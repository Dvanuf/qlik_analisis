/**
 * Outline скрипта: структура по разделам, «шаги» таблицы человеческим
 * языком, поток построения из resident-источников и недостижимый код.
 *
 * Всё это выводится из уже разобранной модели скрипта (parse.js) — новых
 * запросов к серверу не требуется.
 */

/**
 * Строит outline скрипта.
 *
 * @param {object} model — модель скрипта из parseScript
 * @returns {object} структура скрипта
 */
export function buildOutline(model) {
  return {
    sections: buildSections(model),
    steps: buildTableSteps(model),
    residentFlow: buildResidentFlow(model),
    unreachable: buildUnreachable(model),
  };
}

/**
 * Разделы скрипта: что создаётся в каждом разделе.
 *
 * @param {object} model
 * @returns {object[]}
 */
function buildSections(model) {
  const sections = [];
  let current = { name: '(без раздела)', line: 0, tables: [], subs: [], includes: [], variables: [] };
  sections.push(current);

  // Операторы идут в порядке строк — сортируем, чтобы собрать разделы.
  const events = [
    ...(model.sections ?? []).map((s) => ({ ...s, kind: 'section' })),
    ...(model.loads ?? []).map((l) => ({ line: l.line, kind: 'table', value: l.table })),
    ...(model.residents ?? []).map((r) => ({ line: r.line, kind: 'table', value: r.target || r.table })),
    ...(model.subs ?? []).map((s) => ({ line: s.line, kind: 'sub', value: s.name })),
    ...(model.includes ?? []).map((i) => ({ line: i.line, kind: 'include', value: i.file })),
    ...(model.variables ?? []).map((v) => ({ line: v.line, kind: 'variable', value: v.name })),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  for (const ev of events) {
    if (ev.kind === 'section') {
      current = { name: ev.name, line: ev.line, tables: [], subs: [], includes: [], variables: [] };
      sections.push(current);
      continue;
    }
    if (ev.kind === 'table' && ev.value) current.tables.push(ev.value);
    else if (ev.kind === 'sub') current.subs.push(ev.value);
    else if (ev.kind === 'include') current.includes.push(ev.value);
    else if (ev.kind === 'variable') current.variables.push(ev.value);
  }

  // Пустые разделы в структуре не нужны: первый («без раздела») тоже
  // показываем, только если в нём что-то есть.
  return sections.filter((s, i) => (i === 0 && s.name !== '(без раздела)')
    || s.tables.length || s.subs.length || s.includes.length || s.variables.length);
}

/**
 * «Шаги» построения таблицы человеческим языком.
 *
 * @param {object} model
 * @returns {object[]} список шагов
 */
function buildTableSteps(model) {
  const steps = [];
  const add = (table, text, line) => {
    if (!table) return;
    steps.push({ table, text, line: line ?? 0 });
  };

  for (const l of model.loads ?? []) {
    const source = l.source ? ` из ${l.source}` : '';
    const filter = l.hasWhere ? ' с фильтром WHERE' : '';
    add(l.table, `Загрузка данных${source}${filter}`, l.line);
  }
  for (const r of model.residents ?? []) {
    add(r.target || r.table, `Перезапись таблицы на основе ${r.table} (RESIDENT)`, r.line);
  }
  for (const j of model.joins ?? []) {
    add(j.table, `Соединение с ${j.table} (${j.joinType})`, j.line);
  }
  for (const c of model.concatenates ?? []) {
    add(c.target, 'Склейка таблиц (CONCATENATE)', c.line);
  }
  for (const s of model.stores ?? []) {
    add(s.table, 'Сохранение таблицы в файл (STORE)', s.line);
  }
  for (const d of model.drops ?? []) {
    add(d.kind === 'table' ? d.name : null, `Удаление ${d.kind === 'table' ? 'таблицы' : 'полей'}`, d.line);
  }
  for (const r of model.renames ?? []) {
    add(r.to, `Переименование ${r.from} → ${r.to}`, r.line);
  }

  return steps.sort((a, b) => a.line - b.line);
}

/**
 * Поток построения таблицы: из каких resident-источников она выросла.
 *
 * @param {object} model
 * @returns {object[]} по одной записи на таблицу
 */
function buildResidentFlow(model) {
  const flow = new Map();
  for (const l of model.loads ?? []) {
    if (!l.table) continue;
    flow.set(l.table, { table: l.table, sources: [], line: l.line });
  }
  for (const r of model.residents ?? []) {
    const target = r.target || r.table;
    if (!target) continue;
    if (!flow.has(target)) flow.set(target, { table: target, sources: [], line: r.line });
    flow.get(target).sources.push(r.table);
  }
  return [...flow.values()];
}

/**
 * Недостижимый код: операторы после безусловного EXIT SCRIPT.
 *
 * @param {object} model
 * @returns {object[]} недостижимые операторы
 */
function buildUnreachable(model) {
  const exits = model.exits ?? [];
  if (!exits.length) return [];
  // Последний EXIT SCRIPT безусловный — всё после него не выполняется.
  const last = exits[exits.length - 1];
  const after = [];
  for (const st of model.others ?? []) {
    if ((st.line ?? 0) > last.line) after.push(st);
  }
  for (const l of model.loads ?? []) {
    if ((l.line ?? 0) > last.line) after.push({ raw: `LOAD ${l.table}`, line: l.line });
  }
  for (const v of model.variables ?? []) {
    if ((v.line ?? 0) > last.line) after.push({ raw: `${v.name} = …`, line: v.line });
  }
  return after.sort((a, b) => a.line - b.line);
}

/**
 * Поиск по скрипту: таблица, подпрограмма или переменная.
 *
 * @param {object} model
 * @param {string} query — что ищем
 * @returns {object[]} найденные места
 */
export function searchScript(model, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [];
  const found = [];

  const add = (kind, name, line, extra = '') => {
    if (!name) return;
    if (!String(name).toLowerCase().includes(needle)) return;
    found.push({ kind, name, line: line ?? 0, detail: extra });
  };

  for (const l of model.loads ?? []) add('таблица', l.table, l.line, l.source ?? '');
  for (const r of model.residents ?? []) {
    add('таблица', r.table, r.line, 'RESIDENT');
    // RESIDENT Products пишет в Sales — обе таблицы участвуют в операции.
    if (r.target) add('таблица', r.target, r.line, 'цель RESIDENT');
  }
  for (const j of model.joins ?? []) add('таблица', j.table, j.line, 'JOIN');
  for (const s of model.subs ?? []) add('подпрограмма', s.name, s.line, s.params.join(', '));
  for (const c of model.subCalls ?? []) add('вызов подпрограммы', c.name, c.line, c.args.join(', '));
  for (const v of model.variables ?? []) add('переменная', v.name, v.line, v.value ?? '');
  for (const i of model.includes ?? []) add('include', i.file, i.line);

  return found.sort((a, b) => a.line - b.line);
}
