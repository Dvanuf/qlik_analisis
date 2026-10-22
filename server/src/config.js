/**
 * Конфигурация сервера.
 *
 * Файл: server/server.config.json (путь — --config или переменная QLIK_SERVER_CONFIG).
 * Секреты (пароли пользователей, пароль Qlik) в файле не хранятся: указывается
 * ИМЯ переменной окружения, значение берётся из process.env.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_SERVER_CONFIG = 'server/server.config.json';

/** @param {string} configPath */
export function loadServerConfig(configPath = DEFAULT_SERVER_CONFIG) {
  const candidates = [
    process.env.QLIK_SERVER_CONFIG,
    configPath,
    resolve(process.cwd(), DEFAULT_SERVER_CONFIG),
    resolve(process.cwd(), '../server/server.config.json'),
  ].filter(Boolean);

  for (const c of candidates) {
    const full = resolve(c);
    if (!existsSync(full)) continue;
    const raw = JSON.parse(readFileSync(full, 'utf8'));
    return { config: raw ?? {}, path: full, exists: true };
  }
  return { config: {}, path: null, exists: false };
}

/**
 * Итоговая конфигурация сервера.
 * @param {object} raw — содержимое config-файла
 */
export function resolveServerConfig(raw = {}) {
  const server = raw.server ?? {};
  const auth = raw.auth ?? {};
  const qlik = raw.qlik ?? {};

  return {
    server: {
      host: server.host ?? '127.0.0.1',
      port: Number(server.port ?? 8080),
      // Каталог для отчётов и истории (относительно корня проекта).
      dataDir: server.dataDir ?? 'server/data',
      // Одновременных анализов: 1 — чтобы не исчерпать лицензии движка Qlik.
      concurrency: Number(server.concurrency ?? 1),
      // Пауза между приложениями при пакетном анализе (мс).
      pauseMs: Number(server.pauseMs ?? 1000),
      // Разрешить анализ по запросу из браузера (POST /api/...).
      allowRemoteAnalysis: server.allowRemoteAnalysis ?? true,
      // Доверять заголовку X-Forwarded-User (reverse-proxy с Kerberos/Negotiate).
      trustProxy: server.trustProxy ?? false,
      // Ограничение по IP для служебных маршрутов (пусто — не ограничивать).
      allowedIps: server.allowedIps ?? [],
    },
    auth: {
      // none | basic | proxy
      mode: auth.mode ?? 'none',
      realm: auth.realm ?? 'Qlik Quality',
      // Для режима basic: список пользователей { login, passwordEnv | password, role }.
      users: auth.users ?? [],
      // Для режима proxy: имя заголовка с логином и допустимые домены.
      userHeader: auth.userHeader ?? 'X-Forwarded-User',
      allowedDomains: auth.allowedDomains ?? [],
      // Роль, достаточная для запуска анализа (остальные — только просмотр).
      analystRole: auth.analystRole ?? 'analyst',
    },
    qlik: {
      url: qlik.url ?? '',
      cookie: qlik.cookie ?? '',
      xrfKey: qlik.xrfKey ?? '',
      csrfToken: qlik.csrfToken ?? '',
      user: qlik.user ?? '',
      passwordEnv: qlik.passwordEnv ?? '',
      insecure: qlik.insecure ?? true,
      platform: qlik.platform ?? 'qlikview',
    },
  };
}

/** Значение переменной окружения по имени (пустая строка — если не задана). */
export function envOrEmpty(name) {
  if (!name) return '';
  const v = process.env[name];
  return v === undefined ? '' : v;
}
