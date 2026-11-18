// Client MCP (Model Context Protocol) : liste ET appelle les outils des serveurs MCP.
// Transports : stdio (JSON-RPC délimité par des retours à la ligne) et HTTP « Streamable HTTP ».
// Aucune dépendance npm. Aucun console.log : tout passe par onLog?.(msg).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { discoverMcpServers } from './discover.js';
import { bearerFor, hasLogin } from './mcp-oauth.js';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'fs-cli', version: '3.1.0' };
const IS_WIN = process.platform === 'win32';
const STDERR_KEEP = 8000;
const STDERR_TAIL = 2000;

// ── Presets ───────────────────────────────────────────────────────────────────
export const PRESETS = {
  filesystem: {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    description: 'Accès et manipulation des fichiers du projet local',
  },
  blender: {
    command: 'uvx', args: ['blender-mcp'],
    description: 'Blender 3D via MCP (l\'add-on Blender doit être lancé et connecté, port 9876)',
  },
  roblox: {
    command: 'node', args: ['bridge.js'],
    description: 'Bridge Roblox Studio MCP pour génération d\'assets et scripts',
  },
  memory: {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    description: 'Graphe de mémoire et connaissances persistantes pour l\'IA',
  },
  fetch: {
    command: 'uvx', args: ['mcp-server-fetch'],
    description: 'Extraction et lecture de contenu web pour l\'IA',
  },
  github: {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    description: 'Interaction avec les dépôts, commits et issues GitHub',
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
  },
  sqlite: {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '--db', 'database.sqlite'],
    description: 'Requêtage SQL et exploration de bases SQLite locales',
  },
  playwright: {
    command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    description: 'Pilotage d\'un navigateur (Playwright) : navigation, clics, captures',
  },
  'sequential-thinking': {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    description: 'Raisonnement structuré étape par étape',
  },
};

// ── Configuration ─────────────────────────────────────────────────────────────
function userDir() {
  return process.env.FS_CLI_HOME || path.join(os.homedir(), '.fs-cli');
}
/** Projets approuvés : un .mcp.json de projet peut lancer des commandes, il ne démarre donc qu'après /mcp trust.
 *  L'approbation est liée au CONTENU du fichier (SHA-256) : toute modification demande une nouvelle approbation. */
const trustFile = () => path.join(userDir(), 'trusted-projects.json');
function projectHash(cwd) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(mcpConfigPaths(cwd).projet)).digest('hex'); } catch { return null; }
}
function readTrust() {
  try { const d = JSON.parse(fs.readFileSync(trustFile(), 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; }
}
/** Clé d'un projet : chemin réel (Mac : /tmp → /private/tmp, casse réelle du disque), en minuscules comme avant. */
const projectKey = cwd => { let p = path.resolve(cwd || process.cwd()); try { p = fs.realpathSync.native(p); } catch {} return p.toLowerCase(); };
export function isProjectTrusted(cwd) {
  const h = projectHash(cwd);
  const d = readTrust();
  return !!h && (d[projectKey(cwd)] === h || d[path.resolve(cwd || process.cwd()).toLowerCase()] === h);   // ancienne clé : approbations déjà enregistrées
}
export function trustProject(cwd) {
  const h = projectHash(cwd); if (!h) return false;
  const d = readTrust(); d[projectKey(cwd)] = h;
  fs.mkdirSync(userDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(trustFile(), JSON.stringify(d), { mode: 0o600 });
  return true;
}

/** Chemins des fichiers de config : { user, projet }. */
export function mcpConfigPaths(cwd) {
  return { user: path.join(userDir(), 'mcp.json'), projet: path.join(path.resolve(cwd || process.cwd()), '.mcp.json') };
}

function readJsonFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { missing: true }; }
  try { return { data: JSON.parse(raw.replace(/^﻿/, '')) }; }
  catch (e) { return { error: `${file} : JSON invalide (${e.message})` }; }
}

function normalizeServer(raw, scope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = { _scope: scope };
  if (typeof raw.command === 'string' && raw.command.trim()) s.command = raw.command.trim();
  s.args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  s.env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
    ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {};
  if (typeof raw.url === 'string' && raw.url.trim()) s.url = raw.url.trim();
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    s.headers = Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)]));
  }
  if (typeof raw.description === 'string') s.description = raw.description;
  s.disabled = raw.disabled === true;
  return s;
}

