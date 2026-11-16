#!/usr/bin/env node
/**
 * FS-CLI v3 — agent terminal pour France Student AI
 * Boucle d'agent avec vrais appels d'outils (shell, python, fichiers, recherche, web),
 * permissions, sessions persistantes, changement de modèle à la volée.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

import { cfg, saveCfg, TOKEN, VERSION, FILES, HOME_DIR, ROOT, loadSessions, upsertSession, markSessionsGone } from './src/config.js';
import { fetchChatUsage } from './src/account.js';
import { fetchAgents, listFsProjects, fetchChatsList, requestJson } from './src/api.js';
import { TOOLS, detectEnv, sysEnv, resolveP, runShellDirect, undoLast, startJob, listJobs, stopJob, IS_WIN } from './src/tools.js';
import { runAgent, runBlock, setSelectHandler, baseDir } from './src/agent.js';
import { createInput, attachScreen } from './src/input.js';
import { StdioInput, send as stdioSend } from './src/stdio.js';
import { findEditors, buildVsix, installInto } from './src/vscode-install.js';
import { mcpOverview, connectAll, connectOne } from './src/mcp-status.js';
import { approveServer as approveMcp } from './src/pseudo.js';
import { detectTargetDir } from './src/target.js';
import { sensitivePathReason } from './src/permissions.js';
import { detectIntent, urlsIn } from './src/intent.js';
import { isFolderTrusted, trustFolder, isBroadFolder } from './src/trust.js';
import { loginWizard } from './src/setup.js';
import { runDoctor } from './src/doctor.js';
import { loadCustomCommands, expandCommand } from './src/commands.js';
import { startBridge } from './src/bridge.js';
import { chromeExtensionInstalled, playwrightServer } from './src/browser.js';
import { checkUpdate, INSTALL_CMD } from './src/update.js';
import { grabClipboardImage, readClipboardText, extractImagePaths, IMAGE_RE, MAX_IMAGES, MAX_IMAGE_BYTES, mimeOf } from './src/images.js';
import { uploadFile } from './src/api.js';
import { workPreferences, mentionedServers, serverBrief, wantsBrowser, BROWSER_SERVERS } from './src/pseudo.js';
import { discoverMcpServers, discoverSkills, autoSkills } from './src/discover.js';
import { newSid, createdToday, DAILY_LIMIT } from './src/chats.js';
import { extraCommand, maybeAutoCompact } from './src/extra-commands.js';
import * as mem from './src/memory.js';
import { summarizeChanges, fileDiff, undoFile, changeLine } from './src/changes.js';
import { fetchChat } from './src/api.js';
import { toolsCatalog, loadMcpConfig, saveMcpConfig } from './src/mcp.js';
import { getMcp, activeServers } from './src/mcp-runtime.js';
import * as ui from './src/ui.js';
import { c, println, THEMES } from './src/ui.js';


// ── Arguments ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { print: false, cont: false, model: null, mode: null, cwd: null, help: false, version: false, web: null, prompt: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p' || a === '--print') opts.print = true;
  else if (a === '-c' || a === '--continue') opts.cont = true;
  else if (a === '-m' || a === '--model') opts.model = argv[++i];
  else if (a === '--mode') opts.mode = argv[++i];
  else if (a === '--cwd') opts.cwd = argv[++i];
  else if (a === '--web') opts.web = true;
  else if (a === '--classic') opts.classic = true;
  else if (a === '--stdio') opts.stdio = true;
  else if (a === '--vscode') opts.vscode = true;                 // installe l'extension dans les éditeurs détectés, puis quitte                   // mode machine : extension VS Code
  else if (a === '--login') opts.login = true;
  else if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '-v' || a === '--version') opts.version = true;
  else opts.prompt.push(a);
}
if (opts.version) { console.log(`fs-cli ${VERSION}`); process.exit(0); }
if (opts.vscode) { process.exit(installVscode({ all: true, log: t => console.log(t) }) ? 0 : 1); }
if (opts.stdio) {                                                   // tout passe en événements JSON : rien d'autre ne doit polluer la sortie
  console.log = (...a) => stdioSend('print', { text: a.join(' ') + '\n' });
  console.error = (...a) => stdioSend('print', { text: a.join(' ') + '\n' });
}
if (opts.help) {
  console.log(`FS-CLI ${VERSION} — agent terminal France Student AI

  fs                       session interactive
  fs "fais X"              démarre avec une demande, puis reste en interactif
  fs -p "fais X"           une seule demande, puis quitte (idéal pour scripts)
  echo "fais X" | fs       demande lue depuis stdin
  fs -c                    reprend la dernière session de ce dossier

  -m, --model <id|nom>     modèle (ex: -m opus, -m -2003)
  --mode auto|edits|ask|plan  auto = tout sauf actions dangereuses · edits = fichiers sans demander, commandes confirmées · ask = confirme tout · plan = lecture seule
  --cwd <dossier>          dossier de travail
  --web                    active la recherche web
  --classic                ancienne saisie (readline) au lieu de l'interface plein écran
  --login                  (re)configurer ta clé de session France Student
  -h, --help  -v, --version`);
  process.exit(0);
}

if (opts.login && process.stdin.isTTY) {                                // fs-cli --login : changer de clé de session
  if (!(await loginWizard({ first: false }))) process.exit(1);
}
if (!TOKEN) {
  // premier lancement : assistant de connexion (aucun fichier à éditer) ; sans terminal interactif, on explique
  const canAsk = process.stdin.isTTY && process.stdout.isTTY && !opts.print;
  if (opts.stdio) { stdioSend('needLogin', {}); process.exit(2); }
  if (!canAsk || !(await loginWizard({ first: true }))) {
    if (!canAsk) {
      console.log(c.red('\n  Clé de session France Student manquante.'));
      console.log(c.dim(`  Lance simplement « fs-cli » dans un terminal pour la configurer, ou mets FS_SESSION_TOKEN=... dans ${path.join(HOME_DIR, '.env')}\n`));
    }
    process.exit(1);
  }
}

if (IS_WIN) { try { execSync('chcp 65001', { stdio: 'ignore' }); } catch {} }
try { process.stdout.setDefaultEncoding('utf8'); } catch {}

if (opts.mode && ['auto', 'edits', 'ask', 'plan'].includes(opts.mode)) cfg.mode = opts.mode;
if (opts.web) cfg.webSearch = true;
ui.theme.name = THEMES[cfg.theme] ? cfg.theme : 'cyan';

// ── État ──────────────────────────────────────────────────────────────────────
let AGENTS = {
  '-1002': 'GPT-6 Luna', '-1003': 'GPT-6.1 Sol', '-1004': 'GPT-6 Astra',
  '-2001': 'Claude Opus 5.5', '-2002': 'Claude Haiku 5.5', '-2003': 'Claude Sonnet 5.5', '-2005': 'Claude Fable 5.2',
};
const S = {
  chatId: null, agentId: cfg.agentId, primed: false,
  cwd: opts.cwd ? path.resolve(opts.cwd) : (process.env.FS_WORKDIR || process.cwd()),
  notes: [], allow: {}, undo: [], tokens: { in: 0, out: 0 }, stats: { turns: 0, requests: 0, tools: 0 }, startedAt: Date.now(), lastResponse: '', title: '', pendingFiles: [],
  blocks: [], pendingResults: [], ctxSent: false, ctxPercent: null, lastUserText: '', pendingContext: [], images: [], pendingFileIds: [], mcpSig: '', targetDir: null, sid: newSid(), slots: {},
};
const modelName = (id = S.agentId) => AGENTS[String(id)] || `#${id}`;

function resolveModel(arg) {
  arg = String(arg || '').trim();
  if (!arg) return null;
  if (AGENTS[arg]) return parseInt(arg);
  const keys = Object.keys(AGENTS);
  if (/^\d{1,2}$/.test(arg) && keys[parseInt(arg) - 1]) return parseInt(keys[parseInt(arg) - 1]);
  const low = arg.toLowerCase();
  const hit = keys.find(k => AGENTS[k].toLowerCase() === low) || keys.find(k => AGENTS[k].toLowerCase().includes(low));
  return hit ? parseInt(hit) : null;
}

function saveSession() {
  if (!S.chatId) return;
  upsertSession({ chatId: S.chatId, agentId: S.agentId, cwd: S.cwd, title: S.title || '(sans titre)', ctxSent: S.ctxSent, sid: S.sid, slots: S.slots, targetDir: S.targetDir, toolsHintSig: S.toolsHintSig || '' });
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
ui.spinner.start('démarrage…');
const [agents] = await Promise.all([fetchAgents(), detectEnv()]);
ui.spinner.stop();
if (agents) AGENTS = agents;

if (opts.model) {
  const id = resolveModel(opts.model);
  if (id !== null) { S.agentId = id; cfg.agentId = id; } else console.log(c.yellow(`  modèle "${opts.model}" inconnu — ${modelName()} conservé`));
}
if (opts.cont) {
  const list = loadSessions();
  const s = list.find(x => path.resolve(x.cwd || '') === path.resolve(S.cwd)) || list[0];
  if (s) { applySession(s); if (opts.cwd) { S.cwd = path.resolve(opts.cwd); S.targetDir = null; } }   // --cwd explicite : il gagne sur le dossier de la session reprise
  else console.log(c.dim('  aucune session à reprendre'));
}
function applySession(s) {
  S.chatId = s.chatId; S.agentId = s.agentId || S.agentId; S.title = s.title || '';
  S.ctxSent = s.ctxSent !== false; S.ctxPercent = null; S.blocks = []; S.pendingResults = [];
  S.sid = s.sid || newSid(); S.slots = s.slots || {}; S.targetDir = s.targetDir && fs.existsSync(s.targetDir) ? s.targetDir : null;
  if (s.cwd && fs.existsSync(s.cwd)) S.cwd = s.cwd;
  S.toolsHintSig = s.toolsHintSig || '';                             // outils du PC déjà annoncés dans cette conversation ?
}

// ── Pièces jointes (@fichier) ─────────────────────────────────────────────────
function readAttachment(fp) {
  const st = fs.statSync(fp);
  if (st.isDirectory()) {
    const names = fs.readdirSync(fp, { withFileTypes: true }).slice(0, 150).map(e => e.name + (e.isDirectory() ? '/' : ''));
    return { label: `${path.basename(fp)}/ (${names.length} entrées)`, body: `<fs:file path="${fp}" type="dir">\n${names.join('\n')}\n</fs:file>` };
  }
  const buf = fs.readFileSync(fp);
  if (buf.subarray(0, 4096).includes(0)) return { label: `${path.basename(fp)} (binaire ignoré)`, body: null };
  let text = buf.toString('utf8');
  let cut = '';
  if (text.length > 60000) { text = text.slice(0, 60000); cut = '\n[… tronqué à 60000 caractères — utilise read_file pour la suite]'; }
  const n = text.split('\n').length;
  return { label: `${path.basename(fp)} (${n} lignes)`, body: `<fs:file path="${fp}" lines="${n}">\n${text}${cut}\n</fs:file>` };
}

/** Envoie les images en attente (Files v2) et prépare leurs ids pour ce message ; ajoute une ligne pour que le modèle sache lesquelles. */
async function sendImages(message) {
  const ids = [], names = [];
  const list = S.images.splice(0, S.images.length);
  ui.spinner.start(`envoi de ${list.length} image${list.length > 1 ? 's' : ''}…`);
  try {
    for (const [i, p] of list.entries()) {
      const st = fs.statSync(p);
      if (st.size > MAX_IMAGE_BYTES) { ui.spinner.stop(); println(c.yellow(`  ⚠ ${path.basename(p)} ignorée : trop lourde (max ${MAX_IMAGE_BYTES / 1048576} Mo)`)); continue; }
      ids.push(await uploadFile(fs.readFileSync(p), path.basename(p), mimeOf(p)));
      names.push(`Image #${i + 1} = ${path.basename(p)}`);
    }
  } finally { ui.spinner.stop(); }
  if (!ids.length) return message;
  S.pendingFileIds = ids;
  println(c.dim(`  📎 ${ids.length} image${ids.length > 1 ? 's' : ''} jointe${ids.length > 1 ? 's' : ''} : ${list.map(p => path.basename(p)).join(', ')}`));
  return `${message}\n\n[${ids.length} image${ids.length > 1 ? 's' : ''} jointe${ids.length > 1 ? 's' : ''} à ce message : ${names.join(' ; ')}]`;
}

