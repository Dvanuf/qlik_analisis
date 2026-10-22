/**
 * Конфигурация инструмента.
 *
 * Приоритет значений: CLI-флаг > переменная окружения > config-файл > умолчание.
 * Секреты в config-файле не хранятся: указывается ИМЯ переменной окружения
 * (passwordEnv), значение берётся из process.env.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

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
  };
}

/** Пути вывода из config-файла + CLI (поддерживает {env} и {app}). */
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
