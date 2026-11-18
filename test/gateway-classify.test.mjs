// Tests de src/gateway/classify.js : requête principale ou arrière-plan (spécification § 3.1, § 5.1).
// Les forks sont fabriqués à partir des captures réelles de Claude Code 2.1.207, avec les textes exacts de ses prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture } from './gateway-helpers.mjs';           // pose FS_CLI_HOME sur un dossier temporaire

const { classify, lastUserText, systemText } = await import('../src/gateway/classify.js');
const { KINDS } = await import('../src/gateway/types.js');

// Prompts internes de Claude Code 2.1.207 (copiés du bundle).
const PROMPTS = {
  compact: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.\n- You already have all the context you need in the conversation above.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests and your previous actions.',
  suggestion: '[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nFIRST: Look at the user\'s recent messages and original request.',
  away: 'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.',
  agent: 'Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.',
  rename: 'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures". Return JSON with a "name" field.',
  tools: 'User\'s intent (from assistant\'s last message): Je lis le fichier.\n\nTools completed:\n\nTool: Read\nInput: {"file_path":"C:\\\\proj\\\\hello.txt"}\nOutput: 1\tcontenu de test\n\nLabel:',
  webFetch: '\nWeb page content:\n---\n# Titre\n\nCorps de la page.\n---\n\nRésume la page.',
  bashPrefix: '<policy_spec>\n# Claude Code Code Bash command prefix detection\n- git status`ls` => command_injection_detected\n</policy_spec>\n\nCommand: git status',
};

/** Fork de la conversation principale (system et tools de req-03/04) avec un dernier message user donné. */
function fork(text, fixture = 'req-04') {
  const f = loadFixture(fixture);
  f.body.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Le fichier contient « contenu de test ».' }] });
  f.body.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  return f;
}

/** Requête « latérale » sans outils (même forme que req-02, sans output_config). */
function side(text, system = 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.') {
  const f = loadFixture('req-02');
  delete f.body.output_config;
  f.body.system = [{ type: 'text', text: system }];
  f.body.tools = [];
  f.body.messages = [{ role: 'user', content: text }];
  return f;
}

const kind = f => classify(f.body, f.headers).kind;

test('captures réelles : req-02 → title, req-03 et req-04 → main (et la variante Linux)', () => {
  assert.equal(kind(loadFixture('req-02')), 'title');
  assert.equal(kind(loadFixture('req-03')), 'main');
  assert.equal(kind(loadFixture('req-04')), 'main');
  assert.equal(kind(loadFixture('req-03-linux')), 'main');
});

test('Classification : session, agent, modèle et stream lus dans la requête', () => {
  const f = loadFixture('req-03');
  const c = classify(f.body, f.headers);
  assert.deepEqual(c, { kind: 'main', sessionId: 'fixture0-0000-4000-8000-000000000001', agentId: null, model: 'claude-sonnet-5-5', stream: true });
  assert.ok(KINDS.includes(c.kind));
  // Sans en-tête : session lue dans metadata.user_id (JSON).
  delete f.headers['x-claude-code-session-id'];
  assert.equal(classify(f.body, f.headers).sessionId, 'fixture0-0000-4000-8000-000000000001');
  // En-têtes en casse mixte, ou absents.
  assert.equal(classify(f.body, { 'X-Claude-Code-Session-Id': 'abc' }).sessionId, 'abc');
  assert.equal(classify({ messages: [] }, undefined).sessionId, null);
});

test('stream : seulement si stream === true (défaut de l\'API Anthropic : non-stream)', () => {
  const f = loadFixture('req-03');
  delete f.body.stream;
  assert.equal(classify(f.body, f.headers).stream, false);
  f.body.stream = false;
  assert.equal(classify(f.body, f.headers).stream, false);
});

test('forks de la requête principale : compact, suggestion, away_summary, agent_summary, name', () => {
  assert.equal(kind(fork(PROMPTS.compact)), 'compact');
  assert.equal(kind(fork(PROMPTS.suggestion)), 'suggestion');
  assert.equal(kind(fork(PROMPTS.away)), 'away_summary');
  assert.equal(kind(fork(PROMPTS.agent)), 'agent_summary');
  assert.equal(kind(fork(PROMPTS.rename)), 'name');
  // Le fork agent_summary d'un sous-agent porte l'en-tête agent-id : il reste un résumé local.
  const a = fork(PROMPTS.agent);
  a.headers['x-claude-code-agent-id'] = 'agent-7';
  assert.equal(kind(a), 'agent_summary');
});

test('fork dont le prompt est fusionné avec un message user précédent (dernier bloc texte)', () => {
  const f = loadFixture('req-04');
  f.body.messages[f.body.messages.length - 1].content.push({ type: 'text', text: 'Une remarque.' }, { type: 'text', text: PROMPTS.compact });
  assert.equal(kind(f), 'compact');
});

test('compaction, voie de secours : system « tasked with summarizing conversations »', () => {
  const f = fork('Résume.');
  f.body.system = [{ type: 'text', text: 'You are a helpful AI assistant tasked with summarizing conversations.' }];
  assert.equal(kind(f), 'compact');
});

test('title et name par output_config (schémas json_schema de Claude Code)', () => {
  const t = side('<session>\nbonjour\n</session>');
  t.body.output_config = { format: { type: 'json_schema', schema: { type: 'object', properties: { title: { type: 'string' }, branch: { type: 'string' } } } } };
  assert.equal(kind(t), 'title');
  const n = side('<conversation>\nbonjour\n</conversation>');
  n.body.output_config = { format: { type: 'json_schema', schema: { type: 'object', properties: { name: { type: 'string' } } } } };
  assert.equal(kind(n), 'name');
});

