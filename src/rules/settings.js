/**
 * Настройки правил: включение/выключение, важность, пороги, исключения.
 *
 * Настройки приходят из конфигурационного файла (config.rules) и из редактора
 * правил в приложении. Ядро остаётся детерминированным: настройки только
 * меняют состав и важность находок, логика правил не меняется.
 */

/** Пороги по умолчанию для правил, у которых они есть. */
export const DEFAULT_THRESHOLDS = {
  // Поле-константа: сколько уникальных значений допустимо.
  R009: { maxDistinct: 1 },
  // Неоптимальное хранение чисел: с какой доли строк поле считается «плотным».
  R012: { minRows: 1000, minDistinctRatio: 0.5 },
  // Лист с большим числом объектов: сколько объектов считается пределом.
  R017: { maxObjects: 15 },
};

/** Служебные таблицы, для которых S002 («загрузка без WHERE») не срабатывает. */
export const DEFAULT_EXCLUDED_TABLES = ['Fields', 'Info', 'tmp_*', 'sys_*'];

/**
 * Приводит настройки к единому виду.
 * @param {object} config — конфигурация анализа
 * @returns {{
 *   enabled: Set<string>|null, disabled: Set<string>|null,
 *   severity: Record<string, string>, thresholds: Record<string, object>,
 *   exclusions: Record<string, object>, suppressExclusions: object[],
 * }}
 */
export function normalizeRuleSettings(config = {}) {
  const rules = config.rules ?? config;
  const enabled = rules.enabled ?? rules.enabledRules ?? config.enabledRules ?? null;
  const disabled = rules.disabled ?? rules.disabledRules ?? config.disabledRules ?? null;

  const severity = {};
  for (const [id, value] of Object.entries(rules.severity ?? config.severity ?? {})) {
    if (['error', 'warning', 'info'].includes(value)) severity[String(id).toUpperCase()] = value;
  }

  const thresholds = {};
  for (const [id, value] of Object.entries(rules.thresholds ?? config.thresholds ?? {})) {
    thresholds[String(id).toUpperCase()] = { ...(DEFAULT_THRESHOLDS[id] ?? {}), ...(value ?? {}) };
  }
  for (const [id, value] of Object.entries(DEFAULT_THRESHOLDS)) {
    if (!thresholds[id]) thresholds[id] = { ...value };
  }

  const exclusions = {};
  for (const [id, value] of Object.entries(rules.exclusions ?? config.exclusions ?? {})) {
    exclusions[String(id).toUpperCase()] = value ?? {};
  }
  if (!exclusions.S002) exclusions.S002 = { tables: [...DEFAULT_EXCLUDED_TABLES] };

  const suppressExclusions = rules.suppress ?? config.suppressExclusions ?? [];

  return {
    enabled: enabled ? new Set(enabled) : null,
    disabled: disabled ? new Set(disabled) : null,
    severity,
    thresholds,
    exclusions,
    suppressExclusions,
  };
}

/**
 * Важность находки с учётом переопределений.
 * @param {string} ruleId
 * @param {string} base — важность по умолчанию
 * @param {object} settings — результат normalizeRuleSettings
 */
export function severityFor(ruleId, base, settings) {
  return settings?.severity?.[String(ruleId).toUpperCase()] ?? base;
}

/**
 * Совпадает ли имя таблицы со списком исключений (поддерживаются маски `*`).
 * @param {string} name
 * @param {string[]} patterns
 */
export function matchesExcludedTable(name, patterns) {
  const value = String(name ?? '').toLowerCase();
  if (!value) return false;
  return (patterns ?? []).some((pattern) => {
    const p = String(pattern ?? '').toLowerCase();
    if (!p) return false;
    if (p.includes('*')) {
      const re = new RegExp(`^${p.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return re.test(value);
    }
    return p === value;
  });
}
