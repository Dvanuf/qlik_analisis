import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listApps, listAppsViaHub } from '../src/extract/session.js';
import { hubRootUrl } from '../src/extract/url.js';

/**
 * Список приложений.
 *
 * Сессия, открытая на конкретном приложении (`/app/<id>`), не даёт серверных
 * методов — вызов GetDocList на ней заканчивается «Method not found».
 * Поэтому список берётся либо через REST API хаба (Qlik Sense), либо через
 * движок, подключённый к корню хаба (QlikView 12).
 */

test('hubRootUrl: убирает привязку к приложению', () => {
  assert.equal(hubRootUrl('wss://host/app/abc-123'), 'wss://host/');
  assert.equal(hubRootUrl('wss://host/app/abc-123?reloadUri=x&qlik-csrf-token=y'), 'wss://host/');
  assert.equal(hubRootUrl('wss://host:4747/app/abc-123'), 'wss://host:4747/');
  // Без привязки к приложению — без изменений.
  assert.equal(hubRootUrl('wss://host/'), 'wss://host/');
  assert.equal(hubRootUrl('wss://host/app'), 'wss://host/app');
});

test('listAppsViaHub: без cookie возвращает null', async () => {
  assert.equal(await listAppsViaHub({ url: 'wss://host/app/abc' }), null);
});

test('listApps: список приложений через REST API хаба', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/apps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        items: [{ id: 'app-1', title: 'Продажи', fileSize: 1024, modifiedDate: '2026-01-01' }],
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const apps = await listApps({
      url: `http://127.0.0.1:${port}/app/app-1`,
      cookie: 'X-Qlik-Session=abc',
    });
    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, 'app-1');
    assert.equal(apps[0].title, 'Продажи');
    assert.equal(apps[0].size, 1024);
    assert.equal(apps[0].lastReload, '2026-01-01');
  } finally {
    server.close();
  }
});

test('listApps: следует за редиректом хаба', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/apps') {
      res.writeHead(301, { Location: '/api/v1/apps/' });
      res.end();
      return;
    }
    if (req.url === '/api/v1/apps/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: 'app-9', title: 'После редиректа' }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const apps = await listApps({
      url: `http://127.0.0.1:${port}/app/engineData`,
      cookie: 'X-Qlik-Session=abc',
    });
    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, 'app-9');
    assert.equal(apps[0].title, 'После редиректа');
  } finally {
    server.close();
  }
});

test('listApps: REST API хаба недоступен — падает не «Method not found» молча', async () => {
  const server = createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // REST не дал список — идём в движок, он недоступен: понятная ошибка
    // с подсказкой, а не голое «Method not found» от хаба.
    await assert.rejects(
      () => listApps({ url: `http://127.0.0.1:${port}/app/app-1`, cookie: 'X-Qlik-Session=abc' }),
      (err) => {
        assert.match(String(err?.message ?? err), /Не удалось получить список приложений/);
        assert.match(String(err?.message ?? err), /Войти в хаб/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});
