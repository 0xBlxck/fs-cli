// Client API France Student AI (SSE)
import https from 'node:https';
import { TOKEN, VERSION, cfg, saveCfg } from './config.js';
import { register as registerChat, localTime } from './chats.js';

const HOST = 'api.francestudent.ai';
// Identification honnête (pas de faux navigateur) ; le token ne part que vers api.francestudent.ai en HTTPS
const baseHeaders = () => ({
  'Authorization': `Bearer ${TOKEN}`,
  'User-Agent': `fs-cli/${VERSION} (client communautaire non officiel)`,
});

export class ApiError extends Error {
  constructor(msg, { status, retry = false } = {}) { super(msg); this.status = status; this.retry = retry; }
}

/** corps d'une réponse 429 « Daily new chat limit… » → erreur claire (sans nouvel essai), sinon null */
export function parseDailyLimit(body) {
  if (!/Daily new chat limit/i.test(body || '')) return null;
  let resetAt = '';
  try { resetAt = JSON.parse(body).message.match(/Reset at (\S+?)\.?$/)?.[1] || ''; } catch {}
  const e = new ApiError(`Limite de 50 nouvelles conversations par jour atteinte${resetAt ? ` — remise à zéro ${localTime(resetAt)}` : ''}. ` +
    'Tu peux continuer dans une conversation existante (/history <n°> ou /resume).', { status: 429, retry: false });
  e.code = 'DAILY_CHAT_LIMIT'; e.resetAt = resetAt;
  return e;
}

/** Outils client officiels de FS (mode « avancé ») : appels exécutés sur la machine de l'utilisateur */
export const CLIENT_TOOLS = ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file', 'run_command'];

