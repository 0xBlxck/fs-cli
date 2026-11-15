// Mode « modifs auto », bilan des fichiers modifiés, annulation fichier par fichier, alerte d'attente
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStreams } from './term-sim.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-changes-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');

const { summarizeChanges, fileDiff, undoFile, changeLine } = await import('../src/changes.js');
const { needsConfirm } = await import('../src/agent.js');
const { cfg } = await import('../src/config.js');
const { Tui } = await import('../src/tui/tui.js');
const ui = await import('../src/ui.js');

const plain = { green: s => s, red: s => s, dim: s => s, yellow: s => s, accent: s => s };

test('mode edits : écritures sans confirmation, commandes confirmées, danger toujours confirmé', () => {
  const prev = cfg.mode;
  try {
    cfg.mode = 'edits';
    assert.equal(needsConfirm({ kind: 'write' }, { allow: {} }), false);
    assert.equal(needsConfirm({ kind: 'exec' }, { allow: {} }), true);
    assert.equal(needsConfirm({ kind: 'read' }, { allow: {} }), false);
    assert.equal(needsConfirm({ kind: 'write', protectedPath: true }, { allow: {} }), true);
    assert.equal(needsConfirm({ kind: 'exec', danger: true }, { allow: {} }), true);
    cfg.mode = 'ask';
    assert.equal(needsConfirm({ kind: 'write' }, { allow: {} }), true);
    cfg.mode = 'auto';
    assert.equal(needsConfirm({ kind: 'exec' }, { allow: {} }), false);
  } finally { cfg.mode = prev; }
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const a = path.join(dir, 'a.txt'), b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'un\ndeux\ntrois\n');
  const S = { undo: [], turnMarks: [{ at: 0, text: 'x', t: 0 }] };
  // a modifié deux fois, b créé
  S.undo.push({ path: a, prev: fs.readFileSync(a) }); fs.writeFileSync(a, 'un\nDEUX\ntrois\n');
  S.undo.push({ path: b, prev: null }); fs.writeFileSync(b, 'nouveau\nfichier\n');
  S.undo.push({ path: a, prev: fs.readFileSync(a) }); fs.writeFileSync(a, 'un\nDEUX\ntrois\nquatre\n');
  S.turnMarks.push({ at: 3, text: 'y', t: 1 });
  return { dir, a, b, S };
}

test('bilan : fichiers regroupés, lignes +/− comptées depuis la 1re modification', () => {
  const { dir, a, b, S } = workspace();
  const files = summarizeChanges(S.undo, 0);
  assert.equal(files.length, 2);
  const fa = files.find(f => f.path === a), fb = files.find(f => f.path === b);
  assert.deepEqual([fa.edits, fa.added, fa.removed, fa.created], [2, 2, 1, false]);
  assert.deepEqual([fb.added, fb.removed, fb.created], [2, 0, true]);
  assert.match(changeLine(fa, dir, plain), /a\.txt {2}\+2 −1/);
  assert.match(changeLine(fb, dir, plain), /créé/);
  assert.equal(fileDiff(S.undo, a).before, 'un\ndeux\ntrois\n');
  assert.equal(summarizeChanges(S.undo, 3).length, 0);
});

test('annuler un seul fichier : les autres restent, repères /rewind recalés, créé → corbeille', () => {
  const { a, b, S } = workspace();
  const trash = path.join(tmp, 'trash');
  const msg = undoFile(S, a, trash);
  assert.match(msg, /restauré/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'un\ndeux\ntrois\n');
  assert.equal(fs.readFileSync(b, 'utf8'), 'nouveau\nfichier\n');     // b intact
  assert.equal(S.undo.length, 1);
  assert.equal(S.turnMarks[1].at, 1);
  const m2 = undoFile(S, b, trash);
  assert.match(m2, /corbeille|retiré/);
  assert.equal(fs.existsSync(b), false);
  assert.ok(fs.readdirSync(trash).some(n => n.endsWith('b.txt')));       // jamais supprimé : déplacé
  assert.equal(undoFile(S, b, trash), null);
});

test('alerte : bip + état « attention » Windows Terminal pendant un menu, puis retour', async () => {
  const f = fakeStreams(90, 30);
  let raw = ''; const w = f.stdout.write; f.stdout.write = x => { raw += x; return w(x); };
  const prevWt = process.env.WT_SESSION; process.env.WT_SESSION = 'test';
  try {
    const tui = new Tui({ stdin: f.stdin, stdout: f.stdout });
    tui.setStatus({ model: 'test', mode: 'auto' });
    tui.start();
    ui.attachSink({ print: t => tui.print(t), spinner: s => tui.spinner(s) });
    const p = tui.select({ title: 'Continuer ?', options: ['Oui', 'Non'] });
    await new Promise(r => setTimeout(r, 20));
    assert.ok(raw.includes('\x07'));
    assert.ok(raw.includes('\x1b]9;4;4;100\x07'));
    f.type('\r'); await f.tick();
    assert.equal(await p, 0);
    assert.ok(raw.includes('\x1b]9;4;0;0\x07'));
    tui.stop?.();
  } finally { if (prevWt === undefined) delete process.env.WT_SESSION; else process.env.WT_SESSION = prevWt; }
});
