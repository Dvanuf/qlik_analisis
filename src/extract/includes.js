/**
 * Включаемые файлы скрипта ($(include=…) и $(Must_Include=…)).
 *
 * Скрипты приложений часто — заглушки из нескольких строк, вся логика
 * живёт в подключаемых .qvs (репозиторий Git). Сервер отдаёт главный
 * скрипт без раскрытия включений, поэтому правила по такому тексту
 * почти ничего не видят. Модуль находит include-строки и собирает
 * объединённый скрипт: строка включения заменяется содержимым файла.
 *
 * Путь include может быть:
 *   $(Must_Include=lib://Git_Sense/P&L.qvs);
 *   $(include=[C:\скрипты\common.qvs]);
 *   $(Include=..\config\settings.txt)
 * Ключ сопоставления с подложенными файлами — нормализованный хвост пути.
 */

/** Извлечь пути из строки скрипта: [{ path, line, must }] (строки с единицы). */
export function parseIncludeLines(script) {
  const out = [];
  const lines = String(script ?? '').replace(/\r\n?/g, '\n').split('\n');
  const re = /\$\(\s*(must_include|include)\s*=\s*(\[)?([^\]\n)]+)/gi;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Комментарии-табы и пустые строки пропускаем: включение ищем по всей строке.
    let m;
    while ((m = re.exec(line)) !== null) {
      const path = m[3].trim().replace(/\]+$/, '');
      if (path) out.push({ path, line: i + 1, must: m[1].toLowerCase() === 'must_include' });
    }
  }
  return out;
}

/** Нормализованный ключ пути: нижний регистр, прямые слэши, хвостовой файл. */
export function includeKey(path) {
  const p = String(path ?? '').replace(/\\/g, '/').toLowerCase();
  const lib = /^lib:\/\/([^/]+)\//.exec(p);
  // lib://Имя/путь → ключ «имя/файл» (в разных средах имя коннекции может отличаться).
  if (lib) return `${lib[1]}/${p.slice(lib[0].length)}`;
  const tail = p.split('/').filter(Boolean);
  return tail.length ? tail[tail.length - 1] : p;
}

/** Найти содержимое по пути: точное совпадение ключа либо по хвостовому файлу. */
function lookup(map, path) {
  const key = includeKey(path);
  if (map.has(key)) return map.get(key);
  const file = key.split('/').pop();
  for (const [k, v] of map.entries()) {
    if (k.split('/').pop() === file) return v;
  }
  return null;
}

/**
 * Объединённый скрипт: строки включения заменяются содержимым файлов.
 * Вложенные include раскрываются рекурсивно (до глубины 5, циклы — guard).
 *
 * @param {string} script — главный скрипт приложения
 * @param {Record<string, string>} files — подложенные файлы (ключ/содержимое)
 * @returns {{ script: string, resolved: string[], missing: string[] }}
 */
export function resolveIncludes(script, files, depth = 0, seen = new Set()) {
  const map = files instanceof Map ? files : new Map(Object.entries(files ?? {}));
  const src = String(script ?? '');
  const includes = parseIncludeLines(src);
  if (!includes.length || depth > 5) {
    return { script: src, resolved: depth ? [] : [], missing: depth ? [] : [] };
  }
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const resolved = [];
  const missing = [];
  // Строки include заменяем снизу вверх, чтобы номера строк не поехали.
  for (let i = includes.length - 1; i >= 0; i -= 1) {
    const inc = includes[i];
    const key = includeKey(inc.path);
    const guard = `${key}#${inc.line}`;
    const content = lookup(map, inc.path);
    if (content == null) {
      missing.push(inc.path);
      continue;
    }
    if (seen.has(guard)) continue;
    seen.add(guard);
    let merged = content.replace(/\r\n?/g, '\n');
    if (depth < 5) {
      merged = resolveIncludes(merged, map, depth + 1, seen).script;
    }
    resolved.push(inc.path);
    lines.splice(inc.line - 1, 1, ...merged.split('\n'));
  }
  return { script: lines.join('\n'), resolved, missing };
}
