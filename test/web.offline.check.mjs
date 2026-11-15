import http from 'node:http';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {
  isPublicIp, assertPublicUrl, safeFetch, htmlToText, webSearch, formatSearchResults,
  _followRedirectTarget, _parseDuckHtml
} from '../src/web.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('ECHEC', name, extra); } };

// ---- isPublicIp
const table = [
  ['8.8.8.8', true], ['1.1.1.1', true], ['93.184.216.34', true], ['172.15.255.255', true], ['172.32.0.1', true],
  ['100.63.255.255', true], ['100.128.0.1', true], ['198.17.0.1', true], ['198.20.0.1', true], ['223.255.255.255', true],
  ['2606:4700:4700::1111', true], ['2001:4860:4860::8888', true], ['2a00:1450:4007:80f::200e', true],
  ['::ffff:8.8.8.8', true], ['::ffff:808:808', true], ['64:ff9b::808:808', true], ['64:ff9b::8.8.8.8', true],
  ['127.0.0.1', false], ['127.255.255.254', false], ['0.0.0.0', false], ['0.1.2.3', false], ['10.0.0.5', false],
  ['10.255.255.255', false], ['172.16.0.1', false], ['172.31.255.255', false], ['192.168.1.1', false],
  ['169.254.169.254', false], ['169.254.0.1', false], ['100.64.0.1', false], ['100.127.255.255', false],
  ['224.0.0.1', false], ['239.255.255.255', false], ['240.0.0.1', false], ['255.255.255.255', false],
  ['192.0.0.1', false], ['198.18.0.1', false], ['198.19.255.255', false], ['192.0.2.5', false],
  ['198.51.100.7', false], ['203.0.113.9', false],
  ['::1', false], ['::', false], ['fe80::1', false], ['fe80::abcd%eth0', false], ['febf::1', false], ['fc00::1', false],
  ['fd12:3456::1', false], ['ff02::1', false], ['2001:db8::1', false], ['::ffff:127.0.0.1', false],
  ['::ffff:7f00:1', false], ['::ffff:10.0.0.1', false], ['::ffff:a00:1', false], ['::ffff:169.254.169.254', false],
  ['::ffff:a9fe:a9fe', false], ['::ffff:c0a8:101', false], ['0:0:0:0:0:ffff:7f00:1', false],
  ['64:ff9b::7f00:1', false], ['64:ff9b::10.0.0.1', false], ['64:ff9b::a9fe:a9fe', false],
  ['[::1]', false], ['2002:7f00:1::', false], ['2002:808:808::', true],
  ['', false], ['abc', false], ['999.1.1.1', false], ['1.2.3', false], ['010.0.0.1', false], [null, false], [undefined, false], [42, false]
];
for (const [ip, expected] of table) ok(`isPublicIp(${ip})`, isPublicIp(ip) === expected, `obtenu ${isPublicIp(ip)}`);
console.log(`isPublicIp : ${table.length} cas`);

