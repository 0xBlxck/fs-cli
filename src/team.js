// /team : le travail est découpé en parts (une par fichier) ; chaque part est une demande normale à l'agent FS-CLI, qui écrit avec les outils
// officiels de France Student (à la suite dans la conversation courante, ou en parallèle dans des conversations réutilisées).
import path from 'node:path';
import { streamChat, isLockedChat } from './api.js';
import { baseDir } from './agent.js';
import { summarizeChanges } from './changes.js';
import { cfg } from './config.js';
import { contextPercent } from './account.js';
import { newSid, createdToday, lastReset, DAILY_LIMIT } from './chats.js';
import * as mem from './memory.js';
import { workPreferences } from './pseudo.js';
import * as ui from './ui.js';
import { c, println } from './ui.js';
import { NO_CLARIFY_MODELS, RETRY_MODELS } from './native.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Découpage fait par le CLI (aucun appel au modèle) : le modèle FS refuse de produire du JSON destiné à un programme.
//   /team demande | index.html: la structure | style.css: le style | script.js: le comportement   → un agent par segment
//   /team un site avec index.html, style.css et script.js                                          → un agent par fichier cité
//   /team un site en html, css et js                                                               → index.html / style.css / script.js
const ROLE = { html: 'la structure et le contenu de la page', css: 'la mise en forme (couleurs, mise en page, thème)', js: 'le comportement interactif', py: 'le script Python', md: 'la documentation' };
const roleOf = f => ROLE[f.split('.').pop().toLowerCase()] || 'son contenu';

export const MAX_AGENTS = 8;
const roundRobin = (items, k) => Array.from({ length: k }, (_, i) => items.filter((_, j) => j % k === i)).filter(g => g.length);

/** n = nombre d'agents voulu (facultatif) : les fichiers sont répartis entre eux ; jamais plus d'agents que de fichiers */
export function buildPlan(raw, { n = null } = {}) {
  const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
  const task = parts[0] || raw.trim();
  const want = n ? Math.min(MAX_AGENTS, Math.max(1, n)) : null;
  const seen = new Set();
  const explicit = parts.slice(1).map(s => {
    const m = s.match(/^([\w.\/\\:-]+\.[A-Za-z0-9]{1,6})\s*:\s*(.*)$/);
    if (!m || seen.has(m[1])) return null;
    seen.add(m[1]);
    return { titre: m[1].split(/[\\/]/).pop().slice(0, 24), files: [m[1]], consigne: m[2] || `écris ${m[1]} (${roleOf(m[1])})` };
  }).filter(Boolean).slice(0, MAX_AGENTS);

  let units, mode;                                          // unités de travail = un fichier chacune
  if (explicit.length) { units = explicit; mode = 'explicite'; }
  else {
    let files = [...new Set([...task.matchAll(/\b([\w-]+\.(?:html|css|js|mjs|ts|tsx|jsx|py|json|md|txt|lua|luau|cs|java|go|rs|php|sql))\b/gi)].map(m => m[1]))];
    if (files.length < 2) {
      const kw = [];
      if (/\bhtml\b/i.test(task)) kw.push('index.html');
      if (/\bcss\b/i.test(task)) kw.push('style.css');
      if (/\b(js|javascript)\b/i.test(task)) kw.push('script.js');
      if (kw.length >= 2) files = kw;
    }
    let webDefault = false;
    if (files.length < 2 && /\b(site|page web|landing|portfolio|webapp|application web)\b/i.test(task)) {   // « un site… » sans fichiers cités → trio classique
      files = ['index.html', 'style.css', 'script.js']; webDefault = true;
    }
    if (files.length < 2) {
      const note = want && want > 1 ? `-n ${want} ignoré : la demande ne cite qu'un fichier (cite plusieurs fichiers pour répartir, ex. « avec index.html, style.css et script.js »)` : '';
      return { task, mode: 'un seul agent', note, plan: [{ titre: 'agent', files: [], consigne: task }] };
    }
    units = files.slice(0, 24).map(f => ({ titre: f.slice(0, 24), files: [f], consigne: `écris ${f} (${roleOf(f)}) pour répondre à la demande` }));
    mode = webDefault ? 'site web : index.html, style.css, script.js' : 'automatique';
  }

  const k = Math.min(units.length, want ?? Math.min(units.length, 4));
  let note = want && want > units.length ? `-n ${want} réduit à ${units.length} : il n'y a que ${units.length} fichier${units.length > 1 ? 's' : ''} à répartir (pour plus d'agents, cite plus de fichiers : about.html, contact.html…)` : '';
  if (k >= units.length) return { task, plan: units, mode, note };
  const plan = roundRobin(units, k).map(g => ({                                // plusieurs fichiers par agent
    titre: g.length > 1 ? `${g[0].titre}+${g.length - 1}` : g[0].titre,
    files: g.flatMap(u => u.files),
    consigne: g.map(u => u.consigne).join(' ; '),
  }));
  return { task, plan, mode, note };
}

