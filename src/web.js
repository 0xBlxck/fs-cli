// Outils web sûrs pour l'agent : lecture de pages (safeFetch) et recherche (webSearch).
//
// Garanties principales :
//  - garde-fou SSRF : seules les adresses IP publiques sont jointes (isPublicIp / assertPublicUrl) ;
//  - épinglage d'IP : la connexion utilise l'adresse DÉJÀ vérifiée (option `lookup`), ce qui
//    empêche le DNS rebinding entre la vérification et la connexion ;
//  - redirections suivies à la main, chaque saut est revalidé en entier ;
//  - le contenu web est une DONNÉE : rien n'est exécuté ni interprété.
//
// Zéro dépendance, aucun console.log, tout est annulable via AbortSignal.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

// User-Agent honnête : le CLI ne se fait pas passer pour un navigateur
const USER_AGENT = 'fs-cli (client communautaire open source)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/* ------------------------------------------------------------------ */
/* Adresses IP                                                         */
/* ------------------------------------------------------------------ */

function parseIPv4(text) {
  if (net.isIPv4(text) === false) return null;
  const parts = text.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** Découpe une IPv6 en 8 groupes de 16 bits (ou null si invalide). */
function parseIPv6(text) {
  let s = text;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;

  // IPv4 incorporée en fin d'adresse : on la convertit en deux groupes hexadécimaux.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  let head;
  let rest;
  const dbl = s.indexOf('::');
  if (dbl === -1) {
    head = s.split(':');
    rest = [];
  } else {
    head = s.slice(0, dbl) === '' ? [] : s.slice(0, dbl).split(':');
    rest = s.slice(dbl + 2) === '' ? [] : s.slice(dbl + 2).split(':');
  }
  const missing = 8 - head.length - rest.length;
  if (dbl === -1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(dbl === -1 ? 0 : missing).fill('0'), ...rest].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPublicV4([a, b, c]) {
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10/8
  if (a === 127) return false; // bouclage
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // lien-local, métadonnées cloud
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // relais 6to4 (obsolète)
  if (a === 192 && b === 168) return false; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast 224/4 + réservé 240/4 + broadcast
  return true;
}

/**
 * true uniquement pour une adresse IP publique routable. Toute valeur qui n'est pas une IP
 * valide renvoie false (refus par défaut).
 */
export function isPublicIp(ip) {
  if (typeof ip !== 'string') return false;
  const text = ip.trim().replace(/^\[|\]$/g, '');
  if (!text) return false;

  const v4 = parseIPv4(text);
  if (v4) return isPublicV4(v4);

  const g = parseIPv6(text);
  if (!g) return false;

  const embedded = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeros = (from, to) => g.slice(from, to).every(x => x === 0);

  if (zeros(0, 5) && g[5] === 0xffff) return isPublicV4(embedded(g[6], g[7])); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPublicV4(embedded(g[6], g[7])); // NAT64
  if ((g[0] & 0xe000) !== 0x2000) return false; // hors 2000::/3 : ::, ::1, fc00::/7, fe80::/10, ff00::/8…
  if (g[0] === 0x2002) return isPublicV4(embedded(g[1], g[2])); // 6to4 : on juge l'IPv4 contenue
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23 (Teredo, protocoles IETF…)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false; // documentation 3fff::/20
  return true;
}

/* ------------------------------------------------------------------ */
/* Validation d'URL                                                    */
/* ------------------------------------------------------------------ */

function abortError() {
  const error = new Error('Opération annulée.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** Course entre une promesse et un signal d'annulation. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

/**
 * Vérifie qu'une URL vise un hôte public : http/https, sans identifiants, ni hôte local,
 * et toutes les adresses résolues publiques. Renvoie { url, addresses }.
 * Options non documentées : `signal`, `_resolve(host)` (résolveur injectable pour les tests).
 */
export async function assertPublicUrl(input, { signal, _resolve } = {}) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input).trim());
  } catch {
    throw new Error(`URL invalide : ${String(input).slice(0, 200)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Protocole refusé : ${url.protocol} (seuls http et https sont acceptés).`);
  }
  if (url.username || url.password) {
    throw new Error("URL refusée : elle contient des identifiants (utilisateur:mot de passe@).");
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (!host) throw new Error('URL invalide : nom d’hôte vide.');

  if (host === 'localhost' || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    throw new Error(`Adresse refusée : ${host} est un hôte local ou interne.`);
  }

  const family = net.isIP(host);
  let addresses;
  if (family) {
    // `new URL()` a déjà normalisé les notations décimale, octale et hexadécimale.
    addresses = [{ address: host, family }];
  } else {
    try {
      const lookup = _resolve ?? (name => dns.promises.lookup(name, { all: true, verbatim: true }));
      addresses = await raceAbort(Promise.resolve(lookup(host)), signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new Error(`Nom de domaine introuvable : ${host} (${error?.code || error?.message || 'erreur DNS'}).`);
    }
    if (!Array.isArray(addresses)) addresses = addresses ? [addresses] : [];
    addresses = addresses
      .map(entry => (typeof entry === 'string' ? { address: entry, family: net.isIP(entry) } : entry))
      .filter(entry => entry?.address);
    if (addresses.length === 0) throw new Error(`Nom de domaine introuvable : ${host}.`);
  }

  for (const { address } of addresses) {
    if (!isPublicIp(address)) {
      throw new Error(`Adresse refusée : ${host} pointe vers ${address} (réseau local, privé ou réservé).`);
    }
  }

  return { url, addresses: addresses.map(({ address, family: f }) => ({ address, family: f || net.isIP(address) })) };
}

/**
 * Résout l'en-tête Location d'une redirection puis la revalide intégralement.
 * Exportée pour les tests : une redirection vers une adresse non publique est refusée.
 */
export async function _followRedirectTarget(fromUrl, location, opts = {}) {
  let target;
  try {
    target = new URL(String(location), fromUrl);
  } catch {
    throw new Error(`Redirection invalide : ${String(location).slice(0, 200)}`);
  }
  try {
    return await assertPublicUrl(target, opts);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(`Redirection refusée vers ${target.href} : ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Couche réseau (HTTP épinglé)                                        */
/* ------------------------------------------------------------------ */

/** Signal combiné : annulation de l'appelant + délai global. */
function makeDeadline(userSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', onAbort);
    }
  };
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options?.all) callback(null, addresses.map(({ address, family }) => ({ address, family })));
    else callback(null, addresses[0].address, addresses[0].family);
  };
}

const DECODERS = {
  gzip: () => zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  'x-gzip': () => zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  deflate: () => zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  br: () => zlib.createBrotliDecompress()
};

/** Lit au plus maxBytes octets (après décompression), puis arrête le flux. */
async function readLimited(res, maxBytes) {
  const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase();
  let stream = res;
  let decoder = null;
  if (encoding && encoding !== 'identity') {
    if (!DECODERS[encoding]) throw new Error(`Encodage de contenu non pris en charge : ${encoding}.`);
    decoder = DECODERS[encoding]();
    res.on('error', error => decoder.destroy(error));
    res.pipe(decoder);
    stream = decoder;
  }

  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const room = maxBytes - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size += Math.max(room, 0);
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    decoder?.destroy();
    res.destroy();
  }
  return { body: Buffer.concat(chunks), truncated, bytes: size };
}

/**
 * Une requête HTTP(S) unique, épinglée sur les adresses déjà vérifiées. Sans redirection.
 * Renvoie { status, headers (clés en minuscules), body: Buffer, truncated, bytes }.
 */
export function _requestOnce(url, addresses, { method = 'GET', headers = {}, body, signal, maxBytes }) {
  const client = url.protocol === 'https:' ? https : http;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const payload = body === undefined ? null : Buffer.from(body);
  const finalHeaders = { ...headers, 'accept-encoding': 'gzip, deflate, br' };
  if (payload) finalHeaders['content-length'] = String(payload.length);

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: finalHeaders,
        agent: false,
        lookup: pinnedLookup(addresses),
        signal,
        ...(net.isIP(host) ? {} : { servername: host })
      },
      res => {
        readLimited(res, maxBytes).then(
          ({ body: buffer, truncated, bytes }) =>
            resolve({ status: res.statusCode, headers: res.headers, body: buffer, truncated, bytes }),
          reject
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const NET_MESSAGES = {
  ENOTFOUND: 'nom de domaine introuvable',
  EAI_AGAIN: 'résolution DNS indisponible',
  ECONNREFUSED: 'connexion refusée',
  ECONNRESET: 'connexion interrompue par le serveur',
  ETIMEDOUT: 'délai de connexion dépassé',
  EHOSTUNREACH: 'hôte injoignable',
  ENETUNREACH: 'réseau injoignable',
  EPIPE: 'connexion rompue',
  CERT_HAS_EXPIRED: 'certificat TLS expiré',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificat TLS auto-signé',
  SELF_SIGNED_CERT_IN_CHAIN: 'certificat TLS auto-signé dans la chaîne',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificat TLS non vérifiable',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificat TLS ne correspondant pas au domaine',
  Z_DATA_ERROR: 'contenu compressé corrompu',
  Z_BUF_ERROR: 'contenu compressé tronqué',
  ERR_BROTLI_DECODE_FAILED: 'contenu compressé corrompu'
};

function describeNetError(error) {
  const code = error?.code;
  if (code && NET_MESSAGES[code]) return `Échec de la requête : ${NET_MESSAGES[code]} (${code}).`;
  if (code) return `Échec de la requête : ${code}.`;
  return `Échec de la requête : ${error?.message || 'erreur inconnue'}.`;
}

/* ------------------------------------------------------------------ */
/* HTML -> texte                                                       */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', micro: 'µ',
  frac12: '½', frac14: '¼', frac34: '¾', iexcl: '¡', iquest: '¿',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', check: '✓',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å',
  ccedil: 'ç', icirc: 'î', iuml: 'ï', igrave: 'ì', iacute: 'í', ocirc: 'ô', ouml: 'ö', ograve: 'ò', oacute: 'ó',
  ugrave: 'ù', ucirc: 'û', uuml: 'ü', uacute: 'ú', aacute: 'á', atilde: 'ã', ntilde: 'ñ', yuml: 'ÿ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Ocirc: 'Ô', Ucirc: 'Û',
  oelig: 'œ', OElig: 'Œ', szlig: 'ß', aelig: 'æ', AElig: 'Æ'
};

function decodeEntities(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return match;
      return n === 0xa0 ? ' ' : String.fromCodePoint(n);
    }
    return Object.hasOwn(ENTITIES, code) ? ENTITIES[code] : match;
  });
}

/** Supprime les blocs <script>, <style>… en une passe linéaire (bloc non fermé : jusqu'à la fin). */
function removeBlocks(html) {
  const open = /<(script|style|noscript|svg|template|head)\b/gi;
  let out = '';
  let last = 0;
  let match;
  while ((match = open.exec(html)) !== null) {
    out += html.slice(last, match.index);
    const close = new RegExp(`</${match[1]}\\s*>`, 'gi');
    close.lastIndex = match.index + match[0].length;
    const end = close.exec(html);
    if (!end) {
      last = html.length;
      break;
    }
    last = end.index + end[0].length;
    open.lastIndex = last;
  }
  return out + html.slice(last);
}

/**
 * Convertit du HTML en texte brut lisible. Ne conserve aucune balise : le résultat est une
 * donnée, jamais du code.
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  text = removeBlocks(text);
  text = text.replace(/<li\b[^>]*>/gi, '\n• ');
  text = text.replace(/<br\b[^>]*>/gi, '\n');
  text = text.replace(
    /<\/?(?:p|div|h[1-6]|tr|section|article|header|footer|ul|ol|table|nav|main|aside|blockquote|pre|form|figure|figcaption|dl|dt|dd|hr|thead|tbody)\b[^>]*>/gi,
    '\n'
  );
  text = text.replace(/<\/t[dh]\s*>/gi, ' ');
  text = text.replace(/<[a-zA-Z\/!?][^>]*>/g, '');
  text = decodeEntities(text);

  return text
    .split('\n')
    .map(line => line.replace(/[ \t\r\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return '';
  return decodeEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* safeFetch                                                           */
/* ------------------------------------------------------------------ */

function decodeBody(buffer, contentType, isHtml) {
  let charset = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType || '')?.[1];
  if (!charset && isHtml) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]+)/i.exec(head)?.[1];
  }
  for (const label of [charset, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(buffer);
    } catch {
      // charset non supporté : on essaie le suivant
    }
  }
  return buffer.toString('utf8');
}

/** Renvoie 'html' | 'json' | 'text' | null selon le type MIME. */
function classify(mime) {
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/xml' || mime.endsWith('+xml')) return 'text';
  return null;
}

function failure(error, extra = {}) {
  return {
    ok: false,
    status: 0,
    url: '',
    contentType: '',
    title: '',
    text: '',
    truncated: false,
    bytes: 0,
    redirects: 0,
    error,
    ...extra
  };
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Lit une page web de façon sûre. Ne lève jamais d'exception, sauf annulation (AbortError).
 * Options non documentées : `_resolve` (résolveur DNS), `_request` (transport injectable).
 */
export async function safeFetch(url, options = {}) {
  const { maxChars = 20000, timeoutMs = 20000, signal, maxRedirects = 5, maxBytes = 3_000_000, headers } = options;
  throwIfAborted(signal);

  const deadline = makeDeadline(signal, timeoutMs);
  const send = options._request ?? _requestOnce;
  const limit = Math.max(1, Number(maxChars) || 20000);
  const byteLimit = Math.max(1, Number(maxBytes) || 3_000_000);
  let redirects = 0;
  let current = String(url);
  let reqHeaders = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
    ...Object.fromEntries(
      Object.entries(headers ?? {})
        .map(([k, v]) => [k.toLowerCase(), String(v)])
        .filter(([k]) => k !== 'host' && k !== 'accept-encoding' && k !== 'content-length')
    )
  };

  try {
    let checked = await assertPublicUrl(current, { signal: deadline.signal, _resolve: options._resolve });
    current = checked.url.href;

    for (;;) {
      const response = await send(checked.url, checked.addresses, {
        method: 'GET',
        headers: reqHeaders,
        signal: deadline.signal,
        maxBytes: byteLimit
      });
      const status = response.status;

      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location;
        if (!location) return failure(`Redirection HTTP ${status} sans en-tête Location.`, { status, url: current, redirects });
        if (redirects >= maxRedirects) {
          return failure(`Trop de redirections (plus de ${maxRedirects}).`, { status, url: current, redirects });
        }
        const next = await _followRedirectTarget(checked.url, location, {
          signal: deadline.signal,
          _resolve: options._resolve
        });
        // Les identifiants ne suivent jamais une redirection vers une autre origine.
        if (next.url.origin !== checked.url.origin) {
          reqHeaders = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => !SENSITIVE_HEADERS.includes(k)));
        }
        redirects++;
        checked = next;
        current = next.url.href;
        continue;
      }

      const contentType = String(response.headers['content-type'] || '');
      let mime = contentType.split(';')[0].trim().toLowerCase();
      const body = response.body;
      let kind = classify(mime);

      if (!mime) {
        // Pas de Content-Type : on devine seulement si le contenu ressemble à du texte.
        const sample = body.subarray(0, 2048);
        if (!sample.includes(0)) {
          const head = sample.toString('latin1');
          kind = /<!doctype html|<html[\s>]/i.test(head) ? 'html' : 'text';
          mime = kind === 'html' ? 'text/html' : 'text/plain';
        }
      }

      const base = { status, url: current, contentType: mime, bytes: response.bytes ?? body.length, redirects };
      const httpOk = status >= 200 && status < 300;

      if (!kind) {
        return failure(
          `Type de contenu non pris en charge : ${mime || 'inconnu'} (HTML, JSON, XML ou texte uniquement).`,
          base
        );
      }

      const raw = decodeBody(body, contentType, kind === 'html');
      let text;
      let title = '';
      if (kind === 'html') {
        title = extractTitle(raw);
        text = htmlToText(raw);
      } else if (kind === 'json') {
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
      } else {
        text = raw;
      }

      const truncated = Boolean(response.truncated) || text.length > limit;
      if (text.length > limit) text = text.slice(0, limit);

      const result = { ok: httpOk, ...base, title, text, truncated };
      if (!httpOk) result.error = `Réponse HTTP ${status} pour ${current}.`;
      return result;
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (deadline.timedOut()) return failure(`Délai dépassé (${timeoutMs} ms).`, { url: current, redirects });
    if (error?.name === 'AbortError') throw abortError();
    return failure(error?.code ? describeNetError(error) : error?.message || String(error), {
      url: current,
      redirects
    });
  } finally {
    deadline.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* Recherche web                                                       */
/* ------------------------------------------------------------------ */

const MAX_QUERY_CHARS = 400;
const MAX_SNIPPET_CHARS = 300;

const clean = text => htmlToText(String(text ?? '')).replace(/\s+/g, ' ').trim();

function engineError(name, status) {
  if (status === 401 || status === 403) {
    return new Error(`Le moteur ${name} a refusé la requête (HTTP ${status}) : clé d'API invalide ou non autorisée.`);
  }
  if (status === 429) {
    return new Error(`Le moteur ${name} a refusé la requête (HTTP 429) : quota dépassé, réessaie plus tard.`);
  }
  return new Error(`Le moteur ${name} a répondu avec une erreur (HTTP ${status}).`);
}

function decodeDuckUrl(href) {
  const raw = decodeEntities(String(href ?? '')).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) return target;
    // Lien publicitaire (y.js) ou lien interne : ignoré par l'appelant.
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** Lit les résultats de la version HTML de DuckDuckGo (publicités ignorées). */
export function _parseDuckHtml(html) {
  const text = String(html ?? '');
  const anchors = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchorRe.exec(text)) !== null) {
    const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1]);
    const classes = (cls?.[1] ?? cls?.[2] ?? '').split(/\s+/);
    if (classes.includes('result__a')) anchors.push({ kind: 'title', index: match.index, end: anchorRe.lastIndex, attrs: match[1], inner: match[2] });
    else if (classes.includes('result__snippet')) anchors.push({ kind: 'snippet', index: match.index, end: anchorRe.lastIndex, inner: match[2] });
  }
  // Snippets en <div>/<td> (anciennes variantes de la page).
  const blockRe = /<(div|td|span)\b[^>]*class\s*=\s*"[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  while ((match = blockRe.exec(text)) !== null) {
    anchors.push({ kind: 'snippet', index: match.index, end: blockRe.lastIndex, inner: match[2] });
  }
  anchors.sort((a, b) => a.index - b.index);

  const results = [];
  let current = null;
  for (const item of anchors) {
    if (item.kind === 'title') {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(item.attrs);
      const url = decodeDuckUrl(href?.[1] ?? href?.[2] ?? '');
      current = url ? { title: item.inner, url, snippet: '' } : null;
      if (current) results.push(current);
    } else if (current && !current.snippet) {
      current.snippet = item.inner;
    }
  }
  return results;
}

