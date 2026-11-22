// fs claude : dossier Claude Code à part (sessions séparées), réglages / skills / MCP partagés
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-cchome-'));
process.env.FS_CLI_HOME = path.join(tmp, 'fshome');
const { prepareClaudeHome, mergeClaudeJson, moveSessions, SHARED_DIRS } = await import('../src/gateway/claudehome.js');

function userHome() {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const cl = path.join(home, '.claude');
  for (const d of ['skills/mon-skill', 'commands', 'plugins', 'ide', 'projects/C--proj']) fs.mkdirSync(path.join(cl, d), { recursive: true });
  fs.writeFileSync(path.join(cl, 'skills/mon-skill/SKILL.md'), '# skill');
  fs.writeFileSync(path.join(cl, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(cl, 'CLAUDE.md'), 'mes consignes');
  fs.writeFileSync(path.join(cl, '.credentials.json'), '{"faux":1}');
  fs.writeFileSync(path.join(cl, 'history.jsonl'), '{"display":"ma demande perso"}\n');
  fs.writeFileSync(path.join(cl, 'projects/C--proj/vraie-session.jsonl'), '{}\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { blender: { command: 'uvx' } },
    projects: { 'C:/proj': { hasTrustDialogAccepted: true, mcpServers: { local: {} }, lastSessionId: 'vraie-session', lastCost: 3 } } }));
  return { home, cl };
}

test('dossier de fs claude : skills/commandes/plugins/ide partagés en direct, réglages et MCP recopiés, sessions et identifiants jamais', () => {
  const { home, cl } = userHome();
  const target = path.join(tmp, 'cc-1');
  const r = prepareClaudeHome({ target, env: {}, home });
  assert.equal(r.dir, target);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.linked.sort(), ['commands', 'ide', 'plugins', 'skills']);
  assert.ok(fs.lstatSync(path.join(target, 'skills')).isSymbolicLink(), 'lien (jonction sous Windows), pas une copie');
  assert.equal(fs.readFileSync(path.join(target, 'skills/mon-skill/SKILL.md'), 'utf8'), '# skill');
  fs.writeFileSync(path.join(cl, 'skills/mon-skill/SKILL.md'), '# modifié');
  assert.equal(fs.readFileSync(path.join(target, 'skills/mon-skill/SKILL.md'), 'utf8'), '# modifié', 'partagé en direct');
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.equal(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8'), 'mes consignes');
  for (const f of ['.credentials.json', 'history.jsonl', 'projects']) assert.ok(!fs.existsSync(path.join(target, f)), `${f} jamais repris`);
  const j = JSON.parse(fs.readFileSync(path.join(target, '.claude.json'), 'utf8'));
  assert.equal(j.hasCompletedOnboarding, true, 'pas d\'écran d\'accueil');
  assert.deepEqual(Object.keys(j.mcpServers), ['blender'], 'serveurs MCP partagés');
  assert.deepEqual(j.projects['C:/proj'], { hasTrustDialogAccepted: true, mcpServers: { local: {} } }, 'confiance et MCP locaux, sans la session du vrai Claude Code');

  // 2e lancement : idempotent ; réglages modifiés chez l'utilisateur recopiés ; sessions de fs claude gardées
  const jj = JSON.parse(fs.readFileSync(path.join(target, '.claude.json'), 'utf8'));
  jj.projects['C:/proj'].lastSessionId = 'session-fs';
  fs.writeFileSync(path.join(target, '.claude.json'), JSON.stringify(jj));
  fs.writeFileSync(path.join(cl, 'settings.json'), '{"theme":"light"}');
  const r2 = prepareClaudeHome({ target, env: {}, home });
  assert.deepEqual(r2.errors, []);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"theme":"light"}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, '.claude.json'), 'utf8')).projects['C:/proj'].lastSessionId, 'session-fs');
  assert.ok(fs.existsSync(path.join(cl, 'skills/mon-skill/SKILL.md')), 'la cible des liens n\'est jamais touchée');
});

test('vrai dossier déjà présent dans le dossier de fs claude : laissé tel quel (jamais écrasé), signalé', () => {
  const { home } = userHome();
  const target = path.join(tmp, 'cc-2');
  fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(target, 'skills', 'a-moi.md'), 'x');
  const r = prepareClaudeHome({ target, env: {}, home });
  assert.equal(r.dir, target);
  assert.ok(r.errors.some(e => /skills : un vrai dossier existe/.test(e)));
  assert.ok(fs.existsSync(path.join(target, 'skills', 'a-moi.md')));
});

test('CLAUDE_CONFIG_DIR de l\'utilisateur : c\'est sa source (avec son .claude.json dedans) ; jamais sur lui-même', () => {
  const src = fs.mkdtempSync(path.join(tmp, 'perso-'));
  fs.mkdirSync(path.join(src, 'skills'));
  fs.writeFileSync(path.join(src, '.claude.json'), '{"mcpServers":{"x":{}}}');
  const target = path.join(tmp, 'cc-3');
  const r = prepareClaudeHome({ target, env: { CLAUDE_CONFIG_DIR: src }, home: tmp });
  assert.deepEqual(r.linked, ['skills']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(target, '.claude.json'), 'utf8')).mcpServers), ['x']);
  assert.equal(prepareClaudeHome({ target: src, env: { CLAUDE_CONFIG_DIR: src }, home: tmp }).dir, null);
});

test('mergeClaudeJson et moveSessions : sessions déplacées (jsonl, dossier, file-history), jamais supprimées ni écrasées', () => {
  assert.deepEqual(mergeClaudeJson(null, { a: 1 }), { a: 1 });
  const { cl } = userHome();
  const to = path.join(tmp, 'cc-4');
  fs.mkdirSync(path.join(cl, 'projects/C--proj/s1/subagents'), { recursive: true });
  fs.writeFileSync(path.join(cl, 'projects/C--proj/s1.jsonl'), 'S1');
  fs.mkdirSync(path.join(cl, 'file-history/s1'), { recursive: true });
  const r = moveSessions(['s1', 'absente'], cl, to, 'C--proj');
  assert.deepEqual(r, { moved: ['s1'], skipped: ['absente'] });
  assert.equal(fs.readFileSync(path.join(to, 'projects/C--proj/s1.jsonl'), 'utf8'), 'S1');
  assert.ok(fs.existsSync(path.join(to, 'projects/C--proj/s1/subagents')));
  assert.ok(fs.existsSync(path.join(to, 'file-history/s1')));
  assert.ok(!fs.existsSync(path.join(cl, 'projects/C--proj/s1.jsonl')));
  assert.ok(fs.existsSync(path.join(cl, 'projects/C--proj/vraie-session.jsonl')), 'les autres sessions ne bougent pas');
  fs.writeFileSync(path.join(cl, 'projects/C--proj/s1.jsonl'), 'AUTRE');
  assert.deepEqual(moveSessions(['s1'], cl, to, 'C--proj'), { moved: [], skipped: ['s1'] }, 'déjà présente à l\'arrivée : rien n\'est écrasé');
  assert.ok(SHARED_DIRS.includes('ide'), 'connexion à l\'éditeur partagée');
});
