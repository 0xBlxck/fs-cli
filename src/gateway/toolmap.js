// Passerelle Claude Code : traduction des outils dans les deux sens (spécification § 3.5 et 3.6).
//   FS → Claude Code : chaque appel d'outil client France Student devient un tool_use natif (Read, Edit, Write, Bash ou
//                      PowerShell, Grep, Glob) que Claude Code exécute avec SES permissions. La passerelle n'exécute rien.
//   Claude Code → FS : chaque tool_result redevient un résultat { callId, output, isError } compréhensible par le modèle FS
//                      (messages d'erreur traduits, numéros de ligne au format du doc FS, tailles bornées).
// Les chemins sont calculés avec path.win32 ou path.posix selon env.pathMod (jamais le path de la machine qui fait tourner
// la passerelle). Tout accès disque passe par ctx.fsExists / ctx.fsStat (synchrones, injectés).
import path from 'node:path';
import { fsId, synthId, retryId, decodeId } from './ids.js';
import { documentFileName, htmlDocumentName, cleanText } from '../native.js';
import { clipMiddle } from '../tools.js';

/** Limites de France Student (client-tools.md) : 40 000 caractères par résultat, 120 000 par envoi (marge gardée), 32 appels. */
export const MAX_CALLS = 32;
const PER = 40000;
const TOTAL = 118000;
const MAX_IMAGES = 4;
const CC_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'];

/** Textes envoyés à FS quand la passerelle répond elle-même à un appel (pending.local). */
export const LOCAL = {
  unavailable: 'Outil indisponible dans cette session.',
  missing: name => `Argument manquant : ${name}`,
  tooMany: `Non exécuté : plus de ${MAX_CALLS} actions dans un même tour, refais-les.`,
  notRun: 'Non exécuté : interrompu ou ignoré par l\'utilisateur.',
};

// arguments obligatoires du catalogue FS (client-tools.md)
const REQUIRED = {
  list_directory: ['path'], read_file: ['path'], search_files: ['query'],
  edit_file: ['path', 'old_text', 'new_text'], write_file: ['path', 'content'], run_command: ['command'],
};

const P = env => (env?.pathMod === 'win32' ? path.win32 : path.posix);
const parseArgs = a => { if (typeof a === 'string') { try { return JSON.parse(a) || {}; } catch { return {}; } } return a && typeof a === 'object' ? a : {}; };
const asText = v => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
const posInt = v => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const firstLine = (s, n) => { const l = String(s).split('\n')[0]; return l.length > n ? l.slice(0, n - 1) + '…' : l; };

// ── Chemins ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Chemin absolu pour Claude Code (ses outils exigent des chemins absolus).
 * Vide ou « . » → dossier de travail. Sous win32 : « /c/x » (Git Bash) → « C:\x », « \x » ou « /x » sans lecteur → relatif
 * au dossier de travail, « C:\… » et UNC gardés. Sous POSIX : « /x » est absolu. Sinon résolu depuis env.cwd puis normalisé.
 * Les chemins hors du dossier ne sont PAS bloqués : ce sont les permissions de Claude Code qui décident.
 */
export function absPath(p, env) {
  const M = P(env), cwd = env.cwd;
  let s = String(p ?? '').trim();
  if (!s || s === '.') return cwd;
  if (M === path.win32) {
    const git = /^\/([A-Za-z])(?:\/(.*))?$/.exec(s);                        // /c ou /c/x (Git Bash, MSYS)
    if (git) s = `${git[1].toUpperCase()}:\\${git[2] || ''}`;
    else if (/^[\\/](?![\\/])/.test(s)) s = s.replace(/^[\\/]+/, '');        // \x ou /x sans lecteur : relatif au dossier
  }
  const out = M.normalize(M.resolve(cwd, s));
  return out.length > M.parse(out).root.length ? out.replace(/[\\/]+$/, '') : out;
}

/** Chemin montré au modèle FS : relatif au dossier de travail (barres « / ») s'il est dedans, sinon absolu. */
export function displayPath(abs, env) {
  const M = P(env);
  const r = M.relative(env.cwd, abs);
  if (r === '') return '.';
  return r && !r.startsWith('..') && !M.isAbsolute(r) ? r.split(M.sep).join('/') : abs;
}

/** Clé d'un chemin dans readSet : insensible à la casse et au sens des barres sous Windows. */
export function readKey(abs, env) {
  const s = String(abs).normalize('NFC');
  return env?.pathMod === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s;
}

