// E2E de la passerelle avec le VRAI Claude Code et un FAUX France Student (spécification § 5.1, hors de scripts.test).
// Lancement à la main : node test/gateway-e2e.check.mjs   (ignoré si Claude Code est absent ou en CI).
//
// Aucun appel réseau externe vers France Student : la passerelle (startGateway, port 0) reçoit un faux FS scénarisé
// (test/gateway-helpers.mjs). Claude Code tourne en -p dans un dossier temporaire neuf, avec CLAUDE_CONFIG_DIR vers un
// dossier temporaire : la configuration de l'utilisateur (~/.claude) n'est ni lue ni modifiée.
//
// Scénario 1 : read_file hello.txt → Read exécuté → le faux FS reçoit « N: ligne » → (sonde § 7 q11 : ls / find | head,
//              plus un témoin « node -e » qui doit être refusé faute de règle allow) → texte final.
// Scénario 2 : edit_file sur calc.js sans lecture préalable → Read{limit:1} injecté + Edit dans le même message (§ 7 q1)
//              → fichier réellement modifié → run_command « node --version » → Bash exécuté → résultat reçu par FS.
//              Les réglages utilisateur (CLAUDE_CONFIG_DIR/settings.json) pointent ANTHROPIC_BASE_URL vers un port mort :
//              --settings doit l'emporter (§ 7 q2).
// Scénario 3 : arrière-plan (titre…) servi localement : AUCUN appel au faux FS ; tous les corps reçus passent assertClean strict.
// Scénario 4 : Edit sur un fichier non lu (Read injecté désactivé) → micro-tour local [Read, Edit] (§ 7 q1),
//              et permissions.ask de --settings face à allow:["Bash"] des réglages utilisateur (--fs-demander, § 7 q2).
// Témoin q2 : sans --settings, env.ANTHROPIC_BASE_URL des réglages utilisateur (port mort) l'emporte-t-il sur l'environnement ?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpHome, fakeFs } from './gateway-helpers.mjs';          // pose FS_CLI_HOME (dossier temporaire) avant tout import de src/

const { startGateway } = await import('../src/gateway/index.js');
const { assertClean } = await import('../src/gateway/outbound.js');
const { findClaude, childEnv, writeClaudeSettings, claudeVersion } = await import('../src/gateway/launch.js');

const RUN_TIMEOUT_MS = 240000;
const MODEL = 'claude-sonnet-5-5';

let pass = 0, fail = 0;
const failures = [];
const findings = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
const note = s => findings.push(s);

// ── Garde : CI ou Claude Code absent ──────────────────────────────────────────────────────────────────────────────────

const bin = findClaude(process.env);
if (process.env.CI || !bin) {
  console.log(`gateway-e2e : ignoré (${process.env.CI ? 'CI' : 'Claude Code introuvable'}).`);
  process.exit(0);
}
const version = claudeVersion(bin) || 'inconnue';

// ── Dossiers temporaires ──────────────────────────────────────────────────────────────────────────────────────────────

const root = tmpHome({ prefix: 'fscli-e2e-' });
const work = path.join(root, 'projet');
fs.mkdirSync(work);
const HELLO = 'Bonjour depuis hello.txt\nDeuxième ligne\n';
const CALC = 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n';
const NOTE = 'note initiale\n';
fs.writeFileSync(path.join(work, 'hello.txt'), HELLO);
fs.writeFileSync(path.join(work, 'calc.js'), CALC);
fs.writeFileSync(path.join(work, 'note.txt'), NOTE);

/** Dossier de configuration Claude Code neuf (CLAUDE_CONFIG_DIR), avec un settings.json « utilisateur » facultatif. */
function configDir(name, userSettings = null) {
  const d = path.join(root, `cc-config-${name}`);
  fs.mkdirSync(d, { recursive: true });
  if (userSettings) fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(userSettings, null, 2));
  return d;
}

/** Environnement de base sans les variables d'une session Claude Code parente (le test peut tourner DANS Claude Code). */
function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC_|AI_AGENT$|MCP_)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

// ── Lancement de Claude Code ──────────────────────────────────────────────────────────────────────────────────────────

