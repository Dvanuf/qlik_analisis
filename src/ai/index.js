/**
 * ИИ-слой: единая точка входа для работы с языковыми моделями.
 * ИИ-слой: единая точка входа для работы с языковыми моделями.
 *
 * analyze(prompt, data, options) — один вызов, внутри которого:
 *   1. данные агрегируются в сводку (модуль summary);
 *   2. сводка обезличивается, если провайдер внешний (модуль redact);
 *   3. запрос проходит по цепочке провайдеров с повторами;
 *   4. соблюдаются лимиты частоты и работает кэш ответов (модуль limits).
 *
 * Ключи провайдеров в модуль не попадают «из ниоткуда»: их передаёт
 * вызывающий (main-процесс Electron или HTTP-сервер) через options.apiKeys.
 * В репозитории ключей нет.
 */
import { AiError, AI_ERROR, toAiError } from './errors.js';
import { PROVIDERS, providerChain, resolveProvider } from './providers.js';
import { chatCompletion } from './openai.js';
import { buildMessages } from './prompt.js';
import { createRedactor } from './redact.js';
import { buildSummary, DEFAULT_MAX_CHARS } from './summary.js';
import { Limits, DEFAULT_LIMITS } from './limits.js';

/**
 * Результат запроса к модели.
 * @typedef {object} AiAnswer
 * @property {string} text — текст ответа.
 * @property {string} provider — провайдер, который ответил.
 * @property {string} model — модель провайдера.
 * @property {boolean} truncated — была ли сводка обрезана.
 * @property {boolean} cached — отдан ли ответ из кэша.
 * @property {boolean} redacted — обезличены ли данные перед отправкой.
 * @property {number} attempts — сколько попыток потребовалось.
 */

export { AiError, AI_ERROR } from './errors.js';
export { PROVIDERS, providerChain } from './providers.js';
export { buildSummary } from './summary.js';
export { createRedactor } from './redact.js';
export { Limits } from './limits.js';

/** Сколько раз пробуем одного и того же провайдера перед переключением. */
export const MAX_ATTEMPTS_PER_PROVIDER = 2;
/** Базовая пауза между повторами (мс); растёт экспоненциально. */
export const RETRY_BASE_MS = 800;
/** Больше минуты ждать нельзя: лимит запросов за это время не восстановится. */
export const MAX_RETRY_AFTER_MS = 60000;

/**
 * Пауза перед повтором: экспоненциальный рост плюс случайный разброс.
 * @param {number} attempt — номер попытки, начиная с 1
 * @param {number} [base]
 * @returns {number}
 */
export function retryDelay(attempt, base = RETRY_BASE_MS) {
  const exp = base * (2 ** Math.max(0, attempt - 1));
  // Разброс ±30 %: не даём нескольким клиентам бить провайдера синхронно.
  const jitter = exp * 0.3 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}


/**
 * Пауза перед повтором с учётом Retry-After.
 *
 * Провайдер может сказать, сколько ждать. Но ждать дольше минуты нельзя:
 * пользователь успеет закрыть окно, а лимит запросов не восстановится.
 *
 * @param {AiError} error
 * @param {number} attempt
 * @returns {number}
 */
export function retryWait(error, attempt) {
  const requested = Number(error?.retryAfterMs ?? 0);
  if (requested > 0) return Math.min(requested, MAX_RETRY_AFTER_MS);
  return retryDelay(attempt);
}
/**
 * Пауза с поддержкой отмены.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiError(AI_ERROR.CANCELLED, 'Запрос отменён.'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new AiError(AI_ERROR.CANCELLED, 'Запрос отменён.'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Нужно ли повторять запрос у того же провайдера.
 *
 * 401/403 (плохой ключ) и 404 (неверная модель) повтором не лечатся — сразу
 * переходим к следующему провайдеру. 429, 5xx, таймаут и сетевые ошибки
 * повторяем: это временные сбои.
 *
 * @param {AiError} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  if (error.code === AI_ERROR.CANCELLED) return false;
  if (error.code === AI_ERROR.NO_KEY) return false;
  if (error.code === AI_ERROR.BAD_RESPONSE) return false;
  if (error.code === AI_ERROR.DATA_TOO_LARGE) return false;
  if (error.code === AI_ERROR.NO_LOCAL_PROVIDER) return false;
  // Исчерпанный лимит — ждать бессмысленно: надо переключаться на резервного.
  if (error.code === AI_ERROR.QUOTA_EXHAUSTED) return false;
  return true;
}

/**
 * Ключ для кэша ответов: провайдер, модель, вопрос и сводку.
 *
 * В ключ входят также история диалога и правка промпта: иначе отредактированный
 * промпт получил бы из кэша ответ на исходный.
 * @param {string} provider
 * @param {string} model
 * @param {string} prompt
 * @param {string} summary
 * @param {object} [extra]
 * @returns {string}
 */
