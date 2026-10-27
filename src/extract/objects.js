/**
 * Сбор объектов приложения (листы, визуализации, переменные) у движка Qlik.
 *
 * Сервер не обязан понимать все типы объектов: если в одном запросе есть
 * незнакомый ему тип, отказ приходит на весь вызов — и тогда теряются
 * сразу все объекты приложения. Поэтому типы запрашиваются блоками,
 * а неудавшийся блок разбирается по одному типу: остальные не теряются.
 *
 * Формат элемента различается у разных API:
 *  - QIX App API: {qId, qType, qMeta};
 *  - Doc API:      {qInfo: {qId, qType}, qMeta, qData}.
 * Поэтому элементы приводятся к общему виду функцией normalizeObjectItem —
 * иначе сервер отдаёт объекты, а код их молча отбрасывает.
 */

/** Типы объектов, которые запрашиваем у движка. */
export const OBJECT_TYPES = [
  'sheet', 'story', 'chart', 'dimension', 'measure', 'textbox', 'button',
  'slider', 'selection', 'inputbox', 'group', 'container', 'pivot', 'table',
  'listbox', 'treemap', 'bar', 'line', 'pie', 'scatter', 'combo', 'gauge',
  'funnel', 'histogram', 'boxplot', 'heatmap', 'radar', 'waterfall', 'bullet',
  'sparkline', 'map', 'extension', 'variable',
];

/**
 * Приводит элемент списка объектов к общему виду.
 *
 * @param {object} item — элемент ответа getObjects
 * @returns {{id: string, type: string, name: string, description: string}|null}
 *   null, если элемент без идентификатора (такой использовать нельзя).
 */
export function normalizeObjectItem(item) {
  if (!item || typeof item !== 'object') return null;
  // QIX App API — поля лежат прямо в элементе, Doc API — внутри qInfo.
  const info = item.qInfo && typeof item.qInfo === 'object' ? item.qInfo : item;
  const id = String(info.qId ?? '');
  const type = String(info.qType ?? '');
  if (!id) return null;
  const meta = item.qMeta && typeof item.qMeta === 'object' ? item.qMeta : {};
  return {
    id,
    type,
    // Название объекта сервер отдаёт по-разному: qName, qTitle или title.
    name: String(meta.qName ?? meta.qTitle ?? meta.title ?? ''),
    description: String(meta.qDescription ?? meta.description ?? ''),
  };
}

