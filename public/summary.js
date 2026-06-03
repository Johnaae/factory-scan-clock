const sumDate = document.getElementById('sumDate');
const sumBody = document.getElementById('sumBody');
const sumHint = document.getElementById('sumHint');

const sxStart = document.getElementById('sxStart');
const sxEnd = document.getElementById('sxEnd');
const sxDateRow = document.getElementById('sxDateRow');
const sxEmployeeWrap = document.getElementById('sxEmployeeWrap');
const sxEmployee = document.getElementById('sxEmployee');
const btnSxExport = document.getElementById('btnSxExport');
const sxExportHint = document.getElementById('sxExportHint');

const btnToday = document.getElementById('btnToday');
const logoutBtn = document.getElementById('logoutBtn');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function formatIsoLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${localDateString(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
    second: '2-digit',
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

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(v);
}

function populateSxEmployees(employees) {
  if (!sxEmployee) return;
  const prev = sxEmployee.value;
  sxEmployee.innerHTML = '<option value="all">All workers</option>';
  const sorted = employees
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const e of sorted) {
    const o = document.createElement('option');
    o.value = e.code;
    o.textContent = `${e.name} (${e.code})`;
    sxEmployee.appendChild(o);
  }
  const ok = [...sxEmployee.options].some((o) => o.value === prev);
  sxEmployee.value = ok ? prev : 'all';
  syncSxWorkerUi();
}

async function loadEmployeesForExport() {
  try {
    const data = await apiJson('/api/employees');
    populateSxEmployees(data.employees || []);
  } catch {
    /* ignore */
  }
}

function syncSxScopeUi() {
  const scope = document.querySelector('input[name="sxScope"]:checked');
  const v = scope ? scope.value : 'today';
  if (sxDateRow) sxDateRow.classList.toggle('is-hidden', v !== 'range');
}

function syncSxWorkerUi() {
  syncSxScopeUi();
  const wm = document.querySelector('input[name="sxWorkerMode"]:checked');
  const mode = wm ? wm.value : 'all';
  if (sxEmployeeWrap) {
    sxEmployeeWrap.classList.toggle('is-hidden', mode !== 'single');
    sxEmployeeWrap.setAttribute('aria-hidden', mode !== 'single' ? 'true' : 'false');
  }
  if (sxEmployee) {
    sxEmployee.disabled = mode !== 'single';
    if (mode === 'single') {
      if (sxEmployee.value === 'all' && sxEmployee.options.length > 1) {
        sxEmployee.selectedIndex = 1;
      }
    }
  }
}

function buildSxExportParams() {
  const format = document.querySelector('input[name="sxFormat"]:checked')?.value || 'csv';
  const scope = document.querySelector('input[name="sxScope"]:checked')?.value || 'today';
  const workerMode = document.querySelector('input[name="sxWorkerMode"]:checked')?.value || 'all';
  let employee = 'all';
  if (workerMode === 'single' && sxEmployee) {
    employee = sxEmployee.value || 'all';
  }
  const p = new URLSearchParams({ format, scope, employee });
  if (scope === 'range') {
    if (sxStart) p.set('start', sxStart.value);
    if (sxEnd) p.set('end', sxEnd.value);
  }
  return p;
}

