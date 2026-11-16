// Registre des conversations créées par le CLI + étiquettes lisibles dans la liste de FS + compteur de la limite quotidienne.
// FS limite à 50 NOUVELLES conversations par jour (remise à zéro à 03:59:59 UTC) : on en crée le moins possible.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './config.js';

export const DAILY_LIMIT = 50;
const FILE = () => path.join(HOME_DIR, 'chats.json');

const read = () => { try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(j.created) ? j : { created: [] }; } catch { return { created: [] }; } };
function write(d) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    fs.renameSync(tmp, FILE());
  } catch {}
}

/** identifiant court (4 hex) d'une session CLI : il apparaît dans le titre des conversations FS */
export const newSid = () => crypto.randomBytes(2).toString('hex');

/** étiquette en tête du 1er message → titre FS « [7f3a] écris-moi… » ou « [7f3a·css] Tu es l'agent… » (≤ 20 caractères avant troncature) */
export const tag = (sid, role = '') => `[${sid}${role ? '·' + role : ''}] `;

/** dernier instant de remise à zéro de la limite quotidienne (04:00:00 UTC, le jour même ou la veille) */
export function lastReset(now = Date.now()) {
  const d = new Date(now);
  const r = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 4, 0, 0, 0);
  return r <= now ? r : r - 86400000;
}

export function register(id, { sid, role = 'main' } = {}) {
  if (!id) return;
  const d = read();
  if (d.created.some(x => x.id === id)) return;
  d.created.push({ id, sid: sid || '', role, t: Date.now() });
  d.created = d.created.slice(-500);
  write(d);
}

/** nombre de conversations créées par le CLI depuis la dernière remise à zéro (hors conversations créées sur le site) */
export function createdToday(now = Date.now()) {
  const from = lastReset(now);
  return read().created.filter(x => x.t >= from).length;
}

export const listCreated = () => read().created;
export const forSession = sid => read().created.filter(x => x.sid === sid);

export function unregister(ids) {
  const set = new Set(ids);
  const d = read(); d.created = d.created.filter(x => !set.has(x.id)); write(d);
}

/** heure locale lisible d'une date ISO */
export function localTime(iso) {
  const t = new Date(iso);
  return isNaN(t) ? '?' : t.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