/** Fusionne ~/.fs-cli/mcp.json (user) puis <cwd>/.mcp.json (projet, prioritaire). Ne lève jamais d'exception. */
export function loadMcpConfig(cwd) {
  const out = { mcpServers: {} };
  const errors = [];
  let paths;
  try { paths = mcpConfigPaths(cwd); } catch (e) { out._error = e.message; out._errors = [e.message]; return out; }
  for (const scope of ['user', 'projet']) {
    const r = readJsonFile(paths[scope]);
    if (r.missing) continue;
    if (r.error) { errors.push(r.error); continue; }
    const servers = r.data && typeof r.data === 'object' ? r.data.mcpServers : null;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, raw] of Object.entries(servers)) {
      const s = normalizeServer(raw, scope);
      if (s) out.mcpServers[name] = s; // le projet remplace l'entrée user du même nom
    }
  }
  // serveurs déjà configurés dans tes autres assistants (Claude Code, Codex…) : priorité la plus basse
  try {
    for (const [name, raw] of Object.entries(discoverMcpServers(path.resolve(cwd || process.cwd())))) {
      if (out.mcpServers[name]) continue;
      const s = normalizeServer(raw, 'importé');
      if (s) { s._source = raw._source; if (raw.cwd) s.cwd = raw.cwd; out.mcpServers[name] = s; }
    }
  } catch {}
  if (errors.length) { out._error = errors.join(' ; '); out._errors = errors; }
  return out;
}

/**
 * Écrit la config du scope ('user'|'projet'). Les champs commençant par '_' sont retirés ; les serveurs
 * dont _scope vaut l'autre scope sont ignorés (on peut donc passer directement la config fusionnée).
 * Retourne { ok, path, error? } (ne lève pas).
 */