async function runSxExport() {
  if (!btnSxExport) return;
  const scope = document.querySelector('input[name="sxScope"]:checked')?.value || 'today';
  const workerMode = document.querySelector('input[name="sxWorkerMode"]:checked')?.value || 'all';
  if (scope === 'range' && (!sxStart || !sxEnd || !sxStart.value || !sxEnd.value)) {
    if (sxExportHint) sxExportHint.textContent = 'Choose start and end dates for date range.';
    return;
  }
  if (workerMode === 'single' && sxEmployee && sxEmployee.value === 'all') {
    if (sxExportHint) sxExportHint.textContent = 'Select an employee, or switch back to all workers.';
    return;
  }

  const params = buildSxExportParams();
  const url = `/api/export?${params.toString()}`;
  const labelEl = btnSxExport.querySelector('.btn-export-label');
  const prevLabel = labelEl ? labelEl.textContent : '';
  btnSxExport.disabled = true;
  btnSxExport.classList.add('is-loading');
  btnSxExport.setAttribute('aria-busy', 'true');
  if (labelEl) labelEl.textContent = 'Preparing report…';
  if (sxExportHint) sxExportHint.textContent = 'Preparing report…';
  try {
    const res = await fetch(url);
    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (sxExportHint) sxExportHint.textContent = (j && j.message) || `Export failed (${res.status}).`;
      return;
    }
    if (ct.includes('application/json')) {
      if (sxExportHint) sxExportHint.textContent = 'Unexpected response.';
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd) || /filename\*=UTF-8''([^;\s]+)/.exec(cd);
    let fname = 'download';
    if (m) fname = decodeURIComponent(m[1].replace(/"/g, '').trim());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    const fmt = params.get('format');
    if (sxExportHint) {
      sxExportHint.textContent =
        blob.size === 0 ? `Empty ${fmt.toUpperCase()} — no matching rows.` : 'Download started.';
    }
  } catch {
    if (sxExportHint) sxExportHint.textContent = 'Network error.';
  } finally {
    btnSxExport.disabled = false;
    btnSxExport.classList.remove('is-loading');
    btnSxExport.setAttribute('aria-busy', 'false');
    if (labelEl) labelEl.textContent = prevLabel || 'Export Report';
  }
}

function render(rows, payroll) {
  const payMap = new Map();
  if (payroll && payroll.rows) {
    for (const pr of payroll.rows) {
      payMap.set(pr.employee_code, pr);
    }
  }
  const wages = payroll && payroll.rows ? payroll.rows.map((p) => Number(p.wage) || 0) : [];
  const maxWage = wages.length ? Math.max(...wages) : 0;

  const body = rows
    .map((r) => {
      const active = r.is_active ? '<span class="badge badge-in">Yes</span>' : '<span class="badge badge-muted">No</span>';
      const st =
        typeof FactoryStatus !== 'undefined'
          ? FactoryStatus.statusBadgeHtml(r.current_status)
          : r.current_status === 'IN'
            ? '<span class="badge badge-in">IN</span>'
            : r.current_status === 'STOP'
              ? '<span class="badge badge-stop">STOP</span>'
              : '<span class="badge badge-out">OUT</span>';
      const pr = payMap.get(r.employee_code);
      const w = pr ? Number(pr.wage) || 0 : 0;
      const hi = maxWage > 0 && w >= maxWage * 0.85 && w > 0 ? ' row-wage-high' : '';
      const hrs = pr ? String(pr.hours_rounded) : '—';
      const rate = pr ? formatMoney(pr.hourly_rate) : '—';
      const wage = pr ? formatMoney(pr.wage) : '—';
      return `<tr class="${hi}">
        <td><strong>${escapeHtml(r.employee_name)}</strong></td>
        <td>${escapeHtml(r.employee_code)}</td>
        <td>${active}</td>
        <td class="muted">${r.first_in ? escapeHtml(formatDisplayDateTime(r.first_in)) : '—'}</td>
        <td class="muted">${r.last_out ? escapeHtml(formatDisplayDateTime(r.last_out)) : '—'}</td>
        <td class="td-num">${String(r.total_scans || 0)}</td>
        <td>${st}</td>
        <td class="td-num">${escapeHtml(hrs)}</td>
        <td class="td-num">${escapeHtml(rate)}</td>
        <td class="td-num">${escapeHtml(wage)}</td>
      </tr>`;
    })
    .join('');
  sumBody.innerHTML = body || '<tr><td colspan="10" class="muted">No rows.</td></tr>';
}

async function load(date) {
  sumHint.textContent = 'Loading…';
  try {
    const [data, payRes] = await Promise.all([
      apiJson(`/api/summary?date=${encodeURIComponent(date)}`),
      fetch(`/api/payroll?date=${encodeURIComponent(date)}`),
    ]);
    const rows = data.rows || [];
    let payroll = null;
    if (payRes.ok) {
      payroll = await payRes.json().catch(() => null);
    }
    let payLine = '';
    if (payroll && payroll.total_payroll != null) {
      const avg =
        payroll.average_hours_per_employee != null && Number.isFinite(Number(payroll.average_hours_per_employee))
          ? `${Number(payroll.average_hours_per_employee).toFixed(1)} h avg`
          : '';
      payLine = ` Payroll: ${formatMoney(payroll.total_payroll)} · ${payroll.total_hours_rounded} h total${avg ? ` · ${avg}` : ''}.`;
    }
    sumHint.textContent = `Showing ${date} — ${rows.length} employee${rows.length === 1 ? '' : 's'}.${payLine}`;
    render(rows, payroll);
  } catch {
    sumHint.textContent = 'Could not load summary.';
    sumBody.innerHTML = '<tr><td colspan="10" class="muted">Load failed.</td></tr>';
  }
}

btnToday.addEventListener('click', () => {
  const d = localDateString();
  sumDate.value = d;
  void load(d);
});

sumDate.addEventListener('change', () => {
  const d = sumDate.value;
  if (!d) return;
  void load(d);
});

document.querySelectorAll('input[name="sxScope"]').forEach((el) => {
  el.addEventListener('change', () => syncSxWorkerUi());
});
document.querySelectorAll('input[name="sxWorkerMode"]').forEach((el) => {
  el.addEventListener('change', () => syncSxWorkerUi());
});

if (btnSxExport) {
  btnSxExport.addEventListener('click', () => void runSxExport());
}

window.addEventListener('load', () => {
  const d = localDateString();
  sumDate.value = d;
  if (sxStart) sxStart.value = d;
  if (sxEnd) sxEnd.value = d;
  if (sxExportHint) sxExportHint.textContent = 'Uses the same export engine as the dashboard.';
  syncSxWorkerUi();
  void loadEmployeesForExport();
  void load(d);
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}
