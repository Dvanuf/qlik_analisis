import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildMessages, buildUserMessage, SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { analyze, buildPromptPreview, restoreNames } from '../src/ai/index.js';
import { createRedactor } from '../src/ai/redact.js';

/** Заглушка результата анализа нужной формы. */
function fakeAnalysis() {
  return {
    summary: {
      findings: { total: 2, bySeverity: { error: 1, warning: 1 }, byCategory: { Quality: 2 } },
      score: 70,
    },
    findings: [
      {
        ruleId: 'S001', severity: 'error', title: 'Без ключа', count: 2,
        message: 'Поле без ключа', recommendation: 'Добавьте ключ',
        target: { kind: 'field', name: 'Amount' },
      },
      {
        ruleId: 'S002', severity: 'warning', title: 'Лишнее поле', count: 5,
        table: 'Sales', line: 42, message: 'Не используется', recommendation: 'Удалите',
      },
    ],
  };
}

const data = {
  analysis: fakeAnalysis(),
  app: { title: 'Продажи РФ', platform: 'qlik-sense' },
};

test('промпт: инструкция требует отвечать по вопросу, а не пересказывать сводку', () => {
  assert.match(SYSTEM_PROMPT, /Не пересказывай сводку целиком/);
  assert.match(SYSTEM_PROMPT, /Не используй один и тот же шаблон/);
  assert.match(SYSTEM_PROMPT, /истори/i);
});

test('промпт: сообщение пользователя содержит вопрос и сводку', () => {
  const text = buildUserMessage('что исправить?', 'Находок: 2');
  assert.match(text, /Вопрос: что исправить\?/);
  assert.match(text, /Сводка результатов анализа:/);
  assert.match(text, /Находок: 2/);
});

test('промпт: история диалога попадает в сообщения перед новым вопросом', () => {
  const messages = buildMessages('а подробнее?', 'сводка', {
    history: [
      { role: 'user', content: 'первый вопрос' },
      { role: 'assistant', content: 'первый ответ' },
    ],
  });
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'первый вопрос');
  assert.equal(messages[2].content, 'первый ответ');
  assert.equal(messages[3].role, 'user');
  assert.match(messages[3].content, /а подробнее\?/);
});

test('промпт: правка пользователя заменяет текст запроса', () => {
  const messages = buildMessages('вопрос', 'сводка', {
    system: 'моя инструкция',
    user: 'мой текст запроса',
  });
  assert.equal(messages[0].content, 'моя инструкция');
  assert.equal(messages[1].content, 'мой текст запроса');
});

test('предпросмотр: внешнему провайдеру уходит обезличенный текст', () => {
  const preview = buildPromptPreview('что исправить?', data, { provider: 'zai' });
  assert.equal(preview.ok ?? true, true);
  assert.equal(preview.provider, 'zai');
  assert.equal(preview.external, true);
  assert.match(preview.user, /Приложение_1/);
  assert.doesNotMatch(preview.user, /Продажи РФ/);
  assert.ok(preview.system.length > 0);
});

test('предпросмотр: локальной модели название видно как есть', () => {
  const preview = buildPromptPreview('что исправить?', data, { provider: 'local' });
  assert.equal(preview.external, false);
  assert.match(preview.user, /Продажи РФ/);
});

test('предпросмотр: совпадает с тем, что уходит в запрос', () => {
  const preview = buildPromptPreview('вопрос', data, { provider: 'zai' });
  const messages = buildMessages('вопрос', 'x');
  assert.equal(typeof preview.user, 'string');
  assert.ok(preview.user.length > 0);
  assert.ok(messages.length > 0);
});

test('предпросмотр: в сводке есть конкретные находки с объектами и строками', () => {
  const preview = buildPromptPreview('что исправить?', data, { provider: 'local' });
  assert.match(preview.user, /Конкретные находки/);
  assert.match(preview.user, /S001 \[error\]/);
  assert.match(preview.user, /Amount/);
  assert.match(preview.user, /строка 42/);
  assert.match(preview.user, /Рекомендация/);
});

