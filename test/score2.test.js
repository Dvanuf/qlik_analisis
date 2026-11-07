/**
 * Оценка v2: эталонные кейсы из ТЗ (0.12.0).
 *
 * Формула по паттернам с потолками проверяется на калибровочных примерах:
 * пустое приложение → 100, одно правило со многими местами не утоплено,
 * монотонность, лишние данные, домены и первоочередной список.
 * Калибровка «checker 3/25/94 → 45–65» из ТЗ с этими весами даёт 30 —
 * см. тест «профиль checker»: вопрос калибровки вынесен на стоп-точку,
 * веса настраиваются в rules.json без правки кода.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, aggregateGroup, normalizeScoring, SCORE_VERSION } from '../src/score/index.js';

/** Паттерн-заготовка. */
const f = (ruleId, severity, count = 1, extra = {}) => ({
  ruleId, severity, count, domain: 'model', title: ruleId, ...extra,
});

test('пустое приложение — 100, «Отлично»', () => {
  const s = computeScore([]);
  assert.equal(s.score, 100);
  assert.equal(s.verdict, 'Отлично');
  assert.equal(s.scoreVersion, SCORE_VERSION);
});

test('лог-вес: одно правило со 100 местами не уходит ниже 60', () => {
  // 100 мест одного предупреждения: 3 × (1 + log2 100) ≈ 3 × 7.64 ≈ 22.9 —
  // с потолком 30 это штраф 22.9 → балл 77.
  const s = computeScore([f('R001', 'warning', 100)]);
  assert.ok(s.score >= 60, `скор 100 мест одного правила: ${s.score}`);
  // 100 предупреждений по одному месту: сумма 300 → потолок 30 → 70.
  const many = computeScore(Array.from({ length: 100 }, (_, i) => f(`R${i}`, 'warning', 1)));
  assert.ok(many.score >= 60, `скор 100 правил по месту: ${many.score}`);
});

test('профиль checker 3/25/94 (одно место) — фиксированное значение', () => {
  const findings = [
    ...Array.from({ length: 3 }, (_, i) => f(`E${i}`, 'error', 1)),
    ...Array.from({ length: 25 }, (_, i) => f(`W${i}`, 'warning', 1)),
    ...Array.from({ length: 94 }, (_, i) => f(`I${i}`, 'info', 1)),
  ];
  const s = computeScore(findings);
  // Штраф: 30 (ошибки) + 30 (потолок предупреждений) + 10 (потолок замечаний) = 70.
  assert.equal(s.score, 30);
  assert.equal(s.verdict, 'Критично');
  // Калибровка в зону 45–65 из ТЗ достигается настройкой weights/ceilings:
  const tuned = computeScore(findings, {
    scoring: { weights: { error: 10, warning: 3, info: 0.5 }, ceilings: { error: 25, warning: 18, info: 5 } },
  });
  assert.ok(tuned.score >= 45 && tuned.score <= 65, `калиброванный скор: ${tuned.score}`);
});

test('монотонность: устранение находки не снижает оценку', () => {
  const base = [f('R001', 'warning', 5), f('R002', 'error', 2), f('R003', 'info', 10)];
  const full = computeScore(base).score;
  for (let i = 0; i < base.length; i += 1) {
    const partial = computeScore(base.filter((_, j) => j !== i)).score;
    assert.ok(partial >= full, `устранение ${base[i].ruleId} снизило оценку: ${partial} < ${full}`);
  }
});

test('лишние данные: штраф до 20 по доле строк, R003 включается', () => {
  // 1000 строк в модели, 500 убираемых — половина → штраф 10.
  const s = computeScore([f('R001', 'warning', 5, { impact: { rows: 500 } })], { totalRows: 1000 });
  assert.equal(s.wasted.rows, 500);
  assert.equal(s.wasted.penalty, 10);
  // warning 3×(1+log2 5) ≈ 9.97 + штраф 10 → балл ≈ 80.
  assert.ok(s.score >= 79 && s.score <= 81, `скор с лишними данными: ${s.score}`);
  // Доля 1.0 → потолок 20.
  const max = computeScore([f('R003', 'warning', 1, { impact: { rows: 5000 } })], { totalRows: 5000 });
  assert.equal(max.wasted.penalty, 20);
  // Без totalRows штраф недоказуем — не начисляется.
  const none = computeScore([f('R001', 'warning', 5, { impact: { rows: 500 } })]);
  assert.equal(none.wasted.penalty, 0);
});

