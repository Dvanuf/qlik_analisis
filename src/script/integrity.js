/**
 * Проверка целостности скрипта загрузки.
 *
 * Нужна по двум причинам:
 *  1) ложные срабатывания S010 — в Qlik кавычка внутри строки удваивается
 *     ('O''Brien'), и наивный разбор считал такую строку незакрытой;
 *  2) обрезанный скрипт — часть API отдаёт текст не полностью, и тогда
 *     «незакрытая строка» означает не дефект скрипта, а дефект чтения.
 */
import { stripComments } from './parse.js';

/**
 * Ищет закрывающую кавычку строки.
 *
 * В Qlik обратный слэш НЕ экранирует символы: `'\'` — это строка из одного
 * обратного слэша. Экранирование в Qlik другое — удвоение кавычки ('O''Brien').
 * Раньше сканер считал `\'` экранированной кавычкой, из-за чего в скриптах
 * вида `LET p = a & '\' & b;` строка не закрывалась и появлялось ложное
 * сообщение о незакрытой строке.
 *
 * @param {string} src — текст скрипта
 * @param {number} start — индекс открывающей кавычки
 * @param {string} quote — символ кавычки
 * @returns {number} индекс закрывающей кавычки или -1
 */
export function scanString(src, start, quote) {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === quote) {
      // Удвоенная кавычка — экранированный символ внутри строки.
      if (src[i + 1] === quote) { i += 2; continue; }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Структурная проверка скрипта: незакрытые строки и скобки.
 *
 * @param {string} script
 * @returns {{problems: Array<{code: string, message: string, line: number}>}}
 */
export function checkScriptStructure(script) {
  const problems = [];
  // Комментарии убираем: апостроф в комментарии («Don't») не должен считаться строкой.
  const src = stripComments(String(script ?? ''));
  let depth = 0;
  let line = 1;
  let brackets = 0;
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }

    if (c === '"' || c === "'") {
      const startLine = line;
      const end = scanString(src, i, c);
      if (end === -1) {
        problems.push({
          code: 'UNCLOSED_STRING',
          message: `Незакрытая строковая константа (строка ${startLine})`,
          line: startLine,
        });
        // Дальше разбирать бессмысленно: текст внутри «строки» — не код.
        break;
      }
      for (let k = i; k < end; k += 1) if (src[k] === '\n') line += 1;
      i = end + 1;
      continue;
    }

    if (c === '[') { brackets += 1; i += 1; continue; }
    if (c === ']') { brackets = Math.max(0, brackets - 1); i += 1; continue; }
    if (brackets > 0) { i += 1; continue; } // внутри пути ([lib://…]) скобки не считаем
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    i += 1;
  }

  if (depth > 0) problems.push({ code: 'UNCLOSED_PAREN', message: `Незакрытых круглых скобок: ${depth}`, line: line });
  if (depth < 0) problems.push({ code: 'EXTRA_PAREN', message: 'Лишняя закрывающая скобка', line: line });
  return { problems };
}

/**
 * Сводка по целостности скрипта: длина, строки, признаки обрезания.
 *
 * @param {string} script
 * @returns {{
 *   length: number, lines: number, endsWithSemicolon: boolean,
 *   truncated: boolean, maybeTruncated: boolean, problems: object[],
 * }}
 */
export function analyzeScriptIntegrity(script) {
  const src = String(script ?? '');
  const trimmed = src.trim();
  const { problems } = checkScriptStructure(src);
  const endsWithSemicolon = /;\s*$/.test(trimmed);
  const endsWithComment = /(\/\/[^\n]*|\*\/[^\n]*)$/.test(trimmed);
  // Незакрытая строка в конце — почти наверняка оборванный скрипт.
  const unterminated = problems.some((p) => p.code === 'UNCLOSED_STRING');
  return {
    length: src.length,
    lines: src ? src.split(/\r?\n/).length : 0,
    endsWithSemicolon,
    // Скрипт не закрыт последним оператором — возможно, прочитан не полностью.
    maybeTruncated: Boolean(trimmed) && !endsWithSemicolon && !endsWithComment,
    truncated: unterminated,
    problems,
  };
}
