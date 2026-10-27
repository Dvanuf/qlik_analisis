import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { analyze } from '../src/analyzer.js';
import { ALL_RULES, RULES_BY_ID } from '../src/rules/index.js';
import {
  RULE_PLATFORMS, isRuleApplicable, PLATFORM_SENSE, PLATFORM_VIEW, PLATFORM_ANY,
} from '../src/rules/platforms.js';
import { renderHtml } from '../src/report/html.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, 'fixtures/app-graph.json'), 'utf8'));

const result = analyze(fixture, {});
const ids = new Set(result.findings.map((f) => f.ruleId));
const byId = (id) => result.findings.filter((f) => f.ruleId === id);

test('правила зарегистрированы и имеют уникальные ID', () => {
  assert.ok(ALL_RULES.length >= 25, 'ожидается не менее 25 правил');
  assert.equal(new Set(ALL_RULES.map((r) => r.id)).size, ALL_RULES.length);
  for (const rule of ALL_RULES) {
    assert.ok(rule.id && rule.title && rule.description && rule.recommendation, `rule ${rule.id} заполнен`);
    assert.ok(['Quality', 'Resources', 'Practices', 'Script'].includes(rule.category));
    assert.ok(['error', 'warning', 'info'].includes(rule.severity));
    assert.equal(typeof rule.run, 'function');
  }
});

test('Quality: найдена синтаксическая ошибка', () => {
  assert.ok(ids.has('Q001'));
});

test('Quality: найдена ссылка на несуществующее поле', () => {
  assert.ok(ids.has('Q002'));
  assert.ok(byId('Q002').some((f) => f.message.includes('NoSuchField')));
});

test('Quality: найдена ссылка на неопределённую переменную', () => {
  assert.ok(ids.has('Q003'));
});

test('Quality: найдена неизвестная функция', () => {
  assert.ok(ids.has('Q004'));
  assert.ok(byId('Q004').some((f) => f.message.includes('Smm')));
});

test('Quality: найден объект без описания', () => {
  assert.ok(ids.has('Q006'));
});

test('Resources: найдено неиспользуемое поле', () => {
  assert.ok(ids.has('R001'));
  assert.ok(byId('R001').some((f) => f.target.name === 'CustomerID'));
});

test('Resources: найдена неиспользуемая таблица', () => {
  assert.ok(ids.has('R003'));
  assert.ok(byId('R003').some((f) => f.target.name === 'Staging'));
});

test('Resources: найдена неиспользуемая переменная', () => {
  assert.ok(ids.has('R004'));
  assert.ok(byId('R004').some((f) => f.target.name === 'vUnused'));
});

test('Resources: найдено поле, полностью заполненное NULL', () => {
  assert.ok(ids.has('R005'));
  assert.ok(byId('R005').some((f) => f.target.name === 'Comment'));
});

test('Resources: найдена пустая таблица', () => {
  assert.ok(ids.has('R006'));
});

test('Resources: найден ключ, подходящий под AutoNumber', () => {
  assert.ok(ids.has('R007'));
  assert.ok(byId('R007').some((f) => f.target.name === 'OrderID'));
});

test('Resources: найден лист без объектов', () => {
  assert.ok(ids.has('R008'));
});

test('Practices: найдено дублирующееся выражение', () => {
  assert.ok(ids.has('P001'));
});

test('Practices: найдены совпадающие меры с разными именами', () => {
  assert.ok(ids.has('P002'));
});

test('Practices: найдено использование ключевого поля в выражении', () => {
  assert.ok(ids.has('P003'));
  assert.ok(byId('P003').some((f) => f.message.includes('OrderID')));
});

test('Practices: найден дубликат названия объекта', () => {
  assert.ok(ids.has('P004'));
  assert.ok(byId('P004').some((f) => f.message.includes('Margin')));
});

test('Practices: найден синтетический ключ', () => {
  assert.ok(ids.has('P005'));
  assert.ok(byId('P005').some((f) => f.target.name === 'Staging'));
});

