// Tests de src/gateway/outbound.js : seul constructeur des corps envoyés à France Student (spécification § 3.7, I1, I3).
// Les cas « réels » partent des captures de Claude Code 2.1.207 (req-03 : 1er message, req-04 : résultat d'un Read)
// et passent par canonicalize / computeDelta / collectResults, comme le fera la passerelle. Hors ligne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, fakeFs } from './gateway-helpers.mjs';

const { buildSend, assertClean, frenchNote, mergeUserTurns, afterSend } = await import('../src/gateway/outbound.js');
const { planToolUses, collectResults, LOCAL } = await import('../src/gateway/toolmap.js');
const { canonicalize, computeDelta } = await import('../src/gateway/transcript.js');
const { extractEnv } = await import('../src/gateway/context.js');
const { CLIENT_TOOLS } = await import('../src/api.js');
const { READ_TOOLS } = await import('../src/native.js');

const ANTH = Object.freeze({ agentId: -2003, model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic', native: true, contextWindow: 200000 });
const GPT = Object.freeze({ agentId: -1004, model: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'openai', native: true, contextWindow: 400000 });
const GEMINI = Object.freeze({ agentId: -3001, model: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'google', native: false, contextWindow: 1000000 });
const WIN = Object.freeze({ cwd: 'C:\\proj', platform: 'win32', shell: 'bash', osVersion: 'Windows 11 Pro 10.0.26300', isGit: false, branch: null, extraDirs: [], pathMod: 'win32' });

/** Conversation neuve, même forme que store.create (sans disque). */
function conv(over = {}) {
  return {
    id: 'convTest0001', key: 'sess|main', sessions: ['sess'], sid: 'ab12',
    chatId: null, agentId: -2003, provider: 'anthropic', native: true, bare: false,
    env: WIN, preambleSent: false, claudeMdHash: null, lastFp: null, lastText: '', anchors: [],
    fs: { state: 'idle', pending: [], lastEventId: null, inflightKey: null },
    readSet: { sessionId: 'sess', paths: {} }, notes: [], refusal: { stage: 0, toolsSeen: false }, subagents: 0,
    lastReplies: [], fsPromptTokens: 0, turn: 0, createdAt: 0, updatedAt: 0, ...over,
  };
}

const userTurn = (text, over = {}) => ({ role: 'user', text, results: [], images: [], notes: [], interrupted: false, marker: null, isContinuation: false, claudeMd: null, ...over });
const delta = (userTurns, over = {}) => ({ kind: 'append', userTurns, ...over });
const strictOk = (send, pending) => assert.deepEqual(assertClean(send, { strict: true, pending }), []);
const MD = text => ({ text, hash: `h-${text.length}`, paths: ['C:\\proj\\CLAUDE.md'] });

// ── Captures réelles ──

test('req-03 (1er message) : chat neuf = préambule + demande, register, outils client ; rien de Claude Code (I1)', () => {
  const body = loadFixture('req-03').body;
  const env = extractEnv(body.system, 'C:\\ailleurs');
  const turns = canonicalize(body.messages);
  const c = conv({ env });
  const d = computeDelta(c, turns, body.model);
  assert.equal(d.kind, 'new');
  const send = buildSend(c, d, ANTH, env, { date: '2026-11-18', shellTool: 'Bash' });
  strictOk(send);
  assert.deepEqual(Object.keys(send).sort(), ['agentId', 'chatId', 'clientTools', 'content', 'register', 'webSearch']);
  assert.deepEqual(send.register, { sid: 'ab12', role: 'cc' });
  assert.deepEqual(send.clientTools, CLIENT_TOOLS);
  assert.equal(send.chatId, null);
  assert.equal(send.agentId, -2003);
  assert.equal(send.webSearch, false);
  assert.match(send.content, /^\[ab12·cc\] Contexte : dossier de travail C:\\proj \(/);
  assert.match(send.content, /Date : 18\/11\/2026\./);
  assert.match(send.content, /\n\nlis hello\.txt et dis-moi ce qu'il contient$/);
  for (const bad of [/system-reminder/, /Claude Code/, /currentDate/, /IMPORTANT: this context/, /\bAgent\b/, /skills?/i])
    assert.doesNotMatch(send.content, bad);
  assert.ok(!('toolResults' in send) && !('files' in send));
});

test('req-04 (résultat du Read) : le 2e envoi ne contient QUE toolResults (scénario a), I3 vérifié', async () => {
  const body = loadFixture('req-04').body;
  const env = extractEnv(body.system);
  const fake = fakeFs({ files: { 'C:\\proj\\hello.txt': 'contenu de test\n' } });
  const c = conv({ env, chatId: 'chat-1' });
  const plan = planToolUses([{ callId: 'call_1', name: 'read_file', arguments: { path: 'hello.txt' } }],
    { env, tools: body.tools, readSet: c.readSet, sessionId: 'sess', fsExists: fake.fsExists, fsStat: fake.fsStat, chatId: 'chat-1' });
  // la capture contient l'id « toolu_capture1 » : on y met celui que la passerelle aurait émis
  const id = plan.uses[0].id;
  const asst = body.messages.find(m => m.role === 'assistant');
  asst.content[0].id = id;
  body.messages.at(-1).content[0].tool_use_id = id;
  Object.assign(c, { lastFp: 'A:' + id, fs: { ...c.fs, state: 'pending', pending: plan.pending } });

  const turns = canonicalize(body.messages);
  const d = computeDelta(c, turns, body.model);
  assert.equal(d.kind, 'append');
  const byId = Object.fromEntries(d.userTurns.flatMap(u => u.results).map(r => [r.id, r]));
  const col = await collectResults(c.fs.pending, byId, { env, readSet: c.readSet, uploadFile: fake.uploadFile });
  const send = buildSend(c, d, ANTH, env, { toolResults: col.toolResults, files: col.files, notes: col.notes });
  strictOk(send, c.fs.pending);
  assert.deepEqual(send, {
    agentId: -2003, chatId: 'chat-1', webSearch: false, clientTools: CLIENT_TOOLS,
    toolResults: [{ callId: 'call_1', output: '1: contenu de test\n2: ', isError: false }],
  });
});

test('un message saisi pendant des appels en attente : toolResults « Non exécuté » + content, notes et interruption', () => {
  const pending = [{ callId: 'c1', ccId: 'x', fsName: 'run_command', path: null, local: null, retried: 0 },
    { callId: 'c2', ccId: 'y', fsName: 'read_file', path: null, local: null, retried: 0 }];
  const c = conv({ chatId: 'chat-1', fs: { state: 'pending', pending, lastEventId: null, inflightKey: null }, notes: ['Note en attente.'] });
  const d = delta([userTurn('arrête et lance plutôt les tests', { interrupted: true, notes: ['Fichier modifié hors de la conversation : a.js (relis-le avant de le modifier).'] })]);
  const send = buildSend(c, d, ANTH, WIN);
  strictOk(send, pending);
  assert.deepEqual(send.toolResults, [
    { callId: 'c1', output: LOCAL.notRun, isError: true },
    { callId: 'c2', output: LOCAL.notRun, isError: true },
  ]);
  assert.equal(send.content, 'Note en attente.\nFichier modifié hors de la conversation : a.js (relis-le avant de le modifier).\n(L\'utilisateur a interrompu l\'action précédente.)\n\narrête et lance plutôt les tests');
  assert.ok(!('register' in send));
});

test('mode texte seul (Gemini) : ni clientTools ni toolResults, même avec des appels en attente (I7)', () => {
  const pending = [{ callId: 'c1', ccId: 'x', fsName: 'read_file', path: null, local: null, retried: 0 }];
  const c = conv({ chatId: 'chat-1', fs: { state: 'pending', pending, lastEventId: null, inflightKey: null } });
  const send = buildSend(c, delta([userTurn('explique ce code')]), GEMINI, WIN, { toolResults: [{ callId: 'c1', output: 'x', isError: false }] });
  strictOk(send);
  assert.deepEqual(send, { agentId: -3001, chatId: 'chat-1', webSearch: false, content: 'explique ce code' });
  const fresh = buildSend(conv(), { kind: 'new', userTurns: [userTurn('bonjour')] }, GEMINI, WIN);
  assert.ok(!('clientTools' in fresh) && fresh.register && fresh.content.endsWith('\n\nbonjour'));
});

test('mode plan → outils de lecture seuls ; recherche web ; images et captures (4 au plus, sans doublon)', () => {
  const send = buildSend(conv({ chatId: 'chat-1', planMode: true }), delta([userTurn('regarde')]), ANTH, WIN,
    { web: true, images: ['f1', 'f2'], files: ['f2', 'f3', 'f4', 'f5'] });
  assert.deepEqual(send.clientTools, READ_TOOLS);
  assert.equal(send.webSearch, true);
  assert.deepEqual(send.files, ['f1', 'f2', 'f3', 'f4']);
});

test('chat « bare » (refus GPT au 1er tour) : étiquette + demande seule, ni préambule ni CLAUDE.md', () => {
  const d = { kind: 'new', userTurns: [userTurn('crée README.md', { claudeMd: MD('Règle : tests avant commit.') })] };
  const send = buildSend(conv({ bare: true }), d, GPT, WIN);
  strictOk(send);
  assert.equal(send.content, '[ab12·cc] crée README.md');
});

test('CLAUDE.md : envoyé aux modèles Claude, pas à GPT (sauf --fs-claude-md) ; changement noté une seule fois', () => {
  const md = MD('Toujours répondre en français.\nUtilise TodoWrite pour suivre.\nTests : npm test.');
  const d = { kind: 'new', userTurns: [userTurn('salut', { claudeMd: md })] };
  const a = buildSend(conv(), d, ANTH, WIN);
  strictOk(a);
  assert.match(a.content, /\[Consignes du projet \(CLAUDE\.md, extrait\) :\nToujours répondre en français\.\nTests : npm test\.\]/);
  assert.doesNotMatch(buildSend(conv(), d, GPT, WIN).content, /CLAUDE\.md|Toujours répondre/);
  assert.match(buildSend(conv(), d, GPT, WIN, { forceClaudeMd: true }).content, /Toujours répondre en français/);

  const c = conv({ chatId: 'chat-1', claudeMdHash: 'ancien' });
  const md2 = MD('Nouvelle règle : pas de console.log.');
  const s1 = buildSend(c, delta([userTurn('continue', { claudeMd: md2 })]), ANTH, WIN);
  strictOk(s1);
  assert.equal(s1.content, '[Consignes du projet mises à jour (CLAUDE.md, extrait) :\nNouvelle règle : pas de console.log.]\n\ncontinue');
  afterSend(c, WIN, { claudeMd: md2 });
  assert.equal(buildSend(c, delta([userTurn('encore', { claudeMd: md2 })]), ANTH, WIN).content, 'encore', 'une seule fois');
  assert.equal(buildSend(conv({ chatId: 'chat-1', claudeMdHash: 'ancien' }), delta([userTurn('x', { claudeMd: md2 })]), GPT, WIN).content, 'x');
});

test('changement de dossier ou de shell : note d\'une ligne, une seule fois (afterSend)', () => {
  const c = conv({ chatId: 'chat-1', shellTool: 'Bash' });
  const env2 = { ...WIN, cwd: 'D:\\autre' };
  const s = buildSend(c, delta([userTurn('liste')]), ANTH, env2, { shellTool: 'PowerShell' });
  strictOk(s);
  assert.equal(s.content, '(Le dossier de travail est maintenant D:\\autre : les chemins relatifs partent de ce dossier.)\n(Les commandes de run_command s\'exécutent maintenant dans PowerShell.)\n\nliste');
  afterSend(c, env2, { shellTool: 'PowerShell' });
  assert.equal(buildSend(c, delta([userTurn('liste')]), ANTH, env2, { shellTool: 'PowerShell' }).content, 'liste');
  assert.deepEqual(c.notes, []);
  assert.equal(c.preambleSent, true);
});

test('chat emprunté (limite du jour) : note « nouvelle tâche » + préambule + demande, dans le chat existant', () => {
  const send = buildSend(conv({ chatId: 'chat-9' }), { kind: 'new', userTurns: [userTurn('corrige calc.js')] }, ANTH, WIN, { borrowed: true, date: '2026-11-18' });
  strictOk(send);
  assert.equal(send.chatId, 'chat-9');
  assert.ok(!('register' in send));
  assert.match(send.content, /^\[Nouvelle tâche, sans rapport avec ce qui précède\.\]\n\[ab12·cc\] Contexte : /);
  assert.match(send.content, /\n\ncorrige calc\.js$/);
});

test('retour en arrière par note : extrait de l\'ancre, appels en attente « annulés »', () => {
  const pending = [{ callId: 'c1', ccId: 'x', fsName: 'edit_file', path: null, local: null, retried: 0 }];
  const c = conv({ chatId: 'chat-1', anchors: [['T:abc', 1, 'Voici le plan en trois étapes pour corriger le calcul de la TVA dans facture.js', null]],
    fs: { state: 'pending', pending, lastEventId: null, inflightKey: null } });
  const send = buildSend(c, { kind: 'rewind', anchorIndex: 0, userTurns: [userTurn('fais plutôt l\'étape 2')] }, ANTH, WIN, { rewind: 'note' });
  strictOk(send, pending);
  assert.deepEqual(send.toolResults, [{ callId: 'c1', output: 'Annulé (retour en arrière).', isError: true }]);
  assert.equal(send.content, '[Retour en arrière : l\'utilisateur a annulé tout ce qui suit ta réponse « Voici le plan en trois étapes pour corriger le calcul de la TVA… ». '
    + 'Les fichiers ont pu être restaurés : relis-les avant de les modifier. Ne tiens plus compte des échanges annulés.]\n\nfais plutôt l\'étape 2');
});

test('réponse affichée hors passerelle : note avec 400 caractères au plus ; récapitulatif d\'un nouveau chat', () => {
  const s = buildSend(conv({ chatId: 'chat-1' }), delta([userTurn('ok')], { foreignAssistantText: 'z'.repeat(1000) }), ANTH, WIN);
  strictOk(s);
  assert.equal(s.content, `(Réponse affichée entre-temps, hors France Student : « ${'z'.repeat(400)}… ».)\n\nok`);
  const r = buildSend(conv(), { kind: 'unknown', userTurns: [userTurn('et maintenant ?')] }, ANTH, WIN, { recap: 'Récapitulatif : tu as lu calc.js.' });
  strictOk(r);
  assert.match(r.content, /^\[ab12·cc\] Contexte : [\s\S]*\n\nRécapitulatif : tu as lu calc\.js\.\n\net maintenant \?$/);
});

test('rien à envoyer : consigne « Continue » (I7) ; mergeUserTurns fusionne les messages', () => {
  assert.equal(buildSend(conv({ chatId: 'chat-1' }), delta([]), ANTH, WIN).content, frenchNote('continue'));
  assert.match(buildSend(conv(), { kind: 'new', userTurns: [] }, ANTH, WIN).content, /\n\nContinue la tâche en cours/);
  const m = mergeUserTurns([userTurn('a', { results: [{ id: 'r1' }], notes: ['n1'] }), { role: 'assistant', text: 'ignoré' },
    userTurn('b', { interrupted: true, images: [{ media_type: 'image/png', data: 'AA' }], claudeMd: MD('x') })]);
  assert.deepEqual([m.text, m.results.length, m.notes, m.interrupted, m.images.length, m.claudeMd.text], ['a\n\nb', 1, ['n1'], true, 1, 'x']);
});

// ── assertClean ──

test('assertClean strict : chaque motif interdit lève une exception (balises, Claude Code, noms d\'outils)', () => {
  const bad = ['<system-reminder>x</system-reminder>', '<command-name>/init</command-name>', '<tool_use_error>x</tool_use_error>',
    'You are Claude Code, Anthropic\'s CLI', 'x-anthropic-billing-header: cc', 'utilise TodoWrite', 'NotebookEdit', 'WebFetch', 'SendMessage', 'ExitPlanMode',
    'avec `Read`', 'avec `Bash`', 'avec `Skill`'];
  for (const content of bad) {
    assert.throws(() => assertClean({ content }, { strict: true }), /Fuite vers France Student/, content);
  }
  for (const content of ['lis le fichier Read.me', 'Edit du README', 'Agent immobilier', 'bash et grep']) assert.deepEqual(assertClean({ content }, { strict: true }), []);
});

test('assertClean : toolResults jamais inspectés ; hors mode strict, content nettoyé et fuites listées', () => {
  const send = { toolResults: [{ callId: 'c1', output: '<system-reminder>contenu réel du fichier</system-reminder> TodoWrite', isError: false }] };
  assert.deepEqual(assertClean(send, { strict: true }), []);
  const s = { content: '<system-reminder>rappel</system-reminder> Utilise TodoWrite puis `Read`.' };
  const leaks = assertClean(s);
  assert.equal(leaks.length, 3);
  assert.equal(s.content, 'rappel Utilise l\'assistant puis l\'assistant.');
});

test('assertClean { pending } : I3 (une réponse par appel en attente, aucun id inconnu ou synthétique)', () => {
  const pending = [{ callId: 'c1' }, { callId: 'c2' }];
  assert.deepEqual(assertClean({ toolResults: [{ callId: 'c1', output: '', isError: false }, { callId: 'c2', output: '', isError: false }] }, { pending }), []);
  const leaks = assertClean({ toolResults: [{ callId: 'c1', output: '', isError: false }, { callId: 'c1', output: '', isError: false }, { callId: 'toolu_s', output: '', isError: false }] }, { pending });
  assert.deepEqual(leaks.sort(), ['toolResults : callId c1 répondu 2 fois', 'toolResults : callId c2 sans réponse', 'toolResults : callId inconnu toolu_s'].sort());
  assert.throws(() => assertClean({ toolResults: [] }, { strict: true, pending }), /I1\/I3/);
});

test('I1 de bout en bout : rappels skills/agents, balises de commande et auto-mémoire ne partent jamais', () => {
  const body = loadFixture('req-03').body;
  body.messages[0].content.unshift({ type: 'text', text: '<system-reminder>\nThe following skills are available for use with the Skill tool:\n- review\n</system-reminder>' });
  body.messages[0].content.push({ type: 'text', text: '<command-name>/review</command-name><command-message>review</command-message><command-args>calc.js</command-args>' });
  body.messages[0].content.unshift({ type: 'text', text: '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# claudeMd\nContents of C:\\Users\\x\\.claude\\projects\\p\\memory\\MEMORY.md (user\'s auto-memory, persists across conversations):\n\n- secret perso\n\nContents of C:\\proj\\CLAUDE.md (project instructions, checked into the codebase):\n\nRègle du projet.\n# userEmail\nquelqu.un@example.com\n</system-reminder>' });
  const turns = canonicalize(body.messages);
  const env = extractEnv(body.system);
  const send = buildSend(conv({ env }), computeDelta(conv(), turns, body.model), ANTH, env);
  strictOk(send);
  assert.doesNotMatch(send.content, /secret perso|example\.com|Skill|review<|command-/);
  assert.match(send.content, /Règle du projet\./);
  assert.match(send.content, /calc\.js/);
});
