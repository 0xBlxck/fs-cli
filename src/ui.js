import fs from 'node:fs';
// UI : couleurs, spinner, rendu markdown en streaming, blocs d'outils
import process from 'node:process';
import { parseFenceInfo } from './fence.js';
import { replaceMath, latexToText, mathBlockStart } from './latex.js';
import { wrapAnsi, strWidth as visWidth } from './tui/layout.js';

export const THEMES = {
  cyan: [86, 212, 221], green: [120, 220, 140], magenta: [210, 130, 230], yellow: [240, 200, 90],
  orange: [255, 150, 80], blue: [110, 160, 255], red: [240, 100, 100], white: [235, 235, 235],
  amber: [255, 176, 0], matrix: [0, 230, 80], cyberpunk: [255, 60, 200], dracula: [189, 147, 249],
};
export const theme = { name: 'cyan' };
/** Touche « coller une image » : Ctrl+V sur Mac (Option+V y tape √ ou ◊), Alt+V ailleurs. */
export const PASTE_IMAGE_KEY = process.platform === 'darwin' ? 'ctrl+v' : 'alt+v';

// Profondeur de couleur choisie une fois : Terminal.app (macOS ≤ 15) ne comprend pas le 24 bits (38;2;R;G;B) → 256 couleurs.
// getColorDepth respecte FORCE_COLOR / COLORTERM ; hors terminal (panneau, tubes) on garde le 24 bits.
export const COLOR_DEPTH = process.stdout.isTTY && process.stdout.getColorDepth ? process.stdout.getColorDepth() : 24;
const q6 = v => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
const LV = [0, 95, 135, 175, 215, 255];
/** RGB → index de la palette 256 couleurs (cube 6×6×6 ou rampe de gris : le plus proche). */
export function rgb256([r, g, b]) {
  const ci = [q6(r), q6(g), q6(b)];
  const cd = (LV[ci[0]] - r) ** 2 + (LV[ci[1]] - g) ** 2 + (LV[ci[2]] - b) ** 2;
  const gi = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10))), gv = 8 + 10 * gi;
  const gd = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return gd < cd ? 232 + gi : 16 + 36 * ci[0] + 6 * ci[1] + ci[2];
}
/** Séquence SGR de couleur : k = 38 (texte) ou 48 (fond) ; 24 bits si le terminal le gère, sinon 256 couleurs. */
export const sgr = (k, [r, g, b], depth = COLOR_DEPTH) => (depth >= 24 ? `\x1b[${k};2;${r};${g};${b}m` : `\x1b[${k};5;${rgb256([r, g, b])}m`);
const fg = rgb => sgr(38, rgb), bg = rgb => sgr(48, rgb);
const col = (rgb) => (s) => `${fg(rgb)}${s}\x1b[39m`;
const GRAY = [128, 134, 146];

export const c = {
  bold: s => `\x1b[1m${s}\x1b[22m`,
  italic: s => `\x1b[3m${s}\x1b[23m`,
  underline: s => `\x1b[4m${s}\x1b[24m`,
  dim: col(GRAY),
  gray: col(GRAY),
  red: col([240, 105, 105]),
  green: col([125, 215, 140]),
  yellow: col([240, 200, 100]),
  blue: col([115, 165, 255]),
  magenta: col([205, 135, 235]),
  orange: col([255, 160, 90]),
  white: col([236, 238, 242]),
  accent: s => `${fg(THEMES[theme.name] || THEMES.cyan)}${s}\x1b[39m`,
};

export const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
export const cols = () => Math.max(40, process.stdout.columns || 100);
export const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);
const TTY = !!process.stdout.isTTY;
// couleurs seulement vers un terminal (fs -p … > fichier, | autre outil : texte brut) ; FORCE_COLOR les impose, NO_COLOR les retire
const FORCE = process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '' && process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== 'false';
export const COLOR = FORCE || (TTY && !process.env.NO_COLOR) || process.argv.includes('--stdio');   // panneau de l'éditeur : sortie inchangée

process.on('exit', () => { if (TTY) process.stdout.write('\x1b[?25h'); });

// ── Sortie : toute écriture passe ici, le spinner s'efface toujours avant ──────
// Avec l'interface plein écran (sink), le texte et le spinner passent par la zone d'affichage : le spinner reste visible pendant le flux.
let sink = null;
export function attachSink(s) { sink = s; }
export const currentSink = () => sink;                               // /team en parallèle : l'affichage normal est mis de côté pendant que les agents travaillent
/** Événement structuré pour le panneau VS Code (équipe d'agents…) : sans effet dans le terminal. */
export function emit(type, data = {}) { if (sink?.event) try { sink.event(type, data); } catch {} }
export const hasEvents = () => !!sink?.event;

