/**
 * Предлагаемые правки скрипта в виде «было / стало».
 *
 * Реализация переехала в src/script/refactor.js — единый источник правок
 * для интерфейса, отчётов и сборки предложенной версии скрипта. Здесь
 * остаётся фасад: прежние импорты (рендерер, тесты) продолжают работать.
 */
export {
  isCodeLine,
  lastCodeLine,
  ident,
  findLoadLine,
  collectEdits,
  buildFixes,
  changeId,
  buildRefactoredScript,
  buildScriptPatch,
  applyPatchToScript,
} from '../script/refactor.js';
