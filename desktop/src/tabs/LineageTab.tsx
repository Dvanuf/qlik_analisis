/**
 * Вкладка «Формирование» — модель данных приложения в трёх состояниях
 * (утверждённый макет 0.29.0, упрощён по замечаниям 0.29.1: lineage-граф
 * и «Документ» убраны — вкладка показывает только модель).
 *
 * Карточка «Качество модели» — наверху: балл домена, счётчики, худшие
 * таблицы. Если проверки использования полей (R001/R002/R003) пропущены —
 * карточка честно говорит «Оценка неполная» и перечисляет пропуски:
 * «чистые таблицы» в этом случае не звучит как «отлично».
 *
 * Три сворачиваемые секции: «как сформировано» (с дропнутыми и
 * промежуточными), «текущая финальная», «рекомендованная — после правок».
 * Проблемы — бейджами по типам, чипы-фильтры подсвечивают проблемное.
 */
import { useMemo, useState } from 'react';
import type { AnalysisResult, SchemaProblems, SchemaTable } from '../types.js';
import { SOURCE_KIND_LABELS } from '../../../src/script/lineage.js';
import { canonicalFieldName } from '../../../src/normalize.js';

type Props = {
  analysis: AnalysisResult | null;
  /** Со схемы: открыть «Анализ» с поиском по таблице/полю. */
  onOpenAnalysis?: (name: string) => void;
};

const SEV_RANK: Record<string, number> = { error: 3, warning: 2, info: 1 };
const SEV_RU: Record<string, string> = { error: 'Ошибка', warning: 'Предупреждение', info: 'Замечание' };
const CHAIN_LABELS: Record<string, string> = { resident: 'RESIDENT', join: 'JOIN', concatenate: 'CONCATENATE' };

/** Обрезка текста в SVG-узле. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtRows = (rows: number | null) => (rows == null ? '—' : rows.toLocaleString('ru-RU'));

/** Максимальная важность проблем — по ней красится рамка таблицы/поле. */
function maxSev(p: SchemaProblems | null): 'error' | 'warning' | 'info' | null {
  if (!p) return null;
  if (p.error > 0) return 'error';
  if (p.warning > 0) return 'warning';
  if (p.info > 0) return 'info';
  return null;
}

type StateKey = 'asBuilt' | 'final' | 'afterFix';
const MODEL_STATES: { key: StateKey; title: string }[] = [
  { key: 'asBuilt', title: '1. С учётом дропнутых — как сформировано' },
  { key: 'final', title: '2. Без дропнутых — текущая (финальная) модель' },
  { key: 'afterFix', title: '3. Рекомендованная — после правок' },
];

type FilterKey = 'all' | 'problems' | 'synthetic' | 'unused' | 'mn' | 'incomplete';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'problems', label: 'Только проблемное' },
  { key: 'synthetic', label: 'Синт.ключи' },
  { key: 'unused', label: 'Неисп.поля' },
  { key: 'mn', label: 'M:N' },
  { key: 'incomplete', label: 'Неполные ключи' },
];

/** Таблица проходит фильтр? (для подсветки: не прошедшие гаснут) */
function matchesFilter(t: SchemaTable, f: FilterKey): boolean {
  if (f === 'all') return true;
  const p = t.problemsByType;
  if (f === 'problems') return (t.problems?.total ?? 0) > 0;
  if (f === 'synthetic') return p.synthetic > 0;
  if (f === 'unused') return p.unusedFields > 0 || p.unusedTable > 0;
  if (f === 'mn') return p.mn > 0;
  if (f === 'incomplete') return p.incompleteKeys > 0;
  return true;
}

