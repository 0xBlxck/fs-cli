// Serveur MCP (fs-cli --mcp) : d'autres agents (Antigravity, Claude Code, Codex…) utilisent France Student à travers FS-CLI.
// Transport stdio : JSON-RPC 2.0, un message JSON par ligne. STDOUT ne contient QUE du JSON-RPC (tout le reste est redirigé).
// Outils : fs_models (liste des modèles), fs_ask (question simple, sans outils), fs_agent (vrai agent FS-CLI, sans humain : tout ce
// qui demanderait une confirmation est REFUSÉ automatiquement). Aucune dépendance npm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import readline from 'node:readline';
import { TOKEN, VERSION, cfg, saveCfg, saveCfgKeys, FILES, ROOT } from './config.js';
import { streamChat, fetchAgents, requestJson, lastMessageImages, fetchApiFile, setProjectOverride, fetchChatsList, listFsProjects } from './api.js';
import { newSid, tag } from './chats.js';
import { isFolderTrusted, isBroadFolder, trustFolder } from './trust.js';
import { summarizeChanges } from './changes.js';
import * as ui from './ui.js';

export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'france-student';

// modèles connus si /chats/agents ne répond pas (mêmes valeurs que cli.js)
const FALLBACK_AGENTS = {
  '-1002': 'GPT-6 Luna', '-1003': 'GPT-6.1 Sol', '-1004': 'GPT-6 Astra',
  '-2001': 'Claude Opus 5.5', '-2002': 'Claude Haiku 5.5', '-2003': 'Claude Sonnet 5.5', '-2005': 'Claude Fable 5.2',
};

const NO_TOKEN = 'Aucune clé de session France Student n\'est configurée pour FS-CLI. ' +
  'Lance « fs-cli » une fois dans un terminal pour te connecter (assistant de connexion), puis redémarre l\'application de l\'agent.';

const INSTRUCTIONS = 'Serveur MCP de FS-CLI (client communautaire non officiel de France Student AI). ' +
  'fs_models liste les modèles ; fs_ask pose une question à un modèle France Student (texte seulement) ; ' +
  'fs_agent confie une tâche de code à l\'agent FS-CLI dans un dossier que l\'utilisateur a déjà approuvé avec fs-cli. ' +
  'Le compte est limité à 50 nouvelles conversations par jour : les conversations sont réutilisées, n\'utilise new_conversation que si c\'est nécessaire.';

