// Images jointes à un message : collées depuis le presse-papiers (Alt+V / Ctrl+V / /image), glissées-déposées
// dans le terminal (le terminal colle alors leur chemin) ou citées avec @image.png. Elles sont envoyées sur
// Files v2 de France Student puis jointes au message (champ `files`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME_DIR } from './config.js';

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 10;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
export const mimeOf = p => MIME[(path.extname(p).slice(1) || '').toLowerCase()] || 'application/octet-stream';

/** Image du presse-papiers enregistrée en PNG dans ~/.fs-cli/images ; renvoie son chemin, ou null s'il n'y en a pas. */
export function grabClipboardImage() {
  const dir = path.join(HOME_DIR, 'images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[Windows.Forms.Clipboard]::GetImage(); ` +
        `if($i){ $i.Save('${file.replace(/'/g, "''")}',[Drawing.Imaging.ImageFormat]::Png); 'ok' } else { ` +
        `$f=[Windows.Forms.Clipboard]::GetFileDropList(); if($f.Count -gt 0){ 'fichier:' + $f[0] } }`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const out = (r.stdout || '').trim();
      if (out === 'ok' && fs.existsSync(file)) return file;
      if (out.startsWith('fichier:')) { const f = out.slice(8).trim(); if (IMAGE_RE.test(f) && fs.existsSync(f)) return f; }   // fichier image copié dans l'Explorateur
      return null;
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('pngpaste', [file], { timeout: 15000 });
      return r.status === 0 && fs.existsSync(file) ? file : null;
    }
    const r = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 15000, maxBuffer: MAX_IMAGE_BYTES });
    if (r.status === 0 && r.stdout?.length) { fs.writeFileSync(file, r.stdout, { mode: 0o600 }); return file; }
  } catch {}
  return null;
}

/** Chemins d'images existantes dans le texte (glisser-déposer, collage) → remplacés par [Image #n]. */
export function extractImagePaths(text, startIndex = 0) {
  const found = [];
  const re = /"([^"\r\n]+?\.(?:png|jpe?g|gif|webp|bmp))"|'([^'\r\n]+?\.(?:png|jpe?g|gif|webp|bmp))'|((?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])[^\s"'<>|]+?\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s,;.!?)])/gi;
  const out = String(text).replace(re, (m, q1, q2, bare) => {
    let p = (q1 || q2 || bare || '').trim();
    if (p.startsWith('~')) p = path.join(process.env.USERPROFILE || process.env.HOME || '', p.slice(2));
    try { if (!fs.statSync(p).isFile()) return m; } catch { return m; }
    if (found.length + startIndex >= MAX_IMAGES) return m;
    found.push(path.resolve(p));
    return `[Image #${startIndex + found.length}]`;
  });
  return { text: out, paths: found };
}
