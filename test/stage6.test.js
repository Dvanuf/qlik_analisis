/**
 * Тесты версии 0.6.0: правки скрипта, ошибки скрипта от сервера,
 * метаданные приложений (поток, владелец, тэги) и правило P001.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFixes, isCodeLine, lastCodeLine } from '../src/report/fixes.js';
import { normalizeScriptErrors, fetchScriptErrors } from '../src/extract/script-errors.js';
import { appMeta, pickTags } from '../src/extract/session.js';
import { isWorthReporting } from '../src/rules/practices.js';
import { buildDataModelSheets, buildDataModelXlsx } from '../src/report/data-model.js';
import { buildXlsxBook } from '../src/report/xlsx.js';
import { searchExpressions } from '../src/script/search.js';
import { renderHtml } from '../src/report/html.js';
import { analyze } from '../src/analyzer.js';
import { RULES_BY_ID } from '../src/rules/index.js';

// --- Пункт 1: правки скрипта не должны выглядеть «пустыми» ---

test('разделитель ///$tab и комментарии не считаются кодом', () => {
  assert.equal(isCodeLine('///$tab ____________________'), false);
  assert.equal(isCodeLine('// комментарий'), false);
  assert.equal(isCodeLine('/* блок */'), false);
  assert.equal(isCodeLine('DROP FIELD Comment;'), true);
});

test('опора правки — последняя строка с кодом, а не разделитель', () => {
  const lines = [
    'LOAD * FROM a.csv;',
    '///$tab ____________________',
    '///$tab ____________________',
  ];
  assert.equal(lastCodeLine(lines), 0);
});

test('правка DROP FIELD опирается на строку кода, а не на разделитель', () => {
  const script = 'LOAD * FROM a.csv;\n///$tab ____________________\n';
  const findings = [{
    ruleId: 'R005', title: 'Пустое поле', fix: { kind: 'dropField', payload: 'Comment' },
  }];
  const fixes = buildFixes(findings, script);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].before, 'LOAD * FROM a.csv;');
  assert.ok(!fixes[0].before.includes('$tab'), 'опора не разделитель');
  assert.match(fixes[0].after, /DROP FIELD Comment;/);
});

// --- Пункт 1: правки одного вида собираются в один оператор ---

test('несколько удаляемых полей дают одну правку, а не десяток', () => {
  const findings = [
    { ruleId: 'R005', title: 'Пустое поле', fix: { kind: 'dropField', payload: 'Comment' } },
    { ruleId: 'R002', title: 'Не используется', fix: { kind: 'dropField', payload: 'Extra' } },
    { ruleId: 'R006', title: 'Пустая таблица', fix: { kind: 'dropTable', payload: 'Tmp' } },
  ];
  const fixes = buildFixes(findings, 'LOAD * FROM a.csv;');
  const fields = fixes.filter((f) => f.kind === 'dropField');
  const tables = fixes.filter((f) => f.kind === 'dropTable');
  assert.equal(fields.length, 1, 'поля объединены в одну правку');
  assert.equal(tables.length, 1, 'таблицы — в отдельную правку');
  assert.match(fields[0].statement, /DROP FIELD Comment, Extra;/);
  assert.equal(fields[0].count, 2);
});

test('одно и то же поле из двух правил — одна правка', () => {
  const findings = [
    { ruleId: 'R005', title: 'Пустое поле', fix: { kind: 'dropField', payload: 'Comment' } },
    { ruleId: 'R002', title: 'Не используется', fix: { kind: 'dropField', payload: 'Comment' } },
  ];
  const fixes = buildFixes(findings, 'LOAD * FROM a.csv;');
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].statement, /DROP FIELD Comment;$/);
});

// --- Пункт 3: ошибки скрипта с местами ---

test('ответ сервера об ошибках скрипта читается в строку и колонку', () => {
  const errors = normalizeScriptErrors({
    qErrors: [
      { qLineInTab: 12, qColInLine: 5, qMessage: 'Invalid object name', qType: 'SYNTAX_ERROR' },
      { qMessage: 'Ошибка без строки' },
    ],
  });
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 12);
  assert.equal(errors[0].column, 5);
  assert.equal(errors[0].message, 'Invalid object name');
  assert.equal(errors[1].line, null);
});

test('сервер без метода проверки синтаксиса — не ошибка', async () => {
  assert.deepEqual(await fetchScriptErrors({}), []);
  assert.deepEqual(await fetchScriptErrors(null), []);
});

// --- Пункт 4 и 5: метаданные приложения ---

test('тэги читаются и из строк, и из объектов', () => {
  assert.deepEqual(pickTags({ qTags: ['ежедневно', 'продажи'] }), ['ежедневно', 'продажи']);
  assert.deepEqual(pickTags({ tags: [{ qName: 'отчёт' }] }), ['отчёт']);
  assert.deepEqual(pickTags({}), []);
});

