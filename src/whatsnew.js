// « Quoi de neuf » : affiché à l'accueil du terminal et du panneau, en entier avec /nouveautes.
// Une ligne = une nouveauté visible, en mots simples. La version la plus récente en premier.
export const WHATS_NEW = [
  { version: '3.47.1', items: [
    'On voit le modèle travailler : « recherche sur le web… », « le modèle écrit un document · 12,4k caractères »',
    'Recherches web affichées (requête et nombre de sources), marqueurs « citeturn… » retirés du texte',
    'Listes de tâches qui se collaient (« …aperçu.- [x] étape ») remises à la ligne',
    'Site créé par le modèle : « OFFGRID — index.html » écrit dans index.html, page sans nom → index.html',
  ] },
  { version: '3.47.0', items: [
    'Un fichier existant jamais lu n\'est plus écrasé à l\'aveugle : le modèle le lit d\'abord',
    'Recherche plus intelligente : casse ignorée en minuscules, .gitignore respecté, plus de blocage',
    'Projets : chaque conversation reçoit les instructions de SON projet ; /team reçoit le contexte',
    'IDE : questions en file sans voler le clavier, « Demander à FS-CLI » ouvre le panneau',
    'Terminal : ↑ dans un long message, emojis, Ctrl+O complet, fs -p sans codes couleur',
    'MCP : une conversation par dossier pour fs_agent, nouvelle clé prise en compte, aide si GPT refuse',
  ] },
  { version: '3.46.2', items: [
    'Moins de tokens : sélection de l\'IDE, pages web et outils MCP envoyés une seule fois par conversation',
    'Index des skills un tiers plus léger ; conversation du MCP renouvelée au-delà de 60 000 tokens',
    'Limite d\'étapes : le modèle ne refait plus des actions déjà faites',
    'Coupure réseau : FS-CLI ne reste plus bloqué ; /new repart vraiment de zéro',
    'Terminal : menus trop grands défilent (Annuler toujours visible), Échap ×2 pour effacer la saisie (↑ la rend)',
    'IDE : une confirmation ne se cache plus derrière une fenêtre',
  ] },
  { version: '3.46.1', items: [
    'Recherche dans les fichiers : les .env et clés ne sont plus jamais lus ni envoyés',
    'Fichiers en Latin-1 / Windows-1252 (CSV d\'Excel…) et UTF-16 modifiés sans abîmer les accents',
    'Menus : « 10 » choisit bien l\'option 10 (Entrée valide), /rewind présélectionne « Annuler »',
    'Deux confirmations en même temps (/team) ne bloquent plus le CLI',
    'Hors ligne, /resume ne cache plus de conversations (celles cachées à tort réapparaissent)',
    'IDE : le fichier ouvert ne change plus le dossier où le modèle écrit',
  ] },
  { version: '3.46.0', items: [
    'Mac : coller une image marche (Ctrl+V), photos .heic converties, couleurs correctes dans Terminal',
    'Mac/Linux : plus de blocage quand une commande lance un sous-processus ; serveurs bien arrêtés',
    'Mac : installation sans sudo, /doctor qui vérifie Rosetta et npm, panneau qui trouve Node depuis le Dock',
    'L\'index des skills s\'ouvre sans demander de confirmation',
    'Moins de faux « refus » détectés (plus de requêtes ni de conversations gâchées)',
    'run_command dans un autre dossier : jugé pour ce dossier, confirmation hors du projet',
  ] },
  { version: '3.45.2', items: [
    'Mac : raccourcis du Mac (Ctrl+V pour coller une image, Cmd+Maj+P), page Chrome ouverte dans Chrome',
    'Fermer le Terminal arrête proprement les serveurs lancés par l\'agent',
    'Sécurité Mac : confirmation pour AppleScript, launchctl, trousseau… ; disque externe entier jamais approuvé',
  ] },
  { version: '3.45.1', items: [
    'fs-cli --install-mcp : aussi VS Code (Copilot), opencode, Cursor, Claude Desktop, Windsurf, Gemini CLI',
  ] },
  { version: '3.45.0', items: [
    'GPT ne refuse plus de travailler (« moteur d\'un agent externe ») : 1er message allégé',
    'Skills : la liste est ouverte par le modèle quand il en a besoin (≈ 6 500 tokens de moins)',
    'Si GPT refuse quand même : nouvel essai tout seul dans une conversation neuve',
  ] },
  { version: '3.44.1', items: [
    'Skills : plus de skill hors sujet joint par mot-clé, le modèle choisit d\'après les descriptions',
  ] },
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
