/**
 * GitHub-провайдер сверки скрипта приложения с эталонным .qvs (0.37.0).
 *
 * Эталон ищется по имени приложения в дереве репозитория
 * (`/repos/{owner}/{repo}/git/trees/{ref}?recursive=1`), содержимое —
 * через contents API с Accept: application/vnd.github.raw.
 * Сравнение — общий compareScripts (gitlab-sync.js).
 */
import { encodeGitLabPath } from '../extract/gitlab.js';
import { appFileName } from './gitlab-sync.js';

const DEFAULT_GITHUB = { baseUrl: 'https://api.github.com', ref: 'main' };

function authHeaders(token) {
  const h = {
    Accept: 'application/vnd.github.raw',
    'User-Agent': 'qlik-analyzer',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Дерево репозитория: список путей файлов. */
export async function fetchGitHubTree(opts = {}) {
  const cfg = { ...DEFAULT_GITHUB, ...opts };
  const baseUrl = String(cfg.baseUrl ?? '').replace(/\/+$/, '');
  const owner = encodeGitLabPath(cfg.owner ?? '');
  const repo = encodeGitLabPath(cfg.repo ?? '');
  const ref = encodeURIComponent(cfg.ref ?? 'main');
  const url = `${baseUrl}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const { request: httpRequest } = await import('node:http');
  const { request: httpsRequest } = await import('node:https');
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
      method: 'GET',
      headers: { ...authHeaders(cfg.token), Accept: 'application/json' },
      ...(cfg.timeout ? { timeout: cfg.timeout } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode ?? 0) >= 400) {
          resolve({ ok: false, paths: [], notes: [`HTTP ${res.statusCode}: ${body.toString('utf8').slice(0, 140)}`] });
          return;
        }
        try {
          const json = JSON.parse(body.toString('utf8'));
          const paths = (json.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path);
          resolve({ ok: paths.length > 0, paths, notes: paths.length ? [] : ['дерево репозитория пусто'] });
        } catch (err) {
          resolve({ ok: false, paths: [], notes: [String(err?.message ?? err).slice(0, 140)] });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, paths: [], notes: [String(err?.message ?? err).slice(0, 160)] }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Сырое содержимое файла (Accept: raw). */
export async function fetchGitHubFileText(opts = {}) {
  const cfg = { ...DEFAULT_GITHUB, ...opts };
  const baseUrl = String(cfg.baseUrl ?? '').replace(/\/+$/, '');
  const owner = encodeGitLabPath(cfg.owner ?? '');
  const repo = encodeGitLabPath(cfg.repo ?? '');
  const path = encodeGitLabPath(cfg.path ?? '');
  const ref = encodeURIComponent(cfg.ref ?? 'main');
  const url = `${baseUrl}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const { request: httpRequest } = await import('node:http');
  const { request: httpsRequest } = await import('node:https');
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
      method: 'GET',
      headers: authHeaders(cfg.token),
      ...(cfg.timeout ? { timeout: cfg.timeout } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode ?? 0) >= 400) {
          resolve({ ok: false, note: `HTTP ${res.statusCode}: ${body.toString('utf8').slice(0, 140)}` });
          return;
        }
        resolve({ ok: true, content: body.toString('utf8'), note: 'ok' });
      });
    });
    req.on('error', (err) => resolve({ ok: false, note: String(err?.message ?? err).slice(0, 160) }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Поиск эталона по имени приложения в путях дерева.
 *  Пути нормализуются NFC: GitHub может отдать «й»/«ё» в разложенной
 *  форме (NFD), и без нормализации визуально одинаковые имена не совпадут. */
export function findGitHubFile(paths, appName) {
  const want = appFileName(appName).normalize('NFC');
  if (!want || !Array.isArray(paths)) return null;
  const norm = (p) => String(p).normalize('NFC').toLowerCase();
  const exact = paths.find((p) => norm(p) === want);
  if (exact) return { file: exact };
  const hit2 = paths.find((p) => norm(p).endsWith(`/${want}`)) ?? null;
  return hit2 ? { file: hit2 } : null;
}
