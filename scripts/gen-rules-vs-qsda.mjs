/**
 * Генерация docs/rules-vs-qsda.md — таблица соответствия наших правил флагам QSDA Pro V3.7.
 * Запуск: node scripts/gen-rules-vs-qsda.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_RULES } from '../src/rules/index.js';
import { QSDA_FLAGS, QSDA_NOT_IMPLEMENTED } from '../src/rules/qsda-map.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../docs/rules-vs-qsda.md');

const covered = new Set(ALL_RULES.flatMap((r) => r.qsdaFlags ?? []));
const rulesByFlag = new Map();
for (const r of ALL_RULES) {
  for (const slug of r.qsdaFlags ?? []) {
    if (!rulesByFlag.has(slug)) rulesByFlag.set(slug, []);
    rulesByFlag.get(slug).push(r);
  }
}

const flagRows = Object.entries(QSDA_FLAGS)
  .sort((a, b) => a[1].localeCompare(b[1]))
  .map(([slug, name]) => {
    const rules = rulesByFlag.get(slug) ?? [];
    const ids = rules.length ? rules.map((r) => `\`${r.id}\``).join(', ') : '—';
    return `| ${name} | ${ids} | ${covered.has(slug) ? '✅' : '⛔'} |`;
  });

const ownRows = ALL_RULES
  .filter((r) => !(r.qsdaFlags ?? []).length)
  .map((r) => `| \`${r.id}\` | ${r.category} | ${r.title} | — |`)
  .sort();

const md = `# Наши правила и флаги QSDA Pro V3.7

Сгенерировано: \`node scripts/gen-rules-vs-qsda.mjs\`.
Справочник QSDA с описаниями: [qsda-flags-v3.7.md](./qsda-flags-v3.7.md).

**Покрытие: ${covered.size} из ${Object.keys(QSDA_FLAGS).length} флагов QSDA V3.7.**

## Соответствие

| Флаг QSDA | Наши правила | Статус |
|---|---|---|
${flagRows.join('\n')}

## Наши правила без аналога в QSDA

| ID | Категория | Правило | Флаг QSDA |
|---|---|---|---|
${ownRows.join('\n')}

## Не реализовано (осознанный долг)

${QSDA_NOT_IMPLEMENTED.map((s) => `- **${QSDA_FLAGS[s]}** — ${s}`).join('\n')}

Большинство из них требуют master items, закладок, расширений и тем —
то есть доступны только в Qlik Sense. В QlikView 12 эти проверки помечаются
«не применимо».
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md, 'utf8');
console.log(`Записано: ${OUT} (покрыто ${covered.size} из ${Object.keys(QSDA_FLAGS).length})`);
