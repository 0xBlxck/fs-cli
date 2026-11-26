// Passerelle Claude Code : commandes « fs-cli claude » et « fs-cli gateway » (src/gateway/launch.js, cli.js ; spécification § 4).
// Aucun processus réel ni réseau : Claude Code, la passerelle et France Student sont simulés (io et deps injectés).
import { tmpHome, fakeFs, deferred } from './gateway-helpers.mjs';   // pose FS_CLI_HOME avant tout import de src/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const L = await import('../src/gateway/launch.js');
const { cfg, HOME_DIR } = await import('../src/config.js');
const { createModels } = await import('../src/gateway/models.js');
const { WHATS_NEW } = await import('../src/whatsnew.js');

const CLI = fs.readFileSync(new URL('../cli.js', import.meta.url), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 500; i++) { if (fn()) return; await tick(); }
  assert.fail(`attente trop longue : ${what}`);
}

// ── splitArgs ──

test('splitArgs : options --fs-* pour FS-CLI, le reste (et tout ce qui suit --) tel quel pour Claude Code', () => {
  const r = L.splitArgs(['-p', 'x', '--model', 'gpt-6-astra', '--fs-web', '--', '--fs-x']);
  assert.deepEqual(r.rest, ['-p', 'x', '--model', 'gpt-6-astra', '--', '--fs-x']);
  assert.equal(r.fs.web, true);
  assert.deepEqual(r.fs.errors, []);
  assert.equal(r.fs.claudeModel, 'gpt-6-astra');
  assert.equal(r.fs.claudeSettings, null);

  const d = L.splitArgs([]).fs;
  assert.deepEqual({ ...d, errors: undefined, claudeModel: undefined, claudeSettings: undefined }, { ...L.FS_DEFAULTS, errors: undefined, claudeModel: undefined, claudeSettings: undefined });

  const o = L.splitArgs(['--fs-projet', 'SandBox Test', '--fs-retour=note', '--fs-sous-agents', '5', '--fs-flux', '1', '--fs-port=9000',
    '--fs-demander', '--fs-claude-md', '--fs-nouveau-jeton', '--fs-debug', '--continue', '--model=claude-fs/openai/gpt-6-luna', '--settings', 'mes.json']);
  assert.deepEqual(o.rest, ['--continue', '--model=claude-fs/openai/gpt-6-luna', '--settings', 'mes.json']);
  assert.equal(o.fs.project, 'SandBox Test');
  assert.equal(o.fs.rewind, 'note');
  assert.equal(o.fs.subagents, 5);
  assert.equal(o.fs.flows, 1);
  assert.equal(o.fs.port, 9000);
  assert.equal(o.fs.ask && o.fs.claudeMd && o.fs.newToken && o.fs.debug, true);
  assert.equal(o.fs.claudeModel, 'claude-fs/openai/gpt-6-luna');
  assert.equal(o.fs.claudeSettings, 'mes.json');
  assert.equal(L.splitArgs(['--fs-web=off']).fs.web, false);
  assert.equal(L.splitArgs(['--fs-journal']).fs.journal, true);
});

test('splitArgs : options inconnues ou valeurs invalides signalées en français', () => {
  const e = L.splitArgs(['--fs-inconnue', '--fs-retour', 'bof', '--fs-port', 'abc', '--fs-flux', '0', '--fs-web=peut-être', '--fs-projet']).fs.errors;
  assert.equal(e.length, 6);
  assert.match(e[0], /^Option inconnue : --fs-inconnue/);
  assert.match(e[1], /--fs-retour.*auto, note, chat/);
  assert.match(e[2], /--fs-port.*« abc »/);
  assert.match(e[3], /--fs-flux.*« 0 »/);
  assert.match(e[4], /--fs-web/);
  assert.match(e[5], /--fs-projet attend une valeur/);
  assert.match(L.splitArgs(['--fs-projet', '--fs-web']).fs.errors[0], /attend une valeur/);
});

// ── childEnv ──

test('childEnv : passerelle et réglages du § 4.2, sans clé Anthropic, token FS, ni fournisseur tiers', () => {
  const base = {
    PATH: '/usr/bin', HOME: '/home/user', LANG: 'fr_FR.UTF-8',
    ANTHROPIC_API_KEY: 'cle-de-test', FS_SESSION_TOKEN: 'jeton-fs', FS_PASSWORD: 'mdp', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_SMALL_FAST_MODEL: 'claude-3-haiku',
    anthropic_base_url: 'https://api.example.com', ANTHROPIC_AUTH_TOKEN: 'ancien', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', FS_CLI_BRIDGE: 'pont',
  };
  const env = L.childEnv(base, { url: 'http://127.0.0.1:53412', token: 'jeton-passerelle', model: 'claude-sonnet-5-5', opts: L.splitArgs([]).fs });
  for (const k of ['ANTHROPIC_API_KEY', 'FS_SESSION_TOKEN', 'FS_PASSWORD', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_SMALL_FAST_MODEL', 'anthropic_base_url', 'CLAUDE_CODE_OAUTH_TOKEN', 'FS_CLI_BRIDGE']) {
    assert.ok(!(k in env), `${k} doit être retirée`);
  }
  assert.deepEqual(Object.keys(env).filter(k => /^CLAUDE_CODE_USE_/i.test(k)), []);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.LANG, 'fr_FR.UTF-8');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:53412');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'jeton-passerelle');
  assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-5-5');
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'claude-fs/gpt-6-astra');
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'GPT-6 Astra (France Student)');
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false');
  assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
  assert.equal(env.DISABLE_TELEMETRY, '1');
  assert.equal(env.DISABLE_ERROR_REPORTING, '1');
  assert.equal(env.API_TIMEOUT_MS, '1800000');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '4');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'pas de forks extract_memories / auto_dream');
  for (const [k, v] of Object.entries(env)) assert.equal(typeof v, 'string', k);
  assert.equal(base.ANTHROPIC_API_KEY, 'cle-de-test', 'l\'environnement de FS-CLI n\'est pas modifié');

  const withModel = L.childEnv(base, { url: 'u', token: 't', model: 'claude-sonnet-5-5', opts: L.splitArgs(['--model', 'gpt-6-astra']).fs });
  assert.ok(!('ANTHROPIC_MODEL' in withModel), '--model de l\'utilisateur prioritaire');
  assert.ok(!('ANTHROPIC_MODEL' in L.childEnv(base, { url: 'u', token: 't' })));
});

// ── findClaude ──

/** Arborescence simulée : isFile / readFile sur un dictionnaire (insensible à la casse sous Windows). */
function vfs(files, { win = false } = {}) {
  const key = p => (win ? p.toLowerCase() : p);
  const map = new Map(Object.entries(files).map(([p, c]) => [key(p), c]));
  return { isFile: p => map.has(key(p)), readFile: p => map.get(key(p)) ?? '' };
}
const NPM = 'C:\\Users\\user\\AppData\\Roaming\\npm';
const SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
const EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const WIN = { platform: 'win32', home: 'C:\\Users\\user', execPath: 'C:\\Program Files\\nodejs\\node.exe' };

