import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, splitStatements } from '../src/script/parse.js';
import { analyze } from '../src/analyzer.js';

const SCRIPT = `
// Загрузка клиентов
Customers:
LOAD
    CustomerID,
    FirstName,
    Country
FROM [lib://Data/Customers.csv]
(txt, codepage is 1252, embedded labels, delimiter is ',');

Orders:
LOAD *
FROM [lib://Data/Orders.csv];

// Промежуточная трансформация
Temp:
LOAD *
RESIDENT Customers;

Fact:
LOAD *
RESIDENT Temp;

Left JOIN Orders IN Orders
ON Orders.CustomerID = Fact.CustomerID;

Bad:
LOAD *
RESIDENT MissingTable;

CONCATENATE(Orders)
LOAD * FROM [lib://Data/Orders2024.csv];

LET vStart = '2024-01-01';
LET vUnused = 1;
`;

const model = parseScript(SCRIPT);
const graph = {
  meta: { source: 'test', generatedAt: new Date().toISOString(), capabilities: [], skipped: [] },
  appName: 'Script test',
  appId: '',
  script: SCRIPT,
  sheets: [],
  objects: [],
  variables: model.variables.map((v) => ({ name: v.name, value: v.value, description: '' })),
  fields: [],
  tables: model.tables.map((t) => ({ name: t.name, fields: t.fields, keyFields: [], synthetic: false, rows: null })),
  bookmarks: [],
  extensions: [],
};
const result = analyze(graph, {});
const ids = new Set(result.findings.map((f) => f.ruleId));
const byId = (id) => result.findings.filter((f) => f.ruleId === id);

test('скрипт режется на операторы, комментарии выделяются', () => {
  const { statements, comments } = splitStatements(SCRIPT);
  assert.ok(statements.length > 8);
  assert.equal(comments.length, 2);
});

test('разбираются загрузки с метками и списком полей', () => {
  const customers = model.loads.find((l) => l.table === 'Customers');
  assert.ok(customers);
  assert.deepEqual(customers.fields, ['CustomerID', 'FirstName', 'Country']);
  assert.equal(customers.hasWhere, false);
});

test('распознаётся загрузка без списка полей', () => {
  const orders = model.loads.find((l) => l.table === 'Orders');
  assert.ok(orders);
  assert.equal(orders.allFields, true);
});

test('распознаются RESIDENT и JOIN', () => {
  assert.ok(model.residents.some((r) => r.table === 'Temp'));
  assert.ok(model.joins.some((j) => j.table === 'Orders' && j.joinType === 'LEFT'));
});

test('распознаются переменные скрипта', () => {
  assert.deepEqual(model.variables.map((v) => v.name).sort(), ['vStart', 'vUnused']);
});

test('S001: загрузка без списка полей', () => {
  assert.ok(ids.has('S001'));
  assert.ok(byId('S001').some((f) => f.target.name === 'Orders'));
});

test('S002: загрузка без WHERE', () => {
  assert.ok(ids.has('S002'));
});

test('S003: цепочка RESIDENT', () => {
  assert.ok(ids.has('S003'));
  assert.ok(byId('S003').some((f) => f.target.name === 'Fact'));
});

test('S004: CONCATENATE без NoConcatenate', () => {
  assert.ok(ids.has('S004'));
});

test('S007: в скрипте нет DROP FIELD', () => {
  assert.ok(ids.has('S007'));
});

test('S008: неиспользуемая переменная скрипта (когда есть данные фронт-енда)', () => {
  const withFrontEnd = analyze({ ...graph, objects: [{ id: 'o1', name: 'o1', type: 'chart', expressions: [] }] }, {});
  const found = withFrontEnd.findings.filter((f) => f.ruleId === 'S008');
  assert.ok(found.length > 0);
  assert.ok(found.some((f) => f.target.name === 'vUnused'));
});

test('S008: в файловом режиме проверка пропускается с объяснением', () => {
  assert.equal(byId('S008').length, 0);
  const stat = result.ruleStats.find((s) => s.id === 'S008');
  assert.ok(stat.note && stat.note.includes('фронт-енд'));
});

test('правило может вернуть пометку о пропуске', () => {
  const stat = result.ruleStats.find((s) => s.id === 'S008');
  assert.ok(typeof stat.note === 'string' && stat.note.length > 0);
});

test('S009: ссылка на неизвестную таблицу', () => {
  assert.ok(ids.has('S009'));
  assert.ok(byId('S009').some((f) => f.message.includes('MissingTable')));
});

test('S012: загрузка файла без указания формата', () => {
  assert.ok(ids.has('S012'));
  assert.ok(byId('S012').some((f) => f.message.includes('Orders.csv')));
});

test('S010: структурная ошибка скрипта ловится', () => {
  const broken = analyze({ ...graph, script: 'LOAD a FROM "b.csv;' }, {});
  assert.ok(broken.findings.some((f) => f.ruleId === 'S010'));
});

test('без скрипта скриптовые правила пропускаются, а не падают', () => {
  const noScript = analyze({ ...graph, script: '' }, {});
  const scriptFindings = noScript.findings.filter((f) => f.category === 'Script');
  assert.equal(scriptFindings.length, 0);
  const stat = noScript.ruleStats.find((s) => s.id === 'S001');
  assert.equal(stat.skipped, true);
});
