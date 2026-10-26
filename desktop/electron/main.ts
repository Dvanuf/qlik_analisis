/**
 * Main-процесс Electron.
 *
 * Здесь живёт ядро анализа (папка ../../src ядра проекта) — renderer получает
 * только данные через IPC и не имеет прямого доступа к файловой системе.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import enigma from 'enigma.js';
import NodeWebSocket from 'ws';
import { extractFromEngine, buildEngineUrl, ENIGMA_SCHEMA } from '../../src/extract/engine.js';
import { listApps } from '../../src/extract/session.js';
import { appUrl } from '../../src/extract/url.js';
import { analyze } from '../../src/analyzer.js';
import { ALL_RULES, CATEGORIES } from '../../src/rules/index.js';
import { extractFromFile } from '../../src/connectors/file.js';
import { renderHtml } from '../../src/report/html.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { parseScript } from '../../src/script/parse.js';
import { maskSecrets, maskUrl } from '../../src/logging/mask.js';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Qlik Analyzer',
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const indexHtml = resolve(__dirname, '../renderer/index.html');
  if (existsSync(indexHtml)) {
    void mainWindow.loadFile(indexHtml);
  } else {
    mainWindow.loadURL('data:text/html;charset=utf-8,<h1>Сборка renderer не найдена</h1>');
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  if (process.env.QA_SMOKE) void runSmokeCheck();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Автоматическая проверка приложения (этап 0): рендер, IPC, работа ядра.
 * Запуск: npm run smoke  ->  out/smoke.png + вывод в консоль.
 */
async function runSmokeCheck(): Promise<void> {
  const win = mainWindow;
  if (!win) return;
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 1500));

        // Открываем вкладку «Правила» — там каталог с описаниями и рекомендациями.
        await win.webContents.executeJavaScript(`
          (function () {
            var btn = Array.prototype.slice.call(document.querySelectorAll('.tabs button'))
              .filter(function (b) { return b.textContent.indexOf('Правила') === 0; })[0];
            if (btn) btn.click();
            return true;
          })()
        `);
        await new Promise((r) => setTimeout(r, 900));

        const catalog = await win.webContents.executeJavaScript(`
          (function () {
            var table = document.querySelector('table.rules');
            if (!table) return JSON.stringify({ rows: 0, heads: [], externalLinks: 0 });
            return JSON.stringify({
              rows: table.querySelectorAll('tbody tr').length,
              heads: Array.prototype.slice.call(table.querySelectorAll('thead th'))
                .map(function (t) { return t.textContent.trim(); }),
              externalLinks: table.querySelectorAll('a[href^="http"]').length
            });
          })()
        `);

        // Вкладка «Подключение»: пошаговый сценарий и главная кнопка.
        await win.webContents.executeJavaScript(`
          (function () {
            var btn = Array.prototype.slice.call(document.querySelectorAll('.tabs button'))
              .filter(function (b) { return b.textContent.indexOf('Подключение') === 0; })[0];
            if (btn) btn.click();
            return true;
          })()
        `);
        await new Promise((r) => setTimeout(r, 600));
        const connect = await win.webContents.executeJavaScript(`
          (function () {
            return JSON.stringify({
              steps: document.querySelectorAll('.wizard .step').length,
              current: document.querySelectorAll('.wizard .step.current').length,
              mainButtons: document.querySelectorAll('.actions button.primary').length,
              platformLabel: (document.querySelector('.platform-label') || {}).textContent || ''
            });
          })()
        `);

        const image = await win.webContents.capturePage();
        // В упакованном приложении app.asar доступен только для чтения —
        // скриншот пишем в каталог пользователя.
        const out = app.isPackaged
          ? resolve(app.getPath('userData'), 'qa-smoke')
          : resolve(app.getAppPath(), 'out');
        if (!existsSync(out)) mkdirSync(out, { recursive: true });
        writeFileSync(resolve(out, 'smoke.png'), image.toPNG());

        const fixture = resolve(app.getAppPath(), '../test/fixtures/app-graph.json');
        let findingsOnFixture = null;
        if (existsSync(fixture)) {
          const graph = JSON.parse(readFileSync(fixture, 'utf8'));
          findingsOnFixture = analyze(graph as never, {}).findings.length;
        }

        console.log('SMOKE OK', JSON.stringify({
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          rules: ALL_RULES.length,
          categories: CATEGORIES,
          findingsOnFixture,
          catalog: JSON.parse(String(catalog)),
          connect: JSON.parse(String(connect)),
          screenshot: resolve(out, 'smoke.png'),
        }, null, 2));
      } catch (err) {
        console.error('SMOKE FAILED', err);
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    })();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------ IPC ---------------------------------- */

