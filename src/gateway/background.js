// Passerelle Claude Code : réponses locales aux requêtes d'arrière-plan (spécification § 3.11). 0 appel France Student :
// titre, nom, sondes, suggestions, résumés, préfixe Bash, WebFetch, WebSearch désactivée, /btw, compaction (résumé local,
// France Student garde toute la conversation et le marqueur [fs-gw:<id>] permet de la retrouver ensuite).
import { lastUserText } from './classify.js';
import { cleanUserContent, splitReminders, CONTINUE_FR } from './context.js';

const WEB_FETCH_MAX = 8000;
export const SUBAGENT_REFUSAL = 'Sous-agent indisponible avec France Student (limite de conversations) : je continue sans lui.';
export const WEB_SEARCH_OFF = 'Recherche web désactivée : relance avec fs-cli claude --fs-web.';
// /btw : la conversation France Student est unique et ne peut pas répondre « à côté » sans que la question y reste.
export const SIDE_QUESTION_OFF = 'Question annexe indisponible avec France Student : pose-la dans la conversation principale.';

/** Estimation des tokens d'entrée à partir du corps reçu de Claude Code (caractères / 3,5), jamais la taille du chat FS. */
export function estimateBodyTokens(body) {
  const b = body || {};
  return Math.ceil(JSON.stringify({ system: b.system, tools: b.tools, messages: b.messages }).length / 3.5);
}

const words = (s, n) => String(s ?? '').split(/\s+/).filter(Boolean).slice(0, n);
const oneLine = (s, max) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t; };
const baseName = p => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || String(p ?? '');
const TRAILING_PUNCT = /[\s.,;:!?…·\-–—"'«»()[\]{}]+$/u;

/** Titre local : 6 premiers mots, ponctuation finale retirée, majuscule initiale, 60 caractères au plus. */
export function localTitle(text) {
  const clean = splitReminders(text).clean;
  let t = words(clean, 6).join(' ').replace(TRAILING_PUNCT, '');
  if (t.length > 60) t = t.slice(0, 60).replace(TRAILING_PUNCT, '');
  if (!t) return 'Nouvelle session';
  return t.charAt(0).toLocaleUpperCase('fr-FR') + t.slice(1);
}

/** Nom kebab-case : 6 premiers mots, sans accents ; 'session' si vide. */
export function localSlug(text) {
  const s = words(splitReminders(text).clean, 6).join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'session';
}

// Forme canonique légère (même forme que transcript.canonicalize) quand l'appelant ne fournit pas ctx.turns.
function toTurns(messages) {
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role === 'assistant') {
      const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
      turns.push({
        role: 'assistant',
        text: c.filter(b => b?.type === 'text').map(b => b.text).join(''),
        toolUses: c.filter(b => b?.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input || {} })),
      });
    } else if (m?.role === 'user') {
      const c = Array.isArray(m.content) ? m.content : [];
      const results = c.filter(b => b?.type === 'tool_result').map(b => ({ id: b.tool_use_id, content: b.content, is_error: !!b.is_error }));
      turns.push({ role: 'user', ...cleanUserContent(m.content), results });
    }
  }
  return turns;
}

