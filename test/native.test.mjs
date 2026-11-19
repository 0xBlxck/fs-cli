// Moteur natif (outils client officiels de FS) avec un FAUX serveur : traduction des appels, exécution, garde-fous, résultats renvoyés
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-native-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { runNative, mapCall, documentFileName } = await import('../src/native.js');
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
    return { text: t.text || '', usage: null, toolCalls: t.calls || [], documents: t.documents || [] };
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

// ── « panneau de code » du site (outil serveur createDocument, nov. 2026) : le modèle y met parfois le fichier au lieu d'appeler write_file ──
test('documents du site : un titre de fichier devient un chemin du dossier de travail, le reste non', () => {
  assert.equal(documentFileName({ title: 'carla_env.py' }), 'carla_env.py');
  assert.equal(documentFileName({ title: 'src/app.js' }), 'src/app.js');
  assert.equal(documentFileName({ title: 'Rapport de sécurité' }), null);          // pas un fichier
  assert.equal(documentFileName({ title: '../evil.js' }), null);                    // jamais hors du dossier par ce chemin
  assert.equal(documentFileName({ title: 'C:\\Windows\\x.dll' }), null);
  assert.equal(documentFileName({ title: '/etc/passwd.txt' }), null);
});

test('documents du site : le fichier est écrit À L\'IDENTIQUE (indentation comprise) et le modèle est prévenu ; un document « texte » est seulement montré', async () => {
  const { dir, S } = mk();
  const py = 'class A:\n    def tick(self):\n        while True:\n            try:\n                if self.x:\n                    break\n            except RuntimeError:\n                raise\n';
  const f = fakeFs([{ text: '`carla_env.py` est disponible dans le panneau de code.', documents: [
    { id: 'file-1', title: 'carla_env.py', kind: 'code', content: py },
    { id: 'file-2', title: 'Notes de conception', kind: 'text', content: '# Notes\nrien' },
  ] }]);
  await runNative(S, 'crée carla_env.py', { ...io(), stream: f.stream });
  assert.equal(fs.readFileSync(path.join(dir, 'carla_env.py'), 'utf8'), py);
  assert.ok(!fs.existsSync(path.join(dir, 'Notes de conception')));
  assert.ok(S.undo.length >= 1, 'annulable avec /rewind comme un write_file');
  assert.ok(S.notes.some(n => /carla_env\.py/.test(n) && /write_file/.test(n)));
  assert.ok(S.notes.some(n => /Notes de conception/.test(n)));
});

test('documentsOf : forme réelle renvoyée par France Student (parts « tool-createDocument »)', async () => {
  const { documentsOf } = await import('../src/api.js');
  const parts = [
    { type: 'text', text: 'ok' },
    { type: 'tool-createDocument', toolCallId: 'call_1', state: 'output-available', input: { title: 'a.py', kind: 'code', content: 'if x:\n    y()\n' }, output: { id: 'file-9', title: 'a.py', kind: 'code', content: 'if x:\n    y()\n' } },
    { type: 'tool-updateDocument', toolCallId: 'call_2', state: 'output-available', input: { id: 'file-9', description: 'ajoute z' }, output: { id: 'file-9', title: 'a.py', kind: 'code', content: 'The document has been updated successfully.' } },
    { type: 'tool-createDocument', state: 'output-error', input: { title: 'b.py', content: 'x' } },
  ];
  const d = documentsOf(parts);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], { id: 'file-9', title: 'a.py', kind: 'code', content: 'if x:\n    y()\n', update: false });
  assert.equal(d[1].update, true); assert.equal(d[1].content, null, 'mise à jour sans contenu : rien d\'écrit au hasard');
});

test('documents du site : « index.html — Nébula » devient index.html ; un document MIS À JOUR est relu sur le site puis écrit', async () => {
  assert.equal(documentFileName({ title: 'index.html — Nébula' }), 'index.html');
  assert.equal(documentFileName({ title: 'app.js : serveur' }), 'app.js');
  assert.equal(documentFileName({ title: 'Plan — étape 1' }), null);
  const { dir, S } = mk();
  const f = fakeFs([{ text: 'Mis à jour.', documents: [{ id: 'file-7', title: 'page.html — Accueil', kind: 'code', content: null, update: true }] }]);
  await runNative(S, 'modifie la page', { ...io(), stream: f.stream, readDocument: async id => (id === 'file-7' ? '<p>v2</p>\n' : '') });
  assert.equal(fs.readFileSync(path.join(dir, 'page.html'), 'utf8'), '<p>v2</p>\n');
});

