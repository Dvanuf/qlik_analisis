/**
 * Экстрактор данных приложения из живого Qlik Sense через Enigma.js.
 *
 * Каждый «коллектор» (script, objects, dataModel, variables, bookmarks, perf)
 * выполняется независимо и в try/catch: если конкретная возможность недоступна
 * (старая версия движка, ограничения прав, Qlik Cloud), анализ продолжается,
 * а факт пропуска попадает в отчёт как «пропущенная проверка».
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import enigma from 'enigma.js';
import NodeWebSocket from 'ws';
import { parseLoadScript } from './loadscript.js';
import { extractViaDocApi } from './docapi.js';
import { PLATFORM_SENSE } from '../rules/platforms.js';
import { analyzeScriptIntegrity } from '../script/integrity.js';
import { maskUrl } from '../logging/mask.js';
import { fetchObjects, OBJECT_TYPES } from './objects.js';
import { fetchAssociations } from './associations.js';
import { fetchScriptErrors } from './script-errors.js';
// Схема встраивается в бандл: в собранном приложении node_modules нет,
// и require.resolve('enigma.js/schemas/…') не сработает.
import embeddedSchema from 'enigma.js/schemas/12.34.11.json' with { type: 'json' };

/** Схема QIX Engine API, встроенная в бандл (в т.ч. в упакованное приложение). */
export const ENIGMA_SCHEMA = embeddedSchema;

// createRequire вызывается лениво: в CommonJS-бандле Electron import.meta.url
// недоступен на верхнем уровне модуля, а нужен он только в запасном пути поиска схемы.
let nodeRequire = null;
function requireFromDisk(id) {
  if (!nodeRequire) nodeRequire = createRequire(import.meta.url);
  return nodeRequire(id);
}

function loadSchema(schemaPath) {
  // 1) Явный путь к схеме (--schema).
  if (schemaPath) return JSON.parse(readFileSync(schemaPath, 'utf8'));
  // 2) Схема, встроенная в сборку (десктоп-приложение).
  if (embeddedSchema) return embeddedSchema;
  // 3) Схема из node_modules (запуск из исходников).
  const candidates = [
    'enigma.js/schemas/12.34.11.json',
    'enigma.js/schemas/12.20.0.json',
    'enigma.js/schemas/3.2.json',
  ];
  for (const c of candidates) {
    try {
      return JSON.parse(readFileSync(requireFromDisk(c), 'utf8'));
    } catch {
      /* пробуем следующий */
    }
  }
  throw new Error('Не найдена схема enigma.js. Укажите --schema <путь к json>.');
}

/** Рекурсивно вытаскивает выражения из layout объекта. */
function collectExpressions(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  if (Array.isArray(node)) {
    node.forEach((n) => collectExpressions(n, out, seen));
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'qDef' && typeof value === 'string') {
      out.push({ kind: 'measure', expr: value });
    } else if ((key === 'qFormula' || key === 'qExpr' || key === 'qExpression') && typeof value === 'string') {
      out.push({ kind: 'dimension', expr: value });
    } else if (key === 'qFieldDefs' && Array.isArray(value)) {
      value.forEach((f) => { if (typeof f === 'string') out.push({ kind: 'dimension', expr: f }); });
    } else if (key === 'qExpressions' && Array.isArray(value)) {
      value.forEach((f) => { if (typeof f === 'string') out.push({ kind: 'measure', expr: f }); });
    } else if (typeof value === 'object') {
      collectExpressions(value, out, seen);
    }
  }
  return out;
}

/** Имя/описание объекта из layout. */
function readMeta(layout) {
  const meta = layout?.qMeta ?? {};
  const layoutPart = layout?.qLayout ?? {};
  const name = meta.qName ?? meta.qTitle ?? layoutPart.qTitle ?? '';
  const description = meta.qDescription ?? layoutPart.qDescription ?? '';
  return { name: String(name ?? ''), description: String(description ?? '') };
}

