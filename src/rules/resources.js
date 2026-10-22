/**
 * Правила категории Resources — «балласт» приложения: неиспользуемые поля и таблицы,
 * пустые данные, ключи, которые можно AutoNumber. Каждое правило умеет подсказать
 * конкретное исправление скрипта (fix).
 */
import { canonicalFieldName } from '../normalize.js';

const CATEGORY = 'Resources';

export const resourceRules = [
  {
    id: 'R001',
    category: CATEGORY,
    severity: 'warning',
    title: 'Неиспользуемое поле',
    description: 'Поле загружено в модель данных, но не используется ни в одном выражении объекта или переменной.',
    recommendation: 'Удалить поле из модели данных — экономия оперативной памяти и лицензионной квоты Qlik Cloud.',
    run(ctx) {
      const findings = [];
      // Без данных фронт-енда нельзя доказать, что поле не используется.
      if (!ctx.index?.frontEndAvailable) {
        return {
          findings: [],
          note: 'Пропущено: не удалось получить список объектов приложения — без них usage поля не определить.',
        };
      }
      for (const entry of ctx.index.fieldUsage.values()) {
        if (entry.usedInFrontEnd) continue;
        if (entry.isKey) continue; // ключевые поля служат связями
        if (!entry.table) continue; // происхождение поля неизвестно — не судим
        const meta = ctx.index.fieldMeta.get(entry.id);
        findings.push({
          ruleId: 'R001',
          category: CATEGORY,
          severity: 'warning',
          title: 'Неиспользуемое поле',
          target: { kind: 'field', name: entry.name, id: entry.name },
          message: `Поле «${entry.name}» (таблица ${entry.table}) не используется во фронт-енде`,
          detail: meta?.rows != null
            ? `Строк: ${meta.rows}, уникальных значений: ${meta.distinct ?? 'н/д'}`
            : 'Объём данных неизвестен — требуется подключение к движку.',
          impact: { rows: meta?.rows ?? null, distinct: meta?.distinct ?? null },
          recommendation: 'Добавить DROP FIELD в конец скрипта загрузки.',
          fix: { kind: 'dropField', payload: entry.name },
        });
      }
      return findings;
    },
  },

  {
    id: 'R002',
    category: CATEGORY,
    severity: 'warning',
    title: 'Поле используется только в скрипте',
    description: 'Поле участвует в трансформациях скрипта, но не используется в визуальном слое.',
    recommendation: 'Проверить, можно ли убрать поле из загрузки целиком, а не только удалить его в конце скрипта.',
    run(ctx) {
      const findings = [];
      // «Используется только в скрипте» — утверждение о фронт-енде:
      // без списка объектов его нельзя доказать.
      if (!ctx.index?.frontEndAvailable) {
        return {
          findings: [],
          note: 'Пропущено: не удалось получить список объектов приложения — без них usage поля не определить.',
        };
      }
      for (const key of ctx.index.scriptOnlyFields) {
        const entry = ctx.index.fieldUsage.get(key);
        if (!entry) continue;
        findings.push({
          ruleId: 'R002',
          category: CATEGORY,
          severity: 'warning',
          title: 'Поле используется только в скрипте',
          target: { kind: 'field', name: entry.name, id: entry.name },
          message: `Поле «${entry.name}» используется только в скрипте загрузки`,
          detail: 'Возможно, поле можно не загружать вовсе — это снизит расход памяти при перезагрузке.',
          recommendation: 'Проанализировать скрипт: поле участвует только в промежуточных вычислениях.',
        });
      }
      return findings;
    },
  },

  {
    id: 'R003',
    category: CATEGORY,
    severity: 'warning',
    title: 'Неиспользуемая таблица',
    description: 'Ни одно поле таблицы не используется во фронт-енде — таблицу можно удалить.',
    recommendation: 'Добавить DROP TABLE в конец скрипта загрузки.',
    run(ctx) {
      const findings = [];
      if (!ctx.index?.frontEndAvailable) {
        return {
          findings: [],
          note: 'Пропущено: не удалось получить список объектов приложения — без них usage таблицы не определить.',
        };
      }
      for (const t of ctx.graph.tables ?? []) {
        const fields = t.fields ?? [];
        if (!fields.length) continue;
        const used = fields.filter((f) => ctx.index.usedFields.has(canonicalFieldName(f)));
        if (used.length > 0) continue;
        findings.push({
          ruleId: 'R003',
          category: CATEGORY,
          severity: 'warning',
          title: 'Неиспользуемая таблица',
          target: { kind: 'table', name: t.name, id: t.name },
          message: `Таблица «${t.name}» (${fields.length} полей) не используется во фронт-енде`,
          detail: t.rows != null ? `Строк: ${t.rows}` : 'Объём данных неизвестен.',
          impact: { rows: t.rows ?? null },
          recommendation: 'Добавить DROP TABLE в конец скрипта загрузки.',
          fix: { kind: 'dropTable', payload: t.name },
        });
      }
      return findings;
    },
  },

  {
    id: 'R004',
    category: CATEGORY,
    severity: 'info',
    title: 'Неиспользуемая переменная',
    description: 'Переменная объявлена, но нигде не используется.',
    recommendation: 'Удалить переменную из скрипта.',
    run(ctx) {
      const findings = [];
      for (const v of ctx.graph.variables ?? []) {
        const usage = ctx.index.variableUsage.get(canonicalFieldName(v.name));
        if (!usage || usage.usedInFrontEnd) continue;
        findings.push({
          ruleId: 'R004',
          category: CATEGORY,
          severity: 'info',
          title: 'Неиспользуемая переменная',
          target: { kind: 'variable', name: v.name, id: v.name },
          message: `Переменная «${v.name}» не используется`,
          recommendation: 'Удалить объявление переменной из скрипта.',
        });
      }
      return findings;
    },
  },

  {
    id: 'R005',
    category: CATEGORY,
    severity: 'warning',
    title: 'Поле полностью заполнено NULL',
    description: 'Все значения поля равны NULL — поле бесполезно для аналитики.',
    recommendation: 'Исключить поле из модели данных либо исправить источник данных.',
    run(ctx) {
      const findings = [];
      for (const f of ctx.graph.fields ?? []) {
        if (f.nonNulls === 0 && f.rows > 0) {
          findings.push({
            ruleId: 'R005',
            category: CATEGORY,
            severity: 'warning',
            title: 'Поле полностью заполнено NULL',
            target: { kind: 'field', name: f.name, id: f.name },
            message: `Поле «${f.name}» (${f.table}) содержит только NULL (${f.rows} строк)`,
            impact: { rows: f.rows, distinct: f.distinct ?? null },
            recommendation: 'Удалить поле из модели данных или исправить загрузку.',
            fix: { kind: 'dropField', payload: f.name },
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'R006',
    category: CATEGORY,
    severity: 'warning',
    title: 'Пустая таблица',
    description: 'Таблица загружена, но не содержит ни одной строки.',
    recommendation: 'Проверить условия загрузки (WHERE) и источник данных.',
    run(ctx) {
      const findings = [];
      for (const t of ctx.graph.tables ?? []) {
        if (t.rows === 0) {
          findings.push({
            ruleId: 'R006',
            category: CATEGORY,
            severity: 'warning',
            title: 'Пустая таблица',
            target: { kind: 'table', name: t.name, id: t.name },
            message: `Таблица «${t.name}» пуста (0 строк)`,
            recommendation: 'Проверить фильтры загрузки и корректность источника.',
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'R007',
    category: CATEGORY,
    severity: 'info',
    title: 'Ключ можно заменить на AutoNumber',
    description: 'Ключевое поле уникально и без NULL — его можно заменить счётчиком AutoNumber.',
    recommendation: 'Использовать AutoNumber вместо исходного ключа: экономит память и ускоряет joins.',
    run(ctx) {
      const findings = [];
      for (const f of ctx.graph.fields ?? []) {
        if (!f.key || f.rows == null || f.distinct == null) continue;
        if (f.nonNulls != null && f.nonNulls !== f.rows) continue;
        if (f.distinct !== f.rows) continue;
        findings.push({
          ruleId: 'R007',
          category: CATEGORY,
          severity: 'info',
          title: 'Ключ можно заменить на AutoNumber',
          target: { kind: 'field', name: f.name, id: f.name },
          message: `Ключевое поле «${f.name}» уникально (${f.rows} строк) — подходит для AutoNumber`,
          impact: { rows: f.rows, distinct: f.distinct },
          recommendation: 'Заменить ключ на AutoNumber в скрипте загрузки.',
          fix: { kind: 'autoNumber', payload: f.name },
        });
      }
      return findings;
    },
  },

  {
    id: 'R008',
    category: CATEGORY,
    severity: 'info',
    title: 'Лист без объектов',
    description: 'На листе нет ни одного визуального объекта.',
    recommendation: 'Удалить пустой лист.',
    run(ctx) {
      const findings = [];
      for (const s of ctx.graph.sheets ?? []) {
        if ((ctx.index.objectsPerSheet.get(s.id) ?? 0) === 0) {
          findings.push({
            ruleId: 'R008',
            category: CATEGORY,
            severity: 'info',
            title: 'Лист без объектов',
            target: { kind: 'sheet', name: s.name, id: s.id },
            message: `Лист «${s.name}» не содержит объектов`,
            recommendation: 'Удалить пустой лист из приложения.',
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'R009',
    category: CATEGORY,
    severity: 'info',
    title: 'Поле-константа',
    description: 'Поле содержит единственное уникальное значение — избыточно для аналитики.',
    recommendation: 'Проверить, нужен ли атрибут в модели данных.',
    run(ctx) {
      const findings = [];
      for (const f of ctx.graph.fields ?? []) {
        if (f.distinct !== 1 || f.key) continue;
        findings.push({
          ruleId: 'R009',
          category: CATEGORY,
          severity: 'info',
          title: 'Поле-константа',
          target: { kind: 'field', name: f.name, id: f.name },
          message: `Поле «${f.name}» (${f.table}) содержит одно уникальное значение`,
          impact: { rows: f.rows ?? null },
          recommendation: 'Рассмотреть удаление поля из модели данных.',
        });
      }
      return findings;
    },
  },
];
