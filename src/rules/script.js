/**
 * Правила категории Script — анализ скрипта загрузки.
 * Синтаксис скрипта у Qlik Sense и QlikView общий: правила работают для обоих.
 * Сервер не нужен — достаточно текста скрипта.
 */
import { canonicalFieldName } from '../normalize.js';
import { stripComments } from '../script/parse.js';

const CATEGORY = 'Script';

const SEVERITY = {
  S001: 'warning', S002: 'info', S003: 'warning', S004: 'info',
  S005: 'warning', S006: 'warning', S007: 'info', S008: 'info',
  S009: 'warning', S010: 'error', S011: 'info', S012: 'info',
};

const finding = (ruleId, title, target, message, detail, recommendation) => ({
  ruleId,
  category: CATEGORY,
  severity: SEVERITY[ruleId] ?? 'info',
  title,
  target,
  message,
  detail,
  recommendation,
});

/** Структурная проверка скрипта: незакрытые строки и скобки. */
function checkScriptStructure(script) {
  const problems = [];
  // Комментарии убираем: апостроф в комментарии («Don't») не должен считаться строкой.
  const src = stripComments(String(script ?? ''));
  let quote = null;
  let depth = 0;
  let line = 1;
  let brackets = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\n') line += 1;
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      // Открывает строку только при наличии закрывающей кавычки дальше.
      if (src.indexOf(c, i + 1) === -1) {
        problems.push({ code: 'UNCLOSED_STRING', message: `Незакрытая строковая константа (строка ${line})` });
      } else {
        quote = c;
      }
      continue;
    }
    if (c === '[') { brackets += 1; continue; }
    if (c === ']') { brackets = Math.max(0, brackets - 1); continue; }
    if (brackets > 0) continue; // внутри пути ([lib://…]) скобки не считаем
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
  }
  if (depth > 0) problems.push({ code: 'UNCLOSED_PAREN', message: `Незакрытых круглых скобок: ${depth}` });
  if (depth < 0) problems.push({ code: 'EXTRA_PAREN', message: 'Лишняя закрывающая скобка' });
  return problems;
}

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
          'Указать список полей явно.'));
      }
      return out;
    },
  },

  {
    id: 'S002',
    category: CATEGORY,
    severity: SEVERITY.S002,
    title: 'Загрузка без фильтра WHERE',
    description: 'Данные грузятся целиком и фильтруются уже в памяти Qlik.',
    recommendation: 'Добавить WHERE в LOAD, чтобы сократить объём памяти при загрузке.',
    run(ctx) {
      const out = [];
      for (const l of ctx.script.loads) {
        if (l.hasWhere || !l.source) continue;
        out.push(finding('S002', 'Загрузка без фильтра WHERE',
          { kind: 'table', name: l.table, id: l.table },
          `Таблица «${l.table}» загружается без WHERE`,
          `Источник: ${l.source}`,
          'Перенести фильтрацию в LOAD (WHERE).'));
      }
      return out;
    },
  },

  {
    id: 'S003',
    category: CATEGORY,
    severity: SEVERITY.S003,
    title: 'Цепочка RESIDENT',
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
          'Объединить трансформации или сохранять промежуточный результат в QVD.'));
      }
      return out;
    },
  },

  {
    id: 'S004',
    category: CATEGORY,
    severity: SEVERITY.S004,
    title: 'CONCATENATE без NoConcatenate',
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
          'Добавить NoConcatenate и проверить наборы полей.'));
      }
      return out;
    },
  },

  {
    id: 'S005',
    category: CATEGORY,
    severity: SEVERITY.S005,
    title: 'Повторная загрузка таблицы',
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
          'Объединить загрузки в одну или развести по разным именам.'));
      }
      return out;
    },
  },

  {
    id: 'S006',
    category: CATEGORY,
    severity: SEVERITY.S006,
    title: 'JOIN по неключевому полю',
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
            'Соединять по ключу или создать ключ AutoNumber.'));
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
    description: 'Служебные поля остаются в модели данных и занимают память приложения.',
    recommendation: 'Добавить DROP FIELD в конец скрипта для полей, не используемых во фронт-енде.',
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
    description: 'Переменная объявлена, но нигде в скрипте не используется.',
    recommendation: 'Удалить объявление.',
    run(ctx) {
      const out = [];
      const script = String(ctx.graph.script ?? '');
      // Переменная может использоваться только во фронт-енде — без данных движка
      // это недоказуемо, поэтому в файловом режиме проверка не выполняется.
      const hasFrontEnd = (ctx.graph.objects ?? []).length > 0;
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
      const check = (table, raw, kind) => {
        if (!table || known.has(canonicalFieldName(table))) return;
        if (isSystemTable(table)) return;
        out.push(finding('S009', 'Ссылка на неизвестную таблицу',
          { kind: 'table', name: table, id: table },
          `${kind} ссылается на таблицу «${table}», которой нет в скрипте`,
          raw.slice(0, 160),
          'Исправить имя или добавить загрузку этой таблицы.'));
      };
      for (const r of ctx.script.residents) check(r.table, r.raw, 'RESIDENT');
      for (const j of ctx.script.joins) check(j.table, j.raw, 'JOIN');
      return out;
    },
  },

  {
    id: 'S010',
    category: CATEGORY,
    severity: SEVERITY.S010,
    title: 'Структурная ошибка в скрипте',
    description: 'Скрипт содержит незакрытую строку или скобки — загрузка упадёт.',
    recommendation: 'Исправить скрипт (Ctrl+ → Check syntax в редакторе).',
    run(ctx) {
      const out = [];
      for (const p of checkScriptStructure(ctx.graph.script)) {
        out.push(finding('S010', 'Структурная ошибка в скрипте',
          { kind: 'app', name: 'скрипт загрузки', id: 'script' },
          p.message,
          `Код: ${p.code}`,
          'Исправить скрипт и проверить синтаксис.'));
      }
      return out;
    },
  },

  {
    id: 'S011',
    category: CATEGORY,
    severity: SEVERITY.S011,
    title: 'Скрипт без комментариев',
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
          'Указать формат явно в скобках после имени файла.'));
      }
      return out;
    },
  },
];
