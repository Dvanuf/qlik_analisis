/**
 * Тесты этапа 3: редактор правил.
 *
 * Проверяются: отключение правила, переопределение важности, пороги
 * (R009, R012), настраиваемый список исключений S002, экспорт и импорт
 * файла настроек.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/analyzer.js';
import { readRulesConfig, writeRulesConfig, sanitizeRulesConfig } from '../src/rules/config.js';
import { RULES_BY_ID } from '../src/rules/index.js';

function graph() {
  return {
    meta: { source: 'test', platform: 'any', capabilities: ['script'], skipped: [] },
    appName: 'Тест',
    appId: 'test',
    script: "LOAD * FROM 'clients.csv';\n",
    sheets: [],
    objects: [],
    variables: [],
    fields: [
      // Поле-константа: одно уникальное значение.
      { name: 'Region', table: 'Clients', key: false, rows: 100, distinct: 1, nonNulls: 100 },
      // Плотное числовое поле: 100 строк, 90 уникальных значений.
      { name: 'Amount', table: 'Clients', key: false, rows: 100, distinct: 90, nonNulls: 100, tags: ['$numeric'] },
    ],
    tables: [{ name: 'Clients', rows: 100, fields: ['Region', 'Amount'], keyFields: [] }],
    bookmarks: [],
    extensions: [],
  };
}

test('редактор правил: правило можно отключить', () => {
  const result = analyze(graph(), { rules: { disabled: ['R009'] } });
  assert.equal(result.findings.filter((f) => f.ruleId === 'R009').length, 0);
  assert.equal(result.ruleStats.find((s) => s.id === 'R009').skipped, true);
});

test('редактор правил: важность правила переопределяется', () => {
  const result = analyze(graph(), { rules: { severity: { R009: 'error' } } });
  const r009 = result.findings.filter((f) => f.ruleId === 'R009');
  assert.equal(r009.length, 1);
  assert.equal(r009[0].severity, 'error');
});

test('редактор правил: порог R009 (поле-константа) настраивается', () => {
  // По умолчанию поле-константа — одно уникальное значение.
  const byDefault = analyze(graph(), {});
  assert.equal(byDefault.findings.filter((f) => f.ruleId === 'R009').length, 1);

  // Порог 0 — константой не считается ни одно поле.
  const strict = analyze(graph(), { rules: { thresholds: { R009: { maxDistinct: 0 } } } });
  assert.equal(strict.findings.filter((f) => f.ruleId === 'R009').length, 0);

  // Порог 2 — константой считается и поле с двумя уникальными значениями.
  const twoValues = {
    ...graph(),
    fields: [
      { name: 'Region', table: 'Clients', key: false, rows: 100, distinct: 2, nonNulls: 100 },
    ],
  };
  const relaxed = analyze(twoValues, { rules: { thresholds: { R009: { maxDistinct: 2 } } } });
  assert.equal(relaxed.findings.filter((f) => f.ruleId === 'R009').length, 1);
});

test('редактор правил: порог R012 (плотное числовое поле) настраивается', () => {
  // По умолчанию нужно 1000 строк — поля на 100 строк не попадают.
  const byDefault = analyze(graph(), {});
  assert.equal(byDefault.findings.filter((f) => f.ruleId === 'R012').length, 0);

  // С порогом 50 строк — попадает.
  const relaxed = analyze(graph(), { rules: { thresholds: { R012: { minRows: 50 } } } });
  assert.equal(relaxed.findings.filter((f) => f.ruleId === 'R012').length, 1);
});

test('снижение шума: R013 — самый низкий уровень и его можно отключить', () => {
  assert.equal(RULES_BY_ID.get('R013').severity, 'info');
  const result = analyze(graph(), { rules: { disabled: ['R013'] } });
  assert.equal(result.ruleStats.find((s) => s.id === 'R013').skipped, true);
});

test('снижение шума: S002 не срабатывает на служебные таблицы', () => {
  const service = {
    ...graph(),
    script: "LOAD * FROM Fields;\nLOAD * FROM Sales;\n",
  };
  const result = analyze(service, {});
  const s002 = result.findings.filter((f) => f.ruleId === 'S002');
  assert.equal(s002.length, 1);
  assert.equal(s002[0].target.name, 'Sales');
});

test('снижение шума: список исключений S002 настраивается', () => {
  const service = {
    ...graph(),
    script: "LOAD * FROM Fields;\nLOAD * FROM Sales;\n",
  };
  const result = analyze(service, { rules: { exclusions: { S002: { tables: ['Sales'] } } } });
  const s002 = result.findings.filter((f) => f.ruleId === 'S002');
  assert.equal(s002.length, 1);
  assert.equal(s002[0].target.name, 'Fields');
});

test('настройки правил: экспорт и импорт файла сохраняют значения', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-rules-io-'));
  const path = join(dir, 'rules.json');
  const config = {
    rules: {
      disabled: ['R013'],
      severity: { S010: 'warning' },
      thresholds: { R012: { minRows: 5000 } },
      exclusions: { S002: { tables: ['Fields', 'Info'] } },
      suppress: [{ ruleId: 'S001', table: 'Staging' }],
    },
  };
  writeRulesConfig(path, config);

  // Экспорт: копия файла читается как есть.
  const exported = join(dir, 'exported.json');
  writeFileSync(exported, readFileSync(path, 'utf8'), 'utf8');

  // Импорт: значения сохраняются после нормализации.
  const imported = sanitizeRulesConfig(JSON.parse(readFileSync(exported, 'utf8')), [
    'R013', 'S010', 'S001', 'S002', 'R012',
  ]);
  assert.deepEqual(imported.rules.disabled, ['R013']);
  assert.equal(imported.rules.severity.S010, 'warning');
  assert.equal(imported.rules.thresholds.R012.minRows, 5000);
  assert.deepEqual(imported.rules.exclusions.S002.tables, ['Fields', 'Info']);
  assert.equal(imported.rules.suppress[0].ruleId, 'S001');

  // И записанный файл читается без потерь.
  const read = readRulesConfig(path);
  assert.equal(read.rules.thresholds.R012.minRows, 5000);
});
