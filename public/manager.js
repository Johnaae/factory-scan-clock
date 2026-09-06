const tankNumber = document.getElementById('tankNumber');
const tankDescription = document.getElementById('tankDescription');
const tankCustomer = document.getElementById('tankCustomer');
const tankModel = document.getElementById('tankModel');
const tankPriority = document.getElementById('tankPriority');
const tankDueDate = document.getElementById('tankDueDate');
const tankNotes = document.getElementById('tankNotes');
const tankPieceCount = document.getElementById('tankPieceCount');
const tankSearch = document.getElementById('tankSearch');
const btnClearTankSearch = document.getElementById('btnClearTankSearch');
const tankStatusFilter = document.getElementById('tankStatusFilter');
const btnAddTank = document.getElementById('btnAddTank');
const tankHint = document.getElementById('tankHint');
const tankBody = document.getElementById('tankBody');
const btnPrintSelectedTanks = document.getElementById('btnPrintSelectedTanks');
const btnPrintAllTanks = document.getElementById('btnPrintAllTanks');
const btnSelectAllTanks = document.getElementById('btnSelectAllTanks');
const tankSelectAll = document.getElementById('tankSelectAll');
const dailySummaryDate = document.getElementById('dailySummaryDate');
const dailySummaryFilter = document.getElementById('dailySummaryFilter');
const dailySummaryBody = document.getElementById('dailySummaryBody');
const btnDailySummaryRefresh = document.getElementById('btnDailySummaryRefresh');
const btnDailySummaryCsv = document.getElementById('btnDailySummaryCsv');
const btnDailySummaryPrint = document.getElementById('btnDailySummaryPrint');
const productionNotesBody = document.getElementById('productionNotesBody');
const btnNotesRefresh = document.getElementById('btnNotesRefresh');
const tankEditBackdrop = document.getElementById('tankEditBackdrop');
const editTankId = document.getElementById('editTankId');
const editTankNumber = document.getElementById('editTankNumber');
const editTankStatus = document.getElementById('editTankStatus');
const editTankCustomer = document.getElementById('editTankCustomer');
const editTankModel = document.getElementById('editTankModel');
const editTankPriority = document.getElementById('editTankPriority');
const editTankDueDate = document.getElementById('editTankDueDate');
const editTankPieceCount = document.getElementById('editTankPieceCount');
const editTankDescription = document.getElementById('editTankDescription');
const editTankNotes = document.getElementById('editTankNotes');
const editTankHint = document.getElementById('editTankHint');
const btnSaveTankEdit = document.getElementById('btnSaveTankEdit');
const btnCancelTankEdit = document.getElementById('btnCancelTankEdit');
const btnCloseTankEdit = document.getElementById('btnCloseTankEdit');
const logoutBtn = document.getElementById('logoutBtn');
const btnSaveKioskPins = document.getElementById('btnSaveKioskPins');
const kioskPinHint = document.getElementById('kioskPinHint');
const kioskPinGrid = document.getElementById('kioskPinGrid');
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
const btnExportTankReportCsv = document.getElementById('btnExportTankReportCsv');
const btnExportTankReportXlsx = document.getElementById('btnExportTankReportXlsx');
const tankTableHead = document.getElementById('tankTableHead');
const tankTrashConfirmBackdrop = document.getElementById('tankTrashConfirmBackdrop');
const tankTrashConfirmTitle = document.getElementById('tankTrashConfirmTitle');
const tankTrashConfirmMessage = document.getElementById('tankTrashConfirmMessage');
const tankTrashHistoryWarning = document.getElementById('tankTrashHistoryWarning');
const tankTrashConfirmHint = document.getElementById('tankTrashConfirmHint');
const btnConfirmTankTrash = document.getElementById('btnConfirmTankTrash');
const btnCancelTankTrash = document.getElementById('btnCancelTankTrash');
const tankTrashRestoreBackdrop = document.getElementById('tankTrashRestoreBackdrop');
const tankTrashRestoreMessage = document.getElementById('tankTrashRestoreMessage');
const btnConfirmTankTrashRestore = document.getElementById('btnConfirmTankTrashRestore');
const btnCancelTankTrashRestore = document.getElementById('btnCancelTankTrashRestore');
const tankPermanentDeleteBackdrop = document.getElementById('tankPermanentDeleteBackdrop');
const tankPermanentDeleteMessage = document.getElementById('tankPermanentDeleteMessage');
const tankPermanentDeleteConfirmInput = document.getElementById('tankPermanentDeleteConfirmInput');
const tankPermanentDeleteHint = document.getElementById('tankPermanentDeleteHint');
const btnConfirmTankPermanentDelete = document.getElementById('btnConfirmTankPermanentDelete');
const btnCancelTankPermanentDelete = document.getElementById('btnCancelTankPermanentDelete');
let currentAuthUser = null;
let tanksFetchSeq = 0;
let tankActionInFlight = false;
let pendingTrashTank = null;
let pendingTrashRestoreTank = null;
let pendingPermanentDeleteTank = null;
let dailySummaryRows = [];
let dailySortKey = 'tank_number';
let dailySortDir = 1;
let currentTankReportId = null;

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
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_e) {
      data = { ok: false, error: 'non_json_response', message: text.trim().slice(0, 240), raw: text };
    }
  }
  return { res, data };
}

function apiErrorMessage(data, fallback) {
  if (data && data.message) return String(data.message);
  if (data && data.error === 'non_json_response') {
    return 'Server returned an unexpected response. Restart or redeploy the application server, then try again.';
  }
  return fallback;
}

function tankTableColSpan(filter) {
  return filter === 'trash' ? 8 : 10;
}

function renderTankTableMessage(filter, message) {
  if (!tankBody) return;
  tankBody.innerHTML = `<tr><td colspan="${tankTableColSpan(filter)}" class="muted">${escapeHtml(message)}</td></tr>`;
}

function tankIsActive(t) {
  const st = String((t && t.status) || 'active').toLowerCase();
  return st === 'active' || st === 'paused' || st === 'waiting' || st === '';
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
  const st = String((t && t.status) || '').toLowerCase();
  if (st === 'waiting') return 0;
  const startIso = t.first_scanned_at || t.started_at;
  if (!startIso) return 0;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return 0;
  let end = Date.now();
  if (!tankIsActive(t) && t.completed_at) {
    end = new Date(t.completed_at).getTime();
    if (Number.isNaN(end)) end = Date.now();
  }
  return Math.max(0, end - start);
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
  const st = String((t && t.status) || '').toLowerCase();
  if (st === 'waiting') {
    return '<span class="tank-lifecycle-in-progress">Waiting</span>';
  }
  if (tankIsActive(t)) {
    return '<span class="tank-lifecycle-in-progress">In Progress</span>';
  }
  const text = fmtTankDateTime(t.completed_at || t.updated_at) || fmtTankDateTime(new Date().toISOString());
  return `<span class="tank-lifecycle-muted">${escapeHtml(text)}</span>`;
}

