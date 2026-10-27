/**
 * Генерация HTML-отчёта (без внешних зависимостей: inline CSS + немного JS для фильтров).
 */
import { CATEGORIES, SEVERITIES } from '../rules/index.js';

const SEVERITY_LABEL = { error: 'Ошибка', warning: 'Предупреждение', info: 'Замечание' };

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
  :root { --navy:#1f3b5c; --bg:#f5f7fa; --err:#c0392b; --warn:#b9770e; --info:#2c7a4b; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 28px; background:var(--bg); color:#1c2733;
         font:14px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  h1 { margin:0 0 4px; font-size:24px; color:var(--navy); }
  h2 { margin:28px 0 10px; font-size:17px; color:var(--navy); }
  .sub { color:#5b6b7c; margin-bottom:18px; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0; }
  .card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 18px; min-width:150px; }
  .card-num { font-size:26px; font-weight:700; color:var(--navy); }
  .card-label { color:#5b6b7c; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .chip { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; margin-right:6px;
          background:#e8eef6; color:#33465c; }
  .sev-error { color:#fff; background:var(--err); }
  .sev-warning { color:#fff; background:var(--warn); }
  .sev-info { color:#fff; background:var(--info); }
  .pill { display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; color:#fff; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:9px 11px; border-bottom:1px solid #eef2f7; vertical-align:top; }
  th { background:var(--navy); color:#fff; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  tr:last-child td { border-bottom:none; }
  .muted { color:#64748b; }
  .small { font-size:12px; }
  code { background:#eef2f7; padding:1px 5px; border-radius:4px; font-size:12px; }
  pre.patch { background:#0f2338; color:#e6f0fa; padding:14px 16px; border-radius:8px; overflow:auto; }
  .toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:10px 0 14px; }
  .toolbar button { border:1px solid #cbd5e1; background:#fff; border-radius:999px; padding:5px 14px; cursor:pointer; font-size:13px; }
  .toolbar button.active { background:var(--navy); color:#fff; border-color:var(--navy); }
  .toolbar .sep { width:1px; height:20px; background:var(--line); }
  .toolbar .search { flex:1 1 240px; min-width:200px; padding:6px 10px; border:1px solid #cbd5e1; border-radius:999px; font-size:13px; }
  a { color:#1d4ed8; }
  .skipped { background:#fff8e6; border:1px solid #f0d9a0; padding:10px 12px; border-radius:8px; font-size:13px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin:12px 0 4px; }
  .stat { background:#fff; border:1px solid #e2e8f0; border-radius:8px; padding:10px 12px; }
  .stat b { display:block; font-size:19px; color:var(--navy); }
`;

/**
 * @param {object} result — результат analyze()
 * @returns {string} HTML
 */
export function renderHtml(result) {
  const { summary, findings, ruleStats, patch } = result;
  const meta = summary;

  const cards = CATEGORIES.map((cat) => `
      <div class="card">
        <div class="card-num">${meta.findings.byCategory[cat] ?? 0}</div>
        <div class="card-label">${cat}</div>
      </div>`).join('');

  const sevChips = SEVERITIES.map((s) => `
      <span class="chip sev-${s}">${SEVERITY_LABEL[s]}: ${meta.findings.bySeverity[s] ?? 0}</span>`).join('');

  const rows = findings.map((f) => `
      <tr data-category="${escapeHtml(f.category)}" data-severity="${escapeHtml(f.severity)}" data-rule="${escapeHtml(f.ruleId)}">
        <td><span class="pill sev-${escapeHtml(f.severity)}">${escapeHtml(SEVERITY_LABEL[f.severity] ?? f.severity)}</span></td>
        <td><code>${escapeHtml(f.ruleId)}</code></td>
        <td>${escapeHtml(f.category)}</td>
        <td><b>${escapeHtml(f.title)}</b><div class="muted">${escapeHtml(f.message ?? '')}</div>
            ${f.detail ? `<div class="muted small">${escapeHtml(f.detail)}</div>` : ''}</td>
        <td>${escapeHtml(f.target?.kind ?? '')}<div class="muted small">${escapeHtml(f.target?.name ?? '')}</div></td>
        <td>${escapeHtml(f.recommendation ?? '')}</td>
      </tr>`).join('');

  const ruleRows = ruleStats.map((r) => `
      <tr>
        <td><code>${escapeHtml(r.id)}</code></td>
        <td>${escapeHtml(r.category)}</td>
        <td><span class="pill ${escapeHtml(r.severity)}">${escapeHtml(r.severity)}</span></td>
        <td title="${escapeHtml(r.description ?? '')}">
          <b>${escapeHtml(r.title)}</b>
          <div class="muted small">${escapeHtml(r.description ?? '')}</div>
          ${r.note ? `<div class="muted small">${escapeHtml(r.note)}</div>` : ''}
        </td>
        <td class="muted small">${escapeHtml(r.recommendation ?? '')}</td>
        <td>${r.skipped ? '<span class="muted">выключено</span>' : `<b>${r.count}</b>`}</td>
      </tr>`).join('');
  const skipped = (meta.skipped ?? []).length
    ? `<div class="skipped"><b>Пропущенные проверки (${meta.skipped.length}):</b> ${meta.skipped
      .map((s) => `${escapeHtml(s.capability)} — ${escapeHtml(s.reason)}`).join('; ')}</div>`
    : '';

  // Полнота сбора метаданных: если сервер перечислил больше объектов, чем мы
  // получили, об этом надо сказать прямо — иначе выводы выглядят полными.
  const inventory = meta.inventory ?? null;
  const inventoryNote = inventory?.available && inventory.missing?.length
    ? `<div class="skipped"><b>Метаданные собраны не полностью:</b> сервер перечислил ${inventory.expected} объектов, `
      + `получено ${inventory.collected}. Не получены: ${escapeHtml([...new Set(inventory.missing)].join(', '))}.</div>`
    : '';

  const patchBlock = patch.script
    ? `<h2>Предлагаемые правки скрипта загрузки</h2>
       <p class="muted">Вставьте в конец скрипта (после всех JOIN/CONCATENATE) и выполните перезагрузку:</p>
       <pre class="patch">${escapeHtml(patch.script)}</pre>`
    : '';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Анализ качества — ${escapeHtml(meta.appName)}</title>
<style>${CSS}</style>
</head>
<body>
  <h1>Анализ качества приложения Qlik Sense</h1>
  <div class="sub">
    ${escapeHtml(meta.appName)} · источник: ${escapeHtml(meta.source)} · сформирован: ${escapeHtml(meta.generatedAt)}
  </div>

  <div class="cards">
    <div class="card"><div class="card-num">${meta.findings.total}</div><div class="card-label">Всего находок</div></div>
    ${cards}
  </div>
  <div>${sevChips}</div>

  <div class="grid">
    <div class="stat"><b>${meta.counts.sheets}</b>листов</div>
    <div class="stat"><b>${meta.counts.objects}</b>объектов</div>
    <div class="stat"><b>${meta.counts.expressions}</b>выражений</div>
    <div class="stat"><b>${meta.counts.fields}</b>полей</div>
    <div class="stat"><b>${meta.counts.tables}</b>таблиц</div>
    <div class="stat"><b>${meta.counts.variables}</b>переменных</div>
    ${meta.counts.masterObjects ? `<div class="stat"><b>${meta.counts.masterObjects}</b>master-объектов</div>` : ''}
    ${meta.counts.connections ? `<div class="stat"><b>${meta.counts.connections}</b>подключений</div>` : ''}
  </div>

  ${inventoryNote}

  ${skipped}

  <h2>Находки</h2>
  <div class="toolbar" id="filters">
    <input class="search" id="search" placeholder="Поиск по находкам…">
    <span class="sep"></span>
    <button class="active" data-sev="all" data-cat="all">Все</button>
    ${SEVERITIES.map((s) => `<button data-sev="${escapeHtml(s)}" data-cat="all">${escapeHtml(SEVERITY_LABEL[s])}</button>`).join('')}
    <span class="sep"></span>
    ${CATEGORIES.map((c) => `<button data-sev="all" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
    <span class="muted" id="counter"></span>
  </div>
  <table id="findings">
    <thead><tr><th>Уровень</th><th>Правило</th><th>Категория</th><th>Находка</th><th>Объект</th><th>Рекомендация</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">Находок нет — приложение чистое по заданным правилам.</td></tr>'}</tbody>
  </table>

  ${patchBlock}

  <h2>Каталог правил</h2>
  <table>
    <thead><tr><th>ID</th><th>Категория</th><th>Уровень</th><th>Правило</th><th>Рекомендация</th><th>Срабатываний</th></tr></thead>
    <tbody>${ruleRows}</tbody>
  </table>

  <script>
    (function () {
      var btns = document.querySelectorAll('#filters button');
      var rows = document.querySelectorAll('#findings tbody tr');
      var search = document.getElementById('search');
      var counter = document.getElementById('counter');
      var state = { sev: 'all', cat: 'all', q: '' };

      function apply() {
        var shown = 0;
        rows.forEach(function (r) {
          var okSev = state.sev === 'all' || r.dataset.severity === state.sev;
          var okCat = state.cat === 'all' || r.dataset.category === state.cat;
          var okQ = !state.q
            || (r.textContent || '').toLowerCase().indexOf(state.q) !== -1;
          var show = okSev && okCat && okQ;
          r.style.display = show ? '' : 'none';
          if (show) shown += 1;
        });
        if (counter) counter.textContent = 'показано ' + shown + ' из ' + rows.length;
      }

      btns.forEach(function (b) {
        b.addEventListener('click', function () {
          btns.forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          state.sev = b.dataset.sev || 'all';
          state.cat = b.dataset.cat || 'all';
          apply();
        });
      });

      if (search) {
        search.addEventListener('input', function () {
          state.q = (search.value || '').trim().toLowerCase();
          apply();
        });
      }
      apply();
    })();
  </script>
</body>
</html>`;
}
