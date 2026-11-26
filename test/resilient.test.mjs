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

test('document du site sans nom de fichier (vu sur Discord avec GPT-6.2 Sol) : copie écrite en local sous un nom tiré du titre, jamais par-dessus un fichier', async () => {
  const { fallbackDocumentName } = await import('../src/native.js');
  const { dir, S } = mk();
  const rust = { title: 'Arcade Deck — prototype Rust/Bevy pour Windows', kind: 'code', content: 'use bevy::prelude::*;\nfn main() {}\n' };
  assert.equal(fallbackDocumentName(rust, dir), 'arcade-deck-prototype-rust-bevy-pour-windows.rs');
  assert.equal(fallbackDocumentName({ title: 'Plan du jeu', kind: 'text', content: '# Plan' }, dir), 'plan-du-jeu.md');
  assert.equal(fallbackDocumentName({ ...rust, update: true }, dir), null, 'mise à jour : pas de nouveau fichier');
  assert.equal(fallbackDocumentName({ title: 'Vide', kind: 'text', content: '  ' }, dir), null);
  fs.writeFileSync(path.join(dir, 'plan-du-jeu.md'), 'à moi');
  assert.equal(fallbackDocumentName({ title: 'Plan du jeu', kind: 'text', content: '# Plan' }, dir), 'plan-du-jeu-2.md', 'jamais par-dessus');

  let n = 0;
  const stream = async o => { n++; o.onChat?.('chat-doc'); return n === 1 ? { text: 'Créé.', usage: null, toolCalls: [], documents: [rust] } : { text: 'ok', usage: null, toolCalls: [], documents: [] }; };
  await runNative(S, 'fais un prototype rust', { ...io(), stream });
  assert.equal(fs.readFileSync(path.join(dir, 'arcade-deck-prototype-rust-bevy-pour-windows.rs'), 'utf8'), rust.content);
  assert.equal(fs.readFileSync(path.join(dir, 'plan-du-jeu.md'), 'utf8'), 'à moi');
  assert.ok(S.notes.some(x => /arcade-deck-prototype-rust-bevy-pour-windows\.rs[\s\S]*crée chacun d'eux à sa place avec write_file/.test(x)), 'le modèle est prévenu');
});

test('commande longue arrêtée par l\'utilisateur : le modèle sait depuis combien de temps elle tournait (vu : « le rendu n\'a pas démarré » après 6 min 30)', async () => {
  const { S } = mk();
  const ac = new AbortController();
  let n = 0;
  const cmd = `node -e "setTimeout(()=>{}, 8000)"`;
  const stream = async o => { n++; o.onChat?.('chat-stop'); return n === 1 ? { text: '', usage: null, toolCalls: [{ callId: 'c1', name: 'run_command', arguments: JSON.stringify({ command: cmd, timeout_seconds: 30 }) }], documents: [] } : { text: 'ok', usage: null, toolCalls: [], documents: [] }; };
  setTimeout(() => ac.abort(), 1500);
  await assert.rejects(runNative(S, 'lance le rendu', { ...io(), signal: ac.signal, stream }), e => e.name === 'AbortError');
  const note = S.notes.find(x => /Avant l'interruption/.test(x)) || '';
  assert.match(note, /run_command « node -e .*» \(arrêtée par l'utilisateur après \d+ s d'exécution, avant la fin\)/);
  assert.match(note, /au lieu de dire qu'elle n'a pas démarré/);
});

test('script Python sans flush : ses lignes arrivent en direct (PYTHONUNBUFFERED), pas toutes à la fin', async t => {
  const { spawnSync } = await import('node:child_process');
  const py = ['python3', 'python'].find(p => { try { return spawnSync(p, ['-c', 'import sys; sys.exit(0)'], { timeout: 10000 }).status === 0; } catch { return false; } });
  if (!py) return t.skip('Python absent');
  const { runShellDirect } = await import('../src/tools.js');
  const ui = await import('../src/ui.js');
  const { dir } = mk();
  fs.writeFileSync(path.join(dir, 'lent.py'), 'import time\nfor i in range(3):\n    print("etape", i)\n    time.sleep(0.8)\n');
  const seen = [];
  const t0 = Date.now();
  ui.attachSink({ event: (type, d) => { if (type === 'toolLive' && /etape/.test(d.line)) seen.push(Date.now() - t0); }, print() {} });
  try { await runShellDirect(`${py} lent.py`, { cwd: dir, signal: new AbortController().signal }); } finally { ui.attachSink(null); }
  assert.equal(seen.length, 3);
  assert.ok(seen[2] - seen[0] > 1000, `lignes reçues au fil de l'eau (écarts : ${seen.join(', ')} ms), pas d'un bloc à la fin`);
});

test('pare-feu sur la demande (vu sur Discord, en boucle) : petite requête sans contenu → contenu bloqué : renvoyée sans le contexte joint ; réseau bloqué : message clair', async () => {
  const { firewallProbe, FIREWALL_CONTENT, FIREWALL_NETWORK } = await import('../src/api.js');
  assert.equal(await firewallProbe(async () => ({ status: 200, data: {} })), 'ok');
  assert.equal(await firewallProbe(async () => ({ status: 401, data: { error: 'x' } })), 'ok', 'le serveur répond : le réseau passe');
  assert.equal(await firewallProbe(async () => ({ status: 403, data: null })), 'blocked', 'page HTML de Cloudflare');
  assert.equal(await firewallProbe(async () => ({ status: 0 })), 'unreachable');

  const fw = () => Object.assign(new Error('403 — pare-feu'), { status: 403, code: 'FIREWALL' });
  // contenu : la 3e tentative part sans le contexte joint, et passe
  let { S } = mk();
  const sent = [];
  let stream = async o => { sent.push(o.content); o.onChat?.('c'); if (sent.length <= 2) throw fw(); return { text: 'ok', usage: null, toolCalls: [], documents: [] }; };
  await runNative(S, '[Contexte du projet : FSCLI.md…]\n\nfais le build', { ...io(), stream, firewallDelayMs: 0, probe: async () => 'ok', bare: 'fais le build' });
  assert.equal(sent.length, 3);
  assert.match(sent[0], /Contexte du projet/);
  assert.equal(sent[2], 'fais le build', 'renvoyée seule');
  // contenu, déjà sans contexte : message qui explique quoi changer
  ({ S } = mk());
  stream = async () => { throw fw(); };
  await assert.rejects(runNative(S, 'SELECT * FROM users', { ...io(), stream, firewallDelayMs: 0, probe: async () => 'ok', bare: 'SELECT * FROM users' }), e => e.message === FIREWALL_CONTENT);
  // réseau : rien à renvoyer, message réseau
  ({ S } = mk());
  let n = 0;
  stream = async () => { n++; throw fw(); };
  await assert.rejects(runNative(S, 'x', { ...io(), stream, firewallDelayMs: 0, probe: async () => 'blocked', bare: 'x' }), e => e.message === FIREWALL_NETWORK);
  assert.equal(n, 2, 'pas de 3e envoi quand c\'est le réseau');
});
