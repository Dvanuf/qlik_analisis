import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, formatSummary } from '../src/ai/summary.js';

/** Заглушка результата анализа нужной формы. */
function fakeAnalysis() {
  return {
    summary: {
      findings: {
        total: 12,
        bySeverity: { error: 3, warning: 5, info: 4 },
        byCategory: { Quality: 7, Resources: 5 },
        byDomain: {
          model: { id: 'model', findings: 4, failed: 2, passed: 10 },
          script: { id: 'script', findings: 8, failed: 3, passed: 7 },
        },
        suppressed: 1,
      },
      score: 72,
      savings: { removableFields: 3, removableRows: 12000 },
    },
    findings: [
      { ruleId: 'S001', severity: 'error', title: 'Без ключа', count: 3 },
      { ruleId: 'S002', severity: 'warning', title: 'Лишнее поле', count: 5 },
      { ruleId: 'R010', severity: 'info', title: 'Метка', count: 4 },
    ],
  };
}

test('сводка: содержит счётчики, скор и топ правил', () => {
  const { text, truncated } = buildSummary({
    analysis: fakeAnalysis(),
    app: { title: 'Продажи РФ', platform: 'qlik-sense' },
  });
  assert.equal(truncated, false);
  assert.match(text, /Продажи РФ/);
  assert.match(text, /скор 0–100\): 72/);
  assert.match(text, /всего: 12/);
  assert.match(text, /ошибок: 3/);
  assert.match(text, /S001/);
  assert.match(text, /Quality/);
});

test('сводка: не содержит сырых данных анализа', () => {
  const analysis = fakeAnalysis();
  analysis.script = 'LOAD SecretField FROM TABLE;';
  const { text } = buildSummary({ analysis, app: { title: 'Продажи' } });
  // Скрипт в сводку не попадает: наружу уходят только агрегаты.
  assert.doesNotMatch(text, /SecretField/);
});

test('сводка: показывает динамику по прогонам', () => {
  const { text } = buildSummary({
    analysis: fakeAnalysis(),
    runs: [
      { at: '2026-03-10T00:00:00Z', score: 72, errors: 3, warnings: 5, total: 12 },
      { at: '2026-03-01T00:00:00Z', score: 60, errors: 6, warnings: 8, total: 18 },
    ],
  });
  assert.match(text, /Динамика по прогонам/);
  assert.match(text, /2026-03-10/);
  assert.match(text, /скор 72/);
});

test('сводка: показывает отклонения от базовой линии', () => {
  const { text } = buildSummary({
    analysis: fakeAnalysis(),
    comparison: {
      added: [{ ruleId: 'S001', target: { name: 'Table_1' }, line: 42 }],
      fixed: [{ ruleId: 'S002', target: { name: 'Table_2' } }],
    },
  });
  assert.match(text, /Отклонения от базовой линии/);
  assert.match(text, /появились/);
  assert.match(text, /Table_1/);
  assert.match(text, /строка 42/);
});

test('сводка: помечается обрезкой при превышении лимита', () => {
  const findings = Array.from({ length: 400 }, (_, i) => ({
    ruleId: `R${i}`, severity: 'warning', title: `Правило номер ${i} с длинным названием`, count: 10,
  }));
  const analysis = fakeAnalysis();
  analysis.findings = findings;
  const { text, truncated } = buildSummary({ analysis, maxChars: 800 });
  assert.equal(truncated, true);
  assert.ok(text.length <= 800, `длина ${text.length} должна быть не больше 800`);
});

test('сводка: обрезка не теряет счётчики находок', () => {
  const findings = Array.from({ length: 400 }, (_, i) => ({
    ruleId: `R${i}`, severity: 'warning', title: `Правило ${i}`, count: 10,
  }));
  const analysis = fakeAnalysis();
  analysis.findings = findings;
  const { text } = buildSummary({ analysis, maxChars: 800 });
  assert.match(text, /всего: 12/);
});

test('сводка: пустой анализ не ломает сборку', () => {
  const { text, truncated } = buildSummary({});
  assert.equal(truncated, false);
  assert.match(text, /всего: 0/);
});

test('сводка: формат выводит потенциал упрощения', () => {
  const data = {
    app: { title: 'X', platform: '', score: 50 },
    totals: { findings: 1, errors: 0, warnings: 1, infos: 0, suppressed: 0 },
    byCategory: {},
    byDomain: {},
    topRules: [],
    savings: { removableFields: 2, removableRows: 500 },
    dynamics: [],
    deviations: { added: [], fixed: [] },
  };
  const text = formatSummary(data);
  assert.match(text, /Потенциал упрощения/);
  assert.match(text, /строк данных: 500/);
test('сводка: показывает владельца приложения', () => {
  const { text } = buildSummary({
    analysis: fakeAnalysis(),
    app: { title: 'Продажи РФ', owner: 'Иванов Иван Иванович' },
  });
  assert.match(text, /владелец: Иванов Иван Иванович/);
});

test('сводка: показывает конкретные находки с объектом, строкой и рекомендацией', () => {
  const analysis = fakeAnalysis();
  analysis.findings.push({
    ruleId: 'S100',
    severity: 'error',
    title: 'Поле без ключа',
    count: 4,
    message: 'Поле не участвует в расчёте',
    recommendation: 'Добавьте ключ',
    target: { kind: 'field', name: 'Amount' },
    table: 'Sales',
    line: 42,
  });
  const { text } = buildSummary({ analysis });
  assert.match(text, /Конкретные находки/);
  assert.match(text, /S100 \[error\]/);
  assert.match(text, /Amount/);
  assert.match(text, /строка 42/);
  assert.match(text, /Рекомендация: Добавьте ключ/);
});

test('сводка: находки, релевантные вопросу, идут первыми', () => {
  const analysis = fakeAnalysis();
  analysis.findings = [
    { ruleId: 'S001', severity: 'error', title: 'Без ключа', count: 1, message: 'Ключ', recommendation: '' },
    { ruleId: 'S900', severity: 'warning', title: 'Размер таблицы Sales', count: 2, message: 'Много строк', recommendation: '' },
  ];
  const { data } = buildSummary({ analysis, question: 'что не так с таблицей Sales' });
  assert.equal(data.concrete[0].ruleId, 'S900');
});

test('сводка: находка, выбранная пользователем, попадает в сводку', () => {
  const { text } = buildSummary({
    analysis: fakeAnalysis(),
    focus: {
      ruleId: 'S001',
      severity: 'error',
      title: 'Без ключа',
      target: 'Amount',
      message: 'Поле без ключа',
      recommendation: 'Добавьте ключ',
    },
  });
  assert.match(text, /О чём конкретно спросили/);
  assert.match(text, /S001 \[error\]/);
  assert.match(text, /Amount/);
});

test('сводка: без находок и фокуса лишних блоков нет', () => {
  const { text } = buildSummary({ analysis: { summary: {}, findings: [] } });
  assert.doesNotMatch(text, /Конкретные находки/);
  assert.doesNotMatch(text, /О чём конкретно спросили/);
});
});

test('сводка: показывает владельца приложения', () => {
  const { text } = buildSummary({
    analysis: fakeAnalysis(),
    app: { title: 'Продажи РФ', owner: 'Иванов Иван Иванович' },
  });
  assert.match(text, /владелец: Иванов Иван Иванович/);
});