/** Consigne d'une part du travail : une demande normale, sans jeu de rôle ni format imposé (France Student refuse « tu es l'agent X d'une équipe »).
 *  Le modèle travaille avec les outils officiels (lire, écrire, modifier), comme pour n'importe quelle demande. */
export function workerTask(task, W, plan, dir, { same = false, reused = false } = {}) {
  if (!W.files.length) return task;                                   // une seule part, sans fichiers précis : la demande telle quelle
  const others = plan.flatMap(p => p.files).filter(f => !W.files.includes(f));
  return (reused ? '(Nouvelle tâche, indépendante des précédentes de cette conversation.)\n' : '') +
    `${W.consigne[0].toUpperCase() + W.consigne.slice(1)} (dossier : ${dir}).\n` +      // la consigne d'abord : c'est elle qui donne son titre à la conversation
    `C'est une partie du projet « ${task} ».` +
    (others.length ? ` Les autres fichiers du projet (${others.join(', ')}) sont faits ${same ? 'juste avant ou juste après' : 'en même temps, séparément'} : ` +
      `garde des noms, ids, classes et liens cohérents avec eux${same ? '' : ', sans les créer toi-même'}.` : '') +
    `\nCrée ou modifie uniquement : ${W.files.join(', ')}. Écris le contenu final complet avec tes outils.`;
}

// ── événements pour la vue « Agents » du panneau VS Code (sans sink à événements : rien n'est émis, le terminal ne change pas) ──
//  teamStart {team, task, mode, model, count, parallel, agents:[{id, name, task, files}]}
//  agentStart {team, id, name, task, files, model, mode, slot} · agentUpdate {team, id, status, tokens?, durationMs?}
//  agentDone {team, id, ok, summary, output, files, tokens?, durationMs, aborted?} · teamDone {team, count, durationMs, ok, aborted?}
//  status : 'running' | 'done' | 'error'  (en attente = pas encore d'agentStart)
export const OUTPUT_CAP = 20_000;
let teamSeq = 0;
const capOut = s => { s = String(s || ''); return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + '\n… (sortie tronquée)' : s; };
/** tokens d'une réponse (tokenUsage de France Student), ou null s'ils ne sont pas connus */
export function tokensOf(u) {
  if (!u) return null;
  const t = Number(u.totalTokenCount) || (Number(u.promptTokenCount) || 0) + (Number(u.candidatesTokenCount) || 0);
  return t > 0 ? t : null;
}
function summaryOf(W) {
  if (W.status === 'ok') { const n = W.written.length; return n ? `${n} fichier${n > 1 ? 's' : ''} : ${W.written.join(', ')}` : 'terminé'; }
  if (W.status === 'sans fichier') return 'le modèle n\'a pas écrit de fichier';
  return W.error || 'échec';
}
const QUIET = { print() {}, spinner() {}, setActive() {} };           // affichage mis de côté pendant le travail en parallèle

/**
 * Conversation NEUVE d'un agent : le même contexte de projet que la conversation principale (FSCLI.md, préprompt, faits, notes,
 * instructions du projet France Student, préférences de forme), joint une seule fois. Jamais l'index des skills ni de protocole d'outils.
 * Mode same après un résumé automatique : le résumé de la conversation précédente part en tête, comme dans chatTurn.
 */
export function workerContext(S, WS, { sameChat = false } = {}) {
  if (WS.chatId || (sameChat && S.ctxSent)) return { before: '', after: '', prefsSig: null };
  const after = [];
  const block = mem.buildContextBlock(S.cwd).text;
  if (block) after.push(block);
  if (cfg.fsProject?.id && S.fsProjInstr?.id === cfg.fsProject.id && S.fsProjInstr.text) {   // instructions déjà lues par chatTurn (pas de requête ici)
    after.push(`[Instructions du projet France Student « ${cfg.fsProject.name} » de l'utilisateur, à suivre :\n${S.fsProjInstr.text.slice(0, 8000)}]`);
  }
  let prefsSig = null;
  if (!(sameChat && S.bareChat)) { const p = workPreferences(); if (p.sig !== WS.toolsHintSig) { after.push(p.text); prefsSig = p.sig; } }
  const before = sameChat && S.pendingSummary
    ? `[Reprise : résumé de la conversation précédente (même session de travail), à garder comme contexte]\n${S.pendingSummary}\n\n[Nouvelle demande de l'utilisateur]\n` : '';
  return { before, after: after.length ? '\n\n' + after.join('\n\n') : '', prefsSig };
}

