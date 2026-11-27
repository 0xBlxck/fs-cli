// Passerelle Claude Code : lecture de l'environnement, nettoyage des messages user et préambule du 1er message
// (spécification § 3.2). Rien de propre à Claude Code ne doit sortir d'ici vers France Student (invariant I1) :
// system-reminders, balises de commande, auto-mémoire et e-mail de l'utilisateur sont retirés.
import crypto from 'node:crypto';
import { systemText } from './classify.js';
import { tag } from '../chats.js';
import { goalStartFromClaudeCode } from '../goal.js';

// ── Environnement (prompt système de Claude Code) ──

const line = (s, re) => (s.match(re)?.[1] ?? '').trim();

// « Additional working directories: » : liste indentée (« - X ») ou, selon les variantes, valeurs séparées par des virgules.
function extraDirsOf(sys) {
  const lines = sys.split(/\r?\n/);
  const i = lines.findIndex(l => /^\s*-?\s*Additional working directories:/.test(l));
  if (i < 0) return [];
  const inline = lines[i].replace(/^[^:]*:/, '').trim();
  if (inline) return inline.split(/,\s*/).map(s => s.trim()).filter(Boolean);
  const indent = lines[i].match(/^\s*/)[0].length;
  const out = [];
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^(\s*)-\s+(.+?)\s*$/);
    if (!m || m[1].length <= indent) break;
    out.push(m[2]);
  }
  return out;
}

/**
 * Environnement de la session, lu dans le prompt système. Champ absent → valeur par défaut (cwd → fallbackCwd).
 * @returns {import('./types.js').Env}
 */
export function extractEnv(system, fallbackCwd = process.cwd()) {
  const sys = systemText(system);
  const cwd = line(sys, /^\s*-?\s*Primary working directory:\s*(.+)$/m) || fallbackCwd;
  const plat = line(sys, /^\s*-?\s*Platform:\s*(win32|darwin|linux)\b/m)
    || (['win32', 'darwin'].includes(process.platform) ? process.platform : 'linux');
  const git = sys.match(/Is a git repository:\s*(true|false)/);
  return {
    cwd,
    platform: plat,
    shell: line(sys, /^\s*-?\s*Shell:\s*([^\s;(]+)/m),                    // « bash », « zsh », « PowerShell »…
    osVersion: line(sys, /^\s*-?\s*OS Version:\s*(.+)$/m),
    isGit: git ? git[1] === 'true' : false,
    branch: sys.match(/gitStatus:[\s\S]*?Current branch:\s*(\S+)/)?.[1] || null,
    extraDirs: extraDirsOf(sys),
    pathMod: plat === 'win32' ? 'win32' : 'posix',
  };
}

// ── System-reminders ──

const REMINDER_RE = /<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/g;

/** Retire tous les blocs <system-reminder>…</system-reminder> (un bloc non fermé court jusqu'à la fin). */
export function splitReminders(text) {
  const reminders = [];
  const clean = String(text ?? '').replace(REMINDER_RE, (_, inner) => { reminders.push(inner.trim()); return ''; });
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), reminders };
}

// Types de fichiers d'instructions gardés (libellés exacts de Claude Code 2.1.207). Tout le reste est exclu :
// auto-mémoire, règles de l'organisation, instructions globales de l'utilisateur, types inconnus.
const KEPT_TYPES = new Set([
  'project instructions, checked into the codebase',
  "user's private project instructions, not checked in",
]);
const CONTEXT_HEAD = "As you answer the user's questions, you can use the following context:";
const SECTION_RE = /^# (claudeMd|userEmail|attachedProject|currentDate|[a-z]+(?:[A-Z][a-z0-9]*)+)[ \t]*$/;
const FILE_RE = /^Contents of (.+) \(([^()]+)\):[ \t]*$/;

