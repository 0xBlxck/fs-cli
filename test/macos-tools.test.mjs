// macOS (et Linux) : serveurs « à la façon bash », groupes de processus, dossier cible, droits +x / liens, fichiers du Finder, clé de fraîcheur
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isServerCommand, guessPort, writeAtomic, keyOf, noteSeen, staleReason, resolveP, notOurServer, OPEN_HINT,
  SH_ARGS, macFindExe, startJob, stopJob, TOOLS,
} from '../src/tools.js';
import { detectTargetDir } from '../src/target.js';

const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const tmpDir = name => fs.mkdtempSync(path.join(os.tmpdir(), `fscli-${name}-`));
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const waitFor = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise(r => setTimeout(r, 100)); } return cond(); };

test('isServerCommand : formes bash (variables, venv, export, nohup, & final) et $env: de PowerShell', () => {
  for (const c of [
    'PORT=3001 npm run dev', 'NODE_ENV=development HOST="0.0.0.0" npm start',
    'source .venv/bin/activate && uvicorn main:app --reload', '. venv/bin/activate; flask run',
    'export PORT=4000 && npm start', 'cd back && source .venv/bin/activate && python3 manage.py runserver',
    'nohup npm run dev > dev.log 2>&1 &', 'npm run dev &', 'cd site && PORT=3001 nohup npx vite &', 'env PORT=5173 npx vite',
    '$env:PORT=3001; npm run dev',
  ]) assert.equal(isServerCommand(c), true, c);
  for (const c of [
    'PORT=3001 npm run build', 'source x.sh && rm -rf build', 'export A=1; npm test', 'nohup python3 script.py &',
    'rm -rf x; PORT=1 npm run dev', 'curl http://x & npm run dev',
  ]) assert.equal(isServerCommand(c), false, c);
  // formes déjà reconnues : inchangées
  for (const c of ['npx serve .', 'cd site; npm run dev', 'python -m http.server 8000']) assert.equal(isServerCommand(c), true, c);
});

test('guessPort : lit PORT=…', () => {
  assert.equal(guessPort('PORT=3001 npm run dev'), 3001);
  assert.equal(guessPort('$env:PORT=4100; npm start'), 4100);
  assert.equal(guessPort('export PORT="8081" && npm start'), 8081);
  assert.equal(guessPort('VITE_PORT=9 npx vite'), 5173);                     // une autre variable n'est pas le port
  assert.equal(guessPort('PORT=3001 npx vite --port 4000'), 4000);           // l'option explicite gagne
});

test('ouvrir une adresse : commande du système ; AirPlay (AirTunes) n\'est pas notre serveur', () => {
  assert.equal(OPEN_HINT, IS_WIN ? 'Start-Process <adresse> (ou start <adresse>)' : IS_MAC ? 'open <adresse>' : 'xdg-open <adresse>');
  assert.equal(notOurServer(new Headers({ server: 'AirTunes/770.8.1' })), true);
  assert.equal(notOurServer(new Headers({ server: 'Werkzeug/3.0.1 Python/3.12.1' })), false);
  assert.equal(notOurServer(new Headers()), false);
});

test('shell : -c sur Mac (pas de shell de connexion qui remet /usr/bin devant Homebrew), -lc sous Linux', () => {
  if (!IS_WIN) assert.deepEqual(SH_ARGS, IS_MAC ? ['-c'] : ['-lc']);
});

test('macFindExe : jamais le faux /usr/bin/python3 sans les outils Xcode', (t) => {
  if (IS_WIN) return t.skip('chemins POSIX');
  const dir = tmpDir('exe');
  const fake = path.join(dir, 'python3'); fs.writeFileSync(fake, '#!/bin/sh\n'); fs.chmodSync(fake, 0o755);
  const pathVar = `/usr/bin:${dir}`;
  const noCLT = macFindExe('python3', { pathVar, clt: () => false });
  assert.ok(!noCLT.includes('/usr/bin/python3'));
  assert.ok(noCLT.includes(fake));
  if (fs.existsSync('/usr/bin/python3')) assert.equal(macFindExe('python3', { pathVar, clt: () => true })[0], '/usr/bin/python3');
});

test('dossier cible : « /users », « /tmp » (un seul niveau) ignorés hors Windows ; dossier non inscriptible refusé', (t) => {
  if (IS_WIN) return t.skip('chemins POSIX');
  assert.equal(detectTargetDir('la route /users renvoie la liste des comptes'), null);
  assert.equal(detectTargetDir('mets les logs dans /tmp'), null);
  assert.equal(detectTargetDir('GET /api/users'), null);
  if (process.getuid?.() !== 0) {
    assert.equal(detectTargetDir('le dossier /usr/share est plein'), null);   // existe, mais on ne peut pas y écrire
    assert.equal(detectTargetDir('crée /usr/monprojet stp'), null);            // à créer dans un parent non inscriptible
  }
  const dir = tmpDir('target');
  assert.equal(detectTargetDir(`travaille dans ${dir} stp`), path.resolve(dir));   // dossier normal : toujours reconnu
});

