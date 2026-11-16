// Serveur MCP (fs-cli --mcp) et inscription dans les agents (fs-cli --install-mcp) — hors ligne : aucun appel à la vraie API
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-mcpsrv-'));
const fsHome = path.join(tmp, 'fscli'), home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.FS_CLI_HOME = fsHome;
process.env.FS_IMPORT_HOME = home;
process.env.FS_SESSION_TOKEN = 'faux-jeton-de-test';                 // jamais la vraie clé : un appel réseau par erreur échouerait (401) sans consommer de quota
const ENV = { ...process.env, FS_CLI_HOME: fsHome, FS_IMPORT_HOME: home, FS_SESSION_TOKEN: 'faux-jeton-de-test' };

const srv = await import('../src/mcp-server.js');
const { cfg, FILES } = await import('../src/config.js');
const { trustFolder } = await import('../src/trust.js');

/** lance « fs-cli --mcp », envoie les lignes, attend `want` réponses ; renvoie les messages reçus et la sortie brute */
function talk(lines, want) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, '--mcp'], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('délai dépassé : ' + out + err)); }, 30000);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => { out += d; if (out.split('\n').filter(Boolean).length >= want) p.stdin.end(); });
    p.stderr.on('data', d => { err += d; });
    p.on('close', () => { clearTimeout(timer); resolve({ raw: out, msgs: out.split('\n').filter(Boolean).map(l => JSON.parse(l)), err }); });
    for (const l of lines) p.stdin.write((typeof l === 'string' ? l : JSON.stringify(l)) + '\n');
  });
}

test('stdio : initialize, tools/list, méthode inconnue, dossier non approuvé — stdout ne contient que du JSON-RPC', async () => {
  const untrusted = fs.mkdtempSync(path.join(tmp, 'non-approuve-'));
  const { raw, msgs } = await talk([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'methode/inconnue' },
    { jsonrpc: '2.0', id: 4, method: 'ping' },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fs_agent', arguments: { task: 'crée a.txt', folder: untrusted } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'outil_inexistant', arguments: {} } },
  ], 6);
  for (const l of raw.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(l), `ligne non JSON sur stdout : ${l}`);
  const by = Object.fromEntries(msgs.map(m => [m.id, m]));
  assert.equal(msgs.length, 6, 'pas de réponse à la notification');
  assert.equal(by[1].result.protocolVersion, '2025-06-18');
  assert.ok(by[1].result.capabilities.tools);
  assert.equal(by[1].result.serverInfo.name, 'fs-cli');
  assert.deepEqual(by[2].result.tools.map(t => t.name), ['fs_models', 'fs_ask', 'fs_agent']);
  assert.deepEqual(by[2].result.tools.find(t => t.name === 'fs_agent').inputSchema.required, ['task', 'folder']);
  assert.equal(by[3].error.code, -32601);
  assert.deepEqual(by[4].result, {});
  assert.equal(by[5].result.isError, true);
  assert.match(by[5].result.content[0].text, /non approuvé/);
  assert.match(by[5].result.content[0].text, /fs-cli/);
  assert.ok(!fs.existsSync(path.join(untrusted, 'a.txt')));
  assert.equal(by[6].error.code, -32602);
});

