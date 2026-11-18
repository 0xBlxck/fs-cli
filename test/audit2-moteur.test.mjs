// Audit 2 · moteur des outils : écrasement sans lecture, cache de lecture, noms des outils de FS, search_files (casse, blocage,
// sortie), contenu envoyé en objet, dossier cible détecté dans une trace d'erreur.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-audit2-'));
process.env.FS_CLI_HOME = path.join(tmp, 'home');
const { cfg } = await import('../src/config.js');
const { execCall, forgetRead, setSelectHandler } = await import('../src/agent.js');
const { TOOLS, normalizeArgs, READ_MAX, wasSeen } = await import('../src/tools.js');
const { detectTargetDir, acceptTarget, targetNote } = await import('../src/target.js');

let n = 0;
/** dossier de projet neuf (avec .git : les .gitignore des dossiers parents ne s'appliquent pas) */
const project = () => { const d = path.join(tmp, `p${++n}`); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
const put = (dir, rel, content) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
const session = (cwd, extra = {}) => ({ cwd, targetDir: null, allow: {}, undo: [], notes: [], pendingResults: [], chatId: `chat-${++n}`, ...extra });
const io = root => ({ signal: new AbortController().signal, ask: async () => '', root });

// ── moteur-agent-ecrase-sans-lecture ──
test('write_file : un fichier existant jamais lu n\'est pas écrasé (mode auto) ; après read_file, oui', async () => {
  cfg.mode = 'auto';
  const dir = project();
  const f = put(dir, 'index.html', '<h1>le vrai site</h1>\n');
  const S = session(dir);
  const r = await execCall(S, { name: 'write_file', args: { path: 'index.html', content: 'remplacé' } }, io(dir));
  assert.equal(r.ok, false);
  assert.match(r.output, /existe déjà et tu ne l'as pas lu/);
  assert.match(r.output, /read_file/);
  assert.equal(fs.readFileSync(f, 'utf8'), '<h1>le vrai site</h1>\n');
  assert.equal((await TOOLS.write_file.run({ path: 'index.html', content: 'x' }, { cwd: dir })).ok, false, 'aussi en appel direct');
  await execCall(S, { name: 'read_file', args: { path: 'index.html' } }, io(dir));
  assert.equal(wasSeen(f), true);
  assert.equal((await execCall(S, { name: 'write_file', args: { path: 'index.html', content: 'remplacé' } }, io(dir))).ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'remplacé');
});

test('write_file : nouveau fichier et réécriture de son propre fichier restent libres ; écrasement accepté par l\'utilisateur : écrit', async () => {
  cfg.mode = 'auto';
  const dir = project();
  const S = session(dir);
  assert.equal((await execCall(S, { name: 'write_file', args: { path: 'a.txt', content: 'v1' } }, io(dir))).ok, true);
  assert.equal((await execCall(S, { name: 'write_file', args: { path: 'a.txt', content: 'v2' } }, io(dir))).ok, true);
  const g = put(dir, 'b.txt', 'garde-moi');
  assert.equal((await execCall(S, { name: 'write_file', args: { path: 'b.txt', content: 'bloc' }, allowOverwrite: true }, io(dir))).ok, true, 'bloc choisi par l\'utilisateur (/run)');
  assert.equal(fs.readFileSync(g, 'utf8'), 'bloc');
  // mode « confirmer » : la carte le signale, et « Oui » vaut accord pour écraser
  cfg.mode = 'ask';
  const asked = [];
  setSelectHandler(async o => { asked.push(o); return 0; });
  const h = put(dir, 'c.txt', 'ancien');
  assert.equal((await execCall(session(dir), { name: 'write_file', args: { path: 'c.txt', content: 'nouveau' } }, io(dir))).ok, true);
  assert.match(asked[0].title, /écrase un fichier existant/);
  assert.equal(fs.readFileSync(h, 'utf8'), 'nouveau');
  setSelectHandler(null); cfg.mode = 'auto';
});

// ── moteur-agent-cache-lecture-faux ──
test('read_file : fichier binaire relu → toujours une erreur, jamais « déjà reçu »', async () => {
  const dir = project();
  put(dir, 'img.bin', Buffer.from([1, 2, 0, 3, 0, 4]));
  const ctx = { cwd: dir, readCache: new Map() };
  for (let i = 0; i < 2; i++) {
    const r = await TOOLS.read_file.run({ path: 'img.bin' }, ctx);
    assert.equal(r.ok, false); assert.match(r.output, /binaire/);
  }
});

test('read_file : lecture limitée sous la coupe de France Student, suite annoncée avec start_line', async () => {
  const dir = project();
  const big = Array.from({ length: 1500 }, (_, i) => `ligne ${i + 1} ` + 'x'.repeat(60)).join('\n');
  put(dir, 'gros.txt', big);
  const ctx = { cwd: dir, readCache: new Map() };
  const r = await TOOLS.read_file.run({ path: 'gros.txt' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.length <= READ_MAX + 200, `résultat de ${r.output.length} caractères`);
  assert.ok(r.output.length < 40000, 'sous la limite de FS par résultat');
  const m = r.output.match(/start_line=(\d+) pour continuer/);
  assert.ok(m, 'indice de suite');
  assert.doesNotMatch(r.output, /offset=/);
  assert.match(r.output, new RegExp(`\\b${Number(m[1]) - 1}\\tligne ${Number(m[1]) - 1} `), 'la dernière ligne envoyée précède la suite');
  assert.doesNotMatch(r.output, /caractères omis/, 'pas de coupe au milieu');
  const suite = await TOOLS.read_file.run({ path: 'gros.txt', offset: Number(m[1]) }, ctx);
  assert.match(suite.output, new RegExp(`ligne ${m[1]} `));
});

test('read_file : un résultat coupé avant d\'arriver au modèle est oublié (forgetRead) ; contexte résumé par FS → cache vidé', async () => {
  cfg.mode = 'auto';
  const dir = project();
  put(dir, 'a.js', 'const a = 1;\n');
  const S = session(dir);
  const r1 = await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir));
  assert.ok(r1.cacheKey, 'clé de cache renvoyée');
  assert.match((await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir))).output, /inchangé/);
  await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir));            // soupape : renvoyé en entier
  forgetRead(S, r1.cacheKey);
  assert.match((await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir))).output, /const a = 1/, 'oublié : renvoyé en entier');
  // compaction : la taille du contexte baisse fortement → le modèle a oublié ce qu'il a lu
  S.lastPromptTokens = 100000;
  assert.match((await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir))).output, /inchangé/);
  await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir));            // soupape
  S.lastPromptTokens = 95000;                                                            // baisse faible : cache gardé
  assert.match((await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir))).output, /inchangé/);
  S.lastPromptTokens = 30000;
  assert.match((await execCall(S, { name: 'read_file', args: { path: 'a.js' } }, io(dir))).output, /const a = 1/, 'après un résumé du contexte : renvoyé');
});

