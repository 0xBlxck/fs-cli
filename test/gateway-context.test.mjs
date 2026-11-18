// Tests de src/gateway/context.js : environnement, nettoyage des messages user, préambule (spécification § 3.2, § 5.1).
// Les rappels sont fabriqués avec les textes exacts de Claude Code 2.1.207 (les captures n'en contiennent qu'un).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture } from './gateway-helpers.mjs';           // pose FS_CLI_HOME sur un dossier temporaire

const { extractEnv, splitReminders, parseContextReminder, cleanUserContent, preamble, claudeMdExcerpt, CONTINUE_FR } =
  await import('../src/gateway/context.js');

const R = s => `<system-reminder>\n${s}\n</system-reminder>\n`;
const IMPORTANT = '\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.';

/** Rappel de contexte complet, au format de Claude Code (NLd + gUr). */
function contextReminder({ email = true } = {}) {
  return R("As you answer the user's questions, you can use the following context:\n"
    + '# claudeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n'
    + 'Contents of C:\\proj (x86)\\CLAUDE.md (project instructions, checked into the codebase):\n\n# Projet démo\nUtilise des tabulations.\n\n'
    + 'Contents of C:\\proj\\CLAUDE.local.md (user\'s private project instructions, not checked in):\n\nRéponds en français.\n\n'
    + 'Contents of C:\\Users\\x\\.claude\\projects\\p\\memory\\MEMORY.md (user\'s auto-memory, persists across conversations):\n\n- SECRET-MEMOIRE : mot de passe du NAS\n\n'
    + 'Contents of C:\\Users\\x\\.claude\\CLAUDE.md (user\'s private global instructions for all projects):\n\nGLOBAL-PERSO\n\n'
    + 'Contents of C:\\ProgramData\\ClaudeCode\\CLAUDE.md (organization-managed policy instructions):\n\nPOLITIQUE-ORGA\n'
    + (email ? '# userEmail\nThe user\'s email address is perso@example.com.\n' : '')
    + '# currentDate\nToday\'s date is 2026-11-18.' + IMPORTANT);
}

const LINUX = () => loadFixture('req-03-linux').body.system;

test('extractEnv sur req-03 : Windows, bash, pas de dépôt git', () => {
  const env = extractEnv(loadFixture('req-03').body.system, '/ailleurs');
  assert.deepEqual(env, {
    cwd: 'C:\\proj', platform: 'win32', shell: 'bash', osVersion: 'Windows 11 Pro 10.0.26300',
    isGit: false, branch: null, extraDirs: ['C:/proj'], pathMod: 'win32',
  });
});

test('extractEnv sur la variante Linux : chemins avec espaces et accents, zsh', () => {
  const env = extractEnv(LINUX(), 'C:\\ailleurs');
  assert.equal(env.cwd, '/home/user/mon projet/été');
  assert.deepEqual(env.extraDirs, ['/home/user/mon projet/été']);
  assert.equal(env.platform, 'linux');
  assert.equal(env.pathMod, 'posix');
  assert.equal(env.shell, 'zsh');
  assert.equal(env.osVersion, 'Linux 6.8.0-49-generic');
});

test('extractEnv : dépôt git et branche, shell PowerShell, dossiers en ligne, valeurs par défaut', () => {
  const sys = 'Here is useful information about the environment you are running in:\n - Primary working directory: D:\\dev\\app\n - Is a git repository: true\n'
    + ' - Additional working directories: D:\\lib, D:\\docs\n - Platform: win32\n'
    + ' - Shell: PowerShell (primary); Bash tool also available for POSIX scripts — each takes its own syntax.\n - OS Version: Windows 11 Pro 10.0.26300\n\n'
    + 'gitStatus: This is the git status at the start of the conversation.\nCurrent branch: feature/x\n\nMain branch (you will usually use this for PRs): main';
  const env = extractEnv([{ type: 'text', text: sys }], '/x');
  assert.equal(env.cwd, 'D:\\dev\\app');
  assert.equal(env.isGit, true);
  assert.equal(env.branch, 'feature/x');
  assert.equal(env.shell, 'PowerShell');
  assert.deepEqual(env.extraDirs, ['D:\\lib', 'D:\\docs']);
  const empty = extractEnv(undefined, '/repli');
  assert.equal(empty.cwd, '/repli');
  assert.ok(['win32', 'darwin', 'linux'].includes(empty.platform));
  assert.deepEqual(empty.extraDirs, []);
  assert.equal(empty.branch, null);
});

