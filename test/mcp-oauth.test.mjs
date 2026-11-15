// Connexion OAuth d'un serveur MCP distant, de bout en bout, contre un FAUX service local (ressource + serveur d'autorisation) :
// découverte (401 + resource_metadata) → enregistrement du client → page de connexion → PKCE vérifié → jeton utilisé par le MCP → renouvellement.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-oauth-'));
const home = path.join(tmp, 'home'), proj = path.join(tmp, 'projet');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(proj, { recursive: true });
process.env.FS_CLI_HOME = home; process.env.FS_IMPORT_HOME = path.join(tmp, 'vide');

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const st = { codes: new Map(), tokens: new Set(), refreshes: 0, registered: 0, base: '' };
const json = (res, code, o, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => { let d = ''; req.on('data', x => d += x); req.on('end', () => r(d)); });

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, st.base);
  if (u.pathname === '/mcp') {                                       // ressource MCP protégée
    const auth = req.headers.authorization || '';
    if (!st.tokens.has(auth.replace(/^Bearer /, ''))) return json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': `Bearer resource_metadata="${st.base}/.well-known/oauth-protected-resource/mcp", scope="lire"` });
    const m = JSON.parse(await body(req));
    if (m.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'faux', version: '1' } } });
    if (m.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'bonjour', description: 'dit bonjour', inputSchema: { type: 'object', properties: {} } }] } });
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    return json(res, 200, { jsonrpc: '2.0', id: m.id, result: {} });
  }
  if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, { resource: `${st.base}/mcp`, authorization_servers: [`${st.base}/auth`] });
  if (u.pathname === '/.well-known/oauth-authorization-server/auth') return json(res, 200, { issuer: `${st.base}/auth`, authorization_endpoint: `${st.base}/auth/authorize`, token_endpoint: `${st.base}/auth/token`, registration_endpoint: `${st.base}/auth/register`, code_challenge_methods_supported: ['S256'] });
  if (u.pathname === '/auth/register') { st.registered++; const b = JSON.parse(await body(req)); assert.equal(b.token_endpoint_auth_method, 'none'); return json(res, 201, { client_id: 'client-' + st.registered, redirect_uris: b.redirect_uris }); }
  if (u.pathname === '/auth/authorize') {                            // « l'utilisateur accepte » : retour immédiat vers FS-CLI
    const code = 'code-' + crypto.randomBytes(4).toString('hex');
    st.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri'), resource: u.searchParams.get('resource') });
    res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state'))}` }); return res.end();
  }
  if (u.pathname === '/auth/token') {
    const p = new URLSearchParams(await body(req));
    if (p.get('grant_type') === 'authorization_code') {
      const c = st.codes.get(p.get('code'));
      if (!c || b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest()) !== c.challenge) return json(res, 400, { error: 'invalid_grant' });   // PKCE
      const t = 'jeton-' + crypto.randomBytes(4).toString('hex'); st.tokens.add(t);
      return json(res, 200, { access_token: t, refresh_token: 'rafraichir', expires_in: 1 });
    }
    if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'rafraichir') { st.refreshes++; const t = 'jeton-r-' + st.refreshes; st.tokens.add(t); return json(res, 200, { access_token: t, expires_in: 3600 }); }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  res.writeHead(404); res.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
st.base = `http://127.0.0.1:${srv.address().port}`;
fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { compte: { url: `${st.base}/mcp` } } }));

const oauth = await import('../src/mcp-oauth.js');
const { McpManager } = await import('../src/mcp.js');
const browser = url => { fetch(url, { redirect: 'follow' }).catch(() => {}); return true; };   // « navigateur » : suit la redirection vers FS-CLI

test('sans connexion : 401 expliqué avec la commande à taper', async () => {
  const mgr = new McpManager({ cwd: proj });
  const r = await mgr.test('compte', 5000);
  assert.equal(r.ok, false);
  assert.match(r.error, /\/mcp login compte/);
});

test('connexion OAuth complète puis outils accessibles ; jeton expiré renouvelé tout seul', async () => {
  // le serveur local de test est en http : le module n'ouvre que des pages https dans le vrai navigateur, ici on simule le navigateur
  let shown = '';
  await oauth.login(`${st.base}/mcp`, { open: browser, onUrl: u => { shown = u; } });
  assert.match(shown, /code_challenge_method=S256/);
  assert.match(shown, /state=/);
  assert.equal(st.registered, 1);
  assert.equal(oauth.hasLogin(`${st.base}/mcp`), true);
  const saved = fs.readFileSync(path.join(home, 'mcp-oauth.json'), 'utf8');
  assert.match(saved, /jeton-/);
  await new Promise(r => setTimeout(r, 1200));                       // le jeton (1 s) expire
  const mgr = new McpManager({ cwd: proj });
  const r = await mgr.test('compte', 5000);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tools.map(t => t.name), ['bonjour']);
  assert.ok(st.refreshes >= 1);                                       // renouvelé sans redemander de connexion
  await mgr.closeAll();
});

test('déconnexion : la clé est retirée', async () => {
  assert.equal(oauth.logout(`${st.base}/mcp`), true);
  assert.equal(oauth.hasLogin(`${st.base}/mcp`), false);
  srv.close();
});
