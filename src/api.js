import path from 'node:path';
import fs from 'node:fs';
// Client API France Student AI (SSE)
import https from 'node:https';
import { TOKEN, VERSION, cfg, saveCfg, saveCfgKeys } from './config.js';
import { register as registerChat, localTime } from './chats.js';

const HOST = 'api.francestudent.org';                       // adresse utilisée par le site officiel (l'ancienne, .ai, répond parfois en 30 s)
// Identification honnête (pas de faux navigateur) ; le token ne part que vers api.francestudent.org en HTTPS
const baseHeaders = () => ({
  'Authorization': `Bearer ${TOKEN}`,
  'User-Agent': `fs-cli/${VERSION} (client communautaire non officiel)`,
});

export class ApiError extends Error {
  constructor(msg, { status, retry = false } = {}) { super(msg); this.status = status; this.retry = retry; }
}

/** Erreur de France Student qui bloque toute la conversation : un ANCIEN message de l'historique (souvent un résultat de recherche web
 *  ou une réflexion signée) est refusé par le modèle à chaque nouvel envoi, ex. « messages.11.content.0: Invalid `encrypted_content`
 *  in `search_result` block ». Rien à corriger de notre côté : on ne peut que repartir d'une nouvelle conversation. */
export const isBrokenHistory = e => /Invalid\s+`?(?:encrypted_content|signature)`?\s+in\s+`?(?:search_result|web_search_tool_result|thinking|redacted_thinking)|messages\.\d+\.content\.\d+:\s*Invalid/i.test(String(e?.message || e || ''));

/** Conversation verrouillée par France Student après un signalement du filtre de sécurité du fournisseur du modèle
 *  (« This conversation was flagged by the AI provider and has been locked… ») : elle ne peut plus être utilisée. */
export const isLockedChat = e => /flagged by the AI provider|has been locked|conversation (?:a été |est )?verrouill/i.test(String(e?.message || e || ''));

/** corps d'une réponse 429 « Daily new chat limit… » → erreur claire (sans nouvel essai), sinon null */
export function parseDailyLimit(body) {
  if (!/Daily new chat limit/i.test(body || '')) return null;
  let resetAt = '';
  try { resetAt = JSON.parse(body).message.match(/Reset at (\S+?)\.?$/)?.[1] || ''; } catch {}
  const e = new ApiError(`Limite de 50 nouvelles conversations par jour atteinte${resetAt ? ` — remise à zéro ${localTime(resetAt)}` : ''}. ` +
    'Tu peux continuer dans une conversation existante (/history <n°> ou /resume).', { status: 429, retry: false });
  e.code = 'DAILY_CHAT_LIMIT'; e.resetAt = resetAt;
  return e;
}

/** Outils client officiels de FS (mode « avancé ») : appels exécutés sur la machine de l'utilisateur */
export const CLIENT_TOOLS = ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file', 'run_command'];

/** Envoie un fichier (image…) sur Files v2 ; renvoie son id, à mettre dans `files` d'un message. */
export async function uploadFile(buffer, filename, mime = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), String(filename || 'fichier').replace(/[\r\n"\\/]/g, '_').slice(0, 200));
  const r = await fetch(`https://${HOST}/filesv2`, { method: 'POST', headers: { ...baseHeaders(), Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(120000), redirect: 'error' });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new ApiError(`Envoi de ${filename} impossible (HTTP ${r.status}${j?.message ? ' : ' + String(j.message).slice(0, 200) : ''})`, { status: r.status });
  const id = j?.id ?? j?.file_id ?? j?.uuid;
  if (!id) throw new ApiError(`Envoi de ${filename} : réponse sans identifiant`);
  return String(id);
}

/**
 * Un bloc SSE (lignes entre deux lignes vides) → { id, event, data }. Règles du format Server-Sent Events :
 * commentaires « : » ignorés (ex. « : keepalive »), une espace après « champ: » retirée, lignes data jointes par \n.
 * id : null si absent · event : '' si absent · data : null si aucune ligne data.
 */
