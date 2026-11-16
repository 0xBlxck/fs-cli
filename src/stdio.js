// Mode « machine » (fs-cli --stdio) : utilisé par l'extension VS Code.
// Sortie : un événement JSON par ligne, précédé du caractère \x1e (séparateur d'enregistrement) — toute autre ligne est ignorée par l'extension.
// Entrée : un message JSON par ligne ({ type: 'submit', text } · { type: 'select', id, index } · { type: 'ask', id, text } · { type: 'interrupt' } …).
import readline from 'node:readline';

const RS = '\x1e';
export function send(type, data = {}) {
  try { process.stdout.write(RS + JSON.stringify({ type, ...data }) + '\n'); } catch {}
}

export class StdioInput {
  constructor() {
    this.kind = 'stdio';
    this.handlers = { instant: [], submit: [], interrupt: [], quit: [], cycleMode: [], pasteImage: [], rewind: [], expand: [], setMode: [], setModel: [], diffBefore: [], undoFile: [], mcpAction: [], historyOpen: [], resumeChat: [], projectUse: [], folderPicked: [], skillsOpen: [], skillToggle: [] };
    this.queue = []; this.busy = false; this.pending = new Map(); this.seq = 0;
    this.rl = readline.createInterface({ input: process.stdin, terminal: false });
    this.rl.on('line', line => this.onLine(line));
    this.rl.on('close', () => this.emit('quit'));
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.handlers[ev] || []) fn(...a); }

  onLine(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'submit': {
        const text = String(m.text ?? '').slice(0, 200_000);
        if (!text.trim()) return;
        if (this.busy && /^\s*\/usage\s*$/i.test(text)) { this.emit('instant', text.trim()); return; }   // s'affiche dans une fenêtre : tout de suite, même pendant une réponse
        if (this.busy) { this.queue.push(text); send('queued', { text }); return; }
        this.emit('submit', text); return;
      }
      case 'select': case 'ask': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        p(m.type === 'select' ? (Number.isInteger(m.index) && m.index >= 0 ? m.index : null) : String(m.text ?? ''));
        return;
      }
      case 'interrupt': return this.emit('interrupt');
      case 'cycleMode': return this.emit('cycleMode');
      case 'setMode': return this.emit('setMode', String(m.mode || ''));
      case 'setModel': return this.emit('setModel', String(m.id ?? ''));
      case 'expand': return this.emit('expand');
      case 'diffBefore': return this.emit('diffBefore', m.id, String(m.path || ''));
      case 'undoFile': return this.emit('undoFile', String(m.path || ''));
      case 'mcpAction': return this.emit('mcpAction', String(m.action || ''), String(m.name || ''));
      case 'historyOpen': return this.emit('historyOpen');
      case 'skillsOpen': return this.emit('skillsOpen');
      case 'skillToggle': return this.emit('skillToggle', String(m.kind || ''), String(m.name || ''));
      case 'resumeChat': return this.emit('resumeChat', String(m.chatId || ''));
      case 'projectUse': return this.emit('projectUse', String(m.id || ''));
      case 'folderPicked': return this.emit('folderPicked', String(m.purpose || ''), String(m.path || ''));
      case 'quit': return this.emit('quit');
    }
  }

  // ── interface attendue par cli.js ──
  start() {}
  stop() { try { this.rl.close(); } catch {} }
  setStatus(st) { send('status', st); }
  setTasks(list) { send('tasks', { list }); }
  setBusy(b) { this.busy = !!b; send('busy', { busy: this.busy }); }
  setPrompt() {}
  prompt() {}
  takeQueued() { return this.queue.shift() || null; }
  clearScreen() { send('clear'); }
  print(t) { send('print', { text: String(t) }); }
  spinner(s) { send('spinner', { text: s }); }
  flash(text) { send('flash', { text }); }
  insert(text) { send('insert', { text }); }
  echo() {}
  event(type, data) { send(type, data); }
  select({ title, detail = '', options, defaultIndex = 0, proposal = null }) {
    const id = ++this.seq;
    const plain = s => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    // proposal : modification de fichier proposée → l'extension ouvre le diff natif (avant ↔ proposé) ; ignoré par les anciens panneaux
    const extra = proposal && typeof proposal.path === 'string' && typeof proposal.after === 'string'
      ? { proposal: { path: proposal.path, before: String(proposal.before ?? ''), after: proposal.after, created: !!proposal.created } } : {};
    send('select', { id, title: plain(title), detail: plain(detail), options: (options || []).map(plain), defaultIndex, ...extra });
    return new Promise(resolve => this.pending.set(id, resolve));
  }
  askLine(label) {
    const id = ++this.seq;
    send('ask', { id, label: String(label).replace(/\x1b\[[0-9;]*m/g, '').trim() });
    return new Promise(resolve => this.pending.set(id, resolve));
  }
}
