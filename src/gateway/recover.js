// Passerelle Claude Code : refus GPT, récapitulatif d'une conversation, quota de 50 nouvelles conversations par jour,
// et lecture des erreurs de France Student (spécification § 3.12). Fonctions pures ou presque : fsturn.js décide quoi faire.
import fs from 'node:fs';
import { looksLikeToolRefusal, CLARIFY } from '../native.js';
import { isBrokenHistory, isLockedChat } from '../api.js';
import { createdToday, lastReset, localTime, DAILY_LIMIT } from '../chats.js';
import { cfg, FILES } from '../config.js';

export { CLARIFY };

const DAY = 86400000;

// ── Textes visibles (repris tels quels par fsturn.js et index.js) ──
export const MESSAGES = Object.freeze({
  borrow: '(Limite de 50 nouvelles conversations atteinte : je continue dans une conversation existante.)',
  newTask: '[Nouvelle tâche, sans rapport avec ce qui précède.]',
  busy: 'France Student est occupé, nouvel essai…',
  expired: 'Session France Student expirée : lance « fs-cli --login » dans un autre terminal, puis renvoie ton message.',
  nativeOff: '(Ce modèle ne peut pas agir sur tes fichiers avec France Student : réponse en texte seul. Choisis un modèle Claude ou GPT avec /model.)',
  chatGone: '(La conversation France Student n\'est plus disponible : reprise dans une nouvelle conversation.)',
  contentPolicy: '(France Student a bloqué cette demande : filtre de contenu.)',
  accountDisabled: 'Compte France Student désactivé : la passerelle ne peut plus rien envoyer. Vérifie ton compte sur le site de France Student.',
  giveUp: '(Le modèle a refusé d\'utiliser les outils. Reformule, ou change de modèle avec /model.)',
  continueCut: 'Continue : ta réponse précédente a été coupée par une coupure réseau.',
  lost: '\n\n[FS-CLI] Connexion à France Student perdue. Renvoie ton message pour reprendre.',
  serverError: '\n\n[FS-CLI] Réponse interrompue par une erreur de France Student. Renvoie ton message pour réessayer.',
});

/** « (GPT a refusé d'utiliser les outils : la demande est passée à Claude Sonnet 5.5.) » */
export const switchNote = name => `(GPT a refusé d'utiliser les outils : la demande est passée à ${name || 'Claude Sonnet 5.5'}.)`;

/** 400 du quota quand rien n'est empruntable. */
export const limitMessage = resetText =>
  `Limite de 50 nouvelles conversations France Student atteinte (remise à zéro ${resetText || 'demain'}). Reprends une session existante avec claude --continue.`;

// ── Refus GPT ──

/** Réponse d'un modèle qui croit ne pas avoir le droit d'utiliser les outils (mêmes motifs que le moteur natif de FS-CLI). */
export const isRefusal = text => looksLikeToolRefusal(text);

/**
 * Étape suivante après un refus (comme native.js) :
 * - 0 : 'bare' (1er tour, quota suffisant : la demande seule dans un chat neuf) sinon 'clarify' (précision CLARIFY dans le même chat) ;
 * - 1 : 'switch' (même chat, Claude Sonnet, ou Opus si on était déjà sur Sonnet) ;
 * - ensuite, ou modèle non GPT, ou récupération désactivée (/config refusalRecover) : 'give_up'.
 * L'appelant fait avancer conv.refusal.stage.
 */
export function nextRefusalStep(conv, agent, quota, { enabled = cfg.refusalRecover !== false } = {}) {
  if (!enabled || agent?.provider !== 'openai') return 'give_up';
  const stage = Number(conv?.refusal?.stage) || 0;
  if (stage === 0) {
    const roomy = !quota?.limitHit && (Number(quota?.remaining) || 0) > 5;
    return (Number(conv?.turn) || 0) === 0 && !conv?.bare && roomy ? 'bare' : 'clarify';
  }
  return stage === 1 ? 'switch' : 'give_up';
}

