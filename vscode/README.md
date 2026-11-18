# FS-CLI pour VS Code

Le chat de **FS-CLI** (agent France Student AI) dans un panneau de ton éditeur. Il marche dans VS Code, Cursor, Windsurf et Antigravity.

- Il lit et modifie ton projet. Les modifications s'affichent en diff, et tu peux les ouvrir dans le diff de l'éditeur.
- Le fichier ouvert et le code sélectionné sont joints à ta demande. Un clic sur la puce les retire.
- Les confirmations s'affichent dans le panneau : Oui / Non, au clavier avec 1-9.
- À la fin de chaque demande, un bilan liste les fichiers modifiés, avec **Annuler** fichier par fichier.
- La liste de tâches, le choix du modèle et le mode (Auto, Modifs auto, Confirmer, Plan) sont accessibles d'un clic. **Maj+Tab** change de mode.
- Tu peux coller une image avec **Ctrl+V** (Mac : **Cmd+V**), ou joindre des fichiers avec **+**. Une très grosse capture est réduite avant l'envoi ; au-delà de 10 Mo, capture plutôt une zone (Mac : **Cmd+Ctrl+Maj+4**).

## Installation

1. Installe FS-CLI : `npm install -g github:0xBlxck/fs-cli`, puis lance `fs-cli` une fois pour te connecter.
2. Télécharge `fs-cli-vscode-*.vsix` depuis les [releases](https://github.com/0xBlxck/fs-cli/releases).
3. Dans l'éditeur, ouvre les Extensions, puis **⋯ › Installer depuis un VSIX…**.

Le panneau est dans la barre latérale (icône ✻). Tu peux aussi l'ouvrir dans un onglet : **Ctrl+Alt+I** (Mac : **Cmd+Option+I**), ou le bouton en haut à droite de l'éditeur. Pour envoyer la sélection : **Ctrl+Alt+K** (Mac : **Cmd+Option+K**), ou clic droit › *Demander à FS-CLI*.

## Sur Mac

- **« FS-CLI introuvable »** : une appli ouverte depuis le Dock ne voit pas toujours le PATH du Terminal (Homebrew, nvm, Volta…). L'extension cherche elle-même `node` et FS-CLI (`/opt/homebrew`, `/usr/local`, `~/.nvm`, `~/.volta`, `~/.local`, `npm prefix -g` du shell). Si ça ne suffit pas : quitte l'éditeur avec **Cmd+Q** (fermer la fenêtre ne suffit pas) puis rouvre-le, ou mets le chemin complet dans le réglage `fsCli.command`, par exemple `/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/fs-cli/cli.js`.
- **Aucun dossier ouvert** : le panneau te demande de choisir un dossier au lieu de travailler dans ton dossier personnel (où macOS afficherait ses fenêtres d'autorisation pour Documents, Bureau, Téléchargements…).
- La palette de commandes est **Cmd+Maj+P** (« Reload Window » pour recharger la fenêtre).

## Sécurité

L'extension ne lit ni ne stocke ta clé de session. Elle lance `fs-cli --stdio`, qui garde sa clé dans `~/.fs-cli` et applique les mêmes garde-fous que dans le terminal.
