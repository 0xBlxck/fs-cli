// Code reçu minifié sur une ligne (document du site écrit par GPT) → remis en forme sans JAMAIS changer ce qu'il fait.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { formatJs, formatCss, formatHtml, prettifyIfMinified } = await import('../src/prettify.js');
const run = code => { const out = []; vm.runInNewContext(code, { log: x => out.push(JSON.stringify(x)) }); return out.join('|'); };
const noWs = s => s.replace(/\s+/g, '');

test('JS : même résultat à l\'exécution malgré les pièges (chaînes, gabarits, regex, commentaires, for, else, objets)', () => {
  const src = 'const a="x;{y}",b=\'}\';let n=0;for(let i=0;i<3;i++){n+=i}' +
    'const t=`a;${n>1?`{${b}}`:"z"};c`;const r=/[;{}]\\//g.test("a;/");/* ; { } */const o={k:1,f(){return{z:2}}};' +
    'function f(x){if(x){return x/2/1}else{return-1}}try{null.x}catch(e){log("err")}finally{log("fin")}' +
    'const d=10/2/5;label:{log(a+b)}log([a,b,n,t,r,o.f().z,f(4),f(0),d]);while(n-->0){}log(n)';
  const out = formatJs(src);
  assert.equal(run(out), run(src), 'même sortie');
  assert.ok(out.split('\n').length > 15, 'sur plusieurs lignes');
  assert.match(out, /for\(let i=0;i<3;i\+\+\)\{/, 'for (…;…;…) jamais coupé');
  assert.match(out, /\} else \{|\}else\{/, '« } else » reste lié');
  assert.match(out, /const a="x;\{y\}"/, 'chaîne intacte');
  assert.match(out, /\/\[;\{\}\]\\\/\/g/, 'regex intacte');
  assert.match(out, /`a;\$\{n>1\?`\{\$\{b\}\}`:"z"\};c`/, 'gabarit imbriqué intact');
  assert.equal(noWs(out), noWs(src));
});

test('CSS : règles sur plusieurs lignes ; :hover, @media et chaînes intacts', () => {
  const src = 'a:hover{color:red;content:"a;{b}"}@media (max-width:600px){.x{margin:0;padding:1px 2px}}b{}';
  const out = formatCss(src);
  assert.equal(noWs(out), noWs(src));
  assert.match(out, /^a:hover \{\n  color:red;\n  content:"a;\{b\}"\n\}/);
  assert.match(out, /@media \(max-width:600px\) \{\n  \.x \{\n    margin:0;\n    padding:1px 2px\n  \}\n\}/);
});

test('HTML : blocs et SVG sur plusieurs lignes ; éléments en ligne, <pre>, texte SVG jamais coupés ; script formaté et valide', () => {
  const src = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>T</title><style>p{margin:0}</style></head><body>' +
    '<div><p>Bonjour <b>toi</b><span>a</span><span>b</span></p><pre>  x\n   y</pre></div>' +
    '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><text x="1"><tspan>A</tspan><tspan>B</tspan></text></svg>' +
    '<button>OK</button><script>const x=1;if(x){log("ok")}</script></body></html>';
  const out = formatHtml(src);
  assert.equal(noWs(out), noWs(src), 'seuls des espaces et retours à la ligne ajoutés');
  assert.match(out, /<span>a<\/span><span>b<\/span>/, 'deux éléments en ligne : jamais séparés (espace visible)');
  assert.match(out, /Bonjour <b>toi<\/b>/);
  assert.match(out, /<pre> {2}x\n {3}y<\/pre>/, '<pre> tel quel');
  assert.match(out, /<tspan>A<\/tspan><tspan>B<\/tspan>/, 'texte SVG jamais coupé');
  assert.match(out, /\n\s+<linearGradient id="g">\n\s+<stop offset="0"\/>/, 'éléments SVG sur leurs lignes');
  assert.match(out, /\n\s+<meta charset="utf-8">\n/);
  const js = out.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.equal(run(js), run('const x=1;if(x){log("ok")}'));
  assert.ok(out.split('\n').length > 15);
});

test('prettifyIfMinified : seulement le code sur une ligne (≥ 400 car.), jamais un .min.js ni un fichier déjà lisible', () => {
  const big = '<!doctype html><html><head><title>x</title></head><body>' + '<div><p>texte</p></div>'.repeat(30) + '</body></html>';
  assert.ok(prettifyIfMinified('page.html', big).split('\n').length > 20);
  assert.equal(prettifyIfMinified('page.html', big.replace(/<\/div>/g, '</div>\n')), big.replace(/<\/div>/g, '</div>\n'), 'déjà sur plusieurs lignes : intact');
  const js = 'const a=1;'.repeat(60);
  assert.equal(prettifyIfMinified('lib.min.js', js), js);
  assert.ok(prettifyIfMinified('lib.js', js).split('\n').length >= 60);
  assert.equal(prettifyIfMinified('court.js', 'a=1;b=2'), 'a=1;b=2');
  assert.equal(prettifyIfMinified('notes.md', 'x'.repeat(500)), 'x'.repeat(500), 'autres types : intact');
});
