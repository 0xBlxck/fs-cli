// Code reçu minifié sur UNE ligne (vu : une page HTML de 8 Ko écrite par GPT dans un document du site, illisible dans
// l'éditeur) → remis sur plusieurs lignes, indenté. Zéro dépendance. Règle d'or : ne jamais changer ce que fait le code.
// - JS / CSS : retour à la ligne seulement après « { » et « ; » et avant « } », hors chaînes, gabarits, commentaires et
//   expressions régulières, et jamais dans des parenthèses (for (…;…;…)) : un saut de ligne à ces endroits ne change pas le sens.
// - HTML : saut de ligne seulement entre deux balises (sans texte entre elles) dont l'une au moins est un bloc ou un élément
//   invisible (head, meta, style, script…), ou entre éléments d'un dessin SVG (hors <text>) ; jamais entre deux éléments en
//   ligne (un espace visible apparaîtrait) ; <pre>, <textarea> et le texte gardés tels quels.

const IND = '  ';

/** JavaScript minifié → lignes indentées. */
export function formatJs(src, base = 0) {
  const s = String(src);
  let out = '', depth = 0, i = 0;
  const stack = [];                                  // ( [ { ouverts ; « t » = gabarit `…${
  let lastSig = '';                                  // dernier caractère significatif (pour distinguer / division et /regex/)
  let lastWord = '';
  const nl = () => { out = out.replace(/[ \t]+$/, ''); out += '\n' + IND.repeat(base + Math.max(0, depth)); };
  const regexAllowed = () => !lastSig || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(lastWord);
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '"' || c === "'") {                    // chaîne
      let j = i + 1;
      while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; if (s[j] === '\n') break; j++; }
      out += s.slice(i, j + 1); i = j + 1; lastSig = c; lastWord = ''; continue;
    }
    if (c === '`') {                                 // gabarit : on copie jusqu'à « ` » ou « ${ »
      let j = i + 1;
      while (j < s.length && s[j] !== '`' && !(s[j] === '$' && s[j + 1] === '{')) { if (s[j] === '\\') j++; j++; }
      if (s[j] === '$') { out += s.slice(i, j + 2); stack.push('t'); i = j + 2; lastSig = '{'; lastWord = ''; continue; }
      out += s.slice(i, j + 1); i = j + 1; lastSig = '`'; lastWord = ''; continue;
    }
    if (c === '/' && d === '/') { const j = s.indexOf('\n', i); const end = j < 0 ? s.length : j; out += s.slice(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const j = s.indexOf('*/', i + 2); const end = j < 0 ? s.length : j + 2; out += s.slice(i, end); i = end; continue; }
    if (c === '/' && regexAllowed()) {               // expression régulière
      let j = i + 1, cls = false;
      while (j < s.length && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; else if (s[j] === '/' && !cls) break;
        j++;
      }
      j++; while (j < s.length && /[a-z]/i.test(s[j])) j++;
      out += s.slice(i, j); i = j; lastSig = '/'; lastWord = ''; continue;
    }
    if (c === '}' && stack[stack.length - 1] === 't') {   // fin d'un ${…} : retour dans le gabarit
      stack.pop(); out += '}'; i++;
      let j = i;
      while (j < s.length && s[j] !== '`' && !(s[j] === '$' && s[j + 1] === '{')) { if (s[j] === '\\') j++; j++; }
      if (s[j] === '$') { out += s.slice(i, j + 2); stack.push('t'); i = j + 2; lastSig = '{'; continue; }
      out += s.slice(i, j + 1); i = j + 1; lastSig = '`'; continue;
    }
    if (c === '(' || c === '[') { stack.push(c); out += c; i++; lastSig = c; lastWord = ''; continue; }
    if (c === ')' || c === ']') { stack.pop(); out += c; i++; lastSig = c; lastWord = ''; continue; }
    if (c === '{') {
      stack.push('{'); out += '{'; i++; lastSig = '{'; lastWord = '';
      if (s[i] === '}') { out += '}'; stack.pop(); i++; lastSig = '}'; continue; }   // {} vide : sur place
      depth++; nl(); while (s[i] === ' ' || s[i] === '\t') i++; continue;
    }
    if (c === '}') {
      stack.pop(); depth--; nl(); out += '}'; i++; lastSig = '}'; lastWord = '';
      // fin de bloc collée à l'instruction suivante (« }const x ») : à la ligne, sauf « } else », « } catch »… (même instruction)
      const next = /^[A-Za-z_$]+/.exec(s.slice(i))?.[0];
      if (next && !/^(else|catch|finally|while|instanceof|in|of)$/.test(next) && !stack.includes('(')) nl();
      continue;
    }
    if (c === ';') {
      out += ';'; i++; lastSig = ';'; lastWord = '';
      if (!stack.includes('(') && s[i] !== '}' && s[i] !== undefined && s[i] !== '\n') { nl(); while (s[i] === ' ' || s[i] === '\t') i++; }
      continue;
    }
    if (c === '\n') { nl(); i++; while (s[i] === ' ' || s[i] === '\t') i++; continue; }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i; while (j < s.length && /[A-Za-z_$0-9]/.test(s[j])) j++;
      lastWord = s.slice(i, j); out += lastWord; i = j; lastSig = 'a'; continue;
    }
    out += c; i++; if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** CSS minifié → règles sur plusieurs lignes. */
