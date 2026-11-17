# FS-CLI

**Un agent de code pour [France Student AI](https://ia.francestudent.org), dans ton terminal.** Tu lui parles normalement (« fais-moi un site de café », « corrige le bug dans script.js ») : il lit tes fichiers, les crée ou les modifie et lance des commandes **sur ton PC**, en te demandant ton accord quand c'est sensible.

Gratuit, open source, sans dépendance et sans télémétrie. Interface en français.

> *English: an unofficial community terminal client for France Student AI — a coding agent built on the platform's official client-tools API, with sub-agents, permissions, per-project memory and MCP. Zero dependencies, Node.js ≥ 20, French UI.*

> ⚠️ **Projet communautaire, non affilié à France Student.** Tu utilises ton propre compte : respecte les conditions d'utilisation de la plateforme. Logiciel fourni « tel quel », sans garantie (licence MIT). Il exécute des commandes sur ton ordinateur : lis la section [Sécurité](#sécurité).

---

## Installation (5 minutes, Windows)

**1. Installe Node.js** (une seule fois) : version **LTS** sur <https://nodejs.org>, ou dans PowerShell :

```powershell
winget install OpenJS.NodeJS.LTS
```

Ferme puis rouvre le terminal. Sur un Windows neuf, autorise aussi les scripts de npm (une seule fois, réponds `O`) :

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**2. Installe FS-CLI :**

```powershell
npm install -g https://github.com/0xBlxck/fs-cli/archive/refs/heads/main.tar.gz
```

**3. Lance-le dans le dossier de ton projet :**

```powershell
cd "C:\chemin\vers\ton projet"
fs-cli
```

Au premier lancement, un **assistant** connecte ton compte France Student : il ouvre le site, t'explique où copier ta clé de session (F12 → *Application* → *Cookies* → `next-auth.session-token`), la vérifie et l'enregistre sur ton PC (`~/.fs-cli/.env`). Rien à éditer à la main. Il te demande ensuite si tu fais confiance au dossier.

> 🔐 **Ta clé de session = ton mot de passe.** Ne la donne à personne, ne la colle pas dans un ticket ou une capture d'écran. Si elle a fuité : déconnecte-toi puis reconnecte-toi sur le site, et lance `fs-cli --login`.

| Besoin | Commande |
|---|---|
| Mettre à jour | relance la commande de l'étape 2 (FS-CLI te prévient quand une nouvelle version sort) |
| Changer de compte / clé expirée | `fs-cli --login` |
| Reprendre la dernière session du dossier | `fs-cli -c` |
| Une seule demande, puis quitter | `fs-cli -p "résume ce dossier"` |
| Vérifier que tout marche | `fs-cli` puis `/doctor` |
| Désinstaller | `npm uninstall -g fs-cli` (tes réglages restent dans `~/.fs-cli`) |

Linux et macOS devraient fonctionner (bash) mais ne sont pas testés en continu.

---

## Premiers pas

Tape ta demande et appuie sur Entrée. **Pas besoin de connaître les commandes** : le CLI comprend les demandes courantes.

| Tu écris | Ce qui se passe |
|---|---|
| « crée un site de café avec une page menu » | le modèle crée les fichiers dans ton dossier |
| « fais ce site avec plusieurs agents » | une **équipe d'agents** se partage le travail |
| « … avec 3 agents en parallèle, et relis le résultat » | 3 agents en même temps, puis une relecture |
| « compare gpt et claude sur … » | la même question posée à deux modèles |
| « retiens que je code en TypeScript » | enregistré dans la mémoire du dossier |
| « combien de conversations il me reste ? » / « mon quota ? » | ton compteur du jour / ta consommation (`/usage`) |
| « résume https://exemple.fr/article » | la page est lue et jointe à ta demande |

Dis « sans agents » pour l'éviter ; `/intent off` désactive cette compréhension automatique.

### Les 4 modes (Maj+Tab)

| Mode | Comportement |
|---|---|
| **auto** | agit sans demander pour ce qui n'est pas dangereux ; demande pour les actions sensibles |
| **modifs auto** | modifie les fichiers sans demander, mais te demande avant chaque commande |
| **confirmer** | demande ton accord avant chaque écriture et chaque commande |
| **plan** | lecture seule : il explore et propose un plan, **rien n'est modifié** (`/plan <demande>` pour une seule demande) |

### Raccourcis

| Touche | Action |
|---|---|
| Entrée · `\` + Entrée · Ctrl+J | envoyer · nouvelle ligne (le collage multi-ligne est géré) |
| Échap · Ctrl+C | interrompre (la génération s'arrête aussi côté serveur) · effacer ; deux fois Ctrl+C pour quitter |
| `/` · `@fichier` · `!commande` | commandes · joindre un fichier · commande shell directe |
| **Alt+V** | coller une image (capture Win+Maj+S…) ; glisser-déposer une image ou `@image.png` marche aussi |
| ↑ ↓ · Ctrl+R | historique · recherche dans l'historique |
| `?` · `# info` | afficher les raccourcis · retenir une info en mémoire |
| Ctrl+O | déplier les sorties résumées et la pensée du modèle |
| Échap × 2 | revenir en arrière (état des fichiers avant une demande) |

---

## Extension VS Code (aussi Cursor, Windsurf, Antigravity)

Le même agent dans un panneau de chat de ton éditeur :

- Le fichier ouvert et ton code sélectionné sont joints à la demande.
- Les diffs s'affichent dans le panneau, et tu peux les ouvrir dans le diff de l'éditeur.
- Les confirmations se font en un clic.
- Un bilan des fichiers modifiés, avec **Annuler** par fichier.
- Les tâches, le modèle et le mode sont accessibles en un clic.

L'extension est livrée avec FS-CLI. Pour l'installer, tape **`/vscode`** dans FS-CLI (ou `fs-cli --vscode` dans un terminal) : il trouve tes éditeurs (VS Code, Cursor, Windsurf, Antigravity) et l'y installe. Recharge ensuite la fenêtre de l'éditeur.

Sans le CLI sous la main, tu peux aussi télécharger `fs-cli-vscode-*.vsix` dans les [releases](https://github.com/0xBlxck/fs-cli/releases), puis dans l'éditeur : Extensions › **⋯ › Installer depuis un VSIX…**.

Pour l'ouvrir : l'icône ✻ dans la barre latérale, ou **Ctrl+Alt+I** pour un onglet. Pour envoyer la sélection : **Ctrl+Alt+K**, ou clic droit › *Demander à FS-CLI*.

---

## Utiliser France Student depuis un autre agent (Claude Code, VS Code, opencode, Cursor, Antigravity…)

FS-CLI peut servir de **serveur MCP** : un autre agent (Claude Code, Claude Desktop, VS Code avec Copilot, opencode, Cursor, Windsurf, Codex, Gemini CLI, Antigravity…) peut alors interroger les modèles France Student ou leur confier une tâche de code. Les modèles FS y apparaissent comme des **outils** (pas comme le modèle principal de l'agent).

```bash
fs-cli --install-mcp
```

Cette commande ajoute le serveur **`france-student`** (`node <chemin>/cli.js --mcp`) dans la configuration des agents trouvés sur ton PC :

| Agent | Fichier modifié |
|---|---|
| Antigravity (application) | `~/.gemini/config/mcp_config.json` |
| Antigravity (éditeur) | `~/.gemini/antigravity-ide/mcp_config.json` |
| Claude Code | `~/.claude.json` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows) · `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) |
| Codex | `~/.codex/config.toml` |
| VS Code (Copilot, mode agent) | `~/.copilot/mcp-config.json` |
| opencode | `~/.config/opencode/opencode.json` (`mcp` › `servers`) — un `opencode.jsonc` à commentaires n'est jamais modifié : la commande t'indique quoi ajouter |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` (seulement s'il existe déjà) |

Seule l'entrée `france-student` est ajoutée ou mise à jour : tes autres serveurs ne bougent pas, une copie `.bak` est faite avant chaque modification, et un fichier illisible n'est jamais touché. **Redémarre ensuite l'application de l'agent.** Pour Claude Code, ferme-le avant de lancer la commande, sinon il risque de réécrire son fichier par-dessus.

L'agent voit alors huit outils :

- **`fs_models`** : la liste des modèles France Student (id, nom, taille du contexte).
- **`fs_ask`** : pose une question à un modèle (sans accès à tes fichiers ; `web_search: true` pour qu'il cherche sur le web). Une seule conversation est réutilisée, même après un redémarrage, pour ne pas encombrer ton compte ni la limite de 50 nouvelles conversations par jour. `new_conversation: true` en démarre une nouvelle, `conversation_id` en vise une précise.
- **`fs_agent`** : lance le vrai agent FS-CLI dans un dossier (`task`, `folder` en chemin absolu, `model` facultatif). Il renvoie le compte rendu du modèle, les fichiers modifiés et le nombre d'appels d'outils. Il utilise la même conversation que `fs_ask`.
- **`fs_image`** : génère une image avec le meilleur modèle GPT du compte et la renvoie directement (`save_dir` pour l'enregistrer aussi).
- **`fs_web`** : répond à une question avec la recherche web de France Student (actualité, docs récentes, versions…).
- **`fs_files`** : fait analyser 1 à 5 fichiers du PC (images, PDF, code, Markdown, CSV, logs…). Les fichiers sensibles (`.env`, clés, mots de passe, dossiers système) sont toujours refusés.
- **`fs_conversations`** : liste tes conversations (celles du site et de tes projets comprises), en relit une, ou la choisit comme conversation du MCP.
- **`fs_usage`** : ce qu'il reste du budget du jour et des 50 nouvelles conversations.

**Choisir où le MCP parle** : au premier appel de chaque session, un IDE qui sait afficher des formulaires (Claude Code…) ouvre une fenêtre pour choisir la conversation (celle du MCP, une nouvelle, ou une de tes conversations du site) et le projet où la ranger. Ailleurs, ou pour régler ça une fois pour toutes : `/mcp conversation` dans fs-cli, puis redémarre l'agent.

Règles de sécurité de `fs_agent` (personne n'est là pour répondre aux confirmations) :

- Il ne travaille que dans un dossier **que tu as déjà approuvé** en l'ouvrant une fois avec `fs-cli`. L'agent qui l'appelle ne peut pas approuver un dossier lui-même.
- Les modifications de fichiers dans ce dossier sont permises.
- Tout ce qui demanderait ton accord est **refusé automatiquement** : commandes (toutes, par défaut), chemins protégés, secrets, écritures hors du dossier. La raison du refus est renvoyée au modèle et listée dans le résultat.
- Pour autoriser les commandes **sans danger** (les dangereuses restent refusées), ajoute `"env": { "FS_MCP_ALLOW_COMMANDS": "1" }` à l'entrée `france-student` de ton agent.

Il faut une clé de session France Student : si FS-CLI n'est pas encore connecté, lance `fs-cli` une fois dans un terminal.

---

## Fonctions

- **Agent natif** : le modèle utilise les outils officiels « outils client » de France Student (lire, chercher, écrire, éditer, lancer une commande) ; le CLI les exécute sur ton PC avec ses garde-fous.
- **Suivi des tâches** : sur une tâche longue, le modèle écrit son plan et le coche au fur et à mesure ; il reste affiché au-dessus de la zone de saisie (☐ à faire · ◐ en cours · ☑ fait).
- **Skills choisis automatiquement** : selon ta demande (« fais un beau site », « un tableur Excel », « ma lettre de motivation »…), FS-CLI joint tout seul le guide le plus adapté parmi tes skills installés.
- **Diff coloré** : chaque modification montre les lignes retirées (rouge) et ajoutées (vert), avec les numéros de ligne.
- **Mode plan** : le modèle propose un plan en lecture seule, puis te demande s'il doit l'appliquer (automatiquement ou en validant chaque action).
- **Commandes perso** : un fichier `ma-commande.md` dans `.fs-cli/commands/` (projet) ou `~/.fs-cli/commands/` devient `/ma-commande` (`$ARGUMENTS` = ce que tu tapes après). Tes commandes de Claude Code (`.claude/commands/`) marchent aussi.
- **Valider dans l'éditeur** : en mode « confirmer », chaque modification proposée s'ouvre dans le diff de l'éditeur avec Accepter / Refuser (panneau ou boutons ✓ / ✗ du diff). En mode auto ou « modifs auto », il fait tout seul.
- **Agents** : avec `/team`, le panneau suit chaque agent en direct (état, durée, tokens, résultat), avec une vue en arbre comme l'« Agent map » de Claude.
- **Images** : les modèles GPT de France Student génèrent des images ; elles s'affichent directement dans le panneau (bouton « Enregistrer… »), et sont renvoyées aux autres agents via le serveur MCP.
- **Contexte adapté au modèle** : résumé automatique à 200k tokens par message pour Claude (1M), ~80k pour GPT, 60k pour Haiku (`/autocompact 150k` pour choisir).
- **Sélecteur de modèle** groupé par fournisseur (Anthropic, OpenAI) avec logos et taille de contexte.
- **Bilan des fichiers** : après chaque demande, la liste des fichiers modifiés (+/− lignes) ; `/changes` montre le diff d'un fichier et permet de **l'annuler seul**.
- **Alerte** : quand l'agent attend ta réponse, le terminal bipe (la barre des tâches clignote) — tu peux faire autre chose pendant qu'il travaille.
- **Retour en arrière** : `/rewind` (ou « reviens en arrière ») remet tous les fichiers dans l'état d'avant la demande de ton choix.
- **Plusieurs agents** : `/team` répartit une tâche entre agents (jusqu'à 8), **à la suite dans la même conversation** (défaut) ou **en parallèle** ; `/compare` pose la même question à deux modèles.
- **Interface type Claude Code** : saisie ancrée en bas de la fenêtre, suggestions, menus à flèches, file d'attente de messages, code replié en une ligne.
- **Mémoire** : notes par dossier, préprompt, faits appris, compétences (`/skills`), compactage automatique avant que le contexte soit plein.
- **Instructions du projet** : `/init` crée `FSCLI.md` (ou utilise un `AGENTS.md` existant), lu au début de chaque conversation.
- **Projets France Student** : par défaut, tes conversations FS-CLI sont des **conversations normales**, visibles dans la liste du site. Au premier lancement, FS-CLI te demande si tu préfères les ranger dans un projet. `/projet` (ou « travaille dans mon projet Marketing ») choisit un projet : les conversations y sont rangées et le modèle suit ses **instructions personnalisées**. `/projet off` revient aux conversations normales.
- **Sur tous tes PC** : `/resume` et le menu Conversations montrent aussi les conversations de ton compte faites ailleurs (autre PC, site).
- **MCP avec compte (OAuth)** : pour un serveur qui demande une connexion (Meta Ads, Trendtrack…), tape `/mcp login <nom>` ou clique « Se connecter » dans la fenêtre Serveurs MCP. La page de connexion s'ouvre dans ton navigateur, et FS-CLI garde sa propre clé sur ton PC (`~/.fs-cli/mcp-oauth.json`), renouvelée toute seule. `/mcp logout <nom>` pour la retirer.
- **Commandes & skills** : le bouton « / » du panneau (ou `/skills`) liste tes skills du PC, tes commandes perso et les compétences France Student, avec un interrupteur On/Off. `/nom-du-skill ta demande` joint ce guide à la demande.
- **Serveurs locaux sans fenêtre** : « ouvre le site en local » lance le serveur en arrière-plan, sans fenêtre de console, et donne son adresse. `/jobs` le montre, `/jobs stop <n>` l'arrête, et il s'arrête aussi en quittant FS-CLI.
- **Images** : colle une capture avec **Alt+V** (ou `/image`), glisse-dépose une image dans le terminal, ou écris `@capture.png` : le modèle la voit.
- **Web** : une URL citée est lue automatiquement ; `/search` et `/fetch` (adresses locales refusées).
- **Tes outils déjà installés, automatiquement** : FS-CLI retrouve les serveurs **MCP** configurés dans Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI ou Windsurf, et les **skills** (`SKILL.md` de `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, plugins installés). Les skills adaptés à ta demande sont joints automatiquement (ou avec `/nom-du-skill`) ; un serveur MCP s'utilise quand tu le nommes (« avec le mcp leboncoin… »), via le programme **`fs-mcp`** installé avec FS-CLI. FS-CLI n'injecte pas de protocole d'outils dans tes messages : France Student le bloque, la voie officielle étant ses « outils client », que FS-CLI utilise. Les serveurs importés sont **actifs tout de suite** : ils viennent de tes propres réglages. Avec `/mcp ask on`, FS-CLI te demande ton accord avant le premier démarrage de chacun. Un `.mcp.json` trouvé dans un dossier de projet demande toujours ton approbation (`/mcp trust`). `/import` montre ce qui a été trouvé, `/import off` désactive.
- **Contrôle du navigateur, avec la vue** : `/navigateur` (une fois) et le modèle ouvre des pages, clique, remplit des formulaires, lit la console et le réseau… et **voit la page** grâce aux captures d'écran (design, bug visuel, vérification du résultat), comme Claude in Chrome. `/navigateur chrome` pour piloter **ton** Chrome avec tes comptes déjà connectés (extension « Playwright MCP Bridge »). L'extension affiche une ligne `PLAYWRIGHT_MCP_EXTENSION_TOKEN=…` : colle-la dans FS-CLI pour ne plus avoir à autoriser chaque connexion (elle reste sur ton PC, jamais envoyée au modèle).
- **MCP** : tes propres serveurs MCP (stdio et HTTP) avec presets (Blender, Playwright…).
- **Fichiers protégés** : le modèle ne peut pas écraser un fichier que tu as modifié depuis sa dernière lecture ; écritures atomiques ; `/undo` annule la dernière modification.

### Conversations et limites du compte

France Student limite à **50 nouvelles conversations par jour**. FS-CLI en utilise **une par session** : tous tes messages et toutes les actions de l'agent restent dans la même conversation, y compris `/team` en mode normal.

Créent une conversation en plus : `/new`, le compactage (`/compact`, ou automatique à 80 % de contexte), `/team --pool` (jusqu'à 3, réutilisées ensuite) et `/compare` (2, réutilisées). `/chats` montre ton compteur du jour et quelles conversations appartiennent à ta session.

Chaque envoi de résultats d'outils compte comme **une requête de chat** dans les limites de messages et le budget de ton compte (la fin de chaque tour affiche le nombre de requêtes).

### Moteur natif et mode « chat »

Le moteur **natif** fonctionne avec les modèles Claude et GPT (pas Gemini). Si ton compte ou ton modèle ne le gère pas, le CLI repasse seul en mode **chat** : le modèle écrit du code dans sa réponse et le CLI l'exécute avec les mêmes garde-fous. `/engine native|chat` pour choisir.

---

## Commandes

`/help` les liste toutes. Les plus utiles :

| Thème | Commandes |
|---|---|
| Éditeur | `/vscode` (panneau de chat dans VS Code, Cursor, Windsurf, Antigravity) |
| Conversation | `/usage` · `/changes` · `/messages` · `/plan <demande>` · `/rewind` · `/doctor` · `/new` · `/resume` · `/rename <titre>` · `/export [fichier.md\|.html]` · `/btw <question>` · `/model` · `/effort <niveau>` · `/compact` · `/context` · `/quota` · `/chats` · `/clean` · `/undo` |
| Automatisation | `fs-cli -p "<demande>" --max-turns N` · `/webhook <url>` (POST JSON à la fin de chaque demande) |
| Agents | `/team [-n N] [--pool] [--review] <tâche>` · `/teammode same\|pool` · `/parallel N` · `/workers <modèle>` · `/compare <question>` |
| Projet | `/init` · `/cd` · `/target` · `/tree` · `/index` · `/project` · `/fr-project` |
| Mémoire | `/remember` · `/forget` · `/memory` · `/preprompt` · `/profil` · `/skills` |
| Web et outils | `/navigateur` · `/search` · `/fetch` · `/mcp` · `/import` · `/jobs` · `!commande` |
| Sécurité | `/permissions` · `/mode auto\|edits\|ask\|plan` · `/intent on\|off` |

---

## Sécurité

Résumé ; le détail et le modèle de menace sont dans [SECURITY.md](SECURITY.md).

- **Ta clé** n'est envoyée qu'à `api.francestudent.org` (l’adresse du site officiel, en HTTPS), n'est jamais affichée ni journalisée, et **n'est pas transmise** aux commandes, scripts et serveurs MCP que le CLI lance.
- **Confiance par dossier** : le CLI demande avant d'agir dans un nouveau dossier. S'il doit écrire **en dehors** du dossier de travail, il te le demande une fois (« faire confiance à ce dossier » évite les questions suivantes).
- **Commandes analysées** : refus net (formatage de disque, code téléchargé puis exécuté, `git push --force`, suppression de la racine ou du dossier personnel…), confirmation (suppressions, `git push`, installations globales, `npx`…) ou autorisation.
- **Fichiers sensibles** (`.env`, clés, `.ssh`…) et **secrets** écrits dans un fichier : toujours une confirmation, même en mode auto.
- Le `.env` du dossier courant n'est **jamais lu** ; un `.mcp.json` de projet ne démarre rien sans `/mcp trust`.
- Les pages web et fichiers peuvent contenir des instructions hostiles (prompt injection) : en cas de doute, passe en mode **confirmer** ou **plan**.
- **Limites** : l'analyse des commandes est heuristique ; le CLI agit avec **tes** droits ; une commande autorisée peut envoyer des données sur Internet. Liste complète : [SECURITY.md](SECURITY.md#limites-connues-à-lire).

Une faille ? Signale-la en privé (onglet *Security* → *Report a vulnerability*), jamais dans un ticket public.

---

## Problèmes fréquents

| Problème | Solution |
|---|---|
| « l'exécution de scripts est désactivée sur ce système » (npm ou fs-cli) | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, puis réessaie (ou lance `fs-cli.cmd`) |
| `npm` ou `fs-cli` n'est pas reconnu | ferme et rouvre le terminal ; sinon vérifie que `npm config get prefix` est dans ton `PATH` |
| « clé de session expirée » / erreur 401 | `fs-cli --login` |
| « Limite de 50 nouvelles conversations par jour » | continue dans une conversation existante (`fs-cli -c`, `/resume`) ; remise à zéro vers 5 h du matin |
| « Ce modèle ne gère pas les outils client » | choisis un modèle Claude ou GPT avec `/model` |
| Il me demande Oui/Non en mode auto | il écrit hors du dossier de travail : réponds « faire confiance à ce dossier », ou lance `fs-cli` dans ce dossier |
| Accents illisibles | utilise Windows Terminal ou PowerShell 7 |

---

## Contribuer

```bash
git clone https://github.com/0xBlxck/fs-cli.git
cd fs-cli
git config core.hooksPath .githooks   # bloque tout commit contenant un secret
node cli.js                           # ou : npm link, puis fs-cli
npm test                              # tests (aucun appel à la vraie API)
npm run scan                          # cherche tokens, clés, e-mails, chemins personnels
```

Voir [CONTRIBUTING.md](CONTRIBUTING.md).

| Fichier | Rôle |
|---|---|
| `cli.js` | point d'entrée, commandes de base, sessions |
| `src/native.js` · `src/agent.js` | moteur natif · exécution des outils, confirmations, mode chat |
| `src/stdio.js` · `vscode/` | mode `--stdio` (événements JSON) · extension VS Code (panneau de chat, `node vscode/scripts/pack.mjs` pour le .vsix) |
| `src/permissions.js` · `src/trust.js` | politique de commandes et secrets · confiance par dossier |
| `src/intent.js` | compréhension des demandes en langage naturel |
| `src/team.js` · `src/chats.js` | agents multiples · gestion des conversations |
| `src/api.js` · `src/setup.js` · `src/config.js` | API France Student · assistant de connexion · configuration |
| `src/tools.js` · `src/web.js` · `src/mcp.js` | outils locaux · web sûr · client MCP |
| `src/memory.js` · `src/extra-commands.js` · `src/tui/` | mémoire · commandes · interface |

## Licence

MIT — voir [LICENSE](LICENSE) et [THIRD_PARTY.md](THIRD_PARTY.md).
