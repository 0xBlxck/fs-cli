// Passerelle Claude Code : un tour France Student robuste (spécification § 3.9 et § 3.12).
// POST du delta, puis : en-têtes HTTP envoyés à l'acceptation (2xx), texte relayé au fil de l'eau (retenu sur 400 caractères
// tant que GPT n'a jamais appelé d'outil, pour détecter un refus), rattachement après une coupure (I2 : un POST accepté
// n'est jamais renvoyé), vérification de l'état du chat (reconcile), boucle interne pour les appels traités localement,
// documents du site écrits par des Write synthétiques, puis émission des tool_use APRÈS la sauvegarde de l'état (I4).
// Ce module n'écrit rien sur le disque lui-même : tout passe par ctx.store, et le réseau par ctx.deps (injectables).
import { textCleaner } from '../native.js';
import { documentsOf } from '../api.js';
import { tag } from '../chats.js';
import { CONTINUE_FR } from './context.js';
import { fpAssistant } from './transcript.js';
import { pushAnchor } from './store.js';
import { planToolUses, planDocuments, LOCAL } from './toolmap.js';
import { assertClean } from './outbound.js';
import { isRefusal, nextRefusalStep, switchAgentId, switchNote, errorKind, httpErrorFor, MESSAGES, CLARIFY } from './recover.js';

/** Texte de secours : jamais de réponse vide (même texte que anthropic.js). */
export const EMPTY_TEXT = '(France Student n\'a renvoyé aucune réponse. Renvoie ton message pour réessayer.)';
const MAX_INNER = 3;                                   // passages de la boucle interne (appels tous traités localement)
const DEFAULT_DELAYS = [1000, 3000, 8000];             // pauses avant chaque essai de rattachement
const RESULTS_TEXT_MAX = 8000;

const sleep = ms => (ms > 0 ? new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }) : Promise.resolve());
const one = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** Messages du chat (GET /chats/{id}) quelle que soit la forme de la réponse. */
const messagesOf = chat => (Array.isArray(chat?.chatMessages) ? chat.chatMessages : Array.isArray(chat?.messages) ? chat.messages : []);
const callIdOf = c => String(c?.callId ?? c?.call_id ?? c?.id ?? '');

/**
 * État réel du chat France Student (I6), lu avec GET /chats/{id} : le dernier message fait foi (client-tools.md).
 * → { state:'pending', callIds } (assistant avec toolCalls) | { state:'idle' } (assistant sans appel)
 *   | { state:'orphan_user' } (message utilisateur sans réponse) | { state:'unknown' } (lecture impossible).
 */
export async function reconcile(conv, deps) {
  let chat = null;
  if (conv?.chatId) { try { chat = await deps.fetchChat(conv.chatId); } catch { chat = null; } }
  const last = messagesOf(chat).at(-1);
  if (!last) return { state: 'unknown', callIds: [] };
  if (last.role === 'assistant') {
    const callIds = (Array.isArray(last.toolCalls) ? last.toolCalls : []).map(callIdOf).filter(Boolean);
    return { state: callIds.length ? 'pending' : 'idle', callIds, message: last };
  }
  if (last.role === 'user') return { state: 'orphan_user', callIds: [] };
  return { state: 'unknown', callIds: [] };
}

/** Résultats d'outils transformés en texte (quand FS ne les attend plus) : 8 000 caractères au plus, sans identifiant. */
export function resultsText(results) {
  const list = (results || []).filter(r => r && String(r.output ?? '').trim());
  if (!list.length) return '';
  let left = RESULTS_TEXT_MAX;
  const parts = [];
  for (const r of list) {
    if (left <= 0) break;
    const t = one(r.output, Math.min(left, 2000));
    parts.push(`- ${r.isError ? '(échec) ' : ''}${t}`);
    left -= t.length;
  }
  return `(Résultats des actions précédentes :\n${parts.join('\n')})`;
}