// ── moteur-agent-noms-internes ──
test('messages au modèle : noms des outils et paramètres de France Student, aucun format d\'outil', async () => {
  cfg.mode = 'auto';
  const dir = project();
  put(dir, 'sous/x.txt', 'abc\n');
  const ctx = { cwd: dir };
  assert.match((await TOOLS.read_file.run({ path: 'sous' }, ctx)).output, /list_directory/);
  const e1 = await TOOLS.edit_file.run({ path: 'sous/x.txt', old_string: 'zzz', new_string: 'y' }, ctx);
  assert.match(e1.output, /old_text introuvable/);
  assert.doesNotMatch(e1.output, /old_string/);
  assert.match((await TOOLS.edit_file.run({ path: 'sous/x.txt', old_string: 'abc', new_string: 'abc' }, ctx)).output, /old_text et new_text/);
  const S = session(dir);
  const m = await execCall(S, { name: 'edit_file', args: { path: 'sous/x.txt', new_string: 'y' } }, io(dir));
  assert.equal(m.ok, false);
  assert.match(m.output, /old_text/);
  assert.doesNotMatch(m.output, /<fs:|old_string|Format attendu/);
  const g = await execCall(S, { name: 'grep', args: {} }, io(dir));
  assert.match(g.output, /^search_files : paramètre manquant : query/);
});

