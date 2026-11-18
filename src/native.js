// Moteur NATIF : vrais appels d'outils via le mode officiel « outils client » de France Student.
// FS déclare les outils au modèle, nous renvoie les appels dans completed.message.toolCalls, nous les exécutons ICI (avec nos garde-fous :
// politique de commandes, confirmations, secrets, chemins limités au workspace) et renvoyons les résultats avec toolResults.
// Documentation FS : « Outils client (mode avancé) », flag 2026_11_client_tools.
import fs from 'node:fs';
import path from 'node:path';
import { streamChat, CLIENT_TOOLS, uploadFile, lastMessageImages, fetchApiFile, withDocumentContents } from './api.js';
import { HOME_DIR } from './config.js';
import { takeQueuedImages } from './vision.js';
import { contextPercent } from './account.js';
import { cfg, saveCfg, saveCfgKeys } from './config.js';
import { newSid, tag, lastReset } from './chats.js';
import { execCall, baseDir, forgetRead } from './agent.js';
import { clipMiddle } from './tools.js';
import * as ui from './ui.js';
import { c } from './ui.js';

export const READ_TOOLS = CLIENT_TOOLS.slice(0, 3);
// Certains modèles de France Student refusent de servir d'agent à un outil externe (« ne peut pas servir de moteur à ton outil externe »,
// « colle ici le contenu »…). FS-CLI ne contourne pas ce refus : il l'explique et propose un modèle qui accepte les outils.
const TOOL_REFUSAL = /servir de moteur|(?:moteur|outil|agent) (?:d'un |à un |pour un )?(?:agent |outil )?externe|(?:je ne (?:peux|pourrai) pas|nous ne pouvons pas|impossible pour moi de) (?:piloter|contr[ôo]ler|utiliser) (?:FS-CLI|tes outils|les outils|ton (?:PC|ordinateur|disque))|(?:je ne (?:peux|pourrai) pas|nous ne pouvons pas) (?:acc[ée]der|modifier|[ée]crire|lire|ex[ée]cuter|cr[ée]er|lancer|ouvrir)\b[^.]{0,60}\b(?:tes |vos |ton |votre )(?:fichiers?|disque|dossier|commandes?|ordinateur|PC|machine)|je n'ai pas (?:d'|l')?acc[èe]s (?:à|aux) (?:tes |ton |vos |votre )(?:fichiers?|disque|dossier|syst[èe]me|ordinateur|PC|machine)|colle[rz]?(?:-le)? ici (?:le )?contenu/i;   // 1re personne + « ici » obligatoires (audit 17/11 : 6 réponses normales sur 7 prises pour des refus)
// seulement le DÉBUT de la réponse (un refus se dit d'entrée) : « Python ne peut pas lire le fichier… » plus loin n'est pas un refus (audit 17/11)
export const looksLikeToolRefusal = text => TOOL_REFUSAL.test(String(text || '').slice(0, 400));   // list_directory, read_file, search_files : seuls outils proposés en mode plan
const MAX_RESULT = 40000;     // limite FS par résultat (au-delà FS coupe et prévient le modèle)
const MAX_TOTAL = 120000;      // limite FS par envoi
// conversation trop chargée en pleine demande : le modèle finit l'étape en cours puis s'arrête (le résumé est fait avant le message suivant)
export const HEAVY_NOTE = '(Note : cette conversation est devenue très longue. Termine l\'étape en cours, puis arrête-toi avec un court point d\'étape : ce qui est fait, ce qui reste à faire. La suite reprendra juste après, à partir d\'un résumé.)';

/** appel FS → appel de nos outils (noms et arguments traduits) */
export function mapCall(name, a = {}) {
  switch (name) {
    case 'list_directory': return { name: 'list_dir', args: { path: a.path, depth: a.depth } };
    case 'read_file': {
      const start = a.start_line ? Number(a.start_line) : undefined, end = a.end_line ? Number(a.end_line) : undefined;
      return { name: 'read_file', args: { path: a.path, offset: start, limit: start && end && end >= start ? end - start + 1 : (end && !start ? end : undefined) } };
    }
    case 'search_files': return { name: 'grep', args: { pattern: a.query, path: a.path, glob: a.glob, context: 0, max_results: a.max_results } };   // la recherche gère elle-même la limite (et dit s'il en reste)
    case 'edit_file': return { name: 'edit_file', args: { path: a.path, old_string: a.old_text, new_string: a.new_text, replace_all: a.replace_all } };
    case 'write_file': return { name: 'write_file', args: { path: a.path, content: a.content } };
    case 'run_command': return { name: 'shell', args: { command: a.command, cwd: a.cwd, timeout: a.timeout_seconds } };
    default: return null;
  }
}

const parseArgs = a => { if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } } return a || {}; };

