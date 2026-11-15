// Images : chemins glissés-déposés détectés, Alt+V / Ctrl+V déclenchent le collage d'image dans l'interface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeStreams } from './term-sim.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-img-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { extractImagePaths, mimeOf, IMAGE_RE } = await import('../src/images.js');
const { Tui } = await import('../src/tui/tui.js');

const dir = path.join(tmp, 'Mes captures'); fs.mkdirSync(dir);
const a = path.join(dir, 'écran 1.png'); fs.writeFileSync(a, 'x');
const b = path.join(tmp, 'photo.JPG'); fs.writeFileSync(b, 'x');

test('glisser-déposer : chemins d\'images (avec espaces, entre guillemets ou non) → [Image #n]', () => {
  const r = extractImagePaths(`regarde "${a}" et ${b} stp`);
  assert.deepEqual(r.paths, [a, b]);
  assert.equal(r.text, 'regarde [Image #1] et [Image #2] stp');
  const r2 = extractImagePaths(`'${a}'`, 3);
  assert.equal(r2.text, '[Image #4]', 'numérotation qui suit les images déjà en attente');
});

test('glisser-déposer : rien d\'inventé (fichier absent, pas une image, simple mot)', () => {
  const t = `C:\\nexiste\\pas.png ${path.join(tmp, 'notes.txt')} logo.png`;
  const r = extractImagePaths(t);
  assert.deepEqual(r.paths, []); assert.equal(r.text, t);
});

test('types d\'images', () => {
  assert.equal(mimeOf('a.png'), 'image/png'); assert.equal(mimeOf('b.JPEG'), 'image/jpeg'); assert.equal(mimeOf('c.webp'), 'image/webp');
  assert.ok(IMAGE_RE.test('x.gif')); assert.ok(!IMAGE_RE.test('x.svg.txt'));
});

test('interface : Alt+V et Ctrl+V demandent le collage d\'une image', () => {
  const f = fakeStreams(60, 20);
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, history: [] });
  let n = 0; tui.on('pasteImage', () => n++);
  tui.start();
  f.stdin.emit('data', Buffer.from('\x1bv'));     // Alt+V
  f.stdin.emit('data', Buffer.from('\x16'));      // Ctrl+V (quand le terminal ne colle pas de texte)
  assert.equal(n, 2);
  tui.insert('[Image #1] ');
  assert.equal(tui.buf, '[Image #1] ');
  tui.stop();
});
