/**
 * Вкладка «Оценка» — первая в панели, открывается после анализа.
 *
 * Отвечает на главный вопрос пользователя: хорошо ли приложение, что
 * исправить первым и что это даст. Все цифры — из summary анализа
 * (score v2: domains, top, forecast, wasted), ничего не пересчитывается
 * на месте. Группа приложений читает последний пакетный прогон.
 */
import { useMemo, useState } from 'react';
import { DOMAIN_ORDER, DOMAIN_LABELS } from '../../../src/rules/domains.js';

// Домен из находки — строка; подписи ядра имеют конкретные ключи.
const DL = DOMAIN_LABELS as Record<string, string>;
import type { AnalysisResult, BatchItem, HistoryRun, Severity } from '../types.js';

type Props = {
  analysis: AnalysisResult | null;
  /** История прогонов приложения — динамика к прошлой проверке. */
  runs: HistoryRun[];
  /** Последний пакетный прогон — источник блока «Группа приложений». */
  batch: { results: BatchItem[]; totals: { apps: number } } | null;
  /** Перейти в «Анализ» с фильтром по правилу. */
  onOpenAnalysis: (ruleId: string) => void;
  /** Перейти в «Улучшенный скрипт» (правка уже включена). */
  onOpenRefactor: () => void;
  /** Проанализировать приложение из группы. */
  onAnalyzeApp: (appId: string) => void;
  /** Печать «Отчёта для руководителя»: HTML собран здесь, PDF — в main. */
  onPrintReport: (html: string) => void;
  onNote: (text: string) => void;
};

const SEVERITY_PILL: Record<Severity, string> = {
  error: 'pill error',
  warning: 'pill warning',
  info: 'pill info',
};

/** Уровень цвета по баллу: red < 50, yellow < 75, green дальше. */
function zone(score: number): 'r' | 'y' | 'g' {
  return score < 50 ? 'r' : score < 75 ? 'y' : 'g';
}

