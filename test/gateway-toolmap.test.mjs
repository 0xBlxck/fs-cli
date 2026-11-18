// Tests de src/gateway/toolmap.js : appels d'outils France Student ↔ tool_use de Claude Code (spécification § 3.5, 3.6).
// Chaque input de tool_use produit est validé contre l'input_schema RÉEL de Claude Code 2.1.207 (fixture req-03).
// Hors ligne : faux France Student (fsExists, fsStat, uploadFile simulés). Chemins win32 ET posix, quelle que soit la machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, toolSchema, validateAgainstSchema, fakeFs } from './gateway-helpers.mjs';

const T = await import('../src/gateway/toolmap.js');
const { decodeId } = await import('../src/gateway/ids.js');
const { absPath, stripLineNumbers, planToolUses, collectResults, translateResult, budget, condenseTestOutput, planDocuments, planRetry, LOCAL } = T;

// ── Environnements et schémas ──

const WIN = Object.freeze({ cwd: 'C:\\proj', platform: 'win32', shell: 'bash', osVersion: 'Windows 11 Pro 10.0.26300', isGit: false, branch: null, extraDirs: [], pathMod: 'win32' });
const LINUX = Object.freeze({ cwd: '/home/user/mon projet/été', platform: 'linux', shell: 'zsh', osVersion: 'Linux 6.8.0', isGit: true, branch: 'main', extraDirs: [], pathMod: 'posix' });

