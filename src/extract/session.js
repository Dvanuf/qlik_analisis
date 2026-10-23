/**
 * Открытие сессии к движку Qlik (QIX Engine API) через Enigma.js.
 * Общий код для CLI, пакетного режима и десктоп-приложения.
 */
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
 * Список приложений, доступных пользователю на сервере.
 *
 * Метод зависит от платформы, и «лишний» метод не просто отсутствует —
 * сервер отвечает на него ошибкой «Method not found»:
 *  - Qlik Sense (QIX Engine API) — GetAppList;
 *  - QlikView 12 (Doc API)       — GetDocList.
 * Поэтому пробуем оба и берём тот, который ответил.
 */
export async function listApps(qix) {
  let list = null;
  let lastError = null;
  for (const method of ['getAppList', 'getDocList']) {
    const fn = qix?.[method];
    if (typeof fn !== 'function') continue;
    try {
      list = await fn.call(qix);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!list) {
    throw lastError ?? new Error('Сервер не поддерживает получение списка приложений');
  }
  const items = (Array.isArray(list) ? list : ((list?.qItems ?? [])));
  return items.map((d) => ({
    // У Qlik Sense — qAppId, у QlikView — qDocId.
    id: d.qAppId ?? d.qDocId ?? '',
    title: d.qTitle ?? d.qDocName ?? '',
    size: d.qFileSize ?? null,
    lastReload: d.qLastReloadTime ?? null,
  }));
}