/** Applique le résultat de reconcile à la conversation : appels en attente recoupés avec ceux que FS attend vraiment. */
export function applyReconcile(conv, rec) {
  if (rec.state === 'pending') {
    const known = new Map((conv.fs.pending || []).map(p => [p.callId, p]));
    conv.fs.pending = rec.callIds.map(id => known.get(id)
      || { callId: id, ccId: null, fsName: '', path: null, local: { output: LOCAL.notRun, isError: true }, retried: 0 });
    conv.fs.state = 'pending';
  } else {
    conv.fs.pending = [];
    conv.fs.state = 'idle';
  }
  conv.fs.partial = null;
  return conv;
}

/** Envoi corrigé après reconcile : toolResults alignés sur ce que FS attend, le reste en texte (I3, I7). */
function fixSend(conv, send, rec) {
  applyReconcile(conv, rec);
  if (rec.state !== 'pending') return contentOnly(send);
  const byId = new Map((send.toolResults || []).map(r => [r.callId, r]));
  const toolResults = rec.callIds.map(id => byId.get(id) || { callId: id, output: LOCAL.notRun, isError: true });
  const extra = (send.toolResults || []).filter(r => !rec.callIds.includes(r.callId));
  const s = { ...send, toolResults };
  const text = [send.content, resultsText(extra)].filter(Boolean).join('\n\n');
  if (text) s.content = text;
  return s;
}

/** Même envoi sans toolResults : les résultats passent en texte (I7, un content est toujours accepté). */
function contentOnly(send) {
  const s = { ...send };
  delete s.toolResults;
  s.content = [send.content, resultsText(send.toolResults)].filter(Boolean).join('\n\n') || CONTINUE_FR;
  return s;
}

/** Chat créé dont l'id n'est pas arrivé : on le retrouve par l'étiquette [sid·cc] du titre (GET /chats/search). */
async function findByTag(sid, deps) {
  try {
    const list = await deps.searchChats?.(tag(sid, 'cc').trim(), 5);
    return (Array.isArray(list) ? list : []).map(c => c?.id).find(Boolean) || null;
  } catch { return null; }
}

// ── État d'un flux (un POST ou un rattachement) ──────────────────────────────────────────────────────────────────────

function newStream(conv, ctx) {
  return { accepted: false, received: '', held: '', cleaner: textCleaner(), guard: ctx.agent?.provider === 'openai' && !conv.refusal?.toolsSeen };
}

/** Texte nettoyé → Reply, ou retenu tant que la garde anti-refus est active (400 premiers caractères de GPT). */
function emit(st, reply, t) {
  if (!t) return;
  if (!st.guard) return reply.text(t);
  st.held += t;
  if (st.held.length >= 400 && !isRefusal(st.held)) { st.guard = false; reply.text(st.held); st.held = ''; }
}

/** Fin du flux : la garde tombe, le texte retenu et la fin du nettoyeur partent. */
function releaseText(st, reply) {
  st.guard = false;
  const t = st.held + st.cleaner.flush();
  st.held = '';
  if (t) reply.text(t);
}

function flushPrefix(reply, ctx) {
  if (!ctx.prefix?.length) return;
  reply.text((reply.emittedText ? '\n\n' : '') + ctx.prefix.join('\n') + '\n\n');
  ctx.prefix.length = 0;
}

/** Résultat d'un tour dont la suite est perdue : texte de fin (MESSAGES.lost par défaut), état vérifié au prochain envoi. */
const lostResult = (lostText = null) => ({ text: '', toolCalls: [], usage: null, documents: [], lost: true, ...(lostText ? { lostText } : {}) });
const LOST = Symbol('perdu');

/** Erreur rendue par le serveur dans le flux (événement SSE « error ») et non coupure réseau : se rattacher ne sert à rien. */
const fromServer = e => e?.serverError === true || /^Erreur du serveur:/.test(String(e?.message || ''));

