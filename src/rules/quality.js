/**
 * Правила категории Quality — ошибки и дефекты, которые ломают или искажают расчёты.
 * Все правила детерминированные: работают по статическому разбору выражений.
 */
import { checkStructure, extractReferences, canonicalFieldName } from '../normalize.js';
import { QLIK_FUNCTIONS } from './qfuncs.js';
import { allExpressions } from '../graph.js';

const CATEGORY = 'Quality';

export const qualityRules = [
  {
    id: 'Q001',
    category: CATEGORY,
    severity: 'error',
    title: 'Синтаксическая ошибка в выражении',
    description: 'Выражение не проходит структурную проверку: незакрытые скобки, незакрытая строка или висящий оператор.',
    recommendation: 'Исправить выражение. В Qlik Sense Desktop проверьте синтаксис: Ctrl+ → Check syntax.',
    run(ctx) {
      const findings = [];
      for (const item of allExpressions(ctx.graph)) {
        for (const problem of checkStructure(item.expr)) {
          findings.push({
            ruleId: 'Q001',
            category: CATEGORY,
            severity: 'error',
            title: 'Синтаксическая ошибка в выражении',
            target: { kind: 'expression', name: item.owner.name, id: item.owner.id },
            message: `${problem.message} — «${truncate(item.expr)}»`,
            detail: `Проблема: ${problem.code}`,
            recommendation: 'Исправить выражение; проверка синтаксиса в редакторе скрипта.',
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'Q002',
    category: CATEGORY,
    severity: 'error',
    title: 'Ссылка на несуществующее поле',
    description: 'Выражение ссылается на поле, которого нет в модели данных приложения.',
    recommendation: 'Исправить имя поля либо загрузить недостающее поле в модель данных.',
    run(ctx) {
      const findings = [];
      const known = new Set();
      for (const f of ctx.graph.fields ?? []) known.add(canonicalFieldName(f.name));
      for (const t of ctx.graph.tables ?? []) {
        for (const f of t.fields ?? []) known.add(canonicalFieldName(f));
      }
      if (known.size === 0) return findings;

      for (const item of allExpressions(ctx.graph)) {
        const refs = extractReferences(item.expr);
        for (const f of refs.fields) {
          if (!known.has(canonicalFieldName(f))) {
            findings.push({
              ruleId: 'Q002',
              category: CATEGORY,
              severity: 'error',
              title: 'Ссылка на несуществующее поле',
              target: { kind: 'expression', name: item.owner.name, id: item.owner.id },
              message: `Поле «${f}» не найдено в модели данных`,
              detail: `Выражение: «${truncate(item.expr)}»`,
              recommendation: 'Проверить имя поля или добавить поле в модель данных.',
            });
          }
        }
      }
      return findings;
    },
  },

  {
    id: 'Q003',
    category: CATEGORY,
    severity: 'error',
    title: 'Ссылка на неопределённую переменную',
    description: 'Выражение использует переменную, которая не объявлена в приложении.',
    recommendation: 'Объявить переменную в скрипте (LET/SET) или исправить ссылку.',
    run(ctx) {
      const findings = [];
      const declared = ctx.graph.variables ?? [];
      if (!declared.length) return findings;
      const known = new Set(declared.map((v) => canonicalFieldName(v.name)));

      for (const item of allExpressions(ctx.graph)) {
        const refs = extractReferences(item.expr);
        for (const v of refs.variables) {
          if (!known.has(canonicalFieldName(v))) {
            findings.push({
              ruleId: 'Q003',
              category: CATEGORY,
              severity: 'error',
              title: 'Ссылка на неопределённую переменную',
              target: { kind: 'expression', name: item.owner.name, id: item.owner.id },
              message: `Переменная «${v}» не объявлена`,
              detail: `Выражение: «${truncate(item.expr)}»`,
              recommendation: 'Объявить переменную в скрипте или исправить ссылку.',
            });
          }
        }
      }
      return findings;
    },
  },

  {
    id: 'Q004',
    category: CATEGORY,
    severity: 'warning',
    title: 'Неизвестная функция',
    description: 'В выражении вызвана функция, которой нет в справочнике функций Qlik Sense — вероятно, опечатка.',
    recommendation: 'Проверить имя функции; при необходимости добавить функцию в справочник правила.',
    run(ctx) {
      const findings = [];
      for (const item of allExpressions(ctx.graph)) {
        const refs = extractReferences(item.expr);
        for (const fn of refs.functions) {
          if (!QLIK_FUNCTIONS.has(fn.toLowerCase())) {
            findings.push({
              ruleId: 'Q004',
              category: CATEGORY,
              severity: 'warning',
              title: 'Неизвестная функция',
              target: { kind: 'expression', name: item.owner.name, id: item.owner.id },
              message: `Функция «${fn}()» не найдена в справочнике Qlik`,
              detail: `Выражение: «${truncate(item.expr)}»`,
              recommendation: 'Проверить написание функции либо добавить её в QLIK_FUNCTIONS.',
            });
          }
        }
      }
      return findings;
    },
  },

  {
    id: 'Q005',
    category: CATEGORY,
    severity: 'warning',
    title: 'Пустое выражение',
    description: 'У объекта есть измерение или мера без выражения — объект не будет отображать данные.',
    recommendation: 'Заполнить выражение или удалить пустое измерение/меру.',
    run(ctx) {
      const findings = [];
      for (const obj of ctx.graph.objects ?? []) {
        for (const e of obj.expressions ?? []) {
          if (!e.expr || !e.expr.trim()) {
            findings.push({
              ruleId: 'Q005',
              category: CATEGORY,
              severity: 'warning',
              title: 'Пустое выражение',
              target: { kind: 'object', name: obj.name, id: obj.id },
              message: `В объекте «${obj.name}» пустое ${e.kind === 'measure' ? 'выражение меры' : 'выражение измерения'}`,
              recommendation: 'Заполнить выражение или удалить его.',
            });
          }
        }
      }
      return findings;
    },
  },

  {
    id: 'Q006',
    category: CATEGORY,
    severity: 'info',
    title: 'Объект без описания',
    description: 'У объекта приложения не заполнено поле description — его назначение непонятно команде.',
    recommendation: 'Заполнить описание объекта: помогает при ревью и при передаче поддержке.',
    run(ctx) {
      const findings = [];
      for (const obj of ctx.graph.objects ?? []) {
        if (!obj.description || !obj.description.trim()) {
          findings.push({
            ruleId: 'Q006',
            category: CATEGORY,
            severity: 'info',
            title: 'Объект без описания',
            target: { kind: 'object', name: obj.name, id: obj.id },
            message: `У объекта «${obj.name}» не заполнено описание`,
            recommendation: 'Добавить краткое описание назначения объекта.',
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'Q007',
    category: CATEGORY,
    severity: 'info',
    title: 'Переменная без описания',
    description: 'Переменная приложения не документирована.',
    recommendation: 'Добавить описание: переменные — общий контракт между разработчиками.',
    run(ctx) {
      const findings = [];
      for (const v of ctx.graph.variables ?? []) {
        if (!v.description || !v.description.trim()) {
          findings.push({
            ruleId: 'Q007',
            category: CATEGORY,
            severity: 'info',
            title: 'Переменная без описания',
            target: { kind: 'variable', name: v.name, id: v.name },
            message: `Переменная «${v.name}» не документирована`,
            recommendation: 'Добавить описание в скрипте (комментарий) и в свойствах переменной.',
          });
        }
      }
      return findings;
    },
  },
];

function truncate(str, max = 120) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
