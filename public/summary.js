'use strict';

const sumDate = document.getElementById('sumDate');
const sumBody = document.getElementById('sumBody');
const sumHint = document.getElementById('sumHint');
const sumFilter = document.getElementById('sumFilter');
const btnToday = document.getElementById('btnToday');
const btnRefresh = document.getElementById('btnRefresh');
const btnCsv = document.getElementById('btnCsv');
const btnPrint = document.getElementById('btnPrint');
const logoutBtn = document.getElementById('logoutBtn');

let tankRows = [];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateString(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDisplayDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function apiJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.message) || 'Request failed');
  return data;
}

function statusBadge(status) {
  const s = String(status || 'Waiting');
  const key = s.toLowerCase().replace(/\s+/g, '-');
  let cls = 'badge badge-muted';
  if (key === 'running') cls = 'badge badge-in';
  else if (key === 'break' || key === 'lunch') cls = 'badge badge-warn';
  else if (key === 'downtime') cls = 'badge badge-stop';
  else if (key === 'completed') cls = 'badge badge-out';
  else if (key === 'waiting') cls = 'badge badge-muted';
  return `<span class="${cls}">${escapeHtml(s)}</span>`;
}

function filteredRows() {
  const filter = String(sumFilter && sumFilter.value ? sumFilter.value : '')
    .trim()
    .toLowerCase();
  if (!filter) return tankRows.slice();
  return tankRows.filter((r) =>
    [r.tank_number, r.team_name, r.machine_name, r.current_phase, r.production_status, r.status]
      .join(' ')
      .toLowerCase()
      .includes(filter)
  );
}

function render() {
  const rows = filteredRows();
  if (!rows.length) {
    sumBody.innerHTML = '<tr><td colspan="10" class="muted">No tanks worked on this day.</td></tr>';
    return;
  }
  sumBody.innerHTML = rows
    .map((r) => {
      const pct = Math.max(0, Math.min(100, Number(r.percent_complete) || 0));
      const id = Number(r.tank_id);
      return `<tr>
        <td><strong>${escapeHtml(r.tank_number)}</strong></td>
        <td>${escapeHtml(r.team_name || '—')}</td>
        <td>${escapeHtml(r.machine_name || '—')}</td>
        <td>${escapeHtml(r.current_phase || '—')}</td>
        <td>${statusBadge(r.production_status)}</td>
        <td>${escapeHtml(r.current_phase_time_display || '00:00')}</td>
        <td>${escapeHtml(r.tank_total_running_time_display || '—')}</td>
        <td>
          <div class="progress-bar" style="min-width:72px;background:#e2e8f0;border-radius:6px;overflow:hidden;height:10px">
            <div style="width:${pct}%;height:100%;background:#2563eb"></div>
          </div>
          <span class="muted">${pct}%</span>
        </td>
        <td class="muted">${r.last_activity_at ? escapeHtml(formatDisplayDateTime(r.last_activity_at)) : '—'}</td>
        <td><a class="btn btn-sm" href="/manager?tankReport=${id}">View Report</a></td>
      </tr>`;
    })
    .join('');
}

async function load(date) {
  if (sumHint) sumHint.textContent = 'Loading…';
  try {
    const data = await apiJson(`/api/summary?date=${encodeURIComponent(date)}`);
    tankRows = data.tanks || [];
    if (sumHint) {
      sumHint.textContent = `Showing ${date} — ${tankRows.length} tank${tankRows.length === 1 ? '' : 's'} with production activity.`;
    }
    render();
  } catch (err) {
    if (sumHint) sumHint.textContent = err.message || 'Could not load summary.';
    sumBody.innerHTML = '<tr><td colspan="10" class="muted">Load failed.</td></tr>';
  }
}

function exportCsv() {
  const date = sumDate && sumDate.value ? sumDate.value : localDateString();
  window.location.href = `/api/summary/tanks.csv?date=${encodeURIComponent(date)}`;
}

function exportPdf() {
  const date = sumDate && sumDate.value ? sumDate.value : localDateString();
  window.location.href = `/api/summary/tanks.pdf?date=${encodeURIComponent(date)}`;
}

if (btnToday) {
  btnToday.addEventListener('click', () => {
    const d = localDateString();
    if (sumDate) sumDate.value = d;
    void load(d);
  });
}
if (btnRefresh) {
  btnRefresh.addEventListener('click', () => {
    const d = sumDate && sumDate.value ? sumDate.value : localDateString();
    void load(d);
  });
}
if (sumDate) {
  sumDate.addEventListener('change', () => {
    if (!sumDate.value) return;
    void load(sumDate.value);
  });
}
if (sumFilter) sumFilter.addEventListener('input', () => render());
if (btnCsv) btnCsv.addEventListener('click', () => exportCsv());
if (btnPrint) btnPrint.addEventListener('click', () => exportPdf());

