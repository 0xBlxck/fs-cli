// Audit (lot 2) : reprise de conversation, relances, contexte de l'IDE, chemins « /… », historique, images collées, démarrage du panneau
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-audit2-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(root, 'cli.js'), 'utf8');
const fnBody = name => { const i = cli.indexOf(name); assert.ok(i >= 0, name + ' introuvable'); return cli.slice(i, cli.indexOf('\n}\n', i)); };

test('équipe d\'agents : « des agents immobiliers », « 3 agents de sécurité » ne lancent rien ; les vraies demandes oui', async () => {
  const { detectIntent } = await import('../src/intent.js');
  assert.equal(detectIntent('fais un site vitrine pour des agents immobiliers'), null);
  assert.equal(detectIntent('crée une landing page pour une agence de 3 agents de sécurité'), null);
  assert.equal(detectIntent('fais un annuaire de plusieurs agents commerciaux'), null);
  assert.equal(detectIntent('fais ce site avec plusieurs agents')?.arg, 'fais ce site');
  assert.equal(detectIntent('fais un portfolio, utilise deux agents')?.arg, '-n 2 fais un portfolio');
  const r = detectIntent('fais un CRM pour des agents commerciaux avec 2 agents');   // le sujet reste entier dans la consigne
  assert.equal(r?.cmd, '/team'); assert.equal(r.arg, '-n 2 fais un CRM pour des agents commerciaux');
});

