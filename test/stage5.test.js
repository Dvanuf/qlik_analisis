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
import {
  fetchInventory, fetchDataConnections, readObjectTitle, readObjectDefinition,
} from '../src/extract/metadata.js';
import { hasCalcCondition } from '../src/extract/objects.js';
import { extractObjectExpressions } from '../src/extract/expressions.js';
import { parseScript } from '../src/script/parse.js';
import { buildOutline, searchScript } from '../src/script/outline.js';
import {
  listLibrary, libraryCall, libraryAsQvs, librarySubs,
} from '../src/script/library.js';

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
  const { objects: children, sheetOf } = await fetchSheetChildren(app, [{ id: 'sheet1', type: 'sheet' }]);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, 'kpi1');
  assert.equal(children[0].type, 'UniKPI');
  assert.equal(sheetOf.get('kpi1'), 'sheet1', 'зафиксировано, какому листу принадлежит объект');
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

/**
 * Метаданные приложения: полный перечень, свойства, подключения.
 */

test('fetchInventory: перечень объектов читается, служебные типы помечаются отдельно', async () => {
  const app = {
    getAllInfos: async () => [
      { qId: 'a1', qType: 'sheet' },
      { qId: 'a2', qType: 'masterobject' },
      { qId: 'a3', qType: 'LoadModel' },
    ],
  };
  const { items, available } = await fetchInventory(app);
  assert.equal(available, true);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.type), ['sheet', 'masterobject', 'LoadModel']);
});

test('fetchInventory: недоступность перечня не роняет сборку', async () => {
  const { items, available } = await fetchInventory({});
  assert.equal(available, false);
  assert.deepEqual(items, []);
});

test('fetchDataConnections: подключения читаются с типом и строкой подключения', async () => {
  const app = {
    getConnections: async () => [
      { qId: 'c1', qName: 'Sales', qType: 'folder', qConnectionString: '\\\\host\\Sales\\' },
    ],
  };
  const { items, available } = await fetchDataConnections(app);
  assert.equal(available, true);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Sales');
  assert.equal(items[0].type, 'folder');
});

test('readObjectTitle: название берётся из разных мест, без названия — идентификатор', () => {
  assert.equal(readObjectTitle({ qMeta: { title: 'Лист' } }), 'Лист');
  assert.equal(readObjectTitle({ title: 'Пользователь' }), 'Пользователь');
  assert.equal(readObjectTitle({ qMeta: { qName: 'Из qName' } }), 'Из qName');
  assert.equal(readObjectTitle({}, 'ид-1'), 'ид-1');
});

test('readObjectDefinition: определение собирается из полей измерения', () => {
  const def = readObjectDefinition({
    qHyperCube: { qDimensionInfo: [{ qGroupFieldDefs: ['=if(len([User Name])>1,[User Name])'] }] },
  });
  assert.match(def, /User Name/);
});

test('hasCalcCondition: пустое условие условием не считается', () => {
  assert.equal(hasCalcCondition({ qListObject: { qCalcCondition: { qCond: { qv: '' } } } }), false);
  assert.equal(hasCalcCondition({ qListObject: { qCalcCondition: { qCond: { qv: 'Count([X])>10' } } } }), true);
  assert.equal(hasCalcCondition({}), false);
});

/**
 * Новые правила по метаданным.
 */

test('R015: неиспользуемый master-объект', () => {
  const graph = graphWithObjects([
    { id: 'o1', type: 'table', expressions: [{ kind: 'dimension', expr: '[ID]' }] },
  ], {
    masterObjects: [{ id: 'm1', name: 'Топ пользователей', definition: '[User Name]' }],
  });
  const result = analyze(graph, { platform: 'qlik-sense' });
  const r015 = result.findings.filter((f) => f.ruleId === 'R015');
  assert.equal(r015.length, 1);
  assert.match(r015[0].message, /Топ пользователей/);
});

test('R015: master-объект, чьи поля используются, находки не даёт', () => {
  const graph = graphWithObjects([
    { id: 'o1', type: 'table', expressions: [{ kind: 'dimension', expr: '[User Name]' }] },
  ], {
    masterObjects: [{ id: 'm1', name: 'Топ пользователей', definition: '[User Name]' }],
  });
  const result = analyze(graph, { platform: 'qlik-sense' });
  assert.equal(result.findings.filter((f) => f.ruleId === 'R015').length, 0);
});

test('R016: тяжёлый объект без условия вычисления помечается', () => {
  const graph = graphWithObjects([
    // Агрегация — объект пересчитывается дорого.
    { id: 'o1', name: 'Первый', type: 'table', expressions: [{ kind: 'measure', expr: 'Sum([Amount])' }], calcCondition: false },
    // Условие вычисления задано — объект пересчитывается не всегда.
    { id: 'o2', name: 'Второй', type: 'table', expressions: [{ kind: 'measure', expr: 'Sum([Amount])' }], calcCondition: true },
    // Простое измерение по полю — дёшево, ругаться не на что.
    { id: 'o3', name: 'Третий', type: 'table', expressions: [{ kind: 'dimension', expr: '[ID]' }], calcCondition: false },
  ]);
  const result = analyze(graph, { platform: 'qlik-sense' });
  const r016 = result.findings.filter((f) => f.ruleId === 'R016');
  assert.equal(r016.length, 1);
  assert.match(r016[0].message, /Первый/);
});

