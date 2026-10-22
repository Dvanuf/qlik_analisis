/**
 * Очередь фоновых задач анализа.
 *
 * Зачем очередь, а не «анализ прямо в HTTP-запросе»:
 *  - анализ 220 приложений занимает часы, а HTTP-запрос столько не живёт;
 *  - параллельные анализы выжигают лицензии движка Qlik;
 *  - пользователю нужен прогресс и возможность отмены.
 *
 * Задачи выполняются последовательно (concurrency по умолчанию 1).
 */
import { EventEmitter } from 'node:events';

let counter = 0;

export class JobQueue extends EventEmitter {
  /**
   * @param {{concurrency?: number, runner?: (payload: object, ctx: object) => Promise<any>}} options
   */
  constructor(options = {}) {
    super();
    this.concurrency = Math.max(1, Number(options.concurrency ?? 1));
    this.runner = options.runner ?? (async () => { throw new Error('runner не задан'); });
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
  }

  /**
   * Ставит задачу в очередь.
   * @param {'analyze-app'|'analyze-all'} type
   * @param {object} payload
   * @param {string} [requestedBy] — пользователь, запустивший задачу
   */
  enqueue(type, payload, requestedBy = 'anonymous') {
    counter += 1;
    const id = `job-${Date.now()}-${counter}`;
    const job = {
      id,
      type,
      payload,
      requestedBy,
      status: 'queued',
      progress: { phase: 'queued', index: 0, total: 0 },
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.emit('job', this.snapshot(job));
    // Запуск откладываем на следующий тик: иначе задача успела бы стартовать
    // синхронно, и её нельзя было бы отменить, пока она в очереди.
    setImmediate(() => this.#pump());
    return job;
  }

  /** Отмена задачи (если ещё не началась — снимается из очереди). */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return false;
    job.cancelRequested = true;
    const pos = this.queue.indexOf(id);
    if (pos !== -1) {
      this.queue.splice(pos, 1);
      job.status = 'canceled';
      job.finishedAt = new Date().toISOString();
      this.emit('job', this.snapshot(job));
      return true;
    }
    // Задача уже выполняется — отмена через ctx.shouldStop.
    this.emit('job', this.snapshot(job));
    return true;
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : null;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((j) => this.snapshot(j));
  }

  /** Публичное представление задачи (без внутренних полей). */
  snapshot(job) {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      requestedBy: job.requestedBy,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      result: job.result,
    };
  }

  /** Запускает задачи, пока не упрёмся в лимит параллелизма. */
  #pump() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job) continue;
      this.running += 1;
      this.#run(job).finally(() => {
        this.running -= 1;
        this.#pump();
      });
    }
  }

  async #run(job) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.progress = { phase: 'start', index: 0, total: 0 };
    this.emit('job', this.snapshot(job));

    const ctx = {
      jobId: job.id,
      requestedBy: job.requestedBy,
      shouldStop: () => job.cancelRequested,
      onProgress: (p) => {
        job.progress = { ...job.progress, ...p };
        this.emit('job', this.snapshot(job));
      },
    };

    try {
      const result = await this.runner(job.type, job.payload, ctx);
      if (job.cancelRequested) {
        job.status = 'canceled';
        job.progress = { ...job.progress, phase: 'stopped' };
      } else {
        job.status = 'done';
        job.result = result;
      }
    } catch (err) {
      job.status = 'failed';
      job.error = String(err?.message ?? err);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.emit('job', this.snapshot(job));
    }
  }
}
