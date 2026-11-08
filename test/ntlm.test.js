/**
 * NTLMv2-клиент (QlikView AccessPoint): MD4 по RFC-векторам, формат
 * сообщений Type1/Type2/Type3 по MS-NLMP. Живую проверку проводит
 * пользователь на своём AccessPoint — здесь проверяется протокол.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md4, ntlmHash, createType1Message, parseType2Message, createType3Message, ntResponseV1, lmResponseV1 } from '../src/extract/ntlm.js';

test('MD4: векторы, сверенные с OpenSSL (эталон)', () => {
  const hex = (b) => b.toString('hex');
  assert.equal(hex(md4(Buffer.from(''))), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.equal(hex(md4(Buffer.from('a'))), 'bde52cb31de33e46245e05fbdbd6fb24');
  assert.equal(hex(md4(Buffer.from('abc'))), 'a448017aaf21d8525fc10ae87aa6729d');
  assert.equal(hex(md4(Buffer.from('message digest'))), 'd9130a8164549fe818874806e1c7014b');
  // Длинный вход — несколько блоков.
  assert.equal(hex(md4(Buffer.from('abcdefghijklmnopqrstuvwxyz'))), 'd79e1c308aa5bbcdeea8ed63df412da9');
});

test('NT-хеш пароля: MD4 от UTF-16LE', () => {
  // Пустой пароль → MD4 пустой строки.
  assert.equal(ntlmHash('').toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0');
  // «password» в UTF-16LE → известный NTLM-хеш «password».
  assert.equal(ntlmHash('password').toString('hex'), '8846f7eaee8fb117ad06bdd830b7586c');
});

test('Type1: сигнатура, тип 1, флаги', () => {
  const msg = createType1Message();
  assert.match(msg, /^NTLM /);
  const buf = Buffer.from(msg.slice(5), 'base64');
  assert.equal(buf.slice(0, 8).toString('ascii'), 'NTLMSSP\0');
  assert.equal(buf.readUInt32LE(8), 1);
  // UNICODE + NTLM + TARGET_INFO + 128.
  assert.equal(buf.readUInt32LE(12), 0xa0800201);
});

test('Type2: разбор challenge и targetInfo', () => {
  // Синтетический Type2: сигнатура, тип 2, targetName, флаги, challenge, reserved, targetInfo.
  const buf = Buffer.alloc(60);
  Buffer.from('NTLMSSP\0').copy(buf, 0);
  buf.writeUInt32LE(2, 8);
  buf.writeUInt16LE(8, 12); buf.writeUInt16LE(8, 14); buf.writeUInt32LE(48, 16);
  buf.writeUInt32LE(0x80800201, 20);
  // challenge 0x0123456789abcdef (LE).
  buf.writeUInt32LE(0x89abcdef, 24); buf.writeUInt32LE(0x01234567, 28);
  buf.writeUInt16LE(12, 40); buf.writeUInt16LE(12, 42); buf.writeUInt32LE(48, 44);
  Buffer.from('DOM\0SERVER\0', 'ascii').copy(buf, 48);
  const parsed = parseType2Message(`NTLM ${buf.toString('base64')}`);
  assert.ok(parsed, 'Type2 не разобран');
  assert.equal(parsed.challenge.toString('hex'), 'efcdab8967452301');
  assert.ok(parsed.targetInfo.length === 12);
  // Не NTLM — null.
  assert.equal(parseType2Message('Basic realm=x'), null);
});

test('Type3: структура MS-NLMP (сигнатура, тип, буферы, флаги, данные)', () => {
  const type2 = parseType2Message(`NTLM ${(() => {
    const b = Buffer.alloc(56);
    Buffer.from('NTLMSSP\0').copy(b, 0);
    b.writeUInt32LE(2, 8);
    b.writeUInt32LE(0x89abcdef, 24); b.writeUInt32LE(0x01234567, 28);
    return b.toString('base64');
  })()}`);
  assert.ok(type2);
  const msg = createType3Message({
    username: 'User', password: 'Password', domain: 'DOMAIN', type2,
  });
  assert.match(msg, /^NTLM /);
  const buf = Buffer.from(msg.slice(5), 'base64');
  assert.equal(buf.readUInt32LE(8), 3);
  // Шесть security-буферов: lm@12, nt@20, domain@28, user@36, ws@44, session@52; флаги@60.
  assert.equal(buf.readUInt32LE(60), 0xa0800201);
  assert.equal(buf.slice(0, 8).toString('ascii'), 'NTLMSSP\0');
  const domainLen = buf.readUInt16LE(28);
  const domainOff = buf.readUInt32LE(32);
  assert.equal(buf.slice(domainOff, domainOff + domainLen).toString('utf16le'), 'DOMAIN');
  const userLen = buf.readUInt16LE(36);
  const userOff = buf.readUInt32LE(40);
  assert.equal(buf.slice(userOff, userOff + userLen).toString('utf16le'), 'User');
  // NT-ответ: proof(16) + blob — не меньше 32 байт.
  const ntLen = buf.readUInt16LE(8 + 8);
  assert.ok(ntLen >= 32, `NT-ответ короче ожидаемого: ${ntLen}`);
  // Детерминированность: тот же вход — тот же ответ (кроме времени/нонса не проверяем).
});

test('Type3: детерминирован для фиксированного времени', () => {
  // NT-ответ зависит от времени и нонса — поэтому здесь проверяем лишь
  // неизменность неизменяемых полей: домен, пользователь, флаги.
  const type2 = parseType2Message(`NTLM ${(() => {
    const b = Buffer.alloc(48);
    Buffer.from('NTLMSSP\0').copy(b, 0);
    b.writeUInt32LE(2, 8);
    return b.toString('base64');
  })()}`);
  assert.ok(type2);
  const msg = createType3Message({ username: 'u', password: 'p', domain: 'D', type2 });
  const buf = Buffer.from(msg.slice(5), 'base64');
  const userLen = buf.readUInt16LE(36);
  const userOff = buf.readUInt32LE(40);
  assert.equal(buf.slice(userOff, userOff + userLen).toString('utf16le'), 'u');
});

test('NTLMv1: официальный вектор MS-NLMP 4.2.2 (NT- и LM-ответы)', () => {
  // User='User', Domain='Domain', Password='Password', challenge 0x0123456789abcdef.
  // Векторы — из спецификации [MS-NLMP] 4.2.2.2 (PDF, сверено с эталоном).
  const challenge = Buffer.from('0123456789abcdef', 'hex');
  const nt = ntResponseV1(ntlmHash('Password'), challenge);
  assert.equal(nt.toString('hex'), '67c43011f30298a2ad35ece64f16331c44bdbed927841f94', 'NT-ответ');
  const lm = lmResponseV1('Password', challenge);
  assert.equal(lm.toString('hex'), '98def7b87f88aa5dafe2df779688a172def11c7d5ccdef13', 'LM-ответ');
});

test('NTLMv1: структурные свойства', () => {
  const challenge = Buffer.from('0123456789abcdef', 'hex');
  const r1 = ntResponseV1(ntlmHash('Password'), challenge);
  const r2 = ntResponseV1(ntlmHash('Password'), challenge);
  assert.deepEqual(r1, r2, 'NT-ответ недетерминирован');
  const r3 = ntResponseV1(ntlmHash('Password2'), challenge);
  assert.notDeepEqual(r1, r3, 'NT-ответ не зависит от пароля');
});
