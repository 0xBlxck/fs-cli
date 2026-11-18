// Tests de src/gateway/server.js (sécurité, routes, corps, déconnexion) et src/gateway/log.js (rotation, masquage).
// Serveur réel sur 127.0.0.1 port 0 (boucle locale uniquement, aucun réseau externe, aucun appel à France Student).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { tmpHome, loadFixture, parseSse, deferred } from './gateway-helpers.mjs';   // pose FS_CLI_HOME avant tout import de src/

const { checkAuth, readBody, route, handleHttp, listen, parseJsonBody, MAX_BODY } = await import('../src/gateway/server.js');
const { Reply, estimateTokens } = await import('../src/gateway/anthropic.js');
const { createLog, redact } = await import('../src/gateway/log.js');

const TOKEN = crypto.randomBytes(24).toString('base64url');            // jeton de passerelle tiré au hasard à chaque exécution
const BAD_TOKEN_MSG = 'Jeton de la passerelle FS-CLI invalide : relance avec fs-cli claude, ou recopie le jeton affiché par fs-cli gateway.';

/** Requête HTTP vers la passerelle de test ; renvoie { status, headers, text, json }. */
function call(port, { method = 'POST', path: p = '/v1/messages?beta=true', headers = {}, body = null, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const all = { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const h = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));   // undefined = en-tête retiré
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

/** Passerelle de test : vrai serveur HTTP, gestionnaires injectés. */
async function gateway(handlers = {}, opts = {}) {
  const lines = [];
  const log = { line: o => lines.push(o) };
  const srv = await listen((req, res) => handleHttp(req, res, { token: TOKEN, handlers, log, ...opts }));
  return { ...srv, lines };
}

const fakeReq = (method, url, headers = {}) => ({ method, url, headers });

// ── route() ──

test('route : messages, count_tokens, models, HEAD/GET / ; tout le reste → notfound', () => {
  const cases = [
    ['POST', '/v1/messages?beta=true', 'messages'], ['POST', '/v1/messages', 'messages'], ['POST', '/v1/messages/', 'messages'],
    ['POST', '/v1/messages/count_tokens?beta=true', 'count_tokens'], ['GET', '/v1/models?limit=1000', 'models'],
    ['HEAD', '/', 'head'], ['GET', '/', 'head'], ['GET', '/?x=1', 'head'],
    ['POST', '/', 'notfound'], ['GET', '/v1/messages', 'notfound'], ['POST', '/v1/complete', 'notfound'],
    ['DELETE', '/v1/models', 'notfound'], ['POST', '/v1/messages/batches', 'notfound'], ['GET', '/v1/models/claude-x', 'notfound'],
  ];
  for (const [m, u, want] of cases) assert.equal(route(fakeReq(m, u)), want, `${m} ${u}`);
});

// ── checkAuth() ──

test('checkAuth : Origin → 403, Host étranger → 403, jeton faux ou absent → 401 (seul cas de 401), bon jeton → null', () => {
  const port = 53412;
  const host = { host: `127.0.0.1:${port}` };
  const ok = (h, m = 'POST', u = '/v1/messages') => checkAuth(fakeReq(m, u, { ...host, ...h }), { token: TOKEN, port });
  assert.equal(ok({ authorization: `Bearer ${TOKEN}` }), null);
  assert.equal(ok({ authorization: `bearer  ${TOKEN} ` }), null, 'schéma Bearer insensible à la casse');
  assert.equal(ok({ 'x-api-key': TOKEN }), null, 'x-api-key accepté (ANTHROPIC_API_KEY)');
  assert.equal(ok({ authorization: 'Bearer faux', 'x-api-key': TOKEN }), null, 'l\'un des deux suffit');
  assert.equal(checkAuth(fakeReq('POST', '/v1/messages', { host: `LOCALHOST:${port}`, 'x-api-key': TOKEN }), { token: TOKEN, port }), null);
  for (const h of [{}, { authorization: 'Bearer faux' }, { authorization: `Bearer ${TOKEN}x` }, { authorization: TOKEN }, { 'x-api-key': TOKEN.slice(1) }, { authorization: `Basic ${TOKEN}` }]) {
    assert.deepEqual(ok(h), { status: 401, type: 'authentication_error', message: BAD_TOKEN_MSG }, JSON.stringify(h));
  }
  const origin = ok({ authorization: `Bearer ${TOKEN}`, origin: 'https://site-malveillant.example.com' });
  assert.equal(origin.status, 403);
  assert.equal(origin.type, 'permission_error');
  assert.equal(ok({ authorization: `Bearer ${TOKEN}`, origin: 'null' }).status, 403, 'Origin « null » (iframe sandbox) refusé aussi');
  for (const h of ['evil.example.com', `127.0.0.1:${port + 1}`, `0.0.0.0:${port}`, '127.0.0.1', `[::1]:${port}`, '']) {
    assert.equal(checkAuth(fakeReq('POST', '/v1/messages', { host: h, authorization: `Bearer ${TOKEN}` }), { token: TOKEN, port }).status, 403, h);
  }
  assert.equal(checkAuth(fakeReq('POST', '/v1/messages', { ...host, authorization: 'Bearer ' }), { token: '', port }).status, 401, 'jeton serveur vide : tout refusé');
});

test('checkAuth : HEAD / et GET / sans jeton (préchauffage), mais Origin et Host restent contrôlés', () => {
  const port = 8787;
  const h = { host: `127.0.0.1:${port}` };
  assert.equal(checkAuth(fakeReq('HEAD', '/', h), { token: TOKEN, port }), null);
  assert.equal(checkAuth(fakeReq('GET', '/', h), { token: TOKEN, port }), null);
  assert.equal(checkAuth(fakeReq('GET', '/v1/models', h), { token: TOKEN, port }).status, 401);
  assert.equal(checkAuth(fakeReq('HEAD', '/', { ...h, origin: 'http://x.example.com' }), { token: TOKEN, port }).status, 403);
  assert.equal(checkAuth(fakeReq('HEAD', '/', { host: 'evil.example.com' }), { token: TOKEN, port }).status, 403);
});

// ── readBody() / parseJsonBody() ──

const stream = (chunks, headers = {}) => Object.assign(Readable.from(chunks.map(c => Buffer.from(c))), { headers });

test('readBody : corps complet en Buffer ; 413 au-delà de la limite (annoncée ou constatée) ; 400 si le client coupe', async () => {
  const buf = await readBody(stream(['{"a":', '1}']));
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), '{"a":1}');
  assert.equal(MAX_BODY, 64 * 2 ** 20);
  await assert.rejects(readBody(stream(['x'], { 'content-length': String(MAX_BODY + 1) })), e => e.status === 413 && e.type === 'request_too_large');
  await assert.rejects(readBody(stream(['12345', '67890', 'abc']), 10), e => e.status === 413);
  assert.equal((await readBody(stream(['12345', '67890']), 10)).length, 10, 'exactement la limite : accepté');
  const cut = Object.assign(new EventEmitter(), { headers: {}, resume() {} });
  const p = readBody(cut);
  cut.emit('data', Buffer.from('{"a"'));
  cut.emit('aborted');
  await assert.rejects(p, e => e.status === 400);
});

