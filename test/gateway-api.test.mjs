// Lot A de la passerelle Claude Code : src/api.js (once rétrocompatible, resumeStream, searchChats, compactChat, fetchAgentsFull,
// parseSseBlock, createSseReader) et src/agents-table.js. 100 % hors ligne : https.request est détourné vers un petit serveur
// HTTP local (127.0.0.1, port libre) qui joue France Student ; https.get lève une exception (aucun appel réseau possible).
import { tmpHome } from './gateway-helpers.mjs';                  // pose FS_CLI_HOME sur un dossier temporaire AVANT tout import de src/
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

if (!process.env.FS_CLI_HOME) tmpHome({ env: true });
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Faux France Student local ─────────────────────────────────────────────────────────────────────────────────────────

const seen = [];                                                       // requêtes reçues : { method, url, headers, body }
let route = (req, res) => { res.writeHead(404); res.end('{}'); };
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const r = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    seen.push(r);
    route(req, res, r);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
mock.method(https, 'request', (opts, cb) => http.request({ ...opts, hostname: '127.0.0.1', port: PORT }, cb));
mock.method(https, 'get', () => { throw new Error('appel réseau externe interdit dans ce test'); });

const config = await import('../src/config.js');
const api = await import('../src/api.js');
const { FALLBACK_AGENTS, FAMILY_AGENT } = await import('../src/agents-table.js');
config.setToken('jeton-de-test');                                      // jamais le vrai jeton, même vers 127.0.0.1
api.setProjectOverride(false);                                         // pas de rangement automatique dans un projet du site

after(() => { mock.restoreAll(); server.closeAllConnections?.(); server.close(); });

const reset = () => { seen.length = 0; };
const posts = () => seen.filter(r => r.method === 'POST' && /^\/chats\/(stream|[^/]+)$/.test(r.url));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(10)) if (cond()) return true;
  return false;
}

/** bloc SSE au format France Student : id, event, data (type = event) */
const ev = (id, type, data = {}) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
/** flux complet d'un tour : stream.open, response.created, deltas, completed */
function turnEvents({ chat = 'chat-A', umid = 'um-1', deltas = ['Bon', 'jour'], message = {} } = {}) {
  let n = 0;
  return [
    ev(++n, 'stream.open', { chat_id: chat, first_response_timeout_ms: 300000 }),
    ev(++n, 'response.created', { chat_id: chat, user_message_id: umid, chat: { id: chat } }),
    ...deltas.map(d => ev(++n, 'response.output_text.delta', { item_id: 'm', output_index: 0, content_index: 0, delta: d })),
    ev(++n, 'completed', { chat_id: chat, message: { id: 'a-1', chatId: chat, role: 'assistant', content: deltas.join(''), ...message } }),
  ];
}
let openRes = null;                                                    // dernière réponse gardée ouverte (hold) : le test peut la couper
/** répond 200 en SSE ; hold : n'envoie que n blocs et garde le flux ouvert (génération « en cours ») */
function sse(res, blocks, { hold = null } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const b of blocks.slice(0, hold ?? blocks.length)) res.write(b);
  if (hold == null) res.end(); else openRes = res;
}
/** coupure réseau brutale du flux ouvert, une fois que le client a bien reçu ce qui précède */
const cutOpen = () => setImmediate(() => openRes?.socket?.destroy());
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

/** journal des rappels d'un tour */
function recorder(extra = {}) {
  const log = [];
  const h = {
    onAccepted: () => log.push(['accepted']),
    onChat: id => log.push(['chat', id]),
    onUserMessageId: id => log.push(['umid', id]),
    onEventId: id => log.push(['id', id]),
    onText: d => log.push(['text', d]),
    ...extra,
  };
  return { log, h };
}

// ── agents-table.js ───────────────────────────────────────────────────────────────────────────────────────────────────

