// Config, .env, sessions persistantes
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HOME_DIR = process.env.FS_CLI_HOME || path.join(os.homedir(), '.fs-cli');
fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });      // données privées : lisibles par toi seul (Linux/macOS)

export const FILES = {
  cfg: path.join(HOME_DIR, 'config.json'),
  hist: path.join(HOME_DIR, 'history.txt'),
  sessions: path.join(HOME_DIR, 'sessions.json'),
  legacySession: path.join(HOME_DIR, 'session.json'),
  trash: path.join(HOME_DIR, 'trash'),
};

// ── .env : process.env > dossier du CLI > ~/.fs-cli ────────────────────────────
// Sécurité : le .env du dossier COURANT n'est jamais lu (un dépôt piégé pourrait y mettre PATH ou NODE_OPTIONS),
// et seules ces clés sont acceptées, même dans nos propres fichiers .env.
const ENV_ALLOWED = new Set(['FS_SESSION_TOKEN', 'FS_AGENT_ID', 'FS_WORKDIR', 'FS_SEARCH_API_KEY', 'FS_SEARCH_PROVIDER']);
function loadEnv(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || !ENV_ALLOWED.has(m[1])) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== '' && !process.env[m[1]]) process.env[m[1]] = v;      // une variable vide compte comme absente
  }
}
loadEnv(path.join(ROOT, '.env'));
loadEnv(path.join(HOME_DIR, '.env'));

// ── Config persistante ─────────────────────────────────────────────────────────
const DEFAULTS = {
  agentId: -1002,
  mcpAskImported: false,
  toolRefusals: {},
  btwChat: null,           // /btw : conversation « à côté » réutilisée { id } (n'encombre pas la conversation en cours ni la limite de 50 par jour)
  webhook: '',             // URL appelée (POST JSON) à la fin de chaque demande : CI, notifications… (vide = désactivé)
  refusalRecover: true,    // un modèle croit ne pas avoir le droit d'utiliser les outils : 1 précision factuelle, puis la demande repart avec Sonnet (affiché)
  mcpChat: null,           // conversation France Student utilisée par le serveur MCP { id, title } : réutilisée même après un redémarrage
  mcpAskWhere: true,       // serveur MCP : au premier appel de chaque session, l'IDE (Claude Code…) affiche un choix de conversation (boutons)
  mcpProject: 'same',      // où ranger la conversation du MCP : 'same' = comme FS-CLI · false = conversations normales · { id, name } = ce projet
  fsProject: null,         // projet du site où ranger les conversations : null/false = conversations normales · { id, name } = ce projet
  fsProjectChosen: false,  // le choix « conversations normales / projet » a été fait (demandé une fois)
  lastWorkDir: '',         // dernier dossier de travail choisi explicitement : proposé en premier quand FS-CLI est lancé depuis un dossier large
  disabledSkills: [],      // skills du PC désactivés (noms en minuscules) : jamais joints ni annoncés au modèle
  dailyLimitHitAt: 0,      // France Student a répondu « limite de 50 nouvelles conversations atteinte » à cette date        // agentId → date : modèles qui refusent de travailler avec les outils de FS-CLI (prévenu à la sélection)   // false = serveurs MCP importés (Claude Code, Codex…) actifs directement · true = accord demandé avant le 1er démarrage (/mcp ask on)
  engine: 'native',    // native = vrais appels d'outils (mode officiel « outils client » de FS) · chat = le modèle écrit du code, le CLI l'exécute (secours)
  engineExplicit: false, // true dès que tu choisis avec /engine (sinon un ancien réglage « chat » est remplacé par « native »)
  autoCompact: true,  // compacte la conversation (résumé → nouvelle conversation) quand le contexte atteint le seuil
  compactThreshold: 80,
  compactTokensUser: false, // true = seuil choisi par toi avec /autocompact <n>k
  compactTokens: 0,        // 0 = automatique selon le modèle (30 % de sa fenêtre, entre 60k et 200k : Claude 1M → 200k, GPT 272k → ~80k) ; sinon ton seuil (/autocompact 150k)    // résumé aussi quand un message envoie plus que ça (l'historique entier repart à chaque message)
  sound: false,       // bip à la fin d'une réponse longue (> 3 s)
  eco: false,         // consignes de concision ajoutées aux demandes de création
  skills: [],         // ids des compétences actives (skills.json)
  tagChats: true,     // préfixe le 1er message d'une conversation avec [id] pour la retrouver dans la liste FS
  teamMode: 'same',   // /team : 'same' = agents à la suite DANS la conversation courante (aucune conversation créée) · 'pool' = agents en parallèle dans des conversations réutilisées
  maxParallel: 3,    // agents de /team travaillant en même temps (1-6)
  workerModel: null, // modèle des agents de /team (null = le modèle courant)
  duelModel: null,   // 2e modèle pour /compare
  showCode: false,   // false : les blocs de code sont repliés en une ligne (« ▸ html index.html · 118 lignes »), façon Claude Code
  fileHint: true,     // chat : ajoute une consigne de FORMAT (fichiers directs, pas de script générateur) quand tu demandes de créer du code/des fichiers
  feedback: true,     // chat + autoRun : renvoie les résultats d'exécution au modèle (false = affichés localement seulement)
  autoRun: true,     // chat : exécute automatiquement les blocs de la réponse (sans taper /run)
  autoRounds: 6,      // chat + autoRun : nombre max d'allers-retours (réparation après échec)
  mode: 'auto',       // auto = tout s'exécute sauf actions dangereuses · ask = confirmation pour écrire/exécuter
  webSearch: false,
  theme: 'cyan',
  showThinking: false,
  maxSteps: 40,
};
export const cfg = { ...DEFAULTS };
try {
  const saved = JSON.parse(fs.readFileSync(FILES.cfg, 'utf8'));
  for (const k of Object.keys(DEFAULTS)) if (saved[k] !== undefined) cfg[k] = saved[k];
} catch {}
if (!['auto', 'edits', 'ask', 'plan'].includes(cfg.mode)) cfg.mode = 'auto';
if (cfg.compactTokens === 80000 && !cfg.compactTokensUser) cfg.compactTokens = 0;   // ancienne valeur par défaut enregistrée → seuil automatique selon le modèle
if (!['native', 'chat'].includes(cfg.engine)) cfg.engine = 'native';
if (!cfg.engineExplicit && cfg.engine === 'chat') cfg.engine = 'native';      // migration : le mode natif est désormais disponible

