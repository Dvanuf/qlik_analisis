/**
 * Транспорт к OpenAI-совместимому чат-эндпоинту.
 *
 * Один и тот же код работает с Z.ai, Gemini (режим OpenAI), Ollama и LM Studio:
 * адрес и модель приходят от адаптера провайдера, протокол везде одинаковый —
 * POST {baseUrl}/chat/completions.
 *
 * Написан на node:http/node:https, а не на fetch: так же, как остальная сеть
 * в проекте (src/extract/http.js), и не требует внешних зависимостей.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AiError, AI_ERROR } from './errors.js';

/**
 * Склеивает базовый адрес и путь, не дублируя и не теряя слэш.
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const tail = String(path ?? '').replace(/^\/+/, '');
  return tail ? `${base}/${tail}` : base;
}

/**
 * Разбирает тело ответа провайдера: достаёт текст ошибки.
 * @param {string} body
 * @returns {string}
 */
function errorMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? '').slice(0, 300);
  } catch {
    return String(body ?? '').slice(0, 300);
  }
}

/**
 * Классифицирует HTTP-статус провайдера в типизированную ошибку.
 * @param {number} status
 * @param {string} body
 * @param {string} provider
 * @returns {AiError}
 */
export function statusToError(status, body, provider) {
  const detail = errorMessage(body);
  if (status === 401 || status === 403) {
    return new AiError(
      AI_ERROR.NO_KEY,
      provider === 'local'
        ? 'Локальный сервер отклонил запрос: проверьте, что модель загружена.'
        : 'Провайдер отклонил ключ: проверьте его в настройках ИИ.',
      { status, provider, detail },
    );
  }
  if (status === 429) {
    return new AiError(
      AI_ERROR.QUOTA_EXHAUSTED,
      'Провайдер вернул 429: лимит запросов на стороне сервиса. Попробуйте позже.',
      { status, provider, detail },
    );
  }
  if (status === 404) {
    return new AiError(
      AI_ERROR.BAD_RESPONSE,
      `Провайдер не знает адрес ${provider} или модель. Проверьте настройки ИИ.`,
      { status, provider, detail },
    );
  }
  if (status >= 500) {
    return new AiError(
      AI_ERROR.PROVIDER_UNAVAILABLE,
      `Провайдер вернул ${status}. Попробуйте позже или переключитесь на резервного.`,
      { status, provider, detail },
    );
  }
  return new AiError(
    AI_ERROR.BAD_RESPONSE,
    `Провайдер вернул ${status}${detail ? `: ${detail}` : ''}`,
    { status, provider, detail },
  );
}

/**
 * Выполняет запрос к чат-эндпоинту.
 *
 * @param {{baseUrl: string, model: string, messages: Array<object>, apiKey?: string,
 *   timeoutMs?: number, signal?: AbortSignal, stream?: boolean, temperature?: number,
 *   maxTokens?: number, provider?: string, onDelta?: (chunk: string) => void}} options
 * @returns {Promise<{text: string, usage: object|null, model: string, finishReason: string|null}>}
 */
export function chatCompletion(options = {}) {
  const {
    baseUrl,
    model,
    messages,
    apiKey,
    timeoutMs = 45000,
    signal,
    stream = false,
    temperature = 0.2,
    maxTokens,
    provider = '?',
    onDelta,
  } = options;

  const url = new URL(joinUrl(baseUrl, 'chat/completions'));
  const payload = {
    model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(stream ? { stream: true } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
  // Локальный сервер ключа не требует; внешние — требуют.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, {
      method: 'POST',
      headers,
    }, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          reject(statusToError(status, Buffer.concat(chunks).toString('utf8'), provider));
        });
        return;
      }

      if (!stream) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(text);
            const choice = parsed?.choices?.[0];
            const content = choice?.message?.content ?? '';
            resolve({
              text: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
              usage: parsed?.usage ?? null,
              model: parsed?.model ?? model,
              finishReason: choice?.finish_reason ?? null,
            });
          } catch {
            reject(new AiError(
              AI_ERROR.BAD_RESPONSE,
              'Провайдер вернул ответ, который не разбирается как JSON.',
              { provider, detail: text.slice(0, 200) },
            ));
          }
        });
        return;
      }

      // Потоковый режим: накапливаем текст по «data: {…}» блокам.
      let buffer = '';
      let text = '';
      let usage = null;
      let finishReason = null;

      const handleChunk = (raw) => {
        const line = raw.trim();
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage) usage = parsed.usage;
          const choice = parsed?.choices?.[0];
          if (!choice) return;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
          if (delta) {
            text += delta;
            onDelta?.(delta);
          }
        } catch {
          // Неполный блок SSE — пропускаем, следующий придёт целиком.
        }
      };

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleChunk(line);
          idx = buffer.indexOf('\n');
        }
      });
      res.on('end', () => {
        if (buffer.trim()) handleChunk(buffer);
        resolve({ text, usage, model, finishReason });
      });
    });

    request.on('error', (err) => {
      if (signal?.aborted) {
        reject(new AiError(AI_ERROR.CANCELLED, 'Запрос отменён.', { provider }));
        return;
      }
      reject(new AiError(
        AI_ERROR.PROVIDER_UNAVAILABLE,
        `Не удалось связаться с провайдером: ${err.message}`,
        { provider, detail: err.message },
      ));
    });

    // Таймаут запроса и отмена пользователем.
    const timer = setTimeout(() => {
      request.destroy();
      reject(new AiError(
        AI_ERROR.TIMEOUT,
        `Провайдер не ответил за ${Math.round(timeoutMs / 1000)} с.`,
        { provider },
      ));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      request.destroy();
      reject(new AiError(AI_ERROR.CANCELLED, 'Запрос отменён.', { provider }));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    request.on('close', () => clearTimeout(timer));
    request.end(body);
  });
}