// Prompts internes de Claude Code (forks) : ce ne sont pas des demandes de l'utilisateur.
const INTERNAL_PROMPT = /^(CRITICAL: Respond with TEXT ONLY|\[SUGGESTION MODE:|The user stepped away|Describe your most recent action|Generate a short kebab-case name)|create a detailed summary of the conversation/;
const isHumanRequest = t => t.role === 'user' && t.text && !INTERNAL_PROMPT.test(t.text) && !(t.isContinuation && t.text === CONTINUE_FR);
const lastAssistantText = turns => [...turns].reverse().find(t => t.role === 'assistant' && t.text?.trim())?.text || '';

/**
 * Résumé de compaction construit localement (format <analysis>/<summary> attendu par Claude Code).
 * Le marqueur [fs-gw:<conv.id>] permet à store.find de retrouver le même chat France Student après la compaction.
 */
export function localCompactSummary(turns, conv) {
  const all = Array.isArray(turns) ? turns : [];
  const asks = all.filter(isHumanRequest).slice(-8).map(t => `   - ${oneLine(t.text, 300)}`);
  const uses = all.filter(t => t.role === 'assistant').flatMap(t => t.toolUses || []);
  const errors = new Set(all.filter(t => t.role === 'user').flatMap(t => t.results || []).filter(r => r.is_error).map(r => r.id));
  const files = [...new Set(uses.filter(u => /^(Write|Edit)$/.test(u.name) && u.input?.file_path).map(u => u.input.file_path))];
  const cmds = uses.filter(u => /^(Bash|PowerShell)$/.test(u.name) && u.input?.command).slice(-5)
    .map(u => `   - ${oneLine(u.input.command, 200)}${errors.has(u.id) ? ' (échec)' : ''}`);
  const last = String(conv?.lastText || lastAssistantText(all)).trim();
  const lines = [
    '<analysis>Résumé construit localement par FS-CLI : la conversation complète reste dans France Student.</analysis>',
    '<summary>',
    '1. Demandes de l\'utilisateur :' + (asks.length ? '\n' + asks.join('\n') : ' aucune'),
    '2. Fichiers touchés : ' + (files.length ? files.join(', ') : 'aucun'),
    '3. Dernières commandes :' + (cmds.length ? '\n' + cmds.join('\n') : ' aucune'),
    '4. Dernière réponse : ' + (last ? (last.length > 1500 ? last.slice(0, 1500) + '…' : last) : 'aucune'),
  ];
  if (conv?.id) lines.push(`5. Conversation France Student conservée : [fs-gw:${conv.id}]`);
  lines.push('</summary>');
  return lines.join('\n');
}

// Texte « humain » d'une requête de titre ou de nom : contenu de <session> / <conversation>, sinon 1re demande.
function sourceText(body, turns) {
  const last = lastUserText(body?.messages);
  const m = last.match(/<(session|conversation)>\n?([\s\S]*?)\n?<\/\1>/);
  if (m) return m[2];
  return turns.find(isHumanRequest)?.text || '';
}

// Objet JSON conforme au schéma demandé (title, name, branch… ; autres chaînes requises vides).
function schemaAnswer(body, kind, src) {
  const schema = body?.output_config?.format?.schema || body?.output_format?.schema || {};
  const props = schema.properties || {};
  const out = {};
  for (const k of [...new Set([...(schema.required || []), ...Object.keys(props)])]) {
    if (k === 'title') out.title = localTitle(src);
    else if (k === 'name') out.name = localSlug(src);
    else if (k === 'branch') out.branch = localSlug(src);
    else if ((schema.required || []).includes(k) && (props[k]?.type || 'string') === 'string') out[k] = '';
  }
  if (kind === 'title' && !('title' in out)) out.title = localTitle(src);
  if (kind === 'name' && !('name' in out)) out.name = localSlug(src);
  return JSON.stringify(out);
}

// Libellé du dernier outil d'une requête « Tools completed: … Label: » (entrée JSON coupée à 300 caractères par Claude Code).
function toolLabel(text) {
  const blocks = String(text ?? '').split(/^Tool: /m).slice(1);
  const b = blocks[blocks.length - 1];
  if (!b) return 'Action terminée';
  const name = b.match(/^(\S+)/)?.[1] || '';
  const field = f => {
    const m = b.match(new RegExp(`"${f}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    if (!m) return '';
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  };
  if (name === 'Read') return `Lecture de ${baseName(field('file_path'))}`;
  if (/^(Edit|Write)$/.test(name)) return `Modification de ${baseName(field('file_path'))}`;
  if (/^(Bash|PowerShell)$/.test(name)) return `Commande : ${field('command').replace(/\s+/g, ' ').trim().slice(0, 30).trimEnd()}`;
  return 'Action terminée';
}

function webPage(text) {
  const m = String(text ?? '').match(/Web page content:\n---\n([\s\S]*?)\n---\n/);
  const page = (m ? m[1] : String(text ?? '')).trim();
  return (page.length > WEB_FETCH_MAX ? page.slice(0, WEB_FETCH_MAX) + '\n[…]' : page)
    + '\n\n(Résumé non disponible : contenu brut de la page.)';
}

function textFor(cls, body, ctx, turns) {
  switch (cls.kind) {
    case 'title': case 'name': return schemaAnswer(body, cls.kind, sourceText(body, turns));
    case 'probe': return '.';
    case 'suggestion': case 'background_other': return '';
    case 'away_summary': {
      const w = words(ctx.conv?.lastText || lastAssistantText(turns.slice(0, -1)), 40);
      return w.length ? 'Dernière étape : ' + w.join(' ') : 'Travail en cours.';
    }
    case 'agent_summary': return 'Travail en cours';
    case 'tool_summary': return toolLabel(lastUserText(body?.messages));
    case 'bash_prefix': return 'none';
    case 'compact': return localCompactSummary(turns, ctx.conv);
    case 'web_fetch': return webPage(lastUserText(body?.messages));
    case 'web_search': return WEB_SEARCH_OFF;
    case 'side_question': return SIDE_QUESTION_OFF;
    case 'subagent': return SUBAGENT_REFUSAL;
    default: return null;
  }
}

/**
 * Réponse locale d'une requête d'arrière-plan. ctx : { conv?, turns?, est?, modelKnown? }.
 * - probe : si ctx.modelKnown === false, renvoie { error:{status:404,type,message} } (l'appelant répond en 404).
 * - main (ou sorte inconnue) : null, la requête doit passer par le moteur.
 * @returns {{content:{type:'text',text:string}[], stop:string, usage:{input_tokens:number,output_tokens:number}, error?:object}|null}
 */
export function answerLocally(cls, body, ctx = {}) {
  const turns = ctx.turns || toTurns(body?.messages);
  const input = ctx.est ?? estimateBodyTokens(body);
  if (cls.kind === 'probe' && ctx.modelKnown === false) {
    return { content: [], stop: null, usage: { input_tokens: input, output_tokens: 0 },
      error: { status: 404, type: 'not_found_error', message: `model: ${cls.model} introuvable sur France Student` } };
  }
  const text = textFor(cls, body, ctx, turns);
  if (text == null) return null;
  return {
    content: [{ type: 'text', text }],
    stop: cls.kind === 'probe' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: input, output_tokens: Math.ceil(text.length / 4) },
  };
}

/**
 * Compactage côté France Student après un /compact local, en tâche de fond : seulement si le chat dépasse 60 % de la
 * fenêtre et qu'aucun appel n'est en attente. Ne lève jamais d'exception ; 409/422 ignorés. Renvoie le statut ou null.
 */
export async function compactFsInBackground(conv, { contextWindow = 200000, compactChat } = {}) {
  if (!conv?.chatId || conv.fs?.state !== 'idle' || typeof compactChat !== 'function') return null;
  if (!(conv.fsPromptTokens > 0.6 * contextWindow)) return null;
  try { return (await compactChat(conv.chatId))?.status ?? null; } catch { return null; }
}
