// Blocs de code d'une réponse de chat (mode « chat » de secours) : fichiers nommés, commandes, appels MCP, code du « panneau » FS
import { parseMcpBlock } from './mcp.js';
import { parseFenceInfo, captionFile, isFilePath } from './fence.js';

// ── Blocs de code d'une réponse de chat classique (mode « chat » + /run) ──────
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'ps1', 'pwsh', 'console']);
const PY_LANGS = new Set(['python', 'py', 'python3']);
const JS_LANGS = new Set(['javascript', 'js', 'node', 'mjs', 'cjs']);
const FILE_RE = /^[\w.\/\\:-]+\.[A-Za-z0-9]{1,6}$/;
const EXT_LANG = { py: 'python', js: 'javascript', mjs: 'javascript', ps1: 'powershell', sh: 'bash' };

export function extractBlocks(text) {
  const blocks = [], lines = text.split(/\r?\n/);
  let i = 0, caption = '';
  while (i < lines.length) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
    if (!m) { if (lines[i].trim()) caption = lines[i]; i++; continue; }
    const closeRe = new RegExp('^\\s*' + m[1][0] + '{' + m[1].length + ',}\\s*$');
    const body = []; i++;
    while (i < lines.length && !closeRe.test(lines[i])) body.push(lines[i++]);
    i++;
    const infoStr = m[2].trim();
    if (/^mcp[\s:]/i.test(infoStr + ' ')) {                 // ```mcp serveur.outil + arguments JSON
      const p = parseMcpBlock(infoStr, body.join('\n')); caption = '';
      if (p) blocks.push({ lang: 'mcp', name: `${p.server}.${p.tool}`, code: body.join('\n'), mcp: p, action: 'mcp' });
      continue;
    }
    const fi = parseFenceInfo(infoStr);                      // gère les chemins avec espaces : « html HTML SITE\index.html »
    let lang = fi.lang.toLowerCase(), name = fi.name || null;
    if (fi.fileFirst) lang = EXT_LANG[name.split('.').pop().toLowerCase()] || lang;
    if (!name) name = captionFile(caption);
    caption = '';
    if (body.join('\n').trim()) blocks.push({ lang, name, code: body.join('\n') });
  }
  return blocks.map(b => ({ ...b, action: b.action || (b.name ? 'write' : SHELL_LANGS.has(b.lang) ? 'shell' : PY_LANGS.has(b.lang) ? 'python' : JS_LANGS.has(b.lang) ? 'node' : null) }))
    .filter(b => b.action);
}

/** Pour l'exécution auto : tous les fichiers à écrire + un seul type de commande (python OU shell… = alternatives) */
export function pickAutoBlocks(blocks) {
  const keep = blocks.find(b => b.action !== 'write' && b.action !== 'mcp')?.action;
  return blocks.filter(b => b.action === 'write' || b.action === 'mcp' || b.action === keep);
}

/** Documents « panneau » (tool-createDocument / updateDocument) d'un message assistant → blocs /run */
export function panelBlocks(message) {
  const out = [];
  for (const p of message?.parts || []) {
    if (!/^tool-(create|update)Document$/.test(p?.type || '')) continue;
    const code = p.output?.content ?? p.input?.content;
    const title = String(p.output?.title ?? p.input?.title ?? '').trim();
    if (!code || !String(code).trim()) continue;
    const ext = (title.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1]?.toLowerCase() || '';
    const run = { py: 'python', js: 'node', mjs: 'node', cjs: 'node', ps1: 'shell' }[ext];
    if (run) out.push({ lang: ext === 'py' ? 'python' : ext, name: title, code, action: run, source: 'panneau' });
    else if (isFilePath(title)) out.push({ lang: ext, name: title, code, action: 'write', source: 'panneau' });
  }
  return out;
}