export function formatCss(src, base = 0) {
  const s = String(src);
  let out = '', depth = 0, i = 0;
  const nl = () => { out = out.replace(/[ \t]+$/, ''); out += '\n' + IND.repeat(base + Math.max(0, depth)); };
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } out += s.slice(i, j + 1); i = j + 1; continue; }
    if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); const end = j < 0 ? s.length : j + 2; out += s.slice(i, end); i = end; continue; }
    if (c === '{') { out += ' {'.replace(/^ /, /\s$/.test(out) ? '' : ' '); depth++; nl(); i++; while (s[i] === ' ') i++; continue; }
    if (c === '}') { depth--; nl(); out += '}'; i++; if (s[i] && s[i] !== '}') nl(); continue; }
    if (c === ';') { out += ';'; i++; if (s[i] !== '}') { nl(); while (s[i] === ' ') i++; } continue; }
    if (c === '\n') { i++; continue; }
    out += c; i++;
  }
  return out.replace(/[ \t]+$/gm, '').trim();
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', '!doctype']);
const BLOCK = new Set(['html', 'head', 'body', 'title', 'meta', 'link', 'style', 'script', 'noscript', 'template', 'base', '!doctype',
  'div', 'section', 'header', 'footer', 'main', 'nav', 'article', 'aside', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'form', 'fieldset', 'legend',
  'figure', 'figcaption', 'blockquote', 'hr', 'details', 'summary', 'dialog', 'canvas', 'video', 'audio', 'iframe', 'address', 'menu']);
const RAW = new Set(['script', 'style', 'pre', 'textarea']);
const SVG_TEXT = new Set(['text', 'tspan', 'textpath', 'title', 'desc']);

