// Confiance par dossier et fichier d'instructions du projet
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-trust-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { isFolderTrusted, trustFolder, isBroadFolder } = await import('../src/trust.js');
const mem = await import('../src/memory.js');

test('confiance : dossier inconnu non approuvé, puis approuvé avec ses sous-dossiers', () => {
  const proj = path.join(tmp, 'projet'); fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  assert.equal(isFolderTrusted(proj), false);
  trustFolder(proj);
  assert.equal(isFolderTrusted(proj), true);
  assert.equal(isFolderTrusted(path.join(proj, 'src')), true);
  assert.equal(isFolderTrusted(path.join(tmp, 'projet-voisin')), false, 'un nom qui commence pareil n\'est pas un sous-dossier');
});

test('confiance « session seulement » : rien n\'est enregistré', () => {
  const d = path.join(tmp, 'temporaire'); fs.mkdirSync(d);
  trustFolder(d, { remember: false });
  assert.equal(isFolderTrusted(d), true);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.FS_CLI_HOME, 'trusted-folders.json'), 'utf8'));
  assert.equal(saved.some(p => p.includes('temporaire')), false);
});

test('dossiers trop larges : racine du disque et dossier personnel', () => {
  assert.equal(isBroadFolder(path.parse(tmp).root), true);
  assert.equal(isBroadFolder(os.homedir()), true);
  assert.equal(isBroadFolder(tmp), false);
});

test('/init crée FSCLI.md sans jamais écraser, et il est joint au contexte', () => {
  const p = path.join(tmp, 'app'); fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: 'app', scripts: { dev: 'vite', test: 'vitest' } }));
  const r = mem.initInstructions(p);
  assert.equal(r.created, true);
  const txt = fs.readFileSync(r.path, 'utf8');
  assert.match(txt, /npm run dev/); assert.match(txt, /npm test/);
  fs.writeFileSync(r.path, '# Mes règles\n- toujours en TypeScript\n');
  assert.equal(mem.initInstructions(p).created, false);
  assert.equal(fs.readFileSync(r.path, 'utf8'), '# Mes règles\n- toujours en TypeScript\n', 'pas écrasé');
  const block = mem.buildContextBlock(p);
  assert.match(block.text, /toujours en TypeScript/); assert.match(block.label, /FSCLI\.md/);
});