function renderTankDurationBadge(t) {
  const st = String((t && t.status) || '').toLowerCase();
  const isActive = tankIsActive(t);
  const label = st === 'waiting' || !(t.first_scanned_at || t.started_at) ? '0m' : formatTankDurationClient(t);
  const cls =
    st === 'waiting'
      ? 'tank-duration-badge tank-duration-badge--waiting'
      : isActive
        ? 'tank-duration-badge tank-duration-badge--active'
        : 'tank-duration-badge tank-duration-badge--archived';
  const icon = st === 'waiting' ? '⚪' : isActive ? '🟢' : '🔵';
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

/** Tank Report durations: always "Xh Ym" (never show decimal hours). */
function fmtHours(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '0h 0m';
  const totalMin = Math.round(n * 60);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function fmtMsXhYm(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '0h 0m';
  const totalMin = Math.round(n / 60000);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

/** Prefer ms, then hours, then an existing display string. */
function fmtReportDuration(opts = {}) {
  if (opts.ms != null && Number.isFinite(Number(opts.ms))) return fmtMsXhYm(opts.ms);
  if (opts.hours != null && Number.isFinite(Number(opts.hours))) return fmtHours(opts.hours);
  if (opts.display != null && String(opts.display).trim() !== '' && String(opts.display) !== '—') {
    return String(opts.display);
  }
  return '—';
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

function tankStatusLabel(t) {
  const st = String((t && t.status) || 'active').toLowerCase();
  if (st === 'archived') return 'Completed';
  if (t && t.production_status === 'Ready to Complete') return 'Ready to Complete';
  if (st === 'waiting') return 'Waiting';
  if (st === 'paused') return 'In Progress — Paused';
  return 'In Progress';
}

function tankStatusBadge(t) {
  const st = String((t && t.status) || 'active').toLowerCase();
  if (st === 'archived') return '<span class="badge badge-muted">Completed</span>';
  if (t && t.production_status === 'Ready to Complete') {
    return '<span class="badge badge-warn">Ready to Complete</span>';
  }
  if (st === 'waiting') return '<span class="badge badge-warn">Waiting</span>';
  if (st === 'paused') return '<span class="badge badge-warn">Paused</span>';
  return '<span class="badge badge-in">Active</span>';
}

function getTankStatusFilter() {
  const raw = tankStatusFilter ? String(tankStatusFilter.value || '').toLowerCase() : 'active';
  if (raw === 'archived' || raw === 'all' || raw === 'waiting' || raw === 'trash') return raw;
  return 'active';
}

function updateTrashFilterLabel(count) {
  if (!tankStatusFilter) return;
  const trashOpt = Array.from(tankStatusFilter.options).find((o) => o.value === 'trash');
  if (trashOpt) trashOpt.textContent = count > 0 ? `Trash (${count})` : 'Trash';
}

function updateTankTableHead(filter) {
  if (!tankTableHead) return;
  if (filter === 'trash') {
    tankTableHead.innerHTML = `<tr>
      <th>Tank #</th><th>Customer</th><th>Model</th><th>Pieces</th><th>Previous Status</th><th>Deleted At</th><th>Deleted By</th><th>Actions</th>
    </tr>`;
    return;
  }
  tankTableHead.innerHTML = `<tr>
    <th><input type="checkbox" id="tankSelectAll" aria-label="Select all" /></th>
    <th>Tank #</th><th>Customer</th><th>Model</th><th>Pieces</th><th>Status</th><th>Created</th><th>Started</th><th>Duration</th><th>Actions</th>
  </tr>`;
  const selectAll = document.getElementById('tankSelectAll');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      const checked = selectAll.checked;
      document.querySelectorAll('.tank-select-cb').forEach((cb) => {
        cb.checked = checked;
      });
    });
  }
}

function previousStatusLabel(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'archived') return 'Completed';
  if (st === 'waiting') return 'Waiting';
  if (st === 'paused') return 'Paused';
  if (st === 'active') return 'Active';
  return status || '—';
}

