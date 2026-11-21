// Aides partagées des tests de la passerelle Claude Code (test/gateway-*.test.mjs) :
// fixtures de requêtes réelles, faux France Student injectable, mini-validateur JSON Schema, parseur SSE Anthropic strict,
// dossiers temporaires. Ce module n'importe RIEN de src/ : on peut l'importer statiquement en tête d'un fichier de test.
//
// Garde-fou : si FS_CLI_HOME n'est pas encore défini quand ce module est chargé, il pointe vers un dossier temporaire neuf.
// Les imports statiques étant évalués avant le corps du fichier de test, src/config.js ne touchera donc jamais ~/.fs-cli
// tant que src/ est importé APRÈS ce module (import dynamique ou import statique placé après).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Crée un dossier temporaire neuf et renvoie son chemin ; { env: true } en fait aussi le FS_CLI_HOME du processus. */
export function tmpHome({ prefix = 'fscli-gw-', env = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (env) process.env.FS_CLI_HOME = dir;
  return dir;
}

if (!process.env.FS_CLI_HOME) tmpHome({ env: true });

// ── Fixtures (captures nettoyées de Claude Code 2.1.207) ──────────────────────────────────────────────────────────────

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc');
const fixtureText = new Map();

/**
 * Capture de requête Claude Code : { n, method, url, headers, body }. Copie neuve à chaque appel (modifiable sans risque).
 * name : 'req-02' | 'req-03' | 'req-04' | 'req-03-linux' (extension .json facultative).
 */
export function loadFixture(name) {
  const file = path.join(FIXTURES, /\.json$/i.test(name) ? name : `${name}.json`);
  if (!fixtureText.has(file)) fixtureText.set(file, fs.readFileSync(file, 'utf8'));
  return JSON.parse(fixtureText.get(file));
}

/** input_schema d'un outil Claude Code tel qu'envoyé dans une capture (req-03 par défaut) ; null si l'outil est absent. */
export function toolSchema(name, fixture = 'req-03') {
  return loadFixture(fixture).body.tools.find(t => t.name === name)?.input_schema || null;
}

// ── Mini-validateur JSON Schema ───────────────────────────────────────────────────────────────────────────────────────

const kindOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function matchesType(v, t) {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'null') return v === null;
  return typeof v === t;                                                   // string, boolean
}

function checkNumber(v, s, at, errs) {
  if (s.minimum != null && v < s.minimum) errs.push(`${at} : ${v} < minimum ${s.minimum}`);
  if (s.maximum != null && v > s.maximum) errs.push(`${at} : ${v} > maximum ${s.maximum}`);
  if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) errs.push(`${at} : ${v} ≤ ${s.exclusiveMinimum} (exclusiveMinimum)`);
  if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) errs.push(`${at} : ${v} ≥ ${s.exclusiveMaximum} (exclusiveMaximum)`);
}

function checkString(v, s, at, errs) {
  if (s.minLength != null && v.length < s.minLength) errs.push(`${at} : longueur ${v.length} < ${s.minLength}`);
  if (s.maxLength != null && v.length > s.maxLength) errs.push(`${at} : longueur ${v.length} > ${s.maxLength}`);
  if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errs.push(`${at} : ne respecte pas le motif ${s.pattern}`);
}

function checkObject(v, s, at, errs) {
  const props = s.properties || {};
  for (const k of s.required || []) if (!Object.hasOwn(v, k) || v[k] === undefined) errs.push(`${at}.${k} : requis mais absent`);
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) { errs.push(`${at}.${k} : undefined (un champ absent doit être omis)`); continue; }
    if (Object.hasOwn(props, k)) check(x, props[k], `${at}.${k}`, errs);
    else if (s.additionalProperties === false) errs.push(`${at}.${k} : propriété non autorisée (additionalProperties:false)`);
    else check(x, typeof s.additionalProperties === 'object' ? s.additionalProperties : {}, `${at}.${k}`, errs);
  }
}