export function saveMcpConfig(scope, cwd, config) {
  try {
    if (scope !== 'user' && scope !== 'projet') throw new Error(`Scope inconnu : "${scope}" (user|projet)`);
    const file = mcpConfigPaths(cwd)[scope];
    const servers = {};
    for (const [name, s] of Object.entries((config && config.mcpServers) || {})) {
      if (!s || typeof s !== 'object') continue;
      if (s._scope && s._scope !== scope) continue;
      const clean = {};
      for (const [k, v] of Object.entries(s)) if (!k.startsWith('_') && v !== undefined) clean[k] = v;
      servers[name] = clean;
    }
    let base = {};
    const prev = readJsonFile(file);
    if (prev.data && typeof prev.data === 'object' && !Array.isArray(prev.data)) {
      base = Object.fromEntries(Object.entries(prev.data).filter(([k]) => !k.startsWith('_')));
    }
    base.mcpServers = servers;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(base, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Utilitaires ───────────────────────────────────────────────────────────────
class McpError extends Error {
  constructor(message, kind = 'rpc', extra = {}) {
    super(message);
    this.name = 'McpError';
    this.kind = kind; // timeout | abort | closed | spawn | http | rpc
    Object.assign(this, extra);
  }
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const expandVars = (s) => (typeof s === 'string' ? s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, v) => process.env[v] ?? m) : s);

/** Combine un AbortSignal externe et un délai ; expose timedOut(). */
function linkSignals(signal, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs) : null;
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    aborted: () => !!signal?.aborted,
    cleanup() { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

const timeoutError = (method, ms) => new McpError(`Délai dépassé (${Math.round(ms / 100) / 10} s) : pas de réponse à "${method}"`, 'timeout');
const abortError = () => new McpError('Opération annulée', 'abort');

/** Quote un argument pour cmd.exe (règles MSVCRT). */
function quoteWin(s) {
  s = String(s);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

// Secours : tuer les enfants restants à la sortie du process.
const CHILDREN = new Set();
let exitHookInstalled = false;
function killTree(proc, sync = false) {
  if (!proc || proc.pid == null) return;
  try {
    if (IS_WIN) {
      const args = ['/pid', String(proc.pid), '/T', '/F'];
      if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } else {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    }
  } catch { /* déjà mort */ }
}
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => { for (const p of CHILDREN) killTree(p, true); });
  // Mac/Linux : fermer l'onglet du terminal envoie SIGHUP, et Node s'arrête sans « exit ». Les serveurs lancés en
  // detached (nouvelle session) ne reçoivent pas ce signal : on les arrête ici, puis on sort (hooks « exit » compris).
  if (!IS_WIN) for (const [sig, n] of [['SIGHUP', 1], ['SIGTERM', 15]]) {
    process.on(sig, () => {
      for (const p of CHILDREN) killTree(p, true);
      if (process.listenerCount(sig) <= 1) process.exit(128 + n);    // personne d'autre n'écoute : comportement par défaut (sortie)
    });
  }
}

function handleServerRequest(msg) {
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
}

// ── Transport stdio ───────────────────────────────────────────────────────────
class StdioTransport {
  constructor(name, cfg, { cwd, onLog }) {
    this.name = name; this.cfg = cfg; this.cwd = cwd; this.onLog = onLog;
    this.nextId = 0; this.pending = new Map();
    this.stderr = ''; this.dead = false; this.exitInfo = null; this.spawnError = null;
    this.onNotification = null; this.onClose = null;
    this.buf = '';
    this._start();
  }

  _start() {
    const { command, args = [], env = {} } = this.cfg;
    const useShell = IS_WIN && !/\.exe$/i.test(command);
    const cwd = this.cwd && fs.existsSync(this.cwd) ? this.cwd : process.cwd();
    const opts = {
      env: { ...process.env, FS_CLI_BRIDGE: '', ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandVars(v)])) },   // le pont de session n'est pas transmis aux serveurs
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    };
    const eargs = args.map(expandVars);
    let proc;
    try {
      if (useShell) {
        proc = spawn([command, ...eargs].map(quoteWin).join(' '), { ...opts, shell: true });
      } else {
        proc = spawn(expandVars(command), eargs, { ...opts, detached: !IS_WIN });
      }
    } catch (e) {
      this.spawnError = e;
      this._fail(new McpError(`Impossible de lancer "${command}" : ${e.message}`, 'spawn'));
      return;
    }
    this.proc = proc;
    CHILDREN.add(proc); installExitHook();
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => this._onData(d));
    proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + stripAnsi(d)).slice(-STDERR_KEEP);
    });
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    proc.on('error', (e) => {
      this.spawnError = e;
      const msg = e.code === 'ENOENT'
        ? `Commande introuvable : "${command}" (est-elle installée et dans le PATH ?)`
        : `Impossible de lancer "${command}" : ${e.message}`;
      this._fail(new McpError(msg, 'spawn'));
    });
    proc.on('exit', (code, sig) => {
      this.exitInfo = { code, sig };
      CHILDREN.delete(proc);
      // laisse le temps de traiter les dernières données déjà dans le pipe
      setTimeout(() => this._fail(this._exitError()), 150).unref?.();
    });
    proc.on('close', (code, sig) => {
      this.exitInfo = this.exitInfo || { code, sig };
      CHILDREN.delete(proc);
      this._fail(this._exitError());
    });
  }

  _exitError() {
    const { code, sig } = this.exitInfo || {};
    const cmd = this.cfg.command;
    let msg = `Le serveur MCP s'est arrêté (${sig ? `signal ${sig}` : `code ${code}`})`;
    if (IS_WIN && code === 1 && /n.est pas reconnu|is not recognized|introuvable|cannot find/i.test(this.stderr)) {
      msg = `Commande introuvable : "${cmd}" (est-elle installée et dans le PATH ?)`;
    } else if (code === 127) {
      msg = `Commande introuvable : "${cmd}"`;
    }
    return new McpError(msg, 'closed');
  }

  get alive() { return !this.dead; }
  tail() { return this.stderr.slice(-STDERR_TAIL).trim(); }

  _fail(err) {
    if (this.dead) return;
    this.dead = true; this.deathError = err;
    for (const p of [...this.pending.values()]) p.reject(err);
    this.pending.clear();
    try { this.onClose?.(err); } catch { /* ignore */ }
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line || line[0] !== '{' && line[0] !== '[') continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // ligne non-JSON : ignorée
      for (const m of Array.isArray(msg) ? msg : [msg]) this._dispatch(m);
    }
    if (this.buf.length > 64 * 1024 * 1024) this.buf = ''; // garde-fou
  }

  _dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.method !== undefined) {
      if (msg.id !== undefined && msg.id !== null) this._write(handleServerRequest(msg));
      else { try { this.onNotification?.(msg); } catch { /* ignore */ } }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.error) {
      p.reject(new McpError(msg.error.message || 'Erreur JSON-RPC', 'rpc', { code: msg.error.code, data: msg.error.data }));
    } else p.resolve(msg.result);
  }

  _write(obj, cb) {
    if (this.dead || !this.proc?.stdin?.writable) { cb?.(this.deathError || new McpError('Serveur MCP indisponible', 'closed')); return; }
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n', (err) => cb?.(err)); }
    catch (e) { cb?.(e); }
  }

  request(method, params, { timeoutMs = 60000, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.deathError);
      if (signal?.aborted) return reject(abortError());
      const id = ++this.nextId;
      let timer = null, onAbort = null;
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.pending.delete(id); };
      const cancel = (reason) => {
        if (method !== 'initialize') this._write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
      };
      this.pending.set(id, {
        resolve: (v) => { done(); resolve(v); },
        reject: (e) => { done(); reject(e); },
      });
      timer = setTimeout(() => { cancel('timeout'); this.pending.get(id)?.reject(timeoutError(method, timeoutMs)); }, timeoutMs);
      onAbort = () => { cancel('annulé'); this.pending.get(id)?.reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this._write({ jsonrpc: '2.0', id, method, params }, (err) => {
        if (err) this.pending.get(id)?.reject(new McpError(`Écriture impossible vers le serveur MCP : ${err.message}`, 'closed'));
      });
    });
  }

  async notify(method, params) {
    this._write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async close() {
    const proc = this.proc;
    this._fail(new McpError('Connexion fermée', 'closed'));
    if (!proc) return;
    const exited = () => proc.exitCode !== null || proc.signalCode !== null;
    try { proc.stdin.end(); } catch { /* ignore */ }
    if (!exited()) {
      await new Promise((res) => {
        const t = setTimeout(res, 400);
        proc.once('exit', () => { clearTimeout(t); res(); });
      });
    }
    if (!exited() || IS_WIN) killTree(proc); // sous Windows, l'arbre (cmd -> npx -> node) peut survivre
    CHILDREN.delete(proc);
  }
}