export const TOOL_DEFS = [
  {
    name: 'fs_models',
    title: 'Modèles France Student',
    description: 'Liste les modèles disponibles sur le compte France Student de l\'utilisateur : identifiant (ex. -2003), nom (ex. « Claude Sonnet 5.5 ») et taille de la fenêtre de contexte quand elle est connue. ' +
      'Le nom ou l\'identifiant peut ensuite être passé dans le paramètre « model » de fs_ask et fs_agent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'fs_ask',
    title: 'Demander à France Student',
    description: 'Envoie une question à un modèle France Student et renvoie sa réponse en texte. Le modèle n\'a AUCUN accès aux fichiers ni aux commandes : ' +
      'mets dans « prompt » tout le contexte utile. Une seule conversation, choisie par l\'utilisateur, est réutilisée (le modèle se souvient des échanges précédents) ; ' +
      'new_conversation=true en démarre une nouvelle (à éviter : le compte est limité à 50 nouvelles conversations par jour). ' +
      'Les modèles GPT savent GÉNÉRER DES IMAGES : demande-le dans « prompt » ; l\'image est renvoyée dans la réponse (save_dir pour l\'enregistrer aussi sur le disque).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'La question ou la demande, avec tout le contexte nécessaire.' },
        model: { type: 'string', description: 'Modèle à utiliser : nom (ex. « sonnet », « Claude Opus 5.5 », « luna ») ou identifiant (ex. « -2003 »). Par défaut : le modèle choisi dans fs-cli.' },
        new_conversation: { type: 'boolean', description: 'true = nouvelle conversation (oublie les échanges précédents). Par défaut false.', default: false },
        conversation_id: { type: 'string', description: 'Identifiant d\'une conversation France Student précise à utiliser pour cette demande (facultatif, seulement si l\'utilisateur le donne).' },
        save_dir: { type: 'string', description: 'Dossier (chemin absolu) où enregistrer les images générées. Facultatif : sans lui, les images sont seulement renvoyées dans la réponse.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'fs_agent',
    title: 'Agent FS-CLI (France Student)',
    description: 'Confie une tâche à l\'agent FS-CLI : un modèle France Student lit, cherche et modifie les fichiers du dossier « folder » avec les outils officiels de France Student, puis renvoie son compte rendu, ' +
      'la liste des fichiers modifiés et le nombre d\'appels d\'outils. Le dossier doit être un chemin ABSOLU déjà approuvé par l\'utilisateur dans fs-cli (sinon refus). ' +
      'Aucun humain ne répond aux confirmations : les actions sensibles (commandes dangereuses ou à confirmer, chemins protégés, secrets, écritures hors du dossier) sont refusées automatiquement. ' +
      'Les modifications de fichiers dans le dossier sont permises. Une conversation est réutilisée par dossier pendant la session du serveur.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'La tâche à réaliser, précise et complète (fichiers concernés, résultat attendu).' },
        folder: { type: 'string', description: 'Chemin absolu du dossier de travail (déjà approuvé avec fs-cli).' },
        model: { type: 'string', description: 'Modèle (nom ou identifiant, voir fs_models). Par défaut : le modèle choisi dans fs-cli. Les modèles Claude acceptent le mieux de travailler avec les outils.' },
        new_conversation: { type: 'boolean', description: 'true = nouvelle conversation pour ce dossier. Par défaut false.', default: false },
        conversation_id: { type: 'string', description: 'Identifiant d\'une conversation France Student précise à utiliser (facultatif, seulement si l\'utilisateur le donne).' },
      },
      required: ['task', 'folder'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

/** même logique que resolveModel de cli.js : identifiant exact, numéro dans la liste, nom exact, puis nom partiel */
export function resolveModelIn(agents, arg) {
  arg = String(arg ?? '').trim();
  if (!arg) return null;
  if (agents[arg]) return parseInt(arg);
  const keys = Object.keys(agents);
  if (/^\d{1,2}$/.test(arg) && keys[parseInt(arg) - 1]) return parseInt(keys[parseInt(arg) - 1]);
  const low = arg.toLowerCase();
  const hit = keys.find(k => String(agents[k]).toLowerCase() === low) || keys.find(k => String(agents[k]).toLowerCase().includes(low));
  return hit ? parseInt(hit) : null;
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) });
/** images générées → contenus MCP « image » (+ enregistrement si save_dir est donné) */
const MAX_IMG = 8_000_000;
function imageContents(imgs, saveDir) {
  const out = [], saved = [];
  for (const im of imgs) {
    if (!im?.data || im.data.length > MAX_IMG) continue;
    out.push({ type: 'image', data: im.data.toString('base64'), mimeType: /^image\/(png|jpeg|webp|gif)$/.test(im.mime) ? im.mime : 'image/png' });
    if (saveDir) { try { fs.mkdirSync(saveDir, { recursive: true }); const f = path.join(saveDir, String(im.name || 'image.png').replace(/[^\w.-]/g, '_')); fs.writeFileSync(f, im.data); saved.push(f); } catch {} }
  }
  return { out, saved };
}
const withImages = (result, imgs, saveDir) => {
  if (!imgs.length) return result;
  const { out, saved } = imageContents(imgs, saveDir);
  if (!out.length) return result;
  const note = `${out.length} image${out.length > 1 ? 's' : ''} générée${out.length > 1 ? 's' : ''} par France Student (jointe${out.length > 1 ? 's' : ''} ci-dessous)${saved.length ? ` · enregistrée${saved.length > 1 ? 's' : ''} : ${saved.join(', ')}` : ' · non enregistrée sur le disque (paramètre save_dir pour l\'enregistrer)'}.`;
  return { ...result, content: [...result.content, { type: 'text', text: note }, ...out] };
};

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Réponse automatique aux confirmations : toujours NON (aucun humain derrière le serveur MCP). */
const REFUSAL_NOTE = 'refus automatique : FS-CLI tourne comme serveur MCP pour un autre agent, sans humain pour confirmer. Trouve une autre façon de faire, sans cette action, ou explique dans ta réponse ce que l\'utilisateur devra faire lui-même.';

/**
 * Cœur du serveur, sans entrées-sorties (testable). deps : remplaçables dans les tests.
 * handle(msg) → réponse JSON-RPC (objet) ou null (notification).
 */
export function createMcpServer(deps = {}) {
  const d = {
    hasToken: () => !!TOKEN,
    stream: streamChat,
    fetchAgents,
    fetchAgentsFull: async () => (await requestJson('GET', '/chats/agents').catch(() => ({}))).data,   // { data: [...] } déballé
    fetchApiFile,
    listChats: n => fetchChatsList(n),
    listProjects: listFsProjects,
    runNative: null,                                                   // chargé à la demande (moteur natif + outils locaux)
    allowCommands: process.env.FS_MCP_ALLOW_COMMANDS === '1',
    ...deps,
  };
  let agents = null;
  const askState = { chatId: cfg.mcpChat?.id || null, sid: newSid() };   // conversation du MCP retenue dans ta config : réutilisée après un redémarrage
  if (cfg.mcpProject !== 'same' && cfg.mcpProject !== undefined) setProjectOverride(cfg.mcpProject || false);
  /** conversation à utiliser : celle demandée (conversation_id), sinon celle du MCP */
  const chatFor = args => (typeof args.conversation_id === 'string' && /^[\w-]{8,64}$/.test(args.conversation_id) ? args.conversation_id : null);
  const remember = (id, title) => { if (id && cfg.mcpChat?.id !== id) saveCfgKeys({ mcpChat: { id, title: title || '', since: Date.now() } }); };
  const cleanTitle = t => String(t || '(sans titre)').replace(/^\[[0-9a-f]{4}(?:·[^\]]*)?\]\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(sans titre)';

  // ── requêtes vers le client (elicitation : l'IDE affiche un petit formulaire à l'utilisateur) ──
  let clientCanAsk = false, askedWhere = false, reqN = 0;
  const waiting = new Map();
  function request(method, params, signal, ms = 10 * 60_000) {
    if (!d.notify) return Promise.reject(new Error('pas de canal vers le client'));
    const id = `fs-cli-${++reqN}`;
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); waiting.delete(id); signal?.removeEventListener?.('abort', onAbort); };
      const onAbort = () => { stop(); reject(Object.assign(new Error('annulé'), { name: 'AbortError' })); };
      const timer = setTimeout(() => { stop(); reject(new Error('pas de réponse de l\'utilisateur')); }, ms);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      waiting.set(id, msg => { stop(); if (msg.error) reject(new Error(msg.error.message || 'refus du client')); else resolve(msg.result); });
      d.notify({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** premier appel de la session : l'IDE demande où parler (boutons). null = rien demandé · { cancel } = l'utilisateur a fermé la fenêtre */
  async function chooseWhere(signal) {
    if (askedWhere || !clientCanAsk || cfg.mcpAskWhere === false) return null;
    askedWhere = true;
    const [chats, projects] = await Promise.all([d.listChats(12).catch(() => []), d.listProjects().catch(() => [])]);
    const conv = [], convNames = [];
    if (askState.chatId) { conv.push('keep'); convNames.push(`Continuer la conversation du MCP${cfg.mcpChat?.title ? ` (« ${cleanTitle(cfg.mcpChat.title)} »)` : ''}`); }
    conv.push('new'); convNames.push('Nouvelle conversation');
    const titles = new Map();
    for (const ch of (Array.isArray(chats) ? chats : []).slice(0, 10)) {
      if (!ch?.id || ch.id === askState.chatId || !/^[\w-]{8,64}$/.test(ch.id)) continue;
      conv.push(`chat:${ch.id}`); convNames.push(`Conversation « ${cleanTitle(ch.title)} »`); titles.set(ch.id, ch.title || '');
    }
    const properties = {
      conversation: { type: 'string', title: 'Conversation France Student', description: 'Où le MCP doit écrire sur ton compte France Student', enum: conv, enumNames: convNames, default: conv[0] },
    };
    const projs = (Array.isArray(projects) ? projects : []).filter(p => p?.id).slice(0, 10);
    const curProj = cfg.mcpProject === 'same' || cfg.mcpProject === undefined ? 'same' : cfg.mcpProject?.id ? `project:${cfg.mcpProject.id}` : 'none';
    const pe = ['same', 'none', ...projs.map(p => `project:${p.id}`)];
    properties.project = { type: 'string', title: 'Ranger une nouvelle conversation dans', description: 'Seulement pour une nouvelle conversation',
      enum: pe, enumNames: ['Comme FS-CLI', 'Aucun projet (conversations normales)', ...projs.map(p => `Projet « ${cleanTitle(p.name)} »`)], default: pe.includes(curProj) ? curProj : 'same' };
    properties.remember = { type: 'boolean', title: 'Retenir ce choix et ne plus demander', default: false };
    let r;
    try {
      r = await request('elicitation/create', { message: 'France Student : dans quelle conversation le MCP doit-il parler ?', requestedSchema: { type: 'object', properties, required: ['conversation'] } }, signal);
    } catch (e) { if (e?.name === 'AbortError') throw e; return null; }   // le client ne sait pas afficher le formulaire : choix enregistré
    if (r?.action !== 'accept') { askedWhere = false; return { cancel: true }; }   // fenêtre fermée : on redemandera
    const v = r.content || {};
    if (typeof v.project === 'string' && pe.includes(v.project)) {
      const p = v.project === 'same' ? undefined : v.project === 'none' ? false : (pr => pr && { id: pr.id, name: pr.name })(projs.find(x => `project:${x.id}` === v.project));
      setProjectOverride(p);
      if (v.remember === true) saveCfgKeys({ mcpProject: p === undefined ? 'same' : p });
    }
    if (v.conversation === 'new') { askState.chatId = null; askState.sid = newSid(); folders.clear(); }
    else if (typeof v.conversation === 'string' && v.conversation.startsWith('chat:') && conv.includes(v.conversation)) {
      const id = v.conversation.slice(5);
      askState.chatId = id; remember(id, titles.get(id)); folders.clear();
    }
    if (v.remember === true) saveCfgKeys({ mcpAskWhere: false });
    return null;
  }
  /** dossier pas encore approuvé : l'IDE le demande à l'utilisateur (c'est lui qui clique, jamais l'agent). Jamais pour un disque entier ou le dossier personnel. */
  async function askTrust(dir, signal) {
    if (!clientCanAsk || isBroadFolder(dir)) return false;
    let r;
    try {
      r = await request('elicitation/create', {
        message: `Faire confiance à ce dossier ?\n${dir}\n\nL'agent FS-CLI (modèle France Student) pourra y lire, créer et modifier des fichiers. Les commandes et actions sensibles restent refusées automatiquement.`,
        requestedSchema: { type: 'object', properties: { trust: { type: 'string', title: 'Ta réponse', enum: ['always', 'session', 'no'], enumNames: ['Oui, je fais confiance à ce dossier', 'Oui, pour cette session seulement', 'Non'], default: 'always' } }, required: ['trust'] },
      }, signal);
    } catch (e) { if (e?.name === 'AbortError') throw e; return false; }
    const v = r?.action === 'accept' ? r.content?.trust : 'no';
    if (v === 'always') trustFolder(dir);
    else if (v === 'session') trustFolder(dir, { remember: false });
    else return false;
    return true;
  }
  const CANCELLED = () => textResult('L\'utilisateur a fermé la fenêtre de choix de la conversation : rien n\'a été envoyé à France Student. Demande-lui avant de réessayer.', true);
  const gone = e => /Chat not found|not found with id/i.test(String(e?.message || e));
  const folders = new Map();                                           // dossier normalisé → état de session de l'agent
  const running = new Map();                                           // id de requête → AbortController
  let queue = Promise.resolve();                                       // fs_ask / fs_agent : un à la fois (réglages globaux, quotas)
  const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  async function getAgents() {
    if (!agents) agents = (await d.fetchAgents().catch(() => null)) || null;
    return agents || FALLBACK_AGENTS;
  }
  async function pickModel(arg) {
    if (arg === undefined || arg === null || String(arg).trim() === '') return { id: cfg.agentId };
    const list = await getAgents();
    const id = resolveModelIn(list, arg);
    if (id === null) return { error: `Modèle « ${arg} » inconnu. Modèles disponibles : ${Object.entries(list).map(([k, v]) => `${v} (${k})`).join(', ')}.` };
    return { id };
  }
  const nameOf = id => (agents || FALLBACK_AGENTS)[String(id)] || `#${id}`;

  async function toolModels() {
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const j = await d.fetchAgentsFull();
    const arr = Array.isArray(j) ? j : (j?.data || j?.agents);   // la vraie API renvoie { data: [...] }
    if (!Array.isArray(arr)) return textResult('Impossible de récupérer la liste des modèles France Student (réseau, ou clé de session expirée : relance « fs-cli --login »).', true);
    const list = arr.filter(a => a && a.isActive !== false).map(a => ({ id: a.id, name: a.name, contextWindow: Number(a.contextWindow) || null }));
    agents = Object.fromEntries(list.map(a => [String(a.id), a.name]));
    const lines = list.map(a => `- ${a.name} (id ${a.id})${a.contextWindow ? ` · contexte ${a.contextWindow.toLocaleString('fr-FR')} tokens` : ''}${String(a.id) === String(cfg.agentId) ? ' · modèle par défaut' : ''}`);
    return textResult(`${list.length} modèle${list.length > 1 ? 's' : ''} France Student :\n${lines.join('\n')}\n\nJSON : ${JSON.stringify(list)}`);
  }

  async function toolAsk(args, signal) {
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (!prompt.trim()) return textResult('Paramètre « prompt » manquant ou vide.', true);
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const m = await pickModel(args.model);
    if (m.error) return textResult(m.error, true);
    const target = chatFor(args);                                      // conversation précise demandée par l'utilisateur
    if (!target && args.new_conversation !== true && (await chooseWhere(signal))?.cancel) return CANCELLED();
    if (args.new_conversation === true) { askState.chatId = null; askState.sid = newSid(); }
    const send = async chatId => {
      let content = prompt;
      if (!chatId && cfg.tagChats !== false) content = tag(askState.sid, 'mcp') + content;
      return d.stream({
        agentId: m.id, chatId, content, signal, webSearch: false, register: { sid: askState.sid, role: 'mcp' },
        onChat: id => { if (!target && !askState.chatId) { askState.chatId = id; remember(id); } },
      });
    };
    try {
      let res;
      try { res = await send(target || askState.chatId); }
      catch (e) { if (!gone(e) || target) throw e; askState.chatId = null; saveCfgKeys({ mcpChat: null }); res = await send(null); }   // conversation supprimée sur le site : une neuve
      if (!target && askState.chatId) remember(askState.chatId);
      const text = String(res?.text || '').trim();
      let imgs = [];
      const usedChat = target || askState.chatId;
      if (res?.sawImage && usedChat) {                            // image générée côté France Student (modèles GPT) : récupérée en mémoire
        const list = res.images?.length ? res.images : await lastMessageImages(usedChat).catch(() => []);
        for (const im of list) { try { imgs.push({ data: await d.fetchApiFile(im.url), mime: im.contentType, prompt: im.prompt, name: `image-${String(im.id || Date.now()).slice(0, 8)}.${im.ext}` }); } catch {} }
      }
      if (!text && !imgs.length) return textResult(`${nameOf(m.id)} n'a renvoyé aucune réponse.`, true);
      return withImages(textResult(text || '(image seule)'), imgs, typeof args.save_dir === 'string' && path.isAbsolute(args.save_dir) ? args.save_dir : '');
    } catch (e) {
      if (e?.name === 'AbortError') return textResult('Demande annulée.', true);
      return textResult(`Erreur France Student : ${e?.message || e}`, true);
    }
  }

  async function toolAgent(args, signal, progress = () => {}) {
    const task = typeof args.task === 'string' ? args.task : '';
    const folder = typeof args.folder === 'string' ? args.folder.trim() : '';
    if (!task.trim()) return textResult('Paramètre « task » manquant ou vide.', true);
    if (!folder) return textResult('Paramètre « folder » manquant : donne le chemin absolu du dossier de travail.', true);
    if (!path.isAbsolute(folder)) return textResult(`« folder » doit être un chemin absolu (reçu : ${folder}).`, true);
    let st = null; try { st = fs.statSync(folder); } catch {}
    if (!st?.isDirectory()) return textResult(`Dossier introuvable : ${folder}`, true);
    const dir = path.resolve(folder);
    // sécurité : seul l'utilisateur peut approuver un dossier, dans fs-cli (jamais l'agent qui appelle ce serveur)
    if (!isFolderTrusted(dir) && !(await askTrust(dir, signal))) {
      return textResult(`Dossier non approuvé : ${dir}\nPar sécurité, fs_agent ne travaille que dans un dossier que l'utilisateur a déjà approuvé. ` +
        `Demande à l'utilisateur d'ouvrir ce dossier une fois avec fs-cli (cd dans le dossier puis « fs-cli ») et de répondre « Oui, je fais confiance à ce dossier », puis réessaie.`, true);
    }
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const m = await pickModel(args.model);
    if (m.error) return textResult(m.error, true);
    if (!d.runNative) {
      const { detectEnv } = await import('./tools.js');
      await detectEnv();
      d.runNative = (await import('./native.js')).runNative;
    }
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (!folders.has(key) && !chatFor(args) && args.new_conversation !== true && (await chooseWhere(signal))?.cancel) return CANCELLED();
    let S = folders.get(key);
    if (!S || args.new_conversation === true) {
      S = { chatId: chatFor(args) || (args.new_conversation === true ? null : askState.chatId), sid: newSid(), agentId: m.id, cwd: dir, targetDir: null, undo: [], allow: {}, pendingResults: [], notes: [], tokens: { in: 0, out: 0 }, slots: {}, stats: { turns: 0, requests: 0, tools: 0 }, lastResponse: '' };
      folders.set(key, S);
    }
    S.agentId = m.id; S.allow = {};                                    // aucune autorisation « toujours » ne survit d'une tâche à l'autre
    const from = S.undo.length, tools0 = S.stats.tools;
    S.lastResponse = '';
    const log = [], refused = [];
    const ask = async q => {
      if (/raison|alternative/i.test(String(q))) return REFUSAL_NOTE;  // explication renvoyée au modèle
      let at = -1;
      for (let k = log.length - 1; k >= 0; k--) if (/^\s*[⚠?]\s/.test(log[k])) { at = k; break; }
      let what = (at >= 0 ? log[at] : String(q)).replace(/^\s*[⚠?]\s*/, '').trim();
      const detail = at >= 0 && log[at + 1] ? log[at + 1].trim() : '';
      if (detail && /^(shell|python)\b|^Action sensible/.test(what)) what += ` — ${detail.length > 200 ? detail.slice(0, 199) + '…' : detail}`;   // commandes : la ligne lancée (jamais le contenu d'un fichier ni un secret)
      refused.push(what);
      return 'n';
    };
    // mode : fichiers sans confirmation ; commandes refusées (ou, si l'utilisateur l'a choisi via FS_MCP_ALLOW_COMMANDS=1, seules les commandes sans danger)
    const savedMode = cfg.mode;
    cfg.mode = d.allowCommands ? 'auto' : 'edits';
    ui.attachSink({ print: s => { for (const l of ui.stripAnsi(String(s)).split('\n')) if (l.trim()) { log.push(l); if (log.length > 400) log.shift(); progress(l.trim()); } }, spinner: () => {} });
    let error = null;
    const agentImages = [];
    ui.onImage(im => agentImages.push(im));                            // images générées pendant la tâche : renvoyées à l'appelant
    try {
      await d.runNative(S, task, { signal, ask });
      if (!chatFor(args) && S.chatId && !askState.chatId) { askState.chatId = S.chatId; remember(S.chatId); }   // même conversation pour fs_ask et fs_agent
    }
    catch (e) { error = e; }
    finally {
      ui.onImage(null);
      cfg.mode = savedMode;
      restoreSavedMode(savedMode);
      ui.attachSink(SILENT_SINK);
    }
    for (const l of log) if (/refusé par la politique de sécurité/i.test(l)) refused.push(l.replace(/^[\s⎿]+/, '').trim());
    const changes = summarizeChanges(S.undo, from);
    const nTools = S.stats.tools - tools0;
    const parts = [];
    if (error) parts.push(error.name === 'AbortError' ? 'Tâche annulée.' : error.code === 'NATIVE_UNSUPPORTED' ? `${error.message}` : `Erreur : ${error.message || error}`);
    parts.push(S.lastResponse ? `Réponse de ${nameOf(S.agentId)} :\n${S.lastResponse}` : `(${nameOf(S.agentId)} n'a pas écrit de compte rendu)`);
    const rel = p => { const r = path.relative(dir, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
    parts.push(changes.length
      ? `Fichiers modifiés (${changes.length}) :\n${changes.map(f => `- ${rel(f.path)}${f.created ? ' (créé)' : f.deleted ? ' (supprimé)' : ''}${f.binary ? ' binaire' : ` +${f.added} −${f.removed}`}`).join('\n')}`
      : 'Fichiers modifiés : aucun.');
    parts.push(`Appels d'outils : ${nTools}.`);
    if (refused.length) parts.push(`Actions refusées automatiquement (${refused.length}) :\n${[...new Set(refused)].slice(0, 20).map(r => `- ${r}`).join('\n')}`);
    return withImages(textResult(parts.join('\n\n'), !!error && !S.lastResponse), agentImages, '');
  }

  /** notifications/progress (si le client a fourni un progressToken) : l'agent appelant voit que le travail avance (au plus une toutes les 2 s) */
  function progressFor(params) {
    const token = params?._meta?.progressToken;
    if ((typeof token !== 'string' && typeof token !== 'number') || !d.notify) return () => {};
    let n = 0, last = 0;
    return message => {
      const now = Date.now(); if (now - last < 2000) return; last = now;
      d.notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: String(message).slice(0, 200) } });
    };
  }

  async function callTool(params, signal) {
    const name = params?.name, args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (name === 'fs_models') return toolModels();
    if (name === 'fs_ask') return serial(() => toolAsk(args, signal));
    if (name === 'fs_agent') { const progress = progressFor(params); return serial(() => toolAgent(args, signal, progress)); }
    return null;
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.id !== undefined && msg.method === undefined) { waiting.get(msg.id)?.(msg); return null; }   // réponse du client à une de nos requêtes
      return rpcError(msg?.id, -32600, 'Invalid Request');
    }
    const { id, method, params } = msg;
    const isNotif = id === undefined;
    if (isNotif) {
      if (method === 'notifications/cancelled') running.get(params?.requestId)?.abort();
      return null;                                                     // notifications/initialized et autres : pas de réponse
    }
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        clientCanAsk = !!params?.capabilities?.elicitation;           // Claude Code… : sait afficher un formulaire à l'utilisateur
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fs-cli', title: 'France Student (FS-CLI)', version: VERSION },
          instructions: INSTRUCTIONS,
        } };
      }
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } };
      case 'tools/call': {
        const ac = new AbortController();
        running.set(id, ac);
        try {
          const r = await callTool(params, ac.signal);
          if (!r) return rpcError(id, -32602, `Outil inconnu : ${params?.name}`);
          return { jsonrpc: '2.0', id, result: r };
        } catch (e) {
          return { jsonrpc: '2.0', id, result: textResult(`Erreur interne de FS-CLI : ${e?.message || e}`, true) };
        } finally { running.delete(id); }
      }
      default: return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return { handle, abortAll: () => { for (const ac of running.values()) ac.abort(); } };
}

