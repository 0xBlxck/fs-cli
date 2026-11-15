// Politique de sécurité : classe une commande ou un code (safe / ask / deny),
// règles « toujours autoriser » persistantes, chemins sensibles, détection de secrets.
//
// Analyse de TEXTE uniquement : rien n'est jamais exécuté ici.
// Entrées visées : scripts PowerShell / bash / cmd multi-lignes écrits par un modèle,
// et code Python / Node. Tokenisation tolérante (guillemets, here-strings, heredocs,
// sous-expressions, blocs), pas un vrai parseur : en cas de doute on préfère « ask ».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
//  Verdicts
// ═══════════════════════════════════════════════════════════════════════════
const RANK = { safe: 0, ask: 1, deny: 2 };
const MAX_FINDINGS = 400;
const MAX_DEPTH = 5;

function newCtx(cwd) {
  return { cwd: cwd || '', findings: [], depth: 0, budget: { n: 0 } };
}
function add(ctx, level, reason, key) {
  if (ctx.findings.length >= MAX_FINDINGS) return;
  ctx.findings.push({ level, reason, key: key || null });
}

/** Résume les constats : deny > ask > safe. `keys` = toutes les clés « ask » (la règle doit toutes les couvrir). */
function finalize(findings) {
  let deny = null;
  const asks = [];
  for (const f of findings) {
    if (f.level === 'deny') { deny = deny || f; } else if (f.level === 'ask') asks.push(f);
  }
  if (deny) return { level: 'deny', reason: deny.reason, key: null, keys: [] };
  if (asks.length) {
    const keys = [];
    const reasons = [];
    for (const f of asks) {
      if (f.key && !keys.includes(f.key)) keys.push(f.key);
      if (!reasons.includes(f.reason)) reasons.push(f.reason);
    }
    let reason = reasons[0];
    if (reasons.length > 1) reason += ` (+${reasons.length - 1} autre${reasons.length > 2 ? 's' : ''} : ${reasons.slice(1, 3).join(' ; ')}${reasons.length > 3 ? ' ; …' : ''})`;
    return { level: 'ask', reason, key: keys[0] || null, keys };
  }
  return { level: 'safe', reason: 'aucune opération risquée détectée', key: null, keys: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chemins sensibles
// ═══════════════════════════════════════════════════════════════════════════
const CODE_EXT_RE = /\.(py|js|mjs|cjs|ts|tsx|jsx|md|html|css|rb|go|rs|java|c|cpp|h|cs|php|lua|sh|ps1)$/i;

function sensitiveFileMatch(p) {
  if (!p || p.length > 400) return null;
  const s = String(p).replace(/^['"@]+|['"]+$/g, '').replace(/\\/g, '/');
  if (!s) return null;
  const segs = s.split('/').filter(Boolean);
  if (!segs.length) return null;
  const base = segs[segs.length - 1];
  const lb = base.toLowerCase();
  let m;
  if (/^\.env(\..*)?$/i.test(base) || /^[^/]+\.env$/i.test(base)) {
    if (!/\.(example|sample|template|dist|defaults?|tpl)$/i.test(base)) return { label: '.env', reason: 'fichier d\'environnement (.env)' };
  }
  if (lb === '.npmrc' || lb === '_npmrc') return { label: '.npmrc', reason: 'fichier .npmrc (jetons npm)' };
  if (lb === '.netrc' || lb === '_netrc') return { label: '.netrc', reason: 'fichier .netrc (identifiants)' };
  if (lb === '.pgpass') return { label: '.pgpass', reason: 'fichier .pgpass (mots de passe)' };
  if (lb === '.pypirc') return { label: '.pypirc', reason: 'fichier .pypirc (jetons PyPI)' };
  if (lb === '.git-credentials') return { label: 'git-credentials', reason: 'identifiants git (.git-credentials)' };
  if ((m = /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(?!.*\.pub$)/i.exec(base))) return { label: m[1].toLowerCase(), reason: `clé privée SSH (${base})` };
  if (/\.(pem|key|pfx|p12|ppk|jks|keystore|kdbx|gpg|asc)$/i.test(base) && !/\.pub$/i.test(base)) {
    const ext = /\.([a-z0-9]+)$/i.exec(base)[1].toLowerCase();
    const lab = ext === 'p12' ? '*.pfx' : `*.${ext}`;
    return { label: lab, reason: `fichier de clé ou certificat (${base})` };
  }
  if (/^(credentials?|secrets?)([._-][^/]*)?$/i.test(base) && !CODE_EXT_RE.test(base)) {
    return { label: /^cred/i.test(base) ? 'credentials' : 'secrets', reason: `fichier d'identifiants (${base})` };
  }
  if (/^(wallet\.dat|ntds\.dit|logins\.json|key[34]\.db)$/i.test(base)) return { label: base.toLowerCase(), reason: `fichier sensible (${base})` };
  if (/^(login data|cookies|web data|local state)$/i.test(base) && /\/(user data|profiles)\//i.test(s)) {
    return { label: 'browser-data', reason: 'données de navigateur (mots de passe / cookies)' };
  }
  for (const seg of segs.slice(0, -1).concat(segs.length ? [lb] : [])) {
    const l = seg.toLowerCase();
    if (l === '.ssh') return { label: '.ssh', reason: 'dossier .ssh (clés SSH)' };
    if (l === '.aws') return { label: '.aws', reason: 'dossier .aws (identifiants AWS)' };
    if (l === '.gnupg') return { label: '.gnupg', reason: 'dossier .gnupg (clés GPG)' };
    if (l === '.kube') return { label: '.kube', reason: 'dossier .kube (accès cluster)' };
    if (l === '.azure') return { label: '.azure', reason: 'dossier .azure (identifiants Azure)' };
    if (l === '.fs-cli') return { label: '.fs-cli', reason: 'dossier .fs-cli (règles, sessions et projets approuvés du CLI)' };
  }
  if (/(^|\/)\.docker\/config\.json$/i.test(s)) return { label: '.docker', reason: 'configuration Docker (jetons de registre)' };
  if (/(^|\/)gcloud\/(credentials|application_default_credentials)/i.test(s)) return { label: 'credentials', reason: 'identifiants gcloud' };
  return null;
}

const SYS_WIN_RE = /^(?:[a-z]:\\|\\\\\?\\[a-z]:\\)(?:windows|program files(?: \(x86\))?)(?:\\|$)/i;
const SYS_ENV_RE = /^(?:%|\$env:|\${env:)(?:windir|systemroot|programfiles(?:\(x86\))?)(?:%|}|\\|$)/i;
const SYS_NIX_RE = /^\/(?:etc|usr|bin|sbin|boot|lib|lib32|lib64|sys|proc|system|library)(?:\/|$)/i;
function systemPathMatch(p) {
  if (!p || p.length > 400) return null;
  const s = String(p).replace(/^['"]+|['"]+$/g, '');
  if (!s) return null;
  const win = s.replace(/\//g, '\\');
  if (SYS_WIN_RE.test(win) || SYS_ENV_RE.test(win)) return { label: 'system-path', reason: `dossier système (${s})` };
  if (SYS_NIX_RE.test(s.replace(/\\/g, '/'))) return { label: 'system-path', reason: `dossier système (${s})` };
  if (/^\/dev\/(?!null$|zero$|stdout$|stderr$|stdin$|tty$|urandom$|random$|fd\/)/.test(s)) return { label: 'system-path', reason: `périphérique (${s})` };
  return null;
}

/** Raison (français) si le chemin est sensible (identifiants, clés, dossier système), sinon null. */
export function sensitivePathReason(p) {
  if (p == null) return null;
  const s = String(p).trim();
  if (!s) return null;
  const f = sensitiveFileMatch(s);
  if (f) return `chemin sensible : ${f.reason}`;
  let expanded = s;
  const home = os.homedir();
  if (/^~(?=[\\/]|$)/.test(expanded)) expanded = home + expanded.slice(1);
  const sys = systemPathMatch(expanded);
  if (sys) return `chemin sensible : ${sys.reason}`;
  const f2 = sensitiveFileMatch(expanded);
  if (f2) return `chemin sensible : ${f2.reason}`;
  const abs = path.resolve(expanded).replace(/\\/g, '/').toLowerCase();
  const h = home.replace(/\\/g, '/').toLowerCase();
  if (abs === h) return 'chemin sensible : dossier personnel';
  const sys2 = systemPathMatch(path.resolve(expanded));
  if (sys2) return `chemin sensible : ${sys2.reason}`;
  return null;
}

// Cibles catastrophiques pour une suppression : racine, lecteur, dossier système, dossier personnel.
const CATA_VARS = new Set([
  '~', '$home', '${home}', '$env:userprofile', '${env:userprofile}', '$env:homepath', '$env:homedrive',
  '$env:systemdrive', '$env:systemroot', '$env:windir', '$env:programfiles', '${env:programfiles}', '$env:programdata',
  '%userprofile%', '%homepath%', '%homedrive%', '%systemdrive%', '%systemroot%', '%windir%', '%programfiles%',
  '%programfiles(x86)%', '%programdata%', '$pshome', '$env:public', '%public%'
]);
const CATA_WIN_RE = /^[a-z]:(?:\\(?:windows(?:\\system32)?|users|program files(?: \(x86\))?|programdata|recovery|boot|system volume information|\$recycle\.bin|users\\[^\\]+))?$/;
const CATA_NIX_RE = /^\\(?:etc|usr|bin|sbin|lib|lib32|lib64|boot|dev|proc|sys|var|opt|srv|system|library|applications|users|volumes|mnt|media|run|snap|root|home|(?:home|users)\\[^\\]+)$/;

function catastrophicNorm(v) {
  if (!v) return null;
  if (CATA_VARS.has(v)) return 'dossier système ou personnel';
  if (CATA_WIN_RE.test(v)) return /^[a-z]:$/.test(v) ? 'racine d\'un lecteur' : 'dossier système ou personnel';
  if (CATA_NIX_RE.test(v)) return 'dossier système ou personnel';
  return null;
}
function winish(cwd) { return /^[a-z]:[\\/]/i.test(cwd || '') || process.platform === 'win32'; }
function catastrophicReason(raw, cwd) {
  if (raw == null) return null;
  let v = String(raw).trim().toLowerCase().replace(/^['"]+|['"]+$/g, '');
  if (!v) return null;
  if (/^[\\/]+\*?$/.test(v)) return 'racine du système de fichiers';
  const relative = /^(?:\.{1,2}|\*|\.{1,2}[\\/]\*?|\*\.\*)$/.test(v);
  v = v.replace(/\//g, '\\').replace(/\\\*+(\.\*)?$/, '').replace(/\\\.$/, '').replace(/\\+$/, '');
  if (!relative) return catastrophicNorm(v);
  if (!cwd) return null;
  try {
    const base = raw.replace(/\*.*$/, '') || '.';
    const r = (winish(cwd) ? path.win32 : path.posix).resolve(cwd, base);
    const n = r.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
    if (n === os.homedir().toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')) return 'dossier personnel';
    if (!n) return 'racine du système de fichiers';
    return catastrophicNorm(n);
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tokenisation tolérante d'un script (PowerShell / bash / cmd)
// ═══════════════════════════════════════════════════════════════════════════
const BASH_HINT_RE = /\s\\;(?:\s|$)|^#!\s*\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|z|da)?sh|(?:^|[\n;])\s*(?:fi|done|esac)\s*(?:[;\n]|$)|\$\(\(|\[\[\s|;;\s*(?:\n|$)|\bthen\s*(?:\n|$)/m;
const PS_HINT_RE = /\$env:|\b(?:Get|Set|Remove|New|Write|Select|Where|ForEach|Out|Invoke|Start|Stop|Test|Copy|Move|Add|Import|Export|Join|Split)-[A-Z]\w+|\$_\b|@['"][ \t]*\r?\n|\[[\w.]+\]::|-(?:Recurse|Force|Path|LiteralPath)\b/i;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const MID_BRACE_OPENERS = new Set(['%', '?', 'foreach', 'foreach-object', 'where-object', 'else', 'try', 'finally', 'do', 'begin', 'process', 'end', 'catch', 'then', 'elseif', 'switch', 'sort-object', 'start-job']);

function mkStmt(pipePrev) {
  return { words: [], pipePrev: pipePrev || null, kids: [], heredoc: null, h: null };
}

function matchParen(src, openIdx) {
  // openIdx : position de '(' ; renvoie la position de ')' correspondant (ou la fin).
  let depth = 0;
  const n = src.length;
  for (let j = openIdx; j < n; j++) {
    const c = src[j];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
    else if (c === "'") { const e = src.indexOf("'", j + 1); if (e < 0) return n - 1; j = e; }
    else if (c === '"') {
      let k = j + 1;
      while (k < n && src[k] !== '"') { if (src[k] === '`' || (src[k] === '\\' && src[k + 1] === '"')) k++; k++; }
      j = k;
    }
  }
  return n - 1;
}

function tokenize(src, forceBash) {
  const n = src.length;
  const bash = typeof forceBash === 'boolean' ? forceBash : (BASH_HINT_RE.test(src) && !PS_HINT_RE.test(src));
  const all = [];
  const stack = [];
  let frameStmts = [];
  let cur = mkStmt();
  let wb = null;
  let redir = null;
  const pending = [];

  const startWord = () => { if (!wb) wb = { t: '', bare: false, sq: false, dq: false, here: false, dyn: false, subs: [], digits: true }; return wb; };
  function flush() {
    if (!wb) return;
    const w = wb; wb = null;
    let q = 'b';
    const kinds = (w.bare ? 1 : 0) + (w.sq ? 1 : 0) + (w.dq ? 1 : 0) + (w.here ? 1 : 0);
    if (w.here) q = 'h'; else if (kinds > 1) q = 'm'; else if (w.sq) q = 's'; else if (w.dq) q = 'd';
    if (q !== 's' && !w.dyn && w.t.indexOf('%') >= 0 && /%[A-Za-z_][\w()]*%/.test(w.t)) w.dyn = true;
    const out = { t: w.t, q, dyn: w.dyn, subs: w.subs, redir: null };
    if (redir) { out.redir = redir; redir = null; }
    cur.words.push(out);
  }
  function endStmt(sep) {
    flush();
    if (cur.words.length || cur.heredoc) {
      frameStmts.push(cur); all.push(cur);
      const prev = cur;
      cur = mkStmt(sep === '|' ? prev : null);
    } else if (sep !== '|' && sep !== '\n') cur.pipePrev = null;
    redir = null;
  }
  function open() {
    flush();
    stack.push({ stmts: frameStmts, parent: cur });
    frameStmts = [];
    cur = mkStmt();
    redir = null;
  }
  function close() {
    endStmt(';');
    const fr = stack.pop();
    const kids = frameStmts;
    cur = fr.parent;
    frameStmts = fr.stmts;
    for (const k of kids) { for (const w of k.words) cur.words.push(w); cur.kids.push(k); }
  }

  let i = 0;
  while (i < n) {
    const ch = src[i];

    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      flush();
      if (pending.length) {
        let pos = i + 1;
        for (const p of pending) {
          const bodyStart = pos;
          let found = false;
          while (pos <= n) {
            let eol = src.indexOf('\n', pos);
            if (eol < 0) eol = n;
            let line = src.slice(pos, eol);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if ((p.dash ? line.replace(/^\t+/, '') : line) === p.delim) {
              p.stmt.heredoc = { text: src.slice(bodyStart, pos), quoted: p.quoted };
              pos = eol + 1; found = true; break;
            }
            pos = eol + 1;
            if (eol >= n) break;
          }
          if (!found) { p.stmt.heredoc = { text: src.slice(bodyStart), quoted: p.quoted }; pos = n; }
        }
        pending.length = 0;
        i = pos;
        endStmt('\n');
        continue;
      }
      endStmt('\n');
      i++; continue;
    }
    if (ch === ' ' || ch === '\t') { flush(); i++; continue; }

    if (!wb) {
      if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (ch === '<' && src[i + 1] === '#' && !bash) {
        const e = src.indexOf('#>', i + 2);
        i = e < 0 ? n : e + 2; continue;
      }
      if (ch === '@' && (src[i + 1] === "'" || src[i + 1] === '"')) {
        const m = /^[ \t]*\r?\n/.exec(src.slice(i + 2, i + 40));
        if (m) {
          const quote = src[i + 1];
          const bodyStart = i + 2 + m[0].length;
          const re = quote === "'" ? /\r?\n'@/g : /\r?\n"@/g;
          re.lastIndex = bodyStart - 1 > 0 ? bodyStart - 1 : 0;
          const mm = re.exec(src);
          let body, next;
          if (mm) { body = src.slice(bodyStart, mm.index); next = mm.index + mm[0].length; } else { body = src.slice(bodyStart); next = n; }
          const w = startWord();
          w.here = true; w.t += body; w.digits = false;
          if (quote === '"') {
            if (/\$[A-Za-z_{(]/.test(body)) w.dyn = true;
            let k = body.indexOf('$(');
            while (k >= 0 && w.subs.length < 50) {
              const e = matchParen(body, k + 1);
              w.subs.push(body.slice(k + 2, e));
              k = body.indexOf('$(', e + 1);
            }
          }
          i = next; flush(); continue;
        }
      }
    }

    if (ch === "'") {
      const w = startWord(); w.sq = true; w.digits = false;
      const e = src.indexOf("'", i + 1);
      if (e < 0) { w.t += src.slice(i + 1); i = n; } else { w.t += src.slice(i + 1, e); i = e + 1; }
      continue;
    }
    if (ch === '"') {
      const w = startWord(); w.dq = true; w.digits = false;
      let j = i + 1;
      while (j < n) {
        const c = src[j];
        if (c === '"') {
          if (!bash && src[j + 1] === '"') { w.t += '"'; j += 2; continue; }
          break;
        }
        if (c === '`' && !bash) { if (j + 1 < n) w.t += src[j + 1]; j += 2; continue; }
        if (bash && c === '\\' && j + 1 < n && (src[j + 1] === '"' || src[j + 1] === '\\' || src[j + 1] === '$' || src[j + 1] === '`')) { w.t += src[j + 1]; j += 2; continue; }
        if (bash && c === '`') {
          const e = src.indexOf('`', j + 1);
          const end = e < 0 ? n : e;
          w.subs.push(src.slice(j + 1, end)); w.dyn = true; w.t += src.slice(j, end + 1); j = end + 1; continue;
        }
        if (c === '$') {
          const nx = src[j + 1];
          if (nx === '(') {
            const e = matchParen(src, j + 1);
            w.subs.push(src.slice(j + 2, e)); w.dyn = true; w.t += src.slice(j, e + 1); j = e + 1; continue;
          }
          if (nx && /[A-Za-z_{?@*#!$0-9]/.test(nx)) w.dyn = true;
        }
        w.t += c; j++;
      }
      i = j + 1;
      continue;
    }

    if (ch === '`') {
      const w = startWord(); w.digits = false;
      if (bash) {
        const e = src.indexOf('`', i + 1);
        const end = e < 0 ? n : e;
        w.subs.push(src.slice(i + 1, end)); w.dyn = true; w.bare = true; w.t += src.slice(i, end + 1); i = end + 1; continue;
      }
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      if (i + 1 < n) { w.t += src[i + 1]; w.bare = true; }
      i += 2; continue;
    }
    if (ch === '\\') {
      const nx = src[i + 1];
      const contOk = bash || !wb || i === 0 || src[i - 1] === ' ' || src[i - 1] === '\t';
      if (contOk && nx === '\n') { i += 2; continue; }
      if (contOk && nx === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      const w = startWord(); w.bare = true; w.digits = false;
      if (bash && nx && (';|&()<>{}'.includes(nx) || nx === '"' || nx === "'" || nx === ' ')) { w.t += nx; i += 2; continue; }
      if (!bash && nx && '{}'.includes(nx)) { w.t += ch + nx; i += 2; continue; }
      w.t += ch; i++; continue;
    }
    if (ch === '$') {
      const nx = src[i + 1];
      if (nx === '(') {
        const w = startWord(); w.bare = true; w.digits = false;
        const e = matchParen(src, i + 1);
        w.subs.push(src.slice(i + 2, e)); w.dyn = true; w.t += src.slice(i, e + 1); i = e + 1; continue;
      }
      const w = startWord(); w.bare = true; w.digits = false;
      if (nx === '{') {
        const e = src.indexOf('}', i + 2);
        const end = e < 0 ? n - 1 : e;
        w.t += src.slice(i, end + 1); w.dyn = true; i = end + 1; continue;
      }
      if (nx && /[A-Za-z_?@*#!$0-9-]/.test(nx)) w.dyn = true;
      w.t += ch; i++; continue;
    }

    if (ch === ';') { endStmt(';'); i++; continue; }
    if (ch === '|') {
      if (src[i + 1] === '|') { endStmt('||'); i += 2; continue; }
      if (src[i + 1] === '&') { endStmt('|'); i += 2; continue; }
      endStmt('|'); i++; continue;
    }
    if (ch === '&') {
      if (src[i + 1] === '&') { endStmt('&&'); i += 2; continue; }
      if (src[i + 1] === '>') {
        flush(); i += 2; if (src[i] === '>') i++; redir = 'out'; continue;
      }
      endStmt('&'); i++; continue;
    }
    if (ch === '>' || ch === '<') {
      if (wb && wb.digits && /^(\d*|\*)$/.test(wb.t) && wb.bare) wb = null; else flush();
      if (ch === '<') {
        if (src[i + 1] === '<' && src[i + 2] === '<') { i += 3; continue; }
        if (src[i + 1] === '<') {
          let j = i + 2;
          let dash = false;
          if (src[j] === '-') { dash = true; j++; }
          while (src[j] === ' ' || src[j] === '\t') j++;
          let delim = '', quoted = false;
          if (src[j] === "'" || src[j] === '"') {
            const q = src[j]; const e = src.indexOf(q, j + 1);
            delim = src.slice(j + 1, e < 0 ? n : e); quoted = true; j = e < 0 ? n : e + 1;
          } else {
            if (src[j] === '\\') { j++; quoted = true; }
            const m = /^[A-Za-z0-9_.-]+/.exec(src.slice(j, j + 80));
            delim = m ? m[0] : ''; j += delim.length;
          }
          if (delim) { cur.heredoc = cur.heredoc || { text: '', quoted }; pending.push({ delim, dash, quoted, stmt: cur }); }
          i = j; continue;
        }
        if (src[i + 1] === '(') { i++; continue; }
        redir = 'in'; i++; continue;
      }
      // '>'
      i++;
      if (src[i] === '>') i++;
      else if (src[i] === '|') i++;
      if (src[i] === '&') {
        i++;
        while (i < n && /[0-9-]/.test(src[i])) i++;
        redir = null;
      } else redir = 'out';
      continue;
    }
    if (ch === '(') {
      if (wb && wb.t === '@' && !wb.sq && !wb.dq) wb = null;
      open(); i++; continue;
    }
    if (ch === ')') { flush(); if (stack.length) close(); else endStmt(';'); i++; continue; }
    if (ch === '{') {
      if (wb && wb.t === '@') { wb = null; open(); i++; continue; }
      if (!wb) { open(); i++; continue; }
      if (MID_BRACE_OPENERS.has(wb.t.toLowerCase())) { open(); i++; continue; }
      // accolade au milieu d'un mot : expansion {a,b} ou format, gardée dans le mot
      let depth = 0, j = i;
      while (j < n) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } else if (src[j] === '\n') break; j++; }
      const w = startWord(); w.bare = true; w.digits = false;
      w.t += src.slice(i, Math.min(j + 1, n)); i = Math.min(j + 1, n); continue;
    }
    if (ch === '}') { flush(); if (stack.length) close(); else endStmt(';'); i++; continue; }

    // caractère ordinaire : on avale la suite du mot d'un bloc
    const w = startWord(); w.bare = true;
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === "'" || c === '"' || c === '`' || c === '\\' || c === '$' || c === ';' || c === '|' || c === '&' || c === '>' || c === '<' || c === '(' || c === ')' || c === '{' || c === '}') break;
      j++;
    }
    if (j === i) j = i + 1;
    const chunk = src.slice(i, j);
    if (w.digits && !/^\d+$/.test(chunk) && chunk !== '*') w.digits = false;
    w.t += chunk; i = j;
  }
  flush();
  while (stack.length) close();
  endStmt(';');
  all.bash = bash;
  return all;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Résolution du nom de commande
// ═══════════════════════════════════════════════════════════════════════════
const SKIP_KW = new Set(['if', 'elif', 'elseif', 'else', 'then', 'fi', 'do', 'done', 'while', 'until', 'for', 'foreach', 'function', 'try', 'catch', 'finally', 'switch', 'begin', 'process', 'end', '!', 'time', 'nohup', 'builtin', 'exec', 'call', '.', 'esac', 'case', 'select']);
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-c', '-d', '-h', '-p', '-r', '-t', '-U', '-C', '-D', '-T']);

function cmdName(text) {
  let t = String(text).toLowerCase();
  const bs = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  if (bs >= 0 && bs < t.length - 1) t = t.slice(bs + 1);
  return t.replace(/\.(exe|com|cmd|bat)$/, '');
}

function resolveHead(words) {
  let i = 0, elev = null, guard = 0;
  const n = words.length;
  while (i < n && guard++ < 60) {
    const w = words[i];
    const lower = w.t.toLowerCase();
    if (w.q === 'b') {
      if (SKIP_KW.has(lower)) { i++; continue; }
      if (ASSIGN_RE.test(w.t)) { i++; continue; }
      if (w.t[0] === '$' && words[i + 1] && (words[i + 1].t === '=' || words[i + 1].t === '+=')) { i += 2; continue; }
      if (w.t[0] === '$' && /^\$[\w:.]+\+?=/.test(w.t)) { i++; continue; }
    }
    if (w.q === 'h' || w.t.indexOf('\n') >= 0) return { name: '', raw: '', idx: i, args: [], elev };
    const name = cmdName(w.t);
    if (name === 'sudo' || name === 'doas' || name === 'gsudo') {
      elev = elev || name; i++;
      while (i < n && words[i].t[0] === '-' && words[i].t.length > 1) {
        i += SUDO_VALUE_FLAGS.has(words[i].t) ? 2 : 1;
      }
      continue;
    }
    if (name === 'env') {
      i++;
      while (i < n && (words[i].t[0] === '-' || ASSIGN_RE.test(words[i].t))) { i += (words[i].t === '-u' || words[i].t === '-C' || words[i].t === '-S') ? 2 : 1; }
      continue;
    }
    if (name === 'nice' || name === 'ionice' || name === 'stdbuf' || name === 'setsid' || name === 'unbuffer' || name === 'timeout' || name === 'caffeinate') {
      i++;
      while (i < n && words[i].t[0] === '-') i += (words[i].t === '-n' || words[i].t === '-s' || words[i].t === '-c') ? 2 : 1;
      if (name === 'timeout' && i < n && /^[\d.]+[smhd]?$/.test(words[i].t)) i++;
      continue;
    }
    if (name === 'command' && words[i + 1] && /^-[vV]$/.test(words[i + 1].t)) return { name: 'command-v', raw: w.t, idx: i, args: [], elev };
    if (name === 'command') { i++; continue; }
    return { name, raw: w.t, idx: i, args: words.slice(i + 1), elev, rawLower: lower };
  }
  return { name: '', raw: '', idx: n, args: [], elev };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tables de commandes
// ═══════════════════════════════════════════════════════════════════════════
const DOWNLOADERS = new Set(['iwr', 'invoke-webrequest', 'curl', 'wget', 'irm', 'invoke-restmethod', 'start-bitstransfer', 'bitsadmin', 'certutil', 'aria2c', 'http', 'https', 'xh']);
const EXECUTORS = new Set(['iex', 'invoke-expression', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'powershell', 'pwsh', 'cmd', 'python', 'python3', 'py', 'pythonw', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'source', 'eval', 'cscript', 'wscript', 'mshta']);
const WEBCLIENT_RE = /webclient|downloadstring|downloaddata|\.openread|httpclient|net\.webrequest|invoke-webrequest|invoke-restmethod/i;
const DL_TEXT_RE = /(?:^|[\s;|&(`])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?(?=[\s;|&)`]|$)|downloadstring|webclient/i;
const EXEC_EXT_RE = /\.(exe|msi|ps1|bat|cmd|sh|dll|vbs|scr|hta|jar|msix|appx|reg|com|lnk|apk)$/i;
const PY_RE = /^(python[0-9.]*w?|py|pypy[0-9.]*)$/;
const PIP_RE = /^(pip[0-9.]*|pipx)$/;
const DEFENDER_SVC = new Set(['windefend', 'wdnissvc', 'sense', 'mpssvc', 'wscsvc', 'securityhealthservice', 'wdfilter', 'wdboot', 'wdnisdrv', 'bfe']);
const PRINT_HEADS = new Set(['echo', 'write-host', 'write-output', 'write-error', 'write-warning', 'write-verbose', 'write-information', 'printf', 'print', 'test-path', 'split-path', 'join-path', 'resolve-path', 'get-help', 'help', 'man', 'rem', 'command-v', 'type-v', 'test', '[', '[[']);
const WRITE_HEADS = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee-object', 'tee', 'new-item', 'ni', 'rename-item', 'ren', 'rni', 'mkdir', 'md', 'touch', 'cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'xcopy', 'robocopy', 'chmod', 'chown', 'ln', 'install', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'unlink', 'shred', 'mklink', 'export-csv', 'export-clixml']);
const REG_WRITE_HEADS = new Set(['set-itemproperty', 'sp', 'new-itemproperty', 'remove-itemproperty', 'clear-itemproperty', 'rename-itemproperty', 'copy-itemproperty', 'move-itemproperty', 'set-item', 'si', 'new-item', 'ni', 'clear-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'copy-item', 'cpi', 'cp', 'move-item', 'mi', 'mv', 'rename-item', 'ren', 'rni', 'regedit', 'reg']);
const REG_MACHINE_RE = /^(?:registry::)?(?:hklm|hkey_local_machine|hkcr|hkey_classes_root|hku|hkey_users|hkcc|hkey_current_config)(?::|\\|\/|$)/i;
const REG_USER_RE = /^(?:registry::)?(?:hkcu|hkey_current_user)(?::|\\|\/|$)/i;

const ASK_SIMPLE = new Map([
  ['install-module', ['installation de module PowerShell (Install-Module)', 'install-module']],
  ['uninstall-module', ['désinstallation de module PowerShell (Uninstall-Module)', 'uninstall-module']],
  ['update-module', ['mise à jour de module PowerShell (Update-Module)', 'update-module']],
  ['install-package', ['installation de paquet (Install-Package)', 'install-package']],
  ['uninstall-package', ['désinstallation de paquet (Uninstall-Package)', 'uninstall-package']],
  ['install-script', ['installation de script PowerShell (Install-Script)', 'install-script']],
  ['add-appxpackage', ['installation d\'application (Add-AppxPackage)', 'add-appxpackage']],
  ['remove-appxpackage', ['désinstallation d\'application (Remove-AppxPackage)', 'remove-appxpackage']],
  ['enable-windowsoptionalfeature', ['modification de fonctionnalités Windows', 'windows-feature']],
  ['disable-windowsoptionalfeature', ['modification de fonctionnalités Windows', 'windows-feature']],
  ['dism', ['modification du système (dism)', 'dism']],
  ['msiexec', ['installation / désinstallation MSI (msiexec)', 'msiexec']],
  ['setx', ['modification persistante de variable d\'environnement (setx)', 'setx']],
  ['regedit', ['modification du registre (regedit)', 'regedit']],
  ['register-scheduledtask', ['création de tâche planifiée (Register-ScheduledTask)', 'scheduled-task']],
  ['unregister-scheduledtask', ['suppression de tâche planifiée', 'scheduled-task']],
  ['set-scheduledtask', ['modification de tâche planifiée', 'scheduled-task']],
  ['new-service', ['création de service (New-Service)', 'new-service']],
  ['remove-service', ['suppression de service (Remove-Service)', 'remove-service']],
  ['new-netfirewallrule', ['règle de pare-feu (New-NetFirewallRule)', 'new-netfirewallrule']],
  ['set-netfirewallrule', ['règle de pare-feu (Set-NetFirewallRule)', 'set-netfirewallrule']],
  ['remove-netfirewallrule', ['règle de pare-feu (Remove-NetFirewallRule)', 'remove-netfirewallrule']],
  ['disable-netadapter', ['désactivation d\'une carte réseau', 'disable-netadapter']],
  ['enable-psremoting', ['activation de PowerShell Remoting', 'enable-psremoting']],
  ['new-localuser', ['création de compte local', 'localuser']],
  ['remove-localuser', ['suppression de compte local', 'localuser']],
  ['set-localuser', ['modification de compte local', 'localuser']],
  ['add-localgroupmember', ['modification de groupe local', 'localgroup']],
  ['clear-eventlog', ['effacement du journal d\'événements', 'clear-eventlog']],
  ['takeown', ['changement de propriétaire (takeown)', 'takeown']],
  ['cipher', ['cipher (chiffrement / effacement)', 'cipher']],
  ['logoff', ['fermeture de session (logoff)', 'logoff']],
  ['psexec', ['exécution à distance / élevée (psexec)', 'runas']],
  ['psexec64', ['exécution à distance / élevée (psexec)', 'runas']],
  ['runas', ['exécution sous un autre compte (runas)', 'runas']],
  ['su', ['élévation de privilèges (su)', 'sudo']]
]);

const DENY_SIMPLE = new Map([
  ['format-volume', 'formatage de disque (Format-Volume)'],
  ['clear-disk', 'effacement de disque (Clear-Disk)'],
  ['remove-partition', 'suppression de partition (Remove-Partition)'],
  ['initialize-disk', 'initialisation de disque (Initialize-Disk)'],
  ['diskpart', 'partitionnement de disque (diskpart)'],
  ['fdisk', 'partitionnement de disque (fdisk)'],
  ['sfdisk', 'partitionnement de disque (sfdisk)'],
  ['parted', 'partitionnement de disque (parted)'],
  ['wipefs', 'effacement de signatures de disque (wipefs)'],
  ['bcdedit', 'modification du démarrage Windows (bcdedit)'],
  ['shutdown', 'arrêt ou redémarrage de la machine (shutdown)'],
  ['restart-computer', 'arrêt ou redémarrage de la machine (Restart-Computer)'],
  ['stop-computer', 'arrêt ou redémarrage de la machine (Stop-Computer)'],
  ['reboot', 'arrêt ou redémarrage de la machine (reboot)'],
  ['poweroff', 'arrêt ou redémarrage de la machine (poweroff)'],
  ['halt', 'arrêt ou redémarrage de la machine (halt)'],
  ['telinit', 'changement de niveau d\'exécution (telinit)'],
  ['cmdkey', 'manipulation d\'identifiants Windows (cmdkey)'],
  ['mimikatz', 'outil de vol d\'identifiants (mimikatz)'],
  ['invoke-mimikatz', 'outil de vol d\'identifiants (Invoke-Mimikatz)'],
  ['pypykatz', 'outil de vol d\'identifiants (pypykatz)'],
  ['lazagne', 'outil de vol d\'identifiants (LaZagne)'],
  ['secretsdump', 'extraction d\'identifiants (secretsdump)'],
  ['vaultcmd', 'manipulation du coffre d\'identifiants (vaultcmd)'],
  ['ntdsutil', 'manipulation de la base Active Directory (ntdsutil)']
]);

// ═══════════════════════════════════════════════════════════════════════════
//  Analyse d'une commande résolue
// ═══════════════════════════════════════════════════════════════════════════
const HANDLERS = new Map();
function reg(names, fn) { for (const n of names) HANDLERS.set(n, fn); }

const lowerOf = (words) => words.map(w => w.t.toLowerCase());
const nonFlags = (words) => words.filter(w => !(w.t.length > 1 && w.t[0] === '-'));
const isLit = (w) => !w.dyn && w.subs.length === 0;
function firstNonFlag(words) { for (const w of words) if (!(w.t.length > 1 && w.t[0] === '-')) return w; return null; }
function hasForce(lower) {
  return lower.some(a => a === '-force' || a === '--force' || a === '-f' || /^-fo(r(c(e)?)?)?$/.test(a) || a === '/y' || /^-[a-z]{1,4}$/i.test(a) && /f/.test(a) && !/^-(?:fo|fi)/i.test(a));
}

function subStmt(words) { return { words, pipePrev: null, kids: [], heredoc: null, h: null }; }

function analyzeWords(words, ctx, parent) {
  if (!words.length) return;
  const st = subStmt(words);
  if (parent) { st.pipePrev = null; }
  st.h = resolveHead(words);
  analyzeStatement(st, ctx);
}

function analyzeScript(text, ctx) {
  if (ctx.depth >= MAX_DEPTH) { add(ctx, 'ask', 'imbrication de commandes trop profonde (code dynamique)', 'dynamic-code'); return; }
  if (++ctx.budget.n > 600) return;
  ctx.depth++;
  try {
    const stmts = tokenize(text);
    for (const st of stmts) st.h = resolveHead(st.words);
    for (const st of stmts) analyzeStatement(st, ctx);
    // Antislash / backtick ambigus entre PowerShell et bash : on relit avec l'autre lecture (pire cas retenu).
    if (/\\["'`]|\\\r?\n|`/.test(text)) {
      const alt = tokenize(text, !stmts.bash);
      for (const st of alt) st.h = resolveHead(st.words);
      for (const st of alt) analyzeStatement(st, ctx);
    }
  } finally { ctx.depth--; }
}

function kidsDownload(st) {
  for (const k of st.kids || []) {
    if (k.h && DOWNLOADERS.has(k.h.name)) return true;
    if (kidsDownload(k)) return true;
  }
  return false;
}
function sourceDownloads(st) {
  if (!st) return false;
  if (st.h && DOWNLOADERS.has(st.h.name)) return true;
  for (const w of st.words) {
    if ((w.q === 'b' || w.q === 'm') && WEBCLIENT_RE.test(w.t)) return true;
    if (w.subs.some(s => DL_TEXT_RE.test(s))) return true;
  }
  return kidsDownload(st);
}
function execHasInlineDownload(st) {
  for (const w of st.words) {
    if ((w.q === 'b' || w.q === 'm') && WEBCLIENT_RE.test(w.t)) return true;
    if (w.subs.some(s => DL_TEXT_RE.test(s))) return true;
  }
  return kidsDownload(st);
}

// Source littérale injectée sur stdin (heredoc, here-string ou echo).
function literalStdin(st) {
  if (st.heredoc && st.heredoc.text) return { text: st.heredoc.text, literal: true };
  const p = st.pipePrev;
  if (!p) return null;
  if (p.words.length === 1 && p.words[0].q === 'h') return { text: p.words[0].t, literal: !p.words[0].dyn };
  if (p.h && /^(echo|write-output|write-host|printf|cat)$/.test(p.h.name)) {
    const ws = nonFlags(p.h.args);
    if (ws.length >= 1 && ws.every(isLit) && p.h.name !== 'cat') return { text: ws.map(w => w.t).join(' '), literal: true };
  }
  return { text: '', literal: false };
}

function analyzeStatement(st, ctx) {
  const res = st.h || (st.h = resolveHead(st.words));
  const name = res.name;

  // pipeline : téléchargement → exécution
  if (name && EXECUTORS.has(name)) {
    let p = st.pipePrev, dl = false, guard = 0;
    while (p && guard++ < 50) { if (sourceDownloads(p)) { dl = true; break; } p = p.pipePrev; }
    const inlineDl = execHasInlineDownload(st);
    const isCodeRun = name === 'iex' || name === 'invoke-expression' || name === 'source' || name === 'eval' || name === 'bash' || name === 'sh' || name === 'zsh' || name === 'dash' || name === 'ksh' || name === 'fish' || name === 'ash' || name === 'powershell' || name === 'pwsh' || name === 'cmd' || PY_RE.test(name) || name === 'node' || name === 'perl' || name === 'ruby' || name === 'php' || name === 'deno' || name === 'bun';
    if (isCodeRun && (dl || inlineDl)) {
      add(ctx, 'deny', `exécution de code téléchargé (${res.raw}${dl ? ' ← téléchargement dans un pipe' : ' avec téléchargement intégré'})`);
    }
  }
  for (const w of st.words) { if (w.subs.length) for (const sub of w.subs) analyzeScript(sub, ctx); }
  if (!name) { scanNetPatterns(st, ctx); return; }

  const lower = lowerOf(res.args);
  if (lower.includes('-whatif')) return; // simulation PowerShell : rien n'est modifié

  const c = {
    ctx, st, res, name, raw: res.raw, args: res.args, lower,
    ask: (reason, key) => add(ctx, 'ask', reason, key),
    deny: (reason) => add(ctx, 'deny', reason)
  };
  if (res.elev) {
    const k = res.elev === 'gsudo' || res.elev === 'sudo' || res.elev === 'doas' ? 'sudo' : res.elev;
    c.ask(`élévation de privilèges (${res.elev})`, k);
  }

  if (DENY_SIMPLE.has(name)) { c.deny(DENY_SIMPLE.get(name)); }
  else if (/^mkfs(\..+)?$/.test(name)) c.deny(`formatage de disque (${res.raw})`);
  else if (ASK_SIMPLE.has(name)) { const [r, k] = ASK_SIMPLE.get(name); c.ask(r, k); }

  const h = HANDLERS.get(name);
  if (h) h(c);
  else if (PIP_RE.test(name)) pipHandler(c, c.args);

  // python -m pip / <dynamique> -m pip
  const mi = lower.indexOf('-m');
  if (mi >= 0 && lower[mi + 1] === 'pip' && !PIP_RE.test(name)) pipHandler(c, res.args.slice(mi + 2));

  registryCheck(c);
  scanWords(c);
  scanNetPatterns(st, ctx);
}

// ── registre ────────────────────────────────────────────────────────────────
function registryCheck(c) {
  if (!REG_WRITE_HEADS.has(c.name)) return;
  if (c.name === 'reg') return; // traité par son gestionnaire
  let machine = null, user = null;
  for (const w of c.args) {
    const t = w.t.replace(/^-\w+[:=]/, '');
    if (REG_MACHINE_RE.test(t)) machine = machine || t;
    else if (REG_USER_RE.test(t)) user = user || t;
  }
  if (machine) c.deny(`modification du registre machine (${machine.slice(0, 40)})`);
  else if (user) c.ask(`modification du registre utilisateur (${c.raw})`, c.name === 'regedit' ? 'regedit' : `registry:${aliasCanon(c.name)}`);
}
function aliasCanon(n) {
  const m = { sp: 'set-itemproperty', si: 'set-item', ni: 'new-item', ri: 'remove-item', rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item', cpi: 'copy-item', cp: 'copy-item', mi: 'move-item', mv: 'move-item', ren: 'rename-item', rni: 'rename-item', kill: 'stop-process', spps: 'stop-process', copy: 'copy-item', move: 'move-item' };
  return m[n] || n;
}

// ── mots sensibles (fichiers de secrets, chemins système en écriture) ───────
function scanWords(c) {
  const { name, args, ctx } = c;
  const printing = PRINT_HEADS.has(name);
  const writing = WRITE_HEADS.has(name);
  const seen = new Set();
  const allWords = c.st.words;
  const stWords = c.st === null ? args : args;
  void allWords; void stWords;
  const consider = (w, isRedirect) => {
    if (w.q === 'h') return;
    const t = w.t;
    if (!t || t.length > 300 || t.indexOf('\n') >= 0) return;
    if (printing && !isRedirect) return;
    const cands = [t];
    const eq = t.lastIndexOf('=');
    if (eq > 0 && t[0] === '-') cands.push(t.slice(eq + 1));
    else if (eq > 0 && eq < t.length - 1 && /^[\w.-]+=/.test(t)) cands.push(t.slice(eq + 1));
    if (t[0] === '-' && /^-[A-Za-z]{1,3}[^A-Za-z-]/.test(t)) cands.push(t.slice(2));
    for (const cand of cands) {
      const f = sensitiveFileMatch(cand);
      if (f && !seen.has(f.label)) { seen.add(f.label); c.ask(`accès à un fichier sensible : ${f.reason}`, `sensitive:${f.label}`); }
      if ((writing || isRedirect === 'out') && !seen.has('system-path')) {
        const s = systemPathMatch(cand);
        if (s) {
          // chemins système : pas de faux positif sur une simple lecture
          seen.add('system-path'); c.ask(`écriture / suppression dans un ${s.reason}`, 'sensitive:system-path');
        }
      }
      if ((isRedirect === 'out' || name === 'dd' || name === 'shred') && /^\/dev\/(sd|hd|nvme|vd|xvd|disk|mmcblk|rdisk)/i.test(cand)) c.deny(`écriture directe sur un disque (${cand})`);
      if (isRedirect === 'out' && /^\\\\\.\\(physicaldrive|[a-z]:)/i.test(cand)) c.deny(`écriture directe sur un disque (${cand})`);
    }
    if (EXEC_EXT_RE.test(t) && isRedirect === 'out' && DOWNLOADERS.has(name)) c.ask(`téléchargement d'un exécutable (${t})`, 'download-executable');
  };
  for (const w of args) consider(w, w.redir === 'out' ? 'out' : w.redir === 'in' ? 'in' : null);
  // cibles de redirection situées dans le statement mais avant la tête
  for (const w of c.st.words) if (w.redir && !args.includes(w) && w.t !== c.raw) consider(w, w.redir);
  void ctx;
}

// ── motifs .NET / PowerShell dans les mots nus ──────────────────────────────
function scanNetPatterns(st, ctx) {
  let bare = '';
  let quotedUserMachine = false;
  for (const w of st.words) {
    if (w.q === 'b') { bare += ' ' + w.t.toLowerCase(); }
    else if (w.q !== 'h' && /^(user|machine)$|(^|,)(user|machine)(,|$)|environmentvariabletarget/i.test(w.t)) quotedUserMachine = true;
  }
  if (!bare) { return; }
  if (bare.indexOf('::') < 0 && bare.indexOf('.') < 0) return;
  if (/\[(?:system\.)?io\.(?:file|directory)\]::delete/.test(bare) || /\[microsoft\.visualbasic\.fileio\.filesystem\]::delete/.test(bare)) {
    let cat = null;
    for (const w of st.words) { cat = cat || catastrophicReason(w.t, ctx.cwd); }
    if (cat) add(ctx, 'deny', `suppression de la racine ou d'un dossier système/personnel (${cat})`);
    else add(ctx, 'ask', 'suppression de fichiers ([IO.File]::Delete)', 'remove-item');
  }
  if (/\.(delete|deletedir)$/m.test(bare.split(' ').filter(Boolean).filter(x => /\.(delete|deletedir)$/.test(x)).join('\n')) && !/::delete/.test(bare)) {
    add(ctx, 'ask', 'suppression de fichiers (méthode .Delete())', 'remove-item');
  }
  if (/\.kill$/m.test(bare.split(' ').filter(x => /\.kill$/.test(x)).join('\n'))) add(ctx, 'ask', 'arrêt de processus (.Kill())', 'stop-process');
  if (bare.indexOf('win32shutdown') >= 0) add(ctx, 'deny', 'arrêt ou redémarrage de la machine (Win32Shutdown)');
  if (bare.indexOf('setenvironmentvariable') >= 0 && quotedUserMachine) add(ctx, 'ask', 'modification persistante de variable d\'environnement (SetEnvironmentVariable User/Machine)', 'setenvironmentvariable');
  if (/\[microsoft\.win32\.registry\]::setvalue|\[microsoft\.win32\.registry\]::deletesubkey/.test(bare)) {
    const machine = st.words.some(w => /hkey_local_machine|hkey_classes_root|hkey_users/i.test(w.t));
    if (machine) add(ctx, 'deny', 'modification du registre machine (Registry.SetValue)');
    else add(ctx, 'ask', 'modification du registre (Registry.SetValue)', 'registry:setvalue');
  }
}

// ── suppression ─────────────────────────────────────────────────────────────
reg(['rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'unlink', 'shred', 'rimraf', 'sdelete', 'sdelete64', 'srm', 'clear-recyclebin'], (c) => {
  const targets = [];
  for (const w of nonFlags(c.args)) for (const part of w.t.split(',')) if (part) targets.push(part);
  for (const t of targets) {
    const cat = catastrophicReason(t, c.ctx.cwd);
    if (cat) { c.deny(`suppression de la racine ou d'un dossier système/personnel (${c.raw} ${t} → ${cat})`); return; }
  }
  c.ask(`suppression de fichiers (${c.raw})`, 'remove-item');
});

// ── déplacement / copie forcés ──────────────────────────────────────────────
reg(['mv', 'move', 'move-item', 'mi'], (c) => {
  if (hasForce(c.lower)) c.ask(`déplacement avec écrasement forcé (${c.raw})`, 'move-item -force');
});
reg(['cp', 'copy', 'copy-item', 'cpi', 'xcopy'], (c) => {
  if (hasForce(c.lower)) c.ask(`copie avec écrasement forcé (${c.raw})`, 'copy-item -force');
});
reg(['robocopy'], (c) => {
  if (c.lower.some(a => a === '/mir' || a === '/purge' || a === '/move' || a === '/mov')) c.ask('robocopy en miroir / purge (supprime des fichiers à la destination)', 'robocopy /mir');
});
reg(['docker', 'podman'], (c) => {
  const l = c.lower;
  const sub = l.find(a => a[0] !== '-') || '';
  const rest = l.slice(l.indexOf(sub) + 1);
  if ((sub === 'system' || sub === 'volume' || sub === 'image' || sub === 'container' || sub === 'network') && (rest[0] === 'prune' || rest[0] === 'rm')) c.ask(`suppression Docker (${c.raw} ${sub} ${rest[0]})`, `docker ${sub} ${rest[0]}`);
  else if ((sub === 'rm' || sub === 'rmi') && rest.some(a => /^-[a-z]*f/.test(a) || a === '--force')) c.ask(`suppression Docker forcée (${c.raw} ${sub} -f)`, `docker ${sub} -f`);
});
reg(['kubectl', 'helm'], (c) => {
  const sub = c.lower.find(a => a[0] !== '-') || '';
  if (sub === 'delete' || sub === 'uninstall') c.ask(`suppression de ressources (${c.raw} ${sub})`, `${c.name} ${sub}`);
});
reg(['rsync'], (c) => {
  if (c.lower.some(a => a.startsWith('--delete'))) c.ask('rsync --delete (supprime des fichiers à la destination)', 'rsync --delete');
});

// ── processus ───────────────────────────────────────────────────────────────
reg(['stop-process', 'spps', 'kill'], (c) => {
  if (c.name === 'kill' && c.lower.some(a => a === '-l' || a === '-L')) return;
  c.ask(`arrêt de processus (${c.raw})`, 'stop-process');
});
reg(['taskkill', 'tskill'], (c) => c.ask(`arrêt de processus (${c.raw})`, 'taskkill'));
reg(['pkill', 'killall'], (c) => c.ask(`arrêt de processus (${c.raw})`, 'pkill'));

// ── services, tâches planifiées, réseau ─────────────────────────────────────
function defenderArg(c) { return c.lower.some(a => DEFENDER_SVC.has(a)); }
reg(['stop-service', 'restart-service', 'set-service'], (c) => {
  if (defenderArg(c)) { c.deny('désactivation de la protection Windows (service Defender / pare-feu)'); return; }
  c.ask(`modification de service (${c.raw})`, c.name);
});
const SC_SUBS = new Set(['config', 'delete', 'create', 'stop', 'pause', 'continue', 'failure', 'sdset', 'description', 'privs', 'triggerinfo']);
reg(['sc'], (c) => {
  const first = firstNonFlag(c.args);
  const sub = first ? first.t.toLowerCase() : '';
  const exe = /\.exe$/i.test(c.raw);
  if (!SC_SUBS.has(sub)) return; // Set-Content (alias PowerShell) ou sc query
  if (defenderArg(c)) { c.deny('désactivation de la protection Windows (service Defender / pare-feu)'); return; }
  void exe;
  c.ask(`modification de service (sc ${sub})`, `sc ${sub}`);
});
reg(['net', 'net1'], (c) => {
  const sub = (c.lower[0] || '');
  if (sub === 'stop') {
    if (defenderArg(c)) { c.deny('désactivation de la protection Windows (net stop)'); return; }
    c.ask('arrêt de service (net stop)', 'net stop'); return;
  }
  if ((sub === 'user' || sub === 'localgroup' || sub === 'accounts') && (c.args.length > 1)) c.ask(`modification de comptes (net ${sub})`, `net ${sub}`);
});
reg(['schtasks'], (c) => {
  const sub = c.lower.find(a => ['/create', '/delete', '/change', '/end', '/run'].includes(a));
  if (sub) c.ask(`gestion de tâche planifiée (schtasks ${sub})`, `schtasks ${sub}`);
});
reg(['systemctl'], (c) => {
  const sub = (firstNonFlag(c.args) || { t: '' }).t.toLowerCase();
  if (['poweroff', 'reboot', 'halt', 'kexec', 'suspend', 'hibernate'].includes(sub)) c.deny(`arrêt ou redémarrage de la machine (systemctl ${sub})`);
  else if (['stop', 'disable', 'mask', 'restart', 'kill', 'edit', 'set-default'].includes(sub)) c.ask(`gestion de service (systemctl ${sub})`, `systemctl ${sub}`);
});
reg(['service'], (c) => {
  if (c.lower.some(a => ['stop', 'restart'].includes(a))) c.ask('gestion de service (service)', 'service');
});
reg(['init'], (c) => { if (c.lower[0] === '0' || c.lower[0] === '6') c.deny(`arrêt ou redémarrage de la machine (init ${c.lower[0]})`); });
reg(['crontab'], (c) => {
  if (c.lower.includes('-l')) return;
  c.ask('modification de la crontab', c.lower.includes('-r') ? 'crontab -r' : 'crontab');
});
reg(['netsh'], (c) => {
  const l = c.lower;
  if ((l.includes('advfirewall') || l.includes('firewall')) && l.some(a => a === 'off' || a === 'disable')) { c.deny('désactivation du pare-feu Windows (netsh)'); return; }
  if (l.includes('advfirewall') && l.some(a => a === 'add' || a === 'delete' || a === 'set' || a === 'reset')) c.ask('modification du pare-feu Windows (netsh advfirewall)', 'netsh advfirewall');
});
reg(['set-mppreference', 'add-mppreference'], (c) => {
  const l = c.lower;
  for (let i = 0; i < l.length; i++) {
    if (/^-(disable|exclusion)/.test(l[i]) || /^-(maps?reporting|submitsamplesconsent)$/.test(l[i])) {
      const v = (l[i + 1] || '');
      if (/^-disable/.test(l[i]) && /^(\$false|0|false)$/.test(v)) continue; // réactivation
      c.deny(`désactivation / exclusion de Windows Defender (${c.raw} ${c.args[i].t})`); return;
    }
  }
});
reg(['set-netfirewallprofile'], (c) => {
  const i = c.lower.indexOf('-enabled');
  if (i >= 0 && /^(\$false|false|0|off)$/.test(c.lower[i + 1] || '')) c.deny('désactivation du pare-feu Windows (Set-NetFirewallProfile)');
});
reg(['vssadmin'], (c) => {
  if (c.lower.some(a => a === 'delete' || a === 'resize')) c.deny('suppression des clichés instantanés (vssadmin)');
});
reg(['wbadmin'], (c) => { if (c.lower.some(a => a === 'delete')) c.deny('suppression des sauvegardes (wbadmin)'); });
reg(['wmic'], (c) => {
  if (c.lower.includes('shadowcopy') && c.lower.includes('delete')) c.deny('suppression des clichés instantanés (wmic)');
  else if (c.lower.some(a => /shutdown|reboot/.test(a))) c.deny('arrêt ou redémarrage de la machine (wmic)');
});
reg(['procdump', 'procdump64'], (c) => { if (c.lower.includes('lsass') || c.lower.includes('lsass.exe')) c.deny('copie mémoire de lsass (vol d\'identifiants)'); });
reg(['rundll32'], (c) => { if (c.lower.some(a => a.includes('comsvcs') || a.includes('minidump'))) c.deny('copie mémoire de processus (vol d\'identifiants)'); });
reg(['wevtutil'], (c) => { if (c.lower.some(a => a === 'cl' || a === 'clear-log')) c.ask('effacement de journaux d\'événements', 'wevtutil cl'); });
reg(['set-executionpolicy'], (c) => {
  const i = c.lower.indexOf('-scope');
  if (i >= 0 && c.lower[i + 1] === 'process') return;
  c.ask('modification de la politique d\'exécution (Set-ExecutionPolicy)', 'set-executionpolicy');
});
reg(['format'], (c) => {
  if (c.lower.some(a => /^[a-z]:\\?$/.test(a) || a.startsWith('/fs:') || a === '/q' || a === '/y')) c.deny(`formatage de disque (format ${c.args[0] ? c.args[0].t : ''})`.trim());
});
reg(['dd'], (c) => {
  const of = c.lower.find(a => a.startsWith('of='));
  if (of && /^of=(\/dev\/(?!null$|zero$|stdout$|stderr$|tty$)|\\\\\.\\)/.test(of)) c.deny(`écriture brute sur un périphérique (${of})`);
});
reg(['chmod', 'chown', 'chgrp', 'icacls', 'attrib'], (c) => {
  const recursive = c.lower.some(a => a === '-r' || a === '--recursive' || a === '/t' || /^-[a-z]*r[a-z]*$/i.test(a) && !a.startsWith('--'));
  if (!recursive && c.name !== 'icacls') return;
  for (const w of nonFlags(c.args)) {
    const cat = catastrophicReason(w.t, c.ctx.cwd);
    if (cat && !/^\d+$/.test(w.t)) { c.deny(`modification récursive des droits sur ${cat} (${c.raw} ${w.t})`); return; }
  }
});

// ── registre : reg.exe ──────────────────────────────────────────────────────
reg(['reg'], (c) => {
  const sub = (c.lower[0] || '');
  if (!['add', 'delete', 'import', 'copy', 'load', 'unload', 'restore', 'save'].includes(sub)) return;
  const words = c.args.slice(1);
  const machine = words.find(w => REG_MACHINE_RE.test(w.t));
  if (machine) { c.deny(`modification du registre machine (reg ${sub} ${machine.t.slice(0, 40)})`); return; }
  if (sub === 'save' && words.some(w => /(^|\\)(sam|security|system)$/i.test(w.t))) { c.deny('extraction de ruches sensibles (reg save SAM/SYSTEM)'); return; }
  c.ask(`modification du registre (reg ${sub})`, `reg ${sub}`);
});

// ── élévation ───────────────────────────────────────────────────────────────
reg(['start-process', 'start', 'saps'], (c) => {
  // Start-Process cmd -ArgumentList '/c','rd /s /q …' : on analyse programme + arguments comme une commande
  const ai = c.lower.findIndex(a => a === '-argumentlist' || a === '-args');
  const progW = c.args.find(w => w.t[0] !== '-');
  if (progW) {
    const VAL = /^-(verb|workingdirectory|windowstyle|credential|redirectstandard\w+|filepath)$/i;
    const rest = [];
    const from = ai >= 0 ? ai + 1 : c.args.indexOf(progW) + 1;          // -ArgumentList explicite, sinon arguments en position
    for (let k = from; k < c.args.length; k++) {
      const w = c.args[k];
      if (VAL.test(w.t)) { k++; continue; }
      if (/^-(wait|nonewwindow|passthru|usenewenvironment|loaduserprofile)$/i.test(w.t)) continue;
      for (const t of w.t.split(',')) if (t) rest.push(t);              // tableau PowerShell « "/c","rd","/s" » : virgules = séparateurs
    }
    analyzeScript([progW.t, ...rest].join(' '), c.ctx);                 // commande reconstruite : « cmd /c rd /s /q … »
  }
  const i = c.lower.indexOf('-verb');
  if (i >= 0 && c.lower[i + 1] === 'runas') c.ask('lancement avec élévation (Start-Process -Verb RunAs)', 'runas');
  else if (c.lower.some(a => a === '-verb:runas' || a === '-verb=runas')) c.ask('lancement avec élévation (Start-Process -Verb RunAs)', 'runas');
});

// ── git ─────────────────────────────────────────────────────────────────────
reg(['git'], (c) => {
  const a = c.args;
  let i = 0;
  while (i < a.length && a[i].t[0] === '-') {
    i += (a[i].t === '-C' || a[i].t === '-c' || a[i].t === '--git-dir' || a[i].t === '--work-tree' || a[i].t === '--namespace') ? 2 : 1;
  }
  const sub = (a[i] ? a[i].t : '').toLowerCase();
  const rest = a.slice(i + 1);
  const rl = lowerOf(rest);
  const dry = rl.includes('-n') || rl.includes('--dry-run');
  switch (sub) {
    case 'push': {
      if (dry) return;
      const lease = rl.some(x => x === '--force-with-lease' || x.startsWith('--force-with-lease=') || x === '--force-if-includes');
      const force = rl.some(x => x === '--force' || (/^-[a-z]+$/.test(x) && x.includes('f')) || (x[0] === '+' && x.length > 1) || /^\+[^+]/.test(x));
      if (rl.includes('--mirror')) { c.deny('git push --mirror (écrase tout l\'historique distant)'); return; }
      if (force) { c.deny('git push --force (écrase l\'historique distant)'); return; }
      if (lease) { c.ask('git push --force-with-lease (réécrit l\'historique distant, avec garde-fou)', 'git push --force-with-lease'); return; }
      if (rl.includes('--delete') || rl.includes('-d') || rl.some(x => x.startsWith(':') && x.length > 1)) { c.ask('git push --delete (suppression de branche distante)', 'git push --delete'); return; }
      c.ask('git push (publie des commits sur le dépôt distant)', 'git push');
      return;
    }
    case 'filter-branch': case 'filter-repo': c.deny(`git ${sub} (réécriture de l'historique)`); return;
    case 'reset': if (rl.includes('--hard')) c.ask('git reset --hard (perte des modifications locales)', 'git reset --hard'); return;
    case 'clean': if (!dry) c.ask('git clean (supprime des fichiers non suivis)', 'git clean'); return;
    case 'checkout': {
      if (rl.includes('--') || rl.includes('.') || rl.includes('-f') || rl.includes('--force')) c.ask('git checkout -- (écrase les modifications locales)', 'git checkout --');
      return;
    }
    case 'switch': if (rl.some(x => x === '-f' || x === '--force' || x === '--discard-changes')) c.ask('git switch --discard-changes (écrase les modifications locales)', 'git checkout --'); return;
    case 'restore': {
      if (rl.includes('--staged') && !rl.includes('--worktree') && !rl.includes('-w')) return;
      c.ask('git restore (écrase les modifications locales)', 'git restore'); return;
    }
    case 'stash': if (rl[0] === 'drop' || rl[0] === 'clear') c.ask(`git stash ${rl[0]} (perte de modifications mises de côté)`, 'git stash drop'); return;
    case 'branch': if (rl.includes('-D') || rl.some(x => x === '-d' || x === '--delete') && rl.some(x => x === '-f' || x === '--force') || rest.some(x => x.t === '-D')) c.ask('git branch -D (suppression de branche)', 'git branch -D'); return;
    case 'rm': if (!rl.includes('--cached') && !dry) c.ask('git rm (suppression de fichiers suivis)', 'git rm'); return;
    case 'reflog': if (rl[0] === 'expire' || rl[0] === 'delete') c.ask('git reflog expire (perte d\'historique local)', 'git reflog expire'); return;
    case 'gc': case 'prune': if (rl.some(x => x.startsWith('--prune')) || sub === 'prune') c.ask('git gc --prune (suppression d\'objets)', 'git gc --prune'); return;
    case 'update-ref': if (rl.includes('-d')) c.ask('git update-ref -d (suppression de référence)', 'git update-ref -d'); return;
    default: return;
  }
});
reg(['gh'], (c) => {
  const l = c.lower;
  if (l[0] === 'auth' && l[1] === 'token') c.ask('affichage du jeton GitHub (gh auth token)', 'gh auth token');
  else if ((l[0] === 'repo' || l[0] === 'release') && l[1] === 'delete') c.ask(`suppression distante (gh ${l[0]} delete)`, `gh ${l[0]} delete`);
});

// ── gestionnaires de paquets ────────────────────────────────────────────────
function pipHandler(c, args) {
  const l = lowerOf(args);
  const sub = l.find(a => a[0] !== '-');
  if (c.name === 'pipx' && sub === 'run') { c.ask('téléchargement et exécution de code distant (pipx run)', 'pipx-run'); return; }
  if (sub === 'uninstall') c.ask('désinstallation de paquets Python (pip uninstall)', 'pip uninstall');
  else if (sub === 'install') {
    const rest = l.slice(l.indexOf('install') + 1);
    const local = rest.includes('-r') || rest.includes('--requirement') || rest.includes('-e') || rest.includes('--editable') || rest.every(a => a[0] === '-' || a === '.' || a === './' || a === '.\\');
    if (!local) c.ask('installation de paquets Python (pip install)', 'pip install');
  }
}
const OS_PKG = new Set(['winget', 'choco', 'scoop', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'brew', 'zypper', 'apk', 'snap', 'conda', 'mamba', 'flatpak', 'port', 'nix-env']);
const OS_PKG_SUBS = new Set(['install', 'uninstall', 'remove', 'upgrade', 'purge', 'add', 'reinstall', 'autoremove', 'erase', 'del', '-s', '-r', '-rs', '-syu', '-su']);
for (const n of OS_PKG) {
  reg([n], (c) => {
    const first = c.lower.find(a => a[0] !== '-' || /^-[a-z]+$/.test(a));
    if (first && OS_PKG_SUBS.has(first)) c.ask(`installation / désinstallation système (${c.raw} ${first})`, `${n} ${first === 'i' ? 'install' : first}`);
  });
}
reg(['dotnet'], (c) => {
  if (c.lower[0] === 'tool' && (c.lower[1] === 'install' || c.lower[1] === 'uninstall') && c.lower.some(a => a === '-g' || a === '--global')) c.ask(`outil .NET global (dotnet tool ${c.lower[1]} -g)`, `dotnet tool ${c.lower[1]} -g`);
});
const NPM_LIKE = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx'];
reg(NPM_LIKE, (c) => {
  const a = c.args;
  const l = c.lower;
  const name = c.name;
  const idx = l.findIndex(x => x[0] !== '-');
  const sub = idx >= 0 ? l[idx] : '';
  const global = l.some(x => x === '-g' || x === '--global' || x === '--location=global') || (l.includes('--location') && l[l.indexOf('--location') + 1] === 'global');
  if (name === 'npx' || name === 'pnpx' || name === 'bunx' || sub === 'exec' || sub === 'dlx' || (name !== 'npm' && sub === 'x' && name === 'bun')) {
    const offline = l.includes('--no-install') || l.includes('--no') || l.includes('--offline');
    if (!offline && (name === 'npx' || name === 'pnpx' || name === 'bunx' || sub === 'dlx' || (name === 'npm' && sub === 'exec') || (name === 'bun' && sub === 'x'))) {
      c.ask(`téléchargement et exécution de code distant (${name}${sub === 'dlx' || sub === 'exec' ? ' ' + sub : ''})`, 'npx-run');
    }
    // npx rimraf x : on juge aussi la commande lancée
    let j = name === 'npx' || name === 'pnpx' || name === 'bunx' ? 0 : idx + 1;
    while (j < a.length && a[j].t[0] === '-') { j += (a[j].t === '-p' || a[j].t === '--package' || a[j].t === '-c') ? 2 : 1; if (a[j - 1] && a[j - 1].t === '--') break; }
    if (j < a.length) analyzeWords(a.slice(j), c.ctx, c.st);
    return;
  }
  const canon = (s) => (s === 'i' || s === 'in' || s === 'ins' || s === 'install' ? 'install' : s);
  if (name === 'yarn' && sub === 'global') { c.ask('installation globale (yarn global)', 'yarn global'); return; }
  if (name === 'yarn' && sub === 'npm' && l[idx + 1] === 'publish') { c.ask('publication de paquet (yarn npm publish)', 'yarn publish'); return; }
  if (sub === 'publish') { c.ask(`publication de paquet (${name} publish)`, `${name} publish`); return; }
  if (['unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'token', 'login', 'logout', 'adduser', 'add-user'].includes(sub)) {
    c.ask(`compte / registre npm (${name} ${sub})`, `${name} ${sub}`); return;
  }
  if (global) {
    if (['install', 'i', 'in', 'ins', 'add'].includes(sub)) c.ask(`installation globale (${name} ${sub} -g)`, `${name} ${sub === 'add' ? 'add' : 'install'} -g`);
    else if (['uninstall', 'remove', 'rm', 'un', 'unlink', 'r'].includes(sub)) c.ask(`désinstallation globale (${name} ${sub} -g)`, `${name} uninstall -g`);
    else if (['update', 'up', 'upgrade'].includes(sub)) c.ask(`mise à jour globale (${name} ${sub} -g)`, `${name} update -g`);
  }
  void canon;
});
reg(['pnpm-global'], () => {});

// ── interpréteurs et exécution dynamique ────────────────────────────────────
function dynamicCode(c, what) { c.ask(`exécution de code dynamique (${what})`, 'dynamic-code'); }

function runLiteralShell(c, text, label) {
  analyzeScript(text, c.ctx);
  void label;
}

function stdinForInterpreter(c, lang) {
  const src = literalStdin(c.st);
  if (!src) return;
  if (src.text) {
    if (lang === 'python' || lang === 'node') judgeCodeInto(c.ctx, src.text, lang);
    else analyzeScript(src.text, c.ctx);
  } else if (!src.literal) dynamicCode(c, `${c.raw} lit un script sur l'entrée standard`);
}

reg(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash'], (c) => {
  const a = c.args;
  for (let i = 0; i < a.length; i++) {
    const t = a[i].t;
    if (/^-[a-z]*c$/i.test(t) && t !== '-') {
      const code = a[i + 1];
      if (!code) return;
      if (isLit(code)) analyzeScript(code.t, c.ctx);
      else {
        if (code.subs.some(s => DL_TEXT_RE.test(s))) c.deny(`exécution de code téléchargé (${c.raw} -c "$(…)")`);
        else dynamicCode(c, `${c.raw} -c <variable>`);
        for (const s of code.subs) analyzeScript(s, c.ctx);
      }
      return;
    }
    if (t[0] !== '-') return; // script lancé : rien à analyser ici
  }
  stdinForInterpreter(c, 'shell');
});
reg(['cmd'], (c) => {
  const a = c.args;
  const i = a.findIndex(w => /^\/[ckr]$/i.test(w.t));
  if (i < 0) return;
  const rest = a.slice(i + 1);
  if (!rest.length) return;
  if (rest.some(w => !isLit(w))) {
    if (rest.some(w => w.subs.some(s => DL_TEXT_RE.test(s)))) c.deny('exécution de code téléchargé (cmd /c)');
    else dynamicCode(c, 'cmd /c <variable>');
  }
  analyzeScript(rest.map(w => w.t).join(' '), c.ctx);
});
reg(['powershell', 'pwsh'], (c) => {
  const a = c.args;
  for (let i = 0; i < a.length; i++) {
    const t = a[i].t.toLowerCase();
    if (/^-(e|ec|enc|encodedcommand|encodedcomm\w*)$/.test(t)) { dynamicCode(c, `${c.raw} -EncodedCommand`); return; }
    if (/^-(c|co|com|comm|comma|comman|command)$/.test(t)) {
      const rest = a.slice(i + 1);
      if (!rest.length) return;
      if (rest.length === 1 && rest[0].t === '-') { stdinForInterpreter(c, 'shell'); return; }
      if (rest.some(w => !isLit(w))) {
        if (rest.some(w => w.subs.some(s => DL_TEXT_RE.test(s)))) c.deny(`exécution de code téléchargé (${c.raw} -Command)`);
        else dynamicCode(c, `${c.raw} -Command <variable>`);
        for (const w of rest) for (const s of w.subs) analyzeScript(s, c.ctx);
        return;
      }
      analyzeScript(rest.map(w => w.t).join(' '), c.ctx);
      return;
    }
    if (/^-(f|file)$/.test(t)) return;
  }
  stdinForInterpreter(c, 'shell');
});
reg(['wsl'], (c) => {
  const a = c.args;
  let j = 0;
  while (j < a.length && a[j].t[0] === '-') { const t = a[j].t.toLowerCase(); j += (t === '-d' || t === '--distribution' || t === '-u' || t === '--user' || t === '--cd') ? 2 : 1; if (t === '--') break; }
  if (j < a.length) analyzeWords(a.slice(j), c.ctx, c.st);
});
reg(['xargs'], (c) => {
  const a = c.args;
  let j = 0;
  while (j < a.length && a[j].t[0] === '-') { j += /^-(i|n|p|l|s|d|e|a|i)$/i.test(a[j].t) && a[j].t.length === 2 && a[j].t !== '-0' ? 2 : 1; }
  if (j < a.length) analyzeWords(a.slice(j), c.ctx, c.st);
});
reg(['find'], (c) => {
  const a = c.args;
  const l = c.lower;
  if (l.includes('-delete')) c.ask('find -delete (suppression de fichiers)', 'remove-item');
  for (let i = 0; i < a.length; i++) {
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(l[i])) {
      let j = i + 1;
      const cmd = [];
      while (j < a.length && a[j].t !== ';' && a[j].t !== '+' && a[j].t !== '\\') { cmd.push(a[j]); j++; }
      if (cmd.length) analyzeWords(cmd, c.ctx, c.st);
      i = j;
    }
  }
});

const PS_INLINE = new Set(['iex', 'invoke-expression']);
reg([...PS_INLINE], (c) => {
  const ws = nonFlags(c.args);
  const piped = c.st.pipePrev;
  if (ws.length === 1 && isLit(ws[0]) && !c.st.kids.length) { analyzeScript(ws[0].t, c.ctx); return; }
  if (!ws.length && piped) {
    const src = literalStdin(c.st);
    if (src && src.text) { analyzeScript(src.text, c.ctx); return; }
  }
  for (const w of ws) for (const s of w.subs) analyzeScript(s, c.ctx);
  c.ask(`exécution de code dynamique (${c.raw})`, 'invoke-expression');
});
reg(['eval'], (c) => {
  const ws = nonFlags(c.args);
  if (ws.length && ws.every(isLit)) { analyzeScript(ws.map(w => w.t).join(' '), c.ctx); return; }
  for (const w of ws) for (const s of w.subs) analyzeScript(s, c.ctx);
  c.ask('exécution de code dynamique (eval)', 'eval');
});

function inlineCodeOf(c, kind) {
  // renvoie {code:Word|null, found:boolean, script:boolean}
  const a = c.args;
  for (let i = 0; i < a.length; i++) {
    const t = a[i].t;
    const tl = t.toLowerCase();
    if (kind === 'python') {
      if (t === '-c' || (/^-[A-Za-z]*c$/.test(t) && !t.startsWith('--'))) return { code: a[i + 1] || null, found: true };
      if (t.startsWith('-m') || t === '-m') return { code: null, found: false, module: (t === '-m' ? (a[i + 1] ? a[i + 1].t : '') : t.slice(2)), rest: a.slice(i + 2) };
      if (t === '-W' || t === '-X') { i++; continue; }
      if (t[0] !== '-' || t === '-') return { code: null, found: false, script: t !== '-' };
    } else {
      if (tl === '-e' || tl === '--eval' || tl === '-p' || tl === '--print' || /^-[a-z]*[ep]$/i.test(t) && !t.startsWith('--') && t.length <= 4) return { code: a[i + 1] || null, found: true };
      if (tl.startsWith('--eval=') || tl.startsWith('--print=')) return { code: { t: t.slice(t.indexOf('=') + 1), q: 's', dyn: a[i].dyn, subs: a[i].subs }, found: true };
      if (t === '-r' || t === '--require' || t === '--import' || t === '--loader' || t === '-C' || t === '--conditions') { i++; continue; }
      if (t[0] !== '-' || t === '-') return { code: null, found: false, script: t !== '-' };
    }
  }
  return { code: null, found: false, script: false };
}
reg(['python', 'python3', 'py', 'pythonw'], (c) => runPython(c));
for (const v of ['python2', 'python3.8', 'python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13', 'python3.14', 'pypy', 'pypy3']) HANDLERS.set(v, (c) => runPython(c));
function runPython(c) {
  const r = inlineCodeOf(c, 'python');
  if (r.found) {
    if (!r.code) return;
    if (isLit(r.code)) judgeCodeInto(c.ctx, r.code.t, 'python'); else dynamicCode(c, `${c.raw} -c <variable>`);
    return;
  }
  if (r.module === 'pip') { pipHandler(c, r.rest || []); return; }
  if (r.module) return;
  if (!r.script) stdinForInterpreter(c, 'python');
}
reg(['node', 'nodejs'], (c) => {
  const r = inlineCodeOf(c, 'node');
  if (r.found) {
    if (!r.code) return;
    if (isLit(r.code)) judgeCodeInto(c.ctx, r.code.t, 'node'); else dynamicCode(c, 'node -e <variable>');
    return;
  }
  if (!r.script) stdinForInterpreter(c, 'node');
});
reg(['perl', 'ruby', 'php', 'lua', 'rscript', 'deno', 'bun'], (c) => {
  const l = c.lower;
  if (c.name === 'deno' && l[0] === 'eval') { dynamicCode(c, 'deno eval'); return; }
  if (c.name === 'deno' && l[0] === 'run' && l.some(a => /^https?:\/\//.test(a))) { c.ask('exécution de code distant (deno run <url>)', 'deno-remote'); return; }
  if (['perl', 'ruby'].includes(c.name) && l.some(a => a === '-e')) dynamicCode(c, `${c.raw} -e`);
  else if (c.name === 'php' && l.some(a => a === '-r')) dynamicCode(c, 'php -r');
  else if (c.name === 'rscript' && l.some(a => a === '-e')) dynamicCode(c, 'Rscript -e');
  else if (c.name === 'bun' && (l[0] === 'x' || l[0] === 'add' || l[0] === 'install' || l[0] === 'i' || l[0] === 'remove') ) {
    if ((l.includes('-g') || l.includes('--global')) && l[0] !== 'x') c.ask(`installation globale (bun ${l[0]} -g)`, `bun ${l[0] === 'add' ? 'add' : 'install'} -g`);
  }
});

reg(['uvx'], (c) => { c.ask('téléchargement et exécution de code distant (uvx)', 'uvx-run'); });
reg(['uv'], (c) => { if (c.lower[0] === 'tool' && c.lower[1] === 'run') c.ask('téléchargement et exécution de code distant (uv tool run)', 'uvx-run'); });
reg(['printenv'], (c) => { c.ask('affichage des variables d\'environnement (peuvent contenir des secrets)', 'env-dump'); });

// ── téléchargeurs ───────────────────────────────────────────────────────────
function downloadHandler(c) {
  const l = c.lower;
  const name = c.name;
  let writes = false;
  const psOut = l.some(a => /^-(ou|out|outf|outfi|outfil|outfile|destination|dest)$/.test(a));
  // curl : -o f, --output f, -O, -J, grappes courtes (-fsSLo f, -LO)
  const curlOut = c.args.some(w => w.t === '--output' || w.t === '--remote-name' || w.t === '--remote-header-name' || w.t.startsWith('--output=') || (/^-[A-Za-z]+$/.test(w.t) && /[oOJ]/.test(w.t)));
  if (name === 'curl' || name === 'xh' || name === 'http' || name === 'https') writes = curlOut || psOut;
  else if (name === 'wget') {
    const toStdout = l.includes('--output-document=-') || l.some((a, i) => (a === '-o' || a === '-O') && l[i + 1] === '-') || l.some(a => /^-[a-z]*o-$/.test(a));
    writes = !toStdout;
  } else if (name === 'iwr' || name === 'irm' || name === 'invoke-webrequest' || name === 'invoke-restmethod' || name === 'start-bitstransfer') writes = psOut || l.includes('-o');
  else if (name === 'certutil') writes = l.includes('-urlcache') || l.includes('-verifyctl');
  else if (name === 'bitsadmin') writes = l.includes('/transfer') || l.includes('/addfile');
  else if (name === 'aria2c') writes = true;
  if (!writes) return;
  for (const w of c.args) {
    if (w.q === 'h') continue;
    const t = w.t.replace(/[?#].*$/, '');
    if (EXEC_EXT_RE.test(t)) { c.ask(`téléchargement d'un exécutable sur le disque (${w.t.slice(0, 80)})`, 'download-executable'); return; }
  }
}
reg([...DOWNLOADERS], downloadHandler);

// ═══════════════════════════════════════════════════════════════════════════
//  Analyse de code Python / Node
// ═══════════════════════════════════════════════════════════════════════════
function unescapeStr(s) {
  if (s.indexOf('\\') < 0) return s;
  return s.replace(/\\([\s\S])/g, (m, c) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      case '`': return '`';
      case '\n': return '';
      default: return m;
    }
  });
}
const blank = (s) => s.replace(/[^\n]/g, ' ');

function lexPy(src) {
  const n = src.length;
  const parts = [];
  const lits = [];
  const litAt = new Map();
  let last = 0, i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      parts.push(src.slice(last, i), ' '.repeat(j - i)); last = j; i = j; continue;
    }
    if (c === '"' || c === "'") {
      let ps = i;
      while (ps > 0 && i - ps < 2 && /[rRbBuUfF]/.test(src[ps - 1])) ps--;
      if (ps > 0 && /\w/.test(src[ps - 1])) ps = i;
      const prefix = src.slice(ps, i).toLowerCase();
      const raw = prefix.includes('r');
      const fstr = prefix.includes('f');
      const q3 = c.repeat(3);
      const triple = src.startsWith(q3, i);
      const ql = triple ? 3 : 1;
      let j = i + ql;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (triple ? src.startsWith(q3, j) : src[j] === c) break;
        if (!triple && src[j] === '\n') break;
        j++;
      }
      const closed = j < n && (triple ? src.startsWith(q3, j) : src[j] === c);
      const end = closed ? j + ql : Math.min(j, n);
      const rawVal = src.slice(i + ql, Math.min(j, n));
      let value = raw ? rawVal : unescapeStr(rawVal);
      let dyn = false;
      if (fstr) {
        value = value.replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002');
        value = value.replace(/\{[^{}]*\}/g, () => { dyn = true; return '$var'; }).replace(/\u0001/g, '{').replace(/\u0002/g, '}');
      }
      const lit = { start: i, end, value, dyn };
      lits.push(lit); litAt.set(i, lit);
      parts.push(src.slice(last, ps), ' '.repeat(i - ps), c.repeat(ql), blank(src.slice(i + ql, Math.min(j, n))), closed ? c.repeat(ql) : '');
      last = end; i = end; continue;
    }
    i++;
  }
  parts.push(src.slice(last));
  return { masked: parts.join(''), lits, litAt };
}

const JS_REGEX_PREV_RE = /[(,=:[!&|?{};+\-*%<>~^]$/;
function lexJs(src) {
  const n = src.length;
  const parts = [];
  const lits = [];
  const litAt = new Map();
  let last = 0, i = 0;
  let prevSig = '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      parts.push(src.slice(last, i), ' '.repeat(j - i)); last = j; i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      parts.push(src.slice(last, i), blank(src.slice(i, j))); last = j; i = j; continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') {
      let j = src.indexOf('\n'); if (j < 0) j = n;
      parts.push(' '.repeat(j)); last = j; i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1, val = '', dyn = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { val += src.slice(j, j + 2); j += 2; continue; }
        if (ch === c) break;
        if (c !== '`' && ch === '\n') break;
        if (c === '`' && ch === '$' && src[j + 1] === '{') {
          let d = 1, k = j + 2;
          while (k < n && d > 0) { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; }
          val += '$var'; dyn = true; j = k; continue;
        }
        val += ch; j++;
      }
      const closed = j < n && src[j] === c;
      const end = closed ? j + 1 : Math.min(j, n);
      const lit = { start: i, end, value: unescapeStr(val), dyn };
      lits.push(lit); litAt.set(i, lit);
      parts.push(src.slice(last, i), c, blank(src.slice(i + 1, Math.min(j, n))), closed ? c : '');
      last = end; i = end; prevSig = 'a'; continue;
    }
    if (c === '/' && (prevSig === '' || JS_REGEX_PREV_RE.test(prevSig))) {
      let j = i + 1, inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      if (j < n && src[j] === '/') {
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;
        parts.push(src.slice(last, i), ' '.repeat(j - i)); last = j; i = j; prevSig = 'a'; continue;
      }
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prevSig = c;
    i++;
  }
  parts.push(src.slice(last));
  return { masked: parts.join(''), lits, litAt };
}

function splitCall(masked, openIdx) {
  const n = masked.length;
  const args = [];
  let depth = 0, argStart = openIdx + 1;
  for (let j = openIdx; j < n; j++) {
    const ch = masked[j];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { args.push({ s: argStart, e: j }); return { args, close: j }; }
    } else if (ch === ',' && depth === 1) { args.push({ s: argStart, e: j }); argStart = j + 1; }
  }
  args.push({ s: argStart, e: n });
  return { args, close: n };
}
function trimR(masked, s, e) {
  while (s < e && /\s/.test(masked[s])) s++;
  while (e > s && /\s/.test(masked[e - 1])) e--;
  return { s, e };
}
function renderExpr(masked, litAt, s0, e0) {
  const pieces = [];
  let k = s0;
  while (k < e0) {
    const ch = masked[k];
    if (/\s/.test(ch) || ch === '+') { k++; continue; }
    const lit = litAt.get(k);
    if (lit) { pieces.push(lit.value); k = lit.end; continue; }
    let d = 0, m = k;
    while (m < e0) {
      const c2 = masked[m];
      if (c2 === '(' || c2 === '[' || c2 === '{') d++;
      else if (c2 === ')' || c2 === ']' || c2 === '}') d--;
      else if (d === 0 && c2 === '+') break;
      else if (d === 0 && litAt.has(m) && m > k && /\s/.test(masked[m - 1])) break;
      m++;
    }
    pieces.push('$var'); k = Math.max(m, k + 1);
  }
  return pieces.join('');
}
function renderArg(masked, litAt, a) {
  const t = trimR(masked, a.s, a.e);
  if (t.s >= t.e) return '';
  const first = masked[t.s];
  if (first === '[' || first === '(') {
    const sc = splitCall(masked, t.s);
    if (sc.close >= t.e - 1) {
      const out = [];
      for (const el of sc.args) {
        const tt = trimR(masked, el.s, el.e);
        if (tt.s >= tt.e) continue;
        let v = renderExpr(masked, litAt, tt.s, tt.e);
        if (v === '' || (/[\s"']/.test(v) && v !== '$var')) v = '"' + v.replace(/"/g, '\\"') + '"';
        out.push(v);
      }
      return out.join(' ');
    }
  }
  return renderExpr(masked, litAt, t.s, t.e);
}

const HOME_EXPR_RE = /^\s*(?:os\.)?homedir\(\)\s*$|^\s*(?:pathlib\.)?Path\.home\(\)\s*$|^\s*os\.path\.expanduser\(\s*['"]~['"]\s*\)\s*$|^\s*process\.env\.(?:HOME|USERPROFILE)\s*$|^\s*os\.environ(?:\[\s*['"](?:HOME|USERPROFILE)['"]\s*\]|\.get\(\s*['"](?:HOME|USERPROFILE)['"]\s*\))\s*$|^\s*os\.getenv\(\s*['"](?:HOME|USERPROFILE)['"]\s*\)\s*$/;
const PATH_FUNCS = new Set(['open', 'path', 'purepath', 'posixpath', 'windowspath', 'join', 'joinpath', 'read_text', 'write_text', 'read_bytes', 'write_bytes', 'copy', 'copy2', 'copyfile', 'copytree', 'move', 'rename', 'replace', 'listdir', 'scandir', 'walk', 'glob', 'rglob', 'load', 'dump', 'readfile', 'readfilesync', 'writefile', 'writefilesync', 'appendfile', 'appendfilesync', 'createreadstream', 'createwritestream', 'readdir', 'readdirsync', 'copyfilesync', 'cp', 'cpsync', 'resolve', 'normalize', 'opensync', 'expanduser', 'expandvars', 'read_csv', 'read_json', 'read_excel', 'config', 'readlines', 'dotenv', 'load_dotenv', 'dotenv_values', 'from_file', 'send_file', 'send_from_directory', 'upload']);

function enclosingCallName(masked, pos) {
  let depth = 0;
  const lo = Math.max(0, pos - 3000);
  for (let k = pos - 1; k >= lo; k--) {
    const ch = masked[k];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        let e = k;
        while (e > 0 && /\s/.test(masked[e - 1])) e--;
        let s = e;
        while (s > 0 && /[\w$.]/.test(masked[s - 1])) s--;
        const full = masked.slice(s, e);
        return full.slice(full.lastIndexOf('.') + 1).toLowerCase();
      }
      depth--;
    } else if (ch === '[' || ch === '{') { if (depth > 0) depth--; }
  }
  return null;
}

const PY_CALLS = [
  { re: /\b(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|send2trash(?:\.send2trash)?)\s*\(/g, kind: 'delete' },
  { re: /(?<![.\w])rmtree\s*\(/g, kind: 'delete' },
  { re: /\.(?:unlink|rmdir)\s*\(/g, kind: 'delete-method' },
  { re: /\b(?:shutil\.move|os\.replace)\s*\(/g, kind: 'move' },
  { re: /\b(?:subprocess\.(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)|commands\.getoutput|os\.(?:system|popen))\s*\(/g, kind: 'exec' },
  { re: /(?<![.\w])(?:Popen|check_output|check_call)\s*\(/g, kind: 'exec' },
  { re: /\bos\.(?:kill|killpg)\s*\(/g, kind: 'kill' },
  { re: /(?<![.\w])(?:eval|exec)\s*\(/g, kind: 'eval' },
  { re: /\b__import__\s*\(/g, kind: 'import' },
  { re: /\bwinreg\.(?:SetValueEx?|DeleteKeyEx?|DeleteValue|CreateKeyEx?|SetValue)\s*\(/g, kind: 'registry' },
  { re: /\b(?:ExitWindowsEx|InitiateSystemShutdown\w*)\s*\(/g, kind: 'shutdown' }
];
const JS_CALLS = [
  { re: /\b(?:fs|fsp|fse|fsExtra|fsPromises|promises)\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|remove|removeSync|emptyDir|emptyDirSync)\s*\(/g, kind: 'delete' },
  { re: /\.(?:unlinkSync|rmSync|rmdirSync)\s*\(/g, kind: 'delete' },
  { re: /(?<![.\w])(?:rmSync|unlinkSync|rmdirSync|rimraf|rimrafSync|removeSync|emptyDirSync)\s*\(/g, kind: 'delete' },
  { re: /\b(?:Deno\.remove|shell\.rm)\s*\(/g, kind: 'delete' },
  { re: /\b(?:child_process|childProcess|cp|child|proc|execa)\.(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/g, kind: 'exec' },
  { re: /\.(?:execSync|spawnSync|execFileSync)\s*\(/g, kind: 'exec' },
  { re: /(?<![.\w])(?:execSync|spawnSync|execFileSync)\s*\(/g, kind: 'exec' },
  { re: /(?<![.\w])eval\s*\(/g, kind: 'eval' },
  { re: /\bnew\s+Function\s*\(|(?<![.\w])Function\s*\(/g, kind: 'eval' },
  { re: /\bvm\.(?:runInNewContext|runInThisContext|runInContext)\s*\(/g, kind: 'eval' },
  { re: /\bprocess\.kill\s*\(/g, kind: 'kill' }
];
const DL_PY_RE = /\b(?:requests|httpx|urllib\.request|urllib2|urllib3|aiohttp)\.\w+\s*\(|(?<![.\w])(?:urlopen|urlretrieve)\s*\(|\bwget\.download\s*\(/;
const DL_JS_RE = /(?<![.\w])(?:fetch|axios|got)\s*\(|\baxios\.\w+\s*\(|\bhttps?\.(?:get|request)\s*\(|\bnode-fetch\b/;
const DL_ARG_RE = /requests\.|httpx\.|urlopen|urlretrieve|\.text\b|\.content\b|\.read\(\)|fetch\(|axios|\.data\b|\.json\(\)/;

function judgeCodeInto(ctx, code, lang) {
  if (ctx.depth >= MAX_DEPTH) { add(ctx, 'ask', 'imbrication de code trop profonde (code dynamique)', 'dynamic-code'); return; }
  ctx.depth++;
  try {
    const src = code.length > 3000000 ? code.slice(0, 3000000) : code;
    const py = lang === 'python';
    const { masked, lits, litAt } = py ? lexPy(src) : lexJs(src);
    const table = (py ? PY_CALLS : JS_CALLS).map(e => ({ ...e, re: new RegExp(e.re.source, e.re.flags) }));

    if (py) {
      const re = /\bfrom\s+(os|shutil|subprocess|send2trash)\s+import\s+([^\n]+)/g;
      let m;
      const kinds = {
        os: { remove: 'delete', unlink: 'delete', rmdir: 'delete', removedirs: 'delete', replace: 'move', system: 'exec', popen: 'exec', kill: 'kill', killpg: 'kill' },
        shutil: { rmtree: 'delete', move: 'move' },
        subprocess: { run: 'exec', call: 'exec', Popen: 'exec', check_output: 'exec', check_call: 'exec', getoutput: 'exec', getstatusoutput: 'exec' },
        send2trash: { send2trash: 'delete' }
      };
      while ((m = re.exec(masked))) {
        for (const item of m[2].replace(/[()]/g, '').split(',')) {
          const [orig, alias] = item.trim().split(/\s+as\s+/);
          const kind = kinds[m[1]][orig];
          if (kind) table.push({ re: new RegExp('(?<![.\\w])' + (alias || orig).replace(/[^\w]/g, '') + '\\s*\\(', 'g'), kind, shell: /^(system|popen|getoutput|getstatusoutput)$/.test(orig) });
        }
      }
    } else {
      if (/require\(\s*['"`](?:node:)?fs(?:\/promises)?['"`]\s*\)|from\s+['"`](?:node:)?fs(?:\/promises)?['"`]/.test(src)) {
        table.push({ re: /(?<![.\w])(?:rm|unlink|rmdir)\s*\(/g, kind: 'delete' });
      }
      if (/child_process/.test(src)) table.push({ re: /(?<![.\w])(?:exec|spawn|execFile)\s*\(/g, kind: 'exec' });
    }

    const hasDl = (py ? DL_PY_RE : DL_JS_RE).test(masked);
    const done = new Set();
    let dynEval = false;

    for (const entry of table) {
      let m;
      let guard = 0;
      while ((m = entry.re.exec(masked)) && guard++ < 500) {
        const openIdx = m.index + m[0].length - 1;
        if (done.has(openIdx)) continue;
        done.add(openIdx);
        const call = m[0].replace(/\s*\($/, '').replace(/^\./, '');
        const { args, close } = splitCall(masked, openIdx);
        const rawArg0 = args[0] ? src.slice(args[0].s, args[0].e) : '';
        const callText = src.slice(openIdx, Math.min(close + 1, openIdx + 2000));
        switch (entry.kind) {
          case 'delete': case 'delete-method': {
            let cat = null;
            if (entry.kind === 'delete' && args[0]) {
              const lit = renderArg(masked, litAt, args[0]);
              if (lit && !lit.includes('$var')) cat = catastrophicReason(lit, ctx.cwd);
              if (!cat && HOME_EXPR_RE.test(rawArg0)) cat = 'dossier personnel';
            }
            if (cat) add(ctx, 'deny', `suppression de la racine ou d'un dossier système/personnel (${call} → ${cat})`);
            else add(ctx, 'ask', `suppression de fichiers (${call})`, 'delete-files');
            break;
          }
          case 'move':
            add(ctx, 'ask', `déplacement / écrasement de fichiers (${call})`, 'move-files');
            break;
          case 'kill':
            add(ctx, 'ask', `arrêt de processus (${call})`, 'kill-process');
            break;
          case 'registry': {
            if (/HKEY_LOCAL_MACHINE|HKEY_CLASSES_ROOT|HKEY_USERS/.test(callText)) add(ctx, 'deny', `modification du registre machine (${call})`);
            else add(ctx, 'ask', `modification du registre (${call})`, 'registry-write');
            break;
          }
          case 'shutdown':
            add(ctx, 'deny', `arrêt ou redémarrage de la machine (${call})`);
            break;
          case 'import':
            add(ctx, 'ask', 'exécution de code dynamique (__import__)', 'dynamic-code');
            break;
          case 'eval': {
            const t0 = args[0] ? trimR(masked, args[0].s, args[0].e) : null;
            if (!t0 || t0.s >= t0.e) break;
            const l0 = litAt.get(t0.s);
            if (l0 && l0.end >= t0.e && !l0.dyn) judgeCodeInto(ctx, l0.value, lang);
            else {
              dynEval = true;
              if (DL_ARG_RE.test(rawArg0) && hasDl) add(ctx, 'deny', `exécution de code téléchargé (${call}(…))`);
              else add(ctx, 'ask', `exécution de code dynamique (${call})`, 'dynamic-code');
            }
            break;
          }
          case 'exec': {
            const name = call.toLowerCase();
            const shellImplied = entry.shell || /(?:^|\.)(?:system|popen|getoutput|getstatusoutput|exec|execsync)$/.test(name);
            const shellTrue = /shell\s*(?:=|:)\s*(?:True|true)/.test(callText);
            if (!args[0]) break;
            let text;
            const isSpawn = !py && /(?:spawn|spawnsync|execfile|execfilesync)$/.test(name);
            if (isSpawn) {
              const head = renderArg(masked, litAt, args[0]);
              const t1 = args[1] ? trimR(masked, args[1].s, args[1].e) : null;
              const rest = t1 && masked[t1.s] === '[' ? renderArg(masked, litAt, args[1]) : '';
              text = `${/\s/.test(head) && head !== '$var' ? '"' + head + '"' : head} ${rest}`.trim();
            } else text = renderArg(masked, litAt, args[0]);
            if (hasDl && /requests\.|urlopen|fetch\(|axios/.test(rawArg0)) { add(ctx, 'deny', `exécution de code téléchargé (${call}(…))`); break; }
            if (!text) break;
            if (text.trim() === '$var') {
              if (shellImplied || shellTrue) add(ctx, 'ask', `exécution de commande dynamique (${call})`, 'dynamic-exec');
              break;
            }
            analyzeScript(text, ctx);
            break;
          }
          default: break;
        }
      }
    }

    if (py && /\bimport\s+psutil|\bfrom\s+psutil\b/.test(masked) && /\.(?:kill|terminate)\s*\(/.test(masked)) add(ctx, 'ask', 'arrêt de processus (psutil)', 'kill-process');

    // fichiers sensibles passés à un appel de chemin
    for (const lit of lits) {
      const v = lit.value;
      if (!v || v.length > 300 || v.indexOf('\n') >= 0) continue;
      const f = sensitiveFileMatch(v.trim());
      if (!f) continue;
      const fn = enclosingCallName(masked, lit.start);
      if (fn && PATH_FUNCS.has(fn)) add(ctx, 'ask', `accès à un fichier sensible : ${f.reason}`, `sensitive:${f.label}`);
    }

    // téléchargement puis exécutable
    if (hasDl) {
      if (lits.some(l => !l.dyn && l.value.length < 200 && !/^https?:\/\//i.test(l.value) && /^[\w./\\: -]+$/.test(l.value) && EXEC_EXT_RE.test(l.value))) {
        add(ctx, 'ask', 'téléchargement puis écriture d\'un exécutable', 'download-executable');
      }
      if (/\bos\.startfile\s*\(|ShellExecute/.test(masked)) add(ctx, 'ask', 'téléchargement puis exécution (os.startfile)', 'download-exec');
      if (dynEval && !ctx.findings.some(f => f.level === 'deny')) add(ctx, 'deny', 'exécution de code dynamique après un téléchargement');
    }
  } finally { ctx.depth--; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  API publique : jugement
// ═══════════════════════════════════════════════════════════════════════════
/** Classe un script shell (PowerShell / bash / cmd). -> { level, reason, key, keys } */
export function judgeCommand(command, { cwd } = {}) {
  const text = command == null ? '' : String(command);
  if (!text.trim()) return { level: 'safe', reason: 'commande vide', key: null, keys: [] };
  const ctx = newCtx(cwd);
  analyzeScript(text, ctx);
  if (/\$env:[A-Za-z_]*(token|secret|passw|api_?key|credential)/i.test(text) || /\b(get-childitem|gci|ls|dir|get-item|gi)\s+(-path\s+)?env:/i.test(text) || /\[environment\]::getenvironmentvariables/i.test(text)) {
    add(ctx, 'ask', 'lecture de variables d\'environnement (peuvent contenir des secrets)', 'env-dump');
  }
  return finalize(ctx.findings);
}

/** Classe du code Python ou Node. -> { level, reason, key, keys } */
export function judgeCode(code, lang) {
  const text = code == null ? '' : String(code);
  if (!text.trim()) return { level: 'safe', reason: 'code vide', key: null, keys: [] };
  const l = String(lang || '').toLowerCase();
  const kind = /^(py|python|python3)$/.test(l) ? 'python' : 'node';
  const ctx = newCtx('');
  judgeCodeInto(ctx, text, kind);
  return finalize(ctx.findings);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Règles « toujours autoriser » (persistantes)
// ═══════════════════════════════════════════════════════════════════════════
function homeDir() { return process.env.FS_CLI_HOME || path.join(os.homedir(), '.fs-cli'); }
function rulesFile() { return path.join(homeDir(), 'permissions.json'); }
function normCwd(cwd) {
  let p;
  try { p = path.resolve(String(cwd || process.cwd())); } catch { p = String(cwd || ''); }
  p = p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return p || '/';
}
function normKey(k) { return String(k == null ? '' : k).trim().replace(/\s+/g, ' ').toLowerCase(); }

function cleanList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const key = normKey(typeof r === 'string' ? r : (r && typeof r === 'object' && typeof r.key === 'string' ? r.key : ''));
    if (!key || key.startsWith('deny:') || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, added: r && typeof r.added === 'string' ? r.added : null });
  }
  return out;
}
function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('format');
    const projects = {};
    if (raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects)) {
      for (const [k, v] of Object.entries(raw.projects)) { const l = cleanList(v); if (l.length) projects[k] = l; }
    }
    return { global: cleanList(raw.global), projects };
  } catch { return { global: [], projects: {} }; }
}
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignoré */ } }
function writeStore(store) {
  const file = rulesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify({ global: store.global, projects: store.projects }, null, 2) + '\n';
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) { lastErr = e; sleepMs(15 * (attempt + 1)); }
  }
  try { fs.copyFileSync(tmp, file); } catch { throw lastErr; } finally { try { fs.unlinkSync(tmp); } catch { /* ignoré */ } }
}
const scopeOf = (s) => (/^(global|globale)$/i.test(String(s || '')) ? 'global' : 'projet');

/** Règles actives pour ce dossier : globales puis projet. */
export function loadRules(cwd) {
  const store = readStore();
  const proj = store.projects[normCwd(cwd)] || [];
  return [
    ...store.global.map(r => ({ key: r.key, scope: 'global', added: r.added })),
    ...proj.map(r => ({ key: r.key, scope: 'projet', added: r.added }))
  ];
}

/** Ajoute une règle (scope 'projet' par défaut). Lève si la clé est vide ou commence par 'deny:'. */
export function addRule(key, cwd, scope = 'projet') {
  const k = normKey(key);
  if (!k) throw new Error('Clé de règle vide.');
  if (k.startsWith('deny:')) throw new Error('Une action interdite (deny) ne peut pas être autorisée par une règle.');
  const sc = scopeOf(scope);
  const store = readStore();
  const ck = normCwd(cwd);
  const list = sc === 'global' ? store.global : (store.projects[ck] = store.projects[ck] || []);
  const existing = list.find(r => r.key === k);
  if (existing) return { key: k, scope: sc, added: existing.added };
  const rec = { key: k, added: new Date().toISOString() };
  list.push(rec);
  writeStore(store);
  return { key: k, scope: sc, added: rec.added };
}

/** Supprime une règle : numéro (1 = première de loadRules) ou clé. Renvoie true si quelque chose a été retiré. */
export function removeRule(selector, cwd) {
  const store = readStore();
  const ck = normCwd(cwd);
  const proj = store.projects[ck] || [];
  const s = String(selector == null ? '' : selector).trim();
  let removed = false;
  if (/^\d+$/.test(s)) {
    const idx = Number(s) - 1;
    if (idx < 0) return false;
    if (idx < store.global.length) { store.global.splice(idx, 1); removed = true; }
    else if (idx - store.global.length < proj.length) { proj.splice(idx - store.global.length, 1); removed = true; }
    if (removed) { if (proj.length) store.projects[ck] = proj; else delete store.projects[ck]; }
  } else {
    const k = normKey(s);
    if (!k) return false;
    const g = store.global.length;
    store.global = store.global.filter(r => r.key !== k);
    const np = proj.filter(r => r.key !== k);
    removed = store.global.length !== g || np.length !== proj.length;
    if (removed) { if (np.length) store.projects[ck] = np; else delete store.projects[ck]; }
  }
  if (removed) writeStore(store);
  return removed;
}

/** Efface les règles ('projet' | 'global' | 'tout'). Renvoie le nombre de règles retirées. */
export function clearRules(cwd, scope = 'projet') {
  const store = readStore();
  const ck = normCwd(cwd);
  const sc = /^(tout|all)$/i.test(String(scope)) ? 'all' : scopeOf(scope);
  let n = 0;
  if (sc === 'global' || sc === 'all') { n += store.global.length; store.global = []; }
  if (sc === 'projet' || sc === 'all') { n += (store.projects[ck] || []).length; delete store.projects[ck]; }
  if (n) writeStore(store);
  return n;
}

function judgementKeys(j) {
  if (!j) return [];
  if (Array.isArray(j.keys) && j.keys.length) return j.keys.map(normKey).filter(Boolean);
  return j.key ? [normKey(j.key)] : [];
}

/** Une règle autorise un jugement 'ask' si TOUTES ses clés sont couvertes. Jamais un 'deny'. */
export function isAllowedByRule(judgement, cwd) {
  if (!judgement || judgement.level !== 'ask') return false;
  const keys = judgementKeys(judgement);
  if (!keys.length || keys.some(k => k.startsWith('deny:'))) return false;
  const set = new Set(loadRules(cwd).map(r => r.key));
  return keys.every(k => set.has(k));
}

/** Enregistre une règle pour chaque clé d'un jugement 'ask'. Renvoie le nombre de règles ajoutées. */
export function addRulesForJudgement(judgement, cwd, scope = 'projet') {
  if (!judgement || judgement.level !== 'ask') return 0;
  let n = 0;
  const have = new Set(loadRules(cwd).filter(r => r.scope === scopeOf(scope)).map(r => r.key));
  for (const k of judgementKeys(judgement)) { if (!have.has(k)) { addRule(k, cwd, scope); n++; } }
  return n;
}

/** Décision finale : run (exécuter), confirm (demander), refuse (refus net). */
export function decide(judgement, cwd) {
  const j = judgement && typeof judgement === 'object' ? judgement : { level: 'ask', reason: 'jugement invalide', key: null };
  const base = { reason: j.reason || '', key: j.key || null, allowedByRule: false };
  if (j.level === 'deny') return { action: 'refuse', ...base };
  if (j.level === 'safe') return { action: 'run', ...base };
  if (isAllowedByRule(j, cwd)) return { action: 'run', ...base, allowedByRule: true };
  return { action: 'confirm', ...base };
}

/** Lignes lisibles pour /permissions. */
export function describeRules(cwd) {
  const rules = loadRules(cwd);
  if (!rules.length) return ['Aucune règle « toujours autoriser » enregistrée.'];
  const lines = [`Règles « toujours autoriser » (${rules.length}) :`];
  rules.forEach((r, i) => {
    const date = r.added ? ` — ajoutée le ${r.added.slice(0, 10)}` : '';
    lines.push(`${i + 1}. [${r.scope}] ${r.key}${date}`);
  });
  lines.push('Les actions interdites (deny) ne peuvent jamais être autorisées par une règle.');
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Détection de secrets dans du texte à écrire
// ═══════════════════════════════════════════════════════════════════════════
const PLACEHOLDER_RE = /x{4,}|\*{3,}|\.{3}|…|your[_-]?|example|placeholder|dummy|fake|redact|changeme|replace|insert|<[^>]*>|0{8,}|1234567|abcdefg|sample|todo|\$\{|%\w+%/i;
function looksPlaceholder(tok) {
  if (PLACEHOLDER_RE.test(tok)) return true;
  const body = tok.replace(/^[A-Za-z_]{2,12}[-_]/, '');
  return body.length >= 16 && new Set(body).size < 6;
}
const SECRET_PATTERNS = [
  { name: 'Clé privée PEM', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, pem: true },
  { name: 'Clé Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Clé OpenAI', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{32,}/g },
  { name: 'Jeton GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: 'Clé AWS (accès)', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { name: 'Clé AWS (secrète)', re: /aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
  { name: 'Clé Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Jeton Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g },
  { name: 'Webhook Slack', re: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g },
  { name: 'Webhook Discord', re: /discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/[\w-]{40,}/g },
  { name: 'Jeton Discord', re: /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,38}\b/g, check: (m) => /\d/.test(m[0]) && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) },
  { name: 'Clé Stripe', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/g },
  { name: 'Jeton npm', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'Jeton Hugging Face', re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { name: 'Clé SendGrid', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { name: 'Jeton bot Telegram', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'Jeton Bearer', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{40,})/g, group: 1 }
];

/** Détecte des secrets dans du texte. -> [{ name, sample (4 premiers caractères + …), index }] */
export function scanSecrets(text) {
  if (text == null) return [];
  const s = String(text);
  if (s.length < 8) return [];
  const found = [];
  const ranges = [];
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m, guard = 0;
    while ((m = re.exec(s)) && guard++ < 200) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const tok = p.group ? m[p.group] : m[0];
      const idx = p.group ? m.index + m[0].indexOf(tok) : m.index;
      if (p.pem) {
        const after = s.slice(m.index + m[0].length, m.index + m[0].length + 160);
        if (!/[A-Za-z0-9+/=]{16,}/.test(after) || /\.{3}|x{6,}/i.test(after.slice(0, 60))) continue;
      } else if (looksPlaceholder(tok)) continue;
      if (p.check && !p.check(m, s)) continue;
      const end = idx + tok.length;
      if (ranges.some(([a, b]) => idx < b && end > a)) continue;
      ranges.push([idx, end]);
      found.push({ name: p.name, sample: tok.slice(0, 4) + '…', index: idx });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}
