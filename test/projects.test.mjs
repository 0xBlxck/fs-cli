// Suppression d'un projet France Student SANS perdre ses conversations (faux serveur FS, aucune requête réelle).
// Vérifié en vrai le 17/11/2026 : DELETE /projects/{id} laisse ses conversations pointer vers un projet disparu → 404 pour toujours.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.FS_CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fscli-proj-'));
const api = await import('../src/api.js');

/** faux serveur : projets, conversations (projectId), options pour simuler des pannes et une liste en retard */
function fakeServer({ chats, ignoreDetach = [], staleLists = 0, hiddenFirst = 0 }) {
  const st = { projects: new Set(['P']), chats: new Map(chats.map(c => [c.id, { ...c }])), calls: [], staleLists, hiddenFirst };
  const reply = (method, url) => {
    st.calls.push(`${method} ${url}`);
    let m;
    if ((m = url.match(/^\/projects\/(\w+)\/chats\?/)) && method === 'GET') {
      if (!st.projects.has(m[1])) return [404, {}];
      if (st.hiddenFirst-- > 0) return [200, { chats: [], hasMore: false }];   // rangée à l'instant : pas encore dans la liste (vu en vrai)
      const snapshot = st.staleLists-- > 0 ? chats : [...st.chats.values()].filter(c => c.projectId === m[1]);   // la 1re relecture peut être en retard
      return [200, { chats: snapshot.map(c => ({ id: c.id, title: c.id })), hasMore: false }];
    }
    if ((m = url.match(/^\/projects\/(\w+)\/chats\/(\w+)$/)) && method === 'DELETE') {
      const c = st.chats.get(m[2]); if (c && !ignoreDetach.includes(c.id)) c.projectId = null; return [204, null];
    }
    if ((m = url.match(/^\/projects\/(\w+)$/)) && method === 'DELETE') { st.projects.delete(m[1]); return [204, null]; }
    if ((m = url.match(/^\/chats\/(\w+)$/)) && method === 'GET') {
      const c = st.chats.get(m[1]); if (!c) return [404, {}];
      if (c.projectId && !st.projects.has(c.projectId)) return [404, { message: `Project not found with id: ${c.projectId}` }];
      return [200, { id: c.id, projectId: c.projectId }];
    }
    if ((m = url.match(/^\/chats\/(\w+)$/)) && method === 'DELETE') { st.chats.delete(m[1]); return [204, null]; }
    return [404, {}];
  };
  const request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {}; req.setTimeout = () => req; req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const [status, body] = reply(opts.method || 'GET', opts.path);
      const res = new EventEmitter(); res.statusCode = status; res.setEncoding = () => {}; res.resume = () => {};
      cb(res);
      setImmediate(() => { if (body != null) res.emit('data', JSON.stringify(body)); res.emit('end'); });
    });
    return req;
  };
  return { st, request };
}

test('garder les conversations : chacune est sortie du projet et vérifiée, PUIS le projet est supprimé', async () => {
  const f = fakeServer({ chats: [{ id: 'a', projectId: 'P' }, { id: 'b', projectId: 'P' }] });
  const m = mock.method(https, 'request', f.request);
  try {
    const r = await api.deleteFsProjectSafely('P', { keep: true, settle: 0 });
    assert.equal(r.ok, true); assert.equal(r.kept, 2);
    assert.ok(!f.st.projects.has('P'));
    assert.deepEqual([...f.st.chats.values()].map(c => c.projectId), [null, null], 'conversations intactes, hors projet');
    assert.ok(f.st.calls.indexOf('DELETE /projects/P') > f.st.calls.lastIndexOf('DELETE /projects/P/chats/b'), 'le projet est supprimé en dernier');
  } finally { m.mock.restore(); }
});

test('une conversation refuse de sortir : le projet N\'EST PAS supprimé (sinon elle serait perdue)', async () => {
  const f = fakeServer({ chats: [{ id: 'a', projectId: 'P' }, { id: 'b', projectId: 'P' }], ignoreDetach: ['b'] });
  const m = mock.method(https, 'request', f.request);
  try {
    const r = await api.deleteFsProjectSafely('P', { keep: true, settle: 0 });
    assert.equal(r.ok, false); assert.deepEqual(r.failed, ['b']);
    assert.ok(f.st.projects.has('P')); assert.ok(!f.st.calls.includes('DELETE /projects/P'));
  } finally { m.mock.restore(); }
});

test('liste du projet en retard (déjà vu en vrai) : la conversation elle-même fait foi, le projet est supprimé sans perte', async () => {
  const f = fakeServer({ chats: [{ id: 'a', projectId: 'P' }], staleLists: 2 });
  const m = mock.method(https, 'request', f.request);
  try {
    const r = await api.deleteFsProjectSafely('P', { keep: true, settle: 0 });
    assert.equal(r.ok, true);
    assert.equal(f.st.chats.get('a').projectId, null);
  } finally { m.mock.restore(); }
});

test('supprimer aussi les conversations (choix explicite) : conversations puis projet', async () => {
  const f = fakeServer({ chats: [{ id: 'a', projectId: 'P' }, { id: 'b', projectId: 'P' }] });
  const m = mock.method(https, 'request', f.request);
  try {
    const r = await api.deleteFsProjectSafely('P', { keep: false, settle: 0 });
    assert.equal(r.ok, true); assert.equal(r.deleted, 2);
    assert.equal(f.st.chats.size, 0); assert.ok(!f.st.projects.has('P'));
  } finally { m.mock.restore(); }
});

test('conversation rangée à l\'instant, absente de la 1re liste (cas réel qui a perdu une conversation) : retrouvée après la pause, rien de perdu', async () => {
  const f = fakeServer({ chats: [{ id: 'n', projectId: 'P' }], hiddenFirst: 1 });
  const m = mock.method(https, 'request', f.request);
  try {
    const r = await api.deleteFsProjectSafely('P', { keep: true, settle: 0 });
    assert.equal(r.ok, true); assert.equal(r.kept, 1);
    assert.equal(f.st.chats.get('n').projectId, null, 'sortie du projet avant la suppression');
    assert.ok(f.st.calls.indexOf('DELETE /projects/P/chats/n') < f.st.calls.indexOf('DELETE /projects/P'));
  } finally { m.mock.restore(); }
});