const SILENT_SINK = { print: () => {}, spinner: () => {} };

/** le mode imposé pendant fs_agent ne doit jamais rester enregistré dans la config de l'utilisateur (runNative peut appeler saveCfg) */
function restoreSavedMode(mode) {
  try { const saved = JSON.parse(fs.readFileSync(FILES.cfg, 'utf8')); if (saved.mode !== undefined && saved.mode !== mode) saveCfg(); } catch {}
}

/** Lance le serveur sur stdin/stdout. Se termine quand stdin est fermé. */
export async function runMcpServer() {
  // STDOUT : uniquement nos messages JSON-RPC. Tout le reste (console.*, affichage du CLI, bips) part sur stderr.
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, enc, cb) => process.stderr.write(chunk, enc, cb);
  const toErr = (...a) => { try { process.stderr.write(util.format(...a) + '\n'); } catch {} };
  console.log = console.info = console.warn = console.error = console.debug = toErr;
  ui.attachSink(SILENT_SINK);
  try { process.stdout.setDefaultEncoding?.('utf8'); } catch {}

  const send = obj => { try { realWrite(JSON.stringify(obj) + '\n'); } catch {} };
  const server = createMcpServer({ notify: send });
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send(rpcError(null, -32700, 'Parse error')); return; }
    const p = server.handle(msg).then(r => { if (r) send(r); }, e => { if (msg?.id !== undefined) send(rpcError(msg.id, -32603, String(e?.message || e))); });
    pending.add(p); p.finally(() => pending.delete(p));
  });
  await new Promise(res => rl.on('close', res));
  server.abortAll();                                                   // le client est parti : on arrête le travail en cours
  await Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, 3000).unref())]);
}

