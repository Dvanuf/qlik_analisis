import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerChain, resolveProvider, externalOnly } from '../src/ai/providers.js';
import { AiError, AI_ERROR, toAiError } from '../src/ai/errors.js';
import { statusToError, joinUrl } from '../src/ai/openai.js';

test('провайдеры: описаны с адресами, моделями и признаком внешнего', () => {
  assert.equal(PROVIDERS.zai.baseUrl, 'https://api.z.ai/api/paas/v4');
  assert.equal(PROVIDERS.zai.model, 'glm-4.7-flash');
  assert.equal(PROVIDERS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(PROVIDERS.local.baseUrl, 'http://localhost:11434/v1');
  // Локальная модель — единственная, чьи данные не покидают машину.
  assert.equal(PROVIDERS.local.external, false);
  assert.equal(PROVIDERS.zai.external, true);
  assert.equal(PROVIDERS.gemini.external, true);
});

test('провайдеры: цепочка без повторов и без неизвестных', () => {
  assert.deepEqual(providerChain('zai', ['gemini', 'local']), ['zai', 'gemini', 'local']);
  assert.deepEqual(providerChain('zai', ['zai', 'gemini']), ['zai', 'gemini']);
  assert.deepEqual(providerChain('nope', ['gemini']), ['gemini']);
  assert.deepEqual(providerChain('zai'), ['zai']);
});

test('провайдеры: конфиденциальный режим оставляет только локального', () => {
  const chain = ['zai', 'gemini', 'local'];
  assert.deepEqual(externalOnly(chain, false), chain);
  assert.deepEqual(externalOnly(chain, true), ['local']);
});

test('провайдеры: переопределение адреса и модели из конфигурации', () => {
  const p = resolveProvider('local', { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen3:14b' });
  assert.equal(p.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(p.model, 'qwen3:14b');
  // Остальные поля дескриптора сохраняются.
  assert.equal(p.timeoutMs, PROVIDERS.local.timeoutMs);
  assert.equal(resolveProvider('нет-такого'), null);
});

test('адрес собирается без дублей слэш', () => {
  assert.equal(joinUrl('https://api.z.ai/api/paas/v4', 'chat/completions'), 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(joinUrl('https://api.z.ai/api/paas/v4/', '/chat/completions'), 'https://api.z.ai/api/paas/v4/chat/completions');
});

test('статусы провайдера превращаются в понятные ошибки', () => {
  const badKey = statusToError(401, '{"error":{"message":"invalid api key"}}', 'zai');
  assert.equal(badKey.code, AI_ERROR.NO_KEY);
  assert.match(badKey.message, /ключ/i);

  const limit = statusToError(429, '{}', 'zai');
  assert.equal(limit.code, AI_ERROR.QUOTA_EXHAUSTED);

  const down = statusToError(503, '{}', 'zai');
  assert.equal(down.code, AI_ERROR.PROVIDER_UNAVAILABLE);

  const wrongModel = statusToError(404, '{}', 'zai');
  assert.equal(wrongModel.code, AI_ERROR.BAD_RESPONSE);
});

test('неизвестная ошибка становится ошибкой провайдера, а не теряется', () => {
  const err = toAiError(new Error('ECONNRESET'), 'gemini');
  assert.ok(err instanceof AiError);
  assert.equal(err.code, AI_ERROR.PROVIDER_UNAVAILABLE);
  assert.equal(err.provider, 'gemini');
});
