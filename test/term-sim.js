// Mini émulateur de terminal pour tester l'interface sans vrai terminal (sous-ensemble VT : curseur, effacement, défilement, retour auto à la ligne)
import { EventEmitter } from 'node:events';
import { charWidth } from '../src/tui/layout.js';

export class TermSim {
  constructor(cols = 80, rows = 24) {
    this.cols = cols; this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
    this.scrollback = []; this.r = 0; this.c = 0; this.cursorVisible = true; this.writes = 0;
  }

  lineFeed() {
    if (this.r < this.rows - 1) this.r++;
    else { this.scrollback.push(this.grid.shift().join('').trimEnd()); this.grid.push(Array(this.cols).fill(' ')); }
  }

  write(s) {
    this.writes++;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i));
        if (m) { this.csi(m[1], m[2]); i += m[0].length; continue; }
        i++; continue;
      }
      if (ch === '\r') { this.c = 0; i++; continue; }
      if (ch === '\n') { this.lineFeed(); i++; continue; }          // le terminal réel ne remet pas la colonne à 0 : on respecte (comme onlcr désactivé)
      if (ch === '\x07') { i++; continue; }
      const cp = String.fromCodePoint(s.codePointAt(i)), w = charWidth(cp);
      i += cp.length;
      if (w === 0) continue;
      if (this.c + w > this.cols) { this.c = 0; this.lineFeed(); }
      this.grid[this.r][this.c] = cp;
      if (w === 2 && this.c + 1 < this.cols) this.grid[this.r][this.c + 1] = '';
      this.c += w;
    }
  }

  csi(p, f) {
    const n = parseInt(p, 10) || 0, one = n || 1;
    switch (f) {
      case 'A': this.r = Math.max(0, this.r - one); break;
      case 'B': this.r = Math.min(this.rows - 1, this.r + one); break;
      case 'C': this.c = Math.min(this.cols - 1, this.c + one); break;
      case 'D': this.c = Math.max(0, this.c - one); break;
      case 'G': this.c = Math.max(0, Math.min(this.cols - 1, one - 1)); break;
      case 'H': { const [rr, cc] = p.split(';').map(x => parseInt(x, 10) || 1); this.r = Math.min(this.rows - 1, rr - 1); this.c = Math.min(this.cols - 1, cc - 1); break; }
      case 'J':
        if (n === 2 || n === 3) { this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(' ')); if (n === 3) this.scrollback = []; }
        else { for (let x = this.c; x < this.cols; x++) this.grid[this.r][x] = ' '; for (let y = this.r + 1; y < this.rows; y++) this.grid[y].fill(' '); }
        break;
      case 'K':
        if (n === 2) this.grid[this.r].fill(' ');
        else if (n === 1) for (let x = 0; x <= this.c; x++) this.grid[this.r][x] = ' ';
        else for (let x = this.c; x < this.cols; x++) this.grid[this.r][x] = ' ';
        break;
      case 'h': if (p === '?25') this.cursorVisible = true; break;
      case 'l': if (p === '?25') this.cursorVisible = false; break;
      default: break;                                              // m (couleurs), modes : ignorés
    }
  }

  /** redimensionne la fenêtre : le haut du contenu est conservé, le curseur recadré (comme la plupart des terminaux) */
  resize(cols, rows) {
    const old = this.grid.map(r => r.slice());
    this.grid = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => (old[y] && old[y][x]) ?? ' '));
    this.cols = cols; this.rows = rows;
    this.r = Math.min(this.r, rows - 1); this.c = Math.min(this.c, cols - 1);
  }

  lines() { return this.grid.map(r => r.join('').trimEnd()); }
  screen() { return this.lines().join('\n').replace(/\n+$/, ''); }
  all() { return [...this.scrollback, ...this.lines()].join('\n').replace(/\n+$/, ''); }
  count(re) { return (this.all().match(re) || []).length; }
}

/** flux simulés pour Tui */
export function fakeStreams(cols = 80, rows = 24) {
  const sim = new TermSim(cols, rows);
  const stdout = new EventEmitter();
  Object.assign(stdout, { columns: cols, rows, isTTY: true, write: s => { sim.write(s); return true; } });
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
  const type = s => stdin.emit('data', Buffer.from(s, 'utf8'));
  const tick = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  const resize = (c, r) => { sim.resize(c, r); stdout.columns = c; stdout.rows = r; stdout.emit('resize'); };
  return { sim, stdout, stdin, type, tick, resize };
}
