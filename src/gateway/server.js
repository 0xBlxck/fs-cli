// Passerelle Claude Code : couche HTTP (node:http), sécurité, routes et lecture du corps (§ 4.4 de la spécification).
// Sécurité, dans l'ordre : écoute sur 127.0.0.1 seulement, Origin présent → 403 (pages web), Host inattendu → 403
// (DNS rebinding), jeton comparé en temps constant (Bearer ou x-api-key) → sinon 401, corps ≤ 64 Mo → sinon 413,
// JSON invalide → 400, route inconnue → 404. HEAD / et GET / répondent 200 sans jeton (préchauffage de Claude Code).
// La logique métier (messages, modèles) est injectée par l'assemblage (index.js) via `handlers`.
import http from 'node:http';
import crypto from 'node:crypto';
import { sendError, sendJson, estimateTokens } from './anthropic.js';

export const MAX_BODY = 64 * 2 ** 20;
const BAD_TOKEN = 'Jeton de la passerelle FS-CLI invalide : relance avec fs-cli claude, ou recopie le jeton affiché par fs-cli gateway.';

const pathOf = req => {
  try { return new URL(String(req.url || '/'), 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'; }
  catch { return null; }
};

/** Route d'une requête : 'head' | 'messages' | 'count_tokens' | 'models' | 'notfound' (chaîne de requête ignorée). */
export function route(req) {
  const p = pathOf(req);
  const m = String(req.method || 'GET').toUpperCase();
  if (p === '/' && (m === 'HEAD' || m === 'GET')) return 'head';
  if (p === '/v1/messages' && m === 'POST') return 'messages';
  if (p === '/v1/messages/count_tokens' && m === 'POST') return 'count_tokens';
  if (p === '/v1/models' && m === 'GET') return 'models';
  return 'notfound';
}

/** Égalité en temps constant : on compare des empreintes SHA-256 (même longueur, la longueur du jeton ne fuit pas). */
function sameSecret(given, token) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(token)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Jetons présentés par le client : Authorization: Bearer … (ANTHROPIC_AUTH_TOKEN) et x-api-key (ANTHROPIC_API_KEY). */
function presented(headers) {
  const out = [];
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(String(headers.authorization || ''));
  if (m) out.push(m[1]);
  const k = headers['x-api-key'];
  if (typeof k === 'string' && k.trim()) out.push(k.trim());
  return out;
}

/**
 * Contrôle d'accès (§ 4.4). Renvoie null si la requête est admise, sinon { status, type, message } à renvoyer tel quel.
 * 401 n'est utilisé QUE pour un jeton de passerelle invalide (jamais pour une session France Student expirée).
 */
export function checkAuth(req, { token, port } = {}) {
  const h = req.headers || {};
  if (h.origin != null) return { status: 403, type: 'permission_error', message: 'Requête refusée : la passerelle FS-CLI n\'accepte pas les requêtes venant d\'une page web (en-tête Origin).' };
  const host = String(h.host || '').toLowerCase();
  if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
    return { status: 403, type: 'permission_error', message: 'Requête refusée : hôte inattendu (en-tête Host). Utilise http://127.0.0.1:<port>.' };
  }
  if (route(req) === 'head') return null;
  const ok = !!token && presented(h).some(t => sameSecret(t, token));
  return ok ? null : { status: 401, type: 'authentication_error', message: BAD_TOKEN };
}

const tooBig = max => Object.assign(new Error(`Requête trop volumineuse : ${Math.round(max / 2 ** 20)} Mo au plus.`), { status: 413, type: 'request_too_large' });

/** Lit le corps entier (Buffer). Rejette avec { status: 413 } au-delà de maxBytes, { status: 400 } si le client coupe. */
export function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { req.resume?.(); return reject(tooBig(maxBytes)); }
    const parts = [];
    let size = 0, settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      req.off?.('data', onData);
      if (err) { req.resume?.(); reject(err); } else resolve(val);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) return done(tooBig(maxBytes));
      parts.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => done(null, Buffer.concat(parts, size)));
    const cut = () => done(Object.assign(new Error('Corps de la requête interrompu.'), { status: 400, type: 'invalid_request_error' }));
    req.on('aborted', cut);
    req.on('close', cut);                    // après 'end', sans effet (déjà réglé)
    req.on('error', e => done(Object.assign(new Error(`Lecture du corps impossible : ${e.message}`), { status: 400, type: 'invalid_request_error' })));
  });
}

