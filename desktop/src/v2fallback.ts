/**
 * Совместимость старых пакетных прогонов с оценкой v2.
 *
 * Прогоны, сделанные до 0.12.0, не содержат в summary ни оценок доменов,
 * ни первоочередных исправлений. Чтобы сводные представления не были
 * пустыми, недостающие поля пересчитываются на месте по находкам —
 * той же функцией computeScore, что и в ядре анализа.
 */
import { computeScore } from '../../src/score/index.js';
import type { BatchItem, RefactorChange } from './types.js';
import { DOMAIN_ORDER } from '../../src/rules/domains.js';

const DOMAIN_IDS = DOMAIN_ORDER;

type DomainsInfo = NonNullable<BatchItem['summary']>['domains'];
type TopInfo = NonNullable<BatchItem['summary']>['top'];

/** Возвращает домены и топ-исправления прогона, пересчитывая их при необходимости. */
export function v2Info(item: BatchItem): { domains: DomainsInfo; top: TopInfo } {
  const s = item.summary;
  const hasDomains = s && Object.keys(s.domains ?? {}).length > 0;
  const hasTop = s && (s.top?.length ?? 0) > 0;
  if (hasDomains && hasTop) return { domains: s.domains, top: s.top };
  const recomputed = computeScore(item.findings ?? []) as {
    domains: DomainsInfo; top: TopInfo;
  };
  let domains = (hasDomains ? s!.domains : recomputed.domains) as DomainsInfo;
  // Приложение анализировалось, но по какому-то домену нет ни одной находки —
  // это «нарушений не найдено», а не «нет данных»: в тепловой карте сводного
  // отчёта такой домен показывается зелёным со баллом 100 (как в макете).
  if (s && Object.keys(domains ?? {}).length === 0) {
    domains = Object.fromEntries(DOMAIN_IDS.map((id) => [id, {
      score: 100, verdict: 'Отлично', word: 'отлично', findings: 0, places: 0,
    }])) as DomainsInfo;
  }
  return {
    domains,
    top: (hasTop ? s!.top : recomputed.top) as TopInfo,
  };
}

export type { RefactorChange };