test('agents-table : FALLBACK_AGENTS et FAMILY_AGENT figés, valeurs attendues', () => {
  assert.ok(Object.isFrozen(FALLBACK_AGENTS) && Object.isFrozen(FAMILY_AGENT));
  assert.deepEqual(FALLBACK_AGENTS, {
    '-1002': 'GPT-6 Luna', '-1003': 'GPT-6.1 Sol', '-1004': 'GPT-6 Astra',
    '-2001': 'Claude Opus 5.5', '-2002': 'Claude Haiku 5.5', '-2003': 'Claude Sonnet 5.5', '-2005': 'Claude Fable 5.2',
  });
  assert.deepEqual(FAMILY_AGENT, { opus: -2001, sonnet: -2003, haiku: -2002, fable: -2005, gpt: -1004 });
  for (const id of Object.values(FAMILY_AGENT)) assert.ok(FALLBACK_AGENTS[String(id)], `famille → agent connu ${id}`);
});

test('agents-table : cli.js et mcp-server.js importent la table (plus de copie), mcp-server utilise fetchAgentsFull de api.js', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
  for (const [name, src] of [['cli.js', cli], ['mcp-server.js', mcp]]) {
    assert.match(src, /import \{ FALLBACK_AGENTS \} from '\.\/(src\/)?agents-table\.js'/, name);
    assert.doesNotMatch(src, /'-1002': 'GPT-6 Luna'/, `${name} : plus de copie locale`);
  }
  assert.match(cli, /let AGENTS = \{ \.\.\.FALLBACK_AGENTS \};/, 'copie modifiable (la table est figée)');
  assert.match(mcp, /import \{[^}]*\bfetchAgentsFull\b[^}]*\} from '\.\/api\.js'/);
  assert.doesNotMatch(mcp, /requestJson\('GET', '\/chats\/agents'\)/);
});

// ── parseSseBlock ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('parseSseBlock : id, event, data ; commentaires ignorés ; une seule espace retirée ; data multiligne ; CRLF', () => {
  assert.deepEqual(api.parseSseBlock('id: 7\nevent: completed\ndata: {"a":1}'), { id: '7', event: 'completed', data: '{"a":1}' });
  assert.deepEqual(api.parseSseBlock(': keepalive'), { id: null, event: '', data: null });
  assert.deepEqual(api.parseSseBlock('id:3\r\nevent:x\r\ndata:{}\r'), { id: '3', event: 'x', data: '{}' });
  assert.deepEqual(api.parseSseBlock('data: a\ndata:  b\n: commentaire\ndata'), { id: null, event: '', data: 'a\n b\n' });
  assert.equal(api.parseSseBlock('id: 1\0\ndata: {}').id, null, 'id avec NUL ignoré (règle SSE)');
  assert.deepEqual(api.parseSseBlock(''), { id: null, event: '', data: null });
  assert.deepEqual(api.parseSseBlock(undefined), { id: null, event: '', data: null });
});

// ── createSseReader (pur) ─────────────────────────────────────────────────────────────────────────────────────────────

const OPENAPI_EXAMPLE = [
  'id: 1\nevent: stream.open\ndata: {"type":"stream.open","chat_id":"c1","first_response_timeout_ms":300000}\n\n',
  'id: 2\nevent: response.created\ndata: {"type":"response.created","chat_id":"c1","user_message_id":"u1","chat":{"id":"c1"}}\n\n',
  'id: 3\nevent: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"ws_1"}}\n\n',
  'id: 4\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Bonjour"}\n\n',
  ': keepalive\n\n',
  'id: 5\nevent: chat.title\ndata: {"type":"chat.title","chat_id":"c1","title":"Salutations"}\n\n',
  'id: 6\nevent: completed\ndata: {"type":"completed","chat_id":"c1","message":{"id":"m3","role":"assistant","content":"Bonjour","tokenUsage":{"promptTokenCount":10}}}\n',
].join('');

function readAll(text, chunker, h = {}, opts) {
  const r = api.createSseReader(h, opts);
  for (const c of chunker(text)) r.push(c);
  r.end();
  return r;
}
const whole = t => [t];
const bytes = t => [...t];
const crlf = t => [t.replace(/\n/g, '\r\n')].flatMap(x => x.match(/[\s\S]{1,7}/g));   // CRLF coupé n'importe où (\r et \n séparés)

