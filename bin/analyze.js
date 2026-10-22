#!/usr/bin/env node
/**
 * CLI анализатора качества приложений Qlik Sense / QlikView.
 *
 *   qlik-analyzer analyze --env prod --app sales
 *   qlik-analyzer analyze --script "C:\scripts\sales.qvs"
 *   qlik-analyzer doctor  --env prod --app sales
 *   qlik-analyzer envs
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { extractFromEngine } from '../src/extract/engine.js';
import { extractFromFile } from '../src/connectors/file.js';
import { analyze } from '../src/analyzer.js';
import { renderHtml } from '../src/report/html.js';
import { runDoctor } from '../src/cli/doctor.js';
import {
  loadConfig, loadDotEnv, resolveTarget, resolveRules, resolvePaths, DEFAULT_CONFIG_NAME,
} from '../src/config.js';

function writeOut(path, content) {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

const FLAGS = {
  '--config': 'config', '--env': 'env', '--app': 'app', '--url': 'url',
  '--host': 'host', '--port': 'port', '--app-id': 'appId', '--user': 'user',
  '--qlik-user': 'qlikUser', '--password': 'password', '--password-env': 'passwordEnv',
  '--api-key': 'apiKey', '--cookie': 'cookie', '--xrf-key': 'xrfKey', '--csrf-token': 'csrfToken', '--insecure': 'insecure', '--schema': 'schema',
  '--out-dir': 'outDir', '--summary': 'summary', '--cache-dir': 'cacheDir', '--pause': 'pause',
  '--limit': 'limit', '--app-ids': 'appIds', '--no-cache': 'noCache',
  '--script': 'script', '--qvs': 'qvs', '--qvw': 'qvw', '--fixture': 'fixture', '--out': 'out',
  '--json': 'json', '--graph': 'graph', '--fail-on': 'failOn',
  '--enable': 'enable', '--platform': 'platform', '--disable': 'disable',
  '--max-expression-length': 'maxExpressionLength', '--name-prefixes': 'namePrefixes',
  '--perf': 'perf', '--quiet': 'quiet',
};

function parseArgs(argv) {
  const args = { enable: [], disable: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (FLAGS[a]) {
      const key = FLAGS[a];
      if (key === 'insecure' || key === 'perf' || key === 'quiet') { args[key] = true; continue; }
      const value = argv[++i];
      if (key === 'enable' || key === 'disable') args[key].push(...String(value).split(',').map((s) => s.trim()));
      else if (key === 'port' || key === 'maxExpressionLength') args[key] = Number(value);
      else if (key === 'namePrefixes') args[key] = String(value).split(',').map((s) => s.trim());
      else args[key] = value;
      continue;
    }
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    rest.push(a);
  }
  args._ = rest;
  return args;
}

function usage() {
  console.log(`
qlik-analyzer — анализ качества приложений Qlik Sense / QlikView

Команды:
  analyze                 анализ приложения (по умолчанию)
  doctor                  проверка подключения к серверу
  envs                    список окружений и приложений из конфигурации

Подключение (приоритет: флаг > переменная окружения > ${DEFAULT_CONFIG_NAME} > умолчание):
  --env <name>            имя окружения из конфигурации
  --app <name>            имя приложения из конфигурации
  --url <ws://…>          полный URL движка (ws://host:4747/app/<appId>)
  --host <host> --port <port> --app-id <id>
  --user <domain\\user>   доменный пользователь (Qlik Sense Enterprise on Windows)
  --password-env <NAME>   имя переменной окружения с паролем
  --api-key <key>         API-токен (Qlik Cloud)
  --qlik-user <user>      заголовок X-Qlik-User (имперсонация на QSS)
  --insecure              принимать самоподписанный сертификат (обычно нужен на QSS)

Файлы (оффлайн, сервер не нужен):
  --script <file>         скрипт загрузки (экспорт .qvs / .txt из Qlik Sense или QlikView)
  --qvs <file>            контейнер приложения Qlik Sense (zip)
  --qvw <file>            документ QlikView (нужен экспорт скрипта — формат проприетарный)

Вывод:
  --out <report.html>     HTML-отчёт
  --json <findings.json>  находки в JSON
  --graph <graph.json>    извлечённый граф приложения
  --fail-on <error|warning|none>   код возврата для CI
  --enable/--disable <ID,…>         включение/выключение правил
`);
}

function printDoctor(steps) {
  console.log('');
  for (const s of steps) {
    const mark = s.status === 'OK' ? '✓' : s.status === 'WARN' ? '!' : '✗';
    console.log(`${mark} ${s.name}: ${s.detail}`);
    if (s.hint) console.log(`    → ${s.hint}`);
  }
  console.log('');
}

/** Команда envs: показать, что есть в конфигурации. */
function runEnvs(config, configPath) {
  console.log(`\nКонфигурация: ${configPath ?? '(файл не найден — используются значения по умолчанию)'}\n`);
  const envs = config.environments ?? {};
  const names = Object.keys(envs);
  if (!names.length) console.log('  Окружения не заданы.');
  for (const name of names) {
    const e = envs[name];
    console.log(`  [${name}] ${e.type ?? 'qlik-sense'}`);
    console.log(`      url:      ${e.url ?? (e.host ? `ws://${e.host}:${e.port ?? 4747}/app` : '—')}`);
    console.log(`      appId:    ${e.appId ?? '—'}`);
    console.log(`      user:     ${e.user ?? '—'}`);
    console.log(`      пароль:   ${e.passwordEnv ? `из переменной ${e.passwordEnv}` : '—'}`);
    console.log(`      insecure: ${e.insecure ? 'да' : 'нет'}`);
  }
  const apps = config.apps ?? {};
  const appNames = Object.keys(apps);
  console.log('\n  Приложения:');
  if (!appNames.length) console.log('    не заданы');
  for (const name of appNames) {
    const a = apps[name];
    console.log(`    ${name} -> окружение ${a.env ?? '—'}${a.appId ? `, appId ${a.appId}` : ''}`);
  }
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'analyze';
  const args = parseArgs(argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv);

  if (args.help) { usage(); return; }

  loadDotEnv();
  const { config, path: configPath } = loadConfig(args.config);

  if (command === 'envs') { runEnvs(config, configPath); return; }

  const target = resolveTarget(args, config);
  const rules = resolveRules(args, config);
  const paths = resolvePaths(args, config, target);

  if (command === 'doctor') {
    const { steps, failed } = await runDoctor(target);
    printDoctor(steps);
    process.exit(failed ? 1 : 0);
  }

  if (command === 'analyze-all') {
    const { analyzeAll } = await import('../src/batch.js');
    const { renderSummaryHtml } = await import('../src/report/summary.js');
    const outDir = resolve(args.outDir ?? 'reports/batch');
    const cacheDir = resolve(args.cacheDir ?? '.cache/analysis');
    mkdirSync(outDir, { recursive: true });

    console.log(`Пакетный анализ: ${target.url}`);
    const { results, totals } = await analyzeAll({
      url: target.url,
      cookie: target.cookie,
      xrfKey: target.xrfKey,
      csrfToken: target.csrfToken,
      user: target.user,
      password: target.password,
      insecure: target.insecure,
      platform: rules.platform,
      rules,
      appIds: args.appIds ? String(args.appIds).split(',').map((s) => s.trim()) : null,
      limit: args.limit ?? null,
      pauseMs: args.pause ?? 1000,
      cacheDir,
      useCache: !args.noCache,
      onProgress: (p) => {
        if (p.phase === 'start') {
          process.stdout.write(`  [${p.index + 1}/${p.total}] ${p.title}… `);
        } else if (p.phase === 'done') {
          console.log(`готово (${p.findings} находок${p.fromCache ? ', из кэша' : ''})`);
        } else if (p.phase === 'error') {
          console.log(`ОШИБКА: ${p.error}`);
        }
      },
    });

    for (const r of results) {
      const name = String(r.title || r.appId).replace(/[^\wа-яА-Я ._-]/g, '_').slice(0, 60);
      writeOut(resolve(outDir, `${name}.json`), `${JSON.stringify(r, null, 2)}\n`);
    }
    const summaryPath = resolve(args.summary ?? resolve(outDir, 'summary.json'));
    writeOut(summaryPath, `${JSON.stringify({ totals, results }, null, 2)}\n`);
    const summaryHtml = writeOut(resolve(outDir, 'summary.html'),
      renderSummaryHtml({ results, totals, platform: rules.platform }));
    console.log(`\nПриложений: ${totals.apps}, находок: ${totals.findings} `
      + `(ошибок ${totals.bySeverity.error ?? 0}, предупреждений ${totals.bySeverity.warning ?? 0})`);
    console.log(`Сводный отчёт: ${summaryHtml}`);
    console.log(`JSON: ${summaryPath}`);
    if (totals.bySeverity.error > 0) process.exit(1);
    return;
  }

  if (command !== 'analyze') {
    console.error(`Неизвестная команда: ${command}`);
    usage();
    process.exit(2);
  }

  // --- Получение данных ---
  let graph;
  if (target.fileType === 'fixture') {
    if (!args.quiet) console.error(`Чтение фикстуры: ${target.file}`);
    graph = JSON.parse(readFileSync(resolve(target.file), 'utf8'));
    graph.meta = graph.meta ?? {};
    graph.meta.source = graph.meta.source ?? 'fixture';
    graph.meta.generatedAt = graph.meta.generatedAt ?? new Date().toISOString();
  } else if (target.file) {
    if (!args.quiet) console.error(`Чтение файла: ${target.file}`);
    graph = await extractFromFile(target);
  } else {
    if (!target.url) {
      console.error('Не задан источник данных: нужен --url/--env (сервер) или --script/--qvs/--qvw (файл).');
      process.exit(2);
    }
    if (!args.quiet) console.error(`Подключение к ${target.url} …`);
    graph = await extractFromEngine({
      url: target.url,
      schemaPath: target.schemaPath,
      apiKey: target.apiKey,
      user: target.user,
      password: target.password,
      qlikUser: target.qlikUser,
      insecure: target.insecure,
      cookie: target.cookie,
      xrfKey: target.xrfKey,
      csrfToken: target.csrfToken,
      appId: target.appId,
      measurePerf: Boolean(args.perf),
    });
  }

  const result = analyze(graph, rules);

  if (args.graph) {
    const p = writeOut(paths.graph, JSON.stringify(graph, null, 2));
    if (!args.quiet) console.error(`Граф сохранён: ${p}`);
  }
  if (args.out) {
    const p = writeOut(paths.out, renderHtml(result));
    if (!args.quiet) console.error(`Отчёт сохранён: ${p}`);
  }
  if (args.json) {
    const p = writeOut(paths.json, JSON.stringify({
      summary: result.summary, findings: result.findings, patch: result.patch,
    }, null, 2));
    if (!args.quiet) console.error(`JSON сохранён: ${p}`);
  }

  const s = result.summary;
  console.log(`\n${s.appName}: находок ${s.findings.total} `
    + `(Quality ${s.findings.byCategory.Quality}, Resources ${s.findings.byCategory.Resources}, `
    + `Practices ${s.findings.byCategory.Practices}, Script ${s.findings.byCategory.Script})`);
  console.log(`  ошибок: ${s.findings.bySeverity.error}, предупреждений: ${s.findings.bySeverity.warning}, `
    + `замечаний: ${s.findings.bySeverity.info}`);
  if (result.errors.length) {
    console.log(`  правил с ошибками: ${result.errors.length} (см. ruleErrors в JSON)`);
  }
  if (result.patch.script) {
    console.log('\nПредлагаемые правки скрипта:');
    console.log(result.patch.script);
  }

  const failOn = args.failOn ?? 'none';
  if (failOn === 'error' && s.findings.bySeverity.error > 0) process.exit(1);
  if (failOn === 'warning' && (s.findings.bySeverity.error + s.findings.bySeverity.warning) > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Ошибка анализа:', err?.message ?? err);
  process.exit(1);
});
