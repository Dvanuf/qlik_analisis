/**
 * Общие типы десктоп-приложения.
 * Вынесены отдельно, чтобы вкладки не импортировали друг друга.
 */
export type Tab = 'connect' | 'analysis' | 'script' | 'summary' | 'model' | 'rules' | 'library';
/**
 * Платформа приложения.
 * 'auto' — определить по данным сервера (по умолчанию): один и тот же
 * Sense-сервер бывает доступен через Doc API, поэтому платформа определяется
 * по набору типов объектов, а не по способу подключения.
 */
export type Platform = 'qlik-sense' | 'qlikview' | 'auto';
export type Severity = 'error' | 'warning' | 'info';

/**
 * Область находки: где проблема находится в приложении.
 * - script — загрузочный скрипт и модель данных;
 * - dashboard — листы и объекты интерфейса;
 * - measures — меры, измерения и их выражения.
 */
export type FindingScope = 'script' | 'dashboard' | 'measures';

/**
 * Домен анализа — «какая забота», а не «в каком файле лежит правило».
 */
export type DomainId = 'model' | 'script' | 'dash' | 'expr' | 'vars' | 'conn';

export type AppInfo = {
  appVersion: string; electron: string; chrome: string; node: string; v8: string;
  platform: string; arch: string; locale: string; cwd: string;
};

export type RuleInfo = {
  total: number;
  categories: { name: string; count: number }[];
  /** Домены: идентификатор, подпись, число правил. */
  domains?: { id: DomainId; label: string; count: number }[];
  rules: {
    id: string; category: string; severity: string; title: string; description: string;
    recommendation: string; platforms: string[]; domain?: DomainId;
  }[];
};

export type DoctorStep = {
  name: string; status: 'OK' | 'WARN' | 'FAIL'; detail: string; hint?: string; index?: number;
};

/**
 * Запись каталога готовых функций скрипта.
 */
export type LibraryFunction = {
  id: string;
  title: string;
  category: string;
  description: string;
  signature: string;
  params: { name: string; purpose: string }[];
  code: string;
  note?: string;
};

export type Finding = {
  ruleId: string; category: string; severity: string; title: string;
  message: string; recommendation: string; detail?: string;
  target?: { kind: string; name: string; id?: string };
  /** Счётчик свёрнутых одинаковых находок. */
  count?: number;
  /** Таблицы, где находка встречается. */
  tables?: string[];
  /** Таблица, к которой относится находка. */
  table?: string;
  /** Номер строки в скрипте. */
  line?: number;
  /** Все строки скрипта, к которым относится находка. */
  lines?: number[];
  /** Всего строк в скрипте, связанных с находкой (может быть больше, чем показано). */
  linesTotal?: number;
  /** Область находки: скрипт / дашборд / меры. */
  scope?: FindingScope;
  /** Домен находки: модель данных, скрипт, дашборд и т. д. */
  domain?: DomainId;
  /** Объекты в сгруппированной находке. */
  objects?: string[];
  /** Подавлена находка (скрыта по умолчанию). */
  suppressed?: boolean;
  suppressReason?: string;
};

/** Сводка по одному домену. */
export type DomainSummary = {
  id: DomainId;
  label: string;
  /** Правил в домене. */
  total: number;
  /** Правил с нарушениями. */
  failed: number;
  /** Правил, пропущенных (нет данных или не применимо к платформе). */
  skipped: number;
  /** Правил, пройденных без замечаний. */
  passed: number;
  /** Находок. */
  findings: number;
  /** Мест — с учётом свёрнутых находок. */
  places: number;
};

/** Место находки: объект, таблица или строка скрипта. */
export type PatternPlace = {
  name: string;
  kind: string;
  table: string;
  line: number | null;
  sheet: string;
  message: string;
};

/**
 * Паттерн — корень проблемы одной строкой; места перечислены внутри.
 */
export type Pattern = {
  id: string;
  ruleId: string;
  domain: DomainId;
  category: string;
  severity: string;
  title: string;
  /** Выражение, если причина в нём. */
  expression: string;
  message: string;
  recommendation: string;
  places: PatternPlace[];
  /** Сколько мест нашлось. */
  count: number;
};

/** Паттерны одного правила. */
export type PatternRule = {
  ruleId: string;
  domain: DomainId;
  category: string;
  severity: string;
  title: string;
  patterns: Pattern[];
  places: number;
};

