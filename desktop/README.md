# Qlik Analyzer — десктопное приложение (Electron + React + TypeScript)

Этап 0: подтверждение среды, каркас приложения, проверка упаковки под Windows и macOS.

## Что уже работает

| Проверка | Результат |
|---|---|
| Electron устанавливается и запускается | ✅ Electron 45.0.0, Chromium 156.0.8078.48, Node 24.22.0 |
| React + TypeScript + Vite собираются | ✅ renderer 225 КБ (70 КБ gzip) |
| Ядро анализа работает внутри main-процесса | ✅ 38 правил, 4 категории — из бандла, без node_modules |
| IPC main ↔ renderer | ✅ `app:info`, `core:rules`, `core:analyze-file`, `core:doctor`, диалоги |
| Автоматическая проверка приложения | ✅ `npm run smoke` → скриншот окна + отчёт в консоли |
| Упаковка macOS | ✅ `Qlik Analyzer.app` (arm64) и `.zip` |
| Упаковка Windows **из macOS** | ✅ `Qlik Analyzer-0.1.0-x64.exe` (NSIS-инсталлятор, 107 МБ) |
| CLI и ядро не сломаны | ✅ 69/69 тестов ядра зелёные |

## Команды

```bash
export PATH="$(cd ../.tools/node/bin && pwd):$PATH"   # Node 20+ (в проекте лежит локально)
cd desktop

npm install
npm run build          # main+preload (esbuild) и renderer (vite)
npm start              # запуск приложения
npm run smoke          # автопроверка: рендер + IPC + ядро, скриншот в out/smoke.png
npm run typecheck      # проверка типов
npm run package:mac    # сборка под macOS (--dir)
npm run package:win    # сборка под Windows (--dir)
npx electron-builder --win --x64 --config.win.target=nsis   # NSIS-инсталлятор .exe
```

## Структура

```
desktop/
  electron/main.ts       main-процесс: окно, IPC, safeStorage (этап 2), smoke-проверка
  electron/preload.ts    безопасный мост contextBridge
  src/                   renderer: React + TS (App.tsx, styles.css, main.tsx)
  scripts/build-main.mjs esbuild-сборка main/preload (ядро ../../src попадает в бандл)
  electron-builder.yml   цели: mac (dir/zip), win (dir/zip/nsis)
  release/               артефакты сборки
```

Ядро анализа (`../src`) не дублируется: esbuild включает его в main-бандл, поэтому
десктоп, CLI и CI используют один и тот же код правил.

## Важные находки этапа 0

1. **Схема enigma.js должна быть в бандле.** В упакованном приложении `node_modules` нет,
   и `require.resolve('enigma.js/schemas/…')` падает. Решение: схема импортируется в ядро
   статически (`import embeddedSchema from 'enigma.js/schemas/12.34.11.json'`) и вшивается
   в бандл; путь через `require.resolve` остался запасным вариантом.
2. **`import.meta.url` не выживает в CommonJS-бандле Electron.** `createRequire` в ядре
   переведён в ленивый вызов — иначе приложение падало на старте.
3. **`app.asar` доступен только для чтения** — скриншоты и отчёты пишутся в
   `app.getPath('userData')`.
4. **npm 11 не выполняет install-скрипты автоматически** (`esbuild`, `electron`) — бинарник
   Electron пришлось качать вручную: `node node_modules/electron/install.js`.
5. **NSIS-инсталлятор для Windows собирается с macOS** (wine не требуется) — это снимает
   риск «нужен Windows, чтобы собрать Windows-версию».

## Матрица целей сборки

| Цель | Статус | Артефакт |
|---|---|---|
| macOS arm64 (Apple Silicon) | ✅ | `Qlik Analyzer-0.1.0-arm64-mac.zip` |
| macOS x64 (Intel) | ⬜ этап 6 | требует `--x64` |
| Windows x64 (NSIS-инсталлятор) | ✅ собран, не проверен на стенде | `Qlik Analyzer-0.1.0-x64.exe` |
| Windows x64 (распакованный) | ✅ | `release/win-unpacked/` |
| Подпись кода (Windows/macOS) | ⬜ этап 6 | нужен сертификат; сейчас Electron идёт без подписи (исполняемый файл помечается как неподписанный) |
| Иконка приложения | ⬜ этап 6 | сейчас используется стандартная иконка Electron |

## Что проверено, а что нет

**Проверено:** запуск и рендер на macOS arm64, работа IPC, работа ядра из бандла,
автопроверка `npm run smoke`, сборка всех трёх артефактов, отсутствие регрессий в ядре.

**Не проверено (нужен ваш стенд):**
- запуск `.exe` на Windows (собран на macOS, нужно развернуть и проверить);
- авторизация на вашем Qlik Sense (в UI уже есть форма `doctor` — подставьте
  свой URL движка `wss://<host>/app/<appId>` или нажмите «восстановить»);
- подпись кода и отсутствие блокировок SmartScreen/Gatekeeper.

## Дальше (этап 1–2 по плану)

- экран «Подключения» со списком серверов и сохранением учётных данных через
  Electron `safeStorage` (DPAPI на Windows, Keychain на macOS) — пароль в открытом виде
  не хранится никогда;
- инкрементальный импорт конфигурации `qlik-analyzer.config.json` в приложение;
- история анализов в `userData`.
