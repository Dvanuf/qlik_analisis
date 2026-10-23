/**
 * Пакетный анализ всех приложений сервера.
 *
 * Одна сессия движка на весь прогон, кэш по времени последней перезагрузки,
 * мягкий режим (ошибка на одном приложении не останавливает прогон),
 * пауза между приложениями и возможность отмены.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listApps } from './extract/session.js';
import { appUrl } from './extract/url.js';
import { buildGraphFromDoc } from './extract/docapi.js';
import { extractFromEngine } from './extract/engine.js';
import { analyze } from './analyzer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Кэш анализа: <dir>/<appId>.json */
function cachePath(dir, appId) {
  return resolve(dir, `${String(appId).replace(/[^\w-]/g, '_')}.json`);
}

function readCache(dir, appId) {
  const file = cachePath(dir, appId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(dir, appId, data) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(dir, appId), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch { /* кэш не критичен */ }
}

/**
 * @param {{
 *   url: string, cookie?: string, xrfKey?: string, csrfToken?: string,
 *   user?: string, password?: string, insecure?: boolean, platform?: string,
 *   rules?: object, appIds?: string[], limit?: number, pauseMs?: number,
 *   cacheDir?: string, useCache?: boolean, onProgress?: (p: object) => void,
 *   shouldStop?: () => boolean,
 * }} options
 */
export async function analyzeAll(options) {
  const {
    url, cookie, xrfKey, csrfToken, user, password, insecure, platform = null,
    rules = {}, appIds, limit, pauseMs = 1000, cacheDir, useCache = true,
    onProgress = () => {}, shouldStop = () => false,
  } = options;

  // Можно передать готовую сессию (тесты) — тогда соединение не открывается.
  const sharedQix = options.qix ?? null;
  const sharedSession = options.session ?? null;

  // Движок отвечает по пути /app — это «входная точка», после неё мы обходим
  // все приложения сервера.
  if (!sharedQix && !/\/app(\/|$)/.test(url)) {
    throw new Error(
      'В URL нужен путь /app — например wss://<host>/app/<appId>. '
      + 'Это адрес хаба, а анализ пройдёт по всем приложениям сервера.',
    );
  }

  const results = [];
  try {
    const all = await listApps(
      options.qix ?? { url, cookie, xrfKey, csrfToken, user, password, insecure },
    );
    const selected = appIds?.length
      ? all.filter((a) => appIds.includes(a.id))
      : all;
    const apps = limit ? selected.slice(0, limit) : selected;
    const total = apps.length;

    for (let i = 0; i < apps.length; i += 1) {
      if (shouldStop()) {
        onProgress({ phase: 'stopped', index: i, total });
        break;
      }
      const app = apps[i];
      onProgress({
        phase: 'start', index: i, total, appId: app.id, title: app.title, size: app.size,
      });

      try {
        const cached = useCache && cacheDir ? readCache(cacheDir, app.id) : null;
        if (cached && cached.lastReload && cached.lastReload === app.lastReload) {
          results.push({ ...cached, fromCache: true });
          onProgress({
            phase: 'done', index: i, total, appId: app.id, title: app.title,
            findings: cached.findings?.length ?? 0, fromCache: true,
          });
          await sleep(pauseMs);
          continue;
        }

        let graph;
        if (sharedQix) {
          const doc = await sharedQix.openDoc(app.id);
          graph = await buildGraphFromDoc(doc, app.id);
        } else {
          // Сессия на каждое приложение: документ нельзя закрыть в рамках
          // сессии (в схеме QIX нет метода CloseDoc), поэтому при обходе подряд
          // сервер отвечает «App already open». Своя сессия на приложение
          // освобождает документ при закрытии соединения.
          graph = await extractFromEngine({
            url: appUrl(url, app.id),
            appId: app.id,
            cookie, xrfKey, csrfToken, user, password, insecure,
          });
        }
        const result = analyze(graph, { ...rules, platform });
        const entry = {
          appId: app.id,
          title: graph.appName || app.title,
          size: app.size,
          lastReload: graph.meta?.lastReload ?? app.lastReload ?? null,
          fromCache: false,
          summary: result.summary,
          findings: result.findings,
          patch: result.patch,
          ruleStats: result.ruleStats,
          at: new Date().toISOString(),
        };
        results.push(entry);
        if (cacheDir) writeCache(cacheDir, app.id, entry);
        onProgress({
          phase: 'done',
          index: i,
          total,
          appId: app.id,
          title: entry.title,
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
        onProgress({
          phase: 'error', index: i, total, appId: app.id, title: app.title,
          error: String(err?.message ?? err),
        });
      }

      await sleep(pauseMs);
    }
  } finally {
    try { await sharedSession?.close(); } catch { /* закрываем мягко */ }
  }

  return { results, totals: totalsOf(results) };
}

/** Сводные цифры по прогону. */
export function totalsOf(results) {
  const totals = {
    apps: results.length,
    errors: results.filter((r) => r.error).length,
    findings: 0,
    byCategory: {},
    bySeverity: { error: 0, warning: 0, info: 0 },
    removableRows: 0,
    removableFields: 0,
  };
  for (const r of results) {
    if (!r.summary) continue;
    totals.findings += r.summary.findings?.total ?? 0;
    for (const [cat, n] of Object.entries(r.summary.findings?.byCategory ?? {})) {
      totals.byCategory[cat] = (totals.byCategory[cat] ?? 0) + n;
    }
    for (const [sev, n] of Object.entries(r.summary.findings?.bySeverity ?? {})) {
      totals.bySeverity[sev] = (totals.bySeverity[sev] ?? 0) + n;
    }
    totals.removableRows += r.summary.savings?.removableRows ?? 0;
    totals.removableFields += r.summary.savings?.removableFields ?? 0;
  }
  return totals;
}
