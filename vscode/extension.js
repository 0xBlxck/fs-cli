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
const proposalDocs = new Map();           // contenus PROPOSÉS par l'agent, en attente d'accord (schéma fs-cli-proposal:)
const proposalOwners = new Map();         // uri du côté proposé → { chat, id } : boutons Accepter / Refuser de la barre du diff
let cliPathCache;                          // Windows : chemin de cli.js ; Mac/Linux : { node, js, pathDirs } (null = introuvable)
let loginInfoCache;                        // Mac/Linux : ce que voit le shell de connexion (PATH, node, fs-cli, préfixe npm)
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const INSTALL_CMD = 'npm install -g github:0xBlxck/fs-cli';

function npmRootGlobal() {
  try { return cp.execSync('npm root -g', { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true }).trim(); } catch { return ''; }
}

/** Mac/Linux : sortie du shell de connexion → { path, node, fsCli, prefix } (le bruit du .zshrc est ignoré) */
function parseLoginOutput(out) {
  const get = k => ((String(out || '').match(new RegExp('^__' + k + '__(.*)$', 'm')) || [])[1] || '').trim();
  return { path: get('FSP'), node: get('FSN'), fsCli: get('FSC'), prefix: get('FSG') };
}

/** Mac/Linux : une appli lancée depuis le Dock n'a pas le PATH du terminal ; on le demande au shell de connexion (-il : lit .zprofile et .zshrc) */
function loginShellInfo(env = process.env) {
  const base = path.posix.basename(String(env.SHELL || ''));
  const sh = /^(zsh|bash|sh|ksh|dash)$/.test(base) && path.posix.isAbsolute(env.SHELL) ? env.SHELL : (IS_MAC ? '/bin/zsh' : '/bin/sh');
  const script = 'printf "\\n__FSP__%s\\n" "$PATH"; printf "__FSN__%s\\n" "$(command -v node)"; printf "__FSC__%s\\n" "$(command -v fs-cli)"; printf "__FSG__%s\\n" "$(npm prefix -g 2>/dev/null)"';
  const shEnv = { ...env }; delete shEnv.ELECTRON_RUN_AS_NODE;
  return new Promise(res => {
    try {
      cp.execFile(sh, ['-ilc', script], { encoding: 'utf8', timeout: 10000, env: shEnv }, (err, out) => res(parseLoginOutput(out)));
    } catch { res({}); }
  });
}

/** Mac/Linux : dossiers usuels de node / fs-cli, ajoutés au PATH du CLI (et de la commande personnalisée) */
function knownBinDirs(home = os.homedir(), exists = fs.existsSync) {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.posix.join(home, '.volta/bin'), path.posix.join(home, '.local/bin'), path.posix.join(home, '.npm-global/bin')].filter(d => { try { return exists(d); } catch { return false; } });
}

/** versions nvm installées, la plus récente d'abord */
function nvmVersions(home, env, readdir) {
  const dir = path.posix.join(env.NVM_DIR || path.posix.join(home, '.nvm'), 'versions', 'node');
  let list = [];
  try { list = readdir(dir).filter(v => /^v\d+/.test(v)); } catch {}
  const num = v => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  list.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return list.map(v => path.posix.join(dir, v));
}

/**
 * Mac/Linux : trouve node et cli.js de FS-CLI sans compter sur le PATH de l'éditeur.
 * Tout l'accès disque est injectable (tests). Renvoie { node, js, pathDirs } ou { missing: { node, cli } }.
 */