function cacheKey(provider, model, prompt, summary, extra = {}) {
  const history = (extra.history ?? []).map((m) => `${m.role}:${m.content}`).join('\n');
  const override = extra.override
    ? `sys:${extra.override.system ?? ''}\nusr:${extra.override.user ?? ''}`
    : '';
  return Limits.key(provider, model, prompt, summary, history, override);
}

/**
 * Значения, которые нужно скрыть перед отправкой во внешний API.
 * @param {object} data
 * @returns {Array<{value: string, kind: string}>}
 */
function redactionNames(data = {}) {
  return [
    { value: data?.app?.title ?? data?.app?.name, kind: 'Приложение' },
    { value: data?.app?.owner, kind: 'Владелец' },
  ].filter((n) => n.value);
}

/**
 * Собирает сообщения для одного провайдера.
 *
 * Для внешнего провайдера маскируется всё сообщение целиком — и сводка, и
 * вопрос пользователя: иначе имя, вписанное в вопрос вручную, ушло бы наружу.
 *
 * @param {object} params
 * @param {string} params.question
 * @param {object} params.summary — результат buildSummary
 * @param {Array<object>} [params.history] — прежние реплики диалога
 * @param {object|null} [params.override] — {system, user} — правка промпта
 * @param {boolean} [params.external] — уходят ли данные с машины
 * @param {Array<object>} [params.names] — значения для маскирования
 * @returns {{messages: Array<object>, redactor: object|null}}
 */
function composeMessages({
  question, summary, history = [], override = null, external = false, names = [],
}) {
  const redactor = external ? createRedactor({ names }) : null;
  const messages = buildMessages(question, summary.text, {
    history,
    system: override?.system,
    user: override?.user,
  });
  return {
    messages: redactor
      ? messages.map((m) => ({ role: m.role, content: redactor.mask(m.content) }))
      : messages,
    redactor,
  };
}

/**
 * Возвращает настоящие значения вместо плейсхолдеров.
 *
 * Маскирование нужно для внешнего провайдера, но пользователь должен видеть
 * в ответе своё название приложения, а не «Приложение_1». Подстановка идёт
 * локально — наружу уходит обезличенный текст.
 *
 * @param {string} text
 * @param {object|null} redactor
 * @returns {string}
 */
export function restoreNames(text, redactor) {
  if (!redactor?.replacements?.size) return String(text ?? '');
  let out = String(text ?? '');
  // Длинные плейсхолдеры — первыми: «Приложение_1» не должен повредить «Приложение_11».
  const pairs = [...redactor.replacements.entries()]
    .map(([original, placeholder]) => [placeholder, original])
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
  for (const [placeholder, original] of pairs) {
    if (!placeholder || !out.includes(placeholder)) continue;
    out = out.split(placeholder).join(original);
  }
  return out;
}

/**
 * Готовит промпт для показа в интерфейсе: ровно тот текст, который уйдёт
 * первому провайдеру цепочки.
 *
 * @param {string} prompt — вопрос пользователя
 * @param {object} [data] — {analysis, runs, comparison, app, maxChars, focus}
 * @param {object} [options]
 * @param {string} [options.provider]
 * @param {string[]} [options.fallback]
 * @param {boolean} [options.sensitive]
 * @param {object} [options.providers]
 * @param {Array<object>} [options.history]
 * @param {object|null} [options.override]
 * @returns {{system: string, user: string, provider: string, model: string,
 *   external: boolean, truncated: boolean, redacted: boolean}}
 */
