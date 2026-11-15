# Crédits et licences tierces

FS-CLI n'a **aucune dépendance npm** : rien n'est téléchargé à l'installation.

| Élément | Origine | Licence |
|---|---|---|
| `skills.json` (compétences « Fullstack », « GLua », « Sécurité », « DevOps », « Python AI ») | adapté du projet CLI-FS / `clifs-x3vren` (« France Student Developer CLI ») | MIT |
| Presets MCP (`src/mcp.js`) | noms et commandes de serveurs MCP publics (`@modelcontextprotocol/*`, `@playwright/mcp`, `blender-mcp`, `mcp-server-fetch`…). Ils ne sont **pas** installés par FS-CLI : `npx` / `uvx` les télécharge seulement si tu les actives. | licences de leurs auteurs |

FS-CLI n'est affilié ni à France Student ni à Anthropic ni à OpenAI. Les noms de produits appartiennent à leurs propriétaires.

## Licence du projet dont `skills.json` est adapté (MIT)

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
