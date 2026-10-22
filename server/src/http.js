/**
 * HTTP-сервер: REST API + веб-интерфейс.
 *
 * Маршруты:
 *   GET  /api/me                 — кто вошёл (имя, роль)
 *   GET  /api/rules              — каталог правил
 *   GET  /api/apps               — список приложений сервера Qlik
 *   POST /api/analyze            — поставить анализ приложения в очередь { appId }
 *   POST /api/analyze-all        — поставить пакетный анализ в очередь
 *   GET  /api/jobs               — список задач
 *   GET  /api/jobs/:id           — состояние задачи
 *   POST /api/jobs/:id/cancel    — отменить задачу
 *   GET  /api/reports            — список сохранённых отчётов
 *   GET  /api/reports/:id        — метаданные отчёта
 *   GET  /reports/:id.html       — сам отчёт (HTML)
 *   GET  /reports/:id.json       — находки (JSON)
 *   DELETE /api/reports/:id      — удалить отчёт
 *   GET  /api/stream             — SSE-поток прогресса задач
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, challengeHeader } from './auth.js';
import { analyzeApp, analyzeAllApps, fetchApps, rulesCatalog } from './qlik.js';
import { JobQueue } from './queue.js';
import { ReportStore } from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req, limitBytes = 1024 * 256) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Тело запроса слишком велико');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Некорректный JSON в теле запроса');
  }
}

/**
 * @param {object} options
 * @param {object} options.config — итоговая конфигурация сервера
 * @param {ReportStore} options.store
 * @param {(msg: string) => void} [options.log]
 */
