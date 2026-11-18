// Audit 2 : interface du terminal (saisie longue, rendus regroupés, redimensionnement, en-têtes filtrés, largeurs, Ctrl+O, couleurs hors terminal)
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fakeStreams, TermSim } from './term-sim.js';
import { Tui } from '../src/tui/tui.js';
import { PinnedScreen } from '../src/tui/pinned.js';
import { strWidth, clipAnsi, layoutInput, indexAt } from '../src/tui/layout.js';
import * as ui from '../src/ui.js';

const ESC = '\x1b';
const UI_URL = pathToFileURL(path.resolve(import.meta.dirname, '../src/ui.js')).href;

function make({ cols = 80, rows = 24, history = [] } = {}) {
  const f = fakeStreams(cols, rows);
  let bytes = 0;
  const w = f.stdout.write;
  f.stdout.write = s => { bytes += s.length; f.writesLog.push(s); return w(s); };
  f.writesLog = [];
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, history });
  tui.setStatus({ model: 'Claude Sonnet 5.5', mode: 'auto' });
  tui.start();
  return { ...f, tui, bytes: () => bytes };
}

/** capture ce que ui.js écrit directement sur la sortie standard (sans interface) */
function capture(fn) {
  const real = process.stdout.write;
  let outText = '';
  process.stdout.write = (s) => { outText += String(s); return true; };
  try { fn(); } finally { process.stdout.write = real; }
  return outText;
}

// ── terminal-tui-fleche-haut-message-long ───────────────────────────────────
test('↑ dans un message long qui passe à la ligne monte d\'une ligne au lieu de charger l\'historique', async () => {
  const { tui, type, tick, sim } = make({ cols: 80, history: ['ancien message'] });
  const long = 'x'.repeat(75);
  type(long); await tick();
  assert.match(sim.screen(), /│   x+\s*│/, 'le message s\'affiche bien sur 2 lignes');
  type(`${ESC}[A`); await tick();
  assert.equal(tui.buf, long, '↑ ne remplace pas le texte par l\'historique');
  assert.ok(tui.cur < long.length, 'le curseur est monté sur la 1re ligne');
  type(`${ESC}[B`); await tick();
  assert.equal(tui.buf, long);
  assert.equal(tui.cur, long.length, '↓ redescend en fin de texte');
  type(`${ESC}[A`); type(`${ESC}[A`); await tick();
  assert.equal(tui.buf, 'ancien message', 'depuis la 1re ligne, ↑ ouvre bien l\'historique');
  type(`${ESC}[B`); await tick();
  assert.equal(tui.buf, long, 'le brouillon revient');
  tui.stop();
});

// ── terminal-tui-rendu-a-chaque-ligne ───────────────────────────────────────
test('2000 lignes de sortie en direct : une seule image par tour de boucle, état final affiché', async () => {
  const { tui, tick, sim } = make({ cols: 80, rows: 24 });
  await tick();
  ui.attachSink({ print: t => tui.print(t), spinner: s => tui.spinner(s), setActive: l => tui.setActive(l) });
  try {
    ui.toolHeader('shell', 'npm test');
    await tick();
    const before = sim.writes;
    const live = ui.createLive();
    let chunk = '';
    for (let i = 1; i <= 2000; i++) chunk += `ok ${i} - test\n`;
    for (const l of chunk.split(/(?<=\n)/)) live.push(l);          // une écriture par ligne, comme une commande bavarde
    assert.equal(sim.writes, before, 'aucun rendu synchrone pendant le flux');
    await tick();
    assert.ok(sim.writes - before <= 2, `au plus 2 écritures (${sim.writes - before})`);
    assert.match(sim.screen(), /ok 2000 - test/, 'la dernière ligne est affichée');
    live.end();
    ui.toolDone(true);
    await tick();
    assert.match(sim.screen(), /⏵⏵ auto/);
  } finally { ui.attachSink(null); tui.stop(); }
});

