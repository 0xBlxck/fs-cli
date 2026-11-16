// Liste de tâches épinglée, choix automatique des skills, retour en arrière multi-fichiers, mise à jour, intentions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeStreams } from './term-sim.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-feat-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const ui = await import('../src/ui.js');
const { Tui } = await import('../src/tui/tui.js');
const { autoSkills } = await import('../src/discover.js');
const { TOOLS, undoLast } = await import('../src/tools.js');
const { compareVersions } = await import('../src/update.js');
const { detectIntent } = await import('../src/intent.js');
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('liste de tâches : - [ ] / - [~] / - [x] du modèle → ☐ ◐ ☑ et liste courante mise à jour', () => {
  const seen = [];
  ui.tasks.on(l => seen.push(l));
  const md = new ui.MdStream();
  md.push('Mon plan :\n\n- [ ] créer index.html\n- [ ] ajouter le style\n- [ ] tester\n\nJe commence.\n');
  assert.deepEqual(ui.tasks.list.map(t => t.state), ['todo', 'todo', 'todo']);
  md.push('- [x] créer index.html\n\n- [~] ajouter le style\n- [ ] tester\n');
  md.end?.();
  assert.deepEqual(ui.tasks.list.map(t => `${t.state}:${t.text}`), ['done:créer index.html', 'doing:ajouter le style', 'todo:tester']);
  assert.ok(seen.length >= 6);
  const normal = new ui.MdStream(); normal.push('- un point normal\n');            // une liste ordinaire n'est pas une liste de tâches
  assert.deepEqual(ui.tasks.list.map(t => t.state), ['done', 'doing', 'todo']);
  ui.tasks.clear(); assert.deepEqual(ui.tasks.list, []);
});

test('panneau épinglé : « Tâches 1/3 » et les étapes au-dessus de la saisie', () => {
  const f = fakeStreams(70, 24);
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, history: [] });
  tui.start();
  tui.setTasks([{ text: 'créer index.html', state: 'done' }, { text: 'ajouter le style', state: 'doing' }, { text: 'tester', state: 'todo' }]);
  const rows = tui.compose().lines.map(strip);
  assert.ok(rows.some(l => /Tâches · 1\/3 faites/.test(l)));
  assert.ok(rows.some(l => /☒ créer index\.html/.test(l)) && rows.some(l => /◐ ajouter le style/.test(l)) && rows.some(l => /☐ tester/.test(l)));
  assert.ok(!rows.some(l => /☑/.test(l)), 'jamais ☑ (affiché en émoji par Windows Terminal)');
  tui.setTasks([]);
  assert.ok(!tui.compose().lines.map(strip).some(l => /Tâches/.test(l)));
  tui.stop();
});

test('skills automatiques : correspondance nette seulement (français → descriptions anglaises)', () => {
  const list = [
    { name: 'web-design-guidelines', description: 'Design guidelines for building beautiful modern websites' },
    { name: 'xlsx', description: 'Create and edit Excel spreadsheet files' },
    { name: 'code-reviewer', description: 'Review code for bugs' },
  ];
  assert.deepEqual(autoSkills(list, 'fais moi un beau site web').map(s => s.name), ['web-design-guidelines']);
  assert.deepEqual(autoSkills(list, 'fais un tableur de mes dépenses').map(s => s.name), ['xlsx']);
  assert.deepEqual(autoSkills(list, 'corrige le code de script.js'), [], 'mots trop génériques : rien d\'imposé');
  assert.deepEqual(autoSkills(list, 'salut'), []);
});

