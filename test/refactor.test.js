/**
 * Единый механизм правок скрипта: сбор из находок, предложенная версия
 * «по месту», чекбоксы (выключение правки пересобирает скрипт),
 * детерминизм и патч для отчётов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectEdits, buildFixes, buildRefactoredScript, buildScriptPatch,
  applyPatchToScript, changeId,
} from '../src/script/refactor.js';

const SCRIPT = [
  "///$tab Данные",
  "Sales:",
  "LOAD ID, Amount, Tmp1",
  "FROM [data.qvd] (qvd);",
  "",
  "Customers:",
  "LOAD CustomerID, Name",
  "FROM [customers.qvd] (qvd);",
  "///$tab ______",
].join('\n');

const FINDINGS = [
  { ruleId: 'R001', title: 'Неиспользуемое поле', fix: { kind: 'dropField', payload: 'Tmp1' }, target: { name: 'Sales' } },
  { ruleId: 'R002', title: 'Неиспользуемая таблица', fix: { kind: 'dropTable', payload: 'Customers' }, target: { name: 'Customers' } },
  { ruleId: 'R007', title: 'AutoNumber для ключа', fix: { kind: 'autoNumber', payload: { field: 'ID', key: 'Key_ID', table: 'Sales' } }, target: { name: 'Sales' } },
];

test('сбор правок: удаления схлопываются по имени, AutoNumber — по полю', () => {
  const edits = collectEdits([
    ...FINDINGS,
    { ruleId: 'R003', title: 'Ещё раз про Tmp1', fix: { kind: 'dropField', payload: 'Tmp1' }, target: { name: 'Другая' } },
    { ruleId: 'R007', title: 'AutoNumber дубликат', fix: { kind: 'autoNumber', payload: { field: 'ID', key: 'Key_ID', table: 'Sales' } } },
  ]);
  assert.equal(edits.dropFields.size, 1);
  assert.equal(edits.dropTables.size, 1);
  assert.equal(edits.autoNumbers.size, 1);
  // Объекты обеих находок собрались в одну правку
  assert.ok(edits.dropFields.get('Tmp1').objects.includes('Другая'));
});

test('правки без поля fix игнорируются', () => {
  const edits = collectEdits([{ ruleId: 'R010', title: 'Без правки' }, null]);
  assert.equal(edits.dropFields.size, 0);
  assert.equal(edits.dropTables.size, 0);
  assert.equal(edits.autoNumbers.size, 0);
});

test('предложенная версия: AutoNumber после своей LOAD, DROP — в конец', () => {
  const { script, changes } = buildRefactoredScript(SCRIPT, FINDINGS);
  const lines = script.split('\n');
  // AutoNumber(ID, 'Key_ID') — сразу после строки LOAD таблицы Sales (строка 3)
  assert.equal(lines[3], "AutoNumber(ID, 'Key_ID');");
  // DROP-операторы — после последней строки кода; завершающий разделитель
  // ///$tab ______ остаётся ниже правок, как и был.
  const last = lines[lines.length - 1];
  assert.equal(last.trim(), '///$tab ______');
  assert.match(lines[lines.length - 2], /^DROP TABLE Customers;$/);
  assert.ok(script.includes('DROP FIELD Tmp1;'));
  assert.ok(script.includes('DROP TABLE Customers;'));
  // Разделитель ///$tab ______ не оказался выше DROP — правки после всего кода
  assert.ok(lines.indexOf('///$tab ______') > lines.indexOf('DROP TABLE Customers;'));
  // Перечень правок: AutoNumber + dropField + dropTable
  assert.deepEqual(changes.map((c) => c.id).sort(), ['autoNumber:ID', 'dropField', 'dropTable']);
});

test('предложенная версия детерминирована', () => {
  const a = buildRefactoredScript(SCRIPT, FINDINGS);
  const b = buildRefactoredScript(SCRIPT, FINDINGS);
  assert.equal(a.script, b.script);
  assert.deepEqual(a.changes, b.changes);
});

test('added: номера добавленных строк в предложенной версии', () => {
  const { script, added } = buildRefactoredScript(SCRIPT, FINDINGS);
  const lines = script.split('\n');
  assert.deepEqual(added, [4, 10, 11], 'AutoNumber после LOAD Sales, DROP-и в конце');
  for (const n of added) {
    assert.match(lines[n - 1], /^(AutoNumber\(|DROP )/);
  }
});

test('выключенная правка не попадает в предложенную версию', () => {
  const full = buildRefactoredScript(SCRIPT, FINDINGS);
  const noDrop = buildRefactoredScript(SCRIPT, FINDINGS, { disabled: new Set(['dropField']) });
  assert.ok(!noDrop.script.includes('DROP FIELD'));
  assert.ok(noDrop.script.includes('DROP TABLE'));
  // Перечень правок полон даже при выключенных — интерфейс показывает все
  assert.equal(noDrop.changes.length, full.changes.length);

  const noAuto = buildRefactoredScript(SCRIPT, FINDINGS, { disabled: new Set(['autoNumber:ID']) });
  assert.ok(!noAuto.script.includes('AutoNumber('));
});

test('вставки AutoNumber не съезжают при нескольких таблицах', () => {
  const two = [
    'A:',
    'LOAD K1 FROM a.qvd (qvd);',
    'B:',
    'LOAD K2 FROM b.qvd (qvd);',
  ].join('\n');
  const findings = [
    { ruleId: 'R007', title: 't', fix: { kind: 'autoNumber', payload: { field: 'K1', key: 'Key_K1', table: 'A' } } },
    { ruleId: 'R007', title: 't', fix: { kind: 'autoNumber', payload: { field: 'K2', key: 'Key_K2', table: 'B' } } },
  ];
  const { script } = buildRefactoredScript(two, findings);
  const lines = script.split('\n');
  assert.equal(lines[2], "AutoNumber(K1, 'Key_K1');", 'после LOAD таблицы A');
  assert.equal(lines[5], "AutoNumber(K2, 'Key_K2');", 'после LOAD таблицы B');
});

test('пустой скрипт и правки без таблицы — без падения', () => {
  assert.deepEqual(buildRefactoredScript('', FINDINGS), { script: '', changes: [], added: [] });
  const noTable = [{ ruleId: 'R007', title: 't', fix: { kind: 'autoNumber', payload: { field: 'X', key: 'Key_X', table: null } } }];
  const { script, changes } = buildRefactoredScript('LOAD X FROM q.qvd;', noTable);
  // Таблица не найдена — правка остаётся в перечне, но в скрипт не вставлена
  assert.equal(changes.length, 1);
  assert.equal(changes[0].line, null);
  assert.equal(script, 'LOAD X FROM q.qvd;');
});

test('вид «было / стало»: формат сохранён прежним', () => {
  const fixes = buildFixes(FINDINGS, SCRIPT);
  const drop = fixes.find((f) => f.kind === 'dropTable');
  assert.equal(drop.statement, 'DROP TABLE Customers;');
  assert.equal(drop.line, 8, 'последняя строка с кодом — FROM customers.qvd (строка 8)');
  assert.ok(drop.before.includes('FROM'));
  const auto = fixes.find((f) => f.kind === 'autoNumber');
  assert.equal(auto.statement, "AutoNumber(ID, 'Key_ID');");
  assert.equal(auto.line, 3, 'строка LOAD таблицы Sales');
});

test('changeId: стабильные ключи для чекбоксов', () => {
  assert.equal(changeId({ kind: 'dropField' }), 'dropField');
  assert.equal(changeId({ kind: 'autoNumber', field: 'ID' }), 'autoNumber:ID');
});

test('патч для отчётов: прежний формат {dropFields, dropTables, autoNumbers, script}', () => {
  const patch = buildScriptPatch(FINDINGS);
  assert.deepEqual(patch.dropFields, ['Tmp1']);
  assert.deepEqual(patch.dropTables, ['Customers']);
  assert.deepEqual(patch.autoNumbers, [{ field: 'ID', key: 'Key_ID' }]);
  assert.equal(patch.script, "DROP FIELD Tmp1;\nDROP TABLE Customers;\nAutoNumber(ID, 'Key_ID');");
});

test('applyPatchToScript: дописывание операторов в конец с заголовком', () => {
  const out = applyPatchToScript('LOAD 1;', { script: 'DROP FIELD X;' });
  assert.match(out, /^LOAD 1;\n\n\/\/ --- Правки Qlik Analyzer/);
  assert.ok(out.trimEnd().endsWith('DROP FIELD X;'));
  // Без правок — скрипт возвращается как был
  assert.equal(applyPatchToScript('LOAD 1;', { script: '' }), 'LOAD 1;\n');
  assert.equal(applyPatchToScript('', { script: '' }), '');
});
