// Moteur natif (outils client officiels de FS) avec un FAUX serveur : traduction des appels, exécution, garde-fous, résultats renvoyés
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-native-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { runNative, mapCall } = await import('../src/native.js');
const { detectEnv } = await import('../src/tools.js');
const { cfg } = await import('../src/config.js');
await detectEnv();

/** faux serveur FS : joue un scénario (liste de tours) ; chaque tour renvoie du texte et/ou des appels d'outils */
function fakeFs(turns) {
  const st = { reqs: [], i: 0 };
  const stream = async (o) => {
    st.reqs.push({ chatId: o.chatId, content: o.content, toolResults: o.toolResults, clientTools: o.clientTools });
    if (!o.chatId) o.onChat?.('chat-1');
    const t = turns[st.i++] || { text: 'fin' };
    if (t.text) o.onText?.(t.text);
    return { text: t.text || '', usage: null, toolCalls: t.calls || [] };
  };
  return { st, stream };
}
const mk = (over = {}) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const S = { chatId: null, sid: 'abcd', agentId: -2003, cwd: dir, targetDir: null, undo: [], allow: {}, pendingResults: [], notes: [], tokens: { in: 0, out: 0 }, slots: {}, ...over };
  return { dir, S };
};
const io = (ask = async () => 'o') => ({ signal: new AbortController().signal, ask, ctxPct: async () => null });

test('mapCall : noms et arguments traduits', () => {
  assert.deepEqual(mapCall('list_directory', { path: '.', depth: 2 }), { name: 'list_dir', args: { path: '.', depth: 2 } });
  assert.deepEqual(mapCall('read_file', { path: 'a.js', start_line: 10, end_line: 19 }).args, { path: 'a.js', offset: 10, limit: 10 });
  assert.equal(mapCall('search_files', { query: 'foo', glob: '*.js' }).name, 'grep');
  assert.deepEqual(mapCall('edit_file', { path: 'a', old_text: 'x', new_text: 'y', replace_all: true }).args, { path: 'a', old_string: 'x', new_string: 'y', replace_all: true });
  assert.equal(mapCall('run_command', { command: 'dir', timeout_seconds: 5 }).args.timeout, 5);
  assert.equal(mapCall('inconnu', {}), null);
});

test('boucle complète : écrire, lire, chercher, lancer une commande — résultats renvoyés avec les bons callId', async () => {
  const { dir, S } = mk();
  const f = fakeFs([
    { text: 'Je crée le fichier.', calls: [{ callId: 'c1', name: 'write_file', arguments: { path: 'hello.txt', content: 'Bonjour natif\n' } }] },
    { calls: [{ callId: 'c2', name: 'read_file', arguments: { path: 'hello.txt' } }, { callId: 'c3', name: 'search_files', arguments: { query: 'natif' } }, { callId: 'c4', name: 'list_directory', arguments: { path: '.' } }] },
    { calls: [{ callId: 'c5', name: 'run_command', arguments: { command: 'cat hello.txt' } }] },
    { text: 'Terminé : hello.txt contient « Bonjour natif ».' },
  ]);
  await runNative(S, 'crée hello.txt puis vérifie', { ...io(), stream: f.stream });
  assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'Bonjour natif\n');
  assert.equal(f.st.reqs.length, 4);
  assert.ok(f.st.reqs[0].content.startsWith('[abcd] '), 'étiquette sur le 1er message');
  assert.deepEqual(f.st.reqs[0].clientTools, ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file', 'run_command']);
  assert.equal(S.chatId, 'chat-1'); assert.ok(f.st.reqs.slice(1).every(r => r.chatId === 'chat-1' && !r.content), 'les suites ne renvoient que des toolResults');
  const r2 = f.st.reqs[2].toolResults;
  assert.deepEqual(r2.map(r => r.callId), ['c2', 'c3', 'c4']);                       // un résultat par appel, même ordre
  assert.match(r2[0].output, /Bonjour natif/); assert.match(r2[1].output, /hello\.txt:1:/); assert.match(r2[2].output, /hello\.txt/);
  assert.ok(r2.every(r => r.isError === false));
  assert.match(f.st.reqs[3].toolResults[0].output, /Bonjour natif/);
});

