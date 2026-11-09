/**
 * Вкладка «Улучшенный скрипт».
 *
 * Слева — текущий скрипт загрузки (якорные строки будущих вставок
 * подсвечены), ниже — перечень правок с чекбоксами: выключенная правка
 * пересобирает предложенную версию. Справа — предложенная версия:
 * детерминированные правки правил или (по явному запросу, opt-in)
 * предложение ИИ-провайдера.
 *
 * Ответ ИИ никогда не применяется автоматически и показывается отдельным
 * источником: скрипт уходит провайдеру только после нажатия кнопки.
 */
import { useMemo, useRef, useState } from 'react';
import { buildRefactoredScript } from '../../../src/script/refactor.js';
import { computeScore } from '../../../src/score/index.js';
import { formatScript } from '../../../src/script/format.js';
import { highlightScript, type Token } from '../qlisense-highlight.js';
import type { AnalysisResult, RefactorChange } from '../types.js';

type Props = {
  analysis: AnalysisResult | null;
  /** Заметки об экспорте и ошибках — общий текст внизу окна. */
  onNote: (note: string) => void;
};

/** Ответ IPC core:ai-refactor. */
type AiRefactorResult = {
  ok: boolean;
  script?: string;
  commentary?: string;
  provider?: string;
  model?: string;
  truncated?: boolean;
  redacted?: boolean;
  cached?: boolean;
  error?: string;
};

/** Подписи видов правок. */
const KIND_LABELS: Record<string, string> = {
  dropField: 'Удалить поле',
  dropTable: 'Удалить таблицу',
  autoNumber: 'AutoNumber для ключа',
};

