# Состояние проекта qlik-analyzer — передача контекста

Документ отвечает на вопрос «с чего начать новую задачу». Правила работы с AI —
в [`AGENTS.md`](../AGENTS.md), история версий — в [`CHANGELOG.md`](../CHANGELOG.md).

**Обновлено:** 26.10.2026 · **Текущая версия:** 0.5.3 (тег `v0.5.3`)

---

## 1. Где что лежит

| Что | Путь |
|---|---|
| Исходники | `/Users/anufriev_d_v/.cline/data/workspaces/chat/qlik-analyzer` |
| Архив всех сборок | `<проект>/desktop/release/` |
| Последняя сборка на рабочем столе | `/Users/anufriev_d_v/Desktop/Qlik Analyzer-0.5.3-{arm64.dmg,x64.exe}` |
| Лог входа в хаб | `~/Library/Application Support/qlik-analyzer-desktop/hub-login.log` |
| Настройки правил | `~/Library/Application Support/qlik-analyzer-desktop/rules.json` |
| История прогонов | `~/Library/Application Support/qlik-analyzer-desktop/history.sqlite` |
| Учётные данные хаба (зашифрованы) | `~/Library/Application Support/qlik-analyzer-desktop/hub-credentials.bin` |

---

## 2. Что сделано (0.1.13 → 0.5.3)

| Версия | Суть |
|---|---|
| 0.1.13 | Применимость всех 45 правил по платформам; исправлен вход в хаб (перехват CSRF-токена) |
| 0.1.14–0.1.18 | Итерации по списку приложений; первые попытки строились на неверной гипотезе (REST API хаба) |
| 0.1.18 | Список приложений: WebSocket-метод `GetDocList` с csrf-токеном — **работает** |
| 0.1.19 | Исправлено «App already open»: своя сессия на приложение, адрес строго под выбранное |
| 0.1.20 | **Этап 0 плана:** двойной вывод диагностики, ложные срабатывания S010, нулевые значения в doctor, R007 (`AutoNumber(ID, 'Key_…')`), дедупликация находок, маскирование секретов в логах |
| 0.2.0 | **Этап 1 плана:** вкладка «Подключение» — пошаговый сценарий, combobox приложений с поиском/фильтрами/мультивыбором, чек-лист проверок, тёмная тема |
| 0.3.0 | **Этап 2 плана:** вкладка «Анализ» — карточки метрик и скор 0–100, фильтры-чипы, колонки «Таблица»/«Строка», просмотр скрипта, diff правок, подавление находок |
| 0.4.0 | **Этап 3 плана:** вкладка «Правила» — редактор правил (вкл/выкл, важность, пороги), файл настроек с экспортом и импортом |
| 0.5.0 | **Этап 4 плана:** сводный отчёт — тепловая карта, топ-10 правил, колонки скор/владелец/поток/дата, история в SQLite со сравнением, экспорт CSV и Excel |
| 0.5.1–0.5.3 | **Хаб:** понятная диагностика отказа 403, видимое окно входа, кнопка «Войти в хаб» доступна всегда и не блокирует интерфейс, показано состояние сессии |
| 0.5.3 (пересборка) | **Целостность сессии и сбор объектов:** файл сессии пишется атомарно и проверяется при чтении; объекты приложения запрашиваются по типам с обходом отказа (сервер отвергает весь блок при незнакомом типе); в диагностике и в отчёте видно настоящую причину, по которой сервер не отдал объекты и связи между таблицами |

---

## 3. Особенности вашего хаба — критично знать

Хост: `dc3-qliks-ap-03.onyx.local` (Qlik Sense Enterprise, порт 443).

| Что | Факт (проверено на сервере) |
|---|---|
| REST API хаба | **Не реализован.** `/api/v1/apps` → `501`, `/hub/api/v1/apps` → HTML страницы хаба, `/api/v1/documents` → `404` |
| Список приложений | Только **WebSocket-метод `GetDocList`** — отдаёт 223 приложения |
| Обязательное условие для WS | В URL должен быть **`qlik-csrf-token`**; без него сервер отвечает `403` |
| Корневые адреса хаба | `wss://host/` и `wss://host/app` → **`301`** (переадресуются) |
| Рабочие адреса для WS | `wss://host/app/<appId>` и служебный `wss://host/app/engineData` |
| Закрытие документа | В схеме QIX **нет метода `CloseDoc`** → документ нельзя закрыть в рамках сессии |
| Обход приложений подряд | Только **своя сессия на каждое приложение**, иначе «App already open» |
| Объекты приложений | Не отдаются (0 объектов) — Doc API не возвращает листы и чарты |

**Вывод:** анализ объектов (выражения чартов) на этом сервере недоступен — работают
только правила по скрипту и модели данных.

---

## 4. Как проверить на реальном сервере

Учётные данные лежат в `safeStorage` (Keychain). Расшифровать их можно тем же
Electron, которым собирается приложение:

```js
// /tmp/qa-read-creds.mjs
import { app, safeStorage } from 'electron';
import { readFileSync } from 'node:fs';
app.setName('qlik-analyzer-desktop');   // имя важно: ключ в Keychain привязан к нему
app.whenReady().then(async () => {
  const buf = readFileSync('/Users/anufriev_d_v/Library/Application Support/qlik-analyzer-desktop/hub-credentials.bin');
  console.log(await safeStorage.decryptStringAsync(buf));
  app.quit();
});
```

```bash
cd <проект>
env -u ELECTRON_RUN_AS_NODE ./desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/qa-read-creds.mjs
```

