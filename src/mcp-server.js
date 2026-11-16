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
import { streamChat, fetchAgents, requestJson, lastMessageImages, fetchApiFile, setProjectOverride, fetchChatsList, listFsProjects, uploadFile, fetchChat } from './api.js';
import { fetchUserUsage } from './account.js';
import { sensitivePathReason } from './permissions.js';
import { newSid, tag, lastReset, createdToday, DAILY_LIMIT } from './chats.js';
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
  'fs_models liste les modèles ; fs_ask pose une question à un modèle France Student (texte, recherche web en option) ; ' +
  'fs_agent confie une tâche de code à l\'agent FS-CLI dans un dossier que l\'utilisateur a approuvé ; fs_image génère une image ; ' +
  'fs_web répond avec la recherche web ; fs_files fait analyser des images, PDF ou fichiers texte ; fs_conversations liste, relit ou choisit une conversation du compte ; ' +
  'fs_usage montre ce qu\'il reste du quota. ' +
  'Si un outil répond « Rien n\'a été envoyé… », demande à l\'utilisateur où écrire avant de rappeler l\'outil. Le compte est limité à 50 nouvelles conversations par jour : les conversations sont réutilisées, n\'utilise new_conversation que si c\'est nécessaire.';

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
        conversation_id: { type: 'string', description: 'Où écrire : "mcp" (la conversation du MCP), "new" (nouvelle conversation) ou l\'identifiant d\'une conversation France Student. Seulement selon le choix de l\'utilisateur.' },
        save_dir: { type: 'string', description: 'Dossier (chemin absolu) où enregistrer les images générées. Facultatif : sans lui, les images sont seulement renvoyées dans la réponse.' },
        web_search: { type: 'boolean', description: 'true = le modèle peut chercher sur le web pour répondre. Par défaut false.', default: false },
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
        conversation_id: { type: 'string', description: 'Où écrire : "mcp", "new" ou l\'identifiant d\'une conversation France Student. Seulement selon le choix de l\'utilisateur.' },
      },
      required: ['task', 'folder'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'fs_image',
    title: 'Générer une image (France Student)',
    description: 'Génère une image avec un modèle GPT de France Student et la renvoie directement (contenu image). Décris précisément ce que tu veux (sujet, style, cadrage, couleurs, texte éventuel). ' +
      'save_dir (chemin absolu) pour l\'enregistrer aussi sur le disque. Utilise la conversation du MCP (pas de nouvelle conversation).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description de l\'image à générer.' },
        model: { type: 'string', description: 'Modèle GPT à utiliser (facultatif ; par défaut le meilleur modèle GPT du compte).' },
        save_dir: { type: 'string', description: 'Dossier (chemin absolu) où enregistrer l\'image. Facultatif.' },
        conversation_id: { type: 'string', description: 'Où écrire : "mcp", "new" ou l\'identifiant d\'une conversation (selon le choix de l\'utilisateur).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'fs_web',
    title: 'Recherche web (France Student)',
    description: 'Pose une question à un modèle France Student AVEC sa recherche web activée : actualité, documentation récente, prix, versions de bibliothèques… Renvoie une réponse rédigée, avec ses sources quand le modèle les donne.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'La question, précise (ce qu\'il faut chercher et ce qu\'il faut en retenir).' },
        model: { type: 'string', description: 'Modèle (facultatif, voir fs_models).' },
        conversation_id: { type: 'string', description: 'Où écrire : "mcp", "new" ou l\'identifiant d\'une conversation (selon le choix de l\'utilisateur).' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'fs_files',
    title: 'Analyser des fichiers (France Student)',
    description: 'Envoie 1 à 5 fichiers du PC à un modèle France Student avec une consigne : images (capture d\'écran, maquette, photo, schéma), PDF, ou fichiers texte (code, Markdown, CSV, JSON, logs). ' +
      'Chemins ABSOLUS. Les fichiers sensibles (clés, mots de passe, .env, dossiers système) sont refusés.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, description: 'Chemins absolus des fichiers.' },
        prompt: { type: 'string', description: 'Ce que le modèle doit faire avec ces fichiers.' },
        model: { type: 'string', description: 'Modèle (facultatif, voir fs_models).' },
        conversation_id: { type: 'string', description: 'Où écrire : "mcp", "new" ou l\'identifiant d\'une conversation (selon le choix de l\'utilisateur).' },
      },
      required: ['paths', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'fs_conversations',
    title: 'Conversations France Student',
    description: 'Les conversations du compte France Student (y compris celles faites sur le site et rangées dans des projets). ' +
      'action « list » : les plus récentes (titre, identifiant, projet, date) ; « read » : relit les messages d\'une conversation (conversation_id) ; ' +
      '« select » : en fait la conversation utilisée par fs_ask / fs_agent / fs_image (seulement si l\'utilisateur le demande).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'select'], default: 'list' },
        conversation_id: { type: 'string', description: 'Pour read et select.' },
        limit: { type: 'integer', minimum: 1, maximum: 60, description: 'list : nombre de conversations (20 par défaut) ; read : nombre de derniers messages (20 par défaut).' },
        search: { type: 'string', description: 'list : ne garder que les titres qui contiennent ce texte.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'fs_usage',
    title: 'Consommation France Student',
    description: 'Ce qu\'il reste sur le compte France Student : budget de chat du jour (pourcentage, heure de remise à zéro), nouvelles conversations créées aujourd\'hui sur 50, autres limites. À consulter avant une grosse tâche.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
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
    projectChats: async id => { const j = (await requestJson('GET', `/projects/${encodeURIComponent(id)}/chats`)).data; return Array.isArray(j) ? j : (j?.chats || []); },
    fetchChat,
    upload: uploadFile,
    userUsage: fetchUserUsage,
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
  /** IDE sans fenêtre de choix (Antigravity…) : rien n'est envoyé, l'agent doit d'abord demander à l'utilisateur où écrire */
  let pendingChoice = false;
  async function choiceText() {
    const [chats, projects] = await Promise.all([d.listChats(15).catch(() => []), d.listProjects().catch(() => [])]);
    const rows = [], seen = new Set();
    const add = (arr, proj) => { for (const x of Array.isArray(arr) ? arr : []) if (x?.id && !seen.has(x.id)) { seen.add(x.id); rows.push({ id: x.id, title: cleanTitle(x.title), proj, at: Date.parse(x.lastMessageAt || x.createdAt) || 0 }); } };
    add(chats);
    const some = (Array.isArray(projects) ? projects : []).filter(x => x?.id).slice(0, 5);
    (await Promise.all(some.map(x => d.projectChats(x.id).catch(() => [])))).forEach((arr, i) => add(arr, some[i].name));
    const list = rows.sort((a, b) => b.at - a.at).slice(0, 12).map(x => `  - ${x.title} · id ${x.id}${x.proj ? ` · projet « ${cleanTitle(x.proj)} »` : ''}`).join('\n');
    return 'Rien n\'a été envoyé à France Student. L\'utilisateur veut choisir la conversation où écrire : DEMANDE-LUI d\'abord, puis rappelle cet outil avec conversation_id :\n' +
      (askState.chatId ? `- "mcp" : la conversation du MCP${cfg.mcpChat?.title ? ` (« ${cleanTitle(cfg.mcpChat.title)} »)` : ''}\n` : '') +
      '- "new" : une nouvelle conversation (compte dans les 50 nouvelles conversations par jour)\n' +
      (list ? `- ou l'identifiant d'une de ses conversations :\n${list}\n` : '') +
      'Ensuite, ne redemande plus pendant cette session : les appels suivants utilisent la conversation choisie.';
  }
  /** choix de l'utilisateur transmis par l'agent : conversation_id = "mcp" | "new" | identifiant */
  function applyChoice(args) {
    const v = typeof args.conversation_id === 'string' ? args.conversation_id.trim() : '';
    if (/^(new|nouvelle?)$/i.test(v)) { delete args.conversation_id; args.new_conversation = true; }
    else if (/^(mcp|courante|current|session)$/i.test(v)) delete args.conversation_id;
    else if (/^[\w-]{8,64}$/.test(v)) { if (pendingChoice) { askState.chatId = v; remember(v); folders.clear(); delete args.conversation_id; } }
    else if (args.new_conversation !== true) return;                   // aucun choix exprimé
    askedWhere = true; pendingChoice = false;
  }

  async function chooseWhere(signal) {
    if (askedWhere || cfg.mcpAskWhere === false) return null;
    if (!clientCanAsk) { pendingChoice = true; return { ask: await choiceText() }; }
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

  async function toolAsk(args, signal, extra = {}) {
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (!prompt.trim()) return textResult('Paramètre « prompt » manquant ou vide.', true);
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const m = extra.modelId != null ? { id: extra.modelId } : await pickModel(args.model);
    if (m.error) return textResult(m.error, true);
    applyChoice(args);
    const target = chatFor(args);                                      // conversation précise demandée par l'utilisateur
    const cw = !target && args.new_conversation !== true ? await chooseWhere(signal) : null;
    if (cw?.cancel) return CANCELLED();
    if (cw?.ask) return textResult(cw.ask);
    if (args.new_conversation === true) { askState.chatId = null; askState.sid = newSid(); }
    const send = async chatId => {
      let content = prompt;
      if (!chatId && cfg.tagChats !== false) content = tag(askState.sid, 'mcp') + content;
      return d.stream({
        agentId: m.id, chatId, content, signal, webSearch: !!(extra.web || args.web_search === true), register: { sid: askState.sid, role: 'mcp' },
        ...(extra.files?.length ? { files: extra.files } : {}),
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
    applyChoice(args);
    const cw = !folders.has(key) && !chatFor(args) && args.new_conversation !== true ? await chooseWhere(signal) : null;
    if (cw?.cancel) return CANCELLED();
    if (cw?.ask) return textResult(cw.ask);
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

  // ── outils en plus : image, web, fichiers, conversations, consommation ──
  const str = v => (typeof v === 'string' ? v.trim() : '');
  let agentsFull = null;
  async function fullAgents() {
    if (!agentsFull) {
      const j = await d.fetchAgentsFull().catch(() => null);
      const arr = Array.isArray(j) ? j : (j?.data || j?.agents);
      agentsFull = Array.isArray(arr) ? arr.filter(a => a && a.isActive !== false) : [];
      if (agentsFull.length) agents = Object.fromEntries(agentsFull.map(a => [String(a.id), a.name]));
    }
    return agentsFull;
  }
  /** modèle qui sait générer des images (GPT) : celui demandé s'il est GPT, sinon le meilleur GPT du compte */
  async function imageModel(arg) {
    const list = await fullAgents();
    const gpt = list.filter(a => /openai/i.test(String(a.modelProvider || '')) || /\bgpt\b/i.test(String(a.name || '')));
    if (str(arg)) {
      const m = await pickModel(arg);
      if (m.error || !gpt.length || gpt.some(a => String(a.id) === String(m.id))) return m;
      return { error: `${nameOf(m.id)} ne génère pas d'images. Modèles qui le font : ${gpt.map(a => a.name).join(', ')}.` };
    }
    const best = gpt.find(a => /sol/i.test(a.name)) || gpt.find(a => /luna/i.test(a.name)) || gpt[0];
    return { id: best ? Number(best.id) : -1003 };
  }

  async function toolImage(args, signal) {
    const prompt = str(args.prompt);
    if (!prompt) return textResult('Paramètre « prompt » manquant : décris l\'image à générer.', true);
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const m = await imageModel(args.model);
    if (m.error) return textResult(m.error, true);
    const r = await toolAsk({ prompt: `Génère une image : ${prompt}`, save_dir: args.save_dir, conversation_id: args.conversation_id }, signal, { modelId: m.id });
    if (r.isError || r.content.some(x => x.type === 'image')) return r;
    const said = r.content.find(x => x.type === 'text')?.text || '';
    return textResult(`${nameOf(m.id)} n'a pas généré d'image.${said ? ` Sa réponse : ${said.slice(0, 1500)}` : ''}`, true);
  }

  async function toolWeb(args, signal) {
    const q = str(args.question);
    if (!q) return textResult('Paramètre « question » manquant.', true);
    return toolAsk({ prompt: q, model: args.model, conversation_id: args.conversation_id }, signal, { web: true });
  }

  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|php|java|kt|go|rs|c|h|cpp|hpp|cs|swift|sql|sh|ps1|bat|lua|luau|log|r|dart|vue|svelte)$/i;
  const UPLOAD_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', pdf: 'application/pdf' };
  async function toolFiles(args, signal) {
    const prompt = str(args.prompt);
    const paths = (Array.isArray(args.paths) ? args.paths : typeof args.paths === 'string' ? [args.paths] : []).map(str).filter(Boolean);
    if (!prompt) return textResult('Paramètre « prompt » manquant : dis ce qu\'il faut faire avec les fichiers.', true);
    if (!paths.length) return textResult('Paramètre « paths » manquant : donne 1 à 5 chemins absolus.', true);
    if (paths.length > 5) return textResult('5 fichiers au maximum par appel.', true);
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const ids = [], texts = [];
    let textBudget = 120_000;
    for (const p of paths) {
      if (!path.isAbsolute(p)) return textResult(`Chemin non absolu : ${p}`, true);
      const why = sensitivePathReason(p);
      if (why) return textResult(`Refusé : ${p} (${why}). Ce fichier n'est jamais envoyé.`, true);
      let st = null; try { st = fs.statSync(p); } catch {}
      if (!st?.isFile()) return textResult(`Fichier introuvable : ${p}`, true);
      const ext = path.extname(p).slice(1).toLowerCase();
      if (UPLOAD_EXT[ext]) {
        if (st.size > 20 * 1024 * 1024) return textResult(`${path.basename(p)} est trop gros (20 Mo au maximum).`, true);
        try { ids.push(await d.upload(fs.readFileSync(p), path.basename(p), UPLOAD_EXT[ext])); }
        catch (e) { return textResult(`Envoi de ${path.basename(p)} impossible : ${e?.message || e}`, true); }
      } else if (TEXT_EXT.test(p)) {
        const t = fs.readFileSync(p, 'utf8');
        const cut = t.length > textBudget ? t.slice(0, textBudget) + '\n[… fichier coupé]' : t;
        textBudget -= cut.length;
        texts.push(`--- ${path.basename(p)} ---\n${cut}`);
        if (textBudget <= 0) break;
      } else return textResult(`Type de fichier non pris en charge : ${path.basename(p)} (images, PDF ou fichiers texte).`, true);
    }
    const full = texts.length ? `${prompt}\n\n${texts.join('\n\n')}` : prompt;
    return toolAsk({ prompt: full, model: args.model, conversation_id: args.conversation_id }, signal, { files: ids });
  }

  const cleanUser = t => {
    let s = String(t || '').replace(/^\[[0-9a-f]{4}(?:·[^\]]*)?\]\s*/i, '');
    for (let k = 0; k < 4 && /^\[(?:L'utilisateur|Dossier courant|Info de FS-CLI|Résultats|Contenu de la page|Contexte VS Code|Préférences)[\s\S]*?\]\s*\n/.test(s); k++) s = s.replace(/^\[[\s\S]*?\]\s*\n/, '');
    const cut = s.search(/\n\n\[(?:Info de FS-CLI|Guide «|Format de réponse|Préférences|Instructions du projet|Outils MCP|Contexte)/);
    return (cut > 0 ? s.slice(0, cut) : s).trim();
  };
  async function toolConversations(args) {
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const action = str(args.action) || 'list';
    const id = str(args.conversation_id);
    const limit = Math.max(1, Math.min(60, Number(args.limit) || 20));
    if (action === 'list') {
      const [mine, projects] = await Promise.all([d.listChats(50).catch(() => []), d.listProjects().catch(() => [])]);
      const all = [], seen = new Set();
      const add = (arr, project) => { for (const x of Array.isArray(arr) ? arr : []) if (x?.id && !seen.has(x.id)) { seen.add(x.id); all.push({ id: x.id, title: cleanTitle(x.title), project: project || '', at: Date.parse(x.lastMessageAt || x.updatedAt || x.createdAt) || 0 }); } };
      add(mine);
      const some = (Array.isArray(projects) ? projects : []).filter(p => p?.id).slice(0, 10);
      (await Promise.all(some.map(p => d.projectChats(p.id).catch(() => [])))).forEach((arr, i) => add(arr, some[i].name));
      const q = str(args.search).toLowerCase();
      const list = all.filter(x => !q || x.title.toLowerCase().includes(q)).sort((a, b) => b.at - a.at).slice(0, limit);
      if (!list.length) return textResult(q ? `Aucune conversation dont le titre contient « ${args.search} ».` : 'Aucune conversation sur le compte.');
      const when = t => (t ? new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?');
      return textResult(`${list.length} conversation${list.length > 1 ? 's' : ''} :\n` + list.map(x =>
        `- ${x.title} · id ${x.id}${x.project ? ` · projet « ${x.project} »` : ''} · ${when(x.at)}${x.id === askState.chatId ? ' · conversation du MCP' : ''}`).join('\n'));
    }
    if (!/^[\w-]{8,64}$/.test(id)) return textResult('Paramètre « conversation_id » manquant ou invalide (voir action « list »).', true);
    const chat = await d.fetchChat(id).catch(() => null);
    if (!chat) return textResult(`Conversation introuvable : ${id}`, true);
    if (action === 'select') {
      askState.chatId = id; remember(id, chat.title || ''); folders.clear(); askedWhere = true; pendingChoice = false;
      return textResult(`Conversation du MCP : « ${cleanTitle(chat.title)} ». fs_ask, fs_agent, fs_image, fs_web et fs_files l'utilisent désormais.`);
    }
    if (action !== 'read') return textResult(`Action inconnue : ${action} (list, read ou select).`, true);
    const msgs = (chat.chatMessages || []).filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, text: m.role === 'user' ? cleanUser(m.content) : String(m.content || '').trim() })).filter(m => m.text);
    const last = msgs.slice(-limit);
    const body = last.map(m => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.text.length > 4000 ? m.text.slice(0, 4000) + ' […]' : m.text}`).join('\n\n');
    return textResult(`« ${cleanTitle(chat.title)} » · ${msgs.length} message${msgs.length > 1 ? 's' : ''}${msgs.length > last.length ? ` (les ${last.length} derniers)` : ''}\n\n${body || '(aucun message)'}`);
  }

  async function toolUsage() {
    if (!d.hasToken()) return textResult(NO_TOKEN, true);
    const since = lastReset();
    const [u, mine, projects] = await Promise.all([d.userUsage().catch(() => null), d.listChats(50).catch(() => []), d.listProjects().catch(() => [])]);
    const ids = new Set();
    const addAll = arr => { for (const x of Array.isArray(arr) ? arr : []) if (x?.id && Date.parse(x.createdAt) >= since) ids.add(x.id); };
    addAll(mine);
    const some = (Array.isArray(projects) ? projects : []).filter(p => p?.id).slice(0, 10);
    (await Promise.all(some.map(p => d.projectChats(p.id).catch(() => [])))).forEach(addAll);
    const made = Math.max(ids.size, createdToday());
    const hour = iso => { const t = new Date(iso); return isNaN(t) ? '?' : t.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }); };
    const lines = [];
    if (u?.chatBudget) lines.push(`Budget de chat : ${Math.round(u.chatBudget.remainingPercent)} % restant (remise à zéro ${hour(u.chatBudget.resetAt)})`);
    else lines.push('Budget de chat : indisponible');
    lines.push(`Nouvelles conversations aujourd'hui : ${made} / ${DAILY_LIMIT} (remise à zéro ${hour(new Date(since + 86400000).toISOString())})`);
    const NAMES = { TRANSCRIPT_UPLOAD: 'Transcriptions (jour)', USER_INVITES: 'Invitations (mois)' };
    for (const rl of u?.rateLimits || []) lines.push(`${NAMES[rl.type] || String(rl.type || '?').toLowerCase().replace(/_/g, ' ')} : ${rl.used} / ${rl.limit} (remise à zéro ${hour(rl.resetAt)})`);
    if (u?.rateLimitPowerUpActive) lines.push('Power-up actif : limites doublées');
    return textResult(lines.join('\n'));
  }

  async function callTool(params, signal) {
    const name = params?.name, args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (name === 'fs_models') return toolModels();
    if (name === 'fs_ask') return serial(() => toolAsk(args, signal));
    if (name === 'fs_agent') { const progress = progressFor(params); return serial(() => toolAgent(args, signal, progress)); }
    if (name === 'fs_image') return serial(() => toolImage(args, signal));
    if (name === 'fs_web') return serial(() => toolWeb(args, signal));
    if (name === 'fs_files') return serial(() => toolFiles(args, signal));
    if (name === 'fs_conversations') return toolConversations(args);
    if (name === 'fs_usage') return toolUsage();
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