/** enregistre seulement certaines clés (relit le fichier d'abord) : un autre processus FS-CLI peut tourner en même temps */
export function saveCfgKeys(obj) {
  Object.assign(cfg, obj);
  try { const cur = JSON.parse(fs.readFileSync(FILES.cfg, 'utf8')); fs.writeFileSync(FILES.cfg, JSON.stringify({ ...cur, ...obj }, null, 2), { mode: 0o600 }); }
  catch { saveCfg(); }
}

export function saveCfg() {
  try { fs.writeFileSync(FILES.cfg, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch {}
}

export let TOKEN = process.env.FS_SESSION_TOKEN || '';
/** Token fourni pendant l'exécution (assistant de premier lancement, /login) : jamais placé dans l'environnement. */
export function setToken(t) { TOKEN = String(t || '').trim(); }
// Sécurité : le token ne doit JAMAIS être hérité par les programmes que le CLI lance (commandes du modèle, serveurs MCP, python…)
// idem pour la clé de recherche web : elle est lue ici, puis passée explicitement à web.js (jamais laissée dans l'environnement des enfants)
export const SEARCH_KEY = process.env.FS_SEARCH_API_KEY || '';
export const SEARCH_PROVIDER = process.env.FS_SEARCH_PROVIDER || '';
for (const k of ['FS_SESSION_TOKEN', 'FS_PASSWORD', 'FS_EMAIL', 'FS_SEARCH_API_KEY', 'FS_SEARCH_PROVIDER']) delete process.env[k];

export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
if (process.env.FS_AGENT_ID && !isNaN(parseInt(process.env.FS_AGENT_ID))) cfg.agentId = parseInt(process.env.FS_AGENT_ID);
if (cfg.mode === 'bypass') cfg.mode = 'auto';                       // « tout autoriser » ne vaut que pour la session où il a été activé

// ── Sessions ───────────────────────────────────────────────────────────────────
export function loadSessions() {
  try {
    const list = JSON.parse(fs.readFileSync(FILES.sessions, 'utf8'));
    if (Array.isArray(list)) return list;
  } catch {}
  // migration de l'ancien session.json
  try {
    const s = JSON.parse(fs.readFileSync(FILES.legacySession, 'utf8'));
    if (s.chatId) return [{ chatId: s.chatId, agentId: s.agentId, cwd: s.cwd, title: '(ancienne session)', updatedAt: Date.now(), primed: false }];
  } catch {}
  return [];
}

/** conversations supprimées du site : marquées (jamais effacées du fichier), puis masquées des listes */
export function markSessionsGone(ids) {
  const set = new Set(ids); if (!set.size) return;
  const list = loadSessions().map(x => (set.has(x.chatId) ? { ...x, gone: true } : x));
  try { fs.writeFileSync(FILES.sessions, JSON.stringify(list, null, 1), { mode: 0o600 }); } catch {}
}

/** conversations masquées à tort (elles existent encore sur le site) : de nouveau visibles */
export function unmarkSessionsGone(ids) {
  const set = new Set(ids); if (!set.size) return;
  const list = loadSessions().map(x => (set.has(x.chatId) && x.gone ? (({ gone, ...rest }) => rest)(x) : x));
  try { fs.writeFileSync(FILES.sessions, JSON.stringify(list, null, 1), { mode: 0o600 }); } catch {}
}

export function upsertSession(s, { touch = true } = {}) {
  let list = loadSessions();
  const i = list.findIndex(x => x.chatId === s.chatId);
  if (!touch && i >= 0) list[i] = { ...list[i], ...s };               // simple mise à jour (ex. titre renommé) : ni date ni place changées
  else { list = list.filter(x => x.chatId !== s.chatId); list.unshift({ ...s, updatedAt: Date.now() }); }
  try { fs.writeFileSync(FILES.sessions, JSON.stringify(list.slice(0, 50), null, 1), { mode: 0o600 }); } catch {}
}
