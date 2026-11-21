// Sorties de commandes réduites pour le modèle (src/output.js) et liste de tâches fusionnée (src/todos.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipMiddle, fitOutput, commandOutput, collapseRepeats, resolveCarriageReturns, condenseTestOutput, shares } from '../src/output.js';
import { mergeTodos, todoView } from '../src/todos.js';
import { workPreferences, shellEnv } from '../src/pseudo.js';

// build bavard comme au banc : barre de progression, 180 modules, lignes répétées, 2 avertissements noyés au milieu
function noisyBuild() {
  let s = 'mini-stats build v2.4.1\n';
  for (let i = 0; i <= 40; i++) s += `\r[${'#'.repeat(i)}${' '.repeat(40 - i)}] ${Math.round(i * 2.5)}%`;
  s += '\n';
  for (let i = 1; i <= 180; i++) {
    s += `compiling module ${i}/180 (src/chunk-${String(i).padStart(3, '0')}.js)\n`;
    if (i === 97) s += 'WARN deprecated option --legacy-math used in build config (removed in v3)\n';
    if (i % 3 === 0) s += 'info: cache hit\ninfo: cache hit\ninfo: cache hit\n';
  }
  for (let i = 0; i < 60; i++) s += 'info: optimizing assets...\n';
  s += 'WARN src/stats.js: function "max" has no documentation comment\n';
  for (let i = 0; i < 40; i++) s += 'info: writing dist/chunk files\n';
  return s + 'build done: 180 modules, 2 warnings, 0 errors in 1.24s';
}

test('sortie courte : inchangée (seule la barre de progression garde son état final)', () => {
  assert.equal(fitOutput('ok\nfini'), 'ok\nfini');
  assert.equal(resolveCarriageReturns('10%\r50%\r100%\nfin'), '100%\nfin');
  assert.equal(resolveCarriageReturns('a\r\nb'), 'a\nb');
  assert.equal(resolveCarriageReturns('texte\r'), 'texte');
  assert.equal(commandOutput('npm run build', 'court'), 'court');
});

test('build bavard : les 2 avertissements et le bilan restent, ≈ 10 fois plus court que la coupe début + fin', () => {
  const raw = noisyBuild();
  const old = clipMiddle(raw.replace(/\r/g, ''));
  assert.ok(!old.includes('legacy-math'));                               // l'ancienne coupe perdait l'avertissement du milieu
  const out = commandOutput('npm run build', raw);
  assert.ok(out.includes('WARN deprecated option --legacy-math'));
  assert.ok(out.includes('function "max" has no documentation comment'));
  assert.ok(out.includes('build done: 180 modules, 2 warnings, 0 errors'));
  assert.ok(out.includes('[########################################] 100%'));
  assert.ok(!out.includes('] 2%'));
  assert.ok(out.includes('lignes semblables'));
  assert.ok(out.length < 2000, `${out.length}`);
});

test('regroupement : identiques « [× N] », semblables (nombres) résumés, lignes importantes jamais regroupées', () => {
  assert.equal(collapseRepeats('a\nx\nx\nx\nx\nb'), 'a\nx  [× 4]\nb');
  assert.equal(collapseRepeats('x\nx\ny'), 'x\nx\ny');                    // 2 fois : laissé tel quel
  const lines = Array.from({ length: 10 }, (_, i) => `step ${i + 1}/10`).join('\n');
  assert.equal(collapseRepeats(lines), 'step 1/10\n[… 8 lignes semblables]\nstep 10/10');
  const withErr = ['step 1', 'step 2', 'step 3', 'error 4 failed', 'step 5', 'step 6', 'step 7', 'step 8'].join('\n');
  assert.ok(collapseRepeats(withErr).includes('error 4 failed'));
});

