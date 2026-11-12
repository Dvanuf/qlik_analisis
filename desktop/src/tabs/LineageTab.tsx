/**
 * Вкладка «Формирование» — две вьюхи структуры приложения.
 *
 * «Граф формирования» — lineage по мотивам NodeGraph: послойный DAG,
 * колонки — уровень построения (depth), рёбра — кривые Безье, клик по узлу —
 * детали. Кнопка «Документ» — текстовый отчёт по разделам и шагам outline.
 *
 * «Модель данных» — схема «снежинка» (как в просмотрщике модели Qlik):
 * таблицы-боксы с полями, связи по общим полям (1:1 / M:N / ключ).
 * Проблемы из находок видны прямо на схеме: рамка таблицы и точки у полей
 * красятся по максимальной важности, клик — детали с переходом в «Анализ».
 * Карточка «Качество модели» — балл домена, находки и худшие таблицы.
 */
import { useMemo, useState } from 'react';
import type { AnalysisResult, LineageNode, SchemaProblems, SchemaTable } from '../types.js';
import { SOURCE_KIND_LABELS } from '../../../src/script/lineage.js';
import { canonicalFieldName } from '../../../src/normalize.js';
import { parseIncludeLines } from '../../../src/extract/includes.js';

type Props = {
  analysis: AnalysisResult | null;
  /** Со схемы: открыть «Анализ» с поиском по таблице/полю. */
  onOpenAnalysis?: (name: string) => void;
};

/** Цвет узла/ребра по типу — токены темы. */
function nodeClass(n: LineageNode): string {
  if (n.kind === 'source') return 'ln-src';
  if (n.status === 'dropped') return 'ln-dropped';
  if (n.stored) return 'ln-stored';
  return 'ln-table';
}

const EDGE_LABELS: Record<string, string> = {
  source: 'источник → таблица',
  resident: 'RESIDENT',
  join: 'JOIN',
  concatenate: 'CONCATENATE',
  store: 'STORE → файл',
};

const SEV_RANK: Record<string, number> = { error: 3, warning: 2, info: 1 };

/** Максимальная важность проблем — по ней красится рамка таблицы/поле. */
function maxSev(p: SchemaProblems | null): 'error' | 'warning' | 'info' | null {
  if (!p) return null;
  if (p.error > 0) return 'error';
  if (p.warning > 0) return 'warning';
  if (p.info > 0) return 'info';
  return null;
}

const SEV_RU: Record<string, string> = { error: 'Ошибка', warning: 'Предупреждение', info: 'Замечание' };

