// GÉNÉRÉ depuis src/latex.js (même code, pour le panneau) : ne pas modifier à la main, voir test/latex.test.mjs.
(() => {
// Formules LaTeX des réponses (\( … \), \[ … \], $$ … $$, $ … $) → texte Unicode lisible : π_θ, ∑ᵢ xᵢ², a/b, √x, ≤ …
// Pas de moteur de rendu (zéro dépendance) : une conversion simple, exacte pour les formules courantes.
// Même code dans le panneau de l'éditeur : vscode/media/latex.js (vérifié par test/latex.test.mjs).

const SYM = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', infty: '∞', partial: '∂', nabla: '∇',
  forall: '∀', exists: '∃', nexists: '∄', emptyset: '∅', varnothing: '∅', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', bigcup: '⋃', bigcap: '⋂',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬', oplus: '⊕', otimes: '⊗', odot: '⊙', circ: '∘',
  bullet: '•', cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', dagger: '†',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', simeq: '≃', cong: '≅', equiv: '≡',
  propto: '∝', ll: '≪', gg: '≫', prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', implies: '⇒', impliedby: '⇐', iff: '⇔', mapsto: '↦', longrightarrow: '⟶', longleftarrow: '⟵',
  Longrightarrow: '⟹', uparrow: '↑', downarrow: '↓', nearrow: '↗', searrow: '↘',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱', langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉',
  lfloor: '⌊', rfloor: '⌋', mid: '|', vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖', parallel: '∥',
  perp: '⊥', angle: '∠', degree: '°', prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', top: '⊤', bot: '⊥',
  checkmark: '✓', triangle: '△', square: '□', blacksquare: '■', therefore: '∴', because: '∵', colon: ':',
  quad: '  ', qquad: '    ', lbrace: '{', rbrace: '}', backslash: '\\',
};
// opérateurs écrits en lettres droites
const WORDS = ['log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'min', 'max', 'arg', 'lim', 'liminf', 'limsup', 'det', 'dim', 'ker', 'gcd', 'Pr', 'sup', 'inf', 'argmax', 'argmin', 'mod', 'bmod', 'deg', 'hom', 'sgn', 'tr', 'rank', 'var', 'cov'];
// commandes dont seul le contenu compte
const PLAIN = ['text', 'textrm', 'textbf', 'textit', 'texttt', 'textsf', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'boldsymbol',
  'bm', 'operatorname', 'mbox', 'emph', 'displaystyle', 'textstyle', 'scriptstyle', 'mathnormal', 'underline', 'overline', 'pmb'];
// commandes de taille ou d'espacement sans contenu propre
const DROP = ['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'middle',
  'limits', 'nolimits', 'displaystyle', 'nonumber', 'notag', 'label', 'tag', 'phantom', 'hphantom', 'vphantom'];
const BB = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', E: '𝔼', H: 'ℍ', F: '𝔽', 1: '𝟙' };
const CAL = { L: 'ℒ', F: 'ℱ', H: 'ℋ', O: '𝒪', N: '𝒩', D: '𝒟', A: '𝒜', B: 'ℬ', C: '𝒞', E: 'ℰ', M: 'ℳ', P: '𝒫', R: 'ℛ', S: '𝒮', T: '𝒯', X: '𝒳' };
const ACCENT = { hat: '̂', widehat: '̂', bar: '̄', tilde: '̃', widetilde: '̃', vec: '⃗', dot: '̇', ddot: '̈', check: '̌', breve: '̆' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ',
  s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ', '′': '′', '*': '*', '∗': '*' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };

/** Petit indice / exposant en caractères Unicode si chaque caractère en a un ; sinon « _x » / « ^(x+1) ». */
function script(body, map, mark) {
  const s = body.replace(/\s+/g, '');
  if (s && [...s].every(ch => map[ch])) return [...s].map(ch => map[ch]).join('');
  return mark + ([...s].length > 1 ? `(${s})` : s);
}

/** Expression LaTeX (sans délimiteurs) → texte. */
function latexToText(src) {
  const s = String(src ?? '');
  let i = 0;
  const skipSpaces = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const group = () => {                                // {…} équilibré, ou un seul élément
    skipSpaces();
    if (s[i] === '{') {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '{') depth++;
        else if (s[j] === '}' && --depth === 0) break;
      }
      const inner = s.slice(i + 1, j);
      i = j + 1;
      return conv(inner);
    }
    if (s[i] === '\\') { const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i)); i += m ? m[0].length : 1; return conv(m ? m[0] : '\\'); }
    return s[i++] ?? '';
  };
  const optional = () => {                             // [n] de \sqrt[n]{x}
    skipSpaces();
    if (s[i] !== '[') return null;
    const j = s.indexOf(']', i);
    if (j < 0) return null;
    const v = s.slice(i + 1, j); i = j + 1; return conv(v);
  };
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      if (!m) { out += ch; i++; continue; }
      const name = m[1];
      i += m[0].length;
      if (name === '\\') { out += '\n'; continue; }      // \\ : retour à la ligne (tableaux, cas)
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
        const a = group(), b = group();
        const wrap = t => (/^[\w.′αβγδεθλμπσφωΓΔΘΛΠΣΦΩ]+$/u.test(t) || /^\(.*\)$/.test(t) ? t : `(${t})`);
        out += `${wrap(a)}/${wrap(b)}`; continue;
      }
      if (name === 'binom') { const a = group(), b = group(); out += `C(${a}, ${b})`; continue; }
      if (name === 'sqrt') { const n = optional(); const a = group(); const root = n ? script(n, SUP, '') : ''; out += `${root}√${[...a].length > 1 ? `(${a})` : a}`; continue; }
      if (name === 'mathbb' || name === 'Bbb') { const a = group(); out += [...a].map(c => BB[c] || c).join(''); continue; }
      if (name === 'mathcal' || name === 'mathscr') { const a = group(); out += [...a].map(c => CAL[c] || c).join(''); continue; }
      if (ACCENT[name]) { const a = group(); out += [...a].length === 1 ? a + ACCENT[name] : `${a}${ACCENT[name]}`; continue; }
      if (name === 'begin' || name === 'end') { group(); continue; }   // environnements : on garde le contenu
      if (name === 'not') { const a = group(); out += a === '=' ? '≠' : a === '∈' ? '∉' : a + '̸'; continue; }
      if (PLAIN.includes(name)) { const a = group(); out += a; continue; }
      if (DROP.includes(name)) continue;
      if (WORDS.includes(name)) { out += name.replace(/^b(?=mod)/, ''); continue; }
      if (SYM[name] !== undefined) { out += SYM[name]; continue; }
      if (/^[,;:!> ]$/.test(name)) { out += name === '!' ? '' : ' '; continue; }
      if (/^[{}%$&#_|]$/.test(name)) { out += name === '|' ? '‖' : name; continue; }
      out += name;                                       // commande inconnue : son nom, lisible
      continue;
    }
    if (ch === '^' || ch === '_') {
      i++;
      const body = group();
      out += script(body, ch === '^' ? SUP : SUB, ch);
      continue;
    }
    if (ch === '{' || ch === '}') { i++; continue; }
    if (ch === '&') { out += ' '; i++; continue; }
    if (ch === '~') { out += ' '; i++; continue; }
    out += ch; i++;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').trim();
}
const conv = latexToText;