/** Une ligne de tâche (symboles en texte, jamais en émoji) : ☐ à faire · ◐ en cours (gras) · ☒ fait (barré, grisé). */
export function taskLine(state, text) {
  if (state === 'done') return `${c.green('☒')} ${c.dim(`\x1b[9m${text}\x1b[29m`)}`;
  if (state === 'doing') return `${c.yellow('◐')} ${c.bold(text)}`;
  return `${c.dim('☐')} ${text}`;
}
/** Durée lisible : « 6,8 s », « 3 min 26 s ». */
export function duration(secs) {
  if (secs < 60) return `${secs.toFixed(1).replace('.', ',')} s`;
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return `${m} min${s ? ` ${s} s` : ''}`;
}

/** Liste de tâches courante (la dernière écrite par le modèle) : affichée en panneau épinglé au-dessus de la saisie. */
export const tasks = {
  list: [], listeners: [], blocks: 0,                                   // blocks : nombre de listes écrites pendant la demande en cours
  set(list) { this.list = list; for (const fn of this.listeners) try { fn(list); } catch {} },
  clear() { this.blocks = 0; this.set([]); },
  on(fn) { this.listeners.push(fn); },
};

/** Retire d'un texte venant du modèle ou d'une commande toute séquence de contrôle du terminal (OSC : titre de fenêtre / liens / presse-papiers,
 *  CSI, DCS/APC, touches C1…) : le texte non fiable ne doit jamais piloter le terminal. Garde \n, \r et \t. */
export function sanitize(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]?/g, '')
    .replace(/\x1b[\s\S]?/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
/**
 * Écriture directe dans la sortie standard (hors interface plein écran). Sous « node --test », la sortie standard d'un fichier de
 * test porte les messages du lanceur : l'affichage du CLI (\r, codes couleur) les cassait parfois (« Unable to deserialize cloned
 * data », vu en CI). Il est donc ignoré dans ce cas — sauf si un test a remplacé process.stdout.write pour le lire.
 */
const IN_TEST_FILE = !!process.env.NODE_TEST_CONTEXT && /\.test\.m?js$/i.test(process.argv[1] || '');   // pas un « fs -p » lancé par un test
export function rawOut(s) {
  if (IN_TEST_FILE && !Object.hasOwn(process.stdout, 'write')) return true;
  return process.stdout.write(s);
}
export function out(s) {
  if (sink) {
    if (cell && !committing) commitAction();                         // autre texte (réponse du modèle…) : l'action en cours passe d'abord dans l'historique
    sink.print(s); return;
  }
  spinner.stop(); rawOut(COLOR ? s : stripAnsi(s));                  // sans terminal ni interface (panneau --stdio = sink) : pas de codes couleur
}
export function println(s = '') { out(s + '\n'); }

// ── Spinner ────────────────────────────────────────────────────────────────────
// symbole qui « respire » et verbe qui change à chaque attente (comme Claude Code), en français
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = ['Réflexion', 'Cogitation', 'Élaboration', 'Gamberge', 'Peaufinage', 'Fignolage', 'Mijotage', 'Bricolage', 'Conception', 'Méditation', 'Ruminage', 'Déduction', 'Orchestration', 'Tricotage', 'Distillation'];
let sp = null;
// tokens reçus en direct pendant la demande en cours (comme « ↓ 77 tokens » de Claude Code) : estimés d'après le texte reçu
// (réponse, réflexion, arguments des outils) ; le compte exact de France Student s'affiche à la fin (« ✻ Terminé … ↓ tok »).
let liveChars = 0, liveT0 = 0;                                       // liveT0 : début de la demande (la durée ne repart pas à 0 à chaque requête)
export const liveTokens = {
  reset() { liveChars = 0; liveT0 = Date.now(); },
  end() { liveChars = 0; liveT0 = 0; },
  add(text) { if (liveT0) liveChars += String(text || '').length; },
  get count() { return Math.round(liveChars / 3.5); },
};
const fmtTok = n => (n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n));
function draw() {
  if (!sp) return;
  const s = Math.floor((Date.now() - (liveT0 || sp.t0)) / 1000);
  const dur = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  const frame = FRAMES[Math.floor(sp.i++ / 1.5) % FRAMES.length];
  const tok = liveTokens.count;
  const text = `${c.accent(frame)} ${c.accent(sp.label)} ${c.dim(`(${dur}${tok ? ` · ↓ ${fmtTok(tok)} tokens` : ''} · échap pour interrompre)`)}`;
  if (sink) sink.spinner(text);
  else rawOut(`\r\x1b[K  ${text}`);
}
export const spinner = {
  start(label = 'réflexion…') {
    if (!TTY && !sink) return;
    this.stop();
    if (sink?.event) { if (/^réflexion…?$/i.test(label)) label = VERBS[Math.floor(Math.random() * VERBS.length)] + '…'; sp = { label, t0: Date.now(), timer: null }; sink.event('spinner', { label }); return; }   // panneau VS Code : il anime lui-même
    if (/^réflexion…?$/i.test(label)) label = VERBS[Math.floor(Math.random() * VERBS.length)] + '…';   // attente générique : verbe au hasard
    sp = { label, t0: Date.now(), i: 0, timer: null };
    if (!sink) rawOut('\x1b[?25l');
    draw();
    sp.timer = setInterval(draw, 90);
  },
  label(l) { if (sp) { sp.label = l; sink?.event?.('spinner', { label: l }); } },
  /** activité en direct : met à jour l'étiquette, ou relance l'indicateur s'il a été arrêté par du texte (le modèle écrit encore) */
  show(l) { if (sp) this.label(l); else this.start(l); },
  stop() {
    if (!sp) return;
    clearInterval(sp.timer); sp = null;
    if (sink?.event) { sink.event('spinner', { label: null }); return; }
    if (sink) sink.spinner(null);
    else rawOut('\r\x1b[K\x1b[?25h');
  },
  get active() { return !!sp; },
};

// ── Coloration syntaxique générique ───────────────────────────────────────────
const KW = new Set(('function const let var return if else elif for while class def import from export default async await try catch except finally throw raise new in of is not and or ' +
  'None null undefined true false True False self this fn pub use struct impl match type interface enum public private static void int string echo fi then do done foreach param switch case break continue with as lambda yield pass package func go defer ' +
  'Write-Host Get-ChildItem Set-Location SELECT FROM WHERE INSERT UPDATE DELETE CREATE TABLE').split(/\s+/));
const TOKEN_RE = /(\/\/.*$|#.*$|--\s.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][\w-]*\b)/g;
export function highlight(line) {
  let res = '', last = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    res += line.slice(last, m.index);
    if (m[1]) res += c.dim(m[1]);
    else if (m[2]) res += c.green(m[2]);
    else if (m[3]) res += c.orange(m[3]);
    else if (m[4]) res += KW.has(m[4]) ? c.magenta(m[4]) : m[4];
    last = m.index + m[0].length;
    if (m[0].length === 0) TOKEN_RE.lastIndex++;
  }
  return res + line.slice(last);
}

// ── Markdown inline ───────────────────────────────────────────────────────────
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, t) => { codes.push(t); return `\u0000${codes.length - 1}\u0000`; });
  // liens AVANT le gras : sinon le « [ » des codes couleur (ESC[1m) est pris pour le début d'un lien et casse le texte
  // formules LaTeX (\( … \), $ … $) → texte Unicode, mises de côté pour que * et _ ne soient pas pris pour de l'italique
  const maths = [];
  s = replaceMath(s, t => { maths.push(t); return `\u0002${maths.length - 1}\u0002`; });
  const links = [];
  s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => { links.push([t, u]); return `\u0001${links.length - 1}\u0001`; });
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, (_, t) => c.bold(c.italic(t)));
  s = s.replace(/\*\*(.+?)\*\*/g, (_, t) => c.bold(t));
  s = s.replace(/__(.+?)__/g, (_, t) => c.bold(t));
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, (_, p, t) => p + c.italic(t));
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => `${c.underline(links[i][0])} ${c.dim('(' + links[i][1] + ')')}`);
  s = s.replace(/\u0002(\d+)\u0002/g, (_, i) => c.italic(maths[i]));
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `${bg([48, 50, 60])}${fg([240, 205, 150])} ${codes[i]} \x1b[39m\x1b[49m`);
  return s;
}

