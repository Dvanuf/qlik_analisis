/**
 * Main-процесс Electron.
 *
 * Здесь живёт ядро анализа (папка ../../src ядра проекта) — renderer получает
 * только данные через IPC и не имеет прямого доступа к файловой системе.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Ядро анализа (ESM-JS исходники собираются esbuild'ом в этот же бандл).
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { ALL_RULES, CATEGORIES } from '../../src/rules/index.js';
import { analyze } from '../../src/analyzer.js';
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
  const model = parseScript(text);
  return {
    loads: model.loads.map((l) => l.table),
    variables: model.variables.map((v) => v.name),
    comments: model.comments.length,
  };
});

ipcMain.handle('core:read-file', (_e, filePath: string) => readFileSync(resolve(filePath), 'utf8'));

function looksLikeText(filePath: string): boolean {
  try {
    const head = readFileSync(filePath).subarray(0, 4);
    return !(head[0] === 0x50 && head[1] === 0x4b);
  } catch {
    return true;
  }
}
