/**
 * Индекс использования ресурсов приложения.
 *
 * Строится один раз поверх «сырого» графа и используется всеми правилами:
 *  - каждое поле: где используется (объекты, переменные, скрипт);
 *  - каждая переменная: где используется;
 *  - таблица поля, ключевые поля, признак синтетического ключа.
 */
import { extractReferences, canonicalFieldName } from './normalize.js';

/**
 * @param {object} graph
 * @returns {object} индекс
 */
export function buildIndex(graph, scriptModel = null) {
  const fieldUsage = new Map();
  const variableUsage = new Map();
  const objectById = new Map();

  const touchField = (name) => {
    const id = canonicalFieldName(name);
    if (!fieldUsage.has(id)) {
      fieldUsage.set(id, {
        name, id, table: null, isKey: false, usedIn: [], usedInFrontEnd: false, usedInScript: false,
      });
    }
    return fieldUsage.get(id);
  };

  const touchVariable = (name) => {
    const id = canonicalFieldName(name);
    if (!variableUsage.has(id)) {
      variableUsage.set(id, { name, id, usedIn: [], usedInFrontEnd: false, value: null });
    }
    return variableUsage.get(id);
  };

  // 1. Поля и переменные из выражений объектов
  for (const obj of graph.objects ?? []) {
    objectById.set(obj.id, obj);
    for (const e of obj.expressions ?? []) {
      const refs = extractReferences(e.expr);
      for (const f of refs.fields) {
        const entry = touchField(f);
        entry.usedIn.push({ kind: 'object', id: obj.id, name: obj.name, expr: e.expr });
        entry.usedInFrontEnd = true;
      }
      for (const v of refs.variables) {
        const entry = touchVariable(v);
        entry.usedIn.push({ kind: 'object', id: obj.id, name: obj.name, expr: e.expr });
        entry.usedInFrontEnd = true;
      }
    }
  }

  // 2. Переменные: их определения и использование
  for (const v of graph.variables ?? []) {
    const entry = touchVariable(v.name);
    entry.value = v.value ?? '';
    entry.description = v.description ?? '';
    if (v.value) {
      const refs = extractReferences(v.value);
      for (const f of refs.fields) {
        const fe = touchField(f);
        fe.usedIn.push({ kind: 'variable', id: v.name, name: v.name, expr: v.value });
        fe.usedInFrontEnd = true;
      }
      for (const dep of refs.variables) {
        const de = touchVariable(dep);
        de.usedIn.push({ kind: 'variable', id: v.name, name: v.name, expr: v.value });
        de.usedInFrontEnd = true;
      }
    }
  }

  // 3. Поля, объявленные в скрипте загрузки (только из операторов LOAD/RESIDENT —
  //    иначе в список попадают идентификаторы из выражений).
  const declaredFields = new Map(); // каноническое имя -> исходное написание
  if (scriptModel) {
    for (const l of scriptModel.loads ?? []) {
      for (const f of l.fields ?? []) declaredFields.set(canonicalFieldName(f), f);
    }
    for (const r of scriptModel.residents ?? []) {
      for (const f of r.fields ?? []) declaredFields.set(canonicalFieldName(f), f);
    }
  }
  if (declaredFields.size === 0) {
    for (const f of graph.meta?.scriptFields ?? []) {
      declaredFields.set(canonicalFieldName(f), f);
    }
  }

  // 4. Привязка полей к таблицам + метаданные полей
  const fieldMeta = new Map();
  for (const f of graph.fields ?? []) {
    const id = canonicalFieldName(f.name);
    const entry = touchField(f.name);
    entry.table = f.table ?? entry.table;
    fieldMeta.set(id, f);
    if (f.key) entry.isKey = true;
  }

  // 4.1. Поля, объявленные в скрипте, но не используемые во фронт-енде
  for (const [key, original] of declaredFields) {
    const entry = touchField(original);
    entry.usedInScript = true;
  }

  // 5. Таблицы
  const tableByName = new Map();
  for (const t of graph.tables ?? []) {
    tableByName.set(canonicalFieldName(t.name), t);
    for (const fname of t.fields ?? []) {
      const entry = touchField(fname);
      if (!entry.table) entry.table = t.name;
    }
  }

  // 6. Объекты листов: считаем объекты на листе
  const objectsPerSheet = new Map();
  for (const obj of graph.objects ?? []) {
    const sheet = (graph.sheets ?? []).find((s) => s.id === obj.sheetId);
    const key = sheet?.id ?? 'unknown';
    objectsPerSheet.set(key, (objectsPerSheet.get(key) ?? 0) + 1);
  }

  return {
    fieldUsage,
    variableUsage,
    fieldMeta,
    tableByName,
    objectById,
    objectsPerSheet,
    /**
     * Есть ли данные фронт-енда (объекты приложения).
     * Без них нельзя доказать, что поле «не используется» — такие правила пропускаются.
     */
    frontEndAvailable: (graph.objects ?? []).length > 0,
    /** Все поля, реально используемые во фронт-енде */
    usedFields: new Set([...fieldUsage.values()].filter((f) => f.usedInFrontEnd).map((f) => f.id)),
    /** Поля, встречающиеся только в скрипте */
    scriptOnlyFields: new Set([...fieldUsage.values()].filter((f) => f.usedInScript && !f.usedInFrontEnd).map((f) => f.id)),
  };
}

/** Утилита: список выражений приложения с указанием владельца. */
export function allExpressions(graph) {
  const list = [];
  for (const obj of graph.objects ?? []) {
    for (const e of obj.expressions ?? []) {
      list.push({ owner: obj, kind: e.kind, expr: e.expr });
    }
  }
  for (const v of graph.variables ?? []) {
    if (v.value) list.push({ owner: { id: v.name, name: v.name, type: 'variable' }, kind: 'variable', expr: v.value });
  }
  return list;
}
