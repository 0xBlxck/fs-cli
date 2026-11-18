// Passerelle Claude Code : refus GPT, récapitulatif, quota et erreurs (src/gateway/recover.js, spécification § 3.12).
import { tmpHome, fsError, FAKE_NOW } from './gateway-helpers.mjs';   // pose FS_CLI_HOME avant tout import de src/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const R = await import('../src/gateway/recover.js');
const { localTime } = await import('../src/chats.js');

// mêmes motifs que outbound.assertClean (I1) : rien de propre à Claude Code dans un texte envoyé à France Student
const LEAKS = [/<system-reminder/, /<command-/, /<tool_use_error/, /You are Claude Code/, /x-anthropic-billing-header/,
  /\b(TodoWrite|NotebookEdit|WebFetch|SendMessage|ExitPlanMode)\b/, /`(Read|Edit|Write|Bash|Grep|Glob|Agent|Task|Skill)`/];
const CC_NAMES = /\b(Read|Edit|MultiEdit|Write|Bash|PowerShell|Grep|Glob|TodoWrite|Task)\b/;

const user = (text, results = []) => ({ role: 'user', text, results, images: [], notes: [], interrupted: false, marker: null, isContinuation: false, claudeMd: null });
const asst = (text, toolUses = []) => ({ role: 'assistant', text, toolUses });

test('isRefusal : refus des outils au début de la réponse seulement', () => {
  assert.equal(R.isRefusal('Je ne peux pas accéder à tes fichiers depuis ici, désolé.'), true);
  assert.equal(R.isRefusal('Colle ici le contenu de calc.js et je le corrige.'), true);
  assert.equal(R.isRefusal('Je ne peux pas servir de moteur à ton outil externe.'), true);
  assert.equal(R.isRefusal('Voici le contenu de hello.txt : « contenu de test ».'), false);
  assert.equal(R.isRefusal('x'.repeat(420) + ' Je ne peux pas accéder à tes fichiers.'), false, 'au-delà de 400 caractères : pas un refus');
  assert.equal(R.isRefusal(''), false);
  assert.match(R.CLARIFY, /outils client officiels de France Student/);
});

test('nextRefusalStep : bare au 1er tour, sinon clarify, puis switch, puis give_up', () => {
  const gpt = { provider: 'openai', agentId: -1004 };
  const conv = (stage, turn, bare = false) => ({ refusal: { stage, toolsSeen: false }, turn, bare });
  const q = (remaining, limitHit = false) => ({ created: 50 - remaining, remaining, limitHit, resetText: 'jeu. 05:00' });
  const on = { enabled: true };
  assert.equal(R.nextRefusalStep(conv(0, 0), gpt, q(40), on), 'bare');
  assert.equal(R.nextRefusalStep(conv(0, 0), gpt, q(5), on), 'clarify', 'quota bas : pas de chat de plus');
  assert.equal(R.nextRefusalStep(conv(0, 0), gpt, q(40, true), on), 'clarify', 'limite atteinte');
  assert.equal(R.nextRefusalStep(conv(0, 0, true), gpt, q(40), on), 'clarify', 'déjà dans un chat « bare »');
  assert.equal(R.nextRefusalStep(conv(0, 3), gpt, q(40), on), 'clarify', '3e tour');
  assert.equal(R.nextRefusalStep(conv(1, 3), gpt, q(40), on), 'switch');
  assert.equal(R.nextRefusalStep(conv(2, 3), gpt, q(40), on), 'give_up');
  assert.equal(R.nextRefusalStep(conv(0, 0), { provider: 'anthropic' }, q(40), on), 'give_up', 'seulement GPT');
  assert.equal(R.nextRefusalStep(conv(0, 0), gpt, q(40), { enabled: false }), 'give_up', 'récupération désactivée');
  assert.equal(R.switchAgentId(-1004), -2003);
  assert.equal(R.switchAgentId(-2003), -2001);
  assert.equal(R.switchNote('Claude Sonnet 5.5'), '(GPT a refusé d\'utiliser les outils : la demande est passée à Claude Sonnet 5.5.)');
});