test('parseJsonBody : objet exigé, sinon 400 en français', () => {
  assert.deepEqual(parseJsonBody(Buffer.from('{"model":"x"}')), { model: 'x' });
  for (const bad of ['', '{', '[1]', 'null', '"x"', '42']) {
    assert.throws(() => parseJsonBody(Buffer.from(bad)), e => e.status === 400 && e.type === 'invalid_request_error' && /JSON/.test(e.message), bad);
  }
});

// ── serveur HTTP réel ──

test('serveur : mauvais jeton → 401, Origin → 403, Host étranger → 403, HEAD/GET / → 200 sans jeton', async () => {
  let reached = 0;
  const g = await gateway({ messages: (req, res) => { reached++; res.end('{}'); } });
  try {
    const r401 = await call(g.port, { body: { model: 'm', messages: [] }, auth: false, headers: { authorization: 'Bearer pas-le-bon' } });
    assert.equal(r401.status, 401);
    assert.deepEqual(r401.json, { type: 'error', error: { type: 'authentication_error', message: BAD_TOKEN_MSG } });
    assert.equal((await call(g.port, { body: {}, auth: false })).status, 401);
    const r403 = await call(g.port, { body: {}, headers: { origin: 'http://page.example.com' } });
    assert.equal(r403.status, 403);
    assert.equal(r403.json.error.type, 'permission_error');
    assert.equal((await call(g.port, { body: {}, headers: { host: 'attaquant.example.com' } })).status, 403, 'anti DNS rebinding');
    assert.equal((await call(g.port, { body: {}, headers: { host: `localhost:${g.port}` } })).status, 200, 'localhost:port accepté');
    const head = await call(g.port, { method: 'HEAD', path: '/', auth: false });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal((await call(g.port, { method: 'GET', path: '/', auth: false })).status, 200);
    assert.equal(reached, 1, 'seule la requête autorisée atteint le gestionnaire');
    assert.match(g.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally { await g.close(); }
});

test('serveur : 413 request_too_large (annoncé et en flux), 400 JSON invalide, 404 route inconnue', async () => {
  let reached = 0;
  const g = await gateway({ messages: (req, res) => { reached++; res.end('{}'); } }, { maxBytes: 1000 });
  try {
    const big = await call(g.port, { body: Buffer.alloc(2000, 0x61) });
    assert.equal(big.status, 413);
    assert.deepEqual(Object.keys(big.json.error).sort(), ['message', 'type']);
    assert.equal(big.json.error.type, 'request_too_large');
    const chunked = await call(g.port, { body: Buffer.alloc(3000, 0x62), headers: { 'content-length': undefined, 'transfer-encoding': 'chunked' } });
    assert.equal(chunked.status, 413, 'sans content-length : limite constatée en lisant');
    const bad = await call(g.port, { body: '{"model":' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.type, 'invalid_request_error');
    const nf = await call(g.port, { method: 'POST', path: '/v1/complete', body: {} });
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.type, 'not_found_error');
    assert.equal((await call(g.port, { method: 'GET', path: '/v1/messages' })).status, 404);
    assert.equal((await call(g.port, { method: 'GET', path: '/v1/models/x', auth: false })).status, 401, 'le jeton passe avant la route');
    assert.equal(reached, 0);
  } finally { await g.close(); }
});

test('serveur : count_tokens = estimateTokens(corps) ; /v1/models servi par le gestionnaire injecté (claude-fs/gpt-6-astra)', async () => {
  const models = { data: [
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5 · France Student', type: 'model', created_at: '2026-01-01T00:00:00Z' },
    { id: 'claude-fs/gpt-6-astra', display_name: 'GPT-6 Astra · France Student', type: 'model', created_at: '2026-01-01T00:00:00Z' },
  ], has_more: false };
  const g = await gateway({ models: async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(models)); } });
  const bare = await gateway({});
  try {
    const body = loadFixture('req-03').body;
    const count = { model: body.model, system: body.system, tools: body.tools, messages: body.messages };
    const ct = await call(g.port, { path: '/v1/messages/count_tokens?beta=true', body: count });
    assert.equal(ct.status, 200);
    assert.deepEqual(ct.json, { input_tokens: estimateTokens(body) });
    const m = await call(g.port, { method: 'GET', path: '/v1/models?limit=1000', headers: { 'x-api-key': TOKEN }, auth: false });
    assert.equal(m.status, 200);
    assert.ok(m.json.data.some(x => x.id === 'claude-fs/gpt-6-astra'));
    assert.ok(m.json.data.every(x => /^(claude|anthropic)/i.test(x.id)), 'filtre de découverte de Claude Code 2.1.207');
    assert.deepEqual((await call(bare.port, { method: 'GET', path: '/v1/models' })).json, { data: [], has_more: false });
    assert.equal((await call(bare.port, { body: { model: 'x' } })).status, 404, 'pas de gestionnaire messages : 404');
  } finally { await g.close(); await bare.close(); }
});

