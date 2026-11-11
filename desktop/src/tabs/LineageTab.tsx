/**
 * Вкладка «Формирование» — lineage-визуализация структуры приложения
 * (по мотивам NodeGraph): источники → таблицы → файлы/приложение.
 *
 * Послойный DAG: колонки — уровень построения (depth), узлы — карточки,
 * рёбра — кривые Безье. Клик по узлу — детали (тип, строка, поля, статус).
 * Кнопка «Документ» — текстовый отчёт по разделам и шагам outline
 * (аналог «App Documentation» NodeGraph).
 */
import { useMemo, useState } from 'react';
import type { AnalysisResult, LineageNode } from '../types.js';
import { SOURCE_KIND_LABELS } from '../../../src/script/lineage.js';

type Props = {
  analysis: AnalysisResult | null;
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

export default function LineageTab({ analysis }: { analysis: Props['analysis'] }) {
  const [selected, setSelected] = useState<LineageNode | null>(null);
  const [docOpen, setDocOpen] = useState(false);

  const lineage = analysis?.lineage ?? null;
  const outline = analysis?.outline?.full ?? null;

  /** Раскладка: колонки по depth, узлы внутри колонки по порядку. */
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

  if (!analysis || !lineage || !layout) {
    return (
      <section className="card wide">
        <h2>Формирование</h2>
        <p className="muted">
          Структура формирования приложения появится после анализа: источники,
          таблицы, цепочки RESIDENT/JOIN/CONCATENATE, STORE и DROP — как
          lineage-граф в NodeGraph.
        </p>
      </section>
    );
  }

  const { nodePos, W, H } = layout;
  const pos = (id: string) => nodePos.get(id) ?? { x: 0, y: 0 };
  const node = (id: string) => lineage.nodes.find((n) => n.id === id);

  return (
    <section>
      <div className="card row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Формирование приложения</h3>
        <span className="grow" />
        <span className="hint">{lineage.nodes.length} узлов · {lineage.edges.length} связей</span>
        <button className="small" onClick={() => setDocOpen((v) => !v)} aria-expanded={docOpen}>
          Документ
        </button>
      </div>

      {/* Предупреждения: мёртвые таблицы, источники-сироты */}
      {lineage.warnings.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          {lineage.warnings.map((w, i) => (
            <div key={i} className="hint" style={{ color: 'var(--warn, #e0a33e)' }}>⚠ {w}</div>
          ))}
        </div>
      )}

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

          {/* Рёбра: от правого края узла-источника к левому краю приёмника */}
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

          {/* Узлы */}
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

      {/* Документ: разделы и шаги (аналог App Documentation) */}
      {docOpen && outline && (
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
