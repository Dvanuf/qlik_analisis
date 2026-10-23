/**
 * Приведение URL движка Qlik к рабочему формату.
 *
 * Модуль намеренно без зависимостей — его используют и ядро (Node),
 * и интерфейс десктоп-приложения (браузер).
 */

/**
 * Служебный адрес движка Qlik Sense (`/app/engineData`) — это не приложение,
 * по нему нельзя открыть документ.
 */
const ENGINE_DATA = 'engineData';

/**
 * Идентификатор приложения из адреса движка.
 * @param {string} raw
 * @returns {string|null} null — если приложения в адресе нет
 */
export function appIdFromUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const id = new URL(text).pathname.match(/\/app\/([^/?#]+)/)?.[1] ?? '';
    if (!id || id === ENGINE_DATA) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * Приводит любой вариант адреса к формату `wss://<host>/app/<appId>`.
 *
 * Принимает: `host`, `host:4747`, `http://host`, `https://host`,
 * `ws://host/app/<id>`, `wss://host/sense/app/<id>` и т. п.
 *
 * Правила выбора схемы:
 *  - порт 4747 — http на стороне движка → `ws://`;
 *  - порт 4746 — https → `wss://`;
 *  - `http://` → `ws://`, `https://` → `wss://`;
 *  - без схемы — `wss://` (хаб через 443).
 *
 * @param {string} raw — введённый пользователем адрес
 * @param {{appId?: string}} [options] — appId, если он известен из UI
 * @returns {string} приведённый адрес (пустая строка, если вход пустой)
 */
export function normalizeEngineUrl(raw, { appId } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  // Схемы может не быть: «host» или «host:4747».
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return text;
  }

  // appId из пути: /app/<id> или /sense/app/<id>.
  // Адрес, который ввёл пользователь, важнее подставленного из UI.
  const rawId = u.pathname.match(/\/app\/([^/?#]+)/)?.[1] ?? '';
  const fromPath = rawId && rawId !== ENGINE_DATA ? rawId : '';
  const id = fromPath || appId || '';

  const port = u.port;
  let scheme;
  if (port === '4747') scheme = 'ws';
  else if (port === '4746') scheme = 'wss';
  else if (u.protocol === 'http:') scheme = 'ws';
  else if (u.protocol === 'https:') scheme = 'wss';
  else if (u.protocol === 'ws:' || u.protocol === 'wss:') scheme = u.protocol.slice(0, -1);
  else scheme = 'wss';

  const host = u.hostname;
  const portPart = port ? `:${port}` : '';
  return id
    ? `${scheme}://${host}${portPart}/app/${id}`
    : `${scheme}://${host}${portPart}/app`;
}

/**
 * Убирает query-параметры из адреса движка.
 *
 * Адрес, перехваченный из рукопожатия, выглядит так:
 * `wss://host/app/<id>?reloadUri=…&qlik-csrf-token=…` — в поле URL
 * нужен чистый адрес без параметров.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanEngineUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const u = new URL(text);
    u.search = '';
    u.hash = '';
    // /app/engineData — служебный адрес, а не приложение.
    if (u.pathname.endsWith(`/app/${ENGINE_DATA}`)) u.pathname = '/app';
    return u.toString();
  } catch {
    return text.split('?')[0].split('#')[0];
  }
}
