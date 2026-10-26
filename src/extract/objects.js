/**
 * Сбор объектов приложения (листы, визуализации, переменные) у движка Qlik.
 *
 * Сервер не обязан понимать все типы объектов: если в одном запросе есть
 * незнакомый ему тип, отказ приходит на весь вызов — и тогда теряются
 * сразу все объекты приложения. Поэтому типы запрашиваются блоками,
 * а неудавшийся блок разбирается по одному типу: остальные не теряются.
 */

/** Типы объектов, которые запрашиваем у движка. */
export const OBJECT_TYPES = [
  'sheet', 'story', 'chart', 'dimension', 'measure', 'textbox', 'button',
  'slider', 'selection', 'inputbox', 'group', 'container', 'pivot', 'table',
  'listbox', 'treemap', 'bar', 'line', 'pie', 'scatter', 'combo', 'gauge',
  'funnel', 'histogram', 'boxplot', 'heatmap', 'radar', 'waterfall', 'bullet',
  'sparkline', 'map', 'extension', 'variable',
];

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
 * @param {object} app — объект App QIX (умеет getObjects)
 * @param {string[]} [types] — типы объектов
 * @param {object} [options]
 * @param {number} [options.batchSize] — сколько типов спрашивать за один вызов
 * @param {number} [options.timeoutMs] — предел ожидания одного вызова
 * @returns {Promise<{items: object[], skipped: {type: string, reason: string}[]}>}
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

  // Один и тот же объект может прийти в двух типах (например, лист и лист-история):
  // оставляем первое вхождение, чтобы не считать объект дважды.
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const id = item?.qId;
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }

  return { items: unique, skipped };
}