test('createSseReader : exemple OpenAPI, résultat identique quel que soit le découpage (entier, octet par octet, CRLF)', () => {
  const results = [whole, bytes, crlf].map(ch => {
    const { log, h } = recorder();
    const firsts = [];
    const r = readAll(OPENAPI_EXAMPLE, ch, { ...h, onFirstChat: id => firsts.push(id) });
    return { res: r.result(), log, firsts, last: r.lastEventId, umid: r.userMessageId, chat: r.chatId };
  });
  for (const x of results) {
    assert.deepEqual(x.res, { text: 'Bonjour', usage: { promptTokenCount: 10 }, toolCalls: [], stopped: false, images: [], documents: [], sawImage: false, chatId: 'c1', completed: true });
    assert.deepEqual(x.firsts, ['c1'], 'onFirstChat une seule fois');
    assert.equal(x.last, '6'); assert.equal(x.umid, 'u1'); assert.equal(x.chat, 'c1');
    assert.deepEqual(x.log.filter(e => e[0] === 'id').map(e => e[1]), ['1', '2', '3', '4', '5', '6'], 'chaque ligne id: signalée, dans l\'ordre ; pas le keepalive');
    assert.deepEqual(x.log.filter(e => e[0] === 'umid'), [['umid', 'u1']]);
    const iText = x.log.findIndex(e => e[0] === 'text');
    assert.deepEqual(x.log[iText - 1], ['id', '4'], 'onEventId juste avant onText du même événement');
  }
  assert.deepEqual(results[1].log, results[0].log);
  assert.deepEqual(results[2].log, results[0].log);
});

test('createSseReader : appels d\'outils, documents et images de « completed » ; événements inconnus ignorés', () => {
  const toolCalls = [{ callId: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }];
  const parts = [
    { type: 'tool-createDocument', state: 'output-available', input: { title: 'Doc', kind: 'text', content: 'x' }, output: { id: 'file-1', title: 'Doc' } },
    { type: 'tool-imageGeneration', output: { kind: 'image', contentUrl: '/chats/c/img.png' } },
  ];
  const text = [ev(1, 'mystere.nouveau', { x: 1 }), ev(2, 'completed', { chat_id: 'c2', message: { content: '', toolCalls, parts } })].join('');
  const res = readAll(text, whole).result();
  assert.deepEqual(res.toolCalls, toolCalls);
  assert.equal(res.documents.length, 1); assert.equal(res.documents[0].title, 'Doc');
  assert.equal(res.images.length, 1); assert.equal(res.sawImage, true);
  assert.equal(res.text, ''); assert.equal(res.completed, true, 'texte vide mais tour terminé : pas une erreur');
});

test('createSseReader : erreurs du flux (code, retryable, chat verrouillé), annulation, flux vide, réponse partielle sans completed', () => {
  const err = [ev(1, 'stream.open', { chat_id: 'c' }), ev(2, 'error', { code: 'STREAM_LEASE_LOST', message: 'perdu', retryable: true, origin: 'backend', chat_flagged: true })].join('');
  assert.throws(() => readAll(err, bytes).result(), e => e.name !== 'AbortError' && e.code === 'STREAM_LEASE_LOST' && e.retryable === true
    && e.chatFlagged === true && /Erreur du serveur: perdu/.test(e.message) && e instanceof api.ApiError);
  assert.throws(() => readAll(ev(1, 'error', { code: 'UPSTREAM_TIMEOUT', message: 'm', retryable: false }), whole).result(), e => e.retryable === false && e.code === 'UPSTREAM_TIMEOUT');
  assert.throws(() => readAll(ev(1, 'cancelled', { chat_id: 'c' }), whole).result(), e => e.code === 'CANCELLED' && /Réponse vide/.test(e.message));
  assert.throws(() => readAll('', whole).result(), /Réponse vide \/ flux interrompu/);
  assert.throws(() => readAll(': keepalive\n\ndata: [DONE]\n\ndata: pas du json\n\ndata: null\n\n', whole).result(), /Réponse vide/, 'blocs sans JSON objet ignorés sans planter');
  const partial = readAll(ev(1, 'response.output_text.delta', { delta: 'début' }), whole).result();
  assert.equal(partial.text, 'début'); assert.equal(partial.completed, false, 'coupure propre sans completed : signalée par completed=false');
});

