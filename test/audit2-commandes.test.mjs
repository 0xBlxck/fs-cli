// Audit 2 (commandes et tokens) : /preprompt /profil /skill sans renvoi du contexte, /project, /history, /btw et /compare,
// contexte des agents de /team, conversations « w0, w1… » remises à zéro, résumé pendant une longue demande, MCP de FS-CLI jamais réimporté.
// Aucun appel réseau : faux France Student injecté partout.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-audit2-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const importHome = path.join(tmp, 'autre-home');
fs.mkdirSync(importHome, { recursive: true });
process.env.FS_IMPORT_HOME = importHome;

const { cfg, upsertSession } = await import('../src/config.js');
const { extraCommand, contextNote, cleanTitle, maybeAutoCompact } = await import('../src/extra-commands.js');
const { runTeam, workerContext } = await import('../src/team.js');
const { runNative, HEAVY_NOTE } = await import('../src/native.js');
const { discoverMcpServers, isSelfMcpServer } = await import('../src/discover.js');
const { mentionedServers, workPreferences } = await import('../src/pseudo.js');
const { loadMcpConfig } = await import('../src/mcp.js');
const { detectEnv } = await import('../src/tools.js');
await detectEnv();
cfg.mode = 'auto';
cfg.dailyLimitHitAt = 0;

const mkdir = p => { const d = fs.mkdtempSync(path.join(tmp, p)); return d; };
const baseS = over => ({ chatId: 'main-1', ctxSent: true, slots: {}, sid: 'abcd', agentId: -2003, cwd: mkdir('w-'), targetDir: null, undo: [], allow: {},
  pendingResults: [], notes: [], pendingContext: [], tokens: { in: 0, out: 0 }, ...over });
const envOf = (S, over = {}) => ({ S, AGENTS: { '-2003': 'Claude Sonnet', '-1001': 'GPT' }, modelName: id => (id == null ? 'Modèle' : `M${id}`), resolveModel: () => null,
  withAbort: fn => fn(new AbortController().signal), ask: async () => 'o', buildMessage: t => t, refreshPrompt: () => {}, applySession: () => {}, ...over });

// ── /preprompt, /profil, /skill : seulement le changement, jamais une 2e copie du bloc ──
test('contextNote : note dans la conversation qui a déjà le contexte, rien sinon', () => {
  const S = baseS();
  assert.equal(contextNote(S, 'n1'), true); assert.deepEqual(S.notes, ['n1']);
  const neuf = baseS({ chatId: null, ctxSent: false });
  assert.equal(contextNote(neuf, 'n2'), false); assert.deepEqual(neuf.notes, [], 'pas de conversation : le bloc complet partira, à jour');
  const pasEnvoye = baseS({ ctxSent: false });
  assert.equal(contextNote(pasEnvoye, 'n3'), true); assert.deepEqual(pasEnvoye.notes, [], 'bloc pas encore envoyé : il partira au prochain message');
  const nu = baseS({ bareChat: true });
  assert.equal(contextNote(nu, 'n4'), false); assert.deepEqual(nu.notes, []);
});

