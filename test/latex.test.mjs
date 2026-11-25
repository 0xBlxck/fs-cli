// Formules LaTeX des réponses → texte Unicode (terminal et panneau de l'éditeur ; bug signalé sur Discord : « \(\pi_\theta\) » brut)
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { latexToText, replaceMath, mathBlockStart } = await import('../src/latex.js');

test('latexToText : grec, indices et exposants, fractions, racines, ensembles, opérateurs, accents', () => {
  const cases = [
    [String.raw`\pi_\theta`, 'π_θ'],
    [String.raw`x^2 + y^2 = z^2`, 'x² + y² = z²'],
    [String.raw`\sum_{i=1}^{n} x_i^2`, '∑ᵢ₌₁ⁿ xᵢ²'],
    [String.raw`\frac{a+b}{2}`, '(a+b)/2'],
    [String.raw`\frac{1}{2}`, '1/2'],
    [String.raw`\sqrt{x+1}`, '√(x+1)'],
    [String.raw`\sqrt[3]{x}`, '³√x'],
    [String.raw`x \in \mathbb{R}^n`, 'x ∈ ℝⁿ'],
    [String.raw`a \leq b \neq c \approx d \to \infty`, 'a ≤ b ≠ c ≈ d → ∞'],
    [String.raw`\hat{y}_i`, 'ŷᵢ'],                // accent combinant : s'affiche « ŷ »
    [String.raw`\log \pi_\theta(a_t \mid s_t)`, 'log π_θ(aₜ | sₜ)'],
    [String.raw`\mathbb{E}_{x \sim p}\left[ f(x) \right]`, '𝔼_(x∼p)[ f(x) ]'],
    [String.raw`\text{si } x > 0`, 'si x > 0'],
    [String.raw`\mathcal{L}(\theta)`, 'ℒ(θ)'],
    [String.raw`\inf_x f`, 'infₓ f'],
    [String.raw`\commandeinconnue{x}`, 'commandeinconnuex'],
  ];
  for (const [src, want] of cases) assert.equal(latexToText(src), want, src);
});

test('replaceMath : délimiteurs \\( \\), \\[ \\], $$ $$, $ $ ; prix, variables et dollars isolés jamais touchés', () => {
  const w = (t, block) => (block ? `[${t}]` : `«${t}»`);
  assert.equal(replaceMath(String.raw`\(\pi_\theta\) est la politique`, w), '«π_θ» est la politique');
  assert.equal(replaceMath(String.raw`voir \[ a^2 \] et $$b_1$$`, w), 'voir [a²] et [b₁]');
  assert.equal(replaceMath(String.raw`$x^2$ et $\alpha$ et $x$`, w), '«x²» et «α» et «x»');
  for (const plain of ['ça coûte 5$ et 10$', 'prix : $5 et $10', 'variable $HOME et $PATH', 'un seul $ ici', 'total: $ 20 $']) {
    assert.equal(replaceMath(plain, w), plain, plain);
  }
  assert.equal(mathBlockStart(String.raw`\[`), String.raw`\]`);
  assert.equal(mathBlockStart('  $$'), '$$');
  assert.equal(mathBlockStart(String.raw`\[ a \]`), null, 'ouvert et fermé sur la même ligne : inline');
  assert.equal(mathBlockStart('texte'), null);
});

test('terminal : formules converties dans le texte et en bloc ; code inline et blocs de code intacts', async () => {
  const ui = await import('../src/ui.js');
  const out = [];
  ui.attachSink({ print: t => out.push(t) });
  try {
    const md = new ui.MdStream();
    md.push(String.raw`- \(\pi_\theta\) est la politique. Code : ` + '`$x_1$`\n' + String.raw`\[
\nabla_\theta J(\theta) = \mathbb{E}[G_t]
\]
` + '```py\n' + String.raw`print("\(x\)")` + '\n```\n');
    md.finish();
  } finally { ui.attachSink(null); }
  const text = ui.stripAnsi(out.join('\n'));
  assert.match(text, /π_θ est la politique/);
  assert.match(text, /\$x_1\$/, 'code inline intact');
  assert.match(text, /∇_θ J\(θ\) = 𝔼\[Gₜ\]/);
  assert.ok(text.includes(String.raw`print("\(x\)")`), 'bloc de code intact');
  assert.ok(!/\\theta|\\pi|\\nabla/.test(text), 'plus de LaTeX brut hors du code');
});

test('panneau : vscode/media/latex.js est la copie exacte de src/latex.js (régénérée, jamais modifiée à la main)', () => {
  const src = fs.readFileSync(new URL('../src/latex.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  const media = fs.readFileSync(new URL('../vscode/media/latex.js', import.meta.url), 'utf8');
  assert.ok(media.includes(src), 'régénérer : voir l\'en-tête de vscode/media/latex.js');
  assert.match(media, /window\.FsLatex = \{ latexToText, replaceMath, mathBlockStart \}/);
  assert.match(fs.readFileSync(new URL('../vscode/extension.js', import.meta.url), 'utf8'), /media\('latex\.js'\)[\s\S]*media\('panel\.js'\)/, 'chargé avant panel.js');
});
