/**
 * Вкладка «Подключение» (этап 1 плана развития).
 *
 * Сценарий из четырёх шагов: ① Войти в хаб → ② Загрузить список приложений →
 * ③ Выбрать приложение → ④ Анализировать. Главная кнопка одна и меняет
 * действие по текущему шагу; «Анализ файла…» и «Анализировать все» вынесены
 * в отдельную группу вторичных действий.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeEngineUrl } from '../../../src/extract/url.js';
import type { AppItem, BatchProgress, DoctorStep, Platform, RuleInfo } from '../types.js';

const PLATFORMS: { id: Platform; label: string; hint: string }[] = [
  { id: 'auto', label: 'Определить автоматически', hint: 'По типам объектов приложения — так надёжнее' },
  { id: 'qlik-sense', label: 'Qlik Sense', hint: 'QIX App API: объекты, master items, закладки' },
  { id: 'qlikview', label: 'QlikView 12', hint: 'Doc API: скрипт и модель данных' },
];

/** Шаги сценария подключения. */
const STEPS = [
  { id: 'signin', title: 'Войти в хаб' },
  { id: 'apps', title: 'Загрузить список приложений' },
  { id: 'select', title: 'Выбрать приложение' },
  { id: 'analyze', title: 'Анализировать' },
] as const;

type Props = {
  url: string; onUrl: (v: string) => void;
  insecure: boolean; onInsecure: (v: boolean) => void;
  platform: Platform; onPlatform: (p: Platform) => void;
  user: string; onUser: (v: string) => void;
  password: string; onPassword: (v: string) => void;
  cookie: string; onCookie: (v: string) => void;
  xrfKey: string; onXrfKey: (v: string) => void;
  csrfToken: string; onCsrfToken: (v: string) => void;
  apps: AppItem[]; appId: string; onAppId: (v: string) => void;
  selectedIds: string[]; onSelectedIds: (v: string[]) => void;
  doctorSteps: DoctorStep[];
  /** Сведения о каталоге правил — чтобы показывать реальное число правил. */
  ruleInfo: RuleInfo | null;
  hubStatus: string;
  busy: string;
  batchRunning: boolean;
  batchProgress: BatchProgress | null;
  /** Идёт вход в хаб — интерфейс при этом не блокируется. */
  signingIn: boolean;
  /** Когда сессия хаба была получена. */
  sessionAt: string | null;
  /** Ошибка авторизации (403) — предлагаем обновить сессию. */
  sessionError: string | null;
  onSignIn: () => void;
  onLoadApps: () => void;
  onAnalyze: () => void;
  onAnalyzeAll: (appIds?: string[]) => void;
  onAnalyzeFile: () => void;
  onDoctor: () => void;
  onCancelBatch: () => void;
  /** Повторный вход в хаб (обновление истёкшей сессии). */
  onRefreshSession: () => void;
};

/** Иконка статуса проверки: цвет не единственный носитель смысла. */
function statusIcon(status: DoctorStep['status']): string {
  if (status === 'OK') return '✓';
  if (status === 'WARN') return '!';
  return '✕';
}

