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
          note: `${maskUrl(target)} → ${message}. Нужен клиентский сертификат QRS.`,
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
      note: `${maskUrl(target)} → ${message}. Нужен клиентский сертификат QRS.`,
    };
  }
}
