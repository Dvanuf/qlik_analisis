/**
 * Общие помощники фильтров (аудит C13: uniq-опции были продублированы
 * в «Оценке», «Сводном отчёте» и «Подключении»).
 */

/** Уникальные непустые значения, отсортированные по алфавиту. */
export function uniqSorted(vals: (string | null | undefined)[]): string[] {
  return [...new Set(vals.map((v) => String(v ?? '').trim()).filter(Boolean))].sort();
}

/** Складывает массивы тегов приложений в отсортированный список. */
export function uniqTags(vals: { tags?: string[] }[]): string[] {
  return [...new Set(vals.flatMap((a) => a.tags ?? []))].sort();
}