test('splitReminders : retire tous les rappels, y compris un rappel non fermé', () => {
  const r = splitReminders('a' + R('un') + 'b' + R('deux') + 'c <system-reminder>trois');
  assert.deepEqual(r.reminders, ['un', 'deux', 'trois']);
  assert.equal(r.clean, 'a\nb\nc');
  assert.deepEqual(splitReminders(undefined), { clean: '', reminders: [] });
});

test('parseContextReminder : CLAUDE.md du projet gardé, auto-mémoire et autres types exclus, e-mail signalé', () => {
  const inner = splitReminders(contextReminder()).reminders[0];
  const c = parseContextReminder(inner);
  assert.deepEqual(c.files.map(f => [f.path, f.type]), [
    ['C:\\proj (x86)\\CLAUDE.md', 'project instructions, checked into the codebase'],
    ['C:\\proj\\CLAUDE.local.md', "user's private project instructions, not checked in"],
  ]);
  assert.equal(c.files[0].body, '# Projet démo\nUtilise des tabulations.');
  assert.equal(c.date, '2026-11-18');
  assert.equal(c.email, true);
  assert.equal(parseContextReminder(splitReminders(contextReminder({ email: false })).reminders[0]).email, false);
});

test('cleanUserContent sur req-03 : demande seule, date lue, aucun CLAUDE.md', () => {
  const u = cleanUserContent(loadFixture('req-03').body.messages[0].content);
  assert.equal(u.text, 'lis hello.txt et dis-moi ce qu\'il contient');
  assert.equal(u.date, '2026-11-18');
  assert.equal(u.claudeMd, null);
  assert.deepEqual(u.notes, []);
  assert.equal(u.interrupted, false);
  assert.equal(u.isContinuation, false);
});

test('cleanUserContent : CLAUDE.md projet gardé, auto-mémoire, instructions globales et e-mail jamais dans le texte', () => {
  const u = cleanUserContent([{ type: 'text', text: contextReminder() }, { type: 'text', text: 'corrige le bug' }]);
  assert.equal(u.text, 'corrige le bug');
  assert.ok(u.claudeMd);
  assert.match(u.claudeMd.text, /Utilise des tabulations/);
  assert.match(u.claudeMd.text, /Réponds en français/);
  assert.match(u.claudeMd.hash, /^[0-9a-f]{40}$/);
  assert.deepEqual(u.claudeMd.paths, ['C:\\proj (x86)\\CLAUDE.md', 'C:\\proj\\CLAUDE.local.md']);
  const all = JSON.stringify(u);
  for (const leak of ['SECRET-MEMOIRE', 'GLOBAL-PERSO', 'POLITIQUE-ORGA', 'perso@example.com', 'auto-memory', 'system-reminder']) {
    assert.ok(!all.includes(leak), `fuite : ${leak}`);
  }
});

test('cleanUserContent : balises de commande (arguments gardés, prompt développé gardé)', () => {
  const u = cleanUserContent([
    { type: 'text', text: '<command-message>revue</command-message>\n<command-name>/revue</command-name>\n<command-args>src/api.js</command-args>' },
    { type: 'text', text: 'Relis le fichier indiqué et liste les problèmes.' },
  ]);
  assert.equal(u.text, 'src/api.js\n\nRelis le fichier indiqué et liste les problèmes.');
  const local = cleanUserContent('<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<local-command-stdout>Total cost: $0.00</local-command-stdout>\n<local-command-stderr>rien</local-command-stderr>');
  assert.equal(local.text, '');
  const caveat = cleanUserContent('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>\nfais le point');
  assert.equal(caveat.text, 'fais le point');
});

