// Tests de bout en bout de la passerelle Claude Code (src/gateway/index.js + fsturn.js), scénarios (a) à (t) du § 5.1.
// Vrai serveur HTTP sur 127.0.0.1 port 0, requêtes de Claude Code construites à partir des captures réelles (req-03),
// faux France Student injecté (test/gateway-helpers.mjs) : aucun appel réseau externe.
// Chaque scénario se termine par assertClean strict sur tous les corps envoyés au faux FS (I1) et par la vérification d'I3.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpHome, loadFixture, parseSse, fakeFs, deferred } from './gateway-helpers.mjs';   // pose FS_CLI_HOME avant tout import de src/

const { startGateway } = await import('../src/gateway/index.js');
const { assertClean } = await import('../src/gateway/outbound.js');
const { decodeId } = await import('../src/gateway/ids.js');
const { estimateTokens } = await import('../src/gateway/anthropic.js');
const { MESSAGES, limitMessage, CLARIFY } = await import('../src/gateway/recover.js');
const { SUBAGENT_REFUSAL, WEB_SEARCH_OFF, SIDE_QUESTION_OFF } = await import('../src/gateway/background.js');
const { LOCAL } = await import('../src/gateway/toolmap.js');

const BASE = loadFixture('req-03');
const FIRST = BASE.body.messages[0];                                     // 1er message réel (rappel de contexte + demande)
const FAST = { pingMs: 30, headerWaitMs: 5000, idleMs: 60, reattachDelays: [0, 0, 0] };
const HELLO = 'C:\\proj\\hello.txt';

// ── Aides ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = r => ({ role: 'assistant', content: r.sse ? r.sse.message.content : r.json.content });
const results = (...rs) => ({ role: 'user', content: rs.map(([id, content, isError]) => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) })) });
const readCall = (callId, p = 'hello.txt') => ({ callId, name: 'read_file', arguments: { path: p } });

/** Requête Claude Code : system et tools de la capture req-03, messages fournis. */
function ccReq(messages, { session = 'sess-a', agentId = null, model = null, stream = true, body = {} } = {}) {
  const b = { ...structuredClone(BASE.body), messages, stream, ...(model ? { model } : {}), ...body };
  return { body: b, headers: { 'x-claude-code-session-id': session, ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}) } };
}

/** Requête HTTP vers la passerelle ; → { status, headers, text, json, sse } (sse analysé strictement). */
function call(gw, r, { method = 'POST', path: p = '/v1/messages?beta=true' } = {}) {
  return new Promise((resolve, reject) => {
    const data = r?.body == null ? null : Buffer.from(JSON.stringify(r.body));
    const headers = { authorization: `Bearer ${gw.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(r?.headers || {}) };
    const req = http.request({ host: '127.0.0.1', port: gw.port, method, path: p, headers }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        const sse = /event-stream/.test(res.headers['content-type'] || '') ? parseSse(text) : null;
        resolve({ status: res.statusCode, headers: res.headers, text, json, sse });
      });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

/** Lit le flux jusqu'à ce que until(texte reçu) soit vrai, puis coupe la connexion (Échap dans Claude Code). → texte SSE reçu */
function callUntil(gw, r, until) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(r.body));
    const req = http.request({ host: '127.0.0.1', port: gw.port, method: 'POST', path: '/v1/messages?beta=true',
      headers: { authorization: `Bearer ${gw.token}`, 'content-type': 'application/json', 'content-length': data.length, ...r.headers } }, res => {
      let text = '';
      res.on('data', c => { text += c; if (until(text)) { req.destroy(); resolve(text); } });
      res.on('end', () => resolve(text));
      res.on('error', () => {});
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end(data);
  });
}

const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('condition jamais atteinte'); await tick(5); }
}

/**
 * Passerelle de test sur un faux FS. Chaque appel stream mémorise les appels que FS attend VRAIMENT avant l'envoi
 * (dernier message assistant du chat avec toolCalls) : c'est la référence de la vérification d'I3.
 */
async function setup(t, script = {}, opts = {}, { fake = null, storeDir = null } = {}) {
  fake ||= fakeFs(script);
  if (!fake.expected) {
    fake.expected = [];
    const orig = fake.deps.stream;
    fake.deps.stream = o => {
      const last = o?.chatId ? fake.chats.get(o.chatId)?.messages.at(-1) : null;
      fake.expected.push(last?.role === 'assistant' ? (last.toolCalls || []).map(c => c.callId) : []);
      return orig(o);
    };
  }
  const dir = storeDir || tmpHome({ prefix: 'fscli-gwflow-' });
  const lines = [];
  const gw = await startGateway({
    port: 0, deps: fake.deps, log: { line: o => lines.push(o), debug() {} },
    opts: { storeDir: dir, agentsFile: path.join(dir, 'agents.json'), defaultAgentId: -2003, timing: FAST, cwd: 'C:\\proj', ...opts },
  });
  t.after(() => gw.close());
  return { fake, gw, dir, lines };
}

/** I1 (assertClean strict sur chaque corps envoyé) et I3 (chaque appel attendu reçoit exactement une réponse, rien d'autre). */
function checkInvariants(fake) {
  fake.sent.forEach((s, i) => {
    assertClean(structuredClone(s), { strict: true });
    if (!s.toolResults) return;
    const ids = s.toolResults.map(r => r.callId);
    assert.equal(new Set(ids).size, ids.length, `I3 : réponse en double dans l'envoi ${i}`);
    assert.deepEqual([...ids].sort(), [...fake.expected[i]].sort(), `I3 : envoi ${i}`);
    for (const id of ids) assert.equal(decodeId(id), null, `I3 : id synthétique ${id} dans l'envoi ${i}`);
  });
  assert.deepEqual(fake.errors, [], 'tours du faux FS épuisés');
}

// ── (a) à (c) : tours normaux, ordre, déduplication ───────────────────────────────────────────────────────────────────

test('(a) lecture → résultat → réponse finale : 2 POST, le 2e ne contient que toolResults', async t => {
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'contenu de test\n' },
    turns: [{ text: 'Je lis le fichier. ', toolCalls: [readCall('call_1')] }, 'Le fichier contient « contenu de test ».'],
  });
  const r1 = await call(gw, ccReq([FIRST]));
  assert.equal(r1.status, 200);
  assert.equal(r1.sse.message.stop_reason, 'tool_use');
  assert.equal(r1.sse.text, 'Je lis le fichier. ');
  const [use] = r1.sse.toolUses;
  assert.equal(use.name, 'Read');
  assert.deepEqual(use.input, { file_path: HELLO });
  assert.deepEqual(decodeId(use.id), { kind: 'f', chatId: 'chat-1', callId: 'call_1' });
  assert.equal(r1.sse.message.usage.input_tokens, estimateTokens(ccReq([FIRST]).body));

  const req2 = ccReq([FIRST, asst(r1), results([use.id, '1\tcontenu de test\n2\t'])]);
  const r2 = await call(gw, req2);
  assert.equal(r2.sse.text, 'Le fichier contient « contenu de test ».');
  assert.equal(r2.sse.message.stop_reason, 'end_turn');

  assert.equal(fake.sent.length, 2);
  const [s1, s2] = fake.sent;
  assert.ok(s1.register && s1.chatId === null);
  assert.match(s1.content, /^\[[0-9a-f]{4}·cc\] Contexte : dossier de travail C:\\proj/);
  assert.match(s1.content, /lis hello\.txt et dis-moi ce qu'il contient$/);
  assert.equal(s2.chatId, 'chat-1');
  assert.equal(s2.content, undefined);
  assert.deepEqual(s2.toolResults, [{ callId: 'call_1', output: '1: contenu de test\n2: ', isError: false }]);
  checkInvariants(fake);
});