test('serveur : exception d\'un gestionnaire → 500 api_error journalisé (sans corps ni jeton)', async () => {
  const g = await gateway({ messages: async () => { throw new Error('panne simulée'); } });
  try {
    const r = await call(g.port, { body: { model: 'm', messages: [] } });
    assert.equal(r.status, 500);
    assert.equal(r.json.error.type, 'api_error');
    assert.match(r.json.error.message, /panne simulée/);
    assert.equal(g.lines.length, 1);
    assert.ok(!JSON.stringify(g.lines).includes(TOKEN));
  } finally { await g.close(); }
});

test('serveur : flux SSE réel, puis fermeture du client détectée par res.on(\'close\') et non par la fin de lecture du corps', async () => {
  const abandoned = deferred();
  const ready = deferred();
  let reply = null, reqClosedEarly = false;
  const g = await gateway({
    messages: (req, res, body) => {
      reqClosedEarly = req.destroyed || req.readableEnded;               // le corps est lu : req a fini (et peut déjà avoir émis close)
      reply = new Reply({ model: body.model, inputTokens: estimateTokens(body), idleMs: 40, onAbandon: () => abandoned.open('abandon') });
      reply.subscribe(res, body.stream !== false);
      reply.headers();
      reply.text('Je commence…');
      ready.open();                                                       // génération « en cours » : jamais terminée ici
    },
  });
  try {
    const data = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: 'salut' }] }));
    const req = http.request({ host: '127.0.0.1', port: g.port, method: 'POST', path: '/v1/messages?beta=true',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': data.length } });
    const first = new Promise((resolve, reject) => {
      req.on('response', res => {
        let text = '';
        res.on('data', c => { text += c; if (text.includes('Je commence')) resolve({ res, text }); });
        res.on('error', () => {});
      });
      req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    });
    req.end(data);
    await ready.promise;
    const { res, text } = await first;
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    const p = parseSse(text, { partial: true });
    assert.equal(p.events[0].event, 'message_start');
    assert.equal(p.text, 'Je commence…');
    assert.ok(reqClosedEarly, 'le corps est entièrement lu avant le gestionnaire');
    await new Promise(r => setTimeout(r, 120));                           // 3 × idleMs : req a fini depuis longtemps
    assert.equal(reply.listeners, 1, 'la fin de lecture du corps ne désabonne pas le client');
    req.destroy();                                                        // le client coupe (Échap, réessai…)
    const outcome = await Promise.race([abandoned.promise, new Promise(r => setTimeout(() => r('délai dépassé'), 3000).unref())]);
    assert.equal(outcome, 'abandon');
    assert.equal(reply.listeners, 0);
    assert.equal(reply.done, false, 'la génération n\'est pas terminée par la coupure : c\'est à l\'appelant d\'annuler');
    reply.finish('end_turn');                                             // libère le minuteur de pings
  } finally { await g.close(); }
});

