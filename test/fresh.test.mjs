// Fraîcheur des fichiers et écriture atomique : le modèle n'écrase jamais une version qu'il n'a pas vue.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../src/tools.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-fresh-'));
const ctx = { cwd: dir, undo: [] };
const later = (fp) => { const t = new Date(Date.now() + 5000); fs.utimesSync(fp, t, t); };

test('édition refusée si le fichier a changé depuis la lecture, acceptée après relecture', async () => {
  const fp = path.join(dir, 'a.txt');
  fs.writeFileSync(fp, 'bonjour monde\n');
  assert.equal((await TOOLS.read_file.run({ path: 'a.txt' }, ctx)).ok, true);
  fs.writeFileSync(fp, 'bonjour monde\najout de l\'utilisateur\n'); later(fp);   // l'utilisateur modifie le fichier
  const r = await TOOLS.edit_file.run({ path: 'a.txt', old_string: 'monde', new_string: 'tous' }, ctx);
  assert.equal(r.ok, false); assert.match(r.output, /modifié depuis ta dernière lecture/);
  await TOOLS.read_file.run({ path: 'a.txt' }, ctx);
  const r2 = await TOOLS.edit_file.run({ path: 'a.txt', old_string: 'monde', new_string: 'tous' }, ctx);
  assert.equal(r2.ok, true);
  assert.equal(fs.readFileSync(fp, 'utf8'), 'bonjour tous\najout de l\'utilisateur\n');
});

test('écritures successives du modèle sans relecture : autorisées (il connaît sa propre version)', async () => {
  assert.equal((await TOOLS.write_file.run({ path: 'b.txt', content: 'v1' }, ctx)).ok, true);
  assert.equal((await TOOLS.edit_file.run({ path: 'b.txt', old_string: 'v1', new_string: 'v2' }, ctx)).ok, true);
  assert.equal((await TOOLS.write_file.run({ path: 'b.txt', content: 'v3' }, ctx)).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'v3');
});

test('écrasement refusé si quelqu\'un a modifié le fichier après la lecture', async () => {
  const fp = path.join(dir, 'c.txt');
  fs.writeFileSync(fp, 'original');
  await TOOLS.read_file.run({ path: 'c.txt' }, ctx);
  fs.writeFileSync(fp, 'modifié à la main'); later(fp);
  const r = await TOOLS.write_file.run({ path: 'c.txt', content: 'écrasé' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(fp, 'utf8'), 'modifié à la main');
});

test('écriture atomique : aucun fichier temporaire laissé', async () => {
  await TOOLS.write_file.run({ path: 'd.txt', content: 'x'.repeat(10000) }, ctx);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});
