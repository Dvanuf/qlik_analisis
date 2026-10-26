/**
 * Тесты сессии хаба, сбора объектов и диагностики.
 *
 * Проверяются: целостность файла сессии (не-строка не превращается в
 * «[object Object]»), обход типов объектов по одному при отказе сервера
 * на целом блоке, сохранение текста ошибки сервера для связей между
 * таблицами и понятная причина отсутствия объектов в диагностике.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCredentials, isSessionUsable, parseCredentials } from '../src/session/credentials.js';
import { fetchObjects, chunk } from '../src/extract/objects.js';
import { fetchAssociations } from '../src/extract/associations.js';
import { describeMissingObjects } from '../src/cli/doctor.js';

/**
 * Сессия хаба.
 *
 * Сессия хранится в зашифрованном файле. Если в него попадёт не-строка,
 * после сохранения там окажется «[object Object]» — такой файл больше не
 * читается, и пользователь входит заново без объяснения причины.
 */

test('normalizeCredentials: значения приводятся к строкам, объект не превращается в [object Object]', () => {
  const creds = normalizeCredentials({
    hubUrl: 'https://hub.local',
    cookie: 'X-Qlik-Session=abc',
    xrfKey: { value: 'xrf' },
    csrfToken: 12345,
  }, '2026-10-26T00:00:00.000Z');

  assert.equal(creds.hubUrl, 'https://hub.local');
  assert.equal(creds.cookie, 'X-Qlik-Session=abc');
  // Объект без строкового представления — пустая строка, а не «[object Object]».
  assert.equal(creds.xrfKey, '');
  assert.equal(creds.csrfToken, '12345');
  assert.equal(creds.at, '2026-10-26T00:00:00.000Z');
  assert.ok(!JSON.stringify(creds).includes('[object Object]'));
});

test('normalizeCredentials: время получения сессии проставляется, если его не передали', () => {
  const creds = normalizeCredentials({ cookie: 'c' }, '2026-10-26T10:00:00.000Z');
  assert.equal(creds.at, '2026-10-26T10:00:00.000Z');
});

test('isSessionUsable: пустая cookie означает испорченную сессию', () => {
  assert.equal(isSessionUsable({ cookie: 'X-Qlik-Session=abc' }), true);
  assert.equal(isSessionUsable({ cookie: '' }), false);
  assert.equal(isSessionUsable({ cookie: '   ' }), false);
  assert.equal(isSessionUsable(null), false);
  assert.equal(isSessionUsable('мусор'), false);
});

test('parseCredentials: испорченный файл отбрасывается, а не ломает восстановление', () => {
  assert.equal(parseCredentials('{не json'), null);
  assert.equal(parseCredentials('[object Object]'), null);
  assert.equal(parseCredentials('"строка"'), null);
  assert.equal(parseCredentials('{"cookie":""}'), null);
  assert.equal(parseCredentials(null), null);
});

test('parseCredentials: корректный файл восстанавливает сессию', () => {
  const creds = parseCredentials(JSON.stringify({
    hubUrl: 'https://hub.local', cookie: 'X-Qlik-Session=abc', xrfKey: 'x', csrfToken: 'c',
    at: '2026-10-26T10:00:00.000Z',
  }));
  assert.equal(creds.cookie, 'X-Qlik-Session=abc');
  assert.equal(creds.at, '2026-10-26T10:00:00.000Z');
});

/**
 * Сбор объектов приложения.
 */

test('chunk: список делится на блоки', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test('fetchObjects: незнакомый серверу тип не уводит остальные объекты', async () => {
  // Сервер отвергает вызов целиком, если в списке есть неизвестный ему тип.
  const app = {
    getObjects: async ({ qTypes }) => {
      if (qTypes.includes('story')) throw new Error('Unknown object type: story');
      return { qItems: qTypes.map((t) => ({ qId: `${t}-1`, qType: t })) };
    },
  };
  const { items, skipped } = await fetchObjects(app, ['sheet', 'chart'], { batchSize: 8 });
  assert.equal(items.length, 2, 'объекты известных типов получены');
  assert.equal(skipped.length, 0);
});

test('fetchObjects: тип, который сервер не понимает, попадает в пропущенные с текстом ошибки', async () => {
  const app = {
    getObjects: async ({ qTypes }) => {
      if (qTypes.includes('story')) throw new Error('Unknown object type: story');
      return { qItems: qTypes.filter((t) => t !== 'story').map((t) => ({ qId: `${t}-1`, qType: t })) };
    },
  };
  const { items, skipped } = await fetchObjects(app, ['sheet', 'story'], { batchSize: 8 });
  assert.equal(items.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].type, 'story');
  assert.match(skipped[0].reason, /Unknown object type/);
});

test('fetchObjects: один и тот же объект не считается дважды', async () => {
  const app = {
    getObjects: async ({ qTypes }) => ({
      qItems: qTypes.map(() => ({ qId: 'sheet-1', qType: 'sheet' })),
    }),
  };
  const { items } = await fetchObjects(app, ['sheet', 'story'], { batchSize: 8 });
  assert.equal(items.length, 1);
});

/**
 * Связи между таблицами и диагностика.
 */

test('fetchAssociations: недоступность метода объясняется, а не замалчивается', async () => {
  const { associations, reason } = await fetchAssociations({});
  assert.equal(associations, null);
  assert.match(reason, /R011/);
});

test('fetchAssociations: текст ошибки сервера сохраняется', async () => {
  const app = {
    getAssociationScores: async () => { throw new Error('Method not found'); },
  };
  const { associations, reason } = await fetchAssociations(app);
  assert.equal(associations, null);
  assert.match(reason, /Method not found/);
});

test('fetchAssociations: поддерживаемый сервер отдаёт связи', async () => {
  const app = { getAssociationScores: async () => [{ qTable1: 'A' }] };
  const { associations, reason } = await fetchAssociations(app);
  assert.deepEqual(associations, [{ qTable1: 'A' }]);
  assert.equal(reason, '');
});

test('describeMissingObjects: показывается настоящая причина от сервера', () => {
  const text = describeMissingObjects({
    meta: { skipped: [{ capability: 'objects', reason: 'тип story: Unknown object type' }] },
  });
  assert.match(text, /сервер не отдал объекты/);
  assert.match(text, /Unknown object type/);
});

test('describeMissingObjects: без причины остаётся прежняя формулировка', () => {
  const text = describeMissingObjects({ meta: { skipped: [] } });
  assert.match(text, /API не вернул список объектов/);
});
