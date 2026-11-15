// Outils du PC pour le moteur natif. France Student fixe la liste des outils du modèle (6 outils client) : on ne peut pas
// y ajouter les MCP, et on ne simule rien. À la place, FS-CLI fournit un VRAI programme, « fs-mcp » (mcp-cli.js), que le
// modèle lance avec run_command comme n'importe quel programme (et qu'il peut vérifier lui-même). Ce module :
//   - prépare le court bloc d'information envoyé au modèle (serveurs, commande exacte, guides proches de la demande) ;
//   - demande ton accord avant qu'un serveur importé d'un autre assistant puisse être démarré par fs-mcp.
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT } from './config.js';
import { loadMcpConfig } from './mcp.js';
import { getMcp } from './mcp-runtime.js';
import { discoverSkills, searchSkills } from './discover.js';
import { isImportApproved, approveImport } from './approvals.js';
import { confirm } from './agent.js';
import * as ui from './ui.js';

/** Commande exacte pour lancer fs-mcp (chemin absolu : marche même sans installation globale). */
export const FS_MCP = `node "${path.join(ROOT, 'mcp-cli.js')}"`;

/** Liste de tâches : simple mise en forme Markdown, que FS-CLI affiche comme un suivi de progression épinglé. */
const TASKS_RULE = '- Pour toute tâche en plusieurs étapes (3 ou plus), écris d\'abord ton plan sous forme de liste de tâches Markdown, une ligne par étape : « - [ ] étape ». ' +
  'Au fil du travail, réécris la liste COMPLÈTE avec « - [x] » pour ce qui est fait et « - [~] » pour l\'étape en cours. FS-CLI l\'affiche à l\'utilisateur comme un suivi de progression. Pour une demande simple, pas de liste.';

const RULE ='N\'affirme jamais avoir cherché, trouvé ou vérifié quelque chose (annonces, prix, données…) sans avoir réellement lancé l\'outil dans cette réponse ; sinon dis-le clairement.';

