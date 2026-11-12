/**
 * Схема модели данных с пометками проблем: узлы-таблицы, связи по общим
 * полям (1:1 / m:n / key), агрегация находок по таблицам и полям, notes
 * о полноте данных.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../src/script/parse.js';
import { buildLineage } from '../src/script/lineage.js';
import { buildDataSchema, SCHEMA_MAX_LINKS } from '../src/report/data-schema.js';

const SCRIPT = [
  'Продажи:',
  'LOAD Код, Сумма FROM [lib://Data/sales.qvd] (qvd);',
  'Товары:',
  'LOAD Код, Наименование FROM [lib://Data/goods.qvd] (qvd);',
].join('\n');

const GRAPH = {
  appName: 'Тест',
  script: SCRIPT,
  meta: {
    source: 'engine',
    capabilities: ['dataModel', 'associations'],
    associations: [{ qTable: 'Продажи', qTable2: 'Товары', qField: 'Код', qCardinality: '1:1' }],
  },
  tables: [
    { name: 'Продажи', rows: 100, fields: ['Код', 'Сумма'], keyFields: ['Код'], synthetic: false },
    { name: 'Товары', rows: 50, fields: ['Код', 'Наименование'], keyFields: ['Код'], synthetic: false },
    { name: 'Мост', rows: 30, fields: ['Код', 'Сумма'], keyFields: [], synthetic: true },
  ],
  fields: [
    { name: 'Код', table: 'Продажи', key: true, rows: 100, distinct: 100, subsetRatio: 0.8 },
    { name: 'Сумма', table: 'Продажи', key: false, rows: 100, distinct: 90 },
    { name: 'Код', table: 'Товары', key: true, rows: 50, distinct: 50, subsetRatio: 1 },
    { name: 'Наименование', table: 'Товары', key: false, rows: 50, distinct: 50 },
    { name: 'Код', table: 'Мост', key: false, rows: 30, distinct: 10 },
    { name: 'Сумма', table: 'Мост', key: false, rows: 30, distinct: 20 },
  ],
};

const FINDINGS = [
  { ruleId: 'R003', severity: 'warning', title: 'Неиспользуемая таблица', target: { kind: 'table', name: 'Мост' } },
  { ruleId: 'R001', severity: 'info', title: 'Поле не используется', target: { kind: 'field', name: 'Сумма' } },
  { ruleId: 'R010', severity: 'warning', title: 'Неполный ключ', target: { kind: 'field', name: 'Код' } },
];

const lineage = () => buildLineage(parseScript(SCRIPT));

test('buildDataSchema: узлы-таблицы с атрибутами и типом источника', () => {
  const schema = buildDataSchema(GRAPH, FINDINGS, lineage());
  assert.equal(schema.tables.length, 3);
  const sales = schema.tables.find((t) => t.name === 'Продажи');
  const bridge = schema.tables.find((t) => t.name === 'Мост');
  assert.equal(sales.rows, 100);
  assert.equal(sales.sourceKind, 'lib', 'источник из lineage');
  assert.equal(bridge.sourceKind, null, 'таблицы вне скрипта — без типа источника');
  assert.equal(bridge.synthetic, true, 'синтетический ключ сохраняется');
  // Поля таблицы: ключевые помечены, неполный ключ — по subsetRatio.
  const salesKey = sales.fields.find((f) => f.name === 'Код');
  assert.equal(salesKey.key, true);
  assert.equal(salesKey.incompleteKey, true, 'subsetRatio 0.8 — ключ неполный');
  const goodsKey = schema.tables.find((t) => t.name === 'Товары').fields.find((f) => f.name === 'Код');
  assert.equal(goodsKey.incompleteKey, false, 'subsetRatio 1 — ключ полный');
});

test('buildDataSchema: типы связей — 1:1 из associations, m:n по неуникальности, key по умолчанию', () => {
  const schema = buildDataSchema(GRAPH, FINDINGS, lineage());
  const kinds = {};
  for (const l of schema.links) kinds[`${l.from}+${l.to}+${l.field}`] = l.kind;
  assert.equal(kinds['продажи+товары+код'], '1:1', 'связь из meta.associations');
  assert.equal(kinds['мост+продажи+сумма'], 'm:n', 'Сумма неуникальна в обеих таблицах');
  assert.equal(kinds['мост+продажи+код'], 'key', 'Код неуникален только в Мост');
  assert.equal(schema.meta.associationsAvailable, true);
});

test('buildDataSchema: проблемы таблицы — находка по таблице и по её полям', () => {
  const schema = buildDataSchema(GRAPH, FINDINGS, lineage());
  const bridge = schema.tables.find((t) => t.name === 'Мост');
  // R003 (таблица) + R010 (поле Код) — warnings; R001 (поле Сумма) — info.
  assert.equal(bridge.problems.warning, 2);
  assert.equal(bridge.problems.info, 1);
  assert.equal(bridge.problems.total, 3);
  const ids = bridge.problems.rules.map((r) => r.id);
  assert.deepEqual(ids, ['R003', 'R010', 'R001'], 'сортировка по важности, затем по id');
  assert.equal(bridge.problems.rules.find((r) => r.id === 'R010').count, 1);
  const clean = schema.tables.find((t) => t.name === 'Товары');
  // Товары: R010 по полю Код → warning тоже здесь (поле в двух таблицах).
  assert.equal(clean.problems.warning, 1);
  assert.equal(clean.problems.info, 0);
});

test('buildDataSchema: проблемы поля попадают во все таблицы с этим полем', () => {
  const schema = buildDataSchema(GRAPH, FINDINGS, lineage());
  const salesSum = schema.tables.find((t) => t.name === 'Продажи').fields.find((f) => f.name === 'Сумма');
  const bridgeSum = schema.tables.find((t) => t.name === 'Мост').fields.find((f) => f.name === 'Сумма');
  assert.equal(salesSum.problems.rules[0].id, 'R001');
  assert.equal(bridgeSum.problems.rules[0].id, 'R001');
  const salesName = schema.tables.find((t) => t.name === 'Товары').fields.find((f) => f.name === 'Наименование');
  assert.equal(salesName.problems, null, 'чистое поле — problems null');
});

test('buildDataSchema: чистая таблица без находок — problems null', () => {
  const schema = buildDataSchema(GRAPH, [], lineage());
  for (const t of schema.tables) assert.equal(t.problems, null);
});

test('buildDataSchema: пустой граф — пустая схема без лишних notes', () => {
  const schema = buildDataSchema({}, []);
  assert.deepEqual(schema.tables, []);
  assert.deepEqual(schema.links, []);
  assert.deepEqual(schema.meta.notes, []);
});

test('buildDataSchema: без таблиц движка таблицы выводятся из модели скрипта', () => {
  // Файловый анализ: коннектор отдаёт только текст скрипта (tables: []).
  const script = [
    'Продажи:',
    'LOAD Код, Сумма FROM [lib://Data/sales.qvd] (qvd);',
    'Товары:',
    'LOAD Код, Наименование FROM [lib://Data/goods.qvd] (qvd);',
    'Итоги:',
    'LOAD Код, Sum(Сумма) as Итог Resident Продажи Group By Код;',
  ].join('\n');
  const model = parseScript(script);
  const g = { meta: { source: 'file:script', capabilities: ['script'] }, tables: [], fields: [] };
  const schema = buildDataSchema(g, [], lineage(), [], model);
  assert.deepEqual(schema.tables.map((t) => t.name).sort(), ['Итоги', 'Продажи', 'Товары']);
  const sales = schema.tables.find((t) => t.name === 'Продажи');
  assert.deepEqual(sales.fields.map((f) => f.name).sort(), ['Код', 'Сумма']);
  assert.equal(sales.rows, null, 'объём строк из скрипта неизвестен');
  assert.equal(schema.links.length, 3, '«Код» связывает все три таблицы: Итоги–Продажи, Итоги–Товары, Продажи–Товары');
  assert.ok(schema.links.every((l) => l.kind === 'key'), 'без кардинальности все связи — key');
  assert.equal(schema.meta.modelFromScript, true);
  assert.ok(schema.meta.notes.some((n) => n.includes('объём данных')));
  // Настоящие таблицы движка не заменяются скриптовыми.
  const engineSchema = buildDataSchema(GRAPH, [], lineage(), [], model);
  assert.equal(engineSchema.tables.length, 3);
  assert.equal(engineSchema.tables.find((t) => t.name === 'Мост').synthetic, true);
});

test('buildDataSchema: модель из скрипта — пометка об отсутствии объёмов', () => {
  const g = { ...GRAPH, meta: { source: 'file:qvs', capabilities: [] } };
  const schema = buildDataSchema(g, [], lineage());
  assert.equal(schema.meta.modelFromScript, true);
  assert.ok(schema.meta.notes.some((n) => n.includes('объём данных')), 'note о неизвестных строках');
});

test('buildDataSchema: пропуск проверок использования полей — без дубля-note (карточка сама)', () => {
  const stats = [
    { id: 'R001', skipped: true },
    { id: 'R002', skipped: true },
    { id: 'R003', skipped: true },
  ];
  const schema = buildDataSchema(GRAPH, [], lineage(), stats);
  assert.ok(!schema.meta.notes.some((n) => n.includes('использовании полей')), 'note о пропусках дублирует карточку');
});

test('buildDataSchema: связи обрезаются пределом SCHEMA_MAX_LINKS', () => {
  const fields = [];
  const names = Array.from({ length: SCHEMA_MAX_LINKS + 50 }, (_, i) => `f${String(i).padStart(3, '0')}`);
  for (const n of names) fields.push({ name: n, table: 'A', rows: 10, distinct: 10 }, { name: n, table: 'B', rows: 10, distinct: 10 });
  const g = {
    meta: { source: 'engine', capabilities: ['dataModel'] },
    tables: [
      { name: 'A', rows: 10, fields: names, keyFields: [], synthetic: false },
      { name: 'B', rows: 10, fields: names, keyFields: [], synthetic: false },
    ],
    fields,
  };
  const schema = buildDataSchema(g, []);
  assert.equal(schema.links.length, SCHEMA_MAX_LINKS);
  assert.ok(schema.meta.notes.some((n) => n.includes(`из ${names.length}`)), 'note об упрощении');
});

const DROP_SCRIPT = [
  'Продажи:',
  'LOAD Код, Сумма FROM [lib://Data/sales.qvd] (qvd);',
  'Raw:',
  'LOAD Код, Коммент FROM [lib://Data/raw.qvd] (qvd);',
  'Итог:',
  'LOAD Код Resident Продажи;',
  'DROP Table Raw;',
].join('\n');
const dropLineage = () => buildLineage(parseScript(DROP_SCRIPT));

test('buildDataSchema: три состояния — asBuilt с дропнутой, final без, критерии в meta', () => {
  // Движок видит только финальные таблицы; Raw удалена (DROP) в скрипте.
  const g = { ...GRAPH, meta: { ...GRAPH.meta, associations: [] } };
  const schema = buildDataSchema(g, [], dropLineage(), [], parseScript(DROP_SCRIPT));
  // asBuilt содержит и движковые, и промежуточную Raw со статусом dropped.
  const asNames = schema.asBuilt.tables.map((t) => t.name);
  assert.ok(asNames.includes('Raw'), 'asBuilt: промежуточная таблица на месте');
  const raw = schema.asBuilt.tables.find((t) => t.name === 'Raw');
  assert.equal(raw.dropped, true, 'Raw помечена как удалённая');
  assert.equal(raw.intermediate, true, 'Raw — промежуточная (нет в движке)');
  assert.equal(raw.fields.length, 2, 'поля промежуточной — из LOAD скрипта');
  // final — только движковые, без Raw.
  const finNames = schema.final.tables.map((t) => t.name);
  assert.ok(!finNames.includes('Raw'), 'final: дропнутой нет');
  assert.ok(finNames.includes('Продажи') && finNames.includes('Товары'));
  // Цепочки RESIDENT из lineage попали в asBuilt-связи (без поля).
  assert.ok(schema.asBuilt.links.some((l) => l.field === null && l.kind === 'resident'), 'RESIDENT-ребро в asBuilt');
  // Критерии — для легенды и панели качества.
  assert.ok(schema.meta.criteria.some((c) => c.id === 'synthetic' && c.label.length > 3));
  // Диагностика прогона: платформа не задана в этом графе, объектов нет.
  assert.equal(schema.meta.platform, null);
  assert.equal(schema.meta.objectsCount, 0);
  assert.deepEqual(schema.meta.frontEndStats, null, 'без index — без цифр');
});

test('buildDataSchema: анализ файла — final исключает дропнутые таблицы', () => {
  const model = parseScript(DROP_SCRIPT);
  const g = { meta: { source: 'file:script', capabilities: [] }, tables: [], fields: [] };
  const schema = buildDataSchema(g, [], dropLineage(), [], model);
  const fin = schema.final.tables.map((t) => t.name);
  assert.ok(!fin.includes('Raw'), 'final без дропнутой');
  assert.ok(fin.includes('Итог') && fin.includes('Продажи'), 'остальные на месте');
  const as = schema.asBuilt.tables.map((t) => t.name);
  assert.ok(as.includes('Raw'), 'asBuilt хранит всю картину');
});

test('buildDataSchema: problemsByType — синт.ключ, неиспользуемые, перегрузка', () => {
  const findings = [
    { ruleId: 'P005', severity: 'warning', title: 'Синтетический ключ', target: { kind: 'table', name: 'Мост' } },
    { ruleId: 'R001', severity: 'warning', title: 'Неиспользуемое поле', target: { kind: 'field', name: 'Сумма' }, impact: { rows: 40 } },
    { ruleId: 'Q001', severity: 'error', title: 'Ошибка выражения', target: { kind: 'table', name: 'Мост' } },
  ];
  const schema = buildDataSchema(GRAPH, findings, lineage());
  const bridge = schema.final.tables.find((t) => t.name === 'Мост');
  assert.equal(bridge.problemsByType.synthetic, 1);
  assert.equal(bridge.problemsByType.errors, 1, 'ошибки считаются отдельно');
  // Сумма в двух таблицах: unusedFields в обеих; перегрузка у Продажи —
  // по доле лишних строк (40 из 100) и полей.
  const sales = schema.final.tables.find((t) => t.name === 'Продажи');
  assert.equal(sales.problemsByType.unusedFields, 1);
  assert.ok(sales.problemsByType.overload > 0 && sales.problemsByType.overload <= 100, 'перегрузка 0–100');
  const clean = schema.final.tables.find((t) => t.name === 'Товары');
  assert.equal(clean.problemsByType.overload, 0, 'без лишних данных — 0');
  // Поле с неиспользуемым флагом.
  const sumField = sales.fields.find((f) => f.name === 'Сумма');
  assert.equal(sumField.unused, true);
});

test('buildDataSchema: afterFix — удаляемое по fix помечено и убрано из связей', () => {
  const findings = [
    { ruleId: 'R003', severity: 'warning', title: 'Неиспользуемая таблица', target: { kind: 'table', name: 'Мост' }, fix: { kind: 'dropTable', payload: 'Мост' } },
    { ruleId: 'R001', severity: 'warning', title: 'Неиспользуемое поле', target: { kind: 'field', name: 'Сумма' }, fix: { kind: 'dropField', payload: 'Сумма' } },
  ];
  const schema = buildDataSchema(GRAPH, findings, lineage());
  const bridge = schema.afterFix.tables.find((t) => t.name === 'Мост');
  assert.equal(bridge.removedByFix, true, 'таблица помечена удаляемой');
  const sales = schema.afterFix.tables.find((t) => t.name === 'Продажи');
  assert.equal(sales.removedByFix, undefined, 'остальные не тронуты');
  // Связи afterFix не ссылаются на удаляемую таблицу.
  assert.ok(schema.afterFix.links.every((l) => l.from !== 'мост' && l.to !== 'мост'), 'мост исключён из связей');
});
