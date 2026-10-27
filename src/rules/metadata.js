/**
 * Правила по метаданным приложения: master-объекты, тяжёлые объекты
 * без условия вычисления, перегруженные листы и объекты без измерения.
 *
 * Все они опираются на данные фронт-энда, поэтому без сведений об
 * объектах пропускаются с объяснением, а не выдают пустоту.
 */
import { canonicalFieldName } from '../normalize.js';

const CATEGORY = 'Resources';

/** Порог числа объектов на листе, выше которого лист считается тяжёлым. */
export const SHEET_OBJECT_LIMIT = 15;

/**
 * Поля и выражения объекта.
 *
 * @param {object} obj — объект приложения
 * @returns {{fields: string[], expressions: string[]}}
 */
function objectScope(obj) {
  const fields = new Set();
  const expressions = [];
  for (const e of obj.expressions ?? []) {
    const expr = String(e.expr ?? '').trim();
    if (!expr) continue;
    expressions.push(expr);
    // Поле в квадратных скобках — прямая ссылка.
    const bracket = expr.match(/^\[(.+)\]$/);
    if (bracket) fields.add(canonicalFieldName(bracket[1]));
  }
  return { fields: [...fields], expressions };
}

/**
 * Приводит выражение к виду, по которому можно сравнивать.
 *
 * Определение master-объекта приходит как `=if(len([User Name])>1,[User Name])`,
 * а в объекте то же самое — без знака равенства. Сравнивать их напрямую
 * нельзя, иначе использование master-объекта не найдётся.
 *
 * @param {string} expr — выражение
 * @returns {string} нормализованное выражение
 */