test('поток и владелец читаются и из строк, и из объектов', () => {
  const meta = appMeta({ stream: { name: 'Retail' }, owner: 'Иванова' });
  assert.equal(meta.stream, 'Retail');
  assert.equal(meta.owner, 'Иванова');
});

// --- Пункт 6: правило P001 больше не кричит о нормальном коде ---

test('простая ссылка на поле не считается повторным использованием', () => {
  assert.equal(isWorthReporting('[Поле]', {}), false);
  assert.equal(isWorthReporting('sum([Продажи])', {}), true);
});

test('P001 — замечание, а не ошибка, и называется «повторное использование»', () => {
  const rule = RULES_BY_ID.get('P001');
  assert.equal(rule.severity, 'info');
  assert.equal(rule.title, 'Повторное использование выражения');
});

test('P001 не срабатывает на повтор простой ссылки на поле', () => {
  const graph = {
    script: '',
    meta: {},
    sheets: [],
    tables: [],
    fields: [],
    objects: [
      { id: 'o1', name: 'Лист1', type: 'sheet', expressions: [{ kind: 'dimension', expr: '[Поле]' }] },
      { id: 'o2', name: 'Лист2', type: 'sheet', expressions: [{ kind: 'dimension', expr: '[Поле]' }] },
    ],
    variables: [],
  };
  const result = analyze(graph, { platform: 'auto' });
  assert.equal(result.findings.filter((f) => f.ruleId === 'P001').length, 0);
});

test('P001 сообщает о повторе сложного выражения в разных объектах', () => {
  const graph = {
    script: '',
    meta: {},
    sheets: [],
    tables: [],
    fields: [],
    objects: [
      { id: 'o1', name: 'Лист1', type: 'sheet', expressions: [{ kind: 'measure', expr: 'sum([Продажи] / [Цена])' }] },
      { id: 'o2', name: 'Лист2', type: 'sheet', expressions: [{ kind: 'measure', expr: 'Sum([Продажи]/[Цена])' }] },
    ],
    variables: [],
  };
  const result = analyze(graph, { platform: 'auto' });
  const p001 = result.findings.filter((f) => f.ruleId === 'P001');
  assert.equal(p001.length, 1);
  assert.equal(p001[0].severity, 'info');
  assert.match(p001[0].message, /используется в 2 объектах/);
});

// --- Пункт 7: «Data model (Excel)» раздела Explore ---

/** Приложение с таблицей, полями, объектами и переменной. */
function graphForModel() {
  return {
    meta: {},
    script: '',
    sheets: [{ id: 's1', name: 'Лист 1' }],
    tables: [{ name: 'Customers', rows: 100, fields: ['ID', 'Name'], keyFields: ['ID'], synthetic: false, directDiscovery: false }],
    fields: [
      { name: 'ID', table: 'Customers', key: true, rows: 100, distinct: 100, nonNulls: 100 },
      { name: 'Name', table: 'Customers', key: false, rows: 100, distinct: 40, nonNulls: 90 },
    ],
    objects: [
      { id: 'o1', name: 'Таблица 1', type: 'table', description: '', expressions: [{ kind: 'dimension', expr: '[Name]' }] },
    ],
    variables: [{ name: 'Валюта', value: '=1', description: '' }],
    bookmarks: [{ id: 'b1', name: 'Закладка 1', objectIds: ['o1'] }],
    masterObjects: [],
    connections: [{ id: 'c1', name: 'Папка', type: 'folder', connectionString: 'lib://Data' }],
  };
}

test('модель данных раскладывается по листам книги', () => {
  const sheets = buildDataModelSheets(graphForModel());
  const names = sheets.map((s) => s.name);
  assert.deepEqual(names, [
    'Таблицы', 'Поля', 'Объекты', 'Измерения', 'Меры', 'Переменные', 'Закладки',
    'Истории', 'Master-объекты', 'Подключения',
  ]);
  const tables = sheets.find((s) => s.name === 'Таблицы');
  assert.equal(tables.rows.length, 1);
  assert.equal(tables.rows[0][0], 'Customers');
  const fields = sheets.find((s) => s.name === 'Поля');
  assert.equal(fields.rows.length, 2);
  // У поля Name видно, где оно используется.
  const nameRow = fields.rows.find((r) => r[0] === 'Name');
  assert.match(nameRow[7], /измерение/);
  assert.match(nameRow[8], /Таблица 1/);
});

test('книга модели данных — корректный zip с несколькими листами', () => {
  const buf = buildDataModelXlsx(graphForModel());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const text = buf.toString('latin1');
  assert.ok(text.includes('xl/worksheets/sheet1.xml'));
  assert.ok(text.includes('xl/worksheets/sheet10.xml'));
  assert.ok(text.includes('xl/workbook.xml'));
});

test('книга Excel с несколькими листами содержит все листы', () => {
  const buf = buildXlsxBook([
    { name: 'Первый', headers: ['A'], rows: [['значение']] },
    { name: 'Второй', headers: ['B'], rows: [['ещё']] },
  ]);
  const text = buf.toString('latin1');
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(text.includes('xl/worksheets/sheet1.xml'));
  assert.ok(text.includes('xl/worksheets/sheet2.xml'));
});

