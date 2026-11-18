// Tests de src/gateway/background.js : réponses locales aux requêtes d'arrière-plan, 0 appel France Student
// (spécification § 3.11, § 5.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, validateAgainstSchema, fakeFs } from './gateway-helpers.mjs';   // pose FS_CLI_HOME

const { answerLocally, localTitle, localSlug, localCompactSummary, estimateBodyTokens, compactFsInBackground, SUBAGENT_REFUSAL, WEB_SEARCH_OFF } =
  await import('../src/gateway/background.js');
const { classify } = await import('../src/gateway/classify.js');
const { cleanUserContent } = await import('../src/gateway/context.js');

const answer = (f, ctx) => answerLocally(classify(f.body, f.headers), f.body, ctx);
const textOf = r => r.content.map(b => b.text).join('');

function side(text, extra = {}) {
  const f = loadFixture('req-02');
  delete f.body.output_config;
  f.body.messages = [{ role: 'user', content: text }];
  Object.assign(f.body, extra);
  return f;
}

function fork(text) {
  const f = loadFixture('req-04');
  f.body.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Le fichier hello.txt contient « contenu de test ».' }] });
  f.body.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  return f;
}

test('title (req-02) : JSON conforme au schéma, 6 premiers mots, end_turn, usage estimé sur le corps reçu', () => {
  const f = loadFixture('req-02');
  const r = answer(f);
  const obj = JSON.parse(textOf(r));
  assert.deepEqual(obj, { title: 'Lis hello.txt et dis-moi ce qu\'il' });
  assert.deepEqual(validateAgainstSchema(obj, f.body.output_config.format.schema), []);
  assert.equal(r.stop, 'end_turn');
  assert.equal(r.usage.input_tokens, estimateBodyTokens(f.body));
  assert.equal(r.usage.input_tokens, Math.ceil(JSON.stringify({ system: f.body.system, tools: f.body.tools, messages: f.body.messages }).length / 3.5));
  assert.equal(r.usage.output_tokens, Math.ceil(textOf(r).length / 4));
  assert.equal(answer(f, { est: 1234 }).usage.input_tokens, 1234);
});

test('localTitle : ponctuation finale, majuscule, 60 caractères, rappels retirés, vide', () => {
  assert.equal(localTitle('corrige le bug !!!'), 'Corrige le bug');
  assert.equal(localTitle('  écris un test pour calc.js, puis lance-le maintenant svp'), 'Écris un test pour calc.js, puis');
  assert.equal(localTitle(''), 'Nouvelle session');
  assert.equal(localTitle('<system-reminder>x</system-reminder> ?'), 'Nouvelle session');
  const long = localTitle('Anticonstitutionnellementxxxxxxxxxxxxxxxxxxxx ' + 'b'.repeat(40));
  assert.ok(long.length <= 60, long);
});

test('name : par output_config et par fork /rename, JSON kebab-case conforme', () => {
  const f = side('<conversation>\nlis hello.txt et dis-moi ce qu\'il contient\nLe fichier contient du texte.\n</conversation>');
  f.body.output_config = { format: { type: 'json_schema', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } };
  const obj = JSON.parse(textOf(answer(f)));
  assert.deepEqual(obj, { name: 'lis-hello-txt-et-dis-moi-ce-qu-il' });
  assert.deepEqual(validateAgainstSchema(obj, f.body.output_config.format.schema), []);
  const k = fork('Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Return JSON with a "name" field.');
  assert.deepEqual(JSON.parse(textOf(answer(k))), { name: 'lis-hello-txt-et-dis-moi-ce-qu-il' });
  // Le prompt interne de /rename n'est jamais pris pour une demande de l'utilisateur.
  const only = side('Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation.');
  only.body.tools = loadFixture('req-03').body.tools;
  assert.deepEqual(JSON.parse(textOf(answer(only))), { name: 'session' });
  assert.equal(localSlug('Été : réparer l\'API'), 'ete-reparer-l-api');
  assert.equal(localSlug(''), 'session');
});

test('title de téléportation {title, branch} : les deux champs requis sont remplis', () => {
  const f = side('<session>\najoute une page de connexion\n</session>');
  const schema = { type: 'object', properties: { title: { type: 'string' }, branch: { type: 'string' } }, required: ['title', 'branch'], additionalProperties: false };
  f.body.output_config = { format: { type: 'json_schema', schema } };
  const obj = JSON.parse(textOf(answer(f)));
  assert.deepEqual(validateAgainstSchema(obj, schema), []);
  assert.equal(obj.title, 'Ajoute une page de connexion');
  assert.equal(obj.branch, 'ajoute-une-page-de-connexion');
});

