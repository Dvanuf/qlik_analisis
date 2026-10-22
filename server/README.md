# Сервер qlik-analyzer

Веб-сервер для многопользовательской работы: несколько сотрудников открывают
отчёты в браузере, анализ выполняет сервер.

**Ядро — то же самое**, что у CLI и десктопа (`../src/`): одни и те же 45 правил,
одинаковые HTML-отчёты. Сервер — это оболочка над ядром, а не его копия.

## Запуск

```bash
npm install
node server/server.js
```

Сервер поднимется на `http://127.0.0.1:8080` (по умолчанию — только локально).

```bash
node server/server.js --host 0.0.0.0 --port 8080      # доступ из сети
node server/server.js --config server/server.config.json
node server/server.js --auth proxy                     # аутентификация через прокси
```

## Конфигурация

`server/server.config.json` (путь — `--config` или переменная `QLIK_SERVER_CONFIG`).

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "dataDir": "server/data",
    "concurrency": 1,
    "pauseMs": 1000
  },
  "auth": {
    "mode": "basic",
    "users": [
      { "login": "ivan", "passwordEnv": "QLIK_SERVER_PASSWORD", "role": "analyst" }
    ]
  },
  "qlik": {
    "url": "wss://qlik-host/app/<appId>",
    "cookie": "",
    "csrfToken": "",
    "passwordEnv": "QLIK_PASSWORD",
    "insecure": true,
    "platform": "qlikview"
  }
}
```

**Секреты** — только через переменные окружения: в конфиге указывается **имя**
переменной (`passwordEnv`), значение берётся из `process.env`.

### Ключевые параметры

| Параметр | Значение | Комментарий |
|---|---|---|
| `server.concurrency` | `1` | Сколько анализов одновременно. **Не поднимайте выше 1**, если не хотите выжигать лицензии движка Qlik |
| `server.pauseMs` | `1000` | Пауза между приложениями при пакетном анализе |
| `server.dataDir` | `server/data` | Где хранятся отчёты и `index.json` |
| `auth.mode` | `none` / `basic` / `proxy` | см. ниже |
| `qlik.platform` | `qlikview` / `qlik-sense` | Влияет на набор применимых правил |

## Аутентификация

### `basic` — HTTP Basic

```json
{
  "auth": {
    "mode": "basic",
    "realm": "Qlik Quality",
    "users": [
      { "login": "ivan", "passwordEnv": "QLIK_SERVER_PASSWORD", "role": "analyst" },
      { "login": "petr", "passwordEnv": "QLIK_SERVER_VIEWER_PASSWORD", "role": "viewer" }
    ]
  }
}
```

Роли:
- `analyst` — просмотр + запуск анализа;
- `viewer` — только просмотр отчётов и каталога правил;
- `admin` — всё.

### `proxy` — аутентификация на reverse-proxy (рекомендуется для корпоратива)

Прокси (IIS, nginx + `mod_auth_gssapi`, Apache) выполняет Kerberos/Negotiate и
передаёт логин в заголовке:

```json
{
  "auth": {
    "mode": "proxy",
    "userHeader": "X-Forwarded-User",
    "allowedDomains": ["corp"]
  }
}
```

> **Важно:** режим `proxy` доверяет заголовку — сервер должен слушать только
> на внутреннем интерфейсе, а наружу выставляться через прокси. Иначе любой
> может подделать заголовок.

### `none` — без аутентификации

Только для локальной разработки. Наружу не выставлять.

## REST API

| Метод | Путь | Назначение | Роль |
|---|---|---|---|
| GET | `/api/health` | Состояние сервера, очередь, статистика | без аутентификации |
| GET | `/api/me` | Кто вошёл и его роль | любая |
| GET | `/api/rules` | Каталог 45 правил | любая |
| GET | `/api/apps` | Список приложений сервера Qlik | любая |
| POST | `/api/analyze` | Запустить анализ приложения `{ appId }` | analyst |
| POST | `/api/analyze-all` | Запустить пакетный анализ | analyst |
| GET | `/api/jobs` | Список задач | любая |
| GET | `/api/jobs/:id` | Состояние задачи | любая |
| POST | `/api/jobs/:id/cancel` | Отменить задачу | analyst |
| GET | `/api/reports` | Список отчётов | любая |
| GET | `/api/reports/:id` | Метаданные отчёта | любая |
| DELETE | `/api/reports/:id` | Удалить отчёт | любая |
| GET | `/reports/:id.html` | Сам отчёт | любая |
| GET | `/reports/:id.json` | Находки в JSON | любая |
| GET | `/api/stream` | SSE-поток прогресса задач | любая |

### Примеры

```bash
# вход
curl -u 'ivan:пароль' http://localhost:8080/api/me

