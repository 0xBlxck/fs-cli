// Audit 2 — extension de l'éditeur : chemin du fichier ouvert relatif au dossier du CLI, questions en file (une carte à la fois,
// jamais le clavier pris pendant qu'on écrit), plus de fuite mémoire des blocs de code, « FS-CLI introuvable » lisible sous Windows,
// « Demander à FS-CLI » qui montre toujours le panneau. Tout est simulé (faux DOM, faux module vscode) : aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PANEL_SRC = fs.readFileSync(path.join(ROOT, 'vscode', 'media', 'panel.js'), 'utf8');
const LATEX_SRC = fs.readFileSync(path.join(ROOT, 'vscode', 'media', 'latex.js'), 'utf8');

// ── faux module « vscode » (juste ce que Chat et editorContext utilisent) ──
const VS = {
  editor: null, folders: [],
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    asRelativePath: uri => path.relative(VS.folders[0] || '', uri.fsPath).split(path.sep).join('/'),
    getWorkspaceFolder: uri => { const f = VS.folders.find(d => uri.fsPath.startsWith(d)); return f ? { uri: { fsPath: f } } : undefined; },
    get workspaceFolders() { return VS.folders.map(f => ({ uri: { fsPath: f } })); },
  },
  window: {
    get activeTextEditor() { return VS.editor; },
    get visibleTextEditors() { return VS.editor ? [VS.editor] : []; },
    onDidChangeTextEditorSelection: () => ({ dispose() {} }), onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  },
  commands: { executeCommand: async () => {} },
  Uri: { joinPath: (...a) => ({ toString: () => a.join('/') }), file: f => ({ fsPath: f, scheme: 'file' }) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? VS : origLoad.call(this, req, ...rest); };
const ext = require(path.join(ROOT, 'vscode', 'extension.js'));
Module._load = origLoad;
const T = ext._test;

function fakeWebview() {
  const posts = [];
  return { posts, cspSource: 'x', asWebviewUri: u => u, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: m => { posts.push(m); return true; } };
}
function editorOn(file, sel = null) {
  const s = sel || { isEmpty: true, start: { line: 0 }, end: { line: 0, character: 0 } };
  return { selection: s, document: { uri: { scheme: 'file', fsPath: file }, languageId: 'js', getText: () => 'const a = 1;' } };
}

// ── extension-ide-chemin-contexte-relatif ──
test('contexte de l\'éditeur : chemin relatif au dossier de travail du CLI, pas au workspace', () => {
  const W = path.win32, P = path.posix;
  assert.equal(T.pathForCli('C:\\proj\\frontend\\src\\app.js', 'C:\\proj\\frontend', W), 'src/app.js');   // 📁 frontend choisi : plus de « frontend/frontend/… »
  assert.equal(T.pathForCli('C:\\proj\\backend\\x.js', 'C:\\proj\\frontend', W), 'C:\\proj\\backend\\x.js');   // hors du dossier : chemin complet
  assert.equal(T.pathForCli('D:\\autre\\x.js', 'C:\\proj', W), 'D:\\autre\\x.js');                     // autre lecteur
  assert.equal(T.pathForCli('c:\\Proj\\A.js', 'C:\\proj', W), 'A.js');                                  // Windows : casse ignorée
  assert.equal(T.pathForCli('/home/moi/proj/web/src/a.ts', '/home/moi/proj/web', P), 'src/a.ts');
  assert.equal(T.pathForCli('/home/moi/..cache/a.ts', '/home/moi', P), '..cache/a.ts');                // nom qui commence par « .. » : encore dedans
  assert.equal(T.pathForCli('/etc/hosts', '/home/moi/proj', P), '/etc/hosts');
  assert.equal(T.pathForCli('/a/b.js', '', P), '/a/b.js');
});

test('contexte de l\'éditeur : l\'en-tête envoyé au CLI suit son dossier de travail (📁, /cd, conversation reprise)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-ide-'));
  const front = path.join(root, 'frontend'), file = path.join(front, 'src', 'app.js');
  VS.folders = [root]; VS.editor = editorOn(file);
  try {
    const chat = new T.Chat({ extensionUri: 'ext' }, fakeWebview());
    const sent = [];
    chat.proc = { stdin: { writable: true, write: s => sent.push(JSON.parse(s)) } };
    chat.cwd = front;                                                   // status du CLI : dossier de travail = frontend
    await chat.fromPanel({ type: 'send', text: 'explique ce fichier' });
    assert.equal(sent[0].type, 'submit');
    assert.ok(sent[0].text.startsWith('[Contexte VS Code : fichier ouvert dans l\'éditeur : src/app.js]\n'), sent[0].text);
    chat.cwd = path.join(root, 'ailleurs');                             // /cd vers un autre dossier : chemin complet, jamais un relatif faux
    await chat.fromPanel({ type: 'send', text: 'et maintenant ?' });
    assert.ok(sent[1].text.startsWith(`[Contexte VS Code : fichier ouvert dans l'éditeur : ${file}]\n`), sent[1].text);
    // sélection : même règle
    VS.editor = editorOn(file, { isEmpty: false, start: { line: 2 }, end: { line: 4, character: 3 } });
    chat.cwd = front;
    await chat.fromPanel({ type: 'send', text: 'corrige' });
    assert.match(sent[2].text, /^\[Contexte VS Code : dans src\/app\.js, lignes 3-5 sélectionnées par l'utilisateur\]\n```js\n/);
    chat.dispose();
  } finally { VS.editor = null; VS.folders = []; fs.rmSync(root, { recursive: true, force: true }); }
  assert.equal(T.contextPrefix({ file: '/x/a.js', rel: 'a.js' }), '[Contexte VS Code : fichier ouvert dans l\'éditeur : a.js]\n\n');   // sans dossier connu : comme avant
});

