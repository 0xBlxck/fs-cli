// Exécution des outils (permissions, confirmations) et mode « chat » de secours (le CLI exécute le code affiché)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { streamChat, fetchChat } from './api.js';
import { contextPercent } from './account.js';
import { getMcp } from './mcp-runtime.js';
import { newSid, tag } from './chats.js';
import { runNative } from './native.js';
import { judgeCommand, judgeCode, decide, addRulesForJudgement, sensitivePathReason, scanSecrets } from './permissions.js';
import { extractBlocks, panelBlocks, pickAutoBlocks } from './blocks.js';
import { TOOLS, normalizeArgs, riskInfo, resolveP, makeTmp, dropTmp } from './tools.js';
import * as ui from './ui.js';
import { c } from './ui.js';
import { isFolderTrusted, trustFolder, isBroadFolder } from './trust.js';
import { isSkillPath } from './discover.js';

// ── Un échange avec le modèle (affichage en streaming) ────────────────────────
async function oneStream(S, content, signal) {
  const md = new ui.MdStream({
    collapse: !cfg.showCode && cfg.mode !== 'plan',
    onCode: ({ lang, name, lines }) => {
      const label = `rédaction de ${name || lang || 'code'} · ${lines} ligne${lines > 1 ? 's' : ''}`;
      if (ui.spinner.active) ui.spinner.label(label); else ui.spinner.start(label);
    },
  });
  let thinkBuf = '', visible = '';
  ui.spinner.start('réflexion…');
  try {
    const res = await streamChat({
      agentId: S.agentId, chatId: S.chatId, content, files: S.pendingFileIds, webSearch: cfg.webSearch, signal, register: { sid: S.sid, role: 'main' },
      onChat: id => { if (!S.chatId) S.chatId = id; },
      onReasoning: d => {
        if (!cfg.showThinking) return;
        thinkBuf += d;
        let i;
        while ((i = thinkBuf.indexOf('\n')) >= 0) { ui.println(c.dim(c.italic('  ✻ ' + thinkBuf.slice(0, i)))); thinkBuf = thinkBuf.slice(i + 1); }
      },
      onText: d => { visible += d; md.push(d); },
    });
    if (thinkBuf.trim() && cfg.showThinking) ui.println(c.dim(c.italic('  ✻ ' + thinkBuf)));
    md.finish();
    return { visible, usage: res.usage };
  } finally {
    ui.spinner.stop();
  }
}

// ── Permissions ───────────────────────────────────────────────────────────────
// Menu à flèches (interface plein écran) ; absent en mode readline → questions textuelles
let selectHandler = null;
export function setSelectHandler(fn) { selectHandler = fn; }

/** Chemin réel (liens symboliques et jonctions résolus) ; pour un chemin pas encore créé, on résout son plus proche ancêtre existant. */
function realish(p) {
  let cur = path.resolve(p); const tail = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch {}
    const up = path.dirname(cur); if (up === cur) break;
    tail.push(path.basename(cur)); cur = up;
  }
  return path.resolve(p);
}

/** Détail d'une confirmation :séquences de contrôle retirées, lignes longues RETOURNÉES (jamais coupées en silence), et le reste annoncé. */
function fitDetail(detail, maxRows = 8) {
  const W = Math.max(30, (ui.cols?.() || 80) - 10);
  const rows = [];
  for (const l of ui.sanitize(detail || '').replace(/\r/g, '').split('\n')) {
    if (!l.trim()) continue;
    for (let i = 0; i < l.length; i += W) rows.push(l.slice(i, i + W));
  }
  if (rows.length <= maxRows) return rows.join('\n');
  const hidden = rows.slice(maxRows - 1);
  return rows.slice(0, maxRows - 1).join('\n') + `\n… +${hidden.length} ligne(s) masquée(s) (${hidden.join('').length} caractères) — vérifie la commande complète avant d'accepter`;
}

