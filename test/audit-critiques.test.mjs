// Problèmes critiques de l'audit complet (17/11/2026) — tests hors ligne
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FS_CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-crit-'));
const { TOOLS, decodeText } = await import('../src/tools.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-crit-ws-'));
const ctx = { cwd: dir, undo: [] };

test('edit_file sur un fichier Windows-1252 / Latin-1 (CSV Excel) : les accents des autres lignes restent intacts', async () => {
  const fp = path.join(dir, 'export.csv');
  fs.writeFileSync(fp, Buffer.from('nom;ville\r\ncafé crème;Orléans\r\nligne2;x\r\n', 'latin1'));
  assert.equal((await TOOLS.read_file.run({ path: 'export.csv' }, ctx)).output.includes('café crème'), true, 'lu avec ses accents');
  const r = await TOOLS.edit_file.run({ path: 'export.csv', old_string: 'ligne2', new_string: 'ligne3 éà' }, ctx);
  assert.equal(r.ok, true, r.output);
  const bytes = fs.readFileSync(fp);
  assert.equal(bytes.toString('latin1'), 'nom;ville\r\ncafé crème;Orléans\r\nligne3 éà;x\r\n');
  assert.ok(!bytes.includes(Buffer.from([0xEF, 0xBF, 0xBD])), 'aucun « � »');
  const bad = await TOOLS.edit_file.run({ path: 'export.csv', old_string: 'ligne3', new_string: 'ligne4 €' }, ctx);
  assert.equal(bad.ok, false, 'caractère hors de l\'encodage : refus clair, rien d\'abîmé');
  assert.match(bad.output, /Windows-1252/);
});

test('edit_file sur un fichier UTF-16 (PowerShell 5.1) : modifié et réécrit en UTF-16', async () => {
  const fp = path.join(dir, 'notes.txt');
  fs.writeFileSync(fp, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Bonjour\r\nété\r\n', 'utf16le')]));
  const r = await TOOLS.edit_file.run({ path: 'notes.txt', old_string: 'Bonjour', new_string: 'Salut' }, ctx);
  assert.equal(r.ok, true, r.output);
  const d = decodeText(fs.readFileSync(fp));
  assert.equal(d.enc, 'utf16le'); assert.equal(d.text, 'Salut\r\nété\r\n');
});

test('edit_file : UTF-8 avec BOM conservé, UTF-8 normal inchangé', async () => {
  const fp = path.join(dir, 'a.txt');
  fs.writeFileSync(fp, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('déjà là\n', 'utf8')]));
  assert.equal((await TOOLS.edit_file.run({ path: 'a.txt', old_string: 'là', new_string: 'ici' }, ctx)).ok, true);
  const b = fs.readFileSync(fp);
  assert.deepEqual([...b.subarray(0, 3)], [0xEF, 0xBB, 0xBF]); assert.equal(b.subarray(3).toString('utf8'), 'déjà ici\n');
});

test('search_files ne renvoie jamais le contenu d\'un .env (ni d\'une clé) : fichier signalé, à lire avec confirmation', async () => {
  fs.writeFileSync(path.join(dir, '.env'), 'STRIPE_SECRET=sk_live_123\nDB_PASSWORD=hunter2\n');   // scan-ignore (faux secret de test)
  fs.writeFileSync(path.join(dir, 'app.js'), 'const k = process.env.STRIPE_SECRET;\n');
  const r = await TOOLS.grep.run({ pattern: 'SECRET|PASSWORD' }, ctx);
  assert.doesNotMatch(r.output, /sk_live|hunter2/);
  assert.match(r.output, /app\.js:1:/);
  assert.match(r.output, /sensible\(s\) non fouillé\(s\) : \.env/);
});

test('contexte de l\'éditeur : un chemin avec [ ] (Next.js) est bien retiré ; ce qui est tapé reste', async () => {
  const { stripEditorContext } = await import('../src/editor-context.js');
  assert.equal(stripEditorContext('[Contexte VS Code : fichier ouvert dans l\'éditeur : app/[id]/page.tsx]\nexplique ce fichier'), 'explique ce fichier');
  assert.equal(stripEditorContext('[Contexte VS Code : fichier ouvert : C:\\Temp\\log.txt]\n```\nC:\\Temp\\autre\n```\ncorrige le bug'), 'corrige le bug');
});