export function parseSseBlock(block) {
  let id = null, event = '', data = null;
  for (const raw of String(block ?? '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (!l || l.startsWith(':')) continue;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data = data === null ? value : `${data}\n${value}`;
    else if (field === 'event') event = value.trim();
    else if (field === 'id' && !value.includes('\0')) id = value.trim();
  }
  return { id, event, data };
}

/** appel d'un rappel de l'appelant qui ne doit jamais casser la lecture du flux */
const safely = (fn, ...a) => { try { fn?.(...a); } catch {} };

/**
 * Lecteur du flux SSE d'un tour France Student, sans réseau (partagé par once et resumeStream, testable seul).
 * h : onEvent(type, d), onText(delta, stop), onReasoning, onChat, onEventId(id) (lignes « id: »), onUserMessageId (response.created),
 *     onFirstChat(chatId) (1er chat_id vu), onStop(partiel) (l'appelant a demandé l'arrêt avec stop()).
 * → { push(morceau), end(), result() (FsResult, ou lève une ApiError), chatId, lastEventId, userMessageId, stopped }
 */
export function createSseReader(h = {}, { chatId = null } = {}) {
  let buf = '', text = '', usage = null, toolCalls = [], images = [], documents = [];
  let sawImage = false, sawCompleted = false, cancelled = false, stopped = false, opened = false, streamError = null;
  let seenChatId = chatId || null, lastEventId = null, userMessageId = null;
  const stop = () => {
    if (stopped) return;
    stopped = true; h.onStop?.({ text, usage, stopped: true });
  };
  function handle(block) {
    if (stopped) return;
    const { id, event, data } = parseSseBlock(block);
    if (id) { lastEventId = id; safely(h.onEventId, id); }             // reprise possible à partir de cet événement (Last-Event-ID)
    if (!data || data === '[DONE]') return;
    let d; try { d = JSON.parse(data); } catch { return; }
    if (!d || typeof d !== 'object') return;
    const type = d.type || event;
    safely(h.onEvent, type, d);                                         // activité en direct (recherche web, outils du site…)
    if (/image_?generation/i.test(type) || d.item?.type === 'image_generation_call') sawImage = true;   // image générée côté serveur
    if (d.chat_id) {
      seenChatId = d.chat_id;
      if (!opened) { opened = true; h.onFirstChat?.(d.chat_id); }
      h.onChat?.(d.chat_id);
    }
    if (type === 'response.created') {                                  // message de l'utilisateur enregistré par France Student
      const mid = d.user_message_id ?? d.userMessageId;
      if (mid != null && mid !== '') { userMessageId = String(mid); safely(h.onUserMessageId, userMessageId); }
    }
    if (type === 'response.output_text.delta' && typeof d.delta === 'string') {
      text += d.delta;
      h.onText?.(d.delta, stop);
    } else if (type === 'response.reasoning_summary_text.delta' && typeof d.delta === 'string') {
      h.onReasoning?.(d.delta);
    } else if (type === 'completed') {
      sawCompleted = true;
      usage = d.message?.tokenUsage || null;
      if (Array.isArray(d.message?.toolCalls)) toolCalls = d.message.toolCalls;      // seule source de vérité des appels à exécuter
      if (Array.isArray(d.message?.parts)) { images = imagesOf(d.message.parts); documents = documentsOf(d.message.parts); }
    } else if (type === 'cancelled') {
      cancelled = true;
    } else if (type === 'error' || type === 'response.failed' || type === 'response.error') {
      streamError = {
        message: d.message || d.error?.message || d.error || JSON.stringify(d).slice(0, 200),
        code: d.code || d.error?.code, retryable: d.retryable, chatFlagged: d.chat_flagged, accountDisabled: d.account_disabled,
      };
    }
  }
  return {
    push(chunk) {
      buf += chunk;
      if (buf.includes('\r')) buf = buf.replace(/\r\n|\r(?!$)/g, '\n');   // CRLF ou CR seul ; un CR final attend le morceau suivant
      let i;
      while (!stopped && (i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); handle(b); }
    },
    end() {
      if (buf.trim()) handle(buf.replace(/\r$/, ''));
      buf = '';
    },
    result() {
      if (streamError) {
        const e = new ApiError(`Erreur du serveur: ${streamError.message}`);
        for (const k of ['code', 'retryable', 'chatFlagged', 'accountDisabled']) if (streamError[k] !== undefined) e[k] = streamError[k];
        e.serverError = true;                                           // rendue par le serveur (pas une coupure réseau)
        throw e;
      }
      if (!sawCompleted && !text) {
        const e = new ApiError('Réponse vide / flux interrompu');
        if (cancelled) e.code = 'CANCELLED';
        throw e;
      }
      return { text, usage, toolCalls, stopped: false, images, documents, sawImage: sawImage || images.length > 0, chatId: seenChatId, completed: sawCompleted };
    },
    get chatId() { return seenChatId; },
    get lastEventId() { return lastEventId; },
    get userMessageId() { return userMessageId; },
    get stopped() { return stopped; },
  };
}

/** corps et route d'un envoi : nouveau chat → POST /chats/stream (initialContent + clientTools) ;
 *  chat existant en mode outils client → POST /chats/{id} (content + clientTools / toolResults) ; mode texte → POST /chats/stream avec chatId */
function chatRequest({ agentId, chatId, content, webSearch, clientTools, toolResults, files }) {
  const native = !!(clientTools || toolResults);
  if (native && chatId) {
    return {
      native, urlPath: `/chats/${encodeURIComponent(chatId)}`,
      body: { agentId, ...(content ? { content } : {}), ...(files?.length ? { files } : {}), ...(clientTools ? { clientTools } : {}), ...(toolResults ? { toolResults } : {}), ...(webSearch ? { enableWebSearch: true } : {}) },
    };
  }
  return {
    native, urlPath: '/chats/stream',
    body: {
      agentId, chatId: chatId || null, enableCanvas: false, enableWebSearch: !!webSearch,
      images: [], files: files?.length ? files : [], initialContent: content, isIncognito: false, isPrivate: true,
      ...(clientTools ? { clientTools } : {}),
    },
  };
}

/** message lisible d'une réponse d'erreur JSON de l'API ({ message } ou { error: { message } }) ; '' si HTML ou illisible */
export function serverMessage(b) {
  try {
    const j = JSON.parse(b || '');
    const m = j?.message || j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.detail || '';
    return String(m).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch { return ''; }
}

/** réponse HTTP ≥ 300 d'un flux → ApiError claire (status, code, body) */
function httpError(st, b, { native = false } = {}) {
  // limite quotidienne de nouvelles conversations : inutile de réessayer, on explique
  const daily = st === 429 ? parseDailyLimit(b) : null;
  if (daily) { try { saveCfgKeys({ dailyLimitHitAt: Date.now() }); } catch {} return daily; }
  // page HTML (pare-feu, Cloudflare, proxy) : un 403 passager, pas le drapeau des outils client
  const firewall = st === 403 && (/^\s*</.test(b || '') || /cloudflare|cf-ray|attention required|just a moment/i.test(b || ''));
  if (native && !firewall && (st === 403 || (st === 400 && /Client tools are not supported/i.test(b)))) {       // flag désactivé ou modèle sans outils client (ex. Gemini)
    const e = new ApiError(st === 403 ? 'Le mode « outils client » n\'est pas activé sur ce compte (403).' : 'Ce modèle ne gère pas les outils client (essaie un modèle Claude ou GPT avec /model).', { status: st });
    e.code = 'NATIVE_UNSUPPORTED';
    return e;
  }
  // 403 : une clé invalide ou absente donne 401 (vérifié le 19/11/2026) ; 403 = connecté mais refusé → on montre la raison du serveur
  const why = serverMessage(b);
  const msg = st === 401 ? '401 — clé de session expirée ou invalide : reconnecte-toi avec « fs-cli --login » dans un terminal'
    : st === 403 && firewall ? '403 — le pare-feu de France Student (Cloudflare) a bloqué la requête. Réessaie dans une minute ; si ça continue, ouvre francestudent.org dans ton navigateur ou change de réseau (VPN, partage 4G).'
    : st === 403 ? `403 — France Student refuse cette demande${why ? ` : « ${why} »` : ''}. Si ta session a changé (déconnexion, autre appareil), reconnecte-toi avec « fs-cli --login » ; sinon essaie un autre modèle (/model).`
    : st === 429 ? '429 — trop de requêtes, patiente quelques secondes'
    : `HTTP ${st}: ${b.slice(0, 200)}`;
  const e = new ApiError(msg, { status: st, retry: st === 429 || st >= 500 });
  e.body = b.slice(0, 2000);                                          // ex. 400 « missing: … » / « pending », 409 : lus par la passerelle Claude Code
  return e;
}

/**
 * Requête SSE vers France Student (POST d'un message ou GET de rattachement), lue par createSseReader.
 * Toutes les erreurs portent e.accepted : true dès que le serveur a répondu 2xx. Après un 2xx, jamais de nouvel essai
 * (retry: false) : le message est déjà enregistré, le renvoyer le dupliquerait. On se rattache alors avec resumeStream.
 */
function sseRequest({ urlPath, method, payload = null, chatId = null, h, native = false, onFirstChat, cancelOnAbort = true }) {
  return new Promise((resolve, reject) => {
    const { signal } = h;
    let accepted = false, settled = false, req = null;
    const finish = (fn, v) => { if (settled) return; settled = true; fn(v); };
    const reader = createSseReader({
      onEvent: h.onEvent, onText: h.onText, onReasoning: h.onReasoning, onChat: h.onChat,
      onEventId: h.onEventId, onUserMessageId: h.onUserMessageId, onFirstChat,
      onStop: partial => { finish(resolve, partial); req?.destroy(); },
    }, { chatId });
    const fail = e => {
      if (e && typeof e === 'object') {
        e.accepted = accepted;
        if (accepted && reader.chatId && e.chatId == null) e.chatId = reader.chatId;
        if (accepted && reader.lastEventId && e.lastEventId == null) e.lastEventId = reader.lastEventId;
      }
      finish(reject, e);
    };
    const onNetError = e => {
      if (settled || reader.stopped) return;
      if (signal?.aborted || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
        if (cancelOnAbort && reader.chatId) cancelStream(reader.chatId);   // Ctrl+C : on arrête aussi la génération côté serveur (sinon elle continue et consomme)
        return fail(Object.assign(new Error('annulé'), { name: 'AbortError' }));
      }
      fail(e instanceof ApiError ? e : new ApiError(`Réseau: ${e?.message || e}`, { retry: !accepted }));
    };
    const headers = { ...baseHeaders(), 'Accept': 'text/event-stream', ...h.headers };
    if (payload !== null) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });

    req = https.request({ hostname: HOST, path: urlPath, method, signal, headers }, (res) => {
      const st = res.statusCode || 0;
      if (st >= 300) {
        let b = ''; res.setEncoding('utf8');
        res.on('data', d => b += d);
        res.on('end', () => fail(httpError(st, b, { native })));
        res.on('error', onNetError);
        return;
      }
      accepted = true;                                                  // 2xx : le message est enregistré, ne plus jamais le renvoyer
      safely(h.onAccepted);
      res.setEncoding('utf8');
      res.on('data', chunk => reader.push(chunk));
      res.on('end', () => {
        reader.end();
        if (reader.stopped) return;
        try { finish(resolve, reader.result()); } catch (e) { fail(e); }
      });
      res.on('error', onNetError);
      res.on('close', () => { if (!res.complete) onNetError(new ApiError('Réseau: flux coupé avant la fin', { retry: false })); });
    });
    req.setTimeout(150_000, () => req.destroy(new ApiError('Délai dépassé (aucune donnée depuis 150 s)', { retry: !accepted })));
    req.on('error', onNetError);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function once(opts) {
  const { chatId, register } = opts;
  const { urlPath, body, native } = chatRequest(opts);
  return sseRequest({
    urlPath, method: 'POST', payload: JSON.stringify(body), chatId, h: opts, native,
    onFirstChat: id => {
      if (!chatId && register) registerChat(id, register);             // nouvelle conversation → registre
      if (!chatId) attachToFsProject(id);                                // et rangement dans le Projet FS du CLI
    },
  });
}

/**
 * Se rattache à la génération en cours (ou qui vient de finir) d'un chat : GET /chats/{id}/stream avec Last-Event-ID.
 * France Student rejoue les événements d'id supérieur puis continue en direct : text ne contient que la suite rejouée.
 * handlers : mêmes rappels que streamChat (signal, onText, onEventId, onAccepted…). Résultat : comme streamChat.
 * Une annulation (signal) n'arrête pas la génération côté serveur : c'est à l'appelant de décider (cancelStream).
 */
export function resumeStream(chatId, lastEventId = null, handlers = {}) {
  if (!chatId) return Promise.reject(Object.assign(new ApiError('resumeStream : chatId manquant'), { accepted: false }));
  const last = lastEventId == null ? '' : String(lastEventId).replace(/[^\x21-\x7e]/g, '');
  return sseRequest({
    urlPath: `/chats/${encodeURIComponent(chatId)}/stream`, method: 'GET', chatId, cancelOnAbort: false,
    h: { ...handlers, headers: last ? { 'Last-Event-ID': last } : {} },
  });
}

/** Envoie un message avec retry (uniquement si rien n'a encore été reçu). */
export async function streamChat(opts) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await once(opts); }
    catch (e) {
      lastErr = e;
      if (e.name === 'AbortError' || !e.retry || attempt === 2 || opts.signal?.aborted) throw e;
      await new Promise(r => setTimeout(r, [1500, 4000][attempt]));
    }
  }
  throw lastErr;
}

