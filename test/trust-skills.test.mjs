// Signalé : dans le panneau (Antigravity), choisir son dossier personnel tournait en boucle (« Choisir un autre dossier… » → même
// question) ; et /skills ne montrait que les 5 profils intégrés, pas les skills de ~/.claude/skills que le modèle utilise pourtant.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-trust-'));
const CLI = new URL('../cli.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** vrai cli.js en --stdio (comme le panneau), lancé depuis le dossier personnel (dossier « très large ») ; rien n'est envoyé au modèle */
function runTrust(answer) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.writeFileSync(path.join(home, '.env'), 'FS_SESSION_TOKEN=jeton-de-test\n');
  const p = spawn(process.execPath, [CLI, '--stdio'], { cwd: os.homedir(), env: { ...process.env, FS_CLI_HOME: home, FS_CLI_NO_UPDATE_CHECK: '1', FS_IMPORT_HOME: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const say = m => p.stdin.write(JSON.stringify(m) + '\n');
  const seen = { questions: [], cwd: null, exit: null, home, warned: false };
  let buf = '', asks = 0;
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); try { say({ type: 'quit' }); p.stdin.end(); } catch {} setTimeout(() => { p.kill(); resolve(seen); }, 300); };
    const timer = setTimeout(done, 25000);
    p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith('\x1e')) continue;
        let e; try { e = JSON.parse(line.slice(1)); } catch { continue; }
        if (e.type === 'select' && /confiance/i.test(e.title || '')) {
          seen.questions.push(e.options);
          say({ type: 'select', id: e.id, index: answer.select(e.options, seen.questions.length) });
        } else if (e.type === 'select') say({ type: 'select', id: e.id, index: 0 });
        if (e.type === 'ask') say({ type: 'ask', id: e.id, text: answer.path(++asks) });
        if (e.type === 'pickFolder') say({ type: 'folderPicked', purpose: e.purpose || 'trust', path: answer.path(++asks) });
        if (e.type === 'print' && /dossier très large/.test(e.text || '')) seen.warned = true;
        if (e.type === 'status' && e.cwd && seen.questions.length) { seen.cwd = e.cwd; done(); }
      }
    });
    p.on('exit', code => { seen.exit = code; done(); });
  });
}
const pick = start => (opts, n) => opts.findIndex(o => o.startsWith(n === 1 ? start : 'Non'));

test('dossier personnel choisi soi-même dans le sélecteur : accepté pour la session, sans reposer la question (plus de boucle)', async () => {
  const r = await runTrust({ select: pick('Choisir un autre dossier'), path: () => os.homedir() });
  assert.equal(r.questions.length, 1, 'une seule question');
  assert.ok(r.questions[0].includes('Oui, toujours pour ce dossier (très large)'), 'option « toujours » proposée pour un dossier très large');
  assert.equal(path.resolve(r.cwd).toLowerCase(), path.resolve(os.homedir()).toLowerCase());
  assert.ok(r.warned, 'avertissement « dossier très large » affiché');
  assert.ok(!fs.existsSync(path.join(r.home, 'trusted-folders.json')), 'pas retenu pour toujours sans le demander');
});

test('sélecteur fermé sans choix : la question revient (avant : FS-CLI s\'arrêtait, puis le panneau le relançait en boucle)', async () => {
  const r = await runTrust({ select: pick('Choisir un autre dossier'), path: () => '' });
  assert.equal(r.questions.length, 2, 'question reposée');
  assert.equal(r.exit, 0, 'arrêt seulement après « Non »');
});

test('« Oui, toujours pour ce dossier (très large) » : retenu, plus de question aux lancements suivants', async () => {
  const r = await runTrust({ select: pick('Oui, toujours'), path: () => '' });
  assert.equal(r.questions.length, 1);
  assert.ok(r.cwd);
  const trusted = JSON.parse(fs.readFileSync(path.join(r.home, 'trusted-folders.json'), 'utf8'));
  assert.ok(trusted.some(t => path.resolve(t).toLowerCase() === path.resolve(os.homedir()).toLowerCase()));
});

test('/skills liste les skills du PC (~/.claude/skills…) avant les profils ; /skills <mot> cherche ; /skill <nom> désactive puis réactive', async () => {
  const fake = fs.mkdtempSync(path.join(tmp, 'pc-'));
  for (const [n, d] of [['demo-pdf', 'Lire et créer des PDF'], ['roblox-ui', 'Interfaces Roblox']]) {
    fs.mkdirSync(path.join(fake, '.claude', 'skills', n), { recursive: true });
    fs.writeFileSync(path.join(fake, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${d}\n---\n# ${n}`);
  }
  process.env.FS_CLI_HOME = path.join(tmp, 'cfg'); process.env.FS_IMPORT_HOME = fake;
  const ui = await import('../src/ui.js');
  const { extraCommand } = await import('../src/extra-commands.js');
  const { cfg } = await import('../src/config.js');
  const S = { cwd: fs.mkdtempSync(path.join(tmp, 'proj-')), notes: [], toolsHintSig: 'x', skillsCatSig: 'x' };
  const run = async (cmd, arg) => { const out = []; ui.attachSink({ print: t => out.push(t) }); try { await extraCommand(cmd, arg, { S }); } finally { ui.attachSink(null); } return ui.stripAnsi(out.join('\n')); };
  const list = await run('/skills', '');
  assert.match(list, /Skills de ton PC · 2 actifs sur 2/);
  assert.match(list, /Claude Code \(~\/\.claude\/skills\) : 2[\s\S]*demo-pdf[\s\S]*roblox-ui/);
  assert.ok(list.indexOf('Skills de ton PC') < list.indexOf('Profils FS-CLI'), 'skills du PC d\'abord');
  assert.match(await run('/skills', 'pdf'), /● demo-pdf · Claude Code[\s\S]*Lire et créer des PDF/);
  assert.match(await run('/skill', 'demo-pdf'), /skill demo-pdf : désactivé/);
  assert.deepEqual(cfg.disabledSkills, ['demo-pdf']);
  assert.equal(S.skillsCatSig, '', 'index des skills renvoyé au modèle au prochain message');
  assert.match(await run('/skills', ''), /1 actif sur 2[\s\S]*demo-pdf \(off\)/);
  assert.match(await run('/skill', 'demo-pdf'), /réactivé/);
  assert.deepEqual(cfg.disabledSkills, []);
});
