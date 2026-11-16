// /team : des agents qui écrivent chacun leurs fichiers (à la suite dans la conversation courante, ou en parallèle dans des conversations réutilisées)
// puis le CLI exécute le résultat avec les mêmes garde-fous que d'habitude.
import fs from 'node:fs';
import { streamChat, fetchChat } from './api.js';
import { extractBlocks, panelBlocks } from './blocks.js';
import { runBlock, baseDir } from './agent.js';
import { resolveP } from './tools.js';
import { cfg } from './config.js';
import { contextPercent } from './account.js';
import { newSid, tag, createdToday, DAILY_LIMIT } from './chats.js';
import * as ui from './ui.js';
import { c, println } from './ui.js';

const FILE_RE = /^[\w.\/\\:-]+\.[A-Za-z0-9]{1,6}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Découpage fait par le CLI (aucun appel au modèle) : le modèle FS refuse de produire du JSON destiné à un programme.
//   /team demande | index.html: la structure | style.css: le style | script.js: le comportement   → un agent par segment
//   /team un site avec index.html, style.css et script.js                                          → un agent par fichier cité
//   /team un site en html, css et js                                                               → index.html / style.css / script.js
const ROLE = { html: 'la structure et le contenu de la page', css: 'la mise en forme (couleurs, mise en page, thème)', js: 'le comportement interactif', py: 'le script Python', md: 'la documentation' };
const roleOf = f => ROLE[f.split('.').pop().toLowerCase()] || 'son contenu';

export const MAX_AGENTS = 8;
const roundRobin = (items, k) => Array.from({ length: k }, (_, i) => items.filter((_, j) => j % k === i)).filter(g => g.length);

/** n = nombre d'agents voulu (facultatif) : les fichiers sont répartis entre eux ; jamais plus d'agents que de fichiers */
export function buildPlan(raw, { n = null } = {}) {
  const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
  const task = parts[0] || raw.trim();
  const want = n ? Math.min(MAX_AGENTS, Math.max(1, n)) : null;
  const seen = new Set();
  const explicit = parts.slice(1).map(s => {
    const m = s.match(/^([\w.\/\\:-]+\.[A-Za-z0-9]{1,6})\s*:\s*(.*)$/);
    if (!m || seen.has(m[1])) return null;
    seen.add(m[1]);
    return { titre: m[1].split(/[\\/]/).pop().slice(0, 24), files: [m[1]], consigne: m[2] || `écris ${m[1]} (${roleOf(m[1])})` };
  }).filter(Boolean).slice(0, MAX_AGENTS);

  let units, mode;                                          // unités de travail = un fichier chacune
  if (explicit.length) { units = explicit; mode = 'explicite'; }
  else {
    let files = [...new Set([...task.matchAll(/\b([\w-]+\.(?:html|css|js|mjs|ts|tsx|jsx|py|json|md|txt|lua|luau|cs|java|go|rs|php|sql))\b/gi)].map(m => m[1]))];
    if (files.length < 2) {
      const kw = [];
      if (/\bhtml\b/i.test(task)) kw.push('index.html');
      if (/\bcss\b/i.test(task)) kw.push('style.css');
      if (/\b(js|javascript)\b/i.test(task)) kw.push('script.js');
      if (kw.length >= 2) files = kw;
    }
    let webDefault = false;
    if (files.length < 2 && /\b(site|page web|landing|portfolio|webapp|application web)\b/i.test(task)) {   // « un site… » sans fichiers cités → trio classique
      files = ['index.html', 'style.css', 'script.js']; webDefault = true;
    }
    if (files.length < 2) {
      const note = want && want > 1 ? `-n ${want} ignoré : la demande ne cite qu'un fichier (cite plusieurs fichiers pour répartir, ex. « avec index.html, style.css et script.js »)` : '';
      return { task, mode: 'un seul agent', note, plan: [{ titre: 'agent', files: [], consigne: task }] };
    }
    units = files.slice(0, 24).map(f => ({ titre: f.slice(0, 24), files: [f], consigne: `écris ${f} (${roleOf(f)}) pour répondre à la demande` }));
    mode = webDefault ? 'site web : index.html, style.css, script.js' : 'automatique';
  }

  const k = Math.min(units.length, want ?? Math.min(units.length, 4));
  let note = want && want > units.length ? `-n ${want} réduit à ${units.length} : il n'y a que ${units.length} fichier${units.length > 1 ? 's' : ''} à répartir (pour plus d'agents, cite plus de fichiers : about.html, contact.html…)` : '';
  if (k >= units.length) return { task, plan: units, mode, note };
  const plan = roundRobin(units, k).map(g => ({                                // plusieurs fichiers par agent
    titre: g.length > 1 ? `${g[0].titre}+${g.length - 1}` : g[0].titre,
    files: g.flatMap(u => u.files),
    consigne: g.map(u => u.consigne).join(' ; '),
  }));
  return { task, plan, mode, note };
}

