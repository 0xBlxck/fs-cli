// Commandes « fs-cli claude » (passerelle + vrai Claude Code branché dessus) et « fs-cli gateway » (passerelle seule),
// spécification § 4. La passerelle elle-même (src/gateway/index.js) est chargée à l'exécution seulement.
// Tout ce qui touche au système (processus, terminal, réseau) passe par `io`, remplaçable en test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { HOME_DIR, cfg, saveCfgKeys } from '../config.js';
import { createModels } from './models.js';
import { quotaState } from './recover.js';

const GW_DIR = () => path.join(HOME_DIR, 'gateway');
export const logFile = () => path.join(GW_DIR(), 'gateway.log');
const DEFAULT_GATEWAY_PORT = 8787;

const NO_SESSION = 'Pas de session France Student : lance d\'abord fs-cli --login.';
const NOT_FOUND = 'Claude Code est introuvable. Installe-le (npm i -g @anthropic-ai/claude-code ou https://code.claude.com), puis relance fs-cli claude.';

// ── Arguments ─────────────────────────────────────────────────────────────────

/** Options --fs-* lues par FS-CLI (tout le reste part tel quel à Claude Code). */
const FS_FLAGS = {
  '--fs-projet': { key: 'project', type: 'string' },
  '--fs-web': { key: 'web', type: 'bool' },
  '--fs-claude-md': { key: 'claudeMd', type: 'bool' },
  '--fs-retour': { key: 'rewind', type: 'enum', values: ['auto', 'note', 'chat'] },
  '--fs-sous-agents': { key: 'subagents', type: 'int', min: 0, max: 50 },
  '--fs-flux': { key: 'flows', type: 'int', min: 1, max: 20 },
  '--fs-demander': { key: 'ask', type: 'bool' },
  '--fs-port': { key: 'port', type: 'int', min: 1, max: 65535 },
  '--fs-nouveau-jeton': { key: 'newToken', type: 'bool' },
  '--fs-journal': { key: 'journal', type: 'bool' },
  '--fs-debug': { key: 'debug', type: 'bool' },
  '--fs-mcp': { key: 'mcp', type: 'bool' },
};

/** Valeurs par défaut des options de la passerelle (opts de createGateway / startGateway). */
export const FS_DEFAULTS = Object.freeze({
  project: null, web: false, claudeMd: false, rewind: 'auto', subagents: 3, flows: 3,
  ask: false, port: null, newToken: false, journal: false, debug: false, mcp: false,
});

function readValue(spec, flag, raw) {
  if (spec.type === 'bool') {
    if (raw === undefined) return { value: true };
    if (/^(1|true|on|oui|yes)$/i.test(raw)) return { value: true };
    if (/^(0|false|off|non|no)$/i.test(raw)) return { value: false };
    return { error: `Valeur invalide pour ${flag} : « ${raw} » (on ou off).` };
  }
  if (raw === undefined || raw === '' || raw.startsWith('--')) return { error: `L'option ${flag} attend une valeur.` };
  if (spec.type === 'string') return { value: raw };
  if (spec.type === 'enum') return spec.values.includes(raw) ? { value: raw } : { error: `Valeur invalide pour ${flag} : « ${raw} » (${spec.values.join(', ')}).` };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) return { error: `Valeur invalide pour ${flag} : « ${raw} » (nombre entier de ${spec.min} à ${spec.max}).` };
  return { value: n };
}

/** Valeur d'une option de Claude Code dans ses arguments (« --model x » ou « --model=x »), avant « -- ». */
function claudeOption(rest, name) {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (a === name) return rest[i + 1] ?? '';
    if (a.startsWith(name + '=')) return a.slice(name.length + 1);
  }
  return null;
}

/**
 * Sépare les options de FS-CLI (--fs-*) de celles de Claude Code.
 * → { fs: { ...FS_DEFAULTS, errors: string[], claudeModel: string|null, claudeSettings: string|null }, rest: string[] }
 * « -- » et tout ce qui le suit partent tels quels à Claude Code (« -- » compris, pour qu'il ne lise pas la suite comme des options).
 */
