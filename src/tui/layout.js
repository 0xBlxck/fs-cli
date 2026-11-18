// Mise en page du texte dans le terminal : largeur, découpe ANSI, retour à la ligne de la zone de saisie

export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = s => s.replace(ANSI_RE, '');

// emojis du plan de base affichés sur 2 colonnes (East Asian Width « W ») : ✅ ❌ ⚡ ⭐ ✨ ⏳ ❗…
const WIDE_BMP = [[0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff]];

/** largeur d'affichage d'un caractère (approximation : CJK et emojis = 2, accents combinés = 0) */
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2;
  if (cp >= 0x231a && cp <= 0x1f2ff) for (const [a, b] of WIDE_BMP) { if (cp < a) break; if (cp <= b) return 2; }
  return 1;
}

/**
 * Largeur d'un caractère à la colonne `col`, sachant la largeur du précédent (`prevW`) :
 * tabulation = jusqu'au prochain multiple de 8 ; U+FE0F (présentation emoji) après un caractère simple = 1 colonne de plus (⚠️ = 2).
 */
export function cellWidth(ch, col, prevW) {
  if (ch === '\t') return 8 - (col % 8);
  if (ch === '️') return prevW === 1 ? 1 : 0;
  return charWidth(ch);
}

export function strWidth(s) {
  let w = 0, prev = 0;
  for (const ch of stripAnsi(s)) { const cw = cellWidth(ch, w, prev); w += cw; prev = ch === '️' ? 0 : cw; }
  return w;
}

/** coupe une chaîne ANSI à `max` colonnes visibles (séquences d'échappement conservées) */
export function clipAnsi(s, max) {
  if (strWidth(s) <= max) return s;
  let out = '', w = 0, i = 0, prev = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const cw = cellWidth(ch, w, prev);
    if (w + cw > max - 1) break;
    out += ch; w += cw; i += ch.length; prev = ch === '️' ? 0 : cw;
  }
  return out + '…\x1b[0m';
}

export const padAnsi = (s, width) => s + ' '.repeat(Math.max(0, width - strWidth(s)));

/**
 * Découpe `buf` en lignes visuelles de `width` colonnes max.
 * cur = index (unités UTF-16) du curseur. Renvoie {lines, caret:{row,col}, starts:[index de début de chaque ligne], srcs:[texte d'origine de chaque ligne]}
 * Les tabulations sont affichées en espaces (jusqu'au prochain multiple de 8) : `lines` contient les espaces, `srcs` le texte d'origine.
 */
export function layoutInput(buf, cur, width) {
  width = Math.max(4, width);
  const lines = [], starts = [], srcs = [];
  let line = '', src = '', w = 0, unit = 0, caret = null, prev = 0;
  starts.push(0);
  for (const ch of buf) {
    if (unit === cur) caret = { row: lines.length, col: w };
    if (ch === '\n') { lines.push(line); srcs.push(src); line = ''; src = ''; w = 0; prev = 0; unit += 1; starts.push(unit); continue; }
    let cw = cellWidth(ch, w, prev);
    if (w + cw > width) {
      lines.push(line); srcs.push(src); line = ''; src = ''; w = 0; starts.push(unit);
      if (unit === cur) caret = { row: lines.length, col: 0 };
      if (ch === '\t') cw = 8;
    }
    if (ch === '\t') { cw = Math.min(cw, width - w); line += ' '.repeat(cw); } else line += ch;
    src += ch; w += cw; unit += ch.length; prev = ch === '️' ? 0 : cw;
  }
  if (unit === cur || !caret) {
    if (w >= width) { lines.push(line); srcs.push(src); line = ''; src = ''; w = 0; starts.push(unit); }
    caret = { row: lines.length, col: w };
  }
  lines.push(line); srcs.push(src);
  return { lines, caret, starts, srcs };
}

/** index (unités UTF-16) correspondant à (row, col) dans une mise en page */
export function indexAt(layout, row, col) {
  row = Math.max(0, Math.min(layout.lines.length - 1, row));
  let idx = layout.starts[row], w = 0, prev = 0;
  for (const ch of (layout.srcs ? layout.srcs[row] : layout.lines[row])) {   // texte d'origine (tabulations comprises) si connu
    const cw = cellWidth(ch, w, prev);
    if (w + cw > col) break;
    w += cw; idx += ch.length; prev = ch === '️' ? 0 : cw;
  }
  return idx;
}
