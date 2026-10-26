/**
 * Плоская таблица находок для выгрузки в CSV и Excel.
 *
 * Одна строка — одна находка. Колонки подобраны так, чтобы файл можно было
 * загрузить в Qlik Sense как источник для QA-дашборда.
 */

/** Колонки плоской таблицы. */
export const FINDINGS_COLUMNS = [
  { key: 'runAt', title: 'Дата запуска' },
  { key: 'app', title: 'Приложение' },
  { key: 'stream', title: 'Поток' },
  { key: 'owner', title: 'Владелец' },
  { key: 'ruleId', title: 'Правило' },
  { key: 'category', title: 'Категория' },
  { key: 'severity', title: 'Важность' },
  { key: 'object', title: 'Объект' },
  { key: 'table', title: 'Таблица' },
  { key: 'line', title: 'Строка' },
  { key: 'message', title: 'Текст' },
];

/** Человекочитаемые названия важности. */
const SEVERITY_LABELS = { error: 'Ошибка', warning: 'Предупреждение', info: 'Замечание' };

/**
 * Превращает находки в строки плоской таблицы.
 * @param {object[]} findings
 * @param {{runAt?: string, app?: string, stream?: string, owner?: string}} [meta]
 */
export function toFlatRows(findings, meta = {}) {
  return (findings ?? []).map((f) => ({
    runAt: meta.runAt ?? '',
    app: meta.app ?? '',
    stream: meta.stream ?? '',
    owner: meta.owner ?? '',
    ruleId: f.ruleId ?? '',
    category: f.category ?? '',
    severity: SEVERITY_LABELS[f.severity] ?? f.severity ?? '',
    object: f.target?.name ?? '',
    table: f.table ?? (f.target?.kind === 'table' ? f.target.name : ''),
    line: f.line ?? '',
    message: f.message ?? '',
  }));
}

/** Экранирование значения для CSV. */
function csvCell(value) {
  const text = String(value ?? '');
  if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Формирует CSV (разделитель «;» — так файл открывается в русском Excel).
 * @param {object[]} rows — строки плоской таблицы
 * @returns {string} текст CSV с BOM
 */
export function renderCsv(rows) {
  const header = FINDINGS_COLUMNS.map((c) => csvCell(c.title)).join(';');
  const body = (rows ?? []).map((row) => FINDINGS_COLUMNS.map((c) => csvCell(row[c.key])).join(';'));
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}
