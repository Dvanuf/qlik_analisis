/**
 * JUnit XML для CI: структура, экранирование, passed/skipped, shouldFail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJUnitXml, shouldFail } from '../src/report/junit.js';

const findings = [
  { ruleId: 'S010', severity: 'error', title: 'Незакрытая строка', message: 'Строка 10: <незакрыто> & "кавычки"', recommendation: 'Закрыть строку', domain: 'script', count: 1 },
  { ruleId: 'R001', severity: 'warning', title: 'Неиспользуемое поле', message: 'Поле «X» не используется', domain: 'model', count: 3 },
];
const ruleStats = [
  { id: 'S010', title: 'Незакрытая строка', domain: 'script', skipped: false },
  { id: 'R001', title: 'Неиспользуемое поле', domain: 'model', skipped: false },
  { id: 'R003', title: 'Неиспользуемая таблица', domain: 'model', skipped: true, note: 'сервер не отдал сведения' },
];

test('buildJUnitXml: testsuite, failures и skipped', () => {
  const xml = buildJUnitXml({ appName: 'Продажи', findings, ruleStats });
  assert.ok(xml.startsWith('<?xml version="1.0"'));
  assert.ok(xml.includes('testsuite name="Продажи"'));
  assert.ok(xml.includes('failures="2"'));
  assert.ok(xml.includes('<failure'), 'находки — failure');
  assert.ok(xml.includes('<skipped message="сервер не отдал сведения" />'), 'пропущенное правило — skipped');
  assert.ok(xml.includes('name="S010: Незакрытая строка"'), 'testcase по правилу');
});

test('buildJUnitXml: экранирование XML-спецсимволов', () => {
  const xml = buildJUnitXml({ appName: 'a<b>&"c"', findings, ruleStats: [] });
  assert.ok(xml.includes('a&lt;b&gt;&amp;&quot;c&quot;'), 'спецсимволы экранированы');
  assert.ok(xml.includes('&lt;незакрыто&gt; &amp; &quot;кавычки&quot;'), 'тело failure экранировано');
});

test('shouldFail: уровни error/warning/info/none', () => {
  const s = { error: 0, warning: 3, info: 5 };
  assert.equal(shouldFail(s, 'none'), false);
  assert.equal(shouldFail(s, 'error'), false);
  assert.equal(shouldFail(s, 'warning'), true);
  assert.equal(shouldFail(s, 'info'), true);
  assert.equal(shouldFail({ error: 1, warning: 0, info: 0 }, 'error'), true);
  assert.equal(shouldFail(undefined, 'error'), false);
});
