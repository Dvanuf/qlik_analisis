/**
 * REST API хаба Qlik Sense — метаданные приложений (владелец, поток, тэги).
 *
 * Хаб отдаёт данные по адресу '/api/hub/v1/…' — это видно в его собственном
 * бандле (модуль 'hub/core/services/comm/mocks/enigma': база 'basePath + api/hub/',
 * версия берётся из '/api/hub/about'). Старое расположение '/api/v1/apps' на части
 * развёртываний отдаёт 501, поэтому осталось запасным путём.
 *
 * Формат ответа — JSON:API:
 *   {
 *     data: [{ type: 'App', id: '…',
 *              attributes: { name, fileSize, lastReloadTime, published,
 *                            customProperties: [{ value, definition: { name } }] },
 *              relationships: { owner:  { data: { type: 'User',   id } },
 *                               stream: { data: { type: 'Stream', id } } } }],
 *     included: [{ type: 'User',   id, attributes: { name } },
 *                { type: 'Stream', id, attributes: { name } }]
 *   }
 *
 * Имена владельца и потока лежат в 'included', а не в 'data': по идентификатору
 * из 'relationships' без 'included' получить нечего. Отдельной сущности 'tags'
 * в API нет — это свойства приложения ('customProperties'), и в интерфейсе хаба
 * они показываются как «Свойство:Значение».
 */
import { httpGetJson } from './http.js';
import { maskUrl } from '../logging/mask.js';

/**
 * Базовый адрес REST API хаба: 'https://<host>/api/hub/v1'.
 *
 * Схема ws/wss приводится к http/https, путь до приложения (/app/<id>)
 * отбрасывается — у хаба своя база ('/' или '/hub/').
 *
 * @param {string} url — адрес движка ('wss://host/app/<id>')
 * @returns {string|null}
 */
export function hubApiBase(url) {
  try {
    const u = new URL(String(url));
    const scheme = u.protocol === 'ws:' ? 'http:' : (u.protocol === 'wss:' ? 'https:' : u.protocol);
    if (scheme !== 'http:' && scheme !== 'https:') return null;
    const base = u.pathname.replace(/\/app(\/[^/?#]*)?.*$/, '').replace(/\/+$/, '');
    return `${scheme}//${u.host}${base}/api/hub/v1`;
  } catch {
    return null;
  }
}

/**
 * Разбор ответа '/api/hub/v1/apps' — метаданные по идентификатору приложения.
 *
 * @param {object} payload — разобранный JSON
 * @returns {{byId: Map<string, object>, users: Map<string, string>, streams: Map<string, string>}}
 */
export function parseHubApps(payload) {
  const users = new Map();
  const streams = new Map();
  for (const res of payload?.included ?? []) {
    const name = typeof res?.attributes?.name === 'string' ? res.attributes.name.trim() : '';
    if (!name) continue;
    if (res.type === 'User') users.set(res.id, name);
    else if (res.type === 'Stream') streams.set(res.id, name);
  }

  const byId = new Map();
  for (const app of payload?.data ?? []) {
    if (!app?.id) continue;
    const attrs = app.attributes ?? {};
    const ownerId = app.relationships?.owner?.data?.id ?? null;
    const streamId = app.relationships?.stream?.data?.id ?? null;
    const tags = [];
    for (const cp of attrs.customProperties ?? []) {
      const value = typeof cp?.value === 'string' ? cp.value.trim() : '';
      if (!value) continue;
      const def = typeof cp?.definition?.name === 'string' ? cp.definition.name.trim() : '';
      tags.push(def ? `${def}:${value}` : value);
    }
    byId.set(app.id, {
      id: app.id,
      title: typeof attrs.name === 'string' ? attrs.name : '',
      size: Number.isFinite(attrs.fileSize) ? attrs.fileSize : null,
      lastReload: attrs.lastReloadTime ?? null,
      published: typeof attrs.published === 'boolean' ? attrs.published : null,
      owner: ownerId ? (users.get(ownerId) ?? null) : null,
      stream: streamId ? (streams.get(streamId) ?? null) : null,
      tags,
    });
  }
  return { byId, users, streams };
}

/**
 * Запрос списка приложений у REST API хаба (JSON:API).
 *
 * Запрашиваются 'include=owner,stream' — без этого хаб не вернёт имена владельцев
 * и потоков, а только их идентификаторы.
 *
 * @param {{url: string, cookie?: string, xrfKey?: string, insecure?: boolean}} options
 * @returns {Promise<{ok: boolean, byId?: Map<string, object>, note: string}>}
 */
export async function fetchHubApps({ url, cookie, xrfKey, insecure = false }) {
  const base = hubApiBase(url);
  if (!base) return { ok: false, note: 'не удалось определить адрес REST API хаба' };
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (xrfKey) headers['X-Qlik-XrfKey'] = xrfKey;
  const qs = new URLSearchParams({ include: 'owner,stream' });
  if (xrfKey) qs.set('xrfkey', xrfKey);
  const target = `${base}/apps?${qs.toString()}`;
  try {
    const payload = await httpGetJson(target, { headers, insecure });
    const { byId } = parseHubApps(payload);
    if (!byId.size) return { ok: false, note: `${maskUrl(target)} → в ответе нет приложений` };
    return { ok: true, byId, note: `${maskUrl(target)} → приложений ${byId.size}` };
  } catch (err) {
    return { ok: false, note: `${maskUrl(target)} → ${err?.message ?? err}` };
  }
}
