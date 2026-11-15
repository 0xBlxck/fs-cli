// Accords donnés aux serveurs MCP importés d'autres assistants (Claude Code, Codex…).
// Un accord est lié à la commande (ou l'URL) du serveur : si elle change, il faut le redonner.
// Fichier : ~/.fs-cli/approved-mcp.json (droits 0600). ~/.fs-cli est un chemin sensible : le modèle ne peut pas l'écrire sans ton accord.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';

const FILE = () => path.join(HOME_DIR, 'approved-mcp.json');
export const serverSig = s => crypto.createHash('sha256').update(JSON.stringify([s.command || '', s.args || [], s.url || ''])).digest('hex').slice(0, 16);

function read() { try { const o = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } }

export function isImportApproved(name, s) { return read()[name] === serverSig(s); }

export function approveImport(name, s) {
  const o = read(); o[name] = serverSig(s);
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}
