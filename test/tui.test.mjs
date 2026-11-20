import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStreams } from './term-sim.js';
import { KeyParser } from '../src/tui/keys.js';
import { layoutInput, indexAt, clipAnsi, strWidth } from '../src/tui/layout.js';
import { Tui } from '../src/tui/tui.js';

const ESC = '\x1b';
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function make(opts = {}) {
  const f = fakeStreams(opts.cols || 60, opts.rows || 20);
  const submits = [];
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, history: opts.history || [], suggester: opts.suggester });
  tui.on('submit', t => submits.push(t));
  tui.setStatus({ model: 'Claude Sonnet 5.5', mode: 'auto' });
  tui.start();
  return { ...f, tui, submits };
}

// ── clavier ───────────────────────────────────────────────────────────────────
test('KeyParser : flèches, ctrl, alt, collage encadré, séquence coupée', () => {
  const keys = []; const p = new KeyParser(k => keys.push(k));
  p.feed(`${ESC}[A${ESC}[B${ESC}[1;5C${ESC}[3~${ESC}[Z\r\t\x7f\x03${ESC}b${ESC}\r`);
  assert.deepEqual(keys.map(k => k.name + (k.ctrl ? '^' : '') + (k.meta ? '~' : '')), ['up', 'down', 'right^', 'delete', 'shift-tab', 'enter', 'tab', 'backspace', 'c^', 'b~', 'newline~']);
  keys.length = 0;
  p.feed(`a${ESC}[200~l1\r\nl2${ESC}[201~z`);
  assert.deepEqual(keys, [{ name: 'text', text: 'a' }, { name: 'paste', text: 'l1\nl2' }, { name: 'text', text: 'z' }]);
  keys.length = 0;
  p.feed(`${ESC}[2`); p.feed('0~');                                    // séquence coupée entre deux morceaux (touche 20~ inconnue)
  p.feed(`${ESC}[1;`); p.feed('5D');
  assert.deepEqual(keys.map(k => k.name + (k.ctrl ? '^' : '')), ['left^']);
  keys.length = 0;
  p.feed('é😀');                                                      // UTF-8 multi-octets
  assert.equal(keys[0].text, 'é😀');
});

test('KeyParser : collage sans marqueurs contenant des retours à la ligne', () => {
  const keys = []; const p = new KeyParser(k => keys.push(k));
  p.feed('ligne 1\rligne 2\r');
  assert.deepEqual(keys, [{ name: 'paste', text: 'ligne 1\nligne 2' }]);
  keys.length = 0; p.feed('\r'); assert.equal(keys[0].name, 'enter');  // une frappe Entrée seule reste une frappe
});

// ── mise en page ──────────────────────────────────────────────────────────────
test('layoutInput : retour à la ligne, curseur, indexAt', () => {
  let l = layoutInput('abcdefghij', 10, 4);
  assert.deepEqual(l.lines, ['abcd', 'efgh', 'ij']); assert.deepEqual(l.caret, { row: 2, col: 2 });
  l = layoutInput('abcd', 4, 4);                                      // ligne pleine : le curseur passe à la ligne suivante
  assert.deepEqual(l.caret, { row: 1, col: 0 }); assert.equal(l.lines.length, 2);
  l = layoutInput('a\nbc\n', 5, 10);
  assert.deepEqual(l.lines, ['a', 'bc', '']); assert.deepEqual(l.caret, { row: 2, col: 0 });
  l = layoutInput('ab\ncd', 1, 10); assert.deepEqual(l.caret, { row: 0, col: 1 });
  assert.equal(indexAt(layoutInput('ab\ncdef', 0, 10), 1, 3), 6);
  assert.equal(strWidth('日本a'), 5);
  assert.equal(strWidth(clipAnsi('\x1b[31mabcdefghij\x1b[0m', 6)), 6);
});

