/**
 * Итоговый скор приложения: 0–100.
 *
 * Формула (показывается в подсказке интерфейса):
 *   штраф = 10 × ошибки + 4 × предупреждения + 1 × замечания
 *   скор  = 100 − штраф × 10 ÷ число выполненных проверок
 *
 * Деление на число проверок нужно, чтобы одинаковая по весу проблема
 * в большом приложении не «съедала» весь скор: у приложения с 40 правилами
 * одна ошибка — это 100 − 100/40 ≈ 98, а не 90.
 */

/** Вес каждой важности. */
export const SEVERITY_WEIGHT = { error: 10, warning: 4, info: 1 };

/** Текст формулы — для тултипа в интерфейсе и отчёте. */
export const SCORE_FORMULA = 'Скор = 100 − (10×ошибки + 4×предупреждения + 1×замечания) × 10 ÷ число выполненных проверок';

/**
 * @param {{bySeverity?: object, checks?: number}} input
 * @returns {{score: number, penalty: number, checks: number, formula: string}}
 */
export function computeScore(input = {}) {
  const bySeverity = input.bySeverity ?? {};
  const errors = bySeverity.error ?? 0;
  const warnings = bySeverity.warning ?? 0;
  const infos = bySeverity.info ?? 0;
  const penalty = errors * SEVERITY_WEIGHT.error
    + warnings * SEVERITY_WEIGHT.warning
    + infos * SEVERITY_WEIGHT.info;
  const checks = Math.max(1, input.checks ?? 1);
  const raw = 100 - (penalty * 10) / checks;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, penalty, checks, formula: SCORE_FORMULA };
}