test('writeAtomic garde les droits (+x)', (t) => {
  if (IS_WIN) return t.skip('pas de bit +x sous Windows');
  const dir = tmpDir('mode');
  const f = path.join(dir, 'build.sh');
  fs.writeFileSync(f, '#!/bin/sh\necho 1\n'); fs.chmodSync(f, 0o755);
  writeAtomic(f, '#!/bin/sh\necho 2\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(f, 'utf8'), '#!/bin/sh\necho 2\n');
});

test('writeAtomic écrit à travers un lien symbolique (le lien reste un lien)', (t) => {
  if (IS_WIN) return t.skip('liens symboliques : droits spéciaux sous Windows');
  const dir = tmpDir('link');
  const real = path.join(dir, 'real.conf'), link = path.join(dir, 'link.conf');
  fs.writeFileSync(real, 'a=1\n'); fs.chmodSync(real, 0o640);
  fs.symlinkSync(real, link);
  writeAtomic(link, 'a=2\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(real, 'utf8'), 'a=2\n');
  assert.equal(fs.statSync(real).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link.conf', 'real.conf']);   // pas de fichier temporaire oublié
});

test('clé de fraîcheur : NFC partout, insensible à la casse sous Windows et macOS', () => {
  const base = path.join(os.tmpdir(), 'fscli-key');
  assert.equal(keyOf(path.join(base, 'café.js')), keyOf(path.join(base, 'café.js')));
  const same = keyOf(path.join(base, 'App.js')) === keyOf(path.join(base, 'app.js'));
  assert.equal(same, IS_WIN || IS_MAC);
});

test('fichier modifié depuis la lecture : vu même si la casse du chemin change (Windows, macOS)', (t) => {
  if (!IS_WIN && !IS_MAC) return t.skip('disque sensible à la casse');
  const dir = tmpDir('fresh');
  const f = path.join(dir, 'App.js');
  fs.writeFileSync(f, 'a'); noteSeen(f);
  fs.writeFileSync(f, 'abc'); const later = new Date(Date.now() + 5000); fs.utimesSync(f, later, later);
  assert.ok(staleReason(path.join(dir, 'app.js')));
});

test('resolveP : chemin glissé depuis le Finder (« Mon\\ Projet ») → antislashs retirés hors Windows', (t) => {
  if (IS_WIN) return t.skip('antislash = séparateur sous Windows');
  const dir = tmpDir('drag');
  fs.mkdirSync(path.join(dir, 'Mon Projet'));
  assert.equal(resolveP('Mon\\ Projet', dir), path.join(dir, 'Mon Projet'));
  assert.equal(resolveP(`${dir}/Mon\\ Projet/neuf.txt`, '/'), path.join(dir, 'Mon Projet', 'neuf.txt'));   // fichier à créer dans un dossier glissé
  fs.mkdirSync(path.join(dir, 'a\\b'));
  assert.equal(resolveP('a\\b', dir), path.join(dir, 'a\\b'));                   // le nom existe tel quel : gardé
});

test('glob et list_dir : .DS_Store et ._* masqués hors Windows', async (t) => {
  if (IS_WIN) return t.skip('fichiers du Finder');
  const dir = tmpDir('junk');
  for (const f of ['.DS_Store', '._photo.png', 'photo.png']) fs.writeFileSync(path.join(dir, f), 'x');
  const g = await TOOLS.glob.run({ pattern: '*' }, { cwd: dir });
  assert.equal(g.output.trim(), 'photo.png');
  const l = await TOOLS.list_dir.run({}, { cwd: dir });
  assert.doesNotMatch(l.output, /DS_Store|\._photo/);
  assert.match(l.output, /photo\.png/);
});

test('délai dépassé : tout le groupe est tué, l\'outil rend la main (sous-processus en fond)', async (t) => {
  if (IS_WIN) return t.skip('groupes de processus POSIX');
  const t0 = Date.now();
  const r = await TOOLS.shell.run({ command: 'sleep 30 & sleep 30; wait', timeout: 1 }, { cwd: os.tmpdir() });
  assert.ok(Date.now() - t0 < 6000, `rendu en ${Date.now() - t0} ms`);
  assert.match(r.output, /délai dépassé/);
});

test('shell fini mais processus en fond qui garde le pipe : rendu ~1 s après la fin du shell', async (t) => {
  if (IS_WIN) return t.skip('groupes de processus POSIX');
  const t0 = Date.now();
  const r = await TOOLS.shell.run({ command: 'sleep 30 & echo pret', timeout: 60 }, { cwd: os.tmpdir() });
  assert.ok(Date.now() - t0 < 6000, `rendu en ${Date.now() - t0} ms`);
  assert.match(r.output, /pret/);
});

test('git ne lit jamais le clavier : GIT_TERMINAL_PROMPT=0 hors Windows', async (t) => {
  if (IS_WIN) return t.skip('Windows : Git Credential Manager, inchangé');
  const r = await TOOLS.shell.run({ command: 'echo "gtp=$GIT_TERMINAL_PROMPT"' }, { cwd: os.tmpdir() });
  assert.match(r.output, /gtp=0/);
});

test('stopJob arrête tout le groupe (npm → node), pas seulement le shell', async (t) => {
  if (IS_WIN) return t.skip('groupes de processus POSIX');
  const job = startJob('sleep 30 & sleep 30; wait', os.tmpdir());
  await new Promise(r => setTimeout(r, 300));
  assert.equal(groupAlive(job.child.pid), true);
  assert.equal(stopJob(job.id), true);
  assert.equal(await waitFor(() => !groupAlive(job.child.pid), 4000), true);
});
