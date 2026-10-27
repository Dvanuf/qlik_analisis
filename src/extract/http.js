/**
 * HTTP-запрос без внешних зависимостей (с учётом самоподписанного сертификата).
 *
 * Вынесено отдельным модулем: один и тот же запрос нужен и модулю сессии,
 * и клиенту REST API хаба — иначе они импортировали бы друг друга.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * GET с автоматическим следованием редиректам (301/302/303/307/308).
 * Заголовки авторизации при переходе сохраняются — хаб часто отвечает
 * перенаправлением, а без cookie отдаёт 401.
 *
 * @param {string} url
 * @param {{headers?: object, insecure?: boolean, redirects?: number}} [options]
 * @returns {Promise<object>} разобранный JSON
 */
export function httpGetJson(url, { headers = {}, insecure = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      ...(insecure ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirects > 0) {
        res.resume();
        const next = new URL(location, u).toString();
        httpGetJson(next, { headers, insecure, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 400) {
          reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`));
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