async function searchDuckDuckGo(query, { signal, send, resolveOpt, maxBytes }) {
  const url = new URL('https://html.duckduckgo.com/html/');
  const checked = await assertPublicUrl(url, { signal, _resolve: resolveOpt });
  const response = await send(checked.url, checked.addresses, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://html.duckduckgo.com',
      referer: 'https://html.duckduckgo.com/'
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
    maxBytes
  });

  const html = response.body.toString('utf8');
  if (response.status === 202 || (response.status === 403 && /anomaly|captcha/i.test(html))) {
    throw new Error(
      'DuckDuckGo a détecté un trafic automatisé (anomalie / captcha). Réessaie plus tard ou définis FS_SEARCH_API_KEY (Brave Search).'
    );
  }
  if (response.status === 429) throw engineError('duckduckgo', 429);
  if (response.status < 200 || response.status >= 300) throw engineError('duckduckgo', response.status);

  const items = _parseDuckHtml(html);
  if (items.length === 0 && /anomaly|captcha|unusual traffic/i.test(html)) {
    throw new Error(
      'DuckDuckGo a détecté un trafic automatisé (anomalie / captcha). Réessaie plus tard ou définis FS_SEARCH_API_KEY (Brave Search).'
    );
  }
  return items;
}

async function searchBrave(query, count, apiKey, { signal, send, resolveOpt, maxBytes }) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  const checked = await assertPublicUrl(url, { signal, _resolve: resolveOpt });
  // Pas de redirection suivie : la clé ne doit partir que vers Brave.
  const response = await send(checked.url, checked.addresses, {
    method: 'GET',
    headers: { accept: 'application/json', 'x-subscription-token': apiKey, 'user-agent': USER_AGENT },
    signal,
    maxBytes
  });
  if (response.status < 200 || response.status >= 300) throw engineError('brave', response.status);

  let data;
  try {
    data = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new Error('Réponse illisible du moteur brave (JSON invalide).');
  }
  const items = Array.isArray(data?.web?.results) ? data.web.results : [];
  return items.map(item => ({ title: item?.title, url: item?.url, snippet: item?.description }));
}

