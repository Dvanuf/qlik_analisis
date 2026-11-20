/**
 * Сверка скрипта с GitLab: сравнение, поиск файла, статусы.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForCompare, appFileName, findGitLabFile, compareScripts,
} from '../src/verify/gitlab-sync.js';

test('normalizeForCompare: CRLF и хвостовые переводы не влияют', () => {
  assert.equal(normalizeForCompare('A\r\nB\r\n'), normalizeForCompare('A\nB'));
});

test('appFileName: имя приложения → имя файла', () => {
  assert.equal(appFileName('Продажи'), 'продажи.qvs');
  assert.equal(appFileName('  Продажи (qs-r-01) '), 'продажи (qs-r-01).qvs');
  assert.equal(appFileName(''), '');
});

test('findGitLabFile: точное совпадение и по подкаталогу', () => {
  const index = new Map([
    ['продажи.qvs', { projectId: 1, path: 'qlik-sense/продажи.qvs' }],
    ['qlik-view/скрипт.qvs', { projectId: 2, path: 'qlik-view/скрипт.qvs' }],
  ]);
  assert.equal(findGitLabFile(index, 'Продажи')?.path, 'qlik-sense/продажи.qvs');
  assert.equal(findGitLabFile(index, 'Скрипт')?.path, 'qlik-view/скрипт.qvs');
  assert.equal(findGitLabFile(index, 'Нет такого'), null);
});

test('compareScripts: sync — совпадает, empty — пустой эталон', () => {
  assert.equal(compareScripts('LOAD a;\n', 'LOAD a;\r\n').status, 'sync');
  assert.equal(compareScripts('LOAD a;', '   \n  ').status, 'empty');
});

test('compareScripts: drift — diff с ведущими знаками и номерами строк', () => {
  const r = compareScripts('LOAD a;\nLOAD b;\nLOAD c;\n', 'LOAD a;\nLOAD x;\nLOAD c;\n');
  assert.equal(r.status, 'drift');
  assert.equal(r.diffLines, 2);
  const kinds = r.diff.map((d) => d.type).filter((t) => t !== 'ctx' && t !== 'hunk');
  assert.deepEqual(kinds, ['del', 'add']);
  assert.ok(r.diff.some((d) => d.type === 'del' && d.text === '−LOAD b;'));
  assert.ok(r.diff.some((d) => d.type === 'add' && d.text === '+LOAD x;'));
  assert.ok(r.diff.every((d) => !d.lineNo.includes('null')), 'номера строк заполнены');
});

test('compareScripts: контекст ±3 и hunk-разделители между блоками', () => {
  // Два блока изменений, разделённые ~30 одинаковыми строками: между ними
  // в diff появляется hunk-разделитель «… строки N …».
  const a = ['HEAD', ...Array.from({ length: 30 }, (_, i) => `same ${i}`), 'MID',
             ...Array.from({ length: 30 }, (_, i) => `same2 ${i}`), 'TAIL'];
  const b = a.map((l) => (l === 'MID' ? 'MID-изменено' : l === 'TAIL' ? 'TAIL-изменено' : l));
  const r = compareScripts(a.join('\n'), b.join('\n'));
  assert.equal(r.diffLines, 4, '2 del + 2 add');
  const hunks = r.diff.filter((d) => d.type === 'hunk');
  assert.ok(hunks.length >= 1, 'между блоками изменений — разделители');
  assert.ok(r.diff.some((d) => d.text === '−MID') && r.diff.some((d) => d.text === '+MID-изменено'));
});

test('compareScripts: огромный diff сворачивается в сводку', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  const r = compareScripts(a, b);
  assert.equal(r.status, 'drift');
  assert.equal(r.truncated, true);
  assert.ok(r.diffLines >= 6000, 'сводка посчитана');
});