test('createSseReader : stop() depuis onText → onStop(partiel), plus aucun rappel ensuite', () => {
  const stops = [], texts = [];
  const r = api.createSseReader({ onText: (d, stop) => { texts.push(d); if (d === 'B') stop(); }, onStop: p => stops.push(p) });
  r.push([ev(1, 'response.output_text.delta', { delta: 'A' }), ev(2, 'response.output_text.delta', { delta: 'B' }), ev(3, 'response.output_text.delta', { delta: 'C' })].join(''));
  r.end();
  assert.deepEqual(texts, ['A', 'B']);
  assert.deepEqual(stops, [{ text: 'AB', usage: null, stopped: true }]);
  assert.equal(r.stopped, true); assert.equal(r.lastEventId, '2');
});

test('createSseReader : un rappel onEventId / onUserMessageId / onEvent qui lève ne casse pas la lecture', () => {
  const boom = () => { throw new Error('bug appelant'); };
  const res = readAll(OPENAPI_EXAMPLE, whole, { onEventId: boom, onUserMessageId: boom, onEvent: boom }).result();
  assert.equal(res.text, 'Bonjour');
});

// ── once() / streamChat ───────────────────────────────────────────────────────────────────────────────────────────────

test('streamChat nouveau chat : POST /chats/stream, ordre des rappels onAccepted → onChat → onUserMessageId → (onEventId, onText)* → onEventId(completed)', async () => {
  reset();
  const toolCalls = [{ callId: 'call_9', name: 'list_directory', arguments: { path: '.' } }];
  route = (req, res) => sse(res, turnEvents({ chat: 'chat-N', umid: 'um-7', message: { toolCalls, tokenUsage: { promptTokenCount: 5 } } }));
  const { log, h } = recorder();
  const r = await api.streamChat({ agentId: -2003, chatId: null, content: '[ab12·cc] bonjour', clientTools: api.CLIENT_TOOLS, ...h });
  assert.equal(r.text, 'Bonjour'); assert.equal(r.chatId, 'chat-N'); assert.deepEqual(r.toolCalls, toolCalls); assert.equal(r.completed, true);
  assert.deepEqual(r.usage, { promptTokenCount: 5 });
  const [req] = seen;
  assert.equal(seen.length, 1);
  assert.equal(req.method, 'POST'); assert.equal(req.url, '/chats/stream');
  assert.equal(req.headers.authorization, 'Bearer jeton-de-test'); assert.equal(req.headers.accept, 'text/event-stream');
  assert.equal(req.headers['last-event-id'], undefined);
  assert.deepEqual(req.body, { agentId: -2003, chatId: null, enableCanvas: false, enableWebSearch: false, images: [], files: [],
    initialContent: '[ab12·cc] bonjour', isIncognito: false, isPrivate: true, clientTools: api.CLIENT_TOOLS });
  const first = k => log.findIndex(e => e[0] === k);
  assert.equal(first('accepted'), 0, 'onAccepted en premier (dès le 2xx)');
  assert.ok(first('chat') < first('umid') && first('umid') < first('text'));
  log.forEach((e, i) => { if (e[0] === 'text') assert.equal(log[i - 1][0], 'id'); });
  const ids = log.filter(e => e[0] === 'id').map(e => Number(e[1]));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids croissants');
  assert.ok(log.findLastIndex(e => e[0] === 'id') > log.findLastIndex(e => e[0] === 'text'), 'id de completed après le dernier texte');
});

test('streamChat chat existant : outils client → POST /chats/{id} (content, toolResults, files, web) ; texte seul → POST /chats/stream avec chatId', async () => {
  reset();
  route = (req, res) => sse(res, turnEvents({ chat: 'c/1' }));
  const toolResults = [{ callId: 'call_1', output: 'ok', isError: false }];
  await api.streamChat({ agentId: -1004, chatId: 'c/1', content: 'suite', toolResults, clientTools: api.CLIENT_TOOLS, files: ['file-1'], webSearch: true });
  assert.equal(seen[0].url, '/chats/c%2F1');
  assert.deepEqual(seen[0].body, { agentId: -1004, content: 'suite', files: ['file-1'], clientTools: api.CLIENT_TOOLS, toolResults, enableWebSearch: true });
  reset();
  await api.streamChat({ agentId: -1004, chatId: 'c/1', toolResults });
  assert.deepEqual(seen[0].body, { agentId: -1004, toolResults }, 'toolResults seuls : pas de content vide');
  reset();
  await api.streamChat({ agentId: -3001, chatId: 'c-9', content: 'texte seul' });
  assert.equal(seen[0].url, '/chats/stream');
  assert.equal(seen[0].body.chatId, 'c-9'); assert.equal(seen[0].body.initialContent, 'texte seul'); assert.equal(seen[0].body.clientTools, undefined);
});

