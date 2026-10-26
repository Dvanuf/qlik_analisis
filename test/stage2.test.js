/**
 * Тесты этапа 2: вкладка «Анализ».
 *
 * Проверяются: карточки метрик и скор, предлагаемые правки в виде
 * «было / стало», применение правок к копии скрипта, файл конфигурации
 * правил и применение настроек (отключение правила, важность, подавление).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/analyzer.js';
import { buildFixes, applyPatchToScript } from '../src/report/fixes.js';
import { readRulesConfig, writeRulesConfig, sanitizeRulesConfig, defaultRulesConfig } from '../src/rules/config.js';

const SCRIPT = [
  '// Загрузка клиентов',
  'Customers:',
  'LOAD *',
  "FROM 'clients.csv';",
  '',
].join('\n');

function graphWithFixes() {
  return {
    meta: { source: 'test', platform: 'any', capabilities: ['script'], skipped: [] },
    appName: 'Тест',
    appId: 'test',
    script: SCRIPT,
    sheets: [],
    objects: [],
    variables: [],
    fields: [
      { name: 'ID', table: 'Customers', key: true, rows: 100, distinct: 100, nonNulls: 100 },
      // Поле без значений — срабатывает R005 и даёт правку DROP FIELD.
      { name: 'Comment', table: 'Customers', key: false, rows: 100, distinct: 0, nonNulls: 0 },
    ],
    tables: [{ name: 'Customers', rows: 100, fields: ['ID', 'Comment'], keyFields: ['ID'] }],
    bookmarks: [],
    extensions: [],
  };
}

test('предлагаемые правки: AutoNumber показывается как «было / стало»', () => {
  const result = analyze(graphWithFixes(), {});
  const fixes = buildFixes(result.findings, SCRIPT);
  const auto = fixes.find((f) => f.kind === 'autoNumber');
  assert.ok(auto, 'правка AutoNumber найдена');
  assert.match(auto.after, /AutoNumber\(ID, 'Key_Customers'\);/);
  assert.ok(auto.before.includes('LOAD'), 'до показана строка загрузки');
  assert.ok(auto.after.startsWith(auto.before), 'после включает прежние строки');
});

test('предлагаемые правки: DROP FIELD добавляется в конец скрипта', () => {
  const result = analyze(graphWithFixes(), {});
  const fixes = buildFixes(result.findings, SCRIPT);
  const drop = fixes.find((f) => f.kind === 'dropField');
  assert.ok(drop, 'правка DROP FIELD найдена');
  assert.match(drop.after, /DROP FIELD Comment;/);
});

test('применение правок к копии скрипта не меняет исходный текст', () => {
  const result = analyze(graphWithFixes(), {});
  const modified = applyPatchToScript(SCRIPT, result.patch);
  assert.ok(modified.startsWith(SCRIPT.trimEnd()), 'исходный скрипт сохранён в начале');
  assert.match(modified, /DROP FIELD Comment;/);
  assert.match(modified, /AutoNumber\(ID, 'Key_Customers'\);/);
  assert.ok(!SCRIPT.includes('DROP FIELD'), 'исходный скрипт не изменён');
});

test('файл конфигурации правил: запись и чтение', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-rules-'));
  const path = join(dir, 'rules.json');
  const config = defaultRulesConfig();
  config.rules.disabled = ['R013'];
  config.rules.severity.S010 = 'warning';
  writeRulesConfig(path, config);
  const read = readRulesConfig(path);
  assert.deepEqual(read.rules.disabled, ['R013']);
  assert.equal(read.rules.severity.S010, 'warning');
});

test('файл конфигурации правил: битый файл не ломает запуск', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-rules-bad-'));
  const path = join(dir, 'rules.json');
  // Заведомо неверный JSON.
  writeFileSync(path, '{ это не json', 'utf8');
  const read = readRulesConfig(path);
  assert.deepEqual(read.rules.disabled, []);
});

test('конфигурация правил: неизвестные правила и значения отбрасываются', () => {
  const clean = sanitizeRulesConfig({
    rules: {
      disabled: ['S001', 'ZZZ9'],
      severity: { S010: 'warning', Q001: 'critical' },
      suppress: [{ ruleId: 's002', table: 'Staging' }, { ruleId: '' }],
    },
  }, ['S001', 'S002', 'S010', 'Q001']);
  assert.deepEqual(clean.rules.disabled, ['S001']);
  assert.equal(clean.rules.severity.S010, 'warning');
  assert.equal(clean.rules.severity.Q001, undefined, 'неверная важность отброшена');
  assert.equal(clean.rules.suppress.length, 1);
  assert.equal(clean.rules.suppress[0].ruleId, 'S002');
});

test('настройки правил применяются к анализу: отключение и важность', () => {
  const graph = graphWithFixes();
  const withRules = analyze(graph, {
    rules: { disabled: ['R007'], severity: { S001: 'error' } },
  });
  assert.equal(withRules.findings.filter((f) => f.ruleId === 'R007').length, 0);
  const s001 = withRules.findings.filter((f) => f.ruleId === 'S001');
  assert.equal(s001[0].severity, 'error');
});

test('настройки правил применяются к анализу: глобальное подавление', () => {
  const graph = graphWithFixes();
  const result = analyze(graph, {
    rules: { suppress: [{ ruleId: 'S001', table: 'Customers' }] },
  });
  assert.equal(result.findings.filter((f) => f.ruleId === 'S001').length, 0);
  assert.equal(result.suppressed.filter((f) => f.ruleId === 'S001').length, 1);
});

test('скор приложения попадает в сводку', () => {
  const result = analyze(graphWithFixes(), {});
  assert.equal(typeof result.summary.score, 'number');
  assert.ok(result.summary.score >= 0 && result.summary.score <= 100);
  assert.ok(result.summary.scoreDetails.formula.includes('100'));
});
