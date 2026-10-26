/**
 * Тесты этапа 1: вкладка «Подключение».
 *
 * Проверяются: пошаговый сценарий (состояние шагов), список приложений
 * с поиском и фильтрами (поток/владелец), мультивыбор для пакетного
 * анализа и компактный чек-лист проверок подключения без дублей.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appMeta, listApps } from '../src/extract/session.js';
import { analyzeAll } from '../src/batch.js';
import { pushStep, runDoctor } from '../src/cli/doctor.js';

test('поток и владелец извлекаются из ответа сервера', () => {
  const meta = appMeta({ qStream: 'Продажи', qOwner: 'Иванова' });
  assert.equal(meta.stream, 'Продажи');
  assert.equal(meta.owner, 'Иванова');
});

test('поток и владелец: сервер не отдал — значения пустые', () => {
  const meta = appMeta({ qDocId: 'app-1' });
  assert.equal(meta.stream, null);
  assert.equal(meta.owner, null);
});

test('список приложений содержит поток и владельца', async () => {
  const apps = await listApps({
    getDocList: async () => ([
      { qDocId: 'app-1', qTitle: 'Продажи', qFileSize: 100, qStream: 'Retail', qOwner: 'Иванова' },
      { qDocId: 'app-2', qTitle: 'Склад', qFileSize: 200 },
    ]),
  });
  assert.equal(apps.length, 2);
  assert.equal(apps[0].stream, 'Retail');
  assert.equal(apps[0].owner, 'Иванова');
  assert.equal(apps[1].stream, null);
});

/** Мок движка QlikView Doc API для пакетного анализа. */
function fakeQix() {
  const apps = [
    { id: 'app-1', title: 'Продажи' },
    { id: 'app-2', title: 'Склад' },
    { id: 'app-3', title: 'Кадры' },
  ];
  return {
    getDocList: async () => apps.map((a) => ({ qDocId: a.id, qTitle: a.title, qFileSize: 100 })),
    openDoc: async (id) => {
      const app = apps.find((a) => a.id === id);
      return {
        getAppLayout: async () => ({ qTitle: app.title, qFileName: app.id }),
        getAppProperties: async () => ({ qTitle: app.title, qThumbnail: {} }),
        getScript: async () => `// ${app.title}\nLOAD\n  ID\nFROM 'c.csv';\n`,
        getTablesAndKeys: async () => ({
          qtr: [{
            qName: 'Customers',
            qNoOfRows: 10,
            qFields: [{ qName: 'ID', qnRows: 10, qnNonNulls: 10, qnTotalDistinctValues: 10, qKeyType: 'KEY' }],
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

test('мультивыбор: пакетный анализ идёт только по выбранным приложениям', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'qa-batch-sel-'));
  const { results } = await analyzeAll({
    qix: fakeQix(),
    session: { close: async () => {} },
    url: 'wss://host/app/app-1',
    platform: 'qlikview',
    pauseMs: 0,
    cacheDir,
    appIds: ['app-1', 'app-3'],
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.appId).sort(), ['app-1', 'app-3']);
});

test('чек-лист проверок: шаг с тем же именем не дублируется', () => {
  const steps = [];
  pushStep(steps, { name: 'Проверка порта (HTTP)', status: 'WARN', detail: 'нет ответа' });
  pushStep(steps, { name: 'Проверка порта (HTTP)', status: 'FAIL', detail: 'порт молчит' });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'FAIL');
  assert.equal(steps[0].index, 0);
});

test('чек-лист проверок: у каждого шага свой индекс', () => {
  const steps = [];
  pushStep(steps, { name: 'URL', status: 'OK', detail: 'wss://host/app' });
  pushStep(steps, { name: 'TCP-соединение', status: 'OK', detail: 'порт доступен' });
  pushStep(steps, { name: 'Модель данных', status: 'WARN', detail: '0 таблиц' });
  assert.deepEqual(steps.map((s) => s.index), [0, 1, 2]);
  assert.equal(new Set(steps.map((s) => s.name)).size, 3);
});

test('диагностика без URL даёт один понятный шаг', async () => {
  const { steps, failed } = await runDoctor({ url: '' });
  assert.equal(failed, true);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'FAIL');
  assert.match(steps[0].hint, /--url|--host/);
});

test('диагностика: без сессии хаба подсказывает «Войти в хаб»', async () => {
  const { steps } = await runDoctor({ url: 'wss://localhost:1/app' });
  const session = steps.find((s) => s.name === 'Сессия хаба');
  assert.ok(session, 'есть отдельный шаг про сессию хаба');
  assert.equal(session.status, 'WARN');
  assert.match(session.hint, /Войти в хаб/);
});

test('диагностика: подсказка про 403 говорит про вход в хаб', async () => {
  const { hintFor } = await import('../src/cli/doctor.js');
  const hint = hintFor('Unexpected server response: 403');
  assert.match(hint, /Войти в хаб/);
  assert.match(hint, /CSRF/);
});