/** Accord pour un serveur importé (Claude Code, Codex…) : enregistré, car fs-mcp le vérifie à chaque lancement. */
export async function approveServer(S, name, s, io) {
  if (s._scope !== 'importé' || isImportApproved(name, s)) return true;
  const what = s.url ? `URL : ${s.url}` : `Commande : ${[s.command, ...(s.args || [])].join(' ')}`;
  const r = await confirm(io.ask, {
    title: `Autoriser le serveur MCP « ${name} » (configuré dans ${s._source || 'un autre outil'}) ?`,
    detail: `${what}\nLe modèle pourra le démarrer et appeler ses outils via fs-mcp. Il tourne sur ton PC avec tes droits ; ses variables d'environnement restent locales.`,
    danger: false, noAlways: true, yesLabel: 'Oui, autoriser ce serveur',
  });
  if (r.aborted || io.signal?.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
  if (!r.allow) return false;
  approveImport(name, s);
  return true;
}

function describeTools(server, tools) {
  return `Outils de ${server} (* = obligatoire) — appel : ${FS_MCP} call ${server} <outil> cle=valeur … (cle=@fichier pour du code ou un long texte écrit d'abord dans un fichier du dossier de travail)\n` + tools.slice(0, 60).map(t => {
    const props = t.inputSchema?.properties && typeof t.inputSchema.properties === 'object' ? t.inputSchema.properties : {};
    const req = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
    const params = Object.entries(props).slice(0, 15).map(([k, v]) => `${k}${req.has(k) ? '*' : ''}=${v?.type || 'valeur'}`).join(' ');
    return `- ${t.name} ${params}${t.description ? ' — ' + String(t.description).replace(/\s+/g, ' ').slice(0, 200) : ''}`;
  }).join('\n');
}

/** Bloc envoyé à chaque conversation qui ne l'a pas encore vu : ce que le modèle peut utiliser sur ce PC. */
export function toolsHint(cwd, userText) {
  const servers = Object.entries(loadMcpConfig(cwd).mcpServers || {}).filter(([, s]) => !s.disabled).map(([n]) => n);
  const skills = discoverSkills(cwd);
  const sig = crypto.createHash('sha256').update(JSON.stringify([servers, skills.length, FS_MCP, 'taches-v1'])).digest('hex').slice(0, 12);
  const lines = [`[Info de FS-CLI (le programme qui exécute tes outils chez l'utilisateur) :`, TASKS_RULE];
  if (!servers.length && !skills.length) { lines.push(`${RULE}]`); return { text: lines.join('\n'), label: 'suivi des tâches', sig }; }
  lines.push(`- Sur ce PC, le programme fs-mcp (installé avec FS-CLI) donne accès aux serveurs MCP et aux guides (skills) de l'utilisateur. Lance-le avec run_command comme n'importe quel programme, par exemple : ${FS_MCP} list`);
  if (servers.length) lines.push(`- Serveurs MCP : ${servers.join(', ')}. \`${FS_MCP} tools <serveur>\` liste les outils ; \`${FS_MCP} call <serveur> <outil> cle=valeur …\` en appelle un. Pour du code ou un long texte (ex. un script Blender), écris-le d'abord dans un fichier du dossier de travail avec write_file, puis passe \`cle=@fichier\` (ex. code=@scene.py).`);
  if (skills.length) {
    const near = searchSkills(skills, userText, 4);
    lines.push(`- ${skills.length} guides (skills) : \`${FS_MCP} skills <mots>\` pour chercher.` +
      (near.length ? ` Proches de cette demande (lis le fichier avec read_file avant de te lancer) : ${near.map(s => `${s.name} → ${s.file}`).join(' ; ')}.` : ''));
  }
  lines.push(`Utilise-les quand ils aident vraiment. ${RULE}]`);
  return { text: lines.join('\n'), label: `${servers.length} MCP · ${skills.length} skills`, sig };
}

/** Serveurs MCP nommés dans la demande (« avec le mcp leboncoin », « via blender »…). */
export function mentionedServers(cwd, text) {
  const t = String(text || '').toLowerCase();
  const names = Object.entries(loadMcpConfig(cwd).mcpServers || {}).filter(([, s]) => !s.disabled).map(([n]) => n);
  const saysMcp = /\bmcp\b/.test(t);
  return names.filter(n => {
    const re = new RegExp(`(^|[^\\w-])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_-]/g, '[ _-]?')}($|[^\\w-])`);
    return re.test(t) && (saysMcp || n.length >= 6);              // noms courts (rea, cua) : seulement si « mcp » est dit
  }).slice(0, 3);
}

/** Serveur nommé par l'utilisateur : accord si besoin, démarrage, puis liste de ses outils jointe à la demande. */
export async function serverBrief(S, name, io) {
  const s = loadMcpConfig(S.cwd).mcpServers?.[name];
  if (!s) return '';
  try {
    if (!(await approveServer(S, name, s, io))) return `[Info de FS-CLI : l'utilisateur a refusé d'autoriser le serveur MCP ${name}.]`;
    ui.spinner.start(`démarrage de ${name}…`);
    const tools = await getMcp(S.cwd).listTools(name, { signal: io.signal });
    ui.spinner.stop();
    return `[Info de FS-CLI : l'utilisateur veut que tu utilises le serveur MCP « ${name} » de son PC. Lance-le avec run_command via le programme fs-mcp. ${RULE}\n${describeTools(name, tools)}]`;
  } catch (e) {
    ui.spinner.stop();
    if (e.name === 'AbortError') throw e;
    return `[Info de FS-CLI : le serveur MCP ${name} n'a pas pu démarrer (${String(e.message).slice(0, 300)}). Dis-le à l'utilisateur, n'invente pas de résultats.]`;
  }
}
