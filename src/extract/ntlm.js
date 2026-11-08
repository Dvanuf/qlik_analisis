/**
 * NTLM-клиент для QlikView AccessPoint (Windows-аутентификация).
 *
 * Chromium на macOS не умеет NTLM, а AccessPoint у QlikView Server обычно
 * настроен именно на него (страница login.htm делает автологин текущими
 * учётными данными Windows). Этот модуль проводит NTLMv2-рукопожатие
 * программно: Type1 → Type2 (challenge) → Type3 → cookie сессии.
 *
 * Чистая реализация без внешних зависимостей. MD4 реализован на JS:
 * OpenSSL 3 в Node 24 не отдаёт 'md4' без legacy provider.
 *
 * Пароль пользователя живёт только в памяти запроса и не сохраняется
 * нигде — сохраняется лишь полученная cookie сессии.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';

// --- MD4 (RFC 1320) — нужен для NTLM-хеша пароля ---

/** MD4: байтовый вход → 16-байтовый дайджест. */
export function md4(input) {
  // Инициализация (little-endian слова).
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  // Дополнение: 0x80, нули, длина в битах (LE).
  const lenBits = input.length * 8;
  const padded = Buffer.concat([
    input,
    Buffer.from([0x80]),
    Buffer.alloc((56 - (input.length + 1) % 64 + 64) % 64),
    (() => { const b = Buffer.alloc(8); b.writeUInt32LE(lenBits >>> 0, 0); b.writeUInt32LE(Math.floor(lenBits / 0x100000000), 4); return b; })(),
  ]);

  const R = (v, s) => ((v << s) | (v >>> (32 - s))) >>> 0;
  const X = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) X[i] = padded.readUInt32LE(off + i * 4);
    let a = a0, b = b0, c = c0, d = d0;

    // Раунд 1: F(b,c,d) = (b&c)|(~b&d), сдвиги 3,7,11,19.
    const F1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const S1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i += 1) {
      a = R(a + (b & c | ~b & d) + X[F1[i]], S1[i % 4]);
      const t = d; d = c; c = b; b = a; a = t;
    }
    // Раунд 2: G(b,c,d) = (b&c)|(b&d)|(c&d), порядок X 0,4,8,12,1,5,9,13,…
    const F2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    const S2 = [3, 5, 9, 13];
    for (let i = 0; i < 16; i += 1) {
      a = R(a + (b & c | b & d | c & d) + X[F2[i]] + 0x5a827999, S2[i % 4]);
      const t = d; d = c; c = b; b = a; a = t;
    }
    // Раунд 3: H(b,c,d) = b^c^d, порядок X 0,8,4,12,2,10,6,14,1,9,5,13,…
    const F3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    const S3 = [3, 9, 11, 15];
    for (let i = 0; i < 16; i += 1) {
      a = R(a + (b ^ c ^ d) + X[F3[i]] + 0x6ed9eba1, S3[i % 4]);
      const t = d; d = c; c = b; b = a; a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a0, 0); out.writeUInt32LE(b0, 4);
  out.writeUInt32LE(c0, 8); out.writeUInt32LE(d0, 12);
  return out;
}

// --- NTLMv2 ---

const SIGNATURE = Buffer.from('NTLMSSP\0', 'ascii');
const FLAG_UNICODE = 0x00000001;
const FLAG_NTLM = 0x00000200;
const FLAG_TARGET_INFO = 0x00800000;
const FLAG_128 = 0x20000000;
const FLAG_56 = 0x80000000;
const FLAGS = (FLAG_UNICODE | FLAG_NTLM | FLAG_TARGET_INFO | FLAG_128 | FLAG_56) >>> 0; // 0x80800201

/** NT-хеш пароля: MD4(UTF-16LE(password)). */
export function ntlmHash(password) {
  return md4(Buffer.from(String(password ?? ''), 'utf16le'));
}

/** Type1: стартовое сообщение negotiate (тело base64 без префикса «NTLM »). */
export function createType1Message() {
  const buf = Buffer.alloc(16);
  SIGNATURE.copy(buf, 0);
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(FLAGS, 12);
  return `NTLM ${buf.toString('base64')}`;
}