test('coupure APRÈS le 2xx : erreur accepted=true, retry=false, chatId et lastEventId connus, un seul POST (jamais renvoyé)', async () => {
  reset();
  route = (req, res) => sse(res, turnEvents({ chat: 'chat-cut', deltas: ['a', 'b', 'c'] }), { hold: 3 });   // open, created, 1er delta
  const { log, h } = recorder({ onText: d => { log.push(['text', d]); cutOpen(); } });
  await assert.rejects(api.streamChat({ agentId: -2003, chatId: null, content: 'x', clientTools: api.CLIENT_TOOLS, ...h }), e => {
    assert.equal(e.accepted, true); assert.equal(e.retry, false);
    assert.equal(e.chatId, 'chat-cut'); assert.equal(e.lastEventId, '3');
    assert.match(e.message, /^Réseau: /);
    return true;
  });
  assert.equal(posts().length, 1, 'I2 : aucun nouvel essai après acceptation');
  assert.deepEqual(log.filter(e => e[0] === 'text'), [['text', 'a']]);
});

test('2xx puis flux vide : « Réponse vide », accepted=true, retry=false, un seul POST', async () => {
  reset();
  route = (req, res) => sse(res, []);
  const accepted = [];
  await assert.rejects(api.streamChat({ agentId: -2003, chatId: 'c', content: 'x', clientTools: api.CLIENT_TOOLS, onAccepted: () => accepted.push(1) }),
    e => e.accepted === true && e.retry === false && /Réponse vide/.test(e.message));
  assert.equal(posts().length, 1); assert.deepEqual(accepted, [1]);
});

test('erreur SSE après acceptation : code et retryable transmis, accepted=true, pas de nouvel essai', async () => {
  reset();
  route = (req, res) => sse(res, [ev(1, 'stream.open', { chat_id: 'c-e' }), ev(2, 'error', { code: 'UPSTREAM_SERVER_ERROR', message: 'boom', retryable: true, origin: 'upstream' })]);
  await assert.rejects(api.streamChat({ agentId: -2003, chatId: 'c-e', content: 'x', clientTools: api.CLIENT_TOOLS }), e => {
    assert.equal(e.code, 'UPSTREAM_SERVER_ERROR'); assert.equal(e.retryable, true); assert.equal(e.accepted, true); assert.equal(e.retry, false);
    assert.equal(e.chatId, 'c-e'); assert.equal(e.lastEventId, '2');
    return true;
  });
  assert.equal(posts().length, 1);
});

test('avant acceptation : 503 puis 200 → nouvel essai (retry=true, accepted=false), onAccepted une seule fois', async () => {
  reset();
  let n = 0;
  route = (req, res) => (n++ === 0 ? json(res, 503, { message: 'indisponible' }) : sse(res, turnEvents()));
  const accepted = [];
  const r = await api.streamChat({ agentId: -2003, chatId: 'c', content: 'x', onAccepted: () => accepted.push(1) });
  assert.equal(r.text, 'Bonjour'); assert.equal(posts().length, 2); assert.deepEqual(accepted, [1]);
});

test('avant acceptation : connexion coupée sans réponse → « Réseau: », retry=true, accepted=false, puis nouvel essai', async () => {
  reset();
  let n = 0;
  route = (req, res) => (n++ === 0 ? req.socket.destroy() : sse(res, turnEvents()));
  const r = await api.streamChat({ agentId: -2003, chatId: 'c', content: 'x' });
  assert.equal(r.text, 'Bonjour'); assert.equal(posts().length, 2);
});