function check(v, s, at, errs) {
  if (v === undefined) return void errs.push(`${at} : undefined`);
  if (['function', 'symbol', 'bigint'].includes(typeof v)) return void errs.push(`${at} : ${typeof v} non sérialisable en JSON`);
  if (typeof v === 'number' && !Number.isFinite(v)) return void errs.push(`${at} : nombre non fini (${v})`);
  if (s === false) return void errs.push(`${at} : interdit par le schéma`);
  if (s == null || s === true) s = {};
  if (s.type) {
    const types = [].concat(s.type);
    if (!types.some(t => matchesType(v, t))) return void errs.push(`${at} : type ${kindOf(v)} au lieu de ${types.join('|')}`);
  }
  if (s.enum && !s.enum.some(e => sameJson(e, v))) errs.push(`${at} : ${JSON.stringify(v)} hors de l'enum ${JSON.stringify(s.enum)}`);
  if (Object.hasOwn(s, 'const') && !sameJson(s.const, v)) errs.push(`${at} : ${JSON.stringify(v)} ≠ const ${JSON.stringify(s.const)}`);
  if (s.anyOf && !s.anyOf.some(b => validateAgainstSchema(v, b).length === 0)) errs.push(`${at} : aucune branche anyOf ne correspond`);
  if (s.oneOf && s.oneOf.filter(b => validateAgainstSchema(v, b).length === 0).length !== 1) errs.push(`${at} : il faut exactement une branche oneOf`);
  if (typeof v === 'number') checkNumber(v, s, at, errs);
  else if (typeof v === 'string') checkString(v, s, at, errs);
  else if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) errs.push(`${at} : ${v.length} éléments < ${s.minItems}`);
    if (s.maxItems != null && v.length > s.maxItems) errs.push(`${at} : ${v.length} éléments > ${s.maxItems}`);
    for (let i = 0; i < v.length; i++) check(v[i], s.items ?? {}, `${at}[${i}]`, errs);   // un trou (tableau creux) donne undefined → erreur
  } else if (v !== null && typeof v === 'object') checkObject(v, s, at, errs);
}

/**
 * Valide `input` contre un JSON Schema (sous-ensemble utile aux input_schema de Claude Code) :
 * type (dont integer et listes de types), required, properties, additionalProperties (false ou schéma), enum, const,
 * anyOf/oneOf, minimum/maximum/exclusive*, min/maxLength, pattern, items, min/maxItems.
 * En plus du standard : toute valeur undefined (même facultative), fonction ou nombre non fini est une erreur.
 * Renvoie la liste des erreurs (tableau vide = valide).
 */
export function validateAgainstSchema(input, schema) {
  const errs = [];
  check(input, schema, 'input', errs);
  return errs;
}

// ── Parseur SSE Anthropic strict ──────────────────────────────────────────────────────────────────────────────────────

const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal']);
const TOOL_ID = /^[A-Za-z0-9_-]+$/;                                        // contrainte de Claude Code sur les ids tool_use

function splitBlocks(text, partial) {
  const src = String(text).replace(/\r\n?/g, '\n');
  const blocks = src.split('\n\n');
  const tail = blocks.pop();
  if (tail.trim() && !partial) throw new Error('SSE invalide : dernier événement non terminé par une ligne vide');
  return blocks;
}

function parseBlock(raw, n) {
  let event = null; const data = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;                    // commentaire SSE
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let val = i < 0 ? '' : line.slice(i + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') { if (event !== null) throw new Error(`SSE invalide (bloc ${n}) : deux lignes event:`); event = val; }
    else if (field === 'data') data.push(val);
    else if (field !== 'id' && field !== 'retry') throw new Error(`SSE invalide (bloc ${n}) : champ inconnu « ${field} »`);
  }
  if (event === null && !data.length) return null;
  if (event === null) throw new Error(`SSE invalide (bloc ${n}) : data sans ligne event:`);
  if (!data.length) throw new Error(`SSE invalide (bloc ${n}) : event « ${event} » sans data`);
  let d;
  try { d = JSON.parse(data.join('\n')); } catch { throw new Error(`SSE invalide (bloc ${n}, ${event}) : data n'est pas du JSON`); }
  if (d?.type !== event) throw new Error(`SSE invalide (bloc ${n}) : event « ${event} » mais data.type « ${d?.type} »`);
  return { event, data: d };
}