export function splitArgs(argv) {
  const out = { ...FS_DEFAULTS, errors: [] };
  const rest = [];
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--') { rest.push(...list.slice(i)); break; }
    if (!a.startsWith('--fs-')) { rest.push(a); continue; }
    const eq = a.indexOf('=');
    const flag = eq < 0 ? a : a.slice(0, eq);
    const spec = FS_FLAGS[flag];
    if (!spec) { out.errors.push(`Option inconnue : ${flag} (options de FS-CLI : ${Object.keys(FS_FLAGS).join(', ')}).`); continue; }
    let raw = eq < 0 ? undefined : a.slice(eq + 1);
    if (raw === undefined && spec.type !== 'bool') raw = list[++i];
    const r = readValue(spec, flag, raw);
    if (r.error) out.errors.push(r.error);
    else out[spec.key] = r.value;
  }
  out.claudeModel = claudeOption(rest, '--model');
  out.claudeSettings = claudeOption(rest, '--settings');
  return { fs: out, rest };
}

// ── Réglages enregistrés (--fs-garder / --fs-oublier) ─────────────────────────

/** Options jamais enregistrées (ponctuelles). */
const NOT_KEPT = new Set(['--fs-journal', '--fs-nouveau-jeton']);
/** Options de Claude Code enregistrables (avec leur valeur) : le reste (-p, -c, --resume…) est propre à une exécution. */
const CC_KEPT = ['--model', '--permission-mode'];
const flagOf = a => { const eq = a.indexOf('='); return eq < 0 ? a : a.slice(0, eq); };
/** l'option prend-elle l'argument suivant comme valeur ? (« --model x », pas « --model=x » ni « --fs-web ») */
const takesNext = a => !a.includes('=') && (FS_FLAGS[flagOf(a)] ? FS_FLAGS[flagOf(a)].type !== 'bool' : CC_KEPT.includes(flagOf(a)));
export const showArgs = list => list.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');

/** Options de argv à enregistrer : les --fs-* (sauf ponctuelles) et --model / --permission-mode, avec leur valeur, avant « -- ». */
export function keptArgs(argv) {
  const list = (argv || []).map(String), out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--') break;
    const f = flagOf(a);
    if (!FS_FLAGS[f] && !CC_KEPT.includes(f)) continue;
    const v = takesNext(a) ? list[++i] : undefined;
    if (NOT_KEPT.has(f) || (takesNext(a) && v === undefined)) continue;
    out.push(a, ...(v !== undefined ? [v] : []));
  }
  return out;
}

/** Réglages enregistrés placés devant ce qui est tapé ; une option tapée remplace la même option enregistrée.
 *  claude=false (fs-cli gateway) : seulement les --fs-*. */
export function withSaved(saved, argv, { claude = true } = {}) {
  const list = (argv || []).map(String);
  const end = list.indexOf('--');
  const typed = new Set((end < 0 ? list : list.slice(0, end)).map(flagOf));
  const out = [];
  const s = (saved || []).map(String);
  for (let i = 0; i < s.length; i++) {
    const a = s[i], f = flagOf(a);
    const v = takesNext(a) ? s[++i] : undefined;
    if (!FS_FLAGS[f] && !(claude && CC_KEPT.includes(f))) continue;
    if (NOT_KEPT.has(f) || typed.has(f)) continue;
    out.push(a, ...(v !== undefined ? [v] : []));
  }
  return [...out, ...list];
}

const savedDefaults = () => (Array.isArray(cfg.claudeDefaults) ? cfg.claudeDefaults.map(String) : []);

