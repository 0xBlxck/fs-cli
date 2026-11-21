// Moteur du CLI : récupération d'après client-tools.md (coupure après acceptation, 409, 400 « missing », > 32 appels)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-resil-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { runNative } = await import('../src/native.js');
const { NOT_RUN, BUSY_MESSAGE, LOST_MESSAGE, alignResults } = await import('../src/resilient.js');
const { detectEnv } = await import('../src/tools.js');
await detectEnv();

const mk = () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const S = { chatId: null, sid: 'abcd', agentId: -2003, cwd: dir, targetDir: null, undo: [], allow: {}, pendingResults: [], notes: [], tokens: { in: 0, out: 0 }, slots: {} };
  return { dir, S };
};
const io = () => ({ signal: new AbortController().signal, ask: async () => 'o', ctxPct: async () => null, reattachDelays: [0, 0, 0], busyDelays: [0, 0, 0] });
const cut = (lastEventId = '7') => Object.assign(new Error('Réseau: flux coupé avant la fin'), { accepted: true, retry: false, lastEventId });
const call = (id, p) => ({ callId: id, name: 'read_file', arguments: JSON.stringify({ path: p }) });

test('coupure après acceptation : rattachement (Last-Event-ID), le message n\'est JAMAIS renvoyé', async () => {
  const { S } = mk();
  const posts = [], resumes = [];
  const stream = async o => { posts.push(o.content); o.onChat?.('chat-r'); o.onText?.('Bonjour '); throw cut('12'); };
  const resume = async (id, last, h) => { resumes.push([id, last]); h.onText('le monde'); return { text: 'le monde', usage: null, toolCalls: [], documents: [] }; };
  const r = await runNative(S, 'salut', { ...io(), stream, resume, fetchChat: async () => null });
  assert.equal(posts.length, 1, 'un seul POST');
  assert.deepEqual(resumes, [['chat-r', '12']]);
  assert.match(S.lastResponse || r?.text || '', /monde/);
});

test('coupure, rattachement impossible : la réponse relue dans le chat porte des appels → ils sont exécutés', async () => {
  const { dir, S } = mk();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'contenu A');
  const posts = [];
  const stream = async o => {
    posts.push({ content: o.content, results: o.toolResults });
    o.onChat?.('chat-h');
    if (posts.length === 1) throw cut();
    return { text: 'fini', usage: null, toolCalls: [], documents: [] };
  };
  const resume = async () => { throw new Error('Réseau: ECONNRESET'); };
  const fetchChat = async () => ({ chatMessages: [{ id: 'u1', role: 'user', content: 'lis a' }, { role: 'assistant', content: 'Je lis.', toolCalls: [call('c1', 'a.txt')] }] });
  await runNative(S, 'lis a', { ...io(), stream, resume, fetchChat });
  assert.equal(posts.length, 2);
  assert.equal(posts[1].content, undefined, 'pas de nouveau message, seulement les résultats');
  assert.equal(posts[1].results[0].callId, 'c1');
  assert.match(posts[1].results[0].output, /contenu A/);
});

test('coupure, rien de récupérable : erreur claire qui propose /continue (pas de renvoi)', async () => {
  const { S } = mk();
  let n = 0;
  const stream = async o => { n++; o.onChat?.('chat-x'); throw cut(); };
  await assert.rejects(runNative(S, 'x', { ...io(), stream, resume: async () => { throw new Error('Réseau'); }, fetchChat: async () => ({ chatMessages: [{ role: 'user', content: 'x' }] }) }),
    e => e.message === LOST_MESSAGE);
  assert.equal(n, 1);
});

test('400 « missing » sur des résultats : recalés sur les appels que FS attend vraiment, chacun une fois', async () => {
  const { dir, S } = mk();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  const posts = [];
  const stream = async o => {
    posts.push(o.toolResults && o.toolResults.map(r => r.callId));
    o.onChat?.('chat-m');
    if (posts.length === 1) return { text: '', usage: null, toolCalls: [call('c1', 'a.txt')], documents: [] };
    if (posts.length === 2) throw Object.assign(new Error('400 missing: c2'), { status: 400 });
    return { text: 'ok', usage: null, toolCalls: [], documents: [] };
  };
  const fetchChat = async () => ({ chatMessages: [{ role: 'assistant', toolCalls: [{ callId: 'c1' }, { callId: 'c2' }] }] });
  await runNative(S, 'lis', { ...io(), stream, resume: async () => { throw new Error('non'); }, fetchChat });
  assert.deepEqual(posts, [undefined, ['c1'], ['c1', 'c2']]);
  assert.deepEqual(alignResults([{ callId: 'c1', output: 'A' }], ['c1', 'c2'])[1], { callId: 'c2', output: NOT_RUN, isError: true });
});

