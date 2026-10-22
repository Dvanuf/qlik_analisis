import { useEffect, useMemo, useState } from 'react';

type Tab = 'connect' | 'analysis' | 'rules';
type Platform = 'qlik-sense' | 'qlikview';
type Severity = 'error' | 'warning' | 'info';

type AppInfo = {
  appVersion: string; electron: string; chrome: string; node: string; v8: string;
  platform: string; arch: string; locale: string; cwd: string;
};

type RuleInfo = {
  total: number;
  categories: { name: string; count: number }[];
  rules: {
    id: string; category: string; severity: string; title: string; description: string;
    recommendation: string; qsdaName: string | null; qsdaUrl: string | null;
    platforms: string[];
  }[];
};

type DoctorStep = { name: string; status: 'OK' | 'WARN' | 'FAIL'; detail: string; hint?: string };

type Finding = {
  ruleId: string; category: string; severity: string; title: string;
  message: string; recommendation: string; detail?: string;
  target?: { kind: string; name: string; id?: string };
};

type AnalysisResult = {
  appName?: string;
  file?: string;
  summary: {
    findings: { total: number; byCategory: Record<string, number>; bySeverity: Record<string, number> };
    counts: Record<string, number>;
    savings?: { removableFields: number; removableRows: number };
  };
  findings: Finding[];
  patch: { script: string };
  skipped?: { capability: string; reason: string }[];
  ruleStats?: {
    id: string; category: string; severity: string; title: string;
    count: number; skipped: boolean; note: string | null; qsdaName: string | null;
  }[];
};

type AppItem = { id: string; title: string; size: number | null };

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
      onDoctorStep(cb: (step: DoctorStep) => void): () => void;
    };
  }
}

const SEVERITIES: { id: Severity; label: string }[] = [
  { id: 'error', label: 'Ошибка' },
  { id: 'warning', label: 'Предупреждение' },
  { id: 'info', label: 'Замечание' },
];

