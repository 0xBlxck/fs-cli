// Tests des aides de test de la passerelle Claude Code (test/gateway-helpers.mjs), des fixtures et de src/gateway/types.js.
// Tout est hors ligne : le faux France Student ne touche aucun réseau.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tmpHome, loadFixture, toolSchema, validateAgainstSchema, parseSse, fakeFs, fsError, deferred, DEFAULT_AGENTS, FAKE_NOW,
} from './gateway-helpers.mjs';

const { KINDS } = await import('../src/gateway/types.js');

// ── FS_CLI_HOME et dossiers temporaires ──

test('FS_CLI_HOME pointe vers un dossier temporaire, jamais vers ~/.fs-cli', () => {
  const home = process.env.FS_CLI_HOME;
  assert.ok(home, 'FS_CLI_HOME doit être défini dès le chargement des aides');
  assert.notEqual(path.resolve(home), path.resolve(os.homedir(), '.fs-cli'));
  assert.ok(fs.existsSync(home));
});

test('tmpHome : dossier neuf à chaque appel ; { env: true } change FS_CLI_HOME', () => {
  const before = process.env.FS_CLI_HOME;
  const a = tmpHome(), b = tmpHome();
  assert.notEqual(a, b);
  assert.ok(fs.statSync(a).isDirectory() && a.startsWith(os.tmpdir()));
  assert.equal(process.env.FS_CLI_HOME, before);
  const c = tmpHome({ env: true });
  assert.equal(process.env.FS_CLI_HOME, c);
  process.env.FS_CLI_HOME = before;
});

// ── types.js ──

test('KINDS : les 14 sortes de requêtes du § 3.1 plus side_question (/btw) et hook_check (/goal), figées et uniques', () => {
  assert.equal(KINDS.length, 16);
  assert.equal(new Set(KINDS).size, 16);
  assert.ok(Object.isFrozen(KINDS));
  for (const k of ['main', 'subagent', 'title', 'name', 'probe', 'suggestion', 'compact', 'away_summary', 'agent_summary',
    'tool_summary', 'bash_prefix', 'web_search', 'web_fetch', 'side_question', 'hook_check', 'background_other']) assert.ok(KINDS.includes(k), k);
});

// ── Fixtures ──

const NAMES = ['req-02', 'req-03', 'req-04', 'req-03-linux'];

test('fixtures : aucune donnée personnelle ni identifiant réel', () => {
  for (const n of NAMES) {
    const t = JSON.stringify(loadFixture(n));
    for (const bad of ['wazer', '8fcbe3de', 'b94c8dbc', '3a2dbff1', '7b8586aa', 'cc-work', 'cc-config', '# auto memory', 'userEmail'])
      assert.ok(!t.includes(bad), `${n} contient « ${bad} »`);
    const mails = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).filter(m => !/@example\.com$/.test(m));
    assert.deepEqual(mails, [], `${n} : e-mail inattendu`);
    assert.doesNotMatch(t, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, `${n} : UUID (refusé par scripts/scan.mjs)`);
  }
});

test('fixtures : ids fictifs et cohérents entre en-tête et metadata', () => {
  for (const n of NAMES) {
    const f = loadFixture(n);
    const u = JSON.parse(f.body.metadata.user_id);
    assert.match(u.device_id, /^[0-9a-f]{64}$/);
    assert.equal(u.account_uuid, '');
    assert.equal(f.headers['x-claude-code-session-id'], u.session_id, n);
    assert.equal(Number(f.headers['content-length']), Buffer.byteLength(JSON.stringify(f.body)), n);
  }
  assert.notEqual(JSON.parse(loadFixture('req-03-linux').body.metadata.user_id).session_id,
    JSON.parse(loadFixture('req-03').body.metadata.user_id).session_id);
});

