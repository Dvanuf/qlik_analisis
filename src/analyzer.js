/**
 * Ядро анализа: граф -> индекс -> правила -> сводка + патч скрипта.
 */
import { buildIndex } from './graph.js';
import { runRules, CATEGORIES, SEVERITIES } from './rules/index.js';
import { PLATFORM_ANY, PLATFORM_AUTO } from './rules/platforms.js';
import { parseScript } from './script/parse.js';
import { dedupeFindings, dedupeStats } from './findings/dedupe.js';
import { applySuppression } from './findings/suppress.js';
import { computeScore } from './score.js';

/**
 * @param {object} graph — результат экстрактора
 * @param {object} config — настройки правил
 */
export function analyze(graph, config = {}) {
  const scriptModel = parseScript(graph.script ?? '');
  const index = buildIndex(graph, scriptModel);
  // Платформа: явный выбор пользователя важнее; 'auto' — определить по данным
  // сервера (экстрактор выводит её из набора типов объектов). Если данных нет —
  // платформа не определена, и правила проверяются по мере достаточности.
  const requested = config.platform ?? PLATFORM_AUTO;
  const platform = requested === PLATFORM_AUTO
    ? (graph.meta?.platform ?? PLATFORM_ANY)
    : requested;
  const { findings: rawFindings, ruleStats, errors } = runRules(graph, index, { ...config, platform }, scriptModel);

  // Одинаковые находки («правило + объект + текст») сворачиваются в одну запись.
  const deduped = config.dedupe === false ? rawFindings : dedupeFindings(rawFindings);
  const dedupe = dedupeStats(rawFindings, deduped);

  // Подавление: комментарии `// qa-ignore` в скрипте и глобальные исключения.
  const { findings, suppressed } = applySuppression(deduped, {
    script: graph.script,
    exclusions: config.suppressExclusions ?? config.rules?.suppress ?? [],
    appName: graph.appName,
    appId: graph.appId,
  });

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  // Оценка «веса» неиспользуемых полей: сумма строк по удаляемым полям.
  const removable = findings.filter((f) => f.fix?.kind === 'dropField' && f.impact?.rows != null);
  const removableRows = removable.reduce((acc, f) => acc + (f.impact.rows ?? 0), 0);

  // Скор 0–100: чем больше находок на выполненную проверку, тем ниже скор.
  const checks = ruleStats.filter((s) => !s.skipped).length;
  const score = computeScore({ bySeverity, checks });

  const summary = {
    appName: graph.appName || '(без названия)',
    appId: graph.appId || '',
    source: graph.meta?.source ?? 'unknown',
    platform,
    generatedAt: graph.meta?.generatedAt ?? new Date().toISOString(),
    counts: {
      sheets: (graph.sheets ?? []).length,
      objects: (graph.objects ?? []).length,
      variables: (graph.variables ?? []).length,
      fields: (graph.fields ?? []).length,
      tables: (graph.tables ?? []).length,
      bookmarks: (graph.bookmarks ?? []).length,
      expressions: (graph.objects ?? []).reduce((n, o) => n + (o.expressions?.length ?? 0), 0),
      scriptLoads: scriptModel.loads.length,
      scriptVariables: scriptModel.variables.length,
      scriptComments: scriptModel.comments.length,
    },
    findings: {
      total: findings.length,
      byCategory,
      bySeverity,
      // Сколько одинаковых находок свёрнуто и сколько подавлено.
      merged: dedupe.merged,
      suppressed: suppressed.length,
    },
    score: score.score,
    scoreDetails: score,
    savings: {
      removableFields: removable.length,
      removableRows,
      note: 'Оценка в строках данных; точный расход памяти доступен только из отчёта движка.',
    },
    capabilities: graph.meta?.capabilities ?? [],
    skipped: graph.meta?.skipped ?? [],
    ruleErrors: errors,
  };

  return {
    graph,
    index,
    findings,
    suppressed,
    ruleStats,
    errors,
    summary,
    patch: buildScriptPatch(findings),
  };
}

/** Имя поля в скрипте: с пробелами — в квадратных скобках. */
function ident(name) {
  const value = String(name ?? '');
  return /\s/.test(value) ? `[${value}]` : value;
}

/**
 * Формирует предложения по правке скрипта загрузки на основе находок.
 * @param {object[]} findings
 */
export function buildScriptPatch(findings) {
  const dropFields = new Set();
  const dropTables = new Set();
  // поле -> имя нового ключевого поля
  const autoNumbers = new Map();

  for (const f of findings) {
    if (!f.fix) continue;
    if (f.fix.kind === 'dropField') dropFields.add(f.fix.payload);
    if (f.fix.kind === 'dropTable') dropTables.add(f.fix.payload);
    if (f.fix.kind === 'autoNumber') {
      const payload = f.fix.payload;
      const field = typeof payload === 'string' ? payload : payload?.field;
      const key = typeof payload === 'string' ? `Key_${payload}` : payload?.key;
      if (field) autoNumbers.set(field, key || `Key_${field}`);
    }
  }

  const lines = [];
  if (dropFields.size) {
    lines.push(`DROP FIELD ${[...dropFields].map(ident).join(', ')};`);
  }
  if (dropTables.size) {
    lines.push(`DROP TABLE ${[...dropTables].map(ident).join(', ')};`);
  }
  if (autoNumbers.size) {
    // Второй аргумент AutoNumber — имя нового поля, обязательно строковый литерал:
    // AutoNumber(ID, 'Key_QvdTableHeader');
    const pairs = [...autoNumbers.entries()].map(([field, key]) => `${ident(field)}, '${key}'`);
    lines.push(`AutoNumber(${pairs.join(', ')});`);
  }

  return {
    dropFields: [...dropFields],
    dropTables: [...dropTables],
    autoNumbers: [...autoNumbers.entries()].map(([field, key]) => ({ field, key })),
    script: lines.join('\n'),
  };
}
