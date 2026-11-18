// Audit 2 — serveur MCP (fs-cli --mcp) : conversations par dossier, reprises (supprimée, clé expirée), config, Codex, fs_files.
// Hors ligne : aucun appel à la vraie API (stream et runNative remplacés).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-audit2-mcp-'));
const fsHome = path.join(tmp, 'fscli'), home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.FS_CLI_HOME = fsHome;
process.env.FS_IMPORT_HOME = home;
process.env.FS_SESSION_TOKEN = 'faux-jeton-de-test';                 // jamais la vraie clé

const srv = await import('../src/mcp-server.js');
const { cfg, FILES, saveCfg } = await import('../src/config.js');
const { trustFolder } = await import('../src/trust.js');
cfg.mcpAskWhere = false;

const readCfg = () => { try { return JSON.parse(fs.readFileSync(FILES.cfg, 'utf8')); } catch { return {}; } };
const mkDir = name => { const d = fs.mkdtempSync(path.join(tmp, name)); trustFolder(d); return d; };
const call = async (s, name, args) => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
const AGENTS = async () => ({ '-2003': 'Claude Sonnet 5.5' });

/** faux moteur : note la conversation reçue, en crée une si besoin (ids uniques) */
function fakeNative(log, { fail } = {}) {
  let n = 0;
  return async S => {
    log.push({ dir: S.cwd, chat: S.chatId });
    const e = fail?.(S); if (e) throw e;
    if (!S.chatId) S.chatId = `conv-${Date.now().toString(36)}-${++n}`;
    S.lastResponse = 'fait';
  };
}

test('mcp-serveur-1 : chaque dossier a sa conversation (retenue au redémarrage), fs_ask ne récupère pas celle de l\'agent', async () => {
  cfg.mcpChat = null; saveFolders({});
  const A = mkDir('a-'), B = mkDir('b-');
  const log = [], asks = [];
  const stream = async o => { asks.push(o.chatId); if (!o.chatId) o.onChat?.('mcp-ask-0001'); return { text: 'ok' }; };
  let s = srv.createMcpServer({ hasToken: () => true, stream, fetchAgents: AGENTS, runNative: fakeNative(log) });
  assert.ok(!(await call(s, 'fs_agent', { task: 't', folder: A })).isError);
  const chatA = srv.readFolders()?.[srv.folderKey(A)]?.id;
  assert.ok(chatA, 'conversation du dossier A retenue dans la config');
  await call(s, 'fs_agent', { task: 't', folder: B });
  assert.equal(log[1].chat, null, 'le dossier B ne reprend pas la conversation du dossier A');
  await call(s, 'fs_ask', { prompt: 'question' });
  assert.equal(asks.at(-1), null, 'fs_ask ne continue pas la conversation de l\'agent');
  assert.notEqual(cfg.mcpChat?.id, chatA);
  await call(s, 'fs_agent', { task: 't', folder: A });
  assert.equal(log.at(-1).chat, chatA, 'même dossier : même conversation');
  // redémarrage du serveur : la conversation du dossier est retrouvée
  s = srv.createMcpServer({ hasToken: () => true, stream, fetchAgents: AGENTS, runNative: fakeNative(log) });
  await call(s, 'fs_agent', { task: 't', folder: A });
  assert.equal(log.at(-1).chat, chatA);
  // conversation désignée par l'utilisateur (fs_conversations select) : utilisée dans tous les dossiers
  s = srv.createMcpServer({ hasToken: () => true, stream, fetchAgents: AGENTS, runNative: fakeNative(log), fetchChat: async () => ({ title: 'Choisie', chatMessages: [] }) });
  await call(s, 'fs_conversations', { action: 'select', conversation_id: 'choisie-1234' });
  await call(s, 'fs_agent', { task: 't', folder: B });
  assert.equal(log.at(-1).chat, 'choisie-1234');
  assert.equal(srv.readFolders()?.[srv.folderKey(A)]?.id, chatA, 'la conversation propre au dossier A est conservée');
  // « mcp » choisi pour cet appel : la conversation du MCP, pour ce dossier
  s = srv.createMcpServer({ hasToken: () => true, stream, fetchAgents: AGENTS, runNative: fakeNative(log) });
  const C = mkDir('c-');
  await call(s, 'fs_agent', { task: 't', folder: C, conversation_id: 'mcp' });
  assert.equal(log.at(-1).chat, cfg.mcpChat.id);
  cfg.mcpChat = null;
});