test('retour en arrière : plusieurs fichiers restaurés d\'un coup, fichier créé mis à la corbeille', async () => {
  const dir = path.join(tmp, 'proj'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original');
  const ctx = { cwd: dir, undo: [] };
  const mark = ctx.undo.length;                                         // repère posé au début de la demande
  await TOOLS.read_file.run({ path: 'a.txt' }, ctx);
  await TOOLS.write_file.run({ path: 'a.txt', content: 'modifié' }, ctx);
  await TOOLS.write_file.run({ path: 'b.txt', content: 'nouveau' }, ctx);
  await TOOLS.edit_file.run({ path: 'a.txt', old_string: 'modifié', new_string: 'encore modifié' }, ctx);
  const trash = path.join(tmp, 'corbeille');
  while (ctx.undo.length > mark) undoLast(ctx, trash);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
  assert.equal(fs.readdirSync(trash).length, 1, 'le fichier créé est gardé dans la corbeille, pas supprimé');
});

test('mise à jour : comparaison de versions', () => {
  assert.equal(compareVersions('3.10.0', '3.9.0'), 1);
  assert.equal(compareVersions('3.8.0', '3.8.0'), 0);
  assert.equal(compareVersions('3.8.1', '4.0.0'), -1);
});

test('intention : « reviens en arrière » → /rewind, mais pas une demande nuancée', () => {
  assert.equal(detectIntent('reviens en arrière')?.cmd, '/rewind');
  assert.equal(detectIntent('annule tout ce que tu as fait stp')?.cmd, '/rewind');
  assert.equal(detectIntent('retour en arrière sur le design mais garde le header'), null);
});

test('affichage : gras + lien dans la même phrase restent propres (plus de « 1m » ni de crochets)', () => {
  let out = ''; ui.attachSink({ write: s => out += s, print: s => out += s });
  const md = new ui.MdStream();
  md.push('1. **Installe [Playwright](https://exemple.fr/x).** puis **relance**\n');
  md.end?.();
  ui.attachSink(null);
  const vis = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(vis, /1\. Installe Playwright \(https:\/\/exemple\.fr\/x\)\. puis relance/);
  assert.doesNotMatch(vis, /\d+m[A-Za-z]|\[Playwright/);
});

test('jeton de l\'extension Chrome collé : intercepté (jamais envoyé au modèle)', () => {
  const r = detectIntent('PLAYWRIGHT_MCP_EXTENSION_TOKEN=abcdefghijklmnopqrstuvwxyz123');   // scan-ignore (faux jeton de test)
  assert.equal(r.cmd, '/navigateur'); assert.match(r.arg, /^chrome PLAYWRIGHT_MCP_EXTENSION_TOKEN=/);
});

test('vision : les images d\'un outil MCP sont enregistrées et mises en file pour le modèle', async () => {
  const { captureImages, takeQueuedImages } = await import('../src/vision.js');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const files = captureImages([{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: png }]);
  assert.equal(files.length, 1); assert.ok(fs.existsSync(files[0]));
  const q = takeQueuedImages();
  assert.equal(q.length, 1); assert.equal(q[0].mime, 'image/png');
  assert.equal(takeQueuedImages().length, 0, 'une capture n\'est envoyée qu\'une fois');
  assert.equal(captureImages([{ type: 'image', data: png }], { queueForModel: false }).length, 1);
  assert.equal(takeQueuedImages().length, 0);
});

test('navigateur : vision, pdf, devtools activés, jeton de l\'extension conservé', async () => {
  const { playwrightServer } = await import('../src/browser.js');
  const sep = playwrightServer({ outDir: '/x' });
  assert.ok(sep.args.includes('vision,pdf,devtools')); assert.ok(!sep.args.includes('--extension')); assert.equal(sep.env, undefined);
  const mine = playwrightServer({ mineChrome: true, token: 'abc', outDir: '/x' });
  assert.ok(mine.args.includes('--extension')); assert.equal(mine.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'abc');
});

test('actions lisibles : les appels fs-mcp sont décodés, les outils ont un type et un libellé', () => {
  const B = String.fromCharCode(92);
  const cmd = `node "C:${B}x${B}fs-cli${B}mcp-cli.js" call Roblox_Studio get_studio_state studio_id=abc`;
  assert.deepEqual(ui.describeAction('shell', cmd), { tag: 'MCP', label: 'Roblox_Studio · get_studio_state', detail: 'studio_id=abc' });
  assert.equal(ui.describeAction('shell', 'npm test').label, 'Commande');
  assert.equal(ui.describeAction('edit_file', 'a.css').label, 'Modifier');
  assert.equal(ui.describeAction('mcp blender.get_scene', '{}').tag, 'MCP');
});

test('actions façon Codex : explorations regroupées, commande écrite à la fin avec puce verte ou rouge', async () => {
  const { fakeStreams } = await import('./term-sim.js');
  const f = fakeStreams(90, 30);
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, history: [] });
  tui.start();
  ui.attachSink({ print: t => tui.print(t), spinner: s => tui.spinner(s), setActive: l => tui.setActive(l) });
  for (const [n, s] of [['read_file', 'a.js'], ['read_file', 'b.js'], ['grep', 'TODO']]) { ui.toolHeader(n, s); assert.equal(ui.toolDone(true), false, 'exploration réussie : résultat masqué'); }
  ui.toolHeader('shell', 'npm run build');
  assert.ok(tui.active.some(l => /◦/.test(l) && /npm run build/.test(l)), 'commande en cours dans la zone du bas');
  ui.toolDone(false);
  await new Promise(r => setTimeout(r, 30));
  const all = f.sim.lines().join('\n');
  assert.match(all, /Exploré\n\s+└ Lire a\.js, b\.js\n\s+Chercher TODO/);
  assert.match(all, /npm run build/);
  assert.equal(tui.active.length, 0, 'zone du bas vidée une fois l\'action terminée');
  ui.attachSink(null); tui.stop();
});