test('probe : « . » et max_tokens ; modèle inconnu → erreur 404 en français', () => {
  const f = loadFixture('req-03');
  f.body.max_tokens = 1;
  const r = answer(f);
  assert.equal(textOf(r), '.');
  assert.equal(r.stop, 'max_tokens');
  const e = answer(f, { modelKnown: false });
  assert.deepEqual(e.error, { status: 404, type: 'not_found_error', message: 'model: claude-sonnet-5-5 introuvable sur France Student' });
});

test('suggestion, agent_summary, bash_prefix, background_other : réponses exactes', () => {
  assert.equal(textOf(answer(fork('[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]'))), '');
  assert.equal(textOf(answer(fork('Describe your most recent action in 3-5 words using present tense (-ing).'))), 'Travail en cours');
  assert.equal(textOf(answer(side('Command: git status', { system: [{ type: 'text', text: 'git status`ls` => command_injection_detected' }] }))), 'none');
  const other = answer(side('requête inconnue'));
  assert.equal(textOf(other), '');
  assert.equal(other.stop, 'end_turn');
  assert.deepEqual(other.content, [{ type: 'text', text: '' }]);
});

test('away_summary : 40 premiers mots de la dernière réponse (conv, sinon historique, sinon défaut)', () => {
  const f = fork('The user stepped away and is coming back. Recap in under 40 words.');
  const long = Array.from({ length: 60 }, (_, i) => `mot${i}`).join(' ');
  const a = textOf(answer(f, { conv: { lastText: long } }));
  assert.equal(a, 'Dernière étape : ' + Array.from({ length: 40 }, (_, i) => `mot${i}`).join(' '));
  assert.equal(textOf(answer(f)), 'Dernière étape : Le fichier hello.txt contient « contenu de test ».');
  const g = loadFixture('req-03');
  g.body.messages.push({ role: 'user', content: 'The user stepped away and is coming back.' });
  assert.equal(textOf(answer(g)), 'Travail en cours.');
});

test('tool_summary : libellé du dernier outil (Read, Edit/Write, Bash, autre, JSON coupé)', () => {
  const ts = (tool, input) => textOf(answer(side(`Tools completed:\n\nTool: Glob\nInput: {}\nOutput: x\n\nTool: ${tool}\nInput: ${input}\nOutput: ok\n\nLabel:`)));
  assert.equal(ts('Read', '{"file_path":"C:\\\\proj\\\\hello.txt"}'), 'Lecture de hello.txt');
  assert.equal(ts('Edit', '{"file_path":"/srv/mon projet/été/calc.js","old_string":"a"}'), 'Modification de calc.js');
  assert.equal(ts('Write', '{"file_path":"C:\\\\proj\\\\README.md","content":"…'), 'Modification de README.md');
  assert.equal(ts('Bash', '{"command":"node --test test/calc.test.js && echo terminé et vérifié","descr'), 'Commande : node --test test/calc.test.js');
  assert.equal(ts('TodoWrite', '{"todos":[]}'), 'Action terminée');
});

test('web_fetch : page brute coupée à 8 000 caractères + note ; web_search désactivée ; sous-agent refusé', () => {
  const page = 'p'.repeat(9000);
  const w = textOf(answer(side(`\nWeb page content:\n---\n${page}\n---\n\nRésume la page.`)));
  assert.ok(w.startsWith('p'.repeat(8000) + '\n[…]'));
  assert.ok(w.endsWith('\n\n(Résumé non disponible : contenu brut de la page.)'));
  assert.ok(!w.includes('Résume la page'));
  const s = side('Perform a web search for the query: météo');
  s.body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  assert.equal(textOf(answer(s)), WEB_SEARCH_OFF);
  assert.equal(textOf(answerLocally({ kind: 'subagent', model: 'x' }, loadFixture('req-03').body)), SUBAGENT_REFUSAL);
  assert.equal(answerLocally({ kind: 'main', model: 'x' }, loadFixture('req-03').body), null);
});

