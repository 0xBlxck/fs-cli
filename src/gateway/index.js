// Passerelle « API Anthropic Messages » de FS-CLI pour Claude Code : assemblage (spécification § 2.1 et § 3).
// Relie le serveur HTTP (server.js), la classification (classify.js), l'état persistant (store.js), le delta
// (transcript.js), le seul constructeur d'envois (outbound.js), le tour France Student (fsturn.js) et les réponses
// locales (background.js). Toutes les dépendances réseau, disque et horloge arrivent par `deps` (faux FS en test).
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { HOME_DIR, cfg } from '../config.js';
import { classify, lastUserText } from './classify.js';
import { extractEnv } from './context.js';
import { canonicalize, computeDelta, requestKey, fpAssistant, findLastIndex } from './transcript.js';
import { openStore, pushAnchor, pushReply, atomicWrite } from './store.js';
import { buildSend, afterSend, mergeUserTurns } from './outbound.js';
import { collectResults, planRetry, translateResult, mcpNamed, mcpBrief } from './toolmap.js';
import { Reply, wholeReply, sendError, sendJson, estimateTokens } from './anthropic.js';
import { handleHttp, listen } from './server.js';
import { createModels } from './models.js';
import { answerLocally, compactFsInBackground, SUBAGENT_REFUSAL } from './background.js';
import { recapOf, quotaState, limitMessage, MESSAGES } from './recover.js';
import { runFsTurn, reconcile, applyReconcile, resultsText } from './fsturn.js';
import { decodeId } from './ids.js';
import { fsCommand, pickChats, chatLine, isChatId, pickLabel, pickAnswer } from './fschats.js';
import { synthId } from './ids.js';
import { textCleaner } from '../native.js';

const MAX_IMAGES = 4;
const LOCAL_KINDS_WITH_CONV = new Set(['compact', 'away_summary']);
const TIMING = { pingMs: 10000, headerWaitMs: 25000, idleMs: 8000, reattachDelays: [1000, 3000, 8000] };
const SIDE_AGENT = -2002;                                     // Claude Haiku : chat annexe de la recherche web (--fs-web)
const BORROW_IDLE_MS = 10 * 60_000;                           // emprunt : seulement une conversation inactive depuis 10 min

const NOOP_LOG = { line() {}, debug() {}, close() {} };
const isoDay = t => new Date(t).toISOString().slice(0, 10);

/**
 * Passerelle prête à servir (sans écoute réseau) : { handle(req, res), store, close() }.
 * deps : faux FS en test, src/api.js en production (launch.realDeps). opts (noms de launch.splitArgs().fs, plus) :
 *   token (jeton exigé des clients), web, claudeMd, rewind ('auto'|'note'|'chat'), subagents (3), flows (3),
 *   log ({ line, debug }), storeDir (HOME_DIR/gateway), agentsFile, defaultAgentId (cfg.agentId),
 *   timing ({ pingMs, headerWaitMs, idleMs, reattachDelays } : tests), cwd (dossier de repli de extractEnv).
 */
