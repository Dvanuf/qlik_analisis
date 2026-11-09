/**
 * Описания провайдеров ИИ.
 *
 * Все три говорят по OpenAI-совместимому протоколу (POST /chat/completions),
 * поэтому транспорт общий. Различаются они базовым адресом, моделью, наличием
 * ключа и тем, уходят ли данные с машины пользователя.
 *
 * external: true — данные покидают машину, значит применяется маскирование
 * и режим конфиденциальности такие провайдеры исключает.
 */

/**
 * Описание провайдера ИИ.
 * @typedef {object} AiProvider
 * @property {string} id — идентификатор провайдера.
 * @property {string} label — подпись для интерфейса.
 * @property {string} baseUrl — адрес OpenAI-совместимого эндпоинта.
 * @property {string} model — модель по умолчанию.
 * @property {string|null} apiKeyEnv — имя переменной окружения с ключом.
 * @property {boolean} needsKey — нужен ли ключ.
 * @property {boolean} external — уходят ли данные с машины.
 * @property {number} timeoutMs — таймаут запроса.
 * @property {number} [maxTokens] — предел длины ответа в токенах.
 * @property {object} [thinking] — параметры режима размышления провайдера.
 */

/** @type {Record<string, AiProvider>} */
export const PROVIDERS = {
  zai: {
    id: 'zai',
    label: 'Z.ai',
    // Бесплатный тариф: модель glm-4.5-flash не тарифицируется.
    // glm-4.7-flash тоже бесплатна, но часто отвечает «модель перегружена».
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-4.5-flash',
    apiKeyEnv: 'QLIK_AI_ZAI_KEY',
    needsKey: true,
    external: true,
    // GLM отвечает 30–90 с: стандартных 45 с не хватает.
    timeoutMs: 120000,
    maxTokens: 8000,
    // Без этого бюджет уходит в reasoning_content, а content приходит пустым.
    thinking: { type: 'disabled' },
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini — Flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Псевдоним всегда указывает на актуальную стабильную Flash-модель:
    // конкретные номера версий устаревают и исчезают из API.
    model: 'gemini-flash-latest',
    apiKeyEnv: 'QLIK_AI_GEMINI_KEY',
    needsKey: true,
    external: true,
    timeoutMs: 90000,
  },
  local: {
    id: 'local',
    label: 'Локальная модель — Ollama / LM Studio',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    apiKeyEnv: null,
    needsKey: false,
    external: false,
    timeoutMs: 180000,
  },
};

/** Порядок провайдеров по умолчанию: платный-бесплатный → бесплатный → локальный. */
export const PROVIDER_ORDER = ['zai', 'gemini', 'local'];
/**
 * Убирает из списка резервов всё, что не может быть резервом.
 *
 * Остаются только известные провайдеры, без повторов и без основного:
 * основной и так первый в цепочке, а «резерв = основной» бессмысленно —
 * такая настройка тихо оставляет запрос без резерва.
 *
 * @param {string} primary
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function sanitizeFallback(primary = '', fallback = []) {
  const list = Array.isArray(fallback) ? fallback : [fallback];
  return [...new Set(list
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .filter((id) => Boolean(PROVIDERS[id]))
    .filter((id) => id !== primary))];
}

/**
 * Собирает цепочку провайдеров: основной + резервные, без повторов.
 * @param {string} primary
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function providerChain(primary = 'zai', fallback = []) {
  const list = [primary, ...sanitizeFallback(primary, fallback)]
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  return [...new Set(list)].filter((id) => Boolean(PROVIDERS[id]));
}


/**
 * Описание провайдера с учётом переопределений из конфигурации.
 * @param {string} id
 * @param {{baseUrl?: string, model?: string}} [override]
 * @returns {object|null}
 */
export function resolveProvider(id, override = {}) {
  const base = PROVIDERS[id];
  if (!base) return null;
  return {
    ...base,
    baseUrl: override.baseUrl ?? base.baseUrl,
    model: override.model ?? base.model,
  };
}

/**
 * Провайдеры, которым можно отправлять данные при sensitive: false.
 * В режиме конфиденциальности остаётся только локальный.
 * @param {string[]} chain
 * @param {boolean} sensitive
 * @returns {string[]}
 */
export function externalOnly(chain, sensitive) {
  if (!sensitive) return chain;
  return chain.filter((id) => PROVIDERS[id]?.external === false);
}
