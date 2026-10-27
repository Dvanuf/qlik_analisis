/**
 * Выгрузка модели данных и метаданных приложения в Excel.
 *
 * В QS Metadata Explorer это блок «Data model (Excel)» раздела Explore:
 * отдельные листы на таблицы, поля, объекты, переменные и закладки.
 * У нас данные те же самые — берём их из графа приложения.
 */
import { buildXlsxBook } from './xlsx.js';
import { canonicalFieldName } from '../normalize.js';

/** Имя поля с пробелами — в квадратных скобках (как в скрипте Qlik). */
function ident(name) {
  const value = String(name ?? '');
  return /\s/.test(value) ? `[${value}]` : value;
}

/**
 * Где поле используется: список объектов и ролей.
 *
 * @param {object} graph
 * @returns {Map<string, {objects: string[], roles: Set<string>}>}
 */
function fieldUsage(graph) {
  const usage = new Map();
  const add = (field, object, role) => {
    const key = canonicalFieldName(field);
    if (!key) return;
    if (!usage.has(key)) usage.set(key, { objects: [], roles: new Set() });
    const entry = usage.get(key);
    if (object && !entry.objects.includes(object)) entry.objects.push(object);
    entry.roles.add(role);
  };
  for (const obj of graph.objects ?? []) {
    for (const e of obj.expressions ?? []) {
      for (const field of String(e.expr ?? '').matchAll(/\[([^\]]+)\]/g)) {
        add(field[1], obj.name ?? obj.id, e.kind === 'measure' ? 'мера' : 'измерение');
      }
    }
  }
  for (const v of graph.variables ?? []) {
    for (const field of String(v.value ?? '').matchAll(/\[([^\]]+)\]/g)) {
      add(field[1], v.name, 'переменная');
    }
  }
  for (const f of graph.fields ?? []) {
    if (String(f.name ?? '').trim()) add(f.name, '', 'скрипт');
  }
  return usage;
}

/**
 * Листы книги «Модель данных».
 *
 * @param {object} graph — граф приложения
 * @returns {Array<{name: string, headers: string[], rows: Array<Array<string|number>>}>}
 */
export function buildDataModelSheets(graph) {
  const g = graph ?? {};
  const usage = fieldUsage(g);

  const tables = (g.tables ?? []).map((t) => [
    String(t.name ?? ''),
    t.rows ?? '',
    (t.keyFields ?? []).join(', '),
    t.synthetic ? 'да' : 'нет',
    t.directDiscovery ? 'да' : 'нет',
    (t.fields ?? []).length,
  ]);

  const fields = (g.fields ?? []).map((f) => {
    const entry = usage.get(canonicalFieldName(f.name));
    return [
      String(f.name ?? ''),
      String(f.table ?? ''),
      f.key ? 'да' : 'нет',
      f.rows ?? '',
      f.distinct ?? '',
      f.nonNulls ?? '',
      f.hasNull === true ? 'да' : (f.hasNull === false ? 'нет' : ''),
      [...(entry?.roles ?? [])].sort().join(', '),
      (entry?.objects ?? []).join(', '),
    ];
  });

  const objects = (g.objects ?? []).map((o) => [
    String(o.name ?? o.id ?? ''),
    String(o.type ?? ''),
    String(o.description ?? ''),
    (o.expressions ?? []).length,
  ]);

  const variables = (g.variables ?? []).map((v) => [
    String(v.name ?? ''),
    String(v.description ?? ''),
    String(v.value ?? ''),
  ]);

  const bookmarks = (g.bookmarks ?? []).map((b) => [
    String(b.name ?? b.id ?? ''),
    (b.objectIds ?? []).length,
  ]);

  const masterObjects = (g.masterObjects ?? []).map((m) => [
    String(m.name ?? m.id ?? ''),
    String(m.definition ?? ''),
  ]);

  const connections = (g.connections ?? []).map((c) => [
    String(c.name ?? c.id ?? ''),
    String(c.type ?? ''),
    String(c.connectionString ?? ''),
  ]);

  // Измерения и меры — отдельными перечнями (QSME: Dimensions / Measures).
  const dimensions = [];
  const measures = [];
  for (const o of g.objects ?? []) {
    for (const e of o.expressions ?? []) {
      const row = [
        String(o.name ?? o.id ?? ''),
        String(o.type ?? ''),
        String(e.expr ?? ''),
      ];
      if (e.kind === 'measure') measures.push(row);
      else dimensions.push(row);
    }
  }

  const stories = (g.stories ?? []).map((s) => [
    String(s.name ?? s.id ?? ''),
    String(s.description ?? ''),
  ]);

  return [
    {
      name: 'Таблицы',
      headers: ['Таблица', 'Строк', 'Ключевые поля', 'Синтетический ключ', 'Direct Discovery', 'Полей'],
      rows: tables,
    },
    {
      name: 'Поля',
      headers: ['Поле', 'Таблица', 'Ключ', 'Строк', 'Уникальных', 'Не NULL', 'Есть NULL', 'Роли', 'Где используется'],
      rows: fields,
    },
    {
      name: 'Объекты',
      headers: ['Объект', 'Тип', 'Описание', 'Выражений'],
      rows: objects,
    },
    {
      name: 'Измерения',
      headers: ['Объект', 'Тип объекта', 'Выражение'],
      rows: dimensions,
    },
    {
      name: 'Меры',
      headers: ['Объект', 'Тип объекта', 'Выражение'],
      rows: measures,
    },
    {
      name: 'Переменные',
      headers: ['Переменная', 'Описание', 'Значение'],
      rows: variables,
    },
    {
      name: 'Закладки',
      headers: ['Закладка', 'Объектов'],
      rows: bookmarks,
    },
    {
      name: 'Истории',
      headers: ['История', 'Описание'],
      rows: stories,
    },
    {
      name: 'Master-объекты',
      headers: ['Объект', 'Определение'],
      rows: masterObjects,
    },
    {
      name: 'Подключения',
      headers: ['Подключение', 'Тип', 'Строка подключения'],
      rows: connections,
    },
  ];
}

/**
 * Формирует книгу Excel с моделью данных приложения.
 *
 * @param {object} graph — граф приложения
 * @param {string} [fileName] — имя листа по умолчанию
 * @returns {Buffer} содержимое файла .xlsx
 */
export function buildDataModelXlsx(graph, fileName = 'Модель данных') {
  return buildXlsxBook(buildDataModelSheets(graph));
}

/**
 * Имена полей, которые можно удалить: пустые и неиспользуемые.
 *
 * Нужно для выгрузки «поля к проверке» — тем же составом, что и правила
 * R001/R002, но без запуска анализа.
 *
 * @param {object} graph
 * @returns {string[]}
 */
export function removableFieldNames(graph) {
  const g = graph ?? {};
  const usage = fieldUsage(g);
  const out = [];
  for (const f of g.fields ?? []) {
    const entry = usage.get(canonicalFieldName(f.name));
    const used = (entry?.objects ?? []).length > 0;
    const empty = f.distinct === 0;
    if (!used || empty) out.push(ident(f.name));
  }
  return [...new Set(out)];
}
