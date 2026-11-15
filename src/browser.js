// Navigateur piloté : détection de l'extension « Playwright MCP Bridge » (mode « ton Chrome »).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLAYWRIGHT_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';

/**
 * Configuration du serveur navigateur, au niveau de Claude in Chrome :
 * vision (clic aux coordonnées d'une capture), pdf, devtools (console, réseau…), fichiers produits hors du projet.
 * En mode « ton Chrome » (--extension), les onglets pilotés sont regroupés dans un groupe d'onglets à part.
 */
export function playwrightServer({ mineChrome = false, token = '', outDir }) {
  return {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--caps', 'vision,pdf,devtools', '--output-dir', outDir, ...(mineChrome ? ['--extension'] : [])],
    ...(mineChrome && token ? { env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } } : {}),
    description: mineChrome ? 'ton Chrome (extension Playwright MCP Bridge)' : 'navigateur piloté (Playwright)',
  };
}

/** Dossiers de données de Chrome (Windows, macOS, Linux). */
function chromeUserDataDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') return [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')];
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')];
  return [path.join(home, '.config', 'google-chrome'), path.join(home, '.config', 'chromium')];
}

/** L'extension est-elle installée dans un des profils Chrome ? (lecture seule) */
export function chromeExtensionInstalled(id = PLAYWRIGHT_EXTENSION_ID) {
  for (const base of chromeUserDataDirs()) {
    let profiles = [];
    try { profiles = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name))).map(d => d.name); } catch { continue; }
    for (const p of profiles) { try { if (fs.statSync(path.join(base, p, 'Extensions', id)).isDirectory()) return true; } catch {} }
  }
  return false;
}
