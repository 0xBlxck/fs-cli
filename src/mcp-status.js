// Vue d'ensemble des serveurs MCP (comme la fenêtre « MCP servers » de Claude Code) :
// groupes (ce projet / FS-CLI / importés de Claude Code, Codex…), état de chaque serveur, connexion de tous en parallèle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMcpConfig, isProjectTrusted } from './mcp.js';
import { isImportApproved } from './approvals.js';

/** groupe d'affichage d'un serveur */
function groupOf(s) {
  if (s._scope === 'projet') return 'Ce projet';
  if (s._scope === 'importé') return /dossier/i.test(s._source || '') ? 'Ce projet' : (s._source || 'Importés');
  return 'FS-CLI';
}

/** connecteurs claude.ai : ils vivent dans le compte Claude (chez Anthropic), pas sur ce PC — affichés pour information seulement */
export function claudeAiConnectors() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const list = Array.isArray(j.claudeAiMcpEverConnected) ? j.claudeAiMcpEverConnected : [];
    return [...new Set(list.filter(x => typeof x === 'string' && /^claude\.ai /.test(x)).map(x => x.slice(0, 80)))].sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

/** liste à afficher, sans rien démarrer. status : connected | idle | disabled | approve | untrusted */
export async function mcpOverview(cwd, mgr) {
  const cfg = loadMcpConfig(cwd);
  const live = new Map((await mgr.list()).map(s => [s.name, s]));
  const projTrusted = isProjectTrusted(cwd);
  const servers = Object.entries(cfg.mcpServers || {}).map(([name, s]) => {
    const l = live.get(name);
    const status = s.disabled ? 'disabled'
      : s._scope === 'importé' && !isImportApproved(name, s) ? 'approve'
      : s._scope === 'projet' && !projTrusted ? 'untrusted'
      : l?.connected ? 'connected' : 'idle';
    return {
      name, group: groupOf(s), source: s._source || '', transport: s.url && !s.command ? 'http' : 'stdio',
      target: String(s.url || [s.command, ...(s.args || [])].join(' ')).slice(0, 300), description: String(s.description || '').slice(0, 200),
      status, toolCount: l?.toolCount || 0,
    };
  });
  const order = g => (g === 'Ce projet' ? 0 : g === 'FS-CLI' ? 1 : 2);
  servers.sort((a, b) => order(a.group) - order(b.group) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  return { servers, cloud: claudeAiConnectors(), error: cfg._error || null };
}

/** classe une erreur de connexion : besoin d'une connexion à un compte (OAuth) ou panne */
export const statusOfError = msg => (/\b401\b|OAuth|unauthori[sz]ed|authenticat/i.test(String(msg)) ? 'auth' : 'error');

/** connecte en parallèle les serveurs prêts (activés, autorisés) ; onStatus reçoit chaque résultat dès qu'il arrive */
export async function connectAll(mgr, servers, onStatus, { timeoutMs = 20000 } = {}) {
  const todo = servers.filter(s => s.status === 'idle' || s.status === 'connected' || s.status === 'error' || s.status === 'auth');
  await Promise.all(todo.map(async s => {
    onStatus({ name: s.name, status: 'connecting' });
    onStatus(await connectOne(mgr, s.name, { timeoutMs }));
  }));
}

export async function connectOne(mgr, name, { timeoutMs = 20000 } = {}) {
  try {
    const info = await mgr.connect(name, { timeoutMs });
    const tools = (await mgr.listTools?.(name).catch(() => null)) || null;
    return { name, status: 'connected', toolCount: info.toolCount, tools: Array.isArray(tools) ? tools.slice(0, 80).map(t => ({ name: t.name, description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 160) })) : undefined };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 400);
    return { name, status: statusOfError(msg), error: msg };
  }
}