function normalizeResults(items, max) {
  const seen = new Set();
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const url = String(item?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const snippet = clean(item.snippet);
    results.push({
      title: clean(item.title) || url,
      url,
      snippet: snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}…` : snippet
    });
    if (results.length >= max) break;
  }
  return results;
}

/**
 * Recherche web. Brave Search si FS_SEARCH_API_KEY est défini, sinon DuckDuckGo (HTML).
 * FS_SEARCH_PROVIDER=none désactive la recherche. Lève une Error en français en cas d'échec.
 * Options non documentées : `_request`, `_resolve`, `apiKey`, `provider`.
 */
export async function webSearch(query, options = {}) {
  const { max = 5, signal, timeoutMs = 15000 } = options;
  throwIfAborted(signal);

  if (typeof query !== 'string' || !query.trim()) throw new Error('La requête de recherche ne doit pas être vide.');
  const q = query.trim();
  if (q.length > MAX_QUERY_CHARS) {
    throw new Error(`La requête de recherche est trop longue (${MAX_QUERY_CHARS} caractères au maximum).`);
  }

  const count = Math.min(Math.max(Math.trunc(Number(max)) || 5, 1), 10);
  const apiKey = String(options.apiKey ?? process.env.FS_SEARCH_API_KEY ?? '').trim();
  const providerEnv = String(options.provider ?? process.env.FS_SEARCH_PROVIDER ?? '').trim().toLowerCase();

  if (providerEnv === 'none' || providerEnv === 'off') {
    throw new Error('La recherche web est désactivée (FS_SEARCH_PROVIDER=none).');
  }
  if (providerEnv && providerEnv !== 'brave' && providerEnv !== 'duckduckgo') {
    throw new Error(`Moteur de recherche inconnu : ${providerEnv} (valeurs possibles : brave, duckduckgo, none).`);
  }
  const provider = providerEnv || (apiKey ? 'brave' : 'duckduckgo');
  if (provider === 'brave' && !apiKey) {
    throw new Error("Clé d'API absente pour le moteur brave : définis FS_SEARCH_API_KEY.");
  }

  const deadline = makeDeadline(signal, timeoutMs);
  const ctx = {
    signal: deadline.signal,
    send: options._request ?? _requestOnce,
    resolveOpt: options._resolve,
    maxBytes: 2_000_000
  };

  try {
    const raw =
      provider === 'brave' ? await searchBrave(q, count, apiKey, ctx) : await searchDuckDuckGo(q, ctx);
    return { provider, results: normalizeResults(raw, count) };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (deadline.timedOut()) throw new Error(`Délai dépassé (${timeoutMs} ms) pour la recherche web.`);
    if (error?.name === 'AbortError') throw abortError();
    let message = error?.code ? describeNetError(error) : error?.message || String(error);
    if (apiKey) message = message.split(apiKey).join('***');
    throw new Error(message.startsWith('Échec') ? `Recherche web (${provider}) : ${message}` : message);
  } finally {
    deadline.cleanup();
  }
}

/** Mise en forme lisible, numérotée (titre, url, extrait). */
export function formatSearchResults(results) {
  if (!Array.isArray(results) || results.length === 0) return 'Aucun résultat.';
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || r.url}`, `   ${r.url}`];
      if (r.snippet) lines.push(`   ${r.snippet}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