// ── Transport HTTP (Streamable HTTP) ──────────────────────────────────────────
async function readSse(res, onMessage) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n|\r\r/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = block.split(/\r\n|\r|\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (onMessage(msg) === true) return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

class HttpTransport {
  constructor(name, cfg, { onLog }) {
    this.name = name; this.onLog = onLog;
    this.url = expandVars(cfg.url);
    this.headers = Object.fromEntries(Object.entries(cfg.headers || {}).map(([k, v]) => [k, expandVars(v)]));
    this.nextId = 0; this.sessionId = null; this.protocolVersion = null;
    this.dead = false; this.onNotification = null; this.onClose = null;
  }
  get alive() { return !this.dead; }
  tail() { return ''; }
  setProtocolVersion(v) { this.protocolVersion = v; }

  _headers() {
    const h = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...this.headers };
    if (this.bearer && !Object.keys(this.headers).some(k => k.toLowerCase() === 'authorization')) h.Authorization = `Bearer ${this.bearer}`;   // connexion faite dans FS-CLI (/mcp login)
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  async _post(body, signal, retried = false) {
    let res;
    try {
      if (this.bearer === undefined) this.bearer = await bearerFor(this.url).catch(() => null);   // une fois par connexion (renouvelé s'il expire)
      res = await fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body), signal, redirect: 'error' });
    } catch (e) {
      if (signal?.aborted) throw e;
      const c = e.cause?.code || e.cause?.message || e.message;
      throw new McpError(`Connexion impossible à ${this.url} : ${c}`, 'http');
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300).trim(); } catch { /* ignore */ }
      if ((res.status === 404 || res.status === 405) && /\/sse\/?(\?.*)?$/i.test(this.url)) {
        throw new McpError(`Le serveur répond HTTP ${res.status} sur ${this.url} : l'ancien transport SSE (HTTP+SSE de 2024-11-05) n'est pas supporté. `
          + 'Utilise un serveur « Streamable HTTP » (URL en /mcp) ou un serveur stdio.', 'http', { status: res.status });
      }
      if (res.status === 401 && !retried && hasLogin(this.url)) {        // jeton expiré : renouvelé, puis un seul nouvel essai
        this.bearer = await bearerFor(this.url, { force: true }).catch(() => null);
        if (this.bearer) return this._post(body, signal, true);
      }
      if (res.status === 401 || res.status === 403) {
        throw new McpError(`HTTP ${res.status} : ce serveur demande une connexion à ton compte. Connecte-le avec « /mcp login ${this.name} » (ou le bouton « Se connecter » de la fenêtre Serveurs MCP) : la page de connexion s'ouvre dans ton navigateur.`, 'http', { status: res.status });
      }
      if (res.status === 404 && this.sessionId) {
        throw new McpError('Session MCP expirée (HTTP 404) : reconnecte le serveur', 'http', { status: 404 });
      }
      throw new McpError(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, 'http', { status: res.status });
    }
    return res;
  }

  _serverMessage(msg) {
    if (msg.method === undefined) return;
    if (msg.id !== undefined && msg.id !== null) {
      // requête serveur -> client : on répond par un POST (échec ignoré)
      fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(handleServerRequest(msg)), redirect: 'error' })
        .then((r) => r.body?.cancel?.()).catch(() => {});
    } else { try { this.onNotification?.(msg); } catch { /* ignore */ } }
  }

  async request(method, params, { timeoutMs = 60000, signal } = {}) {
    if (this.dead) throw new McpError('Connexion fermée', 'closed');
    const id = ++this.nextId;
    const link = linkSignals(signal, timeoutMs);
    try {
      const res = await this._post({ jsonrpc: '2.0', id, method, params }, link.signal);
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      let found = null;
      const take = (m) => {
        if (m && m.method === undefined && m.id === id) { found = m; return true; }
        this._serverMessage(m);
        return false;
      };
      if (ctype.includes('text/event-stream')) {
        await readSse(res, take);
      } else {
        const text = await res.text();
        if (text.trim()) {
          let data;
          try { data = JSON.parse(text); } catch { throw new McpError(`Réponse non-JSON du serveur (${text.slice(0, 120).trim()})`, 'http'); }
          for (const m of Array.isArray(data) ? data : [data]) if (take(m)) break;
        }
      }
      if (!found) throw new McpError(`Réponse absente pour "${method}" (flux terminé sans réponse)`, 'http');
      if (found.error) throw new McpError(found.error.message || 'Erreur JSON-RPC', 'rpc', { code: found.error.code, data: found.error.data });
      return found.result;
    } catch (e) {
      if (e instanceof McpError) throw e;
      if (link.timedOut()) throw timeoutError(method, timeoutMs);
      if (link.aborted() || e.name === 'AbortError') throw abortError();
      throw new McpError(`Erreur réseau : ${e.cause?.code || e.message}`, 'http');
    } finally {
      link.cleanup();
    }
  }

  async notify(method, params) {
    const link = linkSignals(null, 10000);
    try {
      const res = await this._post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, link.signal);
      res.body?.cancel?.().catch(() => {});
    } catch (e) {
      if (e instanceof McpError && e.kind === 'http' && e.status) return; // statut inattendu sur une notification : toléré
      if (e instanceof McpError) throw e;
      throw link.timedOut() ? timeoutError(method, 10000) : new McpError(`Erreur réseau : ${e.cause?.code || e.message}`, 'http');
    } finally { link.cleanup(); }
  }

  async close() {
    if (this.dead) return;
    this.dead = true;
    if (this.sessionId) {
      const link = linkSignals(null, 2000);
      try {
        const h = this._headers(); delete h['Content-Type'];
        await fetch(this.url, { method: 'DELETE', headers: h, signal: link.signal, redirect: 'error' }).then((r) => r.body?.cancel?.());
      } catch { /* ignoré */ } finally { link.cleanup(); }
    }
    try { this.onClose?.(new McpError('Connexion fermée', 'closed')); } catch { /* ignore */ }
  }
}

