// Passerelle Claude Code : forme canonique, empreintes et delta (src/gateway/transcript.js, spécification § 3.3).
import { loadFixture } from './gateway-helpers.mjs';   // pose FS_CLI_HOME sur un dossier temporaire avant tout import de src/
import test from 'node:test';
import assert from 'node:assert/strict';

const T = await import('../src/gateway/transcript.js');
const { canonicalize, fpAssistant, requestKey, computeDelta, norm, basicClean } = T;

const MODEL = 'claude-sonnet-5-5';
const ASK = 'lis hello.txt et dis-moi ce qu\'il contient';

/** conversation minimale (forme Conv, seuls les champs lus par computeDelta comptent) */
function mkConv(over = {}) {
  return {
    id: 'AbCdEf123456', chatId: 'chat-1', lastFp: null, lastText: '', anchors: [], lastReplies: [],
    fs: { state: 'idle', pending: [], lastEventId: null, inflightKey: null }, ...over,
  };
}
const user = (...content) => ({ role: 'user', content });
const text = t => ({ type: 'text', text: t });
const asst = (t, uses = []) => ({ role: 'assistant', content: [...(t ? [text(t)] : []), ...uses.map(([id, name, input]) => ({ type: 'tool_use', id, name, input: input || {} }))] });
const result = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });

const CONTINUATION = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Demandes : corriger calc.js\n5. Conversation France Student conservée : [fs-gw:Ab12Cd34Ef56]\n'
  + '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary.';

// ── canonicalize ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('canonicalize req-03 : message role:system ignoré, rappels retirés, demande seule', () => {
  const turns = canonicalize(loadFixture('req-03').body.messages);
  assert.equal(turns.length, 1);
  const [u] = turns;
  assert.equal(u.role, 'user');
  assert.equal(u.text, ASK);
  assert.doesNotMatch(u.text, /system-reminder|currentDate|Available agent types/);
  assert.deepEqual(u.results, []);
  assert.equal(u.isContinuation, false);
  assert.equal(u.interrupted, false);
});

test('canonicalize req-04 : assistant tool_use puis user tool_result', () => {
  const turns = canonicalize(loadFixture('req-04').body.messages);
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant', 'user']);
  assert.deepEqual(turns[1].toolUses, [{ id: 'toolu_capture1', name: 'Read', input: { file_path: 'C:\\proj\\hello.txt' } }]);
  assert.equal(turns[1].text, '');
  assert.deepEqual(turns[2].results, [{ id: 'toolu_capture1', content: '1\tcontenu de test\n2\t', is_error: false }]);
  assert.equal(turns[2].text, '');
  assert.equal(fpAssistant(turns[1]), 'A:toolu_capture1');
});

test('canonicalize : messages consécutifs du même rôle fusionnés, thinking ignoré', () => {
  const turns = canonicalize([
    user(text('a')), user(text('b')),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, text('Je lis.')] },
    asst('', [['toolu_1', 'Read', { file_path: '/x' }]]),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'a\n\nb');
  assert.equal(turns[1].text, 'Je lis.');
  assert.deepEqual(turns[1].toolUses.map(t => t.id), ['toolu_1']);
  assert.equal(canonicalize([{ role: 'user', content: 'texte brut' }])[0].text, 'texte brut');
  assert.deepEqual(canonicalize(null), []);
});

test('canonicalize : nettoyeur injectable (contrat de context.cleanUserContent)', () => {
  const seen = [];
  const clean = c => { seen.push(c); return { text: 'PROPRE', images: [], notes: ['n1'], interrupted: true, marker: null, isContinuation: false, claudeMd: null }; };
  const [u] = canonicalize([user(result('toolu_9', 'ok'), text('<system-reminder>x</system-reminder>salut'))], { clean });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map(b => b.type), ['text'], 'les tool_result ne passent pas par le nettoyeur');
  assert.equal(u.text, 'PROPRE');
  assert.deepEqual(u.notes, ['n1']);
  assert.equal(u.interrupted, true);
  assert.deepEqual(u.results.map(r => r.id), ['toolu_9']);
});

