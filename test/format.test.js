/**
 * Форматирование скрипта: отступы управляющих конструкций, чистка пробелов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatScript, formatRulesDoc } from '../src/script/format.js';

test('formatScript: вложенность SUB/FOR/IF и обратный выход', () => {
  const src = [
    'SUB Load(Path)',
    'FOR i = 0 TO 10',
    'IF i > 2 THEN',
    'LOAD * FROM x;',
    'ELSE',
    'LOAD 1 FROM y;',
    'END IF',
    'NEXT',
    'END SUB',
  ].join('\n');
  const out = formatScript(src).split('\n');
  assert.equal(out[0], 'SUB Load(Path)');
  assert.equal(out[1], '    FOR i = 0 TO 10');
  assert.equal(out[2], '        IF i > 2 THEN');
  assert.equal(out[3], '            LOAD * FROM x;');
  assert.equal(out[4], '        ELSE');
  assert.equal(out[5], '            LOAD 1 FROM y;');
  assert.equal(out[6], '        END IF');
  assert.equal(out[7], '    NEXT');
  assert.equal(out[8], 'END SUB');
});

test('formatScript: однострочный IF ... THEN не уходит вглубь', () => {
  const out = formatScript('If a > 1 then LOAD 1;').split('\n');
  assert.deepEqual(out, ['If a > 1 then LOAD 1;']);
});

test('formatScript: чистка пробелов и пустых строк', () => {
  const out = formatScript('LOAD a ,  b ;   \n\n\n\nLOAD c;').split('\n');
  assert.deepEqual(out, ['LOAD a, b ;', '', 'LOAD c;']);
});

test('formatScript: строки в кавычках не перекошены по содержимому', () => {
  // Ключевое слово внутри строки не должно влиять на отступ.
  const out = formatScript("SET vMsg='for next end sub';\nLOAD 1;").split('\n');
  assert.deepEqual(out, ["SET vMsg='for next end sub';", 'LOAD 1;']);
});

test('formatScript: SWITCH/CASE', () => {
  const out = formatScript('SWITCH x\nCASE 1\nLOAD 1;\nEND SWITCH').split('\n');
  assert.deepEqual(out, ['SWITCH x', '    CASE 1', '        LOAD 1;', 'END SWITCH']);
});

test('formatScript: настраиваемый отступ (2 пробела)', () => {
  const out = formatScript('SUB A\nLOAD 1;\nEND SUB', { indent: 2 }).split('\n');
  assert.equal(out[1], '  LOAD 1;');
});

test('formatScript: cleanSpaces=false сохраняет пробелы', () => {
  const out = formatScript('LOAD a ,  b   ;', { cleanSpaces: false });
  assert.equal(out, 'LOAD a ,  b   ;');
});

test('formatScript: alignAs выравнивает алиасы колонкой в ряду', () => {
  const src = 'LOAD\n    Сумма as [Сумма],\n    Количество as [Кол-во],\n    Дата as [Дата]';
  const out = formatScript(src, { alignAs: true }).split('\n');
  const at = (i) => out[i].indexOf(' as ');
  assert.ok(at(1) === at(2) && at(2) === at(3), `алиасы не в колонке: ${JSON.stringify(out)}`);
  // без alignAs — не выравниваются
  const plain = formatScript(src).split('\n');
  assert.ok(plain[1].indexOf(' as ') !== plain[2].indexOf(' as '));
});

test('formatScript: extraBlocks открывают блок как конструкция', () => {
  const out = formatScript('TRACEMSG x\nLOAD 1;', { extraBlocks: ['TRACEMSG'] }).split('\n');
  assert.equal(out[1], '    LOAD 1;');
  // без extraBlocks — обычная строка
  const plain = formatScript('TRACEMSG x\nLOAD 1;').split('\n');
  assert.equal(plain[1], 'LOAD 1;');
});

test('formatRulesDoc: описание из текущих настроек', () => {
  const rules = formatRulesDoc({ indent: 2, alignAs: true, extraBlocks: ['TRACEMSG'] });
  const text = rules.join(' ');
  assert.ok(text.includes('2 пробела'));
  assert.ok(text.includes('выравниваются колонкой'));
  assert.ok(text.includes('TRACEMSG'));
  const off = formatRulesDoc({}).join(' ');
  assert.ok(off.includes('4 пробела') && off.includes('не выравниваются'));
});
