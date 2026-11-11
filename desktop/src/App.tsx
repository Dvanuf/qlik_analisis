import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { cleanEngineUrl } from '../../src/extract/url.js';
import { includeKey, parseIncludeLines } from '../../src/extract/includes.js';
import { stageLabel } from '../../src/extract/progress.js';
import { SCOPE_LABELS } from '../../src/rules/scopes.js';
import ConnectTab from './tabs/ConnectTab.js';
import AnalysisTab from './tabs/AnalysisTab.js';
import RulesTab from './tabs/RulesTab.js';
import LibraryTab from './tabs/LibraryTab.js';
import SummaryTab from './tabs/SummaryTab.js';
import ModelTab from './tabs/ModelTab.js';
import LineageTab from './tabs/LineageTab.js';
import ScriptTab from './tabs/ScriptTab.js';
import RefactorTab from './tabs/RefactorTab.js';
import ScoreTab from './tabs/ScoreTab.js';
import AiTab from './tabs/AiTab.js';
import { buildRefactoredScript } from '../../src/script/refactor.js';
import type {
  AnalysisResult, AnalyzeProgress, AppInfo, AppItem, BatchItem, BatchProgress, BatchTotals,
  Comparison, DoctorStep, Finding, HistoryRun, LibraryFunction, Platform, QrsStatus,
  RuleInfo, RulesConfig, Severity, Tab,
} from './types.js';


declare global {
  interface Window {
    qa: {
      appInfo(): Promise<AppInfo>;
      rules(): Promise<RuleInfo>;
      /** Каталог готовых функций скрипта. */
      library(): Promise<{ functions: LibraryFunction[] }>;
      libraryQvs(ids: string[]): Promise<{ canceled: boolean; path?: string }>;
      librarySubs(script: string): Promise<{ subs: { name: string; params: string[] }[] }>;
      analyzeFile(path: string): Promise<AnalysisResult>;
      doctor(opts: {
        url: string; user?: string; password?: string; insecure?: boolean;
        cookie?: string; xrfKey?: string; csrfToken?: string;
      }): Promise<{ steps: DoctorStep[]; failed: boolean }>;
      openDialog(): Promise<string | null>;
      listApps(opts: {
        url: string; cookie?: string; xrfKey?: string; csrfToken?: string;
        user?: string; password?: string; insecure?: boolean;
      }): Promise<AppItem[] | { apps: AppItem[]; notes: string[] } | { error: string }>;
      analyzeApp(opts: {
        url: string; appId: string; cookie?: string; xrfKey?: string; csrfToken?: string;
        user?: string; password?: string; insecure?: boolean; platform?: string;
        /** Подложенные включаемые файлы (путь → содержимое). */
        includes?: Record<string, string>;
        /** Папка клона репозитория: включения ищутся по именам автоматически. */
        repoFolder?: string;
        /** Настройки GitLab для авто-раскрытия включений. */
        gitlab?: Record<string, unknown>;
      }): Promise<AnalysisResult>;
      openHub(opts: { hubUrl: string; appId?: string; insecure?: boolean; loginUrl?: string; platform?: 'sense' | 'qv' }): Promise<{
        cookie?: string; xrfKey?: string; csrfToken?: string; wsUrl?: string;
      } | null>;
      saveCredentials(creds: {
        hubUrl: string; cookie: string; xrfKey?: string; csrfToken?: string; at?: string;
      }): Promise<boolean>;
          ntlmLogin(payload: { loginUrl: string; username: string; domain?: string; password: string; insecure?: boolean }): Promise<{ ok: boolean; host?: string; note?: string; error?: string }>;
      loadCredentials(opts?: { host?: string }): Promise<{

        hubUrl: string; cookie: string; xrfKey?: string; csrfToken?: string; at?: string;
      } | null>;
      clearCredentials(opts?: { host?: string }): Promise<boolean>;
      onDoctorStep(cb: (step: DoctorStep) => void): () => void;
      /** Этапы анализа приложения. */
      onAnalyzeProgress(cb: (p: AnalyzeProgress) => void): () => void;
      analyzeAll(opts: {
        url: string; cookie?: string; xrfKey?: string; csrfToken?: string;
        user?: string; password?: string; insecure?: boolean; platform?: string;
        pauseMs?: number; useCache?: boolean; appIds?: string[];
      }): Promise<{ results: BatchItem[]; totals: BatchTotals }>;
      cancelBatch(): Promise<boolean>;
      onBatchProgress(cb: (p: BatchProgress) => void): () => void;
      exportReport(payload: {
        appName: string; summary: unknown; findings: unknown; patch: unknown; ruleStats: unknown;
      }): Promise<{ htmlPath: string; jsonPath: string }>;
      exportSummary(payload: {
        totals: unknown; results: unknown; platform?: string;
      }): Promise<{ htmlPath: string; jsonPath: string }>;
      /** Каталог правил в Excel (все правила с описаниями). */
      exportRulesCatalog(): Promise<{ canceled: boolean; path?: string }>;
      /** Содержимое включаемого файла (utf8/cp1251). */
      readTextFile(path: string): Promise<string>;
      /** Настройки GitLab: конфиг + факт наличия токена. */
      gitlabConfigGet(): Promise<Record<string, unknown>>;
      /** Сохранение настроек GitLab + токен. */
      gitlabConfigSave(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
      /** Выбор папки репозитория (диалог). */
      pickFolder(): Promise<string | null>;
      rulesConfig(): Promise<unknown>;
      saveRulesConfig(config: unknown): Promise<{ path: string; config: unknown }>;
      exportRulesConfig(): Promise<{ canceled: boolean; path?: string }>;
      importRulesConfig(): Promise<{ canceled: boolean; path?: string; config?: unknown }>;
      exportScript(payload: {
        appName?: string; script: string; patch?: { script?: string }; finalScript?: string;
      }): Promise<{ path: string }>;
      /** «Отчёт для руководителя»: HTML -> PDF через скрытое окно. */
      printReport(payload: { html: string; appName?: string }): Promise<{ path: string }>;
      /** ИИ-рефакторинг скрипта (opt-in): уходит к провайдеру целиком. */
      aiRefactor(payload: {
        script: string; findings?: unknown[]; appName?: string;
      }): Promise<{
        ok: boolean; script?: string; commentary?: string;
        provider?: string; model?: string; redacted?: boolean; cached?: boolean; error?: string;
      }>;
      historySave(payload: {
        appId: string; appName?: string; at?: string; score?: number;
        summary?: unknown; findings?: unknown[];
      }): Promise<{ runId: number }>;
      historyList(opts?: { appId?: string; limit?: number }): Promise<HistoryRun[]>;
      historyLatest(opts: { appId: string }): Promise<HistoryRun | null>;
      historyCompare(opts: { baselineId: number; currentId: number }): Promise<Comparison>;
      exportFindingsCsv(payload: {
        rows: Record<string, string | number>[]; fileName?: string;
      }): Promise<{ path: string }>;
      exportFindingsXlsx(payload: {
        rows: Record<string, string | number>[]; fileName?: string;
      }): Promise<{ path: string }>;
      qrsStatus: () => Promise<QrsStatus>;
      qrsSaveSettings: (settings: {
        host?: string; port?: number; certPath?: string; keyPath?: string; enabled?: boolean;
      }) => Promise<boolean>;
      exportDataModel(payload: {
        sheets: { name: string; headers: string[]; rows: (string | number)[][] }[];
        fileName?: string;
      }): Promise<{ path: string }>;
    };
  }
}

const SEVERITIES: { id: Severity; label: string }[] = [
  { id: 'error', label: 'Ошибка' },
  { id: 'warning', label: 'Предупреждение' },
  { id: 'info', label: 'Замечание' },
];

/** Вкладки в порядке панели: индекс + 1 = номер горячей клавиши. */
/**
 * Вкладки по группам — порядок в панели и номера горячих клавиш:
 * Ctrl/Cmd+1…9 слева направо, Ctrl/Cmd+0 — десятая (последняя).
 */
const TAB_GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: 'Обзор', tabs: ['score', 'summary'] },
  { label: 'Работа', tabs: ['analysis', 'script', 'refactor', 'model', 'lineage'] },
  { label: 'Помощь', tabs: ['ai', 'library'] },
  { label: 'Настройки', tabs: ['connect', 'rules'] },
];
const TAB_ORDER: Tab[] = TAB_GROUPS.flatMap((g) => g.tabs);

