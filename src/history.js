/**
 * История анализов в локальной базе SQLite.
 *
 * Хранит прогоны (приложение, дата, версия правил, скор) и находки каждого
 * прогона. По истории считается сравнение с базовой линией: какие находки
 * появились, какие исправлены, какие остались без изменений.
 *
 * Модуль `node:sqlite` есть в Node 22+ и в Electron 45; в более старых
 * версиях Node база недоступна — вызывающий код получает понятную ошибку.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Версия набора правил — попадает в историю, чтобы сравнивать прогоны честно. */
export const RULES_VERSION = '0.5.0';

let sqliteModule = null;

/** Ленивая загрузка node:sqlite: на старых Node импорт не должен ронять приложение. */
async function loadSqlite() {
  if (sqliteModule !== null) return sqliteModule;
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    sqliteModule = false;
  }
  return sqliteModule;
}

/**
 * Открывает (или создаёт) базу истории.
 * @param {string} dbPath — путь к файлу .sqlite
 * @returns {Promise<{close: () => void, prepare: (sql: string) => any, exec: (sql: string) => void}>}
 */
export async function openHistory(dbPath) {
  const sqlite = await loadSqlite();
  if (!sqlite) {
    throw new Error('История анализов недоступна: в этой сборке Node нет модуля node:sqlite (нужен Node 22+).');
  }
  const full = resolve(dbPath);
  if (!existsSync(dirname(full))) mkdirSync(dirname(full), { recursive: true });
  const db = new sqlite.DatabaseSync(full);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      app_name TEXT,
      at TEXT NOT NULL,
      rules_version TEXT,
      score INTEGER,
      errors INTEGER DEFAULT 0,
      warnings INTEGER DEFAULT 0,
      infos INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      rule_id TEXT,
      category TEXT,
      severity TEXT,
      object TEXT,
      table_name TEXT,
      line INTEGER,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app_id);
  `);
  return db;
}

/**
 * Сохраняет прогон анализа и его находки.
 * @param {object} db — соединение с базой
 * @param {object} run — {appId, appName, at, rulesVersion, score, summary, findings}
 * @returns {number} идентификатор прогона
 */
export function saveRun(db, run) {
  const summary = run.summary ?? {};
  const bySeverity = summary.bySeverity ?? {};
  const at = run.at ?? new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO runs (app_id, app_name, at, rules_version, score, errors, warnings, infos, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(run.appId ?? ''),
    String(run.appName ?? ''),
    at,
    String(run.rulesVersion ?? RULES_VERSION),
    Number(run.score ?? 0),
    Number(bySeverity.error ?? 0),
    Number(bySeverity.warning ?? 0),
    Number(bySeverity.info ?? 0),
    Number(summary.total ?? (run.findings ?? []).length),
  );
  const runId = Number(info.lastInsertRowid);

  const insert = db.prepare(`
    INSERT INTO findings (run_id, rule_id, category, severity, object, table_name, line, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of run.findings ?? []) {
    insert.run(
      runId,
      String(f.ruleId ?? ''),
      String(f.category ?? ''),
      String(f.severity ?? ''),
      String(f.target?.name ?? ''),
      String(f.table ?? ''),
      f.line == null ? null : Number(f.line),
      String(f.message ?? ''),
    );
  }
  return runId;
}

/**
 * Список прогонов (новые сверху).
 * @param {object} db
 * @param {{appId?: string, limit?: number}} [options]
 */
export function listRuns(db, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 50));
  const rows = options.appId
    ? db.prepare('SELECT * FROM runs WHERE app_id = ? ORDER BY id DESC LIMIT ?').all(String(options.appId), limit)
    : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    appId: r.app_id,
    appName: r.app_name,
    at: r.at,
    rulesVersion: r.rules_version,
    score: Number(r.score ?? 0),
    errors: Number(r.errors ?? 0),
    warnings: Number(r.warnings ?? 0),
    infos: Number(r.infos ?? 0),
    total: Number(r.total ?? 0),
  }));
}

/** Находки прогона. */
export function getFindings(db, runId) {
  const rows = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(Number(runId));
  return rows.map((r) => ({
    ruleId: r.rule_id,
    category: r.category,
    severity: r.severity,
    object: r.object,
    table: r.table_name,
    line: r.line == null ? null : Number(r.line),
    message: r.message,
  }));
}

/** Ключ находки для сравнения прогонов. */
export function findingKey(finding) {
  return [
    finding.ruleId ?? '',
    finding.object ?? finding.target?.name ?? '',
    finding.message ?? '',
  ].join('|');
}

/**
 * Сравнение двух прогонов: новые, исправленные и без изменений.
 * @param {object} db
 * @param {number} baselineId — базовая линия
 * @param {number} currentId — текущий прогон
 */
export function compareRuns(db, baselineId, currentId) {
  const baseline = getFindings(db, baselineId);
  const current = getFindings(db, currentId);
  const baseMap = new Map(baseline.map((f) => [findingKey(f), f]));
  const curMap = new Map(current.map((f) => [findingKey(f), f]));

  const added = current.filter((f) => !baseMap.has(findingKey(f)));
  const fixed = baseline.filter((f) => !curMap.has(findingKey(f)));
  const unchanged = current.filter((f) => baseMap.has(findingKey(f)));

  return {
    baselineId: Number(baselineId),
    currentId: Number(currentId),
    added,
    fixed,
    unchanged,
    counts: { added: added.length, fixed: fixed.length, unchanged: unchanged.length },
  };
}

/** Последний прогон по приложению (для режима «только новые находки»). */
export function latestRunForApp(db, appId) {
  const rows = listRuns(db, { appId, limit: 1 });
  return rows[0] ?? null;
}