export default function RefactorTab(props: Props) {
  const { analysis, onNote } = props;
  const script = analysis?.script ?? '';

  // Выключенные правки: чекбоксы пересобирают предложенную версию.
  const [off, setOff] = useState<Set<string>>(new Set());
  // Источник предложения: детерминированные правила или ответ ИИ.
  const [source, setSource] = useState<'rules' | 'ai'>('rules');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AiRefactorResult | null>(null);
  // Последняя ошибка запроса: показывается в панели постоянно, а не только
  // тостом (тост исчезает за 5 секунд — «непонятно, что делается»).
  const [aiError, setAiError] = useState<string | null>(null);
  // Форматирование предложенной версии (отступы как в линтерах) и
  // синхронная прокрутка панелей «было/стало».
  const [formatOn, setFormatOn] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

  const rules = useMemo<{ script: string; changes: RefactorChange[]; added: number[] }>(
    () => buildRefactoredScript(script, analysis?.findings ?? [], { disabled: off }) as {
      script: string; changes: RefactorChange[]; added: number[];
    },
    [script, analysis, off],
  );

  /** Находки с готовыми правками — только включённые: их и отправляем ИИ. */
  const fixFindings = useMemo(
    () => (analysis?.findings ?? []).filter((f) => {
      const kind = (f as { fix?: { kind?: string; payload?: unknown } }).fix?.kind;
      if (!kind) return false;
      const id = kind === 'autoNumber'
        ? `autoNumber:${typeof (f as { fix?: { payload?: { field?: string } } }).fix?.payload === 'string'
          ? (f as { fix?: { payload?: string } }).fix?.payload
          : (f as { fix?: { payload?: { field?: string } } }).fix?.payload?.field}`
        : kind;
      return !off.has(id);
    }),
    [analysis, off],
  );

  const proposed = source === 'ai' && aiResult?.ok && aiResult.script?.trim()
    ? aiResult.script
    : rules.script;

  // Сводка «правок N, оценка A → B»: пересчитываем скор по находкам,
  // у которых включённая правка устраняет паттерн.
  const scoreAfter = useMemo(() => {
    if (!analysis?.summary) return null;
    const meta = analysis.summary.scoreDetails as { details?: { totalRows?: number } } | undefined;
    const totalRows = meta?.details?.totalRows ?? 0;
    const remaining = (analysis.findings ?? []).filter((f) => {
      const fix = (f as { fix?: { kind?: string; payload?: unknown } }).fix;
      if (!fix?.kind) return true;
      const field = typeof fix.payload === 'string' ? fix.payload : (fix.payload as { field?: string })?.field;
      const id = fix.kind === 'autoNumber' ? `autoNumber:${field}` : fix.kind;
      // Выключенные правки оставляем — они не применяются.
      return off.has(id);
    });
    return (computeScore(remaining, { totalRows }) as { score: number }).score;
  }, [analysis, off]);
  const shown = useMemo(
    () => (formatOn ? formatScript(proposed) : proposed),
    [proposed, formatOn],
  );
  const rightLines = useMemo(() => shown.split(/\r?\n/), [shown]);

  const anchorLines = useMemo(
    () => new Set(rules.changes.map((c: RefactorChange) => c.line).filter((n): n is number => n != null)),
    [rules.changes],
  );

  const toggle = (id: string) => {
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copy = () => {
    void navigator.clipboard?.writeText(shown);
    onNote(`Скопировано: предложенная версия (${rightLines.length} строк)`);
  };

  /** Экспорт предложенной версии в .qvs — готовым скриптом, без доспыпания. */
  const exportQvs = async () => {
    if (!analysis) return;
    try {
      const res = await window.qa.exportScript({
        appName: analysis.appName ?? analysis.file ?? 'Приложение',
        script,
        finalScript: shown,
      });
      onNote(`Изменённый скрипт сохранён: ${res.path}`);
    } catch (err) {
      onNote(`Не удалось сохранить скрипт: ${String(err)}`);
    }
  };

  /** Запрос предложения у ИИ — единственный путь, которым скрипт уходит наружу. */
  const askAi = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await window.qa.aiRefactor({
        script,
        findings: fixFindings,
        appName: analysis?.appName ?? analysis?.file ?? '',
      }) as AiRefactorResult;
      setAiResult(res);
      if (res.ok) {
        // Версию ИИ показываем только по факту ответа: до него панель
        // остаётся на версии правил — иначе выглядит, будто «ничего не делается».
        setSource('ai');
        onNote(`Предложение ИИ получено: ${res.provider ?? ''} ${res.model ?? ''}`.trim());
      } else {
        setAiError(res.error ?? 'неизвестная ошибка');
        onNote(`ИИ не ответил: ${res.error ?? 'неизвестная ошибка'}`);
      }
    } catch (err) {
      setAiResult({ ok: false, error: String(err) });
      setAiError(String(err));
      onNote(`ИИ не ответил: ${String(err)}`);
    }
    setAiLoading(false);
  };

  /** Строковый diff версии ИИ против текущего скрипта: сколько строк добавлено/убрано. */
  const aiDiff = useMemo(() => {
    if (source !== 'ai' || !aiResult?.ok) return null;
    const counts = (arr: string[]) => {
      const m = new Map<string, number>();
      for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const a = counts(script.split(/\r?\n/));
    const b = counts(shown.split(/\r?\n/));
    let added = 0;
    let removed = 0;
    for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0));
    for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0));
    return { added, removed };
  }, [source, aiResult, shown, script]);

  /** Строки версии ИИ, которых нет в текущем скрипте, — для подсветки. */
  const aiAddedSet = useMemo(() => {
    const set = new Set<number>();
    if (source !== 'ai' || !aiResult?.ok) return set;
    const rest = new Map<string, number>();
    for (const l of script.split(/\r?\n/)) rest.set(l, (rest.get(l) ?? 0) + 1);
    rightLines.forEach((l, i) => {
      const n = rest.get(l) ?? 0;
      if (n > 0) rest.set(l, n - 1);
      else set.add(i + 1);
    });
    return set;
  }, [source, aiResult, script, rightLines]);
  const added = source === 'ai' ? [...aiAddedSet].sort((x, y) => x - y) : rules.added;
  const addedSet = useMemo(() => new Set(added), [added]);

  /** Добавленные строки показанной версии: при форматировании — постстрочный
   *  diff (номера строк сдвигаются), без — точные метки правил. */
  const shownAdded = useMemo(() => {
    if (!formatOn) return source === 'ai' ? aiAddedSet : addedSet;
    const rest = new Map<string, number>();
    for (const l of script.split(/\r?\n/)) rest.set(l, (rest.get(l) ?? 0) + 1);
    const set = new Set<number>();
    rightLines.forEach((l, i) => {
      const n = rest.get(l) ?? 0;
      if (n > 0) rest.set(l, n - 1);
      else set.add(i + 1);
    });
    return set;
  }, [formatOn, source, aiAddedSet, addedSet, script, rightLines]);

  /** Синхронная прокрутка: позиция одной панели переносится во вторую. */
  const syncFrom = (side: 'left' | 'right') => (e: React.UIEvent<HTMLDivElement>) => {
    if (!syncScroll || syncingRef.current) return;
    const dst = side === 'left' ? rightRef.current : leftRef.current;
    if (!dst) return;
    syncingRef.current = true;
    dst.scrollTop = e.currentTarget.scrollTop;
    dst.scrollLeft = e.currentTarget.scrollLeft;
    syncingRef.current = false;
  };

  if (!analysis || !script.trim()) {
    return (
      <section className="card wide">
        <h2>Улучшенный скрипт</h2>
        <p className="muted">
          Сравнение текущего и предложенного скрипта появится после анализа.
          Откройте вкладку «Подключение» и запустите анализ — правки правил
          встанут по месту, а рядом будет видно, что именно изменится.
        </p>
      </section>
    );
  }

  return (
    <section>
      {/* Сводка над сравнением — как в макете: правок N, оценка A → B. */}
      <div className="card row" style={{ marginBottom: 12 }}>
        <div><div className="muted">Правок</div><div className="num">{rules.changes.length}</div></div>
        <div>
          <div className="muted">Оценка</div>
          <div className="num">
            {analysis?.summary?.score ?? '—'}
            {' → '}
            {scoreAfter != null ? <span style={{ color: 'var(--success)' }}>{scoreAfter}</span> : '—'}
          </div>
        </div>
        <span className="grow" />
        <span className="hint">правки применяются по месту; экспорт — показанная версия целиком</span>
      </div>
      <div className="refgrid">
      <div className="card">
        <h3>
          Текущий скрипт
          <span className="grow" />
          <span className="hint">
            {script.split(/\r?\n/).length} строк · подсвечены места правок
          </span>
        </h3>
        <div className="codeview senseview" ref={leftRef} onScroll={syncFrom('left')}>
          {highlightScript(script).map((parts: Token[], i) => (
            <div key={i} className={`l${anchorLines.has(i + 1) ? ' anchor' : ''}`}>
              <span className="n">{i + 1}</span>
              <span className="c">{parts.map((t, j) => t.k === 'plain' ? <span key={j}>{t.t}</span> : <span key={j} className={`tk-${t.k}`}>{t.t}</span>)}</span>
            </div>
          ))}
        </div>

        {/* Перечень правок: чекбокс выключает правку и пересобирает версию справа */}
        {rules.changes.length > 0 && (
          <div className="fixlist">
            <h4>Правки правил ({rules.changes.length})</h4>
            <p className="muted small" style={{ margin: '0 0 6px' }}>
              Готовые правки дают правила R001, R003, R005 и R007; у этого приложения сработали {rules.changes.length}.
            </p>
            {rules.changes.map((c) => (
              <label key={c.id} className="fixitem">
                <input
                  type="checkbox"
                  checked={!off.has(c.id)}
                  onChange={() => toggle(c.id)}
                />
                <span className="fixbody">
                  <b>{KIND_LABELS[c.kind] ?? c.kind}</b>
                  {' '}· <code>{c.ruleId}</code>
                  <div className="hint">
                    {c.kind === 'autoNumber'
                      ? `${c.statement}${c.line != null ? ` — после строки ${c.line}` : ' — место не определено'}`
                      : `${c.objects.slice(0, 6).join(', ')}${c.objects.length > 6 ? ` и ещё ${c.objects.length - 6}` : ''}`}
                  </div>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>
          Предложенная версия
          <span className="grow" />
          <span className="hint">
            {aiLoading
              ? 'запрос к ИИ… обычно 10–60 секунд'
              : source === 'ai' && aiResult?.ok
                ? `предложение ИИ · ${aiResult.provider ?? ''} ${aiResult.model ?? ''}`.trim()
                  + (aiDiff ? ` · +${aiDiff.added}/−${aiDiff.removed} строк` : '')
                : `правила · ${rules.changes.length} правок`}
          </span>
        </h3>

        {/* Источник предложения: правила по умолчанию, ИИ — по явному запросу */}
        <div className="aisrc">
          <button
            className={`small${source === 'rules' ? ' on' : ''}`}
            onClick={() => setSource('rules')}
          >
            Правила
          </button>
          <button
            className={`small${source === 'ai' ? ' on' : ''}`}
            onClick={() => { if (aiResult?.ok) setSource('ai'); }}
            disabled={aiLoading || !aiResult?.ok}
            title={aiResult?.ok ? 'Показать предложение ИИ' : 'Сначала запросите предложение — кнопка «Запросить ИИ»'}
          >
            Предложение ИИ
          </button>
          {source === 'ai' && aiResult?.redacted && (
            <span className="hint">данные обезличены перед отправкой</span>
          )}
          <span className="grow" />
          <button
            className={`small${formatOn ? ' on' : ''}`}
            onClick={() => setFormatOn((v) => !v)}
            title="Выравнивать отступы предложенной версии (как в линтерах)"
          >
            Формат
          </button>
          <button
            className={`small${syncScroll ? ' on' : ''}`}
            onClick={() => setSyncScroll((v) => !v)}
            title="Прокручивать панели «было/стало» синхронно"
          >
            Синхронно
          </button>
        </div>

        {aiLoading && (
          <div className="ailoading" role="status">
            <span className="spin" aria-hidden="true">⟳</span>
            <span>
              Запрос к ИИ-провайдеру — до минуты. Скрипт уходит наружу, это
              единственный случай передачи данных; результат появится на этой панели.
            </span>
          </div>
        )}

        {aiError && !aiLoading && (
          <div className="aierr" role="alert">
            <span>ИИ не ответил: {aiError}</span>
            <button className="small" onClick={() => void askAi()}>Повторить</button>
          </div>
        )}

        {!aiLoading && source === 'rules' && !aiResult?.ok && rules.changes.length === 0 && (
          <p className="muted">
            Правила не предложили правок для этого приложения. Можно запросить
            предложение ИИ — оно уйдёт провайдеру целиком со скриптом.
          </p>
        )}

        {!aiLoading && !aiResult?.ok && (source === 'ai' || rules.changes.length > 0) && (
          <p className="warnline">
            <span aria-hidden="true">⚠</span> ИИ-предложение: скрипт будет отправлен
            провайдеру целиком. Правила работают локально и наружу ничего не отправляют.
            <button className="small" onClick={() => void askAi()} disabled={aiLoading}>
              Запросить ИИ
            </button>
          </p>
        )}

        <div className="codeview senseview" ref={rightRef} onScroll={syncFrom('right')}>
          {highlightScript(shown).map((parts: Token[], i) => (
            <div key={i} className={`l${shownAdded.has(i + 1) ? ' added' : ''}`}>
              <span className="n">{i + 1}</span>
              <span className="c">{parts.map((t, j) => t.k === 'plain' ? <span key={j}>{t.t}</span> : <span key={j} className={`tk-${t.k}`}>{t.t}</span>)}</span>
            </div>
          ))}
        </div>

        {source === 'ai' && aiResult?.ok && aiResult.commentary && (
          <div className="aicomm">
            <h4>Пояснения ИИ</h4>
            <pre>{aiResult.commentary}</pre>
          </div>
        )}

        <div className="actions">
          <button className="small" onClick={copy}>Копировать</button>
          <button className="small" onClick={() => void exportQvs()}>Экспорт .qvs</button>
          <span className="hint">
            {source === 'ai' && aiDiff
              ? `+${aiDiff.added}/−${aiDiff.removed} строк · экспортируется показанная версия`
              : `добавлено строк: ${added.length} · экспортируется показанная версия`}
          </span>
        </div>
      </div>
      </div>
    </section>
  );
}