**Внимание:** полученные cookie и ключи — это действующая сессия. Не коммитить,
не класть в отчёты, после проверки временные файлы удалять.

---

## 5. Особенности окружения (обязательно к знанию)

**Node.js v24 лежит в `<рабочая папка>/.tools/node/bin`** (не в системном PATH —
команда `node` может не сработать, тогда используй полный путь). Сборку
и electron-builder удобнее делать через Electron, который лежит в проекте:

```bash
PROJ=/Users/anufriev_d_v/.cline/data/workspaces/chat/qlik-analyzer
TOOLS=/Users/anufriev_d_v/.cline/data/workspaces/chat/.tools/node/bin
ELECTRON="$PROJ/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

# тесты
cd "$PROJ" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" --test "test/*.test.js"
# типы
cd "$PROJ/desktop" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" ./node_modules/typescript/bin/tsc --noEmit
# сборка main и preload
cd "$PROJ/desktop" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scripts/build-main.mjs
# сборка renderer
cd "$PROJ/desktop" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" node_modules/vite/bin/vite.js build
# релиз (артефакты в desktop/release/)
cd "$PROJ/desktop" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scripts/build-release.mjs
```

Ловушки:

- В терминале VSCode выставлено `ELECTRON_RUN_AS_NODE=1`. Для запуска самого
  приложения нужно `env -u ELECTRON_RUN_AS_NODE`.
- Скрипты запускаются как `scripts/build-main.mjs` — **без** слова `node` перед
  путём (иначе Node ищет файл `node` и падает с MODULE_NOT_FOUND).
- `electron-builder` не запускается через CLI (yargs получает путь к скрипту как
  аргумент) — работает **программный API** `build({ targets, config })`.
- Под Electron-as-node нужно `process.noAsar = true`, иначе сборщик падает на
  `default_app.asar` («Invalid package»).
- `electronDownload.arch` задавать строкой (`'arm64'`/`'x64'`), иначе в
  `@electron/get` уходит число (`Arch.arm64 === 3`), кэш Electron не находится.
- Макрос `${arch}` в `artifactName` раскрывается числом — имена задаются явно:
  `${productName}-${version}-arm64.${ext}`.
- `npm list` для сбора зависимостей: production-зависимостей нет, достаточно
  заглушки `{"name":…,"version":…,"dependencies":{}}`.
- `safeStorage.decryptStringAsync` в Electron 45 возвращает объект, а не строку —
  для чтения файла сессии используйте `safeStorage.decryptString`.

---

## 6. Что появилось в версиях 0.1.20 – 0.5.0

| Что | Где в коде |
|---|---|
| Проверка целостности скрипта, корректный разбор строк Qlik | `src/script/integrity.js` |
| Дедупликация находок, подавление `// qa-ignore`, глобальные исключения | `src/findings/` |
| Итоговый скор 0–100 | `src/score.js` |
| Настройки правил (вкл/выкл, важность, пороги, исключения) и файл `rules.json` | `src/rules/settings.js`, `src/rules/config.js` |
| Правки скрипта «было / стало», применение к копии скрипта | `src/report/fixes.js` |
| Тепловая карта, топ правил, сводные колонки | `src/report/heatmap.js` |
| Выгрузка плоской таблицы в CSV и Excel (свой генератор .xlsx) | `src/report/csv.js`, `src/report/xlsx.js` |
| История прогонов в SQLite и сравнение с базовой линией | `src/history.js` |
| Маскирование секретов в логах, отчётах и URL | `src/logging/mask.js` |
| Вкладки интерфейса (Подключение / Анализ / Сводный отчёт / Правила) | `desktop/src/tabs/` |
| Сборка релиза одной командой | `desktop/scripts/build-release.mjs` |
| Целостность файла сессии хаба (нормализация, проверка, отказ от мусора) | `src/session/credentials.js` |
| Сбор объектов приложения по типам с обходом отказа сервера | `src/extract/objects.js` |
| Связи между таблицами с сохранением текста ошибки сервера | `src/extract/associations.js` |

## 7. Открытые вопросы и что не сделано

- **Объекты приложений не собирались** на этом сервере: `getObjects` отдавал 0
  объектов без объяснения причины. Теперь типы запрашиваются блоками, а
  отказавший блок разбирается по одному типу, и в диагностике видно, какой
  именно тип сервер не принял. **Проверка на живом сервере не завершена:**
  сессия хаба истекла, нужен новый вход из приложения.
- **Правило R011** (связи между таблицами) неприменимо: `getAssociationScores`
  на этом сервере недоступен. Причина теперь сохраняется в отчёте целиком.
- **Пакетный анализ 223 приложений** не проверялся целиком — только 3 подряд.
  Стоит прогнать на ограниченной выборке (`--limit 10`) и замерить время.
- **Кэш пакетного анализа** (`desktop/release/../.cache`) не проверен на
  инвалидирование при перезагрузке приложения.
- **Версия в заголовке** берётся из `app.getVersion()` — в dev-сборке показывает
  версию `package.json`, в упакованной — релизную.

---

## 8. Быстрый старт для новой задачи

1. Прочитать [`AGENTS.md`](../AGENTS.md) — правила работы, пути, соглашения.
2. Прочитать этот файл — состояние и особенности сервера.
3. `git log --oneline -10` и `git tag` — что уже сделано.
4. Проверить `npm test` (через Electron-as-node) — 178 тестов, должно быть зелено.
5. Сформулировать задачу в формате из `AGENTS.md` и приступить.

Этап 5 плана (ИИ-ревью, сверка с GitLab, режим CLI) выполняется только после
отдельного утверждения пользователя.
