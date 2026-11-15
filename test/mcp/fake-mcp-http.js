import http from 'node:http';
export function startHttp() {
  const state = { deleted: 0, sessionOk: 0, badSession: 0, initialized: false };
  const server = http.createServer((req, res) => {
    if (req.url === '/sse') { res.writeHead(405); return res.end('no'); }
    if (req.url === '/auth') { res.writeHead(401); return res.end('no'); }
    if (req.method === 'DELETE') { state.deleted++; res.writeHead(200); return res.end(); }
    let body = ''; req.on('data', (d) => body += d); req.on('end', () => {
      const m = JSON.parse(body || '{}');
      const sid = req.headers['mcp-session-id'];
      if (m.method !== 'initialize') { if (sid === 'SESS-42') state.sessionOk++; else { state.badSession++; res.writeHead(400); return res.end('no session'); } }
      const json = (obj, extra = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
      const sse = (objs) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const o of objs) res.write(`event: message\r\ndata: ${JSON.stringify(o)}\r\n\r\n`); res.end(); };
      if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fakehttp', version: '1' } } }, { 'Mcp-Session-Id': 'SESS-42' });
      if (m.method === 'notifications/initialized') { state.initialized = true; res.writeHead(202); return res.end(); }
      if (m.method === 'tools/list') return sse([{ jsonrpc: '2.0', method: 'notifications/message', params: {} }, { jsonrpc: '2.0', id: 'srv', method: 'ping' }, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'sum', description: 'additionne', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }, { name: 'sse_tool', description: 'via SSE', inputSchema: { type: 'object', properties: {} } }, { name: 'hang', description: 'ne répond pas', inputSchema: { type: 'object' } }] } }]);
      if (m.method === 'tools/call') {
        const { name, arguments: a } = m.params;
        if (name === 'sum') return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.a + a.b) }] } });
        if (name === 'sse_tool') return sse([{ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'flux sse ok' }] } }]);
        if (name === 'hang') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': keepalive\n\n'); return; }
      }
      json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}