test('/preprompt, /profil learn|forget et /skill ne remettent plus ctxSent à false', async () => {
  const S = baseS();
  assert.equal(await extraCommand('/preprompt', 'réponds toujours en français', envOf(S)), true);
  assert.equal(S.ctxSent, true);
  assert.match(S.notes.at(-1), /Nouveau préprompt.*réponds toujours en français/);
  await extraCommand('/preprompt', 'clear', envOf(S));
  assert.equal(S.ctxSent, true); assert.match(S.notes.at(-1), /effacé son préprompt/);

  await extraCommand('/profil', 'learn aime le code commenté', envOf(S));
  assert.equal(S.ctxSent, true); assert.match(S.notes.at(-1), /Fait sur l'utilisateur : aime le code commenté/);
  await extraCommand('/profil', 'forget 1', envOf(S));
  assert.equal(S.ctxSent, true); assert.match(S.notes.at(-1), /retiré ce fait.*aime le code commenté/);

  const before = [...cfg.skills];
  await extraCommand('/skill', '1', envOf(S));
  assert.equal(S.ctxSent, true); assert.match(S.notes.at(-1), /Compétence à appliquer désormais|N'applique plus la compétence/);
  await extraCommand('/skill', '1', envOf(S));
  assert.deepEqual(cfg.skills, before);
  assert.ok(!S.notes.some(n => /Contexte de l'utilisateur/.test(n)), 'jamais le bloc complet');
});

// ── /project : même chemin que /cd ──
test('/project passe par changeCwd (confiance, dossier cible remis à zéro) ; refus → rien d\'affiché comme changé', async () => {
  const dest = mkdir('proj-');
  const S = baseS({ targetDir: mkdir('ancien-') });
  const calls = [];
  const changeCwd = async d => { calls.push(d); S.cwd = d; S.targetDir = null; };
  await extraCommand('/project', dest, envOf(S, { changeCwd }));
  assert.deepEqual(calls, [dest]); assert.equal(S.cwd, dest); assert.equal(S.targetDir, null);

  const S2 = baseS(), was = S2.cwd;
  await extraCommand('/project', dest, envOf(S2, { changeCwd: async () => {} }));   // refusé : dossier inchangé
  assert.equal(S2.cwd, was);
});

test('/project sans changeCwd (ancien cli.js) : le dossier cible d\'avant ne reçoit plus les écritures', async () => {
  const dest = mkdir('proj-');
  const S = baseS({ targetDir: mkdir('ancien-') });
  await extraCommand('/project', dest, envOf(S));
  assert.equal(S.cwd, dest); assert.equal(S.targetDir, null);
  assert.match(S.notes.at(-1), /Dossier courant changé/);
});

// ── /history <n°> ──
test('/history <n°> : resumeChatById si disponible, sinon session locale (contexte pas renvoyé, sid et slots gardés)', async () => {
  const list = [{ id: 'chat-loc', title: '[7f3a] Mon site', agent: { id: -2003, name: 'Sonnet' } }, { id: 'chat-site', title: '[9b2c·w0] Autre', agent: { id: -1001 } }];
  const S = baseS();
  const resumed = [];
  await extraCommand('/history', '1', envOf(S, { fetchChatsList: async () => list, resumeChatById: async id => { resumed.push(id); return []; } }));
  assert.deepEqual(resumed, ['chat-loc']);

  upsertSession({ chatId: 'chat-loc', agentId: -2003, cwd: S.cwd, title: '[7f3a] Mon site', ctxSent: true, sid: '7f3a', slots: { w0: 'w-old' }, targetDir: null });
  const applied = [];
  await extraCommand('/history', '1', envOf(S, { fetchChatsList: async () => list, applySession: s => applied.push(s) }));
  assert.equal(applied[0].ctxSent, true); assert.equal(applied[0].sid, '7f3a'); assert.deepEqual(applied[0].slots, { w0: 'w-old' });
  assert.equal(applied[0].title, 'Mon site', 'titre sans l\'étiquette');

  await extraCommand('/history', '2', envOf(S, { fetchChatsList: async () => list, applySession: s => applied.push(s) }));
  assert.equal(applied[1].chatId, 'chat-site'); assert.equal(applied[1].ctxSent, true, 'conversation du compte : déjà son contexte, pas de 2e copie');
  assert.equal(applied[1].title, 'Autre');
  assert.equal(cleanTitle('[ab12·btw] Question'), 'Question');
});

// ── /btw et /compare ──
function fakeChat() {
  const st = { calls: [], seq: 0 };
  const stream = async o => {
    let chatId = o.chatId;
    if (!chatId) { chatId = `neuve-${++st.seq}`; o.onChat?.(chatId); }
    st.calls.push({ chatId, fresh: !o.chatId, content: o.content, agentId: o.agentId });
    return { text: 'réponse', usage: {}, toolCalls: [] };
  };
  return { st, stream };
}

test('/btw : conversation trop chargée → neuve ; réutilisée → « question indépendante »', async () => {
  const S = baseS();
  const f = fakeChat();
  const pct = { 'btw-old': 35, 'btw-ok': 5 };
  cfg.btwChat = { id: 'btw-old' };
  await extraCommand('/btw', 'c\'est quoi un closure ?', envOf(S, { stream: f.stream, contextPercent: async id => pct[id] ?? null }));
  assert.equal(f.st.calls[0].fresh, true, 'au-delà de 20 % : nouvelle conversation');
  assert.equal(cfg.btwChat.id, 'neuve-1');

  cfg.btwChat = { id: 'btw-ok' };
  await extraCommand('/btw', 'et un hoisting ?', envOf(S, { stream: f.stream, contextPercent: async id => pct[id] ?? null }));
  assert.equal(f.st.calls[1].chatId, 'btw-ok');
  assert.match(f.st.calls[1].content, /^\(Question indépendante des précédentes\.\)/);

  cfg.dailyLimitHitAt = Date.now();                                   // limite des 50 atteinte : on garde la conversation, même chargée
  cfg.btwChat = { id: 'btw-old' };
  await extraCommand('/btw', 'encore ?', envOf(S, { stream: f.stream, contextPercent: async id => pct[id] ?? null }));
  assert.equal(f.st.calls[2].chatId, 'btw-old');
  cfg.dailyLimitHitAt = 0; cfg.btwChat = null;
});

test('/compare : les conversations du duel trop chargées sont remplacées, les autres gardées', async () => {
  const S = baseS({ slots: { duelA: 'dA', duelB: 'dB' } });
  const f = fakeChat();
  await extraCommand('/compare', 'quel tri choisir ?', envOf(S, { stream: f.stream, contextPercent: async id => ({ dA: 50, dB: 3 })[id] ?? null }));
  const byAgent = Object.fromEntries(f.st.calls.map(x => [x.agentId, x]));
  assert.equal(byAgent[-2003].fresh, true); assert.equal(byAgent[-1001].chatId, 'dB');
  assert.notEqual(S.slots.duelA, 'dA'); assert.equal(S.slots.duelB, 'dB');
});

// ── /team : contexte du projet pour les agents ──
function fakeTeam({ usageIn = 600, summary = 'RÉSUMÉ-TEST' } = {}) {
  const st = { calls: [], created: [], seq: 0 };
  const lastFiles = new Map();
  const stream = async o => {
    let chatId = o.chatId;
    if (!chatId) { chatId = `chat-${++st.seq}`; st.created.push(chatId); o.onChat?.(chatId); }
    st.calls.push({ chatId, content: o.content, results: !!o.toolResults, fresh: !o.chatId });
    const usage = { promptTokenCount: usageIn, candidatesTokenCount: 50 };
    if (/^Résume cette session/.test(o.content || '')) return { text: summary, usage, toolCalls: [] };
    if (o.toolResults) return { text: 'fait', usage, toolCalls: [] };
    const m = /Crée ou modifie uniquement : ([^\n]+?)\. Écris/.exec(o.content || '');
    const files = m ? m[1].split(/,\s*/) : [];
    lastFiles.set(chatId, files);
    return { text: '', usage, toolCalls: files.map((f, i) => ({ callId: `c${st.calls.length}-${i}`, name: 'write_file', arguments: { path: f, content: `x ${f}\n` } })) };
  };
  return { st, stream };
}
const TASK = 'un site avec index.html, style.css et script.js';
const firsts = st => st.calls.filter(c => !c.results && !/^Résume cette session/.test(c.content));

test('/team --pool : chaque conversation neuve reçoit FSCLI.md, préprompt, notes et préférences, une seule fois ; jamais l\'index des skills', async () => {
  cfg.maxParallel = 3;
  const S = baseS();
  fs.writeFileSync(path.join(S.cwd, 'FSCLI.md'), 'Règle du projet : ne modifie pas dist/.\n');
  const f = fakeTeam();
  await runTeam(envOf(S, { stream: f.stream, contextPercent: async () => null }), TASK, { mode: 'pool' });
  const fr = firsts(f.st);
  assert.equal(fr.length, 3);
  for (const c of fr) {
    assert.match(c.content, /^\[abcd·w[0-2]\] Écris /, 'la consigne d\'abord (titre de la conversation)');
    assert.match(c.content, /ne modifie pas dist\//);
    assert.ok(c.content.includes(workPreferences().text));
    assert.doesNotMatch(c.content, /skills? disponibles|index des skills|fs-mcp|outils? MCP|\bagents?\b|équipe/i);
  }
  for (const k of ['w0', 'w1', 'w2']) assert.equal(S.slotTokens[S.slots[k]], 600, 'taille de la dernière requête mémorisée, par conversation');
  const n = f.st.calls.length;
  await runTeam(envOf(S, { stream: f.stream, contextPercent: async () => null }), TASK, { mode: 'pool' });
  const second = firsts({ calls: f.st.calls.slice(n) });
  assert.equal(second.length, 3);
  for (const c of second) assert.doesNotMatch(c.content, /ne modifie pas dist\//, 'conversation réutilisée : déjà son contexte');
});

test('/team --same dans une conversation neuve : contexte joint au 1er agent, puis ctxSent et préférences notés', async () => {
  const S = baseS({ chatId: null, ctxSent: false, toolsHintSig: '' });
  fs.writeFileSync(path.join(S.cwd, 'FSCLI.md'), 'Toujours en français.\n');
  const f = fakeTeam();
  await runTeam(envOf(S, { stream: f.stream, contextPercent: async () => null }), TASK, { mode: 'same' });
  const fr = firsts(f.st);
  assert.match(fr[0].content, /Toujours en français/);
  assert.ok(fr.slice(1).every(c => !/Toujours en français/.test(c.content)), 'une seule fois');
  assert.equal(S.ctxSent, true); assert.equal(S.toolsHintSig, workPreferences().sig);
  assert.equal(workerContext(S, S, { sameChat: true }).after, '', 'plus rien à joindre');
});

test('/team --same dans la conversation courante qui a déjà son contexte : rien n\'est ajouté', async () => {
  const S = baseS();
  fs.writeFileSync(path.join(S.cwd, 'FSCLI.md'), 'Règle X.\n');
  const f = fakeTeam();
  await runTeam(envOf(S, { stream: f.stream, contextPercent: async () => null }), TASK, { mode: 'same' });
  assert.ok(firsts(f.st).every(c => !/Règle X/.test(c.content)));
});

// ── /team --pool : remise à zéro en tokens ──
test('/team --pool : une voie dont la dernière requête dépasse le seuil (≤ 60k) repart d\'une conversation neuve', async () => {
  cfg.maxParallel = 3;
  const S = baseS({ slots: { w0: 'old-0', w1: 'old-1', w2: 'old-2' }, slotTokens: { 'old-0': 90000, 'old-1': 1000, 'old-2': 1000 } });
  const f = fakeTeam();
  await runTeam(envOf(S, { stream: f.stream, contextPercent: async () => 10 }), TASK, { mode: 'pool' });
  assert.equal(f.st.created.length, 1);
  assert.notEqual(S.slots.w0, 'old-0'); assert.equal(S.slots.w1, 'old-1'); assert.equal(S.slots.w2, 'old-2');

  const S2 = baseS({ slots: { w0: 'o0' }, ctxWindows: { '-2003': 1000000 } });   // fenêtre connue : 10 % de 1M = 100k ≥ 60k
  const g = fakeTeam();
  cfg.maxParallel = 1;
  await runTeam(envOf(S2, { stream: g.stream, contextPercent: async () => 10 }), TASK, { mode: 'pool' });
  assert.notEqual(S2.slots.w0, 'o0');

  const S3 = baseS({ slots: { w0: 'o0' }, slotTokens: { o0: 90000 } });
  const h = fakeTeam();
  cfg.dailyLimitHitAt = Date.now();                                   // limite des 50 atteinte : on garde la voie
  await runTeam(envOf(S3, { stream: h.stream, contextPercent: async () => 10 }), TASK, { mode: 'pool' });
  assert.equal(S3.slots.w0, 'o0');
  cfg.dailyLimitHitAt = 0; cfg.maxParallel = 3;
});

test('/team --pool après /resume ou /new : la taille mémorisée d\'une AUTRE conversation n\'est jamais appliquée à w0', async () => {
  cfg.maxParallel = 1;
  // session A : sa voie w0 finit lourde (70k par requête)
  const S = baseS();
  const a = fakeTeam({ usageIn: 70000 });
  await runTeam(envOf(S, { stream: a.stream, contextPercent: async () => 10 }), TASK, { mode: 'pool' });
  const aId = S.slots.w0;
  assert.ok(aId); assert.equal(S.slotTokens[aId], 70000);
  // puis /resume de la session B (applySession remplace S.slots), dont w0 est une conversation légère « b-0 »
  S.slots = { w0: 'b-0' };
  const f = fakeTeam();
  await runTeam(envOf(S, { stream: f.stream, contextPercent: async () => 10 }), TASK, { mode: 'pool' });
  assert.equal(f.st.created.length, 0, 'aucune conversation ouverte pour rien');
  assert.equal(S.slots.w0, 'b-0');
  assert.equal(S.slotTokens['b-0'], 600);
  assert.equal(S.slotTokens[aId], 70000, 'la taille de A reste pour A (reprise de A plus tard)');

  // et la voie lourde de B, elle, est bien repérée par sa propre taille
  const S2 = baseS({ slots: { w0: 'b-0' }, slotTokens: { 'a-0': 1000, 'b-0': 90000 } });
  const g = fakeTeam();
  await runTeam(envOf(S2, { stream: g.stream, contextPercent: async () => 10 }), TASK, { mode: 'pool' });
  assert.notEqual(S2.slots.w0, 'b-0');
  assert.equal(S2.slotTokens['b-0'], undefined);
  cfg.maxParallel = 3;
});

// ── résumé automatique : entre deux agents de /team --same, et pendant une longue demande ──
test('/team --same : conversation trop lourde → résumée entre deux agents, le résumé part avec l\'agent suivant', async () => {
  cfg.autoCompact = true;
  const S = baseS({ lastPromptTokens: 500000 });
  const f = fakeTeam({ summary: 'RÉSUMÉ-TEST' });
  await runTeam(envOf(S, { stream: f.stream, contextPercent: async () => null }), TASK, { mode: 'same' });
  assert.ok(f.st.calls.some(c => /^Résume cette session/.test(c.content) && c.chatId === 'main-1'), 'résumé demandé dans la conversation lourde');
  const fr = firsts(f.st);
  assert.match(fr[0].content, /\[Reprise : résumé[\s\S]*RÉSUMÉ-TEST[\s\S]*Écris /);
  assert.equal(fr[0].fresh, true);
  assert.equal(S.pendingSummary, null); assert.equal(S.ctxSent, true);
  assert.ok(fr.slice(1).every(c => !/RÉSUMÉ-TEST/.test(c.content)));
});

test('/team --same : résumé fait mais limite des 50 atteinte à l\'ouverture → on reste dans la conversation d\'avant', async () => {
  cfg.autoCompact = true;
  const S = baseS({ lastPromptTokens: 500000 });
  const f = fakeTeam();
  const stream = async o => { if (!o.chatId) throw Object.assign(new Error('limite des 50'), { code: 'DAILY_CHAT_LIMIT' }); return f.stream(o); };
  await runTeam(envOf(S, { stream, contextPercent: async () => null }), TASK, { mode: 'same' });
  assert.equal(S.chatId, 'main-1');
  assert.ok(firsts(f.st).length >= 1 && firsts(f.st).every(c => c.chatId === 'main-1'));
});

test('longue demande : au-delà de 1,5 × le seuil, le modèle est invité à finir l\'étape puis s\'arrêter ; résumé au message suivant', async () => {
  cfg.autoCompact = true;
  const S = baseS({ interactive: true });                              // session interactive (terminal ou panneau)
  let n = 0; const seen = [];
  const stream = async o => {
    seen.push(o); n++;
    if (n <= 2) return { text: '', usage: { promptTokenCount: 200000 }, toolCalls: [{ callId: `c${n}`, name: 'write_file', arguments: { path: `f${n}.txt`, content: 'x\n' } }] };
    return { text: 'Point d\'étape : f1 et f2 faits.', usage: { promptTokenCount: 200000 }, toolCalls: [] };
  };
  await runNative(S, 'grosse tâche', { signal: new AbortController().signal, ask: async () => 'o', stream, ctxPct: async () => null, bare: 'grosse tâche' });
  const withNote = seen.filter(o => o.toolResults?.some(r => r.output.includes(HEAVY_NOTE)));
  assert.equal(withNote.length, 1, 'une seule fois');
  assert.equal(S.needCompact, 'main-1');
  assert.ok(fs.existsSync(path.join(S.cwd, 'f2.txt')), 'la tâche n\'est pas coupée : les appels en cours sont exécutés');

  const f = fakeTeam({ summary: 'résumé de la grosse tâche' });
  S.lastPromptTokens = 0;                                             // même sans la taille : la demande arrêtée suffit
  await maybeAutoCompact(S, new AbortController().signal, { stream: f.stream });
  assert.equal(S.chatId, null); assert.match(S.pendingSummary, /grosse tâche/); assert.equal(S.needCompact, null);
});

test('longue demande : rien pour les agents de /team ni le serveur MCP (pas de « bare »), ni quand la limite des 50 est atteinte', async () => {
  cfg.autoCompact = true;
  const run = async (S, opts) => {
    const seen = []; let n = 0;
    const stream = async o => { seen.push(o); n++; return n === 1 ? { text: '', usage: { promptTokenCount: 300000 }, toolCalls: [{ callId: 'c', name: 'read_file', arguments: { path: 'nope.txt' } }] } : { text: 'ok', usage: {}, toolCalls: [] }; };
    await runNative(S, 'tâche', { signal: new AbortController().signal, ask: async () => 'o', stream, ctxPct: async () => null, ...opts });
    return seen.some(o => o.toolResults?.some(r => r.output.includes(HEAVY_NOTE)));
  };
  const I = over => baseS({ interactive: true, ...over });
  assert.equal(await run(I(), { bare: 'x' }), true, 'témoin : session interactive');
  assert.equal(await run(I(), {}), false, 'serveur MCP');
  assert.equal(await run(I({ tagRole: 'w0' }), { bare: 'x' }), false, 'agent de /team');
  cfg.dailyLimitHitAt = Date.now();
  assert.equal(await run(I(), { bare: 'x' }), false, 'limite atteinte : aucun résumé possible');
  cfg.dailyLimitHitAt = 0;
  cfg.autoCompact = false;
  assert.equal(await run(I(), { bare: 'x' }), false, '/autocompact off');
  cfg.autoCompact = true;
});

test('longue demande en mode -p / stdin (pas interactif) : jamais de note d\'arrêt, la tâche va jusqu\'au bout', async () => {
  cfg.autoCompact = true;
  const run = async (S, opts) => {
    const seen = []; let n = 0;
    const stream = async o => {
      seen.push(o); n++;
      if (n <= 3) return { text: '', usage: { promptTokenCount: 400000 }, toolCalls: [{ callId: `c${n}`, name: 'write_file', arguments: { path: `g${n}.txt`, content: 'x\n' } }] };
      return { text: 'fini', usage: { promptTokenCount: 400000 }, toolCalls: [] };
    };
    await runNative(S, 'tâche', { signal: new AbortController().signal, ask: async () => 'o', stream, ctxPct: async () => null, ...opts });
    return { note: seen.some(o => o.toolResults?.some(r => r.output.includes(HEAVY_NOTE))), S };
  };
  for (const S of [baseS(), baseS({ interactive: false })]) {          // cli.js -p : S.interactive absent ou faux
    const r = await run(S, { bare: 'tâche' });
    assert.equal(r.note, false, 'pas de HEAVY_NOTE en mode -p');
    assert.equal(S.needCompact ?? null, null);
    assert.ok(fs.existsSync(path.join(S.cwd, 'g3.txt')), 'toutes les étapes faites');
  }
  assert.equal((await run(baseS(), { bare: 'tâche', midCompact: true })).note, true, 'activable explicitement');
  assert.equal((await run(baseS({ interactive: true }), { bare: 'tâche', midCompact: false })).note, false, 'désactivable explicitement');
});

// ── MCP de FS-CLI ──
test('le serveur MCP de FS-CLI (« france-student ») n\'est jamais réimporté ni proposé au modèle', () => {
  const cli = path.join('C:', 'outils', 'fs-cli', 'cli.js');
  fs.writeFileSync(path.join(importHome, '.claude.json'), JSON.stringify({ mcpServers: {
    'france-student': { command: 'node', args: [cli, '--mcp'] },
    'fs-perso': { command: 'node', args: ['/opt/lib/node_modules/fs-cli/cli.js', '--mcp'] },
    leboncoin: { command: 'npx', args: ['leboncoin-mcp'] },
  } }));
  const found = discoverMcpServers(tmp);
  assert.deepEqual(Object.keys(found), ['leboncoin']);
  assert.equal(isSelfMcpServer('France-Student', {}), true);
  assert.equal(isSelfMcpServer('autre', { args: ['serveur.js', '--mcp'] }), false, '« --mcp » seul ne suffit pas');
  assert.equal(isSelfMcpServer('autre', { args: [cli] }), false, 'cli.js de FS-CLI sans --mcp : pas le serveur MCP');

  const cwd = mkdir('mcp-');
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'france-student': { command: 'node', args: ['x.js'] } } }));
  assert.ok(loadMcpConfig(cwd).mcpServers['france-student'], 'toujours visible dans /mcp si tu l\'ajoutes toi-même');
  assert.deepEqual(mentionedServers(cwd, 'mon compte france student ne marche plus'), [], 'mais jamais proposé au modèle');
  assert.deepEqual(mentionedServers(cwd, 'cherche avec leboncoin'), ['leboncoin']);
});

test('/team avec GPT Astra : l\'utilisateur choisit le modèle des agents (menu) ; sans menu on garde Astra ; Échap annule ; modèle d\'agents réglé respecté', async () => {
  cfg.maxParallel = 3;
  // [modèle principal, modèle d'agents réglé, interactif, réponse au menu, modèle attendu des agents (null = équipe annulée)]
  const cases = [[-1004, null, true, 0, -2003], [-1006, null, true, 1, -2001], [-1004, null, true, 2, -1004], [-1004, null, false, undefined, -1004],
    [-1004, null, true, null, null], [-1004, -1001, true, undefined, -1001], [-2001, null, true, undefined, -2001]];
  for (const [main, worker, inter, answer, expected] of cases) {
    const S = baseS();
    S.agentId = main; S.interactive = inter;
    const before = cfg.workerModel;
    cfg.workerModel = worker;
    const f = fakeTeam();
    const ids = [], menus = [];
    const stream = o => { ids.push(o.agentId); return f.stream(o); };
    const env = { ...envOf(S, { stream, contextPercent: async () => null }), select: async o => { menus.push(o.options); return answer; } };
    try { await runTeam(env, TASK, { mode: 'pool' }); }
    finally { cfg.workerModel = before; }
    const label = `principal ${main}, agents réglés ${worker}, interactif ${inter}, réponse ${answer}`;
    if (expected === null) assert.equal(ids.length, 0, `${label} : équipe annulée`);
    else assert.deepEqual([...new Set(ids)], [expected], label);
    assert.equal(menus.length, inter && worker == null && [-1004, -1006].includes(main) ? 1 : 0, `${label} : menu`);
    if (menus.length) assert.deepEqual(menus[0], ['Claude Sonnet 5.5', 'Claude Opus 5.5', 'GPT Astra quand même']);
    assert.equal(S.agentId, main, 'ta conversation garde son modèle');
  }
});