/** Раскладка одной схемы: BFS-уровни от таблицы с максимумом связей. */
function computeLayout(tables: SchemaTable[], links: { from: string; to: string }[]) {
  const W = 230, GX = 84, GY = 26, HDR = 36, ROW = 17, SHOW = 15;
  const canon = (name: string) => canonicalFieldName(name);
  const heightOf = (t: SchemaTable) => {
    const shown = Math.min(t.fields.length, SHOW);
    const more = t.fields.length > SHOW ? ROW : 0;
    const bar = t.problemsByType.overload > 0 ? 8 : 0;
    return HDR + shown * ROW + more + bar + 8;
  };
  const adj = new Map<string, Set<string>>();
  const deg = new Map<string, number>();
  const bump = (c: string, nb: string) => {
    if (!adj.has(c)) adj.set(c, new Set());
    adj.get(c)!.add(nb);
  };
  for (const l of links) {
    bump(l.from, l.to);
    bump(l.to, l.from);
    deg.set(l.from, (deg.get(l.from) ?? 0) + 1);
    deg.set(l.to, (deg.get(l.to) ?? 0) + 1);
  }
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  let root = sorted[0];
  for (const t of sorted) {
    const d = (deg.get(canon(t.name)) ?? 0) - (deg.get(canon(root.name)) ?? 0);
    if (d > 0) root = t;
  }
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
  const maxLevel = Math.max(0, ...level.values());
  const cols: SchemaTable[][] = Array.from({ length: maxLevel + 1 }, () => []);
  const orphans: SchemaTable[] = [];
  for (const t of sorted) {
    const lv = level.get(canon(t.name));
    if (lv == null) orphans.push(t);
    else cols[lv].push(t);
  }
  if (orphans.length) cols.push(orphans);
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
  const fieldY = (tc: string, fieldName: string): number | null => {
    const t = tables.find((x) => canon(x.name) === tc);
    const p = pos.get(tc);
    if (!t || !p) return null;
    const idx = t.fields.findIndex((f) => canonicalFieldName(f.name) === canonicalFieldName(fieldName));
    if (idx < 0 || idx >= SHOW) return null;
    return p.y + HDR + idx * ROW + ROW - 5;
  };
  return { tables: sorted, pos, W, GX, HDR, ROW, SHOW, width, height, fieldY, canon };
}