test('(b) 3 appels → 1 POST avec les 3 résultats dans l\'ordre des appels', async t => {
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'x\n', 'C:\\proj\\a.txt': 'y\n' },
    turns: [{ text: 'Trois actions. ', toolCalls: [readCall('call_1'), { callId: 'call_2', name: 'search_files', arguments: { query: 'foo' } },
      { callId: 'call_3', name: 'run_command', arguments: { command: 'npm test' } }] }, 'Fini.'],
  });
  const r1 = await call(gw, ccReq([user('fais trois choses')]));
  assert.deepEqual(r1.sse.toolUses.map(u => u.name), ['Read', 'Grep', 'Bash']);
  const [a, b, c] = r1.sse.toolUses.map(u => u.id);
  // Claude Code renvoie les résultats dans un ordre quelconque : FS les reçoit dans l'ordre de ses appels
  await call(gw, ccReq([user('fais trois choses'), asst(r1), results([c, 'ok'], [a, '1\tx'], [b, 'No matches found'])]));
  assert.equal(fake.sent.length, 2);
  assert.deepEqual(fake.sent[1].toolResults.map(r => r.callId), ['call_1', 'call_2', 'call_3']);
  assert.equal(fake.sent[1].toolResults[1].output, 'Aucun résultat.');
  checkInvariants(fake);
});

test('(c) même requête en parallèle, puis à la suite, puis en stream:false → un seul POST', async t => {
  const hold = deferred();
  const { fake, gw } = await setup(t, { turns: [{ text: 'Bonjour à toi !', hold: hold.promise }] });
  const req = ccReq([user('salut')]);
  const p1 = call(gw, req);
  await until(() => fake.sent.length === 1);
  const p2 = call(gw, req);                                             // réessai pendant la génération : il la rejoint
  await tick(30);
  hold.open();
  const [r1, r2] = await Promise.all([p1, p2]);
  const r3 = await call(gw, req);                                       // réessai après la fin : rejoué depuis le cache
  const r4 = await call(gw, { ...req, body: { ...req.body, stream: false } });   // repli non-stream de Claude Code
  for (const r of [r1, r2, r3]) assert.equal(r.sse.text, 'Bonjour à toi !');
  assert.equal(r4.json.type, 'message');
  assert.equal(r4.json.content[0].text, 'Bonjour à toi !');
  assert.equal(r3.sse.message.id, r1.sse.message.id);
  assert.equal(fake.sent.length, 1);
  checkInvariants(fake);
});

// ── (d) à (g) : coupures, rattachement, vérification de l'état ───────────────────────────────────────────────────────

test('(d) coupure après acceptation → resume avec Last-Event-ID, jamais un 2e POST, texte non dupliqué', async t => {
  const { fake, gw } = await setup(t, { turns: [{ text: 'un deux trois quatre cinq six', cut: 2 }] });
  const r = await call(gw, ccReq([user('compte')]));
  assert.equal(r.sse.text, 'un deux trois quatre cinq six');
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.calls.resume.length, 1);
  assert.deepEqual(fake.calls.resume[0], { chatId: 'chat-1', lastEventId: '2' });
  checkInvariants(fake);
});

test('(e) resume impossible, le chat montre un assistant avec toolCalls → tool_use émis (suffixe de texte seulement)', async t => {
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'x\n' },
    resume: 'fail',
    turns: [{ text: 'Je regarde le fichier. ', toolCalls: [readCall('call_9')], cut: 1 }],
  });
  const r = await call(gw, ccReq([user('regarde hello')]));
  assert.equal(r.sse.text, 'Je regarde le fichier. ');
  assert.equal(r.sse.toolUses.length, 1);
  assert.deepEqual(decodeId(r.sse.toolUses[0].id), { kind: 'f', chatId: 'chat-1', callId: 'call_9' });
  assert.equal(fake.calls.resume.length, 3);
  assert.equal(fake.calls.fetchChat.length, 1);
  assert.equal(fake.sent.length, 1);
  checkInvariants(fake);
});

test('(f) le chat se termine par un message user orphelin → « Continue » une seule fois', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: '', sseError: { code: 'GENERATION_INTERRUPTED' } }, 'Suite et fin.'],
  });
  const r = await call(gw, ccReq([user('écris la suite')]));
  assert.equal(r.sse.text, 'Suite et fin.');
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].content, MESSAGES.continueCut);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.ok(fake.sent[1].clientTools?.length);
  checkInvariants(fake);
});

test('(g) 409 sur toolResults → reconcile → résultats envoyés en content', async t => {
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'x\n' },
    turns: [{ text: 'Je lis. ', toolCalls: [readCall('call_1')] }, { fail: 409 }, 'Réponse finale.'],
    chats: { 'chat-1': { id: 'chat-1', chatMessages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'déjà répondu' }] } },
  });
  const m1 = user('lis hello');
  const r1 = await call(gw, ccReq([m1]));
  const r2 = await call(gw, ccReq([m1, asst(r1), results([r1.sse.toolUses[0].id, '1\tcontenu de test'])]));
  assert.equal(r2.sse.text, 'Réponse finale.');
  assert.equal(fake.sent.length, 3);
  assert.ok(fake.sent[1].toolResults);
  assert.equal(fake.sent[2].toolResults, undefined);
  assert.match(fake.sent[2].content, /Résultats des actions précédentes[\s\S]*1: contenu de test/);
  assert.equal(fake.calls.fetchChat.length, 1);
  checkInvariants(fake);
});

