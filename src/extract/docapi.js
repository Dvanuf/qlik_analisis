/**
 * Экстракт через QlikView-совместимый Doc API (QlikView Server 12.x).
 *
 * В отличие от QIX App API (Qlik Sense 12 / Qlik Cloud), здесь глобальный объект
 * не имеет метода get('App'), а документ открывается через openDoc() и сам
 * предоставляет методы getScript / getAppLayout / getTablesAndKeys / getObject.
 */
import { parseLoadScript } from './loadscript.js';
import { PLATFORM_VIEW } from '../rules/platforms.js';
import { analyzeScriptIntegrity } from '../script/integrity.js';
import { fetchAssociations } from './associations.js';
import { fetchObjects, fetchLayout, fetchSheetChildren, hasCalcCondition, OBJECT_TYPES } from './objects.js';
import { detectPlatform } from '../rules/platforms.js';
import {
  fetchInventory, fetchDataConnections, readObjectTitle, readObjectDefinition,
  CONTENT_TYPES, SERVICE_TYPES,
} from './metadata.js';
import { extractObjectExpressions, CONTAINER_TYPES } from './expressions.js';

/**
 * Приводит значение qGroupFieldDefs к виду выражения.
 *
 * Там бывают и имена полей (`User ID`), и выражения (`=Month`, `=Sum([Amount])`).
 * Имя с пробелами без скобок не является ссылкой на поле, поэтому разбор
 * выражений его не узнаёт — и поле ошибочно считается неиспользуемым.
 *
 * @param {string} value — значение из qGroupFieldDefs
 * @returns {string} выражение
 */
function readMeta(layout, fallbackId = '') {
  const meta = layout?.qMeta ?? {};
  const layoutPart = layout?.qLayout ?? {};
  return {
    // Название объекта сервер отдаёт по-разному: qName, qTitle или title.
    name: String(meta.qName ?? meta.qTitle ?? meta.title ?? layoutPart.qTitle ?? fallbackId ?? ''),
    description: String(meta.qDescription ?? meta.description ?? layoutPart.qDescription ?? ''),
  };
}

/**
 * @param {object} qix — глобальный объект Doc API
 * @param {string} appId — идентификатор документа
 * @param {(msg: string) => void} [log]
 */
/**
 * Строит граф приложения по уже открытому документу.
 * Вынесено отдельно, чтобы пакетный режим мог переиспользовать одну сессию
 * движка для всех приложений (не открывать соединение на каждое).
 *
 * @param {object} app — открытый документ (Doc API)
 * @param {string} appId
 * @param {(msg: string) => void} [log]
 */
