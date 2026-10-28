/**
 * Домены анализа — «какая забота», а не «в каком файле лежит правило».
 *
 * Внутренние категории правил (Quality / Resources / Practices / Script)
 * описывают структуру кода и пользователю ничего не сообщают. Домен отвечает
 * на вопрос «что именно проверяем»: модель данных, скрипт загрузки, дашборд,
 * меры и выражения, переменные, подключения.
 *
 * Правило, не попавшее ни в одну карту, попадает в домен по категории —
 * так новые правила не пропадают из интерфейса.
 */

/** Порядок доменов в интерфейсе. */
export const DOMAIN_ORDER = ['model', 'script', 'dash', 'expr', 'vars', 'conn'];

/** Подписи доменов. */
export const DOMAIN_LABELS = {
  model: 'Модель данных',
  script: 'Скрипт загрузки',
  dash: 'Дашборд и объекты',
  expr: 'Меры и выражения',
  vars: 'Переменные',
  conn: 'Подключения и окружение',
};

/**
 * Правила по доменам. Проверено против полного списка правил: 54 из 54.
 */
export const DOMAIN_RULES = {
  model: [
    'R001', 'R002', 'R003', 'R005', 'R006', 'R007', 'R009', 'R010', 'R011',
    'R012', 'R020', 'R021', 'P003', 'P005', 'P010', 'P012',
  ],
  script: [
    'S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008', 'S009',
    'S010', 'S011', 'S012', 'S013', 'S014',
  ],
  dash: [
    'R008', 'R013', 'R014', 'R015', 'R016', 'R017', 'R018',
    'P004', 'P006', 'P009', 'Q006',
  ],
  expr: [
    'Q001', 'Q002', 'Q003', 'Q004', 'Q005',
    'P001', 'P002', 'P007', 'P008', 'P011',
  ],
  vars: ['R004', 'Q007'],
  conn: ['R019'],
};

/** Категория правила → домен (запасной вариант). */
const CATEGORY_DOMAIN = {
  Quality: 'model',
  Resources: 'model',
  Practices: 'dash',
  Script: 'script',
};

/** Правило → домен. */
const RULE_DOMAIN = new Map();
for (const [domain, ids] of Object.entries(DOMAIN_RULES)) {
  for (const id of ids) RULE_DOMAIN.set(id, domain);
}

/**
 * Домен правила.
 * @param {string} ruleId
 * @param {string} [category] — категория правила (запасной вариант)
 * @returns {string} идентификатор домена
 */
export function domainForRule(ruleId, category) {
  return RULE_DOMAIN.get(ruleId)
    ?? CATEGORY_DOMAIN[category ?? '']
    ?? 'dash';
}

/**
 * Типы доменов — для TypeScript-части десктоп-приложения.
 *
 * Идентификаторы совпадают с ключами DOMAIN_LABELS.
 *
 * @type {const}
 */
export const DOMAIN_IDS = ['model', 'script', 'dash', 'expr', 'vars', 'conn'];

/**
 * Разбивка правил по доменам.
 * @param {object[]} ruleStats — статистика правил из runRules
 * @returns {Record<string, object[]>} правила по доменам, в порядке DOMAIN_ORDER
 */
export function groupRulesByDomain(ruleStats) {
  const out = {};
  for (const d of DOMAIN_ORDER) out[d] = [];
  for (const s of ruleStats ?? []) {
    out[domainForRule(s.id, s.category)].push(s);
  }
  return out;
}
