/**
 * Этапы анализа приложения.
 *
 * Анализ одного приложения занимает от нескольких секунд до минуты:
 * подключение, сбор метаданных, обход объектов, проверка правил. Пользователь
 * должен видеть, на чём именно остановился процесс, иначе ожидание выглядит
 * как зависание.
 *
 * Порядок этапов общий для ядра и интерфейса: список один, чтобы шаги
 * в приложении совпадали с шагами в отчёте.
 */

/** @type {{id: string, label: string}[]} */
export const ANALYSIS_STAGES = [
  { id: 'connect', label: 'Подключение к движку' },
  { id: 'layout', label: 'Свойства приложения' },
  { id: 'script', label: 'Скрипт загрузки' },
  { id: 'scriptErrors', label: 'Проверка скрипта сервером' },
  { id: 'dataModel', label: 'Таблицы и поля' },
  { id: 'objects', label: 'Объекты и листы' },
  { id: 'variables', label: 'Переменные' },
  { id: 'associations', label: 'Связи между таблицами' },
  { id: 'bookmarks', label: 'Закладки' },
  { id: 'rules', label: 'Проверка правил' },
  { id: 'report', label: 'Формирование отчёта' },
];

/**
 * Человекочитаемое название этапа.
 *
 * @param {string} stage
 * @returns {string}
 */
export function stageLabel(stage) {
  return ANALYSIS_STAGES.find((s) => s.id === stage)?.label ?? stage ?? '';
}
