// write_file du modèle avec du code minifié sur une ligne (vu en vrai : index.html de GPT en 1 ligne) → remis en forme
// sur le PC (CLI, panneau) et dans `fs claude` (Write de Claude Code), avec une note pour le modèle ; le reste intact.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-prettywrite-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { runNative } = await import('../src/native.js');
const { detectEnv } = await import('../src/tools.js');
const { planToolUses } = await import('../src/gateway/toolmap.js');
const { PRETTY_NOTE } = await import('../src/prettify.js');
await detectEnv();

const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Cathédrale</title><style>body{margin:0;background:#000}canvas{display:block}</style></head><body><div id="hud"><p>Course <b>live</b></p><p>Pays en tête : <span id="lead">aucun</span></p></div><canvas id="c"></canvas><script>const c=document.getElementById("c");let t=0;function loop(){t++;if(t%60===0){console.log(t)}requestAnimationFrame(loop)}loop();</script></body></html>';

function fakeFs(turns) {
  const st = { reqs: [], i: 0 };
  const stream = async o => {
    st.reqs.push({ toolResults: o.toolResults });
    if (!o.chatId) o.onChat?.('chat-1');
    const t = turns[st.i++] || { text: 'fin' };
    return { text: t.text || '', usage: null, toolCalls: t.calls || [], documents: [] };
  };
  return { st, stream };
}
const io = () => ({ signal: new AbortController().signal, ask: async () => 'o', ctxPct: async () => null });

test('CLI / panneau : write_file d\'une page HTML sur une ligne → fichier sur plusieurs lignes, même code, note au modèle', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const S = { chatId: null, sid: 'abcd', agentId: -2003, cwd: dir, targetDir: null, undo: [], allow: {}, pendingResults: [], notes: [], tokens: { in: 0, out: 0 }, slots: {} };
  const f = fakeFs([
    { calls: [{ callId: 'w1', name: 'write_file', arguments: { path: 'index.html', content: PAGE } }, { callId: 'w2', name: 'write_file', arguments: { path: 'notes.txt', content: 'x'.repeat(500) } }] },
    { text: 'ok' },
  ]);
  await runNative(S, 'fais la page', { ...io(), stream: f.stream });
  const written = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(written.split('\n').length > 10, 'sur plusieurs lignes');
  assert.equal(written.replace(/\s+/g, ''), PAGE.replace(/\s+/g, ''), 'seuls des espaces ajoutés');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'x'.repeat(500), 'autres fichiers intacts');
  const [r1, r2] = f.st.reqs[1].toolResults;
  assert.ok(r1.output.includes(PRETTY_NOTE), 'le modèle est prévenu');
  assert.ok(!r2.output.includes(PRETTY_NOTE));
});

test('fs claude : write_file d\'une page sur une ligne → Write de Claude Code reçoit le contenu remis en forme, avec la note', () => {
  const tools = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'].map(name => ({ name, input_schema: { type: 'object' } }));
  const ctx = { env: { cwd: 'C:\proj', platform: 'win32' }, tools, readSet: { sessionId: 's', paths: {} }, sessionId: 's', fsExists: () => false, chatId: 'chat-1' };
  const r = planToolUses([
    { callId: 'a', name: 'write_file', arguments: { path: 'index.html', content: PAGE } },
    { callId: 'b', name: 'write_file', arguments: { path: 'lib.min.js', content: 'var a=1;'.repeat(80) } },
  ], ctx);
  const [w1, w2] = r.uses.filter(u => u.name === 'Write');
  assert.ok(w1.input.content.split('\n').length > 10);
  assert.equal(w1.input.content.replace(/\s+/g, ''), PAGE.replace(/\s+/g, ''));
  assert.equal(r.pending[0].note, PRETTY_NOTE);
  assert.equal(w2.input.content, 'var a=1;'.repeat(80), '.min.js jamais touché');
  assert.equal(r.pending[1].note, undefined);
});
