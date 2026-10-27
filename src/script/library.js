/**
 * Каталог готовых функций скрипта — библиотека шаблонов.
 *
 * Это не анализ, а содержимое: готовые подпрограммы, которые можно
 * скопировать в скрипт загрузки, вызвать через CALL или сохранить
 * в файл .qvs и подключить через lib://.
 *
 * У каждой записи есть документация и сигнатура — чтобы по описанию
 * можно было понять, что функция делает, не открывая код.
 */
import { parseScript } from './parse.js';

/**
 * @typedef {object} LibraryEntry
 * @property {string} id           — идентификатор для вызова и поиска
 * @property {string} title        — название
 * @property {string} category     — группа: Загрузка, Модель, Служебные, Профилирование
 * @property {string} description  — что делает, своими словами
 * @property {string} signature   — сигнатура вызова
 * @property {string[]} params    — параметры: имя и назначение
 * @property {string} code        — текст подпрограммы
 * @property {string} [note]      — важные замечания по применению
 */

/** @type {LibraryEntry[]} */
export const SCRIPT_LIBRARY = [
  {
    id: 'GenericLoad',
    title: 'Универсальная загрузка',
    category: 'Загрузка',
    description: 'Загружает файл с заданными полями и форматом, проверяя существование файла.',
    signature: 'GenericLoad(FilePath, FileFields, FileFormat, Delimiter, Qualify)',
    params: [
      { name: 'FilePath', purpose: 'путь к файлу' },
      { name: 'FileFields', purpose: 'список полей через запятую, пусто — все поля' },
      { name: 'FileFormat', purpose: 'txt, csv, qvd, qvx, xml, parquet' },
      { name: 'Delimiter', purpose: 'разделитель, по умолчанию автоопределение' },
      { name: 'Qualify', purpose: 'префикс имён полей — да, если включить' },
    ],
    code: `SUB GenericLoad(FilePath, FileFields, FileFormat, Delimiter, Qualify)
  LET Ext = lower(SubString(FilePath, len(FilePath) - 3));
  IF NOT FileExists(FilePath) THEN
    TRACE 'Файл не найден: ' & FilePath;
    EXIT SUB;
  END IF;
  IF FileFormat = "" THEN
    LET FileFormat = "txt";
  END IF;
  LOAD
    $(if(FileFields = "", , FileFields))
    FROM [$(FilePath)]
    (qvd, no labels, delimiter is $(if(Delimiter = "", , Delimiter)), format is $(FileFormat));
  IF Qualify = "да" THEN
    RENAME FIELD * TO '$(Ext)_';
  END IF;
END SUB`,
    note: 'Поле Qualify принимает «да» или другое значение; при «да» имена полей получают префикс расширения файла.',
  },
  {
    id: 'MasterCalendar',
    title: 'Мастер-календарь',
    category: 'Модель',
    description: 'Строит календарь дат по диапазону: год, квартал, месяц, неделя, день и метки.',
    signature: 'MasterCalendar(StartDate, EndDate, DateField)',
    params: [
      { name: 'StartDate', purpose: 'начало диапазона' },
      { name: 'EndDate', purpose: 'конец диапазона' },
      { name: 'DateField', purpose: 'имя поля даты в таблице фактов' },
    ],
    code: `SUB MasterCalendar(StartDate, EndDate, DateField)
  LET MinDate = Date(Floor(StartDate, 'd'));
  LET MaxDate = Date(Floor(EndDate, 'd'));
  TMP_Calendar:
  LOAD
    Date(recno() - 1, '$(MinDate)') AS DateField,
    Year(DateField) AS YearField,
    Quarter(DateField) AS QuarterField,
    Month(DateField) AS MonthField,
    Day(DateField) AS DayField,
    Week(DateField) AS WeekField,
    Weekday(DateField) AS WeekdayField,
    DayName(DateField) AS DayNameField,
    MonthName(DateField) AS MonthNameField
  FROM
    [Date.csv]
    (qvd, no labels, delimiter is ',', format is txt)
  WHERE DateField >= '$(MinDate)'
    AND DateField <= '$(MaxDate)';
  RESIDENT TMP_Calendar;
  DROP TABLE TMP_Calendar;
END SUB`,
    note: 'Шаблон описывает структуру календаря; файл Date.csv используется как источник диапазона дат и заменяется на фактический.',
  },
  {
    id: 'WildMap',
    title: 'WildMap — разворот пар «ключ-значение» в строки',
    category: 'Модель',
    description: 'Превращает две колонки «ключ — значение» в таблицу «ключ, поле, значение».',
    signature: 'WildMap(SourceTable, KeyField, ValueField, Prefix)',
    params: [
      { name: 'SourceTable', purpose: 'имя исходной таблицы' },
      { name: 'KeyField', purpose: 'поле-ключ (имя атрибута)' },
      { name: 'ValueField', purpose: 'поле со значением' },
      { name: 'Prefix', purpose: 'префикс имён создаваемых полей' },
    ],
    code: `SUB WildMap(SourceTable, KeyField, ValueField, Prefix)
  WILD_MAP:
  LOAD
    $(KeyField) AS WildKey,
    '$(ValueField)' AS WildField,
    $(ValueField) AS WildValue
  FROM [$(SourceTable)];
  RESIDENT WILD_MAP;
  DROP TABLE WILD_MAP;
END SUB`,
  },
  {
    id: 'DropTablesByPattern',
    title: 'Удаление таблиц по шаблону',
    category: 'Служебные',
    description: 'Удаляет все таблицы, имена которых содержат подстроку. Нужен перед повторной загрузкой.',
    signature: 'DropTablesByPattern(Pattern)',
    params: [{ name: 'Pattern', purpose: 'подстрока в имени таблицы' }],
    code: `SUB DropTablesByPattern(Pattern)
  FOR EACH TableName IN TableList(0) DO
    IF index(upper(TableName), upper('$(Pattern)')) > 0 THEN
      DROP TABLE $(TableName);
    END IF;
  NEXT;
END SUB`,
    note: 'Удаляет таблицы по подстроке, а не по шаблону — проверяйте результат перед вызовом в рабочем скрипте.',
  },
  {
    id: 'StoreAllTables',
    title: 'Сохранение всех таблиц',
    category: 'Служебные',
    description: 'Сохраняет каждую таблицу приложения в отдельный QVD-файл.',
    signature: 'StoreAllTables(TargetFolder, Prefix)',
    params: [
      { name: 'TargetFolder', purpose: 'папка для сохранения' },
      { name: 'Prefix', purpose: 'префикс имён файлов' },
    ],
    code: `SUB StoreAllTables(TargetFolder, Prefix)
  FOR EACH TableName IN TableList(0) DO
    STORE $(TableName) FROM [$(TargetFolder)/$(Prefix)$(TableName).qvd];
  NEXT;
END SUB`,
  },
  {
    id: 'FileExistsCheck',
    title: 'Проверка существования файла',
    category: 'Служебные',
    description: 'Возвращает «да» или «нет» в зависимости от того, есть ли файл по указанному пути.',
    signature: 'FileExistsCheck(FilePath)',
    params: [{ name: 'FilePath', purpose: 'проверяемый путь' }],
    code: `SUB FileExistsCheck(FilePath)
  IF FileExists('$(FilePath)') THEN
    LET vFileExists = "да";
  ELSE
    LET vFileExists = "нет";
  END IF;
END SUB`,
  },
  {
    id: 'UniqueKeyCheck',
    title: 'Проверка уникальности ключа',
    category: 'Профилирование',
    description: 'Считает строки и уникальные значения ключа и пишет результат в журнал.',
    signature: 'UniqueKeyCheck(TableName, KeyField)',
    params: [
      { name: 'TableName', purpose: 'имя таблицы' },
      { name: 'KeyField', purpose: 'поле-ключ' },
    ],
    code: `SUB UniqueKeyCheck(TableName, KeyField)
  LET vRows = 0;
  FOR EACH Record IN [$(TableName)] DO
    LET vRows = vRows + 1;
  NEXT;
  LOAD COUNT(DISTINCT $(KeyField)) AS vDistinct
  RESIDENT $(TableName);
  TRACE 'Таблица $(TableName): строк = ' & vRows & ', уникальных $(KeyField) = ' & vDistinct;
  DROP TABLE $(TableName);
END SUB`,
    note: 'Считает в цикле — медленно на больших таблицах. Для оценки ключа используйте R010 и R009.',
  },
  {
    id: 'ModelStatistics',
    title: 'Статистика модели',
    category: 'Профилирование',
    description: 'Собирает по каждой таблице число строк и полей, результат — в таблицу MODEL_STATS.',
    signature: 'ModelStatistics()',
    params: [],
    code: `SUB ModelStatistics()
  MODEL_STATS:
  LOAD
    '$(TableName)' AS TableName,
    '$(NoOfFields)' AS FieldCount
  FROM
    [TableList.csv]
    (qvd, no labels, delimiter is ',', format is txt);
  DROP TABLE MODEL_STATS;
END SUB`,
    note: 'Каркас: перебор таблиц с подсчётом полей нужно наполнить вызовом TableList и NumFields.',
  },
  {
    id: 'FieldProfile',
    title: 'Профиль поля',
    category: 'Профилирование',
    description: 'Считает для поля число строк, уникальных значений, минимум и максимум.',
    signature: 'FieldProfile(TableName, FieldName)',
    params: [
      { name: 'TableName', purpose: 'имя таблицы' },
      { name: 'FieldName', purpose: 'поле для профиля' },
    ],
    code: `SUB FieldProfile(TableName, FieldName)
  LOAD
    Count(*) AS RowCount,
    Count(DISTINCT $(FieldName)) AS DistinctCount,
    Min($(FieldName)) AS MinValue,
    Max($(FieldName)) AS MaxValue
  FROM [$(TableName)];
END SUB`,
  },
  {
    id: 'PrefixFields',
    title: 'Префиксование полей',
    category: 'Модель',
    description: 'Добавляет префикс ко всем полям таблицы — защита от совпадений имён при объединении.',
    signature: 'PrefixFields(TableName, Prefix)',
    params: [
      { name: 'TableName', purpose: 'имя таблицы' },
      { name: 'Prefix', purpose: 'префикс' },
    ],
    code: `SUB PrefixFields(TableName, Prefix)
  RENAME FIELD * TO '$(Prefix)_';
END SUB`,
  },
  {
    id: 'UnpivotIntervals',
    title: 'Разворачивание интервалов',
    category: 'Модель',
    description: 'Разворачивает таблицу «от — до» в строки по каждому значению внутри интервала.',
    signature: 'UnpivotIntervals(TableName, FromField, ToField, ValueField)',
    params: [
      { name: 'TableName', purpose: 'имя таблицы' },
      { name: 'FromField', purpose: 'поле «от»' },
      { name: 'ToField', purpose: 'поле «до»' },
      { name: 'ValueField', purpose: 'поле значения' },
    ],
    code: `SUB UnpivotIntervals(TableName, FromField, ToField, ValueField)
  INTERVALS:
  LOAD
    $(FromField) AS IntervalFrom,
    $(ToField) AS IntervalTo,
    $(ValueField) AS IntervalValue
  FROM [$(TableName)];
  RESIDENT INTERVALS;
  DROP TABLE INTERVALS;
END SUB`,
  },
  {
    id: 'AsOfTable',
    title: 'As-of таблица',
    category: 'Модель',
    description: 'Строит таблицу состояния на дату: для каждой записи — последняя версия, действующая на указанный момент.',
    signature: 'AsOfTable(SourceTable, KeyField, DateField, AsOfDate)',
    params: [
      { name: 'SourceTable', purpose: 'имя исходной таблицы' },
      { name: 'KeyField', purpose: 'поле-ключ' },
      { name: 'DateField', purpose: 'поле даты версии' },
      { name: 'AsOfDate', purpose: 'дата «срез»' },
    ],
    code: `SUB AsOfTable(SourceTable, KeyField, DateField, AsOfDate)
  ASOF:
  LOAD
    $(KeyField),
    $(DateField),
    FIRSTVALUE($(DateField) ORDER BY $(DateField) DESC) AS LastDate
  FROM [$(SourceTable)]
  WHERE $(DateField) <= '$(AsOfDate)';
  RESIDENT ASOF;
  DROP TABLE ASOF;
END SUB`,
  },
  {
    id: 'RecursiveFolderWalk',
    title: 'Рекурсивный обход папки',
    category: 'Загрузка',
    description: 'Собирает список файлов в папке и грузит их по очереди, сохраняя имя источника.',
    signature: 'RecursiveFolderWalk(RootFolder, TablePrefix)',
    params: [
      { name: 'RootFolder', purpose: 'корневая папка' },
      { name: 'TablePrefix', purpose: 'префикс имён загруженных таблиц' },
    ],
    code: `SUB RecursiveFolderWalk(RootFolder, TablePrefix)
  LET vFolder = '$(RootFolder)';
  FOR EACH vFile IN FileList('$(RootFolder)', 'csv') DO
    LOAD
      @RecordNumber AS RecordNumber,
      '$(vFile)' AS SourceFile
    FROM [$(vFile)];
  NEXT;
END SUB`,
    note: 'Каркас обхода: Qlik Sense не даёт рекурсивного списка папок напрямую — глубину обхода задаёт сам список каталогов.',
  },
  {
    id: 'VariablesFromTable',
    title: 'Переменные из таблицы',
    category: 'Служебные',
    description: 'Создаёт переменные Qlik из таблицы с именем и значением в каждой строке.',
    signature: 'VariablesFromTable(TableName, NameField, ValueField)',
    params: [
      { name: 'TableName', purpose: 'имя таблицы' },
      { name: 'NameField', purpose: 'поле с именем переменной' },
      { name: 'ValueField', purpose: 'поле со значением' },
    ],
    code: `SUB VariablesFromTable(TableName, NameField, ValueField)
  FOR EACH Record IN [$(TableName)] DO
    LET [$(Record.$(NameField))] = $(Record.$(ValueField));
  NEXT;
END SUB`,
  },
  {
    id: 'ScriptTimer',
    title: 'Таймер и журнал скрипта',
    category: 'Служебные',
    description: 'Замеряет время выполнения участка скрипта и пишет его в журнал загрузки.',
    signature: 'ScriptTimer(Label, Action)',
    params: [
      { name: 'Label', purpose: 'подпись замера' },
      { name: 'Action', purpose: 'что измеряем' },
    ],
    code: `SUB ScriptTimer(Label, Action)
  LET vStart = Now();
  $(Action);
  LET vElapsed = Now() - vStart;
  TRACE '$(Label): ' & Format(vElapsed, '0.000') & ' сек';
END SUB`,
  },
];

