// ANCIENNE icône provisoire (remplacée par le logo officiel France Student) : ne plus lancer, elle écraserait media/icon.png.
// Génère media/icon.png (128×128) : carré arrondi orange + étoile blanche à 8 branches. Zéro dépendance.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const N = 128, SS = 4;                       // suréchantillonnage pour l'anticrénelage
const px = new Float32Array(N * N * 4);
const inRound = (x, y) => { const r = 28, m = 4; const cx = Math.min(Math.max(x, m + r), N - m - r), cy = Math.min(Math.max(y, m + r), N - m - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= m && y >= m && x <= N - m && y <= N - m; };
const segDist = (px_, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px_ - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px_ - ax - t * dx, py - ay - t * dy); };
const C = 64, R = 40, W = 6.5;
const arms = [0, 45, 90, 135].map(a => { const r = a * Math.PI / 180; return [C - R * Math.cos(r), C - R * Math.sin(r), C + R * Math.cos(r), C + R * Math.sin(r)]; });
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  let bg = 0, fg = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const X = x + (sx + 0.5) / SS, Y = y + (sy + 0.5) / SS;
    if (!inRound(X, Y)) continue;
    bg++;
    if (Math.hypot(X - C, Y - C) < 9 || arms.some(a => segDist(X, Y, ...a) < W)) fg++;
  }
  const a = bg / (SS * SS), f = bg ? fg / bg : 0, i = (y * N + x) * 4;
  const or = [226, 113, 77];
  px[i] = or[0] + (255 - or[0]) * f; px[i + 1] = or[1] + (255 - or[1]) * f; px[i + 2] = or[2] + (255 - or[2]) * f; px[i + 3] = 255 * a;
}
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; for (let x = 0; x < N * 4; x++) raw[y * (N * 4 + 1) + 1 + x] = Math.round(px[y * N * 4 + x]); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log('écrit', out, png.length, 'octets');