/** GET JSON authentifié ; renvoie null en cas d'erreur (jamais d'exception) */
export function getJson(p, timeout = 12000) {
  return new Promise(resolve => {
    const req = https.get({ hostname: HOST, path: p, headers: baseHeaders() }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => { try { resolve(res.statusCode < 300 ? JSON.parse(d) : null); } catch { resolve(null); } });
      res.on('error', () => resolve(null)); res.on('close', () => { if (!res.complete) resolve(null); });   // coupure en pleine réponse
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

/** Requête JSON authentifiée → { status, data } ; ne lève jamais (status 0 = réseau). */
export function requestJson(method, p, body, timeout = 15000) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: HOST, path: p, method,
      headers: { ...baseHeaders(), Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => { let data = null; try { data = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode || 0, data }); });
      res.on('error', () => resolve({ status: 0, data: null })); res.on('close', () => { if (!res.complete) resolve({ status: 0, data: null }); });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, data: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Conversations dont le titre ou le contenu contient query (GET /chats/search) → [{ id, title, … }] ; [] en cas d'échec (jamais d'exception). */
export async function searchChats(query, limit = 10) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const n = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));
  try {
    const r = await requestJson('GET', `/chats/search?query=${encodeURIComponent(q)}&limit=${n}`);
    if (r.status < 200 || r.status >= 300) return [];
    const arr = Array.isArray(r.data) ? r.data : (r.data?.chats || r.data?.data);
    return Array.isArray(arr) ? arr.filter(c => c && typeof c === 'object') : [];
  } catch { return []; }
}