// ---- assertPublicUrl
const refused = [
  'http://localhost/', 'http://LOCALHOST:8080/', 'http://foo.localhost/', 'http://printer.local/', 'http://db.internal/',
  'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://[::1]/',
  'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.5/', 'http://192.168.0.1/', 'https://user:pass@example.com/', 'https://user@example.com/',
  'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'http://0/', 'http://localhost./'
];
for (const u of refused) {
  let threw = null;
  try { await assertPublicUrl(u); } catch (e) { threw = e; }
  ok(`refus ${u}`, threw instanceof Error, 'accepté !');
  if (threw) ok(`message fr ${u}`, /refus|invalide|introuvable|identifiants/i.test(threw.message), threw.message);
}
// résolution DNS fake -> privée / mixte
const fakeResolve = map => async h => { if (!map[h]) { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } return map[h]; };
let threw;
threw = null; try { await assertPublicUrl('http://evil.test/', { _resolve: fakeResolve({ 'evil.test': [{ address: '127.0.0.1', family: 4 }] }) }); } catch (e) { threw = e; }
ok('dns -> loopback refusé', !!threw);
threw = null; try { await assertPublicUrl('http://mix.test/', { _resolve: fakeResolve({ 'mix.test': [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }) }); } catch (e) { threw = e; }
ok('dns mixte refusé', !!threw);
threw = null; try { await assertPublicUrl('http://nx.test/', { _resolve: fakeResolve({}) }); } catch (e) { threw = e; }
ok('dns introuvable', !!threw && /introuvable/.test(threw.message));
const good = await assertPublicUrl('http://pub.test/', { _resolve: fakeResolve({ 'pub.test': [{ address: '8.8.8.8', family: 4 }] }) });
ok('dns public accepté', good.addresses[0].address === '8.8.8.8' && good.url.hostname === 'pub.test');

// ---- serveur local : safeFetch doit refuser
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('<html><head><title>Gz &amp; Co</title></head><body><p>bonjour</p></body></html>')); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('secret');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const r1 = await safeFetch(`http://127.0.0.1:${port}/`);
ok('safeFetch refuse 127.0.0.1', r1.ok === false && /refus/i.test(r1.error) && hits === 0, JSON.stringify(r1));
const r1b = await safeFetch(`http://localhost:${port}/`);
ok('safeFetch refuse localhost', r1b.ok === false && hits === 0);
const r1c = await safeFetch(`http://2130706433:${port}/`);
ok('safeFetch refuse décimal', r1c.ok === false && hits === 0);

// ---- redirection simulée vers 127.0.0.1 (transport injecté, serveur local jamais touché)
const resolver = fakeResolve({ 'pub.test': [{ address: '8.8.8.8', family: 4 }], 'other.test': [{ address: '1.1.1.1', family: 4 }] });
const seen = [];
const transport = (location, extra = {}) => async (url, addrs, o) => {
  seen.push({ href: url.href, addr: addrs[0].address, headers: o.headers });
  if (url.hostname === 'pub.test') return { status: 302, headers: { location }, body: Buffer.alloc(0), truncated: false, bytes: 0 };
  return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok'), truncated: false, bytes: 2, ...extra };
};
let r = await safeFetch('http://pub.test/', { _resolve: resolver, _request: transport(`http://127.0.0.1:${port}/x`) });
ok('redirection -> 127.0.0.1 refusée', r.ok === false && /Redirection refusée/.test(r.error) && seen.length === 1 && hits === 0, JSON.stringify(r));
seen.length = 0;
r = await safeFetch('http://pub.test/', { _resolve: resolver, _request: transport('http://169.254.169.254/latest') });
ok('redirection -> metadata refusée', r.ok === false && seen.length === 1);
seen.length = 0;
r = await safeFetch('http://pub.test/', { _resolve: resolver, _request: transport('http://[::ffff:7f00:1]/') });
ok('redirection -> ::ffff:7f00:1 refusée', r.ok === false && seen.length === 1);
seen.length = 0;
r = await safeFetch('http://pub.test/', { _resolve: resolver, _request: transport('file:///etc/passwd') });
ok('redirection -> file: refusée', r.ok === false);
seen.length = 0;
r = await safeFetch('http://pub.test/', { _resolve: resolver, _request: transport('http://other.test/y'), headers: { Authorization: 'Bearer x', 'X-Test': '1' } });
ok('redirection -> publique suivie', r.ok === true && r.redirects === 1 && r.url === 'http://other.test/y' && r.text === 'ok', JSON.stringify(r));
ok('épinglage : IP vérifiée transmise', seen[0].addr === '8.8.8.8' && seen[1].addr === '1.1.1.1');
ok('authorization retiré cross-origin', seen[0].headers.authorization === 'Bearer x' && seen[1].headers.authorization === undefined && seen[1].headers['x-test'] === '1');
// DNS rebinding simulé : 2e résolution différente de la 1re ne peut pas servir car l'IP est épinglée
let calls = 0;
const rebinding = async () => (++calls === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
seen.length = 0;
r = await safeFetch('http://rebind.test/', { _resolve: rebinding, _request: async (u, a) => { seen.push(a[0].address); return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('x'), truncated: false, bytes: 1 }; } });
ok('rebinding : une seule résolution, IP épinglée', calls === 1 && seen[0] === '8.8.8.8' && r.ok);
// boucle infinie
r = await safeFetch('http://pub.test/', { _resolve: resolver, maxRedirects: 3, _request: async (u) => ({ status: 301, headers: { location: 'http://pub.test/loop' }, body: Buffer.alloc(0), truncated: false, bytes: 0 }) });
ok('maxRedirects respecté', r.ok === false && /Trop de redirections/.test(r.error) && r.redirects === 3, JSON.stringify(r));
// _followRedirectTarget direct
threw = null;
try { await _followRedirectTarget('http://pub.test/a', '//127.0.0.1/', { _resolve: resolver }); } catch (e) { threw = e; }
ok('_followRedirectTarget //127.0.0.1', !!threw);
const t = await _followRedirectTarget('http://pub.test/a/b', '../c', { _resolve: resolver });
ok('_followRedirectTarget relatif', t.url.href === 'http://pub.test/c');

