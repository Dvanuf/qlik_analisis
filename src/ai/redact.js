/**
 * Маскирование персональных и коммерческих данных перед отправкой во внешний API.
 *
 * Что маскируется:
 * - адреса электронной почты;
 * - номера телефонов (российские и международные форматы);
 * - ФИО: «Иванов Иван Иванович» и «Иванов И.И.»;
 * - названия, переданные явно: владелец приложения, название приложения.
 *
 * Маскирование детерминированное: одно и то же значение в рамках одного
 * запроса всегда заменяется одним и тем же плейсхолдером. Это позволяет
 * модели рассуждать о связях («владелец А владеет и приложением Б»), не видя
 * самих имён. Порядок появления плейсхолдеров зависит от порядка обхода.
 */

/** Частые слова, которые встречаются в названиях объектов и не являются ФИО. */
const NOT_A_NAME = new Set([
  'Список', 'Продажи', 'Продаж', 'Клиенты', 'Клиентов', 'Товары', 'Товаров',
  'Заказы', 'Заказов', 'Отчёт', 'Отчеты', 'Отчёты', 'Динамика', 'Анализ',
  'Данные', 'Данных', 'Прогноз', 'План', 'Факт', 'Сумма', 'Итог', 'Оборот',
  'Склад', 'Остатки', 'Остаток', 'Цена', 'Цены', 'Скидка', 'Скидки',
  'Дата', 'Месяц', 'Год', 'Квартал', 'Регион', 'Город', 'Страна', 'Канал',
  'Менеджер', 'Менеджеры', 'Статус', 'Категория', 'Категории', 'Товар',
  'Поле', 'Поля', 'Таблица', 'Таблицы', 'Скрипт', 'Модель', 'Лист', 'Листы',
  'Выбор', 'Значения', 'Показатель', 'Показатели', 'Мера', 'Меры',
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// +7 999 123-45-67 / 8 (999) 123-45-67 / +7-999-123-45-67
const PHONE_RE = /(?:\+7|8)[\s(-]?\d{3}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g;
// Полное ФИО: Фамилия Имя Отчество.
// Границы слов заданы свойствами Unicode: обычный \b в JavaScript работает
// только по ASCII и на кириллице не срабатывает.
const FIO_FULL_RE = /(?<![\p{L}\p{N}_])[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?![\p{L}\p{N}_])/gu;
// ФИО с инициалами: Фамилия И. И.
const FIO_SHORT_RE = /(?<![\p{L}\p{N}_])[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.(?![\p{L}\p{N}_])/gu;

/**
 * Создаёт маскировщик на один запрос.
 *
 * @param {{names?: Array<{value: string, kind?: string}|string}} [options]
 *   names — значения, которые нужно скрыть целиком (владелец, название
 *   приложения). kind задаёт подпись плейсхолдера: «Владелец», «Приложение».
 * @returns {{mask: (text: string) => string, maskValue: (value: unknown) => unknown,
 *   replacements: Map<string, string>, count: () => number}}
 */
export function createRedactor(options = {}) {
  /** @type {Map<string, string>} исходное значение → плейсхолдер */
  const replacements = new Map();
  /** @type {Map<string, number>} вид плейсхолдера → счётчик */
  const counters = new Map();
  /** Явно переданные значения: {value, placeholder}. */
  const explicit = [];

  /** Плейсхолдер для вида: «Владелец_1», «Владелец_2»… */
  function placeholder(kind) {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return `${kind}_${n}`;
  }

  /** Замена для известного значения — с учётом уже выданного плейсхолдера. */
  function known(value, kind) {
    const key = String(value ?? '').trim();
    if (!key) return value;
    const existing = replacements.get(key);
    if (existing) return existing;
    const ph = placeholder(kind);
    replacements.set(key, ph);
    return ph;
  }

  /** Замена по регулярке: первое появление получает плейсхолдер, дальше — тот же. */
  function byPattern(text, re, kind) {
    return text.replace(re, (match) => known(match, kind));
  }

  /**
   * Маскирует строку.
   * @param {string} text
   * @returns {string}
   */
  function mask(text) {
    if (text == null) return '';
    let out = String(text);
    // Сначала подставляем явно переданные значения: длинные — раньше, чтобы
    // «Продажи РФ» не распалось на части.
    for (const item of [...explicit].sort((a, b) => b.value.length - a.value.length)) {
      out = out.split(item.value).join(item.placeholder);
    }
    out = byPattern(out, EMAIL_RE, 'email');
    out = byPattern(out, PHONE_RE, 'телефон');
    out = byPattern(out, FIO_SHORT_RE, 'ФИО');
    // Полное ФИО проверяем отдельно: последовательность из трёх заглавных слов
    // — это не всегда человек (например, «Список Продажи Клиентов»).
    out = out.replace(FIO_FULL_RE, (match) => {
      const words = match.split(/\s+/);
      if (words.some((w) => NOT_A_NAME.has(w))) return match;
      return known(match, 'ФИО');
    });
    return out;
  }

  /** Маскирует значение любого типа: строки, числа, массивы, объекты. */
  function maskValue(value) {
    if (typeof value === 'string') return mask(value);
    if (Array.isArray(value)) return value.map(maskValue);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = maskValue(v);
      return out;
    }
    return value;
  }

  // Явно переданные значения маскируем первыми — у них приоритет и
  // собственный вид плейсхолдера («Владелец_1», а не «ФИО_1»).
  for (const item of options.names ?? []) {
    const value = typeof item === 'string' ? item : item?.value;
    const kind = typeof item === 'string' ? 'Имя' : (item?.kind ?? 'Имя');
    if (!value) continue;
    const ph = known(String(value), kind);
    explicit.push({ value: String(value), placeholder: ph });
  }

  return {
    mask,
    maskValue,
    replacements,
    count: () => replacements.size,
  };
}

/**
 * Разовое маскирование строки — удобно для тестов и простых случаев.
 * @param {string} text
 * @param {{names?: Array<{value: string, kind?: string}|string>}} [options]
 * @returns {string}
 */
export function redact(text, options = {}) {
  return createRedactor(options).mask(text);
}
