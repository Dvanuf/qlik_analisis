/**
 * Разбор скрипта загрузки Qlik (Qlik Sense и QlikView — синтаксис одинаков).
 *
 * Скрипт режется на операторы по ';' вне строк и комментариев, далее каждый
 * оператор классифицируется: LOAD / RESIDENT / JOIN / CONCATENATE / INTO /
 * LET / SET / DROP / RENAME / STORE.
 */

/** Делит строку по запятой, не разрывая скобки и строки. */
function splitTopLevel(text, sep = ',') {
  const out = [];
  let depth = 0;
  let buf = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length);
}

/** Разбивает скрипт на операторы, сохраняя комментарии отдельно. */
export function splitStatements(script) {
  const src = String(script ?? '');
  const statements = [];
  const comments = [];
  let buf = '';
  let quote = null;
  let brackets = 0;
  let i = 0;

  const push = () => {
    const text = buf.trim();
    buf = '';
    if (text) statements.push({ kind: 'statement', text });
  };

  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i, i + 2);

    if (quote) {
      buf += c;
      if (c === '\\') { buf += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    // В квадратных скобках — путь (например [lib://Data/File.csv]):
    // «//» внутри пути не является комментарием.
    if (c === '[') { brackets += 1; buf += c; i += 1; continue; }
    if (c === ']') { brackets = Math.max(0, brackets - 1); buf += c; i += 1; continue; }
    if (brackets > 0) { buf += c; i += 1; continue; }
    if (rest === '//') {
      const end = src.indexOf('\n', i);
      const line = src.slice(i, end === -1 ? src.length : end);
      comments.push({ text: line.replace(/^\/\/\s?/, ''), offset: i });
      i = end === -1 ? src.length : end;
      continue;
    }
    if (rest === '/*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end === -1 ? src.length : end);
      comments.push({ text: body.replace(/^\/\*|\*\/$/g, '').trim(), offset: i });
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      // Кавычка открывает строку только если закрывающая есть дальше по тексту.
      // Иначе это просто символ (например, апостроф в комментарии или в дате).
      const close = src.indexOf(c, i + 1);
      if (close === -1) { buf += c; i += 1; continue; }
      quote = c;
      buf += c;
      i += 1;
      continue;
    }
    if (c === ';') { push(); i += 1; continue; }
    buf += c;
    i += 1;
  }
  if (buf.trim()) statements.push({ kind: 'statement', text: buf.trim() });

  return { statements, comments };
}

/** Имя файла/источника -> имя таблицы. */
export function tableNameFromSource(source) {
  const clean = String(source ?? '').trim().replace(/^'+|'+$/g, '');
  if (!clean) return '';
  const file = clean.split(/[/\\]/).pop() ?? clean;
  return file.replace(/\.[a-z0-9]+$/i, '').trim();
}

/** Убирает синтаксические обёртки поля: [Name], `Name`, Name AS Alias. */
export function stripFieldSyntax(field) {
  let f = String(field).trim();
  f = f.replace(/^\[|\]$/g, '').replace(/^`|`$/g, '').replace(/^"|"$/g, '');
  const asMatch = f.match(/\s+AS\s+(.+)$/i);
  if (asMatch) f = asMatch[1].trim().replace(/^\[|\]$/g, '');
  return f.trim();
}

