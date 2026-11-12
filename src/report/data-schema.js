/**
 * Схема модели данных приложения («снежинка») с пометками проблем.
 *
 * Проекция уже собранных данных — новых запросов к серверу не делает:
 *   узлы     — graph.tables (+ поля graph.fields с ключами и кардинальностью);
 *   связи    — общие имена полей между таблицами; тип связи: '1:1' из
 *              meta.associations, 'm:n' — поле неуникально в обеих таблицах
 *              (по образцу R022), иначе 'key';
 *   проблемы — находки с target.kind 'table'|'field' (таблица поля — по
 *              graph.fields; если поле в нескольких таблицах, помечается
 *              каждая: пометка «здесь тоже есть эта проблема»);
 *   notes    — что в схеме может не хватать (связи недоступны, модель из
 *              скрипта, использование полей недоказуемо).
 *
 * Детерминировано: сортировка и обрезка связей — по именам, без времени
 * и случайности. Результат читает вкладка «Формирование» (вьюха «Модель
 * данных») — раскраска узлов/полей считается в интерфейсе из problems.
 */
import { canonicalFieldName } from '../normalize.js';

/** Верхний предел рёбер схемы: защита от «паутины» на широких моделях. */
export const SCHEMA_MAX_LINKS = 100;

const SEV_RANK = { error: 3, warning: 2, info: 1 };

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

/**
 * Строит схему модели данных с пометками проблем.
 * @param {object} graph — результат экстрактора (tables, fields, meta)
 * @param {object[]} findings — итоговые находки анализа (после дедупликации)
 * @param {object|null} [lineage] — lineage-граф (для типа источника таблицы)
 * @param {object[]} [ruleStats] — статистика правил (для notes о пропусках)
 * @param {object|null} [scriptModel] — модель скрипта (parseScript): когда
 *   движок не отдал таблиц (анализ файла/скрипта), таблицы и связи выводятся
 *   из LOAD/RESIDENT — иначе схема пуста при живом lineage.
 * @returns {{ tables: object[], links: object[], meta: object }}
 */
export function buildDataSchema(graph, findings = [], lineage = null, ruleStats = [], scriptModel = null) {
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

  // Проблемы по таблицам и полям — из находок (target: table|field).
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
      for (const tc of tablesOfField.get(fc) ?? []) addProblem(tableBucket(tc), f, weight);
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

  // Рёбра: общие имена полей между таблицами.
  const known = new Set(tablesSrc.map((t) => canonicalFieldName(t.name)));
  const pairs = [];
  for (const [fc, tcs] of tablesOfField) {
    const list = [...tcs].filter((tc) => known.has(tc));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
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
  let links = pairs;
  if (pairs.length > SCHEMA_MAX_LINKS) {
    links = pairs.slice(0, SCHEMA_MAX_LINKS);
    notes.push(`Показаны первые ${SCHEMA_MAX_LINKS} связей из ${pairs.length} — схема упрощена.`);
  }

  // Узлы-таблицы: атрибуты движка + собранные проблемы.
  const modelFromScript = !(graph?.meta?.capabilities ?? []).includes('dataModel');
  const tables = tablesSrc.map((t) => {
    const tc = canonicalFieldName(t.name);
    const keyFields = new Set((t.keyFields ?? []).map(canonicalFieldName));
    const fields = (t.fields ?? []).map((name) => {
      const fc = canonicalFieldName(name);
      const st = fieldStats.get(`${tc}|${fc}`);
      const isKey = keyFields.has(fc) || Boolean(st?.key);
      const problems = finalizeProblems(byField.get(fc) ?? emptyProblems());
      return {
        name: String(name),
        key: isKey,
        // Неполный ключ (по образцу R010): совпадает не со всеми значениями.
        incompleteKey: isKey && st?.subsetRatio != null && st.subsetRatio < 1,
        problems: problems.rules.length ? problems : null,
      };
    });
    const problems = finalizeProblems(byTable.get(tc) ?? emptyProblems());
    return {
      name: String(t.name ?? ''),
      rows: t.rows ?? null,
      synthetic: Boolean(t.synthetic),
      sourceKind: sourceKindOf.get(tc) ?? null,
      keyFields: t.keyFields ?? [],
      problems: problems.rules.length ? problems : null,
      fields,
    };
  });

  // Notes: что в схеме может не хватать — чтобы пометки читались честно.
  const associationsSkipped = (graph?.meta?.skipped ?? []).find((s) => s.capability === 'associations');
  if (associationsSkipped?.reason) notes.push(`Связи 1:1 недоступны: ${associationsSkipped.reason}`);
  if (modelFromScript && tables.length) {
    notes.push('Модель построена по скрипту: объём данных (строки, кардинальность) неизвестен.');
  }
  const usageRules = ['R001', 'R002', 'R003'];
  const usageSkipped = (ruleStats ?? []).filter((s) => usageRules.includes(s.id) && s.skipped);
  if (usageSkipped.length === usageRules.length) {
    notes.push('Сведения об использовании полей фронт-энда недоступны — пометки о лишних данных могут быть неполными.');
  }

  return {
    tables,
    links,
    meta: {
      notes,
      modelFromScript,
      associationsAvailable: assoc.size > 0,
      linkKinds: { '1:1': 'связь один к одному', 'm:n': 'многие ко многим', key: 'связь по ключу' },
    },
  };
}
