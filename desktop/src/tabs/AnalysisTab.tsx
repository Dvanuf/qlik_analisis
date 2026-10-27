/**
 * Вкладка «Анализ» (этап 2 плана развития).
 *
 * Карточки метрик с итоговым скором, фильтры-чипы со счётчиками, таблица
 * находок с колонками «Таблица» и «Строка», просмотр скрипта с подсветкой
 * нужной строки, блок «Предлагаемые правки» (было/стало) и подавление
 * находок.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildFixes } from '../../../src/report/fixes.js';
import { searchExpressions } from '../../../src/script/search.js';
import type {
  AnalysisResult, Finding, FindingScope, RulesConfig, Severity,
} from '../types.js';

const SEVERITIES: { id: Severity; label: string }[] = [
  { id: 'error', label: 'Ошибка' },
  { id: 'warning', label: 'Предупреждение' },
  { id: 'info', label: 'Замечание' },
];

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
};

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** Первая строка скрипта, связанная с находкой (для сортировки). */
function firstLine(finding: Finding): number {
  const lines = finding.lines?.length ? finding.lines : [];
  if (lines.length) return lines[0];
  return finding.line ?? 0;
}

export default function AnalysisTab(props: Props) {
  const {
    analysis, categories, exportNote, onExport, onExportScript, onExportDataModel,
    rulesConfig, onSaveRulesConfig,
  } = props;

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

  const scriptLines = useMemo(
    () => String(analysis?.script ?? '').split(/\r?\n/),
    [analysis?.script],
  );

  /**
   * Строки скрипта, к которым относится выбранная находка.
   *
   * Их может быть несколько: поле грузится в нескольких таблицах, мера
   * ссылается на поля из разных загрузок. Показываем их все — с перечислением
   * через запятую и подсветкой каждой.
   */
  const hitLines = useMemo(() => {
    if (!selected) return new Set<number>();
    const lines = selected.lines?.length ? selected.lines : [];
    if (lines.length) return new Set(lines);
    if (selected.line != null) return new Set([selected.line]);
    return new Set<number>();
  }, [selected]);

  /** Прокрутка скрипта к первой найденной строке. */
  const scriptViewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selected || hitLines.size === 0) return;
    const first = Math.min(...hitLines);
    const node = scriptViewRef.current?.querySelector(`[data-line="${first}"]`);
    node?.scrollIntoView({ block: 'center' });
  }, [selected, hitLines]);

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

  return (
    <section className="card wide">
      <h2>
        Результаты анализа
        {analysis.appName ? ` — ${analysis.appName}` : ''}
        {analysis.file ? ` — ${analysis.file}` : ''}
      </h2>

      {/* --- Карточки метрик --- */}
      <div className="metric-group">
        <h4>Важность</h4>
        <div className="metric-grid">
          {SEVERITIES.map((s) => {
            const n = counts.bySeverity[s.id] ?? 0;
            const active = sevFilter.has(s.id);
            return (
              <button
                key={s.id}
                className={`metric ${s.id}${n === 0 ? ' zero' : ''}${active ? ' active' : ''}`}
                onClick={() => setSevFilter(toggle(sevFilter, s.id))}
                title={active ? 'Снять фильтр' : 'Отфильтровать по важности'}
              >
                <div className="n">{n}</div>
                <div className="l">{s.label}</div>
              </button>
            );
          })}
          <div
            className={`metric score ${scoreClass}`}
            title={analysis.summary.scoreDetails?.formula ?? 'Скор 0–100'}
          >
            <div className="n">{score}</div>
            <div className="l">скор приложения</div>
          </div>
        </div>
      </div>

      <div className="metric-group">
        <h4>Категории</h4>
        <div className="metric-grid">
          {categories.map((c) => {
            const n = counts.byCategory[c] ?? 0;
            const active = catFilter.has(c);
            return (
              <button
                key={c}
                className={`metric${n === 0 ? ' zero' : ''}${active ? ' active' : ''}`}
                onClick={() => setCatFilter(toggle(catFilter, c))}
                title={active ? 'Снять фильтр' : 'Отфильтровать по категории'}
              >
                <div className="n">{n}</div>
                <div className="l">{c}</div>
              </button>
            );
          })}
        </div>
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

      {/* --- Скрипт загрузки (выше находок: сюда ведёт клик по находке) --- */}
      {scriptLines.length > 0 && (
      <>
      <h3>
        Скрипт загрузки
        {selected && hitLines.size > 0 && (
          <> — строки {[...hitLines].sort((a, b) => a - b).join(', ')}</>
        )}
        {selected && <button className="link" onClick={() => setSelected(null)}> закрыть</button>}
      </h3>
      {!selected && (
        <p className="muted small">
          Нажмите на находку в таблице ниже — здесь подсветятся связанные с ней строки скрипта.
        </p>
      )}
      {selected && hitLines.size === 0 && (
        <p className="muted small">
          Для этой находки нельзя указать строку: она относится к приложению в целом.
        </p>
      )}
      {selected && hitLines.size > 0 && selected.detail && (
        <p className="muted small">{selected.detail}</p>
      )}
      <div className="script-view" ref={scriptViewRef}>
        {scriptLines.map((line, i) => (
          <div
            key={i}
            data-line={i + 1}
            className={`line${hitLines.has(i + 1) ? ' hit' : ''}`}
          >
            <span className="no">{i + 1}</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
      </>
      )}

      {/* --- Находки --- */}
      <h3>Находки</h3>
      <div className="toolbar">
        <button
          className={sevFilter.size === 0 ? 'active' : ''}
          onClick={() => setSevFilter(new Set())}
        >
          Все важности <span className="n">{findings.length}</span>
        </button>
        {SEVERITIES.map((s) => (
          <button
            key={s.id}
            className={`chip${sevFilter.has(s.id) ? ' active' : ''}`}
            onClick={() => setSevFilter(toggle(sevFilter, s.id))}
          >
            {s.label} <span className="n">{counts.bySeverity[s.id] ?? 0}</span>
          </button>
        ))}
        <span className="sep" />
        <button
          className={catFilter.size === 0 ? 'active' : ''}
          onClick={() => setCatFilter(new Set())}
        >
          Все категории
        </button>
        {categories.map((c) => (
          <button
            key={c}
            className={`chip${catFilter.has(c) ? ' active' : ''}`}
            onClick={() => setCatFilter(toggle(catFilter, c))}
          >
            {c} <span className="n">{counts.byCategory[c] ?? 0}</span>
          </button>
        ))}
        <span className="sep" />
        <button
          className={scopeFilter.size === 0 ? 'active' : ''}
          onClick={() => setScopeFilter(new Set())}
        >
          Все области
        </button>
        {SCOPES.map((sc) => (
          <button
            key={sc.id}
            className={`chip${scopeFilter.has(sc.id) ? ' active' : ''}`}
            onClick={() => setScopeFilter(toggle(scopeFilter, sc.id))}
            title={`Находки в области «${sc.label}»`}
          >
            {sc.label} <span className="n">{counts.byScope[sc.id] ?? 0}</span>
          </button>
        ))}
        <input
          className="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по находкам…"
        />
        <label className="muted small">
          <input
            type="checkbox"
            checked={showSuppressed}
            onChange={(e) => setShowSuppressed(e.target.checked)}
          />
          {' '}показать подавленные ({suppressed.length})
        </label>
        <span className="muted">показано {filtered.length} из {findings.length}</span>
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
    </section>
  );
}
