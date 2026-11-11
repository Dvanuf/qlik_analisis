/**
 * Форматтер загрузочных скриптов Qlik Sense (QVS) — по спецификации
 * «Правила форматирования загрузочных скриптов Qlik Sense (QVS)».
 *
 * Главный принцип: не сломать рабочий скрипт важнее идеальной красоты.
 * Если разбор строки сомнителен — строка остаётся как есть, в предупреждения
 * пишется причина.
 *
 * Пайплайн:
 *  1. Маскирование защищённых фрагментов (строки, комментарии, ///$tab,
 *     $(…), {<…>}) плейсхолдерами — п. 3.
 *  2. Структурный проход: отступы по стеку блоков {type, line, depth}
 *     (п. 1–2), проверки типов END, незакрытых блоков, глубины.
 *  3. Проход операторов LOAD/SELECT: одно поле на строку, ведущие
 *     запятые, ключевые слова на уровне LOAD (п. 4–5).
 *  4. alignAs — выравнивание алиасов колонкой (п. 4.4, опция).
 *  5. Восстановление маскированных фрагментов.
 *
 * Зоны // fmt:off … // fmt:on копируются без изменений (п. 3.2).
 */

/** Максимальная глубина по умолчанию (п. 2.5). */
export const DEFAULT_MAX_DEPTH = 8;

const BLOCK_END = /^end\s+(sub|if|switch)\b|^next\b|^loop\b/i;
const BLOCK_MID = /^(else|elseif)\b/i;
const BLOCK_CASE = /^(case|default)\b/i;
/** WHEN — модификатор EXIT …, меткой блока не является (п. 1.6). */
const WHEN_RE = /^when\b/i;
/** Многострочный оператор IF: начинается с IF и содержит THEN (п. 1.8). */
const IF_OPERATOR = /^if\b.*\bthen\b/i;
/** Ключевые слова LOAD/SELECT на уровне оператора (п. 4.3). */
const LOAD_KEYWORD = /^(from|resident|where|group by|order by|join|inner join|left join|right join)\b/i;
const LOAD_KEYWORD_SPLIT = /\s+(?=(?:from|resident|where|group by|order by|join|inner join|left join|right join)\b)/i;

/** Строка отступа по числу пробелов (1–8). */
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
 * Маскирование защищённых фрагментов (п. 3.1): строки '…'/"…",
 * комментарии // и /* *\/, REM … ;, $(…), $(=…), set analysis {<…>}.
 * Возвращает { text, fragments } — плейсхолдеры \u0001N\u0001.
 */
