/**
 * Подсветка скрипта в стилистике редактора загрузки Qlik Sense:
 * ключевые слова и функции — синие, поля — красные, комментарии — зелёные,
 * строковые литералы — янтарные, фон светлый. Без HTML-инъекций: строка
 * разбирается на токены и рендерится React-элементами.
 *
 * Точность сознательно pragmatic: полный парсер Qlik здесь не нужен —
 * важно, чтобы скрипт читался так же легко, как в Sense.
 */

export type TokenKind = 'kw' | 'field' | 'comment' | 'str' | 'plain';
export type Token = { t: string; k: TokenKind };

/** Операторы и служебные слова Qlik — синие. */
const KEYWORDS = new Set([
  'ADD', 'ALIAS', 'AND', 'AS', 'ASC', 'AUTOGENERATE', 'BEFORE', 'BINARY', 'BREAK', 'BUFFER',
  'BUNDLE', 'CALL', 'CASE', 'CONNECT', 'CROSSTABLE', 'CUSTOM', 'DECLARE', 'DERIVE', 'DESC',
  'DIMENSION', 'DISTINCT', 'DO', 'DROP', 'ELSE', 'ELSEIF', 'END', 'ENDIF', 'ENDSUB', 'EXIT',
  'EXPAND', 'EXTERNAL', 'FIRST', 'FOR', 'FROM', 'GENERIC', 'GROUP', 'HIERARCHY', 'IF',
  'INFO', 'INLINETABLE', 'INPUTFIELD', 'INTERVALMATCH', 'INTO', 'IS', 'JOIN', 'KEEP', 'LET',
  'LIB', 'LOAD', 'LOCATE', 'LOOP', 'MAP', 'MAPPING', 'MEASURE', 'NEXT', 'NOCONCATENATE',
  'NOT', 'ODBC', 'OLEDB', 'ON', 'OR', 'ORDER', 'OUTER', 'PARTIALLY', 'PREFIX', 'PREVIOUS',
  'QUALIFY', 'RECORDS', 'RELEASED', 'REMOVE', 'RENAME', 'REPLACE', 'RESIDENT', 'SELECT',
  'SEMICOLON', 'SET', 'SLEEP', 'SQL', 'SQLSELECT', 'STOP', 'STORE', 'SUB', 'THEN', 'TO',
  'TRACE', 'UNQUALIFY', 'UNTIL', 'USING', 'WHEN', 'WHERE', 'WHILE', 'WITH',
]);

/** Функции — тоже синие, как в редакторе Sense. */
const FUNCTIONS = new Set([
  'ABS', 'ACOS', 'APPLYMAP', 'ASIN', 'ATAN', 'AUTONUMBER', 'AUTONUMBER128', 'AUTONUMBERHASH',
  'CEIL', 'CHRR', 'CLASS', 'CONCAT', 'COS', 'COUNT', 'DATE', 'DATE#', 'DAY', 'DAYNAME',
  'DAYNUMBEROFYEAR', 'DIV', 'EXP', 'FABS', 'FIELDINDEX', 'FIELDVALUE', 'FLOOR', 'FRAC',
  'HASH128', 'HASH256', 'HOUR', 'IF', 'IN', 'INDEX', 'INTERVAL', 'ITERNUM', 'KEEPCHAR',
  'LEFT', 'LEN', 'LOG', 'LOG10', 'LOWER', 'LTRIM', 'MATCH', 'MAX', 'MAXSTRING', 'MID',
  'MIN', 'MINSTRING', 'MINUTE', 'MIXMATCH', 'MOD', 'MONTH', 'MONTHEND', 'MONTHNAME',
  'MONTHSTART', 'NOW', 'NULL', 'NUM', 'NUM#', 'ONLY', 'ORD', 'PICK', 'PI', 'POW', 'PURGECHAR',
  'QVDCREATETIME', 'QVDFILESIZE', 'QVDNAME', 'RAND', 'RANGEAVG', 'RANGECOUNT', 'REPEAT',
  'REPLACE', 'RIGHT', 'ROUND', 'ROWNO', 'RTRIM', 'SECOND', 'SIGN', 'SIN', 'SQRT', 'SUBFIELD',
  'SUBSTRINGCOUNT', 'SUM', 'TAN', 'TEXT', 'TEXTBETWEEN', 'TIMESTAMP', 'TIMESTAMP#', 'TIMEZONE',
  'TODAY', 'TRIM', 'UPPER', 'UTC', 'WEEK', 'WEEKDAY', 'WEEKEND', 'WEEKNAME', 'WEEKSTART',
  'WILDMATCH', 'YEAR', 'YEAREND', 'YEARTODATE',
]);