# список приложений
curl -u 'ivan:пароль' http://localhost:8080/api/apps

# анализ одного приложения (ответ — id задачи, отчёт появится в /api/reports)
curl -u 'ivan:пароль' -X POST -H 'Content-Type: application/json' \
  -d '{"appId":"7cd8b706-5b9e-4c96-b2fb-6b1ed3deeb20"}' \
  http://localhost:8080/api/analyze

# состояние задачи
curl -u 'ivan:пароль' http://localhost:8080/api/jobs/job-1792670375053-1
```

## Устройство

```
server/
  server.js            точка входа
  server.config.json   конфигурация (шаблон)
  src/
    config.js          разбор конфига, значения по умолчанию
    auth.js            аутентификация (none / basic / proxy) и роли
    queue.js           очередь фоновых задач: прогресс, отмена
    store.js           хранение отчётов на диске
    qlik.js            обёртка ядра анализа для серверных задач
    http.js            HTTP-сервер и REST-маршруты
  public/              веб-интерфейс (без сборки — чистый JS)
  data/                отчёты и index.json (в git не попадает)
```

## Развёртывание

**Windows** (рядом с QlikView Server 12 — так проще с доменной авторизацией):

```powershell
# установить Node.js LTS, затем:
npm install
$env:QLIK_SERVER_PASSWORD = "…"
$env:QLIK_PASSWORD = "…"
node server/server.js --host 0.0.0.0 --port 8080
```

**Через IIS/nginx** — Node слушает `127.0.0.1:8080`, прокси отдаёт наружу
и выполняет аутентификацию:

```nginx
server {
    listen 443 ssl;
    server_name qlik-quality.corp.local;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-User $remote_user;   # ← для режима proxy
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;      # нужно для SSE-потока прогресса
    }
}
```

**Служба Windows** (nssm) или systemd — чтобы сервер поднимался при загрузке.

## Ограничения

- **Сессия Qlik протухает.** Cookie `X-Qlik-Session` имеет ограниченный срок жизни.
  Для постоянной работы сервера нужен либо ре-логин по расписанию, либо сервисная
  учётка с Basic-авторизацией (тогда сессия не протухает, но нужны права на все
  приложения).
- **QlikView 12: объектный анализ недоступен** — Doc API не отдаёт листы и чарты.
  По QV-приложениям проверяются скрипт и модель данных.
- **Отчёты содержат внутреннюю структуру** (имена таблиц, полей, ключей) —
  доступ к серверу должен быть ограничен.
- Сервер не хранит состояние в базе — только JSON-файл `index.json`. Для
  нескольких десятков пользователей этого достаточно; для серьёзной отчётности
  нужен PostgreSQL.

### `basic` — HTTP Basic

```json
{
  "auth": {
    "mode": "basic",
    "realm": "Qlik Quality",
    "users": [
      { "login": "ivan", "passwordEnv": "QLIK_SERVER_PASSWORD", "role": "analyst" },
      { "login": "petr", "passwordEnv": "QLIK_SERVER_VIEWER_PASSWORD", "role": "viewer" }
    ]
  }
}
```

Роли:
- `analyst` — просмотр + запуск анализа;
- `viewer` — только просмотр отчётов и каталога правил;
- `admin` — всё.

### `proxy` — аутентификация на reverse-proxy (рекомендуется для корпоратива)

Прокси (IIS, nginx + `mod_auth_gssapi`, Apache) выполняет Kerberos/Negotiate и
передаёт логин в заголовке:

```json
{
  "auth": {
    "mode": "proxy",
    "userHeader": "X-Forwarded-User",
    "allowedDomains": ["corp"]
  }
}
```

> **Важно:** режим `proxy` доверяет заголовку — сервер должен слушать только
> на внутреннем интерфейсе, а наружу выставляться через прокси. Иначе любой
> может подделать заголовок.

### `none` — без аутентификации

Только для локальной разработки. Наружу не выставлять.
