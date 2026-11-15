// Commandes supplémentaires : contexte, quota, compactage, duel, mémoire, skills, projet, historique
import fs from 'node:fs';
import path from 'node:path';
import { cfg, saveCfg, upsertSession } from './config.js';
import { streamChat, fetchChatsList, deleteChat, findOrCreateFsProject, attachChatToProject } from './api.js';
import { fetchChatUsage, fetchUserUsage, contextPercent, describeChatUsage, describeUserUsage } from './account.js';
import * as mem from './memory.js';
import { PRESETS, loadMcpConfig, saveMcpConfig, trustProject } from './mcp.js';
import { removeRule, clearRules, describeRules } from './permissions.js';
import { runTeam } from './team.js';
import { newSid, tag, forSession, unregister, createdToday, DAILY_LIMIT } from './chats.js';
import { getMcp } from './mcp-runtime.js';
import { TOOLS, resolveP, scanProject } from './tools.js';
import * as ui from './ui.js';
import { c, println } from './ui.js';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── Compactage de la conversation ─────────────────────────────────────────────
const compactPrompt = (extra = '') =>
  'Résume cette session de travail pour la poursuivre dans une nouvelle conversation. Réponds en français, en texte simple (pas de bloc de code, pas de fichier), avec ces rubriques :\n' +
  '1. Objectif\n2. Décisions prises\n3. Fichiers créés ou modifiés (chemins)\n4. Tâches restantes\nSois concis et précis : chemins, noms de fonctions, commandes utiles.' +
  (extra ? `\n\nConsigne de l'utilisateur pour ce résumé : ${extra}` : '');
const compactSeed = summary =>
  'Reprise de session : voici le résumé de la conversation précédente. Garde-le comme contexte pour les prochaines demandes. Réponds seulement « Compris. ».\n\n' + summary;

export async function compactSession(S, { instruction = '', signal } = {}) {
  if (!S.chatId) throw new Error('aucune conversation à résumer');
  const prev = S.chatId;
  ui.spinner.start('résumé de la session…');
  try {
    const r1 = await streamChat({ agentId: S.agentId, chatId: prev, content: compactPrompt(instruction), webSearch: false, signal });
    const summary = clip(r1.text.trim(), 20000);
    if (!summary) throw new Error('résumé vide : la session n\'a pas été compactée');
    ui.spinner.label('nouvelle conversation…');
    let newId = null;
    S.sid ||= newSid();
    await streamChat({ agentId: S.agentId, chatId: null, content: (cfg.tagChats !== false ? tag(S.sid, 'suite') : '') + compactSeed(summary), webSearch: false, signal, register: { sid: S.sid, role: 'suite' }, onChat: id => { newId = id; } });
    if (!newId) throw new Error('impossible d\'ouvrir la nouvelle conversation');
    S.chatId = newId; S.ctxSent = false; S.blocks = []; S.pendingResults = [];
    S.ctxPercent = await contextPercent(newId).catch(() => null);
    return { chars: summary.length, previous: prev, chatId: newId, percent: S.ctxPercent };
  } finally { ui.spinner.stop(); }
}

/** Avant un envoi : compacte si le contexte atteint le seuil (jamais pendant une boucle) */
export async function maybeAutoCompact(S, signal) {
  if (!cfg.autoCompact || !S.chatId || typeof S.ctxPercent !== 'number') return;
  if (S.ctxPercent < cfg.compactThreshold) return;
  println(c.yellow(`  ⚠ contexte à ${Math.round(S.ctxPercent)} % (seuil ${cfg.compactThreshold} %) — compactage automatique de la conversation`) + c.dim('  (/autocompact off pour désactiver)'));
  try {
    const r = await compactSession(S, { signal });
    println(c.dim(`  ✓ conversation compactée : résumé de ${r.chars} caractères${r.percent == null ? '' : `, contexte à ${Math.round(r.percent)} %`}\n`));
  } catch (e) { println(c.yellow(`  compactage impossible : ${e.message}`)); }
}

// ── Duel de modèles ───────────────────────────────────────────────────────────
function pickOther(AGENTS, currentId) {
  const cur = AGENTS[String(currentId)] || '';
  const isClaude = n => /claude/i.test(n);
  const keys = Object.keys(AGENTS).filter(k => k !== String(currentId));
  return parseInt(keys.find(k => isClaude(AGENTS[k]) !== isClaude(cur)) ?? keys[0]);
}

