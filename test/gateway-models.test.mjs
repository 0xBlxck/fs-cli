// Passerelle Claude Code : modèles (src/gateway/models.js, spécification § 3.10). Hors ligne : faux France Student injecté.
import { tmpHome, fakeFs, DEFAULT_AGENTS } from './gateway-helpers.mjs';   // pose FS_CLI_HOME avant tout import de src/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { normalizeModel, createModels, ccModelId, slug } = await import('../src/gateway/models.js');

const MIN = 60 * 1000;
const fresh = (script = {}) => {
  const fake = fakeFs(script);
  const file = path.join(tmpHome(), 'agents.json');
  return { fake, file, models: createModels(fake.deps, { file }) };
};

test('normalizeModel : minuscules, [1m], date finale et préfixes retirés', () => {
  assert.equal(normalizeModel(' Claude-Sonnet-5-5[1m] '), 'claude-sonnet-5-5');
  assert.equal(normalizeModel('claude-opus-5-5-20260101'), 'claude-opus-5-5');
  assert.equal(normalizeModel('claude-fs/gpt-6-astra'), 'gpt-6-astra');
  assert.equal(normalizeModel('claude-fs/openai/gpt-6-astra'), 'openai/gpt-6-astra');
  assert.equal(normalizeModel('anthropic/claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(normalizeModel('us.anthropic.claude-haiku-5-5-20251001'), 'claude-haiku-5-5');
  assert.equal(normalizeModel(''), '');
  assert.equal(normalizeModel(undefined), '');
  assert.equal(slug('Claude Sonnet 5.5'), 'claude-sonnet-5-5');
  assert.equal(slug('GPT Spécial 2.0'), 'gpt-special-2-0');
});

test('resolve : nom exact, namespace/modèle, nom lisible, famille, sinon null', async () => {
  const extra = { id: -1099, name: 'GPT Spécial 2.0', namespace: 'openai', model: 'gpt-x-interne', modelProvider: 'openai', isActive: true };
  const { models } = fresh({ agents: [...DEFAULT_AGENTS, extra] });
  assert.equal((await models.resolve('claude-sonnet-5-5')).agentId, -2003);
  assert.equal((await models.resolve('claude-sonnet-5-5[1m]')).agentId, -2003);
  assert.equal((await models.resolve('gpt-6-astra')).agentId, -1004);
  assert.equal((await models.resolve('claude-fs/gpt-6-astra')).agentId, -1004, 'ANTHROPIC_CUSTOM_MODEL_OPTION');
  assert.equal((await models.resolve('claude-fs/openai/gpt-6-luna')).agentId, -1002, 'id de /v1/models');
  assert.equal((await models.resolve('gpt-special-2-0')).agentId, -1099, 'slug du nom');
  assert.equal((await models.resolve('claude-opus-4-1-20250805')).agentId, -2001, 'famille opus');
  assert.equal((await models.resolve('claude-3-5-haiku-latest')).agentId, -2002, 'famille haiku');
  assert.equal((await models.resolve('claude-fable-9')).agentId, -2005, 'famille fable');
  assert.equal((await models.resolve('gpt-9')).agentId, -1004, 'famille GPT');
  assert.equal((await models.resolve('claude-fs/openai/gpt-9')).agentId, -1004, 'famille GPT derrière un namespace');
  assert.equal(await models.resolve('llama-3-70b'), null);
  assert.equal(await models.resolve(''), null);
});

test('Agent : forme exacte ; Gemini et agents NATIVE_UNSUPPORTED en texte seul ; inactifs ignorés', async () => {
  const agents = [...DEFAULT_AGENTS, { id: -2009, name: 'Claude Ancien', model: 'claude-ancien', modelProvider: 'anthropic', isActive: false },
    { id: -2010, name: 'Claude Sans Fenêtre', namespace: 'anthropic', model: 'claude-sans-fenetre', modelProvider: 'anthropic' }];
  const { models } = fresh({ agents });
  assert.deepEqual(await models.resolve('claude-sonnet-5-5'),
    { agentId: -2003, model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic', native: true, contextWindow: 200000 });
  assert.equal((await models.resolve('gemini-3-pro')).native, false);
  assert.equal((await models.resolve('gemini-3-pro')).provider, 'google');
  assert.equal((await models.resolve('claude-sans-fenetre')).contextWindow, 200000, 'fenêtre absente → 200 000');
  assert.equal(await models.fromAgentId(-2009), null, 'isActive:false ignoré');
  assert.equal((await models.list()).length, DEFAULT_AGENTS.length + 1);
  models.markNativeOff(-1004);
  assert.equal((await models.resolve('gpt-6-astra')).native, false);
  assert.equal((await models.fromAgentId(-1002)).native, true);
});

test('forClaudeCode : ids claude tels quels, les autres sous claude-fs/ ; tous passent le filtre de Claude Code et reviennent au même agent', async () => {
  const { models } = fresh();
  const r = await models.forClaudeCode();
  assert.equal(r.has_more, false);
  const ids = r.data.map(m => m.id);
  assert.ok(ids.includes('claude-sonnet-5-5'));
  assert.ok(ids.includes('claude-fs/openai/gpt-6-astra'));
  assert.ok(ids.includes('claude-fs/google/gemini-3-pro'));
  for (const m of r.data) {
    assert.match(m.id, /^(claude|anthropic)/i, 'filtre de Claude Code 2.1.207');
    assert.equal(m.type, 'model');
    assert.equal(m.created_at, '2026-01-01T00:00:00Z');
    assert.match(m.display_name, / · France Student$/);
    assert.ok(await models.resolve(m.id), `${m.id} doit se résoudre`);
  }
  for (const a of DEFAULT_AGENTS) assert.equal((await models.resolve(ccModelId(a))).agentId, a.id);
  assert.equal(await models.ccId(-1004), 'claude-fs/openai/gpt-6-astra');
  assert.equal(await models.ccId(-2001), 'claude-opus-5-5');
  assert.equal(await models.ccId(-9999), null);
});

test('cache : 10 min en mémoire, puis nouvel appel à GET /chats/agents ; appels simultanés regroupés', async () => {
  const { fake, models } = fresh();
  await Promise.all([models.list(), models.resolve('claude-opus-5-5'), models.forClaudeCode()]);
  assert.equal(fake.calls.fetchAgentsFull.length, 1);
  fake.advance(9 * MIN);
  await models.list();
  assert.equal(fake.calls.fetchAgentsFull.length, 1);
  fake.advance(2 * MIN);
  await models.list();
  assert.equal(fake.calls.fetchAgentsFull.length, 2);
});

test('hors ligne : cache disque de 24 h, puis la table de secours de FS-CLI', async () => {
  const { file, models } = fresh({ agents: [...DEFAULT_AGENTS, { id: -1077, name: 'O9 Disque', namespace: 'openai', model: 'o9-disque', modelProvider: 'openai' }] });
  await models.list();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(disk.agents) && Number.isFinite(disk.at), 'agents.json écrit');

  const off = fakeFs({ agents: null });                               // GET /chats/agents indisponible
  const m2 = createModels(off.deps, { file });
  assert.equal((await m2.resolve('o9-disque')).agentId, -1077, 'repris du disque');

  const late = fakeFs({ agents: null });
  late.advance(25 * 60 * MIN);
  const m3 = createModels(late.deps, { file });
  assert.equal(await m3.resolve('o9-disque'), null, 'disque trop vieux (> 24 h)');
  assert.equal((await m3.resolve('claude-sonnet-5-5')).agentId, -2003, 'table de secours');
  assert.equal((await m3.resolve('gpt-6-luna')).provider, 'openai');

  const broken = { ...fakeFs().deps, fetchAgentsFull: async () => { throw new Error('réseau'); } };
  const m4 = createModels(broken, { file: path.join(tmpHome(), 'agents.json') });
  assert.equal((await m4.resolve('claude-haiku-5-5')).agentId, -2002, 'exception → table de secours');
});

test('réponse { data } ou { agents } acceptée ; resolveMain retombe sur l\'agent par défaut', async () => {
  const fake = fakeFs();
  const deps = { ...fake.deps, fetchAgentsFull: async () => ({ data: structuredClone(DEFAULT_AGENTS) }) };
  const models = createModels(deps, { file: path.join(tmpHome(), 'agents.json') });
  assert.equal((await models.resolve('gpt-6-astra')).agentId, -1004);
  const deps2 = { ...fake.deps, fetchAgentsFull: async () => ({ agents: structuredClone(DEFAULT_AGENTS) }) };
  assert.equal((await createModels(deps2, { file: path.join(tmpHome(), 'agents.json') }).resolve('gpt-6-luna')).agentId, -1002);
  assert.deepEqual(await models.resolveMain('modele-inconnu', -2001).then(r => [r.agent.agentId, r.unknown]), [-2001, true]);
  assert.deepEqual(await models.resolveMain('claude-haiku-5-5', -2001).then(r => [r.agent.agentId, r.unknown]), [-2002, false]);
});