/** Fait résumer l'historique d'un chat par le fournisseur (POST /chats/{id}/context) → { status, data } ; jamais d'exception.
 *  status 409 : génération en cours ou chat vide · 422 : le modèle ne le permet pas · 0 : réseau. */
export async function compactChat(chatId) {
  if (!chatId) return { status: 0, data: null };
  try { return await requestJson('POST', `/chats/${encodeURIComponent(chatId)}/context`, undefined, 120000); }
  catch { return { status: 0, data: null }; }
}

/** Liste complète des agents (ModelDto : id, name, model, namespace, modelProvider, contextWindow, isActive…) de GET /chats/agents.
 *  Accepte un tableau ou { data } / { agents } ; null si indisponible (jamais d'exception). Les agents inactifs sont gardés. */
export async function fetchAgentsFull() {
  try {
    const r = await requestJson('GET', '/chats/agents');
    if (r.status < 200 || r.status >= 300) return null;
    const arr = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.agents);
    return Array.isArray(arr) ? arr.filter(a => a && typeof a === 'object') : null;
  } catch { return null; }
}

/** Arrête la génération en cours côté serveur (POST /chats/{id}/stream/cancel, idempotent). */
export async function cancelStream(chatId) {
  if (!chatId) return false;
  const r = await requestJson('POST', `/chats/${encodeURIComponent(chatId)}/stream/cancel`, undefined, 10000);
  return r.status >= 200 && r.status < 300;
}

