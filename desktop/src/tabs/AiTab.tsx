/**
 * Вкладка «ИИ-чат».
 *
 * Задача вкладки — задать вопрос по результатам анализа. Наружу уходит
 * агрегированная сводка (счётчики, топ правил, динамика), а не сырой анализ:
 * ключи и полный скрипт в интерфейсе не показываются и наружу не уходят.
 *
 * Настройки провайдера, ключей и лимитов — в блоке «Настройки ИИ».
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiAnswer, AiMessage, AiPromptPreview, AiStatus, AnalysisResult, Finding,
} from '../types.js';

type Props = {
  analysis: AnalysisResult | null;
  /** Название и платформа анализируемого приложения. */
  appTitle?: string;
  platform?: string;
  /** Находка, выбранная во вкладке «Анализ» — задаёт фокус вопроса. */
  focus?: Finding | null;
  /** Сбросить фокус после отправки вопроса. */
  onFocusUsed?: () => void;
};

/** Подсказки, с которых начинается разговор. */
const PROMPTS = [
  'Что важнее всего исправить в первую очередь?',
  'Какие находки связаны между собой?',
  'Почему скор такой низкий?',
  'Что можно удалить без риска?',
];

/** API, доступное из окна приложения (объявлен в preload). */
type QaApi = {
  aiStatus: () => Promise<AiStatus>;
  aiSaveSettings: (settings: unknown) => Promise<boolean>;
  aiSaveKeys: (keys: { zai?: string; gemini?: string }) => Promise<boolean>;
  aiClearKeys: () => Promise<boolean>;
  aiAsk: (payload: unknown) => Promise<AiAnswer>;
  /** Фактический промпт, который уйдёт модели: для просмотра и правки. */
  aiPrompt: (payload: unknown) => Promise<AiPromptPreview>;
  aiCancel: () => Promise<boolean>;
  onAiEvent: (cb: (e: { type?: string; message?: string; provider?: string }) => void) => () => void;
};

function api(): QaApi {
  return (window as unknown as { qa: QaApi }).qa;
}

