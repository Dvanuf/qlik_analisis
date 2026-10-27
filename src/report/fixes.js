/**
 * Предлагаемые правки скрипта в виде «было / стало».
 *
 * Каждая правка показывается как фрагмент скрипта до и после изменения:
 * так видно, что именно добавится в конец скрипта загрузки.
 *
 * Правки одного вида собираются в один оператор (DROP FIELD a, b, c;),
 * а опорой служит последняя строка с кодом: иначе в отчёте появляются
 * одинаковые «пустые» правки на строке-разделителе `///$tab ______`.
 */

/**
 * Является ли строка текстом кода.
 *
 * Разделители `///$tab ______` и комментарии `// …` — не код: вставлять
 * правку после них бессмысленно, и в отчёте такая вставка выглядит как
 * «пустая» правка (строка-разделитель меняется, а суть не видна).
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isCodeLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return false;
  if (text.startsWith('//')) return false;
  if (text.startsWith('/*') || text.startsWith('*') || text.endsWith('*/')) return false;
  return true;
}

/**
 * Номер последней строки с кодом.
 *
 * Если в конце скрипта только комментарии или разделители, берём последнюю
 * строку именно с кодом — иначе «было» в правке выглядит бессмысленно.
 *
 * @param {string[]} lines
 * @returns {number} индекс строки (с нуля) или -1
 */
export function lastCodeLine(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isCodeLine(lines[i])) return i;
  }
  return -1;
}

/** Имя объекта в синтаксисе Qlik: с пробелами — в квадратных скобках. */
function ident(name) {
  const value = String(name ?? '');
  return /\s/.test(value) ? `[${value}]` : value;
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
 *   after: string, line: number|null, statement: string, objects: string[],
 *   count: number}>}
 */
export function buildFixes(findings, script) {
  const src = String(script ?? '');
  const lines = src ? src.split(/\r?\n/) : [];
  // Опора для вставки — последняя строка с кодом, а не последняя непустая:
  // разделитель `///$tab ______` в конце скрипта делал правку «пустой».
  const tail = lastCodeLine(lines);
  const out = [];

  // Удаляемые поля и таблицы собираем в один оператор: десяток отдельных
  // «DROP FIELD X;» в отчёте выглядит как десяток одинаковых пустых правок.
  const dropFields = new Map();
  const dropTables = new Map();
  const autoNumbers = [];

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
      const statement = `AutoNumber(${ident(field)}, '${key}');`;
      const at = findLoadLine(lines, payload?.table ?? f.table);
      const before = at >= 0 ? lines[at] : '';
      const after = at >= 0
        ? `${before}\n${statement}`
        : `${before ? `${before}\n` : ''}${statement}`;
      autoNumbers.push({
        ruleId: f.ruleId,
        title: f.title,
        kind,
        before,
        after,
        line: at >= 0 ? at + 1 : null,
        statement,
        objects: [String(f.target?.name ?? field)],
        count: 1,
      });
      continue;
    }

    if (kind === 'dropField' || kind === 'dropTable') {
      const name = String(f.fix.payload ?? '');
      if (!name) continue;
      const bucket = kind === 'dropField' ? dropFields : dropTables;
      // Несколько находок об одном поле (разные правила) — одна правка.
      if (!bucket.has(name)) {
        bucket.set(name, { ruleId: f.ruleId, title: f.title, kind, objects: [] });
      }
      const entry = bucket.get(name);
      const obj = String(f.target?.name ?? name);
      if (!entry.objects.includes(obj)) entry.objects.push(obj);
    }
  }

  /** Одна правка на оператор: DROP FIELD a, b, c; */
  const pushDrop = (bucket, keyword) => {
    if (!bucket.size) return;
    const names = [...bucket.keys()];
    const statement = `${keyword} ${names.map(ident).join(', ')};`;
    const first = bucket.values().next().value;
    const objects = [...new Set([...bucket.values()].flatMap((e) => e.objects))];
    const before = tail >= 0 ? lines[tail] : '';
    out.push({
      ruleId: first.ruleId,
      title: first.title,
      kind: first.kind,
      before,
      after: before ? `${before}\n${statement}` : statement,
      line: tail >= 0 ? tail + 1 : null,
      statement,
      objects,
      count: names.length,
    });
  };

  pushDrop(dropFields, 'DROP FIELD');
  pushDrop(dropTables, 'DROP TABLE');
  out.push(...autoNumbers);

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
