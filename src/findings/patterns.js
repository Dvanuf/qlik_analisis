/**
 * Паттерны находок: корень проблемы — одна строка.
 *
 * Правило часто срабатывает много раз, и каждая сработка — отдельная строка
 * в таблице. Пользователю это не помогает: он видит список жалоб, а не
 * список причин. Например, «поле не используется» — это одна причина
 * (в таблице грузится лишнее поле), а не пятнадцать разных проблем.
 *
 * Паттерн — это группа находок одного правила с общей причиной. У паттерна
 * есть выражение (если причина в нём), список мест и счётчик мест.
 *
 * Как определяется причина:
 *  - правило уже свёрнуло находки само (P001, P002) — причина в выражении,
 *    оно берётся из поля `detail` нормализованной формы;
 *  - находка указывает на объект или таблицу — причина в этом объекте;
 *  - иначе причина не выделяется: находка остаётся сама по себе паттерном.
 *
 * Модуль ничего не теряет: каждая находка попадает ровно в один паттерн,
 * а `places` хранит все места — и количество, и список.
 */
import { domainForRule } from '../rules/domains.js';

/** Нормализованная форма выражения в detail находки. */
const NORMALIZED_RE = /Нормализованная форма:\s*(.+)$/;

/**
 * Причина находки: строка-ключ, по которой находки объединяются.
 *
 * @param {object} finding — находка
 * @returns {string} ключ причины
 */
export function causeKey(finding) {
  // Причина в выражении: одинаковая нормализованная форма — одна причина.
  const normalized = String(finding?.detail ?? '').match(NORMALIZED_RE);
  if (normalized) return `expr:${normalized[1].trim()}`;

  const target = finding?.target ?? {};
  const kind = String(target.kind ?? '');
  const name = String(target.name ?? '');

  // Объект приложения: причина в самом объекте.
  if (kind === 'object' || kind === 'measure' || kind === 'dimension' || kind === 'expression') {
    return `obj:${name}`;
  }
  // Поле или таблица: причина в конкретном поле/таблице.
  if (kind === 'field' || kind === 'table') {
    const table = String(finding?.table ?? '');
    return table ? `tbl:${table}:${name}` : `obj:${name}`;
  }
  // Переменная: причина в самой переменной.
  if (kind === 'variable') return `var:${name}`;

  // Находка без объекта — причина в самом правиле и тексте сообщения.
  return `msg:${String(finding?.message ?? finding?.ruleId ?? '')}`;
}

/**
 * Выражение, к которому относится паттерн.
 *
 * @param {object} finding — находка
 * @returns {string} выражение или нормализованная форма, '' если нет
 */
export function patternExpression(finding) {
  const normalized = String(finding?.detail ?? '').match(NORMALIZED_RE);
  if (normalized) return normalized[1].trim();
  // «Выражение: ...» — выражение из detail.
  const expr = String(finding?.detail ?? '').match(/^Выражение:\s*(.+)$/);
  if (expr) return expr[1].trim();
  return '';
}

/**
 * Место находки: где именно проблема.
 *
 * @param {object} finding — находка
 * @returns {{name: string, kind: string, table: string, line: number|null,
 *   sheet: string, message: string}}
 */
export function findingPlace(finding) {
  const target = finding?.target ?? {};
  const lines = finding?.lines ?? [];
  return {
    name: String(target.name ?? ''),
    kind: String(target.kind ?? ''),
    table: String(finding?.table ?? ''),
    line: lines.length ? lines[0] : (finding?.line ?? null),
    sheet: String(finding?.sheet ?? ''),
    message: String(finding?.message ?? ''),
  };
}

/**
 * Все места находки.
 *
 * Правило может уже перечислить объекты, где проблема повторяется
 * (P001, P002, P004, свёрнутая P010) — тогда каждое из них отдельное место.
 *
 * @param {object} finding — находка
 * @returns {object[]} места
 */
export function findingPlaces(finding) {
  const objects = finding?.objects;
  if (Array.isArray(objects) && objects.length > 1) {
    const kind = String(finding?.target?.kind ?? '');
    return objects.map((name) => ({
      name: String(name ?? ''),
      kind,
      table: String(finding?.table ?? ''),
      line: null,
      sheet: '',
      message: String(finding?.message ?? ''),
    }));
  }
  return [findingPlace(finding)];
}

/**
 * Группирует находки в паттерны: корень проблемы — одна строка.
 *
 * @param {object[]} findings — находки
 * @param {object} [opts]
 * @param {string[]} [opts.domains] — ограничить доменами
 * @returns {object[]} паттерны
 */
export function buildPatterns(findings, opts = {}) {
  const domains = opts.domains ? new Set(opts.domains) : null;
  const groups = new Map();

  for (const finding of findings ?? []) {
    if (domains) {
      const domain = finding.domain ?? domainForRule(finding.ruleId, finding.category);
      if (!domains.has(domain)) continue;
    }
    const key = `${finding.ruleId}|${causeKey(finding)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        ruleId: finding.ruleId,
        domain: finding.domain ?? domainForRule(finding.ruleId, finding.category),
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        expression: patternExpression(finding),
        message: finding.message,
        recommendation: finding.recommendation,
        places: [],
        count: 0,
      };
      groups.set(key, group);
    }
    const places = findingPlaces(finding);
    group.places.push(...places);
    // Мест может быть больше, чем находок: свёрнутая находка перечисляет
    // несколько объектов (count) или правило отдало список объектов.
    group.count += Math.max(places.length, finding.count ?? 1);
  }

  const out = [...groups.values()];
  for (const group of out) {
    // Список мест без повторов и без пустых имён.
    const seen = new Set();
    group.places = group.places.filter((p) => {
      const key = `${p.kind}:${p.name}:${p.line}`;
      if (!p.name && p.line == null) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Счётчик мест не меньше списка: он учитывает и свёрнутые находки.
    if (group.places.length > group.count) group.count = group.places.length;
  }

  return out;
}

/**
 * Паттерны, сгруппированные по правилам.
 *
 * @param {object[]} findings — находки
 * @param {object} [opts] — см. buildPatterns
 * @returns {{rules: object[], patterns: object[], places: number}}
 */
export function groupPatternsByRule(findings, opts = {}) {
  const patterns = buildPatterns(findings, opts);
  const byRule = new Map();
  for (const p of patterns) {
    if (!byRule.has(p.ruleId)) byRule.set(p.ruleId, []);
    byRule.get(p.ruleId).push(p);
  }
  const rules = [...byRule.entries()].map(([ruleId, list]) => ({
    ruleId,
    domain: list[0].domain,
    category: list[0].category,
    severity: list[0].severity,
    title: list[0].title,
    patterns: list,
    places: list.reduce((a, p) => a + p.count, 0),
  }));
  return {
    rules,
    patterns,
    places: patterns.reduce((a, p) => a + p.count, 0),
  };
}
