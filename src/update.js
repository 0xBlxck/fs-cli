// Vérification de mise à jour : lit seulement le numéro de version publié sur GitHub (package.json de la branche main),
// au plus une fois toutes les 12 h (cache dans ~/.fs-cli/update.json). Aucune donnée n'est envoyée.
// Désactivable : variable FS_CLI_NO_UPDATE_CHECK=1.
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, VERSION } from './config.js';

export const REPO = '0xBlxck/fs-cli';
export const INSTALL_CMD = `npm install -g https://github.com/${REPO}/archive/refs/heads/main.tar.gz`;
const URL_PKG = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const CACHE = () => path.join(HOME_DIR, 'update.json');
const EVERY = 12 * 3600 * 1000;

/** -1 si a < b, 0 si égales, 1 si a > b (versions x.y.z). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }
  return 0;
}

/** { current, latest, newer } ; latest = null si inconnue (hors ligne…). Ne lève jamais. */
export async function checkUpdate({ force = false } = {}) {
  const out = { current: VERSION, latest: null, newer: false };
  if (process.env.FS_CLI_NO_UPDATE_CHECK === '1') return out;
  let cache = null; try { cache = JSON.parse(fs.readFileSync(CACHE(), 'utf8')); } catch {}
  if (!force && cache?.latest && Date.now() - (cache.checkedAt || 0) < EVERY) out.latest = cache.latest;
  else {
    try {
      const r = await fetch(URL_PKG, { headers: { 'User-Agent': `fs-cli/${VERSION}` }, signal: AbortSignal.timeout(4000), redirect: 'follow' });
      if (r.ok) {
        const v = String((await r.json())?.version || '');
        if (/^\d+\.\d+\.\d+$/.test(v)) {
          out.latest = v;
          try { fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(CACHE(), JSON.stringify({ latest: v, checkedAt: Date.now() }), { mode: 0o600 }); } catch {}
        }
      }
    } catch {}
  }
  out.newer = !!out.latest && compareVersions(out.latest, VERSION) > 0;
  return out;
}

// ── npm -g sans droits d'écriture (Mac avec le .pkg de nodejs.org, Linux avec le Node du système) ──
/** Sortie de npm qui signale un refus d'écriture (EACCES / EPERM) ? */
export function isNpmPermissionError(text) {
  return /\bE(ACCES|PERM)\b|permission denied|operation not permitted/i.test(String(text || ''));
}

/** Fichier de démarrage du shell où ajouter le PATH (zsh par défaut sur Mac). */
export function shellProfile({ platform = process.platform, shell = process.env.SHELL || '' } = {}) {
  if (/zsh$/.test(shell) || (platform === 'darwin' && !shell)) return '~/.zprofile';
  if (/bash$/.test(shell)) return platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
  return platform === 'darwin' ? '~/.zprofile' : '~/.profile';
}

/** Commandes pour que npm -g écrive dans ~/.local (jamais sudo : il laisserait ~/.npm à root). */
export function npmPrefixFix(opts = {}) {
  const prof = shellProfile(opts);
  return [
    'mkdir -p ~/.local',
    'npm config set prefix ~/.local',
    `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${prof}`,
  ];
}

/** Explication en français d'un échec EACCES/EPERM de npm -g (lignes à afficher). null si ce n'en est pas un. */
export function npmPermissionHelp(text, opts = {}) {
  if (!isNpmPermissionError(text)) return null;
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return [
    'npm n\'a pas pu remplacer les fichiers de FS-CLI (fichier verrouillé ou droits insuffisants).',
    'Ferme les autres fenêtres fs-cli et les éditeurs qui utilisent le panneau FS-CLI, puis relance :',
    `  ${INSTALL_CMD}`,
  ];
  return [
    'npm n\'a pas le droit d\'écrire dans son dossier global (il appartient à root : Node installé avec le .pkg de nodejs.org ou par le système).',
    'N\'utilise pas sudo : il laisserait des fichiers à root dans ~/.npm et casserait les prochains npm install.',
    'Fais une fois ceci pour installer les paquets globaux dans ton dossier personnel :',
    ...npmPrefixFix(opts).map(l => `  ${l}`),
    'Ouvre un nouveau terminal, puis :',
    `  ${INSTALL_CMD}`,
    'Ensuite /update marchera sans mot de passe.',
  ];
}

/** Dossier global de npm modifiable ? true / false, ou null si FS-CLI n'est pas installé avec npm -g. */
export function globalDirWritable(root, access = p => fs.accessSync(p, fs.constants.W_OK)) {
  const dir = path.dirname(path.resolve(root));
  if (path.basename(dir) !== 'node_modules') return null;
  try { access(dir); return true; } catch { return false; }
}