// Conversation fabriquée : demandes, Edit/Write, commandes (une en échec), puis le prompt de compaction.
function compactBody() {
  const f = loadFixture('req-04');
  const m = f.body.messages;
  m.push({ role: 'assistant', content: [{ type: 'text', text: 'Je corrige.' },
    { type: 'tool_use', id: 'toolu_e1', name: 'Edit', input: { file_path: 'C:\\proj\\calc.js', old_string: 'a - b', new_string: 'a + b' } },
    { type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'node --test', description: 'tests' } }] });
  m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'toolu_b1', content: 'Exit code 1', is_error: true }] });
  m.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_w1', name: 'Write', input: { file_path: 'C:\\proj\\README.md', content: '#' } },
    { type: 'tool_use', id: 'toolu_e2', name: 'Edit', input: { file_path: 'C:\\proj\\calc.js', old_string: 'x', new_string: 'y' } }] });
  m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'toolu_e2', content: 'ok' }, { type: 'text', text: 'ajoute aussi une fonction subtract' }] });
  m.push({ role: 'assistant', content: [{ type: 'text', text: 'C\'est fait : subtract ajoutée et tests verts.' }] });
  m.push({ role: 'user', content: [{ type: 'text', text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far.' }] });
  return f;
}

test('compact : résumé local <analysis>/<summary> avec demandes, fichiers, commandes, dernière réponse et marqueur', () => {
  const f = compactBody();
  const fake = fakeFs();
  const r = answer(f, { conv: { id: 'Ab12Cd34Ef56', lastText: 'Réponse finale enregistrée.' } });
  const s = textOf(r);
  assert.equal(r.stop, 'end_turn');
  assert.match(s, /^<analysis>Résumé construit localement par FS-CLI : la conversation complète reste dans France Student\.<\/analysis>\n<summary>\n/);
  assert.match(s, /1\. Demandes de l'utilisateur :\n   - lis hello\.txt et dis-moi ce qu'il contient\n   - ajoute aussi une fonction subtract\n2\./);
  assert.ok(!s.includes('CRITICAL'));
  assert.match(s, /2\. Fichiers touchés : C:\\proj\\calc\.js, C:\\proj\\README\.md\n/);
  assert.match(s, /3\. Dernières commandes :\n   - node --test \(échec\)\n/);
  assert.match(s, /4\. Dernière réponse : Réponse finale enregistrée\.\n/);
  assert.match(s, /5\. Conversation France Student conservée : \[fs-gw:Ab12Cd34Ef56\]\n<\/summary>$/);
  assert.equal(fake.calls.stream.length, 0);                                       // aucun appel France Student
  // Sans conv : dernière réponse lue dans l'historique, pas de marqueur.
  const t = textOf(answer(f));
  assert.match(t, /4\. Dernière réponse : C'est fait : subtract ajoutée et tests verts\./);
  assert.ok(!t.includes('fs-gw:'));
});

test('compact puis reprise : le marqueur du résumé est retrouvé par cleanUserContent dans le message de continuation', () => {
  const summary = localCompactSummary([{ role: 'user', text: 'corrige calc.js', results: [] }], { id: 'Zz98Yy76Xx54', lastText: 'ok' });
  const continuation = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n'
    + summary.replace(/<analysis>[\s\S]*?<\/analysis>\n/, '').replace(/<\/?summary>/g, '')
    + '\nContinue the conversation from where it left off without asking the user any further questions.';
  const u = cleanUserContent(continuation);
  assert.equal(u.isContinuation, true);
  assert.equal(u.marker, 'Zz98Yy76Xx54');
  assert.ok(!u.text.includes('corrige calc.js'));
});

test('localCompactSummary : historique vide, dernière réponse coupée à 1 500 caractères', () => {
  const s = localCompactSummary([], { id: 'abcdef', lastText: 'r'.repeat(2000) });
  assert.match(s, /1\. Demandes de l'utilisateur : aucune\n2\. Fichiers touchés : aucun\n3\. Dernières commandes : aucune\n/);
  assert.ok(s.includes('r'.repeat(1500) + '…\n'));
  assert.ok(!s.includes('r'.repeat(1501)));
  assert.match(localCompactSummary(null, null), /4\. Dernière réponse : aucune\n<\/summary>$/);
});

test('compactFsInBackground : seulement au-delà de 60 % et sans appel en attente ; erreurs avalées', async () => {
  const calls = [];
  const compactChat = async id => { calls.push(id); return { status: 204 }; };
  const conv = { chatId: 'chat-1', fs: { state: 'idle' }, fsPromptTokens: 130000 };
  assert.equal(await compactFsInBackground(conv, { contextWindow: 200000, compactChat }), 204);
  assert.equal(await compactFsInBackground({ ...conv, fsPromptTokens: 100000 }, { contextWindow: 200000, compactChat }), null);
  assert.equal(await compactFsInBackground({ ...conv, fs: { state: 'pending' } }, { contextWindow: 200000, compactChat }), null);
  assert.equal(await compactFsInBackground({ ...conv, chatId: null }, { compactChat }), null);
  assert.deepEqual(calls, ['chat-1']);
  assert.equal(await compactFsInBackground(conv, { compactChat: async () => { throw new Error('réseau'); } }), null);
  assert.equal(await compactFsInBackground(conv, { compactChat: async () => ({ status: 422 }) }), 422);
});

test('économie : aucune réponse d\'arrière-plan n\'utilise le faux France Student', () => {
  const fake = fakeFs();
  const bodies = [loadFixture('req-02'), fork('[SUGGESTION MODE: x]'), fork('CRITICAL: Respond with TEXT ONLY.'), side('Tools completed:\n\nTool: Read\nInput: {}\nOutput: x\n\nLabel:')];
  for (const f of bodies) assert.ok(answerLocally(classify(f.body, f.headers), f.body, { deps: fake.deps }));
  for (const [name, list] of Object.entries(fake.calls)) assert.equal(list.length, 0, name);
});