/** claude -p … --output-format stream-json --verbose → { code, events, stderr, timedOut } */
function runClaude(args, { env, cwd }) {
  return new Promise(resolve => {
    const child = bin.isCmd
      ? spawn([bin.cmd, ...args].map(a => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(bin.cmd, [...(bin.args || []), ...args], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, RUN_TIMEOUT_MS);
    const end = code => {
      clearTimeout(timer);
      const events = [];
      for (const l of out.split(/\r?\n/)) { if (!l.trim()) continue; try { events.push(JSON.parse(l)); } catch {} }
      resolve({ code, events, stderr: err, timedOut });
    };
    child.on('exit', end);
    child.on('error', e => { err += String(e?.message || e); end(1); });
  });
}

/** tool_use émis par Claude Code (dans l'ordre) et tool_result reçus, depuis le flux stream-json. */
function toolTrace(events) {
  const uses = [], results = {}, byMessage = new Map();
  for (const e of events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (e.type === 'assistant' && b.type === 'tool_use') {
        uses.push({ id: b.id, name: b.name, input: b.input, msg: e.message.id });
        byMessage.set(e.message.id, [...(byMessage.get(e.message.id) || []), b.name]);
      }
      if (e.type === 'user' && b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join('\n');
        results[b.tool_use_id] = { text, isError: !!b.is_error };
      }
    }
  }
  const final = events.filter(e => e.type === 'result').at(-1) || null;
  return { uses, results, byMessage, final };
}

// ── Passerelle sur un faux FS ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Démarre une passerelle neuve sur un faux FS scénarisé. Les existences de fichiers sont celles du VRAI disque
 * (Read injecté seulement si le fichier existe), sauf les chemins de hideFiles (Read injecté désactivé).
 */
async function gateway(name, turns, { hideFiles = [] } = {}) {
  const fake = fakeFs({ turns });
  const hidden = p => hideFiles.some(h => path.resolve(p).toLowerCase() === path.resolve(h).toLowerCase());
  fake.deps.fsExists = p => !hidden(p) && fs.existsSync(p);
  fake.deps.fsStat = p => { if (hidden(p)) return null; try { return fs.statSync(p); } catch { return null; } };
  const lines = [];
  const dir = path.join(root, `gw-${name}`);
  const gw = await startGateway({
    port: 0, deps: fake.deps, log: { line: o => lines.push(o), debug() {} },
    opts: { storeDir: dir, agentsFile: path.join(dir, 'agents.json'), defaultAgentId: -2003, cwd: work },
  });
  return { fake, gw, lines, url: `http://127.0.0.1:${gw.port}` };
}

/** Lance Claude Code sur la passerelle, comme « fs-cli claude » : environnement de childEnv + --settings. */
async function claudeOn(g, prompt, { name, userSettings = null, ask = false, extra = [], withSettings = true, envExtra = {} }) {
  const cfgDir = configDir(name, userSettings);
  const settings = writeClaudeSettings(path.join(root, `claude-settings-${name}.json`), { url: g.url, token: g.gw.token, ask });
  // pas de mise à jour automatique. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC n'est PAS posé : il supprime aussi la requête
  // de titre (vérifié en 2.1.207), que le scénario 3 doit voir servie en local
  const env = { ...childEnv(baseEnv(), { url: g.url, token: g.gw.token, model: MODEL }), CLAUDE_CONFIG_DIR: cfgDir,
    DISABLE_AUTOUPDATER: '1', ...envExtra };
  // --strict-mcp-config : sans lui, un .mcp.json d'un dossier parent (ex. ~/.mcp.json, os.tmpdir() étant sous le profil
  // Windows) serait chargé, et Claude Code contacterait ses serveurs MCP
  const args = [...(withSettings ? ['--settings', settings] : []), '--strict-mcp-config',
    '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', ...extra];
  const r = await runClaude(args, { env, cwd: work });
  return { ...r, trace: toolTrace(r.events) };
}

/** Scénario 3 : les corps reçus par le faux FS passent assertClean strict, et l'arrière-plan n'a rien coûté. */
function checkClean(label, g, expectedPosts) {
  g.fake.sent.forEach((s, i) => {
    let leaks = [];
    try { leaks = assertClean(structuredClone(s), { strict: true }); } catch (e) { leaks = [String(e?.message || e)]; }
    check(`${label} : envoi ${i + 1} propre (assertClean strict)`, !leaks.length, leaks.join(' ; '));
  });
  const local = g.lines.filter(l => l.event === 'local').map(l => l.kind);
  const mains = g.lines.filter(l => l.event === 'request');
  check(`${label} : ${expectedPosts} POST exactement vers le faux FS`, g.fake.sent.length === expectedPosts, `reçu ${g.fake.sent.length}`);
  check(`${label} : une seule conversation FS créée`, g.fake.registered.length === 1, `créées ${g.fake.registered.length}`);
  check(`${label} : aucun tour du faux FS épuisé`, g.fake.errors.length === 0, g.fake.errors.map(e => e.message).join(' ; '));
  const bg = /title|name|suggestion|summary|probe|compact|bash_prefix|background_other/;
  const bgText = /SUGGESTION MODE|Respond with TEXT ONLY|stepped away|Describe your most recent action|"title"|Generate a (concise|short) title/i;
  check(`${label} : aucun corps d'arrière-plan chez FS`, !g.fake.sent.some(s => bgText.test(String(s.content || ''))));
  return { local: local.filter(k => bg.test(k)), mains: mains.length };
}

const outputOf = (send, callId) => send?.toolResults?.find(r => r.callId === callId) || null;
const short = s => String(s || '').replace(/\s+/g, ' ').slice(0, 160);

// ── Scénario 1 : lecture ──────────────────────────────────────────────────────────────────────────────────────────────

async function scenario1() {
  const seen = {};
  const g = await gateway('s1', [
    send => { seen.first = send; return { text: 'Je lis le fichier. ', toolCalls: [{ callId: 'call_r1', name: 'read_file', arguments: { path: 'hello.txt' } }] }; },
    send => {
      seen.read = outputOf(send, 'call_r1');
      return { text: 'Je liste le dossier. ', toolCalls: [
        { callId: 'call_l1', name: 'list_directory', arguments: { path: '.' } },
        { callId: 'call_l2', name: 'list_directory', arguments: { path: '.', depth: 2 } },
        // témoin : une commande qui n'est pas en lecture seule doit être refusée (aucune règle allow : config isolée)
        { callId: 'call_t1', name: 'run_command', arguments: { command: 'node -e "process.exit(0)"' } }] };
    },
    send => {
      seen.ls = outputOf(send, 'call_l1'); seen.find = outputOf(send, 'call_l2'); seen.witness = outputOf(send, 'call_t1');
      return 'hello.txt contient « Bonjour depuis hello.txt ».';
    },
  ]);
  try {
    const r = await claudeOn(g, 'lis hello.txt et dis-moi ce qu\'il contient', { name: 's1' });
    check('S1 : Claude Code termine (code 0)', r.code === 0 && !r.timedOut, `code ${r.code}${r.timedOut ? ' (délai dépassé)' : ''} ${short(r.stderr)}`);
    const names = r.trace.uses.map(u => u.name);
    check('S1 : Claude Code exécute Read sur hello.txt', r.trace.uses[0]?.name === 'Read' && /hello\.txt$/i.test(r.trace.uses[0]?.input?.file_path || ''), names.join(','));
    check('S1 : premier envoi = préambule + demande, nouveau chat', !seen.first?.chatId && !!seen.first?.register && /lis hello\.txt/.test(seen.first?.content || ''));
    check('S1 : le faux FS reçoit le contenu au format « N: ligne »',
      !!seen.read && !seen.read.isError && /^1: Bonjour depuis hello\.txt$/m.test(seen.read.output) && /^2: Deuxième ligne$/m.test(seen.read.output), short(seen.read?.output));
    check('S1 : texte final rendu par Claude Code', /Bonjour depuis hello\.txt/.test(r.trace.final?.result || ''), short(r.trace.final?.result));
    // § 7 q11 : ls / find | head sans règle allow (CLAUDE_CONFIG_DIR neuf, aucune autorisation Bash)
    for (const [label, o] of [['ls -la', seen.ls], ['find … | head', seen.find]]) {
      if (!o) { note(`q11 : ${label} → aucun résultat reçu`); continue; }
      const denied = /permission|approval|not allowed|refus|requires approval/i.test(o.output) && o.isError;
      note(`q11 : ${label} sans règle allow (-p, acceptEdits) → ${denied ? 'REFUSÉ' : o.isError ? 'erreur' : 'exécuté sans demande'} : ${short(o.output)}`);
    }
    const w = seen.witness;
    check('S1 (q11) : témoin node -e refusé sans règle allow (réglages de l\'utilisateur non lus)',
      !!w && w.isError && /^Action non autorisée/.test(w.output), `${w?.isError ? 'erreur' : 'succès'} : ${short(w?.output)}`);
    check('S1 (q11) : ls et find | head exécutés sans règle allow (lecture seule)',
      !!seen.ls && !seen.ls.isError && /hello\.txt/.test(seen.ls.output) && !!seen.find && !seen.find.isError && /calc\.js/.test(seen.find.output),
      `${short(seen.ls?.output)} | ${short(seen.find?.output)}`);
    const c = checkClean('S1', g, 3);
    note(`S1 : requêtes d'arrière-plan servies en local : ${c.local.join(', ') || 'aucune'} ; requêtes moteur : ${c.mains}`);
    return c;
  } finally { await g.gw.close(); }
}

// ── Scénario 2 : modification sans lecture + commande ────────────────────────────────────────────────────────────────

async function scenario2() {
  const seen = {};
  const g = await gateway('s2', [
    () => ({ text: 'Je corrige l\'addition. ', toolCalls: [{ callId: 'call_e1', name: 'edit_file',
      arguments: { path: 'calc.js', old_text: '  return a - b;', new_text: '  return a + b;' } }] }),
    send => { seen.edit = send; return { text: 'Je vérifie node. ', toolCalls: [{ callId: 'call_c1', name: 'run_command', arguments: { command: 'node --version' } }] }; },
    send => { seen.cmd = outputOf(send, 'call_c1'); return 'calc.js est corrigé et node répond.'; },
  ]);
  try {
    // réglages « utilisateur » : base URL vers un port mort et Bash autorisé partout (comme ~/.claude/settings.json réel)
    const userSettings = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, permissions: { allow: ['Bash'] } };
    const r = await claudeOn(g, 'corrige le bug de calc.js puis vérifie la version de node', { name: 's2', userSettings });
    check('S2 : Claude Code termine (code 0)', r.code === 0 && !r.timedOut, `code ${r.code} ${short(r.stderr)}`);
    check('S2 (q2) : --settings l\'emporte sur env.ANTHROPIC_BASE_URL des réglages utilisateur', g.fake.sent.length > 0);
    const uses = r.trace.uses;
    const iEdit = uses.findIndex(u => u.name === 'Edit');
    const read = uses[iEdit - 1];
    check('S2 (q1) : [Read{limit:1}, Edit] dans le même message, dans cet ordre',
      iEdit > 0 && read?.name === 'Read' && read.input?.limit === 1 && read.msg === uses[iEdit].msg, uses.map(u => `${u.name}@${u.msg}`).join(','));
    const editRes = r.trace.results[uses[iEdit]?.id];
    check('S2 (q1) : Edit réussi après Read{limit:1}', !!editRes && !editRes.isError, short(editRes?.text));
    check('S2 : calc.js réellement modifié sur le disque', fs.readFileSync(path.join(work, 'calc.js'), 'utf8').includes('return a + b;'));
    const er = outputOf(seen.edit, 'call_e1');
    check('S2 : le faux FS reçoit un seul résultat (Edit), pas le Read injecté',
      seen.edit?.toolResults?.length === 1 && !!er && !er.isError, JSON.stringify(seen.edit?.toolResults || []).slice(0, 200));
    check('S2 : Bash « node --version » exécuté', uses.some(u => u.name === 'Bash' && /node --version/.test(u.input?.command || '')), uses.map(u => u.name).join(','));
    check('S2 : le faux FS reçoit la sortie de node --version', !!seen.cmd && !seen.cmd.isError && /v\d+\.\d+\.\d+/.test(seen.cmd.output), short(seen.cmd?.output));
    check('S2 : texte final rendu', /corrigé/.test(r.trace.final?.result || ''), short(r.trace.final?.result));
    const c = checkClean('S2', g, 3);
    note(`S2 : requêtes d'arrière-plan servies en local : ${c.local.join(', ') || 'aucune'} ; requêtes moteur : ${c.mains}`);
    return c;
  } finally { await g.gw.close(); }
}

