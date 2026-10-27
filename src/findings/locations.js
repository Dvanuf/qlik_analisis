/**
 * Привязка находок к строкам скрипта загрузки.
 *
 * Находка должна показывать, где именно в скрипте объект появляется: у
 * таблицы это строка её `LOAD`, у поля — строки, где поле грузится или
 * участвует в выражении, у переменной — строка `LET`/`SET`.
 *
 * Одной строки мало: поле может грузиться в нескольких таблицах, а мера —
 * ссылаться на поля из разных загрузок. Поэтому находка хранит список
 * строк, а интерфейс подсвечивает их все.
 */
import { extractReferences, canonicalFieldName } from '../normalize.js';
import { namesInStatement } from '../script/usage.js';

/**
 * Ищет имя в строке скрипта как отдельное слово.
 *
 * Границы слова: перед именем не должно быть буквы/цифры/подчёркивания.
 * Это отсекает совпадения вроде `OrderID` для имени `ID`.
 *
 * @param {string} line — строка скрипта
 * @param {string} name — искомое имя
 * @returns {boolean}
 */
export function lineMentions(line, name) {
  const target = String(name ?? '').trim();
  if (!target) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i');
  return re.test(line);
}

/**
 * Индекс скрипта: имя → строки, где оно встречается.
 *
 * Строки ищутся по самому тексту скрипта, а не по номеру оператора:
 * поле может упоминаться в нескольких местах, и пользователю нужны все
 * конкретные строки, а не начало блока.
 *
 * @param {object} model — модель скрипта из parseScript
 * @param {string[]} [scriptLines] — строки скрипта
 * @returns {Map<string, number[]>}
 */
export function buildScriptIndex(model, scriptLines = []) {
  const index = new Map();

  const add = (name, line) => {
    const key = canonicalFieldName(name);
    if (!key || line == null) return;
    if (!index.has(key)) index.set(key, []);
    const lines = index.get(key);
    if (!lines.includes(line)) lines.push(line);
  };

  // Имена, которые вообще встречаются в скрипте.
  const names = new Set();
  for (const l of model.loads ?? []) {
    names.add(l.table);
    for (const f of l.fields ?? []) names.add(f);
  }
  for (const r of model.residents ?? []) {
    names.add(r.table);
    names.add(r.target);
    for (const f of r.fields ?? []) names.add(f);
  }
  for (const j of model.joins ?? []) names.add(j.table);
  for (const i of model.into ?? []) names.add(i.table);
  for (const s of model.stores ?? []) names.add(s.table);
  for (const v of model.variables ?? []) names.add(v.name);
  for (const c of model.concatenates ?? []) names.add(c.target);
  for (const o of model.others ?? []) {
    for (const name of namesInStatement(o.raw)) names.add(name);
  }
  for (const v of model.variables ?? []) {
    for (const name of namesInStatement(v.value)) names.add(name);
  }

  // Точные строки вхождений — по самому тексту скрипта.
  if (scriptLines.length) {
    for (const name of names) {
      if (!name) continue;
      const key = canonicalFieldName(name);
      for (let i = 0; i < scriptLines.length; i += 1) {
        if (lineMentions(scriptLines[i], name)) add(name, i + 1);
      }
    }
    return index;
  }

  // Скрипта нет — остаются строки операторов.
  for (const l of model.loads ?? []) {
    add(l.table, l.line);
    for (const f of l.fields ?? []) add(f, l.line);
  }
  for (const r of model.residents ?? []) {
    add(r.table, r.line);
    add(r.target, r.line);
    for (const f of r.fields ?? []) add(f, r.line);
  }
  for (const j of model.joins ?? []) add(j.table, j.line);
  for (const i of model.into ?? []) add(i.table, i.line);
  for (const s of model.stores ?? []) add(s.table, s.line);
  for (const v of model.variables ?? []) add(v.name, v.line);
  for (const c of model.concatenates ?? []) add(c.target, c.line);

  for (const lines of index.values()) lines.sort((a, b) => a - b);
  return index;
}

/**
 * Поля, на которые ссылается объект приложения.
 *
 * @param {object} graph — граф приложения
 * @param {object} finding — находка
 * @returns {string[]} имена полей
 */
function objectFields(graph, finding) {
  const id = finding?.target?.id;
  const name = finding?.target?.name;
  const obj = (graph?.objects ?? []).find((o) => (id && o.id === id)
    || (!id && name && String(o.name ?? '') === String(name)));
  if (!obj) return [];
  const fields = new Set();
  for (const e of obj.expressions ?? []) {
    for (const f of extractReferences(e.expr).fields) fields.add(f);
  }
  return [...fields];
}

/**
 * Строки скрипта, относящиеся к находке.
 *
 * @param {object} finding — находка
 * @param {Map<string, number[]>} index — индекс скрипта
 * @param {object} [graph] — граф приложения (для находок об объектах)
 * @param {number} [limit] — сколько строк вернуть максимум
 * @returns {{lines: number[], total: number}}
 */
export function findingLines(finding, index, graph = null, limit = 12) {
  // Строки, уже известные правилу (например, ошибка скрипта с сервера).
  if (finding?.line != null) return { lines: [finding.line], total: 1 };

  const kind = finding?.target?.kind;
  const name = finding?.target?.name;
  const found = new Set();

  if (['table', 'field', 'variable'].includes(kind) && name) {
    for (const line of index.get(canonicalFieldName(name)) ?? []) found.add(line);
  } else if (['object', 'expression', 'measure', 'dimension', 'sheet'].includes(kind)) {
    // Объект живёт в интерфейсе, в скрипте его нет. Но его поля — есть:
    // показываем строки, где они грузятся, — это и есть «место проблемы».
    if (graph) {
      for (const field of objectFields(graph, finding)) {
        for (const line of index.get(canonicalFieldName(field)) ?? []) found.add(line);
      }
    }
  }

  const lines = [...found].sort((a, b) => a - b);
  return { lines: lines.slice(0, limit), total: lines.length };
}
