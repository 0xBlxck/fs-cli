// Passerelle Claude Code : nom de modèle envoyé par Claude Code → agent (modèle) France Student (spécification § 3.10).
// Source : GET /chats/agents (deps.fetchAgentsFull), en cache 10 min en mémoire et 24 h sur disque (démarrage hors ligne),
// puis la table de secours de FS-CLI si rien d'autre n'est disponible.
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from '../config.js';
import { FALLBACK_AGENTS, FAMILY_AGENT } from '../agents-table.js';

const MEMORY_TTL = 10 * 60 * 1000;
const DISK_TTL = 24 * 60 * 60 * 1000;
const FAILED_TTL = 60 * 1000;                     // échec de GET /chats/agents : nouvel essai au plus tard dans 1 min

/** Agent de chaque famille de modèles (repli quand le nom exact est inconnu, ex. « claude-opus-4-1 » → Opus de FS). */
const FAMILIES = [[/opus/, FAMILY_AGENT.opus], [/sonnet/, FAMILY_AGENT.sonnet], [/haiku/, FAMILY_AGENT.haiku],
  [/fable/, FAMILY_AGENT.fable], [/^gpt/, FAMILY_AGENT.gpt]];

/** « Claude Sonnet 5.5 » → « claude-sonnet-5-5 » (accents retirés, tout ce qui n'est ni lettre ni chiffre devient « - »). */
export function slug(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Nom de modèle reçu → forme comparable : minuscules, sans « [1m] », sans date finale, sans préfixe claude-fs/, anthropic/, us.anthropic. */
export function normalizeModel(name) {
  let n = String(name ?? '').trim().toLowerCase().replace(/\[1m\]/g, '').trim();
  for (let prev = null; prev !== n;) {
    prev = n;
    n = n.replace(/^(?:claude-fs\/|anthropic\/|us\.anthropic\.)/, '');
  }
  return n.replace(/-\d{8}$/, '');
}

/** Fournisseur d'un agent : modelProvider de FS, sinon déduit du nom du modèle. */
function providerOf(a) {
  if (a.modelProvider) return String(a.modelProvider).toLowerCase();
  const m = String(a.model || a.name || '').toLowerCase();
  if (/^claude|anthropic/.test(m)) return 'anthropic';
  if (/^gpt|^o\d|openai/.test(m)) return 'openai';
  if (/gemini|google/.test(m)) return 'google';
  return 'unknown';
}

/** Liste brute de GET /chats/agents (tableau, { data } ou { agents }) → ModelDto valides et actifs. */
function cleanList(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.agents) ? raw.agents : null;
  if (!list) return null;
  const ok = list.filter(a => a && Number.isFinite(Number(a.id)) && (a.model || a.name) && a.isActive !== false);
  return ok.length ? ok : null;
}

/** Table { id: nom } de FS-CLI → ModelDto approximatifs (modèle = slug du nom, comme « gpt-6-astra »). */
function fromTable(table) {
  return Object.entries(table).map(([id, name]) => {
    const model = slug(name);
    const modelProvider = /^claude/.test(model) ? 'anthropic' : /^gpt/.test(model) ? 'openai' : 'unknown';
    return { id: Number(id), name, namespace: modelProvider, model, modelProvider, isActive: true, contextWindow: 200000 };
  });
}

function readDisk(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const agents = cleanList(j?.agents);
    return agents && Number.isFinite(j.at) ? { at: j.at, agents } : null;
  } catch { return null; }
}

/** écriture atomique (fichier temporaire puis renommage ; repli Windows si le fichier est ouvert ailleurs), jamais d'exception */
function writeDisk(file, obj) {
  const text = JSON.stringify(obj), tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.renameSync(tmp, file); }
    catch { fs.writeFileSync(file, text, { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} }
  } catch {}
}

/** Id de modèle annoncé à Claude Code (GET /v1/models, ANTHROPIC_MODEL) : tel quel pour Claude, sinon « claude-fs/<namespace>/<modèle> ». */
export function ccModelId(a) {
  const model = a.model || '';
  if (/^(claude|anthropic)/i.test(model)) return model;
  const ns = a.namespace ?? (a.provider && a.provider !== 'unknown' ? a.provider : '');
  return 'claude-fs/' + (ns ? ns + '/' : '') + model;
}

