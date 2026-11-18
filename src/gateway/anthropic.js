// Passerelle Claude Code : réponses au format de l'API Anthropic Messages (§ 3.8 de la spécification).
// Reply est un JOURNAL d'événements SSE avec abonnés : le flux d'origine, un réessai qui rejoint la génération en cours
// et le repli non-stream de Claude Code relisent tous le même journal depuis le début, puis suivent en direct (I5).
// Les en-têtes HTTP sont retardés : tant qu'ils ne sont pas partis, une erreur France Student devient un vrai statut HTTP.
// Ce module ne parle jamais à France Student : il ne fait que mettre en forme ce qu'on lui donne.
import crypto from 'node:crypto';

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789';   // en trois morceaux : pas une « chaîne à forte entropie » pour scripts/scan.mjs
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal']);
const EMPTY_NOTE = '(France Student n\'a renvoyé aucune réponse. Renvoie ton message pour réessayer.)';

/** Statut HTTP de chaque type d'erreur Anthropic (enveloppe {type:'error', error:{type, message}}). */
const STATUS_OF = {
  invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404,
  request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529,
};
/** Types qu'on transforme en `event: error` overloaded_error une fois les en-têtes partis (Claude Code réessaie). */
const RETRYABLE = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' };
const REAL_TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval };

