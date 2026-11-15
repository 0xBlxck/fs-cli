// Bilan des fichiers modifiés par le modèle (fin de demande, /changes) et annulation fichier par fichier.
// Source : la pile d'annulation S.undo ({ path, prev }) — prev = contenu d'avant (Buffer), null si le fichier a été créé.
import fs from 'node:fs';
import path from 'node:path';
import { lineDiff } from './ui.js';
import { undoLast } from './tools.js';

const MAX_DIFF = 400000;   // au-delà, pas de comptage de lignes (trop coûteux)

const readNow = p => { try { return fs.readFileSync(p); } catch { return null; } };
const isBinary = b => !!b && b.subarray(0, 8000).includes(0);

/** fichiers touchés dans undo[from..] : état d'avant la 1re modif, comptage +/− par rapport au contenu actuel */
export function summarizeChanges(undo, from = 0) {
  const byPath = new Map();
  undo.slice(from).forEach(u => { if (!byPath.has(u.path)) byPath.set(u.path, { path: u.path, before: u.prev, edits: 0 }); byPath.get(u.path).edits++; });
  return [...byPath.values()].map(f => {
    const now = readNow(f.path);
    const r = { path: f.path, edits: f.edits, created: f.before == null, deleted: now == null, added: 0, removed: 0, binary: isBinary(f.before) || isBinary(now) };
    if (!r.binary && (f.before?.length || 0) + (now?.length || 0) < MAX_DIFF) {
      const lines = b => (b == null || !b.length ? 0 : b.toString('utf8').replace(/\r?\n$/, '').split('\n').length);
      if (f.before == null || now == null) { r.added = lines(now); r.removed = lines(f.before); }   // créé / supprimé : tout compte
      else for (const l of lineDiff(f.before.toString('utf8'), now.toString('utf8'))) {
        if (l.t === '+') r.added++; else if (l.t === '-') r.removed++;
      }
    }
    return r;
  });
}

/** diff complet d'un fichier depuis sa première modification de la session */
export function fileDiff(undo, file) {
  const first = undo.find(u => u.path === file);
  if (!first) return null;
  const now = readNow(file);
  return { before: first.prev == null ? '' : first.prev.toString('utf8'), after: now == null ? '' : now.toString('utf8'), created: first.prev == null };
}

/** remet UN fichier dans son état d'avant sa première modification ; les autres fichiers ne bougent pas. Renvoie le message ou null. */
export function undoFile(S, file, trashDir) {
  const idx = S.undo.map((u, i) => (u.path === file ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return null;
  const first = S.undo[idx[0]];
  const msg = undoLast({ undo: [first] }, trashDir);            // restaure prev, ou met le fichier créé à la corbeille du CLI (jamais supprimé)
  const drop = new Set(idx);
  S.undo = S.undo.filter((_, i) => !drop.has(i));
  for (const m of S.turnMarks || []) m.at -= idx.filter(i => i < m.at).length;   // repères /rewind recalés
  return msg;
}

/** une ligne de bilan : « ✎ src/app.js  +12 −3 » */
export function changeLine(f, cwd, c) {
  const rel = path.relative(cwd, f.path);
  const name = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? f.path : rel;
  const counts = f.binary ? c.dim('binaire') : [f.added ? c.green(`+${f.added}`) : '', f.removed ? c.red(`−${f.removed}`) : ''].filter(Boolean).join(' ') || c.dim('inchangé');
  const tag = f.deleted ? c.yellow(' supprimé') : f.created ? c.dim(' créé') : '';
  return `${f.created ? c.green('＋') : c.accent('✎')} ${name}  ${counts}${tag}`;
}
