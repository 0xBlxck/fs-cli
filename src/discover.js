// Découverte automatique des outils déjà installés sur le PC pour d'autres assistants :
// serveurs MCP (Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf) et skills (SKILL.md).
// Lecture seule : rien n'est modifié dans les fichiers de ces outils. Les valeurs d'environnement (clés)
// restent locales : elles servent à lancer le serveur, elles ne sont jamais envoyées au modèle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from './config.js';

/** Dossier personnel exploré (désactivé dans les tests, sauf FS_IMPORT_HOME explicite). */
export function importHome() {
  if (cfg.importTools === false) return null;                       // /import off
  if (process.env.FS_IMPORT_HOME !== undefined) return process.env.FS_IMPORT_HOME || null;
  return process.env.FS_CLI_HOME ? null : os.homedir();
}

const readText = f => { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { return null; } };
const readJson = f => { const t = readText(f); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const samePath = (a, b) => path.resolve(a).toLowerCase().replace(/[\\/]+$/, '') === path.resolve(b).toLowerCase().replace(/[\\/]+$/, '');

// ── TOML minimal (sections [mcp_servers.x] et [mcp_servers.x.env] de Codex) ──
function tomlValue(v) {
  v = v.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
  if (v.startsWith('[')) {
    const out = []; const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g; let m;
    while ((m = re.exec(v))) out.push(m[1] !== undefined ? tomlValue(`"${m[1]}"`) : m[2]);
    return out;
  }
  if (v.startsWith('{')) {
    const o = {}; const re = /([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g; let m;
    while ((m = re.exec(v))) o[m[1]] = tomlValue(m[2]);
    return o;
  }
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
export function parseCodexMcp(text) {
  const servers = {}; let cur = null, sub = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[\s*mcp_servers\.("?)([^".\]]+)\1(?:\.(\w+))?\s*\]$/);
    if (sec) { cur = servers[sec[2]] ||= {}; sub = sec[3] || null; continue; }
    if (line.startsWith('[')) { cur = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const val = tomlValue(kv[2]);
    if (sub) (cur[sub] ||= {})[kv[1]] = typeof val === 'string' ? val : String(val);
    else cur[kv[1]] = val;
  }
  return servers;
}

/** Entrée d'un autre outil → format FS-CLI ({command,args,env} ou {url,headers}). */
function toServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.disabled === true || raw.enabled === false) return null;
  const s = {};
  const url = raw.url || raw.serverUrl || raw.httpUrl;
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) { s.url = url; if (raw.headers && typeof raw.headers === 'object') s.headers = raw.headers; }
  else if (typeof raw.command === 'string' && raw.command.trim()) {
    s.command = raw.command; s.args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    if (raw.env && typeof raw.env === 'object') s.env = raw.env;
    if (typeof raw.cwd === 'string') s.cwd = raw.cwd;
  } else return null;
  return s;
}

/** Serveurs MCP configurés dans les autres assistants : { nom: { ...serveur, _source } }. Le premier trouvé gagne. */
export function discoverMcpServers(cwd) {
  const home = importHome(); if (!home) return {};
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out = {};
  const add = (servers, source) => {
    for (const [name, raw] of Object.entries(servers || {})) {
      if (out[name] || !/^[\w.-]{1,64}$/.test(name)) continue;
      const s = toServer(raw); if (s) out[name] = { ...s, _source: source };
    }
  };
  const cj = readJson(path.join(home, '.claude.json'));
  if (cj) {
    if (cwd) for (const [p, v] of Object.entries(cj.projects || {})) if (samePath(p, cwd)) add(v?.mcpServers, 'Claude Code (ce dossier)');
    add(cj.mcpServers, 'Claude Code');
  }
  add(readJson(path.join(appData, 'Claude', 'claude_desktop_config.json'))?.mcpServers, 'Claude Desktop');
  const codex = readText(path.join(home, '.codex', 'config.toml'));
  if (codex) add(parseCodexMcp(codex), 'Codex');
  add(readJson(path.join(home, '.cursor', 'mcp.json'))?.mcpServers, 'Cursor');
  add(readJson(path.join(home, '.gemini', 'settings.json'))?.mcpServers, 'Gemini CLI');
  add(readJson(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))?.mcpServers, 'Windsurf');
  return out;
}