// ── Inscription dans les agents du PC (fs-cli --install-mcp) ──────────────────

/** dossier personnel ciblé : FS_IMPORT_HOME (tests) ; jamais le vrai dossier quand FS_CLI_HOME est défini sans FS_IMPORT_HOME */
export function installHome() {
  if (process.env.FS_IMPORT_HOME !== undefined) return process.env.FS_IMPORT_HOME || null;
  return process.env.FS_CLI_HOME ? null : os.homedir();
}

const exists = p => { try { fs.statSync(p); return true; } catch { return false; } };

/** fichiers de configuration MCP des agents trouvés sur le PC */
export function mcpTargets(home) {
  const g = path.join(home, '.gemini');
  const t = [];
  const agyApp = path.join(g, 'config', 'mcp_config.json');           // application Antigravity (agent) récente
  if (exists(agyApp) || exists(path.join(g, 'config')) || exists(path.join(g, 'antigravity'))) t.push({ label: 'Antigravity', file: agyApp, kind: 'json' });
  const agyIde = path.join(g, 'antigravity-ide', 'mcp_config.json');  // Antigravity (éditeur)
  if (exists(agyIde) || exists(path.dirname(agyIde))) t.push({ label: 'Antigravity IDE', file: agyIde, kind: 'json' });
  const agyOld = path.join(g, 'antigravity', 'mcp_config.json');      // ancien emplacement, seulement s'il existe déjà
  if (exists(agyOld)) t.push({ label: 'Antigravity (ancien emplacement)', file: agyOld, kind: 'json' });
  const claude = path.join(home, '.claude.json');
  if (exists(claude)) t.push({ label: 'Claude Code', file: claude, kind: 'json', extra: { type: 'stdio' } });
  const codex = path.join(home, '.codex', 'config.toml');
  if (exists(codex) || exists(path.dirname(codex))) t.push({ label: 'Codex', file: codex, kind: 'toml' });
  return t;
}