test('erreurs HTTP : accepted=false ; 400 garde le corps (e.body) ; 401 ; 403 et 400 « Client tools » → NATIVE_UNSUPPORTED (outils client seulement)', async () => {
  const cases = [
    [400, { message: 'missing: call_1' }, { clientTools: api.CLIENT_TOOLS }, e => e.status === 400 && /missing: call_1/.test(e.body) && /^HTTP 400: /.test(e.message) && e.retry === false],
    [409, { message: 'pending' }, {}, e => e.status === 409 && /pending/.test(e.body)],
    [401, {}, {}, e => e.status === 401 && /^401 — clé de session expirée ou invalide.*fs-cli --login/.test(e.message)],
    [403, {}, { clientTools: api.CLIENT_TOOLS }, e => e.code === 'NATIVE_UNSUPPORTED' && e.status === 403],
    [403, {}, {}, e => e.code === undefined && /^403 — France Student refuse cette demande. .*fs-cli --login/.test(e.message)],
    [403, { message: 'Model not available on your plan' }, {}, e => /^403 — France Student refuse cette demande : « Model not available on your plan »/.test(e.message)],
    [400, { message: 'Client tools are not supported for this model' }, { toolResults: [] }, e => e.code === 'NATIVE_UNSUPPORTED' && e.status === 400],
  ];
  for (const [status, body, extra, check] of cases) {
    reset();
    route = (req, res) => json(res, status, body);
    const accepted = [];
    await assert.rejects(api.streamChat({ agentId: -2003, chatId: 'c', content: 'x', onAccepted: () => accepted.push(1), ...extra }),
      e => e.accepted === false && check(e), `${status} ${JSON.stringify(body)}`);
    assert.deepEqual(accepted, [], 'pas de 2xx : onAccepted jamais appelé');
    assert.equal(posts().length, 1);
  }
});

test('403 en page HTML (pare-feu, Cloudflare) avec outils client → 403 ordinaire, jamais NATIVE_UNSUPPORTED (mode texte seul à tort)', async () => {
  for (const page of ['<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>',
    'error code: 1020 (cf-ray 8a1b2c3d)']) {
    reset();
    route = (req, res) => { res.writeHead(403, { 'content-type': 'text/html' }); res.end(page); };
    await assert.rejects(api.streamChat({ agentId: -2003, chatId: 'c', content: 'x', clientTools: api.CLIENT_TOOLS }),
      e => e.status === 403 && e.code === undefined && /^403 — le pare-feu de France Student \(Cloudflare\)/.test(e.message));
  }
});

test('429 limite du jour : DAILY_CHAT_LIMIT, pas de nouvel essai, dailyLimitHitAt écrit avec saveCfgKeys (les autres clés du fichier sont gardées)', async () => {
  reset();
  const file = config.FILES.cfg;
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...cur, cleEcriteAilleurs: 'gardée' }, null, 2));   // écrite par un autre processus FS-CLI
  route = (req, res) => json(res, 429, { message: 'Daily new chat limit reached (50). Reset at 2026-11-19T04:00:00Z.' });
  const before = Date.now();
  await assert.rejects(api.streamChat({ agentId: -2003, chatId: null, content: 'x', clientTools: api.CLIENT_TOOLS }),
    e => e.code === 'DAILY_CHAT_LIMIT' && e.status === 429 && e.retry === false && e.accepted === false && e.resetAt === '2026-11-19T04:00:00Z');
  assert.equal(posts().length, 1);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.cleEcriteAilleurs, 'gardée', 'saveCfgKeys fusionne avec le fichier (saveCfg l\'aurait écrasée)');
  assert.ok(disk.dailyLimitHitAt >= before); assert.equal(config.cfg.dailyLimitHitAt, disk.dailyLimitHitAt);
});

test('annulation (signal) après acceptation : AbortError accepted=true et POST /chats/{id}/stream/cancel ; avant : accepted=false', async () => {
  reset();
  route = (req, res) => (req.url.endsWith('/stream/cancel') ? json(res, 204) : sse(res, turnEvents({ chat: 'chat-ab' }), { hold: 3 }));
  const ac = new AbortController();
  await assert.rejects(api.streamChat({ agentId: -2003, chatId: null, content: 'x', signal: ac.signal, onText: () => ac.abort() }),
    e => e.name === 'AbortError' && e.accepted === true);
  assert.ok(await until(() => seen.some(r => r.method === 'POST' && r.url === '/chats/chat-ab/stream/cancel')), 'génération arrêtée côté serveur');
  assert.equal(posts().length, 1);
  reset();
  const ac2 = new AbortController(); ac2.abort();
  await assert.rejects(api.streamChat({ agentId: -2003, chatId: 'c', content: 'x', signal: ac2.signal }), e => e.name === 'AbortError' && e.accepted === false);
});