export function buildPromptPreview(prompt, data = {}, options = {}) {
  const {
    provider = 'zai', fallback = [], sensitive = false, providers = {},
    history = [], override = null,
  } = options;
  const chain = providerChain(provider, fallback);
  const allowed = sensitive
    ? chain.filter((id) => PROVIDERS[id]?.external === false)
    : chain;
  if (!allowed.length) {
    throw new AiError(
      AI_ERROR.NO_LOCAL_PROVIDER,
      'Режим конфиденциальности: доступна только локальная модель. Укажите её в настройках ИИ.',
    );
  }
  const first = allowed[0];
  const descriptor = resolveProvider(first, providers[first] ?? {});
  const maxChars = Number(data?.maxChars ?? DEFAULT_MAX_CHARS);
  const summary = buildSummary({
    ...data,
    maxChars,
    question: prompt,
    focus: data?.focus ?? null,
  });
  const { messages, redactor } = composeMessages({
    question: prompt,
    summary,
    history,
    override,
    external: descriptor.external === true,
    names: redactionNames(data),
  });
  return {
    system: messages.find((m) => m.role === 'system')?.content ?? '',
    user: messages[messages.length - 1]?.content ?? '',
    provider: first,
    model: descriptor.model,
    external: descriptor.external === true,
    truncated: summary.truncated,
    redacted: Boolean(redactor),
  };
}

/**
 * Запрашивает модель у одного провайдера с повторами.
 *
 * @param {object} provider — описание провайдера
 * @param {object} params — {messages, apiKey, timeoutMs, signal, stream, onDelta}
 * @returns {Promise<{text: string, usage: object|null, model: string}>}
 */
async function callProvider(provider, params) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
    try {
      const result = await chatCompletion({
        baseUrl: provider.baseUrl,
        model: provider.model,
        messages: params.messages,
        apiKey: params.apiKey,
        timeoutMs: provider.timeoutMs ?? params.timeoutMs ?? 45000,
        signal: params.signal,
        stream: params.stream,
        temperature: params.temperature,
        provider: provider.id,
        onDelta: params.onDelta,
      });
      // Пустой ответ — повторяем: у провайдера бывают «молчаливые» сбои.
      if (!result.text || !result.text.trim()) {
        throw new AiError(
          AI_ERROR.EMPTY_RESPONSE,
          'Провайдер вернул пустой ответ.',
          { provider: provider.id },
        );
      }
      return result;
    } catch (err) {
      const error = toAiError(err, provider.id);
      lastError = error;
      if (!isRetryable(error) || attempt >= MAX_ATTEMPTS_PER_PROVIDER) throw error;
      await sleep(retryWait(error, attempt), params.signal);
    }
  }
  throw lastError ?? new AiError(AI_ERROR.PROVIDER_UNAVAILABLE, 'Провайдер недоступен.');
}

/**
 * Лимитеры, разделяемые внутри процесса.
 *
 * Счётчик дня и кэш ответов должны быть общими для всех вызовов analyze:
 * иначе каждый вопрос начинался бы с нуля, а кэш не срабатывал бы никогда.
 * Ключ — путь к файлу состояния (или «default» для работы без файла).
 * @type {Map<string, Limits>}
 */
const sharedLimiters = new Map();

/**
 * Возвращает общий для процесса ограничитель.
 * @param {object} options — {limits, statePath, limiter}
 * @returns {Limits}
 */
function getLimiter(options = {}) {
  if (options.limiter) return options.limiter;
  const wanted = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const key = options.statePath ?? 'default';
  const current = sharedLimiters.get(key);
  if (current
    && current.requestsPerMinute === wanted.requestsPerMinute
    && current.dailyCap === wanted.dailyCap
    && current.cacheTtlMs === wanted.cacheTtlMs) {
    return current;
  }
  const limiter = new Limits({ ...wanted, statePath: options.statePath ?? null });
  sharedLimiters.set(key, limiter);
  return limiter;
}

/**
 * Единая точка входа ИИ-слоя.
 *
 *
 * @param {string} prompt — вопрос пользователя
 * @param {object} data — {analysis, runs, comparison, app, maxChars}
 * @param {object} [options]
 * @param {string} [options.provider] — основной провайдер (по умолчанию zai)
 * @param {string[]} [options.fallback] — резервные провайдеры
 * @param {Record<string, string>} [options.apiKeys] — ключи по идентификатору провайдера
 * @param {boolean} [options.sensitive] — режим конфиденциальности: только локальный
 * @param {object} [options.providers] — переопределения провайдеров {id: {baseUrl, model}}
 * @param {object} [options.limits] — {requestsPerMinute, dailyCap, cacheTtlMs}
 * @param {string} [options.statePath] — файл состояния счётчиков
 * @param {AbortSignal} [options.signal]
 * @param {(chunk: string) => void} [options.onDelta] — потоковый вывод
 * @param {(event: object) => void} [options.onEvent] — события прогресса
 * @param {Array<{role: string, content: string}>} [options.history] — прежние реплики диалога
 * @param {{system?: string, user?: string}|null} [options.override] — правка промпта из интерфейса
 * @returns {Promise<AiAnswer>}
 */