test('fixtures : forme des requêtes (titre, principale, suite avec tool_result)', () => {
  const r2 = loadFixture('req-02').body;
  assert.deepEqual(r2.tools, []);
  assert.deepEqual(Object.keys(r2.output_config.format.schema.properties), ['title']);
  const r3 = loadFixture('req-03').body;
  assert.ok(r3.tools.length >= 3 && r3.tools.some(t => t.name === 'Read'));
  assert.deepEqual(r3.messages.map(m => m.role), ['user', 'system']);
  const r4 = loadFixture('req-04').body;
  assert.deepEqual(r4.messages.map(m => m.role), ['user', 'system', 'assistant', 'user']);
  assert.deepEqual(r4.messages[2].content[0], { type: 'tool_use', id: 'toolu_capture1', name: 'Read', input: { file_path: 'C:\\proj\\hello.txt' } });
  assert.equal(r4.messages[3].content[0].tool_use_id, 'toolu_capture1');
});

test('fixtures : environnement Windows (C:\\proj) et variante Linux (zsh, espace et accents)', () => {
  const win = loadFixture('req-03').body.system[2].text;
  assert.match(win, /^ - Primary working directory: C:\\proj$/m);
  assert.match(win, /^ - Platform: win32$/m);
  assert.match(win, /^ - Shell: bash$/m);
  assert.match(win, /Is a git repository: false/);
  const lin = loadFixture('req-03-linux');
  const s = lin.body.system[2].text;
  assert.match(s, /^ - Primary working directory: \/home\/user\/mon projet\/été$/m);
  assert.match(s, /^ {2}- \/home\/user\/mon projet\/été$/m);
  assert.match(s, /^ - Platform: linux$/m);
  assert.match(s, /^ - Shell: zsh$/m);
  assert.match(s, /^ - OS Version: Linux /m);
  assert.equal(lin.headers['x-stainless-os'], 'Linux');
  assert.ok(!JSON.stringify(lin).includes('C:\\\\proj') && !JSON.stringify(lin).includes('C:/proj'));
  assert.ok(!lin.body.tools.find(t => t.name === 'Bash').description.includes('Git Bash'));
});

test('loadFixture : copie neuve à chaque appel, extension facultative', () => {
  const a = loadFixture('req-02'); a.body.model = 'modifié';
  assert.equal(loadFixture('req-02.json').body.model, 'claude-sonnet-5-5');
  assert.throws(() => loadFixture('inexistant'));
});

// ── validateAgainstSchema ──

test('validateAgainstSchema : entrées valides des outils de req-03', () => {
  assert.deepEqual(validateAgainstSchema({ file_path: 'C:\\proj\\a.js', offset: 10, limit: 5 }, toolSchema('Read')), []);
  assert.deepEqual(validateAgainstSchema({ pattern: 'foo', output_mode: 'content', '-n': true, head_limit: 100 }, toolSchema('Grep')), []);
  assert.deepEqual(validateAgainstSchema({ command: 'ls -la', timeout: 1500.5, description: 'Lister' }, toolSchema('Bash')), []);
  assert.deepEqual(validateAgainstSchema({ file_path: 'a', old_string: 'x', new_string: 'y', replace_all: true }, toolSchema('Edit')), []);
});

test('validateAgainstSchema : requis, type, enum, additionalProperties, undefined', () => {
  const read = toolSchema('Read');
  assert.match(validateAgainstSchema({}, read).join(), /file_path : requis/);
  assert.match(validateAgainstSchema({ file_path: 'a', path: 'b' }, read).join(), /path : propriété non autorisée/);
  assert.match(validateAgainstSchema({ file_path: 'a', offset: undefined }, read).join(), /offset : undefined/);
  assert.match(validateAgainstSchema({ file_path: 'a', offset: 1.5 }, read).join(), /type number au lieu de integer/);
  assert.match(validateAgainstSchema({ file_path: 'a', limit: 0 }, read).join(), /exclusiveMinimum/);
  assert.match(validateAgainstSchema({ file_path: null }, read).join(), /type null au lieu de string/);
  assert.match(validateAgainstSchema({ pattern: 'x', output_mode: 'tout' }, toolSchema('Grep')).join(), /hors de l'enum/);
  assert.match(validateAgainstSchema({ command: 'x', timeout: '5' }, toolSchema('Bash')).join(), /type string au lieu de number/);
  assert.match(validateAgainstSchema({ command: 'x', timeout: NaN }, toolSchema('Bash')).join(), /non fini/);
  assert.match(validateAgainstSchema('texte', read).join(), /type string au lieu de object/);
});

test('validateAgainstSchema : undefined détecté même sans schéma détaillé, tableaux et anyOf', () => {
  assert.match(validateAgainstSchema({ a: { b: [1, undefined] } }, {}).join(), /input\.a\.b\[1\] : undefined/);
  const s = { type: 'array', items: { type: 'string' }, maxItems: 2 };
  assert.deepEqual(validateAgainstSchema(['a', 'b'], s), []);
  assert.equal(validateAgainstSchema(['a', 1, 'c'], s).length, 2);
  const any = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  assert.deepEqual(validateAgainstSchema(3, any), []);
  assert.match(validateAgainstSchema(true, any).join(), /anyOf/);
  assert.match(validateAgainstSchema({ f() {} }, {}).join(), /non sérialisable/);
});

// ── parseSse ──

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } });
const textBlock = (i, ...parts) => ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
  + parts.map(t => ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: t } })).join('')
  + ev('content_block_stop', { index: i });