test('mcp-serveur-1 : conversation du dossier pleine à 60 % → une neuve à la tâche suivante (dit dans le résultat)', async () => {
  cfg.mcpChat = null; saveFolders({});
  const A = mkDir('plein-');
  const log = [];
  const native = fakeNative(log);
  const s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: async (S, t, o) => { await native(S, t, o); S.ctxPercent = 72; } });
  const r = await call(s, 'fs_agent', { task: 't', folder: A });
  assert.match(r.content[0].text, /remplie à 72 %/);
  assert.equal(srv.readFolders()?.[srv.folderKey(A)], undefined, 'plus retenue');
  await call(s, 'fs_agent', { task: 't', folder: A });
  assert.equal(log.at(-1).chat, null, 'nouvelle conversation');
});

test('mcp-serveur-2 (déjà corrigé en 3.46.2) : la conversation du MCP au-delà de 60 000 tokens repart à neuf', async () => {
  cfg.mcpChat = { id: 'grosse-conv-01', tokens: 70000 }; cfg.dailyLimitHitAt = 0;
  const reqs = [];
  const s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, stream: async o => { reqs.push(o.chatId); if (!o.chatId) o.onChat?.('neuve-conv-01'); return { text: 'ok' }; } });
  await call(s, 'fs_ask', { prompt: 'q' });
  assert.equal(reqs[0], null);
  assert.equal(cfg.mcpChat.id, 'neuve-conv-01');
  cfg.mcpChat = null;
});

test('mcp-serveur-3 : fs_agent se remet d\'une conversation supprimée (dossier ou MCP) ; fs_ask libère aussi les dossiers', async () => {
  cfg.mcpChat = null;
  const A = mkDir('morte-');
  saveFolders({ [srv.folderKey(A)]: { id: 'supprimee-dossier', at: Date.now() } });
  const log = [];
  const fail = S => (S.chatId === 'supprimee-dossier' || S.chatId === 'mcp-morte-123' ? new Error(`Chat not found with id ${S.chatId}`) : null);
  let s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log, { fail }) });
  const r = await call(s, 'fs_agent', { task: 't', folder: A });
  assert.ok(!r.isError, r.content[0].text);
  assert.doesNotMatch(r.content[0].text, /Chat not found/);
  assert.deepEqual(log.map(x => x.chat), ['supprimee-dossier', null]);
  const neuve = srv.readFolders()?.[srv.folderKey(A)]?.id;
  assert.ok(neuve && neuve !== 'supprimee-dossier', 'nouvelle conversation retenue pour le dossier');
  // conversation du MCP supprimée, choisie pour cet appel
  cfg.mcpChat = { id: 'mcp-morte-123' };
  s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log, { fail }) });
  const B = mkDir('mcp-morte-');
  const r2 = await call(s, 'fs_agent', { task: 't', folder: B, conversation_id: 'mcp' });
  assert.ok(!r2.isError, r2.content[0].text);
  assert.equal(cfg.mcpChat, null, 'conversation du MCP oubliée');
  // fs_ask : conversation supprimée → les dossiers qui l'utilisaient repartent aussi à neuf
  cfg.mcpChat = { id: 'mcp-vivante-01' };
  let dead = false;
  const log2 = [];
  s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log2),
    stream: async o => { if (dead && o.chatId === 'mcp-vivante-01') throw new Error('Chat not found'); if (!o.chatId) o.onChat?.('mcp-remplace-01'); return { text: 'ok' }; } });
  const C = mkDir('partage-');
  await call(s, 'fs_agent', { task: 't', folder: C, conversation_id: 'mcp' });
  assert.equal(log2.at(-1).chat, 'mcp-vivante-01');
  dead = true;
  await call(s, 'fs_ask', { prompt: 'q' });
  assert.equal(cfg.mcpChat.id, 'mcp-remplace-01');
  await call(s, 'fs_agent', { task: 't', folder: C });
  assert.notEqual(log2.at(-1).chat, 'mcp-vivante-01', 'le dossier n\'écrit plus dans la conversation supprimée');
  cfg.mcpChat = null;
});

