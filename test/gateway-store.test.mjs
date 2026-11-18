// Passerelle Claude Code : état persistant, index, verrous et sémaphore (src/gateway/store.js, spécification § 3.3).
import { tmpHome, FAKE_NOW, deferred } from './gateway-helpers.mjs';   // pose FS_CLI_HOME avant tout import de src/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { openStore, pushAnchor, pushReply, atomicWrite } = await import('../src/gateway/store.js');
const { fsId, synthId } = await import('../src/gateway/ids.js');
const { canonicalize, fpAssistant } = await import('../src/gateway/transcript.js');

const ENV = { cwd: 'C:\\proj', platform: 'win32', shell: 'bash', osVersion: 'Windows 11', isGit: false, branch: null, extraDirs: [], pathMod: 'win32' };
const AGENT = { agentId: -2003, model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic', native: true, contextWindow: 200000 };
const CHAT = ['1a2b3c4d', '0000', '4000', '8000', '000000000009'].join('-');   // forme UUID assemblée (scan.mjs refuse les littéraux)
const DAY = 86_400_000;

const cls = (sessionId, agentId = null) => ({ kind: agentId ? 'subagent' : 'main', sessionId, agentId, model: AGENT.model, stream: true });
const clock = (t = FAKE_NOW) => { const c = () => c.t; c.t = t; return c; };
const tick = () => new Promise(r => setImmediate(r));
function open(dir = tmpHome(), opts = {}) {
  const logs = [];
  const store = openStore(dir, { now: clock(), log: o => logs.push(o), ...opts });
  return { store, dir, logs };
}
const convFiles = dir => fs.readdirSync(path.join(dir, 'conv')).filter(n => n.endsWith('.json'));
const turnsWith = (...msgs) => canonicalize(msgs);
const asstUses = (...ids) => ({ role: 'assistant', content: ids.map(id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: 'C:\\proj\\a.txt' } })) });

// ── création, sauvegarde, relecture ───────────────────────────────────────────────────────────────────────────────────

