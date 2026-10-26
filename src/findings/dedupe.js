/**
 * Дедупликация находок.
 *
 * Одинаковые находки («правило + объект + текст») объединяются в одну запись
 * со счётчиком повторов и списком таблиц, где они встречаются.
 * Так список из 200 однотипных строк превращается в 5 строк с пометкой «×40».
 */

/** Таблица, к которой относится находка. */
function tableOf(finding) {
  if (!finding) return null;
  if (finding.table) return String(finding.table);
  if (finding.target?.kind === 'table') return String(finding.target.name ?? '') || null;
  return null;
}

/** Ключ группировки: правило + вид объекта + имя объекта + текст. */
export function findingKey(finding) {
  return [
    finding.ruleId ?? '',
    finding.target?.kind ?? '',
    finding.target?.name ?? '',
    finding.message ?? '',
  ].join('|');
}

/**
 * @param {object[]} findings
 * @returns {object[]} находки с полями count и tables
 */
export function dedupeFindings(findings) {
  const byKey = new Map();
  const out = [];

  for (const finding of findings ?? []) {
    const key = findingKey(finding);
    const existing = byKey.get(key);
    if (!existing) {
      const copy = { ...finding, count: 1, tables: tableOf(finding) ? [tableOf(finding)] : [] };
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    existing.count += 1;
    const table = tableOf(finding);
    if (table && !existing.tables.includes(table)) existing.tables.push(table);
  }

  return out;
}

/**
 * Сколько находок было свёрнуто.
 * @param {object[]} original
 * @param {object[]} deduped
 */
export function dedupeStats(original, deduped) {
  const before = (original ?? []).length;
  const after = (deduped ?? []).length;
  return { before, after, merged: Math.max(0, before - after) };
}