const laborStart = document.getElementById('laborStart');
const laborEnd = document.getElementById('laborEnd');
const laborBody = document.getElementById('laborBody');
const laborFoot = document.getElementById('laborFoot');
const laborMeta = document.getElementById('laborMeta');
const laborTotalRunning = document.getElementById('laborTotalRunning');
const laborTotalLabor = document.getElementById('laborTotalLabor');
const btnLaborRefresh = document.getElementById('btnLaborRefresh');
const btnLaborCsv = document.getElementById('btnLaborCsv');
const btnLaborPdf = document.getElementById('btnLaborPdf');
const btnLaborThisWeek = document.getElementById('btnLaborThisWeek');
const btnLaborThisMonth = document.getElementById('btnLaborThisMonth');
const btnLaborLastMonth = document.getElementById('btnLaborLastMonth');

function monthBounds(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: localDateString(start), end: localDateString(end) };
}

function weekBounds(d = new Date()) {
  const day = d.getDay();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { start: localDateString(start), end: localDateString(end) };
}

function setLaborRange(start, end) {
  if (laborStart) laborStart.value = start;
  if (laborEnd) laborEnd.value = end;
}

function renderLaborReport(data) {
  if (!laborBody) return;
  const tanks = (data && data.tanks) || [];
  const totals = (data && data.totals) || {};
  if (laborMeta) {
    const range =
      data.start_date === data.end_date ? data.start_date : `${data.start_date} → ${data.end_date}`;
    laborMeta.textContent = `Range: ${range} — ${tanks.length} tank${tanks.length === 1 ? '' : 's'}.`;
  }
  if (!tanks.length) {
    laborBody.innerHTML =
      '<tr><td colspan="3" class="muted">No tanks with production activity in this date range.</td></tr>';
    if (laborFoot) laborFoot.hidden = true;
    return;
  }
  laborBody.innerHTML = tanks
    .map(
      (r) => `<tr>
        <td><strong>${escapeHtml(r.tank_number)}</strong></td>
        <td>${escapeHtml(r.total_running_display || '0h 0m')}</td>
        <td>${escapeHtml(r.total_labor_display || '0h 0m')}</td>
      </tr>`
    )
    .join('');
  if (laborFoot) laborFoot.hidden = false;
  if (laborTotalRunning) laborTotalRunning.textContent = totals.total_running_display || '0h 0m';
  if (laborTotalLabor) laborTotalLabor.textContent = totals.total_labor_display || '0h 0m';
}

async function loadLaborReport() {
  if (!laborBody) return;
  const start = laborStart && laborStart.value ? laborStart.value : localDateString();
  const end = laborEnd && laborEnd.value ? laborEnd.value : start;
  if (laborStart && !laborStart.value) laborStart.value = start;
  if (laborEnd && !laborEnd.value) laborEnd.value = end;
  if (laborMeta) laborMeta.textContent = 'Loading…';
  try {
    const data = await apiJson(
      `/api/summary/tank-labor-report?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
    );
    renderLaborReport(data);
  } catch (err) {
    laborBody.innerHTML = `<tr><td colspan="3" class="muted">${escapeHtml(err.message || 'Load failed.')}</td></tr>`;
    if (laborFoot) laborFoot.hidden = true;
    if (laborMeta) laborMeta.textContent = '';
  }
}

function exportLaborCsv() {
  const start = laborStart && laborStart.value ? laborStart.value : localDateString();
  const end = laborEnd && laborEnd.value ? laborEnd.value : start;
  window.location.href = `/api/summary/tank-labor.csv?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
}

function exportLaborPdf() {
  const start = laborStart && laborStart.value ? laborStart.value : localDateString();
  const end = laborEnd && laborEnd.value ? laborEnd.value : start;
  window.location.href = `/api/summary/tank-labor.pdf?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
}

if (btnLaborRefresh) btnLaborRefresh.addEventListener('click', () => void loadLaborReport());
if (btnLaborCsv) btnLaborCsv.addEventListener('click', () => exportLaborCsv());
if (btnLaborPdf) btnLaborPdf.addEventListener('click', () => exportLaborPdf());
if (btnLaborThisWeek) {
  btnLaborThisWeek.addEventListener('click', () => {
    const b = weekBounds();
    setLaborRange(b.start, b.end);
    void loadLaborReport();
  });
}
if (btnLaborThisMonth) {
  btnLaborThisMonth.addEventListener('click', () => {
    const b = monthBounds();
    setLaborRange(b.start, b.end);
    void loadLaborReport();
  });
}
if (btnLaborLastMonth) {
  btnLaborLastMonth.addEventListener('click', () => {
    const d = new Date();
    const b = monthBounds(new Date(d.getFullYear(), d.getMonth() - 1, 1));
    setLaborRange(b.start, b.end);
    void loadLaborReport();
  });
}
if (laborStart) laborStart.addEventListener('change', () => void loadLaborReport());
if (laborEnd) laborEnd.addEventListener('change', () => void loadLaborReport());

window.addEventListener('load', () => {
  const d = localDateString();
  if (sumDate) sumDate.value = d;
  void load(d);
  if (laborStart && laborEnd) {
    const month = monthBounds();
    setLaborRange(month.start, month.end);
    void loadLaborReport();
  }
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}
