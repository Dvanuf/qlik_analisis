/**
 * Разбор скрипта загрузки Qlik (эвристический).
 * Даёт:
 *  - список таблиц и их полей (по операторам LOAD);
 *  - поля, упомянутые в скрипте (для правила «поле используется только в скрипте»);
 *  - операции DROP/RENAME/ALIAS/AUTONUMBER — кандидаты на рефакторинг.
 *
 * Точность: эвристическая. Для продакшн-анализа модель данных берётся
 * из движка (см. extract/engine.js), скрипт используется как дополнение.
 */

const LOAD_RE = /\bLOAD\b([\s\S]*?)\bFROM\b([^\n;]*)/gi;
const INTO_RE = /\bINTO\s+(?:TABLE\s+)?([\w. ]+)/gi;
const RESIDENT_RE = /\bRESIDENT\s+([\w. ]+)/gi;
const DROP_TABLE_RE = /\bDROP\s+TABLE\s+([\w. ]+)/gi;
const DROP_FIELD_RE = /\bDROP\s+FIELD[S]?\s+([^;]+)/gi;
const RENAME_RE = /\bRENAME\s+([\w. ]+)\s+TO\s+([\w. ]+)/gi;
const ALIAS_RE = /\bALIAS\s+([\w. ]+)\s+TO\s+([\w. ]+)/gi;
const AUTONUMBER_RE = /\bAutoNumber(?:Hash)?\s*\(?\s*([^;)]*)\)?/gi;

/** Разбирает список полей вида `a, [B c], D` в массив имён. */
function parseFieldList(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim().replace(/^\[|\]$/g, '').trim())
    .filter((s) => s.length > 0 && !/^(fmt|.*format)$/i.test(s));
}

/** Имя таблицы из пути источника: `.../sales_2024.csv` -> `sales_2024`. */
function tableNameFromPath(path) {
  const clean = String(path).trim().replace(/^'+|'+$/g, '');
  const file = clean.split(/[/\\]/).pop() ?? clean;
  return file.replace(/\.[a-z0-9]+$/i, '').replace(/^.*\.(?:csv|txt|qvd|xlsx|xls|parquet|json)$/i, '') || file;
}

/**
 * @param {string} script
 * @returns {{tables: Array<{name: string, fields: string[]}>, scriptFields: string[],
 *            operations: {drops: string[], renames: Array, aliases: Array, autonumbers: string[]}}}
 */
export function parseLoadScript(script) {
  const src = String(script ?? '');
  const tables = [];
  const scriptFields = new Set();
  const drops = [];
  const renames = [];
  const aliases = [];
  const autonumbers = [];

  let match;
  LOAD_RE.lastIndex = 0;
  while ((match = LOAD_RE.exec(src)) !== null) {
    const fields = parseFieldList(match[1]);
    const target = match[2] ?? '';
    let name = tableNameFromPath(target.split(/\s+(?:where|group by|order by|having)\b/i)[0]);
    const into = INTO_RE.exec(target);
    INTO_RE.lastIndex = 0;
    if (into) name = into[1].trim();
    fields.forEach((f) => scriptFields.add(f));
    tables.push({ name, fields });
  }

  RESIDENT_RE.lastIndex = 0;
  while ((match = RESIDENT_RE.exec(src)) !== null) scriptFields.add(match[1].trim());

  DROP_TABLE_RE.lastIndex = 0;
  while ((match = DROP_TABLE_RE.exec(src)) !== null) drops.push(match[1].trim());

  DROP_FIELD_RE.lastIndex = 0;
  while ((match = DROP_FIELD_RE.exec(src)) !== null) {
    parseFieldList(match[1]).forEach((f) => drops.push(f));
  }

  RENAME_RE.lastIndex = 0;
  while ((match = RENAME_RE.exec(src)) !== null) renames.push({ from: match[1].trim(), to: match[2].trim() });

  ALIAS_RE.lastIndex = 0;
  while ((match = ALIAS_RE.exec(src)) !== null) aliases.push({ from: match[1].trim(), to: match[2].trim() });

  AUTONUMBER_RE.lastIndex = 0;
  while ((match = AUTONUMBER_RE.exec(src)) !== null) {
    parseFieldList(match[1].replace(/\)$/, '')).forEach((f) => autonumbers.push(f));
  }

  // Поля, встречающиеся в скрипте как идентификаторы (для «используется только в скрипте»).
  const fieldLike = /\[([^\]]+)\]|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((match = fieldLike.exec(src)) !== null) {
    const name = (match[1] ?? match[2] ?? '').trim();
    if (name && !/^(LOAD|FROM|INTO|RESIDENT|JOIN|LEFT|RIGHT|INNER|OUTER|CONCATENATE|CONCAT|DROP|RENAME|ALIAS|AUTONUMBER|LET|SET|IF|ELSE|END|FOR|NEXT|WHILE|DO|EXIT|SELECT|ORDER|GROUP|BY|HAVING|WHERE|DISTINCT|NOCONCATENATE|REPLACE|INSERT|EXISTS|IN|NOT|AND|OR|MAPPING|UNION|ALL|RECORD|KEEP|LOOKUP|PEEK|COUNT|SUM|MAX|MIN|AVG|FIRST|LAST|CONCAT|TRUE|FALSE|NULL|TRACE|TIMESTAMP|AS|BINARY|OPTIMIZE|BUFFER|WARNING|INFO|TRACE)$/i.test(name)) {
      scriptFields.add(name);
    }
  }

  return {
    tables,
    scriptFields: [...scriptFields],
    operations: { drops, renames, aliases, autonumbers },
  };
}