const toolBlock = (i, id, name, input) => ev('content_block_start', { index: i, content_block: { type: 'tool_use', id, name, input: {} } })
  + ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(0, 5) } })
  + ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(5) } })
  + ev('content_block_stop', { index: i });
const end = (stop, out = 7) => ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: 42, output_tokens: out } }) + ev('message_stop', {});

test('parseSse : texte puis tool_use, pings, usage fusionné', () => {
  const s = start + ev('ping', {}) + textBlock(0, 'Je lis ', 'le fichier.') + toolBlock(1, 'toolu_abc-1_Z', 'Read', { file_path: 'C:\\proj\\a.js' }) + ev('ping', {}) + end('tool_use');
  const r = parseSse(s);
  assert.equal(r.text, 'Je lis le fichier.');
  assert.deepEqual(r.toolUses, [{ type: 'tool_use', id: 'toolu_abc-1_Z', name: 'Read', input: { file_path: 'C:\\proj\\a.js' } }]);
  assert.equal(r.pings, 2);
  assert.equal(r.message.stop_reason, 'tool_use');
  assert.deepEqual(r.message.usage, { input_tokens: 42, output_tokens: 7 });
  assert.equal(r.events[0].event, 'message_start');
  assert.equal(r.error, null);
});

test('parseSse : CRLF, commentaires et event error acceptés ; flux partiel sur demande', () => {
  assert.equal(parseSse((start + textBlock(0, 'ok') + end('end_turn')).replace(/\n/g, '\r\n') + ': fin\n\n').text, 'ok');
  const e = parseSse(ev('error', { error: { type: 'overloaded_error', message: 'occupé' } }));
  assert.deepEqual(e.error, { type: 'overloaded_error', message: 'occupé' });
  assert.equal(e.message, null);
  assert.equal(parseSse(start + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), { partial: true }).message.content.length, 1);
});

test('parseSse : rejette les flux non conformes', () => {
  const bad = {
    'sans message_stop': start + textBlock(0, 'x'),
    'index sauté': start + ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    'delta hors bloc': start + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }),
    'deux blocs ouverts': start + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    'partial_json invalide': start + ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } })
      + ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }) + ev('content_block_stop', { index: 0 }) + end('tool_use'),
    'id tool_use invalide': start + toolBlock(0, 'toolu_a|b', 'Read', {}) + end('tool_use'),
    'event ≠ data.type': start + 'event: ping\ndata: {"type":"message_stop"}\n\n',
    'stop_reason incohérent': start + toolBlock(0, 'toolu_1', 'Read', { file_path: 'a' }) + end('end_turn'),
    'tool_use annoncé sans outil': start + textBlock(0, 'x') + end('tool_use'),
    'événement après message_stop': start + textBlock(0, 'x') + end('end_turn') + ev('ping', {}),
    'message_start en double': start + start,
    'data non JSON': 'event: ping\ndata: {oups\n\n',
    'dernier bloc non terminé': start + 'event: ping\ndata: {"type":"ping"}',
    'bloc thinking': start + ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    'stop_reason inconnu': start + textBlock(0, 'x') + end('fini'),
  };
  for (const [why, s] of Object.entries(bad)) assert.throws(() => parseSse(s), /SSE invalide/, why);
});

