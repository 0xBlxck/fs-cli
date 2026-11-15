// Navigateur piloté : détection de l'extension « Playwright MCP Bridge » (mode « ton Chrome »).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLAYWRIGHT_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';

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