/** --fs-garder / --fs-oublier, puis réglages enregistrés ajoutés. → { argv } ou { done } */
async function applySaved(h, argv, { claude = true } = {}) {
  const list = (argv || []).map(String);
  const end = list.indexOf('--');
  const head = end < 0 ? list : list.slice(0, end);
  const keep = head.includes('--fs-garder'), forget = head.includes('--fs-oublier');
  const clean = list.filter((a, i) => !((end < 0 || i < end) && (a === '--fs-garder' || a === '--fs-oublier')));
  if ((keep || forget) && !claude) return { done: await h.fail(2, 'Les réglages s\'enregistrent avec fs-cli claude --fs-garder (ils servent aussi à fs-cli gateway).') };
  if (forget) {
    h.saveDefaults([]);
    h.err('Réglages de fs-cli claude effacés : retour aux options par défaut.\n');
    if (!keep) return { done: await h.exit(0) };
  }
  if (keep) {
    const k = keptArgs(clean);
    if (!k.length) {
      const cur = h.savedDefaults();
      h.out(cur.length ? `Réglages enregistrés : ${showArgs(cur)}\n(fs-cli claude --fs-oublier pour les effacer)\n`
        : 'Aucun réglage enregistré. Exemple : fs-cli claude --fs-garder --model gpt-6-astra --fs-projet "Mon projet" --permission-mode acceptEdits\n');
      return { done: await h.exit(0) };
    }
    const chk = splitArgs(k);
    if (chk.fs.errors.length) return { done: await h.fail(2, chk.fs.errors.join('\n')) };
    h.saveDefaults(k);
    h.err(`Réglages enregistrés : ${showArgs(k)}\nLa prochaine fois, « fs-cli claude » suffit (--fs-oublier pour les effacer).\n`);
    return { argv: clean };
  }
  const saved = h.savedDefaults();
  const merged = withSaved(saved, clean, { claude });
  const used = merged.slice(0, merged.length - clean.length);
  if (used.length) h.err(`Réglages enregistrés : ${showArgs(used)}  (--fs-oublier pour les effacer)\n`);
  return { argv: merged };
}

// ── Recherche de Claude Code ──────────────────────────────────────────────────

/** Variable d'environnement sans tenir compte de la casse sous Windows (Path, PATH…). */
function envGet(env, name, win) {
  if (!win) return env[name];
  const k = Object.keys(env).find(x => x.toUpperCase() === name.toUpperCase());
  return k === undefined ? undefined : env[k];
}

const defaultIsFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const defaultIsExec = p => { try { fs.accessSync(p, fs.constants.X_OK); return defaultIsFile(p); } catch { return false; } };
const defaultRead = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** Programme réellement lancé par le claude.cmd de npm : l'exe (ou l'ancien cli.js, lancé avec node). null si rien de connu. */
function behindCmd(cmdFile, { isFile, readFile, execPath }) {
  const P = path.win32, dir = P.dirname(cmdFile);
  const text = readFile(cmdFile) || '';
  const named = [...text.matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:exe|c?js|mjs))"/gi)].map(m => P.join(dir, m[1]));
  const pkg = P.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  const exes = [...named.filter(f => /\.exe$/i.test(f)), P.join(pkg, 'bin', 'claude.exe')];
  for (const f of exes) if (isFile(f)) return { cmd: f, isCmd: false, args: [] };
  const scripts = [...named.filter(f => /\.(?:c?js|mjs)$/i.test(f)), P.join(pkg, 'cli.js')];
  for (const f of scripts) if (isFile(f)) return { cmd: execPath, isCmd: false, args: [f] };
  return null;
}

/**
 * Trouve l'exécutable de Claude Code. → { cmd, isCmd, args } | null (args = arguments à placer avant ceux de l'utilisateur).
 * Windows : claude.exe dans le PATH, sinon l'exe caché derrière claude.cmd (npm), sinon ~/.local/bin/claude.exe ;
 * claude.cmd lui-même seulement en dernier recours (isCmd : lancé par cmd.exe, qui interprète % ^ & dans -p).
 * macOS / Linux : claude dans le PATH, puis les emplacements des installateurs (~/.local/bin, ~/.claude/local, Homebrew).
 * options (tests) : { platform, home, isFile, isExec, readFile, execPath }.
 */