test('mcp-serveur-4 : conversation_id est respecté même quand le dossier a déjà une session', async () => {
  cfg.mcpChat = null; saveFolders({});
  const A = mkDir('choix-');
  const log = [];
  const s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log) });
  await call(s, 'fs_agent', { task: 't', folder: A });
  const own = srv.readFolders()?.[srv.folderKey(A)]?.id;
  await call(s, 'fs_agent', { task: 't', folder: A, conversation_id: 'autre-conv-42' });
  assert.equal(log.at(-1).chat, 'autre-conv-42');
  await call(s, 'fs_agent', { task: 't', folder: A });
  assert.equal(log.at(-1).chat, 'autre-conv-42', 'puis gardée pour la session');
  assert.equal(srv.readFolders()?.[srv.folderKey(A)]?.id, own, 'la conversation propre au dossier reste retenue');
});

test('mcp-serveur-5 : seul le mode imposé est remis, jamais toute la config (réglages changés ailleurs conservés)', async () => {
  const f = path.join(tmp, 'cfg-test.json');
  fs.writeFileSync(f, JSON.stringify({ mode: 'edits', theme: 'nouveau', agentId: -2003 }));
  srv.restoreSavedMode('auto', 'edits', f);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { mode: 'auto', theme: 'nouveau', agentId: -2003 });
  fs.writeFileSync(f, JSON.stringify({ mode: 'ask', theme: 'autre' }));
  srv.restoreSavedMode('auto', 'edits', f);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { mode: 'ask', theme: 'autre' }, 'mode changé dans un autre fs-cli : conservé');
  // de bout en bout : pendant la tâche, l'utilisateur change de mode et de thème dans son fs-cli
  const A = mkDir('mode-');
  const userMode = cfg.mode, userTheme = cfg.theme;
  const s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: async S => {
    fs.writeFileSync(FILES.cfg, JSON.stringify({ ...readCfg(), mode: 'plan', theme: 'theme-change-ailleurs' }));
    S.chatId ||= 'conv-mode-0001'; S.lastResponse = 'ok';
  } });
  await call(s, 'fs_agent', { task: 't', folder: A });
  const saved = readCfg();
  assert.equal(saved.mode, 'plan'); assert.equal(saved.theme, 'theme-change-ailleurs');
  assert.equal(cfg.mode, userMode); assert.equal(cfg.theme, userTheme);
});

test('mcp-serveur-6 : Codex — délai d\'appel d\'outil de 30 min dans la section ajoutée', () => {
  const h = fs.mkdtempSync(path.join(tmp, 'home-codex-'));
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  const res = srv.installMcp({ home: h, cliPath: path.join(tmp, 'cli.js'), command: 'node' });
  assert.equal(res.find(r => r.label === 'Codex')?.status, 'ajouté');
  const t = fs.readFileSync(path.join(h, '.codex', 'config.toml'), 'utf8');
  assert.match(t, /\[mcp_servers\.france-student\]\ncommand = "node"\nargs = \[.*\]\nstartup_timeout_sec = 30\ntool_timeout_sec = 1800\n/);
});

