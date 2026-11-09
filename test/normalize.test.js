import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, extractReferences, canonicalize, checkStructure, canonicalFieldName,
  isScriptFragment,
} from '../src/normalize.js';
import { lineMentions } from '../src/findings/locations.js';

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

test('токенайзер распознаёт кириллические идентификаторы целиком', () => {
  // «Основание_» — один токен: без этого распадалось на пунктуацию,
  // а хвостовой «_» становился несуществующим «полем».
  const tokens = tokenize('Основание_').map((t) => ({ type: t.type, value: t.value }));
  assert.deepEqual(tokens, [{ type: 'ident', value: 'Основание_' }]);
  const refs = extractReferences('Sum([Сумма продаж]) + Основание_');
  assert.ok(refs.fields.includes('Сумма продаж'));
  assert.ok(!refs.fields.includes('_'), 'хвостовой «_» не должен стать отдельным полем');
  // Голая кириллица — не ссылка (неквотированное имя может быть только ASCII).
  assert.ok(!refs.fields.includes('Основание_'));
});

test('isScriptFragment: оператор загрузки — не выражение', () => {
  const inline = 'Переключаемые_поля_измерения:\nLoad * Inline [\nИзмерение, Сортировка\nОснование_, 1\n];';
  assert.ok(isScriptFragment(inline), 'Load * Inline [...] — скрипт-фрагмент');
  assert.ok(isScriptFragment('Данные:\nLOAD * FROM [lib://data/x.qvd] (qvd);'), 'LOAD ... FROM — скрипт-фрагмент');
  assert.ok(isScriptFragment('Таб:\nLOAD * Resident Таб2;'), 'LOAD ... Resident — скрипт-фрагмент');
  assert.ok(!isScriptFragment('Sum([Сумма продаж]) + Основание_'), 'выражение объекта — не скрипт');
  assert.ok(!isScriptFragment(''), 'пустая строка — не скрипт');
});

test('extractReferences: голая кириллица — не ссылка на поле', () => {
  // Регрессия 0.18.9: русские слова из скрипт-фрагментов в переменных
  // превращались в несуществующие «поля» («Кол», «в», «Продажи»).
  assert.deepEqual(extractReferences('Кол-во продаж').fields, [], 'Кол-во продаж');
  assert.deepEqual(extractReferences('значения в таблице').fields, [], 'текст целиком');
  assert.deepEqual(extractReferences('DROP Table Продажи;').fields, [], 'DROP Table');
  // Смешанное ASCII+кириллица имя — неквотированное, в Qlik невалидно: не ссылка.
  assert.deepEqual(extractReferences("ApplyMap('Логины', owner_id_2_линия, 'нет') as [Логин]").fields, ['Логин'], 'скобки остаются полем');
  // Чистый ASCII-идентификатор — настоящая ссылка на поле.
  assert.deepEqual(extractReferences("ApplyMap('Логины', x_id, 'нет') as [Логин]").fields, ['x_id', 'Логин'], 'ASCII-идентификатор — поле');
  assert.deepEqual(extractReferences('Sum([Количество])').fields, ['Количество'], 'кириллица в скобках — поле');
  assert.deepEqual(extractReferences('ApplyMap(Т, Ф, Д)').functions, ['ApplyMap'], 'функция ASCII');
  assert.deepEqual(extractReferences('РусскаяФункция(X)').functions, [], 'кириллическая «функция» — не функция');
});

test('isScriptFragment: операторы Drop/NullAsValue/Store — не выражения', () => {
  assert.ok(isScriptFragment('DROP Table Продажи;'), 'DROP Table');
  assert.ok(isScriptFragment('NullAsValue\n[a],\n[b];'), 'NullAsValue');
  assert.ok(isScriptFragment('STORE Таб INTO [lib://x.qvd];'), 'STORE INTO');
  assert.ok(isScriptFragment('Rename Table Таб to Таб2;'), 'Rename Table');
  assert.ok(!isScriptFragment('Sum([Количество]) as Кол'), 'выражение не оператор');
});

test('lineMentions: границы слова Unicode — без совпадений внутри слов', () => {
  // Регрессия 0.18.9: \w в JS — только ASCII, кириллические границы не
  // работали: «Кол» совпадал в «Количество», «в» — в «владельца».
  assert.ok(!lineMentions('Количество as [Кол_во]', 'Кол'), 'Кол внутри Количество');
  assert.ok(!lineMentions('[Логин_владельца_2_линия]', 'в'), 'в внутри владельца');
  assert.ok(!lineMentions('ДатаРождения as x', 'Дата'), 'Дата внутри ДатаРождения');
  assert.ok(lineMentions('[Дата] загрузка', 'Дата'), 'отдельное слово находится');
  assert.ok(!lineMentions('OrderID as x', 'ID'), 'латинские границы сохранены');
});