test('erreurs : outil inconnu, fichier absent, texte à éditer introuvable → isError', async () => {
  const { S } = mk();
  const f = fakeFs([
    { calls: [{ callId: 'a', name: 'delete_everything', arguments: {} }, { callId: 'b', name: 'read_file', arguments: { path: 'nope.txt' } }, { callId: 'c', name: 'edit_file', arguments: { path: 'nope.txt', old_text: 'x', new_text: 'y' } }] },
    { text: 'ok' },
  ]);
  await runNative(S, 'test', { ...io(), stream: f.stream });
  const r = f.st.reqs[1].toolResults;
  assert.deepEqual(r.map(x => x.callId), ['a', 'b', 'c']); assert.ok(r.every(x => x.isError === true));
  assert.match(r[0].output, /inconnu/i);
});

test('garde-fous : commande interdite refusée, suppression → menu (refus = isError), secret → confirmation', { skip: process.platform !== 'win32' && 'commandes PowerShell (Windows)' }, async () => {
  const { dir, S } = mk();
  fs.writeFileSync(path.join(dir, 'x.txt'), 'garde-moi');
  const asked = [];
  const ask = async q => { asked.push(q); return 'n'; };                          // l'utilisateur refuse tout
  const secret = 'const K = "sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";'; // scan-ignore
  const f = fakeFs([
    { calls: [
      { callId: '1', name: 'run_command', arguments: { command: 'Format-Volume -DriveLetter D' } },
      { callId: '2', name: 'run_command', arguments: { command: 'Remove-Item .\\x.txt' } },
      { callId: '3', name: 'write_file', arguments: { path: 'k.js', content: secret } },
    ] },
    { text: 'ok' },
  ]);
  await runNative(S, 'test', { ...io(ask), stream: f.stream });
  const r = f.st.reqs[1].toolResults;
  assert.ok(r.every(x => x.isError), 'les trois sont des erreurs');
  assert.match(r[0].output, /politique de sécurité/);
  assert.match(r[1].output, /refus/i);
  assert.ok(fs.existsSync(path.join(dir, 'x.txt')), 'x.txt conservé'); assert.ok(!fs.existsSync(path.join(dir, 'k.js')), 'secret non écrit');
});

test('workspace : un chemin hors du dossier de travail demande confirmation', async () => {
  const { dir, S } = mk();
  const outside = path.join(tmp, 'dehors.txt'); fs.writeFileSync(outside, 'secret perso');
  let asks = 0;
  const f = fakeFs([{ calls: [{ callId: 'z', name: 'read_file', arguments: { path: outside } }] }, { text: 'ok' }]);
  await runNative(S, 'test', { ...io(async () => { asks++; return 'n'; }), stream: f.stream });
  assert.ok(f.st.reqs[1].toolResults[0].isError, 'refusé');
  const g = fakeFs([{ calls: [{ callId: 'y', name: 'read_file', arguments: { path: 'ok.txt' } }] }, { text: 'ok' }]);
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'dedans');
  await runNative(S, 'test', { ...io(async () => { asks++; return 'n'; }), stream: g.stream });
  assert.equal(g.st.reqs[1].toolResults[0].isError, false);
});

test('dossier cible : les chemins relatifs sont résolus dans le workspace cité', async () => {
  const target = fs.mkdtempSync(path.join(tmp, 'cible-'));
  const { dir, S } = mk({ targetDir: target });
  const f = fakeFs([{ calls: [{ callId: 'w', name: 'write_file', arguments: { path: 'sous/a.txt', content: 'x' } }] }, { text: 'ok' }]);
  await runNative(S, 'test', { ...io(), stream: f.stream });
  assert.ok(fs.existsSync(path.join(target, 'sous', 'a.txt'))); assert.deepEqual(fs.readdirSync(dir), []);
});