test('mcp-serveur-7 : clé expirée — relue après « fs-cli --login » (nouvel essai), sinon message clair', async () => {
  const f1 = path.join(tmp, 'a.env'), f2 = path.join(tmp, 'b.env');
  fs.writeFileSync(f1, '﻿AUTRE=1\r\nFS_SESSION_TOKEN="cle-du-cli"\r\n'); fs.writeFileSync(f2, 'FS_SESSION_TOKEN=cle-perso\n');
  assert.deepEqual(srv.envTokens([f1, f2, path.join(tmp, 'absent.env')]), ['cle-du-cli', 'cle-perso']);
  cfg.mcpChat = null;
  const e401 = Object.assign(new Error('401 — token de session expiré (récupère un nouveau cookie next-auth.session-token)'), { status: 401 });
  let fresh = false, reloads = 0;
  const reloadToken = () => { reloads++; if (fresh) return false; fresh = true; return true; };
  const reqs = [];
  const s = srv.createMcpServer({ hasToken: () => true, reloadToken, fetchAgents: AGENTS,
    stream: async o => { reqs.push(o.chatId); if (!fresh) throw e401; o.onChat?.('apres-login-01'); return { text: 'réponse' }; } });
  const r = await call(s, 'fs_ask', { prompt: 'q' });
  assert.equal(r.content[0].text, 'réponse'); assert.equal(reqs.length, 2); assert.equal(reloads, 1);
  // clé toujours la même : message utile, sans parler de cookie
  const s2 = srv.createMcpServer({ hasToken: () => true, reloadToken: () => false, fetchAgents: AGENTS, stream: async () => { throw e401; },
    runNative: async () => { throw e401; } });
  const r2 = await call(s2, 'fs_ask', { prompt: 'q' });
  assert.equal(r2.isError, true); assert.match(r2.content[0].text, /fs-cli --login/); assert.doesNotMatch(r2.content[0].text, /cookie/);
  const r3 = await call(s2, 'fs_agent', { task: 't', folder: mkDir('cle-') });
  assert.equal(r3.isError, true); assert.match(r3.content[0].text, /fs-cli --login/); assert.doesNotMatch(r3.content[0].text, /cookie/);
  cfg.mcpChat = null;
});

test('mcp-serveur-8 : fs_files — après un gros fichier texte, les autres sont envoyés ou signalés (jamais oubliés en silence)', async () => {
  cfg.mcpChat = null;
  const dir = fs.mkdtempSync(path.join(tmp, 'gros-'));
  const big = path.join(dir, 'gros.log'), png = path.join(dir, 'capture.png'), md = path.join(dir, 'notes.md');
  fs.writeFileSync(big, 'a'.repeat(200_000)); fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex')); fs.writeFileSync(md, '# notes');
  const uploads = [], reqs = [];
  const s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, upload: async (b, name) => { uploads.push(name); return 'file-1'; },
    stream: async o => { reqs.push(o); if (!o.chatId) o.onChat?.('fichiers-01'); return { text: 'analyse' }; } });
  const r = await call(s, 'fs_files', { paths: [big, png, md], prompt: 'Analyse' });
  assert.ok(!r.isError);
  assert.deepEqual(uploads, ['capture.png'], 'la capture après le gros fichier est envoyée');
  assert.deepEqual(reqs[0].files, ['file-1']);
  assert.match(reqs[0].content, /\[… fichier coupé\]/);
  assert.match(reqs[0].content, /\[notes\.md non inclus : limite/);
  assert.ok(r.content.some(c => c.type === 'text' && /Non envoyé à France Student .*notes\.md/.test(c.text)), 'l\'appelant est prévenu');
  // lecture limitée : jamais tout le fichier, caractère coupé retiré
  const euro = path.join(dir, 'euro.txt'); fs.writeFileSync(euro, '€€€€');
  assert.deepEqual(srv.readTextHead(euro, 12, 1), { text: '€', partial: true });
  assert.deepEqual(srv.readTextHead(euro, 12, 10), { text: '€€€€', partial: false });
  cfg.mcpChat = null;
});

function saveFolders(v) { srv.writeFolders(srv.FOLDERS_FILE, v); }

test('mcp-serveur-1 : la conversation de chaque dossier survit à un saveCfg() (fs-cli, api.js, native.js)', async () => {
  cfg.mcpChat = null; saveFolders({}); cfg.dailyLimitHitAt = 0;
  const A = mkDir('garde-');
  const log = [];
  let s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log) });
  await call(s, 'fs_agent', { task: 't', folder: A });
  const chatA = srv.readFolders()[srv.folderKey(A)]?.id;
  assert.ok(chatA);
  saveCfg();                                                          // même processus (native.js toolRefusals, api.js limite du jour)
  const other = { ...readCfg() }; delete other.mcpFolders;            // autre fs-cli : config réécrite avec ses seules clés
  fs.writeFileSync(FILES.cfg, JSON.stringify(other, null, 2));
  assert.equal(srv.readFolders()[srv.folderKey(A)]?.id, chatA, 'toujours retenue');
  assert.equal(readCfg().mcpFolders, undefined, 'rien dans config.json');
  s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log) });
  await call(s, 'fs_agent', { task: 't', folder: A });
  assert.equal(log.at(-1).chat, chatA, 'redémarrage : même conversation');
  // fichier abîmé : lu comme vide, sans planter
  fs.writeFileSync(srv.FOLDERS_FILE, '{ pas du json');
  assert.deepEqual(srv.readFolders(), {});
  saveFolders({});
});

