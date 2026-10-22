/**
 * Проверка механизма входа в хаб: открываем страницу приложения с готовой
 * сессионной cookie (тестовая), перехватываем WebSocket-рукопожатие движка
 * и печатаем, что удалось получить: CSRF-токен, XSRF-ключ, cookie.
 *
 * Запуск: electron scripts/test-hub-login.mjs <hubUrl> <appId> <cookie>
 */
import { app, BrowserWindow } from 'electron';

const [hubUrl, appId, cookieValue] = process.argv.slice(2);
const partition = 'persist:qlik-hub-test';
const allowed = new Set([new URL(hubUrl).hostname]);

app.on('certificate-error', (event, _wc, url, _err, _cert, callback) => {
  try {
    if (allowed.has(new URL(url).hostname)) { event.preventDefault(); callback(true); return; }
  } catch { /* ignore */ }
  callback(false);
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
  });

  // Ставим сессионную cookie так же, как это делает браузер после входа.
  // Если передан "-", проверяем поведение БЕЗ сессии (что видит новый пользователь).
  const url = new URL(hubUrl);
  if (cookieValue && cookieValue !== '-') {
    await win.webContents.session.cookies.set({
      url: hubUrl,
      name: 'X-Qlik-Session',
      value: cookieValue,
      domain: url.hostname,
      path: '/',
      secure: true,
    });
    console.log('>> cookie подставлена');
  } else {
    console.log('>> проверка БЕЗ сессии (как у нового пользователя)');
  }

  win.webContents.on('did-fail-load', (_e, code, desc, u) => {
    console.log('>> did-fail-load:', code, desc, u);
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log('>> консоль страницы:', message, `(${source}:${line})`);
  });

  const captured = { csrfToken: null, xrfKey: null, wsUrl: null, cookie: null };

  await win.loadURL(`${hubUrl}/sense/app/${appId}/overview`);

  // Отладчик подключаем после первой загрузки и перезагружаем страницу:
  // тогда рукопожатие движка гарантированно попадёт в перехват.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Network.enable');
      win.webContents.debugger.on('message', (_e, method, params) => {
        if (method === 'Network.requestWillBeSent') {
          const u = String(params?.request?.url ?? '');
          if (u.includes('xrfkey') || u.includes('csrf')) {
            console.log('>> запрос с ключом:', u.slice(0, 160));
            const h = params?.request?.headers ?? {};
            for (const [k, v] of Object.entries(h)) {
              if (k.toLowerCase().includes('xrf') || k.toLowerCase().includes('csrf')) {
                console.log('   заголовок', k, '=', v);
              }
            }
          }
        }
        if (method === 'Network.webSocketCreated') {
          captured.wsUrl = params.url;
          try {
            captured.csrfToken = new URL(params.url).searchParams.get('qlik-csrf-token');
          } catch { /* ignore */ }
          console.log('>> WS создан:', params.url);
        }
        if (method === 'Network.webSocketWillSendHandshakeRequest') {
          const h = params.request?.headers ?? {};
          for (const [k, v] of Object.entries(h)) {
            if (k.toLowerCase() === 'x-qlik-xrfkey') captured.xrfKey = v;
          }
          console.log('>> заголовки рукопожатия:', JSON.stringify(h).slice(0, 300));
        }
      });
      console.log('>> отладчик подключён с попытки', attempt);
      await win.reload();
      break;
    } catch (e) {
      console.log('попытка', attempt, 'не удалась:', e.message);
      try { win.webContents.debugger.detach(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  await new Promise((r) => setTimeout(r, 15000));
  console.log('>> текущий URL окна:', win.webContents.getURL());
  console.log('>> заголовок окна:', win.webContents.getTitle());

  const cookies = await win.webContents.session.cookies.get({ url: hubUrl });
  const s = cookies.find((c) => c.name === 'X-Qlik-Session');
  captured.cookie = s ? `${s.name}=${s.value}` : null;

  console.log('\n=== РЕЗУЛЬТАТ ===');
  console.log('cookie:     ', captured.cookie ? 'получена ✓' : 'нет ✗');
  console.log('csrf-token: ', captured.csrfToken ?? 'нет ✗');
  console.log('xrf-key:    ', captured.xrfKey ?? 'нет ✗');
  app.quit();
});
