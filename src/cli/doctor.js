/**
 * Диагностика подключения к Qlik Sense (QIX Engine API).
 * Показывает, на каком шаге соединение ломается, и подсказывает причину.
 */
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { extractFromEngine } from '../extract/engine.js';

export const ERROR_HINTS = {
  301: 'Сервер перенаправляет запрос: указан не адрес движка. Для Qlik Sense нужен путь '
    + '/app/<appId> (например ws://<host>:4747/app/<appId>), для QlikView — /app/<appId> через хаб (443).',
  302: 'Сервер перенаправляет запрос — проверьте, что указан адрес движка /app/<appId>, а не путь хаба.',
  307: 'Сервер перенаправляет запрос — проверьте схему (ws:// или wss://) и путь /app/<appId>.',
  308: 'Сервер перенаправляет запрос — проверьте схему (ws:// или wss://) и путь /app/<appId>.',
  4202: 'Некорректный WebSocket-запрос — проверьте URL (ожидается ws://host:port/app/<appId>).',
  4203: 'Недостаточно прав на приложение — нужна роль в разделе «Управление пользователями».',
  4204: 'Приложение не найдено — проверьте appId и что приложение опубликовано.',
  'App not found': 'Приложение по этому адресу не найдено. В URL после /app/ должен быть '
    + 'идентификатор приложения; служебный адрес /app/engineData — не приложение. '
    + 'Загрузите список приложений и выберите нужное.',
  4205: 'Система занята — повторите попытку.',
  4230: 'Слишком много открытых приложений в организации.',
  4240: 'Нет свободных движков — увеличьте лицензии или уменьшите нагрузку.',
  1006: 'Соединение закрыто аномально — часто это 401/403 (авторизация) или прокси.',
  401: 'Не пройдена авторизация — проверьте пользователя, пароль или API-ключ.',
  403: 'Доступ запрещён — проверьте права и заголовок X-Qlik-User.',
  'ECONNREFUSED': 'Порт закрыт — проверьте, что Qlik Sense Server запущен и слушает этот порт.',
  'ENOTFOUND': 'Хост не найден — проверьте DNS-имя сервера.',
  'CERT_HAS_EXPIRED': 'Сертификат сервера просрочен — используйте --insecure или обновите сертификат.',
  'DEPTH_ZERO_SELF_SIGNED_CERT': 'Самоподписанный сертификат — добавьте --insecure.',
  'EPROTO': 'Несовпадение схемы и порта: по этому порту ожидается обычный WebSocket (ws://), '
    + 'а в URL указано wss://. На Qlik Sense Server 4747 — http (нужен ws://), 4746 — https (нужен wss://).',
  'ERR_TLS_CERT_ALTNAME_INVALID': 'Сертификат не соответствует имени сервера — используйте --insecure.',
};

/**
 * Зондирование порта обычным HTTP(S)-запросом.
 * Помогает отличить «порт не тот» (TLS-рассогласование) от «нужна авторизация» (401/403).
 */
export function probePort(host, port, useTls, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    const mod = useTls ? https : http;
    const req = mod.request({
      host,
      port,
      path: '/',
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { 'User-Agent': 'qlik-analyzer/0.1' },
    }, (res) => {
      res.resume();
      resolvePromise({ ok: true, status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolvePromise({ ok: false, reason: 'Таймаут HTTP-запроса' });
    });
    req.on('error', (err) => resolvePromise({
      ok: false, reason: err.message, code: err.code,
    }));
    req.end();
  });
}

/** Проверка TCP-доступности. */
export function checkTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise({ ok: false, port, reason: 'Таймаут соединения' });
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise({ ok: true, port });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, port, reason: err.message });
    });
  });
}

/** Подсказка по тексту ошибки. */
export function hintFor(message) {
  const keys = Object.keys(ERROR_HINTS);
  const found = keys.find((k) => String(message).includes(k));
  return found ? ERROR_HINTS[found] : 'Проверьте авторизацию и параметры подключения.';
}

/**
 * Диагностика подключения к Qlik Sense (QIX Engine API).
 * Показывает, на каком шаге соединение ломается, и подсказывает причину.
 *
 * @param {object} target — результат resolveTarget()
 * @param {(step: object) => void} [onStep] — колбэк для пошагового вывода
 * @param {number} [connectTimeoutMs] — предел на установку соединения и OpenDoc
 */
