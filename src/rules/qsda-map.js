/**
 * Соответствие наших правил флагам QSDA Pro V3.7.
 *
 * Источник: https://qsda.help.motio.com/V3.7/flag-descriptions/
 * Полный справочник с описаниями: docs/qsda-flags-v3.7.md (генерируется скриптом
 * scripts/gen-qsda-reference.mjs).
 *
 * Совпадение бывает трёх видов:
 *   exact     — правило реализует тот же флаг QSDA;
 *   partial   — правило покрывает только часть флага;
 *   none      — аналога в QSDA нет (наши собственные проверки).
 */

export const QSDA_BASE = 'https://qsda.help.motio.com/V3.7/flag-descriptions';

/** slug → название флага QSDA (39 флагов V3.7). */
export const QSDA_FLAGS = {
  zerorowtable: '0-row Table',
  nullfield: '100 Pct Null field',
  tablefieldsunused: 'All fields unused but keys',
  bookmarkmissingfield: 'Bookmark Field not Found',
  calculateddimension: 'Calculated Dimension',
  circularreference: 'Circular Reference',
  conditionalaggregation: 'Conditional Aggregation',
  dataislandexpression: 'Data Island Expression',
  deprecatedobject: 'DeprecatedVisualization',
  dimensionsyntaxerror: 'Dimension Syntax Error',
  duplicateidentifier: 'Duplicate Name',
  expressionmatchingmeasure: 'Expression Matching Measure',
  expressionsyntaxerror: 'Expression Syntax Error',
  holdingunusedfield: 'Master Item holding unused field',
  autonumberkey: 'Key can be Autonumbered',
  keyinexpression: 'Key Field Used in Expression',
  masterdimduplicatedef: 'Master Dimension Duplicate Definition',
  masterdimduplicatelabel: 'Master Dimension Duplicate Label',
  masterdimduplicate: 'Master Dimension Duplication',
  mastermeasduplicatedef: 'Master Measure Duplicate Definition',
  mastermeasduplicatelabel: 'Master Measure Duplicate Label',
  mastermeasduplicate: 'Master Measure Duplication',
  missingactiontarget: 'Missing Action Target',
  missingextension: 'Missing Extension',
  missingkeyvalue: 'Missing Key value',
  missingmasterdimension: 'Missing Master Dimension',
  missingmastermeasure: 'Missing Master Measure',
  missingmasterviz: 'Missing Master Visualization',
  multitableexpression: 'Multi Table Expression',
  missingtheme: 'Missing Theme',
  noappthumbnail: 'No Application Thumbnail',
  parseerror: 'Parse Error',
  repeatingexpression: 'Repeating Expression',
  synthetickeyfield: 'Synthetic Key field',
  synthetickeytable: 'Synthetic Key table',
  suboptimalnumericstorage: 'Suboptimal numeric storage',
  outerjointables: 'Tables can be Outer Joined',
  unrecognizedname: 'Unrecognized Name',
  unusedfield: 'Unused Field',
};

/** Наши правила → флаги QSDA. */
export const RULE_QSDA = {
  Q001: ['expressionsyntaxerror', 'dimensionsyntaxerror'],
  Q002: ['unrecognizedname'],
  Q003: ['unrecognizedname'],
  Q004: ['parseerror'],
  Q010: ['parseerror'],
  Q011: ['parseerror'],
  R001: ['unusedfield'],
  R002: ['unusedfield'],
  R003: ['tablefieldsunused'],
  R005: ['nullfield'],
  R006: ['zerorowtable'],
  R007: ['autonumberkey'],
  R010: ['missingkeyvalue'],
  R011: ['outerjointables'],
  R012: ['suboptimalnumericstorage'],
  R013: ['noappthumbnail'],
  R014: ['deprecatedobject'],
  P001: ['repeatingexpression'],
  P002: ['expressionmatchingmeasure'],
  P003: ['keyinexpression'],
  P004: ['duplicateidentifier'],
  P005: ['synthetickeytable'],
  P012: ['synthetickeyfield'],
  P006: ['calculateddimension'],
  P007: ['multitableexpression'],
  P008: ['dataislandexpression'],
  P011: ['conditionalaggregation'],
  S004: ['synthetickeytable'],
  S006: ['keyinexpression'],
  S007: ['unusedfield'],
  S009: ['unrecognizedname'],
  S010: ['parseerror'],
};

/** Флаги QSDA, которые мы пока не реализовали (осознанный долг). */
export const QSDA_NOT_IMPLEMENTED = [
  'bookmarkmissingfield', 'circularreference', 'holdingunusedfield',
  'masterdimduplicatedef', 'masterdimduplicatelabel', 'masterdimduplicate',
  'mastermeasduplicatedef', 'mastermeasduplicatelabel', 'mastermeasduplicate',
  'missingactiontarget', 'missingextension', 'missingmasterdimension',
  'missingmastermeasure', 'missingmasterviz', 'missingtheme',
];

/**
 * Платформы, на которых правило применимо.
 * qlik-sense — только Qlik Sense (нужны master items, закладки, расширения);
 * qlikview  — только QlikView 12;
 * both       — на обеих платформах.
 */
export const RULE_PLATFORMS = {
  // Правила про master items, закладки и окружение — только Qlik Sense.
  P002: ['qlik-sense', 'qlikview'],
};

/** Возвращает обогащённое описание правила. */
export function enrichRule(rule) {
  const slugs = RULE_QSDA[rule.id] ?? [];
  const platforms = RULE_PLATFORMS[rule.id] ?? ['qlik-sense', 'qlikview'];
  return {
    ...rule,
    qsdaFlags: slugs,
    qsdaName: slugs.length ? QSDA_FLAGS[slugs[0]] : null,
    qsdaUrl: slugs.length ? `${QSDA_BASE}/${slugs[0]}/` : null,
    platforms,
  };
}