// ── moteur-agent-search-casse ──
test('search_files : casse intelligente, « (?i) », regex invalide signalée, max_results respecté', async () => {
  const dir = project();
  put(dir, 'src/auth.js', 'function handleLogin() {}\nclass LoginService {}\nconst login = 1;\n');
  const ctx = { cwd: dir };
  const grep = a => TOOLS.grep.run(a, ctx);
  const low = await grep({ pattern: 'login' });
  assert.match(low.output, /handleLogin/); assert.match(low.output, /LoginService/); assert.match(low.output, /const login/);
  const upper = await grep({ pattern: 'Login' });                       // majuscule : sensible à la casse
  assert.match(upper.output, /handleLogin/); assert.doesNotMatch(upper.output, /const login/);
  const inl = await grep({ pattern: '(?i)LOGIN' });
  assert.match(inl.output, /const login/); assert.match(inl.output, /LoginService/);
  assert.match((await grep({ pattern: 'Login', ignore_case: true })).output, /const login/);
  const bad = await grep({ pattern: 'handleLogin(' });
  assert.match(bad.output, /^\[regex invalide : recherche du texte exact\]/);
  assert.match(bad.output, /handleLogin\(\)/);
  assert.equal((await grep({ pattern: '*foo' })).ok, true, 'texte exact avec * : pas d\'erreur interne');
  const two = await grep({ pattern: 'login', max_results: 2 });
  assert.equal(two.output.split('\n').filter(l => /auth\.js:\d+:/.test(l)).length, 2);
  assert.match(two.output, /il en reste d'autres/);
  const { args } = normalizeArgs(TOOLS.grep, { pattern: 'login', max_results: 'all' });
  assert.equal(args.max_results, undefined, '« all » : limite par défaut');
  assert.equal((await grep(args)).output.split('\n').filter(l => /auth\.js:\d+:/.test(l)).length, 3);
});

// ── moteur-agent-grep-bloquant ──
test('search_files : rend la main pendant le parcours, s\'arrête sur Ctrl+C ou au bout du budget, signale les gros fichiers', async () => {
  const dir = project();
  for (let i = 0; i < 450; i++) put(dir, `d${i % 9}/f${i}.txt`, 'rien\n');
  put(dir, 'gros.txt', 'cible\n' + 'y'.repeat(2_100_000));
  const all = await TOOLS.grep.run({ pattern: 'cible' }, { cwd: dir });
  assert.match(all.output, /1 fichier de plus de 2 Mo non fouillé/);
  assert.match(all.output, /aucune correspondance/);
  const ac = new AbortController(); ac.abort();
  assert.match((await TOOLS.grep.run({ pattern: 'rien' }, { cwd: dir, signal: ac.signal })).output, /\[recherche interrompue\]/);
  assert.match((await TOOLS.grep.run({ pattern: 'zzz' }, { cwd: dir, searchBudgetMs: 0 })).output, /recherche arrêtée après 0 s : résultats incomplets/);
});

// ── tokens-search-files-sortie ──
test('search_files : dossiers générés, copies de worktree, verrous, *.min.js et .gitignore ignorés ; sortie regroupée au-delà de 60', async () => {
  const dir = project();
  put(dir, 'src/app.js', 'chatId\n');
  for (const p of ['dist/app.js', 'build/x.js', 'coverage/c.js', '.claude/worktrees/w1/src/app.js', 'package-lock.json', 'web/lib.min.js', 'web/lib.js.map',
    'logs/run.txt', 'debug.log', 'gen/out.js', 'notes/gen/keep.js']) put(dir, p, 'chatId\n');
  put(dir, '.gitignore', '# commentaire\nlogs/\n*.log\n/gen\n');
  const r = await TOOLS.grep.run({ pattern: 'chatId' }, { cwd: dir });
  const files = r.output.split('\n').filter(l => /:\d+:/.test(l)).map(l => l.split(':')[0].replace(/\\/g, '/'));
  assert.deepEqual(files.sort(), ['notes/gen/keep.js', 'src/app.js']);
  // visé directement : fouillé quand même
  assert.match((await TOOLS.grep.run({ pattern: 'chatId', path: 'dist' }, { cwd: dir })).output, /app\.js:1:/);
  assert.match((await TOOLS.grep.run({ pattern: 'chatId', path: 'logs' }, { cwd: dir })).output, /run\.txt:1:/);
  assert.match((await TOOLS.grep.run({ pattern: 'chatId', glob: 'dist/**/*.js' }, { cwd: dir })).output, /app\.js:1:/);
  // list_dir montre toujours ces dossiers
  assert.match((await TOOLS.list_dir.run({ depth: 2 }, { cwd: dir })).output, /dist\/[\s\S]*app\.js/);
  // beaucoup de correspondances : une ligne par fichier
  const many = project();
  for (let i = 0; i < 10; i++) put(many, `m${i}.js`, Array.from({ length: 12 }, (_, k) => `const chatId${k} = '${'z'.repeat(250)}';`).join('\n'));
  const g = await TOOLS.grep.run({ pattern: 'chatId' }, { cwd: many });
  assert.match(g.output, /^120 correspondances dans 10 fichiers, regroupées par fichier :/);
  assert.match(g.output, /m0\.js \(12\) : l\.1, l\.2/);
  assert.match(g.output, /affine avec path ou glob/);
  assert.ok(g.output.length < 4000, `sortie de ${g.output.length} caractères`);
  const few = await TOOLS.grep.run({ pattern: 'chatId', glob: 'm1.js' }, { cwd: many });
  assert.match(few.output, /^m1\.js:1:const chatId0/, 'peu de correspondances : lignes complètes, comme avant');
});

// ── moteur-agent-contenu-objet ──
test('contenu envoyé comme objet : JSON pour un .json, refusé ailleurs (jamais « [object Object] »)', async () => {
  cfg.mode = 'auto';
  const pkg = normalizeArgs(TOOLS.write_file, { path: 'package.json', content: { name: 'demo', version: '1.0.0' } });
  assert.equal(pkg.args.content, '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  assert.deepEqual(pkg.invalid, []);
  const txt = normalizeArgs(TOOLS.write_file, { path: 'a.txt', content: { a: 1 } });
  assert.deepEqual(txt.invalid, ['content']);
  const dir = project();
  const r = await execCall(session(dir), { name: 'write_file', args: { path: 'a.txt', content: { a: 1 } } }, io(dir));
  assert.equal(r.ok, false);
  assert.match(r.output, /content doit être une chaîne de texte/);
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
  const e = await execCall(session(dir), { name: 'edit_file', args: { path: 'a.txt', old_string: ['x'], new_string: 'y' } }, io(dir));
  assert.match(e.output, /old_text doit être une chaîne/);
});

// ── cli-commandes-dossier-cible-silencieux (détection) ──
test('dossier cible : une trace d\'erreur ou « fichier:ligne » ne change pas le dossier ; un dossier du projet seulement pour une création', () => {
  const proj = fs.realpathSync(project());
  const src = path.join(proj, 'src'); fs.mkdirSync(src, { recursive: true });
  const api = path.join(src, 'api.js'); fs.writeFileSync(api, '');
  assert.equal(detectTargetDir(`TypeError: x\n    at run (${api}:45:12)\n    at main (${api}:3:1)`), null);
  assert.equal(detectTargetDir(`corrige ${api}:45`), null);
  assert.equal(detectTargetDir(`regarde "${api}:45:12"`), null);
  assert.equal(detectTargetDir(`crée un projet dans ${path.join(proj, 'neuf:3')}`), null, 'jamais un dossier à créer avec « : »');
  assert.equal(detectTargetDir(`modifie ${api} stp`), path.resolve(src), 'fichier cité sans ligne : inchangé (son dossier)');
  // côté décision (utilisé par la boucle de conversation)
  assert.equal(acceptTarget(src, { cwd: proj, text: `corrige ${api}` }), false, 'dossier déjà dans le dossier de travail : ignoré');
  assert.equal(acceptTarget(proj, { cwd: proj, text: 'travaille ici' }), false);
  assert.equal(acceptTarget(src, { cwd: proj, text: `regarde ${path.join(proj, 'work', 'new')}` }), false, 'mots dans un chemin : pas une demande de création');
  assert.equal(acceptTarget(path.join(proj, 'site'), { cwd: proj, text: `crée un site dans ${path.join(proj, 'site')}` }), true);
  assert.equal(acceptTarget(path.join(proj, 'site'), { cwd: proj, text: `écris la page dans ${path.join(proj, 'site')}` }), true);
  assert.equal(acceptTarget(path.join(tmp, 'ailleurs'), { cwd: proj, text: 'regarde ça' }), true, 'hors du dossier de travail : accepté');
  assert.equal(acceptTarget(null, { cwd: proj }), false);
  assert.match(targetNote(src), /^Dossier cible : .*les chemins relatifs y sont résolus/);
});

// ── cli-commandes-dossier-cible-silencieux (relecture) : verbes trop larges, format « fichier(ligne,col) » ──
test('dossier cible : « fais », « à la place », « copie », « save » ne déplacent pas la racine ; seule une vraie création ou un placement « dans <chemin> »', () => {
  const proj = fs.realpathSync(project());
  const src = path.join(proj, 'src'); fs.mkdirSync(src, { recursive: true });
  const out = path.join(proj, 'out'); fs.mkdirSync(out, { recursive: true });
  const api = path.join(src, 'api.js'); fs.writeFileSync(api, '');
  const decide = text => acceptTarget(detectTargetDir(text), { cwd: proj, text });
  // phrasés mesurés par la relecture : tous restaient « vrais »
  for (const t of [`corrige ${api} et fais passer les tests`, `le bug est dans ${api}, fais en sorte que ça marche`,
    `corrige ${api}, à la place de la boucle utilise map`, `regarde ${api} et copie la logique`, `corrige ${api} et save`,
    `crée un test pour ${api}`, `mets à jour ${api}`, `écris un test dans ${api}`]) assert.equal(decide(t), false, t);
  // même sans fichier : un dossier existant du projet, sans placement juste avant
  for (const t of [`corrige ${src} et fais passer les tests`, `regarde ${src}, à la place de la boucle utilise map`, `regarde ${src} et crée un test`,
    `make sure ${src} compiles`, `la fonction init de ${src} plante, new approach please`]) assert.equal(decide(t), false, t);
  // placement juste avant « dans / in / into <chemin> » : accepté (c'est bien ce dossier qui est visé)
  assert.equal(decide(`mets-le dans ${out}`), true);
  assert.equal(decide(`copie les fichiers dans ${out} stp`), true);
  assert.equal(decide(`crée un composant React dans ${src}`), true);
  assert.equal(decide(`put the build in ${out}`), true);
  // le verbe porte sur un autre chemin que le dossier trouvé : refusé
  assert.equal(acceptTarget(src, { cwd: proj, text: `copie ${src} dans ${out}` }), false);
  // dossier à créer : vraie création, ou « fais / fabrique »
  assert.equal(decide(`crée le projet ${path.join(proj, 'appli')}`), true);
  assert.equal(decide(`nouveau projet : ${path.join(proj, 'appli2')}`), true);
  assert.equal(decide(`fais un site dans ${path.join(proj, 'vitrine')}`), true);
  assert.equal(decide(`regarde ${path.join(proj, 'vitrine')}`), false, 'dossier inexistant sans création');
  // fromFile explicite : jamais pour le dossier d'un fichier cité
  assert.equal(acceptTarget(src, { cwd: proj, text: `mets-le dans ${src}`, fromFile: true }), false);
  assert.equal(acceptTarget(src, { cwd: proj, text: `mets-le dans ${src}`, fromFile: false }), true);
  // hors du dossier de travail : toujours accepté, comme avant
  const ext = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'ext-')));
  assert.equal(decide(`corrige ${ext} et fais passer les tests`), true);
});

