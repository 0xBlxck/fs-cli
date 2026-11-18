// Extension VS Code sur Mac : recherche de node / cli.js sans le PATH du terminal, chemins /private/tmp,
// message « introuvable », grosse image collée, raccourcis Cmd. Tout est simulé : le test tourne aussi sous Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// faux module « vscode » : extension.js ne s'en sert qu'à l'exécution
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? { workspace: {}, window: {}, commands: {} } : origLoad.call(this, req, ...rest); };
const ext = require(path.join(ROOT, 'vscode', 'extension.js'));
Module._load = origLoad;
const T = ext._test;

/** faux disque : fichiers, liens (realpath) et dossiers */
function fakeFs(files, links = {}) {
  const set = new Set(files);
  const dirs = new Set();
  for (const f of [...files, ...Object.keys(links)]) { let d = path.posix.dirname(f); while (d !== '/') { dirs.add(d); d = path.posix.dirname(d); } }
  return {
    exists: f => set.has(f) || f in links || dirs.has(f),
    realpath: f => { if (f in links) return links[f]; if (set.has(f) || dirs.has(f)) return f; throw new Error('ENOENT'); },
    readdir: d => [...new Set([...set, ...Object.keys(links)].filter(f => f.startsWith(d + '/')).map(f => f.slice(d.length + 1).split('/')[0]))],
  };
}
const HOME = '/Users/moi';

test('Mac : Homebrew hors du PATH de l\'éditeur → node et cli.js trouvés quand même', () => {
  const js = '/opt/homebrew/lib/node_modules/fs-cli/cli.js';
  const r = T.locateCli({ home: HOME, env: { PATH: '/usr/bin:/bin' }, ...fakeFs(['/opt/homebrew/bin/node', js], { '/opt/homebrew/bin/fs-cli': js }) });
  assert.equal(r.node, '/opt/homebrew/bin/node');
  assert.equal(r.js, js);
  assert.ok(r.pathDirs.includes('/opt/homebrew/bin'));
});

test('Mac : installateur communautaire (préfixe npm ~/.local)', () => {
  const js = `${HOME}/.local/lib/node_modules/fs-cli/cli.js`;
  const r = T.locateCli({ home: HOME, env: { PATH: '/usr/bin:/bin' }, ...fakeFs(['/usr/local/bin/node', js]) });
  assert.equal(r.js, js);
  assert.equal(r.node, '/usr/local/bin/node');
});

test('Mac : nvm → la version la plus récente, et node du même préfixe que cli.js', () => {
  const v = `${HOME}/.nvm/versions/node`;
  const r = T.locateCli({ home: HOME, env: { PATH: '/usr/bin' }, ...fakeFs([`${v}/v9.11.2/bin/node`, `${v}/v18.0.0/bin/node`, `${v}/v22.3.1/bin/node`, `${v}/v22.3.1/lib/node_modules/fs-cli/cli.js`]) });
  assert.equal(r.node, `${v}/v22.3.1/bin/node`);
  assert.equal(r.js, `${v}/v22.3.1/lib/node_modules/fs-cli/cli.js`);
});

test('Mac : Volta', () => {
  const js = `${HOME}/.volta/tools/image/packages/fs-cli/lib/node_modules/fs-cli/cli.js`;
  const r = T.locateCli({ home: HOME, env: { PATH: '/usr/bin' }, ...fakeFs([`${HOME}/.volta/bin/node`, js]) });
  assert.equal(r.node, `${HOME}/.volta/bin/node`);
  assert.equal(r.js, js);
});

test('Mac : « npm prefix -g » du shell de connexion (préfixe inhabituel)', () => {
  const out = 'Bienvenue dans zsh !\nlast login…\n__FSP__/opt/tools/bin:/usr/bin\n__FSN__/opt/tools/bin/node\n__FSC__\n__FSG__/opt/npmglobal\n';
  const login = T.parseLoginOutput(out);
  assert.deepEqual(login, { path: '/opt/tools/bin:/usr/bin', node: '/opt/tools/bin/node', fsCli: '', prefix: '/opt/npmglobal' });
  const r = T.locateCli({ home: HOME, env: { PATH: '/usr/bin' }, login, ...fakeFs(['/opt/tools/bin/node', '/opt/npmglobal/lib/node_modules/fs-cli/cli.js']) });
  assert.equal(r.js, '/opt/npmglobal/lib/node_modules/fs-cli/cli.js');
  assert.equal(r.node, '/opt/tools/bin/node');
  assert.ok(r.pathDirs.includes('/opt/tools/bin'));
});