// ── Connexion à un serveur ────────────────────────────────────────────────────
class Connection {
  constructor(name, cfg, { cwd, onLog }) {
    this.name = name; this.cfg = cfg; this.onLog = onLog;
    this.transport = cfg.url && !cfg.command ? new HttpTransport(name, cfg, { onLog }) : new StdioTransport(name, cfg, { cwd, onLog });
    this.kind = cfg.url && !cfg.command ? 'http' : 'stdio';
    this.tools = null; this.serverInfo = null; this.closed = false;
    this.transport.onNotification = (m) => {
      if (m.method === 'notifications/tools/list_changed') this.tools = null;
    };
  }

  get alive() { return !this.closed && this.transport.alive; }
  stderrTail() { return this.transport.tail(); }

  async request(method, params, opts) {
    try {
      return await this.transport.request(method, params, opts);
    } catch (e) {
      if (e instanceof McpError && ['closed', 'timeout', 'spawn'].includes(e.kind) && !e._decorated) {
        const t = this.transport.tail();
        if (t) e.message += `\nstderr :\n${t}`;
        e._decorated = true;
      }
      throw e;
    }
  }

  async init({ timeoutMs = 30000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    const rem = () => Math.max(300, deadline - Date.now());
    const res = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, { timeoutMs: rem(), signal });
    this.serverInfo = res?.serverInfo || null;
    this.transport.setProtocolVersion?.(res?.protocolVersion || PROTOCOL_VERSION);
    await this.transport.notify('notifications/initialized');
    await this.fetchTools({ timeoutMs: rem(), signal });
  }