test('findClaude (Windows) : l\'exe caché derrière le claude.cmd de npm, jamais cmd.exe quand on peut l\'éviter', () => {
  const env = { Path: `C:\\Windows\\System32;"${NPM}"` };
  assert.deepEqual(L.findClaude(env, { ...WIN, ...vfs({ [`${NPM}\\claude.cmd`]: SHIM, [`${NPM}\\claude`]: '#!/bin/sh', [EXE]: '' }, { win: true }) }),
    { cmd: EXE, isCmd: false, args: [] });
  // claude.exe directement dans le PATH (installateur natif) : prioritaire, même placé après npm
  const local = 'C:\\Users\\user\\.local\\bin';
  assert.deepEqual(L.findClaude({ PATH: `${NPM};${local}` }, { ...WIN, ...vfs({ [`${NPM}\\claude.cmd`]: SHIM, [EXE]: '', [`${local}\\claude.exe`]: '' }, { win: true }) }).cmd,
    `${local}\\claude.exe`);
  // ancien paquet npm : cli.js lancé avec node, toujours sans cmd.exe
  const oldShim = '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*';
  const js = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  assert.deepEqual(L.findClaude({ PATH: NPM }, { ...WIN, ...vfs({ [`${NPM}\\claude.cmd`]: oldShim, [js]: '' }, { win: true }) }),
    { cmd: WIN.execPath, isCmd: false, args: [js] });
  // exe introuvable mais au chemin connu (shim d'un autre format)
  assert.equal(L.findClaude({ PATH: NPM }, { ...WIN, ...vfs({ [`${NPM}\\claude.cmd`]: '@echo off', [EXE]: '' }, { win: true }) }).cmd, EXE);
  // rien derrière le .cmd : dernier recours cmd.exe
  assert.deepEqual(L.findClaude({ PATH: NPM }, { ...WIN, ...vfs({ [`${NPM}\\claude.cmd`]: '@echo off' }, { win: true }) }),
    { cmd: `${NPM}\\claude.cmd`, isCmd: true, args: [] });
  // hors du PATH : ~/.local/bin/claude.exe ; le « claude » sans extension (script sh) n'est jamais pris sous Windows
  assert.equal(L.findClaude({ PATH: '' }, { ...WIN, ...vfs({ 'C:\\Users\\user\\.local\\bin\\claude.exe': '' }, { win: true }) }).cmd, 'C:\\Users\\user\\.local\\bin\\claude.exe');
  assert.equal(L.findClaude({ PATH: NPM }, { ...WIN, ...vfs({ [`${NPM}\\claude`]: '#!/bin/sh' }, { win: true }) }), null);
  assert.equal(L.findClaude({}, { ...WIN, ...vfs({}, { win: true }) }), null);
});

test('findClaude (macOS, Linux) : claude dans le PATH, puis les dossiers des installateurs', () => {
  const lin = { platform: 'linux', home: '/home/user', execPath: '/usr/bin/node' };
  assert.deepEqual(L.findClaude({ PATH: '/usr/bin:/home/user/.npm-global/bin' }, { ...lin, ...vfs({ '/home/user/.npm-global/bin/claude': '' }) }),
    { cmd: '/home/user/.npm-global/bin/claude', isCmd: false, args: [] });
  assert.equal(L.findClaude({ PATH: '/usr/bin' }, { ...lin, ...vfs({ '/home/user/.local/bin/claude': '' }) }).cmd, '/home/user/.local/bin/claude');
  assert.equal(L.findClaude({ PATH: '/usr/bin' }, { ...lin, ...vfs({ '/home/user/.claude/local/claude': '' }) }).cmd, '/home/user/.claude/local/claude');
  assert.equal(L.findClaude({ PATH: '/usr/bin' }, { ...lin, ...vfs({ '/opt/homebrew/bin/claude': '' }) }), null, 'Homebrew : macOS seulement');
  assert.equal(L.findClaude({ PATH: '/usr/bin' }, { ...lin, platform: 'darwin', home: '/Users/user', ...vfs({ '/opt/homebrew/bin/claude': '' }) }).cmd, '/opt/homebrew/bin/claude');
  assert.equal(L.findClaude({ PATH: '/usr/bin' }, { ...lin, ...vfs({}) }), null);
});

test('findClaude : vraie arborescence sur ce système', () => {
  const dir = tmpHome({ prefix: 'fscli-claude-bin-' });
  const home = tmpHome({ prefix: 'fscli-claude-home-' });
  if (process.platform === 'win32') {
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), SHIM);
    assert.deepEqual(L.findClaude({ PATH: dir }, { home }), { cmd: exe, isCmd: false, args: [] });
  } else {
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 });
    assert.notEqual(L.findClaude({ PATH: dir }, { home })?.cmd, bin, 'fichier non exécutable ignoré');
    fs.chmodSync(bin, 0o755);
    assert.deepEqual(L.findClaude({ PATH: dir }, { home }), { cmd: bin, isCmd: false, args: [] });
  }
});

// ── inspectClaudeSettings ──