function handlersFor(conv, reply, ctx, st) {
  return {
    onAccepted: () => {
      if (st.accepted) return;
      st.accepted = true;
      ctx.acceptedOnce = true;                           // un POST de ce tour est enregistré : plus jamais d'erreur réessayable
      conv.fs.state = 'inflight';
      ctx.store.save(conv);
      reply.headers();
      flushPrefix(reply, ctx);
    },
    onEventId: id => { if (id != null) conv.fs.lastEventId = String(id); },
    onUserMessageId: id => { conv.pendingUserMessageId = id ?? null; },
    onChat: id => { if (id && !conv.chatId) { conv.chatId = String(id); ctx.store.save(conv); } },
    onText: d => { const s = String(d ?? ''); st.received += s; emit(st, reply, st.cleaner.push(s)); },
  };
}

// ── Erreurs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Nouveau chat après un chat perdu (supprimé, verrouillé, historique cassé), une fois par tour. → send | null */
function restartSend(kind, ctx) {
  if (ctx.restarted || typeof ctx.restart !== 'function') return null;
  ctx.restarted = true;
  const s = ctx.restart(kind);
  if (s) ctx.prefix.push(MESSAGES.chatGone);
  return s;
}

/**
 * Erreur AVANT acceptation (rien n'est enregistré chez FS pour CE POST) : nouvel envoi corrigé, ou erreur HTTP Anthropic.
 * → send | null | LOST. LOST : un POST précédent du même tour a été accepté (boucle interne, refus GPT) ; une erreur
 * réessayable ferait renvoyer par Claude Code la même requête, donc la demande de l'utilisateur une 2e fois (I2).
 */
async function beforeAccept(conv, e, send, reply, ctx) {
  const kind = errorKind(e);
  ctx.log?.({ event: 'fs_error', phase: 'avant', kind, status: e?.status ?? null, code: e?.code ?? null });
  switch (kind) {
    case 'aborted': return null;
    case 'auth':
      if (!ctx.authRetried && typeof ctx.deps.reloadToken === 'function') {
        ctx.authRetried = true;
        try { if (await ctx.deps.reloadToken()) return send; } catch {}
      }
      break;
    case 'native': {
      if (!send.clientTools && !send.toolResults) break;
      // pas de conv.native = false sur disque : un 403 passager ne doit pas couper les outils pour toujours (models réessaie)
      ctx.models?.markNativeOff?.(send.agentId);
      applyReconcile(conv, { state: 'idle' });
      ctx.prefix.push(MESSAGES.nativeOff);
      const s = contentOnly(send);
      delete s.clientTools;
      return s;
    }
    case 'reconcile':
      if (!ctx.reconciled) { ctx.reconciled = true; return fixSend(conv, send, await reconcile(conv, ctx.deps)); }
      if (send.toolResults) { applyReconcile(conv, { state: 'idle' }); return contentOnly(send); }
      break;
    case 'daily':
      if (send.register && typeof ctx.borrow === 'function') { const s = ctx.borrow(); if (s) return s; }
      break;
    case 'gone': case 'locked': case 'broken': {
      const s = restartSend(kind, ctx);
      if (s) return s;
      break;
    }
    case 'disabled': ctx.onDisabled?.(); break;
    default: break;
  }
  if (ctx.acceptedOnce) return LOST;
  // 409 qui persiste après reconcile (chat occupé : compactage, autre génération) : Claude Code réessaiera plus tard
  const k = kind === 'reconcile' && Number(e?.status) === 409 ? 'busy' : kind;
  const err = k === 'policy' ? { status: 400, type: 'invalid_request_error', message: MESSAGES.contentPolicy, headers: {} }
    : httpErrorFor(k, ctx.quota?.(), e) || httpErrorFor('other', null, e);
  reply.fail(err.type, err.message, { status: err.status, headers: err.headers });
  return null;
}

