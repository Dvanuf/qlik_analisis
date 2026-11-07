/**
 * Единый механизм правок скрипта загрузки.
 *
 * Здесь живёт вся работа с правками: сбор из находок, вид «было / стало»
 * для интерфейса и отчётов, сборка предложенной версии скрипта и применение
 * правок к копии. Раньше эти механизмы жили раздельно (buildFixes в
 * рендерере, buildScriptPatch в ядре) и могли расходиться — теперь один
 * источник: collectEdits() нормализует находки, остальные функции строят
 * свои представления поверх него.
 *
 * Правки применяются по месту: AutoNumber вставляется после своей строки
 * LOAD, а DROP-операторы добавляются в конец — таблицы и поля к этому
 * моменту уже загружены. Исходное приложение не меняется никогда.
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
export function ident(name) {
  const value = String(name ?? '');
  return /\s/.test(value) ? `[${value}]` : value;
}

/**
 * Строка загрузки таблицы (для AutoNumber).
 *
 * В скрипте Qlik метка с именем таблицы стоит перед LOAD, а сам LOAD может
 * быть на следующей строке: `Customers:` / `LOAD` / `  ID` / `FROM …`.
 * Сначала ищется метка таблицы — иначе при нескольких таблицах вставка
 * привязывается к первому LOAD скрипта, а не к своей таблице.
 *
 * @param {string[]} lines
 * @param {string} table
 * @returns {number} индекс строки LOAD (с нуля) или -1
 */
export function findLoadLine(lines, table) {
  const needle = String(table ?? '').trim().toLowerCase();
  // Без имени таблицы место вставки не определить честно — не угадываем.
  if (!needle) return -1;

  // 1) Метка таблицы: строка с именем, заканчивающаяся на ':'.
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text.toLowerCase().includes(needle)) continue;
    if (/:\s*$/.test(text) && !/\bload\b/i.test(text)) {
      for (let k = i + 1; k <= Math.min(lines.length - 1, i + 4); k += 1) {
        if (/\bload\b/i.test(lines[k])) return k;
      }
      return -1;
    }
  }

  // 2) Без метки: имя таблицы рядом с LOAD (перед ним или в FROM/INTO после).
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\bload\b/i.test(lines[i])) continue;
    for (let k = i - 1; k >= 0 && k >= i - 3; k -= 1) {
      if (lines[k].toLowerCase().includes(needle)) return i;
    }
    for (let k = i; k < Math.min(lines.length, i + 8); k += 1) {
      if (lines[k].toLowerCase().includes(needle)) return i;
    }
  }
  return -1;
}

/**
 * Нормализованные правки из находок — единый источник для всех видов.
 *
 * Удаления полей и таблиц схлопываются по имени: несколько находок об одном
 * поле (разные правила) — одна правка. AutoNumber — одна правка на поле.
 *
 * @param {object[]} findings — находки с полем fix
 * @returns {{dropFields: Map<string, object>, dropTables: Map<string, object>,
 *   autoNumbers: Map<string, object>}}
 */
export function collectEdits(findings) {
  const dropFields = new Map();
  const dropTables = new Map();
  const autoNumbers = new Map();

  for (const f of findings ?? []) {
    if (!f?.fix) continue;
    const kind = f.fix.kind;

    if (kind === 'dropField' || kind === 'dropTable') {
      const name = String(f.fix.payload ?? '');
      if (!name) continue;
      const bucket = kind === 'dropField' ? dropFields : dropTables;
      if (!bucket.has(name)) {
        bucket.set(name, { ruleId: f.ruleId, title: f.title, kind, objects: [] });
      }
      const entry = bucket.get(name);
      const obj = String(f.target?.name ?? name);
      if (!entry.objects.includes(obj)) entry.objects.push(obj);
      continue;
    }

    if (kind === 'autoNumber') {
      const payload = typeof f.fix.payload === 'string'
        ? { field: f.fix.payload, key: `Key_${f.fix.payload}` }
        : f.fix.payload;
      const field = payload?.field;
      if (!field || autoNumbers.has(field)) continue;
      autoNumbers.set(field, {
        ruleId: f.ruleId,
        title: f.title,
        kind,
        field,
        key: payload?.key ?? `Key_${field}`,
        table: payload?.table ?? f.table ?? null,
        objects: [String(f.target?.name ?? field)],
      });
    }
  }
  return { dropFields, dropTables, autoNumbers };
}

/**
 * Вид «было / стало» для интерфейса и HTML-отчёта.
 *
 * Формат сохранён прежним (правка = оператор), чтобы не ломать отчёты:
 * DROP-операторы схлопнуты в один, AutoNumber — отдельная правка на поле.
 *
 * @param {object[]} findings
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
  const edits = collectEdits(findings);
  const out = [];

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

  pushDrop(edits.dropFields, 'DROP FIELD');
  pushDrop(edits.dropTables, 'DROP TABLE');
  for (const [, e] of edits.autoNumbers) {
    const statement = `AutoNumber(${ident(e.field)}, '${e.key}');`;
    const at = findLoadLine(lines, e.table);
    const before = at >= 0 ? lines[at] : '';
    out.push({
      ruleId: e.ruleId,
      title: e.title,
      kind: e.kind,
      before,
      after: at >= 0 ? `${before}\n${statement}` : statement,
      line: at >= 0 ? at + 1 : null,
      statement,
      objects: e.objects,
      count: 1,
    });
  }
  return out;
}

/**
 * Стабильный идентификатор правки — ключ чекбокса в интерфейсе.
 *
 * @param {{kind: string, field?: string}} change
 * @returns {string}
 */
