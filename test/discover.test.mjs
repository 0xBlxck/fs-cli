// Import automatique des MCP et skills des autres assistants (Claude Code, Codex…) + commandes spéciales du moteur natif
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-disc-'));
const home = path.join(tmp, 'home'); const proj = path.join(tmp, 'projet');
fs.mkdirSync(proj, { recursive: true });
process.env.FS_CLI_HOME = path.join(tmp, 'fscli');
process.env.FS_IMPORT_HOME = home;
delete process.env.FS_CLI_BRIDGE;                                     // jamais le pont d'une vraie session pendant les tests
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');

const fake = path.join(here, 'mcp', 'fake-mcp-stdio.js');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
w(path.join(tmp, 'fscli', 'config.json'), JSON.stringify({ mcpAskImported: true }));   // ces tests vérifient le mode « demander avant » (/mcp ask on)
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
const { toolsHint, approveServer, mentionedServers } = await import('../src/pseudo.js');
const { loadMcpConfig } = await import('../src/mcp.js');
const { setSelectHandler } = await import('../src/agent.js');
const { cfg } = await import('../src/config.js');

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


// ── fs-mcp : le vrai programme que le modèle lance avec run_command ──
const CLI = path.join(here, '..', 'mcp-cli.js');
const fsmcp = (...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: proj, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, FS_CLI_HOME: process.env.FS_CLI_HOME, FS_IMPORT_HOME: home, APPDATA: process.env.APPDATA },
});

test('fs-mcp list / skills / skill : lecture, aucun serveur démarré', () => {
  const l = fsmcp('list');
  assert.equal(l.status, 0); assert.match(l.stdout, /faux \(configuré dans Claude Code, PAS encore approuvé\)/);
  const s = fsmcp('skills', 'site', 'web');
  assert.match(s.stdout, /site-web/); assert.match(s.stdout, /SKILL\.md/);
  assert.match(fsmcp('skill', 'site-web').stdout, /Utilise une grille/);
});

test('fs-mcp : un serveur importé non approuvé est REFUSÉ (le modèle ne peut pas le démarrer seul)', () => {
  const r = fsmcp('call', 'faux', 'echo', 'text=salut');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /pas encore approuvé/); assert.match(r.stderr, /\/mcp faux/);
});

test('accord donné dans FS-CLI → fs-mcp appelle vraiment l\'outil (arguments cle=valeur typés)', async () => {
  const asked = [];
  setSelectHandler(async (o) => { asked.push(o); return 0; });            // « Oui, autoriser ce serveur »
  const S = { cwd: proj, allow: {}, notes: [] };
  const ok = await approveServer(S, 'faux', loadMcpConfig(proj).mcpServers.faux, { ask: async () => '' });
  assert.equal(ok, true);
  assert.match(asked[0].title, /« faux » \(configuré dans Claude Code\)/);
  assert.deepEqual(asked[0].options, ['Oui, autoriser ce serveur', 'Non, et dire quoi faire à la place']);
  const t = fsmcp('tools', 'faux');
  assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /echo text\*=string upper=boolean/);
  const c = fsmcp('call', 'faux', 'echo', 'text=salut', 'upper=true');
  assert.equal(c.status, 0, c.stderr); assert.equal(c.stdout.trim(), 'SALUT');
  fs.writeFileSync(path.join(proj, 'long.txt'), 'ligne 1\nligne "2" avec guillemets\n');      // cle=@fichier : code / long texte
  const f = fsmcp('call', 'faux', 'echo', 'text=@long.txt');
  assert.equal(f.status, 0, f.stderr); assert.equal(f.stdout.trim(), 'ligne 1\nligne "2" avec guillemets');
  assert.match(fsmcp('call', 'faux', 'echo', 'text=@absent.txt').stderr, /Fichier introuvable/);
  const bad = fsmcp('call', 'faux', 'echo', 'pas-un-argument');
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /cle=valeur/);
  // un accord est lié à la commande du serveur : si elle change, il tombe
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  cj.mcpServers.faux.args = [fake, '--autre'];
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cj));
  assert.equal(fsmcp('call', 'faux', 'echo', 'text=x').status, 3, 'commande modifiée → nouvel accord nécessaire');
});

