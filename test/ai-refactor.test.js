/**
 * ИИ-рефакторинг скрипта: сборка запроса (скрипт + замечания), извлечение
 * скрипта из ответа и сквозной прогон через фейкового провайдера —
 * поверх той же цепочки, лимитов и кэша, что и чат.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { refactorScript, buildRefactorOverride, extractScriptFromAnswer, MAX_SCRIPT_CHARS } from '../src/ai/refactor.js';

/** Поддельный OpenAI-совместимый сервер (как в ai-fallback.test.js). */
async function withServer(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      calls.push({ url: req.url, body });
      handler(res, calls.length, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls };
}

function replyText(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    model: 'test-model',
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
  }));
}

test('сборка запроса: скрипт целиком, замечания списком, лимит длины', () => {
  const script = 'LOAD A FROM a.qvd;';
  const findings = [
    { ruleId: 'R001', title: 'Неиспользуемое поле', message: 'поле A не используется', fix: { kind: 'dropField', payload: 'A' } },
    { ruleId: 'R010', title: 'Без правки', message: 'просто замечание' },
  ];
  const o = buildRefactorOverride({ script, findings, appName: 'Продажи' });
  assert.match(o.system, /улучшенную версию скрипта/);
  assert.match(o.user, /Приложение: Продажи/);
  assert.match(o.user, /R001: Неиспользуемое поле — поле A не используется/);
  assert.match(o.user, /LOAD A FROM a\.qvd;/);
  assert.ok(!o.truncated);

  const long = 'x'.repeat(MAX_SCRIPT_CHARS + 500);
  const cut = buildRefactorOverride({ script: long });
  assert.ok(cut.truncated);
  assert.ok(cut.user.length < long.length);
});

test('извлечение скрипта: самый большой блок кода, остальное — пояснения', () => {
  const answer = [
    'Вот улучшенная версия:',
    '```',
    'LOAD A FROM a.qvd;',
    'DROP FIELD A;',
    '```',
    'Изменения: удалил поле A.',
    '```короткий````',
  ].join('\n');
  const { script, commentary } = extractScriptFromAnswer(answer);
  assert.equal(script, 'LOAD A FROM a.qvd;\nDROP FIELD A;');
  assert.match(commentary, /Изменения: удалил поле A\./);
  assert.ok(!commentary.includes('LOAD A'));

  // Без блоков — весь текст считается скриптом
  const plain = extractScriptFromAnswer('LOAD 1;');
  assert.equal(plain.script, 'LOAD 1;');
});

test('рефакторинг сквозной: запрос уходит с системным промптом, ответ разбирается', async (t) => {
  const { baseUrl, calls } = await withServer(t, (res) => replyText(
    res,
    '```qlik\nLOAD A FROM a.qvd;\nDROP FIELD A;\n```\n\nИзменения: убрал неиспользуемое поле.',
  ));
  const result = await refactorScript(
    { script: 'LOAD A FROM a.qvd;', appName: 'Тест' },
    {
      provider: 'local',
      providers: { local: { baseUrl, model: 'test-model' } },
      limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 },
    },
  );
  assert.ok(result.ok !== false);
  assert.equal(result.script, 'LOAD A FROM a.qvd;\nDROP FIELD A;');
  assert.match(result.commentary, /убрал неиспользуемое поле/);
  assert.equal(result.provider, 'local');

  // В запросе ушёл наш системный промпт и сам скрипт (в override.user)
  const messages = calls[0].body.messages;
  assert.match(messages[0].content, /разработчик скриптов Qlik/);
  const user = messages[messages.length - 1].content;
  assert.match(user, /LOAD A FROM a\.qvd;/);
  assert.match(user, /Приложение: Тест/);
});

test('рефакторинг: разные скрипты не смешиваются в кэше', async (t) => {
  const seen = [];
  const { baseUrl } = await withServer(t, (res, n, body) => {
    seen.push(body.messages[body.messages.length - 1].content);
    replyText(res, `\`\`\`\n-- ответ ${n}\n\`\`\``);
  });
  const opts = {
    provider: 'local',
    providers: { local: { baseUrl, model: 'test-model' } },
    limits: { requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 60000 },
  };
  await refactorScript({ script: 'LOAD 1;' }, opts);
  const second = await refactorScript({ script: 'LOAD 2;' }, opts);
  // Скрипт входит в override.user, а тот — в ключ кэша: второй запрос не взял
  // чужой ответ из кэша и реально ушёл к провайдеру.
  assert.match(second.script, /-- ответ 2/);
  assert.ok(!second.cached);
  assert.equal(seen.length, 2);
});