// ── fakeFs ──

test('fakeFs : 13 dépendances injectables, chacune avec son journal d\'appels', () => {
  const f = fakeFs();
  const names = ['stream', 'resume', 'fetchChat', 'searchChats', 'compactChat', 'uploadFile', 'cancelStream', 'fetchAgentsFull', 'createdToday', 'quota', 'fsExists', 'fsStat', 'now'];
  assert.deepEqual(Object.keys(f.deps).sort(), [...names].sort());
  for (const n of names) { assert.equal(typeof f.deps[n], 'function'); assert.equal(f[n].calls, f.calls[n]); }
});

test('fakeFs : nouveau chat, texte en deltas, ordre des rappels, corps enregistré sans rappels', async () => {
  const f = fakeFs({ turns: ['Bonjour, je regarde.'] });
  const log = [];
  const r = await f.deps.stream({
    agentId: -2003, chatId: null, content: '[ab12·cc] lis a.js', clientTools: ['read_file'], webSearch: false, register: { sid: 'ab12', role: 'cc' },
    signal: new AbortController().signal,
    onAccepted: () => log.push('accepted'), onChat: id => log.push('chat:' + id), onUserMessageId: id => log.push('um:' + id),
    onEventId: id => log.push('id:' + id), onText: d => log.push('t:' + d),
  });
  assert.deepEqual(log, ['accepted', 'chat:chat-1', 'um:msg-1', 'id:1', 't:Bonjour, ', 'id:2', 't:je ', 'id:3', 't:regarde.', 'id:4']);
  assert.equal(r.text, 'Bonjour, je regarde.');
  assert.equal(r.chatId, 'chat-1');
  assert.deepEqual(r.toolCalls, []);
  assert.deepEqual(f.sent, [{ agentId: -2003, chatId: null, content: '[ab12·cc] lis a.js', clientTools: ['read_file'], webSearch: false, register: { sid: 'ab12', role: 'cc' } }]);
  assert.equal(f.registered.length, 1);
  assert.equal(f.created, 1);
  assert.equal(f.deps.createdToday(), 1);
});

