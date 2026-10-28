/**
 * Тесты доменов и паттернов: версия 0.6.3.
 *
 * Домен отвечает на вопрос «что проверяем» (модель данных, скрипт, дашборд…),
 * паттерн — на вопрос «в чём причина»: одна причина — одна строка, места
 * перечислены внутри.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAIN_ORDER, DOMAIN_LABELS, DOMAIN_RULES, domainForRule, groupRulesByDomain,
} from '../src/rules/domains.js';
import { ALL_RULES } from '../src/rules/index.js';
import { buildPatterns, causeKey, groupPatternsByRule } from '../src/findings/patterns.js';
import { analyze } from '../src/analyzer.js';

// --- Домены ---

test('каждое правило попадает в домен', () => {
  const mapped = new Set(Object.values(DOMAIN_RULES).flat());
  for (const rule of ALL_RULES) {
    assert.ok(mapped.has(rule.id), `${rule.id} не отнесён ни к одному домену`);
  }
  assert.equal(mapped.size, ALL_RULES.length);
});

test('в доменах нет правил, которых не существует', () => {
  const ids = new Set(ALL_RULES.map((r) => r.id));
  for (const [domain, list] of Object.entries(DOMAIN_RULES)) {
    for (const id of list) {
      assert.ok(ids.has(id), `${id} в домене ${domain} не существует`);
    }
  }
});

test('у каждого домена есть подпись', () => {
  for (const d of DOMAIN_ORDER) {
    assert.ok(DOMAIN_LABELS[d], `нет подписи у домена ${d}`);
  }
});

test('правило без разметки попадает в домен по категории', () => {
  assert.equal(domainForRule('X999', 'Script'), 'script');
  assert.equal(domainForRule('X999', 'Quality'), 'model');
  assert.equal(domainForRule('R001', 'Quality'), 'model');
});

test('правила разбиты по доменам без потерь', () => {
  const stats = ALL_RULES.map((r) => ({ id: r.id, category: r.category }));
  const grouped = groupRulesByDomain(stats);
  const total = Object.values(grouped).reduce((a, list) => a + list.length, 0);
  assert.equal(total, ALL_RULES.length);
});

// --- Паттерны ---

/** Находка-образец: объект без привязки к строке. */
function finding(over = {}) {
  return {
    ruleId: 'R001',
    category: 'Resources',
    severity: 'warning',
    title: 'Неиспользуемое поле',
    message: 'Поле «x» не используется',
    recommendation: 'Удалить поле',
    target: { kind: 'field', name: 'x', id: 'x' },
    ...over,
  };
}

test('находки с одной причиной собираются в один паттерн', () => {
  const list = [
    finding({ target: { kind: 'field', name: 'a' } }),
    finding({ target: { kind: 'field', name: 'b' } }),
  ];
  const patterns = buildPatterns(list);
  assert.equal(patterns.length, 2, 'разные поля — разные причины');
});

test('одинаковая нормализованная форма выражения — одна причина', () => {
  const list = [
    finding({
      ruleId: 'P001',
      target: { kind: 'expression', name: 'Выручка' },
      detail: 'Нормализованная форма: sum([x])',
    }),
    finding({
      ruleId: 'P001',
      target: { kind: 'expression', name: 'Маржа' },
      detail: 'Нормализованная форма: sum([x])',
    }),
  ];
  const patterns = buildPatterns(list);
  assert.equal(patterns.length, 1, 'одно выражение — одна причина');
  assert.equal(patterns[0].places.length, 2, 'оба объекта — места этой причины');
  assert.equal(patterns[0].expression, 'sum([x])');
});

test('перечисленные правилом объекты становятся местами', () => {
  const list = [
    finding({
      ruleId: 'P002',
      target: { kind: 'measure', name: 'a' },
      detail: 'Нормализованная форма: sum([x])',
      objects: ['a', 'b', 'c'],
    }),
  ];
  const patterns = buildPatterns(list);
  assert.equal(patterns[0].places.length, 3);
  assert.equal(patterns[0].count, 3);
});

test('паттерны группируются по правилам', () => {
  const list = [
    finding({ ruleId: 'R001', target: { kind: 'field', name: 'a' } }),
    finding({ ruleId: 'R001', target: { kind: 'field', name: 'b' } }),
    finding({ ruleId: 'P001', target: { kind: 'expression', name: 'c' } }),
  ];
  const grouped = groupPatternsByRule(list);
  assert.equal(grouped.rules.length, 2);
  const r001 = grouped.rules.find((r) => r.ruleId === 'R001');
  assert.equal(r001.patterns.length, 2);
  assert.equal(r001.places, 2);
  assert.equal(grouped.places, 3);
});

test('паттерны фильтруются по домену', () => {
  const list = [
    finding({ ruleId: 'R001', domain: 'model' }),
    finding({ ruleId: 'S001', domain: 'script', target: { kind: 'table', name: 't' } }),
  ];
  assert.equal(buildPatterns(list, { domains: ['model'] }).length, 1);
  assert.equal(buildPatterns(list, { domains: ['script'] }).length, 1);
});

test('ключ причины различает объекты и выражения', () => {
  assert.notEqual(
    causeKey(finding({ target: { kind: 'object', name: 'a' } })),
    causeKey(finding({ target: { kind: 'object', name: 'b' } })),
  );
});

// --- Сквозная проверка: домены и паттерны в результате анализа ---

test('анализ отдаёт сводку по доменам и паттерны', () => {
  const graph = {
    appName: 'Тест',
    appId: 'x',
    script: 'LOAD * FROM "T1";\nLOAD * FROM "T2";',
    tables: [{ name: 'T1', keyFields: ['id'], synthetic: false, fields: ['id', 'unused'], rows: 10 }],
    fields: [{ name: 'unused', table: 'T1', rows: 10, distinct: 1 }],
    objects: [],
    sheets: [],
    variables: [],
    masterObjects: [],
    connections: [],
    bookmarks: [],
    meta: { platform: 'qlik-sense', capabilities: [] },
  };
  const res = analyze(graph, {});
  const byDomain = res.summary.findings.byDomain;
  assert.ok(byDomain.model, 'нет домена «Модель данных»');
  assert.ok(byDomain.model.total > 0, 'в домене должны быть правила');
  assert.ok(Array.isArray(res.patterns), 'нет паттернов');
  assert.ok(res.patternRules.length > 0, 'паттерны не сгруппированы по правилам');
  for (const f of res.findings) {
    assert.ok(f.domain, `у находки ${f.ruleId} нет домена`);
  }
});
