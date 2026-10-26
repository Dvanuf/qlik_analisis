/**
 * Нормализация выражений Qlik Sense.
 * Задачи:
 *  - разбор выражения на токены (строки, поля, переменные, функции, операторы);
 *  - извлечение ссылок (поля / переменные / функции);
 *  - канонизация выражения — основа для поиска дублирующихся мер
 *    (аналог проверки «совпадающие меры»).
 */

/** Ключевые слова языка выражений Qlik — они не являются полями. */
export const KEYWORDS = new Set([
  'and', 'or', 'not', 'in', 'like', 'between', 'asc', 'desc',
  'mapping', 'when', 'then', 'else', 'end', 'true', 'false', 'null', 'mod', 'div',
]);

/** Убирает комментарии /* ... *\/ и // ... */
export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Токенизатор выражения.
 * Возвращает массив { type, value, raw }:
 *  type: 'string' | 'field' | 'var' | 'number' | 'ident' | 'func' | 'op' | 'punct'
 */
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src ?? '');

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) { i += 1; continue; }

    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // Строковая константа
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < s.length) {
        // В Qlik обратный слэш не экранирует ('\' — строка из одного слэша).
        // Экранирование — удвоение кавычки ('').
        if (s[j] === quote && s[j + 1] === quote) { value += quote; j += 2; continue; }
        if (s[j] === quote) { closed = true; j += 1; break; }
        value += s[j];
        j += 1;
      }
      tokens.push({ type: 'string', value, raw: s.slice(i, j), closed });
      i = j;
      continue;
    }

    // Поле в квадратных скобках: [Order Date]
    if (c === '[') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === ']') { closed = true; j += 1; break; }
        value += s[j];
        j += 1;
      }
      tokens.push({ type: 'field', value, raw: s.slice(i, j), closed });
      i = j;
      continue;
    }

    // Переменная: $var, ${var}, $(var)
    if (c === '$') {
      let j = i + 1;
      let value = '';
      let closed = true;
      if (s[j] === '{') {
        j += 1;
        while (j < s.length && s[j] !== '}') { value += s[j]; j += 1; }
        closed = j < s.length;
        j += 1;
      } else if (s[j] === '(') {
        j += 1;
        while (j < s.length && s[j] !== ')') { value += s[j]; j += 1; }
        closed = j < s.length;
        j += 1;
      } else {
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) { value += s[j]; j += 1; }
        closed = value.length > 0;
      }
      tokens.push({ type: 'var', value, raw: s.slice(i, j), closed });
      i = j;
      continue;
    }

    // Число
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.eE]/.test(s[j])) {
        if ((s[j] === 'e' || s[j] === 'E') && !/[0-9]/.test(s[j + 1] ?? '')) break;
        j += 1;
      }
      tokens.push({ type: 'number', value: s.slice(i, j), raw: s.slice(i, j) });
      i = j;
      continue;
    }

    // Идентификатор: имя поля, имя функции или ключевое слово
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
      const value = s.slice(i, j);
      let k = j;
      while (k < s.length && /\s/.test(s[k])) k += 1;
      const isFunc = s[k] === '(';
      tokens.push({ type: isFunc ? 'func' : 'ident', value, raw: value });
      i = j;
      continue;
    }

    // Операторы (двухсимвольные — первыми)
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '=='].includes(two)) {
      tokens.push({ type: 'op', value: two, raw: two });
      i += 2;
      continue;
    }

    if ('+-*/^=<>'.includes(c)) {
      tokens.push({ type: 'op', value: c, raw: c });
      i += 1;
      continue;
    }

    tokens.push({ type: 'punct', value: c, raw: c });
    i += 1;
  }

  return tokens;
}

/**
 * Извлекает ссылки из выражения.
 * @returns {{fields: string[], variables: string[], functions: string[]}}
 */
export function extractReferences(expr) {
  const tokens = tokenize(stripComments(expr));
  const fields = new Set();
  const variables = new Set();
  const functions = new Set();

  for (const tk of tokens) {
    if (tk.type === 'field') {
      if (tk.value.trim()) fields.add(tk.value.trim());
    } else if (tk.type === 'var') {
      if (tk.value.trim()) variables.add(tk.value.trim());
    } else if (tk.type === 'func') {
      functions.add(tk.value);
    } else if (tk.type === 'ident') {
      const low = tk.value.toLowerCase();
      if (!KEYWORDS.has(low)) fields.add(tk.value);
    }
  }

  return {
    fields: [...fields],
    variables: [...variables],
    functions: [...functions],
  };
}

/** Нормализует имя поля: `Unit Cost` и `[Unit Cost]` — одно и то же поле. */
export function canonicalFieldName(name) {
  return String(name).replace(/^\[|\]$/g, '').trim().toLowerCase();
}

