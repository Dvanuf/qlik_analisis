/**
 * Экспорт реестра правил в Excel: код, название, описание, важность,
 * домен, платформа, рекомендация.
 *
 * Запуск: node tools/export-rules.mjs [путь-результата]
 * По умолчанию пишет «qlik-analyzer-правила.xlsx» рядом с проектом.
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_RULES } from '../src/rules/index.js';
import { DOMAIN_LABELS, domainForRule } from '../src/rules/domains.js';
import { platformLabel, isRuleApplicable, PLATFORM_SENSE, PLATFORM_VIEW } from '../src/rules/platforms.js';
import { buildXlsx } from '../src/report/xlsx.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', process.argv[2] ?? '../qlik-analyzer-правила.xlsx');

const SEVERITY_LABELS = { error: 'Ошибка', warning: 'Предупреждение', info: 'Инфо' };
const CATEGORY_LABELS = {
  Quality: 'Качество выражений',
  Resources: 'Ресурсы и данные',
  Practices: 'Практики разработки',
  Script: 'Скрипт загрузки',
};

/** Платформы правила строкой: «Sense + QlikView» или перечисление. */
function platformsText(rule) {
  const applicable = [
    platformLabel(PLATFORM_SENSE),
    platformLabel(PLATFORM_VIEW),
  ].filter((_, i) => isRuleApplicable(rule, i === 0 ? PLATFORM_SENSE : PLATFORM_VIEW));
  return applicable.length === 2 ? 'Sense + QlikView' : applicable.join(', ');
}

const rows = ALL_RULES
  .map((r) => ({
    code: r.id,
    human: r.humanTitle ?? r.title,
    category: CATEGORY_LABELS[r.category] ?? r.category,
    severity: SEVERITY_LABELS[r.severity] ?? r.severity,
    domain: DOMAIN_LABELS[domainForRule(r.id, r.category)] ?? '',
    platforms: platformsText(r),
    what: r.whatHappened ?? '',
    description: r.description ?? '',
    recommendation: r.recommendation ?? '',
  }))
  .sort((a, b) => a.code.localeCompare(b.code))
  .map((r) => [r.code, r.human, r.category, r.severity, r.domain, r.platforms, r.what, r.description, r.recommendation]);

const headers = ['Код', 'Правило', 'Категория', 'Важность', 'Домен', 'Платформы', 'Что случилось', 'Описание', 'Рекомендация'];
writeFileSync(out, buildXlsx(headers, rows, 'Правила'));
console.log(`Правил: ${ALL_RULES.length} → ${out}`);