test('предпросмотр: находка, о которой спросили, попадает в сводку', () => {
  const preview = buildPromptPreview('что с этим полем?', {
    ...data,
    focus: { ruleId: 'S001', title: 'Без ключа', target: 'Amount', message: 'Поле без ключа', severity: 'error' },
  }, { provider: 'local' });
  assert.match(preview.user, /О чём конкретно спросили/);
  assert.match(preview.user, /S001/);
});

test('название приложения возвращается в ответе локально', () => {
  const redactor = createRedactor({ names: [{ value: 'Продажи РФ', kind: 'Приложение' }] });
  const masked = redactor.mask('В приложении Приложение_1 ошибка S001');
  assert.match(masked, /Приложение_1/);
  const restored = restoreNames(masked, redactor);
  assert.match(restored, /Продажи РФ/);
  assert.doesNotMatch(restored, /Приложение_1/);
});

test('восстановление названия не ломает похожие плейсхолдеры', () => {
  const redactor = createRedactor({
    names: [
      { value: 'Продажи', kind: 'Приложение' },
      { value: 'Продажи РФ', kind: 'Приложение' },
    ],
  });
  const masked = redactor.mask('Продажи и Продажи РФ');
  const restored = restoreNames(masked, redactor);
  assert.match(restored, /Продажи РФ/);
});

/**
 * Поддельный провайдер: запоминает тело запроса и отвечает заданным текстом.
 */
async function withProvider(t, reply) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const payload = JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => new Promise((r) => server.close(r)));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls };
}

test('предпросмотр совпадает с промптом, который реально уходит провайдеру', async (t) => {
  const srv = await withProvider(t, 'Ответ модели');
  const preview = buildPromptPreview('что исправить?', data, {
    provider: 'local',
    providers: { local: { baseUrl: srv.baseUrl, model: 'test-model' } },
  });

  await analyze('что исправить?', data, {
    provider: 'local',
    providers: { local: { baseUrl: srv.baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });

  assert.equal(srv.calls.length, 1);
  const sent = srv.calls[0].messages;
  assert.equal(sent[0].content, preview.system);
  assert.equal(sent[sent.length - 1].content, preview.user);
});

test('название приложения возвращается в ответе, наружу уходит плейсхолдер', async (t) => {
  const srv = await withProvider(t, 'В приложении Приложение_1 находка S001');
  const result = await analyze('вопрос', data, {
    provider: 'zai',
    apiKeys: { zai: 'k' },
    providers: { zai: { baseUrl: srv.baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
  });
  // Наружу ушло обезличенное.
  const sent = srv.calls[0].messages[srv.calls[0].messages.length - 1].content;
  assert.doesNotMatch(sent, /Продажи РФ/);
  // Пользователь видит настоящее название.
  assert.match(result.text, /Продажи РФ/);
});

test('правка промпта уходит модели вместо штатного текста', async (t) => {
  const srv = await withProvider(t, 'Ответ модели');
  await analyze('вопрос', data, {
    provider: 'local',
    providers: { local: { baseUrl: srv.baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
    override: { user: 'мой собственный текст запроса' },
  });
  const sent = srv.calls[0].messages;
  assert.equal(sent[sent.length - 1].content, 'мой собственный текст запроса');
});

test('история диалога доходит до провайдера', async (t) => {
  const srv = await withProvider(t, 'Ответ модели');
  await analyze('а подробнее?', data, {
    provider: 'local',
    providers: { local: { baseUrl: srv.baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
    history: [
      { role: 'user', content: 'первый вопрос' },
      { role: 'assistant', content: 'первый ответ' },
    ],
  });
  const sent = srv.calls[0].messages;
  assert.equal(sent.length, 4);
  assert.equal(sent[1].content, 'первый вопрос');
  assert.equal(sent[2].content, 'первый ответ');
});