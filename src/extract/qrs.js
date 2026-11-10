/**
 * QRS — сервис репозитория Qlik Sense Enterprise (Qlik Repository Service).
 *
 * Отличие от REST API хаба: хаб показывает только опубликованные
 * приложения, а репозиторий видит все — включая неопубликованные и личные.
 * Именно это нужно, чтобы список приложений и фильтры «Поток / Владелец /
 * Тэги» были полными.
 *
 * Доступ — по клиентскому сертификату (взаимная TLS-аутентификация):
 * без него сервис отвечает «403 No client certificate supplied». Поэтому
 * параметры сертификата задаются отдельно: путь к файлу — в настройках,
 * пароль — в переменной окружения.
 *
 * Путь к API различается между версиями Qlik Sense, поэтому перебирается
 * несколько адресов — как это уже сделано для REST API хаба.
 */
import { readFileSync, existsSync } from 'node:fs';
import { httpGetJson } from './http.js';
import { maskUrl } from '../logging/mask.js';

/** Порт QRS по умолчанию. */
export const QRS_PORT = 4242;

/**
 * Адреса списка приложений: перебираются по порядку, первый ответивший
 * выигрывает. Порядок — от самого короткого пути к самому общему.
 */
export const QRS_APP_PATHS = [
  '/qrs/apps',
  '/qrs/applications',
  '/qrs/repository/apps',
  '/qrs/repo/apps',
];

/**
 * Адрес QRS по хосту и порту.
 * @param {{host?: string, port?: number|string, scheme?: string}} options
 * @returns {string|null}
 */
export function qrsBase({ host, port = QRS_PORT, scheme = 'https' } = {}) {
  const h = String(host ?? '').trim();
  if (!h) return null;
  const p = Number(port) || QRS_PORT;
  return `${scheme}://${h}:${p}`;
}

/**
 * Клиентский сертификат: читаем файл и готовим параметры TLS.
 *
 * Поддерживаются два вида:
 *  - PKCS#12 (.pfx, .p12) — ключ внутри файла, нужен пароль;
 *  - PEM (.crt/.pem) — ключ отдельным файлом .key либо в том же файле.
 *
 * PEM нужен не только как альтернатива: часть систем создаёт .pfx в формате,
 * который не читается OpenSSL 3 (например, LibreSSL на macOS).
 *
 * @param {{certPath?: string, certPassword?: string, keyPath?: string}} options
 * @returns {{pfx?: Buffer, passphrase?: string, cert?: Buffer, key?: Buffer, note?: string}}
 */
export function readQrsCertificate({ certPath, certPassword, keyPath } = {}) {
  const path = String(certPath ?? '').trim();
  if (!path) return { note: 'клиентский сертификат не задан' };
  if (!existsSync(path)) return { note: `файл сертификата не найден: ${path}` };
  try {
    const data = readFileSync(path);

    // PKCS#12: закрытый контейнер с ключом и сертификатом.
    if (/\.(pfx|p12)$/i.test(path)) {
      const out = { pfx: data };
      if (certPassword) out.passphrase = certPassword;
      return out;
    }

    // PEM: сертификат плюс ключ — отдельным файлом или в том же.
    let key = null;
    const explicit = String(keyPath ?? '').trim();
    if (explicit && existsSync(explicit)) {
      key = readFileSync(explicit);
    } else {
      const guess = path.replace(/\.(crt|pem|cer)$/i, '.key');
      if (existsSync(guess)) key = readFileSync(guess);
      else if (data.includes('PRIVATE KEY')) key = data;
    }
    if (!key) {
      return { note: `не найден ключ для сертификата ${path} (укажите отдельный .key)` };
    }
    return { cert: data, key };
  } catch (err) {
    return { note: `не удалось прочитать сертификат: ${err?.message ?? err}` };
  }
}


/**
 * Разбор ответа QRS со списком приложений.
 *
 * Формат ответа зависит от версии: встречается массив, объект с полем
 * 'data' или 'items'. Разбор терпимый — как и в остальных коннекторах.
 *
 * @param {object} payload — разобранный ответ
 * @returns {Array<object>} список приложений в едином виде
 */
