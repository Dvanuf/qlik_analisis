/**
 * Агрегация результатов анализа в компактную сводку для модели.
 *
 * Наружу уходит не сырой результат анализа (там скрипт, граф и все находки),
 * а сводка: счётчики по критичности и доменам, топ правил, конкретные находки
 * с объектами и строками, динамика по прогонам и отклонения от базовой линии.
 * Это одновременно экономит квоту и уменьшает объём данных, покидающих машину.
 *
 * Если сводка не помещается в лимит символов, она ужимается: сначала
 * сокращается список прогонов, затем топ правил, затем число конкретных
 * находок, затем обрезается текст. Факт обрезки возвращается флагом truncated —
 * о нём сообщается в интерфейсе.
 */

/** Сколько правил показывать в топе. */
const TOP_RULES = 8;
/** Сколько прогонов оставлять в динамике после обрезки. */
const KEEP_RUNS = 5;
/** Сколько конкретных находок показывать. */
const MAX_CONCRETE = 12;
/** Предел размера сводки по умолчанию. */
export const DEFAULT_MAX_CHARS = 12000;

/**
 * Счётчики находок по критичности в порядке убывания важности.
 * @param {object} bySeverity
 * @returns {Array<{severity: string, count: number}>}
 */
function severityRows(bySeverity = {}) {
  const order = ['error', 'warning', 'info'];
  return order
    .map((severity) => ({ severity, count: Number(bySeverity?.[severity] ?? 0) }))
    .filter((r) => r.count > 0);
}

/**
 * Топ правил по числу срабатываний.
 * @param {Array<object>} findings
 * @param {number} [limit]
 * @returns {Array<{ruleId: string, title: string, severity: string, count: number}>}
 */