// ── Projets France Student : les conversations du CLI sont rangées dans un projet (barre latérale du site) ──
export async function listFsProjects() {
  const r = await requestJson('GET', '/projects');
  return Array.isArray(r.data) ? r.data : [];
}
/** Projet par nom (sans tenir compte de la casse), créé s'il n'existe pas. */
export async function findOrCreateFsProject(name) {
  const clean = String(name || '').trim().slice(0, 255);
  if (!clean) throw new Error('nom de projet vide');
  const want = clean.toLocaleLowerCase('fr-FR');
  const found = (await listFsProjects()).find(p => String(p?.name || '').trim().toLocaleLowerCase('fr-FR') === want);
  if (found) return { project: found, created: false };
  const r = await requestJson('POST', '/projects', { name: clean });
  if (!r.data?.id) throw new Error(`création du projet refusée (HTTP ${r.status})`);
  return { project: r.data, created: true };
}
/** Renomme une conversation sur France Student (PATCH /chats/{id}, comme le site). */
export async function renameChat(chatId, title) {
  const t = String(title || '').trim().slice(0, 120);
  if (!chatId || !t) return false;
  const r = await requestJson('PATCH', `/chats/${encodeURIComponent(chatId)}`, { title: t });
  return r.status >= 200 && r.status < 300;
}
/** Range une conversation dans un projet (PUT /projects/{p}/chats/{c}). */
export async function attachChatToProject(projectId, chatId) {
  const r = await requestJson('PUT', `/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`);
  return r.status >= 200 && r.status < 300;
}
/** sort une conversation de son projet (elle redevient une conversation normale) : DELETE /projects/{p}/chats/{c} → 204 */
export async function detachChatFromProject(projectId, chatId) {
  const r = await requestJson('DELETE', `/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`);
  return r.status >= 200 && r.status < 300;
}
/** conversations d'un projet (toutes les pages) → [{ id, title, … }] ; null si illisible */
export async function projectChats(projectId) {
  const out = [];
  for (let page = 0, before = ''; page < 20; page++) {
    const r = await requestJson('GET', `/projects/${encodeURIComponent(projectId)}/chats?limit=50${before ? '&before=' + encodeURIComponent(before) : ''}`);
    if (r.status !== 200) return page ? out : null;
    const chats = r.data?.chats || [];
    const fresh = chats.filter(c => !out.some(o => o.id === c.id)); out.push(...fresh);
    if (!r.data?.hasMore || !fresh.length) break;
    before = chats.at(-1)?.id || '';
  }
  return out;
}
/**
 * Supprime un projet du site. ATTENTION (vérifié en vrai le 17/11/2026) : France Student ne déplace PAS les conversations du projet ;
 * elles deviennent inaccessibles pour toujours (404 « Project not found »). Donc, avant : chaque conversation est soit sortie du projet
 * (keep), soit supprimée (!keep), et vérifiée une par une ; s'il en reste une qui pointe encore vers le projet, rien n'est supprimé.
 * → { ok, kept, deleted, failed: [ids], reason }
 */