export function createGateway(deps, opts = {}) {
  const o = { web: false, claudeMd: false, rewind: 'auto', subagents: 3, flows: 3, ...opts };
  const timing = { ...TIMING, ...(o.timing || {}) };
  const log = o.log && typeof o.log.line === 'function' ? o.log : NOOP_LOG;
  const line = obj => { try { log.line(obj); } catch {} };
  const debug = (name, body) => { try { log.debug?.(name, body); } catch {} };
  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
  const dir = o.storeDir || path.join(HOME_DIR, 'gateway');
  const store = openStore(dir, { now, flows: o.flows || 3, log: x => line({ event: 'store', ...x }) });
  const models = o.models || createModels(deps, o.agentsFile ? { file: o.agentsFile } : undefined);
  const replyOpts = { pingMs: timing.pingMs, headerWaitMs: timing.headerWaitMs, idleMs: timing.idleMs };
  const live = new Map();                                     // 's:<session|agent>' et 'c:<convId>' → génération en cours
  const seen = new Set();                                     // conversations déjà vues par ce processus
  let disabled = false, unknownBackground = 0;
  // --fs-conversation : la 1re session principale de ce processus continue une conversation France Student existante
  const attach = o.attachChat?.id ? { id: String(o.attachChat.id), used: false } : null;
  const listed = new Map();                                   // session → dernière liste de /fs:conversations (numéros de /fs:reprendre)

  const quota = () => {
    try { return typeof deps.quota === 'function' ? deps.quota() : quotaState(deps); }
    catch { return { created: 0, limitHit: false, remaining: 50, resetText: '' }; }
  };

  // ── Requêtes locales (arrière-plan, § 3.11) : 0 appel France Student ──

  async function local(res, body, cls) {
    const est = estimateTokens(body);
    if (cls.kind === 'web_search' && o.web) return webSearch(res, body, cls, est);
    const turns = canonicalize(body.messages);
    let conv = null;
    if (LOCAL_KINDS_WITH_CONV.has(cls.kind)) { try { conv = store.find(cls, turns); } catch { conv = null; } }
    const modelKnown = cls.kind === 'probe' ? !!(await models.resolve(cls.model)) : undefined;
    const a = answerLocally(cls, body, { conv, turns, est, modelKnown });
    if (cls.kind === 'background_other') line({ event: 'background_other', unknownBackground: ++unknownBackground });
    line({ event: 'local', kind: cls.kind });
    if (!a) return sendError(res, 400, 'invalid_request_error', 'Requête non prise en charge par la passerelle FS-CLI.');
    if (a.error) return sendError(res, a.error.status, a.error.type, a.error.message);
    wholeReply(res, { model: body.model, stream: cls.stream, content: a.content, stop: a.stop, usage: a.usage });
    // Sous le verrou de la conversation, sans l'attendre ici : la requête principale suivante (post_compact) passe après
    // (résultats d'outils mis de côté, compactage FS terminé : pas de 409 sur un chat en cours de compactage).
    if (cls.kind === 'compact' && conv) store.lock(conv.key, () => afterCompact(conv, body, turns)).catch(() => {});
  }

  /**
   * Après une compaction locale. 1) Auto-compaction juste après l'exécution des tool_use : les tool_result ne sont que
   * dans la requête de compaction (la requête suivante n'a que le résumé) ; on les traduit et on les garde dans
   * conv.fs.partial, que collectResults réutilise au prochain envoi. Les appels sans résultat restent absents (ils
   * partiront en « Non exécuté »). 2) Compactage côté FS si le chat est long (§ 3.11).
   */
  async function afterCompact(conv, body, turns) {
    const last = turns.at(-1);
    if (conv.chatId && conv.fs?.state === 'pending' && last?.role === 'user' && last.results.length) {
      const byId = Object.fromEntries(last.results.map(r => [r.id, r]));
      const ready = new Set((conv.fs.pending || []).filter(p => p.local || (p.ccId && byId[p.ccId])).map(p => p.callId));
      for (const r of conv.fs.partial || []) ready.add(r.callId);
      const env = extractEnv(body.system, o.cwd || process.cwd());
      const c = await collectResults(conv.fs.pending, byId, { env, readSet: conv.readSet, uploadFile: deps.uploadFile, partial: conv.fs.partial, synthetic: conv.fs.synthetic });
      // Edit/Write sur un fichier non lu : pas de micro-tour possible ici, FS reçoit l'explication et refera l'action
      const retried = c.retry.map(p => ({ callId: p.callId, output: translateResult(byId[p.ccId], p, { env, readSet: conv.readSet }).output, isError: true }));
      conv.fs.partial = [...c.toolResults, ...retried].filter(r => ready.has(r.callId));
      conv.notes.push(...c.notes);
      store.save(conv);
      line({ event: 'compact_résultats', gardés: conv.fs.partial.length, attendus: conv.fs.pending.length });
    }
    const agent = await models.fromAgentId(conv.agentId).catch(() => null);
    const status = await compactFsInBackground(conv, { contextWindow: agent?.contextWindow || 200000, compactChat: deps.compactChat });
    if (status != null) line({ event: 'compact_fs', chatId: conv.chatId, status });
  }

  /** --fs-web : recherche web dans un chat annexe réutilisé (side.json), texte seul, réponse en un bloc texte. */
  async function webSearch(res, body, cls, est) {
    const sideFile = path.join(dir, 'side.json');
    let side = null;
    try { side = JSON.parse(fs.readFileSync(sideFile, 'utf8')); } catch {}
    const reply = new Reply({ model: body.model, inputTokens: est, ...replyOpts });
    reply.subscribe(res, cls.stream);
    const cleaner = textCleaner();
    const query = lastUserText(body.messages).replace(/^Perform a web search for the query:\s*/i, '').trim();
    const release = await store.acquireFlow(() => reply.headersIfWaiting());
    try {
      const r = await deps.stream({
        agentId: SIDE_AGENT, chatId: side?.chatId || null, webSearch: true,
        content: `Recherche sur le web, puis réponds en français avec un court résumé et les liens utiles en markdown : ${query}`,
        ...(side?.chatId ? {} : { register: { sid: 'web0', role: 'cc' } }),
        onAccepted: () => reply.headers(),
        onChat: id => { if (id && id !== side?.chatId) { side = { chatId: id, day: isoDay(now()) }; try { atomicWrite(sideFile, JSON.stringify(side)); } catch {} } },
        onText: d => reply.text(cleaner.push(d)),
      });
      reply.text(cleaner.flush());
      reply.finish('end_turn', r?.usage || null);
    } catch (e) {
      reply.fail(reply.hasContent ? 'api_error' : 'overloaded_error', `Recherche web indisponible : ${String(e?.message || e).slice(0, 200)}`);
    } finally { release(); }
  }

  // ── Moteur (requête principale et sous-agents) ──

  async function engine(res, body, cls) {
    const turns = canonicalize(body.messages);
    const sessionKey = `${cls.sessionId}|${cls.agentId || 'main'}`;
    const key = requestKey(turns, cls.model);
    const cur = live.get('s:' + sessionKey);
    if (cur && !cur.reply.done) {
      if (cur.key === key) { cur.reply.subscribe(res, cls.stream); return { outcome: 'rejointe', chatId: cur.conv?.chatId }; }   // I5
      if (!cur.reply.listeners) cur.abandon();                // Échap puis nouveau message : on n'attend pas les 8 s
    }
    return store.lock(sessionKey, async () => {
      const conv = store.find(cls, turns);
      if (conv && conv.key !== sessionKey) return store.lock(conv.key, () => withConv(conv, res, body, cls, turns, sessionKey));
      return withConv(conv, res, body, cls, turns, sessionKey);
    });
  }

  async function withConv(found, res, body, cls, turns, sessionKey) {
    const delta = computeDelta(found, turns, cls.model);
    if (delta.kind === 'replay') {
      const snap = found.lastReplies.find(r => r.key === delta.key).snapshot;
      Reply.fromSnapshot(snap, replyOpts).subscribe(res, cls.stream);
      return { outcome: 'rejouée', chatId: found.chatId };
    }
    if (delta.kind === 'join') {
      const cur = live.get('c:' + found.id);
      if (cur && cur.key === delta.key && !cur.reply.done) { cur.reply.subscribe(res, cls.stream); return { outcome: 'rejointe', chatId: found.chatId }; }
    }
    const reply = new Reply({ model: body.model, inputTokens: estimateTokens(body), ...replyOpts });
    reply.subscribe(res, cls.stream);
    const entry = { key: delta.key, reply, conv: found, abandon: () => {} };
    live.set('s:' + sessionKey, entry);
    if (found) live.set('c:' + found.id, entry);
    let out = { outcome: 'erreur', chatId: found?.chatId || null };
    try {
      out = await processRequest(found, delta, reply, body, cls, turns, entry);
    } catch (e) {
      line({ event: 'erreur', message: String(e?.message || e).slice(0, 300) });
      reply.fail('api_error', `Erreur interne de la passerelle FS-CLI : ${String(e?.message || e).slice(0, 200)}`);
    } finally {
      for (const k of ['s:' + sessionKey, 'c:' + entry.conv?.id]) if (live.get(k) === entry) live.delete(k);
      const conv = entry.conv;
      const snap = conv && reply.done && out.cache !== false ? reply.snapshot(delta.key) : null;
      if (snap?.phase === 'done') { pushReply(conv, delta.key, snap); store.save(conv); }   // I5 : un réessai sera rejoué (jamais un échec)
    }
    return { outcome: out.outcome, chatId: entry.conv?.chatId || out.chatId || null };
  }

  /** Agent FS de la requête : le modèle demandé, sauf passage à Sonnet après un refus (gardé tant que /model ne change pas). */
  async function agentFor(conv, cls) {
    const { agent, unknown } = await models.resolveMain(cls.model, o.defaultAgentId ?? cfg.agentId);
    if (unknown) line({ event: 'modèle', note: 'modèle inconnu', model: cls.model });
    let a = agent;
    if (conv) {
      if (conv.ccModel === cls.model && conv.agentId !== agent.agentId) a = (await models.fromAgentId(conv.agentId)) || agent;
      else if (conv.ccModel !== cls.model) {
        if (conv.provider !== agent.provider) conv.refusal = { stage: 0, toolsSeen: false };
        conv.agentId = agent.agentId;
        conv.provider = agent.provider;
        conv.native = agent.native;
        conv.ccModel = cls.model;
      }
    }
    // conv.native n'est plus consulté : le mode texte seul après un 403 vit dans models (limité dans le temps)
    return { ...a, native: !!a.native };
  }

  /** Oublie le chat FS de la conversation : le prochain envoi ouvre un nouveau chat (préambule, récapitulatif). */
  function resetChat(conv) {
    conv.chatId = null;
    conv.fs = { state: 'idle', pending: [], lastEventId: null, inflightKey: null };
    conv.preambleSent = false;
    conv.bare = false;
    conv.refusal = { stage: 0, toolsSeen: conv.refusal?.toolsSeen || false };
    conv.readSet = { sessionId: conv.readSet?.sessionId ?? null, paths: {} };
    conv.lastReplies = [];
    conv.undelivered = null;
  }

  /**
   * Limite du jour atteinte : on emprunte le chat d'une conversation INACTIVE (ni génération, ni appel en attente,
   * rien depuis BORROW_IDLE_MS : l'autre terminal pourrait s'en servir), d'abord une de la même session, sinon la plus
   * ancienne. Le chat change de propriétaire : la conversation prêteuse l'oublie (b.chatId = null, b.borrowedBy) et
   * repartira dans un nouveau chat avec récapitulatif. Jamais deux conversations sur un même chat FS. → true si possible
   */
  function borrowInto(conv, prefix) {
    const b = store.recentGatewayChat({ exclude: conv.id, sessions: conv.sessions || [], minIdleMs: BORROW_IDLE_MS, oldest: true });
    if (!b || !b.chatId) return false;
    const chatId = b.chatId;
    resetChat(b);
    b.borrowedBy = conv.id;
    store.save(b);
    conv.chatId = chatId;
    conv.fs = { state: 'idle', pending: [], lastEventId: null, inflightKey: null };
    prefix.push(MESSAGES.borrow);
    line({ event: 'emprunt', chatId, de: b.id });
    return true;
  }

  /** Images du message utilisateur → Files v2 (4 au plus) ; échec silencieux. */
  async function uploadImages(images) {
    const ids = [];
    for (const [i, img] of (images || []).slice(0, MAX_IMAGES).entries()) {
      try {
        const ext = (String(img.media_type).split('/')[1] || 'png').replace('jpeg', 'jpg');
        const id = await deps.uploadFile?.(Buffer.from(img.data || '', 'base64'), `image-${i + 1}.${ext}`, img.media_type);
        if (id) ids.push(id);
      } catch {}
    }
    return ids;
  }

  /** Réponse locale terminée (micro-tour, document écrit…) : état mémorisé AVANT l'émission (I4). */
  function localTurn(conv, reply, text, uses = []) {
    if (text) reply.text(text);
    conv.undelivered = null;
    conv.lastText = reply.emittedText;
    conv.lastFp = fpAssistant({ text: reply.emittedText, toolUses: uses });
    pushAnchor(conv);
    store.save(conv);
    for (const u of uses) reply.toolUse(u.id, u.name, u.input);
    reply.finish(uses.length ? 'tool_use' : 'end_turn');
  }

  /** Conversations du site : projectId donné (null = toutes), sinon celles du projet de --fs-projet ; null si illisibles. */
  async function siteChats(projectId = o.listProject || null) {
    try { return typeof deps.listChats === 'function' ? await deps.listChats({ projectId }) : null; }
    catch { return null; }
  }

  const PICK_PAGE = 3;                                        // menu de Claude Code : 4 choix au plus → 3 + « Suivantes ▸ »
  const NO_LIST = 'Impossible de lire tes conversations France Student pour le moment (réessaie dans un instant).';

  /** Menu à flèches de Claude Code (AskUserQuestion), une page de st.items ; la réponse revient dans conv.pick. */
  function askPage(conv, reply, st, text) {
    const total = st.items.length, pages = Math.max(1, Math.ceil(total / PICK_PAGE)), fits = total <= 4;
    const page = fits ? 0 : st.page % pages;
    const shown = (fits ? st.items : st.items.slice(page * PICK_PAGE, page * PICK_PAGE + PICK_PAGE)).map(it => ({ ...it }));
    if (!fits) shown.push({ label: page + 1 < pages ? `Suivantes ▸ (page ${page + 1}/${pages})` : `↺ Retour au début (page ${pages}/${pages})`, description: 'faire défiler la liste', nav: true });
    const id = synthId('pick');
    conv.pick = { ccId: id, stage: st.stage, page, items: st.items, shown: shown.map(x => ({ label: x.label, nav: !!x.nav, value: x.value })), question: st.question, header: st.header };
    return localTurn(conv, reply, text, [{
      id, name: 'AskUserQuestion',
      input: { questions: [{ question: st.question, header: st.header, multiSelect: false, options: shown.map(x => ({ label: x.label, description: x.description || '' })) }] },
    }]);
  }

  /** liste des conversations (toutes, d'un projet, ou filtrées par un mot) : texte numéroté + menu à flèches si possible */
  async function chatStage(conv, reply, avail, { projectId, projectName = '', word = '' } = {}) {
    const key = conv.key || conv.id;
    const list = await siteChats(projectId === undefined ? (o.listProject || null) : projectId);
    if (!Array.isArray(list)) return localTurn(conv, reply, NO_LIST);
    const cands = pickChats(list, word, 50);
    listed.set(key, cands.map(c => ({ id: c.id, title: c.title || '' })));
    line({ event: 'commande', name: 'conversations', n: cands.length });
    const where = projectName ? ` du projet « ${projectName} »` : (projectId === undefined && o.listProject) ? ' du projet' : '';
    if (!cands.length) return localTurn(conv, reply, `Aucune conversation France Student${where}${word ? ` dont le titre contient « ${word} »` : ''}.`);
    const text = `Conversations France Student${where}${word ? ` (titre contenant « ${word} »)` : ''} :\n\n${cands.map((c, i) => chatLine(c, i).trim()).join('\n')}`;
    if (!avail.has('AskUserQuestion') || cands.length < 2) return localTurn(conv, reply, `${text}\n\nPour continuer l'une d'elles ici : /fs:reprendre <numéro>`);
    const items = cands.map((c, i) => ({ label: pickLabel(c, i), description: chatLine(c, i).trim().replace(/^\d+\.\s*[^·]*·?\s*/, ''), value: { id: c.id, title: c.title || '' } }));
    return askPage(conv, reply, { stage: 'chat', page: 0, items, question: 'Quelle conversation continuer ici ? (« Other » : un numéro ou un mot du titre)', header: 'Conversation' },
      `${text}\n\nChoisis avec les flèches, ou plus tard : /fs:reprendre <numéro>`);
  }

  /** la session continue dans ce chat FS (le prochain message y part, avec la note « suite de cette conversation ») */
  function resumeChat(conv, reply, target) {
    if (target.id === conv.chatId) return localTurn(conv, reply, 'Tu es déjà dans cette conversation.');
    const owner = store.list().find(c => c.id !== conv.id && c.chatId === target.id);
    if (owner) { resetChat(owner); owner.borrowedBy = conv.id; store.save(owner); }   // jamais deux conversations sur un même chat FS
    resetChat(conv);
    conv.chatId = target.id;
    conv.fs = { state: 'uncertain', pending: [], lastEventId: null, inflightKey: null };   // vérifié avant le prochain envoi
    conv.attachNext = true;
    line({ event: 'reprise', chatId: target.id, via: 'commande' });
    return localTurn(conv, reply, `Conversation France Student ${target.title ? `« ${target.title} »` : target.id} reprise : ton prochain message part dedans, le modèle se souvient de ce qui y a été dit.`);
  }

  /** réponse au menu à flèches (résultat d'AskUserQuestion) */
  async function answerPick(conv, picked, reply, avail) {
    const st = conv.pick;
    conv.pick = null;
    const answer = pickAnswer(picked);
    if (picked.is_error || !answer) return localTurn(conv, reply, 'Aucune conversation reprise (choix annulé). /fs:conversations pour revoir la liste.');
    const opt = (st.shown || []).find(x => x.label === answer);
    if (opt?.nav) {
      const pages = Math.max(1, Math.ceil(st.items.length / PICK_PAGE)), next = (st.page + 1) % pages;
      return askPage(conv, reply, { ...st, page: next }, `Page ${next + 1}/${pages}`);
    }
    if (st.stage === 'project') {
      if (opt) return chatStage(conv, reply, avail, { projectId: opt.value?.projectId ?? null, projectName: opt.value?.name || '' });
      return chatStage(conv, reply, avail, { projectId: null, word: answer });   // « Other » : un mot cherché dans toutes les conversations
    }
    if (opt?.value?.id) return resumeChat(conv, reply, opt.value);
    return runFsCommand(conv, { name: 'reprendre', arg: answer }, reply, avail);   // « Other » : numéro de la liste ou mot du titre
  }

  /** /fs:conversations [mot] : projets puis conversations (menu à flèches) ; /fs:reprendre <n° | mot | id> : la session continue dans ce chat FS. */
  async function runFsCommand(conv, cmd, reply, avail = new Set()) {
    const key = conv.key || conv.id;
    if (cmd.name === 'conversations') {
      // sans mot ni --fs-projet : d'abord tes projets du site (menu à flèches), puis leurs conversations
      if (!cmd.arg && !o.listProject && avail.has('AskUserQuestion') && typeof deps.listProjects === 'function') {
        let projects = null;
        try { projects = await deps.listProjects(); } catch {}
        if (Array.isArray(projects) && projects.length) {
          const items = [{ label: 'Toutes mes conversations', description: 'les plus récentes, tous projets', value: { projectId: null } },
            ...projects.map(p => ({ label: `📁 ${String(p.name || 'sans nom').replace(/["“”]/g, '\'').slice(0, 40)}`, description: 'projet du site France Student', value: { projectId: p.id, name: p.name || '' } }))];
          line({ event: 'commande', name: 'projets', n: projects.length });
          return askPage(conv, reply, { stage: 'project', page: 0, items, question: 'Quelles conversations afficher ? (« Other » : un mot cherché dans les titres)', header: 'Projet' },
            `Projets France Student : ${projects.map(p => p.name).join(', ')}`);
        }
      }
      return chatStage(conv, reply, avail, { word: cmd.arg });
    }
    const arg = cmd.arg;
    if (!arg) return localTurn(conv, reply, 'Indique laquelle : /fs:reprendre <numéro> (après /fs:conversations), un mot du titre, ou son id.');
    if (/^\d+$/.test(arg)) {
      const prev = listed.get(key);
      if (!prev) return localTurn(conv, reply, 'Tape d\'abord /fs:conversations pour voir la liste numérotée.');
      const target = prev[Number(arg) - 1];
      if (!target) return localTurn(conv, reply, `Pas de conversation n° ${arg} dans la dernière liste (1 à ${prev.length}).`);
      return resumeChat(conv, reply, target);
    }
    if (isChatId(arg)) return resumeChat(conv, reply, { id: arg.toLowerCase(), title: '' });
    const list = await siteChats();
    if (!Array.isArray(list)) return localTurn(conv, reply, NO_LIST);
    const cands = pickChats(list, arg);
    if (cands.length === 1) return resumeChat(conv, reply, { id: cands[0].id, title: cands[0].title || '' });
    if (!cands.length) return localTurn(conv, reply, `Aucune conversation France Student${o.listProject ? ' du projet' : ''} dont le titre contient « ${arg} ».`);
    listed.set(key, cands.map(c => ({ id: c.id, title: c.title || '' })));
    return localTurn(conv, reply, `Plusieurs conversations contiennent « ${arg} » :\n\n${cands.map((c, i) => chatLine(c, i).trim()).join('\n')}\n\nChoisis : /fs:reprendre <numéro>`);
  }

  async function processRequest(found, delta, reply, body, cls, turns, entry) {
    const env = extractEnv(body.system, o.cwd || process.cwd());
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const avail = new Set(tools.map(t => t?.name).filter(Boolean));
    const shellTool = avail.has('Bash') ? 'Bash' : avail.has('PowerShell') ? 'PowerShell' : null;
    const q = quota();
    const prefix = [];

    // sous-agents : plafond par session et quota suffisant (chaque sous-agent coûte une conversation)
    if (cls.kind === 'subagent' && !found) {
      const n = store.list().filter(c => c.key.startsWith(`${cls.sessionId}|`) && !c.key.endsWith('|main')).length;
      if (n >= o.subagents || q.remaining <= 10 || q.limitHit) {
        line({ event: 'sous-agent refusé', n, remaining: q.remaining });
        reply.text(SUBAGENT_REFUSAL);
        reply.finish('end_turn');
        return { outcome: 'sous-agent refusé', cache: false };
      }
    }

    const agent = await agentFor(found, cls);
    let conv = found;
    let kind = delta.kind;
    if (kind === 'join') kind = 'resume';                    // génération acceptée par un processus précédent : on se rattache
    if (!conv) {
      conv = store.create(cls, env, agent);
      conv.ccModel = cls.model;
      kind = kind === 'new' ? 'new' : 'unknown';
    }
    entry.conv = conv;
    live.set('c:' + conv.id, entry);
    if (!seen.has(conv.id)) {                                 // 1re rencontre dans ce processus (redémarrage) : état à vérifier (I6)
      seen.add(conv.id);
      if (conv.chatId && ['pending', 'inflight'].includes(conv.fs.state)) conv.fs.state = 'uncertain';
    }
    entry.abandon = () => {                                   // plus personne n'écoute : génération arrêtée côté FS
      if (reply.done || !conv._abort) return;
      if (conv.chatId) Promise.resolve().then(() => deps.cancelStream?.(conv.chatId)).catch(() => {});
      conv._abort.abort();
    };
    reply.onAbandon = () => { line({ event: 'abandon', chatId: conv.chatId }); entry.abandon(); };

    const ia = findLastIndex(turns, t => t.role === 'assistant');
    const u = mergeUserTurns(delta.userTurns);
    // /fs:conversations, /fs:reprendre (plugin de session de fs-cli claude) : répondues ici, aucun appel au modèle
    const picked = conv.pick && u.results.find(r => r.id === conv.pick.ccId);
    if (picked) { await answerPick(conv, picked, reply, avail); return { outcome: 'commande', chatId: conv.chatId, cache: false }; }   // réponse au menu de /fs:conversations
    const cmd = cls.kind === 'main' && !u.results.length ? fsCommand(u.text) : null;
    if (cmd) { await runFsCommand(conv, cmd, reply, avail); return { outcome: 'commande', chatId: conv.chatId, cache: false }; }
    const extras = { web: !!o.web, date: isoDay(now()), shellTool, forceClaudeMd: !!o.claudeMd };
    if (conv.attachNext) { conv.attachNext = false; extras.borrowed = true; extras.attached = true; }   // 1er envoi après /fs:reprendre : note + préambule
    const ctxBase = { deps, store, models, agent, key: delta.key, est: estimateTokens(body), prefix, userText: u.text, timing, quota,
      log: line, debug, onDisabled: () => { disabled = true; },
      toolCtx: { env, tools, sessionId: cls.sessionId, fsExists: deps.fsExists, fsStat: deps.fsStat } };

    if (kind === 'resume') {
      conv.fs.state = 'inflight';
      return finishTurn(conv, await runFsTurn(conv, null, reply, ctxBase), env, u, shellTool);
    }

    // nouveau chat (conversation neuve, retour en arrière en mode chat, conversation inconnue, chat sans id)
    let fresh = kind === 'new' || !conv.chatId;
    if (kind === 'rewind') {
      const mode = o.rewind === 'auto' ? (q.remaining > 10 && !q.limitHit ? 'chat' : 'note') : o.rewind;
      conv.readSet.paths = {};
      conv.lastReplies = [];
      if (mode === 'note' && conv.chatId) extras.rewind = 'note';
      else { resetChat(conv); fresh = true; extras.recap = recapOf(turns.slice(0, ia + 1)); }
      line({ event: 'retour', mode: extras.rewind ? 'note' : 'chat' });
    } else if (kind === 'unknown' || (kind === 'post_compact' && !conv.chatId) || (!conv.chatId && conv.borrowedBy)) {
      // conversation inconnue, ou dont le chat a été prêté (limite du jour) : nouveau chat amorcé par un récapitulatif
      resetChat(conv);
      fresh = true;
      conv.borrowedBy = null;
      if (ia >= 0) extras.recap = recapOf(turns.slice(0, ia + 1));
    }
    if (fresh && kind === 'new' && cls.kind === 'main' && attach && !attach.used) {
      attach.used = true;
      const owner = store.list().find(c => c.id !== conv.id && c.chatId === attach.id);
      if (owner) { resetChat(owner); owner.borrowedBy = conv.id; store.save(owner); }   // jamais deux conversations sur un même chat FS
      conv.chatId = attach.id;
      conv.fs = { state: 'uncertain', pending: [], lastEventId: null, inflightKey: null };   // vérifié avant d'envoyer (appel d'outil en attente ?)
      fresh = false;
      extras.borrowed = true; extras.attached = true;
      line({ event: 'reprise', chatId: attach.id });
    }
    if (fresh && (q.limitHit || q.remaining === 0)) {
      if (!borrowInto(conv, prefix)) {
        reply.fail('invalid_request_error', limitMessage(q.resetText), { status: 400 });
        return { outcome: 'limite du jour', cache: false };
      }
      fresh = false;
      extras.borrowed = true;
    }

    // chat existant dans un état incertain (redémarrage, coupure, erreur) : on vérifie avant d'envoyer (I6)
    const byId = Object.fromEntries(u.results.map(r => [r.id, r]));
    const tctx = { env, readSet: conv.readSet, uploadFile: deps.uploadFile, partial: conv.fs.partial, synthetic: conv.fs.synthetic };
    const staleNotes = [];
    if (!fresh && ['uncertain', 'orphan_user', 'inflight'].includes(conv.fs.state)) {
      const rec = await reconcile(conv, deps);
      line({ event: 'reconcile', chatId: conv.chatId, state: rec.state, calls: rec.callIds.length });
      applyReconcile(conv, rec);
      if (rec.state !== 'pending') {                          // FS n'attend plus rien : nos résultats partent en texte (I7)
        const stale = u.results.map(r => ({ r, d: decodeId(r.id) })).filter(x => x.d?.kind === 'f' || x.d?.kind === 'r')
          .map(x => {
            const use = turns.flatMap(t => t.toolUses || []).find(tu => tu.id === x.r.id);
            return { callId: x.d.callId, ccId: x.r.id, ccName: use?.name, fsName: '', path: use?.input?.file_path || null, local: null, retried: 1 };
          });
        const t = stale.length ? resultsText((await collectResults(stale, byId, tctx)).toolResults) : '';
        if (t) staleNotes.push(t);
      }
    }

    // résultats de Claude Code → toolResults (ou notes)
    if (!fresh && agent.native && conv.fs.state === 'pending' && extras.rewind !== 'note') {
      const c = await collectResults(conv.fs.pending, byId, tctx);
      if (c.retry.length) return microTurn(conv, c, u, reply);
      extras.toolResults = c.toolResults;
      extras.files = c.files;
      extras.notes = [...staleNotes, ...c.notes];
    } else if (u.results.length) {
      const c = await collectResults([], byId, tctx);
      extras.notes = [...staleNotes, ...c.notes];
      if (conv.fs.state === 'pending' && !agent.native) applyReconcile(conv, { state: 'idle' });
    }
    if (!fresh && !extras.toolResults && !u.text && u.results.length && conv.fs.state !== 'pending' && !extras.rewind && !staleNotes.length) {
      // fin de tour qui ne contient que des synthétiques (document écrit, lecture injectée) : FS n'attend rien
      conv.notes.push(...(extras.notes || []));
      const docs = (conv.fs.synthetic || []).filter(s => s.purpose === 'doc' && byId[s.ccId]);
      const names = docs.filter(s => !byId[s.ccId].is_error).map(s => s.name);
      // écriture refusée (permission, dossier hors projet…) : le dire, jamais « C'est fait » (vu en vrai avec -p)
      const failed = docs.filter(s => byId[s.ccId].is_error).map(s => s.path || s.name);
      const msg = [
        names.length ? `C'est fait : ${names.join(', ')} écrit.` : '',
        failed.length ? `Fichier non écrit (écriture refusée) : ${failed.join(', ')}. Le contenu reste dans le panneau du site France Student ; autorise l'écriture puis redemande.` : '',
      ].filter(Boolean).join('\n') || 'C\'est fait.';
      localTurn(conv, reply, msg);
      return { outcome: 'local', chatId: conv.chatId };
    }
    // serveur MCP nommé par l'utilisateur (« avec le mcp leboncoin ») : ses outils et la commande fs-mcp, une fois par conversation
    for (const s of mcpNamed(u.text, tools).filter(x => !(conv.mcpBriefed || []).includes(x))) { conv.notes = [...(conv.notes || []), mcpBrief(s, tools)]; conv.mcpBriefed = [...(conv.mcpBriefed || []), s]; }
    extras.images = await uploadImages(u.images);

    const send = buildSend(conv, delta, agent, env, extras);
    const ctx = {
      ...ctxBase,
      borrow: () => {
        if (!borrowInto(conv, prefix)) return null;
        return buildSend(conv, delta, agent, env, { ...extras, borrowed: true });
      },
      restart: k => {
        line({ event: 'chat perdu', kind: k, chatId: conv.chatId });
        const q2 = quota();
        resetChat(conv);
        if (q2.limitHit || q2.remaining === 0) {
          if (!borrowInto(conv, prefix)) return null;
          return buildSend(conv, delta, agent, env, { ...extras, toolResults: undefined, borrowed: true });
        }
        return buildSend(conv, delta, agent, env, { ...extras, toolResults: undefined, recap: k === 'locked' ? '' : recapOf(turns.slice(0, ia + 1)) });
      },
    };
    const result = await runFsTurn(conv, send, reply, ctx);
    return finishTurn(conv, result, env, u, shellTool);
  }

  function finishTurn(conv, result, env, u, shellTool) {
    if (result.accepted) { afterSend(conv, env, { claudeMd: u.claudeMd, shellTool }); store.save(conv); }
    return { outcome: result.outcome, chatId: conv.chatId, cache: result.accepted && result.outcome !== 'annulé' };
  }

  /** Micro-tour local (§ 3.6) : [Read, même Edit/Write] renvoyés à Claude Code sans appeler FS. */
  function microTurn(conv, c, u, reply) {
    const { uses, synthetic } = planRetry(c.retry, { chatId: conv.chatId });
    conv.fs.partial = c.toolResults;
    conv.fs.synthetic = [...(conv.fs.synthetic || []), ...synthetic];
    conv.notes.push(...c.notes, ...(u.text ? [u.text] : []));
    line({ event: 'micro-tour', appels: c.retry.length });
    localTurn(conv, reply, '', uses);
    return { outcome: 'micro-tour', chatId: conv.chatId };
  }

  // ── HTTP ──

  async function onMessages(req, res, body) {
    const t0 = Date.now();
    const cls = classify(body, req.headers);
    if (disabled) return sendError(res, 400, 'invalid_request_error', MESSAGES.accountDisabled);
    debug(`requete-${cls.kind}`, body);
    if (cls.kind !== 'main' && cls.kind !== 'subagent') return local(res, body, cls);
    const out = await engine(res, body, cls);
    line({ event: 'request', kind: cls.kind, chatId: out?.chatId || null, ms: Date.now() - t0, outcome: out?.outcome || '' });
  }

  const handlers = {
    messages: onMessages,
    count_tokens: (req, res, body) => sendJson(res, 200, { input_tokens: estimateTokens(body) }),
    models: async (req, res) => sendJson(res, 200, await models.forClaudeCode()),
  };

  return {
    store,
    models,
    handle: (req, res) => handleHttp(req, res, { token: o.token, port: null, handlers, log: { line } }),
    /** Arrêt : générations en cours annulées côté FS, état sur disque. */
    async close() {
      for (const [k, e] of live) {
        if (!k.startsWith('c:') || e.reply.done) continue;
        try { e.abandon(); } catch {}
        try { store.save(e.conv); } catch {}
      }
    },
  };
}

/**
 * Démarre la passerelle sur host:port (127.0.0.1, port 0 = libre). token : jeton exigé des clients (tiré au hasard s'il manque).
 * → { port, token, url, store, close() }. Rejette avec un message en français si le port est pris (EADDRINUSE).
 */
export async function startGateway({ host = '127.0.0.1', port = 0, token, deps, opts = {}, log } = {}) {
  const tok = token || crypto.randomBytes(24).toString('base64url');
  const gw = createGateway(deps, { ...opts, token: tok, log: log || opts.log });
  if (opts.flows) gw.store.setFlows(opts.flows);
  const srv = await listen((req, res) => gw.handle(req, res), { host, port });
  return {
    port: srv.port, token: tok, url: srv.url, store: gw.store,
    close: async () => { await gw.close(); await srv.close(); },
  };
}
