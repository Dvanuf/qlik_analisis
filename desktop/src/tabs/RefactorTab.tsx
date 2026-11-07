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
import { useMemo, useState } from 'react';
import { buildRefactoredScript } from '../../../src/script/refactor.js';
import { computeScore } from '../../../src/score/index.js';
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
  const added = source === 'ai' ? [] : rules.added;
  const rightLines = useMemo(() => proposed.split(/\r?\n/), [proposed]);
  const addedSet = useMemo(() => new Set(added), [added]);

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
    void navigator.clipboard?.writeText(proposed);
    onNote(`Скопировано: предложенная версия (${rightLines.length} строк)`);
  };

  /** Экспорт предложенной версии в .qvs — готовым скриптом, без доспыпания. */
  const exportQvs = async () => {
    if (!analysis) return;
    try {
      const res = await window.qa.exportScript({
        appName: analysis.appName ?? analysis.file ?? 'Приложение',
        script,
        finalScript: proposed,
      });
      onNote(`Изменённый скрипт сохранён: ${res.path}`);
    } catch (err) {
      onNote(`Не удалось сохранить скрипт: ${String(err)}`);
    }
  };

  /** Запрос предложения у ИИ — единственный путь, которым скрипт уходит наружу. */
  const askAi = async () => {
    setAiLoading(true);
    setSource('ai');
    try {
      const res = await window.qa.aiRefactor({
        script,
        findings: fixFindings,
        appName: analysis?.appName ?? analysis?.file ?? '',
      }) as AiRefactorResult;
      setAiResult(res);
      if (res.ok) {
        onNote(`Предложение ИИ получено: ${res.provider ?? ''} ${res.model ?? ''}`.trim());
      } else {
        onNote(`ИИ не ответил: ${res.error ?? 'неизвестная ошибка'}`);
      }
    } catch (err) {
      setAiResult({ ok: false, error: String(err) });
      onNote(`ИИ не ответил: ${String(err)}`);
    }
    setAiLoading(false);
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
      <section className="split2">
      <div className="card">
        <h3>
          Текущий скрипт
          <span className="grow" />
          <span className="hint">
            {script.split(/\r?\n/).length} строк · подсвечены места правок
          </span>
        </h3>
        <div className="codeview senseview">
          {script.split(/\r?\n/).map((text, i) => (
            <div key={i} className={`l${anchorLines.has(i + 1) ? ' anchor' : ''}`}>
              <span className="n">{i + 1}</span>
              <span className="c">{text}</span>
            </div>
          ))}
        </div>

        {/* Перечень правок: чекбокс выключает правку и пересобирает версию справа */}
        {rules.changes.length > 0 && (
          <div className="fixlist">
            <h4>Правки правил ({rules.changes.length})</h4>
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
            {source === 'ai' && aiResult?.ok
              ? `предложение ИИ · ${aiResult.provider ?? ''} ${aiResult.model ?? ''}`.trim()
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
            onClick={() => setSource('ai')}
            disabled={aiLoading || !aiResult?.ok}
            title={aiResult?.ok ? 'Показать предложение ИИ' : 'Сначала запросите предложение ИИ'}
          >
            Предложение ИИ
          </button>
          {source === 'ai' && aiResult?.redacted && (
            <span className="hint">данные обезличены перед отправкой</span>
          )}
        </div>

        {aiLoading && (
          <p className="muted">
            Запрос к провайдеру… Скрипт уходит наружу — это единственный случай,
            когда данные покидают приложение.
          </p>
        )}

        {!aiLoading && source === 'rules' && !aiResult?.ok && rules.changes.length === 0 && (
          <p className="muted">
            Правила не предложили правок для этого приложения. Можно запросить
            предложение ИИ — оно уйдёт провайдеру целиком со скриптом.
          </p>
        )}

        {!aiLoading && !aiResult?.ok && rules.changes.length > 0 && (
          <p className="warnline">
            <span aria-hidden="true">⚠</span> ИИ-предложение: скрипт будет отправлен
            провайдеру целиком. Правила работают локально и наружу ничего не отправляют.
            <button className="small" onClick={() => void askAi()} disabled={aiLoading}>
              Запросить ИИ
            </button>
          </p>
        )}

        <div className="codeview senseview">
          {rightLines.map((text, i) => (
            <div key={i} className={`l${addedSet.has(i + 1) ? ' added' : ''}`}>
              <span className="n">{i + 1}</span>
              <span className="c">{text}</span>
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
            добавлено строк: {added.length} · экспортируется показанная версия
          </span>
        </div>
      </div>
      </section>
    </section>
  );
}
