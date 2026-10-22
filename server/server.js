#!/usr/bin/env node
/**
 * Точка входа сервера qlik-analyzer.
 *
 * Запуск:
 *   node server/server.js
 *   node server/server.js --config server/server.config.json --port 8080
 *
 * Сервер поднимает HTTP-интерфейс: список приложений, запуск анализа,
 * прогресс в реальном времени (SSE), история отчётов.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig, resolveServerConfig, envOrEmpty } from './src/config.js';
import { ReportStore } from './src/store.js';
import { createApp } from './src/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') { args.config = argv[i + 1]; i += 1; }
    else if (a === '--port') { args.port = Number(argv[i + 1]); i += 1; }
    else if (a === '--host') { args.host = argv[i + 1]; i += 1; }
    else if (a === '--auth') { args.auth = argv[i + 1]; i += 1; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { config: raw, path: configPath, exists } = loadServerConfig(args.config);
const config = resolveServerConfig(raw);

if (args.port) config.server.port = args.port;
if (args.host) config.server.host = args.host;
if (args.auth) config.auth.mode = args.auth;

// Пароль Qlik берётся из переменной окружения, указанной в конфиге.
config.qlik.password = envOrEmpty(config.qlik.passwordEnv);

const store = new ReportStore(resolve(PROJECT_ROOT, config.server.dataDir));
const { server } = createApp({ config, store, log: (m) => console.error(m) });

server.listen(config.server.port, config.server.host, () => {
  const base = `http://${config.server.host}:${config.server.port}`;
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  Qlik Analyzer — сервер                       │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  Адрес:        ${base}`);
  console.log(`  Конфиг:       ${configPath ?? '(не найден, используются значения по умолчанию)'}`);
  console.log(`  Аутентификация: ${config.auth.mode}`);
  console.log(`  Движок Qlik:  ${config.qlik.url || '(не задан)'}`);
  console.log(`  Параллельных анализов: ${config.server.concurrency}`);
  console.log(`  Каталог отчётов: ${store.reportsDir}`);
  if (!exists) {
    console.log('');
    console.log('  ВНИМАНИЕ: файл конфигурации не найден — создайте server/server.config.json');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal}: останавливаем сервер…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
