// Pont local fs-mcp ↔ session FS-CLI : appels qui passent, refus (jeton, page web, serveur importé non autorisé).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-bridge-'));
const home = path.join(tmp, 'home'); const imp = path.join(tmp, 'imp'); const proj = path.join(tmp, 'proj');
for (const d of [home, imp, proj]) fs.mkdirSync(d, { recursive: true });
process.env.FS_CLI_HOME = home; process.env.FS_IMPORT_HOME = imp;
const fake = path.join(here, 'mcp', 'fake-mcp-stdio.js');
fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { faux: { command: process.execPath, args: [fake] } } }));
fs.writeFileSync(path.join(imp, '.claude.json'), JSON.stringify({ mcpServers: { importe: { command: process.execPath, args: [fake] } } }));

const { McpManager } = await import('../src/mcp.js');
const { startBridge, bridgeRequest } = await import('../src/bridge.js');
const mgr = new McpManager({ cwd: proj });
const br = await startBridge({ getManager: () => mgr, getCwd: () => proj });
const [port, token] = br.env.split(':');
const post = (headers, body) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('appel d\'outil à travers le pont (serveur gardé ouvert par la session)', async () => {
  const r = await bridgeRequest({ action: 'call', server: 'faux', tool: 'echo', args: { text: 'salut', upper: true } });
  assert.equal(r.ok, true); assert.equal(r.text, 'SALUT');
  const t = await bridgeRequest({ action: 'tools', server: 'faux' });
  assert.ok(t.tools.some(x => x.name === 'echo'));
});

test('refus : mauvais jeton, appel venant d\'une page web, serveur inconnu', async () => {
  assert.equal((await post({ 'x-fs-cli-token': 'f'.repeat(48) }, { action: 'tools', server: 'faux' })).status, 401);
  assert.equal((await post({ 'x-fs-cli-token': token, Origin: 'https://site-malveillant.example' }, { action: 'tools', server: 'faux' })).status, 403);
  assert.equal((await post({ 'x-fs-cli-token': token }, { action: 'tools', server: 'nexiste-pas' })).status, 404);
});

test('refus : serveur importé (Claude Code…) pas encore autorisé par l\'utilisateur', async () => {
  const r = await bridgeRequest({ action: 'call', server: 'importe', tool: 'echo', args: { text: 'x' } });
  assert.equal(r.status, 403); assert.match(r.error, /pas encore approuvé/);
});

test('fs-mcp passe par le pont de la session', async () => {
  const out = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(here, '..', 'mcp-cli.js'), 'call', 'faux', 'echo', 'text=via le pont'], { cwd: proj, env: { ...process.env } });
    let o = ''; p.stdout.on('data', d => o += d); p.on('close', code => res({ code, o }));
  });
  assert.equal(out.code, 0); assert.equal(out.o.trim(), 'via le pont');
  await mgr.closeAll(); br.server.close();
});
