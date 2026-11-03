import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAi, aiKeyEnvNames } from '../src/config.js';
import { providerChain } from '../src/ai/providers.js';

test('конфигурация ИИ: значения по умолчанию', () => {
  const cfg = resolveAi({}, {});
  assert.equal(cfg.provider, 'zai');
  assert.deepEqual(cfg.fallback, ['gemini', 'local']);
  assert.equal(cfg.sensitive, false);
  assert.equal(cfg.limits.requestsPerMinute, 10);
  assert.equal(cfg.limits.dailyCap, 200);
  assert.equal(cfg.limits.cacheTtlMs, 60000);
  assert.equal(cfg.maxSummaryChars, 12000);
});

test('конфигурация ИИ: файл конфигурации важнее умолчаний', () => {
  const cfg = resolveAi({}, {
    ai: {
      provider: 'gemini',
      fallback: ['local'],
      sensitive: true,
      limits: { requestsPerMinute: 5, dailyCap: 50, cacheTtlMs: 1000 },
      maxSummaryChars: 4000,
      providers: { local: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen3:14b' } },
    },
  });
  assert.equal(cfg.provider, 'gemini');
  assert.deepEqual(cfg.fallback, ['local']);
  assert.equal(cfg.sensitive, true);
  assert.equal(cfg.limits.requestsPerMinute, 5);
  assert.equal(cfg.maxSummaryChars, 4000);
  assert.equal(cfg.providers.local.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(cfg.providers.local.model, 'qwen3:14b');
});

test('конфигурация ИИ: CLI-флаг важнее файла', () => {
  const cfg = resolveAi(
    { aiProvider: 'local', aiFallback: [], aiRequestsPerMinute: 2, aiSensitive: true },
    { ai: { provider: 'gemini', fallback: ['local'], limits: { requestsPerMinute: 9 } } },
  );
  assert.equal(cfg.provider, 'local');
  assert.deepEqual(cfg.fallback, []);
  assert.equal(cfg.limits.requestsPerMinute, 2);
  assert.equal(cfg.sensitive, true);
});

test('конфигурация ИИ: переменная окружения важнее файла', () => {
  process.env.QLIK_AI_PROVIDER = 'local';
  try {
    const cfg = resolveAi({}, { ai: { provider: 'gemini' } });
    assert.equal(cfg.provider, 'local');
  } finally {
    delete process.env.QLIK_AI_PROVIDER;
  }
  const cfg = resolveAi({}, {
    ai: { provider: 'zai', fallback: ['zai', 'nope', 'gemini', 'gemini'] },
  });
  // Основной провайдер резервом быть не может, неизвестные отбрасываются.
  assert.deepEqual(cfg.fallback, ['gemini']);
});

test('конфигурация ИИ: цепочка провайдеров всегда непустая', () => {
  const cfg = resolveAi({}, { ai: { provider: 'zai', fallback: ['zai'] } });
  assert.equal(providerChain(cfg.provider, cfg.fallback)[0], 'zai');
  // Резерв, равный основному, не оставляет запрос без резерва.
  assert.equal(providerChain(cfg.provider, cfg.fallback).length, 1);
});


test('конфигурация ИИ: имена переменных с ключами', () => {
  const names = aiKeyEnvNames(resolveAi({}, {}));
  assert.equal(names.zai, 'QLIK_AI_ZAI_KEY');
  assert.equal(names.gemini, 'QLIK_AI_GEMINI_KEY');
  // Локальной модели ключ не нужен.
  assert.equal(names.local, null);
});

test('конфигурация ИИ: имя переменной с ключом можно переопределить', () => {
  const names = aiKeyEnvNames(resolveAi({}, { ai: { providers: { zai: { apiKeyEnv: 'MY_ZAI_KEY' } } } }));
  assert.equal(names.zai, 'MY_ZAI_KEY');
});
