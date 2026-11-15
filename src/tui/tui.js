// Interface interactive : boîte de saisie encadrée en bas, barre d'état, suggestions, menus de confirmation, file d'attente.
import { StringDecoder } from 'node:string_decoder';
import { KeyParser } from './keys.js';
import { Screen } from './screen.js';
import { PinnedScreen } from './pinned.js';
import { layoutInput, indexAt, strWidth, padAnsi, stripAnsi, clipAnsi } from './layout.js';
import { c, taskLine } from '../ui.js';

// astuces affichées dans la zone de saisie vide (une nouvelle à chaque demande)
const TIPS = ['fais-moi un site de café avec plusieurs agents', 'corrige le bug dans script.js', 'ouvre quick.fr dans le navigateur', 'retiens que je code en TypeScript', 'explique ce projet', 'ajoute des tests', 'refais le design de index.html', 'combien de conversations il me reste ?'];

const MODE_LABEL = {
  auto: ['⏵⏵ auto', 'exécution automatique'],
  edits: ['⏵ modifs auto', 'fichiers modifiés sans demander, commandes confirmées'],
  ask: ['⏸ confirmer', 'confirmation à chaque action'],
  plan: ['◇ plan', 'proposer sans exécuter'],
};

export class Tui {
  constructor({ stdin = process.stdin, stdout = process.stdout, history = [], onHistory = null, suggester = null, maxInputLines = 8, pinned = true } = {}) {
    this.stdin = stdin; this.stdout = stdout; this.onHistory = onHistory; this.suggester = suggester; this.maxInputLines = maxInputLines;
    this.buf = ''; this.cur = 0;
    this.hist = history.slice(); this.histIdx = -1; this.draft = '';
    this.queue = []; this.busy = false; this.spinnerText = null; this.tasks = []; this.tipIdx = Math.floor(Math.random() * 8); this.lastEsc = 0;
    this.status = { model: '', mode: 'auto', cwd: '', ctx: null };
    this.flashText = ''; this.flashTimer = null; this.lastCtrlC = 0;
    this.sug = { items: [], idx: -1, start: 0 }; this.sugOff = null;
    this.search = null; this.ask = null; this.askSaved = null; this.select_ = null;
    this.handlers = { submit: [], interrupt: [], quit: [], cycleMode: [], pasteImage: [], rewind: [], expand: [] };
    this.started = false;
    // zone de saisie ancrée en bas de la fenêtre si le terminal annonce sa hauteur ; sinon affichage « en ligne » classique
    const pin = pinned && (stdout.rows || 0) >= 8;
    this.screen = pin
      ? new PinnedScreen({ out: stdout, compose: R => this.compose(R), getCols: () => stdout.columns || 100, getRows: () => stdout.rows || 24 })
      : new Screen({ out: stdout, compose: () => this.compose(), getCols: () => stdout.columns || 100 });
  }