function maskProtected(text) {
  const fragments = [];
  let out = '';
  let i = 0;
  const push = (frag) => { fragments.push(frag); return `\u0001${fragments.length - 1}\u0001`; };
  const n = text.length;
  while (i < n) {
    const rest2 = text.slice(i, i + 2);
    if (rest2 === '//') { out += push(text.slice(i)); break; }
    if (rest2 === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += push(text.slice(i, stop));
      i = stop;
      continue;
    }
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === c && text[j + 1] === c) { j += 2; continue; }
        if (text[j] === c) { j += 1; break; }
        j += 1;
      }
      out += push(text.slice(i, j));
      i = j;
      continue;
    }
    if (/^rem\b/i.test(text.slice(i, i + 4))) {
      const end = text.indexOf(';', i);
      const stop = end === -1 ? n : end + 1;
      out += push(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (rest2 === '$(') {
      let depth = 0;
      let j = i + 1;
      for (; j < n; j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
      out += push(text.slice(i, j));
      i = j;
      continue;
    }
    if (text.slice(i, i + 2) === '{<') {
      const end = text.indexOf('}>', i);
      const stop = end === -1 ? n : end + 2;
      out += push(text.slice(i, stop));
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return { text: out, fragments };
}

/** Возвращает маскированные фрагменты на место. */
function unmask(text, fragments) {
  return String(text ?? '').replace(/\u0001(\d+)\u0001/g, (_, idx) => fragments[Number(idx)] ?? '');
}

/**
 * Человекочитаемый перечень правил — панель «Как форматируется».
 * Строится из текущих настроек, чтобы не расходиться с кодом.
 *
 * @param {object} [opts] — настройки форматирования
 * @returns {string[]} строки-правила
 */
export function formatRulesDoc(opts = {}) {
  const indent = Math.min(8, Math.max(1, Number(opts.indent) || 4));
  const maxDepth = Math.max(2, Number(opts.maxDepth) || DEFAULT_MAX_DEPTH);
  const extra = (opts.extraBlocks ?? []).filter(Boolean);
  const comma = opts.commaStyle === 'trailing' ? 'в конце строки, после поля' : 'в начале строки, перед полем';
  return [
    `Отступ — ${indent} пробела(ов) на уровень; табы заменяются пробелами.`,
    'Открывают блок: SUB, FOR, DO, SWITCH, многострочный IF … THEN.',
    'Закрывают: END SUB / END IF / END SWITCH, NEXT, LOOP.',
    'ELSE/ELSEIF — на уровне открывающей; CASE и DEFAULT внутри SWITCH — +1.',
    'WHEN — модификатор EXIT …, отступ не даёт.',
    'Однострочные конструкции — по итоговому балансу строки; If(…) как функция блок не открывает.',
    `Глубина больше ${maxDepth} — предупреждение; END не того типа и незакрытые блоки — предупреждения.`,
    'Строки, комментарии, ///$tab, $(…), {<…>} не трогаются; зоны // fmt:off / fmt:on — без изменений.',
    extra.length ? `Дополнительные блоки пользователя: ${extra.join(', ')}.` : null,
    'Многострочные LOAD/SELECT: одно поле на строку, продолжение +1, FROM/RESIDENT/WHERE/GROUP BY/ORDER BY — на уровне LOAD.',
    `Запятые в списке полей: ${comma} (commaStyle), вплотную к полю.`,
    opts.alignAs ? 'Алиасы «as [поле]» выравниваются колонкой.' : 'Алиасы «as [поле]» не выравниваются (alignAs выключен).',
    'Не уверен в разборе строки — строка остаётся как есть, добавляется предупреждение.',
  ];
}

/**
 * Форматирование с предупреждениями.
 * @param {string} src
 * @param {object} [opts] — indent, cleanSpaces, alignAs, extraBlocks,
 *   commaStyle ('leading'|'trailing'), maxDepth, oneFieldPerLine
 * @returns {{ script: string, warnings: string[] }}
 */
export function formatScriptDetailed(src, opts = {}) {
  const warnings = [];
  const indentUnit = indentUnitFor(opts.indent);
  const maxDepth = Math.max(2, Number(opts.maxDepth) || DEFAULT_MAX_DEPTH);
  const cleanSpaces = opts.cleanSpaces !== false;
  const startRe = blockStartRegex(opts.extraBlocks);

  const masked = maskProtected(String(src ?? '').replace(/\r\n?/g, '\n'));
  const rawLines = masked.text.split('\n');
  const fragments = masked.fragments;

  const strip = (line) => (cleanSpaces
    ? line.replace(/[ \t]+/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '').replace(/[ \t]+,/g, ',')
    : line.replace(/[ \t]+$/g, ''));

  const stack = []; // { type, line, depth } — п. 2.1
  let depth = 0;
  let fmtOff = false;
  const out = [];

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const raw = rawLines[idx];
    const lineNo = idx + 1;
    const plain = unmask(raw, fragments);
    // ///$tab — всегда в колонке 0 (п. 3.1).
    if (/^\s*\/\/\/\$tab/i.test(plain)) { out.push(plain.replace(/^\s+/, '')); continue; }

    // fmt:off / fmt:on (п. 3.2).
    if (/\/\/\s*fmt:off/i.test(plain)) { fmtOff = true; out.push(raw.trimEnd()); continue; }
    if (/\/\/\s*fmt:on/i.test(plain)) { fmtOff = false; out.push(raw.trimEnd()); continue; }
    if (fmtOff) { out.push(raw.trimEnd()); continue; }

    const line = strip(raw);
    const trimmed = line.trim();
    if (!trimmed) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    const maskedLower = trimmed.toLowerCase();
    const lower = unmask(trimmed, fragments).toLowerCase();

    // WHEN — модификатор, отступ не даёт (п. 1.6).
    if (WHEN_RE.test(lower)) { out.push(indentUnit.repeat(depth) + trimmed); continue; }

    if (BLOCK_END.test(lower)) {
      // П. 2.3: END не того типа — предупреждение, блок закрывается.
      const top = stack[stack.length - 1];
      const kind = /\bend\s+sub\b/i.test(lower) ? 'sub'
        : /\bend\s+if\b/i.test(lower) ? 'if'
        : /\bend\s+switch\b/i.test(lower) ? 'switch'
        : /\bnext\b/i.test(lower) ? 'for' : 'do';
      if (top && top.type !== kind && top.type !== 'user') {
        warnings.push(`Строка ${lineNo}: «${trimmed}» — ожидался END ${top.type.toUpperCase()} (открыт на строке ${top.line})`);
      }
      const closed = top ? stack.pop() : null;
      depth = closed ? closed.depth : Math.max(0, depth - 1);
      out.push(indentUnit.repeat(depth) + trimmed);
      continue;
    }

    if (BLOCK_CASE.test(lower)) {
      // CASE/DEFAULT внутри SWITCH — +1 (п. 1.5), тело CASE — ещё +1.
      const top = stack[stack.length - 1];
      const base = top && top.type === 'switch' ? top.depth : Math.max(0, depth - 1);
      out.push(indentUnit.repeat(base + 1) + trimmed);
      depth = top && top.type === 'switch' ? base + 2 : base + 1;
      continue;
    }

    if (BLOCK_MID.test(lower)) {
      // ELSE/ELSEIF — на уровне открывающего IF (п. 1.4).
      const base = stack.length ? stack[stack.length - 1].depth : Math.max(0, depth - 1);
      out.push(indentUnit.repeat(base) + trimmed);
      continue;
    }

    out.push(indentUnit.repeat(depth) + trimmed);

    // Открывающие: IF — только оператор с THEN (п. 1.8); If( — функция.
    if (startRe.test(maskedLower) || (/^if\b/i.test(lower) && IF_OPERATOR.test(lower))) {
      const type = /^switch\b/i.test(lower) ? 'switch'
        : /^sub\b/i.test(lower) ? 'sub'
        : /^for\b/i.test(lower) ? 'for'
        : /^do\b/i.test(lower) ? 'do' : 'if';
      stack.push({ type, line: lineNo, depth });
      depth += 1;
      if (depth > maxDepth) {
        warnings.push(`Строка ${lineNo}: глубина вложенности ${depth} больше ${maxDepth} (п. 2.5)`);
      }
    }
  }

  // П. 2.4: незакрытые блоки в конце файла.
  for (const b of stack) {
    warnings.push(`Строка ${b.line}: ${b.type.toUpperCase()} не закрыт`);
  }

  // П. 4–5: многострочные LOAD/SELECT.
  let lines = out;
  if (opts.oneFieldPerLine !== false) {
    lines = reformatLoadStatements(lines, {
      commaStyle: opts.commaStyle === 'trailing' ? 'trailing' : 'leading',
      warnings,
    });
  }

  if (opts.alignAs) alignAsLines(lines);

  return { script: unmask(lines.join('\n'), fragments), warnings };
}

/** Удобная обёртка: только текст (совместимость со старым вызовом). */
export function formatScript(src, opts = {}) {
  return formatScriptDetailed(src, opts).script;
}

/**
 * Многострочные LOAD/SELECT: одно поле на строку, ведущие запятые,
 * ключевые слова — на уровне оператора, «;» в конце (п. 4–5).
 * Однострочные операторы не трогаются.
 */
function reformatLoadStatements(lines, { commaStyle, warnings }) {
  const out = [];
  let i = 0;
  const endsStatement = (line) => /;\s*$/.test(line.trim());
  const startsStatement = (line) => /^(load|select)\b/i.test(line.trim());

  while (i < lines.length) {
    const line = lines[i];
    if (!startsStatement(line)) { out.push(line); i += 1; continue; }
    const base = line.length - line.trimStart().length;
    const indent = line.slice(0, base);
    let j = i;
    const body = [];
    while (j < lines.length && j - i <= 200) {
      body.push(lines[j].trim());
      if (endsStatement(lines[j])) break;
      j += 1;
    }
    const text = body.join(' ');
    // Однострочный оператор разбираем, только если в нём есть поля
    // (хотя бы одна запятая): «LOAD * FROM x;» остаётся как есть.
    const single = body.length === 1 && !/^\s*(?:load|select)\b[^,]*,/i.test(text);
    if (single) {
      for (let k = i; k <= j; k += 1) out.push(lines[k]);
      i = j + 1;
      continue;
    }
    const kwMatch = LOAD_KEYWORD_SPLIT.exec(text);
    let head = text;
    let tailParts = [];
    if (kwMatch) {
      head = text.slice(0, kwMatch.index).trim();
      tailParts = text.slice(kwMatch.index).trim().split(LOAD_KEYWORD_SPLIT).filter(Boolean);
    }
    const fieldsPart = head.replace(/^(load|select)\b/i, '').trim().replace(/[;,]+$/, '');
    const fields = fieldsPart ? fieldsPart.split(',') : [];
    out.push(`${indent}LOAD`);
    fields.forEach((f, k) => {
      const field = f.trim();
      if (!field) return;
      const first = k === 0;
      if (commaStyle === 'leading') {
        out.push(`${first ? `${indent} ` : `${indent},`}${field}`);
      } else {
        out.push(`${indent} ${field}${k < fields.length - 1 ? ',' : ''}`);
      }
    });
    for (const part of tailParts) out.push(`${indent}${part.trim()}`);
    const lastIdx = out.length - 1;
    if (!/;\s*$/.test(out[lastIdx])) out[lastIdx] = `${out[lastIdx]};`;
    if (!tailParts.length) {
      warnings.push(`Строки ${i + 1}–${j + 1}: в LOAD нет FROM/RESIDENT — проверьте оператор`);
    }
    i = j + 1;
  }
  return out;
}

/**
 * Выравнивание `as [алиас]` колонкой внутри рядов подряд идущих строк
 * (п. 4.4). Строки вне рядов не трогаются.
 */
function alignAsLines(lines) {
  const AS = /^(.*[^\s])\s+([Aa][Ss])\s+(\[.*\]|".*"|'.*'|[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*([;,]?)$/;
  let i = 0;
  while (i < lines.length) {
    if (!AS.test(lines[i])) { i += 1; continue; }
    let j = i;
    while (j < lines.length && AS.test(lines[j])) j += 1;
    const width = Math.max(...lines.slice(i, j).map((l) => (AS.exec(l) || [])[1].length));
    for (let k = i; k < j; k += 1) {
      const m = AS.exec(lines[k]);
      lines[k] = `${m[1]}${' '.repeat(width - m[1].length)} ${m[2]} ${m[3]}${m[4]}`;
    }
    i = j;
  }
  return lines;
}
