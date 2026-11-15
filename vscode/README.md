# FS-CLI pour VS Code

Le chat de **FS-CLI** (agent France Student AI) dans un panneau de ton éditeur. Il marche dans VS Code, Cursor, Windsurf et Antigravity.

- Il lit et modifie ton projet. Les modifications s'affichent en diff, et tu peux les ouvrir dans le diff de l'éditeur.
- Le fichier ouvert et le code sélectionné sont joints à ta demande. Un clic sur la puce les retire.
- Les confirmations s'affichent dans le panneau : Oui / Non, au clavier avec 1-9.
- À la fin de chaque demande, un bilan liste les fichiers modifiés, avec **Annuler** fichier par fichier.
- La liste de tâches, le choix du modèle et le mode (Auto, Modifs auto, Confirmer, Plan) sont accessibles d'un clic. **Maj+Tab** change de mode.
- Tu peux coller une image avec Ctrl+V, ou joindre des fichiers avec **+**.

## Installation

1. Installe FS-CLI : `npm install -g github:0xBlxck/fs-cli`, puis lance `fs-cli` une fois pour te connecter.
2. Télécharge `fs-cli-vscode-*.vsix` depuis les [releases](https://github.com/0xBlxck/fs-cli/releases).
3. Dans l'éditeur, ouvre les Extensions, puis **⋯ › Installer depuis un VSIX…**.

Le panneau est dans la barre latérale (icône ✻). Tu peux aussi l'ouvrir dans un onglet : **Ctrl+Alt+I**, ou le bouton en haut à droite de l'éditeur. Pour envoyer la sélection : **Ctrl+Alt+K**, ou clic droit › *Demander à FS-CLI*.

## Sécurité

L'extension ne lit ni ne stocke ta clé de session. Elle lance `fs-cli --stdio`, qui garde sa clé dans `~/.fs-cli` et applique les mêmes garde-fous que dans le terminal.
