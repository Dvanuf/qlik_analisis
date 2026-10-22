/**
 * Правила категории Practices — качество проектирования: дубли выражений,
 * вычисляемые измерения, синтетические ключи, обращения к ключевым полям в выражениях.
 */
import { canonicalize, extractReferences, canonicalFieldName } from '../normalize.js';
import { allExpressions } from '../graph.js';

const CATEGORY = 'Practices';

const AGG_FUNCTIONS = new Set([
  'sum', 'count', 'counta', 'countd', 'avg', 'min', 'max', 'range', 'stdev', 'stdevp',
  'deviation', 'var', 'varp', 'skew', 'kurtosis', 'first', 'last', 'concatenate',
  'firstsortedvalue', 'lastsortedvalue', 'minsortedvalue', 'aggr',
]);

/** Карта переменных: имя -> определение (для раскрытия ссылок). */
function variableMap(graph) {
  const map = new Map();
  for (const v of graph.variables ?? []) map.set(v.name, v.value ?? '');
  return map;
}

export const practiceRules = [
  {
    id: 'P001',
    category: CATEGORY,
    severity: 'warning',
    title: 'Дублирующееся выражение',
    description: 'Одинаковое выражение (с учётом регистра, пробелов и раскрытия переменных) используется в нескольких местах.',
    recommendation: 'Вынести выражение в переменную и переиспользовать её — меньше копипаста, меньше расхождений в цифрах.',
    run(ctx) {
      const findings = [];
      const vmap = variableMap(ctx.graph);
      const buckets = new Map();
      for (const item of allExpressions(ctx.graph)) {
        const canon = canonicalize(item.expr, { variableMap: vmap, expandVariables: false });
        if (!canon) continue;
        if (!buckets.has(canon)) buckets.set(canon, []);
        buckets.get(canon).push(item);
      }
      for (const [canon, items] of buckets) {
        if (items.length < 2) continue;
        const owners = items.map((i) => i.owner.name);
        findings.push({
          ruleId: 'P001',
          category: CATEGORY,
          severity: 'warning',
          title: 'Дублирующееся выражение',
          target: { kind: 'expression', name: owners[0], id: items[0].owner.id },
          message: `Одно и то же выражение используется ${items.length} раз: ${owners.join(', ')}`,
          detail: `Нормализованная форма: ${canon.slice(0, 160)}`,
          recommendation: 'Вынести в переменную и переиспользовать.',
        });
      }
      return findings;
    },
  },

  {
    id: 'P002',
    category: CATEGORY,
    severity: 'warning',
    title: 'Совпадающие меры с разными именами',
    description: 'Две меры имеют одинаковую эффективную формулу (различия только в именах переменных, регистре и пробелах).',
    recommendation: 'Оставить одну меру и использовать её повторно — аналог проверки «Expression Matching Measure» в QSDA Pro.',
    run(ctx) {
      const findings = [];
      const vmap = variableMap(ctx.graph);
      const buckets = new Map();
      for (const item of allExpressions(ctx.graph)) {
        if (item.kind !== 'measure') continue;
        const canon = canonicalize(item.expr, { variableMap: vmap, expandVariables: true });
        if (!canon) continue;
        if (!buckets.has(canon)) buckets.set(canon, []);
        buckets.get(canon).push(item);
      }
      for (const [canon, items] of buckets) {
        if (items.length < 2) continue;
        const names = items.map((i) => i.owner.name);
        if (new Set(names).size < 2) continue; // одинаковые имена — это P001
        findings.push({
          ruleId: 'P002',
          category: CATEGORY,
          severity: 'warning',
          title: 'Совпадающие меры с разными именами',
          target: { kind: 'measure', name: names[0], id: items[0].owner.id },
          message: `Меры «${names.join('» и «')}» вычисляют одно и то же`,
          detail: `Нормализованная форма: ${canon.slice(0, 160)}`,
          recommendation: 'Свести к одной мере и ссылаться на неё.',
        });
      }
      return findings;
    },
  },

  {
    id: 'P003',
    category: CATEGORY,
    severity: 'warning',
    title: 'Ключевое поле используется в выражении',
    description: 'Обращение к ключевому полю внутри выражения часто приводит к резкому росту времени расчёта.',
    recommendation: 'Использовать неключевое поле; при необходимости создать новое поле вне ключа.',
    run(ctx) {
      const findings = [];
      for (const item of allExpressions(ctx.graph)) {
        const refs = extractReferences(item.expr);
        for (const f of refs.fields) {
          const meta = ctx.index.fieldMeta.get(canonicalFieldName(f));
          if (!meta?.key) continue;
          findings.push({
            ruleId: 'P003',
            category: CATEGORY,
            severity: 'warning',
            title: 'Ключевое поле используется в выражении',
            target: { kind: 'expression', name: item.owner.name, id: item.owner.id },
            message: `Выражение «${item.owner.name}» использует ключевое поле «${f}»`,
            detail: `Выражение: ${item.expr}`,
            recommendation: 'Заменить на неключевое поле или создать производное поле.',
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'P004',
    category: CATEGORY,
    severity: 'info',
    title: 'Дубликат названия объекта',
    description: 'Два и более объектов приложения имеют одинаковое имя.',
    recommendation: 'Переименовать объекты: по названию их различают в отчётах и при поддержке.',
    run(ctx) {
      const findings = [];
      const buckets = new Map();
      for (const obj of ctx.graph.objects ?? []) {
        const key = String(obj.name ?? '').trim().toLowerCase();
        if (!key) continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(obj);
      }
      for (const [, objs] of buckets) {
        if (objs.length < 2) continue;
        findings.push({
          ruleId: 'P004',
          category: CATEGORY,
          severity: 'info',
          title: 'Дубликат названия объекта',
          target: { kind: 'object', name: objs[0].name, id: objs[0].id },
          message: `Имя «${objs[0].name}» используется ${objs.length} объектами: ${objs.map((o) => o.id).join(', ')}`,
          recommendation: 'Переименовать объекты, добавив контекст (лист/смысл).',
        });
      }
      return findings;
    },
  },

  {
    id: 'P005',
    category: CATEGORY,
    severity: 'warning',
    title: 'Синтетический ключ',
    description: 'Таблица содержит несколько ключевых полей — движок создаёт синтетический ключ, что ухудшает производительность joins.',
    recommendation: 'Оставить один ключ, остальные поля сделать обычными атрибутами.',
    run(ctx) {
      const findings = [];
      for (const t of ctx.graph.tables ?? []) {
        if (!t.synthetic) continue;
        findings.push({
          ruleId: 'P005',
          category: CATEGORY,
          severity: 'warning',
          title: 'Синтетический ключ',
          target: { kind: 'table', name: t.name, id: t.name },
          message: `Таблица «${t.name}» имеет ${(t.keyFields ?? []).length} ключевых поля: ${(t.keyFields ?? []).join(', ')}`,
          recommendation: 'Оставить один ключ и разгрузить остальные поля.',
        });
      }
      return findings;
    },
  },

  {
    id: 'P006',
    category: CATEGORY,
    severity: 'warning',
    title: 'Вычисляемое измерение',
    description: 'Измерение содержит агрегацию — это мера, вычисленная в контексте измерения, и главный источник тормозов.',
    recommendation: 'Перенести логику в меру или в вычисляемое поле на этапе загрузки.',
    run(ctx) {
      const findings = [];
      for (const item of allExpressions(ctx.graph)) {
        if (item.kind !== 'dimension') continue;
        const refs = extractReferences(item.expr);
        const used = refs.functions.filter((f) => AGG_FUNCTIONS.has(f.toLowerCase()));
        if (!used.length) continue;
        findings.push({
          ruleId: 'P006',
          category: CATEGORY,
          severity: 'warning',
          title: 'Вычисляемое измерение',
          target: { kind: 'object', name: item.owner.name, id: item.owner.id },
          message: `Измерение «${item.owner.name}» содержит агрегацию: ${[...new Set(used)].join(', ')}`,
          detail: `Выражение: ${item.expr}`,
          recommendation: 'Перенести в меру или в скрипт загрузки.',
        });
      }
      return findings;
    },
  },

  {
    id: 'P007',
    category: CATEGORY,
    severity: 'warning',
    title: 'Выражение по нескольким таблицам',
    description: 'Выражение ссылается на поля разных таблиц — Qlik выполняет дополнительные joins.',
    recommendation: 'Разделить выражение или вынести связь в модель данных.',
    run(ctx) {
      const findings = [];
      for (const item of allExpressions(ctx.graph)) {
        const refs = extractReferences(item.expr);
        const tables = new Set();
        for (const f of refs.fields) {
          const meta = ctx.index.fieldMeta.get(canonicalFieldName(f));
          if (meta?.table) tables.add(meta.table);
        }
        if (tables.size < 2) continue;
        findings.push({
          ruleId: 'P007',
          category: CATEGORY,
          severity: 'warning',
          title: 'Выражение по нескольким таблицам',
          target: { kind: 'object', name: item.owner.name, id: item.owner.id },
          message: `«${item.owner.name}» ссылается на ${tables.size} таблиц: ${[...tables].join(', ')}`,
          detail: `Выражение: ${item.expr}`,
          recommendation: 'Упростить выражение или вынести связь в модель данных.',
        });
      }
      return findings;
    },
  },

  {
    id: 'P008',
    category: CATEGORY,
    severity: 'warning',
    title: 'Data island (Aggr-выражение)',
    description: 'Aggr создаёт data island — вычисление идёт в памяти приложения и резко нагружает сервер.',
    recommendation: 'По возможности обойтись без Aggr или вынести расчёт в скрипт загрузки.',
    run(ctx) {
      const findings = [];
      for (const item of allExpressions(ctx.graph)) {
        const refs = extractReferences(item.expr);
        if (!refs.functions.some((f) => f.toLowerCase() === 'aggr')) continue;
        findings.push({
          ruleId: 'P008',
          category: CATEGORY,
          severity: 'warning',
          title: 'Data island (Aggr-выражение)',
          target: { kind: 'object', name: item.owner.name, id: item.owner.id },
          message: `«${item.owner.name}» использует Aggr()`,
          detail: `Выражение: ${item.expr}`,
          recommendation: 'Заменить на обычную агрегацию или пересчитать в скрипте.',
        });
      }
      return findings;
    },
  },

  {
    id: 'P009',
    category: CATEGORY,
    severity: 'info',
    title: 'Сложное выражение',
    description: 'Выражение длинное или глубоко вложенное — его сложно читать и тяжело отлаживать.',
    recommendation: 'Разбить выражение на части, вынести в LET или в переменную.',
    run(ctx) {
      const findings = [];
      const maxLength = ctx.config?.maxExpressionLength ?? 200;
      for (const item of allExpressions(ctx.graph)) {
        const len = String(item.expr ?? '').length;
        const depth = maxParenDepth(item.expr);
        if (len <= maxLength && depth <= 4) continue;
        findings.push({
          ruleId: 'P009',
          category: CATEGORY,
          severity: 'info',
          title: 'Сложное выражение',
          target: { kind: 'object', name: item.owner.name, id: item.owner.id },
          message: `«${item.owner.name}»: длина ${len} символов, вложенность ${depth}`,
          detail: `Выражение: ${item.expr}`,
          recommendation: 'Разбить на части, вынести в LET или переменную.',
        });
      }
      return findings;
    },
  },

  {
    id: 'P010',
    category: CATEGORY,
    severity: 'info',
    title: 'Несогласованное именование',
    description: 'Имена объектов не следуют принятому в команде соглашению (например, префиксы dim_/fact_/var_).',
    recommendation: 'Привести имена к соглашению команды.',
    run(ctx) {
      const findings = [];
      const prefixes = ctx.config?.namePrefixes ?? ['dim_', 'fact_', 'var_', 'ext_'];
      for (const obj of ctx.graph.objects ?? []) {
        const name = String(obj.name ?? '');
        if (!name) continue;
        if (prefixes.some((p) => name.toLowerCase().startsWith(p.toLowerCase()))) continue;
        findings.push({
          ruleId: 'P010',
          category: CATEGORY,
          severity: 'info',
          title: 'Несогласованное именование',
          target: { kind: 'object', name: obj.name, id: obj.id },
          message: `Имя «${name}» не соответствует соглашению (${prefixes.join(', ')})`,
          recommendation: 'Переименовать объект согласно соглашению команды.',
        });
      }
      return findings;
    },
  },
];

/** Максимальная глубина вложенности скобок. */
function maxParenDepth(expr) {
  let depth = 0;
  let max = 0;
  for (const ch of String(expr ?? '')) {
    if (ch === '(') { depth += 1; max = Math.max(max, depth); }
    else if (ch === ')') depth -= 1;
  }
  return max;
}