function normalizeExpr(expr) {
  return String(expr ?? '').trim().replace(/^=/, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Агрегации в выражении — признак тяжёлого объекта.
 *
 * Простое измерение по полю пересчитывается дёшево; дорого обходятся
 * агрегации (Sum, Count, Aggr…) и функции над наборами.
 *
 * @param {string} expr — выражение
 * @returns {boolean}
 */
function hasAggregation(expr) {
  return /\b(sum|count|counta|countd|avg|min|max|range|stdev|stdevp|deviation|var|varp|skew|kurtosis|first|last|concatenate|aggr|aggr2|firstsortedvalue|lastsortedvalue|minsortedvalue|maxsortedvalue|concatenate)\s*\(/i
    .test(String(expr ?? ''));
}

export const metadataRules = [
  {
    id: 'R015',
    category: CATEGORY,
    severity: 'info',
    title: 'Неиспользуемый master-объект',
    description: 'Master-объект определён в приложении, но ни один объект его не использует.',
    recommendation: 'Удалить master-объект из приложения.',
    run(ctx) {
      const out = [];
      const masters = ctx.graph.masterObjects ?? [];
      if (!masters.length) {
        return { findings: [], note: 'Master-объекты в приложении не найдены.' };
      }
      // Master-объект используется, если его определение встречается
      // в выражениях объектов — напрямую или через поля определения.
      const usedFields = new Set();
      const usedExprs = new Set();
      for (const obj of ctx.graph.objects ?? []) {
        for (const e of obj.expressions ?? []) usedExprs.add(normalizeExpr(e.expr));
        for (const f of objectScope(obj).fields) usedFields.add(f);
      }
      for (const master of masters) {
        const definition = normalizeExpr(master.definition);
        // Определение целиком присутствует в объекте (например, treemap
        // содержит то же выражение, что и master-объект).
        if (definition && usedExprs.has(definition)) continue;
        // Либо использованы поля master-объекта.
        const own = objectScope({ expressions: [{ kind: 'dimension', expr: master.definition ?? '' }] });
        if (own.fields.some((f) => usedFields.has(f))) continue;
        out.push({
          ruleId: 'R015',
          category: CATEGORY,
          severity: 'info',
          title: 'Неиспользуемый master-объект',
          target: { kind: 'master', name: master.name, id: master.id },
          message: `Master-объект «${master.name}» не используется ни в одном объекте`,
          detail: master.definition ? `Определение: ${master.definition.slice(0, 160)}` : 'Определение недоступно.',
          recommendation: 'Удалить master-объект из приложения.',
        });
      }
      return out;
    },
  },
  {
    id: 'R016',
    category: CATEGORY,
    severity: 'info',
    title: 'Тяжёлый объект без условия вычисления',
    description: 'Объект пересчитывается при каждом выборе, но не имеет условия вычисления.',
    recommendation: 'Задать условие вычисления (calc condition) для объекта.',
    run(ctx) {
      const out = [];
      const objects = ctx.graph.objects ?? [];
      if (!objects.length) {
        return { findings: [], note: 'Список объектов приложения недоступен.' };
      }
      for (const obj of objects) {
        // Условие вычисления задано — объект пересчитывается не всегда.
        if (obj.calcCondition === true) continue;
        const scope = objectScope(obj);
        // Тяжёлым считается объект с агрегациями: простое измерение по полю
        // пересчитывается дёшево, и ругаться на него не стоит.
        const heavy = scope.expressions.filter((e) => hasAggregation(e));
        if (!heavy.length) continue;
        out.push({
          ruleId: 'R016',
          category: CATEGORY,
          severity: 'info',
          title: 'Тяжёлый объект без условия вычисления',
          target: { kind: 'object', name: obj.name, id: obj.id },
          message: `Объект «${obj.name}» пересчитывается при каждом выборе — условие вычисления не задано`,
          detail: `Агрегаций в объекте: ${heavy.length}. Такие объекты замедляют выбор.`,
          recommendation: 'Задать условие вычисления либо упростить выражения объекта.',
        });
      }
      return out;
    },
  },

  {
    id: 'R017',
    category: CATEGORY,
    severity: 'info',
    title: 'Лист с большим числом объектов',
    description: 'На листе размещено больше объектов, чем удобно поддерживать.',
    recommendation: 'Разделить лист на несколько или сгруппировать объекты в контейнеры.',
    run(ctx) {
      const out = [];
      const limit = ctx.config?.thresholds?.R017?.maxObjects ?? SHEET_OBJECT_LIMIT;
      const counts = new Map();
      for (const obj of ctx.graph.objects ?? []) {
        if (!obj.sheetId) continue;
        counts.set(obj.sheetId, (counts.get(obj.sheetId) ?? 0) + 1);
      }
      const sheets = ctx.graph.sheets ?? [];
      if (!sheets.length) {
        return { findings: [], note: 'Список листов недоступен.' };
      }
      for (const sheet of sheets) {
        const count = counts.get(sheet.id) ?? 0;
        if (count <= limit) continue;
        out.push({
          ruleId: 'R017',
          category: CATEGORY,
          severity: 'info',
          title: 'Лист с большим числом объектов',
          target: { kind: 'sheet', name: sheet.name, id: sheet.id },
          message: `На листе «${sheet.name}» ${count} объектов (порог ${limit})`,
          detail: 'Большой лист замедляет открытие приложения и усложняет его поддержку.',
          recommendation: 'Разделить лист на несколько или сгруппировать объекты в контейнеры.',
        });
      }
      return out;
    },
  },

  {
    id: 'R018',
    category: CATEGORY,
    severity: 'info',
    title: 'Объект без измерения',
    description: 'У объекта нет ни одного измерения — он не показывает данные.',
    recommendation: 'Добавить измерение или удалить объект.',
    run(ctx) {
      const out = [];
      const objects = ctx.graph.objects ?? [];
      if (!objects.length) {
        return { findings: [], note: 'Список объектов приложения недоступен.' };
      }
      for (const obj of objects) {
        // У контейнеров (фильтры, KPI) поля лежат в детях — об их отсутствии
        // судить нельзя.
        if (obj.fieldsKnown === false) continue;
        const hasDimension = obj.hasDimensions
          ?? (obj.expressions ?? []).some((e) => e.kind === 'dimension');
        const hasMeasure = obj.hasMeasures
          ?? (obj.expressions ?? []).some((e) => e.kind === 'measure');
        if (hasDimension || hasMeasure) continue;
        out.push({
          ruleId: 'R018',
          category: CATEGORY,
          severity: 'info',
          title: 'Объект без измерения',
          target: { kind: 'object', name: obj.name, id: obj.id },
          message: `У объекта «${obj.name}» нет ни измерения, ни меры`,
          detail: 'Объект не отображает данные.',
          recommendation: 'Добавить измерение или удалить объект.',
        });
      }
      return out;
    },
  },
];

