// Vue « Agents » du panneau : /team émet des événements structurés (teamStart, agentStart, agentUpdate, agentDone, teamDone)
// avec un FAUX France Student qui répond par des appels d'outils officiels — aucun appel réel.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-agents-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const ui = await import('../src/ui.js');
const { runTeam, tokensOf, OUTPUT_CAP } = await import('../src/team.js');
const { detectEnv } = await import('../src/tools.js');
const { cfg } = await import('../src/config.js');
await detectEnv();
cfg.mode = 'auto';

const TASK = 'un site avec index.html, style.css et script.js';
const AGENT_EV = new Set(['teamStart', 'agentStart', 'agentUpdate', 'agentDone', 'teamDone']);

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

async function run(mode, { agentMap = false, sink = true, ...fake } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'w-'));
  const S = { chatId: 'main-1', slots: {}, sid: 'abcd', agentId: -2003, cwd: dir, targetDir: null, undo: [], allow: {}, pendingResults: [], notes: [], tokens: { in: 0, out: 0 } };
  const env = { S, modelName: () => 'Modèle test', ask: async () => 'o', withAbort: fn => fn(new AbortController().signal), stream: fakeServer(fake).stream, fetchChat: async () => null, contextPercent: async () => null, agentMap };
  const events = [], prints = [];
  if (sink) ui.attachSink({ print: t => prints.push(String(t)), spinner: () => {}, event: (type, data) => events.push({ type, ...data }) });
  try { await runTeam(env, TASK, { mode }); } finally { ui.attachSink(null); }
  return { events, agentEvents: events.filter(e => AGENT_EV.has(e.type)), prints, dir };
}

/** vérifications communes : champs présents, une équipe, chaque agent démarre puis finit, teamDone en dernier */
function checkShape(evs, mode) {
  const team = evs[0];
  assert.equal(team.type, 'teamStart');
  assert.equal(team.mode, mode); assert.equal(team.count, 3); assert.equal(team.model, 'Modèle test');
  assert.deepEqual(team.agents.map(a => a.name), ['index.html', 'style.css', 'script.js']);
  assert.ok(team.agents.every(a => a.id && a.task && Array.isArray(a.files)));
  assert.ok(evs.every(e => e.team === team.team), 'tous les événements portent l\'id de l\'équipe');
  assert.equal(evs.at(-1).type, 'teamDone');
  assert.equal(evs.filter(e => e.type === 'teamDone').length, 1);
  const td = evs.at(-1);
  assert.equal(td.count, 3); assert.equal(td.ok, 3); assert.ok(td.durationMs >= 0); assert.ok(!td.aborted);
  for (const a of team.agents) {
    const mine = evs.filter(e => e.id === a.id);
    const types = mine.map(e => e.type);
    assert.equal(types[0], 'agentStart', `${a.name} : agentStart d'abord`);
    assert.equal(types.at(-1), 'agentDone', `${a.name} : agentDone en dernier`);
    assert.deepEqual(types.slice(1, -1).filter(t => t !== 'agentUpdate'), [], 'entre les deux : seulement des agentUpdate');
    const st = mine[0];
    assert.equal(st.name, a.name); assert.equal(st.task, a.task); assert.equal(st.model, 'Modèle test'); assert.equal(st.mode, mode);
    assert.equal(st.slot, mode === 'same' ? 'main' : st.slot); if (mode === 'pool') assert.match(st.slot, /^w[0-2]$/);
    const up = mine.filter(e => e.type === 'agentUpdate').at(-1);
    assert.equal(up.status, 'done'); assert.ok(up.durationMs >= 0); assert.ok(up.tokens > 1000);
    const done = mine.at(-1);
    assert.equal(done.ok, true); assert.match(done.summary, new RegExp(`1 fichier : ${a.name.replace('.', '\\.')}`));
    assert.match(done.output, new RegExp('contenu de ' + a.name.replace('.', '\\.')));
    assert.deepEqual(done.files, [a.name]); assert.equal(done.tokens, up.tokens);
  }
}