export default function ConnectTab(props: Props) {
  const {
    url, onUrl, insecure, onInsecure, platform, onPlatform,
    user, onUser, password, onPassword, cookie, onCookie, xrfKey, onXrfKey, csrfToken, onCsrfToken,
    apps, appId, onAppId, selectedIds, onSelectedIds,
    doctorSteps, hubStatus, busy, batchRunning, batchProgress, ruleInfo,
    signingIn, sessionAt, sessionError,
    onSignIn, onLoadApps, onAnalyze, onAnalyzeAll, onAnalyzeFile, onDoctor, onCancelBatch,
    onRefreshSession,
  } = props;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [streamFilter, setStreamFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [howtoOpen, setHowtoOpen] = useState(() => localStorage.getItem('qa.howto.open') !== '0');
  const comboRef = useRef<HTMLDivElement | null>(null);

  const signedIn = Boolean(cookie);
  const appsLoaded = apps.length > 0;
  const appSelected = Boolean(appId);

  // Состояние блока «Как подключиться» запоминается между запусками.
  useEffect(() => { localStorage.setItem('qa.howto.open', howtoOpen ? '1' : '0'); }, [howtoOpen]);

  // После успешного входа инструкция сворачивается: она уже не нужна.
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) setHowtoOpen(false);
    wasSignedIn.current = signedIn;
  }, [signedIn]);

  // Список закрывается по клику вне поля.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  /** Номер текущего шага: первый невыполненный. */
  const currentStep = !signedIn ? 0 : (!appsLoaded ? 1 : (!appSelected ? 2 : 3));

  const streams = useMemo(() => {
    const set = new Set<string>();
    for (const a of apps) set.add(a.stream || 'не указан');
    return [...set].sort();
  }, [apps]);

  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const a of apps) set.add(a.owner || 'не указан');
    return [...set].sort();
  }, [apps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps.filter((a) => {
      if (q && !a.title.toLowerCase().includes(q) && !a.id.toLowerCase().includes(q)) return false;
      if (streamFilter !== 'all' && (a.stream || 'не указан') !== streamFilter) return false;
      if (ownerFilter !== 'all' && (a.owner || 'не указан') !== ownerFilter) return false;
      return true;
    });
  }, [apps, query, streamFilter, ownerFilter]);

  const currentApp = apps.find((a) => a.id === appId) ?? null;

  /** Главная кнопка: одно действие на текущем шаге. */
  const mainAction = (() => {
    if (!signedIn) return { label: 'Войти в хаб (откроется окно авторизации)', run: onSignIn };
    if (!appsLoaded) return { label: 'Загрузить список приложений', run: onLoadApps };
    if (!appSelected) return { label: 'Выберите приложение в списке ниже', run: () => setOpen(true) };
    return { label: `Анализировать «${currentApp?.title ?? ''}»`, run: onAnalyze };
  })();

  const toggleSelected = (id: string) => {
    onSelectedIds(selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  };

  return (
    <section className="card wide">
      <h2>Подключение к Qlik</h2>

      {/* --- Пошаговый сценарий --- */}
      <div className="wizard" role="list" aria-label="Шаги подключения">
        {STEPS.map((step, i) => {
          const state = i < currentStep ? 'done' : (i === currentStep ? 'current' : 'disabled');
          return (
            <div key={step.id} className={`step ${state}`} role="listitem">
              <span className="num">{state === 'done' ? '✓' : i + 1}</span>
              <span>{step.title}</span>
            </div>
          );
        })}
      </div>

      <details
        className="howto"
        open={howtoOpen}
        onToggle={(e) => setHowtoOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Как подключиться</summary>
        <ol>
          <li>
            Укажите <b>URL движка</b>: <code>{'wss://<host>/app/<appId>'}</code>
            {' '}(через хаб, порт 443) или <code>{'ws://<host>:4747/app/<appId>'}</code>.
          </li>
          <li>
            Нажмите <b>«Войти в хаб»</b> → в открывшемся окне введите доменный логин и пароль.
            Cookie и CSRF-токен подставятся сами — вручную ничего копировать не нужно.
          </li>
          <li>
            <b>«Загрузить список приложений»</b> → выберите приложение → <b>«Анализировать»</b>.
          </li>
          <li>
            Результаты одного приложения — на вкладке <b>«Анализ»</b>: сводка, находки с фильтрами,
            готовые правки скрипта. Кнопка <b>«Экспорт отчёта»</b> сохраняет HTML+JSON в «Документы/QlikAnalyzer».
          </li>
          <li>
            <b>«Анализировать все»</b> — прогон по всем приложениям сервера; результат открывается
            на вкладке <b>«Сводный отчёт»</b> (таблица приложений, фильтр по категории, поиск).
          </li>
        </ol>
        <p className="muted small">
          Проверяем {ruleInfo?.total ?? 49} правил в 4 категориях (Quality · Resources · Practices · Script).
          Отчёты: «Документы/QlikAnalyzer». Лог входа: <code>hub-login.log</code> рядом с данными приложения.
        </p>
      </details>

      {/* --- Адрес и сертификат --- */}
      <div className="form">
        <label>
          URL движка
          <input
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            placeholder="wss://host/app/<appId>"
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={insecure} onChange={(e) => onInsecure(e.target.checked)} />
          самоподписанный сертификат
        </label>
        <button
          type="button"
          className="small ghost"
          title="Привести адрес к виду wss://<host>/app/<appId>"
          onClick={() => onUrl(normalizeEngineUrl(url, { appId: appId || undefined }))}
        >
          привести в формат
        </button>
      </div>

      {/* --- Состояние сессии хаба --- */}
      <div className={`notice${sessionError ? ' warn' : ''}`}>
        {sessionError ? (
          <>
            <b>{sessionError}</b>
            <div className="actions">
              <button onClick={onRefreshSession} disabled={signingIn}>
                Обновить сессию (войти в хаб заново)
              </button>
            </div>
          </>
        ) : signedIn ? (
          <>
            Сессия хаба получена
            {sessionAt ? ` (${new Date(sessionAt).toLocaleString('ru-RU')})` : ''}.
            Cookie и CSRF-токен сохранены в зашифрованном виде.
            {signingIn ? ' Идёт новый вход…' : ''}
          </>
        ) : (
          'Сессии хаба нет — нажмите «Войти в хаб» и авторизуйтесь в открывшемся окне.'
        )}
      </div>

      {/* --- Главное действие --- */}
      <div className="actions">
        <button className="primary" onClick={mainAction.run} disabled={signingIn}>
          {mainAction.label}
        </button>
      </div>

      {/* --- Вторичные действия --- */}
      <div className="actions">
        <span className="muted small" style={{ alignSelf: 'center' }}>Дополнительно:</span>
        <button onClick={onSignIn} disabled={signingIn}>
          {signedIn ? 'Войти в хаб заново' : 'Войти в хаб'}
        </button>
        <button onClick={onDoctor} disabled={Boolean(busy)}>Проверить подключение</button>
        <button onClick={onAnalyzeFile} disabled={Boolean(busy)}>Анализ файла…</button>
        <button onClick={() => onAnalyzeAll()} disabled={Boolean(busy) || batchRunning}>
          Анализировать все
        </button>
        {selectedIds.length > 0 && (
          <button onClick={() => onAnalyzeAll(selectedIds)} disabled={Boolean(busy) || batchRunning}>
            Анализировать выбранные ({selectedIds.length})
          </button>
        )}
        {batchRunning && <button onClick={onCancelBatch}>Прервать</button>}
      </div>

      {batchProgress && (
        <>
          <div className="progress">
            <div style={{ width: `${Math.round(((batchProgress.index + 1) / Math.max(1, batchProgress.total)) * 100)}%` }} />
          </div>
          <p className="muted small">
            {batchProgress.phase === 'start' && (
              <>Обработано {batchProgress.index} из {batchProgress.total}: {batchProgress.title}…</>
            )}
            {batchProgress.phase === 'done' && (
              <>Готово {batchProgress.index + 1} из {batchProgress.total}: {batchProgress.title} — {batchProgress.findings} находок
                {batchProgress.fromCache ? ' (из кэша)' : ''}</>
            )}
            {batchProgress.phase === 'error' && (
              <>Ошибка на {batchProgress.title}: {batchProgress.error}</>
            )}
            {batchProgress.phase === 'stopped' && <>Прогон остановлен на {batchProgress.index} из {batchProgress.total}.</>}
          </p>
        </>
      )}

      {hubStatus && (
        <p className={hubStatus.startsWith('Вход выполнен') ? 'ok' : 'muted'}>
          {hubStatus}
          {hubStatus.startsWith('Вход выполнен') && (
            <> — <span className="muted">данные сохранены в зашифрованном виде; ручное копирование из DevTools больше не нужно</span></>
          )}
        </p>
      )}

      {/* --- Список приложений --- */}
      {appsLoaded && (
        <div className="appList" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="combo" ref={comboRef}>
            <input
              className="combo-input"
              value={query}
              placeholder="Поиск приложения по названию…"
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              aria-label="Поиск приложения"
            />
            {open && (
              <div className="combo-list">
                {filtered.length === 0 && <div className="combo-empty">Ничего не найдено</div>}
                {filtered.slice(0, 300).map((a) => (
                  <div
                    key={a.id}
                    className={`combo-item${a.id === appId ? ' active' : ''}`}
                    onClick={() => { onAppId(a.id); setOpen(false); }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(a.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelected(a.id)}
                      aria-label={`Выбрать ${a.title} для пакетного анализа`}
                    />
                    <span>{a.title}</span>
                    <span className="meta">
                      {a.size ? `${Math.round(a.size / 1048576)} МБ` : 'размер неизвестен'}
                      {a.stream ? ` · ${a.stream}` : ''}
                      {a.owner ? ` · ${a.owner}` : ''}
                    </span>
                  </div>
                ))}
                {filtered.length > 300 && (
                  <div className="combo-empty">Показаны первые 300 из {filtered.length} — уточните поиск</div>
                )}
              </div>
            )}
          </div>

          <div className="combo-filters">
            <label>
              Поток:{' '}
              <select value={streamFilter} onChange={(e) => setStreamFilter(e.target.value)}>
                <option value="all">все</option>
                {streams.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>
              Владелец:{' '}
              <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                <option value="all">все</option>
                {owners.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <span className="muted small">
              Показано {filtered.length} из {apps.length}
            </span>
          </div>

          {selectedIds.length > 0 && (
            <div className="combo-selected">
              {selectedIds.map((id) => {
                const a = apps.find((x) => x.id === id);
                return (
                  <span className="tag" key={id}>
                    {a?.title ?? id}
                    <button className="link" onClick={() => toggleSelected(id)} aria-label="Убрать из выбора">✕</button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* --- Проверки подключения --- */}
      {doctorSteps.length > 0 && (
        <ul className="checklist">
          {doctorSteps.map((s, i) => (
            <li key={`${s.name}-${i}`} className={s.status.toLowerCase()}>
              <span className="icon" aria-hidden="true">{statusIcon(s.status)}</span>
              <span className="name">{s.name}</span>
              <span className="detail">
                {s.detail}
                {s.hint && <div className="hint">→ {s.hint}</div>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* --- Ручной ввод --- */}
      <details className="advanced" open={showAdvanced}>
        <summary onClick={() => setShowAdvanced((v) => !v)}>
          Дополнительно — ручной ввод (для других развёртываний)
        </summary>
        <div className="form">
          <label>
            Пользователь (домен\логин)
            <input value={user} onChange={(e) => onUser(e.target.value)} placeholder="CORP\user" />
          </label>
          <label>
            Пароль
            <input type="password" value={password} onChange={(e) => onPassword(e.target.value)} />
          </label>
          <label>
            Cookie сессии хаба
            <input
              type="password"
              value={cookie}
              onChange={(e) => onCookie(e.target.value)}
              placeholder="X-Qlik-Session=…"
            />
          </label>
          <label>
            XSRF-ключ хаба
            <input
              type="password"
              value={xrfKey}
              onChange={(e) => onXrfKey(e.target.value)}
              placeholder="X-Qlik-XrfKey: …"
            />
          </label>
          <label>
            CSRF-токен
            <input
              type="password"
              value={csrfToken}
              onChange={(e) => onCsrfToken(e.target.value)}
              placeholder="qlik-csrf-token=…"
            />
          </label>
        </div>
      </details>
    </section>
  );
}
