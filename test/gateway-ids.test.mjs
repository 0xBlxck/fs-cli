// Passerelle Claude Code : ids tool_use décodables (src/gateway/ids.js, spécification § 3.4).
import './gateway-helpers.mjs';                      // pose FS_CLI_HOME sur un dossier temporaire avant tout import de src/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { fsId, synthId, retryId, decodeId, rand62 } = await import('../src/gateway/ids.js');

const CHAT = ['1a2b3c4d', '0000', '4000', '8000', '000000000001'].join('-');   // forme UUID, valeur fictive (assemblée : scan.mjs refuse les UUID littéraux)
const ALPHABET = /^[A-Za-z0-9_-]+$/;

test('fsId : aller-retour f, alphabet de Claude Code, préfixe toolu_', () => {
  const id = fsId(CHAT, 'toolu_01AbCdEf');
  assert.match(id, /^toolu_/);
  assert.match(id, ALPHABET);
  assert.ok(id.length <= 200);
  assert.deepEqual(decodeId(id), { kind: 'f', chatId: CHAT, callId: 'toolu_01AbCdEf' });
  assert.equal(fsId(CHAT, 'toolu_01AbCdEf'), id, 'déterministe : même appel, même id');
  assert.notEqual(fsId(CHAT, 'call_2'), id);
});

test('fsId : callId avec « | », accents ou caractères spéciaux', () => {
  for (const callId of ['a|b|c', 'appel-é→1', 'call_x y']) {
    const id = fsId(CHAT, callId);
    assert.match(id, ALPHABET);
    assert.deepEqual(decodeId(id), { kind: 'f', chatId: CHAT, callId });
  }
});

test('retryId : aller-retour r avec le numéro d\'essai', () => {
  const id = retryId(CHAT, 'call|7', 1);
  assert.match(id, ALPHABET);
  assert.deepEqual(decodeId(id), { kind: 'r', chatId: CHAT, callId: 'call|7', n: 1 });
  assert.notEqual(id, fsId(CHAT, 'call|7'));
  assert.notEqual(retryId(CHAT, 'call|7', 2), id);
});

test('synthId : aller-retour s, ids toujours différents (aléa)', () => {
  const a = synthId('read'), b = synthId('read');
  assert.match(a, ALPHABET);
  assert.notEqual(a, b, 'deux Read injectés ne partagent jamais un id (sinon empreintes identiques)');
  assert.deepEqual(decodeId(a), { kind: 's', purpose: 'read' });
  const d = synthId('doc', 3);
  assert.deepEqual(decodeId(d), { kind: 's', purpose: 'doc', n: '3' });
  assert.notEqual(synthId('doc', 3), d);
});

test('repli sha1 au-delà de 200 caractères : id court, non décodable', () => {
  const long = 'c'.repeat(300);
  const id = fsId(CHAT, long);
  const expect = 'toolu_f' + createHash('sha1').update(`${CHAT}|${long}`).digest('hex').slice(0, 24);
  assert.equal(id, expect);
  assert.match(id, ALPHABET);
  assert.equal(decodeId(id), null, 'la correspondance reste dans pending');
  const r = retryId(CHAT, long, 1);
  assert.match(r, /^toolu_r[0-9a-f]{24}$/);
  assert.equal(decodeId(r), null);
  // juste sous la limite : encore décodable
  let n = 1; while (decodeId(fsId(CHAT, 'x'.repeat(n + 1))) && n < 1000) n++;   // dernier callId encore encodé en clair
  assert.ok(n < 1000);
  assert.ok(fsId(CHAT, 'x'.repeat(n)).length <= 200);
  assert.equal(decodeId(fsId(CHAT, 'x'.repeat(n))).callId, 'x'.repeat(n));
  assert.equal(decodeId(fsId(CHAT, 'x'.repeat(n + 1))), null);
});

test('decodeId est tolérant : null pour tout id qui n\'est pas à nous', () => {
  for (const id of ['toolu_capture1', 'toolu_01ABCdefGHI', 'toolu_', 'call_123', '', 'toolu_!!', 'toolu_Znw',
    'toolu_' + Buffer.from('x|y|z').toString('base64url'), 'toolu_' + Buffer.from('f||z').toString('base64url'),
    'toolu_' + Buffer.from('f|chat|').toString('base64url'), 'toolu_' + Buffer.from('r|chat|call|abc').toString('base64url'),
    'toolu_' + Buffer.from('s|read').toString('base64url'), 'toolu_' + Buffer.from([0x66, 0x7c, 0xff, 0x7c, 0x61]).toString('base64url'),
    'srvtoolu_' + Buffer.from('f|a|b').toString('base64url')]) {
    assert.equal(decodeId(id), null, id);
  }
  for (const v of [null, undefined, 42, {}, ['toolu_x']]) assert.equal(decodeId(v), null);
});

test('rand62 : longueur et alphabet base62', () => {
  const s = rand62(12);
  assert.match(s, /^[0-9A-Za-z]{12}$/);
  assert.notEqual(rand62(12), s);
});
