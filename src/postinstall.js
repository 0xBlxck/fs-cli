// Après « npm install -g » sous Windows : dans PowerShell, « fs-cli » passe par le lanceur fs-cli.ps1 que npm crée.
// Or un Windows neuf bloque les scripts PowerShell (politique « Restricted ») : « fs-cli : Impossible de charger le fichier
// …\fs-cli.ps1, car l'exécution de scripts est désactivée sur ce système ». Dans ce cas SEULEMENT, ce lanceur est mis de côté
// (renommé, pas supprimé) : PowerShell prend alors fs-cli.cmd, qui marche partout (cmd, PowerShell ; Git Bash a son lanceur).
// La politique de sécurité de Windows n'est jamais modifiée. Ce script ne fait jamais échouer l'installation.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SHIMS = ['fs-cli', 'fs-mcp'];
/** politiques qui empêchent un script .ps1 local non signé de se lancer (Undefined partout = Restricted sur Windows client) */
export const BLOCKING = /^(Restricted|AllSigned|Undefined)$/i;

/** Politique d'exécution effective d'une nouvelle fenêtre PowerShell (Windows PowerShell 5.1, celle de Windows). */
export function executionPolicy(env = process.env) {
  if (env.FS_CLI_TEST_POLICY) return env.FS_CLI_TEST_POLICY;                       // tests
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...env, PSExecutionPolicyPreference: '' } });
    return String(r.stdout || '').trim() || null;
  } catch { return null; }
}

/** Dossier global de npm où sont les lanceurs (le paquet est dans <prefix>\node_modules\fs-cli) ; null hors installation globale. */
export function globalPrefix(pkgRoot, env = process.env) {
  const candidates = [env.npm_config_prefix, path.resolve(pkgRoot, '..', '..')].filter(Boolean);
  for (const p of candidates) {
    const inside = path.resolve(pkgRoot).toLowerCase().startsWith(path.join(path.resolve(p), 'node_modules').toLowerCase());
    if (inside && fs.existsSync(path.join(p, 'fs-cli.cmd'))) return p;
  }
  return null;
}

/**
 * → { prefix, policy, moved: [noms], kept: raison } ; ne lève jamais.
 * moved : lanceurs .ps1 mis de côté (fs-cli.ps1 → fs-cli.ps1.bloque) parce que PowerShell les aurait refusés.
 */
export function fixPowerShellShims({ pkgRoot, env = process.env, platform = process.platform } = {}) {
  const out = { prefix: null, policy: null, moved: [], kept: null };
  try {
    if (platform !== 'win32') { out.kept = 'pas Windows'; return out; }
    out.prefix = globalPrefix(pkgRoot, env);
    if (!out.prefix) { out.kept = 'pas une installation globale'; return out; }
    out.policy = executionPolicy(env);
    if (!out.policy || !BLOCKING.test(out.policy)) { out.kept = `PowerShell autorise les scripts (${out.policy || 'inconnu'})`; return out; }
    for (const name of SHIMS) {
      const ps1 = path.join(out.prefix, name + '.ps1'), cmd = path.join(out.prefix, name + '.cmd');
      if (!fs.existsSync(ps1) || !fs.existsSync(cmd)) continue;                  // jamais sans le .cmd de secours
      fs.renameSync(ps1, ps1 + '.bloque');
      out.moved.push(name + '.ps1');
    }
  } catch (e) { out.kept = 'erreur : ' + e.message; }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = fixPowerShellShims({ pkgRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
  if (r.moved.length) console.log(`fs-cli : PowerShell bloque les scripts (${r.policy}) ; ${r.moved.join(', ')} mis de côté, « fs-cli » passe par fs-cli.cmd et marche partout.`);
  process.exitCode = 0;
}
