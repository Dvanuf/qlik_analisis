/**
 * Тесты этапа 0: баги и корректность.
 *
 * Проверяются: S010 (ложные срабатывания и обрезанный скрипт), R007
 * (AutoNumber со строковым литералом), дедупликация находок, подавление,
 * расчёт скора и маскирование секретов в логах.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';
import { checkScriptStructure, analyzeScriptIntegrity } from '../src/script/integrity.js';
import { dedupeFindings } from '../src/findings/dedupe.js';
import { parseIgnoreDirectives, applySuppression } from '../src/findings/suppress.js';
import { computeScore } from '../src/score.js';
import { maskSecrets, maskUrl } from '../src/logging/mask.js';
import { normalizeRuleSettings, matchesExcludedTable } from '../src/rules/settings.js';

/** Минимальный граф приложения для скриптовых проверок. */
function graphWithScript(script, extra = {}) {
  return {
    meta: { source: 'test', platform: 'any', capabilities: ['script'], skipped: [] },
    appName: 'Тестовое приложение',
    appId: 'test-app',
    script,
    sheets: [],
    objects: [],
    variables: [],
    fields: [],
    tables: [],
    bookmarks: [],
    extensions: [],
    ...extra,
  };
}

test('S010: удвоенная кавычка внутри строки не считается незакрытой', () => {
  const script = "SET name = 'O''Brien';\nLOAD * FROM [lib://Data/Clients.csv];";
  const { problems } = checkScriptStructure(script);
  assert.equal(problems.length, 0, `неожиданные проблемы: ${JSON.stringify(problems)}`);

  const result = analyze(graphWithScript(script), {});
  assert.equal(result.findings.filter((f) => f.ruleId === 'S010').length, 0);
});

test('S010: апостроф в комментарии не считается незакрытой строкой', () => {
  const script = "// Don't touch this\nLOAD * FROM data.csv;";
  const { problems } = checkScriptStructure(script);
  assert.equal(problems.length, 0);
});

test('S010: обрезанный скрипт понижает важность и помечает находку', () => {
  const script = "LOAD * FROM data.csv;\nSET a = 'незакрытая строка";
  const info = analyzeScriptIntegrity(script);
  assert.equal(info.truncated, true, 'скрипт без закрывающей кавычки считается обрезанным');

  const result = analyze(graphWithScript(script), {});
  const s010 = result.findings.filter((f) => f.ruleId === 'S010');
  assert.equal(s010.length, 1);
  assert.equal(s010[0].severity, 'warning', 'важность понижается, если скрипт прочитан не полностью');
  assert.match(s010[0].message, /возможно, скрипт получен не полностью/);
});

test('S010: целый скрипт даёт ошибку, а не предупреждение', () => {
  const script = "LOAD * FROM data.csv;\nSET a = 'строка';";
  const result = analyze(graphWithScript(script), {});
  const s010 = result.findings.filter((f) => f.ruleId === 'S010');
  assert.equal(s010.length, 0);
});

test('R007: AutoNumber формируется со строковым литералом', () => {
  const graph = graphWithScript('LOAD * FROM data.csv;', {
    fields: [{
      name: 'ID', table: 'QvdTableHeader', key: true, rows: 100, distinct: 100, nonNulls: 100,
    }],
    tables: [{ name: 'QvdTableHeader', rows: 100, fields: ['ID'], keyFields: ['ID'] }],
  });
  const result = analyze(graph, {});
  const r007 = result.findings.filter((f) => f.ruleId === 'R007');
  assert.equal(r007.length, 1);
  assert.equal(r007[0].fix.kind, 'autoNumber');
  assert.equal(r007[0].fix.payload.field, 'ID');
  assert.equal(r007[0].fix.payload.key, 'Key_QvdTableHeader');
  assert.match(result.patch.script, /AutoNumber\(ID, 'Key_QvdTableHeader'\);/);
});

test('дедупликация: одинаковые находки сворачиваются со счётчиком и списком таблиц', () => {
  const findings = [
    { ruleId: 'Q002', category: 'Quality', severity: 'error', title: 't', message: 'Нет поля', target: { kind: 'field', name: 'X' }, table: 'Sales' },
    { ruleId: 'Q002', category: 'Quality', severity: 'error', title: 't', message: 'Нет поля', target: { kind: 'field', name: 'X' }, table: 'Sales' },
    { ruleId: 'Q002', category: 'Quality', severity: 'error', title: 't', message: 'Нет поля', target: { kind: 'field', name: 'X' }, table: 'Staging' },
  ];
  const deduped = dedupeFindings(findings);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].count, 3);
  assert.deepEqual(deduped[0].tables, ['Sales', 'Staging']);
});

