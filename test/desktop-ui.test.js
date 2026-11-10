/**
 * Структурные проверки интерфейса десктопа (UX-быстрые победы 0.10.0).
 *
 * Регрессия: обратная связь о действиях была тихой строкой в глубине
 * вкладки, Esc не закрывал панель паттерна, горячих клавиш не было,
 * кнопка «Обновить» в шапке не работала. Проверки держат эти механизмы
 * на месте: если правка их вынесет — тест упадёт.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'App.tsx'), 'utf8');
const SCRIPT_TAB = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'tabs', 'ScriptTab.tsx'), 'utf8');
const ANALYSIS_TAB = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'tabs', 'AnalysisTab.tsx'), 'utf8');
const REFACTOR_TAB = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'tabs', 'RefactorTab.tsx'), 'utf8');
const AI_TAB = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'tabs', 'AiTab.tsx'), 'utf8');
const TYPES = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'types.ts'), 'utf8');
const STYLES = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'styles.css'), 'utf8');

test('App: тосты — showToast есть, тихие exportNote-строки убраны', () => {
  assert.ok(APP.includes('function showToast('), 'нет функции showToast');
  assert.ok(APP.includes('className={`toast on ${toast.kind}`'), 'тост не рендерится');
  assert.ok(APP.includes('window.setTimeout(() => setToast(null)'), 'тост не скрывается по таймеру');
  // Тихие строки заменены: state exportNote больше не существует.
  assert.ok(!APP.includes('exportNote'), 'в App остался exportNote');
  // Вкладки больше не рендерят exportNote как строку.
  for (const [name, src] of [['AnalysisTab', ANALYSIS_TAB], ['RefactorTab', REFACTOR_TAB]]) {
    assert.ok(!src.includes('exportNote'), `${name}: остался exportNote`);
  }
  assert.ok(ANALYSIS_TAB.includes('onNote('), 'AnalysisTab: подавление находки не идёт в onNote');
});

test('App: горячие клавиши — Ctrl/Cmd+1..9 и Ctrl+F на скрипте', () => {
  assert.ok(APP.includes('const TAB_GROUPS'), 'нет групп вкладок (Обзор/Работа/Помощь/Настройки)');
  assert.ok(APP.includes('const TAB_ORDER: Tab[] = TAB_GROUPS.flatMap'), 'TAB_ORDER не из групп');
  // 0 — десятая вкладка.
  assert.ok(APP.includes("digit[1] === '0' ? 10 :"), 'нет Ctrl+0 для десятой вкладки');
  assert.ok(APP.includes("addEventListener('keydown', onKey)"), 'нет keydown-обработчика');
  // По e.code — работает в любой раскладке.
  assert.ok(APP.includes('/^Digit([0-9])$/.exec(e.code)'), 'вкладки переключаются не по e.code');
  assert.ok(APP.includes("e.code === 'KeyF'"), 'Ctrl+F не по e.code');
  assert.ok(APP.includes("'script-find'"), 'Ctrl+F не ищет поле поиска');
  // Подсказка с номером на кнопках вкладок.
  assert.ok(APP.includes('Ctrl+${i === 9 ? 0 : i + 1}'), 'на вкладках нет подсказки горячих клавиш');
});

test('ScriptTab: поиск по тексту скрипта', () => {
  assert.ok(SCRIPT_TAB.includes('script-find'), 'нет поля поиска');
  assert.ok(SCRIPT_TAB.includes('const matches = useMemo'), 'совпадения не считаются');
  assert.ok(SCRIPT_TAB.includes('gotoMatch'), 'нет перехода по совпадениям с закольцовыванием');
  assert.ok(SCRIPT_TAB.includes("'Escape'"), 'Esc не очищает поиск');
  assert.ok(SCRIPT_TAB.includes('mhit') && SCRIPT_TAB.includes('mcur'), 'нет подсветки совпадений');
});

test('AnalysisTab: Esc закрывает панель паттерна', () => {
  const escBlock = ANALYSIS_TAB.slice(ANALYSIS_TAB.indexOf("e.key === 'Escape'") - 200);
  assert.ok(ANALYSIS_TAB.includes("e.key === 'Escape'"), 'нет обработки Escape');
  assert.ok(escBlock.includes('setOpenPattern(null)'), 'Escape не закрывает openPattern');
  assert.ok(ANALYSIS_TAB.includes('autoFocus'), 'кнопка «Закрыть» не получает фокус');
});

test('App: кнопка «Обновить» работает, а не мёртвый div', () => {
  // Кнопка ⟳ вызывает перезагрузку списка приложений.
  assert.ok(/<button[^>]*className="icon-btn"[^>]*>/.test(APP), '⟳ не кнопка');
  const btn = APP.slice(APP.indexOf('className="icon-btn"') - 200, APP.indexOf('className="icon-btn"') + 300);
  assert.ok(btn.includes('loadApps()'), '⟳ не перезагружает список приложений');
});

test('styles.css: варианты тоста и подсветка поиска на месте', () => {
  assert.ok(STYLES.includes('.toast.ok::before'), 'нет маркера успеха');
  assert.ok(STYLES.includes('.toast.err::before'), 'нет маркера ошибки');
  assert.ok(STYLES.includes('.lnfind'), 'нет тулбара поиска');
  assert.ok(STYLES.includes('.codeview .l.mhit') && STYLES.includes('.codeview .l.mcur'), 'нет стилей совпадений');
});

test('styles.css: тёмная тема — заливки через --solid, ссылки через --link', () => {
  // Регрессия 0.11.0: в dark --brand светлеет, и белые подписи на кнопках
  // и шапках таблиц давали контраст ≈2.1:1. Заливки держатся на --solid,
  // который в dark остаётся тёмным.
  assert.ok(STYLES.includes('--solid: var(--brand)'), 'нет --solid в :root');
  assert.ok(/--solid: #00873d/.test(STYLES), 'нет тёмного --solid в dark-медиа');
  assert.ok(!STYLES.includes('background: var(--navy);'), 'остались заливки var(--navy)');
  assert.ok(!STYLES.includes('#1d4ed8'), 'ссылки захардкожены мимо --link');
  assert.ok(STYLES.includes('--link: #7fb3ff'), 'нет светлого --link для dark');
});

test('styles.css: меню-сайдбар по образцу (рельса, группы, поиск)', () => {
  // 0.21.0: меню по образцу пользователя — шапка с брендом, поиск,
  // сворачиваемые группы, рельса 68px, подвал со статусом.
  assert.ok(/\.menu \{[^}]*--nav-w: 272px/s.test(STYLES), 'нет ширины меню');
  assert.ok(/\.menu\.is-collapsed \{ width: var\(--rail-w\)/.test(STYLES), 'нет рельсы');
  assert.ok(/\.nav-item \{[^}]*text-align: left/s.test(STYLES), 'пункты выровнены влево');
  assert.ok(/\.group\.is-closed \.group__list \{ display: none; \}/.test(STYLES), 'нет сворачивания групп');
  assert.ok(STYLES.includes('.menu__search'), 'нет поиска по разделам');
  assert.ok(STYLES.includes('.menu__foot'), 'нет подвала со статусом');
  assert.ok(/@media \(max-width: 900px\)/.test(STYLES), 'нет адаптации узкого окна');
  // Регрессия 0.20.1: без .row число и слово домена склеивались («44слабо»).
  assert.ok(/\.row \{[^}]*display: flex/s.test(STYLES), 'нет утилиты .row (склейка балла и вердикта)');
  for (const cls of ['.btn {', '.code {', '.num {', '.err {', '.ok {', '.checks {']) {
    assert.ok(STYLES.includes(cls), `нет класса ${cls}`);
  }
  // Имя приложения в шапке обрезается, а не растягивает хаб.
  assert.ok(/\.hub \.apppick \{[^}]*text-overflow: ellipsis/s.test(STYLES), 'apppick без ellipsis');
});

test('styles.css: колонка находок в «Скрипте загрузки» удвоена', () => {
  // Регрессия 0.18.8: при 320px текст находки сжимался до нечитаемости.
  assert.ok(/\.split2 \{[^}]*grid-template-columns: 640px minmax\(0, 1fr\)/s.test(STYLES),
    'колонка находок .split2 не 640px');
  assert.ok(!/grid-template-columns: 320px/.test(STYLES), 'осталась старая ширина 320px');
});

test('AnalysisTab: переключатель подавленных жив, мёртвый selected удалён', () => {
  assert.ok(ANALYSIS_TAB.includes('setShowSuppressed((v) => !v)'), 'нет переключателя подавленных');
  assert.ok(!ANALYSIS_TAB.includes('setSelected'), 'остался мёртвый selected');
  assert.ok(!ANALYSIS_TAB.includes('const [selected'), 'объявление selected не удалено');
});

test('RefactorTab: запрос ИИ со статусом, ошибкой в панели и подсветкой изменений', () => {
  // Регрессия 0.21.2: «Запросить ИИ» выглядел как «ничего не происходит» —
  // панель молчала до ответа, ошибка исчезала тостом, дифф не подсвечивался.
  assert.ok(REFACTOR_TAB.includes("role=\"status\""), 'нет видимого статуса запроса');
  assert.ok(REFACTOR_TAB.includes('role="alert"'), 'ошибка ИИ не показывается постоянно');
  assert.ok(REFACTOR_TAB.includes('aiAddedSet'), 'изменения ИИ-версии не подсвечиваются');
  assert.ok(REFACTOR_TAB.includes('Повторить'), 'нет повтора после ошибки');
  // Источник переключается только по факту ответа, тумблер блокируется до него.
  assert.ok(/setSource\('ai'\);\n        onNote/.test(REFACTOR_TAB), 'источник переключается до ответа');
  assert.ok(REFACTOR_TAB.includes("disabled={aiLoading || !aiResult?.ok}"), 'тумблер ИИ активен без ответа');
});

test('AiTab: дубль подписи «Конфиденциальность» убран, чекбоксы в ряду', () => {
  const count = (AI_TAB.match(/Конфиденциальность<\/td>/g) ?? []).length;
  assert.equal(count, 1, `ячейка «Конфиденциальность» встречается ${count} раз`);
  assert.ok(AI_TAB.includes('className="checks"'), 'чекбоксы не обёрнуты в .checks');
});

test('App: аватар удалён, платформа показывается из анализа', () => {
  assert.ok(!APP.includes('className="avatar"'), 'декоративный аватар остался');
  assert.ok(APP.includes('platformLabel'), 'платформа не выводится в шапке');
  assert.ok(TYPES.includes('platform?: string'), 'в AnalysisResult.summary нет поля platform');
});

test('RefactorTab: форматирование и синхронная прокрутка панелей', () => {
  assert.ok(REFACTOR_TAB.includes("formatScript(proposed)"), 'форматирование не подключено');
  assert.ok(REFACTOR_TAB.includes('setFormatOn'), 'нет тумблера формата');
  assert.ok(REFACTOR_TAB.includes('setSyncScroll'), 'нет тумблера прокрутки');
  assert.ok(REFACTOR_TAB.includes('syncFrom'), 'нет синхронной прокрутки');
  assert.ok(REFACTOR_TAB.includes('finalScript: shown'), 'экспортируется не показанная версия');
});

test('ScoreTab: аналитическая карточка по макету', () => {
  const SCORE_TAB = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'tabs', 'ScoreTab.tsx'), 'utf8');
  assert.ok(SCORE_TAB.includes('headline'), 'нет заголовка-вывода');
  assert.ok(SCORE_TAB.includes('scoretiles'), 'нет плиток находок');
  assert.ok(SCORE_TAB.includes('comp-track'), 'нет полосы-композиции');
  assert.ok(SCORE_TAB.includes('domainDiag'), 'нет диагнозов доменов');
  assert.ok(SCORE_TAB.includes('балл срезан'), 'нет диагноза «срезан проверками»');
  assert.ok(SCORE_TAB.includes('planbox'), 'нет агрегированного плана');
  assert.ok(SCORE_TAB.includes('tailcard'), 'нет блока «вне топ-5»');
  assert.ok(SCORE_TAB.includes('задачи перезагрузки'), 'нет футера-предупреждения');
  assert.ok(!SCORE_TAB.includes('scorehero-counts'), 'старые счётчики не убраны');
});

test('ScoreTab: обращения до раннего выхода — optional chaining (null-анализ не падает)', () => {
  // Регрессия 0.22.1: клик «Оценка» до анализа делал пустое окно —
  // analysis.ruleStats читался до проверки if (!analysis).
  const SCORE_TAB = readFileSync(resolve(HERE, '..', 'desktop', 'src', 'tabs', 'ScoreTab.tsx'), 'utf8');
  assert.ok(SCORE_TAB.includes('| null)?.ruleStats ?? []'), 'ruleStats читается без защиты от null');
  assert.ok(SCORE_TAB.includes('summary?.findings?.bySeverity'), 'bySeverity без второй optional-цепочки');
});
