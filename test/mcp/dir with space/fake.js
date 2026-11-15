// Faux serveur MCP stdio
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const replies = [];
process.stdout.write('bonjour je ne suis pas du JSON\n');
process.stderr.write('fake-mcp: demarrage\n');
const T1 = [
  { name: 'echo', description: 'Renvoie le texte.\n  Avec une description longue '.padEnd(150, 'x'), inputSchema: { type: 'object', properties: { text: { type: 'string' }, upper: { type: 'boolean' } }, required: ['text'] } },
  { name: 'fail', description: 'Renvoie isError', inputSchema: { type: 'object', properties: {} } },
];
const T2 = [
  { name: 'slow', description: 'Met 5 s', inputSchema: { type: 'object', properties: {} } },
  { name: 'img', description: 'Image', inputSchema: { type: 'object', properties: {} } },
  { name: 'replies', description: 'Réponses du client aux requêtes serveur', inputSchema: { type: 'object', properties: {} } },
  { name: 'dotted.tool', description: 'nom avec point', inputSchema: { type: 'object', properties: {} } },
];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === undefined) { replies.push(m); return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } } });
  } else if (m.method === 'notifications/initialized') {
    send({ jsonrpc: '2.0', id: 's1', method: 'ping' });
    send({ jsonrpc: '2.0', id: 's2', method: 'roots/list' });
  } else if (m.method === 'tools/list') {
    if (!m.params?.cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: T1, nextCursor: 'p2' } });
    else send({ jsonrpc: '2.0', id: m.id, result: { tools: T2 } });
  } else if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    if (name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: a.upper ? String(a.text).toUpperCase() : a.text }] } });
    else if (name === 'fail') send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'ça a échoué' }] } });
    else if (name === 'slow') setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'lent' }] } }), 5000);
    else if (name === 'img') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'voici' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'resource', resource: { uri: 'file:///x.txt', text: 'contenu' } }] } });
    else if (name === 'replies') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(replies) }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool: ' + name } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
  }
});
