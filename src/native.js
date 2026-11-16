// Moteur NATIF : vrais appels d'outils via le mode officiel « outils client » de France Student.
// FS déclare les outils au modèle, nous renvoie les appels dans completed.message.toolCalls, nous les exécutons ICI (avec nos garde-fous :
// politique de commandes, confirmations, secrets, chemins limités au workspace) et renvoyons les résultats avec toolResults.
// Documentation FS : « Outils client (mode avancé) », flag 2026_11_client_tools.
import fs from 'node:fs';
import path from 'node:path';
import { streamChat, CLIENT_TOOLS, uploadFile, lastMessageImages, downloadApiFile } from './api.js';
import { HOME_DIR } from './config.js';
import { takeQueuedImages } from './vision.js';
import { contextPercent } from './account.js';
import { cfg, saveCfg } from './config.js';
import { newSid, tag } from './chats.js';
import { execCall, baseDir } from './agent.js';
import { clipMiddle } from './tools.js';
import * as ui from './ui.js';
import { c } from './ui.js';

export const READ_TOOLS = CLIENT_TOOLS.slice(0, 3);
// Certains modèles de France Student refusent de servir d'agent à un outil externe (« ne peut pas servir de moteur à ton outil externe »,
// « colle ici le contenu »…). FS-CLI ne contourne pas ce refus : il l'explique et propose un modèle qui accepte les outils.
const TOOL_REFUSAL = /servir de moteur|outil externe|agent externe|(?:ne (?:peux|peut|pouvons) pas|impossible de) (?:piloter|contr[ôo]ler|utiliser) (?:FS-CLI|tes outils|les outils|ton (?:PC|ordinateur|disque))|ne (?:peux|peut|pouvons) pas (?:acc[ée]der|modifier|[ée]crire|lire|ex[ée]cuter|cr[ée]er|lancer|ouvrir)\b[^.]{0,60}\b(?:fichiers?|disque|dossier|commandes?|ordinateur|PC|machine)|(?:je )?n'ai pas (?:d'|l')?acc[èe]s (?:à|aux) (?:tes |ton |vos |votre |ce |tes )?(?:fichiers?|disque|dossier|syst[èe]me|ordinateur|PC|machine)|colle[rz]? (?:ici )?(?:le )?contenu/i;
export const looksLikeToolRefusal = text => TOOL_REFUSAL.test(String(text || ''));   // list_directory, read_file, search_files : seuls outils proposés en mode plan
const MAX_RESULT = 40000;     // limite FS par résultat (au-delà FS coupe et prévient le modèle)
const MAX_TOTAL = 120000;      // limite FS par envoi

/** appel FS → appel de nos outils (noms et arguments traduits) */
export function mapCall(name, a = {}) {
  switch (name) {
    case 'list_directory': return { name: 'list_dir', args: { path: a.path, depth: a.depth } };
    case 'read_file': {
      const start = a.start_line ? Number(a.start_line) : undefined, end = a.end_line ? Number(a.end_line) : undefined;
      return { name: 'read_file', args: { path: a.path, offset: start, limit: start && end && end >= start ? end - start + 1 : (end && !start ? end : undefined) } };
    }
    case 'search_files': return { name: 'grep', args: { pattern: a.query, path: a.path, glob: a.glob, context: 0 }, max: a.max_results };
    case 'edit_file': return { name: 'edit_file', args: { path: a.path, old_string: a.old_text, new_string: a.new_text, replace_all: a.replace_all } };
    case 'write_file': return { name: 'write_file', args: { path: a.path, content: a.content } };
    case 'run_command': return { name: 'shell', args: { command: a.command, cwd: a.cwd, timeout: a.timeout_seconds } };
    default: return null;
  }
}

const parseArgs = a => { if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } } return a || {}; };