// ── Scénario 4 : Edit sur fichier non lu (micro-tour) + permissions.ask de --settings ───────────────────────────────

async function scenario4() {
  const seen = {};
  const notePath = path.join(work, 'note.txt');
  const g = await gateway('s4', [
    () => ({ text: 'Je modifie la note. ', toolCalls: [{ callId: 'call_e2', name: 'edit_file',
      arguments: { path: 'note.txt', old_text: 'note initiale', new_text: 'note modifiée' } }] }),
    send => { seen.edit = send; return { text: 'Je lance une commande. ', toolCalls: [{ callId: 'call_c2', name: 'run_command', arguments: { command: 'node --version' } }] }; },
    send => { seen.cmd = outputOf(send, 'call_c2'); return 'Terminé.'; },
  ], { hideFiles: [notePath] });
  try {
    const userSettings = { permissions: { allow: ['Bash'] } };
    const r = await claudeOn(g, 'remplace « note initiale » par « note modifiée » dans note.txt', { name: 's4', userSettings, ask: true });
    check('S4 : Claude Code termine (code 0)', r.code === 0 && !r.timedOut, `code ${r.code} ${short(r.stderr)}`);
    const uses = r.trace.uses;
    const first = uses[0];
    const firstRes = first ? r.trace.results[first.id] : null;
    note(`q1 : Edit sur un fichier non lu (-p, acceptEdits) → ${firstRes ? (firstRes.isError ? 'ERREUR : ' : 'OK : ') + short(firstRes.text) : 'aucun résultat'}`);
    const micro = g.lines.some(l => l.event === 'micro-tour');
    if (firstRes?.isError && /has not been read yet/i.test(firstRes.text)) {
      check('S4 (q1) : micro-tour local [Read, Edit] sans appel FS', micro && uses.length >= 3 && uses[1].name === 'Read' && uses[2].name === 'Edit',
        uses.map(u => u.name).join(','));
    }
    check('S4 : note.txt réellement modifié', fs.readFileSync(notePath, 'utf8').includes('note modifiée'));
    const er = outputOf(seen.edit, 'call_e2');
    check('S4 : un seul résultat définitif envoyé à FS pour l\'Edit', seen.edit?.toolResults?.length === 1 && !!er && !er.isError, short(er?.output));
    // § 7 q2 : permissions.ask de --settings (--fs-demander) contre allow:["Bash"] des réglages utilisateur
    if (seen.cmd) {
      const asked = seen.cmd.isError && !/v\d+\.\d+\.\d+/.test(seen.cmd.output);
      note(`q2 : permissions.ask de --settings face à allow:["Bash"] utilisateur → ${asked ? 'ask l\'emporte (commande non exécutée en -p)' : 'allow l\'emporte (commande exécutée)'} : ${short(seen.cmd.output)}`);
      if (asked) check('S4 : refus de permission traduit en français pour FS', /^Action non autorisée/.test(seen.cmd.output), short(seen.cmd.output));
    } else note('q2 : aucun résultat de commande reçu');
    const c = checkClean('S4', g, 3);
    note(`S4 : requêtes d'arrière-plan servies en local : ${c.local.join(', ') || 'aucune'} ; requêtes moteur : ${c.mains}`);
    return c;
  } finally { await g.gw.close(); }
}