/**
 * Rattachement après une coupure (I2) : GET /chats/{id}/stream avec Last-Event-ID (3 essais), sinon relecture du chat
 * (assistant → on reconstruit le résultat ; user orphelin → « Continue » une fois), sinon connexion perdue.
 */
export async function reattach(conv, h, st, send, ctx) {
  const signal = conv._abort?.signal;
  for (const ms of ctx.timing?.reattachDelays || DEFAULT_DELAYS) {
    await sleep(ms);
    if (signal?.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError', accepted: true });
    try { return await ctx.deps.resume(conv.chatId, conv.fs.lastEventId, { ...h, signal }); }
    catch (e) { if (e?.name === 'AbortError') throw e; ctx.log?.({ event: 'reattach', ok: false, message: one(e?.message, 120) }); }
  }
  const { last, result } = await readBack(conv, h, st, ctx);
  if (result) return result;
  if (last?.role === 'user' && !ctx.continued) {
    ctx.continued = true;
    conv.fs.state = 'orphan_user';
    const s = { agentId: send.agentId, chatId: conv.chatId, webSearch: !!send.webSearch, content: MESSAGES.continueCut, ...(send.clientTools ? { clientTools: send.clientTools } : {}) };
    try { return await ctx.deps.stream({ ...s, signal, ...h }); }
    catch (e) { if (e?.name === 'AbortError') throw e; }
  }
  return lostResult();
}

/**
 * Relecture du chat (GET /chats/{id}) après une coupure ou une erreur : si le dernier message est la réponse de
 * l'assistant à CE tour, on la reconstruit (seul le suffixe de texte manquant est émis).
 * → { last (dernier message, ou undefined), result (FsResult | null) }
 */
async function readBack(conv, h, st, ctx) {
  let chat = null;
  try { chat = await ctx.deps.fetchChat(conv.chatId); } catch {}
  const msgs = messagesOf(chat);
  const last = msgs.at(-1);
  if (last?.role !== 'assistant') return { last, result: null };
  // la réponse d'un tour précédent n'est pas celle de ce tour (message utilisateur de ce POST connu et absent avant elle)
  const mine = conv.pendingUserMessageId != null ? msgs.findIndex(m => String(m?.id) === String(conv.pendingUserMessageId)) : -1;
  if (conv.pendingUserMessageId != null && mine < 0 && msgs.some(m => m?.id != null)) return { last, result: null };
  const content = String(last.content ?? '');
  const missing = content.startsWith(st.received) ? content.slice(st.received.length) : (st.received ? '' : content);
  if (missing) h.onText(missing);
  return { last, result: { text: content, toolCalls: Array.isArray(last.toolCalls) ? last.toolCalls : [], usage: last.tokenUsage || null, documents: documentsOf(last.parts) } };
}

/**
 * Erreur APRÈS acceptation : jamais de nouveau POST du même message dans le même chat (I2).
 * Coupure réseau → rattachement. Erreur rendue par le serveur (événement SSE « error ») → chat perdu : nouveau chat
 * (une fois) ; échec définitif : relecture du chat, sinon note claire (ni rattachement ni « Continue », le serveur
 * rejouerait la même erreur). → résultat (éventuellement { note }, { lost }) ou { restart: send } (nouveau chat).
 */
async function afterAccept(conv, e, h, st, send, ctx) {
  const kind = errorKind(e);
  ctx.log?.({ event: 'fs_error', phase: 'après', kind, status: e?.status ?? null, code: e?.code ?? null });
  if (kind === 'aborted') throw e;
  if (kind === 'policy') return { text: '', toolCalls: [], usage: null, documents: [], note: MESSAGES.contentPolicy };
  if (kind === 'disabled') { ctx.onDisabled?.(); return { text: '', toolCalls: [], usage: null, documents: [], note: MESSAGES.accountDisabled }; }
  if (!fromServer(e) || ['reattach', 'retry_continue', 'busy'].includes(kind)) return reattach(conv, h, st, send, ctx);
  if (['gone', 'locked', 'broken'].includes(kind)) {
    const s = restartSend(kind, ctx);
    return s ? { restart: s } : lostResult(MESSAGES.chatGone);
  }
  return (await readBack(conv, h, st, ctx)).result || lostResult(MESSAGES.serverError);
}

/**
 * Un POST (avec ses corrections avant acceptation). → { r, st } | { aborted, st } | null (réponse d'erreur déjà envoyée).
 * Si un POST de ce tour a déjà été accepté (ctx.acceptedOnce), un échec se termine en { r: lostResult() } : fin propre.
 */
async function post(conv, send, reply, ctx) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const st = newStream(conv, ctx);
    const h = handlersFor(conv, reply, ctx, st);
    const leaks = assertClean(send, { pending: send.toolResults ? conv.fs.pending : null });
    if (leaks.length) ctx.log?.({ event: 'fuite', leaks });
    ctx.debug?.('fs-envoi', send);
    try {
      const r = await ctx.deps.stream({ ...send, signal: conv._abort?.signal, ...h });
      return { r: r || {}, st };
    } catch (e) {
      if (st.accepted || e?.accepted) {
        let r;
        try { r = await afterAccept(conv, e, h, st, send, ctx); }
        catch (e2) {
          if (e2?.name === 'AbortError') return { aborted: true, st };
          throw e2;
        }
        if (!r?.restart) return { r, st };
        send = r.restart;                                // nouveau chat : pas un renvoi dans le même chat (I2)
        continue;
      }
      const next = await beforeAccept(conv, e, send, reply, ctx);
      if (next === LOST) return { r: lostResult(), st };
      if (!next) return e?.name === 'AbortError' ? { aborted: true, st } : null;
      send = next;
    }
  }
  if (ctx.acceptedOnce) return { r: lostResult(), st: newStream(conv, ctx) };
  reply.fail('overloaded_error', MESSAGES.busy);
  return null;
}