async function execNative(S, call, io) {
  const callId = call.callId || call.call_id || call.id;
  const mapped = CLIENT_TOOLS.includes(call.name) ? mapCall(call.name, parseArgs(call.arguments)) : null;
  if (!mapped) return { callId, output: `Outil inconnu ou non pris en charge par le client : ${call.name}`, isError: true };
  if (cfg.mode === 'plan' && !READ_TOOLS.includes(call.name)) {
    return { callId, output: 'Mode plan (lecture seule) : aucune écriture ni commande. Propose un plan détaillé ; l\'utilisateur repassera en mode auto pour l\'appliquer.', isError: true };
  }
  const r = await execCall(S, { name: mapped.name, args: mapped.args }, io);
  let out = String(r.output ?? '');
  if (mapped.max && mapped.name === 'grep') out = out.split('\n').slice(0, Math.max(1, Number(mapped.max))).join('\n');
  if (!r.ok && /REFUSÉ|refusé par la politique/i.test(out)) out = out.includes('REFUSÉ') ? `Commande refusée par l'utilisateur. ${out.replace(/^.*?REFUSÉ cette action\.?/i, '').trim()}`.trim() : out;
  return { callId, output: clipMiddle(out, MAX_RESULT), isError: !r.ok };
}

/** Tour complet : message → (appels d'outils → résultats)* → réponse finale */
export async function runNative(S, userText, { signal, ask, stream = streamChat, ctxPct = contextPercent }) {
  let content = userText;
  if (S.notes.length) { content = `[${S.notes.join(' ')}]\n${content}`; S.notes = []; }
  S.sid ||= newSid();
  if (!S.chatId && cfg.tagChats !== false) content = tag(S.sid) + content;
  const root = baseDir(S);
  const t0 = Date.now();
  let results = null, resultFiles = [], nTools = 0, nReq = 0, tokensIn = 0, tokensOut = 0, steps = 0, hitLimit = false, visible = '';

  for (; steps < (cfg.maxSteps || 40); steps++) {
    if (signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
    const md = new ui.MdStream({ collapse: false });
    let thinkBuf = '';
    ui.spinner.start(results ? 'réflexion…' : 'réflexion…');
    let res;
    try {
      res = await stream({
        agentId: S.agentId, chatId: S.chatId, signal, webSearch: cfg.webSearch, register: { sid: S.sid, role: 'main' },
        clientTools: cfg.mode === 'plan' ? READ_TOOLS : CLIENT_TOOLS,...(results ? { toolResults: results, files: resultFiles } : { content, files: S.pendingFileIds }),   // images : avec le message, ou avec les résultats (captures d'outils)
        onChat: id => { if (!S.chatId) S.chatId = id; },
        onText: d => md.push(d),
        onReasoning: d => {
          ui.rememberThinking(d);                                       // gardée pour Ctrl+O
          if (!cfg.showThinking) return;
          thinkBuf += d; let i;
          while ((i = thinkBuf.indexOf('\n')) >= 0) { ui.println(c.dim(c.italic('  ✻ ' + thinkBuf.slice(0, i)))); thinkBuf = thinkBuf.slice(i + 1); }
        },
      });
    } finally { ui.spinner.stop(); }
    md.finish(); nReq++;
    const u = res.usage;
    let reqIn = 0;
    if (u && typeof u === 'object') for (const [k, v] of Object.entries(u)) {
      if (typeof v !== 'number' || /total|reasoning|cached/i.test(k)) continue;
      if (/prompt|input/i.test(k)) { tokensIn += v; reqIn += v; } else if (/candidate|compl|output/i.test(k)) tokensOut += v;
    }
    if (reqIn) S.lastPromptTokens = reqIn;                              // taille du contexte envoyé à cette requête (résumé auto au-delà du seuil)
    visible = res.text?.trim() || visible;
    if (res.sawImage && S.chatId) {                                     // image générée par France Student : enregistrée sur le PC et montrée
      const imgs = res.images?.length ? res.images : await lastMessageImages(S.chatId).catch(() => []);
      for (const im of imgs) {
        const file = path.join(HOME_DIR, 'images', `${new Date().toISOString().slice(0, 10)}-${String(im.id || Date.now()).slice(0, 8)}.${im.ext}`);
        try {
          if (!fs.existsSync(file)) await downloadApiFile(im.url, file);
          ui.image(file, im.prompt);
          S.notes.push(`Image générée et enregistrée sur le PC de l'utilisateur : ${file}. Pour l'utiliser dans le projet, copie-la dans le dossier voulu avec run_command.`);
        } catch (e) { ui.println(c.yellow(`  image générée, mais téléchargement impossible : ${e.message}`)); }
      }
    }
    const calls = res.toolCalls || [];
    if (!calls.length) break;

    // exécution des appels, dans l'ordre ; tous reçoivent une réponse (exigé par FS)
    results = [];
    let total = 0;
    for (const call of calls.slice(0, 32)) {
      if (signal.aborted) throw Object.assign(new Error('annulé'), { name: 'AbortError' });
      nTools++;
      let r = await execNative(S, call, { signal, ask, root });
      if (total + r.output.length > MAX_TOTAL) r = { ...r, output: r.output.slice(0, Math.max(500, MAX_TOTAL - total)) + '\n[… coupé : lis une plage plus étroite]' };
      total += r.output.length; results.push(r);
    }
    // captures renvoyées par les outils (navigateur, Blender…) : envoyées sur Files v2 et jointes à ces résultats → le modèle les VOIT
    resultFiles = [];
    for (const img of takeQueuedImages(4)) {
      try { resultFiles.push(await uploadFile(fs.readFileSync(img.file), path.basename(img.file), img.mime)); } catch {}
    }
    if (resultFiles.length) ui.toolNote(`📷 ${resultFiles.length} capture${resultFiles.length > 1 ? 's' : ''} transmise${resultFiles.length > 1 ? 's' : ''} au modèle`);
    if (steps === (cfg.maxSteps || 40) - 1) hitLimit = true;
  }
  if (visible) S.lastResponse = visible;
  if (nTools && cfg.toolRefusals?.[String(S.agentId)]) { const r = { ...cfg.toolRefusals }; delete r[String(S.agentId)]; cfg.toolRefusals = r; saveCfg(); }
  // Le modèle refuse de travailler pour FS-CLI (consigne de France Student : « pas de moteur pour un agent externe »).
  // Ce refus est respecté : pas de relance, pas de reformulation pour le contourner. On le dit clairement et on le retient pour ce modèle.
  const refused = !nTools && cfg.mode !== 'plan' && looksLikeToolRefusal(visible);
  if (refused) {
    cfg.toolRefusals = { ...(cfg.toolRefusals || {}), [String(S.agentId)]: Date.now() }; saveCfg();
    ui.println('\n' + c.yellow('  ⚠ Ce modèle refuse de travailler avec les outils de FS-CLI (consigne de France Student) : il peut discuter, mais pas lire ni modifier tes fichiers.'));
    ui.println(c.dim('    Les modèles Claude acceptent dans nos essais : ') + c.accent('/model sonnet') + c.dim(' ou ') + c.accent('/model opus'));
  }

  const secs = (Date.now() - t0) / 1000;
  const bits = [ui.duration(secs)];
  if (nTools) bits.push(`${nTools} outil${nTools > 1 ? 's' : ''}`);
  bits.push(`${nReq} requête${nReq > 1 ? 's' : ''}`);
  if (tokensIn > 0 && tokensOut > 0) bits.push(`${tokensIn >= 1000 ? (tokensIn / 1000).toFixed(1) + 'k' : tokensIn}↑ ${tokensOut >= 1000 ? (tokensOut / 1000).toFixed(1) + 'k' : tokensOut}↓ tok`);
  S.tokens.in += tokensIn; S.tokens.out += tokensOut;
  S.stats ||= { turns: 0, requests: 0, tools: 0 }; S.stats.turns++; S.stats.requests += nReq; S.stats.tools += nTools;   // pour /usage
  let ctxBit = '';
  if (S.chatId) {
    S.ctxPercent = await ctxPct(S.chatId).catch(() => null);
    if (typeof S.ctxPercent === 'number') { const p = Math.round(S.ctxPercent); ctxBit = ' · ' + (p >= 80 ? c.red : p >= 60 ? c.yellow : c.dim)(`ctx ${p}%`); }
  }
  ui.println('\n' + c.dim(`  ✻ Terminé en ${bits.join(' · ')}`) + ctxBit);
  if (secs > 15 && process.stdout.isTTY) process.stdout.write('\x07');   // tâche longue finie : alerte (la barre des tâches clignote si la fenêtre n'est pas au premier plan)
  if (cfg.sound && secs > 3) process.stdout.write('\x07');
  if (hitLimit) ui.println(c.yellow(`  ⚠ limite de ${cfg.maxSteps || 40} étapes atteinte — tape /continue pour poursuivre`));
  return { hitLimit, nReq };
}
