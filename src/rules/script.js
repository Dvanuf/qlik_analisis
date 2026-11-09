/**
 * Правила категории Script — анализ скрипта загрузки.
 * Синтаксис скрипта у Qlik Sense и QlikView общий: правила работают для обоих.
 * Сервер не нужен — достаточно текста скрипта.
 */
import { canonicalFieldName } from '../normalize.js';
import { analyzeScriptIntegrity } from '../script/integrity.js';
import { matchesExcludedTable } from './settings.js';

const CATEGORY = 'Script';

const SEVERITY = {
  S001: 'warning', S002: 'info', S003: 'warning', S004: 'info',
  S005: 'warning', S006: 'warning', S007: 'info', S008: 'info',
  S009: 'warning', S010: 'error', S011: 'info', S012: 'info', S013: 'info',
  S014: 'error', S015: 'warning', S016: 'warning', S017: 'info', S018: 'info', S019: 'error',
  S020: 'error',
};

/**
 * Находка скриптового правила.
 * Дополнительно можно передать важность (понижение), номер строки и таблицу —
 * они нужны для привязки к скрипту и для подавления.
 */
const finding = (ruleId, title, target, message, detail, recommendation, extra = {}) => ({
  ruleId,
  category: CATEGORY,
  severity: extra.severity ?? SEVERITY[ruleId] ?? 'info',
  title,
  target,
  message,
  detail,
  recommendation,
  ...(extra.line != null ? { line: extra.line } : {}),
  ...(extra.column != null ? { column: extra.column } : {}),
  ...(extra.table ? { table: extra.table } : {}),
});

/** Глубина цепочки RESIDENT: 0 — прямая загрузка, 2+ — цепочка перезаписей. */
function residentDepth(model) {
  const depth = new Map();
  const origin = new Map();
  for (const l of model.loads) origin.set(l.table, { kind: 'load' });
  // RESIDENT: r.table — исходная таблица, r.target — таблица-результат.
  for (const r of model.residents) {
    if (r.target) origin.set(r.target, { kind: 'resident', from: r.table });
  }

  const resolve = (name, seen = new Set()) => {
    if (depth.has(name)) return depth.get(name);
    if (seen.has(name)) return 0;
    seen.add(name);
    const info = origin.get(name);
    if (!info || info.kind !== 'resident') { depth.set(name, 0); return 0; }
    const d = resolve(info.from, seen) + 1;
    depth.set(name, d);
    return d;
  };
  for (const r of model.residents) if (r.target) resolve(r.target);
  return depth;
}

