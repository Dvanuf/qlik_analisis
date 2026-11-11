/**
 * Клиент GitLab для авто-раскрытия включаемых файлов (п. L013).
 *
 * Приложение-заглушка «$(Must_Include=lib://Git_Sense/P&L.qvs)» — вся логика
 * в .qvs из Git-репозитория. Модуль строит индекс .qvs-файлов заданных
 * папок GitLab (проект → папка, ветка) и скачивает содержимое по имени
 * файла: сопоставление с include — по хвостовому имени (includeKey,
 * src/extract/includes.js).
 *
 * Авторизация: Personal Access Token (read_repository) через заголовок
 * PRIVATE-TOKEN; без токена — попытка анонимно (внутренний GitLab может
 * отдавать публичные проекты).
 */
import { httpGetJson } from './http.js';
import { decodeText } from '../connectors/file.js';

/** Настройки GitLab по умолчанию (переопределяются в gitlab-config.json). */
export const DEFAULT_GITLAB = {
  baseUrl: 'http://gitlab.onyx.local',
  ref: 'master',
  /** Проект → папка, где искать .qvs включения. */
  targets: [
    { project: 'qlik/qlik-sense', folder: '03_Load_Layer' },
    { project: 'qlik/qlik-view', folder: '03_Load_Layer' },
    { project: 'qlik/qlik-view', folder: 'Documents' },
    { project: 'qlik/qlik-view', folder: 'Documents2' },
    { project: 'qlik/qlik-view', folder: 'Documents_Продажи' },
    { project: 'qlik/qlik-view', folder: 'Documents_Archive' },
  ],
  extensions: ['.qvs', '.txt', '.qvsx'],
};

/** Кодирование пути проекта/файла для URL GitLab (слэши — %2F). */
export function encodeGitLabPath(path) {
  return encodeURIComponent(String(path ?? ''));
}

function authHeaders(token) {
  const h = { Accept: 'application/json' };
  if (token) h['PRIVATE-TOKEN'] = token;
  return h;
}

/**
 * Индекс .qvs-файлов по заданным папкам (проект → папка).
 *
 * @param {{ baseUrl?: string, ref?: string, targets?: {project: string, folder: string}[],
 *   token?: string, extensions?: string[], timeout?: number }} opts
 * @returns {Promise<{ ok: boolean, index: Map<string, {projectId: string, path: string}>,
 *   notes: string[] }>} индекс: ключ — имя файла в нижнем регистре
 */
export async function fetchGitLabIndex(opts = {}) {
  const cfg = { ...DEFAULT_GITLAB, ...opts };
  const baseUrl = String(cfg.baseUrl ?? '').replace(/\/+$/, '');
  const notes = [];
  const index = new Map();
  if (!baseUrl) return { ok: false, index, notes: ['не задан адрес GitLab'] };

  for (const t of cfg.targets ?? []) {
    const project = encodeGitLabPath(t.project);
    const folder = String(t.folder ?? '').replace(/\/+$/, '');
    const url = `${baseUrl}/api/v4/projects/${project}/repository/tree?ref=${encodeURIComponent(cfg.ref)}&path=${encodeURIComponent(folder)}&recursive=true&per_page=100`;
    try {
      const payload = await httpGetJson(url, {
        insecure: true,
        headers: authHeaders(cfg.token),
        timeout: opts.timeout ?? 20000,
      });
      const entries = Array.isArray(payload) ? payload : [];
      let added = 0;
      for (const e of entries) {
        if (e?.type !== 'blob') continue;
        const name = String(e.name ?? '');
        if (!cfg.extensions.some((ext) => name.toLowerCase().endsWith(ext))) continue;
        index.set(name.toLowerCase(), { projectId: t.project, path: e.path });
        added += 1;
      }
      notes.push(`${t.project}/${t.folder} → файлов ${added}`);
    } catch (err) {
      notes.push(`${t.project}/${t.folder} → ${String(err?.message ?? err).slice(0, 140)}`);
    }
  }
  return { ok: index.size > 0, index, notes };
}

/**
 * Скачать сырой файл включения из GitLab (текст, decodeText — cp1251 fallback).
 *
 * @param {{ baseUrl?: string, ref?: string, token?: string, projectId: string,
 *   path: string, timeout?: number }} opts
 * @returns {Promise<{ ok: boolean, content?: string, note: string }>}
 */
export async function fetchGitLabFileText(opts = {}) {
  const cfg = { ...DEFAULT_GITLAB, ...opts };
  const baseUrl = String(cfg.baseUrl ?? '').replace(/\/+$/, '');
  const project = encodeGitLabPath(cfg.projectId);
  const path = encodeGitLabPath(cfg.path);
  const url = `${baseUrl}/api/v4/projects/${project}/repository/files/${path}/raw?ref=${encodeURIComponent(cfg.ref)}`;
  const { request: httpRequest } = await import('node:http');
  const { request: httpsRequest } = await import('node:https');
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
      method: 'GET',
      headers: authHeaders(cfg.token),
      ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      ...(cfg.timeout ? { timeout: cfg.timeout } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode ?? 0) >= 400) {
          resolve({ ok: false, note: `HTTP ${res.statusCode}: ${body.toString('utf8').slice(0, 120)}` });
          return;
        }
        resolve({ ok: true, content: decodeText(body), note: 'ok' });
      });
    });
    req.on('error', (err) => resolve({ ok: false, note: String(err?.message ?? err).slice(0, 160) }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}
