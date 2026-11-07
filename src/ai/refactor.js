/**
 * ИИ-рефакторинг скрипта загрузки.
 *
 * В отличие от чата, в запрос уходит сам скрипт (с обрезкой по длине) и
 * перечень правок от правил, а ответ — предложенная версия скрипта.
 * Ответ никогда не применяется автоматически: интерфейс показывает его
 * отдельным слоем, пользователь решает сам.
 *
 * Технически построено поверх единой точки входа ИИ-слоя (analyze): свой
 * системный промпт и сообщение пользователя через override. Обезличивание,
 * лимиты, кэш и цепочка провайдеров работают как в чате — скрипт попадает
 * в override.user, а тот входит в ключ кэша, поэтому ответы разных
 * приложений не смешиваются.
 */
import { analyze as aiAnalyze } from './index.js';

/** Предел длины скрипта в запросе (символы): примерно 6 тысяч токенов. */
export const MAX_SCRIPT_CHARS = 24000;

export const REFACTOR_SYSTEM_PROMPT = [
  'Ты — старший разработчик скриптов Qlik Sense и QlikView.',
  'Тебе передают скрипт загрузки приложения и перечень замечаний статического анализа.',
  '',
  'Правила ответа:',
  '1. Отвечай на русском языке.',
  '2. Верни улучшенную версию скрипта ЦЕЛИКОМ в одном блоке кода (```…```),',
  '   сохранив смысл загрузки. Не выдумывай поля, таблицы и источники, которых нет.',
  '3. Исправляй только то, что указано в замечаниях, и очевидные сопутствующие проблемы:',
  '   неиспользуемые поля и таблицы, отсутствующие метки таблиц, дубли операторов,',
  '   отсутствие AutoNumber для составных ключей, неиспользуемые переменные.',
  '4. После блока кода дай короткий перечень изменений: что и почему, по пунктам.',
  '5. Если замечание спорное — не применяй его и объясни риск в перечне изменений.',
  '6. Не меняй имена таблиц и полей, кроме случаев, прямо указанных в замечаниях.',
  '7. Если скрипт обрезан — обработай видимую часть и скажи об этом прямо.',
].join('\n');

/**
 * Пользовательское сообщение запроса рефакторинга.
 *
 * @param {{script: string, findings?: Array<object>, appName?: string}} data
 * @returns {{system: string, user: string, truncated: boolean}}
 */
export function buildRefactorOverride({ script, findings = [], appName = '' } = {}) {
  const src = String(script ?? '');
  const truncated = src.length > MAX_SCRIPT_CHARS;
  const visible = truncated ? src.slice(0, MAX_SCRIPT_CHARS) : src;
  const title = String(appName ?? '').trim();
  const notes = (findings ?? [])
    .filter((f) => f?.fix)
    .slice(0, 40)
    .map((f) => `- ${f.ruleId}: ${f.title}${f.message ? ` — ${f.message}` : ''}`);
  const user = [
    title ? `Приложение: ${title}` : 'Приложение Qlik.',
    '',
    'Замечания статического анализа с готовыми правками:',
    notes.length ? notes.join('\n') : '- существенных замечаний нет, предложи общие улучшения качества',
    '',
    truncated
      ? `Скрипт загрузки (обрезан до ${MAX_SCRIPT_CHARS} символов):`
      : 'Скрипт загрузки:',
    '```',
    visible,
    '```',
  ].join('\n');
  return { system: REFACTOR_SYSTEM_PROMPT, user, truncated };
}

/**
 * Извлекает предложенный скрипт из ответа модели: самый большой блок кода.
 * Если блоков нет — возвращается весь текст (модель могла ответить без разметки).
 *
 * @param {string} text
 * @returns {{script: string, commentary: string}}
 */
export function extractScriptFromAnswer(text) {
  const src = String(text ?? '');
  const blocks = [...src.matchAll(/```(?:[a-z]*)\n?([\s\S]*?)```/gi)]
    .map((m) => m[1])
    .filter((b) => b.trim());
  if (!blocks.length) return { script: src.trim(), commentary: '' };
  const script = blocks.reduce((a, b) => (b.length > a.length ? b : a)).trim();
  const commentary = src.replace(/```(?:[a-z]*)\n?[\s\S]*?```/gi, '').trim();
  return { script, commentary };
}

/**
 * Запрос улучшенной версии скрипта у ИИ-цепочки.
 *
 * @param {{script: string, findings?: Array<object>, appName?: string}} data
 * @param {object} [options] — те же, что у analyze ИИ-слоя
 *   (provider, fallback, apiKeys, sensitive, providers, limits, statePath,
 *   signal, onEvent)
 * @returns {Promise<{script: string, commentary: string, text: string,
 *   provider: string, model: string, truncated: boolean, redacted: boolean,
 *   cached: boolean}>}
 */
export async function refactorScript(data = {}, options = {}) {
  const override = buildRefactorOverride(data);
  const answer = await aiAnalyze('', {}, {
    ...options,
    override,
  });
  const { script, commentary } = extractScriptFromAnswer(answer.text);
  return {
    script,
    commentary,
    text: answer.text,
    provider: answer.provider,
    model: answer.model,
    // Скрипт обрезан на входе или ответ пришёл из кэша — обе пометки важны.
    truncated: override.truncated,
    redacted: answer.redacted,
    cached: answer.cached,
  };
}
