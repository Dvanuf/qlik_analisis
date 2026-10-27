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
 * Доля уникальных значений, выше которой поле (вне ключей) считается
 * высококардинальным: 0.9 — почти все строки различны.
 */
export const CARDINALITY_RATIO_LIMIT = 0.9;

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

  {
    id: 'R019',
    category: CATEGORY,
    severity: 'info',
    title: 'Неиспользуемое подключение к данным',
    description: 'Подключение объявлено в приложении, но его строки подключения нет в скрипте загрузки.',
    recommendation: 'Удалить подключение из приложения либо использовать его в скрипте.',
    run(ctx) {
      const out = [];
      const connections = ctx.graph.connections ?? [];
      if (!connections.length) {
        return { findings: [], note: 'Подключения к данным недоступны.' };
      }
      const script = String(ctx.graph.script ?? '');
      for (const conn of connections) {
        const needle = String(conn.connectionString ?? '').trim();
        if (!needle) continue;
        // Строка подключения может встречаться в скрипте как есть
        // или с кавычками — сравниваем по существу.
        const bare = needle.replace(/^['"]|['"]$/g, '');
        const inScript = script.includes(needle) || script.includes(bare);
        if (inScript) continue;
        out.push({
          ruleId: 'R019',
          category: CATEGORY,
          severity: 'info',
          title: 'Неиспользуемое подключение к данным',
          target: { kind: 'connection', name: conn.name || conn.id, id: conn.id },
          message: `Подключение «${conn.name || conn.id}» не встречается в скрипте загрузки`,
          detail: `Тип: ${conn.type || 'не указан'}. Строка подключения: ${needle.slice(0, 160)}`,
          recommendation: 'Удалить подключение из приложения либо использовать его в скрипте.',
        });
      }
      return out;
    },
  },

  {
    id: 'R020',
    category: CATEGORY,
    severity: 'info',
    title: 'Поле высокой кардинальности вне ключа',
    description: 'Поле с числом уникальных значений, близким к числу строк, не является ключом — '
      + 'оно занимает столько же памяти, сколько ключ, но не даёт пользы.',
    recommendation: 'Убрать поле из модели либо использовать его как ключ, если оно действительно уникально.',
    run(ctx) {
      const out = [];
      const fields = ctx.graph.fields ?? [];
      if (!fields.length) {
        return { findings: [], note: 'Модель данных недоступна.' };
      }
      const limit = ctx.config?.thresholds?.R020?.maxDistinctRatio ?? CARDINALITY_RATIO_LIMIT;
      for (const f of fields) {
        if (f.key) continue;
        const rows = Number(f.rows);
        const distinct = Number(f.distinct);
        if (!Number.isFinite(rows) || !Number.isFinite(distinct)) continue;
        if (rows < 100) continue; // на малых таблицах это норма, а не проблема
        const ratio = distinct / rows;
        if (ratio < limit) continue;
        out.push({
          ruleId: 'R020',
          category: CATEGORY,
          severity: 'info',
          title: 'Поле высокой кардинальности вне ключа',
          target: { kind: 'field', name: f.name, id: f.name },
          message: `Поле «${f.name}»: ${distinct} уникальных значений при ${rows} строк`,
          detail: `Доля уникальных значений: ${Math.round(ratio * 100)}% (порог ${Math.round(limit * 100)}%).`
            + ' Поле занимает столько же памяти, сколько ключевое, но ключом не является.',
          recommendation: 'Убрать поле из модели либо объявить его ключевым.',
        });
      }
      return out;
    },
  },

  {
    id: 'R021',
    category: CATEGORY,
    severity: 'info',
    title: 'CONCATENATE без ключа',
    description: 'Таблицы объединены через CONCATENATE, но у результата нет ключевых полей — '
      + 'совпадение строк разных таблиц не проверяется.',
    recommendation: 'Добавить ключевое поле в объединённую таблицу либо разделять таблицы.',
    run(ctx) {
      const out = [];
      const loads = ctx.script.loads ?? [];
      if (!loads.length) {
        return { findings: [], note: 'Скрипт загрузки недоступен.' };
      }
      const keyTables = new Set();
      for (const t of ctx.graph.tables ?? []) {
        if ((t.keyFields ?? []).length) keyTables.add(String(t.name).toLowerCase());
      }
      for (const l of loads) {
        if (!l.concatenated) continue;
        const target = String(l.table ?? '').toLowerCase();
        if (!target) continue;
        if (keyTables.has(target)) continue;
        out.push({
          ruleId: 'R021',
          category: CATEGORY,
          severity: 'info',
          title: 'CONCATENATE без ключа',
          target: { kind: 'table', name: l.table, id: l.table },
          message: `Таблица «${l.table}» получена через CONCATENATE, но ключевых полей у неё нет`,
          detail: 'Строки объединённых таблиц не сверяются по ключу — возможны дубли и «пустые» совпадения.',
          recommendation: 'Добавить ключевое поле в объединённую таблицу.',
          line: l.line,
        });
      }
      return out;
    },
  },
];

