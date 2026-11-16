// Diff « accepter / refuser » dans l'éditeur : en mode « confirmer », write_file / edit_file joignent le contenu PROPOSÉ à la question
// (seulement pour le panneau VS Code) ; en modes auto et « accepter les modifications », aucune question.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-proposal-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { cfg } = await import('../src/config.js');
const { execCall, setSelectHandler } = await import('../src/agent.js');
const { proposedChange, PROPOSAL_MAX } = await import('../src/tools.js');

const work = path.join(tmp, 'projet'); fs.mkdirSync(work);
let n = 0;
const session = () => ({ cwd: work, targetDir: null, allow: {}, undo: [], notes: [], pendingResults: [] });
const io = (feedback = '') => ({ signal: new AbortController().signal, ask: async () => feedback, root: work });
const fresh = (content) => { const f = path.join(work, `f${++n}.txt`); if (content !== undefined) fs.writeFileSync(f, content); return f; };
/** menu factice : enregistre chaque question et choisit l'option demandée */
const answering = (asked, pick) => async (o) => { asked.push(o); const i = o.options.indexOf(pick); return i >= 0 ? i : 0; };

test('mode confirmer · write_file (nouveau fichier) : proposition jointe, « Accepter » écrit le fichier', async () => {
  cfg.mode = 'ask';
  const asked = [];
  setSelectHandler(answering(asked, 'Accepter'), { proposals: true });
  const f = fresh();
  const r = await execCall(session(), { name: 'write_file', args: { path: f, content: '<h1>Bonjour</h1>\n' } }, io());
  assert.equal(r.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].options[0], 'Accepter');
  assert.equal(asked[0].options.at(-1), 'Refuser');
  assert.deepEqual(asked[0].proposal, { path: f, before: '', after: '<h1>Bonjour</h1>\n', created: true });
  assert.equal(fs.readFileSync(f, 'utf8'), '<h1>Bonjour</h1>\n');
});

test('mode confirmer · write_file (fichier existant) : « avant » = contenu actuel', async () => {
  cfg.mode = 'ask';
  const asked = [];
  setSelectHandler(answering(asked, 'Accepter'), { proposals: true });
  const f = fresh('ancien\n');
  await execCall(session(), { name: 'write_file', args: { path: f, content: 'nouveau\n' } }, io());
  assert.deepEqual(asked[0].proposal, { path: f, before: 'ancien\n', after: 'nouveau\n', created: false });
  assert.equal(fs.readFileSync(f, 'utf8'), 'nouveau\n');
});

test('mode confirmer · edit_file : contenu proposé = remplacement appliqué, « Refuser » ne touche à rien', async () => {
  cfg.mode = 'ask';
  const asked = [];
  setSelectHandler(answering(asked, 'Refuser'), { proposals: true });
  const f = fresh('a\nb\nc\n');
  const r = await execCall(session(), { name: 'edit_file', args: { path: f, old_string: 'b', new_string: 'B2' } }, io('garde b'));
  assert.equal(r.ok, false);
  assert.match(r.output, /REFUSÉ.*garde b/);
  assert.deepEqual(asked[0].proposal, { path: f, before: 'a\nb\nc\n', after: 'a\nB2\nc\n', created: false });
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\nc\n');
});

test('mode confirmer · edit_file replace_all et fins de ligne CRLF : identique à ce que l\'outil écrira', async () => {
  cfg.mode = 'ask';
  const asked = [];
  setSelectHandler(answering(asked, 'Accepter'), { proposals: true });
  const f = fresh('x = 1\r\ny = x\r\n');
  await execCall(session(), { name: 'edit_file', args: { path: f, old_string: 'x', new_string: 'z', replace_all: true } }, io());
  assert.equal(asked[0].proposal.after, 'z = 1\r\ny = z\r\n');
  assert.equal(fs.readFileSync(f, 'utf8'), asked[0].proposal.after);
});

test('modes auto et « accepter les modifications » : aucune confirmation, fichiers écrits directement', async () => {
  for (const mode of ['auto', 'edits']) {
    cfg.mode = mode;
    const asked = [];
    setSelectHandler(answering(asked, 'Accepter'), { proposals: true });
    const f = fresh('un\n');
    assert.equal((await execCall(session(), { name: 'edit_file', args: { path: f, old_string: 'un', new_string: 'deux' } }, io())).ok, true);
    const g = fresh();
    assert.equal((await execCall(session(), { name: 'write_file', args: { path: g, content: 'trois' } }, io())).ok, true);
    assert.equal(asked.length, 0, `mode ${mode} : aucune question`);
    assert.equal(fs.readFileSync(f, 'utf8'), 'deux\n');
    assert.equal(fs.readFileSync(g, 'utf8'), 'trois');
  }
});

test('terminal (sans proposals) : questions inchangées « Oui / Non », pas de contenu joint', async () => {
  cfg.mode = 'ask';
  const asked = [];
  setSelectHandler(answering(asked, 'Oui'));
  const f = fresh();
  await execCall(session(), { name: 'write_file', args: { path: f, content: 'x' } }, io());
  assert.equal(asked[0].options[0], 'Oui');
  assert.equal(asked[0].options.at(-1), 'Non');
  assert.equal(asked[0].proposal, undefined);
});

test('proposedChange : rien pour un fichier trop gros, binaire, ou un remplacement impossible', () => {
  const big = fresh('x'.repeat(PROPOSAL_MAX + 1));
  assert.equal(proposedChange('edit_file', { path: big, old_string: 'x', new_string: 'y', replace_all: true }, work), null);
  assert.equal(proposedChange('write_file', { path: fresh(), content: 'y'.repeat(PROPOSAL_MAX + 1) }, work), null);
  const bin = fresh(); fs.writeFileSync(bin, Buffer.from([1, 0, 2]));
  assert.equal(proposedChange('write_file', { path: bin, content: 'x' }, work), null);
  const f = fresh('a a');
  assert.equal(proposedChange('edit_file', { path: f, old_string: 'a', new_string: 'b' }, work), null);      // ambigu : l'outil échouera
  assert.equal(proposedChange('edit_file', { path: f, old_string: 'zz', new_string: 'b' }, work), null);    // introuvable
  assert.equal(proposedChange('shell', { command: 'ls' }, work), null);
  assert.deepEqual(proposedChange('write_file', { path: 'rel.txt', content: 'r' }, work), { path: path.join(work, 'rel.txt'), before: '', after: 'r', created: true });
});

test('StdioInput : la proposition part avec l\'événement select (et seulement si elle est valide)', async () => {
  const { StdioInput } = await import('../src/stdio.js');
  const writes = [], orig = process.stdout.write;
  process.stdout.write = s => { writes.push(String(s)); return true; };
  let inp;
  try {
    inp = new StdioInput();
    inp.select({ title: 'write_file demande ton accord', options: ['Accepter', 'Refuser'], proposal: { path: '/p/index.html', before: 'a', after: 'b', created: false } });
    const ev = JSON.parse(writes.at(-1).slice(1));
    assert.deepEqual(ev.proposal, { path: '/p/index.html', before: 'a', after: 'b', created: false });
    inp.select({ title: 'Continuer ?', options: ['Oui', 'Non'] });
    assert.equal('proposal' in JSON.parse(writes.at(-1).slice(1)), false);
  } finally { process.stdout.write = orig; inp?.stop(); }
});
