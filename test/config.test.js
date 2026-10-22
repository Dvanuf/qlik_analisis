import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, resolveRules, resolvePaths, loadDotEnv, maskSecret } from '../src/config.js';

const CONFIG = {
  environments: {
    'qs-prod': {
      type: 'qlik-sense',
      host: 'qlik.corp.local',
      port: 4747,
      user: 'CORP\\ro',
      passwordEnv: 'QLIK_QS_PASSWORD',
      insecure: true,
    },
  },
  apps: {
    sales: { env: 'qs-prod', appId: 'app-123' },
  },
  paths: { out: 'reports/{env}/{app}/report.html' },
  rules: { disabled: ['P010'], maxExpressionLength: 150 },
};

test('URL собирается из host/port/appId окружения и приложения', () => {
  const t = resolveTarget({ env: 'qs-prod', app: 'sales' }, CONFIG);
  assert.equal(t.url, 'ws://qlik.corp.local:4747/app/app-123');
  assert.equal(t.type, 'qlik-sense');
  assert.equal(t.insecure, true);
});

test('порт 4746 даёт схему wss, 4747 — ws', () => {
  const cfg = {
    environments: {
      a: { type: 'qlik-sense', host: 'h', port: 4747, appId: 'x' },
      b: { type: 'qlik-sense', host: 'h', port: 4746, appId: 'x' },
      c: { type: 'qlik-sense', host: 'h', port: 4746, appId: 'x', scheme: 'ws' },
    },
  };
  assert.equal(resolveTarget({ env: 'a' }, cfg).url, 'ws://h:4747/app/x');
  assert.equal(resolveTarget({ env: 'b' }, cfg).url, 'wss://h:4746/app/x');
  assert.equal(resolveTarget({ env: 'c' }, cfg).url, 'ws://h:4746/app/x');
});

test('зондирование порта отличает HTTP-ответ от TLS-рассогласования', async () => {
  const http = await import('node:http');
  const { probePort } = await import('../src/cli/doctor.js');
  const server = http.createServer((req, res) => { res.statusCode = 401; res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const plain = await probePort('127.0.0.1', port, false);
  assert.equal(plain.ok, true);
  assert.equal(plain.status, 401);

  // Запрос по https к http-порту = рассогласование схемы
  const tls = await probePort('127.0.0.1', port, true);
  assert.equal(tls.ok, false);
  assert.ok(tls.reason.length > 0);

  server.close();
});

test('пароль берётся из переменной окружения, указанной в конфиге', () => {
  process.env.QLIK_QS_PASSWORD = 'secret-value';
  const t = resolveTarget({ env: 'qs-prod', app: 'sales' }, CONFIG);
  assert.equal(t.password, 'secret-value');
  assert.equal(t.passwordEnv, 'QLIK_QS_PASSWORD');
  delete process.env.QLIK_QS_PASSWORD;
});

test('CLI-флаг приоритетнее конфигурации', () => {
  const t = resolveTarget({ env: 'qs-prod', app: 'sales', url: 'ws://other:1234/app/xyz' }, CONFIG);
  assert.equal(t.url, 'ws://other:1234/app/xyz');
});

test('X-Qlik-User по умолчанию равен пользователю', () => {
  const t = resolveTarget({ env: 'qs-prod', app: 'sales' }, CONFIG);
  assert.equal(t.qlikUser, 'CORP\\ro');
});

test('файловый режим определяется по --script/--qvs/--qvw', () => {
  assert.equal(resolveTarget({ script: 'a.qvs' }, CONFIG).fileType, 'script');
  assert.equal(resolveTarget({ qvs: 'a.qvs' }, CONFIG).fileType, 'qvs');
  assert.equal(resolveTarget({ qvw: 'a.qvw' }, CONFIG).fileType, 'qvw');
});

test('правила берутся из конфига и перекрываются флагами', () => {
  const r = resolveRules({}, CONFIG);
  assert.deepEqual(r.disabledRules, ['P010']);
  assert.equal(r.maxExpressionLength, 150);
  const r2 = resolveRules({ disable: ['R001'], maxExpressionLength: 300 }, CONFIG);
  assert.deepEqual(r2.disabledRules, ['R001']);
  assert.equal(r2.maxExpressionLength, 300);
});

test('пути подставляют {env} и {app}', () => {
  const t = resolveTarget({ env: 'qs-prod', app: 'sales' }, CONFIG);
  const p = resolvePaths({}, CONFIG, t);
  assert.equal(p.out, 'reports/qs-prod/sales/report.html');
});

test('.env подхватывается, но не переопределяет заданное', () => {
  const prev = process.env.QLIK_ANALYZER_TEST_VAR;
  delete process.env.QLIK_ANALYZER_TEST_VAR;
  loadDotEnv('test/fixtures/.env.test');
  assert.equal(process.env.QLIK_ANALYZER_TEST_VAR, 'from-file');
  process.env.QLIK_ANALYZER_TEST_VAR = 'preset';
  loadDotEnv('test/fixtures/.env.test');
  assert.equal(process.env.QLIK_ANALYZER_TEST_VAR, 'preset');
  if (prev === undefined) delete process.env.QLIK_ANALYZER_TEST_VAR;
  else process.env.QLIK_ANALYZER_TEST_VAR = prev;
});

test('doctor отдаёт шаги постепенно и не зависает на молчащем сервере', async () => {
  const net = await import('node:net');
  const { runDoctor } = await import('../src/cli/doctor.js');

  // «Чёрная дыра»: порт принимает соединение, но никогда не отвечает.
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const seen = [];
  const result = await runDoctor(
    { url: `ws://127.0.0.1:${port}/app/test` },
    (step) => seen.push(step),
    1500,
  );

  assert.ok(seen.length >= 2, 'шаги приходят по мере появления');
  assert.equal(result.failed, true);
  const last = result.steps[result.steps.length - 1];
  assert.equal(last.status, 'FAIL');
  assert.match(last.detail + (last.hint ?? ''), /ожидания|время|таймаут|не отвечает/i);

  // Освобождаем сокеты, иначе сервер не завершится и тест зависнет.
  for (const s of sockets) s.destroy();
  server.close();
  server.unref();
});

test('секреты маскируются', () => {
  assert.equal(maskSecret('short'), '***');
  assert.ok(maskSecret('verysecretvalue').includes('…'));
});
