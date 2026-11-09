/**
 * Форматирование скрипта загрузки — «красивые отступы как в линтерах».
 *
 * Что делает:
 *  - убирает хвостовые пробелы, пробелы перед запятыми и лишние пробелы
 *    между словами (вне строковых литералов);
 *  - схлопывает 3+ пустые строки в одну;
 *  - выравнивает вложенность управляющих конструкций по стеку блоков:
 *    SUB … END SUB, FOR … NEXT, DO … LOOP, многострочный IF … THEN …
 *    ELSE … END IF (ELSE/ELSEIF — на уровне открывающего IF),
 *    SWITCH … CASE … END SWITCH (CASE — под SWITCH, тело — под CASE);
 *  - базовый отступ — 4 пробела на уровень.
 *
 * Чего не делает (сознательно): не переносит длинные строки, не
 * выравнивает AS-алиасы колонкой — риск сломать смысл выше выгоды.
 */

/** Строка открывает блок (после неё глубина растёт). */
const BLOCK_START = /^(sub|for|do|switch)\b|^(if)\b.*\bthen\s*$/i;
/** Строка закрывает блок. */
const BLOCK_END = /^end\s+(sub|if|switch)\b|^next\b|^loop\b/i;
/** Ветвление внутри блока: ELSE/ELSEIF — на уровне IF. */
const BLOCK_MID = /^(else|elseif)\b/i;
/** Метка внутри SWITCH: на уровень ниже SWITCH, тело — ещё на уровень. */
const BLOCK_CASE = /^(case|when)\b/i;

/** Тип блока по открывающей строке — нужен для END SWITCH (закрывает SWITCH). */
function blockType(lower) {
  if (/^switch\b/.test(lower)) return 'switch';
  return 'block';
}

/**
 * Одна строка: чистка пробелов вне строковых литералов.
 * Кавычки Qlik: '…' и "…", экранирование — удвоение кавычки.
 */
function cleanLine(line) {
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === quote && line[i + 1] === quote) { out += line[i + 1]; i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === '\t') { out += ' '; continue; }
    if (c === ' ') {
      // Схлопывать пробелы, но не перед запятой и не в начале.
      if (out.endsWith(' ') || line[i + 1] === ',') continue;
    }
    out += c;
  }
  return out.replace(/[ \t]+$/g, '').replace(/[ \t]+,/g, ',');
}

/**
 * Форматирует скрипт загрузки.
 * @param {string} src — исходный скрипт
 * @param {{indent?: string}} [opts] — строка отступа (по умолчанию 4 пробела)
 * @returns {string}
 */
export function formatScript(src, opts = {}) {
  const indentUnit = opts.indent ?? '    ';
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  /** Стек открытых блоков: базовая глубина каждого. */
  const stack = [];
  let depth = 0;

  for (const raw of lines) {
    const line = cleanLine(raw);
    const trimmed = line.trim();

    // Пустые строки: максимум одна подряд, глубину не трогают.
    if (!trimmed) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    const lower = trimmed.toLowerCase();

    if (BLOCK_END.test(lower)) {
      // END закрывает последний блок: возврат к его базовой глубине.
      const base = stack.length ? stack.pop() : Math.max(0, depth - 1);
      depth = base;
      out.push(indentUnit.repeat(depth) + trimmed);
      continue;
    }

    if (BLOCK_MID.test(lower)) {
      // ELSE/ELSEIF — на уровне открывающего IF, глубина тела сохраняется.
      const base = stack.length ? stack[stack.length - 1] : Math.max(0, depth - 1);
      out.push(indentUnit.repeat(base) + trimmed);
      continue;
    }

    if (BLOCK_CASE.test(lower)) {
      // CASE — на уровень ниже SWITCH, тело CASE — ещё на уровень.
      const base = stack.length ? stack[stack.length - 1] : 0;
      out.push(indentUnit.repeat(base + 1) + trimmed);
      depth = base + 2;
      continue;
    }

    out.push(indentUnit.repeat(depth) + trimmed);
    if (BLOCK_START.test(lower)) {
      stack.push(depth);
      depth += 1;
    }
  }

  // Убрать пустые строки в конце.
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