/** Достаёт appId из пути вида /app/<appId>. */
export function appIdFromUrl(url) {
  const m = String(url ?? '').match(/\/app\/([^/?#]+)/);
  return m ? m[1] : undefined;
}

/**
 * Собирает URL движка для Qlik Sense / QlikView за forms-auth прокси:
 * требуются query-параметры reloadUri и qlik-csrf-token.
 */
export function buildEngineUrl(url, { csrfToken, appId } = {}) {
  if (!csrfToken) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.get('qlik-csrf-token')) {
      u.searchParams.set('qlik-csrf-token', csrfToken);
    }
    if (!u.searchParams.get('reloadUri')) {
      const id = appId ?? appIdFromUrl(url);
      // reloadUri — это адрес страницы приложения в хабе, то есть https, а не wss.
      if (id) u.searchParams.set('reloadUri', `https://${u.host}/sense/app/${id}`);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * @param {{
 *   url: string, schemaPath?: string, apiKey?: string, measurePerf?: boolean,
 *   user?: string, password?: string, qlikUser?: string, insecure?: boolean,
 *   cookie?: string, xrfKey?: string, csrfToken?: string, appId?: string,
 *   openTimeoutMs?: number,
 * }} config
 * @returns {Promise<object>} граф приложения
 */
export async function extractFromEngine(config) {
  const {
    url, schemaPath, apiKey, measurePerf = false,
    user, password, qlikUser, insecure = false, cookie, xrfKey, csrfToken, appId,
  } = config;

  const schema = loadSchema(schemaPath);
  const engineUrl = buildEngineUrl(url, { csrfToken, appId });
  const targetAppId = appId ?? appIdFromUrl(engineUrl);

  // Заголовки авторизации:
  //  - Qlik Cloud: Authorization: Bearer <API key>;
  //  - Qlik Sense Enterprise on Windows: Basic-аутентификация доменного пользователя;
  //  - X-Qlik-User — имперсонация пользователя на Qlik Sense Server.
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  else if (user && password) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }
  if (qlikUser) headers['X-Qlik-User'] = qlikUser;
  // Сессионная cookie хаба (X-Qlik-Session) — способ доступа к движку за forms-auth прокси.
  if (cookie) headers.Cookie = cookie;
  // XSRF-ключ хаба: без него прокси отвечает 403 (XSRF prevention check failed).
  if (xrfKey) headers['X-Qlik-XrfKey'] = xrfKey;

  const socketOptions = {
    headers,
    ...(insecure ? { rejectUnauthorized: false } : {}),
  };

  const session = enigma.create({
    schema,
    url: engineUrl,
    // Глобальный WebSocket в Node не умеет заголовки — используем пакет ws.
    createSocket: (socketUrl) => new NodeWebSocket(socketUrl, socketOptions),
  });

  const capabilities = [];
  const skipped = [];
  const openTimeoutMs = config.openTimeoutMs ?? 15000;
  let qix;
  try {
    // Рукопожатие ограничено по времени: «молчащий» сервер иначе держит сокет
    // и процесс открытым бесконечно.
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
    try { await session.close(); } catch { /* закрываем сессию мягко */ }
    throw err;
  }
  // QlikView Server 12 / Doc API: глобальный объект не имеет get('App'),
  // документ открывается через openDoc().
  if (typeof qix.get !== 'function') {
    try {
      if (!targetAppId) {
        throw new Error('Не удалось определить appId: укажите --app-id или используйте URL вида wss://host/app/<appId>');
      }
      const docGraph = await extractViaDocApi(qix, targetAppId, (m) => console.error(m));
      // В отчёте и логах адрес должен быть без CSRF-токена.
      docGraph.meta.url = maskUrl(engineUrl);
      return docGraph;
    } finally {
      try { await session.close(); } catch { /* закрываем сессию мягко */ }
    }
  }

  const app = qix.get('App');
  const graph = {
    meta: {
      source: 'engine',
      url: maskUrl(url),
      generatedAt: new Date().toISOString(),
      // QIX Engine API есть только у Qlik Sense / Qlik Cloud.
      platform: PLATFORM_SENSE,
      thumbnail: null,
      associations: [],
    },
    appName: '', appId: '', script: '',
    sheets: [], objects: [], variables: [], fields: [], tables: [], bookmarks: [], extensions: [],
    stories: [], masterObjects: [], connections: [],
  };

  const attempt = async (name, fn, fallback) => {
    try {
      const value = await fn();
      capabilities.push(name);
      return value;
    } catch (err) {
      skipped.push({ capability: name, reason: err?.message ?? String(err) });
      return fallback;
    }
  };

  try {
    const layout = await attempt('appLayout', () => app.getAppLayout(), null);
    graph.appName = layout?.qTitle ?? '';
    graph.appId = layout?.qAppId ?? '';

    const script = await attempt('script', () => app.getScript(), '');
    graph.script = typeof script === 'string' ? script : '';
    // Признаки обрезанного скрипта: правило S010 понижает важность, если текст пришёл не полностью.
    graph.meta.scriptInfo = analyzeScriptIntegrity(graph.script);
    const parsedScript = parseLoadScript(graph.script);

    // --- Ошибки скрипта по данным сервера ---
    // Сервер проверяет скрипт сам и знает номер строки каждой ошибки:
    // без этого в отчёте было видно лишь «ошибка где-то в скрипте».
    // Поле заполняется только при успешной проверке: пустой массив означает
    // «ошибок нет», а отсутствие поля — «проверка не выполнена».
    const scriptErrors = await attempt('scriptErrors', () => fetchScriptErrors(app), null);
    if (scriptErrors) graph.meta.scriptErrors = scriptErrors;

    // --- Модель данных (таблицы, поля, ключи) ---
    const dataModel = await attempt('dataModel', async () => {
      const res = await app.getTablesAndKeys(
        { qRows: 1000, qCols: 10 }, { qRows: 10, qCols: 10 }, 15, false, false,
      );
      return { qtr: res?.qtr ?? [], qk: res?.qk ?? [] };
    }, null);

    if (dataModel) {
      const keyMap = new Map();
      for (const rec of dataModel.qk ?? []) {
        for (const t of rec.qTables ?? []) keyMap.set(t, rec.qKeyFields ?? []);
      }
      for (const t of dataModel.qtr ?? []) {
        const fields = (t.qFields ?? []).map((f) => ({
          name: f.qName,
          table: t.qName,
          tags: f.qTags ?? [],
          key: (keyMap.get(t.qName) ?? []).includes(f.qName),
          rows: f.qnRows ?? null,
          nonNulls: f.qnNonNulls ?? null,
          distinct: f.qnTotalDistinctValues ?? null,
          hasNull: f.qHasNull ?? null,
          informationDensity: f.qInformationDensity ?? null,
          subsetRatio: f.qSubsetRatio ?? null,
        }));
        graph.tables.push({
          name: t.qName,
          rows: t.qNoOfRows ?? null,
          fields: fields.map((f) => f.name),
          keyFields: keyMap.get(t.qName) ?? [],
          synthetic: Boolean(t.qIsSynthetic) || (keyMap.get(t.qName) ?? []).length > 1,
          directDiscovery: Boolean(t.qIsDirectDiscovery),
        });
        graph.fields.push(...fields);
      }
    } else {
      for (const t of parsedScript.tables) {
        graph.tables.push({ name: t.name, rows: null, fields: t.fields, keyFields: [], synthetic: false });
        graph.fields.push(...t.fields.map((name) => ({ name, table: t.name, tags: [], key: false })));
      }
    }

    // --- Объекты приложения ---
    // Типы запрашиваем блоками: сервер отвергает вызов целиком, если в списке
    // есть незнакомый ему тип, — тогда потерялись бы сразу все объекты.
    const objectList = await attempt('objects', async () => {
      const { items, skipped: failed } = await fetchObjects(app, OBJECT_TYPES);
      for (const f of failed) {
        skipped.push({ capability: 'objects', reason: `тип ${f.type}: ${f.reason}` });
      }
      return items;
    }, []);

    for (const info of objectList ?? []) {
      const id = info?.qId;
      const type = info?.qType;
      if (!id) continue;
      if (type === 'sheet' || type === 'story') {
        const sheet = await attempt(`sheet:${id}`, () => app.getObject(id).then((o) => o.getLayout()), null);
        const meta = readMeta(sheet ?? {});
        graph.sheets.push({ id, name: meta.name || id, type, description: meta.description });
        // Истории (stories) — отдельный перечень: в QSME у них своя вкладка.
        if (type === 'story') {
          graph.stories.push({ id, name: meta.name || id, type, description: meta.description });
        }
        continue;
      }
      if (type === 'extension') {
        graph.extensions.push({ id, name: id, type });
        continue;
      }
      const obj = await attempt(`object:${id}`, () => app.getObject(id).then((o) => o.getLayout()), null);
      if (!obj) continue;
      const meta = readMeta(obj);
      const unique = [];
      const seen = new Set();
      for (const e of collectExpressions(obj)) {
        const key = `${e.kind}:${e.expr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(e);
      }
      graph.objects.push({
        id, name: meta.name || id, type,
        description: meta.description, expressions: unique, layoutMs: null,
      });
    }

    // --- Переменные: имена из скрипта, значения уточняем у движка ---
    const varNames = new Set();
    const varRe = /\b(?:LET|SET)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    let m;
    while ((m = varRe.exec(graph.script)) !== null) varNames.add(m[1]);

    for (const name of varNames) {
      let value = '';
      const details = await attempt(`variable:${name}`, () => app.getVariable(name), null);
      if (details) {
        const raw = details.qDefinition ?? details.qValue ?? '';
        value = typeof raw === 'string' ? raw : String(raw ?? '');
      }
      graph.variables.push({ name, value, description: '' });
    }

    // --- Связи между таблицами (правило про внешний join) ---
    // Текст ответа сервера сохраняем: по нему видно, поддерживает ли сервер
    // метод и почему нет — иначе причина неприменимости R011 остаётся загадкой.
    const { associations, reason } = await fetchAssociations(app, graph.tables);
    if (associations) {
      graph.meta.associations = associations;
      capabilities.push('associations');
    } else {
      skipped.push({ capability: 'associations', reason });
    }

    // --- Закладки ---
    const bm = await attempt('bookmarks', async () => {
      const res = await app.getBookmarks({});
      return res?.qItems ?? [];
    }, []);
    for (const b of bm ?? []) {
      const meta = b?.qMeta ?? {};
      graph.bookmarks.push({
        id: meta.qId ?? '',
        name: meta.qName ?? meta.qTitle ?? '',
        objectIds: (b?.qObjects ?? []).map((o) => o?.qId).filter(Boolean),
      });
    }

    // --- Замер времени расчёта (опционально) ---
    if (measurePerf) {
      for (const obj of graph.objects) {
        const started = Date.now();
        await attempt(`perf:${obj.id}`, async () => {
          const o = await app.getObject(obj.id);
          await o.getLayout();
        }, null);
        obj.layoutMs = Date.now() - started;
      }
      capabilities.push('perf');
    }

    graph.meta.capabilities = capabilities;
    graph.meta.skipped = skipped;
    graph.meta.scriptFields = parsedScript.scriptFields;
    graph.meta.scriptOperations = parsedScript.operations;
  } finally {
    try { await session.close(); } catch { /* закрываем сессию мягко */ }
  }

  return graph;
}
