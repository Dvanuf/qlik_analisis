/**
 * QlikView-скриптовые правила S015–S019: Binary, ErrorMode, Sleep,
 * include, CALL — проверяются по тексту скрипта без сервера и движка.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';

/** Минимальный граф приложения со скриптом. */
const graph = (script) => ({
  appName: 'Тест', appId: 't-qv', platform: 'qlikview',
  script,
  tables: [{ name: 'T', rows: 100 }],
  fields: [{ name: 'A', table: 'T', rows: 100 }],
  objects: [], variables: [], sheets: [], bookmarks: [], connections: [],
  masterObjects: [], stories: [],
});

const ids = (result) => new Set(result.findings.map((f) => f.ruleId));

test('S015: Binary Load — зависимость от другого документа', () => {
  const r = analyze(graph('Binary [Прoдажи.qvw];\nSales:\nLOAD A FROM t.csv;'), { rules: { disabled: [] } });
  assert.ok(ids(r).has('S015'), 'S015 не сработал на Binary');
  const f = r.findings.find((x) => x.ruleId === 'S015');
  assert.ok(f.lines.includes(1), 'строка Binary не привязана');
});

test('S016: ErrorMode=0 — ошибки маскируются', () => {
  const r = analyze(graph('SET ErrorMode=0;\nLOAD A FROM t.csv;'), { rules: { disabled: [] } });
  assert.ok(ids(r).has('S016'), 'S016 не сработал');
  // ErrorMode=1 (значение по умолчанию) — не находка.
  const ok = analyze(graph('SET ErrorMode=1;\nLOAD A FROM t.csv;'), { rules: { disabled: [] } });
  assert.ok(!ids(ok).has('S016'), 'S016 ложно сработал на ErrorMode=1');
});

test('S017: Sleep — пауза на каждом прогоне', () => {
  // S017 выключен по умолчанию — в тесте включается явно.
  const r = analyze(graph('LOAD A FROM t.csv;\nSleep(300);'), { rules: { disabled: [] } });
  assert.ok(ids(r).has('S017'), 'S017 не сработал');
  const f = r.findings.find((x) => x.ruleId === 'S017');
  assert.match(f.message, /300/);
});

test('S018: include без Must_Include', () => {
  const r = analyze(graph("$(include=lib://config/settings.qvs);\nLOAD A FROM t.csv;"), { rules: { disabled: [] } });
  assert.ok(ids(r).has('S018'), 'S018 не сработал');
  // Must_Include — не находка.
  const ok = analyze(graph("$(Must_Include=lib://config/settings.qvs);\nLOAD A FROM t.csv;"), { rules: { disabled: [] } });
  assert.ok(!ids(ok).has('S018'), 'S018 ложно сработал на Must_Include');
});

test('S019: CALL без определения SUB', () => {
  const r = analyze(graph('CALL DoMagic;\nLOAD A FROM t.csv;\nSUB Other;\nEND SUB;'), { rules: { disabled: [] } });
  assert.ok(ids(r).has('S019'), 'S019 не сработал на CALL DoMagic');
  // CALL определённой подпрограммы — не находка.
  const ok = analyze(graph('CALL Other;\nLOAD A FROM t.csv;\nSUB Other;\nEND SUB;'), { rules: { disabled: [] } });
  assert.ok(!ids(ok).has('S019'), 'S019 ложно сработал на существующий SUB');
  const f = r.findings.find((x) => x.ruleId === 'S019');
  assert.match(f.message, /DoMagic/);
});

test('новые правила применимы к QlikView (не Sense-only)', () => {
  const r = analyze(graph('Binary [x.qvw];\nSET ErrorMode=0;\nLOAD A FROM t.csv;'), { platform: 'qlikview' });
  const skipped = r.ruleStats.filter((st) => ['S015', 'S016', 'S019'].includes(st.id) && st.skipped);
  assert.deepEqual(skipped, [], 'новые правила не должны пропускаться на QlikView');
});

test('S020: секрет открытым текстом — находка со скрытым значением', () => {
  const secret = "SET vPassword = 'СуперСекрет123';\nLET vToken = 'ghp_abc123def456';\nLOAD A FROM t.csv;";
  const r = analyze(graph(secret), { rules: { disabled: [] } });
  const s020 = r.findings.filter((f) => f.ruleId === 'S020');
  assert.equal(s020.length, 2, 'SET и LET с секретом');
  // Значение скрыто и не попадает ни в сообщение, ни в деталь.
  for (const f of s020) {
    assert.ok(!JSON.stringify(f).includes('СуперСекрет'), 'пароль не утекает в находку');
    assert.ok(!JSON.stringify(f).includes('ghp_abc'), 'токен не утекает в находку');
    assert.ok(f.detail.includes('***'), 'значение замаскировано');
  }
  // Подстановка $( ) и комментарий — не секрет.
  const safe = "LET vPwd = $(vFromConn);\n// password = 'в комментарии'\nLOAD A FROM t.csv;";
  const ok = analyze(graph(safe), { rules: { disabled: [] } });
  assert.ok(!ids(ok).has('S020'), 'подстановка и комментарий не флагаются');
});

test('S020: применим к QlikView и Sense', () => {
  const secret = "SET vPassword = 'пароль12345';\nLOAD A FROM t.csv;";
  const qv = analyze(graph(secret), { platform: 'qlikview', rules: { disabled: [] } });
  assert.ok(ids(qv).has('S020'), 'QlikView: правило применимо');
});