test('stop() depuis onText : résout { text, usage, stopped: true } sans erreur (comportement du REPL inchangé)', async () => {
  reset();
  route = (req, res) => sse(res, turnEvents({ deltas: ['un ', 'deux ', 'trois'] }), { hold: 4 });
  const r = await api.streamChat({ agentId: -2003, chatId: 'c', content: 'x', onText: (d, stop) => { if (d === 'deux ') stop(); } });
  assert.deepEqual(r, { text: 'un deux ', usage: null, stopped: true });
});

test('un rappel onAccepted / onUserMessageId qui lève ne fait pas planter le processus', async () => {
  reset();
  route = (req, res) => sse(res, turnEvents());
  const boom = () => { throw new Error('bug appelant'); };
  const r = await api.streamChat({ agentId: -2003, chatId: 'c', content: 'x', onAccepted: boom, onUserMessageId: boom, onEventId: boom });
  assert.equal(r.text, 'Bonjour');
});

// ── resumeStream ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('resumeStream : GET /chats/{id}/stream avec Last-Event-ID, rejoue seulement la suite (texte non dupliqué)', async () => {
  reset();
  const all = turnEvents({ chat: 'chat-R', deltas: ['a', 'b', 'c'], message: { toolCalls: [{ callId: 'call_2', name: 'read_file', arguments: { path: 'x' } }] } });
  route = (req, res) => {
    const last = Number(req.headers['last-event-id'] || 0);
    sse(res, all.filter(b => Number(/^id: (\d+)/.exec(b)[1]) > last));
  };
  const { log, h } = recorder();
  const r = await api.resumeStream('chat-R', '3', h);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET'); assert.equal(seen[0].url, '/chats/chat-R/stream');
  assert.equal(seen[0].headers['last-event-id'], '3'); assert.equal(seen[0].headers.accept, 'text/event-stream');
  assert.equal(r.text, 'bc'); assert.equal(r.chatId, 'chat-R'); assert.equal(r.completed, true);
  assert.deepEqual(r.toolCalls, [{ callId: 'call_2', name: 'read_file', arguments: { path: 'x' } }]);
  assert.equal(log[0][0], 'accepted');
  assert.deepEqual(log.filter(e => e[0] === 'text').map(e => e[1]), ['b', 'c']);
  assert.deepEqual(log.filter(e => e[0] === 'id').map(e => e[1]), ['4', '5', '6']);
});

test('resumeStream : sans lastEventId → pas d\'en-tête ; valeur nettoyée (pas d\'injection d\'en-tête) ; 404 → accepted=false ; chatId manquant', async () => {
  reset();
  route = (req, res) => sse(res, turnEvents({ chat: 'c' }));
  await api.resumeStream('c', null);
  assert.equal(seen[0].headers['last-event-id'], undefined);
  reset();
  await api.resumeStream('c', '12\r\nX-Injecte: 1');
  assert.equal(seen[0].headers['last-event-id'], '12X-Injecte:1'); assert.equal(seen[0].headers['x-injecte'], undefined);
  reset();
  route = (req, res) => json(res, 404, { message: 'No active stream' });
  await assert.rejects(api.resumeStream('c', '2'), e => e.status === 404 && e.accepted === false && /No active stream/.test(e.body));
  await assert.rejects(api.resumeStream('', '2'), e => e.accepted === false && /chatId manquant/.test(e.message));
});

test('resumeStream : annulation → AbortError sans arrêter la génération côté serveur (l\'appelant décide)', async () => {
  reset();
  route = (req, res) => sse(res, turnEvents({ chat: 'c-hold' }), { hold: 3 });
  const ac = new AbortController();
  await assert.rejects(api.resumeStream('c-hold', null, { signal: ac.signal, onText: () => ac.abort() }), e => e.name === 'AbortError' && e.accepted === true);
  await wait(50);
  assert.ok(!seen.some(r => /\/stream\/cancel$/.test(r.url)));
});

// ── searchChats, compactChat, fetchAgentsFull ─────────────────────────────────────────────────────────────────────────

