/**
 * Схема модели данных приложения в трёх состояниях, с пометками проблем.
 *
 * Проекция уже собранных данных — новых запросов к серверу не делает:
 *   asBuilt  — «как сформировано»: движковые таблицы + промежуточные и
 *              удалённые (DROP) из lineage/скрипта, статусы STORE/DROP;
 *   final    — «текущая финальная»: то, что реально в приложении
 *              (движковые; при анализе файла — LOAD-цели минус DROP);
 *   afterFix — «рекомендованная»: final минус то, что предлагается
 *              удалить находками (fix.kind dropField/dropTable).
 *
 * Проблемы по типам (problemsByType): unusedFields (R001/R002),
 * unusedTable (R003), synthetic (P005/P012), incompleteKeys (R010),
 * mn (R022), merge 1:1 (R011), empty (R005/R006/R009), cardinality
 * (R020), errors (severity=error), overload (0–100 — доля лишних
 * строк/полей, по образцу wasted-штрафа оценки).
 *
 * Детерминировано: сортировка и обрезка связей — по именам, без времени
 * и случайности. Читает вкладка «Формирование» (три секции-аккордеона).
 */
import { canonicalFieldName } from '../normalize.js';

/** Верхний предел рёбер схемы: защита от «паутины» на широких моделях. */
export const SCHEMA_MAX_LINKS = 100;

const SEV_RANK = { error: 3, warning: 2, info: 1 };

/** Правило → тип проблемы на схеме. */
const RULE_TYPE = {
  R001: 'unusedFields', R002: 'unusedFields',
  R003: 'unusedTable',
  P005: 'synthetic', P012: 'synthetic',
  R010: 'incompleteKeys',
  R022: 'mn',
  R011: 'merge',
  R005: 'empty', R006: 'empty', R009: 'empty',
  R020: 'cardinality',
};

/** Критерии оценки модели — легенда и панель «Качество модели». */
export const MODEL_CRITERIA = [
  { id: 'unusedFields', label: 'Неиспользуемые поля', hint: 'R001/R002 — поле не используется ни во фронт-энде, ни в скрипте' },
  { id: 'unusedTable', label: 'Неиспользуемые таблицы', hint: 'R003 — ни одно поле таблицы не используется' },
  { id: 'synthetic', label: 'Синтетические ключи', hint: 'P005/P012 — автоключ Qlik из нескольких общих полей; строится явный ключ' },
  { id: 'incompleteKeys', label: 'Неполные ключи', hint: 'R010 — subset ratio < 100%: значения ключа не совпадают между таблицами' },
  { id: 'mn', label: 'Связи многие-ко-многим', hint: 'R022 — ключ неуникален в обеих таблицах, строки перемножаются' },
  { id: 'merge', label: 'Таблицы можно объединить', hint: 'R011 — связь 1:1 по всему объёму' },
  { id: 'empty', label: 'Пустые поля и таблицы', hint: 'R005/R006/R009 — полностью NULL, ноль строк, константы' },
  { id: 'cardinality', label: 'Высокая кардинальность вне ключа', hint: 'R020 — почти уникальное поле не является ключом' },
  { id: 'overload', label: 'Перегрузка данными', hint: 'доля лишних строк/полей таблицы (0–100)' },
  { id: 'errors', label: 'Ошибки', hint: 'находки с важностью «ошибка»' },
];

/** Пустой счётчик проблем: severity-корзины + перечень правил. */
function emptyProblems() {
  return { error: 0, warning: 0, info: 0, total: 0, rules: new Map() };
}

/** Добавляет находку в корзину проблем (счётчики + слияние правил). */
function addProblem(bucket, finding, weight) {
  const sev = SEV_RANK[finding.severity] != null ? finding.severity : 'info';
  bucket[sev] += weight;
  bucket.total += weight;
  const entry = bucket.rules.get(finding.ruleId);
  if (entry) {
    entry.count += weight;
    if (SEV_RANK[sev] > (SEV_RANK[entry.severity] ?? 0)) entry.severity = sev;
  } else {
    bucket.rules.set(finding.ruleId, {
      id: finding.ruleId,
      severity: sev,
      title: finding.title ?? finding.ruleId,
      count: weight,
    });
  }
}