function topRules(findings = [], limit = TOP_RULES) {
  const map = new Map();
  for (const f of findings) {
    const id = f.ruleId ?? '?';
    const entry = map.get(id) ?? {
      ruleId: id,
      title: f.title ?? '',
      severity: f.severity ?? 'info',
      count: 0,
    };
    entry.count += f.count ?? 1;
    map.set(id, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Разбирает вопрос на значимые слова — по ним оценивается релевантность находок.
 * @param {string} question
 * @returns {string[]}
 */
function questionTokens(question) {
  return String(question ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/**
 * Текст находки, по которому ищем совпадения с вопросом.
 * @param {object} f
 * @returns {string}
 */
function findingHaystack(f) {
  return [
    f.ruleId ?? '',
    f.title ?? '',
    f.message ?? '',
    f.recommendation ?? '',
    f.category ?? '',
    f.domain ?? '',
    f.target?.name ?? '',
    f.table ?? '',
    ...(f.tables ?? []),
  ].join(' ').toLowerCase();
}

/**
 * Оценка релевантности находки вопросу: сколько значимых слов вопроса
 * встречается в находке.
 * @param {object} f
 * @param {string[]} tokens
 * @returns {number}
 */
function relevance(f, tokens) {
  if (!tokens.length) return 0;
  const hay = findingHaystack(f);
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) score += 1;
  }
  return score;
}

/**
 * Конкретные находки: правило, объект, строка и рекомендация.
 *
 * Без этого блока модель видит только счётчики и не может сказать, что именно
 * чинить. Порядок — сначала релевантные вопросу, затем по критичности.
 *
 * @param {Array<object>} findings
 * @param {string} [question]
 * @param {number} [limit]
 * @returns {Array<object>}
 */
function concreteFindings(findings = [], question = '', limit = MAX_CONCRETE) {
  const tokens = questionTokens(question);
  const severityWeight = { error: 0, warning: 1, info: 2 };
  const ranked = findings
    .map((f) => ({ f, rel: relevance(f, tokens) }))
    .sort((a, b) => {
      if (b.rel !== a.rel) return b.rel - a.rel;
      const sa = severityWeight[a.f.severity] ?? 3;
      const sb = severityWeight[b.f.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      return (b.f.count ?? 1) - (a.f.count ?? 1);
    })
    .map(({ f }) => ({
      ruleId: f.ruleId ?? '?',
      severity: f.severity ?? 'info',
      title: f.title ?? '',
      target: f.target?.name ?? '',
      table: f.table ?? (f.tables?.length ? f.tables.join(', ') : ''),
      line: f.line ?? null,
      message: f.message ?? '',
      recommendation: f.recommendation ?? '',
      count: f.count ?? 1,
    }));
  return ranked.slice(0, limit);
}

/**
 * Находка, о которой спросил пользователь, — приводится к виду сводки.
 *
 * Раньше фокус читался в интерфейсе, но в промпт не попадал: модель отвечала
 * по общей сводке, не видя самой находки.
 *
 * @param {object|null} focus
 * @returns {object|null}
 */
function focusDetail(focus) {
  if (!focus || !focus.ruleId) return null;
  return {
    ruleId: focus.ruleId ?? '?',
    severity: focus.severity ?? 'info',
    title: focus.title ?? '',
    target: focus.target ?? '',
    line: focus.line ?? null,
    message: focus.message ?? '',
    recommendation: focus.recommendation ?? '',
  };
}

/**
 * Динамика по прогонам: скор и число находок по датам.
 * @param {Array<object>} runs — прогоны из истории (listRuns)
 * @returns {Array<object>}
 */
function dynamics(runs = []) {
  return runs.slice(0, KEEP_RUNS).map((r) => ({
    at: r.at,
    score: r.score,
    errors: r.errors,
    warnings: r.warnings,
    total: r.total,
  }));
}

/**
 * Собирает сводку по приложению.
 *
 * @param {object} input
 * @param {object} [input.analysis] — результат analyze() из src/analyzer.js
 * @param {Array<object>} [input.runs] — прогоны из истории (listRuns)
 * @param {object|null} [input.comparison] — сравнение с базовой линией
 * @param {object} [input.app] — {id, title, platform}
 * @param {string} [input.question] — вопрос пользователя: по нему ранжируются находки
 * @param {object|null} [input.focus] — находка, о которой спросили
 * @param {number} [maxChars] — предел размера сводки
 * @returns {{text: string, truncated: boolean, data: object}}
 */
export function buildSummary(input = {}) {
  const {
    analysis, runs = [], comparison = null, app = {}, question = '', focus = null,
  } = input;
  const maxChars = Number(input.maxChars ?? DEFAULT_MAX_CHARS);

  const summary = analysis?.summary ?? {};
  const findings = analysis?.findings ?? [];
  const bySeverity = summary?.findings?.bySeverity ?? {};
  const byCategory = summary?.findings?.byCategory ?? {};
  const byDomain = summary?.findings?.byDomain ?? {};

  const data = {
    app: {
      title: app.title ?? app.name ?? '',
      // Владелец — часть метаданных: модели полезно знать, чьё это приложение.
      // Во внешний API уходит обезличенный вид (Владелец_1).
      owner: app.owner ?? '',
      platform: app.platform ?? '',
      score: summary?.score ?? null,
    },
    totals: {
      findings: summary?.findings?.total ?? findings.length,
      errors: bySeverity.error ?? 0,
      warnings: bySeverity.warning ?? 0,
      infos: bySeverity.info ?? 0,
      suppressed: summary?.findings?.suppressed ?? 0,
    },
    byCategory,
    byDomain: Object.fromEntries(
      Object.entries(byDomain).map(([id, d]) => [id, {
        findings: d.findings ?? 0,
        failed: d.failed ?? 0,
        passed: d.passed ?? 0,
      }]),
    ),
    topRules: topRules(findings),
    // Конкретные находки: правило, объект, строка, рекомендация. Без них
    // модель видит только счётчики и не может сказать, что именно чинить.
    concrete: concreteFindings(findings, question),
    // Находка, о которой спросил пользователь, — её детали идут в сводку
    // отдельным блоком.
    focus: focusDetail(focus),
    savings: {
      removableFields: summary?.savings?.removableFields ?? 0,
      removableRows: summary?.savings?.removableRows ?? 0,
    },
    dynamics: dynamics(runs),
    deviations: deviations(comparison),
  };

  let text = formatSummary(data);
  let truncated = false;

  if (text.length > maxChars) {
    truncated = true;
    // Сначала сокращаем историю прогонов, затем топ правил, затем находки.
    data.dynamics = data.dynamics.slice(0, 2);
    text = formatSummary(data);
    if (text.length > maxChars) {
      data.topRules = data.topRules.slice(0, 3);
      text = formatSummary(data);
    }
    if (text.length > maxChars) {
      data.concrete = data.concrete.slice(0, 4);
      text = formatSummary(data);
    }
    if (text.length > maxChars) {
      text = `${text.slice(0, Math.max(0, maxChars - 40))}\n… (сводка обрезана до ${maxChars} символов)`;
    }
  }

  return { text, truncated, data };
}

/**
 * Строка конкретной находки: правило, место и что делать.
 * @param {object} f
 * @returns {string}
 */
function findingLine(f) {
  const parts = [`${f.ruleId} [${f.severity}]`];
  if (f.title) parts.push(f.title);
  const place = [];
  if (f.target) place.push(f.target);
  if (f.table) place.push(`таблица ${f.table}`);
  if (f.line) place.push(`строка ${f.line}`);
  if (place.length) parts.push(`— ${place.join(', ')}`);
  if (f.count > 1) parts.push(`(мест: ${f.count})`);
  if (f.message) parts.push(`: ${trim(f.message, 160)}`);
  if (f.recommendation) parts.push(`Рекомендация: ${trim(f.recommendation, 160)}`);
  return parts.join(' ');
}

/**
 * Форматирует сводку в текст для модели.
 * @param {object} data
 * @returns {string}
 */
export function formatSummary(data) {
  const lines = [];
  const t = data.totals;

  lines.push('Приложение:');
  if (data.app.title) lines.push(`- название: ${data.app.title}`);
  if (data.app.owner) lines.push(`- владелец: ${data.app.owner}`);
  if (data.app.platform) lines.push(`- платформа: ${data.app.platform}`);
  lines.push(`- оценка качества (скор 0–100): ${data.app.score ?? 'н/д'}`);

  lines.push('');
  lines.push('Находки:');
  lines.push(`- всего: ${t.findings} (ошибок: ${t.errors}, предупреждений: ${t.warnings}, замечаний: ${t.infos})`);
  if (t.suppressed) lines.push(`- подавлено правилами конфигурации: ${t.suppressed}`);
  for (const [name, count] of Object.entries(data.byCategory ?? {})) {
    lines.push(`- категория «${name}»: ${count}`);
  }
  for (const [id, d] of Object.entries(data.byDomain ?? {})) {
    if (!d.findings && !d.failed) continue;
    lines.push(`- домен ${id}: находок ${d.findings}, нарушено правил ${d.failed}, пройдено ${d.passed}`);
  }

  if (data.focus) {
    lines.push('');
    lines.push('О чём конкретно спросили (находка, выбранная пользователем):');
    lines.push(`- ${findingLine(data.focus)}`);
  }

  if (data.concrete?.length) {
    lines.push('');
    lines.push('Конкретные находки (правило, объект, строка, рекомендация):');
    for (const f of data.concrete) {
      lines.push(`- ${findingLine(f)}`);
    }
  }

  if (data.topRules?.length) {
    lines.push('');
    lines.push('Топ правил по числу срабатываний:');
    for (const r of data.topRules) {
      lines.push(`- ${r.ruleId} (${r.severity}), срабатываний: ${r.count}${r.title ? ` — ${r.title}` : ''}`);
    }
  }

  if (data.savings?.removableRows || data.savings?.removableFields) {
    lines.push('');
    lines.push('Потенциал упрощения:');
    lines.push(`- можно удалить полей: ${data.savings.removableFields}`);
    lines.push(`- это примерно строк данных: ${data.savings.removableRows}`);
  }

  if (data.dynamics?.length) {
    lines.push('');
    lines.push('Динамика по прогонам (свежие сверху):');
    for (const d of data.dynamics) {
      lines.push(`- ${d.at}: скор ${d.score}, находок ${d.total} (ошибок ${d.errors}, предупреждений ${d.warnings})`);
    }
  }

  const dev = data.deviations ?? {};
  if (dev.added?.length || dev.fixed?.length) {
    lines.push('');
    lines.push('Отклонения от базовой линии:');
    if (dev.added?.length) {
      lines.push('- появились:');
      for (const f of dev.added) {
        lines.push(`  · ${f.ruleId}${f.target ? ` — ${f.target}` : ''}${f.line ? ` (строка ${f.line})` : ''}`);
      }
    }
    if (dev.fixed?.length) {
      lines.push('- исправлены:');
      for (const f of dev.fixed) {
        lines.push(`  · ${f.ruleId}${f.target ? ` — ${f.target}` : ''}`);
      }
    }
  }

  return lines.join('\n');
}

function trim(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/**
 * Отклонения от базовой линии: что появилось и что исправлено.
 * @param {object|null} comparison — результат compareRuns
 * @returns {{added: Array<object>, fixed: Array<object>}}
 */
function deviations(comparison) {
  const brief = (f) => ({
    ruleId: f.ruleId,
    title: f.title ?? '',
    target: f.target?.name ?? f.object ?? '',
    line: f.line ?? null,
  });
  return {
    added: (comparison?.added ?? []).slice(0, 5).map(brief),
    fixed: (comparison?.fixed ?? []).slice(0, 5).map(brief),
  };
}