/** readSet remis à zéro quand l'id de session change (reprise : le readFileState de Claude Code peut être partiel). */
export function syncReadSet(readSet, sessionId) {
  if (!readSet) return readSet;
  readSet.paths ||= {};
  if (sessionId !== undefined && readSet.sessionId !== sessionId) { readSet.sessionId = sessionId; readSet.paths = {}; }
  return readSet;
}

const markRead = (ctx, abs) => { if (ctx.readSet && abs) (ctx.readSet.paths ||= {})[readKey(abs, ctx.env)] = true; };
const forgetRead = (readSet, abs, env) => { if (readSet?.paths && abs) delete readSet.paths[readKey(abs, env)]; };
const wasRead = (ctx, abs) => !!ctx.readSet?.paths?.[readKey(abs, ctx.env)];

// ── Shell ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Guillemets simples POSIX. */
export const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** Chaîne entre guillemets simples PowerShell (les apostrophes typographiques ferment aussi la chaîne). */
const psq = s => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, m => m + m)}'`;
/** Git Bash accepte « C:/… » : on évite les antislashs, que bash interprète. */
const bashPath = (abs, env) => (env.pathMod === 'win32' ? abs.replace(/\\/g, '/') : abs);
/** Un commentaire « # » ou un heredoc dans la commande avalerait la fin d'une enveloppe sur une ligne. */
const needsBreak = cmd => /[#\n]/.test(cmd);

function wrapBash(command, cwdAbs, env) {
  if (!cwdAbs) return command;
  return `(cd ${shq(bashPath(cwdAbs, env))} && ${command}${needsBreak(command) ? '\n' : ''})`;
}

function wrapPowerShell(command, cwdAbs) {
  if (!cwdAbs) return command;
  const b = needsBreak(command);
  return `Push-Location -LiteralPath ${psq(cwdAbs)}; try {${b ? '\n' : ' '}${command}${b ? '\n' : ' '}} finally { Pop-Location }`;
}

const timeoutMs = s => { const n = Number(s); return Number.isFinite(n) && n > 0 ? clamp(Math.round(n * 1000), 1000, 600000) : undefined; };

// ── Expressions régulières ──────────────────────────────────────────────────────────────────────────────────────────

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Regex valide pour JS ET pour ripgrep (pas de lookaround ni de référence arrière, que rg refuse). */
function isValidRegex(q) {
  if (/\(\?<?[=!]|\\[1-9]/.test(q)) return false;
  try { new RegExp(q); return true; } catch { return false; }
}

// ── FS → Claude Code ────────────────────────────────────────────────────────────────────────────────────────────────

/** Si toutes les lignes non vides commencent par un numéro (« 12\t », « 12: », « 12→ »), ce préfixe est retiré ; sinon rien. */
export function stripLineNumbers(s) {
  if (typeof s !== 'string' || !s) return s;
  const NUM = /^\s*\d+(?:\t|: |:$|\u2192)/;
  const lines = s.split('\n');
  const full = lines.filter(l => l.trim() !== '');
  if (!full.length || !full.every(l => NUM.test(l))) return s;
  return lines.map(l => l.replace(NUM, '')).join('\n');
}

function availOf(ctx) {
  if (ctx.avail) return ctx.avail instanceof Set ? ctx.avail : new Set(ctx.avail);
  if (Array.isArray(ctx.tools)) return new Set(ctx.tools.map(t => t.name));
  return new Set(CC_TOOLS);
}

const shellOf = (ctx, avail) => (ctx.shellTool !== undefined ? ctx.shellTool : avail.has('Bash') ? 'Bash' : avail.has('PowerShell') ? 'PowerShell' : null);

/**
 * Garde seulement les clés présentes dans input_schema.properties de l'outil reçu (si ctx.tools est fourni).
 * Renvoie null si un champ requis manque (schéma inattendu) : l'appel est alors traité localement.
 */
function fitSchema(name, input, ctx) {
  const schema = Array.isArray(ctx.tools) ? ctx.tools.find(t => t.name === name)?.input_schema : null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;                            // un champ absent est omis, jamais undefined/null
    if (schema?.properties && !Object.hasOwn(schema.properties, k)) continue;
    out[k] = v;
  }
  if (schema?.required?.some(k => !Object.hasOwn(out, k))) return null;
  return out;
}

/** list_directory traduit selon le shell disponible (ou Glob, sans shell). */
function listUse(args, ctx, avail, shell) {
  const env = ctx.env;
  const abs = absPath(args.path, env);
  const d = clamp(posInt(args.depth) || 1, 1, 3);
  const rel = displayPath(abs, env);
  if (shell === 'Bash') {
    const q = shq(bashPath(abs, env));
    const command = d <= 1 ? `ls -la -- ${q}`
      : `find ${q} -maxdepth ${d} \\( -name node_modules -o -name .git \\) -prune -o -print | head -n 500`;
    return { name: 'Bash', input: { command, description: `Lister ${rel}` }, path: abs };
  }
  if (shell === 'PowerShell') {
    const command = `Get-ChildItem -LiteralPath ${psq(abs)} -Force -Depth ${d - 1} | Select-Object -First 500 FullName,Length,Mode | Format-Table -AutoSize | Out-String -Width 200`;
    return { name: 'PowerShell', input: { command, description: `Lister ${rel}` }, path: abs };
  }
  if (avail.has('Glob')) return { name: 'Glob', input: { pattern: d > 1 ? '**/*' : '*', path: abs }, path: abs, note: '(fichiers seulement)' };
  return null;
}

/** Un appel FS → { name, input, path, note? } (tool_use à émettre) ou null (outil indisponible). */
function mapUse(name, a, ctx, avail, shell) {
  const env = ctx.env;
  switch (name) {
    case 'list_directory': return listUse(a, ctx, avail, shell);
    case 'read_file': {
      const abs = absPath(a.path, env);
      if (ctx.fsStat?.(abs)?.isDirectory?.()) return listUse({ path: a.path }, ctx, avail, shell);
      if (!avail.has('Read')) return null;
      const s = posInt(a.start_line), e = posInt(a.end_line);
      const input = { file_path: abs };
      if (s) input.offset = s;
      if (e && (!s || e >= s)) input.limit = s ? e - s + 1 : e;
      return { name: 'Read', input, path: abs };
    }
    case 'search_files': {
      if (!avail.has('Grep')) return null;
      const q = asText(a.query);
      const input = { pattern: isValidRegex(q) ? q : escapeRe(q) };
      if (typeof a.path === 'string' && a.path.trim()) input.path = absPath(a.path, env);
      if (typeof a.glob === 'string' && a.glob.trim()) input.glob = a.glob.trim();
      Object.assign(input, { output_mode: 'content', '-n': true, head_limit: clamp(posInt(a.max_results) ?? 100, 1, 250) });
      return { name: 'Grep', input, path: input.path || null };
    }
    case 'edit_file': {
      if (!avail.has('Edit')) return null;
      const abs = absPath(a.path, env);
      const input = { file_path: abs, old_string: stripLineNumbers(asText(a.old_text)), new_string: stripLineNumbers(asText(a.new_text)) };
      if (a.replace_all === true) input.replace_all = true;
      return { name: 'Edit', input, path: abs, write: true };
    }
    case 'write_file': {
      if (!avail.has('Write')) return null;
      const abs = absPath(a.path, env);
      return { name: 'Write', input: { file_path: abs, content: asText(a.content) }, path: abs, write: true };
    }
    case 'run_command': {
      if (!shell) return null;
      const command = asText(a.command);
      const cwdAbs = typeof a.cwd === 'string' && a.cwd.trim() ? absPath(a.cwd, env) : null;
      const input = {
        command: shell === 'Bash' ? wrapBash(command, cwdAbs, env) : wrapPowerShell(command, cwdAbs),
        timeout: timeoutMs(a.timeout_seconds),
        description: `Commande : ${firstLine(command, 50)}`,
      };
      return { name: shell, input, path: cwdAbs, command };
    }
    default: return null;
  }
}

/** Read{limit:1} injecté juste avant un Edit/Write sur un fichier existant que Claude Code n'a pas encore lu. */
function injectRead(abs, ctx, avail, seen) {
  if (!avail.has('Read') || !abs || wasRead(ctx, abs) || seen.has(readKey(abs, ctx.env))) return null;
  if (!ctx.fsExists?.(abs)) return null;
  seen.add(readKey(abs, ctx.env));
  return { id: synthId('read'), name: 'Read', input: { file_path: abs, limit: 1 } };
}

/**
 * Appels FS → blocs tool_use pour Claude Code.
 * ctx = { env, avail?:Set|string[], tools?:body.tools, shellTool?, readSet, sessionId?, fsExists, fsStat, chatId }.
 * Renvoie { uses:[{id,name,input}], pending:Pending[], synthetic:[{ccId,purpose,path}] } : pending contient UN élément par
 * appel FS, dans l'ordre (ccId = id du tool_use émis, ou local = réponse déjà prête) ; synthetic liste les Read injectés.
 */
export function planToolUses(calls, ctx) {
  syncReadSet(ctx.readSet, ctx.sessionId);
  const avail = availOf(ctx);
  const shell = shellOf(ctx, avail);
  const uses = [], pending = [], synthetic = [], seen = new Set();
  let emitted = 0;
  for (const call of calls || []) {
    const callId = String(call.callId ?? call.call_id ?? call.id ?? '');
    const args = parseArgs(call.arguments ?? call.args);
    const p = { callId, ccId: null, fsName: String(call.name || ''), path: null, local: null, retried: 0 };
    pending.push(p);
    const miss = REQUIRED[call.name]?.find(k => args[k] === undefined || args[k] === null);
    if (!REQUIRED[call.name]) { p.local = { output: LOCAL.unavailable, isError: true }; continue; }
    if (miss) { p.local = { output: LOCAL.missing(miss), isError: true }; continue; }
    if (emitted >= MAX_CALLS) { p.local = { output: LOCAL.tooMany, isError: true }; continue; }
    const m = mapUse(call.name, args, ctx, avail, shell);
    const input = m && fitSchema(m.name, m.input, ctx);
    if (!input) { p.local = { output: LOCAL.unavailable, isError: true }; continue; }
    if (m.write) {
      const r = injectRead(m.path, ctx, avail, seen);
      if (r) { uses.push(r); synthetic.push({ ccId: r.id, purpose: 'read', path: m.path }); }
    }
    p.ccId = fsId(ctx.chatId, callId);
    Object.assign(p, { path: m.path || null, ccName: m.name, input });
    if (m.note) p.note = m.note;
    if (m.command != null) p.command = m.command;
    uses.push({ id: p.ccId, name: m.name, input });
    emitted++;
  }
  return { uses, pending, synthetic };
}

/** Nom de fichier d'un document du site : documentFileName, sinon page HTML (index.html si libre, d'après ctx.fsExists). */
function documentName(d, ctx) {
  const named = documentFileName(d);
  const cited = citedPaths(ctx.text, ctx.env);
  if (named) {
    // « index.html » + « enregistre-le sous C:\site\index.html » dans la réponse → le chemin complet cité
    if (!/[\\/]/.test(named)) {
      const hit = cited.find(c => P(ctx.env).basename(c).toLowerCase() === named.toLowerCase());
      if (hit) return hit;
    }
    return named;
  }
  const slug = htmlDocumentName(d, null);                                  // null si ce n'est pas du HTML ; sinon un nom tiré du titre
  if (!slug) return null;
  const html = cited.filter(c => /\.html?$/i.test(c));
  if (html.length === 1) return html[0];                                   // GPT dit où l'enregistrer (vu en vrai) : on l'y met
  // « dans le dossier C:\x\site dev moi un site » : un seul dossier cité dans la demande → la page y va (vu en vrai)
  const dirs = citedPaths(ctx.userText, ctx.env, { dirs: true });
  if (dirs.length === 1) {
    const M = P(ctx.env);
    return ctx.fsExists?.(M.join(dirs[0], 'index.html')) ? M.join(dirs[0], slug) : M.join(dirs[0], 'index.html');
  }
  return ctx.fsExists?.(absPath('index.html', ctx.env)) ? slug : 'index.html';
}

/**
 * Chemins ABSOLUS de fichiers cités dans la réponse du modèle (« enregistre-le sous `C:\x\index.html` »), sans doublon.
 * Windows : X:\… ou X:/… ; ailleurs : /… . Seulement des noms avec extension.
 */
export function citedPaths(text, env, { dirs = false } = {}) {
  const t = String(text || '');
  const win = P(env) === path.win32;
  const re = dirs
    ? (win ? /\b[A-Za-z]:[\\/][^\s`"'«»<>|*?]*/g : /(?<![\w.~])\/[^\s`"'«»<>|*?]+/g)
    : (win ? /\b[A-Za-z]:[\\/][^\s`"'«»<>|*?]*\.[A-Za-z0-9]{1,10}\b/g : /(?<![\w.~])\/[^\s`"'«»<>|*?]*\.[A-Za-z0-9]{1,10}\b/g);
  const out = [];
  for (const m of t.matchAll(re)) {
    const raw = m[0].replace(/[.,;:!)\\/]+$/, '');
    if (dirs && /\.[A-Za-z0-9]{1,10}$/.test(raw)) continue;                // dossiers seulement : pas de nom de fichier
    if (!raw || raw.length < 3) continue;
    const abs = absPath(raw, env);
    if (!out.some(o => o.toLowerCase() === abs.toLowerCase())) out.push(abs);
  }
  return out;
}

/**
 * Documents createDocument/updateDocument de GPT (contenu déjà complété) → Write synthétiques (id s|doc).
 * Renvoie { uses, synthetic:[{ccId,purpose:'doc',path,name,title,note}], text } : text = mentions à ajouter à la réponse
 * pour les documents qui ne sont pas des fichiers.
 */
export function planDocuments(docs, ctx) {
  const avail = availOf(ctx);
  const uses = [], synthetic = [], texts = [], seen = new Set();
  for (const d of docs || []) {
    const title = cleanText(String(d?.title || 'sans titre')).trim() || 'sans titre';
    const name = typeof d?.content === 'string' && avail.has('Write') ? documentName(d, ctx) : null;
    if (!name) { texts.push(`(Document « ${title} » laissé dans le panneau du site France Student.)`); continue; }
    const abs = absPath(name, ctx.env);
    const r = injectRead(abs, ctx, avail, seen);
    if (r) { uses.push(r); synthetic.push({ ccId: r.id, purpose: 'read', path: abs }); }
    const id = synthId('doc');
    uses.push({ id, name: 'Write', input: { file_path: abs, content: d.content } });
    synthetic.push({ ccId: id, purpose: 'doc', path: abs, name, title,
      note: `Ton document « ${title} » a été écrit dans ${name}. Pour les fichiers, utilise directement write_file et edit_file.` });
  }
  return { uses, synthetic, text: texts.join('\n') };
}

/**
 * Micro-tour local (§ 3.6) : pour chaque appel Edit/Write refusé faute de lecture, [Read (id s|read), même Edit/Write
 * (id r|chatId|callId|1)]. Met à jour p.ccId et p.retried. Renvoie { uses, synthetic }.
 */
export function planRetry(retry, ctx) {
  const uses = [], synthetic = [];
  for (const p of retry || []) {
    if (!p.ccName || !p.input) continue;
    const abs = p.input.file_path || p.path;
    const r = { id: synthId('read'), name: 'Read', input: { file_path: abs } };
    uses.push(r); synthetic.push({ ccId: r.id, purpose: 'read', path: abs });
    p.retried = (p.retried || 0) + 1;
    p.ccId = retryId(ctx.chatId, p.callId, p.retried);
    uses.push({ id: p.ccId, name: p.ccName, input: p.input });
  }
  return { uses, synthetic };
}

// ── Claude Code → FS ────────────────────────────────────────────────────────────────────────────────────────────────

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;
const TOOL_ERROR = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/;
const TEST_CMD = /node\s+--test|\bjest\b|\bvitest\b|\bpytest\b|npm\s+(?:run\s+)?test\b/;
// noms de paramètres de Claude Code → noms du catalogue FS (seulement dans les messages d'erreur)
const RENAMES = [['file_path', 'path'], ['old_string', 'old_text'], ['new_string', 'new_text'], ['offset', 'start_line'], ['pattern', 'query'], ['timeout', 'timeout_seconds']];

// Messages de Claude Code 2.1.207 (vérifiés dans le bundle) → texte pour le modèle FS. Premier motif reconnu.
const REFUSED = { re: /The user doesn't want to (?:proceed with this tool use|take this action)|^Permission (?:to use|for this)/m,
  out: (m, where, env, text) => { const said = /the user said:\s*([\s\S]+)$/i.exec(text); return 'Action refusée par l\'utilisateur. Arrête-toi et attends ses instructions.' + (said ? ` Il a précisé : ${said[1].trim()}` : ''); } };
// Permission non accordée sans question possible (claude -p, mode dontAsk, règle ask, hook) : messages de Tm() du bundle,
// vus en E2E (« This command requires approval », « Claude requested permissions to use Bash, but you haven't granted it yet. »)
const NOT_GRANTED = {
  re: /^(?:Claude requested permissions to [\s\S]*?, but you haven't granted it yet\.|This command requires approval|This (?:Bash|PowerShell) command contains multiple operations|(?:Permission rule|Hook|Classifier|Tool) '[^']*'[\s\S]*? (?:requires approval for this|blocked this action)|Current permission mode \([^)]*\) requires approval for this)/,
  out: (m, where, env, text) => {
    const why = /^Hook '[^']*' blocked this action: ([\s\S]+)$/.exec(text);
    return 'Action non autorisée : elle demande l\'accord de l\'utilisateur, qui ne l\'a pas donné. Ne la relance pas : dis ce que tu voulais faire et attends ses instructions.'
      + (why ? ` Raison : ${why[1].trim()}` : '');
  },
};
const ABORTED = { re: /Command was aborted before completion|\[Request interrupted by user/, out: () => 'Commande interrompue par l\'utilisateur.' };
const UNCHANGED_TEXT = 'Fichier inchangé depuis ta dernière lecture : réutilise ce que tu as déjà.';
// Read « dédoublonné » par Claude Code (souvent un simple rappel, que le nettoyage effacerait) : pas une erreur
const UNCHANGED = /Wasted call (?:—|-) file unchanged|already in your context/;
const NOTHING = /^(?:No files found|No matches found)$/;
const TRANSLATIONS = [
  REFUSED, NOT_GRANTED, ABORTED,
  { re: /File has not been read yet/, out: () => 'Lis d\'abord ce fichier avec read_file, puis refais la modification.', needsRead: true },
  { re: /File content has changed since it was last read|File has been modified since read/, out: () => 'Le fichier a changé depuis ta lecture : relis-le avec read_file, puis refais la modification.', needsRead: true },
  { re: /String to replace not found in file|String not found in file/, out: () => 'old_text introuvable dans le fichier : relis la zone avec read_file et recopie le texte exact, sans numéros de ligne.' },
  { re: /Found (\d+) matches of the string to replace, but replace_all is false/, out: m => `old_text apparaît ${m[1]} fois : ajoute du contexte pour le rendre unique, ou mets replace_all à true.` },
  { re: /File does not exist\.(?:[\s\S]*?Did you mean (.+?)\?)?/, out: (m, p, env) => `Fichier introuvable : ${p}.${m[1] ? ` Fichier proche : ${near(m[1], env)}.` : ''}` },
  { re: /This tool can only read files, not directories|EISDIR/, out: (m, p) => `${p} est un dossier : utilise list_directory.` },
  { re: /exceeds maximum allowed tokens/, out: () => 'Fichier trop gros pour une lecture complète : lis une plage avec start_line et end_line.' },
  { re: UNCHANGED, out: () => UNCHANGED_TEXT },
];

const near = (s, env) => { const t = String(s).trim().replace(/^["'`]|["'`]$/g, ''); return env && P(env).isAbsolute(t) ? displayPath(t, env) : t; };
const extOf = mt => (String(mt).split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');

/** Contenu d'un tool_result → { text, images } (blocs text joints, images mises de côté avec leur mention, PDF signalés). */
function contentOf(block, p, env) {
  const c = block?.content;
  const images = [];
  if (typeof c === 'string') return { text: c, images };
  const parts = [];
  for (const b of Array.isArray(c) ? c : []) {
    if (b?.type === 'text') parts.push(String(b.text ?? ''));
    else if (b?.type === 'image') {
      const src = b.source || {};
      const base = p?.path && /\.(png|jpe?g|gif|webp|bmp)$/i.test(p.path) ? P(env).basename(p.path) : null;
      const name = base && !images.length ? base : `image-${images.length + 1}.${extOf(src.media_type)}`;
      images.push({ name, media_type: src.media_type || 'image/png', data: src.data || '' });
      parts.push(`[image jointe : ${name}]`);
    } else if (b?.type === 'document') parts.push('[document PDF non transmis]');
  }
  return { text: parts.join('\n'), images };
}

/** Read réussi : « 12\tligne » (ou « 12→ligne ») devient « 12: ligne », le format de l'exemple du doc FS. */
const readLines = t => t.split('\n').map(l => l.replace(/^\s*(\d+)[\t\u2192:](.*)$/, '$1: $2')).join('\n');

/**
 * Un tool_result de Claude Code → résultat pour FS. p = Pending de l'appel (ccName, path, command, note…).
 * Renvoie { output, isError, images:[{name,media_type,data}], needsRead }.
 */
export function translateResult(block, p = {}, ctx = {}) {
  const env = ctx.env || { cwd: '/', pathMod: 'posix' };
  const { text: raw, images } = contentOf(block, p, env);
  const shell = p.ccName === 'Bash' || p.ccName === 'PowerShell';
  let isError = block?.is_error === true;
  let text = raw.replace(REMINDER, '');
  const te = TOOL_ERROR.exec(text);
  if (te) { text = te[1]; isError = true; }
  text = text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');   // « 2\t » (dernière ligne vide d'un Read) gardé
  if (!text.trim()) text = '';
  const where = p.path ? displayPath(p.path, env) : 'ce chemin';
  const tr = (hit, s) => hit.out(hit.re.exec(s), where, env, s);
  let needsRead = false;
  if (isError) {
    // shell : seuls le refus, la permission non accordée et l'interruption sont traduits, la sortie de la commande part telle quelle (« Exit code N… »)
    const hit = (shell ? [REFUSED, NOT_GRANTED, ABORTED] : TRANSLATIONS).find(t => t.re.test(text));
    if (hit) { text = tr(hit, text); needsRead = !!hit.needsRead; }
    else if (!shell && !/^Exit code \d+/.test(text)) for (const [a, b] of RENAMES) text = text.replace(new RegExp(`\\b${a}\\b`, 'g'), b);
  } else if (shell && /<error>Command was aborted before completion<\/error>$/.test(text)) { text = tr(ABORTED, text); isError = true; }
  else if (p.ccName === 'Read' && UNCHANGED.test(raw) && !/^\s*\d+[\t→]/m.test(text)) text = UNCHANGED_TEXT;
  else if (NOTHING.test(text)) text = 'Aucun résultat.';
  else if (p.ccName === 'Read') {
    text = text ? readLines(text) : '(fichier vide)';
    if (p.path) markRead(ctx, p.path);
  }
  if (!isError && (p.ccName === 'Edit' || p.ccName === 'Write') && p.path) markRead(ctx, p.path);   // Claude Code connaît la version écrite
  if ((p.ccName === 'Bash' || p.ccName === 'PowerShell') && text.length > 4000) text = condenseTestOutput(p.command ?? p.input?.command ?? '', text);
  if (p.note) text = text ? `${text}\n${p.note}` : p.note;
  return { output: text || '(aucune sortie)', isError, images, needsRead };
}

/**
 * Sortie de tests trop longue (node --test, jest, vitest, pytest, npm test, plus de 4 000 caractères) : seulement les blocs
 * d'échec (lignes not ok, ✖, FAIL, FAILED, AssertionError + 15 lignes) et le bilan final (20 dernières lignes).
 */
export function condenseTestOutput(command, output) {
  const out = String(output ?? '');
  if (out.length <= 4000 || !TEST_CMD.test(String(command || ''))) return out;
  const lines = out.split('\n');
  const keep = new Uint8Array(lines.length);
  const FAIL = /\bnot ok\b|✖|\bFAIL(?:ED)?\b|AssertionError/;
  lines.forEach((l, i) => { if (FAIL.test(l)) for (let j = i; j <= Math.min(lines.length - 1, i + 15); j++) keep[j] = 1; });
  for (let j = Math.max(0, lines.length - 20); j < lines.length; j++) keep[j] = 1;
  const kept = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep[i]) { if (gap) kept.push('…'); kept.push(l); gap = false; } else gap = true;
  });
  const n = keep.reduce((s, k) => s + k, 0);
  return `[Sortie de test condensée : ${n} lignes sur ${lines.length} (échecs et bilan)]\n${kept.join('\n')}`;
}

// ── Budget de taille ────────────────────────────────────────────────────────────────────────────────────────────────

const CUT_NARROW = '\n[… coupé : lis une plage plus étroite]';

/** Coupe une lecture sur une fin de ligne et indique où reprendre (« N: » = numéro de la dernière ligne gardée). */
function cutRead(text, max) {
  const room = Math.max(0, max - 48);
  let head = text.slice(0, room);
  const nl = head.lastIndexOf('\n');
  if (nl > 0) head = head.slice(0, nl);
  const last = /^(\d+): /.exec(head.split('\n').at(-1) || '');
  const note = last ? `\n[… coupé : relis avec start_line=${Number(last[1]) + 1}]` : CUT_NARROW;
  return head + note;
}

function cutTo(r, max, opts) {
  if (r.output.length <= max) return r;
  if (r._read) { forgetRead(opts.readSet, r._read, opts.env); return { ...r, output: cutRead(r.output, max) }; }
  return { ...r, output: r.output.slice(0, Math.max(0, max - CUT_NARROW.length)) + CUT_NARROW };
}

/** Parts équitables (« water-filling ») : chacun reçoit au moins max(1500, total/n), ce que les petits n'utilisent pas est redistribué. */
function shares(lengths, total) {
  const n = lengths.length;
  const out = new Array(n).fill(0);
  let left = total, rest = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  while (rest.length) {
    const fair = Math.floor(left / rest.length);
    const small = rest.filter(x => x.len <= fair);
    if (!small.length) { for (const x of rest) out[x.i] = Math.max(1500, fair); break; }
    for (const x of small) { out[x.i] = x.len; left -= x.len; }
    rest = rest.filter(x => x.len > fair);
  }
  return out;
}

/**
 * Bornes de France Student : chaque sortie ≤ per (lecture coupée sur une fin de ligne avec « relis avec start_line=… »,
 * sinon coupe au milieu), puis somme ≤ total par parts équitables. Une lecture coupée sort de opts.readSet.
 * Les champs internes (_read) sont retirés : le résultat ne contient que { callId, output, isError }.
 */
export function budget(results, { per = PER, total = TOTAL, readSet = null, env = null } = {}) {
  const opts = { readSet, env };
  let rs = (results || []).map(r => {
    const output = String(r.output ?? '');
    if (output.length <= per) return { ...r, output };
    if (r._read) return cutTo({ ...r, output }, per, opts);
    return { ...r, output: clipMiddle(output, Math.max(0, per - 64)) };
  });
  if (rs.reduce((s, r) => s + r.output.length, 0) > total) {
    const share = shares(rs.map(r => r.output.length), total);
    rs = rs.map((r, i) => cutTo(r, share[i], opts));
  }
  return rs.map(({ _read, ...r }) => r);
}

// ── Collecte des résultats ──────────────────────────────────────────────────────────────────────────────────────────

const resultOf = (byId, id) => (byId instanceof Map ? byId.get(id) : byId?.[id]);
const idsOf = byId => (byId instanceof Map ? [...byId.keys()] : Object.keys(byId || {}));

/** Notes pour les résultats qui ne répondent à aucun appel FS en attente (Read injecté, document, action étrangère). */
function sideNotes(byId, pending, ctx) {
  const notes = [];
  const known = new Set(pending.map(p => p.ccId).filter(Boolean));
  for (const id of idsOf(byId)) {
    if (known.has(id)) continue;
    const r = resultOf(byId, id);
    const s = (ctx.synthetic || []).find(x => x.ccId === id);
    const failed = r?.is_error === true || TOOL_ERROR.test(contentOf(r, {}, ctx.env || {}).text);
    if (s?.purpose === 'read') { if (!failed) markRead(ctx, s.path); continue; }
    if (s?.purpose === 'doc') {
      if (!failed) markRead(ctx, s.path);
      notes.push(failed ? `L'utilisateur a refusé d'écrire ${s.name}.` : s.note);
      continue;
    }
    if (decodeId(id)) continue;                                              // à nous mais plus attendu : rien à dire
    const t = contentOf(r, {}, ctx.env || {}).text.replace(REMINDER, '').trim();
    notes.push(`(Résultat d'une action précédente : ${t.length > 400 ? t.slice(0, 400) + '…' : t})`);
  }
  return notes;
}

/**
 * Résultats de Claude Code → toolResults pour FS (§ 3.6). Chaque appel en attente reçoit exactement une réponse, dans
 * l'ordre de pending ; un id synthétique (s) n'y figure jamais.
 * resultsById : { [tool_use_id]: { content, is_error } } ou Map. ctx = { env, readSet, uploadFile?, partial?, synthetic?,
 * per?, total? } ; partial = résultats déjà prêts d'un micro-tour précédent (réutilisés tels quels).
 * Renvoie { toolResults, files (ids Files v2, 4 au plus), notes, retry (Pending à rejouer en micro-tour local) }.
 */
export async function collectResults(pending, resultsById, ctx = {}) {
  const out = [], files = [], retry = [];
  let imagesLeft = MAX_IMAGES;
  for (const p of pending || []) {
    const prev = (ctx.partial || []).find(r => r.callId === p.callId);
    if (prev) { out.push({ callId: p.callId, output: prev.output, isError: !!prev.isError }); continue; }
    if (p.local) { out.push({ callId: p.callId, output: p.local.output, isError: !!p.local.isError }); continue; }
    const r = p.ccId ? resultOf(resultsById, p.ccId) : null;
    if (!r) { out.push({ callId: p.callId, output: LOCAL.notRun, isError: true }); continue; }
    const t = translateResult(r, p, ctx);
    if (t.needsRead && !p.retried && (p.ccName === 'Edit' || p.ccName === 'Write')) { retry.push(p); continue; }
    let output = t.output;
    for (const img of t.images) {
      const id = imagesLeft > 0 ? await upload(img, ctx) : null;
      if (id) { files.push(id); imagesLeft--; } else output = output.replace(`[image jointe : ${img.name}]`, `[image non transmise : ${img.name}]`);
    }
    const item = { callId: p.callId, output, isError: t.isError };
    if (p.ccName === 'Read' && !t.isError) item._read = p.path;
    out.push(item);
  }
  const notes = sideNotes(resultsById, pending || [], ctx);
  const toolResults = budget(out, { per: ctx.per, total: ctx.total, readSet: ctx.readSet, env: ctx.env });
  return { toolResults, files, notes, retry };
}

/** Téléverse une image (Files v2) ; null en cas d'échec (jamais d'exception). */
async function upload(img, ctx) {
  if (typeof ctx.uploadFile !== 'function') return null;
  try { return await ctx.uploadFile(Buffer.from(img.data || '', 'base64'), img.name, img.media_type); } catch { return null; }
}
