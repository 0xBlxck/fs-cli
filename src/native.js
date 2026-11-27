// Moteur NATIF : vrais appels d'outils via le mode officiel « outils client » de France Student.
// FS déclare les outils au modèle, nous renvoie les appels dans completed.message.toolCalls, nous les exécutons ICI (avec nos garde-fous :
// politique de commandes, confirmations, secrets, chemins limités au workspace) et renvoyons les résultats avec toolResults.
// Documentation FS : « Outils client (mode avancé) », flag 2026_11_client_tools.
import fs from 'node:fs';
import path from 'node:path';
import { streamChat, CLIENT_TOOLS, uploadFile, lastMessageImages, fetchApiFile, withDocumentContents, resumeStream, fetchChat, documentsOf, imagesOf, cancelStream, firewallProbe, FIREWALL_NETWORK } from './api.js';
import { firewallContentMessage } from './firewall.js';
import { recoverSend } from './resilient.js';
import { prettifyIfMinified, PRETTY_NOTE } from './prettify.js';
import { HOME_DIR } from './config.js';
import { takeQueuedImages } from './vision.js';
import { contextPercent, chatBudget, budgetText, fetchChatContext } from './account.js';
import { cfg, saveCfg, saveCfgKeys } from './config.js';
import { newSid, tag, lastReset } from './chats.js';
import { execCall, baseDir, forgetRead } from './agent.js';
import { clipMiddle } from './tools.js';
import { shares } from './output.js';
import { todoView } from './todos.js';
import * as ui from './ui.js';
import { c } from './ui.js';