function workerPrompt(task, W, plan, dir, { same = false, reused = false } = {}) {
  const all = plan.flatMap(p => p.files);
  return (reused && !same ? `[Nouvelle tâche, indépendante des précédentes de cette conversation]\n` : '') +
    `Agent ${W.titre} — tu fais partie d'une équipe qui construit : ${task}\n` +
    (all.length ? `Fichiers de l'ensemble (garde des noms, ids, classes et liens cohérents avec eux) : ${all.join(', ')}.\n` : '') +
    (same ? `Les fichiers déjà écrits par les agents précédents figurent plus haut dans cette conversation : reste cohérent avec eux.\n` : '') +
    `Ta part : ${W.consigne}\n` +
    (W.files.length ? `Écris uniquement tes fichiers : ${W.files.join(', ')}. ` : '') +
    `Pour chaque fichier, un bloc de code dont la ligne d'ouverture donne le langage et le nom du fichier (par exemple \`\`\`html index.html) avec le contenu final complet — pas un script qui le génère. Très peu de texte autour.\n` +
    `Dossier cible : ${dir}`;
}

// ── événements pour la vue « Agents » du panneau VS Code (sans sink à événements : rien n'est émis, le terminal ne change pas) ──
//  teamStart {team, task, mode, model, count, parallel, agents:[{id, name, task, files}]}
//  agentStart {team, id, name, task, files, model, mode, slot} · agentUpdate {team, id, status, chars?, tokens?, durationMs?}
//  agentDone {team, id, ok, summary, output, files, tokens?, durationMs, aborted?} · teamDone {team, count, durationMs, ok, aborted?}
//  status : 'running' | 'done' | 'error'  (en attente = pas encore d'agentStart)
export const OUTPUT_CAP = 20_000;
let teamSeq = 0;
const capOut = s => { s = String(s || ''); return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + '\n… (sortie tronquée)' : s; };
/** tokens d'une réponse (tokenUsage de France Student), ou null s'ils ne sont pas connus */
export function tokensOf(u) {
  if (!u) return null;
  const t = Number(u.totalTokenCount) || (Number(u.promptTokenCount) || 0) + (Number(u.candidatesTokenCount) || 0);
  return t > 0 ? t : null;
}
function summaryOf(W) {
  if (W.status === 'ok') { const n = W.blocks.length; return `${n} fichier${n > 1 ? 's' : ''} : ${W.blocks.map(b => b.name).join(', ')}`; }
  if (W.status === 'sans fichier') return 'le modèle n\'a pas écrit de fichier';
  return W.error || 'échec';
}