test('cleanUserContent : rappels « modifié par un linter », sélection, fichier ouvert → notes ; le reste est jeté', () => {
  const sel = 'The user selected the lines 3 to 5 from C:\\proj\\calc.js:\nfunction add(a, b) {\n  return a - b;\n}\n\nThis may or may not be related to the current task.';
  const u = cleanUserContent([{ type: 'text', text:
    R('Note: C:\\proj\\calc.js was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed.\n1\tfunction add')
    + R(sel)
    + R('The user opened the file C:\\proj\\README.md in the IDE. This may or may not be related to the current task.')
    + R('The following skills are available for use with the Skill tool:\n- revue')
    + R('Your todo list is currently empty. Use TodoWrite.')
    + 'Corrige add' }]);
  assert.equal(u.text, 'Corrige add');
  assert.deepEqual(u.notes, [
    'Fichier modifié hors de la conversation : C:\\proj\\calc.js (relis-le avant de le modifier).',
    'Sélection de l\'utilisateur : C:\\proj\\calc.js, lignes 3 à 5.\nfunction add(a, b) {\n  return a - b;\n}',
    'Fichier ouvert dans l\'éditeur : C:\\proj\\README.md.',
  ]);
  const big = cleanUserContent(R(`The user selected the lines 1 to 900 from C:\\proj\\big.js:\n${'x'.repeat(4001)}\n\nThis may or may not be related to the current task.`) + 'ok');
  assert.deepEqual(big.notes, ['Sélection de l\'utilisateur : C:\\proj\\big.js, lignes 1 à 900.']);
});

test('cleanUserContent : interruption retirée et signalée', () => {
  const a = cleanUserContent([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
  assert.equal(a.interrupted, true);
  assert.equal(a.text, '');
  const b = cleanUserContent('[Request interrupted by user]\nfinalement, fais plutôt ça');
  assert.equal(b.interrupted, true);
  assert.equal(b.text, 'finalement, fais plutôt ça');
  assert.equal(cleanUserContent('rien').interrupted, false);
});

test('cleanUserContent : continuation après compaction, marqueur [fs-gw:…], résumé retiré', () => {
  const head = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Demandes : corriger calc.js\n5. Conversation France Student conservée : [fs-gw:Ab12Cd34Ef56]\n\nRecent messages are preserved verbatim.';
  const cont = '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary.';
  const a = cleanUserContent(head + cont);
  assert.equal(a.isContinuation, true);
  assert.equal(a.marker, 'Ab12Cd34Ef56');
  assert.equal(a.text, CONTINUE_FR);
  // Texte de l'utilisateur après le paragraphe « Continue… », ou dans un bloc séparé : gardé seul.
  assert.equal(cleanUserContent(head + cont + '\n\nque t\'ai-je demandé au début ?').text, 'que t\'ai-je demandé au début ?');
  const b = cleanUserContent([{ type: 'text', text: head + cont }, { type: 'text', text: 'et ensuite ?' }]);
  assert.equal(b.text, 'et ensuite ?');
  // /compact manuel sans paragraphe « Continue » : rien ne reste du résumé.
  const c = cleanUserContent(head);
  assert.equal(c.isContinuation, true);
  assert.equal(c.text, '');
  assert.ok(!JSON.stringify([a, b, c]).includes('corriger calc.js'));
  assert.equal(cleanUserContent('bonjour [fs-gw:Ab12Cd34Ef56]').marker, null);       // marqueur hors continuation ignoré
});

test('cleanUserContent : images base64 extraites', () => {
  const u = cleanUserContent([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }, { type: 'text', text: 'regarde' }]);
  assert.deepEqual(u.images, [{ media_type: 'image/png', data: 'iVBOR' }]);
  assert.equal(u.text, 'regarde');
});

// Mots interdits dans le texte produit par la passerelle : vocabulaire de Claude Code et noms de ses outils.
const TOOL_NAMES = loadFixture('req-03').body.tools.map(t => t.name);
function forbidden(text) {
  const hits = [];
  if (/\bagents?\b/i.test(text)) hits.push('agent');
  if (/\bCLI\b/.test(text)) hits.push('CLI');
  if (/Claude Code/i.test(text)) hits.push('Claude Code');
  if (/outil externe/i.test(text)) hits.push('outil externe');
  if (/sous-agent/i.test(text)) hits.push('sous-agent');
  for (const n of [...TOOL_NAMES, 'Task', 'ExitPlanMode', 'MultiEdit']) if (new RegExp(`\\b${n}\\b`).test(text)) hits.push(n);
  if (/<\/?[a-z-]+>/.test(text.replace(/\[[^\]]*\]/g, ''))) hits.push('balise');
  return hits;
}

const ENV3 = () => extractEnv(loadFixture('req-03').body.system);
const MD = { text: '# Projet\nUtilise des tabulations.\nNe lance jamais de subagent.\nUtilise `Read` avant tout.\nPasse par le serveur MCP.\nLes skills sont dans .claude.\nRéponds en français.', hash: 'h', paths: ['C:\\proj\\CLAUDE.md'] };

