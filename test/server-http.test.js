import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/src/http.js';
import { ReportStore } from '../server/src/store.js';
import { resolveServerConfig } from '../server/src/config.js';

/**
 * Интеграционный тест HTTP-слоя: поднимаем сервер на случайном порту
 * и проверяем REST-маршруты, разграничение прав и раздачу отчётов.
 */
async function withServer(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-http-'));
  const store = new ReportStore(dir);
  const config = resolveServerConfig({
    server: { host: '127.0.0.1', port: 0, dataDir: dir },
    auth: { mode: 'none' },
    qlik: { url: '' },
    ...overrides,
  });
  const { server } = createApp({ config, store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base, store, config };
}

test('HTTP: служебные маршруты и каталог правил', async (t) => {
  const { base } = await withServer(t);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');

  const rules = await fetch(`${base}/api/rules`);
  assert.equal(rules.status, 200);
  const rulesBody = await rules.json();
  assert.equal(rulesBody.total, 54);
  assert.equal(rulesBody.rules.length, 54);

  const me = await fetch(`${base}/api/me`);
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.canAnalyze, true);
});

test('HTTP: веб-интерфейс отдаётся и защита от обхода пути работает', async (t) => {
  const { base } = await withServer(t);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /Qlik Quality/);

  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);

  // Обход каталога не должен выдать содержимое файлов вне public/
  const escape = await fetch(`${base}/../../etc/passwd`);
  assert.equal(escape.status, 404);
});

test('HTTP: без авторизации — 401 с WWW-Authenticate', async (t) => {
  const { base } = await withServer(t, {
    auth: { mode: 'basic', users: [{ login: 'ivan', passwordEnv: 'NOPE', role: 'analyst' }] },
  });

  const res = await fetch(`${base}/api/me`);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Basic/);
});

test('HTTP: роль viewer не может запускать анализ', async (t) => {
  const { base } = await withServer(t, {
    auth: {
      mode: 'proxy',
      userHeader: 'X-Forwarded-User',
      users: [{ login: 'viewer', role: 'viewer' }],
    },
  });

  const me = await fetch(`${base}/api/me`, { headers: { 'X-Forwarded-User': 'viewer' } });
  const meBody = await me.json();
  assert.equal(meBody.role, 'viewer');
  assert.equal(meBody.canAnalyze, false);

  // Просмотр правил разрешён
  const rules = await fetch(`${base}/api/rules`, { headers: { 'X-Forwarded-User': 'viewer' } });
  assert.equal(rules.status, 200);

  // Запуск анализа — нет
  const start = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'X-Forwarded-User': 'viewer', 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: 'x' }),
  });
  assert.equal(start.status, 403);
});

test('HTTP: отчёты сохраняются и отдаются по ссылке', async (t) => {
  const { base, store } = await withServer(t);

  store.save('job-html', {
    type: 'analyze',
    title: 'Тест',
    html: '<html><body>отчёт</body></html>',
    json: { summary: { findings: { total: 7 } } },
    requestedBy: 'ivan',
  });

  const list = await fetch(`${base}/api/reports`);
  const listBody = await list.json();
  assert.equal(listBody.reports.length, 1);
  assert.equal(listBody.reports[0].title, 'Тест');

  const html = await fetch(`${base}/reports/job-html.html`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /отчёт/);

  const json = await fetch(`${base}/reports/job-html.json`);
  assert.equal(json.status, 200);
  const jsonBody = await json.json();
  assert.equal(jsonBody.summary.findings.total, 7);

  // Удаление
  const del = await fetch(`${base}/api/reports/job-html`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await fetch(`${base}/api/reports`);
  assert.equal((await after.json()).reports.length, 0);
});

test('HTTP: несуществующий отчёт — 404', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/reports/nope.html`);
  assert.equal(res.status, 404);
});
