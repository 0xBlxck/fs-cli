#!/usr/bin/env node
// Scanner de secrets et de données personnelles — à lancer avant chaque commit / publication.
//   node scripts/scan.mjs            → fichiers suivis par git (ou tout le dossier si ce n'est pas un dépôt)
//   node scripts/scan.mjs --staged   → seulement ce qui est en cours de commit (utilisé par le hook .githooks/pre-commit)
// Code de sortie 1 s'il trouve quelque chose. Les valeurs trouvées ne sont JAMAIS affichées en entier.
// Pour ignorer une ligne précise (ex. fausse clé de test) : y mettre le commentaire « scan-ignore ».
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSecrets } from '../src/permissions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staged = process.argv.includes('--staged');

// ── liste des fichiers ────────────────────────────────────────────────────────
function listFiles() {
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  try { return staged ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']) : git(['ls-files']); }
  catch {
    const out = [];
    const walk = d => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const rel = path.join(d, e.name);
      e.isDirectory() ? walk(rel) : out.push(rel.replace(/\\/g, '/'));
    } };
    walk('');
    return out;
  }
}

// ── secrets locaux connus : leur valeur exacte ne doit apparaître nulle part ─
function localSecrets() {
  const vals = new Set();
  const grab = text => { for (const m of text.matchAll(/^\s*﻿?\s*FS_(?:SESSION_TOKEN|PASSWORD)\s*=\s*["']?([^\s"']+)/gm)) if (m[1].length >= 8 && !/colle|ton-|ici|xxxx/i.test(m[1])) vals.add(m[1]); };
  for (const f of [path.join(ROOT, '.env'), path.join(os.homedir(), '.fs-cli', '.env')]) { try { grab(fs.readFileSync(f, 'utf8')); } catch {} }
  for (const k of ['FS_SESSION_TOKEN', 'FS_PASSWORD']) if (process.env[k]?.length >= 8) vals.add(process.env[k]);
  return [...vals];
}

const FORBIDDEN_NAME = [
  [/(^|\/)\.env($|\.(?!example$|sample$))/i, 'fichier .env (secrets)'],
  [/\.(pem|key|pfx|p12|kdbx|keystore|jks)$/i, 'clé / certificat'],
  [/(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|$)/i, 'identifiants'],
  [/(^|\/)(sessions|chats|profile|permissions|history)\.(json|txt)$/i, 'données utilisateur du CLI (~/.fs-cli)'],
];
const SAFE_HOME_NAMES = new Set(['moi', 'toi', 'user', 'users', 'you', 'name', 'nom', 'alice', 'bob', 'username', 'public', 'default', 'me', 'example', 'foo', 'x', 'a', 'proj']);

const entropy = s => { const f = {}; for (const ch of s) f[ch] = (f[ch] || 0) + 1; return -Object.values(f).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0); };
const mask = s => (s.length <= 6 ? '***' : s.slice(0, 3) + '…(' + s.length + ' car.)');

const hits = [];
const hit = (file, line, rule, sample) => hits.push({ file, line, rule, sample: mask(sample) });

const secrets = localSecrets();
for (const rel of listFiles()) {
  for (const [re, why] of FORBIDDEN_NAME) if (re.test(rel)) hit(rel, 0, why, rel);
  const abs = path.join(ROOT, rel);
  let buf; try { buf = fs.readFileSync(abs); } catch { continue; }
  if (buf.length > 2_000_000 || buf.subarray(0, 4096).includes(0)) continue;            // binaire / énorme : ignoré
  const text = buf.toString('utf8');
  for (const s of secrets) if (text.includes(s)) hit(rel, 0, 'TON TOKEN LOCAL est présent dans ce fichier', s);

  text.split(/\r?\n/).forEach((line, i) => {
    if (/scan-ignore/.test(line)) return;
    const n = i + 1;
    for (const f of scanSecrets(line)) hit(rel, n, `secret probable (${f.name})`, f.sample || line);
    for (const m of line.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) hit(rel, n, 'UUID (ressemble à un token ou un identifiant de conversation)', m[0]);
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) {
      if (/@(example\.(com|org|net)|users\.noreply\.github\.com|localhost)$/i.test(m[0]) || /^\w+@\d/.test(m[0])) continue;
      hit(rel, n, 'adresse e-mail', m[0]);
    }
    for (const m of line.matchAll(/(?:[A-Za-z]:\\+Users\\+|\/Users\/|\/home\/)([^\\\/\s"'`<>%$:*?|]+)/g)) {
      if (!SAFE_HOME_NAMES.has(m[1].toLowerCase())) hit(rel, n, 'chemin personnel (nom d\'utilisateur)', m[0]);
    }
    if (!/integrity|sha\d{3}|https?:\/\/\S{40,}/i.test(line)) {
      for (const m of line.matchAll(/[A-Za-z0-9+/_=-]{40,}/g)) {
        const t = m[0];
        if (!/^[A-Za-z]+$/.test(t) && !/^[-=_]+$/.test(t) && !/^[A-Za-z]+([-_][A-Za-z]+)+$/.test(t) && entropy(t) >= 4.5) hit(rel, n, 'chaîne à forte entropie (token ?)', t);
      }
    }
  });
}

if (!hits.length) { console.log('✓ scan de sécurité : rien trouvé' + (staged ? ' (fichiers en cours de commit)' : '') + (secrets.length ? ` — ${secrets.length} secret(s) local(aux) recherché(s) partout` : '')); process.exit(0); }
console.error(`✗ scan de sécurité : ${hits.length} problème(s)\n`);
for (const h of hits) console.error(`  ${h.file}${h.line ? ':' + h.line : ''}  —  ${h.rule}  [${h.sample}]`);
console.error('\nCorrige avant de publier. Fausse valeur de test volontaire : ajoute le commentaire « scan-ignore » sur la ligne.');
process.exit(1);
