import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAll, totalsOf } from '../src/batch.js';

/** Мок движка QlikView Doc API: три приложения, одно с ошибкой. */
function fakeQix() {
  const apps = [
    { id: 'app-1', title: 'Продажи', size: 1000, lastReload: '2026-10-01T00:00:00Z' },
    { id: 'app-2', title: 'Склад', size: 2000, lastReload: '2026-10-02T00:00:00Z' },
    { id: 'app-3', title: 'Сломанное', size: 3000, lastReload: '2026-10-03T00:00:00Z' },
  ];
  return {
    getDocList: async () => apps.map((a) => ({
      qDocId: a.id, qTitle: a.title, qFileSize: a.size, qLastReloadTime: a.lastReload,
    })),
    openDoc: async (id) => {
      if (id === 'app-3') throw new Error('документ недоступен');
      const app = apps.find((a) => a.id === id);
      return {
        getAppLayout: async () => ({ qTitle: app.title, qFileName: app.id, qLastReloadTime: app.lastReload }),
        getAppProperties: async () => ({ qTitle: app.title, qSavedInProductVersion: '12.2561.12', qThumbnail: {} }),
        getScript: async () => `// ${app.title}\nCustomers:\nLOAD\n  ID,\n  Name\nFROM 'c.csv';\n`,
        getTablesAndKeys: async () => ({
          qtr: [{
            qName: 'Customers',
            qNoOfRows: 100,
            qFields: [
              { qName: 'ID', qnRows: 100, qnNonNulls: 100, qnTotalDistinctValues: 100, qSubsetRatio: 1, qKeyType: 'KEY', qTags: ['$numeric'] },
              { qName: 'Name', qnRows: 100, qnNonNulls: 100, qnTotalDistinctValues: 90, qSubsetRatio: 1, qKeyType: 'NOT_KEY', qTags: ['$text'] },
            ],
          }],
          qk: [{ qTables: ['Customers'], qKeyFields: ['ID'] }],
        }),
        getAssociationScores: async () => [],
        getObjects: async () => [],
        getTextMacros: async () => [],
      };
    },
  };
}

test('пакетный анализ обходит все приложения и считает сводку', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'qa-batch-'));
  const progress = [];
  const { results, totals } = await analyzeAll({
    qix: fakeQix(),
    session: { close: async () => {} },
    url: 'wss://host/app/app-1',
    platform: 'qlikview',
    pauseMs: 0,
    cacheDir,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(results.length, 3);
  assert.equal(totals.apps, 3);
  assert.equal(totals.errors, 1);
  assert.ok(totals.findings > 0);
  assert.ok(progress.some((p) => p.phase === 'error' && p.appId === 'app-3'));
  assert.ok(progress.some((p) => p.phase === 'done' && p.appId === 'app-1'));
});

test('повторный прогон берёт результат из кэша', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'qa-batch-'));
  const first = await analyzeAll({
    qix: fakeQix(),
    session: { close: async () => {} },
    url: 'wss://host/app/app-1',
    pauseMs: 0,
    cacheDir,
  });
  assert.equal(first.results.find((r) => r.appId === 'app-1').fromCache, false);

  const second = await analyzeAll({
    qix: fakeQix(),
    session: { close: async () => {} },
    url: 'wss://host/app/app-1',
    pauseMs: 0,
    cacheDir,
  });
  assert.equal(second.results.find((r) => r.appId === 'app-1').fromCache, true);
});

test('totalsOf считает сводку по результатам', () => {
  const totals = totalsOf([
    { summary: { findings: { total: 3, byCategory: { Script: 3 }, bySeverity: { warning: 3 } }, savings: { removableRows: 10, removableFields: 1 } } },
    { summary: { findings: { total: 2, byCategory: { Resources: 2 }, bySeverity: { error: 2 } }, savings: { removableRows: 5, removableFields: 2 } } },
    { error: 'boom', summary: null, findings: [] },
  ]);
  assert.equal(totals.findings, 5);
  assert.equal(totals.byCategory.Script, 3);
  assert.equal(totals.bySeverity.error, 2);
  assert.equal(totals.removableRows, 15);
  assert.equal(totals.errors, 1);
});
