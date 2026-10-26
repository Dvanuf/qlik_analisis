/**
 * Файл конфигурации правил: включение/выключение, важность, пороги,
 * списки исключений и глобальные подавления.
 *
 * Файл — обычный JSON, его можно экспортировать и импортировать:
 *   { "rules": { "disabled": ["R013"], "severity": { "S010": "warning" },
 *                "thresholds": { "R012": { "minRows": 5000 } },
 *                "exclusions": { "S002": { "tables": ["Fields"] } },
 *                "suppress": [ { "ruleId": "S001", "table": "Staging" } ] } }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_THRESHOLDS, DEFAULT_EXCLUDED_TABLES } from './settings.js';

/** Имя файла конфигурации в каталоге данных приложения. */
export const RULES_CONFIG_FILE = 'rules.json';

/** Конфигурация по умолчанию. */
export function defaultRulesConfig() {
  return {
    rules: {
      disabled: [],
      severity: {},
      thresholds: { ...DEFAULT_THRESHOLDS },
      exclusions: { S002: { tables: [...DEFAULT_EXCLUDED_TABLES] } },
      suppress: [],
    },
  };
}

/**
 * Читает конфигурацию правил из файла.
 * @param {string} path — путь к файлу
 * @returns {{rules: {disabled: string[], severity: Record<string, string>,
 *   thresholds: Record<string, object>, exclusions: Record<string, object>,
 *   suppress: Array<{ruleId: string, app?: string, table?: string}>}}}
 */
export function readRulesConfig(path) {
  const base = defaultRulesConfig();
  if (!path || !existsSync(path)) return base;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const rules = raw?.rules ?? raw ?? {};
    return {
      rules: {
        disabled: Array.isArray(rules.disabled) ? rules.disabled : base.rules.disabled,
        severity: rules.severity && typeof rules.severity === 'object' ? rules.severity : {},
        thresholds: { ...base.rules.thresholds, ...(rules.thresholds ?? {}) },
        exclusions: { ...base.rules.exclusions, ...(rules.exclusions ?? {}) },
        suppress: Array.isArray(rules.suppress) ? rules.suppress : [],
      },
    };
  } catch {
    // Битый файл не должен ломать запуск — берём значения по умолчанию.
    return base;
  }
}

/**
 * Сохраняет конфигурацию правил.
 * @param {string} path — путь к файлу
 * @param {object} config — конфигурация
 * @returns {string} путь к записанному файлу
 */
export function writeRulesConfig(path, config) {
  const full = resolve(path);
  if (!existsSync(dirname(full))) mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return full;
}

/**
 * Проверяет конфигурацию: неизвестные правила и неверные значения отбрасываются.
 * @param {object} config
 * @param {string[]} knownIds — известные ID правил
 */
export function sanitizeRulesConfig(config, knownIds = []) {
  const known = new Set(knownIds);
  const base = defaultRulesConfig();
  const rules = config?.rules ?? config ?? {};
  const onlyKnown = (list) => (Array.isArray(list) ? list : [])
    .map((id) => String(id).toUpperCase())
    .filter((id) => !known.size || known.has(id));

  const severity = {};
  for (const [id, value] of Object.entries(rules.severity ?? {})) {
    const key = String(id).toUpperCase();
    if (known.size && !known.has(key)) continue;
    if (['error', 'warning', 'info'].includes(value)) severity[key] = value;
  }

  const thresholds = {};
  for (const [id, value] of Object.entries(rules.thresholds ?? {})) {
    const key = String(id).toUpperCase();
    if (known.size && !known.has(key)) continue;
    thresholds[key] = { ...(DEFAULT_THRESHOLDS[key] ?? {}), ...(value ?? {}) };
  }

  const exclusions = {};
  for (const [id, value] of Object.entries(rules.exclusions ?? {})) {
    const key = String(id).toUpperCase();
    if (known.size && !known.has(key)) continue;
    exclusions[key] = value ?? {};
  }

  const suppress = (Array.isArray(rules.suppress) ? rules.suppress : [])
    .filter((s) => s && String(s.ruleId ?? '').trim())
    .map((s) => ({
      ruleId: String(s.ruleId).toUpperCase(),
      app: s.app ? String(s.app) : undefined,
      table: s.table ? String(s.table) : undefined,
    }));

  return {
    rules: {
      disabled: onlyKnown(rules.disabled),
      severity,
      thresholds: { ...base.rules.thresholds, ...thresholds },
      exclusions: { ...base.rules.exclusions, ...exclusions },
      suppress,
    },
  };
}