test('diff : exact ligne à ligne, ancienne ligne avant la nouvelle, numéros de ligne', () => {
  const ops = ui.lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(ops.map(o => o.t + o.line), [' a', '-b', '+B', ' c', ' d', '+e']);
  assert.equal(ops.find(o => o.t === '+' && o.line === 'e').n, 5);
  assert.equal(ops.find(o => o.t === '-').o, 2);
  assert.deepEqual(ui.lineDiff('x\r\ny', 'x\ny').map(o => o.t), [' ', ' '], 'fins de ligne Windows ignorées');
});

test('commandes perso : fichier .md → /commande, $ARGUMENTS et $1 remplacés', async () => {
  const { loadCustomCommands, expandCommand } = await import('../src/commands.js');
  const p = path.join(tmp, 'projcmd'); fs.mkdirSync(path.join(p, '.fs-cli', 'commands', 'git'), { recursive: true });
  fs.writeFileSync(path.join(p, '.fs-cli', 'commands', 'review.md'), '---\ndescription: relis le code\n---\nRelis $ARGUMENTS et liste les bugs.');
  fs.writeFileSync(path.join(p, '.fs-cli', 'commands', 'git', 'commit.md'), 'Fais un commit pour $1');
  fs.mkdirSync(path.join(p, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'commands', 'test.md'), 'Lance les tests');
  const l = loadCustomCommands(p);
  assert.deepEqual(l.map(x => x.name), ['git:commit', 'review', 'test']);
  assert.equal(l.find(x => x.name === 'review').description, 'relis le code');
  assert.equal(expandCommand(l.find(x => x.name === 'review'), 'src/app.js'), 'Relis src/app.js et liste les bugs.');
  assert.equal(expandCommand(l.find(x => x.name === 'git:commit'), 'le header'), 'Fais un commit pour le');
  assert.equal(expandCommand(l.find(x => x.name === 'test'), 'unitaires'), 'Lance les tests\n\nunitaires', 'sans variable : arguments ajoutés à la fin');
});

test('ctrl+o : les sorties résumées et la pensée du modèle sont gardées puis affichées en entier', () => {
  let out = ''; ui.attachSink({ print: s => out += s, spinner: () => {} });
  ui.toolBody(Array.from({ length: 20 }, (_, i) => `ligne ${i + 1}`).join('\n'), { max: 5 });
  assert.match(out, /\+15 lignes \(ctrl\+o pour tout voir\)/);
  ui.rememberThinking('je réfléchis à la question');
  out = ''; ui.showExpanded();
  assert.match(out, /pensée du modèle/); assert.match(out, /ligne 20/);
  out = ''; ui.showExpanded(); assert.match(out, /rien de replié/);
  ui.attachSink(null);
});

test('serveurs locaux : reconnus, lancés en arrière-plan ; Start-Process d\'une console caché (Windows)', async () => {
  const { isServerCommand, guessPort, hideConsoleLaunch } = await import('../src/tools.js');
  for (const c of ['npx serve .', 'cd site; npm run dev', 'python -m http.server 8000', 'npx -y http-server -p 8080', 'php -S localhost:8001']) assert.equal(isServerCommand(c), true, c);
  for (const c of ['npm run build', 'python script.py', 'vite build', 'rm -rf x; npx serve', 'npm test']) assert.equal(isServerCommand(c), false, c);
  assert.equal(guessPort('python -m http.server 8765'), 8765);
  assert.equal(guessPort('npx http-server -p 9090'), 9090);
  assert.equal(guessPort('php -S localhost:8001'), 8001);
  assert.equal(guessPort('npx serve .'), 3000);
  if (process.platform === 'win32') {
    assert.equal(hideConsoleLaunch('Start-Process powershell -ArgumentList "npx serve"'), 'Start-Process -WindowStyle Hidden powershell -ArgumentList "npx serve"');
    assert.equal(hideConsoleLaunch('Start-Process http://localhost:3000'), 'Start-Process http://localhost:3000');   // navigateur : inchangé
    assert.equal(hideConsoleLaunch('Start-Process index.html'), 'Start-Process index.html');
    assert.equal(hideConsoleLaunch('Start-Process node a.js -NoNewWindow'), 'Start-Process node a.js -NoNewWindow');
  }
});