test('contexte de l\'éditeur : un chemin absolu dans l\'en-tête ne change jamais le dossier cible', async () => {
  const { stripEditorContext } = await import('../src/editor-context.js');
  const { detectTargetDir } = await import('../src/target.js');
  const msg = '[Contexte VS Code : fichier ouvert dans l\'éditeur : C:\\Users\\moi\\Downloads\\SITE\\index.html]\n\nexplique ce fichier';
  assert.equal(stripEditorContext(msg), 'explique ce fichier');
  assert.equal(detectTargetDir(stripEditorContext(msg)), null);
});

// ── extension-ide-cli-introuvable ──
test('FS-CLI absent sous Windows : message d\'installation lisible (plus le texte de cmd.exe mal décodé)', () => {
  const fr = "'fs-cli' n'est pas reconnu en tant que commande interne\r\nou externe, un programme ex\uFFFDcutable ou un fichier de commandes.";
  const m = T.notFoundExitMessage(1, fr, { win: true });
  assert.match(m, /^FS-CLI introuvable/);
  assert.match(m, /npm install -g github:0xBlxck\/fs-cli/);
  assert.doesNotMatch(m, /\uFFFD|reconnu/, 'le texte illisible de cmd.exe n\'est plus affiché');
  assert.ok(T.notFoundExitMessage(1, "'fs-cli' n\uFFFDest pas reconnu en tant que commande interne", { win: true }), 'apostrophe mal décodée');
  assert.ok(T.notFoundExitMessage(1, "'fs-cli' is not recognized as an internal or external command,", { win: true }), 'Windows en anglais');
  assert.ok(T.notFoundExitMessage(9009, '', { win: true }));
  assert.match(T.notFoundExitMessage(1, fr, { win: true, custom: true, cmd: 'C:\\outils\\fs.cmd' }), /fsCli\.command introuvable : C:\\outils\\fs\.cmd/);
  assert.equal(T.notFoundExitMessage(1, 'Error: boom', { win: true }), null, 'vraie erreur du CLI : affichée telle quelle');
  assert.equal(T.notFoundExitMessage(0, fr, { win: true }), null);
  assert.equal(T.notFoundExitMessage(127, '', { win: true }), null);
  // raccourci fs-cli.cmd présent mais Node.js absent : c'est Node.js qu'on demande d'installer
  const noNode = "'node' n'est pas reconnu en tant que commande interne\r\nou externe, un programme ex\uFFFDcutable ou un fichier de commandes.";
  assert.match(T.notFoundExitMessage(1, noNode, { win: true }), /^Node\.js introuvable[\s\S]*nodejs\.org/);
  assert.doesNotMatch(T.notFoundExitMessage(1, noNode, { win: true }), /FS-CLI introuvable|\uFFFD/);
  assert.match(T.notFoundExitMessage(1, "'node' is not recognized as an internal or external command,", { win: true }), /^Node\.js introuvable/);
  assert.match(T.notFoundExitMessage(1, "'node' n'est pas reconnu en tant que commande interne", { win: true, custom: true, cmd: 'node C:\\fs\\cli.js' }), /fsCli\.command : node C:\\fs\\cli\.js/);
  // Mac/Linux : inchangé
  assert.match(T.notFoundExitMessage(127, '/bin/sh: fs-cli: command not found', { win: false, mac: false }), /^FS-CLI ou Node\.js introuvable[\s\S]*command not found$/);
  assert.equal(T.notFoundExitMessage(1, 'Error: boom', { win: false }), null);
  // le gestionnaire « exit » s'en sert
  const src = fs.readFileSync(path.join(ROOT, 'vscode', 'extension.js'), 'utf8');
  assert.match(src, /const nf = notFoundExitMessage\(code, errTail, \{ custom: !!r\.custom, cmd \}\);/);
});

// ── extension-ide-askselection-invisible ──
test('« Demander à FS-CLI » : l\'onglet est remis au premier plan, la barre latérale cachée est montrée', async () => {
  const calls = [];
  const tab = { panel: { reveal: (col, keep) => calls.push(['reveal', col, keep]) } };
  const sidebar = { chat: { side: true } };
  assert.equal(await T.revealChat(tab, sidebar, async id => calls.push(['exec', id])), tab);
  assert.deepEqual(calls, [['reveal', undefined, false]]);
  calls.length = 0;
  assert.equal(await T.revealChat(sidebar.chat, sidebar, async id => calls.push(['exec', id])), sidebar.chat);   // déjà créée mais cachée
  assert.deepEqual(calls, [['exec', 'fsCli.chat.focus']]);
  calls.length = 0;
  assert.equal(await T.revealChat(null, sidebar, async id => calls.push(['exec', id])), sidebar.chat);
  assert.deepEqual(calls, [['exec', 'fsCli.chat.focus']]);
});

