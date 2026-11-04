/**
 * Хранение переписки ИИ-чата в localStorage.
 *
 * История ведётся отдельно для каждого приложения: ключ строится из
 * идентификатора анализа, поэтому переписка по разным приложениям не
 * смешивается. Хранилище — абстракция с getItem/setItem, а не сам
 * localStorage: модуль не зависит от DOM и проверяется обычными тестами.
 */

/** Префикс ключа в localStorage. */
export const CHAT_PREFIX = 'qa.ai.chat.';

/** Сколько последних сообщений храним на одно приложение. */
export const MAX_MESSAGES = 100;

/** Предельная длина текста одного сообщения. */
export const MAX_MESSAGE_LENGTH = 8000;

/**
 * Сообщение переписки.
 * @typedef {{role: 'user' | 'assistant', text: string, provider?: string, note?: string}} ChatMessage
 */

/**
 * Ключ истории для результата анализа.
 * @param {object|null} analysis — { appId?, file?, appName? }
 * @returns {string}
 */
export function chatKey(analysis) {
  const id = String(analysis?.appId ?? '').trim();
  if (id) return `${CHAT_PREFIX}${id}`;
  const file = String(analysis?.file ?? '').trim();
  if (file) return `${CHAT_PREFIX}file.${file}`;
  return `${CHAT_PREFIX}default`;
}

/**
 * Прочитать сохранённую переписку.
 * @param {{getItem: (key: string) => string|null}} storage
 * @param {string} key
 * @returns {ChatMessage[]}
 */
export function loadChat(storage, key) {
  if (!storage) return [];
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((m) => m && typeof m.text === 'string'
      && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      text: m.text.slice(0, MAX_MESSAGE_LENGTH),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.note ? { note: m.note } : {}),
    }))
    .slice(-MAX_MESSAGES);
}

/**
 * Сохранить переписку. Ошибка записи (переполнение, запрет) не должна
 * ломать чат — молча пропускаем.
 * @param {{setItem: (key: string, value: string) => void}} storage
 * @param {string} key
 * @param {ChatMessage[]} messages
 * @returns {boolean} — записано ли
 */
export function saveChat(storage, key, messages) {
  if (!storage || !Array.isArray(messages)) return false;
  const payload = messages
    .filter((m) => m && typeof m.text === 'string'
      && (m.role === 'user' || m.role === 'assistant'))
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      text: String(m.text).slice(0, MAX_MESSAGE_LENGTH),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.note ? { note: m.note } : {}),
    }));
  try {
    storage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
