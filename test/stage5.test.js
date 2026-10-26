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
import { fetchObjects, fetchSheetChildren, normalizeObjectItem, chunk } from '../src/extract/objects.js';
import { fetchAssociations } from '../src/extract/associations.js';
import { describeMissingObjects } from '../src/cli/doctor.js';
import { checkScriptStructure, analyzeScriptIntegrity } from '../src/script/integrity.js';
import { extractReferences } from '../src/normalize.js';
import { detectPlatform } from '../src/rules/platforms.js';
import { analyze } from '../src/analyzer.js';

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

test('fetchAssociations: метод вызывается с именами двух таблиц', async () => {
  // Сервер отвергает вызов с массивами и числами: нужны две строки.
  const calls = [];
  const app = {
    getAssociationScores: async (first, second) => {
      calls.push([first, second]);
      if (typeof first !== 'string' || typeof second !== 'string') {
        throw new Error('Invalid method parameter(s)');
      }
      return { qScore: [] };
    },
  };
  const tables = [
    { name: 'Sales', fields: ['ID', 'Amount'] },
    { name: 'Clients', fields: ['ID'] },
  ];
  const { associations, reason } = await fetchAssociations(app, tables);
  assert.deepEqual(calls, [['Sales', 'Clients']]);
  assert.deepEqual(associations, []);
  assert.equal(reason, '');
});

test('fetchAssociations: связь один к одному опознаётся по уникальности и совпадению значений обоих полей', async () => {
  const app = {
    getAssociationScores: async () => ({
      qScore: [
        {
          // Уникальны и полностью совпадают — настоящая связь 1:1.
          qFieldPairName: 'ID / ID',
          qField1Scores: { qFieldName: 'ID', qCardinalRatio: 1, qSymbolScore: 1, qRowScore: 1 },
          qField2Scores: { qFieldName: 'ID', qCardinalRatio: 1, qSymbolScore: 1, qRowScore: 1 },
        },
        {
          // Уникальны, но значения не совпадают — связи нет.
          qFieldPairName: 'ID / Name',
          qField1Scores: { qFieldName: 'ID', qCardinalRatio: 1, qSymbolScore: 0, qRowScore: 0 },
          qField2Scores: { qFieldName: 'Name', qCardinalRatio: 1, qSymbolScore: 0, qRowScore: 0 },
        },
        {
          // Значения совпадают, но поле не уникально — это не 1:1.
          qFieldPairName: 'Amount / Sum',
          qField1Scores: { qFieldName: 'Amount', qCardinalRatio: 0.5, qSymbolScore: 1, qRowScore: 1 },
          qField2Scores: { qFieldName: 'Sum', qCardinalRatio: 1, qSymbolScore: 1, qRowScore: 1 },
        },
      ],
    }),
  };
  const tables = [
    { name: 'Sales', fields: ['ID'] },
    { name: 'Clients', fields: ['ID'] },
  ];
  const { associations } = await fetchAssociations(app, tables);
  assert.equal(associations.length, 1, 'только пара с уникальными полями и полным совпадением значений');
  assert.equal(associations[0].qCardinality, '1:1');
  assert.equal(associations[0].qTable, 'Sales');
  assert.equal(associations[0].qTable2, 'Clients');
});

test('fetchAssociations: текст ошибки сервера сохраняется', async () => {
  const app = {
    getAssociationScores: async () => { throw new Error('Method not found'); },
  };
  const tables = [
    { name: 'Sales', fields: ['ID'] },
    { name: 'Clients', fields: ['ID'] },
  ];
  const { associations, reason } = await fetchAssociations(app, tables);
  assert.equal(associations, null);
  assert.match(reason, /Method not found/);
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

/**
 * Разбор элементов списка объектов.
 *
 * Сервер отдаёт элементы в двух форматах: QIX App API — {qId, qType},
 * Doc API — {qInfo: {qId, qType}}. Раньше читалось только первое, и
 * объекты Doc API молча отбрасывались — приложение выглядело пустым.
 */

test('normalizeObjectItem: Doc API — поля внутри qInfo', () => {
  const obj = normalizeObjectItem({
    qInfo: { qId: 'abc', qType: 'sheet' },
    qMeta: { title: 'Мой лист' },
  });
  assert.equal(obj.id, 'abc');
  assert.equal(obj.type, 'sheet');
  assert.equal(obj.name, 'Мой лист');
});

test('normalizeObjectItem: QIX App API — поля прямо в элементе', () => {
  const obj = normalizeObjectItem({ qId: 'xyz', qType: 'chart', qMeta: { qName: 'График' } });
  assert.equal(obj.id, 'xyz');
  assert.equal(obj.type, 'chart');
  assert.equal(obj.name, 'График');
});

test('normalizeObjectItem: элемент без идентификатора не принимается', () => {
  assert.equal(normalizeObjectItem({ qType: 'sheet' }), null);
  assert.equal(normalizeObjectItem(null), null);
});

test('fetchObjects: ответ-массив (Doc API) разбирается', async () => {
  const app = {
    getObjects: async () => [{ qInfo: { qId: 'a1', qType: 'sheet' } }],
  };
  const { items } = await fetchObjects(app, ['sheet']);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'a1');
});

test('fetchSheetChildren: объекты с листа собираются, даже если их нет в списке типов', async () => {
  // Типы Sense 12 (UniKPI, filterpane) в списке типов движка отсутствуют,
  // но они перечислены в содержимом листа.
  const app = {
    getObject: async (id) => ({
      getLayout: async () => ({
        qInfo: { qId: id, qType: 'sheet' },
        qChildList: { qItems: [{ qInfo: { qId: 'kpi1', qType: 'UniKPI' } }] },
      }),
    }),
  };
  const children = await fetchSheetChildren(app, [{ id: 'sheet1', type: 'sheet' }]);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, 'kpi1');
  assert.equal(children[0].type, 'UniKPI');
});

