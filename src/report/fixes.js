/**
 * Предлагаемые правки скрипта в виде «было / стало».
 *
 * Каждая правка показывается как фрагмент скрипта до и после изменения:
 * так видно, что именно добавится в конец скрипта загрузки.
 */

/** Номер последней непустой строки скрипта. */
function lastMeaningfulLine(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) return i;
  }
  return -1;
}

/**
 * Строка загрузки таблицы (для AutoNumber).
 *
 * В скрипте Qlik метка с именем таблицы стоит перед LOAD, а сам LOAD может
 * быть на следующей строке: `Customers:` / `LOAD` / `  ID` / `FROM …`.
 */
function findLoadLine(lines, table) {
  let loadIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/\bload\b/i.test(lines[i])) { loadIdx = i; break; }
  }
  if (loadIdx === -1) return -1;
  const needle = String(table ?? '').toLowerCase();
  if (!needle) return loadIdx;

  // Метка с именем таблицы — перед LOAD.
  for (let i = loadIdx - 1; i >= 0 && i >= loadIdx - 3; i -= 1) {
    if (lines[i].toLowerCase().includes(needle)) return loadIdx;
  }
  // Имя таблицы может встретиться и после LOAD (INTO, FROM).
  for (let i = loadIdx; i < Math.min(lines.length, loadIdx + 8); i += 1) {
    if (lines[i].toLowerCase().includes(needle)) return loadIdx;
  }
  return -1;
}

/**
 * @param {object[]} findings — находки с полем fix
 * @param {string} script — исходный скрипт загрузки
 * @returns {Array<{ruleId: string, title: string, kind: string, before: string,
 *   after: string, line: number|null, statement: string}>}
 */
export function buildFixes(findings, script) {
  const src = String(script ?? '');
  const lines = src ? src.split(/\r?\n/) : [];
  const tail = lastMeaningfulLine(lines);
  const out = [];

  for (const f of findings ?? []) {
    if (!f.fix) continue;
    const kind = f.fix.kind;

    if (kind === 'autoNumber') {
      const payload = typeof f.fix.payload === 'string'
        ? { field: f.fix.payload, key: `Key_${f.fix.payload}` }
        : f.fix.payload;
      const field = payload?.field;
      const key = payload?.key ?? `Key_${field}`;
      if (!field) continue;
      const statement = `AutoNumber(${/\s/.test(field) ? `[${field}]` : field}, '${key}');`;
      const at = findLoadLine(lines, payload?.table ?? f.table);
      const before = at >= 0 ? lines[at] : '';
      const after = at >= 0
        ? `${before}\n${statement}`
        : `${before ? `${before}\n` : ''}${statement}`;
      out.push({
        ruleId: f.ruleId,
        title: f.title,
        kind,
        before,
        after,
        line: at >= 0 ? at + 1 : null,
        statement,
      });
      continue;
    }

    if (kind === 'dropField' || kind === 'dropTable') {
      const name = String(f.fix.payload ?? '');
      if (!name) continue;
      const statement = kind === 'dropField'
        ? `DROP FIELD ${/\s/.test(name) ? `[${name}]` : name};`
        : `DROP TABLE ${/\s/.test(name) ? `[${name}]` : name};`;
      const before = tail >= 0 ? lines[tail] : '';
      out.push({
        ruleId: f.ruleId,
        title: f.title,
        kind,
        before,
        after: before ? `${before}\n${statement}` : statement,
        line: tail >= 0 ? tail + 1 : null,
        statement,
      });
    }
  }

  return out;
}

/**
 * Применяет правки к копии скрипта.
 * Исходное приложение не меняется — правится только текст.
 *
 * @param {string} script — исходный скрипт
 * @param {{script?: string}} patch — сводка правок
 * @returns {string} изменённый скрипт
 */
export function applyPatchToScript(script, patch) {
  const src = String(script ?? '').replace(/\s+$/, '');
  const statements = String(patch?.script ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!statements.length) return src ? `${src}\n` : '';
  const header = '// --- Правки Qlik Analyzer (применены к копии скрипта) ---';
  return `${src}\n\n${header}\n${statements.join('\n')}\n`;
}