test('mode same : événements dans l\'ordre, un agent après l\'autre', async () => {
  const { agentEvents: evs, dir } = await run('same');
  checkShape(evs, 'same');
  const seq = evs.filter(e => e.type === 'agentStart' || e.type === 'agentDone').map(e => `${e.type}:${e.id.split('-').pop()}`);
  assert.deepEqual(seq, ['agentStart:1', 'agentDone:1', 'agentStart:2', 'agentDone:2', 'agentStart:3', 'agentDone:3']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['index.html', 'script.js', 'style.css'], 'les fichiers sont toujours écrits');
});

test('mode pool : les 3 agents démarrent avant le premier fini, chacun dans sa conversation w0/w1/w2', async () => {
  cfg.maxParallel = 3;
  const { agentEvents: evs } = await run('pool', { delay: 900 });
  checkShape(evs, 'pool');
  const firstDone = evs.findIndex(e => e.type === 'agentDone');
  assert.equal(evs.slice(0, firstDone).filter(e => e.type === 'agentStart').length, 3, 'en parallèle');
  assert.deepEqual(evs.filter(e => e.type === 'agentStart').map(e => e.slot).sort(), ['w0', 'w1', 'w2']);
  assert.equal(evs[0].parallel, 3);
});

test('agent en échec : agentUpdate « error », agentDone ok=false avec le message, teamDone le compte', async () => {
  const { agentEvents: evs } = await run('same', { fail: 'style.css' });
  const team = evs[0];
  const id = team.agents.find(a => a.name === 'style.css').id;
  const done = evs.find(e => e.type === 'agentDone' && e.id === id);
  assert.equal(done.ok, false); assert.match(done.summary, /erreur 500/); assert.deepEqual(done.files, []);
  assert.equal(evs.filter(e => e.id === id && e.type === 'agentUpdate').at(-1).status, 'error');
  assert.equal(evs.at(-1).ok, 2);
});

test('sortie plafonnée (~20 Ko) dans agentDone', async () => {
  const { agentEvents: evs } = await run('same', { big: '\n' + 'x'.repeat(OUTPUT_CAP * 2) });
  const done = evs.find(e => e.type === 'agentDone' && e.output.startsWith('contenu de index.html'));
  assert.ok(done.output.length <= OUTPUT_CAP + 40, 'plafonnée');
  assert.match(done.output, /tronquée/);
});

test('panneau avec la vue « Agents » : la liste en texte disparaît ; panneau ancien : elle reste', async () => {
  const withMap = await run('same', { agentMap: true });
  const old = await run('same', { agentMap: false });
  const txt = p => p.join('').replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(withMap.agentEvents.length && old.agentEvents.length, 'les événements sont émis dans les deux cas');
  assert.doesNotMatch(txt(withMap.prints), /▸ index\.html/);
  assert.ok(!withMap.events.some(e => e.type === 'tool' && e.name === 'équipe'), 'pas de bloc « équipe » en double');
  assert.match(txt(old.prints), /▸ index\.html/);
  assert.match(txt(old.prints), /✓ index\.html/);
});

test('sans sink à événements (terminal) : aucun événement, rien ne casse', async () => {
  const { dir, events } = await run('same', { sink: false });
  assert.deepEqual(events, []);
  assert.equal(ui.hasEvents(), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['index.html', 'script.js', 'style.css']);
});

test('panneau : chaque événement d\'équipe est traité, l\'extension annonce la vue « Agents »', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const panel = fs.readFileSync(path.join(root, 'vscode/media/panel.js'), 'utf8');
  for (const t of AGENT_EV) assert.ok(panel.includes(`case '${t}'`), `le panneau ne traite pas « ${t} »`);
  assert.match(fs.readFileSync(path.join(root, 'vscode/extension.js'), 'utf8'), /FS_CLI_PANEL_FEATURES: 'agents'/);
  assert.match(fs.readFileSync(path.join(root, 'cli.js'), 'utf8'), /PANEL_FEATURES\.has\('agents'\) \? \{ agentMap: true \}/);
});

test('tokensOf : total, ou somme prompt + réponse, sinon null', () => {
  assert.equal(tokensOf({ totalTokenCount: 42 }), 42);
  assert.equal(tokensOf({ promptTokenCount: 10, candidatesTokenCount: 5 }), 15);
  assert.equal(tokensOf(null), null); assert.equal(tokensOf({}), null);
});
