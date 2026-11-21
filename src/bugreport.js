// /bug : journal local des erreurs et rapport prêt à coller sur Discord.
// Rien n'est envoyé nulle part : le rapport est affiché, enregistré sur le PC et copié dans le presse-papiers.
// Jamais de clé de session, de jeton, d'e-mail, de nom d'utilisateur ni de contenu de conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR } from './config.js';

export const ERRORS_FILE = () => path.join(HOME_DIR, 'errors.log');
export const REPORT_FILE = () => path.join(HOME_DIR, 'rapport-bug.txt');
const MAX_LINES = 200;

/** Retire ce qui pourrait identifier ou donner accès : jetons, clés, e-mails, dossier personnel, identifiants longs. */
export function scrub(s, home = os.homedir()) {
  let t = String(s ?? '');
  if (home) t = t.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');
  return t
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jeton>')
    .replace(/\b(Bearer|Token|Cookie|Authorization)\s*[:=]?\s*\S+/gi, '$1 <masqué>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<e-mail>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<clé>')
    .replace(/\b(?:users|home)[\\/][^\\/\s"']+/gi, m => m.replace(/[\\/][^\\/\s"']+$/, '/<utilisateur>'));
}

/** Note une erreur montrée à l'utilisateur (une ligne JSON). Ne lève jamais. */
export function recordError(e, ctx = {}) {
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      message: scrub(e?.message || e).slice(0, 400),
      ...(e?.status ? { status: e.status } : {}), ...(e?.code ? { code: String(e.code) } : {}),
      ...(e?.accepted !== undefined ? { accepted: !!e.accepted } : {}),
      ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, scrub(v).slice(0, 80)])),
    });
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const f = ERRORS_FILE();
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch {}
    lines.push(line);
    fs.writeFileSync(f, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch {}
}

/** Copie dans le presse-papiers du PC (Windows : clip en UTF-16 pour garder les accents). → true si copié. */
export async function copyText(text, platform = process.platform) {
  const { spawnSync } = await import('node:child_process');
  const run = (cmd, args, input) => { try { return spawnSync(cmd, args, { input, timeout: 5000, windowsHide: true }).status === 0; } catch { return false; } };
  if (platform === 'win32') return run('clip', [], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(text), 'utf16le')]));
  if (platform === 'darwin') return run('pbcopy', [], String(text));
  return run('wl-copy', [], String(text)) || run('xclip', ['-selection', 'clipboard'], String(text));
}

const lastLines = (file, n) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; } };

/** Erreurs récentes de la passerelle (fs claude) : événements d'erreur seulement, sans contenu. */
function gatewayErrors(n = 6) {
  const f = path.join(HOME_DIR, 'gateway', 'gateway.log');
  return lastLines(f, 2000).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && (o.event === 'fs_error' || /erreur|lost|perdu|annul/i.test(String(o.outcome || ''))))
    .slice(-n)
    .map(o => `${String(o.t || '').slice(0, 19)} ${o.event}${o.phase ? ' ' + o.phase : ''}${o.kind ? ' ' + o.kind : ''}${o.status ? ' ' + o.status : ''}${o.code ? ' ' + o.code : ''}${o.outcome ? ' ' + scrub(o.outcome).slice(0, 80) : ''}`);
}

/**
 * Rapport texte. info = { version, model, mode, engine, ui, web, shell, extra: [[clé, valeur]…] }.
 */
export function bugReport(info = {}, { now = new Date() } = {}) {
  const errs = lastLines(ERRORS_FILE(), 10).map(l => {
    try {
      const o = JSON.parse(l);
      return `${o.t.slice(0, 19)} ${o.status ? o.status + ' ' : ''}${o.code ? o.code + ' ' : ''}${o.message}${o.model ? ' [' + o.model + ']' : ''}`;
    } catch { return null; }
  }).filter(Boolean);
  const rows = [
    ['FS-CLI', info.version || '?'],
    ['Système', `${os.type()} ${os.release()} (${process.platform} ${process.arch})`],
    ['Node', process.version],
    ['Terminal', [info.ui, info.shell].filter(Boolean).join(' · ') || '?'],
    ['Modèle', info.model || '?'],
    ['Mode', [info.mode, info.engine, info.web ? 'recherche web' : ''].filter(Boolean).join(' · ') || '?'],
    ...(info.extra || []),
  ];
  return [
    '**Rapport FS-CLI** (' + now.toLocaleString('fr-FR') + ')',
    '```',
    ...rows.map(([k, v]) => `${(k + ' :').padEnd(16)} ${scrub(v)}`),
    '',
    'Dernières erreurs du CLI :',
    ...(errs.length ? errs : ['(aucune)']),
    '',
    'Dernières erreurs de fs claude :',
    ...(gatewayErrors().length ? gatewayErrors() : ['(aucune)']),
    '```',
    'Ce que je faisais : ',
  ].join('\n');
}
