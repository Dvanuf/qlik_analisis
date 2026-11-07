/**
 * Превью оценки v2 по реальным приложениям (стоп-точка 0.12.0).
 *
 * Читает кэш пакетного прогона (настоящие находки реальных приложений),
 * пересчитывает балл по новой формуле и печатает таблицу. Используется
 * для калибровки весов ДО релиза: если баллы кажутся смещёнными, меняем
 * weights/ceilings в rules.json, а не код.
 *
 * Запуск: node tools/score-preview.mjs [N — сколько приложений показать]
 *
 * Ограничение: в кэше нет общего числа строк модели, поэтому штраф за
 * лишние данные здесь всегда 0 — для полной оценки нужен живой прогон.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScore } from '../src/score/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = resolve(
  process.env.HOME ?? '/Users/anufriev_d_v',
  'Library/Application Support/qlik-analyzer-desktop/cache',
);
const take = Number(process.argv[2] ?? 8);

if (!existsSync(cacheDir)) {
  console.log('Кэш пакетного прогона не найден:', cacheDir);
  process.exit(0);
}

const rows = [];
for (const file of readdirSync(cacheDir)) {
  if (!file.endsWith('.json')) continue;
  try {
    const entry = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'));
    if (!entry?.findings || !entry.summary) continue;
    rows.push(entry);
  } catch { /* битый кэш пропускаем */ }
}

// Приоритет: приложения, названные в ТЗ/макете (checker), затем по дате.
rows.sort((a, b) => {
  const ac = /checker/i.test(a.title ?? '') ? 0 : 1;
  const bc = /checker/i.test(b.title ?? '') ? 0 : 1;
  return ac - bc || String(b.at ?? '').localeCompare(String(a.at ?? ''));
});

console.log(`Приложений в кэше: ${rows.length}. Показываю первые ${Math.min(take, rows.length)}.\n`);
console.log('Приложение                              Балл  Вердикт             Ошиб/Пред/Замеч  Мест   Топ-исправление (+балл)');
console.log('-'.repeat(132));

for (const entry of rows.slice(0, take)) {
  const s = computeScore(entry.findings ?? [], { totalRows: 0 });
  const sev = s.details
    ? `${s.details.penalties.error ? 'E' : ''}`
    : '';
  const top = s.top[0] ? `${s.top[0].title.slice(0, 34)} (+${s.top[0].gain})` : '—';
  const counts = `${s.details.penalties.error ? '▲' : '·'}${s.details.penalties.warning ? '▲' : '·'}${s.details.penalties.info ? '▲' : '·'}`;
  const errW = `${entry.summary?.findings?.bySeverity?.error ?? 0}/${entry.summary?.findings?.bySeverity?.warning ?? 0}/${entry.summary?.findings?.bySeverity?.info ?? 0}`;
  const name = String(entry.title ?? entry.appId ?? '?').slice(0, 38).padEnd(38);
  const scoreStr = String(s.score).padStart(3);
  const verdict = s.verdict.padEnd(19);
  const places = String(s.details.places).padStart(5);
  console.log(`${name}  ${scoreStr}  ${verdict} ${errW.padStart(15)}  ${places}   ${top}  [${s.top.length > 1 ? `+${s.top[1].gain}…` : ''}] ${counts}`);
}

console.log('\nФормула: 100 − штрафы (ошибка 10, предупреждение 3, замечание 0,5; вес паттерна ×(1+log2 мест);');
console.log('потолки 40/30/10). Штраф за лишние данные в этом превью = 0: в кэше нет общего числа строк.');
console.log('Веса настраиваются в rules.json (раздел scoring) без правки кода.');