const WORD_RE = /[A-Za-z_][\w.#]*/y;
const BRACKET_RE = /\[[^\]]*\]/y;
const STRING_RE = /'(?:[^']|'')*'?/y;

/**
 * Разбирает одну строку скрипта.
 * @param line — текст строки
 * @param inLoad — находимся ли внутри списка полей LOAD (до FROM/RESIDENT)
 * @returns токены строки и новое состояние списка полей
 */
export function highlightScriptLine(line: string, inLoad: boolean): { parts: Token[]; inLoad: boolean } {
  const parts: Token[] = [];
  let i = 0;
  let load = inLoad;

  // Комментарий: // до конца строки (учитываем кавычки — // внутри строки не комментарий).
  const quoteRuns = (idx: number) => {
    let q = false;
    for (let k = 0; k < idx; k += 1) if (line[k] === "'") q = !q;
    return q;
  };
  const commentIdx = (() => {
    for (let k = 0; k < line.length - 1; k += 1) {
      if (line[k] === '/' && line[k + 1] === '/' && !quoteRuns(k)) return k;
    }
    return -1;
  })();
  const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const comment = commentIdx >= 0 ? line.slice(commentIdx) : '';

  const push = (t: string, k: TokenKind) => { if (t) parts.push({ t, k }); };

  while (i < code.length) {
    const rest = code.slice(i);
    // Строковый литерал — янтарный.
    if (rest[0] === "'") {
      STRING_RE.lastIndex = 0;
      const m = STRING_RE.exec(rest);
      push(m ? m[0] : rest[0], 'str');
      i += m ? m[0].length : 1;
      continue;
    }
    // [Поле в скобках] — красное.
    if (rest[0] === '[') {
      BRACKET_RE.lastIndex = 0;
      const m = BRACKET_RE.exec(rest);
      push(m ? m[0] : rest[0], 'field');
      i += m ? m[0].length : 1;
      continue;
    }
    // Слово: ключевое слово/функция — синее; в списке полей LOAD — красное.
    WORD_RE.lastIndex = 0;
    const wm = WORD_RE.exec(rest);
    if (wm && wm.index === 0) {
      const word = wm[0];
      const upper = word.toUpperCase();
      if (upper === 'LOAD' || upper === 'SELECT') { push(word, 'kw'); load = true; i += word.length; continue; }
      if (upper === 'FROM' || upper === 'RESIDENT' || upper === 'AUTOGENERATE' || upper === 'WHERE') { push(word, 'kw'); load = false; i += word.length; continue; }
      if (KEYWORDS.has(upper) || FUNCTIONS.has(upper)) { push(word, 'kw'); i += word.length; continue; }
      if (load) { push(word, 'field'); i += word.length; continue; }
      push(word, 'plain');
      i += word.length;
      continue;
    }
    // Прочее — по символу.
    push(rest[0], 'plain');
    i += 1;
  }
  if (comment) push(comment, 'comment');
  return { parts, inLoad: load };
}

/**
 * Разбирает весь скрипт: массив токенов на строку.
 * @param script — полный текст скрипта
 */
export function highlightScript(script: string): Token[][] {
  const lines = String(script ?? '').split(/\r?\n/);
  const out: Token[][] = [];
  let inLoad = false;
  for (const line of lines) {
    const r = highlightScriptLine(line, inLoad);
    out.push(r.parts);
    inLoad = r.inLoad;
  }
  return out;
}
