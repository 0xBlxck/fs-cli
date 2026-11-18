// Écran « ancré » : la zone de saisie reste TOUJOURS au bas de la fenêtre (quelle que soit sa taille), le texte s'écrit depuis le haut
// et défile normalement (l'historique reste dans le défilement natif du terminal : pas d'écran alternatif, pas de région de défilement).
//
// Principe : on suit nous-mêmes la position d'écriture du contenu (cr, cc). À chaque image :
//   1. on efface la zone du bas, 2. on écrit le texte en attente à (cr, cc), 3. si le contenu empiète sur la zone du bas on fait défiler
//   l'écran avec des sauts de ligne en bas (le terminal range les lignes sortantes dans son historique), 4. on dessine la zone en bas.
import { clipAnsi, charWidth, strWidth, stripAnsi } from './layout.js';

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
    let i = 0, prev = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\x1b') { SGR_OR_CSI.lastIndex = i; if (SGR_OR_CSI.test(text)) { i = SGR_OR_CSI.lastIndex; continue; } i++; continue; }
      if (ch === '\r') { this.cc = 0; prev = 0; i++; continue; }
      if (ch === '\n') { this.cr = Math.min(this.R, this.cr + 1); prev = 0; i++; continue; }
      // tabulation : le terminal saute au prochain taquet de 8 (sans jamais passer à la ligne)
      if (ch === '\t') { this.cc = Math.max(this.cc, Math.min(this.C - 1, (Math.floor(this.cc / 8) + 1) * 8)); prev = 0; i++; continue; }
      const cp = String.fromCodePoint(text.codePointAt(i)); i += cp.length;
      const w = cp === '️' ? (prev === 1 ? 1 : 0) : charWidth(cp);   // ⚠️ : U+FE0F élargit le caractère précédent
      prev = cp === '️' ? 0 : w;
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
    const drawn = lines.map(l => clipAnsi(l, C));
    const tail = `\x1b[${R - H + 1 + caret.row};${caret.col + 1}H` + (hideCursor ? '\x1b[?25l' : '\x1b[?25h');

    // rien d'autre n'a bougé (ni texte en attente, ni taille, ni hauteur) : on ne réécrit que les lignes changées, sans effacer la zone
    if (!resized && !this.pending && prevH > 0 && H === prevH && this.last?.length === H) {
      let s = '';
      for (let i = 0; i < H; i++) {
        if (drawn[i] === this.last[i]) continue;
        s += `\x1b[${R - H + 1 + i};1H\x1b[2K` + drawn[i];
        this.lastWidths[i] = strWidth(stripAnsi(drawn[i]).trimEnd());
      }
      if (!s && tail === this.lastTail) return;              // image identique : aucune écriture
      this.last = drawn; this.lastTail = tail;
      this.out.write('\x1b[?2026h\x1b[?25l' + s + tail + '\x1b[?2026l');   // affichage synchronisé (ignoré par les terminaux qui ne le gèrent pas)
      return;
    }

    let s = '\x1b[?2026h\x1b[?25l';
    if (resized) {                                           // redimensionnement : on repart de la position d'écriture, on nettoie en dessous
      let top = R - H + 1;
      // fenêtre plus étroite : le terminal a remis à la ligne l'ancienne zone (lignes de W-1 colonnes), qui occupe maintenant plus de lignes
      if (this.lastWidths?.length && this.C && C < this.C) {
        const rows = this.lastWidths.reduce((a, w) => a + Math.max(1, Math.ceil(w / C)), 0);
        top = Math.min(top, R - rows + 1);
      }
      this.R = R; this.C = C;
      this.cr = Math.max(1, Math.min(this.cr, top)); this.cc = 0;
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

    for (let i = 0; i < H; i++) s += `\x1b[${R - H + 1 + i};1H\x1b[2K` + drawn[i];   // 4. zone du bas
    s += tail + '\x1b[?2026l';
    this.H = H; this.last = drawn; this.lastTail = tail;
    this.lastWidths = drawn.map(l => strWidth(stripAnsi(l).trimEnd()));   // largeur réelle de chaque ligne (pour un futur rétrécissement)
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
