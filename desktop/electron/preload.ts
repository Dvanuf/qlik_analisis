/**
 * Preload: безопасный мост между renderer и main.
 * Renderer не имеет доступа к Node — только к этому явному API.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  rulesConfig: () => ipcRenderer.invoke('core:rules-config'),
  saveRulesConfig: (config: unknown) => ipcRenderer.invoke('core:rules-config-save', config),
  exportRulesConfig: () => ipcRenderer.invoke('core:rules-config-export'),
  importRulesConfig: () => ipcRenderer.invoke('core:rules-config-import'),
  exportScript: (payload: { appName?: string; script: string; patch?: { script?: string } }) => ipcRenderer.invoke('core:export-script', payload),
  /** История прогонов в локальной базе SQLite. */
  historySave: (payload: {
    appId: string; appName?: string; at?: string; score?: number;
    summary?: unknown; findings?: unknown[];
  }) => ipcRenderer.invoke('core:history-save', payload),
  historyList: (opts?: { appId?: string; limit?: number }) => ipcRenderer.invoke('core:history-list', opts ?? {}),
  historyLatest: (opts: { appId: string }) => ipcRenderer.invoke('core:history-latest', opts),
  historyCompare: (opts: { baselineId: number; currentId: number }) => ipcRenderer.invoke('core:history-compare', opts),
  /** Выгрузка плоской таблицы находок в CSV и Excel. */
  exportFindingsCsv: (payload: { rows: Record<string, string | number>[]; fileName?: string }) => ipcRenderer.invoke('core:export-findings-csv', payload),
  exportFindingsXlsx: (payload: { rows: Record<string, string | number>[]; fileName?: string }) => ipcRenderer.invoke('core:export-findings-xlsx', payload),
  rules: () => ipcRenderer.invoke('core:rules'),
  /** Каталог готовых функций скрипта: список, выгрузка в .qvs, разбор своей библиотеки. */
  library: () => ipcRenderer.invoke('core:library'),
  libraryQvs: (ids: string[]) => ipcRenderer.invoke('core:library-qvs', ids),
  librarySubs: (script: string) => ipcRenderer.invoke('core:library-subs', script),
  analyzeFile: (filePath: string) => ipcRenderer.invoke('core:analyze-file', filePath),
  doctor: (opts: {
    url: string; user?: string; password?: string; qlikUser?: string; insecure?: boolean;
  }) => ipcRenderer.invoke('core:doctor', opts),
  openDialog: () => ipcRenderer.invoke('core:open-dialog'),
  previewScript: (text: string) => ipcRenderer.invoke('core:preview-script', text),
  readFile: (filePath: string) => ipcRenderer.invoke('core:read-file', filePath),
  listApps: (opts: {
    url: string; cookie?: string; xrfKey?: string; csrfToken?: string;
    user?: string; password?: string; insecure?: boolean;
  }) => ipcRenderer.invoke('core:list-apps', opts),
  analyzeApp: (opts: {
    url: string; appId: string; cookie?: string; xrfKey?: string; csrfToken?: string;
    user?: string; password?: string; insecure?: boolean; platform?: string;
  }) => ipcRenderer.invoke('core:analyze-app', opts),
  /** Открывает окно входа в хаб и возвращает cookie + ключи рукопожатия. */
  openHub: (opts: { hubUrl: string; appId?: string; insecure?: boolean }) => ipcRenderer.invoke('core:open-hub', opts),
  saveCredentials: (creds: {
    hubUrl: string; cookie: string; xrfKey?: string; csrfToken?: string; at?: string;
  }) => ipcRenderer.invoke('core:save-credentials', creds),
  loadCredentials: () => ipcRenderer.invoke('core:load-credentials'),
  clearCredentials: () => ipcRenderer.invoke('core:clear-credentials'),
  /** Пакетный анализ всех приложений сервера. */
  analyzeAll: (opts: {
    url: string; cookie?: string; xrfKey?: string; csrfToken?: string;
    user?: string; password?: string; insecure?: boolean; platform?: string;
    pauseMs?: number; useCache?: boolean;
    /** Ограничить прогон выбранными приложениями. */
    appIds?: string[];
  }) => ipcRenderer.invoke('core:analyze-all', opts),
  cancelBatch: () => ipcRenderer.invoke('core:cancel-batch'),
  /** Прогресс пакетного анализа: подписка возвращает функцию отписки. */
  onBatchProgress: (cb: (p: {
    phase: string; index: number; total: number; appId?: string;
    title?: string; findings?: number; error?: string; fromCache?: boolean;
  }) => void) => {
    const listener = (_e: unknown, p: {
      phase: string; index: number; total: number; appId?: string;
      title?: string; findings?: number; error?: string; fromCache?: boolean;
    }) => cb(p);
    ipcRenderer.on('batch:progress', listener);
    return () => ipcRenderer.removeListener('batch:progress', listener);
  },
  /** Сохраняет отчёт (HTML + JSON) в «Документы/QlikAnalyzer» и открывает HTML. */
  exportReport: (payload: {
    appName: string; summary: unknown; findings: unknown; patch: unknown; ruleStats: unknown;
  }) => ipcRenderer.invoke('core:export-report', payload),
  /** Сохраняет сводный отчёт по пакетному прогону. */
  exportSummary: (payload: { totals: unknown; results: unknown; platform?: string }) => ipcRenderer.invoke('core:export-summary', payload),
  /** Пошаговый вывод диагностики: подписка возвращает функцию отписки. */
  onDoctorStep: (cb: (step: { name: string; status: string; detail: string; hint?: string }) => void) => {
    const listener = (_e: unknown, step: { name: string; status: string; detail: string; hint?: string }) => cb(step);
    ipcRenderer.on('doctor:step', listener);
    return () => ipcRenderer.removeListener('doctor:step', listener);
  },
};

export type QlikAnalyzerApi = typeof api;

contextBridge.exposeInMainWorld('qa', api);
