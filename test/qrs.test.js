/**
 * QRS — сервис репозитория Qlik Sense Enterprise.
 *
 * Проверяется то, что можно проверить без сертификата: разбор ответов,
 * построение адреса, понятные ошибки при отсутствии сертификата.
 * Обращение к живому репозиторию требует клиентского сертификата.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  qrsBase, parseQrsApps, readQrsCertificate, fetchQrsApps, fetchQrsVersion,
  qrsCertAdvice, QRS_PORT, QRS_APP_PATHS,
} from '../src/extract/qrs.js';
import { resolveQrs } from '../src/config.js';

test('адрес QRS: хост и порт по умолчанию', () => {
  assert.equal(qrsBase({ host: 'qlik.local' }), `https://qlik.local:${QRS_PORT}`);
  assert.equal(qrsBase({ host: 'qlik.local', port: 4243 }), 'https://qlik.local:4243');
  assert.equal(qrsBase({}), null);
  assert.equal(qrsBase({ host: '  ' }), null);
});

test('разбор ответа: массив приложений', () => {
  const apps = parseQrsApps([
    {
      id: 'app-1',
      name: 'Отчёт CEO',
      owner: 'Ануфриев Дмитрий',
      stream: 'CEO',
      tags: ['report:qs-cm-06'],
      fileSize: 1234,
      published: false,
    },
  ]);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'app-1');
  assert.equal(apps[0].title, 'Отчёт CEO');
  assert.equal(apps[0].owner, 'Ануфриев Дмитрий');
  assert.equal(apps[0].stream, 'CEO');
  assert.deepEqual(apps[0].tags, ['report:qs-cm-06']);
  assert.equal(apps[0].published, false);
  assert.equal(apps[0].source, 'qrs');
});

test('разбор ответа: JSON:API с data и attributes', () => {
  const apps = parseQrsApps({
    data: [{
      id: 'app-2',
      attributes: {
        title: 'Продажи',
        owner: 'sa_repository',
        group: 'Розница',
        customProperties: [{ value: 'etl', definition: { name: 'Consumer' } }],
      },
    }],
  });
  assert.equal(apps.length, 1);
  assert.equal(apps[0].title, 'Продажи');
  assert.equal(apps[0].stream, 'Розница');
  assert.deepEqual(apps[0].tags, ['Consumer:etl']);
});

test('разбор ответа: пусто и мусор', () => {
  assert.deepEqual(parseQrsApps(null), []);
  assert.deepEqual(parseQrsApps({}), []);
  assert.deepEqual(parseQrsApps({ data: 'не массив' }), []);
  assert.deepEqual(parseQrsApps([{ }]), []);
});

test('сертификат: без пути и с несуществующим файлом', () => {
  assert.match(readQrsCertificate({}).note, /не задан/);
  assert.match(readQrsCertificate({ certPath: '/нет/такого.pfx' }).note, /не найден/);
});

test('сертификат: файл читается, пароль передаётся', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-qrs-'));
  const file = join(dir, 'client.pfx');
  writeFileSync(file, Buffer.from('fake-pfx'));
  const cert = readQrsCertificate({ certPath: file, certPassword: 'секрет' });
  assert.ok(cert.pfx);
  assert.equal(cert.passphrase, 'секрет');
  assert.equal(cert.note, undefined);
});

test('список приложений: без сертификата — понятная ошибка', async () => {
  const res = await fetchQrsApps({ host: 'qlik.local' });
  assert.equal(res.ok, false);
  assert.match(res.note, /сертификат/);
});

test('версия QRS: без сертификата — понятная ошибка', async () => {
  const res = await fetchQrsVersion({ host: 'qlik.local' });
  assert.equal(res.ok, false);
  assert.match(res.note, /сертификат/);
});

test('совет по отказу 403: без сертификата и с отклонённым', () => {
  assert.match(qrsCertAdvice('HTTP 403 No client certificate supplied'), /Нужен клиентский сертификат/);
  assert.match(qrsCertAdvice('HTTP 403 Client certificate invalid: '), /отклонён сервером/);
  assert.match(qrsCertAdvice('HTTP 403 Forbidden: '), /Нужен клиентский сертификат/);
});

test('адреса списка приложений перебираются', () => {
  assert.ok(QRS_APP_PATHS.length >= 2);
  assert.ok(QRS_APP_PATHS.every((p) => p.startsWith('/qrs/')));
});

test('настройки QRS: приоритет CLI > окружение > файл', () => {
  const fromFile = resolveQrs({}, { qrs: { host: 'file.local', port: 4242, enabled: true } });
  assert.equal(fromFile.host, 'file.local');
  assert.equal(fromFile.enabled, true);
  assert.equal(fromFile.certPasswordEnv, 'QLIK_QRS_CERT_PASSWORD');

  const fromCli = resolveQrs({ qrsHost: 'cli.local', qrsPort: 4443 }, { qrs: { host: 'file.local' } });
  assert.equal(fromCli.host, 'cli.local');
  assert.equal(fromCli.port, 4443);
});

test('настройки QRS: по умолчанию выключены', () => {
  const cfg = resolveQrs({}, {});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.host, '');
  assert.equal(cfg.port, 4242);
});
test('сертификат в формате PEM: ключ берётся отдельным файлом', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-qrs-'));
  const certFile = join(dir, 'client.crt');
  const keyFile = join(dir, 'client.key');
  writeFileSync(certFile, '-----BEGIN CERTIFICATE-----');
  writeFileSync(keyFile, '-----BEGIN PRIVATE KEY-----');
  const cert = readQrsCertificate({ certPath: certFile });
  assert.ok(cert.cert);
  assert.ok(cert.key);
  assert.equal(cert.pfx, undefined);
  assert.equal(cert.note, undefined);
});

test('сертификат в формате PEM: ключ ищется по имени файла', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-qrs-'));
  const certFile = join(dir, 'client.crt');
  writeFileSync(certFile, '-----BEGIN CERTIFICATE-----');
  writeFileSync(join(dir, 'client.key'), '-----BEGIN PRIVATE KEY-----');
  const cert = readQrsCertificate({ certPath: certFile });
  assert.ok(cert.key);
  assert.equal(cert.note, undefined);
});

test('сертификат в формате PEM: без ключа — понятная ошибка', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-qrs-'));
  const certFile = join(dir, 'client.crt');
  writeFileSync(certFile, '-----BEGIN CERTIFICATE-----');
  const cert = readQrsCertificate({ certPath: certFile });
  assert.match(cert.note, /не найден ключ/);
});

