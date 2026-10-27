/**
 * Метаданные приложения: полный перечень объектов, master-объекты,
 * подключения к данным и свойства объектов.
 *
 * Перечень берётся из getAllInfos — он единственный, кто перечисляет
 * ВСЕ объекты приложения, включая те, чьих типов нет в списке типов
 * движка (master-объекты, закладки, служебные). Список по типам
 * (getObjects) дополняет его, а сверка двух перечней показывает, всё ли
 * собрано — иначе об отсутствии объектов можно и не узнать.
 */

/** Типы объектов, которые не относятся к содержимому приложения. */
export const SERVICE_TYPES = new Set([
  'LoadModel', 'appprops', 'checklist-store', '_gitoqlikMetaData', 'appinfo',
]);

/** Типы объектов, которые относятся к содержимому приложения. */
export const CONTENT_TYPES = new Set([
  'sheet', 'story', 'slide', 'table', 'pivot', 'listbox', 'treemap', 'chart',
  'bar', 'line', 'pie', 'scatter', 'combo', 'gauge', 'funnel', 'histogram',
  'boxplot', 'heatmap', 'radar', 'waterfall', 'bullet', 'sparkline', 'map',
  'textbox', 'text-image', 'button', 'slider', 'selection', 'inputbox',
  'group', 'container', 'filterbox', 'filterpane', 'action-button', 'UniKPI',
  'UniBarChart', 'piechart', 'scatterplot', 'uni_shecklist', 'sn-table',
  'dimension', 'measure', 'extension', 'variable',
]);

/**
 * Полный перечень объектов приложения.
 *
 * @param {object} app — объект App QIX или документ Doc API
 * @returns {Promise<{items: {id: string, type: string}[], available: boolean}>}
 *   available — false, если сервер перечень не отдал.
 */
export async function fetchInventory(app) {
  // Метода может не быть вовсе (старый сервер) — тогда перечень недоступен.
  if (typeof app?.getAllInfos !== 'function') {
    return { items: [], available: false };
  }
  try {
    const res = await app.getAllInfos();
    const list = Array.isArray(res) ? res : (res?.qInfos ?? []);
    const items = [];
    for (const entry of list) {
      const id = String(entry?.qId ?? '');
      const type = String(entry?.qType ?? '');
      if (!id) continue;
      items.push({ id, type });
    }
    return { items, available: true };
  } catch {
    // Перечень недоступен — работаем по списку по типам.
    return { items: [], available: false };
  }
}

/**
 * Подключения к данным, объявленные в приложении.
 *
 * Внимание: на многих серверах getConnections отдаёт подключения уровня
 * сервера, а не приложения — у разных приложений список совпадает. Такие
 * подключения помечаются как серверные: судить по ним об использовании
 * нельзя.
 *
 * @param {object} app — объект App QIX или документ Doc API
 * @returns {Promise<{items: object[], available: boolean}>}
 */
export async function fetchDataConnections(app) {
  if (typeof app?.getConnections !== 'function') {
    return { items: [], available: false };
  }
  try {
    const res = await app.getConnections();
    const list = Array.isArray(res) ? res : (res?.qConnections ?? res?.qItems ?? []);
    const items = [];
    for (const c of list) {
      const id = String(c?.qId ?? '');
      if (!id) continue;
      items.push({
        id,
        name: String(c?.qName ?? ''),
        type: String(c?.qType ?? ''),
        connectionString: String(c?.qConnectionString ?? ''),
      });
    }
    return { items, available: true };
  } catch {
    return { items: [], available: false };
  }
}

/**
 * Название и описание объекта.
 *
 * Название лежит в разных местах в зависимости от типа объекта: у листа
 * — в qMeta.title, у listbox — в title верхнего уровня, у части типов
 * названия сервер не отдаёт вовсе (тогда показываем идентификатор).
 *
 * @param {object} layout — layout объекта
 * @param {string} [fallbackId] — идентификатор, если названия нет
 * @returns {{name: string, description: string}}
 */
export function readObjectTitle(layout, fallbackId = '') {
  const meta = layout?.qMeta ?? {};
  const candidates = [
    meta.title, meta.qTitle, meta.qName,
    layout?.title, layout?.qLayout?.qTitle,
  ];
  for (const value of candidates) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return String(fallbackId ?? '');
}

/**
 * Определение объекта (выражение) — для master-объектов и описаний.
 *
 * @param {object} layout — layout объекта
 * @returns {string} определение или пустая строка
 */
export function readObjectDefinition(layout) {
  const parts = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'qGroupFieldDefs' && Array.isArray(value)) {
        for (const f of value) {
          if (typeof f === 'string' && f.trim()) parts.push(f.trim());
        }
        continue;
      }
      if ((key === 'qDef' || key === 'qFormula' || key === 'qExpression') && typeof value === 'string') {
        if (value.trim()) parts.push(value.trim());
        continue;
      }
      walk(value);
    }
  };
  walk(layout);
  return [...new Set(parts)].join('; ');
}
