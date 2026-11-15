// Menus de confirmation dans l'interface (vraies commandes PowerShell, dossiers temporaires)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStreams } from './term-sim.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-test-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

const { Tui } = await import('../src/tui/tui.js');
const ui = await import('../src/ui.js');
const { runBlock, setSelectHandler } = await import('../src/agent.js');
const { detectEnv } = await import('../src/tools.js');
const { cfg } = await import('../src/config.js');
await detectEnv();

const ESC = '\x1b';
function setup() {
  const f = fakeStreams(90, 30);
  const tui = new Tui({ stdin: f.stdin, stdout: f.stdout });
  tui.setStatus({ model: 'test', mode: 'auto' });
  tui.start();
  ui.attachSink({ print: t => tui.print(t), spinner: s => tui.spinner(s) });
  setSelectHandler(o => tui.select(o));
  const ask = q => tui.askLine(q);
  return { ...f, tui, ask };
}
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };

test('suppression : menu → Non (avec raison) garde le fichier, « toujours » enregistre une règle', { skip: process.platform !== 'win32' && 'commandes PowerShell (Windows)' }, async () => {
  const { sim, type, tui, ask } = setup();
  const dir = fs.mkdtempSync(path.join(tmp, 'w-'));
  fs.writeFileSync(path.join(dir, 'x.txt'), 'a'); fs.writeFileSync(path.join(dir, 'y.txt'), 'b');
  const S = { cwd: dir, undo: [], allow: {}, pendingResults: [] };
  const io = { signal: new AbortController().signal, ask, auto: true };
  const block = f => ({ action: 'shell', lang: 'powershell', code: 'Remove-Item .' + String.fromCharCode(92) + f });

  // 1) menu affiché, 3 options (Oui / Oui + règle / Non), « Non » par défaut ; on choisit Non puis on écrit une raison
  let p = runBlock(S, block('x.txt'), io);
  assert.ok(await waitFor(() => /Action sensible/.test(sim.screen())), 'menu visible');
  assert.match(sim.screen(), /1\. Oui/); assert.match(sim.screen(), /2\. Oui, et ne plus demander \(règle enregistrée\)/); assert.match(sim.screen(), /❯ 3\. Non/);
  type('\r');                                                        // Entrée sur « Non » (défaut)
  assert.ok(await waitFor(() => /raison \/ alternative/.test(sim.screen())), 'question de la raison');
  type('garde-le'); type('\r');
  const r1 = await p;
  assert.equal(r1.ok, false); assert.ok(fs.existsSync(path.join(dir, 'x.txt')), 'x.txt conservé');
  assert.match(S.pendingResults[0], /garde-le/);

  // 2) « Oui, et ne plus demander » → exécuté, règle enregistrée
  p = runBlock(S, block('x.txt'), io);
  assert.ok(await waitFor(() => /Action sensible/.test(sim.screen())));
  type('2');
  const r2 = await p;
  assert.equal(r2.ok, true); assert.ok(!fs.existsSync(path.join(dir, 'x.txt')), 'x.txt supprimé');

  // 3) la règle évite le menu
  S.pendingResults = [];
  const r3 = await runBlock(S, block('y.txt'), io);
  assert.equal(r3.ok, true); assert.ok(!fs.existsSync(path.join(dir, 'y.txt')));
  assert.doesNotMatch(sim.screen(), /Action sensible/);
  tui.stop();
});

test('commande refusée par la politique : aucun menu', { skip: process.platform !== 'win32' && 'commandes PowerShell (Windows)' }, async () => {
  const { sim, tui, ask } = setup();
  const S = { cwd: tmp, undo: [], allow: {}, pendingResults: [] };
  const r = await runBlock(S, { action: 'shell', lang: 'powershell', code: 'Format-Volume -DriveLetter D' }, { signal: new AbortController().signal, ask, auto: true });
  await new Promise(res => setImmediate(res)); await new Promise(res => setImmediate(res));
  assert.equal(r.ok, false); assert.doesNotMatch(sim.screen(), /1\. Oui/);
  assert.match(sim.all(), /refusé par la politique de sécurité/);
  tui.stop();
});

test('secret détecté : menu à 2 options, Échap = fichier non écrit', async () => {
  const { sim, type, tui, ask } = setup();
  const dir = fs.mkdtempSync(path.join(tmp, 'w-'));
  const S = { cwd: dir, undo: [], allow: {}, pendingResults: [] };
  const fake = 'const K = "sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";'; // scan-ignore
  const p = runBlock(S, { action: 'write', name: 'cfg.js', code: fake }, { signal: new AbortController().signal, ask, auto: true });
  assert.ok(await waitFor(() => /Secret détecté/.test(sim.screen())));
  assert.match(sim.screen(), /1\. Oui/); assert.match(sim.screen(), /2\. Non/); assert.doesNotMatch(sim.screen(), /règle/);
  type(ESC);
  const r = await p;
  assert.equal(r.ok, false); assert.ok(!fs.existsSync(path.join(dir, 'cfg.js')));
  tui.stop();
});

test('Ctrl+C dans un menu : refus + interruption', { skip: process.platform !== 'win32' && 'commandes PowerShell (Windows)' }, async () => {
  const { sim, type, tui, ask } = setup();
  let interrupted = 0; tui.on('interrupt', () => interrupted++);
  const dir = fs.mkdtempSync(path.join(tmp, 'w-'));
  fs.writeFileSync(path.join(dir, 'z.txt'), 'z');
  const ac = new AbortController(); tui.on('interrupt', () => ac.abort());
  const S = { cwd: dir, undo: [], allow: {}, pendingResults: [] };
  const p = runBlock(S, { action: 'shell', lang: 'powershell', code: 'Remove-Item .' + String.fromCharCode(92) + 'z.txt' }, { signal: ac.signal, ask, auto: true });
  assert.ok(await waitFor(() => /Action sensible/.test(sim.screen())));
  type('\x03');
  await assert.rejects(p, e => e.name === 'AbortError');
  assert.equal(interrupted, 1); assert.ok(fs.existsSync(path.join(dir, 'z.txt')));
  tui.stop();
});

test('mode plan : saisie et état affichés', async () => {
  const { sim, tui } = setup();
  tui.setStatus({ mode: 'plan' }); await new Promise(r => setImmediate(r));
  assert.match(sim.screen(), /◇ plan/);
  tui.setStatus({ mode: 'ask' }); await new Promise(r => setImmediate(r));
  assert.match(sim.screen(), /⏸ confirmer/);
  tui.stop();
});