function tankEmptyMessage(filter) {
  if (filter === 'archived') return 'No completed tanks';
  if (filter === 'waiting') return 'No waiting tanks';
  if (filter === 'trash') return 'No tanks in Trash';
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

function closeTankActionsMenu() {
  const openBtn = document.querySelector('.tank-actions-more-btn[aria-expanded="true"]');
  if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
  const menu = document.getElementById('tankActionsMenu');
  if (menu) {
    menu.classList.remove('is-open');
    menu.innerHTML = '';
    menu.hidden = true;
  }
}

function ensureTankActionsMenu() {
  let menu = document.getElementById('tankActionsMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'tankActionsMenu';
  menu.className = 'tank-actions-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);
  return menu;
}

function positionTankActionsMenu(anchorBtn) {
  const menu = ensureTankActionsMenu();
  const rect = anchorBtn.getBoundingClientRect();
  const menuWidth = Math.max(188, menu.offsetWidth || 188);
  const pad = 8;
  let left = rect.right - menuWidth;
  left = Math.max(pad, Math.min(left, window.innerWidth - menuWidth - pad));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.visibility = 'hidden';
  menu.hidden = false;
  menu.classList.add('is-open');
  const mh = menu.offsetHeight || 0;
  let top = rect.bottom + 4;
  if (top + mh > window.innerHeight - pad && rect.top - mh - 4 > pad) {
    top = rect.top - mh - 4;
  }
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = '';
}

function buildTankMoreMenuHtml(btn) {
  const kind = btn.getAttribute('data-menu-kind') || 'normal';
  const id = btn.getAttribute('data-id') || '';
  const tank = escapeHtml(btn.getAttribute('data-tank') || '');
  const status = escapeHtml(btn.getAttribute('data-status') || '');
  if (kind === 'trash') {
    return `<button type="button" role="menuitem" class="tank-actions-menu-item is-danger" data-act="permanent-delete" data-id="${id}" data-tank="${tank}">Delete Permanently</button>`;
  }
  const showComplete = btn.getAttribute('data-can-complete') === '1';
  const statusAction = showComplete
    ? `<button type="button" role="menuitem" class="tank-actions-menu-item is-success" data-act="archive" data-id="${id}">Complete Tank</button>`
    : `<button type="button" role="menuitem" class="tank-actions-menu-item" data-act="restore" data-id="${id}">Restore</button>`;
  return `
    <button type="button" role="menuitem" class="tank-actions-menu-item" data-act="edit-phase" data-id="${id}">Edit Phase Time</button>
    <button type="button" role="menuitem" class="tank-actions-menu-item" data-act="print" data-tank="${tank}">Print</button>
    ${statusAction}
    <button type="button" role="menuitem" class="tank-actions-menu-item is-danger" data-act="delete" data-id="${id}" data-tank="${tank}" data-status="${status}">Delete</button>
  `;
}

function openTankActionsMenu(anchorBtn) {
  const wasOpen = anchorBtn.getAttribute('aria-expanded') === 'true';
  closeTankActionsMenu();
  if (wasOpen) return;
  const menu = ensureTankActionsMenu();
  menu.innerHTML = buildTankMoreMenuHtml(anchorBtn);
  anchorBtn.setAttribute('aria-expanded', 'true');
  positionTankActionsMenu(anchorBtn);
}

function renderNormalTankActionsCell(t) {
  const canComplete = tankIsActive(t) && String(t.status).toLowerCase() !== 'archived' ? '1' : '0';
  return `<td class="tank-actions-cell">
    <div class="tank-actions">
      <button type="button" class="btn btn-sm btn-primary" data-act="report" data-id="${t.id}">View Report</button>
      <button type="button" class="btn btn-sm" data-act="edit" data-id="${t.id}">Edit</button>
      <button type="button" class="btn btn-sm tank-actions-more-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" data-tank-more="1" data-menu-kind="normal" data-id="${t.id}" data-tank="${escapeHtml(t.tank_number)}" data-status="${escapeHtml(t.status || '')}" data-can-complete="${canComplete}">⋮</button>
    </div>
  </td>`;
}

function renderTrashTankActionsCell(t) {
  return `<td class="tank-actions-cell">
    <div class="tank-actions">
      <button type="button" class="btn btn-sm btn-primary" data-act="report" data-id="${t.id}">View Report</button>
      <button type="button" class="btn btn-sm btn-success" data-act="trash-restore" data-id="${t.id}" data-tank="${escapeHtml(t.tank_number)}">Restore</button>
      <button type="button" class="btn btn-sm tank-actions-more-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" data-tank-more="1" data-menu-kind="trash" data-id="${t.id}" data-tank="${escapeHtml(t.tank_number)}">⋮</button>
    </div>
  </td>`;
}

function handleTankActionButton(btn) {
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (!act) return;
  closeTankActionsMenu();
  if (act === 'print') {
    const tank = btn.getAttribute('data-tank');
    if (tank) window.open(`/manager/tank-print?tank=${encodeURIComponent(tank)}`, '_blank', 'noopener,noreferrer');
    return;
  }
  const id = Number(btn.getAttribute('data-id'));
  if (!Number.isFinite(id)) return;
  if (act === 'edit') void editTank(id);
  if (act === 'report') void openTankReport(id);
  if (act === 'edit-phase') {
    if (window.PhaseTimeEditor) {
      window.PhaseTimeEditor.open(id, {
        onSaved: () => {
          if (currentTankReportId === id) void openTankReport(id);
        },
      });
    }
  }
  if (act === 'archive') void setTankStatus(id, 'archived');
  if (act === 'restore') void setTankStatus(id, 'active');
  if (act === 'delete') {
    openTankTrashConfirm({
      id,
      tank_number: btn.getAttribute('data-tank') || '',
      status: btn.getAttribute('data-status') || '',
    });
  }
  if (act === 'trash-restore') {
    openTankTrashRestore({ id, tank_number: btn.getAttribute('data-tank') || '' });
  }
  if (act === 'permanent-delete') {
    openTankPermanentDelete({ id, tank_number: btn.getAttribute('data-tank') || '' });
  }
}

function clearTankSearch() {
  if (tankSearch) tankSearch.value = '';
  void loadTanks();
}

async function loadTanks() {
  closeTankActionsMenu();
  const seq = ++tanksFetchSeq;
  const q = String(tankSearch && tankSearch.value ? tankSearch.value : '').trim();
  const statusFilter = getTankStatusFilter();
  updateTankTableHead(statusFilter);
  renderTankTableMessage(statusFilter, 'Loading…');
  const query = new URLSearchParams({ status: statusFilter });
  if (q) query.set('search', q);
  const { res, data } = await apiJson(`/api/tanks?${query.toString()}`);
  // Ignore stale responses from a previous filter/search request.
  if (seq !== tanksFetchSeq) return;
  if (getTankStatusFilter() !== statusFilter) return;
  if (!res.ok) {
    const msg = apiErrorMessage(data, 'Could not load tanks.');
    renderTankTableMessage(statusFilter, msg);
    if (tankHint) tankHint.textContent = msg;
    return;
  }
  if (tankHint && String(tankHint.textContent || '').startsWith('Could not load tanks')) {
    tankHint.textContent = '';
  }
  updateTrashFilterLabel(Number(data.trash_count) || 0);
  const rows = Array.isArray(data.tanks) ? data.tanks : [];
  if (!rows.length) {
    renderTankTableMessage(statusFilter, tankEmptyMessage(statusFilter));
    return;
  }
  if (statusFilter === 'trash') {
    tankBody.innerHTML = rows
      .map((t) => {
        const pcs = `${Number(t.current_piece_number) || 1}/${Number(t.piece_count) || 1}`;
        const deletedAt = t.deleted_at
          ? `<span class="tank-lifecycle-muted">${escapeHtml(fmtTankDateTime(t.deleted_at))}</span>`
          : '—';
        return `<tr>
      <td><strong>${escapeHtml(t.tank_number)}</strong></td>
      <td>${escapeHtml(t.customer || '—')}</td>
      <td>${escapeHtml(t.model || '—')}</td>
      <td>${escapeHtml(pcs)}</td>
      <td>${escapeHtml(previousStatusLabel(t.previous_status || t.status))}</td>
      <td>${deletedAt}</td>
      <td>${escapeHtml(t.deleted_by || '—')}</td>
      ${renderTrashTankActionsCell(t)}
    </tr>`;
      })
      .join('');
    return;
  }
  tankBody.innerHTML = rows
    .map((t) => {
      const started = t.first_scanned_at || t.started_at
        ? `<span class="tank-lifecycle-muted">${escapeHtml(fmtTankDateTime(t.first_scanned_at || t.started_at))}</span>`
        : '<span class="tank-lifecycle-muted">—</span>';
      const pcs = `${Number(t.current_piece_number) || 1}/${Number(t.piece_count) || 1}`;
      return `<tr>
      <td><input type="checkbox" class="tank-select-cb" value="${t.id}" /></td>
      <td><strong>${escapeHtml(t.tank_number)}</strong></td>
      <td>${escapeHtml(t.customer || '—')}</td>
      <td>${escapeHtml(t.model || '—')}</td>
      <td>${escapeHtml(pcs)}</td>
      <td>${tankStatusBadge(t)}</td>
      <td>${renderTankCreatedCell(t)}</td>
      <td>${started}</td>
      <td>${renderTankDurationBadge(t)}</td>
      ${renderNormalTankActionsCell(t)}
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
  const payload = {
    tank_number: number,
    description,
    customer: tankCustomer ? tankCustomer.value.trim() : '',
    model: tankModel ? tankModel.value.trim() : '',
    priority: tankPriority ? tankPriority.value : '',
    due_date: tankDueDate && tankDueDate.value ? tankDueDate.value : null,
    notes: tankNotes ? tankNotes.value.trim() : '',
    piece_count: tankPieceCount ? Number(tankPieceCount.value) || 1 : 1,
  };
  const { res, data } = await apiJson('/api/tanks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    if (data && data.error === 'tank_in_trash') {
      tankHint.textContent = data.message || 'Tank number exists in Trash.';
    } else {
      tankHint.textContent = (data && data.message) || 'Could not create tank.';
    }
    return;
  }
  tankNumber.value = '';
  if (tankDescription) tankDescription.value = '';
  if (tankCustomer) tankCustomer.value = '';
  if (tankModel) tankModel.value = '';
  if (tankNotes) tankNotes.value = '';
  if (tankDueDate) tankDueDate.value = '';
  if (tankPieceCount) tankPieceCount.value = '1';
  tankHint.textContent = `Tank ${number} created (Waiting — timer starts on first scan).`;
  await loadTanks();
}

function closeTankEdit() {
  if (!tankEditBackdrop) return;
  tankEditBackdrop.classList.remove('show');
  tankEditBackdrop.setAttribute('aria-hidden', 'true');
}

async function editTank(id) {
  const one = await apiJson(`/api/tanks/${id}/report`);
  let tank = one.res.ok && one.data && one.data.tank ? one.data.tank : null;
  const hasActivity = Boolean(one.res.ok && one.data && one.data.has_production_activity);
  const minPieces = Math.max(1, Number(one.data && one.data.max_piece_with_activity) || 1);
  if (!tank) {
    const { res, data } = await apiJson(`/api/tanks?status=all`);
    if (res.ok) tank = (data.tanks || []).find((t) => Number(t.id) === Number(id));
  }
  if (!tank) {
    tankHint.textContent = 'Tank not found.';
    return;
  }
  if (editTankId) editTankId.value = String(tank.id);
  if (editTankNumber) editTankNumber.value = tank.tank_number || '';
  if (editTankStatus) editTankStatus.value = tank.status || 'waiting';
  if (editTankCustomer) editTankCustomer.value = tank.customer || '';
  if (editTankModel) editTankModel.value = tank.model || '';
  if (editTankPriority) editTankPriority.value = tank.priority || '';
  if (editTankDueDate) editTankDueDate.value = tank.due_date ? String(tank.due_date).slice(0, 10) : '';
  if (editTankPieceCount) {
    editTankPieceCount.value = String(tank.piece_count || 1);
    Array.from(editTankPieceCount.options).forEach((opt) => {
      const n = Number(opt.value);
      opt.disabled = hasActivity && n < minPieces;
    });
  }
  const pieceHint = document.getElementById('editTankPieceCountHint');
  if (pieceHint) {
    pieceHint.textContent = hasActivity
      ? `Production has started. You can increase pieces, but cannot reduce below ${minPieces}.`
      : 'You can change the piece count until production begins.';
  }
  if (editTankDescription) editTankDescription.value = tank.description || '';
  if (editTankNotes) editTankNotes.value = tank.notes || '';
  if (editTankHint) editTankHint.textContent = '';
  if (tankEditBackdrop) {
    tankEditBackdrop.classList.add('show');
    tankEditBackdrop.setAttribute('aria-hidden', 'false');
  }
}

async function saveTankEdit() {
  const id = Number(editTankId && editTankId.value);
  if (!Number.isInteger(id) || id <= 0) return;
  const payload = {
    tank_number: editTankNumber ? editTankNumber.value : '',
    status: editTankStatus ? editTankStatus.value : undefined,
    customer: editTankCustomer ? editTankCustomer.value : '',
    model: editTankModel ? editTankModel.value : '',
    priority: editTankPriority ? editTankPriority.value : '',
    due_date: editTankDueDate && editTankDueDate.value ? editTankDueDate.value : null,
    piece_count: editTankPieceCount ? Number(editTankPieceCount.value) || 1 : 1,
    description: editTankDescription ? editTankDescription.value : '',
    notes: editTankNotes ? editTankNotes.value : '',
  };
  const { res, data } = await apiJson(`/api/tanks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    if (editTankHint) editTankHint.textContent = (data && data.message) || 'Update failed.';
    return;
  }
  closeTankEdit();
  tankHint.textContent = 'Tank updated.';
  await loadTanks();
}

function selectedTankIds() {
  return Array.from(document.querySelectorAll('.tank-select-cb:checked')).map((el) => Number(el.value)).filter(Boolean);
}

function printSelectedTanks() {
  const ids = selectedTankIds();
  if (!ids.length) {
    tankHint.textContent = 'Select one or more tanks to print.';
    return;
  }
  window.open(`/api/manager/tanks/print-selected?ids=${ids.join(',')}`, '_blank', 'noopener,noreferrer');
}

function printAllTanks() {
  window.open('/api/manager/tanks/print-selected?all=1', '_blank', 'noopener,noreferrer');
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

function closeTankTrashConfirm() {
  pendingTrashTank = null;
  if (tankTrashConfirmHint) tankTrashConfirmHint.textContent = '';
  if (!tankTrashConfirmBackdrop) return;
  tankTrashConfirmBackdrop.classList.remove('show');
  tankTrashConfirmBackdrop.setAttribute('aria-hidden', 'true');
}

function openTankTrashConfirm(tank) {
  pendingTrashTank = tank;
  if (tankTrashConfirmHint) tankTrashConfirmHint.textContent = '';
  if (tankTrashConfirmTitle) tankTrashConfirmTitle.textContent = `Move Tank ${tank.tank_number} to Trash?`;
  if (tankTrashConfirmMessage) {
    tankTrashConfirmMessage.textContent =
      'The tank will be removed from normal Tank Management views but can still be restored from Trash.';
  }
  const hasHistory =
    String(tank.status || '').toLowerCase() === 'archived' ||
    Boolean(tank.first_scanned_at || tank.started_at);
  if (tankTrashHistoryWarning) tankTrashHistoryWarning.hidden = !hasHistory;
  if (tankTrashConfirmBackdrop) {
    tankTrashConfirmBackdrop.classList.add('show');
    tankTrashConfirmBackdrop.setAttribute('aria-hidden', 'false');
  }
}

async function confirmMoveTankToTrash() {
  if (!pendingTrashTank || tankActionInFlight) return;
  tankActionInFlight = true;
  if (btnConfirmTankTrash) btnConfirmTankTrash.disabled = true;
  if (tankTrashConfirmHint) tankTrashConfirmHint.textContent = '';
  const id = Number(pendingTrashTank.id);
  const tankNumber = pendingTrashTank.tank_number;
  const { res, data } = await apiJson(`/api/tanks/${id}/trash`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  tankActionInFlight = false;
  if (btnConfirmTankTrash) btnConfirmTankTrash.disabled = false;
  if (!res.ok) {
    const msg = apiErrorMessage(data, 'Could not move tank to Trash.');
    if (tankTrashConfirmHint) tankTrashConfirmHint.textContent = msg;
    if (tankHint) tankHint.textContent = msg;
    return;
  }
  closeTankTrashConfirm();
  if (tankHint) tankHint.textContent = `Tank ${tankNumber} moved to Trash.`;
  pendingTrashTank = null;
  await loadTanks();
}

function closeTankTrashRestore() {
  pendingTrashRestoreTank = null;
  if (!tankTrashRestoreBackdrop) return;
  tankTrashRestoreBackdrop.classList.remove('show');
  tankTrashRestoreBackdrop.setAttribute('aria-hidden', 'true');
}

function openTankTrashRestore(tank) {
  pendingTrashRestoreTank = tank;
  if (tankTrashRestoreMessage) {
    tankTrashRestoreMessage.textContent = `Restore Tank ${tank.tank_number}?`;
  }
  if (tankTrashRestoreBackdrop) {
    tankTrashRestoreBackdrop.classList.add('show');
    tankTrashRestoreBackdrop.setAttribute('aria-hidden', 'false');
  }
}

async function confirmRestoreTankFromTrash() {
  if (!pendingTrashRestoreTank || tankActionInFlight) return;
  tankActionInFlight = true;
  const id = Number(pendingTrashRestoreTank.id);
  const tankNumber = pendingTrashRestoreTank.tank_number;
  const { res, data } = await apiJson(`/api/tanks/${id}/trash-restore`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  tankActionInFlight = false;
  if (!res.ok) {
    if (tankHint) tankHint.textContent = apiErrorMessage(data, 'Could not restore tank.');
    return;
  }
  closeTankTrashRestore();
  if (tankHint) tankHint.textContent = `Tank ${tankNumber} restored.`;
  pendingTrashRestoreTank = null;
  await loadTanks();
}

function closeTankPermanentDelete() {
  pendingPermanentDeleteTank = null;
  if (tankPermanentDeleteConfirmInput) tankPermanentDeleteConfirmInput.value = '';
  if (tankPermanentDeleteHint) tankPermanentDeleteHint.textContent = '';
  if (btnConfirmTankPermanentDelete) btnConfirmTankPermanentDelete.disabled = true;
  if (!tankPermanentDeleteBackdrop) return;
  tankPermanentDeleteBackdrop.classList.remove('show');
  tankPermanentDeleteBackdrop.setAttribute('aria-hidden', 'true');
}

function openTankPermanentDelete(tank) {
  pendingPermanentDeleteTank = tank;
  if (tankPermanentDeleteMessage) {
    tankPermanentDeleteMessage.textContent = `PERMANENTLY DELETE TANK ${tank.tank_number}?\n\nThis will permanently remove this tank and all related production history.\n\nThis action cannot be undone.`;
  }
  if (tankPermanentDeleteConfirmInput) {
    tankPermanentDeleteConfirmInput.value = '';
    tankPermanentDeleteConfirmInput.placeholder = tank.tank_number;
  }
  if (btnConfirmTankPermanentDelete) btnConfirmTankPermanentDelete.disabled = true;
  if (tankPermanentDeleteBackdrop) {
    tankPermanentDeleteBackdrop.classList.add('show');
    tankPermanentDeleteBackdrop.setAttribute('aria-hidden', 'false');
    if (tankPermanentDeleteConfirmInput) tankPermanentDeleteConfirmInput.focus();
  }
}

function syncPermanentDeleteButton() {
  if (!btnConfirmTankPermanentDelete || !pendingPermanentDeleteTank || !tankPermanentDeleteConfirmInput) return;
  const typed = String(tankPermanentDeleteConfirmInput.value || '').trim().toUpperCase();
  const expected = String(pendingPermanentDeleteTank.tank_number || '').trim().toUpperCase();
  btnConfirmTankPermanentDelete.disabled = typed !== expected;
}

async function confirmPermanentDeleteTank() {
  if (!pendingPermanentDeleteTank || tankActionInFlight) return;
  const typed = String(tankPermanentDeleteConfirmInput && tankPermanentDeleteConfirmInput.value
    ? tankPermanentDeleteConfirmInput.value
    : '').trim();
  const id = Number(pendingPermanentDeleteTank.id);
  tankActionInFlight = true;
  const { res, data } = await apiJson(`/api/tanks/${id}/permanent`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_tank_number: typed }),
  });
  tankActionInFlight = false;
  if (!res.ok) {
    if (tankPermanentDeleteHint) {
      tankPermanentDeleteHint.textContent = (data && data.message) || 'Permanent delete failed.';
    }
    return;
  }
  const tankNumber = pendingPermanentDeleteTank.tank_number;
  closeTankPermanentDelete();
  tankHint.textContent = `Tank ${tankNumber} permanently deleted.`;
  await loadTanks();
}

function closeTankReport() {
  currentTankReportId = null;
  if (!tankReportBackdrop) return;
  tankReportBackdrop.classList.remove('show');
  tankReportBackdrop.setAttribute('aria-hidden', 'true');
  if (tankReportBody) tankReportBody.innerHTML = '';
}

function renderTankReport(data) {
  const tank = data.tank || {};
  const meta = data.report_meta || {};
  const laborHours = data.labor_hours || {};
  const teamCompletion = data.team_completion || {};
  const teamProduction = data.team_production || null;
  const totalLaborHours =
    laborHours.total_labor_hours != null
      ? laborHours.total_labor_hours
      : teamProduction && teamProduction.total_hours != null
        ? teamProduction.total_hours
        : teamCompletion.total_team_hours || 0;
  const totalRunningHours =
    laborHours.total_machine_hours != null
      ? laborHours.total_machine_hours
      : teamProduction && teamProduction.total_machine_hours != null
        ? teamProduction.total_machine_hours
        : totalLaborHours;

  const statusText = meta.production_status || tankStatusLabel(tank);
  const isActive = tankIsActive(tank);
  const pct = meta.percent_complete != null ? Math.max(0, Math.min(100, Number(meta.percent_complete) || 0)) : null;
  const pieces = data.pieces || [];
  const notes = data.production_notes || [];
  const generalNotes = notes.filter((n) => String(n.note_type || '').toLowerCase() !== 'correction');
  const corrections = notes.filter((n) => String(n.note_type || '').toLowerCase() === 'correction');
  const downtimeRows = data.downtime_intervals || [];
  const qaQcRows = data.qa_qc_history || [];
  const phaseTimeSummary =
    (teamProduction && teamProduction.phase_time_summary) || data.phase_time_summary || [];

  const overviewSection = `
    <section class="tank-report-section tank-report-page" data-report-page="1">
      <div class="tank-report-page-label">Section 1 · Overview</div>
      <div class="toolbar" style="margin-bottom:12px">
        <button type="button" class="btn btn-sm btn-primary" id="btnTankReportEditPhase" data-tank-id="${Number(tank.id)}">Edit Phase Time</button>
      </div>
      <h4 class="tank-report-section-title">Tank Information</h4>
      <div class="tank-lifecycle-grid">
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Tank #</div>
          <div class="tank-lifecycle-value">#${escapeHtml(tank.tank_number)}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Team</div>
          <div class="tank-lifecycle-value">${escapeHtml(meta.team_name || teamCompletion.team_name || '—')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Machine</div>
          <div class="tank-lifecycle-value">${escapeHtml(meta.machine_name || '—')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Status</div>
          <div class="tank-lifecycle-value"><span class="badge ${isActive ? 'badge-in' : 'badge-muted'}">${escapeHtml(statusText)}</span></div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Progress</div>
          <div class="tank-lifecycle-value">${
            pct == null
              ? '—'
              : `<div class="progress-bar" style="min-width:88px;background:#e2e8f0;border-radius:6px;overflow:hidden;height:10px;display:inline-block;vertical-align:middle;margin-right:8px">
                   <div style="width:${pct}%;height:100%;background:#2563eb"></div>
                 </div><span>${pct}%</span>`
          }</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Total Running Time</div>
          <div class="tank-lifecycle-value">${escapeHtml(
            fmtReportDuration({
              ms:
                (teamProduction && teamProduction.total_running_ms) != null
                  ? teamProduction.total_running_ms
                  : laborHours.total_running_ms,
              hours: totalRunningHours,
              display:
                (teamProduction && teamProduction.total_running_display) ||
                laborHours.total_running_display,
            })
          )}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Total Labor Hours</div>
          <div class="tank-lifecycle-value">${escapeHtml(
            fmtReportDuration({
              ms:
                (teamProduction && teamProduction.total_labor_ms) != null
                  ? teamProduction.total_labor_ms
                  : laborHours.total_labor_ms,
              hours: totalLaborHours,
              display:
                (teamProduction && teamProduction.total_labor_display) ||
                laborHours.total_labor_display,
            })
          )}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Configured Pieces</div>
          <div class="tank-lifecycle-value">${Number(tank.piece_count) || (data.pieces || []).length || 1}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Completed Pieces</div>
          <div class="tank-lifecycle-value">${
            meta.completed_pieces != null
              ? `${meta.completed_pieces}/${meta.piece_count != null ? meta.piece_count : Number(tank.piece_count) || 1}`
              : '—'
          }</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Current Phase</div>
          <div class="tank-lifecycle-value">${escapeHtml(meta.current_phase || '—')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Piece</div>
          <div class="tank-lifecycle-value">${escapeHtml(meta.piece_label || `Piece ${tank.current_piece_number || 1}`)}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Started</div>
          <div class="tank-lifecycle-value">${
            tank.first_scanned_at || tank.started_at || meta.started_at
              ? escapeHtml(fmtTankDateTime(tank.first_scanned_at || tank.started_at || meta.started_at))
              : '—'
          }</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Customer / Model</div>
          <div class="tank-lifecycle-value">${escapeHtml(tank.customer || '—')} / ${escapeHtml(tank.model || '—')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Downtime Total</div>
          <div class="tank-lifecycle-value">${escapeHtml(data.downtime_total_display || meta.downtime_display || '00:00')}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Completed</div>
          <div class="tank-lifecycle-value">${renderTankCompletedCell(tank)}</div>
        </div>
        <div class="tank-lifecycle-item">
          <div class="tank-lifecycle-label">Duration</div>
          <div class="tank-lifecycle-value">${escapeHtml(
            fmtReportDuration({
              ms: computeTankDurationMsClient(tank),
              display: tank.duration_display,
            })
          )}</div>
        </div>
        <div class="tank-lifecycle-item tank-lifecycle-item--wide">
          <div class="tank-lifecycle-label">Description</div>
          <div class="tank-lifecycle-value">${escapeHtml(tank.description || 'No description')}</div>
        </div>
      </div>
      ${
        ((teamProduction && teamProduction.member_breakdown) || []).length
          ? `<h5 class="tank-report-subsection-title" style="margin-top:16px">Labor breakdown (membership history)</h5>
             <div class="table-wrap">
               <table class="tank-report-table">
                 <thead><tr><th>Employee</th><th>Team(s)</th><th>Time on tank</th></tr></thead>
                 <tbody>${(teamProduction.member_breakdown || [])
                   .map(
                     (m) => `<tr>
                       <td>${escapeHtml(m.employee_name || '—')}</td>
                       <td>${escapeHtml(m.team_name || '—')}</td>
                       <td>${escapeHtml(
                         fmtReportDuration({
                           ms: m.total_ms,
                           hours: m.total_hours,
                           display: m.total_hours_display,
                         })
                       )}</td>
                     </tr>`
                   )
                   .join('')}</tbody>
               </table>
             </div>
             <p class="muted">Total Labor Hours is the sum of employee contributions — not the same as Total Running Time.</p>`
          : ''
      }
    </section>`;

  const phaseSummaryRows = phaseTimeSummary.length
    ? phaseTimeSummary
        .map(
          (row) => `<tr>
            <td>${escapeHtml(row.phase_name || row.phase_code || '—')}</td>
            <td>${escapeHtml(row.status_label || row.status || '—')}</td>
            <td>${escapeHtml(
              fmtReportDuration({
                ms: row.total_duration_ms,
                hours: row.total_duration_hours,
                display: row.total_duration_display,
              })
            )}</td>
            <td>${escapeHtml(row.summary_line || '—')}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No phase activity recorded.</td></tr>';

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
            <td>${escapeHtml(s.phase_name || phase.phase_name || '—')}</td>
            <td>${s.piece_number != null ? `Piece ${Number(s.piece_number)}` : '—'}</td>
            <td>${escapeHtml(s.team_name || '—')}</td>
            <td>${escapeHtml(s.machine_name || '—')}</td>
            <td>${fmtIso(s.started_at)}</td>
            <td>${endLabel === 'In progress' ? 'In progress' : escapeHtml(endLabel)}</td>
            <td>${escapeHtml(
              fmtReportDuration({
                display: s.duration_display,
                hours: s.duration_hours,
              })
            )}${
                  s.is_edited
                    ? ` <span class="badge badge-warn" title="${escapeHtml(s.latest_edit_reason || '')}">Edited</span>`
                    : ''
                }</td>
            <td><span class="badge ${s.status === 'running' ? 'badge-in' : s.status === 'stopped' ? 'badge-warn' : 'badge-muted'}">${escapeHtml(s.status_label || (s.status === 'running' ? 'Running' : s.status === 'stopped' ? 'Paused' : 'Completed'))}</span></td>
            <td class="tank-report-actions">${
              s.id
                ? `<button type="button" class="btn btn-sm btn-session-details" data-session-id="${Number(s.id)}">Details</button>`
                : '—'
            }</td>
          </tr>`;
              })
              .join('');
            return `<div class="tank-phase-group">
          <h5 class="tank-report-subsection-title">${escapeHtml(phase.phase_name || phase.phase_code || 'Phase')} · ${escapeHtml(
            fmtReportDuration({
              ms: phase.phase_total_duration_ms,
              hours: phase.phase_total_hours,
              display: phase.phase_total_display,
            })
          )}</h5>
          <div class="table-wrap">
            <table class="tank-report-table">
              <thead><tr><th>Phase</th><th>Piece</th><th>Team</th><th>Machine</th><th>Start</th><th>End</th><th>Duration</th><th>Status</th><th></th></tr></thead>
              <tbody>${sessionRows || '<tr><td colspan="9" class="muted">No sessions.</td></tr>'}</tbody>
            </table>
          </div>
        </div>`;
          })
          .join('')
      : '';

  const phaseSection = `
    <section class="tank-report-section tank-report-page" data-report-page="2">
      <div class="tank-report-page-label">Section 2 · Phase Summary</div>
      <h4 class="tank-report-section-title">Complete Phase Summary</h4>
      <div class="table-wrap">
        <table class="tank-report-table">
          <thead><tr><th>Phase</th><th>Status</th><th>Time</th><th>Summary</th></tr></thead>
          <tbody>${phaseSummaryRows}</tbody>
        </table>
      </div>
      ${phaseBlocks}
    </section>`;

  const notesTable = (rows, emptyText) =>
    rows.length
      ? rows
          .map(
            (n) => `<tr>
            <td>${fmtIso(n.created_at)}</td>
            <td>${escapeHtml(n.note_type || '—')}</td>
            <td>${n.piece_number != null ? Number(n.piece_number) : '—'}</td>
            <td>${escapeHtml(n.team_name || '—')}</td>
            <td>${escapeHtml(n.body || '—')}</td>
          </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="muted">${escapeHtml(emptyText)}</td></tr>`;

  const detailSection = `
    <section class="tank-report-section tank-report-page" data-report-page="3">
      <div class="tank-report-page-label">Section 3 · Detail History</div>
      <h4 class="tank-report-section-title">Piece History</h4>
      ${
        (data.piece_reports || []).length
          ? `<div class="piece-history-accordion" id="pieceHistoryAccordion">
              ${(data.piece_reports || [])
                .map((pr) => {
                  const statusLabel = String(pr.status || 'pending')
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                  const hasActivity = (pr.phase_time_summary || []).some(
                    (row) =>
                      String(row.status || '') !== 'not_started' ||
                      (Number(row.total_duration_ms) || 0) > 0
                  );
                  const phaseRows = (pr.phase_time_summary || [])
                    .map(
                      (row) => `<tr>
                      <td>${escapeHtml(row.phase_name || row.phase_code || '—')}</td>
                      <td>${escapeHtml(row.status_label || row.status || '—')}</td>
                      <td>${escapeHtml(
                        fmtReportDuration({
                          ms: row.total_duration_ms,
                          hours: row.total_duration_hours,
                          display: row.total_duration_display,
                        })
                      )}</td>
                    </tr>`
                    )
                    .join('');
                  return `<details class="piece-history-item${hasActivity ? ' has-activity' : ''}" data-piece="${Number(
                    pr.piece_number
                  )}">
                    <summary class="piece-history-summary">
                      <span class="piece-history-chevron" aria-hidden="true"></span>
                      <span class="piece-history-title">Piece ${Number(pr.piece_number)} — ${escapeHtml(
                    statusLabel
                  )} — ${escapeHtml(
                    fmtReportDuration({
                      ms: pr.total_duration_ms,
                      hours: pr.total_duration_hours,
                      display: pr.total_duration_display || '0h 0m',
                    })
                  )}</span>
                    </summary>
                    <div class="piece-history-body">
                      <div class="table-wrap">
                        <table class="tank-report-table">
                          <thead><tr><th>Phase</th><th>Status</th><th>Time</th></tr></thead>
                          <tbody>${phaseRows || '<tr><td colspan="3" class="muted">No phase activity.</td></tr>'}</tbody>
                        </table>
                      </div>
                    </div>
                  </details>`;
                })
                .join('')}
            </div>`
          : `<div class="table-wrap">
        <table class="tank-report-table">
          <thead><tr><th>Piece #</th><th>Status</th><th>Started</th><th>Completed</th><th>Operator</th></tr></thead>
          <tbody>${
            pieces.length
              ? pieces
                  .map(
                    (p) => `<tr>
            <td>${Number(p.piece_number)}</td>
            <td>${escapeHtml(p.status || '—')}</td>
            <td>${p.started_at ? fmtIso(p.started_at) : '—'}</td>
            <td>${p.completed_at ? fmtIso(p.completed_at) : '—'}</td>
            <td>${escapeHtml(p.operator_name || '—')}</td>
          </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5" class="muted">No piece tracking records.</td></tr>'
          }</tbody>
        </table>
      </div>`
      }

      <h4 class="tank-report-section-title" style="margin-top:18px">Notes</h4>
      <div class="table-wrap">
        <table class="tank-report-table">
          <thead><tr><th>When</th><th>Type</th><th>Piece</th><th>Team</th><th>Note</th></tr></thead>
          <tbody>${notesTable(generalNotes, 'No notes recorded.')}</tbody>
        </table>
      </div>

      <h4 class="tank-report-section-title" style="margin-top:18px">Corrections</h4>
      <div class="table-wrap">
        <table class="tank-report-table">
          <thead><tr><th>When</th><th>Type</th><th>Piece</th><th>Team</th><th>Note</th></tr></thead>
          <tbody>${notesTable(corrections, 'No corrections recorded.')}</tbody>
        </table>
      </div>

      <h4 class="tank-report-section-title" style="margin-top:18px">Downtime History</h4>
      <p class="muted">Total downtime: <strong>${escapeHtml(data.downtime_total_display || '00:00')}</strong> (excluded from productive phase hours)</p>
      <div class="table-wrap">
        <table class="tank-report-table">
          <thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Reason</th><th>Note</th><th>Phase</th></tr></thead>
          <tbody>${
            downtimeRows.length
              ? downtimeRows
                  .map(
                    (d) => `<tr>
            <td>${d.started_at ? fmtIso(d.started_at) : '—'}</td>
            <td>${d.ended_at ? fmtIso(d.ended_at) : d.open ? 'Open' : '—'}</td>
            <td>${escapeHtml(d.duration_display || '—')}</td>
            <td>${escapeHtml(d.reason_label || d.reason_code || '—')}</td>
            <td>${escapeHtml(d.reason_note || '—')}</td>
            <td>${escapeHtml(d.phase_name || '—')}</td>
          </tr>`
                  )
                  .join('')
              : '<tr><td colspan="6" class="muted">No downtime recorded.</td></tr>'
          }</tbody>
        </table>
      </div>

      <h4 class="tank-report-section-title" style="margin-top:18px">QA/QC History</h4>
      <p class="muted">QA/QC duration is tracked separately and excluded from productive phase time.</p>
      <div class="table-wrap">
        <table class="tank-report-table">
          <thead>
            <tr>
              <th>Piece</th>
              <th>Phase</th>
              <th>Opened At</th>
              <th>Resolved At</th>
              <th>Duration</th>
              <th>Team</th>
              <th>Machine</th>
              <th>Issue Note</th>
              <th>Resolution Note</th>
              <th>Resolved By</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${
            qaQcRows.length
              ? qaQcRows
                  .map(
                    (q) => `<tr>
            <td>${q.piece_number != null ? `Piece ${Number(q.piece_number)}` : '—'}</td>
            <td>${escapeHtml(q.phase_name || q.phase_code || '—')}</td>
            <td>${q.reported_at ? fmtIso(q.reported_at) : '—'}</td>
            <td>${q.resolved_at ? fmtIso(q.resolved_at) : q.status === 'open' ? 'Open' : '—'}</td>
            <td>${escapeHtml(q.duration_display || '—')}</td>
            <td>${escapeHtml(q.team_name || '—')}</td>
            <td>${escapeHtml(q.machine_name || '—')}</td>
            <td>${escapeHtml(q.issue_note || q.notes || '—')}</td>
            <td>${escapeHtml(q.resolution_note || '—')}</td>
            <td>${escapeHtml(q.resolved_by || '—')}</td>
            <td><span class="badge ${q.status === 'open' ? 'badge-warn' : 'badge-muted'}">${
              q.status === 'open' ? 'Open' : 'Resolved'
            }</span></td>
          </tr>`
                  )
                  .join('')
              : '<tr><td colspan="11" class="muted">No QA/QC issues recorded.</td></tr>'
          }</tbody>
        </table>
      </div>
    </section>`;

  return `
    <div id="tankReportPrintArea" class="tank-report-print-area">
      ${overviewSection}
      ${phaseSection}
      ${detailSection}
    </div>`;
}

async function openTankReport(id) {
  if (!tankReportBackdrop || !tankReportBody) return;
  currentTankReportId = Number(id) || null;
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
  const openEditor = (opts) => {
    if (!window.PhaseTimeEditor) return;
    window.PhaseTimeEditor.open(opts.tankId, {
      pieceNumber: opts.pieceNumber,
      phaseCode: opts.phaseCode,
      sessionId: opts.sessionId,
      onSaved: () => {
        if (currentTankReportId) void openTankReport(currentTankReportId);
      },
    });
  };
  const editPhaseBtn = tankReportBody.querySelector('#btnTankReportEditPhase');
  if (editPhaseBtn) {
    editPhaseBtn.addEventListener('click', () => {
      openEditor({ tankId: Number(editPhaseBtn.getAttribute('data-tank-id')) });
    });
  }
}

function expandPieceHistoryForPrint() {
  if (!tankReportBody) return;
  tankReportBody.querySelectorAll('.piece-history-item.has-activity').forEach((el) => {
    el.setAttribute('open', '');
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', expandPieceHistoryForPrint);
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
  await loadDailySummary();
  await loadProductionNotes();
}

function todayLocalDateInput() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderDailySummaryTable() {
  if (!dailySummaryBody) return;
  const filter = String(dailySummaryFilter && dailySummaryFilter.value ? dailySummaryFilter.value : '')
    .trim()
    .toLowerCase();
  let rows = dailySummaryRows.slice();
  if (filter) {
    rows = rows.filter((r) =>
      [r.tank_number, r.team_name, r.machine_name, r.current_phase, r.production_status, r.status]
        .join(' ')
        .toLowerCase()
        .includes(filter)
    );
  }
  rows.sort((a, b) => {
    const av = a[dailySortKey];
    const bv = b[dailySortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dailySortDir;
    if (typeof av === 'boolean' && typeof bv === 'boolean') return ((av ? 1 : 0) - (bv ? 1 : 0)) * dailySortDir;
    return String(av).localeCompare(String(bv)) * dailySortDir;
  });
  if (!rows.length) {
    dailySummaryBody.innerHTML = '<tr><td colspan="10" class="muted">No tanks worked on this day.</td></tr>';
    return;
  }
  dailySummaryBody.innerHTML = rows
    .map((r) => {
      const pct = Math.max(0, Math.min(100, Number(r.percent_complete) || 0));
      const id = Number(r.tank_id);
      return `<tr>
        <td><strong>${escapeHtml(r.tank_number)}</strong></td>
        <td>${escapeHtml(r.team_name || '—')}</td>
        <td>${escapeHtml(r.machine_name || '—')}</td>
        <td>${escapeHtml(r.current_phase || '—')}</td>
        <td>${escapeHtml(r.production_status || r.status || '—')}</td>
        <td>${escapeHtml(r.current_phase_time_display || '00:00')}</td>
        <td>${escapeHtml(r.tank_total_running_time_display || '—')}</td>
        <td>
          <div class="progress-bar" style="min-width:72px;background:#e2e8f0;border-radius:6px;overflow:hidden;height:10px">
            <div style="width:${pct}%;height:100%;background:#2563eb"></div>
          </div>
          <span class="muted">${pct}%</span>
        </td>
        <td>${r.last_activity_at ? escapeHtml(fmtIso(r.last_activity_at)) : '—'}</td>
        <td><button type="button" class="btn btn-sm" data-act="report" data-id="${id}">View Report</button></td>
      </tr>`;
    })
    .join('');
  dailySummaryBody.querySelectorAll('[data-act="report"]').forEach((btn) => {
    btn.addEventListener('click', () => void openTankReport(Number(btn.getAttribute('data-id'))));
  });
}

async function loadDailySummary() {
  if (!dailySummaryBody) return;
  if (dailySummaryDate && !dailySummaryDate.value) dailySummaryDate.value = todayLocalDateInput();
  const date = dailySummaryDate ? dailySummaryDate.value : todayLocalDateInput();
  const { res, data } = await apiJson(`/api/manager/daily-summary?date=${encodeURIComponent(date)}`);
  if (!res.ok) {
    dailySummaryBody.innerHTML = `<tr><td colspan="10" class="muted">${escapeHtml((data && data.message) || 'Could not load daily summary.')}</td></tr>`;
    return;
  }
  dailySummaryRows = data.tanks || [];
  renderDailySummaryTable();
}

function exportDailySummaryCsv() {
  const date = dailySummaryDate ? dailySummaryDate.value : todayLocalDateInput();
  window.location.href = `/api/summary/tanks.csv?date=${encodeURIComponent(date)}`;
}

function exportDailySummaryPdf() {
  const date = dailySummaryDate ? dailySummaryDate.value : todayLocalDateInput();
  window.location.href = `/api/summary/tanks.pdf?date=${encodeURIComponent(date)}`;
}

async function loadProductionNotes() {
  if (!productionNotesBody) return;
  const { res, data } = await apiJson('/api/manager/production-notes?limit=150');
  if (!res.ok) {
    productionNotesBody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml((data && data.message) || 'Could not load notes.')}</td></tr>`;
    return;
  }
  const notes = data.notes || [];
  if (!notes.length) {
    productionNotesBody.innerHTML = '<tr><td colspan="7" class="muted">No production notes yet.</td></tr>';
    return;
  }
  productionNotesBody.innerHTML = notes
    .map(
      (n) => `<tr>
      <td>${fmtIso(n.created_at)}</td>
      <td>${escapeHtml(n.note_type || '—')}</td>
      <td>${escapeHtml(n.tank_number || '—')}</td>
      <td>${n.piece_number != null ? Number(n.piece_number) : '—'}</td>
      <td>${escapeHtml(n.team_name || '—')}</td>
      <td>${escapeHtml(n.machine_name || '—')}</td>
      <td>${escapeHtml(n.body || '—')}</td>
    </tr>`
    )
    .join('');
}

if (btnAddTank) btnAddTank.addEventListener('click', () => void createTank());
if (tankSearch) tankSearch.addEventListener('input', () => void loadTanks());
if (btnClearTankSearch) btnClearTankSearch.addEventListener('click', () => clearTankSearch());
if (tankStatusFilter) tankStatusFilter.addEventListener('change', () => void loadTanks());
if (btnPrintSelectedTanks) btnPrintSelectedTanks.addEventListener('click', () => printSelectedTanks());
if (btnPrintAllTanks) btnPrintAllTanks.addEventListener('click', () => printAllTanks());
if (btnSelectAllTanks || document.getElementById('tankSelectAll')) {
  const toggleAll = () => {
    const boxes = document.querySelectorAll('.tank-select-cb');
    const master = document.getElementById('tankSelectAll');
    const checked = master ? master.checked : true;
    boxes.forEach((b) => {
      b.checked = checked;
    });
  };
  if (btnSelectAllTanks) {
    btnSelectAllTanks.addEventListener('click', () => {
      const master = document.getElementById('tankSelectAll');
      if (master) master.checked = true;
      toggleAll();
    });
  }
}
if (btnSaveTankEdit) btnSaveTankEdit.addEventListener('click', () => void saveTankEdit());
if (btnCancelTankEdit) btnCancelTankEdit.addEventListener('click', closeTankEdit);
if (btnCloseTankEdit) btnCloseTankEdit.addEventListener('click', closeTankEdit);
if (tankEditBackdrop) {
  tankEditBackdrop.addEventListener('click', (e) => {
    if (e.target === tankEditBackdrop) closeTankEdit();
  });
}
if (btnConfirmTankTrash) btnConfirmTankTrash.addEventListener('click', () => void confirmMoveTankToTrash());
if (btnCancelTankTrash) btnCancelTankTrash.addEventListener('click', closeTankTrashConfirm);
if (tankTrashConfirmBackdrop) {
  tankTrashConfirmBackdrop.addEventListener('click', (e) => {
    if (e.target === tankTrashConfirmBackdrop) closeTankTrashConfirm();
  });
}
if (btnConfirmTankTrashRestore) {
  btnConfirmTankTrashRestore.addEventListener('click', () => void confirmRestoreTankFromTrash());
}
if (btnCancelTankTrashRestore) btnCancelTankTrashRestore.addEventListener('click', closeTankTrashRestore);
if (tankTrashRestoreBackdrop) {
  tankTrashRestoreBackdrop.addEventListener('click', (e) => {
    if (e.target === tankTrashRestoreBackdrop) closeTankTrashRestore();
  });
}
if (btnConfirmTankPermanentDelete) {
  btnConfirmTankPermanentDelete.addEventListener('click', () => void confirmPermanentDeleteTank());
}
if (btnCancelTankPermanentDelete) btnCancelTankPermanentDelete.addEventListener('click', closeTankPermanentDelete);
if (tankPermanentDeleteConfirmInput) {
  tankPermanentDeleteConfirmInput.addEventListener('input', syncPermanentDeleteButton);
}
if (tankPermanentDeleteBackdrop) {
  tankPermanentDeleteBackdrop.addEventListener('click', (e) => {
    if (e.target === tankPermanentDeleteBackdrop) closeTankPermanentDelete();
  });
}
if (btnDailySummaryRefresh) btnDailySummaryRefresh.addEventListener('click', () => void loadDailySummary());
if (dailySummaryDate) dailySummaryDate.addEventListener('change', () => void loadDailySummary());
if (dailySummaryFilter) dailySummaryFilter.addEventListener('input', () => renderDailySummaryTable());
if (btnDailySummaryCsv) btnDailySummaryCsv.addEventListener('click', () => exportDailySummaryCsv());
if (btnDailySummaryPrint) {
  btnDailySummaryPrint.addEventListener('click', () => exportDailySummaryPdf());
}
const dailySummaryTable = document.getElementById('dailySummaryTable');
if (dailySummaryTable) {
  dailySummaryTable.querySelectorAll('th[data-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (dailySortKey === key) dailySortDir *= -1;
      else {
        dailySortKey = key;
        dailySortDir = 1;
      }
      renderDailySummaryTable();
    });
  });
}
if (btnNotesRefresh) btnNotesRefresh.addEventListener('click', () => void loadProductionNotes());

