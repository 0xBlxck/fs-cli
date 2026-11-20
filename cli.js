#!/usr/bin/env node
/**
 * FS-CLI v3 — agent terminal pour France Student AI
 * Boucle d'agent avec vrais appels d'outils (shell, python, fichiers, recherche, web),
 * permissions, sessions persistantes, changement de modèle à la volée.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync, spawn } from 'node:child_process';

import { cfg, saveCfg, saveCfgKeys, TOKEN, VERSION, FILES, HOME_DIR, ROOT, loadSessions, upsertSession, markSessionsGone, unmarkSessionsGone, encodeHistory, decodeHistory, historyKeeps } from './src/config.js';
import { fetchChatUsage, contextPercent, chatBudget } from './src/account.js';
import { fetchAgents, listFsProjects, fetchChatsList, requestJson, renameChat, deleteChat, setProjectOnce, setProjectOverride, effectiveProject } from './src/api.js';
import { TOOLS, detectEnv, sysEnv, resolveP, runShellDirect, undoLast, startJob, listJobs, stopJob, IS_WIN } from './src/tools.js';
import { runAgent, runBlock, setSelectHandler, baseDir } from './src/agent.js';
import { createInput, attachScreen } from './src/input.js';
import { StdioInput, send as stdioSend } from './src/stdio.js';
import { findEditors, buildVsix, installInto } from './src/vscode-install.js';
import { mcpOverview, connectAll, connectOne } from './src/mcp-status.js';
import { approveServer as approveMcp } from './src/pseudo.js';
import { detectTargetDir, acceptTarget, targetNote } from './src/target.js';
import { sensitivePathReason } from './src/permissions.js';
import { detectIntent, urlsIn, isSlashCommand } from './src/intent.js';
import { isFolderTrusted, trustFolder, isBroadFolder } from './src/trust.js';
import { loginWizard } from './src/setup.js';
import { runDoctor } from './src/doctor.js';
import { loadCustomCommands, expandCommand } from './src/commands.js';
import { startBridge } from './src/bridge.js';
import { chromeExtensionInstalled, playwrightServer } from './src/browser.js';
import { checkUpdate, INSTALL_CMD, npmPermissionHelp, globalDirWritable, isNpmPermissionError } from './src/update.js';
import { grabClipboardImage, readClipboardText, extractImagePaths, IMAGE_RE, isImagePath, prepareImage, MAX_IMAGES, MAX_IMAGE_BYTES, mimeOf } from './src/images.js';
import { uploadFile } from './src/api.js';
import { workPreferences, mentionedServers, serverBrief, wantsBrowser, BROWSER_SERVERS } from './src/pseudo.js';
import { discoverMcpServers, discoverSkills, autoSkills, skillIndex } from './src/discover.js';
import { newSid, createdToday, DAILY_LIMIT } from './src/chats.js';
import { sortedModelIds } from './src/models-order.js';
import { FALLBACK_AGENTS } from './src/agents-table.js';
import { stripEditorContext } from './src/editor-context.js';
import { extraCommand, maybeAutoCompact, notifyWebhook, deleteProjectFlow, EFFORT_LEVELS, EFFORT_DESC } from './src/extra-commands.js';
import { runTeam } from './src/team.js';
import { WHATS_NEW, latestNews } from './src/whatsnew.js';
const PALETTE_KEY = process.platform === 'darwin' ? 'Cmd+Maj+P' : 'Ctrl+Maj+P';   // palette de commandes de l'éditeur (VS Code, Cursor…)
import { isOpenAiModel } from './src/native.js';
import * as mem from './src/memory.js';
import { summarizeChanges, fileDiff, undoFile, changeLine } from './src/changes.js';
import { fetchChat, isBrokenHistory, isLockedChat } from './src/api.js';
import { toolsCatalog, loadMcpConfig, saveMcpConfig } from './src/mcp.js';
import { getMcp, activeServers } from './src/mcp-runtime.js';
import * as ui from './src/ui.js';
import { c, println, THEMES } from './src/ui.js';

// fs-cli claude / fs-cli gateway : Claude Code branché sur France Student (passerelle locale) ; « fs-cli -- claude » reste une demande
const sub = process.argv[2];
if (['claude', '--claude', 'gateway', '--gateway'].includes(sub)) {
  const L = await import('./src/gateway/launch.js');
  await (sub.includes('claude') ? L.runClaude : L.runGatewayCmd)(process.argv.slice(3));
}
// fs-cli update : FS-CLI + fs-cli claude + panneau des éditeurs, en une commande (« fs-cli -- update » reste une demande)
if (['update', '--update', 'maj', '--maj'].includes(sub)) {
  const { updateAll } = await import('./src/update.js');
  process.exit(await updateAll());
}

// ── Arguments ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { print: false, cont: false, model: null, mode: null, cwd: null, help: false, version: false, web: null, prompt: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p' || a === '--print') opts.print = true;
  else if (a === '-c' || a === '--continue') opts.cont = true;
  else if (a === '-m' || a === '--model') opts.model = argv[++i];
  else if (a === '--max-turns') opts.maxTurns = parseInt(argv[++i], 10);   // -p : nombre d'étapes max pour cette exécution
  else if (a === '--dangerously-skip-permissions') opts.bypass = true;   // comme Claude Code : « tout autoriser » pour cette exécution
  else if (a === '--mode') opts.mode = argv[++i];
  else if (a === '--cwd') opts.cwd = argv[++i];
  else if (a === '--projet' || a === '--project') opts.project = argv[++i];   // conversations de CETTE exécution rangées dans ce projet du site (nom exact ou id)
  else if (a === '--web') opts.web = true;
  else if (a === '--classic') opts.classic = true;
  else if (a === '--stdio') opts.stdio = true;
  else if (a === '--vscode') opts.vscode = true;                 // installe l'extension dans les éditeurs détectés, puis quitte                   // mode machine : extension VS Code
  else if (a === '--mcp') opts.mcp = true;                       // serveur MCP sur stdio : d'autres agents (Antigravity, Claude Code, Codex…) utilisent France Student
  else if (a === '--install-mcp') opts.installMcp = true;        // inscrit ce serveur MCP dans les agents trouvés sur le PC, puis quitte
  else if (a === '--login') opts.login = true;
  else if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '-v' || a === '--version') opts.version = true;
  else if (a === '--') { opts.prompt.push(...argv.slice(i + 1)); break; }   // « fs-cli -- claude » : tout ce qui suit est la demande
  else opts.prompt.push(a);
}
if (opts.mcp) {                                                     // stdout = JSON-RPC uniquement (tout le reste est redirigé sur stderr) ; pas d'assistant de connexion
  const { runMcpServer } = await import('./src/mcp-server.js');
  await runMcpServer();
  process.exit(0);
}
if (opts.installMcp) {
  const { installMcpCli } = await import('./src/mcp-server.js');
  process.exit(installMcpCli(t => console.log(t)));
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
  --mcp                    serveur MCP (stdio) : Antigravity, Claude Code, Codex… utilisent France Student via FS-CLI
  --install-mcp            inscrit ce serveur MCP (« france-student ») dans les agents trouvés sur le PC
  fs claude [options]      Claude Code avec ton compte France Student (options --fs-*, le reste va à Claude Code)
  fs claude --fs-garder …  enregistre ces options : ensuite « fs claude » tout court suffit (--fs-oublier pour les effacer)
  fs claude --fs-conversations  reprendre dans Claude Code une conversation du site (--fs-conversation "mot du titre")
                           dans Claude Code : /fs:conversations puis /fs:reprendre <n°>
  fs gateway               la passerelle seule (port 8787), pour Claude Code lancé à la main ou depuis VS Code
  fs update                tout mettre à jour : FS-CLI, fs claude et le panneau des éditeurs (alias : fs maj)
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
let AGENTS = { ...FALLBACK_AGENTS };
const S = {
  chatId: null, agentId: cfg.agentId, primed: false,
  cwd: opts.cwd ? path.resolve(opts.cwd) : (process.env.FS_WORKDIR || process.cwd()),
  notes: [], allow: {}, undo: [], tokens: { in: 0, out: 0 }, stats: { turns: 0, requests: 0, tools: 0 }, startedAt: Date.now(), lastResponse: '', title: '', pendingFiles: [],
  blocks: [], pendingResults: [], ctxSent: false, ctxPercent: null, lastUserText: '', pendingContext: [], images: [], pendingFileIds: [], mcpSig: '', targetDir: null, sid: newSid(), slots: {},
};
let projectRun = null;                                                 // --projet : projet de toute cette exécution ({ id, name })
const modelName = (id = S.agentId) => AGENTS[String(id)] || `#${id}`;

function resolveModel(arg) {
  arg = String(arg || '').trim();
  if (!arg) return null;
  if (AGENTS[arg]) return parseInt(arg);
  const keys = sortedModelIds(AGENTS);                               // du plus puissant au moins puissant (n° de /models, recherche par nom)
  if (/^\d{1,2}$/.test(arg) && keys[parseInt(arg) - 1]) return parseInt(keys[parseInt(arg) - 1]);
  const low = arg.toLowerCase();
  const hit = keys.find(k => AGENTS[k].toLowerCase() === low) || keys.find(k => AGENTS[k].toLowerCase().includes(low));
  return hit ? parseInt(hit) : null;
}

function saveSession() {
  if (!S.chatId) return;
  upsertSession({ chatId: S.chatId, agentId: S.agentId, cwd: S.cwd, title: S.title || '(sans titre)', ctxSent: S.ctxSent, sid: S.sid, slots: S.slots, slotTokens: S.slotTokens || {}, targetDir: S.targetDir, toolsHintSig: S.toolsHintSig || '', skillsCatSig: S.skillsCatSig || '', lastPromptTokens: S.lastPromptTokens || 0 });
}

/** conversation quittée (nouvelle, reprise, supprimée, verrouillée, illisible) : rien de l'ancienne ne passe dans la suivante */
function resetChatState() {
  S.chatId = null; S.ctxSent = false; S.ctxPercent = null; S.lastPromptTokens = 0; S.needCtxCheck = false;
  S.pendingSummary = null; S.compactedFrom = null; S.toolsHintSig = ''; S.skillsCatSig = ''; S.bareChat = false; S.skillsSent = null;
  S.notes = []; S.blocks = []; S.pendingResults = [];
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
ui.spinner.start('démarrage…');
const [agents] = await Promise.all([fetchAgents(), detectEnv()]);
ui.spinner.stop();
if (agents) AGENTS = agents;

if (Number.isFinite(opts.maxTurns) && opts.maxTurns > 0) S.maxSteps = Math.min(200, opts.maxTurns);   // --max-turns : cette exécution seulement (rien d'enregistré)
if (opts.model) {
  const id = resolveModel(opts.model);
  if (id !== null) { S.agentId = id; cfg.agentId = id; } else console.log(c.yellow(`  modèle "${opts.model}" inconnu — ${modelName()} conservé`));
}
if (opts.cont) {
  const list = loadSessions();
  // la dernière session de CE dossier seulement (casse ignorée sous Windows/macOS) : jamais celle d'un autre projet, qui changerait le dossier de travail
  const s = list.find(x => !x.gone && x.chatId && x.cwd && sameDir(x.cwd, S.cwd));
  if (s) { applySession(s); if (opts.cwd) { S.cwd = path.resolve(opts.cwd); S.targetDir = null; } }   // --cwd explicite : il gagne sur le dossier de la session reprise
  else console.log(c.dim(list.length ? '  aucune session dans ce dossier (/resume pour en choisir une autre)' : '  aucune session à reprendre'));
}
function applySession(s) {
  resetChatState();                                                   // résumé en attente, notes, taille de l'ancienne conversation : oubliés
  setProjectOnce(undefined); S.projectName = projectRun ? projectRun.name : undefined;   // « nouvelle conversation dans le projet P » ne vaut plus
  S.chatId = s.chatId; S.agentId = s.agentId || S.agentId; S.title = s.title || '';
  S.ctxSent = s.ctxSent !== false;
  S.sid = s.sid || newSid(); S.slots = s.slots || {}; S.slotTokens = s.slotTokens || {}; S.targetDir = s.targetDir && fs.existsSync(s.targetDir) ? s.targetDir : null;
  if (s.cwd && fs.existsSync(s.cwd)) S.cwd = s.cwd;
  S.toolsHintSig = s.toolsHintSig || '';                             // outils du PC déjà annoncés dans cette conversation ?
  S.skillsCatSig = s.skillsCatSig || '';                             // index des skills déjà annoncé ?
  S.lastPromptTokens = Number(s.lastPromptTokens) || 0;              // taille de CETTE conversation (seuil de résumé automatique)
  S.needCtxCheck = !!S.chatId && !S.lastPromptTokens;                 // inconnue (autre PC, site, ancienne session) : demandée une fois avant le 1er envoi
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
  const list = S.images.splice(0, S.images.length); S.imageTags = {};
  ui.spinner.start(`envoi de ${list.length} image${list.length > 1 ? 's' : ''}…`);
  try {
    for (const [i, p0] of list.entries()) {
      const p = prepareImage(p0) || p0;                                  // Mac : photo .heic ou grosse capture Retina → JPEG (sips, fourni avec macOS)
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
  // raccourcis du système : sur Mac, Option+V tape « √ » (pas Méta par défaut) → Ctrl+V ; capture : Cmd+Ctrl+Maj+4
  const SHOT = process.platform === 'darwin' ? 'Cmd+Ctrl+Maj+4' : process.platform === 'win32' ? 'Win+Maj+S' : 'ta touche Impr. écran';
  const KEY = process.platform === 'darwin' ? 'Ctrl+V' : 'Alt+V';
  if (!p) { if (input.flash && interactive) input.flash(`pas d'image dans le presse-papiers (fais une capture avec ${SHOT}, puis ${KEY})`); else println(c.yellow(`  pas d'image dans le presse-papiers (capture avec ${SHOT}, puis /image)`)); return; }
  S.images.push(p);
  const tag = `[Image #${S.images.length}] `;
  if (input.insert && interactive) {                                  // étiquette posée dans la saisie : l'effacer retire l'image
    S.imageTags ||= {}; S.imageTags[p] = tag.trim();
    input.insert(tag);
  } else println(c.dim(`  📎 ${tag.trim()} prête : elle partira avec ton prochain message`));   // mode classique : pas d'étiquette à suivre, l'image part
}

function buildMessage(text) {
  const atts = [];
  for (const f of S.pendingFiles) atts.push(f);
  S.pendingFiles = [];
  for (const m of text.matchAll(/(?:^|\s)@("[^"]+"|\S+)/g)) {
    const raw = m[1].replace(/^"|"$/g, '').replace(/[.,;:!?)]+$/, '');
    const fp = resolveP(raw, S.cwd);
    try {
      if (!fs.existsSync(fp)) {                                        // tapé par toi (pas le code sélectionné ni un bloc collé) : jamais en silence
        const typedAt = text.length - stripEditorContext(text).length;
        const at = m.index + m[0].length - m[1].length - 1;              // position du « @ »
        const inFence = ((text.slice(typedAt, at).match(/^(```|~~~)/gm) || []).length % 2) === 1;
        if (at < typedAt || inFence) continue;
        let spaced = '';
        if (!m[1].startsWith('"')) {                                   // « @Mes documents/notes.txt » : chemin avec espace, sans guillemets
          let acc = raw;
          for (const w of text.slice(m.index + m[0].length).match(/^(?: [^\s]+){1,6}/)?.[0].match(/ [^ ]+/g) || []) {
            acc += w;
            try { if (fs.existsSync(resolveP(acc.replace(/[.,;:!?)]+$/, ''), S.cwd))) spaced = acc.replace(/[.,;:!?)]+$/, ''); } catch {}
          }
        }
        if (spaced) println(c.yellow(`  ⚠ @${raw} introuvable : rien de joint (chemin avec espace : écris @"${spaced}")`));
        else if (/[\\/]|\.[A-Za-z0-9]{1,6}$/.test(raw)) println(c.dim(`  @${raw} introuvable : rien de joint`));
        continue;
      }
      const why = sensitivePathReason(fp);   // un @fichier ne doit pas envoyer un secret à l'API sans que tu le saches
      if (why) { println(c.yellow('  ⚠ @' + raw + ' non joint : ' + why)); continue; }
      if (isImagePath(fp)) { if (!S.images.includes(fp) && S.images.length < MAX_IMAGES) S.images.push(fp); continue; }   // @image.png : envoyée comme image
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
    const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };   // pbcopy sans LANG (lancé depuis une appli) abîme les accents
    for (const [cmd, a] of cmds) if (spawnSync(cmd, a, { input: text, env }).status === 0) return true;
  } catch {}
  return false;
}

// ── Complétion ────────────────────────────────────────────────────────────────
const SLASH = ['/help', '/new', '/clear', '/status', '/model ', '/mode ', '/cd ', '/read ', '/web', '/copy', '/undo',
  '/continue', '/navigateur ', '/doctor', '/vscode', '/projet ', '/rewind', '/changes ', '/plan ', '/messages ', '/usage', '/image', '/import ', '/intent ', '/init', '/fr-project ', '/run ', '/code ', '/hint ', '/auto ', '/context', '/quota', '/compact ', '/autocompact ', '/threshold ', '/retry ', '/compare ', '/duel ',
  '/sound', '/eco', '/remember ', '/forget ', '/memory', '/preprompt ', '/profil ', '/skills', '/skill ', '/project ', '/tree ', '/index', '/history ', '/jobs ', '/feedback ', '/search ', '/fetch ', '/mcp ', '/permissions ', '/target ', '/team ', '/teammode ', '/chats', '/clean', '/workers ', '/parallel ', '/engine ', '/resume', '/rename ', '/effort ', '/export ', '/btw ', '/webhook ', '/sessions', '/theme ', '/think', '/steps ', '/tools', '/id', '/save', '/nouveautes', '/conversations', '/quit'];

function pathCandidates(frag, dirsOnly = false) {
  const idx = Math.max(frag.lastIndexOf('/'), frag.lastIndexOf('\\'));
  const dirFrag = frag.slice(0, idx + 1), base = frag.slice(idx + 1).toLowerCase();
  let ents = [];
  try { ents = fs.readdirSync(resolveP(dirFrag || '.', S.cwd), { withFileTypes: true }); } catch {}
  return ents.filter(e => e.name.toLowerCase().startsWith(base) && (!dirsOnly || e.isDirectory()))
    .slice(0, 60).map(e => dirFrag + e.name + (e.isDirectory() ? '/' : ''));
}
/** @chemin à insérer : entre guillemets s'il contient un espace (sinon seul « @Mes » serait lu) ; dossier : guillemet laissé ouvert pour continuer */
function atMention(p, quoted = false) {
  if (!quoted && !p.includes(' ')) return '@' + p;
  return `@"${p}${p.endsWith('/') ? '' : '"'}`;
}
function completer(line) {
  if (line.startsWith('/') && !line.includes(' ')) { const hits = SLASH.filter(x => x.startsWith(line)); return [hits.length ? hits : SLASH, line]; }
  let m = line.match(/^(\/cd |\/read )(.*)$/);
  if (m) return [pathCandidates(m[2], m[1] === '/cd ').map(x => m[1] + x), line];
  if ((m = line.match(/^(\/model )(.*)$/))) return [Object.values(AGENTS).filter(n => n.toLowerCase().includes(m[2].toLowerCase())).map(n => m[1] + n), line];
  if ((m = line.match(/(?:^|\s)@"([^"]*)$/))) return [pathCandidates(m[1]).map(x => atMention(x, true)), '@"' + m[1]];
  if ((m = line.match(/(?:^|\s)@(\S*)$/))) { const sub = '@' + m[1]; return [pathCandidates(m[1]).map(x => atMention(x)), sub]; }
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
    let raw = fs.readFileSync(FILES.hist, 'utf8').split(/\r?\n/).filter(Boolean);
    if (raw.length > 2000) { raw = raw.slice(-1000); fs.writeFileSync(FILES.hist, raw.join('\n') + '\n', { mode: 0o600 }); }
    histLines = decodeHistory(raw.slice(-500).join('\n'));            // une entrée par ligne, en JSON : un message de plusieurs lignes reste entier
  }
} catch {}

// suggestions de l'interface plein écran : /commandes, /cd /read /model, @fichiers
function suggest(buf, cur) {
  const upto = buf.slice(0, cur);
  let m = /^\/(\S*)$/.exec(upto);
  if (m && cur === buf.length) {
    const q = m[1].toLowerCase();
    // ordre (comme Claude Code) : commandes de FS-CLI qui commencent par la saisie, puis les commandes perso (.fs-cli/commands,
    // .claude/commands…) qui commencent par la saisie, puis celles qui la contiennent seulement ; les perso sont marquées par leur source
    const cmdItem = x => ({ label: x.usage.length > 30 ? x.name : x.usage, insert: x.name + (/[<\[]/.test(x.usage) ? ' ' : ''), desc: x.desc });
    const customItem = x => ({ label: '/' + x.name + (x.argumentHint ? ' ' + x.argumentHint : ''), insert: '/' + x.name + ' ', desc: `${x.description} ${c.dim('(' + x.source + ')')}` });
    const custom = loadCustomCommands(S.cwd);
    const items = [
      ...COMMANDS.filter(x => x.name.slice(1).startsWith(q)).map(cmdItem),
      ...custom.filter(x => x.name.startsWith(q)).map(customItem),
      ...(q.length > 1 ? [...COMMANDS.filter(x => !x.name.slice(1).startsWith(q) && x.name.includes(q)).map(cmdItem), ...custom.filter(x => !x.name.startsWith(q) && x.name.includes(q)).map(customItem)] : []),
    ];
    return { start: 0, items };
  }
  if ((m = /^(\/cd |\/read |\/project |\/tree )(.*)$/.exec(upto))) {
    return { start: m[1].length, items: pathCandidates(m[2], m[1] !== '/read ').map(p => ({ label: p, insert: p, desc: '', keepOpen: p.endsWith('/') })) };
  }
  // valeurs d'une commande après l'espace (comme Claude Code) : on n'a plus à les connaître par cœur
  if ((m = /^(\/effort|\/mode|\/theme) (\S*)$/.exec(upto)) && cur === buf.length) {
    const q = m[2].toLowerCase();
    const values = m[1] === '/effort' ? EFFORT_LEVELS.map(l => ({ label: l, insert: l, desc: EFFORT_DESC[l] }))
      : m[1] === '/mode' ? [...MODES, 'tout'].map(x => ({ label: x, insert: x, desc: MODE_DESC[x] || 'tout autoriser (cette session seulement)' }))
      : Object.keys(THEMES).map(t => ({ label: t, insert: t, desc: t === cfg.theme ? 'actuel' : '' }));
    return { start: m[1].length + 1, items: values.filter(v => v.label.startsWith(q)) };
  }
  if ((m = /^\/(?:model|duel|workers) (.*)$/.exec(upto))) {
    const q = m[1].toLowerCase();
    return { start: upto.length - m[1].length, items: Object.entries(AGENTS).filter(([, n]) => n.toLowerCase().includes(q)).map(([id, n]) => ({ label: n, insert: n, desc: id })) };
  }
  if ((m = /(?:^|\s)@"([^"]*)$/.exec(upto) || /(?:^|\s)@(\S*)$/.exec(upto))) {   // @"Mes documents/… : chemin avec espace, entre guillemets
    const quoted = m[0].includes('@"');
    return { start: upto.length - m[1].length - (quoted ? 2 : 1), items: pathCandidates(m[1]).map(p => ({ label: '@' + p, insert: atMention(p, quoted), desc: p.endsWith('/') ? 'dossier' : '', keepOpen: p.endsWith('/') })) };
  }
  return null;
}

const interactive = !!opts.stdio || (!!process.stdin.isTTY && !!process.stdout.isTTY && !opts.classic && !opts.print);
// panneau : les messages reçus pendant le démarrage attendent la question de confiance du dossier (libérés plus bas)
const input = opts.stdio ? new StdioInput({ startBusy: true }) : createInput({
  interactive, history: interactive ? histLines : histLines.filter(l => !l.includes('\n')), completer, promptStr, suggester: suggest,
  // fichier en clair : ni long collage, ni secret (.env, clés…) ; ↑ les retrouve quand même pendant la session
  onHistory: t => { if (t && !opts.print && historyKeeps(t)) try { fs.appendFileSync(FILES.hist, encodeHistory(t) + '\n', { mode: 0o600 }); } catch {} },
});

let busy = false, turnAbort = null;
let holdInput = !!opts.stdio;                                          // démarrage du panneau : la file reste fermée jusqu'à la confiance du dossier
const ask = query => input.askLine(query);
const refreshStatus = () => input.setStatus({ model: modelName(), mode: cfg.mode, cwd: S.cwd, ctx: S.ctxPercent, budget: S.budget ? S.budget.left : null, ...(opts.stdio ? { modelId: S.agentId, chatId: S.chatId || null, title: S.title || '', project: S.projectName !== undefined ? S.projectName : (cfg.fsProject && cfg.fsProject.name ? cfg.fsProject.name : ''), target: S.targetDir || '' } : {}) });
const refreshPrompt = () => { input.setPrompt(promptStr()); refreshStatus(); };
// budget de chat du compte dans la barre d'état dès l'ouverture (sans attendre ; mis à jour après chaque réponse)
if (!opts.print && agents) chatBudget(8000).then(b => { if (b) { S.budget = b; refreshStatus(); } }).catch(() => {});

function banner() {
  if (opts.stdio) {
    try {
      const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8')).version;
      if (verNum(bundled) > verNum(PANEL_VER || '0')) setTimeout(() => stdioSend('print', { text: c.yellow(`  ⬆ Nouvelle version du panneau (${bundled}) : tape /vscode puis recharge la fenêtre de l'éditeur`) + '\n' }), 50);
    } catch {}
  }
  if (opts.stdio) return stdioSend('ready', { version: VERSION, shell: sysEnv.shellName, models: Object.entries(AGENTS).map(([id, name]) => ({ id, name })), modes: MODES.map(m => ({ id: m, name: MODE_NAME[m], desc: MODE_DESC[m] })), commands: SLASH.map(x => x.trim()), whatsNew: latestNews(3), cwd: S.cwd, chatId: S.chatId || null, title: S.title || '' });
  // accueil comme Claude Code : bienvenue · modèle · dossier à gauche, « Pour commencer » et « Quoi de neuf » à droite
  // (le détail technique — moteur, shell, web… — est dans /status)
  const tips = isBroadFolder(S.cwd)
    ? ['Dossier très large : travaille plutôt dans un projet (/cd)', '/resume pour reprendre une conversation ou un projet']
    : ['/resume pour reprendre une conversation ou un projet', '/help pour l\'aide · @fichier pour joindre un fichier'];
  const news = latestNews(3);
  const plainNews = t => String(t).replace(/`/g, '');                 // accents graves du markdown : affichés tels quels dans le terminal
  if (ui.cols() >= 100) {
    const left = [
      { text: '' }, { text: 'Bienvenue dans FS-CLI !', style: c.bold, center: true }, { text: '' },
      { text: '✻', style: c.accent, center: true }, { text: '' },
      { text: modelName() + (S.chatId ? ' · conversation reprise' : ''), style: c.dim, center: true },
      { text: ui.shortPath(S.cwd, 30), style: c.dim, center: true },
    ];
    const right = [
      { text: 'Pour commencer', style: s => c.accent(c.bold(s)) },
      ...tips.map(t => ({ text: t, wrap: 2 })),
      { rule: true },
      { text: 'Quoi de neuf', style: s => c.accent(c.bold(s)) },
      ...news.map(n => ({ text: plainNews(n.text), wrap: 3 })),     // retour à la ligne comme Claude Code (avant : coupé avec « … »)
      { text: '/nouveautes pour tout voir', style: c.dim },
    ];
    ui.splitBox(left, right, { title: `FS-CLI v${VERSION}` });
  } else {
    ui.box([
      `${c.accent('✻')} Bienvenue dans ${c.bold('FS-CLI')} ! ${c.dim('v' + VERSION)}`,
      '',
      `  ${c.dim('modèle :')} ${modelName()}${S.chatId ? c.dim(' · conversation reprise') : ''}`,
      `  ${c.dim('dossier :')} ${ui.shortPath(S.cwd, 48)}`,
      '',
      c.accent('  Quoi de neuf'),
      ...news.flatMap(n => ui.wrapLines(plainNews(n.text), 56, 3).map((l, i) => (i ? '    ' : c.dim('  · ')) + l)),
      c.dim('  /nouveautes pour tout voir · /help pour l\'aide'),
    ], { width: 64 });
  }
  println();
}

const HELP_ROWS = [
    ['/new', 'nouvelle conversation'], ['/model', 'choisir le modèle (menu à flèches, conversation conservée)'],
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
    ['/navigateur', 'laisser le modèle piloter un navigateur (chrome : ton Chrome à toi)'], ['/projet', 'travailler dans un projet France Student (ses instructions sont suivies) · /projet supprimer <nom>'], ['/vscode', 'installer le panneau de chat FS-CLI dans VS Code, Cursor, Windsurf, Antigravity'], ['/doctor', 'vérifier l\'installation et dire quoi corriger'], ['/rewind', 'revenir à l\'état des fichiers d\'avant une demande'], ['/changes', 'fichiers modifiés : diff et annulation fichier par fichier'], ['/plan <demande>', 'une demande en lecture seule, puis proposition d\'appliquer'], ['/messages [n]', 'réafficher les derniers messages de la conversation'], ['/usage', 'consommation : budget du compte, conversations du jour, session'], ['/image', `joindre une image : presse-papiers (aussi ${process.platform === 'darwin' ? 'Ctrl+V' : 'Alt+V'}), /image <chemin>, /image clear`], ['/import', 'MCP et skills de Claude Code, Codex… (on/off)'], ['/intent', 'comprendre les demandes en langage naturel on/off'], ['/init', 'créer FSCLI.md : instructions du projet lues à chaque conversation'],
    ['/fr-project', 'projet du site où ranger les conversations (off pour désactiver)'],
    ['/undo', 'annuler la dernière modification de fichier'], ['/copy', 'copier la dernière réponse'],
    ['/effort [niveau]', 'effort de raisonnement des modèles GPT : none, minimal, low, medium, high, xhigh (réglage du compte, aussi sur le site)'],
    ['/export [fichier.md|.html]', 'enregistrer la conversation en Markdown ou en page HTML'],
    ['/btw <question>', 'question à côté, sans encombrer la conversation en cours'],
    ['/webhook [url|off|test]', 'adresse appelée à la fin de chaque demande (CI, notifications…)'],
    ['/resume', 'choisir une conversation ou un projet (toutes · ce dossier · projets), comme l\'horloge du panneau'], ['/rename <titre>', 'renommer la conversation (aussi sur le site)'], ['/status', 'configuration actuelle'], ['/tools', 'outils disponibles'],
    ['/think', 'afficher/masquer le raisonnement'], ['/steps <n>', 'étapes max par demande'], ['/theme <nom>', Object.keys(THEMES).join(' · ')],
    ...(opts.stdio ? [] : [['/claude', 'Claude Code avec ton compte France Student : la commande à lancer dans un autre terminal']]),   // masquée du panneau (absente de SLASH)
    ['/clear', 'effacer l\'écran'], ['/quit', 'quitter'],
    ['!<commande>', 'exécuter une commande shell directement (sans le modèle)'], ['\\ en fin de ligne', 'continuer sur la ligne suivante'],
];

// commandes proposées dans la liste de suggestions (tirées de l'aide)
// commandes de l'ancien moteur « chat » (blocs de code dans la réponse) : sans objet avec les outils officiels → hors du menu et de l'aide (toujours utilisables)
const LEGACY = new Set(['/run', '/code', '/hint', '/auto', '/engine', '/feedback']);
const legacyHidden = name => cfg.engine === 'native' && LEGACY.has(name);
const COMMANDS = (() => {
  const seen = new Map();
  for (const [k, desc] of HELP_ROWS) {
    const parts = k.split(/\s*·\s*/), descs = desc.split(' · ');
    parts.forEach((part, i) => {                                       // « /chats · /clean » : chacune sa propre description
      const usage = part.trim();
      if (!usage.startsWith('/')) return;
      const name = usage.split(/\s+/)[0];
      if (legacyHidden(name)) return;
      if (!seen.has(name)) seen.set(name, { name, usage, desc: descs.length === parts.length ? descs[i] : desc });
    });
  }
  for (const [name, desc] of [['/exit', 'quitter'], ['/id', 'identifiant de la conversation'], ['/save', 'sauvegarder la session'], ['/clear', 'effacer l\'écran'],
    ['/conversations', 'choisir une conversation ou un projet (comme /resume)'], ['/nouveautes', 'quoi de neuf dans FS-CLI']])
    if (!seen.has(name)) seen.set(name, { name, usage: name, desc });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
})();

function help() {
  println(); for (const [k, v] of HELP_ROWS) if (!legacyHidden(k.split(/\s+/)[0])) println(`  ${c.accent(k.padEnd(20))} ${c.dim(v)}`); println();
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
  transcriptOf,
  printTurnChanges,
  chatTurn: (t, o) => chatTurn(t, o),
  changeCwd: d => changeCwd(d),                                       // /project : question de confiance + dossier cible remis à zéro
  resumeChatById: id => resumeChatById(id),                           // /history <n°> : comme /resume (titre du site, session locale)
  ...(opts.stdio && panelAtLeast('0.4.0') ? { mcpPanel: () => openMcpPanel() } : {}),
  ...(opts.stdio && panelAtLeast('0.5.0') ? { card: data => stdioSend('card', data) } : {}),
  ...(opts.stdio && PANEL_FEATURES.has('agents') ? { agentMap: true } : {}),   // le panneau affiche l'équipe d'agents en bloc « Agents »
});

const PANEL_VER = String(process.env.FS_CLI_PANEL || '');            // version de l'extension qui pilote ce CLI (vide = ancienne extension)
const verNum = v => String(v || '0').split('.').map(n => parseInt(n, 10) || 0).reduce((a, n) => a * 1000 + n, 0);
const panelAtLeast = v => !!PANEL_VER && verNum(PANEL_VER) >= verNum(v);
const PANEL_FEATURES = new Set(String(process.env.FS_CLI_PANEL_FEATURES || '').split(',').map(s => s.trim()).filter(Boolean));   // ce que sait afficher le panneau (ex. « agents »)

/** conversations du compte vues au dernier passage (affichées tout de suite à l'ouverture suivante) */
let remoteCache = [];
let lastProjects = [];                                               // projets France Student vus au dernier passage (onglet « Projets » du panneau)
// déclarées tôt : le panneau peut envoyer des messages pendant le démarrage (await plus bas)
let markSeq = 0;
const SETTING_KEYS = { webSearch: 'recherche web', refusalRecover: 'nouvel essai (même modèle) quand le modèle refuse les outils', autoCompact: 'résumé automatique', showThinking: 'réflexion du modèle affichée', sound: 'bip de fin', mcpAskWhere: 'le MCP demande où écrire' };
let effortCache;
let folderWaiter = null;
const within = (p, ms, dflt) => Promise.race([Promise.resolve(p).catch(() => dflt), new Promise(r => setTimeout(() => r(dflt), ms).unref?.())]);

/** titre d'une conversation tel que France Student l'affiche, sans l'étiquette technique « [7f3a] » de FS-CLI */
const fsTitle = t => String(t || '').replace(/^\[[0-9a-f]{4}(?:·[^\]]*)?\]\s*/i, '').trim();

/** sessions dont la conversation existe encore sur le site + conversations du compte absentes de ce PC (autre PC, site, projets).
 *  Rapide : onQuick reçoit tout de suite la liste locale (+ celles du compte vues la dernière fois), puis UN passage réseau en parallèle :
 *  listes du compte et des projets ; seules les conversations locales récentes absentes de ces listes sont vérifiées une à une.
 *  Une conversation supprimée est marquée et masquée ; si rien ne répond (réseau coupé), on ne masque rien. */
async function liveSessions(limit = 50, onQuick) {
  const list = loadSessions().filter(s => s.chatId && !s.gone).slice(0, limit);
  const merge = (local, remote) => {
    const ids = new Set(local.map(s => s.chatId));
    return [...local, ...remote.filter(r => !ids.has(r.chatId))].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
  };
  try { onQuick?.(merge(list, remoteCache)); } catch {}
  const clean = t => String(t || '(sans titre)').replace(/^\[[0-9a-f]{4}(?:·[^\]]*)?\]\s*/i, '');
  const seen = new Set(), remote = [];
  const add = (arr, proj) => { for (const x of Array.isArray(arr) ? arr : []) if (x?.id && !seen.has(x.id)) { seen.add(x.id); remote.push({ chatId: x.id, raw: String(x.title || ''), title: clean(x.title), agentId: x.agent?.id ?? x.agentId ?? S.agentId, cwd: '', project: proj?.name || '', projectId: proj?.id || x.projectId || '', remote: true, updatedAt: Date.parse(x.lastMessageAt || x.updatedAt || x.createdAt) || 0, ctxSent: true }); } };
  const chatsOf = j => (Array.isArray(j) ? j : j?.chats);
  // null = PAS DE RÉPONSE (réseau coupé, clé expirée, panne) ≠ liste vide : fetchChatsList renverrait [] dans les deux cas
  const [mine, projects] = await Promise.all([within(requestJson('GET', '/chats?limit=50', undefined, 6000).then(r => (r.status >= 200 && r.status < 300 ? (Array.isArray(r.data) ? r.data : r.data?.chats || []) : null)), 6000, null), within(listFsProjects(), 6000, null)]);
  add(mine);
  if (mine !== null) {                                                // masquées à tort avant la v3.46.1 (ouvertes hors ligne) : présentes dans la liste du site → rendues
    const back = loadSessions().filter(s => s.gone && seen.has(s.chatId)).map(s => s.chatId);
    if (back.length) { unmarkSessionsGone(back); list.push(...loadSessions().filter(s => back.includes(s.chatId))); }
  }
  const some = (projects || []).filter(p => p?.id).slice(0, 15);      // une conversation rangée dans un projet n'apparaît plus dans la liste générale du site
  const toCheck = list.filter(s => !seen.has(s.chatId)).slice(0, 15); // les autres : présentes dans les listes du compte = elles existent
  const [projChats, res] = await Promise.all([
    Promise.all(some.map(p => within(requestJson('GET', `/projects/${encodeURIComponent(p.id)}/chats`).then(r => r.data), 6000, null))),
    // une conversation n'est « supprimée » QUE si France Student répond 404 ; toute autre erreur = on ne sait pas (null)
    Promise.all(toCheck.map(s => within(requestJson('GET', `/chats/${encodeURIComponent(s.chatId)}/usage`, undefined, 4000).then(r => (r.status === 404 ? false : r.status >= 200 && r.status < 300 ? true : null)), 4000, null))),
  ]);
  projChats.forEach((j, i) => add(chatsOf(j), some[i]));
  if (projects) lastProjects = some.map(p => ({ id: p.id, name: p.name || '(sans nom)' }));
  const answered = mine !== null || res.some(r => r === true);
  const gone = new Set(answered ? toCheck.filter((s, i) => res[i] === false && !seen.has(s.chatId)).map(s => s.chatId) : []);   // seulement un « n'existe pas » net
  if (gone.size) markSessionsGone([...gone]);
  const local = list.filter(s => !gone.has(s.chatId)).map(s => { const r = remote.find(x => x.chatId === s.chatId); return r?.projectId && !s.projectId ? { ...s, project: r.project, projectId: r.projectId } : s; });
  // titres : renommée sur le site (titre choisi par toi) → ce titre-là, partout ici aussi ;
  // titre automatique du site, coupé à 3 mots (« Salut... ») → le début de ta 1re demande, en entier (lu une fois, gardé ; rien n'est renommé sur le site)
  const autoTitle = raw => { const t = clean(raw).trim(); return !t || t === '(sans titre)' || (/(\.\.\.|…)\s*$/.test(t) && t.replace(/(\.\.\.|…)\s*$/, '').trim().split(/\s+/).length <= 3); };
  const tc = loadTitleCache();
  const need = [...local.filter(s => !tc[s.chatId] && autoTitle(s.title || '') && remote.some(r => r.chatId === s.chatId && autoTitle(r.raw))),
    ...remote.filter(r => !tc[r.chatId] && autoTitle(r.raw) && !local.some(s => s.chatId === r.chatId))].slice(0, 12);
  if (need.length) {
    const got = await Promise.all(need.map(x => within(fetchChat(x.chatId).then(ch => firstAsk(ch)), 3000, '')));
    need.forEach((x, i) => { if (got[i]) tc[x.chatId] = got[i]; });
    saveTitleCache(tc);
  }
  for (const r of remote) if (autoTitle(r.raw) && tc[r.chatId]) r.title = tc[r.chatId];
  for (const s of local) {
    const r = remote.find(x => x.chatId === s.chatId);
    if (!r) continue;
    const t = !autoTitle(r.raw) ? r.title : autoTitle(s.title || '') ? (tc[s.chatId] || s.title) : null;
    if (!t || t === s.title) continue;
    s.title = t;
    const cur = loadSessions().find(x => x.chatId === s.chatId);
    if (cur && cur.title !== t) upsertSession({ ...cur, title: t }, { touch: false });
    if (s.chatId === S.chatId && S.title !== t) { S.title = t; refreshPrompt(); }
  }
  if (mine !== null) remoteCache = remote.filter(r => !list.some(s => s.chatId === r.chatId));
  return merge(local, remote.filter(r => !local.some(s => s.chatId === r.chatId)));
}

/** titres lisibles des conversations dont le site n'a gardé que 3 mots (affichage seulement, jamais renvoyés au site) */
const TITLES_FILE = () => path.join(HOME_DIR, 'titles.json');
function loadTitleCache() { try { const j = JSON.parse(fs.readFileSync(TITLES_FILE(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function saveTitleCache(tc) { try { const keys = Object.keys(tc).slice(-400); fs.writeFileSync(TITLES_FILE(), JSON.stringify(Object.fromEntries(keys.map(k => [k, tc[k]]))), { mode: 0o600 }); } catch {} }
/** début de la 1re demande d'une conversation (1re ligne, coupée sur un mot) */
function firstAsk(chat) {
  const t = (transcriptOf(chat).find(m => m.role === 'user')?.text || '').split('\n').find(l => l.trim()) || '';
  const s = t.replace(/\s+/g, ' ').trim();
  if (s.length <= 80) return s;
  const cut = s.slice(0, 79), sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut) + '…';
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

/**
 * Déjà envoyé dans CETTE conversation ? (kind : 'sel' sélection de l'éditeur, 'url' page lue, 'mcp' outils d'un serveur).
 * Une conversation neuve (chatId pas encore connu) est notée « nouvelle » puis rattachée à son id à la fin du tour.
 */
function alreadySent(kind, key, { mark = true } = {}) {
  S.sentOnce ||= {};
  const chat = S.chatId || '(nouvelle)';
  let m = S.sentOnce[kind];
  if (!m || m.chat !== chat) m = S.sentOnce[kind] = { chat, keys: new Set() };
  if (m.keys.has(key)) return true;
  if (mark) m.keys.add(key);
  return false;
}
function attachSentToChat() { for (const m of Object.values(S.sentOnce || {})) if (m.chat === '(nouvelle)' && S.chatId) m.chat = S.chatId; }
const hashOf = t => { let h = 0; t = String(t || ''); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + t.length; };

/** reprend une conversation (du PC, d'un autre PC ou du site) : session appliquée, titre du site synchronisé → messages de la conversation */
async function resumeChatById(chatId) {
  const s = loadSessions().find(x => x.chatId === chatId) || { chatId, title: '', agentId: S.agentId, ctxSent: true };   // conversation du compte (autre PC, site)
  applySession(s); refreshPrompt(); saveSession();
  let messages = [];
  try {
    const chat = await fetchChat(chatId);
    messages = transcriptOf(chat);
    const t = fsTitle(chat?.title);                                   // titre du site (renommée là-bas → renommée ici)
    if (t && t !== S.title) { S.title = t; saveSession(); refreshPrompt(); }
  } catch {}
  return messages;
}

const agoText = t => {
  const m = Math.max(0, Math.round((Date.now() - (t || 0)) / 60000));
  return !t ? '' : m < 1 ? 'à l\'instant' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} j`;
};

/**
 * Sélecteur de conversations du TERMINAL, avec les MÊMES onglets que la fenêtre de l'horloge de l'IDE : Ce dossier · Tous · Projets.
 * ← → change d'onglet. Choisir une conversation la reprend (avec ses derniers messages) ;
 * dans Projets, on choisit d'abord un projet, puis une de ses conversations ou « Nouvelle conversation dans ce projet » (pour celle-là seulement).
 */
async function pickConversation() {
  ui.spinner.start('conversations…');
  const list = await liveSessions(80).finally(() => ui.spinner.stop());
  const here = list.filter(s => s.cwd && samePathCI(s.cwd, S.cwd));
  const label = s => `💬 ${ui.clip(s.title || '(sans titre)', 52)}${s.chatId === S.chatId ? '  ● en cours' : ''}${s.updatedAt ? '  · ' + agoText(s.updatedAt) : ''}`;
  const count = pid => list.filter(s => (pid ? s.projectId === pid : !s.projectId)).length;
  const TABS = ['Ce dossier', 'Tous', 'Projets'];
  let tab = here.length ? 0 : 1, proj;                                // proj : projet ouvert dans l'onglet Projets (undefined = liste des projets)
  for (;;) {
    const opts = [], acts = [];
    const push = (l, a) => { opts.push(l); acts.push(a); };
    let title, detail;
    if (tab === 0 || tab === 1) {
      const items = tab === 0 ? here : list;
      title = 'Conversations';
      detail = tab === 0
        ? (here.length ? `Tes conversations dans ce dossier (${ui.shortPath(S.cwd, 50)}). Entrée = reprendre.` : `Aucune conversation faite dans ce dossier (${ui.shortPath(S.cwd, 50)}) : → pour voir toutes tes conversations.`)
        : 'Toutes tes conversations, la plus récente en haut. Entrée = reprendre.';
      push('＋ Nouvelle conversation', { new: true });
      for (const s of items) push(label(s), { chat: s });                 // toutes (le menu défile) : avant, coupé à 14
    } else if (proj === undefined) {
      title = 'Projets';
      detail = 'Choisis un projet du site pour voir ses conversations ou en commencer une dedans.';
      push(`○ Conversations normales (hors projet) · ${count('')} conv.`, { proj: '' });
      for (const p of lastProjects) push(`▣ ${p.name} · ${count(p.id)} conv.${cfg.fsProject?.id === p.id ? ' · par défaut' : ''}`, { proj: p.id });
    } else {
      const p = lastProjects.find(x => x.id === proj);
      title = proj ? `Projets › ${p?.name || '?'}` : 'Projets › Conversations normales';
      detail = proj ? `Conversations du projet « ${p?.name || '?'} ». Entrée = reprendre.` : 'Conversations rangées dans aucun projet. Entrée = reprendre.';
      push('← Revenir à la liste des projets', { back: true });
      push(proj ? `＋ Nouvelle conversation dans le projet « ${p?.name} »` : '＋ Nouvelle conversation hors projet', { newIn: proj ? p : false });
      for (const s of list.filter(x => (proj ? x.projectId === proj : !x.projectId))) push(label(s), { chat: s });   // toutes (le menu défile)
    }
    const first = acts.findIndex(a => a.chat && a.chat.chatId !== S.chatId);
    const r = await input.select({ title, detail, options: opts, defaultIndex: first >= 0 ? first : 0, tabs: TABS, tab });
    if (r && typeof r === 'object' && 'tab' in r) { tab = r.tab; proj = undefined; continue; }   // ← → : autre onglet
    const a = r == null || r < 0 ? null : acts[r];
    if (!a) return println(c.dim('  conversation inchangée'));
    if (a.back) { proj = undefined; continue; }
    if ('proj' in a) { proj = a.proj; continue; }
    if (a.new) return command('/new');
    if ('newIn' in a) {
      await command('/new');
      setProjectOnce(a.newIn ? { id: a.newIn.id, name: a.newIn.name } : false); S.projectName = a.newIn ? a.newIn.name : ''; refreshPrompt();
      return println(c.dim(a.newIn ? `  → la prochaine conversation sera rangée dans le projet « ${a.newIn.name} »` : '  → la prochaine conversation sera hors projet'));
    }
    if (a.chat) {
      if (a.chat.chatId === S.chatId) return println(c.dim('  c\'est déjà la conversation en cours'));
      ui.spinner.start('reprise…');
      const msgs = await resumeChatById(a.chat.chatId).finally(() => ui.spinner.stop());
      println(c.green('  ✓ conversation reprise') + c.dim(` · ${S.title || a.chat.title || ''} · ${modelName()}`));
      const last = msgs.slice(-4);                                     // fin de la conversation, pour savoir où on en était
      if (msgs.length > last.length) println(c.dim(`  … ${msgs.length - last.length} message${msgs.length - last.length > 1 ? 's' : ''} plus haut`));
      for (const m of last) {
        const t = m.text.replace(/\s+/g, ' ').trim();
        println(m.role === 'user' ? '  ' + c.accent('> ') + ui.clip(t, 140) : '  ' + c.dim('⎿  ' + ui.clip(t, 220)));
      }
      return;
    }
  }
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
  if (/^\/(history|conversations|conv)$/.test(cmd) && !arg && !opts.stdio && input.select && interactive) return pickConversation();   // même sélecteur que /resume
  if (/^\/(conversations|conv)$/.test(cmd)) return command('/resume' + (arg ? ' ' + arg : ''));   // ailleurs (panneau, mode classique) : la liste de /resume
  switch (cmd) {
    case '/quit': case '/exit': case '/q': return shutdown(0);
    case '/nouveautes': case '/nouveautés': case '/quoi-de-neuf': case '/release-notes': case '/news': {   // comme /release-notes de Claude Code
      const n = Math.max(1, parseInt(arg) || 6);
      println();
      for (const v of WHATS_NEW.slice(0, n)) {
        println(`  ${c.accent(c.bold('v' + v.version))}${v.version === VERSION ? c.dim('  ← ta version') : ''}`);
        for (const it of v.items) println(`    ${c.dim('·')} ${it}`);
      }
      return println(c.dim(`\n  Tout l'historique : https://github.com/0xBlxck/fs-cli/releases · /update pour mettre à jour\n`));
    }
    case '/help': case '/?': return help();
    case '/claude':                                                  // Claude Code a besoin du terminal entier : il se lance à côté, pas ici
      return println(c.dim('  Dans un autre terminal, ouvert dans ton projet : ') + c.accent('fs-cli claude') + c.dim('  (passerelle seule : fs-cli gateway)'));
    case '/clear': input.clearScreen(); return banner();
    case '/status': return status();
    case '/update': case '/maj': return runUpdate();
    case '/rename': {                                                  // renomme la conversation sur France Student (visible sur le site et ici)
      const t = arg.trim().slice(0, 120);
      if (!S.chatId) return println(c.dim('  pas encore de conversation à renommer : envoie d\'abord un message'));
      if (!t) return println(c.dim(`  titre actuel : ${S.title || '(sans titre)'} · /rename <nouveau titre>`));
      if (!(await renameChat(S.chatId, t))) return println(c.red('  France Student n\'a pas accepté le nouveau titre'));
      S.title = t; saveSession(); refreshPrompt();
      return println(c.green('  ✓ ') + `conversation renommée : ${t}`);
    }
    case '/id': return println(c.dim('  ' + (S.chatId || 'aucune conversation')));
    case '/save': saveSession(); return println(c.green('  ✓ session sauvegardée') + c.dim(' (auto à chaque échange)'));
    case '/new':
      setProjectOnce(undefined); S.projectName = projectRun ? projectRun.name : undefined;   // --projet vaut pour toute l'exécution
      resetChatState();
      S.turnMarks = []; S.lastEditorCtx = null; S.fetchedUrls = null; S.briefSent = null; S.allow = {}; S.undo = []; S.title = ''; S.pendingFiles = []; S.pendingContext = []; S.images = []; S.imageTags = {}; S.sid = newSid(); S.slots = {};
      if (opts.stdio) { stdioSend('clear'); refreshPrompt(); return; }   // panneau : page vierge (accueil), pas une ligne à la suite
      return println(c.dim('  → nouvelle conversation') + (createdToday() >= DAILY_LIMIT - 8 ? c.yellow(`  (⚠ ${createdToday()}/${DAILY_LIMIT} nouvelles conversations créées aujourd'hui)`) : ''));
    case '/models':                                                    // ancien nom : même chose que /model (une seule commande)
    case '/model': {
      if (!arg && interactive && input.select) {                      // comme Claude Code : menu à flèches, modèle actuel présélectionné
        const list = sortedModelIds(AGENTS).map(id => [id, AGENTS[id]]);   // du plus puissant au moins puissant (mêmes n° que « /model 2 »)
        const idx = await input.select({ title: 'Modèle', detail: 'Ta conversation est conservée.', options: list.map(([id, n]) => n + (String(id) === String(S.agentId) ? '  (actuel)' : '')), defaultIndex: Math.max(0, list.findIndex(([id]) => String(id) === String(S.agentId))) });
        if (!Number.isInteger(idx) || !list[idx]) return println(c.dim('  modèle inchangé'));
        arg = list[idx][0];
      }
      if (!arg) {                                                      // sans menu (terminal simple) : la liste numérotée
        println(); sortedModelIds(AGENTS).forEach((id, i) => println(`  ${c.dim(String(i + 1).padStart(2))}  ${c.dim(id.padStart(6))}  ${AGENTS[id]}${id === String(S.agentId) ? c.accent('  ◀') : ''}${cfg.toolRefusals?.[id] ? c.dim('  · a refusé les outils une fois') : ''}`));
        println(); return println(c.dim('  /model <nom ou n°> pour changer'));
      }
      const id = resolveModel(arg);
      if (id === null) return println(c.red(`  modèle inconnu: ${arg}`) + c.dim('  (/model pour la liste)'));
      S.agentId = id; cfg.agentId = id; saveCfg(); saveSession();
      if (cfg.toolRefusals?.[String(id)]) println(c.dim('  ℹ ce modèle a déjà refusé une fois d\'utiliser les outils (souvent à cause de la demande elle-même) : s\'il recommence, reformule ou change de modèle'));
      return println(c.dim(`  → ${modelName()}`) + (S.chatId ? c.dim(' · conversation conservée') : ''));
    }
    case '/mode': {
      if (!arg && interactive && input.select) {                      // menu à flèches (sans menu : bascule auto ↔ confirmer, comme avant)
        const all = [...MODES, 'tout'];
        const idx = await input.select({ title: 'Mode', detail: 'Maj+Tab change aussi de mode à tout moment.', options: all.map(m => `${MODE_NAME[m] || 'tout autoriser'}${m === cfg.mode ? '  (actuel)' : ''} — ${String(MODE_DESC[m] || 'tout s\'exécute sans demander (cette session seulement)').replace(/^mode [^:]+ : /, '')}`), defaultIndex: Math.max(0, all.indexOf(cfg.mode)) });
        if (!Number.isInteger(idx) || !all[idx]) return println(c.dim('  mode inchangé'));
        arg = all[idx];
      }
      const m = arg || (cfg.mode === 'auto' ? 'ask' : 'auto');
      if (/^(tout|bypass|yolo|tout-autoriser)$/i.test(m)) { await enableBypass(); return; }
      if (!MODES.includes(m)) return println(c.red('  usage: /mode auto|edits|ask|plan|tout'));
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
      if (!arg && interactive && input.select) {
        const names = Object.keys(THEMES);
        // aperçu en direct : chaque flèche applique le thème au menu et à la barre ; Échap revient au thème d'avant
        const idx = await input.select({ title: 'Thème', detail: 'Aperçu en direct · Échap revient au thème actuel',
          options: names.map(t => `${t}${t === cfg.theme ? '  (actuel)' : ''}  ${ui.sgr(38, THEMES[t])}●●●\x1b[39m`),
          defaultIndex: Math.max(0, names.indexOf(cfg.theme)), onMove: i => { if (names[i]) ui.theme.name = names[i]; },
          // aperçu : à quoi ressemblent la réponse, le cadre et la barre du bas avec le thème survolé
          preview: () => [c.accent('●') + ' Voici une réponse du modèle avec ce thème.', c.accent('╭────────────────────────────╮') + c.dim('   ') + c.accent('⏵⏵ auto') + c.dim(' (maj+tab)'), c.accent('│') + ' > ta demande ici           ' + c.accent('│'), c.accent('╰────────────────────────────╯')] });
        if (!Number.isInteger(idx) || !names[idx]) { ui.theme.name = cfg.theme; refreshPrompt(); return println(c.dim('  thème inchangé')); }
        arg = names[idx];
      }
      if (!THEMES[arg]) return println(c.red('  thèmes: ') + Object.keys(THEMES).join(' · '));
      cfg.theme = arg; ui.theme.name = arg; saveCfg(); refreshPrompt();
      input.clearScreen(); banner();                                   // le texte déjà affiché ne peut pas changer de couleur : on réaffiche avec le nouveau thème
      return println(c.accent(`  → thème ${arg}`) + c.dim('  (la conversation continue, seul l\'écran a été réaffiché)'));
    }
    case '/cd': {
      const dir = resolveP(arg || os.homedir(), S.cwd);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return println(c.red('  dossier introuvable'));
      return changeCwd(dir);
    }
    case '/target': {
      if (!arg) return println(c.dim(S.targetDir ? `  dossier cible : ${S.targetDir}  (détecté dans ta demande ; /target clear pour l'oublier)` : `  pas de dossier cible : les fichiers vont dans ${S.cwd}  (cite un chemin dans ta demande, ou /target <dossier>)`));
      if (/^(clear|off|aucun)$/i.test(arg)) { S.targetDir = null; refreshPrompt(); return println(c.dim('  → dossier cible oublié : les fichiers vont de nouveau dans ' + S.cwd)); }
      const d = resolveP(arg, S.cwd);
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return println(c.red('  dossier introuvable'));
      S.targetDir = d; refreshPrompt(); return println(c.dim('  → dossier cible : ' + d));
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
        if (open === 0) {                                              // la page doit s'ouvrir dans CHROME (pas Safari sur Mac) : sinon, le lien est affiché
          let r = { status: 1 };
          try {
            if (process.platform === 'win32') r = spawnSync('cmd', ['/c', 'start', '', STORE], { windowsHide: true });
            else if (process.platform === 'darwin') r = spawnSync('open', ['-a', 'Google Chrome', STORE]);
            else r = spawnSync('google-chrome', [STORE], { detached: true, stdio: 'ignore' });
          } catch {}
          if (r.status !== 0 || r.error) println(c.yellow(`  Ouvre ce lien dans Chrome : ${STORE}`));
        }
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
      if (/^@\d+$/.test(arg)) return rewindToMark(parseInt(arg.slice(1), 10));
      const marks = (S.turnMarks || []).map((m, i) => ({ ...m, i, changes: S.undo.length - m.at })).filter(m => m.changes > 0).reverse();
      if (!marks.length) return println(c.dim('  rien à annuler : aucune modification de fichier depuis le début de la session'));
      const label = m => `avant « ${m.text}${m.text.length >= 70 ? '…' : ''} » · ${m.changes} modif${m.changes > 1 ? 's' : ''} annulée${m.changes > 1 ? 's' : ''} · ${new Date(m.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
      let pick = null;
      if (/^\d+$/.test(arg)) pick = marks[parseInt(arg, 10) - 1] || null;
      else if (input.select && interactive) {
        const idx = await input.select({ title: 'Revenir à l\'état des fichiers d\'avant quelle demande ?', detail: 'Les fichiers modifiés par le modèle depuis cette demande reprennent leur ancien contenu ; ceux qu\'il a créés partent dans la corbeille du CLI. Les effets des commandes (npm install…) ne sont pas annulés.', options: [...marks.slice(0, 9).map(label), 'Annuler'], defaultIndex: Math.min(9, marks.length) });   // « Annuler » présélectionné : revenir en arrière doit être un choix explicite
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
      if (!arg && cmd !== '/load' && !opts.stdio && input.select && interactive) return pickConversation();   // sélecteur à flèches : toutes · ce dossier · projets
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
      if (/^(clear|aucune|off)$/i.test(arg)) { S.images = []; S.imageTags = {}; return println(c.dim('  → images en attente retirées')); }
      if (!arg) { pasteClipboardImage(); return; }
      const p = resolveP(arg, S.cwd);
      if (!fs.existsSync(p) || !isImagePath(p)) return println(c.red(`  image introuvable (png, jpg, gif, webp, bmp${process.platform === 'darwin' ? ', heic' : ''})`));
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

async function chatTurn(text, { keepLast = false, retry = false } = {}) {
  turnAbort = new AbortController();
  println();
  // relance automatique (conversation supprimée, illisible, limite après un résumé) : le message repart AVEC ce qu'il emportait
  const original = text, own = stripEditorContext(text);              // own : ce que tu as tapé, sans le contexte de l'éditeur
  const consumed = { files: [...S.pendingFiles], results: [...S.pendingResults], context: [...S.pendingContext], images: [...S.images], tags: { ...(S.imageTags || {}) }, forced: S.forceSkills };
  const again = () => {
    S.pendingFiles = consumed.files; S.pendingResults = consumed.results; S.pendingContext = consumed.context; S.images = consumed.images; S.imageTags = consumed.tags; S.forceSkills = consumed.forced;
    for (const f of consumed.forced || []) S.skillsSent?.delete(f.name);   // le skill demandé n'est pas arrivé : il repart
    turnAbort = null;
    return chatTurn(original, { keepLast: true, retry: true });
  };
  try {
    ui.tasks.clear();                                                  // nouvelle demande : le panneau de tâches repart de zéro
    ui.resetThinking();
    if (!keepLast) {                                                   // repère pour /rewind (et le bouton « Revenir ici » du panneau)
      const mark = { id: ++markSeq, at: S.undo.length, text: own.replace(/\s+/g, ' ').trim().slice(0, 70), full: own.slice(0, 20000), t: Date.now() };
      S.turnMarks ||= []; S.turnMarks.push(mark); if (S.turnMarks.length > 50) S.turnMarks.shift();
      if (opts.stdio) stdioSend('turnMark', { id: mark.id, text: mark.text });
    }
    if (S.needCtxCheck && S.chatId && cfg.autoCompact) {               // conversation reprise de taille inconnue : demandée une fois (seuil de résumé juste dès ce message)
      S.needCtxCheck = false;
      const pct = await within(contextPercent(S.chatId), 4000, null);
      if (typeof pct === 'number') {
        S.ctxPercent = pct;
        const win = Number(S.ctxWindows?.[String(S.agentId)]) || 0;
        if (win && !S.lastPromptTokens) S.lastPromptTokens = Math.round(pct / 100 * win);
      }
    }
    await maybeAutoCompact(S, turnAbort.signal);                       // contexte plein → résumé + nouvelle conversation
    { // panneau de l'éditeur : « [Contexte VS Code : … lignes a-b sélectionnées …] » + bloc de code → recollé à chaque message ; une fois suffit
      const m = text.match(/^(\[Contexte VS Code :[^\n]*\])\n(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2\n\n?/);
      if (m && alreadySent('sel', hashOf(m[3]))) text = `${m[1].replace(/\]$/, ' (même sélection que plus haut)]')}\n` + text.slice(m[0].length);
      const f = !m && text.match(/^\[Contexte VS Code : fichier ouvert dans l'éditeur : ([^\n]*)\]\n\n?/);
      if (f && alreadySent('sel', 'fichier:' + f[1])) text = text.slice(f[0].length);   // même fichier ouvert : déjà dit
    }
    if (S.images.some(p => S.imageTags?.[p])) {                        // image collée (Alt+V) dont tu as effacé l'étiquette « [Image #n] » : elle ne part pas
      const kept = [];
      for (const p of S.images) {
        const tag = S.imageTags?.[p];
        if (tag && !text.includes(tag)) { println(c.dim(`  image retirée (étiquette ${tag} effacée) : ${path.basename(p)}`)); delete S.imageTags[p]; continue; }
        kept.push(p);
      }
      kept.forEach((p, i) => {                                         // numéros recalés sur les images qui restent (ordre croissant : aucune collision)
        const tag = S.imageTags?.[p], now = `[Image #${i + 1}]`;
        if (tag && tag !== now) { text = text.split(tag).join(now); S.imageTags[p] = now; }
      });
      S.images = kept;
    }
    const ex = extractImagePaths(text, S.images.length);               // image glissée-déposée (chemin collé) → [Image #n]
    if (ex.paths.length) { text = ex.text; for (const p of ex.paths) if (!S.images.includes(p)) S.images.push(p); }
    // « … dans C:\Users\moi\Downloads\SITE » → les fichiers y seront écrits. Seulement d'après CE QUE TU AS TAPÉ : le fichier ouvert ou la
    // sélection de l'éditeur ne changent plus le dossier en silence (audit 17/11) ; jamais un dossier trop large ; un changement est annoncé.
    const dir = detectTargetDir(own);                                   // own : ce que tu as tapé (déclaré en haut de chatTurn)
    // citer un fichier ou coller une trace d'erreur ne change plus la racine des outils : seulement « crée … dans <dossier> », un dossier hors du projet…
    if (dir && dir !== S.targetDir && !isBroadFolder(dir) && acceptTarget(dir, { cwd: S.cwd, text: own })) {
      const was = S.targetDir; S.targetDir = dir; S.notes.push(targetNote(dir));
      println(was ? c.yellow(`  ＋ dossier cible changé : ${was} → ${dir}  (/target pour voir ou effacer)`) : c.dim(`  ＋ dossier cible : ${dir}  (/target pour voir ou effacer)`));
    }
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
      // projet France Student de CETTE conversation (onglet Projets, --projet, sinon /projet) : ses instructions ; hors projet : aucune
      const proj = effectiveProject();
      if (proj && proj.id) {
        if (S.fsProjInstr?.id !== proj.id) S.fsProjInstr = { id: proj.id, text: String((await listFsProjects().catch(() => [])).find(p => p.id === proj.id)?.customInstructions || '').trim() };
        if (S.fsProjInstr.text) { message += `\n\n[Instructions du projet France Student « ${proj.name} » de l'utilisateur, à suivre :\n${S.fsProjInstr.text.slice(0, 8000)}]`; println(c.dim(`  ＋ instructions du projet « ${proj.name} »`)); }
      }
      S.ctxSent = true;
    }
    if (cfg.engine === 'native' && !S.bareChat) {                                     // MCP et skills du PC : annoncés à toute conversation qui ne les a pas encore vus (y compris après /resume)
      const prefs = workPreferences();                                // préférences de forme seulement (pas de protocole d'outils dans le texte)
      if (prefs.sig !== S.toolsHintSig) { message += '\n\n' + prefs.text; S.toolsHintSig = prefs.sig; }
      // skills : UNE ligne qui renvoie à l'index des skills actifs (fichier sur le PC), une fois par conversation et quand la liste change.
      // La liste complète dans la conversation faisait refuser GPT (« moteur d'un agent externe ») et coûtait ≈ 6 500 tokens rejoués à chaque message.
      // GPT (testé en vrai le 17/11) refuse encore parfois avec la seule ligne : pour GPT, elle ne part que si tu parles toi-même de skills/guides
      // (/nom-du-skill marche toujours). Claude s'en sert sans problème (il ouvre l'index puis le bon guide).
      const skillsOk = !isOpenAiModel(S) || /\b(skills?|guides?)\b/i.test(own);   // own : pas le code sélectionné dans l'éditeur
      const cat = skillsOk ? skillIndex(discoverSkills(S.cwd), S.cwd) : null;
      if (cat && cat.sig !== S.skillsCatSig) { message += '\n\n' + cat.text; S.skillsCatSig = cat.sig; println(c.dim(`  ＋ ${cat.count} skills disponibles (liste ouverte par le modèle si besoin)`)); }
      for (const name of mentionedServers(S.cwd, own)) {               // « à l'aide du mcp leboncoin » → ses outils sont joints à la demande
        const brief = await serverBrief(S, name, { signal: turnAbort.signal, ask });
        if (brief && !alreadySent('mcp', name + '|' + hashOf(brief))) { message = `${brief}\n\n${message}`; println(c.dim(`  ＋ outils MCP joints : ${name}`)); }   // avant la demande : plus visible
      }
      if (wantsBrowser(own)) {
        const pw = loadMcpConfig(S.cwd).mcpServers || {};
        if (!Object.keys(pw).some(n => BROWSER_SERVERS.test(n))) println(c.yellow('  💡 Pour que je pilote le navigateur, active-le une fois avec /navigateur'));
        else if (pw.playwright?.args?.includes('--extension') && !chromeExtensionInstalled()) println(c.yellow('  ⚠ Mode « ton Chrome » sans l\'extension Playwright MCP Bridge : installe-la, ou tape /navigateur separe'));
      }
    }
    if (!keepLast || retry) {                                          // skills joints à cette demande (relance : de nouveau, dans la nouvelle conversation)
      S.skillsSent ||= new Set();
      let budget = 20000;
      const forced = S.forceSkills || []; S.forceSkills = null;        // /nom-du-skill : joint en premier, même sans correspondance
      // moteur natif : le modèle a la liste de TOUS les skills avec leur description (catalogue) et choisit lui-même, comme Claude Code.
      // La recherche par mots-clés n'y sert plus (faux positifs : « dev moi le site » → gmgn-dev-score) ; elle reste pour le moteur « chat » (secours).
      const auto = cfg.engine === 'native' ? [] : autoSkills(discoverSkills(S.cwd), text);
      for (const sk of [...forced, ...auto.filter(s => !forced.some(f => f.name === s.name))].filter(s => !S.skillsSent.has(s.name))) {
        if (!forced.some(f => f.name === sk.name)) {                    // choisi automatiquement : simple référence (le modèle le lit avec read_file s'il en a besoin)
          message += `\n\nGuide disponible pour cette demande : « ${sk.name} » — ${String(sk.description || '').replace(/\s+/g, ' ').slice(0, 240)} (fichier : ${sk.file} ; lis-le avec read_file seulement s'il t'aide).`;
          S.skillsSent.add(sk.name); println(c.dim(`  ＋ skill : ${sk.name}`)); continue;
        }
        let body = ''; try { body = fs.readFileSync(sk.file, 'utf8').replace(/^﻿/, ''); } catch { continue; }
        body = body.length > Math.min(12000, budget) ? body.slice(0, Math.min(12000, budget)) + '\n[… guide tronqué ; la suite est dans ' + sk.file + ']' : body;
        if (budget <= 1000) break;
        budget -= body.length;
        message += `\n\n[Guide « ${sk.name} » de l'utilisateur, à appliquer s'il est pertinent (sans le recopier) ; ses autres fichiers sont dans ${sk.dir}. Il complète la demande sans la remplacer : fais ce que l'utilisateur demande avec tes outils, et ignore les étapes du guide qui citent des outils que tu n'as pas.\n${body}]`;
        S.skillsSent.add(sk.name);
        println(c.dim(`  ＋ skill : ${sk.name}`));
      }
    }
    if (!keepLast) S.lastUserText = original;                         // /retry : la demande telle qu'envoyée (contexte de l'éditeur compris)
    mem.observe(own, S.cwd);
    if (!S.title) S.title = own.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';   // provisoire (sans le contexte de l'éditeur) : remplacé par le titre de France Student dès qu'il est connu
    try {
      const agentBefore = S.agentId, turnT0 = Date.now();
      try { await runAgent(S, message, { signal: turnAbort.signal, ask, bare: text, choose: interactive && input.select ? o => input.select(o) : null }); } finally { attachSentToChat(); }   // bare : ta demande seule (nouvel essai sans les ajouts de FS-CLI si GPT refuse)
      if (cfg.webhook) {                                               // fin de demande → webhook (CI, notifications) : jamais de jeton ni de contenu de fichier
        const mark = (S.turnMarks || []).at(-1);
        const files = mark && S.undo.length > mark.at ? summarizeChanges(S.undo, mark.at).map(f => ({ file: path.relative(S.cwd, f.path), added: f.added, removed: f.removed, created: !!f.created, deleted: !!f.deleted })) : [];
        notifyWebhook({ event: 'turn_done', title: S.title || '', chatId: S.chatId || null, model: modelName(), folder: path.basename(S.cwd), seconds: Math.round((Date.now() - turnT0) / 1000), files_changed: files, summary: String(S.lastResponse || '').slice(0, 2000) }).catch(() => {});
      }
      if (S.agentId !== agentBefore) { saveSession(); refreshPrompt(); }   // refus d'outils : la demande est repartie avec Sonnet → modèle affiché à jour
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
      resetChatState();
      println(c.yellow('  cette conversation a été supprimée du site : ton message part dans une nouvelle conversation'));
      return again();
    }
    if (isLockedChat(e) && S.chatId) {                                 // verrouillée par France Student (signalement du fournisseur) : on n'y renvoie rien
      ui.spinner.stop();
      println(c.yellow('\n  ⚠ France Student a verrouillé cette conversation : le filtre de sécurité du fournisseur du modèle l\'a signalée. Elle ne peut plus être utilisée.'));
      println(c.dim('    Ton prochain message partira dans une nouvelle conversation (rien n\'y est recopié).'));
      if (isBroadFolder(S.cwd)) println(c.dim('    Conseil : ton dossier de travail est ton dossier personnel ; choisis plutôt le dossier du projet (📁 en bas du panneau, ou /cd) : le modèle y voit moins de fichiers sans rapport.'));
      resetChatState();
      turnAbort = null;
      return;
    }
    if (isBrokenHistory(e) && S.chatId && !S.recovering) {            // France Student ne peut plus relire cette conversation : on repart, avec la fin de l'ancienne
      const old = S.chatId;
      println(c.yellow('\n  ⚠ France Student ne peut plus relire cette conversation (un ancien élément, souvent un résultat de recherche web, y est devenu invalide) : elle est bloquée.'));
      println(c.dim('    Ton message repart dans une nouvelle conversation, avec la fin de celle-ci comme contexte.'));
      let recap = '';
      try { recap = transcriptOf(await fetchChat(old)).slice(-10).map(m => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.text.slice(0, 1500)}`).join('\n\n'); } catch {}
      resetChatState();
      S.pendingSummary = recap ? `Derniers échanges de la conversation précédente (devenue inutilisable à cause d'une erreur du serveur) :\n${recap}` : null;
      S.recovering = true;
      try { return await again(); } finally { S.recovering = false; }
    }
    if (e.code === 'DAILY_CHAT_LIMIT' && S.compactedFrom && !S.chatId) {   // impossible d'ouvrir la conversation légère : on reste dans l'actuelle, rien n'est perdu
      S.chatId = S.compactedFrom; S.compactedFrom = null; S.pendingSummary = null; S.ctxSent = true;
      println(c.yellow('  limite des 50 conversations atteinte : on continue dans la conversation actuelle'));
      return again();
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
async function naturalIntent(t, editorCtx = '') {                  // t : ce que tu as tapé ; editorCtx : contexte de l'éditeur (panneau) devant
  const r = detectIntent(t);
  if (!r) return false;
  println(c.dim(`  ↳ compris : ${r.label}`) + c.dim(r.cmd === '/team' ? '  (dis « sans agents » pour l\'éviter)' : ''));
  const prevDuel = cfg.duelModel;
  if (r.duelModel) { const id = resolveModel(r.duelModel); if (id !== null && id !== S.agentId) cfg.duelModel = id; }
  // équipe et duel envoient une demande au modèle : la sélection de l'éditeur part avec.
  // Équipe : options déjà comprises, passées à part (un « tail -n 20 » ou « --parallel » de la sélection n'est pas relu comme option)
  if (editorCtx && r.cmd === '/team' && r.team) {
    const { agents, mode, review, task } = r.team;
    await runTeam(extraEnv(), `${editorCtx}${task}`, { review, agents, mode });
    return true;
  }
  const arg = editorCtx && r.cmd === '/compare' ? `${editorCtx}${r.arg}` : r.arg;
  try { await command(`${r.cmd} ${arg}`.trim()); }
  finally { cfg.duelModel = prevDuel; }
  return true;
}

/**
 * Message qui n'est QU'UN chemin de dossier existant (« C:\…\mon-projet », entre guillemets ou non) : ce n'est pas une demande pour le modèle.
 * Choix : y travailler (dossier de travail), y écrire les fichiers (dossier cible), ou l'envoyer quand même. → true si traité ici.
 */
async function onlyAFolder(t) {
  const raw = t.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!raw || /[\r\n]/.test(raw) || !(path.isAbsolute(raw) || /^~[\\/]/.test(raw) || /^\.{1,2}[\\/]/.test(raw))) return false;
  let dir; try { dir = resolveP(raw, S.cwd); if (!fs.statSync(dir).isDirectory()) return false; } catch { return false; }
  if (samePathCI(dir, S.cwd)) { println(c.dim(`  c'est déjà ton dossier de travail : ${dir}`)); return true; }
  if (!(input.select && interactive)) return false;
  const idx = await input.select({ title: `Dossier ${dir}`, detail: 'Tu as envoyé seulement un chemin de dossier. Que veux-tu en faire ?',
    options: ['Travailler dans ce dossier (dossier de travail)', 'Garder le dossier actuel, mais écrire les fichiers dans celui-ci', 'L\'envoyer au modèle comme message', 'Annuler'], defaultIndex: 0 });
  if (idx === 0) { await changeCwd(dir); return true; }
  if (idx === 1) { S.targetDir = dir; refreshPrompt(); println(c.dim('  → dossier cible : ' + dir + '  (/target clear pour l\'oublier)')); return true; }
  if (idx === 2) return false;
  println(c.dim('  rien n\'a été envoyé')); return true;
}

async function handleInput(text) {
  busy = true; input.setBusy(true);
  try {
    const t = text.trim();
    if (!t) return;
    // panneau de l'éditeur : « [Contexte VS Code : …] » (+ sélection) devant le message → raccourcis et intentions lus sur CE QUE TU AS TAPÉ
    const own = stripEditorContext(t).trim(), editorCtx = t.slice(0, t.length - own.length);
    const knownCmd = name => SLASH.some(x => x.trim() === name) || COMMANDS.some(x => x.name === name)
      || loadCustomCommands(S.cwd).some(x => '/' + x.name === name.toLowerCase()) || discoverSkills(S.cwd).some(x => '/' + x.name.toLowerCase() === name.toLowerCase());
    if (isSlashCommand(t, { win: IS_WIN, known: knownCmd })) await command(t);   // Mac/Linux : « /Users/moi/app plante » est un message, pas une commande
    else if (!t.includes('\n') && t.startsWith('!')) await direct(t.slice(1));
    else if (!own.includes('\n') && /^#\s*\S/.test(own) && !/^##/.test(own)) await command('/remember ' + own.replace(/^#\s*/, ''));   // « # info » : retenue en mémoire (comme Claude Code)
    else if (!opts.print && own && await onlyAFolder(own)) return;  // message = juste un chemin de dossier : on demande ce qu'il faut en faire
    else if (own && (cfg.intents !== false || /PLAYWRIGHT_MCP_EXTENSION_TOKEN/.test(own)) && await naturalIntent(own, editorCtx)) return;   // un jeton collé ne part jamais au modèle
    else {
      if (cfg.intents !== false && cfg.engine === 'native') {     // le modèle n'a pas d'accès web : une URL citée est lue et jointe
        const own = stripEditorContext(t).replace(/```[\s\S]*?```/g, ' ').slice(0, 600);   // pas le code sélectionné ni un log collé
        if (!wantsBrowser(own)) for (const u of urlsIn(own)) if (!alreadySent('url', u)) await extraCommand('/fetch', u + ' --auto', extraEnv());   // « va sur … dans le navigateur » : c'est le navigateur qui ira, pas un téléchargement
      }
      await chatTurn(t);
    }
  } catch (e) {
    ui.spinner.stop();
    println(c.red(`\n  Erreur: ${e.message}`));
    if (/401|expiré/.test(e.message) && !/--login/.test(e.message)) println(c.dim('  → ta clé de session a expiré : quitte puis lance « fs-cli --login »'));
  } finally {
    busy = false; if (!holdInput) input.setBusy(false);              // démarrage du panneau : la file reste fermée jusqu'à la confiance
    refreshPrompt();
    if (!opts.print) input.prompt();
  }
}

/** traite une saisie puis les messages mis en file d'attente pendant le travail */
async function runInput(text) {
  await handleInput(text);
  for (;;) {
    if (busy || holdInput) return;
    const next = input.takeQueued();
    if (!next) return;
    await handleInput(next);
  }
}

const MODES = ['auto', 'edits', 'ask', 'plan'];
const MODE_NAME = { auto: 'auto', edits: 'modifs auto', ask: 'confirmer', plan: 'plan', bypass: 'tout autoriser' };
const MODE_DESC = {
  auto: "mode auto : tout s'exécute (confirmation seulement pour les actions dangereuses)",
  edits: 'mode modifs auto : fichiers modifiés sans demander, commandes confirmées',
  ask: 'mode confirmer : demande avant chaque écriture ou commande',
  plan: "mode plan : lecture seule, rien n'est exécuté",
  bypass: "mode tout autoriser : rien n'est demandé, même les actions sensibles (les commandes catastrophiques restent bloquées) — jusqu'à la fermeture de FS-CLI",
};
/** « Tout autoriser » (comme le mode bypass de Claude Code) : jamais par erreur — confirmation explicite, pas dans un dossier trop large, session seulement */
async function enableBypass({ silent = false } = {}) {
  if (isBroadFolder(S.cwd)) { println(c.yellow(`  « Tout autoriser » est refusé dans ${S.cwd} : c'est un dossier trop large (disque entier ou dossier personnel). Choisis d'abord le dossier du projet (/cd, ou 📁 en bas du panneau).`)); return false; }
  if (!silent) {
    const detail = [
      'Le modèle pourra lancer n\'importe quelle commande, et créer, modifier ou supprimer des fichiers — même hors du dossier de travail et les fichiers sensibles (.env, clés…) — sans rien te demander.',
      'Restent toujours bloquées : les commandes catastrophiques (formater un disque, effacer le système…).',
      'Valable jusqu\'à la fermeture de FS-CLI. À utiliser seulement dans le dossier d\'un projet sauvegardé (git) : /rewind annule les modifications de fichiers, pas les effets des commandes.',
    ].join('\n');
    if (!(input.select && interactive)) { println(c.yellow('  « Tout autoriser » se confirme dans une session interactive (ou avec --dangerously-skip-permissions).')); return false; }
    const idx = await input.select({ title: '⚠ Activer « Tout autoriser » pour cette session ?', detail, options: ['Activer pour cette session', 'Annuler'], defaultIndex: 1 });
    if (idx !== 0) { println(c.dim('  mode inchangé')); return false; }
  }
  cfg.mode = 'bypass'; S.allow = {}; refreshPrompt();                 // pas de saveCfg : rien n'est conservé pour la prochaine session
  println(c.red('  ⚠ mode tout autoriser : aucune confirmation jusqu\'à la fermeture de FS-CLI') + c.dim(' · Maj+Tab ou /mode auto pour en sortir'));
  return true;
}
function cycleMode() {
  cfg.mode = MODES[(MODES.indexOf(cfg.mode) + 1) % MODES.length]; saveCfg(); S.allow = {};
  input.flash?.(MODE_DESC[cfg.mode]);
  refreshPrompt();
}

// ── Entrées (interface plein écran ou readline) ───────────────────────────────
input.on('submit', t => { runInput(t); });
input.on('instant', t => { command(t).catch(e => println(c.red('  ' + (e?.message || e)))); });   // panneau : /usage pendant une réponse (fenêtre, rien dans le fil)
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
    else { const n = name.toLowerCase(), set = new Set((cfg.disabledSkills || []).map(x => String(x).toLowerCase())); if (set.has(n)) set.delete(n); else set.add(n); cfg.disabledSkills = [...set]; S.toolsHintSig = ''; S.skillsCatSig = ''; S.bareChat = false; }
    saveCfg(); stdioSend('skills', skillsPayload());
  });
  input.on('historyOpen', async () => {
    const here = path.resolve(S.cwd).toLowerCase();
    const send = (list, partial) => stdioSend('history', { partial, normal: !cfg.fsProject?.id,
      projects: lastProjects.map(p => ({ ...p, current: cfg.fsProject?.id === p.id })), sessions: list.map(s => ({ projectId: s.projectId || '',
      chatId: s.chatId, title: String(s.title || '(sans titre)').slice(0, 120), model: modelName(s.agentId), cwd: s.cwd || (s.remote ? (s.project ? `projet « ${s.project} »` : 'compte France Student') : ''), remote: !!s.remote,
      here: !!s.cwd && path.resolve(s.cwd).toLowerCase() === here, updatedAt: s.updatedAt || 0, current: s.chatId === S.chatId,
    })) });
    // liste immédiate (panneau récent seulement : un ancien panneau rouvrirait sa fenêtre à la 2e liste), puis la liste vérifiée
    send(await liveSessions(80, panelAtLeast('0.10.1') ? quick => send(quick, true) : null), false);
  });
  input.on('deleteChat', async (chatId, title) => {                 // croix « ✕ » de l'horloge : suppression définitive, toujours confirmée
    if (!/^[\w-]{8,64}$/.test(chatId)) return;
    if (busy) return stdioSend('flash', { text: 'attends la fin de la réponse pour supprimer une conversation' });
    const name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'cette conversation';
    const idx = await input.select({ title: `Supprimer « ${name} » ?`,
      detail: 'Elle est supprimée de ton compte France Student, y compris sur le site. C\'est définitif : impossible de la récupérer ensuite.',
      options: ['Supprimer définitivement', 'Annuler'], defaultIndex: 1 });
    if (idx !== 0) return stdioSend('flash', { text: 'suppression annulée' });
    if (!(await deleteChat(chatId))) return stdioSend('flash', { text: 'France Student n\'a pas supprimé la conversation' });
    markSessionsGone([chatId]);
    remoteCache = remoteCache.filter(r => r.chatId !== chatId);
    if (S.chatId === chatId) {                                         // c'était la conversation ouverte : page vierge
      resetChatState(); S.title = ''; S.sid = newSid();
      stdioSend('clear'); refreshPrompt();
    }
    stdioSend('flash', { text: `conversation « ${name} » supprimée` });
  });
  input.on('folderPicked', async (purpose, p) => {                  // sélecteur de dossiers de l'éditeur
    if (purpose === 'trust') { const w = folderWaiter; folderWaiter = null; return w?.(p || ''); }
    if (!p) return;
    if (busy) return stdioSend('flash', { text: 'attends la fin de la réponse pour changer de dossier' });
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return stdioSend('flash', { text: 'dossier introuvable' });
    if (purpose === 'cwd') return changeCwd(path.resolve(p));
    if (purpose === 'target') { S.targetDir = path.resolve(p); refreshPrompt(); return println(c.dim('  → les fichiers seront écrits dans : ' + S.targetDir)); }
  });
  input.on('settingsOpen', () => { sendSettings(false); sendSettings(true).catch(() => {}); });
  input.on('setting', async (key, value) => {
    if (key === 'effort') {
      const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
      if (!LEVELS.includes(value)) return;
      const r = await requestJson('PATCH', '/user/instructions', { gptReasoning: value }).catch(() => ({ status: 0 }));
      if (r.status >= 200 && r.status < 300) { effortCache = value; stdioSend('flash', { text: `effort de réflexion des GPT : ${value} (réglage du compte)` }); }
      else stdioSend('flash', { text: 'France Student a refusé le réglage' });
      return sendSettings();
    }
    if (!(key in SETTING_KEYS)) return;
    cfg[key] = value === true || value === 'true'; saveCfg();
    stdioSend('flash', { text: `${SETTING_KEYS[key]} : ${cfg[key] ? 'activé' : 'désactivé'}` });
    sendSettings();
  });
  input.on('projectUse', async id => {                              // onglet « Projets » : CETTE nouvelle conversation va dans ce projet (ou hors projet) ; le défaut ne change pas
    if (busy) return stdioSend('flash', { text: 'attends la fin de la réponse pour changer de projet' });
    const p = lastProjects.find(x => x.id === id);
    if (id && !p) return;
    await runInput('/new');
    setProjectOnce(p ? { id: p.id, name: p.name } : false); S.projectName = p ? p.name : '';
    refreshPrompt();
    stdioSend('flash', { text: p ? `nouvelle conversation dans le projet « ${p.name} »` : 'nouvelle conversation hors projet' });
  });
  input.on('deleteProject', async id => {                           // croix « ✕ » d'un projet (onglet Projets) : toujours confirmé, conversations protégées
    if (busy) return stdioSend('flash', { text: 'attends la fin de la réponse pour supprimer un projet' });
    const p = lastProjects.find(x => x.id === id);
    if (!p) return;
    const done = await deleteProjectFlow(p, extraEnv());
    if (done) { lastProjects = lastProjects.filter(x => x.id !== id); remoteCache = remoteCache.map(r => (r.projectId === id ? { ...r, projectId: null } : r)); stdioSend('flash', { text: `projet « ${p.name} » supprimé` }); }
  });
  input.on('resumeChat', async chatId => {
    if (busy) return stdioSend('flash', { text: 'attends la fin de la réponse pour changer de conversation' });
    const messages = await resumeChatById(chatId);
    stdioSend('transcript', { title: S.title || '', model: modelName(), messages: messages.slice(-40), older: Math.max(0, messages.length - 40) });
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
// fermeture de l'onglet du Terminal (SIGHUP) ou arrêt par le panneau de l'éditeur (SIGTERM) : même sortie propre que /quit
// (serveurs lancés par l'agent et serveurs MCP arrêtés, session enregistrée) — sinon ils restent orphelins (Mac, Linux)
for (const [sig, code] of [['SIGHUP', 129], ['SIGTERM', 143]]) { try { process.on(sig, () => { shutdown(code, { quiet: true }); }); } catch {} }
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
  if (ok) log(c.dim(`  → recharge la fenêtre de l'éditeur (${PALETTE_KEY} › « Reload Window ») puis clique sur l'icône France Student à gauche`));
  return ok > 0;
}

/** Première ouverture d'un dossier : on demande la confiance avant que le modèle puisse y agir. */
/** bouton « Revenir ici » du panneau : fichiers remis dans l'état d'avant ce message, puis le message revient dans la saisie */
async function rewindToMark(id) {
  const idx = (S.turnMarks || []).findIndex(m => m.id === id);
  if (idx < 0) return println(c.dim('  ce message est trop ancien : utilise /rewind pour choisir un point de retour'));
  const mark = S.turnMarks[idx], changes = S.undo.length - mark.at;
  const detail = (changes > 0
    ? `${changes} modification${changes > 1 ? 's' : ''} de fichiers faite${changes > 1 ? 's' : ''} depuis ce message sera annulée${changes > 1 ? 's' : ''} : les fichiers reprennent leur contenu d'avant, ceux créés partent dans la corbeille de FS-CLI. Les effets des commandes (npm install…) ne sont pas annulés.`
    : 'Aucun fichier n\'a été modifié depuis ce message.') +
    '\nLa conversation sur France Student n\'est pas effacée : le modèle est prévenu du retour en arrière. Ton message revient dans la zone de saisie pour que tu puisses le modifier.';
  let ok = true;
  if (input.select && interactive) ok = (await input.select({ title: `Revenir à ce point (avant « ${mark.text}${mark.text.length >= 70 ? '…' : ''} ») ?`, detail, options: ['Revenir à ce point', 'Annuler'], defaultIndex: 0 })) === 0;
  if (!ok) return println(c.dim('  rien n\'a été annulé'));
  const done = [];
  while (S.undo.length > mark.at) { const r = undoLast({ undo: S.undo }, FILES.trash); if (!r) break; done.push(r); }
  S.turnMarks = S.turnMarks.slice(0, idx);
  S.notes.push(`L'utilisateur est revenu en arrière jusqu'avant sa demande « ${mark.text} » : ${done.length ? 'les fichiers modifiés depuis sont revenus à leur état d\'avant, relis-les avant de les modifier' : 'aucun fichier n\'avait été modifié'}. Ce qui a été dit depuis ne compte plus.`);
  println(c.green(`  ✓ retour avant « ${mark.text} »`) + c.dim(done.length ? ` : ${done.length} modification${done.length > 1 ? 's' : ''} annulée${done.length > 1 ? 's' : ''}` : ''));
  for (const d of done.slice(0, 12)) println(c.dim('    ' + d));
  if (opts.stdio) stdioSend('restorePrompt', { text: mark.full || mark.text, id: mark.id });
}

/** /update : met à jour FS-CLI (npm) puis le panneau des éditeurs, après un avertissement clair */
function runStep(cmd, args, label) {
  return new Promise(res => {
    let tail = '';
    const p = spawn(cmd, args, { shell: process.platform === 'win32', env: process.env, windowsHide: true });
    const take = d => { tail = (tail + d).slice(-4000); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 5 * 60_000);
    p.on('error', e => { clearTimeout(timer); res({ ok: false, tail: e.message }); });
    p.on('close', code => { clearTimeout(timer); res({ ok: code === 0, tail: tail.replace(/\x1b\[[0-9;]*m/g, '') }); });
    ui.spinner.start(label);
  }).finally(() => ui.spinner.stop());
}
async function runUpdate() {
  if (fs.existsSync(path.join(ROOT, '.git'))) return println(c.yellow('  FS-CLI tourne depuis un dossier de développement (git) : mets-le à jour avec git pull, pas avec /update.'));
  ui.spinner.start('recherche de la dernière version…');
  const u = await checkUpdate({ force: true }).catch(() => ({}));
  ui.spinner.stop();
  if (!u?.latest) return println(c.red('  impossible de joindre GitHub pour vérifier la version : réessaie plus tard ou lance ') + c.accent(INSTALL_CMD));
  const title = u.newer ? `Mettre à jour FS-CLI : v${u.current} → v${u.latest} ?` : `Tu as déjà la dernière version (v${u.current}). Réinstaller quand même ?`;
  const detail = [
    'FS-CLI va lancer sur ton PC :',
    `  1. ${INSTALL_CMD}`,
    '  2. l\'installation du panneau dans tes éditeurs (VS Code, Cursor, Antigravity IDE…)',
    'Ça prend 30 s à 1 min, avec Internet. Une réponse en cours serait interrompue.',
    'Gardés : tes conversations, tes réglages, tes dossiers approuvés et ta connexion à France Student.',
    'Ensuite il faut recharger la fenêtre de l\'éditeur (ou relancer fs-cli dans le terminal).',
    'FS-CLI est un projet communautaire non officiel de France Student. Nouveautés : https://github.com/0xBlxck/fs-cli/releases',
  ].join('\n');
  if (!(input.select && interactive)) { println(c.yellow('  ' + title)); println(c.dim('    ' + detail.replace(/\n/g, '\n    '))); println(c.dim('  en mode non interactif, lance : ') + c.accent(INSTALL_CMD)); return; }
  const go = await input.select({ title, detail, options: [u.newer ? 'Mettre à jour maintenant' : 'Réinstaller maintenant', 'Annuler'], defaultIndex: u.newer ? 0 : 1 });
  if (go !== 0) return println(c.dim('  mise à jour annulée'));
  const url = INSTALL_CMD.split(' ').pop();
  if (process.platform !== 'win32' && globalDirWritable(ROOT) === false) {   // Mac/Linux : dossier global de npm réservé à root → jamais sudo, on explique la vraie correction
    println(c.yellow("  ✗ npm n'a pas le droit d'écrire dans son dossier global :"));
    for (const l of npmPermissionHelp('EACCES')) println(c.dim('    ' + l));
    return;
  }
  const r1 = await runStep(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', url], 'mise à jour de FS-CLI…');
  if (!r1.ok) {
    println(c.red('  ✗ la mise à jour a échoué :'));
    for (const l of r1.tail.trim().split('\n').slice(-6)) println(c.dim('    ' + l));
    if (isNpmPermissionError(r1.tail)) for (const l of npmPermissionHelp(r1.tail)) println(c.yellow('    ' + l));   // jamais « sudo » : il abîme ~/.npm
    return println(c.dim('  à la main : ') + c.accent(INSTALL_CMD));
  }
  let ver = u.latest;
  try { ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch {}
  println(c.green(`  ✓ FS-CLI v${ver} installé`));
  const r2 = await runStep(process.execPath, [path.join(ROOT, 'cli.js'), '--vscode'], 'mise à jour du panneau dans tes éditeurs…');
  for (const l of r2.tail.trim().split('\n').filter(l => /✓|✗|installée|introuvable|échou/i.test(l)).slice(0, 6)) println('  ' + l.trim());
  if (!opts.stdio) return println(c.dim('  → relance fs-cli pour utiliser la nouvelle version'));
  const again = await input.select({ title: 'Recharger la fenêtre de l\'éditeur maintenant ?', detail: 'Le panneau redémarre avec la nouvelle version. Tes conversations sont gardées (horloge en haut à droite).', options: ['Recharger maintenant', 'Plus tard'], defaultIndex: 0 });
  if (again === 0) stdioSend('reloadWindow');
  else println(c.dim(`  → recharge plus tard : ${PALETTE_KEY} › « Reload Window »`));
}

/** palette d'actions du panneau (comme celle de Claude Code) : état des réglages, modifiables d'un clic */
async function sendSettings(fetchEffort = false) {
  if (fetchEffort) effortCache = (await requestJson('GET', '/user/instructions').catch(() => ({}))).data?.gptReasoning ?? effortCache;
  stdioSend('settings', {
    version: VERSION, effort: effortCache ?? null,
    toggles: Object.fromEntries(Object.keys(SETTING_KEYS).map(k => [k, k === 'refusalRecover' || k === 'mcpAskWhere' ? cfg[k] !== false : !!cfg[k]])),
    model: modelName(), mode: cfg.mode, project: cfg.fsProject?.name || '', cwd: S.cwd, target: S.targetDir || '', chat: !!S.chatId,
    rewindable: (S.turnMarks || []).some(m => S.undo.length > m.at),
  });
}

/** dossier de travail changé (commande /cd ou sélecteur du panneau) ; la confiance peut mener à un autre dossier */
async function changeCwd(dir) {
  const ok = await ensureFolderTrust(dir, { picked: true });            // /cd ou 📁 du panneau : choisi par toi, pas de 2e question (sauf dossier très large)
  if (!ok) return println(c.dim('  dossier inchangé'));
  S.cwd = ok; S.targetDir = null; S.notes.push(`Dossier courant changé : ${ok}`); refreshPrompt();
  return println(c.dim('  → dossier de travail : ' + ok));
}

/** demande un dossier : sélecteur de l'éditeur (panneau), sinon chemin tapé */
async function pickFolder(title) {
  if (opts.stdio && panelAtLeast('0.10.3')) {
    return new Promise(res => { folderWaiter = res; stdioSend('pickFolder', { purpose: 'trust', title }); });
  }
  const a = ((await ask('  chemin du dossier (Entrée = annuler) : ')) || '').trim().replace(/^["']|["']$/g, '');
  return a ? resolveP(a, S.cwd) : '';
}

async function ensureFolderTrust(dir, { picked = false } = {}) {
  if (isFolderTrusted(dir)) { if (picked) rememberWorkDir(dir); return dir; }
  const broad = isBroadFolder(dir);
  if (picked && !broad) { trustFolder(dir, { remember: false }); rememberWorkDir(dir); return dir; }   // dossier que tu viens de choisir toi-même : pas de 2e question
  const detail = `Le modèle pourra lire et modifier les fichiers de ce dossier et y lancer des commandes (avec confirmation pour les actions sensibles).` +
    (broad ? `\n⚠ C'est un dossier très large (racine du disque ou dossier personnel) : préfère le dossier précis d'un projet.` : '\nLa confiance vaut aussi pour ses sous-dossiers.');
  // lancé depuis un dossier large (ex. le dossier personnel) : le dernier dossier choisi est proposé en premier
  const last = broad && cfg.lastWorkDir && !samePathCI(cfg.lastWorkDir, dir) && fs.existsSync(cfg.lastWorkDir) && fs.statSync(cfg.lastWorkDir).isDirectory() ? cfg.lastWorkDir : '';
  const RESUME = last ? `Travailler dans ${ui.shortPath(last, 50)} (dernier dossier choisi)` : '';
  const options = broad ? [...(last ? [RESUME] : []), 'Oui, pour cette session seulement', 'Choisir un autre dossier…', 'Non'] : ['Oui, je fais confiance à ce dossier', 'Oui, pour cette session seulement', 'Choisir un autre dossier…', 'Non'];
  let idx;
  if (input.select && interactive) idx = await input.select({ title: `Faire confiance à ce dossier ? ${dir}`, detail, options, defaultIndex: 0 });
  else {
    println(c.yellow(`  ? Faire confiance à ce dossier ? ${dir}`)); println(c.dim('    ' + detail.replace(/\n/g, '\n    ')));
    const a = ((await ask(`  [o]ui / [s]ession seulement / [a]utre dossier / [N]on `)) || '').trim().toLowerCase();
    const yes = options.findIndex(o => o.startsWith('Oui'));
    idx = /^(o|oui|y|yes)$/.test(a) ? yes : /^s/.test(a) ? options.indexOf('Oui, pour cette session seulement') : /^(a|autre|c|choisir)$/.test(a) ? options.indexOf('Choisir un autre dossier…') : options.length - 1;
  }
  if (idx === null || idx === undefined || idx < 0 || options[idx] === 'Non') return false;
  if (RESUME && options[idx] === RESUME) return ensureFolderTrust(path.resolve(last), { picked: true });
  if (options[idx] === 'Choisir un autre dossier…') {
    const other = await pickFolder('Dossier de travail de FS-CLI');
    if (!other) return false;
    if (!fs.existsSync(other) || !fs.statSync(other).isDirectory()) { println(c.red('  dossier introuvable : ' + other)); return false; }
    return ensureFolderTrust(path.resolve(other), { picked: true });
  }
  trustFolder(dir, { remember: options[idx].startsWith('Oui, je') });
  return dir;
}
function samePathCI(a, b) { return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase(); }
// même dossier ? casse ignorée sous Windows et macOS seulement : sous Linux, /home/a/Proj et /home/a/proj sont deux dossiers (fs -c)
function sameDir(a, b, platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' ? samePathCI(a, b) : path.resolve(String(a)) === path.resolve(String(b));
}
/** dossier de travail choisi explicitement : proposé en premier au prochain lancement depuis un dossier large */
function rememberWorkDir(dir) { if (!isBroadFolder(dir)) saveCfgKeys({ lastWorkDir: path.resolve(dir) }); }

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
S.interactive = !opts.print;                                          // native.js : résumé possible en pleine longue tâche (pas en -p : /continue impossible)
if (opts.bypass) await enableBypass({ silent: true });                   // --dangerously-skip-permissions (choisi explicitement à la ligne de commande)
if (opts.project) {                                                    // --projet <nom|id> : pour cette exécution seulement (le réglage /projet ne change pas)
  const want = String(opts.project).trim(), low = want.toLocaleLowerCase('fr-FR');
  const list = await listFsProjects().catch(() => null);
  const p = list && (list.find(x => x.id === want) || list.find(x => String(x.name || '').trim().toLocaleLowerCase('fr-FR') === low));
  if (!p) { console.error(c.red(`  ✗ projet France Student introuvable : « ${want} »`) + c.dim('  (nom exact ou id ; /projet pour la liste)')); process.exit(1); }
  projectRun = { id: p.id, name: p.name };
  setProjectOverride(projectRun); S.projectName = p.name; refreshPrompt();
}
if (opts.print) {
  if (!initial) { console.log(c.red('  -p nécessite une demande')); process.exit(1); }
  await handleInput(initial);
  await shutdown(0, { quiet: true });
}

if (interactive) {
  attachScreen(input);
  if (input.select) setSelectHandler(o => input.select(o), { proposals: input.kind === 'stdio' });   // menus de confirmation à flèches (panneau : + diff proposé dans l'éditeur)
  input.start();
}
refreshPrompt();
if (opts.stdio) banner();                                              // panneau : « ready » tout de suite (le terminal affiche l'accueil APRÈS le choix du dossier)
requestJson('GET', '/chats/agents').then(r => {                      // fournisseur + taille de contexte : seuil de résumé adapté au modèle, sélecteur du panneau
  if (!Array.isArray(r?.data)) return;
  S.ctxWindows = Object.fromEntries(r.data.map(a => [String(a.id), Number(a.contextWindow) || 0]));
  S.providers = Object.fromEntries(r.data.map(a => [String(a.id), String(a.modelProvider || '').toLowerCase()]));   // openai / anthropic : certains réglages dépendent du fournisseur (refus de GPT)
  if (!opts.stdio) return;
  stdioSend('models', { models: r.data.filter(a => a && a.isActive !== false).map(a => ({ id: String(a.id), name: a.name, provider: String(a.modelProvider || ''), contextWindow: Number(a.contextWindow) || null })) });
}).catch(() => {});
if (opts.stdio) input.setBusy(true);                                 // panneau : rien ne part au modèle tant que la confiance n'est pas décidée
const trustedCwd = await ensureFolderTrust(S.cwd);
if (trustedCwd && trustedCwd !== S.cwd) { S.cwd = trustedCwd; S.targetDir = null; refreshPrompt(); }
if (!trustedCwd) {
  println(c.dim('  Dossier non approuvé : relance FS-CLI depuis le dossier de ton projet (ou --cwd <dossier>).'));
  saveSession(); input.stop(); process.exit(0);
}
if (!opts.stdio) banner();                                             // comme Claude Code : confiance d'abord, puis l'accueil avec le VRAI dossier de travail
if (opts.stdio) { holdInput = false; input.setBusy(false); const q = input.takeQueued(); if (q) runInput(q); }   // messages envoyés pendant le démarrage : maintenant
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
  if (opts.stdio) stdioSend('updateAvailable', { latest: u.latest, current: u.current });
  println(c.yellow(`  ⬆ FS-CLI v${u.latest} est disponible (tu as la v${u.current}). Pour mettre à jour :`));
  println(`    ${c.accent(INSTALL_CMD)}`);
  println(c.dim('    ou tape ') + c.accent('/update') + c.dim(' : FS-CLI le fait pour toi (panneau compris)'));
  if (!busy) input.prompt();
}).catch(() => {});
if (initial) await runInput(initial); else input.prompt();