/**
 * Catalogue des modèles pour la passerelle.
 * deps : { fetchAgentsFull, now? } ; options : { file (cache disque, défaut HOME_DIR/gateway/agents.json), table (secours { id: nom }) }.
 * nativeOff : agents qui ont répondu NATIVE_UNSUPPORTED → fin de la période « texte seul » (ms). Rien n'est écrit sur
 * disque : un 403 passager (pare-feu, jeton refusé) ne coupe pas les outils pour toujours, on réessaie après NATIVE_RETRY_MS.
 */
export const NATIVE_RETRY_MS = 10 * 60_000;

export function createModels(deps = {}, { file = path.join(HOME_DIR, 'gateway', 'agents.json'), table = null } = {}) {
  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
  const nativeOff = new Map();
  const isOff = id => (nativeOff.get(id) || 0) > now();
  let mem = null;                                   // { at, ttl, raw }
  let loading = null;

  async function fetchFresh() {
    let raw = null;
    try { raw = cleanList(await deps.fetchAgentsFull?.()); } catch { raw = null; }
    if (raw) { writeDisk(file, { at: now(), agents: raw }); return { raw, ttl: MEMORY_TTL }; }
    const disk = readDisk(file);
    if (disk && now() - disk.at <= DISK_TTL) return { raw: disk.agents, ttl: FAILED_TTL };
    return { raw: fromTable(table || FALLBACK_AGENTS), ttl: FAILED_TTL };
  }

  async function rawAgents() {
    if (mem && now() - mem.at < mem.ttl) return mem.raw;
    loading ||= fetchFresh().then(r => { mem = { at: now(), ...r }; return r.raw; }).finally(() => { loading = null; });
    return loading;
  }

  const toAgent = a => {
    const provider = providerOf(a);
    const agentId = Number(a.id);
    return {
      agentId, model: String(a.model || slug(a.name)), name: String(a.name || a.model), provider,
      native: provider !== 'google' && !isOff(agentId),
      contextWindow: Number(a.contextWindow) > 0 ? Number(a.contextWindow) : 200000,
    };
  };

  async function fromAgentId(id) {
    const n = Number(id);
    const a = (await rawAgents()).find(x => Number(x.id) === n);
    return a ? toAgent(a) : null;
  }

  async function resolve(name) {
    const n = normalizeModel(name);
    if (!n) return null;
    const list = await rawAgents();
    const hit = list.find(a => normalizeModel(a.model) === n)
      || list.find(a => a.namespace && `${a.namespace}/${normalizeModel(a.model)}`.toLowerCase() === n)
      || list.find(a => slug(a.name) === n);
    if (hit) return toAgent(hit);
    const base = n.split('/').pop();                // « openai/gpt-7 » inconnu → famille GPT
    const fam = FAMILIES.find(([re]) => re.test(base));
    return fam ? fromAgentId(fam[1]) : null;
  }

  return {
    nativeOff,
    /** l'agent ne prend pas les outils client (403 NATIVE_UNSUPPORTED) : texte seul pendant ms, puis nouvel essai */
    markNativeOff(id, ms = NATIVE_RETRY_MS) { nativeOff.set(Number(id), now() + ms); },
    resolve,
    fromAgentId,
    /** requête principale : modèle introuvable → agent par défaut (cfg.agentId), unknown = true pour le journal */
    async resolveMain(name, defaultId) {
      const a = await resolve(name);
      if (a) return { agent: a, unknown: false };
      return { agent: (await fromAgentId(defaultId)) || (await fromAgentId(-2003)), unknown: true };
    },
    async list() { return (await rawAgents()).map(toAgent); },
    /** id annoncé à Claude Code pour un agent FS (ANTHROPIC_MODEL au lancement) ; null si l'agent est inconnu */
    async ccId(agentId) {
      const a = (await rawAgents()).find(x => Number(x.id) === Number(agentId));
      return a ? ccModelId(a) : null;
    },
    /** réponse de GET /v1/models pour Claude Code (son filtre /^(claude|anthropic)/i laisse passer claude-fs/…) */
    async forClaudeCode() {
      const data = (await rawAgents()).map(a => ({
        id: ccModelId(a), display_name: `${a.name || a.model} · France Student`, type: 'model', created_at: '2026-01-01T00:00:00Z',
      }));
      return { data, has_more: false };
    },
  };
}