test('mcp-serveur-1 : limite des 50 nouvelles conversations atteinte → conversation existante (dit dans le résultat), jamais un 429', async () => {
  saveFolders({});
  const A = mkDir('limite-a-'), B = mkDir('limite-b-'), C = mkDir('limite-c-');
  const log = [];
  // limite déjà connue : la conversation du MCP
  cfg.dailyLimitHitAt = Date.now(); cfg.mcpChat = { id: 'mcp-existante-01' };
  let s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log) });
  let r = await call(s, 'fs_agent', { task: 't', folder: A });
  assert.equal(log.at(-1).chat, 'mcp-existante-01');
  assert.match(r.content[0].text, /Limite des 50 nouvelles conversations.*conversation du MCP/);
  assert.equal(srv.readFolders()[srv.folderKey(A)], undefined, 'empruntée : pas retenue comme celle du dossier');
  // sans conversation du MCP : celle du dernier dossier utilisé
  cfg.mcpChat = null; saveFolders({ autre: { id: 'dossier-autre-01', at: Date.now() } });
  s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, runNative: fakeNative(log) });
  r = await call(s, 'fs_agent', { task: 't', folder: B });
  assert.equal(log.at(-1).chat, 'dossier-autre-01');
  assert.match(r.content[0].text, /conversation d'un autre dossier/);
  // limite remise à zéro : le dossier prend sa propre conversation
  cfg.dailyLimitHitAt = 0;
  await call(s, 'fs_agent', { task: 't', folder: B });
  assert.equal(log.at(-1).chat, null);
  // limite découverte à l'instant (429 sur la création) : nouvel essai dans une conversation existante
  cfg.mcpChat = { id: 'mcp-existante-02' };
  const e429 = Object.assign(new Error('Limite de 50 nouvelles conversations par jour atteinte'), { status: 429 });
  s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS,
    runNative: fakeNative(log, { fail: S => { if (S.chatId) return null; cfg.dailyLimitHitAt = Date.now(); return e429; } }) });
  r = await call(s, 'fs_agent', { task: 't', folder: C });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(log.slice(-2).map(x => x.chat), [null, 'mcp-existante-02']);
  cfg.dailyLimitHitAt = 0; cfg.mcpChat = null; saveFolders({});
});

/** vrai moteur (native.js) avec un faux flux : 1re requête = un appel d'outil, 2e = l'erreur donnée */
async function realNativeServer(call1, err2, extra = {}) {
  const { runNative } = await import('../src/native.js');
  const tools = await import('../src/tools.js'); await tools.detectEnv?.();
  const sent = [];
  const stream = async o => {
    sent.push(o.chatId);
    if (sent.length === 1) { if (!o.chatId) o.onChat?.('conv-vraie-0001'); return { text: '', toolCalls: [{ id: 'c1', ...call1 }] }; }
    if (sent.length === 2) throw err2;
    if (!o.chatId) o.onChat?.('conv-vraie-0002');
    return { text: 'fait' };
  };
  const s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, ...extra, runNative: (S, t, o) => runNative(S, t, { ...o, stream, ctxPct: async () => null }) });
  return { s, sent };
}

