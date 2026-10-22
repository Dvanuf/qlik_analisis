/**
 * Применимость правил по платформам.
 *
 * qlik-sense — только Qlik Sense (нужны master items, закладки, расширения);
 * qlikview  — только QlikView 12;
 * both       — на обеих платформах.
 */

/** Платформы, на которых правило применимо. */
export const RULE_PLATFORMS = {
  P002: ['qlik-sense', 'qlikview'],
};

/** Возвращает обогащённое описание правила. */
export function enrichRule(rule) {
  const platforms = RULE_PLATFORMS[rule.id] ?? ['qlik-sense', 'qlikview'];
  return { ...rule, platforms };
}