export default function LineageTab({ analysis, onOpenAnalysis }: Props) {
  // Выбранная таблица: { key: состояние, table } — для панели деталей.
  const [selTable, setSelTable] = useState<{ key: StateKey; table: SchemaTable } | null>(null);
  const [selField, setSelField] = useState<{ key: StateKey; table: SchemaTable; field: SchemaTable['fields'][number] } | null>(null);
  // Раскрытые секции-аккордеоны: по умолчанию — текущая финальная модель.
  const [openSections, setOpenSections] = useState<Set<StateKey>>(new Set(['final']));
  const [filter, setFilter] = useState<FilterKey>('all');

  const schema = analysis?.schema ?? null;

  /** Раскладки трёх состояний модели. */
  const layouts = useMemo(() => {
    if (!schema) return null;
    const out = {} as Record<StateKey, ReturnType<typeof computeLayout>>;
    for (const st of MODEL_STATES) {
      const s = st.key === 'asBuilt' ? schema.asBuilt : st.key === 'afterFix' ? schema.afterFix : schema.final;
      out[st.key] = computeLayout(s.tables, s.links);
    }
    return out;
  }, [schema]);

  /** Счётчики фильтров по полной картине asBuilt. */
  const filterCounts = useMemo(() => {
    const counts: Record<Exclude<FilterKey, 'all'>, number> = {
      problems: 0, synthetic: 0, unused: 0, mn: 0, incomplete: 0,
    };
    const seen = new Set<string>();
    for (const t of schema?.asBuilt.tables ?? []) {
      const tc = canonicalFieldName(t.name);
      if (seen.has(tc)) continue;
      seen.add(tc);
      if (matchesFilter(t, 'problems')) counts.problems += 1;
      if (matchesFilter(t, 'synthetic')) counts.synthetic += 1;
      if (matchesFilter(t, 'unused')) counts.unused += 1;
      if (matchesFilter(t, 'mn')) counts.mn += 1;
      if (matchesFilter(t, 'incomplete')) counts.incomplete += 1;
    }
    return counts;
  }, [schema]);

  const modelDom = analysis?.summary?.domains?.model ?? null;
  const modelScore = modelDom?.score ?? null;
  const zone = modelScore == null ? 'n' : modelScore >= 75 ? 'g' : modelScore >= 50 ? 'y' : 'r';
  const zonePill = modelScore == null ? 'mute' : modelScore >= 75 ? 'ok' : modelScore >= 50 ? 'warning' : 'error';

  // Находки домена «Модель данных» — для счётчиков карточки.
  const modelFindings = (analysis?.findings ?? []).filter((f) => f.domain === 'model');
  const modelBySev = { error: 0, warning: 0, info: 0 };
  for (const f of modelFindings) {
    const k = f.severity as keyof typeof modelBySev;
    if (modelBySev[k] != null) modelBySev[k] += 1;
  }
  // Таблиц с синтетическим ключом (по полной картине asBuilt).
  const syntheticTables = (schema?.asBuilt.tables ?? []).filter((t) => t.problemsByType.synthetic > 0).length;

  // Пропущенные проверки модели: без них «чистые таблицы» не звучит как «отлично»
  // (типично для QlikView-импортированных приложений — сервер не отдал
  // сведения об использовании полей).
  const skippedUsage = useMemo(() => (analysis?.ruleStats ?? [])
    .filter((s) => ['R001', 'R002', 'R003'].includes(s.id) && s.skipped), [analysis]);
  const partialScore = skippedUsage.length > 0;
  const verdictText = modelScore == null
    ? 'оценка недоступна'
    : partialScore ? 'Оценка неполная' : (modelDom?.verdict ?? '');
  const verdictPill = partialScore && modelScore != null && modelScore >= 75 ? 'warning' : zonePill;

  // Худшие таблицы для карточки: по максимальной важности, затем по числу мест.
  const worstTables = useMemo(() => (schema?.final.tables ?? [])
    .filter((t) => t.problems)
    .map((t) => ({ t, sev: maxSev(t.problems) ?? 'info' }))
    .sort((a, b) => (
      (SEV_RANK[b.sev] ?? 0) - (SEV_RANK[a.sev] ?? 0)
      || b.t.problems!.total - a.t.problems!.total
      || a.t.name.localeCompare(b.t.name)
    ))
    .slice(0, 4), [schema]);

  const toggleSection = (key: StateKey) => setOpenSections((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  if (!analysis || !schema) {
    return (
      <section className="card wide">
        <h2>Формирование</h2>
        <p className="muted">
          Модель данных приложения появится после анализа: таблицы и связи в трёх
          состояниях — как сформировано (с дропнутыми и промежуточными), текущая
          финальная и рекомендованная после правок — с пометками всех проблем:
          неиспользуемые поля и таблицы, синтетические ключи, неполные ключи, M:N,
          перегрузка данными.
        </p>
      </section>
    );
  }

  /** Бейджи проблем таблицы (строка под заголовком бокса). */
  const badgesOf = (t: SchemaTable) => {
    const p = t.problemsByType;
    const out: { cls: string; text: string }[] = [];
    if (p.synthetic > 0) out.push({ cls: 'ms-b-syn', text: `⚠ синт.ключ ${p.synthetic}` });
    if (p.incompleteKeys > 0) out.push({ cls: 'ms-b-inc', text: `▲ неполный ${p.incompleteKeys}` });
    if (p.unusedFields > 0) out.push({ cls: 'ms-b-unused', text: `◦ неисп. ${p.unusedFields}` });
    if (p.unusedTable > 0) out.push({ cls: 'ms-b-unused', text: 'не используется' });
    if (p.mn > 0) out.push({ cls: 'ms-b-mn', text: `M:N ${p.mn}` });
    if (t.removedByFix) out.push({ cls: 'ms-b-unused', text: '− удаляется правкой' });
    return out;
  };

  /** Схема одного состояния. */
  const renderState = (key: StateKey) => {
    const lay = layouts![key];
    const st = key === 'asBuilt' ? schema.asBuilt : key === 'afterFix' ? schema.afterFix : schema.final;
    const { pos, W, HDR, ROW, SHOW, width, height, fieldY, canon } = lay;
    const boxPos = (tc: string) => pos.get(tc) ?? null;
    return (
      <div className="card scrolltbl" style={{ marginTop: 10 }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: 'block', minWidth: '100%' }}
          role="img"
          aria-label={`Модель данных: ${MODEL_STATES.find((s) => s.key === key)?.title ?? ''}`}
          className="ms-schema"
        >
          <defs>
            <marker id={`ms-arrow-${key}`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" />
            </marker>
          </defs>

          {st.links.map((l, i) => {
            const a = boxPos(l.from);
            const b = boxPos(l.to);
            if (!a || !b) return null;
            const fy1 = l.field ? fieldY(l.from, l.field) : null;
            const fy2 = l.field ? fieldY(l.to, l.field) : null;
            const x1 = a.x + W, y1 = fy1 ?? a.y + a.h / 2;
            const x2 = b.x, y2 = fy2 ?? b.y + b.h / 2;
            const mx = (x1 + x2) / 2;
            const cls = l.kind === 'm:n' ? 'ms-link ms-link-mn' : l.kind === '1:1' ? 'ms-link ms-link-11' : 'ms-link';
            const label = l.field
              ? (l.kind === 'key' ? cut(l.field, 18) : `${cut(l.field, 14)} · ${l.kind === '1:1' ? '1:1' : 'M:N'}`)
              : (CHAIN_LABELS[l.kind] ?? '');
            return (
              <g key={`${l.from}|${l.to}|${l.field ?? l.kind}|${i}`}>
                <path
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 3} ${y2}`}
                  className={cls}
                  markerEnd={`url(#ms-arrow-${key})`}
                />
                {label && <text x={mx} y={(y1 + y2) / 2 - 3} textAnchor="middle" className="ms-linklabel">{label}</text>}
              </g>
            );
          })}

          {st.tables.map((t) => {
            const tc = canon(t.name);
            const p = boxPos(tc);
            if (!p) return null;
            const sev = maxSev(t.problems);
            const zoneCls = sev === 'error' ? 'ms-err' : sev === 'warning' ? 'ms-warn' : sev === 'info' ? 'ms-info' : 'ms-ok';
            const dimmed = !matchesFilter(t, filter);
            const badges = badgesOf(t);
            const isSel = selTable?.key === key && canon(selTable.table.name) === tc;
            const shown = t.fields.slice(0, SHOW);
            const bar = t.problemsByType.overload > 0;
            return (
              <g key={`${key}-${tc}`} transform={`translate(${p.x}, ${p.y})`} opacity={dimmed ? 0.3 : 1}>
                <rect
                  width={W} height={p.h} rx={8}
                  className={`ms-node ${zoneCls}${t.dropped ? ' ms-drop' : ''}${t.removedByFix ? ' ms-removed' : ''}${isSel ? ' ms-sel' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setSelTable({ key, table: t }); setSelField(null); }}
                >
                  <title>{t.name} · {fmtRows(t.rows)} строк{t.synthetic ? ' · синтетический ключ' : ''}{t.dropped ? ' · удалена (DROP)' : ''}</title>
                </rect>
                <text x={10} y={20} className="ms-title" style={{ cursor: 'pointer' }}
                  onClick={() => { setSelTable({ key, table: t }); setSelField(null); }}>{cut(t.name, 20)}</text>
                <text x={W - 8} y={20} textAnchor="end" className="ms-sub">
                  {t.dropped ? '✖ DROP' : t.removedByFix ? '− удаляется' : (t.rows == null ? 'строки —' : `${fmtRows(t.rows)} стр`)}
                </text>
                <text x={10} y={32} className="ms-sub">
                  {badges.length === 0 && !t.stored && !t.sourceKind && <tspan>чистая таблица</tspan>}
                  {badges.map((b, i) => <tspan key={i} className={b.cls}>{`${b.text}  `}</tspan>)}
                  {t.stored && <tspan className="ms-ok-t">· STORE </tspan>}
                  {t.sourceKind && <tspan> · {SOURCE_KIND_LABELS[t.sourceKind] ?? ''}</tspan>}
                </text>
                {shown.map((f, fi) => {
                  const fy = HDR + fi * ROW + ROW - 5;
                  const fsev = maxSev(f.problems);
                  const mark = f.removedByFix ? '− ' : f.key ? '● ' : f.unused ? '◦ ' : '';
                  return (
                    <text
                      key={fi}
                      x={f.removedByFix || f.key || f.unused || fsev ? 24 : 12}
                      y={fy}
                      className={`ms-field${f.key ? ' ms-fkey' : ''}${f.incompleteKey ? ' ms-finc' : ''}${f.unused && !f.removedByFix ? ' ms-funused' : ''}${f.removedByFix ? ' ms-fremoved' : ''}`}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); setSelTable({ key, table: t }); setSelField({ key, table: t, field: f }); }}
                    >
                      <title>{f.name}{f.key ? ' · ключ' : ''}{f.incompleteKey ? ' · неполный ключ' : ''}{f.unused ? ' · не используется' : ''}{f.removedByFix ? ' · удаляется правкой' : ''}</title>
                      {fsev && <tspan className={`ms-sev-${fsev === 'error' ? 'err' : fsev === 'warning' ? 'warn' : 'info'}`}>● </tspan>}
                      {f.key && <tspan className="ms-keymark">● </tspan>}
                      {mark}{cut(f.name, fsev || f.key || f.unused || f.removedByFix ? 21 : 26)}
                    </text>
                  );
                })}
                {t.fields.length > SHOW && (
                  <text x={12} y={HDR + SHOW * ROW + ROW - 5} className="ms-more">+{t.fields.length - SHOW} ещё…</text>
                )}
                {bar && (
                  <>
                    <rect x={10} y={p.h - 8} width={W - 20} height={4} rx={2} className="ms-overload-track" />
                    <rect x={10} y={p.h - 8} width={Math.max(4, (W - 20) * t.problemsByType.overload / 100)} height={4} rx={2}
                      className={t.problemsByType.overload >= 70 ? 'ms-overload-fill-hi' : 'ms-overload-fill'}>
                      <title>Перегрузка данными: {t.problemsByType.overload}%</title>
                    </rect>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    );
  };

  return (
    <section>
      <div className="card row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Модель данных приложения</h3>
        <span className="grow" />
        <span className="hint">{schema.final.tables.length} таблиц · {schema.final.links.length} связей</span>
      </div>

      {/* Карточка «Качество модели» — наверху (утверждённый макет) */}
      <div className="card ms-quality" style={{ marginBottom: 12 }}>
        <div className="hint" style={{ marginBottom: 6 }}>
          Качество модели
          {schema?.meta?.platform ? ` · прогон: платформа ${schema.meta.platform === 'qlikview' ? 'QlikView (Doc API)' : schema.meta.platform}` : ''}
          {schema?.meta?.objectsCount != null ? ` · объектов ${schema.meta.objectsCount}` : ''}
        </div>
        <div className="row" style={{ gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className={`ring ${zone}`} style={{ width: 84, height: 84, borderWidth: 7 }}>
            <div>
              <b>{modelScore ?? '—'}</b>
              <br />
              <span className="muted">из 100</span>
            </div>
          </div>
          <div style={{ fontSize: 15 }}>
            Модель данных
            <br />
            <span className={`pill ${verdictPill}`} style={{ marginTop: 4, display: 'inline-block' }}>
              {verdictText}
            </span>
          </div>
          <div className="ms-qcounts">
            <div className="ms-qcnt"><b className="ms-sev-err-t">{modelBySev.error}</b>ошибки</div>
            <div className="ms-qcnt"><b className="ms-sev-warn-t">{modelBySev.warning}</b>предупреждения</div>
            <div className="ms-qcnt"><b>{modelBySev.info}</b>замечания</div>
            <div className="ms-qcnt"><b className="ms-sev-warn-t">{syntheticTables}</b>синт.ключа</div>
          </div>
          <span className="grow" />
          {worstTables.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="hint">Худшие таблицы:</span>
              {worstTables.map(({ t, sev }) => (
                <button
                  key={t.name}
                  className="chip small"
                  onClick={() => { setSelTable({ key: 'final', table: t }); setSelField(null); }}
                  title="Показать находки таблицы"
                >
                  {cut(t.name, 18)} · {SEV_RU[sev]?.toLowerCase()}
                </button>
              ))}
            </div>
          )}
        </div>
        {partialScore && (() => {
          // Причины пропуска — из ruleStats, а не наугад:
          // skipped без note — правило выключено во вкладке «Правила»;
          // skipped с note — недостаток данных (текст из правила).
          const disabledRules = skippedUsage.filter((s) => !s.note).map((s) => s.id);
          const dataRules = skippedUsage.filter((s) => s.note);
          const plat = schema?.meta?.platform ?? null;
          const fs2 = schema?.meta?.frontEndStats ?? null;
          const objCount = schema?.meta?.objectsCount ?? 0;
          let dataAdvice = '';
          if (dataRules.length) {
            if (plat === 'qlikview') {
              dataAdvice = 'Анализ выполнен в режиме QlikView (Doc API): сервер не отдаёт ссылки на поля в объектах. Если приложение доступно движком Sense — переключите платформу на «Qlik Sense» во вкладке «Подключение» и переанализируйте.';
            } else if (objCount === 0) {
              dataAdvice = 'Объекты фронт-энда не собраны (0) — проверьте подключение (⟳ / «Войти в хаб») и переанализируйте.';
            } else if (fs2 && fs2.objectsWithExpressions === 0) {
              dataAdvice = `Свойства объектов не получены: из ${objCount} объектов ни один не пришёл с выражениями. Чаще всего это устаревшая сессия хаба — войдите в хаб заново («Подключение» → «Войти в хаб») и переанализируйте приложение.`;
            } else if (fs2 && fs2.referenced === 0) {
              dataAdvice = 'Выражения у объектов есть, но ссылки на поля не извлеклись — переанализируйте; если повторится, это ограничение API для импортированных приложений.';
            } else {
              dataAdvice = 'Переанализируйте приложение; если повторится — пришлите скриншот этой карточки разработчику.';
            }
          }
          const statsLine = fs2
            ? ` (объектов ${fs2.objects}, из них с выражениями ${fs2.objectsWithExpressions}, полей со ссылками ${fs2.referenced})`
            : '';
          return (
            <div className="hint" style={{ marginTop: 8 }}>
              ⚠ Оценка неполная{statsLine}: {skippedUsage.length} проверк{skippedUsage.length === 1 ? 'а' : 'и'} не выполнен{(skippedUsage.length === 1 ? 'а' : 'ы')}.
              «Чистые таблицы» в этом случае не означает «отлично».
              {disabledRules.length > 0 && (
                <div>
                  Выключены во вкладке «Правила»: <b>{disabledRules.join(', ')}</b> — включите их, чтобы увидеть неиспользуемые
                  поля/таблицы, синтетические ключи и перегрузку.
                </div>
              )}
              {dataRules.length > 0 && (
                <div>
                  Недостаточно данных для {dataRules.map((s) => s.id).join(', ')}: {dataAdvice}
                </div>
              )}
            </div>
          );
        })()}
        {(schema?.meta.notes ?? []).map((n, i) => (
          <div key={i} className="hint" style={{ color: 'var(--warn, #e0a33e)', marginTop: 6 }}>⚠ {n}</div>
        ))}
        {modelScore == null && (
          <div className="hint" style={{ marginTop: 6 }}>
            ⚠ Балл домена недоступен в этом прогоне — переанализируйте приложение свежей версией.
          </div>
        )}
      </div>

      {/* Фильтры проблем */}
      <div className="ms-filters" style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`small${filter === f.key ? ' is-active' : ''}`}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
          >
            {f.label}
            {f.key !== 'all' ? ` ${filterCounts[f.key as Exclude<FilterKey, 'all'>]}` : ''}
          </button>
        ))}
        <span className="grow" />
        <span className="hint" style={{ alignSelf: 'center' }}>клик по таблице — находки</span>
      </div>

      {/* Три состояния модели — аккордеоны */}
      {MODEL_STATES.map((st) => {
        const s = st.key === 'asBuilt' ? schema.asBuilt : st.key === 'afterFix' ? schema.afterFix : schema.final;
        const droppedCount = s.tables.filter((t) => t.dropped).length;
        const removedFields = s.tables.reduce((n, t) => n + t.fields.filter((f) => f.removedByFix).length, 0);
        const removedTables = s.tables.filter((t) => t.removedByFix).length;
        const counts = st.key === 'asBuilt'
          ? `${s.tables.length} табл · ${droppedCount} удалены · ${s.links.length} связей`
          : st.key === 'afterFix'
            ? `${s.tables.length} табл · −${removedFields} полей · −${removedTables} табл · ${s.links.length} связей`
            : `${s.tables.length} табл · ${s.links.length} связей`;
        const open = openSections.has(st.key);
        return (
          <div key={st.key} className="card ms-sec" style={{ marginBottom: 10 }}>
            <button
              className="ms-sec-head"
              onClick={() => toggleSection(st.key)}
              aria-expanded={open}
            >
              <span className="ms-chev">{open ? '▼' : '▶'}</span>
              <span className="ms-sec-title">{st.title}</span>
              <span className="ms-sec-counts">{counts}</span>
            </button>
            {open && renderState(st.key)}
          </div>
        );
      })}

      {/* Детали таблицы */}
      {selTable && !selField && (() => {
        const t = selTable.table;
        const pbt = t.problemsByType;
        const typePills: { cls: string; label: string }[] = [
          ...(pbt.synthetic > 0 ? [{ cls: 'warning', label: `синт.ключ: ${pbt.synthetic}` }] : []),
          ...(pbt.incompleteKeys > 0 ? [{ cls: 'warning', label: `неполные ключи: ${pbt.incompleteKeys}` }] : []),
          ...(pbt.unusedFields > 0 ? [{ cls: 'mute', label: `неисп. поля: ${pbt.unusedFields}` }] : []),
          ...(pbt.unusedTable > 0 ? [{ cls: 'error', label: 'таблица не используется' }] : []),
          ...(pbt.mn > 0 ? [{ cls: 'error', label: `M:N: ${pbt.mn}` }] : []),
          ...(pbt.empty > 0 ? [{ cls: 'mute', label: `пустое: ${pbt.empty}` }] : []),
          ...(pbt.cardinality > 0 ? [{ cls: 'mute', label: `кардинальность: ${pbt.cardinality}` }] : []),
          ...(pbt.merge > 0 ? [{ cls: 'ok', label: 'можно объединить (1:1)' }] : []),
          ...(pbt.overload > 0 ? [{ cls: 'warning', label: `перегрузка ${pbt.overload}%` }] : []),
        ];
        return (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>
              Таблица: {t.name}
              {t.dropped && <span className="pill error" style={{ marginLeft: 8 }}>✖ DROP</span>}
              {t.removedByFix && <span className="pill warning" style={{ marginLeft: 8 }}>− удаляется правкой</span>}
              {t.synthetic && <span className="pill warning" style={{ marginLeft: 8 }}>синтетический ключ</span>}
              {t.problems && <span className={`pill ${maxSev(t.problems) === 'error' ? 'error' : maxSev(t.problems) === 'warning' ? 'warning' : 'mute'}`} style={{ marginLeft: 8 }}>находок: {t.problems.total}</span>}
              <span className="grow" />
              {onOpenAnalysis && (
                <button className="small" onClick={() => onOpenAnalysis(t.name)}>Показать в Анализе</button>
              )}
              <button className="small" style={{ marginLeft: 6 }} onClick={() => setSelTable(null)}>Закрыть</button>
            </h3>
            <p className="muted small">
              {fmtRows(t.rows)} строк · полей: {t.fields.length}
              {t.sourceKind ? ` · источник: ${SOURCE_KIND_LABELS[t.sourceKind] ?? t.sourceKind}` : ''}
              {t.keyFields.length ? ` · ключи: ${t.keyFields.join(', ')}` : ''}
              {t.intermediate ? ' · промежуточная (нет в финальной модели)' : ''}
            </p>
            {typePills.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                {typePills.map((p, i) => <span key={i} className={`pill ${p.cls}`}>{p.label}</span>)}
              </div>
            )}
            {t.problems && (
              <>
                <div className="hint" style={{ margin: '8px 0 4px' }}>Находки по таблице</div>
                {t.problems.rules.map((r) => (
                  <div key={r.id} className="row small" style={{ gap: 8, marginBottom: 2 }}>
                    <span className={`pill ${r.severity === 'error' ? 'error' : r.severity === 'warning' ? 'warning' : 'mute'}`}>{SEV_RU[r.severity] ?? r.severity}</span>
                    <span>{r.title}</span>
                    <span className="muted">{r.id} · мест: {r.count}</span>
                  </div>
                ))}
                {t.fields.some((f) => f.problems || f.removedByFix) && (
                  <>
                    <div className="hint" style={{ margin: '10px 0 4px' }}>Проблемные поля (клик — детали)</div>
                    {t.fields.filter((f) => f.problems || f.removedByFix).map((f) => {
                      const s = maxSev(f.problems) ?? 'info';
                      return (
                        <div key={f.name} className="row small" style={{ gap: 8, marginBottom: 2, cursor: 'pointer' }}
                          onClick={() => setSelField({ key: selTable.key, table: t, field: f })}>
                          <span className={`pill ${s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'mute'}`}>{SEV_RU[s]}</span>
                          <span>{f.removedByFix ? '− ' : ''}{f.name}</span>
                          <span className="muted">{f.key ? 'ключ · ' : ''}{f.incompleteKey ? 'неполный · ' : ''}{f.unused ? 'не используется · ' : ''}{f.removedByFix ? 'удаляется правкой' : `находок: ${f.problems?.total ?? 0}`}</span>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}
            {!t.problems && (
              <p className="small" style={{ color: 'var(--success)' }}>Проблем не найдено — таблица чистая.</p>
            )}
          </div>
        );
      })()}

      {/* Детали поля */}
      {selField && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>
            Поле: {selField.field.name}
            <span className="muted small" style={{ marginLeft: 8 }}>таблица {selField.table.name}</span>
            {selField.field.key && <span className="pill ok" style={{ marginLeft: 8 }}>ключ</span>}
            {selField.field.incompleteKey && <span className="pill warning" style={{ marginLeft: 8 }}>неполный ключ</span>}
            {selField.field.removedByFix && <span className="pill warning" style={{ marginLeft: 8 }}>− удаляется правкой</span>}
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
    </section>
  );
}
