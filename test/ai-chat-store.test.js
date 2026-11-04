/**
 * Хранение переписки ИИ-чата: ключ на каждое приложение, чтение и запись.
 *
 * Регрессия 0.8.5: переписка жила только в состоянии вкладки, поэтому
 * при переключении вкладки и при перезапуске приложения она терялась.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatKey, loadChat, saveChat, CHAT_PREFIX, MAX_MESSAGES, MAX_MESSAGE_LENGTH,
} from '../src/ai/chat-store.js';

/** Хранилище в памяти — те же методы, что у localStorage. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

test('ключ истории: отдельный для каждого приложения', () => {
  const a = chatKey({ appId: 'app-1', file: 'Продажи.qvw' });
  const b = chatKey({ appId: 'app-2', file: 'Отчёт.qvw' });
  assert.notEqual(a, b);
  assert.ok(a.startsWith(CHAT_PREFIX));
  assert.ok(a.includes('app-1'));
});

test('ключ истории: для файла без appId и для пустого анализа', () => {
  const file = chatKey({ file: 'Продажи.qvw' });
  assert.ok(file.includes('Продажи.qvw'));
  assert.equal(chatKey(null), `${CHAT_PREFIX}default`);
  assert.equal(chatKey({}), `${CHAT_PREFIX}default`);
});

test('переписка сохраняется и читается обратно', () => {
  const storage = fakeStorage();
  const key = chatKey({ appId: 'app-1' });
  const messages = [
    { role: 'user', text: 'Что исправить?' },
    { role: 'assistant', text: 'Сначала Q002.', provider: 'zai' },
  ];
  assert.equal(saveChat(storage, key, messages), true);
  const loaded = loadChat(storage, key);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].text, 'Что исправить?');
  assert.equal(loaded[1].provider, 'zai');
});

test('переписка разных приложений не смешивается', () => {
  const storage = fakeStorage();
  saveChat(storage, chatKey({ appId: 'app-1' }), [{ role: 'user', text: 'первый' }]);
  saveChat(storage, chatKey({ appId: 'app-2' }), [{ role: 'user', text: 'второй' }]);
  assert.equal(loadChat(storage, chatKey({ appId: 'app-1' }))[0].text, 'первый');
  assert.equal(loadChat(storage, chatKey({ appId: 'app-2' }))[0].text, 'второй');
});

test('битое значение в хранилище не ломает чат', () => {
  const storage = fakeStorage({ [chatKey({ appId: 'app-1' })]: '{не json' });
  assert.deepEqual(loadChat(storage, chatKey({ appId: 'app-1' })), []);
});

test('в хранилище попадают только корректные сообщения', () => {
  const storage = fakeStorage();
  const key = chatKey({ appId: 'app-1' });
  saveChat(storage, key, [
    { role: 'user', text: 'нормальное' },
    { role: 'system', text: 'лишняя роль' },
    { role: 'assistant', text: 42 },
    null,
  ]);
  const loaded = loadChat(storage, key);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].text, 'нормальное');
});

test('история ограничена по размеру', () => {
  const storage = fakeStorage();
  const key = chatKey({ appId: 'app-1' });
  const many = Array.from({ length: MAX_MESSAGES + 20 }, (_, i) => ({
    role: 'user', text: `вопрос ${i}`,
  }));
  saveChat(storage, key, many);
  const loaded = loadChat(storage, key);
  assert.equal(loaded.length, MAX_MESSAGES);
  // Остаются последние сообщения, а не первые.
  assert.equal(loaded[loaded.length - 1].text, `вопрос ${many.length - 1}`);
});

test('слишком длинный текст обрезается', () => {
  const storage = fakeStorage();
  const key = chatKey({ appId: 'app-1' });
  saveChat(storage, key, [{ role: 'user', text: 'x'.repeat(MAX_MESSAGE_LENGTH + 500) }]);
  const loaded = loadChat(storage, key);
  assert.equal(loaded[0].text.length, MAX_MESSAGE_LENGTH);
});

test('ошибка записи не пробрасывается', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceeded'); },
  };
  assert.equal(saveChat(storage, chatKey({ appId: 'app-1' }), [{ role: 'user', text: 'x' }]), false);
});

test('пустое хранилище даёт пустую историю', () => {
  assert.deepEqual(loadChat(null, 'key'), []);
  assert.deepEqual(loadChat(fakeStorage(), 'key'), []);
});
