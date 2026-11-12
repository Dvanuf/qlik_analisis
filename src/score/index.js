/**
 * Оценка приложения, версия 2.
 *
 * Смена формулы (0.12.0): прежняя `100 − (10E+4W+1I)×10/checks` уходила
 * в минус на реальных приложениях (обрезалась до 0), а выключение правила
 * в «Правилах» парадоксально повышало балл (сокращался знаменатель).
 *
 * Правила расчёта:
 *  - считаем по находкам-паттернам, а не по местам: вес паттерна
 *    `w × (1 + log2(n))`, где n — число мест. Одно правило с 90 местами
 *    больше не обнуляет оценку;
 *  - базовые веса: ошибка 10, предупреждение 3, замечание 0,5;
 *  - потолок штрафа по важности: ошибки 40, предупреждения 30, замечания 10;
 *  - отдельный штраф за лишние данные (неиспользуемые поля и таблицы):
 *    до 20 по доле строк, которые можно убрать;
 *  - итог: 100 − сумма штрафов, не меньше 0.
 *
 * Веса и потолки настраиваются в rules.json (раздел scoring) — их значения
 * по умолчанию живут здесь (DEFAULT_SCORING) и копируются в defaultRulesConfig.
 *
 * Прогоны помечены scoreVersion = 2: баллы старой формулы (версия 1)
 * несопоставимы с новыми, тренд считается только внутри версии.
 */
import { DOMAIN_ORDER } from '../rules/domains.js';

/** Версия формулы — записывается в историю прогонов. */
export const SCORE_VERSION = 2;

/** Веса, потолки и лишние данные по умолчанию (можно переопределить в rules.json). */
export const DEFAULT_SCORING = {
  weights: { error: 10, warning: 3, info: 0.5 },
  ceilings: { error: 40, warning: 30, info: 10 },
  /** Потолок отдельного штрафа за лишние данные. */
  wastedCeiling: 20,
  /** Правила, находки которых считаются лишними данными. */
  wastedRules: ['R001', 'R003', 'R005'],
};

/** Человеческие подписи вердиктов по общему баллу. */
export const VERDICTS = [
  { min: 90, label: 'Отлично' },
  { min: 75, label: 'Хорошо' },
  { min: 50, label: 'Требует внимания' },
  { min: 0, label: 'Критично' },
];

/** Слова для карточек доменов (мягче общих вердиктов). */
export const DOMAIN_WORDS = [
  { min: 90, label: 'отлично' },
  { min: 75, label: 'хорошо' },
  { min: 50, label: 'средне' },
  { min: 0, label: 'слабо' },
];

const SEVERITIES = ['error', 'warning', 'info'];

/** Нормализует раздел scoring: нестрогие значения — к значениям по умолчанию. */
export function normalizeScoring(scoring) {
  const base = {
    weights: { ...DEFAULT_SCORING.weights },
    ceilings: { ...DEFAULT_SCORING.ceilings },
    wastedCeiling: DEFAULT_SCORING.wastedCeiling,
    wastedRules: [...DEFAULT_SCORING.wastedRules],
  };
  if (!scoring || typeof scoring !== 'object') return base;
  for (const sev of SEVERITIES) {
    const w = Number(scoring.weights?.[sev]);
    if (Number.isFinite(w) && w >= 0) base.weights[sev] = w;
    const c = Number(scoring.ceilings?.[sev]);
    if (Number.isFinite(c) && c >= 0) base.ceilings[sev] = c;
  }
  const wc = Number(scoring.wastedCeiling);
  if (Number.isFinite(wc) && wc >= 0) base.wastedCeiling = wc;
  if (Array.isArray(scoring.wastedRules)) {
    base.wastedRules = scoring.wastedRules.map((r) => String(r)).filter(Boolean);
  }
  return base;
}