test('Mac : rien trouvé → ce qui manque, et message utile (Cmd+Q, fsCli.command) au lieu de « code 127 »', () => {
  assert.deepEqual(T.locateCli({ home: HOME, env: { PATH: '/usr/bin' }, ...fakeFs([]) }), { missing: { node: true, cli: true } });
  assert.deepEqual(T.locateCli({ home: HOME, env: { PATH: '/usr/bin' }, ...fakeFs(['/usr/local/bin/node']) }), { missing: { node: false, cli: true } });
  const msg = T.notFoundMessage({ node: true, cli: true }, true);
  assert.match(msg, /Cmd\+Q/);
  assert.match(msg, /fsCli\.command/);
  assert.match(T.notFoundMessage({ cli: true }, true), /^FS-CLI introuvable/);
});

test('sortie « commande introuvable » reconnue (Mac/Linux seulement)', () => {
  assert.equal(T.isNotFoundExit(127, '', false), true);
  assert.equal(T.isNotFoundExit(1, '/bin/sh: fs-cli: command not found', false), true);
  assert.equal(T.isNotFoundExit(1, 'env: node: No such file or directory', false), true);
  assert.equal(T.isNotFoundExit(1, 'Error: boom', false), false);
  assert.equal(T.isNotFoundExit(127, '', true), false);                 // Windows : inchangé
});

test('/tmp → /private/tmp et liens : chemin ramené à celui ouvert dans l\'éditeur', () => {
  const realpath = p => p.replace(/^\/tmp(?=\/|$)/, '/private/tmp').replace(/^\/Users\/moi\/dev(?=\/|$)/, '/Volumes/SSD/dev');
  const o = { win: false, realpath };
  assert.equal(T.toEditorPath('/private/tmp/projet/src/a.js', ['/tmp/projet'], o), '/tmp/projet/src/a.js');
  assert.equal(T.toEditorPath('/private/tmp/projet', ['/tmp/projet'], o), '/tmp/projet');
  assert.equal(T.toEditorPath('/Volumes/SSD/dev/app/x.ts', ['/Users/moi/dev/app'], o), '/Users/moi/dev/app/x.ts');
  assert.equal(T.toEditorPath('/private/tmp/projetB/a.js', ['/tmp/projet'], o), '/private/tmp/projetB/a.js');   // autre dossier : intact
  assert.equal(T.toEditorPath('/tmp/projet/a.js', ['/tmp/projet'], o), '/tmp/projet/a.js');
  assert.equal(T.toEditorPath('C:\\p\\a.js', ['C:\\p'], { win: true, realpath }), 'C:\\p\\a.js');   // Windows : inchangé
});

test('image collée trop lourde : un message, jamais un abandon silencieux', async () => {
  const posts = [];
  const fake = { post: m => posts.push(m) };
  await T.Chat.prototype.fromPanel.call(fake, { type: 'pasteImage', mime: 'image/png', data: 'A'.repeat(14_000_001) });
  await T.Chat.prototype.fromPanel.call(fake, { type: 'pasteImage', mime: 'image/png', data: '' });
  assert.equal(posts.length, 2);
  for (const p of posts) { assert.equal(p.type, 'event'); assert.equal(p.ev.type, 'flash'); assert.ok(p.ev.text.length > 10); }
  assert.match(posts[0].ev.text, /trop lourde/);
});

test('panneau : réduction des grosses images et raccourcis Cmd pour Mac', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'vscode', 'media', 'panel.js'), 'utf8');
  assert.match(panel, /createImageBitmap/);
  assert.match(panel, /dataset\.platform/);
  assert.match(panel, /Cmd\+Ctrl\+Maj\+4/);
  // la traduction des raccourcis, extraite et exécutée telle quelle
  const src = panel.match(/const macKeys = t => ([\s\S]*?);\n/)[1];
  const macKeys = new Function('IS_MAC', `return t => ${src};`)(true);
  assert.equal(macKeys('recharge (Ctrl+Maj+P › « Reload Window »)'), 'recharge (Cmd+Maj+P › « Reload Window »)');
  assert.equal(macKeys('Win+Maj+S, puis Alt+V'), 'Cmd+Ctrl+Maj+4, puis Cmd+V');
  assert.equal(macKeys('Ctrl+Alt+I'), 'Cmd+Option+I');
  assert.equal(macKeys('Ctrl+C pour quitter'), 'Ctrl+C pour quitter');      // raccourci du terminal : intact
  assert.equal(new Function('IS_MAC', `return t => ${src};`)(false)('Ctrl+Maj+P'), 'Ctrl+Maj+P');   // Windows : intact
});

test('raccourcis : variantes Mac (cmd) dans package.json et le README', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8'));
  for (const k of pkg.contributes.keybindings) assert.match(k.mac || '', /^cmd\+/, k.command);
  const readme = fs.readFileSync(path.join(ROOT, 'vscode', 'README.md'), 'utf8');
  for (const s of ['Cmd+Option+I', 'Cmd+Option+K', 'Cmd+V']) assert.ok(readme.includes(s), s);
});