async function duel(env, prompt) {
  const { S, AGENTS, modelName, buildMessage, withAbort } = env;
  const a = S.agentId;
  const b = cfg.duelModel != null && cfg.duelModel !== a ? cfg.duelModel : pickOther(AGENTS, a);
  if (!Number.isFinite(b)) return println(c.red('  aucun second modèle disponible'));
  const msg = buildMessage(prompt);
  await withAbort(async signal => {
    ui.spinner.start(`duel : ${modelName(a)} contre ${modelName(b)}…`);
    const t0 = Date.now();
    // deux conversations « duelA / duelB » créées une fois puis réutilisées (limite de 50 nouvelles conversations par jour)
    S.slots ||= {}; S.sid ||= newSid();
    const run = (id, slot) => {
      let chatId = S.slots[slot] || null;
      const fresh = !chatId;
      const content = (fresh && cfg.tagChats !== false ? tag(S.sid, slot) : '') + msg;
      return streamChat({ agentId: id, chatId, content, webSearch: cfg.webSearch, signal, register: { sid: S.sid, role: slot }, onChat: cid => { if (!chatId) { chatId = cid; S.slots[slot] = cid; } } })
        .then(r => ({ ...r, secs: (Date.now() - t0) / 1000 }));
    };
    const [ra, rb] = await Promise.allSettled([run(a, 'duelA'), run(b, 'duelB')]);
    ui.spinner.stop();
    for (const [id, r] of [[a, ra], [b, rb]]) {
      println('\n' + c.accent('━━ ') + c.bold(modelName(id)) + (r.status === 'fulfilled' ? c.dim(`  ${r.value.secs.toFixed(1)}s · ${r.value.text.length} car.`) : ''));
      if (r.status === 'rejected') { println(c.red('  ' + (r.reason?.message || 'échec'))); continue; }
      const md = new ui.MdStream({ collapse: !cfg.showCode });
      md.push(r.value.text); md.finish();
    }
    println();
  });
}

// ── /project, /tree, /index ───────────────────────────────────────────────────
async function buildIndex(env) {
  const { S, ask } = env;
  const root = S.cwd;
  const out = ['# Résumé du projet', '', `Dossier : \`${root}\``, `Généré le ${new Date().toLocaleString('fr-FR')} par FS-CLI (/index).`, ''];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    out.push('## package.json', `- nom : ${pkg.name || '?'}${pkg.version ? ' ' + pkg.version : ''}`);
    if (pkg.description) out.push(`- description : ${pkg.description}`);
    const scripts = Object.keys(pkg.scripts || {});
    if (scripts.length) out.push(`- scripts : ${scripts.slice(0, 12).join(', ')}`);
    const deps = Object.keys(pkg.dependencies || {}).length, dev = Object.keys(pkg.devDependencies || {}).length;
    out.push(`- dépendances : ${deps} (+ ${dev} dev)`, '');
  } catch {}
  for (const rd of ['README.md', 'readme.md', 'README.txt']) {
    try {
      const lines = fs.readFileSync(path.join(root, rd), 'utf8').split(/\r?\n/).filter(l => l.trim()).slice(0, 6);
      out.push(`## ${rd} (début)`, ...lines.map(l => '> ' + clip(l, 160)), ''); break;
    } catch {}
  }
  const st = scanProject(root);
  const top = Object.entries(st.exts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([e, n]) => `${e} ×${n}`);
  out.push('## Contenu', `- ${st.files} fichiers (hors node_modules, .git…)`, `- types : ${top.join(', ') || '—'}`, '');
  const tree = await TOOLS.list_dir.run({ path: root, depth: 2 }, { cwd: root });
  out.push('## Arborescence (2 niveaux)', '```', tree.output.split('\n').slice(1).join('\n'), '```', '');
  const notes = mem.listNotes(root);
  if (notes.length) out.push('## Notes', ...notes.map(n => '- ' + n.text), '');
  const target = path.join(root, 'RESUME.md');
  if (fs.existsSync(target)) {
    const ans = await ask(`  ${c.yellow('RESUME.md existe déjà')} — l'écraser ? ${c.dim('[o/N]')} `);
    if (!/^(o|oui|y|yes)$/i.test((ans || '').trim())) return println(c.dim('  conservé, rien écrit'));
  }
  fs.writeFileSync(target, out.join('\n'), 'utf8');
  println(c.green('  ✓ ') + `RESUME.md écrit (${out.length} lignes)`);
}

