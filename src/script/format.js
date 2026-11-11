/**
 * Форматирование скрипта загрузки — «красивые отступы как в линтерах».
 *
 * Что делает (правила читает панель «Как форматируется» во вкладке
 * «Улучшенный скрипт» — см. formatRulesDoc):
 *  - убирает хвостовые пробелы, пробелы перед запятыми и лишние пробелы
 *    между словами (вне строковых литералов) — правило cleanSpaces;
 *  - схлопывает 3+ пустые строки в одну;
 *  - выравнивает вложенность управляющих конструкций по стеку блоков:
 *    SUB … END SUB, FOR … NEXT, DO … LOOP, многострочный IF … THEN …
 *    ELSE … END IF (ELSE/ELSEIF — на уровне открывающего IF),
 *    SWITCH … CASE … END SWITCH (CASE — под SWITCH, тело — под CASE);
 *  - дополнительные конструкции блоков пользователя (extraBlocks)
 *    открывают блок наравне со стандартными;
 *  - при alignAs — выравнивает `as [алиас]` колонкой внутри рядов
 *    подряд идущих строк списков полей;
 *  - базовый отступ — indentUnit (по умолчанию 4 пробела, настраивается).
 *
 * Чего не делает (сознательно): не переносит длинные строки — риск
 * сломать смысл выше выгоды.
 */

/** Строка открывает блок (после неё глубина растёт). */
const BLOCK_START = /^(sub|for|do|switch)\b|^(if)\b.*\bthen\s*$/i;
/** Строка закрывает блок. */
const BLOCK_END = /^end\s+(sub|if|switch)\b|^next\b|^loop\b/i;
/** Ветвление внутри блока: ELSE/ELSEIF — на уровне IF. */
const BLOCK_MID = /^(else|elseif)\b/i;
/** Метка внутри SWITCH: на уровень ниже SWITCH, тело — ещё на уровень. */
const BLOCK_CASE = /^(case|when)\b/i;

/**
 * Настройки форматирования (rules.json → раздел formatting).
 * @typedef {{
 *   indent?: number, cleanSpaces?: boolean, alignAs?: boolean,
 *   extraBlocks?: string[],
 * }} FormatOptions
 */

/** Строка отступа по числу пробелов (1–8, нечётные — к ближайшему чётному). */
export function indentUnitFor(indent) {
  const n = Math.min(8, Math.max(1, Number(indent) || 4));
  return ' '.repeat(n);
}

/** Регэксп открывающих строк с учётом пользовательских конструкций. */
function blockStartRegex(extraBlocks) {
  const extra = (extraBlocks ?? [])
    .map((k) => String(k ?? '').trim())
    .filter(Boolean)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const head = extra.length ? `${extra.join('|')}|` : '';
  return new RegExp(`^(${head}sub|for|do|switch)\\b|^(if)\\b.*\\bthen\\s*$`, 'i');
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
 * Выравнивание `as [алиас]` колонкой внутри рядов подряд идущих строк,
 * где алиас в конце строки (списки полей LOAD). Строки вне рядов
 * не трогаются.
 */
function alignAsLines(lines) {
  const AS = /^(.*[^\s])\s+([Aa][Ss])\s+(\[.*\]|".*"|'.*'|[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*([;,]?)$/;
  let i = 0;
  while (i < lines.length) {
    if (!AS.test(lines[i])) { i += 1; continue; }
    let j = i;
    while (j < lines.length && AS.test(lines[j])) j += 1;
    // Ряд i..j-1: ширина префикса до «as».
    const width = Math.max(...lines.slice(i, j)
      .map((l) => (AS.exec(l) || [])[1].length));
    for (let k = i; k < j; k += 1) {
      const m = AS.exec(lines[k]);
      lines[k] = `${m[1]}${' '.repeat(width - m[1].length)} ${m[2]} ${m[3]}${m[4]}`;
    }
    i = j;
  }
  return lines;
}

/**
 * Человекочитаемый перечень правил — панель «Как форматируется».
 * Описание строится из текущих настроек, чтобы не расходилось с кодом.
 *
 * @param {FormatOptions} [opts]
 * @returns {string[]} строки-правила
 */
export function formatRulesDoc(opts = {}) {
  const indent = Math.min(8, Math.max(1, Number(opts.indent) || 4));
  const extra = (opts.extraBlocks ?? []).filter(Boolean);
  return [
    `Отступ — ${indent} пробела(ов) на уровень вложенности.`,
    'Блоки: SUB…END SUB, FOR…NEXT, DO…LOOP, IF…THEN…ELSE…END IF, SWITCH…CASE…END SWITCH.',
    'ELSE/ELSEIF печатаются на уровне открывающего IF; CASE — на уровень ниже SWITCH.',
    extra.length ? `Дополнительные блоки пользователя: ${extra.join(', ')}.` : null,
    opts.cleanSpaces === false
      ? 'Пробелы не чистятся.'
      : 'Убираются хвостовые пробелы, пробелы перед запятыми, лишние пробелы между словами (вне строк).',
    'Пустые строки схлопываются: максимум одна подряд.',
    opts.alignAs
      ? 'Алиасы «as [поле]» выравниваются колонкой внутри подряд идущих строк.'
      : 'Алиасы «as [поле]» не выравниваются колонкой (alignAs выключен).',
    'Длинные строки не переносятся; содержимое строк и скобок не меняется.',
  ].filter(Boolean);
}

/**
 * Форматирует скрипт загрузки.
 * @param {string} src — исходный скрипт
 * @param {FormatOptions} [opts] — настройки (rules.json → formatting)
 * @returns {string}
 */
export function formatScript(src, opts = {}) {
  const indentUnit = indentUnitFor(opts.indent);
  const cleanSpaces = opts.cleanSpaces !== false;
  const startRe = blockStartRegex(opts.extraBlocks);
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  /** Стек открытых блоков: базовая глубина каждого. */
  const stack = [];
  let depth = 0;

  for (const raw of lines) {
    const line = cleanSpaces ? cleanLine(raw) : raw.replace(/[ \t]+$/g, '');
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
    if (startRe.test(lower)) {
      stack.push(depth);
      depth += 1;
    }
  }

  // Убрать пустые строки в конце.
  while (out.length && out[out.length - 1] === '') out.pop();
  const finalLines = opts.alignAs ? alignAsLines(out) : out;
  return finalLines.join('\n');
}