test('дедупликация применяется в анализаторе, сводка содержит число свёрнутых находок', () => {
  const graph = graphWithScript('LOAD * FROM data.csv;', {
    objects: [{
      id: 'o1',
      name: 'Лист1',
      type: 'chart',
      expressions: [
        { kind: 'measure', expr: 'Sum(' },
        { kind: 'measure', expr: 'Sum(' },
      ],
    }],
  });
  const result = analyze(graph, {});
  assert.ok(result.summary.findings.merged > 0, 'часть находок свёрнута');
  assert.equal(result.summary.findings.total, result.findings.length);
  const q001 = result.findings.filter((f) => f.ruleId === 'Q001');
  assert.equal(q001.length, 1);
  assert.equal(q001[0].count, 2);
});

test('подавление: директива qa-ignore скрывает находку правила', () => {
  const script = [
    '// qa-ignore S001',
    'LOAD * FROM data.csv;',
  ].join('\n');
  const directives = parseIgnoreDirectives(script);
  assert.equal(directives.length, 1);
  assert.equal(directives[0].ruleId, 'S001');

  const findings = [
    { ruleId: 'S001', message: 'без списка полей', line: 2, target: { kind: 'table', name: 'data' } },
    { ruleId: 'S002', message: 'без WHERE', line: 2, target: { kind: 'table', name: 'data' } },
  ];
  const { findings: visible, suppressed } = applySuppression(findings, { script });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].ruleId, 'S002');
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].ruleId, 'S001');
});

test('подавление: глобальное исключение по правилу и таблице', () => {
  const findings = [
    { ruleId: 'S002', message: 'без WHERE', table: 'Fields', target: { kind: 'table', name: 'Fields' } },
    { ruleId: 'S002', message: 'без WHERE', table: 'Sales', target: { kind: 'table', name: 'Sales' } },
  ];
  const { findings: visible, suppressed } = applySuppression(findings, {
    exclusions: [{ ruleId: 'S002', table: 'Fields' }],
  });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].table, 'Sales');
  assert.equal(suppressed.length, 1);
});

test('S002: служебные таблицы исключены из проверки «без WHERE»', () => {
  const script = "LOAD * FROM Fields;\nLOAD * FROM Sales;";
  const graph = graphWithScript(script);
  const result = analyze(graph, {});
  const s002 = result.findings.filter((f) => f.ruleId === 'S002');
  assert.equal(s002.length, 1, 'только Sales, Fields исключён по умолчанию');
  assert.equal(s002[0].target.name, 'Sales');
});

test('настройки правил: список исключений настраивается', () => {
  const settings = normalizeRuleSettings({ rules: { exclusions: { S002: { tables: ['Sales'] } } } });
  assert.equal(matchesExcludedTable('Sales', settings.exclusions.S002.tables), true);
  assert.equal(matchesExcludedTable('tmp_x', settings.exclusions.S002.tables), false);
  assert.equal(matchesExcludedTable('Sales', ['Other']), false);
  // По умолчанию исключаются служебные таблицы.
  const defaults = normalizeRuleSettings({});
  assert.equal(matchesExcludedTable('Fields', defaults.exclusions.S002.tables), true);
  assert.equal(matchesExcludedTable('tmp_qs_sess', defaults.exclusions.S002.tables), true);
});

test('настройки правил: важность правила переопределяется', () => {
  const graph = graphWithScript("LOAD * FROM data.csv;\nSET a = 'незакрытая");
  const result = analyze(graph, { rules: { severity: { S010: 'info' } } });
  const s010 = result.findings.filter((f) => f.ruleId === 'S010');
  assert.equal(s010[0].severity, 'info');
});

test('скор приложения: 100 при отсутствии находок и 0 при множестве ошибок', () => {
  assert.equal(computeScore({ bySeverity: { error: 0, warning: 0, info: 0 }, checks: 40 }).score, 100);
  const many = computeScore({ bySeverity: { error: 50, warning: 0, info: 0 }, checks: 40 }).score;
  assert.equal(many, 0);
  const one = computeScore({ bySeverity: { error: 1, warning: 0, info: 0 }, checks: 40 }).score;
  assert.ok(one > 90 && one < 100, `скор одной ошибки: ${one}`);
});

test('маскирование: cookie, CSRF-токен и ключи не попадают в лог', () => {
  const line = 'WS создан: wss://host/app/abc?qlik-csrf-token=SECRET123&reloadUri=x '
    + 'Cookie: X-Qlik-Session=COOKIEVALUE X-Qlik-XrfKey: XRFKEY';
  const masked = maskSecrets(line);
  assert.ok(!masked.includes('SECRET123'), 'CSRF-токен замаскирован');
  assert.ok(!masked.includes('COOKIEVALUE'), 'cookie замаскирована');
  assert.ok(!masked.includes('XRFKEY'), 'XSRF-ключ замаскирован');
});

test('маскирование: URL без секретов', () => {
  const masked = maskUrl('wss://host/app/abc?qlik-csrf-token=abc123');
  assert.ok(!masked.includes('abc123'));
});