function locateCli({ home = os.homedir(), env = process.env, npmRoot = '', login = null, exists = fs.existsSync, realpath = fs.realpathSync, readdir = fs.readdirSync } = {}) {
  const P = path.posix, L = login || {};
  const isFile = f => { try { return !!f && exists(f); } catch { return false; } };
  const onPath = (name, PATH) => { for (const d of String(PATH || '').split(':')) if (d && P.isAbsolute(d) && isFile(P.join(d, name))) return P.join(d, name); return ''; };
  const nvm = nvmVersions(home, env, readdir);
  const envNode = onPath('node', env.PATH), envFs = onPath('fs-cli', env.PATH);
  const loginNode = L.node && P.isAbsolute(L.node) ? L.node : '', loginFs = L.fsCli && P.isAbsolute(L.fsCli) ? L.fsCli : '';
  const up = (f, n) => { for (let i = 0; i < n; i++) f = P.dirname(f); return f; };
  // cli.js : lien « fs-cli » résolu, puis npm root -g, puis préfixes npm connus
  const viaBin = [envFs, loginFs, onPath('fs-cli', L.path), ...['/opt/homebrew/bin', '/usr/local/bin', P.join(home, '.local/bin'), P.join(home, '.npm-global/bin'), P.join(home, '.npm-packages/bin'), ...nvm.map(v => P.join(v, 'bin'))].map(d => P.join(d, 'fs-cli'))]
    .filter(isFile).map(b => { try { return realpath(b); } catch { return ''; } }).filter(f => /[\\/]cli\.js$/.test(f));
  const prefixes = [L.prefix, env.NPM_CONFIG_PREFIX || env.npm_config_prefix, envNode && up(envNode, 2), loginNode && up(loginNode, 2), '/opt/homebrew', '/usr/local', P.join(home, '.local'), P.join(home, '.npm-global'), P.join(home, '.npm-packages'), ...nvm, '/usr'].filter(Boolean);
  const jsList = [...viaBin, npmRoot && P.join(npmRoot, 'fs-cli', 'cli.js'), ...prefixes.map(p => P.join(p, 'lib/node_modules/fs-cli/cli.js')), P.join(home, '.volta/tools/image/packages/fs-cli/lib/node_modules/fs-cli/cli.js')];
  const js = jsList.find(isFile) || '';
  // node : celui du même préfixe que cli.js d'abord (nvm), puis PATH, shell de connexion, emplacements connus
  const nodeList = [js && P.join(up(js, 4), 'bin/node'), envNode, loginNode, '/opt/homebrew/bin/node', '/usr/local/bin/node', P.join(home, '.volta/bin/node'), ...nvm.map(v => P.join(v, 'bin/node')),
    P.join(home, '.local/share/fnm/aliases/default/bin/node'), P.join(home, 'Library/Application Support/fnm/aliases/default/bin/node'), P.join(home, '.asdf/shims/node'), P.join(home, '.local/bin/node'), '/usr/bin/node'];
  const node = nodeList.find(isFile) || '';
  if (!node || !js) return { missing: { node: !node, cli: !js } };
  const pathDirs = [...new Set([P.dirname(node), ...String(L.path || '').split(':')].filter(d => d && P.isAbsolute(d)))];
  return { node, js, pathDirs };
}

/** Message clair quand l'éditeur ne trouve pas FS-CLI ou Node.js (au lieu d'un « code 127 » et d'un Relancer inutile) */
function notFoundMessage(missing = {}, mac = IS_MAC) {
  const what = missing.node && !missing.cli ? 'Node.js introuvable pour l\'éditeur.' : missing.cli && !missing.node ? 'FS-CLI introuvable pour l\'éditeur.' : 'FS-CLI ou Node.js introuvable pour l\'éditeur.';
  const tip = mac
    ? 'Sur Mac, une appli ouverte depuis le Dock ne voit pas toujours le PATH du Terminal (Homebrew, nvm, Volta…). Si « fs-cli » marche dans le Terminal : quitte l\'éditeur avec Cmd+Q (fermer la fenêtre ne suffit pas) puis rouvre-le. Sinon, installe FS-CLI ou mets le chemin complet dans le réglage fsCli.command (ex. : /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/fs-cli/cli.js).'
    : `Installe-le (${INSTALL_CMD}) ou mets le chemin complet dans le réglage fsCli.command, puis clique sur « Réessayer ».`;
  return what + '\n' + tip;
}

/** sortie du shell « commande introuvable » : Mac/Linux (code 127, « command not found », « env: node: No such file ») ;
 *  Windows : cmd.exe répond code 1 (ou 9009) « … n'est pas reconnu en tant que commande interne ou externe » (texte en page de code OEM, lu de travers) */
function isNotFoundExit(code, errTail, win = IS_WIN) {
  const t = String(errTail || '');
  if (win) return code === 9009 || (code === 1 && /n.{1,3}est pas reconnu en tant que commande|is not recognized as an internal or external command/i.test(t));
  return code === 127 || /command not found|not found: (node|fs-cli)|env: '?node'?: No such file or directory/i.test(t);
}

