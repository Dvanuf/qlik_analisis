/**
 * Обёртка ядра анализа для серверных задач.
 * Использует те же функции, что CLI и десктоп: правила и отчёты — одни и те же.
 */
import { analyze } from '../../src/analyzer.js';
import { extractFromEngine } from '../../src/extract/engine.js';
import { buildGraphFromDoc } from '../../src/extract/docapi.js';
import { openEngineSession, listApps } from '../../src/extract/session.js';
import { appUrl } from '../../src/extract/url.js';
import { renderHtml } from '../../src/report/html.js';
import { renderSummaryHtml } from '../../src/report/summary.js';
import { ALL_RULES, CATEGORIES, SEVERITIES } from '../../src/rules/index.js';
import { totalsOf } from '../../src/batch.js';

/**
 * Список приложений сервера.
 * @param {object} qlikCfg — раздел qlik из resolveServerConfig
 */
export async function fetchApps(qlikCfg) {
  try {
    const apps = await listApps(qlikCfg);
    return apps.map((a) => ({
      id: a.id,
      title: a.title,
      size: a.size,
      lastReload: a.lastReload,
      // Метаданные приложения: поток, владелец, тэги.
      stream: a.stream ?? null,
      owner: a.owner ?? null,
      tags: a.tags ?? [],
    }));
  } finally {
    try { await session.close(); } catch { /* закрываем мягко */ }
  }
}

/**
 * Анализ одного приложения: граф -> правила -> сводка + HTML-отчёт.
 * @param {object} qlikCfg
 * @param {string} appId
 * @param {object} [options] — { platform, rules }
 */
export async function analyzeApp(qlikCfg, appId, options = {}) {
  // null = определяется автоматически по типу API экстрактора.
  const platform = options.platform ?? qlikCfg.platform ?? null;

  const { qix, session } = await openEngineSession({
    // Адрес строго под анализируемое приложение.
    url: appUrl(qlikCfg.url, appId),
    cookie: qlikCfg.cookie,
    xrfKey: qlikCfg.xrfKey,
    csrfToken: qlikCfg.csrfToken,
    user: qlikCfg.user,
    password: qlikCfg.password,
    insecure: qlikCfg.insecure,
    appId,
  });

  let graph;
  try {
    // QlikView (Doc API) и Qlik Sense (QIX App API) — разные ветки.
    if (typeof qix.get !== 'function') {
      const doc = await qix.openDoc(appId);
      graph = await buildGraphFromDoc(doc, appId, () => {});
    } else {
      graph = await extractFromEngine({
        url: appUrl(qlikCfg.url, appId),
        appId,
        cookie: qlikCfg.cookie,
        xrfKey: qlikCfg.xrfKey,
        csrfToken: qlikCfg.csrfToken,
        user: qlikCfg.user,
        password: qlikCfg.password,
        insecure: qlikCfg.insecure,
      });
    }
  } finally {
    try { await session.close(); } catch { /* закрываем мягко */ }
  }

  const result = analyze(graph, { platform, ...(options.rules ?? {}) });
  return {
    appId,
    appName: result.summary.appName,
    summary: result.summary,
    findings: result.findings,
    patch: result.patch,
    ruleStats: result.ruleStats,
    // Структура скрипта: разделы, шаги, поток построения, недостижимый код.
    outline: result.outline,
    html: renderHtml({
      summary: result.summary,
      findings: result.findings,
      patch: result.patch,
      ruleStats: result.ruleStats,
    }),
  };
}

/**
 * Пакетный анализ всех приложений сервера.
 * Одна сессия на весь прогон, мягкий режим (ошибка на одном приложении не валит прогон).
 * @param {object} qlikCfg
 * @param {{pauseMs?: number, shouldStop?: () => boolean, onProgress?: (p: object) => void}} options
 */
export async function analyzeAllApps(qlikCfg, options = {}) {
  const platform = qlikCfg.platform ?? null;

  const results = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pauseMs = options.pauseMs ?? 1000;

  try {
    const apps = await listApps(qlikCfg);
    const total = apps.length;
    for (let i = 0; i < apps.length; i += 1) {
      if (options.shouldStop?.()) {
        options.onProgress?.({ phase: 'stopped', index: i, total });
        break;
      }
      const app = apps[i];
      options.onProgress?.({
        phase: 'start', index: i, total, appId: app.id, title: app.title,
      });
      try {
        // Сессия на каждое приложение: документ нельзя закрыть в рамках
        // сессии (в схеме QIX нет метода CloseDoc), поэтому при обходе подряд
        // сервер отвечает «App already open».
        const graph = await extractFromEngine({
          url: appUrl(qlikCfg.url, app.id),
          appId: app.id,
          cookie: qlikCfg.cookie,
          xrfKey: qlikCfg.xrfKey,
          csrfToken: qlikCfg.csrfToken,
          user: qlikCfg.user,
          password: qlikCfg.password,
          insecure: qlikCfg.insecure,
        });
        const result = analyze(graph, { platform });
        results.push({
          appId: app.id,
          title: graph.appName || app.title,
          size: app.size,
          summary: result.summary,
          findings: result.findings,
          patch: result.patch,
          ruleStats: result.ruleStats,
        });
        options.onProgress?.({
          phase: 'done',
          index: i,
          total,
          appId: app.id,
          title: graph.appName || app.title,
          findings: result.findings.length,
        });
      } catch (err) {
        results.push({
          appId: app.id,
          title: app.title,
          size: app.size,
          error: String(err?.message ?? err),
          summary: null,
          findings: [],
        });
        options.onProgress?.({
          phase: 'error',
          index: i,
          total,
          appId: app.id,
          title: app.title,
          error: String(err?.message ?? err),
        });
      }
      await sleep(pauseMs);
    }
  } finally {
    // Сессии открываются и закрываются внутри цикла — по одной на приложение.
  }

  const totals = totalsOf(results);
  const html = renderSummaryHtml({ results, totals, platform });
  return { results, totals, html };
}

/** Каталог правил — тот же, что показывает десктоп. */
export function rulesCatalog() {
  return {
    total: ALL_RULES.length,
    categories: CATEGORIES.map((name) => ({
      name,
      count: ALL_RULES.filter((r) => r.category === name).length,
    })),
    severities: SEVERITIES,
    rules: ALL_RULES.map((r) => ({
      id: r.id,
      category: r.category,
      severity: r.severity,
      title: r.title,
      description: r.description,
      recommendation: r.recommendation,
      platforms: r.platforms,
    })),
  };
}
