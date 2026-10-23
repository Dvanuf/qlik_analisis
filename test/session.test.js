import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listApps } from '../src/extract/session.js';

/**
 * Список приложений: метод зависит от платформы.
 *  - Qlik Sense (QIX Engine API) — GetAppList, поле qAppId;
 *  - QlikView 12 (Doc API)       — GetDocList, поле qDocId.
 * На «чужой» метод сервер отвечает ошибкой «Method not found» — это не сбой,
 * а признак другой платформы, поэтому метод подбирается перебором.
 */

test('listApps: Qlik Sense — GetAppList, идентификатор из qAppId', async () => {
  const qix = {
    getAppList: async () => [{
      qAppId: 'app-1', qTitle: 'Продажи', qFileSize: 1024, qLastReloadTime: '2026-01-01',
    }],
    getDocList: async () => { throw new Error('Method not found'); },
  };
  const apps = await listApps(qix);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'app-1');
  assert.equal(apps[0].title, 'Продажи');
  assert.equal(apps[0].size, 1024);
  assert.equal(apps[0].lastReload, '2026-01-01');
});

test('listApps: QlikView — GetDocList, идентификатор из qDocId', async () => {
  const qix = {
    getAppList: async () => { throw new Error('Method not found'); },
    getDocList: async () => [{ qDocId: 'doc-1', qTitle: 'Продажи', qFileSize: 2048 }],
  };
  const apps = await listApps(qix);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'doc-1');
  assert.equal(apps[0].title, 'Продажи');
  assert.equal(apps[0].size, 2048);
});

test('listApps: ответ «Method not found» не считается ошибкой', async () => {
  const qix = {
    getAppList: async () => [{ qAppId: 'a' }],
    getDocList: async () => { throw new Error('Method not found'); },
  };
  const apps = await listApps(qix);
  assert.equal(apps[0].id, 'a');
});

test('listApps: пустой список приложений — не ошибка', async () => {
  const qix = { getAppList: async () => [] };
  const apps = await listApps(qix);
  assert.deepEqual(apps, []);
});

test('listApps: сервер не поддерживает ни один метод — возвращается ошибка', async () => {
  const qix = {
    getAppList: async () => { throw new Error('Method not found'); },
    getDocList: async () => { throw new Error('Method not found'); },
  };
  await assert.rejects(() => listApps(qix), /Method not found/);
});