/** Alt+V / Ctrl+V / /image : image du presse-papiers → jointe au prochain message. */
function pasteClipboardImage() {
  if (S.images.length >= MAX_IMAGES) return ui.out(c.yellow(`\n  ⚠ ${MAX_IMAGES} images maximum par message\n`));
  const p = grabClipboardImage();
  if (!p && input.insert && interactive) {                            // pas d'image : c'était un Ctrl+V de texte qui nous est parvenu → on colle le texte
    const t = readClipboardText();
    if (t) { input.insert(t); return; }
  }
  if (!p) { if (input.flash && interactive) input.flash('pas d\'image dans le presse-papiers (fais une capture avec Win+Maj+S, puis Alt+V)'); else println(c.yellow('  pas d\'image dans le presse-papiers (capture avec Win+Maj+S, puis /image)')); return; }
  S.images.push(p);
  const tag = `[Image #${S.images.length}] `;
  if (input.insert && interactive) input.insert(tag); else println(c.dim(`  📎 ${tag.trim()} prête : elle partira avec ton prochain message`));
}

function buildMessage(text) {
  const atts = [];
  for (const f of S.pendingFiles) atts.push(f);
  S.pendingFiles = [];
  for (const m of text.matchAll(/(?:^|\s)@("[^"]+"|\S+)/g)) {
    const raw = m[1].replace(/^"|"$/g, '').replace(/[.,;:!?)]+$/, '');
    const fp = resolveP(raw, S.cwd);
    try {
      if (!fs.existsSync(fp)) continue;
      const why = sensitivePathReason(fp);   // un @fichier ne doit pas envoyer un secret à l'API sans que tu le saches
      if (why) { println(c.yellow('  ⚠ @' + raw + ' non joint : ' + why)); continue; }
      if (IMAGE_RE.test(fp)) { if (!S.images.includes(fp) && S.images.length < MAX_IMAGES) S.images.push(fp); continue; }   // @image.png : envoyée comme image
      atts.push(readAttachment(fp));
    } catch {}
  }
  let head = '';
  if (S.pendingResults.length) {                       // résultats des /run, joints une seule fois
    head = `Résultat de l'exécution locale :\n${S.pendingResults.join('\n')}\n\n`;
    println(c.dim(`  ↳ ${S.pendingResults.length} résultat${S.pendingResults.length > 1 ? 's' : ''} d'exécution joint${S.pendingResults.length > 1 ? 's' : ''}`));
    S.pendingResults = [];
  }
  if (!atts.length) return head + text;
  for (const a of atts) println(c.dim(`  📎 ${a.label}`));
  return `${head}${text}\n\n${atts.filter(a => a.body).map(a => a.body).join('\n')}`;
}

// ── Presse-papiers ────────────────────────────────────────────────────────────
function copyToClipboard(text) {
  try {
    if (process.platform === 'win32') {
      const input = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
      return spawnSync('clip', { input, windowsHide: true }).status === 0;
    }
    const cmds = process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
    for (const [cmd, a] of cmds) if (spawnSync(cmd, a, { input: text }).status === 0) return true;
  } catch {}
  return false;
}

// ── Complétion ────────────────────────────────────────────────────────────────
const SLASH = ['/help', '/new', '/clear', '/status', '/model ', '/models', '/mode ', '/cd ', '/read ', '/web', '/copy', '/undo',
  '/continue', '/navigateur ', '/doctor', '/vscode', '/projet ', '/rewind', '/changes ', '/plan ', '/messages ', '/usage', '/image', '/import ', '/intent ', '/init', '/fr-project ', '/run ', '/code ', '/hint ', '/auto ', '/context', '/quota', '/compact ', '/autocompact ', '/threshold ', '/retry ', '/compare ', '/duel ',
  '/sound', '/eco', '/remember ', '/forget ', '/memory', '/preprompt ', '/profil ', '/skills', '/skill ', '/project ', '/tree ', '/index', '/history ', '/jobs ', '/feedback ', '/search ', '/fetch ', '/mcp ', '/permissions ', '/target ', '/team ', '/teammode ', '/chats', '/clean', '/workers ', '/parallel ', '/engine ', '/resume', '/sessions', '/theme ', '/think', '/steps ', '/tools', '/id', '/save', '/quit'];

function pathCandidates(frag, dirsOnly = false) {
  const idx = Math.max(frag.lastIndexOf('/'), frag.lastIndexOf('\\'));
  const dirFrag = frag.slice(0, idx + 1), base = frag.slice(idx + 1).toLowerCase();
  let ents = [];
  try { ents = fs.readdirSync(resolveP(dirFrag || '.', S.cwd), { withFileTypes: true }); } catch {}
  return ents.filter(e => e.name.toLowerCase().startsWith(base) && (!dirsOnly || e.isDirectory()))
    .slice(0, 60).map(e => dirFrag + e.name + (e.isDirectory() ? '/' : ''));
}
function completer(line) {
  if (line.startsWith('/') && !line.includes(' ')) { const hits = SLASH.filter(x => x.startsWith(line)); return [hits.length ? hits : SLASH, line]; }
  let m = line.match(/^(\/cd |\/read )(.*)$/);
  if (m) return [pathCandidates(m[2], m[1] === '/cd ').map(x => m[1] + x), line];
  if ((m = line.match(/^(\/model )(.*)$/))) return [Object.values(AGENTS).filter(n => n.toLowerCase().includes(m[2].toLowerCase())).map(n => m[1] + n), line];
  if ((m = line.match(/(?:^|\s)@(\S*)$/))) { const sub = '@' + m[1]; return [pathCandidates(m[1]).map(x => '@' + x), sub]; }
  return [[], line];
}

// ── Readline ──────────────────────────────────────────────────────────────────
// demande initiale : argument positionnel, ou stdin si le CLI est alimenté par un pipe
let initial = opts.prompt.join(' ').trim();
if (!process.stdin.isTTY && !initial && !opts.stdio) {
  try { initial = fs.readFileSync(0, 'utf8').trim(); } catch {}
  opts.print = true;
}
const promptStr = () => `${c.dim(path.basename(S.cwd) || S.cwd)}${cfg.mode === 'ask' ? c.yellow(' ✋') : ''} ${c.accent('❯')} `;

let histLines = [];
try {
  if (fs.existsSync(FILES.hist)) {
    histLines = fs.readFileSync(FILES.hist, 'utf8').split(/\r?\n/).filter(Boolean);
    if (histLines.length > 2000) { histLines = histLines.slice(-1000); fs.writeFileSync(FILES.hist, histLines.join('\n') + '\n'); }
    histLines = histLines.slice(-500);
  }
} catch {}

// suggestions de l'interface plein écran : /commandes, /cd /read /model, @fichiers
function suggest(buf, cur) {
  const upto = buf.slice(0, cur);
  let m = /^\/(\S*)$/.exec(upto);
  if (m && cur === buf.length) {
    const q = m[1].toLowerCase();
    // commandes perso (.fs-cli/commands, .claude/commands…) proposées en premier
    const custom = loadCustomCommands(S.cwd).filter(x => x.name.startsWith(q) || (q.length > 1 && x.name.includes(q)))
      .map(x => ({ label: '/' + x.name + (x.argumentHint ? ' ' + x.argumentHint : ''), insert: '/' + x.name + ' ', desc: `${x.description} ${c.dim('(' + x.source + ')')}` }));
    const items = custom.concat(COMMANDS.filter(x => x.name.slice(1).startsWith(q)).concat(q.length > 1 ? COMMANDS.filter(x => !x.name.slice(1).startsWith(q) && x.name.includes(q)) : [])
      .map(x => ({ label: x.usage.length > 30 ? x.name : x.usage, insert: x.name + (/[<\[]/.test(x.usage) ? ' ' : ''), desc: x.desc })));
    return { start: 0, items };
  }
  if ((m = /^(\/cd |\/read |\/project |\/tree )(.*)$/.exec(upto))) {
    return { start: m[1].length, items: pathCandidates(m[2], m[1] !== '/read ').map(p => ({ label: p, insert: p, desc: '', keepOpen: p.endsWith('/') })) };
  }
  if ((m = /^\/(?:model|duel|workers) (.*)$/.exec(upto))) {
    const q = m[1].toLowerCase();
    return { start: upto.length - m[1].length, items: Object.entries(AGENTS).filter(([, n]) => n.toLowerCase().includes(q)).map(([id, n]) => ({ label: n, insert: n, desc: id })) };
  }
  if ((m = /(?:^|\s)@(\S*)$/.exec(upto))) {
    return { start: upto.length - m[1].length - 1, items: pathCandidates(m[1]).map(p => ({ label: '@' + p, insert: '@' + p, desc: p.endsWith('/') ? 'dossier' : '', keepOpen: p.endsWith('/') })) };
  }
  return null;
}

const interactive = !!opts.stdio || (!!process.stdin.isTTY && !!process.stdout.isTTY && !opts.classic && !opts.print);
const input = opts.stdio ? new StdioInput() : createInput({
  interactive, history: histLines, completer, promptStr, suggester: suggest,
  onHistory: t => { if (t && !opts.print && !/TOKEN\s*=|session-token|sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}/i.test(t)) try { fs.appendFileSync(FILES.hist, t + '\n', { mode: 0o600 }); } catch {} },
});

let busy = false, turnAbort = null;
const ask = query => input.askLine(query);
const refreshStatus = () => input.setStatus({ model: modelName(), mode: cfg.mode, cwd: S.cwd, ctx: S.ctxPercent, ...(opts.stdio ? { modelId: S.agentId, chatId: S.chatId || null, title: S.title || '', project: cfg.fsProject && cfg.fsProject.name ? cfg.fsProject.name : '' } : {}) });
const refreshPrompt = () => { input.setPrompt(promptStr()); refreshStatus(); };

function banner() {
  if (opts.stdio) {
    try {
      const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8')).version;
      if (verNum(bundled) > verNum(PANEL_VER || '0')) setTimeout(() => stdioSend('print', { text: c.yellow(`  ⬆ Nouvelle version du panneau (${bundled}) : tape /vscode puis recharge la fenêtre de l'éditeur`) + '\n' }), 50);
    } catch {}
  }
  if (opts.stdio) return stdioSend('ready', { version: VERSION, shell: sysEnv.shellName, models: Object.entries(AGENTS).map(([id, name]) => ({ id, name })), modes: MODES.map(m => ({ id: m, name: MODE_NAME[m], desc: MODE_DESC[m] })), commands: SLASH.map(x => x.trim()), cwd: S.cwd, chatId: S.chatId || null, title: S.title || '' });
  const sess = S.chatId ? c.dim(S.chatId.slice(0, 8)) : c.dim('nouvelle');
  ui.box([
    `${c.bold(c.accent('FS-CLI'))} ${c.dim('v' + VERSION + ' · France Student AI')}`,
    `${c.dim('modèle  ')} ${c.white(modelName())}`,
    `${c.dim('dossier ')} ${ui.shortPath(S.cwd, 58)}`,
    `${c.dim('mode    ')} ${cfg.engine === 'native' ? c.green('agent natif (outils FS)') : cfg.engine === 'chat' ? (cfg.autoRun ? c.green('chat + exécution auto') : c.white('chat + /run')) : c.white('tools')} ${c.dim('·')} ${cfg.mode === 'auto' ? c.green('auto') : c.yellow('ask')}  ${c.dim('· web')} ${cfg.webSearch ? c.green('on') : c.dim('off')}  ${c.dim('· ' + sysEnv.shellName + (sysEnv.pythonVersion ? ' · py ' + sysEnv.pythonVersion : ''))}`,
    `${c.dim('session ')} ${sess}`,
  ], { title: '◆' });
  println(c.dim('  /help · @fichier pour joindre · !cmd pour un shell direct · Ctrl+C annule\n'));
}