test('mcp-serveur-3 : conversation verrouillée APRÈS des actions → jamais relancée (rien n\'est refait), oubliée pour la suite', async () => {
  cfg.mcpChat = null; cfg.dailyLimitHitAt = 0;
  const B = mkDir('verrou-');
  saveFolders({ [srv.folderKey(B)]: { id: 'conv-existe-b1', at: Date.now() } });
  const { s, sent } = await realNativeServer({ name: 'write_file', arguments: JSON.stringify({ path: 'compteur.txt', content: 'x' }) },
    new Error('This conversation was flagged by the AI provider and has been locked'));
  const r = await call(s, 'fs_agent', { task: 'écris compteur.txt', folder: B });
  const text = r.content[0].text;
  assert.equal(sent.length, 2, 'pas de 3e requête : la tâche n\'est pas renvoyée en entier');
  assert.equal(fs.readFileSync(path.join(B, 'compteur.txt'), 'utf8'), 'x');
  assert.match(text, /compteur\.txt \(créé\)/);
  assert.match(text, /au moins 1 avant l'erreur/);
  assert.match(text, /n'a pas été relancée/);
  assert.match(text, /prochaine tâche dans ce dossier démarrera une nouvelle conversation/);
  assert.equal(srv.readFolders()[srv.folderKey(B)], undefined, 'conversation verrouillée oubliée');
  // tâche suivante : nouvelle conversation (et pas la verrouillée)
  sent.length = 2;
  await call(s, 'fs_agent', { task: 'suite', folder: B });
  assert.equal(sent[2], null);
});

test('mcp-serveur-3 : une simple lecture avant l\'erreur suffit à empêcher la relance', async () => {
  cfg.mcpChat = null;
  const B = mkDir('lecture-');
  fs.writeFileSync(path.join(B, 'a.txt'), 'contenu');
  saveFolders({ [srv.folderKey(B)]: { id: 'conv-lecture-01', at: Date.now() } });
  const { s, sent } = await realNativeServer({ name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }, new Error('Chat not found with id conv-lecture-01'));
  await call(s, 'fs_agent', { task: 'lis a.txt', folder: B });
  assert.equal(sent.length, 2);
});

test('mcp-serveur-7 : clé expirée APRÈS des actions → pas de relance, même si une nouvelle clé existe', async () => {
  cfg.mcpChat = null;
  const B = mkDir('cle-tard-');
  let reloads = 0;
  const e401 = Object.assign(new Error('401 — token de session expiré'), { status: 401 });
  const { s, sent } = await realNativeServer({ name: 'write_file', arguments: JSON.stringify({ path: 'un.txt', content: '1' }) }, e401,
    { reloadToken: () => { reloads++; return true; } });
  const r = await call(s, 'fs_agent', { task: 'écris un.txt', folder: B });
  assert.equal(sent.length, 2); assert.equal(reloads, 0);
  assert.match(r.content[0].text, /fs-cli --login/);
  assert.match(r.content[0].text, /n'a pas été relancée/);
});

test('mcp-serveur-7 : la clé de ~/.fs-cli/.env (écrite par « fs-cli --login ») est essayée en premier', async () => {
  const config = await import('../src/config.js');
  const before = config.TOKEN;
  fs.mkdirSync(fsHome, { recursive: true });
  fs.writeFileSync(path.join(fsHome, '.env'), 'FS_SESSION_TOKEN=cle-apres-login\n');
  try {
    const f1 = path.join(tmp, 'root.env'), f2 = path.join(fsHome, '.env');
    fs.writeFileSync(f1, 'FS_SESSION_TOKEN=cle-ancienne\n');
    assert.deepEqual(srv.envTokens([f2, f1]), ['cle-apres-login', 'cle-ancienne']);
    const used = [];
    const s = srv.createMcpServer({ hasToken: () => true, fetchAgents: AGENTS, stream: async o => {
      used.push(config.TOKEN);
      if (config.TOKEN !== 'cle-apres-login') throw Object.assign(new Error('401'), { status: 401 });
      if (!o.chatId) o.onChat?.('conv-login-001'); return { text: 'ok' };
    } });
    const r = await call(s, 'fs_ask', { prompt: 'q' });
    assert.equal(r.content[0].text, 'ok');
    assert.deepEqual(used, [before, 'cle-apres-login']);
  } finally { config.setToken(before); fs.rmSync(path.join(fsHome, '.env'), { force: true }); cfg.mcpChat = null; }
});
