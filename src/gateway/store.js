// Passerelle Claude Code : état persistant des conversations, verrous et sémaphore des flux France Student (§ 3.3).
//
// Disque (dir = HOME_DIR/gateway en production) :
//   conv/<convId>.json   une conversation (Conv), écrite de façon atomique (.tmp + rename) en mode 0o600
//   conv/old/            conversations anciennes DÉPLACÉES par prune() (jamais supprimées), restaurées si on les retrouve
//   index.json           { sessions:{"<sid>|<agent>"→convId}, anchors:{fp→convId}, chats:{chatId→convId} },
//                        5 000 entrées au plus par table, réécrit par relecture puis fusion (plusieurs processus fs-cli)
// Aucune exception ne remonte d'une écriture disque : l'erreur part dans log() et la passerelle continue en mémoire.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { fpAssistant } from './transcript.js';
import { decodeId, rand62 } from './ids.js';

/** @typedef {import('./types.js').Conv} Conv */
/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').Classification} Classification */

const MAX_INDEX = 5000;          // entrées par table de l'index
const MAX_CONVS = 80;            // au-delà, prune() déplace les plus anciennes…
const OLD_DAYS = 7;              // … seulement si elles ont plus de 7 jours
const MAX_ANCHORS = 300;         // dernières réponses émises gardées pour le retour en arrière et la reprise
const MAX_REPLIES = 3;           // réponses en cache pour les réessais (replay)
const MAX_REPLIES_BYTES = 200_000;
const EXCERPT = 64;
const CONV_FILE = /^[0-9A-Za-z]{12}\.json$/;
const TABLES = ['sessions', 'anchors', 'chats'];

// nom d'outil Claude Code → outil France Student (reprise sans état : on ne connaît que le tool_use émis)
const FS_NAME = { Read: 'read_file', Edit: 'edit_file', Write: 'write_file', Grep: 'search_files', Bash: 'run_command', PowerShell: 'run_command', Glob: 'list_directory' };

// ── Écriture atomique ─────────────────────────────────────────────────────────────────────────────────────────────────

/** écrit text dans file : fichier temporaire puis renommage ; repli Windows (fichier ouvert ailleurs) = écriture directe */
export function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, text, { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} }   // antivirus, indexeur…
}

/** lit un JSON ; null si absent ou illisible */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** sérialisation d'une Conv : on ne garde que les données (pas d'AbortController, de Reply, de minuteur…) ni les clés « _… » */
function serialize(conv) {
  return JSON.stringify(conv, (k, v) => {
    if (k.startsWith('_') || typeof v === 'function') return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return undefined;
    }
    return v;
  }, 1);
}

// ── Aides de mise à jour d'une Conv (convention : le plus récent en dernier) ─────────────────────────────────────────