export type AnalysisResult = {
  appName?: string;
  appId?: string;
  file?: string;
  summary: {
    findings: {
      total: number; byCategory: Record<string, number>; bySeverity: Record<string, number>;
      byScope?: Record<string, number>;
      /** Сводка по доменам: сколько проверок, сколько нарушено, сколько мест. */
      byDomain?: Record<DomainId, DomainSummary>;
      merged?: number; suppressed?: number;
    };
    counts: Record<string, number>;
    savings?: { removableFields: number; removableRows: number };
    score?: number;
    scoreDetails?: { formula: string; checks: number; penalty: number };
  };
  findings: Finding[];
  suppressed?: Finding[];
  /** Паттерны: корень проблемы — одна строка. */
  patterns?: Pattern[];
  /** Паттерны, сгруппированные по правилам. */
  patternRules?: PatternRule[];
  /** Всего мест в паттернах. */
  patternPlaces?: number;
  patch: { script: string; autoNumbers?: { field: string; key: string }[] };
  script?: string;
  /** Ошибки скрипта по данным сервера — с номером строки и колонки. */
  scriptErrors?: { message: string; line: number | null; column: number | null; type?: string }[];
  /** Листы книги «Модель данных» — таблицы, поля, объекты, переменные. */
  dataModel?: { name: string; headers: string[]; rows: (string | number)[][] }[];
  /** Плоский перечень выражений приложения — для поиска по выражению. */
  expressionIndex?: { name: string; type: string; kind: string; expr: string }[];
  /** Структура скрипта загрузки. */
  outline?: {
    sections: number;
    steps: number;
    unreachable: number;
    full?: {
      sections: { name: string; line: number; tables: string[]; subs: string[]; variables: string[] }[];
      steps: { table: string; text: string; line: number }[];
      residentFlow: { table: string; sources: string[]; line: number }[];
      unreachable: { raw: string; line: number }[];
    };
  };
  skipped?: { capability: string; reason: string }[];
  ruleStats?: {
    id: string; category: string; severity: string; title: string;
    count: number; skipped: boolean; note: string | null; domain?: DomainId;
  }[];
};

export type AppItem = {
  id: string; title: string; size: number | null;
  /** Поток и владелец — заполняются, если сервер их отдаёт. */
  stream?: string | null; owner?: string | null;
  /** Тэги приложения — заполняются, если сервер их отдаёт. */
  tags?: string[];
  /** Признак публикации — заполняется, если сервер его отдаёт. */
  published?: boolean | null;
  lastReload?: string | null;
};

/** Этап анализа приложения — для индикатора прогресса. */
export type AnalyzeProgress = {
  stage: string;
  detail?: string;
  appId?: string;
};

export type BatchProgress = {
  phase: 'start' | 'done' | 'error' | 'stopped';
  index: number; total: number; appId?: string;
  title?: string; findings?: number; error?: string; fromCache?: boolean;
};

export type BatchItem = {
  appId: string; title: string; size?: number | null; error?: string;
  fromCache?: boolean;
  /** Поток и владелец приложения (если сервер их отдаёт). */
  stream?: string | null;
  owner?: string | null;
  /** Тэги приложения (если сервер их отдаёт). */
  tags?: string[];
  /** Признак публикации (если сервер его отдаёт). */
  published?: boolean | null;
  /** Дата прогона и дата изменения приложения. */
  at?: string;
  lastReload?: string | null;
  /** Находки приложения — нужны для выгрузки и истории. */
  findings?: Finding[];
  summary?: {
    findings: { total: number; byCategory: Record<string, number>; bySeverity: Record<string, number> };
    savings?: { removableFields: number; removableRows: number };
    score?: number;
  } | null;
};

export type BatchTotals = {
  apps: number; errors: number; findings: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  removableRows: number; removableFields: number;
};

/** Прогон анализа в локальной базе истории. */
export type HistoryRun = {
  id: number; appId: string; appName: string; at: string;
  rulesVersion: string; score: number;
  errors: number; warnings: number; infos: number; total: number;
};

/** Сравнение прогона с базовой линией. */
export type Comparison = {
  baselineId: number; currentId: number;
  added: Finding[]; fixed: Finding[]; unchanged: Finding[];
  counts: { added: number; fixed: number; unchanged: number };
};

/** Настройки правил из файла конфигурации. */
export type RulesConfig = {
  rules: {
    disabled: string[];
    severity: Record<string, string>;
    thresholds: Record<string, Record<string, number>>;
    exclusions: Record<string, { tables?: string[] }>;
    suppress: { ruleId: string; app?: string; table?: string }[];
  };
};

/** Параметры подключения, общие для всех вызовов ядра. */
export type Connection = {
  url: string; user: string; password: string; cookie: string;
  xrfKey: string; csrfToken: string; insecure: boolean;
};