function backup(file) {
  let bak = `${file}.bak`;
  if (exists(bak)) bak = `${file}.bak-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}`;   // ne jamais écraser une ancienne sauvegarde
  fs.copyFileSync(file, bak);
  return bak;
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode; try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : {});
  fs.renameSync(tmp, file);
}
function indentOf(text) {
  if (/\n\t/.test(text)) return '\t';
  const m = text.match(/\n( +)\S/);
  return m ? m[1].length : 2;
}

function installJson(t, entry) {
  let text = null, j = {};
  if (exists(t.file)) {
    text = fs.readFileSync(t.file, 'utf8');
    const clean = text.replace(/^﻿/, '');
    if (clean.trim()) {
      try { j = JSON.parse(clean); } catch { return { status: 'erreur', error: 'fichier JSON illisible : laissé tel quel' }; }
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { status: 'erreur', error: 'contenu inattendu (pas un objet JSON) : laissé tel quel' };
  }
  if (j.mcpServers !== undefined && (typeof j.mcpServers !== 'object' || j.mcpServers === null || Array.isArray(j.mcpServers))) return { status: 'erreur', error: '« mcpServers » n\'est pas un objet : laissé tel quel' };
  const want = { ...(t.extra || {}), ...entry };
  const had = j.mcpServers?.[SERVER_NAME];
  if (had && JSON.stringify(had) === JSON.stringify(want)) return { status: 'déjà à jour' };
  j.mcpServers = { ...(j.mcpServers || {}), [SERVER_NAME]: want };
  const bak = text !== null ? backup(t.file) : null;
  const out = JSON.stringify(j, null, text ? indentOf(text) : 2) + (text === null || /\n\s*$/.test(text) ? '\n' : '');
  atomicWrite(t.file, out);
  return { status: had ? 'mis à jour' : 'ajouté', bak };
}

function installToml(t, entry) {
  const text = exists(t.file) ? fs.readFileSync(t.file, 'utf8') : null;
  const re = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${SERVER_NAME}"|'${SERVER_NAME}'|${SERVER_NAME})\\s*\\]`, 'm');
  if (text !== null && re.test(text)) return { status: 'déjà présent (non modifié)' };
  const q = s => JSON.stringify(String(s));                           // chaîne TOML « basique » (mêmes échappements que JSON)
  const section = `[mcp_servers.${SERVER_NAME}]\ncommand = ${q(entry.command)}\nargs = [${entry.args.map(q).join(', ')}]\n`;
  const bak = text !== null ? backup(t.file) : null;
  const base = text === null ? '' : text.replace(/\s*$/, '');
  atomicWrite(t.file, (base ? base + '\n\n' : '') + section);
  return { status: 'ajouté', bak };
}

/** Ajoute (ou met à jour) l'entrée « france-student » sans toucher aux autres serveurs. Renvoie un résultat par agent trouvé. */
export function installMcp({ home = installHome(), cliPath = path.join(ROOT, 'cli.js'), command = process.execPath } = {}) {   // chemin complet : une appli graphique (Antigravity, Mac) n'a pas toujours « node » dans son PATH
  if (!home) return [];
  const entry = { command, args: [path.resolve(cliPath), '--mcp'] };
  return mcpTargets(home).map(t => {
    try { return { label: t.label, file: t.file, ...(t.kind === 'toml' ? installToml(t, entry) : installJson(t, entry)) }; }
    catch (e) { return { label: t.label, file: t.file, status: 'erreur', error: e.message }; }
  });
}

/** fs-cli --install-mcp : affichage du bilan. Renvoie le code de sortie. */
export function installMcpCli(log = s => console.log(s)) {
  const home = installHome();
  if (!home) { log('  Aucun dossier personnel à modifier (FS_CLI_HOME est défini : définis FS_IMPORT_HOME pour choisir le dossier).'); return 1; }
  const res = installMcp({ home });
  if (!res.length) {
    log('  Aucun agent compatible trouvé (Antigravity, Claude Code, Codex).');
    log(`  Ajoute toi-même ce serveur MCP dans ton agent : commande « node », arguments [« ${path.join(ROOT, 'cli.js')} », « --mcp »].`);
    return 1;
  }
  let ok = 0;
  for (const r of res) {
    const good = r.status !== 'erreur';
    if (good) ok++;
    log(`  ${good ? '✓' : '✗'} ${r.label} : ${r.status}${r.error ? ` — ${r.error}` : ''}  (${r.file})${r.bak ? `\n      sauvegarde : ${r.bak}` : ''}`);
  }
  if (ok) {
    log(`\n  Serveur MCP « ${SERVER_NAME} » : outils fs_models, fs_ask, fs_agent.`);
    log('  → Redémarre l\'application de l\'agent (Antigravity, Claude Code, Codex) pour qu\'elle le voie.');
    log('  → fs_agent ne travaille que dans les dossiers déjà approuvés : ouvre-les une fois avec « fs-cli ».');
    if (!TOKEN) log('  ⚠ Aucune clé de session France Student : lance « fs-cli » une fois pour te connecter.');
  }
  return ok ? 0 : 1;
}
