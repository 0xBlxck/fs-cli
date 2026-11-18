// Passerelle Claude Code : forme canonique de la conversation, empreintes et delta (spécification § 3.3).
// Le delta est ancré sur LA DERNIÈRE RÉPONSE ÉMISE par la passerelle (conv.lastFp) : il résiste au micro-compactage
// (tool_result vidés), au cache_control qui se déplace, aux messages role:"system" insérés et à la compaction partielle.
import { createHash } from 'node:crypto';

/** @typedef {import('./types.js').UserTurn} UserTurn */
/** @typedef {import('./types.js').AssistantTurn} AssistantTurn */
/** @typedef {import('./types.js').Conv} Conv */
/** @typedef {import('./types.js').Delta} Delta */

// Nettoyage des messages user : celui de context.js (lot B) s'il est là, sinon un repli minimal (ci-dessous).
// Seule l'absence du module est tolérée : une erreur DANS context.js doit rester visible.
let contextClean = null;
try {
  contextClean = (await import('./context.js')).cleanUserContent || null;
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !/context\.js/.test(String(e.message))) throw e;
}

const sha1 = s => createHash('sha1').update(s, 'utf8').digest('hex');

/** texte normalisé pour comparer : NFC, CRLF → LF, blancs regroupés, trim */
export function norm(s) {
  return String(s ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/** dernier index i tel que pred(arr[i]) ; -1 sinon */
export function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

// ── Repli de nettoyage (si context.js est absent) ─────────────────────────────────────────────────────────────────────

const CONTINUATION = 'This session is being continued from a previous conversation that ran out of context.';
const CONTINUE_PARA = /Continue the conversation from where it left off[^\n]*/g;
const CONTINUE_FR = 'Continue la tâche en cours là où tu t\'es arrêté, sans poser de question.';
const MARKER = /\[fs-gw:([A-Za-z0-9_-]{6,40})\]/;
const INTERRUPTED = /\[Request interrupted by user(?: for tool use)?\]/g;

/** texte après le dernier paragraphe « Continue the conversation… » d'un résumé de compaction ('' s'il n'y en a pas) */
function afterSummary(t) {
  let end = -1;
  for (const m of t.matchAll(CONTINUE_PARA)) end = m.index + m[0].length;
  if (end < 0) return '';
  return t.slice(end).trim() || CONTINUE_FR;
}

/**
 * Nettoyage minimal d'un contenu user (forme de context.cleanUserContent) : system-reminders et balises de commande
 * retirés (le contenu de <command-args> est gardé), interruptions, compaction et marqueur [fs-gw:…], images.
 * Pas de notes ni de CLAUDE.md : c'est le travail de context.js.
 */
export function basicClean(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const out = { text: '', images: [], notes: [], interrupted: false, marker: null, isContinuation: false, claudeMd: null };
  const texts = [];
  for (const b of blocks) {
    if (b?.type === 'image' && b.source?.type === 'base64') { out.images.push({ media_type: b.source.media_type, data: b.source.data }); continue; }
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    let t = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
    t = t.replace(/<command-args>([\s\S]*?)<\/command-args>/g, '$1')
      .replace(/<(command-name|command-message|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, '');
    if (t.includes('[Request interrupted by user')) { out.interrupted = true; t = t.replace(INTERRUPTED, ''); }
    if (t.trimStart().startsWith(CONTINUATION)) {
      out.isContinuation = true;
      out.marker = out.marker || t.match(MARKER)?.[1] || null;
      t = afterSummary(t);
    }
    if (t.trim()) texts.push(t.trim());
  }
  out.text = texts.join('\n\n');
  return out;
}

// ── Forme canonique ───────────────────────────────────────────────────────────────────────────────────────────────────

const blocksOf = content => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

/** message user → UserTurn (tool_result à part, le reste passe par le nettoyeur) */
function userTurn(content, clean) {
  const blocks = blocksOf(content);
  const results = blocks.filter(b => b?.type === 'tool_result')
    .map(b => ({ id: String(b.tool_use_id ?? ''), content: b.content ?? '', is_error: b.is_error === true }));
  const rest = blocks.filter(b => b?.type !== 'tool_result');
  const c = rest.length ? clean(rest) : basicClean([]);
  return {
    role: 'user', text: c.text || '', results, images: c.images || [], notes: c.notes || [],
    interrupted: !!c.interrupted, marker: c.marker || null, isContinuation: !!c.isContinuation, claudeMd: c.claudeMd || null,
  };
}

/** message assistant → AssistantTurn (texte + tool_use ; thinking et blocs serveur ignorés) */
function assistantTurn(content) {
  const blocks = blocksOf(content);
  const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  const toolUses = blocks.filter(b => b?.type === 'tool_use')
    .map(b => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input && typeof b.input === 'object' ? b.input : {} }));
  return { role: 'assistant', text, toolUses };
}

/** fusionne deux tours consécutifs du même rôle (l'API Anthropic les traite comme un seul message) */
function merge(a, b) {
  if (a.role === 'assistant') return { ...a, text: [a.text, b.text].filter(Boolean).join('\n'), toolUses: [...a.toolUses, ...b.toolUses] };
  return {
    ...a,
    text: [a.text, b.text].filter(Boolean).join('\n\n'),
    results: [...a.results, ...b.results], images: [...a.images, ...b.images], notes: [...a.notes, ...b.notes],
    interrupted: a.interrupted || b.interrupted, marker: a.marker || b.marker,
    isContinuation: a.isContinuation || b.isContinuation, claudeMd: a.claudeMd || b.claudeMd,
  };
}

/**
 * messages de Claude Code → tours canoniques. Les messages role:"system" (rappels insérés en cours de conversation)
 * sont ignorés ; les messages consécutifs du même rôle sont fusionnés.
 * @param {object[]} messages body.messages
 * @param {{clean?:(content:any)=>object}} [opts] nettoyeur des messages user (défaut : context.cleanUserContent, sinon basicClean)
 * @returns {(UserTurn|AssistantTurn)[]}
 */
export function canonicalize(messages, { clean = contextClean || basicClean } = {}) {
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const t = m.role === 'user' ? userTurn(m.content, clean) : assistantTurn(m.content);
    const prev = turns.at(-1);
    if (prev && prev.role === t.role) turns[turns.length - 1] = merge(prev, t);
    else turns.push(t);
  }
  return turns;
}