/** message « introuvable » pour une sortie du CLI (null si ce n'est pas ce cas) */
function notFoundExitMessage(code, errTail, { win = IS_WIN, mac = IS_MAC, custom = false, cmd = '' } = {}) {
  if (!isNotFoundExit(code, errTail, win)) return null;
  // Windows : le texte de cmd.exe est illisible (accents mal décodés) → message clair seul, avec la commande du réglage fsCli.command si c'est elle
  if (win) {
    // le raccourci fs-cli.cmd existe mais « node » est introuvable : c'est Node.js qu'il faut installer, pas FS-CLI
    if (/['"]node(\.exe)?['"]/i.test(String(errTail || ''))) return 'Node.js introuvable pour l\'éditeur.\nInstalle Node.js (nodejs.org), redémarre l\'éditeur puis clique sur « Réessayer ».' + (custom ? `\nCommande du réglage fsCli.command : ${cmd}` : '');
    return notFoundMessage({ cli: true }, false) + (custom ? `\nCommande du réglage fsCli.command introuvable : ${cmd}` : '');
  }
  const tail = String(errTail || '').trim();
  return notFoundMessage({ node: true, cli: true }, mac) + (tail ? '\n' + tail.split('\n').slice(-2).join('\n') : '');
}

/** Où est FS-CLI ? réglage → installation globale npm (lancée avec node) → « fs-cli » du PATH */
async function resolveCli() {
  const custom = vscode.workspace.getConfiguration('fsCli').get('command');
  if (custom && custom.trim()) {
    if (IS_WIN) return { cmd: custom.trim(), args: ['--stdio'], shell: true, custom: true };
    return { cmd: custom.trim(), args: ['--stdio'], shell: true, custom: true, pathDirs: [...knownBinDirs(), ...String(loginInfoCache?.path || '').split(':')].filter(Boolean) };
  }
  if (IS_WIN) {                                                     // Windows : inchangé
    if (cliPathCache === undefined) {
      cliPathCache = null;
      const root = npmRootGlobal();
      const js = root && path.join(root, 'fs-cli', 'cli.js');
      if (js && fs.existsSync(js)) cliPathCache = js;
    }
    if (cliPathCache) return { cmd: 'node', args: [cliPathCache, '--stdio'], shell: false };
    return { cmd: 'fs-cli', args: ['--stdio'], shell: true };
  }
  // Mac/Linux : node par son chemin absolu (le PATH de l'éditeur peut être incomplet)
  if (cliPathCache === undefined) {
    let r = locateCli();
    if (r.missing) r = locateCli({ npmRoot: npmRootGlobal() });
    if (r.missing) { loginInfoCache ||= await loginShellInfo(); r = locateCli({ npmRoot: npmRootGlobal(), login: loginInfoCache }); }
    cliPathCache = r.missing ? null : r;
    if (r.missing) return { missing: r.missing };
  }
  if (!cliPathCache) return { missing: { node: true, cli: true } };
  return { cmd: cliPathCache.node, args: [cliPathCache.js, '--stdio'], shell: false, pathDirs: cliPathCache.pathDirs };
}

/** Mac/Linux : /private/tmp/… ou chemin réel derrière un lien → le chemin tel que l'éditeur l'a ouvert (évite les onglets en double) */
function toEditorPath(full, bases, { win = IS_WIN, realpath = fs.realpathSync } = {}) {
  if (win || !full) return full;
  for (const b of bases || []) {
    if (!b) continue;
    let real; try { real = realpath(b); } catch { continue; }
    if (real === b) continue;
    if (full === real) return b;
    if (full.startsWith(real.endsWith('/') ? real : real + '/')) return path.posix.join(b, full.slice(real.length));
  }
  return full;
}

/** dossier du workspace (null si aucun dossier n'est ouvert) */
function openFolder() {
  const ed = currentEditor();
  if (ed && ed.document.uri.scheme === 'file') {
    const wf = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    if (wf) return wf.uri.fsPath;
  }
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : null;
}
function workspaceDir() { return openFolder() || os.homedir(); }

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

/** chemin du fichier pour le CLI : relatif à SON dossier de travail (📁, /cd, conversation reprise…), pas au workspace ; absolu s'il est en dehors */
function pathForCli(file, base, P = path) {
  if (!file) return '';
  if (!base) return file;
  const r = P.relative(base, file);
  if (!r || r === '..' || r.startsWith('..' + P.sep) || P.isAbsolute(r)) return file;   // hors du dossier (ou autre lecteur) : chemin complet
  return r.split(P.sep).join('/');
}

function contextPrefix(ctx, base) {
  if (!ctx) return '';
  const shown = base ? pathForCli(ctx.file, base) : ctx.rel;
  if (ctx.text) {
    const fence = ctx.text.includes('```') ? '~~~~' : '```';
    return `[Contexte VS Code : dans ${shown}, lignes ${ctx.start}-${ctx.end} sélectionnées par l'utilisateur]\n${fence}${ctx.lang || ''}\n${ctx.text}\n${fence}\n\n`;
  }
  return `[Contexte VS Code : fichier ouvert dans l'éditeur : ${shown}]\n\n`;
}

/** Une conversation = un panneau + un processus fs-cli --stdio */
class Chat {
  constructor(context, webview, onTitle) {
    this.context = context; this.webview = webview; this.onTitle = onTitle;
    this.proc = null; this.buf = ''; this.pendingDiff = new Map(); this.proposals = new Map(); this.useContext = vscode.workspace.getConfiguration('fsCli').get('shareSelection') !== false;
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

  /** dossier de base des chemins relatifs */
  baseDir() { return this.cwd || this.workDir || workspaceDir(); }

  /** Mac sans dossier ouvert : pas de démarrage silencieux dans ~ (les recherches y déclenchent les fenêtres d'autorisation de macOS) */
  macCwd() {
    if (!IS_MAC || openFolder()) return workspaceDir();
    if (this.workDir) return this.workDir;
    if (this.allowHome) return os.homedir();
    const last = this.context.globalState?.get('fsCli.lastWorkDir');
    try { if (last && fs.statSync(last).isDirectory()) { this.workDir = last; this.pendingFlash = `aucun dossier ouvert : FS-CLI travaille dans ${path.basename(last)} (clic sur le dossier en bas pour changer)`; return last; } } catch {}
    this.post({ type: 'exit', code: null, noFolder: true, message: 'Aucun dossier n\'est ouvert dans l\'éditeur.\nSur Mac, travailler dans le dossier personnel fait apparaître les fenêtres d\'autorisation de macOS (Documents, Bureau, Téléchargements…) pendant les recherches. Ouvre un dossier (Fichier › Ouvrir le dossier…) ou choisis-en un ici.' });
    return null;
  }

  /** bouton « Choisir un dossier… » du panneau (Mac sans dossier ouvert) */
  async pickStartFolder() {
    const ed = currentEditor();
    let r;
    try { r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Travailler dans ce dossier', title: 'Dossier où FS-CLI va travailler', defaultUri: ed ? vscode.Uri.file(path.dirname(ed.document.uri.fsPath)) : undefined }); } catch {}
    const uri = r && r[0];
    if (!uri) return;                                                  // annulé : l'explication et ses boutons restent affichés
    this.workDir = uri.fsPath;
    try { await this.context.globalState?.update('fsCli.lastWorkDir', uri.fsPath); } catch {}
    this.start();
  }

  async start() {
    if (this.proc || this.starting || this.disposed) return;
    this.starting = true;
    try { await this.spawnCli(); } finally { this.starting = false; }
  }

  async spawnCli() {
    const cwd = this.macCwd();
    if (!cwd) return;
    const r = await resolveCli();
    if (this.disposed || this.proc) return;
    if (r.missing) { this.post({ type: 'exit', code: -1, notFound: true, message: notFoundMessage(r.missing) }); return; }
    const { cmd, args, shell } = r;
    const env = { ...process.env, FORCE_COLOR: '3', FS_CLI_PANEL: String(this.context.extension?.packageJSON?.version || '0.0.0'), FS_CLI_PANEL_FEATURES: 'agents' };   // le CLI adapte ce qu'il envoie à cette version du panneau
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    if (!IS_WIN) {
      env.FS_WORKDIR = cwd;                                             // chemin tel que l'éditeur l'a ouvert (process.cwd() donnerait /private/tmp/…)
      if (r.pathDirs?.length) env.PATH = [...new Set([...r.pathDirs, ...String(env.PATH || '').split(':')].filter(Boolean))].join(':');
    }
    let p;
    try { p = cp.spawn(cmd, args, { cwd, env, shell, windowsHide: true }); }
    catch (e) { this.post({ type: 'exit', code: -1, message: `Impossible de lancer FS-CLI : ${e.message}` }); return; }
    this.proc = p; this.buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => this.onData(d));
    p.stderr.setEncoding('utf8');
    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    p.stdin.on('error', () => {});                                      // processus déjà terminé : écriture perdue, pas d'erreur dans l'éditeur
    p.on('error', e => {
      if (this.proc === p) this.proc = null;                            // sinon start() croirait le CLI encore lancé
      const missing = /ENOENT/.test(e.message);
      if (missing && !IS_WIN) { cliPathCache = undefined; return this.post({ type: 'exit', code: -1, notFound: true, message: notFoundMessage({ node: cmd !== 'fs-cli' }) }); }
      this.post({ type: 'exit', code: -1, message: missing ? (cmd === 'node' ? 'Node.js introuvable dans le PATH de l\'éditeur. Installe Node.js (nodejs.org) puis redémarre l\'éditeur.' : 'FS-CLI introuvable. Installe-le : npm install -g github:0xBlxck/fs-cli') : e.message });
    });
    p.on('exit', code => {
      if (this.proc !== p) return;
      this.proc = null;
      const nf = notFoundExitMessage(code, errTail, { custom: !!r.custom, cmd });
      if (nf) { cliPathCache = undefined; return this.post({ type: 'exit', code, notFound: true, message: nf }); }
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
      if (ev.type === 'pickFolder') { this.pickFolder(String(ev.purpose || 'trust'), ev.title); continue; }   // FS-CLI demande un dossier (confiance)
      if (ev.type === 'reloadWindow') { vscode.commands.executeCommand('workbench.action.reloadWindow'); continue; }   // après /update
      if (ev.type === 'status') {
        if (ev.title !== undefined) this.onTitle?.(ev.title);
        if (ev.cwd) {
          this.cwd = toEditorPath(ev.cwd, this.bases());
          if (IS_MAC && !openFolder() && this.cwd !== os.homedir()) { this.workDir = this.cwd; try { this.context.globalState?.update('fsCli.lastWorkDir', this.cwd); } catch {} }   // retenu pour la prochaine fois
        }
      }
      if (ev.type === 'ready' && this.pendingFlash) { const t = this.pendingFlash; this.pendingFlash = null; setTimeout(() => this.post({ type: 'event', ev: { type: 'flash', text: t } }), 300); }
      if (ev.type === 'busy' && !ev.busy) this.closeProposals();          // tour terminé (ou interrompu) : plus aucune proposition en attente
      if (ev.type === 'selectCancelled') this.closeProposal(ev.id);       // question annulée par le CLI (Échap / interruption) : son diff se ferme
      if (ev.type === 'select' && ev.proposal && typeof ev.proposal.after === 'string') {
        this.showProposal(ev);
        ev = { ...ev, proposal: { path: String(ev.proposal.path || ''), created: !!ev.proposal.created } };   // le panneau n'a pas besoin des contenus
      }
      this.post({ type: 'event', ev });
    }
  }

  toCli(m) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(m) + '\n'); }

  /** sélecteur de dossiers de l'éditeur → FS-CLI (dossier de travail, dossier où écrire, ou réponse à la question de confiance) */
  async pickFolder(purpose, title) {
    const label = purpose === 'target' ? 'Écrire les fichiers ici' : 'Travailler dans ce dossier';
    let uri;
    try {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: label, title: title || label, defaultUri: this.cwd ? vscode.Uri.file(this.cwd) : undefined });
      uri = r && r[0];
    } catch {}
    this.toCli({ type: 'folderPicked', purpose, path: uri ? uri.fsPath : '' });
  }

  async fromPanel(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready': this.start(); this.pushContext(); return;
      case 'send': {
        const text = String(m.text || '');
        if (!text.trim()) return;
        const ctx = this.useContext && !text.trim().startsWith('/') && !text.trim().startsWith('!') ? editorContext() : null;
        this.toCli({ type: 'submit', text: contextPrefix(ctx, this.baseDir()) + text });   // chemin relatif au dossier de travail du CLI
        return;
      }
      case 'select': this.closeProposal(m.id); return this.toCli({ type: 'select', id: m.id, index: m.index });
      case 'openProposal': return this.openProposal(m.id);
      case 'command': { const t = String(m.text || ''); if (/^\/[\w-]+( |$)/.test(t)) this.toCli({ type: 'submit', text: t }); return; }
      case 'mcpAction': return this.toCli({ type: 'mcpAction', action: String(m.action || ''), name: String(m.name || '') });
      case 'historyOpen': return this.toCli({ type: 'historyOpen' });
      case 'skillsOpen': return this.toCli({ type: 'skillsOpen' });
      case 'skillToggle': return this.toCli({ type: 'skillToggle', kind: String(m.kind || ''), name: String(m.name || '') });
      case 'resumeChat': return this.toCli({ type: 'resumeChat', chatId: String(m.chatId || '') });
      case 'projectUse': return this.toCli({ type: 'projectUse', id: String(m.id || '') });
      case 'settingsOpen': return this.toCli({ type: 'settingsOpen' });
      case 'deleteChat': return this.toCli({ type: 'deleteChat', chatId: String(m.chatId || ''), title: String(m.title || '') });
      case 'deleteProject': return this.toCli({ type: 'deleteProject', id: String(m.id || '') });
      case 'setting': return this.toCli({ type: 'setting', key: String(m.key || ''), value: typeof m.value === 'boolean' ? m.value : String(m.value ?? '') });
      case 'pickFolder': return this.pickFolder(m.purpose === 'target' ? 'target' : 'cwd');
      case 'ask': return this.toCli({ type: 'ask', id: m.id, text: String(m.text ?? '') });
      case 'interrupt': return this.toCli({ type: 'interrupt' });
      case 'setMode': return this.toCli({ type: 'setMode', mode: String(m.mode) });
      case 'setModel': return this.toCli({ type: 'setModel', id: String(m.id) });
      case 'undoFile': return this.toCli({ type: 'undoFile', path: String(m.path) });
      case 'toggleContext': this.useContext = !this.useContext; this.pushContext(); return;
      case 'restart': this.stop(); if (!cliPathCache) { cliPathCache = undefined; loginInfoCache = undefined; } this.start(); return;   // introuvable la dernière fois : on recherche
      case 'pickStartFolder': return this.pickStartFolder();
      case 'startHome': this.allowHome = true; return this.start();
      case 'openCliSetting': return vscode.commands.executeCommand('workbench.action.openSettings', 'fsCli.command');
      case 'installCli': {                                             // installation dans un vrai terminal (il a le PATH du shell), puis « Réessayer »
        const t = vscode.window.createTerminal({ name: 'FS-CLI : installation' });
        t.show(); t.sendText(INSTALL_CMD);
        vscode.window.showInformationMessage('Une fois l\'installation finie, clique sur « Réessayer » dans le panneau FS-CLI.');
        return;
      }
      case 'login': return vscode.commands.executeCommand('fsCli.login');
      case 'openFile': return this.openFile(String(m.path || ''), m.line);
      case 'openDiff': return this.openDiff(String(m.path || ''));
      case 'openLink': {
        const u = String(m.url || '');
        if (/^https?:\/\//i.test(u)) vscode.env.openExternal(vscode.Uri.parse(u));
        return;
      }
      case 'copy': return vscode.env.clipboard.writeText(String(m.text || ''));
      case 'saveImage': {                                              // image générée : enregistrée seulement si l'utilisateur le veut, où il veut
        const name = String(m.name || 'image.png').replace(/[^\w.-]/g, '_');
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(this.baseDir(), name)), filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] }, saveLabel: 'Enregistrer l\'image' });
        if (!target) return;
        fs.writeFileSync(target.fsPath, Buffer.from(String(m.data || ''), 'base64'));
        this.post({ type: 'event', ev: { type: 'flash', text: '✓ image enregistrée : ' + path.basename(target.fsPath) } });
        return;
      }
      case 'pickFiles': {
        const r = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Joindre', defaultUri: vscode.Uri.file(this.workDir || workspaceDir()) });
        if (r && r.length) this.post({ type: 'insert', text: r.map(u => '@' + (u.fsPath.includes(' ') ? `"${u.fsPath}"` : u.fsPath)).join(' ') + ' ' });
        return;
      }
      case 'pasteImage': {                                         // image collée dans le panneau → fichier temporaire → chemin dans le message (FS-CLI l'envoie au modèle)
        const ext = /png|jpe?g|gif|webp/i.exec(String(m.mime || ''))?.[0]?.replace('jpeg', 'jpg') || 'png';
        const data = String(m.data || '');
        if (!data || data.length > 14_000_000) {                       // jamais en silence : sur Mac (Retina) une capture plein écran dépasse vite 10 Mo
          const zone = IS_MAC ? 'Cmd+Ctrl+Maj+4' : IS_WIN ? 'Win+Maj+S' : 'l\'outil de capture';
          this.post({ type: 'event', ev: { type: 'flash', text: data ? `image trop lourde (max 10 Mo) : capture plutôt une zone (${zone})` : 'image collée illisible : réessaie ou joins-la avec +' } });
          return;
        }
        const dir = (this.imgDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'fs-cli-images-')));   // dossier unique par panneau
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `collage-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        this.post({ type: 'insert', text: `"${file}" ` });
        return;
      }
    }
  }

  /** dossiers tels que l'éditeur les a ouverts (pour ramener /private/tmp/… vers /tmp/…) */
  bases() { return [...(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath), this.workDir]; }

  abs(p) { return !p ? '' : toEditorPath(path.isAbsolute(p) ? path.normalize(p) : path.join(this.baseDir(), p), this.bases()); }

  async openFile(p, line) {
    if (!p) return;
    const full = this.abs(p);
    if (!fs.existsSync(full)) return;
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(full)) return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full));   // image : visionneuse de l'éditeur
    const doc = await vscode.workspace.openTextDocument(full);
    const ed = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    if (line > 0) { const pos = new vscode.Position(line - 1, 0); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter); }
  }

  /** diff natif de VS Code : contenu d'avant (donné par le CLI, seulement pour un fichier qu'il a modifié) ↔ fichier actuel */
  async openDiff(p) {
    if (!p || !this.proc) return this.openFile(p);
    const id = crypto.randomBytes(6).toString('hex');
    const ev = await new Promise(res => { this.pendingDiff.set(id, res); this.toCli({ type: 'diffBefore', id, path: p }); setTimeout(() => { if (this.pendingDiff.delete(id)) res(null); }, 5000); });
    if (!ev || !ev.ok) return this.openFile(p);
    p = ev.path ? toEditorPath(ev.path, this.bases()) : this.abs(p);
    const name = path.basename(p);
    const left = vscode.Uri.from({ scheme: 'fs-cli-before', path: `/${id}/${name}` });
    beforeDocs.set(left.toString(), ev.before);
    if (beforeDocs.size > 50) beforeDocs.delete(beforeDocs.keys().next().value);
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(p), `${name} (${ev.created ? 'créé' : 'avant'} ↔ maintenant)`, { viewColumn: vscode.ViewColumn.One });
  }

  // ── proposition de modification : diff natif « actuel ↔ proposé », accepter / refuser depuis le panneau ou la barre du diff ──
  showProposal(ev) {
    const pr = ev.proposal, name = path.basename(String(pr.path || 'fichier')) || 'fichier';
    const key = `${ev.id}-${crypto.randomBytes(4).toString('hex')}`;
    const left = vscode.Uri.from({ scheme: 'fs-cli-before', path: `/p${key}/${name}` });
    const right = vscode.Uri.from({ scheme: 'fs-cli-proposal', path: `/${key}/${name}` });
    beforeDocs.set(left.toString(), String(pr.before ?? ''));
    proposalDocs.set(right.toString(), pr.after);
    proposalOwners.set(right.toString(), { chat: this, id: ev.id });
    const opts = Array.isArray(ev.options) ? ev.options : [];
    const reject = opts.indexOf('Refuser');
    this.proposals.set(ev.id, { left, right, name, created: !!pr.created, accept: 0, reject: reject >= 0 ? reject : -1 });   // -1 = refus (comme Échap)
    this.openProposal(ev.id);
  }

  openProposal(id) {
    const p = this.proposals.get(id);
    if (!p) return;
    const title = `${p.name} (proposition de FS-CLI${p.created ? ' · nouveau fichier' : ''})`;
    // preserveFocus : le panneau garde le clavier (↑↓ Entrée) pendant qu'on lit le diff
    return vscode.commands.executeCommand('vscode.diff', p.left, p.right, title, { viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true }).then(undefined, () => {});
  }

  /** réponse donnée depuis l'éditeur (barre du diff) : transmise au CLI, et la carte du panneau est marquée comme répondue */
  answerProposal(id, accept) {
    const p = this.proposals.get(id);
    if (!p) return;
    const index = accept ? p.accept : p.reject;
    this.closeProposal(id);
    this.toCli({ type: 'select', id, index });
    this.post({ type: 'selectAnswered', id, index });
  }

  closeProposal(id) {
    const p = this.proposals.get(id);
    if (!p) return;
    this.proposals.delete(id);
    const r = p.right.toString();
    proposalOwners.delete(r);
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === r);
      if (tabs.length) vscode.window.tabGroups.close(tabs).then(() => { proposalDocs.delete(r); beforeDocs.delete(p.left.toString()); }, () => {});
      else { proposalDocs.delete(r); beforeDocs.delete(p.left.toString()); }
    } catch {}
  }

  closeProposals() { for (const id of [...this.proposals.keys()]) this.closeProposal(id); }

  insertSelection() {
    const ctx = editorContext();
    if (ctx) { this.useContext = true; this.pushContext(); }
    if (!ctx || !ctx.text) this.post({ type: 'event', ev: { type: 'flash', text: ctx ? 'aucune sélection : seul le fichier ouvert sera joint' : 'aucun fichier ouvert : sélectionne du code dans l\'éditeur pour le joindre' } });
    this.post({ type: 'focusInput' });
  }

  stop() {
    this.closeProposals();
    const p = this.proc; this.proc = null;
    if (!p) return;
    try { p.stdin.write('{"type":"quit"}\n'); } catch {}
    setTimeout(() => { try { p.kill(); } catch {} }, 3000);
  }

  dispose() { this.disposed = true; this.stop(); for (const d of this.disposables) try { d.dispose(); } catch {} }

  html() {
    const w = this.webview, media = f => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('panel.css')}">
<title>FS-CLI</title></head>
<body data-logo="${media('logo.png')}" data-platform="${process.platform}"><div id="app"></div><script nonce="${nonce}" src="${media('latex.js')}"></script><script nonce="${nonce}" src="${media('panel.js')}"></script></body></html>`;
  }
}

