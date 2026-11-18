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

// Mac : photos iPhone (HEIC) et TIFF, converties en JPEG par sips (fourni avec macOS) avant l'envoi
export const CONVERT_RE = /\.(heic|heif|tiff?)$/i;
const BASE_EXT = 'png|jpe?g|gif|webp|bmp';
const extsFor = platform => (platform === 'darwin' ? `${BASE_EXT}|heic|heif|tiff?` : BASE_EXT);
/** Chemin d'image acceptée sur cette plateforme (Mac : aussi HEIC/TIFF, convertis par prepareImage). */
export const isImagePath = (p, platform = process.platform) => IMAGE_RE.test(p) || (platform === 'darwin' && CONVERT_RE.test(p));

const imagesDir = () => { const d = path.join(HOME_DIR, 'images'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const stamp = (n = 19) => new Date().toISOString().replace(/[:.]/g, '-').slice(0, n);
const sizeOf = p => { try { return fs.statSync(p).size; } catch { return 0; } };

/** Arguments sips : JPEG, 2560 px max sur le grand côté (captures Retina 5K/4K). */
export const sipsArgs = (src, out) => ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '2560', src, '--out', out];

/** Mac : HEIC/HEIF/TIFF ou image trop lourde → JPEG redimensionné (sips). Ailleurs : chemin inchangé.
 *  Renvoie le chemin à envoyer, ou null si un HEIC/TIFF n'a pas pu être converti. */
export function prepareImage(p, { spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return p;
  const conv = CONVERT_RE.test(p), heavy = sizeOf(p) > MAX_IMAGE_BYTES;
  if (!conv && !heavy) return p;
  const out = path.join(imagesDir(), `${path.basename(p, path.extname(p)).slice(0, 60)}-${stamp(23)}.jpg`);
  try {
    const r = spawn('sips', sipsArgs(p, out), { encoding: 'utf8', timeout: 30000 });
    if (r && r.status === 0 && sizeOf(out) > 0) return out;
  } catch {}
  return conv ? null : p;                                             // trop lourde non convertie : cli.js prévient
}

/** osascript : chemin du fichier copié dans le Finder (Cmd+C). */
export const macFileUrlArgs = () => ['-e', 'POSIX path of (the clipboard as «class furl»)'];
/** osascript : image du presse-papiers (capture Cmd+Ctrl+Maj+4…) écrite en PNG dans `file` ; affiche « ok » ou « none ». */
export function macPngArgs(file) {
  const esc = String(file).replace(/[\\"]/g, '\\$&');
  return ['-e', 'try', '-e', 'set d to (the clipboard as «class PNGf»)', '-e', 'on error', '-e', 'return "none"', '-e', 'end try',
    '-e', 'try', '-e', `set f to open for access (POSIX file "${esc}") with write permission`, '-e', 'set eof f to 0',
    '-e', 'write d to f', '-e', 'close access f',
    '-e', 'on error', '-e', `try`, '-e', `close access (POSIX file "${esc}")`, '-e', 'end try', '-e', 'return "erreur"', '-e', 'end try',
    '-e', 'return "ok"'];
}

/** Image du presse-papiers enregistrée en PNG dans ~/.fs-cli/images ; renvoie son chemin, ou null s'il n'y en a pas. */
export function grabClipboardImage({ spawn = spawnSync, platform = process.platform } = {}) {
  const dir = imagesDir();
  const file = path.join(dir, `capture-${stamp()}.png`);
  try {
    if (platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[Windows.Forms.Clipboard]::GetImage(); ` +
        `if($i){ $i.Save('${file.replace(/'/g, "''")}',[Drawing.Imaging.ImageFormat]::Png); 'ok' } else { ` +
        `$f=[Windows.Forms.Clipboard]::GetFileDropList(); if($f.Count -gt 0){ 'fichier:' + $f[0] } }`;
      const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const out = (r.stdout || '').trim();
      if (out === 'ok' && fs.existsSync(file)) return file;
      if (out.startsWith('fichier:')) { const f = out.slice(8).trim(); if (IMAGE_RE.test(f) && fs.existsSync(f)) return f; }   // fichier image copié dans l'Explorateur
      return null;
    }
    if (platform === 'darwin') {
      // 1) fichier copié dans le Finder : son chemin (sinon on collerait son icône)
      const u = spawn('osascript', macFileUrlArgs(), { encoding: 'utf8', timeout: 5000 });
      const fp = u && u.status === 0 ? String(u.stdout || '').trim() : '';
      let isFile = false; try { isFile = !!fp && fs.statSync(fp).isFile(); } catch {}
      if (isFile) return isImagePath(fp, platform) ? prepareImage(fp, { spawn, platform }) : null;
      // 2) image (capture, copie depuis Aperçu ou un navigateur) : osascript, présent sur tout Mac
      const r = spawn('osascript', macPngArgs(file), { encoding: 'utf8', timeout: 15000 });
      if (r && r.status === 0 && String(r.stdout || '').trim() === 'ok' && sizeOf(file) > 0) return prepareImage(file, { spawn, platform });
      // 3) dernier recours : pngpaste (Homebrew)
      const p = spawn('pngpaste', [file], { timeout: 15000 });
      return p && p.status === 0 && sizeOf(file) > 0 ? prepareImage(file, { spawn, platform }) : null;
    }
    const r = spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 15000, maxBuffer: MAX_IMAGE_BYTES });
    if (r.status === 0 && r.stdout?.length) { fs.writeFileSync(file, r.stdout, { mode: 0o600 }); return file; }
  } catch {}
  return null;
}

/** Texte du presse-papiers (quand Ctrl+V arrive jusqu'au CLI sans image : on colle le texte nous-mêmes). */
export function readClipboardText() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      return (r.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, '');
    }
    const r = process.platform === 'darwin' ? spawnSync('pbpaste', [], { encoding: 'utf8', env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }) : spawnSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' });
    return r.stdout || '';
  } catch { return ''; }
}

