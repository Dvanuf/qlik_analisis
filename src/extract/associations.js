/**
 * Связи между таблицами (нужны правилу про внешний join — R011).
 *
 * Метод getAssociationScores есть не во всех API: в QIX App API его нет,
 * а в Doc API он требует две строки — имена сравниваемых таблиц.
 * Поэтому вызов делается по парам таблиц, у которых есть общие поля
 * (кандидаты на связь), и ответ приводится к тому виду, который ждёт правило.
 */

/** Надпись о недоступности связей (без текста ошибки сервера). */
export const ASSOCIATIONS_UNAVAILABLE = 'Связи между таблицами недоступны в этой версии API — правило R011 не применимо.';

/** Кардинальность связи «один к одному». */
export const CARDINALITY_ONE_TO_ONE = '1:1';

/**
 * Приводит ответ getAssociationScores к виду, который читает правило R011.
 *
 * Сервер отдаёт оценку по парам полей: у каждой стороны есть qFieldName,
 * qCardinalRatio (доля уникальных значений) и оценки совпадения qSymbolScore
 * и qRowScore.
 *
 * Связь «один к одному» — это не просто уникальность обоих полей: нужны ещё
 * и полное совпадение их значений (оценки совпадения равны 1). Иначе связь
 * была бы объявлена там, где значения полей просто не пересекаются.
 *
 * @param {object[]} score — ответ сервера (qScore)
 * @param {string} [table] — имя первой таблицы пары (сервер его не присылает)
 * @param {string} [table2] — имя второй таблицы пары
 * @returns {object[]} связи в виде {qTable, qField, qCardinality}
 */
export function normalizeAssociations(score, table = '', table2 = '') {
  const out = [];
  for (const item of score ?? []) {
    const left = item?.qField1Scores ?? {};
    const right = item?.qField2Scores ?? {};
    const bothUnique = Number(left.qCardinalRatio) === 1 && Number(right.qCardinalRatio) === 1;
    if (!bothUnique) continue;
    // Полное совпадение значений: без него связи между таблицами нет.
    const matched = Number(left.qSymbolScore) === 1
      && Number(right.qSymbolScore) === 1
      && Number(left.qRowScore) === 1
      && Number(right.qRowScore) === 1;
    if (!matched) continue;
    out.push({
      qTable: String(table ?? ''),
      qTable2: String(table2 ?? ''),
      qField: String(left.qFieldName ?? item.qFieldPairName ?? ''),
      qFieldPair: String(item.qFieldPairName ?? ''),
      qCardinality: CARDINALITY_ONE_TO_ONE,
    });
  }
  return out;
}

/**
 * Подбирает пары таблиц с общими полями — их связь стоит проверить.
 *
 * @param {{name: string, fields?: string[]}[]} tables — таблицы модели данных
 * @param {number} [maxPairs] — предел числа запросов к серверу
 * @returns {[string, string][]} пары имён таблиц
 */
export function candidatePairs(tables, maxPairs = 20) {
  const pairs = [];
  const list = tables ?? [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const fieldsA = new Set((a.fields ?? []).map((f) => String(f).toLowerCase()));
      const shared = (b.fields ?? []).some((f) => fieldsA.has(String(f).toLowerCase()));
      if (!shared) continue;
      pairs.push([String(a.name), String(b.name)]);
      if (pairs.length >= maxPairs) return pairs;
    }
  }
  return pairs;
}

/**
 * Запрашивает связи между таблицами.
 *
 * @param {object} app — объект приложения (App QIX или документ Doc API)
 * @param {{name: string, fields?: string[]}[]} [tables] — таблицы модели данных
 * @returns {Promise<{associations: object[]|null, reason: string}>}
 *   associations — массив связей либо null, если их получить не удалось;
 *   reason — причина недоступности (пустая строка, если связи получены).
 */
export async function fetchAssociations(app, tables = []) {
  if (typeof app?.getAssociationScores !== 'function') {
    return { associations: null, reason: `${ASSOCIATIONS_UNAVAILABLE} Метод отсутствует в API.` };
  }

  const pairs = candidatePairs(tables);
  if (!pairs.length) {
    // Сравнивать нечего: ни у одной пары таблиц нет общих полей.
    return { associations: [], reason: '' };
  }

  const associations = [];
  let lastError = '';
  for (const [first, second] of pairs) {
    try {
      // Метод ждёт две строки — имена таблиц. Массивы и числа он отвергает.
      const result = await app.getAssociationScores(first, second);
      const score = result?.qScore ?? result;
      associations.push(...normalizeAssociations(Array.isArray(score) ? score : [], first, second));
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
  }

  if (lastError && !associations.length) {
    return { associations: null, reason: `${ASSOCIATIONS_UNAVAILABLE} (${lastError})` };
  }
  if (lastError) {
    return {
      associations,
      reason: `Часть пар таблиц не проверена: ${lastError}`,
    };
  }
  return { associations, reason: '' };
}
