/**
 * Открытие сессии к движку Qlik (QIX Engine API) через Enigma.js.
 * Общий код для CLI, пакетного режима и десктоп-приложения.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import enigma from 'enigma.js';
import NodeWebSocket from 'ws';
import { buildEngineUrl, ENIGMA_SCHEMA } from './engine.js';
import { hubRootUrl, hubAppUrl, engineDataUrl, appIdFromUrl } from './url.js';
import { maskUrl } from '../logging/mask.js';

/**
 * Пути REST API хаба, где может лежать список приложений.
 * У развёртываний база бывает и в корне, и под /hub/.
 */
const HUB_APP_PATHS = [
  '/api/v1/apps',
  '/hub/api/v1/apps',
  '/api/v1/documents',
  '/hub/api/v1/documents',
];

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
 * Поток, владелец и тэги приложения.
 *
 * Не все платформы их отдают: у QlikView Doc API в GetDocList таких полей нет,
 * тогда в интерфейсе показывается «не указан», а фильтры группируют такие
 * приложения вместе.
 *
 * @param {object} d — элемент ответа сервера
 */
export function appMeta(d) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = d?.[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      // Некоторые развёртывания отдают объект: { qName: '...' } или { name: '...' }.
      if (v && typeof v === 'object') {
        const inner = v.qName ?? v.name ?? v.value ?? v.id;
        if (typeof inner === 'string' && inner.trim()) return inner.trim();
      }
    }
    return null;
  };
  return {
    stream: pick('qStream', 'stream', 'qAppStream', 'qGroup', 'group'),
    owner: pick('qOwner', 'owner', 'qAppOwner', 'qUser', 'user', 'qModifiedBy'),
    tags: pickTags(d),
  };
}

/**
 * Тэги приложения.
 *
 * Формат разный: список строк (`['етка']`) или список объектов
 * (`[{ qName: 'етка' }]`). Имена полей тоже различаются — поэтому
 * перебираем варианты и берём первый непустой.
 *
 * @param {object} d — элемент ответа сервера
 * @returns {string[]} список тэгов (пустой, если сервер их не отдал)
 */