/** Un agent = un message envoyé dans une conversation (la courante, ou une conversation réutilisable « w0, w1… ») */
async function runWorker(W, ctx) {
  const t0 = Date.now();
  W.status = 'en cours'; W.text = '';
  ctx.ev('agentStart', { id: W.id, name: W.titre, task: W.consigne, files: W.files, model: ctx.modelLabel, mode: ctx.sameChat ? 'same' : 'pool', slot: ctx.sameChat ? 'main' : W.slot });
  let lastUp = 0;
  try {
    const { S, stream, getChat } = ctx;
    let chatId = ctx.sameChat ? S.chatId : (S.slots[W.slot] || null);
    const fresh = !chatId;
    let content = W.prompt(!fresh);
    if (fresh && cfg.tagChats !== false) content = tag(S.sid, ctx.sameChat ? '' : W.slot) + content;      // titre FS « [7f3a·w0] Agent … »
    const res = await stream({
      agentId: ctx.workerId, chatId, content, webSearch: false, signal: ctx.signal,
      register: { sid: S.sid, role: ctx.sameChat ? 'main' : W.slot },
      onChat: id => { if (!chatId) { chatId = id; if (ctx.sameChat) S.chatId = id; else S.slots[W.slot] = id; } },
      onText: d => {
        W.chars += d.length; if (W.text.length < OUTPUT_CAP + 1) W.text += d; ctx.tick();
        const now = Date.now();
        if (now - lastUp >= 500) { lastUp = now; ctx.ev('agentUpdate', { id: W.id, status: 'running', chars: W.chars, durationMs: now - t0 }); }
      },
    });
    W.tokens = tokensOf(res.usage);
    let blocks = extractBlocks(res.text).filter(b => b.action === 'write');
    if (!blocks.length && chatId) {                          // code parti dans le « panneau » serveur
      for (let k = 0; k < 2 && !blocks.length; k++) {
        const cd = await getChat(chatId);
        const last = [...(cd?.chatMessages || [])].reverse().find(m => m.role === 'assistant');
        blocks = panelBlocks(last).filter(b => b.action === 'write');
        if (!blocks.length) await sleep(700);
      }
    }
    W.blocks = blocks; W.chatId = chatId; W.text = res.text;
    W.status = blocks.length ? 'ok' : 'sans fichier';
    if (fresh) ctx.created++;
  } catch (e) {
    if (e.name === 'AbortError') {
      W.status = 'annulé';
      const durationMs = Date.now() - t0;
      ctx.ev('agentUpdate', { id: W.id, status: 'error', durationMs });
      ctx.ev('agentDone', { id: W.id, ok: false, summary: 'interrompu', output: capOut(W.text), files: [], durationMs, aborted: true });
      throw e;
    }
    W.status = 'échec'; W.error = e.message; if (e.code === 'DAILY_CHAT_LIMIT') ctx.limitHit = e;
  }
  const durationMs = Date.now() - t0;
  W.secs = durationMs / 1000;
  const ok = W.status === 'ok', tok = W.tokens != null ? { tokens: W.tokens } : {};
  ctx.ev('agentUpdate', { id: W.id, status: ok ? 'done' : 'error', chars: W.chars, durationMs, ...tok });
  ctx.ev('agentDone', { id: W.id, ok, summary: summaryOf(W), output: capOut(W.text), files: W.blocks.map(b => b.name), durationMs, ...tok });
  ctx.tick(true);
}

/**
 * Exécute l'équipe : répartition → agents → écriture (avec garde-fous) → relecture facultative.
 *  mode 'same' (défaut) : les agents travaillent À LA SUITE dans la conversation courante → une seule conversation, aucune création.
 *  mode 'pool'          : jusqu'à `maxParallel` agents EN PARALLÈLE, chacun dans sa propre conversation, réutilisée d'une équipe à l'autre.
 */