function clampScore(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function verdictFor(list, score) {
  return list.find((v) => score >= v.min)?.label ?? '';
}

/**
 * Штраф по набору находок: сумма `w×(1+log2 n)` с потолком на важность.
 * @param {object[]} findings — находки-паттерны (count = число мест)
 * @param {object} scoring — нормализованные веса/потолки
 * @returns {{sums: object, penalties: object, total: number}}
 */
function severityPenalties(findings, scoring) {
  const sums = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    const sev = SEVERITIES.includes(f?.severity) ? f.severity : 'info';
    const n = Math.max(1, Number(f?.count) || 1);
    sums[sev] += scoring.weights[sev] * (1 + Math.log2(n));
  }
  const penalties = {};
  let total = 0;
  for (const sev of SEVERITIES) {
    penalties[sev] = Math.min(sums[sev], scoring.ceilings[sev]);
    total += penalties[sev];
  }
  return { sums, penalties, total };
}

/**
 * Штраф за лишние данные: доля строк, которые можно убрать,
 * умноженная на потолок. Без общего числа строк (totalRows) штраф
 * недоказуем и не начисляется — как и правила о неиспользуемых полях.
 */
function wastedPenalty(findings, scoring, totalRows) {
  if (!scoring.wastedRules.length || !(totalRows > 0)) {
    return { rows: 0, share: 0, penalty: 0 };
  }
  const rows = findings
    .filter((f) => scoring.wastedRules.includes(f?.ruleId))
    .reduce((s, f) => s + (Number(f?.impact?.rows) || 0), 0);
  const share = Math.min(1, rows / totalRows);
  return { rows, share, penalty: Math.min(scoring.wastedCeiling, share * scoring.wastedCeiling) };
}

/** Прирост балла от устранения одной находки (без пересчёта остальных). */
export function gainOf(finding, scoring, totalRows) {
  if (scoring.wastedRules.includes(finding?.ruleId) && totalRows > 0) {
    const before = wastedPenalty([finding], scoring, totalRows).penalty;
    return Math.round(before);
  }
  const sev = SEVERITIES.includes(finding?.severity) ? finding.severity : 'info';
  const n = Math.max(1, Number(finding?.count) || 1);
  const cost = scoring.weights[sev] * (1 + Math.log2(n));
  const sum = severityPenalties([finding], scoring).sums[sev];
  return Math.round(Math.min(sum, scoring.ceilings[sev]) - Math.min(sum - cost, scoring.ceilings[sev]));
}

/**
 * Оценка по находкам.
 *
 * @param {object[]} findings — находки-паттерны после дедупликации
 *   (поля: severity, count, domain, ruleId, title, fix, impact.rows)
 * @param {{scoring?: object, totalRows?: number}} [options]
 * @returns {object} балл, вердикт, домены, первоочередные исправления,
 *   прогноз и состав штрафов
 */
