/**
 * Сводный отчёт по пакетному анализу: таблица приложений, топ проблемных,
 * суммарные цифры. Один самодостаточный HTML-файл.
 */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mb = (bytes) => (bytes == null ? '—' : `${Math.round(bytes / 1048576).toLocaleString('ru-RU')} МБ`);

export function renderSummaryHtml({ results, totals, platform = 'qlikview', generatedAt = new Date().toISOString() }) {
  const rows = results
    .slice()
    .sort((a, b) => (b.summary?.findings?.total ?? -1) - (a.summary?.findings?.total ?? -1));

  const appRows = rows.map((r) => {
    const f = r.summary?.findings ?? {};
    const sev = f.bySeverity ?? {};
    const cat = f.byCategory ?? {};
    return `<tr>
      <td><b>${esc(r.title)}</b><div class="muted small">${esc(r.appId)}</div></td>
      <td>${mb(r.size)}</td>
      <td class="num">${f.total ?? 0}</td>
      <td class="num err">${sev.error ?? 0}</td>
      <td class="num warn">${sev.warning ?? 0}</td>
      <td class="num">${sev.info ?? 0}</td>
      <td class="num">${cat.Script ?? 0}</td>
      <td class="num">${cat.Resources ?? 0}</td>
      <td class="num">${cat.Quality ?? 0}</td>
      <td class="num">${cat.Practices ?? 0}</td>
      <td>${r.error ? `<span class="err">${esc(r.error)}</span>` : (r.fromCache ? '<span class="muted">из кэша</span>' : '')}</td>
    </tr>`;
  }).join('\n');

  const top = rows.filter((r) => r.summary?.findings?.total).slice(0, 20);
  const topList = top.map((r, i) => `<li><b>${i + 1}. ${esc(r.title)}</b> — ${r.summary.findings.total} находок
    <span class="muted">(${esc(Object.entries(r.summary.findings.byCategory).map(([k, v]) => `${k}: ${v}`).join(', '))})</span></li>`).join('\n');

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Сводный анализ Qlik — ${rows.length} приложений</title>
<style>
  body{margin:0;padding:24px 28px;background:#f5f7fa;color:#1c2733;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}
  h1{margin:0 0 4px;font-size:24px;color:#1f3b5c}
  h2{margin:26px 0 10px;font-size:17px;color:#1f3b5c}
  .sub{color:#64748b;margin-bottom:18px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;min-width:150px}
  .card .n{font-size:26px;font-weight:700;color:#1f3b5c}
  .card .l{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
  th,td{padding:7px 9px;border-bottom:1px solid #eef2f7;text-align:left;vertical-align:top}
  th{background:#1f3b5c;color:#fff;font-size:11px;text-transform:uppercase}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .err{color:#c0392b}.warn{color:#b9770e}
  .muted{color:#64748b}.small{font-size:12px}
  ol{padding-left:20px}li{margin-bottom:4px}
</style></head><body>
<h1>Сводный анализ приложений Qlik</h1>
<div class="sub">Платформа: ${esc(platform === 'qlik-sense' ? 'Qlik Sense' : 'QlikView 12')} · сформирован: ${esc(generatedAt)}</div>

<div class="cards">
  <div class="card"><div class="n">${totals.apps}</div><div class="l">приложений</div></div>
  <div class="card"><div class="n">${totals.findings}</div><div class="l">находок всего</div></div>
  <div class="card"><div class="n err">${totals.bySeverity.error ?? 0}</div><div class="l">ошибок</div></div>
  <div class="card"><div class="n warn">${totals.bySeverity.warning ?? 0}</div><div class="l">предупреждений</div></div>
  <div class="card"><div class="n">${totals.removableRows.toLocaleString('ru-RU')}</div><div class="l">строк можно убрать</div></div>
  <div class="card"><div class="n">${totals.errors}</div><div class="l">приложений с ошибкой</div></div>
</div>

<h2>Топ проблемных приложений</h2>
<ol>${topList || '<li class="muted">Находок нет</li>'}</ol>

<h2>Все приложения</h2>
<table>
<thead><tr><th>Приложение</th><th>Размер</th><th>Всего</th><th>Ошибок</th><th>Предупр.</th><th>Замечаний</th>
<th>Script</th><th>Resources</th><th>Quality</th><th>Practices</th><th>Статус</th></tr></thead>
<tbody>${appRows}</tbody></table>
</body></html>`;
}