/** Предзаполненные серверы: переключение Sense ↔ QlikView кнопкой, без ручного ввода. */
const SERVER_PROFILES = [
  {
    id: 'sense', label: 'Qlik Sense', host: 'dc3-qliks-ap-03.onyx.local',
    url: 'wss://dc3-qliks-ap-03.onyx.local/app',
    loginUrl: 'https://dc3-qliks-ap-03.onyx.local/hub/',
    hint: 'хаб: cookie через вход в хаб',
  },
  {
    id: 'qv', label: 'QlikView', host: 'onyx-qlick.onyx.local',
    url: 'wss://onyx-qlick.onyx.local:4747/app',
    loginUrl: 'http://onyx-qlick.onyx.local/qlikview/index.htm',
    hint: 'AccessPoint: движок 4747 — нужен открытый порт',
  },
] as const;

type ServerProfileId = (typeof SERVER_PROFILES)[number]['id'];

const TAB_LABELS: Record<Tab, string> = {
  score: 'Оценка',
  connect: 'Подключение',
  analysis: 'Анализ',
  script: 'Скрипт загрузки',
  refactor: 'Улучшенный скрипт',
  model: 'Модель данных',
  lineage: 'Формирование',
  summary: 'Сводный отчёт',
  rules: 'Правила',
  library: 'Каталог функций',
  ai: 'ИИ-чат',
};

