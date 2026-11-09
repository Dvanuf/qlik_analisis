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

/**
 * Шаги сценария подключения.
 *
 * Под каждым шагом — что именно происходит: пользователь не должен
 * угадывать, что нажать дальше.
 */
const STEPS = [
  {
    id: 'signin',
    title: 'Войти в хаб',
    desc: 'Откроется окно авторизации Qlik. Логин и пароль вводятся в браузере.',
  },
  {
    id: 'apps',
    title: 'Загрузить список приложений',
    desc: 'Приложения хаба с метаданными: поток, владелец, тэги, вид.',
  },
  {
    id: 'select',
    title: 'Выбрать приложение',
    desc: 'Отметьте радиокнопкой приложение для анализа.',
  },
  {
    id: 'analyze',
    title: 'Запустить анализ',
    desc: '54 проверки в 6 доменах: модель данных, скрипт, объекты, меры, переменные.',
  },
] as const;

type ScoresByApp = Record<string, { score: number; at: string; version: number }>;

/** NTLM-вход в QlikView AccessPoint */ 
function NtlmLoginBlock(props: { loginUrl: string; onNote: (t: string) => void; onDone: () => void }) {
  const [user, setUser] = useState('');
  const [domain, setDomain] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function login() {
    if (!user.trim() || !pass) { setNote('Введите логин и пароль.'); return; }
    setBusy(true);
    setNote('');
    try {
      const res = await window.qa.ntlmLogin({
        loginUrl: props.loginUrl,
        username: user.trim(),
        domain: domain.trim(),
        password: pass,
        insecure: true,
      }) as { ok: boolean; host?: string; note?: string; error?: string };
      if (res.ok) {
        props.onNote(res.note ?? `NTLM-аутентификация прошла (${res.host ?? ''})`);
        props.onDone();
      } else {
        setNote(res.error ?? 'Неизвестная ошибка NTLM-входа.');
      }
    } catch (err) {
      setNote(`Ошибка NTLM-входа: ${String(err)}`);
    }
    setBusy(false);
  }

  return (
    <div className="ntlmbox">
      <b>Вход в QlikView (NTLM)</b>
      <div className="muted small">
        AccessPoint использует Windows-аутентификацию (NTLM): логин обычно без
        домена — домен укажите в поле ниже (как в диалоге Windows, например ONYX).
        Пароль не сохраняется — только cookie сессии.
      </div>
      <div className="row">
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="логин"
          aria-label="Логин QlikView"
          disabled={busy}
        />
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="домен (например ONYX)"
          aria-label="Домен QlikView"
          disabled={busy}
        />
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="пароль"
          aria-label="Пароль QlikView"
          onKeyDown={(e) => { if (e.key === 'Enter') void login(); }}
          disabled={busy}
        />
        <button className="small" onClick={() => void login()} disabled={busy || !user.trim() || !pass}>
          Войти
        </button>
      </div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

type Props = {
  /** Последняя оценка каждого приложения — из истории прогонов. */
  scoresByApp?: ScoresByApp;
  /** Активный профиль сервера: sense | qv | custom. */
  serverProfile?: string;
  /** Переключить профиль: подставить адрес и сессию сервера. */
  onServerProfile?: (profile: string) => void;
  /** NTLM-сессия сохранена — перечитать сессию профиля. */
  onSessionSaved?: () => void;
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
  /** Диагностика метаданных: какие источники отвечали и с каким покрытием. */
  metaNote: string | null;
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
    scoresByApp, serverProfile, onServerProfile, onSessionSaved,
    url, onUrl, insecure, onInsecure, platform, onPlatform,
    user, onUser, password, onPassword, cookie, onCookie, xrfKey, onXrfKey, csrfToken, onCsrfToken,
    apps, appId, onAppId, selectedIds, onSelectedIds,
    doctorSteps, hubStatus, metaNote, busy, batchRunning, batchProgress, ruleInfo,
    signingIn, sessionAt, sessionError,
    onSignIn, onLoadApps, onAnalyze, onAnalyzeAll, onAnalyzeFile, onDoctor, onCancelBatch,
    onRefreshSession,
  } = props;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [streamFilter, setStreamFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [howtoOpen, setHowtoOpen] = useState(() => localStorage.getItem('qa.howto.open') !== '0');
  // Настройки репозитория QRS: подгружаются из файла приложения.
  const [qrsHost, setQrsHost] = useState('');
  const [qrsPort, setQrsPort] = useState('4242');
  const [qrsCert, setQrsCert] = useState('');
  const [qrsKey, setQrsKey] = useState('');
  const [qrsEnabled, setQrsEnabled] = useState(false);
  const [qrsBusy, setQrsBusy] = useState(false);
  const [qrsNote, setQrsNote] = useState('');
  const comboRef = useRef<HTMLDivElement | null>(null);

  /** Загрузить сохранённые настройки репозитория. */
  useEffect(() => {
    let alive = true;
    void window.qa.qrsStatus().then((s) => {
      if (!alive) return;
      setQrsHost(s.host ?? '');
      setQrsPort(String(s.port ?? 4242));
      setQrsCert(s.certPath ?? '');
      setQrsKey(s.keyPath ?? '');
      setQrsEnabled(Boolean(s.enabled));
    }).catch(() => { /* настройки необязательны */ });
    return () => { alive = false; };
  }, []);

  /** Сохранить настройки репозитория. */
  async function saveQrs(): Promise<void> {
    setQrsBusy(true);
    setQrsNote('');
    try {
      await window.qa.qrsSaveSettings({
        host: qrsHost.trim(),
        port: Number(qrsPort) || 4242,
        certPath: qrsCert.trim(),
        keyPath: qrsKey.trim(),
        enabled: qrsEnabled,
      });
      setQrsNote('Настройки репозитория сохранены.');
    } catch (err) {
      setQrsNote(`Не удалось сохранить: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setQrsBusy(false);
    }
  }

  /** Проверить связь с репозиторием. */
  async function checkQrs(): Promise<void> {
    setQrsBusy(true);
    setQrsNote('Проверяем соединение…');
    try {
      const res = await window.qa.qrsStatus();
      if (!res.ok) {
        setQrsNote(res.note ?? 'Репозиторий недоступен.');
      } else {
        setQrsNote(`Репозиторий доступен: ${res.note ?? ''}${res.version ? `, версия ${res.version}` : ''}`);
      }
    } catch (err) {
      setQrsNote(`Проверка не удалась: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setQrsBusy(false);
    }
  }

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

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const a of apps) for (const t of a.tags ?? []) set.add(t);
    return [...set].sort();
  }, [apps]);

  // Сервер мог не отдать метаданные — тогда фильтры бессмысленны, и об этом
  // надо сказать прямо, а не молча оставить один пункт «все».
  const metaAvailable = apps.some((a) => a.stream || a.owner || (a.tags ?? []).length);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps.filter((a) => {
      if (q && !a.title.toLowerCase().includes(q) && !a.id.toLowerCase().includes(q)) return false;
      if (streamFilter !== 'all' && (a.stream || 'не указан') !== streamFilter) return false;
      if (ownerFilter !== 'all' && (a.owner || 'не указан') !== ownerFilter) return false;
      if (tagFilter !== 'all' && !(a.tags ?? []).includes(tagFilter)) return false;
      // Вид приложения: опубликовано в потоке или личное.
      if (scopeFilter !== 'all') {
        const isPublished = a.published === true;
        if (scopeFilter === 'published' && !isPublished) return false;
        if (scopeFilter === 'personal' && isPublished) return false;
      }
      return true;
    });
  }, [apps, query, streamFilter, ownerFilter, tagFilter, scopeFilter]);

  const currentApp = apps.find((a) => a.id === appId) ?? null;

  /** Главная кнопка: одно действие на текущем шаге. */
  const mainAction = (() => {
    if (!signedIn) return { label: 'Войти в хаб (откроется окно авторизации)', run: onSignIn };
    if (!appsLoaded) return { label: 'Загрузить список приложений', run: onLoadApps };
    // Выбор приложений — только галочками: главный шаг это пакет по выбранным.
    return {
      label: selectedIds.length
        ? `▶ Анализировать выбранные (${selectedIds.length})`
        : 'Отметьте приложения галочками в списке',
      run: () => { if (selectedIds.length) onAnalyzeAll(selectedIds); },
    };
  })();

  const toggleSelected = (id: string) => {
    onSelectedIds(selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  };

  return (
    <section className="card wide">
      <h2>Подключение к Qlik</h2>

      {/* Профили серверов: переключение Sense / QlikView одной кнопкой.
          У каждого профиля — свой адрес и своя сохранённая сессия. */}
      <div className="serverpills" role="group" aria-label="Сервер">
        <button
          className={`serverpill${serverProfile === 'sense' ? ' on' : ''}`}
          onClick={() => onServerProfile?.('sense')}
        >
          <b>Qlik Sense</b>
          <span className="hint">dc3-qliks-ap-03</span>
        </button>
        <button
          className={`serverpill${serverProfile === 'qv' ? ' on' : ''}`}
          onClick={() => onServerProfile?.('qv')}
          title="Движок QlikView: нужен открытый порт 4747 и вход через AccessPoint"
        >
          <b>QlikView</b>
          <span className="hint">onyx-qlick · порт 4747</span>
        </button>
        <span className="hint" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
          адрес и сессия переключаются автоматически; правка URL ведётся под выбранным сервером
        </span>
      </div>

      {serverProfile === 'qv' && (
        <NtlmLoginBlock
          loginUrl="http://onyx-qlick.onyx.local/QvAJAXZfc/Authenticate.aspx"
          onNote={(t) => setQrsNote(t)}
          onDone={() => onSessionSaved?.()}
        />
      )}

      {/* --- Пошаговый сценарий --- */}
      <div className="wizard" role="list" aria-label="Шаги подключения">
        {STEPS.map((step, i) => {
          const state = i < currentStep ? 'done' : (i === currentStep ? 'current' : 'disabled');
          return (
            <div key={step.id} className={`step ${state}`} role="listitem">
              <span className="num">{state === 'done' ? '✓' : i + 1}</span>
              <span className="tx">
                <b>{step.title}</b>
                <i>{step.desc}</i>
              </span>
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
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setOpen(true)}
              aria-label="Поиск приложения"
            />
          </div>
          <p className="legend hint">
            <b>Радиокнопка</b> — приложение, которое будет проанализировано.
            {' '}<b>Флажок</b> — включить приложение в пакетный анализ (несколько сразу).
          </p>

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
            <label>
              Тэги:{' '}
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                <option value="all">все</option>
                {tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>
              Вид:{' '}
              <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
                <option value="all">все</option>
                <option value='published'>опубликованные</option>
                <option value='personal'>личные</option>
              </select>
            </label>
            <span className="muted small">
              Показано {filtered.length} из {apps.length}
            </span>
          </div>

          {metaNote && (
            <p className='muted small'>{metaNote}</p>
          )}

          {!metaAvailable && (
            <p className="muted small">
              Сервер не отдал поток, владельца и тэги приложений — фильтры по ним не работают.
              Они появятся, когда хаб отдаст метаданные (нужен вход в хаб на сервере Qlik Sense).
            </p>
          )}

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

          {/* --- Таблица приложений: выбор — только галочками (пакетный анализ) --- */}
          <div style={{ maxHeight: 430, overflow: 'auto' }}>
            <table className="rq">
              <thead>
                <tr>
                  <th style={{ width: 64 }} title="Отметить для анализа">Выбор</th>
                  <th style={{ width: 64 }} title="Пакетный анализ">Пакет</th>
                  <th>Приложение</th>
                  <th style={{ width: 90 }}>Размер</th>
                  <th style={{ width: 170 }}>Поток</th>
                  <th style={{ width: 230 }}>Владелец</th>
                  <th style={{ width: 260 }}>Тэги</th>
                  <th style={{ width: 130 }}>Вид</th>
                  <th style={{ width: 110 }} title="Последняя оценка из истории прогонов">Оценка</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr
                    key={a.id}
                    className={selectedIds.includes(a.id) ? 'rule' : ''}
                    onClick={() => toggleSelected(a.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(a.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelected(a.id)}
                        aria-label={`Выбрать ${a.title} для пакетного анализа`}
                      />
                    </td>
                    <td style={{ fontWeight: a.id === appId ? 600 : 400 }}>
                      {a.title}
                      {a.id === appId ? (
                        <span className="pill ok" style={{ marginLeft: 8 }}>будет проанализировано</span>
                      ) : null}
                    </td>
                    <td className="hint">{a.size ? `${(a.size / 1048576).toFixed(1).replace('.', ',')} МБ` : '—'}</td>
                    <td className="hint">{a.stream || '—'}</td>
                    <td className="hint">{a.owner || '—'}</td>
                    <td className="hint">{(a.tags ?? []).join(', ') || '—'}</td>
                    <td>
                      <span className={`pill ${a.published === true ? 'ok' : 'mute'}`}>
                        {a.published === true ? 'опубликовано' : 'личное'}
                      </span>
                    </td>
                    <td style={{ width: 110 }}>
                      {scoresByApp?.[a.id] ? (
                        <span className={`pill ${scoresByApp[a.id].score < 50 ? 'error' : scoresByApp[a.id].score < 75 ? 'warning' : 'ok'}`}>
                          {scoresByApp[a.id].score} · {new Date(scoresByApp[a.id].at).toLocaleDateString('ru-RU')}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted" style={{ padding: 20, textAlign: 'center' }}>
                      Ничего не найдено по текущим фильтрам
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* --- Панель запуска: только выбранные галочками --- */}
          <div className="runbar">
            <div className="rb-info">
              <div className="rb-t">
                {selectedIds.length > 0
                  ? `К анализу отмечено: ${selectedIds.length}`
                  : 'Отметьте приложения галочками в таблице'}
                <span className="pill ok">выбор — галочками</span>
              </div>
              <div className="rb-s">
                Анализ запускается по отмеченным приложениям; «Анализировать все» — весь список.
              </div>
            </div>
            <div className="rb-act">
              <button
                className="btn pri"
                onClick={() => onAnalyzeAll(selectedIds)}
                disabled={selectedIds.length === 0 || Boolean(busy) || batchRunning}
                title={selectedIds.length ? 'Проанализировать отмеченные приложения' : 'Сначала отметьте приложения галочками'}
              >
                ▶ Анализировать выбранные ({selectedIds.length})
              </button>
            </div>
          </div>
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

        {/*
          Репозиторий QRS (Qlik Sense Enterprise, порт 4242). Видит и
          неопубликованные приложения, поэтому метаданные из него дополняют
          хаб. Доступ — по клиентскому сертификату: путь задаётся здесь,
          пароль — в переменной окружения QLIK_QRS_CERT_PASSWORD.
        */}
        <div className="ai-settings" style={{ marginTop: 12 }}>
          <h3>Репозиторий QRS (список приложений)</h3>
          <p className="muted small">
            Хаб отдаёт только опубликованные приложения. Репозиторий QRS
            показывает все — включая неопубликованные — и дополняет владельца,
            поток и тэги. Нужен клиентский сертификат (.pfx или .crt с ключом).
          </p>
          <div className="form">
            <label>
              Хост репозитория
              <input
                value={qrsHost}
                onChange={(e) => setQrsHost(e.target.value)}
                placeholder="qlik-sense.corp.local"
              />
            </label>
            <label>
              Порт
              <input
                value={qrsPort}
                onChange={(e) => setQrsPort(e.target.value)}
                placeholder="4242"
              />
            </label>
            <label>
              Сертификат (.pfx или .crt)
              <input
                value={qrsCert}
                onChange={(e) => setQrsCert(e.target.value)}
                placeholder="/путь/к/client.pfx"
              />
            </label>
            <label>
              Ключ сертификата (.key, если отдельно)
              <input
                value={qrsKey}
                onChange={(e) => setQrsKey(e.target.value)}
                placeholder="/путь/к/client.key"
              />
            </label>
          </div>
          <div className="row-actions">
            <label className="muted small" style={{ flexDirection: 'row', gap: 6 }}>
              <input
                type="checkbox"
                checked={qrsEnabled}
                onChange={(e) => setQrsEnabled(e.target.checked)}
              />
              Брать метаданные из репозитория
            </label>
            <button className="btn" onClick={() => void saveQrs()} disabled={qrsBusy}>
              {qrsBusy ? 'Сохранение…' : 'Сохранить'}
            </button>
            <button className="btn" onClick={() => void checkQrs()} disabled={qrsBusy}>
              Проверить связь
            </button>
          </div>
          {qrsNote && <p className="muted small">{qrsNote}</p>}
        </div>
      </details>
    </section>
  );
}