// ── Rendu markdown en flux (ligne par ligne) ──────────────────────────────────
const parseInfo = info => parseFenceInfo(info);

export class MdStream {
  /** collapse : les blocs de code deviennent une ligne « ▸ langage fichier · N lignes » · onCode : suivi de la rédaction (spinner) */
  constructor({ collapse = false, onCode = null } = {}) {
    this.buf = ''; this.inCode = false; this.lang = ''; this.tick = ''; this.opened = false;
    this.lastBlank = true; this.printed = false;
    this.collapse = collapse; this.onCode = onCode; this.codeLines = 0; this.codeName = '';
  }
  push(t) {
    if (sink?.event) { const d = sanitize(t); if (d) sink.event('text', { delta: d }); return; }   // panneau VS Code : markdown brut, rendu là-bas
    this.buf += sanitize(t);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }
  /** imprime la ligne partielle (avant un spinner d'outil) sans fermer les blocs */
  flushLine() {
    if (this.buf.trim()) { this.line(this.buf.replace(/\r$/, '')); }
    this.buf = '';
  }
  finish() {
    if (sink?.event) { sink.event('textEnd'); return; }
    this.flushLine();
    if (this.tableRows) this.flushTable();
    if (this.inCode) this.closeCode();
    if (this.mathEnd) this.flushMath();
  }
  flushMath() {
    const text = latexToText(this.mathBuf.join('\n'));
    this.mathEnd = null; this.mathBuf = [];
    if (!text) return;
    this.blank();
    for (const l of text.split('\n')) this.emit('    ' + c.italic(l));
    this.blank();
  }
  closeCode() {
    if (this.collapse) {
      if (this.codeLines > 0) {
        this.blank();
        this.flushBlank();
        println(`  ${c.dim('▸')} ${c.accent(this.lang || 'code')}${this.codeName ? ' ' + c.bold(this.codeName) : ''} ${c.dim(`· ${this.codeLines} ligne${this.codeLines > 1 ? 's' : ''}`)}`);
        this.printed = true; this.lastBlank = false;
      }
    } else if (this.opened) { println(c.dim('  ╰─')); this.lastBlank = false; }
    this.inCode = false; this.opened = false; this.codeLines = 0;
  }
  emit(s) {
    if (!this.printed && !this.noLead) println();                     // 1er texte : séparé de l'action ou de la demande au-dessus
    this.flushBlank();
    println(s); this.printed = true; this.lastBlank = false;
  }
  /**
   * Texte passé à la ligne à la largeur du terminal, comme Claude Code : first = préfixe de la 1re ligne, rest = des suivantes
   * (même largeur visible). Le 1er paragraphe d'une réponse commence par « ● ».
   */
  emitWrapped(first, rest, text, { bullet = false } = {}) {
    if (bullet && !this.printed) first = '● ' + first.slice(2);
    const lines = wrapAnsi(text, Math.max(20, cols() - 1 - visWidth(first)));
    lines.forEach((l, i) => this.emit((i ? rest : first) + l));
  }
  /** ligne vide DIFFÉRÉE : écrite seulement si du texte suit (une ligne vide en fin de réponse doublait celle de l'action suivante) */
  blank() { if (!this.lastBlank && this.printed) { this.pendingBlank = true; this.lastBlank = true; } }
  flushBlank() { if (this.pendingBlank) { println(); this.pendingBlank = false; } }
  line(line) {
    if (this.inCode) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === this.tick[0]) { this.closeCode(); return; }
      if (this.collapse) {                           // on ne montre pas le code : compteur + spinner seulement
        if (line.trim() === '' && this.codeLines === 0) return;
        this.codeLines++;
        this.onCode?.({ lang: this.lang, name: this.codeName, lines: this.codeLines });
        return;
      }
      if (!this.opened) {
        if (line.trim() === '') return;
        this.blank();
        this.flushBlank();
        println(c.dim('  ╭─ ') + c.accent(this.lang || 'code'));
        this.opened = true; this.printed = true;
      }
      println(c.dim('  │ ') + highlight(line));
      this.lastBlank = false;
      return;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
    if (open) {
      const { lang, name } = parseInfo(open[2]);
      this.inCode = true; this.tick = open[1]; this.lang = lang; this.codeName = name; this.opened = false; this.codeLines = 0;
      return;
    }
    // formule LaTeX sur plusieurs lignes (\[ … \] ou $$ … $$) : rassemblée, puis écrite convertie en texte Unicode
    if (this.mathEnd) {
      const k = line.indexOf(this.mathEnd);
      if (k < 0) { this.mathBuf.push(line); return; }
      this.mathBuf.push(line.slice(0, k)); this.flushMath();
      if (line.slice(k + 2).trim()) this.line(line.slice(k + 2));
      return;
    }
    { const end = mathBlockStart(line); if (end) { this.mathEnd = end; this.mathBuf = [line.trim().slice(2)]; return; } }

