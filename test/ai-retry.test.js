/**
 * Повтор при rate limit: Retry-After провайдера приоритетнее дефолта,
 * один повтор на провайдера, стрим не дублируется.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRetryDelayMs } from '../src/ai/index.js';
import { AiError, AI_ERROR } from '../src/ai/errors.js';

test('nextRetryDelayMs: Retry-After провайдера с потолком 30 с', () => {
  const long = new AiError(AI_ERROR.RATE_LIMITED, 'x', { retryAfterMs: 42000 });
  assert.equal(nextRetryDelayMs(long, 0), 30000, '42 с урезаны до 30');
  const short = new AiError(AI_ERROR.RATE_LIMITED, 'x', { retryAfterMs: 3000 });
  assert.equal(nextRetryDelayMs(short, 0), 3000, '3 с — как попросил провайдер');
});

test('nextRetryDelayMs: дефолт 15 с, один повтор, стрим и другие коды — нет', () => {
  assert.equal(nextRetryDelayMs(new AiError(AI_ERROR.RATE_LIMITED, 'x'), 0), 15000);
  const rl = new AiError(AI_ERROR.RATE_LIMITED, 'x', { retryAfterMs: 5000 });
  assert.equal(nextRetryDelayMs(rl, 1), 0, 'второй повтор не нужен');
  assert.equal(nextRetryDelayMs(rl, 0, true), 0, 'стрим не дублируется');
  assert.equal(nextRetryDelayMs(new AiError(AI_ERROR.TIMEOUT, 'x'), 0), 0, 'таймаут не ретраится здесь');
  assert.equal(nextRetryDelayMs(null, 0), 0, 'null — безопасно');
});
