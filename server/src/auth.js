/**
 * Аутентификация пользователей сервера.
 *
 * Три режима:
 *  - `none`  — без аутентификации (только для локальной разработки);
 *  - `basic` — HTTP Basic: логины и пароли из конфига (пароль — из переменной окружения);
 *  - `proxy` — аутентификация делает reverse-proxy (Kerberos/Negotiate, IIS, nginx+mod_auth_gssapi),
 *    сервер читает логин из заголовка (по умолчанию X-Forwarded-User).
 *
 * Роли:
 *  - `viewer`   — просмотр отчётов;
 *  - `analyst`  — запуск анализа;
 *  - `admin`    — всё, включая просмотр списка пользователей и настроек.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Пароль может быть задан открыто или через переменную окружения. */
function readPassword(user) {
  if (user.passwordEnv) return process.env[user.passwordEnv] ?? '';
  return user.password ?? '';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Сравниваем хеши, чтобы длина не утекала через время ответа.
    return timingSafeEqual(createHash('sha256').update(ba).digest(), createHash('sha256').update(bb).digest())
      && false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * @param {object} authCfg — раздел auth из resolveServerConfig
 * @param {object} req — HTTP-запрос
 * @param {{clientIp?: string}} [ctx]
 * @returns {{ok: boolean, user?: string, role?: string, reason?: string}}
 */
export function authenticate(authCfg, req, ctx = {}) {
  const mode = authCfg.mode ?? 'none';

  if (mode === 'none') {
    return { ok: true, user: 'anonymous', role: 'admin' };
  }

  if (mode === 'proxy') {
    const header = authCfg.userHeader ?? 'X-Forwarded-User';
    const raw = req.headers?.[String(header).toLowerCase()];
    const login = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
    if (!login) return { ok: false, reason: `Заголовок ${header} отсутствует — не пройдена аутентификация на прокси` };

    // Домен и имя: CORP\ivan -> домен CORP, имя ivan; ivan@corp.local -> домен corp.local.
    let domain = '';
    let shortName = login;
    if (login.includes('\\')) {
      const parts = login.split('\\');
      domain = parts[0].toLowerCase();
      shortName = parts[parts.length - 1];
    } else if (login.includes('@')) {
      const [name, dom] = login.split('@');
      shortName = name;
      domain = String(dom).toLowerCase();
    } else {
      shortName = login;
    }

    const allowed = authCfg.allowedDomains ?? [];
    if (allowed.length) {
      const ok = allowed.some((d) => {
        const want = String(d).toLowerCase();
        return domain === want || shortName.toLowerCase() === want;
      });
      if (!ok) return { ok: false, reason: `Домен пользователя не разрешён: ${domain || shortName}` };
    }
    return { ok: true, user: login, role: roleOf(login, authCfg) };
  }

  // basic
  const header = req.headers?.authorization ?? '';
  if (!header.startsWith('Basic ')) {
    return { ok: false, reason: 'Требуется HTTP Basic', challenge: true };
  }
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'Некорректные данные авторизации' };
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return { ok: false, reason: 'Некорректные данные авторизации' };
  const login = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);

  const users = authCfg.users ?? [];
  const found = users.find((u) => u.login?.toLowerCase() === login.toLowerCase());
  if (!found) return { ok: false, reason: 'Неизвестный пользователь' };
  if (!safeEqual(password, readPassword(found))) {
    return { ok: false, reason: 'Неверный пароль' };
  }
  return { ok: true, user: found.login, role: found.role ?? authCfg.analystRole ?? 'analyst' };
}

/**
 * Роль пользователя. В режиме proxy роль берётся из списка пользователей
 * (если логин там есть), иначе — по умолчанию «viewer».
 */
function roleOf(login, authCfg) {
  const users = authCfg.users ?? [];
  const found = users.find((u) => u.login?.toLowerCase() === String(login).toLowerCase());
  if (found?.role) return found.role;
  return 'viewer';
}

/** Заголовок WWW-Authenticate для ответа 401. */
export function challengeHeader(authCfg) {
  return `Basic realm="${authCfg.realm ?? 'Qlik Quality'}", charset="UTF-8"`;
}