test('barre latérale montrée : elle devient le panneau utilisé ; fermée : on l\'oublie', () => {
  const seen = [];
  const sp = new T.SidebarProvider({ extensionUri: 'ext' }, (c, shown) => seen.push([c, shown]));
  let vis, gone;
  const view = { visible: false, webview: fakeWebview(), onDidChangeVisibility: f => { vis = f; }, onDidDispose: f => { gone = f; } };
  sp.resolveWebviewView(view);
  const chat = sp.chat;
  view.visible = true; vis();
  assert.deepEqual(seen, [[chat, true]]);
  gone();
  assert.deepEqual(seen[1], [chat, false]);
  assert.equal(sp.chat, null);
  const src = fs.readFileSync(path.join(ROOT, 'vscode', 'extension.js'), 'utf8');
  assert.match(src, /chat\.panel = panel;/);
  assert.match(src, /revealChat\(lastActive \|\| sidebar\.chat, sidebar,/);
});

test('« Demander à FS-CLI » sans sélection : un mot d\'explication et la saisie prend le focus', () => {
  const wv = fakeWebview();
  VS.editor = null;
  const chat = new T.Chat({ extensionUri: 'ext' }, wv);
  chat.insertSelection();
  assert.equal(wv.posts.at(-1).type, 'focusInput');
  assert.match(wv.posts.at(-2).ev.text, /aucun fichier ouvert/);
  VS.editor = editorOn(path.join(os.tmpdir(), 'a.js'));
  chat.insertSelection();
  assert.match(wv.posts.at(-2).ev.text, /aucune sélection/);
  assert.equal(chat.useContext, true);
  VS.editor = null; chat.dispose();
});

// ── faux DOM minimal pour exécuter panel.js tel quel ──
function makeDom() {
  const clock = { t: 1_000_000 };
  class FD extends Date { constructor(...a) { super(...(a.length ? a : [clock.t])); } static now() { return clock.t; } }
  const timers = [];
  const camel = s => s.replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const parseSel = s => s.trim().split(/\s+/).map(part => ({
    tag: (part.match(/^[a-z]+/i) || [])[0]?.toUpperCase() || null,
    cls: [...part.matchAll(/\.([\w-]+)/g)].map(m => m[1]),
    attrs: [...part.matchAll(/\[([\w-]+)\]/g)].map(m => m[1]),
  }));
  const matchOne = (el, c) => el.nodeType === 1 && (!c.tag || el.tagName === c.tag) && c.cls.every(k => el._cls.has(k)) && c.attrs.every(a => (a.startsWith('data-') ? el.dataset[camel(a)] !== undefined : el._attrs[a] !== undefined));
  const matches = (el, sel) => sel.split(',').some(one => {
    const parts = parseSel(one);
    if (!matchOne(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2, p = el.parentNode;
    while (i >= 0 && p) { if (matchOne(p, parts[i])) i--; p = p.parentNode; }
    return i < 0;
  });
  class Txt { constructor(t) { this.nodeType = 3; this._t = String(t); this.parentNode = null; } get textContent() { return this._t; } set textContent(v) { this._t = String(v); } remove() { this.parentNode?._rm(this); } }
  class El {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this._cls = new Set(); this._attrs = {}; this.dataset = {}; this.style = {}; this._t = ''; this._html = ''; this._ls = {}; this.hidden = false; this.value = ''; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; }
    get className() { return [...this._cls].join(' '); } set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList() { const s = this._cls; return { add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)), contains: c => s.has(c), toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; } }; }
    get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._t; }
    set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._t = String(v); this._html = ''; }
    get innerHTML() { return this._html; } set innerHTML(v) { this.textContent = String(v).replace(/<[^>]*>/g, ''); this._html = String(v); }
    _adopt(n) { if (typeof n === 'string') n = new Txt(n); if (n.isFrag) { const k = [...n.children]; n.children = []; return k.map(x => this._adopt(x)); } n.parentNode?._rm(n); n.parentNode = this; if (!this.children.length && this._t) { const t = new Txt(this._t); t.parentNode = this; this.children.push(t); this._t = ''; } return [n]; }
    append(...ns) { for (const n of ns) for (const x of this._adopt(n)) this.children.push(x); }
    appendChild(n) { this.append(n); return n; }
    prepend(...ns) { const list = ns.flatMap(n => this._adopt(n)); this.children.unshift(...list); }
    insertBefore(n, ref) { const list = this._adopt(n); const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, ...list); return n; }
    _rm(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; }
    remove() { this.parentNode?._rm(this); }
    get elements() { return this.children.filter(c => c.nodeType === 1); }
    get lastElementChild() { const e = this.elements; return e[e.length - 1] || null; }
    get previousElementSibling() { const s = this.parentNode?.elements || []; return s[s.indexOf(this) - 1] || null; }
    get firstChild() { return this.children[0] || null; }
    get isConnected() { let p = this; while (p) { if (p === doc.body) return true; p = p.parentNode; } return false; }
    _all() { const out = []; const walk = e => { for (const c of e.elements) { out.push(c); walk(c); } }; walk(this); return out; }
    querySelectorAll(s) { return this._all().filter(e => matches(e, s)); }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    closest(s) { let p = this; while (p && p.nodeType === 1) { if (matches(p, s)) return p; p = p.parentNode; } return null; }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    setAttribute(k, v) { this._attrs[k] = String(v); } getAttribute(k) { return this._attrs[k] ?? null; } removeAttribute(k) { delete this._attrs[k]; if (k === 'tabindex') delete this.tabIndex; }
    addEventListener(t, f) { (this._ls[t] ||= []).push(f); } removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter(x => x !== f); }
    focus() { doc.activeElement = this; } blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    scrollIntoView() {} getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  }
  const docLs = {};
  const doc = {
    activeElement: null,
    createElement: t => new El(t),
    createDocumentFragment: () => { const f = new El('#frag'); f.isFrag = true; return f; },
    getElementById: id => (id === 'app' ? app : null),
    addEventListener: (t, f) => { (docLs[t] ||= []).push(f); }, removeEventListener: (t, f) => { docLs[t] = (docLs[t] || []).filter(x => x !== f); },
    querySelectorAll: s => doc.body.querySelectorAll(s),
  };
  doc.body = new El('body'); doc.body.dataset.platform = 'win32'; doc.activeElement = doc.body;
  const app = new El('div'); doc.body.append(app);
  const winLs = {};
  const posts = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: m => posts.push(JSON.parse(JSON.stringify(m))) }),   // copie : objets du contexte vm → objets d'ici
    document: doc, navigator: { platform: 'Win32' }, console, Date: FD,
    window: { addEventListener: (t, f) => { (winLs[t] ||= []).push(f); }, innerHeight: 800 },
    requestAnimationFrame: f => { timers.push({ f, ms: 'raf' }); return timers.length; },
    cancelAnimationFrame: id => { if (timers[id - 1]) timers[id - 1].f = null; },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].f = null; },
    setInterval: () => 0, clearInterval: () => {},
  };
  vm.runInNewContext(LATEX_SRC, sandbox, { filename: 'latex.js' });   // chargé avant panel.js, comme dans extension.js
  vm.runInNewContext(PANEL_SRC, sandbox, { filename: 'panel.js' });
  const ev = (k, extra = {}) => ({ key: k, shiftKey: false, isComposing: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra });
  const D = {
    doc, posts, clock, timers,
    log: app.querySelector('.log'), ta: app.querySelector('textarea'), flash: app.querySelector('.flash'),
    msg: m => { for (const f of winLs.message || []) f({ data: m }); },
    event: e => D.msg({ type: 'event', ev: e }),
    /** touche : d'abord l'élément qui a le focus (onkeydown / écouteurs), puis le document */
    key: (k, extra) => {
      const e = ev(k, { target: doc.activeElement, ...extra });
      const t = doc.activeElement;
      if (t && t !== doc.body) { t.onkeydown?.(e); for (const f of t._ls?.keydown || []) f(e); }
      for (const f of docLs.keydown || []) f(e);
      return e;
    },
    click: el => { const e = ev('', { target: el }); el.onclick?.(e); for (const f of docLs.click || []) f(e); },
    flushFrames: () => { let n = 0; for (const t of timers) if (t.f && (t.ms === 'raf' || t.ms === 100)) { const f = t.f; t.f = null; f(); n++; } return n; },
    later: ms => { clock.t += ms; },
    cards: () => D.log.querySelectorAll('.ask'),
    selects: () => posts.filter(p => p.type === 'select' || p.type === 'ask'),
  };
  return D;
}