test('basicClean : interruption, balises de commande, images, compaction avec marqueur', () => {
  const a = basicClean([text('[Request interrupted by user for tool use]'), text('<command-name>/fix</command-name><command-message>fix</command-message><command-args>le bug</command-args>'),
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }]);
  assert.equal(a.interrupted, true);
  assert.equal(a.text, 'le bug');
  assert.deepEqual(a.images, [{ media_type: 'image/png', data: 'iVBOR' }]);
  const b = basicClean(CONTINUATION);
  assert.equal(b.isContinuation, true);
  assert.equal(b.marker, 'Ab12Cd34Ef56');
  assert.doesNotMatch(b.text, /This session is being continued|Summary/);
  assert.match(b.text, /^Continue la tâche/);
  assert.equal(basicClean(CONTINUATION + '\n\nEt ajoute un test.').text, 'Et ajoute un test.');
});

// ── empreintes et clés ────────────────────────────────────────────────────────────────────────────────────────────────

test('norm : NFC, CRLF, blancs regroupés', () => {
  assert.equal(norm('  e\u0301té\r\n  ok\t\t!  '), 'été ok !');
  assert.equal(norm(null), '');
});

test('fpAssistant : ids des tool_use, sinon sha1 du texte normalisé', () => {
  assert.equal(fpAssistant({ text: 'x', toolUses: [{ id: 'a' }, { id: 'b' }] }), 'A:a,b');
  const fp = fpAssistant({ text: 'Bonjour\r\n le monde ', toolUses: [] });
  assert.match(fp, /^T:[0-9a-f]{16}$/);
  assert.equal(fpAssistant({ text: 'Bonjour le monde', toolUses: [] }), fp);
});

test('requestKey : stable quand cache_control se déplace, qu\'un message system est inséré ou qu\'un tool_result est vidé', () => {
  const base = loadFixture('req-04').body.messages;
  const k0 = requestKey(canonicalize(base), MODEL);

  const moved = loadFixture('req-04').body.messages;
  delete moved.at(-1).content[0].cache_control;
  moved[0].content[0].cache_control = { type: 'ephemeral' };
  assert.equal(requestKey(canonicalize(moved), MODEL), k0, 'cache_control déplacé');

  const sys = loadFixture('req-04').body.messages.filter(m => m.role !== 'system');
  sys.splice(2, 0, { role: 'system', content: '<system-reminder>Todo list vide</system-reminder>' });
  assert.equal(requestKey(canonicalize(sys), MODEL), k0, 'message role:system déplacé');

  const cleared = loadFixture('req-04').body.messages;
  cleared.at(-1).content[0].content = '[Old tool result content cleared]';
  assert.equal(requestKey(canonicalize(cleared), MODEL), k0, 'tool_result vidé (micro-compactage)');
  assert.equal(fpAssistant(canonicalize(cleared)[1]), 'A:toolu_capture1');

  assert.notEqual(requestKey(canonicalize(base), 'claude-opus-5-5'), k0, 'autre modèle, autre génération');
  const other = loadFixture('req-04').body.messages;
  other.at(-1).content.push(text('et aussi calc.js'));
  assert.notEqual(requestKey(canonicalize(other), MODEL), k0);
});

test('requestKey : insensible aux blancs et CRLF du texte, sensible aux images', () => {
  const a = canonicalize([user(text('salut  le\r\nmonde'))]);
  const b = canonicalize([user(text('salut le monde '))]);
  assert.equal(requestKey(a, MODEL), requestKey(b, MODEL));
  const img = canonicalize([user(text('salut le monde'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })]);
  assert.notEqual(requestKey(img, MODEL), requestKey(b, MODEL));
});

// ── computeDelta ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('delta new : 1re requête sans conversation (req-03)', () => {
  const turns = canonicalize(loadFixture('req-03').body.messages);
  const d = computeDelta(null, turns, MODEL);
  assert.equal(d.kind, 'new');
  assert.equal(d.userTurns.length, 1);
  assert.equal(d.userTurns[0].text, ASK);
  assert.equal(d.key, requestKey(turns, MODEL));
  assert.equal(computeDelta(mkConv({ chatId: null }), turns, MODEL).kind, 'new', 'conversation sans chat FS');
});

test('delta append : req-03 puis req-04 (résultat du Read émis)', () => {
  const turns = canonicalize(loadFixture('req-04').body.messages);
  const d = computeDelta(mkConv({ lastFp: 'A:toolu_capture1', anchors: [['A:toolu_capture1', 1, '', null]] }), turns, MODEL);
  assert.equal(d.kind, 'append');
  assert.equal(d.userTurns.length, 1);
  assert.deepEqual(d.userTurns[0].results.map(r => r.id), ['toolu_capture1']);
  assert.equal(d.foreignAssistantText, undefined);
});