export function parseQrsApps(payload) {
  const items = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.data) ? payload.data
      : (Array.isArray(payload?.items) ? payload.items : []));
  const out = [];
  for (const raw of items) {
    if (!raw) continue;
    const attrs = raw.attributes ?? raw;
    const id = String(raw.id ?? attrs.id ?? attrs.appId ?? attrs.guid ?? '').trim();
    const title = String(
      attrs.name ?? attrs.title ?? attrs.appName ?? attrs.document ?? '',
    ).trim();
    if (!id && !title) continue;

    const tags = [];
    for (const t of attrs.tags ?? attrs.customProperties ?? []) {
      if (typeof t === 'string') {
        const v = t.trim();
        if (v) tags.push(v);
      } else if (t && typeof t === 'object') {
        const value = String(t.value ?? t.name ?? '').trim();
        const def = String(t.definition?.name ?? t.type ?? '').trim();
        if (value) tags.push(def ? `${def}:${value}` : value);
      }
    }

    out.push({
      id,
      title,
      owner: String(attrs.owner ?? attrs.ownerName ?? attrs.user ?? '').trim() || null,
      stream: String(attrs.stream ?? attrs.streamName ?? attrs.group ?? '').trim() || null,
      tags,
      size: Number.isFinite(attrs.fileSize) ? attrs.fileSize : null,
      lastReload: attrs.lastReloadTime ?? attrs.modified ?? attrs.updated ?? null,
      published: typeof attrs.published === 'boolean' ? attrs.published : null,
      source: 'qrs',
    });
  }
  return out;
}


/**
 * Совет по отказу 403: без сертификата и с непринятым сертификатом
 * причины разные, и подсказка должна вести в нужную сторону.
 * Живой сервер отвечает «No client certificate supplied» без сертификата
 * и «Client certificate invalid» с нераспознанным сертификатом
 * (проверено на живом QRS 07.11.2026).
 *
 * @param {string} message — текст ошибки HTTP-запроса
 * @returns {string} подсказка для пользователя
 */
export function qrsCertAdvice(message) {
  return /invalid|not\s+recognized|unknown/i.test(String(message))
    ? 'Сертификат отклонён сервером: неверный файл или сертификат не экспортирован из QMC.'
    : 'Нужен клиентский сертификат QRS.';
}

/**
 * Запрос списка приложений у QRS.
 *
 * @param {{
 *   host?: string, port?: number|string, certPath?: string, keyPath?: string,
 *   certPassword?: string, insecure?: boolean, log?: ((m: string) => void)|null,
 * }} options
 * @returns {Promise<{ok: boolean, apps?: Array<object>, note: string}>}
 */
export async function fetchQrsApps({
  host, port = QRS_PORT, certPath, certPassword, keyPath, insecure = true, log = null,
} = {}) {
  const base = qrsBase({ host, port });
  if (!base) return { ok: false, note: 'не задан хост репозитория QRS' };

  const cert = readQrsCertificate({ certPath, certPassword, keyPath });
  if (cert.note) return { ok: false, note: cert.note };

  for (const path of QRS_APP_PATHS) {
    const target = `${base}${path}`;
    try {
      const payload = await httpGetJson(target, {
        insecure,
        pfx: cert.pfx,
        passphrase: cert.passphrase,
        cert: cert.cert,
        key: cert.key,
      });
      const apps = parseQrsApps(payload);
      if (!apps.length) {
        log?.(`${maskUrl(target)} → в ответе нет приложений`);
        continue;
      }
      log?.(`${maskUrl(target)} → приложений ${apps.length}`);
      return { ok: true, apps, note: `${maskUrl(target)} → приложений ${apps.length}` };
    } catch (err) {
      const message = String(err?.message ?? err);
      // Сертификат обязателен: дальше перебирать пути бессмысленно.
      if (/client certificate|403/i.test(message)) {
        return {
          ok: false,
          note: `${maskUrl(target)} → ${message}. ${qrsCertAdvice(message)}`,
        };
      }
      log?.(`${maskUrl(target)} → ${message}`);
    }
  }
  return { ok: false, note: `${maskUrl(base)} → подходящий адрес не найден` };
}

