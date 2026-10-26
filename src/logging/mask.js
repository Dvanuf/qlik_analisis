/**
 * Маскирование секретов в логах, отчётах и сообщениях об ошибках.
 *
 * Cookie сессии хаба, CSRF-токен, XSRF-ключ и пароли не должны попадать
 * в файлы журналов и в выгружаемые отчёты: по ним можно войти в хаб.
 */

/** Правила маскирования: первая группа — регулярка, вторая — замена. */
const RULES = [
  // CSRF-токен в query-параметре: ?qlik-csrf-token=…
  { re: /(qlik-csrf-token=)([^&\s"'#]+)/gi, to: '$1***' },
  // Сессионная cookie хаба: X-Qlik-Session=…
  { re: /(X-Qlik-Session=)([^;\s"'&]+)/gi, to: '$1***' },
  // XSRF-ключ хаба в заголовке или параметре
  { re: /(X-Qlik-XrfKey"?\s*[:=]\s*"?)([^";\s&]+)/gi, to: '$1***' },
  // Авторизация Basic/Bearer
  { re: /(Authorization"?\s*[:=]\s*"?)(Basic|Bearer)\s+[^"\s]+/gi, to: '$1$2 ***' },
  // Пароли и ключи в параметрах
  {
    re: /((?:password|passwd|pwd|api[_-]?key|apikey|secret|access[_-]?token|refresh[_-]?token)=)([^&\s"'#]+)/gi,
    to: '$1***',
  },
  // JSON-подобные пары: "cookie": "…", "csrfToken": "…"
  {
    re: /("(?:cookie|csrfToken|csrf_token|xrfKey|xrf_key|password|apiKey|api_key|token)"\s*:\s*")([^"]*)(")/gi,
    to: '$1***$3',
  },
];

/**
 * Маскирует секреты в произвольной строке.
 * @param {unknown} value
 * @returns {string}
 */
export function maskSecrets(value) {
  if (value == null) return '';
  let text = typeof value === 'string' ? value : String(value);
  for (const rule of RULES) text = text.replace(rule.re, rule.to);
  return text;
}

/**
 * Маскирует секреты в URL: query-параметры и пользовательская часть.
 * @param {string} url
 * @returns {string}
 */
export function maskUrl(url) {
  const raw = String(url ?? '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|secret|password|session|cookie/i.test(key)) u.searchParams.set(key, '***');
    }
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return maskSecrets(u.toString());
  } catch {
    return maskSecrets(raw);
  }
}

/**
 * Маскирует значение секрета для показа в интерфейсе: видны только первые
 * и последние символы, длина — нет.
 * @param {string} value
 * @returns {string}
 */
export function maskValue(value) {
  const s = String(value ?? '');
  if (!s) return '(не задан)';
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}