/** Machine à états : applique un événement à `st` (règles du SDK Anthropic, en plus strict). Lève une Error en français. */
function apply(st, { event, data }) {
  const need = (ok, msg) => { if (!ok) throw new Error(`SSE invalide (${event}) : ${msg}`); };
  need(!st.stopped, 'événement après message_stop');
  need(!st.error, 'événement après error');
  const m = st.message, blocks = m?.content;
  switch (event) {
    case 'ping': st.pings++; return;
    case 'error':
      need(data.error && typeof data.error.type === 'string' && typeof data.error.message === 'string', 'error.type et error.message attendus');
      st.error = data.error; return;
    case 'message_start': {
      need(!m, 'message_start en double');
      const x = data.message || {};
      need(x.type === 'message' && x.role === 'assistant', 'message.type « message » et role « assistant » attendus');
      need(typeof x.id === 'string' && typeof x.model === 'string', 'message.id et message.model attendus');
      need(Array.isArray(x.content) && x.content.length === 0, 'message.content doit être vide au départ');
      need(x.usage && typeof x.usage.input_tokens === 'number', 'message.usage.input_tokens attendu');
      st.message = structuredClone(x); return;
    }
    case 'content_block_start': {
      need(m, 'avant message_start');
      need(st.open === null, `bloc ${st.open} encore ouvert`);
      need(!st.delta, 'après message_delta');
      need(data.index === blocks.length, `index ${data.index} au lieu de ${blocks.length}`);
      const cb = data.content_block || {};
      if (cb.type === 'text') { need(typeof cb.text === 'string', 'content_block.text attendu'); blocks.push({ type: 'text', text: cb.text }); }
      else if (cb.type === 'tool_use') {
        need(typeof cb.id === 'string' && TOOL_ID.test(cb.id), `id tool_use invalide « ${cb.id} »`);
        need(typeof cb.name === 'string' && cb.name.length > 0, 'nom d\'outil attendu');
        need(cb.input && typeof cb.input === 'object' && !Array.isArray(cb.input) && !Object.keys(cb.input).length, 'input initial doit être {}');
        blocks.push({ type: 'tool_use', id: cb.id, name: cb.name, input: {} });
        st.json[data.index] = '';
      } else need(false, `type de bloc inattendu « ${cb.type} »`);
      st.open = data.index; return;
    }
    case 'content_block_delta': {
      need(st.open !== null && data.index === st.open, `index ${data.index} alors que le bloc ouvert est ${st.open}`);
      const b = blocks[data.index], d = data.delta || {};
      if (d.type === 'text_delta') { need(b.type === 'text' && typeof d.text === 'string', 'text_delta hors d\'un bloc text'); b.text += d.text; }
      else if (d.type === 'input_json_delta') { need(b.type === 'tool_use' && typeof d.partial_json === 'string', 'input_json_delta hors d\'un bloc tool_use'); st.json[data.index] += d.partial_json; }
      else need(false, `delta inattendu « ${d.type} »`);
      return;
    }
    case 'content_block_stop': {
      need(st.open !== null && data.index === st.open, `index ${data.index} alors que le bloc ouvert est ${st.open}`);
      const b = blocks[data.index];
      if (b.type === 'tool_use') {
        const raw = st.json[data.index];
        try { b.input = raw === '' ? {} : JSON.parse(raw); } catch { need(false, `partial_json non analysable : ${raw.slice(0, 80)}`); }
        need(b.input && typeof b.input === 'object' && !Array.isArray(b.input), 'input d\'outil non objet');
      }
      st.open = null; return;
    }
    case 'message_delta': {
      need(m && st.open === null, 'avant message_start ou bloc encore ouvert');
      need(!st.delta, 'message_delta en double');
      const d = data.delta || {};
      need(STOP_REASONS.has(d.stop_reason), `stop_reason inconnu « ${d.stop_reason} »`);
      need(d.stop_sequence == null || typeof d.stop_sequence === 'string', 'stop_sequence invalide');
      need(data.usage && typeof data.usage.output_tokens === 'number', 'usage.output_tokens attendu');
      m.stop_reason = d.stop_reason; m.stop_sequence = d.stop_sequence ?? null;
      m.usage = { ...m.usage, ...data.usage };
      st.delta = true; return;
    }
    case 'message_stop':
      need(st.delta, 'message_stop sans message_delta');
      st.stopped = true; return;
    default: need(false, 'type d\'événement inconnu');
  }
}

