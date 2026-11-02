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
  ai: { status: null, messages: [], busy: false },
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

  // Список отчётов нужен и для выбора контекста в ИИ-чате.
  renderAiReports();

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
    || `${r.id} ${r.title} ${r.description} ${r.recommendation ?? ''}`.toLowerCase().includes(q));
  $('#rules-count').textContent = `показано ${list.length} из ${state.rules.length}`;
  $('#rules-table tbody').innerHTML = list.map((r) => `
    <tr>
      <td><code>${esc(r.id)}</code></td>
      <td>${esc(r.category)}</td>
      <td><span class="pill ${esc(r.severity)}">${esc(r.severity)}</span></td>
      <td><b>${esc(r.title)}</b><div class="muted small">${esc(r.description)}</div></td>
      <td class="muted small">${esc(r.recommendation ?? '')}</td>
      <td class="muted small">${(r.platforms ?? []).map((p) => (p === 'qlik-sense' ? 'Qlik Sense' : 'QlikView')).join(', ')}</td>
    </tr>`).join('');
}

// --- ИИ-чат ---
async function loadAiStatus() {
  try {
    state.ai.status = await api('/api/ai/status');
  } catch {
    state.ai.status = null;
  }
  renderAiStatus();
  renderAiReports();
}

function renderAiStatus() {
  const st = state.ai.status;
  const el = $('#ai-status');
  if (!st) {
    el.textContent = 'ИИ-слой недоступен';
    return;
  }
  const ready = st.providers.filter((p) => !p.needsKey || p.hasKey).map((p) => p.label);
  el.textContent = `провайдер: ${st.provider} · доступны: ${ready.join(', ') || 'нет'}`
    + ` · лимит ${st.limits.requestsPerMinute}/мин, ${st.limits.dailyCap}/сутки`;
  // Наблюдатель не может задавать вопросы — роль analyst обязательна.
  const canAsk = Boolean(state.me?.canAnalyze);
  $('#ai-send').disabled = !canAsk || state.ai.busy;
  $('#ai-question').disabled = !canAsk;
  if (!canAsk) el.textContent += ' · нужна роль analyst';
}

function renderAiReports() {
  const select = $('#ai-report');
  const current = select.value;
  select.innerHTML = state.reports.map((r) =>
    `<option value="${esc(r.jobId)}">${esc(r.title)} — ${esc(r.jobId)}</option>`).join('');
  if (current) select.value = current;
}

function renderAiLog() {
  const log = $('#ai-log');
  log.innerHTML = state.ai.messages.map((m) => `
    <div class="ai-msg ${m.role}">
      <div class="ai-msg-head"><b>${m.role === 'user' ? 'Вы' : 'ИИ'}</b>${
  m.provider ? `<span class="muted small">${esc(m.provider)}</span>` : ''}${
  m.note ? `<span class="muted small">${esc(m.note)}</span>` : ''}</div>
      <div class="ai-msg-text">${esc(m.text)}</div>
    </div>`).join('')
    || '<p class="muted">Задайте вопрос по результатам анализа.</p>';
  log.scrollTop = log.scrollHeight;
}

async function sendAiQuestion() {
  const input = $('#ai-question');
  const question = input.value.trim();
  if (!question || state.ai.busy) return;
  input.value = '';
  state.ai.messages.push({ role: 'user', text: question });
  state.ai.busy = true;
  renderAiLog();
  renderAiStatus();
  try {
    const reportId = $('#ai-report').value;
    const res = await api('/api/ai/analyze', {
      method: 'POST',
      body: JSON.stringify(reportId ? { question, reportId } : { question }),
    });
    const notes = [];
    if (res.truncated) notes.push('сводка обрезана');
    if (res.redacted) notes.push('данные обезличены');
    if (res.cached) notes.push('ответ из кэша');
    state.ai.messages.push({
      role: 'assistant',
      text: res.text ?? 'Пустой ответ',
      provider: res.provider,
      note: notes.join(' · '),
    });
  } catch (err) {
    state.ai.messages.push({ role: 'assistant', text: `Ошибка: ${err.message}` });
  } finally {
    state.ai.busy = false;
    renderAiLog();
    renderAiStatus();
  }
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
$('#ai-send').addEventListener('click', () => void sendAiQuestion());
$('#ai-question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendAiQuestion();
  }
});
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
    await Promise.all([loadRules(), loadJobs(), loadReports(), loadAiStatus()]);
    connectStream();
    await loadApps();
  } catch (err) {
    showAlert(err.message);
  }
})();
