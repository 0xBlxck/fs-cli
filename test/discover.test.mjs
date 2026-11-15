// Import automatique des MCP et skills des autres assistants (Claude Code, Codex…) + commandes spéciales du moteur natif
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-disc-'));
const home = path.join(tmp, 'home'); const proj = path.join(tmp, 'projet');
fs.mkdirSync(proj, { recursive: true });
process.env.FS_CLI_HOME = path.join(tmp, 'fscli');
process.env.FS_IMPORT_HOME = home;
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');

const fake = path.join(here, 'mcp', 'fake-mcp-stdio.js');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
w(path.join(home, '.claude.json'), JSON.stringify({
  mcpServers: { faux: { type: 'stdio', command: process.execPath, args: [fake], env: { CLE_SECRETE: 'ne-doit-pas-partir' } }, web: { type: 'http', url: 'https://exemple.invalid/mcp' } },
  projects: { [proj]: { mcpServers: { local: { command: 'node', args: ['x.js'] } } } },
}));
w(path.join(home, '.codex', 'config.toml'), [
  'model = "gpt"', '', '[mcp_servers.node_repl]', 'command = \'C:\\outils\\repl.exe\'', 'args = ["--a", "b c"]', '',
  '[mcp_servers.node_repl.env]', 'NODE_PATH = "x"', '', '[mcp_servers.faux]', 'command = "autre"', '', '[features]', 'x = true',
].join('\n'));
w(path.join(home, '.claude', 'skills', 'site-web', 'SKILL.md'), '---\nname: site-web\ndescription: Créer un beau site web moderne et responsive\n---\n# Guide\nUtilise une grille.');
w(path.join(home, '.claude', 'skills', 'site-web', 'exemples', 'hero.html'), '<section>hero</section>');
w(path.join(home, '.codex', 'skills', 'excel', 'SKILL.md'), '---\nname: excel\ndescription: >\n  Tableurs et formules\n  avancées\n---\ncorps');
w(path.join(home, '.claude', 'plugins', 'marketplaces', 'm', 'skills', 'pas-installe', 'SKILL.md'), '---\nname: pas-installe\n---\n');

const d = await import('../src/discover.js');
const { runPseudo, toolsHint } = await import('../src/pseudo.js');
const { setSelectHandler } = await import('../src/agent.js');
const { cfg } = await import('../src/config.js');
const { getMcp } = await import('../src/mcp-runtime.js');

test('MCP : Claude Code (utilisateur + ce dossier) et Codex sont trouvés, le premier gagne', () => {
  const s = d.discoverMcpServers(proj);
  assert.deepEqual(Object.keys(s).sort(), ['faux', 'local', 'node_repl', 'web']);
  assert.equal(s.faux._source, 'Claude Code'); assert.equal(s.faux.command, process.execPath);
  assert.equal(s.local._source, 'Claude Code (ce dossier)');
  assert.equal(s.web.url, 'https://exemple.invalid/mcp');
  assert.equal(s.node_repl._source, 'Codex');
  assert.equal(s.node_repl.command, 'C:\\outils\\repl.exe');
  assert.deepEqual(s.node_repl.args, ['--a', 'b c']);
  assert.equal(s.node_repl.env.NODE_PATH, 'x');
});

test('skills : SKILL.md trouvés (Claude Code, Codex), description multi-ligne, catalogues de plugins ignorés', () => {
  const list = d.discoverSkills(proj, { refresh: true });
  assert.deepEqual(list.map(s => s.name).sort(), ['excel', 'site-web']);
  assert.equal(list.find(s => s.name === 'excel').description, 'Tableurs et formules avancées');
  assert.equal(d.searchSkills(list, 'fais moi un site web')[0].name, 'site-web');
  assert.ok(d.isSkillPath(path.join(home, '.claude', 'skills', 'site-web', 'exemples', 'hero.html'), proj));
  assert.ok(!d.isSkillPath(path.join(home, 'Documents', 'secret.txt'), proj));
});

test('/import off : plus rien n\'est importé', () => {
  cfg.importTools = false;
  assert.deepEqual(d.discoverMcpServers(proj), {});
  cfg.importTools = true;
});

test('commandes spéciales : skills, skill, mcp list — sans shell', async () => {
  const S = { cwd: proj, allow: {}, notes: [] };
  const io = { signal: new AbortController().signal, ask: async () => '' };
  const r1 = await runPseudo(S, 'skills site web', io);
  assert.ok(r1.ok); assert.match(r1.output, /site-web/);
  const r2 = await runPseudo(S, 'skill site-web', io);
  assert.match(r2.output, /Utilise une grille/); assert.match(r2.output, /hero\.html/);
  const r3 = await runPseudo(S, 'mcp list', io);
  assert.match(r3.output, /faux \(de Claude Code\)/);
  assert.equal(await runPseudo(S, 'npm test', io), null, 'une vraie commande n\'est pas interceptée');
  const hint = toolsHint(proj, 'crée un site web');
  assert.match(hint.text, /Serveurs MCP : .*faux/); assert.match(hint.text, /site-web/);
  assert.doesNotMatch(hint.text, /ne-doit-pas-partir/, 'les variables d\'environnement ne sont jamais envoyées au modèle');
});

test('serveur importé : accord demandé au 1er démarrage, refus respecté, puis appel d\'outil réel', async () => {
  cfg.mode = 'auto';
  const asked = [];
  let answer = 'Non';
  setSelectHandler(async (o) => { asked.push(o.title); return o.options.findIndex(x => x.startsWith(answer)); });
  const S = { cwd: proj, allow: {}, notes: [] };
  const io = { signal: new AbortController().signal, ask: async () => '' };
  const refused = await runPseudo(S, 'mcp faux.echo {"text":"salut"}', io);
  assert.equal(refused.ok, false); assert.match(refused.output, /refusé/);
  assert.match(asked[0], /« faux » \(configuré dans Claude Code\)/);
  answer = 'Oui, toujours';
  const ok = await runPseudo(S, 'mcp faux.echo {"text":"salut","upper":true}', io);
  assert.equal(ok.ok, true); assert.equal(ok.output, 'SALUT');
  const tools = await runPseudo({ cwd: proj, allow: {}, notes: [] }, 'mcp faux', io);   // nouvelle session : « toujours » mémorisé
  assert.match(tools.output, /echo\(text\*: string, upper: boolean\)/);
  assert.equal(asked.length, 2, 'plus de question après « toujours »');
  const bad = await runPseudo(S, 'mcp faux.echo pas-du-json', io);
  assert.match(bad.output, /objet JSON/);
  await getMcp(proj).closeAll?.();
});