/**
 * Analyse un flux SSE de l'API Anthropic Messages et vérifie l'ordre exact des événements (lève une Error sinon) :
 * message_start → (content_block_start → *_delta… → content_block_stop)* → message_delta → message_stop, index
 * consécutifs depuis 0, un seul bloc ouvert, partial_json analysable, ids tool_use [A-Za-z0-9_-], stop_reason
 * cohérent (tool_use ⇔ au moins un bloc tool_use), ping et error acceptés. { partial: true } tolère un flux inachevé.
 * Renvoie { events, message, text, toolUses, pings, error }.
 */
export function parseSse(text, { partial = false } = {}) {
  const events = splitBlocks(text, partial).map(parseBlock).filter(Boolean);
  const st = { message: null, open: null, json: {}, delta: false, stopped: false, pings: 0, error: null };
  for (const e of events) apply(st, e);
  if (!partial && !st.stopped && !st.error) throw new Error('SSE invalide : flux incomplet (ni message_stop ni error)');
  const content = st.message?.content || [];
  const toolUses = content.filter(b => b.type === 'tool_use');
  if (st.stopped && (st.message.stop_reason === 'tool_use') !== (toolUses.length > 0))
    throw new Error(`SSE invalide : stop_reason « ${st.message.stop_reason} » avec ${toolUses.length} bloc(s) tool_use`);
  const textOut = content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { events, message: st.message, text: textOut, toolUses, pings: st.pings, error: st.error };
}

// ── Faux France Student ───────────────────────────────────────────────────────────────────────────────────────────────

/** Agents par défaut (forme ModelDto de GET /chats/agents). Gemini (-3001) est fictif : il sert aux tests du mode texte seul. */
export const DEFAULT_AGENTS = Object.freeze([
  { id: -2001, name: 'Claude Opus 5.5', namespace: 'anthropic', model: 'claude-opus-5-5', modelProvider: 'anthropic', isActive: true, isDefault: false, contextWindow: 200000 },
  { id: -2003, name: 'Claude Sonnet 5.5', namespace: 'anthropic', model: 'claude-sonnet-5-5', modelProvider: 'anthropic', isActive: true, isDefault: true, contextWindow: 200000 },
  { id: -2002, name: 'Claude Haiku 5.5', namespace: 'anthropic', model: 'claude-haiku-5-5', modelProvider: 'anthropic', isActive: true, isDefault: false, contextWindow: 200000 },
  { id: -2005, name: 'Claude Fable 5.2', namespace: 'anthropic', model: 'claude-fable-5-2', modelProvider: 'anthropic', isActive: true, isDefault: false, contextWindow: 200000 },
  { id: -1004, name: 'GPT-6 Astra', namespace: 'openai', model: 'gpt-6-astra', modelProvider: 'openai', isActive: true, isDefault: false, contextWindow: 400000 },
  { id: -1002, name: 'GPT-6 Luna', namespace: 'openai', model: 'gpt-6-luna', modelProvider: 'openai', isActive: true, isDefault: false, contextWindow: 400000 },
  { id: -3001, name: 'Gemini 3 Pro', namespace: 'google', model: 'gemini-3-pro', modelProvider: 'google', isActive: true, isDefault: false, contextWindow: 1000000 },
].map(a => Object.freeze(a)));

/** Horloge par défaut du faux FS : 18/11/2026 10:00 UTC. */
export const FAKE_NOW = Date.parse('2026-11-18T10:00:00.000Z');

