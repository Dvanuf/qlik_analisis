import { useEffect, useMemo, useState } from 'react';
import { cleanEngineUrl } from '../../src/extract/url.js';
import ConnectTab from './tabs/ConnectTab.js';
import AnalysisTab from './tabs/AnalysisTab.js';
import RulesTab from './tabs/RulesTab.js';
import SummaryTab from './tabs/SummaryTab.js';
import type {
  AnalysisResult, AppInfo, AppItem, BatchItem, BatchProgress, BatchTotals,
  Comparison, DoctorStep, HistoryRun, Platform, RuleInfo, RulesConfig, Severity, Tab,
} from './types.js';


declare global {
  interface Window {
    qa: {
      appInfo(): Promise<AppInfo>;
      rules(): Promise<RuleInfo>;
      analyzeFile(path: string): Promise<AnalysisResult>;
      doctor(opts: {
        url: string; user?: string; password?: string; insecure?: boolean;
        cookie?: string; xrfKey?: string; csrfToken?: string;
      }): Promise<{ steps: DoctorStep[]; failed: boolean }>;
      openDialog(): Promise<string | null>;
      listApps(opts: {
        url: string; cookie?: string; xrfKey?: string; csrfToken?: string;
        user?: string; password?: string; insecure?: boolean;
      }): Promise<AppItem[] | { error: string }>;
      analyzeApp(opts: {
        url: string; appId: string; cookie?: string; xrfKey?: string; csrfToken?: string;
        user?: string; password?: string; insecure?: boolean; platform?: string;
      }): Promise<AnalysisResult>;
      openHub(opts: { hubUrl: string; appId?: string; insecure?: boolean }): Promise<{
        cookie?: string; xrfKey?: string; csrfToken?: string; wsUrl?: string;
      } | null>;
      saveCredentials(creds: {
        hubUrl: string; cookie: string; xrfKey?: string; csrfToken?: string; at?: string;
      }): Promise<boolean>;
      loadCredentials(): Promise<{
        hubUrl: string; cookie: string; xrfKey?: string; csrfToken?: string; at?: string;
      } | null>;
      clearCredentials(): Promise<boolean>;
      onDoctorStep(cb: (step: DoctorStep) => void): () => void;
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
      rulesConfig(): Promise<unknown>;
      saveRulesConfig(config: unknown): Promise<{ path: string; config: unknown }>;
      exportRulesConfig(): Promise<{ canceled: boolean; path?: string }>;
      importRulesConfig(): Promise<{ canceled: boolean; path?: string; config?: unknown }>;
      exportScript(payload: {
        appName?: string; script: string; patch?: { script?: string };
      }): Promise<{ path: string }>;
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
    };
  }
}