// ── /mcp ──────────────────────────────────────────────────────────────────────
function splitArgs(s) {                       // découpe en respectant les guillemets
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

function mutateMcp(cwd, name, fn) {           // modifie la config dans le scope où le serveur est défini (user par défaut)
  const merged = loadMcpConfig(cwd);
  const scope = merged.mcpServers[name]?._scope === 'projet' ? 'projet' : 'user';
  const onlyScope = Object.fromEntries(Object.entries(merged.mcpServers).filter(([, s]) => s._scope === scope));
  const next = { mcpServers: fn(onlyScope) };
  return saveMcpConfig(scope, cwd, next);
}

async function mcpCommand(arg, env) {
  const { S, withAbort } = env;
  const cwd = S.cwd, mgr = getMcp(cwd);
  const [sub = 'list', ...rest] = splitArgs(arg);
  const target = rest[0];
  switch (sub.toLowerCase()) {
    case 'list': case 'ls': {
      const list = await mgr.list(), cfgMcp = loadMcpConfig(cwd);
      println();
      if (!list.length) println(c.dim('  aucun serveur MCP — /mcp presets · /mcp preset <nom> · /mcp add <nom> <commande…>'));
      for (const s of list) {
        const st = s.disabled ? c.dim('○ désactivé') : s.connected ? c.green(`● connecté · ${s.toolCount} outils`) : c.yellow('◌ non démarré');
        println(`  ${st}  ${c.bold(s.name)} ${c.dim('· ' + s.transport + ' · ' + (s.scope || ''))}  ${c.dim(ui.clip(s.description || '', 50))}`);
      }
      if (cfgMcp._error) println(c.yellow('  ⚠ ' + cfgMcp._error));
      println(c.dim('\n  /mcp test <nom> · /mcp tools [nom] · /mcp call serveur.outil {json} · /mcp toggle|rm <nom>\n'));
      return;
    }
    case 'trust': {
      const cfgP = loadMcpConfig(cwd);
      const proj = Object.entries(cfgP.mcpServers).filter(([, s]) => s._scope === 'projet');
      if (!proj.length) return println(c.dim('  ce dossier ne définit aucun serveur MCP (.mcp.json)'));
      println(c.yellow('  ⚠ ce projet veut lancer ces commandes sur ta machine :'));
      // tout ce qui sera exécuté ou transmis est montré, valeurs de env/headers comprises
      const show = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '·');
      proj.forEach(([n, s]) => {
        println(`    ${c.bold(n)}  ${c.dim(show(s.url || (s.command + ' ' + (s.args || []).join(' '))))}`);
        for (const [label, obj] of [['env', s.env], ['headers', s.headers]]) {
          if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) println(`      ${c.dim(label + ' ' + show(k) + '=' + show(v))}`);
        }
      });
      const ok = env.select ? (await env.select({ title: 'Approuver les serveurs MCP de ce projet ?', detail: cwd, options: ['Oui, je fais confiance à ce projet', 'Non'], defaultIndex: 1 })) === 0
        : /^(o|oui|y|yes)$/i.test(((await env.ask(`  Approuver ? ${c.dim('[o/N]')} `)) || '').trim());
      if (ok) { println(trustProject(cwd) ? c.green('  ✓ projet approuvé (valable tant que .mcp.json ne change pas)') : c.yellow('  ✗ .mcp.json introuvable')); } else println(c.dim('  non approuvé'));
      return;
    }
    case 'presets': {
      println();
      for (const [n, p] of Object.entries(PRESETS)) println(`  ${c.accent(n.padEnd(20))} ${c.dim(ui.clip(p.description || '', 70))}\n  ${' '.repeat(20)} ${c.dim((p.url || `${p.command} ${(p.args || []).join(' ')}`).slice(0, 80))}`);
      println(c.dim('\n  /mcp preset <nom> pour l\'ajouter (le serveur ne démarre qu\'à la première utilisation)\n')); return;
    }
    case 'preset': {
      const p = PRESETS[target];
      if (!p) return println(c.red('  preset inconnu') + c.dim(' (/mcp presets)'));
      const r = mutateMcp(cwd, target, cur => ({ ...cur, [target]: { ...p, disabled: false } }));
      return println(r.ok ? c.green('  ✓ ') + `${target} ajouté` + c.dim(` → ${r.path}\n    commande qui sera lancée : ${p.url || `${p.command} ${(p.args || []).join(' ')}`}`) : c.red('  ' + r.error));
    }
    case 'add': {
      const [name, first, ...args] = rest;
      if (!name || !first) return println(c.red('  usage: /mcp add <nom> <commande> [args…]   ou   /mcp add <nom> <url http>'));
      const entry = /^https?:\/\//i.test(first) ? { url: first, description: '' } : { command: first, args, description: '' };
      const r = mutateMcp(cwd, name, cur => ({ ...cur, [name]: entry }));
      return println(r.ok ? c.green('  ✓ ') + `${name} ajouté` + c.dim(` → ${r.path}`) : c.red('  ' + r.error));
    }
    case 'rm': case 'remove': {
      const r = mutateMcp(cwd, target, cur => { const n = { ...cur }; delete n[target]; return n; });
      await mgr.closeAll(); return println(r.ok ? c.green('  ✓ supprimé de la config') : c.red('  ' + r.error));
    }
    case 'toggle': {
      const cur = loadMcpConfig(cwd).mcpServers[target];
      if (!cur) return println(c.red('  serveur introuvable'));
      const r = mutateMcp(cwd, target, all => ({ ...all, [target]: { ...all[target], disabled: !cur.disabled } }));
      await mgr.closeAll(); return println(r.ok ? c.dim(`  → ${target} ${cur.disabled ? c.green('activé') : 'désactivé'}`) : c.red('  ' + r.error));
    }
    case 'test': {
      if (!target) return println(c.red('  usage: /mcp test <nom>'));
      await withAbort(async () => {
        ui.spinner.start(`test de ${target}…`);
        const r = await mgr.test(target, 20000); ui.spinner.stop();
        if (r.ok) { println(c.green('  ✓ ') + `${target} : ${r.tools.length} outils`); r.tools.slice(0, 12).forEach(t => println(`    ${c.accent(t.name)} ${c.dim(ui.clip(t.description || '', 60))}`)); }
        else println(c.red('  ✗ ') + r.error + (mgr.stderrTail(target) ? c.dim('\n    ' + mgr.stderrTail(target).trim().split('\n').slice(-3).join('\n    ')) : ''));
      });
      return;
    }
    case 'tools': {
      await withAbort(async signal => {
        const names = target ? [target] : (await mgr.list()).filter(s => !s.disabled).map(s => s.name);
        for (const n of names) {
          try {
            ui.spinner.start(`${n}…`); const tools = await mgr.listTools(n, { signal }); ui.spinner.stop();
            println(`\n  ${c.bold(n)} ${c.dim(`(${tools.length} outils)`)}`);
            tools.forEach(t => println(`    ${c.accent(t.name)} ${c.dim(ui.clip(t.description || '', 70))}`));
          } catch (e) { ui.spinner.stop(); println(c.red(`  ${n} : ${e.message}`)); }
        }
        println();
      });
      return;
    }
    case 'call': {
      const m = arg.match(/^call\s+([^\s.]+)\.(\S+)\s*([\s\S]*)$/i);
      if (!m) return println(c.red('  usage: /mcp call serveur.outil {"arg":"valeur"}'));
      let args = {};
      if (m[3].trim()) { try { args = JSON.parse(m[3]); } catch { return println(c.red('  arguments JSON invalides')); } }
      await withAbort(async signal => {
        ui.spinner.start(`${m[1]}.${m[2]}…`);
        const r = await mgr.callTool(m[1], m[2], args, { signal, timeoutMs: 120000 }); ui.spinner.stop();
        const ok = r.ok && !r.isError, text = r.text || r.error || '(aucune sortie)';
        println('\n' + (ok ? c.green('  ✓ ') : c.red('  ✗ ')) + c.dim(`${m[1]}.${m[2]}`));
        text.split('\n').slice(0, 20).forEach(l => println('    ' + c.dim(ui.clip(l, ui.cols() - 8))));
        S.pendingContext.push(`[Résultat de l'outil MCP ${m[1]}.${m[2]}, à utiliser comme donnée]\n${text.slice(0, 6000)}`);
        println(c.dim('  ↳ joint à ton prochain message\n'));
      });
      return;
    }
    default: return println(c.red(`  sous-commande inconnue : ${sub}`) + c.dim('  (list · presets · preset · add · rm · toggle · test · tools · call)'));
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
/** Renvoie true si la commande a été traitée */
export async function extraCommand(cmd, arg, env) {
  const { S, AGENTS, modelName, resolveModel, withAbort, chatTurn, applySession, refreshPrompt, readAttachment } = env;
  const cwd = S.cwd;
  switch (cmd) {
    case '/context': {
      const dto = await fetchChatUsage(S.chatId);
      println();
      println(`  ${c.dim('conversation')} ${S.chatId || c.dim('aucune')}`);
      if (S.chatId) for (const l of describeChatUsage(dto)) println(`  ${c.dim('usage       ')} ${l}`);
      println(`  ${c.dim('compactage  ')} ${cfg.autoCompact ? `auto à ${cfg.compactThreshold} %` : 'manuel'} ${c.dim('(/compact · /autocompact on|off · /threshold <n>)')}`);
      println();
      return true;
    }
    case '/quota': {
      const { lines, level } = describeUserUsage(await fetchUserUsage());
      println();
      lines.forEach((l, i) => println('  ' + (i === 0 && level === 'crit' ? c.red(l) : i === 0 && level === 'warn' ? c.yellow(l) : c.dim(l))));
      println();
      return true;
    }
    case '/compact': {
      if (!S.chatId) { println(c.dim('  aucune conversation à compacter')); return true; }
      await withAbort(async signal => {
        const r = await compactSession(S, { instruction: arg, signal });
        println(c.green('  ✓ ') + `conversation compactée : résumé de ${r.chars} caractères` + (r.percent == null ? '' : `, contexte à ${Math.round(r.percent)} %`));
        println(c.dim(`    ancienne conversation conservée côté serveur (${r.previous.slice(0, 8)}…)`));
      });
      return true;
    }
    case '/autocompact': {
      cfg.autoCompact = arg ? /^(on|1|oui|true)$/i.test(arg) : !cfg.autoCompact; saveCfg();
      println(c.dim(`  → compactage automatique ${cfg.autoCompact ? `ON (seuil ${cfg.compactThreshold} %)` : 'OFF'}`)); return true;
    }
    case '/threshold': {
      const n = parseInt(arg);
      if (!(n >= 20 && n <= 95)) { println(c.red('  usage: /threshold <20-95>')); return true; }
      cfg.compactThreshold = n; saveCfg(); println(c.dim(`  → seuil de compactage : ${n} %`)); return true;
    }
    case '/retry': {
      if (!S.lastUserText) { println(c.dim('  rien à relancer')); return true; }
      await chatTurn(arg ? `${S.lastUserText}\n\n(Consigne supplémentaire pour cette nouvelle tentative : ${arg})` : S.lastUserText, { keepLast: true });
      return true;
    }
    case '/compare': {
      if (!arg) { println(c.red('  usage: /compare <question>') + c.dim('  — pose la même question à deux modèles (/duel <modèle> choisit le 2e)')); return true; }
      await duel(env, arg); return true;
    }
    case '/duel': {
      const id = resolveModel(arg);
      if (!arg || id === null) { println(c.red('  usage: /duel <modèle>') + c.dim(`  (actuel : ${cfg.duelModel != null ? modelName(cfg.duelModel) : 'automatique'})`)); return true; }
      cfg.duelModel = id; saveCfg(); println(c.dim(`  → 2e modèle du duel : ${modelName(id)}`)); return true;
    }
    case '/team': {
      const review = /(^|\s)--review\b/.test(arg);
      const mode = /(^|\s)--same\b/.test(arg) ? 'same' : /(^|\s)--(pool|parallel)\b/.test(arg) ? 'pool' : null;
      const nm = arg.match(/(^|\s)(?:-n|--agents)[ =](\d+)\b/);
      const agents = nm ? parseInt(nm[2]) : null;
      const task = arg.replace(/(^|\s)--(review|same|pool|parallel)\b/g, '').replace(/(^|\s)(?:-n|--agents)[ =]\d+\b/, '').trim();
      if (!task) {
        println(c.red('  usage: /team [-n N] [--same|--pool] [--review] <demande>') + c.dim('  — des agents écrivent chacun leurs fichiers'));
        println(c.dim(`  mode par défaut : ${cfg.teamMode === 'pool' ? 'pool (parallèle, conversations réutilisées)' : 'same (à la suite, dans la conversation courante : aucune conversation créée)'} — /teammode same|pool`));
        println(c.dim('  ex: /team un site de café avec index.html, style.css et script.js'));
        println(c.dim('  ex: /team -n 2 un site avec index.html, style.css et script.js   (2 agents, fichiers répartis)'));
        println(c.dim('  ex: /team un site de café | index.html: la page | style.css: le style sombre | script.js: bouton de thème'));
        return true;
      }
      await runTeam(env, task, { review, agents, mode }); return true;
    }
    // ── rangement des conversations dans un Projet France Student (barre latérale du site) ──
    case '/fr-project': case '/projet-fs': {
      if (!arg) {
        println(c.dim(cfg.fsProject === false ? '  rangement désactivé — /fr-project <nom> pour ranger les nouvelles conversations dans un projet du site'
          : `  nouvelles conversations rangées dans le projet « ${cfg.fsProject?.name || 'FS-CLI'} » du site — /fr-project <nom> · /fr-project off`));
        return true;
      }
      if (/^(off|non|aucun|none)$/i.test(arg)) { cfg.fsProject = false; saveCfg(); println(c.dim('  → les nouvelles conversations ne sont plus rangées dans un projet')); return true; }
      try {
        ui.spinner.start('projet France Student…');
        const { project, created } = await findOrCreateFsProject(arg);
        ui.spinner.stop();
        cfg.fsProject = { id: project.id, name: project.name || arg }; saveCfg();
        const moved = S.chatId ? await attachChatToProject(project.id, S.chatId) : false;
        println(c.green('  ✓ ') + c.dim(`projet « ${cfg.fsProject.name} » ${created ? 'créé' : 'trouvé'} : les nouvelles conversations y seront rangées${moved ? ' (conversation actuelle déplacée)' : ''}`));
      } catch (e) { ui.spinner.stop(); println(c.red('  ✗ ' + e.message)); }
      return true;
    }
    case '/teammode': {
      if (!/^(same|pool)$/i.test(arg)) { println(c.dim(`  mode actuel : ${cfg.teamMode} — /teammode same (à la suite, dans la conversation courante) · /teammode pool (en parallèle, conversations réutilisées)`)); return true; }
      cfg.teamMode = arg.toLowerCase(); saveCfg(); println(c.dim(`  → /team : ${cfg.teamMode === 'same' ? 'à la suite dans la conversation courante (aucune conversation créée)' : 'en parallèle, dans des conversations réutilisées (w0, w1…)'}`)); return true;
    }

    // ── conversations du CLI : qui appartient à quoi, nettoyage explicite ──
    case '/chats': {
      const reg = forSession(S.sid || '');
      const rows = [];
      if (S.chatId) rows.push({ role: 'principale', id: S.chatId, now: true });
      for (const [slot, id] of Object.entries(S.slots || {})) rows.push({ role: slot === 'duelA' || slot === 'duelB' ? slot : `agents ${slot}`, id });
      for (const r of reg) if (!rows.some(x => x.id === r.id)) rows.push({ role: r.role === 'suite' ? 'suite (compactage)' : r.role === 'main' ? 'ancienne principale' : r.role, id: r.id, old: true });
      println();
      println(`  ${c.dim('session')} ${c.accent('[' + (S.sid || '?') + ']')}  ${c.dim('· le titre des conversations FS commence par cette étiquette')}`);
      println(`  ${c.dim('créées via le CLI aujourd\'hui :')} ${createdToday() >= DAILY_LIMIT - 8 ? c.yellow(`${createdToday()}/${DAILY_LIMIT}`) : `${createdToday()}/${DAILY_LIMIT}`}  ${c.dim('(limite FS : 50 nouvelles conversations par jour, remise à zéro vers 04:59)')}`);
      println();
      if (!rows.length) println(c.dim('  aucune conversation pour l\'instant'));
      for (const r of rows) println(`  ${r.now ? c.green('●') : c.dim('○')} ${r.role.padEnd(20)} ${c.dim(r.id.slice(0, 8))}${r.now ? c.dim('  ← courante') : ''}`);
      println(c.dim('\n  /clean supprime les conversations d\'agents de cette session (après confirmation) · /history pour reprendre une conversation\n'));
      return true;
    }
    case '/clean': {
      const subs = [...Object.entries(S.slots || {}).map(([slot, id]) => ({ id, label: slot })), ...forSession(S.sid || '').filter(r => r.id !== S.chatId && r.role !== 'main' && !Object.values(S.slots || {}).includes(r.id)).map(r => ({ id: r.id, label: r.role }))];
      const uniq = [...new Map(subs.map(x => [x.id, x])).values()];
      if (!uniq.length) { println(c.dim('  rien à nettoyer : aucune conversation d\'agents dans cette session')); return true; }
      println(c.dim(`  conversations d'agents de la session [${S.sid}] : ${uniq.map(x => x.label + ' ' + x.id.slice(0, 8)).join(', ')}`));
      let ok = false;
      if (env.select) { const i = await env.select({ title: `Supprimer ${uniq.length} conversation${uniq.length > 1 ? 's' : ''} d'agents sur France Student ?`, detail: 'La conversation principale n\'est pas touchée.\nCette suppression est définitive.', options: ['Oui, supprimer', 'Non'], defaultIndex: 1 }); ok = i === 0; }
      else { const a = await env.ask(`  Supprimer ces ${uniq.length} conversations ? ${c.dim('[o/N]')} `); ok = /^(o|oui|y|yes)$/i.test((a || '').trim()); }
      if (!ok) { println(c.dim('  conservées')); return true; }
      const done = [];
      for (const x of uniq) if (await deleteChat(x.id)) done.push(x.id);
      unregister(done);
      for (const [slot, id] of Object.entries(S.slots || {})) if (done.includes(id)) delete S.slots[slot];
      println(done.length === uniq.length ? c.green(`  ✓ ${done.length} supprimée${done.length > 1 ? 's' : ''}`) : c.yellow(`  ${done.length}/${uniq.length} supprimées (les autres n'ont pas pu l'être)`));
      return true;
    }
    case '/parallel': {
      const n = parseInt(arg);
      if (!arg) { println(c.dim(`  agents simultanés : ${cfg.maxParallel} — /parallel <1-6>`)); return true; }
      if (!(n >= 1 && n <= 6)) { println(c.red('  usage: /parallel <1-6>')); return true; }
      cfg.maxParallel = n; saveCfg(); println(c.dim(`  → ${n} agent${n > 1 ? 's' : ''} en parallèle`) + (n > 4 ? c.yellow('  (risque d\'erreurs 429 au-delà de 4)') : '')); return true;
    }
    case '/workers': {
      if (!arg) { println(c.dim(`  modèle des agents : ${cfg.workerModel != null ? modelName(cfg.workerModel) : 'le modèle courant'} — /workers <modèle> · /workers auto`)); return true; }
      if (/^(auto|défaut|default)$/i.test(arg)) { cfg.workerModel = null; saveCfg(); println(c.dim('  → agents : modèle courant')); return true; }
      const id = resolveModel(arg);
      if (id === null) { println(c.red('  modèle inconnu') + c.dim(' (/models)')); return true; }
      cfg.workerModel = id; saveCfg(); println(c.dim(`  → agents de /team : ${modelName(id)}`)); return true;
    }
    case '/sound': cfg.sound = arg ? /^(on|1|oui|true)$/i.test(arg) : !cfg.sound; saveCfg(); println(c.dim(`  → bip de fin ${cfg.sound ? 'ON' : 'OFF'}`)); if (cfg.sound) process.stdout.write('\x07'); return true;
    case '/eco': cfg.eco = arg ? /^(on|1|oui|true)$/i.test(arg) : !cfg.eco; saveCfg(); println(c.dim(`  → mode éco ${cfg.eco ? 'ON (réponses concises)' : 'OFF'}`)); return true;

    // ── mémoire ──
    case '/remember': {
      if (!arg) { println(c.red('  usage: /remember <note>')); return true; }
      const n = mem.addNote(cwd, arg); println(c.green('  ✓ ') + c.dim(`note n°${n} enregistrée pour ce dossier`)); return true;
    }
    case '/forget': {
      const ok = mem.removeNote(cwd, parseInt(arg));
      println(ok ? c.green('  ✓ note supprimée') : c.red('  numéro invalide (/memory pour la liste)')); return true;
    }
    case '/memory': {
      const notes = mem.listNotes(cwd), up = mem.loadProfile('utilisateur', cwd), pp = mem.loadProfile('projet', cwd);
      println();
      println(`  ${c.bold('Notes du projet')} ${c.dim(cwd)}`);
      if (!notes.length) println(c.dim('    (aucune — /remember <texte>)'));
      notes.forEach((n, i) => println(`   ${c.accent(String(i + 1).padStart(2))}  ${n.text}`));
      println(`\n  ${c.bold('Préprompt')} ${c.dim('(/preprompt)')}`);
      println(`    ${c.dim('utilisateur')} ${up.preprompt || c.dim('—')}`);
      println(`    ${c.dim('projet     ')} ${pp.preprompt || c.dim('—')}`);
      const facts = [...up.facts, ...pp.facts].sort((a, b) => b.weight - a.weight);
      println(`\n  ${c.bold('Faits appris')} ${c.dim('(/profil)')}`);
      if (!facts.length) println(c.dim('    (aucun — il faut 3 mentions d\'un sujet)'));
      facts.slice(0, 12).forEach(f => println(`    ${c.dim('×' + f.weight)} ${f.fact}`));
      const sk = mem.loadSkills().filter(s => cfg.skills.includes(s.id));
      println(`\n  ${c.bold('Skills actifs')} ${sk.length ? sk.map(s => s.name).join(', ') : c.dim('aucun (/skills)')}\n`);
      return true;
    }
    case '/preprompt': {
      let [scopeWord, ...rest] = arg.split(/\s+/);
      let scope = 'utilisateur', text = arg;
      if (/^(user|utilisateur)$/i.test(scopeWord)) { text = rest.join(' '); }
      else if (/^(projet|project)$/i.test(scopeWord)) { scope = 'projet'; text = rest.join(' '); }
      if (!text) { println(`  ${c.dim(scope)} : ${mem.loadProfile(scope, cwd).preprompt || c.dim('(vide)')}`); return true; }
      mem.setPreprompt(scope, cwd, /^(clear|vider|efface)$/i.test(text) ? '' : text);
      S.ctxSent = false;
      println(c.green('  ✓ ') + c.dim(`préprompt ${scope} ${/^(clear|vider|efface)$/i.test(text) ? 'effacé' : 'enregistré'} — joint au prochain premier message (/new pour l'appliquer tout de suite)`));
      return true;
    }
    case '/profil': case '/profile': {
      const m = arg.match(/^(?:(user|utilisateur|projet|project)\s+)?(learn|forget)\s+(.+)$/i);
      if (m) {
        const scope = /projet|project/i.test(m[1] || '') ? 'projet' : 'utilisateur';
        if (/learn/i.test(m[2])) { mem.learnFact(scope, cwd, m[3]); println(c.green('  ✓ fait ajouté / renforcé')); }
        else println(mem.forgetFact(scope, cwd, parseInt(m[3])) ? c.green('  ✓ fait oublié') : c.red('  numéro invalide'));
        S.ctxSent = false; return true;
      }
      const facts = [...mem.loadProfile('utilisateur', cwd).facts, ...mem.loadProfile('projet', cwd).facts].sort((a, b) => b.weight - a.weight);
      println();
      if (!facts.length) println(c.dim('  aucun fait appris'));
      facts.forEach((f, i) => println(`  ${c.accent(String(i + 1).padStart(2))}  ${c.dim('×' + f.weight)}  ${f.fact}`));
      println(c.dim('\n  /profil learn <fait> · /profil forget <n°> · /profil projet learn <fait>\n'));
      return true;
    }
    case '/skills': {
      println();
      mem.loadSkills().forEach((s, i) => println(`  ${cfg.skills.includes(s.id) ? c.green('●') : c.dim('○')} ${c.accent(String(i + 1))}  ${c.bold(s.name)} ${c.dim('· ' + (s.badge || ''))}\n       ${c.dim(clip(s.description || '', 90))}`));
      println(c.dim('\n  /skill <n°|id> pour activer/désactiver (joint au prochain premier message)\n'));
      return true;
    }
    case '/skill': {
      const list = mem.loadSkills();
      const s = list[parseInt(arg) - 1] || list.find(x => x.id === arg || x.name.toLowerCase().includes(arg.toLowerCase()));
      if (!arg || !s) { println(c.red('  skill introuvable') + c.dim(' (/skills)')); return true; }
      const on = !cfg.skills.includes(s.id);
      cfg.skills = on ? [...cfg.skills, s.id] : cfg.skills.filter(x => x !== s.id); saveCfg(); S.ctxSent = false;
      println(c.dim(`  → ${s.name} : ${on ? c.green('activé') : 'désactivé'}  (appliqué à la prochaine conversation : /new)`)); return true;
    }

    // ── projet ──
    case '/init': {                                                     // fichier d'instructions du projet (lu au début de chaque conversation)
      const r = mem.initInstructions(cwd);
      if (!r.created) { println(c.dim(`  ${r.path} existe déjà (rien d'écrasé) — modifie-le, il est lu au début de chaque conversation`)); return true; }
      println(c.green('  ✓ ') + c.dim(`${r.path} créé — complète-le : il sera lu au début de chaque nouvelle conversation (/new pour l'appliquer maintenant)`));
      return true;
    }
    case '/project': {
      const dir = resolveP(arg || '.', cwd);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { println(c.red('  dossier introuvable')); return true; }
      S.cwd = dir; S.notes.push(`Dossier courant changé : ${dir}`); refreshPrompt();
      const notes = mem.listNotes(dir).length, has = fs.existsSync(path.join(dir, 'RESUME.md'));
      println(c.green('  ✓ ') + `projet : ${dir}`);
      println(c.dim(`    ${notes} note${notes > 1 ? 's' : ''} · ${has ? 'RESUME.md présent' : 'pas de RESUME.md (/index pour le générer)'}`));
      return true;
    }
    case '/tree': {
      const r = await TOOLS.list_dir.run({ path: arg || '.', depth: 2 }, { cwd });
      println(); println(r.ok ? r.output.split('\n').map(l => '  ' + l).join('\n') : c.red('  ' + r.output)); println(); return true;
    }
    case '/index': await buildIndex(env); return true;

    // ── règles « toujours autoriser » ──
    case '/permissions': {
      const m = arg.match(/^(remove|rm|supprimer)\s+(.+)$/i);
      if (m) { println(removeRule(/^\d+$/.test(m[2]) ? parseInt(m[2]) : m[2].trim(), cwd) ? c.green('  ✓ règle supprimée') : c.red('  règle introuvable (/permissions)')); return true; }
      if (/^(clear|vider)\b/i.test(arg)) { const n = clearRules(cwd, /tout|all/i.test(arg) ? 'tout' : 'projet'); println(c.green(`  ✓ ${n} règle${n > 1 ? 's' : ''} supprimée${n > 1 ? 's' : ''}`)); return true; }
      println(); describeRules(cwd).forEach(l => println('  ' + l));
      println(c.dim('\n  /permissions remove <n°|clé> · /permissions clear [tout]  — les actions interdites (deny) ne peuvent jamais être autorisées par une règle\n'));
      return true;
    }

    // ── MCP ──
    case '/mcp': { await mcpCommand(arg, env); return true; }

    // ── commandes en arrière-plan ──
    case '/jobs': {
      const { listJobs, getJob, stopJob } = await import('./tools.js');
      const m = arg.match(/^(stop|logs?)\s*(\S*)\s*(\d*)$/i);
      if (m && /^stop$/i.test(m[1])) {
        const ids = m[2] === 'all' || !m[2] ? listJobs().filter(j => j.status === 'running').map(j => j.id) : [parseInt(m[2])];
        println(ids.length && ids.every(i => stopJob(i)) ? c.green(`  ✓ arrêté (${ids.join(', ')})`) : c.red('  aucun job en cours à arrêter'));
        return true;
      }
      if (m) {
        const j = getJob(parseInt(m[2]));
        if (!j) { println(c.red('  job introuvable')); return true; }
        const lines = j.out.replace(/\r/g, '').split('\n'); const n = parseInt(m[3]) || 30;
        println(); lines.slice(-n).forEach(l => println('  ' + c.dim(ui.clip(l, ui.cols() - 4)))); println(); return true;
      }
      const jobs = listJobs();
      if (!jobs.length) { println(c.dim('  aucun job (lance-en un avec !& <commande>)')); return true; }
      println();
      jobs.forEach(j => {
        const st = j.status === 'running' ? c.green('● en cours') : j.status === 'stopped' ? c.yellow('■ arrêté') : (j.code === 0 ? c.dim('✓ terminé') : c.red(`✗ code ${j.code | 0}`));
        println(`  ${c.accent(String(j.id))}  ${st}  ${c.dim(Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000) + 's')}  ${clip(j.command.replace(/\s+/g, ' '), 60)}`);
      });
      println(c.dim('\n  /jobs logs <id> [n] · /jobs stop <id|all>\n'));
      return true;
    }
    case '/feedback': {
      cfg.feedback = arg ? /^(on|1|oui|true)$/i.test(arg) : !(cfg.feedback !== false); saveCfg();
      println(c.dim(`  → renvoi des résultats d'exécution au modèle : ${cfg.feedback ? 'ON' : 'OFF (affichés ici seulement)'}`)); return true;
    }

    // ── web : le résultat est joint au prochain message (le contenu web reste une donnée) ──
    case '/search': {
      if (!arg) { println(c.red('  usage: /search <requête>')); return true; }
      await withAbort(async signal => {
        ui.spinner.start('recherche web…');
        const r = await TOOLS.web_search.run({ query: arg, max_results: 6 }, { cwd, signal }); ui.spinner.stop();
        println(r.ok ? '\n' + r.output.split('\n').map(l => '  ' + l).join('\n') + '\n' : c.red('  ' + r.output));
        if (r.ok) { S.pendingContext.push(`[Résultats de recherche web, à utiliser comme données]\n${r.output}`); println(c.dim('  ↳ joint à ton prochain message')); }
      });
      return true;
    }
    case '/fetch': {
      if (!arg) { println(c.red('  usage: /fetch <url>')); return true; }
      await withAbort(async signal => {
        ui.spinner.start('lecture de la page…');
        const r = await TOOLS.fetch_url.run({ url: arg.split(/\s+/)[0], max_chars: 15000 }, { cwd, signal }); ui.spinner.stop();
        if (!r.ok) return println(c.red('  ' + r.output));
        println(c.green('  ✓ ') + c.dim(r.display));
        S.pendingContext.push(`[Contenu de la page ${arg}, à utiliser comme donnée]\n${r.output}`); println(c.dim('  ↳ joint à ton prochain message'));
      });
      return true;
    }

    // ── historique du compte ──
    case '/history': {
      const list = await fetchChatsList(15);
      if (!list.length) { println(c.dim('  historique indisponible')); return true; }
      const n = parseInt(arg);
      if (n >= 1 && list[n - 1]) {
        const ch = list[n - 1];
        applySession({ chatId: ch.id, agentId: ch.agent?.id, cwd: S.cwd, title: ch.title, primed: true, ctxSent: false });
        println(c.green('  ✓ conversation reprise') + c.dim(` · ${ch.title} · ${ch.agent?.name || ''}`)); return true;
      }
      println();
      list.forEach((ch, i) => println(`  ${c.accent(String(i + 1).padStart(2))}  ${clip(ch.title || '(sans titre)', 42).padEnd(42)} ${c.dim((ch.agent?.name || '').padEnd(18))} ${c.dim(String(ch.createdAt || '').slice(0, 16).replace('T', ' '))}`));
      println(c.dim('\n  /history <n°> pour reprendre une conversation du compte\n'));
      return true;
    }
    default: return false;
  }
}
