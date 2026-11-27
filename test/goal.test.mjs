// /goal : le modèle vérifie avec ses outils puis finit par une ligne d'état (« 🎯 atteint / pas encore / impossible »).
// Pas de vérificateur séparé : le modèle de France Student refuse ce rôle (vu en vrai le 28/11/2026).
import test from 'node:test';
import assert from 'node:assert/strict';

const G = await import('../src/goal.js');

test('parseStatus : la dernière ligne d\'état compte ; variantes d\'écriture ; pas de ligne → null', () => {
  assert.deepEqual(G.parseStatus('J\'ai relu le fichier.\n\n🎯 atteint : preuve.txt contient « objectif ok »'), { state: 'met', reason: 'preuve.txt contient « objectif ok »' });
  assert.deepEqual(G.parseStatus('🎯 pas encore : 2 tests échouent'), { state: 'not', reason: '2 tests échouent' });
  assert.deepEqual(G.parseStatus('**🎯 Pas encore atteint — il manque le son**'), { state: 'not', reason: 'il manque le son' });
  assert.deepEqual(G.parseStatus('> 🎯 impossible : ffmpeg absent et pas de réseau'), { state: 'impossible', reason: 'ffmpeg absent et pas de réseau' });
  assert.equal(G.parseStatus('🎯 Objectif atteint').state, 'met');
  assert.equal(G.parseStatus('Je dois finir par « 🎯 atteint : … » plus tard.\n\n🎯 pas encore : tests à relancer').state, 'not', 'la dernière ligne compte');
  assert.equal(G.parseStatus('Tout est fait, normalement.'), null);
  assert.equal(G.parseStatus('🎯 atteint : x\n' + 'ligne\n'.repeat(12)), null, 'ligne d\'état trop haut : pas une fin de réponse');
});

test('messages : départ et reprise portent la condition et la consigne de vérifier avec les outils puis de donner la ligne d\'état', () => {
  const s = G.startMessage('les tests passent');
  assert.match(s, /^\[Objectif fixé avec \/goal : « les tests passent »/);
  assert.match(s, /vérifie avec tes outils/);
  assert.match(s, /🎯 atteint : <la preuve que tu viens de vérifier>/);
  const c = G.continueMessage('les tests passent', '2 tests échouent', 3);
  assert.match(c, /étape 3 : « 2 tests échouent »/);
  assert.match(c, /« les tests passent »/);
  assert.match(c, /🎯 pas encore/);
});

test('hookVerdict (fs claude) : « atteint » seulement avec la ligne ; impossible ; sinon « pas encore » + rappel de la consigne', () => {
  const conv = last => [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'text', text: last }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] }, { role: 'user', content: 'Condition: les tests passent' }];
  assert.deepEqual(G.hookVerdict(conv('Relancé : 14 passing.\n🎯 atteint : 14 passing')), { ok: true, reason: '14 passing' });
  assert.deepEqual(G.hookVerdict(conv('🎯 impossible : pas de dossier de tests')), { ok: false, impossible: true, reason: 'pas de dossier de tests' });
  const not = G.hookVerdict(conv('🎯 pas encore : 2 échecs'));
  assert.equal(not.ok, false);
  assert.match(not.reason, /^pas encore : 2 échecs\. Avant de finir, vérifie avec tes outils/);
  const none = G.hookVerdict(conv('C\'est fait !'));
  assert.equal(none.ok, false, 'jamais « atteint » sans la ligne d\'état');
  assert.match(none.reason, /^pas encore confirmé\./);
  assert.equal(G.hookVerdict([]).ok, false);
});

test('consigne anglaise de Claude Code au démarrage de /goal → consigne française avec la ligne d\'état', () => {
  const en = 'A session-scoped Stop hook is now active with condition: "all tests pass". Briefly acknowledge the goal, then immediately start (or continue) working toward it';
  assert.match(G.goalStartFromClaudeCode(en), /^\[Objectif fixé avec \/goal : « all tests pass »[\s\S]*🎯 atteint/);
  assert.equal(G.goalStartFromClaudeCode('bonjour'), null);
});
