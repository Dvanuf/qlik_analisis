import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';
import { parseScript } from '../src/script/parse.js';
import { analyzeScriptUsage } from '../src/script/usage.js';
import { buildScriptIndex, findingLines } from '../src/findings/locations.js';
import { groupFindings } from '../src/findings/group.js';
import { scopeForRule, SCOPES, SCOPE_LABELS } from '../src/rules/scopes.js';
import { ALL_RULES } from '../src/rules/index.js';

/**
 * Граф приложения-примера: таблица «Staging» грузится из файла и служит
 * источником для другой таблицы. Во фронт-энде её поля не встречаются —
 * ровно тот случай, из-за которого появлялась ложная находка
 * «Неиспользуемая таблица».
 */
export function graphWithStaging() {
  return {
    meta: { source: 'test', capabilities: ['script', 'objects', 'dataModel'] },
    appName: 'Пример',
    appId: 'app-1',
    script: [
      'Employee:',
      'LOAD',
      '  ID,',
      '  Name',
      "FROM 'employees.csv';",
      'Staging:',
      'LOAD',
      '  RowID,',
      '  Amount',
      "FROM 'staging.csv';",
      'Facts:',
      'RESIDENT Staging;',
      'LET vTotal = Sum([Amount]);',
    ].join('\n'),
    sheets: [{ id: 's1', name: 'Лист', type: 'sheet', description: '' }],
    objects: [{
      id: 'o1',
      name: 'chart_Sales',
      type: 'chart',
      sheetId: 's1',
      description: '',
      expressions: [{ kind: 'measure', expr: 'Count([ID])' }],
    }],
    variables: [{ name: 'vTotal', value: 'Sum([Amount])', description: '' }],
    fields: [
      { name: 'ID', table: 'Employee', key: true, rows: 10, distinct: 10 },
      { name: 'Name', table: 'Employee', key: false, rows: 10, distinct: 10 },
      { name: 'RowID', table: 'Staging', key: false, rows: 5, distinct: 5 },
      { name: 'Amount', table: 'Staging', key: false, rows: 5, distinct: 4 },
    ],
    tables: [
      { name: 'Employee', rows: 10, fields: ['ID', 'Name'], keyFields: ['ID'], synthetic: false },
      { name: 'Staging', rows: 5, fields: ['RowID', 'Amount'], keyFields: [], synthetic: false },
    ],
    bookmarks: [],
    connections: [],
    masterObjects: [],
  };
}

test('таблица — источник другой таблицы не считается неиспользуемой', () => {
  const result = analyze(graphWithStaging(), {});
  const r003 = result.findings.filter((f) => f.ruleId === 'R003');
  assert.deepEqual(r003.map((f) => f.target.name), [],
    'Staging используется в RESIDENT — её нельзя предлагать удалить');
  assert.equal(result.patch.dropTables.includes('Staging'), false);
});

test('таблица без использования — по-прежнему попадает в находки', () => {
  const graph = graphWithStaging();
  // Убираем RESIDENT, выражение по Amount и переменную: таблица остаётся «балластом».
  graph.script = graph.script
    .replace('RESIDENT Staging;', 'DROP TABLE Staging;')
    .replace('LET vTotal = Sum([Amount]);', '');
  graph.variables = [];
  const result = analyze(graph, {});
  const r003 = result.findings.filter((f) => f.ruleId === 'R003');
  assert.ok(r003.some((f) => f.target.name === 'Staging'),
    'таблица без ссылок должна попадать в R003');
});

test('поле, используемое в выражении скрипта, не считается неиспользуемым', () => {
  const graph = graphWithStaging();
  // Поле Amount используется только в скрипте — во фронт-энде его нет.
  graph.script = graph.script.replace('RESIDENT Staging;', 'LET vSum = Sum([Amount]);');
  graph.variables = [];
  const result = analyze(graph, {});
  const r001 = result.findings.filter((f) => f.ruleId === 'R001');
  assert.equal(r001.some((f) => f.target.name === 'Amount'), false,
    'Amount участвует в выражении скрипта — удалять нельзя');
  const r002 = result.findings.filter((f) => f.ruleId === 'R002');
  assert.ok(r002.some((f) => f.target.name === 'Amount'),
    'поле, используемое только в скрипте, описывается отдельной находкой');
});