/** Корзина → { problems, rules[] } для JSON (Map → отсортированный список). */
function finalizeProblems(bucket) {
  const rules = [...bucket.rules.values()].sort((a, b) => {
    const d = (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0);
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
  });
  const { error, warning, info, total } = bucket;
  return { error, warning, info, total, rules };
}

/** Типизированные проблемы из корзины + перегрузка. */
function typedProblems(bucket, fieldsLen, rows, unusedRows) {
  const t = {
    unusedFields: 0, unusedTable: 0, synthetic: 0, incompleteKeys: 0,
    mn: 0, merge: 0, empty: 0, cardinality: 0, errors: 0,
  };
  for (const r of bucket.rules.values()) {
    const type = RULE_TYPE[r.id];
    if (type) t[type] += r.count;
    if (r.severity === 'error') t.errors += r.count;
  }
  const fieldsShare = fieldsLen > 0 ? Math.min(1, t.unusedFields / fieldsLen) : 0;
  const rowsShare = rows ? Math.min(1, unusedRows / rows) : null;
  t.overload = (rowsShare != null || fieldsShare > 0)
    ? Math.round(100 * Math.min(1, (rowsShare ?? fieldsShare) * 0.7 + fieldsShare * 0.3))
    : 0;
  return t;
}

/**
 * Строит рёбра между таблицами из allowedCanon по общим именам полей;
 * поле пропускается, если fieldAllowed(tc, fc) возвращает false.
 */
function computeLinks(tablesOfField, fieldStats, assoc, allowedCanon, fieldAllowed) {
  const pairs = [];
  for (const [fc, tcs] of tablesOfField) {
    const list = [...tcs].filter((tc) => allowedCanon.has(tc));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (fieldAllowed && (!fieldAllowed(list[i], fc) || !fieldAllowed(list[j], fc))) continue;
        // Пара ориентируется по имени таблицы — результат стабилен.
        const [from, to] = [list[i], list[j]].sort((a, b) => a.localeCompare(b));
        const nonUnique = (tc) => {
          const st = fieldStats.get(`${tc}|${fc}`);
          return st?.rows != null && st?.distinct != null && st.distinct < st.rows;
        };
        const kind = assoc.has(`${from}|${to}|${fc}`)
          ? '1:1'
          : (nonUnique(from) && nonUnique(to) ? 'm:n' : 'key');
        pairs.push({ from, to, field: fc, kind });
      }
    }
  }
  pairs.sort((a, b) => (
    a.field.localeCompare(b.field)
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
  ));
  return pairs;
}

/**
 * Строит схему модели данных в трёх состояниях с пометками проблем.
 * @param {object} graph — результат экстрактора (tables, fields, meta)
 * @param {object[]} findings — итоговые находки анализа (после дедупликации)
 * @param {object|null} [lineage] — lineage-граф (промежуточные/удалённые, источники)
 * @param {object[]} [ruleStats] — статистика правил (для notes о пропусках)
 * @param {object|null} [scriptModel] — модель скрипта (parseScript): таблицы из
 *   LOAD при отсутствии движка, удаляемое из drops
 * @returns {{ asBuilt: object, final: object, afterFix: object,
 *   tables: object[], links: object[], meta: object }}
 */
