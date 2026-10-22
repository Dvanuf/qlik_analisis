import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_RULES, RULES_BY_ID } from '../src/rules/index.js';
import { QSDA_FLAGS, RULE_QSDA, QSDA_NOT_IMPLEMENTED } from '../src/rules/qsda-map.js';
import { analyze } from '../src/analyzer.js';

test('все ссылки на флаги QSDA существуют в справочнике', () => {
  for (const [ruleId, slugs] of Object.entries(RULE_QSDA)) {
    for (const slug of slugs) {
      assert.ok(QSDA_FLAGS[slug], `правило ${ruleId} ссылается на неизвестный флаг ${slug}`);
    }
  }
});

test('справочник QSDA покрывает все 39 флагов V3.7', () => {
  assert.equal(Object.keys(QSDA_FLAGS).length, 39);
});

test('реализовано не менее 24 флагов QSDA', () => {
  const covered = new Set(Object.values(RULE_QSDA).flat());
  assert.ok(covered.size >= 24, `покрыто ${covered.size}`);
  for (const slug of QSDA_NOT_IMPLEMENTED) {
    assert.ok(!covered.has(slug), `флаг ${slug} помечен как нереализованный, но покрыт`);
  }
});

test('новые правила зарегистрированы', () => {
  for (const id of ['R010', 'R011', 'R012', 'R013', 'R014', 'P011']) {
    assert.ok(RULES_BY_ID.has(id), `нет правила ${id}`);
    assert.ok(RULES_BY_ID.get(id).qsdaName, `у правила ${id} нет флага QSDA`);
  }
});

test('R010: ключевое поле с неполным subset ratio', () => {
  const graph = {
    meta: { source: 'test', capabilities: [], skipped: [] },
    appName: 't', appId: '', script: '',
    sheets: [], objects: [], variables: [], bookmarks: [], extensions: [],
    fields: [
      { name: 'ID', table: 'T', key: true, rows: 100, nonNulls: 90, distinct: 90, subsetRatio: 0.9 },
      { name: 'OK', table: 'T', key: true, rows: 100, nonNulls: 100, distinct: 100, subsetRatio: 1 },
    ],
    tables: [],
  };
  const res = analyze(graph, {});
  const found = res.findings.filter((f) => f.ruleId === 'R010');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /90%/);
});

test('R013: приложение без превью', () => {
  const graph = {
    meta: { source: 'test', capabilities: [], skipped: [], thumbnail: {} },
    appName: 't', appId: '', script: '', sheets: [], objects: [], variables: [],
    fields: [], tables: [], bookmarks: [], extensions: [],
  };
  const res = analyze(graph, {});
  assert.ok(res.findings.some((f) => f.ruleId === 'R013'));
});

test('P011: условная агрегация в выражении', () => {
  const graph = {
    meta: { source: 'test', capabilities: [], skipped: [] },
    appName: 't', appId: '', script: '', sheets: [], variables: [], fields: [], tables: [],
    bookmarks: [], extensions: [],
    objects: [{
      id: 'o1', name: 'obj', type: 'chart', description: '',
      expressions: [{ kind: 'measure', expr: "If([Region]='EU', Sum([Sales]), Count([Orders]))" }],
    }],
  };
  const res = analyze(graph, {});
  assert.ok(res.findings.some((f) => f.ruleId === 'P011'));
});

test('платформа влияет на применимость правил', () => {
  const graph = {
    meta: { source: 'test', capabilities: [], skipped: [] },
    appName: 't', appId: '', script: '', sheets: [], objects: [], variables: [],
    fields: [], tables: [], bookmarks: [], extensions: [],
  };
  const qv = analyze(graph, { platform: 'qlikview' });
  const qs = analyze(graph, { platform: 'qlik-sense' });
  assert.ok(qv.ruleStats.length > 0 && qs.ruleStats.length > 0);
  // Правило, ограниченное Qlik Sense, должно быть пропущено на QlikView
  const onlyQs = ALL_RULES.find((r) => r.platforms.length === 1 && r.platforms[0] === 'qlik-sense');
  if (onlyQs) {
    const stat = qv.ruleStats.find((s) => s.id === onlyQs.id);
    assert.equal(stat.skipped, true);
  }
});