const homeOf = p => (p.startsWith('~') ? path.join(process.env.USERPROFILE || process.env.HOME || '', p.slice(2)) : p);

/** Hors Windows : chemin glissé-déposé avec antislashs (« Capture\ d’écran\ 10.23.45.png », Terminal/iTerm2/Ghostty)
 *  ou avec une espace insécable (U+202F des captures macOS) → mis entre guillemets, sans les antislashs. */
export function quoteEscapedPaths(text, platform = process.platform) {
  if (platform === 'win32') return String(text);
  const re = new RegExp(String.raw`(?<![^\s(])((?:~\/|\/)(?:\\.|[^\s"'<>|\\]|[  ])+?\.(?:${extsFor(platform)}))(?=$|[\s,;.!?)])`, 'gi');
  return String(text).replace(re, m => {
    if (!/[\\  ]/.test(m)) return m;                          // chemin simple : déjà reconnu tel quel
    const p = m.replace(/\\(.)/g, '$1');
    if (p.includes('"')) return m;
    try { if (!fs.statSync(homeOf(p)).isFile()) return m; } catch { return m; }
    return `"${p}"`;
  });
}

/** Chemins d'images existantes dans le texte (glisser-déposer, collage) → remplacés par [Image #n]. */
export function extractImagePaths(text, startIndex = 0, { platform = process.platform, spawn = spawnSync } = {}) {
  const found = [];
  const ext = extsFor(platform);
  const re = new RegExp(String.raw`"([^"\r\n]+?\.(?:${ext}))"|'([^'\r\n]+?\.(?:${ext}))'|((?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])[^\s"'<>|]+?\.(?:${ext}))(?=$|[\s,;.!?)])`, 'gi');
  const out = quoteEscapedPaths(text, platform).replace(re, (m, q1, q2, bare) => {
    let p = homeOf((q1 || q2 || bare || '').trim());
    try { if (!fs.statSync(p).isFile()) return m; } catch { return m; }
    if (found.length + startIndex >= MAX_IMAGES) return m;
    const ready = prepareImage(path.resolve(p), { spawn, platform });   // Mac : HEIC / trop lourde → JPEG
    if (!ready) return m;
    found.push(ready);
    return `[Image #${startIndex + found.length}]`;
  });
  return { text: out, paths: found };
}
