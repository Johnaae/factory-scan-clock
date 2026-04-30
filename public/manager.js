const tankNumber = document.getElementById('tankNumber');
const tankDescription = document.getElementById('tankDescription');
const tankSearch = document.getElementById('tankSearch');
const tankStatusFilter = document.getElementById('tankStatusFilter');
const btnAddTank = document.getElementById('btnAddTank');
const tankHint = document.getElementById('tankHint');
const tankBody = document.getElementById('tankBody');
const currentWorkBody = document.getElementById('currentWorkBody');
const tankSummaryBody = document.getElementById('tankSummaryBody');
const overtimeBody = document.getElementById('overtimeBody');
const areaFilter = document.getElementById('areaFilter');
const logoutBtn = document.getElementById('logoutBtn');
const pinAreaA = document.getElementById('pinAreaA');
const pinAreaB = document.getElementById('pinAreaB');
const pinAreaC = document.getElementById('pinAreaC');
const showPinA = document.getElementById('showPinA');
const showPinB = document.getElementById('showPinB');
const showPinC = document.getElementById('showPinC');
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
let currentAuthUser = null;
let currentWorkRowsCache = [];

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

function refreshCurrentWorkElapsedCells() {
  if (!currentWorkBody) return;
  const cells = currentWorkBody.querySelectorAll('[data-started-at]');
  cells.forEach((cell) => {
    const iso = cell.getAttribute('data-started-at');
    cell.textContent = elapsedFromIso(iso);
  });
}

async function loadTanks() {
  const q = String(tankSearch.value || '').trim();
  const statusFilter = (tankStatusFilter && String(tankStatusFilter.value || '').toLowerCase()) || 'active';
  const query = new URLSearchParams({
    search: q,
    status: statusFilter,
  });
  const { res, data } = await apiJson(`/api/tanks?${query.toString()}`);
  if (!res.ok) return;
  const rows = data.tanks || [];
  tankBody.innerHTML =
    rows
      .map(
        (t) => `<tr>
      <td><strong>${t.tank_number}</strong></td>
      <td>${t.description || '-'}</td>
      <td>${t.status === 'ACTIVE' ? '<span class="badge badge-in">Active</span>' : '<span class="badge badge-muted">Archived</span>'}</td>
      <td>
        <div class="toolbar" style="justify-content:flex-start">
          <button class="btn btn-sm" data-act="edit" data-id="${t.id}">Edit</button>
          <button class="btn btn-sm" data-act="print" data-tank="${t.tank_number}">Print Barcode</button>
          <button class="btn btn-sm" data-act="archive" data-id="${t.id}">${t.status === 'ACTIVE' ? 'Archive' : 'Restore'}</button>
        </div>
      </td>
    </tr>`
      )
      .join('') || '<tr><td colspan="4" class="muted">No tanks</td></tr>';
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
    body: JSON.stringify({ tank_number: n, description: d, status: 'ACTIVE' }),
  });
  if (!res.ok) {
    tankHint.textContent = (data && data.message) || 'Update failed.';
    return;
  }
  await loadTanks();
}

async function archiveTank(id, makeActive) {
  const prompt = makeActive ? 'Restore this tank?' : 'Archive this tank?';
  if (!window.confirm(prompt)) return;
  const { res, data } = await apiJson(`/api/tanks/${id}/archive`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: makeActive ? 'ACTIVE' : 'ARCHIVED' }),
  });
  if (!res.ok) {
    tankHint.textContent = (data && data.message) || 'Tank update failed.';
    return;
  }
  tankHint.textContent = makeActive ? 'Tank restored.' : 'Tank archived.';
  await loadTanks();
}

async function loadCurrentWork() {
  const { res, data } = await apiJson('/api/manager/current-work');
  if (!res.ok) return;
  const selectedArea = areaFilter ? areaFilter.value : 'ALL';
  const rows = (data.rows || []).filter((r) => selectedArea === 'ALL' || (r.area_name || '') === selectedArea);
  currentWorkRowsCache = rows;
  currentWorkBody.innerHTML =
    rows
      .map(
        (r) => `<tr>
      <td>${r.employee_name} (${r.employee_code})</td>
      <td><span class="badge badge-in">${r.status}</span></td>
      <td>${r.activity || '-'}</td>
      <td><strong>${r.tank_number || '-'}</strong></td>
      <td>${r.area_name || '-'}</td>
      <td>${fmtIso(r.started_at)}</td>
      <td data-started-at="${r.started_at || ''}">${elapsedFromIso(r.started_at)}</td>
      <td>${r.daily_hours}</td>
      <td>${r.weekly_hours}</td>
      <td>${
        Array.isArray(r.flags) && r.flags.length
          ? r.flags.map((f) => `<span class="badge badge-warn">${titleCaseFlag(f)}</span>`).join(' ')
          : r.overtime_warning
            ? '<span class="badge badge-warn">Watch</span>'
            : '<span class="badge badge-warn">Missing OUT</span>'
      }</td>
      <td>${fmtIso(r.last_scan_time)}</td>
    </tr>`
      )
      .join('') || '<tr><td colspan="11" class="muted">No one currently clocked IN.</td></tr>';
  if (currentWorkRowsCache.length) refreshCurrentWorkElapsedCells();
}

