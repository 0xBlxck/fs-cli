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
  assert.deepEqual(by[2].result.tools.map(t => t.name), ['fs_models', 'fs_ask', 'fs_agent', 'fs_image', 'fs_web', 'fs_files', 'fs_conversations', 'fs_usage']);
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
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 8);
  for (const [name, args] of [['fs_models', {}], ['fs_ask', { prompt: 'bonjour' }], ['fs_image', { prompt: 'un chat' }], ['fs_web', { question: 'q' }], ['fs_files', { paths: ['/x.png'], prompt: 'p' }], ['fs_conversations', {}], ['fs_usage', {}]]) {
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
  assert.match(reqs[0].content, /^\[[0-9a-f]{4}·mcp\] un$/);
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
  cfg.mcpChat = null;                                                  // pas de conversation du MCP retenue d'un test précédent
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

test('conversation du MCP : retenue d\'un démarrage à l\'autre, conversation_id ponctuel, conversation supprimée → une neuve', async () => {
  cfg.mcpChat = null; cfg.mcpAskWhere = true;
  const reqs = [];
  let n = 0;
  const stream = async o => {
    reqs.push(o.chatId);
    if (o.chatId === 'supprimee-123') throw new Error('Chat not found with id supprimee-123');
    if (!o.chatId) o.onChat?.(`mcp-${++n}`);
    return { text: 'ok' };
  };
  const mk = () => srv.createMcpServer({ hasToken: () => true, stream, fetchAgents: async () => ({ '-2003': 'Claude Sonnet 5.5' }) });
  const ask = async (s, args) => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_ask', arguments: args } })).result;
  await ask(mk(), { prompt: 'un' });
  let saved = JSON.parse(fs.readFileSync(FILES.cfg, 'utf8'));
  assert.equal(saved.mcpChat?.id, 'mcp-1', 'conversation enregistrée dans la config');
  await ask(mk(), { prompt: 'deux' });                                  // « redémarrage » : nouveau serveur, même conversation
  assert.equal(reqs.at(-1), 'mcp-1');
  const s = mk();
  await ask(s, { prompt: 'ailleurs', conversation_id: 'autre-conv-42' });
  assert.equal(reqs.at(-1), 'autre-conv-42', 'conversation_id utilisé');
  assert.equal(cfg.mcpChat.id, 'mcp-1', 'sans changer la conversation retenue');
  await ask(s, { prompt: 'trois' });
  assert.equal(reqs.at(-1), 'mcp-1');
  cfg.mcpChat = { id: 'supprimee-123' };                                // supprimée sur le site
  const r = await ask(mk(), { prompt: 'quatre' });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(reqs.slice(-2), ['supprimee-123', null]);
  assert.equal(cfg.mcpChat.id, 'mcp-2');
});

test('IDE avec formulaires (elicitation) : choix de la conversation et du projet avec des boutons, une fois par session', async () => {
  cfg.mcpChat = { id: 'mcp-ancienne', title: '[ab12·mcp] vieux' }; cfg.mcpAskWhere = true; cfg.mcpProject = 'same';
  const reqs = [], sent = [];
  let answer = null;
  let s;
  const notify = m => { sent.push(m); if (m.method === 'elicitation/create') setImmediate(() => s.handle({ jsonrpc: '2.0', id: m.id, result: answer(m) })); };
  const stream = async o => { reqs.push(o.chatId); if (!o.chatId) o.onChat?.('neuve-1'); return { text: 'ok' }; };
  s = srv.createMcpServer({ hasToken: () => true, notify, stream, fetchAgents: async () => ({ '-2003': 'Claude Sonnet 5.5' }),
    listChats: async () => [{ id: 'site-conv-777', title: 'Mes révisions' }, { id: 'mcp-ancienne', title: 'doublon' }],
    listProjects: async () => [{ id: 'proj-1', name: 'Cours' }] });
  await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } });
  const ask = async args => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_ask', arguments: args } })).result;
  // 1) l'utilisateur ferme la fenêtre : rien n'est envoyé
  answer = () => ({ action: 'cancel' });
  const r0 = await ask({ prompt: 'x' });
  assert.equal(r0.isError, true); assert.match(r0.content[0].text, /rien n'a été envoyé/);
  assert.equal(reqs.length, 0);
  // 2) il choisit une conversation du site
  answer = m => {
    const p = m.params.requestedSchema.properties;
    assert.deepEqual(p.conversation.enum, ['keep', 'new', 'chat:site-conv-777'], 'la conversation du MCP n\'apparaît qu\'une fois');
    assert.match(p.conversation.enumNames[0], /« vieux »/);
    assert.equal(p.conversation.enumNames[2], 'Conversation « Mes révisions »');
    assert.deepEqual(p.project.enum, ['same', 'none', 'project:proj-1']);
    return { action: 'accept', content: { conversation: 'chat:site-conv-777', project: 'same', remember: false } };
  };
  await ask({ prompt: 'y' });
  assert.equal(reqs.at(-1), 'site-conv-777');
  assert.equal(cfg.mcpChat.id, 'site-conv-777');
  // 3) plus de question pendant la session
  const before = sent.filter(m => m.method === 'elicitation/create').length;
  await ask({ prompt: 'z' });
  assert.equal(sent.filter(m => m.method === 'elicitation/create').length, before);
  assert.equal(reqs.at(-1), 'site-conv-777');
  // 4) nouvelle session : nouvelle conversation rangée dans aucun projet, choix retenu
  answer = () => ({ action: 'accept', content: { conversation: 'new', project: 'none', remember: true } });
  s = srv.createMcpServer({ hasToken: () => true, notify, stream, fetchAgents: async () => ({ '-2003': 'Claude Sonnet 5.5' }), listChats: async () => [], listProjects: async () => [{ id: 'proj-1', name: 'Cours' }] });
  await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } });
  await ask({ prompt: 'w' });
  assert.equal(reqs.at(-1), null);
  assert.equal(cfg.mcpChat.id, 'neuve-1');
  const saved = JSON.parse(fs.readFileSync(FILES.cfg, 'utf8'));
  assert.equal(saved.mcpAskWhere, false, 'ne plus demander');
  assert.equal(saved.mcpProject, false, 'aucun projet');
  // 5) un IDE sans formulaires : aucune question, choix enregistré
  cfg.mcpAskWhere = true; sent.length = 0;
  s = srv.createMcpServer({ hasToken: () => true, notify, stream, fetchAgents: async () => ({ '-2003': 'Claude Sonnet 5.5' }), listChats: async () => [], listProjects: async () => [] });
  await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await ask({ prompt: 'v' });
  assert.equal(sent.length, 0);
  assert.equal(reqs.at(-1), 'neuve-1');
  const { setProjectOverride } = await import('../src/api.js');
  setProjectOverride(undefined);
});