export async function deleteFsProjectSafely(projectId, { keep = true, chats = null, onProgress, settle = 2000 } = {}) {
  // La liste GET /projects/{p}/chats a ~1 s de retard (mesuré le 17/11/2026, dans les deux sens, sans cache contournable) :
  // une conversation rangée à l'instant n'y figure pas encore. Donc on relit TOUJOURS la liste après une pause avant de supprimer.
  const pause = () => (settle > 0 ? new Promise(r => setTimeout(r, settle)) : Promise.resolve());
  chats ||= await projectChats(projectId);
  if (!chats) return { ok: false, kept: 0, deleted: 0, failed: [], reason: 'liste des conversations du projet illisible' };
  chats = [...chats];
  let kept = 0, deleted = 0; const failed = [], done = new Set();
  const total = () => chats.length;
  let pending = 0;
  for (let pass = 0; pass < 4; pass++) {                              // jusqu'à ce qu'une relecture après pause ne montre plus rien de nouveau
    for (const ch of chats.filter(x => !done.has(x.id))) {
      done.add(ch.id); onProgress?.(done.size, total());
      if (keep) {
        await detachChatFromProject(projectId, ch.id);
        const r = await requestJson('GET', `/chats/${encodeURIComponent(ch.id)}`);
        if (r.status === 200 && r.data?.projectId !== projectId) kept++; else failed.push(ch.id);
      } else if (await deleteChat(ch.id)) deleted++; else failed.push(ch.id);
    }
    if (failed.length) break;
    await pause();
    const again = await projectChats(projectId);
    if (!again) return { ok: false, kept, deleted, failed, reason: 'liste des conversations du projet illisible' };
    const left = [];
    for (const ch of again) {                                         // déjà traitée mais encore listée : on demande à la conversation elle-même
      if (!done.has(ch.id)) { left.push(ch); continue; }
      const r = await requestJson('GET', `/chats/${encodeURIComponent(ch.id)}`);
      if (keep && r.status === 200 && r.data?.projectId === projectId) failed.push(ch.id);
    }
    pending = left.length;
    if (failed.length || !left.length) break;
    chats = [...chats, ...left];
  }
  if (pending && !failed.length) return { ok: false, kept, deleted, failed, reason: 'de nouvelles conversations apparaissent encore dans le projet : réessaie dans un instant' };
  if (failed.length) return { ok: false, kept, deleted, failed, reason: `${failed.length} conversation(s) n'ont pas pu être ${keep ? 'sorties du projet' : 'supprimées'}` };
  const r = await requestJson('DELETE', `/projects/${encodeURIComponent(projectId)}`);
  return { ok: r.status >= 200 && r.status < 300, kept, deleted, failed, reason: r.status >= 300 || !r.status ? `France Student a répondu ${r.status || 'sans réponse'}` : '' };
}