test('dossier cible : format des compilateurs Windows « fichier(ligne,col) » (tsc, MSBuild, csc) ignoré', () => {
  const proj = fs.realpathSync(project());
  const src = path.join(proj, 'src'); fs.mkdirSync(src, { recursive: true });
  const api = path.join(src, 'api.js'); fs.writeFileSync(api, '');
  assert.equal(detectTargetDir(`${api}(45,12): error TS2322: Type 'string' is not assignable to type 'number'.`), null);
  assert.equal(detectTargetDir(`${path.join(src, 'Program.cs')}(12): warning CS0168`), null);
  // fichier inexistant (dossier « à créer » sinon) : refusé aussi, même hors du dossier de travail
  const ailleurs = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-tsc-'));
  assert.equal(detectTargetDir(`${path.join(ailleurs, 'neuf', 'api.ts')}(45,12): error TS2322`), null);
  assert.equal(detectTargetDir(`crée un dossier ${path.join(ailleurs, 'x(2')} stp`), null, 'jamais un dossier à créer avec « ( » + chiffre');
  assert.equal(detectTargetDir(`crée un site dans ${path.join(ailleurs, 'site')}`), path.resolve(path.join(ailleurs, 'site')), 'dossier à créer normal : inchangé');
  fs.rmSync(ailleurs, { recursive: true, force: true });
});

