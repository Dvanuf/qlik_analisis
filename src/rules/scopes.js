/**
 * Область находки: где проблема находится в приложении.
 *
 * Категория правила отвечает на вопрос «какого типа проверка», а область —
 * «где смотреть в приложении». Разделение нужно, чтобы в отчёте и в
 * интерфейсе находки не лежали одной кучей: у загрузочного скрипта, у
 * дашборда и у мер с измерениями — разные способы исправления.
 */
export const SCOPES = ['script', 'dashboard', 'measures'];

/** Человекочитаемые названия областей. */
export const SCOPE_LABELS = {
  script: 'Скрипт загрузки',
  dashboard: 'Дашборд',
  measures: 'Меры и измерения',
};

/**
 * Область по ID правила.
 *
 * Проставлена явно, а не выводится из категории: правило «Неиспользуемое
 * поле» относится к модели данных (скрипт), а правило «Объект без
 * описания» — к дашборду, хотя обе они в категории Quality/Practices.
 */
export const SCOPE_BY_RULE = {
  // --- Quality ---
  Q001: 'measures',
  Q002: 'measures',
  Q003: 'measures',
  Q004: 'measures',
  Q005: 'measures',
  Q006: 'dashboard',
  Q007: 'script',

  // --- Resources ---
  R001: 'script',
  R002: 'script',
  R003: 'script',
  R004: 'script',
  R005: 'script',
  R006: 'script',
  R007: 'script',
  R008: 'dashboard',
  R009: 'script',
  R010: 'script',
  R011: 'script',
  R012: 'script',
  R013: 'dashboard',
  R014: 'dashboard',
  R015: 'dashboard',
  R016: 'dashboard',
  R017: 'dashboard',
  R018: 'dashboard',
  R019: 'script',
  R020: 'script',
  R021: 'script',

  // --- Practices ---
  P001: 'measures',
  P002: 'measures',
  P003: 'measures',
  P004: 'dashboard',
  P005: 'script',
  P006: 'measures',
  P007: 'measures',
  P008: 'measures',
  P009: 'measures',
  P010: 'dashboard',
  P011: 'measures',
  P012: 'script',

  // --- Script ---
  S001: 'script',
  S002: 'script',
  S003: 'script',
  S004: 'script',
  S005: 'script',
  S006: 'script',
  S007: 'script',
  S008: 'script',
  S009: 'script',
  S010: 'script',
  S011: 'script',
  S012: 'script',
  S013: 'script',
  S014: 'script',
};

/**
 * Область находки по правилу.
 *
 * @param {string} ruleId
 * @param {string} [category] — категория правила (запасной вариант)
 * @returns {string} script | dashboard | measures
 */
export function scopeForRule(ruleId, category = '') {
  const scope = SCOPE_BY_RULE[ruleId];
  if (scope) return scope;
  // Правило без явной разметки: скриптовые — к скрипту, остальные — к дашборду.
  if (category === 'Script') return 'script';
  return 'dashboard';
}