  on(ev, fn) { this.handlers[ev].push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.handlers[ev] || []) fn(...a); }

  // ── cycle de vie ────────────────────────────────────────────────────────────
  start() {
    if (this.started) return;
    this.started = true;
    if (this.stdin.isTTY && this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.decoder = new StringDecoder('utf8');
    this.parser = new KeyParser(k => this.onKey(k));
    this.onData = d => this.parser.feed(typeof d === 'string' ? d : this.decoder.write(d));
    this.stdin.on('data', this.onData);
    this.stdin.resume();
    this.stdout.write('\x1b[?2004h');                       // collage encadré
    this.onResize = () => this.screen.render();
    this.stdout.on('resize', this.onResize);
    if (this.screen.start) this.screen.start(); else this.screen.render();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.stdin.off('data', this.onData);
    this.stdout.off?.('resize', this.onResize);
    this.screen.stop();
    this.stdout.write('\x1b[?2004l');
    if (this.stdin.isTTY && this.stdin.setRawMode) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  // ── affichage ───────────────────────────────────────────────────────────────
  print(text) { if (!this.started) { this.stdout.write(text); return; } this.screen.print(text); }
  clearScreen() { this.screen.clearScreen(); }
  render() { if (this.started) this.screen.render(); }
  spinner(text) { this.spinnerText = text; this.render(); }
  setBusy(b) {
    this.busy = !!b;
    // Windows Terminal : progression animée dans l'onglet pendant le travail
    if (process.env.WT_SESSION && this.started) try { this.stdout.write(this.busy ? '\x1b]9;4;3;0\x07' : '\x1b]9;4;0;0\x07'); } catch {}
    this.render();
  }
  setStatus(s) { Object.assign(this.status, s); this.render(); }
  setTasks(list) { this.tasks = Array.isArray(list) ? list : []; this.render(); }
  /** Action en cours (affichée au-dessus de la saisie jusqu'à ce qu'elle soit terminée). */
  setActive(lines) { this.active = Array.isArray(lines) ? lines : []; this.render(); }
  flash(text, ms = 2200) {
    this.flashText = text; clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flashText = ''; this.render(); }, ms);
    this.flashTimer.unref?.();
    this.render();
  }
  echo(text) { this.print(c.dim('> ') + text.split('\n').join('\n  ') + '\n'); }   // ta demande, réaffichée comme dans Claude Code

  // ── API asynchrone : question d'une ligne, menu ─────────────────────────────
  askLine(label) {
    return new Promise(resolve => {
      this.askSaved = { buf: this.buf, cur: this.cur };
      this.buf = ''; this.cur = 0; this.sug = { items: [], idx: -1, start: 0 };
      this.ask = { label: stripAnsi(label).trim(), resolve };
      this.render();
    });
  }
  finishAsk(value) {
    const a = this.ask; this.ask = null;
    this.buf = this.askSaved?.buf || ''; this.cur = this.askSaved?.cur || 0; this.askSaved = null;
    this.render(); a.resolve(value);
  }

  /** menu à flèches ; renvoie l'index choisi ou null (Échap) */
  select({ title, detail = '', options, defaultIndex = 0 }) {
    return new Promise(resolve => {
      this.select_ = { title, detail, options, idx: defaultIndex, resolve };
      this.render();
      this.attention(true);
    });
  }
  finishSelect(v) { const s = this.select_; this.select_ = null; this.attention(false); this.render(); s.resolve(v); }
  /** l'agent attend une réponse : bip (la barre des tâches clignote si la fenêtre est en arrière-plan) + barre de progression orange dans Windows Terminal */
  attention(on) {
    if (!this.started) return;
    try {
      if (on) this.stdout.write('\x07' + (process.env.WT_SESSION ? '\x1b]9;4;4;100\x07' : ''));
      else if (process.env.WT_SESSION) this.stdout.write(this.busy ? '\x1b]9;4;3;0\x07' : '\x1b]9;4;0;0\x07');
    } catch {}
  }

  takeQueued() {
    const t = this.queue.shift();
    if (t !== undefined) { this.echo(t); this.render(); }
    return t ?? null;
  }

  // ── composition de la zone du bas (style Claude Code : traits horizontaux, modèle à droite au-dessus) ──
  rule(title, edge, W) {
    const t = title ? ` ${title} ` : '';
    return edge('─' + t + '─'.repeat(Math.max(0, W - 1 - strWidth(t))));
  }

  compose(maxRows = 24) {
    const W = this.screen.getCols();
    const st = this.status;
    const lines = [];

    for (const q of this.queue.slice(-3)) lines.push('  ' + c.dim('⧗ en file : ' + q.replace(/\s+/g, ' ').slice(0, Math.max(10, W - 20))));

    // action en cours (comme Codex) : visible ici pendant qu'elle tourne, écrite dans l'historique quand elle est finie
    if (this.active?.length) {
      const a = this.active.length > 8 ? [...this.active.slice(0, 3), ...this.active.slice(-5)] : this.active;
      for (const l of a) lines.push(clipAnsi(l, W - 1));
      lines.push('');
    }

    // liste de tâches du modèle, épinglée : on voit où il en est sur les longues tâches
    if (this.tasks.length) {
      const done = this.tasks.filter(t => t.state === 'done').length;
      lines.push('  ' + c.accent('●') + ' ' + c.bold('Tâches') + c.dim(` · ${done}/${this.tasks.length} faites`));
      let items = this.tasks;
      if (items.length > 7) {                                         // longue liste : fenêtre autour de la première étape non faite
        const open = Math.max(0, items.findIndex(t => t.state !== 'done'));
        const start = Math.max(0, Math.min(open - 1, items.length - 7));
        items = items.slice(start, start + 7);
      }
      const max = Math.max(10, W - 10);
      for (const t of items) {
        const txt = t.text.length > max ? t.text.slice(0, max - 1) + '…' : t.text;
        lines.push('    ' + taskLine(t.state, txt));
      }
    }

    // ligne du haut : spinner à gauche, modèle · contexte à droite (toujours présente : la zone ne change pas de hauteur)
    const right = st.model || '';                                    // le contexte restant est affiché en bas à droite
    const left = this.spinnerText ? '  ' + this.spinnerText : '';
    const gap = W - 1 - strWidth(left) - strWidth(right) - 1;
    lines.push(gap >= 1 && right ? left + ' '.repeat(gap) + c.dim(right) : left);

    if (this.select_) {
      const s = this.select_;
      lines.push(this.rule(c.bold(s.title), c.accent, W));
      for (const l of String(s.detail || '').split('\n').slice(0, 8)) if (l.trim()) lines.push('  ' + c.dim(l));
      lines.push('');
      s.options.forEach((o, i) => lines.push(i === s.idx ? '  ' + c.accent(`❯ ${i + 1}. ${o}`) : `    ${i + 1}. ${o}`));
      lines.push(this.rule('', c.accent, W));
      lines.push('  ' + c.dim('↑↓ choisir · 1-' + s.options.length + ' · Entrée valider · Échap = refuser'));
      return { lines, caret: { row: lines.length - 1, col: 0 }, hideCursor: true };
    }

    // zone de saisie : cadre aux coins arrondis (comme Claude Code)
    const textW = Math.max(10, W - 7);
    const text = this.search ? this.search.q : this.buf;
    const lay = layoutInput(text, this.search ? text.length : this.cur, textW);
    const max = Math.max(1, Math.min(this.maxInputLines, maxRows - 8));
    let start = 0;
    if (lay.lines.length > max) start = Math.min(Math.max(0, lay.caret.row - (max - 1)), lay.lines.length - max);
    const vis = lay.lines.slice(start, start + max);
    const body = vis.map((l, i) => {
      const first = start + i === 0;
      const prefix = first ? (this.ask ? c.yellow('? ') : c.accent('> ')) : '  ';
      if (first && !l && !this.search && !this.ask) {
        const ph = this.busy ? 'Écris pour ajouter à la file…' : `Essaie « ${TIPS[this.tipIdx % TIPS.length]} »`;
        return prefix + c.dim(ph.length > textW ? ph.slice(0, textW - 1) + '…' : ph);   // jamais plus large que le cadre
      }
      return prefix + l;
    });
    let title = '';
    if (this.ask) title = c.yellow(this.ask.label);
    else if (this.search) {
      title = c.accent('recherche');
      const m = this.search.match;
      body.length = 0;
      body.push(c.accent('⌕ ') + this.search.q + (m ? c.dim('  →  ' + m.replace(/\s+/g, ' ').slice(0, Math.max(5, textW - this.search.q.length - 8))) : this.search.q ? c.dim('  (aucun résultat)') : ''));
    } else if (start > 0) title = c.dim(`↑ ${start} ligne${start > 1 ? 's' : ''} plus haut`);
    const edge = this.ask ? c.yellow : c.dim;
    const inner = W - 4;                                               // « │ » + contenu + « │ »
    const t = title ? ` ${title} ` : '';
    lines.push(edge('╭─') + t + edge('─'.repeat(Math.max(0, inner - strWidth(t))) + '╮'));
    const inputTop = lines.length;
    for (const l of body) lines.push(edge('│') + ' ' + padAnsi(l, inner) + edge('│'));   // même largeur que les coins ╭╮ ╰╯
    lines.push(edge('╰' + '─'.repeat(inner + 1) + '╯'));
    const caret = { row: inputTop + (this.search ? 0 : Math.max(0, lay.caret.row - start)), col: this.search ? 4 + strWidth(this.search.q) : 4 + lay.caret.col };

    // suggestions (sous le trait du bas)
    const N = Math.max(0, Math.min(7, maxRows - lines.length - 4));
    if (this.sug.items.length && !this.ask && !this.search && N > 0) {
      const items = this.sug.items;
      const first = Math.max(0, Math.min(this.sug.idx - (N - 1), items.length - N));
      const win = items.slice(first, first + N);
      const lw = Math.min(28, Math.max(...win.map(it => strWidth(it.label))));
      win.forEach((it, i) => {
        const sel = first + i === this.sug.idx;
        lines.push('  ' + (sel ? c.accent(c.bold(padAnsi(it.label, lw))) : padAnsi(it.label, lw)) + '  ' + c.dim((it.desc || '').slice(0, Math.max(0, W - lw - 8))));
      });
      if (items.length > N) lines.push('  ' + c.dim(`… ${items.length} résultats · ↑↓ naviguer · Tab compléter`));
    }

    // « ? » seul dans la saisie : aide des raccourcis (comme Claude Code)
    if (this.buf === '?' && !this.ask && !this.search) {
      const keys = [['/', 'commandes'], ['@', 'joindre un fichier'], ['!', 'commande shell directe'], ['#', 'retenir une info (mémoire)'],
        ['alt+v', 'coller une image'], ['maj+tab', 'changer de mode'], ['échap ×2', 'revenir en arrière (/rewind)'], ['ctrl+r', 'chercher dans l\'historique'],
        ['\\ + entrée', 'nouvelle ligne'], ['ctrl+o', 'déplier sorties et pensée'], ['ctrl+c', 'interrompre · ×2 quitter']];
      const half = Math.ceil(keys.length / 2), cw = Math.floor((W - 4) / 2);
      for (let i = 0; i < half; i++) {
        const cell = k => k ? padAnsi(`${c.accent(k[0].padEnd(11))}${c.dim(k[1])}`, cw) : '';
        lines.push('  ' + cell(keys[i]) + cell(keys[i + half]));
      }
    }

    // barre d'état : mode à gauche, contexte restant à droite
    const ml = MODE_LABEL[st.mode] || MODE_LABEL.auto;
    const base = (this.busy ? c.dim('échap : interrompre · ') : '') + c.accent(ml[0]) + c.dim(' (maj+tab)');
    const leftStatus = this.flashText ? c.yellow(this.flashText) : (W > 70 && !this.busy ? base + c.dim(' · ? pour les raccourcis') : base);
    const ctxLeft = st.ctx != null ? Math.max(0, 100 - Math.round(st.ctx)) : null;
    const rightStatus = ctxLeft == null ? '' : (ctxLeft < 25 ? c.yellow : c.dim)(`contexte restant : ${ctxLeft} %`);
    const sgap = W - 2 - strWidth(leftStatus) - strWidth(rightStatus) - 1;
    lines.push('  ' + leftStatus + (rightStatus && sgap > 1 ? ' '.repeat(sgap) + rightStatus : ''));

    return { lines, caret, hideCursor: false };
  }

  // ── édition ─────────────────────────────────────────────────────────────────
  prevIdx(i) { if (i <= 0) return 0; const lo = this.buf.charCodeAt(i - 1); return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? i - 2 : i - 1; }
  nextIdx(i) { if (i >= this.buf.length) return this.buf.length; const hi = this.buf.charCodeAt(i); return hi >= 0xd800 && hi <= 0xdbff ? Math.min(this.buf.length, i + 2) : i + 1; }
  lineStart() { return this.buf.lastIndexOf('\n', this.cur - 1) + 1; }
  lineEnd() { const e = this.buf.indexOf('\n', this.cur); return e < 0 ? this.buf.length : e; }
  wordLeft() { let i = this.cur; while (i > 0 && /\s/.test(this.buf[i - 1])) i--; while (i > 0 && !/\s/.test(this.buf[i - 1])) i--; return i; }
  wordRight() { let i = this.cur; const n = this.buf.length; while (i < n && /\s/.test(this.buf[i])) i++; while (i < n && !/\s/.test(this.buf[i])) i++; return i; }
  cutBetween(a, b) { if (a === b) return; this.buf = this.buf.slice(0, a) + this.buf.slice(b); this.cur = a; this.edited(); }
  insert(text) {
    if (!text) return;
    this.buf = this.buf.slice(0, this.cur) + text + this.buf.slice(this.cur);
    this.cur += text.length; this.histIdx = -1; this.edited();
  }
  edited() { this.updateSuggestions(); this.render(); }
  clearInput() { this.buf = ''; this.cur = 0; this.histIdx = -1; this.sug = { items: [], idx: -1, start: 0 }; this.render(); }
  layout() { return layoutInput(this.buf, this.cur, Math.max(10, this.screen.getCols() - 3)); }

  moveVert(dir) {
    const lay = this.layout();
    const row = lay.caret.row + dir;
    if (row < 0 || row >= lay.lines.length) return false;
    this.cur = indexAt(lay, row, lay.caret.col); this.render(); return true;
  }

  // ── suggestions ─────────────────────────────────────────────────────────────
  updateSuggestions() {
    if (this.ask || this.search || !this.suggester || this.sugOff === this.buf) { this.sug = { items: [], idx: -1, start: 0 }; return; }
    let r = null;
    try { r = this.suggester(this.buf, this.cur); } catch {}
    this.sug = r && r.items?.length ? { items: r.items.slice(0, 60), idx: -1, start: r.start } : { items: [], idx: -1, start: 0 };
  }
  acceptSuggestion() {
    const it = this.sug.items[this.sug.idx >= 0 ? this.sug.idx : 0];
    if (!it) return null;
    this.buf = this.buf.slice(0, this.sug.start) + it.insert + this.buf.slice(this.cur);
    this.cur = this.sug.start + it.insert.length;
    this.updateSuggestions(); this.render();
    return it;
  }

  // ── historique ──────────────────────────────────────────────────────────────
  pushHistory(t) {
    if (this.hist[this.hist.length - 1] !== t) { this.hist.push(t); this.onHistory?.(t); }
    if (this.hist.length > 1000) this.hist.shift();
  }
  histPrev() {
    if (!this.hist.length) return;
    if (this.histIdx === -1) { this.draft = this.buf; this.histIdx = this.hist.length - 1; } else if (this.histIdx > 0) this.histIdx--;
    this.buf = this.hist[this.histIdx]; this.cur = this.buf.length; this.updateSuggestions(); this.render();
  }
  histNext() {
    if (this.histIdx === -1) return;
    if (this.histIdx < this.hist.length - 1) { this.histIdx++; this.buf = this.hist[this.histIdx]; }
    else { this.histIdx = -1; this.buf = this.draft; }
    this.cur = this.buf.length; this.updateSuggestions(); this.render();
  }

  // ── touches ─────────────────────────────────────────────────────────────────
  onKey(k) {
    if (this.select_) return this.keySelect(k);
    if (this.search) return this.keySearch(k);
    return this.keyInput(k);
  }

  keySelect(k) {
    const s = this.select_;
    if (k.name === 'up' || (k.ctrl && k.name === 'p')) { s.idx = (s.idx + s.options.length - 1) % s.options.length; return this.render(); }
    if (k.name === 'down' || k.name === 'tab' || (k.ctrl && k.name === 'n')) { s.idx = (s.idx + 1) % s.options.length; return this.render(); }
    if (k.name === 'enter') return this.finishSelect(s.idx);
    if (k.name === 'escape') return this.finishSelect(null);
    if (k.ctrl && k.name === 'c') { this.finishSelect(null); this.emit('interrupt'); return; }
    if (k.name === 'text' && /^[1-9]$/.test(k.text) && +k.text <= s.options.length) return this.finishSelect(+k.text - 1);
  }

  keySearch(k) {
    const S = this.search;
    const find = (from) => { for (let i = from; i >= 0; i--) if (S.q && this.hist[i].toLowerCase().includes(S.q.toLowerCase())) { S.idx = i; S.match = this.hist[i]; return; } S.match = null; };
    if (k.name === 'text') { S.q += k.text; find(this.hist.length - 1); return this.render(); }
    if (k.name === 'backspace') { S.q = S.q.slice(0, -1); find(this.hist.length - 1); return this.render(); }
    if (k.ctrl && k.name === 'r') { find((S.idx ?? this.hist.length) - 1); return this.render(); }
    if (k.name === 'enter' || k.name === 'tab') { if (S.match) { this.buf = S.match; this.cur = this.buf.length; } this.search = null; return this.edited(); }
    if (k.name === 'escape' || (k.ctrl && (k.name === 'c' || k.name === 'g'))) { this.search = null; return this.render(); }
  }

  keyInput(k) {
    if (k.ctrl) {
      switch (k.name) {
        case 'a': this.cur = this.lineStart(); return this.render();
        case 'e': this.cur = this.lineEnd(); return this.render();
        case 'b': this.cur = this.prevIdx(this.cur); return this.render();
        case 'f': this.cur = this.nextIdx(this.cur); return this.render();
        case 'k': { const e = this.lineEnd(); return this.cutBetween(this.cur, e === this.cur && e < this.buf.length ? e + 1 : e); }
        case 'u': return this.cutBetween(this.lineStart(), this.cur);
        case 'w': return this.cutBetween(this.wordLeft(), this.cur);
        case 'c': return this.ctrlC();
        case 'd': return this.ctrlD();
        case 'v': if (!this.ask) this.emit('pasteImage'); return;
        case 'o': if (!this.ask) this.emit('expand'); return;           // Ctrl+O : déplier les sorties résumées et la pensée (comme Claude Code)     // Ctrl+V qui arrive jusqu'ici = le terminal n'a pas collé de texte (image)
        case 'l': return this.screen.clearScreen();
        case 'r': if (this.ask) return; this.search = { q: '', idx: null, match: null }; return this.render();
        case 'p': return this.up();
        case 'n': return this.down();
        case 'newline': break;
        default: if (k.name !== 'left' && k.name !== 'right' && k.name !== 'backspace' && k.name !== 'delete' && k.name !== 'newline') return;
      }
    }
    switch (k.name) {
      case 'text': case 'paste':
        if (k.name === 'paste' && !k.text) { if (!this.ask) this.emit('pasteImage'); return; }   // collage vide = Ctrl+V avec une image (Windows Terminal ne colle que du texte)
        if (k.meta && k.name === 'text') return this.keyMeta(k); return this.insert(k.text);
      case 'enter': return this.enter();
      case 'newline': return this.insert('\n');
      case 'tab': return this.tab();
      case 'shift-tab': return this.emit('cycleMode');
      case 'escape': return this.escape();
      case 'backspace': return k.meta ? this.cutBetween(this.wordLeft(), this.cur) : this.cutBetween(this.prevIdx(this.cur), this.cur);
      case 'delete': return this.cutBetween(this.cur, this.nextIdx(this.cur));
      case 'left': this.cur = (k.ctrl || k.meta) ? this.wordLeft() : this.prevIdx(this.cur); return this.render();
      case 'right': this.cur = (k.ctrl || k.meta) ? this.wordRight() : this.nextIdx(this.cur); return this.render();
      case 'up': return this.up();
      case 'down': return this.down();
      case 'home': this.cur = this.lineStart(); return this.render();
      case 'end': this.cur = this.lineEnd(); return this.render();
      default: if (k.meta) return this.keyMeta(k);
    }
  }

  keyMeta(k) {
    switch (k.name) {
      case 'b': this.cur = this.wordLeft(); return this.render();
      case 'f': this.cur = this.wordRight(); return this.render();
      case 'd': return this.cutBetween(this.cur, this.wordRight());
      case 'v': if (!this.ask) this.emit('pasteImage'); return;       // Alt+V : coller une image (comme Claude Code sous Windows)
    }
  }

  up() {
    if (this.sug.items.length) { this.sug.idx = this.sug.idx <= 0 ? this.sug.items.length - 1 : this.sug.idx - 1; return this.render(); }
    if (!this.moveVert(-1) && !this.ask) this.histPrev();
  }
  down() {
    if (this.sug.items.length) { this.sug.idx = this.sug.idx >= this.sug.items.length - 1 ? 0 : this.sug.idx + 1; return this.render(); }
    if (!this.moveVert(1) && !this.ask) this.histNext();
  }
  tab() {
    if (this.ask) return;
    if (this.sug.items.length) this.acceptSuggestion();
  }
  escape() {
    // Échap deux fois, saisie vide et rien en cours : revenir en arrière (comme Claude Code)
    const now = Date.now();
    if (!this.busy && !this.ask && !this.buf && !this.sug.items.length && now - this.lastEsc < 600) { this.lastEsc = 0; return this.emit('rewind'); }
    this.lastEsc = now;
    if (this.sug.items.length) { this.sugOff = this.buf; this.sug = { items: [], idx: -1, start: 0 }; return this.render(); }
    if (this.ask) return this.finishAsk(null);
    if (this.busy) return this.emit('interrupt');
    if (this.buf) this.clearInput();
  }
  ctrlC() {
    if (this.ask) { this.finishAsk(null); this.emit('interrupt'); return; }
    if (this.busy) return this.emit('interrupt');
    if (this.buf) return this.clearInput();
    const now = Date.now();
    if (now - this.lastCtrlC < 1500) return this.emit('quit');
    this.lastCtrlC = now; this.flash('Ctrl+C encore pour quitter');
  }
  ctrlD() {
    if (!this.buf && !this.busy && !this.ask) return this.emit('quit');
    this.cutBetween(this.cur, this.nextIdx(this.cur));
  }

  enter() {
    if (this.sug.items.length && this.sug.idx >= 0) {
      const it = this.acceptSuggestion();
      if (it && /^\/\S*$/.test(this.buf.trim()) && !it.keepOpen && !/\s$/.test(it.insert)) this.submit();
      return;
    }
    if (this.ask) { const v = this.buf; return this.finishAsk(v); }
    if (this.cur === this.buf.length && this.buf.endsWith('\\')) { this.buf = this.buf.slice(0, -1) + '\n'; this.cur = this.buf.length; return this.edited(); }
    this.submit();
  }

  submit() {
    const text = this.buf.trim();
    if (!text) return;
    this.pushHistory(text);
    this.buf = ''; this.cur = 0; this.histIdx = -1; this.sug = { items: [], idx: -1, start: 0 }; this.sugOff = null;
    if (this.busy) { this.queue.push(text); this.flash('message mis en file d\'attente'); return; }
    this.echo(text);
    this.tipIdx++;
    this.render();
    this.emit('submit', text);
  }
}
