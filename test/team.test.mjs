// /team : une seule conversation (mode same) ou conversations réutilisées (mode pool) — avec un FAUX France Student qui répond par des
// appels d'outils officiels (aucune conversation réelle créée)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-team-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { runTeam } = await import('../src/team.js');
const { detectEnv } = await import('../src/tools.js');
const { cfg } = await import('../src/config.js');
const { tag, lastReset, createdToday, register, newSid } = await import('../src/chats.js');
const { parseDailyLimit } = await import('../src/api.js');
await detectEnv();
cfg.mode = 'auto';

/** faux France Student pour /team : outils officiels. 1re requête d'une part → appel write_file pour chaque fichier demandé ;
 *  résultats d'outils → texte final ; relecture → « Tout est cohérent. ». Mesure la concurrence et les créations. */
function fakeServer({ delay = 25, big = '', fail = '' } = {}) {
  const st = { calls: [], created: [], active: 0, maxActive: 0, seq: 0 };
  const lastFiles = new Map();
  const stream = async (o) => {
    st.active++; st.maxActive = Math.max(st.maxActive, st.active);
    try {
      let chatId = o.chatId;
      if (!chatId) { chatId = `chat-${++st.seq}`; st.created.push(chatId); o.onChat?.(chatId); }
      st.calls.push({ chatId, agentId: o.agentId, content: o.content, results: !!o.toolResults, fresh: !o.chatId, tools: o.clientTools });
      await new Promise(r => setTimeout(r, delay));
      const usage = { promptTokenCount: 600, candidatesTokenCount: 500 };
      if (o.toolResults) {
        const files = lastFiles.get(chatId) || [];
        const text = `contenu de ${files.join(', ')} écrit` + (files.includes('index.html') ? big : '');
        o.onText?.(text);
        return { text, usage, toolCalls: [] };
      }
      if (/^(?:\[[^\]]+\]\s*)?Relis /.test(o.content || '')) { o.onText?.('Tout est cohérent.'); return { text: 'Tout est cohérent.', usage, toolCalls: [] }; }
      const m = /Crée ou modifie uniquement : ([^\n]+?)\. Écris/.exec(o.content || '');
      const files = m ? m[1].split(/,\s*/) : [];
      if (fail && files.includes(fail)) throw new Error('erreur 500 du serveur');
      lastFiles.set(chatId, files);
      return { text: '', usage, toolCalls: files.map((f, i) => ({ callId: `c${st.calls.length}-${i}`, name: 'write_file', arguments: { path: f, content: `contenu de ${f}\n` } })) };
    } finally { st.active--; }
  };
  return { st, stream };
}

function setup(over = {}, delay = 25) {
  const dir = fs.mkdtempSync(path.join(tmp, 'w-'));
  const srv = fakeServer({ delay });
  const S = { chatId: 'main-1', slots: {}, sid: 'abcd', agentId: -2003, cwd: dir, targetDir: null, undo: [], allow: {}, pendingResults: [], notes: [], tokens: { in: 0, out: 0 }, ...over };
  const pct = {};
  const env = { S, modelName: () => 'Modèle', ask: async () => 'o', withAbort: fn => fn(new AbortController().signal), stream: srv.stream, contextPercent: async id => pct[id] ?? null };
  return { dir, srv, S, env, pct };
}
const TASK = 'un site avec index.html, style.css et script.js';
const ls = d => fs.readdirSync(d).sort();
const firsts = st => st.calls.filter(c => !c.results);                  // 1re requête de chaque part (pas les renvois de résultats d'outils)