// Sections « # clé » du rappel de contexte → { clé: texte }.
function sectionsOf(text) {
  const body = String(text ?? '').split(/\n[ \t]*IMPORTANT: this context may or may not be relevant/)[0];
  const out = {};
  let key = null;
  for (const l of body.split(/\r?\n/)) {
    const m = l.match(SECTION_RE);
    if (m) { key = m[1]; out[key] = []; continue; }
    if (key) out[key].push(l);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

// Fichiers « Contents of <chemin> (<type>): » d'une section claudeMd.
function filesOf(section) {
  const files = [];
  let cur = null;
  for (const l of String(section ?? '').split(/\r?\n/)) {
    const m = l.match(FILE_RE);
    if (m) { cur = { path: m[1].trim(), type: m[2].trim(), lines: [] }; files.push(cur); continue; }
    if (cur) cur.lines.push(l);
  }
  return files.map(f => ({ path: f.path, type: f.type, body: f.lines.join('\n').trim() }));
}

/**
 * Rappel de contexte de Claude Code (« As you answer the user's questions… »).
 * files : seulement les CLAUDE.md du projet (types gardés) ; date : AAAA-MM-JJ ; email : vrai si un e-mail figurait (jeté).
 */
export function parseContextReminder(text) {
  const s = sectionsOf(String(text ?? '').replace(CONTEXT_HEAD, ''));
  const files = filesOf(s.claudeMd).filter(f => KEPT_TYPES.has(f.type) && f.body);
  const date = (s.currentDate || '').match(/Today's date is\s+(.+?)\.?\s*$/m)?.[1]?.trim() || null;
  return { files, date, email: 'userEmail' in s };
}

// ── Nettoyage d'un message user ──

const INTERRUPT_RE = /\[Request interrupted by user(?: for tool use)?\]/g;
const CONTINUATION_HEAD = 'This session is being continued from a previous conversation that ran out of context.';
const CONTINUE_PARA = 'Continue the conversation from where it left off';
export const CONTINUE_FR = 'Continue la tâche en cours là où tu t\'es arrêté, sans poser de question.';
const MARKER_RE = /\[fs-gw:([A-Za-z0-9_-]{6,40})\]/;

// Rappel → note française, ou null (jeté). Le rappel de contexte est traité à part.
function reminderNote(r) {
  let m = r.match(/^Note: (.+?) was modified, either by the user or by a linter/);
  if (m) return `Fichier modifié hors de la conversation : ${m[1]} (relis-le avant de le modifier).`;
  m = r.match(/^The user selected the lines (\d+) to (\d+) from (.+?):\n([\s\S]*?)(?:\n\nThis may or may not be related to the current task\.?)?\s*$/);
  if (m) {
    const sel = m[4].trim();
    return `Sélection de l'utilisateur : ${m[3]}, lignes ${m[1]} à ${m[2]}.` + (sel && sel.length <= 4000 ? '\n' + sel : '');
  }
  m = r.match(/^The user opened the file (.+?) in the IDE\./);
  if (m) return `Fichier ouvert dans l'éditeur : ${m[1]}.`;
  return null;                                                             // skills, agents, todos, MCP, mode plan, hooks…
}

// Balises de commande de Claude Code : on garde les arguments et le prompt développé qui suit, rien d'autre.
function stripCommandTags(t) {
  return t
    .replace(/<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat|task-notification)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, '$1')
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_, c) => `(Commande lancée par l'utilisateur : ${c.trim()})`)
    .replace(/<bash-(stdout|stderr)>([\s\S]*?)<\/bash-\1>/g, (_, k, c) => c.trim() ? `${k === 'stdout' ? 'Sortie' : 'Erreurs'} :\n${c.trim()}` : '');
}

// Résumé de compaction : retiré ; on ne garde que ce qui suit le paragraphe « Continue the conversation… ».
function afterContinuation(t) {
  const i = t.lastIndexOf(CONTINUE_PARA);
  if (i < 0) return { rest: '', wantsContinue: false };
  const end = t.indexOf('\n\n', i);
  return { rest: end < 0 ? '' : t.slice(end).trim(), wantsContinue: true };
}

function claudeMdOf(files) {
  if (!files.length) return null;
  const text = files.map(f => f.body).join('\n\n');
  return { text, hash: crypto.createHash('sha1').update(text).digest('hex'), paths: files.map(f => f.path) };
}

/**
 * Nettoie le contenu d'un message user de Claude Code (chaîne ou blocs). Les tool_result sont ignorés ici.
 * @returns {{text:string, images:{media_type:string,data:string}[], notes:string[], interrupted:boolean, marker:string|null,
 *   isContinuation:boolean, claudeMd:import('./types.js').ClaudeMd|null, date:string|null}}
 */
export function cleanUserContent(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []);
  const out = { text: '', images: [], notes: [], interrupted: false, marker: null, isContinuation: false, claudeMd: null, date: null };
  const texts = [], files = [];
  let wantsContinue = false;
  for (const b of blocks) {
    if (b?.type === 'image' && b.source?.type === 'base64' && b.source.data) {
      out.images.push({ media_type: b.source.media_type || 'image/png', data: b.source.data });
      continue;
    }
    if (b?.type === 'document') { texts.push('[document PDF non transmis]'); continue; }
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    const { clean, reminders } = splitReminders(b.text);
    for (const r of reminders) {
      if (r.startsWith(CONTEXT_HEAD)) {
        const c = parseContextReminder(r);
        files.push(...c.files);
        out.date = c.date || out.date;
        continue;
      }
      const note = reminderNote(r);
      if (note) out.notes.push(note);
    }
    let t = stripCommandTags(clean);
    // /goal activé dans Claude Code : sa consigne anglaise → la nôtre, qui demande de vérifier avec les outils et de finir
    // par la ligne d'état « 🎯 atteint / pas encore / impossible » (lue par le vérificateur, voir hookCheck)
    const goalStart = goalStartFromClaudeCode(t);
    if (goalStart) t = goalStart;
    const t0 = t;
    t = t.replace(INTERRUPT_RE, '');
    if (t !== t0) out.interrupted = true;
    t = t.trim();
    if (t.startsWith(CONTINUATION_HEAD)) {
      out.isContinuation = true;
      out.marker = t.match(MARKER_RE)?.[1] || out.marker;
      const a = afterContinuation(t);
      wantsContinue = wantsContinue || a.wantsContinue;
      t = a.rest;
    }
    if (t) texts.push(t);
  }
  out.text = texts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!out.text && wantsContinue) out.text = CONTINUE_FR;
  out.claudeMd = claudeMdOf(files);
  return out;
}