test('bloc d\'info envoyé au modèle : commande réelle, guides proches, aucune clé', () => {
  const hint = toolsHint(proj, 'crée un site web');
  assert.match(hint.text, /mcp-cli\.js" list/); assert.match(hint.text, /Serveurs MCP : .*faux/);
  assert.match(hint.text, /site-web → .*SKILL\.md/);
  assert.doesNotMatch(hint.text, /ne-doit-pas-partir/, 'les variables d\'environnement ne sont jamais envoyées au modèle');
  assert.ok(hint.sig && hint.sig === toolsHint(proj, 'autre chose').sig, 'signature stable : envoyé une fois par conversation');
  assert.deepEqual(mentionedServers(proj, 'fais-le avec le mcp faux'), ['faux']);
  assert.deepEqual(mentionedServers(proj, 'un truc faux'), [], 'nom court sans « mcp » : ignoré');
});

test('skills automatiques : chemins ignorés, skill d\'audit seulement si on demande un audit', async () => {
  const { autoSkills } = await import('../src/discover.js');
  const list = [
    { name: 'web-design-guidelines', description: 'Review UI code for Web Interface Guidelines compliance. Use when asked to check my site against best practices.' },
    { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces and web pages with high design quality.' },
  ];
  const names = q => autoSkills(list, q).map(s => s.name);
  assert.ok(!names('C:\Users\moi\Downloads\HTML SITE team ameliore un peu mon site').includes('web-design-guidelines'));
  assert.ok(names('audit l\'accessibilité de mon site web').includes('web-design-guidelines'));
});

test('index des skills (v3.45) : UNE ligne dans la conversation (sans nom d\'outil), la liste complète dans un fichier lisible sans confirmation', () => {
  const list = d.discoverSkills(proj, { refresh: true });
  const idx = d.skillIndex(list, proj);
  assert.ok(idx && idx.count === 2);
  assert.ok(!idx.text.includes('\n') && idx.text.length < 400, 'une seule ligne courte');
  assert.doesNotMatch(idx.text, /read_file|run_command|sans demander|outil/i, 'rien qui ressemble à un protocole d\'outils (refus de GPT)');
  assert.ok(idx.text.includes(idx.file));
  const content = fs.readFileSync(idx.file, 'utf8');
  assert.match(content, /site-web — Créer un beau site web/);
  assert.match(content, /excel — Tableurs et formules avancées/);
  assert.ok(d.isSkillPath(idx.file, proj), 'l\'index se lit sans confirmation');
  const again = d.skillIndex(list, proj);
  assert.equal(again.sig, idx.sig, 'même liste → même signature (pas de nouvel envoi)');
  assert.notEqual(d.skillIndex(list, path.join(tmp, 'autre-projet')).file, idx.file, 'un index par dossier de travail');
  assert.equal(d.skillIndex([], proj), null);
});

test('index des skills : lu SANS confirmation par read_file, alors qu\'il est rangé dans le dossier protégé .fs-cli', async () => {
  const { execCall } = await import('../src/agent.js');
  const idx = d.skillIndex(d.discoverSkills(proj, { refresh: true }), proj);
  let asked = 0;
  const S = { cwd: proj, undo: [], allow: {}, notes: [], tokens: { in: 0, out: 0 } };
  const r = await execCall(S, { name: 'read_file', args: { path: idx.file } }, { signal: new AbortController().signal, ask: async () => { asked++; return 'n'; }, root: proj });
  assert.equal(asked, 0, 'aucune question');
  assert.equal(r.ok, true); assert.match(r.output, /site-web/);
  const { sensitivePathReason } = await import('../src/permissions.js');
  assert.ok(sensitivePathReason(path.join(os.homedir(), '.fs-cli', 'config.json')), 'le reste de .fs-cli reste protégé');
});
