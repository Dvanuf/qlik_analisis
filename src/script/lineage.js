/**
 * Структура формирования приложения (data lineage в пределах одного
 * приложения, по мотивам NodeGraph): источники → таблицы → файлы/приложение.
 *
 * Строится поверх модели скрипта (parseScript): loads, residents, joins,
 * concatenates, stores, drops. Результат — послойный DAG:
 *   узлы: { id, kind: 'source'|'table', label, depth, line?, status }
 *   рёбра: { from, to, kind: 'source'|'resident'|'join'|'concatenate'|'store' }
 *   предупреждения: мёртвые таблицы (загружена и DROP), источники-сироты.
 *
 * Ограничение: lineage в пределах одного приложения. Межприложенческие
 * связи по QVD и field-level lineage — отдельные задачи.
 */

/** Тип источника по сырой строке FROM (п. 4.3 OutLine). */
export function sourceKind(source) {
  const s = String(source ?? '').replace(/[[\]"']/g, '').trim();
  if (!s) return 'inline';
  if (/^lib:\/\//i.test(s)) return 'lib';
  if (/(\.(qvd|csv|txt|xlsx|xls|tsv|parquet))(\s|\)|$)/i.test(s)) return 'file';
  if (/^(http|ftp|webfile):/i.test(s)) return 'web';
  if (/^(sql|odbc|oledb|custom|lib:\/\/[a-z_]*db)/i.test(s)) return 'sql';
  if (/^inline\b/i.test(s)) return 'inline';
  if (/^[a-z]:[\\/]/i.test(s) || s.startsWith('\\\\')) return 'file';
  if (/^rest/i.test(s)) return 'web';
  return 'other';
}

/** Короткая подпись типа источника для узла. */
export const SOURCE_KIND_LABELS = {
  lib: 'lib:// подключение',
  file: 'файл',
  sql: 'SQL-источник',
  inline: 'INLINE',
  web: 'web/URL',
  other: 'источник',
};

/** Ключ узла источника: нормализованная строка подключения. */
function sourceId(source) {
  const s = String(source ?? '').replace(/\s+/g, ' ').trim();
  return `src:${s.toLowerCase()}`;
}

/** Ключ узла таблицы. */
function tableId(name) {
  return `tbl:${String(name ?? '').toLowerCase()}`;
}

/** Читаемый ярлык источника: последний сегмент пути или строка до 48 символов. */
function sourceLabel(source) {
  const s = String(source ?? '').replace(/[[\]"']/g, '').replace(/\s+/g, ' ').trim();
  const tail = s.split(/[\\/]/).filter(Boolean).pop();
  if (tail && tail.length <= 48) return tail;
  return s.length > 48 ? `${s.slice(0, 45)}…` : (s || 'INLINE');
}

/**
 * Строит lineage-граф по модели скрипта.
 * @param {object} model — результат parseScript (loads, residents, joins,
 *   concatenates, stores, drops)
 * @returns {{ nodes: object[], edges: object[], warnings: string[] }}
 */
export function buildLineage(model) {
  const nodes = [];
  const nodeById = new Map();
  const edges = [];
  const warnings = [];
  const addNode = (node) => {
    if (nodeById.has(node.id)) return nodeById.get(node.id);
    nodes.push(node);
    nodeById.set(node.id, node);
    return node;
  };
  const addEdge = (from, to, kind) => {
    if (!from || !to || from === to) return;
    if (edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return;
    edges.push({ from, to, kind });
  };

  const loads = model?.loads ?? [];

  // Глубины таблиц: LOAD FROM источника — 0; RESIDENT от глубины d — d+1;
  // JOIN/CONCATENATE — max(depth источников)+1.
  const depthOf = new Map();

  // 1) LOAD с внешним источником.
  for (const load of loads) {
    const tid = tableId(load.table);
    const kind = sourceKind(load.source);
    if (kind === 'inline' && !load.source) {
      // Источник не распознан (RESIDENT-ветка уже в residents) — без узла.
      depthOf.set(tid, depthOf.get(tid) ?? 0);
      continue;
    }
    const sid = sourceId(load.source);
    addNode({
      id: sid, kind: 'source', sourceKind: kind,
      label: sourceLabel(load.source), depth: 0,
      detail: load.source,
    });
    addEdge(sid, tid, 'source');
    depthOf.set(tid, 0);
  }

  // 2) RESIDENT-цепочки: повторные проходы, пока появляются новые глубины.
  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;
    for (const r of model?.residents ?? []) {
      const fromId = tableId(r.table);
      const toId = tableId(r.target || r.table);
      const fromDepth = depthOf.get(fromId);
      if (fromDepth == null) continue;
      const curDepth = depthOf.get(toId);
      if (curDepth == null || curDepth < fromDepth + 1) {
        depthOf.set(toId, fromDepth + 1);
        changed = true;
      }
      addNode({
        id: toId, kind: 'table', label: r.target || r.table, depth: depthOf.get(toId),
        detail: `RESIDENT ${r.table}`, line: r.line,
      });
      addEdge(fromId, toId, 'resident');
    }
    if (!changed) break;
  }

  // 3) Все известные таблицы: LOAD + RESIDENT-источники/приёмники.
  const knownTables = new Set([...loads.map((l) => l.table)]);
  for (const r of model?.residents ?? []) {
    if (r.table) knownTables.add(r.table);
    if (r.target) knownTables.add(r.target);
  }

  // 4) JOIN: цель — таблица из «JOIN (T)»; источник — RESIDENT-таблица
  //    вложенного LOAD (орфаны без target связываем с ближайшим JOIN).
  const orphans = (model?.residents ?? []).filter((r) => !r.target);
  let orphanIdx = 0;
  for (const j of model?.joins ?? []) {
    const target = j.table ? tableId(j.table) : null;
    if (!target) continue;
    addNode({
      id: target, kind: 'table', label: j.table, depth: depthOf.get(target) ?? 0,
      detail: `${j.joinType} JOIN`, line: j.line,
    });
    if (j.source && sourceKind(j.source) !== 'inline') {
      const sid = sourceId(j.source);
      addNode({ id: sid, kind: 'source', sourceKind: sourceKind(j.source), label: sourceLabel(j.source), depth: 0, detail: j.source });
      addEdge(sid, target, 'source');
    }
    const r = orphans[orphanIdx];
    orphanIdx += 1;
    if (r && r.table) addEdge(tableId(r.table), target, 'join');
  }

  // 5) CONCATENATE: приёмник + таблица-источник склейки.
  for (const c of model?.concatenates ?? []) {
    if (!c.target) continue;
    const to = tableId(c.target);
    addNode({
      id: to, kind: 'table', label: c.target, depth: depthOf.get(to) ?? 0,
      detail: c.hasNoConcatenate ? 'NoConcatenate' : 'CONCATENATE',
    });
    if (c.hasNoConcatenate) continue;
    // Источник склейки — таблица LOAD, идущая следом (связь по порядку строк
    // недоступна в lineage; показываем связь с ближайшей по имени таблицей).
    const sameName = loads.find((l) => l.table === c.target);
    if (sameName) addEdge(tableId(sameName.table), to, 'concatenate');
  }

  // 6) Узлы всех известных таблиц + статусы dropped/stored (п. 4.2 NodeGraph).
  for (const name of knownTables) {
    const tid = tableId(name);
    const dropped = (model?.drops ?? []).some((d) => d.kind === 'table'
      && d.targets.some((t) => String(t).toLowerCase() === String(name).toLowerCase()));
    const stored = (model?.stores ?? []).some((st) => String(st.table).toLowerCase() === String(name).toLowerCase());
    const existing = nodeById.get(tid);
    if (existing) {
      if (dropped) existing.status = 'dropped';
      existing.stored = stored;
      continue;
    }
    addNode({
      id: tid, kind: 'table', label: name, depth: depthOf.get(tid) ?? 0,
      status: dropped ? 'dropped' : undefined, stored,
    });
  }
  // STORE: ребро таблица → узел файла.
  for (const st of model?.stores ?? []) {
    if (!st.table) continue;
    const fid = sourceId(`store:${st.table}`);
    addNode({ id: fid, kind: 'source', sourceKind: 'file', label: `STORE → ${st.table}`, depth: null, detail: st.raw });
    addEdge(tableId(st.table), fid, 'store');
  }

  // Предупреждения: мёртвые таблицы и источники-сироты (п. 4.4 NodeGraph).
  const targetsOf = new Set(edges.filter((e) => e.kind !== 'store').map((e) => e.to));
  for (const n of nodes) {
    if (n.kind !== 'table') continue;
    if (n.status === 'dropped') {
      warnings.push(`Таблица «${n.label}» загружена и удалена (DROP) — её данные не попадают в приложение`);
    } else if (!targetsOf.has(n.id) && !(model?.stores ?? []).some((st) => String(st.table).toLowerCase() === n.label.toLowerCase())) {
      warnings.push(`Таблица «${n.label}» никуда далее не используется (конечная таблица приложения)`);
    }
  }

  // Пересчитать depth у узлов-таблиц из depthOf (после всех проходов).
  for (const n of nodes) {
    if (n.kind === 'table' && n.depth == null) n.depth = depthOf.get(n.id) ?? 0;
  }

  return { nodes, edges, warnings };
}