/** Envoie un fichier (image…) sur Files v2 ; renvoie son id, à mettre dans `files` d'un message. */
export async function uploadFile(buffer, filename, mime = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), String(filename || 'fichier').replace(/[\r\n"\\/]/g, '_').slice(0, 200));
  const r = await fetch(`https://${HOST}/filesv2`, { method: 'POST', headers: { ...baseHeaders(), Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(120000), redirect: 'error' });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new ApiError(`Envoi de ${filename} impossible (HTTP ${r.status}${j?.message ? ' : ' + String(j.message).slice(0, 200) : ''})`, { status: r.status });
  const id = j?.id ?? j?.file_id ?? j?.uuid;
  if (!id) throw new ApiError(`Envoi de ${filename} : réponse sans identifiant`);
  return String(id);
}

function once({ agentId, chatId, content, webSearch, signal, onText, onReasoning, onChat, register, clientTools, toolResults, files }) {
  return new Promise((resolve, reject) => {
    // Outils client : nouveau chat → POST /chats/stream (initialContent + clientTools) ; chat existant → POST /chats/{id} (content + clientTools / toolResults)
    const native = !!(clientTools || toolResults);
    let urlPath = '/chats/stream', body;
    if (native && chatId) {
      urlPath = `/chats/${encodeURIComponent(chatId)}`;
      body = { agentId, ...(content ? { content } : {}), ...(files?.length ? { files } : {}), ...(clientTools ? { clientTools } : {}), ...(toolResults ? { toolResults } : {}), ...(webSearch ? { enableWebSearch: true } : {}) };
    } else {
      body = {
        agentId, chatId: chatId || null, enableCanvas: false, enableWebSearch: !!webSearch,
        images: [], files: files?.length ? files : [], initialContent: content, isIncognito: false, isPrivate: true,
        ...(clientTools ? { clientTools } : {}),
      };
    }
    const payload = JSON.stringify(body);
    let text = '', usage = null, toolCalls = [], opened = false, settled = false, stopped = false, sawCompleted = false, streamError = null, seenChatId = chatId || null;
    const finish = (fn, v) => { if (settled) return; settled = true; fn(v); };

    const req = https.request({
      hostname: HOST, path: urlPath, method: 'POST', signal,
      headers: {
        ...baseHeaders(),
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const st = res.statusCode || 0;
      if (st >= 300) {
        let b = ''; res.setEncoding('utf8');
        res.on('data', d => b += d);
        res.on('end', () => {
          // limite quotidienne de nouvelles conversations : inutile de réessayer, on explique
          const daily = st === 429 ? parseDailyLimit(b) : null;
          if (daily) return finish(reject, daily);
          if (native && (st === 403 || (st === 400 && /Client tools are not supported/i.test(b)))) {       // flag désactivé ou modèle sans outils client (ex. Gemini)
            const e = new ApiError(st === 403 ? 'Le mode « outils client » n\'est pas activé sur ce compte (403).' : 'Ce modèle ne gère pas les outils client (essaie un modèle Claude ou GPT avec /model).', { status: st });
            e.code = 'NATIVE_UNSUPPORTED';
            return finish(reject, e);
          }
          const msg = st === 401 ? '401 — token de session expiré (récupère un nouveau cookie next-auth.session-token)'
            : st === 403 ? '403 — accès refusé (token invalide ?)'
            : st === 429 ? '429 — trop de requêtes, patiente quelques secondes'
            : `HTTP ${st}: ${b.slice(0, 200)}`;
          finish(reject, new ApiError(msg, { status: st, retry: st === 429 || st >= 500 }));
        });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      const handle = (block) => {
        let ev = '', data = [];
        for (const l of block.split('\n')) {
          const t = l.replace(/\r$/, '');
          if (t.startsWith('event:')) ev = t.slice(6).trim();
          else if (t.startsWith('data:')) data.push(t.slice(5).trimStart());
        }
        const pl = data.join('\n');
        if (!pl || pl === '[DONE]') return;
        let d; try { d = JSON.parse(pl); } catch { return; }
        const type = d.type || ev;
        if (d.chat_id) {
          seenChatId = d.chat_id;
          if (!opened) {
            opened = true;
            if (!chatId && register) registerChat(d.chat_id, register);   // nouvelle conversation → registre
            if (!chatId) attachToFsProject(d.chat_id);                       // et rangement dans le Projet FS du CLI
          }
          onChat?.(d.chat_id);
        }
        if (type === 'response.output_text.delta' && typeof d.delta === 'string') {
          text += d.delta;
          onText?.(d.delta, () => {
            if (stopped) return;
            stopped = true; finish(resolve, { text, usage, stopped: true }); req.destroy();
          });
        } else if (type === 'response.reasoning_summary_text.delta' && typeof d.delta === 'string') {
          onReasoning?.(d.delta);
        } else if (type === 'completed') {
          sawCompleted = true;
          usage = d.message?.tokenUsage || null;
          if (Array.isArray(d.message?.toolCalls)) toolCalls = d.message.toolCalls;      // seule source de vérité des appels à exécuter
        } else if (type === 'error' || type === 'response.failed' || type === 'response.error') {
          streamError = d.message || d.error?.message || d.error || JSON.stringify(d).slice(0, 200);
        }
      };
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); handle(b); }
      });
      res.on('end', () => {
        if (buf.trim()) handle(buf);
        if (stopped) return;
        if (streamError) return finish(reject, new ApiError(`Erreur du serveur: ${streamError}`));
        if (!sawCompleted && !text) return finish(reject, new ApiError('Réponse vide / flux interrompu', { retry: !opened }));
        finish(resolve, { text, usage, toolCalls, stopped: false });
      });
      res.on('error', e => { if (!stopped) finish(reject, e); });
    });
    req.setTimeout(150_000, () => req.destroy(new ApiError('Délai dépassé (aucune donnée depuis 150 s)', { retry: !opened })));
    req.on('error', e => {
      if (stopped) return;
      if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
        if (seenChatId) cancelStream(seenChatId);                        // Ctrl+C : on arrête aussi la génération côté serveur (sinon elle continue et consomme)
        return finish(reject, Object.assign(new Error('annulé'), { name: 'AbortError' }));
      }
      finish(reject, e instanceof ApiError ? e : new ApiError(`Réseau: ${e.message}`, { retry: !opened }));
    });
    req.write(payload); req.end();
  });
}

/** Envoie un message avec retry (uniquement si rien n'a encore été reçu). */
export async function streamChat(opts) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await once(opts); }
    catch (e) {
      lastErr = e;
      if (e.name === 'AbortError' || !e.retry || attempt === 2 || opts.signal?.aborted) throw e;
      await new Promise(r => setTimeout(r, [1500, 4000][attempt]));
    }
  }
  throw lastErr;
}

