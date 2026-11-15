// Pont local entre fs-mcp et la session FS-CLI : fs-mcp (lancé par le modèle avec run_command) passe ses appels au CLI,
// qui garde les serveurs MCP ouverts. Indispensable pour les serveurs qui ont un état (navigateur, Blender…) : sans pont,
// chaque appel relancerait un serveur neuf et le navigateur se fermerait entre deux actions.
// Sécurité : écoute uniquement sur 127.0.0.1, jeton aléatoire propre à la session (transmis aux programmes lancés par le
// CLI via FS_CLI_BRIDGE), en-têtes Host/Origin vérifiés (anti-DNS rebinding / pages web), mêmes accords que fs-mcp.
import http from 'node:http';
import crypto from 'node:crypto';
import { loadMcpConfig } from './mcp.js';
import { isImportApproved } from './approvals.js';
import { captureImages } from './vision.js';

export function startBridge({ getManager, getCwd }) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const port = server.address()?.port;
    if (req.method !== 'POST' || req.url !== '/mcp') return send(404, { error: 'introuvable' });
    if (req.headers.origin || !new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(String(req.headers.host))) return send(403, { error: 'refusé' });
    const given = Buffer.from(String(req.headers['x-fs-cli-token'] || ''));
    if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) return send(401, { error: 'jeton invalide' });
    let body = ''; let tooBig = false;
    req.on('data', d => { body += d; if (body.length > 5_000_000) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooBig) return;
      let q; try { q = JSON.parse(body); } catch { return send(400, { error: 'JSON invalide' }); }
      const cwd = getCwd();
      const s = q.server ? loadMcpConfig(cwd).mcpServers?.[q.server] : null;
      if (q.server && (!s || s.disabled)) return send(404, { error: `Serveur MCP inconnu : ${q.server}` });
      if (s && s._scope === 'importé' && !isImportApproved(q.server, s)) {
        return send(403, { error: `Le serveur « ${q.server} » (configuré dans ${s._source}) n'est pas encore approuvé par l'utilisateur. Demande-lui de taper « /mcp ${q.server} » dans FS-CLI, puis réessaie.`, code: 3 });
      }
      const mgr = getManager();
      try {
        if (q.action === 'tools') return send(200, { tools: await mgr.listTools(q.server) });
        if (q.action === 'call') {
          const r = await mgr.callTool(q.server, q.tool, q.args || {}, { timeoutMs: 180000 });
          let text = r.text || r.error || '';
          const shots = captureImages(r.content);                       // capture d'écran… → montrée au modèle avec ce résultat
          if (shots.length) text += `\n[${shots.length} image${shots.length > 1 ? 's' : ''} jointe${shots.length > 1 ? 's' : ''} à ce résultat : tu peux ${shots.length > 1 ? 'les' : 'la'} voir]`;
          return send(200, { ok: r.ok && !r.isError, text });
        }
        return send(400, { error: 'action inconnue' });
      } catch (e) { return send(500, { error: e.message }); }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const env = `${server.address().port}:${token}`;
      process.env.FS_CLI_BRIDGE = env;                                  // hérité par les commandes lancées par le CLI (donc par fs-mcp)
      server.unref();
      resolve({ server, env });
    });
    server.on('error', () => resolve(null));
  });
}

/** Côté fs-mcp : appel au pont de la session FS-CLI qui l'a lancé (null si pas de pont). */
export async function bridgeRequest(payload) {
  const v = process.env.FS_CLI_BRIDGE || '';
  const m = v.match(/^(\d{2,5}):([0-9a-f]{48})$/);
  if (!m) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${m[1]}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fs-cli-token': m[2] },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(200000),
    });
    const j = await r.json().catch(() => ({ error: `réponse illisible (HTTP ${r.status})` }));
    return { status: r.status, ...j };
  } catch { return null; }                                           // session fermée : fs-mcp travaille seul
}