// ── rendu ─────────────────────────────────────────────────────────────────────
test('la boîte de saisie et la barre d\'état s\'affichent', async () => {
  const { sim, type, tick, tui } = make();
  await tick();
  const s = sim.screen();
  assert.equal(sim.count(/^[╭╰]─{20,}[╮╯]$/gm), 2, 'un cadre aux coins arrondis (haut et bas)');
  assert.match(s, /Essaie « /); assert.match(s, /⏵⏵ auto/); assert.match(s, /Claude Sonnet 5\.5/);
  type('bonjour'); await tick();
  assert.match(sim.screen(), /│ > bonjour/);
  assert.equal(sim.c, 4 + 7);                                         // curseur juste après « bonjour » (« │ > » + « bonjour »)
  tui.stop();
});

test('le texte défile au-dessus sans dupliquer le footer', async () => {
  const { sim, tick, tui } = make();
  for (let i = 1; i <= 30; i++) tui.print(`ligne ${i}\n`);
  await tick(); await tick();
  tui.print('fin\n'); await tick();
  assert.equal(sim.count(/Essaie « /g), 1, 'une seule zone de saisie (rien dans l\'historique défilé)');
  assert.equal(sim.count(/ligne 17\b/g), 1);
  assert.match(sim.all(), /ligne 1\n/); assert.match(sim.screen(), /fin\n[\s\S]*─{10,}/);
  tui.stop();
});

test('spinner : visible dans le footer, puis retiré', async () => {
  const { sim, tick, tui } = make();
  tui.spinner('⠋ réflexion… 3s');
  await tick();
  assert.match(sim.screen(), /réflexion… 3s/);
  tui.print('texte pendant le spinner\n'); await tick();
  assert.match(sim.screen(), /texte pendant le spinner[\s\S]*réflexion… 3s[\s\S]*─{10,}/);
  tui.spinner(null); await tick();
  assert.doesNotMatch(sim.screen(), /réflexion/);
  tui.stop();
});

// ── saisie ────────────────────────────────────────────────────────────────────
test('Entrée envoie, écho dans l\'historique, saisie vidée', async () => {
  const { sim, type, tick, tui, submits } = make();
  type('salut'); type('\r'); await tick();
  assert.deepEqual(submits, ['salut']);
  assert.match(sim.all(), /^> salut/m);
  assert.match(sim.screen(), /Essaie « /);
  tui.stop();
});

test('édition : curseur, suppression, mots, ctrl+u/k', async () => {
  const { type, tick, tui } = make();
  type('hello world'); type(`${ESC}[D${ESC}[D${ESC}[D`);               // 3 × gauche
  assert.equal(tui.cur, 8);
  type('\x7f'); assert.equal(tui.buf, 'hello wrld');
  type('\x17'); assert.equal(tui.buf, 'hello rld');                   // ctrl+w
  type('\x01'); type('>'); assert.equal(tui.buf, '>hello rld');       // ctrl+a
  type('\x0b'); assert.equal(tui.buf, '>');                           // ctrl+k
  type('\x15'); assert.equal(tui.buf, '');                            // ctrl+u
  type('é'); type('\x7f'); assert.equal(tui.buf, '');
  type('😀'); type(`${ESC}[D`); assert.equal(tui.cur, 0);             // emoji = un seul pas
  await tick(); tui.stop();
});

test('multi-ligne : ctrl+j, antislash+Entrée, collage encadré', async () => {
  const { sim, type, tick, tui, submits } = make();
  type('a'); type('\n'); type('b'); await tick();
  assert.equal(tui.buf, 'a\nb');
  assert.match(sim.screen(), /│ > a\s*│\n│   b\s*│\n╰─+/);
  type('\\'); type('\r'); type('c'); assert.equal(tui.buf, 'a\nb\nc');
  type(`${ESC}[200~x\ny${ESC}[201~`); assert.equal(tui.buf, 'a\nb\ncx\ny');
  assert.equal(submits.length, 0);
  type('\r'); assert.deepEqual(submits, ['a\nb\ncx\ny']);
  await tick(); tui.stop();
});