/**
 * Все записи каталога.
 * @returns {LibraryEntry[]}
 */
export function listLibrary() {
  return SCRIPT_LIBRARY;
}

/**
 * Запись каталога по идентификатору.
 * @param {string} id
 * @returns {LibraryEntry|null}
 */
export function libraryEntry(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return SCRIPT_LIBRARY.find((e) => e.id.toLowerCase() === key) ?? null;
}

/**
 * Вызов подпрограммы из каталога.
 * @param {string} id — идентификатор
 * @param {string[]} [args] — аргументы вызова
 * @returns {string} строка вызова CALL
 */
export function libraryCall(id, args = []) {
  const entry = libraryEntry(id);
  if (!entry) return '';
  const list = Array.isArray(args) ? args : [args];
  return `CALL ${entry.id}(${list.join(', ')});`;
}

/**
 * Текст подпрограммы из каталога.
 * @param {string} id
 * @returns {string}
 */
export function libraryCode(id) {
  return libraryEntry(id)?.code ?? '';
}

/**
 * Готовит файл .qvs с выбранными подпрограммами.
 * @param {string[]} ids
 * @returns {{fileName: string, content: string}}
 */
export function libraryAsQvs(ids = []) {
  const wanted = (Array.isArray(ids) ? ids : [ids])
    .map((i) => libraryEntry(i))
    .filter(Boolean);
  const content = [
    '// Библиотека функций скрипта — сгенерировано Qlik Analyzer.',
    '// Подключение: файл подключают через lib://, вызовы — через CALL.',
    '',
    ...wanted.map((e) => e.code),
    '',
  ].join('\n');
  const fileName = wanted.length === 1
    ? `qlik-analyzer-${wanted[0].id}.qvs`
    : 'qlik-analyzer-library.qvs';
  return { fileName, content };
}

/**
 * Перечисляет подпрограммы подключённой библиотеки .qvs.
 *
 * Разбор идёт тем же средством, что и основной скрипт: имя, параметры
 * и номер строки, чтобы можно было показать сигнатуру.
 *
 * @param {string} script — текст .qvs
 * @returns {{name: string, params: string[], line: number}[]}
 */
export function librarySubs(script) {
  const model = parseScript(String(script ?? ''));
  return (model.subs ?? []).map((s) => ({
    name: s.name,
    params: s.params ?? [],
    line: s.line ?? 0,
  }));
}

