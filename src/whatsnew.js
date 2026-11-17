// « Quoi de neuf » : affiché à l'accueil du terminal et du panneau, en entier avec /nouveautes.
// Une ligne = une nouveauté visible, en mots simples. La version la plus récente en premier.
export const WHATS_NEW = [
  { version: '3.44.0', items: [
    '/resume : onglets Ce dossier · Tous · Projets (← →), comme dans l\'IDE',
    'MCP : le code que le modèle met dans le panneau du site est renvoyé en entier',
    'Documents du site mis à jour par le modèle : relus et écrits dans ton dossier',
  ] },
  { version: '3.43.0', items: [
    '/resume : conversations et projets au clavier, comme dans l\'IDE',
    'Quoi de neuf à l\'accueil (terminal et IDE), /nouveautes pour tout voir',
  ] },
  { version: '3.42.0', items: [
    'Dossier de travail affiché en direct au-dessus de la saisie',
    'Lancé depuis ton dossier perso : ton dernier dossier proposé en 1er',
    'Un chemin de dossier tapé seul : FS-CLI demande quoi en faire',
  ] },
  { version: '3.41.0', items: [
    'Fichiers mis par le modèle dans le panneau du site : écrits dans ton dossier',
    'Supprimer un projet sans perdre ses conversations (/projet supprimer, ✕ dans l\'IDE)',
    '--projet <nom> : range les conversations d\'une exécution dans un projet',
  ] },
  { version: '3.40.0', items: ['Le modèle voit tous tes skills et ouvre celui qu\'il lui faut'] },
  { version: '3.39.0', items: ['Mode « tout autoriser » pour la session (/mode tout)'] },
  { version: '3.38.0', items: ['Supprimer une conversation depuis l\'horloge (✕), toujours confirmé'] },
  { version: '3.37.0', items: ['Revenir à un message (↺) et palette de réglages dans l\'IDE', '/update en un clic'] },
];

/** les n nouveautés les plus récentes → [{ version, text }] */
export function latestNews(n = 3) {
  return WHATS_NEW.flatMap(v => v.items.map(text => ({ version: v.version, text }))).slice(0, n);
}
