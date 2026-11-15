#!/usr/bin/env node
// fs-mcp : petit programme en ligne de commande, fourni avec FS-CLI, qui donne accès aux serveurs MCP et aux skills
// installés sur ce PC (les tiens + ceux configurés dans Claude Code, Codex…). Le modèle le lance avec run_command,
// comme n'importe quel programme : rien de caché, il peut le vérifier avec « fs-mcp list ».
//
//   fs-mcp list                                   serveurs MCP disponibles
//   fs-mcp tools <serveur>                        outils d'un serveur
//   fs-mcp call <serveur> <outil> cle=valeur …    appelle un outil (ou --json '{…}' / --json-file f.json)
//   fs-mcp skills <mots>                          cherche un guide (skill)
//   fs-mcp skill <nom>                            affiche un guide
//
// Sécurité : un serveur importé d'un autre assistant ne démarre que si tu l'as approuvé dans FS-CLI (« toujours ») ;
// ses variables d'environnement restent locales.
import fs from 'node:fs';
import path from 'node:path';
import { loadMcpConfig, McpManager } from './src/mcp.js';
import { discoverSkills, searchSkills } from './src/discover.js';
import { isImportApproved } from './src/approvals.js';

const argv = process.argv.slice(2);
const cwd = process.cwd();
const out = s => process.stdout.write(s + '\n');
let mgr = null;
async function finish(code) {
  try { if (mgr) await Promise.race([mgr.closeAll(), new Promise(r => setTimeout(r, 2000))]); } catch {}
  await new Promise(r => setTimeout(r, 120));                 // laisse les connexions se fermer (Windows)
  process.exit(code);
}
function fail(msg, code = 1) { process.stderr.write(msg + '\n'); return finish(code); }

function servers() { return Object.entries(loadMcpConfig(cwd).mcpServers || {}).filter(([, s]) => !s.disabled); }
function getServer(name) {
  const s = loadMcpConfig(cwd).mcpServers?.[name];
  if (!s || s.disabled) return { error: `Serveur MCP inconnu : ${name}. Liste : fs-mcp list` };
  if (s._scope === 'importé' && !isImportApproved(name, s)) {
    return { error: `Le serveur « ${name} » (configuré dans ${s._source}) n'est pas encore approuvé par l'utilisateur. ` +
      `Demande-lui de taper « /mcp ${name} » dans FS-CLI et de choisir « Oui, toujours pour ce serveur », puis réessaie.`, code: 3 };
  }
  return { s };
}