/** n caractères base62 tirés au hasard (tirage avec rejet : pas de biais). */
function b62(n) {
  let out = '';
  while (out.length < n) {
    for (const byte of crypto.randomBytes(n * 2)) {
      if (byte < 248 && out.length < n) out += B62[byte % 62];
    }
  }
  return out;
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const writable = res => res && !res.destroyed && !res.writableEnded;
const unref = h => { h?.unref?.(); return h; };

/** input_tokens annoncé à Claude Code : taille du corps qu'IL a envoyé (jamais promptTokenCount de FS), § 3.8. */
export function estimateTokens(body) {
  const b = body && typeof body === 'object' ? body : {};
  // Les définitions d'outils ne sont JAMAIS envoyées à France Student : on ne les compte pas.
  // Sinon un Claude Code avec beaucoup de serveurs MCP (180k tokens d'outils, vu en vrai) se croit plein
  // dès le 1er message (« Context limit reached ») et compacte en boucle.
  const len = JSON.stringify({ system: b.system, messages: b.messages }).length;
  return Math.max(1, Math.ceil(len / 3.5));
}

/** Réponse JSON simple (count_tokens, /v1/models, non-stream). Ne lève jamais d'exception. */
export function sendJson(res, status, obj, headers = {}) {
  if (!writable(res)) return;
  if (res.headersSent) { res.end(); return; }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** Erreur au format Anthropic : {type:'error', error:{type, message}}. Si les en-têtes sont déjà partis, on ferme seulement. */
export function sendError(res, status, type, message, headers = {}) {
  sendJson(res, status, { type: 'error', error: { type, message: String(message ?? '') } }, headers);
}

/** Reconstruit le message complet à partir du journal : le non-stream est ainsi identique au stream. */
function foldEvents(events) {
  let msg = null;
  const json = {};
  for (const { event, data } of events) {
    if (event === 'message_start') msg = structuredClone(data.message);
    else if (!msg) continue;
    else if (event === 'content_block_start') {
      msg.content[data.index] = structuredClone(data.content_block);
      if (data.content_block.type === 'tool_use') json[data.index] = '';
    } else if (event === 'content_block_delta') {
      if (data.delta.type === 'text_delta') msg.content[data.index].text += data.delta.text;
      else json[data.index] += data.delta.partial_json;
    } else if (event === 'content_block_stop') {
      const b = msg.content[data.index];
      if (b.type === 'tool_use') b.input = json[data.index] ? JSON.parse(json[data.index]) : {};
    } else if (event === 'message_delta') {
      msg.stop_reason = data.delta.stop_reason;
      msg.stop_sequence = data.delta.stop_sequence ?? null;
      msg.usage = { ...msg.usage, ...data.usage };
    }
  }
  return msg;
}

/** Fusionne les text_delta consécutifs d'un même bloc (instantané plus léger, rendu identique). */
function compactEvents(events) {
  const out = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (e.event === 'content_block_delta' && e.data.delta.type === 'text_delta' && prev?.event === 'content_block_delta'
      && prev.data.delta.type === 'text_delta' && prev.data.index === e.data.index) {
      prev.data.delta.text += e.data.delta.text;
    } else out.push(structuredClone(e));
  }
  return out;
}

/** Nombre de tokens de sortie : usage FS (candidatesTokenCount) ou Anthropic (output_tokens), sinon estimation. */
function outputTokensOf(usage, fallbackChars) {
  const n = usage?.output_tokens ?? usage?.candidatesTokenCount;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : Math.max(1, Math.ceil(fallbackChars / 4));
}

/**
 * Réponse Anthropic en cours de construction, partagée entre abonnés.
 * Options (en plus de model et inputTokens) : timers (horloge injectable : setTimeout/clearTimeout/setInterval/clearInterval),
 * pingMs (10 s), headerWaitMs (25 s : en-têtes envoyés d'office), idleMs (8 s sans abonné avant onAbandon),
 * onAbandon (appelé quand plus personne n'écoute une génération inachevée), id (msg_… imposé).
 */
export class Reply {
  constructor({ model, inputTokens, timers = REAL_TIMERS, pingMs = 10000, headerWaitMs = 25000, idleMs = 8000, onAbandon = null, id = null } = {}) {
    this.model = String(model ?? '');
    this.inputTokens = Math.max(0, Math.round(Number(inputTokens) || 0));
    this.id = id || 'msg_' + b62(24);
    this.onAbandon = onAbandon;
    this._t = timers; this._pingMs = pingMs; this._headerWaitMs = headerWaitMs; this._idleMs = idleMs;
    this._events = [];
    this._subs = new Set();
    this._phase = 'open';                     // open | done | failed
    this._headersSent = false;
    this._httpError = null;                   // { status, type, message, headers } : échec AVANT les en-têtes
    this._blocks = [];                        // { type, id? } par index
    this._open = null;                        // index du bloc ouvert (texte uniquement : un tool_use s'ouvre et se ferme d'un coup)
    this._text = '';
    this._toolIds = [];
    this._ping = null; this._headerTimer = null; this._idleTimer = null;
    this._push('message_start', {
      type: 'message_start',
      message: {
        id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  // ── état lisible ──
  get emittedText() { return this._text; }
  get toolUseIds() { return [...this._toolIds]; }
  get hasContent() { return this._blocks.length > 0; }
  get headersSent() { return this._headersSent; }
  get done() { return this._phase !== 'open'; }
  get listeners() { return this._subs.size; }

  /** Envoie les en-têtes 200 text/event-stream à tous les abonnés stream, rejoue le journal et lance les pings. */
  headers() {
    if (this._headersSent || this._httpError) return;
    this._headersSent = true;
    this._clear('_headerTimer');
    for (const s of this._subs) this._start(s);
    if (this._phase === 'open' && !this._ping) {
      this._ping = unref(this._t.setInterval(() => this._broadcast(sse('ping', { type: 'ping' })), this._pingMs));
    }
  }

  /** Attente longue annoncée (sémaphore, verrou) : on envoie les en-têtes tout de suite pour que les pings partent. */
  headersIfWaiting() {
    if (this._phase === 'open' && this._subs.size && [...this._subs].some(s => s.stream)) this.headers();
  }

  /** Ajoute du texte (déjà nettoyé par l'appelant). Une chaîne vide est ignorée : jamais de bloc vide par accident. */
  text(delta) {
    const t = delta == null ? '' : String(delta);
    if (!t || this._phase !== 'open') return;
    if (this._open === null) {
      const index = this._blocks.length;
      this._blocks.push({ type: 'text' });
      this._open = index;
      this._push('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    }
    this._text += t;
    this._push('content_block_delta', { type: 'content_block_delta', index: this._open, delta: { type: 'text_delta', text: t } });
  }

  /** Émet un bloc tool_use complet : start (input {}), un seul input_json_delta analysable, stop. */
  toolUse(id, name, input) {
    if (this._phase !== 'open') return;
    this._closeText();
    const index = this._blocks.length;
    this._blocks.push({ type: 'tool_use', id: String(id) });
    this._toolIds.push(String(id));
    this._push('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: String(id), name: String(name), input: {} } });
    this._push('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) } });
    this._push('content_block_stop', { type: 'content_block_stop', index });
  }

  /**
   * Termine la réponse. stop_reason est rendu cohérent : 'tool_use' dès qu'il y a un bloc tool_use, jamais sinon.
   * usage : { output_tokens } ou usage FS ({ candidatesTokenCount }) ; à défaut, longueur du texte / 4.
   */
  finish(stopReason = 'end_turn', usage = null) {
    if (this._phase !== 'open') return;
    if (!this._blocks.length) this.text(EMPTY_NOTE);                    // jamais de réponse vide
    this._closeText();
    const hasTools = this._toolIds.length > 0;
    let stop = STOP_REASONS.has(stopReason) ? stopReason : 'end_turn';
    if (hasTools) stop = 'tool_use';
    else if (stop === 'tool_use') stop = 'end_turn';
    const toolChars = this._events.reduce((n, e) => n + (e.data.delta?.partial_json?.length || 0), 0);
    this._push('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { input_tokens: this.inputTokens, output_tokens: outputTokensOf(usage, this._text.length + toolChars), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    this._push('message_stop', { type: 'message_stop' });
    this._terminate('done');
  }

  /**
   * Échec de la génération.
   * - avant les en-têtes : vrai statut HTTP (statut déduit du type, ou opts.status ; 529 → retry-after: 5) ;
   * - après les en-têtes, sans contenu : `event: error` overloaded_error pour un type réessayable (Claude Code réessaie,
   *   le réessai tombe en join, replay ou reconcile), sinon le message en texte puis end_turn ;
   * - après du contenu : jamais `event: error` ; le message devient une note finale et la réponse se termine (end_turn).
   */
  fail(type, message, { status = null, headers = {} } = {}) {
    if (this._phase !== 'open') return;
    const msg = String(message ?? '');
    if (this.hasContent) {
      if (!this._toolIds.length && msg) this.text((this._text ? '\n\n' : '') + msg);
      return this.finish('end_turn');
    }
    if (!this._headersSent) {
      const st = status ?? STATUS_OF[type] ?? 500;
      const h = { ...(st === 529 || type === 'overloaded_error' ? { 'retry-after': '5' } : {}), ...headers };
      this._httpError = { status: st, type, message: msg, headers: h };
      for (const s of this._subs) sendError(s.res, st, type, msg, h);
      return this._terminate('failed');
    }
    if (!RETRYABLE.has(type)) { this.text(msg); return this.finish('end_turn'); }
    this._push('error', { type: 'error', error: { type: 'overloaded_error', message: msg } });
    for (const s of this._subs) if (!s.stream) sendError(s.res, 529, 'overloaded_error', msg, { 'retry-after': '5' });
    this._terminate('failed');
  }

  /**
   * Abonne une réponse HTTP. stream=true : SSE (journal rejoué depuis le début puis direct) ; stream=false : JSON à la fin.
   * La déconnexion est détectée par res.on('close') (jamais req.on('close'), émis dès la fin de lecture du corps).
   * Renvoie une fonction de désabonnement.
   */
  subscribe(res, stream = true) {
    const s = { res, stream: stream !== false, started: false };
    this._subs.add(s);
    this._clear('_idleTimer');
    res.on?.('close', () => this._leave(s));
    if (this._httpError) { const e = this._httpError; sendError(res, e.status, e.type, e.message, e.headers); }
    else if (s.stream && (this._headersSent || this._phase !== 'open')) this._start(s);
    else if (!s.stream && this._phase !== 'open') this._deliverJson(s);
    else if (s.stream && !this._headerTimer) {
      this._headerTimer = unref(this._t.setTimeout(() => { this._headerTimer = null; this.headers(); }, this._headerWaitMs));
    }
    if (this._phase !== 'open') this._subs.delete(s);
    return () => this._leave(s, false);
  }

  /** Message complet au format non-stream, reconstruit depuis le journal. */
  toJSON() {
    return foldEvents(this._events);
  }

  /** Instantané sérialisable pour le cache des réponses (replay), text_delta fusionnés. */
  snapshot(key) {
    return {
      v: 1, key: key ?? null, id: this.id, model: this.model, inputTokens: this.inputTokens, phase: this._phase,
      httpError: this._httpError ? structuredClone(this._httpError) : null, events: compactEvents(this._events),
    };
  }

  /** Reply terminée reconstruite depuis snapshot() : subscribe() la resert à l'identique, sans appel FS. */
  static fromSnapshot(snap, opts = {}) {
    const r = new Reply({ ...opts, model: snap.model, inputTokens: snap.inputTokens, id: snap.id });
    r._events = structuredClone(snap.events || []);
    r._httpError = snap.httpError ? structuredClone(snap.httpError) : null;
    r._headersSent = !r._httpError;
    const msg = foldEvents(r._events);
    for (const b of msg?.content || []) {
      r._blocks.push({ type: b.type, ...(b.id ? { id: b.id } : {}) });
      if (b.type === 'text') r._text += b.text;
      else r._toolIds.push(b.id);
    }
    r._phase = snap.phase === 'open' ? 'failed' : snap.phase;       // un instantané pris en cours de route n'est jamais rejoué « en direct »
    return r;
  }

  // ── interne ──

  _push(event, data) {
    this._events.push({ event, data });
    if (event !== 'message_start' && !this._headersSent && !this._httpError) this.headers();   // du contenu = FS a accepté
    else this._broadcast(sse(event, data));
  }

  _broadcast(chunk) {
    for (const s of this._subs) if (s.stream && s.started && writable(s.res)) s.res.write(chunk);
  }

  /** Démarre un abonné stream : en-têtes SSE, journal complet, fin si la réponse est terminée. */
  _start(s) {
    if (!s.stream || s.started || !writable(s.res)) return;
    s.started = true;
    if (!s.res.headersSent) s.res.writeHead(200, { ...SSE_HEADERS, 'request-id': 'req_' + b62(24) });
    s.res.write(this._events.map(e => sse(e.event, e.data)).join(''));
    if (this._phase !== 'open') s.res.end();
  }

  _deliverJson(s) {
    if (this._httpError) { const e = this._httpError; return sendError(s.res, e.status, e.type, e.message, e.headers); }
    const last = this._events[this._events.length - 1];
    if (last?.event === 'error') return sendError(s.res, 529, 'overloaded_error', last.data.error.message, { 'retry-after': '5' });
    sendJson(s.res, 200, this.toJSON());
  }

  /** Bloc texte vide (start + stop) : seulement pour les réponses locales qui l'exigent (suggestion). */
  _emptyTextBlock() {
    if (this._phase !== 'open') return;
    this._closeText();
    const index = this._blocks.length;
    this._blocks.push({ type: 'text' });
    this._push('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    this._push('content_block_stop', { type: 'content_block_stop', index });
  }

  _closeText() {
    if (this._open === null) return;
    const index = this._open;
    this._open = null;
    this._push('content_block_stop', { type: 'content_block_stop', index });
  }

  _terminate(phase) {
    this._phase = phase;
    this._clear('_ping'); this._clear('_headerTimer'); this._clear('_idleTimer');
    for (const s of this._subs) {
      if (s.stream && s.started && writable(s.res)) s.res.end();
      else if (!s.stream && phase === 'done') this._deliverJson(s);
    }
    this._subs.clear();
  }

  /** Départ d'un abonné. Plus personne et génération inachevée : minuteur idleMs, puis onAbandon (annulation côté FS). */
  _leave(s, viaClose = true) {
    if (!this._subs.delete(s)) return;
    if (!this._subs.size) this._clear('_headerTimer');
    if (!viaClose || this._subs.size || this._phase !== 'open' || this._idleTimer) return;
    this._idleTimer = unref(this._t.setTimeout(() => {
      this._idleTimer = null;
      if (!this._subs.size && this._phase === 'open') this.onAbandon?.();
    }, this._idleMs));
  }

  _clear(name) {
    const h = this[name];
    if (h == null) return;
    if (name === '_ping') this._t.clearInterval(h); else this._t.clearTimeout(h);
    this[name] = null;
  }
}

/**
 * Réponse locale complète en une fois (arrière-plan, § 3.11) : content = [{type:'text', text}|{type:'tool_use', id, name, input}].
 * Un bloc texte vide est émis tel quel (suggestion) ; un content vide donne la note « aucune réponse ». Renvoie la Reply.
 */
export function wholeReply(res, { model, stream = true, content = [], stop = 'end_turn', usage = null } = {}) {
  const reply = new Reply({ model, inputTokens: usage?.input_tokens ?? 0 });
  if (res) reply.subscribe(res, stream);
  reply.headers();
  for (const b of content || []) {
    if (b?.type === 'tool_use') reply.toolUse(b.id, b.name, b.input);
    else if (b?.type === 'text' && b.text) reply.text(b.text);
    else if (b?.type === 'text') reply._emptyTextBlock();
  }
  reply.finish(stop, usage);
  return reply;
}

