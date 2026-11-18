// macOS : presse-papiers image (osascript), couleurs 256 si pas de 24 bits, chemins glissés avec antislashs,
// HEIC / captures Retina (sips), marque de fin de collage coupée, aide « ? ». Aucun vrai outil lancé : spawnSync simulé.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeStreams } from './term-sim.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-mac-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const img = await import('../src/images.js');
const ui = await import('../src/ui.js');
const { KeyParser } = await import('../src/tui/keys.js');
const { Tui } = await import('../src/tui/tui.js');

/** spawnSync simulé : enregistre les appels ; `script(cmd, args)` renvoie { status, stdout } et peut écrire des fichiers. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return { status: 1, stdout: '', ...(script(cmd, args) || {}) }; };
  return { spawn, calls };
}
const pngTarget = args => /POSIX file "((?:[^"\\]|\\.)*)"/.exec(args.join('\n'))[1].replace(/\\(.)/g, '$1');

// ── couleurs ────────────────────────────────────────────────────────────────
test('couleurs : 24 bits si le terminal le gère, sinon palette 256 (Terminal.app)', () => {
  assert.equal(ui.sgr(38, [240, 105, 105], 24), '\x1b[38;2;240;105;105m');
  assert.equal(ui.sgr(48, [44, 47, 58], 24), '\x1b[48;2;44;47;58m');
  assert.equal(ui.sgr(38, [240, 105, 105], 8), '\x1b[38;5;203m');
  assert.equal(ui.sgr(48, [44, 47, 58], 8), '\x1b[48;5;236m', 'gris foncé → rampe de gris, pas un bleu marine');
  assert.equal(ui.rgb256([255, 0, 0]), 196); assert.equal(ui.rgb256([0, 0, 0]), 16); assert.equal(ui.rgb256([255, 255, 255]), 231);
  assert.equal(ui.rgb256([128, 134, 146]), 102);
  for (const t of Object.values(ui.THEMES)) {                         // amber / matrix : plus de « 0 » lu comme remise à zéro
    const s = ui.sgr(38, t, 8);
    assert.match(s, /^\x1b\[38;5;\d+m$/); const n = +s.match(/;(\d+)m$/)[1]; assert.ok(n >= 16 && n <= 255);
  }
  for (const d of [1, 4, 8]) assert.ok(!ui.sgr(48, [72, 26, 30], d).includes(';2;'));
});

test('couleurs : hors terminal le 24 bits reste (tests, panneau) et plus aucune séquence 24 bits écrite en dur', () => {
  assert.equal(ui.COLOR_DEPTH, 24);
  assert.ok(ui.c.red('x').startsWith('\x1b[38;2;'));
  const src = fs.readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
  assert.ok(!/\\x1b\[(?:38|48);2;\d/.test(src), 'les fonds du code, des tableaux et du diff passent par bg()');});

// ── chemins glissés-déposés ─────────────────────────────────────────────────
// Chemin POSIX vers un fichier du dossier temporaire (sous Windows : même lecteur, sans la lettre)
const posix = p => (process.platform === 'win32' ? p.slice(2).replace(/\\/g, '/') : p);
const posixOk = process.platform !== 'win32' || path.resolve('/').toLowerCase() === tmp.slice(0, 3).toLowerCase();
const esc = p => p.replace(/[ ()'&]/g, '\\$&');

const capDir = path.join(tmp, 'Mon Projet (copie)'); fs.mkdirSync(capDir);
const cap = path.join(capDir, 'Capture d’écran 2026-11-17 à 10.23.45.png'); fs.writeFileSync(cap, 'x');
const cap2 = path.join(tmp, 'Screenshot 2026-11-17 at 10.23.45 AM.png'); fs.writeFileSync(cap2, 'x');

test('glisser-déposer Mac : chemin avec « \\ » (et U+202F) reconnu comme image', { skip: !posixOk && 'lecteur différent' }, () => {
  const never = () => { throw new Error('aucun outil à lancer pour un PNG léger'); };
  const t = `regarde ${esc(posix(cap))} et ${esc(posix(cap2))}, stp`;
  for (const platform of ['darwin', 'linux']) {
    const r = img.extractImagePaths(t, 0, { platform, spawn: never });
    assert.equal(r.text, 'regarde [Image #1] et [Image #2], stp', platform);
    assert.deepEqual(r.paths.map(p => p.normalize()), [path.resolve(posix(cap)), path.resolve(posix(cap2))]);
  }
  const absent = `${esc(posix(path.join(tmp, 'pas là.png')))} ok`;
  assert.equal(img.extractImagePaths(absent, 0, { platform: 'darwin' }).text, absent, 'rien d\'inventé');
  assert.equal(img.quoteEscapedPaths(absent, 'darwin'), absent);
});

test('glisser-déposer : Windows inchangé (pas de déséchappement « \\ »)', () => {
  const t = `vois ${esc(posix(cap))}`;
  assert.equal(img.quoteEscapedPaths(t, 'win32'), t);
  assert.deepEqual(img.extractImagePaths(t, 0, { platform: 'win32' }).paths, []);
  const r = img.extractImagePaths(`"${cap}"`, 0, { platform: 'win32' });      // forme Windows Terminal (guillemets) toujours gérée
  assert.deepEqual(r.paths, [cap]);
});

// ── HEIC et grandes captures (sips) ─────────────────────────────────────────
const heic = path.join(tmp, 'IMG_0001.HEIC'); fs.writeFileSync(heic, 'x');
const big = path.join(tmp, 'grande capture.png'); fs.writeFileSync(big, ''); fs.truncateSync(big, img.MAX_IMAGE_BYTES + 1);
const sipsOk = () => fakeSpawn((cmd, args) => { if (cmd === 'sips') { fs.writeFileSync(args.at(-1), 'jpg'); return { status: 0 }; } });

test('Mac : HEIC et image > 10 Mo convertis en JPEG par sips ; Windows inchangé', () => {
  let f = sipsOk();
  const out = img.prepareImage(heic, { platform: 'darwin', spawn: f.spawn });
  assert.match(out, /IMG_0001-.*\.jpg$/); assert.ok(fs.existsSync(out));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].cmd, 'sips');
  assert.deepEqual(f.calls[0].args, img.sipsArgs(heic, out));
  assert.deepEqual(f.calls[0].args.slice(0, 8), ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '2560']);
  f = sipsOk();
  assert.match(img.prepareImage(big, { platform: 'darwin', spawn: f.spawn }), /\.jpg$/);
  assert.equal(img.prepareImage(big, { platform: 'win32', spawn: () => { throw new Error('non'); } }), big);
  assert.equal(img.prepareImage(cap, { platform: 'darwin', spawn: () => { throw new Error('non'); } }), cap, 'PNG léger : rien à faire');
  const ko = fakeSpawn(() => ({ status: 1 }));
  assert.equal(img.prepareImage(heic, { platform: 'darwin', spawn: ko.spawn }), null, 'HEIC non converti : pas envoyé');
  assert.equal(img.prepareImage(big, { platform: 'darwin', spawn: ko.spawn }), big, 'trop lourde non convertie : cli.js prévient');
  assert.ok(img.isImagePath('a.heic', 'darwin') && !img.isImagePath('a.heic', 'win32') && !img.IMAGE_RE.test('a.heic'));
});

test('Mac : photo HEIC glissée → [Image #1] en JPEG ; ignorée ailleurs', () => {
  const f = sipsOk();
  const r = img.extractImagePaths(`"${heic}"`, 0, { platform: 'darwin', spawn: f.spawn });
  assert.equal(r.text, '[Image #1]'); assert.match(r.paths[0], /\.jpg$/);
  assert.deepEqual(img.extractImagePaths(`"${heic}"`, 0, { platform: 'win32' }).paths, []);
});

// ── presse-papiers Mac (osascript) ──────────────────────────────────────────
test('presse-papiers Mac : capture d\'écran écrite en PNG par osascript (sans pngpaste)', () => {
  const f = fakeSpawn((cmd, args) => {
    if (cmd === 'osascript' && args.join(' ').includes('«class furl»')) return { status: 1 };
    if (cmd === 'osascript') { fs.writeFileSync(pngTarget(args), 'png'); return { status: 0, stdout: 'ok\n' }; }
  });
  const p = img.grabClipboardImage({ platform: 'darwin', spawn: f.spawn });
  assert.ok(p && p.startsWith(path.join(process.env.FS_CLI_HOME, 'images')) && fs.readFileSync(p, 'utf8') === 'png');
  assert.deepEqual(f.calls.map(c => c.cmd), ['osascript', 'osascript'], 'pngpaste jamais lancé');
  assert.deepEqual(f.calls[0].args, img.macFileUrlArgs());
  assert.deepEqual(f.calls[1].args, img.macPngArgs(p));
  assert.ok(f.calls[1].args.includes('set d to (the clipboard as «class PNGf»)'));
});

test('presse-papiers Mac : fichier image copié dans le Finder → ce fichier (pas son icône)', () => {
  const f = fakeSpawn(cmd => (cmd === 'osascript' ? { status: 0, stdout: cap + '\n' } : {}));
  assert.equal(img.grabClipboardImage({ platform: 'darwin', spawn: f.spawn }), cap);
  assert.equal(f.calls.length, 1);
  const txt = path.join(tmp, 'notes.txt'); fs.writeFileSync(txt, 'x');
  const g = fakeSpawn(cmd => (cmd === 'osascript' ? { status: 0, stdout: txt + '\n' } : {}));
  assert.equal(img.grabClipboardImage({ platform: 'darwin', spawn: g.spawn }), null, 'autre fichier : rien (sinon icône collée)');
  assert.equal(g.calls.length, 1);
  const h = fakeSpawn((cmd, args) => {
    if (cmd === 'osascript') return { status: 0, stdout: heic };
    if (cmd === 'sips') { fs.writeFileSync(args.at(-1), 'jpg'); return { status: 0 }; }
  });
  assert.match(img.grabClipboardImage({ platform: 'darwin', spawn: h.spawn }), /\.jpg$/, 'photo HEIC copiée → JPEG');
});

test('presse-papiers Mac : pngpaste en dernier recours, sinon null', () => {
  const f = fakeSpawn((cmd, args) => {
    if (cmd === 'osascript') return args.join(' ').includes('furl') ? { status: 1 } : { status: 0, stdout: 'none' };
    if (cmd === 'pngpaste') { fs.writeFileSync(args[0], 'png'); return { status: 0 }; }
  });
  assert.ok(img.grabClipboardImage({ platform: 'darwin', spawn: f.spawn }));
  assert.deepEqual(f.calls.map(c => c.cmd), ['osascript', 'osascript', 'pngpaste']);
  const none = fakeSpawn(() => ({ status: 1 }));
  assert.equal(img.grabClipboardImage({ platform: 'darwin', spawn: none.spawn }), null);
  const enoent = fakeSpawn(() => ({ status: null, error: new Error('ENOENT') }));
  assert.equal(img.grabClipboardImage({ platform: 'darwin', spawn: enoent.spawn }), null);
});

test('presse-papiers : guillemets et antislashs échappés dans le script AppleScript ; Windows toujours via PowerShell', () => {
  const a = img.macPngArgs('/Users/a/x"y\\z.png').join('\n');
  assert.ok(a.includes('POSIX file "/Users/a/x\\"y\\\\z.png"'));
  const w = fakeSpawn(() => ({ status: 0, stdout: '' }));
  assert.equal(img.grabClipboardImage({ platform: 'win32', spawn: w.spawn }), null);
  assert.deepEqual(w.calls.map(c => c.cmd), ['powershell.exe']);
});

// ── collage « bracketed » ───────────────────────────────────────────────────
test('collage : marque de fin coupée entre deux morceaux → le clavier répond encore', () => {
  const END = '\x1b[201~';
  for (let k = 1; k < END.length; k++) {
    const keys = []; const p = new KeyParser(e => keys.push(e));
    p.feed('\x1b[200~bonjour' + END.slice(0, k));
    assert.deepEqual(keys, [], `coupure ${k} : rien avant la fin`);
    p.feed(END.slice(k) + '\r');
    assert.deepEqual(keys, [{ name: 'paste', text: 'bonjour' }, { name: 'enter' }], `coupure ${k}`);
    assert.equal(p.pasting, false);
    p.feed('\x03'); assert.deepEqual(keys.at(-1), { name: 'c', ctrl: true });
  }
  const keys = []; const p = new KeyParser(e => keys.push(e));
  p.feed('\x1b[200~a'); p.feed('b\x1b['); p.feed('2'); p.feed('01~x');
  assert.deepEqual(keys, [{ name: 'paste', text: 'ab' }, { name: 'text', text: 'x' }], 'marque coupée en trois');
  const k2 = []; const q = new KeyParser(e => k2.push(e));
  q.feed('\x1b[200~a\x1b[2'); q.feed('x' + END);
  assert.deepEqual(k2, [{ name: 'paste', text: 'a\x1b[2x' }], 'faux début de marque : gardé dans le texte collé');
});

// ── aide « ? » ──────────────────────────────────────────────────────────────
test('aide « ? » : bonne touche d\'image selon le système, Ctrl+L indiqué et redessin complet', async () => {
  assert.equal(ui.PASTE_IMAGE_KEY, process.platform === 'darwin' ? 'ctrl+v' : 'alt+v');
  const f = fakeStreams(100, 30);
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout, history: [] });
  tui.start();
  f.type('?'); await f.tick();
  const s = f.sim.screen();
  assert.ok(s.includes(ui.PASTE_IMAGE_KEY + ' ') && s.includes('coller une image'));
  assert.match(s, /ctrl\+l\s+effacer et redessiner/);
  f.type('\x7f'); tui.print('vieux texte\n'); await f.tick();
  assert.match(f.sim.screen(), /vieux texte/);
  f.type('\x0c'); await f.tick();                                    // Ctrl+L
  assert.doesNotMatch(f.sim.screen(), /vieux texte/);
  assert.match(f.sim.screen(), /╭─/, 'zone de saisie redessinée');
  tui.stop();
});