if (tankBody) tankBody.addEventListener('click', (e) => {
  const moreBtn = e.target.closest('[data-tank-more]');
  if (moreBtn) {
    e.preventDefault();
    e.stopPropagation();
    openTankActionsMenu(moreBtn);
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn || !tankBody.contains(btn)) return;
  handleTankActionButton(btn);
});

document.addEventListener('click', (e) => {
  const menu = document.getElementById('tankActionsMenu');
  if (!menu || !menu.classList.contains('is-open')) return;
  if (e.target.closest('#tankActionsMenu')) {
    const btn = e.target.closest('button[data-act]');
    if (btn) handleTankActionButton(btn);
    return;
  }
  if (e.target.closest('[data-tank-more]')) return;
  closeTankActionsMenu();
});

window.addEventListener('resize', () => closeTankActionsMenu());
window.addEventListener(
  'scroll',
  () => {
    if (document.getElementById('tankActionsMenu')?.classList.contains('is-open')) closeTankActionsMenu();
  },
  true
);

if (btnCloseTankReport) btnCloseTankReport.addEventListener('click', closeTankReport);
if (btnPrintTankReport) {
  btnPrintTankReport.addEventListener('click', () => {
    if (!currentTankReportId) return;
    window.location.href = `/api/tanks/${currentTankReportId}/report.pdf`;
  });
}
if (btnExportTankReportCsv) {
  btnExportTankReportCsv.addEventListener('click', () => {
    if (!currentTankReportId) return;
    window.location.href = `/api/tanks/${currentTankReportId}/report.csv`;
  });
}
if (btnExportTankReportXlsx) {
  btnExportTankReportXlsx.addEventListener('click', () => {
    if (!currentTankReportId) return;
    window.location.href = `/api/tanks/${currentTankReportId}/report.xlsx`;
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
  setInterval(() => void loadProductionNotes(), 30000);
  try {
    const params = new URLSearchParams(window.location.search || '');
    const reportId = Number(params.get('tankReport'));
    if (Number.isInteger(reportId) && reportId > 0) {
      window.setTimeout(() => void openTankReport(reportId), 400);
    }
  } catch (_err) {
    /* ignore */
  }
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
wirePinShow(showOwnerPasswords, ownerCurrentPassword);
wirePinShow(showOwnerPasswords, ownerNewPassword);
wirePinShow(showOwnerPasswords, ownerConfirmPassword);
wirePinShow(showManagerResetPassword, managerResetPassword);
wirePinShow(showManagerResetPassword, managerResetConfirmPassword);

function escapePinHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadKioskPinMachines() {
  if (!kioskPinGrid) return;
  kioskPinGrid.innerHTML = '<p class="muted">Loading machines…</p>';
  const { res, data } = await apiJson('/api/manager/kiosk-pins');
  if (!res.ok || !data.ok) {
    kioskPinGrid.innerHTML = `<p class="muted">${escapePinHtml((data && data.message) || 'Could not load machines.')}</p>`;
    return;
  }
  const machines = Array.isArray(data.machines) ? data.machines : [];
  if (!machines.length) {
    kioskPinGrid.innerHTML = '<p class="muted">No active winding machines. Add one in Manage Machines.</p>';
    return;
  }
  kioskPinGrid.innerHTML = machines
    .map((m) => {
      const id = Number(m.id);
      const status = m.has_pin
        ? '<span class="muted" style="font-size:0.85rem;font-weight:700;">PIN configured</span>'
        : '<span class="muted" style="font-size:0.85rem;font-weight:700;color:#b45309;">No PIN set</span>';
      return `<article class="manager-subcard" data-machine-id="${id}">
        <h3 class="manager-subcard-title">${escapePinHtml(m.name)}</h3>
        <div class="field">
          <label for="pinMachine${id}">New PIN</label>
          <input id="pinMachine${id}" class="kiosk-pin-input" data-machine-id="${id}" type="password" inputmode="numeric" maxlength="6" placeholder="4-6 digit PIN" autocomplete="new-password" />
        </div>
        <label class="pw-inline manager-checkbox"><input class="kiosk-pin-show" type="checkbox" data-pin-input="pinMachine${id}" /> Show PIN</label>
        <div style="margin-top:8px">${status}</div>
      </article>`;
    })
    .join('');
  kioskPinGrid.querySelectorAll('.kiosk-pin-show').forEach((cb) => {
    const input = document.getElementById(cb.getAttribute('data-pin-input'));
    wirePinShow(cb, input);
  });
}

async function refreshAuthUi() {
  const { res, data } = await apiJson('/api/auth/me');
  currentAuthUser = res.ok && data && data.user ? data.user : null;
  const isOwner = !!currentAuthUser && String(currentAuthUser.role || '').toUpperCase() === 'MANAGER' && String(currentAuthUser.username || '').toLowerCase() === 'owner';
  if (ownerSecuritySection) ownerSecuritySection.style.display = isOwner ? '' : 'none';
}

async function saveKioskPins() {
  if (!kioskPinHint) return;
  setAlert(kioskPinHint, '', null);
  const pins = [];
  (kioskPinGrid ? kioskPinGrid.querySelectorAll('.kiosk-pin-input') : []).forEach((input) => {
    const digits = String(input.value || '').trim();
    if (!digits) return;
    pins.push({ machine_id: Number(input.getAttribute('data-machine-id')), pin: digits });
  });
  if (!pins.length) {
    setAlert(kioskPinHint, 'Enter at least one new PIN to update.', 'error');
    return;
  }
  for (const item of pins) {
    if (!/^\d{4,6}$/.test(item.pin)) {
      setAlert(kioskPinHint, 'Each PIN must be exactly 4–6 digits.', 'error');
      return;
    }
  }
  if (btnSaveKioskPins) btnSaveKioskPins.disabled = true;
  const { res, data } = await apiJson('/api/manager/kiosk-pins', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pins }),
  });
  if (!res.ok) {
    setAlert(kioskPinHint, (data && data.message) || 'Could not save PINs.', 'error');
    if (btnSaveKioskPins) btnSaveKioskPins.disabled = false;
    return;
  }
  setAlert(kioskPinHint, 'Kiosk PINs updated.', 'success');
  if (btnSaveKioskPins) btnSaveKioskPins.disabled = false;
  await loadKioskPinMachines();
}

if (btnSaveKioskPins) btnSaveKioskPins.addEventListener('click', () => void saveKioskPins());
void loadKioskPinMachines();

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
