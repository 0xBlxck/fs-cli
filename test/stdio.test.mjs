// Mode --stdio (extension VS Code) : événements structurés au lieu du dessin terminal, questions par identifiant
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-stdio-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const ui = await import('../src/ui.js');

test('affichage branché sur des événements : texte brut, actions, diff, notes', () => {
  const ev = [];
  ui.attachSink({ print: t => ev.push(['print', t]), spinner: () => {}, event: (type, data) => ev.push([type, data]) });
  try {
    const md = new ui.MdStream();
    md.push('# Titre\n**gras** \x1b]0;pirate\x07ok'); md.finish();
    ui.toolHeader('read_file', 'a.js'); assert.equal(ui.toolDone(true), false);   // exploration réussie : sortie masquée
    ui.toolHeader('shell', 'npm test'); const live = ui.createLive(); live.push('ligne 1\nligne 2\n'); live.end(); assert.equal(ui.toolDone(false), true);
    ui.toolBody('sortie\n', { error: true });
    ui.toolNote('\x1b[32mvert\x1b[39m', 'green');
    ui.diffView('a\nb\nc', 'a\nB\nc');
    ui.spinner.start('travail…'); ui.spinner.stop();
    const types = ev.map(e => e[0]);
    assert.deepEqual(types.filter(t => t !== 'print'), ['text', 'textEnd', 'tool', 'toolDone', 'tool', 'toolLive', 'toolLive', 'toolDone', 'toolOutput', 'note', 'diff', 'spinner', 'spinner']);
    const text = ev.find(e => e[0] === 'text')[1].delta;
    assert.equal(text, '# Titre\n**gras** ok');                                // markdown brut, séquences de contrôle retirées
    assert.deepEqual(ev.find(e => e[0] === 'tool')[1], { name: 'read_file', tag: '◇', label: 'Lire', detail: 'a.js', explore: true });
    assert.equal(ev.find(e => e[0] === 'note')[1].text, 'vert');
    const d = ev.find(e => e[0] === 'diff')[1];
    assert.deepEqual([d.added, d.removed], [1, 1]);
    assert.deepEqual(d.lines.map(l => l && l.t), [' ', '-', '+', ' ']);
  } finally { ui.attachSink(null); }
});

test('StdioInput : un événement JSON par ligne (préfixe \\x1e), réponses aux menus par identifiant', async () => {
  const { StdioInput } = await import('../src/stdio.js');
  const writes = [];
  const orig = process.stdout.write;
  process.stdout.write = s => { writes.push(String(s)); return true; };
  let inp;
  try {
    inp = new StdioInput();
    const got = [];
    inp.on('submit', t => got.push(t));
    inp.setStatus({ mode: 'auto' });
    const p = inp.select({ title: 'Continuer ?', options: ['Oui', 'Non'] });
    const sel = JSON.parse(writes.at(-1).slice(1));
    assert.equal(writes.at(-1)[0], '\x1e');
    assert.equal(sel.type, 'select');
    inp.onLine(JSON.stringify({ type: 'select', id: sel.id, index: 1 }));
    assert.equal(await p, 1);
    const q = inp.select({ title: 'Encore ?', options: ['Oui'] });
    inp.onLine(JSON.stringify({ type: 'select', id: JSON.parse(writes.at(-1).slice(1)).id, index: -1 }));
    assert.equal(await q, null);                                                // refus (Échap) → null comme dans le terminal
    inp.onLine('pas du json'); inp.onLine(JSON.stringify({ type: 'submit', text: 'bonjour' }));
    inp.setBusy(true); inp.onLine(JSON.stringify({ type: 'submit', text: 'après' }));
    assert.deepEqual(got, ['bonjour']);
    assert.equal(inp.takeQueued(), 'après');                                   // pendant le travail : mis en file
  } finally { process.stdout.write = orig; inp?.stop(); }
});