/**
 * Экранирование в Qlik: обратный слэш не экранирует, кавычка удваивается.
 */

test('S010: обратный слэш в строке не считается экранированием', () => {
  // Реальный случай из скрипта приложения: склейка пути обратным слэшем.
  const script = "LET vPath = vDir & '\\' & vFile;\nLOAD * FROM [lib://Data/File.csv];";
  const { problems } = checkScriptStructure(script);
  assert.equal(problems.length, 0, `неожиданные проблемы: ${JSON.stringify(problems)}`);
});

test('S010: удвоенная кавычка остаётся экранированной', () => {
  const script = "SET name = 'O''Brien';\nLOAD * FROM data.csv;";
  const { problems } = checkScriptStructure(script);
  assert.equal(problems.length, 0, `неожиданные проблемы: ${JSON.stringify(problems)}`);
});

test('целостность: скрипт с обратным слэшем не считается обрезанным', () => {
  const script = "LET vPath = vDir & '\\' & vFile;\nLOAD * FROM data.csv;";
  const info = analyzeScriptIntegrity(script);
  assert.equal(info.truncated, false);
  assert.equal(info.maybeTruncated, false);
});

test('разбор выражений: обратный слэш не съедает закрывающую кавычку', () => {
  // После строки из одного обратного слэша разбор продолжается,
  // а не «съедает» остаток выражения.
  const refs = extractReferences("Replace(vPath, '\\', '/')");
  assert.deepEqual(refs.fields, ['vPath']);
  assert.deepEqual(refs.functions, ['Replace']);
});

/**
 * Определение платформы по типам объектов.
 */

test('detectPlatform: типы Sense 12 отличают Sense от QlikView', () => {
  assert.equal(detectPlatform([{ type: 'sheet' }, { type: 'UniKPI' }]), 'qlik-sense');
  assert.equal(detectPlatform([{ type: 'filterpane' }]), 'qlik-sense');
  assert.equal(detectPlatform([{ type: 'sheet' }, { type: 'table' }]), 'qlikview');
  assert.equal(detectPlatform([]), 'qlikview');
});

/**
 * Платформа по умолчанию — по данным сервера.
 */

function graphWithObjects(objects, extra = {}) {
  return {
    meta: { source: 'test', platform: 'qlik-sense', capabilities: ['objects'], skipped: [] },
    appName: 'Тест',
    appId: 'test',
    script: '',
    sheets: [],
    objects,
    variables: [],
    fields: [],
    tables: [],
    bookmarks: [],
    extensions: [],
    ...extra,
  };
}

test('анализ: платформа auto берётся из данных сервера', () => {
  const graph = graphWithObjects([{ id: 'o1', type: 'sheet', expressions: [] }], {
    meta: { source: 'test', platform: 'qlik-sense', capabilities: ['objects'], skipped: [] },
  });
  const result = analyze(graph, { platform: 'auto' });
  assert.equal(result.summary.platform, 'qlik-sense');
});

test('анализ: явно выбранная платформа важнее определённой сервером', () => {
  const graph = graphWithObjects([{ id: 'o1', type: 'sheet', expressions: [] }]);
  const result = analyze(graph, { platform: 'qlikview' });
  assert.equal(result.summary.platform, 'qlikview');
});

/**
 * «Поле не используется» — утверждение о фронт-энде, и оно требует данных.
 */

test('R001: без сведений об использовании полей правило пропускается, а не ругается', () => {
  // Объекты есть, но ссылок на поля в них нет — сервер их не отдал.
  const graph = graphWithObjects([{ id: 'o1', type: 'table', expressions: [] }], {
    fields: [{ name: 'Amount', table: 'Sales', key: false, tags: [] }],
    tables: [{ name: 'Sales', fields: ['Amount'] }],
  });
  const result = analyze(graph, { platform: 'qlik-sense' });
  assert.equal(result.findings.filter((f) => f.ruleId === 'R001').length, 0);
  const stat = result.ruleStats.find((s) => s.id === 'R001');
  assert.equal(stat.skipped, true);
  assert.match(stat.note, /недоказуемо/);
});

test('R001: при известном использовании полей находка появляется', () => {
  const graph = graphWithObjects([
    { id: 'o1', type: 'table', expressions: [{ kind: 'dimension', expr: '[ID]' }] },
  ], {
    fields: [
      { name: 'ID', table: 'Sales', key: false, tags: [] },
      { name: 'Amount', table: 'Sales', key: false, tags: [] },
    ],
    tables: [{ name: 'Sales', fields: ['ID', 'Amount'] }],
  });
  const result = analyze(graph, { platform: 'qlik-sense' });
  const r001 = result.findings.filter((f) => f.ruleId === 'R001');
  assert.equal(r001.length, 1);
  assert.match(r001[0].message, /Amount/);
});