ipcMain.handle('app:info', () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  locale: app.getLocale(),
  cwd: process.cwd(),
}));

ipcMain.handle('core:rules', () => ({
  total: ALL_RULES.length,
  categories: CATEGORIES.map((c) => ({
    name: c,
    count: ALL_RULES.filter((r) => r.category === c).length,
  })),
  rules: ALL_RULES.map((r) => ({
    id: r.id,
    category: r.category,
    severity: r.severity,
    title: r.title,
    description: r.description,
    recommendation: r.recommendation,
    platforms: r.platforms,
  })),
}));

ipcMain.handle('core:analyze-file', async (_e, filePath: string) => {
  const full = resolve(filePath);
  const isQvw = full.toLowerCase().endsWith('.qvw');
  const isQvsApp = full.toLowerCase().endsWith('.qvs');
  const graph = await extractFromFile({
    file: full,
    fileType: isQvw ? 'qvw' : (isQvsApp && !looksLikeText(full) ? 'qvs' : 'script'),
  });
  const result = analyze(graph as never, {});
  return {
    file: full,
    summary: result.summary,
    findings: result.findings,
    suppressed: result.suppressed,
    patch: result.patch,
    script: (graph as { script?: string }).script ?? '',
    skipped: result.summary.skipped,
  };
});

ipcMain.handle('core:doctor', async (_e, opts: {
  url: string; user?: string; password?: string; qlikUser?: string; insecure?: boolean;
  appId?: string; cookie?: string; xrfKey?: string; csrfToken?: string;
}) => {
  // Шаги отправляем в renderer по мере появления — иначе при «молчащем» сервере
  // пользователь не видит ничего и не понимает, что происходит.
  const { steps, failed } = await runDoctor(
    {
      url: opts.url,
      user: opts.user,
      password: opts.password,
      qlikUser: opts.qlikUser,
      insecure: opts.insecure,
      cookie: opts.cookie,
      xrfKey: opts.xrfKey,
      csrfToken: opts.csrfToken,
    },
    (step) => {
      mainWindow?.webContents.send('doctor:step', step);
    },
  );
  return { steps, failed };
});