test('préambule : contexte, shell, date, séparateur ; aucun mot interdit', () => {
  const p = preamble(ENV3(), { sid: 'ab12', claudeMd: MD, provider: 'anthropic', shellTool: 'Bash', date: '2026-11-18' });
  assert.ok(p.startsWith('[ab12·cc] Contexte : dossier de travail C:\\proj (Windows 11 Pro, pas de dépôt git). Les chemins relatifs partent de ce dossier.\n'), p);
  assert.match(p, /run_command s'exécutent dans bash .*syntaxe POSIX\./);
  assert.match(p, /\nDate : 18\/11\/2026\.\n/);
  assert.ok(p.endsWith('\n\n') && !p.includes('---'), 'pas de « --- » : le site en faisait un titre géant');
  assert.ok(!p.includes('Autres dossiers'), 'dossier additionnel identique au dossier de travail');
  assert.deepEqual(forbidden(p), []);
  assert.deepEqual(forbidden('Un agent lance Bash via le CLI de Claude Code <system-reminder>'), ['agent', 'CLI', 'Claude Code', 'Bash', 'balise']);
  // CLAUDE.md : lignes propres à Claude Code retirées.
  assert.match(p, /\[Consignes du projet \(CLAUDE\.md, extrait\) :\n# Projet\nUtilise des tabulations\.\nRéponds en français\.\]/);
  for (const w of ['subagent', 'MCP', 'skills', '`Read`']) assert.ok(!p.includes(w), w);
});

test('préambule : pas de CLAUDE.md pour un modèle openai (sauf forceClaudeMd)', () => {
  const env = ENV3();
  const gpt = preamble(env, { sid: 'ab12', claudeMd: MD, provider: 'openai', shellTool: 'Bash', date: '2026-11-18' });
  assert.ok(!gpt.includes('CLAUDE.md') && !gpt.includes('tabulations'));
  const forced = preamble(env, { sid: 'ab12', claudeMd: MD, provider: 'openai', shellTool: 'Bash', forceClaudeMd: true });
  assert.match(forced, /tabulations/);
  assert.ok(!preamble(env, { sid: 'ab12', claudeMd: null, provider: 'anthropic' }).includes('CLAUDE.md'));
});

test('préambule : PowerShell, Linux/zsh, dépôt git, dossiers en plus, bare', () => {
  const ps = preamble({ ...ENV3(), isGit: true, branch: 'main', extraDirs: ['C:/proj', 'D:\\lib'] }, { sid: 'cd34', shellTool: 'PowerShell' });
  assert.match(ps, /\(Windows 11 Pro, dépôt git, branche main\)/);
  assert.match(ps, /run_command s'exécutent dans PowerShell\./);
  assert.match(ps, /Autres dossiers accessibles : D:\\lib\./);
  assert.ok(!ps.includes('Date :'));
  const lx = preamble(extractEnv(LINUX()), { sid: 'ef56', shellTool: 'Bash', date: '2026-11-18' });
  assert.match(lx, /dossier de travail \/home\/user\/mon projet\/été \(Linux, pas de dépôt git\)/);
  assert.match(lx, /dans zsh : syntaxe POSIX/);
  const none = preamble(ENV3(), { sid: 'ab12', shellTool: null });
  assert.match(none, /run_command n'est pas disponible/);
  for (const p of [ps, lx, none]) assert.deepEqual(forbidden(p), []);
  assert.equal(preamble(ENV3(), { sid: 'ab12', bare: true }), '[ab12·cc] ');
});

test('claudeMdExcerpt : 6 000 caractères au plus, coupé sur une fin de ligne', () => {
  const long = Array.from({ length: 400 }, (_, i) => `Règle ${i} : garder le style existant du fichier.`).join('\n');
  const ex = claudeMdExcerpt(long);
  assert.ok(ex.length <= 6000 + 4, ex.length);
  assert.ok(ex.endsWith('\n[…]'));
  assert.match(ex.split('\n').at(-2), /^Règle \d+ : garder le style existant du fichier\.$/);
  assert.equal(claudeMdExcerpt('Lance un Agent.\nTodoWrite partout'), '');
  assert.equal(claudeMdExcerpt(null), '');
});
