/**
 * Конфигурация инструмента.
 *
 * Приоритет значений: CLI-флаг > переменная окружения > config-файл > умолчание.
 * Секреты в config-файле не хранятся: указывается ИМЯ переменной окружения
 * (passwordEnv), значение берётся из process.env.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { sanitizeFallback } from './ai/providers.js';

export const DEFAULT_CONFIG_NAME = 'qlik-analyzer.config.json';

/** Загружает .env в process.env (если файл есть и переменные не заданы). */
export function loadDotEnv(path = '.env') {
  const full = resolve(path);
  if (!existsSync(full)) return [];
  const loaded = [];
  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

/**
 * @param {string} configPath
 * @returns {{config: object, path: string|null, exists: boolean}}
 */
export function loadConfig(configPath = DEFAULT_CONFIG_NAME) {
  const candidates = [
    process.env.QLIK_ANALYZER_CONFIG,
    configPath,
    resolve(process.cwd(), DEFAULT_CONFIG_NAME),
  ].filter(Boolean);

  for (const c of candidates) {
    const full = resolve(c);
    if (!existsSync(full)) continue;
    const raw = JSON.parse(readFileSync(full, 'utf8'));
    return { config: raw ?? {}, path: full, exists: true };
  }
  return { config: {}, path: null, exists: false };
}

/** Значение из окружения по списку имён (первое найденное). */
export function envValue(names = []) {
  for (const n of names) {
    if (!n) continue;
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * Собирает итоговые параметры подключения.
 * @param {object} cli — разобранные аргументы CLI
 * @param {object} config — содержимое config-файла
 */
export function resolveTarget(cli = {}, config = {}) {
  const envName = cli.env ?? envValue(['QLIK_ANALYZER_ENV']);
  const envCfg = (config.environments ?? {})[envName] ?? {};

  const appName = cli.app ?? envValue(['QLIK_ANALYZER_APP']);
  const appCfg = (config.apps ?? {})[appName] ?? {};

  const merged = {
    ...envCfg,
    ...appCfg,
    ...pickDefined(cli, [
      'type', 'url', 'host', 'port', 'appId', 'user', 'qlikUser', 'insecure',
      'doc', 'path', 'schemaPath', 'scheme',
    ]),
  };

  // URL: явный --url приоритетнее; иначе собираем из host/port/appId.
  // На Qlik Sense Server: 4747 — http (ws://), 4746 — https (wss://).
  if (!merged.url && merged.host) {
    const port = merged.port ?? 4747;
    const scheme = merged.scheme ?? (Number(port) === 4746 ? 'wss' : 'ws');
    merged.url = merged.appId
      ? `${scheme}://${merged.host}:${port}/app/${merged.appId}`
      : `${scheme}://${merged.host}:${port}/app`;
  }
  if (merged.url && merged.appId && !/\/app\/.+/.test(merged.url)) {
    merged.url = `${merged.url.replace(/\/$/, '')}/${merged.appId}`;
  }

  // Секреты
  const passwordEnv = cli.passwordEnv ?? merged.passwordEnv;
  const password = cli.password
    ?? envValue([passwordEnv, 'QLIK_PASSWORD', 'QLIK_ANALYZER_PASSWORD'])
    ?? undefined;
  const apiKey = cli.apiKey
    ?? envValue([merged.apiKeyEnv, 'QLIK_API_KEY'])
    ?? undefined;

  // Сессионная cookie хаба — основной способ доступа к движку за forms-auth.
  const cookie = cli.cookie
    ?? envValue([merged.cookieEnv, 'QLIK_COOKIE'])
    ?? undefined;
  // XSRF-ключ хаба: без него прокси отвечает «XSRF prevention check failed».
  const xrfKey = cli.xrfKey
    ?? envValue([merged.xrfKeyEnv, 'QLIK_XRF_KEY'])
    ?? undefined;
  // CSRF-токен для WebSocket-рукопожатия (?qlik-csrf-token=…).
  const csrfToken = cli.csrfToken
    ?? envValue([merged.csrfTokenEnv, 'QLIK_CSRF_TOKEN'])
    ?? undefined;

  if (!merged.qlikUser) merged.qlikUser = merged.user;

  return {
    envName,
    appName,
    type: merged.type ?? (cli.script || cli.qvs || cli.qvw ? 'file' : 'qlik-sense'),
    url: merged.url,
    host: merged.host,
    port: merged.port,
    appId: merged.appId,
    user: merged.user,
    qlikUser: merged.qlikUser,
    password,
    passwordEnv,
    apiKey,
    cookie,
    xrfKey,
    csrfToken,
    insecure: Boolean(merged.insecure ?? cli.insecure),
    schemaPath: merged.schemaPath ?? cli.schema,
    doc: merged.doc,
    file: cli.script ?? cli.qvs ?? cli.qvw ?? cli.fixture ?? merged.path,
    fileType: cli.script ? 'script'
      : cli.qvs ? 'qvs'
        : cli.qvw ? 'qvw'
          : cli.fixture ? 'fixture'
            : (merged.path ? 'script' : null),
  };
}

function pickDefined(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

/** Правила из config-файла + CLI. */
export function resolveRules(cli = {}, config = {}) {
  const cfg = config.rules ?? {};
  return {
    enabledRules: cli.enable?.length ? cli.enable : (cfg.enabled ?? null),
    disabledRules: cli.disable?.length ? cli.disable : (cfg.disabled ?? null),
    maxExpressionLength: cli.maxExpressionLength ?? cfg.maxExpressionLength ?? 200,
    namePrefixes: cli.namePrefixes ?? cfg.namePrefixes ?? ['dim_', 'fact_', 'var_', 'ext_'],
    // Платформа определяет применимость правил (master items, закладки — только Qlik Sense).
    // null = определяется автоматически по типу API экстрактора (QIX Engine API / Doc API).
    platform: cli.platform ?? cfg.platform ?? null,
    deprecatedVisualizationTypes: cfg.deprecatedVisualizationTypes ?? [],
  };
}

/**
 * Переопределение провайдера ИИ из конфигурации.
 * @typedef {object} AiProviderOverride
 * @property {string|undefined} baseUrl — адрес эндпоинта.
 * @property {string|undefined} model — модель.
 * @property {string|undefined} apiKeyEnv — имя переменной окружения с ключом.
 */

/**
 * Итоговые настройки ИИ-слоя.
 * @typedef {object} AiSettings
 * @property {string} provider — основной провайдер.
 * @property {string|undefined} model — модель по умолчанию.
 * @property {string[]} fallback — резервные провайдеры.
 * @property {boolean} sensitive — режим конфиденциальности.
 * @property {{requestsPerMinute: number, dailyCap: number, cacheTtlMs: number}} limits — лимиты.
 * @property {number} maxSummaryChars — предел размера сводки.
 * @property {Record<string, AiProviderOverride>} providers — переопределения провайдеров.
 */

/**
 * Настройки ИИ-слоя: провайдеры, резервная цепочка, лимиты.
 *
 * Приоритет значений: CLI-флаг > переменная окружения > config-файл > умолчание.
 * Секреты в config-файле не хранятся: указывается ИМЯ переменной окружения
 * (apiKeyEnv), значение берётся из process.env.
 *
 * @param {object} [cli] — разобранные аргументы CLI
 * @param {object} [config] — содержимое config-файла
 * @returns {AiSettings}
 */
export function resolveAi(cli = {}, config = {}) {
  const cfg = config.ai ?? {};
  const envCfg = cfg;

  const provider = cli.aiProvider
    ?? envValue(['QLIK_AI_PROVIDER'])
    ?? envCfg.provider
    ?? 'zai';
  const model = cli.aiModel
    ?? envValue(['QLIK_AI_MODEL'])
    ?? envCfg.model
    ?? undefined;
  const fallback = cli.aiFallback
    ?? (envValue(['QLIK_AI_FALLBACK'])?.split(',').map((s) => s.trim()).filter(Boolean))
    ?? envCfg.fallback
    ?? ['gemini', 'local'];
  // Флаг «чувствительные данные» читается из окружения как «1»/«0».
  // Проверять нужно undefined, а не сравнивать с «1»: иначе false от
  // сравнения перехватывал бы значение из файла конфигурации.
  const sensitiveEnv = envValue(['QLIK_AI_SENSITIVE']);
  const sensitive = cli.aiSensitive
    ?? (sensitiveEnv === undefined ? undefined : sensitiveEnv === '1')
    ?? envCfg.sensitive
    ?? false;

  const limits = {
    requestsPerMinute: Number(
      cli.aiRequestsPerMinute ?? envValue(['QLIK_AI_RPM']) ?? envCfg.limits?.requestsPerMinute ?? 10,
    ),
    dailyCap: Number(
      cli.aiDailyCap ?? envValue(['QLIK_AI_DAILY_CAP']) ?? envCfg.limits?.dailyCap ?? 200,
    ),
    cacheTtlMs: Number(
      cli.aiCacheTtlMs ?? envValue(['QLIK_AI_CACHE_TTL_MS']) ?? envCfg.limits?.cacheTtlMs ?? 60000,
    ),
  };

  const maxSummaryChars = Number(
    cli.aiMaxSummaryChars ?? envValue(['QLIK_AI_MAX_SUMMARY']) ?? envCfg.maxSummaryChars ?? 12000,
  );

  // Адреса и модели провайдеров можно переопределить: локальный сервер может
  // слушать не на 11434, а модель — отличаться от значения по умолчанию.
  const providers = {};
  for (const id of ['zai', 'gemini', 'local']) {
    const over = envCfg.providers?.[id] ?? {};
    providers[id] = {
      baseUrl: over.baseUrl,
      model: over.model,
      apiKeyEnv: over.apiKeyEnv,
    };
  }

  return {
    provider,
    model,
    // Резервные провайдеры очищаются: неизвестные и повтор основного
    // не могут быть резервом и тихо оставляют запрос без резерва.
    fallback: sanitizeFallback(provider, Array.isArray(fallback) ? fallback : [fallback]),
    sensitive: Boolean(sensitive),
    limits,
    maxSummaryChars,
    providers,
  };
}

/**
 * Имена переменных окружения с ключами провайдеров.
 * @param {AiSettings} [aiConfig] — результат resolveAi
 * @returns {Record<string, string|null>} идентификатор провайдера → имя переменной
 */
export function aiKeyEnvNames(aiConfig = {}) {
  const defaults = {
    zai: 'QLIK_AI_ZAI_KEY',
    gemini: 'QLIK_AI_GEMINI_KEY',
    local: null,
  };
  const out = {};
  for (const [id, over] of Object.entries(aiConfig.providers ?? {})) {
    out[id] = over?.apiKeyEnv ?? defaults[id] ?? null;
  }
  for (const [id, name] of Object.entries(defaults)) {
    if (out[id] === undefined) out[id] = name;
  }
  return out;
}

/**
 * Пути вывода из config-файла + CLI (поддерживает {env} и {app}).
 * @param {object} cli — разобранные аргументы CLI
 * @param {object} config — содержимое config-файла
 * @param {object} target — подключение
 */
export function resolvePaths(cli = {}, config = {}, target = {}) {
  const p = config.paths ?? {};
  const fmt = (tpl, fallback) => String(tpl ?? fallback)
    .replace('{env}', target.envName ?? 'default')
    .replace('{app}', target.appName ?? 'app');
  return {
    out: cli.out ?? fmt(p.out, 'out/report.html'),
    json: cli.json ?? fmt(p.json, 'out/findings.json'),
    graph: cli.graph ?? fmt(p.graph, 'out/app-graph.json'),
  };
}

/** Секреты маскируются в логах. */
export function maskSecret(value) {
  if (!value) return '(не задан)';
  const s = String(value);
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-2)}`;
}