test('historique : haut/bas, brouillon conservé', async () => {
  const { type, tui } = make({ history: ['un', 'deux', 'trois'] });
  type('brouillon');
  type(`${ESC}[A`); assert.equal(tui.buf, 'trois');
  type(`${ESC}[A`); assert.equal(tui.buf, 'deux');
  type(`${ESC}[B`); assert.equal(tui.buf, 'trois');
  type(`${ESC}[B`); assert.equal(tui.buf, 'brouillon');
  tui.stop();
});

test('recherche dans l\'historique (ctrl+r)', async () => {
  const { type, tick, sim, tui } = make({ history: ['git status', 'npm test', 'git push'] });
  type('\x12'); type('git'); await tick();
  assert.match(sim.screen(), /recherche[\s\S]*git push/);
  type('\x12'); await tick(); assert.match(sim.screen(), /git status/);
  type('\r'); assert.equal(tui.buf, 'git status');
  tui.stop();
});

test('file d\'attente : un message envoyé pendant le travail attend', async () => {
  const { sim, type, tick, tui, submits } = make();
  tui.setBusy(true);
  type('suite'); type('\r'); await tick();
  assert.equal(submits.length, 0);
  assert.match(sim.screen(), /⧗ en file : suite/);
  tui.setBusy(false);
  assert.equal(tui.takeQueued(), 'suite'); await tick();
  assert.doesNotMatch(sim.screen(), /⧗/);
  tui.stop();
});

test('interruption : Échap et Ctrl+C pendant le travail', async () => {
  const { type, tui } = make();
  let n = 0; tui.on('interrupt', () => n++);
  tui.setBusy(true); type(ESC); type('\x03'); assert.equal(n, 2);
  tui.setBusy(false); type('texte'); type('\x03'); assert.equal(tui.buf, '');   // Ctrl+C efface la saisie
  let quit = 0; tui.on('quit', () => quit++);
  type('\x03'); assert.equal(quit, 0); type('\x03'); assert.equal(quit, 1);       // 2e appui = quitter
  type('\x04'); assert.equal(quit, 2);                                            // Ctrl+D saisie vide
  tui.stop();
});

test('suggestions : /commande, navigation, Tab, Entrée', async () => {
  const cmds = [{ name: '/model', desc: 'changer de modèle' }, { name: '/models', desc: 'liste' }, { name: '/mode', desc: 'auto ou ask' }, { name: '/help', desc: 'aide' }];
  const suggester = (buf) => {
    const m = /^\/(\S*)$/.exec(buf); if (!m) return null;
    return { start: 0, items: cmds.filter(c => c.name.startsWith('/' + m[1])).map(c => ({ label: c.name, insert: c.name, desc: c.desc })) };
  };
  const { sim, type, tick, tui, submits } = make({ suggester });
  type('/mo'); await tick();
  assert.match(sim.screen(), /\/model\s+changer de modèle/); assert.match(sim.screen(), /\/mode\s+auto ou ask/); assert.doesNotMatch(sim.screen(), /\/help/);
  type(`${ESC}[B`); type('\t'); assert.equal(tui.buf, '/model');         // flèche bas puis Tab
  type('\x15'); type('/he'); type(`${ESC}[B`); type('\r');               // Entrée sur une suggestion choisie = exécute
  assert.deepEqual(submits, ['/help']);
  type('/mo'); type(ESC); await tick();                                  // Échap ferme la liste
  assert.doesNotMatch(sim.screen(), /changer de modèle/);
  tui.stop();
});

