/**
 * Проверка пакетного режима и сводного отчёта на моке движка.
 * Запуск: node scripts/check-batch.mjs
 */
import { writeFileSync } from 'node:fs';
import { analyzeAll } from '../src/batch.js';
import { renderSummaryHtml } from '../src/report/summary.js';

const qix = {
  getDocList: async () => [
    { qDocId: 'a1', qTitle: 'Пример приложения', qFileSize: 251658240, qLastReloadTime: '2026-10-20T10:00:00Z' },
    { qDocId: 'a2', qTitle: 'Второе приложение', qFileSize: 10485760, qLastReloadTime: '2026-10-21T10:00:00Z' },
    { qDocId: 'a3', qTitle: 'Недоступное приложение', qFileSize: 100, qLastReloadTime: null },
  ],
  openDoc: async (id) => {
    if (id === 'a3') throw new Error('документ недоступен');
    return {
      getAppLayout: async () => ({ qTitle: 'X', qLastReloadTime: '2026-10-20T10:00:00Z' }),
      getAppProperties: async () => ({ qTitle: 'X', qSavedInProductVersion: '12.2561.12', qThumbnail: {} }),
      getScript: async () => "Customers:\nLOAD\n  ID,\n  Name\nFROM 'c.csv';\n",
      getTablesAndKeys: async () => ({
        qtr: [{
          qName: 'Customers',
          qNoOfRows: 100,
          qFields: [{
            qName: 'ID', qnRows: 100, qnNonNulls: 100, qnTotalDistinctValues: 100,
            qSubsetRatio: 1, qKeyType: 'KEY', qTags: ['$numeric'],
          }],
        }],
        qk: [{ qTables: ['Customers'], qKeyFields: ['ID'] }],
      }),
      getAssociationScores: async () => [],
      getObjects: async () => [],
      getTextMacros: async () => [],
    };
  },
};

const { results, totals } = await analyzeAll({
  qix,
  session: { close: async () => {} },
  url: 'wss://h/app/a1',
  platform: 'qlikview',
  pauseMs: 0,
  cacheDir: '/tmp/qa-batch-check',
  onProgress: (p) => {
    if (p.phase === 'done') console.log(`  готово: ${p.title} — ${p.findings} находок`);
    if (p.phase === 'error') console.log(`  ошибка: ${p.title} — ${p.error}`);
  },
});

console.log(`\nприложений: ${totals.apps} | находок: ${totals.findings} | с ошибкой: ${totals.errors}`);
console.log('категории:', JSON.stringify(totals.byCategory));
console.log('уровни:', JSON.stringify(totals.bySeverity));
console.log('строк можно убрать:', totals.removableRows);

const html = renderSummaryHtml({ results, totals, platform: 'qlikview' });
writeFileSync('/tmp/qa-summary-check.html', html, 'utf8');
console.log(`сводный HTML: ${html.length} байт -> /tmp/qa-summary-check.html`);
