/**
 * GitLab-клиент: индекс папок, скачивание raw-файла, диагностика 401/404.
 * Локальный HTTP-сервер имитирует API GitLab.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchGitLabIndex, fetchGitLabFileText } from '../src/extract/gitlab.js';

const TREE = JSON.stringify([
  { type: 'blob', name: 'P&L.qvs', path: '03_Load_Layer/P&L.qvs' },
  { type: 'blob', name: 'common.qvs', path: '03_Load_Layer/common.qvs' },
  { type: 'tree', name: 'sub', path: '03_Load_Layer/sub' },
]);

test('fetchGitLabIndex: индекс .qvs по папкам, без токена', async () => {
  const server = createServer((req, res) => {
    if (req.url.includes('/repository/tree') && req.url.includes('qlik%2Fqlik-sense')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(TREE);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
  const r = await fetchGitLabIndex({
    baseUrl: `http://127.0.0.1:${port}`,
    targets: [
      { project: 'qlik/qlik-sense', folder: '03_Load_Layer' },
      { project: 'qlik/qlik-view', folder: '03_Load_Layer' },
    ],
  });
  assert.equal(r.index.get('p&l.qvs').path, '03_Load_Layer/P&L.qvs');
  assert.equal(r.index.get('common.qvs').projectId, 'qlik/qlik-sense');
  assert.equal(r.index.has('sub'), false, 'папки в индекс не попадают');
  assert.ok(r.notes.some((x) => x.includes('qlik-view')), '404 папки — в notes');
  } finally { server.close(); }
});

test('fetchGitLabFileText: raw-файл текстом, 401 с токеном-ошибкой', async () => {
  const server = createServer((req, res) => {
    if (req.url.includes('/raw') && req.url.includes('P%26L.qvs')) {
      if (req.headers['private-token'] === 'bad') { res.writeHead(401); res.end('401 Unauthorized'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Продажи:\nLOAD Код FROM qvd;');
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
  const ok = await fetchGitLabFileText({
    baseUrl: `http://127.0.0.1:${port}`, projectId: 'qlik/qlik-sense',
    path: '03_Load_Layer/P&L.qvs', ref: 'master',
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.content.includes('Продажи:'));
  const bad = await fetchGitLabFileText({
    baseUrl: `http://127.0.0.1:${port}`, projectId: 'qlik/qlik-sense',
    path: '03_Load_Layer/P&L.qvs', ref: 'master', token: 'bad',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.note.includes('401'));
  } finally { server.close(); }
});