/** Rattachement seul (génération acceptée par un processus précédent, requête identique) : aucun POST. */
async function resumeOnly(conv, reply, ctx) {
  const st = newStream(conv, ctx);
  st.accepted = true;
  ctx.acceptedOnce = true;
  const h = handlersFor(conv, reply, ctx, st);
  reply.headers();
  try { return { r: await reattach(conv, h, st, { agentId: conv.agentId, chatId: conv.chatId }, ctx), st }; }
  catch (e) { if (e?.name === 'AbortError') return { aborted: true, st }; throw e; }
}

// ── Refus GPT ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Envoi de l'étape de récupération (bare, clarify, switch) ; null si impossible. */
async function refusalSend(step, conv, send, ctx) {
  const base = { webSearch: !!send.webSearch, ...(send.clientTools ? { clientTools: send.clientTools } : {}) };
  if (step === 'bare' && ctx.userText) {
    conv.refusal.stage = 1;
    conv.bare = true;
    conv.chatId = null;
    applyReconcile(conv, { state: 'idle' });
    conv.preambleSent = false;
    return { ...base, agentId: send.agentId, chatId: null, content: tag(conv.sid, 'cc') + ctx.userText, register: { sid: conv.sid, role: 'cc' } };
  }
  if (step === 'bare' || step === 'clarify') {
    conv.refusal.stage = 1;
    return { ...base, agentId: send.agentId, chatId: conv.chatId, content: CLARIFY };
  }
  if (step === 'switch') {
    conv.refusal.stage = 2;
    const id = switchAgentId(send.agentId);
    const agent = (await ctx.models?.fromAgentId?.(id)) || { agentId: id, name: 'Claude Sonnet 5.5', provider: 'anthropic', native: true, contextWindow: 200000 };
    conv.agentId = agent.agentId;
    conv.provider = agent.provider;
    ctx.agent = agent;
    ctx.prefix.push(switchNote(agent.name));
    return { ...base, agentId: agent.agentId, chatId: conv.chatId, content: ctx.userText || CONTINUE_FR };
  }
  return null;
}

