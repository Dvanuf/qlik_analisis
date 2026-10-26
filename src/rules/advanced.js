/**
 * Дополнительные правила: полнота ключей, кардинальность связей,
 * хранение числовых данных, превью приложения, устаревшие типы
 * визуализаций, синтетические ключи и условная агрегация.
 */
import { extractReferences } from '../normalize.js';
import { allExpressions } from '../graph.js';

const AGG_FUNCTIONS = new Set([
  'sum', 'count', 'counta', 'countd', 'avg', 'min', 'max', 'range', 'stdev', 'stdevp',
  'deviation', 'var', 'varp', 'skew', 'kurtosis', 'first', 'last', 'concatenate',
  'firstsortedvalue', 'lastsortedvalue', 'minsortedvalue',
]);

export const advancedRules = [
  {
    id: 'R010',
    category: 'Resources',
    severity: 'warning',
    title: 'Неполный ключ',
    description: 'Ключевое поле имеет subset ratio меньше 100% — часть значений ключа отсутствует, это признак потери данных при связи таблиц.',
    recommendation: 'Проверить источник данных и полноту ключа; при необходимости пересобрать ключ.',
    run(ctx) {
      const out = [];
      for (const f of ctx.graph.fields ?? []) {
        if (!f.key) continue;
        const ratio = f.subsetRatio;
        if (ratio == null || ratio >= 0.999) continue;
        out.push({
          ruleId: 'R010',
          category: 'Resources',
          severity: 'warning',
          title: 'Неполный ключ',
          target: { kind: 'field', name: f.name, id: f.name },
          message: `Ключевое поле «${f.name}» (${f.table}) заполнено на ${Math.round(ratio * 100)}%`,
          detail: 'Часть значений ключа отсутствует — вероятна потеря данных при связи таблиц.',
          recommendation: 'Проверить источник и полноту ключа.',
          impact: { rows: f.rows ?? null },
        });
      }
      return out;
    },
  },

  {
    id: 'R011',
    category: 'Practices',
    severity: 'info',
    title: 'Таблицы можно объединить',
    description: 'Между таблицами связь «один к одному» — их можно объединить внешним join, сократив число связей.',
    recommendation: 'Объединить таблицы внешним join, если это допустимо по бизнес-логике.',
    run(ctx) {
      const out = [];
      const assoc = ctx.graph.meta?.associations ?? [];
      for (const a of assoc) {
        const card = String(a.qCardinality ?? a.cardinality ?? '').toLowerCase();
        if (!card.includes('1:1') && card !== 'one-to-one') continue;
        out.push({
          ruleId: 'R011',
          category: 'Practices',
          severity: 'info',
          title: 'Таблицы можно объединить',
          target: { kind: 'table', name: a.qTable ?? a.table ?? '?', id: a.qTable ?? '' },
          message: `Связь «${a.qField ?? a.field ?? '?'}» имеет кардинальность 1:1 — таблицы можно объединить внешним join`,
          detail: 'Устраняет лишнюю связь в модели данных.',
          recommendation: 'Объединить таблицы внешним join.',
        });
      }
      return out;
    },
  },

  {
    id: 'R012',
    category: 'Resources',
    severity: 'info',
    title: 'Неоптимальное хранение чисел',
    description: 'Числовое поле хранится неоптимально: высокое количество уникальных значений при большом объёме данных.',
    recommendation: 'Рассмотреть хранение как float или уменьшить разрядность; точную оценку памяти даёт отчёт движка.',
    run(ctx) {
      const out = [];
      // Пороги настраиваются в редакторе правил: сколько строк и какая доля
      // уникальных значений считаются «плотным» полем.
      const limits = ctx.config?.thresholds?.R012 ?? {};
      const minRows = limits.minRows ?? 1000;
      const minDistinctRatio = limits.minDistinctRatio ?? 0.5;
      for (const f of ctx.graph.fields ?? []) {
        if (f.key) continue;
        if (!Array.isArray(f.tags) || !f.tags.includes('$numeric')) continue;
        if (!f.rows || f.rows < minRows || !f.distinct) continue;
        if (f.distinct / f.rows < minDistinctRatio) continue;
        out.push({
          ruleId: 'R012',
          category: 'Resources',
          severity: 'info',
          title: 'Неоптимальное хранение чисел',
          target: { kind: 'field', name: f.name, id: f.name },
          message: `Числовое поле «${f.name}» (${f.table}): ${f.distinct} уникальных значений на ${f.rows} строк`,
          detail: 'Плотность значений указывает на неоптимальное хранение (dual вместо float).',
          recommendation: 'Проверить тип хранения поля; точную экономию памяти покажет отчёт движка.',
          impact: { rows: f.rows, distinct: f.distinct },
        });
      }
      return out;
    },
  },

  {
    id: 'R013',
    category: 'Resources',
    severity: 'info',
    title: 'Нет превью приложения',
    description: 'У приложения нет изображения-превью — в списке приложений оно выглядит безликим.',
    recommendation: 'Задать превью приложения в свойствах приложения.',
    run(ctx) {
      const thumb = ctx.graph.meta?.thumbnail;
      if (thumb === undefined) return []; // данных нет — правило неприменимо
      const hasThumb = Boolean(thumb && (thumb.qUrl || thumb.url || Object.keys(thumb).length));
      if (hasThumb) return [];
      return [{
        ruleId: 'R013',
        category: 'Resources',
        severity: 'info',
        title: 'Нет превью приложения',
        target: { kind: 'app', name: ctx.graph.appName ?? 'приложение', id: ctx.graph.appId ?? '' },
        message: 'У приложения не задано изображение-превью',
        detail: 'В списке приложений хаба такое приложение сложнее опознать.',
        recommendation: 'Задать превью в свойствах приложения.',
      }];
    },
  },

  {
    id: 'R014',
    category: 'Practices',
    severity: 'info',
    title: 'Устаревший тип визуализации',
    description: 'Используется устаревший тип визуализации.',
    recommendation: 'Заменить на поддерживаемый объект.',
    run(ctx) {
      const deprecated = ctx.config?.deprecatedVisualizationTypes ?? [];
      if (!deprecated.length) return []; // список не настроен — правило молчит
      const out = [];
      for (const obj of ctx.graph.objects ?? []) {
        const type = String(obj.type ?? '').toLowerCase();
        if (!deprecated.includes(type)) continue;
        out.push({
          ruleId: 'R014',
          category: 'Practices',
          severity: 'info',
          title: 'Устаревший тип визуализации',
          target: { kind: 'object', name: obj.name, id: obj.id },
          message: `Объект «${obj.name}» имеет устаревший тип «${obj.type}»`,
          detail: 'Тип помечен как deprecated/obsolete в документации Qlik.',
          recommendation: 'Заменить на поддерживаемый объект.',
        });
      }
      return out;
    },
  },

  {
    id: 'P012',
    category: 'Practices',
    severity: 'warning',
    title: 'Поле синтетического ключа',
    description: 'Поле входит в синтетический ключ — такие ключи ухудшают связность и нагрузку на joins.',
    recommendation: 'Оставить один ключевой атрибут, остальные сделать обычными полями.',
    run(ctx) {
      const out = [];
      for (const t of ctx.graph.tables ?? []) {
        if (!t.synthetic) continue;
        for (const keyField of t.keyFields ?? []) {
          out.push({
            ruleId: 'P012',
            category: 'Practices',
            severity: 'warning',
            title: 'Поле синтетического ключа',
            target: { kind: 'field', name: keyField, id: keyField },
            message: `Поле «${keyField}» входит в синтетический ключ таблицы «${t.name}»`,
            detail: `Ключевые поля таблицы: ${(t.keyFields ?? []).join(', ')}`,
            recommendation: 'Свести таблицу к одному ключевому полю.',
          });
        }
      }
      return out;
    },
  },

  {
    id: 'P011',
    category: 'Practices',
    severity: 'warning',
    title: 'Условная агрегация',
    description: 'В выражении условная агрегация: считаются несколько агрегатов сразу, что замедляет расчёт.',
    recommendation: 'Вынести условие в вычисляемое поле или в set analysis.',
    run(ctx) {
      const out = [];
      for (const item of allExpressions(ctx.graph)) {
        const expr = String(item.expr ?? '');
        if (!/\bif\s*\(/i.test(expr)) continue;
        const refs = extractReferences(expr);
        const aggs = refs.functions.filter((f) => AGG_FUNCTIONS.has(f.toLowerCase()));
        if (aggs.length < 1) continue;
        out.push({
          ruleId: 'P011',
          category: 'Practices',
          severity: 'warning',
          title: 'Условная агрегация',
          target: { kind: 'object', name: item.owner.name, id: item.owner.id },
          message: `«${item.owner.name}»: условная агрегация (${[...new Set(aggs)].join(', ')}) внутри IF`,
          detail: `Выражение: ${expr.slice(0, 160)}`,
          recommendation: 'Вынести условие в вычисляемое поле или использовать set analysis.',
        });
      }
      return out;
    },
  },
];