// ── (h) à (k) : refus GPT, quota, session, mode texte ────────────────────────────────────────────────────────────────

const REFUSAL = 'Je ne peux pas accéder à tes fichiers ni exécuter de commandes sur ton PC.';

test('(h) refus GPT au 1er tour → chat « bare » ; texte du refus jamais montré', async t => {
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'x\n' },
    turns: [REFUSAL, { text: 'Je lis. ', toolCalls: [readCall('call_1')] }],
  });
  const r = await call(gw, ccReq([user('lis hello.txt')], { model: 'gpt-6-astra' }));
  assert.equal(r.sse.toolUses.length, 1);
  assert.equal(r.sse.text, 'Je lis. ');
  assert.ok(!r.text.includes('accéder à tes fichiers'));
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.registered.length, 2);
  assert.equal(fake.sent[1].chatId, null);
  assert.match(fake.sent[1].content, /^\[[0-9a-f]{4}·cc\] lis hello\.txt$/);
  assert.equal(fake.sent[1].agentId, -1004);
  assert.equal(decodeId(r.sse.toolUses[0].id).chatId, 'chat-2');
  checkInvariants(fake);
});

test('(h) refus GPT au 3e tour → CLARIFY dans le même chat, puis Claude Sonnet', async t => {
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'x\n' },
    turns: ['Bonjour, que veux-tu faire ?', 'D\'accord, dis-moi quel fichier.', REFUSAL, REFUSAL, { text: 'Je lis. ', toolCalls: [readCall('call_1')] }],
  });
  const opt = { model: 'gpt-6-astra' };
  const m = [user('salut')];
  const r1 = await call(gw, ccReq(m, opt));
  m.push(asst(r1), user('aide-moi'));
  const r2 = await call(gw, ccReq(m, opt));
  m.push(asst(r2), user('lis hello.txt'));
  const r3 = await call(gw, ccReq(m, opt));
  assert.equal(fake.sent.length, 5);
  assert.equal(fake.registered.length, 1);
  assert.equal(fake.sent[3].content, CLARIFY);
  assert.equal(fake.sent[3].chatId, 'chat-1');
  assert.equal(fake.sent[4].agentId, -2003);
  assert.equal(fake.sent[4].content, 'lis hello.txt');
  assert.ok(r3.sse.text.startsWith('(GPT a refusé d\'utiliser les outils : la demande est passée à Claude Sonnet 5.5.)'));
  assert.ok(!r3.text.includes('accéder à tes fichiers'));
  assert.equal(r3.sse.toolUses.length, 1);
  checkInvariants(fake);
});

test('(i) limite du jour → emprunt d\'une conversation existante, avec avertissement', async t => {
  const { fake, gw } = await setup(t, { created: 49, turns: ['Réponse A.', 'Réponse B.'] });
  await call(gw, ccReq([user('tâche A')], { session: 'sess-a' }));
  fake.advance(11 * 60_000);                                            // A inactive depuis plus de 10 min : empruntable
  const r = await call(gw, ccReq([user('tâche B')], { session: 'sess-b' }));
  assert.equal(r.status, 200);
  assert.ok(r.sse.text.startsWith(MESSAGES.borrow));
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.equal(fake.sent[1].register, undefined);
  assert.match(fake.sent[1].content, /^\[Nouvelle tâche, sans rapport avec ce qui précède\.\]\n\[[0-9a-f]{4}·cc\] Contexte/);
  assert.match(fake.sent[1].content, /tâche B$/);
  checkInvariants(fake);
});

test('(i) limite du jour et rien d\'empruntable → 400 en français avec l\'heure de remise à zéro', async t => {
  const { fake, gw } = await setup(t, { created: 50, turns: [] });
  const r = await call(gw, ccReq([user('tâche')]));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, 'invalid_request_error');
  assert.equal(r.json.error.message, limitMessage(fake.quota().resetText));
  assert.match(r.json.error.message, /remise à zéro .*\d/);
  assert.equal(fake.sent.length, 0);
  checkInvariants(fake);
});

test('(j) 401 de France Student → 400 « fs-cli --login » (jamais 401)', async t => {
  const { fake, gw } = await setup(t, { turns: [{ fail: 'auth' }] });
  const r = await call(gw, ccReq([user('bonjour')]));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, 'invalid_request_error');
  assert.match(r.json.error.message, /fs-cli --login/);
  checkInvariants(fake);
});

test('(k) NATIVE_UNSUPPORTED → même envoi sans clientTools, réponse en texte seul avec la note', async t => {
  const { fake, gw } = await setup(t, { turns: [{ fail: 'native' }, 'Réponse en texte.'] });
  const r = await call(gw, ccReq([user('bonjour')]));
  assert.equal(fake.sent.length, 2);
  assert.ok(fake.sent[0].clientTools?.length);
  assert.equal(fake.sent[1].clientTools, undefined);
  assert.equal(fake.sent[1].toolResults, undefined);
  assert.equal(fake.sent[1].content, fake.sent[0].content);
  assert.ok(r.sse.text.startsWith(MESSAGES.nativeOff));
  assert.ok(r.sse.text.endsWith('Réponse en texte.'));
  checkInvariants(fake);
});

// ── (l) et (m) : documents et micro-tour local ───────────────────────────────────────────────────────────────────────

test('(l) createDocument → Write synthétique → fin locale sans FS → note au prochain envoi', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: 'Voici le document demandé.', documents: [{ title: 'notes.md', kind: 'text', content: '# Notes\n' }] }, 'Avec plaisir.'],
  });
  const opt = { model: 'gpt-6-astra' };
  const m = [user('écris des notes')];
  const r1 = await call(gw, ccReq(m, opt));
  const [w] = r1.sse.toolUses;
  assert.equal(w.name, 'Write');
  assert.deepEqual(w.input, { file_path: 'C:\\proj\\notes.md', content: '# Notes\n' });
  assert.equal(decodeId(w.id).kind, 's');
  m.push(asst(r1), results([w.id, 'File created successfully at: C:\\proj\\notes.md']));
  const r2 = await call(gw, ccReq(m, opt));
  assert.equal(r2.sse.text, 'C\'est fait : notes.md écrit.');
  assert.equal(fake.sent.length, 1);                                    // fin de tour locale : 0 appel FS
  m.push(asst(r2), user('merci'));
  await call(gw, ccReq(m, opt));
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].toolResults, undefined);
  assert.match(fake.sent[1].content, /Ton document « notes\.md » a été écrit dans notes\.md\.[\s\S]*merci$/);
  checkInvariants(fake);
});