test('recapOf : actions décrites avec le vocabulaire de France Student, échecs marqués, rien de Claude Code', () => {
  const turns = [
    user('corrige le bug de calc.js puis lance les tests'),
    asst('Je regarde le fichier.', [{ id: 'toolu_a', name: 'Read', input: { file_path: 'C:\\proj\\calc.js' } }]),
    user('', [{ id: 'toolu_a', content: '1\tfunction add(a, b) { return a - b; }', is_error: false }]),
    asst('', [{ id: 'toolu_b', name: 'Edit', input: { file_path: 'C:\\proj\\calc.js', old_string: 'a - b', new_string: 'a + b' } },
      { id: 'toolu_c', name: 'TodoWrite', input: { todos: [] } }]),
    user('', [{ id: 'toolu_b', content: 'ok', is_error: false }, { id: 'toolu_c', content: 'ok', is_error: false }]),
    asst('', [{ id: 'toolu_d', name: 'Bash', input: { command: 'node --test', description: 'tests' } },
      { id: 'toolu_e', name: 'Grep', input: { pattern: 'add\\(', path: 'C:\\proj' } }, { id: 'toolu_f', name: 'Glob', input: { pattern: '**/*.js' } }]),
    user('', [{ id: 'toolu_d', content: 'Exit code 1\nnot ok 1', is_error: true }, { id: 'toolu_e', content: 'x', is_error: false }]),
    asst('Le test échoue encore : je regarde.'),
    user('et ajoute une fonction subtract'),
  ];
  const r = R.recapOf(turns);
  assert.match(r, /^Récapitulatif de notre conversation précédente/);
  assert.match(r, /Utilisateur : corrige le bug de calc\.js puis lance les tests/);
  assert.match(r, /→ read_file C:\\proj\\calc\.js/);
  assert.match(r, /→ edit_file C:\\proj\\calc\.js(?! \(échec\))/);
  assert.match(r, /→ run_command « node --test » \(échec\)/);
  assert.match(r, /→ search_files « add\\\( » dans C:\\proj/);
  assert.match(r, /→ list_directory \. \(\*\*\/\*\.js\)/);
  assert.match(r, /→ autre action/);
  assert.match(r, /Utilisateur : et ajoute une fonction subtract/);
  assert.doesNotMatch(r, /function add/, 'le contenu des résultats n\'est pas recopié');
  assert.doesNotMatch(r, CC_NAMES);
  for (const re of LEAKS) assert.doesNotMatch(r, re);
});

test('recapOf : borné, première demande et échanges récents gardés, milieu omis', () => {
  const turns = [user('PREMIÈRE demande : crée le projet')];
  for (let i = 0; i < 200; i++) turns.push(asst(`réponse ${i} ` + 'x'.repeat(300)), user(`demande ${i}`));
  const r = R.recapOf(turns, 3000);
  assert.ok(r.length <= 3000, `longueur ${r.length}`);
  assert.match(r, /PREMIÈRE demande/);
  assert.match(r, /demande 199/);
  assert.match(r, /\[… \d+ échange\(s\) plus ancien\(s\) omis …\]/);
  assert.doesNotMatch(r, /demande 10\b/);
  assert.ok(R.recapOf(turns).length <= 12000, 'défaut 12 000 caractères');
  assert.equal(R.recapOf([]), '');
  assert.equal(R.recapOf(null), '');
});

test('quotaState : compteur, remise à zéro à 04:00 UTC, limite lue sur disque', () => {
  const home = tmpHome();
  const cfgFile = path.join(home, 'config.json');
  const deps = (created, now = FAKE_NOW) => ({ createdToday: () => created, now: () => now, cfgFile });
  assert.deepEqual(R.quotaState(deps(13)), { created: 13, limitHit: false, remaining: 37, resetText: localTime('2026-11-19T04:00:00.000Z') });
  assert.equal(R.quotaState(deps(60)).remaining, 0);
  assert.equal(R.quotaState(deps(0, Date.parse('2026-11-18T03:30:00Z'))).resetText, localTime('2026-11-18T04:00:00.000Z'), 'avant 04:00 UTC : remise à zéro le jour même');
  assert.equal(R.quotaState(deps(0, Date.parse('2026-07-01T10:00:00Z'))).resetText, localTime('2026-07-02T04:00:00.000Z'), 'été');

  fs.writeFileSync(cfgFile, JSON.stringify({ dailyLimitHitAt: FAKE_NOW - 3600000 }));   // 09:00 UTC : après la remise à zéro
  assert.equal(R.quotaState(deps(13)).limitHit, true);
  fs.writeFileSync(cfgFile, JSON.stringify({ dailyLimitHitAt: Date.parse('2026-11-18T03:00:00Z') }));   // avant 04:00 UTC : périmé
  assert.equal(R.quotaState(deps(13)).limitHit, false);
  fs.writeFileSync(cfgFile, '{ illisible');
  assert.equal(R.quotaState(deps(13)).limitHit, false);
});

test('quotaState : bonne heure de remise à zéro à Paris, en hiver (05:00) comme en été (06:00)', t => {
  const url = new URL('../src/gateway/recover.js', import.meta.url).href;
  const code = `const R = await import(${JSON.stringify(url)});
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const at = iso => R.quotaState({ createdToday: () => 0, now: () => Date.parse(iso), cfgFile: 'absent.json' }).resetText;
    console.log(JSON.stringify({ tz, hiver: at('2026-11-18T10:00:00Z'), ete: at('2026-07-01T10:00:00Z') }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: 'Europe/Paris' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  if (out.tz !== 'Europe/Paris') return t.skip(`fuseau Europe/Paris non appliqué par ce Node (${out.tz})`);
  assert.match(out.hiver, /05:00/);
  assert.match(out.ete, /06:00/);
});

test('errorKind : tableau du § 3.12, lu sur les champs (pas sur la classe)', () => {
  const k = (spec, o) => R.errorKind(fsError(spec, o));
  assert.equal(k('daily'), 'daily');
  assert.equal(k('auth'), 'auth');
  assert.equal(k(401), 'auth');
  assert.equal(k('native'), 'native');
  assert.equal(k({ status: 400, body: 'Client tools are not supported for this model' }), 'native');
  assert.equal(k('busy'), 'busy');
  assert.equal(k('network'), 'busy');
  assert.equal(k(502), 'busy');
  assert.equal(k({ status: 429, body: 'Too many requests' }), 'busy');
  assert.equal(k(409), 'reconcile');
  assert.equal(k({ status: 400, body: 'missing: call_1' }), 'reconcile');
  assert.equal(k({ status: 400, body: 'unknown: call_9' }), 'reconcile');
  assert.equal(k({ status: 404, body: 'Chat not found' }), 'gone');
  assert.equal(k({ code: 'CHAT_DELETED' }), 'gone');
  assert.equal(k({ status: 403, body: 'This conversation was flagged by the AI provider and has been locked' }), 'locked');
  assert.equal(k({ status: 400, body: 'messages.11.content.0: Invalid `encrypted_content` in `search_result` block' }), 'broken');
  assert.equal(k({ code: 'STREAM_LEASE_LOST' }, { accepted: true }), 'reattach');
  assert.equal(k({ code: 'BACKEND_TIMEOUT' }, { accepted: true }), 'reattach');
  assert.equal(k({ code: 'UPSTREAM_RATE_LIMIT', retryable: true }, { accepted: true }), 'retry_continue');
  assert.equal(k({ code: 'STREAM_FAILED', retryable: true }, { accepted: true }), 'retry_continue');
  assert.equal(k({ code: 'STREAM_FAILED', retryable: false }, { accepted: true }), 'stream_failed');
  assert.equal(k({ code: 'CONTENT_POLICY_VIOLATION' }, { accepted: true }), 'policy');
  assert.equal(R.errorKind(Object.assign(new Error('x'), { accountDisabled: true })), 'disabled');
  assert.equal(R.errorKind(Object.assign(new Error('annulé'), { name: 'AbortError' })), 'aborted');
  assert.equal(k({ status: 400, body: 'mauvaise requête' }), 'other');
  assert.equal(R.errorKind(null), 'other');
});

test('httpErrorFor : jamais 401 ni 429 ; quota et session en 400 français, surcharge en 529', () => {
  const q = { created: 50, remaining: 0, limitHit: true, resetText: 'jeu. 05:00' };
  const daily = R.httpErrorFor('daily', q);
  assert.deepEqual([daily.status, daily.type], [400, 'invalid_request_error']);
  assert.equal(daily.message, 'Limite de 50 nouvelles conversations France Student atteinte (remise à zéro jeu. 05:00). Reprends une session existante avec claude --continue.');
  assert.match(R.httpErrorFor('auth').message, /fs-cli --login/);
  assert.equal(R.httpErrorFor('auth').status, 400);
  const busy = R.httpErrorFor('busy');
  assert.deepEqual([busy.status, busy.type, busy.headers['retry-after']], [529, 'overloaded_error', '5']);
  assert.equal(R.httpErrorFor('disabled').status, 400);
  assert.match(R.httpErrorFor('other', null, new Error('HTTP 400: champ invalide')).message, /champ invalide/);
  for (const kind of ['reconcile', 'native', 'gone', 'locked', 'broken', 'reattach', 'aborted']) assert.equal(R.httpErrorFor(kind, q), null, kind);
  for (const kind of ['daily', 'auth', 'busy', 'disabled', 'other']) assert.ok(![401, 429].includes(R.httpErrorFor(kind, q).status), kind);
  assert.match(R.MESSAGES.borrow, /^\(Limite de 50 nouvelles conversations atteinte/);
  assert.equal(R.MESSAGES.newTask, '[Nouvelle tâche, sans rapport avec ce qui précède.]');
});