/** Убирает комментарии обоих видов, сохраняя разметку строк. */
export function stripComments(src) {
  const s = String(src ?? '');
  let out = '';
  let quote = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i, i + 2);
    if (quote) {
      out += c;
      if (c === '\\') { out += s[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (rest === '//') {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (rest === '/*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      // Кавычка открывает строку, только если закрывающая есть дальше.
      const close = s.indexOf(c, i + 1);
      if (close === -1) { out += c; i += 1; continue; }
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Основной разбор скрипта.
 * @param {string} script
 * @returns {object} модель скрипта
 */
export function parseScript(script) {
  const { statements, comments } = splitStatements(script);

  const model = {
    comments,
    loads: [],
    residents: [],
    joins: [],
    concatenates: [],
    into: [],
    variables: [],
    drops: [],
    renames: [],
    stores: [],
    others: [],
    tables: [],
    hasWhereFilter: false,
    hasDropField: false,
  };

  let pendingLabel = '';
  let pendingConcatenate = null;

  // Очередь операторов: CONCATENATE(...) и следующий LOAD могут быть одним куском.
  const queue = [...statements];

  while (queue.length) {
    const st = queue.shift();
    let text = st.text;

    // Метка может стоять в начале оператора: "Customers:\nLOAD ...".
    const labelMatch = text.match(/^([A-Za-z_][A-Za-z0-9_ ]*):\s*([\s\S]+)$/);
    if (labelMatch && /^(LOAD|RESIDENT|CONCATENATE|JOIN|INTO|LET|SET|DROP|RENAME|STORE)\b/i.test(labelMatch[2].trim())) {
      pendingLabel = labelMatch[1].trim();
      text = labelMatch[2].trim();
    }

    // Метка перед LOAD: "Customers:"
    if (/^[A-Za-z_][A-Za-z0-9_ ]*:$/.test(text.trim())) {
      pendingLabel = text.trim().replace(/:$/, '').trim();
      continue;
    }

    if (/^CONCATENATE\s*\(/i.test(text)) {
      const m = text.match(/^CONCATENATE\s*\(\s*([^)]*)\)\s*([\s\S]*)$/i);
      pendingConcatenate = m ? m[1].trim() : '';
      model.concatenates.push({
        target: pendingConcatenate,
        hasNoConcatenate: /NOCONCATENATE/i.test(text),
      });
      // Хвост оператора (обычно LOAD) обрабатываем отдельно.
      const rest = (m?.[2] ?? '').trim();
      if (rest) queue.unshift({ text: rest });
      continue;
    }

    if (/^DROP\s+FIELDS?\b/i.test(text) || /^DROP\s+TABLE\b/i.test(text)) {
      model.hasDropField = true;
      const m = text.match(/^DROP\s+(FIELDS?|TABLE)\s+([^;]+)/i);
      model.drops.push({
        kind: /^TABLE/i.test(m?.[1] ?? '') ? 'table' : 'field',
        targets: splitTopLevel((m?.[2] ?? '').replace(/\([^)]*\)/g, '')),
        raw: text,
      });
      continue;
    }

    if (/^RENAME\b/i.test(text)) {
      const m = text.match(/^RENAME\s+(\S+)\s+TO\s+(\S+)/i);
      model.renames.push({ from: m?.[1], to: m?.[2], raw: text });
      continue;
    }

    if (/^STORE\b/i.test(text)) {
      const m = text.match(/^STORE\s+(\S+)/i);
      model.stores.push({ table: m?.[1], raw: text });
      continue;
    }

    if (/^(LET|SET)\s+[A-Za-z_]/i.test(text)) {
      const m = text.match(/^(LET|SET)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/i);
      model.variables.push({
        kind: (m?.[1] ?? 'LET').toUpperCase(),
        name: m?.[2] ?? '',
        value: (m?.[3] ?? '').trim(),
        raw: text,
      });
      continue;
    }

    if (/^(LEFT\s+|RIGHT\s+|INNER\s+|OUTER\s+|FULL\s+)?JOIN\b/i.test(text)) {
      const joinType = (text.match(/^(LEFT|RIGHT|INNER|OUTER|FULL)/i)?.[1] ?? 'INNER').toUpperCase();
      const afterJoin = text.replace(/^(LEFT|RIGHT|INNER|OUTER|FULL)?\s*JOIN\s*/i, '');
      const parenTable = afterJoin.match(/^\(([^)]+)\)/);
      const wordTable = afterJoin.match(/^([^\s(]+)/);
      const table = (parenTable?.[1] ?? wordTable?.[1] ?? '').replace(/["'`]/g, '');
      let tail = afterJoin.slice((parenTable?.[0] ?? wordTable?.[0] ?? '').length);

      // Предикат ON отделяем от вложенной загрузки.
      const onIdx = tail.search(/\bON\b/i);
      let source = onIdx === -1 ? tail : tail.slice(0, onIdx);
      const loadIdx = source.search(/\bLOAD\b/i);
      if (loadIdx !== -1) {
        // Вложенный LOAD (типично для LEFT JOIN (T) LOAD ... RESIDENT T)
        queue.unshift({ text: source.slice(loadIdx).trim() });
        source = source.slice(0, loadIdx);
      }
      model.joins.push({
        joinType,
        table,
        source: source.trim(),
        raw: text,
      });
      continue;
    }

    if (/^INTO\b/i.test(text)) {
      const m = text.match(/^INTO\s+(?:TABLE\s+)?([^\s]+)/i);
      model.into.push({ table: m?.[1]?.replace(/["'`]/g, '') ?? '', raw: text });
      continue;
    }

    if (/^LOAD\b/i.test(text)) {
      const residentMatch = text.match(/^LOAD\b([\s\S]*?)\bRESIDENT\s+([^\s;]+)([\s\S]*)$/i);
      if (residentMatch) {
        model.residents.push({
          table: residentMatch[2].replace(/["'`]/g, ''),
          target: pendingLabel || '',
          fields: splitTopLevel(residentMatch[1] || '').map(stripFieldSyntax),
          raw: text,
        });
        // После RESIDENT может идти JOIN с вложенной загрузкой — разбираем отдельно.
        const rest = (residentMatch[3] ?? '').trim();
        if (rest) queue.unshift({ text: rest });
        pendingLabel = '';
        continue;
      }

      const fromIdx = text.search(/\bFROM\b/i);
      const fieldPart = fromIdx === -1
        ? text.replace(/^LOAD\b/i, '')
        : text.slice(text.indexOf('LOAD') + 4, fromIdx);
      const sourcePart = fromIdx === -1 ? '' : text.slice(fromIdx + 4);
      const fields = splitTopLevel(fieldPart);
      const allFields = fields.length === 1 && /^\*$/.test(fields[0]);
      const hasWhere = /\bWHERE\b/i.test(sourcePart);
      const intoMatch = sourcePart.match(/\bINTO\s+(?:TABLE\s+)?([^\s]+)/i);
      const table = intoMatch
        ? intoMatch[1].replace(/["'`]/g, '')
        : (pendingLabel || tableNameFromSource(sourcePart.split(/\(/)[0]));

      model.loads.push({
        table,
        fields: allFields ? [] : fields.map(stripFieldSyntax),
        allFields,
        hasWhere,
        source: sourcePart.split(/\(/)[0].trim(),
        concatenated: Boolean(pendingConcatenate),
        concatenatedInto: pendingConcatenate || null,
        raw: text,
      });
      model.tables.push({ name: table, kind: allFields ? 'load-all' : 'load', fields: allFields ? [] : fields.map(stripFieldSyntax) });
      if (hasWhere) model.hasWhereFilter = true;
      pendingLabel = '';
      pendingConcatenate = null;
      continue;
    }

    model.others.push({ raw: text });
  }

  return model;
}
