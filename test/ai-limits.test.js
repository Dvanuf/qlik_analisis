import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Limits, DEFAULT_LIMITS } from '../src/ai/limits.js';
import { AiError, AI_ERROR } from '../src/ai/errors.js';

test('лимиты: не больше N запросов в минуту', () => {
  const limits = new Limits({ requestsPerMinute: 2, dailyCap: 0, cacheTtlMs: 0 });
  limits.record();
  limits.record();
  assert.throws(
    () => limits.check(),
    (err) => err instanceof AiError && err.code === AI_ERROR.RATE_LIMITED,
  );
});

test('лимиты: счётчик окна очищается по прошествии минуты', () => {
  let now = 1000000;
  const limits = new Limits({ requestsPerMinute: 1, dailyCap: 0, cacheTtlMs: 0, now: () => now });
  limits.record();
  assert.throws(() => limits.check());
  now += 61000;
  assert.doesNotThrow(() => limits.check());
});

test('лимиты: дневной потолок даёт понятную ошибку', () => {
  const limits = new Limits({ requestsPerMinute: 100, dailyCap: 1, cacheTtlMs: 0 });
  limits.record();
  assert.throws(
    () => limits.check(),
    (err) => err.code === AI_ERROR.QUOTA_EXHAUSTED && /Дневной лимит/.test(err.message),
  );
});

test('лимиты: счётчик дня обнуляется на следующий день', () => {
  let now = new Date('2026-03-10T10:00:00Z').getTime();
  const limits = new Limits({ requestsPerMinute: 100, dailyCap: 1, cacheTtlMs: 0, now: () => now });
  limits.record();
  assert.throws(() => limits.check());
  now += 24 * 3600 * 1000;
  assert.doesNotThrow(() => limits.check());
});

test('лимиты: счётчик сохраняется между перезапусками', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ai-'));
  const statePath = join(dir, 'ai-state.json');
  const first = new Limits({ requestsPerMinute: 100, dailyCap: 1, cacheTtlMs: 0, statePath });
  first.record();
  // Новый экземпляр читает состояние из файла — лимит не сбрасывается.
  const second = new Limits({ requestsPerMinute: 100, dailyCap: 1, cacheTtlMs: 0, statePath });
  assert.equal(second.day.count, 1);
  assert.throws(() => second.check());
});

test('лимиты: одинаковый запрос попадает в кэш на заданное время', () => {
  let now = 1000000;
  const limits = new Limits({ requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 60000, now: () => now });
  const key = Limits.key('zai', 'glm-4.7-flash', 'вопрос', 'сводка');
  assert.equal(limits.getCached(key), undefined);
  limits.setCached(key, { text: 'ответ' });
  assert.deepEqual(limits.getCached(key), { text: 'ответ' });
  // После истечения TTL запись больше не выдаётся.
  now += 61000;
  assert.equal(limits.getCached(key), undefined);
});

test('лимиты: кэш выключается нулевым TTL', () => {
  const limits = new Limits({ requestsPerMinute: 10, dailyCap: 0, cacheTtlMs: 0 });
  const key = Limits.key('a');
  limits.setCached(key, { text: 'x' });
  assert.equal(limits.getCached(key), undefined);
});

test('лимиты: значения по умолчанию подходят для бесплатных тарифов', () => {
  assert.equal(DEFAULT_LIMITS.requestsPerMinute, 10);
  assert.equal(DEFAULT_LIMITS.dailyCap, 200);
  assert.equal(DEFAULT_LIMITS.cacheTtlMs, 60000);
});