const HELP_ROWS = [
    ['/new', 'nouvelle conversation'], ['/model [nom|id|n°]', 'changer de modèle (conversation conservée)'], ['/models', 'lister les modèles'],
    ['/mode [auto|edits|ask|plan]', 'auto : tout s\'exécute sauf actions dangereuses · edits : fichiers sans demander, commandes confirmées · ask : confirme chaque action · plan : rien n\'est exécuté (Maj+Tab pour changer)'],
    ['/cd <dossier>', 'changer de dossier de travail'], ['/target [dossier|clear]', 'dossier où écrire les fichiers à nom relatif (détecté si ta demande cite un chemin)'], ['/read <fichier>', 'joindre un fichier au prochain message (ou @fichier)'],
    ['/run [n|all]', 'exécuter les blocs de code de la dernière réponse (écrit aussi les fichiers nommés)'],
    ['/context · /quota', 'contexte utilisé de la conversation · quota du compte'],
    ['/compact [consigne]', 'résume la conversation et repart d\'une nouvelle (auto à 80 % : /autocompact, /threshold)'],
    ['/retry [consigne] · /compare', 'relancer la dernière demande · même question à 2 modèles (/duel <modèle>)'],
    ['/remember · /memory · /forget', 'notes persistantes par dossier'],
    ['/preprompt · /profil', 'instructions permanentes · faits appris sur toi'],
    ['/skills · /skill <n°>', 'compétences spécialisées (Fullstack, GLua, Sécurité, DevOps, Python…)'],
    ['/project · /tree · /index', 'changer de projet · arborescence · générer RESUME.md'],
    ['/search · /fetch <url>', 'recherche web · lire une page (adresses locales refusées) ; résultat joint à ton prochain message'],
    ['!& <cmd> · /jobs', 'lancer une commande en arrière-plan (serveur…) · liste, logs, stop'],
    ['/mcp [list|presets|preset|add|test|tools|call|trust]', 'serveurs MCP (Blender, Roblox, filesystem…) : un .mcp.json de projet demande /mcp trust avant de démarrer'],
    ['/team [-n N] [--same|--pool] [--review] <demande>', 'agents qui écrivent chacun leurs fichiers : --same (défaut) à la suite DANS la conversation courante, --pool en parallèle dans des conversations réutilisées · /teammode · /parallel · /workers'],
    ['/chats · /clean', 'qui appartient à quoi (étiquette [id] dans la liste FS, compteur de la limite de 50 nouvelles conversations par jour) · supprimer les conversations d\'agents de la session'],
    ['/permissions', 'règles « toujours autoriser » enregistrées (remove, clear)'],
    ['/feedback [on|off]', 'renvoyer (ou non) les résultats d\'exécution au modèle'],
    ['/history [n°]', 'conversations du compte (reprendre avec le n°)'],
    ['/sound · /eco', 'bip de fin · réponses concises'],
    ['"""', 'saisie multi-ligne : ouvre un bloc, """ de nouveau pour envoyer'],
    ['/code [on|off]', 'afficher le code en entier ou le replier en une ligne (défaut: replié)'],
    ['/hint [on|off]', 'joint une consigne de format (fichiers directs, pas de script générateur) aux demandes de création'],
    ['/auto [on|off]', 'exécution automatique des blocs de la réponse (défaut: on)'],
    ['/engine [chat|tools]', 'chat : /run manuel · tools : boucle d\'outils automatique'],
    ['/web', 'recherche web côté serveur on/off'], ['/continue', 'relancer après la limite d\'étapes'],
    ['/navigateur', 'laisser le modèle piloter un navigateur (chrome : ton Chrome à toi)'], ['/projet', 'travailler dans un projet France Student (ses instructions sont suivies)'], ['/vscode', 'installer le panneau de chat FS-CLI dans VS Code, Cursor, Windsurf, Antigravity'], ['/doctor', 'vérifier l\'installation et dire quoi corriger'], ['/rewind', 'revenir à l\'état des fichiers d\'avant une demande'], ['/changes', 'fichiers modifiés : diff et annulation fichier par fichier'], ['/plan <demande>', 'une demande en lecture seule, puis proposition d\'appliquer'], ['/messages [n]', 'réafficher les derniers messages de la conversation'], ['/usage', 'consommation : budget du compte, conversations du jour, session'], ['/image', 'joindre une image : presse-papiers (aussi Alt+V), /image <chemin>, /image clear'], ['/import', 'MCP et skills de Claude Code, Codex… (on/off)'], ['/intent', 'comprendre les demandes en langage naturel on/off'], ['/init', 'créer FSCLI.md : instructions du projet lues à chaque conversation'],
    ['/fr-project', 'projet du site où ranger les conversations (off pour désactiver)'],
    ['/undo', 'annuler la dernière modification de fichier'], ['/copy', 'copier la dernière réponse'],
    ['/resume [n°]', 'reprendre une session (liste si pas de n°)'], ['/status', 'configuration actuelle'], ['/tools', 'outils disponibles'],
    ['/think', 'afficher/masquer le raisonnement'], ['/steps <n>', 'étapes max par demande'], ['/theme <nom>', Object.keys(THEMES).join(' · ')],
    ['/clear', 'effacer l\'écran'], ['/quit', 'quitter'],
    ['!<commande>', 'exécuter une commande shell directement (sans le modèle)'], ['\\ en fin de ligne', 'continuer sur la ligne suivante'],
];

// commandes proposées dans la liste de suggestions (tirées de l'aide)
const COMMANDS = (() => {
  const seen = new Map();
  for (const [k, desc] of HELP_ROWS) for (const part of k.split(/\s*·\s*/)) {
    const usage = part.trim();
    if (!usage.startsWith('/')) continue;
    const name = usage.split(/\s+/)[0];
    if (!seen.has(name)) seen.set(name, { name, usage, desc });
  }
  for (const [name, desc] of [['/exit', 'quitter'], ['/id', 'identifiant de la conversation'], ['/save', 'sauvegarder la session'], ['/clear', 'effacer l\'écran']])
    if (!seen.has(name)) seen.set(name, { name, usage: name, desc });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
})();

function help() {
  println(); for (const [k, v] of HELP_ROWS) println(`  ${c.accent(k.padEnd(20))} ${c.dim(v)}`); println();
}

function status() {
  println();
  const row = (k, v) => println(`  ${c.dim(k.padEnd(9))} ${v}`);
  row('modèle', c.white(modelName()) + c.dim(`  (${S.agentId})`));
  row('session', S.chatId || c.dim('aucune'));
  row('dossier', S.cwd);
  row('mode', cfg.mode === 'auto' ? c.green('auto') : c.yellow(MODE_NAME[cfg.mode] || cfg.mode));
  row('web', cfg.webSearch ? c.green('on') : c.dim('off'));
  row('shell', sysEnv.shellName);
  row('python', sysEnv.pythonVersion || c.dim('non détecté'));
  row('étapes', `${cfg.maxSteps} max`);
  row('tokens', c.dim(`${S.tokens.in}↑ ${S.tokens.out}↓ (cette exécution)`));
  row('thème', c.accent(cfg.theme));
  println();
}

// ── Commandes ─────────────────────────────────────────────────────────────────
async function withAbort(fn) {
  turnAbort = new AbortController();
  try { return await fn(turnAbort.signal); }
  catch (e) { if (e.name === 'AbortError' || turnAbort?.signal.aborted) { ui.spinner.stop(); println(c.yellow('  ⏹ interrompu')); } else throw e; }
  finally { turnAbort = null; }
}
const extraEnv = () => ({
  S, AGENTS, modelName, resolveModel, withAbort, ask, readAttachment, buildMessage, applySession, refreshPrompt,
  select: input.select ? o => input.select(o) : null,
  chatTurn: (t, o) => chatTurn(t, o),
  ...(opts.stdio && panelAtLeast('0.4.0') ? { mcpPanel: () => openMcpPanel() } : {}),
  ...(opts.stdio && panelAtLeast('0.5.0') ? { card: data => stdioSend('card', data) } : {}),
});

const PANEL_VER = String(process.env.FS_CLI_PANEL || '');            // version de l'extension qui pilote ce CLI (vide = ancienne extension)
const verNum = v => String(v || '0').split('.').map(n => parseInt(n, 10) || 0).reduce((a, n) => a * 1000 + n, 0);
const panelAtLeast = v => !!PANEL_VER && verNum(PANEL_VER) >= verNum(v);

/** sessions dont la conversation existe encore sur le site (vérification légère, en parallèle). Une conversation supprimée est marquée et masquée ;
 *  si aucune vérification n'aboutit (réseau coupé), on ne masque rien. */
async function liveSessions(limit = 50) {
  const list = loadSessions().filter(s => s.chatId && !s.gone).slice(0, limit);
  const check = s => Promise.race([fetchChatUsage(s.chatId).then(r => !!r).catch(() => null), new Promise(r => setTimeout(() => r(null), 5000))]);
  const res = [];
  for (let i = 0; i < list.length; i += 8) res.push(...await Promise.all(list.slice(i, i + 8).map(check)));
  if (!res.some(Boolean)) return list;                               // rien n'a répondu : réseau ? on montre tout
  markSessionsGone(list.filter((s, i) => res[i] === false).map(s => s.chatId));   // seulement un « n'existe pas » net
  const local = list.filter((s, i) => res[i] !== false);              // délai dépassé : gardée (dans le doute, on montre)
  // conversations du compte absentes de ce PC (faites sur un autre PC ou sur le site) : liste du compte + projet choisi
  const known = new Set(loadSessions().map(s => s.chatId));
  const remote = [];
  const add = arr => { for (const x of arr || []) if (x?.id && !known.has(x.id) && !remote.some(r => r.chatId === x.id)) remote.push({ chatId: x.id, title: String(x.title || '(sans titre)').replace(/^\[[0-9a-f]{4}(?:·[^\]]*)?\]\s*/i, ''), agentId: x.agent?.id ?? x.agentId ?? S.agentId, cwd: '', remote: true, updatedAt: Date.parse(x.lastMessageAt || x.createdAt) || 0, ctxSent: true }); };
  try {
    add(await fetchChatsList(30));
    if (cfg.fsProject?.id) add((await requestJson('GET', `/projects/${encodeURIComponent(cfg.fsProject.id)}/chats`).catch(() => ({}))).data?.chats);
  } catch {}
  return [...local, ...remote].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
}

