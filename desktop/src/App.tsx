import { useEffect, useState } from 'react';

type AppInfo = {
  appVersion: string; electron: string; chrome: string; node: string; v8: string;
  platform: string; arch: string; locale: string; cwd: string;
};

type RuleInfo = {
  total: number;
  categories: { name: string; count: number }[];
  rules: { id: string; category: string; severity: string; title: string; description: string }[];
};

type DoctorStep = { name: string; status: 'OK' | 'WARN' | 'FAIL'; detail: string; hint?: string };

type Finding = {
  ruleId: string; category: string; severity: string; title: string;
  message: string; recommendation: string;
};

type AnalysisResult = {
  file: string;
  summary: {
    findings: { total: number; byCategory: Record<string, number>; bySeverity: Record<string, number> };
    counts: Record<string, number>;
  };
  findings: Finding[];
  patch: { script: string };
  skipped: { capability: string; reason: string }[];
};

declare global {
  interface Window {
    qa: {
      appInfo(): Promise<AppInfo>;
      rules(): Promise<RuleInfo>;
      analyzeFile(path: string): Promise<AnalysisResult>;
      doctor(opts: { url: string; user?: string; password?: string; insecure?: boolean; cookie?: string; xrfKey?: string; csrfToken?: string }): Promise<{ steps: DoctorStep[]; failed: boolean }>;
      openDialog(): Promise<string | null>;
      onDoctorStep(cb: (step: DoctorStep) => void): () => void;
    };
  }
}

function groupByRule(findings: Finding[]): [string, Finding[]][] {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!map.has(f.ruleId)) map.set(f.ruleId, []);
    map.get(f.ruleId)!.push(f);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ruleInfo, setRuleInfo] = useState<RuleInfo | null>(null);
  const [busy, setBusy] = useState('');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [doctorSteps, setDoctorSteps] = useState<DoctorStep[]>([]);
  const [url, setUrl] = useState('wss://dc3-qliks-ap-03.onyx.local/app/7cd8b706-5b9e-4c96-b2fb-6b1ed3deeb20');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [cookie, setCookie] = useState('');
  const [xrfKey, setXrfKey] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [insecure, setInsecure] = useState(true);

  useEffect(() => {
    void window.qa.appInfo().then(setInfo);
    void window.qa.rules().then(setRuleInfo);
    // Пошаговый вывод диагностики приходит из main по мере готовности.
    return window.qa.onDoctorStep((step) => {
      setDoctorSteps((prev) => [...prev, step]);
    });
  }, []);

  async function pickAndAnalyze() {
    setBusy('Выбор файла…');
    const file = await window.qa.openDialog();
    if (!file) { setBusy(''); return; }
    setBusy(`Анализ ${file}…`);
    try {
      setAnalysis(await window.qa.analyzeFile(file));
    } catch (err) {
      setDoctorSteps([{ name: 'Анализ файла', status: 'FAIL', detail: String(err), hint: 'Проверьте формат файла' }]);
    }
    setBusy('');
  }

  async function runDoctor() {
    setBusy('Проверка подключения…');
    setDoctorSteps([]);
    try {
      const res = await window.qa.doctor({ url, user, password, insecure, cookie, xrfKey, csrfToken });
      setDoctorSteps(res.steps);
    } catch (err) {
      setDoctorSteps([{ name: 'Проверка подключения', status: 'FAIL', detail: String(err) }]);
    }
    setBusy('');
  }

  return (
    <div className="app">
      <header>
        <h1>Qlik Analyzer</h1>
        <span className="sub">Этап 0 — проверка среды, ядра и каналов IPC</span>
      </header>

      {busy && <div className="busy">{busy}</div>}

      <section className="cards">
        <div className="card">
          <h2>Среда</h2>
          {info ? (
            <table className="kv">
              <tbody>
                <tr><td>Electron</td><td>{info.electron}</td></tr>
                <tr><td>Chromium</td><td>{info.chrome}</td></tr>
                <tr><td>Node</td><td>{info.node}</td></tr>
                <tr><td>Платформа</td><td>{info.platform} / {info.arch}</td></tr>
                <tr><td>Версия приложения</td><td>{info.appVersion}</td></tr>
              </tbody>
            </table>
          ) : <p className="muted">загрузка…</p>}
        </div>

        <div className="card">
          <h2>Ядро анализа</h2>
          {ruleInfo ? (
            <>
              <p className="big">{ruleInfo.total} правил</p>
              <ul className="cats">
                {ruleInfo.categories.map((c) => (
                  <li key={c.name}><b>{c.count}</b> {c.name}</li>
                ))}
              </ul>
              <p className="muted">Ядро общее для десктопа, CLI и CI</p>
            </>
          ) : <p className="muted">загрузка…</p>}
        </div>

        <div className="card">
          <h2>Быстрая проверка</h2>
          <p className="muted">Анализ файла скрипта/приложения через IPC</p>
          <button onClick={() => void pickAndAnalyze()}>Выбрать файл и проанализировать</button>
          {analysis && (
            <div className="result">
              <p>
                <b>{analysis.summary.findings.total}</b> находок (
                {Object.entries(analysis.summary.findings.byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')})
              </p>
              {analysis.patch.script && <pre>{analysis.patch.script}</pre>}
              <div className="byRule">
                {groupByRule(analysis.findings).map(([ruleId, items]) => (
                  <details key={ruleId}>
                    <summary>
                      <code>{ruleId}</code> {items[0].title} <b>{items.length}</b>
                    </summary>
                    <ul>
                      {items.slice(0, 50).map((f, i) => (
                        <li key={i}>
                          <span className={`pill ${f.severity}`}>{f.severity}</span> {f.message}
                        </li>
                      ))}
                    </ul>
                    {items.length > 50 && <p className="muted">…и ещё {items.length - 50}</p>}
                  </details>
                ))}
              </div>
              {analysis.skipped.map((s) => <p key={s.capability} className="warn">{s.reason}</p>)}
            </div>
          )}
        </div>
      </section>

      <section className="card wide">
        <h2>Проверка подключения к Qlik Sense (doctor)</h2>
        <div className="form">
          <label>
            URL движка
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://host:4747/app/&lt;appId&gt;"
            />
            <span className="muted">Движок часто доступен только через хаб: wss://&lt;host&gt;/app/&lt;appId&gt; (443)</span>
          </label>
          <label>
            Пользователь (домен\логин)
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="CORP\\user" />
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
              placeholder="X-Qlik-Session=… (из DevTools браузера)"
            />
          </label>
          <label>
            XSRF-ключ хаба
            <input
              type="password"
              value={xrfKey}
              onChange={(e) => setXrfKey(e.target.value)}
              placeholder="X-Qlik-XrfKey: … (из DevTools → Network)"
            />
          </label>
          <label>
            CSRF-токен
            <input
              type="password"
              value={csrfToken}
              onChange={(e) => setCsrfToken(e.target.value)}
              placeholder="qlik-csrf-token=… (из URL WebSocket)"
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
            самоподписанный сертификат (--insecure)
          </label>
          <button onClick={() => void runDoctor()}>Проверить</button>
        </div>
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

      {ruleInfo && (
        <section className="card wide">
          <h2>Каталог правил</h2>
          <table className="rules">
            <thead>
              <tr><th>ID</th><th>Категория</th><th>Уровень</th><th>Правило</th></tr>
            </thead>
            <tbody>
              {ruleInfo.rules.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.id}</code></td>
                  <td>{r.category}</td>
                  <td><span className={`pill ${r.severity}`}>{r.severity}</span></td>
                  <td title={r.description}>{r.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
