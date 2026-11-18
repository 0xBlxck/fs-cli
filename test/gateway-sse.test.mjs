// Tests de src/gateway/anthropic.js : journal Reply, flux SSE Anthropic, non-stream, erreurs, pings (horloge simulée).
// Tout est hors ligne : les réponses HTTP sont simulées (FakeRes) et vérifiées par le parseur SSE strict des aides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadFixture, parseSse } from './gateway-helpers.mjs';    // pose FS_CLI_HOME avant tout import de src/

const { Reply, estimateTokens, sendError, sendJson, wholeReply } = await import('../src/gateway/anthropic.js');

// ── doublures ──

/** Réponse HTTP simulée : garde le statut, les en-têtes et les octets écrits ; hangUp() = le client coupe. */
class FakeRes extends EventEmitter {
  constructor() { super(); this.status = null; this.head = {}; this.chunks = []; this.headersSent = false; this.writableEnded = false; this.destroyed = false; }
  writeHead(status, headers = {}) {
    assert.ok(!this.headersSent, 'writeHead appelé deux fois');
    this.status = status; this.headersSent = true;
    for (const [k, v] of Object.entries(headers)) this.head[k.toLowerCase()] = String(v);
    return this;
  }
  write(c) { assert.ok(!this.writableEnded, 'write après end'); assert.ok(this.headersSent, 'write avant writeHead'); this.chunks.push(String(c)); return true; }
  end(c) { if (c != null) this.chunks.push(String(c)); this.writableEnded = true; this.emit('close'); }
  hangUp() { this.destroyed = true; this.emit('close'); }
  get body() { return this.chunks.join(''); }
  get json() { return JSON.parse(this.body); }
}

/** Horloge simulée : setTimeout/setInterval déclenchés seulement par advance(ms). */
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { fn, at: now + ms, every: every ? ms : 0 }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => add(fn, ms, true), clearInterval: id => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        now = next.t.at;
        if (next.t.every) next.t.at += next.t.every; else timers.delete(next.id);
        next.t.fn();
      }
      now = end;
    },
    get pending() { return timers.size; },
  };
}

const newReply = (o = {}) => new Reply({ model: 'claude-sonnet-5-5', inputTokens: 1234, timers: fakeClock(), ...o });

// ── séquence SSE ──