/** messages d'une conversation, sans les ajouts internes de FS-CLI (étiquette, notes, consignes jointes) */
function transcriptOf(chat) {
  const clean = (role, t) => {
    let s = String(t || '');
    if (role === 'user') {
      s = s.replace(/^\[[0-9a-f]{4}(?:·[^\]]*)?\]\s*/i, '');                        // étiquette de session « [7f3a] »
      for (let k = 0; k < 4 && /^\[(?:L'utilisateur|Dossier courant|Info de FS-CLI|Résultats|Contenu de la page|Contexte VS Code)[\s\S]*?\]\s*\n/.test(s); k++) s = s.replace(/^\[[\s\S]*?\]\s*\n/, '');
      const cut = s.search(/\n\n\[(?:Info de FS-CLI|Guide «|Format de réponse|Instructions du projet|Sois concis|Outils MCP|Préprompt|Mémoire|Faits|Contexte)/);
      if (cut > 0) s = s.slice(0, cut);
    }
    return s.trim();
  };
  return (chat?.chatMessages || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, text: clean(m.role, m.content).slice(0, 20000) }))
    .filter(m => m.text);
}

/** fenêtre « Serveurs MCP » du panneau VS Code : la liste tout de suite, puis l'état de chaque serveur dès qu'il est connu */
async function openMcpPanel() {
  const mgr = getMcp(S.cwd);
  const ov = await mcpOverview(S.cwd, mgr);
  stdioSend('mcpPanel', ov);
  connectAll(mgr, ov.servers, r => stdioSend('mcpStatus', r), { timeoutMs: 20000 }).catch(() => {});
}

async function command(line) {
  const [cmd, ...rest] = line.split(/\s+/);
  let arg = line.slice(cmd.length).trim();
  switch (cmd) {
    case '/quit': case '/exit': case '/q': return shutdown(0);
    case '/help': case '/?': return help();
    case '/clear': input.clearScreen(); return banner();
    case '/status': return status();
    case '/id': return println(c.dim('  ' + (S.chatId || 'aucune conversation')));
    case '/save': saveSession(); return println(c.green('  ✓ session sauvegardée') + c.dim(' (auto à chaque échange)'));
    case '/new':
      S.chatId = null; S.toolsHintSig = ''; S.skillsSent = null; S.allow = {}; S.undo = []; S.notes = []; S.title = ''; S.pendingFiles = []; S.blocks = []; S.pendingResults = []; S.ctxSent = false; S.ctxPercent = null; S.pendingContext = []; S.sid = newSid(); S.slots = {};
      if (opts.stdio) { stdioSend('clear'); refreshPrompt(); return; }   // panneau : page vierge (accueil), pas une ligne à la suite
      return println(c.dim('  → nouvelle conversation') + (createdToday() >= DAILY_LIMIT - 8 ? c.yellow(`  (⚠ ${createdToday()}/${DAILY_LIMIT} nouvelles conversations créées aujourd'hui)`) : ''));
    case '/models': {
      println(); Object.entries(AGENTS).forEach(([id, n], i) =>
        println(`  ${c.dim(String(i + 1).padStart(2))}  ${c.dim(id.padStart(6))}  ${n}${id === String(S.agentId) ? c.accent('  ◀') : ''}${cfg.toolRefusals?.[id] ? c.yellow('  · refuse les outils de FS-CLI') : ''}`));
      return println();
    }
    case '/model': {
      if (!arg) { println(c.dim(`  modèle actuel: ${modelName()} — /models pour la liste`)); return; }
      const id = resolveModel(arg);
      if (id === null) return println(c.red(`  modèle inconnu: ${arg}`) + c.dim('  (/models)'));
      S.agentId = id; cfg.agentId = id; saveCfg(); saveSession();
      if (cfg.toolRefusals?.[String(id)]) println(c.yellow('  ⚠ ce modèle a déjà refusé de travailler avec les outils de FS-CLI : il pourra discuter, mais pas lire ni modifier tes fichiers'));
      return println(c.dim(`  → ${modelName()}`) + (S.chatId ? c.dim(' · conversation conservée') : ''));
    }
    case '/mode': {
      const m = arg || (cfg.mode === 'auto' ? 'ask' : 'auto');
      if (!MODES.includes(m)) return println(c.red('  usage: /mode auto|edits|ask|plan'));
      cfg.mode = m; saveCfg(); S.allow = {}; refreshPrompt();
      return println(c.dim(`  → ${MODE_DESC[m]}  ·  Maj+Tab pour changer`));
    }
    case '/web': cfg.webSearch = !cfg.webSearch; saveCfg(); return println(c.dim(`  → web ${cfg.webSearch ? 'on' : 'off'}`));
    case '/think': cfg.showThinking = !cfg.showThinking; saveCfg(); return println(c.dim(`  → raisonnement ${cfg.showThinking ? 'affiché' : 'masqué'}`));
    case '/steps': {
      const n = parseInt(arg);
      if (!n || n < 1 || n > 500) return println(c.red('  usage: /steps <1-500>'));
      cfg.maxSteps = n; saveCfg(); return println(c.dim(`  → ${n} étapes max`));
    }
    case '/theme': {
      if (!THEMES[arg]) return println(c.red('  thèmes: ') + Object.keys(THEMES).join(' · '));
      cfg.theme = arg; ui.theme.name = arg; saveCfg(); refreshPrompt();
      input.clearScreen(); banner();                                   // le texte déjà affiché ne peut pas changer de couleur : on réaffiche avec le nouveau thème
      return println(c.accent(`  → thème ${arg}`) + c.dim('  (la conversation continue, seul l\'écran a été réaffiché)'));
    }
    case '/cd': {
      const dir = resolveP(arg || os.homedir(), S.cwd);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return println(c.red('  dossier introuvable'));
      if (!(await ensureFolderTrust(dir))) return println(c.dim('  dossier inchangé'));
      S.cwd = dir; S.targetDir = null; S.notes.push(`Dossier courant changé : ${dir}`); refreshPrompt(); return println(c.dim('  → ' + dir));
    }
    case '/target': {
      if (!arg) return println(c.dim(S.targetDir ? `  dossier cible : ${S.targetDir}  (détecté dans ta demande ; /target clear pour l'oublier)` : `  pas de dossier cible : les fichiers vont dans ${S.cwd}  (cite un chemin dans ta demande, ou /target <dossier>)`));
      if (/^(clear|off|aucun)$/i.test(arg)) { S.targetDir = null; return println(c.dim('  → dossier cible oublié')); }
      const d = resolveP(arg, S.cwd);
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return println(c.red('  dossier introuvable'));
      S.targetDir = d; return println(c.dim('  → dossier cible : ' + d));
    }
    case '/read': {
      if (!arg) return println(c.red('  usage: /read <fichier>'));
      const fp = resolveP(arg, S.cwd);
      if (!fs.existsSync(fp)) return println(c.red('  fichier introuvable'));
      const a = readAttachment(fp); S.pendingFiles.push(a);
      return println(c.dim(`  📎 ${a.label} — joint au prochain message`));
    }
    case '/copy': {
      if (!S.lastResponse) return println(c.dim('  rien à copier'));
      return println(copyToClipboard(S.lastResponse) ? c.green('  ✓ copié') : c.red('  presse-papiers indisponible'));
    }
    case '/undo': {
      const r = undoLast({ undo: S.undo }, FILES.trash);
      return println(r ? c.green('  ✓ ' + r) : c.dim('  rien à annuler'));
    }
    case '/navigateur': case '/browser': {                            // contrôle du navigateur (Playwright MCP) : ajout + démarrage
      const cfgAll = loadMcpConfig(S.cwd);
      // jeton de l'extension collé (« PLAYWRIGHT_MCP_EXTENSION_TOKEN=… ») : gardé dans la config privée, jamais envoyé au modèle
      const tok = arg.match(/PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*["']?([\w-]{16,})["']?/);
      if (tok) {
        arg = arg.replace(tok[0], '').trim();
        cfgAll.mcpServers.playwright = { ...playwrightServer({ mineChrome: true, token: tok[1], outDir: path.join(HOME_DIR, 'navigateur') }), _scope: 'user' };
        const sv = saveMcpConfig('user', S.cwd, cfgAll);
        println(sv.ok ? c.green('  ✓ jeton de l\'extension enregistré (config privée ~/.fs-cli) : le modèle pilote TON Chrome sans redemander l\'autorisation') : c.red('  ✗ ' + sv.error));
        if (!arg) return;
      }
      // 1er mot = mode éventuel (chrome / separe / off) ; le reste = une demande à faire tout de suite avec le navigateur
      const [first = '', ...more] = arg.split(/\s+/).filter(Boolean);
      const MODE_CHROME = /^(chrome|mon[- ]?chrome|extension)$/i, MODE_SEP = /^(separe|séparé|normal|playwright)$/i;
      if (/^(off|non|retirer)$/i.test(first)) {
        if (cfgAll.mcpServers.playwright?._scope === 'user') { delete cfgAll.mcpServers.playwright; saveMcpConfig('user', S.cwd, cfgAll); }
        return println(c.dim('  → contrôle du navigateur retiré'));
      }
      const cur = cfgAll.mcpServers.playwright;
      const curChrome = !!cur?.args?.includes('--extension');
      const mineChrome = MODE_CHROME.test(first) ? true : MODE_SEP.test(first) ? false : (cur ? curChrome : false);   // sans mode précisé : on garde l'actuel
      const request = (MODE_CHROME.test(first) || MODE_SEP.test(first) ? more : [first, ...more]).join(' ').trim();
      if (mineChrome && !chromeExtensionInstalled()) {                  // mode « ton Chrome » sans l'extension : on ne bascule pas, on explique
        if (curChrome) {                                               // déjà en mode Chrome sans extension : retour au navigateur séparé pour que ça marche
          cfgAll.mcpServers.playwright = { ...playwrightServer({ outDir: path.join(HOME_DIR, 'navigateur') }), _scope: 'user' };
          saveMcpConfig('user', S.cwd, cfgAll);
          println(c.dim('  (retour au navigateur séparé en attendant l\'extension)'));
        }
        const STORE = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm';
        println(c.yellow('  ⚠ L\'extension « Playwright MCP Bridge » n\'est pas installée dans ton Chrome : sans elle, le modèle ne peut pas piloter TON Chrome.'));
        println(c.dim(`  1. Installe-la : ${STORE}`));
        println(c.dim('  2. Puis relance : /navigateur chrome'));
        const open = input.select && interactive ? await input.select({ title: 'Ouvrir la page de l\'extension dans Chrome ?', options: ['Oui, l\'ouvrir', 'Non'], defaultIndex: 0 }) : 1;
        if (open === 0) { try { spawnSync('cmd', ['/c', 'start', '', STORE], { windowsHide: true }); } catch {} }
        return println(c.dim(cur ? '  (le navigateur actuel reste actif)' : '  En attendant, /navigateur active un navigateur séparé (sans tes comptes).'));
      }
      const needSetup = !cur || curChrome !== mineChrome || !cur.args?.includes('--caps');   // ancienne config sans vision/pdf/devtools : mise à niveau
      if (needSetup) {
        const want = playwrightServer({ mineChrome, token: mineChrome ? cur?.env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN : '', outDir: path.join(HOME_DIR, 'navigateur') });   // le jeton de l'extension est conservé
        cfgAll.mcpServers.playwright = { ...want, _scope: 'user' };
        const saved = saveMcpConfig('user', S.cwd, cfgAll);
        if (!saved.ok) return println(c.red('  ✗ ' + saved.error));
        if (mineChrome) {
          println(c.dim('  Mode « ton Chrome » : le modèle pilote TON navigateur, avec tes comptes déjà connectés.'));
          println(c.dim('  Il faut l\'extension « Playwright MCP Bridge » du Chrome Web Store ; à la 1re action, Chrome te demandera d\'autoriser la connexion.'));
        }
        ui.spinner.start('préparation du navigateur (1re fois : téléchargement)…');
        try {
          const tools = await getMcp(S.cwd).listTools('playwright');
          ui.spinner.stop();
          println(c.green(`  ✓ contrôle du navigateur prêt${mineChrome ? ' (ton Chrome)' : ''} : ${tools.length} actions (ouvrir une page, cliquer, remplir, capturer l'écran…)`));
        } catch (e) { ui.spinner.stop(); return println(c.red('  ✗ démarrage impossible : ' + e.message) + c.dim('\n  Il faut Google Chrome installé et Node.js (npx).')); }
      } else if (!request) println(c.green(`  ✓ contrôle du navigateur déjà actif${mineChrome ? ' (ton Chrome)' : ' (navigateur séparé)'}`));
      if (request) return chatTurn(/navigateur|chrome|browser/i.test(request) ? request : `${request} (dans le navigateur)`);   // la demande part directement
      println(c.dim('  Demande simplement : « va sur youtube.com et cherche … », ou /navigateur ouvre quick.fr'));
      return println(c.dim(mineChrome ? '  /navigateur separe pour le navigateur séparé · /navigateur off pour retirer' : '  /navigateur chrome pour piloter TON Chrome (comptes connectés) · /navigateur off pour retirer'));
    }
    case '/vscode': case '/extension': {                            // installe l'extension (panneau de chat) dans VS Code, Cursor, Windsurf, Antigravity…
      const eds = findEditors();
      if (!eds.length) return println(c.yellow('  aucun éditeur compatible trouvé (VS Code, Cursor, Windsurf, Antigravity)') + c.dim('\n  installe-en un, ou télécharge le .vsix dans les releases GitHub'));
      let pick = eds;
      if (eds.length > 1 && input.select && interactive && !/^(tous|all)$/i.test(arg)) {
        const idx = await input.select({ title: 'Installer l\'extension FS-CLI dans quel éditeur ?', detail: 'Elle ajoute un panneau de chat FS-CLI (icône France Student dans la barre latérale).', options: ['Tous : ' + eds.map(e => e.name).join(', '), ...eds.map(e => e.name), 'Annuler'] });
        if (idx == null || idx > eds.length) return println(c.dim('  rien n\'a été installé'));
        pick = idx === 0 ? eds : [eds[idx - 1]];
      }
      ui.spinner.start('installation de l\'extension…');
      try { installVscode({ editors: pick, log: println }); } finally { ui.spinner.stop(); }
      return;
    }
    case '/doctor': {                                                 // vérifie l'installation et dit quoi corriger
      ui.spinner.start('vérification…');
      const checks = await runDoctor(S);
      ui.spinner.stop();
      println();
      for (const k of checks) {
        const icon = k.level === 'ok' ? c.green('✓') : k.level === 'warn' ? c.yellow('⚠') : c.red('✗');
        println(`  ${icon} ${c.bold(k.label.padEnd(20))} ${k.level === 'ok' ? c.dim(k.detail) : k.detail}`);
        if (k.fix) println(`    ${' '.repeat(20)} ${c.dim('→')} ${c.accent(k.fix)}`);
      }
      const bad = checks.filter(k => k.level !== 'ok').length;
      return println(bad ? c.dim(`\n  ${bad} point${bad > 1 ? 's' : ''} à regarder\n`) : c.green('\n  tout est en ordre\n'));
    }
    case '/rewind': {                                                 // revenir à l'état d'avant une demande : tous ses fichiers d'un coup
      const marks = (S.turnMarks || []).map((m, i) => ({ ...m, i, changes: S.undo.length - m.at })).filter(m => m.changes > 0).reverse();
      if (!marks.length) return println(c.dim('  rien à annuler : aucune modification de fichier depuis le début de la session'));
      const label = m => `avant « ${m.text}${m.text.length >= 70 ? '…' : ''} » · ${m.changes} modif${m.changes > 1 ? 's' : ''} annulée${m.changes > 1 ? 's' : ''} · ${new Date(m.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
      let pick = null;
      if (/^\d+$/.test(arg)) pick = marks[parseInt(arg, 10) - 1] || null;
      else if (input.select && interactive) {
        const idx = await input.select({ title: 'Revenir à l\'état des fichiers d\'avant quelle demande ?', detail: 'Les fichiers modifiés par le modèle depuis cette demande reprennent leur ancien contenu ; ceux qu\'il a créés partent dans la corbeille du CLI. Les effets des commandes (npm install…) ne sont pas annulés.', options: [...marks.slice(0, 9).map(label), 'Annuler'], defaultIndex: 0 });
        pick = idx == null || idx >= Math.min(9, marks.length) ? null : marks[idx];
      } else { marks.slice(0, 9).forEach((m, i) => println(`  ${c.accent(String(i + 1))}  ${label(m)}`)); return println(c.dim('\n  /rewind <n°> pour revenir à ce point\n')); }
      if (!pick) return println(c.dim('  rien n\'a été annulé'));
      const done = [];
      while (S.undo.length > pick.at) { const r = undoLast({ undo: S.undo }, FILES.trash); if (!r) break; done.push(r); }
      S.turnMarks = S.turnMarks.slice(0, pick.i + 1);
      S.notes.push(`L'utilisateur a annulé (/rewind) toutes les modifications de fichiers faites depuis sa demande « ${pick.text} » : ces fichiers sont revenus à leur état d'avant. Relis-les avant de les modifier.`);
      println(c.green(`  ✓ retour à l'état d'avant « ${pick.text} » : ${done.length} modification${done.length > 1 ? 's' : ''} annulée${done.length > 1 ? 's' : ''}`));
      for (const d of done.slice(0, 12)) println(c.dim('    ' + d));
      if (done.length > 12) println(c.dim(`    … +${done.length - 12}`));
      return;
    }
    case '/changes': case '/diff': {                                  // fichiers modifiés dans la session : diff et annulation fichier par fichier
      const files = summarizeChanges(S.undo, 0);
      if (!files.length) return println(c.dim('  aucun fichier modifié par le modèle dans cette session'));
      const [sub, num] = /^(undo|annuler)\b/i.test(arg) ? ['undo', arg.split(/\s+/)[1]] : ['diff', arg];
      const at = n => files[parseInt(n, 10) - 1];
      const showDiff = f => {
        const d = fileDiff(S.undo, f.path);
        println(`\n  ${changeLine(f, S.cwd, c)}`);
        if (f.binary) return println(c.dim('  ⎿  fichier binaire : pas de diff'));
        ui.diffView(d.before, d.after, { max: 80 });
      };
      const doUndo = f => {
        const r = undoFile(S, f.path, FILES.trash);
        S.notes.push(`L'utilisateur a annulé tes modifications du fichier ${f.path} (retour à son état d'avant). Relis-le avant de le modifier.`);
        println(c.green(`  ✓ ${r}`));
      };
      if (num && !at(num)) return println(c.red(`  numéro inconnu (1 à ${files.length})`));
      if (sub === 'undo' && num) return doUndo(at(num));
      if (sub === 'diff' && num) return showDiff(at(num));
      if (input.select && interactive) {
        const idx = await input.select({ title: `Fichiers modifiés dans cette session · ${files.length}`, detail: 'Choisis un fichier pour voir son diff ou l\'annuler.', options: [...files.slice(0, 9).map(f => changeLine(f, S.cwd, c)), 'Fermer'] });
        const f = idx == null || idx >= Math.min(9, files.length) ? null : files[idx];
        if (!f) return;
        showDiff(f);
        const act = await input.select({ title: `Annuler les modifications de ${path.basename(f.path)} ?`, detail: f.created ? 'Le fichier a été créé par le modèle : il partira dans la corbeille du CLI (récupérable).' : 'Le fichier reprendra son contenu d\'avant la première modification du modèle. Les autres fichiers ne bougent pas.', options: ['Non, garder', 'Oui, annuler ce fichier'] });
        if (act === 1) doUndo(f);
        return;
      }
      println(); files.forEach((f, i) => println(`  ${c.accent(String(i + 1).padStart(2))}  ${changeLine(f, S.cwd, c)}`));
      return println(c.dim('\n  /changes <n°> : voir le diff · /changes undo <n°> : annuler ce fichier\n'));
    }
    case '/plan': {                                                   // /plan <demande> : une demande en lecture seule, puis proposition d'appliquer
      if (!arg) { cfg.mode = 'plan'; saveCfg(); S.allow = {}; refreshPrompt(); return println(c.dim(`  → ${MODE_DESC.plan}  ·  /plan <demande> pour une seule demande`)); }
      const prev = cfg.mode;
      cfg.mode = 'plan'; S.allow = {}; refreshPrompt();
      try { await chatTurn(arg); }
      finally { if (cfg.mode === 'plan' && prev !== 'plan') { cfg.mode = prev; S.allow = {}; refreshPrompt(); println(c.dim(`  ↩ retour au mode ${MODE_NAME[prev]}`)); } }
      return;
    }
    case '/messages': {                                               // réafficher les derniers messages de la conversation
      if (!S.chatId) return println(c.dim('  pas encore de conversation'));
      const n = Math.min(100, Math.max(1, parseInt(arg, 10) || 10));
      ui.spinner.start('lecture de la conversation…');
      const data = await fetchChat(S.chatId).finally(() => ui.spinner.stop());
      const msgs = (data?.chatMessages || []).filter(m => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
      if (!msgs.length) return println(c.dim('  aucun message lisible'));
      const shown = msgs.slice(-n);
      println(c.dim(`\n  ${shown.length} dernier${shown.length > 1 ? 's' : ''} message${shown.length > 1 ? 's' : ''} sur ${msgs.length}\n`));
      for (const m of shown) {
        const txt = ui.sanitize(String(m.content)).replace(/^\[[^\]]{0,4000}\]\s*/s, '').trim();   // note client en tête (contexte joint) retirée
        if (m.role === 'user') println(c.dim('> ') + (txt.length > 600 ? txt.slice(0, 600) + c.dim(' …') : txt).split('\n').join('\n  '));
        else { const md = new ui.MdStream({ collapse: false }); md.push(txt.length > 4000 ? txt.slice(0, 4000) + '\n\n… (tronqué : /copy pour la dernière réponse entière)' : txt); md.finish(); }
        println();
      }
      return;
    }
    case '/tools': {
      println(); for (const [n, t] of Object.entries(TOOLS)) println(`  ${c.accent(n.padEnd(11))} ${c.dim(t.risk.padEnd(6))} ${t.desc().split('.')[0]}`);
      return println();
    }
    case '/sessions': case '/resume': case '/load': {
      ui.spinner.start('conversations…');
      const list = await liveSessions(12).finally(() => ui.spinner.stop());   // sans celles supprimées du site
      if (!list.length) return println(c.dim('  aucune session sauvegardée'));
      const n = parseInt(arg) || (cmd === '/load' ? 1 : 0);
      if (n >= 1 && list[n - 1]) {
        applySession(list[n - 1]); refreshPrompt();
        return println(c.green(`  ✓ conversation reprise`) + c.dim(` · ${list[n - 1].title} · ${modelName()}`));
      }
      println();
      list.forEach((s, i) => println(`  ${c.accent(String(i + 1).padStart(2))}  ${ui.clip(s.title, 44).padEnd(44)} ${c.dim(modelName(s.agentId).padEnd(18))} ${c.dim(ui.shortPath(s.cwd || '', 30))}`));
      return println(c.dim('\n  /resume <n°> pour reprendre\n'));
    }
    case '/engine': {
      if (!arg) return println(c.dim(`  moteur : ${cfg.engine}${S.nativeOff ? ' (natif indisponible sur ce modèle : chat utilisé)' : ''} — /engine native · chat`));
      const e = arg.toLowerCase();
      if (!['native', 'chat'].includes(e)) return println(c.red('  usage: /engine native|chat'));
      cfg.engine = e; cfg.engineExplicit = true; S.nativeOff = false; saveCfg();
      return println(c.dim(e === 'native' ? '  → natif : vrais appels d\'outils (lire, éditer, chercher, lancer des commandes) via le mode officiel « outils client » de FS'
        : '  → chat : le modèle écrit du code, le CLI l\'exécute (secours)'));
    }
    case '/code': {
      cfg.showCode = arg ? /^(on|1|oui|true)$/i.test(arg) : !cfg.showCode; saveCfg();
      return println(c.dim(`  → code ${cfg.showCode ? 'affiché en entier' : 'replié en une ligne (compact)'}`));
    }
    case '/hint': {
      cfg.fileHint = arg ? /^(on|1|oui|true)$/i.test(arg) : !cfg.fileHint; saveCfg();
      return println(c.dim(`  → consigne « fichiers directs » ${cfg.fileHint ? 'ON' : 'OFF'}`));
    }
    case '/auto': {
      const v = arg ? /^(on|1|oui|true)$/i.test(arg) : !cfg.autoRun;
      cfg.autoRun = v; saveCfg();
      return println(c.dim(v ? '  → exécution automatique ON : le code de la réponse s\'exécute tout seul (actions dangereuses et écrasements = confirmation)' : '  → exécution automatique OFF : utilise /run'));
    }
    case '/run': {
      if (!S.blocks.length) return println(c.dim('  aucun bloc exécutable dans la dernière réponse'));
      if (!arg) {
        println();
        S.blocks.forEach((b, i) => println(`  ${c.accent(String(i + 1))}  ${c.bold(b.action === 'write' ? 'écrire ' + b.name : b.action === 'mcp' ? 'mcp ' + b.name : b.action + (b.source ? ` · panneau ${b.name}` : ''))}  ${c.dim(ui.clip(b.code.split('\n').find(l => l.trim()) || '', 60))}`));
        return println(c.dim('\n  /run all · /run 1 · /run 1 3\n'));
      }
      const idx = arg === 'all' ? S.blocks.map((_, i) => i) : arg.split(/[\s,]+/).map(n => parseInt(n) - 1).filter(i => S.blocks[i]);
      if (!idx.length) return println(c.red('  numéro de bloc invalide'));
      turnAbort = new AbortController();
      try { for (const i of idx) { if (turnAbort.signal.aborted) break; await runBlock(S, S.blocks[i], { signal: turnAbort.signal, ask }); } }
      finally { turnAbort = null; }
      return println('\n' + c.dim('  ↳ résultats joints à ton prochain message'));
    }
    case '/continue': return chatTurn('Continue.', { keepLast: true });
    case '/image': {                                                  // /image : presse-papiers · /image <chemin> : fichier · /image clear
      if (/^(clear|aucune|off)$/i.test(arg)) { S.images = []; return println(c.dim('  → images en attente retirées')); }
      if (!arg) { pasteClipboardImage(); return; }
      const p = resolveP(arg, S.cwd);
      if (!fs.existsSync(p) || !IMAGE_RE.test(p)) return println(c.red('  image introuvable (png, jpg, gif, webp, bmp)'));
      if (S.images.length >= MAX_IMAGES) return println(c.yellow(`  ${MAX_IMAGES} images maximum par message`));
      S.images.push(p); return println(c.dim(`  📎 [Image #${S.images.length}] ${path.basename(p)} : elle partira avec ton prochain message`));
    }
    case '/import': {                                                 // MCP et skills des autres assistants (Claude Code, Codex…)
      if (/^(on|off|oui|non)$/i.test(arg)) { cfg.importTools = /^(on|oui)$/i.test(arg); saveCfg(); }
      if (cfg.importTools === false) return println(c.dim('  import désactivé — /import on pour utiliser les MCP et skills de Claude Code, Codex…'));
      const servers = discoverMcpServers(S.cwd), skills = discoverSkills(S.cwd, { refresh: true });
      const by = (arr, k) => arr.reduce((a, x) => (a[x[k]] = (a[x[k]] || 0) + 1, a), {});
      println();
      println(`  ${c.bold('Serveurs MCP importés')} ${c.dim(`(${Object.keys(servers).length})`)}`);
      for (const [n, s] of Object.entries(servers)) println(`    ${c.accent(n.padEnd(18))} ${c.dim(s._source + ' · ' + (s.url ? 'http' : 'stdio'))}`);
      println(`  ${c.bold('Skills')} ${c.dim(`(${skills.length})`)}  ${c.dim(Object.entries(by(skills, 'source')).map(([k, v]) => `${k} : ${v}`).join(' · '))}`);
      println(c.dim('\n  Le modèle les utilise tout seul quand c\'est utile ; un serveur importé demande ton accord à son premier démarrage.'));
      return println(c.dim('  /import off pour désactiver · /mcp pour tous les serveurs\n'));
    }
    case '/intent':                                                   // compréhension des demandes en langage naturel
      cfg.intents = arg ? /^(on|1|oui|true)$/i.test(arg) : cfg.intents === false; saveCfg();
      return println(c.dim(`  → demandes en langage naturel ${cfg.intents ? 'ON (« fais ce site avec plusieurs agents » lance une équipe…)' : 'OFF (seules les /commandes déclenchent les fonctions)'}`));
    default: {
      if (await extraCommand(cmd, arg, extraEnv())) return;
      const custom = loadCustomCommands(S.cwd).find(x => '/' + x.name === cmd.toLowerCase());   // commande perso : son texte part comme une demande
      if (custom) { println(c.dim(`  ↳ commande perso /${custom.name} (${custom.source})`)); return chatTurn(expandCommand(custom, arg)); }
      const skill = discoverSkills(S.cwd).find(x => '/' + x.name.toLowerCase() === cmd.toLowerCase());   // skill du PC appelé par son nom
      if (skill) { println(c.dim(`  ↳ skill ${skill.name} (${skill.source})`)); S.forceSkills = [skill]; S.skillsSent?.delete(skill.name); return chatTurn(arg || `Utilise le guide « ${skill.name} » pour la suite de ce projet.`); }
      return println(c.red(`  commande inconnue: ${cmd}`) + c.dim('  (/help)'));
    }
  }
}

// ── Tour de chat ──────────────────────────────────────────────────────────────
const FILE_INTENT = /\b(html|css|site|page web|fichiers?|écris|ecris|crée|cree|génère|genere|fais|code|script)\b/i;
const formatHint = () => `[Format de réponse souhaité : pour chaque fichier à créer, un bloc de code dont la ligne d'ouverture donne le langage et le nom du fichier, par exemple \`\`\`html index.html — avec le contenu final du fichier lui-même, pas un script qui le génère. ${S.targetDir ? `Dossier cible : ${S.targetDir} (un nom relatif y sera écrit, sous-dossiers possibles, ex. \`\`\`html monsite/index.html).` : `Dossier de travail actuel : ${S.cwd} (un nom relatif y sera écrit ; pour un autre dossier, mets le chemin complet dans le nom du fichier).`}]`;

/** « ● Fichiers modifiés · 3 » après une demande qui a écrit des fichiers (comme FranceStudent Code) */
function printTurnChanges() {
  const mark = (S.turnMarks || []).at(-1);
  if (!mark || S.undo.length <= mark.at) return;
  const files = summarizeChanges(S.undo, mark.at);
  if (opts.stdio) return stdioSend('changes', { files: files.map(f => ({ path: f.path, rel: path.relative(S.cwd, f.path), added: f.added, removed: f.removed, created: f.created, deleted: f.deleted, binary: f.binary })) });
  const add = files.reduce((n, f) => n + f.added, 0), rem = files.reduce((n, f) => n + f.removed, 0);
  println(`\n  ${c.green('●')} ${c.bold('Fichiers modifiés')} ${c.dim(`· ${files.length}`)}  ${add ? c.green('+' + add) : ''} ${rem ? c.red('−' + rem) : ''}`);
  files.slice(0, 12).forEach((f, i) => println(`  ${i === 0 ? c.dim('  └') : '   '} ${changeLine(f, S.cwd, c)}`));
  if (files.length > 12) println(c.dim(`      … +${files.length - 12} autres`));
  println(c.dim('    /changes pour voir les diffs ou annuler un fichier'));
}

async function chatTurn(text, { keepLast = false } = {}) {
  turnAbort = new AbortController();
  println();
  try {
    ui.tasks.clear();                                                  // nouvelle demande : le panneau de tâches repart de zéro
    ui.resetThinking();
    if (!keepLast) { S.turnMarks ||= []; S.turnMarks.push({ at: S.undo.length, text: text.replace(/\s+/g, ' ').trim().slice(0, 70), t: Date.now() }); if (S.turnMarks.length > 50) S.turnMarks.shift(); }   // repère pour /rewind
    await maybeAutoCompact(S, turnAbort.signal);                       // contexte plein → résumé + nouvelle conversation
    const ex = extractImagePaths(text, S.images.length);               // image glissée-déposée (chemin collé) → [Image #n]
    if (ex.paths.length) { text = ex.text; for (const p of ex.paths) if (!S.images.includes(p)) S.images.push(p); }
    const dir = detectTargetDir(text);                                // « … dans C:\Users\moi\Downloads\SITE » → les fichiers y seront écrits
    if (dir && dir !== S.targetDir) { S.targetDir = dir; println(c.dim(`  ＋ dossier cible : ${dir}  (/target pour voir ou effacer)`)); }
    let message = buildMessage(text);
    if (S.images.length) message = await sendImages(message);          // images : envoyées sur Files v2 puis jointes au message
    if (cfg.engine === 'chat' && cfg.fileHint && FILE_INTENT.test(text)) {
      message += '\n\n' + formatHint();
      println(c.dim('  ＋ consigne de format jointe : fichiers directs (/hint pour désactiver)'));
    }
    if (cfg.eco) message += '\n\n[Sois concis : pas d\'introduction ni de conclusion.]';
    if (S.pendingContext.length) {                                     // résultats /search, /fetch, /mcp joints une seule fois
      message = `${S.pendingContext.join('\n\n')}\n\n${message}`; S.pendingContext = [];
    }
    const mcpNames = activeServers(S.cwd).join(',');                   // outils MCP : catalogue joint quand les serveurs actifs changent
    if (cfg.engine !== 'native' && mcpNames && (mcpNames !== S.mcpSig)) {
      ui.spinner.start('connexion aux serveurs MCP…');
      const cat = await toolsCatalog(getMcp(S.cwd)).catch(() => ''); ui.spinner.stop();
      S.mcpSig = mcpNames;
      if (cat) {
        message += `\n\n[Outils MCP disponibles sur cette machine. Pour en appeler un, écris un bloc de code dont la première ligne est \`\`\`mcp serveur.outil et dont le contenu est les arguments en JSON.]\n${cat}`;
        println(c.dim(`  ＋ outils MCP joints : ${mcpNames}`));
      }
    }
    if (!S.ctxSent) {                                                  // préprompt, faits, notes, skills : 1er message d'une conversation
      if (S.pendingSummary) { message = `[Reprise : résumé de la conversation précédente (même session de travail), à garder comme contexte]\n${S.pendingSummary}\n\n[Nouvelle demande de l'utilisateur]\n${message}`; println(c.dim('  ＋ résumé de la conversation précédente')); }
      const { text: ctxText, label } = mem.buildContextBlock(S.cwd);
      if (ctxText) { message += '\n\n' + ctxText; println(c.dim(`  ＋ contexte joint : ${label}`)); }
      if (cfg.fsProject && cfg.fsProject.id) {                         // projet France Student choisi (/projet) : ses instructions personnalisées
        if (S.fsProjInstr?.id !== cfg.fsProject.id) S.fsProjInstr = { id: cfg.fsProject.id, text: String((await listFsProjects().catch(() => [])).find(p => p.id === cfg.fsProject.id)?.customInstructions || '').trim() };
        if (S.fsProjInstr.text) { message += `\n\n[Instructions du projet France Student « ${cfg.fsProject.name} » de l'utilisateur, à suivre :\n${S.fsProjInstr.text.slice(0, 8000)}]`; println(c.dim(`  ＋ instructions du projet « ${cfg.fsProject.name} »`)); }
      }
      S.ctxSent = true;
    }
    if (cfg.engine === 'native') {                                     // MCP et skills du PC : annoncés à toute conversation qui ne les a pas encore vus (y compris après /resume)
      const prefs = workPreferences();                                // préférences de forme seulement (pas de protocole d'outils dans le texte)
      if (prefs.sig !== S.toolsHintSig) { message += '\n\n' + prefs.text; S.toolsHintSig = prefs.sig; }
      for (const name of mentionedServers(S.cwd, text)) {               // « à l'aide du mcp leboncoin » → ses outils sont joints à la demande
        const brief = await serverBrief(S, name, { signal: turnAbort.signal, ask });
        if (brief) { message = `${brief}\n\n${message}`; println(c.dim(`  ＋ outils MCP joints : ${name}`)); }   // avant la demande : plus visible
      }
      if (wantsBrowser(text)) {
        const pw = loadMcpConfig(S.cwd).mcpServers || {};
        if (!Object.keys(pw).some(n => BROWSER_SERVERS.test(n))) println(c.yellow('  💡 Pour que je pilote le navigateur, active-le une fois avec /navigateur'));
        else if (pw.playwright?.args?.includes('--extension') && !chromeExtensionInstalled()) println(c.yellow('  ⚠ Mode « ton Chrome » sans l\'extension Playwright MCP Bridge : installe-la, ou tape /navigateur separe'));
      }
    }
    if (!keepLast) {                                                   // skills choisis automatiquement pour cette demande (correspondance nette seulement)
      S.skillsSent ||= new Set();
      let budget = 20000;
      const forced = S.forceSkills || []; S.forceSkills = null;        // /nom-du-skill : joint en premier, même sans correspondance
      for (const sk of [...forced, ...autoSkills(discoverSkills(S.cwd), text).filter(s => !forced.some(f => f.name === s.name))].filter(s => !S.skillsSent.has(s.name))) {
        let body = ''; try { body = fs.readFileSync(sk.file, 'utf8').replace(/^﻿/, ''); } catch { continue; }
        body = body.length > Math.min(12000, budget) ? body.slice(0, Math.min(12000, budget)) + '\n[… guide tronqué ; la suite est dans ' + sk.file + ']' : body;
        if (budget <= 1000) break;
        budget -= body.length;
        message += `\n\n[Guide « ${sk.name} » de l'utilisateur, à appliquer s'il est pertinent (sans le recopier) ; ses autres fichiers sont dans ${sk.dir}. Il complète la demande sans la remplacer : fais ce que l'utilisateur demande avec tes outils, et ignore les étapes du guide qui citent des outils que tu n'as pas.\n${body}]`;
        S.skillsSent.add(sk.name);
        println(c.dim(`  ＋ skill : ${sk.name}`));
      }
    }
    if (!keepLast) S.lastUserText = text;
    mem.observe(text, S.cwd);
    if (!S.title) S.title = text.replace(/\s+/g, ' ').slice(0, 60);
    try {
      await runAgent(S, message, { signal: turnAbort.signal, ask });
      if (S.chatId && S.pendingSummary) { S.pendingSummary = null; S.compactedFrom = null; }   // nouvelle conversation ouverte avec le résumé
      if (!cfg.showThinking && ui.thinkingLength() > 40) println(c.dim('  ✻ le modèle a réfléchi avant de répondre (ctrl+o pour voir)'));
      if (!opts.stdio && ui.tasks.blocks > 1 && ui.tasks.list.length) {               // liste mise à jour pendant le travail : état final écrit une seule fois
        const L = ui.tasks.list, done = L.filter(t => t.state === 'done').length;
        println(`
  ${done === L.length ? c.green('●') : c.accent('●')} ${c.bold('Tâches')} ${c.dim(`· ${done}/${L.length} faites`)}`);
        L.forEach((t, i) => println(`  ${i === 0 ? c.dim('  └') : '   '} ${ui.taskLine(t.state, t.text)}`));
      }
      printTurnChanges();                                              // bilan des fichiers touchés par cette demande
      // mode plan : le modèle a proposé un plan → on demande s'il faut l'appliquer (comme Claude Code)
      if (cfg.mode === 'plan' && interactive && input.select && (S.lastResponse || '').trim()) {
        const idx = await input.select({
          title: 'Appliquer ce plan ?',
          detail: 'Le modèle a travaillé en lecture seule. Choisis comment il doit maintenant l\'exécuter.',
          options: ['Oui, tout automatiquement (mode auto)', 'Oui, fichiers automatiques mais commandes confirmées (mode modifs auto)', 'Oui, en validant chaque action (mode confirmer)', 'Non, continuer à planifier'],
          defaultIndex: 0,
        });
        if (idx >= 0 && idx <= 2) S.afterPlan = ['auto', 'edits', 'ask'][idx];
      }
    }
    finally { S.pendingFileIds = []; ui.tasks.set([]); }               // images : seulement ce message ; panneau de tâches vidé (sinon affiché en double)
  } catch (e) {
    if (/Chat not found/i.test(e.message || '') && S.chatId) {        // conversation supprimée du site entre-temps : on repart sur une neuve
      markSessionsGone([S.chatId]);
      S.chatId = null; S.ctxSent = false; S.toolsHintSig = ''; S.skillsSent = null; S.ctxPercent = null; S.lastPromptTokens = 0;
      println(c.yellow('  cette conversation a été supprimée du site : ton message part dans une nouvelle conversation'));
      turnAbort = null;
      return chatTurn(text, { keepLast: true });
    }
    if (e.code === 'DAILY_CHAT_LIMIT' && S.compactedFrom && !S.chatId) {   // impossible d'ouvrir la conversation légère : on reste dans l'actuelle, rien n'est perdu
      S.chatId = S.compactedFrom; S.compactedFrom = null; S.pendingSummary = null; S.ctxSent = true;
      println(c.yellow('  limite des 50 conversations atteinte : on continue dans la conversation actuelle'));
      turnAbort = null;
      return chatTurn(text, { keepLast: true });
    }
    if (e.name === 'AbortError' || turnAbort.signal.aborted) {
      ui.spinner.stop();
      println(c.yellow('\n  ⏹ interrompu'));
      S.notes.push("L'utilisateur a interrompu (Ctrl+C) ta réponse ou l'exécution de tes outils juste avant ce message.");
    } else throw e;
  } finally {
    turnAbort = null;
    saveSession();
  }
  println();
  if (S.afterPlan) {                                                   // plan approuvé : on change de mode et on lance l'exécution
    cfg.mode = S.afterPlan; S.afterPlan = null; saveCfg(); S.allow = {}; refreshPrompt();
    println(c.green(`  ✓ plan approuvé : exécution en mode ${MODE_NAME[cfg.mode]}`));
    return chatTurn('Le plan est approuvé : exécute-le maintenant, étape par étape, en tenant la liste de tâches à jour.');
  }
}

