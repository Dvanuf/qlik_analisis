/**
 * Веб-интерфейс сервера Qlik Quality.
 * Общается с REST API; прогресс задач приходит через SSE (/api/stream).
 */
const state = {
  me: null,
  apps: [],
  jobs: [],
  reports: [],
  rules: [],
  appSearch: '',
  ruleSearch: '',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function showAlert(message, kind = 'error') {
  const el = $('#alert');
  el.textContent = message;
  el.className = `alert ${kind}`;
  el.hidden = false;
  if (kind === 'ok') setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    showAlert('Требуется авторизация. Обновите страницу и введите логин/пароль.', 'error');
    throw new Error('401');
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mb = (bytes) => (bytes == null ? '—' : `${Math.round(bytes / 1048576).toLocaleString('ru-RU')} МБ`);

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU') : '—');

// --- вкладки ---
$$('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === btn.dataset.tab));
  });
});

// --- загрузка данных ---
async function loadMe() {
  state.me = await api('/api/me');
  $('#whoami').textContent = `${state.me.user} · роль ${state.me.role}`;
  if (!state.me.canAnalyze) {
    $('#btn-analyze-all').disabled = true;
    showAlert('У вас роль наблюдателя: просмотр отчётов доступен, запуск анализа — нет.', 'warn');
  }
}

async function loadJobs() {
  const { jobs } = await api('/api/jobs');
  state.jobs = jobs;
  renderJobs();
}

const STATUS_RU = {
  queued: 'в очереди', running: 'выполняется', done: 'готово',
  failed: 'ошибка', canceled: 'отменено',
};

function renderJobs() {
  $('#jobs-table tbody').innerHTML = state.jobs.map((j) => {
    const p = j.progress ?? {};
    const progress = p.total
      ? `${p.index ?? 0} / ${p.total} — ${esc(p.title ?? '')}`
      : (p.phase ?? '');
    const result = j.result?.reportId
      ? `<a href="/reports/${j.result.reportId}.html" target="_blank">отчёт</a>`
      : '';
    return `<tr>
      <td><code>${esc(j.id)}</code></td>
      <td>${j.type === 'analyze-all' ? 'все приложения' : 'приложение'}</td>
      <td><span class="pill ${esc(j.status)}">${STATUS_RU[j.status] ?? esc(j.status)}</span>
        ${j.error ? `<div class="err small">${esc(j.error)}</div>` : ''}</td>
      <td class="muted small">${progress}</td>
      <td class="muted small">${esc(j.requestedBy)}</td>
      <td>${result}${j.status === 'running' || j.status === 'queued'
        ? `<button data-cancel="${esc(j.id)}">отменить</button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">задач нет</td></tr>';

  $$('#jobs-table button[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/jobs/${btn.dataset.cancel}/cancel`, { method: 'POST' });
        showAlert('Задача отменена', 'ok');
        await loadJobs();
      } catch (err) {
        showAlert(err.message);
      }
    });
  });
}

async function loadReports() {
  const { reports } = await api('/api/reports');
  state.reports = reports;
  $('#reports-table tbody').innerHTML = reports.map((r) => `
    <tr>
      <td>${esc(r.title)}<div class="muted small"><code>${esc(r.jobId)}</code></div></td>
      <td>${r.type === 'analyze-all' ? 'сводный' : 'приложение'}</td>
      <td class="muted small">${fmtDate(r.createdAt)}</td>
      <td class="muted small">${esc(r.requestedBy)}</td>
      <td>
        <a href="${esc(r.htmlUrl)}" target="_blank">открыть</a>
        <a href="${esc(r.jsonUrl)}" target="_blank">JSON</a>
        <button data-del="${esc(r.jobId)}">удалить</button>
      </td>
    </tr>`).join('')
    || '<tr><td colspan="5" class="muted">отчётов пока нет</td></tr>';

  $$('#reports-table button[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/reports/${btn.dataset.del}`, { method: 'DELETE' });
        await loadReports();
      } catch (err) {
        showAlert(err.message);
      }
    });
  });
}

async function loadRules() {
  const data = await api('/api/rules');
  state.rules = data.rules;
  renderRules();
}

function renderRules() {
  const q = state.ruleSearch.trim().toLowerCase();
  const list = state.rules.filter((r) => !q
    || `${r.id} ${r.title} ${r.qsdaName ?? ''} ${r.description}`.toLowerCase().includes(q));
  $('#rules-count').textContent = `показано ${list.length} из ${state.rules.length}`;
  $('#rules-table tbody').innerHTML = list.map((r) => `
    <tr>
      <td><code>${esc(r.id)}</code></td>
      <td>${esc(r.category)}</td>
      <td><span class="pill ${esc(r.severity)}">${esc(r.severity)}</span></td>
      <td><b>${esc(r.title)}</b><div class="muted small">${esc(r.description)}</div></td>
      <td>${r.qsdaUrl
        ? `<a href="${esc(r.qsdaUrl)}" target="_blank">${esc(r.qsdaName)}</a>`
        : '<span class="muted">—</span>'}</td>
      <td class="muted small">${(r.platforms ?? []).map((p) => (p === 'qlik-sense' ? 'Qlik Sense' : 'QlikView')).join(', ')}</td>
    </tr>`).join('');
}

// --- SSE: прогресс задач ---
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (evt) => {
    try {
      const job = JSON.parse(evt.data);
      const idx = state.jobs.findIndex((j) => j.id === job.id);
      if (idx === -1) state.jobs.unshift(job);
      else state.jobs[idx] = job;
      renderJobs();
      if (job.status === 'done' && job.result?.reportId) {
        loadReports();
        showAlert('Анализ завершён, отчёт готов', 'ok');
      }
      if (job.status === 'failed') showAlert(`Ошибка анализа: ${job.error}`);
    } catch { /* некорректное сообщение — пропускаем */ }
  };
  es.onerror = () => { /* браузер переподключится сам */ };
}

// --- события ---
$('#app-search').addEventListener('input', (e) => {
  state.appSearch = e.target.value;
  renderApps();
});
$('#rule-search').addEventListener('input', (e) => {
  state.ruleSearch = e.target.value;
  renderRules();
});
$('#btn-reload-apps').addEventListener('click', () => void loadApps());
$('#btn-analyze-all').addEventListener('click', async () => {
  try {
    const res = await api('/api/analyze-all', { method: 'POST', body: '{}' });
    showAlert(`Пакетный анализ в очереди: ${res.jobId}`, 'ok');
    await loadJobs();
  } catch (err) {
    showAlert(err.message);
  }
});

// --- старт ---
(async () => {
  try {
    await loadMe();
    await Promise.all([loadRules(), loadJobs(), loadReports()]);
    connectStream();
    await loadApps();
  } catch (err) {
    showAlert(err.message);
  }
})();
