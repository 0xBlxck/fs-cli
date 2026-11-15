// Assistant de connexion : au premier lancement (ou avec /login), on aide l'utilisateur à fournir SON token
// sans éditer de fichier. Le token est lu en saisie masquée, vérifié auprès de l'API, puis enregistré
// dans ~/.fs-cli/.env (droits 0600). Il n'est jamais affiché ni placé dans l'environnement.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { HOME_DIR, setToken } from './config.js';
import { getJson } from './api.js';
import { c } from './ui.js';

const SITE = 'https://ia.francestudent.org';

/** Nettoie ce que l'utilisateur colle : « next-auth.session-token=… », guillemets, espaces, point-virgule final. */
export function cleanToken(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^(?:FS_SESSION_TOKEN|(?:__Secure-)?next-auth\.session-token)\s*[=:]\s*/i, '');
  t = t.replace(/^["']|["']$/g, '').replace(/;.*$/, '').trim();
  return /^[\w.\-~+/=]{20,}$/.test(t) ? t : '';
}

/** Écrit (ou remplace) FS_SESSION_TOKEN dans ~/.fs-cli/.env, sans toucher aux autres lignes. */
export function saveToken(token, dir = HOME_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, '.env');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => !/^\s*FS_SESSION_TOKEN\s*=/.test(l)); } catch {}
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`FS_SESSION_TOKEN=${token}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function openSite() {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', SITE], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [SITE], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

function question(prompt, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      let shown = false;
      rl._writeToOutput = (s) => {                       // n'affiche que l'invite, puis des • à la place des caractères
        if (!shown) { process.stdout.write(s); shown = true; return; }
        if (/\r|\n/.test(s)) process.stdout.write('\n'); else process.stdout.write(c.dim('•'.repeat(Math.min(s.length, 1))));
      };
    }
    rl.question(prompt, a => { rl.close(); resolve(a); });
    rl.on('SIGINT', () => { rl.close(); resolve(null); });
  });
}

/** Vérifie un token auprès de l'API (GET /user/usage). */
export async function checkToken(token) {
  setToken(token);
  return (await getJson('/user/usage', 12000)) !== null;
}

/** Assistant interactif. Renvoie true si un token valide est enregistré. */
export async function loginWizard({ first = true } = {}) {
  const say = (s = '') => process.stdout.write(s + '\n');
  say();
  say(c.bold(first ? '  Bienvenue dans FS-CLI 👋' : '  Changer de compte / de token'));
  say(c.dim('  Le CLI utilise TON compte France Student. Il faut copier une fois ta « clé de session » :'));
  say();
  say(`  1. Connecte-toi sur ${c.accent(SITE)}`);
  say(`  2. Appuie sur ${c.bold('F12')} → onglet ${c.bold('Application')} (Chrome/Edge) ou ${c.bold('Stockage')} (Firefox) → ${c.bold('Cookies')}`);
  say(`  3. Clique sur ${c.bold('next-auth.session-token')} et copie sa ${c.bold('valeur')}`);
  say();
  say(c.dim('  🔐 Cette clé est comme un mot de passe : ne la donne à personne. Elle reste sur ton PC (~/.fs-cli/.env).'));
  say();
  const open = await question(`  Ouvrir le site maintenant ? ${c.dim('[O/n]')} `);
  if (open === null) return false;
  if (!/^n/i.test(open.trim())) openSite();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await question(`  Colle la valeur ici puis Entrée ${c.dim('(elle ne s\'affiche pas)')} : `, { hidden: true });
    if (raw === null || !raw.trim()) { say(c.dim('  annulé')); return false; }
    const token = cleanToken(raw);
    if (!token) { say(c.yellow('  Ça ne ressemble pas à une clé de session (copie bien la colonne « Valeur »).')); continue; }
    process.stdout.write(c.dim('  vérification…'));
    const ok = await checkToken(token);
    process.stdout.write('\r\x1b[K');
    if (!ok) { setToken(''); say(c.yellow('  Clé refusée par France Student (expirée, incomplète ou d\'un autre site). Réessaie.')); continue; }
    const file = saveToken(token);
    say(c.green('  ✓ Connecté ! ') + c.dim(`Clé enregistrée dans ${file} — /login pour la changer plus tard.`));
    say();
    return true;
  }
  say(c.red('  Trop d\'essais. Relance fs-cli quand tu as la bonne valeur.'));
  return false;
}
