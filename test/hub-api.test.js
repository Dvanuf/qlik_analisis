import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchHubApps, hubApiBase, parseHubApps } from '../src/extract/hub-api.js';
import { appMeta, listApps, listAppsViaHub, metaCoverage } from '../src/extract/session.js';

/**
 * Метаданные приложений: REST API хаба (/api/hub/v1/apps) и разбор ответа.
 *
 * Хаб Qlik Sense отдаёт данные в формате JSON:API: имена владельца и потока
 * лежат в секции included, тэги — это свойства приложения (customProperties).
 */

/** Реалистичный фрагмент ответа хаба. */
const HUB_PAYLOAD = {
  data: [{
    type: 'App',
    id: 'app-1',
    attributes: {
      name: 'Продажи',
      fileSize: 1024,
      lastReloadTime: '2026-01-01',
      published: true,
      customProperties: [
        { value: 'qs-cm-06', definition: { name: 'ReportAccess' } },
        { value: 'ETL', definition: { name: 'Consumer' } },
      ],
    },
    relationships: {
      owner: { data: { type: 'User', id: 'u1' } },
      stream: { data: { type: 'Stream', id: 's1' } },
    },
  }],
  included: [
    { type: 'User', id: 'u1', attributes: { name: 'Иванова Мария' } },
    { type: 'Stream', id: 's1', attributes: { name: 'Розница' } },
  ],
};

test('hubApiBase: адрес REST API хаба', () => {
  assert.equal(hubApiBase('wss://host/app/abc'), 'https://host/api/hub/v1');
  assert.equal(hubApiBase('wss://host/app/engineData'), 'https://host/api/hub/v1');
  assert.equal(hubApiBase('https://host/'), 'https://host/api/hub/v1');
  // Хаб под виртуальным каталогом — база сохраняется.
  assert.equal(hubApiBase('wss://host/hub/app/abc'), 'https://host/hub/api/hub/v1');
  // Порт 4747 — движок по http.
  assert.equal(hubApiBase('ws://host:4747/app/abc'), 'http://host:4747/api/hub/v1');
  assert.equal(hubApiBase('мусор'), null);
});

test('parseHubApps: владелец, поток и тэги из JSON:API', () => {
  const { byId } = parseHubApps(HUB_PAYLOAD);
  const app = byId.get('app-1');
  assert.ok(app);
  assert.equal(app.title, 'Продажи');
  assert.equal(app.size, 1024);
  assert.equal(app.lastReload, '2026-01-01');
  assert.equal(app.published, true);
  // Имена приходят из included, а не из relationships.
  assert.equal(app.owner, 'Иванова Мария');
  assert.equal(app.stream, 'Розница');
  assert.deepEqual(app.tags, ['ReportAccess:qs-cm-06', 'Consumer:ETL']);
});

test('parseHubApps: без included остаются только идентификаторы', () => {
  const { byId } = parseHubApps({
    data: [{ id: 'app-2', attributes: { name: 'X' }, relationships: { owner: { data: { id: 'u9' } } } }],
  });
  assert.equal(byId.get('app-2').owner, null);
  assert.equal(byId.get('app-2').stream, null);
  assert.deepEqual(byId.get('app-2').tags, []);
});

test('appMeta: поток берётся из qMeta', () => {
  const meta = appMeta({
    qDocId: 'app-1',
    qMeta: { stream: { id: 's1', name: 'Розница' }, published: true },
  });
  assert.equal(meta.stream, 'Розница');
  assert.equal(meta.published, true);
  // Верхний уровень по-прежнему читается (QlikView, старые развёртывания).
  const legacy = appMeta({ qStream: 'Retail', qOwner: 'Иванова' });
  assert.equal(legacy.stream, 'Retail');
  assert.equal(legacy.owner, 'Иванова');
});

test('metaCoverage: сколько приложений получили метаданные', () => {
  const text = metaCoverage([
    { stream: 'Розница', owner: 'Иванова', tags: ['a'] },
    { stream: null, owner: null, tags: [] },
  ]);
  assert.match(text, /поток 1\/2/);
  assert.match(text, /владелец 1\/2/);
  assert.match(text, /тэги 1\/2/);
});

/** Мок хаба: отдаёт JSON:API по адресу /api/hub/v1/apps. */
function hubServer(payload = HUB_PAYLOAD, onRequest = null) {
  return createServer((req, res) => {
    onRequest?.(req);
    if (req.url.startsWith('/api/hub/v1/apps')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}

test('listApps: метаданные из REST API хаба (JSON:API)', async () => {
  const server = hubServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const notes = [];
    const apps = await listApps({
      url: `http://127.0.0.1:${port}/app/app-1`,
      cookie: 'X-Qlik-Session=abc',
      notes,
    });
    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, 'app-1');
    assert.equal(apps[0].title, 'Продажи');
    assert.equal(apps[0].owner, 'Иванова Мария');
    assert.equal(apps[0].stream, 'Розница');
    assert.deepEqual(apps[0].tags, ['ReportAccess:qs-cm-06', 'Consumer:ETL']);
    assert.equal(apps[0].published, true);
    // Причина и покрытие видны в диагностике — иначе пустой фильтр непонятен.
    assert.ok(notes.some((n) => /метаданные: поток 1\/1/.test(n)), notes.join(' | '));
  } finally {
    server.close();
  }
});

test('fetchHubApps: запрос к /api/hub/v1/apps', async () => {
  let seen = null;
  const server = hubServer(HUB_PAYLOAD, (req) => { seen = req.url; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetchHubApps({
      url: `http://127.0.0.1:${port}/app/app-1`,
      cookie: 'X-Qlik-Session=abc',
    });
    assert.equal(res.ok, true);
    assert.equal(res.byId.get('app-1').owner, 'Иванова Мария');
    // Владелец и поток запрашиваются включиком.
    assert.match(seen, /include=owner%2Cstream|include=owner,stream/);
  } finally {
    server.close();
  }
});

test('listApps: старый путь REST остаётся запасным', async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/hub/v1/apps')) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/api/v1/apps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: 'app-9', title: 'Старый путь' }] }));
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
    assert.equal(apps[0].id, 'app-9');
  } finally {
    server.close();
  }
});

test('listApps: поток из qMeta движка', async () => {
  const apps = await listApps({
    getDocList: async () => ([{
      qDocId: 'app-1',
      qTitle: 'Продажи',
      qMeta: { stream: { id: 's1', name: 'Розница' }, published: true },
    }]),
  });
  assert.equal(apps[0].stream, 'Розница');
  assert.equal(apps[0].published, true);
});
