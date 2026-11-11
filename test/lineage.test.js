/**
 * Структура формирования приложения (lineage): узлы, рёбра, глубины,
 * статусы и предупреждения — по мотивам NodeGraph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../src/script/parse.js';
import { buildLineage, sourceKind } from '../src/script/lineage.js';

const SCRIPT = [
  'Продажи:',
  'LOAD Код, Сумма FROM [lib://Data/sales.qvd] (qvd);',
  '',
  'Tmp:',
  'LOAD Код, Sum(Сумма) as Итог Resident Продажи Group By Код;',
  '',
  'LEFT JOIN (Продажи)',
  'LOAD Код, Скидка Resident Tmp;',
  '',
  'STORE Продажи INTO [lib://Data/sales_final.qvd] (qvd);',
  'DROP Table Tmp;',
].join('\n');

test('sourceKind: типы источников', () => {
  assert.equal(sourceKind('[lib://Data/x.qvd]'), 'lib');
  assert.equal(sourceKind('[C:\\data\\x.qvd]'), 'file');
  assert.equal(sourceKind('SQL SELECT * FROM t'), 'sql');
  assert.equal(sourceKind('INLINE [a, b]'), 'inline');
});

test('buildLineage: источники, таблицы, рёбра и глубины', () => {
  const { nodes, edges, warnings } = buildLineage(parseScript(SCRIPT));
  const kinds = (k) => nodes.filter((n) => n.kind === k);
  assert.ok(kinds('source').some((n) => n.label.includes('sales.qvd')), 'источник lib://');
  assert.ok(kinds('table').some((n) => n.label === 'Продажи'), 'таблица Продажи');
  assert.ok(kinds('table').some((n) => n.label === 'Tmp'), 'таблица Tmp');
  // Источник → Продажи (source), Продажи → Tmp (resident), Tmp → Продажи (resident)
  assert.ok(edges.some((e) => e.kind === 'source' && e.to === 'tbl:продажи'));
  assert.ok(edges.some((e) => e.kind === 'resident' && e.from === 'tbl:продажи' && e.to === 'tbl:tmp'));
  // Вливание Tmp → Продажи через LEFT JOIN LOAD — ребро join (или resident).
  assert.ok(edges.some((e) => (e.kind === 'join' || e.kind === 'resident') && e.from === 'tbl:tmp' && e.to === 'tbl:продажи'));
  // STORE: ребро таблица → узел файла
  assert.ok(edges.some((e) => e.kind === 'store' && e.from === 'tbl:продажи'));
  // Глубины: источник 0, Продажи 0, Tmp 1
  const prod = nodes.find((n) => n.id === 'tbl:продажи');
  const tmp = nodes.find((n) => n.id === 'tbl:tmp');
  assert.equal(prod.depth, 0);
  assert.equal(tmp.depth, 1);
});

test('buildLineage: статусы dropped/stored и предупреждения', () => {
  const { nodes, warnings } = buildLineage(parseScript(SCRIPT));
  const tmp = nodes.find((n) => n.id === 'tbl:tmp');
  assert.equal(tmp.status, 'dropped', 'Tmp удалена');
  const prod = nodes.find((n) => n.id === 'tbl:продажи');
  assert.equal(prod.stored, true, 'Продажи выгружена STORE');
  assert.ok(warnings.some((w) => w.includes('Tmp') && w.includes('DROP')), 'предупреждение о мёртвой таблице');
});

test('buildLineage: JOIN открывает ребро join', () => {
  const { edges } = buildLineage(parseScript(SCRIPT));
  assert.ok(edges.some((e) => e.kind === 'join'));
});

test('buildLineage: цикл RESIDENT не уводит в бесконечность', () => {
  const { nodes } = buildLineage(parseScript('A:\nLOAD 1;\nB:\nLOAD * Resident A;\nA2:\nLOAD * Resident B;\n'));
  assert.ok(nodes.length > 0);
});