test('sans clé de session : initialize et tools/list répondent, les outils expliquent comment se connecter', async () => {
  const s = srv.createMcpServer({ hasToken: () => false, stream: async () => { throw new Error('aucun appel réseau attendu'); }, fetchAgents: async () => null, fetchAgentsFull: async () => { throw new Error('aucun appel réseau attendu'); } });
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })).result.protocolVersion, '2024-11-05');
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 3);
  for (const [name, args] of [['fs_models', {}], ['fs_ask', { prompt: 'bonjour' }]]) {
    const r = (await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).result;
    assert.equal(r.isError, true); assert.match(r.content[0].text, /Lance « fs-cli » une fois/);
  }
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('fs_ask : une seule conversation réutilisée, nouvelle seulement sur demande, modèle résolu par son nom', async () => {
  const reqs = [];
  let n = 0;
  const stream = async o => { reqs.push({ chatId: o.chatId, agentId: o.agentId, content: o.content, clientTools: o.clientTools }); const id = `conv-${++n}`; if (!o.chatId) o.onChat?.(id); return { text: `réponse ${n}` }; };
  const s = srv.createMcpServer({ hasToken: () => true, stream, fetchAgents: async () => ({ '-2003': 'Claude Sonnet 5.5', '-1002': 'GPT-6 Luna' }) });
  const call = async args => (await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fs_ask', arguments: args } })).result;
  assert.equal((await call({ prompt: 'un', model: 'sonnet' })).content[0].text, 'réponse 1');
  await call({ prompt: 'deux' });
  await call({ prompt: 'trois', new_conversation: true });
  assert.deepEqual(reqs.map(r => r.chatId), [null, 'conv-1', null]);
  assert.equal(reqs[0].agentId, -2003);
  assert.ok(reqs.every(r => !r.clientTools), 'aucun outil client');
  assert.match(reqs[0].content, /^\[[0-9a-f]{4}\] un$/);
  const bad = await call({ prompt: 'x', model: 'modele-qui-nexiste-pas' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /inconnu/);
});

test('fs_agent : fichiers modifiés dans le dossier, tout ce qui demande une confirmation est refusé automatiquement', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'projet-'));
  trustFolder(dir);
  const outside = path.join(tmp, 'dehors.txt');
  const secret = 'const K = "sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";'; // scan-ignore
  const turns = [
    { calls: [
      { callId: '1', name: 'write_file', arguments: { path: 'hello.txt', content: 'Bonjour\n' } },
      { callId: '2', name: 'write_file', arguments: { path: outside, content: 'hors dossier' } },
      { callId: '3', name: 'run_command', arguments: { command: 'echo coucou' } },
      { callId: '4', name: 'write_file', arguments: { path: 'cle.js', content: secret } },
    ] },
    { text: 'Fait : hello.txt créé.' },
  ];
  const seen = [];
  let i = 0;
  const { runNative } = await import('../src/native.js');
  const { detectEnv } = await import('../src/tools.js');
  await detectEnv();
  const fakeStream = async o => { seen.push(o); if (!o.chatId) o.onChat?.('chat-agent'); const t = turns[i++] || { text: 'fin' }; if (t.text) o.onText?.(t.text); return { text: t.text || '', toolCalls: t.calls || [] }; };
  const modeBefore = cfg.mode;
  const notes = [];
  const s = srv.createMcpServer({ hasToken: () => true, notify: m => notes.push(m), fetchAgents: async () => null, runNative: (S, task, o) => runNative(S, task, { ...o, stream: fakeStream, ctxPct: async () => null }) });
  const r = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_agent', arguments: { task: 'crée hello.txt', folder: dir }, _meta: { progressToken: 'p1' } } })).result;
  const text = r.content[0].text;
  assert.ok(!r.isError, text);
  assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'Bonjour\n');
  assert.ok(!fs.existsSync(outside), 'rien écrit hors du dossier');
  assert.ok(!fs.existsSync(path.join(dir, 'cle.js')), 'secret non écrit');
  const res = seen[1].toolResults;
  assert.deepEqual(res.map(x => x.isError), [false, true, true, true]);
  assert.match(res[2].output, /refus automatique/);
  assert.match(text, /Fait : hello\.txt créé\./);
  assert.match(text, /hello\.txt \(créé\)/);
  assert.match(text, /Appels d'outils : 4\./);
  assert.match(text, /Actions refusées automatiquement \(3\)/);
  assert.ok(notes.length >= 1 && notes.every(m => m.method === 'notifications/progress' && m.params.progressToken === 'p1'), 'progression envoyée');
  assert.equal(cfg.mode, modeBefore, 'mode de l\'utilisateur rétabli');
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(FILES.cfg, 'utf8')); } catch {}
  assert.notEqual(saved.mode, 'edits', 'le mode imposé n\'est jamais enregistré');
  // 2e tâche dans le même dossier : même conversation
  turns.push({ text: 'encore' }); i = turns.length - 1;
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fs_agent', arguments: { task: 'et ensuite ?', folder: dir } } });
  assert.equal(seen.at(-1).chatId, 'chat-agent');
});

