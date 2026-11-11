/**
 * Ядро анализа: граф -> индекс -> правила -> сводка + патч скрипта.
 */
import { buildIndex } from './graph.js';
import { runRules, CATEGORIES, SEVERITIES } from './rules/index.js';
import { PLATFORM_ANY, PLATFORM_AUTO } from './rules/platforms.js';
import { parseScript } from './script/parse.js';
import { buildOutline } from './script/outline.js';
import { buildLineage } from './script/lineage.js';
import { dedupeFindings, dedupeStats } from './findings/dedupe.js';
import { applySuppression } from './findings/suppress.js';
import { computeScore } from './score/index.js';
import { buildDataModelSheets } from './report/data-model.js';
import { buildDataSchema } from './report/data-schema.js';
import { buildScriptIndex, findingLines } from './findings/locations.js';
import { groupFindings } from './findings/group.js';
import { groupPatternsByRule } from './findings/patterns.js';
import { DOMAIN_ORDER, DOMAIN_LABELS, domainForRule } from './rules/domains.js';
import { buildScriptPatch } from './script/refactor.js';

// Патч скрипта теперь собирается в src/script/refactor.js (единый источник правок);
// экспорт сохранён для прежних потребителей (отчёты, тесты).
export { buildScriptPatch };
import { SCOPES, SCOPE_LABELS } from './rules/scopes.js';

/**
 * @param {object} graph — результат экстрактора
 * @param {object} config — настройки правил
 */
