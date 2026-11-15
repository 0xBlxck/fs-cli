// Installe l'extension VS Code de FS-CLI dans les éditeurs présents (VS Code, Cursor, Windsurf, Antigravity…).
// Le .vsix est fabriqué sur place à partir du dossier vscode/ livré avec le CLI : rien n'est téléchargé.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.js';

const IS_WIN = process.platform === 'win32';
export const EXT_ID = '0xblxck.fs-cli-vscode';

/** éditeurs compatibles VS Code : nom, commande, emplacements connus */
function candidates() {
  const L = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const PF = process.env.ProgramFiles || 'C:\\Program Files';
  const win = (...p) => path.join(...p);
  return [
    { name: 'VS Code', cmd: 'code', paths: [win(L, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), win(PF, 'Microsoft VS Code', 'bin', 'code.cmd'), '/usr/local/bin/code', '/usr/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'] },
    { name: 'VS Code Insiders', cmd: 'code-insiders', paths: [win(L, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd')] },
    { name: 'Cursor', cmd: 'cursor', paths: [win(L, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'), win(PF, 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'), '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'] },
    { name: 'Windsurf', cmd: 'windsurf', paths: [win(L, 'Programs', 'Windsurf', 'bin', 'windsurf.cmd'), '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'] },
    { name: 'Antigravity IDE', cmd: 'antigravity-ide', paths: [win(L, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd')] },
    { name: 'Antigravity', cmd: 'antigravity', paths: [win(L, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd'), '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity'] },
    { name: 'VSCodium', cmd: 'codium', paths: [win(L, 'Programs', 'VSCodium', 'bin', 'codium.cmd'), '/usr/bin/codium'] },
  ];
}

function onPath(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (r.status !== 0) return null;
  const lines = String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return (IS_WIN ? lines.find(l => /\.cmd$/i.test(l)) : lines[0]) || null;
}

/** éditeurs installés sur la machine (un par produit) */
export function findEditors() {
  const out = [];
  for (const c of candidates()) {
    const bin = c.paths.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || onPath(c.cmd);
    if (bin && !out.some(e => e.bin.toLowerCase() === bin.toLowerCase())) out.push({ name: c.name, bin });
  }
  return out;
}

/** lance la commande d'un éditeur (les .cmd Windows passent par cmd.exe, chemin entre guillemets) */
function runEditor(bin, args) {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 120000 };
  const r = IS_WIN && /\.cmd$/i.test(bin)
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[bin, ...args].map(a => `"${a}"`).join(' ')}"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(bin, args, opts);
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

export function hasExtension(editor) {
  const r = runEditor(editor.bin, ['--list-extensions']);
  return r.ok && r.out.toLowerCase().split(/\r?\n/).some(l => l.trim() === EXT_ID);
}

/** fabrique le .vsix à partir du dossier vscode/ du CLI (dossier temporaire) */
export function buildVsix() {
  const pack = path.join(ROOT, 'vscode', 'scripts', 'pack.mjs');
  if (!fs.existsSync(pack)) throw new Error('dossier vscode/ absent de cette installation : mets FS-CLI à jour');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-cli-vscode-'));   // dossier unique : rien ne peut être glissé à la place du .vsix
  const r = spawnSync(process.execPath, [pack, dir], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(`fabrication de l'extension impossible : ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8')).version;
  const file = path.join(dir, `fs-cli-vscode-${ver}.vsix`);
  if (!fs.existsSync(file)) throw new Error('fichier .vsix introuvable après fabrication');
  return { file, version: ver };
}

export function installInto(editor, vsix) {
  const r = runEditor(editor.bin, ['--install-extension', vsix, '--force']);
  return { ok: r.ok && /success|install/i.test(r.out), out: r.out.split(/\r?\n/).filter(l => !/depends on|NOT registered/.test(l)).slice(-2).join(' ') };
}
