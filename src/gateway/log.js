// Passerelle Claude Code : journal sur disque (HOME_DIR/gateway/gateway.log) avec rotation et masquage des secrets.
// Une ligne JSON par événement. Au-delà de maxBytes (2 Mo), le fichier devient <fichier>.1 (l'ancien .1 est remplacé)
// et un nouveau fichier commence. Avec debugDir (--fs-debug), les corps échangés sont écrits à part, masqués eux aussi.
// Le journal ne doit jamais casser la passerelle : aucune méthode ne lève d'exception.
import fs from 'node:fs';
import path from 'node:path';

const MASK = '***';

// Ordre important : les formes « clé: valeur » d'abord, puis les jetons reconnaissables où qu'ils soient.
const RULES = [
  // en-têtes et champs JSON sensibles : "authorization": "…", x-api-key: …, "token":"…", cookie=…
  [/((?:"|')?(?:authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|secret|password|passwd|cookie|set-cookie)(?:"|')?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|(?:(?:Bearer|Basic)\s+)?[^\s,;}&]+)/gi,
    (_, k, v) => k + (/^["']/.test(v) ? v[0] + MASK + v[0] : MASK)],
  // variables d'environnement : ANTHROPIC_AUTH_TOKEN=…, FS_SESSION_TOKEN=…, *_API_KEY=…, *_SECRET=…, *_PASSWORD=…
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD))(\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, (_, k, eq) => k + eq + MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (_, s) => `${s} ${MASK}`],
  [/(next-auth\.session-token|__Secure-next-auth\.session-token)=[^;\s"]+/gi, (_, k) => `${k}=${MASK}`],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, () => `sk-ant-${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, () => `sk-${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, () => `eyJ${MASK}`],
  [/\b(gh[pousr]_|github_pat_|xox[baprs]-|AIza|hf_|npm_)[A-Za-z0-9_-]{16,}/g, (_, p) => p + MASK],
];

/** Masque jetons, en-têtes Bearer, clés d'API, cookies de session et mots de passe dans un texte. */
export function redact(s) {
  let t = s == null ? '' : String(s);
  for (const [re, fn] of RULES) t = t.replace(re, fn);
  return t;
}

const SECRET_KEY = /^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|secret|password|passwd|cookie|set-cookie)$|(?:TOKEN|API_KEY|SECRET|PASSWORD)$/i;

/** Copie masquée d'une valeur JSON : clés sensibles remplacées par ***, chaînes passées par redact (le JSON reste valide). */
function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (!v || typeof v !== 'object' || depth > 40) return v;
  if (Array.isArray(v)) return v.map(x => redactDeep(x, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && x != null && x !== '' ? MASK : redactDeep(x, depth + 1);
  return o;
}

const stamp = () => new Date().toISOString();
const safeName = n => String(n || 'corps').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

/**
 * Ouvre le journal `file` (dossier créé au besoin, fichiers en 0600).
 * Renvoie { line(obj), debug(name, body), close() } ; line accepte un objet (une ligne JSON horodatée) ou un texte.
 */
export function createLog(file, { maxBytes = 2 * 2 ** 20, debugDir = null } = {}) {
  let fd = null, size = 0, closed = false, seq = 0;

  const open = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, 'a', 0o600);
    size = fs.fstatSync(fd).size;
  };
  const rotate = () => {
    try { fs.closeSync(fd); } catch {}
    fd = null;
    fs.renameSync(file, file + '.1');                                   // remplace l'ancien .1 (rotation sur deux fichiers)
    open();
  };

  function line(obj) {
    if (closed) return;
    try {
      const rec = obj && typeof obj === 'object' ? { t: stamp(), ...obj } : { t: stamp(), msg: String(obj ?? '') };
      const text = JSON.stringify(redactDeep(rec)) + '\n';
      const n = Buffer.byteLength(text);
      if (fd === null) open();
      if (size > 0 && size + n > maxBytes) rotate();
      fs.writeSync(fd, text);
      size += n;
    } catch { /* journal indisponible : on continue sans */ }
  }

  function debug(name, body) {
    if (!debugDir || closed) return;
    try {
      fs.mkdirSync(debugDir, { recursive: true });
      let text = typeof body === 'string' ? redact(body) : JSON.stringify(redactDeep(body), null, 2) ?? '';
      if (text.length > maxBytes) text = text.slice(0, maxBytes) + '\n[… coupé]';
      const f = path.join(debugDir, `${stamp().replace(/[:.]/g, '-')}-${String(++seq).padStart(4, '0')}-${safeName(name)}.txt`);
      fs.writeFileSync(f, text, { mode: 0o600 });
    } catch { /* idem */ }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    fd = null;
  }

  return { line, debug, close };
}