export function analyze(graph, config = {}) {
  const scriptModel = parseScript(graph.script ?? '');
  const lineage = buildLineage(scriptModel);
  const index = buildIndex(graph, scriptModel);
  // Outline скрипта: разделы, шаги таблиц, поток построения, недостижимый код.
  const outline = buildOutline(scriptModel);
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

  // Однотипные находки (например, «Несогласованное именование» по каждому
  // объекту) сворачиваются в одну строку со списком объектов.
  const grouped = groupFindings(deduped);

  // Подавление: комментарии `// qa-ignore` в скрипте и глобальные исключения.
  const { findings, suppressed } = applySuppression(grouped, {
    script: graph.script,
    exclusions: config.suppressExclusions ?? config.rules?.suppress ?? [],
    appName: graph.appName,
    appId: graph.appId,
  });

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const byScope = Object.fromEntries(SCOPES.map((sc) => [sc, 0]));
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byScope[f.scope ?? 'dashboard'] = (byScope[f.scope ?? 'dashboard'] ?? 0) + 1;
  }

  // Строки скрипта для каждой находки: по ним интерфейс показывает место
  // проблемы и подсвечивает все найденные строки сразу.
  const scriptIndex = buildScriptIndex(
    scriptModel,
    String(graph.script ?? '').split(/\r?\n/),
  );
  const withLines = (list) => list.map((f) => {
    const { lines, total } = findingLines(f, scriptIndex, graph);
    const base = lines.length ? { ...f, lines, linesTotal: total } : f;
    // Лист, на котором живёт объект находки: в панели паттерна видно,
    // ГДЕ именно проблема (данные листов отдаёт Doc API и извлечение листов).
    const kind = base.target?.kind;
    if (['object', 'expression', 'measure', 'dimension', 'sheet'].includes(kind)) {
      const obj = (graph.objects ?? []).find((o) => (base.target?.id && o.id === base.target?.id)
        || (!base.target?.id && base.target?.name && String(o.name ?? '') === String(base.target.name)));
      const sheetId = obj?.sheetId;
      const sheet = sheetId ? (graph.sheets ?? []).find((sh) => sh.id === sheetId)?.name : '';
      if (sheet) return { ...base, sheet };
    }
    return base;
  });
  const locatedFindings = withLines(findings);
  const locatedSuppressed = withLines(suppressed);

  // Сводка по доменам: сколько проверок в каждом домене, сколько нарушено
  // и сколько мест найдено. Домен — то, что пользователь видит в интерфейсе.
  const byDomain = {};
  for (const domain of DOMAIN_ORDER) {
    byDomain[domain] = {
      id: domain,
      label: DOMAIN_LABELS[domain],
      total: 0,
      failed: 0,
      skipped: 0,
      passed: 0,
      findings: 0,
      places: 0,
    };
  }
  for (const stat of ruleStats) {
    const domain = stat.domain ?? domainForRule(stat.id, stat.category);
    const bucket = byDomain[domain];
    if (!bucket) continue;
    bucket.total += 1;
    if (stat.skipped) bucket.skipped += 1;
    else if (stat.count > 0) bucket.failed += 1;
    else bucket.passed += 1;
  }
  for (const f of findings) {
    const bucket = byDomain[f.domain];
    if (!bucket) continue;
    bucket.findings += 1;
    bucket.places += f.count ?? 1;
  }

  // Паттерны: корень проблемы — одна строка, места перечислены внутри.
  const patternGroups = groupPatternsByRule(locatedFindings);

  // Оценка «веса» неиспользуемых полей: сумма строк по удаляемым полям.
  const removable = findings.filter((f) => f.fix?.kind === 'dropField' && f.impact?.rows != null);
  const removableRows = removable.reduce((acc, f) => acc + (f.impact.rows ?? 0), 0);

  // Скор v2: считается по находкам-паттернам (вес растёт медленно с числом
  // мест), с потолками по важности и отдельным штрафом за лишние данные.
  // Доля лишнего считается от всех строк модели — она приходит из графа.
  const totalRows = (graph.tables ?? []).reduce((s, t) => s + (Number(t.rows) || 0), 0);
  const score = computeScore(locatedFindings, {
    scoring: config.scoring,
    totalRows,
  });

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
      masterObjects: (graph.masterObjects ?? []).length,
      connections: (graph.connections ?? []).length,
      expressions: (graph.objects ?? []).reduce((n, o) => n + (o.expressions?.length ?? 0), 0),
      scriptLoads: scriptModel.loads.length,
      scriptVariables: scriptModel.variables.length,
      scriptComments: scriptModel.comments.length,
    },
    // Полнота сбора метаданных: сколько объектов перечислил сервер
    // и сколько удалось получить. Позволяет заметить, что фронт-энд виден не весь.
    inventory: graph.meta?.inventory ?? null,
    // Структура скрипта: разделы, шаги, поток построения, недостижимый код.
    outline: {
      sections: outline.sections.length,
      steps: outline.steps.length,
      unreachable: outline.unreachable.length,
      // Полная структура — для отчёта и HTTP-ответа.
      full: {
        sections: outline.sections,
        steps: outline.steps,
        residentFlow: outline.residentFlow,
        unreachable: outline.unreachable,
      },
    },
    findings: {
      total: locatedFindings.length,
      byCategory,
      bySeverity,
      byScope,
      // Сводка по доменам — как в интерфейсе.
      byDomain,
      // Сколько одинаковых находок свёрнуто и сколько подавлено.
      merged: dedupe.merged,
      suppressed: suppressed.length,
    },
    score: score.score,
    // Версия формулы: тренд в истории считается только между прогонами
    // одной версии (v2 — расчёт по паттернам с потолками).
    scoreVersion: score.scoreVersion,
    verdict: score.verdict,
    // Домены, топ-исправления, прогноз — на верхнем уровне: их читают
    // вкладки «Оценка» и «Сводный отчёт» (scoreDetails — для формулы).
    domains: score.domains,
    top: score.top,
    candidates: score.candidates,
    forecast: score.forecast,
    wasted: score.wasted,
    scoreDetails: score,
    savings: {
      removableFields: removable.length,
      removableRows,
      note: 'Оценка в строках данных; точный расход памяти доступен только из отчёта движка.',
    },
    capabilities: graph.meta?.capabilities ?? [],
    skipped: graph.meta?.skipped ?? [],
    // Диагностика раскрытия включений (пути подключений QRS и т.д.).
    includeNotes: graph.meta?.includeNotes ?? [],
    // Ошибки скрипта по данным сервера — с номером строки и колонки.
    scriptErrors: graph.meta?.scriptErrors ?? [],
    ruleErrors: errors,
  };

  return {
    graph,
    index,
    findings: locatedFindings,
    suppressed: locatedSuppressed,
    // Паттерны: корень проблемы — одна строка, места внутри.
    patterns: patternGroups.patterns,
    patternRules: patternGroups.rules,
    patternPlaces: patternGroups.places,
    byDomain,
    ruleStats,
    errors,
    summary,
    outline,
    lineage,
    patch: buildScriptPatch(findings),
    // Модель данных и метаданные — листами книги Excel (QSME: Data model).
    dataModel: buildDataModelSheets(graph),
    // Схема модели данных («снежинка») с пометками проблем по таблицам/полям.
    schema: buildDataSchema(graph, locatedFindings, lineage, ruleStats),
    // Перечень выражений — для поиска «где используется это выражение».
    expressionIndex: buildExpressionIndex(graph),
  };
}

/**
 * Плоский перечень выражений приложения.
 *
 * Нужен для поиска в интерфейсе: пользователь ищет формулу и видит,
 * в каких объектах она встречается.
 *
 * @param {object} graph
 * @returns {Array<{name: string, type: string, kind: string, expr: string}>}
 */
export function buildExpressionIndex(graph) {
  const out = [];
  for (const obj of graph?.objects ?? []) {
    for (const e of obj.expressions ?? []) {
      const expr = String(e.expr ?? '').trim();
      if (!expr) continue;
      out.push({
        name: String(obj.name ?? obj.id ?? ''),
        type: String(obj.type ?? ''),
        kind: String(e.kind ?? ''),
        expr,
      });
    }
  }
  return out;
}
