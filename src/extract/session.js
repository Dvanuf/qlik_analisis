/**
 * Открытие сессии к движку Qlik (QIX Engine API) через Enigma.js.
 * Общий код для CLI, пакетного режима и десктоп-приложения.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import enigma from 'enigma.js';
import NodeWebSocket from 'ws';
import { buildEngineUrl, ENIGMA_SCHEMA } from './engine.js';

/**
 * @param {{
 *   url: string, cookie?: string, xrfKey?: string, csrfToken?: string,
 *   user?: string, password?: string, insecure?: boolean, appId?: string,
 *   openTimeoutMs?: number,
 * }} options
 * @returns {Promise<{qix: object, session: object, url: string}>}
 */
export async function openEngineSession(options) {
  const {
    url, cookie, xrfKey, csrfToken, user, password, insecure, appId,
    openTimeoutMs = 20000,
  } = options;

  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (xrfKey) headers['X-Qlik-XrfKey'] = xrfKey;
  if (user && password) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  const engineUrl = buildEngineUrl(url, { csrfToken, appId });
  const session = enigma.create({
    schema: ENIGMA_SCHEMA,
    url: engineUrl,
    // Глобальный WebSocket в Node не умеет заголовки — используем пакет ws.
    createSocket: (socketUrl) => new NodeWebSocket(socketUrl, {
      headers,
      ...(insecure ? { rejectUnauthorized: false } : {}),
    }),
  });

  let qix;
  try {
    qix = await Promise.race([
      session.open(),
      new Promise((_r, rejectPromise) => {
        const t = setTimeout(() => rejectPromise(new Error(
          `Превышено время ожидания WebSocket-рукопожатия (${Math.round(openTimeoutMs / 1000)} с).`,
        )), openTimeoutMs);
        t.unref?.();
      }),
    ]);
  } catch (err) {
    try { await session.close(); } catch { /* закрываем мягко */ }
    throw err;
  }

  return { qix, session, url: engineUrl };
}

/**
 * URL хаба без привязки к приложению.
 *
 * Сессия, открытая на конкретном приложении (`/app/<id>`), не даёт серверных
 * методов — вызов GetDocList на ней заканчивается ошибкой «Method not found».
 * Для списка приложений нужен корень хаба.
 *
 * @param {string} url
 * @returns {string}
 */
export function hubRootUrl(url) {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/app\/[^/?#]*/, '');
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return String(url ?? '');
  }
}

/**
 * HTTP-запрос без внешних зависимостей (с учётом самоподписанного сертификата).
 * Редиректы (301/302/303/307/308) следуются автоматически — хаб часто
 * отвечает перенаправлением, а заголовки авторизации при этом сохраняются.
 */
function httpGetJson(url, { headers = {}, insecure = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      ...(insecure ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirects > 0) {
        res.resume();
        const next = new URL(location, u).toString();
        httpGetJson(next, { headers, insecure, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 400) {
          reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Ответ не является JSON: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Список приложений через REST API хаба (Qlik Sense): GET /api/v1/apps.
 *
 * Требует сессионную cookie `X-Qlik-Session` и ключ `X-Qlik-XrfKey` —
 * их приложение получает при входе в хаб.
 *
 * @param {{url: string, cookie?: string, xrfKey?: string, insecure?: boolean}} options
 * @returns {Promise<object[]|null>} null — если хаб не отдал список
 */
export async function listAppsViaHub({ url, cookie, xrfKey, insecure }) {
  if (!cookie) return null;
  let u;
  try {
    u = new URL(hubRootUrl(url));
    u.protocol = u.protocol === 'wss:' ? 'https:' : (u.protocol === 'ws:' ? 'http:' : u.protocol);
    u.search = '';
  } catch {
    return null;
  }
  const headers = { Cookie: cookie };
  if (xrfKey) headers['X-Qlik-XrfKey'] = xrfKey;
  // Пути REST API хаба: основной и запасной (развёртывания отличаются).
  for (const path of ['/api/v1/apps', '/hub/api/v1/apps']) {
    try {
      u.pathname = path;
      const data = await httpGetJson(u.toString(), { headers, insecure });
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      if (!Array.isArray(items)) continue;
      return items.map((a) => ({
        id: a.id ?? a.qAppId ?? a.qDocId ?? '',
        title: a.title ?? a.qTitle ?? a.name ?? '',
        size: a.fileSize ?? a.qFileSize ?? null,
        lastReload: a.modifiedDate ?? a.qLastReloadTime ?? null,
      }));
    } catch {
      // Пробуем следующий путь.
    }
  }
  return null;
}

/**
 * Список приложений, доступных пользователю на сервере.
 *
 * Порядок попыток:
 *  1. REST API хаба (Qlik Sense) — работает всегда, когда есть сессия хаба;
 *  2. движок на корне хаба, метод GetDocList (QlikView 12).
 *
 * На «чужом» методе сервер отвечает «Method not found» — это не сбой,
 * а признак другой платформы, поэтому методы подбираются по очереди.
 *
 * @param {{
 *   url: string, cookie?: string, xrfKey?: string, csrfToken?: string,
 *   user?: string, password?: string, insecure?: boolean,
 * }} options
 * @returns {Promise<object[]>}
 */
export async function listApps(options = {}) {
  // Передан готовый объект движка (например, подставленный в тестах) —
  // используем его, сессию заново не открываем.
  if (typeof options?.getDocList === 'function') {
    const list = await options.getDocList();
    const items = (Array.isArray(list) ? list : ((list?.qItems ?? [])));
    return items.map((d) => ({
      id: d.qDocId ?? d.qAppId ?? '',
      title: d.qTitle ?? d.qDocName ?? '',
      size: d.qFileSize ?? null,
      lastReload: d.qLastReloadTime ?? null,
    }));
  }

  const { url, cookie, xrfKey, csrfToken, user, password, insecure } = options;

  // 1. REST API хаба — основной путь для Qlik Sense.
  const viaHub = await listAppsViaHub({ url, cookie, xrfKey, insecure });
  if (viaHub) return viaHub;

  // 2. Движок на корне хаба — QlikView 12 (Doc API).
  let session = null;
  try {
    const conn = await openEngineSession({
      url: hubRootUrl(url), cookie, xrfKey, csrfToken, user, password, insecure,
    });
    session = conn.session;
    const list = await conn.qix.getDocList?.();
    const items = (Array.isArray(list) ? list : ((list?.qItems ?? [])));
    return items.map((d) => ({
      id: d.qDocId ?? d.qAppId ?? '',
      title: d.qTitle ?? d.qDocName ?? '',
      size: d.qFileSize ?? null,
      lastReload: d.qLastReloadTime ?? null,
    }));
  } catch (err) {
    throw new Error(
      `Не удалось получить список приложений: ${err?.message ?? err}. `
      + 'Проверьте, что в поле URL указан адрес хаба (wss://<host>/app/<appId>) '
      + 'и что выполнен вход в хаб (кнопка «Войти в хаб»).',
      { cause: err },
    );
  } finally {
    try { await session?.close(); } catch { /* закрываем мягко */ }
  }
}
