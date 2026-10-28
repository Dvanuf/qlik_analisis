/**
 * Вкладка «Анализ».
 *
 * Устроена по доменам — «какая забота», а не «в каком файле лежит правило».
 * Сверху — метрики (скор, пройдено, нарушено, пропущено), затем карточки
 * шести доменов. Ниже слева — чек-лист всех проверок, справа — находки,
 * собранные в паттерны: одна строка на корень проблемы, места внутри.
 *
 * Клик по паттерну открывает панель справа с выражением и списком мест.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildFixes } from '../../../src/report/fixes.js';
import { searchExpressions } from '../../../src/script/search.js';
import type {
  AnalysisResult, DomainId, Finding, FindingScope, Pattern, PatternRule,
  RulesConfig, Severity,
} from '../types.js';

const SEVERITIES: { id: Severity; label: string }[] = [
  { id: 'error', label: 'Ошибка' },
  { id: 'warning', label: 'Предупреждение' },
  { id: 'info', label: 'Замечание' },
];

/** Домены в порядке интерфейса. */
const DOMAIN_ORDER: DomainId[] = ['model', 'script', 'dash', 'expr', 'vars', 'conn'];

/** Подписи доменов. */
const DOMAIN_LABELS: Record<DomainId, string> = {
  model: 'Модель данных',
  script: 'Скрипт загрузки',
  dash: 'Дашборд и объекты',
  expr: 'Меры и выражения',
  vars: 'Переменные',
  conn: 'Подключения и окружение',
};

/** Состояние проверки в чек-листе. */
function checkState(count: number, skipped: boolean): 'f' | 'o' | 's' {
  if (skipped) return 's';
  return count > 0 ? 'f' : 'o';
}

/** Области находок: скрипт / дашборд / меры. */
const SCOPES: { id: FindingScope; label: string }[] = [
  { id: 'script', label: 'Скрипт загрузки' },
  { id: 'dashboard', label: 'Дашборд' },
  { id: 'measures', label: 'Меры и измерения' },
];

const SCOPE_LABELS: Record<string, string> = Object.fromEntries(
  SCOPES.map((s) => [s.id, s.label]),
);

type SortKey = 'severity' | 'ruleId' | 'category' | 'object' | 'table' | 'line';

type Props = {
  analysis: AnalysisResult | null;
  categories: string[];
  exportNote: string;
  onExport: () => void;
  onExportScript: () => void;
  onExportDataModel: () => void;
  rulesConfig: RulesConfig | null;
  onSaveRulesConfig: (config: RulesConfig) => void;
  /** Переход к вкладке «Скрипт загрузки» — из карточки паттерна. */
  onOpenScript?: () => void;
  /** Переход к вкладке «Модель данных». */
  onOpenModel?: () => void;
};

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** Первая строка скрипта, связанная с находкой (для сортировки). */
function firstLine(finding: Finding): number {
  const lines = finding.lines?.length ? finding.lines : [];
  if (lines.length) return lines[0];
  return finding.line ?? 0;
}

/**
 * Склонение числительного: plural(5, 'место', 'места', 'мест') → 'мест'.
 */
