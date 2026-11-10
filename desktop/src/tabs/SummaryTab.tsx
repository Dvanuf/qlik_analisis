/**
 * Вкладка «Сводный отчёт» — аналитика группы приложений (этап 5 ТЗ «Оценка»).
 *
 * Источник данных: последний пакетный прогон и история в SQLite. Все цифры
 * — из aggregateGroup ядра (единый источник для вкладки, экспортов и PDF).
 * Композиция — по утверждённому макету: фильтры → вывод → шесть показателей →
 * зоны и изменения → динамика → тепловая карта «приложение × домен» →
 * главные проблемы группы → потоки и лишние данные → «что делать группе».
 * История прогонов и сравнение с базовой линией — свёрнутый блок внизу.
 */
import { useEffect, useMemo, useState } from 'react';
import { aggregateGroup } from '../../../src/score/index.js';
import { v2Info } from '../v2fallback.js';
import { DOMAIN_ORDER, DOMAIN_LABELS } from '../../../src/rules/domains.js';
import type { BatchItem, BatchTotals, Comparison, DomainId, HistoryRun } from '../types.js';

const DL = DOMAIN_LABELS as Record<string, string>;

type Props = {
  batch: { results: BatchItem[]; totals: BatchTotals } | null;
  /** Сколько приложений на сервере (для показателя «проверено из …»). */
  appsCount: number;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  onPrintReport: (html: string) => void;
  history: HistoryRun[];
  comparison: Comparison | null;
  onlyNew: boolean;
  onOnlyNew: (value: boolean) => void;
  onSaveHistory: () => void;
  onCompare: (baselineId: number) => void;
  onLoadHistory: () => void;
  /** Детальный анализ приложения из любого блока. */
  onAnalyzeApp: (appId: string) => void;
};

/** Зона по баллу: pill-класс и подпись. */
function zoneOf(score: number): 'r' | 'y' | 'g' {
  return score < 50 ? 'r' : score < 75 ? 'y' : 'g';
}

