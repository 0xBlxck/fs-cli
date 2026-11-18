// Dossier cible : si la demande cite un chemin Windows absolu (ex. « dans C:\Users\moi\Downloads\SITE »), les fichiers à nom relatif y sont écrits
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const IS_WIN = process.platform === 'win32';
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// hors Windows : seulement un dossier où l'on peut écrire (sinon write_file échoue en EACCES, npm init et mkdir aussi)
const writable = p => { if (IS_WIN) return true; try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
// hors Windows : « la route /users », « /library », « /api » ne sont pas des dossiers de travail (sur Mac, /users = /Users : disque insensible à la casse)
const oneLevel = p => !IS_WIN && p.startsWith('/') && p.split('/').filter(Boolean).length < 2;
const STOP = /^(avec|et|pour|qui|que|dont|où|ya|il|elle|je|tu|on|stp|svp|merci|puis|ensuite|sans|dans|sur|and|with|for|please|then|which|that|the)$/i;
// « fichier:ligne(:col) » (Node, gcc, Python) ou « fichier(ligne,col) » (tsc, MSBuild, csc) ; la « ) » finale est déjà retirée par trimTail
const CODE_REF = /\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\)?)$/;
const trimTail = s => s.replace(/[\s.,;:!?)\]}»"'`]+$/g, '');

/** Cherche dans `text` un dossier cible ; renvoie un chemin absolu ou null. Les chemins avec espaces sont reconnus par essais sur le disque. */
export function detectTargetDir(text) { return detect(text)?.dir ?? null; }

