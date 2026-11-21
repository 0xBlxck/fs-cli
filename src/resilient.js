// Moteur du CLI : récupération après une coupure ou un désaccord avec France Student, d'après client-tools.md.
// - Un message accepté (2xx) n'est JAMAIS renvoyé : on se rattache à la génération (GET /chats/{id}/stream + Last-Event-ID),
//   sinon on relit le chat (GET /chats/{id}) : le dernier message fait foi (réponse, appels d'outils en attente).
// - 409 / 400 « missing: … » sur un envoi de résultats : on lit les appels vraiment en attente et on répond à chacun, une fois.
// - 409 sur un nouveau message (résumé ou génération en cours chez FS) : on attend puis on réessaie, au lieu d'échouer.
// Rien n'est caché : chaque récupération est annoncée par ctx.note.

/** Pause interrompue tout de suite par Ctrl+C (signal). */
const sleep = (ms, signal) => (ms > 0 ? new Promise(r => {
  const done = () => { clearTimeout(t); signal?.removeEventListener?.('abort', done); r(); };
  const t = setTimeout(done, ms);                                       // pas d'unref : en fs -p rien d'autre ne retient Node (il quitterait en silence)
  signal?.addEventListener?.('abort', done, { once: true });
}) : Promise.resolve());
const messagesOf = chat => (Array.isArray(chat?.chatMessages) ? chat.chatMessages : Array.isArray(chat?.messages) ? chat.messages : []);
const callIdOf = c => String(c?.callId ?? c?.call_id ?? c?.id ?? '');
const aborted = () => Object.assign(new Error('annulé'), { name: 'AbortError' });

export const NOT_RUN = 'Non exécuté : le CLI n\'avait pas cet appel (connexion coupée). Refais-le si besoin.';
export const BUSY_MESSAGE = 'La conversation est occupée chez France Student (résumé ou réponse encore en cours). Réessaie dans un instant.';
export const LOST_MESSAGE = 'Connexion perdue avec France Student et réponse introuvable. Ton message est bien enregistré : tape /continue pour reprendre.';

/** État réel du chat : { state: 'pending'|'idle'|'orphan_user'|'unknown', callIds, msgs } */
export async function chatState(chatId, fetchChat) {
  let chat = null;
  try { chat = chatId ? await fetchChat(chatId) : null; } catch {}
  const msgs = messagesOf(chat);
  const last = msgs.at(-1);
  if (!last) return { state: 'unknown', callIds: [], msgs };
  if (last.role === 'assistant') {
    const callIds = (Array.isArray(last.toolCalls) ? last.toolCalls : []).map(callIdOf).filter(Boolean);
    return { state: callIds.length ? 'pending' : 'idle', callIds, msgs };
  }
  return { state: last.role === 'user' ? 'orphan_user' : 'unknown', callIds: [], msgs };
}

/** Résultats alignés sur les appels que FS attend : chacun exactement une fois (les inconnus du CLI : « non exécuté »). */
export function alignResults(results, callIds) {
  const byId = new Map((results || []).map(r => [String(r.callId), r]));
  return callIds.map(id => byId.get(id) || { callId: id, output: NOT_RUN, isError: true });
}

/** Réponse de l'assistant relue dans l'historique (seule la fin pas encore affichée part dans onText). null si absente. */
function fromHistory(msgs, ctx) {
  const last = msgs.at(-1);
  if (last?.role !== 'assistant') return null;
  const uid = ctx.userMessageId?.();
  if (uid != null && msgs.some(m => m?.id != null)) {
    const mine = msgs.findIndex(m => String(m?.id) === String(uid));
    if (mine < 0 || mine > msgs.length - 2) return null;                // pas la réponse à CE message
  }
  const content = String(last.content ?? '');
  const seen = ctx.received?.() || '';
  const missing = content.startsWith(seen) ? content.slice(seen.length) : (seen ? '' : content);
  if (missing) ctx.onText?.(missing);
  const { documentsOf, imagesOf } = ctx.parts || {};
  return {
    text: content, usage: last.tokenUsage || null, recovered: true,
    toolCalls: Array.isArray(last.toolCalls) ? last.toolCalls : [],
    documents: documentsOf ? documentsOf(last.parts) : [], images: imagesOf ? imagesOf(last.parts) : [],
  };
}

