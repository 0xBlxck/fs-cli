import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttp } from './fake-mcp-http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
const home = path.join(tmp, 'home'); const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
process.env.FS_CLI_HOME = path.join(home, '.fs-cli'); // dossier absent exprès

const { PRESETS, loadMcpConfig, saveMcpConfig, McpManager, toolsCatalog, parseMcpBlock, trustProject } = await import('../../src/mcp.js');

let pass = 0, fail = 0;
const H = (l) => console.log('   [H]', l, process._getActiveHandles().filter(h=>h.pid).map(h=>h.pid+':'+h.spawnargs.join(' ').slice(-40)).join(' | '));
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

// ── config ──
console.log('config');
t('config absente = vide', Object.keys(loadMcpConfig(proj).mcpServers).length === 0);
t('PRESETS 9 entrées', Object.keys(PRESETS).length === 9 && PRESETS.playwright && PRESETS['sequential-thinking'], Object.keys(PRESETS));
const http = await startHttp();
const fake = path.join(here, 'fake-mcp-stdio.js');
const userCfg = { mcpServers: { fake: { command: 'node', args: [fake], description: 'user fake' }, shared: { command: 'echo-user' } } };
let r = saveMcpConfig('user', proj, userCfg);
t('save user crée ~/.fs-cli', r.ok && fs.existsSync(path.join(home, '.fs-cli', 'mcp.json')), r);
fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
  shared: { command: 'echo-projet', disabled: true },
  space: { command: 'node', args: [path.join(here, 'dir with space', 'fake.js')], description: 'chemin avec espace' },
  web: { url: `http://127.0.0.1:${http.port}/mcp`, description: 'http' },
  legacy: { url: `http://127.0.0.1:${http.port}/sse` },
  auth: { url: `http://127.0.0.1:${http.port}/auth` },
  nocmd: { command: 'cette-commande-nexiste-pas-xyz' },
  crash: { command: 'node', args: ['-e', 'console.error("boum"); process.exit(3)'] },
  off: { command: 'node', args: [fake], disabled: true },
} }));
let cfg = loadMcpConfig(proj);
t('fusion + priorité projet', cfg.mcpServers.shared.command === 'echo-projet' && cfg.mcpServers.shared._scope === 'projet' && cfg.mcpServers.fake._scope === 'user', cfg.mcpServers.shared);
const projBad = path.join(tmp, 'projbad'); fs.mkdirSync(projBad); fs.writeFileSync(path.join(projBad, '.mcp.json'), '{nope');
const cb = loadMcpConfig(projBad);
t('JSON invalide -> _error, pas d\'exception, user conservé', typeof cb._error === 'string' && cb.mcpServers.fake, cb._error);
// save projet : ne doit pas écrire les entrées user
const projCfg = loadMcpConfig(proj);
projCfg.mcpServers.extra = { command: 'x', _tmp: 1 };
r = saveMcpConfig('projet', proj, projCfg);
const written = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
t('save projet filtre _ et scope user', r.ok && !written.mcpServers.fake && written.mcpServers.extra && !('_tmp' in written.mcpServers.extra) && !('_scope' in written.mcpServers.shared), written);
trustProject(proj);   // approbation après la dernière écriture de .mcp.json (elle est liée à son contenu)
t('save scope invalide', saveMcpConfig('x', proj, {}).ok === false);

