// Mise en page du texte dans le terminal : largeur, découpe ANSI, retour à la ligne de la zone de saisie

export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = s => s.replace(ANSI_RE, '');

/** largeur d'affichage d'un caractère (approximation : CJK et emojis = 2, accents combinés = 0) */
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2;
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** coupe une chaîne ANSI à `max` colonnes visibles (séquences d'échappement conservées) */
export function clipAnsi(s, max) {
  if (strWidth(s) <= max) return s;
  let out = '', w = 0, i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch; w += cw; i += ch.length;
  }
  return out + '…\x1b[0m';
}

export const padAnsi = (s, width) => s + ' '.repeat(Math.max(0, width - strWidth(s)));

/**
 * Découpe `buf` en lignes visuelles de `width` colonnes max.
 * cur = index (unités UTF-16) du curseur. Renvoie {lines, caret:{row,col}, starts:[index de début de chaque ligne]}
 */
export function layoutInput(buf, cur, width) {
  width = Math.max(4, width);
  const lines = [], starts = [];
  let line = '', w = 0, unit = 0, caret = null;
  starts.push(0);
  for (const ch of buf) {
    if (unit === cur) caret = { row: lines.length, col: w };
    if (ch === '\n') { lines.push(line); line = ''; w = 0; unit += 1; starts.push(unit); continue; }
    const cw = charWidth(ch);
    if (w + cw > width) {
      lines.push(line); line = ''; w = 0; starts.push(unit);
      if (unit === cur) caret = { row: lines.length, col: 0 };
    }
    line += ch; w += cw; unit += ch.length;
  }
  if (unit === cur || !caret) {
    if (w >= width) { lines.push(line); line = ''; w = 0; starts.push(unit); }
    caret = { row: lines.length, col: w };
  }
  lines.push(line);
  return { lines, caret, starts };
}

/** index (unités UTF-16) correspondant à (row, col) dans une mise en page */
export function indexAt(layout, row, col) {
  row = Math.max(0, Math.min(layout.lines.length - 1, row));
  let idx = layout.starts[row], w = 0;
  for (const ch of layout.lines[row]) {
    const cw = charWidth(ch);
    if (w + cw > col) break;
    w += cw; idx += ch.length;
  }
  return idx;
}
