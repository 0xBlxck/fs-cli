// Syntaxe de tous les fichiers JS (mêmes fichiers que l'étape « Syntaxe » de la CI) :
// une erreur dans vscode/media/panel.js laisse le panneau de l'extension vide sans autre message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inDir = (dir, ext) => {
  const abs = path.join(ROOT, dir);
  return fs.existsSync(abs) ? fs.readdirSync(abs).filter(f => f.endsWith(ext)).map(f => path.join(dir, f)) : [];
};
const FILES = [
  'cli.js', 'mcp-cli.js',
  ...inDir('src', '.js'), ...inDir('src/tui', '.js'),
  ...inDir('vscode', '.js'), ...inDir('vscode/media', '.js'), ...inDir('vscode/scripts', '.mjs'),
];

for (const f of FILES) {
  test(`syntaxe : ${f}`, () => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
    catch (e) { assert.fail(`${f}\n${String(e.stderr || e.message).trim()}`); }
  });
}