export async function analyze(prompt, data = {}, options = {}) {
  const {
    provider = 'zai',
    fallback = [],
    apiKeys = {},
    sensitive = false,
    providers = {},
    limits = {},
    statePath = null,
    signal,
    onDelta,
    onEvent,
    stream = false,
    history = [],
    override = null,
  } = options;

  const chain = providerChain(provider, fallback);
  if (!chain.length) {
    throw new AiError(AI_ERROR.BAD_RESPONSE, `Неизвестный провайдер ИИ: ${provider}.`);
  }

  // В режиме конфиденциальности наружу уходят только локальные модели.
  const allowed = sensitive
    ? chain.filter((id) => PROVIDERS[id]?.external === false)
    : chain;
  if (!allowed.length) {
    throw new AiError(
      AI_ERROR.NO_LOCAL_PROVIDER,
      'Режим конфиденциальности: доступна только локальная модель. Укажите её в настройках ИИ.',
    );
  }

  const limiter = getLimiter({ ...options, limits, statePath });
  // 1. Агрегация: наружу уходит сводка, а не сырой результат анализа.
  const maxChars = Number(data?.maxChars ?? DEFAULT_MAX_CHARS);
  const question = String(prompt ?? '').trim();
  const summary = buildSummary({
    ...data,
    maxChars,
    question,
    focus: data?.focus ?? null,
  });
  if (summary.truncated) {
    onEvent?.({ type: 'truncated', message: `Сводка обрезана до ${maxChars} символов.` });
  }

  const firstModel = providers[allowed[0]]?.model ?? PROVIDERS[allowed[0]]?.model;
  const key = cacheKey(allowed[0], firstModel, question, summary.text, {
    history,
    override,
  });
  const cached = limiter.getCached(key);
  if (cached) {
    onEvent?.({ type: 'cached', message: 'Ответ взят из кэша.' });
    return { ...cached, cached: true, attempts: 0 };
  }

  // 2. Лимиты: проверяем до выхода в сеть.
  limiter.check();

  let lastError = null;
  let attempts = 0;

  for (const id of allowed) {
    const descriptor = resolveProvider(id, providers[id] ?? {});
    const apiKey = apiKeys?.[id] ?? (descriptor.apiKeyEnv ? process.env[descriptor.apiKeyEnv] : undefined);

    if (descriptor.needsKey && !apiKey) {
      lastError = new AiError(
        AI_ERROR.NO_KEY,
        `Не задан ключ провайдера ${descriptor.label}. Укажите его в настройках ИИ.`,
        { provider: id },
      );
      onEvent?.({ type: 'skip', provider: id, message: lastError.message });
      continue;
    }

    // 3. Обезличивание: внешние провайдеры получают маскированный текст.
    const { messages, redactor } = composeMessages({
      question,
      summary,
      history,
      override,
      external: descriptor.external === true,
      names: redactionNames(data),
    });
    const redacted = Boolean(redactor?.count());
    if (redacted) {
      onEvent?.({ type: 'redacted', message: `Обезличено значений: ${redactor.count()}.` });
    }


    onEvent?.({ type: 'provider', provider: id, model: descriptor.model });

    try {
      const result = await callProvider(descriptor, {
        messages,
        apiKey,
        signal,
        stream,
        onDelta,
        temperature: options.temperature,
      });
      attempts += 1;
      limiter.record();
      const answer = {
        // Название приложения возвращается в ответе: наружу ушло обезличенное,
        // а пользователь должен видеть своё приложение, а не «Приложение_1».
        text: restoreNames(result.text, redactor),
        provider: id,
        model: descriptor.model,
        truncated: summary.truncated,
        cached: false,
        redacted,
        attempts,
      };
      limiter.setCached(key, answer);
      return answer;
    } catch (err) {
      const error = toAiError(err, id);
      lastError = error;
      attempts += 1;
      if (error.code === AI_ERROR.CANCELLED) throw error;
      onEvent?.({ type: 'error', provider: id, message: error.message });
    }
  }

  throw lastError ?? new AiError(AI_ERROR.PROVIDER_UNAVAILABLE, 'Ни один провайдер не ответил.');
}