// ── Empreintes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** empreinte d'une réponse assistant : 'A:' + ids des tool_use, sinon 'T:' + sha1(texte normalisé) sur 16 caractères */
export function fpAssistant(turn) {
  const uses = turn?.toolUses || [];
  return uses.length ? 'A:' + uses.map(t => t.id).join(',') : 'T:' + sha1(norm(turn?.text)).slice(0, 16);
}

/**
 * Clé d'une requête (I5 : même clé ⇒ une seule génération FS) : modèle + empreinte du dernier assistant + ids des
 * tool_result et texte normalisé des messages user qui le suivent (+ empreinte des images). Insensible aux contenus
 * de tool_result (micro-compactage), au cache_control et aux messages système.
 */
export function requestKey(turns, model = '') {
  const ia = findLastIndex(turns, t => t.role === 'assistant');
  const after = turns.slice(ia + 1).filter(t => t.role === 'user');
  const parts = [
    String(model || ''),
    ia >= 0 ? fpAssistant(turns[ia]) : '-',
    after.flatMap(u => u.results.map(r => r.id)).join(','),
    norm(after.map(u => u.text).join('\n')),
    after.flatMap(u => u.images.map(i => sha1(String(i.data ?? '')).slice(0, 12))).join(','),
  ];
  return sha1(parts.join('\n'));
}

// ── Delta ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** la réponse a est-elle la dernière émise (même empreinte, ou texte partiel d'une réponse interrompue par Échap) ? */
function isLastEmitted(conv, a) {
  if (fpAssistant(a) === conv.lastFp) return true;
  const t = norm(a.text);
  if (a.toolUses.length || !t) return false;
  const partial = conv.undelivered?.partial;
  return (!!partial && norm(partial).startsWith(t)) || (!!conv.lastText && norm(conv.lastText).startsWith(t));
}

