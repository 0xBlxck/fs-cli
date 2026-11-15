// UI : couleurs, spinner, rendu markdown en streaming, blocs d'outils
import process from 'node:process';
import { parseFenceInfo } from './fence.js';

export const THEMES = {
  cyan: [86, 212, 221], green: [120, 220, 140], magenta: [210, 130, 230], yellow: [240, 200, 90],
  orange: [255, 150, 80], blue: [110, 160, 255], red: [240, 100, 100], white: [235, 235, 235],
  amber: [255, 176, 0], matrix: [0, 230, 80], cyberpunk: [255, 60, 200], dracula: [189, 147, 249],
};
export const theme = { name: 'cyan' };

const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
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

process.on('exit', () => { if (TTY) process.stdout.write('\x1b[?25h'); });

// ── Sortie : toute écriture passe ici, le spinner s'efface toujours avant ──────
// Avec l'interface plein écran (sink), le texte et le spinner passent par la zone d'affichage : le spinner reste visible pendant le flux.
let sink = null;
export function attachSink(s) { sink = s; }

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
export function out(s) {
  if (sink) { if (sp && /^réflexion/.test(sp.label)) sp.label = 'rédaction…'; sink.print(s); return; }
  spinner.stop(); process.stdout.write(s);
}
export function println(s = '') { out(s + '\n'); }

// ── Spinner ────────────────────────────────────────────────────────────────────
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let sp = null;
function draw() {
  if (!sp) return;
  const s = Math.floor((Date.now() - sp.t0) / 1000);
  const text = `${c.accent(FRAMES[sp.i++ % FRAMES.length])} ${c.dim(sp.label)} ${c.dim(s + 's')}`;
  if (sink) sink.spinner(text);
  else process.stdout.write(`\r\x1b[K  ${text}`);
}
export const spinner = {
  start(label = 'réflexion…') {
    if (!TTY && !sink) return;
    this.stop();
    sp = { label, t0: Date.now(), i: 0, timer: null };
    if (!sink) process.stdout.write('\x1b[?25l');
    draw();
    sp.timer = setInterval(draw, 90);
  },
  label(l) { if (sp) sp.label = l; },
  stop() {
    if (!sp) return;
    clearInterval(sp.timer); sp = null;
    if (sink) sink.spinner(null);
    else process.stdout.write('\r\x1b[K\x1b[?25h');
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
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, (_, t) => c.bold(c.italic(t)));
  s = s.replace(/\*\*(.+?)\*\*/g, (_, t) => c.bold(t));
  s = s.replace(/__(.+?)__/g, (_, t) => c.bold(t));
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, (_, p, t) => p + c.italic(t));
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `${c.underline(t)} ${c.dim('(' + u + ')')}`);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `\x1b[48;2;48;50;60m\x1b[38;2;240;205;150m ${codes[i]} \x1b[39m\x1b[49m`);
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
    this.flushLine();
    if (this.inCode) this.closeCode();
  }
  closeCode() {
    if (this.collapse) {
      if (this.codeLines > 0) {
        this.blank();
        println(`  ${c.dim('▸')} ${c.accent(this.lang || 'code')}${this.codeName ? ' ' + c.bold(this.codeName) : ''} ${c.dim(`· ${this.codeLines} ligne${this.codeLines > 1 ? 's' : ''}`)}`);
        this.printed = true; this.lastBlank = false;
      }
    } else if (this.opened) { println(c.dim('  ╰─')); this.lastBlank = false; }
    this.inCode = false; this.opened = false; this.codeLines = 0;
  }
  emit(s) { println(s); this.printed = true; this.lastBlank = false; }
  blank() { if (!this.lastBlank && this.printed) { println(); this.lastBlank = true; } }
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

    if (line.trim() === '') { this.blank(); return; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      this.blank();
      const t = inline(m[2]);
      this.emit(m[1].length === 1 ? c.bold(c.accent(t)) : m[1].length === 2 ? c.bold(c.white(t)) : c.bold(c.yellow(t)));
      return;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { this.emit(c.dim('─'.repeat(Math.min(48, cols() - 4)))); return; }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) { this.emit(`${m[1]}${c.accent('•')} ${inline(m[2])}`); return; }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) { this.emit(`${m[1]}${c.accent(m[2] + '.')} ${inline(m[3])}`); return; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { this.emit(`${c.dim('▎')} ${c.italic(inline(m[1]))}`); return; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { this.emit(c.dim(line.replace(/[^|]/g, '─').replace(/\|/g, '┼'))); return; }
      this.emit(inline(line).replace(/\|/g, c.dim('│'))); return;
    }
    this.emit(inline(line));
  }
}

// ── Blocs d'outils ────────────────────────────────────────────────────────────
export function toolHeader(name, summary = '') {
  println();
  println(`  ${c.accent('●')} ${c.bold(name)}${summary ? '  ' + c.dim(clip(summary.replace(/\s+/g, ' '), cols() - name.length - 10)) : ''}`);
}

export function toolBody(text, { max = 8, error = false } = {}) {
  const lines = sanitize(text).replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return;
  const paint = error ? c.red : c.dim;
  const shown = lines.slice(0, max);
  shown.forEach((l, i) => println(`  ${i === 0 ? c.dim('⎿') : ' '}  ${paint(clip(l, cols() - 6))}`));
  if (lines.length > max) println(`     ${c.dim(`… +${lines.length - max} lignes`)}`);
}

export function toolNote(text, kind = 'dim') {
  println(`  ${c.dim('⎿')}  ${(c[kind] || c.dim)(text)}`);
}

/** affichage en direct de la sortie d'une commande (limité) */
export function createLive(maxLines = 24) {
  let carry = '', shown = 0, hidden = 0;
  const emitLine = (l) => {
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

export function diffView(oldStr, newStr, max = 14) {
  const o = oldStr.split('\n'), n = newStr.split('\n');
  let a = 0;
  while (a < o.length && a < n.length && o[a] === n[a]) a++;
  let b = 0;
  while (b < o.length - a && b < n.length - a && o[o.length - 1 - b] === n[n.length - 1 - b]) b++;
  const rem = o.slice(a, o.length - b), add = n.slice(a, n.length - b);
  const lines = [...rem.map(l => c.red('- ' + l)), ...add.map(l => c.green('+ ' + l))];
  const w = cols() - 8;
  lines.slice(0, max).forEach((l, i) => println(`  ${i === 0 ? c.dim('⎿') : ' '}  ${clip(l, w + 20)}`));
  if (lines.length > max) println(`     ${c.dim(`… +${lines.length - max} lignes`)}`);
  return { removed: rem.length, added: add.length };
}

// ── Boîte / bannière ──────────────────────────────────────────────────────────
export function box(rows, { title = '', width } = {}) {
  const W = Math.min(width || cols() - 2, 84);
  const inner = W - 4;
  const top = `╭─ ${title} ${'─'.repeat(Math.max(0, W - 5 - stripAnsi(title).length))}╮`;
  println(c.accent(top));
  for (const r of rows) {
    const vis = stripAnsi(r).length;
    const txt = vis > inner ? clip(stripAnsi(r), inner) : r;
    const pad = ' '.repeat(Math.max(0, inner - stripAnsi(txt).length));
    println(`${c.accent('│')} ${txt}${pad} ${c.accent('│')}`);
  }
  println(c.accent(`╰${'─'.repeat(W - 2)}╯`));
}

export function shortPath(p, max = 52) {
  return p.length > max ? '…' + p.slice(-(max - 1)) : p;
}