/** HTML minifié → une balise de bloc par ligne, indentée ; script et style formatés ; rien d'autre ne bouge. */
export function formatHtml(src) {
  const s = String(src);
  const tokens = [];                                 // { tag, name, close, self } ou { text }
  let i = 0;
  while (i < s.length) {
    if (s[i] === '<') {
      if (s.startsWith('<!--', i)) { const j = s.indexOf('-->', i); const end = j < 0 ? s.length : j + 3; tokens.push({ tag: s.slice(i, end), name: '!--', comment: true }); i = end; continue; }
      let j = i + 1, q = null;
      for (; j < s.length; j++) { const c = s[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
      const tag = s.slice(i, j + 1);
      const m = /^<\/?\s*([!A-Za-z][\w:-]*)/.exec(tag);
      const name = m ? m[1].toLowerCase() : '';
      const t = { tag, name, close: tag.startsWith('</'), self: /\/>$/.test(tag) || VOID.has(name) };
      tokens.push(t); i = j + 1;
      if (!t.close && RAW.has(name)) {                // contenu brut jusqu'à la balise fermante
        const end = s.toLowerCase().indexOf(`</${name}`, i);
        const stop = end < 0 ? s.length : end;
        tokens.push({ raw: s.slice(i, stop), name }); i = stop;
      }
      continue;
    }
    const j = s.indexOf('<', i); const end = j < 0 ? s.length : j;
    tokens.push({ text: s.slice(i, end) }); i = end;
  }
  let out = '', depth = 0, svg = 0, svgText = 0;
  const lineStart = () => { out = out.replace(/[ \t]+$/, ''); if (out) out += '\n'; out += IND.repeat(Math.max(0, depth)); };
  const breakable = t => t && t.name && (BLOCK.has(t.name) || t.comment || (svg > 0 && !svgText && !SVG_TEXT.has(t.name)) || t.name === 'svg');
  let prev = null;
  for (const t of tokens) {
    if (t.raw !== undefined) {
      // la balise ouvrante a déjà augmenté la profondeur : le contenu est un cran sous <script> / <style>
      if (t.name === 'script' && t.raw.trim() && !/^\s*</.test(t.raw)) { lineStart(); out += formatJs(t.raw.trim(), depth); }
      else if (t.name === 'style' && t.raw.trim()) { lineStart(); out += formatCss(t.raw.trim(), depth); }
      else out += t.raw;                             // pre, textarea, script vide ou JSON : tel quel
      // fin de <script> / <style> formatés : la balise fermante passe à la ligne ; JAMAIS dans <pre> / <textarea>
      // (un retour à la ligne y changerait le texte affiché)
      prev = (t.name === 'script' || t.name === 'style') && t.raw.trim() ? { name: t.name, rawEnd: true } : { name: t.name, keep: true };
      continue;
    }
    if (t.text !== undefined) { out += t.text; prev = t.text.trim() ? null : prev; continue; }
    if (t.close) {
      if (t.name === 'svg') svg = Math.max(0, svg - 1);
      if (SVG_TEXT.has(t.name) && svg) svgText = Math.max(0, svgText - 1);
      depth--;
      const brk = prev && !prev.keep && (prev.rawEnd || (breakable(prev) && breakable(t)) || (prev.close && breakable(prev)));
      if (brk && !out.endsWith('\n' + IND.repeat(Math.max(0, depth)))) lineStart();
      out += t.tag; prev = t; continue;
    }
    // balise ouvrante
    const brk = prev && ((breakable(prev) || breakable(t)) && (prev.rawEnd || prev.name) && !(prev.text !== undefined));
    const inlineBoth = prev && !breakable(prev) && !breakable(t);
    if (out && brk && !inlineBoth) lineStart();
    out += t.tag;
    if (t.name === 'svg' && !t.self) svg++;
    if (SVG_TEXT.has(t.name) && svg && !t.self) svgText++;
    if (!t.self && !t.comment && t.name !== '!doctype') depth++;
    prev = t;
  }
  return out.replace(/[ \t]+$/gm, '').trim() + '\n';
}

/** Contenu d'un document du site écrit en une seule ligne (HTML, CSS, JS) → formaté ; sinon tel quel. */
export function prettifyIfMinified(name, content) {
  const text = String(content ?? '');
  const lines = text.split('\n').length;
  if (lines > 3 || text.length < 400 || /\.min\.[a-z]+$/i.test(String(name))) return text;
  const ext = (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  try {
    if (ext === 'html' || ext === 'htm' || ext === 'svg' || (!ext && /^\s*<!doctype html|^\s*<html/i.test(text))) return formatHtml(text);
    if (ext === 'css') return formatCss(text) + '\n';
    if (['js', 'mjs', 'cjs'].includes(ext)) return formatJs(text) + '\n';
  } catch {}
  return text;
}
