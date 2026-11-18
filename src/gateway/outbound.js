// Passerelle Claude Code : SEUL constructeur des corps envoyés à France Student (spécification § 3.7, invariant I1).
// Tout ce qui part chez FS passe par buildSend puis assertClean : le prompt système, les outils, les messages role:"system"
// et les system-reminders de Claude Code ne partent jamais ; seul le delta (texte humain nettoyé, notes en français,
// résultats des appels en attente) est transmis. Le contenu des fichiers lus et la sortie des commandes (toolResults)
// partent tels quels : assertClean ne les inspecte pas.
import { CLIENT_TOOLS } from '../api.js';
import { READ_TOOLS } from '../native.js';
import { tag } from '../chats.js';
import { preamble, claudeMdExcerpt, CONTINUE_FR } from './context.js';
import { LOCAL } from './toolmap.js';

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).trimEnd() + '…' : t; };

/**
 * Notes et messages en français produits par la passerelle (jamais de vocabulaire propre à Claude Code).
 * kind : interrupted | foreign {text} | rewind {excerpt} | rewound | notRun | borrowed | continue | cwd {cwd}
 *        | shell {shellTool} | claudeMd {text}
 */
export function frenchNote(kind, data = {}) {
  switch (kind) {
    case 'interrupted': return '(L\'utilisateur a interrompu l\'action précédente.)';
    case 'foreign': return `(Réponse affichée entre-temps, hors France Student : « ${clip(data.text, 400)} ».)`;
    case 'rewind': return `[Retour en arrière : l'utilisateur a annulé tout ce qui suit ta réponse « ${clip(data.excerpt, 64)} ». Les fichiers ont pu être restaurés : relis-les avant de les modifier. Ne tiens plus compte des échanges annulés.]`;
    case 'rewound': return 'Annulé (retour en arrière).';
    case 'notRun': return LOCAL.notRun;
    case 'borrowed': return '[Nouvelle tâche, sans rapport avec ce qui précède.]';
    case 'continue': return CONTINUE_FR;
    case 'cwd': return `(Le dossier de travail est maintenant ${data.cwd} : les chemins relatifs partent de ce dossier.)`;
    case 'shell': return data.shellTool === 'PowerShell'
      ? '(Les commandes de run_command s\'exécutent maintenant dans PowerShell.)'
      : data.shellTool ? '(Les commandes de run_command s\'exécutent maintenant dans bash : syntaxe POSIX.)'
        : '(run_command n\'est plus disponible dans cette session.)';
    case 'claudeMd': return data.text ? `[Consignes du projet mises à jour (CLAUDE.md, extrait) :\n${data.text}]` : '(Les consignes du projet (CLAUDE.md) ont été retirées.)';
    default: return '';
  }
}

/** Fusionne les messages user du delta : textes, résultats, notes, images, interruption, CLAUDE.md, date. */
export function mergeUserTurns(userTurns = []) {
  const u = { text: '', results: [], notes: [], images: [], interrupted: false, claudeMd: null, date: null };
  const texts = [];
  for (const t of userTurns || []) {
    if (!t || t.role !== 'user') continue;
    if (t.text) texts.push(t.text);
    u.results.push(...(t.results || []));
    u.notes.push(...(t.notes || []));
    u.images.push(...(t.images || []));
    u.interrupted ||= !!t.interrupted;
    u.claudeMd = t.claudeMd || u.claudeMd;
    u.date = t.date || u.date;
  }
  u.text = texts.join('\n\n').trim();
  return u;
}

const claudeMdFor = (agent, extras) => agent.provider === 'anthropic' || !!extras.forceClaudeMd;

