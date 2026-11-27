// Passerelle Claude Code : distingue la requête principale des requêtes d'arrière-plan (spécification § 3.1).
// L'ordre des tests compte : les « forks » de Claude Code (compaction, suggestion, résumés, /btw, extraction de mémoire)
// reprennent le system et les tools de la requête principale, avec le même id de session, et ne se distinguent que par
// leur dernier message user. Motifs vérifiés dans le bundle de Claude Code 2.1.207 (textes exacts des prompts internes).

/** Texte brut du champ system d'une requête Anthropic (chaîne ou tableau de blocs text). */
export function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map(b => typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

const REMINDER_RE = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;
const unremind = t => t.replace(REMINDER_RE, '').trimStart();

// Blocs texte (nettoyés des system-reminders) du dernier message de rôle user ; les messages role:'system' sont ignorés.
function lastUserBlocks(messages) {
  if (!Array.isArray(messages)) return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return [unremind(m.content)];
    if (!Array.isArray(m.content)) return [];
    return m.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => unremind(b.text)).filter(Boolean);
  }
  return [];
}

// Texte brut (rappels compris) du dernier message de rôle user : certains prompts internes tiennent dans un rappel.
function lastUserRaw(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    return Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  }
  return '';
}

/** Texte du dernier message user, sans system-reminders, début d'espaces retiré ('' s'il ne contient que des tool_result). */
export function lastUserText(messages) {
  return lastUserBlocks(messages).join('\n').trimStart();
}

function jsonTry(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// En-tête HTTP insensible à la casse (Node les met en minuscules, un appelant de test peut ne pas le faire).
function header(h, name) {
  if (!h) return null;
  const v = h[name] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(v) ? v[0] : (v || null);
}

// Prompts internes de Claude Code 2.1.207 (début exact du dernier message user).
const FORKS = [
  [/^\[SUGGESTION MODE:/, 'suggestion'],
  [/^CRITICAL: Respond with TEXT ONLY/, 'compact'],
  [/^The user stepped away and is coming back/, 'away_summary'],
  [/^Describe your most recent action in 3-5 words/, 'agent_summary'],
  [/^Generate a short kebab-case name/, 'name'],                       // /rename par fork (sans output_config)
  // forks d'arrière-plan avec outils (même session, même system) : jamais envoyés à FS (I1), jamais la conversation principale
  [/^You are now acting as the memory extraction subagent/, 'background_other'],   // extract_memories
  [/^# Dream: Memory Consolidation/, 'background_other'],                           // auto_dream
];

// System des agents internes avec outils (hooks de type agent, recherche de sessions) : pas d'ancrage en début de texte,
// Claude Code peut placer d'autres blocs system (identité, en-tête de facturation) avant.
const INTERNAL_SYSTEMS = /You are verifying a stop condition in Claude Code|You are evaluating a [^\n.]{1,60} hook in Claude Code|You are searching for past Claude Code conversation sessions/;
// Crochets de type « prompt » de Claude Code (/goal en crée un sur Stop) : système exact de Claude Code 2.1.x.
const HOOK_CHECK = /You are evaluating a stop-condition hook in Claude Code|You are evaluating a hook condition in Claude Code/;
// Question annexe (/btw, querySource « side_question ») : tout le prompt interne est dans un system-reminder.
// Pas d'ancrage : le message peut être fusionné avec un message user précédent (tool_result, rappels).
const SIDE_QUESTION = /<system-reminder>\s*This is a side question from the user\./;

/**
 * Classe une requête POST /v1/messages de Claude Code.
 * @param {object} body corps JSON reçu
 * @param {object} headers en-têtes HTTP (minuscules)
 * @returns {import('./types.js').Classification}
 */
export function classify(body, headers) {
  const b = body || {};
  const blocks = lastUserBlocks(b.messages);
  const last = blocks.join('\n').trimStart();
  const tail = blocks.length ? blocks[blocks.length - 1] : '';             // dernier bloc seul : messages user fusionnés
  const starts = re => re.test(last) || re.test(tail);
  const sys = systemText(b.system);
  const props = b.output_config?.format?.schema?.properties || b.output_format?.schema?.properties || {};
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const base = {
    sessionId: header(headers, 'x-claude-code-session-id') || jsonTry(b.metadata?.user_id)?.session_id || null,
    agentId: header(headers, 'x-claude-code-agent-id') || null,
    model: String(b.model || ''),
    stream: b.stream === true,                                             // l'API Anthropic ne streame que sur stream:true
  };
  const k = kind => ({ kind, ...base });
  if (b.max_tokens != null && b.max_tokens <= 1) return k('probe');
  if (props.title) return k('title');
  if (props.name) return k('name');
  if (SIDE_QUESTION.test(lastUserRaw(b.messages))) return k('side_question');   // avant unremind : le rappel EST le marqueur
  for (const [re, kind] of FORKS) if (starts(re)) return k(kind);
  // vérificateur d'un crochet « prompt » (dont /goal : « Condition: … ») : il FAUT une vraie réponse {"ok": …}, sinon
  // /goal ne s'arrête jamais ou s'arrête au hasard (avant : réponse vide, /goal cassé dans fs claude)
  if (HOOK_CHECK.test(sys)) return k('hook_check');
  if (INTERNAL_SYSTEMS.test(sys)) return k('background_other');
  if (/tasked with summarizing conversations/i.test(sys)) return k('compact');
  // Requêtes « latérales » sans outils (Ij de Claude Code) : un texte d'utilisateur ne doit pas les imiter.
  if (!tools.length && /Tools completed:[\s\S]*Label:\s*$/.test(last)) return k('tool_summary');
  if (tools.some(t => /^web_search_\d+/.test(t?.type || ''))) return k('web_search');
  if (!tools.length && starts(/^Web page content:\n---/)) return k('web_fetch');
  if (!tools.length && /command_injection_detected/.test(sys + '\n' + last)) return k('bash_prefix');
  if (base.agentId || /cc_is_subagent=true/.test(sys)) return k('subagent');
  if (tools.length >= 3 && /Primary working directory:/.test(sys)) return k('main');
  if (!tools.length) return k('background_other');
  return k('main');
}
