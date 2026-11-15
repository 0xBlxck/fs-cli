// Dossier cible : si la demande cite un chemin Windows absolu (ex. « dans C:\Users\moi\Downloads\SITE »), les fichiers à nom relatif y sont écrits
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const STOP = /^(avec|et|pour|qui|que|dont|où|ya|il|elle|je|tu|on|stp|svp|merci|puis|ensuite|sans|dans|sur|and|with|for|please|then|which|that|the)$/i;
const trimTail = s => s.replace(/[\s.,;:!?)\]}»"'`]+$/g, '');

/** Cherche dans `text` un dossier cible ; renvoie un chemin absolu ou null. Les chemins avec espaces sont reconnus par essais sur le disque. */
export function detectTargetDir(text) {
  const cands = [];
  // racine d'un chemin absolu : C:\ ou C:/ partout ; /… et ~/… seulement hors Windows (sous Windows « /api » serait pris pour C:\api)
  // (un « C:\… » cité sous macOS / Linux n'existe pas là-bas : il ne doit pas devenir un dossier relatif « ./C:\… »)
  const ROOT = process.platform === 'win32' ? String.raw`[A-Za-z]:[\\/]` : String.raw`(?:~\/|\/(?=[^\s/]))`;
  const home = s => (s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s);
  for (const m of text.matchAll(new RegExp(String.raw`["'\`](${ROOT}[^"'\`\r\n]+)["'\`]`, 'g'))) cands.push(home(m[1]));   // chemin entre guillemets
  for (const m of text.matchAll(new RegExp(String.raw`(?:^|[\s(])(${ROOT}[^\r\n]*)`, 'g'))) cands.push(home(m[1]));       // reste de la ligne : on teste les préfixes
  for (const raw of cands) {
    const toks = raw.split(/\s+/);
    for (let k = toks.length; k >= 1; k--) {                                                               // du plus long au plus court
      const cand = trimTail(toks.slice(0, k).join(' '));
      if (!cand) continue;
      if (isDir(cand)) return path.resolve(cand);
      if (/\.[A-Za-z0-9]{1,6}$/.test(cand) && isDir(path.dirname(cand))) return path.resolve(path.dirname(cand));   // chemin d'un fichier → son dossier
    }
    // dossier à créer (inexistant) : on prend le nom jusqu'à la ponctuation ou à un mot de liaison, si son parent existe
    const kept = [];
    for (const t of toks) {
      if (kept.length && STOP.test(t.replace(/[.,;:!?]+$/, ''))) break;
      kept.push(t);
      if (/[.,;:!?]$/.test(t)) break;
    }
    const made = trimTail(kept.join(' '));
    if (made && /[\\/]/.test(made.slice(3)) && isDir(path.dirname(made))) return path.resolve(made);
  }
  return null;
}
