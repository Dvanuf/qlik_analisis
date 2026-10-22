/**
 * Хранилище отчётов на диске.
 *
 * Структура каталога dataDir:
 *   reports/<jobId>.html   — самодостаточный HTML-отчёт
 *   reports/<jobId>.json   — находки и сводка (машиночитаемо)
 *   index.json             — список всех прогонов (метаданные)
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync,
} from 'node:fs';
import { resolve } from 'node:path';

export class ReportStore {
  /** @param {string} dataDir — каталог данных (относительно корня проекта) */
  constructor(dataDir) {
    this.root = resolve(dataDir);
    this.reportsDir = resolve(this.root, 'reports');
    this.indexPath = resolve(this.root, 'index.json');
    if (!existsSync(this.reportsDir)) mkdirSync(this.reportsDir, { recursive: true });
  }

  /** Метаданные всех прогонов, новые первыми. */
  list() {
    if (!existsSync(this.indexPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  #writeIndex(list) {
    writeFileSync(this.indexPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  }

  /**
   * Сохраняет результат задачи.
   * @param {string} jobId
   * @param {{type: string, title: string, html: string, json: object, requestedBy?: string}} data
   */
  save(jobId, data) {
    const htmlPath = resolve(this.reportsDir, `${jobId}.html`);
    const jsonPath = resolve(this.reportsDir, `${jobId}.json`);
    writeFileSync(htmlPath, data.html, 'utf8');
    writeFileSync(jsonPath, `${JSON.stringify(data.json, null, 2)}\n`, 'utf8');

    const entry = {
      jobId,
      type: data.type,
      title: data.title,
      requestedBy: data.requestedBy ?? 'anonymous',
      createdAt: new Date().toISOString(),
      htmlUrl: `/reports/${jobId}.html`,
      jsonUrl: `/reports/${jobId}.json`,
      summary: data.json?.summary ?? data.json?.totals ?? null,
    };
    const list = this.list().filter((e) => e.jobId !== jobId);
    list.unshift(entry);
    this.#writeIndex(list);
    return entry;
  }

  /** Один прогон по jobId. */
  get(jobId) {
    return this.list().find((e) => e.jobId === jobId) ?? null;
  }

  /** Путь к HTML-файлу (для отдачи по HTTP). */
  htmlPath(jobId) {
    const safe = String(jobId).replace(/[^\w-]/g, '');
    return resolve(this.reportsDir, `${safe}.html`);
  }

  /** Удаляет прогон и его файлы. */
  remove(jobId) {
    const safe = String(jobId).replace(/[^\w-]/g, '');
    for (const ext of ['html', 'json']) {
      const p = resolve(this.reportsDir, `${safe}.${ext}`);
      if (existsSync(p)) rmSync(p);
    }
    const before = this.list().length;
    const list = this.list().filter((e) => e.jobId !== jobId);
    if (list.length !== before) this.#writeIndex(list);
    return before !== list.length;
  }

  /** Удаляет отчёты старше N дней. */
  prune(maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const list = this.list();
    const keep = [];
    let removed = 0;
    for (const e of list) {
      if (new Date(e.createdAt).getTime() < cutoff) {
        this.remove(e.jobId);
        removed += 1;
      } else {
        keep.push(e);
      }
    }
    return { removed, kept: keep.length };
  }

  /** Итог по всем прогонам (для сводной страницы). */
  stats() {
    const list = this.list();
    return {
      reports: list.length,
      lastRun: list[0]?.createdAt ?? null,
      byType: list.reduce((acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }
}
