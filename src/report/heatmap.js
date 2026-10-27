/**
 * Данные для сводного отчёта: тепловая карта «приложения × категории»
 * и топ самых частых правил.
 */

/** Категории правил в фиксированном порядке. */
export const CATEGORY_ORDER = ['Quality', 'Resources', 'Practices', 'Script'];

/**
 * Тепловая карта: сколько находок каждой категории в каждом приложении.
 * @param {object[]} results — результаты пакетного анализа
 * @returns {{apps: Array<{appId: string, title: string, error: string|null,
 *   cells: Record<string, number>, total: number}>, categories: string[],
 *   max: number, total: number}}
 */
export function buildHeatmap(results) {
  const apps = [];
  let max = 0;
  let total = 0;

  for (const r of results ?? []) {
    const byCategory = r.summary?.findings?.byCategory ?? {};
    const cells = {};
    let appTotal = 0;
    for (const cat of CATEGORY_ORDER) {
      const n = Number(byCategory[cat] ?? 0);
      cells[cat] = n;
      appTotal += n;
      if (n > max) max = n;
    }
    total += appTotal;
    apps.push({
      appId: r.appId,
      title: r.title,
      error: r.error ?? null,
      cells,
      total: appTotal,
    });
  }

  apps.sort((a, b) => b.total - a.total);
  return { apps, categories: [...CATEGORY_ORDER], max, total };
}

/**
 * Топ самых частых правил по всем приложениям.
 * @param {object[]} results — результаты пакетного анализа
 * @param {number} [limit]
 * @returns {Array<{ruleId: string, count: number, apps: number, severity: string}>}
 */
export function topRules(results, limit = 10) {
  const map = new Map();
  for (const r of results ?? []) {
    const seen = new Set();
    for (const f of r.findings ?? []) {
      const id = f.ruleId ?? '?';
      const entry = map.get(id) ?? { ruleId: id, count: 0, apps: 0, severity: f.severity ?? 'info' };
      entry.count += f.count ?? 1;
      if (!seen.has(id)) { entry.apps += 1; seen.add(id); }
      map.set(id, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Сводные строки по приложениям: скор, ошибки/предупреждения/замечания,
 * владелец, поток, дата изменения.
 * @param {object[]} results
 * @returns {Array<{appId: string, title: string, score: number|null,
 *   errors: number, warnings: number, infos: number, total: number,
 *   owner: string|null, stream: string|null, tags: string[],
 *   changedAt: string|null, error: string|null}>}
 */
export function summaryRows(results) {
  return (results ?? []).map((r) => {
    const sev = r.summary?.findings?.bySeverity ?? {};
    return {
      appId: r.appId,
      title: r.title,
      score: r.summary?.score ?? null,
      errors: Number(sev.error ?? 0),
      warnings: Number(sev.warning ?? 0),
      infos: Number(sev.info ?? 0),
      total: r.summary?.findings?.total ?? 0,
      owner: r.owner ?? null,
      stream: r.stream ?? null,
      tags: r.tags ?? [],
      changedAt: r.lastReload ?? null,
      error: r.error ?? null,
    };
  });
}