/** Rangement automatique : projet « FS-CLI » par défaut, /fr-project <nom> pour un autre, /fr-project off pour désactiver. Ne lève jamais. */
let projectPromise = null, projectOverride, projectOnce;
/** projet de la PROCHAINE conversation créée seulement (onglet « Projets » du panneau) : { id, name } · false = hors projet · undefined = réglage par défaut */
export function setProjectOnce(p) { projectOnce = p; }
/** serveur MCP : projet propre (undefined = comme FS-CLI · false = aucun · { id, name }) */
export function setProjectOverride(p) { projectOverride = p; projectPromise = null; }
/** projet où ira la prochaine conversation (choix ponctuel, sinon --projet, sinon le réglage /projet) ; false/undefined = hors projet. Ne consomme rien. */
export function effectiveProject() { return projectOnce !== undefined ? projectOnce : projectOverride !== undefined ? projectOverride : cfg.fsProject; }
function attachToFsProject(chatId) {
  if (projectOnce !== undefined) { const p = projectOnce; projectOnce = undefined; if (p?.id) attachChatToProject(p.id, chatId).catch?.(() => {}); return; }
  const proj = projectOverride !== undefined ? projectOverride : cfg.fsProject;
  if (!proj) return;                                                // pas de projet choisi : conversation normale, visible dans ta liste du site
  if (proj.id) { attachChatToProject(proj.id, chatId).catch?.(() => {}); return; }
  const name = proj.name || 'FS-CLI';
  if (!projectPromise || projectPromise.name !== name) {
    projectPromise = (cfg.fsProject?.id && cfg.fsProject.name === name ? Promise.resolve(cfg.fsProject.id)
      : findOrCreateFsProject(name).then(({ project }) => { cfg.fsProject = { id: project.id, name: project.name || name }; saveCfg(); return project.id; }))
      .catch(() => null);
    projectPromise.name = name;
  }
  projectPromise.then(id => { if (id) attachChatToProject(id, chatId); }).catch(() => {});
}

