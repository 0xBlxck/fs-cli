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

import { cfg, saveCfg, TOKEN, VERSION, FILES, HOME_DIR, ROOT, loadSessions, upsertSession } from './src/config.js';
import { fetchAgents } from './src/api.js';
import { TOOLS, detectEnv, sysEnv, resolveP, runShellDirect, undoLast, startJob, IS_WIN } from './src/tools.js';
import { runAgent, runBlock, setSelectHandler } from './src/agent.js';
import { createInput, attachScreen } from './src/input.js';
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
import { toolsHint, mentionedServers, serverBrief, wantsBrowser, BROWSER_SERVERS } from './src/pseudo.js';
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
  else if (a === '--login') opts.login = true;
  else if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '-v' || a === '--version') opts.version = true;
  else opts.prompt.push(a);
}
if (opts.version) { console.log(`fs-cli ${VERSION}`); process.exit(0); }
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
  '/continue', '/navigateur ', '/doctor', '/rewind', '/changes ', '/plan ', '/messages ', '/usage', '/image', '/import ', '/intent ', '/init', '/fr-project ', '/run ', '/code ', '/hint ', '/auto ', '/context', '/quota', '/compact ', '/autocompact ', '/threshold ', '/retry ', '/compare ', '/duel ',
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
if (!process.stdin.isTTY && !initial) {
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

const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !opts.classic && !opts.print;
const input = createInput({
  interactive, history: histLines, completer, promptStr, suggester: suggest,
  onHistory: t => { if (t && !opts.print && !/TOKEN\s*=|session-token|sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}/i.test(t)) try { fs.appendFileSync(FILES.hist, t + '\n', { mode: 0o600 }); } catch {} },
});

let busy = false, turnAbort = null;
const ask = query => input.askLine(query);
const refreshStatus = () => input.setStatus({ model: modelName(), mode: cfg.mode, cwd: S.cwd, ctx: S.ctxPercent });
const refreshPrompt = () => { input.setPrompt(promptStr()); refreshStatus(); };

function banner() {
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
    ['/navigateur', 'laisser le modèle piloter un navigateur (chrome : ton Chrome à toi)'], ['/doctor', 'vérifier l\'installation et dire quoi corriger'], ['/rewind', 'revenir à l\'état des fichiers d\'avant une demande'], ['/changes', 'fichiers modifiés : diff et annulation fichier par fichier'], ['/plan <demande>', 'une demande en lecture seule, puis proposition d\'appliquer'], ['/messages [n]', 'réafficher les derniers messages de la conversation'], ['/usage', 'consommation : budget du compte, conversations du jour, session'], ['/image', 'joindre une image : presse-papiers (aussi Alt+V), /image <chemin>, /image clear'], ['/import', 'MCP et skills de Claude Code, Codex… (on/off)'], ['/intent', 'comprendre les demandes en langage naturel on/off'], ['/init', 'créer FSCLI.md : instructions du projet lues à chaque conversation'],
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
});

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
      return println(c.dim('  → nouvelle conversation') + (createdToday() >= DAILY_LIMIT - 8 ? c.yellow(`  (⚠ ${createdToday()}/${DAILY_LIMIT} nouvelles conversations créées aujourd'hui)`) : ''));
    case '/models': {
      println(); Object.entries(AGENTS).forEach(([id, n], i) =>
        println(`  ${c.dim(String(i + 1).padStart(2))}  ${c.dim(id.padStart(6))}  ${n}${id === String(S.agentId) ? c.accent('  ◀') : ''}`));
      return println();
    }
    case '/model': {
      if (!arg) { println(c.dim(`  modèle actuel: ${modelName()} — /models pour la liste`)); return; }
      const id = resolveModel(arg);
      if (id === null) return println(c.red(`  modèle inconnu: ${arg}`) + c.dim('  (/models)'));
      S.agentId = id; cfg.agentId = id; saveCfg(); saveSession();
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
        pick = idx == null ? null : marks[idx] || null;
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
        const f = idx == null ? null : files[idx];
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
      const list = loadSessions().slice(0, 12);
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
      const { text: ctxText, label } = mem.buildContextBlock(S.cwd);
      if (ctxText) { message += '\n\n' + ctxText; println(c.dim(`  ＋ contexte joint : ${label}`)); }
      S.ctxSent = true;
    }
    if (cfg.engine === 'native') {                                     // MCP et skills du PC : annoncés à toute conversation qui ne les a pas encore vus (y compris après /resume)
      const hint = toolsHint(S.cwd, text);
      if (hint.text && hint.sig !== S.toolsHintSig) { message += '\n\n' + hint.text; S.toolsHintSig = hint.sig; println(c.dim(`  ＋ outils du PC : ${hint.label}`)); }
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
      for (const sk of autoSkills(discoverSkills(S.cwd), text).filter(s => !S.skillsSent.has(s.name))) {
        let body = ''; try { body = fs.readFileSync(sk.file, 'utf8').replace(/^﻿/, ''); } catch { continue; }
        body = body.length > Math.min(12000, budget) ? body.slice(0, Math.min(12000, budget)) + '\n[… guide tronqué ; la suite est dans ' + sk.file + ']' : body;
        if (budget <= 1000) break;
        budget -= body.length;
        message += `\n\n[Guide « ${sk.name} » : skill installé sur le PC de l'utilisateur, choisi automatiquement par FS-CLI pour cette demande. Applique-le s'il est pertinent (sans le recopier) ; ses autres fichiers sont dans ${sk.dir}.\n${body}]`;
        S.skillsSent.add(sk.name);
        println(c.dim(`  ＋ skill : ${sk.name}`));
      }
    }
    if (!keepLast) S.lastUserText = text;
    mem.observe(text, S.cwd);
    if (!S.title) S.title = text.replace(/\s+/g, ' ').slice(0, 60);
    try {
      await runAgent(S, message, { signal: turnAbort.signal, ask });
      if (!cfg.showThinking && ui.thinkingLength() > 40) println(c.dim('  ✻ le modèle a réfléchi avant de répondre (ctrl+o pour voir)'));
      if (ui.tasks.blocks > 1 && ui.tasks.list.length) {               // liste mise à jour pendant le travail : état final écrit une seule fois
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
process.on('exit', () => { try { input.stop(); } catch {} });
process.on('unhandledRejection', e => { ui.spinner.stop(); println(c.red(`\n  Erreur: ${e?.message || e}`)); });

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
if (!(await ensureFolderTrust(S.cwd))) {
  println(c.dim('  Dossier non approuvé : relance FS-CLI depuis le dossier de ton projet (ou --cwd <dossier>).'));
  saveSession(); input.stop(); process.exit(0);
}
// nouvelle version disponible ? (en arrière-plan, au plus une fois toutes les 12 h, n'empêche jamais de démarrer)
checkUpdate().then(u => {
  if (!u.newer) return;
  println(c.yellow(`  ⬆ FS-CLI v${u.latest} est disponible (tu as la v${u.current}). Pour mettre à jour :`));
  println(`    ${c.accent(INSTALL_CMD)}`);
  if (!busy) input.prompt();
}).catch(() => {});
if (initial) await runInput(initial); else input.prompt();