const TOOLS = loadFixture('req-03').body.tools;
// L'outil PowerShell n'apparaît pas dans les captures : schéma relevé dans le bundle 2.1.207 (strictObject command, timeout,
// description, run_in_background, dangerouslyDisableSandbox), au même format que celui de Bash.
const PS_SCHEMA = { ...toolSchema('Bash'), description: undefined };
delete PS_SCHEMA.description;
const PS_TOOL = { name: 'PowerShell', input_schema: PS_SCHEMA };
const SCHEMAS = { PowerShell: PS_SCHEMA };
for (const n of ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']) SCHEMAS[n] = toolSchema(n);

/** Chaque tool_use : id au format Claude Code, outil connu et input conforme à son input_schema réel. */
function assertValidUses(uses) {
  for (const u of uses) {
    assert.match(u.id, /^[A-Za-z0-9_-]+$/, `id tool_use invalide : ${u.id}`);
    assert.ok(SCHEMAS[u.name], `outil inattendu : ${u.name}`);
    assert.deepEqual(validateAgainstSchema(u.input, SCHEMAS[u.name]), [], `${u.name} ${JSON.stringify(u.input)}`);
    assert.deepEqual(JSON.parse(JSON.stringify(u.input)), u.input, 'input sérialisable tel quel (aucun undefined)');
  }
}

const call = (name, args, callId = `call_${name}`) => ({ callId, name, arguments: args });

function ctxFor(env = WIN, { files = {}, dirs = [], tools = TOOLS, readSet, sessionId, extra } = {}) {
  const fake = fakeFs({ files, dirs });
  const ctx = { env, tools, readSet: readSet || { sessionId: sessionId ?? 'sess-1', paths: {} }, sessionId: sessionId ?? 'sess-1',
    fsExists: fake.fsExists, fsStat: fake.fsStat, uploadFile: fake.uploadFile, chatId: 'chat-1', ...extra };
  return { ctx, fake };
}

function plan(calls, opts) {
  const { ctx, fake } = ctxFor(opts?.env, opts);
  const r = planToolUses(calls, ctx);
  assertValidUses(r.uses);
  return { ...r, ctx, fake };
}

const byName = (uses, name) => uses.filter(u => u.name === name);

// ── absPath ──

test('absPath sous win32 : relatif, absolu, /c/x (Git Bash), \\x et /x sans lecteur, UNC', () => {
  assert.equal(absPath('', WIN), 'C:\\proj');
  assert.equal(absPath('.', WIN), 'C:\\proj');
  assert.equal(absPath('src/app.js', WIN), 'C:\\proj\\src\\app.js');
  assert.equal(absPath('./src/../lib/x.js', WIN), 'C:\\proj\\lib\\x.js');
  assert.equal(absPath('D:\\data\\a.txt', WIN), 'D:\\data\\a.txt');
  assert.equal(absPath('D:/data/a.txt', WIN), 'D:\\data\\a.txt');
  assert.equal(absPath('/c/Users/x/a.txt', WIN), 'C:\\Users\\x\\a.txt');
  assert.equal(absPath('/d', WIN), 'D:\\');
  assert.equal(absPath('\\d', WIN), 'C:\\proj\\d', 'la forme Git Bash n\'existe qu\'avec « / »');
  assert.equal(absPath('\\src\\a.js', WIN), 'C:\\proj\\src\\a.js');
  assert.equal(absPath('/src/a.js', WIN), 'C:\\proj\\src\\a.js');
  assert.equal(absPath('\\\\serveur\\partage\\f.txt', WIN), '\\\\serveur\\partage\\f.txt');
  assert.equal(absPath('src\\', WIN), 'C:\\proj\\src', 'pas de séparateur final');
  assert.equal(absPath('..\\autre\\b.txt', WIN), 'C:\\autre\\b.txt', 'hors du dossier : non bloqué (permissions de Claude Code)');
});

test('absPath sous posix : /x absolu, relatif avec espaces et accents, jamais le path de la machine', () => {
  assert.equal(absPath('', LINUX), '/home/user/mon projet/été');
  assert.equal(absPath('src/données.txt', LINUX), '/home/user/mon projet/été/src/données.txt');
  assert.equal(absPath('/etc/hosts', LINUX), '/etc/hosts');
  assert.equal(absPath('/c/x', LINUX), '/c/x', 'la règle Git Bash ne vaut que sous win32');
  assert.equal(absPath('a\\b', LINUX), '/home/user/mon projet/été/a\\b', 'antislash = caractère ordinaire sous POSIX');
  assert.equal(absPath('../x', LINUX), '/home/user/mon projet/x');
});

// ── Les 6 outils → input validé contre les vrais schémas ──

test('les 6 outils FS → tool_use valides (Read, Grep, Edit, Write, Bash, Bash ls), ids décodables', () => {
  const calls = [
    call('read_file', { path: 'src/a.js', start_line: 10, end_line: 20 }, 'c1'),
    call('search_files', { query: 'TODO', path: 'src', glob: '*.js', max_results: 30 }, 'c2'),
    call('edit_file', { path: 'src/a.js', old_text: 'x', new_text: 'y' }, 'c3'),
    call('write_file', { path: 'nouveau.txt', content: 'bonjour' }, 'c4'),
    call('run_command', { command: 'npm test', timeout_seconds: 90 }, 'c5'),
    call('list_directory', { path: '.', depth: 1 }, 'c6'),
  ];
  const r = plan(calls, { readSet: { sessionId: 'sess-1', paths: { 'c:\\proj\\src\\a.js': true } } });
  assert.deepEqual(r.uses.map(u => u.name), ['Read', 'Grep', 'Edit', 'Write', 'Bash', 'Bash']);
  assert.deepEqual(r.uses[0].input, { file_path: 'C:\\proj\\src\\a.js', offset: 10, limit: 11 });
  assert.deepEqual(r.uses[1].input, { pattern: 'TODO', path: 'C:\\proj\\src', glob: '*.js', output_mode: 'content', '-n': true, head_limit: 30 });
  assert.deepEqual(r.uses[2].input, { file_path: 'C:\\proj\\src\\a.js', old_string: 'x', new_string: 'y' });
  assert.deepEqual(r.uses[3].input, { file_path: 'C:\\proj\\nouveau.txt', content: 'bonjour' });
  assert.deepEqual(r.uses[4].input, { command: 'npm test', timeout: 90000, description: 'Commande : npm test' });
  assert.deepEqual(r.uses[5].input, { command: "ls -la -- 'C:/proj'", description: 'Lister .' });
  assert.equal(r.pending.length, 6);
  r.pending.forEach((p, i) => {
    assert.equal(p.callId, calls[i].callId);
    assert.equal(p.ccId, r.uses[i].id);
    assert.equal(p.local, null);
    assert.equal(p.retried, 0);
    assert.deepEqual(decodeId(p.ccId), { kind: 'f', chatId: 'chat-1', callId: calls[i].callId });
  });
  assert.equal(r.synthetic.length, 0);
});

test('arguments en chaîne JSON acceptés ; champs absents omis (jamais undefined ni null)', () => {
  const r = plan([{ callId: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt', start_line: null }) },
    call('search_files', { query: 'x', path: '', glob: null })]);
  assert.deepEqual(r.uses[0].input, { file_path: 'C:\\proj\\a.txt' });
  assert.deepEqual(r.uses[1].input, { pattern: 'x', output_mode: 'content', '-n': true, head_limit: 100 });
});

test('read_file : start_line/end_line → offset/limit (début seul, fin seule, fin < début)', () => {
  const r = plan([
    call('read_file', { path: 'a', start_line: 5 }, 'a'),
    call('read_file', { path: 'a', end_line: 40 }, 'b'),
    call('read_file', { path: 'a', start_line: 30, end_line: 10 }, 'c'),
    call('read_file', { path: 'a', start_line: 0, end_line: 0 }, 'd'),
    call('read_file', { path: 'a', start_line: '7', end_line: '9' }, 'e'),
  ]);
  assert.deepEqual(r.uses.map(u => u.input), [
    { file_path: 'C:\\proj\\a', offset: 5 },
    { file_path: 'C:\\proj\\a', limit: 40 },
    { file_path: 'C:\\proj\\a', offset: 30 },
    { file_path: 'C:\\proj\\a' },
    { file_path: 'C:\\proj\\a', offset: 7, limit: 3 },
  ]);
});

test('read_file sur un dossier → listage', () => {
  const r = plan([call('read_file', { path: 'src' })], { files: { 'C:\\proj\\src\\a.js': 'x' } });
  assert.equal(r.uses[0].name, 'Bash');
  assert.equal(r.uses[0].input.command, "ls -la -- 'C:/proj/src'");
  assert.equal(r.pending[0].fsName, 'read_file');
});

test('search_files : regex invalide (ou refusée par ripgrep) échappée, max_results borné à 1..250', () => {
  const r = plan([
    call('search_files', { query: 'foo(', max_results: 1000 }, 'a'),
    call('search_files', { query: 'a.*b|c', max_results: 0 }, 'b'),
    call('search_files', { query: '(?<=x)y' }, 'c'),
    call('search_files', { query: '[abc' }, 'd'),
  ]);
  assert.equal(r.uses[0].input.pattern, 'foo\\(');
  assert.equal(r.uses[0].input.head_limit, 250);
  assert.equal(r.uses[1].input.pattern, 'a.*b|c');
  assert.equal(r.uses[1].input.head_limit, 100, '0 = absent → 100 par défaut');
  assert.equal(r.uses[2].input.pattern, '\\(\\?<=x\\)y');
  assert.equal(r.uses[3].input.pattern, '\\[abc');
});

test('edit_file : numéros de ligne retirés (tout ou rien), replace_all seulement si true', () => {
  const r = plan([
    call('edit_file', { path: 'a.js', old_text: '12: const a = 1;\n13: const b = 2;', new_text: '12: const a = 3;\n13: const b = 2;', replace_all: true }, 'a'),
    call('edit_file', { path: 'a.js', old_text: 'x', new_text: 'y', replace_all: false }, 'b'),
  ]);
  assert.deepEqual(r.uses[0].input, { file_path: 'C:\\proj\\a.js', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 3;\nconst b = 2;', replace_all: true });
  assert.ok(!('replace_all' in r.uses[1].input));
});

test('stripLineNumbers : tout ou rien, formats « N\\t », « N: », « N→ »', () => {
  assert.equal(stripLineNumbers('1\tfoo\n2\tbar'), 'foo\nbar');
  assert.equal(stripLineNumbers('  9: a\n 10: b\n\n 11: c'), 'a\nb\n\nc');
  assert.equal(stripLineNumbers('3\u2192x\n4\u2192y'), 'x\ny');
  assert.equal(stripLineNumbers('1: a\n2:'), 'a\n', 'ligne vide numérotée sans espace final');
  assert.equal(stripLineNumbers('1: a\nb'), '1: a\nb', 'une ligne sans numéro : rien n\'est retiré');
  assert.equal(stripLineNumbers('12:30 réunion'), '12:30 réunion');
  assert.equal(stripLineNumbers(''), '');
});

test('run_command : cwd en sous-shell POSIX (guillemets sûrs), timeout borné, description courte', () => {
  const r = plan([
    call('run_command', { command: 'ls', cwd: "src/l'été" }, 'a'),
    call('run_command', { command: 'echo a # commentaire', cwd: 'src' }, 'b'),
    call('run_command', { command: 'sleep 1', timeout_seconds: 9999 }, 'c'),
    call('run_command', { command: 'sleep 1', timeout_seconds: 0.2 }, 'd'),
    call('run_command', { command: 'x'.repeat(80) + '\nsuite' }, 'e'),
  ]);
  assert.equal(r.uses[0].input.command, "(cd 'C:/proj/src/l'\\''été' && ls)");
  assert.equal(r.uses[1].input.command, "(cd 'C:/proj/src' && echo a # commentaire\n)", 'un commentaire n\'avale pas la parenthèse');
  assert.equal(r.uses[2].input.timeout, 600000);
  assert.equal(r.uses[3].input.timeout, 1000);
  assert.ok(!('timeout' in r.uses[0].input));
  assert.equal(r.uses[4].input.description, 'Commande : ' + 'x'.repeat(49) + '…');
  assert.equal(r.pending[0].command, 'ls');
});

test('posix (variante Linux) : chemins avec espaces et accents, sous-shell, listage find', () => {
  const r = plan([
    call('read_file', { path: 'notes/été.md' }, 'a'),
    call('run_command', { command: 'make', cwd: 'build dir' }, 'b'),
    call('list_directory', { path: '.', depth: 3 }, 'c'),
  ], { env: LINUX, tools: loadFixture('req-03-linux').body.tools });
  assert.equal(r.uses[0].input.file_path, '/home/user/mon projet/été/notes/été.md');
  assert.equal(r.uses[1].input.command, "(cd '/home/user/mon projet/été/build dir' && make)");
  assert.equal(r.uses[2].input.command, "find '/home/user/mon projet/été' -maxdepth 3 \\( -name node_modules -o -name .git \\) -prune -o -print | head -n 500");
});

test('list_directory : Bash (profondeur 1 à 3), PowerShell, Glob sans shell', () => {
  const bash = plan([call('list_directory', { path: 'src', depth: 2 }, 'a'), call('list_directory', { path: 'src', depth: 9 }, 'b')]);
  assert.match(bash.uses[0].input.command, /^find 'C:\/proj\/src' -maxdepth 2 /);
  assert.match(bash.uses[1].input.command, /-maxdepth 3 /);
  assert.equal(bash.uses[0].input.description, 'Lister src');

  const toolsPs = TOOLS.filter(t => t.name !== 'Bash').concat(PS_TOOL);
  const ps = plan([call('list_directory', { path: "l'été", depth: 2 }, 'a')], { tools: toolsPs });
  assert.equal(ps.uses[0].name, 'PowerShell');
  assert.equal(ps.uses[0].input.command, "Get-ChildItem -LiteralPath 'C:\\proj\\l''été' -Force -Depth 1 | Select-Object -First 500 FullName,Length,Mode | Format-Table -AutoSize | Out-String -Width 200");

  const noShell = TOOLS.filter(t => t.name !== 'Bash');
  const g = plan([call('list_directory', { path: 'src', depth: 1 }, 'a'), call('list_directory', { path: 'src', depth: 2 }, 'b')], { tools: noShell });
  assert.deepEqual(g.uses.map(u => u.input), [{ pattern: '*', path: 'C:\\proj\\src' }, { pattern: '**/*', path: 'C:\\proj\\src' }]);
  assert.equal(g.pending[0].note, '(fichiers seulement)');
  const out = translateResult({ content: 'C:\\proj\\src\\a.js' }, g.pending[0], g.ctx);
  assert.equal(out.output, 'C:\\proj\\src\\a.js\n(fichiers seulement)');
});

test('repli PowerShell quand Bash est absent : Push-Location, apostrophes typographiques doublées, seules les clés du schéma', () => {
  const toolsPs = TOOLS.filter(t => t.name !== 'Bash').concat(PS_TOOL);
  const r = plan([call('run_command', { command: 'Get-Date', cwd: 'l\u2019été', timeout_seconds: 5 }, 'a'),
    call('run_command', { command: 'dir # liste', cwd: 'src' }, 'b')], { tools: toolsPs });
  assert.equal(r.uses[0].name, 'PowerShell');
  assert.equal(r.uses[0].input.command, "Push-Location -LiteralPath 'C:\\proj\\l\u2019\u2019été'; try { Get-Date } finally { Pop-Location }");
  assert.equal(r.uses[0].input.timeout, 5000);
  assert.equal(r.uses[1].input.command, "Push-Location -LiteralPath 'C:\\proj\\src'; try {\ndir # liste\n} finally { Pop-Location }");
  // schéma PowerShell réduit (s'il change) : on n'émet que ses clés
  const tiny = toolsPs.filter(t => t.name !== 'PowerShell').concat({ name: 'PowerShell', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } });
  const { ctx } = ctxFor(WIN, { tools: tiny });
  const r2 = planToolUses([call('run_command', { command: 'Get-Date', timeout_seconds: 5 })], ctx);
  assert.deepEqual(r2.uses[0].input, { command: 'Get-Date' });
});

test('outil absent, nom inconnu ou argument requis manquant → pas de tool_use, réponse locale', () => {
  const noEdit = TOOLS.filter(t => !['Edit', 'Bash'].includes(t.name));
  const r = plan([
    call('edit_file', { path: 'a', old_text: 'x', new_text: 'y' }, 'a'),
    call('run_command', { command: 'ls' }, 'b'),
    call('delete_file', { path: 'a' }, 'c'),
    call('read_file', {}, 'd'),
    call('write_file', { path: 'a' }, 'e'),
    call('read_file', { path: 'ok.txt' }, 'f'),
  ], { tools: noEdit });
  assert.equal(r.uses.length, 1);
  assert.deepEqual(r.pending.map(p => p.local?.output ?? null), [
    LOCAL.unavailable, LOCAL.unavailable, LOCAL.unavailable, 'Argument manquant : path', 'Argument manquant : content', null]);
  for (const p of r.pending.slice(0, 5)) { assert.equal(p.ccId, null); assert.equal(p.local.isError, true); }
});

test('plus de 32 appels : 32 tool_use, les suivants reçoivent une réponse locale', () => {
  const calls = Array.from({ length: 35 }, (_, i) => call('read_file', { path: `f${i}.txt` }, `c${i}`));
  const r = plan(calls);
  assert.equal(r.uses.length, 32);
  assert.equal(r.pending.length, 35);
  assert.deepEqual(r.pending.slice(32).map(p => p.local.output), Array(3).fill(LOCAL.tooMany));
  assert.equal(new Set(r.uses.map(u => u.id)).size, 32, 'ids uniques');
});

test('Read injecté seulement si le fichier existe et n\'a pas été lu ; une seule fois par fichier et par message', () => {
  const files = { 'C:\\proj\\existe.txt': 'a', 'C:\\proj\\lu.txt': 'b' };
  const r = plan([
    call('edit_file', { path: 'existe.txt', old_text: 'a', new_text: 'b' }, 'a'),
    call('write_file', { path: 'EXISTE.TXT', content: 'c' }, 'b'),
    call('write_file', { path: 'neuf.txt', content: 'c' }, 'c'),
    call('edit_file', { path: 'lu.txt', old_text: 'b', new_text: 'c' }, 'd'),
  ], { files, readSet: { sessionId: 'sess-1', paths: { 'c:\\proj\\lu.txt': true } } });
  assert.deepEqual(r.uses.map(u => u.name), ['Read', 'Edit', 'Write', 'Write', 'Edit']);
  assert.deepEqual(r.uses[0].input, { file_path: 'C:\\proj\\existe.txt', limit: 1 });
  assert.deepEqual(decodeId(r.uses[0].id), { kind: 's', purpose: 'read' });
  assert.deepEqual(r.synthetic, [{ ccId: r.uses[0].id, purpose: 'read', path: 'C:\\proj\\existe.txt' }]);
  assert.ok(r.pending.every(p => p.ccId !== r.uses[0].id), 'le Read injecté n\'est pas un appel FS');
});

test('readSet remis à zéro quand l\'id de session change', () => {
  const files = { 'C:\\proj\\a.txt': 'x' };
  const readSet = { sessionId: 'ancienne', paths: { 'c:\\proj\\a.txt': true } };
  const r = plan([call('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' })], { files, readSet, sessionId: 'nouvelle' });
  assert.equal(r.uses[0].name, 'Read', 'reprise : Claude Code ne connaît peut-être plus la lecture');
  assert.deepEqual(readSet, { sessionId: 'nouvelle', paths: {} });
  const same = { sessionId: 'sess-1', paths: { 'c:\\proj\\a.txt': true } };
  const r2 = plan([call('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' })], { files, readSet: same });
  assert.equal(r2.uses[0].name, 'Edit');
});

// ── Documents GPT ──

test('documents : fichier nommé → Write synthétique (id s|doc) ; HTML → index.html si libre ; sinon mention dans le panneau', () => {
  const docs = [
    { title: 'calc.js', kind: 'code', content: 'export const add = (a, b) => a + b;\n' },
    { title: 'ORBIT — Studio créatif', kind: 'html', content: '<!doctype html><html></html>' },
    { title: 'Rapport \uE200cite\uE201', kind: 'text', content: null },
  ];
  const { ctx } = ctxFor(WIN, { files: { 'C:\\proj\\calc.js': 'ancien' } });
  const r = planDocuments(docs, ctx);
  assertValidUses(r.uses);
  assert.deepEqual(r.uses.map(u => u.name), ['Read', 'Write', 'Write']);
  assert.deepEqual(r.uses[1].input, { file_path: 'C:\\proj\\calc.js', content: docs[0].content });
  assert.equal(r.uses[2].input.file_path, 'C:\\proj\\index.html');
  assert.deepEqual(decodeId(r.uses[1].id), { kind: 's', purpose: 'doc' });
  assert.equal(r.synthetic[1].note, 'Ton document « calc.js » a été écrit dans calc.js. Pour les fichiers, utilise directement write_file et edit_file.');
  assert.equal(r.text, '(Document « Rapport » laissé dans le panneau du site France Student.)');
  const taken = ctxFor(WIN, { files: { 'C:\\proj\\index.html': 'x' } }).ctx;
  assert.equal(planDocuments([docs[1]], taken).uses.at(-1).input.file_path, 'C:\\proj\\orbit-studio-creatif.html');
});

// ── Claude Code → FS : traductions ──

const P_EDIT = { callId: 'c', ccName: 'Edit', path: 'C:\\proj\\src\\a.js', input: { file_path: 'C:\\proj\\src\\a.js', old_string: 'a', new_string: 'b' } };
const P_WRITE = { callId: 'c', ccName: 'Write', path: 'C:\\proj\\a.txt' };
const P_READ = { callId: 'c', ccName: 'Read', path: 'C:\\proj\\src\\a.js' };
const P_BASH = { callId: 'c', ccName: 'Bash', path: null, command: 'npm test' };
const err = text => ({ content: `<tool_use_error>${text}</tool_use_error>`, is_error: true });
const tr = (block, p, env = WIN) => translateResult(block, p, { env, readSet: { sessionId: 's', paths: {} } });

test('traductions du tableau 3.6 (messages réels de Claude Code 2.1.207)', () => {
  const cases = [
    [err('File has not been read yet. Read it first before writing to it.'), P_EDIT, 'Lis d\'abord ce fichier avec read_file, puis refais la modification.', true],
    [err('File content has changed since it was last read. This commonly happens when a linter or formatter run via Bash rewrites the file. Call Read on this file to refresh, then retry the edit.'), P_EDIT,
      'Le fichier a changé depuis ta lecture : relis-le avec read_file, puis refais la modification.', true],
    [err('File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'), P_WRITE,
      'Le fichier a changé depuis ta lecture : relis-le avec read_file, puis refais la modification.', true],
    [err('String to replace not found in file.\nString: foo'), P_EDIT, 'old_text introuvable dans le fichier : relis la zone avec read_file et recopie le texte exact, sans numéros de ligne.', false],
    [err('Found 3 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true.'), P_EDIT,
      'old_text apparaît 3 fois : ajoute du contexte pour le rendre unique, ou mets replace_all à true.', false],
    [err('File does not exist. Note: your current working directory is C:\\proj. Did you mean C:\\proj\\src\\b.js?'), P_READ,
      'Fichier introuvable : src/a.js. Fichier proche : src/b.js.', false],
    [err('File does not exist. Note: your current working directory is C:\\proj.'), P_READ, 'Fichier introuvable : src/a.js.', false],
    [err('EISDIR: illegal operation on a directory, read'), P_READ, 'src/a.js est un dossier : utilise list_directory.', false],
    [err('File content (30000 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file.'), P_READ,
      'Fichier trop gros pour une lecture complète : lis une plage avec start_line et end_line.', false],
    [{ content: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.', is_error: true }, P_EDIT,
      'Action refusée par l\'utilisateur. Arrête-toi et attends ses instructions.', false],
    [{ content: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nutilise plutôt let', is_error: true }, P_BASH,
      'Action refusée par l\'utilisateur. Arrête-toi et attends ses instructions. Il a précisé : utilise plutôt let', false],
    [{ content: 'sortie partielle\n<error>Command was aborted before completion</error>', is_error: true }, P_BASH, 'Commande interrompue par l\'utilisateur.', false],
    [{ content: '[Request interrupted by user for tool use]', is_error: true }, P_READ, 'Commande interrompue par l\'utilisateur.', false],
  ];
  for (const [block, p, want, needsRead] of cases) {
    const r = tr(block, p);
    assert.equal(r.output, want, JSON.stringify(block).slice(0, 80));
    assert.equal(r.isError, true);
    assert.equal(r.needsRead, needsRead);
  }
});

test('permission non accordée (claude -p, règle ask, hook) : traduite en français, vue en E2E', () => {
  const NO = 'Action non autorisée : elle demande l\'accord de l\'utilisateur, qui ne l\'a pas donné. Ne la relance pas : dis ce que tu voulais faire et attends ses instructions.';
  const P_WRITE_ERR = { callId: 'c', ccName: 'Edit', path: 'C:\\proj\\src\\a.js' };
  const cases = [
    ['This command requires approval', P_BASH],
    ['Claude requested permissions to use Bash, but you haven\'t granted it yet.', P_BASH],
    ['Claude requested permissions to write to C:\\proj\\src\\a.js, but you haven\'t granted it yet.', P_WRITE_ERR],
    ['Permission rule \'Bash\' from command line arguments requires approval for this Bash command', P_BASH],
    ['This Bash command contains multiple operations. The following part requires approval: rm -rf x', P_BASH],
    ['Current permission mode (Default) requires approval for this Bash command', P_BASH],
  ];
  for (const [text, p] of cases) {
    const r = tr({ content: text, is_error: true }, p);
    assert.deepEqual([r.output, r.isError, r.needsRead], [NO, true, false], text);
  }
  assert.equal(tr({ content: 'Hook \'garde\' blocked this action: pas de rm', is_error: true }, P_BASH).output, `${NO} Raison : pas de rm`);
  // la sortie d'une commande qui échoue n'est pas prise pour un refus
  assert.equal(tr({ content: 'Exit code 1\nThis command requires approval', is_error: true }, P_BASH).output, 'Exit code 1\nThis command requires approval');
});

test('traductions : succès « vides », Exit code inchangé, noms de paramètres renommés dans les autres erreurs', () => {
  assert.deepEqual(tr({ content: 'No files found' }, { ccName: 'Glob' }), { output: 'Aucun résultat.', isError: false, images: [], needsRead: false });
  assert.equal(tr({ content: 'No matches found' }, { ccName: 'Grep' }).output, 'Aucun résultat.');
  const unchanged = tr({ content: '<system-reminder>This file is already in your context. Refer to it.</system-reminder>' }, P_READ);
  assert.deepEqual([unchanged.output, unchanged.isError], ['Fichier inchangé depuis ta dernière lecture : réutilise ce que tu as déjà.', false]);
  assert.equal(tr({ content: 'Wasted call \u2014 file unchanged since your last Read. Refer to that earlier tool_result instead.' }, P_READ).output,
    'Fichier inchangé depuis ta dernière lecture : réutilise ce que tu as déjà.');
  const exit = tr({ content: 'Exit code 2\nnpm ERR! offset file_path', is_error: true }, P_BASH);
  assert.deepEqual([exit.output, exit.isError], ['Exit code 2\nnpm ERR! offset file_path', true]);
  const cut = tr({ content: 'sortie partielle\n<error>Command was aborted before completion</error>' }, P_BASH);
  assert.deepEqual([cut.output, cut.isError], ['Commande interrompue par l\'utilisateur.', true]);
  assert.equal(tr({ content: 'journal : Command was aborted before completion (hier)' }, P_BASH).isError, false, 'texte ordinaire d\'une commande');
  const other = tr(err('InputValidationError: file_path must be absolute; offset too large; old_string empty'), P_EDIT);
  assert.equal(other.output, 'InputValidationError: path must be absolute; start_line too large; old_text empty');
  // le contenu d'un fichier lu n'est jamais retouché, même s'il contient un message d'erreur de Claude Code
  const read = tr({ content: '1\tFile has not been read yet\n2\tfile_path' }, P_READ);
  assert.deepEqual([read.output, read.isError, read.needsRead], ['1: File has not been read yet\n2: file_path', false, false]);
});

test('Read réussi : « N\\t » et « N→ » deviennent « N: », rappels retirés, chemin noté comme lu', () => {
  const readSet = { sessionId: 's', paths: {} };
  const block = { content: '1\tcontenu de test\n2\t\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware.\n</system-reminder>\n' };
  const r = translateResult(block, P_READ, { env: WIN, readSet });
  assert.equal(r.output, '1: contenu de test\n2: ');
  assert.deepEqual(readSet.paths, { 'c:\\proj\\src\\a.js': true });
  assert.equal(translateResult({ content: '   10\u2192a\n   11\u2192b' }, P_READ, { env: WIN }).output, '10: a\n11: b');
  assert.equal(translateResult({ content: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>' }, P_READ, { env: WIN }).output, '(fichier vide)');
  // capture réelle req-04 : tool_result en chaîne « 1\tcontenu de test\n2\t »
  const tr4 = loadFixture('req-04').body.messages.at(-1).content[0];
  assert.equal(translateResult(tr4, { ccName: 'Read', path: 'C:\\proj\\hello.txt' }, { env: WIN }).output, '1: contenu de test\n2: ');
});

test('condenseTestOutput : node --test, jest et pytest ; courte ou autre commande → inchangée', () => {
  const filler = (n, from = 1) => Array.from({ length: n }, (_, i) => `ok ${i + from} - test ${i + from} qui passe ${'.'.repeat(60)}`);
  const node = [...filler(40), 'not ok 41 - addition', '  ---', '  error: AssertionError [ERR_ASSERTION]: 3 !== 4', ...filler(60, 42), '# tests 101', '# pass 100', '# fail 1'].join('\n');
  const c = condenseTestOutput('node --test test/', node);
  assert.ok(c.length < node.length / 2);
  assert.match(c, /^\[Sortie de test condensée : /);
  assert.match(c, /not ok 41 - addition/);
  assert.match(c, /AssertionError/);
  assert.match(c, /# fail 1$/);
  assert.doesNotMatch(c, /ok 2 - test 2 qui/);

  const jest = ['PASS src/a.test.js', ...filler(50), 'FAIL src/calc.test.js', '  ● add › adds', '    expect(received).toBe(expected)', ...filler(50), 'Tests:       1 failed, 99 passed, 100 total'].join('\n');
  const cj = condenseTestOutput('npx jest', jest);
  assert.match(cj, /FAIL src\/calc\.test\.js/);
  assert.match(cj, /Tests: {7}1 failed/);

  const py = [...filler(60), 'FAILED tests/test_calc.py::test_add - assert 3 == 4', ...filler(40), '==== 1 failed, 99 passed in 0.5s ===='].join('\n');
  const cp = condenseTestOutput('(cd \'C:/proj\' && python -m pytest -q)', py);
  assert.match(cp, /FAILED tests\/test_calc\.py::test_add/);
  assert.match(cp, /1 failed, 99 passed/);

  assert.equal(condenseTestOutput('npm test', 'court'), 'court');
  assert.equal(condenseTestOutput('ls -R', node), node);
  // branché sur translateResult pour Bash
  assert.match(tr({ content: node }, P_BASH).output, /^\[Sortie de test condensée/);
});

// ── Budget de taille ──

test('budget : 40 000 par résultat, une lecture est coupée sur une fin de ligne avec start_line, puis oubliée', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `${i + 1}: ${'x'.repeat(20)}`).join('\n');
  const readSet = { sessionId: 's', paths: { 'c:\\proj\\big.txt': true } };
  const [r] = budget([{ callId: 'a', output: lines, isError: false, _read: 'C:\\proj\\big.txt' }], { readSet, env: WIN });
  assert.ok(r.output.length <= 40000);
  const m = /\n\[… coupé : relis avec start_line=(\d+)\]$/.exec(r.output);
  assert.ok(m, r.output.slice(-80));
  const kept = r.output.slice(0, m.index).split('\n');
  assert.equal(Number(m[1]), Number(kept.at(-1).split(':')[0]) + 1);
  assert.match(kept.at(-1), /^\d+: x{20}$/, 'coupe sur une fin de ligne');
  assert.deepEqual(Object.keys(r), ['callId', 'output', 'isError'], 'champs internes retirés');
  assert.deepEqual(readSet.paths, {}, 'lecture coupée : plus considérée comme lue');
  const [o] = budget([{ callId: 'b', output: 'y'.repeat(100000), isError: false }]);
  assert.ok(o.output.length <= 40000 && o.output.includes('caractères omis'));
});

test('budget : total ≤ 118 000 par parts équitables, les petits résultats intacts', () => {
  const rs = [
    { callId: 'a', output: 'a'.repeat(39000), isError: false },
    { callId: 'b', output: 'b'.repeat(39000), isError: false },
    { callId: 'c', output: 'c'.repeat(39000), isError: false },
    { callId: 'd', output: 'd'.repeat(39000), isError: false },
    { callId: 'e', output: 'petit', isError: true },
  ];
  const out = budget(rs);
  const sum = out.reduce((s, r) => s + r.output.length, 0);
  assert.ok(sum <= 118000, `somme ${sum}`);
  assert.equal(out[4].output, 'petit');
  assert.deepEqual(out.map(r => r.callId), ['a', 'b', 'c', 'd', 'e']);
  for (const r of out.slice(0, 4)) { assert.ok(r.output.length > 25000); assert.match(r.output, /\[… coupé : lis une plage plus étroite\]$/); }
  assert.deepEqual(budget([{ callId: 'x', output: 'ok', isError: false }]), [{ callId: 'x', output: 'ok', isError: false }]);
});

// ── collectResults ──

test('collectResults : une réponse par appel, dans l\'ordre ; locales, manquantes ; id s jamais dans toolResults', async () => {
  const files = { 'C:\\proj\\a.txt': 'x' };
  const r = plan([
    call('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' }, 'c1'),
    call('read_file', { path: 'b.txt' }, 'c2'),
    call('delete_file', { path: 'z' }, 'c3'),
    call('run_command', { command: 'ls' }, 'c4'),
  ], { files });
  const [inj, edit, read, bash] = r.uses;
  assert.equal(inj.name, 'Read');
  const results = {
    [inj.id]: { content: '1\tx' },
    [edit.id]: { content: 'The file C:\\proj\\a.txt has been updated successfully.' },
    [read.id]: { content: '1\tbonjour' },
    toolu_capture1: { content: 'sortie étrangère' },
  };
  const out = await collectResults(r.pending, new Map(Object.entries(results)), { ...r.ctx, synthetic: r.synthetic });
  assert.deepEqual(out.toolResults, [
    { callId: 'c1', output: 'The file C:\\proj\\a.txt has been updated successfully.', isError: false },
    { callId: 'c2', output: '1: bonjour', isError: false },
    { callId: 'c3', output: LOCAL.unavailable, isError: true },
    { callId: 'c4', output: LOCAL.notRun, isError: true },
  ]);
  assert.ok(!out.toolResults.some(t => t.callId === inj.id || decodeId(t.callId)), 'aucun id synthétique');
  assert.deepEqual(out.notes, ['(Résultat d\'une action précédente : sortie étrangère)']);
  assert.deepEqual(out.retry, []);
  assert.ok(r.ctx.readSet.paths['c:\\proj\\a.txt'] && r.ctx.readSet.paths['c:\\proj\\b.txt']);
  assert.equal(bash.name, 'Bash');
});

test('micro-tour : « not read yet » → retry [Read, même Edit (id r)] ; le second essai est définitif ; partial réutilisé', async () => {
  const r = plan([call('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' }, 'c1'), call('read_file', { path: 'b.txt' }, 'c2')]);
  const [edit, read] = r.uses;
  const first = await collectResults(r.pending, {
    [edit.id]: err('File has not been read yet. Read it first before writing to it.'),
    [read.id]: { content: '1\tb' },
  }, r.ctx);
  assert.deepEqual(first.retry.map(p => p.callId), ['c1']);
  assert.deepEqual(first.toolResults, [{ callId: 'c2', output: '1: b', isError: false }]);

  const micro = planRetry(first.retry, r.ctx);
  assertValidUses(micro.uses);
  assert.deepEqual(micro.uses.map(u => u.name), ['Read', 'Edit']);
  assert.deepEqual(micro.uses[0].input, { file_path: 'C:\\proj\\a.txt' });
  assert.deepEqual(micro.uses[1].input, edit.input);
  assert.deepEqual(decodeId(micro.uses[1].id), { kind: 'r', chatId: 'chat-1', callId: 'c1', n: 1 });
  assert.equal(r.pending[0].retried, 1);

  const second = await collectResults(r.pending, {
    [micro.uses[0].id]: { content: '1\tx' },
    [micro.uses[1].id]: err('File has not been read yet. Read it first before writing to it.'),
  }, { ...r.ctx, partial: first.toolResults, synthetic: micro.synthetic });
  assert.deepEqual(second.retry, [], 'pas de troisième essai');
  assert.deepEqual(second.toolResults, [
    { callId: 'c1', output: 'Lis d\'abord ce fichier avec read_file, puis refais la modification.', isError: true },
    { callId: 'c2', output: '1: b', isError: false },
  ]);
});

test('collectResults : images → uploadFile simulé → files (4 au plus), PDF signalé, échec d\'envoi signalé', async () => {
  const r = plan([call('read_file', { path: 'shot.png' }, 'c1'), call('run_command', { command: 'capture' }, 'c2')]);
  const img = (d = 'iVBORw0KGgo=') => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: d } });
  const results = {
    [r.uses[0].id]: { content: [img()] },
    [r.uses[1].id]: { content: [{ type: 'text', text: 'captures :' }, img(), img(), img(), img(), { type: 'document', source: {} }] },
  };
  const out = await collectResults(r.pending, results, r.ctx);
  assert.deepEqual(out.files, ['file-1', 'file-2', 'file-3', 'file-4']);
  assert.equal(r.fake.calls.uploadFile.length, 4);
  assert.deepEqual(r.fake.calls.uploadFile[0], { filename: 'shot.png', mime: 'image/png', size: 8 });
  assert.equal(out.toolResults[0].output, '[image jointe : shot.png]');
  assert.equal(out.toolResults[1].output, 'captures :\n[image jointe : image-1.png]\n[image jointe : image-2.png]\n[image jointe : image-3.png]\n[image non transmise : image-4.png]\n[document PDF non transmis]');

  const failing = fakeFs({ uploadFail: 503 });
  const r2 = plan([call('read_file', { path: 'shot.png' }, 'c1')]);
  const out2 = await collectResults(r2.pending, { [r2.uses[0].id]: { content: [img()] } }, { ...r2.ctx, uploadFile: failing.uploadFile });
  assert.deepEqual(out2.files, []);
  assert.equal(out2.toolResults[0].output, '[image non transmise : shot.png]');
});

test('collectResults : document écrit → note ; document refusé → note de refus ; budget appliqué', async () => {
  const { ctx } = ctxFor(WIN);
  const d = planDocuments([{ title: 'notes.md', kind: 'text', content: '# Notes' }, { title: 'b.py', kind: 'code', content: 'print(1)' }], ctx);
  const [w1, w2] = d.uses;
  const big = Array.from({ length: 5000 }, (_, i) => `${i + 1}\t${'z'.repeat(30)}`).join('\n');
  const r = plan([call('read_file', { path: 'big.txt' }, 'c1')]);
  const out = await collectResults(r.pending, {
    [w1.id]: { content: 'File created successfully at: C:\\proj\\notes.md' },
    [w2.id]: { content: 'The user doesn\'t want to proceed with this tool use.', is_error: true },
    [r.uses[0].id]: { content: big },
  }, { ...r.ctx, synthetic: d.synthetic });
  assert.deepEqual(out.notes, [
    'Ton document « notes.md » a été écrit dans notes.md. Pour les fichiers, utilise directement write_file et edit_file.',
    'L\'utilisateur a refusé d\'écrire b.py.',
  ]);
  assert.ok(out.toolResults[0].output.length <= 40000);
  assert.match(out.toolResults[0].output, /\[… coupé : relis avec start_line=\d+\]$/);
  assert.ok(!r.ctx.readSet.paths['c:\\proj\\big.txt'], 'lecture coupée oubliée');
});
