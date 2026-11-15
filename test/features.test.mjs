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
  assert.ok(rows.some(l => /Tâches 1\/3/.test(l)));
  assert.ok(rows.some(l => /☑ créer index\.html/.test(l)) && rows.some(l => /◐ ajouter le style/.test(l)) && rows.some(l => /☐ tester/.test(l)));
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