test('409 sur un nouveau message (résumé en cours) : on attend et on réessaie ; toujours occupé → message clair', async () => {
  let { S } = mk();
  let n = 0;
  const busy = () => Object.assign(new Error('409 conflict'), { status: 409 });
  let stream = async o => { n++; if (n < 3) throw busy(); return { text: 'ok', usage: null, toolCalls: [], documents: [] }; };
  await runNative({ ...S, chatId: 'chat-b' }, 'x', { ...io(), stream, resume: async () => null, fetchChat: async () => null });
  assert.equal(n, 3);
  ({ S } = mk());
  stream = async () => { throw busy(); };
  await assert.rejects(runNative({ ...S, chatId: 'chat-b' }, 'x', { ...io(), stream, resume: async () => null, fetchChat: async () => null }), e => e.message === BUSY_MESSAGE);
});

test('plus de 32 appels dans un tour : chacun reçoit une réponse (les suivants « non exécuté »), jamais de 400 « missing »', async () => {
  const { dir, S } = mk();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  const posts = [];
  const calls = Array.from({ length: 34 }, (_, i) => call('k' + i, 'a.txt'));
  const stream = async o => {
    posts.push({ results: o.toolResults, content: o.content });
    o.onChat?.('chat-32');
    return posts.length === 1 ? { text: '', usage: null, toolCalls: calls, documents: [] } : { text: 'ok', usage: null, toolCalls: [], documents: [] };
  };
  await runNative(S, 'beaucoup', { ...io(), stream });
  // vu en vrai : > 32 toolResults refusés ET réponse exigée pour chaque appel → message normal avec les 34 résultats en texte
  assert.equal(posts[1].results, undefined);
  assert.match(posts[1].content, /ONT TOUS été exécutés/);
  assert.equal((posts[1].content.match(/^### \d+\. read_file a\.txt/gm) || []).length, 34);
  assert.match(posts[1].content, /### 33\. read_file a\.txt\n\s*1\tA/, 'résultat au-delà du 32e bien transmis');
});

test('exactement 32 appels : toolResults normaux (limite incluse)', async () => {
  const { dir, S } = mk();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  const posts = [];
  const calls = Array.from({ length: 32 }, (_, i) => call('k' + i, 'a.txt'));
  const stream = async o => { posts.push(o.toolResults); o.onChat?.('c'); return posts.length === 1 ? { text: '', usage: null, toolCalls: calls, documents: [] } : { text: 'ok', usage: null, toolCalls: [], documents: [] }; };
  await runNative(S, 'x', { ...io(), stream });
  assert.equal(posts[1].length, 32);
});

test('vu en vrai : FS répond 200 puis « 409 CONFLICT » / « 400 BAD_REQUEST … pending » dans le flux, sans rien enregistrer → statut rendu, requête refusée', async () => {
  const { createSseReader } = await import('../src/api.js');
  const { errorKind } = await import('../src/gateway/recover.js');
  const read = (msg, before = '') => {
    const r = createSseReader({});
    r.push(before + 'id: 1\ndata: ' + JSON.stringify({ type: 'error', message: msg, code: 'STREAM_FAILED', retryable: false }) + '\n\n');
    r.end();
    try { r.result(); } catch (e) { return e; }
    return null;
  };
  let e = read('409 CONFLICT "No client tool call is waiting for a result in this chat."');
  assert.deepEqual([e.status, e.rejected, errorKind(e)], [409, true, 'reconcile']);
  e = read('400 BAD_REQUEST "toolResults must answer every pending call exactly once (missing: call_1)"');
  assert.deepEqual([e.status, e.rejected, errorKind(e)], [400, true, 'reconcile']);
  e = read('Erreur interne du fournisseur');
  assert.equal(e.rejected, undefined, 'une vraie erreur de génération reste une erreur après acceptation');
});

test('MCP évoqué sans nom de serveur (« tu vois mes mcp ? ») → la liste des serveurs configurés est jointe ; serveur nommé → pas de liste', async () => {
  const { mcpListNote } = await import('../src/pseudo.js');
  const { dir } = mk();
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { leboncoin: { command: 'node', args: ['x.js'] }, blender: { command: 'uvx', args: ['b'] }, off: { command: 'x', disabled: true } } }));
  const n = mcpListNote(dir, 'pourquoi tu vois pas mes mcp ?');
  assert.equal(n.count, 2);
  assert.match(n.text, /leboncoin, blender/);
  assert.doesNotMatch(n.text, /\boff\b/);
  assert.equal(mcpListNote(dir, 'utilise le mcp leboncoin pour chercher'), null, 'serveur nommé : ses outils sont joints, pas la liste');
  assert.equal(mcpListNote(dir, 'corrige le bug du login'), null, 'MCP non évoqué : rien');
});