export const READ_TOOLS = CLIENT_TOOLS.slice(0, 3);
// Certains modèles de France Student refusent de servir d'agent à un outil externe (« ne peut pas servir de moteur à ton outil externe »,
// « colle ici le contenu »…). FS-CLI ne contourne pas ce refus : il l'explique et propose un modèle qui accepte les outils.
const TOOL_REFUSAL = /servir de moteur|(?:moteur|outil|agent) (?:d'un |à un |pour un )?(?:agent |outil )?externe|(?:je ne (?:peux|pourrai) pas|nous ne pouvons pas|impossible pour moi de) (?:piloter|contr[ôo]ler|utiliser) (?:FS-CLI|tes outils|les outils|ton (?:PC|ordinateur|disque))|(?:je ne (?:peux|pourrai) pas|nous ne pouvons pas) (?:acc[ée]der|modifier|[ée]crire|lire|ex[ée]cuter|cr[ée]er|lancer|ouvrir)\b[^.]{0,60}\b(?:tes |vos |ton |votre )(?:fichiers?|disque|dossier|commandes?|ordinateur|PC|machine)|je n'ai pas (?:d'|l')?acc[èe]s (?:à|aux) (?:tes |ton |vos |votre )(?:fichiers?|disque|dossier|syst[èe]me|ordinateur|PC|machine)|colle[rz]?(?:-le)? ici (?:le )?contenu/i;   // 1re personne + « ici » obligatoires (audit 17/11 : 6 réponses normales sur 7 prises pour des refus)
// seulement le DÉBUT de la réponse (un refus se dit d'entrée) : « Python ne peut pas lire le fichier… » plus loin n'est pas un refus (audit 17/11)
export const looksLikeToolRefusal = text => TOOL_REFUSAL.test(String(text || '').slice(0, 400));
// GPT-6 Astra + recherche web : OpenAI échoue souvent juste après la recherche (« 502 BAD_GATEWAY openai_v2 responses request failed »,
// 6 essais sur 7 le 18/11/2026 ; sans recherche web : écrit du premier coup). Erreur du serveur, pas un refus.
/** remplace un résultat d'outil que le pare-feu de France Student refuse de laisser passer (jamais déguisé) */
export const FIREWALL_NOTE = 'Contenu non transmis : le pare-feu de France Student a refusé ce résultat (souvent à cause de ce que contient le fichier ou la sortie). Dis-le à l\'utilisateur et continue sans ce contenu.';
export const isUpstreamError =e => !!e && e.name !== 'AbortError' && e.code !== 'DAILY_CHAT_LIMIT'
  && ((e.serverError && /openai_v2|BAD_GATEWAY|\b50[0234]\b|error occurred while processing your request|overloaded|internal server error/i.test(e.message || '')) || e.status >= 500);   // list_directory, read_file, search_files : seuls outils proposés en mode plan
const MAX_RESULT = 40000;     // limite FS par résultat (au-delà FS coupe et prévient le modèle)
const MAX_TOTAL = 120000;      // limite FS par envoi
const MAX_RESULTS = 32;        // limite FS de toolResults par envoi (« Too many toolResults (at most 32) », vu en vrai)

/** Plus de 32 appels dans un tour : leurs résultats en texte, pour un message normal (voir runNative). */
export function overflowText(calls, results) {
  const parts = results.map((r, i) => {
    const call = calls.find(c => String(c.callId || c.call_id || c.id) === String(r.callId)) || calls[i] || {};
    const a = parseArgs(call.arguments);
    const what = `${call.name || 'outil'}${a.path ? ' ' + a.path : a.command ? ' « ' + String(a.command).slice(0, 120) + ' »' : ''}`;
    return `### ${i + 1}. ${what}${r.isError ? ' (échec)' : ''}\n${r.output}`;
  });
  return `[Message de FS-CLI, pas de l'utilisateur. Tes ${results.length} appels d'outils de ce tour ONT TOUS été exécutés sur le PC de l'utilisateur. `
    + `France Student n'accepte que ${MAX_RESULTS} résultats d'outils par envoi : leurs résultats réels sont donc transmis ci-dessous en texte, `
    + `et la plateforme te les signale « non exécutés » pour cette seule raison. Utilise ces résultats comme ceux de tes outils, sans les refaire, `
    + `et continue la tâche. Au prochain tour, fais au plus ${MAX_RESULTS} appels.]\n\n${parts.join('\n\n')}`;
}
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
  // write_file avec du code minifié sur une ligne (HTML, CSS, JS) : remis en forme sur le PC, sans token, même code
  let pretty = false;
  if (mapped.name === 'write_file' && typeof mapped.args.content === 'string') {
    const content = prettifyIfMinified(mapped.args.path, mapped.args.content);
    if (content !== mapped.args.content) { mapped.args.content = content; pretty = true; }
  }
  const r = await execCall(S, { name: mapped.name, args: mapped.args }, io);
  let out = String(r.output ?? '');
  if (pretty && r.ok) out += `\n${PRETTY_NOTE}`;
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

/** langage d'un document de code d'après son contenu (le site ne le donne pas) → extension */
const CODE_EXT = [[/^\s*(use\s+\w+::|fn\s+main\s*\(|\[package\])/m, 'rs'], [/^\s*(def |import \w+|from \w+ import |if __name__)/m, 'py'],
  [/^\s*<\?php/, 'php'], [/^\s*(package\s+main|func\s+main\s*\()/m, 'go'], [/^\s*#include\s*</m, 'cpp'],
  [/^\s*(public\s+class|import\s+java\.)/m, 'java'], [/^\s*(import .* from ['"]|export (default |const |function )|const \w+ = require\()/m, 'js'],
  [/^\s*(#!\/bin\/(ba)?sh|set -e)/m, 'sh'], [/^\s*[{[]/, 'json']];

/**
 * Document du site SANS nom de fichier ni HTML (« Arcade Deck — prototype Rust/Bevy », vu sur Discord avec GPT) : avant, il restait
 * sur le site et l'utilisateur ne récupérait rien. Écrit sous un nom tiré du titre (jamais par-dessus un fichier existant).
 * Les mises à jour d'un document ne créent pas de nouveau fichier.
 */
export function fallbackDocumentName(d, root) {
  if (d?.update || typeof d?.content !== 'string' || !d.content.trim()) return null;
  const slug = String(d.title || 'document').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'document';
  const ext = /^code$/i.test(String(d.kind || '')) ? (CODE_EXT.find(([re]) => re.test(d.content))?.[1] || 'txt') : 'md';
  for (let n = 1; n < 100; n++) {
    const name = `${slug}${n > 1 ? '-' + n : ''}.${ext}`;
    if (!root || !fs.existsSync(path.join(root, name))) return name;
  }
  return null;
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
    const named = documentFileName(d) || htmlDocumentName(d, io.root);
    const name = named || fallbackDocumentName(d, io.root);
    if (!name || typeof d.content !== 'string') {
      showDocument(d);
      S.notes.push(`Le document « ${d.title || 'sans titre'} » est resté dans le panneau de documents du site, que l'utilisateur ne voit pas ici. Pour un fichier, utilise write_file ou edit_file dans le dossier de travail.`);
      continue;
    }
    ui.println(c.dim(named ? `  ↳ « ${d.title} » créé dans le panneau du site : écrit dans le dossier de travail`
      : `  ↳ « ${d.title} » créé dans le panneau du site (sans nom de fichier) : copie écrite dans ${name}`));
    // code minifié sur une ligne (HTML, CSS, JS) : remis sur plusieurs lignes, sur le PC (aucun token), sans changer ce qu'il fait
    const content = prettifyIfMinified(name, d.content);
    const pretty = content !== d.content;
    if (pretty) ui.println(c.dim(`  ↳ code reçu sur une seule ligne : remis en forme (${content.split('\n').length} lignes)`));
    const r = await execCall(S, { name: 'write_file', args: { path: name, content } }, io);
    S.notes.push(r.ok
      ? `Ton document « ${d.title} » (panneau de documents du site) a été écrit sur le PC de l'utilisateur dans ${name}.${named ? '' : ' S\'il contient plusieurs fichiers d\'un projet, crée chacun d\'eux à sa place avec write_file.'}${pretty ? ' Il a été remis sur plusieurs lignes (même code) : relis-le avant de le modifier avec edit_file.' : ''} Pour les fichiers, utilise directement write_file et edit_file : l'utilisateur ne voit pas ce panneau.`
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
      const page = !q && typeof a.url === 'string' ? a.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80) : '';
      // GPT envoie aussi des « recherches » sans requête, sans page ni source (vu en vrai : une ligne vide après chaque étape) : rien à montrer
      if (q || n) ui.toolNote(`⌕ recherche web${q ? ` : « ${String(q).slice(0, 80)} »` : ''}${n ? ` · ${n} source${n > 1 ? 's' : ''}` : ''}`);
      else if (page) ui.toolNote(`⌕ page lue : ${page}`);
      return ui.spinner.show('réflexion…');
    }
    if (type === 'response.output_item.added' && it.type === 'function_call') { fn = it.name || 'outil'; chars = 0; last = 0; return ui.spinner.show(WRITING[fn] || `le modèle prépare ${fn}`); }
    if (type === 'response.function_call_arguments.delta' && fn) {
      chars += String(d.delta || '').length; ui.liveTokens.add(d.delta);
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
  const ctxOf = opts.ctxOf !== undefined ? opts.ctxOf : (opts.stream ? null : fetchChatContext);   // contexte mesuré par FS (vrai chiffre d'entrée)
  const measures = [];                                                 // une mesure par requête : tokens relus = contexte après − tokens écrits
  const budgetOf = opts.budget !== undefined ? opts.budget : (opts.stream ? null : chatBudget);
  const resumeFn = opts.resume !== undefined ? opts.resume : (opts.stream ? null : resumeStream);      // rattachement après coupure (tests : injecté)
  const fetchChatFn = opts.fetchChat !== undefined ? opts.fetchChat : (opts.stream ? null : fetchChat);   // budget de chat du compte (tests : désactivé)
  const probeFn = opts.probe !== undefined ? opts.probe : (opts.stream ? null : firewallProbe);   // pare-feu : réseau ou contenu ? (tests : injecté)
  ui.liveTokens.reset();                                              // ↓ tokens en direct dans l'indicateur d'attente (comme Claude Code)
  const firstTurn = !S.chatId;                                         // 1er message d'une conversation (pour la récupération des refus)
  let content = userText;
  // « Info de FS-CLI » : reconnu et masqué quand la conversation est reprise (sinon la note s'affiche comme un message de l'utilisateur)
  if (S.notes.length) { content = `[Info de FS-CLI : ${S.notes.join(' ')}]\n${content}`; S.notes = []; }
  S.sid ||= newSid();
  if (!S.chatId && cfg.tagChats !== false) content = tag(S.sid, S.tagRole || '') + content;   // agents de /team : « [abcd·w0] »
  const root = baseDir(S);
  const t0 = Date.now();
  let results = null, resultFiles = [], msgFiles = null, nTools = 0, nReq = 0, tokensIn = 0, tokensOut = 0, steps = 0, hitLimit = false, visible = '';

  const maxSteps = S.maxSteps || cfg.maxSteps || 40;                  // --max-turns : pour cette exécution seulement
  // résumé automatique pendant une longue demande : sur demande seulement (opts.midCompact), ou conversation principale d'une session
  // INTERACTIVE (S.interactive, posé par cli.js hors -p / stdin) : en mode -p le processus s'arrête après la réponse, /continue est impossible.
  // Jamais pour les agents de /team ni le serveur MCP, que rien ne résumerait ensuite. La tâche n'est jamais coupée : le modèle
  // termine l'étape en cours et fait un point d'étape ; le résumé est fait au message suivant (/continue), avant d'envoyer.
  const midCompact = opts.midCompact ?? (S.interactive === true && 'bare' in opts && !S.tagRole);
  let heavyAt = 0, noWeb = false;                                      // noWeb : recherche web coupée pour le reste de la demande après une erreur d'OpenAI
  for (; steps < maxSteps; steps++) {
    if (measures.length) await measures[measures.length - 1];          // mesure de la requête précédente faite AVANT d'envoyer la suivante (sinon elle compterait ses résultats)
    if (signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
    const md = new ui.MdStream({ collapse: false });
    const clean = textCleaner();                                       // citations du web retirées, listes de tâches remises à la ligne
    const todo = todoView(S);                                          // le modèle n'écrit que les étapes qui changent : la liste complète à jour est affichée
    const activity = activityTracker();                                // « Recherche sur le web… », « Le modèle écrit un document · 12 400 caractères »…
    let thinkBuf = '';
    ui.spinner.start(results ? 'réflexion…' : 'réflexion…');
    let res, received = '', userMsgId = null;
    const handlers = {
      onChat: id => { if (!S.chatId) S.chatId = id; },
      onText: d => { received += d; ui.liveTokens.add(d); const t = todo.push(clean.push(d)); if (t) md.push(t); },
      onEvent: (type, d) => activity(type, d),
      onUserMessageId: id => { userMsgId = id ?? null; },
      onReasoning: d => {
        ui.liveTokens.add(d); ui.rememberThinking(d);                                       // gardée pour Ctrl+O
        if (!cfg.showThinking) return;
        thinkBuf += d; let i;
        while ((i = thinkBuf.indexOf('\n')) >= 0) { ui.println(c.dim(c.italic('  ✻ ' + thinkBuf.slice(0, i)))); thinkBuf = thinkBuf.slice(i + 1); }
      },
    };
    const send = web => stream({
        agentId: S.agentId, chatId: S.chatId, signal, webSearch: web, register: { sid: S.sid, role: 'main' },
        clientTools: cfg.mode === 'plan' ? READ_TOOLS : CLIENT_TOOLS,...(results ? { toolResults: results, files: resultFiles } : { content, files: msgFiles ?? S.pendingFileIds }),   // images : avec le message, ou avec les résultats (captures d'outils)
        ...handlers,
      });
    // Pare-feu de France Student (Cloudflare, 403 en page HTML) : un nouvel essai 3 s plus tard (blocage passager).
    // S'il bloque encore l'envoi de résultats d'outils, c'est leur CONTENU qui est refusé : on ne le déguise pas,
    // on envoie à la place une note « contenu non transmis » pour que la demande continue (et on le dit).
    const sendPastFirewall = async web => {
      try { return await send(web); }
      catch (e) {
        if (e?.code !== 'FIREWALL' || signal.aborted) throw e;
        ui.spinner.stop();
        ui.println(c.yellow('  ⚠ le pare-feu de France Student a bloqué l\'envoi : nouvel essai dans 3 s'));
        await new Promise(r => setTimeout(r, opts.firewallDelayMs ?? 3000));
        ui.spinner.start('réflexion…');
        try { return await send(web); }
        catch (e2) {
          if (e2?.code === 'FIREWALL' && !results?.length && !signal.aborted && probeFn) {
            // la demande elle-même est bloquée : réseau ou contenu ? une petite requête sans contenu tranche
            const net = await probeFn().catch(() => null);
            const bare = typeof opts.bare === 'string' ? opts.bare.trim() : '';
            if (net === 'ok' && bare && String(content).trim() !== bare) {   // contenu : souvent le contexte joint par FS-CLI → la demande seule, une fois
              ui.spinner.stop();
              ui.println(c.yellow('  ⚠ le pare-feu refuse ta demande avec le contexte joint (instructions du projet, notes) : renvoyée seule'));
              ui.spinner.start('réflexion…');
              content = bare;
              try { return await send(web); } catch (e3) { if (e3?.code !== 'FIREWALL') throw e3; e2 = e3; }
            }
            if (net === 'ok' || net === 'blocked') e2.message = net === 'ok' ? firewallContentMessage(content) : FIREWALL_NETWORK;
            throw e2;
          }
          if (e2?.code !== 'FIREWALL' || !results?.length || signal.aborted) throw e2;
          ui.spinner.stop();
          ui.println(c.yellow(`  ⚠ le pare-feu bloque le contenu renvoyé au modèle (${results.length} résultat${results.length > 1 ? 's' : ''}) : il reçoit une note « contenu non transmis » à la place`));
          results = results.map(r => ({ callId: r.callId, output: FIREWALL_NOTE, isError: true }));
          resultFiles = [];
          ui.spinner.start('réflexion…');
          return await send(web);
        }
      }
    };
    // coupure après acceptation, 409, 400 « missing » : récupération d'après client-tools.md (src/resilient.js), jamais de message renvoyé
    const sendSafe = web => sendPastFirewall(web).catch(e => {
      if (!resumeFn || !fetchChatFn || signal.aborted) throw e;
      return recoverSend(e, {
        chatId: () => S.chatId, results, signal, fetchChat: fetchChatFn,
        resend: patch => { if (patch.toolResults) results = patch.toolResults; return sendPastFirewall(web); },
        resume: (id, last) => resumeFn(id, last, { ...handlers, signal, ...(last == null ? { onText: skipSeen(), onReasoning: () => {} } : {}) }),
        received: () => received, userMessageId: () => userMsgId, onText: handlers.onText,
        cancel: id => (opts.cancel ?? (opts.stream ? null : cancelStream))?.(id),
        note: m => { ui.spinner.stop(); ui.println(c.yellow('  ⚠ ' + m)); ui.spinner.start('réflexion…'); },
        delays: opts.reattachDelays, busyDelays: opts.busyDelays, parts: { documentsOf, imagesOf },
      }).then(r => ({ ...r, text: received || r.text || '' }));          // texte COMPLET (début reçu avant la coupure + suite)
    });
    // rattachement sans Last-Event-ID : FS rejoue tout depuis le début → ce qui est déjà affiché n'est pas réaffiché
    const skipSeen = () => { let pos = 0; return d => {
      const s = String(d ?? '');
      let i = 0;
      while (i < s.length && pos < received.length && s[i] === received[pos]) { i++; pos++; }
      if (i < s.length) { pos = Infinity; handlers.onText(s.slice(i)); }
    }; };
    try {
      const web = !!cfg.webSearch && !noWeb;
      try { res = await sendSafe(web); }
      catch (e) {
        // recherche web active et erreur d'OpenAI : la même demande repart une fois sans recherche web (affiché, rien de caché)
        if (!web || signal.aborted || !isUpstreamError(e)) throw e;
        noWeb = true;
        ui.spinner.stop();
        ui.println(c.yellow('  ⚠ le serveur d\'OpenAI a échoué après la recherche web : nouvel essai sans recherche web pour cette demande'));
        ui.spinner.start('réflexion…');
        try { res = await sendSafe(false); } catch (e2) { throw e2?.name === 'AbortError' ? e2 : e; }
      }
    } finally { ui.spinner.stop(); }
    { const t = todo.push(clean.flush()) + todo.flush(); if (t) md.push(t); }
    md.finish(); nReq++;
    const u = res.usage;
    let reqIn = 0, reqOut = 0;
    if (u && typeof u === 'object') for (const [k, v] of Object.entries(u)) {
      if (typeof v !== 'number' || /total|reasoning|cached/i.test(k)) continue;
      if (/prompt|input/i.test(k)) { tokensIn += v; reqIn += v; } else if (/candidate|compl|output/i.test(k)) { tokensOut += v; reqOut += v; }
    }
    // vrai chiffre d'entrée de cette requête (Claude : promptTokenCount ne compte que la partie hors cache) ; lu pendant que les outils tournent
    if (ctxOf && S.chatId) measures.push(Promise.resolve(ctxOf(S.chatId)).then(m => (m ? Math.max(0, m.usedTokens - reqOut) : null)).catch(() => null));
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
    // Ctrl+C / Échap : ce qui a vraiment été fait est noté pour le modèle. Vérifié avant chaque action ET après la dernière
    // (avant : une commande arrêtée en dernier, ex. un rendu seul, n'était notée nulle part → « il n'a pas démarré »)
    const stopIfAborted = () => {
      if (!signal.aborted) return;
      if (done.length) S.notes.push(`Avant l'interruption par l'utilisateur, ces actions ont VRAIMENT été exécutées (ne refais pas celles qui ont abouti) : ${done.join(' ; ')}.`
        + (done.some(d => d.includes('arrêtée par l\'utilisateur')) ? ' Une commande arrêtée avant la fin a commencé son travail sans le terminer : dis-le tel quel (depuis combien de temps elle tournait) au lieu de dire qu\'elle n\'a pas démarré.' : ''));
      throw Object.assign(new Error('annulé'), { name: 'AbortError' });
    };
    for (const call of calls) {
      stopIfAborted();
      nTools++;
      const tCall = Date.now();
      let r;
      try { r = await execNative(S, call, { signal, ask, root }); }
      catch (e) {
        if (e?.name !== 'AbortError') throw e;
        r = { callId: call.callId || call.call_id || call.id, output: '', isError: true };   // arrêtée en cours : notée ci-dessous, puis arrêt
      }
      {
        const a = parseArgs(call.arguments);
        // arrêtée par l'utilisateur en cours de route : depuis combien de temps elle tournait (vu : un rendu arrêté après
        // 6 min 30, et le modèle croyait qu'il « n'avait pas démarré »)
        const s = Math.round((Date.now() - tCall) / 1000);
        const state = signal.aborted ? `arrêtée par l'utilisateur après ${s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`} d'exécution, avant la fin` : r.isError ? 'échec' : 'ok';
        done.push(`${call.name}${a.path ? ' ' + a.path : a.command ? ' « ' + String(a.command).slice(0, 80) + ' »' : ''} (${state})`);
      }
      total += r.output.length; results.push(r);
    }
    stopIfAborted();
    // limite FS par envoi : parts équitables (les petits résultats intacts, les gros se partagent le reste) au lieu de premier servi
    if (total > MAX_TOTAL) {
      const share = shares(results.map(r => r.output.length), MAX_TOTAL - 64 * results.length);
      results = results.map((r, i) => {
        if (r.output.length <= share[i]) return r;
        forgetRead(S, r.cacheKey);                                       // lecture coupée : jamais notée « déjà reçue »
        return { ...r, output: r.output.slice(0, Math.max(0, share[i] - 48)) + '\n[… coupé : lis une plage plus étroite]' };
      });
      total = results.reduce((s, r) => s + r.output.length, 0);
    }
    results = results.map(({ cacheKey, ...r }) => r);                   // FS n'attend que callId, output, isError
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
    // Vu en vrai : FS laisse le modèle demander plus de 32 actions, mais refuse plus de 32 toolResults (« Too many toolResults »)
    // ET exige une réponse à chacune (« missing ») : impossible par toolResults. Sortie prévue par client-tools.md : un message
    // normal (les appels sont rejoués au modèle « non exécutés »), qui porte les résultats en texte et dit qu'ils ONT été exécutés.
    if (results.length > MAX_RESULTS) {
      content = overflowText(calls, results);
      msgFiles = resultFiles; results = null;
      ui.toolNote(`${calls.length} actions dans un tour (France Student en accepte 32 par envoi) : résultats transmis en texte`);
    } else msgFiles = null;
  }
  if (visible) S.lastResponse = visible;
  if (nTools && cfg.toolRefusals?.[String(S.agentId)]) { const r = { ...cfg.toolRefusals }; delete r[String(S.agentId)]; saveCfgKeys({ toolRefusals: r }); }
  // Le modèle croit ne pas avoir le droit d'utiliser les outils (« pas de moteur pour un agent externe »). Or ce sont les outils client OFFICIELS
  // de France Student (doc « client tools » : prévus pour les IDE et CLI). Récupération transparente, affichée, désactivable (cfg.refusalRecover) :
  // 1) une seule précision factuelle au modèle (même modèle) ; 2) s'il refuse encore : l'utilisateur choisit s'il relance avec un autre modèle (jamais à sa place).
  const refused = !nTools && cfg.mode !== 'plan' && looksLikeToolRefusal(visible);
  const stage = opts._recover || 0;
  const bare = typeof opts.bare === 'string' ? opts.bare.trim() : '';
  const retryOk = refused && cfg.refusalRecover !== false && !signal.aborted && stage === 0;
  // GPT qui refuse dès le 1er message : la MÊME demande, seule, dans une conversation neuve (testé en vrai : passe souvent)
  const bareRetry = retryOk && firstTurn && !!bare && bare !== String(userText).trim() && isOpenAiModel(S);
  // sinon une précision factuelle, même modèle — sauf GPT Astra, qu'elle ne fait jamais changer d'avis (vu en vrai)
  const clarify = retryOk && !bareRetry && !NO_CLARIFY_MODELS.has(String(S.agentId));
  const recover = bareRetry || clarify;
  if (refused && !recover) {
    saveCfgKeys({ toolRefusals: { ...(cfg.toolRefusals || {}), [String(S.agentId)]: Date.now() } });
    const other = String(S.agentId) === '-2003' ? '/model opus' : '/model sonnet';
    ui.println('\n' + c.yellow('  ⚠ Le modèle a refusé d\'utiliser les outils pour cette demande : il n\'a rien lu ni modifié.'));
    ui.println(c.dim('    Ça arrive surtout quand la demande ou le projet parle de France Student elle-même (son API, des outils externes), ou quand la conversation est très longue. Reformule, repars de zéro avec ') +
      c.accent('/new') + c.dim(', ou essaie ') + c.accent(other));
  }

  ui.liveTokens.end();
  const secs = (Date.now() - t0) / 1000;
  const bits = [ui.duration(secs)];
  if (nTools) bits.push(`${nTools} outil${nTools > 1 ? 's' : ''}`);
  bits.push(`${nReq} requête${nReq > 1 ? 's' : ''}`);
  // entrée : tokens réellement relus (mesurés) ; sinon le compte de FS, seulement pour GPT (avec Claude il ne compte que le hors-cache)
  const measured = measures.length && measures.length === nReq ? await Promise.all(measures) : [];
  const realIn = measured.length && measured.every(x => x != null) ? measured.reduce((s, x) => s + x, 0) : null;
  const kTok = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const shownIn = realIn != null ? realIn : (isOpenAiModel(S) ? tokensIn : 0);
  if (tokensOut > 0) bits.push(shownIn > 0 ? `${kTok(shownIn)}↑ ${kTok(tokensOut)}↓ tok` : `${kTok(tokensOut)}↓ tok`);
  S.tokens.in += realIn != null ? realIn : tokensIn; S.tokens.out += tokensOut;
  S.stats ||= { turns: 0, requests: 0, tools: 0 }; S.stats.turns++; S.stats.requests += nReq; S.stats.tools += nTools;   // pour /usage
  let ctxBit = '';
  if (S.chatId) {
    const [pct, budget] = await Promise.all([ctxPct(S.chatId).catch(() => null), budgetOf ? budgetOf().catch(() => null) : null]);
    S.ctxPercent = pct;
    if (budget) S.budget = budget;
    if (typeof S.ctxPercent === 'number') { const p = Math.round(S.ctxPercent); ctxBit = ' · ' + (p >= 80 ? c.red : p >= 60 ? c.yellow : c.dim)(`ctx ${p}%`); }
    if (budget) ctxBit += ' · ' + (budget.left <= 10 ? c.red : budget.left <= 25 ? c.yellow : c.dim)(`budget ${budgetText(budget.left)}`);   // limite du site qui bloque les messages
  }
  ui.println('\n' + c.dim(`  ✻ Terminé en ${bits.join(' · ')}`) + ctxBit);
  if (secs > 15 && process.stdout.isTTY) process.stdout.write('\x07');   // tâche longue finie : alerte (la barre des tâches clignote si la fenêtre n'est pas au premier plan)
  if (cfg.sound && secs > 3) process.stdout.write('\x07');
  if (hitLimit) ui.println(c.yellow(`  ⚠ limite de ${maxSteps} étapes atteinte — tape /continue pour poursuivre`));
  if (heavyAt) ui.println(c.yellow(`  ⚠ conversation très chargée (≈${Math.round(heavyAt / 1000)}k tokens par requête) : elle sera résumée avant ton prochain message.`) +
    c.dim('\n    Si la tâche n\'est pas finie, tape /continue : elle reprendra dans une conversation légère, à partir du résumé (rien n\'est perdu).'));
  if (bareRetry) {
    ui.println(c.dim('  ↻ le modèle a refusé dès le 1er message : nouvel essai dans une conversation neuve, avec ta demande seule (sans les infos ajoutées par FS-CLI)'));
    S.chatId = null; S.ctxSent = true; S.bareChat = true;              // cette conversation-là ne reçoit rien d'autre que tes messages (remis à zéro avec /new)
    return runNative(S, bare, { ...opts, bare: null, _recover: 1, _orig: bare });
  }
  if (clarify) {
    ui.println(c.dim('  ↻ le modèle a cru ne pas avoir le droit d\'utiliser les outils : FS-CLI lui précise que ce sont les outils officiels de France Student'));
    S.pendingFileIds = [];                                              // les images sont déjà dans la conversation : pas renvoyées avec la précision
    return runNative(S, CLARIFY, { ...opts, _recover: 1, _orig: userText });
  }
  // Refus définitif : JAMAIS de changement de modèle sans l'utilisateur. Menu (terminal interactif, panneau) : relancer avec quel modèle ?
  if (refused && !signal.aborted && stage < 2 && typeof opts.choose === 'function') {
    const choices = RETRY_MODELS.filter(m => m.id !== Number(S.agentId));
    const idx = await opts.choose({
      title: 'Le modèle a refusé d\'utiliser les outils pour cette demande',
      detail: 'Il n\'a rien lu ni modifié. Tu peux relancer la même demande avec un autre modèle, dans la même conversation.',
      options: [...choices.map(m => `Relancer avec ${m.name}`), 'Ne rien relancer (je change avec /model)'],
      defaultIndex: 0,
    });
    const pick = Number.isInteger(idx) ? choices[idx] : null;
    if (pick) {
      const from = S.agentId;
      S.agentId = pick.id;
      ui.println(c.dim(`  ↻ la demande repart avec ${pick.name} (ton choix ; /model pour changer de modèle)`));
      const r = await runNative(S, opts._orig || userText, { ...opts, _recover: 2 });
      return { ...r, switchedFrom: from, switchedTo: pick.id };
    }
  }
  return { hitLimit, nReq };
}

/** GPT-6 Astra (-1004) et GPT-6.2 Astra (-1006) : la précision ne les fait jamais changer d'avis (vu en vrai le 19/11/2026 :
 *  « ça ne change toutefois pas la limite ») → pas de précision ; l'utilisateur choisit s'il relance avec un autre modèle. */
export const NO_CLARIFY_MODELS = new Set(['-1004', '-1006']);
/** modèles proposés à l'utilisateur après un refus (jamais choisis à sa place) */
export const RETRY_MODELS = [{ id: -2003, name: 'Claude Sonnet 5.5' }, { id: -2001, name: 'Claude Opus 5.5' }];

/** précision envoyée UNE fois quand un modèle croit ne pas avoir le droit d'utiliser les outils (vrai, documenté par France Student) */
export const CLARIFY = 'Précision : list_directory, read_file, search_files, edit_file, write_file et run_command sont les outils client officiels de France Student ' +
  '(fonction « outils client » de la plateforme, prévue pour les IDE et les CLI) : c\'est le serveur de France Student qui te les déclare et qui transmet tes appels à mon PC, avec mon accord. ' +
  'Tu peux donc les utiliser pour faire ma demande précédente.';
