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
import { analyze } from '../../src/analyzer.js';
import { ALL_RULES, CATEGORIES } from '../../src/rules/index.js';
import { extractFromFile } from '../../src/connectors/file.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { parseScript } from '../../src/script/parse.js';

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
    qsdaName: r.qsdaName,
    qsdaUrl: r.qsdaUrl,
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
    patch: result.patch,
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

/** Лог входа в хаб — пишем и в консоль, и в файл, чтобы разобраться без переустановки. */
function hubLog(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
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

  // Отладчик подключаем с повторами: до первой загрузки цели «target closed».
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Network.enable');
      win.webContents.debugger.on('message', (_evt, method, params: Record<string, unknown>) => {
        if (method === 'Network.webSocketCreated') {
          const url = String((params as { url?: string })?.url ?? '');
          captured.wsUrl = url;
          try {
            captured.csrfToken = new URL(url).searchParams.get('qlik-csrf-token') ?? captured.csrfToken;
          } catch { /* некорректный URL — пропускаем */ }
        }
        if (method === 'Network.webSocketWillSendHandshakeRequest') {
          const headers = (params as { request?: { headers?: Record<string, string> } })?.request?.headers ?? {};
          for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === 'x-qlik-xrfkey' && v) captured.xrfKey = v;
          }
        }
      });
      break;
    } catch {
      try { win.webContents.debugger.detach(); } catch { /* уже отключён */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const target = opts.appId
    ? `${opts.hubUrl}/sense/app/${opts.appId}/overview`
    : `${opts.hubUrl}/sense/app`;
  hubLog('открываем:', target);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    hubLog('did-fail-load:', code, desc, url);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[hub] консоль страницы:', message);
  });
  win.webContents.on('did-finish-load', () => {
    hubLog('страница загружена:', win.webContents.getURL(), '|', win.webContents.getTitle());
  });
  await win.loadURL(target);

  // Ждём cookie сессии (появляется после успешного входа) и CSRF-токен
  // (берётся из рукопожатия движка, которое страница приложения открывает сама).
  const result = await new Promise<{ cookie: string; xrfKey?: string; csrfToken?: string; wsUrl?: string } | null>((resolvePromise) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      const cookies = await win.webContents.session.cookies.get({ url: opts.hubUrl });
      const session = cookies.find((c) => c.name === 'X-Qlik-Session');
      const hasToken = Boolean(captured.csrfToken);
      if (session && (hasToken || Date.now() - started > 25000)) {
        clearInterval(timer);
        resolvePromise({
          cookie: `${session.name}=${session.value}`,
          xrfKey: captured.xrfKey,
          csrfToken: captured.csrfToken,
          wsUrl: captured.wsUrl,
        });
        return;
      }
      if (Date.now() - started > 300000) { clearInterval(timer); resolvePromise(null); }
    }, 2000);
    win.on('closed', () => { clearInterval(timer); resolvePromise(null); });
  });

  try { win.webContents.debugger.detach(); } catch { /* уже отключён */ }
  if (!win.isDestroyed()) win.close();
  return result;
});

/** Список приложений, доступных на сервере. */
ipcMain.handle('core:list-apps', async (_e, opts: {
  url: string; cookie?: string; xrfKey?: string; csrfToken?: string; user?: string;
  password?: string; insecure?: boolean;
}) => {
  let session: { close: () => Promise<void> } | null = null;
  try {
    const conn = await openQix(opts);
    session = conn.session;
    const list = await (conn.qix as unknown as { getDocList?: () => Promise<unknown> }).getDocList?.();
    const items = (Array.isArray(list)
      ? list
      : ((list as { qItems?: unknown[] })?.qItems ?? [])) as {
      qDocId?: string; qTitle?: string; qDocName?: string; qFileSize?: number;
    }[];
    return items.map((d) => ({
      id: d.qDocId ?? '',
      title: d.qTitle ?? d.qDocName ?? '',
      size: d.qFileSize ?? null,
    }));
  } catch (err) {
    return { error: String((err as Error)?.message ?? err) };
  } finally {
    try { await session?.close(); } catch { /* закрываем мягко */ }
  }
});

/** Полный анализ приложения на сервере. */
ipcMain.handle('core:analyze-app', async (_e, opts: {
  url: string; appId: string; cookie?: string; xrfKey?: string; csrfToken?: string;
  user?: string; password?: string; insecure?: boolean; platform?: string;
}) => {
  const graph = await extractFromEngine({
    url: opts.url,
    appId: opts.appId,
    cookie: opts.cookie,
    xrfKey: opts.xrfKey,
    csrfToken: opts.csrfToken,
    user: opts.user,
    password: opts.password,
    insecure: opts.insecure,
  });
  const result = analyze(graph as never, { platform: opts.platform ?? 'qlikview' });
  return {
    appName: result.summary.appName,
    summary: result.summary,
    findings: result.findings,
    patch: result.patch,
    ruleStats: result.ruleStats,
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