const sel = (id, extra = {}) => ({ type: 'select', id, title: `Question ${id}`, detail: '', options: ['Oui', 'Oui, et ne plus demander pendant cette session', 'Non, et dire quoi faire à la place'], defaultIndex: 0, ...extra });

// ── extension-ide-cartes-ecrasees ──
test('panneau : deux questions en même temps → une seule carte affichée, la 2e attend et répond ensuite (plus de carte morte)', () => {
  const D = makeDom();
  D.event(sel(1)); D.event(sel(2));
  assert.equal(D.cards().length, 1, 'une seule carte visible');
  assert.match(D.cards()[0].textContent, /Question 1/);
  assert.match(D.cards()[0].textContent, /\+ 1 autre question en attente/);
  D.later(1000);
  D.key('Enter');                                                       // la 1re carte répond (avant : ses boutons ne faisaient plus rien)
  assert.deepEqual(D.selects(), [{ type: 'select', id: 1, index: 0 }]);
  assert.equal(D.cards().length, 1);
  assert.match(D.cards()[0].textContent, /Question 2/);
  assert.doesNotMatch(D.cards()[0].textContent, /autre question/);
  D.key('Enter');                                                       // Entrée encore enfoncée : ignorée juste après l'apparition
  assert.equal(D.selects().length, 1);
  D.later(700);
  D.click(D.cards()[0].querySelectorAll('button.opt')[2]);              // clic : 3e option
  assert.deepEqual(D.selects()[1], { type: 'select', id: 2, index: 2 });
  assert.equal(D.cards().length, 0);
  assert.equal(D.doc.activeElement, D.ta, 'plus de question : retour à la saisie');
  assert.ok(D.log.querySelectorAll('.answered').length >= 2);
});

