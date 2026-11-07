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
  assert.ok(APP.includes('const TAB_ORDER: Tab[]'), 'нет константы TAB_ORDER');
  assert.ok(APP.includes("addEventListener('keydown', onKey)"), 'нет keydown-обработчика');
  // По e.code — работает в любой раскладке.
  assert.ok(APP.includes('/^Digit([1-9])$/.exec(e.code)'), 'вкладки переключаются не по e.code');
  assert.ok(APP.includes("e.code === 'KeyF'"), 'Ctrl+F не по e.code');
  assert.ok(APP.includes("'script-find'"), 'Ctrl+F не ищет поле поиска');
  // Подсказка с номером на кнопках вкладок.
  assert.ok(APP.includes('Ctrl+${i + 1}'), 'на вкладках нет подсказки горячих клавиш');
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
