// Accueil du terminal : les nouveautés passent à la ligne comme dans Claude Code (avant : coupées avec « … »).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FS_CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-welcome-'));
const ui = await import('../src/ui.js');
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('wrapLines : retour à la ligne aux espaces, au plus n lignes (la dernière finit par « … »)', () => {
  assert.deepEqual(ui.wrapLines('un deux trois quatre cinq', 10), ['un deux', 'trois', 'quatre', 'cinq']);
  assert.deepEqual(ui.wrapLines('un deux trois quatre cinq six sept', 10, 2), ['un deux', 'trois…']);
  assert.ok(ui.wrapLines('x'.repeat(50), 12).every(l => l.length <= 12), 'mot très long coupé');
  assert.deepEqual(ui.wrapLines('', 10), ['']);
});

test('splitBox : une nouveauté longue passe à la ligne (lignes de suite décalées), rien ne dépasse le cadre', () => {
  const long = 'fs-cli claude utilise tes serveurs MCP (Roblox Studio, Blender, leboncoin…) : nomme le serveur dans ta demande, le modèle appelle ses outils via fs-mcp';
  const out = [];
  ui.attachSink({ print: s => out.push(s), spinner() {} });
  try {
    ui.splitBox([{ text: 'Bienvenue', center: true }], [{ text: 'Quoi de neuf' }, { text: long, wrap: 3 }, { text: 'court' }], { title: 'FS-CLI', width: 118 });   // largeur de l'accueil dans une fenêtre normale
  } finally { ui.attachSink(null); }
  const lines = plain(out.join('')).split('\n').filter(Boolean);
  assert.equal(new Set(lines.map(l => [...l].length)).size, 1, 'toutes les lignes du cadre ont la même largeur');
  const right = lines.slice(1, -1).map(l => l.split('│')[2].trim());
  assert.equal(right[0], 'Quoi de neuf');
  assert.ok(right[1].startsWith('fs-cli claude utilise') && long.startsWith(right[1]), '1re ligne = début de la nouveauté, coupée à un espace');
  assert.ok(right.length >= 4, 'la nouveauté occupe plusieurs lignes');
  assert.ok(lines.filter(l => /│ {3}\S/.test(l)).length >= 1, 'lignes de suite décalées de 2 espaces');
  assert.ok(right.join(' ').includes('via fs-mcp'), 'la fin de la nouveauté est visible (pas coupée)');
  assert.equal(right.at(-1), 'court');
});

test('wrapAnsi : retour à la ligne aux espaces, styles refermés puis rouverts, emoji = 2 colonnes, mot trop long coupé', async () => {
  const { wrapAnsi, strWidth } = await import('../src/tui/layout.js');
  const B = '\x1b[1m', E = '\x1b[22m';
  const lines = wrapAnsi(`un deux ${B}trois quatre cinq${E} six 🚀 sept`, 12);
  assert.ok(lines.every(l => strWidth(l) <= 12));
  assert.deepEqual(lines.map(plain), ['un deux', 'trois quatre', 'cinq six 🚀', 'sept']);
  assert.ok(lines[1].startsWith(B), 'gras rouvert sur la ligne suivante');
  assert.ok(lines[1].endsWith('\x1b[0m'), 'et refermé en fin de ligne');
  assert.deepEqual(wrapAnsi('x'.repeat(25), 10).map(l => l.length), [10, 10, 5]);
});

test('texte du modèle (MdStream) : « ● » en tête, passé à la ligne avec un retrait de 2, suite d\'une liste alignée, jamais deux lignes vides', () => {
  const out = [];
  const before = process.stdout.columns;
  process.stdout.columns = 60;
  ui.attachSink({ print: s => out.push(s), spinner() {} });
  try {
    const md = new ui.MdStream();
    md.push('Je regarde la page actuelle et la feuille de style pour garder les mêmes classes, puis je refais le design.\n\n');
    md.push('- un élément de liste assez long pour passer à la ligne suivante et rester aligné sous son texte\n\n\n');
    md.push('Fin.\n\n');
    md.finish();
  } finally { ui.attachSink(null); process.stdout.columns = before; }
  const lines = plain(out.join('')).split('\n');
  const text = lines.filter(Boolean);
  assert.ok(text.every(l => [...l].length <= 59), 'rien ne dépasse la largeur');
  assert.match(text[0], /^● Je regarde la page/);
  assert.match(text[1], /^ {2}\S/, 'suite du paragraphe décalée de 2');
  const li = text.findIndex(l => /^ {2}• un élément/.test(l));
  assert.ok(li > 0 && /^ {4}\S/.test(text[li + 1]), 'suite de l\'élément alignée sous son texte');
  assert.equal(text.at(-1), '  Fin.');
  assert.ok(!/\n\n\n/.test(plain(out.join(''))), 'jamais deux lignes vides d\'affilée');
  assert.notEqual(lines.at(-2), '', 'pas de ligne vide en fin de réponse');
});