test('(l2) site du panneau sans nom : écrit dans le dossier de la demande ; écriture refusée → jamais « C\'est fait »', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: 'J’ai créé le site dans le panneau.', documents: [{ title: 'Astra — Site de démonstration', kind: 'code', content: '<!DOCTYPE html><html></html>' }] }],
  });
  const opt = { model: 'gpt-6-astra' };
  const m = [user('ok vasy dans le dossier C:\\sites\\astra dev moi un site pour prouver que tu marche')];
  const r1 = await call(gw, ccReq(m, opt));
  const [w] = r1.sse.toolUses;
  assert.equal(w.input.file_path, 'C:\\sites\\astra\\index.html');
  m.push(asst(r1), results([w.id, 'Claude requested permissions to write to C:\\sites\\astra\\index.html, but you haven\'t granted it yet.', true]));
  const r2 = await call(gw, ccReq(m, opt));
  assert.doesNotMatch(r2.sse.text, /C'est fait/);
  assert.match(r2.sse.text, /Fichier non écrit \(écriture refusée\) : C:\\sites\\astra\\index\.html/);
  assert.equal(fake.sent.length, 1);
  checkInvariants(fake);
});

test('(m) « File has not been read yet » → micro-tour local [Read, Edit] → un seul résultat envoyé à FS', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: 'Je corrige. ', toolCalls: [{ callId: 'call_1', name: 'edit_file', arguments: { path: 'a.txt', old_text: 'x', new_text: 'y' } }] }, 'Corrigé.'],
  });
  const m = [user('corrige a.txt')];
  const r1 = await call(gw, ccReq(m));
  const [edit] = r1.sse.toolUses;
  assert.equal(edit.name, 'Edit');
  m.push(asst(r1), results([edit.id, '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>', true]));
  const r2 = await call(gw, ccReq(m));
  assert.equal(fake.sent.length, 1);                                    // micro-tour : aucun appel FS
  assert.deepEqual(r2.sse.toolUses.map(u => u.name), ['Read', 'Edit']);
  const [read, edit2] = r2.sse.toolUses;
  assert.equal(decodeId(read.id).kind, 's');
  assert.deepEqual(decodeId(edit2.id), { kind: 'r', chatId: 'chat-1', callId: 'call_1', n: 1 });
  assert.deepEqual(edit2.input, edit.input);
  m.push(asst(r2), results([read.id, '1\tx'], [edit2.id, 'The file C:\\proj\\a.txt has been updated successfully.']));
  const r3 = await call(gw, ccReq(m));
  assert.equal(r3.sse.text, 'Corrigé.');
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].toolResults.length, 1);
  assert.equal(fake.sent[1].toolResults[0].callId, 'call_1');
  assert.equal(fake.sent[1].toolResults[0].isError, false);
  assert.match(fake.sent[1].toolResults[0].output, /updated successfully/);
  checkInvariants(fake);
});

// ── (n) à (q) : fermeture du client, retour en arrière, compaction, redémarrage ──────────────────────────────────────

test('(n) fermeture du client → délai → cancelStream → message suivant : toolResults « interrompu » + content', async t => {
  const hold = deferred();
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'x\n' },
    turns: [{ chunks: ['Je regarde le fichier hello.txt maintenant, puis je te réponds. '], toolCalls: [readCall('call_1')], hold: hold.promise }, 'Compris.'],
  });
  const m1 = user('regarde hello.txt');
  const raw = await callUntil(gw, ccReq([m1]), s => /text_delta/.test(s));
  const partial = parseSse(raw, { partial: true }).text;
  assert.ok(partial.length > 0);
  await until(() => fake.calls.cancelStream.length === 1);
  assert.deepEqual(fake.calls.cancelStream[0], { chatId: 'chat-1' });
  await tick(20);
  const r2 = await call(gw, ccReq([m1, { role: 'assistant', content: [{ type: 'text', text: partial }] }, user('[Request interrupted by user]'), user('lis plutôt a.txt')]));
  assert.equal(r2.sse.text, 'Compris.');
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.deepEqual(fake.sent[1].toolResults, [{ callId: 'call_1', output: LOCAL.notRun, isError: true }]);
  assert.match(fake.sent[1].content, /lis plutôt a\.txt/);
  assert.match(fake.sent[1].content, /interrompu/);
  checkInvariants(fake);
});

test('(o) retour en arrière : quota confortable → nouveau chat avec récapitulatif', async t => {
  const { fake, gw } = await setup(t, { turns: ['Réponse un.', 'Réponse deux.', 'Réponse trois.'] });
  const u1 = user('première demande'), r1 = await call(gw, ccReq([u1]));
  await call(gw, ccReq([u1, asst(r1), user('deuxième demande')]));
  const r3 = await call(gw, ccReq([u1, asst(r1), user('demande corrigée')]));
  assert.equal(r3.sse.text, 'Réponse trois.');
  assert.equal(fake.sent.length, 3);
  assert.equal(fake.sent[2].chatId, null);
  assert.ok(fake.sent[2].register);
  assert.match(fake.sent[2].content, /Récapitulatif de notre conversation précédente[\s\S]*première demande[\s\S]*Réponse un\.[\s\S]*demande corrigée$/);
  assert.ok(!fake.sent[2].content.includes('deuxième demande'));
  checkInvariants(fake);
});

