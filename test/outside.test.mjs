// Mode auto : écrire hors du dossier de travail demande UNE fois ; « faire confiance à ce dossier » supprime les questions suivantes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-outside-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { cfg } = await import('../src/config.js');
const { execCall, setSelectHandler } = await import('../src/agent.js');

test('hors du dossier de travail : une question, puis plus rien après « faire confiance »', async () => {
  cfg.mode = 'auto';
  const asked = [];
  setSelectHandler(async (o) => { asked.push(o); const i = o.options.findIndex(x => x.includes('confiance')); return i >= 0 ? i : 0; });
  const site = path.join(tmp, 'HTML SITE team'); fs.mkdirSync(site);
  const work = path.join(tmp, 'travail'); fs.mkdirSync(work);
  const S = { cwd: work, targetDir: null, allow: {}, undo: [], notes: [], pendingResults: [] };
  const io = { signal: new AbortController().signal, ask: async () => '', root: work };
  const write = (f, content = 'x') => execCall(S, { name: 'write_file', args: { path: path.join(site, f), content } }, io);

  assert.equal((await write('index.html')).ok, true);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].options.some(o => o.includes('faire confiance')), 'l\'option de confiance est proposée');
  assert.equal((await write('extras.css')).ok, true);
  assert.equal((await write('sous/extras.js')).ok, true);
  assert.equal(asked.length, 1, 'plus aucune question dans le dossier approuvé');

  await write('.env', 'A=1');
  assert.equal(asked.length, 2, 'un fichier sensible reste toujours demandé');

  // dans le dossier de travail : jamais de question en mode auto
  await execCall(S, { name: 'write_file', args: { path: path.join(work, 'a.txt'), content: 'x' } }, io);
  assert.equal(asked.length, 2);
});
