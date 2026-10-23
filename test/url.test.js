import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEngineUrl, cleanEngineUrl } from '../src/extract/url.js';

test('normalizeEngineUrl: приводит адрес к формату движка', () => {
  assert.equal(
    normalizeEngineUrl('wss://qlik.corp.local/app/abc-123'),
    'wss://qlik.corp.local/app/abc-123',
  );
  // Без схемы — хаб через 443.
  assert.equal(
    normalizeEngineUrl('qlik.corp.local/app/abc-123'),
    'wss://qlik.corp.local/app/abc-123',
  );
  // Порт 4747 — http со стороны движка, значит ws.
  assert.equal(
    normalizeEngineUrl('http://qlik.corp.local:4747/app/abc-123'),
    'ws://qlik.corp.local:4747/app/abc-123',
  );
  assert.equal(
    normalizeEngineUrl('https://qlik.corp.local:4746/app/abc-123'),
    'wss://qlik.corp.local:4746/app/abc-123',
  );
  // Путь /sense/app/<id> тоже распознаётся.
  assert.equal(
    normalizeEngineUrl('https://qlik.corp.local/sense/app/abc-123'),
    'wss://qlik.corp.local/app/abc-123',
  );
});

test('normalizeEngineUrl: подставляет appId, если он известен', () => {
  assert.equal(
    normalizeEngineUrl('qlik.corp.local', { appId: 'abc-123' }),
    'wss://qlik.corp.local/app/abc-123',
  );
  // appId из URL важнее переданного — он ближе к тому, что ввёл пользователь.
  assert.equal(
    normalizeEngineUrl('wss://qlik.corp.local/app/from-url', { appId: 'other' }),
    'wss://qlik.corp.local/app/from-url',
  );
});

test('normalizeEngineUrl: без appId оставляет адрес корня', () => {
  assert.equal(normalizeEngineUrl('qlik.corp.local'), 'wss://qlik.corp.local/app');
  assert.equal(normalizeEngineUrl(''), '');
});

test('cleanEngineUrl: убирает query-параметры рукопожатия', () => {
  assert.equal(
    cleanEngineUrl('wss://host/app/abc-123?reloadUri=https%3A%2F%2Fhost%2Fsense&qlik-csrf-token=xyz'),
    'wss://host/app/abc-123',
  );
  assert.equal(cleanEngineUrl('wss://host/app/abc-123'), 'wss://host/app/abc-123');
  assert.equal(cleanEngineUrl(''), '');
});
