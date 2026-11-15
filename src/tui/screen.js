// Écran : le texte défile normalement, une zone fixe (« footer » : saisie, état) reste en bas.
// Règle : tout affichage passe par print() ; le footer est effacé, le texte écrit, puis le footer redessiné.
import { clipAnsi } from './layout.js';

export class Screen {
  /** compose() -> { lines: string[], caret: {row, col}, hideCursor?: bool } ; getCols() -> nombre de colonnes */
  constructor({ out, compose, getCols }) {
    this.out = out; this.compose = compose; this.getCols = getCols || (() => out.columns || 100);
    this.rendered = false; this.caretRow = 0; this.height = 0;
    this.pending = ''; this.scheduled = false; this.stopped = false;
  }

  eraseSeq() { return (this.caretRow > 0 ? `\x1b[${this.caretRow}A` : '') + '\r\x1b[J'; }

  frame() {
    const { lines, caret, hideCursor } = this.compose();
    const max = Math.max(10, this.getCols() - 1);
    const clipped = lines.map(l => clipAnsi(l, max));
    let s = clipped.join('\r\n');                            // \r\n explicite : indépendant du réglage ONLCR du terminal
    const up = clipped.length - 1 - caret.row;
    if (up > 0) s += `\x1b[${up}A`;
    s += '\r' + (caret.col > 0 ? `\x1b[${caret.col}C` : '') + (hideCursor ? '\x1b[?25l' : '\x1b[?25h');
    this.caretRow = caret.row; this.height = clipped.length;
    return s;
  }

  render() {
    if (this.stopped) return;
    this.flush();                                            // le texte en attente passe avant
    let s = '\x1b[?25l';
    if (this.rendered) s += this.eraseSeq();
    s += this.frame();
    this.rendered = true;
    this.out.write(s);
  }

  /** écrit du texte au-dessus du footer (regroupé : une seule réécriture par tour de boucle) */
  print(text) {
    if (this.stopped) { this.out.write(text); return; }
    this.pending += text;
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; this.render(); }); }
  }

  flush() {
    if (!this.pending) return;
    let t = this.pending; this.pending = '';
    if (!t.endsWith('\n')) t += '\n';
    t = t.replace(/\r?\n/g, '\r\n');
    let s = '\x1b[?25l';
    if (this.rendered) s += this.eraseSeq();
    this.rendered = false;
    this.out.write(s + t);
  }

  /** efface tout l'écran puis redessine le footer */
  clearScreen() {
    this.pending = '';
    this.rendered = false;
    this.out.write('\x1b[2J\x1b[3J\x1b[H');
    this.render();
  }

  stop() {
    if (this.stopped) return;
    this.flush();
    if (this.rendered) this.out.write(this.eraseSeq() + '\x1b[?25h');
    else this.out.write('\x1b[?25h');
    this.rendered = false; this.stopped = true;
  }
}
