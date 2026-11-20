/**
 * Сверка скрипта приложения с .qvs в GitLab (PLAN этап 5, L013).
 *
 * Файл ищется по имени приложения в индексе настроенных папок GitLab
 * (например, «Продажи» → «продажи.qvs»). Сравнение — построчное:
 * статусы 'sync' (совпадает), 'drift' (расходится), 'missing' (файла нет),
 * 'empty' (в GitLab пусто). Для diff — простой LCS без зависимостей;
 * на очень больших скриптах (> MAX_DIFF_LINES × 2) построчный список
 * заменяется сводкой «+X −Y», чтобы не раздувать память.
 */
import { canonicalFieldName } from '../normalize.js';

/** Предел построчного diff: за ним — только сводка. */
export const MAX_DIFF_LINES = 600;

/** Нормализация скрипта для сравнения: CRLF → LF, хвостовые пробелы-пустые. */
export function normalizeForCompare(src) {
  return String(src ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** Имя файла .qvs для приложения: «Продажи (qs-r-01)» → «продажи (qs-r-01).qvs». */
export function appFileName(appName) {
  const base = String(appName ?? '').trim();
  return base ? `${base.toLowerCase()}.qvs` : '';
}

/** Поиск файла приложения в индексе GitLab (ключи — имена файлов в нижнем регистре). */
export function findGitLabFile(index, appName) {
  const want = appFileName(appName);
  if (!want || !index) return null;
  const exact = index.get(want);
  if (exact) return { file: want, ...exact };
  // Файл без расширения или в подкаталоге: ключ заканчивается на «/имя.qvs».
  for (const [key, info] of index.entries()) {
    if (key.endsWith(`/${want}`) || key === want) return { file: key, ...info };
  }
  return null;
}

/**
 * Построчный diff с контекстом 3 строки (упрощённый LCS).
 * @returns {{ diffLines: number, diff: Array<{ type: 'add'|'del'|'ctx'|'hunk', text: string }> }}
 */
function buildDiff(aLines, bLines, maxDiffLines) {
  const n = aLines.length;
  const m = bLines.length;
  // LCS-таблица: с запасом от больших файлов — сворачиваем в сводку
  // (мультимножественное сравнение строк: +X −Y без построчного списка).
  if (n * m > 4_000_000) {
    const counts = new Map();
    for (const l of aLines) counts.set(l, (counts.get(l) ?? 0) + 1);
    let onlyB = 0;
    for (const l of bLines) {
      const c = counts.get(l) ?? 0;
      if (c > 0) counts.set(l, c - 1);
      else onlyB += 1;
    }
    const onlyA = [...counts.values()].reduce((s, v) => s + v, 0);
    return { diffLines: onlyA + onlyB, diff: [], truncated: true };
  }
  // LCS.
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = aLines[i] === bLines[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  // Полный путь → операции.
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push({ type: 'ctx', a: i, b: j }); i += 1; j += 1; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { ops.push({ type: 'del', a: i }); i += 1; }
    else { ops.push({ type: 'add', b: j }); j += 1; }
  }
  while (i < n) { ops.push({ type: 'del', a: i }); i += 1; }
  while (j < m) { ops.push({ type: 'add', b: j }); j += 1; }

  // Контекст ±3 вокруг блоков изменений.
  const diff = [];
  let diffLines = 0;
  let k = 0;
  const shown = new Array(ops.length).fill(false);
  for (k = 0; k < ops.length; k += 1) {
    if (ops[k].type === 'ctx') continue;
    for (let t = Math.max(0, k - 3); t <= Math.min(ops.length - 1, k + 3); t += 1) shown[t] = true;
  }
  let lastShown = -1;
  for (k = 0; k < ops.length; k += 1) {
    if (!shown[k]) continue;
    if (lastShown !== -1 && k - lastShown > 1) {
      diff.push({ type: 'hunk', text: `… строки ${ops[k].a != null ? ops[k].a + 1 : ops[k].b + 1} …` });
    }
    lastShown = k;
    const op = ops[k];
    const no = op.type === 'del' || op.type === 'ctx' ? op.a + 1 : null;
    const nn = op.type === 'add' || op.type === 'ctx' ? op.b + 1 : null;
    const text = op.type === 'del' ? aLines[op.a] : bLines[op.b];
    if (op.type !== 'ctx') diffLines += 1;
    const lineNo = op.type === 'add' ? `+${nn}` : `-${no}`;
    diff.push({
      type: op.type,
      text: `${op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' '}${text}`,
      lineNo: `${no ?? ''} → ${nn ?? ''}`,
    });
    if (diff.length > maxDiffLines) {
      diff.push({ type: 'hunk', text: '… diff обрезан (слишком много отличий) …' });
      break;
    }
  }
  return { diffLines, diff, truncated: false };
}

/**
 * Сравнить скрипт приложения с эталоном из GitLab.
 * @param {string} appScript — скрипт приложения (из движка)
 * @param {string} gitlabScript — эталонный .qvs
 * @param {number} [maxDiffLines] — предел построчного вывода
 * @returns {{ status: 'sync'|'drift'|'empty', diffLines: number,
 *   diff: Array<{type: string, text: string}>, truncated: boolean }}
 */
export function compareScripts(appScript, gitlabScript, maxDiffLines = MAX_DIFF_LINES) {
  const a = normalizeForCompare(appScript);
  const b = normalizeForCompare(gitlabScript);
  if (!b.trim()) return { status: 'empty', diffLines: 0, diff: [], truncated: false };
  if (a === b) return { status: 'sync', diffLines: 0, diff: [], truncated: false };
  const r = buildDiff(a.split('\n'), b.split('\n'), maxDiffLines);
  return { status: 'drift', ...r };
}
