// Mémoire : notes de projet, préprompt, faits appris (profil), compétences (skills)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR, ROOT, cfg } from './config.js';

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

const projectKey = cwd => crypto.createHash('sha1').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 12);
const projectDir = cwd => path.join(HOME_DIR, 'projects', projectKey(cwd));
const userProfileFile = path.join(HOME_DIR, 'profile.json');
const profileFile = (scope, cwd) => scope === 'projet' ? path.join(projectDir(cwd), 'profile.json') : userProfileFile;
const notesFile = cwd => path.join(projectDir(cwd), 'notes.json');

// ── Notes de projet ───────────────────────────────────────────────────────────
export function listNotes(cwd) {
  const d = readJson(notesFile(cwd), { path: path.resolve(cwd), notes: [] });
  return d.notes || [];
}
export function addNote(cwd, text) {
  const notes = listNotes(cwd);
  notes.push({ text: text.trim().slice(0, 600), added: new Date().toISOString() });
  writeJson(notesFile(cwd), { path: path.resolve(cwd), notes });
  return notes.length;
}
export function removeNote(cwd, n) {
  const notes = listNotes(cwd);
  if (!(n >= 1 && n <= notes.length)) return false;
  notes.splice(n - 1, 1);
  writeJson(notesFile(cwd), { path: path.resolve(cwd), notes });
  return true;
}

// ── Profil : préprompt + faits appris ─────────────────────────────────────────
const emptyProfile = () => ({ preprompt: '', facts: [], counts: {} });
export function loadProfile(scope, cwd) { return { ...emptyProfile(), ...readJson(profileFile(scope, cwd), {}) }; }
const saveProfile = (scope, cwd, p) => writeJson(profileFile(scope, cwd), p);

export function setPreprompt(scope, cwd, text) {
  const p = loadProfile(scope, cwd);
  p.preprompt = (text || '').trim().slice(0, 2000);
  saveProfile(scope, cwd, p);
}

// sujets récurrents détectés dans les demandes ; à partir de 3 mentions un sujet devient un fait pondéré
const TOPICS = [
  ['TypeScript', /\btypescript\b|\.tsx?\b/i], ['Python', /\bpython\b|\.py\b|\bpip\b/i], ['React', /\breact\b|\bjsx\b|\bnext\.?js\b/i],
  ['les tests', /\btests?\b|\bjest\b|\bpytest\b|\bvitest\b/i], ['la documentation', /\bdocumentation\b|\breadme\b/i], ['Git', /\bgit\b|\bcommit\b|\bbranche?\b/i],
  ['Roblox / Luau', /\broblox\b|\bluau\b/i], ['Node.js', /\bnode(\.js)?\b|\bnpm\b/i], ['HTML/CSS', /\bhtml\b|\bcss\b/i],
];
export function observe(text, cwd) {
  const p = loadProfile('utilisateur', cwd);
  let changed = false;
  for (const [topic, re] of TOPICS) {
    if (!re.test(text)) continue;
    p.counts[topic] = (p.counts[topic] || 0) + 1; changed = true;
    if (p.counts[topic] >= 3) {
      const fact = `Travaille souvent avec ${topic}`;
      const f = p.facts.find(x => x.fact === fact);
      if (f) f.weight = p.counts[topic]; else p.facts.push({ fact, weight: p.counts[topic] });
    }
  }
  if (changed) saveProfile('utilisateur', cwd, p);
}
export function learnFact(scope, cwd, fact) {
  const p = loadProfile(scope, cwd);
  const f = p.facts.find(x => x.fact.toLowerCase() === fact.toLowerCase());
  if (f) f.weight += 1; else p.facts.push({ fact: fact.trim().slice(0, 200), weight: 3 });
  saveProfile(scope, cwd, p);
}
export function forgetFact(scope, cwd, n) {
  const p = loadProfile(scope, cwd);
  const sorted = [...p.facts].sort((a, b) => b.weight - a.weight);
  const target = sorted[n - 1];
  if (!target) return false;
  p.facts = p.facts.filter(x => x !== target);
  saveProfile(scope, cwd, p);
  return true;
}

// ── Compétences (skills.json du CLI + ~/.fs-cli/skills.json) ──────────────────
export function loadSkills() {
  const base = readJson(path.join(ROOT, 'skills.json'), []);
  const user = readJson(path.join(HOME_DIR, 'skills.json'), []);
  const byId = new Map();
  for (const s of [...base, ...user]) if (s?.id) byId.set(s.id, s);
  return [...byId.values()];
}

// ── Bloc de contexte joint au 1er message d'une conversation ──────────────────
export function buildContextBlock(cwd) {
  const parts = [], bits = [];
  const pre = [loadProfile('utilisateur', cwd).preprompt, loadProfile('projet', cwd).preprompt].filter(Boolean);
  if (pre.length) { parts.push(`Instructions permanentes : ${pre.join(' / ')}`); bits.push('préprompt'); }

  const facts = [...loadProfile('utilisateur', cwd).facts, ...loadProfile('projet', cwd).facts].sort((a, b) => b.weight - a.weight).slice(0, 12);
  if (facts.length) { parts.push(`À propos de l'utilisateur : ${facts.map(f => f.fact).join(' ; ')}`); bits.push(`${facts.length} fait${facts.length > 1 ? 's' : ''}`); }

  const notes = listNotes(cwd).slice(-12);
  if (notes.length) { parts.push(`Notes du projet :\n${notes.map(n => '- ' + n.text).join('\n')}`); bits.push(`${notes.length} note${notes.length > 1 ? 's' : ''}`); }

  const active = loadSkills().filter(s => (cfg.skills || []).includes(s.id));
  if (active.length) { parts.push(`Compétences à appliquer :\n${active.map(s => `- ${s.name} : ${s.systemPrompt}`).join('\n')}`); bits.push(`${active.length} skill${active.length > 1 ? 's' : ''}`); }

  if (!parts.length) return { text: '', label: '' };
  return { text: `[Contexte de l'utilisateur — à respecter sans le commenter]\n${parts.join('\n')}`.slice(0, 4000), label: bits.join(' · ') };
}
