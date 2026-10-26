/**
 * Данные сессии хаба: приведение к безопасному виду и проверка целостности.
 *
 * Сессия лежит в зашифрованном файле (safeStorage). Если в него попадёт
 * не-строка (например, объект), то после `String(...)` получится
 * «[object Object]» — такой файл потом не читается, и пользователь
 * каждый раз входит заново без объяснения причины.
 *
 * Поэтому значения приводятся к строкам явно, а пустая cookie считается
 * признаком испорченной сессии: такой файл не восстанавливаем.
 */

/** Приводит значение к строке; объект без строкового представления — пустая строка. */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Объект не превращаем в «[object Object]»: полезных данных в нём нет.
  return '';
}

/**
 * Приводит параметры сессии к набору строк.
 *
 * @param {object} creds — исходные значения (могут прийти из IPC любого вида)
 * @param {string} [now] — время получения сессии, если его не передали
 * @returns {{hubUrl: string, cookie: string, xrfKey: string, csrfToken: string, at: string}}
 */
export function normalizeCredentials(creds, now = new Date().toISOString()) {
  const source = creds && typeof creds === 'object' ? creds : {};
  return {
    hubUrl: toText(source.hubUrl),
    cookie: toText(source.cookie),
    xrfKey: toText(source.xrfKey),
    csrfToken: toText(source.csrfToken),
    at: toText(source.at) || now,
  };
}

/**
 * Проверяет, что сохранённая сессия пригодна для входа в хаб.
 *
 * @param {object} creds
 * @returns {boolean}
 */
export function isSessionUsable(creds) {
  if (!creds || typeof creds !== 'object') return false;
  return typeof creds.cookie === 'string' && creds.cookie.trim() !== '';
}

/**
 * Разбирает содержимое файла сессии.
 *
 * Файл мог быть записан старой сборкой или прерванной записью — тогда
 * внутри не JSON, а мусор. Такой файл молча ломал бы восстановление
 * сессии, поэтому он отбрасывается: вернётся null, и пользователь
 * увидит обычное приглашение войти заново.
 *
 * @param {string} text — расшифрованное содержимое файла
 * @returns {object|null} нормализованная сессия либо null
 */
export function parseCredentials(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const creds = normalizeCredentials(parsed, toText(parsed.at) || new Date().toISOString());
  return isSessionUsable(creds) ? creds : null;
}
