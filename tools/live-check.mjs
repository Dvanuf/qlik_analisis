/**
 * Живая проверка на сервере Qlik: подключение к хабу и прогон анализа.
 *
 * Инструмент читает сессию хаба, которую десктоп сохранил в зашифрованном
 * виде, и прогоняет по ней настоящий анализ — с отчётом по тем блокам,
 * которые нельзя проверить на фикстурах: полнота метаданных фронт-энда,
 * структура скрипта и находки новых правил.
 *
 * Запуск (нужен Electron — safeStorage доступен только в нём):
 *   cd desktop && ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     ../tools/live-check.mjs [appId ...]
 *
 * Без appId берётся первое приложение из списка сервера.
 * Секреты никогда не печатаются — в вывод идут только итоги.
 */
import { app, safeStorage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CREDS_FILE = 'hub-credentials.bin';
const HOST = 'dc3-qliks-ap-03.onyx.local';

/** Читает сохранённую сессию хаба. */
async function readCreds() {
  const file = resolve(app.getPath('userData'), CREDS_FILE);
  if (!existsSync(file)) {
    console.log(`Сессия не найдена: ${file}`);
    console.log('Откройте десктоп-приложение, нажмите «Войти в хаб» и авторизуйтесь.');
    return null;
  }
  const { result } = await safeStorage.decryptStringAsync(readFileSync(file));
  try {
    return JSON.parse(result);
  } catch {
    console.log('Файл сессии повреждён — войдите в хаб заново.');
    return null;
  }
}

app.setName('qlik-analyzer-desktop');

app.whenReady().then(async () => {
  const creds = await readCreds();
  if (!creds?.cookie) {
    console.log('Сессии хаба нет — войдите в хаб через десктоп-приложение.');
    app.quit();
    return;
  }
  console.log(`Сессия получена ${creds.at ?? '—'}`);

  const { extractFromEngine } = await import('../src/extract/engine.js');
  const { analyze } = await import('../src/analyzer.js');
  const { listApps } = await import('../src/extract/session.js');

  const opts = {
    url: `wss://${HOST}/app`,
    cookie: creds.cookie,
    xrfKey: creds.xrfKey,
    csrfToken: creds.csrfToken,
    insecure: true,
  };

  let appIds = process.argv.slice(2);
  if (!appIds.length) {
    try {
      const apps = await listApps(opts);
      appIds = apps.slice(0, 1).map((a) => a.id);
      console.log(`Приложений на сервере: ${apps.length}`);
      // Покрытие метаданных: по пустому фильтру не видно, что сервер не отдал.
      const withStream = apps.filter((a) => a.stream).length;
      const withOwner = apps.filter((a) => a.owner).length;
      const withTags = apps.filter((a) => (a.tags ?? []).length).length;
      console.log(`  метаданные: поток ${withStream}/${apps.length}, `
        + `владелец ${withOwner}/${apps.length}, тэги ${withTags}/${apps.length}`);
    } catch (err) {
      console.log(`Не удалось получить список приложений: ${err?.message ?? err}`);
    }
  }
  if (!appIds.length) {
    console.log('Не указано приложение для проверки.');
    app.quit();
    return;
  }

  for (const appId of appIds) {
    try {
      const graph = await extractFromEngine({ ...opts, url: `wss://${HOST}/app/${appId}`, appId });
      console.log(`\n=== ${graph.appName} (${appId})`);
      console.log(`  платформа: ${graph.meta.platform}`);
      console.log(`  объектов: ${graph.objects.length} | листов: ${graph.sheets.length}`
        + ` | master-объектов: ${(graph.masterObjects ?? []).length}`
        + ` | подключений: ${(graph.connections ?? []).length}`);
      console.log(`  полнота метаданных: ${JSON.stringify(graph.meta.inventory)}`);
      console.log(`  возможности: ${(graph.meta.capabilities ?? []).join(', ') || '—'}`);

      const result = analyze(graph, { platform: 'auto' });
      const outline = result.outline;
      console.log(`  структура скрипта: разделов ${outline.sections}, шагов ${outline.steps},`
        + ` недостижимых ${outline.unreachable}`);
      for (const s of outline.full?.sections ?? []) {
        console.log(`    раздел «${s.name}»: таблицы ${s.tables.join(', ') || '—'}`
          + `${s.subs.length ? `, подпрограммы ${s.subs.join(', ')}` : ''}`);
      }
      for (const st of outline.full?.steps ?? []) {
        console.log(`    шаг: ${st.table} — ${st.text} (строка ${st.line})`);
      }
      for (const u of outline.full?.unreachable ?? []) {
        console.log(`    недостижимо (строка ${u.line}): ${u.raw}`);
      }

      const byRule = {};
      for (const f of result.findings) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
      console.log(`  находок: ${result.findings.length} | скор: ${result.summary.score}`);
      console.log(`  по правилам: ${JSON.stringify(byRule)}`);
      for (const f of result.findings
        .filter((x) => ['R015', 'R016', 'R017', 'R018', 'S013'].includes(x.ruleId))) {
        console.log(`    ${f.ruleId}: ${f.message}`);
      }
      const skipped = result.summary.skipped ?? [];
      if (skipped.length) {
        console.log('  пропущено с объяснением:');
        for (const s of skipped) console.log(`    ${s.capability} — ${s.reason}`);
      }
    } catch (err) {
      console.log(`\n=== ${appId}: ОШИБКА — ${err?.message ?? err}`);
      if (/403/.test(String(err?.message ?? ''))) {
        console.log('  Сессия истекла: войдите в хаб через десктоп-приложение и повторите.');
      }
    }
  }
  app.quit();
});
