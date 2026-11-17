import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, urlsIn } from '../src/intent.js';

const cmd = (t) => detectIntent(t)?.cmd ?? null;

test('équipe d\'agents comprise en langage naturel', () => {
  let r = detectIntent('fais un site de café et utilise plusieurs agents');
  assert.equal(r.cmd, '/team'); assert.equal(r.arg, 'fais un site de café');
  r = detectIntent('crée un portfolio avec 3 agents en parallèle');
  assert.equal(r.cmd, '/team'); assert.match(r.arg, /^-n 3 --pool crée un portfolio$/);
  r = detectIntent('fais une landing page avec trois sous-agents et relis le résultat');
  assert.equal(r.cmd, '/team'); assert.match(r.arg, /-n 3/); assert.match(r.arg, /--review/);
  assert.equal(cmd('code un jeu snake en équipe'), '/team');
  assert.equal(cmd('fais ce site en multi-agents'), '/team');
});

test('pas de faux positifs pour les équipes', () => {
  assert.equal(cmd('fais un site de café'), null);
  assert.equal(cmd('c\'est quoi des sous-agents ?'), null);
  assert.equal(cmd('fais le site sans agents'), null);
  assert.equal(cmd('écris un agent de trading en python'), null);
  assert.equal(cmd('/team fais un site'), null);
});

test('autres fonctions', () => {
  assert.deepEqual([cmd('retiens que je code en TypeScript'), detectIntent('retiens que je code en TypeScript').arg], ['/remember', 'je code en TypeScript']);
  assert.equal(cmd('souviens-toi que le port est 3003'), '/remember');
  assert.equal(cmd('combien de conversations il me reste ?'), '/chats');
  assert.equal(cmd("c'est quoi mon quota"), '/usage');
  assert.equal(cmd('le contexte est plein ?'), '/context');
  assert.equal(cmd('nouvelle conversation'), '/new');
  assert.equal(cmd('compacte la conversation'), '/compact');
  const c = detectIntent('compare gpt et claude sur la meilleure façon de trier une liste en python');
  assert.equal(c.cmd, '/compare'); assert.match(c.arg, /meilleure façon de trier/); assert.match(c.duelModel, /claude/i);
  assert.equal(cmd('compare ces deux fonctions'), null);
});

test('URL citées', () => {
  assert.deepEqual(urlsIn('résume https://exemple.fr/page. merci'), ['https://exemple.fr/page']);
  assert.deepEqual(urlsIn('rien ici'), []);
});

test('extension de l\'éditeur : la nôtre seulement', () => {
  assert.equal(detectIntent("installe l'extension vs code")?.cmd, '/vscode');
  assert.equal(detectIntent('mets fs-cli dans cursor')?.cmd, '/vscode');
  assert.equal(detectIntent("installe l'extension prettier dans vscode"), null);
  assert.equal(detectIntent('installe express avec npm'), null);
});

test('projet France Student : « travaille dans mon projet X »', () => {
  assert.deepEqual(['cmd', 'arg'].map(k => detectIntent('travaille dans mon projet Marketing')?.[k]), ['/projet', 'Marketing']);
  assert.equal(detectIntent('passe sur le projet « Site vitrine »')?.arg, 'Site vitrine');
  assert.equal(detectIntent('crée un projet react avec vite'), null);
});

test('chemin sans guillemets avec des espaces (« …\test multi agent ») : reconnu jusqu\'au bout grâce au disque, jamais lu comme une demande d\'équipe', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-intent-'));
  const dir = path.join(base, 'test multi agent'); fs.mkdirSync(dir);
  assert.equal(detectIntent(`du code dans ce dossier ${dir}`), null);
  const r = detectIntent(`fais un site dans ${dir} avec 3 agents en parallèle`);
  assert.equal(r?.cmd, '/team'); assert.ok(r.arg.includes(dir), 'le chemin reste entier dans la consigne : ' + r.arg);
});