test('GPT refuse dès le 1er message : même demande SEULE dans une conversation neuve (pas de précision dans la conversation refusée)', async () => {
  const { dir, S } = mk({ chatId: null, agentId: -1004 });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const f = fakeFs([
    { text: 'Le chat France Student ne peut pas servir de moteur à un agent externe ou à un IDE.' },
    { calls: [{ callId: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }] },
    { text: 'Lu.' },
  ]);
  const full = 'lis a.txt\n\nPréférences de l\'utilisateur : …\n\nMes guides de travail (skills) …';
  await runNative(S, full, { ...io(), stream: f.stream, bare: 'lis a.txt' });
  assert.equal(f.st.reqs.length, 3);
  assert.equal(f.st.reqs[0].chatId, null);
  assert.equal(f.st.reqs[1].chatId, null, 'nouvel essai dans une conversation NEUVE');
  assert.match(f.st.reqs[1].content, /lis a\.txt$/);
  assert.doesNotMatch(f.st.reqs[1].content, /Préférences|skills|outils client officiels/, 'la demande seule, sans ajout ni précision');
  assert.equal(S.agentId, -1004, 'même modèle');
  assert.equal(S.ctxSent, true, 'cette conversation ne reçoit pas le bloc de contexte');
});

test('refus de Claude au 1er message, ou de GPT plus tard dans la conversation : précision dans la même conversation (comme avant)', async () => {
  const claude = mk({ chatId: null, agentId: -2003 });
  const f1 = fakeFs([{ text: 'Je ne peux pas servir de moteur à un outil externe.' }, { text: 'Compris.' }]);
  await runNative(claude.S, 'demande\n\nPréférences…', { ...io(), stream: f1.stream, bare: 'demande' });
  assert.match(f1.st.reqs[1].content, /outils client officiels de France Student/);
  const gpt = mk({ chatId: 'conv-g', agentId: -1004 });
  const f2 = fakeFs([{ text: 'Je ne peux pas servir de moteur à un outil externe.' }, { text: 'Compris.' }]);
  await runNative(gpt.S, 'suite', { ...io(), stream: f2.stream, bare: 'suite' });
  assert.equal(f2.st.reqs[1].chatId, 'conv-g');
  assert.match(f2.st.reqs[1].content, /outils client officiels de France Student/);
});

test('affichage : citations de la recherche web retirées, listes de tâches collées remises à la ligne (même coupées entre deux morceaux)', async () => {
  const { textCleaner, cleanText } = await import('../src/native.js');
  const c = textCleaner();
  const parts = ['Je pars sur OFFGRID. ', 'citeturn546988', 'search1', 'Fin.\n- [~] Poser une direction.\n- [ ] Livrer le site.', '- ', '[x] Poser une direction.'];
  const out = parts.map(p => c.push(p)).join('') + c.flush();
  assert.doesNotMatch(out, /cite|turn546988|search1|[-]/);
  assert.match(out, /Livrer le site\.\n- \[x\] Poser/);
  assert.equal(cleanText('acitexb.- [ ] c'), 'ab.\n- [ ] c');
  // coupé à n'importe quel endroit (vu en vrai : « aperçu.- [x] Choisir… » restait collé)
  const src = '- [ ] Te livrer le site dans l’aperçu.- [x] Choisir la direction.';
  for (let i = 1; i < src.length; i++) {
    const k = textCleaner();
    const o = k.push(src.slice(0, i)) + k.push(src.slice(i)) + k.flush();
    assert.match(o, /aperçu\.\n- \[x\] Choisir/, `coupure à ${i}`);
  }
});

test('documents du site : « OFFGRID — index.html » → index.html ; page HTML sans nom → index.html (ou un nom tiré du titre)', async () => {
  const { documentFileName, htmlDocumentName } = await import('../src/native.js');
  assert.equal(documentFileName({ title: 'OFFGRID — index.html' }), 'index.html');
  assert.equal(documentFileName({ title: 'ORBIT — Studio créatif' }), null);
  const { dir } = mk();
  assert.equal(htmlDocumentName({ title: 'ORBIT — Studio créatif', kind: 'html', content: '<!DOCTYPE html>' }, dir), 'index.html');
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  assert.equal(htmlDocumentName({ title: 'ORBIT — Studio créatif', kind: 'html', content: '<!DOCTYPE html>' }, dir), 'orbit-studio-creatif.html');
  assert.equal(htmlDocumentName({ title: 'Notes', kind: 'text', content: 'bonjour' }, dir), null);
});

