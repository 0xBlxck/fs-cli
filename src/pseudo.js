// Commandes spéciales du moteur natif : le modèle n'a que les 6 outils officiels de France Student, donc il passe par
// run_command pour utiliser les serveurs MCP et les skills du PC. Ces commandes sont interceptées ICI et exécutées
// directement par le CLI (jamais par le shell) :
//   mcp list                        → serveurs MCP disponibles (les tiens + ceux de Claude Code, Codex…)
//   mcp <serveur>                   → outils d'un serveur (démarré à ce moment-là)
//   mcp <serveur>.<outil> {json}    → appel d'un outil
//   skills <mots>                   → recherche dans les skills du PC
//   skill <nom>                     → contenu d'un skill (SKILL.md) et liste de ses fichiers
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, HOME_DIR } from './config.js';
import { loadMcpConfig } from './mcp.js';
import { getMcp } from './mcp-runtime.js';
import { discoverSkills, searchSkills } from './discover.js';
import { confirm } from './agent.js';
import * as ui from './ui.js';

const abort = () => Object.assign(new Error('annulé'), { name: 'AbortError' });

// ── accord pour les serveurs importés : une fois par serveur (et « toujours » mémorisé, lié à sa commande) ──
const APPROVED = () => path.join(HOME_DIR, 'approved-mcp.json');
const sigOf = s => crypto.createHash('sha256').update(JSON.stringify([s.command || '', s.args || [], s.url || ''])).digest('hex').slice(0, 16);
function readApproved() { try { const o = JSON.parse(fs.readFileSync(APPROVED(), 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function saveApproved(name, sig) {
  const o = readApproved(); o[name] = sig;
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(APPROVED(), JSON.stringify(o, null, 1), { mode: 0o600 });
}

async function approveServer(S, name, s, io) {
  if (s._scope !== 'importé') return true;                          // tes serveurs et ceux du projet : règles habituelles
  S.mcpApproved ||= new Set();
  if (S.mcpApproved.has(name)) return true;
  const sig = sigOf(s);
  if (readApproved()[name] === sig) { S.mcpApproved.add(name); return true; }
  const what = s.url ? `URL : ${s.url}` : `Commande : ${[s.command, ...(s.args || [])].join(' ')}`;
  const r = await confirm(io.ask, {
    title: `Démarrer le serveur MCP « ${name} » (configuré dans ${s._source || 'un autre outil'}) ?`,
    detail: `${what}\nIl tournera sur ton PC avec tes droits ; ses variables d'environnement restent locales.`,
    danger: false, allowAlways: true, alwaysLabel: 'toujours pour ce serveur',
  });
  if (r.aborted || io.signal?.aborted) throw abort();
  if (!r.allow) return false;
  S.mcpApproved.add(name);
  if (r.always) saveApproved(name, sig);
  return true;
}

function describeServers(cwd) {
  const servers = Object.entries(loadMcpConfig(cwd).mcpServers || {}).filter(([, s]) => !s.disabled);
  if (!servers.length) return 'Aucun serveur MCP disponible sur ce PC.';
  return `${servers.length} serveur(s) MCP :\n` + servers.map(([n, s]) =>
    `- ${n} (${s._scope === 'importé' ? 'de ' + s._source : s._scope}${s.description ? ' — ' + s.description.slice(0, 100) : ''})`).join('\n') +
    '\nPour voir les outils d\'un serveur : `mcp <serveur>`. Pour appeler un outil : `mcp <serveur>.<outil> {arguments JSON}`.';
}

function describeTools(server, tools) {
  return `Outils de ${server} (${tools.length}) — appelle-les avec \`mcp ${server}.<outil> {json}\` (* = obligatoire) :\n` + tools.slice(0, 80).map(t => {
    const props = t.inputSchema?.properties && typeof t.inputSchema.properties === 'object' ? t.inputSchema.properties : {};
    const req = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
    const params = Object.entries(props).slice(0, 15).map(([k, v]) => `${k}${req.has(k) ? '*' : ''}: ${v?.type || (v?.enum ? 'enum' : 'any')}`).join(', ');
    return `- ${t.name}(${params})${t.description ? ' — ' + String(t.description).replace(/\s+/g, ' ').slice(0, 220) : ''}`;
  }).join('\n');
}

/** Si `command` est une commande spéciale, l'exécute et renvoie { ok, output } ; sinon null. */
export async function runPseudo(S, command, io) {
  const t = String(command || '').trim();
  let m;

  if (/^mcp(\s+(list|liste|ls))?\s*$/i.test(t)) {
    ui.toolHeader('mcp list');
    const out = describeServers(S.cwd);
    ui.toolNote(out.split('\n')[0]);
    return { ok: true, output: out };
  }

  if ((m = t.match(/^mcp\s+([\w-]+)(?:\s+--?tools)?\s*$/i))) {
    const server = m[1];
    const s = loadMcpConfig(S.cwd).mcpServers?.[server];
    ui.toolHeader(`mcp ${server}`, 'liste des outils');
    if (!s) return { ok: false, output: `Serveur MCP inconnu : ${server}.\n${describeServers(S.cwd)}` };
    if (!(await approveServer(S, server, s, io))) { ui.toolNote('refusé', 'yellow'); return { ok: false, output: `L'utilisateur a refusé de démarrer le serveur ${server}.` }; }
    ui.spinner.start(`démarrage de ${server}…`);
    try {
      const tools = await getMcp(S.cwd).listTools(server, { signal: io.signal });
      ui.spinner.stop(); ui.toolNote(`${tools.length} outil(s)`);
      return { ok: true, output: describeTools(server, tools) };
    } catch (e) { ui.spinner.stop(); ui.toolBody(e.message, { error: true, max: 3 }); return { ok: false, output: e.message }; }
  }

  if ((m = t.match(/^mcp\s+([\w-]+)\.([\w.:-]+)\s*([\s\S]*)$/i))) {
    const [, server, tool, rawArgs] = m;
    const s = loadMcpConfig(S.cwd).mcpServers?.[server];
    let args = {};
    if (rawArgs.trim()) {
      try { args = JSON.parse(rawArgs.trim().replace(/^'([\s\S]*)'$/, '$1')); }
      catch { return { ok: false, output: `Arguments invalides : il faut un objet JSON, ex. mcp ${server}.${tool} {"cle": "valeur"}` }; }
    }
    ui.toolHeader(`mcp ${server}.${tool}`, JSON.stringify(args).slice(0, 100));
    if (!s) return { ok: false, output: `Serveur MCP inconnu : ${server}.\n${describeServers(S.cwd)}` };
    if (!(await approveServer(S, server, s, io))) { ui.toolNote('refusé', 'yellow'); return { ok: false, output: `L'utilisateur a refusé de démarrer le serveur ${server}.` }; }
    if (cfg.mode === 'ask' && !S.allow.mcp) {
      const r = await confirm(io.ask, { title: `Appeler l'outil MCP ${server}.${tool} ?`, detail: JSON.stringify(args, null, 1), danger: false });
      if (r.aborted || io.signal?.aborted) throw abort();
      if (!r.allow) { ui.toolNote('refusé', 'yellow'); return { ok: false, output: `L'utilisateur a REFUSÉ l'appel ${server}.${tool}.${r.feedback ? ' Il précise : ' + r.feedback : ''}` }; }
      if (r.always) S.allow.mcp = true;
    }
    ui.spinner.start(`mcp ${server}.${tool}…`);
    const res = await getMcp(S.cwd).callTool(server, tool, args, { signal: io.signal, timeoutMs: 120000 });
    ui.spinner.stop();
    if (io.signal?.aborted) throw abort();
    const ok = res.ok && !res.isError;
    const text = res.text || res.error || '(aucune sortie)';
    ui.toolBody(text, ok ? { max: 6 } : { error: true, max: 4 });
    return { ok, output: text };
  }

  if ((m = t.match(/^skills\s*([\s\S]*)$/i))) {
    const all = discoverSkills(S.cwd);
    const q = m[1].trim();
    const hits = q ? searchSkills(all, q, 12) : all.slice(0, 40);
    ui.toolHeader(`skills ${q}`.trim(), `${hits.length} / ${all.length}`);
    if (!hits.length) return { ok: true, output: `Aucun skill ne correspond à « ${q} » (${all.length} skills sur ce PC). Essaie d'autres mots.` };
    return { ok: true, output: hits.map(s => `- ${s.name} (${s.source}) — ${s.description.slice(0, 200) || 'sans description'}`).join('\n') + '\nPour en lire un : `skill <nom>`.' };
  }

  if ((m = t.match(/^skill\s+([\s\S]+)$/i))) {
    const want = m[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
    const all = discoverSkills(S.cwd);
    const s = all.find(x => x.name.toLowerCase() === want) || all.find(x => x.name.toLowerCase().includes(want));
    ui.toolHeader(`skill ${want}`);
    if (!s) return { ok: false, output: `Skill introuvable : ${want}. Cherche avec \`skills <mots>\`.` };
    let body = ''; try { body = fs.readFileSync(s.file, 'utf8'); } catch {}
    const files = [];
    (function walk(dir, depth) {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (files.length >= 40) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3 && !/^(node_modules|\.git|__pycache__)$/.test(e.name)) walk(p, depth + 1);
        else if (e.isFile() && e.name !== 'SKILL.md') files.push(path.relative(s.dir, p));
      }
    })(s.dir, 0);
    ui.toolNote(`${s.name} · ${s.source}`);
    return { ok: true, output: `Skill « ${s.name} » — dossier : ${s.dir}\n` +
      (files.length ? `Autres fichiers (lisibles avec read_file, chemin = dossier + nom) : ${files.join(', ')}\n` : '') +
      `\n${body.length > 30000 ? body.slice(0, 30000) + '\n[… tronqué]' : body}` };
  }
  return null;
}

/** Bloc joint au 1er message (moteur natif) : ce que le modèle peut utiliser sur ce PC, en restant court. */
export function toolsHint(cwd, userText) {
  const servers = Object.entries(loadMcpConfig(cwd).mcpServers || {}).filter(([, s]) => !s.disabled).map(([n]) => n);
  const skills = discoverSkills(cwd);
  if (!servers.length && !skills.length) return { text: '', label: '' };
  const lines = ['[Outils de ce PC, utilisables via run_command avec ces commandes exactes (le CLI les exécute lui-même, sans shell) :'];
  if (servers.length) lines.push(`- Serveurs MCP : ${servers.join(', ')}. \`mcp <serveur>\` liste ses outils ; \`mcp <serveur>.<outil> {json}\` en appelle un.`);
  if (skills.length) {
    const near = searchSkills(skills, userText, 5);
    lines.push(`- ${skills.length} skills (guides d'experts) : \`skills <mots>\` pour chercher, \`skill <nom>\` pour en lire un avant de te lancer.` +
      (near.length ? ` Proches de cette demande : ${near.map(s => `${s.name} (${s.description.slice(0, 90)})`).join(' ; ')}.` : ''));
  }
  lines.push('Utilise-les quand ils aident vraiment ; sinon ignore ce bloc.]');
  return { text: lines.join('\n'), label: `${servers.length} MCP · ${skills.length} skills` };
}