export function pickTags(d) {
  const sources = ['qTags', 'tags', 'qAppTags', 'tagNames', 'qTagList', 'labels'];
  for (const key of sources) {
    const raw = d?.[key];
    if (!raw) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (const item of list) {
      let name = '';
      if (typeof item === 'string') name = item;
      else if (item && typeof item === 'object') {
        const inner = item.qName ?? item.name ?? item.value ?? item.title;
        if (typeof inner === 'string') name = inner;
      }
      const text = name.trim();
      if (text && !out.includes(text)) out.push(text);
    }
    if (out.length) return out;
  }
  return [];
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
export async function listAppsViaHub({ url, cookie, xrfKey, insecure, log = null }) {
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
  // Пути REST API хаба: у развёртываний база бывает и /, и /hub/.
  for (const path of HUB_APP_PATHS) {
    try {
      u.pathname = path;
      const data = await httpGetJson(u.toString(), { headers, insecure });
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      if (!Array.isArray(items)) {
        log?.(`хаб ${path}: ответ без поля items`);
        continue;
      }
      log?.(`хаб ${path}: приложений ${items.length}`);
      return items.map((a) => ({
        id: a.id ?? a.qAppId ?? a.qDocId ?? '',
        title: a.title ?? a.qTitle ?? a.name ?? '',
        size: a.fileSize ?? a.qFileSize ?? null,
        lastReload: a.modifiedDate ?? a.qLastReloadTime ?? null,
        ...appMeta(a),
      }));
    } catch (err) {
      log?.(`хаб ${path}: ${err?.message ?? err}`);
    }
  }
  return null;
}

/**
 * Дополняет список приложений метаданными (поток, владелец, тэги).
 *
 * Список приложений движка (GetDocList) содержит лишь идентификатор,
 * название, размер и дату перезагрузки — потока, владельца и тэгов там нет.
 * А хаб их знает: REST API отдаёт эти поля. Поэтому список из движка
 * дополняется данными хаба — иначе фильтры по потоку, владельцу и тэгам
 * остаются пустыми.
 *
 * Приложения, которых нет в ответе хаба, остаются без метаданных:
 * так честнее, чем подставлять выдуманные значения.
 *
 * @param {object[]} apps — список приложений из движка
 * @param {object} options — параметры подключения к хабу
 * @returns {Promise<object[]>} тот же список с заполненными метаданными
 */
export async function enrichAppsWithHubMeta(apps, options = {}) {
  const list = apps ?? [];
  if (!list.length) return list;
  const hub = await listAppsViaHub(options);
  if (!hub || !hub.length) return list;

  const byId = new Map();
  const byTitle = new Map();
  for (const a of hub) {
    if (a.id) byId.set(String(a.id), a);
    const title = String(a.title ?? '').trim().toLowerCase();
    if (title) byTitle.set(title, a);
  }

  let enriched = 0;
  const out = list.map((app) => {
    const meta = byId.get(String(app.id)) ?? byTitle.get(String(app.title ?? '').trim().toLowerCase());
    if (!meta) return { ...app, tags: app.tags ?? [] };
    enriched += 1;
    return {
      ...app,
      // Поток, владелец и тэги берём из хаба; если там пусто — оставляем
      // то, что отдал движок.
      stream: meta.stream ?? app.stream ?? null,
      owner: meta.owner ?? app.owner ?? null,
      tags: (meta.tags?.length ? meta.tags : (app.tags ?? [])),
      lastReload: app.lastReload ?? meta.lastReload ?? null,
    };
  });
  options.log?.(`хаб: метаданные ${enriched} из ${list.length} приложений`);
  return out;
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
      ...appMeta(d),
    }));
  }

  const {
    url, cookie, xrfKey, csrfToken, user, password, insecure, log = null,
  } = options;
  // Дополнение метаданными (поток, владелец, тэги) — отдельным запросом к хабу.
  const hubOptions = { url, cookie, xrfKey, insecure, log };
  // Что именно пробовали — попадёт в текст ошибки, чтобы не гадать.
  // Адреса маскируются: в URL может быть CSRF-токен.
  const notes = [];
  const note = (m) => {
    const safe = maskUrl(String(m));
    notes.push(safe);
    log?.(safe);
  };

  // 1. Движок, метод GetDocList — работает и на Qlik Sense, и на QlikView.
  //    Сессия открывается по адресу приложения: корневые адреса хаба
  //    переадресуются (301), а csrf-токен в URL обязателен (иначе 403).
  //    Запасной адрес — служебный /app/engineData, через него хаб тоже
  //    отдаёт список приложений.
  //    Служебный адрес /app/engineData идёт первым: он не открывает документ,
  //    поэтому приложение остаётся свободным для последующего анализа
  //    (иначе сервер отвечает «App already open»).
  const candidates = [engineDataUrl(url)];
  if (appIdFromUrl(url)) candidates.push(url);
  let lastError = null;
  for (const candidate of candidates) {
    let conn = null;
    try {
      conn = await openEngineSession({
        url: candidate, cookie, xrfKey, csrfToken, user, password, insecure,
      });
      const list = await conn.qix.getDocList?.();
      const items = (Array.isArray(list) ? list : ((list?.qItems ?? [])));
      note(`движок ${candidate}: приложений ${items.length}`);
      const apps = items.map((d) => ({
        id: d.qDocId ?? d.qAppId ?? '',
        title: d.qTitle ?? d.qDocName ?? '',
        size: d.qFileSize ?? null,
        lastReload: d.qLastReloadTime ?? null,
        ...appMeta(d),
      }));
      // Список из движка не содержит потока, владельца и тэгов — берём их у хаба.
      return enrichAppsWithHubMeta(apps, hubOptions);
    } catch (err) {
      lastError = err;
      note(`движок ${candidate}: ${err?.message ?? err}`);
    } finally {
      try { await conn?.session?.close(); } catch { /* закрываем мягко */ }
    }
  }

  // 2. REST API хаба — запасной путь (на части развёртываний REST отдаёт 501).
  const viaHub = await listAppsViaHub({ url, cookie, xrfKey, insecure, log: note });
  if (viaHub) return viaHub;

  throw new Error(
    `Не удалось получить список приложений: ${lastError?.message ?? 'неизвестная ошибка'}. `
    + (notes.length ? `Пробовали: ${notes.join('; ')}. ` : '')
    + 'Проверьте, что в поле URL указан адрес хаба (wss://<host>/app/<appId>) '
    + 'и что выполнен вход в хаб (кнопка «Войти в хаб»).',
    { cause: lastError },
  );
}
