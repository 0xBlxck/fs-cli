# FS-CLI

Client terminal **communautaire et non officiel** pour [France Student AI](https://ia.francestudent.org) : un agent qui lit, cherche, édite des fichiers et lance des commandes **sur ta machine**, avec de vrais appels d'outils, des confirmations, une mémoire par projet, des serveurs MCP et plusieurs modèles.

> *English: an unofficial community terminal client for France Student AI — a coding agent using the platform's official client-tools API, with permissions, per-project memory and MCP. Zero dependencies, Node.js ≥ 20, French UI.*

> ⚠️ **Non affilié à France Student.** Tu utilises ton propre compte et ton propre token ; respecte les conditions d'utilisation de la plateforme. Le logiciel est fourni « tel quel », sans garantie (licence MIT). Il exécute des commandes sur ton ordinateur : lis la section [Sécurité](#sécurité).

## Fonctions

- **Agent natif** : le modèle appelle les outils officiels « outils client » de FS (`list_directory`, `read_file`, `search_files`, `edit_file`, `write_file`, `run_command`) ; le CLI les exécute puis renvoie les résultats.
- **Interface type Claude Code** : zone de saisie ancrée en bas de la fenêtre, suggestions `/` et `@`, menus de confirmation à flèches, file d'attente de messages, modes *auto / confirmer / plan* (Maj+Tab).
- **Sécurité par défaut** : filtre de commandes (refus / confirmation / autorisation), détection de secrets avant écriture, chemins limités au dossier de travail, anti-SSRF pour le web, token hors de l'environnement des programmes lancés.
- **Mémoire** : notes par dossier, préprompt, faits appris, compétences (`skills`), `/compact` automatique avant que le contexte soit plein.
- **Plusieurs agents** : `/team` fait travailler des agents à la suite dans **la même conversation**, ou en parallèle dans des conversations réutilisées ; `/compare` pose la même question à deux modèles.
- **MCP** : serveurs MCP (stdio et HTTP) avec presets ; un `.mcp.json` de projet ne démarre qu'après `/mcp trust`.
- **Conversations rangées** : sur le site, les conversations du CLI sont regroupées dans le projet **FS-CLI** (`/fr-project <nom>` pour un autre, `/fr-project off` pour désactiver).
- **Instructions du projet** : `/init` crée `FSCLI.md` (ou utilise un `AGENTS.md` existant), lu au début de chaque conversation.
- **Fichiers protégés** : le modèle ne peut pas écraser un fichier modifié depuis sa dernière lecture (il doit le relire) ; écritures atomiques, jamais de fichier à moitié écrit.
- **Confiance par dossier** : à la première ouverture d'un dossier, le CLI demande si tu lui fais confiance.
- **Ctrl+C** arrête aussi la génération côté serveur (elle ne continue pas en arrière-plan).
- **Zéro dépendance** (rien à `npm install`), pas de télémétrie.

## Installation

Prérequis : **Node.js ≥ 20**. Testé sous **Windows 11 + PowerShell** ; Linux/macOS (bash) devraient fonctionner mais ne sont pas testés en continu.

```bash
git clone https://github.com/0xBlxck/fs-cli.git
cd fs-cli
cp .env.example .env        # Windows (cmd) : copy .env.example .env
```

### Ton token (à faire toi-même, une seule fois)

Le CLI a besoin de **ta** session France Student. Personne ne peut te la fournir et tu ne dois la donner à personne.

1. Connecte-toi sur <https://ia.francestudent.org>.
2. Ouvre les outils de développement du navigateur (F12) → **Application** (Chrome) ou **Stockage** (Firefox) → **Cookies** → `ia.francestudent.org`.
3. Copie la valeur du cookie `next-auth.session-token`.
4. Colle-la dans le fichier `.env` : `FS_SESSION_TOKEN=la-valeur-copiée`.

> 🔐 Ce token **est** ton mot de passe de session : ne le partage pas, ne le commite pas (`.env` est dans `.gitignore`), ne le colle pas dans un ticket ou une capture d'écran. S'il a fuité, déconnecte-toi puis reconnecte-toi sur le site.
> Tu peux aussi le fournir par variable d'environnement (`FS_SESSION_TOKEN`) ou dans `~/.fs-cli/.env`.

### Lancer

```bash
node cli.js                  # session interactive
node cli.js -c               # reprend la dernière session du dossier
node cli.js -p "résume ce dossier"   # une demande, puis quitte
node cli.js --help
```

## Utilisation

Tape ta demande : le modèle explore, édite et lance des commandes en demandant ton accord quand c'est sensible.

**Pas besoin de connaître les commandes** : parle normalement, le CLI comprend.

| Tu écris | Le CLI fait |
|---|---|
| « fais un site de café avec plusieurs agents » | lance une équipe d'agents (`/team`) |
| « … avec 3 agents en parallèle, et relis le résultat » | 3 agents en même temps + relecture |
| « compare gpt et claude sur … » | pose la question aux deux modèles (`/compare`) |
| « retiens que je code en TypeScript » | l'enregistre dans la mémoire du dossier (`/remember`) |
| « combien de conversations il me reste ? » | affiche ton compteur du jour (`/chats`, `/quota`) |
| « résume https://… » | lit la page et la joint à ta demande |

Dis « sans agents » pour l'éviter ; `/intent off` désactive cette compréhension automatique.

| Raccourci | Action |
|---|---|
| Entrée / `\` + Entrée · Ctrl+J | envoyer / nouvelle ligne (le collage multi-ligne est géré) |
| Maj+Tab | mode **auto** → **confirmer** → **plan** (rien n'est exécuté) |
| Échap · Ctrl+C | interrompre · effacer ; deux fois Ctrl+C pour quitter |
| `/` · `@` · `!cmd` | commandes · joindre un fichier · commande shell directe |
| ↑ ↓ · Ctrl+R | historique · recherche dans l'historique |

`/help` liste tout. Les principales : `/model` `/new` `/resume` `/compact` `/context` `/quota` `/team` `/compare` `/mcp` `/permissions` `/remember` `/memory` `/skills` `/project` `/tree` `/index` `/search` `/fetch` `/undo` `/chats`.

### Moteur natif et mode « chat »

Par défaut le moteur **natif** utilise l'API officielle d'outils client de FS (modèles Claude et GPT ; pas Gemini). Si ton compte ou ton modèle ne les gère pas, le CLI repasse seul en mode **chat** : le modèle écrit du code dans sa réponse et le CLI l'exécute avec les mêmes garde-fous. `/engine native|chat` pour choisir.

Chaque envoi de résultats d'outils est **une requête de chat** : elle compte dans les limites de messages et le budget quotidien de ton compte (la ligne de fin de tour affiche le nombre de requêtes).

### Conversations (limite de FS : 50 nouvelles par jour)

Une session = **une conversation**. `/team` travaille dans cette conversation (`--same`, défaut) ou dans des conversations réutilisées (`--pool`). Les titres sont étiquetés `[7f3a] …` ; `/chats` montre qui appartient à quoi et le compteur du jour ; `/clean` supprime celles des agents (après confirmation).

## Sécurité

Résumé — le détail et le modèle de menace sont dans [SECURITY.md](SECURITY.md).

- Le token n'est envoyé qu'à `api.francestudent.ai` (HTTPS), n'est jamais journalisé, et **n'est pas hérité** par les commandes, scripts Python et serveurs MCP que le CLI lance.
- Le `.env` du dossier courant n'est **jamais lu** (un dépôt piégé ne peut pas modifier ton environnement) ; seules quelques clés `FS_*` sont acceptées.
- Chaque commande est analysée : **refus net** (formatage de disque, code téléchargé puis exécuté, `git push --force`, suppression de la racine ou du dossier personnel…), **confirmation** (suppressions, `git push`, installations globales, fichiers `.env`/clés…) ou **autorisation**.
- Écrire un secret dans un fichier, sortir du dossier de travail ou écraser un fichier existant demande confirmation.
- Le contenu de fichiers ou de pages web peut contenir des instructions hostiles (prompt injection) : en cas de doute, utilise le mode **confirmer** (Maj+Tab).
- Un `.mcp.json` de projet ne démarre rien sans `/mcp trust` (approbation liée au contenu du fichier).
- Limites : l'analyse des commandes est heuristique ; le CLI agit avec **tes** droits ; une commande autorisée peut envoyer des données sur Internet. Liste complète dans [SECURITY.md](SECURITY.md#limites-connues-à-lire).

## Développement

```bash
npm test         # tests unitaires et sécurité (Windows + PowerShell)
npm run scan     # cherche tokens, clés, e-mails, chemins personnels dans les fichiers suivis
git config core.hooksPath .githooks   # bloque tout commit contenant un secret
```

Les tests n'appellent pas la vraie API (faux serveurs, terminal simulé). Voir [CONTRIBUTING.md](CONTRIBUTING.md).

## Structure

| Fichier | Rôle |
|---|---|
| `cli.js` | point d'entrée, commandes de base, sessions |
| `src/native.js` | moteur natif (outils client officiels) |
| `src/agent.js` | exécution des outils, confirmations, mode chat de secours |
| `src/permissions.js` | politique de commandes, règles, détection de secrets |
| `src/tui/` | interface (saisie ancrée, rendu, clavier) |
| `src/api.js` · `src/config.js` | client de l'API FS, configuration |
| `src/mcp.js` · `src/web.js` | client MCP · lecture web sûre et recherche |
| `src/team.js` · `src/chats.js` | agents multiples, gestion des conversations |
| `src/memory.js` · `src/extra-commands.js` | mémoire, commandes supplémentaires |

## Licence

MIT — voir [LICENSE](LICENSE) et [THIRD_PARTY.md](THIRD_PARTY.md).