/** Une part du travail = une demande à l'agent FS-CLI (outils officiels), dans la conversation courante ou dans « w0, w1… » */
async function runWorker(W, WS, ctx) {
  const t0 = Date.now();
  W.status = 'en cours';
  ctx.ev('agentStart', { id: W.id, name: W.titre, task: W.consigne, files: W.files, model: ctx.modelLabel, mode: ctx.sameChat ? 'same' : 'pool', slot: ctx.sameChat ? 'main' : W.slot });
  const timer = setInterval(() => ctx.ev('agentUpdate', { id: W.id, status: 'running', durationMs: Date.now() - t0 }), 1000);
  timer.unref?.();
  const undoBefore = WS.undo.length, tokBefore = (WS.tokens?.in || 0) + (WS.tokens?.out || 0), hadChat = !!WS.chatId;
  try {
    for (let attempt = 0; ; attempt++) {
      const extra = workerContext(ctx.S || WS, WS, { sameChat: ctx.sameChat });
      const consigne = workerTask(ctx.task, W, ctx.plan, ctx.dir, { same: ctx.sameChat, reused: !ctx.sameChat && hadChat });
      try {
        await ctx.runNative(WS, extra.before + consigne + extra.after,
          { signal: ctx.signal, ask: ctx.ask, stream: ctx.stream, ...(ctx.sameChat ? {} : { ctxPct: async () => null }) });
      } catch (e) {
        // résumé automatique entre deux agents, mais limite des 50 conversations atteinte : on reste dans la conversation d'avant, rien n'est perdu
        if (e?.code === 'DAILY_CHAT_LIMIT' && ctx.sameChat && !WS.chatId && WS.compactedFrom && !attempt) {
          WS.chatId = WS.compactedFrom; WS.compactedFrom = null; WS.pendingSummary = null; WS.ctxSent = true;
          continue;
        }
        throw e;
      }
      if (WS.chatId && (extra.after || extra.before)) {                 // contexte arrivé dans la conversation : pas renvoyé au message suivant
        if (extra.prefsSig) WS.toolsHintSig = extra.prefsSig;
        if (ctx.sameChat) { WS.ctxSent = true; WS.pendingSummary = null; WS.compactedFrom = null; }
      }
      break;
    }
    W.text = WS.lastResponse || '';
    W.written = summarizeChanges(WS.undo, undoBefore).filter(f => !f.deleted).map(f => path.relative(ctx.dir, f.path) || path.basename(f.path));
    W.status = W.files.length && !W.written.length ? 'sans fichier' : 'ok';
    if (!hadChat && WS.chatId) ctx.created++;
  } catch (e) {
    if (e?.name === 'AbortError') {
      clearInterval(timer);
      W.status = 'annulé';
      const durationMs = Date.now() - t0;
      ctx.ev('agentUpdate', { id: W.id, status: 'error', durationMs });
      ctx.ev('agentDone', { id: W.id, ok: false, summary: 'interrompu', output: capOut(W.text), files: [], durationMs, aborted: true });
      throw e;
    }
    W.status = 'échec'; W.error = e?.message || String(e); if (e?.code === 'DAILY_CHAT_LIMIT') ctx.limitHit = e;
    if (isLockedChat(e)) { WS.chatId = null; W.error = 'conversation verrouillée par France Student (signalée par le filtre du fournisseur) : la suite partira dans une nouvelle conversation'; }
  } finally { clearInterval(timer); }
  const durationMs = Date.now() - t0;
  W.secs = durationMs / 1000;
  const used = (WS.tokens?.in || 0) + (WS.tokens?.out || 0) - tokBefore;
  W.tokens = used > 0 ? used : null;
  const ok = W.status === 'ok', tok = W.tokens != null ? { tokens: W.tokens } : {};
  ctx.ev('agentUpdate', { id: W.id, status: ok ? 'done' : 'error', durationMs, ...tok });
  ctx.ev('agentDone', { id: W.id, ok, summary: summaryOf(W), output: capOut(W.text), files: W.written, durationMs, ...tok });
}

