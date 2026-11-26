// /doctor : vérifie l'installation d'un coup et dit quoi corriger. Lecture seule : rien n'est modifié, aucun serveur MCP n'est démarré.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOKEN, VERSION, HOME_DIR, ROOT, cfg } from './config.js';
import { getJson } from './api.js';
import { checkUpdate, INSTALL_CMD, globalDirWritable, npmPrefixFix } from './update.js';
import { BLOCKING } from './postinstall.js';
import { isFolderTrusted, isBroadFolder } from './trust.js';
import { loadMcpConfig } from './mcp.js';
import { isImportApproved } from './approvals.js';
import { discoverSkills } from './discover.js';

const IS_WIN = process.platform === 'win32';

/** Conseil pour installer un Node récent, selon le système. */
export function nodeInstallHint(platform = process.platform) {
  if (platform === 'win32') return 'installe la version LTS : winget install OpenJS.NodeJS.LTS';
  if (platform === 'darwin') return 'brew install node (ou l\'installeur LTS de nodejs.org, version ARM64 sur Apple Silicon)';
  return 'nvm install --lts (ou la version LTS de nodejs.org)';
}

const run = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 }); } catch { return { status: -1, stdout: '' }; } };

/** Dossier global de npm modifiable ? (sinon /update échouera avec EACCES). true / false / null si inconnu. */
function npmGlobalWritable() {
  const own = globalDirWritable(ROOT);                               // FS-CLI installé avec npm -g : son propre dossier
  if (own !== null) return own;
  const r = run('npm', ['prefix', '-g']);
  const prefix = String(r.stdout || '').trim();
  if (r.status !== 0 || !prefix) return null;
  const lib = path.join(prefix, 'lib', 'node_modules');
  try { fs.accessSync(fs.existsSync(lib) ? lib : prefix, fs.constants.W_OK); return true; } catch { return false; }
}

/** Vérifications propres au Mac (et à Linux pour npm) : Rosetta, npm -g sans sudo, outils Xcode, touche Option. Dépendances injectables (tests). */
export function unixChecks({ platform = process.platform, arch = process.arch, env = process.env, exec = run, npmWritable = npmGlobalWritable } = {}) {
  const out = [];
  const add = (level, label, detail, fix) => out.push({ level, label, detail, fix });
  if (platform === 'win32') return out;
  if (platform === 'darwin') {
    // Rosetta : un Node x64 sur un Mac Apple Silicon tourne traduit (plus lent, modules natifs x64)
    const tr = exec('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated']);
    const translated = tr.status === 0 && String(tr.stdout || '').trim() === '1';
    if (arch === 'arm64') add('ok', 'Processeur', 'Apple Silicon : exécution native ARM64, sans Rosetta');
    else if (translated) add('warn', 'Processeur', 'Node x64 lancé sous Rosetta sur un Mac Apple Silicon (plus lent)', 'installe Node ARM64 : brew install node (Homebrew dans /opt/homebrew) ou le .pkg ARM64 de nodejs.org');
    else add('ok', 'Processeur', `Mac Intel (${arch})`);
  }
  const w = npmWritable();
  if (w === false) add('warn', 'npm global', 'dossier global de npm non modifiable sans sudo : /update échouera', `${npmPrefixFix({ platform, shell: env.SHELL }).join(' && ')} (puis rouvre le terminal et réinstalle : ${INSTALL_CMD})`);
  else if (w === true) add('ok', 'npm global', 'modifiable (mise à jour par /update possible)');
  if (platform === 'darwin') {
    // sans les outils Xcode, /usr/bin/git et /usr/bin/python3 ouvrent une fenêtre d'installation ; xcode-select -p n'en ouvre aucune
    const x = exec('/usr/bin/xcode-select', ['-p']);
    if (x.status === 0) add('ok', 'Outils Xcode', String(x.stdout || '').trim() || 'installés');
    else add('warn', 'Outils Xcode', 'absents : git et python3 ouvrent une fenêtre « installer les outils de développement »', 'xcode-select --install (ou brew install git python)');
    if (env.TERM_PROGRAM === 'Apple_Terminal') add('ok', 'Terminal', 'Terminal.app', 'raccourcis Alt (ex. Alt+V) : Terminal › Réglages › Profils › Clavier › coche « Utiliser Option comme touche Méta »');
    else if (env.TERM_PROGRAM === 'iTerm.app') add('ok', 'Terminal', 'iTerm2', 'raccourcis Alt (ex. Alt+V) : Réglages › Profiles › Keys › Left Option key : Esc+');
    else if (env.TERM_PROGRAM) add('ok', 'Terminal', env.TERM_PROGRAM === 'vscode' ? 'terminal de VS Code' : env.TERM_PROGRAM);
  }
  return out;
}