class SidebarProvider {
  constructor(context, onVisible) { this.context = context; this.chat = null; this.onVisible = onVisible; }
  resolveWebviewView(view) {
    this.view = view;
    this.chat?.dispose();
    const chat = this.chat = new Chat(this.context, view.webview);
    view.onDidChangeVisibility(() => { if (view.visible && this.chat === chat) this.onVisible?.(chat, true); });   // barre latérale montrée : c'est elle qu'on utilise
    view.onDidDispose(() => { this.onVisible?.(chat, false); if (this.chat === chat) { chat.dispose(); this.chat = null; } });
  }
}

/** « Demander à FS-CLI » : le panneau visé est toujours montré (barre latérale cachée par l'Explorateur, onglet derrière un autre) */
async function revealChat(c, sidebar, exec) {
  if (c && c.panel) { try { c.panel.reveal(undefined, false); } catch {} return c; }
  await exec('fsCli.chat.focus');
  return sidebar.chat;
}

/** Accepter / Refuser depuis l'éditeur : l'uri reçue (ou l'onglet actif) désigne la proposition */
function answerFromEditor(uri, accept) {
  let key = uri && uri.scheme === 'fs-cli-proposal' ? uri.toString() : null;
  if (!key) {
    const inp = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
    if (inp instanceof vscode.TabInputTextDiff && inp.modified.scheme === 'fs-cli-proposal') key = inp.modified.toString();
  }
  const o = key && proposalOwners.get(key);
  if (!o) { vscode.window.showInformationMessage('Cette proposition de FS-CLI n\'attend plus de réponse.'); return; }
  o.chat.answerProposal(o.id, accept);
}