export function computeScore(findings, options = {}) {
  const scoring = normalizeScoring(options.scoring);
  const totalRows = Number(options.totalRows) || 0;
  const list = Array.isArray(findings) ? findings : [];

  const sev = severityPenalties(list, scoring);
  const wasted = wastedPenalty(list, scoring, totalRows);
  const penalty = sev.total + wasted.penalty;
  const score = clampScore(100 - penalty);

  // Домены — той же формулой на находках домена.
  const byDomain = {};
  for (const f of list) {
    const d = f?.domain;
    if (d) (byDomain[d] ??= []).push(f);
  }
  const domains = {};
  // Сеем ВСЕ шесть доменов: домен без находок (например, «Модель данных»,
  // когда проверки использования полей пропущены) раньше выпадал из
  // summary.domains — и интерфейс показывал «оценка недоступна» вместо
  // честного «Отлично» на чистом домене.
  for (const id of DOMAIN_ORDER) {
    domains[id] = {
      score: 100,
      verdict: verdictFor(VERDICTS, 100),
      word: verdictFor(DOMAIN_WORDS, 100),
      findings: 0,
      places: 0,
    };
  }
  for (const [id, items] of Object.entries(byDomain)) {
    const d = severityPenalties(items, scoring);
    const w = wastedPenalty(items, scoring, totalRows);
    const dscore = clampScore(100 - d.total - w.penalty);
    domains[id] = {
      score: dscore,
      verdict: verdictFor(VERDICTS, dscore),
      word: verdictFor(DOMAIN_WORDS, dscore),
      findings: items.length,
      places: items.reduce((s, f) => s + (Number(f?.count) || 1), 0),
    };
  }

  // Первоочередные исправления: прирост балла от устранения паттерна.
  const gains = list
    .map((f) => ({
      ruleId: String(f?.ruleId ?? ''),
      title: String(f?.title ?? ''),
      severity: SEVERITIES.includes(f?.severity) ? f.severity : 'info',
      domain: f?.domain ?? null,
      count: Math.max(1, Number(f?.count) || 1),
      hasFix: Boolean(f?.fix),
      gain: gainOf(f, scoring, totalRows),
      ref: f,
    }))
    .filter((t) => t.gain > 0)
    .sort((a, b) => b.gain - a.gain
      || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
      || b.count - a.count);
  const top = gains.slice(0, 5).map(({ ref, ...t }) => t);

  // Прогноз: пересчёт без первых трёх исправлений (по самим находкам).
  const topRefs = list
    .filter((f) => top.some((t) => t.ruleId === f?.ruleId && t.title === f?.title))
    .slice(0, 3);
  let forecast = null;
  if (topRefs.length) {
    const rest = list.filter((f) => !topRefs.includes(f));
    const r = severityPenalties(rest, scoring);
    const w = wastedPenalty(rest, scoring, totalRows);
    forecast = clampScore(100 - r.total - w.penalty);
  }

  return {
    score,
    scoreVersion: SCORE_VERSION,
    verdict: verdictFor(VERDICTS, score),
    formula: '100 − штрафы: ошибка 10, предупреждение 3, замечание 0,5, '
      + 'вес растёт как 1 + log2(мест), потолки 40/30/10, лишние данные до 20',
    domains,
    top,
    // Сколько всего паттернов дают прирост — для строки «Ещё N рекомендаций».
    candidates: gains.length,
    forecast,
    wasted: {
      rows: wasted.rows,
      share: Number(wasted.share.toFixed(4)),
      penalty: Math.round(wasted.penalty),
      rules: scoring.wastedRules,
    },
    details: {
      penalties: Object.fromEntries(Object.entries(sev.penalties).map(([k, v]) => [k, Math.round(v)])),
      wasted: Math.round(wasted.penalty),
      findings: list.length,
      places: list.reduce((s, f) => s + (Number(f?.count) || 1), 0),
      // Общее число строк модели — доля лишних данных считается от него.
      totalRows,
    },
  };
}

/**
 * Групповая оценка по нескольким приложениям — единый источник цифр
 * для «Сводного отчёта», экспортов и вкладки «Оценка» (этап 5).
 *
 * @param {Array<{summary?: object|null, appId: string, title?: string, stream?: string|null,
 *   owner?: string|null, tags?: string[]}>} results — результаты batch-прогона
 * @param {{history?: Array<object>, filters?: object,
 *   scoring?: object, totalRows?: number}} [options]
 * @returns {{apps: number, avg: number|null, median: number|null, zones: object,
 *   weakestDomain: string|null, scoreVersion: number|null,
 *   topIssues: Array<object>, byStream: Array<object>, wastedRating: Array<object>}}
 */