export async function confirm(ask, { title, detail, danger, allowAlways = false, trustDir = null, alwaysLabel = null, yesLabel = null, noAlways = false }) {
  detail = fitDetail(detail);
  title = ui.sanitize(title);
  const TRUST = trustDir ? `Oui, et faire confiance à ce dossier (${ui.shortPath ? ui.shortPath(trustDir, 40) : trustDir})` : null;
  if (selectHandler) {
    const alwaysOk = !noAlways && (!danger || allowAlways);
    const options = [yesLabel || 'Oui'];
    if (TRUST) options.push(TRUST);
    else if (alwaysOk) options.push(alwaysLabel ? `Oui, ${alwaysLabel}` : danger ? 'Oui, et ne plus demander (règle enregistrée)' : 'Oui, et ne plus demander pendant cette session');
    options.push('Non');
    const plainTitle = (danger ? '⚠ ' : '') + title.replace(/\x1b\[[0-9;]*m/g, '');
    const idx = await selectHandler({ title: plainTitle, detail: detail || '', options, defaultIndex: TRUST ? 1 : danger ? options.length - 1 : 0 });
    if (idx === null || !options[idx]) return { allow: false };      // Échap (ou choix invalide) = refuser ; Ctrl+C interrompt le tour (signal) en parallèle
    if (options[idx] === 'Non') {
      const why = await ask('raison / alternative pour le modèle (Entrée = rien)');
      return { allow: false, feedback: (why || '').trim() };
    }
    if (options[idx] === TRUST) return { allow: true, trust: true };
    return options[idx].startsWith('Oui, ') ? { allow: true, always: true } : { allow: true };
  }
  if (TRUST) {                                                        // mode texte
    ui.println(`  ${c.yellow('?')} ${c.bold(title)}`);
    if (detail) for (const l of detail.split('\n')) ui.println(`    ${c.dim(l)}`);
    const a = await ask(`  ${c.accent('›')} Autoriser ? ${c.dim('[o]ui / [d]ossier de confiance / [N]on')} `);
    if (a === null) return { allow: false, aborted: true };
    const s = a.trim().toLowerCase();
    if (/^(d|dossier|c|confiance)$/.test(s)) return { allow: true, trust: true };
    if (/^(o|oui|y|yes)$/.test(s)) return { allow: true };
    return { allow: false };
  }
  ui.println(`  ${danger ? c.red('⚠') : c.yellow('?')} ${c.bold(title)}`);
  if (detail) for (const l of detail.split('\n')) ui.println(`    ${c.dim(l)}`);
  const alwaysOk = !danger || allowAlways;
  const hint = danger ? `[o]ui / [N]on${alwaysOk ? ' / [t]oujours (règle enregistrée)' : ''}` : '[O]ui / [n]on / [t]oujours';
  for (;;) {
    const ans = await ask(`  ${c.accent('›')} Autoriser ? ${c.dim(hint)} `);
    if (ans === null) return { allow: false, aborted: true };
    const a = ans.trim().toLowerCase();
    if (a === '' ) { if (danger) return { allow: false }; return { allow: true }; }
    if (/^(o|oui|y|yes)$/.test(a)) return { allow: true };
    if (/^(t|toujours|a|always)$/.test(a) && alwaysOk) return { allow: true, always: true };
    if (/^(n|non|no)$/.test(a)) {
      const why = await ask(`  ${c.dim('  raison / alternative pour le modèle (Entrée = rien) :')} `);
      return { allow: false, feedback: (why || '').trim() };
    }
  }
}

function needsConfirm(risk, S) {
  if (risk.danger || risk.protectedPath || risk.secrets) return true;
  if (risk.kind === 'read' || risk.kind === 'net') return false;
  if (cfg.mode === 'auto') return false;
  return !S.allow[risk.kind];
}

// ── Exécution d'un appel ──────────────────────────────────────────────────────
export async function execCall(S, call, { signal, ask, root = null }) {
  const tool = TOOLS[call.name];
  if (!tool) {
    ui.toolHeader(call.name, '(outil inconnu)');
    ui.toolBody(`Outil inconnu`, { error: true });
    return { name: call.name, ok: false, output: `Outil inconnu: "${call.name}". Outils disponibles: ${Object.keys(TOOLS).join(', ')}.` };
  }
  const { args, missing } = normalizeArgs(tool, call.args);
  const ctx = { cwd: root || S.cwd, signal, undo: S.undo };      // root = racine du workspace (moteur natif)
  if (missing.length) {
    ui.toolHeader(call.name, '');
    ui.toolBody(`paramètre manquant: ${missing.join(', ')}`, { error: true });
    return { name: call.name, ok: false, output: `Paramètre(s) manquant(s) pour ${call.name}: ${missing.join(', ')}. Format attendu: <fs:param name="${missing[0]}">…</fs:param>` };
  }

  ui.toolHeader(call.name, tool.summary?.(args, ctx) || '');

  const risk = riskInfo(tool, args, ctx);

  // politique de sécurité : analyse de la commande / du code, règles « toujours autoriser », secrets, chemins sensibles
  const judgement = call.judge || judgeFor(call.name, args, S.cwd);
  if (judgement) {
    risk.danger = null;                                   // remplace les anciennes regex
    const d = decide(judgement, S.cwd);
    if (d.action === 'refuse') {
      ui.toolNote(`refusé par la politique de sécurité : ${d.reason}`, 'red');
      return { name: call.name, ok: false, output: `Commande REFUSÉE par la politique de sécurité (${d.reason}). Ne la relance pas telle quelle : propose une alternative sûre ou explique à l'utilisateur ce qu'il peut faire lui-même.` };
    }
    if (d.action === 'confirm') { risk.danger = d.reason; risk.judgement = judgement; }
  }
  if (['write_file', 'edit_file', 'read_file'].includes(call.name) && args.path) {
    const p0 = resolveP(args.path, ctx.cwd);
    const sp = sensitivePathReason(p0) || sensitivePathReason(realish(p0));   // aussi via un lien symbolique
    if (sp) risk.protectedPath = risk.protectedPath || sp;
  }
  if (root && args.path && ['write_file', 'edit_file', 'read_file', 'list_dir', 'grep', 'glob'].includes(call.name)) {   // chemins limités au workspace : le reste demande confirmation
    const rp = resolveP(args.path, root);
    const rel = path.relative(realish(root), realish(rp)), rel0 = path.relative(root, rp);   // symlink / jonction qui sort du workspace = hors workspace
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel0.startsWith('..') || path.isAbsolute(rel0)) {
      // dossier du fichier (ou le dossier lui-même pour list_dir / grep / glob)
      let dir = rp; try { if (!fs.statSync(rp).isDirectory()) dir = path.dirname(rp); } catch { dir = ['list_dir', 'grep', 'glob'].includes(call.name) ? rp : path.dirname(rp); }
      const skillRead = ['read_file', 'list_dir', 'grep', 'glob'].includes(call.name) && isSkillPath(rp, S.cwd);   // skills du PC : lecture libre
      if (!skillRead && !isFolderTrusted(dir) && !risk.protectedPath) { risk.protectedPath = `hors du dossier de travail : ${rp}`; risk.outsideDir = dir; }
    }
  }
  const secrets = call.name === 'write_file' ? scanSecrets(args.content || '') : call.name === 'edit_file' ? scanSecrets(args.new_string || '') : [];
  if (secrets.length) risk.secrets = secrets;

  if (needsConfirm(risk, S)) {
    const danger = !!(risk.danger || risk.protectedPath || risk.secrets);
    const title = risk.secrets ? `Secret détecté dans le contenu (${[...new Set(risk.secrets.map(s => s.name))].join(', ')}) — écrire quand même ?`
      : risk.danger ? `Action sensible : ${risk.danger}`
      : risk.protectedPath ? `Chemin sensible : ${risk.protectedPath}`
      : `${call.name} demande ton accord`;
    const detail = risk.secrets ? risk.secrets.slice(0, 5).map(s => `${s.name} : ${s.sample}`).join('\n') : tool.preview?.(args, ctx);
    // seul souci = dossier hors du dossier de travail → on propose de faire confiance à ce dossier (plus de question ensuite, même en auto)
    const trustDir = risk.outsideDir && !risk.danger && !risk.secrets && !isBroadFolder(risk.outsideDir) ? risk.outsideDir : null;
    const r = await confirm(ask, { title, detail, danger, allowAlways: !!risk.judgement && !risk.protectedPath && !risk.secrets, trustDir });
    if (r.aborted || signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
    if (!r.allow) {
      ui.toolNote('refusé', 'yellow');
      return { name: call.name, ok: false, output: `L'utilisateur a REFUSÉ cette action.${r.feedback ? ' Il précise : ' + r.feedback : ' Propose une alternative ou demande-lui.'}` };
    }
    if (r.trust && trustDir) { trustFolder(trustDir); ui.toolNote(`dossier approuvé : ${trustDir} (plus de question pour ce dossier)`, 'dim'); }
    else if (r.always && risk.judgement) { addRulesForJudgement(risk.judgement, S.cwd, 'projet'); ui.toolNote('règle enregistrée pour ce dossier (/permissions)', 'dim'); }
    else if (r.always) S.allow[risk.kind] = true;
  }

  ui.spinner.start(call.name === 'shell' || call.name === 'python' ? 'exécution…' : `${call.name}…`);
  let res;
  try { res = await tool.run(args, ctx); }
  catch (e) { res = { ok: false, output: `Erreur interne de l'outil: ${e.message}`, display: e.message }; }
  ui.spinner.stop();
  if (signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });

  // affichage du résultat
  if (res.diff) { ui.diffView(res.diff[0], res.diff[1]); ui.toolNote(res.display, 'dim'); }
  else if (res.silent) { if (res.display) ui.toolNote(res.display, res.ok ? 'dim' : 'red'); }
  else if (!res.ok) ui.toolBody(res.display || res.output, { error: true, max: 4 });
  else if (['list_dir', 'glob', 'grep'].includes(call.name)) {
    ui.toolNote(res.display, 'dim');
    ui.toolBody(res.output.split('\n').slice(call.name === 'list_dir' ? 1 : 0, 9).join('\n'), { max: 8 });
  } else ui.toolNote(res.display || 'ok', res.kind === 'warn' ? 'yellow' : res.kind === 'ok' ? 'green' : 'dim');

  return { name: call.name, ok: res.ok, output: res.output };
}

