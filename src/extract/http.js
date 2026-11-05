/**
 * HTTP-запрос без внешних зависимостей (с учётом самоподписанного сертификата).
 *
 * Вынесено отдельным модулем: один и тот же запрос нужен и модулю сессии,
 * и клиенту REST API хаба — иначе они импортировали бы друг друга.
 *
 * Поддерживается клиентский сертификат (pfx с паролем или cert+key):
 * он нужен сервису репозитория Qlik Sense (QRS), который требует
 * взаимной TLS-аутентификации.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * GET с автоматическим следованием редиректам (301/302/303/307/308).
 * Заголовки авторизации при переходе сохраняются — хаб часто отвечает
 * перенаправлением, а без cookie отдаёт 401.
 *
 * @param {string} url
 * @param {{
 *   headers?: object, insecure?: boolean, redirects?: number,
 *   pfx?: Buffer, passphrase?: string, cert?: Buffer|string, key?: Buffer|string,
 * }} [options]
 * @returns {Promise<object>} разобранный JSON
 */
export function httpGetJson(url, {
  headers = {}, insecure = false, redirects = 5,
  pfx, passphrase, cert, key,
} = {}) {
  const tls = {};
  if (pfx) tls.pfx = pfx;
  if (passphrase) tls.passphrase = passphrase;
  if (cert) tls.cert = cert;
  if (key) tls.key = key;

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      ...tls,
      ...(insecure ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirects > 0) {
        res.resume();
        const next = new URL(location, u).toString();
        httpGetJson(next, {
          headers, insecure, redirects: redirects - 1, pfx, passphrase, cert, key,
        }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 400) {
          // Текст ответа может быть пустым, а смысл — в строке состояния
          // («403 No client certificate supplied»).
          const reason = res.statusMessage ? ` ${res.statusMessage}` : '';
          reject(new Error(`HTTP ${status}${reason}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Ответ не является JSON: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
