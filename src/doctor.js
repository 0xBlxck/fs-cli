// /doctor : vérifie l'installation d'un coup et dit quoi corriger. Lecture seule : rien n'est modifié, aucun serveur MCP n'est démarré.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOKEN, VERSION, HOME_DIR, cfg } from './config.js';
import { getJson } from './api.js';
import { checkUpdate, INSTALL_CMD } from './update.js';
import { isFolderTrusted, isBroadFolder } from './trust.js';
import { loadMcpConfig } from './mcp.js';
import { isImportApproved } from './approvals.js';
import { discoverSkills } from './discover.js';

const IS_WIN = process.platform === 'win32';

/** Liste de vérifications : { level: 'ok'|'warn'|'err', label, detail, fix? } */
export async function runDoctor(S) {
  const out = [];
  const add = (level, label, detail, fix) => out.push({ level, label, detail, fix });

  // Node.js
  const major = parseInt(process.versions.node, 10);
  if (major >= 20) add('ok', 'Node.js', `v${process.versions.node}`);
  else add('err', 'Node.js', `v${process.versions.node} (trop ancien)`, 'installe la version LTS : winget install OpenJS.NodeJS.LTS');

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
    if (/^(Restricted|AllSigned)$/i.test(pol)) add('err', 'PowerShell', `stratégie d'exécution « ${pol} » : npm et fs-cli peuvent être bloqués`, 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
    else add('ok', 'PowerShell', `stratégie d'exécution « ${pol || '?'} »`);
    const term = process.env.WT_SESSION ? 'Windows Terminal' : process.env.TERM_PROGRAM === 'vscode' ? 'terminal de VS Code' : process.env.ConEmuPID ? 'ConEmu' : process.env.TERM_PROGRAM || '';
    if (term) add('ok', 'Terminal', term);
    else add('warn', 'Terminal', 'console Windows classique : couleurs, accents et collage d\'images limités', 'utilise Windows Terminal (installé par défaut sur Windows 11)');
  }

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
