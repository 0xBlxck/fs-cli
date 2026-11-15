# Contribuer

Les contributions sont bienvenues (bugs, tests, plateformes, documentation).

## Règles

1. **Aucun secret, jamais** : ni token, ni clé, ni e-mail, ni chemin personnel (`C:\Users\toi\…`), ni identifiant de conversation. Utilise des valeurs fictives. Active le hook : `git config core.hooksPath .githooks`.
2. **Zéro dépendance** : le projet n'utilise que la bibliothèque standard de Node. Pas de `npm install` pour un contributeur (et pas de nouvelle dépendance sans discussion).
3. **Tests** : `npm test` doit passer ; ajoute un test pour tout changement de comportement. Les tests n'appellent **pas** la vraie API (faux serveurs et terminal simulé).
4. **Sécurité d'abord** : tout changement de `src/permissions.js`, `src/web.js`, `src/native.js` ou de la gestion du token doit être accompagné de tests (cas dangereux compris).
5. N'ajoute pas de contournement des règles de France Student (protocoles d'outils injectés dans le texte, usurpation d'identité de navigateur, etc.). Le moteur « natif » utilise l'API officielle d'outils client.

## Développement

```bash
npm test            # tests unitaires + sécurité (Windows : PowerShell requis)
npm run scan        # scanner de secrets / données personnelles
node cli.js         # lancer
```

Les tests de l'interface utilisent un terminal simulé (`test/term-sim.js`) : pas besoin de vrai terminal.