test('listen : port déjà pris → message en français (EADDRINUSE)', async () => {
  const a = await listen(async (req, res) => res.end());
  try {
    await assert.rejects(listen(async (req, res) => res.end(), { port: a.port }), e => e.code === 'EADDRINUSE' && /déjà utilisé.*--fs-port/.test(e.message));
  } finally { await a.close(); }
});

// ── log.js ──

const fakeSecrets = () => ({
  ant: ['sk', 'ant', 'api03', 'Zx9Qw'.repeat(8)].join('-'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlX2Zha2U'].join('.'),
  fs: 'Fs' + crypto.randomBytes(18).toString('hex'),
});

test('redact : Bearer, x-api-key, clés sk-ant-/sk-, JWT, cookies next-auth, variables *_TOKEN, champs JSON sensibles', () => {
  const s = fakeSecrets();
  const cases = [
    [`authorization: Bearer ${TOKEN}`, TOKEN],
    [`Authorization: Bearer ${TOKEN}`, TOKEN],
    [`{"x-api-key":"${TOKEN}"}`, TOKEN],
    [`clé ${s.ant} utilisée`, s.ant],
    [`cookie next-auth.session-token=${s.jwt}; path=/`, s.jwt],
    [`jeton ${s.jwt}`, s.jwt],
    [`ANTHROPIC_AUTH_TOKEN=${TOKEN} claude`, TOKEN],
    [`FS_SESSION_TOKEN="${s.fs}"`, s.fs],
    [`{"ANTHROPIC_AUTH_TOKEN":"${TOKEN}"}`, TOKEN],
    [`password=${s.fs}&user=a`, s.fs],
    [`"token": "${s.fs}"`, s.fs],
  ];
  for (const [input, secret] of cases) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `secret visible dans : ${out}`);
    assert.match(out, /\*\*\*/);
  }
  assert.equal(redact('max_tokens: 4096, input_tokens: 12, Tokens restants'), 'max_tokens: 4096, input_tokens: 12, Tokens restants');
  assert.equal(redact('lis C:\\proj\\hello.txt puis node --test'), 'lis C:\\proj\\hello.txt puis node --test');
  assert.equal(redact(null), '');
});

