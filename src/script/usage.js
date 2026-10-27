/**
 * Использование таблиц и полей в скрипте загрузки.
 *
 * Правила «неиспользуемое поле» и «неиспользуемая таблица» смотрят только на
 * фронт-энд. Но данные живут и в скрипте: поле может участвовать в
 * преобразованиях (WHERE, маппинги), а таблица — быть источником другой
 * таблицы (RESIDENT, JOIN, CONCATENATE). Такие объекты удалять нельзя:
 * `DROP TABLE` в конце скрипта сломает загрузку.
 *
 * Модуль отвечает на два вопроса:
 *  1. какие таблицы упомянуты в скрипте (кроме собственного оператора загрузки);
 *  2. какие поля реально используются в выражениях скрипта (а не просто
 *     перечислены в списке LOAD).
 */
import { tokenize } from '../normalize.js';

/** Ключевые слова Qlik — они не полями и не таблицами. */
const SCRIPT_KEYWORDS = new Set([
  'and', 'or', 'not', 'in', 'like', 'between', 'asc', 'desc', 'mapping',
  'when', 'then', 'else', 'end', 'true', 'false', 'null', 'mod', 'div',
  'load', 'from', 'where', 'group', 'by', 'order', 'resident', 'join',
  'left', 'right', 'inner', 'outer', 'full', 'concatenate', 'into', 'let',
  'set', 'drop', 'rename', 'store', 'table', 'field', 'fields', 'distinct',
  'if', 'then', 'else', 'end', 'exit', 'script', 'sub', 'call', 'include',
  'unconditional', 'noconcatenate', 'autonumber', 'total', 'no', 'format',
]);

/** Приводит имя к виду, по которому его удобно сравнивать. */
function canon(name) {
  return String(name ?? '').replace(/^[[\]`'"]/g, '').replace(/[[\]`'"]$/g, '').trim().toLowerCase();
}

/**
 * Имена, встречающиеся в тексте оператора.
 *
 * Учитываются и поля в квадратных скобках, и голые идентификаторы:
 * в скрипте Qlik поле можно писать без скобок.
 *
 * @param {string} raw — текст оператора
 * @returns {string[]} имена в нижнем регистре
 */
export function namesInStatement(raw) {
  const out = new Set();
  for (const tk of tokenize(String(raw ?? ''))) {
    if (tk.type !== 'field' && tk.type !== 'ident') continue;
    const value = canon(tk.value);
    if (!value || SCRIPT_KEYWORDS.has(value)) continue;
    out.add(value);
  }
  return [...out];
}

/**
 * Анализ использования таблиц и полей в скрипте.
 *
 * @param {object} model — модель скрипта из parseScript
 * @param {object} graph — граф приложения (для списка известных полей и таблиц)
 * @returns {{tables: Map<string, {lines: number[]}>, fields: Map<string, {lines: number[]}>}}
 */
export function analyzeScriptUsage(model, graph = {}) {
  const knownFields = new Set((graph.fields ?? []).map((f) => canon(f.name)));
  for (const t of graph.tables ?? []) {
    for (const f of t.fields ?? []) knownFields.add(canon(f));
  }
  const knownTables = new Set((graph.tables ?? []).map((t) => canon(t.name)));

  const tables = new Map();
  const fields = new Map();

  const add = (map, key, line) => {
    if (!key) return;
    const id = canon(key);
    if (!id) return;
    if (!map.has(id)) map.set(id, { lines: [] });
    const entry = map.get(id);
    if (line != null && !entry.lines.includes(line)) entry.lines.push(line);
  };

  /** Операторы скрипта вместе с тем, что они объявляют. */
  const statements = [
    ...(model.loads ?? []).map((l) => ({
      raw: l.raw, line: l.line, declaredFields: l.fields ?? [],
      definesTable: l.table, definesField: null,
    })),
    ...(model.residents ?? []).map((r) => ({
      raw: r.raw, line: r.line, declaredFields: r.fields ?? [],
      definesTable: r.target, definesField: null,
    })),
    ...(model.joins ?? []).map((j) => ({
      raw: j.raw, line: j.line, declaredFields: [],
      definesTable: null, definesField: null,
    })),
    ...(model.into ?? []).map((i) => ({
      raw: i.raw, line: i.line, declaredFields: [], definesTable: i.table, definesField: null,
    })),
    ...(model.variables ?? []).map((v) => ({
      raw: v.raw ?? `SET ${v.name} = ${v.value ?? ''}`, line: v.line,
      declaredFields: [], definesTable: null, definesField: null,
    })),
    ...(model.others ?? []).map((o) => ({
      raw: o.raw, line: o.line, declaredFields: [], definesTable: null, definesField: null,
    })),
  ];

  for (const st of statements) {
    const declared = new Set((st.declaredFields ?? []).map(canon));
    const definedTable = canon(st.definesTable);
    for (const name of namesInStatement(st.raw)) {
      // Объявление поля в списке LOAD — это не использование поля.
      if (declared.has(name)) continue;
      // Таблица, которую оператор создаёт, — не «упоминание» (иначе каждая
      // таблица считалась бы использованной собственной загрузкой).
      if (definedTable && name === definedTable) continue;
      if (knownTables.has(name)) add(tables, name, st.line);
      if (knownFields.has(name)) add(fields, name, st.line);
    }
  }

  // Таблицы-источники: RESIDENT/JOIN/CONCATENATE читают данные таблицы,
  // поэтому её удаление сломает загрузку, даже если во фронт-энде её нет.
  for (const r of model.residents ?? []) add(tables, r.table, r.line);
  for (const j of model.joins ?? []) add(tables, j.table, j.line);
  for (const c of model.concatenates ?? []) add(tables, c.target, c.line);
  for (const s of model.stores ?? []) add(tables, s.table, s.line);

  return { tables, fields };
}

/**
 * Пустой результат анализа — когда скрипта нет.
 */
export function emptyScriptUsage() {
  return { tables: new Map(), fields: new Map() };
}