export default function AiTab(props: Props) {
  const { analysis, appTitle = '', platform = '', focus, onFocusUsed } = props;

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [zaiKey, setZaiKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [prompt, setPrompt] = useState<AiPromptPreview | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptNote, setPromptNote] = useState('');
  /** Правка промпта: null — уходит штатный текст. */
  const [override, setOverride] = useState<{ system?: string; user?: string } | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  /** Загрузить состояние ИИ-слоя при открытии вкладки. */
  useEffect(() => {
    let alive = true;
    void api().aiStatus().then((s) => {
      if (!alive) return;
      setStatus(s);
      setStatusError('');
    }).catch((err) => {
      if (!alive) return;
      setStatusError(err instanceof Error ? err.message : String(err));
      setNote('Не удалось прочитать настройки ИИ.');
    });
    return () => {
      alive = false;
    };
  }, []);

  /** События прогресса ИИ-слоя: смена провайдера, обрезка сводки, обезличивание. */
  useEffect(() => {
    const off = api().onAiEvent((e) => {
      if (!e?.message) return;
      if (e.type === 'provider') {
        setNote(`Запрос к провайдеру: ${e.provider ?? ''}`);
      } else if (e.type === 'truncated' || e.type === 'redacted' || e.type === 'cached') {
        setNote(e.message);
      } else if (e.type === 'error') {
        setNote(e.message);
      }
    });
    return off;
  }, []);

  /** Прокрутка лога к последнему сообщению. */
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  /** Краткая сводка находок — именно она уходит к модели. */
  const context = useMemo(() => {
    if (!analysis) return null;
    return {
      summary: analysis.summary,
      findings: analysis.findings,
    };
  }, [analysis]);

  /** Отправить вопрос. */
  async function send(text?: string): Promise<void> {
    const q = (text ?? question).trim();
    if (!q || busy) return;
    setQuestion('');
    setBusy(true);
    setNote('');
    setMessages((m) => [...m, { role: 'user', text: q }]);

    // История диалога: без неё модель каждый раз отвечает как в первый раз.
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.text }));


    try {
      const answer = await api().aiAsk({
        question: q,
        app: { title: appTitle, platform },
        summary: context,
        focus: focus
          ? {
            ruleId: focus.ruleId,
            title: focus.title,
            target: focus.target?.name ?? '',
            message: focus.message,
            severity: focus.severity,
            recommendation: focus.recommendation,
            line: focus.line ?? null,
          }
          : null,
        history,
        // Правка промпта, если пользователь её внёс. Вопрос в правленном
        // тексте обновляется на стороне main-процесса.
        promptOverride: override,
      });
      if (answer.ok && answer.text) {
        const notes: string[] = [];
        if (answer.truncated) notes.push('Сводка обрезана');
        if (answer.redacted) notes.push('Данные обезличены');
        if (answer.cached) notes.push('Ответ из кэша');
        setMessages((m) => [...m, {
          role: 'assistant',
          text: answer.text ?? '',
          provider: answer.provider,
          note: notes.join(' · ') || undefined,
        }]);
        onFocusUsed?.();
      } else {
        setMessages((m) => [...m, {
          role: 'assistant',
          text: `Не удалось получить ответ: ${answer.error ?? 'неизвестная ошибка'}`,
        }]);
      }
    } catch (err) {
      setMessages((m) => [...m, {
        role: 'assistant',
        text: `Ошибка запроса: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    } finally {
      setBusy(false);
    }
  }
  /** Загрузить фактический промпт, который уйдёт модели. */
  async function loadPrompt(): Promise<void> {
    if (!hasAnalysis) return;
    setPromptBusy(true);
    setPromptNote('');
    try {
      const preview = await api().aiPrompt({
        question: question.trim(),
        app: { title: appTitle, platform },
        summary: context,
        focus: focus
          ? {
            ruleId: focus.ruleId,
            title: focus.title,
            target: focus.target?.name ?? '',
            message: focus.message,
            severity: focus.severity,
            recommendation: focus.recommendation,
            line: focus.line ?? null,
          }
          : null,
        history: messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-6)
          .map((m) => ({ role: m.role, content: m.text })),
      });
      if (preview.ok) {
        setPrompt(preview);
      } else {
        setPrompt(null);
        setPromptNote(preview.error ?? 'Не удалось собрать промпт.');
      }
    } catch (err) {
      setPromptNote(`Не удалось собрать промпт: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPromptBusy(false);
    }
  }

  /** Сохранить ключи провайдеров. */
  async function saveKeys(): Promise<void> {
    setSavingKeys(true);
    try {
      await api().aiSaveKeys({ zai: zaiKey, gemini: geminiKey });
      setZaiKey('');
      setGeminiKey('');
      const s = await api().aiStatus();
      setStatus(s);
      setNote('Ключи сохранены в зашифрованном виде.');
    } catch (err) {
      setNote(`Не удалось сохранить ключи: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingKeys(false);
    }
  }

  /** Повторно прочитать состояние ИИ-слоя — после сбоя чтения или правки ключей. */
  async function reloadStatus(): Promise<void> {
    try {
      const s = await api().aiStatus();
      setStatus(s);
      setStatusError('');
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Включить или выключить режим конфиденциальности. */
  async function toggleSensitive(): Promise<void> {
    if (!status) return;
    const next = !status.sensitive;
    await api().aiSaveSettings({ sensitive: next });
    setStatus({ ...status, sensitive: next });
    setNote(next
      ? 'Режим конфиденциальности: данные не покидают машину, доступна только локальная модель.'
      : 'Режим конфиденциальности выключен.');
  }

  const hasAnalysis = Boolean(analysis);

  return (
    <section className="card wide ai-tab">
      <div className="head-row">
        <h2>ИИ-чат</h2>
        <button className="btn" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? 'Скрыть настройки' : 'Настройки ИИ'}
        </button>
      </div>
      <p className="muted">
        Вопросы по результатам анализа. К модели уходит сводка: счётчики, топ правил и
        динамика по прогонам — полный скрипт и содержимое приложения не передаются.
      </p>

      {showSettings && (status ? (
        <div className="ai-settings">
          <div className="kv">
            <table>
              <tbody>
                <tr>
                  <td>Провайдер</td>
                  <td>
                    <select
                      value={status.provider}
                      onChange={(e) => {
                        const next = { ...status, provider: e.target.value };
                        setStatus(next);
                        void api().aiSaveSettings({ provider: e.target.value });
                      }}
                    >
                      {status.providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} · {p.model}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
                <tr>
                  <td>Резервные провайдеры</td>
                  <td>
                    {status.providers.filter((p) => p.id !== status.provider).map((p) => (
                      <label key={p.id} className="muted small">
                        <input
                          type="checkbox"
                          checked={status.fallback.includes(p.id)}
                          onChange={(e) => {
                            const fallback = e.target.checked
                              ? [...status.fallback, p.id]
                              : status.fallback.filter((x) => x !== p.id);
                            const next = { ...status, fallback };
                            setStatus(next);
                            void api().aiSaveSettings({ fallback });
                          }}
                        />{' '}
                        {p.label}
                      </label>
                    ))}
                  </td>
                </tr>
                <tr>
                  <td>Цепочка запросов</td>
                  <td className="muted small">
                    {(status.chain ?? [status.provider]).map((id) => (
                      status.providers.find((p) => p.id === id)?.label ?? id
                    )).join(' → ')}
                    {(status.chain ?? []).length < 2 ? ' — резерв не задан' : ''}
                  </td>
                </tr>
                <tr>
                  <td>Конфиденциальность</td>
                  <td>Конфиденциальность</td>
                  <td>
                    <label className="muted small">
                      <input type="checkbox" checked={status.sensitive} onChange={() => void toggleSensitive()} />{' '}
                      Данные не покидают машину (только локальная модель)
                    </label>
                  </td>
                </tr>
                <tr>
                  <td>Лимиты</td>
                  <td className="muted small">
                    не больше {status.limits.requestsPerMinute} запросов в минуту,
                    {' '}{status.limits.dailyCap} в сутки
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="ai-keys">
            <h3>Ключи провайдеров</h3>
            <p className="muted small">
              Ключ хранится в зашифрованном виде на вашем компьютере и не попадает в интерфейс.
              Для Z.ai нужен Standard API Key (бесплатная модель glm-4.7-flash).
            </p>
            <div className="form">
              <label>
                Z.ai
                <input
                  type="password"
                  value={zaiKey}
                  placeholder={status.providers.find((p) => p.id === 'zai')?.hasKey ? 'ключ сохранён' : 'не задан'}
                  onChange={(e) => setZaiKey(e.target.value)}
                />
              </label>
              <label>
                Gemini
                <input
                  type="password"
                  value={geminiKey}
                  placeholder={status.providers.find((p) => p.id === 'gemini')?.hasKey ? 'ключ сохранён' : 'не задан'}
                  onChange={(e) => setGeminiKey(e.target.value)}
                />
              </label>
              <button className="btn" onClick={() => void saveKeys()} disabled={savingKeys}>
                {savingKeys ? 'Сохранение…' : 'Сохранить ключи'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="ai-settings ai-settings-error">
          <p className="warn">
            {statusError || 'Не удалось прочитать настройки ИИ.'}
          </p>
          <button className="btn" onClick={() => void reloadStatus()}>Повторить</button>
        </div>
      ))}

      {!hasAnalysis && (
        <p className="warn">
          Сначала проанализируйте приложение — ИИ отвечает по его результатам.
        </p>
      )}

      {focus && (
        <p className="muted small">
          Вопрос будет задан по находке {focus.ruleId}: {focus.title}
        </p>
      )}

      <div className="ai-log" ref={logRef}>
        {messages.length === 0 && (
          <p className="muted">
            {hasAnalysis
              ? 'Спросите о приложении — например, что исправлять в первую очередь.'
              : 'Здесь появятся ответы ИИ.'}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            <div className="ai-msg-head">
              <b>{m.role === 'user' ? 'Вы' : 'ИИ'}</b>
              {m.provider ? <span className="muted small">{m.provider}</span> : null}
              {m.note ? <span className="muted small">{m.note}</span> : null}
            </div>
            <div className="ai-msg-text">{m.text}</div>
          </div>
        ))}
        {busy && <div className="busy">Запрос к модели…</div>}
      </div>

      {note && <p className="muted small">{note}</p>}

      {hasAnalysis && (
        <div className="ai-prompts">
          {PROMPTS.map((p) => (
            <button key={p} className="btn" onClick={() => void send(p)} disabled={busy}>
              {p}
            </button>
          ))}
        </div>
      )}

      {hasAnalysis && (
        <details
          className="advanced ai-prompt"
          open={showPrompt}
          onToggle={(e) => {
            const open = (e.target as HTMLDetailsElement).open;
            setShowPrompt(open);
            // Промпт собирается только когда его действительно смотрят.
            if (open && !prompt) void loadPrompt();
          }}
        >
          <summary>
            Промпт запроса
            {override ? ' (изменён)' : ''}
          </summary>
          <p className="muted small">
            Этот текст уходит модели. Его можно прочитать и поправить перед отправкой.
          </p>
          <div className="row-actions">
            <button className="btn small" onClick={() => void loadPrompt()} disabled={promptBusy}>
              {promptBusy ? 'Сборка…' : 'Обновить'}
            </button>
            <button
              className="btn small"
              onClick={() => setOverride(null)}
              disabled={!override}
            >
              Сбросить правку
            </button>
            <button
              className="btn small"
              onClick={() => {
                if (!prompt) return;
                void navigator.clipboard?.writeText(
                  `${prompt.system ?? ''}\n\n---\n\n${prompt.user ?? ''}`,
                );
                setPromptNote('Промпт скопирован в буфер обмена.');
              }}
              disabled={!prompt}
            >
              Скопировать
            </button>
          </div>
          {promptNote && <p className="muted small">{promptNote}</p>}
          {prompt && (
            <>
              <p className="muted small">
                Провайдер: {prompt.provider} · {prompt.model}
                {prompt.external ? ' · данные обезличиваются' : ' · данные не покидают машину'}
                {prompt.truncated ? ' · сводка обрезана' : ''}
              </p>
              <label className="muted small">
                Инструкция модели
                <textarea
                  rows={8}
                  value={override?.system ?? prompt.system ?? ''}
                  onChange={(e) => setOverride({
                    system: e.target.value,
                    user: override?.user ?? prompt.user ?? '',
                  })}
                />
              </label>
              <label className="muted small">
                Вопрос и данные приложения
                <textarea
                  rows={12}
                  value={override?.user ?? prompt.user ?? ''}
                  onChange={(e) => setOverride({
                    system: override?.system ?? prompt.system ?? '',
                    user: e.target.value,
                  })}
                />
              </label>
              <p className="muted small">
                {override
                  ? 'Изменённый текст уйдёт модели вместо штатного.'
                  : 'Чтобы изменить промпт, отредактируйте поле выше.'}
              </p>
            </>
          )}
        </details>
      )}

      <div className="ai-input">
        <input
          value={question}
          placeholder="Ваш вопрос по приложению…"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={busy || !hasAnalysis}
        />
        {busy ? (
          <button className="btn" onClick={() => void api().aiCancel()}>Отменить</button>
        ) : (
          <button className="btn primary" onClick={() => void send()} disabled={!question.trim() || !hasAnalysis}>
            Спросить
          </button>
        )}
      </div>
    </section>
  );
}
