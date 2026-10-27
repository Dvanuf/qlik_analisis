/**
 * Применимость правил по платформам.
 *
 * qlik-sense — только Qlik Sense (нужны объекты фронт-енда, master items,
 *              закладки, расширения, темы);
 * qlikview  — только QlikView 12;
 * both       — на обеих платформах;
 * any       — платформа не определена (офлайн-режим): правило проверяется,
 *              если хватает доступных данных.
 *
 * Основание разметки — что реально отдаёт API платформы:
 *  - Qlik Sense (QIX Engine API): скрипт, модель данных, объекты, переменные,
 *    закладки, расширения, связи между таблицами;
 *  - QlikView 12 (Doc API): скрипт, модель данных, переменные, свойства
 *    приложения; объекты (листы, чарты) НЕ отдаются — getObjects пуст.
 *
 * Поэтому правила, которым нужен фронт-енд (объекты, листы, выражения чартов),
 * помечены как qlik-sense: на QlikView их нечего проверять, а «неиспользуемое
 * поле» доказать без списка объектов нельзя.
 */

/** Qlik Sense (QIX Engine API). */
export const PLATFORM_SENSE = 'qlik-sense';
/** QlikView 12 (Doc API). */
export const PLATFORM_VIEW = 'qlikview';
/** Платформа не определена — офлайн-режим, фильтр по платформе не применяется. */
export const PLATFORM_ANY = 'any';
/**
 * Платформу определяет сервер — по набору типов объектов приложения.
 * Один и тот же Sense-сервер бывает доступен через Doc API, поэтому по
 * способу подключения судить нельзя.
 */
export const PLATFORM_AUTO = 'auto';

/** Известные платформы (для валидации значения из CLI/конфига). */
export const PLATFORMS = [PLATFORM_SENSE, PLATFORM_VIEW, PLATFORM_AUTO];

/** Человекочитаемые названия платформ — для отчёта и пометок. */
export const PLATFORM_LABELS = {
  [PLATFORM_SENSE]: 'Qlik Sense',
  [PLATFORM_VIEW]: 'QlikView',
  [PLATFORM_AUTO]: 'определяется по данным сервера',
  [PLATFORM_ANY]: 'определяется автоматически',
};

/**
 * Типы объектов, которые встречаются только в Qlik Sense.
 *
 * QlikView 12 знает другой набор типов (chart, bar, line, pivot, button…),
 * а перечисленные ниже появились в Sense 12: KPI, фильтры, кнопки действий,
 * истории, слайды. Их присутствие — верный признак Sense, даже когда
 * подключение выполнено через Doc API.
 */
export const SENSE_ONLY_TYPES = new Set([
  'UniKPI', 'UniBarChart', 'filterpane', 'action-button', 'piechart',
  'scatterplot', 'uni_shecklist', 'text-image', 'slide', 'sn-table',
  'hybridchart', 'pivotchart',
]);

/**
 * Определяет платформу по собранным объектам.
 *
 * Различать платформы по типу API ненадёжно: один и тот же Sense-сервер
 * бывает доступен через Doc API, и тогда приложение ошибочно считалось
 * QlikView, а все правила по фронт-энду пропускались.
 *
 * @param {object[]} objects — собранные объекты приложения
 * @returns {string} 'qlik-sense' | 'qlikview'
 */
export function detectPlatform(objects) {
  for (const obj of objects ?? []) {
    if (SENSE_ONLY_TYPES.has(obj?.type)) return PLATFORM_SENSE;
  }
  return PLATFORM_VIEW;
}

/** Обе платформы. */
const BOTH = [PLATFORM_SENSE, PLATFORM_VIEW];

/**
 * Применимость правил по платформам.
 *
 * Ключ — ID правила, значение — список платформ, на которых правило применимо.
 * Правило, которого здесь нет, считается применимым на обеих платформах.
 */