export default function ScoreTab(props: Props) {
  const { analysis, runs, batch, onOpenAnalysis, onOpenRefactor, onAnalyzeApp, onPrintReport, onNote } = props;
  const [howOpen, setHowOpen] = useState(false);

  const summary = analysis?.summary ?? null;
  const score = summary?.score;
  const domains = summary?.domains ?? {};
  const top = summary?.top ?? [];

  // Динамика: последние два прогона одной версии формулы.
  const trend = useMemo(() => {
    const v2 = runs.filter((r) => (r.scoreVersion ?? 1) === 2);
    if (v2.length < 2) return null;
    return v2[0].score - v2[1].score;
  }, [runs]);

  // Слабейший домен — для фразы-вывода.
  const weakest = useMemo(() => {
    const entries = Object.entries(domains);
    if (!entries.length) return null;
    return entries.sort((a, b) => a[1].score - b[1].score)[0];
  }, [domains]);

  // Группа приложений с баллами v2 — из последнего пакетного прогона.
  const group = useMemo(() => {
    const rows = (batch?.results ?? [])
      .filter((r) => r.summary?.score != null && !r.error)
      .map((r) => ({ item: r, score: Number(r.summary?.score) }))
      .sort((a, b) => a.score - b.score);
    return rows;
  }, [batch]);
  const groupAvg = group.length
    ? Math.round(group.reduce((s, g) => s + g.score, 0) / group.length)
    : null;
  const groupRed = group.filter((g) => g.score < 50).length;

  // Фильтры группы: поток / владелец / тэг.
  const [streamF, setStreamF] = useState('all');
  const [ownerF, setOwnerF] = useState('all');
  const [tagF, setTagF] = useState('all');
  const options = useMemo(() => {
    const uniq = (vals: (string | null | undefined)[]) => [...new Set(vals.map((v) => String(v ?? '')).filter(Boolean))].sort();
    return {
      streams: uniq(group.map((g) => g.item.stream)),
      owners: uniq(group.map((g) => g.item.owner)),
      tags: uniq(group.flatMap((g) => g.item.tags ?? [])),
    };
  }, [group]);
  const filtered = useMemo(() => group.filter(({ item }) => {
    if (streamF !== 'all' && (item.stream ?? '') !== streamF) return false;
    if (ownerF !== 'all' && (item.owner ?? '') !== ownerF) return false;
    if (tagF !== 'all' && !(item.tags ?? []).includes(tagF)) return false;
    return true;
  }), [group, streamF, ownerF, tagF]);

  if (!analysis || !summary || score == null) {
    return (
      <section className="card wide">
        <h2>Оценка приложения</h2>
        <p className="muted">
          Оценка появится после анализа. Откройте вкладку «Подключение»
          и запустите анализ — здесь будет балл, вердикт, слабые домены
          и первоочередные исправления с приростом балла.
        </p>
      </section>
    );
  }

  /** «Отчёт для руководителя»: одна страница A4. */
  const printReport = () => {
    const doms = DOMAIN_ORDER
      .filter((id) => domains[id])
      .map((id) => `<tr><td>${DL[id]}</td><td><b>${domains[id].score}</b></td><td>${domains[id].verdict}</td></tr>`)
      .join('');
    const tops = top.slice(0, 3)
      .map((t) => `<li>${t.title} — +${t.gain} балла</li>`)
      .join('');
    const reds = group.filter((g) => g.score < 50)
      .map((g) => `<li>${g.item.title} — ${g.score}</li>`)
      .join('');
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><style>
      body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d2420;margin:32px}
      h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px}
      .score{font-size:44px;font-weight:700}
      table{border-collapse:collapse;width:100%}td{padding:4px 8px;border-bottom:1px solid #ddd}
      .muted{color:#5b6660}ol{margin:4px 0;padding-left:20px}
    </style></head><body>
      <h1>${analysis.appName ?? 'Приложение'}</h1>
      <div class="muted">Отчёт для руководителя · ${new Date().toLocaleDateString('ru-RU')}</div>
      <div class="score">${score}<span style="font-size:16px;font-weight:400"> / 100 — ${summary.verdict ?? ''}</span></div>
      ${tops ? `<h2>Исправить в первую очередь</h2><ol>${tops}</ol>` : ''}
      <h2>Домены</h2><table>${doms}</table>
      ${group.length ? `<h2>Группа приложений</h2><p>Средняя оценка: ${groupAvg ?? '—'}, в красной зоне: ${groupRed}</p>${reds ? `<ul>${reds}</ul>` : ''}` : ''}
      <p class="muted">Формула: ${summary.scoreDetails?.formula ?? ''}</p>
    </body></html>`;
    onPrintReport(html);
  };

  /** Подробный Excel: листы «Приложения» и «Домены». */
  const exportExcel = async () => {
    if (!group.length) return;
    try {
      const res = await window.qa.exportDataModel({
        fileName: 'Оценка группы',
        sheets: [
          {
            name: 'Приложения',
            headers: ['Приложение', 'Поток', 'Владелец', 'Оценка', 'Вердикт', 'Что сделать первым'],
            rows: group.map(({ item, score: sc }) => [
              item.title, item.stream ?? '', item.owner ?? '', sc,
              item.summary?.verdict ?? '', item.summary?.top?.[0]?.title ?? '',
            ]),
          },
          {
            name: 'Домены',
            headers: ['Приложение', ...DOMAIN_ORDER.map((id) => DL[id])],
            rows: group.map(({ item }) => [
              item.title,
              ...DOMAIN_ORDER.map((id) => item.summary?.domains?.[id]?.score ?? ''),
            ]),
          },
        ],
      });
      onNote(`Оценка группы сохранена: ${res.path}`);
    } catch (err) {
      onNote(`Не удалось сохранить оценку группы: ${String(err)}`);
    }
  };

  return (
    <section>
      {/* --- Шапка: балл, вердикт, вывод, динамика --- */}
      <div className="card scorehero">
        <div className={`ring ${zone(score)}`}>
          <b>{score}</b>
          <span className="muted">из 100</span>
        </div>
        <div className="scorehero-main">
          <h2>{summary.verdict ?? ''}</h2>
          <p className="muted">
            {weakest
              ? `Слабее всего «${DL[weakest[0]] ?? weakest[0]}» — балл ${weakest[1].score}. `
              : 'Существенных слабых мест не найдено. '}
            {summary.forecast != null && summary.forecast > score
              ? `Если исправить первые три пункта, оценка вырастет примерно до ${summary.forecast}.`
              : 'Первых трёх исправлений достаточно для заметного роста.'}
          </p>
          <div className="row">
            {trend != null && (
              <span className={`pill ${trend > 0 ? 'ok' : trend < 0 ? 'error' : 'mute'}`}>
                {trend > 0 ? `+${trend}` : trend} с прошлой проверки
              </span>
            )}
            <button className="link" onClick={() => setHowOpen((v) => !v)} aria-expanded={howOpen}>
              Как считается оценка
            </button>
          </div>
          {howOpen && (
            <p className="muted small howformula">{summary.scoreDetails?.formula ?? ''}</p>
          )}
        </div>
        <div className="scorehero-counts">
          <div className="num err">{summary.findings.bySeverity.error ?? 0}</div>
          <div className="muted">ошибки</div>
          <div className="num warn">{summary.findings.bySeverity.warning ?? 0}</div>
          <div className="muted">предупреждения</div>
          <div className="num">{summary.findings.bySeverity.info ?? 0}</div>
          <div className="muted">замечания</div>
        </div>
      </div>

      {/* --- Домены: слабые первыми --- */}
      <div className="domgrid">
        {DOMAIN_ORDER
          .filter((id) => domains[id])
          .map((id) => ({ id, d: domains[id] }))
          .sort((a, b) => a.d.score - b.d.score)
          .map(({ id, d }) => {
            const first = top.find((t) => t.domain === id);
            return (
              <div className="card domcard" key={id}>
                <div className="muted">{DL[id]}</div>
                <div className="row" style={{ gap: 6, margin: '4px 0 8px' }}>
                  <b className="num">{d.score}</b>
                  <span className="muted">{d.word}</span>
                </div>
                <div className="pbar"><i className={zone(d.score)} style={{ width: `${d.score}%` }} /></div>
                <div className="muted" style={{ marginTop: 8 }}>
                  {first ? first.title : 'нарушений нет'}
                </div>
              </div>
            );
          })}
      </div>

      {/* --- Исправьте в первую очередь --- */}
      {top.length > 0 && (
        <div className="card">
          <h3>Исправьте в первую очередь</h3>
          {top.map((t) => (
            <div className="scoreitem" key={`${t.ruleId}-${t.title}`}>
              <span className={SEVERITY_PILL[t.severity as Severity] ?? 'pill mute'}>
                {t.severity === 'error' ? 'Ошибка' : t.severity === 'warning' ? 'Предупр.' : 'Замечание'}
              </span>
              <div className="grow">
                <b>{t.title}</b>
                <div className="muted small">
                  {t.domain ? (DL[t.domain] ?? t.domain) : '—'}
                  {' · '}мест: {t.count}
                  {t.hasFix ? ' · правка готова' : ''}
                </div>
              </div>
              <b className="gain">+{t.gain}</b>
              <button className="small" onClick={() => onOpenAnalysis(t.ruleId)}>Открыть</button>
              {t.hasFix && (
                <button
                  className="small"
                  onClick={() => {
                    onNote(`Правка «${t.title}» включена во вкладке «Улучшенный скрипт» — проверьте и экспортируйте .qvs`);
                    onOpenRefactor();
                  }}
                >
                  Применить
                </button>
              )}
            </div>
          ))}
          <p className="muted small" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
            Прирост показан для балла этого приложения. Прогноз после первых трёх: {summary.forecast ?? '—'}.
          </p>
        </div>
      )}

      {/* --- Группа приложений --- */}
      {group.length > 0 && (
        <div className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>Группа приложений</h3>
            <span className="grow" />
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
          </div>
          <p className="muted">
            Средняя оценка <b>{groupAvg ?? '—'}</b> · в красной зоне {groupRed} из {group.length}
          </p>
          <div className="scrolltbl">
            <table className="findings">
              <thead>
                <tr>
                  <th>Приложение</th><th style={{ width: '22%' }}>Оценка</th>
                  <th>Домены</th><th>Что сделать первым</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ item, score: sc }) => (
                  <tr key={item.appId} className="clickable" onClick={() => onAnalyzeApp(item.appId)}>
                    <td><b>{item.title}</b><div className="hint">{item.stream ?? ''}</div></td>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                        <b>{sc}</b>
                        <div className="pbar" style={{ flex: 1 }}><i className={zone(sc)} style={{ width: `${sc}%` }} /></div>
                      </div>
                    </td>
                    <td>
                      <div className="dots">
                        {DOMAIN_ORDER.map((id) => {
                          const d = item.summary?.domains?.[id]?.score;
                          return d == null
                            ? <i key={id} className="n" title={DL[id]} />
                            : <i key={id} className={zone(d)} title={`${DL[id]}: ${d}`} />;
                        })}
                      </div>
                    </td>
                    <td className="muted">{item.summary?.top?.[0]?.title ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="primary" onClick={printReport}>Отчёт для руководителя (PDF)</button>
            <button onClick={() => void exportExcel()}>Подробный экспорт (Excel)</button>
          </div>
        </div>
      )}
    </section>
  );
}