/** Agent de l'étape « switch » : Claude Sonnet 5.5, ou Claude Opus 5.5 si le modèle était déjà Sonnet. */
export const switchAgentId = agentId => (Number(agentId) === -2003 ? -2001 : -2003);

// ── Récapitulatif (nouveau chat après un retour en arrière, un chat perdu ou un assistant inconnu) ──

const one = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const quoted = (s, n = 80) => `« ${one(s, n)} »`;

/** Action Claude Code → description avec le vocabulaire des outils France Student (jamais les noms d'outils de Claude Code). */
function describeUse(u) {
  const i = u?.input || {};
  switch (u?.name) {
    case 'Read': return `read_file ${i.file_path || ''}`.trim();
    case 'Edit': case 'MultiEdit': return `edit_file ${i.file_path || ''}`.trim();
    case 'Write': return `write_file ${i.file_path || ''}`.trim();
    case 'NotebookEdit': return `edit_file ${i.notebook_path || ''}`.trim();
    case 'Bash': case 'PowerShell': return `run_command ${quoted(i.command)}`;
    case 'Grep': return `search_files ${quoted(i.pattern, 60)}${i.path ? ' dans ' + i.path : ''}`;
    case 'Glob': return `list_directory ${i.path || '.'} (${one(i.pattern, 40)})`;
    default: return 'autre action';
  }
}

/** Ids des tool_use dont le résultat est une erreur (is_error) dans les messages utilisateur. */
function failedIds(turns) {
  const ko = new Set();
  for (const t of turns) if (t?.role === 'user') for (const r of t.results || []) if (r?.is_error) ko.add(r.id);
  return ko;
}

function turnBlock(t, ko) {
  if (t?.role === 'user') {
    const text = one(t.text, 600);
    return text ? `Utilisateur : ${text}` : '';
  }
  if (t?.role !== 'assistant') return '';
  const lines = [];
  const text = one(t.text, 600);
  if (text) lines.push(`Toi : ${text}`);
  for (const u of t.toolUses || []) lines.push(`  → ${describeUse(u)}${ko.has(u.id) ? ' (échec)' : ''}`);
  return lines.join('\n');
}

/**
 * Récapitulatif texte d'une transcription canonique (UserTurn | AssistantTurn), ≤ maxChars caractères.
 * La première demande est toujours gardée ; ensuite les échanges les plus récents, le milieu est omis si besoin.
 */
export function recapOf(turns, maxChars = 12000) {
  const list = Array.isArray(turns) ? turns : [];
  const ko = failedIds(list);
  const blocks = list.map(t => turnBlock(t, ko)).filter(Boolean);
  const head = 'Récapitulatif de notre conversation précédente (reprise dans une nouvelle conversation) :';
  const tail = '(Fin du récapitulatif. Les fichiers sont dans l\'état laissé par ces actions : relis-les avant de les modifier.)';
  if (!blocks.length) return '';
  let budget = maxChars - head.length - tail.length - 4;
  const first = blocks[0].slice(0, Math.max(0, Math.min(1000, budget)));
  budget -= first.length + 1;
  const kept = [];
  for (let i = blocks.length - 1; i >= 1; i--) {
    if (blocks[i].length + 1 > budget) break;
    kept.unshift(blocks[i]);
    budget -= blocks[i].length + 1;
  }
  const skipped = blocks.length - 1 - kept.length;
  const body = [first, ...(skipped ? [`[… ${skipped} échange(s) plus ancien(s) omis …]`] : []), ...kept];
  return [head, ...body, tail].join('\n').slice(0, maxChars);
}

// ── Quota ──

/** dailyLimitHitAt le plus récent : celui de ce processus ou celui écrit sur disque par un autre FS-CLI. */
function limitHitAt(file = FILES.cfg) {
  let at = Number(cfg.dailyLimitHitAt) || 0;
  try { at = Math.max(at, Number(JSON.parse(fs.readFileSync(file, 'utf8')).dailyLimitHitAt) || 0); } catch {}
  return at;
}

/**
 * État du quota de nouvelles conversations : { created, limitHit, remaining, resetText }.
 * deps : { createdToday?, now?, cfgFile? } (défauts : registre local des conversations, Date.now, config de FS-CLI).
 * resetText = heure locale de la prochaine remise à zéro (04:00 UTC), juste en hiver comme en été.
 */
