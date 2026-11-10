/**
 * Включаемые файлы: разбор include-строк и объединённый скрипт.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIncludeLines, includeKey, resolveIncludes } from '../src/extract/includes.js';

test('parseIncludeLines: Must_Include и Include, скобки и lib://', () => {
  const inc = parseIncludeLines([
    '///$tab GIT',
    '$(Must_Include=lib://Git_Sense/P&L.qvs);',
    '$(include=[C:\\скрипты\\common.qvs]);',
    '$(Include=..\\config\\settings.txt)',
    'EXIT SCRIPT;',
  ].join('\n'));
  assert.equal(inc.length, 3);
  assert.equal(inc[0].path, 'lib://Git_Sense/P&L.qvs');
  assert.equal(inc[0].must, true);
  assert.equal(inc[1].path, 'C:\\скрипты\\common.qvs');
  assert.equal(inc[2].must, false);
});

test('includeKey: lib:// → имя коннекции/файл, хвост файла сравним', () => {
  assert.equal(includeKey('lib://Git_Sense/P&L.qvs'), 'git_sense/p&l.qvs');
  assert.equal(includeKey('C:\\Git_Sense\\P&L.qvs'), 'p&l.qvs');
});

test('resolveIncludes: строка включения заменяется содержимым файла', () => {
  const script = '///$tab GIT\n$(Must_Include=lib://Git_Sense/P&L.qvs);\nEXIT SCRIPT;';
  const { script: merged } = resolveIncludes(script, {
    'git_sense/p&l.qvs': 'Продажи:\nLOAD * FROM qvd;\n',
  });
  assert.ok(merged.includes('Продажи:'), 'содержимое включения не подставлено');
  assert.ok(merged.includes('EXIT SCRIPT;'), 'хвост скрипта сохранён');
  assert.ok(!merged.includes('$(Must_Include'), 'строка включения осталась');
});

test('resolveIncludes: отсутствующий файл — в missing, скрипт не ломается', () => {
  const { script, missing } = resolveIncludes('$(Must_Include=lib://x/a.qvs);\nLOAD 1;', {});
  assert.equal(missing.length, 1);
  assert.ok(script.includes('$(Must_Include'));
});

test('resolveIncludes: вложенные include и защита от циклов', () => {
  const files = {
    'main.qvs': '$(include=inner.qvs);\nLOAD 1;',
    'inner.qvs': '$(include=main.qvs);\nLOAD 2;',
  };
  const { script } = resolveIncludes('$(include=main.qvs);\nLOAD 3;', files);
  assert.ok(script.includes('LOAD 2;'));
  assert.ok(script.includes('LOAD 3;'));
  // Цикл main→inner→main не уводит в бесконечность (глубина/seen).
});