export async function buildGraphFromDoc(app, appId, log = () => {}) {
  const capabilities = [];
  const skipped = [];

  const appLayout = await app.getAppLayout().catch(() => null);
  const appProps = await app.getAppProperties().catch(() => null);
  capabilities.push('appLayout');

  const script = await app.getScript();
  capabilities.push('script');

  const graph = {
    meta: {
      source: 'doc-api',
      api: 'QlikView Doc API',
      generatedAt: new Date().toISOString(),
      // Платформа уточняется по собранным объектам: через Doc API доступен
      // и Qlik Sense (см. detectPlatform), поэтому по одному API судить нельзя.
      platform: PLATFORM_VIEW,
      capabilities,
      skipped,
      productVersion: appProps?.qSavedInProductVersion ?? '',
      lastReload: appLayout?.qLastReloadTime ?? appProps?.qLastReloadTime ?? '',
      thumbnail: appProps?.qThumbnail ?? null,
      associations: [],
    },
    appName: appLayout?.qTitle ?? appProps?.qTitle ?? appId,
    appId: appLayout?.qFileName ?? appId,
    script: typeof script === 'string' ? script : '',
    sheets: [],
    objects: [],
    variables: [],
    fields: [],
    tables: [],
    bookmarks: [],
    extensions: [],
    masterObjects: [],
    connections: [],
    stories: [],
  };

  // --- Модель данных ---
  const dataModel = await app.getTablesAndKeys(
    { qRows: 1000, qCols: 10 },
    { qRows: 10, qCols: 10 },
    15,
    false,
    false,
  ).catch((err) => {
    skipped.push({ capability: 'dataModel', reason: err?.message ?? String(err) });
    return null;
  });
  if (dataModel) {
    capabilities.push('dataModel');
    const keyMap = new Map();
    for (const rec of dataModel.qk ?? []) {
      for (const t of rec.qTables ?? []) keyMap.set(t, rec.qKeyFields ?? []);
    }
    for (const t of dataModel.qtr ?? []) {
      const fields = (t.qFields ?? []).map((f) => ({
        name: f.qName,
        table: t.qName,
        tags: f.qTags ?? [],
        key: (keyMap.get(t.qName) ?? []).includes(f.qName)
          || String(f.qKeyType ?? '').toUpperCase() !== 'NOT_KEY',
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
  }

  // --- Объекты (листы и визуализации) ---
  // Элементы приходят в двух форматах: QIX App API — {qId, qType},
  // Doc API — {qInfo: {qId, qType}}. Разбор приводит их к общему виду,
  // иначе сервер отдаёт объекты, а они молча отбрасываются.
  const { items: listedObjects, skipped: failedTypes } = await fetchObjects(app, OBJECT_TYPES);
  for (const f of failedTypes) {
    skipped.push({ capability: 'objects', reason: `тип ${f.type}: ${f.reason}` });
  }

  // Полный перечень объектов: он включает типы, которых нет в списке типов
  // движка (master-объекты, закладки, служебные). По нему же сверяем,
  // всё ли собрано — иначе об отсутствии объектов можно и не узнать.
  const inventory = await fetchInventory(app);
  if (inventory.available) capabilities.push('inventory');

  // Объекты, лежащие на листах: их нет в списке типов движка, но без них
  // часть фронт-энда (KPI, фильтры, кнопки) остаётся невидимой.
  const sheetLike = listedObjects.filter((o) => o.type === 'sheet' || o.type === 'story');
  const { objects: children, sheetOf } = await fetchSheetChildren(app, sheetLike);
  const items = [...listedObjects];
  const knownIds = new Set(listedObjects.map((o) => o.id));
  for (const child of children) {
    if (knownIds.has(child.id)) continue;
    knownIds.add(child.id);
    items.push(child);
  }

  // Объекты из полного перечня, которых нет ни в списке по типам, ни на листах.
  const masters = [];
  for (const entry of inventory.items) {
    if (knownIds.has(entry.id)) continue;
    if (SERVICE_TYPES.has(entry.type)) continue;
    if (entry.type === 'masterobject') {
      // Master-объект: собираем его отдельно — это не содержимое листа,
      // а переиспользуемое определение, и правила проверяют его отдельно.
      const layout = await fetchLayout(app, entry.id);
      if (!layout) continue;
      masters.push({
        id: entry.id,
        name: readObjectTitle(layout, entry.id),
        description: String(layout?.qMeta?.description ?? layout?.qMeta?.qDescription ?? ''),
        definition: readObjectDefinition(layout),
      });
      knownIds.add(entry.id);
      continue;
    }
    if (CONTENT_TYPES.has(entry.type)) {
      items.push({ id: entry.id, type: entry.type, name: '', description: '' });
      knownIds.add(entry.id);
    }
  }
  if (items.length) capabilities.push('objects');
  if (masters.length) capabilities.push('masterObjects');

  // Полнота сбора: сколько объектов перечислил сервер и сколько мы собрали.
  const expected = inventory.items.filter((e) => !SERVICE_TYPES.has(e.type));
  graph.meta.inventory = {
    available: inventory.available,
    expected: expected.length,
    collected: items.length + masters.length,
    missing: expected.filter((e) => !knownIds.has(e.id)).map((e) => e.type),
  };

  for (const info of items) {
    const { id, type } = info;
    const layout = await fetchLayout(app, id);
    if (!layout) continue;
    const meta = readMeta(layout, id);
    if (type === 'sheet' || type === 'story') {
      graph.sheets.push({ id, name: meta.name || id, type, description: meta.description });
      // Истории (stories) — отдельный перечень: в QSME у них своя вкладка.
      if (type === 'story') {
        graph.stories.push({ id, name: meta.name || id, type, description: meta.description });
      }
      continue;
    }
    const unique = [];
    const seen = new Set();
    const extracted = extractObjectExpressions(layout);
    for (const e of extracted.expressions) {
      const key = `${e.kind}:${e.expr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(e);
    }
    graph.objects.push({
      id, name: meta.name || info.name || id, type,
      description: meta.description || info.description,
      expressions: unique, layoutMs: null,
      // Признак тяжёлого объекта: без условия вычисления он пересчитывается
      // при каждом выборе.
      calcCondition: hasCalcCondition(layout),
      // Известно ли, какие поля объект использует: у контейнеров (фильтры,
      // KPI) поля лежат в детях, и об их отсутствии судить нельзя.
      fieldsKnown: !CONTAINER_TYPES.has(type),
      hasDimensions: extracted.hasDimensions,
      hasMeasures: extracted.hasMeasures,
      // Лист, на котором объект лежит: нужен, чтобы посчитать нагрузку листа.
      sheetId: sheetOf?.get(id) ?? null,
    });
  }

  // --- Master-объекты ---
  // Переиспользуемые определения: в содержимое листа они не входят, но
  // именно они чаще всего остаются неиспользуемыми.
  graph.masterObjects = masters;

  // --- Подключения к данным ---
  // getConnections на многих серверах отдаёт подключения уровня сервера,
  // а не приложения (у разных приложений список совпадает). Такие
  // подключения помечаем отдельно: судить по ним об использовании нельзя.
  const connections = await fetchDataConnections(app);
  if (connections.available) {
    capabilities.push('connections');
    graph.connections = connections.items;
    graph.meta.connectionsScope = 'unknown';
  } else {
    graph.connections = [];
    skipped.push({ capability: 'connections', reason: 'Сервер не отдал подключения к данным.' });
  }

  // --- Связи между таблицами (для правила про внешний join) ---
  // Метод требует имена двух таблиц, поэтому сравниваются пары таблиц
  // с общими полями. Текст ответа сервера сохраняем: по нему видно,
  // поддерживает ли сервер метод и почему нет.
  const { associations, reason } = await fetchAssociations(app, graph.tables);

  // Платформа определяется по собранным объектам: Doc API используется и
  // в QlikView, и в Qlik Sense, а набор типов объектов различает их однозначно.
  graph.meta.platform = detectPlatform(graph.objects);
  if (associations) {
    graph.meta.associations = associations;
    capabilities.push('associations');
  } else {
    skipped.push({ capability: 'associations', reason });
  }

  // --- Переменные ---
  const macros = await app.getTextMacros?.().catch(() => []) ?? [];
  for (const v of macros) {
    graph.variables.push({ name: v.qName ?? v.name ?? '', value: v.qDefinition ?? '', description: '' });
  }

  const parsedScript = parseLoadScript(graph.script);
  graph.meta.scriptFields = parsedScript.scriptFields;
  graph.meta.scriptOperations = parsedScript.operations;
  // Признаки обрезанного скрипта: часть API отдаёт текст не полностью.
  graph.meta.scriptInfo = analyzeScriptIntegrity(graph.script);

  log(`Doc API: скрипт ${graph.script.length} симв., таблиц ${graph.tables.length}, полей ${graph.fields.length}, объектов ${graph.objects.length}`);

  return graph;
}

/**
 * Экстракт одного приложения через Doc API (открывает документ сам).
 * @param {object} qix — глобальный объект Doc API
 * @param {string} appId
 * @param {(msg: string) => void} [log]
 */
export async function extractViaDocApi(qix, appId, log = () => {}) {
  const app = await qix.openDoc(appId);
  const graph = await buildGraphFromDoc(app, appId, log);
  graph.meta.capabilities.unshift('openDoc');
  return graph;
}