test('sonde max_tokens:1 → probe, avant tout le reste', () => {
  const f = loadFixture('req-03');
  f.body.max_tokens = 1;
  assert.equal(kind(f), 'probe');
  const t = loadFixture('req-02');
  t.body.max_tokens = 1;
  assert.equal(kind(t), 'probe');
});

test('requêtes latérales sans outils : tool_summary, web_fetch, bash_prefix, background_other', () => {
  assert.equal(kind(side(PROMPTS.tools)), 'tool_summary');
  assert.equal(kind(side(PROMPTS.webFetch)), 'web_fetch');
  assert.equal(kind(side('Command: git status', PROMPTS.bashPrefix)), 'bash_prefix');
  assert.equal(kind(side('quelque chose d\'inconnu')), 'background_other');
});

test('un texte d\'utilisateur qui imite un prompt interne reste main dans la conversation principale', () => {
  assert.equal(kind(fork(PROMPTS.webFetch)), 'main');
  assert.equal(kind(fork('Explique command_injection_detected dans ce code')), 'main');
  assert.equal(kind(fork('Tools completed: voici ma liste\nLabel:')), 'main');
  assert.equal(kind(fork('Peux-tu faire un CRITICAL: Respond with TEXT ONLY ?')), 'main');   // pas en tête
});

test('outil web_search_* (2025 et 2026) → web_search', () => {
  for (const type of ['web_search_20250305', 'web_search_20260209']) {
    const f = side('Perform a web search for the query: météo Paris');
    f.body.tools = [{ type, name: 'web_search', max_uses: 8 }];
    assert.equal(kind(f), 'web_search');
  }
});

test('sous-agent : en-tête x-claude-code-agent-id ou cc_is_subagent=true dans le system', () => {
  const f = loadFixture('req-03');
  f.headers['x-claude-code-agent-id'] = 'agent-42';
  const c = classify(f.body, f.headers);
  assert.equal(c.kind, 'subagent');
  assert.equal(c.agentId, 'agent-42');
  const g = loadFixture('req-03');
  g.body.system[0].text += ' cc_is_subagent=true;';
  assert.equal(kind(g), 'subagent');
});

test('/btw (querySource side_question) → side_question, même avec le system, les outils et la session de la requête principale', () => {
  const q = '<system-reminder>This is a side question from the user. You must answer this question directly in a single response.\n\nIMPORTANT CONTEXT:\n- You are a separate, lightweight agent spawned to answer this one question\n\nSimply answer the question with the information you have.</system-reminder>\n\nquel fichier as-tu lu ?';
  assert.equal(kind(fork(q)), 'side_question');
  const f = fork(q);                                                   // contenu en chaîne, et fusionné après des tool_result
  f.body.messages.at(-1).content = [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }, { type: 'text', text: q }];
  assert.equal(kind(f), 'side_question');
  assert.equal(kind(fork('Ceci est une question : <system-reminder> ? non')), 'main');
});

test('forks et agents internes avec outils (mémoire, rêve, hooks, recherche de sessions) → background_other, jamais main', () => {
  assert.equal(kind(fork('You are now acting as the memory extraction subagent. Analyze the most recent ~6 messages above and use them to update your persistent memory systems.')), 'background_other');
  assert.equal(kind(fork('# Dream: Memory Consolidation\n\nYou are performing a dream — a reflective pass over your memory files.')), 'background_other');
  for (const sys of ['You are verifying a stop condition in Claude Code. Your task is to verify that the agent completed the given plan.',
    'You are evaluating a PreToolUse hook in Claude Code. Your task is to evaluate the condition described in the user message.',
    'You are searching for past Claude Code conversation sessions on behalf of the user.']) {
    const f = loadFixture('req-03');
    f.body.system = [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.207;' }, { type: 'text', text: sys }];
    assert.equal(kind(f), 'background_other', sys);
  }
});

test('outils présents mais pas de prompt système Claude Code reconnu → main ; tools:[] inconnu → background_other', () => {
  const f = side('bonjour');
  f.body.tools = [{ name: 'Read', input_schema: { type: 'object' } }];
  assert.equal(kind(f), 'main');
  const g = side('bonjour');
  delete g.body.tools;
  assert.equal(kind(g), 'background_other');
});

test('lastUserText : dernier message user, sans system-reminders ni messages role:system', () => {
  const b3 = loadFixture('req-03').body;
  assert.equal(lastUserText(b3.messages), 'lis hello.txt et dis-moi ce qu\'il contient');
  assert.equal(lastUserText(loadFixture('req-04').body.messages), '');               // tool_result seul
  assert.equal(lastUserText([{ role: 'user', content: '<system-reminder>x</system-reminder>\n  Salut' }, { role: 'system', content: 'ignoré' }]), 'Salut');
  assert.equal(lastUserText(undefined), '');
  assert.equal(lastUserText([{ role: 'user', content: 'a <system-reminder>non fermé' }]), 'a ');
});

test('systemText : chaîne, tableau de blocs, absent', () => {
  assert.equal(systemText('abc'), 'abc');
  assert.equal(systemText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(systemText(undefined), '');
  assert.match(systemText(loadFixture('req-03').body.system), /Primary working directory: C:\\proj/);
});