test('limites FS : résultat tronqué à 40 000 caractères', async () => {
  const { dir, S } = mk();
  fs.writeFileSync(path.join(dir, 'gros.txt'), Array.from({ length: 6000 }, (_, i) => 'ligne numéro ' + i + ' ' + 'x'.repeat(30)).join('\n'));
  const f = fakeFs([{ calls: [{ callId: 'g', name: 'read_file', arguments: { path: 'gros.txt', start_line: 1, end_line: 6000 } }] }, { text: 'ok' }]);
  await runNative(S, 'test', { ...io(), stream: f.stream });
  assert.ok(f.st.reqs[1].toolResults[0].output.length <= 40500);
});

test('interruption : le signal annule la boucle sans renvoyer de résultats', async () => {
  const { S } = mk();
  const ac = new AbortController();
  const f = fakeFs([{ calls: [{ callId: 'q', name: 'list_directory', arguments: { path: '.' } }] }, { text: 'ok' }]);
  const stream = async o => { const r = await f.stream(o); ac.abort(); return r; };
  await assert.rejects(runNative(S, 'test', { signal: ac.signal, ask: async () => 'o', stream, ctxPct: async () => null }), e => e.name === 'AbortError');
  assert.equal(f.st.reqs.length, 1);
});

test('refus d\'outils avec la récupération coupée (refusalRecover=false) : aucune relance, modèle retenu', async () => {
  cfg.refusalRecover = false;
  const { S } = mk({ chatId: 'conv-x', agentId: -1004 });
  const f = fakeFs([{ text: 'Le chat France Student ne peut pas servir de moteur à FS-CLI. Colle ici le contenu de index.html.' }, { text: 'ne doit jamais être demandé' }]);
  await runNative(S, 'améliore mon site', { ...io(), stream: f.stream });
  assert.equal(f.st.reqs.length, 1);                                             // pas d'insistance après un refus de principe
  assert.ok(cfg.toolRefusals['-1004']);                                          // signalé ensuite dans /models et au choix du modèle
  cfg.refusalRecover = true;
});

test('refus d\'outils : 1 précision factuelle, et si le modèle comprend, il travaille', async () => {
  const { dir, S } = mk({ chatId: 'conv-r', agentId: -2002 });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const f = fakeFs([
    { text: 'Je ne peux pas servir de moteur à un outil externe.' },
    { calls: [{ callId: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }] },
    { text: 'Lu.' },
  ]);
  await runNative(S, 'lis a.txt', { ...io(), stream: f.stream });
  assert.equal(f.st.reqs.length, 3);
  assert.match(f.st.reqs[1].content, /outils client officiels de France Student/);
  assert.equal(S.agentId, -2002, 'même modèle');
});

test('refus d\'outils persistant : la même demande repart avec Sonnet, puis s\'arrête (pas de boucle)', async () => {
  const { S } = mk({ chatId: 'conv-s', agentId: -2002 });
  const seen = [];
  const refuse = { text: 'Je ne peux pas servir de moteur à un outil externe.' };
  const f = fakeFs([refuse, refuse, refuse]);
  const stream = async o => { seen.push(o.agentId); return f.stream(o); };
  const r = await runNative(S, 'crée b.txt', { ...io(), stream });
  assert.deepEqual(seen, [-2002, -2002, -2003], 'Haiku, Haiku après précision, puis Sonnet — et rien de plus');
  assert.equal(f.st.reqs[2].content, 'crée b.txt', 'la demande d\'origine, pas la précision');
  assert.equal(S.agentId, -2003);
  assert.equal(r.switchedTo, -2003);
});

test('--max-turns : S.maxSteps limite les étapes de cette exécution (sans toucher à la config)', async () => {
  const { dir, S } = mk({ chatId: 'conv-m', maxSteps: 2 });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const call = { calls: [{ callId: 'c', name: 'read_file', arguments: { path: 'a.txt' } }] };
  const f = fakeFs([call, call, call, call, { text: 'fin' }]);
  const before = cfg.maxSteps;
  const r = await runNative(S, 'boucle', { ...io(), stream: f.stream });
  assert.equal(f.st.reqs.length, 2);
  assert.equal(r.hitLimit, true);
  assert.equal(cfg.maxSteps, before);
});