  async fetchTools({ timeoutMs = 30000, signal } = {}) {
    const all = [];
    let cursor;
    try {
      for (let page = 0; page < 100; page++) {
        const res = await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs, signal });
        for (const t of res?.tools || []) {
          if (t && typeof t.name === 'string') all.push({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} } });
        }
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
    } catch (e) {
      if (e.kind === 'rpc' && e.code === -32601) { this.tools = []; return this.tools; } // serveur sans outils
      throw e;
    }
    this.tools = all;
    return all;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close();
  }
}

// ── Manager ───────────────────────────────────────────────────────────────────
const sigOf = (cfg, cwd) => JSON.stringify([cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers, cfg.url ? '' : cwd]);

export class McpManager {
  constructor({ cwd = process.cwd(), onLog } = {}) {
    this.cwd = path.resolve(cwd);
    this.onLog = onLog;
    this._conns = new Map();       // name -> { conn, sig }
    this._connecting = new Map();  // name -> Promise
    this._live = new Set();        // toutes les Connection non fermées (y compris en cours d'init)
    this._failed = new Map();      // name -> timestamp du dernier échec
    this._lastStderr = new Map();  // name -> dernier stderr connu
  }

  _log(msg) { try { this.onLog?.(msg); } catch { /* ignore */ } }

  setCwd(cwd) {
    const next = path.resolve(cwd);
    if (next === this.cwd) return;
    this.cwd = next;
    this._failed.clear();
    // les connexions stdio dépendent du cwd, la config projet aussi : on les referme (reconnexion à la demande)
    this._closeAllNow().catch(() => {});
  }

  _config(name) { return loadMcpConfig(this.cwd).mcpServers[name]; }

  async list() {
    const cfg = loadMcpConfig(this.cwd);
    return Object.entries(cfg.mcpServers).map(([name, s]) => {
      const e = this._conns.get(name);
      const connected = !!(e && e.conn.alive && e.conn.tools);
      return {
        name,
        transport: s.url && !s.command ? 'http' : 'stdio',
        disabled: !!s.disabled,
        description: s.description || '',
        connected,
        toolCount: connected ? e.conn.tools.length : 0,
        scope: s._scope,
      };
    });
  }

  /** Démarre (si besoin) et initialise la connexion ; réutilise une connexion vivante de même config. */
  async connect(name, { timeoutMs = 30000, signal } = {}) {
    const s = this._config(name);
    if (!s) throw new Error(`Serveur MCP inconnu : "${name}"`);
    if (s.disabled) throw new Error(`Le serveur MCP "${name}" est désactivé`);
    if (s._scope === 'projet' && !isProjectTrusted(this.cwd)) throw new Error(`Serveur MCP "${name}" défini par le projet (.mcp.json) : non approuvé. Vérifie ce fichier puis lance /mcp trust`);
    if (!s.command && !s.url) throw new Error(`Serveur MCP "${name}" : ni "command" ni "url" dans la config`);
    const sig = sigOf(s, this.cwd);
    const cur = this._conns.get(name);
    if (cur && cur.conn.alive && cur.sig === sig) return this._info(name, cur.conn);
    if (cur) { this._conns.delete(name); this._dropConn(name, cur.conn); }
    const inflight = this._connecting.get(name);
    if (inflight) return inflight;
    const p = this._open(name, s, sig, { timeoutMs, signal }).finally(() => this._connecting.delete(name));
    this._connecting.set(name, p);
    return p;
  }