export function changeId(change) {
  return change.field ? `${change.kind}:${change.field}` : change.kind;
}

/**
 * Строит предложенную версию скрипта: правки применяются по месту.
 *
 * AutoNumber вставляется после своей строки LOAD (вставки идут снизу вверх,
 * чтобы номера строк выше не съезжали), DROP-операторы — в конец скрипта:
 * к этому моменту все таблицы и поля уже загружены.
 *
 * @param {string} script — исходный скрипт загрузки
 * @param {object[]} findings — находки с полем fix
 * @param {{disabled?: Set<string>}} [options] — выключенные правки (changeId)
 * @returns {{script: string, changes: Array<object>, added: number[]}}
 *   предложенная версия, перечень правок (включая выключенные — интерфейс
 *   показывает их все) и номера добавленных строк (с единицы) — для подсветки
 */
export function buildRefactoredScript(script, findings, options = {}) {
  const src = String(script ?? '').replace(/\s+$/, '');
  if (!src) return { script: '', changes: [], added: [] };
  const lines = src.split(/\r?\n/);
  const edits = collectEdits(findings);
  const disabled = options.disabled ?? new Set();
  const changes = [];
  const added = [];

  // AutoNumber — по месту: после строки LOAD своей таблицы. Вставки идут
  // сверху вниз со сдвигом: каждая прошедшая вставка сдвигает позиции ниже.
  const insertions = [];
  for (const [, e] of edits.autoNumbers) {
    const statement = `AutoNumber(${ident(e.field)}, '${e.key}');`;
    // Таблица неизвестна — место вставки не определяется: правка остаётся
    // в перечне с пометкой «место не определено», в скрипт не попадает.
    const at = e.table ? findLoadLine(lines, e.table) : -1;
    const change = {
      id: changeId(e),
      kind: e.kind,
      ruleId: e.ruleId,
      title: e.title,
      field: e.field,
      statement,
      objects: e.objects,
      // Вставка «после строки N» — место в предложенной версии.
      line: at >= 0 ? at + 1 : null,
      before: at >= 0 ? lines[at] : '',
      after: at >= 0 ? `${lines[at]}\n${statement}` : statement,
    };
    changes.push(change);
    if (!disabled.has(change.id) && at >= 0) insertions.push({ at, statement });
  }
  insertions.sort((a, b) => a.at - b.at);
  let offset = 0;
  for (const ins of insertions) {
    const realAt = ins.at + 1 + offset;
    lines.splice(realAt, 0, ins.statement);
    added.push(realAt + 1);
    offset += 1;
  }

  // DROP-операторы — в конец, одним оператором на вид. Позиция вставки
  // сдвигается после каждой включённой правки: иначе второй оператор
  // оказывается выше первого.
  const tail = lastCodeLine(lines);
  let dropAt = tail + 1;
  const pushDrop = (bucket, keyword, kind) => {
    if (!bucket.size) return;
    const names = [...bucket.keys()];
    const statement = `${keyword} ${names.map(ident).join(', ')};`;
    const first = bucket.values().next().value;
    const change = {
      id: kind,
      kind,
      ruleId: first.ruleId,
      title: first.title,
      statement,
      objects: [...new Set([...bucket.values()].flatMap((e) => e.objects))],
      // Вставка после последней строки кода: «вставка после строки N».
      line: tail >= 0 ? tail + 1 : null,
      before: '',
      after: statement,
    };
    changes.push(change);
    if (!disabled.has(change.id)) {
      // Комментарии и разделители остаются ниже правок, как и были.
      lines.splice(dropAt, 0, statement);
      added.push(dropAt + 1);
      dropAt += 1;
    }
  };
  pushDrop(edits.dropFields, 'DROP FIELD', 'dropField');
  pushDrop(edits.dropTables, 'DROP TABLE', 'dropTable');

  return { script: lines.join('\n'), changes, added };
}

/**
 * Патч для отчётов (HTML/JSON): перечень правок и готовые операторы.
 *
 * Формат прежний: {dropFields, dropTables, autoNumbers, script} —
 * потребители отчётов не меняются.
 *
 * @param {object[]} findings
 * @returns {{dropFields: string[], dropTables: string[],
 *   autoNumbers: Array<{field: string, key: string}>, script: string}}
 */
export function buildScriptPatch(findings) {
  const edits = collectEdits(findings);
  const lines = [];
  if (edits.dropFields.size) {
    lines.push(`DROP FIELD ${[...edits.dropFields.keys()].map(ident).join(', ')};`);
  }
  if (edits.dropTables.size) {
    lines.push(`DROP TABLE ${[...edits.dropTables.keys()].map(ident).join(', ')};`);
  }
  if (edits.autoNumbers.size) {
    // Второй аргумент AutoNumber — имя нового поля, обязательно строковый литерал:
    // AutoNumber(ID, 'Key_QvdTableHeader');
    const pairs = [...edits.autoNumbers.values()].map((e) => `${ident(e.field)}, '${e.key}'`);
    lines.push(`AutoNumber(${pairs.join(', ')});`);
  }
  return {
    dropFields: [...edits.dropFields.keys()],
    dropTables: [...edits.dropTables.keys()],
    autoNumbers: [...edits.autoNumbers.values()].map((e) => ({ field: e.field, key: e.key })),
    script: lines.join('\n'),
  };
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