test('relecture d\'un fichier inchangé : pas renvoyé ; renvoyé si redemandé aussitôt ou s\'il a changé', async () => {
  const os = await import('node:os'), fs = await import('node:fs'), path = await import('node:path');
  const { TOOLS } = await import('../src/tools.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-reread-'));
  const f = path.join(dir, 'a.js'); fs.writeFileSync(f, 'const a = 1;\nconst b = 2;\n');
  const ctx = { cwd: dir, readCache: new Map() };
  const read = () => TOOLS.read_file.run({ path: 'a.js' }, ctx);
  assert.match((await read()).output, /const a = 1/);                     // 1re lecture : en entier
  const again = await read();
  assert.match(again.output, /inchangé depuis ta lecture précédente/);       // relecture identique : pas renvoyé
  assert.ok(again.output.length < 400);
  assert.match((await read()).output, /const a = 1/);                     // redemandé aussitôt : en entier (soupape)
  assert.match((await read()).output, /inchangé/);
  fs.writeFileSync(f, 'const a = 42;\n');
  assert.match((await read()).output, /const a = 42/);                    // modifié : en entier
  assert.match((await TOOLS.read_file.run({ path: 'a.js', offset: 1, limit: 1 }, ctx)).output, /const a = 42/);   // autre plage : en entier
  assert.match((await TOOLS.read_file.run({ path: 'a.js' }, { cwd: dir })).output, /const a = 42/);   // pas de conversation : jamais de cache
});

test('modèle qui refuse les outils de FS-CLI : reconnu (sans fausse alerte sur une réponse normale)', async () => {
  const { looksLikeToolRefusal: f } = await import('../src/native.js');
  for (const s of ['Le chat France Student ne peut pas servir de moteur à ton outil externe.', 'colle ici le contenu actuel de index.html', "Je n'ai pas accès à tes fichiers.", 'Je ne peux pas modifier directement tes fichiers.']) assert.equal(f(s), true, s);
  for (const s of ['Voici le formulaire modifié, le fichier est à jour.', 'Je ne peux pas garantir que ce test passe.', 'Tu peux coller ce code dans ton fichier.']) assert.equal(f(s), false, s);
});

test('1er message : aucun protocole d\'outils dans le texte (bloqué par France Student ; voie officielle = outils client)', async () => {
  const { workPreferences } = await import('../src/pseudo.js');
  const t = workPreferences().text;
  assert.doesNotMatch(t, /fs-mcp|programme qui exécute|FS-CLI|serveur MCP|cle=valeur/i);
  assert.match(t, /- \[ \]/);                                              // la liste de tâches reste demandée (préférence de forme)
});

test('/vscode : seulement les éditeurs de la famille VS Code (pas une appli du même nom)', async () => {
  const os = await import('node:os'), fs = await import('node:fs'), path = await import('node:path');
  const { isVsCodeFamily } = await import('../src/vscode-install.js');
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-ed-'));
  const mk = (rel, json) => { const f = path.join(t, ...rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, json ? JSON.stringify(json) : ''); return f; };
  const code = mk(['code', 'bin', 'code.cmd']); mk(['code', 'abc1234', 'resources', 'app', 'product.json'], { dataFolderName: '.vscode' });   // VS Code récent
  const fork = mk(['fork', 'bin', 'fork']); mk(['fork', 'resources', 'app', 'product.json'], { dataFolderName: '.fork' });
  const agent = mk(['agent', 'Agent.exe']); mk(['agent', 'resources', 'app.asar']);                                                         // appli Electron ordinaire
  assert.equal(isVsCodeFamily(code), true);
  assert.equal(isVsCodeFamily(fork), true);
  assert.equal(isVsCodeFamily(agent), false);
});

test('images générées par France Student : repérées dans la réponse ; skills auto en simple référence', async () => {
  const { imagesOf } = await import('../src/api.js');
  const parts = [{ type: 'tool-imageGeneration', output: { id: 'abc', kind: 'image', status: 'COMPLETED', contentUrl: '/chats/c/messages/m/images/abc/content', contentType: 'image/png', fileExtension: 'png', revisedPrompt: 'un paysage' } }, { type: 'text' }];
  assert.deepEqual(imagesOf(parts), [{ id: 'abc', url: '/chats/c/messages/m/images/abc/content', contentType: 'image/png', ext: 'png', prompt: 'un paysage' }]);
  assert.deepEqual(imagesOf([{ output: { kind: 'image', status: 'FAILED', url: '/x' } }]), []);
  const { workPreferences } = await import('../src/pseudo.js');
  assert.ok(!workPreferences().text.startsWith('['));                    // un bloc entre crochets s'affichait en formule sur le site
});

test('résumé automatique : seuil adapté à la fenêtre de contexte du modèle, sauf seuil choisi', async () => {
  const { compactLimit } = await import('../src/extra-commands.js');
  const { cfg } = await import('../src/config.js');
  const prev = cfg.compactTokens;
  try {
    cfg.compactTokens = 0;
    const S = w => ({ agentId: 7, ctxWindows: { 7: w } });
    assert.equal(compactLimit(S(1000000)), 200000);
    assert.equal(compactLimit(S(100000)), 45000);                   // Haiku : résumé plus tôt
    assert.equal(compactLimit(S(272000)), 81600);
    assert.equal(compactLimit({ agentId: 7 }), 80000);
    cfg.compactTokens = 150000;
    assert.equal(compactLimit(S(1000000)), 150000);
  } finally { cfg.compactTokens = prev; }
});