test('домены: оценка считается той же формулой на находках домена', () => {
  const s = computeScore([
    f('R001', 'error', 1, { domain: 'model' }),
    f('P001', 'info', 1, { domain: 'expr' }),
  ]);
  assert.equal(s.domains.model.score, 90);
  // Замечание 0.5: 100 − 0.5 = 99.5 → округляется до 100.
  assert.equal(s.domains.expr.score, 100);
  assert.ok(s.domains.model.word && s.domains.model.verdict);
});

test('первоочередные исправления: сортировка по приросту, прогноз после топ-3', () => {
  const findings = [
    f('R010', 'error', 1, { domain: 'expr', title: 'Ошибка А' }),   // gain 10
    f('R011', 'error', 1, { domain: 'model', title: 'Ошибка Б' }),  // gain 10
    f('R012', 'error', 1, { domain: 'model', title: 'Ошибка В' }),  // gain 10
    f('R013', 'error', 1, { domain: 'model', title: 'Ошибка Г' }),  // gain 10 — за пределами топ-3? потолок ошибок 40: сумма 40, потолок 40
    f('R014', 'warning', 1, { domain: 'dash', title: 'Предупр. Д' }), // gain 3
  ];
  const s = computeScore(findings);
  assert.ok(s.top.length >= 3, 'топ собран');
  // Прогноз существует и не хуже текущего балла.
  assert.ok(s.forecast != null && s.forecast >= s.score, `прогноз ${s.forecast} < скор ${s.score}`);
  // Приросты не отрицательные и отсортированы по убыванию.
  for (let i = 1; i < s.top.length; i += 1) {
    assert.ok(s.top[i - 1].gain >= s.top[i].gain, 'топ не отсортирован по приросту');
  }
});

test('normalizeScoring: нестрогие значения падают к дефолту', () => {
  const n = normalizeScoring({ weights: { error: 'abc', warning: -5 }, ceilings: { error: 999 } });
  assert.equal(n.weights.error, 10);
  assert.equal(n.weights.warning, 3);
  assert.equal(n.ceilings.error, 999, 'числовой потолок принимается');
  assert.equal(n.wastedCeiling, 20);
});

test('aggregateGroup: средняя, медиана, зоны, слабейший домен', () => {
  const app = (id, score, domains) => ({
    appId: id,
    summary: { score, scoreVersion: 2, domains },
  });
  const results = [
    app('a', 40, { model: { score: 30 }, expr: { score: 35 } }),
    app('b', 55, { model: { score: 60 }, expr: { score: 50 } }),
    app('c', 62, { model: { score: 65 }, expr: { score: 60 } }),
    app('d', 80, { model: { score: 85 }, expr: { score: 70 } }),
    app('e', 93, { model: { score: 95 }, expr: { score: 90 } }),
  ];
  const g = aggregateGroup(results);
  assert.equal(g.apps, 5);
  assert.equal(g.avg, 66);
  assert.equal(g.median, 62);
  assert.deepEqual(g.zones, { critical: 1, attention: 2, good: 2 });
  assert.equal(g.weakestDomain, 'expr');
  assert.equal(g.scoreVersion, 2);

  // Пустая группа — нули и null, без падений.
  const empty = aggregateGroup([]);
  assert.equal(empty.apps, 0);
  assert.equal(empty.avg, null);
  assert.equal(empty.median, null);

  // Смешанные версии: тренд невозможен.
  const mixed = aggregateGroup([app('a', 50), { appId: 'b', summary: { score: 60, scoreVersion: 1 } }]);
  assert.equal(mixed.scoreVersion, null);
});
