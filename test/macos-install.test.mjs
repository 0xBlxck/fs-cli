// Installation et intégration sur Mac (et Linux) : chemins, conseils et messages propres au système.
// Les fonctions prennent la plateforme en paramètre : ces tests tournent aussi sous Windows. Aucun réseau.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-macos-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
process.env.FS_CLI_NO_UPDATE_CHECK = '1';
fs.mkdirSync(process.env.FS_CLI_HOME, { recursive: true });

const { devtoolsSteps } = await import('../src/setup.js');
const { candidates } = await import('../src/vscode-install.js');
const { claudeDesktopConfig, discoverMcpServers } = await import('../src/discover.js');
const { stableNode, manualInstallHelp, folderKey, deniedMessage } = await import('../src/mcp-server.js');
const { fsMcpCommand } = await import('../src/pseudo.js');
const { npmPermissionHelp, isNpmPermissionError, globalDirWritable, shellProfile, INSTALL_CMD } = await import('../src/update.js');
const { unixChecks, nodeInstallHint } = await import('../src/doctor.js');
const { loadCustomCommands } = await import('../src/commands.js');

const withPlatform = (p, fn) => {
  const d = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', d); }
};

test('assistant de connexion : ⌘⌥I et Safari sur Mac, F12 ailleurs', () => {
  const mac = devtoolsSteps('darwin').join('\n');
  assert.match(mac, /⌘⌥I/); assert.match(mac, /Safari/); assert.match(mac, /développeurs web/); assert.doesNotMatch(mac, /F12/);
  for (const p of ['win32', 'linux']) { const t = devtoolsSteps(p).join('\n'); assert.match(t, /F12/); assert.doesNotMatch(t, /Safari/); }
});

test('/vscode sur Mac : /Applications, ~/Applications et Homebrew, pour chaque éditeur', () => {
  const list = candidates('darwin', '/Users/alice');
  const names = list.map(c => c.name);
  for (const n of ['VS Code', 'VS Code Insiders', 'Cursor', 'Windsurf', 'Antigravity IDE', 'Antigravity', 'VSCodium']) assert.ok(names.includes(n), n);
  const all = list.flatMap(c => c.paths);
  for (const app of ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app', 'Cursor.app', 'Windsurf.app', 'Antigravity IDE.app', 'Antigravity.app', 'VSCodium.app']) {
    assert.ok(all.some(p => p.startsWith(`/Applications/${app}/Contents/Resources/app/bin/`)), app);
    assert.ok(all.some(p => p.startsWith(`/Users/alice/Applications/${app}/Contents/Resources/app/bin/`)), `~/Applications ${app}`);
  }
  assert.ok(all.includes('/opt/homebrew/bin/code') && all.includes('/opt/homebrew/bin/codium'));
  assert.ok(all.every(p => !p.includes('\\')), 'chemins Mac en /');
  // Windows : toujours les .cmd de %LOCALAPPDATA%
  assert.ok(candidates('win32', 'C:\\Users\\alice').find(c => c.name === 'VS Code').paths.some(p => /code\.cmd$/i.test(p)));
});