// ── Skills (SKILL.md avec en-tête name / description) ──
function frontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const o = {}; const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[|>][-+]?$/.test(v)) {                                        // valeur sur plusieurs lignes
      const parts = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    o[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return o;
}

function findSkillFiles(root, maxDepth, limit = 3000) {
  const found = []; const stack = [[root, 0]];
  while (stack.length && found.length < limit) {
    const [dir, d] = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name === 'SKILL.md') found.push(path.join(dir, e.name));
      else if (e.isDirectory() && d < maxDepth && !/^(node_modules|\.git|__pycache__|venv|\.venv)$/.test(e.name)) stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return found;
}

let skillCache = null;
/** Skills trouvés : [{ name, description, file, dir, source }]. Mis en cache pour la session. */
export function discoverSkills(cwd, { refresh = false } = {}) {
  const key = `${importHome()}|${cwd}`;
  if (skillCache && skillCache.key === key && !refresh) return skillCache.list;
  const home = importHome();
  const roots = [];
  if (cwd) roots.push([path.join(cwd, '.claude', 'skills'), 'projet', 3], [path.join(cwd, '.agents', 'skills'), 'projet', 3]);
  if (home) roots.push(
    [path.join(home, '.claude', 'skills'), 'Claude Code', 3],
    [path.join(home, '.agents', 'skills'), 'agents', 3],
    [path.join(home, '.codex', 'skills'), 'Codex', 3],
    [path.join(home, '.claude', 'plugins', 'cache'), 'plugin Claude Code', 7],   // plugins installés (pas les catalogues « marketplaces »)
  );
  const byName = new Map();
  for (const [root, source, depth] of roots) {
    for (const file of findSkillFiles(root, depth)) {
      const fm = frontmatter(readText(file) || '');
      const name = (fm.name || path.basename(path.dirname(file))).trim();
      if (!name || byName.has(name.toLowerCase())) continue;
      byName.set(name.toLowerCase(), { name, description: (fm.description || '').slice(0, 400), file, dir: path.dirname(file), source });
    }
  }
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  skillCache = { key, list };
  return list;
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set('le la les un une des de du et ou a au aux en dans pour par sur avec sans ce cette ces mon ma mes ton ta tes son sa ses je tu il elle on nous vous ils elles fais fait faire moi toi qui que quoi est sont the and for with to of in on a an is'.split(' '));

/** Recherche simple par mots (nom compte double). */
export function searchSkills(list, query, max = 10) {
  const words = norm(query).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
  if (!words.length) return [];
  return list.map(s => {
    const n = norm(s.name), d = norm(s.description);
    let score = 0;
    for (const w of words) { if (n.includes(w)) score += 3; if (d.includes(w)) score += 1; }
    return { s, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(x => x.s);
}

// mots français courants → mots des descriptions (souvent en anglais) des skills
const FR_EN = {
  site: 'website web', page: 'page landing web', landing: 'landing page', beau: 'design beautiful ui visual', belle: 'design beautiful ui visual', joli: 'design ui visual',
  design: 'design ui visual', interface: 'ui interface frontend', jeu: 'game', jeux: 'game', video: 'video', presentation: 'slides presentation pptx deck', diapo: 'slides presentation pptx',
  tableur: 'spreadsheet excel xlsx', excel: 'spreadsheet excel xlsx', cv: 'resume cv', lettre: 'cover letter', motivation: 'cover letter', securite: 'security',
  donnees: 'data database', graphique: 'chart dataviz visualization', tableau: 'table dashboard', recherche: 'research', traduire: 'translate', traduction: 'translate',
  animation: 'animation motion', logo: 'logo brand design', document: 'document docx', word: 'docx document', pdf: 'pdf', mail: 'email', email: 'email',
  boutique: 'shop shopify ecommerce', serveur: 'server backend', bdd: 'database sql', test: 'test testing', tests: 'test testing', mobile: 'mobile app',
};
const GENERIC = new Set(['code', 'fichier', 'fichiers', 'projet', 'script', 'programme', 'application', 'app', 'truc', 'chose', 'faire', 'cree', 'creer', 'ecris', 'ecrire', 'corrige', 'aide', 'help']);

/**
 * Skills à joindre AUTOMATIQUEMENT à une demande : seulement en cas de correspondance nette
 * (au moins 2 mots qui correspondent et un score suffisant), 2 au maximum.
 */
export function autoSkills(list, query, max = 2) {
  const words = [...new Set(norm(query).split(/[^a-z0-9]+/).filter(w => (w.length > 2 || FR_EN[w]) && !STOP.has(w) && !GENERIC.has(w)))];
  if (!words.length) return [];
  const terms = [...new Set(words.flatMap(w => [w, ...(FR_EN[w] ? FR_EN[w].split(' ') : [])]))];
  const scored = list.map(s => {
    const n = norm(s.name), d = norm(s.description);
    let score = 0; const hit = new Set();
    for (const t of terms) {
      if (n.includes(t)) { score += 3; hit.add(t); }
      else if (new RegExp(`\\b${t}`).test(d)) { score += 1; hit.add(t); }
    }
    return { s, score, hits: hit.size };
  }).filter(x => x.hits >= 2 && x.score >= 4).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  return scored.filter(x => x.score >= scored[0].score * 0.75).slice(0, max).map(x => x.s);
}

/** Un chemin est-il dans un dossier de skill découvert ? (lecture autorisée sans question) */
export function isSkillPath(p, cwd) {
  const r = path.resolve(p).toLowerCase();
  return discoverSkills(cwd).some(s => { const d = s.dir.toLowerCase(); return r === d || r.startsWith(d + path.sep); });
}
