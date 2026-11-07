/**
 * Согласованность цифр между представлениями.
 *
 * Регрессия этапа 0 (0.12.0): пользователь видел на «Анализе» одни числа
 * (ошибки, находки), а в «Сводном отчёте» — другие. Причины: кэш пакетного
 * прогона не учитывал версию правил, saveRun читал важности не из того
 * места истории, подавления при пакетном прогоне не работали. Эти тесты
 * держат представления согласованными.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAll, totalsOf, settingsHash } from '../src/batch.js';
import { analyze } from '../src/analyzer.js';
import { openHistory, saveRun, listRuns } from '../src/history.js';

/** Фикстура приложения: находки с местами, чтобы видеть разницу находки/места. */
const FINDINGS = [
  { ruleId: 'R001', category: 'Resources', severity: 'warning', message: 'поле A', target: { name: 'A' }, count: 5 },
  { ruleId: 'R001', category: 'Resources', severity: 'warning', message: 'поле B', target: { name: 'B' }, count: 1 },
  { ruleId: 'P005', category: 'Practices', severity: 'error', message: 'ошибка', target: { name: 'X' }, count: 1 },
  { ruleId: 'S010', category: 'Script', severity: 'info', message: 'стиль', target: { name: 'Y' }, count: 1 },
];

function appResult(overrides = {}) {
  const findings = overrides.findings ?? FINDINGS;
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;
  return {
    appId: overrides.appId ?? 'app-1',
    title: overrides.title ?? 'Приложение',
    summary: {
      appName: overrides.title ?? 'Приложение',
      findings: { total: findings.length, bySeverity, byCategory: {}, merged: 1 },
      score: 88,
    },
    findings,
    ...(overrides.rest ?? {}),
  };
}

test('batch: кэш невалиден при смене настроек правил', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Хеш стабильный и чувствительный к настройкам.
  assert.notEqual(
    settingsHash({ rules: { disabled: [] } }),
    settingsHash({ rules: { disabled: ['S010'] } }),
    'разные настройки дали одинаковый хеш',
  );
  assert.equal(settingsHash({ a: 1, b: 2 }), settingsHash({ b: 2, a: 1 }), 'хеш зависит от порядка ключей');
  assert.equal(settingsHash(undefined), settingsHash({}), 'пустые настройки стабильны');

  const app = { id: 'app-1', title: 'Приложение', size: 10, lastReload: '2026-11-01T00:00:00Z' };
  const fake = {
    // Формат Doc API, который ждёт listApps.
    getDocList: async () => [{
      qDocId: app.id, qTitle: app.title, qFileSize: app.size, qLastReloadTime: app.lastReload,
    }],
    openDoc: async () => { throw new Error('openDoc не должен вызываться при валидном кэше'); },
  };
  const entry = {
    appId: app.id, title: app.title, lastReload: app.lastReload,
    settingsHash: settingsHash({ rules: { disabled: [] } }),
    summary: { appName: app.title, findings: { total: 0, bySeverity: {} } },
    findings: [], at: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'app-1.json'), JSON.stringify(entry));

  // Тот же settingsHash — кэш валиден, движок не открывается (openDoc кинул бы).
  const fresh = await analyzeAll({
    qix: fake, session: { close: async () => {} },
    url: 'wss://host/app/app-1', appIds: [app.id], pauseMs: 0, cacheDir: dir,
    rules: { rules: { disabled: [] } },
  });
  assert.equal(fresh.results[0].fromCache, true, 'валидный кэш не использован');

  // Другие настройки (подпись другая) — кэш игнорируется, движок открывается
  // и (заглушка кидает) приложение уходит в error — значит переанализ шёл.
  const stale = await analyzeAll({
    qix: fake, session: { close: async () => {} },
    url: 'wss://host/app/app-1', appIds: [app.id], pauseMs: 0, cacheDir: dir,
    rules: { rules: { disabled: ['S010'] } },
  });
  assert.ok(stale.results[0].error, 'кэш с другой подписью настроек должен переанализироваться');
});