/** Разбивает список на блоки по n элементов. */
export function chunk(list, n) {
  const size = Math.max(1, Number(n) || 1);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Запрашивает у движка список объектов указанных типов.
 *
 * @param {object} app — объект App QIX или документ Doc API (умеет getObjects)
 * @param {string[]} [types] — типы объектов
 * @param {object} [options]
 * @param {number} [options.batchSize] — сколько типов спрашивать за один вызов
 * @param {number} [options.timeoutMs] — предел ожидания одного вызова
 * @returns {Promise<{items: object[], skipped: {type: string, reason: string}[], listed: number}>}
 *   listed — сколько объектов сервер отдал по списку типов (0 — типы ему
 *   неизвестны, и список объектов заведомо неполный).
 */
export async function fetchObjects(app, types = OBJECT_TYPES, options = {}) {
  const { batchSize = 8, timeoutMs = 20000 } = options;
  const items = [];
  const skipped = [];

  // Один вызов — с пределом по времени: «молчащий» сервер иначе держит
  // анализ открытым бесконечно.
  const call = async (qTypes) => {
    let timer;
    try {
      const res = await Promise.race([
        app.getObjects({ qTypes }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Превышено время ожидания ответа по типам ${qTypes.join(', ')} (${Math.round(timeoutMs / 1000)} с).`,
          )), timeoutMs);
          timer.unref?.();
        }),
      ]);
      // QIX App API отдаёт {qItems: [...]}, Doc API — массив элементов.
      if (Array.isArray(res)) return res;
      return res?.qItems ?? [];
    } finally {
      clearTimeout(timer);
    }
  };

  for (const batch of chunk(types, batchSize)) {
    try {
      items.push(...await call(batch));
    } catch {
      // Блок не прошёл — ищем незнакомый тип по одному, остальные не теряем.
      for (const type of batch) {
        try {
          items.push(...await call([type]));
        } catch (err) {
          skipped.push({ type, reason: err?.message ?? String(err) });
        }
      }
    }
  }

  return { items: dedupeObjects(items), skipped, listed: items.length };
}

/**
 * Убирает повторы и приводит элементы к общему виду.
 *
 * @param {object[]} raw — элементы ответа getObjects
 * @returns {object[]} нормализованные объекты
 */
export function dedupeObjects(raw) {
  const normalized = [];
  for (const item of raw ?? []) {
    const obj = normalizeObjectItem(item);
    if (obj) normalized.push(obj);
  }
  return dedupeNormalized(normalized);
}

/**
 * Убирает повторы среди уже нормализованных объектов.
 *
 * @param {object[]} objects — нормализованные объекты
 * @returns {object[]} объекты без повторов
 */
export function dedupeNormalized(objects) {
  const seen = new Set();
  const unique = [];
  for (const obj of objects ?? []) {
    if (!obj?.id) continue;
    // Один и тот же объект может прийти в двух типах (например, лист и лист-история):
    // оставляем первое вхождение, чтобы не считать объект дважды.
    if (seen.has(obj.id)) continue;
    seen.add(obj.id);
    unique.push(obj);
  }
  return unique;
}

/**
 * Читает layout объекта.
 *
 * @param {object} app — объект App QIX или документ Doc API
 * @param {string} id — идентификатор объекта
 * @returns {Promise<object|null>} layout либо null, если объект не читается
 */
export async function fetchLayout(app, id) {
  try {
    const obj = await app.getObject(id);
    return await obj.getLayout();
  } catch {
    return null;
  }
}

/**
 * Есть ли у объекта условие вычисления (calc condition).
 *
 * Без него объект пересчитывается при каждом выборе — это признак тяжёлого
 * объекта. Условие лежит в разных ветках layout в зависимости от типа.
 *
 * @param {object} layout — layout объекта
 * @returns {boolean}
 */
export function hasCalcCondition(layout) {
  if (!layout || typeof layout !== 'object') return false;
  let found = false;
  const seen = new Set();
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'qCalcCondition' && value) {
        // Пустое условие («qCond»: «») условием не считается.
        const cond = value?.qCond?.qv ?? value?.qv;
        if (cond !== undefined && String(cond).trim() === '') continue;
        found = true;
        return;
      }
      walk(value);
    }
  };
  walk(layout);
  return found;
}

/**
 * Собирает объекты, лежащие на листах (qChildList).
 *
 * Список типов у движка конечен и отстаёт от версии Sense: новые объекты
 * (KPI, фильтры, кнопки) в getObjects не попадают, но они перечислены
 * в списке содержимого листа. Без этого обхода часть фронт-энда не видна.
 *
 * @param {object} app — объект App QIX или документ Doc API
 * @param {object[]} sheetObjects — листы и истории (уже нормализованные)
 * @returns {Promise<{objects: object[], sheetOf: Map<string, string>}>}
 *   sheetOf — какой лист какому объекту принадлежит.
 */
export async function fetchSheetChildren(app, sheetObjects) {
  const found = [];
  const sheetOf = new Map();
  for (const sheet of sheetObjects ?? []) {
    const layout = await fetchLayout(app, sheet.id);
    const children = layout?.qChildList?.qItems ?? [];
    for (const child of children) {
      const obj = normalizeObjectItem(child);
      if (!obj) continue;
      obj.sheetId = sheet.id;
      sheetOf.set(obj.id, sheet.id);
      found.push(obj);
    }
  }
  return { objects: dedupeNormalized(found), sheetOf };
}
