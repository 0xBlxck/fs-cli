// Connexion OAuth des serveurs MCP distants (comme « Authenticate » dans Claude Code) — spécification MCP « Authorization » :
// 401 + WWW-Authenticate → métadonnées de la ressource → serveur d'autorisation → enregistrement dynamique du client (public, sans secret)
// → PKCE (S256) + state → page de connexion dans le navigateur → retour sur 127.0.0.1 → jeton, renouvelé tout seul ensuite.
// Les jetons restent sur ce PC (~/.fs-cli/mcp-oauth.json, droits 0600) ; ils ne sont jamais montrés ni envoyés au modèle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME_DIR } from './config.js';

const FILE = () => path.join(HOME_DIR, 'mcp-oauth.json');
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const keyOf = url => { try { const u = new URL(url); return `${u.origin}${u.pathname.replace(/\/+$/, '')}`; } catch { return String(url); } };

function read() { try { const o = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } }
function write(o) {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}
export const hasLogin = url => !!read()[keyOf(url)]?.access_token;
export function logout(url) { const o = read(); const had = !!o[keyOf(url)]; delete o[keyOf(url)]; write(o); return had; }

async function getJson(url, init = {}) {
  const r = await fetch(url, { redirect: 'follow', ...init, headers: { Accept: 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* pas du JSON */ }
  return { status: r.status, ok: r.ok, json: j, text, headers: r.headers };
}

/** WWW-Authenticate: Bearer resource_metadata="…", scope="…" */
function parseChallenge(h) {
  const out = {};
  for (const m of String(h || '').matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** métadonnées du serveur d'autorisation (RFC 8414, avec insertion du chemin de l'émetteur) */
async function authServerMeta(issuer) {
  const u = new URL(issuer), p = u.pathname.replace(/\/+$/, '');
  const tries = [
    `${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}${p}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`,
  ];
  for (const t of [...new Set(tries)]) {
    const r = await getJson(t).catch(() => null);
    if (r?.ok && r.json?.authorization_endpoint && r.json?.token_endpoint) return r.json;
  }
  throw new Error(`configuration de connexion introuvable chez ${issuer}`);
}

/** découverte complète à partir de l'URL du serveur MCP */
export async function discover(url) {
  const probe = await fetch(url, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fs-cli', version: '1' } } }),
  }).catch(e => { throw new Error(`serveur injoignable : ${e.cause?.code || e.message}`); });
  probe.body?.cancel?.().catch(() => {});
  const ch = parseChallenge(probe.headers.get('www-authenticate'));
  const u = new URL(url);
  const prmUrls = [ch.resource_metadata, `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/+$/, '')}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let prm = null;
  for (const p of prmUrls) { const r = await getJson(p).catch(() => null); if (r?.ok && r.json?.authorization_servers?.length) { prm = r.json; break; } }
  if (!prm) throw new Error('ce serveur n\'annonce pas de connexion OAuth standard : ajoute une clé dans la config ("headers": {"Authorization": "Bearer …"})');
  const as = await authServerMeta(prm.authorization_servers[0]);
  const scope = ch.scope || (Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(' ') : '');
  return { resource: prm.resource || keyOf(url), as, scope };
}

/** ouvre une adresse dans le navigateur par défaut, sans passer par un interpréteur de commandes */
export function openInBrowser(url) {
  if (!/^https:\/\//i.test(url)) return false;
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); return true; } catch { return false; }
}

/** connexion complète ; onUrl reçoit l'adresse de la page de connexion (affichée en plus de l'ouverture automatique) */
export async function login(url, { onUrl, open = openInBrowser, timeoutMs = 300000, signal } = {}) {
  const d = await discover(url);
  if (!d.as.registration_endpoint) throw new Error('ce service ne permet pas l\'enregistrement automatique d\'une application : ajoute une clé dans la config ("headers": {"Authorization": "Bearer …"})');
  const methods = d.as.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) throw new Error('ce service ne gère pas PKCE (S256) : connexion refusée par sécurité');

  // 1) serveur de retour local, port choisi par le système
  let resolveCb, rejectCb;
  const got = new Promise((res, rej) => { resolveCb = res; rejectCb = rej; });
  got.catch(() => {});                                                  // rejet traité plus bas (await) : pas d'alerte « non gérée »
  const state = b64url(crypto.randomBytes(24));
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://127.0.0.1');
    if (q.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const ok = q.searchParams.get('state') === state && q.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>FS-CLI</title><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${ok ? '✓ Connexion réussie' : '✗ Connexion refusée'}</h2><p>${ok ? 'Tu peux fermer cet onglet et revenir à FS-CLI.' : 'Réessaie depuis FS-CLI.'}</p></body>`);
    if (q.searchParams.get('state') !== state) return rejectCb(new Error('réponse de connexion invalide (state)'));
    if (q.searchParams.get('error')) return rejectCb(new Error(`connexion refusée : ${q.searchParams.get('error_description') || q.searchParams.get('error')}`));
    resolveCb(q.searchParams.get('code'));
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(() => rejectCb(new Error('délai dépassé (5 min) : connexion non terminée')), timeoutMs);
  signal?.addEventListener('abort', () => rejectCb(new Error('annulé')), { once: true });
  try {
    // 2) enregistrement du client (public, sans secret)
    const reg = await getJson(d.as.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'FS-CLI', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(d.scope ? { scope: d.scope } : {}) }),
    });
    const clientId = reg.json?.client_id;
    if (!clientId) throw new Error(`enregistrement de l'application refusé (HTTP ${reg.status})`);

    // 3) page de connexion (PKCE)
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const auth = new URL(d.as.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, resource: d.resource, ...(d.scope ? { scope: d.scope } : {}) })) auth.searchParams.set(k, v);
    onUrl?.(auth.toString());
    open(auth.toString());
    const code = await got;

    // 4) échange du code contre le jeton
    const tok = await getJson(d.as.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: d.resource }).toString(),
    });
    if (!tok.json?.access_token) throw new Error(`jeton refusé (HTTP ${tok.status}${tok.json?.error ? ` : ${tok.json.error_description || tok.json.error}` : ''})`);
    const o = read();
    o[keyOf(url)] = {
      access_token: tok.json.access_token, refresh_token: tok.json.refresh_token || null,
      expires_at: tok.json.expires_in ? Date.now() + Number(tok.json.expires_in) * 1000 : null,
      token_endpoint: d.as.token_endpoint, client_id: clientId, resource: d.resource, savedAt: Date.now(),
    };
    write(o);
    return { ok: true };
  } finally { clearTimeout(timer); server.close(); }
}

/** jeton valide pour cette URL (renouvelé s'il expire bientôt) ; null s'il n'y a pas de connexion */
export async function bearerFor(url, { force = false } = {}) {
  const o = read(), k = keyOf(url), t = o[k];
  if (!t?.access_token) return null;
  const expiring = t.expires_at && t.expires_at - Date.now() < 60_000;
  if (!force && !expiring) return t.access_token;
  if (!t.refresh_token) return force ? null : t.access_token;
  const r = await getJson(t.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, ...(t.resource ? { resource: t.resource } : {}) }).toString(),
  }).catch(() => null);
  if (!r?.json?.access_token) return force ? null : t.access_token;
  o[k] = { ...t, access_token: r.json.access_token, refresh_token: r.json.refresh_token || t.refresh_token, expires_at: r.json.expires_in ? Date.now() + Number(r.json.expires_in) * 1000 : null, savedAt: Date.now() };
  write(o);
  return o[k].access_token;
}