// ── Tour complet : message utilisateur → (outils)* → réponse finale ───────────
const judgeFor = (name, args, cwd) =>
  name === 'shell' ? judgeCommand(args.command || '', { cwd }) : name === 'python' ? judgeCode(args.code || '', 'python') : null;

/** Appel d'un outil MCP demandé par un bloc ```mcp serveur.outil {json} */
async function runMcpBlock(S, b, io) {
  const { server, tool, args } = b.mcp;
  ui.toolHeader(`mcp ${server}.${tool}`, JSON.stringify(args).slice(0, 100));
  if (cfg.mode === 'ask' && !S.allow.mcp) {
    const r = await confirm(io.ask, { title: `Appeler l'outil MCP ${server}.${tool} ?`, detail: JSON.stringify(args, null, 1), danger: false });
    if (r.aborted || io.signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
    if (!r.allow) { ui.toolNote('refusé', 'yellow'); S.pendingResults.push(`[mcp ${server}.${tool}] refusé par l'utilisateur`); return { ok: false, output: 'refusé' }; }
    if (r.always) S.allow.mcp = true;
  }
  ui.spinner.start(`mcp ${server}.${tool}…`);
  const res = await getMcp(S.cwd).callTool(server, tool, args, { signal: io.signal, timeoutMs: 120000 });
  ui.spinner.stop();
  if (io.signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
  const ok = res.ok && !res.isError;
  const text = res.text || res.error || '(aucune sortie)';
  if (ok) ui.toolBody(text, { max: 6 }); else ui.toolBody(text, { error: true, max: 4 });
  S.pendingResults.push(`[mcp ${server}.${tool}] ${ok ? '' : '(échec) '}${text.slice(0, 2500)}`);
  return { ok, output: text };
}

/** dossier où écrire les fichiers à nom relatif */
export const baseDir = S => S.targetDir || S.cwd;

const rel2 = (p, cwd) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };

/** Exécute un bloc de code affiché par le modèle (commande /run ou exécution auto) */
export async function runBlock(S, b, io) {
  if (b.action === 'mcp') return runMcpBlock(S, b, io);
  let call, tmp = null;
  if (b.action === 'write') {
    const target = resolveP(b.name, baseDir(S));                 // nom relatif → dossier cible cité dans la demande, sinon dossier courant
    if (io.auto && fs.existsSync(target) && !io.trusted?.has(target)) {   // jamais d'écrasement silencieux en exécution automatique
      ui.toolHeader('write_file', rel2(target, baseDir(S)));
      const r = await confirm(io.ask, { title: `Le fichier existe déjà — l'écraser ?`, detail: target, danger: true });
      if (r.aborted || io.signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
      if (!r.allow) { ui.toolNote('ignoré (fichier conservé)', 'yellow'); S.pendingResults.push(`[${b.name}] non écrit : l'utilisateur a gardé le fichier existant`); return { ok: true, output: 'ignoré' }; }
    }
    call = { name: 'write_file', args: { path: target, content: b.code } };
  }
  else if (b.action === 'python') call = { name: 'python', args: { code: b.code } };
  else if (b.action === 'node') {
    tmp = makeTmp(b.lang === 'mjs' ? 'script.mjs' : 'script.js', b.code);
    call = { name: 'shell', args: { command: `node "${tmp}"` }, judge: judgeCode(b.code, 'node') };   // le CODE est analysé, pas la ligne de lancement
  } else if (b.action === 'shell') call = { name: 'shell', args: { command: b.code } };
  try {
    const r = await execCall(S, call, io);
    S.pendingResults.push(`[${b.name || b.lang}] ${r.ok ? '' : '(échec) '}${r.output.slice(0, 1500)}`);
    return r;
  } finally { dropTmp(tmp); }
}

/**
 * Tour complet. Moteur natif (outils client officiels de FS) par défaut ; mode « chat » en secours :
 * le modèle écrit du code dans sa réponse et le CLI l'exécute (avec les mêmes garde-fous).
 */
export async function runAgent(S, userText, { signal, ask }) {
  if (cfg.engine === 'native' && !S.nativeOff) {                    // vrais appels d'outils (mode officiel « outils client » de FS)
    try { return await runNative(S, userText, { signal, ask }); }
    catch (e) {
      if (e.code !== 'NATIVE_UNSUPPORTED') throw e;
      S.nativeOff = true;
      ui.println(c.yellow('  ⚠ ' + e.message) + c.dim('  → ce tour passe en mode chat (le code affiché est exécuté)'));
    }
  }
  let content = userText;
  if (S.notes.length) { content = `[${S.notes.join(' ')}]\n${content}`; S.notes = []; }
  S.sid ||= newSid();
  if (!S.chatId && cfg.tagChats !== false) content = tag(S.sid) + content;       // titre FS « [7f3a] … » : retrouver les conversations du CLI

  const t0 = Date.now();
  let nTools = 0, tokensIn = 0, tokensOut = 0, steps = 0, lastFailed = false;
  const limit = Math.min(cfg.maxSteps, cfg.autoRounds || 6);

  for (; steps < limit; steps++) {
    const r = await oneStream(S, content, signal);
    const u = r.usage;
    if (u && typeof u === 'object') {
      for (const [k, v] of Object.entries(u)) {
        if (typeof v !== 'number') continue;
        if (/total|reasoning|cached/i.test(k)) continue;
        if (/prompt|input/i.test(k)) tokensIn += v; else if (/candidate|compl|output/i.test(k)) tokensOut += v;
      }
    }
    S.lastResponse = r.visible.trim() || S.lastResponse;

    S.blocks = extractBlocks(r.visible);
    if (S.chatId && /panneau|document|canvas|artefact|artifact|créé|cré[ée]e|prêt|généré|écrit/i.test(r.visible)) {
      // le code a pu partir dans le « panneau » serveur : on le récupère dans la conversation
      for (let k = 0; k < 2; k++) {
        const chatData = await fetchChat(S.chatId);
        const last = [...(chatData?.chatMessages || [])].reverse().find(m => m.role === 'assistant');
        const pb = panelBlocks(last);
        if (pb.length) { S.blocks.push(...pb); break; }
        if (last && last.content?.trim() === r.visible.trim()) break;   // message à jour, pas de panneau
        await new Promise(res => setTimeout(res, 800));
      }
    }
    // exécution automatique : 1er tour toujours ; tours suivants seulement pour réparer un échec
    const auto = cfg.autoRun && cfg.mode !== 'plan' && (steps === 0 || lastFailed) ? pickAutoBlocks(S.blocks) : [];
    if (auto.length) {
      ui.println('\n' + c.accent('  ⚡ ') + c.dim(`exécution automatique · ${auto.length} bloc${auto.length > 1 ? 's' : ''}`));
      lastFailed = false;
      for (const b of auto) {
        if (signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
        nTools++;
        const res = await runBlock(S, b, { signal, ask, auto: true });
        if (res && !res.ok) lastFailed = true;
      }
      if (S.pendingResults.length && cfg.feedback === false) { S.pendingResults = []; break; }   // résultats affichés ici seulement
      if (S.pendingResults.length) {
        content = `Résultat de l'exécution locale :\n${S.pendingResults.join('\n')}`;
        S.pendingResults = [];
        ui.println();
        continue;                                   // le modèle voit le résultat et conclut (ou corrige)
      }
      break;
    }
    if (S.blocks.length) ui.println('\n' + c.accent('  ▶ ') + c.dim(`${S.blocks.length} bloc${S.blocks.length > 1 ? 's' : ''} non exécuté${S.blocks.length > 1 ? 's' : ''} — /run pour voir · /run all · /run 1`));
    break;
  }

  const secsN = (Date.now() - t0) / 1000;
  const bits = [`${secsN.toFixed(1)}s`];
  if (nTools) bits.push(`${nTools} outil${nTools > 1 ? 's' : ''}`);
  if (tokensIn > 0 && tokensOut > 0) bits.push(`${fmtK(tokensIn)}↑ ${fmtK(tokensOut)}↓ tok`);
  if (tokensOut > 20 && secsN > 0.5) bits.push(`${Math.round(tokensOut / secsN)} tok/s`);
  S.tokens.in += tokensIn; S.tokens.out += tokensOut;
  S.stats ||= { turns: 0, requests: 0, tools: 0 }; S.stats.turns++; S.stats.requests += steps + 1; S.stats.tools += nTools;   // pour /usage (mode chat)
  let ctxBit = '';
  if (S.chatId) {                                   // pourcentage de contexte utilisé (compaction auto au seuil)
    S.ctxPercent = await contextPercent(S.chatId).catch(() => null);
    if (typeof S.ctxPercent === 'number') {
      const p = Math.round(S.ctxPercent);
      ctxBit = ' · ' + (p >= 80 ? c.red : p >= 60 ? c.yellow : c.dim)(`ctx ${p}%`);
    }
  }
  ui.println('\n' + c.dim(`  ✻ Terminé en ${bits.join(' · ')}`) + ctxBit);
  if (cfg.sound && secsN > 3) process.stdout.write('\x07');
  return { hitLimit: false };
}

const fmtK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