export const RULE_PLATFORMS = {
  // --- Quality: ошибки в выражениях и объектах фронт-енда ---
  Q001: [PLATFORM_SENSE], // выражения объектов
  Q002: [PLATFORM_SENSE], // выражения объектов
  Q003: [PLATFORM_SENSE], // выражения объектов
  Q004: [PLATFORM_SENSE], // выражения объектов
  Q005: [PLATFORM_SENSE], // объекты
  Q006: [PLATFORM_SENSE], // объекты
  Q007: BOTH, // переменные есть на обеих платформах

  // --- Resources: «балласт» приложения ---
  R001: [PLATFORM_SENSE], // нужен список объектов: без него неиспользуемость не доказать
  R002: [PLATFORM_SENSE], // нужен список объектов
  R003: [PLATFORM_SENSE], // нужен список объектов
  R004: [PLATFORM_SENSE], // нужно знать, используется ли переменная во фронт-енде
  R005: BOTH, // модель данных
  R006: BOTH, // модель данных
  R007: BOTH, // модель данных
  R008: [PLATFORM_SENSE], // листы есть только в Qlik Sense
  R009: BOTH, // модель данных
  R010: BOTH, // модель данных
  R012: BOTH, // модель данных
  R013: BOTH, // свойства приложения (превью)
  R015: [PLATFORM_SENSE], // master-объекты есть только в Qlik Sense
  R016: [PLATFORM_SENSE], // условие вычисления есть только в Qlik Sense
  R017: [PLATFORM_SENSE], // состав листа известен только в Qlik Sense
  R018: [PLATFORM_SENSE], // измерения объекта известны только в Qlik Sense

  // --- Practices: качество проектирования ---
  P001: [PLATFORM_SENSE], // выражения объектов
  P002: [PLATFORM_SENSE], // меры объектов
  P003: [PLATFORM_SENSE], // выражения объектов
  P004: [PLATFORM_SENSE], // объекты
  P005: BOTH, // модель данных
  P006: [PLATFORM_SENSE], // измерения объектов
  P007: [PLATFORM_SENSE], // выражения объектов
  P008: [PLATFORM_SENSE], // выражения объектов
  P009: [PLATFORM_SENSE], // выражения объектов
  P010: [PLATFORM_SENSE], // объекты
  P011: [PLATFORM_SENSE], // выражения объектов
  P012: BOTH, // модель данных
  R011: BOTH, // связи между таблицами
  R014: [PLATFORM_SENSE], // типы визуализаций

  // --- Script: синтаксис скрипта загрузки общий для Sense и QlikView ---
  S001: BOTH,
  S002: BOTH,
  S003: BOTH,
  S004: BOTH,
  S005: BOTH,
  S006: BOTH,
  S007: BOTH,
  S008: [PLATFORM_SENSE], // нужно знать, используется ли переменная во фронт-енде
  S009: BOTH,
  S010: BOTH,
  S011: BOTH,
  S012: BOTH,
};

/**
 * Возвращает обогащённое описание правила: добавляет поле platforms.
 *
 * Типы намеренно нестрогие (any): правило — свободный объект с полями
 * id/category/severity/title/description/recommendation/run, а список правил
 * используется и в TypeScript-части десктопа (каталог правил).
 *
 * @param {any} rule
 * @returns {any}
 */
export function enrichRule(rule) {
  const platforms = RULE_PLATFORMS[rule.id] ?? BOTH;
  return { ...rule, platforms };
}

/**
 * Применимо ли правило к указанной платформе.
 *
 * Для PLATFORM_ANY (платформа не определена) правило считается применимым:
 * решение «пропустить» принимает само правило, если данных не хватает.
 *
 * @param {object} rule — правило (желательно обогащённое через enrichRule)
 * @param {string} platform — qlik-sense | qlikview | any
 * @returns {boolean}
 */
export function isRuleApplicable(rule, platform) {
  if (!platform || platform === PLATFORM_ANY) return true;
  const list = rule?.platforms;
  if (!Array.isArray(list) || !list.length) return true;
  return list.includes(platform);
}

/**
 * Человекочитаемое название платформы.
 * @param {string} platform
 * @returns {string}
 */
export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? String(platform ?? 'неизвестно');
}