// ---- types et tailles via transport injecté
const mk = (headers, body, extra = {}) => async () => ({ status: 200, headers, body: Buffer.from(body), truncated: false, bytes: Buffer.byteLength(body), ...extra });
const pubResolver = async () => [{ address: '8.8.8.8', family: 4 }];
const f = (h, b, o = {}, e = {}) => safeFetch('http://pub.test/', { _resolve: pubResolver, _request: mk(h, b, e), ...o });
r = await f({ 'content-type': 'image/png' }, 'xx'); ok('image refusée', !r.ok && /non pris en charge/.test(r.error));
r = await f({ 'content-type': 'application/pdf' }, 'xx'); ok('pdf refusé', !r.ok);
r = await f({ 'content-type': 'application/zip' }, 'xx'); ok('zip refusé', !r.ok);
r = await f({ 'content-type': 'application/octet-stream' }, 'xx'); ok('octet-stream refusé', !r.ok);
r = await f({ 'content-type': 'application/json' }, '{"a":1,"b":[1,2]}'); ok('json indenté', r.ok && r.text === '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}', r.text);
r = await f({ 'content-type': 'application/json' }, '{pas json'); ok('json invalide gardé brut', r.ok && r.text === '{pas json');
r = await f({ 'content-type': 'application/xml' }, '<a>1</a>'); ok('xml accepté', r.ok && r.text === '<a>1</a>');
r = await f({ 'content-type': 'text/csv' }, 'a,b'); ok('text/* accepté', r.ok && r.text === 'a,b');
r = await f({ 'content-type': 'text/plain' }, 'x'.repeat(100), { maxChars: 10 }); ok('maxChars tronque', r.ok && r.text.length === 10 && r.truncated);
r = await f({ 'content-type': 'text/plain' }, 'abc', {}, { truncated: true }); ok('truncated octets propagé', r.truncated === true);
r = await f({ 'content-type': 'text/html' }, '<html><head><title> Mon  titre </title></head><body><h1>Salut</h1></body></html>'); ok('titre html', r.title === 'Mon titre' && r.text === 'Salut', JSON.stringify(r));
const latin = Buffer.from('<p>caf\xe9</p>', 'latin1');
r = await safeFetch('http://pub.test/', { _resolve: pubResolver, _request: async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' }, body: latin, truncated: false, bytes: latin.length }) });
ok('charset header latin1', r.text === 'café', r.text);
const latin2 = Buffer.from('<html><head><meta charset="windows-1252"></head><body>caf\xe9</body></html>', 'latin1');
r = await safeFetch('http://pub.test/', { _resolve: pubResolver, _request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: latin2, truncated: false, bytes: latin2.length }) });
ok('charset meta', r.text === 'café', r.text);
r = await safeFetch('http://pub.test/', { _resolve: pubResolver, _request: async () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=zzz-inconnu' }, body: Buffer.from('é'), truncated: false, bytes: 2 }) });
ok('charset inconnu -> utf-8', r.text === 'é', r.text);
r = await safeFetch('http://pub.test/', { _resolve: pubResolver, _request: async () => ({ status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>nope</p>'), truncated: false, bytes: 11 }) });
ok('404 -> ok:false + status', r.ok === false && r.status === 404 && /404/.test(r.error));
r = await safeFetch('http://pub.test/', { _resolve: pubResolver, _request: async () => { const e = new Error('boom'); e.code = 'ECONNREFUSED'; throw e; } });
ok('erreur réseau -> ok:false', r.ok === false && /refusée/.test(r.error), r.error);

// ---- annulation
const ac = new AbortController(); ac.abort();
let abortName = null; try { await safeFetch('http://pub.test/', { signal: ac.signal }); } catch (e) { abortName = e.name; }
ok('signal déjà annulé -> AbortError', abortName === 'AbortError');
const ac2 = new AbortController();
const slow = (u, a, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
const p = safeFetch('http://pub.test/', { _resolve: pubResolver, _request: slow, signal: ac2.signal });
setTimeout(() => ac2.abort(), 50);
abortName = null; try { await p; } catch (e) { abortName = e.name; }
ok('annulation en vol -> AbortError', abortName === 'AbortError');
r = await safeFetch('http://pub.test/', { _resolve: pubResolver, _request: slow, timeoutMs: 80 });
ok('timeout -> ok:false', r.ok === false && /Délai/.test(r.error), JSON.stringify(r));

// ---- transport réel (node:http) contre le serveur local, en contournant le garde-fou via _resolve ? NON : on teste
// requestOnce indirectement impossible (127.0.0.1 refusé). Test gzip/limite via serveur public simulé = hors scope.
server.close();

// ---- htmlToText
const sample = `<!DOCTYPE html><html><head><title>T</title><style>.a{}</style></head><body>
<!-- commentaire --><script>alert("x")</script><noscript>no js</noscript><svg><path/></svg><template><p>tpl</p></template>
<header>En-tête</header><h1>Titre &amp; sous-titre</h1><p>Un&nbsp;paragraphe   avec   espaces<br>ligne 2</p>
<ul><li>Un</li><li>Deux &#233;t&#xE9; &lt;b&gt; &hellip; &#128512;</li></ul>
<table><tr><td>a</td><td>b</td></tr></table><div>   </div><div></div><div></div><div>Fin &unknown; &#0; &#xD800;</div><footer>Pied</footer></body></html>`;
const txt = htmlToText(sample);
console.log('--- htmlToText ---\n' + txt + '\n---');
ok('htmlToText : pas de script/style/commentaire', !/alert|\.a\{|commentaire|no js|tpl|path|<|>(?!.*&gt;)/.test(txt.replace('<b>', '')));
ok('htmlToText : puces', txt.includes('• Un') && txt.includes('• Deux'));
ok('htmlToText : entités', txt.includes('Titre & sous-titre') && txt.includes('été <b> … 😀') && txt.includes('Un paragraphe avec espaces'));
ok('htmlToText : entité inconnue gardée', txt.includes('&unknown;') && txt.includes('&#0;'));
ok('htmlToText : max 2 sauts', !/\n{3,}/.test(txt));
ok('htmlToText : head retiré', !txt.includes('T\n') || !txt.startsWith('T'));
ok('htmlToText : script non fermé', htmlToText('a<script>evil(') === 'a');
ok('htmlToText : <header> pas pris pour <head>', htmlToText('<header>X</header>') === 'X');
ok('htmlToText : "a < b"', htmlToText('<p>1 < 2 et 3 > 2</p>') === '1 < 2 et 3 > 2', htmlToText('<p>1 < 2 et 3 > 2</p>'));
const big = '<script>'.repeat(20000);
const t0 = Date.now(); htmlToText(big); ok('htmlToText linéaire (script non fermés)', Date.now() - t0 < 1000, `${Date.now() - t0}ms`);

// ---- parseur DuckDuckGo hors-ligne
const ddg = `<html><body><div class="results">
<div class="result results_links results_links_deep web-result result--ad"><div class="links_main"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_provider=bing&u3=x">Pub <b>achat</b></a></h2><a class="result__snippet" href="//duckduckgo.com/y.js?x">Annonce</a></div></div>
<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2&amp;rut=abc">Exemple <b>un</b> &amp; co</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Un <b>extrait</b> avec &quot;entités&quot; &#39;ok&#39;.</a></div></div>
<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
<h2 class="result__title"><a class="result__a" rel="nofollow" href="/l/?kh=-1&uddg=https%3A%2F%2Ffr.wikipedia.org%2Fwiki%2FNode.js&rut=zz">Node.js — Wikipédia</a></h2>
<a class="result__snippet" href="x">Node.js est une plateforme.</a></div></div>
<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2">Doublon</a></h2><a class="result__snippet">dup</a></div>
<div class="result"><h2><a class="result__a" href="https://direct.example.org/page">Lien direct</a></h2><div class="result__snippet">Sans lien</div></div>
</div></body></html>`;
const parsed = _parseDuckHtml(ddg);
ok('ddg : 4 résultats bruts hors pub', parsed.length === 4, JSON.stringify(parsed));
const fakeReq = body => async (u, a, o) => ({ status: 200, headers: {}, body: Buffer.from(body), truncated: false, bytes: body.length, _o: o });
let captured;
const ddgSearch = await webSearch('node js', {
  max: 10, _resolve: pubResolver,
  _request: async (u, a, o) => { captured = { u, a, o }; return { status: 200, headers: {}, body: Buffer.from(ddg), truncated: false, bytes: ddg.length }; }
});
const savedKey = process.env.FS_SEARCH_API_KEY; delete process.env.FS_SEARCH_API_KEY;
const ddgSearch2 = await webSearch('node js', { max: 10, _resolve: pubResolver, _request: async (u, a, o) => { captured = { u, a, o }; return { status: 200, headers: {}, body: Buffer.from(ddg), truncated: false, bytes: ddg.length }; } });
if (savedKey) process.env.FS_SEARCH_API_KEY = savedKey;
ok('ddg : provider', ddgSearch2.provider === 'duckduckgo');
ok('ddg : requête POST html.duckduckgo.com avec q', captured.u.hostname === 'html.duckduckgo.com' && captured.o.method === 'POST' && captured.o.body === 'q=node+js');
ok('ddg : dédoublonnage + décodage', ddgSearch2.results.length === 3 &&
  ddgSearch2.results[0].url === 'https://example.com/a?x=1&y=2' &&
  ddgSearch2.results[0].title === 'Exemple un & co' &&
  ddgSearch2.results[0].snippet === 'Un extrait avec "entités" \'ok\'.' &&
  ddgSearch2.results[1].url === 'https://fr.wikipedia.org/wiki/Node.js' &&
  ddgSearch2.results[2].url === 'https://direct.example.org/page' && ddgSearch2.results[2].snippet === 'Sans lien', JSON.stringify(ddgSearch2.results));
ok('ddg : max borné', (await webSearch('x', { max: 1, _resolve: pubResolver, _request: fakeReq(ddg) })).results.length === 1);
console.log(formatSearchResults(ddgSearch2.results));
ok('formatSearchResults', formatSearchResults(ddgSearch2.results).startsWith('1. Exemple un & co\n   https://example.com/a?x=1&y=2\n   Un extrait') && formatSearchResults([]) === 'Aucun résultat.');

// captcha / anomalie
const anomaly = '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div> captcha anomaly</body></html>';
threw = null; try { await webSearch('x', { _resolve: pubResolver, _request: fakeReq(anomaly) }); } catch (e) { threw = e; }
ok('ddg anomalie -> Error', threw && /anomalie|captcha/i.test(threw.message), threw?.message);
threw = null; try { await webSearch('x', { _resolve: pubResolver, _request: async () => ({ status: 202, headers: {}, body: Buffer.from(''), truncated: false, bytes: 0 }) }); } catch (e) { threw = e; }
ok('ddg 202 -> Error', threw && /anomalie|captcha/i.test(threw.message));
// validations
for (const bad of ['', '   ', 'x'.repeat(401), 12, null]) {
  threw = null; try { await webSearch(bad); } catch (e) { threw = e; }
  ok(`requête invalide ${String(bad).slice(0, 8)}`, threw instanceof Error);
}
const okLong = await webSearch('x'.repeat(400), { _resolve: pubResolver, _request: fakeReq(ddg) }); ok('400 caractères OK', okLong.results.length > 0);
// provider none
process.env.FS_SEARCH_PROVIDER = 'none';
threw = null; try { await webSearch('x'); } catch (e) { threw = e; }
ok('FS_SEARCH_PROVIDER=none', threw && /désactivée/.test(threw.message));
delete process.env.FS_SEARCH_PROVIDER;
// Brave
process.env.FS_SEARCH_API_KEY = 'SECRETKEY123';
const braveJson = JSON.stringify({ web: { results: [{ title: 'A <strong>b</strong>', url: 'https://a.example/', description: 'Desc <strong>x</strong> &amp; y' }, { title: 'dup', url: 'https://a.example/' }, { title: 'js', url: 'javascript:alert(1)' }] } });
const bs = await webSearch('brave test', { max: 99, _resolve: pubResolver, _request: async (u, a, o) => { captured = { u, o }; return { status: 200, headers: {}, body: Buffer.from(braveJson), truncated: false, bytes: 1 }; } });
ok('brave : provider/URL/en-têtes', bs.provider === 'brave' && captured.u.hostname === 'api.search.brave.com' && captured.u.searchParams.get('count') === '10' && captured.u.searchParams.get('q') === 'brave test' && captured.o.headers['x-subscription-token'] === 'SECRETKEY123' && captured.o.headers.accept === 'application/json');
ok('brave : résultats nettoyés', bs.results.length === 1 && bs.results[0].title === 'A b' && bs.results[0].snippet === 'Desc x & y', JSON.stringify(bs.results));
for (const [st, re] of [[429, /quota/], [401, /clé/], [500, /HTTP 500/]]) {
  threw = null; try { await webSearch('q', { _resolve: pubResolver, _request: async () => ({ status: st, headers: {}, body: Buffer.from(''), truncated: false, bytes: 0 }) }); } catch (e) { threw = e; }
  ok(`brave ${st}`, threw && re.test(threw.message) && !threw.message.includes('SECRETKEY123'), threw?.message);
}
threw = null; try { await webSearch('q', { _resolve: pubResolver, _request: async () => { throw new Error('fuite SECRETKEY123'); } }); } catch (e) { threw = e; }
ok('clé masquée dans les erreurs', threw && !threw.message.includes('SECRETKEY123') && threw.message.includes('***'));
delete process.env.FS_SEARCH_API_KEY;
const ac3 = new AbortController(); ac3.abort();
abortName = null; try { await webSearch('x', { signal: ac3.signal }); } catch (e) { abortName = e.name; }
ok('webSearch signal annulé', abortName === 'AbortError');

console.log(`\nRésultat offline : ${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