// ── régression : dossiers générés sautés en silence ──
test('search_files / glob : les dossiers build, out, target… sautés sont signalés (non vides, non ignorés par .gitignore)', async () => {
  const dir = project();
  put(dir, 'src/out/keep.js', 'motcle\n');
  put(dir, 'lib/target/keep.js', 'motcle\n');
  put(dir, 'app/Library/a.php', 'motcle\n');
  fs.mkdirSync(path.join(dir, 'build'));                 // vide : rien à signaler
  put(dir, 'dist/bundle.js', 'motcle\n');
  put(dir, '.gitignore', 'dist/\n');                     // déjà ignoré par git : rien à signaler
  const r = await TOOLS.grep.run({ pattern: 'motcle' }, { cwd: dir });
  assert.match(r.output, /\(aucune correspondance\)/);
  const note = r.output.split('\n').find(l => l.startsWith('[dossiers ignorés'));
  assert.ok(note, r.output);
  for (const p of ['src/out', 'lib/target', 'app/Library']) assert.ok(note.includes(path.join(...p.split('/'))), `${p} dans « ${note} »`);
  assert.doesNotMatch(note, /build|dist/);
  assert.match(note, /vise-les avec path/);
  assert.match((await TOOLS.grep.run({ pattern: 'motcle', path: 'lib/target' }, { cwd: dir })).output, /keep\.js:1:/);
  const g = await TOOLS.glob.run({ pattern: '**/keep.js' }, { cwd: dir });
  assert.match(g.output, /\(aucun fichier\)\n\[dossiers ignorés : .*vise-les avec path/);
  // rien de sauté : pas d'avis
  const propre = project(); put(propre, 'a.js', 'motcle\n');
  assert.doesNotMatch((await TOOLS.grep.run({ pattern: 'motcle' }, { cwd: propre })).output, /dossiers ignorés/);
});