const DEP_NAMES = ['stream', 'resume', 'fetchChat', 'searchChats', 'compactChat', 'uploadFile', 'cancelStream',
  'fetchAgentsFull', 'createdToday', 'quota', 'fsExists', 'fsStat', 'now'];

/** Promesse ouvrable à la main, pour tenir une génération « en cours » : const g = deferred(); … g.open(). */
export function deferred() {
  let open;
  const promise = new Promise(r => { open = r; });
  return { promise, open: v => open(v) };
}

/** Erreur au format de src/api.js (ApiError) : status, code, retry, accepted. */
function apiError(message, props) {
  return Object.assign(new Error(message), { name: 'ApiError', status: undefined, code: undefined, retry: false, accepted: false }, props);
}

const abortError = accepted => Object.assign(new Error('annulé'), { name: 'AbortError', accepted });

/** Construit l'erreur d'un tour raté. spec : 'daily' | 'native' | 'auth' | 'busy' | 'network' | statut HTTP | { status, body, code, message, retryable } */
export function fsError(spec, { accepted = false, resetAt = '2026-11-19T04:00:00.000Z' } = {}) {
  const named = {
    daily: () => ({ status: 429, code: 'DAILY_CHAT_LIMIT', resetAt, message: 'Limite de 50 nouvelles conversations par jour atteinte. Tu peux continuer dans une conversation existante (/history <n°> ou /resume).' }),
    native: () => ({ status: 403, code: 'NATIVE_UNSUPPORTED', message: 'Le mode « outils client » n\'est pas activé sur ce compte (403).' }),
    auth: () => ({ status: 401, message: '401 — token de session expiré (récupère un nouveau cookie next-auth.session-token)' }),
    busy: () => ({ status: 503, retry: true, message: 'HTTP 503: Service Unavailable' }),
    network: () => ({ retry: true, message: 'Réseau: socket hang up' }),
  };
  let p;
  if (typeof spec === 'string') p = named[spec]?.() || { message: spec };
  else if (typeof spec === 'number') p = spec === 401 ? named.auth() : { status: spec, retry: spec === 429 || spec >= 500, message: `HTTP ${spec}: ` };
  else {
    const st = spec.status;
    p = { retry: st === 429 || st >= 500, ...spec, message: spec.message || (st ? `HTTP ${st}: ${spec.body || ''}` : `Erreur du serveur: ${spec.body || spec.code || 'inconnue'}`) };
    delete p.body;
  }
  if (accepted) p.retry = false;                                           // après un 2xx, jamais de nouvel essai (I2)
  return apiError(p.message, { ...p, accepted });
}

const asTurn = t => typeof t === 'string' ? { text: t } : { ...t };
const chunksOf = t => t.chunks || (t.text ? t.text.match(/\S+\s*|\s+/g) : []);

/** Attend un délai (ms), une promesse ou une fonction asynchrone, en respectant le signal d'annulation. */
function waitFor(x, signal, accepted) {
  if (x == null) return;
  if (signal?.aborted) throw abortError(accepted);
  let timer = null;
  const p = typeof x === 'number' ? new Promise(r => { timer = setTimeout(r, x); })
    : typeof x === 'function' ? Promise.resolve().then(x) : Promise.resolve(x);
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError(accepted)); };   // pas de minuteur qui retient le processus
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); }, reject);
  });
}

/** Copie JSON de ce qui part vers FS : sans les rappels ni le signal. */
function sentBody(opts) {
  const o = {};
  for (const [k, v] of Object.entries(opts || {})) if (typeof v !== 'function' && k !== 'signal') o[k] = v;
  return structuredClone(o);
}

const winLike = p => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
function normPath(p) {
  const s = String(p || '');
  return winLike(s) ? s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : s.replace(/\/+$/, '') || '/';
}

const docPart = d => ({
  type: d.update ? 'tool-updateDocument' : 'tool-createDocument', state: 'output-available',
  input: { title: d.title, kind: d.kind || 'text', ...(typeof d.content === 'string' ? { content: d.content } : {}) },
  output: { id: d.id || null, title: d.title, kind: d.kind || 'text' },
});