/**
 * Exécute l'équipe : répartition → agents (outils officiels de France Student) → relecture facultative.
 *  mode 'same' (défaut) : les parts sont faites À LA SUITE dans la conversation courante → une seule conversation, aucune création.
 *  mode 'pool'          : jusqu'à `maxParallel` parts EN PARALLÈLE, chacune dans sa propre conversation, réutilisée d'une équipe à l'autre.
 */
export async function runTeam(env, rawTask, { review = false, agents = null, mode: modeOpt = null } = {}) {
  const { S, modelName, ask, withAbort } = env;
  const stream = env.stream || streamChat, ctxPct = env.contextPercent || contextPercent;
  const runNative = env.runNative || (await import('./native.js')).runNative;
  const { task, plan, mode, note } = buildPlan(rawTask, { n: agents });
  if (plan.length === 1 && !plan[0].files.length && env.chatTurn) {   // une seule part, sans fichiers à répartir : ce n'est pas une équipe, juste une demande
    println(c.dim('  une seule tâche, sans fichiers à répartir entre plusieurs agents : traitée comme une demande normale'));
    return env.chatTurn(task);
  }
  const teamMode = modeOpt || (cfg.teamMode === 'pool' ? 'pool' : 'same');
  const sameChat = teamMode === 'same';
  const parallel = sameChat ? 1 : Math.min(6, Math.max(1, cfg.maxParallel || 3));
  S.slots ||= {}; S.sid ||= newSid(); S.undo ||= []; S.notes ||= []; S.allow ||= {}; S.tokens ||= { in: 0, out: 0 };
  S.turnMarks ||= []; S.turnMarks.push({ at: S.undo.length, text: `/team ${task}`.replace(/\s+/g, ' ').slice(0, 70), t: Date.now() });   // /rewind
  await withAbort(async signal => {
    let workerId = cfg.workerModel != null ? cfg.workerModel : S.agentId;
    // GPT-6 / 6.2 Astra refuse souvent les tâches confiées par une équipe d'agents (« ne peut pas servir de moteur à un agent externe ») :
    // 2 refus sur 2 en vrai le 19/11/2026. On ne change JAMAIS de modèle à la place de l'utilisateur : on lui demande (terminal, panneau),
    // sinon (fs-cli -p) on garde son modèle et on le prévient.
    if (cfg.workerModel == null && NO_CLARIFY_MODELS.has(String(workerId))) {
      const choices = [...RETRY_MODELS, { id: workerId, name: 'GPT Astra quand même' }];
      const canAsk = S.interactive === true && typeof env.select === 'function';
      const idx = canAsk
        ? await env.select({ title: 'Modèle des agents de cette équipe ?', detail: 'GPT Astra refuse souvent les tâches d\'une équipe d\'agents (il répond qu\'il ne peut pas servir de moteur à un agent externe). Ta conversation garde son modèle.', options: choices.map(m => m.name), defaultIndex: 0 })
        : null;
      if (Number.isInteger(idx) && choices[idx]) workerId = choices[idx].id;
      else if (!canAsk) println(c.yellow('  ⚠ GPT Astra refuse souvent les tâches d\'une équipe d\'agents : si les agents refusent, relance avec /model sonnet (ou /config pour le modèle des agents)'));
      else return println(c.dim('  équipe annulée'));                 // Échap sur la question
    }
    const dir = baseDir(S);
    const T0 = Date.now();
    const team = `t${(++teamSeq).toString(36)}${T0.toString(36).slice(-4)}`;
    const outer = ui.currentSink();
    const ev = (type, data) => { if (outer?.event) try { outer.event(type, { team, ...data }); } catch {} };
    const say = s => { if (outer) outer.print(s + '\n'); else ui.rawOut(s + '\n'); };   // passe même quand l'affichage des agents est mis de côté
    const quiet = !!env.agentMap && !!outer?.event;                    // panneau avec la vue « Agents » : le bloc remplace la liste en texte
    const modelLabel = modelName(workerId);
    if (!quiet) {
      ui.toolHeader('équipe', task.slice(0, 80));
      say(c.dim(`    ${plan.length} agent${plan.length > 1 ? 's' : ''} (${mode}) · modèle : ${modelLabel} · ` +
        (sameChat ? 'à la suite, dans la conversation courante' : `${Math.min(parallel, plan.length)} en parallèle, conversations réutilisées`)));
    }
    if (note) say(c.yellow('    ⚠ ' + note));
    if (!sameChat && parallel > 4) say(c.dim('    (plus de 4 requêtes simultanées : risque d\'erreurs 429 « trop de requêtes »)'));
    if (plan.length === 1 && !plan[0].files.length) say(c.dim('    une seule part (précise des fichiers : « … avec index.html, style.css et script.js » ou « | fichier: consigne »)'));
    else if (!quiet) plan.forEach(p => say(`    ${c.accent('▸')} ${c.bold(p.titre)} ${c.dim('→ ' + p.files.join(', '))}`));

    const workers = plan.map((p, i) => ({ ...p, id: `${team}-${i + 1}`, status: 'attente', written: [], secs: 0, slot: '', text: '', tokens: null }));
    ev('teamStart', { task, mode: teamMode, plan: mode, model: modelLabel, count: workers.length, parallel: Math.min(parallel, workers.length),
      agents: workers.map(W => ({ id: W.id, name: W.titre, task: W.consigne, files: W.files })) });
    let doneSent = false;
    const teamDone = (extra = {}) => {
      if (doneSent) return; doneSent = true;
      ev('teamDone', { count: workers.length, durationMs: Date.now() - T0, ok: workers.filter(W => W.status === 'ok').length, ...extra });
    };

    // conversations réutilisées trop pleines → on repart d'une neuve (une seule création, étiquetée).
    // Chaque tâche y est « indépendante des précédentes » : leur historique est rejoué pour rien à chaque requête → seuil en tokens
    // (celui du résumé automatique, 60k au plus), pas seulement 70 % du contexte (≈ 700k tokens sur Claude 1M). Jamais quand la limite des 50 est atteinte.
    if (!sameChat) {
      const canCreate = (cfg.dailyLimitHitAt || 0) < lastReset();
      const { compactLimit } = await import('./extra-commands.js');
      const limit = Math.min(compactLimit({ ctxWindows: S.ctxWindows, agentId: workerId }), 60000);
      const win = Number(S.ctxWindows?.[String(workerId)]) || 0;
      S.slotTokens ||= {};                                             // par identifiant de conversation : jamais appliqué à une autre (/resume, /history, /new)
      const drop = (j, why) => { delete S.slotTokens[S.slots[`w${j}`]]; delete S.slots[`w${j}`]; say(c.dim(`    conversation w${j} ${why} → une neuve sera ouverte`)); };
      for (let j = 0; j < Math.min(parallel, plan.length); j++) {
        const id = S.slots[`w${j}`];
        if (!id) continue;
        const tok = Number(S.slotTokens[id]) || 0;                     // taille envoyée à sa dernière requête (connue sans appel réseau)
        if (canCreate && tok >= limit) { drop(j, `chargée (≈${Math.round(tok / 1000)}k tokens par requête)`); continue; }
        const pct = await ctxPct(id).catch(() => null);
        if (typeof pct === 'number' && pct >= 70) drop(j, `presque pleine (${Math.round(pct)} %)`);
        else if (canCreate && typeof pct === 'number' && win && pct / 100 * win >= limit) drop(j, `chargée (${Math.round(pct)} % du contexte)`);
      }
    }

    const ctx = { S, task, plan, dir, signal, ask, stream, runNative, sameChat, created: 0, limitHit: null, ev, modelLabel };
    const K = Math.min(parallel, workers.length);
    const work = Array.from({ length: K }, (_, j) => workers.filter((_, i) => i % K === j));   // répartition fixe : la voie j garde sa conversation « wj »
    const states = [];
    const tasksBefore = ui.tasks.list;
    let prog = null;
    const agentBefore = S.agentId;
    if (sameChat) S.agentId = workerId;
    else {
      ui.attachSink(QUIET);                                            // chaque agent travaille sans écrire à l'écran (sinon les sorties se mélangent)
      if (outer?.event) outer.event('spinner', { label: 'agents…' });
      const line = () => workers.map(W => `${W.titre} ${W.status === 'ok' ? '✓' : W.status === 'en cours' ? '…' : W.status === 'attente' ? '·' : '✗'}`).join(' · ');
      prog = setInterval(() => { if (outer?.event) return; const t = `${c.accent('✻')} agents : ${line()} ${c.dim('(échap pour interrompre)')}`; if (outer?.spinner) outer.spinner(t); else ui.rawOut(`\r\x1b[K  ${t}`); }, 300);
      prog.unref?.();
    }
    try {
      const lane = async j => {
        const WS = sameChat ? S : { chatId: S.slots[`w${j}`] || null, sid: S.sid, tagRole: `w${j}`, agentId: workerId, cwd: S.cwd, targetDir: S.targetDir, undo: [], allow: { ...S.allow },
          pendingResults: [], notes: [], tokens: { in: 0, out: 0 }, slots: {}, stats: { turns: 0, requests: 0, tools: 0 }, lastResponse: '', maxSteps: S.maxSteps };
        if (!sameChat) states.push(WS);
        for (const W of work[j]) {
          if (signal.aborted) return;
          W.slot = `w${j}`;
          // mode same : les agents s'enchaînent dans la conversation courante sans passer par chatTurn → résumé automatique ici, entre deux agents
          if (sameChat) await (await import('./extra-commands.js')).maybeAutoCompact(S, signal, { stream: env.stream });
          await runWorker(W, WS, ctx);
          if (!sameChat) {
            if (WS.chatId) {
              S.slots[`w${j}`] = WS.chatId;
              delete S.slotTokens[WS.chatId]; S.slotTokens[WS.chatId] = WS.lastPromptTokens || 0;
              const ks = Object.keys(S.slotTokens).filter(k => k !== WS.chatId);
              for (const k of ks.slice(0, Math.max(0, ks.length - 199))) delete S.slotTokens[k];   // taille bornée sur une longue session (200 au plus)
            } else delete S.slots[`w${j}`];
          }
        }
      };
      const lanes = [];
      for (let j = 0; j < K; j++) { lanes.push(lane(j)); if (!sameChat) await sleep(350); }   // départs décalés (limites de débit)
      await Promise.all(lanes);
    } catch (e) { teamDone({ aborted: true }); throw e; }
    finally {
      if (sameChat) S.agentId = agentBefore;
      else {
        clearInterval(prog);
        ui.attachSink(outer);
        if (outer?.event) outer.event('spinner', { label: null }); else if (outer?.spinner) outer.spinner(null); else ui.rawOut('\r\x1b[K');
        for (const WS of states) S.undo.push(...WS.undo);              // /changes et /rewind voient le travail des agents
        ui.tasks.set(tasksBefore);
      }
    }
    if (signal.aborted) { teamDone({ aborted: true }); throw Object.assign(new Error('annulé'), { name: 'AbortError' }); }
    teamDone();

    if (!quiet) {                                                      // bilan en texte (le bloc « Agents » du panneau le montre déjà)
      say('');
      for (const W of workers) {
        const mark = W.status === 'ok' ? c.green('✓') : c.red('✗');
        say(`    ${mark} ${c.bold(W.titre.padEnd(14))} ${c.dim(`${W.secs.toFixed(1)}s · ${W.written.length} fichier${W.written.length > 1 ? 's' : ''}${W.error ? ' · ' + W.error : W.status === 'sans fichier' ? ' · le modèle n\'a pas écrit de fichier' : ''}`)}`);
      }
    }
    if (ctx.limitHit) say(c.yellow('\n    ⚠ ' + ctx.limitHit.message));
    if (ctx.created) say(c.dim(`    ${ctx.created} nouvelle${ctx.created > 1 ? 's' : ''} conversation${ctx.created > 1 ? 's' : ''} créée${ctx.created > 1 ? 's' : ''} (aujourd'hui : ${createdToday()}/${DAILY_LIMIT} via le CLI)`));

    const written = [...new Set(workers.flatMap(W => W.written))];
    if (!written.length && plan.some(p => p.files.length)) { say(c.yellow('\n    aucun fichier produit par l\'équipe')); return; }
    if (!sameChat && written.length) S.notes.push(`Ces fichiers ont été créés ou modifiés dans ${dir} par des agents en parallèle : ${written.join(', ')}.`);

    // relecture facultative : dans la conversation courante, visible comme une demande normale
    if (review && written.length) {
      await runNative(S, `Relis ${written.join(', ')} dans ${dir} : ils forment un seul projet (${task}). Vérifie la cohérence entre eux (ids, classes, chemins, noms de fonctions, liens). ` +
        'Corrige directement avec tes outils ce qui ne va pas ; si tout est cohérent, dis-le en une phrase.', { signal, ask, stream, ctxPct });
    }
    env.printTurnChanges?.();
    say('');
  });
}
