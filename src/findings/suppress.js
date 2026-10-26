/**
 * Подавление находок.
 *
 * Два механизма:
 *  1) комментарий в скрипте — `// qa-ignore S001` на строке или перед блоком;
 *  2) глобальный список исключений — правило + приложение/таблица (в настройках).
 *
 * Подавленные находки не удаляются, а помечаются: их можно показать отдельным
 * переключателем в интерфейсе.
 */

/** Разбор директив `// qa-ignore <ПРАВИЛО> [<ПРАВИЛО> …]`. */
const IGNORE_RE = /\/\/\s*qa-ignore\s+([A-Za-z0-9_,\s-]+)/i;

/**
 * Директивы подавления из текста скрипта.
 *
 * Директива на строке N подавляет находки на строке N и на следующем за ней
 * операторе (блоке до ближайшей «;»).
 *
 * @param {string} script
 * @returns {Array<{ruleId: string, from: number, to: number, line: number}>}
 */
export function parseIgnoreDirectives(script) {
  const src = String(script ?? '');
  if (!src) return [];
  const lines = src.split(/\r?\n/);
  const directives = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = IGNORE_RE.exec(lines[i]);
    if (!match) continue;
    const ruleIds = match[1]
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]\d{3}$/.test(s));
    if (!ruleIds.length) continue;

    // Граница блока: до ближайшей «;» после директивы.
    let to = i + 1;
    for (let k = i + 1; k < lines.length; k += 1) {
      to = k + 1;
      if (lines[k].includes(';')) break;
    }
    for (const ruleId of ruleIds) {
      directives.push({ ruleId, from: i + 1, to, line: i + 1 });
    }
  }

  return directives;
}

/**
 * Совпадает ли находка с глобальным исключением.
 * @param {object} finding
 * @param {object} exclusion — {ruleId, app?, table?}
 * @param {object} context — {appName, appId}
 */
function matchesExclusion(finding, exclusion, context) {
  if (!exclusion) return false;
  const ruleId = String(exclusion.ruleId ?? exclusion.rule ?? '').toUpperCase();
  if (!ruleId || ruleId !== String(finding.ruleId ?? '').toUpperCase()) return false;

  const app = String(exclusion.app ?? '').trim();
  if (app) {
    const current = `${context.appName ?? ''} ${context.appId ?? ''}`.toLowerCase();
    if (!current.includes(app.toLowerCase())) return false;
  }

  const table = String(exclusion.table ?? '').trim();
  if (table) {
    const current = String(finding.table ?? finding.target?.name ?? '').toLowerCase();
    if (current !== table.toLowerCase()) return false;
  }

  return true;
}

/**
 * Применяет подавление к находкам.
 *
 * @param {object[]} findings
 * @param {{script?: string, exclusions?: object[], appName?: string, appId?: string}} options
 * @returns {{findings: object[], suppressed: object[]}}
 */
export function applySuppression(findings, options = {}) {
  const directives = parseIgnoreDirectives(options.script ?? '');
  const exclusions = options.exclusions ?? [];
  const context = { appName: options.appName ?? '', appId: options.appId ?? '' };

  const visible = [];
  const suppressed = [];

  for (const finding of findings ?? []) {
    const line = finding.line ?? null;
    const byDirective = line != null && directives.some((d) => (
      d.ruleId === String(finding.ruleId ?? '').toUpperCase()
      && line >= d.from && line <= d.to
    ));
    const byExclusion = exclusions.some((e) => matchesExclusion(finding, e, context));

    if (byDirective || byExclusion) {
      suppressed.push({
        ...finding,
        suppressed: true,
        suppressReason: byDirective
          ? 'Комментарий qa-ignore в скрипте'
          : 'Глобальное исключение из настроек',
      });
      continue;
    }
    visible.push(finding);
  }

  return { findings: visible, suppressed };
}