// ── manager stdio ──
console.log('manager stdio');
const logs = [];
const mgr = new McpManager({ cwd: proj, onLog: (m) => logs.push(m) });
let list = await mgr.list();
t('list sans connexion', list.length === 10 && list.find((s) => s.name === 'fake').connected === false && list.find((s) => s.name === 'web').transport === 'http', list);
const tools = await mgr.listTools('fake');
t('listTools paginé (6 outils)', tools.length === 6 && tools[0].name === 'echo' && tools[0].inputSchema.required[0] === 'text', tools.map((x) => x.name));
list = await mgr.list();
t('list après connexion', list.find((s) => s.name === 'fake').connected && list.find((s) => s.name === 'fake').toolCount === 6);
let c = await mgr.callTool('fake', 'echo', { text: 'salut é' });
t('callTool echo', c.ok && c.text === 'salut é' && !c.isError, c);
c = await mgr.callTool('fake', 'echo', { text: 'abc', upper: true });
t('callTool echo upper', c.text === 'ABC');
c = await mgr.callTool('fake', 'fail', {});
t('callTool isError', c.ok && c.isError && c.text === 'ça a échoué', c);
c = await mgr.callTool('fake', 'img', {});
t('callTool image+resource', c.text === 'voici\n[image image/png, 5 octets]\n[ressource file:///x.txt]\ncontenu', c.text);
c = await mgr.callTool('fake', 'nope', {});
t('erreur JSON-RPC -> ok:false', c.ok === false && c.isError && /Unknown tool: nope/.test(c.text), c);
c = await mgr.callTool('fake', 'replies', {});
const reps = JSON.parse(c.text);
t('réponses aux requêtes serveur (ping -> {}, roots/list -> -32601)', reps.find((x) => x.id === 's1')?.result && reps.find((x) => x.id === 's2')?.error?.code === -32601, reps);
let t0 = Date.now();
c = await mgr.callTool('fake', 'slow', {}, { timeoutMs: 700 });
t('timeout', c.ok === false && c.timedOut && Date.now() - t0 < 2500, c);
c = await mgr.callTool('fake', 'echo', { text: 'après timeout' });
t('connexion toujours utilisable après timeout', c.ok && c.text === 'après timeout', c);
const ac = new AbortController(); setTimeout(() => ac.abort(), 300); t0 = Date.now();
c = await mgr.callTool('fake', 'slow', {}, { signal: ac.signal });
t('annulation par signal', c.ok === false && c.aborted && Date.now() - t0 < 2500, c);
const pre = AbortSignal.abort();
c = await mgr.callTool('fake', 'echo', { text: 'x' }, { signal: pre });
t('signal déjà annulé', c.ok === false && c.aborted);
c = await mgr.callTool('inconnu', 'x', {});
t('serveur inconnu', c.ok === false && /inconnu/.test(c.text));
c = await mgr.callTool('off', 'x', {});
t('serveur désactivé refusé', c.ok === false && /désactivé/.test(c.text));
t('stderrTail', /demarrage/.test(mgr.stderrTail('fake')), mgr.stderrTail('fake'));

