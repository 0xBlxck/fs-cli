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
| Mettre à jour | relance la commande de l'étape 2 |
| Changer de compte / clé expirée | `fs-cli --login` |
| Reprendre la dernière session du dossier | `fs-cli -c` |
| Une seule demande, puis quitter | `fs-cli -p "résume ce dossier"` |
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
| « combien de conversations il me reste ? » | ton compteur du jour |
| « résume https://exemple.fr/article » | la page est lue et jointe à ta demande |

Dis « sans agents » pour l'éviter ; `/intent off` désactive cette compréhension automatique.

### Les 3 modes (Maj+Tab)

| Mode | Comportement |
|---|---|
| **auto** | agit sans demander pour ce qui n'est pas dangereux ; demande pour les actions sensibles |
| **confirmer** | demande ton accord avant chaque écriture et chaque commande |
| **plan** | lecture seule : il explore et propose un plan, **rien n'est modifié** |

### Raccourcis

| Touche | Action |
|---|---|
| Entrée · `\` + Entrée · Ctrl+J | envoyer · nouvelle ligne (le collage multi-ligne est géré) |
| Échap · Ctrl+C | interrompre (la génération s'arrête aussi côté serveur) · effacer ; deux fois Ctrl+C pour quitter |
| `/` · `@fichier` · `!commande` | commandes · joindre un fichier · commande shell directe |
| ↑ ↓ · Ctrl+R | historique · recherche dans l'historique |

---

## Fonctions

- **Agent natif** : le modèle utilise les outils officiels « outils client » de France Student (lire, chercher, écrire, éditer, lancer une commande) ; le CLI les exécute sur ton PC avec ses garde-fous.
- **Plusieurs agents** : `/team` répartit une tâche entre agents (jusqu'à 8), **à la suite dans la même conversation** (défaut) ou **en parallèle** ; `/compare` pose la même question à deux modèles.
- **Interface type Claude Code** : saisie ancrée en bas de la fenêtre, suggestions, menus à flèches, file d'attente de messages, code replié en une ligne.
- **Mémoire** : notes par dossier, préprompt, faits appris, compétences (`/skills`), compactage automatique avant que le contexte soit plein.
- **Instructions du projet** : `/init` crée `FSCLI.md` (ou utilise un `AGENTS.md` existant), lu au début de chaque conversation.
- **Conversations rangées** : sur le site, les conversations du CLI sont regroupées dans le projet **FS-CLI** (`/fr-project <nom>` pour un autre, `/fr-project off` pour désactiver).
- **Web** : une URL citée est lue automatiquement ; `/search` et `/fetch` (adresses locales refusées).
- **Tes outils déjà installés, automatiquement** : FS-CLI retrouve les serveurs **MCP** configurés dans Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI ou Windsurf, et les **skills** (`SKILL.md` de `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, plugins installés). Le modèle les utilise tout seul quand c'est utile ; un serveur importé demande ton accord à son premier démarrage. `/import` montre ce qui a été trouvé, `/import off` désactive.
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
| Conversation | `/new` · `/resume` · `/model` · `/compact` · `/context` · `/quota` · `/chats` · `/clean` · `/undo` |
| Agents | `/team [-n N] [--pool] [--review] <tâche>` · `/teammode same\|pool` · `/parallel N` · `/workers <modèle>` · `/compare <question>` |
| Projet | `/init` · `/cd` · `/target` · `/tree` · `/index` · `/project` · `/fr-project` |
| Mémoire | `/remember` · `/forget` · `/memory` · `/preprompt` · `/profil` · `/skills` |
| Web et outils | `/search` · `/fetch` · `/mcp` · `/import` · `/jobs` · `!commande` |
| Sécurité | `/permissions` · `/mode auto\|ask\|plan` · `/intent on\|off` |

---

## Sécurité

Résumé ; le détail et le modèle de menace sont dans [SECURITY.md](SECURITY.md).

- **Ta clé** n'est envoyée qu'à `api.francestudent.ai` (HTTPS), n'est jamais affichée ni journalisée, et **n'est pas transmise** aux commandes, scripts et serveurs MCP que le CLI lance.
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
| `src/permissions.js` · `src/trust.js` | politique de commandes et secrets · confiance par dossier |
| `src/intent.js` | compréhension des demandes en langage naturel |
| `src/team.js` · `src/chats.js` | agents multiples · gestion des conversations |
| `src/api.js` · `src/setup.js` · `src/config.js` | API France Student · assistant de connexion · configuration |
| `src/tools.js` · `src/web.js` · `src/mcp.js` | outils locaux · web sûr · client MCP |
| `src/memory.js` · `src/extra-commands.js` · `src/tui/` | mémoire · commandes · interface |

## Licence

MIT — voir [LICENSE](LICENSE) et [THIRD_PARTY.md](THIRD_PARTY.md).