test('createLog : une ligne JSON horodatée et masquée par appel, JSON toujours valide, clés sensibles masquées', () => {
  const dir = tmpHome();
  const file = path.join(dir, 'gateway', 'gateway.log');
  const log = createLog(file);
  const s = fakeSecrets();
  log.line({ sorte: 'main', chat: 'chat-1', headers: { authorization: `Bearer ${TOKEN}`, 'x-api-key': TOKEN }, max_tokens: 5, note: `env ANTHROPIC_AUTH_TOKEN=${TOKEN}`, cle: s.ant });
  log.line('texte libre avec ' + s.jwt);
  log.close();
  log.line({ apres: 'fermeture' });                                       // ignoré, sans exception
  const raw = fs.readFileSync(file, 'utf8');
  for (const v of [TOKEN, s.ant, s.jwt]) assert.ok(!raw.includes(v));
  const lines = raw.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.match(lines[0].t, /^\d{4}-\d\d-\d\dT/);
  assert.equal(lines[0].sorte, 'main');
  assert.equal(lines[0].max_tokens, 5);
  assert.equal(lines[0].headers.authorization, '***');
  assert.equal(lines[0].headers['x-api-key'], '***');
  assert.match(lines[1].msg, /^texte libre avec eyJ\*\*\*/);
});

test('createLog : rotation au-delà de maxBytes (fichier .1 remplacé), aucune ligne coupée', () => {
  const dir = tmpHome();
  const file = path.join(dir, 'gateway.log');
  const log = createLog(file, { maxBytes: 400 });
  for (let i = 0; i < 40; i++) log.line({ i, texte: 'x'.repeat(40) });
  log.close();
  assert.ok(fs.existsSync(file + '.1'), 'fichier tourné présent');
  assert.ok(fs.statSync(file).size <= 400);
  assert.ok(fs.statSync(file + '.1').size <= 400);
  const all = [file + '.1', file].flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n')).map(l => JSON.parse(l).i);
  assert.equal(all[all.length - 1], 39);
  for (let k = 1; k < all.length; k++) assert.equal(all[k], all[k - 1] + 1, 'lignes consécutives entre .1 et le fichier courant');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['gateway.log', 'gateway.log.1'], 'deux fichiers au plus');
});

test('createLog : debug() inactif sans debugDir, corps masqué avec --fs-debug ; jamais d\'exception si le disque refuse', () => {
  const dir = tmpHome();
  const off = createLog(path.join(dir, 'a.log'));
  off.debug('requete', { a: 1 });
  assert.ok(!fs.existsSync(path.join(dir, 'debug')));
  const debugDir = path.join(dir, 'debug');
  const on = createLog(path.join(dir, 'b.log'), { debugDir });
  on.debug('requête main/1', { headers: { authorization: `Bearer ${TOKEN}` }, body: { messages: [{ role: 'user', content: 'salut' }] } });
  on.debug('texte', `x-api-key: ${TOKEN}`);
  const files = fs.readdirSync(debugDir).sort();
  assert.equal(files.length, 2);
  assert.ok(files.every(f => /^[\w.-]+$/.test(f)), 'noms de fichiers sûrs');
  const first = fs.readFileSync(path.join(debugDir, files[0]), 'utf8');
  assert.ok(!first.includes(TOKEN));
  assert.equal(JSON.parse(first).body.messages[0].content, 'salut');
  assert.ok(!fs.readFileSync(path.join(debugDir, files[1]), 'utf8').includes(TOKEN));
  const blocker = path.join(dir, 'fichier');
  fs.writeFileSync(blocker, '');
  const broken = createLog(path.join(blocker, 'sous', 'g.log'), { debugDir: path.join(blocker, 'd') });
  assert.doesNotThrow(() => { broken.line({ a: 1 }); broken.debug('x', {}); broken.close(); broken.close(); });
});