test('R017: перегруженный лист помечается', () => {
  const objects = Array.from({ length: 16 }, (_, i) => ({
    id: `o${i}`, type: 'table', expressions: [{ kind: 'dimension', expr: '[ID]' }], sheetId: 's1',
  }));
  const graph = graphWithObjects(objects, { sheets: [{ id: 's1', name: 'Большой лист', type: 'sheet' }] });
  const result = analyze(graph, { platform: 'qlik-sense' });
  const r017 = result.findings.filter((f) => f.ruleId === 'R017');
  assert.equal(r017.length, 1);
  assert.match(r017[0].message, /16 объектов/);
});

test('R017: порог числа объектов настраивается', () => {
  const objects = Array.from({ length: 16 }, (_, i) => ({
    id: `o${i}`, type: 'table', expressions: [{ kind: 'dimension', expr: '[ID]' }], sheetId: 's1',
  }));
  const graph = graphWithObjects(objects, { sheets: [{ id: 's1', name: 'Большой лист', type: 'sheet' }] });
  const result = analyze(graph, { platform: 'qlik-sense', thresholds: { R017: { maxObjects: 20 } } });
  assert.equal(result.findings.filter((f) => f.ruleId === 'R017').length, 0);
});

test('R018: объект без измерений помечается', () => {
  const graph = graphWithObjects([
    { id: 'o1', name: 'Пустой', type: 'table', expressions: [] },
    { id: 'o2', name: 'С мерой', type: 'table', expressions: [{ kind: 'measure', expr: 'Sum([Amount])' }] },
  ]);
  const result = analyze(graph, { platform: 'qlik-sense' });
  const r018 = result.findings.filter((f) => f.ruleId === 'R018');
  assert.equal(r018.length, 1);
  assert.match(r018[0].message, /Пустой/);
});

test('R018: у контейнера (фильтр, KPI) поля лежат в детях — находки нет', () => {
  const graph = graphWithObjects([
    // Поля фильтра и KPI известны из их детей, а не из самого объекта.
    { id: 'f1', name: 'Фильтр', type: 'filterpane', expressions: [], fieldsKnown: false },
    { id: 'k1', name: 'KPI', type: 'UniKPI', expressions: [], fieldsKnown: false },
  ]);
  const result = analyze(graph, { platform: 'qlik-sense' });
  assert.equal(result.findings.filter((f) => f.ruleId === 'R018').length, 0);
});

/**
 * Разбор выражений: где сервер хранит измерения и меры.
 */

test('разбор выражений: измерения listbox читаются из qDimensionInfo', () => {
  const ex = extractObjectExpressions({
    qListObject: { qDimensionInfo: { qGroupFieldDefs: ['User Name'] } },
  });
  assert.equal(ex.hasDimensions, true);
  assert.equal(ex.expressions[0].expr, '[User Name]');
});

test('разбор выражений: меры читаются из qMeasureInfo', () => {
  const ex = extractObjectExpressions({
    qHyperCube: {
      qDimensionInfo: [],
      qMeasureInfo: [{ qFallbackTitle: 'count(distinct assignee)' }],
    },
  });
  assert.equal(ex.hasMeasures, true);
  assert.equal(ex.hasDimensions, false);
  assert.match(ex.expressions[0].expr, /count\(distinct assignee\)/);
});

test('разбор выражений: поле с пробелами оформляется ссылкой', () => {
  const ex = extractObjectExpressions({
    qHyperCube: { qDimensionInfo: [{ qGroupFieldDefs: ['User ID'] }] },
  });
  assert.equal(ex.expressions[0].expr, '[User ID]');
});

/**
 * Outline скрипта: разделы, шаги, поток построения, недостижимый код.
 */

const OUTLINE_SCRIPT = `
[Раздел загрузки]
Products:
LOAD p1, p2 FROM [products.csv];

[Раздел обработки]
Sales:
LOAD * FROM [sales.csv] RESIDENT Products;

SUB GetTotal(t)
  LOAD x FROM [$(vPath)];
END SUB

CALL GetTotal('Sales');

EXIT SCRIPT;
LET vNever = 1;
`;

test('разбор скрипта: подпрограммы, вызовы и разделы', () => {
  const model = parseScript(OUTLINE_SCRIPT);
  assert.equal(model.sections.length, 2);
  assert.deepEqual(model.sections.map((s) => s.name), ['Раздел загрузки', 'Раздел обработки']);
  assert.equal(model.subs.length, 1);
  assert.equal(model.subs[0].name, 'GetTotal');
  assert.deepEqual(model.subs[0].params, ['t']);
  assert.equal(model.subCalls.length, 1);
  assert.equal(model.subCalls[0].name, 'GetTotal');
  assert.deepEqual(model.subCalls[0].args, ['Sales']);
});

