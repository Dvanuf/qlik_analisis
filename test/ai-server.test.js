import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server/src/http.js';
import { ReportStore } from '../server/src/store.js';
import { resolveServerConfig } from '../server/src/config.js';

/**
 * Интеграционный тест серверного ИИ-слоя: поднимаем сервер на случайном
 * порту и подменяем провайдера локальным OpenAI-совместимым сервером.
 */
async function withServer(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ai-http-'));
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

/** Поддельный OpenAI-совместимый провайдер. */
async function withProvider(t, text = 'Ответ модели') {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: text }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls };
}

test('сервер ИИ: статус отдаёт провайдеров без ключей', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/ai/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'zai');
  assert.equal(body.providers.length, 3);
  // Значения ключей в ответ не попадают — только факт «ключ задан».
  assert.ok(body.providers.every((p) => typeof p.hasKey === 'boolean'));
  assert.equal(JSON.stringify(body).includes('QLIK_AI_ZAI_KEY'), false);
});

test('сервер ИИ: вопрос обрабатывается и возвращает ответ', async (t) => {
  const provider = await withProvider(t, 'Краткий вывод модели');
  const { base } = await withServer(t, {
    ai: {
      provider: 'local',
      fallback: [],
      providers: { local: { baseUrl: provider.baseUrl, model: 'test-model' } },
    },
  });
  const res = await fetch(`${base}/api/ai/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'Что исправлять?',
      app: { title: 'Продажи РФ' },
      summary: { findings: { total: 3, bySeverity: { error: 3 } }, score: 40 },
      findings: [{ ruleId: 'S001', severity: 'error', title: 'Без ключа', count: 3 }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, 'Краткий вывод модели');
  assert.equal(body.provider, 'local');
  // К провайдеру ушла сводка, а не исходные данные.
  const sent = provider.calls[0].messages[1].content;
  assert.match(sent, /всего: 3/);
  assert.equal(provider.calls.length, 1);
});

test('сервер ИИ: без вопроса — 400', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/ai/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('сервер ИИ: роль viewer не может задавать вопросы', async (t) => {
  const { base } = await withServer(t, {
    auth: {
      mode: 'proxy',
      userHeader: 'X-Forwarded-User',
      users: [{ login: 'viewer', role: 'viewer' }],
    },
  });
  const res = await fetch(`${base}/api/ai/analyze`, {
    method: 'POST',
    headers: { 'X-Forwarded-User': 'viewer', 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'привет' }),
  });
  assert.equal(res.status, 403);
});

test('сервер ИИ: контекст берётся из сохранённого отчёта', async (t) => {
  const provider = await withProvider(t, 'Ответ по отчёту');
  const { base, store } = await withServer(t, {
    ai: {
      provider: 'local',
      fallback: [],
      providers: { local: { baseUrl: provider.baseUrl, model: 'test-model' } },
    },
  });
  store.save('job-1', {
    type: 'analyze',
    title: 'Тест',
    html: '<html></html>',
    json: {
      summary: { findings: { total: 7, bySeverity: { error: 2, warning: 5 } }, score: 55 },
      findings: [{ ruleId: 'R001', severity: 'warning', title: 'Лишнее поле', count: 5 }],
    },
    requestedBy: 'ivan',
  });
  const res = await fetch(`${base}/api/ai/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Что там?', reportId: 'job-1' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, 'Ответ по отчёту');
  const sent = provider.calls[0].messages[1].content;
  assert.match(sent, /всего: 7/);
  assert.match(sent, /R001/);
});

test('сервер ИИ: неизвестный отчёт — 404', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/ai/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'привет', reportId: 'нет-такого' }),
  });
  assert.equal(res.status, 404);
});

test('сервер ИИ: сбой провайдера не выдаёт ключи в тексте ошибки', async (t) => {
  const { base } = await withServer(t, {
    ai: { provider: 'zai', fallback: [] },
  });
  process.env.QLIK_AI_ZAI_KEY = 'super-secret-key';
  try {
    const res = await fetch(`${base}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'привет' }),
    });
    // Ключ задан, но провайдер недоступен — ошибка без секрета.
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(JSON.stringify(body).includes('super-secret-key'), false);
  } finally {
    delete process.env.QLIK_AI_ZAI_KEY;
  }
});