test('très longue sortie sans motif : début, fin et toutes les lignes d\'erreur du milieu, sous la limite', () => {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(i === 1500 ? 'Error: cannot find module "zod"' : i === 2200 ? 'npm WARN deprecated glob@7' : `fichier ${Math.random().toString(36).slice(2)} copié vers dist/${i}`);
  const out = fitOutput(lines.join('\n'), 12000);
  assert.ok(out.length <= 12000, `${out.length}`);
  assert.ok(out.includes('Error: cannot find module "zod"'));
  assert.ok(out.includes('npm WARN deprecated glob@7'));
  assert.ok(out.includes(lines[0]) && out.includes(lines[2999]));
  assert.match(out, /lignes omises au milieu ; 2 lignes d'erreur\/avertissement gardées/);
});

test('ligne géante (fichier minifié) : coupe par caractères, sous la limite', () => {
  const out = fitOutput('x'.repeat(50000), 12000);
  assert.ok(out.length <= 12000);
});

test('tests condensés : échecs, avertissements et bilan ; autres commandes inchangées', () => {
  const lines = [];
  for (let i = 1; i <= 300; i++) lines.push(`ok ${i} - test ${i}`, '  ---', `  duration_ms: ${i}.5`, '  ...');
  lines.splice(400, 0, '(node:123) ExperimentalWarning: VM Modules is an experimental feature');
  lines.push('not ok 301 - moyenne', '  error: Expected 4, got 6', '# tests 301', '# pass 300', '# fail 1');
  const out = condenseTestOutput('node --test', lines.join('\n'));
  assert.ok(out.length < 3000, `${out.length}`);
  assert.ok(out.includes('not ok 301 - moyenne') && out.includes('Expected 4, got 6') && out.includes('# fail 1'));
  assert.ok(out.includes('ExperimentalWarning'));
  assert.equal(condenseTestOutput('ls -R', lines.join('\n')), lines.join('\n'));
});

test('parts équitables : les petits intacts, les gros se partagent le reste', () => {
  assert.deepEqual(shares([1000, 60000, 60000, 60000], 120000), [1000, 39666, 39666, 39666]);
  assert.deepEqual(shares([10, 20], 120000), [10, 20]);
});

test('liste de tâches : le modèle n\'écrit que la ligne qui change, la liste complète est affichée', () => {
  const S = {};
  assert.deepEqual(mergeTodos(S, ['- [ ] Lire le code', '- [ ] Corriger average', '- [ ] Lancer les tests']), ['- [ ] Lire le code', '- [ ] Corriger average', '- [ ] Lancer les tests']);
  assert.deepEqual(mergeTodos(S, ['- [x] Lire le code', '- [~] Corriger average']), ['- [x] Lire le code', '- [~] Corriger average', '- [ ] Lancer les tests']);
  assert.deepEqual(mergeTodos(S, ['- [x] Lancer les tests (npm test)']), ['- [x] Lire le code', '- [~] Corriger average', '- [x] Lancer les tests']);
  // liste complète réécrite quand même : même affichage
  assert.deepEqual(mergeTodos(S, ['- [x] Lire le code', '- [x] Corriger average', '- [x] Lancer les tests']), ['- [x] Lire le code', '- [x] Corriger average', '- [x] Lancer les tests']);
  // liste sans rapport : remplace l'ancienne, affichée telle quelle
  assert.deepEqual(mergeTodos(S, ['- [x] Tout est vert']), ['- [x] Tout est vert']);
  assert.deepEqual(S.todos, [{ mark: 'x', text: 'Tout est vert' }]);
  // nouvelle liste (toutes à faire) : repart de zéro même si un intitulé ressemble
  mergeTodos(S, ['- [ ] Tout est vert', '- [ ] Publier']);
  assert.equal(S.todos.length, 2);
});

test('affichage en direct : texte normal immédiat, lignes de liste remplacées par la liste à jour (morceaux coupés n\'importe où)', () => {
  const S = { todos: [{ mark: ' ', text: 'Lire le code' }, { mark: ' ', text: 'Corriger average' }] };
  const v = todoView(S);
  const input = 'C\'est fait.\n- [x] Lire le code\n- [~] Corriger average\nJe continue avec - [x] dans le texte.\n';
  let out = '';
  for (let i = 0; i < input.length; i += 3) out += v.push(input.slice(i, i + 3));
  out += v.flush();
  assert.equal(out, 'C\'est fait.\n- [x] Lire le code\n- [~] Corriger average\nJe continue avec - [x] dans le texte.\n');
  const v2 = todoView(S);
  out = v2.push('Bilan :\n- [x] Corriger average') + v2.flush();
  assert.equal(out, 'Bilan :\n- [x] Lire le code\n- [x] Corriger average\n');
  const v3 = todoView({});                                               // listes à puces ordinaires : passent tout de suite
  assert.equal(v3.push('- un point\n- deux'), '- un point\n- deux');
  assert.equal(v3.flush(), '');
});

test('préférences v4 : liste allégée, actions groupées, environnement ; toujours aucun nom d\'outil', () => {
  const p = workPreferences('Mon PC : Windows ; les commandes passent par Windows PowerShell 5.1.');
  assert.match(p.text, /n'écris que les lignes qui changent/);
  assert.match(p.text, /Fais d'un coup les actions indépendantes/);
  assert.match(p.text, /Mon PC : Windows/);
  assert.doesNotMatch(p.text, /read_file|run_command|edit_file|write_file|search_files|list_directory|FS-CLI|fs-mcp/);
  assert.ok(p.text.length < 1100, `${p.text.length}`);
  assert.match(shellEnv('win32', 'powershell', 'Windows PowerShell 5.1'), /« && » n'y existe pas/);
  assert.doesNotMatch(shellEnv('win32', 'pwsh', 'PowerShell 7.5.0'), /&&/);
  assert.match(shellEnv('darwin'), /macOS ; les commandes passent par bash/);
});

test('indicateur d\'attente : « ↓ N tokens » en direct pendant la demande, durée depuis le début de la demande, rien hors demande', async () => {
  const ui = await import('../src/ui.js');
  const frames = [];
  ui.attachSink({ print() {}, spinner: t => { if (t) frames.push(ui.stripAnsi(t)); } });
  try {
    ui.liveTokens.add('x'.repeat(700));                                  // hors demande : ignoré
    ui.spinner.start('réflexion…'); ui.spinner.stop();
    assert.doesNotMatch(frames.at(-1), /tokens/);
    ui.liveTokens.reset();
    ui.liveTokens.add('x'.repeat(350));
    ui.spinner.start('réflexion…');
    assert.match(frames.at(-1), /\(0 s · ↓ 100 tokens · échap pour interrompre\)/);
    ui.liveTokens.add('y'.repeat(3500));
    await new Promise(r => setTimeout(r, 120));
    assert.match(frames.at(-1), /↓ 1,1k tokens/);
    ui.spinner.stop(); ui.liveTokens.end();
    ui.spinner.start('réflexion…'); ui.spinner.stop();
    assert.doesNotMatch(frames.at(-1), /tokens/);
  } finally { ui.spinner.stop(); ui.liveTokens.end(); ui.attachSink(null); }
});

test('/plus-tard : « 5h », « 5h30 », « 05:00 » → prochaine occurrence ; le reste n\'est pas une heure', async () => {
  const { parseHour } = await import('../src/schedule.js');
  const now = new Date(2026, 10, 21, 22, 15);                            // 21/11 22:15
  const t = d => d && `${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(t(parseHour('5h', now)), '22/11 5:00');                    // déjà passée aujourd'hui → demain
  assert.equal(t(parseHour('5h30', now)), '22/11 5:30');
  assert.equal(t(parseHour('05:00', now)), '22/11 5:00');
  assert.equal(t(parseHour('23h', now)), '21/11 23:00');                  // encore à venir aujourd'hui
  for (const s of ['5', 'demain', '25h', '5h75', 'fais', '']) assert.equal(parseHour(s, now), null, s);
});

test('/plus-tard : échéancier sur l\'heure RÉELLE (veille, changement d\'heure), jamais pendant une réponse, un envoi à la fois, annulation', async () => {
  const { createScheduler } = await import('../src/schedule.js');
  let t = 1_000_000, busy = false, changes = 0;
  const sent = [];
  const s = createScheduler({ run: async x => { sent.push(x); }, isBusy: () => busy, onChange: () => changes++, now: () => t, tickMs: 3_600_000 });
  const a = s.add(t + 60_000, 'A'), b = s.add(t + 120_000, 'B'), c = s.add(t + 30_000, 'C');
  assert.equal(s.next().text, 'C');
  assert.deepEqual(s.cancel(c.id).map(x => x.text), ['C']);
  await s.tick(); assert.deepEqual(sent, [], 'pas encore l\'heure');
  t += 10 * 3_600_000;                                                     // PC sorti de veille 10 h plus tard : l'heure réelle fait foi
  busy = true; await s.tick(); assert.deepEqual(sent, [], 'réponse en cours : on attend');
  busy = false; await s.tick(); assert.deepEqual(sent, ['A'], 'un seul envoi par passage, le plus ancien d\'abord');
  await s.tick(); assert.deepEqual(sent, ['A', 'B']);
  assert.equal(s.list().length, 0);
  assert.ok(changes >= 5);
  assert.equal(a.id + 1, b.id);
  s.stop();
});
