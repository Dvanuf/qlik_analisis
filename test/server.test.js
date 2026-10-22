import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue } from '../server/src/queue.js';
import { ReportStore } from '../server/src/store.js';
import { authenticate } from '../server/src/auth.js';
import { resolveServerConfig } from '../server/src/config.js';

// --- очередь задач ---

test('очередь выполняет задачи последовательно и хранит результат', async () => {
  const order = [];
  const q = new JobQueue({
    concurrency: 1,
    runner: async (type, payload) => {
      order.push(payload.n);
      await new Promise((r) => setTimeout(r, 10));
      return { doubled: payload.n * 2 };
    },
  });

  const a = q.enqueue('test', { n: 1 });
  const b = q.enqueue('test', { n: 2 });
  assert.equal(a.status, 'queued');
  assert.equal(b.status, 'queued');

  await new Promise((resolve) => {
    const check = () => {
      if (q.get(b.id)?.status === 'done') resolve();
      else setTimeout(check, 10);
    };
    check();
  });

  assert.deepEqual(order, [1, 2], 'задачи должны выполняться по порядку');
  assert.equal(q.get(a.id).result.doubled, 2);
  assert.equal(q.get(b.id).result.doubled, 4);
});

test('очередь пробрасывает прогресс и ctx', async () => {
  const seen = [];
  const q = new JobQueue({
    runner: async (type, payload, ctx) => {
      seen.push({ jobId: ctx.jobId, requestedBy: ctx.requestedBy });
      ctx.onProgress({ phase: 'start', index: 3, total: 10 });
      return 'ok';
    },
  });
  const job = q.enqueue('test', {}, 'ivan');
  await new Promise((resolve) => {
    const check = () => {
      if (q.get(job.id)?.status === 'done') resolve();
      else setTimeout(check, 10);
    };
    check();
  });
  assert.equal(seen[0].jobId, job.id);
  assert.equal(seen[0].requestedBy, 'ivan');
  assert.equal(q.get(job.id).progress.index, 3);
  assert.equal(q.get(job.id).progress.total, 10);
});

test('отмена задачи в очереди снимает её без выполнения', async () => {
  let ran = false;
  const q = new JobQueue({
    runner: async () => { ran = true; },
  });
  const job = q.enqueue('test', {});
  assert.equal(q.cancel(job.id), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran, false);
  assert.equal(q.get(job.id).status, 'canceled');
});

test('ошибка в задаче не роняет очередь', async () => {
  const q = new JobQueue({
    runner: async (type) => {
      if (type === 'bad') throw new Error('сломалось');
      return 'ok';
    },
  });
  const bad = q.enqueue('bad', {});
  const good = q.enqueue('good', {});
  await new Promise((resolve) => {
    const check = () => {
      if (q.get(good.id)?.status === 'done') resolve();
      else setTimeout(check, 10);
    };
    check();
  });
  assert.equal(q.get(bad.id).status, 'failed');
  assert.match(q.get(bad.id).error, /сломалось/);
  assert.equal(q.get(good.id).status, 'done');
});

// --- хранилище отчётов ---

test('хранилище сохраняет, читает и удаляет отчёты', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-store-'));
  const store = new ReportStore(dir);

  assert.deepEqual(store.list(), []);
  const entry = store.save('job-1', {
    type: 'analyze',
    title: 'Тестовое приложение',
    html: '<html>ok</html>',
    json: { summary: { findings: { total: 3 } } },
    requestedBy: 'ivan',
  });

  assert.equal(store.list().length, 1);
  assert.equal(entry.title, 'Тестовое приложение');
  assert.equal(store.get('job-1').requestedBy, 'ivan');
  assert.equal(store.stats().reports, 1);

  // Повторное сохранение с тем же id не дублирует запись
  store.save('job-1', {
    type: 'analyze', title: 'Ещё раз', html: '<html>2</html>', json: {},
  });
  assert.equal(store.list().length, 1);

  assert.equal(store.remove('job-1'), true);
  assert.equal(store.list().length, 0);
  assert.equal(store.remove('job-1'), false);
});

test('хранилище чистит старые отчёты', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-store-'));
  const store = new ReportStore(dir);
  store.save('old-job', {
    type: 'analyze', title: 'Старый', html: '<html></html>', json: {},
  });
  // Имитируем старый отчёт: правим индекс вручную.
  const indexPath = join(dir, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index[0].createdAt = new Date(Date.now() - 60 * 86400000).toISOString();
  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  const result = store.prune(30);
  assert.equal(result.removed, 1);
  assert.equal(store.list().length, 0);
});

// --- аутентификация ---

test('аутентификация: режим none пускает всех', () => {
  const cfg = resolveServerConfig({}).auth;
  const res = authenticate(cfg, { headers: {} });
  assert.equal(res.ok, true);
  assert.equal(res.role, 'admin');
});

test('аутентификация: basic проверяет пароль', () => {
  process.env.QLIK_TEST_PW = 'secret123';
  const cfg = resolveServerConfig({
    auth: {
      mode: 'basic',
      users: [{ login: 'ivan', passwordEnv: 'QLIK_TEST_PW', role: 'analyst' }],
    },
  }).auth;

  const good = Buffer.from('ivan:secret123').toString('base64');
  const ok = authenticate(cfg, { headers: { authorization: `Basic ${good}` } });
  assert.equal(ok.ok, true);
  assert.equal(ok.user, 'ivan');
  assert.equal(ok.role, 'analyst');

  const bad = Buffer.from('ivan:wrong').toString('base64');
  const fail = authenticate(cfg, { headers: { authorization: `Basic ${bad}` } });
  assert.equal(fail.ok, false);

  const none = authenticate(cfg, { headers: {} });
  assert.equal(none.ok, false);
  assert.equal(none.challenge, true);
});

test('аутентификация: proxy читает логин из заголовка и проверяет домен', () => {
  const cfg = resolveServerConfig({
    auth: {
      mode: 'proxy',
      userHeader: 'X-Forwarded-User',
      allowedDomains: ['corp'],
      users: [{ login: 'CORP\\ivan', role: 'analyst' }],
    },
  }).auth;

  const ok = authenticate(cfg, { headers: { 'x-forwarded-user': 'CORP\\ivan' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.role, 'analyst');

  const other = authenticate(cfg, { headers: { 'x-forwarded-user': 'OTHER\\petr' } });
  assert.equal(other.ok, false);

  const missing = authenticate(cfg, { headers: {} });
  assert.equal(missing.ok, false);
});

// --- конфигурация ---

test('конфигурация сервера: значения по умолчанию и приоритет', () => {
  const cfg = resolveServerConfig({});
  assert.equal(cfg.server.port, 8080);
  assert.equal(cfg.server.concurrency, 1);
  assert.equal(cfg.auth.mode, 'none');
  assert.equal(cfg.qlik.platform, 'qlikview');

  const custom = resolveServerConfig({
    server: { port: 9000, concurrency: 2 },
    auth: { mode: 'basic' },
    qlik: { platform: 'qlik-sense' },
  });
  assert.equal(custom.server.port, 9000);
  assert.equal(custom.server.concurrency, 2);
  assert.equal(custom.auth.mode, 'basic');
  assert.equal(custom.qlik.platform, 'qlik-sense');
});