/**
 * Tours user qui suivent une réponse jamais reçue par Claude Code (Échap, client parti) : FS a déjà le texte de la
 * demande de ce tour-là, qui reste en tête du message suivant (Claude Code fusionne demande, interruption et nouveau
 * message). On le retire pour ne pas l'envoyer deux fois.
 */
function dropResent(userTurns, sent) {
  const s = String(sent || '').trim();
  const [first, ...rest] = userTurns;
  if (!s || !first?.text) return userTurns;
  let text = null;
  if (first.text.startsWith(s)) text = first.text.slice(s.length).trim();
  else if (norm(first.text) === norm(s)) text = '';
  return text === null ? userTurns : [{ ...first, text }, ...rest];
}

/** Réponse en cache rejouable : seulement la DERNIÈRE émise (sinon, après un retour en arrière, on resservirait une réponse périmée). */
function replayable(conv, key) {
  const hit = conv?.lastReplies?.at(-1);
  return !!hit && hit.key === key && (hit.fp === undefined || hit.fp === conv.lastFp);
}

/**
 * Ce qu'il faut envoyer à France Student pour cette requête (§ 3.3). Le delta porte aussi `key` (requestKey).
 * @param {Conv|null} conv conversation retrouvée (null si aucune)
 * @param {(UserTurn|AssistantTurn)[]} turns canonicalize(body.messages)
 * @param {string} [model] body.model (entre dans requestKey)
 * @returns {Delta & {key:string}}
 */
export function computeDelta(conv, turns, model = '') {
  const key = requestKey(turns, model);
  const d = (kind, userTurns = [], extra = {}) => ({ kind, userTurns, ...extra, key });
  if (conv?.fs?.inflightKey && conv.fs.inflightKey === key) return d('join');
  if (replayable(conv, key)) return d('replay');
  const ia = findLastIndex(turns, t => t.role === 'assistant');
  const after = turns.slice(ia + 1).filter(t => t.role === 'user');
  const first = turns.find(t => t.role === 'user');
  const und = conv?.undelivered || null;                    // dernière réponse jamais reçue par Claude Code
  if (ia < 0) {
    if (first?.isContinuation) return d('post_compact', after);
    if (!conv?.chatId) return d('new', after);
    // 1re réponse interrompue (Échap) ou jamais reçue : le chat continue, sans renvoyer la 1re demande
    if (und && und.fp == null) return d('append', dropResent(after, und.text));
    // chat ouvert mais rien encore émis (1re réponse perdue) : rien à annuler, le texte suit dans le même chat
    if (!conv.lastFp && !conv.anchors?.length) return d('append', after);
    return d('rewind', after, { anchorIndex: -1 });
  }
  const a = turns[ia];
  const cont = first?.isContinuation ? 'post_compact' : 'append';
  // Claude Code s'est arrêté à la réponse d'avant celle qu'il n'a jamais reçue : ce n'est pas un retour en arrière
  if (und && fpAssistant(a) === und.fp) return d(cont, dropResent(after, und.text));
  if (conv && isLastEmitted(conv, a)) return d(cont, after);
  if (!conv) return d('unknown', after);
  // réponse plus ancienne de la passerelle : retour en arrière (Échap Échap, /rewind, message modifié)
  const fp = fpAssistant(a);
  const j = (conv.anchors || []).findIndex(([f]) => f === fp);
  if (j >= 0) return d('rewind', after, { anchorIndex: j });
  // réponse(s) écrite(s) hors passerelle après notre dernière réponse : on continue, avec leur texte en note
  const prev = conv.lastFp ? findLastIndex(turns.slice(0, ia), t => t.role === 'assistant' && fpAssistant(t) === conv.lastFp) : -1;
  if (prev >= 0) {
    const rest = turns.slice(prev + 1);
    const foreign = rest.filter(t => t.role === 'assistant').map(t => t.text).filter(Boolean).join('\n\n');
    return d('append', rest.filter(t => t.role === 'user'), { foreignAssistantText: foreign });
  }
  return d('unknown', after);
}