test('texte puis tool_use : séquence exacte, index consécutifs, partial_json analysable, stop_reason tool_use', () => {
  const r = newReply();
  const res = new FakeRes();
  r.subscribe(res, true);
  r.headers();
  r.text('Je lis ');
  r.text('le fichier.');
  r.toolUse('toolu_abc-1_Z', 'Read', { file_path: 'C:\\proj\\hello.txt', limit: 1 });
  r.toolUse('toolu_abc-2', 'Bash', { command: 'echo "é" && ls', description: 'Commande : echo' });
  r.finish('tool_use', { candidatesTokenCount: 42 });
  assert.equal(res.status, 200);
  assert.match(res.head['content-type'], /^text\/event-stream/);
  assert.equal(res.head['cache-control'], 'no-cache');
  assert.ok(res.writableEnded);
  const p = parseSse(res.body);
  assert.deepEqual(p.events.filter(e => e.event !== 'ping').map(e => e.event), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(p.text, 'Je lis le fichier.');
  assert.deepEqual(p.toolUses.map(t => [t.id, t.name]), [['toolu_abc-1_Z', 'Read'], ['toolu_abc-2', 'Bash']]);
  assert.deepEqual(p.toolUses[0].input, { file_path: 'C:\\proj\\hello.txt', limit: 1 });
  assert.equal(p.toolUses[1].input.command, 'echo "é" && ls');
  assert.equal(p.message.stop_reason, 'tool_use');
  assert.equal(p.message.stop_sequence, null);
  assert.equal(p.message.model, 'claude-sonnet-5-5');
  assert.match(p.message.id, /^msg_[A-Za-z0-9]{24}$/);
  assert.deepEqual(p.message.usage, { input_tokens: 1234, output_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  const start = p.events[0].data.message;
  assert.deepEqual(start.usage, { input_tokens: 1234, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  assert.deepEqual(r.toolUseIds, ['toolu_abc-1_Z', 'toolu_abc-2']);
  assert.equal(r.emittedText, 'Je lis le fichier.');
  assert.ok(r.done);
});

test('texte après un tool_use : nouveau bloc ; format « event: X\\ndata: {…}\\n\\n » sur une seule ligne data', () => {
  const r = newReply();
  const res = new FakeRes();
  r.subscribe(res);
  r.text('a\nb\r\nc');
  r.toolUse('toolu_x', 'Read', { file_path: '/tmp/x' });
  r.text('suite');
  r.finish('end_turn');
  for (const block of res.body.split('\n\n').filter(Boolean)) {
    const lines = block.split('\n');
    assert.equal(lines.length, 2, `bloc SSE inattendu : ${block}`);
    assert.match(lines[0], /^event: [a-z_]+$/);
    assert.match(lines[1], /^data: \{/);
  }
  const p = parseSse(res.body);
  assert.deepEqual(p.message.content.map(b => b.type), ['text', 'tool_use', 'text']);
  assert.equal(p.message.content[0].text, 'a\nb\r\nc');
  assert.equal(p.message.stop_reason, 'tool_use', 'stop_reason rendu cohérent avec la présence d\'un tool_use');
});

test('stop_reason cohérent : tool_use sans bloc tool_use → end_turn ; valeur inconnue → end_turn ; max_tokens gardé', () => {
  for (const [given, want] of [['tool_use', 'end_turn'], ['bidon', 'end_turn'], ['max_tokens', 'max_tokens'], [undefined, 'end_turn']]) {
    const res = new FakeRes();
    const r = newReply();
    r.subscribe(res);
    r.text('.');
    r.finish(given);
    assert.equal(parseSse(res.body).message.stop_reason, want);
  }
});

test('jamais de réponse vide : finish sans contenu → note en français ; text("") ignoré', () => {
  const res = new FakeRes();
  const r = newReply();
  r.subscribe(res);
  r.text('');
  r.text(null);
  r.finish('end_turn');
  const p = parseSse(res.body);
  assert.equal(p.message.content.length, 1);
  assert.match(p.text, /France Student n'a renvoyé aucune réponse/);
  assert.equal(p.message.stop_reason, 'end_turn');
});

test('output_tokens : usage Anthropic, usage FS, sinon ceil(texte/4)', () => {
  const out = usage => { const res = new FakeRes(); const r = newReply(); r.subscribe(res); r.text('x'.repeat(41)); r.finish('end_turn', usage); return parseSse(res.body).message.usage.output_tokens; };
  assert.equal(out({ output_tokens: 7 }), 7);
  assert.equal(out({ candidatesTokenCount: 9, promptTokenCount: 99999 }), 9);
  assert.equal(out(null), 11);
});

// ── input_tokens ──

test('estimateTokens = ceil(len(JSON {system, messages}) / 3.5) — outils exclus —, annoncé dans message_start ET message_delta', () => {
  const body = loadFixture('req-03').body;
  const want = Math.ceil(JSON.stringify({ system: body.system, messages: body.messages }).length / 3.5);
  assert.equal(estimateTokens(body), want);
  assert.ok(want > 1000, 'le prompt réel de Claude Code pèse plusieurs milliers de tokens');
  const changed = { ...body, model: 'autre', max_tokens: 1, metadata: { x: 'y'.repeat(5000) } };
  assert.equal(estimateTokens(changed), want, 'seuls system et messages comptent');
  // 180k tokens d'outils MCP (vu en vrai) : jamais envoyés à FS, donc jamais comptés (sinon « Context limit reached » au 1er message)
  const manyTools = { ...body, tools: [...body.tools, ...Array.from({ length: 2000 }, (_, i) => ({ name: `mcp__x__t${i}`, description: 'd'.repeat(300), input_schema: { type: 'object' } }))] };
  assert.equal(estimateTokens(manyTools), want, 'les outils MCP ne gonflent pas le contexte');
  assert.equal(estimateTokens({}), 1);
  assert.equal(estimateTokens(null), 1);
  const res = new FakeRes();
  const r = new Reply({ model: body.model, inputTokens: estimateTokens(body), timers: fakeClock() });
  r.subscribe(res);
  r.text('ok');
  r.finish('end_turn', { promptTokenCount: 777, candidatesTokenCount: 1 });
  const p = parseSse(res.body);
  assert.equal(p.events[0].data.message.usage.input_tokens, want);
  assert.equal(p.message.usage.input_tokens, want, 'jamais promptTokenCount de France Student');
  assert.equal(p.message.model, body.model);
});

// ── en-têtes retardés et pings ──

test('en-têtes retardés : rien n\'est écrit avant headers() ; une erreur avant devient un vrai statut HTTP', () => {
  const res = new FakeRes();
  const r = newReply();
  r.subscribe(res, true);
  assert.equal(res.headersSent, false);
  assert.equal(res.body, '');
  r.fail('overloaded_error', 'France Student est occupé, nouvel essai…');
  assert.equal(res.status, 529);
  assert.equal(res.head['retry-after'], '5');
  assert.match(res.head['content-type'], /^application\/json/);
  assert.deepEqual(res.json, { type: 'error', error: { type: 'overloaded_error', message: 'France Student est occupé, nouvel essai…' } });
  assert.ok(r.done);
  const late = new FakeRes();
  r.subscribe(late, true);
  assert.equal(late.status, 529, 'un réessai qui rejoint reçoit la même erreur');
  const res400 = new FakeRes();
  const r2 = newReply();
  r2.subscribe(res400, false);
  r2.fail('invalid_request_error', 'Limite de 50 nouvelles conversations France Student atteinte (remise à zéro jeu. 05:00).');
  assert.equal(res400.status, 400);
  assert.equal(res400.json.error.type, 'invalid_request_error');
  assert.equal(res400.head['retry-after'], undefined);
});

test('pings toutes les 10 s après les en-têtes (horloge simulée), arrêtés à message_stop', () => {
  const clock = fakeClock();
  const res = new FakeRes();
  const r = new Reply({ model: 'm', inputTokens: 5, timers: clock });
  r.subscribe(res, true);
  clock.advance(9000);
  assert.equal(res.headersSent, false, 'pas de ping avant les en-têtes');
  r.headers();
  assert.equal(res.status, 200);
  assert.equal(parseSse(res.body, { partial: true }).events.length, 1, 'message_start écrit tout de suite');
  clock.advance(9999);
  assert.equal(parseSse(res.body, { partial: true }).pings, 0);
  clock.advance(1);
  assert.equal(parseSse(res.body, { partial: true }).pings, 1);
  clock.advance(25000);
  assert.equal(parseSse(res.body, { partial: true }).pings, 3);
  r.text('fin');
  r.finish('end_turn');
  assert.equal(clock.pending, 0, 'aucun minuteur ne reste armé');
  clock.advance(60000);
  const p = parseSse(res.body);
  assert.equal(p.pings, 3);
  assert.equal(p.text, 'fin');
});

test('en-têtes envoyés d\'office après 25 s d\'attente (verrou, sémaphore, FS lent), puis pings', () => {
  const clock = fakeClock();
  const res = new FakeRes();
  const r = new Reply({ model: 'm', inputTokens: 5, timers: clock });
  r.subscribe(res, true);
  clock.advance(24999);
  assert.equal(res.headersSent, false);
  clock.advance(1);
  assert.equal(res.status, 200);
  clock.advance(20000);
  assert.equal(parseSse(res.body, { partial: true }).pings, 2);
  r.fail('overloaded_error', 'FS en panne');
  const p = parseSse(res.body);
  assert.deepEqual(p.error, { type: 'overloaded_error', message: 'FS en panne' }, 'après les en-têtes sans contenu : event: error');
  assert.ok(res.writableEnded);
});

test('headersIfWaiting : en-têtes immédiats s\'il y a un abonné stream, rien sinon', () => {
  const r1 = newReply();
  const ns = new FakeRes();
  r1.subscribe(ns, false);
  r1.headersIfWaiting();
  assert.equal(r1.headersSent, false, 'un abonné non-stream ne déclenche pas d\'en-têtes SSE');
  const s = new FakeRes();
  r1.subscribe(s, true);
  r1.headersIfWaiting();
  assert.equal(s.status, 200);
  assert.equal(ns.headersSent, false);
});

// ── erreurs après les en-têtes ──

test('après du contenu : jamais event: error, note finale + end_turn', () => {
  const res = new FakeRes();
  const r = newReply();
  r.subscribe(res);
  r.text('Début de réponse');
  r.fail('overloaded_error', '[FS-CLI] Connexion à France Student perdue. Renvoie ton message pour reprendre.');
  const p = parseSse(res.body);
  assert.equal(p.error, null);
  assert.equal(p.message.stop_reason, 'end_turn');
  assert.equal(p.text, 'Début de réponse\n\n[FS-CLI] Connexion à France Student perdue. Renvoie ton message pour reprendre.');
});

test('après des tool_use : fail termine en tool_use sans note (les outils restent valides)', () => {
  const res = new FakeRes();
  const r = newReply();
  r.subscribe(res);
  r.toolUse('toolu_1', 'Read', { file_path: '/a' });
  r.fail('api_error', 'boum');
  const p = parseSse(res.body);
  assert.equal(p.message.stop_reason, 'tool_use');
  assert.equal(p.text, '');
});

test('après les en-têtes sans contenu : type non réessayable → texte + end_turn ; réessayable → event: error overloaded_error', () => {
  const a = new FakeRes();
  const r = newReply();
  r.subscribe(a);
  r.headers();
  r.fail('invalid_request_error', 'Session France Student expirée : lance « fs-cli --login » dans un autre terminal, puis renvoie ton message.');
  const p = parseSse(a.body);
  assert.equal(p.error, null);
  assert.match(p.text, /fs-cli --login/);
  assert.equal(p.message.stop_reason, 'end_turn');
  const b = new FakeRes();
  const ns = new FakeRes();
  const r2 = newReply();
  r2.subscribe(b);
  r2.subscribe(ns, false);
  r2.headers();
  r2.fail('api_error', 'HTTP 503');
  assert.deepEqual(parseSse(b.body).error, { type: 'overloaded_error', message: 'HTTP 503' });
  assert.equal(ns.status, 529, 'l\'abonné non-stream reçoit un vrai 529');
  assert.equal(ns.json.error.type, 'overloaded_error');
});

test('rien ne s\'écrit après la fin : text, toolUse, finish et fail sont ignorés', () => {
  const res = new FakeRes();
  const r = newReply();
  r.subscribe(res);
  r.text('x');
  r.finish('end_turn');
  const before = res.body;
  r.text('y'); r.toolUse('toolu_2', 'Read', {}); r.finish('tool_use'); r.fail('api_error', 'z');
  assert.equal(res.body, before);
});

// ── abonnés multiples (join, replay) ──

test('abonné tardif pendant la génération : reçoit tout le journal puis le direct (flux identique à l\'original)', () => {
  const clock = fakeClock();
  const r = new Reply({ model: 'm', inputTokens: 10, timers: clock });
  const first = new FakeRes();
  r.subscribe(first);
  r.text('Bonjour ');
  r.text('le monde');
  const late = new FakeRes();
  r.subscribe(late);
  assert.equal(r.listeners, 2);
  r.text(' !');
  r.toolUse('toolu_9', 'Grep', { pattern: 'x', output_mode: 'content' });
  r.finish('tool_use');
  const a = parseSse(first.body), b = parseSse(late.body);
  assert.deepEqual(b.message, a.message);
  assert.equal(b.text, 'Bonjour le monde !');
  assert.equal(late.status, 200);
});

test('abonné tardif après la fin : stream complet ou JSON, sans rien recalculer', () => {
  const r = newReply();
  const first = new FakeRes();
  r.subscribe(first);
  r.text('Réponse finale.');
  r.finish('end_turn', { output_tokens: 3 });
  const s = new FakeRes(), j = new FakeRes();
  r.subscribe(s, true);
  r.subscribe(j, false);
  assert.ok(s.writableEnded && j.writableEnded);
  assert.equal(s.body, first.body);
  assert.deepEqual(j.json, r.toJSON());
  assert.equal(r.listeners, 0);
});

test('non-stream ≡ stream : toJSON = message reconstruit par le parseur SSE ; un abonné non-stream attend la fin', () => {
  const r = newReply();
  const s = new FakeRes(), ns = new FakeRes();
  r.subscribe(s, true);
  r.subscribe(ns, false);
  r.text('Voici ');
  assert.equal(ns.headersSent, false, 'non-stream : rien avant la fin');
  r.text('le plan.');
  r.toolUse('toolu_w', 'Write', { file_path: '/p/a.md', content: '# Titre\n' });
  r.finish('tool_use', { output_tokens: 12 });
  const p = parseSse(s.body);
  assert.equal(ns.status, 200);
  assert.match(ns.head['content-type'], /^application\/json/);
  const j = ns.json;
  assert.deepEqual(j, p.message);
  assert.deepEqual(j, r.toJSON());
  assert.deepEqual(Object.keys(j).sort(), ['content', 'id', 'model', 'role', 'stop_reason', 'stop_sequence', 'type', 'usage']);
  assert.equal(j.content[1].input.content, '# Titre\n');
});

test('snapshot → fromSnapshot : sérialisable, deltas fusionnés, rejoué à l\'identique (replay sans FS)', () => {
  const r = newReply();
  const res = new FakeRes();
  r.subscribe(res);
  for (const w of ['Un ', 'deux ', 'trois.']) r.text(w);
  r.toolUse('toolu_s', 'Read', { file_path: '/x' });
  r.finish('tool_use', { output_tokens: 4 });
  const snap = JSON.parse(JSON.stringify(r.snapshot('cle-1')));
  assert.equal(snap.key, 'cle-1');
  assert.equal(snap.events.filter(e => e.data.delta?.type === 'text_delta').length, 1, 'text_delta consécutifs fusionnés');
  const again = Reply.fromSnapshot(snap, { timers: fakeClock() });
  assert.equal(again.id, r.id);
  assert.equal(again.emittedText, 'Un deux trois.');
  assert.deepEqual(again.toolUseIds, ['toolu_s']);
  assert.ok(again.done);
  const s2 = new FakeRes(), j2 = new FakeRes();
  again.subscribe(s2, true);
  again.subscribe(j2, false);
  assert.deepEqual(parseSse(s2.body).message, parseSse(res.body).message);
  assert.deepEqual(j2.json, r.toJSON());
  const failed = newReply();
  failed.subscribe(new FakeRes());
  failed.fail('invalid_request_error', 'non');
  const f2 = new FakeRes();
  Reply.fromSnapshot(failed.snapshot('k')).subscribe(f2);
  assert.equal(f2.status, 400);
});

// ── déconnexion du client ──

test('fermeture du client : abonné retiré, onAbandon après 8 s sans personne ; un réessai qui rejoint l\'annule', () => {
  const clock = fakeClock();
  let abandoned = 0;
  const r = new Reply({ model: 'm', inputTokens: 1, timers: clock, onAbandon: () => abandoned++ });
  const a = new FakeRes();
  r.subscribe(a);
  r.headers();
  r.text('en cours');
  a.hangUp();
  assert.equal(r.listeners, 0);
  clock.advance(7000);
  const b = new FakeRes();
  r.subscribe(b);                                                         // réessai identique (join) dans le délai
  clock.advance(5000);
  assert.equal(abandoned, 0);
  assert.equal(parseSse(b.body, { partial: true }).text, 'en cours', 'le réessai reçoit ce qui a déjà été émis');
  b.hangUp();
  clock.advance(7999);
  assert.equal(abandoned, 0);
  clock.advance(1);
  assert.equal(abandoned, 1);
  const c = newReply({ onAbandon: () => abandoned++ });
  const d = new FakeRes();
  c.subscribe(d);
  c.text('x');
  c.finish('end_turn');                                                   // fin normale : close après end → pas d'abandon
  assert.equal(abandoned, 1);
  const e = newReply({ onAbandon: () => abandoned++ });
  const unsubscribe = e.subscribe(new FakeRes());
  unsubscribe();                                                          // désabonnement explicite : pas une coupure du client
  assert.equal(e.listeners, 0);
});

test('écriture vers un client coupé ignorée (pas d\'exception)', () => {
  const r = newReply();
  const a = new FakeRes(), b = new FakeRes();
  r.subscribe(a);
  r.subscribe(b);
  r.headers();
  a.destroyed = true;                                                     // socket détruit sans événement close (course)
  r.text('x');
  r.finish('end_turn');
  assert.equal(parseSse(b.body).text, 'x');
});

// ── réponses locales et erreurs ──

test('wholeReply : stream et non-stream identiques ; bloc texte vide gardé tel quel (suggestion)', () => {
  const usage = { input_tokens: 321, output_tokens: 2 };
  const s = new FakeRes(), j = new FakeRes();
  const content = [{ type: 'text', text: '{"title":"Lire hello"}' }];
  wholeReply(s, { model: 'claude-haiku-5-5', stream: true, content, stop: 'end_turn', usage });
  wholeReply(j, { model: 'claude-haiku-5-5', stream: false, content, stop: 'end_turn', usage });
  const p = parseSse(s.body);
  assert.equal(p.text, '{"title":"Lire hello"}');
  assert.equal(p.message.usage.input_tokens, 321);
  const { id: _a, ...ps } = p.message;
  const { id: _b, ...js } = j.json;
  assert.deepEqual(js, ps);
  const e = new FakeRes();
  wholeReply(e, { model: 'm', stream: true, content: [{ type: 'text', text: '' }], stop: 'end_turn', usage });
  const pe = parseSse(e.body);
  assert.deepEqual(pe.message.content, [{ type: 'text', text: '' }], 'suggestion : bloc texte vide, pas de note');
  const probe = new FakeRes();
  wholeReply(probe, { model: 'm', stream: false, content: [{ type: 'text', text: '.' }], stop: 'max_tokens', usage });
  assert.equal(probe.json.stop_reason, 'max_tokens');
  const tool = new FakeRes();
  const rep = wholeReply(tool, { model: 'm', content: [{ type: 'text', text: 'Je relis.' }, { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/a', limit: 1 } }], stop: 'tool_use', usage });
  assert.equal(parseSse(tool.body).toolUses[0].input.limit, 1);
  assert.ok(rep instanceof Reply && rep.done);
});

test('sendError et sendJson : enveloppe Anthropic, en-têtes ajoutés, sans effet si la réponse est déjà partie', () => {
  const res = new FakeRes();
  sendError(res, 404, 'not_found_error', 'model: gpt-9 introuvable sur France Student', { 'x-should-retry': 'false' });
  assert.equal(res.status, 404);
  assert.equal(res.head['x-should-retry'], 'false');
  assert.equal(Number(res.head['content-length']), Buffer.byteLength(res.body));
  assert.deepEqual(res.json, { type: 'error', error: { type: 'not_found_error', message: 'model: gpt-9 introuvable sur France Student' } });
  sendError(res, 500, 'api_error', 'encore');                           // déjà terminée : ignoré
  assert.equal(res.status, 404);
  const ok = new FakeRes();
  sendJson(ok, 200, { input_tokens: 12 });
  assert.deepEqual(ok.json, { input_tokens: 12 });
});