export function findClaude(env = process.env, { platform = process.platform, home = os.homedir(), isFile = defaultIsFile,
  isExec = null, readFile = defaultRead, execPath = process.execPath } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const dirs = String(envGet(env || {}, 'PATH', win) || '').split(win ? ';' : ':')
    .map(d => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (win) {
    for (const d of dirs) { const f = P.join(d, 'claude.exe'); if (isFile(f)) return { cmd: f, isCmd: false, args: [] }; }
    let lastResort = null;
    for (const d of dirs) {
      const f = P.join(d, 'claude.cmd');
      if (!isFile(f)) continue;
      const real = behindCmd(f, { isFile, readFile, execPath });
      if (real) return real;
      lastResort ||= { cmd: f, isCmd: true, args: [] };
    }
    const local = P.join(home, '.local', 'bin', 'claude.exe');
    if (isFile(local)) return { cmd: local, isCmd: false, args: [] };
    return lastResort;
  }
  const exec = isExec || (isFile === defaultIsFile ? defaultIsExec : isFile);
  const extra = [P.join(home, '.local', 'bin'), P.join(home, '.claude', 'local'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin'];
  for (const d of [...dirs, ...extra]) { const f = P.join(d, 'claude'); if (exec(f)) return { cmd: f, isCmd: false, args: [] }; }
  return null;
}

/** Quote un argument pour cmd.exe (règles MSVCRT), comme src/mcp.js : seulement pour le dernier recours claude.cmd. */
function quoteWin(s) {
  s = String(s);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** « claude --version » (5 s au plus) → texte de la version, ou null. */
export function claudeVersion(bin, { timeout = 5000 } = {}) {
  try {
    const r = bin.isCmd
      ? spawnSync([bin.cmd, '--version'].map(quoteWin).join(' '), { shell: true, timeout, encoding: 'utf8', windowsHide: true })
      : spawnSync(bin.cmd, [...(bin.args || []), '--version'], { timeout, encoding: 'utf8', windowsHide: true });
    return String(r.stdout || '').trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

/** Version prévue par la passerelle (reconnaissance des requêtes internes faite sur 2.1.207). */
export const testedVersion = v => /\b2\.1\.2\d\d\b/.test(String(v || ''));

// ── Environnement de Claude Code ──────────────────────────────────────────────

/** Variables retirées de l'environnement de Claude Code (elles contourneraient la passerelle, ou sont des secrets de FS-CLI). */
const REMOVED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_OAUTH_TOKEN',
  'FS_SESSION_TOKEN', 'FS_PASSWORD', 'FS_EMAIL', 'FS_SEARCH_API_KEY', 'FS_SEARCH_PROVIDER', 'FS_CLI_BRIDGE'];

/** Modèles annoncés par défaut à Claude Code (alias opus/sonnet/haiku de /model, et une entrée GPT). */
export const CC_MODELS = Object.freeze({
  opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5',
  custom: Object.freeze({ id: 'claude-fs/gpt-6-astra', name: 'GPT-6 Astra (France Student)' }),
});

/**
 * Environnement du processus Claude Code : celui de FS-CLI, sans les variables qui contourneraient la passerelle,
 * plus ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN vers la passerelle et les réglages du § 4.2.
 * model : id à mettre dans ANTHROPIC_MODEL (ignoré si l'utilisateur passe --model : opts.claudeModel).
 * opts : options de splitArgs, plus models (remplace CC_MODELS) si besoin.
 */
export function childEnv(base, { url, token, model = null, opts = {} } = {}) {
  const set = {
    ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token,
    ...(model && !opts.claudeModel ? { ANTHROPIC_MODEL: model } : {}),
  };
  const m = { ...CC_MODELS, ...(opts.models || {}) };
  Object.assign(set, {
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.opus, ANTHROPIC_DEFAULT_SONNET_MODEL: m.sonnet, ANTHROPIC_DEFAULT_HAIKU_MODEL: m.haiku,
    ANTHROPIC_CUSTOM_MODEL_OPTION: m.custom.id, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: m.custom.name,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    // auto-mémoire coupée à la source : ses forks d'arrière-plan (extract_memories, auto_dream) n'ont rien à faire chez
    // France Student, et la mémoire n'y est de toute façon jamais envoyée
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    API_TIMEOUT_MS: '1800000', CLAUDE_CODE_MAX_RETRIES: '4',
  });
  // Windows ne distingue pas la casse des noms de variables : on retire toutes les variantes avant de poser les nôtres
  const drop = new Set([...REMOVED_ENV, ...Object.keys(set)].map(k => k.toUpperCase()));
  const env = {};
  for (const [k, v] of Object.entries(base || {})) if (!drop.has(k.toUpperCase()) && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(set)) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

// ── Réglages Claude Code de l'utilisateur ─────────────────────────────────────

const BYPASS_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const truthy = v => v !== undefined && v !== null && v !== false && !/^(|0|false|off|no)$/i.test(String(v).trim());

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** Règle d'autorisation sans restriction : « Bash », « Bash(*) », « Bash(:*) » (idem PowerShell). */
const unrestricted = rule => /^(Bash|PowerShell)(\(\s*:?\*\s*\))?$/.test(String(rule || '').trim());

/**
 * Lit ~/.claude/settings.json puis .claude/settings.json et .claude/settings.local.json du dossier, et signale ce qui
 * pourrait contourner la passerelle ou exécuter les commandes du modèle sans confirmation. Ne bloque jamais.
 * → { warnings: string[] }
 */
export function inspectClaudeSettings(cwd, home = os.homedir(), { subagents = FS_DEFAULTS.subagents } = {}) {
  const files = [...new Set([
    path.join(home, '.claude', 'settings.json'),
    path.join(cwd || '.', '.claude', 'settings.json'),
    path.join(cwd || '.', '.claude', 'settings.local.json'),
  ].map(f => path.resolve(f)))];
  const warnings = [];
  let allowAll = false, teams = false;
  for (const file of files) {
    const j = readJson(file);
    if (!j || typeof j !== 'object') continue;
    const env = j.env && typeof j.env === 'object' ? j.env : {};
    const found = BYPASS_ENV.filter(k => truthy(env[k]));
    if (truthy(j.apiKeyHelper)) found.push('apiKeyHelper');
    if (found.length) warnings.push(`Tes réglages Claude Code définissent ${found.join(', ')} : ils pourraient contourner la passerelle (${file}).`);
    const allow = Array.isArray(j.permissions?.allow) ? j.permissions.allow : [];
    if (allow.some(unrestricted) || j.permissions?.defaultMode === 'bypassPermissions') allowAll = true;
    if (truthy(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)) teams = true;
  }
  if (allowAll) warnings.push('Attention : tes réglages Claude Code autorisent toutes les commandes sans confirmation. Les commandes proposées par le modèle France Student s\'exécuteront donc sans te demander. Ajoute --fs-demander pour confirmer chaque commande.');
  if (teams) warnings.push(`Les équipes d'agents de Claude Code consomment des conversations France Student (au plus ${subagents} sous-agents).`);
  return { warnings };
}

// ── Fichiers de la passerelle ─────────────────────────────────────────────────

/** écriture privée (0600) et atomique ; repli Windows si le renommage échoue (fichier ouvert ailleurs) */
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, text, { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} }
  try { fs.chmodSync(file, 0o600); } catch {}
}

/**
 * Fichier de réglages passé avec --settings : env vers la passerelle, et règles « ask » avec --fs-demander.
 * Un fichier PAR PROCESSUS (claudeSettingsFile) : un chemin commun ferait relire à un Claude Code l'URL et le jeton
 * d'une autre passerelle « fs-cli claude » (démarrage simultané, rechargement des réglages). Pas de JSON en ligne :
 * la ligne de commande est lisible par les autres comptes de la machine, le fichier est en 0600.
 */
export const claudeSettingsFile = (pid = process.pid) => path.join(GW_DIR(), `claude-settings-${pid}.json`);

export function writeClaudeSettings(file, { url, token, ask = false }) {
  const j = { env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token }, ...(ask ? { permissions: { ask: ['Bash', 'PowerShell'] } } : {}) };
  writePrivate(file, JSON.stringify(j, null, 2) + '\n');
  return file;
}

/** Jeton persistant de « fs-cli gateway » (HOME_DIR/gateway/token, 0600) ; renew = --fs-nouveau-jeton. */
export function gatewayToken(file = path.join(GW_DIR(), 'token'), { renew = false } = {}) {
  if (!renew) {
    try { const t = fs.readFileSync(file, 'utf8').trim(); if (/^[A-Za-z0-9_-]{20,}$/.test(t)) return t; } catch {}
  }
  const t = crypto.randomBytes(24).toString('base64url');
  writePrivate(file, t + '\n');
  return t;
}

/** Ligne de stdout de « fs-cli gateway » pour un journal { event:'request', kind, chatId, ms, outcome } (main et subagent seulement). */
export function requestLine(obj, now = new Date()) {
  if (!obj || obj.event !== 'request' || !['main', 'subagent'].includes(obj.kind)) return null;
  const t = (obj.t ? new Date(obj.t) : now).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const chat = obj.chatId ? String(obj.chatId).slice(0, 8) : '-';
  const ms = Number.isFinite(obj.ms) ? `${(obj.ms / 1000).toFixed(1).replace('.', ',')} s` : '';
  return [t, obj.kind, chat, ms, obj.outcome || ''].filter(Boolean).join(' · ');
}

// ── Dépendances réelles (production) ──────────────────────────────────────────

/** deps de la passerelle branchées sur France Student (src/api.js), le registre des conversations et le disque. */
export async function realDeps() {
  const api = await import('../api.js');
  const chats = await import('../chats.js');
  const d = {
    stream: api.streamChat,
    resume: api.resumeStream,
    fetchChat: api.fetchChat,
    searchChats: api.searchChats,
    compactChat: api.compactChat,
    uploadFile: api.uploadFile,
    cancelStream: api.cancelStream,
    fetchAgentsFull: api.fetchAgentsFull,
    createdToday: () => chats.createdToday(),
    fsExists: p => { try { return fs.existsSync(p); } catch { return false; } },
    fsStat: p => { try { return fs.statSync(p); } catch { return null; } },
    now: () => Date.now(),
    /** 401 de France Student : relit les .env (« fs-cli --login » lancé ailleurs) ; true si une autre clé a été prise */
    reloadToken: async () => {
      const [{ envTokens }, conf] = await Promise.all([import('../mcp-server.js'), import('../config.js')]);
      const t = envTokens().find(x => x !== conf.TOKEN);
      if (!t) return false;
      conf.setToken(t);
      return true;
    },
  };
  d.quota = () => quotaState(d);
  return d;
}

/** Journal de la passerelle (src/gateway/log.js ; journal minimal en JSON lignes s'il manque). */
async function openLog(file, opts) {
  try { const m = await import('./log.js'); if (typeof m.createLog === 'function') return m.createLog(file, opts); } catch {}
  return {
    line(obj) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n', { mode: 0o600 }); } catch {}
    },
    debug() {}, close() {},
  };
}

/** --fs-projet : conversations de cette exécution rangées dans ce projet du site (créé s'il n'existe pas). null en cas d'échec. */
async function useFsProject(name) {
  try {
    const api = await import('../api.js');
    const { project } = await api.findOrCreateFsProject(name);
    api.setProjectOverride({ id: project.id, name: project.name || name });
    return project;
  } catch { return null; }
}

/** Plus rien sur le terminal : console.* et l'affichage de FS-CLI partent dans le journal (Claude Code a l'écran). */
async function silence(log) {
  const toLog = level => (...a) => { try { log.line({ event: 'console', level, text: util.format(...a).slice(0, 4000) }); } catch {} };
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = toLog(k);
  try { (await import('../ui.js')).attachSink({ print: () => {}, spinner: () => {} }); } catch {}
}

const shortHome = (p, home) => (home && p.toLowerCase().startsWith(home.toLowerCase() + path.sep) ? '~' + p.slice(home.length) : p);

function quotaText(q) {
  if (q.limitHit) return `limite de 50 nouvelles conversations atteinte (remise à zéro ${q.resetText})`;
  return q.remaining === 1 ? '1 nouvelle conversation restante aujourd\'hui' : `${q.remaining} nouvelles conversations restantes aujourd'hui`;
}

/** Accès au système, remplaçables en test (aucun processus, aucun réseau, aucune sortie réelle). */
function makeHost(io) {
  const h = {
    out: t => process.stdout.write(t),
    err: t => process.stderr.write(t),
    exit: code => process.exit(code),
    env: process.env,
    cwd: process.cwd(),
    home: os.homedir(),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    token: async () => (await import('../config.js')).TOKEN,
    login: async () => (await import('../setup.js')).loginWizard({ first: true }),
    findClaude: env => findClaude(env),
    version: bin => claudeVersion(bin),
    spawn: nodeSpawn,
    startGateway: async a => (await import('./index.js')).startGateway(a),
    deps: realDeps,
    project: useFsProject,
    savedDefaults,
    saveDefaults: list => saveCfgKeys({ claudeDefaults: list }),
    openLog,
    silence,
    onSignal: (sig, fn) => { try { process.on(sig, fn); } catch {} },
    ...io,
  };
  h.fail = (code, msg) => { h.err(msg + '\n'); return h.exit(code); };
  return h;
}

/** Début commun aux deux commandes : options invalides (code 2) et --fs-journal (affiche le chemin et quitte).
 *  → { o, rest }, ou { done: valeur de sortie } si la commande s'arrête là. */
async function prepare(h, argv) {
  const { fs: o, rest } = splitArgs(argv);
  if (o.errors.length) return { done: await h.fail(2, o.errors.join('\n')) };
  if (o.journal) { h.out(logFile() + '\n'); return { done: await h.exit(0) }; }
  return { o, rest };
}

/** → { gw }, ou { done } après le message d'erreur (code 1). */
async function startOrFail(h, args, failText) {
  try { return { gw: await h.startGateway(args) }; }
  catch (e) { return { done: await h.fail(1, failText(e)) }; }
}

// ── fs-cli claude ─────────────────────────────────────────────────────────────

/**
 * « fs-cli claude [options --fs-*] [options de Claude Code] » : démarre la passerelle dans ce processus, lance le vrai Claude Code
 * branché dessus (même terminal), puis quitte avec son code de sortie. io : accès système remplaçables (tests).
 */
export async function runClaude(argv, io = {}) {
  const h = makeHost(io);
  const sv = await applySaved(h, argv, { claude: true });
  if ('done' in sv) return sv.done;
  const p = await prepare(h, sv.argv);
  if ('done' in p) return p.done;
  const { o, rest } = p;
  if (!(await h.token()) && !(h.isTTY && await h.login())) return h.fail(1, NO_SESSION);
  const bin = h.findClaude(h.env);
  if (!bin) return h.fail(1, NOT_FOUND);

  const log = await h.openLog(logFile(), { debugDir: o.debug ? path.join(GW_DIR(), 'debug') : null });
  const version = h.version(bin);
  log.line({ event: 'claude', version, ...(testedVersion(version) ? {} : { warning: 'version de Claude Code non testée (passerelle prévue pour 2.1.2xx)' }) });
  for (const w of inspectClaudeSettings(h.cwd, h.home, { subagents: o.subagents }).warnings) h.err(w + '\n');
  if (o.claudeSettings !== null) h.err('Tu passes ton propre --settings : FS-CLI branche Claude Code par les variables d\'environnement seulement' + (o.ask ? ' (--fs-demander est sans effet).' : '.') + '\n');
  if (o.project && !(await h.project(o.project))) h.err(`Projet France Student « ${o.project} » inaccessible : les conversations sont rangées comme d'habitude.\n`);

  const deps = await h.deps();
  const token = crypto.randomBytes(24).toString('base64url');
  const s = await startOrFail(h, { host: '127.0.0.1', port: 0, token, deps, opts: o, log }, e => `Impossible de démarrer la passerelle : ${e?.message || e}`);
  if ('done' in s) return s.done;
  const { gw } = s;
  const url = gw.url || `http://127.0.0.1:${gw.port}`;
  await h.silence(log);

  const settings = o.claudeSettings === null ? writeClaudeSettings(claudeSettingsFile(), { url, token, ask: o.ask }) : null;
  const models = createModels(deps);
  const shown = o.claudeModel ? await models.resolve(o.claudeModel) : await models.fromAgentId(cfg.agentId);
  const ccId = o.claudeModel ? null : await models.ccId(cfg.agentId);
  const q = typeof deps.quota === 'function' ? deps.quota() : quotaState(deps);
  h.err(`FS-CLI → Claude Code · passerelle ${url.replace(/^https?:\/\//, '')} · ${shown?.name || o.claudeModel || 'modèle par défaut'} · ${quotaText(q)} · journal : ${shortHome(logFile(), h.home)}\n`);

  const env = childEnv(h.env, { url, token, model: ccId, opts: o });
  // Les serveurs MCP ne servent à rien au modèle France Student (il ne voit que les outils de fichiers) et ralentissent
  // le démarrage : coupés par défaut, sauf --fs-mcp ou si l'utilisateur passe lui-même --mcp-config / --strict-mcp-config.
  const noMcp = !o.mcp && claudeOption(rest, '--mcp-config') === null && !rest.includes('--strict-mcp-config');
  const args = [...(bin.args || []), ...(settings ? ['--settings', settings] : []), ...(noMcp ? ['--strict-mcp-config'] : []), ...rest];
  log.line({ event: 'spawn', cmd: bin.cmd, viaCmd: !!bin.isCmd, args: args.length });
  const child = bin.isCmd
    ? h.spawn([bin.cmd, ...args].map(quoteWin).join(' '), { stdio: 'inherit', env, shell: true })
    : h.spawn(bin.cmd, args, { stdio: 'inherit', env, shell: false });

  h.onSignal('SIGINT', () => {});                                    // Ctrl+C appartient à Claude Code
  for (const sig of ['SIGTERM', 'SIGHUP']) h.onSignal(sig, () => { try { child.kill(sig); } catch {} });
  const code = await new Promise(resolve => {
    let done = false;
    const end = c => { if (!done) { done = true; resolve(c); } };
    child.once('exit', c => end(c));
    child.once('error', e => { log.line({ event: 'spawn_error', message: String(e?.message || e) }); h.err(`Impossible de lancer Claude Code : ${e?.message || e}\n`); end(1); });
  });
  try { await gw.close(); } catch {}
  // le fichier de réglages de CE processus contient le jeton de la passerelle, désormais fermée : on ne le laisse pas traîner
  if (settings) { try { fs.unlinkSync(settings); } catch {} }
  let made = q.created;
  try { made = Number(deps.createdToday()) || 0; } catch {}
  h.err(`Session terminée · conversations France Student créées aujourd'hui : ${made}/50\n`);
  try { log.close(); } catch {}
  return h.exit(code ?? 1);
}

// ── fs-cli gateway ────────────────────────────────────────────────────────────

/**
 * « fs-cli gateway [--fs-port N] [--fs-nouveau-jeton] … » : la passerelle seule, pour Claude Code lancé à la main ou depuis VS Code.
 * Tourne jusqu'à Ctrl+C. io : accès système remplaçables (tests).
 */
export async function runGatewayCmd(argv, io = {}) {
  const h = makeHost(io);
  const sv = await applySaved(h, argv, { claude: false });
  if ('done' in sv) return sv.done;
  const p = await prepare(h, sv.argv);
  if ('done' in p) return p.done;
  const { o, rest } = p;
  if (rest.length) h.err(`Arguments ignorés par fs-cli gateway : ${rest.join(' ')}\n`);
  const port = o.port ?? DEFAULT_GATEWAY_PORT;
  const token = gatewayToken(path.join(GW_DIR(), 'token'), { renew: o.newToken });
  if (!(await h.token())) h.err('Pas encore de session France Student : lance fs-cli --login dans un autre terminal (inutile de redémarrer la passerelle).\n');
  if (o.project && !(await h.project(o.project))) h.err(`Projet France Student « ${o.project} » inaccessible : les conversations sont rangées comme d'habitude.\n`);

  const file = await h.openLog(logFile(), { debugDir: o.debug ? path.join(GW_DIR(), 'debug') : null });
  const log = {                                                        // journal + une ligne sur stdout par requête principale
    line(obj) { file.line(obj); const s = requestLine(obj); if (s) h.out(s + '\n'); },
    debug: (...a) => file.debug?.(...a),
    close: () => file.close?.(),
  };
  const deps = await h.deps();
  const s = await startOrFail(h, { host: '127.0.0.1', port, token, deps, opts: o, log },
    e => (e?.code === 'EADDRINUSE' ? `Le port ${port} est déjà utilisé (une autre passerelle ?). Choisis-en un autre avec --fs-port.` : `Impossible de démarrer la passerelle : ${e?.message || e}`));
  if ('done' in s) return s.done;
  const { gw } = s;
  await h.silence(file);

  const url = gw.url || `http://127.0.0.1:${gw.port ?? port}`;
  h.out([
    `Passerelle France Student pour Claude Code : ${url}   (Ctrl+C pour arrêter)`,
    `PowerShell :  $env:ANTHROPIC_BASE_URL="${url}"; $env:ANTHROPIC_AUTH_TOKEN="${token}"; Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; claude`,
    `bash / zsh :  ANTHROPIC_BASE_URL=${url} ANTHROPIC_AUTH_TOKEN=${token} claude`,
    'Extension VS Code : réglage « claudeCode.environmentVariables » avec ces deux variables.',
    '',
  ].join('\n'));
  for (const w of inspectClaudeSettings(h.cwd, h.home, { subagents: o.subagents }).warnings) h.err(w + '\n');

  return new Promise(resolve => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await gw.close(); } catch {}
      try { file.close(); } catch {}
      resolve(h.exit(0));
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) h.onSignal(sig, stop);
  });
}
