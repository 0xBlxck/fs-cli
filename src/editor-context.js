// Contexte de l'éditeur que l'extension VS Code ajoute devant le message (« [Contexte VS Code : …] » + sélection éventuelle).

/** texte tapé par l'utilisateur, sans ce contexte (repères de /rewind, message remis dans la saisie) */
export function stripEditorContext(t) {
  let s = String(t || '');
  const m = s.match(/^\[Contexte VS Code :[^\n]*\]\n/);   // chemin avec « [ ] » (Next.js app/[id]/page.tsx) accepté
  if (!m) return s;
  s = s.slice(m[0].length);
  const f = s.match(/^(```|~~~~)[^\n]*\n[\s\S]*?\n\1\n/);
  if (f) s = s.slice(f[0].length);
  return s.replace(/^\n+/, '');
}