test('delta replay et join : même requête (I5)', () => {
  const turns = canonicalize(loadFixture('req-04').body.messages);
  const key = requestKey(turns, MODEL);
  const replay = computeDelta(mkConv({ lastFp: 'A:autre', lastReplies: [{ key, snapshot: {} }] }), turns, MODEL);
  assert.equal(replay.kind, 'replay');
  assert.deepEqual(replay.userTurns, []);
  const conv = mkConv({ lastFp: 'A:toolu_capture1' });
  conv.fs.inflightKey = key;
  assert.equal(computeDelta(conv, turns, MODEL).kind, 'join');
  assert.equal(computeDelta(conv, turns, 'claude-opus-5-5').kind, 'append', 'autre modèle : pas la même requête');
});

test('delta post_compact : sans message récent conservé', () => {
  const turns = canonicalize([user(text(CONTINUATION))]);
  const d = computeDelta(mkConv({ lastFp: 'A:toolu_x' }), turns, MODEL);
  assert.equal(d.kind, 'post_compact');
  assert.equal(d.userTurns.length, 1);
  assert.equal(d.userTurns[0].isContinuation, true);
  assert.equal(d.userTurns[0].marker, 'Ab12Cd34Ef56');
  assert.doesNotMatch(d.userTurns[0].text, /This session is being continued/);
  assert.equal(computeDelta(null, turns, MODEL).kind, 'post_compact', 'même sans conversation retrouvée');
});

test('delta post_compact : avec messages récents conservés', () => {
  const turns = canonicalize([user(text(CONTINUATION)), asst('Voilà le correctif.'), user(text('et maintenant les tests'))]);
  const lastFp = fpAssistant(turns[1]);
  const d = computeDelta(mkConv({ lastFp, lastText: 'Voilà le correctif.' }), turns, MODEL);
  assert.equal(d.kind, 'post_compact');
  assert.deepEqual(d.userTurns.map(u => u.text), ['et maintenant les tests']);
});

test('delta rewind : retour vers une ancre ancienne', () => {
  const r1 = asst('Première réponse.'), r2 = asst('Deuxième réponse.');
  const fp1 = fpAssistant(canonicalize([r1])[0]), fp2 = fpAssistant(canonicalize([r2])[0]);
  const conv = mkConv({ lastFp: fp2, lastText: 'Deuxième réponse.', anchors: [[fp1, 1, 'Première réponse.', null], [fp2, 2, 'Deuxième réponse.', null]] });
  const turns = canonicalize([user(text('q1')), r1, user(text('autre question'))]);
  const d = computeDelta(conv, turns, MODEL);
  assert.equal(d.kind, 'rewind');
  assert.equal(d.anchorIndex, 0);
  assert.deepEqual(d.userTurns.map(u => u.text), ['autre question']);
});

test('delta rewind -1 : retour au tout début ; chat sans réponse émise → append', () => {
  const turns = canonicalize([user(text('nouvelle première question'))]);
  const d = computeDelta(mkConv({ lastFp: 'T:abc', anchors: [['T:abc', 1, 'x', null]] }), turns, MODEL);
  assert.equal(d.kind, 'rewind');
  assert.equal(d.anchorIndex, -1);
  assert.equal(computeDelta(mkConv(), turns, MODEL).kind, 'append', 'rien à annuler : même chat');
});

test('delta unknown : historique qui ne vient pas de la passerelle', () => {
  const turns = canonicalize(loadFixture('req-04').body.messages);
  assert.equal(computeDelta(null, turns, MODEL).kind, 'unknown');
  const d = computeDelta(mkConv({ lastFp: 'A:toolu_autre', lastText: 'rien à voir' }), turns, MODEL);
  assert.equal(d.kind, 'unknown');
  assert.equal(d.userTurns.length, 1);
});

test('delta : texte partiel après Échap → append', () => {
  const conv = mkConv({ lastFp: 'A:toolu_1', lastText: 'Je vais lire le fichier hello.txt puis le corriger.' });
  const turns = canonicalize([user(text('q')), asst('Je vais lire le fichier'), user(text('[Request interrupted by user]')), user(text('non, lis calc.js'))]);
  const d = computeDelta(conv, turns, MODEL);
  assert.equal(d.kind, 'append');
  assert.equal(d.userTurns.length, 1);
  assert.equal(d.userTurns[0].interrupted, true);
  assert.equal(d.userTurns[0].text, 'non, lis calc.js');
  const empty = canonicalize([user(text('q')), asst(''), user(text('x'))]);
  assert.notEqual(computeDelta(mkConv({ lastFp: 'A:toolu_1', lastText: 'abc' }), empty, MODEL).kind, 'append', 'texte vide : pas une réponse partielle');
});

