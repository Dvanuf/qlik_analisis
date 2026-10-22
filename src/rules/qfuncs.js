/** Справочник функций выражений Qlik Sense — для проверки опечаток в именах функций. */
export const QLIK_FUNCTIONS = new Set([
  // Агрегация
  'sum', 'avg', 'min', 'max', 'count', 'counta', 'countd', 'stdev', 'stdevp', 'deviation',
  'var', 'varp', 'range', 'skew', 'skewp', 'kurtosis', 'kurtosisp', 'avg', 'num', 'first',
  'last', 'firstsortedvalue', 'lastsortedvalue', 'concat', 'concatlist', 'minsortedvalue',
  // Set analysis
  'sum', 'count', 'avg', 'min', 'max', 'range', 'stdev', 'sum', 'aggr', 'aggr',
  // Условные
  'if', 'ifelse', 'alt', 'else', 'end', 'case', 'when', 'then',
  // Строковые
  'concat', 'left', 'right', 'mid', 'len', 'length', 'lower', 'upper', 'trim', 'ltrim',
  'rtrim', 'substring', 'replace', 'text', 'textbetween', 'split', 'indexof', 'find',
  'chr', 'ascii', 'format', 'money', 'number', 'date', 'time', 'timestamp', 'week',
  'weekday', 'month', 'year', 'day', 'hour', 'minute', 'second', 'now', 'today',
  'makedate', 'dateadd', 'datesub', 'addmonths', 'addyears', 'yearday', 'weekofyear',
  'islocal', 'isdate', 'istime', 'isnumeric', 'isnull', 'isempty', 'isdual', 'ismissing',
  'isorder', 'issymbol', 'iskey', 'isdim', 'ismember', 'ispartialmatch', 'isforced',
  // Математика
  'abs', 'ceil', 'ceiling', 'floor', 'round', 'exp', 'ln', 'log', 'log10', 'sqrt', 'power',
  'sign', 'mod', 'div', 'rand', 'random', 'sgn', 'pi',
  // Прочее
  'aggr', 'aggr2', 'ash', 'ascii', 'bin', 'bool', 'class', 'colormix', 'colorno',
  'contextexist', 'contextinfo', 'countlist', 'cyclic', 'datetime', 'empty', 'error',
  'eventname', 'eventdata', 'false', 'falsecount', 'fieldname', 'fieldindex', 'fill',
  'find', 'force', 'getbitmap', 'getcurrentfield', 'getfieldname', 'html', 'index',
  'interpret', 'interval', 'isempty', 'label', 'left', 'matrix', 'msql', 'ncol', 'nodify',
  'normalize', 'not', 'null', 'nullcount', 'ord', 'partialmatch', 'peek', 'pick', 'proper',
  'rgb', 'rgba', 'rgb1', 'second', 'sentence', 'set', 'sort', 'sqr', 'string', 'styl',
  'synthetickey', 'tag', 'text', 'timer', 'timestamp', 'top', 'total', 'true', 'trunc',
  'typeof', 'value', 'weight', 'year', 'class', 'bool', 'cos', 'sin', 'tan', 'pi',
]);

/** Функции, которые не следует считать неизвестными (движок расширяет набор). */
export const EXTRA_FUNCTIONS = new Set(['extension', 'ext', 'qlik', 'engine']);
