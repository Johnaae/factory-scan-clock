const tankNumber = document.getElementById('tankNumber');
const tankDescription = document.getElementById('tankDescription');
const tankSearch = document.getElementById('tankSearch');
const btnClearTankSearch = document.getElementById('btnClearTankSearch');
const tankStatusFilter = document.getElementById('tankStatusFilter');
const btnAddTank = document.getElementById('btnAddTank');
const tankHint = document.getElementById('tankHint');
const tankBody = document.getElementById('tankBody');
const logoutBtn = document.getElementById('logoutBtn');
const pinWm1 = document.getElementById('pinWm1');
const pinWm2 = document.getElementById('pinWm2');
const pinWm3 = document.getElementById('pinWm3');
const showPinWm1 = document.getElementById('showPinWm1');
const showPinWm2 = document.getElementById('showPinWm2');
const showPinWm3 = document.getElementById('showPinWm3');
const btnSaveKioskPins = document.getElementById('btnSaveKioskPins');
const kioskPinHint = document.getElementById('kioskPinHint');
const ownerSecuritySection = document.getElementById('ownerSecuritySection');
const ownerCurrentPassword = document.getElementById('ownerCurrentPassword');
const ownerNewPassword = document.getElementById('ownerNewPassword');
const ownerConfirmPassword = document.getElementById('ownerConfirmPassword');
const showOwnerPasswords = document.getElementById('showOwnerPasswords');
const btnChangeOwnerPassword = document.getElementById('btnChangeOwnerPassword');
const ownerPasswordHint = document.getElementById('ownerPasswordHint');
const managerResetPassword = document.getElementById('managerResetPassword');
const managerResetConfirmPassword = document.getElementById('managerResetConfirmPassword');
const showManagerResetPassword = document.getElementById('showManagerResetPassword');
const btnResetManagerPassword = document.getElementById('btnResetManagerPassword');
const managerResetHint = document.getElementById('managerResetHint');
const tankReportBackdrop = document.getElementById('tankReportBackdrop');
const tankReportTitle = document.getElementById('tankReportTitle');
const tankReportBody = document.getElementById('tankReportBody');
const btnCloseTankReport = document.getElementById('btnCloseTankReport');
const btnPrintTankReport = document.getElementById('btnPrintTankReport');
let currentAuthUser = null;
let tanksFetchSeq = 0;
let tankActionInFlight = false;

function setAlert(el, message, type) {
  if (!el) return;
  el.textContent = message || '';
  el.classList.remove('is-success', 'is-error');
  if (!message) return;
  if (type === 'success') el.classList.add('is-success');
  if (type === 'error') el.classList.add('is-error');
}

async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function tankIsActive(t) {
  const st = String((t && t.status) || 'active').toLowerCase();
  return st === 'active' || st === 'paused' || st === '';
}

function fmtTankDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

function tankCreatedIso(t) {
  return t.created_at || t.updated_at || null;
}

function computeTankDurationMsClient(t) {
  const createdIso = tankCreatedIso(t);
  if (!createdIso) return 0;
  const created = new Date(createdIso).getTime();
  if (Number.isNaN(created)) return 0;
  let end = Date.now();
  if (!tankIsActive(t) && t.completed_at) {
    end = new Date(t.completed_at).getTime();
    if (Number.isNaN(end)) end = Date.now();
  }
  return Math.max(0, end - created);
}

