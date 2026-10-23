/**
 * Реестр правил и их прогон.
 */
import { qualityRules } from './quality.js';
import { resourceRules } from './resources.js';
import { practiceRules } from './practices.js';
import { scriptRules } from './script.js';
import { advancedRules } from './advanced.js';
import { enrichRule, isRuleApplicable, platformLabel, PLATFORM_ANY } from './platforms.js';

export const ALL_RULES = [
  ...qualityRules, ...resourceRules, ...practiceRules, ...scriptRules, ...advancedRules,
].map(enrichRule);

export const RULES_BY_ID = new Map(ALL_RULES.map((r) => [r.id, r]));

export const CATEGORIES = ['Quality', 'Resources', 'Practices', 'Script'];

export const SEVERITIES = ['error', 'warning', 'info'];

/**
 * Прогоняет правила над графом приложения.
 * @param {object} graph
 * @param {object} index
 * @param {object} config
 * @returns {{findings: object[], ruleStats: object[], errors: object[]}}
 */
export function runRules(graph, index, config = {}, ctxScript = null) {
  const findings = [];
  const errors = [];
  const enabled = config.enabledRules ? new Set(config.enabledRules) : null;
  const disabled = config.disabledRules ? new Set(config.disabledRules) : null;

  const ruleStats = ALL_RULES.map((rule) => ({
    id: rule.id,
    category: rule.category,
    severity: rule.severity,
    title: rule.title,
    description: rule.description,
    recommendation: rule.recommendation,
    platforms: rule.platforms,
    count: 0,
    skipped: false,
    note: null,
  }));
  const statById = new Map(ruleStats.map((s) => [s.id, s]));

  // Платформа анализа: qlik-sense | qlikview | any (не определена).
  // Для 'any' фильтр по платформе не применяется — решение о пропуске принимает
  // само правило, если данных не хватает.
  const platform = config.platform ?? PLATFORM_ANY;

  for (const rule of ALL_RULES) {
    if (enabled && !enabled.has(rule.id)) { statById.get(rule.id).skipped = true; continue; }
    if (disabled && disabled.has(rule.id)) { statById.get(rule.id).skipped = true; continue; }
    // Правило может быть неприменимо к выбранной платформе.
    if (!isRuleApplicable(rule, platform)) {
      const stat = statById.get(rule.id);
      stat.skipped = true;
      stat.note = `Не применимо для платформы ${platformLabel(platform)}.`;
      continue;
    }
    // Скриптовые правила требуют текста скрипта — без него они не применимы.
    if (rule.category === 'Script' && !String(graph.script ?? '').trim()) {
      statById.get(rule.id).skipped = true;
      continue;
    }
    try {
      const res = rule.run({ graph, index, config, script: ctxScript }) ?? [];
      // Правило может вернуть { findings, note } — note объясняет, почему проверка не выполнялась.
      const list = Array.isArray(res) ? res : (res.findings ?? []);
      const note = Array.isArray(res) ? null : (res.note ?? null);
      if (note) {
        const stat = statById.get(rule.id);
        if (stat) stat.note = note;
      }
      for (const f of list) {
        findings.push({ ...f, ruleId: f.ruleId ?? rule.id });
        const stat = statById.get(rule.id);
        if (stat) stat.count += 1;
      }
    } catch (err) {
      errors.push({ ruleId: rule.id, message: err?.message ?? String(err) });
    }
  }

  const severityOrder = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => {
    const s = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (s !== 0) return s;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return String(a.ruleId).localeCompare(String(b.ruleId));
  });

  return { findings, ruleStats, errors };
}