test('menu de confirmation : flèches, chiffres, Échap', async () => {
  const { sim, type, tick, tui } = make();
  let p = tui.select({ title: 'Action sensible', detail: 'Remove-Item x.txt', options: ['Oui', 'Oui, toujours', 'Non'], defaultIndex: 0 });
  await tick();
  assert.match(sim.screen(), /Action sensible/); assert.match(sim.screen(), /❯ 1\. Oui/); assert.match(sim.screen(), /Remove-Item x\.txt/);
  assert.equal(sim.cursorVisible, false);
  type(`${ESC}[B`); type(`${ESC}[B`); type('\r'); assert.equal(await p, 2);
  await tick(); assert.doesNotMatch(sim.screen(), /Action sensible/); assert.equal(sim.cursorVisible, true);
  p = tui.select({ title: 't', options: ['a', 'b', 'c'] }); type('2'); assert.equal(await p, 1);
  p = tui.select({ title: 't', options: ['a', 'b'] }); type(ESC); assert.equal(await p, null);
  tui.stop();
});

test('askLine : question d\'une ligne, saisie restaurée ensuite', async () => {
  const { sim, type, tick, tui } = make();
  type('brouillon');
  const p = tui.askLine('\x1b[2m  raison ?\x1b[0m'); await tick();
  assert.match(sim.screen(), /raison \?/);
  type('parce que'); type('\r'); assert.equal(await p, 'parce que');
  assert.equal(tui.buf, 'brouillon');
  const q = tui.askLine('autre'); type(ESC); assert.equal(await q, null);
  tui.stop();
});

test('arrêt propre : le footer est effacé et le curseur réaffiché', async () => {
  const { sim, tick, tui } = make();
  tui.print('hello\n'); await tick();
  tui.stop();
  assert.doesNotMatch(sim.screen(), /Essaie « |⏵⏵/); assert.match(sim.screen(), /hello/); assert.equal(sim.cursorVisible, true);
  assert.equal(sim.r, 1, 'le curseur reste juste après le contenu (le shell reprend à la suite)');
});

test('largeur étroite : le footer ne déborde pas', async () => {
  const { sim, tui, tick, type } = make({ cols: 30 });
  type('un texte vraiment très long qui doit passer à la ligne dans la boîte'); await tick();
  for (const l of sim.lines()) assert.ok(strWidth(l) <= 30, `ligne trop large: ${l}`);
  assert.equal(sim.count(/> un texte/g), 1);
  tui.stop();
});

test('toutes les interfaces acceptent un événement qu\'elles ne connaissent pas (ex. « instant » du panneau) sans planter au démarrage', async () => {
  const { createInput } = await import('../src/input.js');
  const f = fakeStreams(80, 20);
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, history: [] });
  assert.doesNotThrow(() => tui.on('instant', () => {}));
  const classic = createInput({ interactive: false, history: [], onHistory() {}, suggester() { return []; }, completer() { return [[], '']; }, promptStr: () => '> ' });
  assert.doesNotThrow(() => classic.on('instant', () => {}));
  classic.stop?.();
});

// ── audit 17/11 : menus de 10 options ou plus, et deux questions en même temps ──
test('menu de 12 options : « 1 » puis « 0 » SÉLECTIONNE l\'option 10 sans valider ; Entrée valide', async () => {
  const { tui, stdin } = make({ rows: 30 });
  const p = tui.select({ title: 'Choix', options: Array.from({ length: 12 }, (_, i) => `option ${i + 1}`), defaultIndex: 11 });
  stdin.emit('data', '1'); stdin.emit('data', '0');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(tui.select_?.idx, 9, 'option 10 sélectionnée');
  stdin.emit('data', '\r');
  assert.equal(await p, 9);
  tui.stop();
});

test('menu de 3 options : un chiffre valide tout de suite (comme avant)', async () => {
  const { tui, stdin } = make();
  const p = tui.select({ title: 'Choix', options: ['a', 'b', 'c'] });
  stdin.emit('data', '2');
  assert.equal(await p, 1);
  tui.stop();
});