test('panneau : question annulée par le CLI (interruption) ou CLI arrêté → carte marquée « annulée », la suivante s\'affiche', () => {
  const D = makeDom();
  D.event(sel(5)); D.event(sel(6)); D.event(sel(7));
  D.event({ type: 'selectCancelled', id: 6 });                          // en file, jamais vue : retirée sans bruit
  assert.match(D.cards()[0].textContent, /\+ 1 autre question en attente/);
  D.event({ type: 'selectCancelled', id: 5 });
  assert.ok(D.log.textContent.includes('✗ question annulée'));
  assert.match(D.cards()[0].textContent, /Question 7/);
  D.msg({ type: 'exit', code: 1, message: 'boom' });
  assert.equal(D.cards().length, 0, 'CLI arrêté : plus aucune carte en attente');
  assert.equal(D.selects().length, 0, 'rien n\'est répondu à la place de l\'utilisateur');
});

test('panneau : CLI relancé sans « exit » (vieux bouton Relancer) → les cartes de l\'ancien processus ne répondent pas aux nouvelles questions', () => {
  const D = makeDom();
  const ready = { type: 'ready', version: '1', models: [], modes: [], commands: [] };
  D.event(ready);
  D.event(sel(1));                                                      // question de l'ancien processus, jamais répondue
  D.event(ready);                                                       // nouveau processus : pas de message « exit » (Chat.stop() met proc à null avant le kill)
  assert.equal(D.cards().length, 0, 'la carte de l\'ancien processus est annulée (le fil vide repasse à l\'accueil)');
  D.event(sel(1, { title: '⚠ Nouvelle question 1' }));                  // le nouveau processus renumérote à partir de 1
  assert.equal(D.cards().length, 1, 'une seule carte visible');
  assert.match(D.cards()[0].textContent, /Nouvelle question 1/);
  assert.doesNotMatch(D.cards()[0].textContent, /autre question/);
  D.later(1000);
  D.click(D.cards()[0].querySelectorAll('button.opt')[2]);
  assert.deepEqual(D.selects(), [{ type: 'select', id: 1, index: 2 }], 'id 1 répondu une seule fois, par la carte vue');
  assert.equal(D.cards().length, 0);
});

test('panneau : clic sur un ancien bouton « Relancer » pendant une question → la question est annulée avant la relance', () => {
  const D = makeDom();
  D.msg({ type: 'exit', code: 1, message: 'boom' });                    // notice avec « Relancer », restée dans le fil
  const old = D.log.querySelectorAll('button.btn').find(b => b.textContent === 'Relancer');
  assert.ok(old);
  D.event({ type: 'ready', version: '1', models: [], modes: [], commands: [] });
  D.event(sel(4));
  assert.equal(D.cards().length, 1);
  D.click(old);
  assert.equal(D.cards().length, 0, 'plus de carte de l\'ancien processus');
  assert.deepEqual(D.posts.filter(p => p.type === 'restart'), [{ type: 'restart' }]);
  assert.equal(D.selects().length, 0, 'rien n\'est répondu à la place de l\'utilisateur');
});

test('panneau : réponse depuis la barre du diff pour une question encore en file', () => {
  const D = makeDom();
  D.event(sel(8)); D.event(sel(9, { proposal: { path: 'a.js', created: false } }));
  D.msg({ type: 'selectAnswered', id: 9, index: 0 });
  assert.equal(D.selects().length, 0, 'déjà transmis au CLI par l\'extension');
  assert.equal(D.cards().length, 1);
  assert.match(D.cards()[0].textContent, /Question 8/);
  assert.doesNotMatch(D.cards()[0].textContent, /autre question/);
  assert.ok(D.log.textContent.includes('✓ Oui'));
});

test('panneau : /new pendant une question → la carte en cours reste affichée', () => {
  const D = makeDom();
  D.event(sel(10));
  D.event({ type: 'clear' });
  assert.equal(D.cards().length, 1);
});

// ── extension-ide-focus-carte ──
test('panneau : une confirmation qui arrive pendant qu\'on tape ne prend pas le clavier', () => {
  const D = makeDom();
  D.ta.focus(); D.ta.value = 'ajoute 2 boutons';
  D.event(sel(3));
  assert.equal(D.doc.activeElement, D.ta, 'la saisie garde le focus');
  assert.match(D.flash.textContent, /question en attente/);
  D.later(1000);
  for (const k of ['2', '1', 'Enter']) D.key(k);                       // « 2 » de « ajoute 2 boutons », puis Entrée pour envoyer
  assert.equal(D.selects().length, 0, 'aucune réponse donnée en tapant');
  assert.ok(D.posts.some(p => p.type === 'send' && p.text === 'ajoute 2 boutons'), 'Entrée envoie le message tapé');
  D.ta.value = 'suite';
  const e = D.key('Tab');                                               // Tab : va sur la carte
  assert.equal(e.defaultPrevented, true);
  assert.equal(D.doc.activeElement, D.cards()[0]);
  D.key('1');
  assert.deepEqual(D.selects(), [{ type: 'select', id: 3, index: 0 }]);
});

test('panneau : touches ignorées juste après l\'apparition d\'une carte (saisie vide)', () => {
  const D = makeDom();
  D.ta.focus(); D.ta.value = '';
  D.event(sel(4));
  assert.equal(D.doc.activeElement, D.cards()[0], 'saisie vide : la carte prend le focus comme avant');
  D.key('2'); D.key('Enter');
  assert.equal(D.selects().length, 0);
  D.later(650);
  D.key('2');
  assert.deepEqual(D.selects(), [{ type: 'select', id: 4, index: 1 }]);
});

