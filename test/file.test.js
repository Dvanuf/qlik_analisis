import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFromFile } from '../src/connectors/file.js';
import { analyze } from '../src/analyzer.js';

const tmp = mkdtempSync(join(tmpdir(), 'qlik-analyzer-'));

const SCRIPT = `
// Загрузка клиентов
Customers:
LOAD
    CustomerID,
    FirstName
FROM [lib://Data/Customers.csv]
(txt, delimiter is ',');
`;

test('текстовый скрипт читается и разбирается', async () => {
  const file = join(tmp, 'script.qvs');
  writeFileSync(file, SCRIPT, 'utf8');
  const graph = await extractFromFile({ file, fileType: 'script' });
  assert.ok(graph.script.includes('Customers'));
  assert.equal(graph.meta.source, 'file:script');

  const result = analyze(graph, {});
  assert.ok(result.findings.some((f) => f.ruleId === 'S001' || f.ruleId === 'S002'));
});

test('файл не-скрипт не ломает анализ, а помечается как пропущенный', async () => {
  const file = join(tmp, 'random.txt');
  writeFileSync(file, 'это не скрипт Qlik', 'utf8');
  const graph = await extractFromFile({ file, fileType: 'script' });
  assert.equal(graph.script, '');
  assert.ok(graph.meta.skipped.length > 0);

  const result = analyze(graph, {});
  assert.equal(result.findings.filter((f) => f.category === 'Script').length, 0);
  assert.deepEqual(result.errors, []);
});

test('документ .qvw обрабатывается корректно с объяснением', async () => {
  const file = join(tmp, 'doc.qvw');
  writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), 'utf8');
  const graph = await extractFromFile({ file, fileType: 'qvw' });
  assert.equal(graph.script, '');
  assert.ok(graph.meta.skipped[0].reason.includes('.qvw'));
});

test('бинарный .qvs без скрипта не роняет анализ', async () => {
  const file = join(tmp, 'app.qvs');
  writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'utf8');
  const graph = await extractFromFile({ file, fileType: 'qvs' });
  assert.equal(graph.script, '');
  assert.ok(graph.meta.skipped.length > 0);
});

test('отсутствующий файл даёт понятную ошибку', async () => {
  await assert.rejects(
    () => extractFromFile({ file: join(tmp, 'нет-такого.qvs'), fileType: 'script' }),
    /не найден/,
  );
});
