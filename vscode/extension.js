// Extension VS Code de FS-CLI : un panneau de chat branché sur « fs-cli --stdio ».
// Le CLI fait tout le travail (modèle, outils, garde-fous, confirmations) ; l'extension affiche et transmet.
// Aucune clé n'est lue ni stockée ici : FS-CLI garde la sienne dans ~/.fs-cli.
'use strict';
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RS = '\x1e';
const MAX_SELECTION = 20000;
const beforeDocs = new Map();             // contenus « avant » pour le diff natif (schéma fs-cli-before:)
let cliPathCache;

/** Où est FS-CLI ? réglage → installation globale npm (lancée avec node) → « fs-cli » du PATH */
function resolveCli() {
  const custom = vscode.workspace.getConfiguration('fsCli').get('command');
  if (custom && custom.trim()) return { cmd: custom.trim(), args: ['--stdio'], shell: true };
  if (cliPathCache === undefined) {
    cliPathCache = null;
    try {
      const root = cp.execSync('npm root -g', { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true }).trim();
      const js = path.join(root, 'fs-cli', 'cli.js');
      if (fs.existsSync(js)) cliPathCache = js;
    } catch {}
  }
  if (cliPathCache) return { cmd: 'node', args: [cliPathCache, '--stdio'], shell: false };
  return { cmd: 'fs-cli', args: ['--stdio'], shell: true };
}

function workspaceDir() {
  const ed = currentEditor();
  if (ed && ed.document.uri.scheme === 'file') {
    const wf = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    if (wf) return wf.uri.fsPath;
  }
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : os.homedir();
}

/** Fichier ouvert + sélection, pour le joindre au message (comme l'extension Claude Code). */
let lastEditor = null;                     // dernier éditeur de fichier (le panneau en onglet le rend « inactif »)
function currentEditor() {
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') { lastEditor = ed; return ed; }
  if (lastEditor && vscode.window.visibleTextEditors.includes(lastEditor)) return lastEditor;
  return vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file') || null;
}
function editorContext() {
  const ed = currentEditor();
  if (!ed || ed.document.uri.scheme !== 'file') return null;
  const file = ed.document.uri.fsPath;
  const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
  const sel = ed.selection;
  if (sel && !sel.isEmpty) {
    const text = ed.document.getText(sel);
    return { file, rel, start: sel.start.line + 1, end: sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1), lines: text.split('\n').length, text: text.slice(0, MAX_SELECTION), lang: ed.document.languageId };
  }
  return { file, rel };
}

function contextPrefix(ctx) {
  if (!ctx) return '';
  if (ctx.text) {
    const fence = ctx.text.includes('```') ? '~~~~' : '```';
    return `[Contexte VS Code : dans ${ctx.rel}, lignes ${ctx.start}-${ctx.end} sélectionnées par l'utilisateur]\n${fence}${ctx.lang || ''}\n${ctx.text}\n${fence}\n\n`;
  }
  return `[Contexte VS Code : fichier ouvert dans l'éditeur : ${ctx.rel}]\n\n`;
}

/** Une conversation = un panneau + un processus fs-cli --stdio */
class Chat {
  constructor(context, webview, onTitle) {
    this.context = context; this.webview = webview; this.onTitle = onTitle;
    this.proc = null; this.buf = ''; this.pendingDiff = new Map(); this.useContext = vscode.workspace.getConfiguration('fsCli').get('shareSelection') !== false;
    this.disposables = [];
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    webview.html = this.html();
    this.disposables.push(webview.onDidReceiveMessage(m => this.fromPanel(m)));
    const push = () => this.post({ type: 'context', ctx: this.summary(editorContext()), enabled: this.useContext });
    this.disposables.push(vscode.window.onDidChangeTextEditorSelection(push), vscode.window.onDidChangeActiveTextEditor(push));
    this.pushContext = push;
  }

  summary(ctx) { return ctx ? { rel: ctx.rel, start: ctx.start, end: ctx.end, lines: ctx.lines } : null; }
  post(m) { try { this.webview.postMessage(m); } catch {} }

