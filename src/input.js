// Entrée utilisateur : interface plein écran (terminal interactif) ou readline (pipe, -p, --classic).
// Les deux exposent la même API : on('submit'|'interrupt'|'quit'|'cycleMode'), setStatus, setBusy, askLine, takeQueued, print, spinner…
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { Tui } from './tui/tui.js';
import * as ui from './ui.js';
import { c, println } from './ui.js';

class ReadlineInput {
  constructor({ history = [], onHistory = null, completer = null, promptStr = () => '❯ ' }) {
    this.kind = 'readline'; this.onHistory = onHistory; this.promptStr = promptStr;
    this.handlers = { submit: [], interrupt: [], quit: [], cycleMode: [], pasteImage: [], rewind: [], expand: [] };
    this.busy = false; this.pasteBuf = []; this.pasteTimer = null; this.inBlock = false; this.currentAsk = null; this.lastSigint = 0;
    this.rl = readline.createInterface({
      input: process.stdin.isTTY ? process.stdin : new PassThrough(),
      output: process.stdout, historySize: 500, completer, terminal: !!process.stdin.isTTY,
    });
    if (history.length) this.rl.history = history.slice(-500).reverse();
    this.rl.on('line', raw => this.onLine(raw));
    this.rl.on('SIGINT', () => this.onSigint());
    this.rl.on('close', () => this.emit('quit'));
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }   // événement inconnu de cette interface (ex. « instant », propre au panneau) : accepté sans planter
  emit(ev, ...a) { for (const fn of this.handlers[ev]) fn(...a); }
  start() {}
  stop() { try { this.rl.close(); } catch {} }
  setStatus() {}
  setTasks() {}
  setBusy(b) { this.busy = !!b; }
  setPrompt(s) { this.rl.setPrompt(s); }
  prompt() { this.rl.prompt(); }
  takeQueued() { return null; }
  clearScreen() { process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); }
  print(t) { process.stdout.write(t); }
  spinner() {}
  flash() {}

  askLine(query) {
    return new Promise(resolve => {
      if (!process.stdin.isTTY) return resolve(null);
      const ac = new AbortController();
      this.currentAsk = ac;
      ac.signal.addEventListener('abort', () => { this.currentAsk = null; resolve(null); }, { once: true });
      this.rl.question(query, { signal: ac.signal }, ans => { this.currentAsk = null; resolve(ans); });
    });
  }

  dispatch(text) {
    if (!text.includes('\n')) this.onHistory?.(text.trim());
    this.emit('submit', text);
  }

  onLine(raw) {
    if (this.busy) return;
    if (raw.trim() === '"""') {                                   // bloc multi-ligne entre deux """
      clearTimeout(this.pasteTimer);
      if (!this.inBlock) { this.inBlock = true; this.pasteBuf = []; this.rl.setPrompt(c.dim('  ┆ ')); this.rl.prompt(); return; }
      this.inBlock = false;
      const text = this.pasteBuf.join('\n'); this.pasteBuf = []; this.rl.setPrompt(this.promptStr()); this.dispatch(text); return;
    }
    if (this.inBlock) { this.pasteBuf.push(raw); this.rl.prompt(); return; }
    if (raw.endsWith('\\') && !raw.endsWith('\\\\')) {            // continuation de ligne
      this.pasteBuf.push(raw.slice(0, -1)); clearTimeout(this.pasteTimer);
      this.rl.setPrompt(c.dim('  … ')); this.rl.prompt(); return;
    }
    this.pasteBuf.push(raw);
    clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {                          // regroupe les collages multi-lignes
      const text = this.pasteBuf.join('\n'); this.pasteBuf = [];
      this.rl.setPrompt(this.promptStr());
      this.dispatch(text);
    }, 40);
  }

  onSigint() {
    if (this.currentAsk) { this.currentAsk.abort(); this.emit('interrupt'); return; }
    if (this.busy) { this.emit('interrupt'); return; }
    if (this.pasteBuf.length) { this.pasteBuf = []; this.rl.setPrompt(this.promptStr()); println(c.dim('\n  (saisie annulée)')); return this.rl.prompt(); }
    const now = Date.now();
    if (now - this.lastSigint < 1500) return this.emit('quit');
    this.lastSigint = now;
    println(c.dim('\n  Ctrl+C encore pour quitter (ou /quit)'));
    this.rl.prompt();
  }
}

class TuiInput extends Tui {
  constructor(o) { super({ history: o.history, onHistory: o.onHistory, suggester: o.suggester }); this.kind = 'tui'; }
  setPrompt() {}
  prompt() {}
}

export function createInput({ interactive, history, onHistory, suggester, completer, promptStr }) {
  return interactive
    ? new TuiInput({ history, onHistory, suggester })
    : new ReadlineInput({ history, onHistory, completer, promptStr });
}

/** branche le texte et le spinner du CLI sur la zone d'affichage de l'interface */
export function attachScreen(input) {
  ui.attachSink({ print: t => input.print(t), spinner: s => input.spinner(s), setActive: l => input.setActive?.(l), ...(input.event ? { event: (type, data) => input.event(type, data) } : {}) });
}