test('erreur d\'OpenAI après la recherche web : la même demande repart une fois sans recherche web, puis plus de web pour la demande', async () => {
  const before = cfg.webSearch; cfg.webSearch = true;
  try {
    const { dir, S } = mk({ agentId: -1004 });
    const reqs = []; let n = 0;
    const stream = async (o) => {
      reqs.push({ web: o.webSearch, content: o.content, toolResults: o.toolResults, chatId: o.chatId });
      if (!o.chatId) o.onChat?.('chat-w');
      n++;
      if (n === 1) { const e = new Error('Erreur du serveur: 502 BAD_GATEWAY "openai_v2 responses request failed: 200: An error occurred while processing your request."'); e.serverError = true; throw e; }
      if (n === 2) return { text: '', usage: null, toolCalls: [{ callId: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>ok</h1>' }) }], documents: [] };
      return { text: 'fini', usage: null, toolCalls: [], documents: [] };
    };
    await runNative(S, 'dev moi un site', { ...io(), stream });
    assert.deepEqual(reqs.map(r => r.web), [true, false, false]);        // 2e essai sans web, et la suite de la demande aussi
    assert.equal(reqs[1].content, reqs[0].content);                      // même demande
    assert.equal(reqs[1].chatId, 'chat-w');                              // dans la conversation déjà ouverte (pas une neuve)
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>ok</h1>');
  } finally { cfg.webSearch = before; }
});

test('erreur d\'OpenAI : sans recherche web, ou erreur qui n\'est pas du serveur → pas de nouvel essai', async () => {
  const before = cfg.webSearch;
  try {
    for (const [web, err] of [[false, Object.assign(new Error('Erreur du serveur: 502 BAD_GATEWAY'), { serverError: true })], [true, new Error('Réponse vide / flux interrompu')]]) {
      cfg.webSearch = web;
      const { S } = mk({ agentId: -1004 });
      let n = 0;
      const stream = async () => { n++; throw err; };
      await assert.rejects(runNative(S, 'x', { ...io(), stream }), err);
      assert.equal(n, 1);
    }
  } finally { cfg.webSearch = before; }
});

test('pare-feu de France Student (403 FIREWALL) : un nouvel essai ; encore bloqué sur des résultats → note « contenu non transmis » (jamais le contenu déguisé)', async () => {
  const { FIREWALL_NOTE } = await import('../src/native.js');
  const fw = () => Object.assign(new Error('403 — le pare-feu de France Student (Cloudflare) a bloqué la requête.'), { status: 403, code: 'FIREWALL' });
  const { dir, S } = mk();
  fs.writeFileSync(path.join(dir, 'secret.txt'), '<script>alert(1)</script> UNION SELECT');
  const reqs = []; let n = 0;
  const stream = async o => {
    reqs.push({ content: o.content, results: o.toolResults && o.toolResults.map(r => ({ ...r })) });
    if (!o.chatId) o.onChat?.('chat-fw');
    n++;
    if (n === 1) throw fw();                                          // passager : le 2e essai passe
    if (n === 2) return { text: '', usage: null, toolCalls: [{ callId: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'secret.txt' }) }], documents: [] };
    if (n === 3 || n === 4) throw fw();                               // les résultats sont refusés deux fois
    return { text: 'fini', usage: null, toolCalls: [], documents: [] };
  };
  await runNative(S, 'lis secret.txt', { ...io(), stream, firewallDelayMs: 0 });
  assert.equal(reqs.length, 5);
  assert.equal(reqs[1].content, reqs[0].content, 'même demande renvoyée');
  assert.match(reqs[2].results[0].output, /UNION SELECT/);
  assert.match(reqs[3].results[0].output, /UNION SELECT/, '2e essai : contenu identique (rien de déguisé)');
  assert.deepEqual(reqs[4].results, [{ callId: 'r1', output: FIREWALL_NOTE, isError: true }]);
});

test('pare-feu : bloqué deux fois sans résultats d\'outils → erreur affichée (pas de note inventée)', async () => {
  const { S } = mk();
  let n = 0;
  const err = Object.assign(new Error('403 — pare-feu'), { status: 403, code: 'FIREWALL' });
  await assert.rejects(runNative(S, 'x', { ...io(), stream: async () => { n++; throw err; }, firewallDelayMs: 0 }), err);
  assert.equal(n, 2);
});
