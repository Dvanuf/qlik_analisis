/**
 * Вкладка «Модель данных».
 *
 * Показывает модель данных приложения: таблицы, поля, объекты, переменные,
 * измерения и меры. Те же данные, что уходят в Excel-лист «Модель данных»,
 * но прямо в интерфейсе — с поиском и переходом по разделам.
 */
import { useMemo, useState } from 'react';
import type { AnalysisResult } from '../types.js';

type Props = {
  analysis: AnalysisResult | null;
  exportNote: string;
  onExport: () => void;
};

type Sheet = { name: string; headers: string[]; rows: (string | number)[][] };

export default function ModelTab(props: Props) {
  const { analysis, exportNote, onExport } = props;

  const [active, setActive] = useState<string>('');
  const [search, setSearch] = useState('');

  const sheets: Sheet[] = analysis?.dataModel ?? [];

  /** Активный лист: по умолчанию — первый. */
  const current = useMemo(() => {
    if (!sheets.length) return null;
    return sheets.find((s) => s.name === active) ?? sheets[0];
  }, [sheets, active]);

  /** Строки, отфильтрованные поиском. */
  const rows = useMemo(() => {
    if (!current) return [];
    const q = search.trim().toLowerCase();
    if (!q) return current.rows;
    return current.rows.filter((row) => row.some((cell) => String(cell ?? '').toLowerCase().includes(q)));
  }, [current, search]);

  if (!analysis || !sheets.length) {
    return (
      <section className="card wide">
        <h2>Модель данных</h2>
        <p className="muted">
          Модель данных появится после анализа приложения. Откройте вкладку «Подключение»
          и запустите анализ — здесь будут таблицы, поля, объекты и меры.
        </p>
      </section>
    );
  }

  return (
    <section className="card wide">
      <h2>
        Модель данных
        {analysis.appName ? ` — ${analysis.appName}` : ''}
      </h2>
      <p className="muted small">
        Таблиц: {analysis.summary.counts.tables ?? 0} · полей: {analysis.summary.counts.fields ?? 0}
        {' · '}объектов: {analysis.summary.counts.objects ?? 0}
        {' · '}переменных: {analysis.summary.counts.variables ?? 0}
      </p>

      <div className="actions">
        <button className="primary" onClick={onExport}>Экспорт модели данных (Excel)</button>
      </div>
      {exportNote && <p className="muted small">{exportNote}</p>}

      <div className="toolbar">
        {sheets.map((s) => (
          <button
            key={s.name}
            className={`chip${current?.name === s.name ? ' active' : ''}`}
            onClick={() => setActive(s.name)}
          >
            {s.name} <span className="n">{s.rows.length}</span>
          </button>
        ))}
        <input
          className="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по разделу модели данных…"
          aria-label="Поиск по модели данных"
        />
        <span className="muted">
          {current ? `показано ${rows.length} из ${current.rows.length}` : ''}
        </span>
      </div>

      {current && (
        <table className="rules">
          <thead>
            <tr>{current.headers.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${current.name}-${i}`}>
                {row.map((cell, j) => (
                  <td key={`${current.name}-${i}-${j}`}>{String(cell ?? '')}</td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, current.headers.length)} className="muted">
                  Ничего не найдено по запросу.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