// --- Пункт 7: «Search any expression» раздела Explore ---

test('поиск по выражению находит объекты и строки скрипта', () => {
  const graph = {
    script: 'LET v = Sum([Продажи]);\nLOAD * FROM a.csv;',
    objects: [
      { id: 'o1', name: 'Лист1', type: 'sheet', expressions: [{ kind: 'measure', expr: 'sum([Продажи])' }] },
      { id: 'o2', name: 'Лист2', type: 'sheet', expressions: [{ kind: 'dimension', expr: '[Регион]' }] },
    ],
    variables: [{ name: 'Валюта', value: '=1' }],
  };
  const hits = searchExpressions(graph, 'продажи');
  assert.equal(hits.objects.length, 1);
  assert.equal(hits.objects[0].name, 'Лист1');
  assert.equal(hits.script.length, 1);
  assert.equal(hits.script[0].line, 1);
  assert.equal(hits.total, 2);
});

test('поиск принимает готовый перечень выражений', () => {
  const hits = searchExpressions({
    expressions: [{ name: 'Лист1', type: 'sheet', kind: 'measure', expr: 'Sum([Продажи])' }],
    script: '',
  }, 'sum([продажи])');
  assert.equal(hits.total, 1);
  assert.equal(hits.objects[0].name, 'Лист1');
});

test('пустой запрос не даёт результатов', () => {
  const hits = searchExpressions({ expressions: [], script: '' }, '   ');
  assert.equal(hits.total, 0);
});

// --- Пункт 7: правила Optimize, которых не было (R019–R021) ---

test('R019: подключение, которого нет в скрипте, считается неиспользуемым', () => {
  const graph = {
    script: 'LOAD * FROM "lib://Data/a.csv";',
    meta: {},
    sheets: [], objects: [], fields: [], tables: [], variables: [], bookmarks: [],
    connections: [
      { id: 'c1', name: 'Папка', type: 'folder', connectionString: 'lib://Data' },
      { id: 'c2', name: 'Старое', type: 'folder', connectionString: 'lib://Old' },
    ],
  };
  const result = analyze(graph, { platform: 'auto' });
  const found = result.findings.filter((f) => f.ruleId === 'R019');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Старое/);
});

test('R020: поле с уникальным значением на каждую строку — высококардинальное', () => {
  const graph = {
    script: '', meta: {}, sheets: [], objects: [], variables: [], bookmarks: [],
    tables: [{ name: 'T', rows: 1000, fields: ['ID', 'Note'], keyFields: ['ID'] }],
    fields: [
      { name: 'ID', table: 'T', key: true, rows: 1000, distinct: 1000 },
      { name: 'Note', table: 'T', key: false, rows: 1000, distinct: 995 },
    ],
  };
  const result = analyze(graph, { platform: 'auto' });
  const found = result.findings.filter((f) => f.ruleId === 'R020');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Note/);
});

test('R021: CONCATENATE без ключевых полей замечается', () => {
  const script = 'LOAD * FROM a.csv;\nCONCATENATE LOAD * FROM b.csv;';
  const graph = {
    script, meta: {}, sheets: [], objects: [], variables: [], bookmarks: [], fields: [],
    tables: [{ name: 'B', rows: 10, fields: ['X'], keyFields: [] }],
  };
  const result = analyze(graph, { platform: 'auto' });
  const found = result.findings.filter((f) => f.ruleId === 'R021');
  assert.ok(found.length >= 1, 'найдена таблица без ключа после CONCATENATE');
});

// --- Пункт 2 и 3: HTML-отчёт ---

test('HTML-отчёт: блок правок сворачивается', () => {
  const result = analyze(graphForModel(), { platform: 'auto' });
  const html = renderHtml({ ...result, patch: { script: 'DROP FIELD Comment;' } });
  assert.ok(html.includes('<details class="fold">'), 'правки спрятаны в сворачиваемый блок');
  assert.ok(html.includes('Показать правки'), 'есть переключатель');
  assert.ok(html.includes('DROP FIELD Comment;'), 'сама правка в отчёте есть');
});

test('HTML-отчёт: показывает ошибки скрипта с номером строки', () => {
  const graph = graphForModel();
  graph.meta = { scriptErrors: [{ message: 'Invalid object name', line: 12, column: 5 }] };
  const result = analyze(graph, { platform: 'auto' });
  const html = renderHtml(result);
  assert.ok(html.includes('Ошибки скрипта загрузки'), 'есть блок ошибок скрипта');
  assert.ok(html.includes('Invalid object name'), 'текст ошибки на месте');
  assert.ok(html.includes('строка 12'), 'указан номер строки');
});

test('HTML-отчёт: в таблице находок есть колонка «Строка»', () => {
  const result = analyze(graphForModel(), { platform: 'auto' });
  const html = renderHtml(result);
  assert.ok(html.includes('<th>Строка</th>'), 'колонка «Строка» есть');
});
