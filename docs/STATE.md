# Состояние проекта qlik-analyzer — передача контекста

Документ отвечает на вопрос «с чего начать новую задачу». Правила работы с AI —
в [`AGENTS.md`](../AGENTS.md), история версий — в [`CHANGELOG.md`](../CHANGELOG.md).

**Обновлено:** 23.10.2026 · **Текущая версия:** 0.1.19 (тег `v0.1.19`)

---

## 1. Где что лежит

| Что | Путь |
|---|---|
| Исходники | `/Users/anufriev_d_v/.cline/data/workspaces/chat/qlik-analyzer` |
| Архив всех сборок | `<проект>/desktop/release/` |
| Последняя сборка на рабочем столе | `/Users/anufriev_d_v/Desktop/Qlik Analyzer-0.1.19-{arm64.dmg,x64.exe}` |
| Лог входа в хаб | `~/Library/Application Support/qlik-analyzer-desktop/hub-login.log` |
| Учётные данные хаба (зашифрованы) | `~/Library/Application Support/qlik-analyzer-desktop/hub-credentials.bin` |

---

## 2. Что сделано (0.1.13 → 0.1.19)

| Версия | Суть |
|---|---|
| 0.1.13 | Применимость всех 45 правил по платформам; исправлен вход в хаб (перехват CSRF-токена) |
| 0.1.14–0.1.18 | Итерации по списку приложений; первые попытки строились на неверной гипотезе (REST API хаба) |
| 0.1.18 | Список приложений: WebSocket-метод `GetDocList` с csrf-токеном — **работает** |
| 0.1.19 | Исправлено «App already open»: своя сессия на приложение, адрес строго под выбранное |

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

**Node.js в системе НЕ установлен.** Рабочий Node берётся из Electron:

```bash
PROJ=/Users/anufriev_d_v/.cline/data/workspaces/chat/qlik-analyzer
ELECTRON="$PROJ/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

# тесты
cd "$PROJ" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" --test "test/*.test.js"
# типы
cd "$PROJ/desktop" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" ./node_modules/typescript/bin/tsc --noEmit
# сборка renderer
cd "$PROJ/desktop" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON" node_modules/vite/bin/vite.js build
```

Ловушки:

- В терминале VSCode выставлено `ELECTRON_RUN_AS_NODE=1`. Для запуска самого
  приложения нужно `env -u ELECTRON_RUN_AS_NODE`.
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

---

## 6. Открытые вопросы и что не сделано

- **Объекты приложений не собираются** на этом сервере (Doc API их не отдаёт) —
  правила по выражениям чартов (Q001–Q006, P001–P011) на ваших приложениях
  не сработают. Это ограничение платформы, не ошибка инструмента.
- **Правило R011** (связи между таблицами) неприменимо: `getAssociationScores`
  на этом сервере недоступен.
- **Пакетный анализ 223 приложений** не проверялся целиком — только 3 подряд.
  Стоит прогнать на ограниченной выборке (`--limit 10`) и замерить время.
- **Кэш пакетного анализа** (`desktop/release/../.cache`) не проверен на
  инвалидирование при перезагрузке приложения.
- **Версия в заголовке** берётся из `app.getVersion()` — в dev-сборке показывает
  версию `package.json`, в упакованной — релизную.

---

## 7. Быстрый старт для новой задачи

1. Прочитать [`AGENTS.md`](../AGENTS.md) — правила работы, пути, соглашения.
2. Прочитать этот файл — состояние и особенности сервера.
3. `git log --oneline -10` и `git tag` — что уже сделано.
4. Проверить `npm test` (через Electron-as-node) — 114 тестов, должно быть зелено.
5. Сформулировать задачу в формате из `AGENTS.md` и приступить.