export const scriptRules = [
  {
    id: 'S001',
    category: CATEGORY,
    severity: SEVERITY.S001,
    title: 'Загрузка без явного списка полей',
    humanTitle: 'LOAD тянет все поля источника',
    whatHappened: 'LOAD * переносит в модель все поля источника, включая ненужные — лишняя память и риск ключей.',
    description: 'LOAD без перечисления полей тянет в память все поля источника — при изменении источника модель меняется молча.',
    recommendation: 'Перечислите поля явно: LOAD field1, field2 FROM ...',
    run(ctx) {
      const out = [];
      for (const l of ctx.script.loads) {
        if (!l.allFields) continue;
        out.push(finding('S001', 'Загрузка без явного списка полей',
          { kind: 'table', name: l.table, id: l.table },
          `Таблица «${l.table}» загружается без списка полей`,
          `Источник: ${l.source || 'не указан'}`,
          'Указать список полей явно.',
          { line: l.line, table: l.table }));
      }
      return out;
    },
  },

  {
    id: 'S002',
    category: CATEGORY,
    severity: SEVERITY.S002,
    title: 'Загрузка без фильтра WHERE',
    humanTitle: 'Таблица грузится без фильтра',
    whatHappened: 'Данные грузятся целиком и фильтруются уже в памяти Qlik — быстрее фильтровать в источнике.',
    description: 'Данные грузятся целиком и фильтруются уже в памяти Qlik.',
    recommendation: 'Добавить WHERE в LOAD, чтобы сократить объём памяти при загрузке.',
    run(ctx) {
      const out = [];
      // Служебные таблицы (Fields, Info, tmp_*) исключаются: они грузятся целиком
      // по умолчанию, и на них предупреждение только создаёт шум.
      const excluded = ctx.config?.exclusions?.S002?.tables ?? [];
      for (const l of ctx.script.loads) {
        if (l.hasWhere || !l.source) continue;
        if (matchesExcludedTable(l.table, excluded)) continue;
        out.push(finding('S002', 'Загрузка без фильтра WHERE',
          { kind: 'table', name: l.table, id: l.table },
          `Таблица «${l.table}» загружается без WHERE`,
          `Источник: ${l.source}`,
          'Перенести фильтрацию в LOAD (WHERE).',
          { line: l.line, table: l.table }));
      }
      return out;
    },
  },

  {
    id: 'S003',
    category: CATEGORY,
    severity: SEVERITY.S003,
    title: 'Цепочка RESIDENT',
    humanTitle: 'Цепочка RESIDENT-таблиц',
    whatHappened: 'Таблица строится из промежуточной, которая тоже построена из RESIDENT — данные копируются по цепочке.',
    description: 'Таблица строится из таблицы, построенной из RESIDENT — данные переписываются в памяти несколько раз.',
    recommendation: 'Свести трансформации в одну операцию либо использовать промежуточные QVD.',
    run(ctx) {
      const out = [];
      for (const [table, d] of residentDepth(ctx.script)) {
        if (d < 2) continue;
        out.push(finding('S003', 'Цепочка RESIDENT',
          { kind: 'table', name: table, id: table },
          `Таблица «${table}» построена через цепочку RESIDENT (глубина ${d})`,
          'Данные перезаписываются в памяти несколько раз подряд.',
          'Объединить трансформации или сохранять промежуточный результат в QVD.',
          { table }));
      }
      return out;
    },
  },

  {
    id: 'S004',
    category: CATEGORY,
    severity: SEVERITY.S004,
    title: 'CONCATENATE без NoConcatenate',
    humanTitle: 'CONCATENATE без NoConcatenate',
    whatHappened: 'Склеивание таблиц без явного флага создаёт синтетический ключ и путает строки.',
    description: 'CONCATENATE без флага NoConcatenate создаёт синтетический ключ, если у таблиц разные наборы полей.',
    recommendation: 'Использовать CONCATENATE(...) с NoConcatenate и явно описать ключ.',
    run(ctx) {
      const out = [];
      for (const c of ctx.script.concatenates) {
        if (c.hasNoConcatenate) continue;
        out.push(finding('S004', 'CONCATENATE без NoConcatenate',
          { kind: 'table', name: c.target || '?', id: c.target || '?' },
          `CONCATENATE для «${c.target || 'неизвестной таблицы'}» без NoConcatenate`,
          'При разных наборах полей Qlik создаст синтетический ключ.',
          'Добавить NoConcatenate и проверить наборы полей.',
          { line: c.line, table: c.target }));
      }
      return out;
    },
  },

  {
    id: 'S005',
    category: CATEGORY,
    severity: SEVERITY.S005,
    title: 'Повторная загрузка таблицы',
    humanTitle: 'Таблица загружается повторно',
    whatHappened: 'Одна и та же таблица загружается несколько раз — риск задвоения строк.',
    description: 'Одна и та же таблица загружается несколько раз — риск задвоения или потери данных.',
    recommendation: 'Объединить загрузки или явно переименовать целевую таблицу (INTO).',
    run(ctx) {
      const out = [];
      const seen = new Map();
      for (const l of ctx.script.loads) {
        const key = canonicalFieldName(l.table);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const [key, count] of seen) {
        if (count < 2) continue;
        const name = ctx.script.loads.find((l) => canonicalFieldName(l.table) === key)?.table;
        if (!name) continue; // загрузка без имени — не показываем
        out.push(finding('S005', 'Повторная загрузка таблицы',
          { kind: 'table', name, id: name },
          `Таблица «${name}» загружается ${count} раза`,
          'Возможны задвоенные строки или потеря данных.',
          'Объединить загрузки в одну или развести по разным именам.',
          { table: name }));
      }
      return out;
    },
  },

  {
    id: 'S006',
    category: CATEGORY,
    severity: SEVERITY.S006,
    title: 'JOIN по неключевому полю',
    humanTitle: 'JOIN по неключевому полю',
    whatHappened: 'Соединение по полю без ключа может дать декартово произведение строк.',
    description: 'JOIN по полю, которое не является ключом, — движок создаёт синтетический ключ и join дорожает.',
    recommendation: 'Соединять по ключевым полям либо заранее подготовить ключ AutoNumber.',
    run(ctx) {
      const out = [];
      if (!ctx.index?.fieldMeta) return out;
      const fieldRe = /\[([^\]]+)\]|"([^"]+)"|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
      for (const j of ctx.script.joins) {
        const fields = [];
        let m;
        while ((m = fieldRe.exec(j.source ?? '')) !== null) {
          const name = (m[1] ?? m[2] ?? m[3] ?? '').trim();
          if (name && !/^(IN|ON|AND|OR)$/i.test(name)) fields.push(name);
        }
        for (const f of fields) {
          const meta = ctx.index.fieldMeta.get(canonicalFieldName(f));
          if (!meta || meta.isKey || meta.key) continue;
          out.push(finding('S006', 'JOIN по неключевому полю',
            { kind: 'table', name: j.table || '(текущая)', id: j.table || '' },
            `JOIN (${j.joinType}) по полю «${f}», которое не является ключом`,
            j.raw.slice(0, 160),
            'Соединять по ключу или создать ключ AutoNumber.',
            { line: j.line, table: j.table }));
        }
      }
      return out;
    },
  },

  {
    id: 'S007',
    category: CATEGORY,
    severity: SEVERITY.S007,
    title: 'В скрипте нет DROP FIELD',
    humanTitle: 'Служебные поля остаются в модели',
    whatHappened: 'После загрузки служебные поля не удалены — они занимают память при каждой перезагрузке.',
    description: 'Служебные поля остаются в модели данных и занимают память приложения.',
    recommendation: 'Добавить DROP FIELD в конец скрипта для полей, не используемых во фронт-энде.',
    run(ctx) {
      if (ctx.script.hasDropField) return [];
      const loaded = ctx.script.loads.length;
      if (!loaded) return [];
      return [finding('S007', 'В скрипте нет DROP FIELD',
        { kind: 'app', name: 'скрипт загрузки', id: 'script' },
        `Ни одного DROP FIELD при ${loaded} загрузк(ах)`,
        'Все загруженные поля остаются в памяти приложения.',
        'Проверить модель данных и добавить DROP FIELD для неиспользуемых полей.')];
    },
  },

  {
    id: 'S008',
    category: CATEGORY,
    severity: SEVERITY.S008,
    title: 'Неиспользуемая переменная скрипта',
    humanTitle: 'Переменная скрипта не используется',
    whatHappened: 'Переменная объявлена в скрипте, но нигде не используется.',
    description: 'Переменная объявлена, но нигде в скрипте не используется.',
    recommendation: 'Удалить объявление.',
    run(ctx) {
      const out = [];
      const script = String(ctx.graph.script ?? '');
      // Переменная может использоваться только во фронт-энде — без сведений
      // от движка это недоказуемо, поэтому без них проверка не выполняется.
      const hasFrontEnd = ctx.index?.frontEndUsageKnown === true;
      if (!hasFrontEnd) {
        return {
          findings: [],
          note: 'Пропущено: без данных фронт-енда нельзя доказать, что переменная не используется в чартах.',
        };
      }
      for (const v of ctx.script.variables) {
        if (!v.name) continue;
        if (new RegExp(`\\$\\{?${v.name}\\b`, 'i').test(script)) continue;
        out.push(finding('S008', 'Неиспользуемая переменная скрипта',
          { kind: 'variable', name: v.name, id: v.name },
          `Переменная «${v.name}» объявлена, но не используется`,
          v.raw.slice(0, 160),
          'Удалить объявление из скрипта.'));
      }
      return out;
    },
  },

  {
    id: 'S009',
    category: CATEGORY,
    severity: SEVERITY.S009,
    title: 'Ссылка на неизвестную таблицу',
    humanTitle: 'Ссылка на несуществующую таблицу',
    whatHappened: 'RESIDENT или JOIN ссылается на таблицу, которой к этому моменту нет — загрузка упадёт.',
    description: 'Оператор RESIDENT или JOIN ссылается на таблицу, которая не загружается в этом скрипте.',
    recommendation: 'Исправить имя таблицы либо загрузить её раньше по скрипту.',
    run(ctx) {
      const out = [];
      const known = new Set([
        ...ctx.script.loads.map((l) => canonicalFieldName(l.table)),
        ...ctx.script.residents.map((r) => canonicalFieldName(r.target)).filter(Boolean),
        ...ctx.script.into.map((i) => canonicalFieldName(i.table)).filter(Boolean),
      ]);

      // Системные/сессионные таблицы Qlik Sense (tmp_qs_sess и подобные) создаёт движок,
      // а не скрипт — на них не жалуемся.
      const isSystemTable = (name) => /^(tmp_|sys_|__)/i.test(name);
      const check = (table, raw, kind, line) => {
        if (!table || known.has(canonicalFieldName(table))) return;
        if (isSystemTable(table)) return;
        out.push(finding('S009', 'Ссылка на неизвестную таблицу',
          { kind: 'table', name: table, id: table },
          `${kind} ссылается на таблицу «${table}», которой нет в скрипте`,
          raw.slice(0, 160),
          'Исправить имя или добавить загрузку этой таблицы.',
          { line, table }));
      };
      for (const r of ctx.script.residents) check(r.table, r.raw, 'RESIDENT', r.line);
      for (const j of ctx.script.joins) check(j.table, j.raw, 'JOIN', j.line);
      return out;
    },
  },

  {
    id: 'S010',
    category: CATEGORY,
    severity: SEVERITY.S010,
    title: 'Структурная ошибка в скрипте',
    humanTitle: 'Скрипт со структурной ошибкой',
    whatHappened: 'Незакрытая строка или скобка — перезагрузка приложения упадёт.',
    description: 'Скрипт содержит незакрытую строку или скобки — загрузка упадёт.',
    recommendation: 'Исправить скрипт (Ctrl+ → Check syntax в редакторе).',
    run(ctx) {
      const out = [];
      // Целостность скрипта: если текст пришёл не полностью, «незакрытая строка»
      // означает дефект чтения, а не дефект скрипта — важность понижается.
      const info = ctx.graph.meta?.scriptInfo ?? analyzeScriptIntegrity(ctx.graph.script);
      const maybePartial = info.truncated || info.maybeTruncated;
      for (const p of info.problems) {
        out.push(finding('S010', 'Структурная ошибка в скрипте',
          { kind: 'app', name: 'скрипт загрузки', id: 'script' },
          maybePartial ? `${p.message} — возможно, скрипт получен не полностью` : p.message,
          `Код: ${p.code}. ${maybePartial
            ? 'Скрипт прочитан не полностью (нет завершающей «;» или строка не закрыта) — проверка может давать ложные срабатывания.'
            : 'Проверьте скрипт в редакторе Qlik (Ctrl+ → Check syntax).'}`,
          'Исправить скрипт и проверить синтаксис.',
          { severity: maybePartial ? 'warning' : SEVERITY.S010, line: p.line }));
      }
      return out;
    },
  },

  {
    id: 'S011',
    category: CATEGORY,
    severity: SEVERITY.S011,
    title: 'Скрипт без комментариев',
    humanTitle: 'Скрипт без комментариев',
    whatHappened: 'В скрипте нет ни одного комментария — поддерживать его будет тяжело.',
    description: 'В скрипте нет ни одного комментария — его невозможно понять без владельца.',
    recommendation: 'Документировать секции загрузки комментариями.',
    run(ctx) {
      if (ctx.script.comments.length > 0) return [];
      return [finding('S011', 'Скрипт без комментариев',
        { kind: 'app', name: 'скрипт загрузки', id: 'script' },
        'В скрипте нет ни одного комментария',
        `Операторов: ${ctx.script.loads.length + ctx.script.others.length}`,
        'Добавить комментарии к секциям загрузки.')];
    },
  },

  {
    id: 'S012',
    category: CATEGORY,
    severity: SEVERITY.S012,
    title: 'Загрузка файла без указания формата',
    humanTitle: 'Загрузка файла без формата',
    whatHappened: 'Для файла не указан формат — Qlik угадывает его и тратит время на каждый прогон.',
    description: 'Для файла не задан формат (txt, qvd, csv, ...) — Qlik тратит время на определение структуры.',
    recommendation: 'Указать формат явно: FROM \'file.csv\' (txt, delimiter is \',\', embedded labels).',
    run(ctx) {
      const out = [];
      for (const l of ctx.script.loads) {
        const src = l.source ?? '';
        if (!src || !/\.(csv|txt|tsv|qvd|xlsx?|parquet|json)\b/i.test(src)) continue;
        if (/\(\s*(txt|csv|qvd|fixed|excel|parquet|json|xml)\b/i.test(l.raw)) continue;
        out.push(finding('S012', 'Загрузка файла без указания формата',
          { kind: 'table', name: l.table, id: l.table },
          `Файл «${src}» загружается без указания формата`,
          'Qlik будет определять структуру автоматически — медленно и нестабильно.',
          'Указать формат явно в скобках после имени файла.',
          { line: l.line, table: l.table }));
      }
      return out;
    },
  },

  {
    id: 'S013',
    category: CATEGORY,
    severity: SEVERITY.S013,
    title: 'Недостижимый код после EXIT SCRIPT',
    humanTitle: 'Код после EXIT SCRIPT',
    whatHappened: 'После безусловного EXIT SCRIPT остались операторы — они никогда не выполнятся.',
    description: 'После безусловного EXIT SCRIPT остались операторы — они никогда не выполняются.',
    recommendation: 'Удалить недостижимый код или убрать EXIT SCRIPT, если он не нужен.',
    run(ctx) {
      const out = [];
      const exits = ctx.script.exits ?? [];
      if (!exits.length) return out;
      // Безусловный EXIT SCRIPT — последний в скрипте: после него код не идёт.
      const last = exits[exits.length - 1];
      // Оператор после выхода может оказаться в любой части разбора:
      // переменной, загрузкой или «прочим» — собираем их все.
      const after = [
        ...(ctx.script.variables ?? []).map((v) => ({ line: v.line, raw: v.raw })),
        ...(ctx.script.loads ?? []).map((l) => ({ line: l.line, raw: l.raw })),
        ...(ctx.script.others ?? []).map((o) => ({ line: o.line, raw: o.raw })),
      ].filter((st) => (st.line ?? 0) > last.line);
      for (const st of after) {
        out.push(finding('S013', 'Недостижимый код после EXIT SCRIPT',
          { kind: 'app', name: 'скрипт загрузки', id: 'script' },
          `После EXIT SCRIPT (строка ${last.line}) остался оператор — он не выполняется`,
          String(st.raw ?? '').slice(0, 160),
          'Удалить недостижимый код или убрать EXIT SCRIPT.',
          { line: st.line }));
      }
      return out;
    },
  },

  {
    id: 'S014',
    category: CATEGORY,
    severity: SEVERITY.S014,
    title: 'Ошибка в скрипте загрузки',
    humanTitle: 'Сервер сообщил об ошибке скрипта',
    whatHappened: 'Сервер проверил скрипт и нашёл ошибку с точной строкой — исправьте и перезагрузите приложение.',
    description: 'Сервер проверил скрипт и сообщил об ошибке — с указанием строки и колонки.',
    recommendation: 'Исправить скрипт в указанной строке и перезагрузить приложение.',
    run(ctx) {
      const out = [];
      // Ошибки отдаёт движок: он знает язык Qlik лучше нашего разбора
      // и указывает точное место — строку и колонку.
      const errors = ctx.graph.meta?.scriptErrors;
      if (!Array.isArray(errors)) {
        return {
          findings: [],
          note: 'Проверка синтаксиса на сервере недоступна (движок не отдал ошибки скрипта).',
        };
      }
      for (const e of errors) {
        const where = e.line ? `строка ${e.line}${e.column ? `, колонка ${e.column}` : ''}` : 'место указано сервером';
        out.push(finding('S014', 'Ошибка в скрипте загрузки',
          { kind: 'app', name: 'скрипт загрузки', id: 'script' },
          `Сервер сообщил об ошибке в скрипте (${where})`,
          e.message,
          'Исправить скрипт в указанном месте и перезагрузить приложение.',
          { line: e.line ?? undefined, column: e.column ?? undefined }));
      }
      return out;
    },
  },

  {
    // Правило для QlikView-легаси: Binary подтягивает модель из другого
    // документа — этот скрипт ломается молча, если источник переехал.
    id: 'S015',
    category: CATEGORY,
    severity: SEVERITY.S015,
    title: 'Скрипт начинается с Binary Load',
    humanTitle: 'Скрипт зависит от другого документа',
    whatHappened: 'Скрипт начинается с Binary — модель приходит из другого документа целиком, и его изменения ломают этот скрипт молча.',
    description: 'Оператор Binary подтягивает модель данных из другого приложения — явной зависимости нет ни в скрипте, ни в документации.',
    recommendation: 'Заменить Binary на явную загрузку нужных таблиц или зафиксировать источник и документировать зависимость.',
    run(ctx) {
      const out = [];
      const lines = String(ctx.graph?.script ?? '').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (/^\s*binary\s+\S/i.test(lines[i])) {
          out.push(finding('S015', 'Скрипт начинается с Binary Load',
            { kind: 'app', name: 'скрипт загрузки', id: 'script' },
            `Строка ${i + 1}: модель берётся из другого документа через Binary`,
            lines[i].trim().slice(0, 160),
            'Заменить Binary на явную загрузку нужных таблиц.',
            { line: i + 1 }));
          break;
        }
      }
      return out;
    },
  },

  {
    id: 'S016',
    category: CATEGORY,
    severity: SEVERITY.S016,
    title: 'ErrorMode отключён',
    humanTitle: 'Ошибки загрузки маскируются',
    whatHappened: 'ErrorMode=0 — ошибки загрузки не останавливают перезагрузку, и некачественные данные попадают в модель незаметно.',
    description: 'SET ErrorMode=0 заставляет перезагрузку продолжаться при ошибках операторов — сбои не видны в журнале выполнения.',
    recommendation: 'Убрать ErrorMode=0 или перейти на ErrorMode=2 (останов по ошибке) с обработкой ожидаемых сбоев.',
    run(ctx) {
      const out = [];
      const lines = String(ctx.graph?.script ?? '').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (/\bset\s+errormode\s*=\s*0\b/i.test(lines[i])) {
          out.push(finding('S016', 'ErrorMode отключён',
            { kind: 'app', name: 'скрипт загрузки', id: 'script' },
            `Строка ${i + 1}: ошибки загрузки игнорируются`,
            lines[i].trim().slice(0, 160),
            'Убрать ErrorMode=0 или обрабатывать ожидаемые сбои явно.',
            { line: i + 1 }));
        }
      }
      return out;
    },
  },

  {
    id: 'S017',
    category: CATEGORY,
    severity: SEVERITY.S017,
    title: 'Пауза Sleep в скрипте',
    humanTitle: 'Скрипт засыпает во время перезагрузки',
    whatHappened: 'Sleep ставит перезагрузку на паузу — время тратится на ожидание при каждом прогоне.',
    description: 'Оператор Sleep приостанавливает выполнение скрипта на заданное число секунд.',
    recommendation: 'Убрать Sleep или заменить на проверку готовности источника (например, существования файла).',
    run(ctx) {
      const out = [];
      const lines = String(ctx.graph?.script ?? '').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const m = /\bsleep\s*\(\s*(\d+)\s*\)/i.exec(lines[i]);
        if (m) {
          out.push(finding('S017', 'Пауза Sleep в скрипте',
            { kind: 'app', name: 'скрипт загрузки', id: 'script' },
            `Строка ${i + 1}: пауза ${m[1]} с на каждом прогоне`,
            lines[i].trim().slice(0, 160),
            'Убрать Sleep или заменить проверкой готовности источника.',
            { line: i + 1 }));
        }
      }
      return out;
    },
  },

  {
    id: 'S018',
    category: CATEGORY,
    severity: SEVERITY.S018,
    title: 'Include без Must_Include',
    humanTitle: 'Подключаемый файл может исчезнуть молча',
    whatHappened: 'Классический $(include=...) при отсутствии файла продолжает скрипт молча — часть логики выпадает без сигнала.',
    description: '$(include=...) не падает, если файл не найден: скрипт выполняется без подключённой логики.',
    recommendation: 'Для обязательных файлов использовать $(Must_Include=...) — при отсутствии загрузка упадёт сразу с понятной ошибкой.',
    run(ctx) {
      const out = [];
      const lines = String(ctx.graph?.script ?? '').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const m = /\$\(\s*include\s*=\s*([^)]+)\)/i.exec(lines[i]);
        if (m) {
          out.push(finding('S018', 'Include без Must_Include',
            { kind: 'app', name: 'скрипт загрузки', id: 'script' },
            `Строка ${i + 1}: файл подключается необязательно — при отсутствии скрипт продолжит молча`,
            lines[i].trim().slice(0, 160),
            'Для обязательных файлов использовать $(Must_Include=...).',
            { line: i + 1 }));
        }
      }
      return out;
    },
  },

  {
    id: 'S019',
    category: CATEGORY,
    severity: SEVERITY.S019,
    title: 'CALL несуществующей подпрограммы',
    humanTitle: 'Вызов подпрограммы, которой нет',
    whatHappened: 'CALL обращается к подпрограмме, не определённой в скрипте — перезагрузка упадёт при достижении вызова.',
    description: 'Оператор CALL вызывает SUB по имени; отсутствие определения приводит к ошибке выполнения.',
    recommendation: 'Определить подпрограмму (SUB … END SUB) или убрать вызов.',
    run(ctx) {
      const out = [];
      const lines = String(ctx.graph?.script ?? '').split(/\r?\n/);
      const subs = new Set();
      const calls = [];
      for (let i = 0; i < lines.length; i += 1) {
        const sm = /\bsub\s+([A-Za-z_][\w]*)/i.exec(lines[i]);
        if (sm) subs.add(sm[1].toLowerCase());
        const cm = /\bcall\s+([A-Za-z_][\w]*)/i.exec(lines[i]);
        if (cm) calls.push({ name: cm[1], line: i + 1, raw: lines[i].trim() });
      }
      for (const c of calls) {
        if (!subs.has(c.name.toLowerCase())) {
          out.push(finding('S019', 'CALL несуществующей подпрограммы',
            { kind: 'app', name: 'скрипт загрузки', id: 'script' },
            `Строка ${c.line}: CALL ${c.name} — подпрограмма не определена в скрипте`,
            c.raw.slice(0, 160),
            'Определить SUB или убрать вызов.',
            { line: c.line }));
        }
      }
      return out;
    },
  },

  {
    id: 'S020',
    category: CATEGORY,
    severity: SEVERITY.S020,
    title: 'Секрет в тексте скрипта',
    humanTitle: 'Пароль или токен открытым текстом',
    whatHappened: 'В скрипте задан пароль, токен или ключ API открытым текстом — он попадает в выгрузки, отчёты и историю.',
    description: 'В строках подключения и LET/SET встречается имя вида password/pwd/token/apikey/secret со значением-литералом. Секреты должны жить в Data Connection или переменных окружения CI.',
    recommendation: 'Вынести секрет в Data Connection или окружение CI и сменить скомпрометированное значение.',
    run(ctx) {
      const out = [];
      const lines = stripCommentsText(String(ctx.graph?.script ?? '')).split(/\r?\n/);
      // Имя секрета: допускается префикс переменной v/v_ (vPassword, v_token).
      const SECRET_NAME = /(?:^|[^\w])(?:v_?)?(?:password|passwd|pwd|userpassword|token|apikey|api[_-]?key|secret|secretofkey)(?:[^\w]|$)/i;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!SECRET_NAME.test(line)) continue;
        // Значение: после «=» или «:» — строка в кавычках или длинный литерал без $( )-подстановки.
        const m = /(?:=|:)\s*('?)([^'";]{4,})\1/.exec(line);
        if (!m) continue;
        const value = m[2].trim();
        // Подстановки $(...), пустые и технические значения — не секрет.
        if (!value || value.includes('$(')) continue;
        if (/^(true|false|null|none|нет|test|демо)$/i.test(value)) continue;
        out.push(finding('S020', 'Секрет в тексте скрипта',
          { kind: 'app', name: 'скрипт загрузки', id: 'script' },
          `Строка ${i + 1}: похоже, задан секрет открытым текстом (значение скрыто)`,
          line.replace(m[2], '***').trim().slice(0, 160),
          'Вынести секрет в Data Connection или окружение CI; сменить скомпрометированное значение.',
          { line: i + 1 }));
      }
      return out;
    },
  },
];

/** Убирает комментарии «//» и блочные — секреты в комментариях не флагаются. */
function stripCommentsText(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