// ── Tour complet ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un tour France Student pour une requête de Claude Code : envoi, relais du texte, appels d'outils → tool_use.
 * ctx = { deps, store, agent, models?, key, est, prefix:string[], userText, toolCtx, timing?, log?, debug?, quota(),
 *         borrow?(), restart?(kind), onDisabled?() }.
 * send = null : rattachement seul (aucun POST). Renvoie { toolCalls, documents, usage, text, outcome, accepted }.
 */
export async function runFsTurn(conv, send, reply, ctx) {
  ctx.prefix ||= [];
  const release = await ctx.store.acquireFlow(() => reply.headersIfWaiting());
  conv._abort = new AbortController();
  conv.fs.inflightKey = ctx.key ?? null;
  try {
    return await turn(conv, send, reply, ctx);
  } finally {
    conv.fs.inflightKey = null;
    release();
  }
}

async function turn(conv, send, reply, ctx) {
  const got = send ? await post(conv, send, reply, ctx) : await resumeOnly(conv, reply, ctx);
  if (!got) return { outcome: 'erreur', accepted: false, toolCalls: [], documents: [], usage: null, text: '' };
  if (got.aborted) return abandoned(conv, got.st, reply, ctx);
  let { r, st } = got;
  if (send?.register && st.accepted && !conv.chatId) conv.chatId = await findByTag(conv.sid, ctx.deps);

  // refus GPT : le texte retenu n'est jamais transmis à Claude Code
  if (st.guard && !r.lost && !(r.toolCalls?.length) && !(r.documents?.length) && isRefusal(st.received || r.text || '')) {
    const step = nextRefusalStep(conv, ctx.agent, ctx.quota?.() || {});
    ctx.log?.({ event: 'refus', step, stage: conv.refusal.stage });
    const s = step !== 'give_up' ? await refusalSend(step, conv, send || {}, ctx) : null;
    if (s) return turn(conv, s, reply, ctx);
    reply.text(MESSAGES.giveUp + '\n\n');
  }
  releaseText(st, reply);
  if (r.note) reply.text((reply.emittedText ? '\n\n' : '') + r.note);

  let calls = r.toolCalls || [];
  let plan = planToolUses(calls, toolCtx(conv, ctx));
  let docs = planDocuments(r.documents || [], { ...toolCtx(conv, ctx), text: st?.received || r.text || '', userText: ctx.userText || '' });   // text : chemin cité par GPT
  // boucle interne : tous les appels sont traités localement (outil absent, argument manquant…) → retour direct à FS
  for (let n = 0; n < MAX_INNER && !r.lost && plan.pending.length && !plan.uses.length && !docs.uses.length && plan.pending.every(p => p.local); n++) {
    conv.fs.pending = plan.pending;
    conv.fs.state = 'pending';
    const s = { agentId: conv.agentId, chatId: conv.chatId, webSearch: !!send?.webSearch, ...(send?.clientTools ? { clientTools: send.clientTools } : {}),
      toolResults: plan.pending.map(p => ({ callId: p.callId, output: p.local.output, isError: !!p.local.isError })) };
    const g = await post(conv, s, reply, ctx);
    if (!g) return { outcome: 'erreur', accepted: true, toolCalls: [], documents: [], usage: null, text: '' };
    if (g.aborted) return abandoned(conv, g.st, reply, ctx);
    ({ r, st } = g);
    releaseText(st, reply);
    if (r.note) reply.text((reply.emittedText ? '\n\n' : '') + r.note);
    calls = r.toolCalls || [];
    plan = planToolUses(calls, toolCtx(conv, ctx));
    docs = planDocuments(r.documents || [], { ...toolCtx(conv, ctx), text: st?.received || r.text || '', userText: ctx.userText || '' });
  }
  if (calls.length) conv.refusal.toolsSeen = true;
  if (docs.text) reply.text((reply.emittedText ? '\n\n' : '') + docs.text);
  if (r.lost) reply.text((reply.emittedText ? '\n\n' : '') + String(r.lostText || MESSAGES.lost).replace(/^\n+/, ''));

  const uses = r.lost ? [] : [...plan.uses, ...docs.uses];
  if (!uses.length && !reply.hasContent) reply.text(EMPTY_TEXT);
  conv.fs.pending = r.lost ? [] : plan.pending;
  conv.fs.state = r.lost ? 'uncertain' : plan.pending.length ? 'pending' : 'idle';
  conv.fs.synthetic = r.lost ? [] : [...plan.synthetic, ...docs.synthetic];
  conv.fs.partial = null;
  conv.fs.inflightKey = null;
  if (Number.isFinite(r.usage?.promptTokenCount)) conv.fsPromptTokens = r.usage.promptTokenCount;
  conv.turn = (conv.turn || 0) + 1;
  // plus personne n'écoute (Échap, client parti) : Claude Code n'aura jamais cette réponse, son prochain historique
  // s'arrêtera à la précédente, ce qui ne doit pas passer pour un retour en arrière
  if (reply.listeners === 0) markUndelivered(conv, conv.lastFp, ctx, reply.emittedText);
  else conv.undelivered = null;
  conv.lastText = reply.emittedText;
  conv.lastFp = fpAssistant({ text: reply.emittedText, toolUses: uses });
  pushAnchor(conv);
  ctx.store.save(conv);                                                    // I4 : état sur disque avant les octets des tool_use
  for (const u of uses) reply.toolUse(u.id, u.name, u.input);
  reply.finish(uses.length ? 'tool_use' : 'end_turn', r.usage || null);
  return { toolCalls: calls, documents: r.documents || [], usage: r.usage || null, text: r.text || '', accepted: true,
    outcome: r.lost ? 'perdu' : uses.length ? `${uses.length} outil(s)` : 'ok' };
}