  start() {
    if (this.proc) return;
    const { cmd, args, shell } = resolveCli();
    const env = { ...process.env, FORCE_COLOR: '3' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    let p;
    try { p = cp.spawn(cmd, args, { cwd: workspaceDir(), env, shell, windowsHide: true }); }
    catch (e) { this.post({ type: 'exit', code: -1, message: `Impossible de lancer FS-CLI : ${e.message}` }); return; }
    this.proc = p; this.buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => this.onData(d));
    p.stderr.setEncoding('utf8');
    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    p.on('error', e => { this.post({ type: 'exit', code: -1, message: /ENOENT/.test(e.message) ? 'FS-CLI introuvable. Installe-le : npm install -g github:0xBlxck/fs-cli' : e.message }); });
    p.on('exit', code => {
      if (this.proc !== p) return;
      this.proc = null;
      this.post({ type: 'exit', code, needLogin: code === 2, message: code && code !== 2 ? errTail.trim().split('\n').slice(-4).join('\n') : '' });
    });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      const k = line.indexOf(RS);
      if (k < 0) continue;                                         // tout ce qui n'est pas un événement est ignoré
      let ev; try { ev = JSON.parse(line.slice(k + 1)); } catch { continue; }
      if (ev.type === 'diffBefore') { const r = this.pendingDiff.get(ev.id); if (r) { this.pendingDiff.delete(ev.id); r(ev); } continue; }
      if (ev.type === 'status') { if (ev.title !== undefined) this.onTitle?.(ev.title); if (ev.cwd) this.cwd = ev.cwd; }
      this.post({ type: 'event', ev });
    }
  }

  toCli(m) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(m) + '\n'); }

  async fromPanel(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready': this.start(); this.pushContext(); return;
      case 'send': {
        const text = String(m.text || '');
        if (!text.trim()) return;
        const ctx = this.useContext && !text.trim().startsWith('/') && !text.trim().startsWith('!') ? editorContext() : null;
        this.toCli({ type: 'submit', text: contextPrefix(ctx) + text });
        return;
      }
      case 'select': return this.toCli({ type: 'select', id: m.id, index: m.index });
      case 'ask': return this.toCli({ type: 'ask', id: m.id, text: String(m.text ?? '') });
      case 'interrupt': return this.toCli({ type: 'interrupt' });
      case 'setMode': return this.toCli({ type: 'setMode', mode: String(m.mode) });
      case 'setModel': return this.toCli({ type: 'setModel', id: String(m.id) });
      case 'undoFile': return this.toCli({ type: 'undoFile', path: String(m.path) });
      case 'toggleContext': this.useContext = !this.useContext; this.pushContext(); return;
      case 'restart': this.stop(); this.start(); return;
      case 'login': return vscode.commands.executeCommand('fsCli.login');
      case 'openFile': return this.openFile(String(m.path || ''), m.line);
      case 'openDiff': return this.openDiff(String(m.path || ''));
      case 'openLink': {
        const u = String(m.url || '');
        if (/^https?:\/\//i.test(u)) vscode.env.openExternal(vscode.Uri.parse(u));
        return;
      }
      case 'copy': return vscode.env.clipboard.writeText(String(m.text || ''));
      case 'pickFiles': {
        const r = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Joindre', defaultUri: vscode.Uri.file(workspaceDir()) });
        if (r && r.length) this.post({ type: 'insert', text: r.map(u => '@' + (u.fsPath.includes(' ') ? `"${u.fsPath}"` : u.fsPath)).join(' ') + ' ' });
        return;
      }
      case 'pasteImage': {                                         // image collée dans le panneau → fichier temporaire → chemin dans le message (FS-CLI l'envoie au modèle)
        const ext = /png|jpe?g|gif|webp/i.exec(String(m.mime || ''))?.[0]?.replace('jpeg', 'jpg') || 'png';
        const data = String(m.data || '');
        if (!data || data.length > 14_000_000) return;
        const dir = path.join(os.tmpdir(), 'fs-cli-images');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `collage-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        this.post({ type: 'insert', text: `"${file}" ` });
        return;
      }
    }
  }

  abs(p) { return !p ? '' : path.isAbsolute(p) ? path.normalize(p) : path.join(this.cwd || workspaceDir(), p); }

  async openFile(p, line) {
    if (!p) return;
    const full = this.abs(p);
    if (!fs.existsSync(full)) return;
    const doc = await vscode.workspace.openTextDocument(full);
    const ed = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    if (line > 0) { const pos = new vscode.Position(line - 1, 0); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter); }
  }

  /** diff natif de VS Code : contenu d'avant (donné par le CLI, seulement pour un fichier qu'il a modifié) ↔ fichier actuel */
  async openDiff(p) {
    p = this.abs(p);
    if (!p || !this.proc) return this.openFile(p);
    const id = crypto.randomBytes(6).toString('hex');
    const ev = await new Promise(res => { this.pendingDiff.set(id, res); this.toCli({ type: 'diffBefore', id, path: p }); setTimeout(() => { if (this.pendingDiff.delete(id)) res(null); }, 5000); });
    if (!ev || !ev.ok) return this.openFile(p);
    const name = path.basename(p);
    const left = vscode.Uri.from({ scheme: 'fs-cli-before', path: `/${id}/${name}` });
    beforeDocs.set(left.toString(), ev.before);
    if (beforeDocs.size > 50) beforeDocs.delete(beforeDocs.keys().next().value);
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(p), `${name} (${ev.created ? 'créé' : 'avant'} ↔ maintenant)`, { viewColumn: vscode.ViewColumn.One });
  }

  insertSelection() {
    const ctx = editorContext();
    if (!ctx || !ctx.text) return;
    this.useContext = true; this.pushContext();
    this.post({ type: 'focusInput' });
  }

  stop() {
    const p = this.proc; this.proc = null;
    if (!p) return;
    try { p.stdin.write('{"type":"quit"}\n'); } catch {}
    setTimeout(() => { try { p.kill(); } catch {} }, 3000);
  }

  dispose() { this.stop(); for (const d of this.disposables) try { d.dispose(); } catch {} }

  html() {
    const w = this.webview, media = f => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('panel.css')}">
<title>FS-CLI</title></head>
<body data-logo="${media('logo.png')}"><div id="app"></div><script nonce="${nonce}" src="${media('panel.js')}"></script></body></html>`;
  }
}

class SidebarProvider {
  constructor(context) { this.context = context; this.chat = null; }
  resolveWebviewView(view) {
    this.view = view;
    this.chat?.dispose();
    this.chat = new Chat(this.context, view.webview);
    view.onDidDispose(() => { this.chat?.dispose(); this.chat = null; });
  }
}

function activate(context) {
  const sidebar = new SidebarProvider(context);
  const tabs = new Set();
  let lastActive = null;                                            // dernier panneau utilisé (pour « Demander à FS-CLI »)

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('fs-cli-before', { provideTextDocumentContent: uri => beforeDocs.get(uri.toString()) ?? '' }),
    vscode.window.registerWebviewViewProvider('fsCli.chat', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('fsCli.open', () => {
      const panel = vscode.window.createWebviewPanel('fsCli.tab', 'FS-CLI', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
      const chat = new Chat(context, panel.webview, t => { panel.title = t ? `FS-CLI · ${t.slice(0, 30)}` : 'FS-CLI'; });
      tabs.add(chat); lastActive = chat;
      panel.onDidChangeViewState(e => { if (e.webviewPanel.active) lastActive = chat; });
      panel.onDidDispose(() => { chat.dispose(); tabs.delete(chat); if (lastActive === chat) lastActive = null; });
    }),
    vscode.commands.registerCommand('fsCli.focus', () => vscode.commands.executeCommand('fsCli.chat.focus')),
    vscode.commands.registerCommand('fsCli.newChat', () => { const c = lastActive || sidebar.chat; if (c) c.toCli({ type: 'submit', text: '/new' }); else vscode.commands.executeCommand('fsCli.chat.focus'); }),
    vscode.commands.registerCommand('fsCli.askSelection', async () => {
      let c = lastActive || sidebar.chat;
      if (!c) { await vscode.commands.executeCommand('fsCli.chat.focus'); c = sidebar.chat; }
      c?.insertSelection();
    }),
    vscode.commands.registerCommand('fsCli.login', () => {
      const t = vscode.window.createTerminal({ name: 'FS-CLI : connexion' });
      t.show(); t.sendText('fs-cli --login');
      vscode.window.showInformationMessage('Colle ta clé de session dans le terminal, puis clique sur « Relancer » dans le panneau FS-CLI.');
    }),
    { dispose: () => { sidebar.chat?.dispose(); for (const c of tabs) c.dispose(); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
