import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, redact } from '../src/ai/redact.js';

test('маскирование: почта и телефон не уходят наружу', () => {
  const out = redact('Пишите на ivan.petrov@example.com или +7 916 123-45-67');
  assert.doesNotMatch(out, /ivan\.petrov@example\.com/);
  assert.doesNotMatch(out, /916 123-45-67/);
  assert.match(out, /email_1/);
  assert.match(out, /телефон_1/);
});

test('маскирование: ФИО заменяется плейсхолдером', () => {
  const out = redact('Владелец приложения — Иванов Иван Иванович.');
  assert.doesNotMatch(out, /Иванов/);
  assert.match(out, /ФИО_1/);
});

test('маскирование: ФИО с инициалами тоже скрывается', () => {
  const out = redact('Ответственный: Петров П.П.');
  assert.doesNotMatch(out, /Петров/);
});

test('маскирование: названия объектов не считаются ФИО', () => {
  // Три заглавных слова подряд — ещё не человек.
  const out = redact('Таблица Список Продажи Клиентов содержит поле Сумма');
  assert.match(out, /Список Продажи Клиентов/);
  assert.doesNotMatch(out, /ФИО_/);
});

test('маскирование: одно и то же значение даёт один плейсхолдер', () => {
  const redactor = createRedactor({
    names: [{ value: 'Продажи РФ', kind: 'Приложение' }],
  });
  const out = redactor.mask('Приложение Продажи РФ и ещё раз Продажи РФ');
  // Связь между вхождениями сохраняется: модель видит, что это одно и то же.
  assert.match(out, /Приложение_1/);
  assert.doesNotMatch(out, /Приложение_2/);
  assert.equal((out.match(/Приложение_1/g) ?? []).length, 2);
  assert.equal(redactor.count(), 1);
});

test('маскирование: владелец и приложение различаются плейсхолдерами', () => {
  const redactor = createRedactor({
    names: [
      { value: 'Продажи РФ', kind: 'Приложение' },
      { value: 'Иванов Иван', kind: 'Владелец' },
    ],
  });
  const out = redactor.mask('Приложение Продажи РФ, владелец Иванов Иван');
  assert.match(out, /Приложение_1/);
  assert.match(out, /Владелец_1/);
});

test('маскирование: значения по умолчанию не меняются', () => {
  const out = redact('Находок: 12, скор: 87');
  assert.equal(out, 'Находок: 12, скор: 87');
});

test('маскирование: структуры обрабатываются целиком', () => {
  const redactor = createRedactor();
  const masked = redactor.maskValue({
    title: 'Пишите на test@example.com',
    items: ['+7 916 000-00-00', 'обычный текст'],
  });
  assert.doesNotMatch(masked.title, /test@example\.com/);
  assert.doesNotMatch(masked.items[0], /916 000-00-00/);
  assert.equal(masked.items[1], 'обычный текст');
});