test('fs_agent : dossier non approuvé → l\'IDE demande à l\'utilisateur (Oui / Non), jamais pour le dossier personnel', async () => {
  const { isFolderTrusted } = await import('../src/trust.js');
  cfg.mcpAskWhere = false;
  const asked = [];
  let answer = 'no', s;
  const notify = m => { if (m.method === 'elicitation/create') { asked.push(m.params.message); setImmediate(() => s.handle({ jsonrpc: '2.0', id: m.id, result: { action: 'accept', content: { trust: answer } } })); } };
  s = srv.createMcpServer({ hasToken: () => true, notify, fetchAgents: async () => null, runNative: async S => { S.lastResponse = 'fait'; } });
  await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } });
  const run = async folder => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_agent', arguments: { task: 't', folder } } })).result;
  const dir = fs.mkdtempSync(path.join(tmp, 'pas-approuve-'));
  const r1 = await run(dir);
  assert.equal(r1.isError, true); assert.match(r1.content[0].text, /non approuvé/);
  assert.equal(asked.length, 1); assert.ok(asked[0].includes(dir));
  assert.equal(isFolderTrusted(dir), false);
  answer = 'always';
  const r2 = await run(dir);
  assert.notEqual(r2.isError, true, JSON.stringify(r2));
  assert.equal(isFolderTrusted(dir), true, 'approuvé par l\'utilisateur');
  asked.length = 0;
  await run(dir);
  assert.equal(asked.length, 0, 'plus de question ensuite');
  const r3 = await run(os.homedir());
  assert.equal(r3.isError, true);
  assert.equal(asked.length, 0, 'jamais proposé pour le dossier personnel');
  cfg.mcpAskWhere = true;
});