  _info(name, conn) {
    return { name, transport: conn.kind, serverInfo: conn.serverInfo, toolCount: conn.tools ? conn.tools.length : 0 };
  }

  _dropConn(name, conn) {
    this._lastStderr.set(name, conn.stderrTail());
    this._live.delete(conn);
    conn.close().catch(() => {});
  }

  async _open(name, s, sig, { timeoutMs, signal }) {
    const conn = new Connection(name, s, { cwd: this.cwd, onLog: this.onLog });
    this._live.add(conn);
    conn.transport.onClose = () => {
      this._lastStderr.set(name, conn.stderrTail());
      this._live.delete(conn);
      const e = this._conns.get(name);
      if (e && e.conn === conn) { this._conns.delete(name); this._log(`MCP ${name} : connexion terminée`); }
    };
    this._log(`MCP ${name} : connexion (${conn.kind})…`);
    try {
      await conn.init({ timeoutMs, signal });
    } catch (e) {
      this._lastStderr.set(name, conn.stderrTail());
      this._failed.set(name, Date.now());
      this._live.delete(conn);
      await conn.close().catch(() => {});
      this._log(`MCP ${name} : échec — ${e.message.split('\n')[0]}`);
      const err = new Error(`Serveur MCP "${name}" : ${e.message}`);
      err.kind = e.kind;
      throw err;
    }
    if (conn.closed || !conn.alive) throw new Error(`Serveur MCP "${name}" : connexion perdue pendant l'initialisation`);
    this._failed.delete(name);
    this._conns.set(name, { conn, sig });
    this._log(`MCP ${name} : connecté (${conn.tools.length} outil(s))`);
    return this._info(name, conn);
  }

  async listTools(name, { refresh = false, signal } = {}) {
    await this.connect(name, { signal });
    const e = this._conns.get(name);
    if (!e) throw new Error(`Serveur MCP "${name}" : connexion perdue`);
    if (refresh || !e.conn.tools) await e.conn.fetchTools({ signal });
    return e.conn.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  /** Appelle un outil. Ne lève pas : ok=false pour une erreur de transport/protocole/timeout/annulation. */
  async callTool(server, tool, args, { timeoutMs = 60000, signal } = {}) {
    const fail = (e) => {
      const msg = e.message || String(e);
      return { ok: false, text: `Erreur MCP ${server}.${tool} : ${msg}`, isError: true, content: [], error: msg, timedOut: e.kind === 'timeout', aborted: e.kind === 'abort' || !!signal?.aborted };
    };
    try {
      if (signal?.aborted) throw abortError();
      await this.connect(server, { signal });
      const entry = this._conns.get(server);
      if (!entry) throw new Error(`Serveur MCP "${server}" : connexion perdue`);
      const res = await entry.conn.request('tools/call', { name: tool, arguments: args && typeof args === 'object' ? args : {} }, { timeoutMs, signal });
      const content = Array.isArray(res?.content) ? res.content : [];
      let text = formatContent(content);
      if (!text && res?.structuredContent !== undefined) text = JSON.stringify(res.structuredContent, null, 2);
      return { ok: true, text, isError: res?.isError === true, content, ...(res?.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}) };
    } catch (e) {
      return fail(e);
    }
  }

  /** Test éphémère (connexion jetable, fermée ensuite). */
  async test(name, timeoutMs = 8000) {
    const s = this._config(name);
    if (!s) return { ok: false, tools: [], error: `Serveur MCP inconnu : "${name}"` };
    if (s._scope === 'projet' && !isProjectTrusted(this.cwd)) return { ok: false, tools: [], error: 'Serveur défini par le projet (.mcp.json) : non approuvé. Vérifie ce fichier puis lance /mcp trust' };
    if (!s.command && !s.url) return { ok: false, tools: [], error: 'Ni "command" ni "url" dans la config' };
    const conn = new Connection(name, s, { cwd: this.cwd, onLog: this.onLog });
    this._live.add(conn);
    try {
      await conn.init({ timeoutMs });
      return { ok: true, tools: conn.tools.map((t) => ({ name: t.name, description: t.description })) };
    } catch (e) {
      this._lastStderr.set(name, conn.stderrTail());
      return { ok: false, tools: [], error: e.message };
    } finally {
      this._live.delete(conn);
      await conn.close().catch(() => {});
    }
  }

