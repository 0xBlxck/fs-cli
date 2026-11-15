// Écran « ancré » : la zone de saisie reste TOUJOURS au bas de la fenêtre (quelle que soit sa taille), le texte s'écrit depuis le haut
// et défile normalement (l'historique reste dans le défilement natif du terminal : pas d'écran alternatif, pas de région de défilement).
//
// Principe : on suit nous-mêmes la position d'écriture du contenu (cr, cc). À chaque image :
//   1. on efface la zone du bas, 2. on écrit le texte en attente à (cr, cc), 3. si le contenu empiète sur la zone du bas on fait défiler
//   l'écran avec des sauts de ligne en bas (le terminal range les lignes sortantes dans son historique), 4. on dessine la zone en bas.
import { clipAnsi, charWidth } from './layout.js';

const SGR_OR_CSI = /\x1b\[[0-9;?]*[A-Za-z]/y;

export class PinnedScreen {
  /** compose(maxRows) -> { lines: string[], caret: {row, col}, hideCursor?: bool } */
  constructor({ out, compose, getCols, getRows }) {
    this.out = out; this.compose = compose;
    this.getCols = getCols || (() => out.columns || 100);
    this.getRows = getRows || (() => out.rows || 24);
    this.cr = 1; this.cc = 0; this.H = 0; this.R = 0; this.C = 0;
    this.pending = ''; this.scheduled = false; this.started = false; this.stopped = false;
  }

  start() {
    this.started = true;
    this.R = this.getRows(); this.C = this.getCols();
    this.out.write('\x1b[2J\x1b[H');                         // écran propre : contenu en haut, saisie en bas
    this.cr = 1; this.cc = 0; this.H = 0;
    this.draw();
  }

  render() { this.draw(); }

  print(text) {
    if (this.stopped) { this.out.write(text); return; }
    this.pending += text;
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; this.draw(); }); }
  }

  clearScreen() {
    this.pending = '';
    this.out.write('\x1b[2J\x1b[3J\x1b[H');
    this.cr = 1; this.cc = 0; this.H = 0;
    this.draw();
  }

  /** met à jour (cr, cc) après l'écriture de `text` (déjà en \r\n) */
  advance(text) {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\x1b') { SGR_OR_CSI.lastIndex = i; if (SGR_OR_CSI.test(text)) { i = SGR_OR_CSI.lastIndex; continue; } i++; continue; }
      if (ch === '\r') { this.cc = 0; i++; continue; }
      if (ch === '\n') { this.cr = Math.min(this.R, this.cr + 1); i++; continue; }
      const cp = String.fromCodePoint(text.codePointAt(i)); i += cp.length;
      const w = charWidth(cp);
      if (!w) continue;
      if (this.cc + w > this.C) { this.cc = 0; this.cr = Math.min(this.R, this.cr + 1); }
      this.cc += w;
    }
  }

  draw() {
    if (!this.started || this.stopped) return;
    const R = this.getRows(), C = this.getCols();
    const { lines: raw, caret, hideCursor } = this.compose(R);
    const lines = raw.slice(0, Math.max(3, R - 1));
    const H = lines.length;
    const resized = R !== this.R || C !== this.C;
    const prevH = this.H;
    let s = '\x1b[?25l';

    if (resized) {                                           // redimensionnement : on repart de la position d'écriture, on nettoie en dessous
      this.R = R; this.C = C;
      this.cr = Math.max(1, Math.min(this.cr, R - H + 1)); this.cc = 0;
      s += `\x1b[${this.cr};1H\x1b[J`;
    } else if (prevH > 0) {
      s += `\x1b[${R - prevH + 1};1H\x1b[J`;                 // efface l'ANCIENNE zone du bas (jamais le contenu au-dessus)
    }

    if (this.pending) {                                      // 2. texte en attente
      let t = this.pending; this.pending = '';
      if (!t.endsWith('\n')) t += '\n';
      const text = t.replace(/\r?\n/g, '\r\n');
      s += `\x1b[${this.cr};${this.cc + 1}H` + text;
      this.advance(text);
    }

    const need = this.cr - (R - H + 1);                       // 3. le contenu ne doit jamais passer sous la zone du bas
    if (need > 0) { s += `\x1b[${R};1H` + '\n'.repeat(need); this.cr -= need; }

    for (let i = 0; i < H; i++) s += `\x1b[${R - H + 1 + i};1H\x1b[2K` + clipAnsi(lines[i], C);   // 4. zone du bas
    s += `\x1b[${R - H + 1 + caret.row};${caret.col + 1}H` + (hideCursor ? '\x1b[?25l' : '\x1b[?25h');
    this.H = H;
    this.out.write(s);
  }

  stop() {
    if (this.stopped) return;
    if (this.started) {
      this.draw();                                           // vide le texte en attente
      const R = this.R, H = this.H;
      this.out.write(`\x1b[${R - H + 1};1H\x1b[J\x1b[${Math.max(1, Math.min(this.cr, R - H + 1))};1H\x1b[?25h`);   // le shell reprend juste après le contenu
    } else this.out.write('\x1b[?25h');
    this.stopped = true;
  }
}
