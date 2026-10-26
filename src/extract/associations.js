/**
 * Связи между таблицами (нужны правилу про внешний join — R011).
 *
 * Метод getAssociationScores есть только в QIX (Qlik Sense). В Doc API
 * (QlikView 12) его нет — это ограничение платформы, а не сбой, поэтому
 * текст ответа сервера сохраняется: по нему видно, поддерживает ли сервер
 * метод и почему нет.
 */

/** Надпись о недоступности связей (без текста ошибки сервера). */
export const ASSOCIATIONS_UNAVAILABLE = 'Связи между таблицами недоступны в этой версии API — правило R011 не применимо.';

/**
 * Запрашивает связи между таблицами.
 *
 * @param {object} app — объект приложения (App QIX или документ Doc API)
 * @returns {Promise<{associations: object[]|null, reason: string}>}
 *   associations — массив связей либо null, если их получить не удалось;
 *   reason — причина недоступности (пустая строка, если связи получены).
 */
export async function fetchAssociations(app) {
  let associations = null;
  let reason = '';

  try {
    const result = await app.getAssociationScores?.([], [], 0);
    if (Array.isArray(result)) associations = result;
    else reason = ASSOCIATIONS_UNAVAILABLE;
  } catch (err) {
    const detail = err?.message ?? String(err);
    reason = `${ASSOCIATIONS_UNAVAILABLE} (${detail})`;
  }

  return { associations, reason };
}