/**
 * Каноническая форма выражения: используется для поиска дубликатов.
 *  - регистр и пробелы нормализуются;
 *  - `Unit Cost` ≡ `[Unit Cost]`;
 *  - ссылки на переменные раскрываются в их определения (опционально);
 *  - разные переменные с одинаковым определением дают одинаковую форму.
 */
export function canonicalize(expr, options = {}) {
  const { variableMap = new Map(), expandVariables = true, maxDepth = 6 } = options;
  const tokens = tokenize(stripComments(expr));
  const parts = [];

  const resolveVar = (name, depth) => {
    const key = String(name).trim();
    if (!expandVariables || depth > maxDepth) return `$${key.toLowerCase()}`;
    const def = variableMap.get(key) ?? variableMap.get(key.toLowerCase());
    if (def === undefined || def === null || def === '') return `$${key.toLowerCase()}`;
    const nested = canonicalize(def, { variableMap, expandVariables, maxDepth: depth + 1 });
    // Простой вызов функции не оборачиваем в скобки — иначе «$(vSales)» и
    // «Sum([Sales Amount])» не совпадут при сравнении эффективных формул.
    const isSimpleCall = /^[a-z_][a-z0-9_]*\(/.test(nested) && nested.endsWith(')');
    return isSimpleCall ? nested : `(${nested})`;
  };

  for (const tk of tokens) {
    switch (tk.type) {
      case 'field':
        parts.push(`[${canonicalFieldName(tk.value)}]`);
        break;
      case 'ident': {
        const low = tk.value.toLowerCase();
        parts.push(KEYWORDS.has(low) ? low : `[${canonicalFieldName(tk.value)}]`);
        break;
      }
      case 'func':
        parts.push(`${tk.value.toLowerCase()}(`);
        break;
      case 'var':
        parts.push(resolveVar(tk.value, 0));
        break;
      case 'string':
        parts.push(`"${tk.value.replace(/"/g, '\\"')}"`);
        break;
      case 'number': {
        const num = Number(tk.value);
        parts.push(Number.isFinite(num) ? String(num) : tk.value);
        break;
      }
      case 'op':
        parts.push(tk.value);
        break;
      default:
        parts.push(tk.value);
    }
  }

  return parts.join('');
}

/** Короткий стабильный хэш строки (FNV-1a, 32 бит). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Структурная проверка выражения (без обращения к движку).
 * @returns {Array<{code: string, message: string}>}
 */
export function checkStructure(expr) {
  const problems = [];
  const raw = String(expr ?? '');
  const tokens = tokenize(raw);
  const src = stripComments(raw);

  // Незакрытая строковая константа
  for (const tk of tokens) {
    if (tk.type === 'string' && !tk.closed) {
      problems.push({ code: 'UNCLOSED_STRING', message: 'Незакрытая строковая константа' });
      break;
    }
  }

  // Незакрытая квадратная скобка поля
  for (const tk of tokens) {
    if (tk.type === 'field' && !tk.closed) {
      problems.push({ code: 'UNCLOSED_BRACKET', message: 'Незакрытая квадратная скобка поля' });
      break;
    }
  }

  // Баланс круглых скобок
  let depth = 0;
  let minDepth = 0;
  for (const ch of src) {
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; minDepth = Math.min(minDepth, depth); }
  }
  if (depth !== 0) {
    problems.push({
      code: 'UNBALANCED_PAREN',
      message: `Незакрытых или лишних круглых скобок: ${depth > 0 ? depth : -depth}`,
    });
  }
  if (minDepth < 0) {
    problems.push({ code: 'EXTRA_CLOSE_PAREN', message: 'Лишняя закрывающая скобка' });
  }

  // Висящий оператор в конце выражения
  const lastMeaningful = [...tokens].reverse().find((t) => t.type !== 'punct' || t.value !== ',');
  if (lastMeaningful && (lastMeaningful.type === 'op')) {
    problems.push({ code: 'DANGLING_OPERATOR', message: `Выражение заканчивается оператором «${lastMeaningful.value}»` });
  }

  // Два оператора подряд
  const meaningful = tokens.filter((t) => t.type !== 'punct' || t.value === '(' || t.value === ')');
  for (let i = 1; i < meaningful.length; i += 1) {
    const prev = meaningful[i - 1];
    const cur = meaningful[i];
    if (prev.type === 'op' && cur.type === 'op' && !(cur.value === '-') && !(cur.value === '+')) {
      problems.push({
        code: 'DOUBLE_OPERATOR',
        message: `Два оператора подряд: «${prev.value}${cur.value}»`,
      });
      break;
    }
  }

  return problems;
}