async function loadTankSummary() {
  const { res, data } = await apiJson('/api/manager/tank-summary');
  if (!res.ok) return;
  const rows = data.rows || [];
  tankSummaryBody.innerHTML =
    rows
      .map(
        (r) => `<tr>
      <td><strong>${r.tank_number}</strong></td>
      <td>${r.workers_currently_on_tank}</td>
      <td>${r.total_labor_hours_today}</td>
      <td>${r.last_activity || '-'}</td>
      <td>${r.status === 'ACTIVE' ? '<span class="badge badge-in">Active</span>' : '<span class="badge">' + r.status + '</span>'}</td>
    </tr>`
      )
      .join('') || '<tr><td colspan="5" class="muted">No tank activity yet.</td></tr>';
}

async function loadOvertime() {
  const { res, data } = await apiJson('/api/manager/overtime-watch');
  if (!res.ok) return;
  const rows = data.rows || [];
  overtimeBody.innerHTML =
    rows
      .map((r) => {
        const flags = Array.isArray(r.flags) && r.flags.length
          ? r.flags.map((f) => `<span class="badge badge-warn">${titleCaseFlag(f)}</span>`).join(' ')
          : [
              r.flag_daily_over_8h ? '<span class="badge badge-out">Over 8h today</span>' : '',
              r.flag_daily_close_8h ? '<span class="badge badge-warn">Close to 8h</span>' : '',
              r.flag_weekly_over_40h ? '<span class="badge badge-out">Over 40h week</span>' : '',
            ]
              .filter(Boolean)
              .join(' ');
        return `<tr>
          <td>${r.employee_name} (${r.employee_code})</td>
          <td>${Number(r.daily_hours || 0).toFixed(2)}</td>
          <td>${Number(r.weekly_hours || 0).toFixed(2)}</td>
          <td>${Number(r.regular_hours || 0).toFixed(2)}</td>
          <td>${Number(r.overtime_hours || 0).toFixed(2)}</td>
          <td>${fmtMoney(r.estimated_pay)}</td>
          <td>${flags || '-'}</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="7" class="muted">No overtime data.</td></tr>';
}

async function refreshAll() {
  await Promise.all([loadTanks(), loadCurrentWork(), loadTankSummary(), loadOvertime()]);
}

btnAddTank.addEventListener('click', () => void createTank());
tankSearch.addEventListener('input', () => void loadTanks());
if (tankStatusFilter) tankStatusFilter.addEventListener('change', () => void loadTanks());
tankBody.addEventListener('click', (e) => {
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
  if (act === 'archive') {
    const makeActive = btn.textContent.trim() === 'Restore';
    void archiveTank(id, makeActive);
  }
});

window.addEventListener('load', () => {
  void refreshAll();
  void refreshAuthUi();
  window.setInterval(() => void refreshAll(), 3500);
  window.setInterval(() => refreshCurrentWorkElapsedCells(), 1000);
});

if (areaFilter) areaFilter.addEventListener('change', () => void loadCurrentWork());

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
wirePinShow(showPinA, pinAreaA);
wirePinShow(showPinB, pinAreaB);
wirePinShow(showPinC, pinAreaC);
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
  const a = pinAreaA && String(pinAreaA.value || '').trim();
  const b = pinAreaB && String(pinAreaB.value || '').trim();
  const c = pinAreaC && String(pinAreaC.value || '').trim();
  if (a) body.area_a_pin = a;
  if (b) body.area_b_pin = b;
  if (c) body.area_c_pin = c;
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
  if (pinAreaA) pinAreaA.value = '';
  if (pinAreaB) pinAreaB.value = '';
  if (pinAreaC) pinAreaC.value = '';
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
