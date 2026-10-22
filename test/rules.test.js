import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { analyze } from '../src/analyzer.js';
import { ALL_RULES, RULES_BY_ID } from '../src/rules/index.js';
import { renderHtml } from '../src/report/html.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, 'fixtures/app-graph.json'), 'utf8'));

const result = analyze(fixture, {});
const ids = new Set(result.findings.map((f) => f.ruleId));
const byId = (id) => result.findings.filter((f) => f.ruleId === id);

test('правила зарегистрированы и имеют уникальные ID', () => {
  assert.ok(ALL_RULES.length >= 25, 'ожидается не менее 25 правил');
  assert.equal(new Set(ALL_RULES.map((r) => r.id)).size, ALL_RULES.length);
  for (const rule of ALL_RULES) {
    assert.ok(rule.id && rule.title && rule.description && rule.recommendation, `rule ${rule.id} заполнен`);
    assert.ok(['Quality', 'Resources', 'Practices', 'Script'].includes(rule.category));
    assert.ok(['error', 'warning', 'info'].includes(rule.severity));
    assert.equal(typeof rule.run, 'function');
  }
});

test('Quality: найдена синтаксическая ошибка', () => {
  assert.ok(ids.has('Q001'));
});

test('Quality: найдена ссылка на несуществующее поле', () => {
  assert.ok(ids.has('Q002'));
  assert.ok(byId('Q002').some((f) => f.message.includes('NoSuchField')));
});

test('Quality: найдена ссылка на неопределённую переменную', () => {
  assert.ok(ids.has('Q003'));
});

test('Quality: найдена неизвестная функция', () => {
  assert.ok(ids.has('Q004'));
  assert.ok(byId('Q004').some((f) => f.message.includes('Smm')));
});

test('Quality: найден объект без описания', () => {
  assert.ok(ids.has('Q006'));
});

test('Resources: найдено неиспользуемое поле', () => {
  assert.ok(ids.has('R001'));
  assert.ok(byId('R001').some((f) => f.target.name === 'CustomerID'));
});

test('Resources: найдена неиспользуемая таблица', () => {
  assert.ok(ids.has('R003'));
  assert.ok(byId('R003').some((f) => f.target.name === 'Staging'));
});

test('Resources: найдена неиспользуемая переменная', () => {
  assert.ok(ids.has('R004'));
  assert.ok(byId('R004').some((f) => f.target.name === 'vUnused'));
});

test('Resources: найдено поле, полностью заполненное NULL', () => {
  assert.ok(ids.has('R005'));
  assert.ok(byId('R005').some((f) => f.target.name === 'Comment'));
});

test('Resources: найдена пустая таблица', () => {
  assert.ok(ids.has('R006'));
});

test('Resources: найден ключ, подходящий под AutoNumber', () => {
  assert.ok(ids.has('R007'));
  assert.ok(byId('R007').some((f) => f.target.name === 'OrderID'));
});

test('Resources: найден лист без объектов', () => {
  assert.ok(ids.has('R008'));
});

test('Practices: найдено дублирующееся выражение', () => {
  assert.ok(ids.has('P001'));
});

test('Practices: найдены совпадающие меры с разными именами', () => {
  assert.ok(ids.has('P002'));
});

test('Practices: найдено использование ключевого поля в выражении', () => {
  assert.ok(ids.has('P003'));
  assert.ok(byId('P003').some((f) => f.message.includes('OrderID')));
});

test('Practices: найден дубликат названия объекта', () => {
  assert.ok(ids.has('P004'));
  assert.ok(byId('P004').some((f) => f.message.includes('Margin')));
});

test('Practices: найден синтетический ключ', () => {
  assert.ok(ids.has('P005'));
  assert.ok(byId('P005').some((f) => f.target.name === 'Staging'));
});

test('Practices: найдено вычисляемое измерение', () => {
  assert.ok(ids.has('P006'));
});

test('Practices: найдено выражение по нескольким таблицам', () => {
  assert.ok(ids.has('P007'));
});

test('Practices: найден data island (Aggr)', () => {
  assert.ok(ids.has('P008'));
});

test('Practices: найдено сложное выражение', () => {
  assert.ok(ids.has('P009'));
});

test('патч скрипта содержит DROP FIELD и DROP TABLE', () => {
  assert.ok(result.patch.dropFields.includes('CustomerID'));
  assert.ok(result.patch.dropTables.includes('Staging'));
  assert.match(result.patch.script, /DROP FIELD/);
  assert.match(result.patch.script, /DROP TABLE/);
});

test('сводка считает находки по категориям', () => {
  assert.equal(result.summary.findings.total, result.findings.length);
  const sum = Object.values(result.summary.findings.byCategory).reduce((a, b) => a + b, 0);
  assert.equal(sum, result.findings.length);
});

test('правила можно отключать', () => {
  const only = analyze(fixture, { disabledRules: ['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007', 'R008', 'R009'] });
  assert.equal(only.findings.some((f) => f.category === 'Resources'), false);
  const stat = only.ruleStats.find((s) => s.id === 'R001');
  assert.equal(stat.skipped, true);
});

test('HTML-отчёт содержит сводку, находки и каталог правил', () => {
  const html = renderHtml(result);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Demo Sales'));
  assert.ok(html.includes('Каталог правил'));
  assert.ok(html.includes('DROP FIELD'));
  assert.ok(html.includes('data-category="Quality"'));
});

test('все правила отрабатывают без исключений на фикстуре', () => {
  assert.deepEqual(result.errors, []);
  for (const rule of ALL_RULES) assert.ok(RULES_BY_ID.has(rule.id));
});