async function execNative(S, call, io) {
  const callId = call.callId || call.call_id || call.id;
  const mapped = CLIENT_TOOLS.includes(call.name) ? mapCall(call.name, parseArgs(call.arguments)) : null;
  if (!mapped) return { callId, output: `Outil inconnu ou non pris en charge par le client : ${call.name}`, isError: true };
  if (cfg.mode === 'plan' && !READ_TOOLS.includes(call.name)) {
    return { callId, output: 'Mode plan (lecture seule) : aucune écriture ni commande. Propose un plan détaillé ; l\'utilisateur repassera en mode auto pour l\'appliquer.', isError: true };
  }
  const r = await execCall(S, { name: mapped.name, args: mapped.args }, io);
  let out = String(r.output ?? '');
  if (!r.ok && /REFUSÉ|refusé par la politique/i.test(out)) out = out.includes('REFUSÉ') ? `Commande refusée par l'utilisateur. ${out.replace(/^.*?REFUSÉ cette action\.?/i, '').trim()}`.trim() : out;
  if (out.length > MAX_RESULT && r.cacheKey) forgetRead(S, r.cacheKey);   // lecture coupée : jamais notée « déjà reçue » (sinon la relecture répondrait « inchangé »)
  return { callId, output: clipMiddle(out, MAX_RESULT), isError: !r.ok, cacheKey: r.cacheKey };
}