test('inspectClaudeSettings : Bash autorisé partout, contournement de la passerelle, équipes d\'agents', () => {
  const home = tmpHome(), proj = tmpHome();
  const write = (dir, name, obj) => { fs.mkdirSync(path.join(dir, '.claude'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude', name), typeof obj === 'string' ? obj : '\uFEFF' + JSON.stringify(obj)); };
  assert.deepEqual(L.inspectClaudeSettings(proj, home), { warnings: [] });

  write(home, 'settings.json', { permissions: { allow: ['Bash', 'Read'] }, env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });
  write(proj, 'settings.local.json', { env: { ANTHROPIC_BASE_URL: 'https://api.example.com' }, apiKeyHelper: '/bin/cle' });
  write(proj, 'settings.json', '{ illisible');
  const w = L.inspectClaudeSettings(proj, home, { subagents: 4 }).warnings;
  assert.equal(w.length, 3, w.join('\n'));
  assert.ok(w.some(x => /^Tes réglages Claude Code définissent ANTHROPIC_BASE_URL, apiKeyHelper : ils pourraient contourner la passerelle/.test(x)));
  assert.ok(w.some(x => /autorisent toutes les commandes sans confirmation.*--fs-demander/.test(x)));
  assert.ok(w.some(x => x === 'Les équipes d\'agents de Claude Code consomment des conversations France Student (au plus 4 sous-agents).'));

  const h2 = tmpHome();
  write(h2, 'settings.json', { permissions: { allow: ['Bash(npm test:*)', 'PowerShell(Get-ChildItem:*)'] }, env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' } });
  assert.deepEqual(L.inspectClaudeSettings(tmpHome(), h2).warnings, [], 'règles restreintes : pas d\'avertissement');
  write(h2, 'settings.json', { permissions: { allow: ['PowerShell(*)'] } });
  assert.equal(L.inspectClaudeSettings(tmpHome(), h2).warnings.length, 1);
  write(h2, 'settings.json', { permissions: { defaultMode: 'bypassPermissions' } });
  assert.match(L.inspectClaudeSettings(tmpHome(), h2).warnings[0], /sans confirmation/);
});

// ── runClaude ──

function harness(over = {}) {
  const fake = fakeFs();
  const rec = { out: '', err: '', exits: [], spawns: [], starts: [], closes: 0, signals: {}, logs: [], silenced: 0, projects: [] };
  const spawned = deferred();
  const child = Object.assign(new EventEmitter(), { kills: [] });
  child.kill = sig => { child.kills.push(sig); return true; };
  const io = {
    out: t => { rec.out += t; }, err: t => { rec.err += t; },
    exit: c => { rec.exits.push(c); return c; },
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'cle-de-test', FS_SESSION_TOKEN: 'jeton-fs', CLAUDE_CODE_USE_VERTEX: '1' },
    cwd: tmpHome(), home: tmpHome(), isTTY: false,
    token: async () => 'session-fs',
    login: async () => { rec.login = true; return false; },
    findClaude: () => ({ cmd: 'C:\\outils\\claude.exe', isCmd: false, args: [] }),
    version: () => '2.1.207 (Claude Code)',
    spawn: (cmd, args, opts) => {                                    // spawn(cmd, args, opts) ou spawn(ligne, opts) avec shell:true
      if (!Array.isArray(args)) { opts = args; args = null; }
      rec.spawns.push({ cmd, args, opts }); spawned.open(); return child;
    },
    startGateway: async a => { rec.starts.push(a); return { port: 53412, token: a.token, url: 'http://127.0.0.1:53412', close: async () => { rec.closes++; } }; },
    deps: async () => fake.deps,
    project: async name => { rec.projects.push(name); return { id: 'p1', name }; },
    openLog: async () => ({ line: o => rec.logs.push(o), debug() {}, close() {} }),
    silence: async () => { rec.silenced++; },
    onSignal: (sig, fn) => { rec.signals[sig] = fn; },
    writePlugin: () => 'PLUGIN',
    checkUpdate: async () => null,
    ...over,
  };
  return { fake, rec, io, child, spawned };
}

test('runClaude : passerelle sur 127.0.0.1 port libre, Claude Code lancé avec --settings et l\'environnement de la passerelle', async () => {
  const { fake, rec, io, child, spawned } = harness();
  const run = L.runClaude(['--fs-demander', '--fs-projet', 'SandBox Test', '-p', 'bonjour & 100%'], io);
  await spawned.promise;
  const [start] = rec.starts;
  assert.deepEqual([start.host, start.port], ['127.0.0.1', 0]);
  assert.match(start.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(start.opts.ask, true);
  assert.equal(start.deps, fake.deps);
  assert.equal(typeof start.log.line, 'function');
  assert.deepEqual(rec.projects, ['SandBox Test']);
  assert.equal(rec.silenced, 1, 'plus rien sur le terminal une fois la passerelle démarrée');

  const settingsFile = path.join(HOME_DIR, 'gateway', `claude-settings-${process.pid}.json`);   // un fichier par processus
  assert.equal(L.claudeSettingsFile(), settingsFile);
  assert.notEqual(L.claudeSettingsFile(111), L.claudeSettingsFile(222), 'deux « fs-cli claude » ne partagent pas leurs réglages');
  const sp = rec.spawns[0];
  assert.equal(sp.cmd, 'C:\\outils\\claude.exe');
  assert.deepEqual(sp.args, ['--settings', settingsFile, '--plugin-dir', 'PLUGIN', '-p', 'bonjour & 100%'], 'MCP gardés par défaut (claude-tool)');
  assert.equal(sp.opts.shell, false, 'exe lancé directement : cmd.exe n\'interprète ni & ni %');
  assert.equal(sp.opts.stdio, 'inherit');
  assert.equal(sp.opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:53412');
  assert.equal(sp.opts.env.ANTHROPIC_AUTH_TOKEN, start.token);
  for (const k of ['ANTHROPIC_API_KEY', 'FS_SESSION_TOKEN', 'CLAUDE_CODE_USE_VERTEX']) assert.ok(!(k in sp.opts.env), k);
  const expected = await createModels(fake.deps, { file: path.join(tmpHome(), 'a.json') }).ccId(cfg.agentId);
  assert.equal(sp.opts.env.ANTHROPIC_MODEL, expected ?? undefined, 'modèle par défaut de FS-CLI');

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(settings, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:53412', ANTHROPIC_AUTH_TOKEN: start.token }, permissions: { ask: ['Bash', 'PowerShell'] } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);

  assert.match(rec.err, /^FS-CLI → Claude Code · passerelle 127\.0\.0\.1:53412 · .+ · 50 nouvelles conversations restantes aujourd'hui · journal : .*gateway\.log\n/m);
  assert.equal(typeof rec.signals.SIGINT, 'function');
  rec.signals.SIGINT();
  assert.deepEqual(child.kills, [], 'Ctrl+C appartient à Claude Code');
  rec.signals.SIGTERM();
  assert.deepEqual(child.kills, ['SIGTERM'], 'SIGTERM relayé');

  child.emit('exit', 3, null);
  assert.equal(await run, 3);
  assert.deepEqual(rec.exits, [3]);
  assert.equal(rec.closes, 1, 'passerelle fermée à la sortie de Claude Code');
  assert.ok(!fs.existsSync(settingsFile), 'jeton de la passerelle fermée : fichier de réglages retiré');
  assert.match(rec.err, /Session terminée · conversations France Student créées aujourd'hui : 0\/50\n$/);
  assert.equal(fake.calls.stream.length, 0, 'aucun appel à France Student au lancement');
  assert.equal(rec.logs.find(l => l.event === 'claude').version, '2.1.207 (Claude Code)');
});

test('runClaude : --model de l\'utilisateur, --settings personnel, version non testée, sortie par signal', async () => {
  const { rec, io, child, spawned } = harness({ version: () => '2.2.0 (Claude Code)' });
  const run = L.runClaude(['--model', 'claude-fs/gpt-6-astra', '--settings', 'perso.json', '--fs-demander'], io);
  await spawned.promise;
  const sp = rec.spawns[0];
  assert.deepEqual(sp.args, ['--plugin-dir', 'PLUGIN', '--model', 'claude-fs/gpt-6-astra', '--settings', 'perso.json'], 'pas de second --settings');
  assert.ok(!('ANTHROPIC_MODEL' in sp.opts.env));
  assert.match(rec.err, /· GPT-6 Astra ·/);
  assert.match(rec.err, /ton propre --settings.*--fs-demander est sans effet/);
  assert.match(rec.logs.find(l => l.event === 'claude').warning, /non testée/);
  child.emit('exit', null, 'SIGKILL');
  assert.equal(await run, 1, 'tué par un signal : code 1');
});

test('runClaude : erreurs avant le lancement (options, session, Claude Code absent, passerelle, spawn, .cmd)', async () => {
  let h = harness();
  assert.equal(await L.runClaude(['--fs-retour', 'bof'], h.io), 2);
  assert.match(h.rec.err, /--fs-retour/);
  assert.equal(h.rec.starts.length, 0);

  h = harness();
  assert.equal(await L.runClaude(['--fs-journal'], h.io), 0);
  assert.equal(h.rec.out.trim(), path.join(HOME_DIR, 'gateway', 'gateway.log'));
  assert.equal(h.rec.starts.length, 0);

  h = harness({ token: async () => '' });
  assert.equal(await L.runClaude([], h.io), 1);
  assert.equal(h.rec.err, 'Pas de session France Student : lance d\'abord fs-cli --login.\n');
  assert.equal(h.rec.login, undefined, 'pas d\'assistant sans terminal');
  h = harness({ token: async () => '', isTTY: true });
  assert.equal(await L.runClaude([], h.io), 1);
  assert.equal(h.rec.login, true, 'terminal : assistant de connexion');

  h = harness({ findClaude: () => null });
  assert.equal(await L.runClaude([], h.io), 1);
  assert.match(h.rec.err, /Claude Code est introuvable\. Installe-le \(npm i -g @anthropic-ai\/claude-code ou https:\/\/code\.claude\.com\), puis relance fs-cli claude\./);
  assert.equal(h.rec.starts.length, 0);

  h = harness({ startGateway: async () => { throw new Error('boum'); } });
  assert.equal(await L.runClaude([], h.io), 1);
  assert.match(h.rec.err, /Impossible de démarrer la passerelle : boum/);
  assert.equal(h.rec.spawns.length, 0);

  h = harness();
  const run = L.runClaude([], h.io);
  await h.spawned.promise;
  h.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(await run, 1);
  assert.match(h.rec.err, /Impossible de lancer Claude Code : spawn ENOENT/);
  assert.equal(h.rec.closes, 1);

  h = harness({ findClaude: () => ({ cmd: `${NPM}\\claude.cmd`, isCmd: true, args: [] }) });
  const run2 = L.runClaude(['-p', 'a b'], h.io);
  await h.spawned.promise;
  assert.equal(h.rec.spawns[0].opts.shell, true, 'dernier recours : cmd.exe');
  assert.match(h.rec.spawns[0].cmd, /claude\.cmd --settings .*claude-settings-\d+\.json"? --plugin-dir PLUGIN -p "a b"$/);
  h.child.emit('exit', 0);
  assert.equal(await run2, 0);
});

// ── runGatewayCmd ──

test('runGatewayCmd : port 8787, jeton persistant, commandes à copier, une ligne par requête principale, Ctrl+C', async () => {
  const tokenFile = path.join(HOME_DIR, 'gateway', 'token');
  try { fs.rmSync(tokenFile); } catch {}
  const h = harness();
  const run = L.runGatewayCmd([], h.io);
  await until(() => h.rec.signals.SIGINT, 'Ctrl+C installé');
  const start = h.rec.starts[0];
  assert.deepEqual([start.host, start.port], ['127.0.0.1', 8787]);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.equal(start.token, token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.match(h.rec.out, /^Passerelle France Student pour Claude Code : http:\/\/127\.0\.0\.1:53412 {3}\(Ctrl\+C pour arrêter\)$/m);
  assert.ok(h.rec.out.includes(`PowerShell :  $env:ANTHROPIC_BASE_URL="http://127.0.0.1:53412"; $env:ANTHROPIC_AUTH_TOKEN="${token}"; Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; claude`));
  assert.ok(h.rec.out.includes(`bash / zsh :  ANTHROPIC_BASE_URL=http://127.0.0.1:53412 ANTHROPIC_AUTH_TOKEN=${token} claude`));
  assert.match(h.rec.out, /claudeCode\.environmentVariables/);

  const before = h.rec.out;
  start.log.line({ event: 'request', kind: 'main', chatId: 'chat-1234567890', ms: 1520, outcome: 'ok' });
  start.log.line({ event: 'request', kind: 'title', ms: 3, outcome: 'local' });
  start.log.line({ event: 'console', text: 'rien sur stdout' });
  const added = h.rec.out.slice(before.length);
  assert.match(added, /^\d{2}:\d{2}:\d{2} · main · chat-123 · 1,5 s · ok\n$/);
  assert.ok(h.rec.logs.some(l => l.kind === 'title'), 'tout reste dans le journal');
  assert.doesNotMatch(added, new RegExp(token), 'jamais le jeton dans les lignes de requête');

  h.rec.signals.SIGINT();
  assert.equal(await run, 0);
  assert.equal(h.rec.closes, 1);

  const h2 = harness();                                                // même jeton au lancement suivant
  const run2 = L.runGatewayCmd(['--fs-port', '9001'], h2.io);
  await until(() => h2.rec.signals.SIGTERM, 'signaux installés');
  assert.equal(h2.rec.starts[0].token, token);
  assert.equal(h2.rec.starts[0].port, 9001);
  h2.rec.signals.SIGTERM();
  assert.equal(await run2, 0);

  const h3 = harness();                                                // --fs-nouveau-jeton
  const run3 = L.runGatewayCmd(['--fs-nouveau-jeton'], h3.io);
  await until(() => h3.rec.signals.SIGINT, 'signaux installés');
  assert.notEqual(h3.rec.starts[0].token, token);
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), h3.rec.starts[0].token);
  h3.rec.signals.SIGINT();
  await run3;
});

test('runGatewayCmd : port déjà utilisé, session absente, arguments ignorés', async () => {
  const h = harness({ startGateway: async () => { throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }); } });
  assert.equal(await L.runGatewayCmd([], h.io), 1);
  assert.match(h.rec.err, /Le port 8787 est déjà utilisé \(une autre passerelle \?\)\. Choisis-en un autre avec --fs-port\./);

  const h2 = harness({ token: async () => '' });
  const run = L.runGatewayCmd(['--model', 'x'], h2.io);
  await until(() => h2.rec.signals.SIGINT, 'signaux installés');
  assert.match(h2.rec.err, /Pas encore de session France Student : lance fs-cli --login/);
  assert.match(h2.rec.err, /Arguments ignorés par fs-cli gateway : --model x/);
  assert.equal(h2.rec.starts.length, 1, 'démarre quand même : le token est relu à chaque requête');
  h2.rec.signals.SIGINT();
  await run;
});

test('realDeps : les 13 dépendances + quota, branchées sur src/api.js (rien n\'est appelé ici)', async () => {
  const d = await L.realDeps();
  for (const k of ['stream', 'resume', 'fetchChat', 'searchChats', 'compactChat', 'uploadFile', 'cancelStream', 'fetchAgentsFull', 'createdToday', 'quota', 'fsExists', 'fsStat', 'now']) {
    assert.equal(typeof d[k], 'function', k);
  }
  assert.equal(d.fsExists(path.join(HOME_DIR, 'absent-' + Date.now())), false);
  assert.equal(d.fsStat(path.join(HOME_DIR, 'absent-' + Date.now())), null);
  assert.equal(d.fsStat(HOME_DIR).isDirectory(), true);
  assert.deepEqual(Object.keys(d.quota()).sort(), ['created', 'limitHit', 'remaining', 'resetText']);
});

// ── cli.js et nouveautés ──

test('cli.js : « fs-cli claude » lance la passerelle avant la boucle d\'arguments ; « fs-cli -- claude » reste une demande', () => {
  const iSub = CLI.indexOf('const sub = process.argv[2];');
  const iArgs = CLI.indexOf('const argv = process.argv.slice(2);');
  assert.ok(iSub > 0 && iSub < iArgs, 'aiguillage avant la boucle d\'arguments');
  const list = JSON.parse(CLI.slice(iSub).match(/if \((\[[^\]]+\])\.includes\(sub\)\)/)[1].replace(/'/g, '"'));
  for (const a of ['claude', '--claude', 'gateway', '--gateway']) assert.ok(list.includes(a), a);
  for (const a of ['--', '-p', 'Claude', 'corrige']) assert.ok(!list.includes(a), a);
  assert.match(CLI.slice(iSub, iArgs), /await import\('\.\/src\/gateway\/launch\.js'\)/);
  assert.match(CLI.slice(iSub, iArgs), /sub\.includes\('claude'\) \? L\.runClaude : L\.runGatewayCmd\)\(process\.argv\.slice\(3\)\)/);
  assert.equal(typeof L.runClaude, 'function');
  assert.equal(typeof L.runGatewayCmd, 'function');

  // la vraie boucle d'arguments de cli.js, exécutée seule
  const loop = CLI.slice(iArgs, CLI.indexOf('if (opts.mcp)', iArgs));
  const parse = argv => new Function('process', `${loop}\nreturn opts;`)({ argv: ['node', 'cli.js', ...argv] });
  assert.equal(parse(['--', 'claude']).prompt.join(' '), 'claude');
  assert.deepEqual(parse(['--', '-p', '--help']).prompt, ['-p', '--help'], 'après --, tout est la demande');
  assert.equal(parse(['--', '-p', '--help']).print, false);
  assert.equal(parse(['-p', 'corrige', 'claude']).prompt.join(' '), 'corrige claude');
  assert.equal(parse(['-p', 'x']).print, true);
});

test('cli.js : aide (2 lignes), /claude dans l\'aide du terminal mais pas dans le panneau', () => {
  const help = CLI.slice(CLI.indexOf('if (opts.help)'), CLI.indexOf('process.exit(0);', CLI.indexOf('if (opts.help)')));
  assert.match(help, /\n {2}fs claude \[options\] +Claude Code avec ton compte France Student/);
  assert.match(help, /\n {2}fs gateway +la passerelle seule/);
  const slash = CLI.slice(CLI.indexOf('const SLASH = ['), CLI.indexOf('];', CLI.indexOf('const SLASH = [')));
  assert.doesNotMatch(slash, /'\/claude/, 'absente de SLASH, la liste envoyée au panneau');
  const rows = CLI.slice(CLI.indexOf('const HELP_ROWS = ['), CLI.indexOf('\n];', CLI.indexOf('const HELP_ROWS = [')));
  assert.match(rows, /\.\.\.\(opts\.stdio \? \[\] : \[\['\/claude', '[^']+'\]\]\)/);
  assert.match(CLI, /case '\/claude':[^\n]*\n\s*return println\([^\n]*fs-cli claude/);
});

test('nouveautés : entrée 3.56.7 en tête, puis 3.56.6, 3.56.5, 3.56.4, 3.56.3, 3.56.2, 3.56.1, 3.56.0, 3.55.4, 3.55.3, 3.55.2, 3.55.1, 3.55.0, 3.54.4, 3.54.3, 3.54.2, 3.54.1, 3.54.0, 3.53.0, 3.52.2, 3.52.1, 3.52.0, 3.51.0, 3.50.0, 3.49.2, 3.49.1, 3.49.0, 3.48.2, 3.48.1 et 3.48.0', () => {
  const [, , , , , , , , , , , , , , , , , m, z, y, x, u, s, r, p, e, g, w, n, v] = WHATS_NEW;
  assert.equal(WHATS_NEW[0].version, '3.56.7');
  assert.match(WHATS_NEW[0].items[0], /bloc repliable/);
  assert.equal(WHATS_NEW[1].version, '3.56.6');
  assert.match(WHATS_NEW[1].items[0], /pare-feu/);
  assert.equal(WHATS_NEW[2].version, '3.56.5');
  assert.match(WHATS_NEW[2].items[0], /façon Claude Code/);
  assert.equal(WHATS_NEW[3].version, '3.56.4');
  assert.match(WHATS_NEW[3].items[0], /PowerShell, cmd et Git Bash/);
  assert.equal(WHATS_NEW[4].version, '3.56.3');
  assert.match(WHATS_NEW[4].items[0], /Formules mathématiques lisibles/);
  assert.match(WHATS_NEW[4].items[1], /copie est écrite dans ton dossier/);
  assert.equal(WHATS_NEW[5].version, '3.56.2');
  assert.match(WHATS_NEW[5].items[0], /git pull/);
  assert.equal(WHATS_NEW[6].version, '3.56.1');
  assert.match(WHATS_NEW[6].items[0], /ne se mélangent plus/);
  assert.equal(WHATS_NEW[7].version, '3.56.0');
  assert.match(WHATS_NEW[7].items[0], /se rattache à la réponse/);
  assert.match(WHATS_NEW[7].items[3], /\/plus-tard/);
  assert.match(WHATS_NEW[7].items[4], /\/bug/);
  assert.equal(WHATS_NEW[8].version, '3.55.4');
  assert.match(WHATS_NEW[8].items[0], /vrai nombre de tokens relus/);
  assert.equal(WHATS_NEW[9].version, '3.55.3');
  assert.match(WHATS_NEW[9].items[0], /petite liste/);
  assert.equal(WHATS_NEW[10].version, '3.55.2');
  assert.match(WHATS_NEW[10].items[0], /aperçu en direct/);
  assert.equal(WHATS_NEW[11].version, '3.55.1');
  assert.match(WHATS_NEW[11].items[0], /budget de chat restant/);
  assert.equal(WHATS_NEW[12].version, '3.55.0');
  assert.match(WHATS_NEW[12].items[0], /Consommation réduite/);
  assert.equal(WHATS_NEW[13].version, '3.54.4');
  assert.equal(WHATS_NEW[14].version, '3.54.3');
  assert.equal(WHATS_NEW[15].version, '3.54.2');
  assert.equal(WHATS_NEW[16].version, '3.54.1');
  assert.equal(m.version, '3.54.0');
  assert.match(m.items[0], /serveurs MCP/);
  assert.equal(z.version, '3.53.0');
  assert.match(z.items[0], /Plus jamais de changement de modèle à ta place/);
  assert.equal(y.version, '3.52.2');
  assert.match(y.items[1], /\/team/);
  assert.equal(x.version, '3.52.1');
  assert.match(x.items[0], /fs-cli update/);
  assert.equal(u.version, '3.52.0');
  assert.match(u.items[0], /fs-cli update/);
  assert.match(u.items[2], /\/fs:conversations/);
  assert.equal(s.version, '3.51.0');
  assert.match(s.items[0], /\/fs:conversations/);
  assert.match(s.items[0], /\/fs:reprendre 3/);
  assert.equal(r.version, '3.50.0');
  assert.match(r.items[0], /--fs-conversations/);
  assert.match(r.items[1], /--fs-conversation "TP nmap"/);
  assert.equal(p.version, '3.49.2');
  assert.match(p.items[0], /--fs-projet <id>/);
  assert.equal(e.version, '3.49.1');
  assert.equal(e.items.length, 2);
  assert.match(e.items[0], /403/);
  assert.equal(g.version, '3.49.0');
  assert.equal(g.items.length, 2);
  assert.match(g.items[0], /--fs-garder/);
  assert.match(g.items[1], /--fs-oublier/);
  assert.equal(w.version, '3.48.2');
  assert.equal(w.items.length, 1);
  assert.match(w.items[0], /recherche web/);
  assert.equal(n.version, '3.48.1');
  assert.equal(n.items.length, 2);
  assert.match(n.items[0], /panneau/);
  assert.match(n.items[1], /refusée/);
  assert.equal(v.version, '3.48.0');
  assert.equal(v.items.length, 4);
  assert.match(v.items[0], /`fs-cli claude`/);
  assert.match(v.items[1], /`fs-cli gateway`/);
  assert.match(v.items[2], /`--fs-mcp`/);
  assert.match(v.items[3], /`fs-cli -- claude`/);
});

// ── réglages enregistrés : --fs-garder / --fs-oublier ──

test('keptArgs / withSaved : --fs-* et --model / --permission-mode gardés ; -p, -c… jamais ; ce qui est tapé l\'emporte', () => {
  assert.deepEqual(L.keptArgs(['--model', 'gpt-6-astra', '--fs-projet', 'SandBox Test', '--fs-web', '--permission-mode=acceptEdits', '-p', 'salut', '-c', '--fs-journal', '--fs-sous-agents', '5', '--', '--model', 'x']),
    ['--model', 'gpt-6-astra', '--fs-projet', 'SandBox Test', '--fs-web', '--permission-mode=acceptEdits', '--fs-sous-agents', '5']);
  assert.deepEqual(L.keptArgs(['--model']), [], 'valeur absente : rien');
  const saved = ['--model', 'gpt-6-astra', '--fs-projet', 'SandBox Test', '--permission-mode', 'acceptEdits', '--fs-web'];
  assert.deepEqual(L.withSaved(saved, ['-p', 'yo']), [...saved, '-p', 'yo']);
  assert.deepEqual(L.withSaved(saved, ['--model=sonnet', '--fs-web=off']), ['--fs-projet', 'SandBox Test', '--permission-mode', 'acceptEdits', '--model=sonnet', '--fs-web=off']);
  assert.deepEqual(L.withSaved(saved, [], { claude: false }), ['--fs-projet', 'SandBox Test', '--fs-web'], 'passerelle seule : seulement les --fs-*');
  assert.deepEqual(L.withSaved(saved, ['--', '--model', 'x']), [...saved, '--', '--model', 'x'], 'après « -- » : rien n\'est une option');
  assert.equal(L.showArgs(['--fs-projet', 'SandBox Test', '--fs-web']), '--fs-projet "SandBox Test" --fs-web');
});

test('runClaude --fs-garder : enregistre puis lance ; ensuite « fs-cli claude » seul reprend les réglages ; --fs-oublier efface', async () => {
  let store = [];
  const over = { savedDefaults: () => store.slice(), saveDefaults: l => { store = l.slice(); } };
  let h = harness(over);
  let run = L.runClaude(['--fs-garder', '--model', 'gpt-6-astra', '--fs-projet', 'SandBox Test', '--permission-mode', 'acceptEdits', '-p', 'yo'], h.io);
  await h.spawned.promise;
  assert.deepEqual(store, ['--model', 'gpt-6-astra', '--fs-projet', 'SandBox Test', '--permission-mode', 'acceptEdits'], '-p jamais enregistré');
  assert.match(h.rec.err, /Réglages enregistrés : --model gpt-6-astra --fs-projet "SandBox Test" --permission-mode acceptEdits\n.*« fs-cli claude » suffit/);
  assert.deepEqual(h.rec.spawns[0].args.slice(-6), ['--model', 'gpt-6-astra', '--permission-mode', 'acceptEdits', '-p', 'yo'], '--fs-garder ne part pas à Claude Code');
  h.child.emit('exit', 0, null); await run;

  h = harness(over);
  run = L.runClaude([], h.io);
  await h.spawned.promise;
  assert.deepEqual(h.rec.projects, ['SandBox Test']);
  assert.deepEqual(h.rec.spawns[0].args.slice(-4), ['--model', 'gpt-6-astra', '--permission-mode', 'acceptEdits']);
  assert.match(h.rec.err, /^Réglages enregistrés : --model gpt-6-astra --fs-projet "SandBox Test" --permission-mode acceptEdits  \(--fs-oublier pour les effacer\)\n/m);
  h.child.emit('exit', 0, null); await run;

  h = harness(over);
  run = L.runClaude(['--model', 'sonnet'], h.io);
  await h.spawned.promise;
  assert.deepEqual(h.rec.spawns[0].args.filter(a => /astra|sonnet/.test(a)), ['sonnet'], 'le modèle tapé remplace celui enregistré');
  h.child.emit('exit', 0, null); await run;

  h = harness(over);
  assert.equal(await L.runClaude(['--fs-garder'], h.io), 0);
  assert.match(h.rec.out, /^Réglages enregistrés : --model gpt-6-astra/);
  assert.equal(h.rec.starts.length, 0);

  h = harness(over);
  assert.equal(await L.runClaude(['--fs-oublier'], h.io), 0);
  assert.deepEqual(store, []);
  assert.match(h.rec.err, /effacés/);
  assert.equal(h.rec.starts.length, 0);

  h = harness(over);
  assert.equal(await L.runClaude(['--fs-garder', '--fs-retour', 'bof'], h.io), 2, 'réglage invalide : rien enregistré');
  assert.deepEqual(store, []);
});

test('chooseChat : id direct, mot du titre, liste au clavier (Entrée = nouvelle), hors terminal → liste avec les id ; projet', async () => {
  const chats = [
    { id: 'c1', title: 'TP Nmap', lastMessageAt: '2026-11-19T10:00:00Z', agent: { name: 'GPT-6 Astra' } },
    { id: 'c2', title: 'CV', lastMessageAt: '2026-11-19T12:00:00Z' },
    { id: 'c3', title: 'TP Wireshark', lastMessageAt: '2026-11-18T09:00:00Z' },
  ];
  const asked = [];
  const mk = (over = {}) => ({ isTTY: true, err() {}, recentChats: async () => chats, projectChats: async id => (id === 'P' ? [chats[0]] : null), ask: async q => { asked.push(q); return over.answer ?? ''; }, ...over });
  const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';   // scan-ignore (faux id de test)
  assert.equal(await L.chooseChat(mk(), {}), null, 'sans option : nouvelle conversation');
  assert.deepEqual(await L.chooseChat(mk(), { chat: ID.toUpperCase() }), { id: ID, title: '' });
  assert.deepEqual(await L.chooseChat(mk(), { chat: 'cv' }), { id: 'c2', title: 'CV' });
  assert.match((await L.chooseChat(mk(), { chat: 'blender' })).error, /Aucune conversation .*« blender »/);
  assert.deepEqual(await L.chooseChat(mk({ answer: '2' }), { chat: 'tp' }), { id: 'c3', title: 'TP Wireshark' }, 'plusieurs « tp » : choix au clavier (1 = TP Nmap, la plus récente ; 2 = TP Wireshark)');
  assert.equal(await L.chooseChat(mk({ answer: '' }), { pickChat: true }), null, 'Entrée : nouvelle conversation');
  assert.deepEqual(await L.chooseChat(mk({ answer: '1' }), { pickChat: true }), { id: 'c2', title: 'CV' });
  assert.match((await L.chooseChat(mk({ answer: '9' }), { pickChat: true })).error, /Numéro invalide/);
  const off = await L.chooseChat(mk({ isTTY: false }), { pickChat: true });
  assert.match(off.error, /--fs-conversation <id>/); assert.match(off.error, /\(c1\)/);
  assert.deepEqual(await L.chooseChat(mk({ answer: '1' }), { pickChat: true }, 'P'), { id: 'c1', title: 'TP Nmap' }, 'projet : ses conversations seulement');
  assert.match((await L.chooseChat(mk(), { pickChat: true }, 'X')).error, /Impossible de lire/);
  assert.match(L.chatLine(chats[0], 0), /^ {2}1\. TP Nmap · GPT-6 Astra · 19\/11/);
  assert.equal(L.keptArgs(['--fs-conversation', 'cv', '--fs-conversations', '--fs-web']).join(' '), '--fs-web', 'jamais enregistrées par --fs-garder');
});

test('plugin de session : deux commandes qui posent le marqueur lu par la passerelle', async () => {
  const { pluginFiles, fsCommand } = await import('../src/gateway/fschats.js');
  const f = pluginFiles('3.51.0');
  assert.equal(JSON.parse(f['.claude-plugin/plugin.json']).name, 'fs');
  assert.match(f['commands/conversations.md'], /^---\ndescription: .+\nargument-hint: .+\n---\nFSCLI-COMMANDE conversations \$ARGUMENTS\n$/);
  assert.match(f['commands/reprendre.md'], /FSCLI-COMMANDE reprendre \$ARGUMENTS/);
  assert.deepEqual(fsCommand('<command-name>/fs:reprendre</command-name>\nFSCLI-COMMANDE reprendre 3 '), { name: 'reprendre', arg: '3' });
  assert.deepEqual(fsCommand('FSCLI-COMMANDE conversations'), { name: 'conversations', arg: '' });
  assert.equal(fsCommand('explique FSCLI-COMMANDE à quelqu\'un'), null);
});

test('menu du lancement : 5 lignes qui défilent, ↑ en haut repart du bas, indicateurs ↑/↓ « de plus »', async () => {
  const P = await import('../src/gateway/picker.js');
  let st = { idx: 0, top: 0 };
  for (let i = 0; i < 6; i++) st = P.movePicker(st, 'down', 12, 5);
  assert.deepEqual(st, { idx: 6, top: 2 });
  st = P.movePicker({ idx: 0, top: 0 }, 'up', 12, 5);
  assert.deepEqual(st, { idx: 11, top: 7 }, 'en haut : on repart du bas');
  assert.deepEqual(P.movePicker(st, 'home', 12, 5), { idx: 0, top: 0 });
  assert.deepEqual(P.movePicker({ idx: 0, top: 0 }, 'pagedown', 12, 5), { idx: 5, top: 1 });
  const items = Array.from({ length: 12 }, (_, i) => ({ label: `Conversation ${i + 1}`, description: 'GPT-6 Astra' }));
  const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = P.renderPicker({ title: 'Titre', items }, { idx: 6, top: 2 }, 5, 60).map(plain);
  assert.equal(lines.length, 9, 'titre + ↑ + 5 lignes + ↓ + aide');
  assert.equal(lines[1], '  ↑ 2 de plus');
  assert.match(lines[6], /^❯ Conversation 7 · GPT-6 Astra$/);
  assert.equal(lines[7], '  ↓ 5 de plus');
  assert.ok(P.renderPicker({ title: 'x'.repeat(200), items: [{ label: 'y'.repeat(200) }] }, { idx: 0, top: 0 }, 5, 40).map(plain).every(l => l.length <= 39));
});

test('menu du lancement dans un faux terminal : flèches puis Entrée → index ; Échap → null ; terminal rétabli', async () => {
  const P = await import('../src/gateway/picker.js');
  const { EventEmitter } = await import('node:events');
  const fakeTerm = () => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, raw: null, setRawMode(v) { this.raw = v; }, resume() {}, pause() {} });
    const output = { columns: 80, out: '', write(s) { this.out += s; } };
    return { input, output };
  };
  const items = Array.from({ length: 8 }, (_, i) => ({ label: `C${i}` }));
  let t = fakeTerm();
  let p = P.pickInTerminal({ title: 'T', items, input: t.input, output: t.output });
  t.input.emit('data', '\x1b[B'); t.input.emit('data', '\x1b[B'); t.input.emit('data', '\r');
  assert.equal(await p, 2);
  assert.equal(t.input.raw, false, 'mode brut rendu');
  assert.match(t.output.out, /\x1b\[\?25h$/, 'curseur rendu');
  t = fakeTerm();
  p = P.pickInTerminal({ title: 'T', items, input: t.input, output: t.output });
  t.input.emit('data', '\x1b');
  assert.equal(await p, null, 'Échap seul');
  assert.equal(await P.pickInTerminal({ title: 'T', items, input: { isTTY: false }, output: t.output }), null, 'pas de terminal : null');
});

test('chooseChat avec le menu : projets puis conversations ; Échap revient aux projets ; « Nouvelle conversation » → null', async () => {
  const picks = [];
  const answers = [];
  const h = {
    isTTY: true, err() {},
    projects: async () => [{ id: 'pA', name: 'Cours' }],
    projectChats: async id => (id === 'pA' ? [{ id: 'c1', title: 'TP', lastMessageAt: '2026-11-19T10:00:00Z' }] : null),
    recentChats: async () => [{ id: 'r1', title: 'Récente', lastMessageAt: '2026-11-19T11:00:00Z' }, { id: 'r2', title: 'Vieille', lastMessageAt: '2026-11-01T11:00:00Z' }],
    pick: async o => { picks.push(o.items.map(i => i.label)); return answers.shift(); },
  };
  answers.push(1, null, 0, 2);   // projet « Cours », Échap (retour), « toutes », 2e conversation
  assert.deepEqual(await L.chooseChat(h, { pickChat: true }), { id: 'r2', title: 'Vieille' }, 'index 2 du menu (0 = nouvelle conversation)');
  assert.deepEqual(picks, [['Toutes mes conversations récentes', '📁 Cours'], ['＋ Nouvelle conversation', 'TP'], ['Toutes mes conversations récentes', '📁 Cours'], ['＋ Nouvelle conversation', 'Récente', 'Vieille']]);
  answers.push(0, 0);
  assert.equal(await L.chooseChat(h, { pickChat: true }), null, '« Nouvelle conversation »');
  picks.length = 0; answers.push(1);
  assert.deepEqual(await L.chooseChat(h, { pickChat: true }, 'pA'), { id: 'c1', title: 'TP' }, 'avec --fs-projet : directement ses conversations');
  assert.deepEqual(picks, [['＋ Nouvelle conversation', 'TP']]);
});

test('fs-cli update : npm puis le panneau des éditeurs, sans question ; dossier git → « git pull » ; échec npm → commande à la main', async () => {
  const { updateAll, INSTALL_CMD } = await import('../src/update.js');
  const mk = (over = {}) => {
    const r = { runs: [], logs: [], shells: [] };
    const deps = { root: 'R', platform: 'win32', exists: () => false, check: async () => ({ current: '3.51.0', latest: '3.52.0', newer: true }),
      run: (cmd, args, o = {}) => { r.runs.push([cmd, ...args].join(' ')); r.shells.push(!!o.shell); return { status: 0 }; }, log: t => r.logs.push(t), node: 'node', ...over };
    return { r, deps };
  };
  let { r, deps } = mk();
  assert.equal(await updateAll(deps), 0);
  assert.deepEqual(r.runs, [`npm.cmd install -g ${INSTALL_CMD.split(' ').pop()}`, `node ${path.join('R', 'cli.js')} --vscode`]);
  assert.match(r.logs.join('\n'), /v3\.51\.0 → v3\.52\.0[\s\S]*Reload Window/);
  assert.deepEqual(r.shells, [true, false], 'npm.cmd par le shell ; Node lancé directement (son chemin « C:\\Program Files\\… » était coupé à l\'espace)');
  assert.doesNotMatch(r.logs.join('\n'), /[✓✗]/, 'pas de symboles que l\'invite de commandes affiche en « ? »');
  ({ r, deps } = mk({ exists: p => p.endsWith('.git'), run: (cmd, args, o = {}) => { r.runs.push([cmd, ...args].join(' ')); r.shells.push(!!o.shell); r.cwds = [...(r.cwds || []), o.cwd]; return { status: 0 }; } }));
  assert.equal(await updateAll(deps), 0, 'dossier git : mis à jour tout seul (git pull), plus besoin d\'aller dans le dossier');
  assert.deepEqual(r.runs, ['git pull --ff-only', `node ${path.join('R', 'cli.js')} --vscode`]);
  assert.equal(r.cwds[0], 'R', 'git pull lancé dans le dossier de FS-CLI');
  assert.deepEqual(r.shells, [false, false], 'git lancé directement : un dossier avec espaces ne casse rien');
  assert.match(r.logs.join('\n'), /git pull[\s\S]*Reload Window/);
  ({ r, deps } = mk({ exists: p => p.endsWith('.git'), run: (cmd) => { r.runs.push(cmd); return { status: 1 }; } }));
  assert.equal(await updateAll(deps), 1);
  assert.equal(r.runs.length, 1, 'panneau pas tenté si git pull échoue');
  assert.match(r.logs.at(-1), /git pull/);
  ({ r, deps } = mk({ run: (cmd) => { r.runs.push(cmd); return { status: 1 }; } }));
  assert.equal(await updateAll(deps), 1);
  assert.equal(r.runs.length, 1, 'panneau pas tenté si npm échoue');
  assert.match(r.logs.at(-1), /À la main : npm\.cmd install -g/, 'Windows : npm.cmd (npm.ps1 bloqué sur un Windows neuf)');
});

test('runClaude : nouvelle version sur GitHub → une ligne « fs-cli update » ; vérification lente (> 1,5 s) → on lance sans attendre', async () => {
  let h = harness({ checkUpdate: async () => ({ current: '3.52.0', latest: '3.53.0', newer: true }) });
  let run = L.runClaude(['-p', 'x'], h.io);
  await h.spawned.promise;
  assert.match(h.rec.err, /Nouvelle version de FS-CLI : v3\.53\.0 \(tu as la v3\.52\.0\)\. Pour tout mettre à jour : fs-cli update/);
  h.child.emit('exit', 0, null); await run;
  h = harness({ checkUpdate: () => new Promise(() => {}) });
  const t0 = Date.now();
  run = L.runClaude(['-p', 'x'], h.io);
  await h.spawned.promise;
  assert.ok(Date.now() - t0 < 3000, 'jamais bloqué');
  assert.doesNotMatch(h.rec.err, /Nouvelle version/);
  h.child.emit('exit', 0, null); await run;
});

test('runClaude --fs-mcp=off : serveurs MCP coupés (--strict-mcp-config)', async () => {
  const h = harness();
  const run = L.runClaude(['--fs-mcp=off', '-p', 'x'], h.io);
  await h.spawned.promise;
  assert.ok(h.rec.spawns[0].args.includes('--strict-mcp-config'));
  h.child.emit('exit', 0, null); await run;
});

test('runClaude : sessions de fs claude à part (CLAUDE_CONFIG_DIR) ; --fs-historique commun : comme avant ; échec → dossier habituel, signalé', async () => {
  let h = harness({ claudeHome: () => ({ dir: 'C:\\fs\\claude-home', linked: ['skills'], copied: ['.claude.json'], errors: [] }) });
  let run = L.runClaude(['-p', 'x'], h.io);
  await h.spawned.promise;
  assert.equal(h.rec.spawns[0].opts.env.CLAUDE_CONFIG_DIR, 'C:\\fs\\claude-home');
  assert.equal(h.rec.logs.find(l => l.event === 'claude-home').dir, 'C:\\fs\\claude-home');
  h.child.emit('exit', 0, null); await run;

  let called = 0;
  h = harness({ claudeHome: () => { called++; return { dir: 'X' }; }, env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: 'C:\\perso' } });
  run = L.runClaude(['--fs-historique', 'commun', '-p', 'x'], h.io);
  await h.spawned.promise;
  assert.equal(called, 0);
  assert.equal(h.rec.spawns[0].opts.env.CLAUDE_CONFIG_DIR, 'C:\\perso', 'commun : le dossier de l\'utilisateur, inchangé');
  h.child.emit('exit', 0, null); await run;

  h = harness({ claudeHome: () => ({ dir: null, errors: ['disque plein'] }) });
  run = L.runClaude(['-p', 'x'], h.io);
  await h.spawned.promise;
  assert.ok(!('CLAUDE_CONFIG_DIR' in h.rec.spawns[0].opts.env));
  assert.match(h.rec.err, /Historique à part impossible \(disque plein\)/);
  h.child.emit('exit', 0, null); await run;
  assert.match(L.splitArgs(['--fs-historique', 'nimporte']).fs.errors[0], /separe, commun/);
});

test('runClaude avec un GPT : avertissement au lancement (ils refusent souvent le mode agent, vu sur Discord) ; avec Claude : rien', async () => {
  for (const [model, warned] of [['gpt-6-astra', true], ['claude-fs/gpt-6-astra', true], ['sonnet', false]]) {
    const { rec, io, spawned, child } = harness();
    const run = L.runClaude(['--model', model, '-p', 'x'], io);
    await spawned.promise;
    assert.equal(/refuse souvent de travailler comme agent/.test(rec.err), warned, model);
    if (warned) assert.match(rec.err, /GPT-6 Astra refuse souvent[\s\S]*fs claude --model sonnet/);
    child.emit('exit', 0, null); await run;
  }
});