const PLATFORMS: { id: Platform; label: string; hint: string }[] = [
  { id: 'qlik-sense', label: 'Qlik Sense', hint: 'QIX App API: объекты, master items, закладки' },
  { id: 'qlikview', label: 'QlikView 12', hint: 'Doc API: скрипт и модель данных' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('connect');
  const [platform, setPlatform] = useState<Platform>('qlikview');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ruleInfo, setRuleInfo] = useState<RuleInfo | null>(null);
  const [busy, setBusy] = useState('');
  const [doctorSteps, setDoctorSteps] = useState<DoctorStep[]>([]);

  const [url, setUrl] = useState('wss://dc3-qliks-ap-03.onyx.local/app/7cd8b706-5b9e-4c96-b2fb-6b1ed3deeb20');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [cookie, setCookie] = useState('');
  const [xrfKey, setXrfKey] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [insecure, setInsecure] = useState(true);

  const [apps, setApps] = useState<AppItem[]>([]);
  const [appId, setAppId] = useState('');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  const [sevFilter, setSevFilter] = useState<Set<Severity>>(new Set());
  const [catFilter, setCatFilter] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [ruleSearch, setRuleSearch] = useState('');
  const [ruleCat, setRuleCat] = useState('all');

  useEffect(() => {
    void window.qa.appInfo().then(setInfo);
    void window.qa.rules().then(setRuleInfo);
    return window.qa.onDoctorStep((step) => {
      setDoctorSteps((prev) => [...prev, step]);
    });
  }, []);

  const conn = { url, user, password, cookie, xrfKey, csrfToken, insecure };

  async function runDoctor() {
    setTab('connect');
    setBusy('Проверка подключения…');
    setDoctorSteps([]);
    try {
      const res = await window.qa.doctor(conn);
      setDoctorSteps(res.steps);
    } catch (err) {
      setDoctorSteps([{ name: 'Проверка подключения', status: 'FAIL', detail: String(err) }]);
    }
    setBusy('');
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
      }
    } catch (err) {
      setDoctorSteps([{ name: 'Список приложений', status: 'FAIL', detail: String(err) }]);
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

  const filtered = useMemo(() => {
    const all = analysis?.findings ?? [];
    return all.filter((f) => {
      if (sevFilter.size && !sevFilter.has(f.severity as Severity)) return false;
      if (catFilter.size && !catFilter.has(f.category)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${f.ruleId} ${f.title} ${f.message} ${f.target?.name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [analysis, sevFilter, catFilter, search]);

  const filteredRules = useMemo(() => {
    const all = ruleInfo?.rules ?? [];
    return all.filter((r) => {
      if (ruleCat !== 'all' && r.category !== ruleCat) return false;
      if (ruleSearch.trim()) {
        const q = ruleSearch.trim().toLowerCase();
        const hay = `${r.id} ${r.title} ${r.qsdaName ?? ''} ${r.description}`.toLowerCase();
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
              {info ? `Electron ${info.electron} · Node ${info.node} · ${info.platform}/${info.arch}` : 'загрузка…'}
            </span>
          </div>
          <div className="platform">
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
          {([['connect', 'Подключение'], ['analysis', 'Анализ'], ['rules', 'Правила']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
              {id === 'analysis' && analysis ? ` (${analysis.summary.findings.total})` : ''}
              {id === 'rules' && ruleInfo ? ` (${ruleInfo.total})` : ''}
            </button>
          ))}
        </nav>
      </header>

      {busy && <div className="busy">{busy}</div>}

      {tab === 'connect' && (
        <section className="card wide">
          <h2>Подключение к Qlik</h2>
          <div className="form">
            <label>
              URL движка
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://host/app/&lt;appId&gt;" />
              <span className="muted">Движок часто доступен только через хаб: wss://&lt;host&gt;/app/&lt;appId&gt; (443)</span>
            </label>
            <label>
              Пользователь (домен\логин)
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="CORP\user" />
            </label>
            <label>
              Пароль
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Cookie сессии хаба
              <input
                type="password"
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                placeholder="X-Qlik-Session=…"
              />
            </label>
            <label>
              XSRF-ключ хаба
              <input
                type="password"
                value={xrfKey}
                onChange={(e) => setXrfKey(e.target.value)}
                placeholder="X-Qlik-XrfKey: …"
              />
            </label>
            <label>
              CSRF-токен
              <input
                type="password"
                value={csrfToken}
                onChange={(e) => setCsrfToken(e.target.value)}
                placeholder="qlik-csrf-token=…"
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
              самоподписанный сертификат
            </label>
          </div>
          <div className="actions">
            <button onClick={() => void runDoctor()}>Проверить подключение</button>
            <button onClick={() => void loadApps()}>Загрузить список приложений</button>
            <button onClick={() => void analyzeFile()}>Анализ файла…</button>
          </div>

          {apps.length > 0 && (
            <div className="appList">
              <label>
                Приложение ({apps.length})
                <select value={appId} onChange={(e) => setAppId(e.target.value)}>
                  {apps.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title} {a.size ? `— ${Math.round(a.size / 1048576)} МБ` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => void analyzeSelected()}>
                Анализировать (платформа: {PLATFORMS.find((p) => p.id === platform)?.label})
              </button>
            </div>
          )}

          {doctorSteps.length > 0 && (
            <ul className="steps">
              {doctorSteps.map((s, i) => (
                <li key={i} className={s.status.toLowerCase()}>
                  <b>{s.name}</b>: {s.detail}
                  {s.hint && <div className="hint">→ {s.hint}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'analysis' && (
        <section className="card wide">
          <h2>
            Результаты анализа
            {analysis?.appName ? ` — ${analysis.appName}` : ''}
            {analysis?.file ? ` — ${analysis.file}` : ''}
          </h2>

          {analysis ? (
            <>
              <div className="cards">
                <div className="card">
                  <div className="card-num">{analysis.summary.findings.total}</div>
                  <div className="card-label">всего находок</div>
                </div>
                {categories.map((c) => (
                  <div className="card" key={c}>
                    <div className="card-num">{analysis.summary.findings.byCategory[c] ?? 0}</div>
                    <div className="card-label">{c}</div>
                  </div>
                ))}
                {SEVERITIES.map((s) => (
                  <div className="card" key={s.id}>
                    <div className="card-num">{analysis.summary.findings.bySeverity[s.id] ?? 0}</div>
                    <div className="card-label">{s.label.toLowerCase()}</div>
                  </div>
                ))}
              </div>

              {analysis.patch.script && (
                <>
                  <h3>Предлагаемые правки скрипта</h3>
                  <pre className="patch">{analysis.patch.script}</pre>
                </>
              )}

              <h3>Находки</h3>
              <div className="toolbar">
                {SEVERITIES.map((s) => (
                  <button
                    key={s.id}
                    className={sevFilter.has(s.id) ? 'active' : ''}
                    onClick={() => setSevFilter(toggle(sevFilter, s.id))}
                  >
                    {s.label}
                  </button>
                ))}
                <span className="sep" />
                <button className={catFilter.size === 0 ? 'active' : ''} onClick={() => setCatFilter(new Set())}>
                  Все категории
                </button>
                {categories.map((c) => (
                  <button
                    key={c}
                    className={catFilter.has(c) ? 'active' : ''}
                    onClick={() => setCatFilter(toggle(catFilter, c))}
                  >
                    {c}
                  </button>
                ))}
                <input
                  className="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по находкам…"
                />
                <span className="muted">показано {filtered.length} из {analysis.findings.length}</span>
              </div>

              <table className="findings">
                <thead>
                  <tr>
                    <th>Уровень</th><th>Правило</th><th>Категория</th><th>Находка</th><th>Объект</th><th>Рекомендация</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((f, i) => (
                    <tr key={`${f.ruleId}-${i}`}>
                      <td><span className={`pill ${f.severity}`}>{f.severity}</span></td>
                      <td><code>{f.ruleId}</code></td>
                      <td>{f.category}</td>
                      <td>
                        <b>{f.title}</b>
                        <div className="muted">{f.message}</div>
                        {f.detail && <div className="muted small">{f.detail}</div>}
                      </td>
                      <td>{f.target?.name ?? '—'}</td>
                      <td className="muted">{f.recommendation}</td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={6} className="muted">Ничего не найдено под текущими фильтрами.</td></tr>
                  )}
                </tbody>
              </table>

              {analysis.skipped?.map((s) => (
                <p key={s.capability} className="warn">Пропущено: {s.reason}</p>
              ))}
            </>
          ) : (
            <p className="muted">Анализ ещё не запускался. Откройте вкладку «Подключение».</p>
          )}
        </section>
      )}

      {tab === 'rules' && (
        <section className="card wide">
          <h2>Каталог правил ({ruleInfo?.total ?? 0})</h2>
          <div className="toolbar">
            <button className={ruleCat === 'all' ? 'active' : ''} onClick={() => setRuleCat('all')}>
              Все категории
            </button>
            {categories.map((c) => (
              <button key={c} className={ruleCat === c ? 'active' : ''} onClick={() => setRuleCat(c)}>
                {c}
              </button>
            ))}
            <input
              className="search"
              value={ruleSearch}
              onChange={(e) => setRuleSearch(e.target.value)}
              placeholder="Поиск по правилу или флагу QSDA…"
            />
            <span className="muted">показано {filteredRules.length}</span>
          </div>
          <table className="rules">
            <thead>
              <tr>
                <th>ID</th><th>Категория</th><th>Уровень</th><th>Правило</th>
                <th>Флаг QSDA</th><th>Платформы</th><th>Срабатываний</th>
              </tr>
            </thead>
            <tbody>
              {filteredRules.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.id}</code></td>
                  <td>{r.category}</td>
                  <td><span className={`pill ${r.severity}`}>{r.severity}</span></td>
                  <td title={r.description}>
                    <b>{r.title}</b>
                    <div className="muted small">{r.description}</div>
                  </td>
                  <td>
                    {r.qsdaUrl ? (
                      <a href={r.qsdaUrl} target="_blank" rel="noreferrer">{r.qsdaName}</a>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td className="muted small">
                    {(r.platforms ?? []).map((p) => (p === 'qlik-sense' ? 'Qlik Sense' : 'QlikView')).join(', ')}
                  </td>
                  <td><b>{countsByRule.get(r.id) ?? 0}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
