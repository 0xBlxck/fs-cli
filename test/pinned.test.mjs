// La zone de saisie est ancrée en bas de la fenêtre, quelle que soit sa taille (comme Claude Code)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStreams } from './term-sim.js';
import { Tui } from '../src/tui/tui.js';

const ESC = '\x1b';
function make({ cols = 70, rows = 20, suggester } = {}) {
  const f = fakeStreams(cols, rows);
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, suggester });
  tui.setStatus({ model: 'Claude Sonnet 5.5', mode: 'auto' });
  tui.start();
  return { ...f, tui };
}
const last = sim => sim.lines()[sim.rows - 1];

test('au démarrage : le contenu part du haut, la saisie est tout en bas', async () => {
  const { sim, tick, tui } = make({ rows: 20 });
  await tick();
  const L = sim.lines();
  assert.match(L[19], /⏵⏵ auto/);                       // barre d'état = dernière ligne
  assert.match(L[18], /^╰─{20,}╯/);                       // bas du cadre
  assert.match(L[17], /^│ > Essaie « /);                 // saisie (astuce)
  assert.match(L[16], /^╭─{20,}╮/);                       // haut du cadre
  assert.match(L[15], /Claude Sonnet 5\.5\s*$/);          // modèle à droite, au-dessus
  for (let y = 0; y < 15; y++) assert.equal(L[y], '', `ligne ${y} vide (rien entre le haut et la barre)`);
  tui.print('bannière\n'); await tick();
  assert.equal(sim.lines()[0], 'bannière', 'le contenu s\'écrit depuis le haut');
  assert.match(last(sim), /⏵⏵ auto/);
  tui.stop();
});

test('quand le contenu dépasse l\'écran : la barre reste en bas, l\'historique défile', async () => {
  const { sim, tick, tui } = make({ rows: 20 });
  for (let i = 1; i <= 60; i++) tui.print(`ligne ${i}\n`);
  await tick();
  assert.match(last(sim), /⏵⏵ auto/);
  assert.equal(sim.lines()[14], 'ligne 60', 'le dernier texte est juste au-dessus de la barre');
  assert.equal(sim.count(/ligne 1\b/g), 1); assert.equal(sim.count(/ligne 60\b/g), 1);
  assert.ok(sim.scrollback.includes('ligne 1'), 'les anciennes lignes sont dans l\'historique du terminal');
  assert.equal(sim.count(/Essaie « /g), 1);
  tui.stop();
});

test('la zone grandit (saisie multi-ligne, suggestions) sans écraser le contenu', async () => {
  const cmds = ['/model', '/mode', '/models', '/memory'].map(n => ({ label: n, insert: n, desc: 'x' }));
  const { sim, type, tick, tui } = make({ rows: 20, suggester: b => /^\/\S*$/.test(b) ? { start: 0, items: cmds.filter(c => c.label.startsWith(b)) } : null });
  for (let i = 1; i <= 40; i++) tui.print(`ligne ${i}\n`);
  await tick();
  type('a\nb\nc'); await tick();                          // 3 lignes de saisie : +2 lignes de zone
  assert.match(last(sim), /⏵⏵ auto/);
  assert.equal(sim.count(/ligne 40\b/g), 1, 'le dernier texte n\'est ni perdu ni écrasé');
  assert.match(sim.screen(), /ligne 40\n[\s\S]*│ > a\s*│\n│   b\s*│\n│   c/);
  type(ESC); type('/m'); await tick();                    // Échap vide la saisie ; suggestions sous le trait
  assert.match(sim.screen(), /\/model/); assert.match(last(sim), /⏵⏵ auto/);
  type(ESC); type(ESC); await tick();                     // ferme la liste puis efface : retour à la taille minimale
  assert.match(last(sim), /⏵⏵ auto/); assert.doesNotMatch(sim.screen(), /\/model/);
  assert.equal(sim.count(/ligne 40\b/g), 1);
  assert.equal(sim.count(/Essaie « /g), 1);
  tui.stop();
});

test('redimensionnement : la barre suit le bas de la fenêtre', async () => {
  const { sim, tick, tui, resize } = make({ cols: 70, rows: 20 });
  tui.print('un\ndeux\n'); await tick();
  resize(90, 30); await tick();                           // plus grande
  assert.match(last(sim), /⏵⏵ auto/); assert.match(sim.lines()[28], /^╰─{20,}╯/);   // bas du cadre
  assert.match(sim.lines()[27], /^│ > Essaie « /); assert.match(sim.lines()[26], /^╭─{20,}╮/);
  resize(60, 12); await tick();                           // plus petite
  assert.match(last(sim), /⏵⏵ auto/); assert.match(sim.lines()[9], /^│ > Essaie « /);
  tui.print('après\n'); await tick();
  assert.match(sim.screen(), /après/); assert.match(last(sim), /⏵⏵ auto/);
  assert.equal(sim.count(/Essaie « /g), 1);
  tui.stop();
});

test('largeur étroite : rien ne déborde, la barre reste en bas', async () => {
  const { sim, type, tick, tui } = make({ cols: 28, rows: 14 });
  type('un texte long qui doit passer à la ligne'); await tick();
  assert.match(last(sim), /auto/);
  assert.equal(sim.count(/Essaie « /g), 0);
  assert.ok(sim.screen().includes('> un texte'));
  tui.stop();
});

test('menu de confirmation : ancré en bas, le contenu reste visible', async () => {
  const { sim, type, tick, tui } = make({ rows: 24 });
  tui.print('contexte important\n'); await tick();
  const p = tui.select({ title: 'Action sensible', detail: 'Remove-Item x.txt', options: ['Oui', 'Non'] });
  await tick();
  assert.match(sim.screen(), /contexte important/); assert.match(sim.screen(), /Action sensible/); assert.match(sim.screen(), /❯ 1\. Oui/);
  assert.match(last(sim), /Échap = refuser/);
  type('\r'); assert.equal(await p, 0); await tick();
  assert.match(last(sim), /⏵⏵ auto/); assert.doesNotMatch(sim.screen(), /Action sensible/);
  tui.stop();
});

test('clear (Ctrl+L) : écran propre, barre toujours en bas', async () => {
  const { sim, type, tick, tui } = make({ rows: 20 });
  tui.print('avant\n'); await tick();
  type('\x0c'); await tick();
  assert.doesNotMatch(sim.screen(), /avant/); assert.match(last(sim), /⏵⏵ auto/);
  tui.print('après\n'); await tick();
  assert.equal(sim.lines()[0], 'après');
  tui.stop();
});