function formatTankDurationClient(t) {
  if (t.duration_display) return t.duration_display;
  const totalMins = Math.floor(computeTankDurationMsClient(t) / 60000);
  if (totalMins < 60) return `${totalMins}m`;
  if (totalMins < 24 * 60) {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const totalHours = Math.floor(totalMins / 60);
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function renderTankCreatedCell(t) {
  const text = fmtTankDateTime(tankCreatedIso(t)) || fmtTankDateTime(new Date().toISOString());
  return `<span class="tank-lifecycle-muted">${escapeHtml(text)}</span>`;
}

function renderTankCompletedCell(t) {
  if (tankIsActive(t)) {
    return '<span class="tank-lifecycle-in-progress">In Progress</span>';
  }
  const text = fmtTankDateTime(t.completed_at || t.updated_at) || fmtTankDateTime(new Date().toISOString());
  return `<span class="tank-lifecycle-muted">${escapeHtml(text)}</span>`;
}

function renderTankDurationBadge(t) {
  const isActive = tankIsActive(t);
  const label = formatTankDurationClient(t);
  const cls = isActive ? 'tank-duration-badge tank-duration-badge--active' : 'tank-duration-badge tank-duration-badge--archived';
  const icon = isActive ? '🟢' : '🔵';
  return `<span class="${cls}">${icon} ${escapeHtml(label)}</span>`;
}

function fmtIso(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '$0.00';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
}

function fmtHours(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function displayAreaName(area) {
  const map = {
    'Area A': 'Winding Machine 01',
    Fabrication: 'Winding Machine 01',
    'Winding Machine 1': 'Winding Machine 01',
    'Winding Machine 2': 'Winding Machine 02',
    'Winding Machine 3': 'Winding Machine 03',
    'Area B': 'Assembly',
    'Area C': 'QA/QC',
  };
  const s = String(area || '').trim();
  return map[s] || s || '-';
}

function areaRowMatchesFilter(rowArea, filter) {
  if (!filter || filter === 'ALL') return true;
  const normalized = displayAreaName(rowArea);
  return normalized === filter || String(rowArea || '').trim() === filter;
}

function titleCaseFlag(flag) {
  const map = {
    missing_out: 'Missing OUT',
    duplicate_scan: 'Duplicate scan',
    daily_overtime: 'Over 8h today',
    weekly_overtime: 'Over 40h week',
    overtime_warning: 'Overtime warning',
    overtime_session: 'Overtime session',
    auto_ended_at_8h: 'Auto ended at 8h',
    active_shift: 'On shift',
    stop: 'On STOP',
  };
  if (map[flag]) return map[flag];
  return String(flag || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function minutesToText(mins) {
  const m = Number(mins || 0);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

function elapsedFromIso(iso) {
  if (!iso) return '0h 0m';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '0h 0m';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  return minutesToText(mins);
}

function statusBadgeFor(value, labelOverride) {
  if (typeof FactoryStatus !== 'undefined') {
    return FactoryStatus.statusBadgeHtml(value, labelOverride ? { label: labelOverride } : undefined);
  }
  const st = String(value || '').toUpperCase();
  const cls = st === 'IN' ? 'badge-in' : st === 'STOP' ? 'badge-stop' : 'badge-out';
  const label = labelOverride || st;
  return `<span class="badge ${cls}">${label}</span>`;
}

function getTankStatusFilter() {
  const raw = tankStatusFilter ? String(tankStatusFilter.value || '').toLowerCase() : 'active';
  if (raw === 'archived' || raw === 'all') return raw;
  return 'active';
}

function tankStatusLabel(t) {
  const st = String((t && t.status) || 'active').toLowerCase();
  if (st === 'archived') return 'Completed';
  if (st === 'paused') return 'In Progress — Paused';
  return 'In Progress';
}

function tankEmptyMessage(filter) {
  if (filter === 'archived') return 'No completed tanks';
  if (filter === 'all') return 'No tanks found';
  return 'No active tanks';
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clearTankSearch() {
  if (tankSearch) tankSearch.value = '';
  void loadTanks();
}

async function loadTanks() {
  const seq = ++tanksFetchSeq;
  const q = String(tankSearch && tankSearch.value ? tankSearch.value : '').trim();
  const statusFilter = getTankStatusFilter();
  const query = new URLSearchParams({ status: statusFilter });
  if (q) query.set('search', q);
  const { res, data } = await apiJson(`/api/tanks?${query.toString()}`);
  if (seq !== tanksFetchSeq) return;
  if (!res.ok) {
    if (tankHint) tankHint.textContent = (data && data.message) || 'Could not load tanks.';
    return;
  }
  const rows = data.tanks || [];
  if (!rows.length) {
    tankBody.innerHTML = `<tr><td colspan="7" class="muted">${tankEmptyMessage(statusFilter)}</td></tr>`;
    return;
  }
  tankBody.innerHTML = rows
    .map((t) => {
      const isActive = tankIsActive(t);
      const statusBadge = isActive
        ? '<span class="badge badge-in">Active</span>'
        : '<span class="badge badge-muted">Completed</span>';
      return `<tr>
      <td><strong>${escapeHtml(t.tank_number)}</strong></td>
      <td>${escapeHtml(t.description || '-')}</td>
      <td>${statusBadge}</td>
      <td>${renderTankCreatedCell(t)}</td>
      <td>${renderTankCompletedCell(t)}</td>
      <td>${renderTankDurationBadge(t)}</td>
      <td>
        <div class="toolbar" style="justify-content:flex-start">
          <button class="btn btn-sm" data-act="report" data-id="${t.id}">View Report</button>
          <button class="btn btn-sm" data-act="edit" data-id="${t.id}">Edit</button>
          <button class="btn btn-sm" data-act="print" data-tank="${escapeHtml(t.tank_number)}">Print Barcode</button>
          ${
            isActive
              ? `<button class="btn btn-sm" data-act="archive" data-id="${t.id}">Complete Tank</button>`
              : `<button class="btn btn-sm" data-act="restore" data-id="${t.id}">Restore</button>`
          }
        </div>
      </td>
    </tr>`;
    })
    .join('');
}

async function createTank() {
  const number = String(tankNumber.value || '').trim().toUpperCase();
  const description = String(tankDescription.value || '').trim();
  if (!number) {
    tankHint.textContent = 'Tank number required.';
    return;
  }
  const { res, data } = await apiJson('/api/tanks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tank_number: number, description }),
  });
  if (!res.ok) {
    tankHint.textContent = (data && data.message) || 'Could not create tank.';
    return;
  }
  tankNumber.value = '';
  tankDescription.value = '';
  tankHint.textContent = `Tank ${number} created.`;
  await loadTanks();
}

async function editTank(id) {
  const n = window.prompt('New tank number:');
  if (!n) return;
  const d = window.prompt('Description:', '') || '';
  const { res, data } = await apiJson(`/api/tanks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tank_number: n, description: d }),
  });
  if (!res.ok) {
    tankHint.textContent = (data && data.message) || 'Update failed.';
    return;
  }
  tankHint.textContent = 'Tank updated.';
  await loadTanks();
}

async function setTankStatus(id, nextStatus) {
  if (tankActionInFlight) return;
  const makeActive = nextStatus === 'active';
  const prompt = makeActive ? 'Restore this tank to active?' : 'Complete this tank? It will move to the Completed list.';
  if (!window.confirm(prompt)) return;
  tankActionInFlight = true;
  const url = makeActive ? `/api/tanks/${id}/restore` : `/api/tanks/${id}/archive`;
  const { res, data } = await apiJson(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: makeActive ? 'active' : 'archived' }),
  });
  tankActionInFlight = false;
  if (!res.ok) {
    tankHint.textContent = (data && data.message) || 'Tank update failed.';
    return;
  }
  const filter = getTankStatusFilter();
  tankHint.textContent = makeActive
    ? 'Tank restored to active.'
    : filter === 'active'
      ? 'Tank completed. Switch to Completed or All to see it.'
      : 'Tank completed.';
  await loadTanks();
}

function closeTankReport() {
  if (!tankReportBackdrop) return;
  tankReportBackdrop.classList.remove('show');
  tankReportBackdrop.setAttribute('aria-hidden', 'true');
  if (tankReportBody) tankReportBody.innerHTML = '';
}

function renderTankReport(data) {
  const tank = data.tank || {};
  const teamCompletion = data.team_completion || {
    recorded: false,
    team_id: null,
    team_name: null,
    completed_at: null,
    confirmed_by_employee_id: null,
    confirmed_by_employee_name: null,
    confirmation_line: null,
    members: [],
    members_included: 0,
    total_team_hours: 0,
    total_estimated_labor_cost: 0,
  };
  const teamProduction = data.team_production || null;
  const memberBreakdown =
    (teamProduction && teamProduction.member_breakdown && teamProduction.member_breakdown.length
      ? teamProduction.member_breakdown
      : teamCompletion.members) || [];
  const totalLaborCost =
    teamProduction && teamProduction.total_estimated_labor_cost != null
      ? teamProduction.total_estimated_labor_cost
      : teamCompletion.total_estimated_labor_cost || 0;
  const totalTeamHours =
    teamProduction && teamProduction.total_hours != null
      ? teamProduction.total_hours
      : teamCompletion.total_team_hours || 0;

  const statusLabel = tankStatusLabel(tank);
  const isActive = tankIsActive(tank);

  const lifecycleSection = `
    <section class="tank-report-section tank-lifecycle-panel">
      <h4 class="tank-report-section-title">Tank Lifecycle</h4>
      <div class="tank-lifecycle-grid">
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Tank #</div>
          <div class="tank-lifecycle-value">#${escapeHtml(tank.tank_number)}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Status</div>
          <div class="tank-lifecycle-value"><span class="badge ${isActive ? 'badge-in' : 'badge-muted'}">${statusLabel}</span></div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Description</div>
          <div class="tank-lifecycle-value">${escapeHtml(tank.description || 'No description')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Created</div>
          <div class="tank-lifecycle-value">${renderTankCreatedCell(tank)}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Completed</div>
          <div class="tank-lifecycle-value">${renderTankCompletedCell(tank)}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Duration</div>
          <div class="tank-lifecycle-value">${renderTankDurationBadge(tank)}</div>
        </div>
      </div>
    </section>`;

  const teamCompletionSection = `<section class="tank-report-section tank-team-completion-panel">
      <h4 class="tank-report-section-title">Team Completion</h4>
      ${
        teamCompletion.recorded && teamCompletion.confirmation_line
          ? `<p class="tank-team-completion-summary">${escapeHtml(teamCompletion.confirmation_line)}</p>`
          : ''
      }
      ${
        teamCompletion.recorded
          ? `<div class="tank-lifecycle-grid">
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Team Name</div>
          <div class="tank-lifecycle-value">${escapeHtml(teamCompletion.team_name || '—')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Completed At</div>
          <div class="tank-lifecycle-value">${teamCompletion.completed_at ? fmtIso(teamCompletion.completed_at) : '—'}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Confirmed By</div>
          <div class="tank-lifecycle-value">${escapeHtml(teamCompletion.confirmed_by_employee_name || '—')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Members Included</div>
          <div class="tank-lifecycle-value">${Number(teamCompletion.members_included) || 0}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Total Team Hours</div>
          <div class="tank-lifecycle-value">${fmtHours(teamCompletion.total_team_hours || 0)}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Total Labor Cost</div>
          <div class="tank-lifecycle-value">${fmtMoney(teamCompletion.total_estimated_labor_cost || 0)}</div>
        </div>
      </div>`
          : `<p class="muted tank-team-completion-empty">No team completion recorded for this tank.</p>`
      }
    </section>`;

  const phaseTimeSummary =
    (teamProduction && teamProduction.phase_time_summary) || data.phase_time_summary || [];

  const phaseSummarySection =
    phaseTimeSummary.length > 0
      ? `<div class="tank-phase-summary-panel tank-phase-summary-panel--inline">
      <h5 class="tank-report-subsection-title">Phase Time Summary</h5>
      <ul class="phase-time-summary-list phase-time-summary-list--report">
        ${phaseTimeSummary
          .map(
            (row) =>
              `<li class="phase-time-summary-item phase-time-summary-item--${escapeHtml(row.status || 'not_started')}">${escapeHtml(row.summary_line || row.phase_name || '')}</li>`
          )
          .join('')}
      </ul>
    </div>`
      : '';

  const phaseBlocks =
    teamProduction && (teamProduction.phases || []).length
      ? teamProduction.phases
          .map((phase) => {
            const sessionRows = (phase.sessions || [])
              .map((s) => {
                const endLabel =
                  s.status === 'running'
                    ? 'In progress'
                    : s.status === 'stopped' && s.ended_at
                      ? fmtIso(s.ended_at)
                      : s.finished_at
                        ? fmtIso(s.finished_at)
                        : '—';
                return `<tr>
            <td>${escapeHtml(s.phase_name || '—')}</td>
            <td>${escapeHtml(s.team_name || '—')}</td>
            <td>${fmtIso(s.started_at)}</td>
            <td>${endLabel === 'In progress' ? 'In progress' : escapeHtml(endLabel)}</td>
            <td>${escapeHtml(s.duration_display || fmtHours(s.duration_hours))}</td>
            <td>${fmtMoney(s.total_estimated_cost)}</td>
            <td><span class="badge ${s.status === 'running' ? 'badge-in' : s.status === 'stopped' ? 'badge-warn' : 'badge-muted'}">${escapeHtml(s.status_label || (s.status === 'running' ? 'Running' : s.status === 'stopped' ? 'Paused' : 'Completed'))}</span></td>
            <td class="tank-report-actions">${s.id ? `<button type="button" class="btn btn-sm btn-session-details" data-session-id="${Number(s.id)}">Details</button>` : '—'}</td>
          </tr>`;
              })
              .join('');
            return `<div class="tank-phase-group">
          <h5 class="tank-report-subsection-title">${escapeHtml(phase.phase_name || phase.phase_code || 'Phase')} · ${fmtHours(phase.phase_total_hours)} total · ${fmtMoney(phase.phase_total_cost)}</h5>
          <div class="table-wrap table-scroll">
            <table class="tank-report-table">
              <thead><tr><th>Phase</th><th>Team</th><th>Start</th><th>End</th><th>Duration</th><th>Labor Cost</th><th>Status</th><th></th></tr></thead>
              <tbody>${sessionRows}</tbody>
            </table>
          </div>
        </div>`;
          })
          .join('')
      : '<p class="muted">No team production sessions recorded for this tank.</p>';

  const teamProductionSection = `<section class="tank-report-section tank-team-production-panel">
      <h4 class="tank-report-section-title">Team Production by Phase</h4>
      <p class="tank-report-summary-line"><strong>Total Labor Cost:</strong> ${fmtMoney(totalLaborCost)} · <strong>Total Team Hours:</strong> ${fmtHours(totalTeamHours)}</p>
      ${phaseSummarySection}
      ${phaseBlocks}
    </section>`;

  const memberBreakdownSection = `<section class="tank-report-section tank-member-breakdown-panel">
      <h4 class="tank-report-section-title">Member Cost Breakdown</h4>
      <div class="table-wrap table-scroll">
        <table class="tank-report-table">
          <thead><tr><th>Member</th><th>Code</th><th>Hours</th><th>Labor Cost</th></tr></thead>
          <tbody>${
            memberBreakdown.length
              ? memberBreakdown
                  .map(
                    (m) => `<tr>
            <td>${escapeHtml(m.employee_name || 'Unknown')}</td>
            <td>${escapeHtml(m.employee_code || '—')}</td>
            <td>${fmtHours(m.total_hours || 0)}</td>
            <td>${fmtMoney(m.total_estimated_cost != null ? m.total_estimated_cost : 0)}</td>
          </tr>`
                  )
                  .join('')
              : '<tr><td colspan="4" class="muted">No team member labor recorded for this tank.</td></tr>'
          }</tbody>
        </table>
      </div>
    </section>`;

  return `
    <div id="tankReportPrintArea" class="tank-report-print-area">
      ${lifecycleSection}
      ${teamCompletionSection}
      ${teamProductionSection}
      ${memberBreakdownSection}
    </div>`;
}

async function openTankReport(id) {
  if (!tankReportBackdrop || !tankReportBody) return;
  tankReportBody.innerHTML = '<p class="muted">Loading report…</p>';
  tankReportBackdrop.classList.add('show');
  tankReportBackdrop.setAttribute('aria-hidden', 'false');
  const { res, data } = await apiJson(`/api/tanks/${id}/report`);
  if (!res.ok) {
    tankReportBody.innerHTML = `<p class="muted">${escapeHtml((data && data.message) || 'Could not load tank report.')}</p>`;
    return;
  }
  if (tankReportTitle) {
    tankReportTitle.textContent = `Tank Report · ${data.tank && data.tank.tank_number ? data.tank.tank_number : id}`;
  }
  tankReportBody.innerHTML = renderTankReport(data);
  tankReportBody.querySelectorAll('.btn-session-details').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sessionId = btn.getAttribute('data-session-id');
      if (sessionId && window.SessionDetails) window.SessionDetails.open(sessionId);
    });
  });
}

function formatDurationMinutes(mins) {
  const m = Math.max(0, Number(mins) || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

async function refreshAll() {
  await loadTanks();
}

if (btnAddTank) btnAddTank.addEventListener('click', () => void createTank());
if (tankSearch) tankSearch.addEventListener('input', () => void loadTanks());
if (btnClearTankSearch) btnClearTankSearch.addEventListener('click', () => clearTankSearch());
if (tankStatusFilter) tankStatusFilter.addEventListener('change', () => void loadTanks());
if (tankBody) tankBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (act === 'print') {
    const tank = btn.getAttribute('data-tank');
    if (tank) window.open(`/manager/tank-print?tank=${encodeURIComponent(tank)}`, '_blank', 'noopener,noreferrer');
    return;
  }
  const id = Number(btn.getAttribute('data-id'));
  if (!Number.isFinite(id)) return;
  if (act === 'edit') void editTank(id);
  if (act === 'report') void openTankReport(id);
  if (act === 'archive') void setTankStatus(id, 'archived');
  if (act === 'restore') void setTankStatus(id, 'active');
});

if (btnCloseTankReport) btnCloseTankReport.addEventListener('click', closeTankReport);
if (btnPrintTankReport) {
  btnPrintTankReport.addEventListener('click', () => {
    const area = document.getElementById('tankReportPrintArea');
    if (!area) {
      window.print();
      return;
    }
    document.body.classList.add('tank-report-printing');
    window.print();
    window.setTimeout(() => document.body.classList.remove('tank-report-printing'), 500);
  });
}
if (tankReportBackdrop) {
  tankReportBackdrop.addEventListener('click', (e) => {
    if (e.target === tankReportBackdrop) closeTankReport();
  });
}

window.addEventListener('load', () => {
  void refreshAll();
  void refreshAuthUi();
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await apiJson('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}

function wirePinShow(checkbox, input) {
  if (!checkbox || !input) return;
  checkbox.addEventListener('change', () => {
    input.type = checkbox.checked ? 'text' : 'password';
  });
}
wirePinShow(showPinWm1, pinWm1);
wirePinShow(showPinWm2, pinWm2);
wirePinShow(showPinWm3, pinWm3);
wirePinShow(showOwnerPasswords, ownerCurrentPassword);
wirePinShow(showOwnerPasswords, ownerNewPassword);
wirePinShow(showOwnerPasswords, ownerConfirmPassword);
wirePinShow(showManagerResetPassword, managerResetPassword);
wirePinShow(showManagerResetPassword, managerResetConfirmPassword);

async function refreshAuthUi() {
  const { res, data } = await apiJson('/api/auth/me');
  currentAuthUser = res.ok && data && data.user ? data.user : null;
  const isOwner = !!currentAuthUser && String(currentAuthUser.role || '').toUpperCase() === 'MANAGER' && String(currentAuthUser.username || '').toLowerCase() === 'owner';
  if (ownerSecuritySection) ownerSecuritySection.style.display = isOwner ? '' : 'none';
}

async function saveKioskPins() {
  if (!kioskPinHint) return;
  setAlert(kioskPinHint, '', null);
  const body = {};
  const wm1 = pinWm1 && String(pinWm1.value || '').trim();
  const wm2 = pinWm2 && String(pinWm2.value || '').trim();
  const wm3 = pinWm3 && String(pinWm3.value || '').trim();
  if (wm1) body.wm_1_pin = wm1;
  if (wm2) body.wm_2_pin = wm2;
  if (wm3) body.wm_3_pin = wm3;
  if (!Object.keys(body).length) {
    setAlert(kioskPinHint, 'Enter at least one new PIN to update.', 'error');
    return;
  }
  if (btnSaveKioskPins) btnSaveKioskPins.disabled = true;
  const { res, data } = await apiJson('/api/manager/kiosk-pins', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    setAlert(kioskPinHint, (data && data.message) || 'Could not save PINs.', 'error');
    if (btnSaveKioskPins) btnSaveKioskPins.disabled = false;
    return;
  }
  setAlert(kioskPinHint, 'Kiosk PINs updated.', 'success');
  if (pinWm1) pinWm1.value = '';
  if (pinWm2) pinWm2.value = '';
  if (pinWm3) pinWm3.value = '';
  if (btnSaveKioskPins) btnSaveKioskPins.disabled = false;
}

if (btnSaveKioskPins) btnSaveKioskPins.addEventListener('click', () => void saveKioskPins());

async function resetManagerPassword() {
  if (!managerResetHint || !managerResetPassword) return;
  setAlert(managerResetHint, '', null);
  const next = String(managerResetPassword.value || '');
  const confirm = String(managerResetConfirmPassword && managerResetConfirmPassword.value ? managerResetConfirmPassword.value : '');
  if (next.trim().length < 6) {
    setAlert(managerResetHint, 'Password must be at least 6 characters.', 'error');
    return;
  }
  if (next !== confirm) {
    setAlert(managerResetHint, 'Passwords do not match.', 'error');
    return;
  }
  if (btnResetManagerPassword) btnResetManagerPassword.disabled = true;
  const { res, data } = await apiJson('/api/owner/reset-manager-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_password: next }),
  });
  if (!res.ok) {
    setAlert(managerResetHint, (data && data.message) || 'Could not reset manager password.', 'error');
    if (btnResetManagerPassword) btnResetManagerPassword.disabled = false;
    return;
  }
  setAlert(managerResetHint, 'Manager password reset.', 'success');
  managerResetPassword.value = '';
  if (managerResetConfirmPassword) managerResetConfirmPassword.value = '';
  if (btnResetManagerPassword) btnResetManagerPassword.disabled = false;
}

if (btnResetManagerPassword) btnResetManagerPassword.addEventListener('click', () => void resetManagerPassword());

async function changeOwnerPassword() {
  if (!ownerPasswordHint || !ownerCurrentPassword || !ownerNewPassword || !ownerConfirmPassword) return;
  setAlert(ownerPasswordHint, '', null);
  const current = String(ownerCurrentPassword.value || '');
  const next = String(ownerNewPassword.value || '');
  const confirm = String(ownerConfirmPassword.value || '');
  if (!current || next.trim().length < 6) {
    setAlert(ownerPasswordHint, 'Current password and a new password (min 6 chars) are required.', 'error');
    return;
  }
  if (next !== confirm) {
    setAlert(ownerPasswordHint, 'New password and confirm password must match.', 'error');
    return;
  }
  if (btnChangeOwnerPassword) btnChangeOwnerPassword.disabled = true;
  const { res, data } = await apiJson('/api/owner/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: current, new_password: next }),
  });
  if (!res.ok) {
    setAlert(ownerPasswordHint, (data && data.message) || 'Could not change owner password.', 'error');
    if (btnChangeOwnerPassword) btnChangeOwnerPassword.disabled = false;
    return;
  }
  setAlert(ownerPasswordHint, 'Owner password changed.', 'success');
  ownerCurrentPassword.value = '';
  ownerNewPassword.value = '';
  ownerConfirmPassword.value = '';
  if (btnChangeOwnerPassword) btnChangeOwnerPassword.disabled = false;
}

if (btnChangeOwnerPassword) btnChangeOwnerPassword.addEventListener('click', () => void changeOwnerPassword());