test('outline: разделы содержат свои таблицы и подпрограммы', () => {
  const outline = buildOutline(parseScript(OUTLINE_SCRIPT));
  const first = outline.sections.find((s) => s.name === 'Раздел загрузки');
  assert.ok(first.tables.includes('Products'), 'таблица продуктов попала в свой раздел');
  const second = outline.sections.find((s) => s.name === 'Раздел обработки');
  assert.ok(second.tables.includes('Sales'), 'таблица продаж попала в свой раздел');
  assert.ok(second.subs.includes('GetTotal'), 'подпрограмма попала в свой раздел');
});

test('outline: шаги таблицы описывают построение по порядку скрипта', () => {
  const outline = buildOutline(parseScript(OUTLINE_SCRIPT));
  const steps = outline.steps.filter((s) => s.table === 'Sales');
  assert.equal(steps.length, 1, 'у таблицы Sales один шаг — перезапись через RESIDENT');
  assert.match(steps[0].text, /RESIDENT/);
  const products = outline.steps.filter((s) => s.table === 'Products');
  assert.match(products[0].text, /Загрузка данных/);
});

test('outline: поток построения показывает resident-источник', () => {
  const outline = buildOutline(parseScript(OUTLINE_SCRIPT));
  const sales = outline.residentFlow.find((f) => f.table === 'Sales');
  assert.ok(sales, 'таблица Sales есть в потоке');
  assert.ok(sales.sources.includes('Products'), 'указано, из чего таблица построена');
});

test('outline: код после EXIT SCRIPT помечается как недостижимый', () => {
  const outline = buildOutline(parseScript(OUTLINE_SCRIPT));
  assert.ok(outline.unreachable.length >= 1, 'найден недостижимый оператор');
  assert.match(outline.unreachable[0].raw, /vNever/);
});

test('S013: недостижимый код после EXIT SCRIPT — находка', () => {
  const graph = graphWithObjects([], { script: OUTLINE_SCRIPT });
  const result = analyze(graph, { platform: 'auto' });
  const s013 = result.findings.filter((f) => f.ruleId === 'S013');
  assert.equal(s013.length, 1);
  assert.match(s013[0].message, /EXIT SCRIPT/);
});

test('поиск по скрипту: таблица, подпрограмма и переменная', () => {
  const model = parseScript(OUTLINE_SCRIPT);
  const tables = searchScript(model, 'sales');
  assert.ok(tables.some((f) => f.kind === 'таблица' && f.name === 'Sales'));
  const subs = searchScript(model, 'GetTotal');
  assert.ok(subs.length >= 1, 'найдена подпрограмма и её вызов');
  const vars = searchScript(model, 'vNever');
  assert.ok(vars.length >= 1, 'найдена переменная');
});

/**
 * Каталог готовых функций скрипта.
 */

test('каталог функций: у каждой записи есть документация и сигнатура', () => {
  const all = listLibrary();
  assert.ok(all.length >= 10, 'каталог непустой');
  for (const e of all) {
    assert.ok(e.id && e.title, 'есть идентификатор и название');
    assert.ok(e.description, `у ${e.id} есть описание`);
    assert.ok(e.signature.includes('('), `у ${e.id} есть сигнатура`);
    assert.ok(e.code.includes('SUB'), `у ${e.id} есть код подпрограммы`);
  }
});

test('каталог функций: код каждой записи разбирается нашим разбором', () => {
  for (const e of listLibrary()) {
    const subs = librarySubs(e.code);
    assert.equal(subs.length, 1, `у ${e.id} ровно одна подпрограмма`);
    assert.equal(subs[0].name, e.id, `имя ${e.id} совпадает с сигнатурой`);
    const sigParams = e.signature.slice(e.signature.indexOf('(') + 1, e.signature.lastIndexOf(')'))
      .split(',').map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(subs[0].params, sigParams, `параметры ${e.id} совпадают с сигнатурой`);
  }
});

test('каталог функций: вызов CALL и файл .qvs', () => {
  assert.equal(libraryCall('GenericLoad', ["'data.csv'", '"csv"']), "CALL GenericLoad('data.csv', \"csv\");");
  assert.equal(libraryCall('нет-такой'), '');
  const qvs = libraryAsQvs(['GenericLoad', 'MasterCalendar']);
  assert.equal(qvs.fileName, 'qlik-analyzer-library.qvs');
  assert.equal(librarySubs(qvs.content).length, 2);
  assert.ok(qvs.content.includes('SUB GenericLoad'));
});

test('каталог функций: своя библиотека .qvs перечисляет подпрограммы', () => {
  const subs = librarySubs(`
SUB MyLoader(Path)
  LOAD * FROM [\$(Path)];
END SUB

SUB MyHelper(a, b)
  LET x = a + b;
END SUB`);
  assert.equal(subs.length, 2);
  assert.deepEqual(subs[0].params, ['Path']);
  assert.deepEqual(subs[1].params, ['a', 'b']);
});