/**
 * e : erreur de l'envoi en cours. ctx = {
 *   chatId(), results (toolResults envoyés, ou null pour un message), resend(patch) → Promise<res> (patch.toolResults),
 *   resume(chatId, lastEventId) → Promise<res>, fetchChat(chatId), received(), userMessageId(), onText, signal, note(msg),
 *   delays (rattachement), busyDelays (chat occupé), parts { documentsOf, imagesOf } }
 * → résultat comme stream(), ou lève (l'erreur d'origine, ou une erreur claire).
 */
export async function recoverSend(e, ctx) {
  const { errorKind } = await import('./gateway/recover.js');
  const kind = errorKind(e);
  const signal = ctx.signal;
  if (kind === 'aborted' || signal?.aborted) throw e;
  const chatId = ctx.chatId?.();
  if (!chatId || !ctx.fetchChat) throw e;
  // Ctrl+C pendant une récupération : la génération est aussi arrêtée chez FS (le rattachement ne l'arrête pas de lui-même)
  const stop = () => { try { ctx.cancel?.(chatId); } catch {} return aborted(); };
  const wait = async ms => { await sleep(ms, signal); if (signal?.aborted) throw stop(); };

  // ── Après acceptation : le message est enregistré chez FS, il ne sera pas renvoyé ──
  if (e?.accepted) {
    const fromServer = e.serverError === true;
    if (!fromServer || kind === 'reattach' || kind === 'retry_continue') {
      ctx.note?.('connexion coupée avec France Student : je me rattache à la réponse en cours');
      let last = e.lastEventId ?? null;
      for (const ms of ctx.delays || [1000, 3000, 8000]) {
        await wait(ms);
        try { return await ctx.resume(chatId, last); }
        catch (e2) { if (e2?.name === 'AbortError' || signal?.aborted) throw stop(); last = e2?.lastEventId ?? last; }
      }
    }
    const r = fromHistory((await chatState(chatId, ctx.fetchChat)).msgs, ctx);
    if (r) { ctx.note?.('réponse récupérée dans la conversation'); return r; }
    if (fromServer) throw e;
    throw Object.assign(new Error(LOST_MESSAGE), { status: e?.status, accepted: true, cause: e });
  }

  if (kind !== 'reconcile') throw e;

  // ── 409 / 400 avant acceptation ──
  if (!ctx.results?.length) {                                           // nouveau message : chat occupé (résumé, génération)
    for (const ms of ctx.busyDelays || [2000, 5000, 10000]) {
      ctx.note?.(`conversation occupée chez France Student : nouvel essai dans ${Math.round(ms / 1000)} s`);
      await wait(ms);
      try { return await ctx.resend({}); }
      catch (e2) { if ((await import('./gateway/recover.js')).errorKind(e2) !== 'reconcile') throw e2; }
    }
    throw Object.assign(new Error(BUSY_MESSAGE), { status: 409, cause: e });
  }
  const st = await chatState(chatId, ctx.fetchChat);
  if (st.state === 'pending') {
    const toolResults = alignResults(ctx.results, st.callIds);
    ctx.note?.(`résultats recalés sur les ${toolResults.length} action${toolResults.length > 1 ? 's' : ''} que France Student attend`);
    return ctx.resend({ toolResults });
  }
  if (st.state === 'orphan_user') {                                     // résultats déjà reçus, réponse en cours : on s'y rattache
    const lastUser = st.msgs.at(-1);
    const sent = new Set((ctx.results || []).map(r => String(r.callId)));
    const theirs = (Array.isArray(lastUser?.toolResults) ? lastUser.toolResults : []).map(callIdOf);
    if (theirs.length && theirs.every(id => sent.has(id))) {
      ctx.note?.('résultats déjà reçus par France Student : je me rattache à la réponse');
      try { return await ctx.resume(chatId, null); } catch (e2) { if (e2?.name === 'AbortError' || signal?.aborted) throw stop(); }
    }
  }
  if (st.state === 'idle') {                                            // résultats déjà reçus ET réponse finie (envoi précédent perdu en route)
    const i = st.msgs.length - 2, prev = st.msgs[i];
    const sent = new Set((ctx.results || []).map(r => String(r.callId)));
    const theirs = (Array.isArray(prev?.toolResults) ? prev.toolResults : []).map(callIdOf);
    if (prev?.role === 'user' && theirs.length && theirs.every(id => sent.has(id))) {
      const r = fromHistory(st.msgs, { ...ctx, userMessageId: () => null });
      if (r) { ctx.note?.('réponse récupérée dans la conversation'); return r; }
    }
  }
  throw e;
}