test('le spinner ne réécrit que sa ligne (sans effacer toute la zone), et une frappe s\'affiche tout de suite', async () => {
  const { tui, tick, sim, writesLog, type } = make({ cols: 80, rows: 24 });
  await tick();
  tui.spinner('✻ Réflexion… (1 s)'); await tick();
  writesLog.length = 0;
  tui.spinner('✻ Réflexion… (2 s)'); await tick();
  assert.equal(writesLog.length, 1);
  assert.doesNotMatch(writesLog[0], /\x1b\[J/, 'pas d\'effacement de la zone');
  assert.equal((writesLog[0].match(/\x1b\[2K/g) || []).length, 1, 'une seule ligne réécrite');
  assert.match(writesLog[0], /^\x1b\[\?2026h[\s\S]*\x1b\[\?2026l$/, 'image en affichage synchronisé');
  assert.match(sim.screen(), /Réflexion… \(2 s\)/);
  writesLog.length = 0;
  tui.render(); await tick();
  assert.equal(writesLog.length, 0, 'image identique : rien n\'est écrit');
  const n = sim.writes;
  type('a');                                                       // pas de tick : la frappe est dessinée sans attendre
  assert.ok(sim.writes > n);
  assert.match(sim.screen(), /│ > a\s*│/);
  tui.stop();
});

// ── terminal-tui-redimension-fantome ────────────────────────────────────────
/** terminal qui remet à la ligne son contenu quand la fenêtre rétrécit (Windows Terminal, iTerm2, xterm.js) */
class ReflowSim extends TermSim {
  resize(cols, rows) {
    if (cols >= this.cols) return super.resize(cols, rows);
    const out = [];
    for (const row of this.grid) {
      let end = row.length; while (end > 0 && row[end - 1] === ' ') end--;
      if (!end) { out.push(Array(cols).fill(' ')); continue; }
      for (let k = 0; k < end; k += cols) { const part = row.slice(k, Math.min(end, k + cols)); while (part.length < cols) part.push(' '); out.push(part); }
    }
    while (out.length > rows) this.scrollback.push(out.shift().join('').trimEnd());   // le bas reste en bas : le haut part dans l'historique
    while (out.length < rows) out.push(Array(cols).fill(' '));
    this.grid = out; this.cols = cols; this.rows = rows;
    this.r = Math.min(this.r, rows - 1); this.c = Math.min(this.c, cols - 1);
  }
}
function reflowStreams(cols, rows) {
  const sim = new ReflowSim(cols, rows);
  const stdout = new EventEmitter();
  Object.assign(stdout, { columns: cols, rows, isTTY: true, write: s => { sim.write(s); return true; } });
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
  const tick = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  const resize = (c, r) => { sim.resize(c, r); stdout.columns = c; stdout.rows = r; stdout.emit('resize'); };
  return { sim, stdout, stdin, tick, resize };
}

test('fenêtre rétrécie (terminal qui remet à la ligne) : aucun morceau de l\'ancienne zone ne reste dans la conversation', async () => {
  const { sim, stdout, stdin, tick, resize } = reflowStreams(100, 30);
  const tui = new Tui({ stdin, stdout });
  tui.setStatus({ model: 'Claude Sonnet 5.5', mode: 'auto', cwd: 'C:\\projets\\site' });
  tui.start();
  for (let i = 1; i <= 60; i++) tui.print(`ligne ${i}\n`);
  await tick();
  assert.equal(sim.count(/╭─/g), 1);
  resize(70, 30); await tick();
  assert.equal(sim.count(/╭─/g), 1, 'un seul haut de cadre (pas de fantôme)');
  assert.equal(sim.count(/│ > Essaie/g), 1, 'une seule ligne de saisie');
  assert.equal(sim.count(/Claude Sonnet 5\.5/g), 1, 'une seule ligne du modèle');
  assert.match(sim.lines()[29], /⏵⏵ auto/);
  assert.match(sim.all(), /ligne 60/, 'le dernier texte n\'est pas perdu');
  tui.print('après\n'); await tick();
  assert.match(sim.screen(), /après/);
  tui.stop();
});

// ── terminal-tui-entete-non-filtre ──────────────────────────────────────────
test('en-tête d\'action et note : les séquences de contrôle venant du modèle sont retirées', () => {
  const evil = 'echo ok \x1b]52;c;SGVsbG8=\x07 \x1b]0;titre\x07fin \x1b[2Jx';
  const d = ui.describeAction('shell', evil);
  assert.doesNotMatch(d.detail, /[\x1b\x07]/);
  assert.match(d.detail, /echo ok/);
  const o1 = capture(() => ui.toolHeader('shell', evil));
  assert.doesNotMatch(o1, /\x1b\]|\x07|\x1b\[2J/, 'aucune séquence OSC / effacement dans l\'en-tête');
  assert.match(o1, /echo ok/);
  const o2 = capture(() => ui.toolNote('refusé : \x1b]52;c;QUJD\x07/etc/passwd', 'red'));
  assert.doesNotMatch(o2, /\x1b\]|\x07/);
  assert.match(o2, /\/etc\/passwd/);
});

test('en-tête d\'action : le nom (serveur MCP, outil inconnu) venant du modèle est filtré aussi', async () => {
  const { extractBlocks } = await import('../src/blocks.js');
  // cas 1 : bloc MCP dont le nom de serveur contient une séquence OSC 52 (presse-papiers)
  const blocks = extractBlocks('```mcp ev\x1b]52;c;QUJD\x07il.tool\n{}\n```');
  const b = blocks.find(x => x.mcp);
  assert.ok(b, 'le bloc MCP est reconnu');
  assert.match(b.mcp.server, /\x1b/, 'le nom du serveur garde la séquence (rien ne la filtre avant l\'affichage)');
  const mcpName = `mcp ${b.mcp.server}.${b.mcp.tool}`;            // comme runMcpBlock (agent.js)
  const d1 = ui.describeAction(mcpName, '{}');
  assert.doesNotMatch(d1.label, /[\x1b\x07]/);
  assert.equal(d1.tag, 'MCP');
  const o1 = capture(() => ui.toolHeader(mcpName, '{}'));
  assert.doesNotMatch(o1, /\x1b\]|\x07/, 'aucune séquence OSC dans l\'en-tête MCP');
  assert.match(o1, /tool/);
  // cas 2 : outil inconnu, le nom est affiché tel quel → filtré
  const d2 = ui.describeAction('x\x1b]0;titre\x07y\x1b[2J\nz', '(outil inconnu)');
  assert.doesNotMatch(d2.label, /[\x1b\x07\n]/);
  const o2 = capture(() => ui.toolHeader('x\x1b]0;titre\x07y\x1b[2J', '(outil inconnu)'));
  assert.doesNotMatch(o2, /\x1b\]|\x07|\x1b\[2J/, 'aucune séquence dans l\'en-tête d\'un outil inconnu');
  assert.match(o2, /xy/);
  // noms légitimes inchangés
  assert.deepEqual(ui.describeAction('read_file', 'a.js'), { tag: '', label: 'Read', detail: 'a.js' });
  assert.equal(ui.describeAction('mcp github.search', 'q').label, 'github · search');
});

// ── terminal-tui-largeur-emoji-tab ──────────────────────────────────────────
test('largeur : emojis du plan de base sur 2 colonnes, ⚠️ (U+FE0F) = 2, tabulation jusqu\'au taquet de 8', () => {
  for (const e of ['✅', '❌', '⚡', '⭐', '✨', '⏳', '❗', '⌛', '☕']) assert.equal(strWidth(e), 2, `${e} = 2 colonnes`);
  assert.equal(strWidth('⚠️'), 2, '⚠️ = 2');
  assert.equal(strWidth('⚠'), 1, '⚠ seul reste à 1');
  assert.equal(strWidth('✔ ✓ → é'), 7, 'symboles simples inchangés');
  assert.equal(strWidth('🚀'), 2);
  assert.equal(strWidth('a\tb'), 9);
  assert.equal(strWidth('\t'), 8);
  assert.equal(strWidth('abcdefgh\tx'), 17);
  assert.equal(strWidth(clipAnsi('✅'.repeat(10), 9)), 9, 'coupe en tenant compte des 2 colonnes');
  // saisie avec tabulation : affichée en espaces, curseur et ↑↓ cohérents
  const lay = layoutInput('a\tb', 3, 40);
  assert.equal(lay.lines[0], 'a       b');
  assert.equal(lay.caret.col, 9);
  assert.equal(indexAt(lay, 0, 8), 2);
  assert.equal(indexAt(lay, 0, 4), 1, 'au milieu de la tabulation : le curseur reste devant');
});

test('suivi de la position d\'écriture : ligne de ✅ qui passe à la ligne, tabulations', () => {
  const p = new PinnedScreen({ out: { write() {} }, compose: () => ({ lines: [], caret: { row: 0, col: 0 } }) });
  p.R = 24; p.C = 80; p.cr = 1; p.cc = 0;
  const line = 'Résultat ' + '✅ '.repeat(24) + 'fin';             // 9 + 72 + 3 = 84 colonnes réelles
  assert.equal(strWidth(line), 84);
  p.advance(line + '\r\n');
  assert.equal(p.cr, 3, 'la ligne de 84 colonnes occupe 2 lignes : on écrit la suite en 3e ligne');
  p.cr = 1; p.cc = 0;
  p.advance('ab\tc');
  assert.equal(p.cc, 9);
  p.cc = 78; p.advance('\t');
  assert.equal(p.cc, 79, 'une tabulation ne passe jamais à la ligne');
  assert.equal(p.cr, 1);
  p.cc = 0; p.advance('⚠️x');
  assert.equal(p.cc, 3);
});

test('collage avec tabulation : le bord droit du cadre reste aligné', async () => {
  const { tui, type, tick, sim } = make({ cols: 60, rows: 20 });
  type(`${ESC}[200~a\tb${ESC}[201~`); await tick();
  const row = sim.lines().find(l => l.startsWith('│ > a'));
  assert.ok(row, 'ligne de saisie trouvée');
  assert.match(row, /^│ > a {7}b +│$/);
  assert.equal(row.length, 59, 'même largeur que le cadre');
  assert.equal(tui.buf, 'a\tb', 'le texte envoyé garde sa tabulation');
  tui.stop();
});

// ── terminal-tui-ctrl-o-pensee-coupee ───────────────────────────────────────
test('Ctrl+O : la pensée est affichée en entier (retour à la ligne, rien de coupé)', () => {
  const para = Array.from({ length: 40 }, (_, i) => `mot${i}`).join(' ') + ' ' + 'https://exemple.fr/' + 'x'.repeat(150) + ' charge les fichiers à la fin.';
  ui.resetThinking();
  ui.rememberThinking('Premier paragraphe court.\n' + para);
  const o = ui.stripAnsi(capture(() => ui.showExpanded()));
  assert.doesNotMatch(o, /…charge|… *$/m, 'pas de « … » de coupure');
  const lines = o.split('\n');
  const W = ui.cols() - 4;
  for (const l of lines) assert.ok(l.length <= W + 2, `ligne trop longue (${l.length}) : ${l}`);
  const joined = lines.map(l => l.replace(/^ {2}/, '')).join('');
  assert.ok(joined.replace(/ /g, '').includes(para.replace(/ /g, '')), 'tout le paragraphe est présent');
  assert.match(o, /charge les fichiers à la fin\./);
  assert.equal(ui.wrapText('', 20).length, 1);
  assert.deepEqual(ui.wrapText('aa bb cc dd ee', 10), ['aa bb cc', 'dd ee']);
});

// ── terminal-tui-sortie-p-couleurs ──────────────────────────────────────────
function child(code, { env = {}, args = [] } = {}) {
  const e = { ...process.env, ...env };
  for (const k of ['FORCE_COLOR', 'NO_COLOR']) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { env: e, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const PRINT = `const u = await import(${JSON.stringify(UI_URL)}); u.println(u.c.bold('Résultat') + ' ' + u.c.accent('index.html')); const m = new u.MdStream(); m.push('# Titre\\n**gras** et \`code\`\\n'); m.finish();`;

test('fs -p … > fichier : pas de codes couleur quand la sortie n\'est pas un terminal', () => {
  const o = child(PRINT);
  assert.doesNotMatch(o, /\x1b/, 'aucun code ANSI');
  assert.match(o, /Résultat index\.html/);
  assert.match(o, /Titre/); assert.match(o, /gras et/);
});

test('FORCE_COLOR impose les couleurs ; FORCE_COLOR=0 ne les impose pas', () => {
  assert.match(child(PRINT, { env: { FORCE_COLOR: '1' } }), /\x1b\[1m/);
  assert.doesNotMatch(child(PRINT, { env: { FORCE_COLOR: '0' } }), /\x1b/);
});

test('panneau de l\'éditeur (--stdio, sortie par sink) : sortie inchangée', () => {
  const viaSink = `const u = await import(${JSON.stringify(UI_URL)}); u.attachSink({ print: s => process.stdout.write(s), spinner() {} }); u.println(u.c.bold('x'));`;
  assert.match(child(viaSink), /\x1b\[1mx\x1b\[22m/, 'le sink reçoit le texte coloré comme avant');
  assert.match(child(PRINT, { args: ['--', '--stdio'] }), /\x1b\[1m/, 'avec --stdio, rien n\'est retiré');
});
