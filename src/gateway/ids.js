// Passerelle Claude Code : ids des blocs tool_use émis vers Claude Code (spécification § 3.4).
// Un id encode de quoi retrouver l'appel France Student SANS état (redémarrage, --resume, autre processus) :
//   f : appel FS          'toolu_' + b64url('f|' + chatId + '|' + callId)
//   s : synthétique       'toolu_' + b64url('s|' + purpose + '|' + rand8 [+ '|' + n])   (Read injecté, document…)
//   r : second essai      'toolu_' + b64url('r|' + chatId + '|' + callId + '|' + n)
// L'alphabet base64url [A-Za-z0-9_-] respecte la contrainte de Claude Code sur les ids tool_use.
// Au-delà de 200 caractères, repli 'toolu_f' / 'toolu_r' + 24 hex de sha1 : la correspondance reste alors dans
// conv.fs.pending (décodage sans état impossible dans ce cas rare) et decodeId renvoie null.
import { createHash, randomInt } from 'node:crypto';

const PREFIX = 'toolu_';
const MAX_LEN = 200;
const range = (from, n) => Array.from({ length: n }, (_, i) => String.fromCharCode(from.charCodeAt(0) + i)).join('');
const B62 = range('0', 10) + range('A', 26) + range('a', 26);    // assemblé : la ligne littérale ressemble à un token pour scan.mjs
const HASHED = /^toolu_[fr][0-9a-f]{24}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

const sha1 = s => createHash('sha1').update(s, 'utf8').digest('hex');
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');

/** n caractères base62 aléatoires (crypto) */
export function rand62(n = 8) {
  let s = '';
  for (let i = 0; i < n; i++) s += B62[randomInt(62)];
  return s;
}

/** encode la charge utile ; trop long → repli haché (kind = 'f' ou 'r') */
function encode(payload, kind) {
  const id = PREFIX + b64(payload);
  return id.length <= MAX_LEN ? id : `${PREFIX}${kind}${sha1(payload.slice(2)).slice(0, 24)}`;
}

/** id du tool_use d'un appel France Student (callId) du chat chatId */
export function fsId(chatId, callId) {
  return encode(`f|${chatId}|${callId}`, 'f');
}

/** id d'un tool_use inventé par la passerelle : purpose = 'read' (Read injecté) | 'doc' (document) ; n facultatif */
export function synthId(purpose, n) {
  const tail = n == null ? '' : `|${n}`;
  return PREFIX + b64(`s|${purpose}|${rand62(8)}${tail}`);
}

/** id du second essai d'un appel FS (micro-tour local : Read puis même Edit/Write), n = numéro d'essai */
export function retryId(chatId, callId, n) {
  return encode(`r|${chatId}|${callId}|${n}`, 'r');
}

/** décode la charge base64url ; null si ce n'est pas un encodage canonique d'un texte UTF-8 valide */
function payloadOf(id) {
  const p = id.slice(PREFIX.length);
  if (!p || !B64URL.test(p)) return null;
  const buf = Buffer.from(p, 'base64url');
  if (buf.toString('base64url') !== p) return null;                 // pas canonique : pas un id à nous
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;       // octets invalides en UTF-8
}

/**
 * Décode un id tool_use. Tolérant : renvoie null pour tout id qui n'est pas à nous (ex. « toolu_capture1 »),
 * y compris un id haché (repli au-delà de 200 caractères).
 * @returns {{kind:'f', chatId:string, callId:string} | {kind:'r', chatId:string, callId:string, n:number} | {kind:'s', purpose:string, n?:string} | null}
 */
export function decodeId(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX) || HASHED.test(id)) return null;
  const text = payloadOf(id);
  if (!text) return null;
  const parts = text.split('|');
  const [kind] = parts;
  if (kind === 'f' && parts.length >= 3 && parts[1]) {
    const callId = parts.slice(2).join('|');                         // un callId pourrait contenir « | »
    return callId ? { kind, chatId: parts[1], callId } : null;
  }
  if (kind === 'r' && parts.length >= 4 && parts[1]) {
    const n = Number(parts.at(-1));
    const callId = parts.slice(2, -1).join('|');
    return callId && Number.isInteger(n) ? { kind, chatId: parts[1], callId, n } : null;
  }
  if (kind === 's' && (parts.length === 3 || parts.length === 4) && parts[1] && parts[2]) {
    return parts.length === 4 ? { kind, purpose: parts[1], n: parts[3] } : { kind, purpose: parts[1] };
  }
  return null;
}
