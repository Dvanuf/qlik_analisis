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
import { fetchObjects, fetchLayout, fetchSheetChildren, OBJECT_TYPES } from './objects.js';
import { detectPlatform } from '../rules/platforms.js';

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
function asFieldExpression(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  // Знак равенства означает выражение измерения: `=Month` или `=Sum([Amount])`.
  if (raw.startsWith('=')) {
    const text = raw.slice(1).trim();
    if (!text) return '';
    // Простое имя поля оформляем ссылкой — разбор выражений её узнаёт.
    if (/^[\wа-яА-Я]+$/.test(text)) return `[${text}]`;
    // Настоящее выражение (функции, операторы) оставляем как есть.
    return text;
  }
  // Имя поля: с пробелами оно ссылкой не считается — нужны скобки.
  if (/^\[.*\]$/.test(raw)) return raw;
  return `[${raw}]`;
}

/**
 * Рекурсивно вытаскивает выражения из layout объекта.
 *
 * Кроме привычных qDef/qFormula, сервер Sense 12 отдаёт поля измерений
 * в qDimensionInfo.qGroupFieldDefs — это названия полей, по ним видно,
 * какие поля объект использует.
 */
function collectExpressions(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((n) => collectExpressions(n, out, seen));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'qDef' && typeof value === 'string') out.push({ kind: 'measure', expr: value });
    else if ((key === 'qFormula' || key === 'qExpr' || key === 'qExpression') && typeof value === 'string') {
      out.push({ kind: 'dimension', expr: value });
    } else if (key === 'qFieldDefs' && Array.isArray(value)) {
      value.forEach((f) => {
        if (typeof f === 'string') out.push({ kind: 'dimension', expr: asFieldExpression(f) });
      });
    } else if (key === 'qGroupFieldDefs' && Array.isArray(value)) {
      // Поля, на которых построено измерение объекта.
      value.forEach((f) => {
        if (typeof f === 'string') out.push({ kind: 'dimension', expr: asFieldExpression(f) });
      });
    } else if (key === 'qExpressions' && Array.isArray(value)) {
      value.forEach((f) => { if (typeof f === 'string') out.push({ kind: 'measure', expr: f }); });
    } else if (typeof value === 'object') collectExpressions(value, out, seen);
  }
  return out;
}

function readMeta(layout) {
  const meta = layout?.qMeta ?? {};
  const layoutPart = layout?.qLayout ?? {};
  return {
    // Название объекта сервер отдаёт по-разному: qName, qTitle или title.
    name: String(meta.qName ?? meta.qTitle ?? meta.title ?? layoutPart.qTitle ?? ''),
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

  // Объекты, лежащие на листах: их нет в списке типов движка, но без них
  // часть фронт-энда (KPI, фильтры, кнопки) остаётся невидимой.
  const sheetLike = listedObjects.filter((o) => o.type === 'sheet' || o.type === 'story');
  const children = await fetchSheetChildren(app, sheetLike);
  const items = [...listedObjects];
  const knownIds = new Set(listedObjects.map((o) => o.id));
  for (const child of children) {
    if (knownIds.has(child.id)) continue;
    knownIds.add(child.id);
    items.push(child);
  }
  if (items.length) capabilities.push('objects');

  for (const info of items) {
    const { id, type } = info;
    const layout = await fetchLayout(app, id);
    if (!layout) continue;
    const meta = readMeta(layout);
    if (type === 'sheet' || type === 'story') {
      graph.sheets.push({ id, name: meta.name || id, type, description: meta.description });
      continue;
    }
    const unique = [];
    const seen = new Set();
    for (const e of collectExpressions(layout)) {
      const key = `${e.kind}:${e.expr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(e);
    }
    graph.objects.push({
      id, name: meta.name || info.name || id, type,
      description: meta.description || info.description,
      expressions: unique, layoutMs: null,
    });
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