  stderrTail(name) {
    const e = this._conns.get(name);
    const t = e ? e.conn.stderrTail() : (this._lastStderr.get(name) || '');
    return t.slice(-STDERR_TAIL);
  }

  async _closeAllNow() {
    const conns = [...this._live];
    this._live.clear(); this._conns.clear(); this._connecting.clear();
    await Promise.all(conns.map((c) => c.close().catch(() => {})));
  }

  /** Ferme toutes les connexions et tue les process. Idempotent. */
  async closeAll() { await this._closeAllNow(); }
}

function b64Size(b64) {
  const s = String(b64 || '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
}

function formatContent(content) {
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text') parts.push(String(c.text ?? ''));
    else if (c.type === 'image') parts.push(`[image ${c.mimeType || 'inconnu'}, ${b64Size(c.data)} octets]`);
    else if (c.type === 'audio') parts.push(`[audio ${c.mimeType || 'inconnu'}, ${b64Size(c.data)} octets]`);
    else if (c.type === 'resource' && c.resource) {
      const r = c.resource;
      if (typeof r.text === 'string') parts.push(`[ressource ${r.uri}]\n${r.text}`);
      else parts.push(`[ressource ${r.uri}${r.mimeType ? `, ${r.mimeType}` : ''}${r.blob ? `, ${b64Size(r.blob)} octets` : ''}]`);
    } else if (c.type === 'resource_link') parts.push(`[ressource ${c.uri}]`);
    else parts.push(`[contenu ${c.type || 'inconnu'}]`);
  }
  return parts.join('\n');
}

// ── Catalogue d'outils pour le prompt ─────────────────────────────────────────
const FAIL_RETRY_MS = 60000;

export async function toolsCatalog(manager, { maxToolsPerServer = 40 } = {}) {
  let servers;
  try { servers = (await manager.list()).filter((s) => !s.disabled && s.scope !== 'importé'); } catch { return ''; }
  const blocks = await Promise.all(servers.map(async (s) => {
    try {
      if (!s.connected) {
        const failedAt = manager._failed?.get(s.name);
        if (failedAt && Date.now() - failedAt < FAIL_RETRY_MS) return [];
        await manager.connect(s.name, { timeoutMs: 8000 });
      }
      const tools = await manager.listTools(s.name);
      const lines = tools.slice(0, maxToolsPerServer).map((t) => {
        const props = t.inputSchema && t.inputSchema.properties && typeof t.inputSchema.properties === 'object' ? Object.keys(t.inputSchema.properties) : [];
        const req = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
        const shown = props.slice(0, 12).map((p) => (req.has(p) ? `${p}*` : p));
        if (props.length > 12) shown.push('…');
        let desc = String(t.description || '').replace(/\s+/g, ' ').trim();
        if (desc.length > 100) desc = desc.slice(0, 99) + '…';
        return `${s.name}.${t.name}(${shown.join(', ')})${desc ? ` — ${desc}` : ''}`;
      });
      if (tools.length > maxToolsPerServer) lines.push(`${s.name}: … +${tools.length - maxToolsPerServer} autres outils non listés`);
      return lines;
    } catch {
      return []; // serveur en échec : ignoré silencieusement
    }
  }));
  return blocks.flat().join('\n');
}

// ── Parsing des blocs ```mcp serveur.outil ``` ────────────────────────────────
export function parseMcpBlock(info, body) {
  if (typeof info !== 'string') return null;
  const m = /^mcp(?:\s*:\s*|\s+)(\S.*)$/i.exec(info.trim());
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/);
  let server, tool;
  if (tokens.length === 1) {
    const i = tokens[0].indexOf('.');
    if (i <= 0 || i === tokens[0].length - 1) return null;
    server = tokens[0].slice(0, i); tool = tokens[0].slice(i + 1);
  } else if (tokens.length === 2) {
    [server, tool] = tokens;
    if (server.includes('.')) return null;
  } else return null;
  let args = {};
  const text = String(body ?? '').replace(/^﻿/, '').trim();
  if (text) {
    try { args = JSON.parse(text); } catch { return null; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  }
  return { server, tool, args };
}