test('panneau : action sensible (⚠) → pas de chiffre, seulement ↑↓ + Entrée ou un clic', () => {
  const D = makeDom();
  D.event(sel(11, { title: '⚠ Exécuter : rm -rf build', options: ['Oui', 'Oui, et ne plus demander (règle enregistrée)', 'Non, et dire quoi faire à la place'], defaultIndex: 2 }));
  assert.match(D.cards()[0].textContent, /chiffres désactivés/);
  D.later(1000);
  D.key('2'); D.key('1');
  assert.equal(D.selects().length, 0, 'un chiffre ne répond pas');
  D.key('ArrowUp'); D.key('Enter');
  assert.deepEqual(D.selects(), [{ type: 'select', id: 11, index: 1 }]);
});

test('panneau : question texte (ask) en file, Entrée juste après l\'apparition ignorée', () => {
  const D = makeDom();
  D.event(sel(12)); D.event({ type: 'ask', id: 13, label: 'raison / alternative pour le modèle' });
  assert.equal(D.cards().length, 1);
  D.later(1000); D.key('3');                                            // « Non, et dire quoi faire »
  assert.equal(D.cards().length, 1);
  const inp = D.cards()[0].querySelector('input');
  assert.equal(D.doc.activeElement, inp);
  D.key('Enter');
  assert.equal(D.selects().length, 1, 'pas de réponse vide envoyée par une Entrée de trop');
  D.later(700); inp.value = 'utilise npm ci'; D.key('Enter');
  assert.deepEqual(D.selects()[1], { type: 'ask', id: 13, text: 'utilise npm ci' });
});

// ── extension-ide-codestore-fuite ──
test('panneau : les blocs de code ne sont plus recopiés à chaque image du flux ; « Copier » relit le DOM', () => {
  assert.doesNotMatch(PANEL_SRC, /codeStore/, 'plus aucune copie gardée à côté');
  const D = makeDom();
  const code = Array.from({ length: 50 }, (_, i) => `ligne ${i} <b>&</b>`).join('\n');
  const txt = 'Voici :\n```js\n' + code + '\n```\n';
  for (let i = 0; i < txt.length; i += 40) { D.event({ type: 'text', delta: txt.slice(i, i + 40) }); D.flushFrames(); }
  D.event({ type: 'textEnd' });
  const ai = D.log.querySelector('.msg-ai');
  assert.match(ai.innerHTML, /<button data-copy="1">Copier<\/button>/);
  // « Copier » : le texte du bloc tel qu'affiché (décodé)
  const blk = D.doc.createElement('div'); blk.className = 'code';
  const bar = D.doc.createElement('div'); const btn = D.doc.createElement('button'); btn.dataset.copy = '1'; btn.textContent = 'Copier'; bar.append(btn);
  const pre = D.doc.createElement('pre'); const c = D.doc.createElement('code'); c.textContent = code; pre.append(c);
  blk.append(bar, pre); D.log.append(blk);
  D.click(btn);
  assert.deepEqual(D.posts.filter(p => p.type === 'copy'), [{ type: 'copy', text: code }]);
});

test('panneau : très longue réponse → rendu limité à ~10 par seconde', () => {
  const D = makeDom();
  D.event({ type: 'text', delta: 'x'.repeat(100) });
  assert.equal(D.timers.at(-1).ms, 'raf');
  D.flushFrames();
  D.event({ type: 'text', delta: 'y'.repeat(25000) });
  assert.equal(D.timers.at(-1).ms, 100, 'au-delà de 20 000 caractères : setTimeout 100 ms');
  const before = D.timers.length;
  D.event({ type: 'text', delta: 'z' }); D.event({ type: 'text', delta: 'z' });
  assert.equal(D.timers.length, before, 'un seul rendu programmé à la fois');
  D.event({ type: 'textEnd' });
  assert.equal(D.timers.at(-1).f, null, 'rendu programmé annulé : rendu final immédiat');
  assert.ok(D.log.querySelector('.msg-ai').textContent.endsWith('zz'));
});

test('extension : une question annulée par le CLI ferme aussi son diff proposé', () => {
  const src = fs.readFileSync(path.join(ROOT, 'vscode', 'extension.js'), 'utf8');
  assert.match(src, /ev\.type === 'selectCancelled'\) this\.closeProposal\(ev\.id\)/);
  assert.match(PANEL_SRC, /case 'selectCancelled':/);
});

test('panneau : formules LaTeX converties (en ligne et en bloc sur plusieurs lignes), code et prix intacts (bug signalé sur Discord)', () => {
  const D = makeDom();
  const txt = String.raw`- \(\pi_\theta\) est la politique formée par le **VAE**.
- Les paramètres \(\theta\) sont ceux de ` + '`policy.net` et `a_b`' + String.raw`.

\[
\sum_{i=1}^{n} x_i^2 \leq \frac{1}{2}
\]
Ça coûte 5$ et 10$.
`;
  for (let i = 0; i < txt.length; i += 17) { D.event({ type: 'text', delta: txt.slice(i, i + 17) }); D.flushFrames(); }
  D.event({ type: 'textEnd' });
  const html = D.log.querySelector('.msg-ai').innerHTML;
  assert.match(html, /<span class="math">π_θ<\/span> est la politique/);
  assert.match(html, /<span class="math">θ<\/span>/);
  assert.match(html, /<div class="math math-block">∑ᵢ₌₁ⁿ xᵢ² ≤ 1\/2<\/div>/);
  assert.match(html, /<code>a_b<\/code>/, 'code jamais converti');
  assert.match(html, /5\$ et 10\$/, 'prix intacts');
  assert.ok(!['\\(', '\\theta', '\\pi', '\\sum'].some(t => html.includes(t)), 'plus aucun LaTeX brut');
});

