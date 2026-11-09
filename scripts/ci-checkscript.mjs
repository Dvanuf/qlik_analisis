#!/usr/bin/env node
/**
 * CI-проверка скрипта загрузки: `npm run ci:checkscript -- путь/к/скрипту.qvs`.
 *
 * Разбирает файл офлайн и возвращает код 1, если ядро нашло ошибки
 * (severity error): синтаксические, ссылки на несуществующие поля,
 * секреты и т.д. Предупреждения и замечания в код возврата не входят —
 * их место в отчёте CI (job artifact), а не в блокировке merge request.
 *
 * Схема повторяет qlbuilder checkscript, но без временного приложения:
 * проверка статическая. Проверку синтаксиса сервером (L001/S014) в CI
 * добавит отдельный шаг против Engine, когда появится доступ.
 */
import { resolve } from 'node:path';
import { extractFromFile } from '../src/connectors/file.js';
import { analyze } from '../src/analyzer.js';

const file = process.argv[2];
if (!file) {
  console.error('Использование: npm run ci:checkscript -- путь/к/скрипту.qvs');
  process.exit(2);
}

const graph = await extractFromFile({ file: resolve(file), fileType: 'script' });
if (!graph.script.trim()) {
  console.error(`Файл не распознан как скрипт Qlik: ${file}`);
  for (const s of graph.meta.skipped ?? []) console.error(`Причина: ${s.reason}`);
  process.exit(2);
}

const result = analyze(graph, {});
const errors = result.findings.filter((f) => f.severity === 'error');
for (const f of result.findings) {
  const mark = f.severity === 'error' ? '[ошибка]' : f.severity === 'warning' ? '[предупр]' : '[замечан]';
  console.log(`${mark} ${f.ruleId}: ${f.message}`);
}

if (errors.length) {
  console.error(`\nПроверка не пройдена: ошибок ${errors.length}.`);
  process.exit(1);
}
console.log('\nОшибок нет.');
