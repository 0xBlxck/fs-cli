// Sécurité : dépôt piégé (.env du dossier courant, .mcp.json de projet), token hors de l'environnement des programmes lancés
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-sec-'));
const url = f => 'file:///' + path.join(SRC, f).replace(/\\/g, '/');

test('.env du dossier courant : jamais lu (PATH, NODE_OPTIONS, clés FS_* ignorés)', () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'projet-piege-'));
  fs.writeFileSync(path.join(cwd, '.env'), 'PATH=C:\\evil\nNODE_OPTIONS=--require evil.js\nFS_AGENT_ID=999\nFS_SESSION_TOKEN=token-du-pirate-123456\n'); // scan-ignore
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const code = `
    const before = process.env.PATH;
    const { cfg, TOKEN } = await import(${JSON.stringify(url('config.js'))});
    console.log(JSON.stringify({ pathSame: process.env.PATH === before, nodeOptions: process.env.NODE_OPTIONS ?? null, agent: cfg.agentId, tokenIsPirate: TOKEN === 'token-du-pirate-123456' }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, env: { ...process.env, FS_CLI_HOME: home, FS_SESSION_TOKEN: '', NODE_OPTIONS: '' }, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.pathSame, true); assert.equal(out.nodeOptions === null || out.nodeOptions === '', true);
  assert.notEqual(out.agent, 999); assert.equal(out.tokenIsPirate, false);
});

test('.env du CLI : seules les clés autorisées passent, et le token est retiré de l\'environnement', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.writeFileSync(path.join(home, '.env'), 'FS_SESSION_TOKEN=mon-token-de-test-1234\nPATH=C:\\evil\nLD_PRELOAD=/x.so\nFS_SEARCH_PROVIDER=none\n');
  const code = `
    const before = process.env.PATH;
    const { TOKEN, SEARCH_PROVIDER } = await import(${JSON.stringify(url('config.js'))});
    console.log(JSON.stringify({ tokenSet: !!TOKEN, tokenIsHome: TOKEN === 'mon-token-de-test-1234', tokenInEnv: process.env.FS_SESSION_TOKEN ?? null, pathSame: process.env.PATH === before, ld: process.env.LD_PRELOAD ?? null, provider: process.env.FS_SEARCH_PROVIDER ?? null, providerExported: SEARCH_PROVIDER }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: tmp, env: { ...process.env, FS_CLI_HOME: home, FS_SESSION_TOKEN: '' }, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  // (booléens seulement : aucune assertion ne doit pouvoir afficher un vrai token ; le .env du dossier du CLI, s'il existe, a priorité)
  const hasLocalEnv = fs.existsSync(path.join(SRC, '..', '.env'));
  assert.ok(out.tokenSet, 'un token est lu');
  if (!hasLocalEnv) assert.ok(out.tokenIsHome, 'le token du .env de ~/.fs-cli est lu');
  assert.ok(out.tokenInEnv === null, 'le token est retiré de l\'environnement (non hérité par les programmes lancés)');
  assert.equal(out.pathSame, true); assert.equal(out.ld, null); assert.equal(out.provider, null, 'FS_SEARCH_* retirées de l\'environnement'); assert.equal(out.providerExported, 'none');
});

test('MCP : un .mcp.json de projet ne démarre rien tant que le projet n\'est pas approuvé', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  process.env.FS_CLI_HOME = home;
  const { McpManager, isProjectTrusted, trustProject } = await import('../src/mcp.js');
  const cwd = fs.mkdtempSync(path.join(tmp, 'depot-pirate-'));
  const marker = path.join(cwd, 'PWNED.txt');
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { piege: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } } }));
  const mgr = new McpManager({ cwd });

  await assert.rejects(mgr.connect('piege'), /non approuvé/);
  assert.equal((await mgr.test('piege')).ok, false);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.existsSync(marker), false, 'la commande du projet n\'a PAS été lancée');
  assert.equal(isProjectTrusted(cwd), false);

  trustProject(cwd);                                           // approbation explicite de l'utilisateur
  assert.equal(isProjectTrusted(cwd), true);
  await mgr.connect('piege', { timeoutMs: 4000 }).catch(() => {});   // la commande démarre (elle n'est pas un vrai serveur MCP : l'échec est normal)
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.existsSync(marker), true, 'après approbation, le serveur est lancé');
  await mgr.closeAll();

  // le fichier change après l'approbation (dépôt mis à jour, commande remplacée) : l'approbation tombe
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { piege: { command: process.execPath, args: ['-e', 'console.log(1)'] } } }));
  assert.equal(isProjectTrusted(cwd), false, 'approbation invalidée par la modification du fichier');
});

test('MCP : la config de l\'utilisateur (~/.fs-cli/mcp.json) n\'a pas besoin d\'approbation', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  process.env.FS_CLI_HOME = home;
  const { loadMcpConfig, saveMcpConfig, isProjectTrusted } = await import('../src/mcp.js');
  const cwd = fs.mkdtempSync(path.join(tmp, 'proj-'));
  saveMcpConfig('user', cwd, { mcpServers: { mien: { command: 'node', args: ['-v'] } } });
  const cfg = loadMcpConfig(cwd);
  assert.equal(cfg.mcpServers.mien._scope, 'user'); assert.equal(isProjectTrusted(cwd), false);
});

test('le token n\'est jamais envoyé par l\'outil web (safeFetch n\'ajoute aucun en-tête d\'authentification)', async () => {
  const src = fs.readFileSync(path.join(SRC, 'web.js'), 'utf8');
  assert.ok(!/FS_SESSION_TOKEN|TOKEN/.test(src.replace(/Brave|X-Subscription-Token/g, '')), 'web.js ne référence pas le token FS');
});

test('terminal : les séquences de contrôle du texte non fiable sont retirées (OSC, CSI, DCS, C1)', async () => {
  const { sanitize } = await import('../src/ui.js');
  const E = String.fromCharCode(27), BEL = String.fromCharCode(7), BS = String.fromCharCode(92);
  assert.equal(sanitize(`a${E}]0;titre${BEL}b`), 'ab');
  assert.equal(sanitize(`a${E}]52;c;ZXZpbA==${E}${BS}b`), 'ab');
  assert.equal(sanitize(`x${E}[2J${E}[31mrouge${E}[0my`), 'xrougey');
  assert.equal(sanitize(`x${E}Pdcs${E}${BS}y`), 'xy');
  assert.equal(sanitize('l1\nl2\ttab'), 'l1\nl2\ttab');
});
