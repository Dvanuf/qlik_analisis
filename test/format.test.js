/**
 * Форматирование скрипта: отступы управляющих конструкций, чистка пробелов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatScript, formatScriptDetailed, formatRulesDoc, MAX_PROTECT_LINES } from '../src/script/format.js';

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
  // Не-LOAD текст: чистка пробелов, запятая вплотную, пустые строки схлопнуты.
  const out = formatScript('LET a = 1 ,  2 ;   \n\n\n\nLET b = 3;').split('\n');
  assert.deepEqual(out, ['LET a = 1, 2 ;', '', 'LET b = 3;']);
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
  const out = formatScript('LET a = 1 ,  2   ;', { cleanSpaces: false });
  assert.equal(out, 'LET a = 1 ,  2   ;');
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

test('formatScript: однострочный LOAD с полями — одно поле на строку, ведущие запятые', () => {
  const out = formatScript('Продажи:\nLOAD Код, Сумма, Дата FROM qvd;').split('\n');
  assert.deepEqual(out, ['Продажи:', 'LOAD', ' Код', ',Сумма', ',Дата', 'FROM qvd;']);
  // «LOAD * FROM x;» без полей не трогается.
  assert.equal(formatScript('LOAD * FROM x;'), 'LOAD * FROM x;');
});

test('formatScript: строчный комментарий не глотает остаток скрипта', () => {
  // Регрессия: «//» маскировался до конца ВСЕГО текста — после первого
  // комментария форматтер не видел ни одного оператора и сообщал
  // «нечего менять» (живой случай: скрипт Jira worklog с // перед LOAD).
  const src = [
    '// 1. Забираем сырые данные',
    'Raw:',
    'LOAD',
    '    issue_key,',
    '    parent_key;',
    '// 2. Сортируем',
    'Sorted:',
    'NoConcatenate',
    'LOAD *',
    'RESIDENT Raw',
    'ORDER BY issue_key DESC;',
  ].join('\n');
  const out = formatScript(src);
  assert.notEqual(out, src, 'скрипт с комментариями должен форматироваться');
  assert.ok(out.includes(' issue_key\n,parent_key;'), 'поля LOAD перестроены (первое — без запятой)');
  assert.ok(out.includes('// 1. Забираем сырые данные'), 'комментарий сохранён');
  assert.ok(out.includes('///$tab') === false, 'лишнего нет');
  // ///$tab остаётся в колонке 0; inline-комментарий не теряется при
  // перестроении (может уехать на свою строку с ведущей запятой — текст цел).
  const withTab = formatScript("///$tab 01_ Данные\nRaw:\nLOAD a, // хвостовой комментарий\n b\nRESIDENT S;");
  assert.ok(withTab.split('\n')[0] === '///$tab 01_ Данные', '///$tab в колонке 0');
  assert.ok(withTab.includes('// хвостовой комментарий'), 'inline-комментарий сохранён');
  assert.ok(withTab.includes(' b\nRESIDENT S;'), 'поля после комментария разбираются');
});

test('formatScript: незакрытая кавычка не слепит остаток файла (предохранитель)', () => {
  // Регрессия: строка с нечётным апострофом (опечатка) маскировалась до
  // конца файла — всё после неё не форматировалось, кнопка «Формат»
  // сообщала «менять нечего». Лимит фрагмента (MAX_PROTECT_LINES) оставляет
  // сломанный фрагмент как текст, разбор продолжается.
  const filler = Array.from({ length: MAX_PROTECT_LINES + 20 }, (_, i) => `// строка ${i}`).join('\n');
  const src = [
    'T1:',
    'LOAD a, b',
    'RESIDENT S;',
    "сломано 'здесь",           // незакрытая кавычка — дальше раньше не разбиралось
    filler,                     // хвост длиннее лимита: раньше уходил в фрагмент до конца файла
    'T2:',
    'LOAD c, d',
    'RESIDENT R;',
  ].join('\n');
  const r = formatScriptDetailed(src, {});
  assert.ok(r.warnings.some((w) => w.includes('не найден закрывающий')), 'предупреждение о незакрытой кавычке');
  assert.ok(r.script.includes('LOAD\n c\n,d\nRESIDENT R;'), 'LOAD после сломанного фрагмента отформатирован');
});