test('Practices: найдено вычисляемое измерение', () => {
  assert.ok(ids.has('P006'));
});

test('Practices: найдено выражение по нескольким таблицам', () => {
  assert.ok(ids.has('P007'));
});

test('Practices: найден data island (Aggr)', () => {
  assert.ok(ids.has('P008'));
});

test('Practices: найдено сложное выражение', () => {
  assert.ok(ids.has('P009'));
});

test('патч скрипта содержит DROP FIELD и DROP TABLE', () => {
  assert.ok(result.patch.dropFields.includes('CustomerID'));
  assert.ok(result.patch.dropTables.includes('Staging'));
  assert.match(result.patch.script, /DROP FIELD/);
  assert.match(result.patch.script, /DROP TABLE/);
});

test('сводка считает находки по категориям', () => {
  assert.equal(result.summary.findings.total, result.findings.length);
  const sum = Object.values(result.summary.findings.byCategory).reduce((a, b) => a + b, 0);
  assert.equal(sum, result.findings.length);
});

test('правила можно отключать', () => {
  const only = analyze(fixture, { disabledRules: ['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007', 'R008', 'R009', 'R010', 'R011', 'R012', 'R013', 'R014', 'R015', 'R016', 'R017', 'R018', 'R019', 'R020', 'R021'] });
  assert.equal(only.findings.some((f) => f.category === 'Resources'), false);
  const stat = only.ruleStats.find((s) => s.id === 'R001');
  assert.equal(stat.skipped, true);
});

test('HTML-отчёт содержит сводку, находки и каталог правил', () => {
  const html = renderHtml(result);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Demo Sales'));
  assert.ok(html.includes('Каталог правил'));
  assert.ok(html.includes('DROP FIELD'));
  assert.ok(html.includes('data-category="Quality"'));
});

test('все правила отрабатывают без исключений на фикстуре', () => {
  assert.deepEqual(result.errors, []);
  for (const rule of ALL_RULES) assert.ok(RULES_BY_ID.has(rule.id));
});

test('каждое правило содержит описание, рекомендацию и платформы', () => {
  for (const rule of ALL_RULES) {
    assert.ok(rule.description?.trim().length > 20,
      `у правила ${rule.id} слишком короткое описание: ${rule.description}`);
    assert.ok(rule.recommendation?.trim().length > 10,
      `у правила ${rule.id} слишком короткая рекомендация: ${rule.recommendation}`);
    assert.ok(Array.isArray(rule.platforms) && rule.platforms.length,
      `у правила ${rule.id} не указаны платформы`);
  }
});

