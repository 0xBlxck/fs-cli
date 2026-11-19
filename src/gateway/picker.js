// Menu à flèches autonome, affiché AVANT le lancement de Claude Code (fs-cli claude --fs-conversations) :
// une fenêtre de quelques lignes qui défile (↑ ↓, Page préc./suiv., Début/Fin), Entrée choisit, Échap revient.
import { KeyParser } from '../tui/keys.js';
import { strWidth } from '../tui/layout.js';

const dim = s => `\x1b[2m${s}\x1b[22m`;
const bold = s => `\x1b[1m${s}\x1b[22m`;
const accent = s => `\x1b[36m${s}\x1b[39m`;

/** coupe un texte à `width` colonnes d'affichage (emoji compris) */
export function fit(s, width) {
  let out = '', w = 0;
  for (const ch of String(s ?? '')) {
    const cw = strWidth(ch);
    if (w + cw > width) return out.slice(0, Math.max(0, out.length - 1)) + '…';
    out += ch; w += cw;
  }
  return out;
}

/** déplacement (état pur, testable) → { idx, top } ; top garde idx dans la fenêtre de `visible` lignes */
export function movePicker({ idx, top }, key, n, visible) {
  const max = n - 1;
  if (key === 'up') idx = idx > 0 ? idx - 1 : max;             // en haut : on repart du bas
  else if (key === 'down') idx = idx < max ? idx + 1 : 0;
  else if (key === 'pageup') idx = Math.max(0, idx - visible);
  else if (key === 'pagedown') idx = Math.min(max, idx + visible);
  else if (key === 'home') idx = 0;
  else if (key === 'end') idx = max;
  if (idx < top) top = idx;
  if (idx >= top + visible) top = idx - visible + 1;
  return { idx, top: Math.max(0, Math.min(top, Math.max(0, n - visible))) };
}

/** lignes à afficher (sans retour à la ligne final) */
export function renderPicker({ title, items, hint }, { idx, top }, visible, cols = 80) {
  const W = Math.max(20, cols - 1);
  const lines = [bold(fit(title, W))];
  const above = top, below = Math.max(0, items.length - top - visible);
  lines.push(dim(above ? `  ↑ ${above} de plus` : ''));
  for (let i = top; i < Math.min(items.length, top + visible); i++) {
    const it = items[i], on = i === idx;
    const label = fit(it.label, W - 4);
    const desc = it.description ? fit(` · ${it.description}`, Math.max(0, W - 4 - strWidth(label))) : '';
    lines.push(on ? `${accent('❯')} ${accent(label)}${dim(desc)}` : `  ${label}${dim(desc)}`);
  }
  lines.push(dim(below ? `  ↓ ${below} de plus` : ''));
  lines.push(dim(fit(hint || '↑↓ défiler · Entrée choisir · Échap retour', W)));
  return lines;
}

/** Affiche le menu ; → index choisi, ou null (Échap, Ctrl+C, pas de terminal). */
export function pickInTerminal({ title, items, hint, visible = 5, input = process.stdin, output = process.stderr }) {
  if (!items?.length || !input.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    let st = { idx: 0, top: 0 }, drawn = 0, escTimer = null;
    const rows = Math.min(visible, items.length);
    const draw = () => {
      const lines = renderPicker({ title, items, hint }, st, rows, output.columns || 80);
      output.write((drawn ? `\x1b[${drawn}F` : '') + '\x1b[J' + lines.join('\n') + '\n');
      drawn = lines.length;
    };
    const done = v => {
      clearTimeout(escTimer);
      input.off('data', onData);
      try { input.setRawMode(false); } catch {}
      input.pause();
      output.write(`\x1b[${drawn}F\x1b[J\x1b[?25h`);                // menu effacé, curseur rendu
      resolve(v);
    };
    const parser = new KeyParser(k => {
      if (k.name === 'enter') return done(st.idx);
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return done(null);
      if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(k.name)) { st = movePicker(st, k.name, items.length, rows); draw(); }
    });
    const onData = d => {
      parser.feed(String(d));
      clearTimeout(escTimer);
      if (parser.rest === '\x1b') escTimer = setTimeout(() => { parser.rest = ''; done(null); }, 60);   // Échap seul (pas une flèche)
    };
    output.write('\x1b[?25l');
    try { input.setRawMode(true); } catch { return resolve(null); }
    input.resume();
    input.on('data', onData);
    draw();
  });
}