function coerce(v, schema) {
  const t = schema?.type;
  if (t === 'integer' || t === 'number') { const n = Number(v); return Number.isFinite(n) ? n : v; }
  if (t === 'boolean') return /^(true|1|oui|yes)$/i.test(v);
  if (t === 'array') { try { const j = JSON.parse(v); if (Array.isArray(j)) return j; } catch {} return v.split(',').map(x => x.trim()).filter(Boolean); }
  if (t === 'object') { try { return JSON.parse(v); } catch { return v; } }
  if (t === 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function parseArgs(kv, def) {
  let args = {};
  for (let i = 0; i < kv.length; i++) {
    if (kv[i] === '--json') { args = { ...args, ...JSON.parse(kv[++i] || '{}') }; continue; }
    if (kv[i] === '--json-file') { args = { ...args, ...JSON.parse(fs.readFileSync(path.resolve(kv[++i] || ''), 'utf8')) }; continue; }
    const m = kv[i].match(/^([\w.-]+)=([\s\S]*)$/);
    if (!m) throw new Error(`Argument incompris : « ${kv[i]} » (format attendu : cle=valeur, ou cle=@fichier)`);
    let v = m[2];
    if (v.startsWith('@') && v.length > 1) {                        // cle=@fichier : la valeur est le contenu du fichier (code, long texte…)
      const f = path.resolve(v.slice(1).replace(/^["']|["']$/g, ''));
      try { v = fs.readFileSync(f, 'utf8').replace(/^﻿/, ''); }
      catch { throw new Error(`Fichier introuvable pour ${m[1]}=@… : ${f}`); }
      args[m[1]] = v;                                               // contenu de fichier : toujours du texte brut
      continue;
    }
    args[m[1]] = coerce(v, def.inputSchema?.properties?.[m[1]]);
  }
  return args;
}

function describeTool(t) {
  const props = t.inputSchema?.properties || {};
  const req = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
  const params = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '*' : ''}=${v?.type || (v?.enum ? v.enum.join('|') : 'valeur')}`).join(' ');
  return `- ${t.name} ${params}\n    ${String(t.description || '').replace(/\s+/g, ' ').slice(0, 300)}`;
}

const [cmd, ...rest] = argv;
switch ((cmd || '').toLowerCase()) {
  case 'list': case 'ls': {
    const list = servers();
    if (!list.length) { out('Aucun serveur MCP sur ce PC.'); await finish(0); break; }
    out(`${list.length} serveur(s) MCP :`);
    for (const [n, s] of list) out(`- ${n} (${s._scope === 'importé' ? 'configuré dans ' + s._source + (isImportApproved(n, s) ? ', approuvé' : ', PAS encore approuvé') : s._scope})${s.description ? ' — ' + s.description.slice(0, 100) : ''}`);
    out('\nOutils d\'un serveur : fs-mcp tools <serveur> · appel : fs-mcp call <serveur> <outil> cle=valeur …');
    await finish(0); break;
  }
  case 'tools': {
    const name = rest[0]; if (!name) { await fail('Usage : fs-mcp tools <serveur>'); break; }
    const g = getServer(name); if (g.error) { await fail(g.error, g.code); break; }
    mgr = new McpManager({ cwd });
    try {
      const tools = await mgr.listTools(name);
      out(`Outils de ${name} (${tools.length}) — * = obligatoire. Appel : fs-mcp call ${name} <outil> cle=valeur …`);
      for (const t of tools) out(describeTool(t));
      await finish(0);
    } catch (e) { await fail(e.message); }
    break;
  }
  case 'call': {
    const [name, tool, ...kv] = rest;
    if (!name || !tool) { await fail('Usage : fs-mcp call <serveur> <outil> cle=valeur … (ou --json \'{…}\' / --json-file fichier.json)'); break; }
    const g = getServer(name); if (g.error) { await fail(g.error, g.code); break; }
    mgr = new McpManager({ cwd });
    try {
      const tools = await mgr.listTools(name);
      const def = tools.find(t => t.name === tool);
      if (!def) { await fail(`Outil inconnu : ${tool}. Outils de ${name} : ${tools.map(t => t.name).join(', ')}`); break; }
      const args = parseArgs(kv, def);                          // lève une erreur claire si un argument est incompris
      const res = await mgr.callTool(name, tool, args, { timeoutMs: 120000 });
      out(res.text || res.error || '(aucune sortie)');
      await finish(res.ok && !res.isError ? 0 : 1);
    } catch (e) { await fail(e.message); }
    break;
  }
  case 'skills': {
    const all = discoverSkills(cwd);
    const q = rest.join(' ');
    const hits = q ? searchSkills(all, q, 12) : all;
    out(`${hits.length} skill(s)${q ? ` pour « ${q} »` : ''} sur ${all.length} :`);
    for (const s of hits) out(`- ${s.name} (${s.source}) — ${s.description.slice(0, 200) || 'sans description'}\n    ${s.file}`);
    await finish(0); break;
  }
  case 'skill': {
    const want = rest.join(' ').toLowerCase();
    const all = discoverSkills(cwd);
    const s = all.find(x => x.name.toLowerCase() === want) || all.find(x => x.name.toLowerCase().includes(want));
    if (!want || !s) { await fail(`Skill introuvable : ${want}. Cherche avec : fs-mcp skills <mots>`); break; }
    out(`Skill « ${s.name} » — dossier : ${s.dir}\n`);
    out(fs.readFileSync(s.file, 'utf8'));
    await finish(0); break;
  }
  default:
    out('fs-mcp : accès aux serveurs MCP et skills de ce PC (fourni par FS-CLI)\n\n' +
      '  fs-mcp list                                  serveurs MCP disponibles\n' +
      '  fs-mcp tools <serveur>                       outils d\'un serveur\n' +
      '  fs-mcp call <serveur> <outil> cle=valeur …   appelle un outil ; cle=@fichier lit la valeur dans un fichier\n' +
      '                                               (code, long texte) ; --json \'{…}\' ou --json-file f.json aussi\n' +
      '  fs-mcp skills <mots>                         cherche un guide (skill)\n' +
      '  fs-mcp skill <nom>                           affiche un guide');
    await finish(cmd ? 1 : 0);
}