test('анализ использования скрипта находит источники и поля', () => {
  const model = parseScript(graphWithStaging().script);
  const usage = analyzeScriptUsage(model, graphWithStaging());
  assert.ok(usage.tables.has('staging'), 'Staging — источник RESIDENT');
  assert.ok(usage.fields.has('amount'), 'Amount используется в выражении');
});

test('находка получает строки скрипта', () => {
  const graph = graphWithStaging();
  const result = analyze(graph, {});
  const scriptIndex = buildScriptIndex(parseScript(graph.script));

  const variable = result.findings.find((f) => f.ruleId === 'R004');
  assert.ok(variable, 'есть находка о неиспользуемой переменной');
  const { lines } = findingLines(variable, scriptIndex, graph);
  assert.ok(lines.length > 0, 'у находки есть строки скрипта');
  assert.ok(lines.every((n) => n >= 1 && n <= graph.script.split('\n').length));
});

test('строки находки перечисляются через запятую в интерфейсе', () => {
  const graph = graphWithStaging();
  const result = analyze(graph, {});
  for (const f of result.findings) {
    if (f.lines?.length) {
      const text = f.lines.join(', ');
      assert.equal(text.split(', ').length, f.lines.length);
    }
  }
});

test('однотипные находки сворачиваются в одну строку со списком', () => {
  const graph = graphWithStaging();
  graph.objects = [
    { id: 'o1', name: 'ПростоЕ', type: 'chart', sheetId: 's1', description: '', expressions: [] },
    { id: 'o2', name: 'ПростоF', type: 'chart', sheetId: 's1', description: '', expressions: [] },
    { id: 'o3', name: 'fact_Правильное', type: 'chart', sheetId: 's1', description: '', expressions: [] },
  ];
  const result = analyze(graph, {});
  const p010 = result.findings.filter((f) => f.ruleId === 'P010');
  assert.equal(p010.length, 1, 'все находки P010 — одна запись');
  assert.deepEqual(p010[0].objects, ['ПростоЕ', 'ПростоF']);
  assert.match(p010[0].message, /ПростоЕ, ПростоF/);
});

test('группировка не трогает находки других правил', () => {
  const findings = [
    { ruleId: 'P010', category: 'Practices', title: 'X', message: 'a', target: { name: 'a' } },
    { ruleId: 'P010', category: 'Practices', title: 'X', message: 'b', target: { name: 'b' } },
    { ruleId: 'Q001', category: 'Quality', title: 'Y', message: 'c', target: { name: 'c' } },
  ];
  const out = groupFindings(findings);
  assert.equal(out.length, 2);
  assert.equal(out[0].count, 2);
  assert.equal(out[1].ruleId, 'Q001');
});

test('у каждой находки есть область', () => {
  const result = analyze(graphWithStaging(), {});
  for (const f of result.findings) {
    assert.ok(SCOPES.includes(f.scope), `у находки ${f.ruleId} область ${f.scope}`);
  }
  assert.ok(result.summary.findings.byScope.script >= 0);
});

test('области правил размечены явно', () => {
  for (const rule of ALL_RULES) {
    const scope = scopeForRule(rule.id, rule.category);
    assert.ok(SCOPES.includes(scope), `у правила ${rule.id} неизвестная область ${scope}`);
    assert.ok(SCOPE_LABELS[scope], `у области ${scope} нет названия`);
  }
  assert.equal(scopeForRule('S001', 'Script'), 'script');
  assert.equal(scopeForRule('P006', 'Practices'), 'measures');
  assert.equal(scopeForRule('R008', 'Resources'), 'dashboard');
});

test('этапы анализа перечислены в известном порядке', async () => {
  const { ANALYSIS_STAGES, stageLabel } = await import('../src/extract/progress.js');
  const ids = ANALYSIS_STAGES.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 3), ['connect', 'layout', 'script']);
  assert.ok(ids.includes('rules'));
  assert.ok(ids.includes('report'));
  assert.equal(stageLabel('dataModel'), 'Таблицы и поля');
  assert.equal(stageLabel('unknown'), 'unknown');
});
