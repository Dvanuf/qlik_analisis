/**
 * Тесты этапа 4: сводный отчёт и история.
 *
 * Проверяются: тепловая карта «приложения × категории», топ-10 правил,
 * сводные колонки, выгрузка в CSV и Excel, история в SQLite и сравнение
 * прогонов с базовой линией.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { buildHeatmap, topRules, summaryRows } from '../src/report/heatmap.js';
import { toFlatRows, renderCsv, FINDINGS_COLUMNS } from '../src/report/csv.js';
import { buildXlsx, columnName } from '../src/report/xlsx.js';
import { openHistory, saveRun, listRuns, compareRuns, latestRunForApp } from '../src/history.js';

const RESULTS = [
  {
    appId: 'app-1',
    title: 'Продажи',
    owner: 'Иванова',
    stream: 'Retail',
    lastReload: '2026-10-20T10:00:00Z',
    summary: {
      score: 72,
      findings: {
        total: 5,
        byCategory: { Quality: 1, Resources: 2, Practices: 1, Script: 1 },
        bySeverity: { error: 1, warning: 2, info: 2 },
      },
    },
    findings: [
      { ruleId: 'S001', category: 'Script', severity: 'warning', message: 'без списка полей', target: { name: 'Sales' }, count: 3 },
      { ruleId: 'R001', category: 'Resources', severity: 'warning', message: 'не используется', target: { name: 'Comment' } },
    ],
  },
  {
    appId: 'app-2',
    title: 'Склад',
    owner: null,
    stream: null,
    summary: {
      score: 95,
      findings: {
        total: 1,
        byCategory: { Quality: 0, Resources: 0, Practices: 0, Script: 1 },
        bySeverity: { error: 0, warning: 0, info: 1 },
      },
    },
    findings: [
      { ruleId: 'S001', category: 'Script', severity: 'info', message: 'без списка полей', target: { name: 'Stock' } },
    ],
  },
];

test('тепловая карта: ячейки по категориям и сортировка по сумме', () => {
  const heat = buildHeatmap(RESULTS);
  assert.equal(heat.apps.length, 2);
  assert.equal(heat.apps[0].appId, 'app-1', 'приложение с большим числом находок идёт первым');
  assert.equal(heat.apps[0].cells.Resources, 2);
  assert.equal(heat.apps[0].total, 5);
  assert.equal(heat.max, 2);
  assert.deepEqual(heat.categories, ['Quality', 'Resources', 'Practices', 'Script']);
});

test('топ правил: считаются повторы и число приложений', () => {
  const top = topRules(RESULTS, 10);
  assert.equal(top[0].ruleId, 'S001');
  assert.equal(top[0].count, 4, 'три повтора в первом приложении и одна находка во втором');
  assert.equal(top[0].apps, 2);
});

test('сводные строки: скор, важности, владелец, поток и дата', () => {
  const rows = summaryRows(RESULTS);
  assert.equal(rows[0].score, 72);
  assert.equal(rows[0].errors, 1);
  assert.equal(rows[0].warnings, 2);
  assert.equal(rows[0].owner, 'Иванова');
  assert.equal(rows[0].stream, 'Retail');
  assert.equal(rows[0].changedAt, '2026-10-20T10:00:00Z');
  assert.equal(rows[1].owner, null);
});

test('CSV: плоская таблица с заголовками и экранированием', () => {
  const rows = toFlatRows(RESULTS[0].findings, {
    runAt: '2026-10-23T12:00:00Z', app: 'Продажи', stream: 'Retail', owner: 'Иванова',
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ruleId, 'S001');
  assert.equal(rows[0].severity, 'Предупреждение');
  assert.equal(rows[0].app, 'Продажи');

  const csv = renderCsv(rows);
  assert.ok(csv.startsWith('﻿'), 'есть BOM — русский Excel открывает файл');
  assert.ok(csv.includes('Дата запуска;Приложение;Поток;Владелец;Правило'));
  assert.ok(csv.includes('S001;Script;Предупреждение'));

  // Кавычки и переводы строк экранируются.
  const tricky = renderCsv(toFlatRows([{ ruleId: 'X', message: 'кавычка " и ; точка' }], {}));
  assert.ok(tricky.includes('"кавычка "" и ; точка"'));
});

test('Excel: книга .xlsx — корректный zip с листом', () => {
  const buf = buildXlsx(['Правило', 'Текст'], [['S001', 'без списка полей']]);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'сигнатура zip');
  const zip = new AdmZip(buf);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('xl/worksheets/sheet1.xml'), 'есть лист');
  assert.ok(names.includes('[Content_Types].xml'), 'есть типы содержимого');
  const sheet = zip.getEntry('xl/worksheets/sheet1.xml').getData().toString('utf8');
  assert.ok(sheet.includes('Правило'));
  assert.ok(sheet.includes('S001'));
});

test('Excel: имена колонок идут A, B, …, Z, AA', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(27), 'AB');
});

test('история: прогон сохраняется и читается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-history-'));
  const db = await openHistory(join(dir, 'history.sqlite'));
  try {
    const runId = saveRun(db, {
      appId: 'app-1',
      appName: 'Продажи',
      at: '2026-10-23T12:00:00Z',
      score: 72,
      summary: { total: 2, bySeverity: { error: 1, warning: 1, info: 0 } },
      findings: [
        { ruleId: 'S001', category: 'Script', severity: 'warning', message: 'без списка полей', target: { name: 'Sales' } },
        { ruleId: 'R001', category: 'Resources', severity: 'error', message: 'не используется', target: { name: 'Comment' } },
      ],
    });
    assert.ok(runId > 0);
    const runs = listRuns(db, { appId: 'app-1' });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].score, 72);
    assert.equal(runs[0].total, 2);
    assert.equal(latestRunForApp(db, 'app-1').id, runId);
  } finally {
    db.close();
  }
});

test('история: сравнение с базовой линией — новые, исправленные и без изменений', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-history-cmp-'));
  const db = await openHistory(join(dir, 'history.sqlite'));
  try {
    const base = saveRun(db, {
      appId: 'app-1',
      appName: 'Продажи',
      score: 80,
      summary: { total: 2, bySeverity: { error: 1, warning: 1, info: 0 } },
      findings: [
        { ruleId: 'S001', category: 'Script', severity: 'warning', message: 'без списка полей', target: { name: 'Sales' } },
        { ruleId: 'R001', category: 'Resources', severity: 'error', message: 'не используется', target: { name: 'Comment' } },
      ],
    });
    const current = saveRun(db, {
      appId: 'app-1',
      appName: 'Продажи',
      score: 90,
      summary: { total: 2, bySeverity: { error: 0, warning: 2, info: 0 } },
      findings: [
        { ruleId: 'S001', category: 'Script', severity: 'warning', message: 'без списка полей', target: { name: 'Sales' } },
        { ruleId: 'S002', category: 'Script', severity: 'warning', message: 'без WHERE', target: { name: 'Sales' } },
      ],
    });

    const cmp = compareRuns(db, base, current);
    assert.equal(cmp.counts.added, 1, 'появилась новая находка S002');
    assert.equal(cmp.counts.fixed, 1, 'R001 исчезла');
    assert.equal(cmp.counts.unchanged, 1, 'S001 осталась');
    assert.equal(cmp.added[0].ruleId, 'S002');
    assert.equal(cmp.fixed[0].ruleId, 'R001');
  } finally {
    db.close();
  }
});

test('колонки плоской таблицы совпадают с планом', () => {
  assert.deepEqual(FINDINGS_COLUMNS.map((c) => c.title), [
    'Дата запуска', 'Приложение', 'Поток', 'Владелец', 'Правило',
    'Категория', 'Важность', 'Объект', 'Таблица', 'Строка', 'Текст',
  ]);
});
