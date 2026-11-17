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
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const o = {}; const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '' || /^[|>][-+]?$/.test(v)) {                            // valeur sur plusieurs lignes (bloc « | » / « > », ou texte simple sur les lignes suivantes)
      const parts = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    o[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return o;
}

const isDirLink = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** Description de secours pour un SKILL.md sans en-tête : son titre et sa première phrase. */
function bodyDescription(text) {
  const body = String(text || '').replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const title = (lines.find(l => /^#{1,3}\s/.test(l)) || '').replace(/^#+\s*/, '');
  const first = (lines.find(l => !/^(#|```|---|\||!\[|<)/.test(l)) || '').replace(/^[>*\-\d.\s]+/, '').replace(/[*_`]/g, '');
  return [title, first].filter(Boolean).join(' — ').slice(0, 400);
}

function findSkillFiles(root, maxDepth, limit = 3000) {
  const found = []; const stack = [[root, 0]];
  while (stack.length && found.length < limit) {
    const [dir, d] = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name === 'SKILL.md') found.push(path.join(dir, e.name));
      else if ((e.isDirectory() || (e.isSymbolicLink() && isDirLink(path.join(dir, e.name)))) && d < maxDepth && !/^(node_modules|\.git|__pycache__|venv|\.venv)$/.test(e.name)) stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return found;
}

/** Dossiers où chercher des skills : [dossier, source, profondeur]. */
export function skillRoots(cwd) {
  const home = importHome();
  const roots = [];
  if (cwd) roots.push([path.join(cwd, '.claude', 'skills'), 'projet', 3], [path.join(cwd, '.agents', 'skills'), 'projet', 3]);
  if (home) roots.push(
    [path.join(home, '.claude', 'skills'), 'Claude Code', 3],
    [path.join(home, '.agents', 'skills'), 'agents', 3],
    [path.join(home, '.codex', 'skills'), 'Codex', 3],
    [path.join(home, '.claude', 'plugins', 'cache'), 'plugin Claude Code', 7],   // plugins installés (pas les catalogues « marketplaces »)
  );
  return roots;
}

let skillCache = null;
/** Skills trouvés : [{ name, description, file, dir, source }]. Mis en cache pour la session. */
export function discoverSkills(cwd, { refresh = false, all = false } = {}) {
  const off = new Set((cfg.disabledSkills || []).map(x => String(x).toLowerCase()));
  const keep = list => (all || !off.size ? list : list.filter(s => !off.has(s.name.toLowerCase())));
  const key = `${importHome()}|${cwd}`;
  if (skillCache && skillCache.key === key && !refresh) return keep(skillCache.list);
  const roots = skillRoots(cwd);
  const byName = new Map();
  for (const [root, source, depth] of roots) {
    for (const file of findSkillFiles(root, depth)) {
      if (/[\\/]\.codex[\\/]skills[\\/]\.system[\\/]/i.test(file)) continue;   // skills internes de Codex (outils propres à Codex, ex. image_gen) : inutiles ici
      const raw = readText(file) || '';
      const fm = frontmatter(raw);
      const name = (fm.name || path.basename(path.dirname(file))).trim();
      if (!name || byName.has(name.toLowerCase())) continue;
      byName.set(name.toLowerCase(), { name, description: (fm.description || bodyDescription(raw)).slice(0, 400), file, dir: path.dirname(file), root, source });
    }
  }
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  skillCache = { key, list };
  return keep(list);
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
const GENERIC = new Set(['skill', 'skills', 'acces', 'access', 'code', 'fichier', 'fichiers', 'dossier', 'dossiers', 'test', 'tests', 'liste', 'affiche', 'courant', 'projet', 'script', 'programme', 'application', 'app', 'truc', 'chose', 'faire', 'cree', 'creer', 'ecris', 'ecrire', 'corrige', 'aide', 'help']);

/**
 * Skills à joindre AUTOMATIQUEMENT à une demande : seulement en cas de correspondance nette
 * (au moins 2 mots qui correspondent et un score suffisant), 2 au maximum.
 */
// skills d'audit / de revue : ils font produire une liste de remarques au lieu d'agir → seulement si l'utilisateur demande un audit
const AUDIT_SKILL = /^\s*(review|audit|check|analy[sz]e|inspect|evaluate|assess)\b/i;
const AUDIT_ASK = /\b(audit|revue|review|relis|relecture|v[ée]rifie|contr[ôo]le|analyse|inspecte|[ée]value|check|accessibilit[ée]|conformit[ée]|bonnes pratiques)/i;

export function autoSkills(list, query, max = 2) {
  // les chemins de fichiers ne disent rien de la demande (« …\\HTML SITE team ») : on les retire avant d'analyser
  query = String(query || '').replace(/(?:[A-Za-z]:[\\/]|~\/|\/)[^\s"'`]*(?:\s+[A-Z][^\s\\/]*)*(?:[\\/][^\s"'`]*)*/g, ' ');
  const wantsAudit = AUDIT_ASK.test(query);
  list = list.filter(s => wantsAudit || !AUDIT_SKILL.test(s.description || ''));
  // mots de la demande (un mot et son pluriel = un seul mot), chacun avec ses équivalents anglais
  const stem = w => (w.length > 3 ? w.replace(/(s|x)$/, '') : w);
  const raw = norm(query).split(/[^a-z0-9]+/).filter(w => (w.length > 2 || FR_EN[w]) && !STOP.has(w) && !GENERIC.has(w) && !TECH.has(w));
  const words = new Map();
  for (const w of raw) { const k = stem(w); const t = words.get(k) || new Set([k]); t.add(w); for (const e of (FR_EN[w] || FR_EN[k] || '').split(' ').filter(Boolean)) t.add(e); words.set(k, t); }
  if (!words.size) return [];
  const texts = list.map(s => ({ s, n: norm(s.name).split(/[^a-z0-9]+/).filter(Boolean), d: norm(s.description) }));
  const inDesc = (d, t) => new RegExp(`\\b${t}`).test(d);
  // mot ENTIER du nom du skill (« web » ≠ « websocket », « test » ≠ « pentest »)
  const inName = (tokens, t) => tokens.some(k => k === t || (t.length >= 5 && k.startsWith(t)));
  const scored = texts.map(({ s, n, d }) => {
    let score = 0, hits = 0;
    for (const [, terms] of words) {
      const tt = [...terms];
      const df = texts.filter(x => tt.some(t => inName(x.n, t) || inDesc(x.d, t))).length;
      const w = df > 30 ? 0.5 : 1;                                       // mot présent partout (« test », « code »…) : compte moitié
      if (tt.some(t => inName(n, t))) { score += 3 * w; hits++; }
      else if (tt.some(t => inDesc(d, t))) { score += w; hits++; }
    }
    // un seul mot suffit s'il est un mot entier du NOM du skill (« cv » → ats-latex-cv, « xlsx »…)
    const nameOnly = hits === 1 && score >= 3;
    return { s, score, ok: (hits >= 2 && score >= 3.5) || nameOnly };
  }).filter(x => x.ok).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  return scored.filter(x => x.score >= scored[0].score * 0.75).slice(0, max).map(x => x.s);
}
// fragments techniques qui ne disent rien de la nature de la demande
const TECH = new Set(['src', 'json', 'package', 'index', 'html', 'css', 'node', 'npm', 'calc', 'etape', 'etapes', 'mini', 'lance', 'lancer', 'fichier', 'courts', 'court', 'bouton', 'ajoute']);

/** Un chemin est-il dans un dossier de skills (un skill découvert, ou un dossier racine comme ~/.claude/skills) ? (lecture autorisée sans question) */
export function isSkillPath(p, cwd) {
  const r = path.resolve(p).toLowerCase();
  const inside = d => { d = path.resolve(d).toLowerCase(); return r === d || r.startsWith(d + path.sep); };
  return discoverSkills(cwd, { all: true }).some(s => inside(s.dir)) || skillRoots(cwd).some(([d]) => inside(d) && fs.existsSync(d));
}

/**
 * Catalogue de TOUS les skills actifs, envoyé une fois par conversation (comme la liste des skills de Claude Code) :
 * le modèle choisit lui-même le guide utile et lit son SKILL.md avec read_file. Taille bornée (budget en caractères) :
 * descriptions raccourcies, puis noms seuls si la liste est très longue.
 */
export function skillCatalog(list, { budget = 24000 } = {}) {
  if (!list?.length) return null;
  const cut = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); if (!n) return ''; if (t.length <= n) return t; const s = t.slice(0, n); const i = s.lastIndexOf(' '); return (i > n * 0.6 ? s.slice(0, i) : s).replace(/[\s,;:.—-]+$/, '') + '…'; };
  // regroupés par dossier : « <dossier>\<nom>\SKILL.md » n'est écrit qu'une fois ; les autres emplacements sont donnés en entier
  const groups = new Map(), others = [];
  for (const s of list) {
    const std = s.root && samePath(path.dirname(s.dir), s.root) && path.basename(s.dir).toLowerCase() === s.name.toLowerCase();
    if (std) { if (!groups.has(s.root)) groups.set(s.root, []); groups.get(s.root).push(s); } else others.push(s);
  }
  const build = (n, max = Infinity) => {
    let shown = 0;
    const line = s => (shown++ < max ? [`- ${s.name}${n ? (s.description ? ' — ' + cut(s.description, n) : '') : ''}`] : []);
    const out = [];
    for (const [root, items] of groups) { const l = items.flatMap(line); if (l.length) out.push(`Dans ${root}${path.sep}<nom>${path.sep}SKILL.md :`, ...l); }
    const o = others.flatMap(s => (shown++ < max ? [`- ${s.name} (${s.file})${n && s.description ? ' — ' + cut(s.description, n) : ''}`] : []));
    if (o.length) out.push('Autres emplacements :', ...o);
    if (list.length > max) out.push(`[… et ${list.length - max} autres]`);
    return out.join('\n');
  };
  const head = `[Guides (skills) de l'utilisateur sur ce PC : ${list.length} fichiers SKILL.md, chacun décrit une méthode pour un type de tâche. `
    + `Quand l'un d'eux correspond à une demande, lis son SKILL.md avec read_file avant de commencer et applique-le (ses autres fichiers sont dans le même dossier) ; `
    + `sinon ignore cette liste. Ces dossiers se lisent sans demander d'accord.`;
  let body = '';
  for (const n of [110, 80, 50, 0]) { body = build(n); if (head.length + body.length <= budget) break; }
  if (head.length + body.length > budget) { let max = list.length; while (max > 10 && head.length + body.length > budget) { max = Math.floor(max * 0.8); body = build(0, max); } }
  const text = `${head}\n${body}]`;
  let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return { text, count: list.length, sig: 'cat-' + (h >>> 0).toString(36) };
}