/** Liste de vérifications : { level: 'ok'|'warn'|'err', label, detail, fix? } */
export async function runDoctor(S) {
  const out = [];
  const add = (level, label, detail, fix) => out.push({ level, label, detail, fix });

  // Node.js
  const major = parseInt(process.versions.node, 10);
  if (major >= 20) add('ok', 'Node.js', `v${process.versions.node}`);
  else add('err', 'Node.js', `v${process.versions.node} (trop ancien)`, nodeInstallHint());

  // version de FS-CLI
  const [upd, usage] = await Promise.all([checkUpdate({ force: true }), TOKEN ? getJson('/user/usage', 8000) : Promise.resolve(null)]);
  if (upd.newer) add('warn', 'FS-CLI', `v${VERSION} — la v${upd.latest} est disponible`, INSTALL_CMD);
  else add('ok', 'FS-CLI', `v${VERSION}${upd.latest ? ' (à jour)' : ' (vérification de mise à jour impossible : hors ligne ?)'}`);

  // clé de session
  if (!TOKEN) add('err', 'Clé de session', 'absente', 'lance « fs-cli --login »');
  else if (!usage) add('err', 'Clé de session', 'refusée par France Student (expirée ?) ou site injoignable', 'lance « fs-cli --login » avec une nouvelle clé');
  else {
    const b = usage.chatBudget;
    add('ok', 'Clé de session', 'valide' + (b ? ` · budget de chat utilisé à ${Math.round(b.usedPercent)} %` : ''));
    if (b && b.usedPercent > 90) add('warn', 'Budget de chat', `${Math.round(b.usedPercent)} % utilisé`, 'attends la remise à zéro (voir /usage)');
  }

  // dossier de travail
  if (isBroadFolder(S.cwd)) add('warn', 'Dossier de travail', `${S.cwd} (dossier personnel ou racine : très large)`, 'lance fs-cli depuis le dossier de ton projet (cd mon-projet puis fs-cli)');
  else add(isFolderTrusted(S.cwd) ? 'ok' : 'warn', 'Dossier de travail', S.cwd + (isFolderTrusted(S.cwd) ? ' (approuvé)' : ' (non approuvé)'), isFolderTrusted(S.cwd) ? undefined : 'relance fs-cli ici et réponds « Oui » à la question de confiance');

  // commande fs-cli dans le PATH
  const where = spawnSync(IS_WIN ? 'where' : 'which', ['fs-cli'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) add('ok', 'Commande fs-cli', 'utilisable partout');
  else add('warn', 'Commande fs-cli', 'pas installée globalement', INSTALL_CMD);

  // Windows : stratégie d'exécution PowerShell (sinon npm / fs-cli.ps1 sont bloqués)
  if (IS_WIN) {
    const ep = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const pol = (ep.stdout || '').trim();
    // scripts bloqués : à l'installation, FS-CLI met de côté son lanceur fs-cli.ps1 (src/postinstall.js) et PowerShell prend
    // fs-cli.cmd ; la stratégie de sécurité de Windows n'a pas besoin d'être changée
    const cmdShim = where.status === 0 ? String(where.stdout).split(/\r?\n/).map(l => l.trim()).find(l => /fs-cli\.cmd$/i.test(l)) : null;
    const ps1 = !!cmdShim && fs.existsSync(cmdShim.replace(/\.cmd$/i, '.ps1'));   // « where » ne liste pas les .ps1
    if (BLOCKING.test(pol) && ps1) add('warn', 'PowerShell', `stratégie d'exécution « ${pol} » : dans PowerShell, « fs-cli » est refusé (scripts désactivés)`, `dans cmd : ${INSTALL_CMD} (FS-CLI s'adapte tout seul, sans toucher à la sécurité de Windows)`);
    else if (BLOCKING.test(pol)) add('ok', 'PowerShell', `stratégie d'exécution « ${pol} » : « fs-cli » passe par fs-cli.cmd et marche aussi dans PowerShell ; pour npm, tape npm.cmd`);
    else add('ok', 'PowerShell', `stratégie d'exécution « ${pol || '?'} »`);
    const term = process.env.WT_SESSION ? 'Windows Terminal' : process.env.TERM_PROGRAM === 'vscode' ? 'terminal de VS Code' : process.env.ConEmuPID ? 'ConEmu' : process.env.TERM_PROGRAM || '';
    if (term) add('ok', 'Terminal', term);
    else add('warn', 'Terminal', 'console Windows classique : couleurs, accents et collage d\'images limités', 'utilise Windows Terminal (installé par défaut sur Windows 11)');
  }

  // Mac / Linux : Rosetta, npm -g, outils Xcode, terminal
  out.push(...unixChecks());

  // moteur et mode
  add(cfg.engine === 'native' ? 'ok' : 'warn', 'Moteur', cfg.engine === 'native' ? 'natif (outils officiels de France Student)' : 'mode chat (secours)', cfg.engine === 'native' ? undefined : '/engine native (modèles Claude ou GPT)');

  // MCP (rien n'est démarré)
  const servers = Object.entries(loadMcpConfig(S.cwd).mcpServers || {}).filter(([, s]) => !s.disabled);
  if (!servers.length) add('ok', 'Serveurs MCP', 'aucun');
  else {
    const imported = servers.filter(([, s]) => s._scope === 'importé');
    const pending = imported.filter(([n, s]) => !isImportApproved(n, s)).map(([n]) => n);
    const oauth = imported.filter(([, s]) => s.url && !s.headers).map(([n]) => n);
    add('ok', 'Serveurs MCP', `${servers.length} (${imported.length} importés de Claude Code, Codex…)`);
    if (pending.length) add('warn', 'MCP non autorisés', pending.join(', '), 'tape « /mcp <nom> » pour autoriser ceux que tu veux utiliser');
    if (oauth.length) add('warn', 'MCP en ligne', `${oauth.join(', ')} : peuvent demander une connexion à un compte (OAuth) non réutilisable`, 'utilise-les depuis l\'outil où tu les as connectés');
  }

  // skills
  const skills = discoverSkills(S.cwd);
  add('ok', 'Skills', `${skills.length} trouvés${cfg.importTools === false ? ' (import désactivé : /import on)' : ''}`);

  // dossier de données
  try { fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 }); fs.accessSync(HOME_DIR, fs.constants.W_OK); add('ok', 'Données du CLI', HOME_DIR.replace(os.homedir(), '~')); }
  catch { add('err', 'Données du CLI', `${HOME_DIR} : écriture impossible`, 'vérifie les droits de ce dossier'); }

  return out;
}