function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Показывать ли паттерн по строке поиска. */
function matchesSearch(pattern: Pattern, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${pattern.ruleId} ${pattern.title} ${pattern.expression} ${pattern.message} ${pattern.recommendation}`
    .toLowerCase();
  return hay.includes(q);
}

/** Класс пилюли по важности. */
function severityClass(severity: string): string {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

/** Подпись важности. */
function severityLabel(severity: string): string {
  return SEVERITIES.find((s) => s.id === severity)?.label ?? severity;
}

/**
 * Строки одного правила: заголовок правила и его паттерны.
 */
function PatternRows(props: {
  rule: PatternRule;
  patterns: Pattern[];
  onOpen: (pattern: Pattern) => void;
}) {
  const { rule, patterns, onOpen } = props;
  return (
    <>
      <tr className="rule">
        <td colSpan={6}>
          <b>{rule.ruleId}</b> · {rule.title}
          <span className={`pill ${severityClass(rule.severity)}`} style={{ marginLeft: 8 }}>
            {severityLabel(rule.severity)}
          </span>
          <span className="hint" style={{ marginLeft: 8 }}>{DOMAIN_LABELS[rule.domain]}</span>
          <span className="num" style={{ float: 'right' }}>
            {rule.places} {plural(rule.places, 'место', 'места', 'мест')}
            {' · '}
            {rule.patterns.length} {plural(rule.patterns.length, 'паттерн', 'паттерна', 'паттернов')}
          </span>
        </td>
      </tr>
      {patterns.map((p) => (
        <tr className="pat" key={p.id} onClick={() => onOpen(p)}>
          <td>
            <span className="link">▸ {p.expression || p.message}</span>
          </td>
          <td className="hint">{DOMAIN_LABELS[p.domain]}</td>
          <td>
            <span className={`pill ${severityClass(p.severity)}`}>
              {severityLabel(p.severity)}
            </span>
          </td>
          <td><span className="pill error">✗ нарушено</span></td>
          <td className="num">{p.count}</td>
          <td className="hint">
            {p.places[0]
              ? `${p.places[0].name}${p.places[0].table ? ` (${p.places[0].table})` : ''}`
              : '—'}
          </td>
        </tr>
      ))}
    </>
  );
}

export default function AnalysisTab(props: Props) {
  const {
    analysis, categories, exportNote, onExport, onExportScript, onExportDataModel,
    rulesConfig, onSaveRulesConfig, onOpenScript, onOpenModel,
  } = props;

  // Активный домен: null — показываем все.
  const [activeDomain, setActiveDomain] = useState<DomainId | null>(null);
  // Открытый паттерн — карточка корня проблемы справа.
  const [openPattern, setOpenPattern] = useState<Pattern | null>(null);
  const [sevFilter, setSevFilter] = useState<Set<Severity>>(new Set());
  const [catFilter, setCatFilter] = useState<Set<string>>(new Set());
  const [scopeFilter, setScopeFilter] = useState<Set<FindingScope>>(new Set());
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState<Finding | null>(null);
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  // Блок предлагаемых правок по умолчанию свёрнут: он длинный,
  // а смотреть его нужно не всегда.
  const [fixesOpen, setFixesOpen] = useState(false);
  // Поиск по произвольному выражению (QSME: search any expression).
  const [exprQuery, setExprQuery] = useState('');

  const findings = analysis?.findings ?? [];
  const suppressed = analysis?.suppressed ?? [];

  /** Счётчики для карточек и чипов. */
  const counts = useMemo(() => {
    const bySeverity: Record<string, number> = { error: 0, warning: 0, info: 0 };
    const byCategory: Record<string, number> = {};
    const byScope: Record<string, number> = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
      const scope = f.scope ?? 'dashboard';
      byScope[scope] = (byScope[scope] ?? 0) + 1;
    }
    return { bySeverity, byCategory, byScope };
  }, [findings]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = findings.filter((f) => {
      if (sevFilter.size && !sevFilter.has(f.severity as Severity)) return false;
      if (catFilter.size && !catFilter.has(f.category)) return false;
      if (scopeFilter.size && !scopeFilter.has((f.scope ?? 'dashboard') as FindingScope)) return false;
      if (q) {
        const hay = `${f.ruleId} ${f.title} ${f.message} ${f.detail ?? ''} ${f.target?.name ?? ''} ${f.table ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sortAsc ? 1 : -1;
    return list.sort((a, b) => {
      switch (sortKey) {
        case 'severity': return ((SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)) * dir;
        case 'ruleId': return a.ruleId.localeCompare(b.ruleId) * dir;
        case 'category': return a.category.localeCompare(b.category) * dir;
        case 'object': return String(a.target?.name ?? '').localeCompare(String(b.target?.name ?? '')) * dir;
        case 'table': return String(a.table ?? '').localeCompare(String(b.table ?? '')) * dir;
        case 'line': return (firstLine(a) - firstLine(b)) * dir;
        default: return 0;
      }
    });
  }, [findings, sevFilter, catFilter, scopeFilter, search, sortKey, sortAsc]);

  const fixes = useMemo(
    () => buildFixes(findings, analysis?.script ?? ''),
    [findings, analysis?.script],
  );

  /**
   * Сводка по доменам: сколько проверок, сколько нарушено, сколько мест.
   *
   * Считается из ruleStats, чтобы домены были видны и там, где сводка ядра
   * ещё не заполнена (например, в старом отчёте).
   */
  const domainStats = useMemo(() => {
    const stats = analysis?.ruleStats ?? [];
    const out = {} as Record<DomainId, {
      id: DomainId; label: string; total: number; failed: number;
      skipped: number; passed: number; findings: number; places: number;
    }>;
    for (const id of DOMAIN_ORDER) {
      out[id] = {
        id, label: DOMAIN_LABELS[id], total: 0, failed: 0,
        skipped: 0, passed: 0, findings: 0, places: 0,
      };
    }
    for (const stat of stats) {
      const id = (stat.domain ?? 'dash') as DomainId;
      const bucket = out[id];
      if (!bucket) continue;
      bucket.total += 1;
      if (stat.skipped) bucket.skipped += 1;
      else if (stat.count > 0) bucket.failed += 1;
      else bucket.passed += 1;
      bucket.findings += stat.count;
    }
    // Места считаем по находкам: одна находка может стоить в нескольких местах.
    for (const f of findings) {
      const bucket = out[(f.domain ?? 'dash') as DomainId];
      if (!bucket) continue;
      bucket.places += f.count ?? 1;
    }
    // Если ядро уже посчитало сводку — берём её: она точнее по местам.
    const fromCore = analysis?.summary.findings.byDomain;
    if (fromCore) {
      for (const id of DOMAIN_ORDER) {
        const src = fromCore[id];
        if (src) out[id] = { ...out[id], ...src, id, label: DOMAIN_LABELS[id] };
      }
    }
    return out;
  }, [analysis?.ruleStats, analysis?.summary.findings.byDomain, findings]);

  /**
   * Паттерны, сгруппированные по правилам: одна строка на корень проблемы.
   *
   * Ядро отдаёт готовую группировку; если её нет (старый результат),
   * показываем находки как есть — по одной на строку.
   */
  const patternRules = useMemo(() => {
    const all = analysis?.patternRules ?? [];
    if (!all.length) return [];
    return activeDomain ? all.filter((r) => r.domain === activeDomain) : all;
  }, [analysis?.patternRules, activeDomain]);

  const patternTotals = useMemo(() => {
    const rules = patternRules.length;
    const patterns = patternRules.reduce((a, r) => a + r.patterns.length, 0);
    const places = patternRules.reduce((a, r) => a + r.places, 0);
    return { rules, patterns, places };
  }, [patternRules]);

  /** Проверки по доменам — для чек-листа. */
  const checklist = useMemo(() => {
    const stats = analysis?.ruleStats ?? [];
    const byDomain = new Map<DomainId, typeof stats>();
    for (const id of DOMAIN_ORDER) byDomain.set(id, []);
    for (const stat of stats) {
      const id = (stat.domain ?? 'dash') as DomainId;
      byDomain.get(id)?.push(stat);
    }
    return byDomain;
  }, [analysis?.ruleStats]);

  /** Результаты поиска по выражению — в объектах и в скрипте. */
  const exprHits = useMemo(
    () => searchExpressions({
      expressions: analysis?.expressionIndex ?? [],
      script: analysis?.script ?? '',
    }, exprQuery),
    [analysis?.expressionIndex, analysis?.script, exprQuery],
  );

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  };

  const sortBy = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const arrow = (key: SortKey) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');

  /** Подавить находку глобально: правило + таблица. */
  const suppressFinding = (f: Finding) => {
    if (!rulesConfig) return;
    const table = f.table ?? (f.target?.kind === 'table' ? f.target.name : undefined);
    const next: RulesConfig = {
      rules: {
        ...rulesConfig.rules,
        suppress: [
          ...rulesConfig.rules.suppress,
          { ruleId: f.ruleId, ...(table ? { table } : {}) },
        ],
      },
    };
    onSaveRulesConfig(next);
    setNote(`Подавлено: ${f.ruleId}${table ? ` (${table})` : ''}. Перезапустите анализ, чтобы применить.`);
  };

  const unsuppress = (ruleId: string, table?: string) => {
    if (!rulesConfig) return;
    const next: RulesConfig = {
      rules: {
        ...rulesConfig.rules,
        suppress: rulesConfig.rules.suppress.filter(
          (s) => !(s.ruleId === ruleId && (s.table ?? undefined) === (table ?? undefined)),
        ),
      },
    };
    onSaveRulesConfig(next);
  };

  if (!analysis) {
    return (
      <section className="card wide">
        <h2>Результаты анализа</h2>
        <p className="muted">Анализ ещё не запускался. Откройте вкладку «Подключение».</p>
      </section>
    );
  }

  const score = analysis.summary.score ?? 0;
  const scoreClass = score >= 80 ? 'info' : score >= 50 ? 'warning' : 'error';
  const outline = analysis.outline?.full ?? null;

  // Числа для метрик: сколько проверок прошло, нарушено и пропущено.
  const totalChecks = (analysis.ruleStats ?? []).length;
  const failedChecks = (analysis.ruleStats ?? []).filter((s) => !s.skipped && s.count > 0).length;
  const skippedChecks = (analysis.ruleStats ?? []).filter((s) => s.skipped).length;
  const passed = Math.max(0, totalChecks - failedChecks - skippedChecks);

  return (
    <section className="card wide">
      <h2>
        Результаты анализа
        {analysis.appName ? ` — ${analysis.appName}` : ''}
        {analysis.file ? ` — ${analysis.file}` : ''}
      </h2>

      {/* --- Метрики --- */}
      <div className="kpis">
        <div className={`kpi ${scoreClass}`}>
          <div className="lab">Скор приложения</div>
          <div className="num">{score}</div>
          <div className="sub">{analysis.summary.scoreDetails?.formula ?? 'взвешенный, 0–100'}</div>
        </div>
        <div className="kpi ok">
          <div className="lab">Проверок пройдено</div>
          <div className="num">{passed} / {totalChecks}</div>
          <div className="sub">из {totalChecks} выполненных</div>
        </div>
        <div className="kpi err">
          <div className="lab">Нарушено</div>
          <div className="num">{failedChecks}</div>
          <div className="sub">правил требуют внимания</div>
        </div>
        <div className="kpi warn">
          <div className="lab">Пропущено</div>
          <div className="num">{skippedChecks}</div>
          <div className="sub">с указанием причины</div>
        </div>
      </div>

      {/* --- Домены: что за работа --- */}
      <h3 className="hint" style={{ margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>
        Домены — что за работа
      </h3>
      <div className="doms">
        {DOMAIN_ORDER.map((id) => {
          const d = domainStats[id];
          const tot = d.total || 1;
          const on = activeDomain === id ? ' on' : '';
          return (
            <button
              key={id}
              className={`dom${on}`}
              onClick={() => setActiveDomain(activeDomain === id ? null : id)}
              title={activeDomain === id ? 'Показать все домены' : `Показать только «${d.label}»`}
            >
              <div className="nm">{d.label}</div>
              <div className="st">
                <span className="f"><b>{d.failed}</b>нарушено</span>
                <span className="o"><b>{d.passed}</b>пройдено</span>
                <span className="s"><b>{d.skipped}</b>пропущено</span>
                <span style={{ marginLeft: 'auto' }}><b>{d.places}</b>находок</span>
              </div>
              <div className="bar">
                <i className="f" style={{ width: `${(d.failed / tot) * 100}%` }} />
                <i className="o" style={{ width: `${(d.passed / tot) * 100}%` }} />
                <i className="s" style={{ width: `${(d.skipped / tot) * 100}%` }} />
              </div>
            </button>
          );
        })}
      </div>

      <div className="actions">
        <button className="primary" onClick={onExport}>Экспорт отчёта</button>
        {analysis.dataModel && analysis.dataModel.length > 0 && (
          <button onClick={onExportDataModel}>Модель данных (Excel)</button>
        )}
        {analysis.patch?.script && (
          <button onClick={onExportScript}>Применить правки к копии скрипта (.qvs)</button>
        )}
      </div>
      {(exportNote || note) && <p className="muted small">{note || exportNote}</p>}

      {/* --- Чек-лист проверок и находки по паттернам --- */}
      <div className="split">
        <div className="card">
          <h3>
            Проверки
            <span className="grow" />
            <span className="hint">
              {activeDomain
                ? `фильтр: ${DOMAIN_LABELS[activeDomain]}`
                : `${DOMAIN_ORDER.length} доменов · ${totalChecks} ${plural(totalChecks, 'проверка', 'проверки', 'проверок')}`}
            </span>
          </h3>
          <ul className="cl">
            {DOMAIN_ORDER.filter((id) => !activeDomain || id === activeDomain).map((id) => {
              const list = checklist.get(id) ?? [];
              const d = domainStats[id];
              // Домен с нарушениями раскрыт сразу — иначе чек-лист выглядит пустым.
              const open = d.failed > 0;
              return (
                <details key={id} open={open}>
                  <summary>
                    {DOMAIN_LABELS[id]}
                    <span className="grow" />
                    <span className="hint">
                      {d.failed} ✗ · {d.passed} ✓ · {d.skipped} ⊘
                    </span>
                  </summary>
                  <ul className="rules">
                    {list.map((r) => {
                      const st = checkState(r.count, r.skipped);
                      return (
                        <li key={r.id} title={r.note ?? r.title}>
                          <span className={`dot ${st}`}>{st === 'f' ? '✗' : st === 's' ? '⊘' : '✓'}</span>
                          <span className="id">{r.id}</span>
                          <span className="t">
                            {r.title}
                            {r.note ? <em className="hint"> — {r.note}</em> : null}
                          </span>
                          {r.count ? <span className="n">{r.count}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              );
            })}
          </ul>
        </div>

        <div className="card">
          <h3>
            Находки
            <span className="grow" />
            <span className="hint">
              {' '}
              {patternTotals.rules} {plural(patternTotals.rules, 'правило', 'правила', 'правил')}
              {' · '}
              {patternTotals.patterns} {plural(patternTotals.patterns, 'паттерн', 'паттерна', 'паттернов')}
              {' · '}
              {patternTotals.places} {plural(patternTotals.places, 'место', 'места', 'мест')}
            </span>
          </h3>
          <div className="toolbar">
            <input
              className="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по находкам…"
            />
            {SEVERITIES.map((s) => (
              <button
                key={s.id}
                className={`chip${sevFilter.has(s.id) ? ' active' : ''}`}
                onClick={() => setSevFilter(toggle(sevFilter, s.id))}
                title={`Важность «${s.label}»`}
              >
                {s.label} <span className="n">{counts.bySeverity[s.id] ?? 0}</span>
              </button>
            ))}
            {activeDomain ? (
              <button className="chip active" onClick={() => setActiveDomain(null)}>
                {DOMAIN_LABELS[activeDomain]} ✕
              </button>
            ) : null}
          </div>
          <div style={{ maxHeight: 640, overflow: 'auto' }}>
            <table className="rq">
              <thead>
                <tr>
                  <th style={{ width: '38%' }}>Проверка / паттерн</th>
                  <th style={{ width: '13%' }}>Домен</th>
                  <th style={{ width: '11%' }}>Важность</th>
                  <th style={{ width: '12%' }}>Состояние</th>
                  <th style={{ width: '7%' }}>Мест</th>
                  <th>Где</th>
                </tr>
              </thead>
              <tbody>
                {patternRules.map((r) => {
                  const visible = r.patterns.filter((p) => matchesSearch(p, search));
                  if (!visible.length) return null;
                  return (
                    <PatternRows
                      key={r.ruleId}
                      rule={r}
                      patterns={visible}
                      onOpen={setOpenPattern}
                    />
                  );
                })}
                {patternRules.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted" style={{ padding: 24, textAlign: 'center' }}>
                      {activeDomain
                        ? 'В этом домене нарушений нет'
                        : 'Нарушений нет — все проверки пройдены'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <table className="findings">
        <thead>
          <tr>
            <th className="sortable" onClick={() => sortBy('severity')}>Уровень{arrow('severity')}</th>
            <th className="sortable" onClick={() => sortBy('ruleId')}>Правило{arrow('ruleId')}</th>
            <th className="sortable" onClick={() => sortBy('category')}>Категория{arrow('category')}</th>
            <th>Находка</th>
            <th className="sortable" onClick={() => sortBy('object')}>Объект{arrow('object')}</th>
            <th className="sortable" onClick={() => sortBy('table')}>Таблица{arrow('table')}</th>
            <th className="sortable" onClick={() => sortBy('line')}>Строка{arrow('line')}</th>
            <th>Область</th>
            <th>Рекомендация</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((f, i) => {
            const key = `${f.ruleId}-${i}`;
            const isOpen = expanded.has(key);
            const long = (f.message.length + (f.detail?.length ?? 0)) > 120;
            return (
              <tr
                key={key}
                className="clickable"
                onClick={() => { setSelected(f); if (long) setExpanded(toggle(expanded, key)); }}
              >
                <td><span className={`pill ${f.severity}`}>{SEVERITIES.find((s) => s.id === f.severity)?.label ?? f.severity}</span></td>
                <td><code>{f.ruleId}</code></td>
                <td>{f.category}</td>
                <td>
                  <b>{f.title}</b>
                  {f.count && f.count > 1 && <span className="pill count">×{f.count}</span>}
                  <div className="muted">
                    {isOpen || !long ? f.message : `${f.message.slice(0, 90)}…`}
                  </div>
                  {isOpen && f.detail && <div className="muted small">{f.detail}</div>}
                  {isOpen && f.tables && f.tables.length > 1 && (
                    <div className="muted small">Таблицы: {f.tables.join(', ')}</div>
                  )}
                  {isOpen && (
                    <button
                      className="link"
                      onClick={(e) => { e.stopPropagation(); suppressFinding(f); }}
                    >
                      подавить это правило
                    </button>
                  )}
                </td>
                <td>{f.target?.name ?? '—'}</td>
                <td>{f.table ?? (f.target?.kind === 'table' ? f.target.name : '—')}</td>
                <td>
                  {f.lines?.length
                    ? f.lines.join(', ')
                    : (f.line ?? '—')}
                  {f.lines?.length && f.linesTotal && f.linesTotal > f.lines.length
                    && <span className="muted small"> (из {f.linesTotal})</span>}
                </td>
                <td>{SCOPE_LABELS[f.scope ?? 'dashboard'] ?? '—'}</td>
                <td className="muted">{f.recommendation}</td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr><td colSpan={9} className="muted">Ничего не найдено под текущими фильтрами.</td></tr>
          )}
        </tbody>
      </table>


      {/* --- Поиск по выражению --- */}
      <h3>Поиск по выражению</h3>
      <div className="toolbar">
        <input
          className="search"
          value={exprQuery}
          onChange={(e) => setExprQuery(e.target.value)}
          placeholder="Найти выражение в объектах и в скрипте…"
          aria-label="Поиск по выражению"
        />
        <span className="muted">
          {exprQuery.trim() ? `найдено: ${exprHits.total}` : 'введите часть выражения'}
        </span>
      </div>
      {exprQuery.trim() && exprHits.total > 0 && (
        <table className="rules">
          <thead><tr><th>Где</th><th>Объект / строка</th><th>Выражение</th></tr></thead>
          <tbody>
            {exprHits.objects.map((h, i) => (
              <tr key={`o-${i}`}>
                <td>{h.kind === 'measure' ? 'мера' : 'измерение'}</td>
                <td>{h.name}</td>
                <td><code>{h.expr}</code></td>
              </tr>
            ))}
            {exprHits.script.slice(0, 50).map((h) => (
              <tr key={`s-${h.line}`}>
                <td>скрипт</td>
                <td>строка {h.line}</td>
                <td><code>{h.text.trim()}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* --- Ошибки скрипта по данным сервера --- */}
      {analysis.scriptErrors && analysis.scriptErrors.length > 0 && (
        <>
          <h3>Ошибки скрипта загрузки</h3>
          <p className="muted small">
            Сервер проверил скрипт и указал места ошибок. Нажмите на строку — откроется скрипт.
          </p>
          <table className="rules">
            <thead><tr><th>Строка</th><th>Колонка</th><th>Сообщение</th></tr></thead>
            <tbody>
              {analysis.scriptErrors.map((e, i) => (
                <tr
                  key={`${e.line}-${i}`}
                  className={e.line ? 'link-row' : ''}
                  onClick={() => {
                    if (!e.line) return;
                    setSelected({
                      ruleId: 'S014', category: 'Script', severity: 'error',
                      title: 'Ошибка в скрипте загрузки',
                      message: e.message, recommendation: 'Исправить скрипт и перезагрузить приложение.',
                      detail: e.column ? `Колонка ${e.column}` : undefined,
                      line: e.line,
                    });
                  }}
                >
                  <td>{e.line ?? '—'}</td>
                  <td>{e.column ?? '—'}</td>
                  <td>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* --- Структура скрипта загрузки --- */}
      {outline && outline.sections.length > 0 && (
        <>
          <h2>Структура скрипта загрузки</h2>
          <p className="muted small">
            Разделы: {outline.sections.length} · шагов построения таблиц: {outline.steps.length}
            {outline.unreachable.length > 0 ? ` · недостижимых операторов: ${outline.unreachable.length}` : ''}
          </p>
          {outline.sections.map((s) => (
            <div key={`${s.name}-${s.line}`} className="muted small">
              <b>{s.name}</b>
              {s.tables.length > 0 && <> — таблицы: {s.tables.join(', ')}</>}
              {s.subs.length > 0 && <> — подпрограммы: {s.subs.join(', ')}</>}
              {s.variables.length > 0 && <> — переменные: {s.variables.join(', ')}</>}
            </div>
          ))}
          {outline.steps.length > 0 && (
            <table className="rules">
              <thead>
                <tr><th>Таблица</th><th>Действие</th><th>Строка</th></tr>
              </thead>
              <tbody>
                {outline.steps.map((st, i) => (
                  <tr key={`${st.table}-${st.line}-${i}`}>
                    <td>{st.table}</td>
                    <td>{st.text}</td>
                    <td>{st.line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {outline.unreachable.length > 0 && (
            <div className="muted small">
              Недостижимый код после EXIT SCRIPT:
              {outline.unreachable.map((u) => (
                <div key={`${u.line}-${u.raw}`}>строка {u.line}: {u.raw}</div>
              ))}
            </div>
          )}
        </>
      )}

      {/* --- Предлагаемые правки --- */}
      {fixes.length > 0 && (
        <>
          <h3>
            Предлагаемые правки скрипта
            <button
              className="link"
              onClick={() => setFixesOpen((v) => !v)}
              aria-expanded={fixesOpen}
            >
              {' '}· {fixesOpen ? 'свернуть' : `развернуть (${fixes.length})`}
            </button>
          </h3>
          {fixesOpen && fixes.map((fix, i) => (
            <div className="fix" key={`${fix.ruleId}-${i}`}>
              <h4>
                {fix.title} <code>{fix.ruleId}</code>
              </h4>
              {fix.count > 1 && (
                <p className="muted small">
                  Затронуто объектов: {fix.count} ({fix.objects?.join(', ') ?? '—'})
                </p>
              )}
              {fix.line != null && (
                <p className="muted small">Вставка после строки {fix.line}</p>
              )}
              <div className="diff">
                <span className="before">− {fix.before || '(конец скрипта)'}</span>
                <span className="after">+ {fix.after}</span>
              </div>
              <div className="actions">
                <button
                  className="small ghost"
                  onClick={() => { void navigator.clipboard?.writeText(fix.statement); setNote(`Скопировано: ${fix.statement}`); }}
                >
                  Копировать
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* --- Подавленные находки --- */}
      {showSuppressed && suppressed.length > 0 && (
        <>
          <h3>Подавленные находки</h3>
          <table className="findings">
            <thead>
              <tr><th>Правило</th><th>Находка</th><th>Причина</th><th /></tr>
            </thead>
            <tbody>
              {suppressed.map((f, i) => (
                <tr key={`${f.ruleId}-sup-${i}`}>
                  <td><code>{f.ruleId}</code></td>
                  <td>{f.message}</td>
                  <td className="muted">{f.suppressReason ?? 'подавлено'}</td>
                  <td>
                    <button
                      className="link"
                      onClick={() => unsuppress(f.ruleId, f.table)}
                    >
                      вернуть
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {analysis.skipped?.map((s) => (
        <p key={s.capability} className="warn">Пропущено: {s.reason}</p>
      ))}

      {/* --- Панель паттерна: корень проблемы и его места --- */}
      <div className={`scrim${openPattern ? ' on' : ''}`} onClick={() => setOpenPattern(null)} />
      <aside className={`drawer${openPattern ? ' on' : ''}`}>
        {openPattern ? (
          <>
            <div className="dh">
              <h3>{openPattern.title}</h3>
              <div className="hint">
                <b>{openPattern.ruleId}</b> · {DOMAIN_LABELS[openPattern.domain]}
              </div>
              <div style={{ marginTop: 8 }}>
                <span className={`pill ${severityClass(openPattern.severity)}`}>
                  {severityLabel(openPattern.severity)}
                </span>
                <span className="pill mute" style={{ marginLeft: 6 }}>
                  {openPattern.count} мест
                </span>
              </div>
            </div>
            <div className="db">
              <div className="hint" style={{ marginBottom: 6 }}>Выражение</div>
              <div className="code">{openPattern.expression || openPattern.message}</div>
              <div className="hint" style={{ margin: '14px 0 6px' }}>
                Где встречается ({openPattern.places.length} из {openPattern.count})
              </div>
              <table className="rq">
                <thead>
                  <tr><th>Объект</th><th>Таблица</th><th>Строка</th></tr>
                </thead>
                <tbody>
                  {openPattern.places.map((place, i) => (
                    <tr key={`${place.name}-${i}`}>
                      <td>{place.name || '—'}</td>
                      <td className="hint">{place.table || '—'}</td>
                      <td className="hint">{place.line ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="hint" style={{ margin: '14px 0 6px' }}>Что делать</div>
              <p className="muted">{openPattern.recommendation}</p>
            </div>
            <div className="df">
              <button className="btn pri" onClick={() => setOpenPattern(null)}>Закрыть</button>
              {onOpenScript ? (
                <button className="btn" onClick={() => { setOpenPattern(null); onOpenScript(); }}>
                  → Скрипт загрузки
                </button>
              ) : null}
              {onOpenModel ? (
                <button className="btn" onClick={() => { setOpenPattern(null); onOpenModel(); }}>
                  → Модель данных
                </button>
              ) : null}
              <button className="btn">Настроить правило</button>
            </div>
          </>
        ) : null}
      </aside>
    </section>
  );
}
