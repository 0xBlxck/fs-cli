# Sécurité

## Signaler une vulnérabilité

Utilise **« Report a vulnerability »** (onglet *Security* du dépôt, signalement privé). N'ouvre **pas** de ticket public pour une faille.
**N'envoie jamais ton token de session**, ni dans un ticket, ni dans un message, ni dans une capture d'écran : personne n'en a besoin pour corriger un problème.

## Ce que FS-CLI manipule

| Donnée | Où | Protection |
|---|---|---|
| Ton token de session France Student (`FS_SESSION_TOKEN`) | un fichier `.env` **que tu crées toi-même** (ou une variable d'environnement) | lu au démarrage puis **retiré de l'environnement** : les commandes du modèle, Python et les serveurs MCP lancés par le CLI ne le voient pas. Envoyé **uniquement** à `api.francestudent.ai` en HTTPS. Jamais écrit dans un journal ni affiché. `.env` est dans `.gitignore`. |
| Sessions, historique, mémoire, règles « toujours autoriser » | `~/.fs-cli/` | fichiers locaux, jamais envoyés ailleurs |
| Contenu de tes messages et des fichiers que tu joins | envoyé à France Student comme n'importe quel message | — |

FS-CLI n'a **pas de télémétrie** et **aucune dépendance** (pas de chaîne d'approvisionnement npm).

## Modèle de menace

Un modèle de langage peut être manipulé (prompt injection : un fichier, une page web ou un résultat d'outil contenant des instructions hostiles). Le CLI part donc du principe que **ce que le modèle demande n'est pas digne de confiance** :

- **Politique de commandes** (`src/permissions.js`, plus de 300 vérifications automatiques) : chaque commande ou script est classé *safe*, *ask* (confirmation) ou *deny* (refus net : formatage de disque, code téléchargé puis exécuté, `git push --force`, suppression de la racine ou du dossier personnel…). Une règle « toujours autoriser » ne peut **jamais** lever un *deny*.
- **Secrets** : écrire une clé API ou un token dans un fichier demande confirmation.
- **Chemins** : tout accès hors du dossier de travail ou à un fichier sensible (`.env`, `.ssh`, clés…) demande confirmation. Un fichier existant n'est jamais écrasé sans accord.
- **Réseau** : `/fetch` et l'outil web refusent les adresses locales/privées et les redirections vers elles (anti-SSRF, IP vérifiée et épinglée).
- **MCP** : tu configures toi-même les serveurs ; ils ne démarrent qu'à l'usage. Un `.mcp.json` trouvé dans un dossier de projet ne démarre **rien** tant que tu n'as pas lancé `/mcp trust` (commandes, `env` et `headers` te sont montrés) ; l'approbation est liée au **contenu** du fichier : s'il change, elle tombe.
- **Import depuis d'autres assistants** (`/import`) : FS-CLI **lit** (sans jamais les modifier) les configurations MCP de Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI et Windsurf de *ton* dossier personnel, ainsi que les skills `SKILL.md`. Seuls des fichiers de ton profil utilisateur sont lus (un dépôt cloné ne peut pas injecter de serveur par ce biais). Le modèle y accède par le programme `fs-mcp` (lancé avec `run_command`, donc soumis à la même politique de commandes). Un serveur importé **ne peut pas être démarré tant que tu ne l'as pas autorisé** dans FS-CLI (sa commande t'est montrée) : `fs-mcp` refuse sinon. L'accord est lié à la commande du serveur (si elle change, il tombe) et stocké dans `~/.fs-cli`, que le modèle ne peut pas modifier sans ta confirmation. Les variables d'environnement de ces serveurs (clés d'API) servent uniquement à les lancer : elles ne sont **jamais envoyées au modèle**. Le modèle peut lire les fichiers des skills sans confirmation (lecture seule). `/import off` désactive tout.
- **Pont de session** : pour que les serveurs MCP restent ouverts entre deux actions (navigateur…), `fs-mcp` passe ses appels à la session FS-CLI par un pont local. Il écoute uniquement sur `127.0.0.1`, exige un jeton aléatoire propre à la session (transmis aux seules commandes lancées par le CLI, jamais aux serveurs MCP), refuse les appels venant d'une page web, et applique les mêmes accords que `fs-mcp`.
- **Navigateur** : en mode `/navigateur chrome`, le modèle agit dans TON Chrome avec tes comptes connectés : réserve-le aux tâches où tu surveilles ce qu'il fait, et passe en mode **confirmer** si besoin.
- **Terminal** : les séquences de contrôle (titre de fenêtre, presse-papiers, liens…) contenues dans une réponse du modèle ou une sortie de commande sont retirées avant affichage.
- **Réseau du CLI** : le User-Agent annonce honnêtement `fs-cli` ; aucune télémétrie.

### Limites connues (à lire)

- L'analyse des commandes est **heuristique**, pas un vrai interpréteur : elle ne voit pas le contenu d'un script lancé par chemin ni les alias définis à la volée. Le mode **confirmer** (Maj+Tab) demande l'accord pour chaque action.
- Le mode « auto » exécute les commandes non dangereuses sans demander : choisis le mode adapté à ton niveau de confiance.
- **Exfiltration réseau** : une commande autorisée (ex. `curl`, `Invoke-WebRequest`) peut envoyer des données vers Internet ; la politique demande confirmation pour les cas évidents, mais ne peut pas tout deviner.
- **Variables d'environnement** : les commandes lancées héritent de ton environnement (sauf le token FS et la clé de recherche, retirés). Évite de lancer le CLI avec des secrets exportés dans le shell.
- **Liens symboliques / jonctions** : l'accès aux fichiers est comparé au chemin réel, mais le contenu d'un script lancé par chemin n'est pas lu.
- **Mode « chat »** (repli si le moteur natif est indisponible) : le modèle écrit des blocs de code que le CLI exécute ; la même politique s'applique, mais le moteur **natif** (outils clients officiels) reste le plus encadré.
- **`npx` / `uvx` / `pipx run` / `deno run <url>`** téléchargent du code distant : ils demandent toujours confirmation.
- **Clé de recherche web** (`FS_SEARCH_API_KEY`, optionnelle) : lue au démarrage puis retirée de l'environnement ; elle n'est envoyée qu'au moteur de recherche choisi.
- Le CLI exécute des commandes **sur ta machine, avec tes droits**. Ne le lance pas dans un dossier contenant des données que tu ne veux pas exposer au modèle.

## Hygiène du token

Traite `FS_SESSION_TOKEN` comme un mot de passe : ne le partage pas, ne le commite pas, ne le colle pas dans un ticket. Si tu penses qu'il a fuité, déconnecte-toi puis reconnecte-toi sur ia.francestudent.org pour obtenir une nouvelle session.
Avant de contribuer : `npm run scan` (et le hook `.githooks/pre-commit`) cherche tokens, clés, e-mails et chemins personnels dans ce que tu commites.
