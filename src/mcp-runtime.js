// Instance unique du gestionnaire MCP (partagée par l'agent et les commandes)
import { McpManager, loadMcpConfig } from './mcp.js';

let mgr = null, lastCwd = null;

export function getMcp(cwd) {
  if (!mgr) { mgr = new McpManager({ cwd }); lastCwd = cwd; }
  else if (lastCwd !== cwd) { mgr.setCwd(cwd); lastCwd = cwd; }
  return mgr;
}

/** noms des serveurs actifs (non désactivés) pour ce dossier */
export function activeServers(cwd) {
  const cfg = loadMcpConfig(cwd);
  return Object.entries(cfg.mcpServers || {}).filter(([, s]) => !s.disabled).map(([n]) => n).sort();
}