/** même recherche → { dir, fromFile } ; fromFile : dossier d'un fichier cité (« corrige …\src\api.js » → …\src) */
function detect(text) {
  text = String(text ?? '');
  const cands = [];
  // racine d'un chemin absolu : C:\ ou C:/ partout ; /… et ~/… seulement hors Windows (sous Windows « /api » serait pris pour C:\api)
  // (un « C:\… » cité sous macOS / Linux n'existe pas là-bas : il ne doit pas devenir un dossier relatif « ./C:\… »)
  const ROOT = IS_WIN ? String.raw`[A-Za-z]:[\\/]` : String.raw`(?:~\/|\/(?=[^\s/]))`;
  const home = s => (s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s);
  for (const m of text.matchAll(new RegExp(String.raw`["'\`](${ROOT}[^"'\`\r\n]+)["'\`]`, 'g'))) cands.push({ raw: home(m[1]), quoted: true });   // chemin entre guillemets
  for (const m of text.matchAll(new RegExp(String.raw`(?:^|[\s(])(${ROOT}[^\r\n]*)`, 'g'))) cands.push({ raw: home(m[1]), quoted: false });       // reste de la ligne : on teste les préfixes
  cand: for (const { raw, quoted } of cands) {
    const toks = raw.split(/\s+/);
    for (let k = toks.length; k >= 1; k--) {                                                               // du plus long au plus court
      const cand = trimTail(toks.slice(0, k).join(' '));
      if (!cand) continue;
      // « fichier:ligne(:colonne) » (trace d'erreur, « api.js:45 ») : une référence de code, pas un dossier où travailler
      if (CODE_REF.test(cand)) continue cand;
      if (!quoted && oneLevel(cand)) continue;
      if (isDir(cand)) { if (writable(cand)) return { dir: path.resolve(cand), fromFile: false }; continue; }
      if (/\.[A-Za-z0-9]{1,6}$/.test(cand) && isDir(path.dirname(cand)) && writable(path.dirname(cand)) && !(!quoted && oneLevel(path.dirname(cand)))) return { dir: path.resolve(path.dirname(cand)), fromFile: true };   // chemin d'un fichier → son dossier
    }
    // dossier à créer (inexistant) : on prend le nom jusqu'à la ponctuation ou à un mot de liaison, si son parent existe
    const kept = [];
    for (const t of toks) {
      if (kept.length && STOP.test(t.replace(/[.,;:!?]+$/, ''))) break;
      kept.push(t);
      if (/[.,;:!?]$/.test(t)) break;
    }
    const made = trimTail(kept.join(' '));
    // jamais un dossier à créer dont le nom contient « : » après la lettre du disque (« api.js:45:12 », « x:y ») : nom invalide sous Windows
    if (made && /:/.test(IS_WIN ? made.slice(2) : made) && (IS_WIN || /:\d/.test(made))) continue;
    // ni « ( » suivie d'un chiffre (« api.js(45,12 » : format tsc / MSBuild / csc)
    if (made && /\(\d/.test(IS_WIN ? made.slice(2) : made)) continue;
    if (made && /[\\/]/.test(made.slice(3)) && isDir(path.dirname(made)) && writable(path.dirname(made))) return { dir: path.resolve(made), fromFile: false };
  }
  return null;
}

const samePath = (a, b) => { const k = p => { const r = path.resolve(p); return IS_WIN || process.platform === 'darwin' ? r.toLowerCase() : r; }; return k(a) === k(b); };
// vraie création : la demande fait naître le dossier (« crée un site … », « génère le projet … », « nouveau projet … »)
const CREATE = /(?<!\p{L})(?:cr[ée]{1,2}[erz]?|cr[ée]{2}s|g[ée]n[èe]re[rz]?|initialise[rz]?|initiali[sz]e|scaffold|create|generate|make(?!\s+sure)|nouveau\s+projet|nouvelle\s+(?:app|application)|new\s+project)(?!\p{L})/iu;
// dossier encore inexistant : « fais / fabrique un site dans …\neuf » vise aussi ce dossier
const MAKE_NEW = /(?<!\p{L})(?:fais|faire|fabrique[rz]?|build)(?!\p{L})/iu;
// placement : un verbe juste avant « dans / in / into <chemin> » (au plus 4 mots entre les deux : « copie les fichiers dans … », « mets-le dans … »)
const PLACE_VERB = String.raw`cr[ée]{1,2}[erz]?|cr[ée]{2}s|g[ée]n[èe]re[rz]?|mets|mettre|place[rz]?|range[rz]?|d[ée]place[rz]?|copie[rz]?|[ée]cri[st]|[ée]crire|[ée]crivez|enregistre[rz]?|sauvegarde[rz]?|installe[rz]?|create|generate|put|save|move|copy|write|install`;
const PLACE = new RegExp(String.raw`(?<!\p{L})(?:${PLACE_VERB})(?:-(?:le|la|les|y|moi|nous))*(?:\s+[^\s\\/"'\x60]+){0,4}?\s+(?:dans|in|into|sous)\s+(["'\x60]?(?:[A-Za-z]:[\\/]|~\/|\/)[^\r\n]*)`, 'giu');
/**
 * Faut-il changer de dossier cible pour `dir` (trouvé par detectTargetDir) ? Toujours pour un dossier hors du dossier de travail.
 * Dedans (fichier cité, trace d'erreur collée, « corrige …\src\api.js et fais passer les tests ») : non, les chemins relatifs appris
 * restent justes ; sauf demande de placement juste avant ce chemin (« mets-le dans …\out ») ou création d'un dossier qui n'existe pas encore.
 * Jamais pour le dossier d'un fichier cité (`fromFile`, déduit du texte s'il n'est pas donné).
 */
export function acceptTarget(dir, { cwd, text = '', fromFile } = {}) {
  if (!dir) return false;
  if (!cwd) return true;
  const r = path.relative(path.resolve(cwd), path.resolve(dir));
  const inside = !r.startsWith('..') && !path.isAbsolute(r);
  if (!inside) return true;
  if (r === '') return false;
  text = String(text ?? '');
  if (fromFile === undefined) { const d = detect(text); fromFile = !!(d && d.fromFile && samePath(d.dir, dir)); }
  if (fromFile) return false;
  // « dans <chemin> » précédé d'un verbe de placement, et ce chemin est bien le dossier trouvé
  for (const m of text.matchAll(PLACE)) { const d = detect(m[1]); if (d && !d.fromFile && samePath(d.dir, dir)) return true; }
  if (isDir(dir)) return false;
  const words = text.replace(/(?:[A-Za-z]:[\\/]|~\/|\.{0,2}\/)[^\s"'`]*/g, ' ');   // sans les chemins (« C:\create\… » n'est pas « create »)
  return CREATE.test(words) || MAKE_NEW.test(words);
}
/** note pour le modèle quand le dossier cible change (les chemins relatifs y sont résolus) */
export const targetNote = dir => `Dossier cible : ${dir} (les chemins relatifs y sont résolus).`;
