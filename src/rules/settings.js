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
  // Повторное использование выражения: сколько объектов и какая длина
  // выражения считаются поводом для замечания.
  P001: { minUses: 2, minLength: 8 },
  // Поле высокой кардинальности: доля уникальных значений вне ключа.
  R020: { maxDistinctRatio: 0.9 },
};

/** Служебные таблицы, для которых S002 («загрузка без WHERE») не срабатывает. */
export const DEFAULT_EXCLUDED_TABLES = ['Fields', 'Info', 'tmp_*', 'sys_*'];

/**
 * Правила, выключенные по умолчанию (ревизия каталога 0.19.0, сверка с
 * каталогом правил v2): шумные («объект без описания» на каждом объекте),
 * дублирующие или работающие только по предположениям. Из каталога не
 * удаляются — включаются галочкой во вкладке «Правила». Явный список
 * отключённых в rules.json заменяет дефолт целиком.
 */
export const DEFAULT_DISABLED_RULES = [
  'Q006', // объект без описания — шум на больших приложениях
  'Q007', // переменная без описания — шум
  'R009', // поле-константа — часто легитимный флаг
  'R011', // таблицы-дубликаты — ненадёжная эвристика
  'R012', // неоптимальное хранение чисел — оценки без гарантий
  'R013', // нет превью приложения — косметика
  'R016', // тяжёлый объект без условия вычисления — замер даёт X-метрика позже
  'R018', // объект без измерений — контейнеры и тексты
  'R020', // поле-уникальное вне ключа — часто законный справочник
  'R021', // CONCATENATE потерял ключ — редко оправдан
  'S002', // загрузка без WHERE — норма для фактов
  'S004', // CONCATENATE без NoConcatenate — авто-конкатенация часто задумана
  'S006', // JOIN по неключевому полю — часто рабочий приём
  'S011', // скрипт без комментариев — стилистика
  'S012', // загрузка файла без формата — косметика
  'S017', // скрипт засыпает — редко встречается
];

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
  // Явный список отключённых заменяет дефолт целиком; без него действуют
  // правила, выключенные по умолчанию (DEFAULT_DISABLED_RULES).
  const userDisabled = rules.disabled ?? rules.disabledRules ?? config.disabledRules ?? null;
  const disabled = userDisabled ? userDisabled : [...DEFAULT_DISABLED_RULES];

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
    disabled: new Set(disabled.map((id) => String(id).toUpperCase())),
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