/**
 * Faux France Student injectable (deps de la passerelle, § 5.1). Enregistre chaque appel et rejoue un scénario.
 *
 * script = {
 *   turns: [tour…]        un tour par appel deps.stream, dans l'ordre ; un tour est une chaîne (texte) ou un objet :
 *     { text, chunks?, toolCalls?, documents?, usage?, reasoning?, chatId?, userMessageId?,
 *       fail?        erreur AVANT acceptation (fsError : 'daily'|'native'|'auth'|'busy'|'network'|statut|objet) ;
 *       cut?         { after:n } ou n : coupure réseau APRÈS acceptation, après n deltas (e.accepted = true) ;
 *       sseError?    { code, message?, retryable?, after? } : événement SSE error après acceptation ;
 *       persisted?   ce que FS a enregistré après une coupure : 'assistant' (défaut si cut) | 'user' (défaut si sseError) | 'none' ;
 *       delayAccept? ms | promesse | fonction, attendu avant l'acceptation ;
 *       hold?        ms | promesse | fonction, attendu après le 1er delta (génération « en cours ») }
 *     ou une fonction (send, n, fake) → tour, pour un scénario dynamique ;
 *   default?:  tour joué quand `turns` est épuisé (sinon l'appel échoue avec code 'FAKE_EXHAUSTED') ;
 *   resumes?:  [ 'replay' | 'fail' | { fail } | fonction ] par appel deps.resume ; resume? : valeur pour tous (défaut 'replay') ;
 *   chats?:    { chatId: réponse de GET /chats/{id} } qui remplace l'état simulé ; fetchChat?: fonction(chatId) ;
 *   search?:   tableau ou fonction(query, limit) pour GET /chats/search ;
 *   compact?:  statut (ou fonction(chatId) → statut) de POST /chats/{id}/context, défaut 200 ;
 *   agents?:   liste ModelDto (défaut DEFAULT_AGENTS ; null = indisponible) ;
 *   created?:  conversations déjà créées aujourd'hui (défaut 0) ; limit? : quota (défaut 50) ; limitHit?, resetText? ;
 *   files?:    { chemin: contenu } (objet lu en direct : on peut le modifier en cours de test) ; dirs? : [chemin…] ;
 *   now?:      horloge initiale en ms (défaut FAKE_NOW)
 * }
 *
 * Renvoie fake = { ...les 13 fonctions, deps, calls, sent, registered, chats, errors, script, advance(ms), setNow(t) }.
 * fake.calls.<nom> (aussi fake.<nom>.calls) liste les appels ; fake.sent = corps envoyés par deps.stream.
 */
