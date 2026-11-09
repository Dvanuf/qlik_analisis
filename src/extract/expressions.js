/**
 * Разбор выражений объекта приложения.
 *
 * Данные об измерениях и мерах лежат в разных ветках layout в зависимости
 * от типа объекта:
 *  - listbox:      qListObject.qDimensionInfo.qGroupFieldDefs — поля измерения;
 *  - table/pivot:  qHyperCube.qDimensionInfo[] — поля измерения;
 *  - меры:         qHyperCube.qMeasureInfo[].qDef — формула (строка или
 *    объект { qDef, qLibraryId }); qFallbackTitle — подпись, не формула.
 *
 * Раньше читался только qDef строкой, поэтому у объектов с мерами в
 * qMeasureInfo выражений не было вовсе — и правила на «объект без
 * измерения» ругались на вполне рабочие объекты.
 */

/** Поле в квадратных скобках приводится к виду ссылки на поле. */
function asFieldExpression(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\[.*\]$/.test(text)) return text;
  // Выражение измерения: `=if(len([User Name])>1,[User Name])` — оставляем как есть.
  if (text.startsWith('=')) return text.slice(1).trim();
  return `[${text}]`;
}

/**
 * Приводит элемент к списку записей (бывает и объект, и массив).
 *
 * @param {object|object[]} node
 * @returns {object[]}
 */
function asList(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  return [node];
}

/**
 * Формула меры и ссылка на мастер-меру из записи qMeasureInfo.
 *
 * В layout QIX qMeasureInfo[].qDef бывает:
 *  - строкой — сама формула;
 *  - объектом HyperCubeMeasureqDef { qDef: 'формула', qLibraryId, qLabel }.
 * qFallbackTitle — подпись с единицами измерения, формулой не является.
 *
 * @param {object} entry — запись qMeasureInfo
 * @returns {{formula: string, libraryId: string|null}}
 */
function measureFormula(entry) {
  if (!entry || typeof entry !== 'object') return { formula: '', libraryId: null };
  const qd = entry.qDef;
  if (typeof qd === 'string') {
    return { formula: qd, libraryId: entry.qLibraryId ?? null };
  }
  if (qd && typeof qd === 'object') {
    const formula = typeof qd.qDef === 'string' ? qd.qDef : '';
    const libraryId = qd.qLibraryId ?? entry.qLibraryId ?? null;
    return { formula, libraryId: libraryId ? String(libraryId) : null };
  }
  return { formula: '', libraryId: entry.qLibraryId ? String(entry.qLibraryId) : null };
}

/**
 * Выражения объекта: измерения и меры.
 *
 * @param {object} layout — layout объекта
 * @returns {{expressions: {kind: string, expr: string}[], hasDimensions: boolean, hasMeasures: boolean}}
 */
export function extractObjectExpressions(layout) {
  const expressions = [];
  const seen = new Set();
  const add = (kind, expr, libraryId = null) => {
    const text = String(expr ?? '').trim();
    if (!text) return;
    const key = `${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    expressions.push(libraryId ? { kind, expr: text, libraryId } : { kind, expr: text });
  };

  // Измерения: поля, на которых объект построен.
  const dimensionRoots = [
    layout?.qListObject?.qDimensionInfo,
    layout?.qHyperCube?.qDimensionInfo,
    layout?.qDimensionInfo,
  ];
  for (const root of dimensionRoots) {
    for (const entry of asList(root)) {
      for (const field of entry?.qGroupFieldDefs ?? []) {
        add('dimension', asFieldExpression(field));
      }
      for (const field of entry?.qFieldDefs ?? []) {
        add('dimension', asFieldExpression(field));
      }
    }
  }

  // Меры: формула лежит в qDef (строка или объект { qDef, qLibraryId }).
  // qFallbackTitle — это ПОДПИСЬ («количество, шт.»), не выражение: две
  // меры с одинаковой подписью — не «две меры считают одно и то же».
  const measureRoots = [
    layout?.qListObject?.qMeasureInfo,
    layout?.qHyperCube?.qMeasureInfo,
    layout?.qMeasureInfo,
  ];
  for (const root of measureRoots) {
    for (const entry of asList(root)) {
      const { formula, libraryId } = measureFormula(entry);
      add('measure', formula, libraryId);
    }
  }

  // Прочие выражения: qDef строкой, формулы и текстовые списки полей.
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'qDef' && typeof value === 'string') add('measure', value);
      else if ((key === 'qFormula' || key === 'qExpr' || key === 'qExpression') && typeof value === 'string') {
        add('dimension', value);
      } else if (key === 'qFieldDefs' && Array.isArray(value)) {
        for (const f of value) add('dimension', asFieldExpression(f));
      } else if (key === 'qExpressions' && Array.isArray(value)) {
        for (const f of value) if (typeof f === 'string') add('measure', f);
      } else {
        walk(value);
      }
    }
  };
  walk(layout);

  return {
    expressions,
    hasDimensions: expressions.some((e) => e.kind === 'dimension'),
    hasMeasures: expressions.some((e) => e.kind === 'measure'),
  };
}

/**
 * Типы объектов, у которых поля лежат не в самом объекте, а в его детях
 * (фильтры, контейнеры). Отсутствие измерения у такого объекта —
 * норма, а не дефект.
 */
export const CONTAINER_TYPES = new Set([
  'filterpane', 'filterbox', 'action-button', 'text-image', 'slide',
  'group', 'container', 'sheet', 'story', 'UniKPI', 'checklist-store',
]);