test('les consignes sont des demandes normales : outils officiels, aucun « agent », « équipe » ni format de blocs imposé', async () => {
  const { srv, env } = setup();
  await runTeam(env, TASK, { mode: 'same' });
  for (const c of firsts(srv.st)) {
    assert.doesNotMatch(c.content, /\bagents?\b|équipe|tu es |bloc de code|```/i, c.content);
    assert.ok(Array.isArray(c.tools) && c.tools.includes('write_file'), 'outils client officiels envoyés');
  }
});

test('mode same : chaque part est faite DANS la conversation courante, à la suite, sans rien créer', async () => {
  const { dir, srv, S, env } = setup();
  await runTeam(env, TASK, { mode: 'same' });
  assert.equal(srv.st.created.length, 0, 'aucune conversation créée');
  assert.equal(firsts(srv.st).length, 3); assert.ok(srv.st.calls.every(c => c.chatId === 'main-1'));
  assert.equal(srv.st.maxActive, 1, 'à la suite (jamais en parallèle)');
  assert.deepEqual(ls(dir), ['index.html', 'script.js', 'style.css']);
  assert.match(firsts(srv.st)[1].content, /juste avant ou juste après/);
  assert.deepEqual(S.slots, {});
  assert.equal(S.undo.length, 3, '/changes et /rewind voient les 3 fichiers');
  assert.match(S.turnMarks.at(-1).text, /^\/team /);
});

test('mode same sans conversation : la 1re part la crée (étiquetée), les autres la réutilisent', async () => {
  const { srv, S, env } = setup({ chatId: null });
  await runTeam(env, TASK, { mode: 'same' });
  assert.equal(srv.st.created.length, 1); assert.equal(S.chatId, 'chat-1');
  assert.ok(srv.st.calls[0].content.startsWith('[abcd] '), 'étiquette [id] en tête du 1er message');
  assert.ok(srv.st.calls.slice(1).every(c => c.chatId === 'chat-1' && !c.fresh));
});

test('mode pool : 3 conversations en parallèle, étiquetées, puis RÉUTILISÉES à l\'équipe suivante', async () => {
  cfg.maxParallel = 3;
  const { dir, srv, S, env } = setup({}, 600);
  await runTeam(env, TASK, { mode: 'pool' });
  assert.equal(srv.st.created.length, 3); assert.ok(srv.st.maxActive >= 2, 'en parallèle');
  assert.deepEqual(Object.keys(S.slots).sort(), ['w0', 'w1', 'w2']);
  assert.ok(firsts(srv.st).every(c => /^\[abcd·w[0-2]\] /.test(c.content)), 'titres « [abcd·w0] … »');
  assert.deepEqual(ls(dir), ['index.html', 'script.js', 'style.css']);
  assert.equal(S.undo.length, 3, 'le travail des agents est rattaché à la session (/changes, /rewind)');
  assert.match(S.notes.at(-1), /index\.html/);

  const before = srv.st.created.length;
  for (const f of ls(dir)) fs.rmSync(path.join(dir, f));
  await runTeam(env, TASK, { mode: 'pool' });
  assert.equal(srv.st.created.length, before, 'aucune nouvelle conversation à la 2e équipe');
  const second = firsts(srv.st).slice(3);
  assert.equal(second.length, 3); assert.ok(second.every(c => !c.fresh && /Nouvelle tâche, indépendante/.test(c.content)));
});

test('mode pool : une conversation trop pleine (≥ 70 %) est remplacée, les autres sont gardées', async () => {
  cfg.maxParallel = 3;
  const { dir, srv, S, env, pct } = setup({ slots: { w0: 'old-0', w1: 'old-1', w2: 'old-2' } });
  pct['old-1'] = 82;
  await runTeam(env, TASK, { mode: 'pool' });
  assert.equal(srv.st.created.length, 1, 'une seule création');
  assert.equal(S.slots.w0, 'old-0'); assert.equal(S.slots.w2, 'old-2'); assert.notEqual(S.slots.w1, 'old-1');
  assert.deepEqual(ls(dir), ['index.html', 'script.js', 'style.css']);
});

test('--review : relecture dans la conversation courante, avec les outils, sans création', async () => {
  const { srv, env } = setup();
  await runTeam(env, TASK, { mode: 'same', review: true });
  assert.equal(srv.st.created.length, 0);
  const rv = firsts(srv.st).at(-1);
  assert.match(rv.content, /^Relis index\.html, style\.css, script\.js/); assert.equal(rv.chatId, 'main-1');
});

test('dossier cible : les fichiers y sont écrits, pas dans le dossier courant', async () => {
  const target = fs.mkdtempSync(path.join(tmp, 'cible-'));
  const { dir, env, S } = setup(); S.targetDir = target;
  await runTeam(env, TASK, { mode: 'same' });
  assert.deepEqual(ls(target), ['index.html', 'script.js', 'style.css']); assert.deepEqual(ls(dir), []);
});

test('étiquettes et remise à zéro quotidienne', () => {
  assert.equal(tag('7f3a'), '[7f3a] '); assert.equal(tag('7f3a', 'css'), '[7f3a·css] ');
  const at = Date.UTC(2026, 10, 15, 13, 0); assert.equal(lastReset(at), Date.UTC(2026, 10, 15, 4, 0));
  const early = Date.UTC(2026, 10, 15, 3, 30); assert.equal(lastReset(early), Date.UTC(2026, 10, 14, 4, 0));
  assert.match(newSid(), /^[0-9a-f]{4}$/);
});

test('registre : compte les conversations créées depuis la remise à zéro', () => {
  const before = createdToday();
  register('x1', { sid: 'zzzz', role: 'main' }); register('x2', { sid: 'zzzz', role: 'w0' }); register('x2', { sid: 'zzzz', role: 'w0' });
  assert.equal(createdToday(), before + 2, 'x2 enregistrée une seule fois');
});

test('limite quotidienne de FS : message clair, pas de nouvel essai', () => {
  const body = JSON.stringify({ status: 429, error: 'Too Many Requests', message: 'Daily new chat limit reached (50 per day). Reset at 2026-11-16T03:59:59.999259305Z.' });
  const e = parseDailyLimit(body);
  assert.equal(e.code, 'DAILY_CHAT_LIMIT'); assert.equal(e.retry, false);
  assert.match(e.message, /50 nouvelles conversations par jour/); assert.match(e.message, /conversation existante/);
  assert.equal(parseDailyLimit('{"message":"autre erreur"}'), null);
});