/**
 * Проверка связи с репозиторием: версия QRS.
 *
 * @param {object} options — те же параметры, что у fetchQrsApps
 * @returns {Promise<{ok: boolean, version?: string, note: string}>}
 */
export async function fetchQrsVersion({
  host, port = QRS_PORT, certPath, certPassword, keyPath, insecure = true, log = null,
} = {}) {
  const base = qrsBase({ host, port });
  if (!base) return { ok: false, note: 'не задан хост репозитория QRS' };
  const cert = readQrsCertificate({ certPath, certPassword, keyPath });
  if (cert.note) return { ok: false, note: cert.note };
  const target = `${base}/qrs/about/version`;
  try {
    const payload = await httpGetJson(target, {
      insecure,
      pfx: cert.pfx,
      passphrase: cert.passphrase,
      cert: cert.cert,
      key: cert.key,
    });
    const version = String(
      payload?.version ?? payload?.Version ?? payload?.qrsVersion ?? '',
    ).trim();
    log?.(`${maskUrl(target)} → ${version || 'ответ без версии'}`);
    return { ok: true, version: version || null, note: `${maskUrl(target)} → соединение установлено` };
  } catch (err) {
    const message = String(err?.message ?? err);
    return {
      ok: false,
      note: `${maskUrl(target)} → ${message}. ${qrsCertAdvice(message)}`,
    };
  }
}

/**
 * Путь подключения по имени (для раскрытия lib:// include-файлов).
 *
 * QRS отдаёт определение подключения: для папочных — путь на сервере
 * (qConnectionString). Содержимое файла по API не отдаётся, но путь
 * позволяет прочитать файл, если он виден с этой машины (общий ресурс,
 * смонтированный share, локальный запуск).
 *
 * @param {{ host?: string, name?: string, port?: number|string,
 *   certPath?: string, certPassword?: string, keyPath?: string,
 *   insecure?: boolean, cookie?: string, xrfKey?: string }} options
 * @returns {Promise<{ok: boolean, path?: string, note: string}>}
 */
export async function fetchQrsConnectionPath({
  host, name, port = QRS_PORT, certPath, certPassword, keyPath, insecure = true,
  cookie, xrfKey,
} = {}) {
  if (!name) return { ok: false, note: 'не задано имя подключения' };
  const filter = encodeURIComponent(`Name eq '${name}'`);
  const attempts = [];

  // Путь 1: через прокси по сессии хаба — тот же вход, что у QMC в браузере.
  // Сертификаты не нужны: аутентификация cookie сессии + XrfKey.
  if (cookie && host) {
    const xrf = xrfKey || 'qlikanalyzer1';
    const target = `https://${host}/qrs/dataconnection?filter=${filter}&xrfkey=${xrf}`;
    attempts.push({ target, headers: { Cookie: cookie, 'X-Qlik-Xrfkey': xrf }, tls: {} });
  }

  // Путь 2: напрямую в QRS по клиентскому сертификату (порт 4242).
  const base = qrsBase({ host, port });
  if (base) {
    const cert = readQrsCertificate({ certPath, certPassword, keyPath });
    if (!cert.note) {
      attempts.push({
        target: `${base}/qrs/dataconnection?filter=${filter}`,
        headers: {},
        tls: { pfx: cert.pfx, passphrase: cert.passphrase, cert: cert.cert, key: cert.key },
      });
    }
  }

  if (!attempts.length) {
    return { ok: false, note: 'ни сессии хаба, ни настроенного QRS — путь подключения не получить' };
  }

  const notes = [];
  for (const a of attempts) {
    try {
      const payload = await httpGetJson(a.target, {
        insecure, headers: a.headers, ...a.tls,
      });
      const list = Array.isArray(payload) ? payload : [];
      if (!list.length) return { ok: false, note: `подключение «${name}» в QRS не найдено` };
      const path = String(list[0]?.qConnectionString ?? list[0]?.connectionString ?? '').trim();
      if (!path) return { ok: false, note: `подключение «${name}» без пути` };
      return { ok: true, path, note: `${maskUrl(a.target)} → путь получен` };
    } catch (err) {
      notes.push(`${maskUrl(a.target)} → ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return { ok: false, note: notes.join('; ') };
}