const SEVERITIES: { id: Severity; label: string }[] = [
  { id: 'error', label: 'Ошибка' },
  { id: 'warning', label: 'Предупреждение' },
  { id: 'info', label: 'Замечание' },
];

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
  const [ruleInfo, setRuleInfo] = useState<RuleInfo | null>(null);
  const [busy, setBusy] = useState('');
  const [doctorSteps, setDoctorSteps] = useState<DoctorStep[]>([]);

  const [url, setUrl] = useState(
    () => localStorage.getItem('qa.url') ?? 'wss://dc3-qliks-ap-03.onyx.local/app',
  );
  const [user, setUser] = useState(() => localStorage.getItem('qa.user') ?? '');
  const [password, setPassword] = useState('');
  const [cookie, setCookie] = useState('');
  const [xrfKey, setXrfKey] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [insecure, setInsecure] = useState(() => localStorage.getItem('qa.insecure') !== '0');

  const [apps, setApps] = useState<AppItem[]>([]);
  const [appId, setAppId] = useState('');
  // Приложения, отмеченные для пакетного анализа.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

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
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [exportNote, setExportNote] = useState('');
  // Настройки правил: отключения, важность, пороги, исключения, подавления.
  const [rulesConfig, setRulesConfig] = useState<RulesConfig | null>(null);
  // История прогонов в локальной базе и сравнение с базовой линией.
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [onlyNew, setOnlyNew] = useState(false);

  // Настройки подключения живут между запусками: без этого после перезапуска
  // поле URL возвращается к заглушке и список приложений не грузится.
  useEffect(() => { localStorage.setItem('qa.url', url); }, [url]);
  useEffect(() => { localStorage.setItem('qa.user', user); }, [user]);
  useEffect(() => { localStorage.setItem('qa.insecure', insecure ? '1' : '0'); }, [insecure]);
  useEffect(() => { localStorage.setItem('qa.platform', platform); }, [platform]);

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
      const res = await window.qa.openHub({
        hubUrl,
        appId: targetApp || undefined,
        insecure,
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
    void window.qa.rulesConfig().then((c) => setRulesConfig(c as RulesConfig));
    // Восстанавливаем сохранённую сессию хаба (зашифрована safeStorage).
    void window.qa.loadCredentials().then((creds) => {
      if (!creds?.cookie) return;
      setCookie(creds.cookie);
      setXrfKey(creds.xrfKey ?? '');
      setCsrfToken(creds.csrfToken ?? '');
      setSessionAt(creds.at ?? null);
      setHubStatus('Сессия хаба восстановлена из защищённого хранилища. '
        + 'Если хаб отвечает 403 — сессия истекла, нажмите «Войти в хаб» ещё раз.');
    });
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
    return () => {
      offDoctor();
      offBatch();
    };
  }, []);

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
        if (!appId && res[0]) setAppId(res[0].id);
      } else {
        setApps([]);
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

  async function analyzeSelected() {
    if (!appId) return;
    setBusy('Анализ приложения…');
    try {
      const res = await window.qa.analyzeApp({ ...conn, appId, platform });
      setAnalysis(res);
      setTab('analysis');
    } catch (err) {
      setDoctorSteps([{ name: 'Анализ приложения', status: 'FAIL', detail: String(err) }]);
      setTab('connect');
    }
    setBusy('');
  }

  /** Пакетный анализ: всех приложений сервера или только выбранных. */
  async function analyzeAll(appIds?: string[]) {
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
      setExportNote(`Отчёт сохранён: ${res.htmlPath}`);
    } catch (err) {
      setExportNote(`Не удалось сохранить отчёт: ${String(err)}`);
    }
  }

  /** Сохранение настроек правил в файл конфигурации. */
  async function saveRulesConfig(config: RulesConfig) {
    try {
      const res = await window.qa.saveRulesConfig(config);
      setRulesConfig(res.config as RulesConfig);
      setExportNote(`Настройки правил сохранены: ${res.path}`);
    } catch (err) {
      setExportNote(`Не удалось сохранить настройки правил: ${String(err)}`);
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
      setExportNote(`Изменённый скрипт сохранён: ${res.path}`);
    } catch (err) {
      setExportNote(`Не удалось сохранить скрипт: ${String(err)}`);
    }
  }

  /** Экспорт настроек правил в файл. */
  async function exportRulesConfig() {
    try {
      const res = await window.qa.exportRulesConfig();
      if (res.canceled) return;
      setExportNote(`Настройки правил выгружены: ${res.path}`);
    } catch (err) {
      setExportNote(`Не удалось выгрузить настройки правил: ${String(err)}`);
    }
  }

  /** Импорт настроек правил из файла. */
  async function importRulesConfig() {
    try {
      const res = await window.qa.importRulesConfig();
      if (res.canceled) return;
      if (res.config) setRulesConfig(res.config as RulesConfig);
      setExportNote(`Настройки правил загружены: ${res.path}`);
    } catch (err) {
      setExportNote(`Не удалось загрузить настройки правил: ${String(err)}`);
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
      };
      for (const f of r.findings ?? []) {
        rows.push({
          runAt: meta.runAt,
          app: meta.app,
          stream: meta.stream,
          owner: meta.owner,
          ruleId: f.ruleId ?? '',
          category: f.category ?? '',
          severity: f.severity === 'error' ? 'Ошибка'
            : f.severity === 'warning' ? 'Предупреждение' : 'Замечание',
          object: f.target?.name ?? '',
          table: f.table ?? (f.target?.kind === 'table' ? f.target.name : ''),
          line: f.line ?? '',
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
      setExportNote(`В историю сохранено прогонов: ${saved}`);
      await loadHistory();
    } catch (err) {
      setExportNote(`Не удалось сохранить историю: ${String(err)}`);
    }
  }

  /** Загрузка списка прогонов из истории. */
  async function loadHistory() {
    try {
      const runs = await window.qa.historyList({ limit: 100 });
      setHistory(runs);
    } catch (err) {
      setExportNote(`История недоступна: ${String(err)}`);
    }
  }

  /** Сравнение прогона с базовой линией. */
  async function compareHistory(baselineId: number) {
    try {
      const baseline = history.find((h) => h.id === baselineId);
      if (!baseline) return;
      const current = await window.qa.historyLatest({ appId: baseline.appId });
      if (!current || current.id === baselineId) {
        setExportNote('Нет более нового прогона для сравнения.');
        return;
      }
      const cmp = await window.qa.historyCompare({ baselineId, currentId: current.id });
      setComparison(cmp);
      setExportNote(`Сравнение: база ${baselineId} → ${current.id}`);
    } catch (err) {
      setExportNote(`Не удалось сравнить прогоны: ${String(err)}`);
    }
  }

  /** Выгрузка плоской таблицы в CSV. */
  async function exportCsv() {
    try {
      const res = await window.qa.exportFindingsCsv({ rows: flatRows(), fileName: 'Находки' });
      setExportNote(`CSV сохранён: ${res.path}`);
    } catch (err) {
      setExportNote(`Не удалось сохранить CSV: ${String(err)}`);
    }
  }

  /** Выгрузка плоской таблицы в Excel. */
  async function exportXlsx() {
    try {
      const res = await window.qa.exportFindingsXlsx({ rows: flatRows(), fileName: 'Находки' });
      setExportNote(`Excel сохранён: ${res.path}`);
    } catch (err) {
      setExportNote(`Не удалось сохранить Excel: ${String(err)}`);
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
      setExportNote(`Сводный отчёт сохранён: ${res.htmlPath}`);
    } catch (err) {
      setExportNote(`Не удалось сохранить сводный отчёт: ${String(err)}`);
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

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  };

  return (
    <div className="app">
      <header>
        <div className="head-row">
          <div>
            <h1>Qlik Analyzer</h1>
            <span className="sub">
              {info
                ? `версия ${info.appVersion} · Electron ${info.electron} · Node ${info.node} · ${info.platform}/${info.arch}`
                : 'загрузка…'}
            </span>
          </div>
          <div className="platform">
            <span className="platform-label">Платформа:</span>
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                className={platform === p.id ? 'active' : ''}
                title={p.hint}
                onClick={() => setPlatform(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <nav className="tabs">
          {([['connect', 'Подключение'], ['analysis', 'Анализ'], ['summary', 'Сводный отчёт'], ['rules', 'Правила']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
              {id === 'analysis' && analysis ? ` (${analysis.summary.findings.total})` : ''}
              {id === 'summary' && batch ? ` (${batch.totals.apps})` : ''}
              {id === 'rules' && ruleInfo ? ` (${ruleInfo.total})` : ''}
            </button>
          ))}
        </nav>
      </header>

      {busy && <div className="busy">{busy}</div>}

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
          hubStatus={hubStatus}
          busy={busy}
          signingIn={signingIn}
          sessionAt={sessionAt}
          sessionError={sessionError}
          onRefreshSession={() => void signIn()}
          batchRunning={batchRunning}
          batchProgress={batchProgress}
          onSignIn={() => void signIn()}
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
          exportNote={exportNote}
          onExport={() => void exportCurrent()}
          onExportScript={() => void exportScript()}
          rulesConfig={rulesConfig}
          onSaveRulesConfig={(c) => void saveRulesConfig(c)}
        />
      )}

      {tab === 'summary' && (
        <SummaryTab
          batch={batch}
          exportNote={exportNote}
          onExport={() => void exportBatch()}
          onExportCsv={() => void exportCsv()}
          onExportXlsx={() => void exportXlsx()}
          history={history}
          comparison={comparison}
          onlyNew={onlyNew}
          onOnlyNew={setOnlyNew}
          onSaveHistory={() => void saveHistory()}
          onCompare={(id) => void compareHistory(id)}
          onLoadHistory={() => void loadHistory()}
        />
      )}

      {tab === 'rules' && (
        <RulesTab
          ruleInfo={ruleInfo}
          rulesConfig={rulesConfig}
          countsByRule={Object.fromEntries(countsByRule)}
          note={exportNote}
          onSave={(c) => void saveRulesConfig(c)}
          onExport={() => void exportRulesConfig()}
          onImport={() => void importRulesConfig()}
        />
      )}
    </div>
  );
}