/** Supprime une conversation (DELETE /chats/{id}) ; true si le serveur accepte */
export function deleteChat(chatId) {
  return new Promise(resolve => {
    const req = https.request({ hostname: HOST, path: `/chats/${encodeURIComponent(chatId)}`, method: 'DELETE', headers: baseHeaders() }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode < 300));
      res.on('error', () => resolve(false)); res.on('close', () => { if (!res.complete) resolve(false); });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** images d'un message (parts « tool-imageGeneration ») → [{ url, contentType, ext, prompt }] */
export function imagesOf(parts) {
  return (parts || []).map(p => p?.output).filter(o => o && o.kind === 'image' && (o.contentUrl || o.url) && o.status !== 'FAILED')
    .map(o => ({ id: o.id || o.generationId, url: o.contentUrl || o.url, contentType: o.contentType || 'image/png', ext: o.fileExtension || 'png', prompt: o.revisedPrompt || '' }));
}
/**
 * Documents du « panneau de code » du site (outil serveur createDocument / updateDocument, apparu en novembre 2026) :
 * le modèle y met parfois un fichier au lieu d'appeler write_file → [{ id, title, kind, content, update }].
 * content = ce que le modèle a écrit (input), sinon le contenu renvoyé (output) ; null si inconnu (ex. mise à jour décrite seulement).
 */
export function documentsOf(parts) {
  return (parts || []).filter(p => /^tool-(create|update)Document$/i.test(String(p?.type || '')) && !/error/i.test(String(p.state || '')))
    .map(p => {
      const i = p.input || {}, o = p.output || {}, update = /update/i.test(p.type);
      const content = typeof i.content === 'string' ? i.content : (!update && typeof o.content === 'string' ? o.content : null);
      return { id: o.id || i.id || null, title: String(o.title || i.title || '').trim(), kind: String(o.kind || i.kind || ''), content, update };
    })
    .filter(d => d.title || d.content);
}
/** contenu ACTUEL d'un document du panneau du site (c'est un fichier Files v2 : GET /filesv2/{id}/content, vu dans le site) → texte */
export async function fetchDocumentContent(id) {
  if (!/^file-[\w-]+$/.test(String(id || ''))) throw new Error('identifiant de document inattendu');
  return (await fetchApiFile(`/filesv2/${id}/content`)).toString('utf8');
}
/** documents mis à jour (sans contenu dans la réponse) ou sans texte : leur version actuelle est lue sur le site */
export async function withDocumentContents(docs, read = fetchDocumentContent) {
  for (const d of docs || []) {
    if (!d.id || (!d.update && typeof d.content === 'string')) continue;
    try { d.content = await read(d.id); } catch {}
  }
  return docs || [];
}
/** images générées dans le dernier message de l'assistant (si le flux ne les a pas données) */
export async function lastMessageImages(chatId) {
  const d = await fetchChat(chatId).catch(() => null);
  const m = [...(d?.chatMessages || [])].reverse().find(x => x.role === 'assistant');
  return imagesOf(m?.parts);
}
/** contenu d'un fichier de l'API France Student (chemin /chats/…), en mémoire */
export async function fetchApiFile(apiPath) {
  if (!/^\/[\w\-./]+$/.test(apiPath)) throw new Error('adresse de fichier inattendue');
  const r = await fetch(`https://${HOST}${apiPath}`, { headers: { Authorization: baseHeaders().Authorization } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
/** télécharge un fichier de l'API France Student (chemin /chats/…) vers dest ; renvoie la taille */
export async function downloadApiFile(apiPath, dest) {
  if (!/^\/[\w\-./]+$/.test(apiPath)) throw new Error('adresse de fichier inattendue');
  const r = await fetch(`https://${HOST}${apiPath}`, { headers: { Authorization: baseHeaders().Authorization } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** Dernières conversations du compte */
export async function fetchChatsList(limit = 15) {
  const j = await getJson(`/chats?limit=${Math.min(50, Math.max(1, limit))}`);
  return Array.isArray(j) ? j : (j?.chats || []);
}

/** Conversation complète (messages + pièces « panneau » créées côté serveur) */
export function fetchChat(chatId) {
  return new Promise(resolve => {
    const req = https.get({ hostname: HOST, path: `/chats/${encodeURIComponent(chatId)}`, headers: baseHeaders() }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => { try { resolve(res.statusCode < 300 ? JSON.parse(d) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

/** Liste des agents/modèles disponibles ({id: name}) */
export function fetchAgents() {
  return new Promise(resolve => {
    const req = https.get({ hostname: HOST, path: '/chats/agents', headers: baseHeaders() }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const arr = Array.isArray(j) ? j : j.agents || [];
          const map = {};
          for (const a of arr) if (a.isActive !== false) map[String(a.id)] = a.name;
          resolve(Object.keys(map).length ? map : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}