/** Analyse le corps JSON d'une requête POST : un objet est exigé. Lève { status: 400 } sinon. */
export function parseJsonBody(buf) {
  let body;
  try { body = JSON.parse(buf.length ? buf.toString('utf8') : ''); }
  catch { throw Object.assign(new Error('Corps JSON invalide.'), { status: 400, type: 'invalid_request_error' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Le corps de la requête doit être un objet JSON.'), { status: 400, type: 'invalid_request_error' });
  }
  return body;
}

/**
 * Traite une requête HTTP de bout en bout : contrôle d'accès, route, corps, puis le gestionnaire injecté.
 * handlers = { messages(req, res, body), models?(req, res), count_tokens?(req, res, body) } (fonctions éventuellement async).
 * Par défaut : count_tokens → { input_tokens: estimateTokens(body) }, models → liste vide. Ne lève jamais d'exception.
 */
export async function handleHttp(req, res, { token, port = null, handlers = {}, log = null, maxBytes = MAX_BODY } = {}) {
  try {
    const denied = checkAuth(req, { token, port: port ?? req.socket?.localPort });
    if (denied) return sendError(res, denied.status, denied.type, denied.message);
    const r = route(req);
    if (r === 'head') { res.writeHead(200, { 'content-length': 0 }); return void res.end(); }
    if (r === 'notfound') return sendError(res, 404, 'not_found_error', `Route inconnue de la passerelle FS-CLI : ${req.method} ${pathOf(req) ?? '?'}`);
    if (r === 'models') return handlers.models ? await handlers.models(req, res) : sendJson(res, 200, { data: [], has_more: false });
    let body;
    try { body = parseJsonBody(await readBody(req, maxBytes)); }
    catch (e) { return sendError(res, e.status || 400, e.type || 'invalid_request_error', e.message); }
    if (r === 'count_tokens') return handlers.count_tokens ? await handlers.count_tokens(req, res, body) : sendJson(res, 200, { input_tokens: estimateTokens(body) });
    if (!handlers.messages) return sendError(res, 404, 'not_found_error', 'Route /v1/messages indisponible.');
    return await handlers.messages(req, res, body);
  } catch (e) {
    log?.line?.({ niveau: 'erreur', ou: 'http', route: route(req), message: String(e?.message || e) });
    if (!res.headersSent) sendError(res, 500, 'api_error', `Erreur interne de la passerelle FS-CLI : ${e?.message || e}`);
    else if (!res.writableEnded) res.end();
  }
}

/**
 * Ouvre le serveur HTTP (127.0.0.1 par défaut, port 0 = libre). handler(req, res) → Promise.
 * Renvoie { server, port, url, close() } ; rejette avec un message en français si le port est pris (code EADDRINUSE).
 */
export function listen(handler, { host = '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { if (!res.writableEnded) res.destroy(); }); });
  server.requestTimeout = 0;                 // une génération peut durer : seuls les pings comptent (Claude Code coupe après 180 s sans octet)
  server.keepAliveTimeout = 65000;           // au-delà du délai de réutilisation des connexions de Claude Code
  return new Promise((resolve, reject) => {
    server.once('error', e => {
      if (e.code === 'EADDRINUSE') e.message = `Le port ${port} est déjà utilisé (une autre passerelle ?). Choisis-en un autre avec --fs-port.`;
      reject(e);
    });
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({
        server, port: p, url: `http://${host}:${p}`,
        close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}
