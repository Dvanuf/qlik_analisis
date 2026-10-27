/**
 * Ошибки скрипта загрузки по данным сервера.
 *
 * Движок Qlik умеет проверять скрипт сам: метод CheckScriptSyntax возвращает
 * список ошибок с номером строки и колонки. Это надёжнее нашего разбора:
 * сервер знает про язык Qlik всё, включая конструкции, которые мы не понимаем.
 *
 * Раньше в отчёте показывалось только «ошибка где-то в скрипте» — без указания,
 * где именно. Теперь у каждой ошибки есть строка, и по ней можно перейти к
 * месту в тексте.
 */

/**
 * Приводит ответ сервера к списку ошибок.
 *
 * Формат ответа отличается у разных версий: список может лежать в qErrors
 * или qItems, а номер строки — в qLineInTab или qLine. Поэтому читаем
 * несколько вариантов и молча пропускаем незнакомые.
 *
 * @param {object|object[]} res — ответ CheckScriptSyntax
 * @returns {Array<{message: string, line: number|null, column: number|null, type: string}>}
 */
export function normalizeScriptErrors(res) {
  if (!res) return [];
  const list = Array.isArray(res) ? res : (res.qErrors ?? res.qItems ?? []);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const message = String(
      e.qMessage ?? e.qText ?? e.message ?? e.qError ?? '',
    ).trim();
    if (!message) continue;
    const line = Number(e.qLineInTab ?? e.qLine ?? e.line ?? NaN);
    const column = Number(e.qColInLine ?? e.qCol ?? e.column ?? NaN);
    out.push({
      message,
      line: Number.isFinite(line) && line > 0 ? line : null,
      column: Number.isFinite(column) && column > 0 ? column : null,
      type: String(e.qType ?? e.type ?? ''),
    });
  }
  return out;
}

/**
 * Запрашивает у движка ошибки скрипта.
 *
 * Метод есть не у всех версий и не у всех платформ (у QlikView Doc API его
 * нет), поэтому отсутствие — не ошибка: возвращаем пустой список.
 *
 * @param {object} app — объект App QIX
 * @returns {Promise<Array<{message: string, line: number|null, column: number|null, type: string}>>}
 */
export async function fetchScriptErrors(app) {
  if (typeof app?.checkScriptSyntax !== 'function') return [];
  try {
    return normalizeScriptErrors(await app.checkScriptSyntax());
  } catch {
    // Часть версий сервера отвечает на этот метод отказом — это не дефект скрипта.
    return [];
  }
}