H('avant console.log(test());');
console.log('test()');
let tr = await mgr.test('space');
t('test chemin avec espace (quoting)', tr.ok && tr.tools.length === 6, tr);
tr = await mgr.test('off');
t('test serveur désactivé OK quand même', tr.ok, tr);
tr = await mgr.test('nocmd', 8000);
t('test commande introuvable', !tr.ok && /introuvable/i.test(tr.error), tr);
console.log('     ->', JSON.stringify(tr.error));
tr = await mgr.test('crash', 8000);
t('test crash : code + stderr', !tr.ok && /code 3/.test(tr.error) && /boum/.test(tr.error), tr);
tr = await mgr.test('inexistant');
t('test inconnu', !tr.ok);
t0 = Date.now();
{
  const f = path.join(home, '.fs-cli', 'mcp.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.mcpServers.mute = { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] };
  fs.writeFileSync(f, JSON.stringify(j));
}
tr = await mgr.test('mute', 1200);
t('test timeout serveur muet', !tr.ok && /Délai dépassé/.test(tr.error) && Date.now() - t0 < 4000, tr);

H('avant console.log(http);');
console.log('http');
tr = await mgr.test('web');
t('test http (SSE + JSON)', tr.ok && tr.tools.length === 3, tr);
t('session id renvoyé', http.state.sessionOk >= 2 && http.state.badSession === 0, http.state);
t('DELETE de session à la fermeture du test', http.state.deleted === 1, http.state);
c = await mgr.callTool('web', 'sum', { a: 2, b: 40 });
t('callTool http JSON direct', c.ok && c.text === '42', c);
c = await mgr.callTool('web', 'sse_tool', {});
t('callTool http SSE', c.ok && c.text === 'flux sse ok', c);
t0 = Date.now();
c = await mgr.callTool('web', 'hang', {}, { timeoutMs: 600 });
t('http timeout', !c.ok && c.timedOut && Date.now() - t0 < 2500, c);
const ac2 = new AbortController(); setTimeout(() => ac2.abort(), 200);
c = await mgr.callTool('web', 'hang', {}, { signal: ac2.signal });
t('http annulation', !c.ok && c.aborted, c);
tr = await mgr.test('legacy');
t('/sse 405 -> message explicite', !tr.ok && /ancien transport SSE/.test(tr.error), tr);
tr = await mgr.test('auth');
t('401 message', !tr.ok && /OAuth/.test(tr.error) && /Authorization/.test(tr.error), tr);
{
  const f = path.join(proj, '.mcp.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.mcpServers.down = { url: 'http://127.0.0.1:1/mcp' };
  fs.writeFileSync(f, JSON.stringify(j));
  trustProject(proj);   // le contenu a changé : nouvelle approbation nécessaire
}
tr = await mgr.test('down');
t('http inaccessible', !tr.ok && /Connexion impossible/.test(tr.error), tr);

H('avant console.log(toolsCat');
console.log('toolsCatalog');
const cat = await toolsCatalog(mgr);
console.log(cat.split('\n').map((l) => '     | ' + l).join('\n'));
const lines = cat.split('\n');
t('catalogue : echo avec requis*', lines.some((l) => l.startsWith('fake.echo(text*, upper) — ')), lines);
t('catalogue : desc ≤100', lines.every((l) => !l.includes(' — ') || l.split(' — ').slice(1).join(' — ').length <= 100));
t('catalogue : ignore désactivés et en échec', !/^off\./m.test(cat) && !/^nocmd\./m.test(cat) && !/^crash\./m.test(cat) && /^web\.sum\(a\*, b\*\)/m.test(cat));
const small = await toolsCatalog(mgr, { maxToolsPerServer: 2 });
t('maxToolsPerServer', /fake: … \+4 autres/.test(small), small);
{
  const saved = process.env.FS_CLI_HOME; process.env.FS_CLI_HOME = path.join(tmp, 'vide');
  const m2 = new McpManager({ cwd: path.join(tmp, 'projbad') });
  t('catalogue vide (aucune config valide)', (await toolsCatalog(m2)) === '');
  await m2.closeAll(); process.env.FS_CLI_HOME = saved;
}

H('avant console.log(parseMcp');
console.log('parseMcpBlock');
const P = parseMcpBlock;
t('a.b', JSON.stringify(P('mcp blender.get_scene_info', '')) === '{"server":"blender","tool":"get_scene_info","args":{}}');
t('a b', P('mcp blender get_scene_info', '{}')?.tool === 'get_scene_info');
t('mcp:a.b', P('mcp:blender.get_scene_info', '{"x":1}')?.args.x === 1);
t('mcp: a.b', P('  mcp: blender.get_scene_info  ', ' \n ')?.server === 'blender');
t('outil avec point', P('mcp srv.dotted.tool', '{}')?.tool === 'dotted.tool');
t('JSON invalide -> null', P('mcp a.b', '{oops') === null);
t('corps tableau -> null', P('mcp a.b', '[1]') === null);
t('corps null -> null', P('mcp a.b', 'null') === null);
t('pas mcp -> null', P('js', '{}') === null && P('mcpx a.b', '{}') === null && P('', '') === null && P(undefined) === null);
t('sans outil -> null', P('mcp blender', '{}') === null && P('mcp blender.', '{}') === null && P('mcp .x', '{}') === null);
t('trop de tokens -> null', P('mcp a b c', '{}') === null);

H('avant console.log(fermetur');
console.log('fermeture');
await mgr.closeAll(); await mgr.closeAll();
t('closeAll idempotent + list', (await mgr.list()).every((s) => !s.connected));
const after = await mgr.callTool('fake', 'echo', { text: 'reconnexion' });
t('reconnexion après closeAll', after.ok && after.text === 'reconnexion');
H('avant mgr.setCwd(tmp);');
mgr.setCwd(tmp);
const l2 = (await mgr.list()).map((s) => s.name).sort().join(',');
t('setCwd change la config (user seul)', l2 === 'fake,mute,shared', l2);
await mgr.closeAll(); http.server.close(); http.server.closeAllConnections?.();
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => { console.log('handles:', process._getActiveHandles().map((h) => h.constructor.name + (h.pid ? ':' + h.pid + ' ' + h.spawnargs.join(' ').slice(0,200) : ''))); }, 1500).unref();
console.log(logs.join('\n'));
