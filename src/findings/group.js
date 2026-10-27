/**
 * Группировка однотипных находок.
 *
 * Правила вроде «Несогласованное именование» дают по находке на каждый
 * объект: двадцать строк об одном и том же дефекте. Пользователю нужен
 * один список. Поэтому такие находки сворачиваются в одну запись, где
 * перечислены все затронутые объекты.
 *
 * Сворачиваются только правила, помеченные как groupable: у каждого из
 * них находки однотипны по смыслу (отличаются лишь именем объекта).
 */

/** Правила, находки по которым сворачиваются в одну запись. */
export const GROUPABLE_RULES = new Set(['P010']);

/** Сколько имён показывать в сообщении до многоточия. */
const MAX_NAMES_IN_MESSAGE = 8;

/**
 * Сворачивает однотипные находки в одну.
 *
 * @param {object[]} findings — находки
 * @param {Set<string>} [groupable] — правила, которые сворачиваются
 * @returns {object[]} находки с группами
 */
export function groupFindings(findings, groupable = GROUPABLE_RULES) {
  const out = [];
  const groups = new Map();

  for (const finding of findings ?? []) {
    if (!groupable.has(finding.ruleId)) {
      out.push(finding);
      continue;
    }
    const key = `${finding.ruleId}|${finding.category}|${finding.title}`;
    if (!groups.has(key)) {
      const first = { ...finding, count: 1, objects: [finding.target?.name ?? ''] };
      groups.set(key, first);
      out.push(first);
      continue;
    }
    const group = groups.get(key);
    group.count += 1;
    const name = finding.target?.name ?? '';
    if (name && !group.objects.includes(name)) group.objects.push(name);
  }

  for (const group of groups.values()) {
    group.objects = group.objects.filter(Boolean);
    const names = group.objects;
    const shown = names.slice(0, MAX_NAMES_IN_MESSAGE).join(', ');
    const rest = names.length - MAX_NAMES_IN_MESSAGE;
    group.message = names.length === 1
      ? group.message
      : `Затронуто объектов: ${names.length} — ${shown}${rest > 0 ? ` и ещё ${rest}` : ''}`;
    group.detail = names.length ? `Объекты: ${names.join(', ')}` : group.detail;
    group.target = { kind: 'objects', name: `${names.length} объект(ов)`, id: group.ruleId };
  }

  return out;
}