/** Notes d'une ligne quand le dossier, le shell ou CLAUDE.md changent en cours de conversation (envoyées une fois). */
function changeNotes(conv, env, u, agent, extras) {
  const notes = [];
  const was = conv.env || {};
  if (env?.cwd && was.cwd && env.cwd !== was.cwd) notes.push(frenchNote('cwd', { cwd: env.cwd }));
  if (extras.shellTool !== undefined && conv.shellTool !== undefined && extras.shellTool !== conv.shellTool) notes.push(frenchNote('shell', { shellTool: extras.shellTool }));
  if (u.claudeMd && u.claudeMd.hash !== conv.claudeMdHash && claudeMdFor(agent, extras)) notes.push(frenchNote('claudeMd', { text: claudeMdExcerpt(u.claudeMd) }));
  return notes;
}

/** Réponse « non exécuté » (ou « annulé ») pour chaque appel FS en attente, quand Claude Code n'a rien renvoyé. */
const answerAll = (pending, output) => (pending || []).map(p => ({ callId: p.callId, output, isError: true }));

/**
 * Construit le corps d'un envoi à France Student (FsSend). Pur : ne modifie pas conv (voir afterSend).
 * extras = {
 *   images?:string[]       ids Files v2 des images du message utilisateur (déjà téléversées) ;
 *   files?:string[]        ids Files v2 des images des résultats (collectResults) ;
 *   toolResults?:array     résultats de collectResults (sinon « Non exécuté » pour chaque appel en attente) ;
 *   notes?:string[]        notes à ajouter (collectResults, documents…) ;
 *   web?, date?, shellTool?, forceClaudeMd?   recherche web FS, date du jour, outil shell, CLAUDE.md pour tous les modèles ;
 *   borrowed?:boolean      chat existant emprunté pour une nouvelle tâche (note + préambule) ;
 *   recap?:string          récapitulatif qui amorce un nouveau chat (retour en arrière, conversation inconnue) ;
 *   rewind?:'note'         retour en arrière par note dans le même chat (appels en attente « annulés ») }
 */
export function buildSend(conv, delta, agent, env, extras = {}) {
  const u = mergeUserTurns(delta?.userTurns);
  const notes = [
    ...(conv.notes || []),
    ...(delta?.kind === 'rewind' && extras.rewind === 'note' ? [frenchNote('rewind', { excerpt: conv.anchors?.[delta.anchorIndex]?.[2] || conv.lastText || '' })] : []),
    ...(delta?.foreignAssistantText ? [frenchNote('foreign', { text: delta.foreignAssistantText })] : []),
    ...u.notes,
    ...(extras.notes || []),
    ...(u.interrupted ? [frenchNote('interrupted')] : []),
  ];
  const send = { agentId: agent.agentId, chatId: conv.chatId || null, webSearch: !!extras.web };
  if (agent.native) send.clientTools = conv.planMode ? [...READ_TOOLS] : [...CLIENT_TOOLS];
  const pre = () => preamble(env, {
    sid: conv.sid, claudeMd: u.claudeMd, provider: agent.provider, shellTool: extras.shellTool, date: extras.date ?? u.date,
    forceClaudeMd: !!extras.forceClaudeMd, bare: !!conv.bare,
  });
  if (!send.chatId) {
    const head = conv.bare ? tag(conv.sid, 'cc') : pre();
    const body = conv.bare ? u.text : [extras.recap, notes.join('\n'), u.text].filter(Boolean).join('\n\n');
    send.content = head + (body || frenchNote('continue'));
    send.register = { sid: conv.sid, role: 'cc' };
  } else {
    if (agent.native && conv.fs?.state === 'pending') {
      send.toolResults = delta?.kind === 'rewind' && extras.rewind === 'note' ? answerAll(conv.fs.pending, frenchNote('rewound'))
        : Array.isArray(extras.toolResults) ? extras.toolResults : answerAll(conv.fs.pending, frenchNote('notRun'));
    }
    const allNotes = extras.borrowed ? notes : [...changeNotes(conv, env, u, agent, extras), ...notes];
    const text = [allNotes.join('\n'), u.text].filter(Boolean).join('\n\n');
    if (extras.borrowed) send.content = `${frenchNote('borrowed')}\n${conv.bare ? tag(conv.sid, 'cc') : pre()}${text || frenchNote('continue')}`;
    else if (text) send.content = text;
    else if (!send.toolResults) send.content = frenchNote('continue');     // I7 : un content texte est toujours accepté
  }
  const files = [...new Set([...(extras.images || []), ...(extras.files || [])])].slice(0, 4);
  if (files.length) send.files = files;
  return send;
}

