// Assistant de connexion : nettoyage de la clé collée et enregistrement privé dans ~/.fs-cli/.env
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-setup-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { cleanToken, saveToken } = await import('../src/setup.js');
const FAKE = 'abcDEF123-_.' + 'x'.repeat(40);   // fausse clé de test

test('la clé collée est nettoyée, quel que soit le format copié', () => {
  assert.equal(cleanToken(FAKE), FAKE);
  assert.equal(cleanToken(`  "${FAKE}"  `), FAKE);
  assert.equal(cleanToken(`next-auth.session-token=${FAKE}; Path=/`), FAKE);
  assert.equal(cleanToken(`__Secure-next-auth.session-token=${FAKE}`), FAKE);
  assert.equal(cleanToken(`FS_SESSION_TOKEN=${FAKE}`), FAKE);
  assert.equal(cleanToken('bonjour'), '', 'texte trop court ou invalide refusé');
  assert.equal(cleanToken('une phrase avec des espaces qui est longue'), '');
});

test('enregistrement : remplace l\'ancienne clé, garde les autres réglages', () => {
  const dir = path.join(tmp, 'h1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'FS_AGENT_ID=-2003\nFS_SESSION_TOKEN=ancienne\n');
  const file = saveToken(FAKE, dir);
  const txt = fs.readFileSync(file, 'utf8');
  assert.match(txt, /FS_AGENT_ID=-2003/);
  assert.match(txt, new RegExp(`FS_SESSION_TOKEN=${FAKE.replace(/[.\-]/g, '\\$&')}`));
  assert.doesNotMatch(txt, /ancienne/);
  assert.equal((txt.match(/FS_SESSION_TOKEN=/g) || []).length, 1);
});

test('enregistrement : crée le dossier s\'il n\'existe pas', () => {
  const dir = path.join(tmp, 'nouveau', '.fs-cli');
  saveToken(FAKE, dir);
  assert.ok(fs.existsSync(path.join(dir, '.env')));
});
