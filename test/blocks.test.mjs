// Extraction des blocs (chemins avec espaces), dossier cible, plan de /team
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBlocks, panelBlocks } from '../src/blocks.js';
import { parseFenceInfo, captionFile } from '../src/fence.js';
import { detectTargetDir } from '../src/target.js';
import { buildPlan } from '../src/team.js';

const BS = String.fromCharCode(92);

test('parseFenceInfo : chemins avec espaces, guillemets, nom seul', () => {
  assert.deepEqual(parseFenceInfo('html index.html'), { lang: 'html', name: 'index.html' });
  assert.equal(parseFenceInfo('html HTML SITE' + BS + 'index.html').name, 'HTML SITE' + BS + 'index.html');
  assert.equal(parseFenceInfo('css HTML SITE/sous dossier/style.css').name, 'HTML SITE/sous dossier/style.css');
  assert.equal(parseFenceInfo('python title="mon script.py"').name, 'mon script.py');
  assert.equal(parseFenceInfo('notes.txt').name, 'notes.txt');
  assert.equal(parseFenceInfo('python').name, '');
  assert.equal(parseFenceInfo('js {1,3}').name, '');
  assert.equal(parseFenceInfo('bash').name, '');
  assert.equal(captionFile('Fichier `HTML SITE' + BS + 'index.html` :'), 'HTML SITE' + BS + 'index.html');
  assert.equal(captionFile('**style.css**'), 'style.css');
});

test('extractBlocks : la session collée (HTML SITE\\index.html) garde le dossier avec espace', () => {
  const txt = [
    'Voici :', '```bash', 'mkdir "C:' + BS + 'x' + BS + 'HTML SITE"', '```',
    '```html HTML SITE' + BS + 'index.html', '<h1>a</h1>', '```',
    '```css HTML SITE' + BS + 'style.css', 'h1{}', '```',
    '```javascript HTML SITE' + BS + 'script.js', 'console.log(1)', '```',
  ].join('\n');
  const b = extractBlocks(txt);
  assert.deepEqual(b.map(x => x.action + ':' + (x.name || x.lang)), ['shell:bash', 'write:HTML SITE' + BS + 'index.html', 'write:HTML SITE' + BS + 'style.css', 'write:HTML SITE' + BS + 'script.js']);
});

test('panneau : titre avec espaces', () => {
  const pb = panelBlocks({ parts: [{ type: 'tool-createDocument', input: { title: 'Mon Site/index.html', content: '<p>x</p>' } }] });
  assert.equal(pb[0].name, 'Mon Site/index.html'); assert.equal(pb[0].action, 'write');
});

test('detectTargetDir : chemin simple, avec espaces, entre guillemets, fichier, inexistant', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-tgt-'));
  const sp = path.join(tmp, 'HTML SITE'); fs.mkdirSync(sp);
  assert.equal(detectTargetDir(`écris un site dans ${tmp}`), path.resolve(tmp));
  assert.equal(detectTargetDir(`${sp} ya rien dedans`), path.resolve(sp));                 // espace dans le nom + mots après
  assert.equal(detectTargetDir(`mets-le dans "${sp}" stp.`), path.resolve(sp));
  assert.equal(detectTargetDir(`modifie ${path.join(tmp, 'a.txt')} please`), path.resolve(tmp));   // un fichier → son dossier
  const neuf = path.join(tmp, 'NOUVEAU');
  assert.equal(detectTargetDir(`crée un projet dans ${neuf}`), path.resolve(neuf));       // dossier à créer : le parent existe
  const neufSp = path.join(tmp, 'NOUVEAU DOSSIER');                                       // à créer, avec un espace
  assert.equal(detectTargetDir(`crée un site dans ${neufSp}`), path.resolve(neufSp));
  assert.equal(detectTargetDir(`crée un site dans ${neufSp}.`), path.resolve(neufSp));
  assert.equal(detectTargetDir(`crée un site dans ${neufSp} avec un header sympa`), path.resolve(neufSp));
  assert.equal(detectTargetDir(`mets-le dans ${path.join(tmp, 'NEUF')} stp`), path.resolve(path.join(tmp, 'NEUF')));
  assert.equal(detectTargetDir('rien ici'), null);
  assert.equal(detectTargetDir('dans Z:' + BS + 'inexistant' + BS + 'sous' + BS + 'dossier'), null);
});

test('buildPlan : « un site » sans fichiers → trio ; -n réparti ; message utile', () => {
  let r = buildPlan('je veux un site avec une vraie DA originale');
  assert.deepEqual(r.plan.map(p => p.files[0]), ['index.html', 'style.css', 'script.js']); assert.match(r.mode, /site web/);
  r = buildPlan('je veux un site avec une vraie DA originale', { n: 5 });
  assert.equal(r.plan.length, 3); assert.match(r.note, /about\.html/);
  r = buildPlan('je veux un site', { n: 2 });
  assert.equal(r.plan.length, 2);
  r = buildPlan('écris un script qui trie');
  assert.equal(r.plan.length, 1);
});