test('fakeFs : appels d\'outils et documents, visibles ensuite dans fetchChat', async () => {
  const calls = [{ callId: 'call_1', name: 'read_file', arguments: { path: 'a.js' } }];
  const f = fakeFs({ turns: [{ text: 'Je lis.', toolCalls: calls, documents: [{ id: 'file-9', title: 'Plan', kind: 'text', content: '# Plan', update: false }] }, 'Fini.'] });
  const r = await f.stream({ agentId: -2003, chatId: null, content: 'x' });
  assert.deepEqual(r.toolCalls, calls);
  assert.equal(r.documents[0].title, 'Plan');
  let chat = await f.fetchChat('chat-1');
  const last = chat.chatMessages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.deepEqual(last.toolCalls, calls);
  assert.equal(last.parts[0].type, 'tool-createDocument');
  assert.equal(last.parts[0].input.content, '# Plan');
  await f.stream({ agentId: -2003, chatId: 'chat-1', toolResults: [{ callId: 'call_1', output: '1: x', isError: false }] });
  chat = await f.fetchChat('chat-1');
  assert.deepEqual(chat.chatMessages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(chat.chatMessages[2].toolResults, [{ callId: 'call_1', output: '1: x', isError: false }]);
  assert.equal(f.created, 1, 'un message dans un chat existant ne crée pas de conversation');
  assert.equal(await f.fetchChat('inconnu'), null);
});

test('fakeFs : erreur AVANT acceptation (pas de onAccepted, accepted:false)', async () => {
  for (const [spec, status, code] of [['auth', 401], ['native', 403, 'NATIVE_UNSUPPORTED'], [409, 409], [{ status: 400, body: 'missing: call_1' }, 400]]) {
    const f = fakeFs({ turns: [{ fail: spec }] });
    let accepted = false;
    const e = await f.stream({ chatId: 'c', content: 'x', onAccepted: () => { accepted = true; } }).catch(x => x);
    assert.equal(e.accepted, false);
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    assert.equal(accepted, false);
  }
  const e = fsError({ status: 400, body: 'missing: call_1' });
  assert.match(e.message, /HTTP 400: missing: call_1/);
  assert.equal(fsError('busy').retry, true);
  assert.equal(fsError('busy', { accepted: true }).retry, false);
});

test('fakeFs : limite quotidienne simulée pour les nouveaux chats seulement', async () => {
  const f = fakeFs({ created: 50, turns: ['a', 'b'] });
  const e = await f.stream({ chatId: null, content: 'x' }).catch(x => x);
  assert.equal(e.code, 'DAILY_CHAT_LIMIT');
  assert.equal(e.status, 429);
  assert.equal(e.accepted, false);
  assert.equal((await f.stream({ chatId: 'existant', content: 'x' })).text, 'b');
  const q = f.quota();
  assert.equal(q.remaining, 0);
  assert.equal(q.limitHit, true);
  assert.equal(typeof q.resetText, 'string');
});

test('fakeFs : coupure après acceptation puis resume avec Last-Event-ID, sans doublon', async () => {
  const f = fakeFs({ turns: [{ text: 'un deux trois quatre', cut: 2, toolCalls: [{ callId: 'call_9', name: 'read_file', arguments: { path: 'b' } }] }] });
  let got = '', lastId = null;
  const h = { onText: d => { got += d; }, onEventId: id => { lastId = id; } };
  const e = await f.stream({ chatId: null, content: 'x', ...h }).catch(x => x);
  assert.equal(e.accepted, true);
  assert.equal(e.retry, false);
  assert.equal(got, 'un deux ');
  assert.equal(lastId, '2');
  const r = await f.resume('chat-1', lastId, h);
  assert.equal(got, 'un deux trois quatre');
  assert.equal(r.text, 'trois quatre');
  assert.deepEqual(r.toolCalls, [{ callId: 'call_9', name: 'read_file', arguments: { path: 'b' } }]);
  assert.deepEqual(f.calls.resume, [{ chatId: 'chat-1', lastEventId: '2' }]);
  assert.equal(f.calls.stream.length, 1);
});

test('fakeFs : resume impossible, user orphelin, erreur SSE et fetchChat scénarisé', async () => {
  const f = fakeFs({ turns: [{ text: 'abc def', cut: 1, persisted: 'user' }, { text: 'x y', sseError: { code: 'STREAM_LEASE_LOST', retryable: true, after: 1 } }], resumes: ['fail'] });
  await f.stream({ chatId: null, content: 'q' }).catch(() => {});
  await assert.rejects(f.resume('chat-1', '1'), e => e.message.includes('Réseau'));
  await assert.rejects(f.resume('chat-1', '1'), e => e.status === 404);
  assert.equal((await f.fetchChat('chat-1')).chatMessages.at(-1).role, 'user');
  const e = await f.stream({ chatId: 'chat-1', content: 'q2' }).catch(x => x);
  assert.equal(e.accepted, true);
  assert.equal(e.code, 'STREAM_LEASE_LOST');
  assert.equal(e.retryable, true);
  const g = fakeFs({ chats: { c1: { id: 'c1', chatMessages: [{ role: 'assistant', content: 'ok' }] } } });
  assert.equal((await g.fetchChat('c1')).chatMessages[0].content, 'ok');
});

test('fakeFs : génération tenue (hold) puis relâchée ; annulation par signal', async () => {
  const gate = deferred();
  const f = fakeFs({ turns: [{ text: 'a b', hold: gate.promise }, { text: 'long', hold: 60000 }] });
  let done = false;
  const p = f.stream({ chatId: 'c', content: 'x' }).then(r => { done = true; return r; });
  await new Promise(r => setImmediate(r));
  assert.equal(done, false);
  gate.open();
  assert.equal((await p).text, 'a b');
  const ac = new AbortController();
  const q = f.stream({ chatId: 'c', content: 'y', signal: ac.signal });
  setImmediate(() => ac.abort());
  await assert.rejects(q, e => e.name === 'AbortError' && e.accepted === true);
});

test('fakeFs : scénario dynamique, tour par défaut, scénario épuisé', async () => {
  const f = fakeFs({ turns: [(send, n) => `réponse ${n} à ${send.content}`] });
  assert.equal((await f.stream({ chatId: 'c', content: 'salut' })).text, 'réponse 0 à salut');
  const e = await f.stream({ chatId: 'c', content: 'encore' }).catch(x => x);
  assert.equal(e.code, 'FAKE_EXHAUSTED');
  assert.equal(f.errors.length, 1);
  const g = fakeFs({ default: 'fin' });
  assert.equal((await g.stream({ chatId: 'c', content: '1' })).text, 'fin');
  assert.equal((await g.stream({ chatId: 'c', content: '2' })).text, 'fin');
});

test('fakeFs : searchChats par étiquette, compactChat, uploadFile, cancelStream, agents', async () => {
  const f = fakeFs({ turns: ['ok'], compact: 422 });
  await f.stream({ chatId: null, content: '[ab12·cc] Contexte : dossier C:\\proj' });
  assert.deepEqual(await f.searchChats('[ab12·cc]'), [{ id: 'chat-1', title: '[ab12·cc] Contexte : dossier C:\\proj' }]);
  assert.deepEqual(await f.searchChats('[ffff·cc]'), []);
  assert.deepEqual(await f.compactChat('chat-1'), { status: 422 });
  assert.equal(await f.uploadFile(Buffer.from('png'), 'a.png', 'image/png'), 'file-1');
  assert.equal(await f.uploadFile(Buffer.from('png'), 'b.png', 'image/png'), 'file-2');
  assert.deepEqual(f.calls.uploadFile[0], { filename: 'a.png', mime: 'image/png', size: 3 });
  assert.equal(await f.cancelStream('chat-1'), true);
  assert.deepEqual(f.calls.cancelStream, [{ chatId: 'chat-1' }]);
  const agents = await f.fetchAgentsFull();
  assert.deepEqual(agents.map(a => a.id), DEFAULT_AGENTS.map(a => a.id));
  agents[0].name = 'modifié';
  assert.equal(DEFAULT_AGENTS[0].name, 'Claude Opus 5.5');
  assert.equal(await fakeFs({ agents: null }).fetchAgentsFull(), null);
  assert.equal((await fakeFs({ search: [{ id: 'z' }] }).searchChats('q')).length, 1);
});

test('fakeFs : fsExists / fsStat (Windows insensible à la casse et aux barres, POSIX, dossiers implicites)', () => {
  const f = fakeFs({ files: { 'C:\\proj\\src\\a.js': 'abc', '/srv/mon projet/été/b.txt': 'é' }, dirs: ['C:\\proj\\vide'] });
  assert.equal(f.fsExists('c:/proj/src/a.js'), true);
  assert.equal(f.fsStat('C:\\PROJ\\src\\a.js').isFile(), true);
  assert.equal(f.fsStat('C:\\proj\\src\\a.js').size, 3);
  assert.equal(f.fsStat('C:\\proj\\src').isDirectory(), true);
  assert.equal(f.fsStat('C:\\proj\\src\\').isDirectory(), true);
  assert.equal(f.fsStat('C:\\proj\\vide').isDirectory(), true);
  assert.equal(f.fsStat('C:\\proj\\sr'), null);
  assert.equal(f.fsExists('C:\\proj\\b.js'), false);
  assert.equal(f.fsStat('/srv/mon projet/été/b.txt').size, 2);
  assert.equal(f.fsStat('/srv/mon projet').isDirectory(), true);
  assert.equal(f.fsExists('/SRV/mon projet/été/b.txt'), false, 'POSIX : sensible à la casse');
  f.script.files['C:\\proj\\nouveau.js'] = '';
  assert.equal(f.fsExists('C:\\proj\\nouveau.js'), true);
  assert.equal(f.calls.fsExists.length, 4);
});

test('fakeFs : horloge simulée', () => {
  const f = fakeFs();
  assert.equal(f.now(), FAKE_NOW);
  f.advance(10000);
  assert.equal(f.now(), FAKE_NOW + 10000);
  f.setNow(0);
  assert.equal(f.deps.now(), 0);
  assert.equal(fakeFs({ now: 123 }).now(), 123);
});
