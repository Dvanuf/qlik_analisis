/**
 * Вкладка «Сводный отчёт» (этап 4 плана развития).
 *
 * Тепловая карта «приложения × категории», топ-10 самых частых правил,
 * таблица приложений со скором и количеством находок, история прогонов
 * в локальной базе с сравнением по базовой линии и выгрузка в CSV/Excel.
 */
import { useMemo, useState } from 'react';
import { buildHeatmap, topRules, summaryRows } from '../../../src/report/heatmap.js';
import type { BatchItem, BatchTotals, Comparison, HistoryRun } from '../types.js';

type Props = {
  batch: { results: BatchItem[]; totals: BatchTotals } | null;
  exportNote: string;
  onExport: () => void;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  history: HistoryRun[];
  comparison: Comparison | null;
  onlyNew: boolean;
  onOnlyNew: (value: boolean) => void;
  onSaveHistory: () => void;
  onCompare: (baselineId: number) => void;
  onLoadHistory: () => void;
};

export default function SummaryTab(props: Props) {
  const {
    batch, exportNote, onExport, onExportCsv, onExportXlsx,
    history, comparison, onlyNew, onOnlyNew, onSaveHistory, onCompare, onLoadHistory,
  } = props;

  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [streamFilter, setStreamFilter] = useState('all');
  const [sevFilter, setSevFilter] = useState('all');

  const results = batch?.results ?? [];
  const heatmap = useMemo(() => buildHeatmap(results), [results]);
  const top = useMemo(() => topRules(results, 10), [results]);
  const rows = useMemo(() => summaryRows(results), [results]);

  const owners = useMemo(() => [...new Set(rows.map((r) => r.owner ?? 'не указан'))].sort(), [rows]);
  const streams = useMemo(() => [...new Set(rows.map((r) => r.stream ?? 'не указан'))].sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (ownerFilter !== 'all' && (r.owner ?? 'не указан') !== ownerFilter) return false;
      if (streamFilter !== 'all' && (r.stream ?? 'не указан') !== streamFilter) return false;
      if (sevFilter === 'error' && r.errors === 0) return false;
      if (sevFilter === 'warning' && r.warnings === 0) return false;
      if (sevFilter === 'info' && r.infos === 0) return false;
      if (q) {
        const hay = `${r.title} ${r.appId} ${r.owner ?? ''} ${r.stream ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, ownerFilter, streamFilter, sevFilter, search]);

  /** Уровень заливки ячейки тепловой карты: 0 — пусто, 4 — максимум. */
  const heatLevel = (value: number) => {
    if (!value) return 0;
    const ratio = heatmap.max ? value / heatmap.max : 0;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };

  if (!batch) {
    return (
      <section className="card wide">
        <h2>Сводный отчёт по всем приложениям</h2>
        <p className="muted">
          Сводный анализ ещё не запускался. Откройте вкладку «Подключение» и нажмите
          «Анализировать все».
        </p>
      </section>
    );
  }

  const totals = batch.totals;

  return (
    <section className="card wide">
      <h2>Сводный отчёт по всем приложениям</h2>

      <div className="cards">
        <div className="metric"><div className="n">{totals.apps}</div><div className="l">приложений</div></div>
        <div className="metric"><div className="n">{totals.findings}</div><div className="l">находок всего</div></div>
        <div className="metric error"><div className="n">{totals.bySeverity.error ?? 0}</div><div className="l">ошибок</div></div>
        <div className="metric warning"><div className="n">{totals.bySeverity.warning ?? 0}</div><div className="l">предупреждений</div></div>
        <div className="metric info"><div className="n">{totals.bySeverity.info ?? 0}</div><div className="l">замечаний</div></div>
        <div className="metric">
          <div className="n">{totals.removableRows.toLocaleString('ru-RU')}</div>
          <div className="l">строк можно убрать</div>
        </div>
        <div className="metric"><div className="n">{totals.errors}</div><div className="l">приложений с ошибкой</div></div>
      </div>

      <div className="actions">
        <button className="primary" onClick={onExport}>Экспорт сводного отчёта (HTML + JSON)</button>
        <button onClick={onExportCsv}>Экспорт в CSV</button>
        <button onClick={onExportXlsx}>Экспорт в Excel</button>
        <button onClick={onSaveHistory}>Сохранить в историю</button>
        <button onClick={onLoadHistory}>Обновить историю</button>
      </div>
      {exportNote && <p className="muted small">{exportNote}</p>}

      {/* --- Тепловая карта --- */}
      <h3>Тепловая карта: приложения × категории</h3>
      <table className="heatmap">
        <thead>
          <tr>
            <th>Приложение</th>
            {heatmap.categories.map((c) => <th key={c}>{c}</th>)}
            <th>Всего</th>
          </tr>
        </thead>
        <tbody>
          {heatmap.apps.slice(0, 40).map((a) => (
            <tr key={a.appId}>
              <td title={a.title}>{a.error ? <span className="err">{a.title} — {a.error}</span> : a.title}</td>
              {heatmap.categories.map((c) => (
                <td key={c} className={`heat-${heatLevel(a.cells[c] ?? 0)}`}>{a.cells[c] ?? 0}</td>
              ))}
              <td><b>{a.total}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      {heatmap.apps.length > 40 && (
        <p className="muted small">Показаны первые 40 приложений из {heatmap.apps.length}.</p>
      )}

      {/* --- Топ правил --- */}
      <h3>Топ-10 самых частых правил</h3>
      <ul className="top-rules">
        {top.map((r) => (
          <li key={r.ruleId}>
            <code>{r.ruleId}</code>
            <span className="bar">
              <div style={{ width: `${top[0]?.count ? Math.round((r.count / top[0].count) * 100) : 0}%` }} />
            </span>
            <span className="n">{r.count}</span>
            <span className="muted small">в {r.apps} прил.</span>
          </li>
        ))}
        {top.length === 0 && <li className="muted">Находок нет</li>}
      </ul>

      {/* --- Таблица приложений --- */}
      <h3>Приложения</h3>
      <div className="toolbar">
        <button className={sevFilter === 'all' ? 'active' : ''} onClick={() => setSevFilter('all')}>Все</button>
        <button className={sevFilter === 'error' ? 'active' : ''} onClick={() => setSevFilter('error')}>С ошибками</button>
        <button className={sevFilter === 'warning' ? 'active' : ''} onClick={() => setSevFilter('warning')}>С предупреждениями</button>
        <button className={sevFilter === 'info' ? 'active' : ''} onClick={() => setSevFilter('info')}>С замечаниями</button>
        <span className="sep" />
        <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} aria-label="Фильтр по владельцу">
          <option value="all">владелец: все</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={streamFilter} onChange={(e) => setStreamFilter(e.target.value)} aria-label="Фильтр по потоку">
          <option value="all">поток: все</option>
          {streams.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          className="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по названию приложения…"
        />
        <span className="muted">показано {filtered.length} из {rows.length}</span>
      </div>

      <table className="batchTable">
        <thead>
          <tr>
            <th>Приложение</th><th>Скор</th><th>Ошибок</th><th>Предупр.</th><th>Замечаний</th>
            <th>Всего</th><th>Владелец</th><th>Поток</th><th>Дата изменения</th><th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.appId}>
              <td>{r.title}</td>
              <td>{r.score ?? '—'}</td>
              <td>{r.errors}</td>
              <td>{r.warnings}</td>
              <td>{r.infos}</td>
              <td>{r.total}</td>
              <td>{r.owner ?? 'не указан'}</td>
              <td>{r.stream ?? 'не указан'}</td>
              <td>{r.changedAt ? new Date(r.changedAt).toLocaleString('ru-RU') : '—'}</td>
              <td>{r.error ? <span className="err">{r.error}</span> : 'ок'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* --- История --- */}
      <h3>История прогонов</h3>
      <div className="toolbar">
        <label className="muted small">
          <input type="checkbox" checked={onlyNew} onChange={(e) => onOnlyNew(e.target.checked)} />
          {' '}показывать только новые находки относительно базовой линии
        </label>
        <span className="muted">прогонов в базе: {history.length}</span>
      </div>

      {history.length > 0 && (
        <table className="batchTable">
          <thead>
            <tr><th>Дата</th><th>Приложение</th><th>Скор</th><th>Находок</th><th>Версия правил</th><th /></tr>
          </thead>
          <tbody>
            {history.slice(0, 20).map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.at).toLocaleString('ru-RU')}</td>
                <td>{h.appName || h.appId}</td>
                <td>{h.score}</td>
                <td>{h.total}</td>
                <td>{h.rulesVersion}</td>
                <td><button className="link" onClick={() => onCompare(h.id)}>сравнить</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {comparison && (
        <>
          <h3>Сравнение с базовой линией</h3>
          <div className="cards">
            <div className="metric error"><div className="n">{comparison.counts.added}</div><div className="l">новых</div></div>
            <div className="metric info"><div className="n">{comparison.counts.fixed}</div><div className="l">исправлено</div></div>
            <div className="metric"><div className="n">{comparison.counts.unchanged}</div><div className="l">без изменений</div></div>
          </div>
          <table className="batchTable">
            <thead><tr><th>Правило</th><th>Находка</th><th>Состояние</th></tr></thead>
            <tbody>
              {comparison.added.map((f, i) => (
                <tr key={`a-${i}`}><td><code>{f.ruleId}</code></td><td>{f.message}</td><td className="err">новая</td></tr>
              ))}
              {comparison.fixed.map((f, i) => (
                <tr key={`f-${i}`}><td><code>{f.ruleId}</code></td><td>{f.message}</td><td className="ok">исправлена</td></tr>
              ))}
              {comparison.unchanged.map((f, i) => (
                <tr key={`u-${i}`}><td><code>{f.ruleId}</code></td><td>{f.message}</td><td className="muted">без изменений</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