    // tableau : on accumule les lignes, il est affiché d'un bloc (colonnes alignées) à la première ligne qui n'en fait pas partie
    if (/^\s*\|.*\|\s*$/.test(line)) {
      this.tableRows ||= [];
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { if (this.tableRows.length === 1) this.tableRows[0].header = true; return; }
      this.tableRows.push({ cells: line.trim().replace(/^\||\|$/g, '').split('|') });
      return;
    }
    if (this.tableRows) this.flushTable();
    if (line.trim() === '') { this.blank(); return; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      this.blank();
      const t = inline(m[2]);
      this.emitWrapped('  ', '  ', m[1].length === 1 ? c.bold(c.accent(t)) : m[1].length === 2 ? c.bold(c.white(t)) : c.bold(c.yellow(t)), { bullet: true });
      return;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { this.emit('  ' + c.dim('─'.repeat(Math.min(48, cols() - 6)))); return; }
    if ((m = line.match(/^(\s*)[-*+]\s+\[( |x|X|~|>|-)\]\s+(.*)$/))) {   // liste de tâches du modèle : ☐ à faire · ◐ en cours · ☑ fait
      const st = m[2] === ' ' ? 'todo' : /[xX]/.test(m[2]) ? 'done' : 'doing';
      if (!this.inTasks) { this.inTasks = true; this.taskList = []; tasks.blocks++; }
      // seule la 1re liste de la demande s'écrit dans le fil ; les mises à jour suivantes ne changent que le panneau épinglé
      if (tasks.blocks <= 1) this.emit(`  ${m[1]}${taskLine(st, inline(m[3]))}`);
      this.taskList.push({ text: m[3].replace(/[*_`]/g, '').trim(), state: st });
      tasks.set(this.taskList.slice());
      return;
    }
    this.inTasks = false;
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {                 // suite d'un élément alignée sous son texte
      const pad = '  ' + m[1];
      this.emitWrapped(`${pad}${c.accent('•')} `, `${pad}  `, inline(m[2])); return;
    }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
      const pad = '  ' + m[1], num = m[2] + '.';
      this.emitWrapped(`${pad}${c.accent(num)} `, pad + ' '.repeat(num.length + 1), inline(m[3])); return;
    }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { this.emitWrapped(`  ${c.dim('▎')} `, `  ${c.dim('▎')} `, c.italic(inline(m[1]))); return; }
    this.emitWrapped('  ', '  ', inline(line), { bullet: true });
  }

  /** Tableau Markdown regroupé puis affiché avec colonnes alignées et cadre (en-tête en gras). */
  flushTable() {
    const rows = this.tableRows; this.tableRows = null;
    if (!rows?.length) return;
    const vis = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
    const cells = rows.map(r => r.cells.map(x => inline(x.trim())));
    const n = Math.max(...cells.map(r => r.length));
    let w = Array.from({ length: n }, (_, i) => Math.max(1, ...cells.map(r => vis(r[i] || ''))));
    const max = Math.max(20, cols() - 6 - (n * 3 + 1));
    while (w.reduce((a, b) => a + b, 0) > max) { const i = w.indexOf(Math.max(...w)); if (w[i] <= 6) break; w[i]--; }   // trop large : on réduit la plus large
    const fit = (s, width) => {
      const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
      if (plain.length <= width) return s + ' '.repeat(width - plain.length);
      return plain.slice(0, width - 1) + '…';
    };
    const line = (l, m, r) => c.dim(l + w.map(x => '─'.repeat(x + 2)).join(m) + r);
    this.blank();
    this.emit('  ' + line('┌', '┬', '┐'));
    cells.forEach((r, k) => {
      const head = k === 0 && rows[0].header;
      const HB = s => `${bg([44, 47, 58])}${s}\x1b[49m`;                // en-tête sur fond grisé
      this.emit('  ' + c.dim('│') + w.map((x, i) => head ? HB(' ' + c.bold(fit(r[i] || '', x)) + ' ') : ' ' + fit(r[i] || '', x) + ' ').join(c.dim('│')) + c.dim('│'));
      if (head && cells.length > 1) this.emit('  ' + line('├', '┼', '┤'));
    });
    this.emit('  ' + line('└', '┴', '┘'));
  }
}

// ── Blocs d'outils ────────────────────────────────────────────────────────────
// Présentation des actions comme Claude Code : « ● Read(index.html) », « ● Update(style.css) », « ● PowerShell(npm test) » (mêmes noms que le panneau)
const SHELL_NAME = process.platform === 'win32' ? 'PowerShell' : 'Bash';
const ACTIONS = {
  shell: ['', SHELL_NAME], python: ['', 'Python'], read_file: ['', 'Read'], write_file: ['', 'Write'], edit_file: ['', 'Update'],
  list_dir: ['', 'List'], grep: ['', 'Search'], glob: ['', 'Search'], fetch_url: ['', 'Fetch'], web_search: ['', 'Web Search'],
};
/** Décode une commande fs-mcp (node "…mcp-cli.js" call srv outil args) pour l'afficher lisiblement. */
export function describeAction(name, summary = '') {
  name = sanitize(String(name || '')).replace(/[\r\n\t]+/g, ' ');   // le nom aussi vient du modèle (serveur MCP, outil inconnu) : il finit dans l'en-tête
  const s = sanitize(String(summary || '')).replace(/\s+/g, ' ').trim();   // texte du modèle : aucune séquence de contrôle ne doit atteindre le terminal
  if (name === 'shell') {
    const m = s.match(/(?:mcp-cli\.js"?|fs-mcp)\s+(call|tools|list|skills?)\s*(.*)$/i);
    if (m) {
      const [, verb, rest] = m;
      if (verb.toLowerCase() === 'call') { const [srv, tool, ...args] = rest.split(' '); return { tag: 'MCP', label: `${srv} · ${tool || ''}`, detail: args.join(' ') }; }
      if (verb.toLowerCase() === 'tools') return { tag: 'MCP', label: `${rest.split(' ')[0]} · outils`, detail: '' };
      if (verb.toLowerCase() === 'list') return { tag: 'MCP', label: 'serveurs disponibles', detail: '' };
      return { tag: 'MCP', label: 'skills', detail: rest };
    }
  }
  const m = name.match(/^mcp (\S+)\.(\S+)$/);
  if (m) return { tag: 'MCP', label: `${m[1]} · ${m[2]}`, detail: s };
  const a = ACTIONS[name];
  return a ? { tag: a[0], label: a[1], detail: s } : { tag: '', label: name, detail: s };
}
const stripLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const EXPLORE = new Set(['read_file', 'list_dir', 'grep', 'glob']);

// ── Ctrl+O : déplier les sorties résumées et la pensée du modèle (comme Claude Code) ──
const expandable = [];                                               // [{ title, lines }] : contenus coupés à l'écran, gardés en entier
let thinking = '';
function remember(title, lines) { expandable.push({ title, lines }); if (expandable.length > 20) expandable.shift(); }
export function rememberThinking(d) { if (sink?.event && d) sink.event('thinking', { delta: sanitize(d) }); thinking += d; if (thinking.length > 200_000) thinking = thinking.slice(-200_000); }
export function resetThinking() { thinking = ''; }
export const thinkingLength = () => thinking.trim().length;
/** Découpe une ligne en morceaux de `width` caractères au plus, de préférence sur un espace (rien n'est perdu). */
export function wrapText(s, width) {
  width = Math.max(10, width);
  const parts = [];
  let rest = String(s ?? '');
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width / 2) {                                             // mot très long (URL…) : coupé net, jamais au milieu d'un emoji
      cut = width;
      const hi = rest.charCodeAt(cut - 1);
      if (hi >= 0xd800 && hi <= 0xdbff) cut--;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^ /, '');
  }
  parts.push(rest);
  return parts;
}
/** Affiche en entier ce qui a été résumé depuis le dernier Ctrl+O (et la pensée du modèle). */
export function showExpanded() {
  const items = expandable.splice(0);
  if (thinking.trim()) items.unshift({ title: 'pensée du modèle', lines: thinking.trim().split('\n') });
  thinking = '';
  if (!items.length) return println(c.dim('  (rien de replié à afficher)'));
  for (const it of items) {
    println(c.dim(`\n  ── ${it.title} (${it.lines.length} ligne${it.lines.length > 1 ? 's' : ''}) ──`));
    for (const l of it.lines.slice(0, 2000)) for (const part of wrapText(sanitize(l).replace(/\t/g, '  '), cols() - 4)) println(c.dim('  ') + part);   // en entier : retour à la ligne, jamais coupé
    if (it.lines.length > 2000) println(c.dim(`  … +${it.lines.length - 2000} lignes`));
  }
  println(c.dim('  ──'));
}

// ── Action en cours (inspiré de Codex) ─────────────────────────────────────────
// Avec l'interface plein écran, l'action en cours est affichée dans la zone du bas (avec sa sortie en direct),
// puis écrite dans l'historique UNE FOIS TERMINÉE, puce verte (réussie) ou rouge (échec).
// Les lectures / recherches successives sont regroupées en un seul bloc « Exploré ».
let cell = null, committing = false, lastExplore = false;
function headLine(bullet, tag, label, detail) {                      // « ● Read(index.html) » ; MCP : « ● serveur · outil (MCP)(args) »
  const head = c.bold(label) + (tag === 'MCP' ? c.dim(' (MCP)') : '');
  return `  ${bullet} ${head}${detail ? '(' + clip(detail, Math.max(10, cols() - stripLen(head) - 8)) + ')' : ''}`;
}
/** « Lu 2 fichiers, cherché 1 motif » : résumé d'une suite de lectures / recherches (comme Claude Code) */
function exploreSummary(items, done) {
  const n = k => items.filter(i => i.kind === k).length;
  const pl = (x, a, b) => `${x} ${x > 1 ? b : a}`;
  const parts = [];
  if (n('read')) parts.push(`${done ? 'lu' : 'lecture de'} ${pl(n('read'), 'fichier', 'fichiers')}`);
  if (n('search')) parts.push(`${done ? 'cherché' : 'recherche de'} ${pl(n('search'), 'motif', 'motifs')}`);
  if (n('list')) parts.push(`${done ? 'listé' : 'liste de'} ${pl(n('list'), 'dossier', 'dossiers')}`);
  const t = parts.join(', ') || (done ? 'exploré' : 'exploration');
  return t[0].toUpperCase() + t.slice(1);
}
const exploreKind = name => (name === 'read_file' ? 'read' : name === 'list_dir' ? 'list' : 'search');
function cellLines(final) {
  if (!cell) return [];
  if (cell.kind === 'explore') {                                      // une ligne, comme Claude Code ; le détail reste dispo avec ctrl+o
    const errs = cell.items.filter(i => i.err);
    const bullet = final ? (errs.length ? c.red('●') : c.green('●')) : c.dim('◦');
    const last = cell.items[cell.items.length - 1];
    if (!final) return [`  ${bullet} ${c.bold(exploreSummary(cell.items, false) + '…')}${last?.detail ? '  ' + c.dim(clip(last.detail, cols() - 40)) : ''}`];
    remember('exploration', cell.items.map(i => `${i.label}(${i.detail || ''})${i.err ? '  ✗ échec' : ''}`));
    const failed = errs.length ? c.red(` · ${errs.length} échec${errs.length > 1 ? 's' : ''} : ${clip(errs.map(i => i.detail).join(', '), 40)}`) : '';
    return [`  ${bullet} ${c.bold(exploreSummary(cell.items, true))}${failed} ${c.dim('(ctrl+o pour voir)')}`];
  }
  const bullet = final ? (cell.ok === false ? c.red('●') : c.green('●')) : c.dim('◦');
  const out = [headLine(bullet, cell.tag, cell.label, cell.detail)];
  const live = cell.live;
  if (live.length) {
    const show = final ? (live.length > 8 ? [...live.slice(0, 5), null, ...live.slice(-2)] : live) : live.slice(-4);
    if (final && live.length > 8) remember(`${cell.label} ${cell.detail || ''}`.trim(), live.slice());
    show.forEach((l, i) => out.push(l === null ? `     ${c.dim(`… +${live.length - 7} lignes (ctrl+o pour tout voir)`)}` : `  ${i === 0 ? c.dim('⎿') : ' '}  ${(cell.ok === false && final ? c.red : c.dim)(clip(l, cols() - 6))}`));
  }
  return out;
}
function showActive() { sink?.setActive?.(cell ? cellLines(false) : []); }
/** Écrit l'action en cours dans l'historique (avec sa couleur finale) et vide la zone du bas. */
export function commitAction() {
  if (!cell || committing) return;
  committing = true;
  const lines = cellLines(true);
  cell = null;
  sink?.setActive?.([]);
  try { out('\n' + lines.join('\n') + '\n'); } finally { committing = false; }
}

export function toolHeader(name, summary = '') {
  const { tag, label, detail } = describeAction(name, summary);
  if (sink?.event) { lastExplore = EXPLORE.has(name); sink.event('tool', { name: sanitize(String(name || '')), tag, label, detail: sanitize(detail), raw: sanitize(String(summary || '')).slice(0, 8000), explore: lastExplore }); return; }
  if (!sink) { println(); println(headLine(c.green('●'), tag, label, detail)); return; }     // sans interface plein écran : direct
  const explore = EXPLORE.has(name);
  if (explore && cell?.kind === 'explore') { cell.items.push({ kind: exploreKind(name), label, detail }); showActive(); return; }
  commitAction();
  cell = explore ? { kind: 'explore', items: [{ kind: exploreKind(name), label, detail }] } : { kind: 'action', tag, label, detail, live: [], ok: undefined };
  showActive();
}

/** Fin d'exécution de l'action en cours : couleur de la puce. Renvoie false si son résultat doit rester masqué (exploration réussie). */
export function toolDone(ok) {
  if (sink?.event) { sink.event('toolDone', { ok: !!ok }); return lastExplore ? !ok : true; }
  if (!cell) return true;
  if (cell.kind === 'explore') {
    if (!ok) cell.items[cell.items.length - 1].err = true;
    showActive();
    return !ok;                                                      // exploration réussie : rien de plus à afficher (comme Codex)
  }
  cell.ok = !!ok;
  commitAction();
  return true;
}

export function toolBody(text, { max = 8, error = false } = {}) {
  if (sink?.event) { const t = sanitize(text).replace(/\r/g, '').replace(/\n+$/, ''); if (t) sink.event('toolOutput', { text: t.slice(0, 20000), error }); return; }
  const lines = sanitize(text).replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return;
  const paint = error ? c.red : c.dim;
  const shown = lines.slice(0, max);
  shown.forEach((l, i) => println(`  ${i === 0 ? c.dim('⎿') : ' '}  ${paint(clip(l, cols() - 6))}`));
  if (lines.length > max) { remember('sortie', lines); println(`     ${c.dim(`… +${lines.length - max} lignes (ctrl+o pour tout voir)`)}`); }
}

/** image générée : affichée dans le panneau, chemin cliquable dans le terminal */
export const showsImages = () => !!sink?.event;                     // le panneau sait afficher une image, pas le terminal
let imageHook = null;
export const onImage = fn => { imageHook = fn; };                     // serveur MCP : récupère les images générées pendant fs_agent
export function image({ data = null, file = '', mime = 'image/png', prompt = '', name = 'image.png' } = {}) {
  if (imageHook && data) { try { imageHook({ data, mime, prompt, name, file }); } catch {} }
  if (sink?.event && data && data.length < 12_000_000) {
    sink.event('image', { data: data.toString('base64'), mime: /^image\/(png|jpeg|webp|gif)$/.test(mime) ? mime : 'image/png', prompt: sanitize(prompt).slice(0, 400), name: String(name).replace(/[^\w.-]/g, '_') });
    return;
  }
  println(`  ${c.green('🖼')} image enregistrée : ${c.accent(file)}`);
}

export function toolNote(text, kind = 'dim') {
  if (sink?.event) { sink.event('note', { text: stripAnsi(sanitize(text)), kind }); return; }
  println(`  ${c.dim('⎿')}  ${(c[kind] || c.dim)(sanitize(text))}`);   // peut contenir des chemins ou bouts de commande venant du modèle
}

/** affichage en direct de la sortie d'une commande (limité) */
export function createLive(maxLines = 24) {
  let carry = '', shown = 0, hidden = 0;
  const emitLine = (l) => {
    if (sink?.event) { if (shown++ < 400) sink.event('toolLive', { line: l }); else hidden++; return; }
    if (cell && cell.kind === 'action' && sink) {                     // action en cours : sortie dans la zone du bas, résumée à la fin
      cell.live.push(l); if (cell.live.length > 400) cell.live.splice(5, cell.live.length - 400);
      showActive(); shown++; return;
    }
    if (shown < maxLines) {
      println(`  ${shown === 0 ? c.dim('⎿') : ' '}  ${c.dim(clip(l, cols() - 6))}`);
      shown++;
    } else hidden++;
  };
  return {
    push(text) {
      carry += sanitize(text).replace(/\r\n?/g, '\n');
      let i;
      while ((i = carry.indexOf('\n')) >= 0) { emitLine(carry.slice(0, i)); carry = carry.slice(i + 1); }
    },
    end() {
      if (carry) { emitLine(carry); carry = ''; }
      if (hidden) println(`     ${c.dim(`… +${hidden} lignes masquées`)}`);
      return shown + hidden;
    },
  };
}

/**
 * Différences ligne à ligne entre deux textes : [{ t: ' '|'-'|'+', line, o?, n? }] (o / n = numéros de ligne avant / après).
 * Préfixe et suffixe communs retirés, puis plus longue sous-séquence commune sur le milieu (exact, et rapide en pratique).
 */
export function lineDiff(oldStr, newStr) {
  const o = String(oldStr ?? '').replace(/\r\n/g, '\n').split('\n'), n = String(newStr ?? '').replace(/\r\n/g, '\n').split('\n');
  let p = 0; while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0; while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
  const A = o.slice(p, o.length - s), B = n.slice(p, n.length - s);
  const ops = [];
  for (let i = 0; i < p; i++) ops.push({ t: ' ', line: o[i], o: i + 1, n: i + 1 });
  if (A.length * B.length <= 4_000_000) {
    const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { ops.push({ t: ' ', line: A[i], o: p + i + 1, n: p + j + 1 }); i++; j++; }
      else if (i < A.length && (j >= B.length || L[i + 1][j] >= L[i][j + 1])) { ops.push({ t: '-', line: A[i], o: p + i + 1 }); i++; }   // ancienne ligne d'abord
      else { ops.push({ t: '+', line: B[j], n: p + j + 1 }); j++; }
    }
  } else {                                                          // très gros changement : tout l'ancien bloc retiré, tout le nouveau ajouté
    A.forEach((l, k) => ops.push({ t: '-', line: l, o: p + k + 1 }));
    B.forEach((l, k) => ops.push({ t: '+', line: l, n: p + k + 1 }));
  }
  for (let k = 0; k < s; k++) ops.push({ t: ' ', line: o[o.length - s + k], o: o.length - s + k + 1, n: n.length - s + k + 1 });
  return ops;
}

/** Diff coloré façon Claude Code : résumé, numéros de ligne, ajouts sur fond vert, retraits sur fond rouge, 2 lignes de contexte. */
export function diffView(oldStr, newStr, { max = 30, context = 2 } = {}) {
  const ops = lineDiff(oldStr, newStr);
  while (ops.length && ops[ops.length - 1].t === ' ' && ops[ops.length - 1].line === '') ops.pop();   // fin de fichier : pas une ligne
  if (sink?.event) return diffEvent(ops, context);
  const added = ops.filter(x => x.t === '+').length, removed = ops.filter(x => x.t === '-').length;
  const parts = [added && `${added} ajout${added > 1 ? 's' : ''}`, removed && `${removed} suppression${removed > 1 ? 's' : ''}`].filter(Boolean);
  println(`  ${c.dim('⎿')}  ${parts.length ? parts.join(', ') : 'aucun changement'}`);
  // lignes à montrer : chaque changement avec `context` lignes autour ; « ⋮ » entre deux zones éloignées
  const keep = new Set();
  ops.forEach((x, i) => { if (x.t !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep.add(k); });
  const width = String(ops.reduce((m, x) => Math.max(m, x.o || 0, x.n || 0), 0)).length;
  const ADD = s => `${bg([22, 58, 34])}${s}\x1b[49m`, DEL = s => `${bg([72, 26, 30])}${s}\x1b[49m`;
  const W = cols() - 8 - width;
  let shown = 0, last = -2;
  for (let i = 0; i < ops.length; i++) {
    if (!keep.has(i)) continue;
    if (shown >= max) {
      remember('diff complet', ops.filter((_, k) => keep.has(k)).map(x => `${x.t === '-' ? x.o : x.n} ${x.t} ${x.line}`));
      println(`     ${c.dim(`… +${[...keep].filter(k => k >= i).length} lignes (ctrl+o pour tout voir)`)}`); break;
    }
    if (last >= 0 && i > last + 1) println(`     ${c.dim('⋮')}`);
    const x = ops[i], num = String(x.t === '-' ? x.o : x.n).padStart(width);
    const text = clip(sanitize(x.line).replace(/\t/g, '  '), W);
    if (x.t === '+') println(`     ${ADD(`${c.green(num)} ${c.green('+')} ${text}`.padEnd(0))}`);
    else if (x.t === '-') println(`     ${DEL(`${c.red(num)} ${c.red('-')} ${text}`)}`);
    else println(`     ${c.dim(num)}   ${c.dim(text)}`);
    shown++; last = i;
  }
  return { removed, added };
}

/** diff envoyé au panneau VS Code : lignes changées + contexte, « null » entre deux zones éloignées */
function diffEvent(ops, context) {
  const added = ops.filter(x => x.t === '+').length, removed = ops.filter(x => x.t === '-').length;
  const keep = new Set();
  ops.forEach((x, i) => { if (x.t !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep.add(k); });
  const lines = []; let last = -2;
  for (let i = 0; i < ops.length && lines.length < 600; i++) {
    if (!keep.has(i)) continue;
    if (last >= 0 && i > last + 1) lines.push(null);
    const x = ops[i]; lines.push({ t: x.t, n: x.t === '-' ? x.o : x.n, line: sanitize(x.line).slice(0, 400) }); last = i;
  }
  sink.event('diff', { added, removed, lines });
  return { added, removed };
}

// ── Boîte / bannière ──────────────────────────────────────────────────────────
export function box(rows, { title = '', width } = {}) {
  const W = Math.min(width || cols() - 2, 84);
  const inner = W - 4;
  const top = title ? `╭─ ${title} ${'─'.repeat(Math.max(0, W - 5 - stripAnsi(title).length))}╮` : `╭${'─'.repeat(W - 2)}╮`;
  println(c.accent(top));
  for (const r of rows) {
    const vis = stripAnsi(r).length;
    const txt = vis > inner ? clip(stripAnsi(r), inner) : r;
    const pad = ' '.repeat(Math.max(0, inner - stripAnsi(txt).length));
    println(`${c.accent('│')} ${txt}${pad} ${c.accent('│')}`);
  }
  println(c.accent(`╰${'─'.repeat(W - 2)}╯`));
}

/** wrapText (retour à la ligne aux espaces, comme Claude Code) avec maxLines lignes au plus : la dernière finit alors par « … ». */
export function wrapLines(text, width, maxLines = Infinity) {
  const lines = wrapText(String(text ?? '').replace(/\s+/g, ' ').trim(), width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = clip(`${kept[maxLines - 1]} …`, width).replace(/ ?…$/, '…');
  return kept;
}

/**
 * Cadre d'accueil en deux colonnes, comme Claude Code : titre dans la bordure, colonne gauche centrée, séparateur, colonne droite.
 * Lignes = { text, style?, center?, wrap? } : le texte est coupé AVANT d'être coloré (pas de couleur cassée) ;
 * wrap: n → passe à la ligne (n lignes au plus) au lieu de couper avec « … ».
 */
export function splitBox(left, right, { title = '', width, leftWidth = 32 } = {}) {
  const W = Math.min(width || cols() - 2, 118);
  const lw = leftWidth, rw = W - lw - 7;
  // lignes de suite décalées de 2 espaces : on voit où commence chaque élément
  right = right.flatMap(r => (r && r.wrap && !r.rule ? wrapLines(r.text, rw - 2, r.wrap).map((t, i) => ({ ...r, text: i ? `  ${t}` : t })) : [r]));
  const cell = (r, w) => {
    if (!r) return ' '.repeat(w);
    const t = clip(String(r.text ?? ''), w), vis = t.length;
    const pad = w - vis, pl = r.center ? Math.floor(pad / 2) : 0;
    return ' '.repeat(pl) + (r.style ? r.style(t) : t) + ' '.repeat(pad - pl);
  };
  const t = title ? ` ${title} ` : '';
  println(c.accent('╭─') + (t ? c.accent(t) : '') + c.accent('─'.repeat(Math.max(0, W - 3 - t.length)) + '╮'));
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const r = right[i];
    const rightCell = r && r.rule ? c.accent('─'.repeat(rw)) : cell(r, rw);
    println(`${c.accent('│')} ${cell(left[i], lw)} ${c.accent('│')} ${rightCell} ${c.accent('│')}`);
  }
  println(c.accent(`╰${'─'.repeat(W - 2)}╯`));
}

export function shortPath(p, max = 52) {
  return p.length > max ? '…' + p.slice(-(max - 1)) : p;
}