/** titre d'un document du site utilisable comme fichier du dossier de travail (« carla_env.py », « src/app.js ») ; sinon null */
export function documentFileName(d) {
  let t = String(d?.title || '').trim().replace(/^[`"'«\s]+|[`"'»\s]+$/g, '');
  // « index.html — Nébula » ou « OFFGRID — index.html » → index.html (la partie qui ressemble à un nom de fichier)
  const parts0 = t.split(/\s+[—–\-:|·]\s+/);
  if (parts0.length > 1) { const hit = parts0.find(p => /^[^\s]+\.[A-Za-z0-9]{1,10}$/.test(p.trim())); if (hit) t = hit.trim(); }
  if (!t || t.length > 200 || path.isAbsolute(t) || /^[A-Za-z]:/.test(t)) return null;
  const parts = t.split(/[\\/]+/);
  if (parts.some(p => !p || p === '..' || p === '.' || /[<>:"|?*\x00-\x1f]/.test(p))) return null;
  return /\.[A-Za-z0-9]{1,10}$/.test(parts.at(-1)) ? parts.join('/') : null;
}

/** page HTML du site sans nom de fichier (« ORBIT — Studio créatif ») : index.html si libre, sinon un nom tiré du titre */
export function htmlDocumentName(d, root) {
  const html = /^html?$/i.test(String(d?.kind || '')) || /^\s*<!doctype html|^\s*<html[\s>]/i.test(String(d?.content || ''));
  if (!html) return null;
  if (root && !fs.existsSync(path.join(root, 'index.html'))) return 'index.html';
  const slug = String(d?.title || 'page').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
  return `${slug}.html`;
}

/** document qui n'est pas un fichier (« Rapport », mise à jour sans contenu…) : montré dans le terminal, sinon l'utilisateur ne le voit nulle part */
function showDocument(d) {
  ui.println(c.dim(`  ⓘ document « ${d.title || 'sans titre'} »${d.update ? ' modifié' : ''} dans le panneau du site`));
  if (typeof d.content !== 'string' || !d.content.trim()) return;
  const md = new ui.MdStream({ collapse: false });
  md.push(d.kind === 'code' ? '```\n' + d.content.replace(/\n?$/, '\n') + '```\n' : d.content.replace(/\n?$/, '\n'));
  md.finish();
}

/**
 * Le modèle a mis un fichier dans le « panneau de code » du site (outil serveur createDocument) au lieu d'appeler write_file :
 * le fichier est écrit sur le PC par le MÊME chemin que write_file (politique, confirmation, diff, /rewind), puis le modèle est prévenu.
 */
async function takeDocuments(S, docs, io) {
  for (const d of docs) {
    const name = documentFileName(d) || htmlDocumentName(d, io.root);
    if (!name || typeof d.content !== 'string') {
      showDocument(d);
      S.notes.push(`Le document « ${d.title || 'sans titre'} » est resté dans le panneau de documents du site, que l'utilisateur ne voit pas ici. Pour un fichier, utilise write_file ou edit_file dans le dossier de travail.`);
      continue;
    }
    ui.println(c.dim(`  ↳ « ${d.title} » créé dans le panneau du site : écrit dans le dossier de travail`));
    const r = await execCall(S, { name: 'write_file', args: { path: name, content: d.content } }, io);
    S.notes.push(r.ok
      ? `Ton document « ${d.title} » (panneau de documents du site) a été écrit sur le PC de l'utilisateur dans ${name}. Pour les fichiers, utilise directement write_file et edit_file : l'utilisateur ne voit pas ce panneau.`
      : `Ton document « ${d.title} » n'a pas été écrit sur le PC (${String(r.output || '').slice(0, 200)}). Pour les fichiers, utilise write_file et edit_file.`);
  }
}

// ── Affichage pendant que le modèle travaille ─────────────────────────────────────────────────────────────
// Marqueurs de citation de la recherche web (caractères privés « cite turn…search1 ») : jamais affichés.
export const cleanText = t => (t == null ? t : String(t).replace(/\uE200[^\uE201]*\uE201/g, '').replace(/[\uE000-\uF8FF]/g, '').replace(/([^\n\s])(- \[[ x~]\] )/g, '$1\n$2'));
/** filtre du texte reçu morceau par morceau : citations retirées, « …HTML.- [x] étape » remis à la ligne (même coupé entre deux morceaux) */
export function textCleaner() {
  let inCite = false, hold = '';
  const push = d => {
    let out = '';
    for (const ch of String(d || '')) {
      if (ch === '\uE200') { inCite = true; continue; }
      if (ch === '\uE201') { inCite = false; continue; }
      if (inCite || (ch >= '\uE000' && ch <= '\uF8FF')) continue;
      out += ch;
    }
    let t = (hold + out).replace(/([^\n\s])(- \[[ x~]\] )/g, '$1\n$2');
    hold = t.slice(-6); return t.slice(0, -6);                         // les 6 derniers caractères attendent la suite (« u.- [x] » coupé n'importe où)
  };
  const flush = () => { const t = hold.replace(/([^\n\s])(- \[[ x~]\] )/g, '$1\n$2'); hold = ''; return t; };
  return { push, flush };
}
// ce que fait le modèle, montré en direct (comme le site : « 31 sites consultés », « Exécution de createDocument 19 s »)
const WRITING = { createDocument: 'le modèle écrit un document', updateDocument: 'le modèle modifie un document', write_file: 'le modèle écrit un fichier', edit_file: 'le modèle prépare une modification', run_command: 'le modèle prépare une commande', imageGeneration: 'génération de l\'image', image_generation: 'génération de l\'image' };
function activityTracker() {
  let fn = null, chars = 0, last = 0;
  const fmt = n => (n >= 1000 ? (n / 1000).toFixed(1).replace('.', ',') + 'k' : String(n));
  return (type, d) => {
    if (/^response\.web_search_call\.(in_progress|searching)$/.test(type)) return ui.spinner.show('recherche sur le web…');
    const it = d?.item || {};
    if (type === 'response.output_item.added' && it.type === 'reasoning') return;   // réflexion : l'indicateur affiche déjà un verbe d'attente
    if (type === 'response.output_item.done' && it.type === 'web_search_call') {
      const a = it.action || {};
      const q = a.query || (Array.isArray(a.queries) ? a.queries[0] : '') || '';
      const n = Array.isArray(a.sources) ? a.sources.length : 0;
      ui.toolNote(`⌕ recherche web${q ? ` : « ${String(q).slice(0, 80)} »` : ''}${n ? ` · ${n} source${n > 1 ? 's' : ''}` : ''}`);
      return ui.spinner.show('réflexion…');
    }
    if (type === 'response.output_item.added' && it.type === 'function_call') { fn = it.name || 'outil'; chars = 0; last = 0; return ui.spinner.show(WRITING[fn] || `le modèle prépare ${fn}`); }
    if (type === 'response.function_call_arguments.delta' && fn) {
      chars += String(d.delta || '').length;
      const now = Date.now(); if (now - last < 250) return; last = now;   // pas plus de 4 mises à jour par seconde
      return ui.spinner.show(`${WRITING[fn] || `le modèle prépare ${fn}`} · ${fmt(chars)} caractères`);
    }
    if (type === 'response.output_item.done' && it.type === 'function_call') { fn = null; return ui.spinner.show('réflexion…'); }
    if (type === 'response.image_generation_call.generating' || type === 'response.image_generation_call.in_progress') return ui.spinner.show('génération de l\'image…');
  };
}

/** Tour complet : message → (appels d'outils → résultats)* → réponse finale */
/** modèle OpenAI (GPT) ? fournisseur connu via /chats/agents (S.providers), sinon d'après l'identifiant (Claude = -2xxx) */
export const isOpenAiModel = (S, id = S.agentId) => {
  const p = S.providers?.[String(id)];
  return p ? p === 'openai' : !(Number(id) <= -2000 && Number(id) > -3000);
};

export async function runNative(S, userText, opts) {
  const { signal, ask, stream = streamChat, ctxPct = contextPercent } = opts;
  const firstTurn = !S.chatId;                                         // 1er message d'une conversation (pour la récupération des refus)
  let content = userText;
  if (S.notes.length) { content = `[${S.notes.join(' ')}]\n${content}`; S.notes = []; }
  S.sid ||= newSid();
  if (!S.chatId && cfg.tagChats !== false) content = tag(S.sid, S.tagRole || '') + content;   // agents de /team : « [abcd·w0] »
  const root = baseDir(S);
  const t0 = Date.now();
  let results = null, resultFiles = [], nTools = 0, nReq = 0, tokensIn = 0, tokensOut = 0, steps = 0, hitLimit = false, visible = '';

  const maxSteps = S.maxSteps || cfg.maxSteps || 40;                  // --max-turns : pour cette exécution seulement
  // résumé automatique pendant une longue demande : sur demande seulement (opts.midCompact), ou conversation principale d'une session
  // INTERACTIVE (S.interactive, posé par cli.js hors -p / stdin) : en mode -p le processus s'arrête après la réponse, /continue est impossible.
  // Jamais pour les agents de /team ni le serveur MCP, que rien ne résumerait ensuite. La tâche n'est jamais coupée : le modèle
  // termine l'étape en cours et fait un point d'étape ; le résumé est fait au message suivant (/continue), avant d'envoyer.
  const midCompact = opts.midCompact ?? (S.interactive === true && 'bare' in opts && !S.tagRole);
  let heavyAt = 0;
  for (; steps < maxSteps; steps++) {
    if (signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
    const md = new ui.MdStream({ collapse: false });
    const clean = textCleaner();                                       // citations du web retirées, listes de tâches remises à la ligne
    const activity = activityTracker();                                // « Recherche sur le web… », « Le modèle écrit un document · 12 400 caractères »…
    let thinkBuf = '';
    ui.spinner.start(results ? 'réflexion…' : 'réflexion…');
    let res;
    try {
      res = await stream({
        agentId: S.agentId, chatId: S.chatId, signal, webSearch: cfg.webSearch, register: { sid: S.sid, role: 'main' },
        clientTools: cfg.mode === 'plan' ? READ_TOOLS : CLIENT_TOOLS,...(results ? { toolResults: results, files: resultFiles } : { content, files: S.pendingFileIds }),   // images : avec le message, ou avec les résultats (captures d'outils)
        onChat: id => { if (!S.chatId) S.chatId = id; },
        onText: d => { const t = clean.push(d); if (t) md.push(t); },
        onEvent: (type, d) => activity(type, d),
        onReasoning: d => {
          ui.rememberThinking(d);                                       // gardée pour Ctrl+O
          if (!cfg.showThinking) return;
          thinkBuf += d; let i;
          while ((i = thinkBuf.indexOf('\n')) >= 0) { ui.println(c.dim(c.italic('  ✻ ' + thinkBuf.slice(0, i)))); thinkBuf = thinkBuf.slice(i + 1); }
        },
      });
    } finally { ui.spinner.stop(); }
    { const t = clean.flush(); if (t) md.push(t); }
    md.finish(); nReq++;
    const u = res.usage;
    let reqIn = 0;
    if (u && typeof u === 'object') for (const [k, v] of Object.entries(u)) {
      if (typeof v !== 'number' || /total|reasoning|cached/i.test(k)) continue;
      if (/prompt|input/i.test(k)) { tokensIn += v; reqIn += v; } else if (/candidate|compl|output/i.test(k)) tokensOut += v;
    }
    if (reqIn) S.lastPromptTokens = reqIn;                              // taille du contexte envoyé à cette requête (résumé auto au-delà du seuil)
    visible = cleanText(res.text)?.trim() || visible;
    if (res.sawImage && S.chatId) {                                     // image générée par France Student : enregistrée sur le PC et montrée
      const imgs = res.images?.length ? res.images : await lastMessageImages(S.chatId).catch(() => []);
      for (const im of imgs) {
        const name = `image-${new Date().toISOString().slice(0, 10)}-${String(im.id || Date.now()).slice(0, 8)}.${im.ext}`;
        try {
          const data = await fetchApiFile(im.url);                          // en mémoire : affichée directement
          if (ui.showsImages()) {                                            // panneau : affichée, « Enregistrer… » pour la garder
            ui.image({ data, mime: im.contentType, prompt: im.prompt, name });
            S.notes.push(`Une image générée a été affichée à l'utilisateur (${name}) ; il peut l'enregistrer d'un clic. Si elle doit servir dans le projet, demande-lui de l'enregistrer dans le dossier voulu.`);
          } else {                                                           // terminal : il ne peut pas afficher d'image → fichier
            const file = path.join(HOME_DIR, 'images', name);
            fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
            ui.image({ data, file, mime: im.contentType, prompt: im.prompt, name });
            S.notes.push(`Image générée enregistrée sur le PC de l'utilisateur : ${file}. Pour l'utiliser dans le projet, copie-la dans le dossier voulu avec run_command.`);
          }
        } catch (e) { ui.println(c.yellow(`  image générée, mais récupération impossible : ${e.message}`)); }
      }
    }
    if (res.documents?.length) await (opts.readDocument ? withDocumentContents(res.documents, opts.readDocument) : withDocumentContents(res.documents));   // document mis à jour : sa version actuelle, lue sur le site
    if (res.documents?.length && !(cfg.mode === 'plan')) await takeDocuments(S, res.documents, { signal, ask, root });
    else if (res.documents?.length) for (const d of res.documents) showDocument(d);   // mode plan : rien n'est écrit, le document est seulement montré
    const calls = res.toolCalls || [];
    if (!calls.length) break;
    // dernière étape autorisée : ces appels ne sont PAS exécutés. Leurs résultats ne pourraient pas être renvoyés, et France Student
    // les rejoue alors comme « non exécutés » → /continue les fait faire une fois, à juste titre (avant : faits ET refaits)
    if (steps === maxSteps - 1) { hitLimit = true; break; }

    // exécution des appels, dans l'ordre ; tous reçoivent une réponse (exigé par FS)
    results = [];
    let total = 0;
    const done = [];                                                    // actions vraiment faites de ce lot (pour Ctrl+C)
    for (const call of calls.slice(0, 32)) {
      if (signal.aborted) {
        if (done.length) S.notes.push(`Avant l'interruption par l'utilisateur, ces actions ont VRAIMENT été exécutées (ne les refais pas) : ${done.join(' ; ')}.`);
        throw Object.assign(new Error('annulé'), { name: 'AbortError' });
      }
      nTools++;
      let r = await execNative(S, call, { signal, ask, root });
      { const a = parseArgs(call.arguments); done.push(`${call.name}${a.path ? ' ' + a.path : a.command ? ' « ' + String(a.command).slice(0, 80) + ' »' : ''} (${r.isError ? 'échec' : 'ok'})`); }
      if (total + r.output.length > MAX_TOTAL) { forgetRead(S, r.cacheKey); r = { ...r, output: r.output.slice(0, Math.max(500, MAX_TOTAL - total)) + '\n[… coupé : lis une plage plus étroite]' }; }
      delete r.cacheKey;                                                 // FS n'attend que callId, output, isError
      total += r.output.length; results.push(r);
    }
    // conversation très chargée (≥ 1,5 × le seuil du résumé) : une seule fois, demande au modèle de finir l'étape en cours puis de s'arrêter
    if (midCompact && !heavyAt && reqIn && results.length && cfg.autoCompact && S.chatId && (cfg.dailyLimitHitAt || 0) < lastReset()) {
      const { compactLimit } = await import('./extra-commands.js');
      if (reqIn >= 1.5 * compactLimit(S)) {
        heavyAt = reqIn; S.needCompact = S.chatId;                       // lu par maybeAutoCompact au prochain message de CETTE conversation
        const last = results.length - 1, add = '\n\n' + HEAVY_NOTE;
        let out = results[last].output;
        const over = Math.max(total + add.length - MAX_TOTAL, out.length + add.length - MAX_RESULT, 0);
        if (over) out = out.slice(0, Math.max(0, out.length - over));
        results[last] = { ...results[last], output: out + add };
      }
    }
    // captures renvoyées par les outils (navigateur, Blender…) : envoyées sur Files v2 et jointes à ces résultats → le modèle les VOIT
    resultFiles = [];
    for (const img of takeQueuedImages(4)) {
      try { resultFiles.push(await uploadFile(fs.readFileSync(img.file), path.basename(img.file), img.mime)); } catch {}
    }
    if (resultFiles.length) ui.toolNote(`📷 ${resultFiles.length} capture${resultFiles.length > 1 ? 's' : ''} transmise${resultFiles.length > 1 ? 's' : ''} au modèle`);
  }
  if (visible) S.lastResponse = visible;
  if (nTools && cfg.toolRefusals?.[String(S.agentId)]) { const r = { ...cfg.toolRefusals }; delete r[String(S.agentId)]; saveCfgKeys({ toolRefusals: r }); }
  // Le modèle croit ne pas avoir le droit d'utiliser les outils (« pas de moteur pour un agent externe »). Or ce sont les outils client OFFICIELS
  // de France Student (doc « client tools » : prévus pour les IDE et CLI). Récupération transparente, affichée, désactivable (cfg.refusalRecover) :
  // 1) une seule précision factuelle au modèle ; 2) s'il refuse encore, la même demande repart avec Sonnet (ou Opus). Rien de caché, aucun faux en-tête.
  const refused = !nTools && cfg.mode !== 'plan' && looksLikeToolRefusal(visible);
  const stage = opts._recover || 0;
  const fallback = String(S.agentId) === '-2003' ? -2001 : String(S.agentId) === '-2001' ? null : -2003;
  const recover = refused && cfg.refusalRecover !== false && !signal.aborted && (stage === 0 || (stage === 1 && fallback !== null));
  if (refused && !recover) {
    saveCfgKeys({ toolRefusals: { ...(cfg.toolRefusals || {}), [String(S.agentId)]: Date.now() } });
    const other = String(S.agentId) === '-2003' ? '/model opus' : '/model sonnet';
    ui.println('\n' + c.yellow('  ⚠ Le modèle a refusé d\'utiliser les outils pour cette demande : il n\'a rien lu ni modifié.'));
    ui.println(c.dim('    Ça arrive surtout quand la demande ou le projet parle de France Student elle-même (son API, des outils externes), ou quand la conversation est très longue. Reformule, repars de zéro avec ') +
      c.accent('/new') + c.dim(', ou essaie ') + c.accent(other));
  }

  const secs = (Date.now() - t0) / 1000;
  const bits = [ui.duration(secs)];
  if (nTools) bits.push(`${nTools} outil${nTools > 1 ? 's' : ''}`);
  bits.push(`${nReq} requête${nReq > 1 ? 's' : ''}`);
  if (tokensIn > 0 && tokensOut > 0) bits.push(`${tokensIn >= 1000 ? (tokensIn / 1000).toFixed(1) + 'k' : tokensIn}↑ ${tokensOut >= 1000 ? (tokensOut / 1000).toFixed(1) + 'k' : tokensOut}↓ tok`);
  S.tokens.in += tokensIn; S.tokens.out += tokensOut;
  S.stats ||= { turns: 0, requests: 0, tools: 0 }; S.stats.turns++; S.stats.requests += nReq; S.stats.tools += nTools;   // pour /usage
  let ctxBit = '';
  if (S.chatId) {
    S.ctxPercent = await ctxPct(S.chatId).catch(() => null);
    if (typeof S.ctxPercent === 'number') { const p = Math.round(S.ctxPercent); ctxBit = ' · ' + (p >= 80 ? c.red : p >= 60 ? c.yellow : c.dim)(`ctx ${p}%`); }
  }
  ui.println('\n' + c.dim(`  ✻ Terminé en ${bits.join(' · ')}`) + ctxBit);
  if (secs > 15 && process.stdout.isTTY) process.stdout.write('\x07');   // tâche longue finie : alerte (la barre des tâches clignote si la fenêtre n'est pas au premier plan)
  if (cfg.sound && secs > 3) process.stdout.write('\x07');
  if (hitLimit) ui.println(c.yellow(`  ⚠ limite de ${maxSteps} étapes atteinte — tape /continue pour poursuivre`));
  if (heavyAt) ui.println(c.yellow(`  ⚠ conversation très chargée (≈${Math.round(heavyAt / 1000)}k tokens par requête) : elle sera résumée avant ton prochain message.`) +
    c.dim('\n    Si la tâche n\'est pas finie, tape /continue : elle reprendra dans une conversation légère, à partir du résumé (rien n\'est perdu).'));
  if (recover && stage === 0) {
    // GPT qui refuse dès le 1er message : la précision dans la même conversation échoue souvent (le refus reste dans l'historique).
    // Testé en vrai : la MÊME demande, seule, dans une conversation neuve, passe. Coût : 1 conversation (limite de 50 par jour).
    const bare = typeof opts.bare === 'string' ? opts.bare.trim() : '';
    if (firstTurn && bare && bare !== String(userText).trim() && isOpenAiModel(S)) {
      ui.println(c.dim('  ↻ le modèle a refusé dès le 1er message : nouvel essai dans une conversation neuve, avec ta demande seule (sans les infos ajoutées par FS-CLI)'));
      S.chatId = null; S.ctxSent = true; S.bareChat = true;            // cette conversation-là ne reçoit rien d'autre que tes messages (remis à zéro avec /new)
      return runNative(S, bare, { ...opts, bare: null, _recover: 1, _orig: bare });
    }
    ui.println(c.dim('  ↻ le modèle a cru ne pas avoir le droit d\'utiliser les outils : FS-CLI lui précise que ce sont les outils officiels de France Student'));
    S.pendingFileIds = [];                                              // les images sont déjà dans la conversation : pas renvoyées avec la précision
    return runNative(S, CLARIFY, { ...opts, _recover: 1, _orig: userText });
  }
  if (recover && stage === 1) {
    const from = S.agentId;
    S.agentId = fallback;
    ui.println(c.dim(`  ↻ toujours un refus : la demande repart avec ${fallback === -2001 ? 'Claude Opus' : 'Claude Sonnet'} (même conversation ; /model pour changer de modèle)`));
    const r = await runNative(S, opts._orig || userText, { ...opts, _recover: 2 });
    return { ...r, switchedFrom: from, switchedTo: fallback };
  }
  return { hitLimit, nReq };
}

/** précision envoyée UNE fois quand un modèle croit ne pas avoir le droit d'utiliser les outils (vrai, documenté par France Student) */
export const CLARIFY = 'Précision : list_directory, read_file, search_files, edit_file, write_file et run_command sont les outils client officiels de France Student ' +
  '(fonction « outils client » de la plateforme, prévue pour les IDE et les CLI) : c\'est le serveur de France Student qui te les déclare et qui transmet tes appels à mon PC, avec mon accord. ' +
  'Tu peux donc les utiliser pour faire ma demande précédente.';