test('panneau : commande longue → le cadre replié montre les DERNIÈRES lignes (progression), message en file expliqué (vu : rendu de 10 min arrêté faute d\'avancement visible)', () => {
  const D = makeDom();
  D.event({ type: 'tool', name: 'shell', detail: 'python render.py' });
  D.event({ type: 'toolLive', line: '{"gap":[[0,0],[1,-0.3],[2,-0.9],[3,-1.4],[4,-2],[5,-2.4],[6,-2.7],[7,-3],[8,-3.2],[9,-3.4]]}' });
  for (const n of [1200, 2400, 3600, 4800]) D.event({ type: 'toolLive', line: `${n} / 5400` });
  const row = D.log.querySelector('.io-row.out');
  assert.ok(row && row.classList.contains('live') && row.classList.contains('long'), 'sortie en direct : vue sur la fin');
  assert.match(row.querySelector('pre').textContent, /4800 \/ 5400$/);
  const css = fs.readFileSync(path.join(ROOT, 'vscode', 'media', 'panel.css'), 'utf8');
  assert.match(css, /\.io-row\.live\.long:not\(\.open\) \.io-text \{[^}]*linear-gradient\(transparent, #000/, 'fondu en haut : les dernières lignes restent lisibles');
  assert.match(css, /\.msg-user\.queued::after \{ content: 'en file d\\'attente : part à la fin de la tâche en cours \(Échap pour l\\'arrêter\)'/);
});

test('panneau façon Claude Code : tâches en carte (coche, roue, cercle pointillé ; plus de « [~] » brut), fichiers en ligne compacte « Modifié x +135 −8 › » / « Créé y +43 », diff replié', () => {
  const D = makeDom();
  D.event({ type: 'text', delta: 'Plan :\n\n- [x] Ambiance nuit\n- [~] Projecteurs\n- [ ] Rendu final\n' });
  D.event({ type: 'textEnd' }); D.flushFrames();
  const html = D.log.querySelector('.msg-ai').innerHTML;
  assert.match(html, /<ul class="task-card"><li class="task tk done"><span class="ic done"><\/span><span class="tx">Ambiance nuit<\/span>/);
  assert.match(html, /<li class="task tk doing"><span class="ic doing"><\/span><span class="tx">Projecteurs/);
  assert.match(html, /<li class="task tk todo"><span class="ic todo"><\/span><span class="tx">Rendu final/);
  assert.doesNotMatch(html, /\[~\]|☐|☒/);

  D.event({ type: 'tool', name: 'edit_file', detail: 'real_lib.py' });
  const edit = D.log.querySelectorAll('.tool').at(-1);
  assert.equal(edit.querySelector('b').textContent, 'Modification', 'pendant : « Modification »');
  D.event({ type: 'diff', added: 135, removed: 8, lines: [{ t: '-', n: 1, line: 'a' }, { t: '+', n: 1, line: 'b' }] });
  D.event({ type: 'toolDone', ok: true });
  assert.equal(edit.querySelector('b').textContent, 'Modifié');
  assert.equal(edit.querySelector('.cnt').textContent, '+135−8');
  const d = edit.querySelector('.diff');
  assert.equal(d.hidden, true, 'diff replié');
  edit.querySelector('.th').onclick();
  assert.equal(d.hidden, false, 'déplié au clic');
  assert.ok(edit.classList.contains('open'));

  D.event({ type: 'tool', name: 'write_file', detail: 'lookdev_nuit.py' });
  D.event({ type: 'diff', added: 43, removed: 0, lines: [{ t: '+', n: 1, line: 'x' }] });
  D.event({ type: 'toolDone', ok: true });
  const created = D.log.querySelectorAll('.tool').at(-1);
  assert.equal(created.querySelector('b').textContent, 'Créé');
  assert.equal(created.querySelector('.cnt').textContent, '+43');

  D.event({ type: 'tool', name: 'shell', detail: 'python render.py', raw: 'python render.py' });
  const sh = D.log.querySelectorAll('.tool').at(-1);
  assert.ok(sh.querySelector('.el'), 'temps écoulé affiché sur l\'action en cours');
});

test('panneau : bloc d\'actions repliable comme Claude Code (titre en direct pendant le travail, résumé replié à la fin) ; une action seule reste dans le fil', () => {
  const D = makeDom();
  const kids = () => D.log.children.filter(x => !String(x.className).includes('spin'));
  D.event({ type: 'busy', busy: true });
  D.event({ type: 'text', delta: 'Je commence.' }); D.event({ type: 'textEnd' });
  D.event({ type: 'tool', name: 'read_file', detail: 'a.py' }); D.event({ type: 'toolDone', ok: true });
  assert.equal(D.log.querySelectorAll('.acts').length, 0, 'une seule action : pas de bloc');
  D.event({ type: 'tool', name: 'edit_file', detail: 'real_lib.py' });
  const g = D.log.querySelector('.acts');
  assert.ok(g && g.classList.contains('running'), '2e action d\'affilée : bloc ouvert');
  assert.equal(g.querySelector('.acts-l').textContent, 'Modification de real_lib.py');
  assert.equal(g.querySelector('.acts-b').querySelectorAll('.tool').length, 2, 'les deux actions dans le bloc');
  D.event({ type: 'diff', added: 3, removed: 1, lines: [] }); D.event({ type: 'toolDone', ok: true });
  D.event({ type: 'thinking', delta: 'je vérifie' });
  D.event({ type: 'tool', name: 'shell', detail: 'npm test', raw: 'npm test' });
  assert.equal(g.querySelector('.acts-l').textContent, 'En train d’exécuter une commande');
  assert.ok(g.querySelector('.acts-b').querySelector('.think'), 'la réflexion entre deux actions reste dans le bloc');
  D.event({ type: 'toolDone', ok: false });
  D.event({ type: 'text', delta: 'Fini.' }); D.event({ type: 'textEnd' });
  assert.ok(!g.classList.contains('running'), 'texte du modèle : le bloc se referme');
  assert.match(g.querySelector('.acts-l').textContent, /^1 fichier modifié, 1 commande, 1 lecture · 1 en échec$/);
  const body = g.querySelector('.acts-b');
  assert.equal(body.hidden, true, 'replié');
  g.querySelector('.acts-h').onclick();
  assert.equal(body.hidden, false, 'rouvert au clic');
  assert.ok(kids().indexOf(g) < kids().indexOf(D.log.querySelectorAll('.msg-ai').at(-1)), 'la réponse vient après le bloc');
});

test('panneau : une nouvelle liste de tâches REMPLACE la précédente de la même demande (vu : deux cartes presque identiques empilées) ; le texte autour reste ; chaque demande garde sa liste', () => {
  const D = makeDom();
  const cards = () => D.log.querySelectorAll('.msg-ai').map(e => e.innerHTML).join('').split('class="task-card"').length - 1;
  const say = t => { D.event({ type: 'text', delta: t }); D.event({ type: 'textEnd' }); D.flushFrames(); };
  say('Je commence.\n\n- [ ] Repérer la scène\n- [ ] Exporter\n');
  say('- [~] Repérer la scène\n- [ ] Exporter\n');
  D.event({ type: 'tool', name: 'shell', detail: 'ls' }); D.event({ type: 'toolDone', ok: true });
  say('- [x] Repérer la scène\n- [~] Exporter\n');
  assert.equal(cards(), 1, 'une seule liste, la dernière');
  const last = D.log.querySelectorAll('.msg-ai').at(-1).innerHTML;
  assert.match(last, /tk done[\s\S]*Repérer[\s\S]*tk doing[\s\S]*Exporter/);
  assert.match(D.log.querySelectorAll('.msg-ai')[0].innerHTML, /Je commence\./, 'le texte d\'avant reste');
  assert.equal(D.log.querySelectorAll('.msg-ai').length, 2, 'message devenu vide (liste seule) retiré');
  // conversation reprise : même règle, mais une liste par demande
  D.event({ type: 'transcript', messages: [
    { role: 'user', text: 'a' }, { role: 'assistant', text: '- [ ] un\n' }, { role: 'assistant', text: '- [x] un\n' },
    { role: 'user', text: 'b' }, { role: 'assistant', text: '- [ ] deux\n' },
  ] });
  assert.equal(cards(), 2);
  assert.doesNotMatch(D.log.querySelectorAll('.msg-ai').map(e => e.innerHTML).join(''), /tk todo[\s\S]{0,80}>un</, 'l\'ancienne liste « un » remplacée');
});

test('panneau : GPT écrit le plan PUIS sa mise à jour dans le même message (vraie conversation reprise) → une seule liste, la dernière', () => {
  const D = makeDom();
  const all = () => D.log.querySelectorAll('.msg-ai').map(e => e.innerHTML).join('');
  D.event({ type: 'transcript', messages: [
    { role: 'user', text: 'bah aller transforme ca en video' },
    { role: 'assistant', text: '- [ ] Repérer comment la scène se lance\n- [ ] Exporter la course\n- [ ] Vérifier le fichier\n\n- [~] Repérer comment la scène se lance' },
    { role: 'assistant', text: '- [x] Repérer comment la scène se lance\n- [~] Exporter la course' },
    { role: 'assistant', text: '**La course est prête en MP4.**\n\n- [x] Exporter la course\n- [x] Vérifier le fichier\n\n1 min 19 s.' },
  ] });
  assert.equal(all().split('class="task-card"').length - 1, 1, 'une seule liste');
  assert.match(all(), /La course est prête/);
  assert.match(all(), /1 min 19 s/, 'le texte après la liste reste');
  // en direct : même règle dans un seul message
  const L = makeDom();
  L.event({ type: 'text', delta: 'Plan :\n\n- [ ] A\n- [ ] B\n\n- [~] A\n- [ ] B\n' }); L.event({ type: 'textEnd' }); L.flushFrames();
  const html = L.log.querySelector('.msg-ai').innerHTML;
  assert.equal(html.split('class="task-card"').length - 1, 1);
  assert.match(html, /Plan/);
  assert.match(html, /tk doing[\s\S]*>A</);
});
