/**
 * Preload: безопасный мост между renderer и main.
 * Renderer не имеет доступа к Node — только к этому явному API.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  rules: () => ipcRenderer.invoke('core:rules'),
  analyzeFile: (filePath: string) => ipcRenderer.invoke('core:analyze-file', filePath),
  doctor: (opts: {
    url: string; user?: string; password?: string; qlikUser?: string; insecure?: boolean;
  }) => ipcRenderer.invoke('core:doctor', opts),
  openDialog: () => ipcRenderer.invoke('core:open-dialog'),
  previewScript: (text: string) => ipcRenderer.invoke('core:preview-script', text),
  readFile: (filePath: string) => ipcRenderer.invoke('core:read-file', filePath),
  /** Пошаговый вывод диагностики: подписка возвращает функцию отписки. */
  onDoctorStep: (cb: (step: { name: string; status: string; detail: string; hint?: string }) => void) => {
    const listener = (_e: unknown, step: { name: string; status: string; detail: string; hint?: string }) => cb(step);
    ipcRenderer.on('doctor:step', listener);
    return () => ipcRenderer.removeListener('doctor:step', listener);
  },
};

export type QlikAnalyzerApi = typeof api;

contextBridge.exposeInMainWorld('qa', api);