/** Type2: разобрать challenge-ответ сервера. */
export function parseType2Message(header) {
  const m = /(?:NTLM|Negotiate)\s+([A-Za-z0-9+/=]+)/i.exec(String(header ?? ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 32 || buf.slice(0, 8).toString('ascii') !== 'NTLMSSP\0') return null;
  if (buf.readUInt32LE(8) !== 2) return null;
  const challenge = buf.slice(24, 32);
  const tiLen = buf.readUInt16LE(40);
  const tiOff = buf.readUInt32LE(44);
  const targetInfo = tiLen > 0 ? buf.slice(tiOff, tiOff + tiLen) : Buffer.alloc(0);
  return { challenge, targetInfo };
}

/** Windows FILETIME (100-нс с 1601 года) — 8 байт LE. */
function filetime(date) {
  const ticks = BigInt(date.getTime() + 11644473600000) * 10000n;
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(ticks);
  return b;
}

/** Type3: финальное сообщение authenticate (тело base64). */
export function createType3Message(opts) {
  // Домен: в NTLMv2-хеш идёт ВЕРХНИЙ регистр, а в буфер Type3 — как ввёл пользователь
  // (сервер сверяет proof со своим доменом; Safari/Windows передают ONYX).
  const domain = String(opts.domain ?? '');
  const user = String(opts.username ?? '');
  const ws = String(opts.workstation ?? 'QLIK-ANALYZER');
  const password = String(opts.password ?? '');

  // NT-хеш → NTLMv2-хеш: HMAC-MD5(NT, UPPER(user) + UPPER(domain)).
  const nt = ntlmHash(password);
  const v2Hash = createHmac('md5', nt)
    .update(Buffer.from(`${user.toUpperCase()}${domain.toUpperCase()}`, 'utf16le'))
    .digest();

  // Blob (MS-NLMP 3.3.2): версия, время, случайный клиент-нонс, AV-пары сервера.
  const blob = Buffer.concat([
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    filetime(new Date()),
    randomBytes(8),
    Buffer.alloc(4),
    opts.type2.targetInfo,
  ]);
  const proof = createHmac('md5', v2Hash)
    .update(Buffer.concat([opts.type2.challenge, blob]))
    .digest();
  const ntResponse = Buffer.concat([proof, blob]);

  // LM-ответ при NTLMv2 не используется: поле заполняется 24 нулями
  // (дублированный NT-ответ строгие серверы отвергают как невалидный LM).
  const lmResponse = Buffer.alloc(24);

  const u16 = (v) => Buffer.from(v, 'utf16le');
  // Шесть security-буферов по порядку MS-NLMP: LM, NT, Domain, User, Workstation, SessionKey.
  const parts = [lmResponse, ntResponse, u16(domain), u16(user), u16(ws), Buffer.alloc(0)];

  // Сборка Type3: сигнатура(8) + type(4) + 6 буферов(8×6=48) + флаги(4), затем данные.
  const buffers = Buffer.alloc(48);
  let dataOffset = SIGNATURE.length + 4 + 48 + 4;
  for (let i = 0; i < parts.length; i += 1) {
    buffers.writeUInt16LE(parts[i].length, i * 8);
    buffers.writeUInt16LE(parts[i].length, i * 8 + 2);
    buffers.writeUInt32LE(dataOffset, i * 8 + 4);
    dataOffset += parts[i].length;
  }
  const flags = Buffer.alloc(4);
  flags.writeUInt32LE(FLAGS, 0);
  const body = Buffer.concat([SIGNATURE, Buffer.from([3, 0, 0, 0]), buffers, flags, ...parts]);
  return `NTLM ${body.toString('base64')}`;
}

/**
 * Один HTTP-запрос с NTLM-заголовком (keep-alive агент на все 3 шага).
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
function httpOnce(url, headers, insecure) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Агент должен совпадать с протоколом: https.Agent в http-запросе даёт
    // ERR_INVALID_PROTOCOL «Expected https:».
    const AgentCtor = u.protocol === 'https:' ? HttpsAgent : HttpAgent;
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      method: 'GET',
      headers: { Connection: 'keep-alive', ...headers },
      agent: new AgentCtor({ keepAlive: true, rejectUnauthorized: !insecure }),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function headerValue(headers, name) {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  }
  return '';
}

function collectSetCookie(headers) {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const map = new Map();
  for (const line of list) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return map;
}

/**
 * Полный NTLM-логин по URL: 401 → Type1 → Type2 → Type3 → 200 + cookie.
 *
 * @param {{url: string, username: string, password: string, domain?: string,
 *   workstation?: string, insecure?: boolean}} opts
 * @returns {Promise<{cookies: Map<string, string>, cookieHeader: string,
 *   status: number}>} cookie сессии (AccessPointSession / X-Qlik-Session)
 */
export async function httpNtlmLogin(opts) {
  const agentHeaders = { Host: new URL(opts.url).host };

  // Шаг 1: без авторизации — ждём 401 + NTLM challenge.
  const first = await httpOnce(opts.url, { Host: agentHeaders.Host }, opts.insecure ?? false);
  if (first.status !== 401) {
    // Сервер пустил без NTLM (нет аутентификации) — cookie текущего ответа.
    const cookies = collectSetCookie(first.headers);
    return { cookies, cookieHeader: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), status: first.status };
  }
  const wwwAuth = headerValue(first.headers, 'www-authenticate');
  if (!/ntlm/i.test(wwwAuth)) {
    throw new Error(`Сервер не предлагает NTLM (WWW-Authenticate: ${wwwAuth || '—'})`);
  }

  // Шаг 2: Type1 → Type2.
  const second = await httpOnce(opts.url, {
    Host: agentHeaders.Host,
    Authorization: createType1Message(),
  }, opts.insecure ?? false);
  const type2 = parseType2Message(headerValue(second.headers, 'www-authenticate'));
  if (!type2) throw new Error('Сервер не вернул NTLM-челлендж (Type2)');

  // Шаг 3: Type3 → 200 + Set-Cookie.
  const third = await httpOnce(opts.url, {
    Host: agentHeaders.Host,
    Authorization: createType3Message({
      username: opts.username,
      password: opts.password,
      domain: opts.domain,
      workstation: opts.workstation,
      type2,
    }),
  }, opts.insecure ?? false);
  if (third.status >= 400) throw new Error(`Сервер отклонил NTLM-аутентификацию (HTTP ${third.status}). Проверьте логин, пароль и домен — при логине без домена укажите домен в поле.`);
  const cookies = collectSetCookie(third.headers);
  return {
    cookies,
    cookieHeader: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    status: third.status,
  };
}