export function createApp(options) {
  const { config, store, log = () => {} } = options;

  const queue = new JobQueue({
    concurrency: config.server.concurrency,
    runner: async (type, payload, ctx) => {
      if (type === 'analyze') {
        const result = await analyzeApp(config.qlik, payload.appId, {
          platform: payload.platform ?? config.qlik.platform,
        });
        const entry = store.save(ctx.jobId, {
          type,
          title: result.appName || payload.appId,
          html: result.html,
          json: {
            summary: result.summary,
            findings: result.findings,
            patch: result.patch,
            ruleStats: result.ruleStats,
          },
          requestedBy: ctx.requestedBy,
        });
        return { reportId: entry.jobId, summary: result.summary };
      }
      const result = await analyzeAllApps(config.qlik, {
        pauseMs: config.server.pauseMs,
        shouldStop: ctx.shouldStop,
        onProgress: ctx.onProgress,
      });
      const entry = store.save(ctx.jobId, {
        type,
        title: `Сводный анализ: ${result.totals.apps} приложений`,
        html: result.html,
        json: { totals: result.totals, results: result.results },
        requestedBy: ctx.requestedBy,
      });
      return { reportId: entry.jobId, totals: result.totals };
    },
  });

  // SSE-подписчики прогресса
  const subscribers = new Set();
  queue.on('job', (job) => {
    const message = `data: ${JSON.stringify(job)}\n\n`;
    for (const res of subscribers) {
      try { res.write(message); } catch { subscribers.delete(res); }
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    try {
      // --- аутентификация ---
      const auth = authenticate(config.auth, req);
      if (!auth.ok) {
        if (auth.challenge) {
          res.writeHead(401, { 'WWW-Authenticate': challengeHeader(config.auth) });
          res.end('Требуется авторизация');
          return;
        }
        sendJson(res, 403, { error: auth.reason ?? 'Доступ запрещён' });
        return;
      }

      // --- служебный маршрут без аутентификации (для балансировщика) ---
      if (pathname === '/api/health') {
        sendJson(res, 200, {
          status: 'ok',
          uptimeSeconds: Math.round(process.uptime()),
          queue: { running: queue.running, queued: queue.queue.length },
          reports: store.stats(),
        });
        return;
      }

      // --- разграничение прав ---
      const isAnalyst = ['analyst', 'admin'].includes(auth.role ?? 'viewer');
      const needsAnalyst = pathname === '/api/analyze'
        || pathname === '/api/analyze-all'
        || /^\/api\/jobs\/[^/]+\/cancel$/.test(pathname);
      if (needsAnalyst && !isAnalyst) {
        sendJson(res, 403, { error: 'Недостаточно прав для запуска анализа (нужна роль analyst)' });
        return;
      }

      if (pathname === '/api/me') {
        sendJson(res, 200, {
          user: auth.user,
          role: auth.role,
          canAnalyze: isAnalyst,
          mode: config.auth.mode,
        });
        return;
      }

      if (pathname === '/api/rules') {
        sendJson(res, 200, rulesCatalog());
        return;
      }

      if (pathname === '/api/apps') {
        if (!config.qlik.url) {
          sendJson(res, 400, { error: 'Не задан URL движка Qlik (qlik.url)' });
          return;
        }
        try {
          sendJson(res, 200, { apps: await fetchApps(config.qlik) });
        } catch (err) {
          sendJson(res, 502, { error: String(err?.message ?? err) });
        }
        return;
      }

      if (pathname === '/api/analyze' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.appId) {
          sendJson(res, 400, { error: 'Не указан appId' });
          return;
        }
        const job = queue.enqueue('analyze', { appId: body.appId, platform: body.platform }, auth.user);
        sendJson(res, 202, { jobId: job.id, status: job.status });
        return;
      }

      if (pathname === '/api/analyze-all' && req.method === 'POST') {
        const body = await readBody(req);
        const job = queue.enqueue('analyze-all', { platform: body.platform }, auth.user);
        sendJson(res, 202, { jobId: job.id, status: job.status });
        return;
      }

      if (pathname === '/api/jobs') {
        sendJson(res, 200, { jobs: queue.list() });
        return;
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const job = queue.get(jobMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: 'Задача не найдена' });
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const ok = queue.cancel(cancelMatch[1]);
        sendJson(res, ok ? 200 : 409, { canceled: ok });
        return;
      }

      if (pathname === '/api/reports') {
        sendJson(res, 200, { reports: store.list(), stats: store.stats() });
        return;
      }

      const reportMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);
      if (reportMatch) {
        if (req.method === 'DELETE') {
          const ok = store.remove(reportMatch[1]);
          sendJson(res, ok ? 200 : 404, { deleted: ok });
          return;
        }
        const entry = store.get(reportMatch[1]);
        if (!entry) {
          sendJson(res, 404, { error: 'Отчёт не найден' });
          return;
        }
        sendJson(res, 200, entry);
        return;
      }

      // --- SSE-поток прогресса ---
      if (pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        subscribers.add(res);
        const keepAlive = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* соединение закрыто */ }
        }, 25000);
        req.on('close', () => {
          clearInterval(keepAlive);
          subscribers.delete(res);
        });
        return;
      }

      // --- статика: отчёты ---
      const reportFile = pathname.match(/^\/reports\/([^/]+)\.(html|json)$/);
      if (reportFile) {
        const file = resolve(store.reportsDir, `${reportFile[1].replace(/[^\w-]/g, '')}.${reportFile[2]}`);
        if (!existsSync(file)) {
          sendText(res, 404, 'Отчёт не найден');
          return;
        }
        const body = readFileSync(file);
        res.writeHead(200, {
          'Content-Type': reportFile[2] === 'json'
            ? 'application/json; charset=utf-8'
            : 'text/html; charset=utf-8',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }

      // --- статика: веб-интерфейс ---
      const filePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const full = resolve(PUBLIC_DIR, filePath);
      if (!full.startsWith(PUBLIC_DIR) || !existsSync(full)) {
        sendText(res, 404, 'Не найдено');
        return;
      }
      const body = readFileSync(full);
      res.writeHead(200, {
        'Content-Type': MIME[extname(full)] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      res.end(body);
    } catch (err) {
      log(`Ошибка обработки ${req.method} ${pathname}: ${err?.stack ?? err}`);
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  });

  return { server, queue, store };
}