async function direct(cmdline) {
  if (!cmdline.trim()) return;
  if (cmdline.trim().startsWith('&')) {                          // !& commande → en arrière-plan
    const cmd = cmdline.trim().slice(1).trim();
    if (!cmd) return println(c.red('  usage: !& <commande>'));
    const j = startJob(cmd, S.cwd);
    return println(c.green('  ● ') + `job ${c.accent(String(j.id))} lancé en arrière-plan ${c.dim('(/jobs · /jobs logs ' + j.id + ' · /jobs stop ' + j.id + ')')}`);
  }
  turnAbort = new AbortController();
  println();
  try {
    const r = await runShellDirect(cmdline, { cwd: S.cwd, signal: turnAbort.signal });
    if (r.code) println(c.dim(`  [code ${r.code}]`));
  } finally { turnAbort = null; }
  println();
}

/** Demande en langage naturel → fonction du CLI (équipe d'agents, comparaison, mémoire, quota…). Renvoie true si elle a été traitée. */
async function naturalIntent(t) {
  const r = detectIntent(t);
  if (!r) return false;
  println(c.dim(`  ↳ compris : ${r.label}`) + c.dim(r.cmd === '/team' ? '  (dis « sans agents » pour l\'éviter)' : ''));
  const prevDuel = cfg.duelModel;
  if (r.duelModel) { const id = resolveModel(r.duelModel); if (id !== null && id !== S.agentId) cfg.duelModel = id; }
  try { await command(`${r.cmd} ${r.arg}`.trim()); }
  finally { cfg.duelModel = prevDuel; }
  return true;
}

