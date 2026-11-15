// Vision : les images renvoyées par un outil MCP (capture du navigateur, de Blender…) sont enregistrées puis JOINTES au
// prochain résultat d'outil envoyé au modèle (Files v2 + champ `files` avec toolResults, vérifié : le modèle les voit).
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';

const queue = [];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 8 * 1024 * 1024;

/** Enregistre les images d'un contenu MCP, les met en file pour le modèle ; renvoie leurs chemins. */
export function captureImages(content, { queueForModel = true } = {}) {
  const out = [];
  const dir = path.join(HOME_DIR, 'captures');
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type !== 'image' || typeof c.data !== 'string') continue;
    const buf = Buffer.from(c.data, 'base64');
    if (!buf.length || buf.length > MAX_BYTES) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${out.length + 1}.${EXT[c.mimeType] || 'png'}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    if (queueForModel) queue.push({ file, mime: c.mimeType || 'image/png' });
    out.push(file);
  }
  return out;
}

/** Images en attente pour le prochain résultat envoyé au modèle (les plus récentes, 4 au maximum). */
export function takeQueuedImages(max = 4) { const all = queue.splice(0, queue.length); return all.slice(-max); }