test('(o) retour en arrière : quota bas → note dans le même chat', async t => {
  const { fake, gw } = await setup(t, { created: 45, turns: ['Réponse un.', 'Réponse deux.', 'Réponse trois.'] });
  const u1 = user('première demande'), r1 = await call(gw, ccReq([u1]));
  await call(gw, ccReq([u1, asst(r1), user('deuxième demande')]));
  await call(gw, ccReq([u1, asst(r1), user('demande corrigée')]));
  assert.equal(fake.registered.length, 1);
  assert.equal(fake.sent[2].chatId, 'chat-1');
  assert.match(fake.sent[2].content, /^\[Retour en arrière : l'utilisateur a annulé tout ce qui suit ta réponse « Réponse un\. »/);
  assert.match(fake.sent[2].content, /demande corrigée$/);
  checkInvariants(fake);
});

test('(p) /compact → 0 appel FS, résumé avec marqueur ; requête suivante retrouvée par le marqueur → même chat', async t => {
  const { fake, gw } = await setup(t, { turns: ['Réponse un.', 'On continue.'] });
  const u1 = user('première demande'), r1 = await call(gw, ccReq([u1]));
  const c = await call(gw, ccReq([u1, asst(r1), user('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far.')]));
  assert.equal(fake.sent.length, 1);
  const summary = c.sse.text;
  const marker = /\[fs-gw:([A-Za-z0-9]{12})\]/.exec(summary);
  assert.ok(marker, 'marqueur dans le résumé');
  assert.match(summary, /^<analysis>[\s\S]*<summary>[\s\S]*première demande[\s\S]*<\/summary>$/);
  const cont = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary.`;
  const r2 = await call(gw, ccReq([user(cont)], { session: 'sess-autre' }));
  assert.equal(r2.sse.text, 'On continue.');
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.equal(fake.sent[1].register, undefined);
  assert.equal(fake.sent[1].content, 'Continue la tâche en cours là où tu t\'es arrêté, sans poser de question.');
  checkInvariants(fake);
});

test('(q) redémarrage (même dossier, autre session) → même chat retrouvé par l\'ancre, avec reconcile', async t => {
  const fake = fakeFs({ files: { [HELLO]: 'x\n' }, turns: [{ text: 'Je lis. ', toolCalls: [readCall('call_1')] }, 'Fin.'] });
  const a = await setup(t, {}, {}, { fake });
  const m = [user('lis hello')];
  const r1 = await call(a.gw, ccReq(m));
  await a.gw.close();
  const b = await setup(t, {}, {}, { fake, storeDir: a.dir });
  m.push(asst(r1), results([r1.sse.toolUses[0].id, '1\tx']));
  const r2 = await call(b.gw, ccReq(m, { session: 'sess-nouvelle' }));
  assert.equal(r2.sse.text, 'Fin.');
  assert.equal(fake.calls.fetchChat.length, 1);
  assert.equal(fake.registered.length, 1);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.deepEqual(fake.sent[1].toolResults.map(x => x.callId), ['call_1']);
  checkInvariants(fake);
});

test('(q) redémarrage sans l\'état (autre dossier) → chat retrouvé par décodage des ids, avec reconcile', async t => {
  const fake = fakeFs({ files: { [HELLO]: 'x\n' }, turns: [{ text: 'Je lis. ', toolCalls: [readCall('call_1')] }, 'Fin.'] });
  const a = await setup(t, {}, {}, { fake });
  const m = [user('lis hello')];
  const r1 = await call(a.gw, ccReq(m));
  await a.gw.close();
  const b = await setup(t, {}, {}, { fake });                           // dossier neuf : ni index ni conversation
  m.push(asst(r1), results([r1.sse.toolUses[0].id, '1\tx']));
  const r2 = await call(b.gw, ccReq(m, { session: 'sess-nouvelle' }));
  assert.equal(r2.sse.text, 'Fin.');
  assert.equal(fake.calls.fetchChat.length, 1);
  assert.equal(fake.registered.length, 1);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.deepEqual(fake.sent[1].toolResults.map(x => x.callId), ['call_1']);
  checkInvariants(fake);
});

test('(q) redémarrage, le chat n\'attend plus rien (reconcile « idle ») → résultats envoyés en texte, sans toolResults', async t => {
  const fake = fakeFs({
    files: { [HELLO]: 'x\n' }, turns: [{ text: 'Je lis. ', toolCalls: [readCall('call_1')] }, 'Fin.'],
    chats: { 'chat-1': { id: 'chat-1', chatMessages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'déjà répondu' }] } },
  });
  const a = await setup(t, {}, {}, { fake });
  const m = [user('lis hello')];
  const r1 = await call(a.gw, ccReq(m));
  await a.gw.close();
  const b = await setup(t, {}, {}, { fake, storeDir: a.dir });
  m.push(asst(r1), results([r1.sse.toolUses[0].id, '1\tcontenu de test']));
  await call(b.gw, ccReq(m));
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].toolResults, undefined);
  assert.match(fake.sent[1].content, /Résultats des actions précédentes[\s\S]*1: contenu de test/);
  // I3 vu du chat simulé (réécrit par « chats ») : FS n'attend plus aucun appel
  fake.expected[1] = [];
  checkInvariants(fake);
});

// ── (r) à (t) : flux simultanés, économie, sous-agents ──────────────────────────────────────────────────────────────

test('(r) --fs-flux 1 : la 2e conversation attend son tour et reçoit des pings', async t => {
  const hold = deferred();
  const { fake, gw } = await setup(t, { turns: [{ text: 'Réponse A.', hold: hold.promise }, 'Réponse B.'] }, { flows: 1 });
  const pa = call(gw, ccReq([user('tâche A')], { session: 'sess-a' }));
  await until(() => fake.sent.length === 1);
  const pb = call(gw, ccReq([user('tâche B')], { session: 'sess-b' }));
  await tick(150);
  assert.equal(fake.sent.length, 1);                                    // B attend le flux
  hold.open();
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(ra.sse.text, 'Réponse A.');
  assert.equal(rb.sse.text, 'Réponse B.');
  assert.ok(rb.sse.pings >= 1, 'pings pendant l\'attente');
  assert.equal(fake.sent.length, 2);
  checkInvariants(fake);
});

test('(s) économie : toutes les requêtes d\'arrière-plan → 0 appel stream, 0 conversation', async t => {
  const { fake, gw } = await setup(t, { turns: [] });
  const fork = (text, extra = {}) => ccReq([user('lis hello.txt'), { role: 'assistant', content: [{ type: 'text', text: 'Fait.' }] }, user(text)], extra);
  const side = (text, body = {}) => ({ body: { model: 'claude-haiku-5-5', max_tokens: 512, stream: true, system: [{ type: 'text', text: 'x' }], tools: [], messages: [user(text)], ...body }, headers: { 'x-claude-code-session-id': 'sess-a' } });
  const title = loadFixture('req-02');
  const cases = [
    ['title', { body: title.body, headers: { 'x-claude-code-session-id': title.headers['x-claude-code-session-id'] } }, r => assert.equal(JSON.parse(r.sse.text).title, 'Lis hello.txt et dis-moi ce qu\'il')],
    ['compact', fork('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nRésume.'), r => assert.match(r.sse.text, /^<analysis>/)],
    ['suggestion', fork('[SUGGESTION MODE: suggest what the user might type next]'), r => assert.equal(r.sse.text, '')],
    ['away', fork('The user stepped away and is coming back. Summarize.'), r => assert.match(r.sse.text, /^Dernière étape : Fait\./)],
    ['agent_summary', fork('Describe your most recent action in 3-5 words'), r => assert.equal(r.sse.text, 'Travail en cours')],
    ['tool_summary', side('Tools completed:\nTool: Read\nInput: {"file_path":"C:\\\\proj\\\\a.txt"}\n\nLabel:'), r => assert.equal(r.sse.text, 'Lecture de a.txt')],
    ['probe', ccReq([user('quota')], { body: { max_tokens: 1 } }), r => assert.equal(r.sse.message.stop_reason, 'max_tokens')],
    ['web_fetch', side('Web page content:\n---\nBonjour le web\n---\n\nRésume la page.'), r => assert.match(r.sse.text, /Bonjour le web/)],
    ['bash_prefix', side('git status', { system: 'Detect command_injection_detected prefixes.' }), r => assert.equal(r.sse.text, 'none')],
    ['background_other', side('Bonjour'), r => assert.equal(r.sse.text, '')],
    ['web_search', side('Perform a web search for the query: météo', { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), r => assert.equal(r.sse.text, WEB_SEARCH_OFF)],
  ];
  for (const [name, req, check] of cases) {
    const r = await call(gw, req);
    assert.equal(r.status, 200, name);
    check(r);
  }
  const unknownProbe = await call(gw, ccReq([user('x')], { model: 'mystere-9', body: { max_tokens: 1 } }));
  assert.equal(unknownProbe.status, 404);
  assert.equal(unknownProbe.json.error.type, 'not_found_error');
  const ct = await call(gw, { body: BASE.body }, { path: '/v1/messages/count_tokens?beta=true' });
  assert.deepEqual(ct.json, { input_tokens: estimateTokens(BASE.body) });
  const models = await call(gw, null, { method: 'GET', path: '/v1/models?limit=1000' });
  assert.ok(models.json.data.some(m => m.id === 'claude-sonnet-5-5'));
  assert.ok(models.json.data.some(m => m.id.startsWith('claude-fs/') && m.id.endsWith('gpt-6-astra')));
  assert.equal(fake.calls.stream.length, 0);
  assert.equal(fake.registered.length, 0);
  checkInvariants(fake);
});

test('(t) sous-agents au-delà du plafond → réponse locale, 0 conversation de plus', async t => {
  const { fake, gw } = await setup(t, { turns: ['Réponse du sous-agent.'] }, { subagents: 1 });
  const r1 = await call(gw, ccReq([user('cherche les tests')], { agentId: 'agent-1' }));
  assert.equal(r1.sse.text, 'Réponse du sous-agent.');
  const r2 = await call(gw, ccReq([user('cherche la doc')], { agentId: 'agent-2' }));
  assert.equal(r2.sse.text, SUBAGENT_REFUSAL);
  assert.equal(r2.sse.message.stop_reason, 'end_turn');
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.registered.length, 1);
  checkInvariants(fake);
});

// ── Retours de relecture : Échap, /btw, compaction, rejeu, erreurs après acceptation, emprunt, mode texte ─────────────

const COMPACT = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far.';
const continuation = summary => `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary.`;
const SIDE = q => `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.\n\nIMPORTANT CONTEXT:\n- You are a separate, lightweight agent spawned to answer this one question\n\nSimply answer the question with the information you have.</system-reminder>\n\n${q}`;

test('(n-bis) Échap dans le terminal (texte partiel absent de l\'historique) → même chat, pas de récapitulatif, demande non renvoyée', async t => {
  const hold = deferred();
  const { fake, gw } = await setup(t, { turns: ['Réponse un.', { chunks: ['Je réfléchis à la deuxième demande. '], hold: hold.promise }, 'Compris.'] });
  const u1 = user('première demande');
  const r1 = await call(gw, ccReq([u1]));
  const m2 = user('deuxième demande');
  await callUntil(gw, ccReq([u1, asst(r1), m2]), s => /text_delta/.test(s));
  await until(() => fake.calls.cancelStream.length === 1);
  await tick(20);
  // Claude Code 2.1.207 (terminal) ne garde pas le bloc texte inachevé : [u1, A1, m2, interruption, nouveau message]
  const r3 = await call(gw, ccReq([u1, asst(r1), m2, user('[Request interrupted by user]'), user('troisième demande')]));
  assert.equal(r3.sse.text, 'Compris.');
  assert.equal(fake.sent.length, 3);
  assert.equal(fake.registered.length, 1, 'aucun nouveau chat FS');
  assert.equal(fake.sent[2].chatId, 'chat-1');
  assert.doesNotMatch(fake.sent[2].content, /Récapitulatif|deuxième demande/, 'FS a déjà la 2e demande');
  assert.match(fake.sent[2].content, /interrompu[\s\S]*troisième demande$/);
  checkInvariants(fake);
});

test('(n-ter) Échap au 1er tour, sans texte partiel → même chat, 1re demande non renvoyée', async t => {
  const hold = deferred();
  const { fake, gw } = await setup(t, { turns: [{ chunks: ['Je commence à peine. '], hold: hold.promise }, 'Compris.'] });
  const m1 = user('première demande');
  await callUntil(gw, ccReq([m1]), s => /text_delta/.test(s));
  await until(() => fake.calls.cancelStream.length === 1);
  await tick(20);
  const r2 = await call(gw, ccReq([m1, user('[Request interrupted by user]'), user('autre chose')]));
  assert.equal(r2.sse.text, 'Compris.');
  assert.equal(fake.registered.length, 1);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.doesNotMatch(fake.sent[1].content, /première demande/);
  assert.match(fake.sent[1].content, /autre chose$/);
  checkInvariants(fake);
});

test('(n-quater) réponse finie pendant les 8 s sans abonné (jamais reçue par Claude Code) → message suivant dans le même chat', async t => {
  const hold = deferred();
  const { fake, gw } = await setup(t, { turns: ['Réponse un.', { chunks: ['Réponse deux, ', 'jamais affichée.'], hold: hold.promise }, 'Compris.'] });
  const u1 = user('première demande');
  const r1 = await call(gw, ccReq([u1]));
  const m2 = user('deuxième demande');
  await callUntil(gw, ccReq([u1, asst(r1), m2]), s => /text_delta/.test(s));
  await tick(30);
  hold.open();                                                        // FS finit avant le délai de 8 s (idleMs)
  await until(() => gw.store.list()[0]?.turn === 2);
  await tick(80);
  assert.equal(fake.calls.cancelStream.length, 0);
  const r3 = await call(gw, ccReq([u1, asst(r1), m2, user('[Request interrupted by user]'), user('troisième demande')]));
  assert.equal(r3.sse.text, 'Compris.');
  assert.equal(fake.registered.length, 1, 'aucun nouveau chat FS');
  assert.equal(fake.sent[2].chatId, 'chat-1');
  assert.doesNotMatch(fake.sent[2].content, /deuxième demande/);
  assert.match(fake.sent[2].content, /troisième demande$/);
  checkInvariants(fake);
});

test('/btw (question annexe) → réponse locale, 0 appel FS ; le message principal suivant reste dans le même chat', async t => {
  const { fake, gw } = await setup(t, { turns: ['Réponse un.', 'Réponse deux.'] });
  const u1 = user('première demande');
  const r1 = await call(gw, ccReq([u1]));
  const btw = await call(gw, ccReq([u1, asst(r1), user(SIDE('quelle heure est-il ?'))]));
  assert.equal(btw.status, 200);
  assert.equal(btw.sse.text, SIDE_QUESTION_OFF);
  assert.equal(btw.sse.message.stop_reason, 'end_turn');
  assert.equal(fake.sent.length, 1, '/btw : aucun envoi à FS');
  const r2 = await call(gw, ccReq([u1, asst(r1), user('deuxième demande')]));
  assert.equal(r2.sse.text, 'Réponse deux.');
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.registered.length, 1, 'aucun nouveau chat FS');
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.equal(fake.sent[1].content, 'deuxième demande');
  checkInvariants(fake);
});

test('fork d\'extraction de mémoire (même session, mêmes outils) → réponse locale, conversation principale intacte', async t => {
  const { fake, gw } = await setup(t, { turns: ['Réponse un.', 'Réponse deux.'] });
  const u1 = user('première demande');
  const r1 = await call(gw, ccReq([u1]));
  const mem = await call(gw, ccReq([u1, asst(r1), user('You are now acting as the memory extraction subagent. Analyze the most recent ~4 messages above and use them to update your persistent memory systems.')]));
  assert.equal(mem.status, 200);
  assert.equal(fake.sent.length, 1);
  await call(gw, ccReq([u1, asst(r1), user('deuxième demande')]));
  assert.equal(fake.registered.length, 1);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.equal(fake.sent[1].content, 'deuxième demande');
  checkInvariants(fake);
});

test('auto-compaction entre les tool_result et la requête suivante → FS reçoit les vrais résultats, pas « Non exécuté »', async t => {
  const { fake, gw } = await setup(t, {
    files: { [HELLO]: 'x\n' },
    turns: [{ text: 'Je lis et je lance. ', toolCalls: [readCall('call_1'), { callId: 'call_2', name: 'run_command', arguments: { command: 'npm test' } }] }, 'Fin.'],
  });
  const m1 = user('lis hello et lance les tests');
  const r1 = await call(gw, ccReq([m1]));
  const [read, bash] = r1.sse.toolUses;
  // Claude Code a exécuté les deux outils, puis lance la compaction (prompt ajouté après les tool_result)
  const c = await call(gw, ccReq([m1, asst(r1), results([read.id, '1\tcontenu de test'], [bash.id, 'tests OK']), user(COMPACT)]));
  assert.equal(fake.sent.length, 1, 'compaction locale');
  const r2 = await call(gw, ccReq([user(continuation(c.sse.text))]));
  assert.equal(r2.sse.text, 'Fin.');
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.deepEqual(fake.sent[1].toolResults, [
    { callId: 'call_1', output: '1: contenu de test', isError: false },
    { callId: 'call_2', output: 'tests OK', isError: false },
  ]);
  checkInvariants(fake);
});

test('même demande renvoyée après /rewind → pas de rejeu de l\'ancienne réponse (ses tool_use sont périmés)', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: 'Je lance. ', toolCalls: [{ callId: 'call_7', name: 'run_command', arguments: { command: 'npm test' } }] }, 'Tests OK.', 'Je relance. '],
  });
  const u1 = user('lance les tests');
  const r1 = await call(gw, ccReq([u1]));
  await call(gw, ccReq([u1, asst(r1), results([r1.sse.toolUses[0].id, 'ok'])]));
  const r3 = await call(gw, ccReq([u1]));                              // Échap Échap jusqu'au 1er message, même texte
  assert.equal(fake.sent.length, 3, 'nouvelle génération, pas un rejeu');
  assert.equal(r3.sse.text, 'Je relance. ');
  checkInvariants(fake);
});

test('historique cassé signalé APRÈS acceptation → reprise dans un nouveau chat (une fois), sans rattachement ni « Continue »', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: '', sseError: { code: 'STREAM_FAILED', message: 'Invalid encrypted_content in search_result' } }, 'Reprise.'],
  });
  const r = await call(gw, ccReq([user('cherche la doc')]));
  assert.equal(r.status, 200);
  assert.ok(r.sse.text.startsWith(MESSAGES.chatGone));
  assert.ok(r.sse.text.endsWith('Reprise.'));
  assert.equal(fake.calls.resume.length, 0, 'pas de rattachement : le serveur a répondu');
  assert.equal(fake.sent.length, 2);
  assert.ok(fake.sent[1].register && fake.sent[1].chatId === null, 'nouveau chat');
  assert.ok(!fake.sent.some(s => s.content === MESSAGES.continueCut));
  checkInvariants(fake);
});

test('STREAM_FAILED non réessayable APRÈS acceptation → note claire, ni rattachement ni « Continue » ; état vérifié au message suivant', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: 'Début de réponse ', sseError: { code: 'STREAM_FAILED', message: 'upstream exploded', after: 1 } }, 'Suite.'],
  });
  const m1 = user('explique');
  const r1 = await call(gw, ccReq([m1]));
  assert.equal(r1.sse.message.stop_reason, 'end_turn');
  assert.match(r1.sse.text, /^Début [\s\S]*erreur de France Student/);
  assert.equal(fake.calls.resume.length, 0);
  assert.equal(fake.sent.length, 1, 'aucun 2e POST dans le chat cassé');
  await call(gw, ccReq([m1, asst(r1), user('et ensuite ?')]));
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  assert.equal(fake.sent[1].content, 'et ensuite ?');
  checkInvariants(fake);
});

test('échec AVANT acceptation d\'un POST de suite (boucle interne) → fin propre, jamais d\'erreur réessayable qui renverrait la demande', async t => {
  const { fake, gw } = await setup(t, {
    turns: [{ text: '', toolCalls: [{ callId: 'call_1', name: 'outil_inconnu', arguments: {} }] }, { fail: 503 }, 'Réponse.'],
  });
  const m1 = user('première demande');
  const r1 = await call(gw, ccReq([m1]));
  assert.equal(r1.sse.error, null, 'pas d\'event: error (Claude Code renverrait la même requête)');
  assert.equal(r1.sse.message.stop_reason, 'end_turn');
  assert.match(r1.sse.text, /Connexion à France Student perdue/);
  assert.equal(fake.sent.length, 2);
  const r2 = await call(gw, ccReq([m1, asst(r1), user('et alors ?')]));
  assert.equal(r2.sse.text, 'Réponse.');
  assert.equal(fake.sent.length, 3);
  assert.equal(fake.sent[2].chatId, 'chat-1');
  assert.doesNotMatch(fake.sent[2].content, /première demande/, 'la demande n\'est jamais renvoyée');
  assert.match(fake.sent[2].content, /et alors \?$/);
  checkInvariants(fake);
});

test('/compact sur un long chat : compactage FS sous le verrou, la requête suivante attend sa fin (pas de 409)', async t => {
  const fake = fakeFs({ turns: [{ text: 'Réponse un.', usage: { promptTokenCount: 150000 } }, 'On continue.'] });
  const gate = deferred();
  const order = [];
  const compact = fake.deps.compactChat;
  fake.deps.compactChat = async id => { order.push('compact:début'); await gate.promise; order.push('compact:fin'); return compact(id); };
  const { gw } = await setup(t, {}, {}, { fake });
  const u1 = user('première demande');
  const r1 = await call(gw, ccReq([u1]));
  const c = await call(gw, ccReq([u1, asst(r1), user(COMPACT)]));
  await until(() => order.length === 1);
  const p2 = call(gw, ccReq([user(continuation(c.sse.text))])).then(r => { order.push('requête'); return r; });
  await tick(60);
  assert.equal(fake.sent.length, 1, 'la requête attend la fin du compactage');
  gate.open();
  const r2 = await p2;
  assert.equal(r2.sse.text, 'On continue.');
  assert.deepEqual(order, ['compact:début', 'compact:fin', 'requête']);
  assert.equal(fake.sent[1].chatId, 'chat-1');
  checkInvariants(fake);
});

test('409 qui persiste après reconcile → 529 (Claude Code réessaie plus tard), pas un 400', async t => {
  const { fake, gw } = await setup(t, { turns: ['Réponse un.', { fail: 409 }, { fail: 409 }] });
  const u1 = user('première demande');
  const r1 = await call(gw, ccReq([u1]));
  const r2 = await call(gw, ccReq([u1, asst(r1), user('deuxième demande')]));
  assert.equal(r2.status, 529);
  assert.equal(r2.json.error.type, 'overloaded_error');
  assert.equal(r2.headers['retry-after'], '5');
  assert.equal(fake.calls.fetchChat.length, 1);
  checkInvariants(fake);
});

test('(i-bis) limite du jour : jamais le chat d\'une conversation active ; le chat prêté n\'a qu\'un propriétaire', async t => {
  const { fake, gw } = await setup(t, { created: 48, files: { [HELLO]: 'x\n' }, turns: [{ text: 'Je lis. ', toolCalls: [readCall('call_1')] }, 'Réponse B.', 'Réponse C.'] });
  await call(gw, ccReq([user('tâche A')], { session: 'sess-a' }));     // A : appel en attente (Claude Code exécute encore)
  await call(gw, ccReq([user('tâche B')], { session: 'sess-b' }));     // B : 50e conversation, vient de servir
  fake.advance(60 * 60_000);
  const conv = key => gw.store.list().find(c => c.key === key);
  const a = conv('sess-a|main');
  a.updatedAt = 0;                                                      // A ancienne mais toujours en attente
  const r = await call(gw, ccReq([user('tâche C')], { session: 'sess-c' }));
  assert.equal(r.status, 200);
  assert.equal(fake.sent[2].chatId, 'chat-2', 'emprunt de B (inactive), jamais de A (appels en attente)');
  assert.equal(conv('sess-b|main').chatId, null, 'B ne réutilise plus ce chat');
  assert.equal(conv('sess-b|main').borrowedBy, conv('sess-c|main').id);
  assert.equal(conv('sess-a|main').chatId, 'chat-1');
  checkInvariants(fake);
});

test('(i-ter) limite du jour : une conversation utilisée il y a moins de 10 min n\'est pas empruntée', async t => {
  const { fake, gw } = await setup(t, { created: 49, turns: ['Réponse A.'] });
  await call(gw, ccReq([user('tâche A')], { session: 'sess-a' }));
  fake.advance(2 * 60_000);
  const r = await call(gw, ccReq([user('tâche B')], { session: 'sess-b' }));
  assert.equal(r.status, 400);
  assert.equal(fake.sent.length, 1);
  checkInvariants(fake);
});

test('(k-bis) NATIVE_UNSUPPORTED : texte seul pour un temps, jamais enregistré sur la conversation ; mode outils réessayé ensuite', async t => {
  const { fake, gw } = await setup(t, { turns: [{ fail: 'native' }, 'Texte.', 'Encore du texte.', 'Avec outils.'] });
  const m = [user('bonjour')];
  const r1 = await call(gw, ccReq(m));
  m.push(asst(r1), user('encore'));
  const r2 = await call(gw, ccReq(m));
  assert.equal(fake.sent[2].clientTools, undefined, 'tout de suite après : texte seul (pas un 403 par tour)');
  assert.notEqual(gw.store.list()[0].native, false, 'rien d\'enregistré sur disque');
  fake.advance(11 * 60_000);
  m.push(asst(r2), user('et maintenant ?'));
  await call(gw, ccReq(m));
  assert.ok(fake.sent[3].clientTools?.length, 'outils client réessayés');
  checkInvariants(fake);
});