/** Contexte de toolmap pour ce chat (le chatId peut avoir changé : nouveau chat, emprunt, chat bare). */
const toolCtx = (conv, ctx) => ({ ...ctx.toolCtx, chatId: conv.chatId, readSet: conv.readSet });

/**
 * Réponse que Claude Code n'a pas reçue en entier : on garde l'empreinte de la réponse d'AVANT (celle qui terminera son
 * prochain historique), le texte de la demande que FS a déjà (à ne pas renvoyer) et le texte partiel (gardé par le SDK).
 * Plusieurs abandons de suite sur la même réponse : les demandes s'ajoutent (Claude Code les fusionne de la même façon).
 */
function markUndelivered(conv, fp, ctx, partial) {
  const prev = conv.undelivered && conv.undelivered.fp === (fp ?? null) ? conv.undelivered.text : '';
  conv.undelivered = { fp: fp ?? null, text: [prev, ctx.userText].filter(Boolean).join('\n\n'), partial: String(partial || '') };
}

/**
 * Génération annulée (client parti, puis cancelStream) : état « incertain », vérifié au prochain envoi (I6).
 * conv.lastFp n'est PAS remplacé par le texte partiel : le terminal de Claude Code ne garde pas un bloc inachevé
 * (seul le SDK le fait), son prochain historique s'arrête donc à la dernière réponse complète.
 */
function abandoned(conv, st, reply, ctx) {
  if (st?.accepted || ctx.acceptedOnce) {
    conv.fs.state = 'uncertain';
    markUndelivered(conv, conv.lastFp, ctx, st?.received || reply.emittedText);
  }
  conv.fs.inflightKey = null;
  ctx.store.save(conv);
  if (!reply.done) reply.finish('end_turn');
  return { outcome: 'annulé', accepted: !!(st?.accepted || ctx.acceptedOnce), toolCalls: [], documents: [], usage: null, text: '' };
}
