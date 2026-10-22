import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, extractReferences, canonicalize, checkStructure, canonicalFieldName,
} from '../src/normalize.js';

test('токенайзер разбирает поле, функцию и переменную', () => {
  const tokens = tokenize('Sum([Sales Amount]) / $(vSales)');
  const types = tokens.map((t) => t.type);
  assert.ok(types.includes('func'));
  assert.ok(types.includes('field'));
  assert.ok(types.includes('var'));
});

test('токенайзер не путает комментарии с кодом', () => {
  const tokens = tokenize('Sum([A]) // это комментарий\n + 1');
  assert.equal(tokens.filter((t) => t.type === 'field').length, 1);
});

test('extractReferences находит поля, переменные и функции', () => {
  const refs = extractReferences('Sum([Sales Amount]) / $(vSales) + Year');
  assert.deepEqual(refs.fields.sort(), ['Sales Amount', 'Year']);
  assert.deepEqual(refs.variables, ['vSales']);
  assert.ok(refs.functions.includes('Sum'));
});

test('extractReferences не считает ключевые слова полями', () => {
  const refs = extractReferences('If(A > 1, 1, 0)');
  assert.deepEqual(refs.fields, ['A']);
});

test('канонизация игнорирует регистр, пробелы и скобки поля', () => {
  const a = canonicalize('SUM( Sales )');
  const b = canonicalize('sum([Sales])');
  assert.equal(a, b);
});

test('канонизация сохраняет многословные имена полей в скобках', () => {
  const a = canonicalize('SUM([Sales Amount])');
  const b = canonicalize('sum([sales amount])');
  assert.equal(a, b);
});

test('канонизация раскрывает переменные', () => {
  const vmap = new Map([['vSales', 'Sum([Sales Amount])']]);
  const withVar = canonicalize('$(vSales)', { variableMap: vmap });
  const direct = canonicalize('Sum([Sales Amount])', { variableMap: vmap });
  assert.equal(withVar, direct);
});

test('без раскрытия переменные остаются разными', () => {
  const vmap = new Map([['vSales', 'Sum([Sales Amount])']]);
  const withVar = canonicalize('$(vSales)', { variableMap: vmap, expandVariables: false });
  const direct = canonicalize('Sum([Sales Amount])', { variableMap: vmap, expandVariables: false });
  assert.notEqual(withVar, direct);
});

test('canonicalFieldName снимает квадратные скобки', () => {
  assert.equal(canonicalFieldName('[Unit Cost]'), 'unit cost');
  assert.equal(canonicalFieldName('Unit Cost'), 'unit cost');
});

test('checkStructure находит незакрытую скобку поля', () => {
  const problems = checkStructure('Sum([Sales Amount');
  assert.ok(problems.some((p) => p.code === 'UNCLOSED_BRACKET'));
});

test('checkStructure находит незакрытую строку', () => {
  const problems = checkStructure('If(A = "abc, 1, 0)');
  assert.ok(problems.some((p) => p.code === 'UNCLOSED_STRING'));
});

test('checkStructure находит висящий оператор', () => {
  const problems = checkStructure('Sum([A]) +');
  assert.ok(problems.some((p) => p.code === 'DANGLING_OPERATOR'));
});

test('checkStructure не даёт ложных срабатываний на корректном выражении', () => {
  assert.deepEqual(checkStructure('Sum([Sales Amount]) / Sum([Quantity])'), []);
});
