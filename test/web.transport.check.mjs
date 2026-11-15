import http from 'node:http';
import zlib from 'node:zlib';
import { _requestOnce, htmlToText } from '../src/web.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('ECHEC', n, x); } };
const html = '<html><body><p>' + 'é'.repeat(5000) + '</p></body></html>';
const server = http.createServer((req, res) => {
  const enc = req.url.slice(1);
  const seenHost = req.headers.host;
  if (enc === 'gzip') { res.writeHead(200, { 'content-encoding': 'gzip', 'x-host': seenHost }); res.end(zlib.gzipSync(html)); }
  else if (enc === 'br') { res.writeHead(200, { 'content-encoding': 'br' }); res.end(zlib.brotliCompressSync(html)); }
  else if (enc === 'deflate') { res.writeHead(200, { 'content-encoding': 'deflate' }); res.end(zlib.deflateSync(html)); }
  else if (enc === 'bomb') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(Buffer.alloc(50_000_000, 97))); }
  else if (enc === 'zstd') { res.writeHead(200, { 'content-encoding': 'zstd' }); res.end('x'); }
  else if (enc === 'redir') { res.writeHead(302, { location: '/gzip' }); res.end(); }
  else if (enc === 'echo') { let b = ''; req.on('data', d => b += d); req.on('end', () => { res.writeHead(200); res.end(`${req.method}|${req.headers['content-type']}|${b}`); }); }
  else if (enc === 'hang') { /* ne répond jamais */ }
  else { res.writeHead(200); res.end('plain'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// Hôte fictif "pinned.test" : la connexion doit aller sur l'IP épinglée sans DNS.
const url = p => new URL(`http://pinned.test:${port}/${p}`);
const addrs = [{ address: '127.0.0.1', family: 4 }];

for (const enc of ['gzip', 'br', 'deflate']) {
  const r = await _requestOnce(url(enc), addrs, { maxBytes: 1e6 });
  ok(`${enc} décompressé`, r.status === 200 && r.body.toString('utf8') === html && !r.truncated, `${r.status} ${r.body.length}`);
  if (enc === 'gzip') ok('épinglage : Host = nom fictif, connexion sur IP épinglée', r.headers['x-host'] === `pinned.test:${port}`);
}
let r = await _requestOnce(url('gzip'), addrs, { maxBytes: 100 });
ok('maxBytes tronque + truncated', r.body.length === 100 && r.truncated && r.bytes === 100);
const t0 = Date.now();
r = await _requestOnce(url('bomb'), addrs, { maxBytes: 1000 });
ok('bombe gzip stoppée', r.body.length === 1000 && r.truncated && Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
r = await _requestOnce(url('redir'), addrs, { maxBytes: 1e6 });
ok('302 renvoyé tel quel (pas suivi par la couche basse)', r.status === 302 && r.headers.location === '/gzip');
r = await _requestOnce(url('echo'), addrs, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'q=a+b', maxBytes: 1e6 });
ok('POST corps', r.body.toString() === 'POST|application/x-www-form-urlencoded|q=a+b', r.body.toString());
let err = null; try { await _requestOnce(url('zstd'), addrs, { maxBytes: 1e6 }); } catch (e) { err = e; }
ok('encodage inconnu -> erreur', err && /Encodage/.test(err.message));
const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
err = null; try { await _requestOnce(url('hang'), addrs, { maxBytes: 1e6, signal: ac.signal }); } catch (e) { err = e; }
ok('abort pendant l’attente', err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'), String(err));
// IP épinglée différente : le nom fictif ne doit jamais être résolu par DNS
err = null; try { await _requestOnce(new URL(`http://pinned.test:1/`), addrs, { maxBytes: 10 }); } catch (e) { err = e; }
ok('port fermé -> ECONNREFUSED (pas ENOTFOUND)', err && err.code === 'ECONNREFUSED', err?.code);
// HTML bullets
ok('puces consécutives', htmlToText('<ul><li>A</li><li>B</li></ul>') === '• A\n• B', JSON.stringify(htmlToText('<ul><li>A</li><li>B</li></ul>')));
server.closeAllConnections?.(); server.close();
console.log(`Résultat transport : ${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