test('batch: totals согласованы со строками результатов', () => {
  const results = [appResult({ appId: '1' }), appResult({ appId: '2', title: 'Второе' })];
  const totals = totalsOf(results);
  const sumTotal = results.reduce((s, r) => s + r.summary.findings.total, 0);
  assert.equal(totals.findings, sumTotal, 'totals.findings != сумме findings.total по приложениям');
  const sumErr = results.reduce((s, r) => s + r.summary.findings.bySeverity.error, 0);
  assert.equal(totals.bySeverity.error, sumErr, 'totals.bySeverity.error != сумме ошибок по приложениям');
});

test('история: saveRun берёт важности из summary.findings.bySeverity', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hist-'));
  const db = await openHistory(join(dir, 'h.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const summary = {
    appName: 'Приложение',
    findings: { total: 4, bySeverity: { error: 1, warning: 2, info: 1 } },
    score: 88,
    scoreVersion: 2,
  };
  const runId = saveRun(db, { appId: 'app-1', score: 88, summary, findings: FINDINGS });
  const [run] = listRuns(db, { appId: 'app-1', limit: 1 });
  assert.equal(run.id, runId);
  // Регрессия: раньше читался summary.bySeverity — в истории были всегда нули.
  assert.equal(run.errors, 1, 'ошибки в истории должны браться из findings.bySeverity');
  assert.equal(run.warnings, 2);
  assert.equal(run.infos, 1);
  assert.equal(run.total, 4);
  assert.equal(run.scoreVersion, 2, 'версия скора сохраняется');
});

test('история: миграция проставляет score_version=1 старым базам', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hist-mig-'));
  const file = join(dir, 'old.sqlite');
  // База старого вида — без score_version.
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, app_name TEXT,
      at TEXT NOT NULL, rules_version TEXT, score INTEGER,
      errors INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, infos INTEGER DEFAULT 0, total INTEGER DEFAULT 0
    );
    CREATE TABLE findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, rule_id TEXT,
      category TEXT, severity TEXT, object TEXT, table_name TEXT, line INTEGER, message TEXT
    );
  `);
  old.prepare("INSERT INTO runs (app_id, at, score) VALUES ('old', '2026-01-01', 55)").run();
  old.close();

  const db = await openHistory(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const runs = listRuns(db, {});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scoreVersion, 1, 'старый прогон считается версией 1');
  // Новый прогон в той же базе получает версию 2.
  saveRun(db, { appId: 'new', score: 90, summary: { findings: { total: 0, bySeverity: {} }, scoreVersion: 2 }, findings: [] });
  const after = listRuns(db, {});
  assert.equal(after[0].scoreVersion, 2);
  assert.equal(after[1].scoreVersion, 1);
});

test('score v2: домены, топ и прогноз доходят до summary анализа', () => {
  const graph = {
    appName: 'Тест', appId: 't-score', platform: 'qlik-sense',
    script: 'Sales:\nLOAD ID, Amount, Tmp FROM [data.qvd] (qvd);\n',
    tables: [{ name: 'Sales', rows: 1000 }],
    fields: [
      { name: 'ID', table: 'Sales', rows: 1000 },
      { name: 'Amount', table: 'Sales', rows: 1000 },
      { name: 'Tmp', table: 'Sales', rows: 1000 },
    ],
    objects: [
      { id: 'o1', name: 'KPI', type: 'kpi', expressions: [{ kind: 'measure', expr: 'Sum(Amount)' }] },
    ],
    variables: [], sheets: [], bookmarks: [], connections: [], masterObjects: [], stories: [],
  };
  const { summary } = analyze(graph, {});
  // Регрессия 0.15.2: домены и топ жили только внутри scoreDetails, вкладка
  // «Оценка» получала пустоту.
  assert.ok(Object.keys(summary.domains ?? {}).length > 0, 'summary.domains пуст');
  assert.ok((summary.top ?? []).length > 0, 'summary.top пуст');
  assert.ok(summary.forecast != null, 'summary.forecast отсутствует');
  assert.equal(summary.scoreVersion, 2);
});