test('Claude Desktop : bon fichier selon le système', () => {
  assert.equal(claudeDesktopConfig('/Users/a', 'darwin'), path.join('/Users/a', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal(claudeDesktopConfig('/home/a', 'linux', {}), path.join('/home/a', '.config', 'Claude', 'claude_desktop_config.json'));
  assert.equal(claudeDesktopConfig('C:\\U\\a', 'win32', { APPDATA: 'C:\\U\\a\\AppData\\Roaming' }), path.join('C:\\U\\a\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
});

test('Claude Desktop : serveurs MCP importés sur Mac (~/Library/Application Support)', () => {
  const home = path.join(tmp, 'imp-mac');
  const dir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { bureau: { command: '/opt/homebrew/bin/npx', args: ['-y', 'x'] } } }));
  const old = process.env.FS_IMPORT_HOME; process.env.FS_IMPORT_HOME = home;
  try {
    const s = withPlatform('darwin', () => discoverMcpServers(null));
    assert.equal(s.bureau?._source, 'Claude Desktop');
    assert.equal(s.bureau.command, '/opt/homebrew/bin/npx');
  } finally { if (old === undefined) delete process.env.FS_IMPORT_HOME; else process.env.FS_IMPORT_HOME = old; }
});

test('--install-mcp : chemin de Node stable avec Homebrew', () => {
  const links = {
    '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/24.1.0/bin/node',
    '/opt/homebrew/opt/node@22/bin/node': '/opt/homebrew/Cellar/node@22/22.9.0/bin/node',
    '/usr/local/bin/node': '/usr/local/Cellar/node/23.0.0/bin/node',
  };
  const realpath = p => { if (links[p]) return links[p]; if (Object.values(links).includes(p) || p.startsWith('/Users/')) return p; throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const o = { platform: 'darwin', realpath };
  assert.equal(stableNode('/opt/homebrew/Cellar/node/24.1.0/bin/node', o), '/opt/homebrew/bin/node');
  assert.equal(stableNode('/usr/local/Cellar/node/23.0.0/bin/node', o), '/usr/local/bin/node');                 // Mac Intel
  assert.equal(stableNode('/opt/homebrew/Cellar/node@22/22.9.0/bin/node', o), '/opt/homebrew/opt/node@22/bin/node');   // formule « keg-only »
  assert.equal(stableNode('/Users/a/.nvm/versions/node/v22.1.0/bin/node', o), '/Users/a/.nvm/versions/node/v22.1.0/bin/node');
  assert.equal(stableNode('C:\\Program Files\\nodejs\\node.exe', { platform: 'win32', realpath }), 'C:\\Program Files\\nodejs\\node.exe');
});

test('--install-mcp sans agent : commande claude mcp add avec le chemin absolu de Node', () => {
  const lines = manualInstallHelp({ node: '/opt/homebrew/bin/node', cli: '/Users/a/fs-cli/cli.js', platform: 'darwin' }).join('\n');
  assert.match(lines, /claude mcp add -s user france-student -- "\/opt\/homebrew\/bin\/node" "\/Users\/a\/fs-cli\/cli\.js" --mcp/);
  assert.match(lines, /Library\/Application Support\/Claude\/claude_desktop_config\.json/);
  assert.doesNotMatch(lines, /commande « node »/);
  assert.ok(manualInstallHelp().join('\n').includes(process.platform === 'win32' ? `"${stableNode()}"` : JSON.stringify(stableNode())));
});

test('fs-mcp : lancé avec le Node de FS-CLI hors Windows', () => {
  assert.equal(fsMcpCommand('darwin', '/opt/homebrew/Cellar/node/24.1.0/bin/node', '/r'), `"/opt/homebrew/Cellar/node/24.1.0/bin/node" "${path.join('/r', 'mcp-cli.js')}"`);
  assert.equal(fsMcpCommand('win32', 'C:\\n\\node.exe', 'C:\\r'), `node "${path.join('C:\\r', 'mcp-cli.js')}"`);
});

test('serveur MCP : accès refusé par macOS ≠ dossier introuvable ; même dossier sous deux casses', () => {
  assert.match(deniedMessage('/Users/a/Desktop', 'darwin'), /Accès refusé par macOS \(Confidentialité et sécurité\)/);
  assert.doesNotMatch(deniedMessage('/x', 'linux'), /macOS/);
  const d = fs.mkdtempSync(path.join(tmp, 'Projet-'));
  assert.equal(folderKey(d.toUpperCase(), 'darwin'), folderKey(d, 'darwin'));
  assert.equal(folderKey(d, 'darwin'), folderKey(d, 'darwin').toLowerCase());
  assert.equal(folderKey(path.join(d, '.'), 'darwin'), folderKey(d, 'darwin'));
});

test('/update : EACCES de npm -g → explication avec ~/.local, jamais sudo', () => {
  assert.equal(isNpmPermissionError('npm ERR! code EACCES'), true);
  assert.equal(isNpmPermissionError('npm ERR! code ETARGET'), false);
  assert.equal(npmPermissionHelp('ETARGET'), null);
  const mac = npmPermissionHelp('npm ERR! Error: EACCES: permission denied, mkdir \'/usr/local/lib/node_modules/fs-cli\'', { platform: 'darwin', shell: '/bin/zsh' });
  const t = mac.join('\n');
  assert.match(t, /npm config set prefix ~\/\.local/);
  assert.match(t, /\$HOME\/\.local\/bin:\$PATH.*~\/\.zprofile/);
  assert.ok(t.includes(INSTALL_CMD));
  assert.ok(mac.every(l => !/^\s*sudo\b/.test(l)), 'aucune commande sudo');
  assert.equal(shellProfile({ platform: 'linux', shell: '/bin/bash' }), '~/.bashrc');
  assert.equal(shellProfile({ platform: 'darwin', shell: '' }), '~/.zprofile');
  assert.ok(npmPermissionHelp('EPERM', { platform: 'win32' }).length > 0);
  // dossier global : seulement quand FS-CLI est dans …/node_modules/fs-cli
  assert.equal(globalDirWritable('/opt/x/fs-cli'), null);
  assert.equal(globalDirWritable('/usr/local/lib/node_modules/fs-cli', () => { throw new Error('EACCES'); }), false);
  assert.equal(globalDirWritable('/usr/local/lib/node_modules/fs-cli', () => {}), true);
});

test('/doctor sur Mac : Rosetta, npm global, outils Xcode, touche Option', () => {
  const ok = (stdout = '') => ({ status: 0, stdout });
  const ko = { status: 1, stdout: '' };
  const native = unixChecks({ platform: 'darwin', arch: 'arm64', env: { TERM_PROGRAM: 'Apple_Terminal' }, exec: (c) => (c.includes('xcode') ? ok('/Library/Developer/CommandLineTools') : ok('0')), npmWritable: () => true });
  assert.ok(native.some(k => k.level === 'ok' && /exécution native ARM64, sans Rosetta/.test(k.detail)));
  assert.ok(native.some(k => k.label === 'Terminal' && /Option comme touche Méta/.test(k.fix)));
  assert.ok(native.every(k => k.level === 'ok'));
  const bad = unixChecks({ platform: 'darwin', arch: 'x64', env: { SHELL: '/bin/zsh' }, exec: (c) => (c.includes('sysctl') ? ok('1\n') : ko), npmWritable: () => false });
  assert.ok(bad.some(k => k.level === 'warn' && /Rosetta/.test(k.detail)));
  assert.ok(bad.some(k => k.level === 'warn' && k.label === 'npm global' && /~\/\.local/.test(k.fix) && !/sudo/.test(k.fix)));
  assert.ok(bad.some(k => k.level === 'warn' && k.label === 'Outils Xcode' && /xcode-select --install/.test(k.fix)));
  assert.deepEqual(unixChecks({ platform: 'win32' }), []);
  assert.match(nodeInstallHint('darwin'), /brew install node/); assert.doesNotMatch(nodeInstallHint('darwin'), /winget/);
  assert.match(nodeInstallHint('win32'), /winget/);
});

test('commandes perso : un .md en lien symbolique est suivi', (t) => {
  const proj = path.join(tmp, 'proj-cmd'); const dir = path.join(proj, '.fs-cli', 'commands');
  const dots = path.join(tmp, 'dotfiles'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(dots, 'git'), { recursive: true });
  fs.writeFileSync(path.join(dots, 'review.md'), '---\ndescription: relis le code\n---\nRelis $ARGUMENTS');
  fs.writeFileSync(path.join(dots, 'git', 'commit.md'), 'Fais un commit');
  try { fs.symlinkSync(path.join(dots, 'git'), path.join(dir, 'git'), 'junction'); }    // dossier (jonction sous Windows : sans droits spéciaux)
  catch { t.skip('liens symboliques non autorisés sur cette machine'); return; }
  let fileLink = true;
  try { fs.symlinkSync(path.join(dots, 'review.md'), path.join(dir, 'review.md'), 'file'); } catch { fileLink = false; }   // Windows sans mode développeur : refusé
  const names = loadCustomCommands(proj).map(c => c.name);
  assert.ok(names.includes('git:commit'), names.join(','));
  if (fileLink) assert.ok(names.includes('review'), names.join(','));
});

test('serveurs MCP stdio arrêtés quand le terminal se ferme (SIGHUP)', { skip: process.platform === 'win32' && 'signaux POSIX' }, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'hup-'));
  const pidFile = path.join(dir, 'sleeper.pid');
  const server = path.join(dir, 'server.mjs');
  fs.writeFileSync(server, `import { spawn } from 'node:child_process'; import fs from 'node:fs';
const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(s.pid));
await import(${JSON.stringify(pathToFileURL(path.join(here, 'mcp', 'fake-mcp-stdio.js')).href)});`);
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { faux: { command: process.execPath, args: [server] } } }));
  const driver = `const { McpManager } = await import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'src', 'mcp.js')).href)});
const m = new McpManager({ cwd: ${JSON.stringify(dir)} }); await m.connect('faux'); console.log('PRET'); setInterval(() => {}, 1000);`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', driver], { env: { ...process.env, FS_CLI_HOME: home, FS_IMPORT_HOME: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('serveur non démarré')), 20000);
    p.stdout.on('data', d => { if (/PRET/.test(d)) { clearTimeout(to); res(); } });
    p.on('exit', c => { clearTimeout(to); rej(new Error(`sortie ${c}`)); });
  });
  const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
  const code = await new Promise(res => { p.removeAllListeners('exit'); p.on('exit', (c, s) => res(c ?? s)); p.kill('SIGHUP'); });
  assert.equal(code, 129);
  let alive = true;
  for (let k = 0; k < 40 && alive; k++) { try { process.kill(sleeper, 0); await new Promise(r => setTimeout(r, 100)); } catch { alive = false; } }
  if (alive) try { process.kill(sleeper, 'SIGKILL'); } catch {}
  assert.equal(alive, false, 'le sous-processus du serveur MCP doit être arrêté');
});