/** GET JSON authentifié ; renvoie null en cas d'erreur (jamais d'exception) */
export function getJson(p, timeout = 12000) {
  return new Promise(resolve => {
    const req = https.get({ hostname: HOST, path: p, headers: baseHeaders() }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => { try { resolve(res.statusCode < 300 ? JSON.parse(d) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

/** Requête JSON authentifiée → { status, data } ; ne lève jamais (status 0 = réseau). */
export function requestJson(method, p, body, timeout = 15000) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: HOST, path: p, method,
      headers: { ...baseHeaders(), Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => { let data = null; try { data = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode || 0, data }); });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, data: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Arrête la génération en cours côté serveur (POST /chats/{id}/stream/cancel, idempotent). */
export async function cancelStream(chatId) {
  if (!chatId) return false;
  const r = await requestJson('POST', `/chats/${encodeURIComponent(chatId)}/stream/cancel`, undefined, 10000);
  return r.status >= 200 && r.status < 300;
}

// ── Projets France Student : les conversations du CLI sont rangées dans un projet (barre latérale du site) ──
export async function listFsProjects() {
  const r = await requestJson('GET', '/projects');
  return Array.isArray(r.data) ? r.data : [];
}
/** Projet par nom (sans tenir compte de la casse), créé s'il n'existe pas. */
export async function findOrCreateFsProject(name) {
  const clean = String(name || '').trim().slice(0, 255);
  if (!clean) throw new Error('nom de projet vide');
  const want = clean.toLocaleLowerCase('fr-FR');
  const found = (await listFsProjects()).find(p => String(p?.name || '').trim().toLocaleLowerCase('fr-FR') === want);
  if (found) return { project: found, created: false };
  const r = await requestJson('POST', '/projects', { name: clean });
  if (!r.data?.id) throw new Error(`création du projet refusée (HTTP ${r.status})`);
  return { project: r.data, created: true };
}
/** Range une conversation dans un projet (PUT /projects/{p}/chats/{c}). */
export async function attachChatToProject(projectId, chatId) {
  const r = await requestJson('PUT', `/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`);
  return r.status >= 200 && r.status < 300;
}

/** Rangement automatique : projet « FS-CLI » par défaut, /fr-project <nom> pour un autre, /fr-project off pour désactiver. Ne lève jamais. */
let projectPromise = null;
function attachToFsProject(chatId) {
  if (cfg.fsProject === false) return;
  const name = cfg.fsProject?.name || 'FS-CLI';
  if (!projectPromise || projectPromise.name !== name) {
    projectPromise = (cfg.fsProject?.id && cfg.fsProject.name === name ? Promise.resolve(cfg.fsProject.id)
      : findOrCreateFsProject(name).then(({ project }) => { cfg.fsProject = { id: project.id, name: project.name || name }; saveCfg(); return project.id; }))
      .catch(() => null);
    projectPromise.name = name;
  }
  projectPromise.then(id => { if (id) attachChatToProject(id, chatId); }).catch(() => {});
}

/** Supprime une conversation (DELETE /chats/{id}) ; true si le serveur accepte */
export function deleteChat(chatId) {
  return new Promise(resolve => {
    const req = https.request({ hostname: HOST, path: `/chats/${encodeURIComponent(chatId)}`, method: 'DELETE', headers: baseHeaders() }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Dernières conversations du compte */
export async function fetchChatsList(limit = 15) {
  const j = await getJson(`/chats?limit=${Math.min(50, Math.max(1, limit))}`);
  return Array.isArray(j) ? j : (j?.chats || []);
}

/** Conversation complète (messages + pièces « panneau » créées côté serveur) */
export function fetchChat(chatId) {
  return new Promise(resolve => {
    const req = https.get({ hostname: HOST, path: `/chats/${encodeURIComponent(chatId)}`, headers: baseHeaders() }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => { try { resolve(res.statusCode < 300 ? JSON.parse(d) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

/** Liste des agents/modèles disponibles ({id: name}) */
export function fetchAgents() {
  return new Promise(resolve => {
    const req = https.get({ hostname: HOST, path: '/chats/agents', headers: baseHeaders() }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', x => d += x);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const arr = Array.isArray(j) ? j : j.agents || [];
          const map = {};
          for (const a of arr) if (a.isActive !== false) map[String(a.id)] = a.name;
          resolve(Object.keys(map).length ? map : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}
