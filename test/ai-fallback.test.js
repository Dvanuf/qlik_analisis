import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { analyze, isRetryable, retryDelay } from '../src/ai/index.js';
import { AiError, AI_ERROR } from '../src/ai/errors.js';

/**
 * Поддельный OpenAI-совместимый сервер.
 *
 * Обработчик получает номер запроса и решает, что ответить: статус, тело или
 * поток. Сервер считает, сколько раз к нему обратились, — это и есть
 * проверка числа попыток.
 */
async function withServer(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      calls.push({ url: req.url, auth: req.headers.authorization ?? null, body });
      handler(res, calls.length, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls };
}

/** Ответ с текстом в формате OpenAI. */
function replyText(res, text) {
  const payload = JSON.stringify({
    model: 'test-model',
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { total_tokens: 42 },
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** Ответ с ошибкой. */
function replyError(res, status) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `ошибка ${status}` } }));
}

test('fallback: успешный ответ возвращается с именем провайдера', async (t) => {
  const { baseUrl, calls } = await withServer(t, (res) => replyText(res, 'Ответ модели'));
  const result = await analyze('Что важно?', {}, {
    provider: 'local',
    providers: { local: { baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  assert.equal(result.text, 'Ответ модели');
  assert.equal(result.provider, 'local');
  assert.equal(result.model, 'test-model');
  assert.equal(calls.length, 1);
});

test('fallback: ключ передаётся в заголовке Authorization', async (t) => {
  const { baseUrl, calls } = await withServer(t, (res) => replyText(res, 'ok'));
  await analyze('вопрос', {}, {
    provider: 'local',
    providers: { local: { baseUrl, model: 'test-model' } },
    apiKeys: { local: 'secret-key' },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  assert.equal(calls[0].auth, 'Bearer secret-key');
});

test('fallback: тело запроса содержит модель и сообщения', async (t) => {
  const { baseUrl, calls } = await withServer(t, (res) => replyText(res, 'ok'));
  await analyze('почему падает скор', {}, {
    provider: 'local',
    providers: { local: { baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  const body = calls[0].body;
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /Отвечай на русском/);
  assert.match(body.messages[1].content, /почему падает скор/);
});

test('fallback: 500 повторяется, затем работает резервный провайдер', async (t) => {
  const first = await withServer(t, (res) => replyError(res, 500));
  const second = await withServer(t, (res) => replyText(res, 'ответ резервного'));
  const result = await analyze('вопрос', {}, {
    provider: 'zai',
    fallback: ['local'],
    providers: {
      zai: { baseUrl: first.baseUrl, model: 'm' },
      local: { baseUrl: second.baseUrl, model: 'm' },
    },
    apiKeys: { zai: 'k' },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  assert.equal(result.provider, 'local');
  assert.equal(result.text, 'ответ резервного');
  // Основной провайдер успели попробовать дважды, резервный — один раз.
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 1);
});


test('fallback: 401 не повторяется — сразу переходим к резервному', async (t) => {
  const first = await withServer(t, (res) => replyError(res, 401));
  const second = await withServer(t, (res) => replyText(res, 'ответ резервного'));
  const result = await analyze('вопрос', {}, {
    provider: 'zai',
    fallback: ['local'],
    providers: {
      zai: { baseUrl: first.baseUrl, model: 'm' },
      local: { baseUrl: second.baseUrl, model: 'm' },
    },
    apiKeys: { zai: 'k' },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  assert.equal(result.provider, 'local');
  // Плохой ключ повтором не лечится — одна попытка.
  assert.equal(first.calls.length, 1);
});

test('fallback: без ключа провайдер пропускается без обращения к сети', async (t) => {
  const first = await withServer(t, (res) => replyText(res, 'не должно вызваться'));
  const second = await withServer(t, (res) => replyText(res, 'ответ резервного'));
  const result = await analyze('вопрос', {}, {
    provider: 'zai',
    fallback: ['local'],
    providers: {
      zai: { baseUrl: first.baseUrl, model: 'm' },
      local: { baseUrl: second.baseUrl, model: 'm' },
    },
    apiKeys: {},
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  assert.equal(result.provider, 'local');
  assert.equal(first.calls.length, 0);
});

test('fallback: все провайдеры исчерпаны — понятная ошибка', async (t) => {
  const only = await withServer(t, (res) => replyError(res, 500));
  await assert.rejects(
    () => analyze('вопрос', {}, {
      provider: 'local',
      providers: { local: { baseUrl: only.baseUrl, model: 'm' } },
      limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
    }),
    (err) => err instanceof AiError && err.code === AI_ERROR.PROVIDER_UNAVAILABLE,
  );
  assert.equal(only.calls.length, 2);
});

test('fallback: пустой ответ считается сбоем и вызывает повтор', async (t) => {
  const srv = await withServer(t, (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }));
  });
  await assert.rejects(
    () => analyze('вопрос', {}, {
      provider: 'local',
      providers: { local: { baseUrl: srv.baseUrl, model: 'm' } },
      limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
    }),
    (err) => err.code === AI_ERROR.EMPTY_RESPONSE,
  );
  assert.equal(srv.calls.length, 2);
});

test('fallback: ключ не попадает в тело запроса', async (t) => {
  const { baseUrl, calls } = await withServer(t, (res) => replyText(res, 'ok'));
  await analyze('вопрос', {}, {
    provider: 'local',
    providers: { local: { baseUrl, model: 'test-model' } },
    apiKeys: { local: 'super-secret-key' },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  // Ключ живёт только в заголовке Authorization, в сообщениях его нет.
  assert.equal(JSON.stringify(calls[0].body).includes('super-secret-key'), false);
});

test('fallback: одинаковый вопрос второй раз отдаётся из кэша', async (t) => {
  const { baseUrl, calls } = await withServer(t, (res) => replyText(res, 'Ответ'));
  const options = {
    provider: 'local',
    providers: { local: { baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 60000 },
  };
  const first = await analyze('один и тот же вопрос', {}, options);
  const second = await analyze('один и тот же вопрос', {}, options);
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  // К провайдеру сходили только один раз.
  assert.equal(calls.length, 1);
});

test('fallback: конфиденциальный режим не обращается к внешним провайдерам', async (t) => {
  const external = await withServer(t, (res) => replyText(res, 'не должно вызваться'));
  const local = await withServer(t, (res) => replyText(res, 'ответ локальной модели'));
  const result = await analyze('вопрос', {}, {
    provider: 'zai',
    fallback: ['local'],
    sensitive: true,
    providers: {
      zai: { baseUrl: external.baseUrl, model: 'm' },
      local: { baseUrl: local.baseUrl, model: 'm' },
    },
    apiKeys: { zai: 'k' },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  assert.equal(result.provider, 'local');
  assert.equal(external.calls.length, 0);
});

test('fallback: конфиденциальный режим без локальной модели — понятная ошибка', async () => {
  await assert.rejects(
    () => analyze('вопрос', {}, {
      provider: 'zai',
      sensitive: true,
      apiKeys: { zai: 'k' },
      limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
    }),
    (err) => err.code === AI_ERROR.NO_LOCAL_PROVIDER,
  );
});

test('fallback: повторяемые и неповторяемые ошибки различаются', () => {
  assert.equal(isRetryable(new AiError(AI_ERROR.PROVIDER_UNAVAILABLE, 'x')), true);
  assert.equal(isRetryable(new AiError(AI_ERROR.TIMEOUT, 'x')), true);
  assert.equal(isRetryable(new AiError(AI_ERROR.QUOTA_EXHAUSTED, 'x')), true);
  assert.equal(isRetryable(new AiError(AI_ERROR.NO_KEY, 'x')), false);
  assert.equal(isRetryable(new AiError(AI_ERROR.BAD_RESPONSE, 'x')), false);
  assert.equal(isRetryable(new AiError(AI_ERROR.CANCELLED, 'x')), false);
});

test('fallback: пауза между повторами растёт и остаётся положительной', () => {
  const first = retryDelay(1, 100);
  const second = retryDelay(2, 100);
  assert.ok(first > 0);
  assert.ok(second >= first);
});

test('fallback: отмена запроса прерывает обращение к провайдеру', async (t) => {
  const srv = await withServer(t, (res) => {
    // Ответ задерживается — отмена должна сработать раньше.
    setTimeout(() => replyText(res, 'поздно'), 2000);
  });
  const controller = new AbortController();
  const promise = analyze('вопрос', {}, {
    provider: 'local',
    providers: { local: { baseUrl: srv.baseUrl, model: 'm' } },
    signal: controller.signal,
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    () => promise,
    (err) => err.code === AI_ERROR.CANCELLED,
  );
});