/** Иконки вкладок меню (штриховые, как в образце сайдбара). */
const ICON = (inner: ReactElement) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {inner}
  </svg>
);
const TAB_ICONS: Record<Tab, ReactElement> = {
  score: ICON(<><path d="M3.5 17a9 9 0 1 1 17 0" /><path d="M12 13l4.2-4.2" /><circle cx="12" cy="13" r="1.6" /></>),
  summary: ICON(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>),
  analysis: ICON(<><path d="M4 19V11M10 19V5M16 19v-5" /><path d="M3 21h18" /></>),
  script: ICON(<><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" /></>),
  refactor: ICON(<><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z" /><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>),
  model: ICON(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>),
  lineage: ICON(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><path d="M6.5 10v4a2 2 0 0 0 2 2H14" /><path d="M17.5 10v4" /></>),
  ai: ICON(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />),
  library: ICON(<><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></>),
  connect: ICON(<><path d="M9 3v6M15 3v6" /><path d="M6 9h12v3a6 6 0 0 1-12 0z" /><path d="M12 18v3" /></>),
  rules: ICON(<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>),
};

const PLATFORMS: { id: Platform; label: string; hint: string }[] = [
  { id: 'auto', label: 'Определить автоматически', hint: 'По типам объектов приложения — так надёжнее' },
  { id: 'qlik-sense', label: 'Qlik Sense', hint: 'QIX App API: объекты, master items, закладки' },
  { id: 'qlikview', label: 'QlikView 12', hint: 'Doc API: скрипт и модель данных' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('connect');

  const [platform, setPlatform] = useState<Platform>(
    // По умолчанию платформу определяет сервер: тот же Sense-сервер бывает
    // доступен через Doc API, и по способу подключения судить нельзя.
    () => (localStorage.getItem('qa.platform') as Platform) ?? 'auto',
  );
  const [info, setInfo] = useState<AppInfo | null>(null);
  // Масштаб интерфейса: пользователь выбирает размер шрифта.
  // Размеры в styles.css заданы в rem, база — html, поэтому --ui-scale
  // меняет весь интерфейс, а не только унаследованный текст.
  const [uiScale, setUiScale] = useState(() => {
    const saved = localStorage.getItem('qa.ui-scale');
    const value = Number(saved);
    // Прежняя шкала (0.8 / 0.9 / 1) масштабировала лишь один блок и
    // на вид почти не влияла. Переносим её по смыслу на новую: мелкий,
    // средний и крупный.
    if (value === 0.8) return 1;
    if (value === 0.9) return 1.15;
    if (value === 1) return 1.3;
    if (value >= 1 && value <= 1.4) return value;
    return 1.15;
  });
  const [ruleInfo, setRuleInfo] = useState<RuleInfo | null>(null);
  const [libraryFunctions, setLibraryFunctions] = useState<LibraryFunction[]>([]);
  const [busy, setBusy] = useState('');
  const [doctorSteps, setDoctorSteps] = useState<DoctorStep[]>([]);

  // Профиль сервера: 'sense' | 'qv' | 'custom' — кнопки на «Подключении».
  const [serverProfile, setServerProfile] = useState<string>(
    () => localStorage.getItem('qa.serverProfile') ?? 'sense',
  );
  // Адрес каждого профиля хранится отдельно — переключение не затирает ввод.
  const urlFor = (profile: string): string => {
    const preset = SERVER_PROFILES.find((p) => p.id === profile);
    if (!preset) return localStorage.getItem('qa.url') ?? '';
    return localStorage.getItem(`qa.url.${profile}`) ?? preset.url;
  };
  const [url, setUrl] = useState(() => {
    const profile = localStorage.getItem('qa.serverProfile') ?? 'sense';
    const preset = SERVER_PROFILES.find((p) => p.id === profile);
    if (!preset) return localStorage.getItem('qa.url') ?? 'wss://dc3-qliks-ap-03.onyx.local/app';
    return localStorage.getItem(`qa.url.${profile}`) ?? preset.url;
  });
  const [user, setUser] = useState(() => localStorage.getItem('qa.user') ?? '');
  const [password, setPassword] = useState('');
  const [cookie, setCookie] = useState('');
  const [xrfKey, setXrfKey] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [insecure, setInsecure] = useState(() => localStorage.getItem('qa.insecure') !== '0');

  const [apps, setApps] = useState<AppItem[]>([]);
  /** Диагностика метаданных: что ответил хаб и с каким покрытием. */
  const [metaNote, setMetaNote] = useState<string | null>(null);
  const [appId, setAppId] = useState('');
  // Приложения, отмеченные для пакетного анализа.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  // Находка, по которой пользователь хочет спросить ИИ.
  const [aiFocus, setAiFocus] = useState<Finding | null>(null);

  const [ruleSearch, setRuleSearch] = useState('');
  const [ruleCat, setRuleCat] = useState('all');
  const [batchCat, setBatchCat] = useState('all');
  const [batchSearch, setBatchSearch] = useState('');
  const [hubStatus, setHubStatus] = useState('');
  // Вход в хаб идёт в отдельном окне: интерфейс при этом не блокируется.
  const [signingIn, setSigningIn] = useState(false);
  // Когда сессия получена (для показа «сессия от …»).
  const [sessionAt, setSessionAt] = useState<string | null>(null);
  // Ошибка авторизации (403) — предлагаем обновить сессию.
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ results: BatchItem[]; totals: BatchTotals } | null>(null);
  // Ход анализа одного приложения: какие этапы уже пройдены.
  const [analyzeStage, setAnalyzeStage] = useState<AnalyzeProgress | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  // Всплывающее уведомление: результат экспорта, сохранения, копирования.
  const [toast, setToast] = useState<{ text: string; kind: string; at: number } | null>(null);
  const toastTimer = useRef<number | null>(null);
  // Настройки правил: отключения, важность, пороги, исключения, подавления.
  const [rulesConfig, setRulesConfig] = useState<RulesConfig | null>(null);
  // История прогонов в локальной базе и сравнение с базовой линией.
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  // Прогоны по анализируемому приложению: из них сводка берёт динамику.
  const [aiRuns, setAiRuns] = useState<HistoryRun[]>([]);
  const [onlyNew, setOnlyNew] = useState(false);
  // Меню-сайдбар: рельса (только иконки), свёрнутые группы, поиск по разделам.
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('qa.nav.collapsed') === '1');
  const [closedGroups, setClosedGroups] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('qa.nav.closed') ?? '[]') as string[]; } catch { return []; }
  });
  const [navQuery, setNavQuery] = useState('');
  useEffect(() => { localStorage.setItem('qa.nav.collapsed', navCollapsed ? '1' : '0'); }, [navCollapsed]);
  useEffect(() => { localStorage.setItem('qa.nav.closed', JSON.stringify(closedGroups)); }, [closedGroups]);
  const toggleGroup = (label: string) => setClosedGroups((prev) => prev.includes(label)
    ? prev.filter((g) => g !== label)
    : [...prev, label]);

  // Настройки подключения живут между запусками: без этого после перезапуска
  // поле URL возвращается к заглушке и список приложений не грузится.
  useEffect(() => {
    if (serverProfile === 'custom') localStorage.setItem('qa.url', url);
    else localStorage.setItem(`qa.url.${serverProfile}`, url);
  }, [url, serverProfile]);
  useEffect(() => { localStorage.setItem('qa.serverProfile', serverProfile); }, [serverProfile]);
  useEffect(() => { localStorage.setItem('qa.user', user); }, [user]);
  useEffect(() => { localStorage.setItem('qa.insecure', insecure ? '1' : '0'); }, [insecure]);
  useEffect(() => { localStorage.setItem('qa.platform', platform); }, [platform]);

  /**
   * Всплывающее уведомление вместо тихой строки в глубине вкладки:
   * результат операции видно сразу, из любой вкладки.
   *
   * Вид сообщения определяется автоматически: «Не удалось …» — ошибка,
   * остальное — успех; точный вид можно задать вторым аргументом.
   */
  function showToast(text: string, kind?: 'ok' | 'err' | 'info') {
    const k = kind ?? (/^Не удалось/.test(text) ? 'err' : 'ok');
    setToast({ text, kind: k, at: Date.now() });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5500);
  }

  /**
   * Горячие клавиши: Ctrl/Cmd+1…9 — вкладка по номеру, Ctrl/Cmd+F на
   * «Скрипте загрузки» — фокус в поиск. По e.code: работает в любой
   * раскладке (e.key на русской раскладке даёт «а» вместо «f»).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const digit = /^Digit([0-9])$/.exec(e.code);
      if (digit) {
        // 0 — десятая вкладка (как в макете: Правила = Ctrl+0).
        const n = digit[1] === '0' ? 10 : Number(digit[1]);
        const target = TAB_ORDER[n - 1];
        if (target) {
          e.preventDefault();
          setTab(target);
        }
        return;
      }
      if (e.code === 'KeyF' && tab === 'script') {
        const el = document.getElementById('script-find');
        if (el) {
          e.preventDefault();
          (el as HTMLInputElement).focus();
          (el as HTMLInputElement).select();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  /** Восстанавливает сессию выбранного сервера (у каждого профиля — своя). */
  function loadSessionFor() {
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    void window.qa.loadCredentials({ host }).then((creds) => {
      if (!creds?.cookie) {
        setCookie(''); setXrfKey(''); setCsrfToken(''); setSessionAt(null);
        setHubStatus('Сессии для этого сервера нет — нажмите «Войти в хаб».');
        return;
      }
      setCookie(creds.cookie);
      setXrfKey(creds.xrfKey ?? '');
      setCsrfToken(creds.csrfToken ?? '');
      setSessionAt(creds.at ?? null);
      setHubStatus(`Сессия ${host} восстановлена из защищённого хранилища. `
        + 'Если сервер отвечает 403 — сессия истекла, войдите заново.');
    });
  }

  /** Переключение сервера кнопкой: подставить адрес и перечитать его сессию. */
  function switchServerProfile(profile: string) {
    if (profile === serverProfile) return;
    setServerProfile(profile);
    setUrl(urlFor(profile));
    setAppId(''); setApps([]); setSelectedIds([]);
    // Сессия подгрузится эффектом [serverProfile] по новому URL.
  }

  /**
   * Прогоны анализируемого приложения: сводка для ИИ показывает динамику
   * по ним. Перечитываются при смене приложения.
   */
  useEffect(() => {
    let alive = true;
    const appId = analysis?.appId ?? '';
    void (async () => {
      if (!appId) {
        if (alive) setAiRuns([]);
        return;
      }
      try {
        const runs = await window.qa.historyList({ appId, limit: 10 });
        if (alive) setAiRuns(runs);
      } catch {
        if (alive) setAiRuns([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [analysis?.appId]);

  /** Базовый URL хаба из URL движка: wss://host/app/... -> https://host */
  const hubUrl = useMemo(() => {
    try {
      const u = new URL(url);
      return `https://${u.host}`;
    } catch {
      return '';
    }
  }, [url]);

  /** appId из URL движка: wss://host/app/<id> -> <id> */
  const appIdFromUrl = useMemo(() => {
    const m = String(url).match(/\/app\/([^/?#]+)/);
    return m ? m[1] : '';
  }, [url]);

  /** Хост текущего сервера — для подвала меню. */
  const navHost = useMemo(() => {
    try { return new URL(url).hostname; } catch { return 'сервер не указан'; }
  }, [url]);

  /** Вход в хаб: открывается окно, пользователь вводит доменный пароль. */
  async function signIn() {
    if (!hubUrl) { setHubStatus('Сначала укажите корректный URL движка'); return; }
    setSigningIn(true);
    setSessionError(null);
    setBusy('Открываем хаб — авторизуйтесь в окне браузера…');
    setHubStatus(
      'Открылось отдельное окно входа в Qlik — введите в нём доменный логин и пароль. '
      + 'Если окно не видно, посмотрите за основным окном приложения или в доке. '
      + 'Окно можно закрыть — вход прервётся.',
    );
    try {
      const targetApp = appId || appIdFromUrl;
      // Страница входа — по профилю: для QlikView это AccessPoint,
      // для Sense — хаб. Кастомный URL — прежняя эвристика из hubUrl.
      const loginUrl = SERVER_PROFILES.find((p) => p.id === serverProfile)?.loginUrl;
      const res = await window.qa.openHub({
        hubUrl,
        appId: targetApp || undefined,
        insecure,
        loginUrl,
        platform: serverProfile === 'qv' ? 'qv' : 'sense',
      });
      if (res?.cookie) {
        setCookie(res.cookie);
        setXrfKey(res.xrfKey ?? '');
        setCsrfToken(res.csrfToken ?? '');
        // Адрес движка из рукопожатия подставляем в поле URL: без него
        // приложение остаётся с заглушкой и список приложений не грузится.
        if (res.wsUrl) setUrl(cleanEngineUrl(res.wsUrl));
        await window.qa.saveCredentials({
          hubUrl,
          cookie: res.cookie,
          xrfKey: res.xrfKey,
          csrfToken: res.csrfToken,
          at: new Date().toISOString(),
        });
        const missing = [
          res.csrfToken ? null : 'CSRF-токен',
          res.xrfKey ? null : 'XSRF-ключ',
        ].filter(Boolean);
        setSessionAt(new Date().toISOString());
        setHubStatus(
          `Вход выполнен: cookie ${res.cookie ? '✓' : '✗'}, `
          + `CSRF-токен ${res.csrfToken ? '✓' : '✗'}, XSRF-ключ ${res.xrfKey ? '✓' : '✗'}`
          + (missing.length
            ? ` — не получен: ${missing.join(', ')}. Подробности в файле hub-login.log.`
            : ' — сессия сохранена в зашифрованном виде.'),
        );
      } else {
        setHubStatus('Авторизация не завершена: окно закрыто или cookie не получена. '
          + 'Подробности — в файле hub-login.log рядом с данными приложения.');
      }
    } catch (err) {
      setHubStatus(`Ошибка входа: ${String(err)}`);
    }
    setSigningIn(false);
    setBusy('');
  }

  useEffect(() => {
    void window.qa.appInfo().then(setInfo);
    void window.qa.rules().then(setRuleInfo);
    void window.qa.library().then((r) => setLibraryFunctions(r.functions ?? []));
    void window.qa.rulesConfig().then((c) => setRulesConfig(c as RulesConfig));
    // Восстанавливаем сессию текущего сервера (у каждого профиля — своя).
    void loadSessionFor();

    // Шаги приходят по мере проверки и по индексу: повторяющиеся шаги
    // заменяют предыдущую запись, а не добавляются вторым списком.
    const offDoctor = window.qa.onDoctorStep((step) => {
      setDoctorSteps((prev) => {
        const index = step.index ?? prev.length;
        const next = [...prev];
        while (next.length <= index) next.push({ name: '', status: 'OK', detail: '' });
        next[index] = step;
        return next;
      });
    });
    const offBatch = window.qa.onBatchProgress((p) => setBatchProgress(p));
    // Ход анализа одного приложения: показываем текущий этап.
    const offAnalyze = window.qa.onAnalyzeProgress((p) => setAnalyzeStage(p));
    return () => {
      offDoctor();
      offBatch();
      offAnalyze();
    };
  }, [serverProfile]);

  const conn = { url, user, password, cookie, xrfKey, csrfToken, insecure };

  /** Похоже ли это на отказ хаба из-за истёкшей сессии (403). */
  function isAuthError(text: string): boolean {
    return /\b403\b|доступ запрещён|Unexpected server response/i.test(text);
  }

  async function runDoctor() {
    setTab('connect');
    setBusy('Проверка подключения…');
    setDoctorSteps([]);
    try {
      const res = await window.qa.doctor(conn);
      setDoctorSteps(res.steps);
      const failed = res.steps.find((s) => s.status === 'FAIL');
      if (failed && isAuthError(`${failed.detail} ${failed.hint ?? ''}`)) {
        setSessionError('Хаб отклонил подключение (403) — сессия истекла или не получена.');
      }
    } catch (err) {
      setDoctorSteps([{ name: 'Проверка подключения', status: 'FAIL', detail: String(err) }]);
      if (isAuthError(String(err))) {
        setSessionError('Хаб отклонил подключение (403) — сессия истекла или не получена.');
      }
    }
    setBusy('');
  }

  /** Размер файла приложения: неизвестные значения не выдаём за «0 МБ». */
  function formatSize(size?: number | null): string {
    if (size == null) return 'размер неизвестен';
    if (size <= 0) return 'размер неизвестен';
    if (size < 1048576) return '< 1 МБ';
    return `${Math.round(size / 1048576).toLocaleString('ru-RU')} МБ`;
  }

  async function loadApps() {
    setBusy('Загрузка списка приложений…');
    try {
      const res = await window.qa.listApps(conn);
      if (Array.isArray(res)) {
        setApps(res);
        setMetaNote(null);
        // Автоподстановка первого приложения отменена: выбор — галочками в списке.
      } else if ('apps' in res) {
        setApps(res.apps);
        // Диагностика: показываем, откуда взялись метаданные и какое покрытие.
        setMetaNote(res.notes.length ? res.notes.join(' · ') : null);
        // Автоподстановка первого приложения отменена: выбор — галочками в списке.
      } else {
        setApps([]);
        setMetaNote(null);
        setDoctorSteps([{ name: 'Список приложений', status: 'FAIL', detail: res.error }]);
        if (isAuthError(res.error)) {
          setSessionError('Хаб отклонил запрос списка приложений (403) — сессия истекла или не получена.');
        }
      }
    } catch (err) {
      setDoctorSteps([{ name: 'Список приложений', status: 'FAIL', detail: String(err) }]);
      if (isAuthError(String(err))) {
        setSessionError('Хаб отклонил запрос списка приложений (403) — сессия истекла или не получена.');
      }
    }
    setBusy('');
  }

  /** Подложенные включаемые файлы приложения (localStorage). */
  const includesFor = (id: string): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(`qa.includes.${id}`) ?? '{}') as Record<string, string>; }
    catch { return {}; }
  };

  /** Папка клона репозитория приложения — авто-раскрытие include по именам. */
  const repoFolderFor = (id: string): string => localStorage.getItem(`qa.repoFolder.${id}`) ?? '';
  async function pickRepoFolder(targetAppId: string) {
    const folder = await window.qa.pickFolder();
    if (!folder) return;
    localStorage.setItem(`qa.repoFolder.${targetAppId}`, folder);
    showToast('Папка репозитория задана — включения раскрываются автоматически');
    await analyzeSelected(targetAppId);
  }

  /** Подложить включаемый файл (клон Git-репозитория) и переанализировать. */
  async function pickInclude(targetAppId: string, path: string) {
    const file = await window.qa.openDialog();
    if (!file) return;
    try {
      const content = await window.qa.readTextFile(file);
      const next = { ...includesFor(targetAppId), [path]: content };
      localStorage.setItem(`qa.includes.${targetAppId}`, JSON.stringify(next));
      showToast(`Включение подложено: ${file.split(/[\\/]/).pop()}`);
      await analyzeSelected(targetAppId);
    } catch (err) {
      showToast(`Не удалось прочитать файл: ${String(err)}`);
    }
  }

  async function analyzeSelected(targetId?: string) {
    const target = targetId ?? appId;
    if (!target) return;
    setBusy('Анализ приложения…');
    setAnalyzeStage(null);
    try {
      const res = await window.qa.analyzeApp({
        ...conn, appId: target, platform,
        includes: includesFor(target), repoFolder: repoFolderFor(target),
        gitlab: await window.qa.gitlabConfigGet().catch(() => ({})),
      });
      setAnalysis(res);
      // ТЗ «Оценка»: вкладка «Оценка» открывается автоматически после анализа.
      setTab('score');
    } catch (err) {
      setDoctorSteps([{ name: 'Анализ приложения', status: 'FAIL', detail: String(err) }]);
      setTab('connect');
    }
    setBusy('');
    setAnalyzeStage(null);
  }

  /**
   * Детальный анализ одного приложения из сводного отчёта.
   *
   * Пакетный прогон даёт сводку по всем приложениям; для одного приложения
   * нужен полный разбор — находки, скрипт и модель данных.
   */
  async function analyzeAppById(targetAppId: string) {
    if (!targetAppId) return;
    setBusy('Анализ приложения…');
    setAnalyzeStage(null);
    setAppId(targetAppId);
    try {
      const res = await window.qa.analyzeApp({
        ...conn, appId: targetAppId, platform,
        includes: includesFor(targetAppId), repoFolder: repoFolderFor(targetAppId),
        gitlab: await window.qa.gitlabConfigGet().catch(() => ({})),
      });
      setAnalysis(res);
      // «Открыть»/«анализ» из сводных представлений — это детальный разбор
      // находок; на «Оценку» переводит основной анализ приложения.
      setTab('analysis');
    } catch (err) {
      showToast(`Не удалось проанализировать приложение: ${String(err)}`);
      setTab('summary');
    }
    setBusy('');
    setAnalyzeStage(null);
  }

  /** Пакетный анализ: всех приложений сервера или только выбранных. */
  async function analyzeAll(appIds?: string[]) {
    // Один отмеченный отсчёт — это полный анализ приложения с вкладкой
    // «Оценка», а не пакет: сводный отчёт для него пуст и вводит в заблуждение.
    if (appIds && appIds.length === 1) {
      await analyzeSelected(appIds[0]);
      return;
    }
    setBatchRunning(true);
    setBatchProgress(null);
    setBusy('Пакетный анализ запущен…');
    try {
      const res = await window.qa.analyzeAll({ ...conn, platform, pauseMs: 1000, appIds });
      setBatch(res);
      setTab('summary');
    } catch (err) {
      setDoctorSteps([{ name: 'Пакетный анализ', status: 'FAIL', detail: String(err) }]);
    } finally {
      setBatchRunning(false);
      setBusy('');
    }
  }

  async function cancelBatch() {
    await window.qa.cancelBatch();
    setBusy('Останавливаем пакетный анализ…');
  }

  /** Экспорт отчёта по текущему анализу (HTML + JSON) в «Документы/QlikAnalyzer». */
  async function exportCurrent() {
    if (!analysis) return;
    try {
      const res = await window.qa.exportReport({
        appName: analysis.appName ?? analysis.file ?? 'Приложение',
        summary: analysis.summary,
        findings: analysis.findings,
        patch: analysis.patch,
        ruleStats: analysis.ruleStats,
      });
      showToast(`Отчёт сохранён: ${res.htmlPath}`);
    } catch (err) {
      showToast(`Не удалось сохранить отчёт: ${String(err)}`);
    }
  }

  /** Сохранение настроек правил в файл конфигурации. */
  async function saveRulesConfig(config: RulesConfig) {
    try {
      const res = await window.qa.saveRulesConfig(config);
      setRulesConfig(res.config as RulesConfig);
      showToast(`Настройки правил сохранены: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось сохранить настройки правил: ${String(err)}`);
    }
  }

  /** Экспорт изменённого скрипта в файл .qvs (исходное приложение не меняется). */
  async function exportScript() {
    if (!analysis) return;
    try {
      const res = await window.qa.exportScript({
        appName: analysis.appName ?? analysis.file ?? 'Приложение',
        script: analysis.script ?? '',
        patch: analysis.patch,
      });
      showToast(`Изменённый скрипт сохранён: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось сохранить скрипт: ${String(err)}`);
    }
  }

  /** «Отчёт для руководителя»: HTML печатается в PDF скрытым окном Electron. */
  async function printScoreReport(html: string) {
    try {
      const res = await window.qa.printReport({ html, appName: analysis?.appName ?? 'Приложение' });
      showToast(`PDF сохранён: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось сохранить PDF: ${String(err)}`);
    }
  }

  /** Экспорт модели данных приложения в Excel (листы на таблицы, поля, объекты). */
  async function exportDataModel() {
    if (!analysis?.dataModel?.length) return;
    try {
      const res = await window.qa.exportDataModel({
        sheets: analysis.dataModel,
        fileName: `${analysis.appName ?? 'Модель данных'}`.slice(0, 60),
      });
      showToast(`Модель данных сохранена: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось сохранить модель данных: ${String(err)}`);
    }
  }

  /** Каталог правил в Excel: все правила с кодами и описаниями. */
  async function exportRulesCatalog() {
    try {
      const res = await window.qa.exportRulesCatalog();
      if (res.canceled) return;
      showToast(`Каталог правил сохранён: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось сохранить каталог правил: ${String(err)}`);
    }
  }

  /** Экспорт настроек правил в файл. */
  async function exportRulesConfig() {
    try {
      const res = await window.qa.exportRulesConfig();
      if (res.canceled) return;
      showToast(`Настройки правил выгружены: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось выгрузить настройки правил: ${String(err)}`);
    }
  }

  /** Импорт настроек правил из файла. */
  async function importRulesConfig() {
    try {
      const res = await window.qa.importRulesConfig();
      if (res.canceled) return;
      if (res.config) setRulesConfig(res.config as RulesConfig);
      showToast(`Настройки правил загружены: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось загрузить настройки правил: ${String(err)}`);
    }
  }

  /** Плоская таблица находок по всем приложениям прогона. */
  function flatRows() {
    const rows: Record<string, string | number>[] = [];
    for (const r of batch?.results ?? []) {
      const meta = {
        runAt: r.at ?? new Date().toISOString(),
        app: r.title,
        stream: r.stream ?? '',
        owner: r.owner ?? '',
        tags: (r.tags ?? []).join(', '),
        score: r.summary?.score ?? '',
        scoreVersion: r.summary?.scoreVersion ?? '',
      };
      for (const f of r.findings ?? []) {
        rows.push({
          runAt: meta.runAt,
          app: meta.app,
          stream: meta.stream,
          owner: meta.owner,
          tags: meta.tags,
          score: meta.score,
          scoreVersion: meta.scoreVersion,
          ruleId: f.ruleId ?? '',
          category: f.category ?? '',
          severity: f.severity === 'error' ? 'Ошибка'
            : f.severity === 'warning' ? 'Предупреждение' : 'Замечание',
          object: f.target?.name ?? '',
          table: f.table ?? (f.target?.kind === 'table' ? f.target.name : ''),
          scope: SCOPE_LABELS[f.scope ?? 'dashboard'] ?? '',
          line: f.lines?.length ? f.lines.join(', ') : (f.line ?? ''),
          message: f.message ?? '',
        });
      }
    }
    return rows;
  }

  /** Сохранение прогона в локальную базу истории. */
  async function saveHistory() {
    if (!batch?.results?.length) return;
    try {
      let saved = 0;
      for (const r of batch.results) {
        if (r.error || !r.findings) continue;
        await window.qa.historySave({
          appId: r.appId,
          appName: r.title,
          at: r.at,
          score: r.summary?.score ?? 0,
          summary: r.summary,
          findings: r.findings,
        });
        saved += 1;
      }
      showToast(`В историю сохранено прогонов: ${saved}`);
      await loadHistory();
    } catch (err) {
      showToast(`Не удалось сохранить историю: ${String(err)}`);
    }
  }

  /** Загрузка списка прогонов из истории. */
  async function loadHistory() {
    try {
      const runs = await window.qa.historyList({ limit: 100 });
      setHistory(runs);
    } catch (err) {
      showToast(`История недоступна: ${String(err)}`);
    }
  }

  /** Сравнение прогона с базовой линией. */
  async function compareHistory(baselineId: number) {
    try {
      const baseline = history.find((h) => h.id === baselineId);
      if (!baseline) return;
      const current = await window.qa.historyLatest({ appId: baseline.appId });
      if (!current || current.id === baselineId) {
        showToast('Нет более нового прогона для сравнения.');
        return;
      }
      const cmp = await window.qa.historyCompare({ baselineId, currentId: current.id });
      setComparison(cmp);
      showToast(`Сравнение: база ${baselineId} → ${current.id}`);
    } catch (err) {
      showToast(`Не удалось сравнить прогоны: ${String(err)}`);
    }
  }

  /** Выгрузка плоской таблицы в CSV. */
  async function exportCsv() {
    try {
      const res = await window.qa.exportFindingsCsv({ rows: flatRows(), fileName: 'Находки' });
      showToast(`CSV сохранён: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось сохранить CSV: ${String(err)}`);
    }
  }

  /** Выгрузка плоской таблицы в Excel. */
  async function exportXlsx() {
    try {
      const res = await window.qa.exportFindingsXlsx({ rows: flatRows(), fileName: 'Находки' });
      showToast(`Excel сохранён: ${res.path}`);
    } catch (err) {
      showToast(`Не удалось сохранить Excel: ${String(err)}`);
    }
  }

  /** Экспорт сводного отчёта по пакетному прогону. */
  async function exportBatch() {
    if (!batch) return;
    try {
      const res = await window.qa.exportSummary({
        totals: batch.totals,
        results: batch.results,
        platform,
      });
      showToast(`Сводный отчёт сохранён: ${res.htmlPath}`);
    } catch (err) {
      showToast(`Не удалось сохранить сводный отчёт: ${String(err)}`);
    }
  }

  async function analyzeFile() {
    setBusy('Выбор файла…');
    const file = await window.qa.openDialog();
    if (!file) { setBusy(''); return; }
    setBusy(`Анализ ${file}…`);
    try {
      setAnalysis(await window.qa.analyzeFile(file));
      setTab('analysis');
    } catch (err) {
      setDoctorSteps([{ name: 'Анализ файла', status: 'FAIL', detail: String(err) }]);
    }
    setBusy('');
  }

  const categories = useMemo(
    () => (ruleInfo ? ruleInfo.categories.map((c) => c.name) : []),
    [ruleInfo],
  );

  const filteredRules = useMemo(() => {
    const all = ruleInfo?.rules ?? [];
    return all.filter((r) => {
      if (ruleCat !== 'all' && r.category !== ruleCat) return false;
      if (ruleSearch.trim()) {
        const q = ruleSearch.trim().toLowerCase();
        const hay = `${r.id} ${r.title} ${r.description} ${r.recommendation}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [ruleInfo, ruleCat, ruleSearch]);

  // История всех прогонов: колонка «Последняя оценка» в таблице приложений.
  const [allRuns, setAllRuns] = useState<HistoryRun[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const runs = await window.qa.historyList({ limit: 500 });
        if (alive) setAllRuns(runs);
      } catch { /* без истории колонка просто пустая */ }
    })();
    return () => { alive = false; };
  }, []);

  // Последняя оценка каждого приложения — для колонки в «Подключении».
  const scoresByApp = useMemo(() => {
    const map: Record<string, { score: number; at: string; version: number }> = {};
    for (const r of allRuns) {
      const prev = map[r.appId];
      // Прогон свежее — заменяет; при равных датах версия 2 приоритетнее.
      if (!prev || r.at > prev.at || (r.at === prev.at && (r.scoreVersion ?? 1) > prev.version)) {
        map[r.appId] = { score: r.score, at: r.at, version: r.scoreVersion ?? 1 };
      }
    }
    return map;
  }, [allRuns]);

  // Находки со строками скрипта — счётчик на вкладке «Скрипт загрузки».
  const scriptFindings = useMemo(
    () => (analysis?.findings ?? []).filter((f) => (f.lines?.length ?? 0) > 0).length,
    [analysis],
  );

  // Правило, по которому надо раскрыть «Анализ» (кнопка «Открыть» в «Оценке»).
  const [analysisFilter, setAnalysisFilter] = useState<string | null>(null);

  // Правки правил — счётчик на вкладке «Улучшенный скрипт».
  const refactorCount = useMemo(
    () => (analysis?.script
      ? buildRefactoredScript(analysis.script, analysis.findings ?? []).changes.length
      : 0),
    [analysis],
  );

  const countsByRule = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of analysis?.findings ?? []) map.set(f.ruleId, (map.get(f.ruleId) ?? 0) + 1);
    return map;
  }, [analysis]);

  /** Категории, реально встречающиеся в сводном отчёте (для фильтра). */
  const batchCatOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of batch?.results ?? []) {
      for (const [cat, n] of Object.entries(r.summary?.findings.byCategory ?? {})) {
        if (n > 0) set.add(cat);
      }
    }
    return [...set].sort();
  }, [batch]);

  /** Отфильтрованные строки сводного отчёта. */
  const filteredBatch = useMemo(() => {
    const all = batch?.results ?? [];
    const q = batchSearch.trim().toLowerCase();
    return all
      .filter((r) => {
        if (batchCat !== 'all') {
          const n = r.summary?.findings.byCategory[batchCat] ?? 0;
          if (n === 0) return false;
        }
        if (q) {
          const hay = `${r.title} ${r.appId}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.summary?.findings.total ?? -1) - (a.summary?.findings.total ?? -1));
  }, [batch, batchCat, batchSearch]);

  // Масштаб применяется к корню приложения через CSS-переменную.
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(uiScale));
    localStorage.setItem('qa.ui-scale', String(uiScale));
  }, [uiScale]);

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  };

  const currentApp = apps.find((a) => a.id === appId);
  const appTitle = analysis?.appName ?? currentApp?.title ?? 'Приложение не выбрано';
  const appIdShort = analysis?.appId ?? appId;
  // Платформа из анализа: ядро определяет её по данным сервера или берёт выбор пользователя.
  const platformLabel = analysis?.summary?.platform
    ? ({ 'qlik-sense': 'Qlik Sense', qlikview: 'QlikView', any: 'on-prem' } as Record<string, string>)[analysis.summary.platform]
      ?? analysis.summary.platform
    : null;

  return (
    <div className="app">
      <div className="hub">
        <div className="apppick" title={appTitle}>
          <span className="live" />
          {appTitle}
        </div>
        <span className="hint">
          {platformLabel ?? 'on-prem'}{appIdShort ? ` · ${String(appIdShort).slice(0, 8)}…` : ''}
        </span>
        <div className="grow" />
        <div className="zoomer" role="group" aria-label="Размер шрифта">
          <span className="lbl">Шрифт</span>
          <button
            className={uiScale === 1 ? 'on' : ''}
            onClick={() => setUiScale(1)}
            title="Мелкий"
          >
            А−
          </button>
          <button
            className={uiScale === 1.15 ? 'on' : ''}
            onClick={() => setUiScale(1.15)}
            title="Средний"
          >
            А
          </button>
          <button
            className={uiScale === 1.3 ? 'on' : ''}
            onClick={() => setUiScale(1.3)}
            title="Крупный"
          >
            А+
          </button>
        </div>
        <button
          className="icon-btn"
          title="Обновить список приложений"
          onClick={() => void loadApps()}
        >
          ⟳
        </button>
      </div>

      <div className="body">
      <nav className={`menu${navCollapsed ? ' is-collapsed' : ''}`} aria-label="Разделы">
        <div className="menu__head">
          <div className="menu__logo" aria-hidden="true">Q</div>
          <div className="menu__title">
            <b>Qlik Анализатор</b>
            <span className="menu__ver" title={`Electron ${info?.electron ?? '—'} · Node ${info?.node ?? '—'}`}>
              v{info?.appVersion ?? '…'}
            </span>
          </div>
          <button
            className="menu__toggle"
            onClick={() => setNavCollapsed((v) => !v)}
            aria-label={navCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
            title={navCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
          </button>
        </div>

        <div className="menu__search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <input
            value={navQuery}
            onChange={(e) => setNavQuery(e.target.value)}
            type="search"
            placeholder="Поиск по разделам"
            aria-label="Поиск по разделам"
          />
        </div>

        <div className="menu__nav">
          {TAB_GROUPS.map((g) => {
            const q = navQuery.trim().toLowerCase();
            const tabs = q
              ? g.tabs.filter((id) => TAB_LABELS[id].toLowerCase().includes(q))
              : g.tabs;
            if (!tabs.length) return null;
            const closed = !q && closedGroups.includes(g.label);
            return (
              <div key={g.label} className={`group${closed ? ' is-closed' : ''}`}>
                <button
                  className="group__head"
                  type="button"
                  aria-expanded={!closed}
                  onClick={() => toggleGroup(g.label)}
                >
                  {g.label}
                </button>
                <ul className="group__list">
                  {tabs.map((id) => {
                    const i = TAB_ORDER.indexOf(id);
                    const cnt = id === 'analysis' && analysis ? analysis.summary.findings.total
                      : id === 'script' && scriptFindings ? scriptFindings
                      : id === 'refactor' && refactorCount ? refactorCount
                      : id === 'summary' && batch ? batch.totals.apps
                      : id === 'rules' && ruleInfo ? ruleInfo.total
                      : id === 'library' && libraryFunctions.length ? libraryFunctions.length
                      : null;
                    return (
                      <li key={id}>
                        <button
                          role="tab"
                          aria-selected={tab === id}
                          className={`nav-item${tab === id ? ' is-active' : ''}`}
                          onClick={() => setTab(id)}
                          data-badge={cnt != null ? '' : undefined}
                          title={`${TAB_LABELS[id]}${cnt != null ? ` — ${cnt}` : ''} · Ctrl+${i === 9 ? 0 : i + 1}`}
                        >
                          {TAB_ICONS[id]}
                          <span className="nav-item__label nav-item__label--wrap">{TAB_LABELS[id]}</span>
                          {cnt != null && (
                            <span className={`nav-item__badge${id === 'refactor' ? ' nav-item__badge--warn' : ''}`}>
                              {cnt}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="menu__foot" title={hubStatus ?? ''}>
          <span className={`menu__dot${cookie ? '' : ' off'}`} />
          <span><b>{navHost}</b> · {cookie ? 'сессия активна' : 'нет сессии'}</span>
        </div>
      </nav>

      <div className="wrap">
      {busy && <div className="busy">{busy}</div>}
      {/* Всплывающее уведомление: результат экспорта, копирования, ошибки. */}
      {toast && (
        <div key={toast.at} className={`toast on ${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}

      {/* Ход анализа: видно, на каком этапе идёт процесс. */}
      {analyzeStage && (
        <div className="progress-line">
          <span className="progress-stage">{analyzeStage.detail ?? stageLabel(analyzeStage.stage)}</span>
          <span className="muted small">{stageLabel(analyzeStage.stage)}</span>
        </div>
      )}

      {tab === 'score' && (
        <ScoreTab
          analysis={analysis}
          runs={aiRuns}
          batch={batch}
          onOpenAnalysis={(ruleId) => {
            setAnalysisFilter(ruleId);
            setTab('analysis');
          }}
          onOpenRefactor={() => setTab('refactor')}
          onAnalyzeApp={(id) => void analyzeAppById(id)}
          onPrintReport={(html) => void printScoreReport(html)}
          onNote={showToast}
        />
      )}

      {tab === 'connect' && (
        <ConnectTab
          url={url} onUrl={setUrl}
          insecure={insecure} onInsecure={setInsecure}
          platform={platform} onPlatform={setPlatform}
          user={user} onUser={setUser}
          password={password} onPassword={setPassword}
          cookie={cookie} onCookie={setCookie}
          xrfKey={xrfKey} onXrfKey={setXrfKey}
          csrfToken={csrfToken} onCsrfToken={setCsrfToken}
          apps={apps} appId={appId} onAppId={setAppId}
          selectedIds={selectedIds} onSelectedIds={setSelectedIds}
          doctorSteps={doctorSteps}
          ruleInfo={ruleInfo}
          hubStatus={hubStatus}
          metaNote={metaNote}
          busy={busy}
          signingIn={signingIn}
          sessionAt={sessionAt}
          sessionError={sessionError}
          onRefreshSession={() => void signIn()}
          batchRunning={batchRunning}
          batchProgress={batchProgress}
          onSignIn={() => void signIn()}
          scoresByApp={scoresByApp}
          serverProfile={serverProfile}
          onServerProfile={switchServerProfile}
          onSessionSaved={() => void loadSessionFor()}
          onLoadApps={() => void loadApps()}
          onAnalyze={() => void analyzeSelected()}
          onAnalyzeAll={(ids) => void analyzeAll(ids)}
          onAnalyzeFile={() => void analyzeFile()}
          onDoctor={() => void runDoctor()}
          onCancelBatch={() => void cancelBatch()}
        />
      )}

      {tab === 'analysis' && (
        <AnalysisTab
          analysis={analysis}
          categories={categories}
          onNote={showToast}
          onExport={() => void exportCurrent()}
          onExportScript={() => void exportScript()}
          onExportDataModel={() => void exportDataModel()}
          rulesConfig={rulesConfig}
          onSaveRulesConfig={(c) => void saveRulesConfig(c)}
          onOpenScript={() => setTab('script')}
          focusRule={analysisFilter}
          onFilterUsed={() => setAnalysisFilter(null)}
          onOpenRefactor={() => setTab('refactor')}
          onOpenModel={() => setTab('model')}
          onAskAi={(finding) => {
            setAiFocus(finding);
            setTab('ai');
          }}
        />
      )}

      {tab === 'ai' && (
        <AiTab
          analysis={analysis}
          appTitle={analysis?.appName ?? analysis?.file ?? ''}
          platform={platform === 'auto' ? '' : platform}
          focus={aiFocus}
          onFocusUsed={() => setAiFocus(null)}
          runs={aiRuns}
          comparison={comparison}
        />
      )}

      {tab === 'model' && (
        <ModelTab
          analysis={analysis}
          onExport={() => void exportDataModel()}
        />
      )}

      {tab === 'lineage' && (
        <LineageTab analysis={analysis} />
      )}

      {tab === 'summary' && (
        <SummaryTab
          batch={batch}
          appsCount={apps.length}
          onExportCsv={() => void exportCsv()}
          onExportXlsx={() => void exportXlsx()}
          onPrintReport={(html) => void printScoreReport(html)}
          history={history}
          comparison={comparison}
          onlyNew={onlyNew}
          onOnlyNew={setOnlyNew}
          onSaveHistory={() => void saveHistory()}
          onCompare={(id) => void compareHistory(id)}
          onLoadHistory={() => void loadHistory()}
          onAnalyzeApp={(id) => void analyzeAppById(id)}
        />
      )}

      {tab === 'rules' && (
        <RulesTab
          ruleInfo={ruleInfo}
          rulesConfig={rulesConfig}
          countsByRule={Object.fromEntries(countsByRule)}
          onSave={(c) => void saveRulesConfig(c)}
          onExport={() => void exportRulesConfig()}
          onImport={() => void importRulesConfig()}
          onExportCatalog={() => void exportRulesCatalog()}
        />
      )}

      {tab === 'library' && (
        <LibraryTab
          functions={libraryFunctions}
          onCopy={(text) => void navigator.clipboard.writeText(text)}
          onSaveQvs={(ids) => void window.qa.libraryQvs(ids)}
          onParseLibrary={async (script) => (await window.qa.librarySubs(script)).subs}
        />
      )}

      {tab === 'script' && (
        <ScriptTab
          analysis={analysis}
          includesMap={includesFor(analysis?.appId ?? appId)}
          repoFolder={repoFolderFor(analysis?.appId ?? appId)}
          onPickInclude={(path) => void pickInclude(analysis?.appId ?? appId, path)}
          onPickFolder={() => void pickRepoFolder(analysis?.appId ?? appId)}
        />
      )}

      {tab === 'refactor' && (
        <RefactorTab analysis={analysis} onNote={showToast} rulesConfig={rulesConfig} />
      )}
      </div>
      </div>
    </div>
  );
}