test('delta : réponse jamais reçue (Échap dans le terminal, sans texte partiel) → append, demande déjà reçue par FS retirée', () => {
  const r1 = asst('Réponse un.');
  const fp1 = fpAssistant(canonicalize([r1])[0]);
  // lastFp = réponse un (inchangé par l'abandon) ; undelivered garde la demande que FS a déjà
  const conv = mkConv({ lastFp: fp1, lastText: 'Réponse un.', anchors: [[fp1, 1, 'Réponse un.', null]],
    undelivered: { fp: fp1, text: 'deuxième demande', partial: 'Je réfléchis' } });
  const turns = canonicalize([user(text('q1')), r1, user(text('deuxième demande')), user(text('[Request interrupted by user]')), user(text('troisième'))]);
  const d = computeDelta(conv, turns, MODEL);
  assert.equal(d.kind, 'append');
  assert.equal(d.userTurns[0].text, 'troisième');
  assert.equal(d.userTurns[0].interrupted, true);
  // même cas, mais la réponse est finie sans abonné : lastFp est la réponse jamais reçue, ce n'est pas un retour en arrière
  const conv2 = mkConv({ lastFp: 'T:jamais-recue', anchors: [[fp1, 1, '', null], ['T:jamais-recue', 2, '', null]], undelivered: { fp: fp1, text: 'deuxième demande', partial: '' } });
  assert.equal(computeDelta(conv2, turns, MODEL).kind, 'append');
  assert.equal(computeDelta({ ...conv2, undelivered: null }, turns, MODEL).kind, 'rewind', 'sans undelivered : vrai retour en arrière');
  // 1er tour (aucune réponse avant)
  const first = canonicalize([user(text('q1')), user(text('[Request interrupted by user]')), user(text('autre'))]);
  const d3 = computeDelta(mkConv({ lastFp: 'T:x', anchors: [['T:x', 1, '', null]], undelivered: { fp: null, text: 'q1', partial: '' } }), first, MODEL);
  assert.equal(d3.kind, 'append');
  assert.equal(d3.userTurns[0].text, 'autre');
  // variante SDK : le texte partiel est gardé dans l'historique
  const sdk = canonicalize([user(text('q1')), r1, user(text('deuxième demande')), asst('Je réfléchis'), user(text('[Request interrupted by user]')), user(text('troisième'))]);
  const d4 = computeDelta(conv, sdk, MODEL);
  assert.equal(d4.kind, 'append');
  assert.equal(d4.userTurns[0].text, 'troisième');
});

test('delta replay : seulement la dernière réponse émise (après /rewind, même texte → plus un rejeu)', () => {
  const turns = canonicalize([user(text('lance les tests'))]);
  const key = requestKey(turns, MODEL);
  const old = { key, snapshot: {}, fp: 'A:toolu_7' };
  const conv = mkConv({ lastFp: 'T:plus-recente', anchors: [['A:toolu_7', 1, '', null], ['T:plus-recente', 2, '', null]],
    lastReplies: [old, { key: 'autre', snapshot: {}, fp: 'T:plus-recente' }] });
  assert.equal(computeDelta(conv, turns, MODEL).kind, 'rewind');
  assert.equal(computeDelta(mkConv({ lastFp: 'A:toolu_7', lastReplies: [old] }), turns, MODEL).kind, 'replay', 'dernière émise : réessai rejoué');
  assert.equal(computeDelta(mkConv({ lastFp: 'T:autre', lastReplies: [old] }), turns, MODEL).kind, 'rewind', 'empreinte différente : périmée');
});

test('delta : réponse étrangère après la nôtre → append avec son texte en note', () => {
  const ours = asst('', [['toolu_ours', 'Read', { file_path: '/p/a' }]]);
  const turns = canonicalize([user(text('q')), ours, user(result('toolu_ours', 'contenu')), asst('Réponse écrite ailleurs.'), user(text('suite'))]);
  const d = computeDelta(mkConv({ lastFp: 'A:toolu_ours' }), turns, MODEL);
  assert.equal(d.kind, 'append');
  assert.equal(d.foreignAssistantText, 'Réponse écrite ailleurs.');
  assert.equal(d.userTurns.length, 2);
  assert.deepEqual(d.userTurns[0].results.map(r => r.id), ['toolu_ours']);
  assert.equal(d.userTurns[1].text, 'suite');
});