test('intentions et raccourcis lus sur ce qui est tapé, pas sur le contexte de l\'IDE', async () => {
  const { detectIntent } = await import('../src/intent.js');
  const { stripEditorContext } = await import('../src/editor-context.js');
  const file = '[Contexte VS Code : fichier ouvert dans l\'éditeur : src\\app.js]\n\n';
  const sel = '[Contexte VS Code : dans a.js, lignes 1-2 sélectionnées par l\'utilisateur]\n```js\n// répartit le travail entre des agents\n// compare les prix renvoyés par gpt-4o\n```\n\n';
  assert.equal(detectIntent(stripEditorContext(file + 'retiens que j\'utilise pnpm'))?.cmd, '/remember');
  assert.equal(detectIntent(stripEditorContext(file + 'nouvelle conversation'))?.cmd, '/new');
  assert.equal(detectIntent(stripEditorContext(file + 'reviens en arrière'))?.cmd, '/rewind');
  assert.equal(detectIntent(stripEditorContext(sel + 'Explique ce code')), null);
  assert.equal(detectIntent(stripEditorContext(sel + 'Ajoute un test')), null);
  // cli.js : handleInput et chatTurn s'appuient sur own (texte tapé) ; le titre ne prend plus le préfixe
  const h = fnBody('async function handleInput(');
  assert.match(h, /const own = stripEditorContext\(t\)\.trim\(\)/);
  assert.match(h, /onlyAFolder\(own\)/); assert.match(h, /naturalIntent\(own, editorCtx\)/); assert.match(h, /\/\^#\\s\*\\S\/\.test\(own\)/);
  const ct = fnBody('async function chatTurn(');
  assert.match(ct, /S\.title = own\.replace/); assert.match(ct, /mem\.observe\(own/); assert.match(ct, /wantsBrowser\(own\)/); assert.match(ct, /mentionedServers\(S\.cwd, own\)/);
  const ni = fnBody('async function naturalIntent(');
  assert.match(ni, /runTeam\(extraEnv\(\), `\$\{editorCtx\}\$\{task\}`, \{ review, agents, mode \}\)/);   // la sélection part avec /team…
  assert.match(ni, /r\.cmd === '\/compare' \? `\$\{editorCtx\}\$\{r\.arg\}`/);                           // … et avec /compare
});

test('équipe + sélection de l\'IDE : « tail -n 20 » ou « --parallel » dans le code ne sont pas lus comme options', async () => {
  const { detectIntent } = await import('../src/intent.js');
  const r = detectIntent('fais ce site avec plusieurs agents en parallèle');
  assert.equal(r?.cmd, '/team');
  assert.deepEqual(r.team, { agents: null, mode: 'pool', review: false, task: 'fais ce site' });
  assert.equal(detectIntent('fais un portfolio, utilise deux agents')?.team.agents, 2);
  // options passées à part : le contexte de l'éditeur reste intact dans la consigne, sans repasser par le lecteur d'options de /team
  const ni = fnBody('async function naturalIntent(');
  assert.match(ni, /if \(editorCtx && r\.cmd === '\/team' && r\.team\)/);
  assert.match(cli, /^import \{ runTeam \} from '\.\/src\/team\.js';/m);
});

test('Mac/Linux : « /Users/moi/app plante » n\'est pas une commande ; Windows inchangé', async () => {
  const { isSlashCommand } = await import('../src/intent.js');
  const posix = { win: false, exists: p => ['/tmp', '/dev'].includes(p), known: n => n === '/dev' };
  assert.equal(isSlashCommand('/Users/moi/app/server.js plante, regarde', posix), false);
  assert.equal(isSlashCommand('/Users/moi/app', posix), false);
  assert.equal(isSlashCommand('/tmp', posix), false);                       // dossier d'un seul niveau qui existe
  assert.equal(isSlashCommand('/dev', posix), true);                        // … sauf si c'est une commande connue (commande perso, skill)
  assert.equal(isSlashCommand('/new', posix), true);
  assert.equal(isSlashCommand('/cd ../projet', posix), true);
  assert.equal(isSlashCommand('/new\nsuite', posix), false);
  assert.equal(isSlashCommand('bonjour', posix), false);
  for (const t of ['/Users/moi/app', '/tmp', '/new', '/cd C:/x']) assert.equal(isSlashCommand(t, { win: true }), true);   // Windows : comme avant
  assert.match(fnBody('async function handleInput('), /isSlashCommand\(t, \{ win: IS_WIN, known: knownCmd \}\)/);
});

test('historique ↑ : une entrée de plusieurs lignes reste entière ; ni secret ni long collage écrit en clair', async () => {
  const { encodeHistory, decodeHistory, historyKeeps } = await import('../src/config.js');
  const msg = 'corrige ce bug :\nTypeError: x is undefined\n    at main.js:12';
  const file = [encodeHistory('première'), 'ancienne ligne brute', encodeHistory(msg), '"guillemet pas json'].join('\n') + '\n';
  assert.deepEqual(decodeHistory(file), ['première', 'ancienne ligne brute', msg, '"guillemet pas json']);
  assert.equal(historyKeeps(msg), true);
  assert.equal(historyKeeps('AWS_SECRET_ACCESS_KEY=' + 'q8Zt3Lm9Xr2Kp7Wv4Nb6Hj1Fd5Gs0Ac8Ye3Ui7Ro2'), false);   // scan-ignore (faux secret de test)
  assert.equal(historyKeeps('DB_PASSWORD=hunter2\nPORT=3000'), false);   // scan-ignore (faux secret de test)
  assert.equal(historyKeeps('voici ma clé ' + 'AKIA' + 'Q7ZK2M9XR4TBW8HN'), false);   // scan-ignore (fausse clé de test)
  assert.equal(historyKeeps('x'.repeat(2001)), false);
  assert.match(cli, /historyKeeps\(t\)\) try \{ fs\.appendFileSync\(FILES\.hist, encodeHistory\(t\)/);
  assert.match(cli, /histLines = decodeHistory\(/);
});

test('projet de la conversation : choix ponctuel > --projet > /projet, sans rien consommer', async () => {
  const { cfg } = await import('../src/config.js');
  const api = await import('../src/api.js');
  const before = cfg.fsProject;
  try {
    cfg.fsProject = { id: 'defaut', name: 'Défaut' };
    assert.equal(api.effectiveProject().id, 'defaut');
    api.setProjectOverride({ id: 'run', name: 'Run' });
    assert.equal(api.effectiveProject().id, 'run');
    api.setProjectOnce({ id: 'once', name: 'Once' });
    assert.equal(api.effectiveProject().id, 'once');
    assert.equal(api.effectiveProject().id, 'once');                        // lu deux fois : toujours là (le rangement le consommera)
    api.setProjectOnce(false);
    assert.equal(api.effectiveProject(), false);                            // hors projet : aucune instruction
  } finally { api.setProjectOnce(undefined); api.setProjectOverride(undefined); cfg.fsProject = before; }
  const ct = fnBody('async function chatTurn(');
  assert.match(ct, /const proj = effectiveProject\(\);/);
  assert.doesNotMatch(ct, /cfg\.fsProject\.id\)\?\.customInstructions/);
});

test('reprise : l\'état de la conversation précédente ne passe pas dans la suivante ; taille de CETTE conversation gardée', () => {
  const save = fnBody('function saveSession(');
  assert.match(save, /skillsCatSig: S\.skillsCatSig \|\| ''/); assert.match(save, /lastPromptTokens: S\.lastPromptTokens \|\| 0/);
  const reset = fnBody('function resetChatState(');
  for (const k of ['lastPromptTokens = 0', 'pendingSummary = null', 'compactedFrom = null', 'notes = []', 'skillsSent = null', "skillsCatSig = ''"]) assert.ok(reset.includes('S.' + k), k);
  const apply = fnBody('function applySession(');
  assert.match(apply, /resetChatState\(\);/);
  assert.match(apply, /S\.lastPromptTokens = Number\(s\.lastPromptTokens\) \|\| 0/);
  assert.match(apply, /S\.skillsCatSig = s\.skillsCatSig \|\| ''/);
  assert.match(apply, /S\.needCtxCheck = /);
  assert.match(fnBody('async function chatTurn('), /S\.needCtxCheck && S\.chatId && cfg\.autoCompact/);   // taille inconnue : demandée une fois avant d'envoyer
  assert.match(cli, /case '\/new':[\s\S]{0,300}resetChatState\(\);[\s\S]{0,300}S\.images = \[\]; S\.imageTags = \{\}/);
});

test('fs -c : seulement une session de CE dossier (casse ignorée sous Windows/macOS), jamais celle d\'un autre dossier', () => {
  const i = cli.indexOf('if (opts.cont) {'), block = cli.slice(i, cli.indexOf('\n}\n', i));
  assert.match(block, /sameDir\(x\.cwd, S\.cwd\)/);
  assert.doesNotMatch(block, /\|\| list\[0\]/);
  assert.match(block, /aucune session dans ce dossier/);
  assert.match(cli, /^function samePathCI\(a, b\)/m);                       // fonctions (hissées) : utilisables dès le démarrage
  assert.match(cli, /^function sameDir\(a, b, platform = process\.platform\)/m);
  // comportement : on évalue les deux fonctions telles qu'elles sont dans cli.js
  const src = ['function samePathCI(', 'function sameDir('].map(n => { const k = cli.indexOf(n); return cli.slice(k, cli.indexOf('\n', cli.indexOf('}', k)) + 1); }).join('\n');
  const sameDir = new Function('path', `${src}\nreturn sameDir;`)(path);
  const a = path.resolve(tmp, 'Proj'), b = path.resolve(tmp, 'proj');
  assert.equal(sameDir(a, b, 'linux'), false);                              // Linux : deux dossiers différents
  assert.equal(sameDir(a, a, 'linux'), true);
  assert.equal(sameDir(a, b, 'win32'), true);                               // Windows : inchangé
  assert.equal(sameDir(a, b, 'darwin'), true);
});

test('relance automatique : fichiers joints, résultats, pages, images et skill demandés repartent', () => {
  const ct = fnBody('async function chatTurn(');
  assert.match(ct, /const consumed = \{ files: \[\.\.\.S\.pendingFiles\], results: \[\.\.\.S\.pendingResults\], context: \[\.\.\.S\.pendingContext\], images: \[\.\.\.S\.images\]/);
  assert.equal((ct.match(/return again\(\)|await again\(\)/g) || []).length, 3);   // supprimée · illisible · limite après résumé
  assert.doesNotMatch(ct, /chatTurn\(text, \{ keepLast: true \}\)/);
  assert.match(ct, /if \(!keepLast \|\| retry\) \{\s+\/\/ skills/);
});

test('@chemin avec espace : proposé entre guillemets ; une mention introuvable est signalée', () => {
  assert.match(cli, /function atMention\(p, quoted = false\)/);
  assert.match(fnBody('function suggest('), /@"\(\[\^"\]\*\)\$/);
  const bm = fnBody('function buildMessage(');
  assert.match(bm, /chemin avec espace : écris @"/);
  assert.match(bm, /introuvable : rien de joint/);
});

test('image collée puis étiquette effacée : elle ne part pas ; en mode classique (sans étiquette) elle part', () => {
  // pasteClipboardImage et le filtre d'images de chatTurn, évalués tels qu'ils sont dans cli.js
  const paste = fnBody('function pasteClipboardImage(') + '\n}';
  const ct = fnBody('async function chatTurn(');
  const k = ct.indexOf('if (S.images.some(p => S.imageTags?.[p])) {');
  assert.ok(k >= 0, 'filtre d\'images introuvable');
  const filter = ct.slice(k, ct.indexOf('\n      S.images = kept;\n    }', k) + '\n      S.images = kept;\n    }'.length);
  const run = ({ insert, interactive, typed }) => {
    const S = { images: [] }, out = [], inserted = [];
    const input = insert ? { insert: t => inserted.push(t) } : {};          // ReadlineInput (mode classique) : pas d'insert
    const c = { dim: s => s, yellow: s => s };
    const pasteFn = new Function('S', 'input', 'interactive', 'MAX_IMAGES', 'grabClipboardImage', 'readClipboardText', 'println', 'c', 'ui',
      `${paste}\nreturn pasteClipboardImage;`)(S, input, interactive, 10, () => path.join(tmp, 'clip.png'), () => '', s => out.push(s), c, { out: s => out.push(s) });
    pasteFn();
    const text = typed(inserted.join(''));
    const res = new Function('S', 'text', 'println', 'c', 'path', `${filter}\nreturn text;`)(S, text, s => out.push(s), c, path);
    return { S, out, inserted, text: res };
  };
  // terminal riche : étiquette insérée ; gardée → l'image part ; effacée → retirée
  let r = run({ insert: true, interactive: true, typed: tag => `${tag}que vois-tu ?` });
  assert.deepEqual(r.inserted, ['[Image #1] ']); assert.equal(r.S.images.length, 1);
  r = run({ insert: true, interactive: true, typed: () => 'que vois-tu ?' });
  assert.equal(r.S.images.length, 0); assert.ok(r.out.some(s => /image retirée/.test(s)));
  // mode classique (--classic, mintty/Git Bash) : aucune étiquette suivie → l'image annoncée part bien avec le message suivant
  for (const opt of [{ insert: false, interactive: true }, { insert: true, interactive: false }]) {
    r = run({ ...opt, typed: () => 'que vois-tu ?' });
    assert.deepEqual(r.inserted, []);
    assert.equal(r.S.images.length, 1, 'image retirée à tort en mode classique');
    assert.ok(r.out.some(s => /prête : elle partira avec ton prochain message/.test(s)));
    assert.ok(!r.out.some(s => /image retirée/.test(s)));
  }
});

test('panneau : un message envoyé pendant le démarrage attend la question de confiance', async () => {
  const { StdioInput } = await import('../src/stdio.js');
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  let inp;
  try {
    inp = new StdioInput({ startBusy: true });
    const got = [];
    inp.on('submit', t => got.push(t));
    inp.onLine(JSON.stringify({ type: 'submit', text: 'trop tôt' }));
    assert.deepEqual(got, []);
    assert.equal(inp.takeQueued(), 'trop tôt');
    inp.setBusy(false); inp.onLine(JSON.stringify({ type: 'submit', text: 'après' }));
    assert.deepEqual(got, ['après']);
  } finally { process.stdout.write = orig; inp?.stop(); }
  assert.match(cli, /new StdioInput\(\{ startBusy: true \}\)/);
  assert.match(cli, /if \(busy \|\| holdInput\) return;/);
  assert.match(cli, /holdInput = false; input\.setBusy\(false\);/);
});
