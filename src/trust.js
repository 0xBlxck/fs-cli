// Confiance par dossier : à la première ouverture d'un dossier, le CLI demande si on lui fait confiance
// (le modèle pourra y lire et modifier des fichiers et y lancer des commandes). Faire confiance à un dossier
// vaut aussi pour ses sous-dossiers. Stockage : ~/.fs-cli/trusted-folders.json (droits 0600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR } from './config.js';

const FILE = () => path.join(HOME_DIR, 'trusted-folders.json');
/** Chemin réel normalisé ; pour un dossier pas encore créé, on résout son plus proche parent existant (noms courts Windows type RUNNER~1, liens…). */
function norm(d) {
  let cur = path.resolve(d); const tail = []; let p = cur;
  for (let i = 0; i < 64; i++) {
    try { p = path.join(fs.realpathSync.native(cur), ...tail.reverse()); break; } catch {}
    const up = path.dirname(cur); if (up === cur) { p = path.resolve(d); break; }
    tail.push(path.basename(cur)); cur = up;
  }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
const sessionTrusted = new Set();

function load() { try { const a = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } }

/** Dossier trop large pour une confiance globale (racine d'un disque, dossier personnel) : jamais hérité par ses sous-dossiers. */
export function isBroadFolder(dir) {
  const p = norm(dir), root = path.parse(p).root;
  return p === root || p + path.sep === root || p === norm(os.homedir());
}

export function isFolderTrusted(dir) {
  const p = norm(dir);
  return [...sessionTrusted, ...load()].some(t => t === p || (!isBroadFolder(t) && p.startsWith(t.endsWith(path.sep) ? t : t + path.sep)));
}

export function trustFolder(dir, { remember = true } = {}) {
  const p = norm(dir);
  sessionTrusted.add(p);
  if (!remember) return;
  const list = load(); if (!list.includes(p)) list.push(p);
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}