export async function runDoctor(target, onStep, connectTimeoutMs = 20000) {
  const steps = [];
  const emit = (step) => { steps.push(step); if (typeof onStep === 'function') onStep(step); };
  const ok = (name, detail) => emit({ name, status: 'OK', detail });
  const fail = (name, detail, hint) => emit({ name, status: 'FAIL', detail, hint });
  const warn = (name, detail) => emit({ name, status: 'WARN', detail });

  if (!target.url) {
    fail('Конфигурация подключения', 'Не задан URL движка',
      'Укажите --url/--host или --env в конфигурационном файле.');
    return { steps, failed: true };
  }

  ok('URL', target.url);

  const urlObj = new URL(target.url);
  const port = Number(target.port ?? (urlObj.port || (urlObj.protocol === 'wss:' ? 443 : 4747)));
  const host = target.host ?? urlObj.hostname;

  const tcp = await checkTcp(host, port);
  if (tcp.ok) ok('TCP-соединение', `${host}:${tcp.port} — порт доступен`);
  else {
    fail('TCP-соединение', tcp.reason,
      'Проверьте порт (Qlik Sense: 4747 http / 4746 https, PCDS: 9076) и сетевые правила.');
    return { steps, failed: true };
  }

  // 1.5. Порт отвечает по HTTP? — отделяем «не та схема» от «нужна авторизация».
  const useTls = urlObj.protocol === 'wss:';
  const probe = await probePort(host, port, useTls, Math.min(8000, connectTimeoutMs));
  if (!probe.ok) {
    const tlsMismatch = probe.code === 'EPROTO'
      || /wrong version number|EPROTO|http parser|wrong HTTP method/i.test(probe.reason ?? '');
    if (tlsMismatch) {
      fail('Проверка порта (HTTP)', probe.reason, ERROR_HINTS.EPROTO);
      return { steps, failed: true };
    }
    warn('Проверка порта (HTTP)', `не удалось получить HTTP-ответ: ${probe.reason}`);
  } else if (probe.status === 401 || probe.status === 403) {
    warn('Проверка порта (HTTP)', `порт отвечает HTTP ${probe.status} — требуется авторизация`);
  } else {
    ok('Проверка порта (HTTP)', `порт отвечает по HTTP (код ${probe.status}) — WebSocket-upgrade доступен`);
  }

  // Спецслучай Qlik Sense: порт 4747 бывает «открыт, но молчит» — это не движок.
  if (!probe.ok && /таймаут|timeout/i.test(probe.reason ?? '')) {
    fail('Проверка порта (HTTP)', `${probe.reason}: порт принимает соединение, но не отвечает по HTTP`,
      'Похоже, это не Engine API. У Qlik Sense Server движок часто доступен только через хаб: '
      + 'wss://<host>/app/<appId> (порт 443). Проверьте этот вариант.');
    return { steps, failed: true };
  }

  try {
    // Установка соединения и OpenDoc ограничены по времени: иначе «socket hang up»
    // или «порт молчит» приводят к бесконечному ожиданию без единого сообщения.
    const graph = await Promise.race([
      extractFromEngine({
        url: target.url,
        schemaPath: target.schemaPath,
        apiKey: target.apiKey,
        user: target.user,
        password: target.password,
        qlikUser: target.qlikUser,
        insecure: target.insecure,
        cookie: target.cookie,
        xrfKey: target.xrfKey,
        csrfToken: target.csrfToken,
        appId: target.appId,
      }),
      new Promise((_r, rejectPromise) => {
        const t = setTimeout(() => rejectPromise(new Error(
          `Превышено время ожидания (${Math.round(connectTimeoutMs / 1000)} с): сервер не ответил на WebSocket-рукопожатие или OpenDoc.`,
        )), connectTimeoutMs);
        t.unref?.();
      }),
    ]);
    ok('WebSocket + OpenDoc', 'Соединение установлено, приложение открыто');
    ok('Скрипт загрузки', graph.script ? `${graph.script.length} символов` : 'скрипт недоступен');
    ok('Объекты приложения', String(graph.objects.length));
    ok('Модель данных', `${graph.tables.length} таблиц, ${graph.fields.length} полей`);
    if (graph.meta?.skipped?.length) {
      warn('Пропущенные возможности', graph.meta.skipped.map((s) => `${s.capability}: ${s.reason}`).join('; '));
    }
  } catch (err) {
    const msg = String(err?.message ?? err);
    const handshakeIssue = /socket hang up|ECONNRESET|1006|abnormal closure/i.test(msg);
    const hint = handshakeIssue
      ? 'TCP открыт, но WebSocket-рукопожатие или первый запрос оборвался. Чаще всего: '
        + '(1) схема и порт не совпадают — на Qlik Sense Server 4747 это http (нужен ws://), '
        + '4746 — https (нужен wss://); (2) сервер требует доменную авторизацию '
        + 'или заголовок X-Qlik-User; (3) между вами и сервером прокси без поддержки WebSocket.'
      : hintFor(msg);
    fail('WebSocket + OpenDoc', msg, hint);
    return { steps, failed: true };
  }

  return { steps, failed: steps.some((s) => s.status === 'FAIL') };
}