export function aggregateGroup(results, options = {}) {
  const rows = (Array.isArray(results) ? results : []).filter((r) => r?.summary?.score != null);
  const scores = rows.map((r) => Number(r.summary.score)).sort((a, b) => a - b);
  const zones = {
    critical: scores.filter((s) => s < 50).length,
    attention: scores.filter((s) => s >= 50 && s < 75).length,
    good: scores.filter((s) => s >= 75).length,
  };
  const median = scores.length
    ? (scores.length % 2
      ? scores[(scores.length - 1) / 2]
      : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)
    : null;
  const avg = scores.length
    ? scores.reduce((s, v) => s + v, 0) / scores.length
    : null;

  // Слабейший домен — по средней оценке домена среди приложений, где он есть.
  const domScores = {};
  for (const r of rows) {
    for (const [id, d] of Object.entries(r.summary.domains ?? {})) {
      (domScores[id] ??= []).push(d.score);
    }
  }
  let weakestDomain = null;
  let weakestAvg = Infinity;
  for (const [id, arr] of Object.entries(domScores)) {
    const a = arr.reduce((s, v) => s + v, 0) / arr.length;
    if (a < weakestAvg) {
      weakestAvg = a;
      weakestDomain = id;
    }
  }

  // Версия формулы: группа смешанных версий тренд не имеет.
  const versions = [...new Set(rows.map((r) => Number(r.summary.scoreVersion) || 1))];

  // Главные проблемы группы: паттерны (правило + человекочитаемый текст),
  // отсортированные по приросту средней оценки группы от их устранения.
  const issueAgg = new Map();
  for (const r of rows) {
    for (const f of r.findings ?? []) {
      const key = `${f.ruleId}|${f.title}`;
      const entry = issueAgg.get(key) ?? {
        ruleId: String(f.ruleId ?? ''),
        title: String(f.title ?? ''),
        severity: String(f.severity ?? 'info'),
        domain: f.domain ?? null,
        places: 0,
        apps: new Set(),
        gains: [],
      };
      entry.places += Math.max(1, Number(f.count) || 1);
      entry.apps.add(r.appId);
      // Прирост в этом приложении; знаменатель — все приложения группы.
      entry.gains.push(gainOf(f, normalizeScoring(options.scoring), Number(options.totalRows) || 0));
      issueAgg.set(key, entry);
    }
  }
  const topIssues = [...issueAgg.values()]
    .map((e) => ({
      ruleId: e.ruleId,
      title: e.title,
      severity: e.severity,
      domain: e.domain,
      places: e.places,
      apps: e.apps.size,
      gainAvg: Math.round(e.gains.reduce((s, v) => s + v, 0) / Math.max(1, rows.length)),
    }))
    .sort((a, b) => b.gainAvg - a.gainAvg)
    .slice(0, 8);

  // Разрез по потокам: приложения, средняя, ошибки, слабейший домен потока.
  const streamsMap = new Map();
  for (const r of rows) {
    const key = r.stream ?? '—';
    const entry = streamsMap.get(key) ?? { stream: key, apps: 0, scores: [], errors: 0, domScores: {} };
    entry.apps += 1;
    entry.scores.push(Number(r.summary.score));
    entry.errors += r.summary.findings?.bySeverity?.error ?? 0;
    for (const [id, d] of Object.entries(r.summary.domains ?? {})) {
      (entry.domScores[id] ??= []).push(d.score);
    }
    streamsMap.set(key, entry);
  }
  const byStream = [...streamsMap.values()]
    .map((e) => {
      const doms = Object.entries(e.domScores)
        .map(([id, arr]) => ({ id, avg: arr.reduce((s, v) => s + v, 0) / arr.length }))
        .sort((a, b) => a.avg - b.avg);
      return {
        stream: e.stream,
        apps: e.apps,
        avg: Math.round(e.scores.reduce((s, v) => s + v, 0) / e.scores.length),
        errors: e.errors,
        weakestDomain: doms.length ? doms[0].id : null,
      };
    })
    .sort((a, b) => a.avg - b.avg);

  // Рейтинг лишних данных: строки, которые можно убрать, по приложениям.
  const wastedRating = rows
    .map((r) => ({ appId: r.appId, title: r.title ?? r.appId, rows: r.summary.savings?.removableRows ?? 0 }))
    .filter((r) => r.rows > 0)
    .sort((a, b) => b.rows - a.rows)
    .slice(0, 5);

  return {
    apps: rows.length,
    avg: avg == null ? null : Math.round(avg),
    median: median == null ? null : Math.round(median),
    zones,
    weakestDomain,
    scoreVersion: versions.length === 1 ? versions[0] : null,
    topIssues,
    byStream,
    wastedRating,
  };
}
