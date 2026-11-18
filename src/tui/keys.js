// Analyse des touches (mode brut) : flèches, ctrl/alt, collage « bracketed », texte UTF-8
// Émet : {name, ctrl?, meta?, shift?, text?}
//   name : 'text' 'paste' 'enter' 'newline' 'tab' 'shift-tab' 'escape' 'backspace' 'delete' 'up' 'down' 'left' 'right'
//          'home' 'end' 'pageup' 'pagedown' ou une lettre (avec ctrl/meta)

const CSI_LETTER = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const PASTE_END = '\x1b[201~';
const CSI_TILDE = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };

function mods(param) {
  const m = Math.max(0, (parseInt(param, 10) || 1) - 1);
  return { shift: !!(m & 1), meta: !!(m & 2), ctrl: !!(m & 4) };
}

export class KeyParser {
  constructor(onKey) { this.onKey = onKey; this.pasting = false; this.pasteBuf = ''; this.rest = ''; }

  feed(input) {
    let str = this.rest + input; this.rest = '';
    const n = str.length;
    let i = 0;

    // collage sans marqueurs (terminal ancien) : un bloc contenant des retours à la ligne n'est pas une frappe
    if (!this.pasting && str.length > 1 && !str.startsWith('\x1b') && /[\r\n]/.test(str) && /[^\r\n]/.test(str) && !/\x1b/.test(str)) {
      const text = str.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      if (text) this.onKey({ name: 'paste', text });
      return;
    }

    while (i < n) {
      if (this.pasting) {
        const e = str.indexOf(PASTE_END, i);
        if (e < 0) {                                                    // marque de fin peut-être coupée entre deux morceaux (pty macOS ~1 Ko) : on garde son début pour la suite
          let k = Math.min(PASTE_END.length - 1, n - i);
          while (k > 0 && !str.endsWith(PASTE_END.slice(0, k))) k--;
          this.pasteBuf += str.slice(i, n - k); this.rest = str.slice(n - k);
          return;
        }
        this.pasteBuf += str.slice(i, e);
        this.onKey({ name: 'paste', text: this.pasteBuf.replace(/\r\n?/g, '\n') });
        this.pasteBuf = ''; this.pasting = false; i = e + 6;
        continue;
      }
      const ch = str[i];

      if (ch === '\x1b') {
        if (str.startsWith('\x1b[200~', i)) { this.pasting = true; i += 6; continue; }
        if (i + 1 >= n) { this.onKey({ name: 'escape' }); i++; continue; }
        const nx = str[i + 1];
        if (nx === '[') {
          let j = i + 2;
          while (j < n && /[0-9;?<=>:]/.test(str[j])) j++;
          if (j >= n) { this.rest = str.slice(i); return; }                 // séquence coupée : on attend la suite
          const params = str.slice(i + 2, j), fin = str[j];
          i = j + 1;
          this.csi(params, fin);
          continue;
        }
        if (nx === 'O') {
          if (i + 2 >= n) { this.rest = str.slice(i); return; }
          const f = str[i + 2]; i += 3;
          if (CSI_LETTER[f]) this.onKey({ name: CSI_LETTER[f] });
          continue;
        }
        if (nx === '\r' || nx === '\n') { this.onKey({ name: 'newline', meta: true }); i += 2; continue; }   // alt+entrée
        const cp = str.codePointAt(i + 1), chr = String.fromCodePoint(cp);
        i += 1 + chr.length;
        if (chr === '\x7f') this.onKey({ name: 'backspace', meta: true });
        else this.onKey({ name: chr.toLowerCase(), meta: true, text: chr });
        continue;
      }

      if (ch === '\r') { this.onKey({ name: 'enter' }); i++; continue; }
      if (ch === '\n') { this.onKey({ name: 'newline', ctrl: true }); i++; continue; }
      if (ch === '\t') { this.onKey({ name: 'tab' }); i++; continue; }
      if (ch === '\x7f' || ch === '\b') { this.onKey({ name: 'backspace' }); i++; continue; }
      const code = ch.codePointAt(0);
      if (code >= 1 && code <= 26) { this.onKey({ name: String.fromCharCode(96 + code), ctrl: true }); i++; continue; }
      if (code < 32) { i++; continue; }

      let j = i;                                                          // série de caractères imprimables
      while (j < n && str.charCodeAt(j) >= 32 && str[j] !== '\x7f' && str[j] !== '\x1b') j++;
      this.onKey({ name: 'text', text: str.slice(i, j) });
      i = j;
    }
  }

  csi(params, fin) {
    const parts = params.split(';');
    if (fin === 'Z') return this.onKey({ name: 'shift-tab', shift: true });
    if (CSI_LETTER[fin]) return this.onKey({ name: CSI_LETTER[fin], ...mods(parts[1]) });
    if (fin === '~') {
      if (parts[0] === '27' && parts[2] === '13') return this.onKey({ name: 'newline', ...mods(parts[1]) });   // modifyOtherKeys : maj+entrée
      const name = CSI_TILDE[parts[0]];
      if (name) this.onKey({ name, ...mods(parts[1]) });
      return;
    }
    if (fin === 'u' && parts[0] === '13') return this.onKey(parts[1] && parts[1] !== '1' ? { name: 'newline', ...mods(parts[1]) } : { name: 'enter' });   // protocole kitty
    if (fin === 'u' && parts[0] === '27') return this.onKey({ name: 'escape' });
  }
}