export async function runTeam(env, rawTask, { review = false, agents = null, mode: modeOpt = null } = {}) {
  const { S, modelName, ask, withAbort } = env;
  const stream = env.stream || streamChat, getChat = env.fetchChat || fetchChat, ctxPct = env.contextPercent || contextPercent;
  const { task, plan, mode, note } = buildPlan(rawTask, { n: agents });
  const teamMode = modeOpt || (cfg.teamMode === 'pool' ? 'pool' : 'same');
  const sameChat = teamMode === 'same';
  const parallel = sameChat ? 1 : Math.min(6, Math.max(1, cfg.maxParallel || 3));
  S.slots ||= {}; S.sid ||= newSid();
  await withAbort(async signal => {
    const workerId = cfg.workerModel != null ? cfg.workerModel : S.agentId;
    const dir = baseDir(S);
    const T0 = Date.now();
    const team = `t${(++teamSeq).toString(36)}${T0.toString(36).slice(-4)}`;
    const ev = (type, data) => ui.emit(type, { team, ...data });
    const quiet = !!env.agentMap && ui.hasEvents();          // panneau avec la vue « Agents » : le bloc remplace la liste en texte
    const modelLabel = modelName(workerId);
    if (!quiet) {
      ui.toolHeader('équipe', task.slice(0, 80));
      println(c.dim(`    ${plan.length} agent${plan.length > 1 ? 's' : ''} (${mode}) · modèle : ${modelLabel} · ` +
        (sameChat ? 'à la suite, dans la conversation courante' : `${Math.min(parallel, plan.length)} en parallèle, conversations réutilisées`)));
    }
    if (note) println(c.yellow('    ⚠ ' + note));
    if (!sameChat && parallel > 4) println(c.dim('    (plus de 4 requêtes simultanées : risque d\'erreurs 429 « trop de requêtes »)'));
    if (plan.length === 1 && !plan[0].files.length) println(c.dim('    un seul agent (précise des fichiers : « … avec index.html, style.css et script.js » ou « | fichier: consigne »)'));
    else if (!quiet) plan.forEach(p => println(`    ${c.accent('▸')} ${c.bold(p.titre)} ${c.dim('→ ' + p.files.join(', '))}`));

    const workers = plan.map((p, i) => ({ ...p, id: `${team}-${i + 1}`, chars: 0, status: 'attente', blocks: [], secs: 0, slot: '', prompt: null, text: '', tokens: null }));
    ev('teamStart', { task, mode: teamMode, plan: mode, model: modelLabel, count: workers.length, parallel: Math.min(parallel, workers.length),
      agents: workers.map(W => ({ id: W.id, name: W.titre, task: W.consigne, files: W.files })) });
    let doneSent = false;
    const teamDone = (extra = {}) => {
      if (doneSent) return; doneSent = true;
      ev('teamDone', { count: workers.length, durationMs: Date.now() - T0, ok: workers.filter(W => W.status === 'ok').length, ...extra });
    };

    // conversations réutilisées trop pleines → on repart d'une neuve (une seule création, étiquetée)
    if (!sameChat) {
      for (let j = 0; j < Math.min(parallel, plan.length); j++) {
        const id = S.slots[`w${j}`];
        if (!id) continue;
        const pct = await ctxPct(id).catch(() => null);
        if (typeof pct === 'number' && pct >= 70) { delete S.slots[`w${j}`]; println(c.dim(`    conversation w${j} presque pleine (${Math.round(pct)} %) → une neuve sera ouverte`)); }
      }
    }

    workers.forEach(W => { W.prompt = reused => workerPrompt(task, W, plan, dir, { same: sameChat, reused }); });
    let lastDraw = 0;
    const ctx = {
      S, stream, getChat, workerId, signal, sameChat, created: 0, limitHit: null, ev, modelLabel,
      tick: (force) => {
        const now = Date.now();
        if (!force && now - lastDraw < 400) return;
        lastDraw = now;
        const bits = workers.map(W => `${W.titre} ${W.status === 'ok' ? '✓' : W.status === 'en cours' ? (W.chars > 999 ? (W.chars / 1000).toFixed(1) + 'k' : W.chars || '…') : W.status === 'attente' ? '·' : '✗'}`);
        if (ui.spinner.active) ui.spinner.label('agents : ' + bits.join(' · '));
      },
    };
    ui.spinner.start('agents…');
    const K = Math.min(parallel, workers.length);
    const work = Array.from({ length: K }, (_, j) => workers.filter((_, i) => i % K === j));   // répartition fixe : la voie j garde sa conversation « wj »
    const lane = async (j) => {
      for (const W of work[j]) {
        if (signal.aborted) return;
        W.slot = `w${j}`;
        await runWorker(W, ctx);
      }
    };
    const lanes = [];
    try {
      for (let j = 0; j < K; j++) { lanes.push(lane(j)); await sleep(350); }   // départs décalés (limites de débit)
      await Promise.all(lanes);
    } catch (e) { teamDone({ aborted: true }); throw e; }
    ui.spinner.stop();
    if (signal.aborted) { teamDone({ aborted: true }); throw Object.assign(new Error('annulé'), { name: 'AbortError' }); }
    teamDone();

    if (!quiet) println();
    for (const W of quiet ? [] : workers) {                  // bilan en texte (le bloc « Agents » du panneau le montre déjà)
      const mark = W.status === 'ok' ? c.green('✓') : c.red('✗');
      println(`    ${mark} ${c.bold(W.titre.padEnd(14))} ${c.dim(`${W.secs.toFixed(1)}s · ${W.blocks.length} fichier${W.blocks.length > 1 ? 's' : ''}${W.error ? ' · ' + W.error : W.status === 'sans fichier' ? ' · le modèle n\'a pas écrit de fichier' : ''}`)}`);
    }
    if (ctx.limitHit) println(c.yellow('\n    ⚠ ' + ctx.limitHit.message));
    if (ctx.created) println(c.dim(`    ${ctx.created} nouvelle${ctx.created > 1 ? 's' : ''} conversation${ctx.created > 1 ? 's' : ''} créée${ctx.created > 1 ? 's' : ''} (aujourd'hui : ${createdToday()}/${DAILY_LIMIT} via le CLI)`));

    // fichiers : un nom = une seule version (le premier agent qui l'écrit)
    const files = new Map();
    for (const W of workers) for (const b of W.blocks) if (!files.has(b.name)) files.set(b.name, b);
    if (!files.size) { println(c.yellow('\n    aucun fichier produit par l\'équipe')); return; }

    if (!cfg.autoRun) {
      S.blocks = [...files.values()];
      println(c.dim(`\n    ${files.size} fichier(s) prêts — /run all pour les écrire`)); return;
    }
    const trusted = new Set();
    const io = { signal, ask, auto: true, trusted };
    for (const b of files.values()) {
      if (signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
      const r = await runBlock(S, b, io);
      if (r?.ok) trusted.add(resolveP(b.name, dir));
    }
    S.pendingResults = [];                                   // les résultats ne sont pas renvoyés au chat principal
    if (!sameChat) S.notes.push(`Via /team, ces fichiers ont été créés dans ${dir} : ${[...files.keys()].join(', ')}.`);

    // relecture facultative (dans la conversation courante en mode « same », sinon dans la conversation w0)
    if (review && trusted.size) {
      ui.spinner.start('relecture…');
      let body = '';
      for (const p of trusted) { try { body += `\n### ${p}\n\`\`\`\n${fs.readFileSync(p, 'utf8').slice(0, 14000)}\n\`\`\`\n`; } catch {} }
      let rv = '';
      try {
        const chatId = sameChat ? S.chatId : (S.slots.w0 || null);
        const prompt = `Relis ces fichiers qui forment un seul projet (${task}). Vérifie la cohérence : ids, classes, chemins, noms de fonctions, liens entre fichiers. Si tout est cohérent, réponds exactement : OK\nSinon, renvoie uniquement les fichiers à corriger, complets, chacun dans un bloc de code dont la ligne d'ouverture donne le langage et le nom du fichier (par exemple \`\`\`html index.html).\n${body}`;
        const r = await stream({
          agentId: S.agentId, chatId, webSearch: false, signal, register: { sid: S.sid, role: sameChat ? 'main' : 'w0' },
          content: (!chatId && cfg.tagChats !== false ? tag(S.sid, sameChat ? '' : 'w0') : '') + prompt,
          onChat: id => { if (!chatId) { if (sameChat) S.chatId = id; else S.slots.w0 = id; } },
        });
        rv = r.text;
      } catch (e) { if (e.name === 'AbortError') throw e; }
      ui.spinner.stop();
      if (/^\s*OK\b/i.test(rv)) println(c.green('\n    ✓ ') + c.dim('relecture : cohérent'));
      else {
        const fixes = extractBlocks(rv).filter(b => b.action === 'write');
        if (!fixes.length) println(c.dim('\n    relecture : rien à corriger'));
        else { println(c.dim(`\n    relecture : ${fixes.length} fichier(s) corrigé(s)`)); for (const b of fixes) await runBlock(S, b, io); S.pendingResults = []; }
      }
    }
    println();
  });
}