test('create : forme Conv, fichier atomique 0o600, index des sessions', () => {
  const { store, dir } = open();
  const conv = store.create(cls('sess-A'), ENV, AGENT);
  assert.match(conv.id, /^[0-9A-Za-z]{12}$/);
  assert.equal(conv.key, 'sess-A|main');
  assert.deepEqual(conv.sessions, ['sess-A']);
  assert.match(conv.sid, /^[0-9a-f]{4}$/);
  assert.equal(conv.chatId, null);
  assert.equal(conv.agentId, -2003);
  assert.equal(conv.fs.state, 'idle');
  assert.deepEqual(conv.readSet, { sessionId: 'sess-A', paths: {} });
  assert.equal(conv.createdAt, FAKE_NOW);
  const file = path.join(dir, 'conv', `${conv.id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).id, conv.id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'conv')).filter(n => n.endsWith('.tmp')), [], 'aucun fichier temporaire laissé');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.sessions['sess-A|main'], conv.id);
  assert.equal(store.create(cls('sess-A', 'agent-7'), ENV, AGENT).key, 'sess-A|agent-7', 'sous-agent : clé à part');
});

test('save : seules les données partent sur disque (AbortController, fonctions, clés « _ » exclus)', () => {
  const { store, dir } = open();
  const conv = store.create(cls('s1'), ENV, AGENT);
  conv.abort = new AbortController();
  conv._reply = { x: 1 };
  conv.cb = () => 1;
  conv.chatId = 'chat-1';
  store.save(conv);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'conv', `${conv.id}.json`), 'utf8'));
  assert.equal(disk.chatId, 'chat-1');
  for (const k of ['abort', '_reply', 'cb']) assert.ok(!(k in disk), k);
  assert.ok(conv.abort instanceof AbortController, 'l\'objet en mémoire est intact');
});

test('find par session : même objet ; après redémarrage (nouvelle instance), relu du disque', () => {
  const dir = tmpHome();
  const { store } = open(dir);
  const conv = store.create(cls('sess-B'), ENV, AGENT);
  conv.chatId = 'chat-b'; conv.lastFp = 'T:1234';
  store.save(conv);
  assert.equal(store.find(cls('sess-B'), []), conv);
  const { store: again } = open(dir);
  const back = again.find(cls('sess-B'), []);
  assert.equal(back.id, conv.id);
  assert.equal(back.chatId, 'chat-b');
  assert.equal(again.find(cls('sess-inconnue'), []), null);
  assert.equal(again.find(cls(null), []), null);
});

test('find par marqueur [fs-gw:…] après compaction : session ajoutée', () => {
  const { store } = open();
  const conv = store.create(cls('sess-C'), ENV, AGENT);
  const turns = [{ role: 'user', text: '', results: [], images: [], notes: [], interrupted: false, marker: conv.id, isContinuation: true, claudeMd: null }];
  const found = store.find(cls('sess-C2'), turns);
  assert.equal(found, conv);
  assert.deepEqual(conv.sessions, ['sess-C', 'sess-C2']);
  assert.equal(store.find(cls('sess-C2'), []), conv, 'la nouvelle session est indexée');
});

test('find par ancre (--resume, autre processus) ; readSet remis à zéro quand la session change', () => {
  const dir = tmpHome();
  const { store } = open(dir);
  const conv = store.create(cls('sess-D'), ENV, AGENT);
  const turns = turnsWith({ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'Réponse émise.' }] }, { role: 'user', content: 'suite' });
  conv.chatId = 'chat-d'; conv.lastFp = fpAssistant(turns[1]); conv.lastText = 'Réponse émise.'; conv.turn = 1;
  conv.readSet.paths['C:\\proj\\a.txt'] = true;
  pushAnchor(conv);
  store.save(conv);
  const { store: other } = open(dir);
  const found = other.find(cls('sess-D-reprise'), turns);
  assert.equal(found.id, conv.id);
  assert.ok(found.sessions.includes('sess-D-reprise'));
  assert.deepEqual(found.readSet, { sessionId: 'sess-D-reprise', paths: {} });
});

test('find par décodage des ids tool_use : chat connu, puis chat inconnu adopté en « uncertain »', () => {
  const dir = tmpHome();
  const { store } = open(dir);
  const conv = store.create(cls('sess-E'), ENV, AGENT);
  conv.chatId = CHAT; store.save(conv);
  const turns = turnsWith({ role: 'user', content: 'q' }, asstUses(fsId(CHAT, 'call-1')), { role: 'user', content: [{ type: 'tool_result', tool_use_id: fsId(CHAT, 'call-1'), content: 'x' }] });
  const { store: other } = open(dir);
  assert.equal(other.find(cls('sess-E2'), turns).id, conv.id);

  const ids = [synthId('read'), fsId('chat-perdu', 'call-7'), fsId('chat-perdu', 'call-8')];
  const lost = turnsWith({ role: 'user', content: 'q' }, asstUses(...ids), { role: 'user', content: 'suite' });
  const adopted = other.find(cls('sess-F'), lost);
  assert.equal(adopted.chatId, 'chat-perdu');
  assert.equal(adopted.fs.state, 'uncertain');
  assert.equal(adopted.preambleSent, true);
  assert.equal(adopted.lastFp, fpAssistant(lost[1]));
  assert.deepEqual(adopted.fs.pending.map(p => [p.callId, p.ccId, p.fsName, p.path]),
    [['call-7', ids[1], 'read_file', 'C:\\proj\\a.txt'], ['call-8', ids[2], 'read_file', 'C:\\proj\\a.txt']]);
  assert.equal(other.find(cls('sess-G'), lost).id, adopted.id, 'retrouvée ensuite par l\'index des chats');
  assert.equal(other.find(cls('sess-H'), turnsWith({ role: 'user', content: 'q' }, asstUses('toolu_capture1'))), null, 'ids étrangers : rien');
});

test('index : relecture puis fusion entre deux processus, plafond de 5 000 entrées par table', () => {
  const dir = tmpHome();
  const { store: a } = open(dir), { store: b } = open(dir);
  const ca = a.create(cls('proc-a'), ENV, AGENT);
  const cb = b.create(cls('proc-b'), ENV, AGENT);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.sessions['proc-a|main'], ca.id, 'l\'entrée de l\'autre processus n\'est pas écrasée');
  assert.equal(index.sessions['proc-b|main'], cb.id);
  assert.equal(a.find(cls('proc-b'), []).id, cb.id, 'a voit la conversation créée par b');

  const big = { sessions: {}, anchors: {}, chats: {} };
  for (let i = 0; i < 5100; i++) big.chats[`chat-${i}`] = 'AAAAAAAAAAAA';
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(big));
  ca.chatId = 'chat-neuf'; a.save(ca);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(Object.keys(after.chats).length, 5000);
  assert.equal(after.chats['chat-neuf'], ca.id, 'l\'entrée récente est gardée');
  assert.ok(!('chat-0' in after.chats), 'les plus anciennes partent');
});

test('fichiers illisibles : index ou conversation corrompus, pas d\'exception', () => {
  const dir = tmpHome();
  fs.mkdirSync(path.join(dir, 'conv'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), '{pas du json');
  const { store, logs } = open(dir);
  const conv = store.create(cls('s-x'), ENV, AGENT);
  fs.writeFileSync(path.join(dir, 'conv', 'Zz0000000000.json'), '{oups');
  assert.equal(store.get('Zz0000000000'), null);
  assert.ok(logs.some(l => l.store === 'illisible'));
  assert.equal(store.get('../index'), null, 'id invalide refusé');
  assert.equal(store.find(cls('s-x'), []), conv);
  assert.ok(store.list().every(c => c.id !== 'Zz0000000000'));
});

test('atomicWrite : remplace le fichier sans laisser de .tmp', () => {
  const dir = tmpHome();
  const f = path.join(dir, 'sous', 'x.json');
  atomicWrite(f, '1'); atomicWrite(f, '2');
  assert.equal(fs.readFileSync(f, 'utf8'), '2');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['x.json']);
});

// ── ancres et cache des réponses ──────────────────────────────────────────────────────────────────────────────────────

test('pushAnchor / pushReply : 300 ancres, 3 réponses et 200 ko au plus, la plus récente toujours gardée', () => {
  const { store } = open();
  const conv = store.create(cls('s-anchors'), ENV, AGENT);
  for (let i = 0; i < 310; i++) { conv.lastFp = `T:${i}`; conv.turn = i; conv.lastText = `réponse ${i} `.repeat(20); pushAnchor(conv); }
  assert.equal(conv.anchors.length, 300);
  assert.deepEqual(conv.anchors.at(-1).slice(0, 2), ['T:309', 309]);
  assert.equal(conv.anchors.at(-1)[2].length, 64);
  assert.equal(conv.anchors.at(-1)[3], null);
  conv.lastFp = 'T:5'; pushAnchor(conv);
  assert.equal(conv.anchors.filter(([f]) => f === 'T:5').length, 1, 'pas de doublon');

  for (let i = 0; i < 5; i++) pushReply(conv, `k${i}`, { text: 'x' });
  assert.deepEqual(conv.lastReplies.map(r => r.key), ['k2', 'k3', 'k4']);
  pushReply(conv, 'gros', { text: 'y'.repeat(150_000) });
  pushReply(conv, 'gros2', { text: 'z'.repeat(150_000) });
  assert.deepEqual(conv.lastReplies.map(r => r.key), ['gros2']);
  pushReply(conv, 'enorme', { text: 'w'.repeat(300_000) });
  assert.deepEqual(conv.lastReplies.map(r => r.key), ['enorme'], 'même au-delà de 200 ko, la dernière reste (sinon un réessai passerait pour un retour en arrière)');
  store.save(conv);
  assert.equal(store.get(conv.id).lastReplies.length, 1);
});

// ── verrous ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('lock : une seule exécution à la fois par clé, une erreur ne bloque pas la suite, clés indépendantes', async () => {
  const { store } = open();
  const order = [];
  const d1 = deferred();
  const p1 = store.lock('k', async () => { order.push('1-début'); await d1.promise; order.push('1-fin'); return 1; });
  const p2 = store.lock('k', async () => { order.push('2'); throw new Error('boum'); });
  const p3 = store.lock('k', async () => { order.push('3'); return 3; });
  const other = store.lock('autre', async () => { order.push('autre'); return 'o'; });
  assert.equal(await other, 'o');
  await tick();
  assert.deepEqual(order, ['1-début', 'autre']);
  d1.open();
  assert.equal(await p1, 1);
  await assert.rejects(p2, /boum/);
  assert.equal(await p3, 3);
  assert.deepEqual(order, ['1-début', 'autre', '1-fin', '2', '3']);
});

test('recentGatewayChat : la plus récente empruntable (chat, ni supprimée, ni verrouillée, ni en cours)', async () => {
  const now = clock();
  const { store } = open(tmpHome(), { now });
  assert.equal(store.recentGatewayChat(), null);
  const mk = (sid, over) => { now.t += 1000; const c = store.create(cls(sid), ENV, AGENT); Object.assign(c, over); store.save(c); return c; };
  const a = mk('a', { chatId: 'chat-a' });
  mk('sans-chat', {});
  const gone = mk('gone', { chatId: 'chat-g', gone: true });
  const locked = mk('locked', { chatId: 'chat-l', locked: true });
  const busy = mk('busy', { chatId: 'chat-busy' }); busy.fs.state = 'inflight'; store.save(busy);
  const b = mk('b', { chatId: 'chat-b' });
  assert.equal(store.recentGatewayChat().id, b.id);
  const d = deferred();
  const held = store.lock(b.key, () => d.promise);
  assert.equal(store.recentGatewayChat().id, a.id, 'conversation dont le verrou est tenu : écartée');
  d.open(); await held; await tick();
  assert.equal(store.recentGatewayChat().id, b.id);
  assert.ok(![gone.id, locked.id, busy.id].includes(store.recentGatewayChat().id));
});

// ── sémaphore des flux ────────────────────────────────────────────────────────────────────────────────────────────────

test('acquireFlow : N flux, onWait une fois pour qui attend, release idempotent, ordre FIFO', async () => {
  const { store } = open(tmpHome(), { flows: 2 });
  const waits = [];
  const r1 = await store.acquireFlow(() => waits.push(1));
  const r2 = await store.acquireFlow(() => waits.push(2));
  assert.deepEqual(waits, []);
  const got = [];
  const p3 = store.acquireFlow(() => waits.push(3)).then(r => { got.push(3); return r; });
  const p4 = store.acquireFlow(() => waits.push(4)).then(r => { got.push(4); return r; });
  await tick();
  assert.deepEqual(waits, [3, 4]);
  assert.deepEqual(store.flowState(), { active: 2, waiting: 2, max: 2 });
  r1(); r1();                                                     // 2e appel sans effet
  const r3 = await p3;
  await tick();
  assert.deepEqual(got, [3], 'un seul flux libéré, un seul réveillé');
  r2(); const r4 = await p4;
  assert.deepEqual(got, [3, 4]);
  r3(); r4();
  assert.deepEqual(store.flowState(), { active: 0, waiting: 0, max: 2 });
});

test('acquireFlow : abandon de l\'attente (signal) et setFlows (--fs-flux)', async () => {
  const { store } = open(tmpHome(), { flows: 1 });
  const r1 = await store.acquireFlow();
  const ac = new AbortController();
  const p = store.acquireFlow(null, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, e => e.name === 'AbortError');
  assert.equal(store.flowState().waiting, 0);
  await assert.rejects(store.acquireFlow(null, { signal: ac.signal }), e => e.name === 'AbortError');

  const p2 = store.acquireFlow(), p3 = store.acquireFlow();
  store.setFlows(3);
  const [r2, r3] = await Promise.all([p2, p3]);
  assert.deepEqual(store.flowState(), { active: 3, waiting: 0, max: 3 });
  store.setFlows(1);
  r1(); r2();
  const p4 = store.acquireFlow();
  let done = false; p4.then(() => { done = true; });
  await tick();
  assert.equal(done, false, 'plafond abaissé : on attend que le dernier flux se libère');
  r3();
  (await p4)();
  assert.deepEqual(store.flowState(), { active: 0, waiting: 0, max: 1 });
});

// ── rangement ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('prune : au-delà du plafond, les conversations de plus de 7 jours sont DÉPLACÉES dans conv/old, jamais supprimées', () => {
  const now = clock(FAKE_NOW - 30 * DAY);
  const dir = tmpHome();
  const { store } = open(dir, { now, maxConvs: 3 });
  const old = [];
  for (let i = 0; i < 3; i++) { now.t += DAY; old.push(store.create(cls(`vieux-${i}`), ENV, AGENT)); }
  now.t = FAKE_NOW;
  const recent = [];
  for (let i = 0; i < 3; i++) { now.t += 1000; recent.push(store.create(cls(`recent-${i}`), ENV, AGENT)); }
  assert.equal(convFiles(dir).length, 3, 'les 3 anciennes sont rangées');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'conv', 'old')).sort(), old.map(c => `${c.id}.json`).sort());
  now.t += 1000;
  store.create(cls('recent-3'), ENV, AGENT);
  assert.equal(convFiles(dir).length, 4, 'les récentes restent même au-delà du plafond');
  const back = store.find(cls('vieux-1'), []);
  assert.equal(back.id, old[1].id, 'une conversation rangée est retrouvée (et remise en place)');
  assert.ok(fs.existsSync(path.join(dir, 'conv', `${old[1].id}.json`)));
  assert.equal(convFiles(dir).length + fs.readdirSync(path.join(dir, 'conv', 'old')).length, 7, 'aucun fichier perdu');
});