async function handleInput(text) {
  busy = true; input.setBusy(true);
  try {
    const t = text.trim();
    if (!t) return;
    if (!t.includes('\n') && t.startsWith('/')) await command(t);
    else if (!t.includes('\n') && t.startsWith('!')) await direct(t.slice(1));
    else if (!t.includes('\n') && /^#\s*\S/.test(t) && !/^##/.test(t)) await command('/remember ' + t.replace(/^#\s*/, ''));   // « # info » : retenue en mémoire (comme Claude Code)
    else if ((cfg.intents !== false || /PLAYWRIGHT_MCP_EXTENSION_TOKEN/.test(t)) && await naturalIntent(t)) return;   // un jeton collé ne part jamais au modèle
    else {
      if (cfg.intents !== false && cfg.engine === 'native') {     // le modèle n'a pas d'accès web : une URL citée est lue et jointe
        if (!wantsBrowser(t)) for (const u of urlsIn(t)) await extraCommand('/fetch', u, extraEnv());   // « va sur … dans le navigateur » : c'est le navigateur qui ira, pas un téléchargement
      }
      await chatTurn(t);
    }
  } catch (e) {
    ui.spinner.stop();
    println(c.red(`\n  Erreur: ${e.message}`));
    if (/401|expiré/.test(e.message)) println(c.dim('  → ta clé de session a expiré : quitte puis lance « fs-cli --login »'));
  } finally {
    busy = false; input.setBusy(false);
    refreshPrompt();
    if (!opts.print) input.prompt();
  }
}

/** traite une saisie puis les messages mis en file d'attente pendant le travail */
async function runInput(text) {
  await handleInput(text);
  for (;;) {
    if (busy) return;
    const next = input.takeQueued();
    if (!next) return;
    await handleInput(next);
  }
}

const MODES = ['auto', 'edits', 'ask', 'plan'];
const MODE_NAME = { auto: 'auto', edits: 'modifs auto', ask: 'confirmer', plan: 'plan' };
const MODE_DESC = {
  auto: "mode auto : tout s'exécute (confirmation seulement pour les actions dangereuses)",
  edits: 'mode modifs auto : fichiers modifiés sans demander, commandes confirmées',
  ask: 'mode confirmer : demande avant chaque écriture ou commande',
  plan: "mode plan : lecture seule, rien n'est exécuté",
};
function cycleMode() {
  cfg.mode = MODES[(MODES.indexOf(cfg.mode) + 1) % MODES.length]; saveCfg(); S.allow = {};
  input.flash?.(MODE_DESC[cfg.mode]);
  refreshPrompt();
}

// ── Entrées (interface plein écran ou readline) ───────────────────────────────
input.on('submit', t => { runInput(t); });
input.on('interrupt', () => { turnAbort?.abort(); });
input.on('cycleMode', cycleMode);
ui.tasks.on(list => input.setTasks?.(list));                          // liste de tâches du modèle → panneau épinglé
await startBridge({ getManager: () => getMcp(S.cwd), getCwd: () => S.cwd });   // pont local : fs-mcp garde les serveurs MCP ouverts (navigateur…)
input.on('rewind', () => { if (!busy) runInput('/rewind'); });      // Échap ×2 : revenir en arrière
input.on('expand', () => ui.showExpanded());                          // Ctrl+O : déplier les sorties résumées et la pensée
input.on('pasteImage', () => { try { pasteClipboardImage(); } catch (e) { println(c.red('  image : ' + e.message)); } });
input.on('quit', () => { shutdown(0); });
if (opts.stdio) {                                                    // commandes directes du panneau VS Code
  input.on('setMode', m => { if (MODES.includes(m)) { cfg.mode = m; saveCfg(); S.allow = {}; refreshPrompt(); } });
  input.on('setModel', id => { const r = resolveModel(id); if (r !== null) { S.agentId = r; cfg.agentId = r; saveCfg(); saveSession(); refreshPrompt(); } });
  input.on('diffBefore', (id, file) => {                               // contenu d'avant d'un fichier modifié (diff natif de VS Code) : seulement les fichiers touchés par le modèle
    const abs = path.resolve(baseDir(S), String(file || ''));                 // relatif au dossier de travail (ou au dossier cible)
    const d = fileDiff(S.undo, abs) || fileDiff(S.undo, path.resolve(S.cwd, String(file || '')));
    stdioSend('diffBefore', { id, path: d ? (fileDiff(S.undo, abs) ? abs : path.resolve(S.cwd, String(file || ''))) : abs, ok: !!d, before: d ? d.before : '', created: d ? d.created : false });
  });
  // ── fenêtre « Conversations » (horloge du panneau) : liste des sessions, reprise avec réaffichage des messages ──
  // ── fenêtre « Commandes & skills » (bouton « / » du panneau) ──
  const skillsPayload = () => {
    const off = new Set((cfg.disabledSkills || []).map(x => String(x).toLowerCase()));
    const size = f => { try { return Math.round(fs.statSync(f).size / 3.5); } catch { return 0; } };
    return {
      skills: discoverSkills(S.cwd, { all: true }).map(s => ({ name: s.name, source: s.source, description: s.description.slice(0, 200), tokens: size(s.file), enabled: !off.has(s.name.toLowerCase()) })),
      commands: loadCustomCommands(S.cwd).map(x => ({ name: x.name, source: x.source, description: String(x.description || '').slice(0, 200) })),
      fs: mem.loadSkills().map(s => ({ name: s.id, label: s.name, source: 'France Student', description: String(s.description || '').slice(0, 200), enabled: cfg.skills.includes(s.id) })),
    };
  };
  input.on('skillsOpen', () => stdioSend('skills', skillsPayload()));
  input.on('skillToggle', (kind, name) => {
    if (kind === 'fs') { const set = new Set(cfg.skills); if (set.has(name)) set.delete(name); else set.add(name); cfg.skills = [...set]; }
    else { const n = name.toLowerCase(), set = new Set((cfg.disabledSkills || []).map(x => String(x).toLowerCase())); if (set.has(n)) set.delete(n); else set.add(n); cfg.disabledSkills = [...set]; S.toolsHintSig = ''; }
    saveCfg(); stdioSend('skills', skillsPayload());
  });
  input.on('historyOpen', async () => {
    const here = path.resolve(S.cwd).toLowerCase();
    stdioSend('history', { sessions: (await liveSessions(50)).map(s => ({
      chatId: s.chatId, title: String(s.title || '(sans titre)').slice(0, 120), model: modelName(s.agentId), cwd: s.cwd || (s.remote ? 'compte France Student' : ''), remote: !!s.remote,
      here: !!s.cwd && path.resolve(s.cwd).toLowerCase() === here, updatedAt: s.updatedAt || 0, current: s.chatId === S.chatId,
    })) });
  });
  input.on('resumeChat', async chatId => {
    if (busy) return stdioSend('flash', { text: 'attends la fin de la réponse pour changer de conversation' });
    const s = loadSessions().find(x => x.chatId === chatId) || { chatId, title: '', agentId: S.agentId, ctxSent: true };   // conversation du compte (autre PC, site)
    applySession(s); refreshPrompt(); saveSession();
    let messages = [];
    try { messages = transcriptOf(await fetchChat(chatId)); } catch {}
    stdioSend('transcript', { title: s.title || '', model: modelName(), messages: messages.slice(-40), older: Math.max(0, messages.length - 40) });
  });
  input.on('mcpAction', async (action, name) => {                    // boutons de la fenêtre « Serveurs MCP »
    const mgr = getMcp(S.cwd), sv = loadMcpConfig(S.cwd).mcpServers?.[name];
    if (action === 'refresh') return openMcpPanel();
    if (!sv) return;
    try {
      if (action === 'approve') {
        if (!(await approveMcp(S, name, sv, { ask }))) return stdioSend('mcpStatus', { name, status: 'approve' });
        action = 'connect';
      }
      if (action === 'connect') { stdioSend('mcpStatus', { name, status: 'connecting' }); return stdioSend('mcpStatus', await connectOne(mgr, name)); }
      if (action === 'login') {                                        // connexion au compte : page de connexion dans le navigateur
        const { login } = await import('./src/mcp-oauth.js');
        stdioSend('mcpStatus', { name, status: 'connecting', note: 'connexion dans ton navigateur…' });
        await login(sv.url, { onUrl: u => stdioSend('mcpLoginUrl', { name, url: u }) });
        await mgr.closeAll();
        return stdioSend('mcpStatus', await connectOne(mgr, name));
      }
      if (action === 'toggle') { await extraCommand('/mcp', `toggle ${name}`, extraEnv()); return openMcpPanel(); }
      if (action === 'trust') { await extraCommand('/mcp', 'trust', extraEnv()); return openMcpPanel(); }
    } catch (e) { stdioSend('mcpStatus', { name, status: 'error', error: String(e?.message || e) }); }
  });
  input.on('undoFile', file => {                                       // bouton « Annuler » d'un fichier du bilan
    if (busy) return stdioSend('flash', { text: 'attends la fin de la réponse pour annuler un fichier' });
    let r;
    try { r = undoFile(S, file, FILES.trash); } catch (e) { return stdioSend('flash', { text: `impossible d'annuler : ${e.code || e.message}` }); }
    if (!r) return stdioSend('flash', { text: 'rien à annuler pour ce fichier' });
    S.notes.push(`L'utilisateur a annulé tes modifications du fichier ${file} (retour à son état d'avant). Relis-le avant de le modifier.`);
    stdioSend('fileUndone', { path: file, message: r });
  });
}
process.on('exit', () => { try { input.stop(); } catch {} });
process.on('unhandledRejection', e => { ui.spinner.stop(); println(c.red(`\n  Erreur: ${e?.message || e}`)); });

/** Fabrique le .vsix depuis le dossier vscode/ du CLI et l'installe dans les éditeurs choisis. Renvoie true si au moins une installation a réussi. */
function installVscode({ editors = null, all = false, log }) {
  const eds = editors || findEditors();
  if (!eds.length) { log(c.yellow('  aucun éditeur compatible trouvé (VS Code, Cursor, Windsurf, Antigravity)')); return false; }
  let v;
  try { v = buildVsix(); } catch (e) { log(c.red('  ' + e.message)); return false; }
  let ok = 0;
  for (const ed of eds) {
    const r = installInto(ed, v.file);
    if (r.ok) ok++;
    log(r.ok ? c.green(`  ✓ extension FS-CLI ${v.version} installée dans ${ed.name}`) : c.red(`  ✗ ${ed.name} : ${r.out || 'échec'}`));
  }
  if (ok) log(c.dim('  → recharge la fenêtre de l\'éditeur (Ctrl+Maj+P › « Reload Window ») puis clique sur l\'icône France Student à gauche'));
  return ok > 0;
}

/** Première ouverture d'un dossier : on demande la confiance avant que le modèle puisse y agir. */
async function ensureFolderTrust(dir) {
  if (isFolderTrusted(dir)) return true;
  const broad = isBroadFolder(dir);
  const detail = `Le modèle pourra lire et modifier les fichiers de ce dossier et y lancer des commandes (avec confirmation pour les actions sensibles).` +
    (broad ? `\n⚠ C'est un dossier très large (racine du disque ou dossier personnel) : préfère le dossier précis d'un projet.` : '\nLa confiance vaut aussi pour ses sous-dossiers.');
  const options = broad ? ['Oui, pour cette session seulement', 'Non'] : ['Oui, je fais confiance à ce dossier', 'Oui, pour cette session seulement', 'Non'];
  let idx;
  if (input.select && interactive) idx = await input.select({ title: `Faire confiance à ce dossier ? ${dir}`, detail, options, defaultIndex: 0 });
  else {
    println(c.yellow(`  ? Faire confiance à ce dossier ? ${dir}`)); println(c.dim('    ' + detail.replace(/\n/g, '\n    ')));
    const a = ((await ask(`  [o]ui / [s]ession seulement / [N]on `)) || '').trim().toLowerCase();
    idx = /^(o|oui|y|yes)$/.test(a) ? (broad ? 0 : 0) : /^s/.test(a) ? (broad ? 0 : 1) : options.length - 1;
  }
  if (idx === null || idx === undefined || options[idx] === 'Non') return false;
  trustFolder(dir, { remember: options[idx].startsWith('Oui, je') });
  return true;
}

/** Sortie propre : on ferme d'abord les serveurs MCP (sinon Node peut planter sous Windows en fermant leurs connexions). */
let stopping = false;
async function shutdown(code = 0, { quiet = false } = {}) {
  if (stopping) return; stopping = true;
  saveSession();
  for (const j of listJobs()) if (j.status === 'running') stopJob(j.id);   // serveurs lancés en arrière-plan : arrêtés avec la session (sinon cachés et oubliés)
  try { await Promise.race([getMcp(S.cwd).closeAll(), new Promise(r => setTimeout(r, 2000))]); } catch {}
  try { input.stop(); } catch {}
  if (!quiet) console.log(c.dim('  à bientôt'));
  await new Promise(r => setTimeout(r, 150));                      // laisse les connexions réseau finir de se fermer
  process.exit(code);
}

// ── Lancement ─────────────────────────────────────────────────────────────────
if (opts.print) {
  if (!initial) { console.log(c.red('  -p nécessite une demande')); process.exit(1); }
  await handleInput(initial);
  await shutdown(0, { quiet: true });
}

if (interactive) {
  attachScreen(input);
  if (input.select) setSelectHandler(o => input.select(o));        // menus de confirmation à flèches
  input.start();
}
refreshPrompt();
banner();
if (opts.stdio) input.setBusy(true);                                 // panneau : rien ne part au modèle tant que la confiance n'est pas décidée
if (!(await ensureFolderTrust(S.cwd))) {
  println(c.dim('  Dossier non approuvé : relance FS-CLI depuis le dossier de ton projet (ou --cwd <dossier>).'));
  saveSession(); input.stop(); process.exit(0);
}
if (opts.stdio) { input.setBusy(false); const q = input.takeQueued(); if (q) runInput(q); }
if (!opts.stdio && !cfg.vscodeTip) {                                 // une seule fois : le panneau de chat existe aussi pour l'éditeur
  try { const eds = findEditors(); if (eds.length) println(c.dim('  💡 FS-CLI existe aussi en panneau de chat dans ' + eds.map(e => e.name).join(', ') + ' : tape ') + c.accent('/vscode')); } catch {}
  cfg.vscodeTip = true; saveCfg();
}
// où ranger les conversations sur le site ? demandé une seule fois (avant : projet « FS-CLI » imposé)
if (interactive && input.select && !cfg.fsProjectChosen) {
  const idx = await input.select({ title: 'Où ranger tes conversations FS-CLI sur le site France Student ?', detail: 'Tu pourras changer plus tard avec /projet.',
    options: ['Dans mes conversations normales (visibles dans la liste du site)', 'Dans un de mes projets existants…', '＋ Créer un nouveau projet…'], defaultIndex: 0 });
  cfg.fsProjectChosen = true;
  if (idx === 1) { saveCfg(); await extraCommand('/projet', '', extraEnv()); }
  else if (idx === 2) { saveCfg(); await extraCommand('/projet', 'nouveau', extraEnv()); }
  else cfg.fsProject = false;
  saveCfg();
}
// nouvelle version disponible ? (en arrière-plan, au plus une fois toutes les 12 h, n'empêche jamais de démarrer)
checkUpdate().then(u => {
  if (!u.newer) return;
  println(c.yellow(`  ⬆ FS-CLI v${u.latest} est disponible (tu as la v${u.current}). Pour mettre à jour :`));
  println(`    ${c.accent(INSTALL_CMD)}`);
  if (!busy) input.prompt();
}).catch(() => {});
if (initial) await runInput(initial); else input.prompt();
