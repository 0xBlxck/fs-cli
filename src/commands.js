// Commandes perso : un fichier Markdown = une commande. « review.md » devient « /review ».
// Dossiers lus (le premier trouvé gagne) : <projet>/.fs-cli/commands, <projet>/.claude/commands,
// ~/.fs-cli/commands, ~/.claude/commands (les commandes de Claude Code marchent telles quelles).
// Dans le texte, $ARGUMENTS est remplacé par ce qui suit la commande ($1, $2… par les mots).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR } from './config.js';

function frontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const l of m[1].split(/\r?\n/)) { const kv = l.match(/^([\w-]+):\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim(); }
  return { meta, body: text.slice(m[0].length) };
}

export function commandDirs(cwd) {
  const home = process.env.FS_CLI_HOME ? null : os.homedir();       // tests : seulement les dossiers du projet et de FS_CLI_HOME
  return [
    [path.join(cwd, '.fs-cli', 'commands'), 'projet'],
    [path.join(cwd, '.claude', 'commands'), 'projet (Claude Code)'],
    [path.join(HOME_DIR, 'commands'), 'perso'],
    ...(home ? [[path.join(home, '.claude', 'commands'), 'perso (Claude Code)']] : []),
  ];
}

/** [{ name, description, body, file, source }] ; sous-dossiers : « git/commit.md » → /git:commit (comme Claude Code). */
export function loadCustomCommands(cwd) {
  const out = new Map();
  for (const [dir, source] of commandDirs(cwd)) {
    const walk = (d, prefix, depth) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        // lien symbolique (dotfiles avec stow, chezmoi… courant sur Mac) : on suit sa cible ; profondeur limitée, donc pas de boucle
        let isDir = e.isDirectory(), isFile = e.isFile();
        if (e.isSymbolicLink()) { try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; } }
        if (isDir && depth < 2) walk(p, prefix + e.name + ':', depth + 1);
        else if (isFile && /\.md$/i.test(e.name)) {
          const name = (prefix + e.name.replace(/\.md$/i, '')).toLowerCase();
          if (!/^[\w:-]{1,60}$/.test(name) || out.has(name)) continue;
          let text = ''; try { text = fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { continue; }
          const { meta, body } = frontmatter(text);
          const description = meta.description || body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'))?.slice(0, 80) || '';
          out.set(name, { name, description, body: body.trim(), file: p, source, argumentHint: meta['argument-hint'] || '' });
        }
      }
    };
    walk(dir, '', 0);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Texte final de la commande : $ARGUMENTS (tout), $1… (mots). */
export function expandCommand(cmd, args) {
  const words = String(args || '').trim().split(/\s+/).filter(Boolean);
  let body = cmd.body.replace(/\$ARGUMENTS/g, String(args || '').trim()).replace(/\$(\d)/g, (_, i) => words[Number(i) - 1] || '');
  if (!/\$ARGUMENTS|\$\d/.test(cmd.body) && args && args.trim()) body += `\n\n${args.trim()}`;   // pas de variable : les arguments sont ajoutés à la fin
  return body;
}
