// /bug : journal des erreurs et rapport, sans aucune donnée sensible
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-bug-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { scrub, recordError, bugReport, ERRORS_FILE } = await import('../src/bugreport.js');

test('scrub : jetons, clés, e-mails, dossier personnel et nom d\'utilisateur masqués', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';   // scan-ignore (faux jeton de test)
  const s = scrub(`401 ${jwt} Bearer abc.def mail moi.test@gmail.com dans C:\\Users\\jean\\projet et ${'a'.repeat(48)}`, 'C:\\Users\\jean');   // scan-ignore (fausses valeurs de test)
  assert.doesNotMatch(s, /eyJ|abc\.def|gmail|jean|a{48}/);
  assert.match(s, /<jeton>/); assert.match(s, /<e-mail>/); assert.match(s, /~\\projet/);
  assert.equal(scrub('D:/Users/marie/x', 'C:\\Users\\jean'), 'D:/Users/<utilisateur>/x');   // scan-ignore (faux chemins de test)
});

test('recordError : une ligne par erreur, nettoyée, 200 au plus ; le rapport les reprend avec la version et le système', () => {
  for (let i = 0; i < 205; i++) recordError(Object.assign(new Error(`erreur ${i} token=eyJaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc`), { status: 409, code: 'STREAM_FAILED' }), { model: 'Claude Sonnet 5.5' });
  const lines = fs.readFileSync(ERRORS_FILE(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 200);
  assert.doesNotMatch(lines.join('\n'), /eyJ/);
  const r = bugReport({ version: '9.9.9', model: 'Claude Sonnet 5.5', mode: 'edits', engine: 'native', ui: 'TUI', shell: 'PowerShell' });
  assert.match(r, /FS-CLI :\s+9\.9\.9/);
  assert.match(r, /Node :\s+v\d+/);
  assert.match(r, /409 STREAM_FAILED erreur 204/);
  assert.match(r, /Ce que je faisais :/);
  assert.equal((r.match(/erreur \d+/g) || []).length, 10, '10 dernières erreurs');
});