/** Après un envoi accepté : notes consommées, environnement et CLAUDE.md mémorisés (les notes de changement partent une fois). */
export function afterSend(conv, env, { claudeMd = null, shellTool } = {}) {
  conv.notes = [];
  conv.preambleSent = true;
  if (env) conv.env = env;
  if (claudeMd?.hash) conv.claudeMdHash = claudeMd.hash;
  if (shellTool !== undefined) conv.shellTool = shellTool;
  return conv;
}

// ── Garde anti-fuite (I1) ───────────────────────────────────────────────────────────────────────────────────────────

const LEAKS = [
  { re: /<\/?\s*system-reminder[^>]*>/gi, label: 'balise system-reminder', fix: '' },
  { re: /<\/?command-[a-z-]*>?/gi, label: 'balise command-', fix: '' },
  { re: /<\/?\s*tool_use_error\s*>/gi, label: 'balise tool_use_error', fix: '' },
  { re: /You are Claude Code/gi, label: '« You are Claude Code »', fix: 'l\'assistant' },
  { re: /x-anthropic-billing-header/gi, label: 'x-anthropic-billing-header', fix: '' },
  { re: /\b(?:TodoWrite|NotebookEdit|WebFetch|SendMessage|ExitPlanMode)\b/g, label: 'nom d\'outil', fix: 'l\'assistant' },
  { re: /`(?:Read|Edit|Write|Bash|Grep|Glob|Agent|Task|Skill)`/g, label: 'nom d\'outil entre accents graves', fix: 'l\'assistant' },
];

/** I3 : chaque appel en attente reçoit exactement une réponse, et rien d'autre (aucun id synthétique). */
function checkResults(send, pending) {
  if (!pending) return [];
  const leaks = [];
  const want = new Set(pending.map(p => p.callId));
  const seen = new Map();
  for (const r of send.toolResults || []) seen.set(r.callId, (seen.get(r.callId) || 0) + 1);
  if (!send.toolResults) return leaks;
  for (const [id, n] of seen) {
    if (!want.has(id)) leaks.push(`toolResults : callId inconnu ${id}`);
    else if (n > 1) leaks.push(`toolResults : callId ${id} répondu ${n} fois`);
  }
  for (const id of want) if (!seen.has(id)) leaks.push(`toolResults : callId ${id} sans réponse`);
  return leaks;
}

/**
 * Cherche dans send.content (jamais dans toolResults[].output) tout ce qui est propre à Claude Code.
 * Renvoie la liste des fuites trouvées. strict : lève une Error (tests) ; sinon nettoie send.content en place
 * (balise retirée, nom remplacé par « l'assistant ») pour la production, qui journalise la liste.
 * { pending } : vérifie aussi I3 sur send.toolResults (signalé, jamais corrigé ici).
 */
export function assertClean(send, { strict = false, pending = null } = {}) {
  const leaks = [];
  const content = typeof send?.content === 'string' ? send.content : '';
  for (const l of LEAKS) {
    const found = content.match(l.re);
    if (found) leaks.push(`${l.label} : ${[...new Set(found)].join(', ')}`);
  }
  leaks.push(...checkResults(send || {}, pending));
  if (strict && leaks.length) throw new Error(`Fuite vers France Student (I1/I3) : ${leaks.join(' ; ')}`);
  if (leaks.length && content) {
    let c = content;
    for (const l of LEAKS) c = c.replace(l.re, l.fix);
    send.content = c;
  }
  return leaks;
}