ipcMain.handle('core:open-dialog', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Выберите файл для анализа',
    properties: ['openFile'],
    filters: [
      { name: 'Qlik-файлы', extensions: ['qvs', 'qvw', 'txt'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('core:preview-script', (_e, text: string) => {
  const model = parseScript(text) as { loads: { table: string }[]; variables: { name: string }[]; comments: unknown[] };
  return {
    loads: model.loads.map((l) => l.table),
    variables: model.variables.map((v) => v.name),
    comments: model.comments.length,
  };
});

ipcMain.handle('core:read-file', (_e, filePath: string) => readFileSync(resolve(filePath), 'utf8'));

/**
 * Открывает сессию к движку Qlik и отдаёт глобальный объект.
 * Один и тот же путь используется для списка приложений и анализа.
 */
async function openQix(opts: {
  url: string; cookie?: string; xrfKey?: string; csrfToken?: string; user?: string;
  password?: string; insecure?: boolean; appId?: string;
}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.xrfKey) headers['X-Qlik-XrfKey'] = opts.xrfKey;
  if (opts.user && opts.password) {
    headers.Authorization = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
  }
  const url = buildEngineUrl(opts.url, { csrfToken: opts.csrfToken, appId: opts.appId });
  const session = enigma.create({
    schema: ENIGMA_SCHEMA,
    url,
    createSocket: (u: string) => new NodeWebSocket(u, {
      headers,
      ...(opts.insecure ? { rejectUnauthorized: false } : {}),
    }) as unknown as WebSocket,
  });
  const qix = await session.open();
  return { qix, session, url };
}

/** Пакетный анализ всех приложений сервера с прогрессом и возможностью отмены. */
let batchCancelRequested = false;

ipcMain.handle('core:analyze-all', async (_e, opts: {
  url: string; cookie?: string; xrfKey?: string; csrfToken?: string;
  user?: string; password?: string; insecure?: boolean; platform?: string;
  pauseMs?: number; useCache?: boolean; appIds?: string[];
}) => {
  const { analyzeAll } = await import('../../src/batch.js');
  batchCancelRequested = false;
  const { results, totals } = await analyzeAll({
    url: opts.url,
    cookie: opts.cookie,
    xrfKey: opts.xrfKey,
    csrfToken: opts.csrfToken,
    user: opts.user,
    password: opts.password,
    insecure: opts.insecure,
    // undefined = платформа определяется автоматически по типу API экстрактора.
    platform: opts.platform,
    rules: { platform: opts.platform },
    pauseMs: opts.pauseMs ?? 1000,
    // Пустой список — анализируем все приложения сервера.
    appIds: opts.appIds?.length ? opts.appIds : undefined,
    cacheDir: resolve(app.getPath('userData'), 'cache'),
    useCache: opts.useCache !== false,
    shouldStop: () => batchCancelRequested,
    onProgress: (p) => mainWindow?.webContents.send('batch:progress', p),
  });
  return { results, totals };
});

ipcMain.handle('core:cancel-batch', () => {
  batchCancelRequested = true;
  return true;
});

/** Экспорт отчёта в HTML (и JSON) и открытие его в браузере. */
ipcMain.handle('core:export-report', async (_e, payload: {
  appName: string; summary: unknown; findings: unknown; patch: unknown; ruleStats: unknown;
}) => {
  const dir = resolve(app.getPath('documents'), 'QlikAnalyzer');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safeName = String(payload.appName || 'app').replace(/[^\wа-яА-Я ._-]/g, '_').slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const htmlPath = resolve(dir, `${safeName} ${stamp}.html`);
  const jsonPath = resolve(dir, `${safeName} ${stamp}.json`);

  const result = {
    summary: payload.summary,
    findings: payload.findings,
    patch: payload.patch,
    ruleStats: payload.ruleStats,
  };
  writeFileSync(htmlPath, renderHtml(result), 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await shell.openPath(htmlPath);
  return { htmlPath, jsonPath };
});

/** Экспорт сводного отчёта по пакетному прогону (HTML + JSON). */
ipcMain.handle('core:export-summary', async (_e, payload: {
  totals: unknown; results: unknown; platform?: string;
}) => {
  const { renderSummaryHtml } = await import('../../src/report/summary.js');
  const dir = resolve(app.getPath('documents'), 'QlikAnalyzer');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const htmlPath = resolve(dir, `Сводный анализ ${stamp}.html`);
  const jsonPath = resolve(dir, `Сводный анализ ${stamp}.json`);

  const html = renderSummaryHtml({
    results: payload.results as never,
    totals: payload.totals as never,
    platform: payload.platform,
  });
  writeFileSync(htmlPath, html, 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await shell.openPath(htmlPath);
  return { htmlPath, jsonPath };
});

/** Сессионная cookie хаба и ключи хранятся в зашифрованном виде (safeStorage). */
const CREDS_FILE = 'hub-credentials.bin';

ipcMain.handle('core:save-credentials', (_e, creds: {
  hubUrl: string; cookie: string; xrfKey?: string; csrfToken?: string;
}) => {
  const blob = safeStorage.encryptString(JSON.stringify(creds));
  writeFileSync(resolve(app.getPath('userData'), CREDS_FILE), blob);
  return true;
});

ipcMain.handle('core:load-credentials', () => {
  const file = resolve(app.getPath('userData'), CREDS_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(file)));
  } catch {
    return null;
  }
});

ipcMain.handle('core:clear-credentials', () => {
  const file = resolve(app.getPath('userData'), CREDS_FILE);
  if (existsSync(file)) rmSync(file);
  return true;
});

/** Хосты, для которых разрешен самоподписанный сертификат (только по явному флагу). */
const allowedInsecureHosts = new Set<string>();

app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  try {
    const host = new URL(url).hostname;
    if (allowedInsecureHosts.has(host)) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch { /* некорректный URL — обрабатываем как обычно */ }
  callback(false);
});

/**
 * Лог входа в хаб — пишем и в консоль, и в файл, чтобы разобраться без переустановки.
 * Все строки маскируются: cookie, CSRF-токен и XSRF-ключ в журнал попадать не должны.
 */
function hubLog(...args: unknown[]): void {
  const raw = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = maskSecrets(`[${new Date().toISOString()}] ${raw}`);
  console.log(line);
  try {
    const file = resolve(app.getPath('userData'), 'hub-login.log');
    if (!existsSync(file)) writeFileSync(file, '', 'utf8');
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch { /* лог не критичен */ }
}

/**
 * Вход в хаб: открываем окно браузера, пользователь вводит доменный пароль,
 * приложение само перехватывает cookie сессии и ключи рукопожатия.
 */
ipcMain.handle('core:open-hub', async (_e, opts: { hubUrl: string; appId?: string; insecure?: boolean }) => {
  const partition = 'persist:qlik-hub';
  const captured: { csrfToken?: string; xrfKey?: string; wsUrl?: string } = {};
  let host = '';
  try {
    host = new URL(opts.hubUrl).hostname;
  } catch { /* оставим пустым */ }
  if (opts.insecure && host) allowedInsecureHosts.add(host);

  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    title: 'Вход в Qlik — авторизуйтесь в браузере',
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
  });

  // --- Перехват рукопожатия движка ---
  // CSRF-токен и XSRF-ключ ходят и в WS-рукопожатии, и в HTTP-запросах к движку.
  // Ловим оба источника: если соединение с движком переиспользуется и нового
  // WS не создаётся, токен всё равно виден в query-параметрах запросов.
  const grabTokenFromUrl = (raw: string): void => {
    try {
      const token = new URL(raw).searchParams.get('qlik-csrf-token');
      if (token) captured.csrfToken = token;
    } catch { /* некорректный URL — пропускаем */ }
  };
  const grabXrfFromHeaders = (headers: Record<string, string> | undefined): void => {
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (k.toLowerCase() === 'x-qlik-xrfkey' && v) captured.xrfKey = v;
    }
  };
  const onDebuggerMessage = (
    _evt: unknown,
    method: string,
    params: Record<string, unknown>,
  ): void => {
    if (method === 'Network.webSocketCreated') {
      const url = String((params as { url?: string })?.url ?? '');
      captured.wsUrl = url;
      grabTokenFromUrl(url);
      // В журнал — только адрес без CSRF-токена.
      hubLog('WS создан:', maskUrl(url));
    }
    if (method === 'Network.webSocketWillSendHandshakeRequest') {
      grabXrfFromHeaders((params as { request?: { headers?: Record<string, string> } })?.request?.headers);
    }
    if (method === 'Network.requestWillBeSent') {
      const req = (params as { request?: { url?: string; headers?: Record<string, string> } })?.request;
      grabTokenFromUrl(String(req?.url ?? ''));
      grabXrfFromHeaders(req?.headers);
    }
  };

  // 1) Сначала грузим страницу: до первой навигации у Electron нет цели для
  //    CDP («target closed while handling command») — окно остаётся белым.
  const target = opts.appId
    ? `${opts.hubUrl}/sense/app/${opts.appId}/overview`
    : `${opts.hubUrl}/sense/app`;
  hubLog('открываем:', target);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    hubLog('did-fail-load:', code, desc, maskUrl(String(url ?? '')));
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) hubLog('консоль страницы:', message);
  });
  win.webContents.on('did-finish-load', () => {
    hubLog('страница загружена:', maskUrl(win.webContents.getURL()), '|', win.webContents.getTitle());
  });
  await win.loadURL(target);

  // 2) Подключаем отладчик и перезагружаем страницу: рукопожатие движка
  //    гарантированно попадёт в перехват.
  let hooked = false;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Network.enable');
      if (!hooked) {
        win.webContents.debugger.on('message', onDebuggerMessage);
        hooked = true;
      }
      hubLog('отладчик подключён, попытка', attempt, '— перезагружаем страницу');
      await win.reload();
      break;
    } catch (err) {
      hubLog('отладчик: попытка', attempt, 'не удалась:', (err as Error)?.message ?? err);
      try { win.webContents.debugger.detach(); } catch { /* уже отключён */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // 3) Ждём cookie сессии: она появляется после успешного входа в хаб.
  const sessionCookie = await new Promise<{ name: string; value: string } | null>((resolvePromise) => {
    const started = Date.now();
    let settled = false;
    const finish = (value: { name: string; value: string } | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolvePromise(value);
    };
    const timer = setInterval(async () => {
      try {
        const cookies = await win.webContents.session.cookies.get({ url: opts.hubUrl });
        const session = cookies.find((c) => c.name.toLowerCase() === 'x-qlik-session');
        hubLog('ожидание cookie: найдено [', cookies.map((c) => c.name).join(', ') || '—',
          '] | CSRF-токен:', captured.csrfToken ? '✓' : '✗');
        if (session) { finish(session); return; }
      } catch (err) {
        hubLog('не удалось прочитать cookie:', (err as Error)?.message ?? err);
      }
      if (Date.now() - started > 300000) finish(null);
    }, 2000);
    win.on('closed', () => finish(null));
  });

  // 4) Cookie есть, а CSRF-токена нет: движок не открыл новое WS (соединение
  //    переиспользовано). Перезагружаем страницу — рукопожатие повторится.
  if (sessionCookie && !captured.csrfToken) {
    hubLog('cookie получена, но CSRF-токен не перехвачен — перезагружаем страницу');
    try {
      await win.reload();
    } catch (err) {
      hubLog('перезагрузка не удалась:', (err as Error)?.message ?? err);
    }
    const until = Date.now() + 20000;
    while (!captured.csrfToken && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const result = sessionCookie
    ? {
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      xrfKey: captured.xrfKey,
      csrfToken: captured.csrfToken,
      wsUrl: captured.wsUrl,
    }
    : null;

  hubLog('итог входа: cookie =', result?.cookie ? '✓' : '✗',
    '| CSRF =', result?.csrfToken ? '✓' : '✗',
    '| XSRF =', result?.xrfKey ? '✓' : '✗');

  try { win.webContents.debugger.detach(); } catch { /* уже отключён */ }
  if (!win.isDestroyed()) win.close();
  return result;
});

/** Список приложений, доступных на сервере. */
ipcMain.handle('core:list-apps', async (_e, opts: {
  url: string; cookie?: string; xrfKey?: string; csrfToken?: string; user?: string;
  password?: string; insecure?: boolean;
}) => {
  try {
    // Общий код ядра: сам выбирает метод — GetAppList для Qlik Sense,
    // GetDocList для QlikView (на «чужой» метод сервер отвечает «Method not found»).
    // Сессию открывает сам listApps: лишняя сессия здесь только мешала бы
    // (движок не отдаёт два открытых документа подряд).
    return await listApps(opts);
  } catch (err) {
    return { error: maskSecrets(String((err as Error)?.message ?? err)) };
  }
});

/** Полный анализ приложения на сервере. */
ipcMain.handle('core:analyze-app', async (_e, opts: {
  url: string; appId: string; cookie?: string; xrfKey?: string; csrfToken?: string;
  user?: string; password?: string; insecure?: boolean; platform?: string;
}) => {
  const graph = await extractFromEngine({
    // Адрес строго под выбранное приложение: в URL из поля может стоять
    // идентификатор другого приложения — открылось бы не то.
    url: appUrl(opts.url, opts.appId),
    appId: opts.appId,
    cookie: opts.cookie,
    xrfKey: opts.xrfKey,
    csrfToken: opts.csrfToken,
    user: opts.user,
    password: opts.password,
    insecure: opts.insecure,
  });
  const result = analyze(graph as never, { platform: opts.platform });
  return {
    appName: result.summary.appName,
    appId: result.summary.appId,
    summary: result.summary,
    findings: result.findings,
    suppressed: result.suppressed,
    patch: result.patch,
    ruleStats: result.ruleStats,
    script: (graph as { script?: string }).script ?? '',
  };
});

function looksLikeText(filePath: string): boolean {
  try {
    const head = readFileSync(filePath).subarray(0, 4);
    return !(head[0] === 0x50 && head[1] === 0x4b);
  } catch {
    return true;
  }
}