/** Обрезка текста в SVG-узле. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const fmtRows = (rows: number | null) => (rows == null ? '—' : rows.toLocaleString('ru-RU'));

export default function LineageTab({ analysis, onOpenAnalysis }: Props) {
  const [selected, setSelected] = useState<LineageNode | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [viewPref, setView] = useState<'lineage' | 'schema'>('lineage');
  const [selTable, setSelTable] = useState<SchemaTable | null>(null);
  const [selField, setSelField] = useState<{ table: SchemaTable; field: SchemaTable['fields'][number] } | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);

  const lineage = analysis?.lineage ?? null;
  const schema = analysis?.schema ?? null;
  const outline = analysis?.outline?.full ?? null;
  // Если lineage нет (старый прогон), но схема есть — показываем сразу схему.
  const view = lineage ? viewPref : 'schema';
  // Нераскрытые включения: скрипт-заглушка не был дополнен файлами.
  const unresolved = parseIncludeLines(analysis?.script ?? '');

  /** Раскладка lineage: колонки по depth, узлы внутри колонки по имени. */
  const layout = useMemo(() => {
    if (!lineage) return null;
    const depths = [...new Set(lineage.nodes.map((n) => n.depth ?? 0))].sort((a, b) => a - b);
    const colIndex = new Map(depths.map((d, i) => [d, i]));
    const cols: LineageNode[][] = depths.map(() => []);
    for (const n of [...lineage.nodes].sort((a, b) => a.label.localeCompare(b.label))) {
      cols[colIndex.get(n.depth ?? 0) ?? 0].push(n);
    }
    const nodePos = new Map<string, { x: number; y: number }>();
    const W = 190, H = 46, GX = 90, GY = 16;
    cols.forEach((col, ci) => {
      col.forEach((n, ri) => {
        nodePos.set(n.id, { x: ci * (W + GX), y: ri * (H + GY) });
      });
    });
    const height = Math.max(...cols.map((c) => c.length), 1) * (H + GY);
    const width = cols.length * (W + GX);
    return { cols, nodePos, W, H, width, height };
  }, [lineage]);

  /** Раскладка схемы: BFS-уровни связей от таблицы с максимумом связей —
   *  корень в первой колонке, звезда/снежинка читается слева направо. */
  const schemaLayout = useMemo(() => {
    if (!schema || !schema.tables.length) return null;
    const W = 230, GX = 84, GY = 26, HDR = 34, ROW = 17, SHOW = 15;
    const heightOf = (t: SchemaTable) => {
      const shown = Math.min(t.fields.length, SHOW);
      const more = t.fields.length > SHOW ? ROW : 0;
      return HDR + shown * ROW + more + 8;
    };
    const canon = (name: string) => canonicalFieldName(name);
    // Соседство по связям.
    const adj = new Map<string, Set<string>>();
    const deg = new Map<string, number>();
    const bump = (c: string, nb: string) => {
      if (!adj.has(c)) adj.set(c, new Set());
      adj.get(c)!.add(nb);
    };
    for (const l of schema.links) {
      bump(l.from, l.to);
      bump(l.to, l.from);
      deg.set(l.from, (deg.get(l.from) ?? 0) + 1);
      deg.set(l.to, (deg.get(l.to) ?? 0) + 1);
    }
    // Корень: максимум связей, при равенстве — первое имя.
    const tables = [...schema.tables].sort((a, b) => a.name.localeCompare(b.name));
    let root = tables[0];
    for (const t of tables) {
      const d = (deg.get(canon(t.name)) ?? 0) - (deg.get(canon(root.name)) ?? 0);
      if (d > 0) root = t;
    }
    // BFS-уровни от корня.
    const level = new Map<string, number>([[canon(root.name), 0]]);
    let frontier = [canon(root.name)];
    while (frontier.length) {
      const next: string[] = [];
      for (const c of frontier) {
        for (const nb of adj.get(c) ?? []) {
          if (!level.has(nb)) {
            level.set(nb, (level.get(c) ?? 0) + 1);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    // Колонки: таблицы без связей — в последнюю колонку справа.
    const maxLevel = Math.max(0, ...level.values());
    const cols: SchemaTable[][] = Array.from({ length: maxLevel + 1 }, () => []);
    const orphans: SchemaTable[] = [];
    for (const t of tables) {
      const lv = level.get(canon(t.name));
      if (lv == null) orphans.push(t);
      else cols[lv].push(t);
    }
    if (orphans.length) cols.push(orphans);
    // Позиции: внутри колонки — накопительно по высоте боксов.
    const pos = new Map<string, { x: number; y: number; h: number }>();
    cols.forEach((col, ci) => {
      let y = 0;
      for (const t of col) {
        const h = heightOf(t);
        pos.set(canon(t.name), { x: ci * (W + GX), y, h });
        y += h + GY;
      }
    });
    const colHeights = cols.map((col) => col.reduce((s, t) => s + heightOf(t) + GY, 0));
    const width = cols.length * (W + GX);
    const height = Math.max(...colHeights, HDR);
    // Y строки поля в боксе (null — поле скрыто лимитом показа).
    const fieldY = (tc: string, fieldName: string): number | null => {
      const t = schema.tables.find((x) => canon(x.name) === tc);
      const p = pos.get(tc);
      if (!t || !p) return null;
      const idx = t.fields.findIndex((f) => canonicalFieldName(f.name) === canonicalFieldName(fieldName));
      if (idx < 0 || idx >= SHOW) return null;
      return p.y + HDR + idx * ROW + ROW - 5;
    };
    return { cols: tables, colBoxes: cols, pos, W, GX, HDR, ROW, SHOW, width, height, fieldY, canon };
  }, [schema]);

  if (!analysis || (!lineage && !schema)) {
    return (
      <section className="card wide">
        <h2>Формирование</h2>
        <p className="muted">
          Структура формирования приложения появится после анализа: источники,
          таблицы, цепочки RESIDENT/JOIN/CONCATENATE, STORE и DROP — как
          lineage-граф в NodeGraph, плюс схема модели данных с пометками проблем.
        </p>
      </section>
    );
  }

  const modelDom = analysis.summary?.domains?.model ?? null;
  const zonePill = (score?: number) => (score == null ? 'mute' : score >= 75 ? 'ok' : score >= 50 ? 'warning' : 'error');

  // Худшие таблицы для «Качества модели»: по максимальной важности, затем
  // по числу находок.
  const worstTables = (schema?.tables ?? [])
    .filter((t) => t.problems)
    .map((t) => ({ t, sev: maxSev(t.problems) ?? 'info' }))
    .sort((a, b) => (
      (SEV_RANK[b.sev] ?? 0) - (SEV_RANK[a.sev] ?? 0)
      || b.t.problems!.total - a.t.problems!.total
      || a.t.name.localeCompare(b.t.name)
    ));
  const modelFindings = (analysis.findings ?? []).filter((f) => f.domain === 'model');
  const modelBySev = { error: 0, warning: 0, info: 0 };
  let modelPlaces = 0;
  for (const f of modelFindings) {
    const sevKey = f.severity as keyof typeof modelBySev;
    if (modelBySev[sevKey] != null) modelBySev[sevKey] += 1;
    modelPlaces += f.count ?? 1;
  }

  /* --------------------- Вьюха «Граф формирования» --------------------- */
  const lineageView = () => {
    if (!lineage || !layout) {
      return (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="muted">Граф формирования появится после повторного анализа.</p>
        </div>
      );
    }
    const { nodePos, W, H } = layout;
    const pos = (id: string) => nodePos.get(id) ?? { x: 0, y: 0 };
    return (
      <>
        {/* Легенда */}
        <div className="card row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
          <span className="legend-item"><i className="ln-src" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> источник</span>
          <span className="legend-item"><i className="ln-table" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> таблица</span>
          <span className="legend-item"><i className="ln-stored" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> STORE (выгружена)</span>
          <span className="legend-item"><i className="ln-dropped" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> DROP (удалена)</span>
          <span className="grow" />
          {Object.entries(EDGE_LABELS).slice(1).map(([k, label]) => (
            <span className="hint" key={k}>{label}</span>
          ))}
        </div>

        {/* Граф: послойный DAG */}
        <div className="card scrolltbl">
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={{ display: 'block', minWidth: '100%' }}
            role="img"
            aria-label="Граф формирования приложения"
          >
            <defs>
              <marker id="ln-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" />
              </marker>
            </defs>

            {lineage.edges.map((e, i) => {
              const a = pos(e.from);
              const b = pos(e.to);
              if (!a || !b) return null;
              const x1 = a.x + W, y1 = a.y + H / 2;
              const x2 = b.x, y2 = b.y + H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 3} ${y2}`}
                  fill="none"
                  stroke="var(--muted)"
                  strokeWidth={1.4}
                  markerEnd="url(#ln-arrow)"
                  opacity={0.65}
                />
              );
            })}

            {layout.cols.flat().map((n: LineageNode) => {
              const p = pos(n.id);
              const cls = nodeClass(n);
              const label = n.label.length > 24 ? `${n.label.slice(0, 22)}…` : n.label;
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x}, ${p.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(n)}
                >
                  <rect
                    width={W} height={H} rx={8}
                    className={`ln-node ${cls}${selected?.id === n.id ? ' ln-sel' : ''}`}
                  />
                  <text x={W / 2} y={19} textAnchor="middle" className="ln-label">{label}</text>
                  <text x={W / 2} y={35} textAnchor="middle" className="ln-sub">
                    {n.kind === 'source'
                      ? (SOURCE_KIND_LABELS[n.sourceKind ?? 'other'] ?? 'источник')
                      : `${n.depth ?? 0} уровень${n.stored ? ' · STORE' : ''}${n.status === 'dropped' ? ' · DROP' : ''}`}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Детали выбранного узла */}
        {selected && (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>
              {selected.kind === 'source' ? 'Источник' : 'Таблица'}: {selected.label}
              {selected.status === 'dropped' && <span className="pill error" style={{ marginLeft: 8 }}>DROP</span>}
              {selected.stored && <span className="pill ok" style={{ marginLeft: 8 }}>STORE</span>}
              <span className="grow" />
              <button className="small" onClick={() => setSelected(null)}>Закрыть</button>
            </h3>
            <p className="muted small">
              {selected.detail || '—'}
              {selected.line != null ? ` · строка ${selected.line}` : ''}
              {' · '}уровень {selected.depth ?? 0}
            </p>
            {/* Поля таблицы: из dataModel-листа «Поля» или master? — из lineage нет,
                показываем через dataModel при наличии. */}
            {analysis?.dataModel && (() => {
              const sheet = analysis.dataModel.find((sh) => sh.name === 'Поля');
              if (!sheet) return null;
              const rows = sheet.rows.filter((r) =>
                String(r[0]).toLowerCase() === selected.label.toLowerCase());
              if (!rows.length) return null;
              return (
                <>
                  <div className="hint" style={{ margin: '8px 0 4px' }}>Поля таблицы ({rows.length})</div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {rows.slice(0, 40).map((r, i) => (
                      <span key={i} className="pill mute">{String(r[1])}</span>
                    ))}
                    {rows.length > 40 && <span className="hint">и ещё {rows.length - 40}</span>}
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </>
    );
  };

  /* ---------------------- Вьюха «Модель данных» ------------------------ */
  const schemaView = () => {
    if (!schema || !schemaLayout) {
      return (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="muted">Схема модели данных появится после повторного анализа.</p>
        </div>
      );
    }
    const { pos, W, HDR, ROW, SHOW, width, height, fieldY, canon } = schemaLayout;
    const boxPos = (tc: string) => pos.get(tc) ?? null;
    return (
      <>
        {/* Легенда схемы */}
        <div className="card row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
          <span className="legend-item"><i className="ms-sev-err" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> ошибки</span>
          <span className="legend-item"><i className="ms-sev-warn" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> предупреждения</span>
          <span className="legend-item"><i className="ms-sev-info" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> замечания</span>
          <span className="legend-item"><i className="ms-sev-ok" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3 }} /> чистая таблица</span>
          <span className="legend-item"><b style={{ color: 'var(--brand)' }}>●</b>&nbsp;ключевое поле</span>
          <span className="legend-item"><u style={{ textDecorationColor: 'var(--warning)' }}>поле</u>&nbsp;— неполный ключ</span>
          <span className="grow" />
          <span className="hint">связь: 1:1 · ключ · M:N — пунктир</span>
        </div>

        {/* Схема «снежинка» */}
        <div className="card scrolltbl">
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ display: 'block', minWidth: '100%' }}
            role="img"
            aria-label="Схема модели данных"
            className="ms-schema"
          >
            <defs>
              <marker id="ms-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" />
              </marker>
            </defs>

            {/* Рёбра: от строки поля в таблице-источнике к строке поля в приёмнике */}
            {schema.links.map((l, i) => {
              const a = boxPos(l.from);
              const b = boxPos(l.to);
              if (!a || !b) return null;
              const fy1 = fieldY(l.from, l.field);
              const fy2 = fieldY(l.to, l.field);
              const x1 = a.x + W, y1 = fy1 ?? a.y + a.h / 2;
              const x2 = b.x, y2 = fy2 ?? b.y + b.h / 2;
              const mx = (x1 + x2) / 2;
              const cls = l.kind === 'm:n' ? 'ms-link ms-link-mn' : l.kind === '1:1' ? 'ms-link ms-link-11' : 'ms-link';
              const label = l.kind === 'key' ? cut(l.field, 18) : `${cut(l.field, 14)} · ${l.kind === '1:1' ? '1:1' : 'M:N'}`;
              return (
                <g key={`${l.from}|${l.to}|${l.field}`}>
                  <path
                    d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 3} ${y2}`}
                    className={cls}
                    markerEnd="url(#ms-arrow)"
                  />
                  <text x={mx} y={(y1 + y2) / 2 - 3} textAnchor="middle" className="ms-linklabel">{label}</text>
                </g>
              );
            })}

            {/* Таблицы-боксы */}
            {schema.tables.map((t) => {
              const tc = canon(t.name);
              const p = boxPos(tc);
              if (!p) return null;
              const sev = maxSev(t.problems);
              const zoneCls = sev === 'error' ? 'ms-err' : sev === 'warning' ? 'ms-warn' : sev === 'info' ? 'ms-info' : 'ms-ok';
              const isSel = selTable && canon(selTable.name) === tc;
              const shown = t.fields.slice(0, SHOW);
              return (
                <g key={tc} transform={`translate(${p.x}, ${p.y})`}>
                  <rect
                    width={W} height={p.h} rx={8}
                    className={`ms-node ${zoneCls}${isSel ? ' ms-sel' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => { setSelTable(t); setSelField(null); }}
                  >
                    <title>{t.name} · {fmtRows(t.rows)} строк{t.synthetic ? ' · синтетический ключ' : ''}</title>
                  </rect>
                  <text x={10} y={20} className="ms-title" style={{ cursor: 'pointer' }}
                    onClick={() => { setSelTable(t); setSelField(null); }}>{cut(t.name, 22)}</text>
                  <text x={W - 8} y={20} textAnchor="end" className="ms-sub">{fmtRows(t.rows)} стр</text>
                  <text x={10} y={30} className="ms-sub">
                    {t.problems && ([
                      ['ms-sev-err', t.problems.error, 'ошибки'],
                      ['ms-sev-warn', t.problems.warning, 'пред.'],
                      ['ms-sev-info', t.problems.info, 'зам.'],
                    ] as const).filter(([, n]) => (n as number) > 0).map(([cls, n]) => (
                      <tspan key={cls} className={cls}>{`${n} ${(n as number) === 1 ? (cls === 'ms-sev-err' ? 'ошибка' : cls === 'ms-sev-warn' ? 'пред.' : 'зам.') : (cls === 'ms-sev-err' ? 'ошибок' : cls === 'ms-sev-warn' ? 'пред.' : 'зам.')}  `}</tspan>
                    ))}
                    {t.synthetic && <tspan className="ms-sub"> · синт. ключ</tspan>}
                    {t.sourceKind && <tspan className="ms-sub"> · {SOURCE_KIND_LABELS[t.sourceKind] ?? ''}</tspan>}
                  </text>
                  {shown.map((f, fi) => {
                    const fy = HDR + fi * ROW + ROW - 5;
                    const fsev = maxSev(f.problems);
                    return (
                      <text
                        key={fi}
                        x={fsev || f.key ? 26 : 12}
                        y={fy}
                        className={`ms-field${f.key ? ' ms-fkey' : ''}${f.incompleteKey ? ' ms-finc' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); setSelTable(t); setSelField({ table: t, field: f }); }}
                      >
                        <title>{f.name}{f.key ? ' · ключ' : ''}{f.incompleteKey ? ' · неполный ключ' : ''}</title>
                        {fsev && <tspan className={`ms-sev-${fsev === 'error' ? 'err' : fsev === 'warning' ? 'warn' : 'info'}`}>● </tspan>}
                        {f.key && <tspan className="ms-keymark">● </tspan>}
                        {cut(f.name, fsev || f.key ? 22 : 26)}
                      </text>
                    );
                  })}
                  {t.fields.length > SHOW && (
                    <text x={12} y={HDR + SHOW * ROW + ROW - 5} className="ms-more">+{t.fields.length - SHOW} ещё…</text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Детали таблицы */}
        {selTable && !selField && (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>
              Таблица: {selTable.name}
              {selTable.synthetic && <span className="pill warning" style={{ marginLeft: 8 }}>синтетический ключ</span>}
              {selTable.problems && <span className={`pill ${maxSev(selTable.problems) === 'error' ? 'error' : maxSev(selTable.problems) === 'warning' ? 'warning' : 'mute'}`} style={{ marginLeft: 8 }}>находок: {selTable.problems.total}</span>}
              <span className="grow" />
              {onOpenAnalysis && (
                <button className="small" onClick={() => onOpenAnalysis(selTable.name)}>Показать в Анализе</button>
              )}
              <button className="small" style={{ marginLeft: 6 }} onClick={() => setSelTable(null)}>Закрыть</button>
            </h3>
            <p className="muted small">
              {fmtRows(selTable.rows)} строк · полей: {selTable.fields.length}
              {selTable.sourceKind ? ` · источник: ${SOURCE_KIND_LABELS[selTable.sourceKind] ?? selTable.sourceKind}` : ''}
              {selTable.keyFields.length ? ` · ключи: ${selTable.keyFields.join(', ')}` : ''}
            </p>
            {selTable.problems && (
              <>
                <div className="hint" style={{ margin: '8px 0 4px' }}>Находки по таблице</div>
                {selTable.problems.rules.map((r) => (
                  <div key={r.id} className="row small" style={{ gap: 8, marginBottom: 2 }}>
                    <span className={`pill ${r.severity === 'error' ? 'error' : r.severity === 'warning' ? 'warning' : 'mute'}`}>{SEV_RU[r.severity] ?? r.severity}</span>
                    <span>{r.title}</span>
                    <span className="muted">{r.id} · мест: {r.count}</span>
                  </div>
                ))}
                {selTable.fields.some((f) => f.problems) && (
                  <>
                    <div className="hint" style={{ margin: '10px 0 4px' }}>Проблемные поля (клик — детали)</div>
                    {selTable.fields.filter((f) => f.problems).map((f) => {
                      const s = maxSev(f.problems) ?? 'info';
                      return (
                        <div key={f.name} className="row small" style={{ gap: 8, marginBottom: 2, cursor: 'pointer' }}
                          onClick={() => setSelField({ table: selTable, field: f })}>
                          <span className={`pill ${s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'mute'}`}>{SEV_RU[s]}</span>
                          <span>{f.name}</span>
                          <span className="muted">{f.key ? 'ключ · ' : ''}{f.incompleteKey ? 'неполный · ' : ''}находок: {f.problems!.total}</span>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}
            {!selTable.problems && (
              <p className="small" style={{ color: 'var(--success)' }}>Проблем не найдено — таблица чистая.</p>
            )}
          </div>
        )}

        {/* Детали поля */}
        {selField && (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>
              Поле: {selField.field.name}
              <span className="muted small" style={{ marginLeft: 8 }}>таблица {selField.table.name}</span>
              {selField.field.key && <span className="pill ok" style={{ marginLeft: 8 }}>ключ</span>}
              {selField.field.incompleteKey && <span className="pill warning" style={{ marginLeft: 8 }}>неполный ключ</span>}
              <span className="grow" />
              {onOpenAnalysis && (
                <button className="small" onClick={() => onOpenAnalysis(selField.field.name)}>Показать в Анализе</button>
              )}
              <button className="small" style={{ marginLeft: 6 }} onClick={() => setSelField(null)}>Закрыть</button>
            </h3>
            {selField.field.problems ? (
              selField.field.problems.rules.map((r) => (
                <div key={r.id} className="row small" style={{ gap: 8, marginBottom: 2 }}>
                  <span className={`pill ${r.severity === 'error' ? 'error' : r.severity === 'warning' ? 'warning' : 'mute'}`}>{SEV_RU[r.severity] ?? r.severity}</span>
                  <span>{r.title}</span>
                  <span className="muted">{r.id} · мест: {r.count}</span>
                </div>
              ))
            ) : (
              <p className="small" style={{ color: 'var(--success)' }}>Проблем не найдено.</p>
            )}
          </div>
        )}
      </>
    );
  };

  return (
    <section>
      <div className="card row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Формирование приложения</h3>
        <span className="grow" />
        <span className="hint">
          {view === 'lineage'
            ? `${lineage?.nodes.length ?? 0} узлов · ${lineage?.edges.length ?? 0} связей`
            : `${schema?.tables.length ?? 0} таблиц · ${schema?.links.length ?? 0} связей`}
        </span>
        {/* Переключатель вьюх: lineage-граф или схема модели данных */}
        <span className="viewswitch">
          <button
            className={`small${view === 'lineage' ? ' is-active' : ''}`}
            onClick={() => setView('lineage')}
            disabled={!lineage}
            aria-pressed={view === 'lineage'}
          >
            Граф формирования
          </button>
          <button
            className={`small${view === 'schema' ? ' is-active' : ''}`}
            onClick={() => setView('schema')}
            aria-pressed={view === 'schema'}
          >
            Модель данных
          </button>
        </span>
        {view === 'lineage' && (
          <button className="small" onClick={() => setDocOpen((v) => !v)} aria-expanded={docOpen}>
            Документ
          </button>
        )}
        {view === 'schema' && (
          <button className="small" onClick={() => setQualityOpen((v) => !v)} aria-expanded={qualityOpen}>
            Качество модели
          </button>
        )}
      </div>

      {/* Скрипт-заглушка: включения не раскрылись — самый частый вопрос */}
      {unresolved.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b>Скрипт — заглушка: включения не раскрыты</b>
          <p className="hint" style={{ margin: '4px 0 6px' }}>
            В скрипте есть нераскрытые включения — их содержимое не попало в
            анализ, поэтому граф показывает только каркас. Укажите папку
            репозитория во вкладке «Скрипт загрузки» и переанализируйте.
          </p>
          {unresolved.map((inc, i) => (
            <div key={i} className="hint" style={{ color: 'var(--warn, #e0a33e)' }}>
              ⚠ не раскрыто: {inc.path} (строка {inc.line})
            </div>
          ))}
          {(analysis?.includeNotes ?? []).map((n, i) => (
            <div key={`n${i}`} className="hint" style={{ color: 'var(--warn, #e0a33e)' }}>{n}</div>
          ))}
        </div>
      )}

      {/* Предупреждения: мёртвые таблицы, источники-сироты */}
      {view === 'lineage' && (lineage?.warnings.length ?? 0) > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          {lineage!.warnings.map((w, i) => (
            <div key={i} className="hint" style={{ color: 'var(--warn, #e0a33e)' }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {view === 'lineage' ? lineageView() : schemaView()}

      {/* Карточка «Качество модели»: балл домена, находки, худшие таблицы */}
      {view === 'schema' && qualityOpen && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>
            Качество модели данных
            <span className="grow" />
            <button className="small" onClick={() => setQualityOpen(false)}>Скрыть</button>
          </h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`pill ${zonePill(modelDom?.score)}`}>
              {modelDom ? `домен «Модель данных»: ${modelDom.score} · ${modelDom.verdict}` : 'домен не оценён'}
            </span>
            {modelBySev.error > 0 && <span className="pill error">ошибки: {modelBySev.error}</span>}
            {modelBySev.warning > 0 && <span className="pill warning">предупреждения: {modelBySev.warning}</span>}
            {modelBySev.info > 0 && <span className="pill mute">замечания: {modelBySev.info}</span>}
            <span className="hint">{modelFindings.length} находок · {modelPlaces} мест</span>
          </div>
          {(schema?.meta.notes ?? []).map((n, i) => (
            <div key={i} className="hint" style={{ color: 'var(--warn, #e0a33e)', marginTop: 4 }}>⚠ {n}</div>
          ))}
          {worstTables.length > 0 && (
            <>
              <div className="hint" style={{ margin: '10px 0 4px' }}>Таблицы с находками — худшие сверху (клик — на схеме)</div>
              {worstTables.map(({ t, sev }) => (
                <div key={t.name} className="row small" style={{ gap: 8, marginBottom: 2, cursor: 'pointer' }}
                  onClick={() => { setSelTable(t); setSelField(null); }}>
                  <span className={`pill ${sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'mute'}`}>{SEV_RU[sev]}</span>
                  <span>{t.name}</span>
                  <span className="muted">находок: {t.problems!.total} · {t.problems!.rules[0]?.title ?? ''}</span>
                </div>
              ))}
            </>
          )}
          {worstTables.length === 0 && (
            <p className="small" style={{ color: 'var(--success)', marginTop: 8 }}>
              Находок по модели данных нет — все таблицы чистые.
            </p>
          )}
        </div>
      )}

      {/* Документ: разделы и шаги (аналог App Documentation) */}
      {view === 'lineage' && docOpen && outline && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Документ по приложению</h3>
          {(outline.sections ?? []).map((sec) => (
            <div key={sec.name ?? sec.line} style={{ marginBottom: 10 }}>
              <b>{sec.name || '(без раздела)'}</b>
              <div className="muted small">строки {sec.line}–{sec.line + 20} · таблиц: {(sec.tables ?? []).length}</div>
            </div>
          ))}
          <div className="hint" style={{ marginTop: 6 }}>Шаги построения:</div>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {(outline.steps ?? []).slice(0, 60).map((st, i) => (
              <li key={i} className="small">{st.text} <span className="muted">· строка {st.line}</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
