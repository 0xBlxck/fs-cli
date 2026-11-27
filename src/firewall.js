// Pare-feu de France Student (Cloudflare) : il refuse un message entier dès qu'UNE ligne ressemble à une attaque.
// Vérifié en vrai le 27/11/2026 avec 22 skills envoyés comme le fait « /nom-du-skill » : 20 passent, 2 sont refusés
// (page « Sorry, you have been blocked »), chacun pour une seule ligne :
//   - un exemple d'injection SQL et de balise script cité dans le texte ;
//   - « cat js_files.txt | xargs -I{} sh -c 'curl -s {} | linkfinder -i - »' (commande qui en lance une autre téléchargée).
// Ce module ne change JAMAIS le contenu envoyé (pas de contournement) : il aide seulement l'utilisateur à trouver la ligne.

/** motifs que le pare-feu prend pour une attaque (d'après les refus observés et les règles habituelles de Cloudflare) */
const RISKY = [
  [/<\s*script\b|<\/\s*script\s*>|\bon(?:error|load|click)\s*=|javascript\s*:/i, 'balise ou code de page (script)'],
  [/'\s*or\s+\d+\s*=\s*\d+|\bunion\s+(?:all\s+)?select\b|\bdrop\s+table\b|;\s*--|\bor\s+1\s*=\s*1\b/i, 'exemple d\'injection SQL'],
  [/\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:ba|z)?sh\s+-c\s+['"]?\s*(?:curl|wget)\b|\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:\w+\s+)?(?:ba|z)?sh\b/i, 'commande téléchargée puis exécutée'],
  [/\|\s*iex\b|\binvoke-expression\b|-executionpolicy\s+bypass|downloadstring\s*\(/i, 'commande PowerShell téléchargée puis exécutée'],
  [/(?:\.\.[\\/]){2,}|\/etc\/(?:passwd|shadow)\b/i, 'chemin qui remonte les dossiers'],
  [/\beval\s*\(\s*(?:base64_decode|atob)\b|\bbase64\s+(?:-d|--decode)\b[^|\n]*\|/i, 'code décodé puis exécuté'],
];

/**
 * Lignes d'un texte que le pare-feu risque de refuser → [{ n, line, why }] (n = numéro de ligne, à partir de 1).
 * Une estimation faite sur le PC : la liste peut être incomplète, ou citer une ligne qui serait passée.
 */
export function riskyLines(text, max = 3) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const hit = RISKY.find(([re]) => re.test(lines[i]));
    if (hit) out.push({ n: i + 1, line: lines[i].trim(), why: hit[1] });
  }
  return out;
}

/** « Base directory for this skill: C:\…\skills\nom » en tête du message : c'est un skill lancé par « /nom » */
export function skillOf(text) {
  const m = /^Base directory for this skill:\s*(.+?)\s*$/m.exec(String(text ?? '').slice(0, 2000));
  if (!m) return null;
  const dir = m[1].replace(/[\\/]+$/, '');
  return { dir, name: dir.split(/[\\/]/).pop() || 'skill' };
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Message affiché quand le CONTENU d'une demande est refusé (le réseau passe). Court, l'action d'abord : Claude Code
 * coupe les erreurs longues (vu : « Reformule ou retire ce pass… », le conseil avait disparu).
 */
export function firewallContentMessage(text) {
  const skill = skillOf(text);
  const hits = riskyLines(text, 2);
  const where = skill ? `dans le fichier SKILL.md du skill « ${skill.name} »` : 'dans ton message';
  const what = hits.length
    ? `Ligne${hits.length > 1 ? 's' : ''} à retirer ou reformuler ${where} : ${hits.map(h => `« ${cut(h.line, 90)} » (${h.why})`).join(' ; ')}.`
    : `Retire ou reformule ${where} la ligne qui ressemble à une attaque (commande du type « curl … | sh », balise script, exemple d'injection SQL).`;
  return `403 — le pare-feu de France Student refuse le CONTENU de cette demande (ta connexion n'est pas en cause). ${what} Une seule ligne suffit à tout bloquer ; FS-CLI ne peut pas la faire passer à ta place.`;
}
