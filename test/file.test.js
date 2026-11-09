import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFromFile, decodeText } from '../src/connectors/file.js';
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

  // Правила включены явно: часть скриптовых выключена по умолчанию.
  const result = analyze(graph, { rules: { disabled: [] } });
  assert.ok(result.findings.some((f) => f.ruleId === 'S001' || f.ruleId === 'S002'));
});

test('файл не-скрипт не ломает анализ, а помечается как пропущенный', async () => {
  const file = join(tmp, 'random.txt');
  writeFileSync(file, 'это не скрипт Qlik', 'utf8');
  const graph = await extractFromFile({ file, fileType: 'script' });
  assert.equal(graph.script, '');
  assert.ok(graph.meta.skipped.length > 0);

  const result = analyze(graph, { rules: { disabled: [] } });
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

test('decodeText: cp1251, BOM и UTF-8 распознаются', () => {
  // «Дата» в Windows-1251: экспорт из QlikView читается как UTF-8 — «кракозябры».
  const cp = Buffer.from([0xC4, 0xE0, 0xF2, 0xE0]);
  assert.equal(decodeText(cp), 'Дата');
  assert.equal(decodeText(Buffer.from('Дата', 'utf8')), 'Дата');
  const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Дата', 'utf8')]);
  assert.equal(decodeText(bom), 'Дата');
  // Чистый ASCII — без изменений.
  assert.equal(decodeText(Buffer.from('LOAD *;')), 'LOAD *;');
});

test('скрипт в cp1251 анализируется без «кракозябр»', async () => {
  const file = join(tmp, 'cp1251.qvs');
  const text = 'Продажи:\nLOAD [Сумма продаж] FROM [lib://data/x.csv];\n';
  // Каждую букву перевести в cp1251 нельзя средствами Node — проверяем через
  // decodeText уже на байтах: cp1251-байты кириллической строки.
  const win1251 = Buffer.from(text.replace(/[А-Яа-яЁё]+/g, (w) => {
    // windows-1251: А-Y = C0-DF, а-я = E0-FF, Ё=A8, ё=B8.
    return [...w].map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 0x0410 && c <= 0x042F) return String.fromCharCode(0xC0 + (c - 0x0410));
      if (c >= 0x0430 && c <= 0x044F) return String.fromCharCode(0xE0 + (c - 0x0430));
      if (ch === 'Ё') return String.fromCharCode(0xA8);
      if (ch === 'ё') return String.fromCharCode(0xB8);
      return ch;
    }).join('');
  }), 'latin1');
  writeFileSync(file, win1251);
  const graph = await extractFromFile({ file, fileType: 'script' });
  assert.ok(graph.script.includes('Сумма продаж'), `имя прочитано, а не мусор: ${graph.script.slice(0, 60)}`);
});