function activate(context) {
  let lastActive = null;                                            // dernier panneau utilisé (pour « Demander à FS-CLI »)
  const sidebar = new SidebarProvider(context, (c, shown) => { if (shown) lastActive = c; else if (lastActive === c) lastActive = null; });
  const tabs = new Set();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('fs-cli-before', { provideTextDocumentContent: uri => beforeDocs.get(uri.toString()) ?? '' }),
    vscode.workspace.registerTextDocumentContentProvider('fs-cli-proposal', { provideTextDocumentContent: uri => proposalDocs.get(uri.toString()) ?? '' }),
    // boutons ✓ / ✗ de la barre du diff proposé (côté droit = fs-cli-proposal:)
    vscode.commands.registerCommand('fsCli.acceptProposal', uri => answerFromEditor(uri, true)),
    vscode.commands.registerCommand('fsCli.rejectProposal', uri => answerFromEditor(uri, false)),
    vscode.window.registerWebviewViewProvider('fsCli.chat', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('fsCli.open', () => {
      const panel = vscode.window.createWebviewPanel('fsCli.tab', 'FS-CLI', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
      const chat = new Chat(context, panel.webview, t => { panel.title = t ? `FS-CLI · ${t.slice(0, 30)}` : 'FS-CLI'; });
      chat.panel = panel;                                           // pour le remettre au premier plan (« Demander à FS-CLI »)
      tabs.add(chat); lastActive = chat;
      panel.onDidChangeViewState(e => { if (e.webviewPanel.active) lastActive = chat; });
      panel.onDidDispose(() => { chat.dispose(); tabs.delete(chat); if (lastActive === chat) lastActive = null; });
    }),
    vscode.commands.registerCommand('fsCli.focus', () => vscode.commands.executeCommand('fsCli.chat.focus')),
    vscode.commands.registerCommand('fsCli.newChat', () => { const c = lastActive || sidebar.chat; if (c) c.toCli({ type: 'submit', text: '/new' }); else vscode.commands.executeCommand('fsCli.chat.focus'); }),
    vscode.commands.registerCommand('fsCli.askSelection', async () => {
      const c = await revealChat(lastActive || sidebar.chat, sidebar, id => vscode.commands.executeCommand(id));
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

module.exports = { activate, deactivate, _test: { locateCli, parseLoginOutput, notFoundMessage, isNotFoundExit, notFoundExitMessage, toEditorPath, knownBinDirs, pathForCli, contextPrefix, revealChat, SidebarProvider, Chat } };   // _test : pour test/macos-extension.test.mjs et test/audit2-ide.test.mjs