export function quotaState(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const created = Number(typeof deps.createdToday === 'function' ? deps.createdToday() : createdToday(now)) || 0;
  const since = lastReset(now);
  return {
    created,
    limitHit: limitHitAt(deps.cfgFile) >= since,
    remaining: Math.max(0, DAILY_LIMIT - created),
    resetText: localTime(new Date(since + DAY).toISOString()),
  };
}

// ── Erreurs de France Student ──

const REATTACH_CODES = new Set(['STREAM_LEASE_LOST', 'STREAM_RELAY_UNAVAILABLE', 'GENERATION_INTERRUPTED', 'BACKEND_TIMEOUT']);
const GONE_CODES = new Set(['CHAT_DELETED', 'CHAT_ARCHIVED', 'CHAT_NOT_FOUND']);

/**
 * Sorte d'une erreur de deps.stream / deps.resume (tableau du § 3.12). On lit les champs (status, code, retryable,
 * message), jamais la classe : les erreurs du faux FS ne sont pas des ApiError.
 * → 'daily' | 'auth' | 'native' | 'reconcile' | 'gone' | 'locked' | 'broken' | 'policy' | 'disabled'
 *   | 'reattach' | 'retry_continue' | 'stream_failed' | 'busy' | 'aborted' | 'other'
 */
export function errorKind(e) {
  if (!e) return 'other';
  if (e.name === 'AbortError') return 'aborted';
  const status = Number(e.status) || 0, code = String(e.code || ''), msg = String(e.message || '');
  if (code === 'DAILY_CHAT_LIMIT' || (status === 429 && /daily new chat limit|limite de 50/i.test(msg))) return 'daily';
  if (status === 401 || /^401\b/.test(msg)) return 'auth';
  if (code === 'NATIVE_UNSUPPORTED' || /client tools are not supported/i.test(msg)) return 'native';
  if (e.accountDisabled || /account_disabled|ACCOUNT_DISABLED/.test(code + ' ' + msg)) return 'disabled';
  if (code === 'CONTENT_POLICY_VIOLATION') return 'policy';
  if (e.chatFlagged || isLockedChat(e)) return 'locked';
  if (GONE_CODES.has(code) || (status === 404 && /chat not found/i.test(msg))) return 'gone';
  if (isBrokenHistory(e)) return 'broken';
  if (status === 409 || (status === 400 && /\b(?:missing|unknown):|pending/i.test(msg))) return 'reconcile';
  if (REATTACH_CODES.has(code)) return 'reattach';
  if (/^UPSTREAM_/.test(code) || code === 'STREAM_FAILED') return e.retryable ? 'retry_continue' : 'stream_failed';
  if (status === 429 || status >= 500 || (!status && (e.retry || /^Réseau|socket|ECONN|ETIMEDOUT|Délai dépassé/i.test(msg)))) return 'busy';
  return 'other';
}

/**
 * Réponse HTTP Anthropic pour une erreur survenue AVANT les en-têtes (jamais 401 ni 429 : Claude Code réessaierait mal).
 * → { status, type, message, headers } ; null si l'erreur se traite sans répondre (reconcile, native, gone… : l'appelant renvoie).
 */
export function httpErrorFor(kind, quota = null, e = null) {
  switch (kind) {
    case 'daily': return { status: 400, type: 'invalid_request_error', message: limitMessage(quota?.resetText), headers: {} };
    case 'auth': return { status: 400, type: 'invalid_request_error', message: MESSAGES.expired, headers: {} };
    case 'disabled': return { status: 400, type: 'invalid_request_error', message: MESSAGES.accountDisabled, headers: {} };
    case 'busy': return { status: 529, type: 'overloaded_error', message: MESSAGES.busy, headers: { 'retry-after': '5' } };
    case 'other': return { status: 400, type: 'invalid_request_error', message: `France Student a refusé la demande : ${one(e?.message || 'erreur inconnue', 300)}`, headers: {} };
    default: return null;
  }
}