export default function SummaryTab(props: Props) {
  const {
    batch, appsCount, onExportCsv, onExportXlsx, onPrintReport,
    history, comparison, onlyNew, onOnlyNew, onSaveHistory, onCompare, onLoadHistory,
    onAnalyzeApp,
  } = props;

  // --- Фильтры (действуют на все блоки ниже) ---
  const [period, setPeriod] = useState(30);
  const [streamF, setStreamF] = useState('all');
  const [ownerF, setOwnerF] = useState('all');
  const [tagF, setTagF] = useState('all');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const results = batch?.results ?? [];

  /** Списки значений фильтров — по всему прогону. */
  const options = useMemo(() => {
    const uniq = (vals: (string | null | undefined)[]) =>
      [...new Set(vals.map((v) => String(v ?? '').trim()).filter(Boolean))].sort();
    return {
      streams: uniq(results.map((r) => r.stream)),
      owners: uniq(results.map((r) => r.owner)),
      tags: uniq(results.flatMap((r) => r.tags ?? [])),
    };
  }, [results]);

  /** Приложения после фильтров — вход для всех блоков. */
  const filtered = useMemo(() => results.filter((r) => {
    if (r.error || !r.summary) return false;
    if (streamF !== 'all' && (r.stream ?? '') !== streamF) return false;
    if (ownerF !== 'all' && (r.owner ?? '') !== ownerF) return false;
    if (tagF !== 'all' && !(r.tags ?? []).includes(tagF)) return false;
    if (errorsOnly && !(r.summary?.findings?.bySeverity?.error > 0)) return false;
    return true;
  }), [results, streamF, ownerF, tagF, errorsOnly]);

  // --- Единый источник цифр (ядро aggregateGroup) ---
  const group = useMemo(
    () => aggregateGroup(filtered) as {
      apps: number; avg: number | null; median: number | null;
      zones: { critical: number; attention: number; good: number };
      weakestDomain: string | null; scoreVersion: number | null;
      topIssues: { ruleId: string; title: string; severity: string; domain: string | null;
        places: number; apps: number; gainAvg: number }[];
      byStream: { stream: string; apps: number; avg: number; errors: number; weakestDomain: string | null }[];
      wastedRating: { appId: string; title: string; rows: number }[];
    },
    [filtered],
  );

  /** История v2 — динамика, изменения, тренды (загружается сверху). */
  const [allRuns, setAllRuns] = useState<HistoryRun[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const runs = await window.qa.historyList({ limit: 500 });
        if (alive) setAllRuns(runs);
      } catch { /* без истории блоки динамики скрываются */ }
    })();
    return () => { alive = false; };
  }, [history]);

  /** Динамика по датам: средняя оценка группы и число красных приложений. */
  const dynamics = useMemo(() => {
    const byDate = new Map<string, { sum: number; n: number; red: number; ts: number }>();
    for (const r of allRuns.filter((r) => (r.scoreVersion ?? 1) === 2)) {
      const d = new Date(r.at);
      if (period > 0 && Date.now() - d.getTime() > period * 86400000) continue;
      const key = d.toLocaleDateString('ru-RU');
      const entry = byDate.get(key) ?? { sum: 0, n: 0, red: 0, ts: d.getTime() };
      entry.sum += r.score;
      entry.n += 1;
      if (r.score < 50) entry.red += 1;
      entry.ts = Math.max(entry.ts, d.getTime());
      byDate.set(key, entry);
    }
    return [...byDate.entries()]
      .map(([date, e]) => ({ date, avg: Math.round(e.sum / e.n), red: e.red, ts: e.ts }))
      .sort((a, b) => a.ts - b.ts)
      .slice(-8);
  }, [allRuns, period]);

  /** Изменение за период: средняя последней даты минус средняя первой. */
  const monthChange = dynamics.length >= 2
    ? dynamics[dynamics.length - 1].avg - dynamics[0].avg
    : null;

  /** Приложения, где оценка упала (последние два прогона v2). */
  const worsened = useMemo(() => {
    const byApp = new Map<string, HistoryRun[]>();
    for (const r of allRuns.filter((r) => (r.scoreVersion ?? 1) === 2)) {
      const arr = byApp.get(r.appId) ?? [];
      arr.push(r);
      byApp.set(r.appId, arr);
    }
    const out: { name: string; diff: number }[] = [];
    for (const [, runs] of byApp) {
      if (runs.length < 2) continue;
      const diff = runs[0].score - runs[1].score;
      if (diff < 0) out.push({ name: runs[0].appName || runs[0].appId, diff });
    }
    return out.sort((a, b) => a.diff - b.diff).slice(0, 3);
  }, [allRuns]);

  /** Прогноз «если исправить пять главных проблем» — по приростам средней. */
  const topFiveGain = useMemo(
    () => group.topIssues.slice(0, 5).reduce((s, t) => s + t.gainAvg, 0),
    [group.topIssues],
  );

  /** Приложение, где проблема встречается (для кнопки «Открыть»). */
  const appWithIssue = (ruleId: string, title: string) =>
    filtered.find((r) => (r.findings ?? []).some((f) => f.ruleId === ruleId && f.title === title))?.appId;

  const totals = batch?.totals;
  const canReduceRows = totals?.removableRows ?? 0;
  const canReduceShare = filtered.length
    ? Math.round((filtered.filter((r) => (r.summary?.savings?.removableRows ?? 0) > 0).length / filtered.length) * 100)
    : 0;

  if (!batch || results.length === 0) {
    return (
      <section className="card wide">
        <h2>Сводный отчёт</h2>
        <p className="muted">
          Аналитика группы появится после пакетного анализа. Откройте вкладку
          «Подключение» и нажмите «Анализировать все».
        </p>
      </section>
    );
  }

  /** «Отчёт для руководителя» из сводного отчёта: блоки 2–4, 7, 8 макета. */
  const printReport = () => {
    const doms = DOMAIN_ORDER
      .filter((id) => filtered.some((r) => r.summary?.domains?.[id]))
      .map((id) => {
        const scores = filtered.map((r) => r.summary?.domains?.[id]?.score).filter((v): v is number => v != null);
        const avg = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : '—';
        return `<tr><td>${DL[id]}</td><td><b>${avg}</b></td></tr>`;
      })
      .join('');
    const tops = group.topIssues.slice(0, 5)
      .map((t) => `<li>${t.title} — в ${t.apps} прил., +${t.gainAvg} к средней</li>`)
      .join('');
    const reds = filtered.filter((r) => (r.summary?.score ?? 100) < 50)
      .map((r) => `<li>${r.title} — ${r.summary?.score}</li>`)
      .join('');
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><style>
      body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d2420;margin:32px}
      h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px}
      table{border-collapse:collapse;width:100%}td{padding:4px 8px;border-bottom:1px solid #ddd}
      .muted{color:#5b6660}ol,ul{margin:4px 0;padding-left:20px}
    </style></head><body>
      <h1>Сводный отчёт по группе</h1>
      <div class="muted">${new Date().toLocaleDateString('ru-RU')} · приложений: ${group.apps}</div>
      <div class="score" style="font-size:36px;font-weight:700">${group.avg ?? '—'}<span style="font-size:15px;font-weight:400"> — средняя оценка группы</span></div>
      <p>В красной зоне: ${group.zones.critical} из ${group.apps}. Слабейший домен: ${group.weakestDomain ? DL[group.weakestDomain] : '—'}.
      ${topFiveGain > 0 ? `Если исправить пять главных проблем, средняя вырастет до ${Math.min(100, (group.avg ?? 0) + topFiveGain)}.` : ''}</p>
      ${tops ? `<h2>Главные проблемы группы</h2><ol>${tops}</ol>` : ''}
      <h2>Домены группы (средняя)</h2><table>${doms}</table>
      ${reds ? `<h2>Приложения в красной зоне</h2><ul>${reds}</ul>` : ''}
    </body></html>`;
    onPrintReport(html);
  };

  /** Подробный Excel группы: показатели, приложения, домены, проблемы, потоки. */
  const exportExcel = async () => {
    try {
      await window.qa.exportDataModel({
        fileName: 'Сводный отчёт группы',
        sheets: [
          {
            name: 'Показатели',
            headers: ['Показатель', 'Значение'],
            rows: [
              ['Проверено приложений', `${group.apps} из ${appsCount}`],
              ['Средняя оценка', group.avg ?? '—'],
              ['Медиана', group.median ?? '—'],
              ['В красной зоне', `${group.zones.critical} из ${group.apps}`],
              ['Ошибок / предупреждений', `${totals?.bySeverity.error ?? 0} / ${totals?.bySeverity.warning ?? 0}`],
              ['Строк можно убрать', canReduceRows],
              ['Изменение за период', monthChange ?? '—'],
            ],
          },
          {
            name: 'Приложения',
            headers: ['Приложение', 'Поток', 'Владелец', 'Оценка', 'Вердикт', 'Что сделать первым'],
            rows: filtered.map((r) => [
              r.title, r.stream ?? '', r.owner ?? '', r.summary?.score ?? '',
              r.summary?.verdict ?? '', r.summary?.top?.[0]?.title ?? '',
            ]),
          },
          {
            name: 'Проблемы группы',
            headers: ['Проблема', 'Домен', 'Мест', 'Приложений', 'Даст группе'],
            rows: group.topIssues.map((t) => [
              t.title, t.domain ? DL[t.domain] ?? t.domain : '', t.places, t.apps, `+${t.gainAvg}`,
            ]),
          },
          {
            name: 'Потоки',
            headers: ['Поток', 'Приложений', 'Средняя', 'Ошибок', 'Слабый домен'],
            rows: group.byStream.map((s) => [
              s.stream, s.apps, s.avg, s.errors, s.weakestDomain ? DL[s.weakestDomain] : '—',
            ]),
          },
        ],
      });
    } catch { /* тихо: экспорт не критичен */ }
  };

  // Средние по доменам группы — нижняя строка тепловой карты.
  const domainAvgs = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const id of DOMAIN_ORDER) {
      const arr = filtered.map((r) => v2Info(r).domains?.[id]?.score).filter((v): v is number => v != null);
      out[id] = arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    }
    return out;
  }, [filtered]);

  return (
    <section>
      <h2>Сводный отчёт</h2>

      {/* --- 1. Фильтры: действуют на все блоки ниже --- */}
      <div className="toolbar">
        <select value={period} onChange={(e) => setPeriod(Number(e.target.value))} aria-label="Период">
          <option value={30}>Последние 30 дней</option>
          <option value={90}>Последние 90 дней</option>
          <option value={3650}>За всё время</option>
        </select>
        <select value={streamF} onChange={(e) => setStreamF(e.target.value)} aria-label="Фильтр по потоку">
          <option value="all">Все потоки</option>
          {options.streams.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={ownerF} onChange={(e) => setOwnerF(e.target.value)} aria-label="Фильтр по владельцу">
          <option value="all">Все владельцы</option>
          {options.owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={tagF} onChange={(e) => setTagF(e.target.value)} aria-label="Фильтр по тэгу">
          <option value="all">Все тэги</option>
          {options.tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className={errorsOnly ? 'active' : ''} onClick={() => setErrorsOnly((v) => !v)}>
          Только с ошибками
        </button>
        <span className="grow" />
        <button className="primary" onClick={printReport}>PDF для руководителя</button>
        <button onClick={() => void exportExcel()}>Excel</button>
        <button onClick={onExportCsv}>CSV</button>
      </div>

      {/* --- 2. Вывод одной фразой --- */}
      <div className="card verdictcard">
        <b>Вывод.</b>{' '}
        {group.avg == null ? 'Данных для вывода недостаточно.' : (
          <>
            {group.zones.critical > 0
              ? `Группа в зоне внимания: средняя оценка ${group.avg}, ${group.zones.critical} из ${group.apps} приложений в красной зоне.`
              : `Группа в хорошем состоянии: средняя оценка ${group.avg}, красной зоны нет.`}
            {group.weakestDomain && ` Слабее всего «${DL[group.weakestDomain]}».`}
            {topFiveGain > 0
              ? ` Если исправить пять главных проблем, средняя вырастет с ${group.avg} до ${Math.min(100, group.avg + topFiveGain)}.`
              : ''}
          </>
        )}
      </div>

      {/* --- 3. Шесть показателей --- */}
      <div className="cards">
        <div className="metric"><div className="n">{group.apps} <span className="muted small">из {appsCount}</span></div><div className="l">проверено приложений</div></div>
        <div className="metric"><div className="n">{group.avg ?? '—'} <span className="muted small">/ {group.median ?? '—'}</span></div><div className="l">средняя / медиана</div></div>
        <div className="metric error"><div className="n">{group.zones.critical} <span className="muted small">из {group.apps}</span></div><div className="l">в красной зоне</div></div>
        <div className="metric"><div className="n">{totals?.bySeverity.error ?? 0} / {totals?.bySeverity.warning ?? 0}</div><div className="l">ошибок / предупреждений</div></div>
        <div className="metric"><div className="n">{canReduceShare}%</div><div className="l">{`можно сократить · ${canReduceRows.toLocaleString('ru-RU')} строк`}</div></div>
        <div className="metric"><div className="n">{monthChange == null ? '—' : monthChange > 0 ? `+${monthChange}` : monthChange}</div><div className="l">изменение за период</div></div>
      </div>

      <div className="cols">
        {/* --- 4. Распределение по зонам --- */}
        <div className="card">
          <h3>Распределение по зонам</h3>
          {group.apps === 0 ? (
            <p className="muted">Нет приложений после фильтров.</p>
          ) : (
            <>
              <div className="zoneline">
                {group.zones.critical > 0 && <div className="zr" style={{ flex: group.zones.critical }}>{group.zones.critical}</div>}
                {group.zones.attention > 0 && <div className="zy" style={{ flex: group.zones.attention }}>{group.zones.attention}</div>}
                {group.zones.good > 0 && <div className="zg" style={{ flex: group.zones.good }}>{group.zones.good}</div>}
              </div>
              <div className="muted small zonelegend">
                <span>Критично и слабо: {group.zones.critical}</span>
                <span>Требует внимания: {group.zones.attention}</span>
                <span>Хорошо: {group.zones.good}</span>
              </div>
            </>
          )}

          {/* --- Что изменилось с прошлой проверки --- */}
          <h3>Что изменилось с прошлой проверки</h3>
          {comparison ? (
            <>
              <div className="zoneline">
                <div className="zg" style={{ flex: Math.max(1, comparison.counts.fixed) }}>{comparison.counts.fixed}</div>
                <div className="zn" style={{ flex: Math.max(1, comparison.counts.unchanged) }}>{comparison.counts.unchanged}</div>
                <div className="zr" style={{ flex: Math.max(1, comparison.counts.added) }}>{comparison.counts.added}</div>
              </div>
              <div className="muted small zonelegend">
                <span>Исправлено: {comparison.counts.fixed}</span>
                <span>Без изменений: {comparison.counts.unchanged}</span>
                <span>Новых: {comparison.counts.added}</span>
              </div>
            </>
          ) : (
            <p className="muted small">Выберите базовую линию в истории прогонов ниже — здесь появится сравнение.</p>
          )}
          {worsened.length > 0 && (
            <p className="muted small">
              {worsened.map((w) => (
                <span key={w.name} className="pill error" style={{ marginRight: 6 }}>
                  {w.name} {w.diff}
                </span>
              ))}
              <span>стало хуже с прошлого прогона</span>
            </p>
          )}
        </div>

        {/* --- 6. Динамика группы --- */}
        <div className="card">
          <h3>Динамика группы</h3>
          {dynamics.length >= 2 ? (
            <>
              <svg viewBox="0 0 300 130" width="100%" role="img" aria-label="Динамика средней оценки и числа приложений в красной зоне">
                <line x1="10" y1="100" x2="290" y2="100" stroke="var(--line)" />
                {dynamics.map((d, i) => {
                  const x = 20 + (270 / Math.max(1, dynamics.length - 1)) * i;
                  const h = Math.min(60, d.red * 12);
                  return <rect key={`b${i}`} x={x - 12} y={100 - h} width={24} height={h} fill="var(--ds)" />;
                })}
                <polyline
                  points={dynamics.map((d, i) => {
                    const x = 20 + (270 / Math.max(1, dynamics.length - 1)) * i;
                    const y = 100 - (d.avg / 100) * 70;
                    return `${x},${y}`;
                  }).join(' ')}
                  fill="none" stroke="var(--brand)" strokeWidth={2.5}
                />
                {dynamics.map((d, i) => {
                  const x = 20 + (270 / Math.max(1, dynamics.length - 1)) * i;
                  const y = 100 - (d.avg / 100) * 70;
                  return (
                    <g key={`p${i}`}>
                      <circle cx={x} cy={y} r={4} fill="var(--brand)" />
                      <text x={x} y={118} fontSize={10} fill="var(--fw)" textAnchor="middle">{d.date.slice(0, 5)}</text>
                      <text x={x} y={y - 8} fontSize={11} fill="var(--text)" textAnchor="middle">{d.avg}</text>
                    </g>
                  );
                })}
              </svg>
              <div className="muted small">
                <span style={{ color: 'var(--brand)' }}>●</span> средняя оценка · столбики — приложения в красной зоне
              </div>
            </>
          ) : (
            <p className="muted small">
              Нужно минимум два прогона одной версии формулы в выбранном периоде — сохраняйте прогоны в историю.
            </p>
          )}
        </div>
      </div>

      {/* --- 7. Тепловая карта «приложение × домен» --- */}
      <div className="card scrolltbl">
        <h3>Оценки по доменам</h3>
        <p className="muted small">
          Чем краснее ячейка, тем хуже. Клик по строке открывает анализ приложения. В нижней строке — среднее по группе.
        </p>
        <table className="heatmap" style={{ minWidth: 700 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Приложение</th><th>Оценка</th>
              {DOMAIN_ORDER.map((id) => <th key={id}>{DL[id]}</th>)}
              <th title="Появится после двух прогонов приложения одной версии формулы">Тренд</th>
            </tr>
          </thead>
          <tbody>
            {[...filtered].sort((a, b) => (a.summary?.score ?? 100) - (b.summary?.score ?? 100)).map((r) => {
              const appRuns = allRuns.filter((h) => h.appId === r.appId && (h.scoreVersion ?? 1) === 2);
              const trend = appRuns.length >= 2 ? appRuns[0].score - appRuns[1].score : null;
              return (
                <tr key={r.appId} className="clickable" onClick={() => onAnalyzeApp(r.appId)}>
                  <td style={{ textAlign: 'left' }}><b>{r.title}</b></td>
                  <td><span className={`heat ${zoneOf(r.summary?.score ?? 100)}`}>{r.summary?.score ?? '—'}</span></td>
                  {DOMAIN_ORDER.map((id) => {
                    const v = v2Info(r).domains?.[id]?.score;
                    return (
                      <td key={id}>
                        {v == null
                          ? <span className="muted">—</span>
                          : <span className={`heat ${zoneOf(v)}`}>{v}</span>}
                      </td>
                    );
                  })}
                  <td>{trend == null ? <span className="muted">—</span> : <span className={trend > 0 ? 'ok' : trend < 0 ? 'err' : 'muted'}>{trend > 0 ? `+${trend}` : trend}</span>}</td>
                </tr>
              );
            })}
            <tr>
              <td style={{ textAlign: 'left' }}><b>Среднее по группе</b></td>
              <td><span className={`heat ${group.avg == null ? 'g' : zoneOf(group.avg)}`}>{group.avg ?? '—'}</span></td>
              {DOMAIN_ORDER.map((id) => {
                const v = domainAvgs[id];
                return <td key={id}>{v == null ? <span className="muted">—</span> : <span className={`heat ${zoneOf(v)}`}>{v}</span>}</td>;
              })}
              <td>{monthChange == null ? '—' : monthChange > 0 ? `+${monthChange}` : monthChange}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* --- 8. Главные проблемы группы --- */}
      <div className="card scrolltbl">
        <h3>Главные проблемы группы</h3>
        <p className="muted small">Отсортированы по тому, сколько баллов средней оценке даст исправление.</p>
        <table className="batchTable">
          <thead>
            <tr><th>Проблема</th><th>Домен</th><th>Мест</th><th>Приложений</th><th>Даст группе</th><th /></tr>
          </thead>
          <tbody>
            {group.topIssues.map((t) => (
              <tr key={`${t.ruleId}-${t.title}`}>
                <td><b>{t.title}</b></td>
                <td className="muted">{t.domain ? DL[t.domain] ?? t.domain : '—'}</td>
                <td className="num">{t.places}</td>
                <td className="num">{t.apps}</td>
                <td><b style={{ color: 'var(--success)' }}>+{t.gainAvg}</b></td>
                <td>
                  {(() => {
                    const appId = appWithIssue(t.ruleId, t.title);
                    return appId
                      ? <button className="link" onClick={() => onAnalyzeApp(appId)}>Открыть</button>
                      : null;
                  })()}
                </td>
              </tr>
            ))}
            {group.topIssues.length === 0 && <tr><td colSpan={6} className="muted">Находок после фильтров нет</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="cols">
        {/* --- 9. По потокам --- */}
        <div className="card scrolltbl">
          <h3>По потокам</h3>
          <table className="batchTable">
            <thead><tr><th>Поток</th><th>Прил.</th><th>Оценка</th><th>Ошибок</th><th>Слабый домен</th></tr></thead>
            <tbody>
              {group.byStream.map((s) => (
                <tr key={s.stream}>
                  <td><b>{s.stream}</b></td>
                  <td>{s.apps}</td>
                  <td><span className={`pill ${zoneOf(s.avg)}`}>{s.avg}</span></td>
                  <td>{s.errors}</td>
                  <td className="muted">{s.weakestDomain ? DL[s.weakestDomain] : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* --- 10. Лишние данные --- */}
        <div className="card">
          <h3>Где больше всего лишних данных</h3>
          {group.wastedRating.length === 0 && <p className="muted small">Приложений с измеримым излишком нет.</p>}
          {group.wastedRating.map((w, i) => (
            <div key={w.appId} style={{ marginBottom: 10 }}>
              <p style={{ margin: '0 0 4px' }}>{w.title} <b style={{ float: 'right' }}>{w.rows.toLocaleString('ru-RU')}</b></p>
              <div className="pbar"><i className="y" style={{ width: `${Math.round((w.rows / Math.max(1, group.wastedRating[0].rows)) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      </div>

      {/* --- 11. Что делать группе --- */}
      <div className="card">
        <h3>Что делать группе</h3>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {group.topIssues.slice(0, 2).map((t, i) => (
            <li key={`${t.ruleId}-${i}`}>
              Исправить «{t.title}» ({t.apps} прил.): <b>+{t.gainAvg}</b> к средней оценке.
            </li>
          ))}
          {group.wastedRating[0] && (
            <li>Удалить лишние данные в «{group.wastedRating[0].title}»: около {group.wastedRating[0].rows.toLocaleString('ru-RU')} строк.</li>
          )}
          {monthChange != null && (
            <li>Повторить проверку через неделю и сравнить: тренд сейчас {monthChange >= 0 ? 'положительный' : 'отрицательный'}.</li>
          )}
        </ol>
      </div>

      {/* --- История прогонов и базовая линия (свернуто) --- */}
      <div className="card">
        <h3>История прогонов</h3>
        <div className="toolbar">
          <label className="muted small">
            <input type="checkbox" checked={onlyNew} onChange={(e) => onOnlyNew(e.target.checked)} />
            {' '}показывать только новые находки относительно базовой линии
          </label>
          <span className="muted">прогонов в базе: {history.length}</span>
          <span className="grow" />
          <button className="small" onClick={onSaveHistory}>Сохранить текущий прогон</button>
          <button className="small" onClick={onLoadHistory}>Обновить</button>
        </div>
        {history.length > 0 && (
          <table className="batchTable">
            <thead>
              <tr><th>Дата</th><th>Приложение</th><th>Оценка</th><th>Версия</th><th>Находок</th><th /></tr>
            </thead>
            <tbody>
              {history.slice(0, 15).map((h) => (
                <tr key={h.id}>
                  <td>{new Date(h.at).toLocaleString('ru-RU')}</td>
                  <td>{h.appName || h.appId}</td>
                  <td>{h.score}</td>
                  <td className="muted">{h.scoreVersion ?? 1}</td>
                  <td>{h.total}</td>
                  <td><button className="link" onClick={() => onCompare(h.id)}>сравнить</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {comparison && comparison.counts.added + comparison.counts.fixed > 0 && (
          <table className="batchTable" style={{ marginTop: 10 }}>
            <thead><tr><th>Правило</th><th>Находка</th><th>Состояние</th></tr></thead>
            <tbody>
              {comparison.added.map((f, i) => (
                <tr key={`a-${i}`}><td><code>{f.ruleId}</code></td><td>{f.message}</td><td className="err">новая</td></tr>
              ))}
              {comparison.fixed.map((f, i) => (
                <tr key={`f-${i}`}><td><code>{f.ruleId}</code></td><td>{f.message}</td><td className="ok">исправлена</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