/** ajoute la réponse émise (conv.lastFp, conv.lastText) aux ancres : [fp, n° de tour, extrait 64, userMessageId|null] */
export function pushAnchor(conv) {
  if (!conv.lastFp) return;
  conv.anchors = (conv.anchors || []).filter(([fp]) => fp !== conv.lastFp);
  conv.anchors.push([conv.lastFp, conv.turn || 0, String(conv.lastText || '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT), conv.pendingUserMessageId ?? null]);
  if (conv.anchors.length > MAX_ANCHORS) conv.anchors = conv.anchors.slice(-MAX_ANCHORS);
}

/**
 * met en cache la réponse d'une requête (replay des réessais) : 3 au plus, 200 ko au plus (la plus récente est toujours gardée).
 * fp = empreinte de cette réponse (conv.lastFp juste après le tour) : seule la dernière émise est rejouable.
 */
export function pushReply(conv, key, snapshot) {
  conv.lastReplies = [...(conv.lastReplies || []).filter(r => r.key !== key), { key, snapshot, fp: conv.lastFp ?? null }];
  trimReplies(conv);
}

function trimReplies(conv) {
  let list = (conv.lastReplies || []).slice(-MAX_REPLIES);
  while (list.length > 1 && JSON.stringify(list).length > MAX_REPLIES_BYTES) list = list.slice(1);
  conv.lastReplies = list;
}

/** Conv neuve (forme du § 3.3) */
function newConv(id, cls, env, agent, now) {
  const sessionId = cls?.sessionId || null;
  return {
    id, key: `${sessionId}|${cls?.agentId || 'main'}`, sessions: sessionId ? [sessionId] : [],
    sid: randomInt(0x10000).toString(16).padStart(4, '0'),
    chatId: null, agentId: agent?.agentId ?? -2003, provider: agent?.provider ?? 'anthropic', native: agent?.native ?? true, bare: false,
    env: env ?? null, preambleSent: false, claudeMdHash: null,
    lastFp: null, lastText: '', anchors: [],
    fs: { state: 'idle', pending: [], lastEventId: null, inflightKey: null },
    readSet: { sessionId, paths: {} },
    notes: [], refusal: { stage: 0, toolsSeen: false }, subagents: 0,
    lastReplies: [],
    fsPromptTokens: 0, turn: 0, createdAt: now, updatedAt: now,
  };
}

// ── Magasin ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ouvre (ou crée) le magasin de conversations dans dir.
 * @param {string} dir dossier (HOME_DIR/gateway)
 * @param {{now?:()=>number, log?:(obj:object)=>void, flows?:number, maxConvs?:number, oldDays?:number}} [opts]
 *   flows = nombre de flux France Student simultanés (--fs-flux, 3 par défaut)
 * @returns {Store & {get(id:string):Conv|null, list():Conv[], setFlows(n:number):void, flowState():{active:number, waiting:number, max:number}, dir:string}}
 */
export function openStore(dir, { now = Date.now, log = () => {}, flows = 3, maxConvs = MAX_CONVS, oldDays = OLD_DAYS } = {}) {
  const convDir = path.join(dir, 'conv');
  const oldDir = path.join(convDir, 'old');
  const indexFile = path.join(dir, 'index.json');
  try { fs.mkdirSync(convDir, { recursive: true, mode: 0o700 }); } catch (e) { log({ store: 'mkdir', error: e.message }); }

  const cache = new Map();                  // convId → { conv, stamp } (stamp = taille:mtime du fichier vu en dernier)
  let index = loadIndex();
  let dirty = emptyIndex();                 // entrées posées depuis la dernière écriture de l'index
  const locks = new Map();                  // clé → fin de la file de promesses
  let maxFlows = Math.max(1, flows | 0 || 3), active = 0;
  const waiting = [];                       // résolveurs en attente d'un flux

  function emptyIndex() { return { sessions: {}, anchors: {}, chats: {} }; }
  function loadIndex() {
    const raw = readJson(indexFile);
    const out = emptyIndex();
    for (const t of TABLES) if (raw?.[t] && typeof raw[t] === 'object') Object.assign(out[t], raw[t]);
    return out;
  }
  /** relit l'index (un autre processus fs-cli a pu l'enrichir), nos entrées pas encore écrites restent prioritaires */
  function refreshIndex() {
    const disk = loadIndex();
    for (const t of TABLES) for (const [k, v] of Object.entries(dirty[t])) { delete disk[t][k]; disk[t][k] = v; }
    index = disk;
  }
  const fileOf = id => path.join(convDir, `${id}.json`);
  const stampOf = file => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };

  /** pose une entrée de l'index (en mémoire, écrite au prochain flushIndex) */
  function setIndex(table, k, convId) {
    if (!k || index[table][k] === convId && !(k in dirty[table])) return;
    dirty[table][k] = convId;
    delete index[table][k];
    index[table][k] = convId;
  }

  /** réécrit l'index : relecture du disque (autres processus), fusion de nos entrées (déplacées en fin), plafond */
  function flushIndex() {
    if (TABLES.every(t => !Object.keys(dirty[t]).length)) return;
    const disk = loadIndex();
    for (const t of TABLES) {
      for (const [k, v] of Object.entries(dirty[t])) { delete disk[t][k]; disk[t][k] = v; }
      const keys = Object.keys(disk[t]);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_INDEX))) delete disk[t][k];
    }
    try { atomicWrite(indexFile, JSON.stringify(disk)); index = disk; dirty = emptyIndex(); }
    catch (e) { log({ store: 'index', error: e.message }); }
  }

  /** remet en place une conversation déplacée dans conv/old (retrouvée par l'index, un marqueur ou une ancre) */
  function restoreOld(id) {
    const from = path.join(oldDir, `${id}.json`);
    if (!fs.existsSync(from) || fs.existsSync(fileOf(id))) return;
    try { fs.renameSync(from, fileOf(id)); log({ store: 'restore', conv: id }); }
    catch (e) { log({ store: 'restore', conv: id, error: e.message }); }
  }

  /** conversation par id : cache, relue si un autre processus l'a réécrite (sauf si elle est en cours d'usage ici) */
  function get(id) {
    if (typeof id !== 'string' || !/^[0-9A-Za-z]{12}$/.test(id)) return null;
    const file = fileOf(id);
    let stamp = stampOf(file);
    if (!stamp) { restoreOld(id); stamp = stampOf(file); }
    const hit = cache.get(id);
    if (hit && (hit.stamp === stamp || locks.has(hit.conv.key) || !stamp)) return hit.conv;
    const conv = stamp && readJson(file);
    if (!conv || typeof conv !== 'object' || conv.id !== id) {
      if (stamp) log({ store: 'illisible', conv: id });
      return hit?.conv || null;
    }
    cache.set(id, { conv, stamp });
    return conv;
  }

  /** toutes les conversations de conv/ (pas celles de conv/old) */
  function list() {
    let names = [];
    try { names = fs.readdirSync(convDir).filter(n => CONV_FILE.test(n)); } catch {}
    const ids = new Set([...names.map(n => n.slice(0, -5)), ...cache.keys()]);
    return [...ids].map(get).filter(Boolean);
  }

  /** ajoute un id de session à la conversation (reconnue par marqueur, ancre ou ids) */
  function attachSession(conv, cls) {
    const sid = cls?.sessionId;
    if (sid && !conv.sessions.includes(sid)) conv.sessions.push(sid);
  }

  /** lecture partielle de Claude Code possible quand la session change : on oublie ce qu'on croyait lu */
  function syncReadSet(conv, cls) {
    const sid = cls?.sessionId || null;
    if (!conv.readSet || conv.readSet.sessionId !== sid) conv.readSet = { sessionId: sid, paths: {} };
  }

  /** reprise sans état : conversation rattachée à un chat FS retrouvé par les ids tool_use (état « uncertain ») */
  function adopt(cls, turns, chatId) {
    const conv = newConv(rand62(12), cls, null, null, now());
    conv.chatId = chatId;
    conv.preambleSent = true;
    conv.fs.state = 'uncertain';
    const ia = turns.findLastIndex(t => t.role === 'assistant');
    const a = turns[ia];
    conv.lastFp = fpAssistant(a);
    conv.lastText = a.text || '';
    conv.fs.pending = a.toolUses.map(u => ({ id: decodeId(u.id), u }))
      .filter(({ id }) => id && (id.kind === 'f' || id.kind === 'r') && id.chatId === chatId)
      .map(({ id, u }) => ({ callId: id.callId, ccId: u.id, fsName: FS_NAME[u.name] || u.name, path: u.input?.file_path || u.input?.path || null, local: null, retried: id.kind === 'r' ? 1 : 0 }));
    conv.turn = turns.filter(t => t.role === 'assistant').length;
    pushAnchor(conv);
    log({ store: 'reprise', conv: conv.id, chat: String(chatId).slice(0, 8) });
    return conv;
  }

  /**
   * Retrouve la conversation d'une requête, dans l'ordre : session, marqueur [fs-gw:…] (après compaction),
   * ancre (empreinte du dernier assistant), ids tool_use décodés (du plus récent au plus ancien).
   * @param {Classification} cls
   * @param {(import('./types.js').UserTurn|import('./types.js').AssistantTurn)[]} turns
   * @returns {Conv|null}
   */
  function find(cls, turns = []) {
    const key = `${cls?.sessionId}|${cls?.agentId || 'main'}`;
    refreshIndex();
    let conv = cls?.sessionId ? get(index.sessions[key]) : null;
    if (!conv) {
      const marker = turns.find(t => t.role === 'user')?.marker;
      conv = marker ? get(marker) : null;
    }
    const ia = turns.findLastIndex(t => t.role === 'assistant');
    if (!conv && ia >= 0) conv = get(index.anchors[fpAssistant(turns[ia])]);
    if (!conv) {
      for (let i = ia; i >= 0 && !conv; i--) {
        if (turns[i].role !== 'assistant') continue;
        for (const u of [...turns[i].toolUses].reverse()) {
          const d = decodeId(u.id);
          if (!d || (d.kind !== 'f' && d.kind !== 'r')) continue;
          conv = get(index.chats[d.chatId]) || adopt(cls, turns, d.chatId);
          break;
        }
      }
    }
    if (!conv) return null;
    attachSession(conv, cls);
    syncReadSet(conv, cls);
    if (cls?.sessionId) setIndex('sessions', key, conv.id);
    save(conv);
    return conv;
  }

  /** nouvelle conversation pour cette requête (pas encore de chat FS) */
  function create(cls, env, agent) {
    let id;
    do id = rand62(12); while (fs.existsSync(fileOf(id)) || cache.has(id));
    const conv = newConv(id, cls, env, agent, now());
    if (cls?.sessionId) setIndex('sessions', conv.key, conv.id);
    save(conv);
    if (list().length > maxConvs) prune();
    return conv;
  }

  /** écrit la conversation (synchrone : I4, l'état est sur disque avant l'envoi des tool_use) et met l'index à jour */
  function save(conv) {
    if (!conv?.id) return;
    conv.updatedAt = now();
    if (conv.anchors?.length > MAX_ANCHORS) conv.anchors = conv.anchors.slice(-MAX_ANCHORS);
    trimReplies(conv);
    const file = fileOf(conv.id);
    try { atomicWrite(file, serialize(conv)); } catch (e) { log({ store: 'save', conv: conv.id, error: e.message }); }
    cache.set(conv.id, { conv, stamp: stampOf(file) });
    const agentPart = conv.key.slice(conv.key.lastIndexOf('|') + 1);
    for (const s of conv.sessions || []) setIndex('sessions', `${s}|${agentPart}`, conv.id);
    if (conv.chatId) setIndex('chats', conv.chatId, conv.id);
    for (const [fp] of (conv.anchors || []).slice(-8)) setIndex('anchors', fp, conv.id);   // les plus récentes suffisent
    flushIndex();
  }

  /** file de promesses par clé : fn ne démarre qu'après la fin (succès ou échec) de la précédente */
  function lock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(() => {}, () => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  /**
   * Sémaphore global des flux FS. onWait() est appelé une fois si la requête doit attendre (en-têtes, pings).
   * Renvoie release() (sans effet au 2e appel). opts.signal : abandon de l'attente (rejet AbortError).
   */
  function acquireFlow(onWait, { signal } = {}) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (waiting.length && active <= maxFlows) waiting.shift().grant();   // la place passe directement au suivant
      else active--;
    };
    if (signal?.aborted) return Promise.reject(abortError());
    if (active < maxFlows && !waiting.length) { active++; return Promise.resolve(release); }
    return new Promise((resolve, reject) => {
      const w = {
        grant: () => { signal?.removeEventListener('abort', w.abort); resolve(release); },
        abort: () => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); reject(abortError()); },
      };
      waiting.push(w);
      signal?.addEventListener('abort', w.abort, { once: true });
      try { onWait?.(); } catch (e) { log({ store: 'onWait', error: e.message }); }
    });
  }

  /** --fs-flux N : prend effet tout de suite (des places libérées réveillent les requêtes en attente) */
  function setFlows(n) {
    maxFlows = Math.max(1, n | 0 || 1);
    while (waiting.length && active < maxFlows) { active++; waiting.shift().grant(); }
  }

  /**
   * Conversation à emprunter quand la limite de 50 chats est atteinte : une conversation qui a un chat FS, ni supprimé
   * (conv.gone) ni verrouillé (conv.locked), sans génération en cours, sans appel en attente (Claude Code peut encore
   * les exécuter) ni verrou tenu. opts : exclude (id de l'emprunteur), sessions (celles de l'emprunteur : préférées),
   * minIdleMs (inactive depuis au moins ce délai, le terminal d'en face peut s'en servir), oldest (la plus ancienne
   * d'abord ; sinon la plus récente).
   */
  function recentGatewayChat({ exclude = null, sessions = [], minIdleMs = 0, oldest = false } = {}) {
    const t = now();
    const own = c => (c.sessions || []).some(s => sessions.includes(s)) ? 0 : 1;
    return list()
      .filter(c => c.id !== exclude && c.chatId && !c.gone && !c.locked && !['inflight', 'pending'].includes(c.fs?.state)
        && !locks.has(c.key) && t - (c.updatedAt || 0) >= minIdleMs)
      .sort((a, b) => own(a) - own(b) || (oldest ? 1 : -1) * ((a.updatedAt || 0) - (b.updatedAt || 0)))[0] || null;
  }

  /** au-delà de maxConvs conversations, DÉPLACE les plus anciennes (plus de oldDays jours) dans conv/old ; ne supprime rien */
  function prune() {
    const convs = list().filter(c => !locks.has(c.key)).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    let count = list().length;
    const limit = now() - oldDays * 86_400_000;
    for (const c of convs) {
      if (count <= maxConvs || (c.updatedAt || 0) >= limit) break;
      try {
        fs.mkdirSync(oldDir, { recursive: true, mode: 0o700 });
        let to = path.join(oldDir, `${c.id}.json`);
        if (fs.existsSync(to)) to = path.join(oldDir, `${c.id}.${now()}.json`);   // jamais d'écrasement
        fs.renameSync(fileOf(c.id), to);
        cache.delete(c.id);
        count--;
      } catch (e) { log({ store: 'prune', conv: c.id, error: e.message }); }
    }
  }

  function flowState() { return { active, waiting: waiting.length, max: maxFlows }; }

  return { find, create, save, lock, acquireFlow, recentGatewayChat, prune, get, list, setFlows, flowState, dir };
}

function abortError() {
  const e = new Error('Attente d\'un flux France Student abandonnée.');
  e.name = 'AbortError';
  return e;
}
