/**
 * Поиск по выражениям приложения и по скрипту загрузки.
 *
 * В QS Metadata Explorer это «search any expression»: находятся места,
 * где встречается произвольное выражение или его часть — и в объектах
 * фронт-энда, и в скрипте.
 *
 * Нужен, чтобы ответить на вопрос «где в приложении используется вот эта
 * формула?» — быстрее, чем grep по выгрузке отчёта.
 */

/**
 * Нормализует выражение для сравнения.
 *
 * @param {string} expr
 * @returns {string}
 */
function normalize(expr) {
  return String(expr ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Ищет текст в выражениях объектов, переменных и скрипте.
 *
 * Принимает либо граф приложения, либо готовый перечень выражений —
 * второй вариант удобен для интерфейса, где граф уже не нужен.
 *
 * @param {object} source — граф приложения или { expressions, script }
 * @param {string} query — искомый текст
 * @returns {{
 *   query: string,
 *   objects: Array<{name: string, type: string, kind: string, expr: string}>,
 *   variables: Array<{name: string, expr: string}>,
 *   script: Array<{line: number, text: string}>,
 *   total: number,
 * }}
 */
export function searchExpressions(source, query) {
  const q = normalize(query);
  const empty = { query: String(query ?? ''), objects: [], variables: [], script: [], total: 0 };
  if (!q) return empty;

  const objects = [];
  const variables = [];

  // Готовый перечень выражений (из результата анализа).
  const index = Array.isArray(source?.expressions) ? source.expressions : null;
  if (index) {
    for (const e of index) {
      const expr = String(e.expr ?? '');
      if (!normalize(expr).includes(q)) continue;
      objects.push({
        name: String(e.name ?? ''),
        type: String(e.type ?? ''),
        kind: String(e.kind ?? ''),
        expr,
      });
    }
  } else {
    for (const obj of source?.objects ?? []) {
      for (const e of obj.expressions ?? []) {
        const expr = String(e.expr ?? '');
        if (!normalize(expr).includes(q)) continue;
        objects.push({
          name: String(obj.name ?? obj.id ?? ''),
          type: String(obj.type ?? ''),
          kind: String(e.kind ?? ''),
          expr,
        });
      }
    }
    for (const v of source?.variables ?? []) {
      const expr = String(v.value ?? '');
      if (!normalize(expr).includes(q)) continue;
      variables.push({ name: String(v.name ?? ''), expr });
    }
  }

  const script = [];
  const lines = String(source?.script ?? '').split(/\r?\n/);
  lines.forEach((text, i) => {
    if (!normalize(text).includes(q)) return;
    script.push({ line: i + 1, text });
  });

  return {
    query: String(query ?? ''),
    objects,
    variables,
    script,
    total: objects.length + variables.length + script.length,
  };
}