test('searchChats : GET /chats/search encodé, limite bornée, { chats } ou tableau ; jamais d\'exception', async () => {
  reset();
  route = (req, res) => json(res, 200, { chats: [{ id: 'c1', title: '[ab12·cc] Projet' }, null], hasMore: false });
  assert.deepEqual(await api.searchChats('[ab12·cc]'), [{ id: 'c1', title: '[ab12·cc] Projet' }]);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, `/chats/search?query=${encodeURIComponent('[ab12·cc]')}&limit=10`);
  reset();
  route = (req, res) => json(res, 200, [{ id: 'c2' }]);
  assert.deepEqual(await api.searchChats('x', 500), [{ id: 'c2' }]);
  assert.match(seen[0].url, /&limit=50$/);
  route = (req, res) => json(res, 500, { message: 'panne' });
  assert.deepEqual(await api.searchChats('x'), []);
  route = (req, res) => req.socket.destroy();
  assert.deepEqual(await api.searchChats('x'), []);
  route = (req, res) => { res.writeHead(200); res.end('pas du json'); };
  assert.deepEqual(await api.searchChats('x'), []);
  reset();
  assert.deepEqual(await api.searchChats('   '), []); assert.equal(seen.length, 0, 'requête vide : aucun appel');
});

test('compactChat : POST /chats/{id}/context → { status, data } ; 409/422 rendus tels quels ; sans chatId aucun appel', async () => {
  reset();
  route = (req, res) => json(res, 200, { totalTokens: 1234, measured: false });
  assert.deepEqual(await api.compactChat('chat-1'), { status: 200, data: { totalTokens: 1234, measured: false } });
  assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].url, '/chats/chat-1/context'); assert.equal(seen[0].body, null);
  for (const st of [409, 422]) {
    route = (req, res) => json(res, st, { message: 'non' });
    assert.equal((await api.compactChat('chat-1')).status, st);
  }
  route = (req, res) => req.socket.destroy();
  assert.equal((await api.compactChat('chat-1')).status, 0);
  reset();
  assert.deepEqual(await api.compactChat(null), { status: 0, data: null }); assert.equal(seen.length, 0);
});

test('fetchAgentsFull : tableau, { data } ou { agents } → tableau (inactifs gardés) ; erreur HTTP ou réseau → null', async () => {
  const list = [{ id: -2003, name: 'Claude Sonnet 5.5', model: 'claude-sonnet-5-5', modelProvider: 'anthropic' }, { id: -9, name: 'Ancien', isActive: false }];
  for (const body of [list, { data: list }, { agents: list }]) {
    reset();
    route = (req, res) => json(res, 200, body);
    assert.deepEqual(await api.fetchAgentsFull(), list);
    assert.equal(seen[0].method, 'GET'); assert.equal(seen[0].url, '/chats/agents');
  }
  route = (req, res) => json(res, 401, { message: 'expired' });
  assert.equal(await api.fetchAgentsFull(), null);
  route = (req, res) => json(res, 200, { autre: 1 });
  assert.equal(await api.fetchAgentsFull(), null);
  route = (req, res) => req.socket.destroy();
  assert.equal(await api.fetchAgentsFull(), null);
});

test('serveur MCP : fs_models fonctionne avec la forme tableau de fetchAgentsFull (rétrocompatible)', async () => {
  const { createMcpServer } = await import('../src/mcp-server.js');
  const s = createMcpServer({ hasToken: () => true, fetchAgents: async () => null,
    fetchAgentsFull: async () => [{ id: -2003, name: 'Claude Sonnet 5.5', contextWindow: 200000 }, { id: -9, name: 'Inactif', isActive: false }] });
  const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_models', arguments: {} } });
  const text = r.result.content[0].text;
  assert.match(text, /^1 modèle France Student/); assert.match(text, /Claude Sonnet 5\.5 \(id -2003\)/); assert.doesNotMatch(text, /Inactif/);
});

test('serverMessage : message JSON lisible, une ligne, 200 caractères au plus ; rien pour du HTML', () => {
  assert.equal(api.serverMessage('{"message":"Accès\\nrefusé"}'), 'Accès refusé');
  assert.equal(api.serverMessage('{"error":{"message":"plan"}}'), 'plan');
  assert.equal(api.serverMessage('{"error":"interdit"}'), 'interdit');
  assert.equal(api.serverMessage('<html>bloqué</html>'), '');
  assert.equal(api.serverMessage(JSON.stringify({ message: 'x'.repeat(500) })).length, 200);
});
