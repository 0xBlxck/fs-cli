// « Quoi de neuf » : affiché à l'accueil du terminal et du panneau, en entier avec /nouveautes.
// Une ligne = une nouveauté visible, en mots simples. La version la plus récente en premier.
export const WHATS_NEW = [
  { version: '3.55.2', items: [
    '`/theme` : aperçu en direct, le thème change pendant que tu bouges avec les flèches (réponse, cadre et barre du bas montrés), Échap revient à l’ancien',
    '`/model` : une seule commande, avec le menu à flèches classé du plus puissant au moins puissant (`/models` fait la même chose)',
  ] },
  { version: '3.55.1', items: [
    'Barre du bas : le budget de chat restant (la limite du site qui bloque les messages) à côté du contexte restant, aussi en fin de réponse ; jaune à 25 %, rouge à 10 %',
  ] },
  { version: '3.55.0', items: [
    'Consommation réduite : environ un tiers de contexte en moins par session (mesuré en vrai, même résultat)',
    'Sorties de commandes trop longues : lignes répétées regroupées, erreurs et avertissements toujours gardés (un build bavard passe de 12 000 à 1 300 caractères) ; sorties de tests condensées',
    'Liste de tâches : le modèle n’écrit plus que les étapes qui changent, FS-CLI affiche toujours la liste complète à jour',
    'Le modèle sait que tes commandes passent par PowerShell (fini les « && » qui échouent sous Windows PowerShell 5.1)',
  ] },
  { version: '3.54.4', items: [
    '/resume : toutes tes conversations dans chaque onglet (avant : 14 au plus), la liste défile aux flèches',
  ] },
  { version: '3.54.3', items: [
    '`/effort` : réglette ← → comme dans Claude Code ; `/model`, `/mode` et `/theme` sans valeur ouvrent un menu à flèches ; après l’espace, les valeurs possibles sont proposées',
    'Réponses du modèle comme dans Claude Code : « ● » en tête, texte passé à la ligne proprement (plus de mots coupés au bord), retrait aligné, listes et tableaux alignés',
    'Accueil du terminal : les nouveautés passent à la ligne au lieu d’être coupées avec « … » ; plus de doubles lignes vides ni de ligne vide en fin de diff',
  ] },
  { version: '3.54.2', items: [
    '`fs-cli update` sous Windows : le panneau des éditeurs s’installe (avant : « C:\\Program n’est pas reconnu »)',
  ] },
  { version: '3.54.1', items: [
    'Menu de `/fs:conversations` et de `--fs-conversations` plus lisible : titres sans étiquette technique, 2e ligne = modèle et date',
  ] },
  { version: '3.54.0', items: [
    '`fs-cli claude` utilise tes serveurs MCP (Roblox Studio, Blender, leboncoin…) : nomme le serveur dans ta demande, le modèle appelle ses outils via fs-mcp',
    'Serveurs MCP gardés par défaut dans `fs-cli claude` (`--fs-mcp=off` pour les couper) ; GPT Astra refuse les MCP, prends un modèle Claude',
  ] },
  { version: '3.53.0', items: [
    'Plus jamais de changement de modèle à ta place : quand le modèle refuse les outils, un menu te propose de relancer avec Claude Sonnet ou Opus (ou rien)',
    '`/team` avec GPT Astra : tu choisis le modèle des agents (Sonnet, Opus ou Astra quand même) ; ta conversation garde le sien',
    '`fs-cli claude` : après un refus, la passerelle te dit de choisir un autre modèle avec /model au lieu de basculer seule sur Sonnet',
  ] },
  { version: '3.52.2', items: [
    'GPT Astra : quand il refuse les outils, la demande part tout de suite chez Claude Sonnet (la « précision » ne le faisait jamais changer d’avis, une requête de gagnée)',
    '`/team` (ou « lance multi agent ») avec GPT Astra : les agents travaillent avec Claude Sonnet, Astra refusant les tâches d’une équipe d’agents',
  ] },
  { version: '3.52.1', items: [
    '`fs-cli claude` te prévient aussi quand une nouvelle version sort (comme FS-CLI et le bouton ⬆ du panneau) : `fs-cli update` pour tout mettre à jour',
    'Pare-feu de France Student (403) : nouvel essai tout seul ; s’il refuse le contenu d’un fichier lu, le modèle reçoit « contenu non transmis » et la demande continue au lieu de s’arrêter',
  ] },
  { version: '3.52.0', items: [
    '`fs-cli update` : tout se met à jour en une commande (FS-CLI, `fs-cli claude` et le panneau de tes éditeurs)',
    '`fs-cli claude --fs-conversations` : menu à flèches, tes projets du site puis leurs conversations (5 visibles, ça défile)',
    '`/fs:conversations` dans Claude Code : choix aux flèches (projets, puis conversations 3 par page avec « Suivantes ▸ ») ; toutes tes conversations, projets compris',
  ] },
  { version: '3.51.0', items: [
    'Dans `fs-cli claude` : `/fs:conversations` liste tes conversations France Student, `/fs:reprendre 3` continue la n° 3 ici, sans relancer Claude Code',
    'Ces commandes ne coûtent ni requête au modèle ni conversation ; le modèle se souvient de la conversation reprise',
  ] },
  { version: '3.50.0', items: [
    '`fs-cli claude --fs-conversations` : reprends dans Claude Code une conversation du site France Student (liste, tu tapes le numéro) ; avec `--fs-projet`, celles du projet',
    '`fs-cli claude --fs-conversation "TP nmap"` : directement par un mot du titre ; le modèle se souvient de tout, aucune nouvelle conversation créée',
  ] },
  { version: '3.49.2', items: [
    '`fs-cli claude --fs-projet <id>` et `/projet <id>` : l\'identifiant trouve le projet (avant : un projet nommé comme l\'identifiant était créé)',
  ] },
  { version: '3.49.1', items: [
    'Erreur 403 : la vraie raison donnée par France Student est affichée (avant : « token invalide ? », souvent faux) ; pare-feu Cloudflare reconnu et expliqué',
    'Erreur 401 : « reconnecte-toi avec fs-cli --login » directement dans le message',
  ] },
  { version: '3.49.0', items: [
    '`fs-cli claude --fs-garder --model gpt-6-astra --fs-projet "Mon projet"` : tes options sont enregistrées, ensuite `fs-cli claude` tout court suffit',
    '`fs-cli claude --fs-garder` seul montre tes réglages, `--fs-oublier` les efface',
  ] },
  { version: '3.48.2', items: [
    'GPT-6 Astra avec la recherche web : quand OpenAI échoue juste après la recherche (erreur 502), la demande repart toute seule sans recherche web',
  ] },
  { version: '3.48.1', items: [
    '`fs-cli claude` : quand GPT-6 Astra met le site dans le panneau du site France Student, il est écrit dans le dossier demandé (ou le chemin cité par le modèle)',
    'Plus de « C’est fait » quand l’écriture du fichier a été refusée : la passerelle dit ce qui n’a pas été écrit',
  ] },
  { version: '3.48.0', items: [
    'Claude Code avec ton compte France Student : `fs-cli claude` (le modèle FS, les outils et l\'interface de Claude Code)',
    '`fs-cli gateway` : la passerelle seule, pour brancher Claude Code lancé à la main ou depuis VS Code',
    'Tes serveurs MCP sont coupés dans `fs-cli claude` (le modèle FS ne s’en sert pas) : `--fs-mcp` pour les garder',
    'Attention : `fs-cli claude` lance désormais Claude Code ; pour envoyer le mot « claude » comme demande, tape `fs-cli -- claude`',
  ] },
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
