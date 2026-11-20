/**
 * JUnit XML для CI (PLAN этап 5): находки анализа в формате JUnit,
 * который понимают GitLab CI / Jenkins / Azure DevOps.
 *
 * testsuite = приложение; testcase = правило каталога:
 *   failure  — правило нарушилось (в находках);
 *   skipped  — правило не выполнено (недостаточно данных / выключено);
 *   passed   — правило проверено, нарушений нет.
 *
 * Уровень провала для CLI (--fail-on): shouldFail(severityCounts, level).
 */

/** XML-экранирование текста. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CDATA-безопасный текст для тела failure. */
function cdata(s) {
  return `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]&gt;')}]]>`;
}

/**
 * JUnit XML по находкам приложения.
 * @param {object} opts
 * @param {string} opts.appName — имя приложения (testsuite name)
 * @param {Array<object>} opts.findings — находки (с ruleId/severity/message/recommendation/count)
 * @param {Array<object>} [opts.ruleStats] — каталог правил: для passed/skipped testcase
 * @returns {string} XML
 */
export function buildJUnitXml(opts = {}) {
  const appName = String(opts.appName ?? 'app');
  const findings = Array.isArray(opts.findings) ? opts.findings : [];
  const ruleStats = Array.isArray(opts.ruleStats) ? opts.ruleStats : [];

  const cases = [];
  // Находки: по одной testcase на запись (дедуплицированную).
  const seen = new Set();
  let failures = 0;
  for (const f of findings) {
    const key = `${f.ruleId}|${f.target?.kind ?? ''}|${f.target?.name ?? ''}|${f.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures += 1;
    const name = `${f.ruleId}: ${f.title ?? 'находка'}`;
    const body = [
      f.message,
      f.recommendation ? `Рекомендация: ${f.recommendation}` : '',
      f.tables?.length ? `Таблицы: ${f.tables.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    cases.push(
      `    <testcase name="${esc(name)}" classname="${esc(f.domain ?? f.category ?? '')}">\n`
      + `      <failure message="${esc(f.message ?? '')}" type="${esc(f.severity ?? 'warning')}">\n`
      + `        ${cdata(body)}\n`
      + `      </failure>\n`
      + `    </testcase>`,
    );
  }
  // Правила без находок: passed / skipped — чтобы CI показывал полноту прогона.
  for (const r of ruleStats) {
    if (findings.some((f) => f.ruleId === r.id)) continue;
    if (r.skipped) {
      cases.push(
        `    <testcase name="${esc(`${r.id}: ${r.title}`)}" classname="${esc(r.domain ?? r.category ?? '')}">\n`
        + `      <skipped message="${esc(r.note ?? 'правило не выполнено')}" />\n`
        + `    </testcase>`,
      );
    } else {
      cases.push(
        `    <testcase name="${esc(`${r.id}: ${r.title}`)}" classname="${esc(r.domain ?? r.category ?? '')}" />\n`,
      );
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="qlik-analyzer: ${esc(appName)}">`,
    `  <testsuite name="${esc(appName)}" tests="${cases.length}" failures="${failures}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

/**
 * Превышает ли набор находок порог провала CLI (--fail-on).
 * @param {{ error: number, warning: number, info: number }} bySeverity
 * @param {string} [level] — 'none' (по умолчанию) | 'error' | 'warning' | 'info'
 * @returns {boolean}
 */
export function shouldFail(bySeverity, level = 'none') {
  const s = bySeverity ?? {};
  if (level === 'error') return (s.error ?? 0) > 0;
  if (level === 'warning') return (s.error ?? 0) > 0 || (s.warning ?? 0) > 0;
  if (level === 'info') return (s.error ?? 0) > 0 || (s.warning ?? 0) > 0 || (s.info ?? 0) > 0;
  return false;
}