// ── Préambule du 1er message d'un chat France Student ──

const CLAUDE_MD_MAX = 6000;
// Lignes de CLAUDE.md jamais transmises : propres à Claude Code, ou qui feraient échouer assertClean (outbound.js).
const CLAUDE_MD_DROP = /Claude Code|subagent|sous-agent|\bskills?\b|\bMCP\b|\b(TodoWrite|Task|Agent)\b/i;
const CLAUDE_MD_DROP_EXACT = /<system-reminder|<command-|<tool_use_error|x-anthropic-billing-header|\b(NotebookEdit|WebFetch|SendMessage|ExitPlanMode)\b|`(Read|Edit|Write|Bash|Grep|Glob|Agent|Task|Skill)`/;

/** CLAUDE.md filtré et coupé (≤ 6 000 caractères, sur une fin de ligne) ; '' s'il ne reste rien. */
export function claudeMdExcerpt(md) {
  const text = typeof md === 'string' ? md : (md?.text || '');
  const kept = text.split(/\r?\n/).filter(l => !CLAUDE_MD_DROP.test(l) && !CLAUDE_MD_DROP_EXACT.test(l)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (kept.length <= CLAUDE_MD_MAX) return kept;
  const cut = kept.slice(0, CLAUDE_MD_MAX);
  const nl = cut.lastIndexOf('\n');
  return (nl > CLAUDE_MD_MAX / 2 ? cut.slice(0, nl) : cut).trimEnd() + '\n[…]';
}

function osLabel(env) {
  if (env.platform === 'darwin') return 'macOS';
  if (env.platform === 'linux') return 'Linux';
  return (env.osVersion || '').replace(/\s+\d+(?:\.\d+)+\s*$/, '').trim() || 'Windows';
}

function frDate(d) {
  if (d == null || d === '') return null;
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const t = new Date(d);
  return isNaN(t) ? null : t.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const samePath = (a, b, win) => {
  const n = p => { const s = String(p).replace(/[\\/]+/g, '/').replace(/\/$/, ''); return win ? s.toLowerCase() : s; };
  return n(a) === n(b);
};

function shellLine(env, shellTool) {
  if (shellTool === 'PowerShell') return 'Les commandes de run_command s\'exécutent dans PowerShell.';
  if (shellTool === 'Bash') {
    return env.platform === 'win32'
      ? 'Les commandes de run_command s\'exécutent dans bash (Git pour Windows) : syntaxe POSIX.'
      : `Les commandes de run_command s'exécutent dans ${/^[a-z]+$/.test(env.shell || '') ? env.shell : 'bash'} : syntaxe POSIX.`;
  }
  return 'run_command n\'est pas disponible dans cette session.';
}

/**
 * Préambule français du 1er message d'un chat neuf (se termine par « ---\n », le texte de l'utilisateur suit).
 * Aucun mot propre à Claude Code (vérifié par assertClean). CLAUDE.md : seulement pour un modèle Anthropic, ou forceClaudeMd.
 * opts : { sid, claudeMd, provider, shellTool, date, forceClaudeMd, bare } ; bare → étiquette seule (« [ab12·cc] »).
 */
export function preamble(env, { sid, claudeMd = null, provider = 'anthropic', shellTool = 'Bash', date = null, forceClaudeMd = false, bare = false, claudeTools = '' } = {}) {
  const head = tag(sid || '0000', 'cc');
  if (bare) return head;
  const e = env || {};
  const git = e.isGit ? 'dépôt git' + (e.branch ? `, branche ${e.branch}` : '') : 'pas de dépôt git';
  const lines = [`${head}Contexte : dossier de travail ${e.cwd} (${osLabel(e)}, ${git}). Les chemins relatifs partent de ce dossier.`];
  const extra = (e.extraDirs || []).filter(d => !samePath(d, e.cwd, e.platform === 'win32'));
  if (extra.length) lines.push(`Autres dossiers accessibles : ${extra.join(', ')}.`);
  lines.push(shellLine(e, shellTool));
  const d = frDate(date);
  if (d) lines.push(`Date : ${d}.`);
  const md = (provider === 'anthropic' || forceClaudeMd) ? claudeMdExcerpt(claudeMd) : '';
  if (md) lines.push(`[Consignes du projet (CLAUDE.md, extrait) :\n${md}]`);
  if (claudeTools) lines.push(claudeTools);                          // claude-tool : MCP, Agent, WebFetch… (toolmap.js)
  // Ligne vide (pas de « --- » : collé sous le texte, le site l'affichait comme un TITRE géant, vu en vrai)
  return lines.join('\n') + '\n\n';
}