// $…$ : seulement une vraie formule (pas « 5$ et 10$ », pas « $HOME ») : collée aux $, une commande \…, ^, _ ou une seule lettre
const DOLLAR_RE = /(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d|\w)/g;
const looksLikeMath = t => /\\[A-Za-z]|[\^_]|^[A-Za-z]$|^[A-Za-z]\s*[=<>]/.test(t);

/**
 * Remplace les formules d'un texte d'UNE ligne (inline) : wrap(texte converti, affichée) décide de la mise en forme
 * (couleur dans le terminal, <span> dans le panneau). Les blocs sur plusieurs lignes sont gérés par l'appelant.
 */
function replaceMath(text, wrap = t => t) {
  let s = String(text ?? '');
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => wrap(conv(e), true));
  s = s.replace(/\$\$([^$]+?)\$\$/g, (_, e) => wrap(conv(e), true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => wrap(conv(e), false));
  s = s.replace(DOLLAR_RE, (all, pre, e) => (looksLikeMath(e) ? pre + wrap(conv(e), false) : all));
  return s;
}

/** Ligne qui ouvre un bloc de formule sur plusieurs lignes (« \[ » ou « $$ » seul, ou ouvert sans fermeture) → délimiteur de fin, sinon null. */
function mathBlockStart(line) {
  const t = String(line).trim();
  if (t.startsWith('\\[') && !t.includes('\\]')) return '\\]';
  if (t.startsWith('$$') && !t.slice(2).includes('$$')) return '$$';
  return null;
}

window.FsLatex = { latexToText, replaceMath, mathBlockStart };
})();