test('deux confirmations en même temps : la 2e attend son tour, aucune ne reste bloquée ; Ctrl+C annule tout', async () => {
  const { tui, stdin } = make({ rows: 30 });
  const p1 = tui.select({ title: 'Agent 1', options: ['Oui', 'Non'] });
  const p2 = tui.select({ title: 'Agent 2', options: ['Oui', 'Non'] });
  assert.equal(tui.select_.title, 'Agent 1');
  stdin.emit('data', '1');
  assert.equal(await p1, 0);
  assert.equal(tui.select_?.title, 'Agent 2', 'la 2e question s\'ouvre ensuite');
  stdin.emit('data', '2');
  assert.equal(await p2, 1);
  const p3 = tui.select({ title: 'A', options: ['x', 'y'] });
  const p4 = tui.askLine('Nom ?');
  stdin.emit('data', '\x03');
  assert.equal(await p3, null); assert.equal(await p4, null);
  assert.equal(tui.select_, null); assert.equal(tui.ask, null);
  tui.stop();
});

test('menu plus haut que la fenêtre : options dans une fenêtre autour de la sélection, aide toujours visible, dernière option atteignable', async () => {
  const { tui, stdin, sim } = make({ rows: 12 });
  const p = tui.select({ title: 'Long', detail: 'une ligne\nune autre', options: Array.from({ length: 20 }, (_, i) => `choix ${i + 1}`).concat(['Annuler']) });
  await new Promise(r => setTimeout(r, 20));
  let scr = strip(sim.screen ? sim.screen() : '');
  assert.match(scr, /↓ \d+ de plus/); assert.match(scr, /Entrée valider/);
  for (let i = 0; i < 20; i++) stdin.emit('data', `${ESC}[B`);
  await new Promise(r => setTimeout(r, 20));
  scr = strip(sim.screen());
  assert.match(scr, /❯ 21\. Annuler/); assert.match(scr, /↑ \d+ de plus/);
  stdin.emit('data', '\r');
  assert.equal(await p, 20);
  tui.stop();
});

test('réglette (comme /effort de Claude Code) : ← → déplacent le repère, bloquée aux bouts, Entrée enregistre, Échap annule', async () => {
  const { sim, type, tick, tui } = make();
  const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  let p = tui.select({ title: 'Effort de raisonnement (modèles GPT)', detail: 'Actuel : medium.', options: LEVELS, defaultIndex: 3, slider: { left: 'Plus rapide', right: 'Plus réfléchi' } });
  await tick();
  const scr = sim.screen();
  assert.match(scr, /Plus rapide\s+Plus réfléchi/);
  assert.match(scr, /none\s+minimal\s+low\s+medium\s+high\s+xhigh/, 'niveaux à l\'horizontale');
  assert.match(scr, /▲/);
  assert.match(scr, /← → régler · Entrée enregistrer · Échap annuler/);
  const col = s => { const rows = s.split('\n'); const r = rows.find(l => l.includes('▲')); const lv = rows.find(l => /none\s+minimal/.test(l)); return [r.indexOf('▲'), lv]; };
  const [c0, lv] = col(scr);
  assert.ok(c0 >= lv.indexOf('medium') && c0 < lv.indexOf('medium') + 6, 'repère sous « medium »');
  type(`${ESC}[C`); await tick();
  const [c1, lv1] = col(sim.screen());
  assert.ok(c1 >= lv1.indexOf('high') && c1 < lv1.indexOf('high') + 4, '→ : repère sous « high »');
  type(`${ESC}[C`); type(`${ESC}[C`); type(`${ESC}[C`);                 // bloqué sur xhigh
  type('\r'); assert.equal(await p, 5);
  p = tui.select({ title: 't', options: LEVELS, defaultIndex: 0, slider: { left: 'a', right: 'b' } });
  type(`${ESC}[D`); type(ESC); assert.equal(await p, null, '← au bout puis Échap : annulé');
  tui.stop();
});

