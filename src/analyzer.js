/**
 * Ядро анализа: граф -> индекс -> правила -> сводка + патч скрипта.
 */
import { buildIndex } from './graph.js';
import { runRules, CATEGORIES, SEVERITIES } from './rules/index.js';
import { parseScript } from './script/parse.js';

/**
 * @param {object} graph — результат экстрактора
 * @param {object} config — настройки правил
 */
export function analyze(graph, config = {}) {
  const scriptModel = parseScript(graph.script ?? '');
  const index = buildIndex(graph, scriptModel);
  const { findings, ruleStats, errors } = runRules(graph, index, config, scriptModel);

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  // Оценка «веса» неиспользуемых полей: сумма строк по удаляемым полям.
  const removable = findings.filter((f) => f.fix?.kind === 'dropField' && f.impact?.rows != null);
  const removableRows = removable.reduce((acc, f) => acc + (f.impact.rows ?? 0), 0);

  const summary = {
    appName: graph.appName || '(без названия)',
    appId: graph.appId || '',
    source: graph.meta?.source ?? 'unknown',
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
    },
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
    ruleStats,
    errors,
    summary,
    patch: buildScriptPatch(findings),
  };
}

/**
 * Формирует предложения по правке скрипта загрузки на основе находок.
 * @param {object[]} findings
 */
export function buildScriptPatch(findings) {
  const dropFields = new Set();
  const dropTables = new Set();
  const autoNumbers = new Set();

  for (const f of findings) {
    if (!f.fix) continue;
    if (f.fix.kind === 'dropField') dropFields.add(f.fix.payload);
    if (f.fix.kind === 'dropTable') dropTables.add(f.fix.payload);
    if (f.fix.kind === 'autoNumber') autoNumbers.add(f.fix.payload);
  }

  const lines = [];
  if (dropFields.size) {
    lines.push(`DROP FIELD ${[...dropFields].map((f) => (/\s/.test(f) ? `[${f}]` : f)).join(', ')};`);
  }
  if (dropTables.size) {
    lines.push(`DROP TABLE ${[...dropTables].map((t) => (/\s/.test(t) ? `[${t}]` : t)).join(', ')};`);
  }
  if (autoNumbers.size) {
    lines.push(`AutoNumber(${[...autoNumbers].map((f) => (/\s/.test(f) ? `[${f}]` : f)).join(', ')});`);
  }

  return {
    dropFields: [...dropFields],
    dropTables: [...dropTables],
    autoNumbers: [...autoNumbers],
    script: lines.join('\n'),
  };
}
