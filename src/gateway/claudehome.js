// « fs claude » : dossier Claude Code à part (CLAUDE_CONFIG_DIR), pour que ses sessions ne se mélangent plus
// à celles du vrai Claude Code (liste de VS Code, /resume, flèche ↑).
// - partagés EN DIRECT (lien de dossier / jonction Windows, sans droits admin) : skills, commandes, agents, plugins, styles,
//   hooks et ide (connexion à l'éditeur) : rien n'est dupliqué, une modification vaut pour les deux ;
// - recopiés à chaque lancement depuis le vrai Claude Code (il reste la référence) : settings.json, settings.local.json,
//   CLAUDE.md, keybindings.json, et ~/.claude.json (serveurs MCP, accueil déjà fait, confiance des dossiers) ;
// - à part : sessions (projects/), historique des demandes, todos, plans… Jamais copiés : les identifiants (.credentials*)
//   ni rien d'autre du dossier de l'utilisateur.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHARED_DIRS = ['skills', 'commands', 'agents', 'plugins', 'output-styles', 'hooks', 'ide'];
export const COPIED_FILES = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'keybindings.json'];
/** Champs d'un projet de .claude.json propres aux sessions : ceux de fs claude sont gardés, pas écrasés par le vrai. */
const SESSION_FIELDS = ['lastSessionId', 'lastCost', 'lastAPIDuration', 'lastAPIDurationWithoutRetries', 'lastToolDuration', 'lastDuration',
  'lastLinesAdded', 'lastLinesRemoved', 'lastTotalInputTokens', 'lastTotalOutputTokens', 'lastTotalCacheCreationInputTokens',
  'lastTotalCacheReadInputTokens', 'lastTotalWebSearchRequests', 'lastModelUsage', 'lastSessionMetrics', 'history', 'exampleFiles', 'exampleFilesGeneratedAt'];

/** Dossier Claude Code de l'utilisateur (CLAUDE_CONFIG_DIR s'il en a un) et son .claude.json. */
export function userClaudeDirs(env = process.env, home = os.homedir()) {
  const dir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  const json = env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
  return { dir, json };
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** .claude.json de fs claude : celui de l'utilisateur, en gardant les champs de session de fs claude par projet. */
export function mergeClaudeJson(user, mine) {
  if (!user || typeof user !== 'object') return mine && typeof mine === 'object' ? mine : {};
  const projects = {};
  for (const [k, p] of Object.entries(user.projects || {})) {     // réglages des dossiers (confiance, MCP locaux…), jamais leurs sessions
    if (!p || typeof p !== 'object') { projects[k] = p; continue; }
    projects[k] = Object.fromEntries(Object.entries(p).filter(([f]) => !SESSION_FIELDS.includes(f)));
  }
  for (const [k, p] of Object.entries(mine?.projects || {})) {    // sessions de fs claude : gardées
    if (!p || typeof p !== 'object') continue;
    projects[k] = { ...(projects[k] || {}), ...Object.fromEntries(SESSION_FIELDS.filter(f => f in p).map(f => [f, p[f]])) };
  }
  return { ...user, projects };
}

/**
 * Prépare le dossier de fs claude. Ne lève jamais : en cas d'échec, { dir: null, errors } (fs claude utilise alors
 * le dossier normal, comme avant). → { dir, linked: [], copied: [], errors: [] }
 */
export function prepareClaudeHome({ target, env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const res = { dir: null, linked: [], copied: [], errors: [] };
  try {
    const src = userClaudeDirs(env, home);
    if (samePath(src.dir, target)) { res.errors.push('dossier source et dossier de fs claude identiques'); return res; }
    fs.mkdirSync(target, { recursive: true });
    for (const name of SHARED_DIRS) {
      const from = path.join(src.dir, name), to = path.join(target, name);
      if (!exists(from)) continue;
      try {
        if (isLink(to)) {
          let cur = ''; try { cur = fs.readlinkSync(to); } catch {}
          if (cur && samePath(cur.replace(/^\\\\\?\\/, ''), from)) { res.linked.push(name); continue; }
          try { fs.unlinkSync(to); } catch { fs.rmdirSync(to); }    // lien vers un autre endroit : refait (le lien seul, jamais la cible)
        } else if (exists(to)) { res.errors.push(`${name} : un vrai dossier existe déjà dans ${target}, laissé tel quel`); continue; }
        fs.symlinkSync(from, to, platform === 'win32' ? 'junction' : 'dir');
        res.linked.push(name);
      } catch (e) { res.errors.push(`${name} : ${e.message}`); }
    }
    for (const name of COPIED_FILES) {
      const from = path.join(src.dir, name), to = path.join(target, name);
      try {
        if (exists(from)) { fs.copyFileSync(from, to); res.copied.push(name); }
        else if (exists(to) && !isLink(to)) fs.unlinkSync(to);   // retiré chez l'utilisateur : la copie l'est aussi
      } catch (e) { res.errors.push(`${name} : ${e.message}`); }
    }
    const mineFile = path.join(target, '.claude.json');
    const merged = mergeClaudeJson(readJson(src.json), readJson(mineFile));
    const tmp = mineFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, mineFile);
    res.copied.push('.claude.json');
    res.dir = target;
  } catch (e) { res.errors.push(e.message); }
  return res;
}

/**
 * Déplace des sessions Claude Code (jsonl + dossier du même nom + file-history) d'un dossier de config à un autre,
 * sans rien supprimer. → { moved: [ids], skipped: [ids] }
 */
export function moveSessions(ids, fromDir, toDir, project) {
  const out = { moved: [], skipped: [] };
  const fromP = path.join(fromDir, 'projects', project), toP = path.join(toDir, 'projects', project);
  fs.mkdirSync(toP, { recursive: true });
  for (const id of ids) {
    const f = path.join(fromP, id + '.jsonl');
    if (!exists(f) || exists(path.join(toP, id + '.jsonl'))) { out.skipped.push(id); continue; }
    fs.renameSync(f, path.join(toP, id + '.jsonl'));
    for (const [a, b] of [[path.join(fromP, id), path.join(toP, id)], [path.join(fromDir, 'file-history', id), path.join(toDir, 'file-history', id)]]) {
      if (exists(a) && !exists(b)) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); }
    }
    out.moved.push(id);
  }
  return out;
}