test('у правил нет внешних ссылок на сторонние справочники', () => {
  for (const rule of ALL_RULES) {
    const blob = JSON.stringify(rule);
    assert.ok(!/https?:\/\//i.test(blob), `в правиле ${rule.id} есть внешняя ссылка`);
  }
});

test('названия правил на русском языке', () => {
  for (const rule of ALL_RULES) {
    // Заголовок должен содержать кириллицу: английские названия из сторонних
    // справочников в отчётах смотрелись бы чужеродно.
    assert.ok(/[а-яА-ЯёЁ]/.test(rule.title),
      `заголовок правила ${rule.id} без кириллицы: ${rule.title}`);
  }
});

test('в HTML-отчёте каталог правил не содержит внешних ссылок', () => {
  const html = renderHtml(result);
  const catalog = html.slice(html.indexOf('Каталог правил'));
  assert.ok(catalog.includes('Рекомендация'), 'в каталоге правил нет колонки «Рекомендация»');
  // В каталоге не должно быть ссылок на внешние ресурсы.
  const links = catalog.match(/<a\s[^>]*href="http[^"]*"/gi) ?? [];
  assert.deepEqual(links, [], `в каталоге правил есть внешние ссылки: ${links.join(', ')}`);
});

// --- применимость правил по платформам ---

test('применимость размечена для всех правил и только известными платформами', () => {
  for (const rule of ALL_RULES) {
    assert.ok(Array.isArray(rule.platforms) && rule.platforms.length,
      `у правила ${rule.id} не указаны платформы`);
    for (const p of rule.platforms) {
      assert.ok([PLATFORM_SENSE, PLATFORM_VIEW].includes(p),
        `у правила ${rule.id} неизвестная платформа «${p}»`);
    }
  }
  // Каждое правило из реестра должно быть описано в карте применимости.
  for (const rule of ALL_RULES) {
    assert.ok(Object.hasOwn(RULE_PLATFORMS, rule.id),
      `правило ${rule.id} отсутствует в RULE_PLATFORMS`);
  }
});

test('правила, требующие фронт-енда, помечены как qlik-sense', () => {
  // QlikView Doc API не отдаёт объекты (getObjects пуст) — проверять нечего.
  const frontEndRules = [
    'Q001', 'Q002', 'Q003', 'Q004', 'Q005', 'Q006',
    'R001', 'R002', 'R003', 'R004', 'R008',
    'P001', 'P002', 'P003', 'P004', 'P006', 'P007', 'P008', 'P009', 'P010', 'P011',
    'R014', 'S008',
  ];
  for (const id of frontEndRules) {
    assert.deepEqual(RULES_BY_ID.get(id).platforms, [PLATFORM_SENSE],
      `правило ${id} должно быть только для Qlik Sense`);
  }
});

test('скриптовые и модельные правила применимы на обеих платформах', () => {
  const bothRules = [
    'Q007',
    'R005', 'R006', 'R007', 'R009', 'R010', 'R012', 'R013',
    'P005', 'P012', 'R011',
    'S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S009', 'S010', 'S011', 'S012',
  ];
  for (const id of bothRules) {
    assert.deepEqual(RULES_BY_ID.get(id).platforms, [PLATFORM_SENSE, PLATFORM_VIEW],
      `правило ${id} должно работать на обеих платформах`);
  }
});

test('isRuleApplicable: для неопределённой платформы правило применимо', () => {
  const rule = RULES_BY_ID.get('Q001');
  assert.equal(isRuleApplicable(rule, PLATFORM_ANY), true);
  assert.equal(isRuleApplicable(rule, undefined), true);
  assert.equal(isRuleApplicable(rule, PLATFORM_SENSE), true);
  assert.equal(isRuleApplicable(rule, PLATFORM_VIEW), false);
});

test('под QlikView правила фронт-енда пропускаются с пометкой', () => {
  const qv = analyze(fixture, { platform: PLATFORM_VIEW });
  const stat = qv.ruleStats.find((s) => s.id === 'Q001');
  assert.equal(stat.skipped, true);
  assert.match(stat.note, /Не применимо для платформы QlikView/);
  assert.equal(qv.findings.some((f) => f.ruleId === 'Q001'), false);
  // Скриптовые правила при этом работают.
  assert.equal(qv.ruleStats.find((s) => s.id === 'S010').skipped, false);
});

test('под Qlik Sense правила фронт-енда выполняются', () => {
  const qs = analyze(fixture, { platform: PLATFORM_SENSE });
  const stat = qs.ruleStats.find((s) => s.id === 'Q001');
  assert.equal(stat.skipped, false);
  assert.ok(qs.findings.some((f) => f.ruleId === 'Q001'));
});

test('платформа по умолчанию берётся из графа, а без неё фильтр не применяется', () => {
  // Офлайн-граф без meta.platform — платформа не определена, правила не отфильтровываются.
  const offline = analyze(fixture, {});
  assert.equal(offline.summary.platform, PLATFORM_ANY);
  assert.ok(offline.findings.some((f) => f.ruleId === 'Q001'));

  // Граф с платформой в meta — она используется.
  const withPlatform = analyze({ ...fixture, meta: { ...fixture.meta, platform: PLATFORM_VIEW } }, {});
  assert.equal(withPlatform.summary.platform, PLATFORM_VIEW);
  assert.equal(withPlatform.findings.some((f) => f.ruleId === 'Q001'), false);
});