export function buildDataSchema(graph, findings = [], lineage = null, ruleStats = [], scriptModel = null, index = null) {
  const notes = [];
  let tablesSrc = graph?.tables ?? [];
  let fieldsSrc = graph?.fields ?? [];

  // Таблиц нет (анализ файла/скрипта: коннектор отдаёт только текст) —
  // выводим таблицы и поля из модели скрипта: LOAD-приёмники, RESIDENT-цели,
  // поля каждого LOAD. Объёмы (строки/кардинальность) неизвестны — это
  // честно помечается в meta (modelFromScript + note).
  if (!tablesSrc.length && scriptModel?.loads?.length) {
    const tableMap = new Map();
    const addTable = (name, fields) => {
      const key = canonicalFieldName(name);
      if (!key) return;
      if (!tableMap.has(key)) {
        tableMap.set(key, { name: String(name), rows: null, synthetic: false, fields: [], seen: new Set() });
      }
      const t = tableMap.get(key);
      for (const f of fields ?? []) {
        const fc = canonicalFieldName(f);
        if (!fc || t.seen.has(fc)) continue;
        t.seen.add(fc);
        t.fields.push(f);
      }
    };
    for (const load of scriptModel.loads) addTable(load.table, load.fields);
    for (const r of scriptModel.residents ?? []) {
      if (r.target) addTable(r.target, r.fields);
    }
    tablesSrc = [...tableMap.values()].map((t) => ({
      name: t.name, rows: null, synthetic: t.synthetic, fields: t.fields, keyFields: [],
    }));
    fieldsSrc = [];
    for (const t of tablesSrc) {
      for (const f of t.fields) fieldsSrc.push({ name: String(f), table: t.name, key: false, rows: null, distinct: null });
    }
  }

  // Сводные по полям: (таблица|поле) → статистика движка (кардинальность и пр.).
  const fieldStats = new Map();
  const tablesOfField = new Map(); // canon поля → Set canon таблиц
  for (const f of fieldsSrc) {
    const tc = canonicalFieldName(f.table);
    const fc = canonicalFieldName(f.name);
    if (!tc || !fc) continue;
    fieldStats.set(`${tc}|${fc}`, f);
    if (!tablesOfField.has(fc)) tablesOfField.set(fc, new Set());
    tablesOfField.get(fc).add(tc);
  }

  // Проблемы по таблицам и полям — из находок (target: table|field),
  // плюс «лишние строки» для перегрузки (R001 impact.rows).
  const byTable = new Map();
  const tableBucket = (tc) => {
    if (!byTable.has(tc)) byTable.set(tc, emptyProblems());
    return byTable.get(tc);
  };
  const byField = new Map();
  const fieldBucket = (fc) => {
    if (!byField.has(fc)) byField.set(fc, emptyProblems());
    return byField.get(fc);
  };
  const tableExtras = new Map(); // canon → { unusedRows }
  const bumpUnusedRows = (tc, rows) => {
    if (!rows) return;
    if (!tableExtras.has(tc)) tableExtras.set(tc, { unusedRows: 0 });
    tableExtras.get(tc).unusedRows += rows;
  };

  for (const f of findings) {
    const weight = f.count ?? 1;
    const kind = f.target?.kind;
    if (kind === 'table') {
      const tc = canonicalFieldName(f.target?.name);
      if (tc) addProblem(tableBucket(tc), f, weight);
      for (const t of f.tables ?? []) {
        const extra = canonicalFieldName(t);
        if (extra && extra !== tc) addProblem(tableBucket(extra), f, weight);
      }
    } else if (kind === 'field') {
      const fc = canonicalFieldName(f.target?.name);
      if (!fc) continue;
      addProblem(fieldBucket(fc), f, weight);
      // Таблица поля в находку не пишется: помечаем все таблицы с этим полем.
      for (const tc of tablesOfField.get(fc) ?? []) {
        addProblem(tableBucket(tc), f, weight);
        if (f.ruleId === 'R001') bumpUnusedRows(tc, (f.impact?.rows ?? 0) * weight);
      }
    } else if ((f.tables ?? []).length) {
      // Скриптовые правила указывают таблицу отдельным полем.
      for (const t of f.tables) {
        const tc = canonicalFieldName(t);
        if (tc) addProblem(tableBucket(tc), f, weight);
      }
    }
  }

  // Тип источника таблицы — из lineage (ребро 'source' в узел таблицы).
  const sourceKindOf = new Map();
  if (lineage?.nodes && lineage?.edges) {
    const nodeById = new Map(lineage.nodes.map((n) => [n.id, n]));
    for (const e of lineage.edges) {
      if (e.kind !== 'source') continue;
      const src = nodeById.get(e.from);
      const tbl = nodeById.get(e.to);
      if (src?.sourceKind && tbl?.kind === 'table') {
        sourceKindOf.set(canonicalFieldName(tbl.label), src.sourceKind);
      }
    }
  }

  // Связи 1:1 из QRS/Engine: «таблица1|таблица2|поле» в обеих ориентациях.
  const assoc = new Set();
  for (const a of graph?.meta?.associations ?? []) {
    const t1 = canonicalFieldName(a.qTable);
    const t2 = canonicalFieldName(a.qTable2);
    const fl = canonicalFieldName(a.qField);
    if (t1 && t2 && fl) {
      assoc.add(`${t1}|${t2}|${fl}`);
      assoc.add(`${t2}|${t1}|${fl}`);
    }
  }

  // Удалённые (DROP): из lineage-узлов и из скрипта.
  const droppedCanon = new Set();
  for (const n of lineage?.nodes ?? []) {
    if (n.kind === 'table' && n.status === 'dropped') droppedCanon.add(canonicalFieldName(n.label));
  }
  for (const d of scriptModel?.drops ?? []) {
    if (d.kind === 'table') for (const t of d.targets ?? []) droppedCanon.add(canonicalFieldName(t));
  }

  // Правки-удаления из находок: какие таблицы/поля предлагается убрать.
  const dropTablesFix = new Set();
  const dropFieldsFix = new Set(); // `${tc}|${fc}` либо `|${fc}` (во всех таблицах)
  for (const f of findings) {
    if (f.fix?.kind === 'dropTable') {
      const tc = canonicalFieldName(typeof f.fix.payload === 'string' ? f.fix.payload : f.target?.name);
      if (tc) dropTablesFix.add(tc);
    } else if (f.fix?.kind === 'dropField') {
      const fc = canonicalFieldName(typeof f.fix.payload === 'string' ? f.fix.payload : f.fix.payload?.field ?? f.target?.name);
      if (!fc) continue;
      const tc = typeof f.fix.payload === 'object' && f.fix.payload?.table
        ? canonicalFieldName(f.fix.payload.table)
        : '';
      dropFieldsFix.add(tc ? `${tc}|${fc}` : `|${fc}`);
    }
  }

  const engineCanon = new Set(tablesSrc.map((t) => canonicalFieldName(t.name)));

  /** Сборка записи таблицы: атрибуты + поля с проблемами и типами. */
  const buildTable = (base, ctx) => {
    const tc = canonicalFieldName(base.name);
    const keyFields = new Set((base.keyFields ?? []).map(canonicalFieldName));
    const fieldsLen = (base.fields ?? []).length;
    const bucket = byTable.get(tc) ?? emptyProblems();
    const problems = finalizeProblems(bucket);
    const extras = tableExtras.get(tc) ?? { unusedRows: 0 };
    const entry = {
      name: String(base.name ?? ''),
      rows: base.rows ?? null,
      synthetic: Boolean(base.synthetic),
      sourceKind: base.sourceKind ?? null,
      keyFields: base.keyFields ?? [],
      problems: problems.rules.length ? problems : null,
      problemsByType: typedProblems(bucket, fieldsLen, base.rows ?? null, extras.unusedRows),
      fields: [],
    };
    if (ctx.dropped != null) entry.dropped = ctx.dropped;
    if (ctx.stored != null) entry.stored = ctx.stored;
    if (ctx.intermediate) entry.intermediate = true;
    if (ctx.removedByFix) entry.removedByFix = true;
    for (const fname of base.fields ?? []) {
      const fc = canonicalFieldName(fname);
      const st = fieldStats.get(`${tc}|${fc}`);
      const isKey = keyFields.has(fc) || Boolean(st?.key);
      const fBucket = byField.get(fc) ?? emptyProblems();
      const fProblems = finalizeProblems(fBucket);
      const field = {
        name: String(fname),
        key: isKey,
        // Неполный ключ (по образцу R010): совпадает не со всеми значениями.
        incompleteKey: isKey && st?.subsetRatio != null && st.subsetRatio < 1,
        unused: fBucket.rules.has('R001') || fBucket.rules.has('R002'),
        problems: fProblems.rules.length ? fProblems : null,
      };
      if (ctx.removedFields?.has(fc)) field.removedByFix = true;
      entry.fields.push(field);
    }
    return entry;
  };

  // ---- asBuilt: движковые + промежуточные/удалённые из lineage ----------
  const asBuiltSrc = [];
  const seenCanon = new Set();
  for (const n of lineage?.nodes ?? []) {
    if (n.kind !== 'table') continue;
    const tc = canonicalFieldName(n.label);
    if (!tc || seenCanon.has(tc)) continue;
    seenCanon.add(tc);
    const engine = tablesSrc.find((t) => canonicalFieldName(t.name) === tc);
    if (engine) {
      asBuiltSrc.push({
        name: engine.name, rows: engine.rows, synthetic: engine.synthetic,
        keyFields: engine.keyFields, fields: engine.fields,
        sourceKind: sourceKindOf.get(tc) ?? null,
        dropped: n.status === 'dropped', stored: Boolean(n.stored),
      });
    } else {
      // Промежуточная таблица: поля — из LOAD модели скрипта.
      const load = (scriptModel?.loads ?? []).find((l) => canonicalFieldName(l.table) === tc);
      const loadFields = [];
      for (const f of load?.fields ?? []) {
        const fc = canonicalFieldName(f);
        if (fc && !loadFields.some((x) => canonicalFieldName(x) === fc)) loadFields.push(String(f));
      }
      asBuiltSrc.push({
        name: n.label, rows: null, synthetic: false, keyFields: [], fields: loadFields,
        sourceKind: null, dropped: n.status === 'dropped', stored: Boolean(n.stored),
        intermediate: true,
      });
    }
  }
  for (const t of tablesSrc) {
    const tc = canonicalFieldName(t.name);
    if (!seenCanon.has(tc)) {
      seenCanon.add(tc);
      asBuiltSrc.push({
        name: t.name, rows: t.rows, synthetic: t.synthetic, keyFields: t.keyFields,
        fields: t.fields, sourceKind: sourceKindOf.get(tc) ?? null,
        dropped: droppedCanon.has(tc), stored: false,
      });
    }
  }

  // ---- final: без дропнутых и промежуточных -----------------------------
  const finalSrc = tablesSrc
    .filter((t) => !droppedCanon.has(canonicalFieldName(t.name)))
    .map((t) => ({
      name: t.name, rows: t.rows, synthetic: t.synthetic, keyFields: t.keyFields,
      fields: t.fields, sourceKind: sourceKindOf.get(canonicalFieldName(t.name)) ?? null,
    }));

  // ---- afterFix: final минус удаляемое по находкам ----------------------
  const afterFixSrc = finalSrc.map((t) => {
    const tc = canonicalFieldName(t.name);
    const removed = dropTablesFix.has(tc);
    const removedFields = new Set();
    if (!removed) {
      for (const fname of t.fields ?? []) {
        const fc = canonicalFieldName(fname);
        if (dropFieldsFix.has(`${tc}|${fc}`) || dropFieldsFix.has(`|${fc}`)) removedFields.add(fc);
      }
    }
    return {
      name: t.name, rows: t.rows, synthetic: t.synthetic, keyFields: t.keyFields,
      fields: removed ? [] : (t.fields ?? []).filter((f) => !removedFields.has(canonicalFieldName(f))),
      sourceKind: t.sourceKind, removedByFix: removed, removedFieldNames: removedFields,
    };
  });

  // ---- рёбра по состояниям ------------------------------------------------
  const buildLinks = (allowedCanon, fieldAllowed, extraEdges = []) => {
    const pairs = computeLinks(tablesOfField, fieldStats, assoc, allowedCanon, fieldAllowed);
    let links = pairs;
    if (pairs.length > SCHEMA_MAX_LINKS) {
      links = pairs.slice(0, SCHEMA_MAX_LINKS);
      notes.push(`Показаны первые ${SCHEMA_MAX_LINKS} связей из ${pairs.length} — схема упрощена.`);
    }
    // Цепочки построения (RESIDENT/JOIN/CONCATENATE) — без поля.
    for (const e of extraEdges) {
      if (allowedCanon.has(e.from) && allowedCanon.has(e.to)
        && !links.some((l) => l.from === e.from && l.to === e.to && l.kind === e.kind)) {
        links.push({ from: e.from, to: e.to, field: null, kind: e.kind });
      }
    }
    return links;
  };
  const buildEdgesFromLineage = (nameOf) => (lineage?.edges ?? [])
    .filter((e) => e.kind === 'resident' || e.kind === 'join' || e.kind === 'concatenate')
    .map((e) => ({
      from: canonicalFieldName(nameOf(e.from)),
      to: canonicalFieldName(nameOf(e.to)),
      kind: e.kind,
    }));
  const lineageNameById = new Map((lineage?.nodes ?? []).filter((n) => n.kind === 'table').map((n) => [n.id, n.label]));

  const asBuiltAllowed = new Set(asBuiltSrc.map((t) => canonicalFieldName(t.name)));
  const finalAllowed = new Set(finalSrc.map((t) => canonicalFieldName(t.name)));
  const afterFixAllowed = new Set(afterFixSrc.filter((t) => !t.removedByFix).map((t) => canonicalFieldName(t.name)));

  const asBuiltLinks = buildLinks(
    asBuiltAllowed,
    null,
    buildEdgesFromLineage((id) => lineageNameById.get(id) ?? id),
  );
  const finalLinks = buildLinks(finalAllowed, null);
  const afterFixLinks = buildLinks(afterFixAllowed, (tc, fc) => {
    const t = afterFixSrc.find((x) => canonicalFieldName(x.name) === tc);
    return t ? !t.removedFieldNames?.has(fc) : false;
  });

  // Сборка записей (после связей — allowed уже посчитаны).
  const asBuiltTables = asBuiltSrc.map((t) => buildTable(t, {
    dropped: t.dropped, stored: t.stored, intermediate: t.intermediate,
  }));
  const finalTables = finalSrc.map((t) => buildTable(t, {}));
  const afterFixTables = afterFixSrc.map((t) => buildTable(t, {
    removedByFix: t.removedByFix, removedFields: t.removedFieldNames,
  }));

  // Notes: что в схеме может не хватать — чтобы пометки читались честно.
  const associationsSkipped = (graph?.meta?.skipped ?? []).find((s) => s.capability === 'associations');
  if (associationsSkipped?.reason) notes.push(`Связи 1:1 недоступны: ${associationsSkipped.reason}`);
  const modelFromScript = !(graph?.meta?.capabilities ?? []).includes('dataModel');
  if (modelFromScript && tablesSrc.length) {
    notes.push('Модель построена по скрипту: объём данных (строки, кардинальность) неизвестен.');
  }
  // Пропуск проверок использования полей карточка «Качество модели»
  // показывает сама («Оценка неполная») — дублирующий note не добавляем.

  const meta = {
    notes,
    modelFromScript,
    associationsAvailable: assoc.size > 0,
    linkKinds: { '1:1': 'связь один к одному', 'm:n': 'многие ко многим', key: 'связь по ключу' },
    criteria: MODEL_CRITERIA,
    // Для честной диагностики пропуска проверок использования полей:
    // платформа, объекты и ЦИФРЫ извлечения ссылок (index.frontEndStats).
    platform: graph?.meta?.platform ?? null,
    objectsCount: (graph?.objects ?? []).length,
    frontEndStats: index?.frontEndStats ?? null,
  };

  return {
    asBuilt: { tables: asBuiltTables, links: asBuiltLinks },
    final: { tables: finalTables, links: finalLinks },
    afterFix: { tables: afterFixTables, links: afterFixLinks },
    // Совместимость с прежним видом: `tables/links` = текущая финальная.
    tables: finalTables,
    links: finalLinks,
    meta,
  };
}