// ── Témoin q2 : sans --settings, l'env des réglages utilisateur l'emporte-t-il sur celui du processus ? ──────────────

async function witnessNoSettings() {
  const g = await gateway('t2', ['Réponse du témoin.']);
  try {
    const userSettings = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } };
    const r = await claudeOn(g, 'dis bonjour', { name: 't2', userSettings, withSettings: false,
      envExtra: { CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '15000' } });
    const reached = g.lines.some(l => l.event === 'request' || l.event === 'local');
    note(`q2 témoin : sans --settings, env.ANTHROPIC_BASE_URL de ~/.claude/settings.json ${reached
      ? 'NE l\'emporte PAS sur l\'environnement du processus (la passerelle a été jointe)'
      : 'l\'emporte sur l\'environnement du processus (passerelle jamais jointe) : --settings est indispensable'} (code ${r.code})`);
    check('Témoin q2 : aucun tour du faux FS épuisé', g.fake.errors.length === 0);
    return null;
  } finally { await g.gw.close(); }
}

// ── Exécution ─────────────────────────────────────────────────────────────────────────────────────────────────────────

console.log(`gateway-e2e : Claude Code ${version} (${bin.cmd}) · dossier ${work}`);
const all = [];
for (const [name, fn] of [['scénario 1', scenario1], ['scénario 2', scenario2], ['scénario 4', scenario4], ['témoin q2', witnessNoSettings]]) {
  const t0 = Date.now();
  try { all.push(await fn()); }
  catch (e) { check(`${name} : exception`, false, String(e?.stack || e).slice(0, 400)); }
  console.log(`  ${name} : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
// Scénario 3 : l'arrière-plan a bien été vu (au moins une requête locale) et n'a jamais coûté d'appel FS (vérifié par les comptes exacts)
const localKinds = all.flatMap(c => c?.local || []);
check('S3 : au moins une requête d\'arrière-plan reçue et servie en local', localKinds.length > 0, 'aucune requête locale vue');

for (const f of findings) console.log(`  · ${f}`);
console.log(`gateway-e2e : ${pass} OK, ${fail} échec(s)`);
for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`  (dossiers temporaires laissés en place pour inspection : ${root})`);
process.exit(fail ? 1 : 0);