test('nouveaux outils : fs_image (GPT choisi), fs_web (recherche web), fs_files (envoi + refus des secrets), fs_conversations, fs_usage', async () => {
  cfg.mcpChat = null; cfg.mcpAskWhere = false;
  const reqs = [], uploads = [];
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const stream = async o => {
    reqs.push({ agentId: o.agentId, web: o.webSearch, files: o.files, content: o.content, chatId: o.chatId });
    if (!o.chatId) o.onChat?.('mcp-outils');
    if (/Génère une image/.test(o.content)) return { text: 'Voici.', sawImage: true, images: [{ id: 'img12345', url: '/x', contentType: 'image/png', ext: 'png' }] };
    return { text: 'ok' };
  };
  const s = srv.createMcpServer({
    hasToken: () => true, stream, fetchApiFile: async () => png,
    fetchAgents: async () => ({ '-2003': 'Claude Sonnet 5.5', '-1002': 'GPT-6 Luna', '-1003': 'GPT-6.1 Sol' }),
    fetchAgentsFull: async () => ({ data: [{ id: -2003, name: 'Claude Sonnet 5.5', modelProvider: 'anthropic' }, { id: -1002, name: 'GPT-6 Luna', modelProvider: 'openai' }, { id: -1003, name: 'GPT-6.1 Sol', modelProvider: 'openai' }] }),
    upload: async (buf, name, mime) => { uploads.push({ name, mime }); return `file-${uploads.length}`; },
    listChats: async () => [{ id: 'site-aaaa-1111', title: '[ab12] Révisions bac', createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }],
    listProjects: async () => [{ id: 'p1', name: 'Cours' }],
    projectChats: async () => [{ id: 'proj-bbbb-2222', title: 'Chapitre 3', createdAt: '2020-01-01T00:00:00Z' }],
    fetchChat: async id => ({ title: 'Révisions bac', chatMessages: [{ role: 'user', content: '[ab12] Explique la photosynthèse' }, { role: 'assistant', content: 'La photosynthèse…' }] }),
    userUsage: async () => ({ chatBudget: { remainingPercent: 72, resetAt: new Date().toISOString() }, rateLimits: [] }),
  });
  const call = async (name, args) => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

  const img = await call('fs_image', { prompt: 'un chat roux' });
  assert.ok(img.content.some(c => c.type === 'image'), JSON.stringify(img));
  assert.equal(reqs.at(-1).agentId, -1003, 'GPT Sol choisi pour les images');
  const notGpt = await call('fs_image', { prompt: 'x', model: 'sonnet' });
  assert.equal(notGpt.isError, true); assert.match(notGpt.content[0].text, /ne génère pas d'images/);

  await call('fs_web', { question: 'dernière version de Node ?' });
  assert.equal(reqs.at(-1).web, true);
  await call('fs_ask', { prompt: 'sans web' });
  assert.equal(reqs.at(-1).web, false);

  const dir = fs.mkdtempSync(path.join(tmp, 'fichiers-'));
  fs.writeFileSync(path.join(dir, 'capture.png'), png); fs.writeFileSync(path.join(dir, 'notes.md'), '# Titre\nbonjour');
  await call('fs_files', { paths: [path.join(dir, 'capture.png'), path.join(dir, 'notes.md')], prompt: 'Analyse' });
  assert.deepEqual(uploads, [{ name: 'capture.png', mime: 'image/png' }]);
  assert.deepEqual(reqs.at(-1).files, ['file-1']);
  assert.match(reqs.at(-1).content, /--- notes\.md ---\n# Titre/);
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  const secret = await call('fs_files', { paths: [path.join(dir, '.env')], prompt: 'lis' });
  assert.equal(secret.isError, true); assert.match(secret.content[0].text, /Refusé/);
  assert.equal(uploads.length, 1, 'rien envoyé');

  const list = (await call('fs_conversations', {})).content[0].text;
  assert.match(list, /Révisions bac · id site-aaaa-1111/);
  assert.match(list, /Chapitre 3 · id proj-bbbb-2222 · projet « Cours »/);
  const read = (await call('fs_conversations', { action: 'read', conversation_id: 'site-aaaa-1111' })).content[0].text;
  assert.match(read, /Utilisateur : Explique la photosynthèse/);
  await call('fs_conversations', { action: 'select', conversation_id: 'site-aaaa-1111' });
  await call('fs_ask', { prompt: 'suite' });
  assert.equal(reqs.at(-1).chatId, 'site-aaaa-1111', 'conversation choisie utilisée');

  const usage = (await call('fs_usage', {})).content[0].text;
  assert.match(usage, /72 % restant/);
  assert.match(usage, /Nouvelles conversations aujourd'hui : \d+ \/ 50/);
  cfg.mcpAskWhere = true; cfg.mcpChat = null;
});

test('MCP : une nouvelle conversation reçoit un titre lisible sur le site (« MCP · … »), une conversation existante n\'est pas renommée', async () => {
  cfg.mcpChat = null; cfg.mcpAskWhere = false;
  const renamed = [];
  const stream = async o => { if (!o.chatId) o.onChat?.('mcp-titre-1'); return { text: 'ok' }; };
  const s = srv.createMcpServer({ hasToken: () => true, stream, fetchAgents: async () => ({ '-2003': 'Claude Sonnet 5.5' }), rename: async (id, t) => { renamed.push([id, t]); return true; } });
  const ask = async a => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_ask', arguments: a } })).result;
  await ask({ prompt: '[ab12] explique-moi les promesses JavaScript' });
  await ask({ prompt: 'et async/await ?' });
  assert.deepEqual(renamed, [['mcp-titre-1', 'MCP · Explique-moi les promesses JavaScript']]);
  cfg.mcpAskWhere = true; cfg.mcpChat = null;
});