export function fakeFs(script = {}) {
  const calls = Object.fromEntries(DEP_NAMES.map(n => [n, []]));
  const chats = new Map();
  const errors = [];
  const limit = script.limit ?? 50;
  const state = { created: script.created ?? 0, now: script.now ?? FAKE_NOW, chatSeq: 0, msgSeq: 0, uploads: 0 };

  const chatOf = id => {
    if (!chats.has(id)) chats.set(id, { id, title: '', register: null, messages: [], events: [], seq: 0, lastTurn: null });
    return chats.get(id);
  };
  const exhausted = n => {
    const e = apiError(`fakeFs : aucun tour prévu pour l'appel stream n°${n + 1}`, { code: 'FAKE_EXHAUSTED' });
    errors.push(e);
    return e;
  };

  async function stream(opts = {}) {
    const n = calls.stream.length;
    const send = sentBody(opts);
    calls.stream.push(send);
    let t = script.turns?.[n] ?? script.default;
    if (typeof t === 'function') t = await t(send, n, fake);
    if (t == null) throw exhausted(n);
    t = asTurn(t);
    const { signal } = opts;
    await waitFor(t.delayAccept, signal, false);
    if (signal?.aborted) throw abortError(false);
    if (t.fail) throw fsError(t.fail);
    if (!opts.chatId && state.created >= limit) throw fsError('daily');
    opts.onAccepted?.();

    const isNew = !opts.chatId;
    const chatId = isNew ? (t.chatId || `chat-${++state.chatSeq}`) : opts.chatId;
    const chat = chatOf(chatId);
    if (isNew) { state.created++; chat.title = String(opts.content || '').split('\n')[0].slice(0, 80); chat.register = opts.register || null; }
    opts.onChat?.(chatId);
    const umid = t.userMessageId || `msg-${++state.msgSeq}`;
    opts.onUserMessageId?.(umid);
    if (t.reasoning) opts.onReasoning?.(t.reasoning);

    // côté serveur, la génération va jusqu'au bout même si le client est coupé : le journal d'événements est complet
    const chunks = chunksOf(t);
    const text = chunks.join('');
    const toolCalls = t.toolCalls || t.calls || [];
    const documents = t.documents || [];
    const usage = t.usage === undefined ? { promptTokenCount: 1200, candidatesTokenCount: Math.ceil(text.length / 4) } : t.usage;
    const events = chunks.map(d => ({ id: String(++chat.seq), delta: d }));
    const doneId = String(++chat.seq);
    chat.events.push(...events);
    const result = { text, usage, toolCalls, stopped: false, images: [], documents, sawImage: false, chatId };
    const broken = t.cut != null ? { kind: 'cut', after: typeof t.cut === 'number' ? t.cut : t.cut.after ?? 0 }
      : t.sseError ? { kind: 'sse', after: t.sseError.after ?? 0 } : null;
    const persisted = t.persisted || (broken?.kind === 'sse' ? 'user' : 'assistant');
    if (persisted !== 'none') chat.messages.push({ id: umid, role: 'user', content: opts.content ?? null, ...(opts.toolResults ? { toolResults: structuredClone(opts.toolResults) } : {}) });
    if (persisted === 'assistant') {
      chat.messages.push({ id: `msg-${++state.msgSeq}`, role: 'assistant', content: text, tokenUsage: usage,
        ...(toolCalls.length ? { toolCalls: structuredClone(toolCalls) } : {}), parts: documents.map(docPart) });
    }
    chat.lastTurn = { events, doneId, result, complete: persisted === 'assistant' };

    const upTo = broken ? Math.min(broken.after, events.length) : events.length;
    for (let i = 0; i < upTo; i++) {
      if (signal?.aborted) throw abortError(true);
      opts.onEventId?.(events[i].id);
      opts.onText?.(events[i].delta, () => {});
      if (i === 0) await waitFor(t.hold, signal, true);
    }
    if (upTo === 0) await waitFor(t.hold, signal, true);
    if (broken?.kind === 'cut') throw fsError('network', { accepted: true });
    if (broken) {
      const s = t.sseError;
      const e = fsError({ code: s.code, retryable: s.retryable ?? false, message: `Erreur du serveur: ${s.message || s.code}` }, { accepted: true });
      // vu en vrai : 200 puis « 409 CONFLICT » / « 400 BAD_REQUEST … pending » dans le flux ; src/api.js rend le statut, requête refusée
      if (s.status) Object.assign(e, { status: s.status, rejected: true, accepted: false, serverError: true });
      throw e;
    }
    if (signal?.aborted) throw abortError(true);
    opts.onEventId?.(doneId);
    return structuredClone(result);
  }

  async function resume(chatId, lastEventId = null, h = {}) {
    const k = calls.resume.length;
    calls.resume.push({ chatId, lastEventId });
    let r = script.resumes?.[k] ?? script.resume ?? 'replay';
    if (typeof r === 'function') r = await r(chatId, lastEventId, k, fake);
    if (r === 'fail') throw fsError('network');
    if (r && typeof r === 'object' && r.fail) throw fsError(r.fail);
    const t = chats.get(chatId)?.lastTurn;
    if (!t || !t.complete) throw fsError({ status: 404, body: 'No active stream' });
    h.onAccepted?.();
    h.onChat?.(chatId);
    const from = Number(lastEventId || 0);
    let text = '';
    for (const ev of t.events) {
      if (Number(ev.id) <= from) continue;
      h.onEventId?.(ev.id);
      h.onText?.(ev.delta, () => {});
      text += ev.delta;
    }
    h.onEventId?.(t.doneId);
    return { ...structuredClone(t.result), text };                          // text = seulement ce qui a été rejoué
  }

  async function fetchChat(chatId) {
    calls.fetchChat.push({ chatId });
    if (script.fetchChat) return script.fetchChat(chatId, fake);
    if (script.chats && Object.hasOwn(script.chats, chatId)) return structuredClone(script.chats[chatId]);
    const c = chats.get(chatId);
    return c ? { id: c.id, title: c.title, chatMessages: structuredClone(c.messages) } : null;
  }

  async function searchChats(query, lim = 10) {
    calls.searchChats.push({ query, limit: lim });
    if (typeof script.search === 'function') return script.search(query, lim, fake);
    if (Array.isArray(script.search)) return structuredClone(script.search).slice(0, lim);
    return [...chats.values()].filter(c => c.title.includes(query)).slice(0, lim).map(c => ({ id: c.id, title: c.title }));
  }

  async function compactChat(chatId) {
    calls.compactChat.push({ chatId });
    const s = typeof script.compact === 'function' ? script.compact(chatId) : script.compact;
    return { status: s ?? 200 };
  }

  async function uploadFile(buffer, filename, mime = 'application/octet-stream') {
    calls.uploadFile.push({ filename, mime, size: buffer?.length ?? 0 });
    if (script.uploadFail) throw fsError(script.uploadFail);
    return `file-${++state.uploads}`;
  }

  async function cancelStream(chatId) {
    calls.cancelStream.push({ chatId });
    return !!chatId;
  }

  async function fetchAgentsFull() {
    calls.fetchAgentsFull.push({});
    const a = script.agents === undefined ? DEFAULT_AGENTS : script.agents;
    return a == null ? a : structuredClone(a);
  }

  function createdToday() {
    calls.createdToday.push({});
    return state.created;
  }

  function quota() {
    calls.quota.push({});
    const reset = new Date(lastResetOf(state.now) + 86400000);
    return {
      created: state.created,
      limitHit: script.limitHit ?? state.created >= limit,
      remaining: Math.max(0, limit - state.created),
      resetText: script.resetText ?? reset.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
    };
  }

  function kindAt(p) {
    const k = normPath(p);
    const files = script.files || {};
    for (const f of Object.keys(files)) if (normPath(f) === k) return { file: true, size: Buffer.byteLength(String(files[f])) };
    const sep = winLike(k) ? '\\' : '/';
    const pre = k.endsWith(sep) ? k : k + sep;
    if ((script.dirs || []).some(d => normPath(d) === k) || Object.keys(files).some(f => normPath(f).startsWith(pre))) return { file: false, size: 0 };
    return null;
  }

  function fsExists(p) {
    calls.fsExists.push({ path: p });
    return kindAt(p) !== null;
  }

  function fsStat(p) {
    calls.fsStat.push({ path: p });
    const k = kindAt(p);
    return k && { isDirectory: () => !k.file, isFile: () => k.file, size: k.size };
  }

  function now() {
    calls.now.push({});
    return state.now;
  }

  const fns = { stream, resume, fetchChat, searchChats, compactChat, uploadFile, cancelStream, fetchAgentsFull, createdToday, quota, fsExists, fsStat, now };
  for (const n of DEP_NAMES) fns[n].calls = calls[n];
  const fake = {
    ...fns,
    deps: { ...fns },
    calls, chats, errors, script,
    get sent() { return calls.stream; },
    get registered() { return calls.stream.filter(s => s.register); },
    get created() { return state.created; },
    advance(ms) { state.now += ms; return state.now; },
    setNow(t) { state.now = t; return t; },
  };
  return fake;
}

/** 04:00 UTC le jour même ou la veille (même règle que src/chats.js lastReset, recopiée pour ne rien importer de src/). */
function lastResetOf(now) {
  const d = new Date(now);
  const r = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 4, 0, 0, 0);
  return r <= now ? r : r - 86400000;
}
