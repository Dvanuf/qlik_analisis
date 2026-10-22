/**
 * Экстракт через QlikView-совместимый Doc API (QlikView Server 12.x).
 *
 * В отличие от QIX App API (Qlik Sense 12 / Qlik Cloud), здесь глобальный объект
 * не имеет метода get('App'), а документ открывается через openDoc() и сам
 * предоставляет методы getScript / getAppLayout / getTablesAndKeys / getObject.
 */
import { parseLoadScript } from './loadscript.js';

const OBJECT_TYPES = [
  'sheet', 'story', 'chart', 'dimension', 'measure', 'textbox', 'button',
  'slider', 'selection', 'inputbox', 'group', 'container', 'pivot', 'table',
  'listbox', 'treemap', 'bar', 'line', 'pie', 'scatter', 'combo', 'gauge',
  'funnel', 'histogram', 'boxplot', 'heatmap', 'radar', 'waterfall', 'bullet',
  'sparkline', 'map', 'extension',
];

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
    if (key === 'qDef' && typeof value === 'string') out.push({ kind: 'measure', expr: value });
    else if ((key === 'qFormula' || key === 'qExpr' || key === 'qExpression') && typeof value === 'string') {
      out.push({ kind: 'dimension', expr: value });
    } else if (key === 'qFieldDefs' && Array.isArray(value)) {
      value.forEach((f) => { if (typeof f === 'string') out.push({ kind: 'dimension', expr: f }); });
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
    name: String(meta.qName ?? meta.qTitle ?? layoutPart.qTitle ?? ''),
    description: String(meta.qDescription ?? layoutPart.qDescription ?? ''),
  };
}

/**
 * @param {object} qix — глобальный объект Doc API
 * @param {string} appId — идентификатор документа
 * @param {(msg: string) => void} [log]
 */
export async function extractViaDocApi(qix, appId, log = () => {}) {
  const capabilities = [];
  const skipped = [];

  const app = await qix.openDoc(appId);
  capabilities.push('openDoc');

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
      capabilities,
      skipped,
      productVersion: appProps?.qSavedInProductVersion ?? '',
      lastReload: appLayout?.qLastReloadTime ?? appProps?.qLastReloadTime ?? '',
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
  const objectList = await app.getObjects({ qTypes: OBJECT_TYPES }).catch((err) => {
    skipped.push({ capability: 'objects', reason: err?.message ?? String(err) });
    return [];
  });
  const items = Array.isArray(objectList) ? objectList : (objectList?.qItems ?? []);
  if (items.length) capabilities.push('objects');

  for (const info of items) {
    const id = info?.qId;
    const type = info?.qType;
    if (!id) continue;
    const layout = await app.getObject(id).then((o) => o.getLayout()).catch(() => null);
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
      id, name: meta.name || id, type,
      description: meta.description, expressions: unique, layoutMs: null,
    });
  }

  // --- Переменные ---
  const macros = await app.getTextMacros?.().catch(() => []) ?? [];
  for (const v of macros) {
    graph.variables.push({ name: v.qName ?? v.name ?? '', value: v.qDefinition ?? '', description: '' });
  }

  const parsedScript = parseLoadScript(graph.script);
  graph.meta.scriptFields = parsedScript.scriptFields;
  graph.meta.scriptOperations = parsedScript.operations;

  log(`Doc API: скрипт ${graph.script.length} симв., таблиц ${graph.tables.length}, полей ${graph.fields.length}, объектов ${graph.objects.length}`);

  return graph;
}
