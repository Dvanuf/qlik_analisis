/**
 * Типизированные ошибки ИИ-слоя.
 *
 * Код ошибки — это то, на что смотрит оркестратор: по нему решается,
 * повторять запрос, переключаться на резервного провайдера или прекращать
 * работу. Текст сообщения — то, что видит пользователь в интерфейсе.
 */

export const AI_ERROR = {
  /** Ключ провайдера не задан или отклонён (401/403). */
  NO_KEY: 'NO_KEY',
  /** Дневной лимит запросов исчерпан. */
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  /** Провайдер недоступен: сеть, 5xx, таймаут. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** Слишком много запросов за минуту (наш ограничитель). */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Данные не поместились в лимит размера запроса. */
  DATA_TOO_LARGE: 'DATA_TOO_LARGE',
  /** Провайдер не ответил за отведённое время. */
  TIMEOUT: 'TIMEOUT',
  /** Запрос отменён пользователем. */
  CANCELLED: 'CANCELLED',
  /** Провайдер вернул неожиданный ответ. */
  BAD_RESPONSE: 'BAD_RESPONSE',
  /** Провайдер ответил пустым текстом. */
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  /** В режиме конфиденциальности нет доступного локального провайдера. */
  NO_LOCAL_PROVIDER: 'NO_LOCAL_PROVIDER',
};

/**
 * Ошибка ИИ-слоя с машиночитаемым кодом.
 */
export class AiError extends Error {
  /**
   * @param {string} code — код из AI_ERROR
   * @param {string} message — текст для пользователя
   * @param {{status?: number, provider?: string, detail?: string}} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = details.status;
    this.provider = details.provider;
    this.detail = details.detail;
  }
}

/**
 * Приводит любую ошибку к типу AiError: неизвестные ошибки считаем
 * недоступностью провайдера — так их перехватит резервная цепочка.
 * @param {unknown} error
 * @param {string} [provider]
 * @returns {AiError}
 */
export function toAiError(error, provider) {
  if (error instanceof AiError) {
    if (provider && !error.provider) error.provider = provider;
    return error;
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Неизвестная ошибка');
  return new AiError(AI_ERROR.PROVIDER_UNAVAILABLE, `Провайдер недоступен: ${message}`, {
    provider,
    detail: message,
  });
}