test('barre d\'état : budget de chat restant puis contexte restant ; version courte si le terminal est étroit', async () => {
  const { sim, tui, tick } = make({ cols: 110 });
  tui.setStatus({ ctx: 15, budget: 87.4 }); await tick();
  assert.match(sim.screen(), /budget restant : 87 % · contexte restant : 85 %/);
  tui.setStatus({ budget: 0.4 }); await tick();
  assert.match(sim.screen(), /budget restant : 0,4 %/);
  tui.stop();
  const n = make({ cols: 64 });
  n.tui.setStatus({ ctx: 15, budget: 50 }); await n.tick();
  assert.match(n.sim.screen(), /budget 50 % · ctx 85 %/);
  n.tui.setStatus({ budget: null }); await n.tick();
  assert.match(n.sim.screen(), /contexte restant : 85 %/);
  assert.doesNotMatch(n.sim.screen(), /budget/);
  for (const l of n.sim.lines()) assert.ok(strWidth(l) <= 64, `ligne trop large: ${l}`);
  n.tui.stop();
});

test('chatBudget : pourcentage restant du compte, ou null (indisponible, lent)', async () => {
  const { chatBudget, budgetText } = await import('../src/account.js');
  assert.deepEqual(await chatBudget(1000, async () => ({ chatBudget: { usedPercent: 12.6, remainingPercent: 87.4, resetAt: 'x' } })), { left: 87.4, resetAt: 'x' });
  assert.deepEqual(await chatBudget(1000, async () => ({ chatBudget: { usedPercent: 30 } })), { left: 70, resetAt: null });
  assert.equal(await chatBudget(1000, async () => null), null);
  assert.equal(await chatBudget(1000, async () => { throw new Error('réseau'); }), null);
  assert.equal(await chatBudget(20, () => new Promise(r => setTimeout(() => r({ chatBudget: { remainingPercent: 5 } }), 200))), null);
  assert.equal(budgetText(87.4), '87 %'); assert.equal(budgetText(0.4), '0,4 %'); assert.equal(budgetText(0), '0 %');
});

test('menu avec aperçu (/theme) : onMove à chaque flèche, puis le menu est redessiné avec le nouveau thème ; Échap → null', async () => {
  const ui = await import('../src/ui.js');
  const before = ui.theme.name;
  const { type, tick, tui, sim } = make();
  const names = ['cyan', 'red', 'green'];
  const moves = [];
  let p = tui.select({ title: 'Thème', options: names, defaultIndex: 0, onMove: i => { moves.push(i); ui.theme.name = names[i]; } });
  await tick();
  type(`${ESC}[B`); await tick();
  assert.deepEqual(moves, [1]);
  assert.equal(ui.theme.name, 'red');
  assert.match(sim.screen(), /❯ 2\. red/);
  type(`${ESC}[A`); type(`${ESC}[A`); await tick();                     // remonte : 0 puis boucle sur 2
  assert.deepEqual(moves, [1, 0, 2]);
  type('\r'); assert.equal(await p, 2);
  assert.deepEqual(moves, [1, 0, 2], 'Entrée ne déclenche pas d\'aperçu de plus');
  p = tui.select({ title: 'Thème', options: names, defaultIndex: 0, onMove: i => moves.push(i) });
  type(ESC); assert.equal(await p, null);
  tui.stop();
  ui.theme.name = before;
});

test('menu avec zone d\'aperçu : lignes recalculées à chaque déplacement, dans la largeur', async () => {
  const { sim, type, tick, tui } = make({ cols: 50, rows: 24 });
  const names = ['cyan', 'red', 'green'];
  const p = tui.select({ title: 'Thème', options: names, defaultIndex: 0, preview: i => [`aperçu du thème ${names[i]} ` + 'x'.repeat(80)] });
  await tick();
  assert.match(sim.screen(), /aperçu du thème cyan/);
  type(`${ESC}[B`); await tick();
  assert.match(sim.screen(), /aperçu du thème red/);
  for (const l of sim.lines()) assert.ok(strWidth(l) <= 50, `ligne trop large: ${l}`);
  type('\r'); assert.equal(await p, 1);
  tui.stop();
});