test('--install-mcp : ajoute « france-student » sans rien perdre, sauvegarde .bak, TOML ajouté une seule fois', () => {
  const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  const agy = path.join(home, '.gemini', 'config', 'mcp_config.json');
  const agyOrig = JSON.stringify({ mcpServers: { autre: { command: 'python', args: ['srv.py'] }, distant: { serverUrl: 'https://exemple.invalid/mcp' } } }, null, 2);
  w(agy, agyOrig);
  const ide = path.join(home, '.gemini', 'antigravity-ide', 'mcp_config.json');
  w(ide, '{ ceci n\'est pas du JSON');
  const claude = path.join(home, '.claude.json');
  w(claude, JSON.stringify({ numStartups: 3, projects: { x: { a: 1 } }, mcpServers: { faux: { type: 'stdio', command: 'node', args: ['f.js'] } } }));
  const toml = path.join(home, '.codex', 'config.toml');
  const tomlOrig = 'model = "gpt"\n\n[mcp_servers.node_repl]\ncommand = "repl"\n';
  w(toml, tomlOrig);

  const run = () => spawnSync(process.execPath, [CLI, '--install-mcp'], { env: ENV, encoding: 'utf8', timeout: 30000 });
  const r1 = run();
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /Redémarre/);
  const a = JSON.parse(fs.readFileSync(agy, 'utf8'));
  assert.deepEqual(Object.keys(a.mcpServers), ['autre', 'distant', 'france-student']);
  assert.equal(a.mcpServers['france-student'].command, process.execPath);
  assert.deepEqual(a.mcpServers['france-student'].args, [path.resolve(CLI), '--mcp']);
  assert.equal(fs.readFileSync(agy + '.bak', 'utf8'), agyOrig);
  assert.equal(fs.readFileSync(ide, 'utf8'), '{ ceci n\'est pas du JSON', 'JSON illisible laissé tel quel');
  assert.match(r1.stdout, /illisible/);
  const cj = JSON.parse(fs.readFileSync(claude, 'utf8'));
  assert.equal(cj.numStartups, 3); assert.deepEqual(cj.projects, { x: { a: 1 } }); assert.ok(cj.mcpServers.faux);
  assert.deepEqual(cj.mcpServers['france-student'], { type: 'stdio', command: process.execPath, args: [path.resolve(CLI), '--mcp'] });
  assert.ok(fs.existsSync(claude + '.bak'));
  const t1 = fs.readFileSync(toml, 'utf8');
  assert.ok(t1.startsWith(tomlOrig.trimEnd()), 'TOML existant conservé');
  assert.match(t1, /\[mcp_servers\.france-student\]\ncommand = ".*node(\.exe)?"\nargs = \[".*cli\.js", "--mcp"\]/);
  assert.equal(fs.readFileSync(toml + '.bak', 'utf8'), tomlOrig);

  const r2 = run();                                                  // 2e passage : rien ne change, aucune nouvelle sauvegarde
  assert.match(r2.stdout, /déjà à jour/); assert.match(r2.stdout, /déjà présent/);
  assert.equal(fs.readFileSync(toml, 'utf8'), t1);
  assert.equal((fs.readFileSync(toml, 'utf8').match(/\[mcp_servers\.france-student\]/g) || []).length, 1);
  assert.equal(fs.readdirSync(path.dirname(agy)).filter(f => f.includes('.bak')).length, 1);
});

test('--install-mcp ne touche jamais au vrai dossier personnel pendant les tests', () => {
  const saved = process.env.FS_IMPORT_HOME;
  delete process.env.FS_IMPORT_HOME;
  try { assert.equal(srv.installHome(), null); assert.deepEqual(srv.installMcp(), []); }
  finally { process.env.FS_IMPORT_HOME = saved; }
});

test('fs_ask : une image générée par France Student est renvoyée à l\'agent appelant (contenu MCP « image »)', async () => {
  const { createMcpServer } = await import('../src/mcp-server.js');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const srv = createMcpServer({
    hasToken: () => true, fetchAgents: async () => ({ '-1002': 'GPT 6 Luna' }),
    stream: async o => { o.onChat?.('chat-img'); return { text: 'Voici.', toolCalls: [], sawImage: true, images: [{ id: 'abc12345', url: '/chats/chat-img/messages/m/images/abc12345', contentType: 'image/png', ext: 'png', prompt: 'un chat' }] }; },
    fetchApiFile: async () => png,
  });
  const r = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_ask', arguments: { prompt: 'une image', model: '-1002' } } });
  const img = r.result.content.find(c => c.type === 'image');
  assert.ok(img, JSON.stringify(r.result));
  assert.equal(img.mimeType, 'image/png');
  assert.equal(Buffer.from(img.data, 'base64').toString('hex'), png.toString('hex'));
});
