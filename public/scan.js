'use strict';

/**
 * Factory kiosk scan — 4 barcode types only: EMPLOYEE, ACTIVITY, TANK, REASON
 * No CMD:IN / CMD:OUT
 */

const scanForm = document.getElementById('scanForm');
const scannerTrap = document.getElementById('scannerTrap');
const manualBarcodeInput = document.getElementById('manualBarcodeInput');
const scanButton = document.getElementById('scanButton');
const workflowTitle = document.getElementById('workflowTitle');
const workflowSub = document.getElementById('workflowSub');
const currentWorkerCard = document.getElementById('currentWorkerCard');
const currentWorkerName = document.getElementById('currentWorkerName');
const currentWorkerMode = document.getElementById('currentWorkerMode');
const currentWorkerActivity = document.getElementById('currentWorkerActivity');
const currentWorkerTank = document.getElementById('currentWorkerTank');
const allowedActionsEl = document.getElementById('allowedActions');
const btnClearSelection = document.getElementById('btnClearSelection');
const selectionPanel = document.getElementById('selectionPanel');
const selectionTitle = document.getElementById('selectionTitle');
const selectionButtons = document.getElementById('selectionButtons');
const tankPanel = document.getElementById('tankPanel');
const tankInput = document.getElementById('tankInput');
const tankConfirmBtn = document.getElementById('tankConfirmBtn');
const refreshStatusBtn = document.getElementById('refreshStatusBtn');
const statusTableBody = document.getElementById('statusTableBody');
const scanToast = document.getElementById('scanToast');
const scanWarning = document.getElementById('scanWarning');
const rescanBadgeBanner = document.getElementById('rescanBadgeBanner');
const debugLine = document.getElementById('debugLine');
const debugRaw = document.getElementById('debugRaw');
const debugNormalized = document.getElementById('debugNormalized');
const debugSource = document.getElementById('debugSource');
const debugLastAction = document.getElementById('debugLastAction');
const debugLastErrorCode = document.getElementById('debugLastErrorCode');
const debugLastSuccessCode = document.getElementById('debugLastSuccessCode');
const debugScanId = document.getElementById('debugScanId');
const debugProcessing = document.getElementById('debugProcessing');
const debugActiveEl = document.getElementById('debugActiveEl');
const logoutBtn = document.getElementById('logoutBtn');
const kioskStationLabel = document.getElementById('kioskStationLabel');
const managerQuickNav = document.getElementById('managerQuickNav');

const ACTIVITY_OPTIONS = [
  { code: 'RUN_MACHINE', label: 'Run Machine' },
  { code: 'ASSEMBLE', label: 'Assemble' },
  { code: 'QUALITY', label: 'Quality Check' },
  { code: 'SURFACE_SANDING', label: 'Surface Sanding' },
  { code: 'PAINTING', label: 'Painting' },
  { code: 'CUTTING', label: 'Cutting' },
  { code: 'WELDING', label: 'Welding' },
  { code: 'MATERIAL_HANDLING', label: 'Material Handling' },
  { code: 'OTHER', label: 'Other' },
];

const REASON_OPTIONS = [
  { code: 'BREAK', label: 'Break' },
  { code: 'LUNCH', label: 'Lunch' },
  { code: 'BATHROOM', label: 'Bathroom' },
  { code: 'END_SHIFT', label: 'End Shift' },
  { code: 'MACHINE_ISSUE', label: 'Machine Issue' },
  { code: 'WAITING_MATERIAL', label: 'Waiting Material' },
  { code: 'MAINTENANCE', label: 'Maintenance' },
  { code: 'SETUP_CHANGE', label: 'Setup Change' },
  { code: 'OTHER', label: 'Other' },
];

const ACTIVITY_LOOKUP = new Map(ACTIVITY_OPTIONS.map((o) => [o.code, o.label]));
const REASON_LOOKUP = new Map(REASON_OPTIONS.map((o) => [o.code, o.label]));
const KNOWN_ACTIVITY_CODES = new Set(ACTIVITY_OPTIONS.map((o) => o.code));
const KNOWN_REASON_CODES = new Set(REASON_OPTIONS.map((o) => o.code));

/** @readonly */
const STEP = {
  IDLE: 'IDLE',
  EMPLOYEE_SELECTED_OUT: 'EMPLOYEE_SELECTED_OUT',
  IN_ACTIVITY_PENDING_TANK: 'IN_ACTIVITY_PENDING_TANK',
  EMPLOYEE_SELECTED_IN: 'EMPLOYEE_SELECTED_IN',
};

const SELECTION_IDLE_MS = 60000;
const SCAN_TIMEOUT = 50;
const ERROR_RESET_MS = 4000;

let scanBuffer = '';
let lastKeyTime = 0;
let scanTimer = null;
let scanSequenceId = 0;
let errorResetTimer = null;

let lastErrorCode = '';
let lastSuccessCode = '';

/** Single source of truth for kiosk UI state */
const ks = {
  step: STEP.IDLE,
  employee: null,
  employeeStatus: 'OUT',
  activity: null,
  tank: null,
  pendingActivity: null,
  isBusy: false,
  lastAction: '',
  authUser: null,
  kioskArea: '',
  statusRefreshTimer: null,
  focusTimer: null,
  idleTimer: null,
};

function normalizeBarcode(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/['"]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_:-]/g, '');
}

const CODE_ALIASES = new Map([
  ['QUALITY_CHECK', 'QUALITY'],
  ['SANDING', 'SURFACE_SANDING'],
  ['ASSEMBLY', 'ASSEMBLE'],
]);

function canonicalizeCode(raw) {
  const n = normalizeCode(raw);
  return CODE_ALIASES.get(n) || n;
}

function parsePrefixed(code, prefix) {
  const n = String(code || '').toUpperCase();
  if (n.startsWith(`${prefix}:`)) return n.slice(prefix.length + 1);
  if (n.startsWith(`${prefix}_`)) return n.slice(prefix.length + 1);
  return null;
}

/** @returns {{ type: string, value: string, tank?: string }} */
function classifyBarcode(code) {
  const n = code;
  if (/^EMP\d{3}$/.test(n)) return { type: 'EMPLOYEE', value: n };
  const act = parsePrefixed(n, 'ACTIVITY');
  if (act) return { type: 'ACTIVITY', value: CODE_ALIASES.get(act) || act };
  const reason = parsePrefixed(n, 'REASON');
  if (reason) return { type: 'REASON', value: reason };
  if (KNOWN_ACTIVITY_CODES.has(n)) return { type: 'ACTIVITY', value: n };
  if (KNOWN_REASON_CODES.has(n)) return { type: 'REASON', value: n };
  if (n.startsWith('TANK_')) {
    const t = n.slice(5);
    if (t) return { type: 'TANK', value: n, tank: t };
  }
  if (/^[A-Z0-9][A-Z0-9-]*$/.test(n) && !n.startsWith('CMD')) {
    return { type: 'TANK', value: n, tank: n };
  }
  return { type: 'UNKNOWN', value: n };
}

function activityLabel(code, clsValue) {
  if (code === 'OTHER') return null;
  const key = clsValue || code;
  return ACTIVITY_LOOKUP.get(key) || String(key).replace(/_/g, ' ').slice(0, 20);
}

function reasonLabel(code) {
  if (code === 'OTHER') return null;
  return REASON_LOOKUP.get(code) || String(code).replace(/_/g, ' ').slice(0, 20);
}

function isEmployeeIn() {
  return ks.employeeStatus === 'IN';
}

function getAllowed() {
  switch (ks.step) {
    case STEP.EMPLOYEE_SELECTED_OUT:
      return { activity: true, tank: false, reason: false };
    case STEP.IN_ACTIVITY_PENDING_TANK:
      return { activity: false, tank: true, reason: false };
    case STEP.EMPLOYEE_SELECTED_IN:
      return { activity: true, tank: true, reason: true };
    default:
      return { activity: false, tank: false, reason: false };
  }
}

function resetIdleTimer() {
  if (ks.idleTimer) window.clearTimeout(ks.idleTimer);
  if (ks.step === STEP.IDLE) return;
  ks.idleTimer = window.setTimeout(() => {
    showToast('Selection cleared (idle).');
    resetToIdle();
  }, SELECTION_IDLE_MS);
}

function resetToIdle() {
  if (ks.idleTimer) window.clearTimeout(ks.idleTimer);
  ks.idleTimer = null;
  if (errorResetTimer) window.clearTimeout(errorResetTimer);
  errorResetTimer = null;
  ks.step = STEP.IDLE;
  ks.employee = null;
  ks.employeeStatus = 'OUT';
  ks.activity = null;
  ks.tank = null;
  ks.pendingActivity = null;
  if (tankInput) tankInput.value = '';
  if (scannerTrap) scannerTrap.value = '';
  if (manualBarcodeInput) manualBarcodeInput.value = '';
  renderUi();
  focusScanner();
}

function finishSuccess(message) {
  if (message) showToast(message);
  void refreshStatusList();
  resetToIdle();
}

function scheduleErrorReset(message) {
  showScanWarning(message);
  if (errorResetTimer) window.clearTimeout(errorResetTimer);
  errorResetTimer = window.setTimeout(() => resetToIdle(), ERROR_RESET_MS);
}

function renderAllowedActions() {
  if (!allowedActionsEl) return;
  if (ks.step === STEP.IDLE) {
    allowedActionsEl.hidden = true;
    return;
  }
  const a = getAllowed();
  allowedActionsEl.hidden = false;
  allowedActionsEl.innerHTML = `
    <div class="allowed-row ${a.activity ? 'allowed-yes' : 'allowed-no'}">${a.activity ? '✅' : '❌'} Activity</div>
    <div class="allowed-row ${a.tank ? 'allowed-yes' : 'allowed-no'}">${a.tank ? '✅' : '❌'} Tank</div>
    <div class="allowed-row ${a.reason ? 'allowed-yes' : 'allowed-no'}">${a.reason ? '✅' : '❌'} Reason</div>
  `;
}

function renderEmployeeCard() {
  if (!currentWorkerCard) return;
  if (!ks.employee) {
    currentWorkerCard.hidden = true;
    return;
  }
  currentWorkerCard.hidden = false;
  const emp = ks.employee;
  if (currentWorkerName) {
    currentWorkerName.textContent = `${emp.name || '—'} (${emp.code || '—'})`;
  }
  const inStatus = isEmployeeIn();
  if (currentWorkerMode) {
    currentWorkerMode.textContent = inStatus ? 'Employee currently IN' : 'Employee OUT';
    currentWorkerMode.className = inStatus
      ? 'current-worker-status current-worker-status--in'
      : 'current-worker-status current-worker-status--out';
  }
  if (currentWorkerActivity) {
    currentWorkerActivity.textContent = `Activity: ${ks.activity || '—'}`;
  }
  if (currentWorkerTank) {
    currentWorkerTank.textContent = `Tank: ${ks.tank || '—'}`;
  }
}

function renderWorkflowText() {
  if (!workflowTitle || !workflowSub) return;
  if (ks.step === STEP.IDLE) {
    workflowTitle.textContent = 'Scan employee badge';
    workflowSub.textContent = 'Clock in: Employee → Activity → Tank. Clock out: Employee → Reason.';
    return;
  }
  const name = ks.employee ? ks.employee.name : 'Employee';
  if (ks.step === STEP.EMPLOYEE_SELECTED_OUT) {
    workflowTitle.textContent = `${name} — OUT`;
    workflowSub.textContent = 'Next: Scan activity to clock in';
    return;
  }
  if (ks.step === STEP.IN_ACTIVITY_PENDING_TANK) {
    workflowTitle.textContent = `${name} — clocking IN`;
    workflowSub.textContent = `Activity: ${ks.pendingActivity || ks.activity || '—'}. Scan tank to finish.`;
    return;
  }
  if (ks.step === STEP.EMPLOYEE_SELECTED_IN) {
    workflowTitle.textContent = `${name} — IN`;
    workflowSub.textContent = 'Scan activity to change work · tank to change tank · reason to clock out';
  }
}

function renderSelectionPanel() {
  if (!selectionPanel) return;
  if (ks.step === STEP.IN_ACTIVITY_PENDING_TANK) {
    selectionPanel.hidden = true;
    if (selectionButtons) selectionButtons.innerHTML = '';
    return;
  }
  const showOut = ks.step === STEP.EMPLOYEE_SELECTED_OUT;
  const showIn = ks.step === STEP.EMPLOYEE_SELECTED_IN;
  if (!showOut && !showIn) {
    selectionPanel.hidden = true;
    if (selectionButtons) selectionButtons.innerHTML = '';
    return;
  }
  selectionPanel.hidden = false;
  const options = showIn ? REASON_OPTIONS : ACTIVITY_OPTIONS;
  if (selectionTitle) {
    selectionTitle.textContent = showIn ? 'Tap reason (clocks OUT)' : 'Tap activity (clocks IN)';
  }
  if (!selectionButtons) return;
  selectionButtons.innerHTML = '';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-btn';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      void handleBarcode(showIn && !showOut ? `REASON:${opt.code}` : `ACTIVITY:${opt.code}`, { source: 'button' });
    });
    selectionButtons.appendChild(btn);
  }
}

function renderTankPanel() {
  if (tankPanel) tankPanel.hidden = ks.step !== STEP.IN_ACTIVITY_PENDING_TANK;
}

function renderUi() {
  renderEmployeeCard();
  renderAllowedActions();
  renderWorkflowText();
  renderSelectionPanel();
  renderTankPanel();
  if (debugLine) debugLine.textContent = ks.lastAction || '';
  if (debugLastAction) debugLastAction.textContent = ks.lastAction || '—';
}

function focusScanner() {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active === manualBarcodeInput) return;
    if (ks.step === STEP.IN_ACTIVITY_PENDING_TANK && tankInput) {
      tankInput.focus({ preventScroll: true });
    } else if (scannerTrap) {
      scannerTrap.focus({ preventScroll: true });
    }
  }, 40);
}

function updateDebug(opts) {
  if (opts.raw !== undefined && debugRaw) debugRaw.textContent = opts.raw == null ? '—' : JSON.stringify(String(opts.raw));
  if (opts.normalized !== undefined && debugNormalized) debugNormalized.textContent = opts.normalized || '—';
  if (opts.source !== undefined && debugSource) debugSource.textContent = opts.source || '—';
  if (opts.processing !== undefined && debugProcessing) debugProcessing.textContent = opts.processing ? 'true' : 'false';
  if (debugScanId) debugScanId.textContent = String(scanSequenceId);
  if (debugLastErrorCode) debugLastErrorCode.textContent = lastErrorCode || '—';
  if (debugLastSuccessCode) debugLastSuccessCode.textContent = lastSuccessCode || '—';
  if (debugActiveEl) debugActiveEl.textContent = document.activeElement?.id ? `#${document.activeElement.id}` : '—';
}

function dismissToast() {
  window.clearTimeout(showToast._t);
  if (!scanToast) return;
  scanToast.classList.remove('scan-toast--visible', 'scan-toast--error');
  scanToast.hidden = true;
  scanToast.textContent = '';
}

function showToast(message, variant) {
  dismissToast();
  if (!scanToast || !message) return;
  scanToast.textContent = message;
  scanToast.hidden = false;
  if (variant === 'error') scanToast.classList.add('scan-toast--error');
  scanToast.classList.add('scan-toast--visible');
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => {
    scanToast.classList.remove('scan-toast--visible', 'scan-toast--error');
    scanToast.hidden = true;
  }, variant === 'error' ? 4500 : 3000);
}

function playErrorBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 220;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.14);
  } catch (_) {
    /* ignore */
  }
}

function showScanWarning(message) {
  lastErrorCode = message || 'error';
  if (scanWarning) {
    scanWarning.textContent = message || '';
    scanWarning.hidden = !message;
  }
  showToast(message, 'error');
  playErrorBeep();
  updateDebug({});
}

function showEmployeeNotFound(code) {
  showScanWarning(`Unknown employee ${code}`);
  if (rescanBadgeBanner) rescanBadgeBanner.hidden = false;
  if (errorResetTimer) window.clearTimeout(errorResetTimer);
  errorResetTimer = window.setTimeout(() => {
    if (rescanBadgeBanner) rescanBadgeBanner.hidden = true;
    resetToIdle();
  }, ERROR_RESET_MS);
}

async function apiJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function workAction(body) {
  const { res, data } = await apiJson('/api/kiosk/work-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !data.ok) {
    const err = new Error(data.message || 'Action failed');
    err.errorCode = data.error || '';
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

async function refreshStatusList() {
  if (!statusTableBody) return;
  const { res, data } = await apiJson('/api/kiosk/status');
  if (!res.ok || !data.ok || !Array.isArray(data.rows)) {
    statusTableBody.innerHTML = '<tr><td colspan="5" class="status-empty">Failed to load status.</td></tr>';
    return;
  }
  if (!data.rows.length) {
    const area = data.kiosk_area || ks.kioskArea || '';
    const label = area ? ` in ${area}` : '';
    statusTableBody.innerHTML = `<tr><td colspan="5" class="status-empty">No scans yet${label}.</td></tr>`;
    return;
  }
  statusTableBody.innerHTML = '';
  for (const row of data.rows) {
    const tr = document.createElement('tr');
    const cls = row.status === 'IN' ? 'in' : 'out';
    const when = row.scanned_at
      ? new Date(row.scanned_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '—';
    tr.innerHTML = `
      <td>${row.employee_name || row.employee_code || '—'}</td>
      <td><span class="status-badge ${cls}">${row.status}</span></td>
      <td>${row.note_value || '—'}</td>
      <td>${row.tank_number ? `Tank ${row.tank_number}` : '—'}</td>
      <td>${row.area_name ? `${when} · ${row.area_name}` : when}</td>`;
    statusTableBody.appendChild(tr);
  }
}

async function loadAuthUser() {
  const { res, data } = await apiJson('/api/auth/me-kiosk');
  if (!res.ok || !data.ok || !data.user) {
    window.location.href = '/kiosk-login';
    return;
  }
  ks.authUser = data.user;
  ks.kioskArea = data.user.area_name ? String(data.user.area_name) : '';
  if (ks.authUser.role === 'KIOSK' && ks.authUser.area_name) {
    if (kioskStationLabel) kioskStationLabel.textContent = `${ks.authUser.area_name} Kiosk`;
    if (managerQuickNav) managerQuickNav.hidden = true;
    if (logoutBtn) logoutBtn.hidden = false;
  } else if (ks.authUser.role === 'MANAGER') {
    if (kioskStationLabel) kioskStationLabel.textContent = 'Manager Scan Access';
    if (managerQuickNav) managerQuickNav.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;
  }
}

async function loadEmployee(code, scanId) {
  const { res, data } = await apiJson(`/api/kiosk/employee/${encodeURIComponent(code)}`, { cache: 'no-store' });
  if (scanId !== scanSequenceId) return null;
  if (!res.ok || !data.ok) {
    const err = new Error(data.message || 'Employee not found');
    err.errorCode = data.error || '';
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

async function onEmployeeScanned(code, scanId) {
  const data = await loadEmployee(code, scanId);
  if (!data || scanId !== scanSequenceId) return;

  ks.employee = data.employee;
  ks.employeeStatus = data.currently_working ? 'IN' : 'OUT';
  ks.activity = data.current_activity || null;
  ks.tank = data.active_tank_number || null;
  ks.pendingActivity = null;

  if (ks.employeeStatus === 'IN') {
    ks.step = STEP.EMPLOYEE_SELECTED_IN;
    showToast('Employee IN — scan activity, tank, or reason.');
  } else {
    ks.step = STEP.EMPLOYEE_SELECTED_OUT;
    showToast('Employee OUT — scan activity to clock in.');
  }

  ks.lastAction = `Selected ${ks.employee.code} (${ks.employeeStatus})`;
  if (data.kiosk_notice) showToast(data.kiosk_notice);
  resetIdleTimer();
  renderUi();
}

async function onActivityScanned(label, scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }

  if (ks.step === STEP.EMPLOYEE_SELECTED_OUT) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'clock_in_activity',
      activity: label,
    });
    if (scanId !== scanSequenceId) return;
    ks.employeeStatus = 'IN';
    ks.activity = data.activity || label;
    ks.pendingActivity = ks.activity;
    ks.tank = null;
    ks.step = STEP.IN_ACTIVITY_PENDING_TANK;
    lastSuccessCode = ks.employee.code;
    const ot = data.session_type === 'OVERTIME' ? ' (OT)' : '';
    showToast(`Clocked IN${ot} — scan tank.`);
    if (data.kiosk_message) showToast(data.kiosk_message);
    ks.lastAction = `Clock in ${ks.employee.code} @ ${label}`;
    resetIdleTimer();
    renderUi();
    return;
  }

  if (ks.step === STEP.IN_ACTIVITY_PENDING_TANK) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'switch_activity',
      activity: label,
    });
    if (scanId !== scanSequenceId) return;
    if (data.noop) {
      showToast(data.message || 'Already on this activity.');
      return;
    }
    ks.pendingActivity = data.activity || label;
    ks.activity = ks.pendingActivity;
    showToast(`Activity set to ${ks.activity}. Scan tank.`);
    resetIdleTimer();
    renderUi();
    return;
  }

  if (ks.step === STEP.EMPLOYEE_SELECTED_IN) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'switch_activity',
      activity: label,
    });
    if (scanId !== scanSequenceId) return;
    if (data.noop) {
      finishSuccess(data.message || 'Already on this activity.');
      return;
    }
    ks.activity = data.activity || label;
    ks.tank = data.tank_number || ks.tank;
    finishSuccess(`Activity: ${ks.activity}`);
    return;
  }

  scheduleErrorReset('Scan employee first.');
}

async function onTankScanned(tank, scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }

  if (ks.step === STEP.EMPLOYEE_SELECTED_OUT) {
    scheduleErrorReset('Scan activity first.');
    return;
  }

  if (ks.step === STEP.IN_ACTIVITY_PENDING_TANK) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'assign_tank',
      tank_number: tank,
    });
    if (scanId !== scanSequenceId) return;
    if (data.noop) {
      finishSuccess(data.message || 'Already on this tank.');
      return;
    }
    ks.tank = data.tank_number || tank;
    ks.activity = data.activity || ks.pendingActivity || ks.activity;
    lastSuccessCode = ks.employee.code;
    finishSuccess(`Working on Tank ${ks.tank}`);
    return;
  }

  if (ks.step === STEP.EMPLOYEE_SELECTED_IN) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'switch_tank',
      tank_number: tank,
    });
    if (scanId !== scanSequenceId) return;
    if (data.noop) {
      finishSuccess(data.message || 'Already on this tank.');
      return;
    }
    ks.tank = data.tank_number || tank;
    ks.activity = data.activity || ks.activity;
    finishSuccess(`Tank ${ks.tank}`);
    return;
  }

  scheduleErrorReset('Scan employee first.');
}

async function onReasonScanned(reason, scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }

  if (ks.step === STEP.EMPLOYEE_SELECTED_OUT || ks.step === STEP.IN_ACTIVITY_PENDING_TANK) {
    scheduleErrorReset('Employee already OUT. Scan activity to clock in.');
    return;
  }

  if (ks.step === STEP.EMPLOYEE_SELECTED_IN) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'clock_out',
      reason,
    });
    if (scanId !== scanSequenceId) return;
    ks.employeeStatus = 'OUT';
    ks.activity = null;
    ks.tank = null;
    lastSuccessCode = ks.employee.code;
    let msg = `Clocked out: ${reason}`;
    if (data.kiosk_message) msg += ` — ${data.kiosk_message}`;
    finishSuccess(msg);
    return;
  }

  scheduleErrorReset('Scan employee first.');
}

function promptOther(kind) {
  const v = window.prompt(`Enter ${kind} (max 20 chars):`, '');
  const s = String(v || '').trim();
  return s ? s.slice(0, 20) : null;
}

async function handleBarcode(raw, meta) {
  const myScanId = ++scanSequenceId;
  if (errorResetTimer) window.clearTimeout(errorResetTimer);
  errorResetTimer = null;
  lastErrorCode = '';
  if (scanWarning) scanWarning.hidden = true;
  if (rescanBadgeBanner) rescanBadgeBanner.hidden = true;

  const code = canonicalizeCode(raw);
  const cls = classifyBarcode(code);
  ks.isBusy = true;
  updateDebug({
    raw: meta.source === 'manual' ? raw : code,
    normalized: code,
    source: meta.source || 'scanner',
    processing: true,
  });

  try {
    if (!code || code.length < 2) return;

    if (cls.type === 'EMPLOYEE') {
      await onEmployeeScanned(cls.value, myScanId);
      return;
    }

    if (ks.step === STEP.IDLE) {
      scheduleErrorReset('Scan employee first.');
      return;
    }

    resetIdleTimer();

    if (cls.type === 'UNKNOWN') {
      scheduleErrorReset('Unknown barcode.');
      return;
    }

    const allowed = getAllowed();

    if (cls.type === 'ACTIVITY') {
      if (!allowed.activity) {
        scheduleErrorReset(isEmployeeIn() ? 'Use tank or reason.' : 'Scan activity first.');
        return;
      }
      let label = activityLabel(code, cls.value);
      if (!label && cls.value === 'OTHER') label = promptOther('activity');
      if (!label) {
        scheduleErrorReset('Unknown activity.');
        return;
      }
      await onActivityScanned(label, myScanId);
      return;
    }

    if (cls.type === 'TANK') {
      if (!allowed.tank) {
        scheduleErrorReset(
          ks.step === STEP.EMPLOYEE_SELECTED_OUT ? 'Scan activity first.' : 'Tank not allowed now.'
        );
        return;
      }
      const tank = cls.tank || cls.value;
      if (!tank) {
        scheduleErrorReset('Unknown tank.');
        return;
      }
      await onTankScanned(tank, myScanId);
      return;
    }

    if (cls.type === 'REASON') {
      if (!allowed.reason) {
        scheduleErrorReset('Employee already OUT. Scan activity to clock in.');
        return;
      }
      let label = reasonLabel(cls.value);
      if (!label && cls.value === 'OTHER') label = promptOther('reason');
      if (!label) {
        scheduleErrorReset('Unknown reason.');
        return;
      }
      await onReasonScanned(label, myScanId);
      return;
    }
  } catch (err) {
    if (myScanId !== scanSequenceId) return;
    if (err.errorCode === 'unknown_employee' || err.httpStatus === 404) {
      showEmployeeNotFound(code);
    } else {
      scheduleErrorReset(err.message || 'Scan failed.');
    }
  } finally {
    ks.isBusy = false;
    updateDebug({ processing: false });
    focusScanner();
  }
}

async function processManualInput() {
  if (!manualBarcodeInput || ks.isBusy) return;
  const raw = manualBarcodeInput.value;
  manualBarcodeInput.value = '';
  if (!String(raw || '').trim()) return;
  await handleBarcode(raw, { source: 'manual' });
}

function processScan(raw) {
  const code = canonicalizeCode(raw);
  if (!code) return;
  void handleBarcode(code, { source: 'scanner' });
}

window.addEventListener('keydown', (e) => {
  if (e.target === manualBarcodeInput || e.target === tankInput) return;
  const now = Date.now();
  if (now - lastKeyTime > SCAN_TIMEOUT) scanBuffer = '';
  lastKeyTime = now;
  if (e.key === 'Enter') {
    processScan(scanBuffer);
    scanBuffer = '';
    clearTimeout(scanTimer);
    return;
  }
  if (e.key.length === 1) scanBuffer += e.key;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (scanBuffer.length) {
      processScan(scanBuffer);
      scanBuffer = '';
    }
  }, SCAN_TIMEOUT);
});

if (scanButton) scanButton.addEventListener('click', () => void processManualInput());
if (scanForm) scanForm.addEventListener('submit', (e) => { e.preventDefault(); void processManualInput(); });
if (btnClearSelection) btnClearSelection.addEventListener('click', () => resetToIdle());
if (tankInput) {
  tankInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = normalizeBarcode(tankInput.value);
    const cls = classifyBarcode(canonicalizeCode(t));
    if (cls.type === 'TANK' && cls.tank) void onTankScanned(cls.tank, scanSequenceId);
  });
}
if (tankConfirmBtn) {
  tankConfirmBtn.addEventListener('click', () => {
    const t = normalizeBarcode(tankInput && tankInput.value ? tankInput.value : '');
    const cls = classifyBarcode(canonicalizeCode(t));
    if (cls.type === 'TANK' && cls.tank) void onTankScanned(cls.tank, scanSequenceId);
  });
}
if (refreshStatusBtn) refreshStatusBtn.addEventListener('click', () => void refreshStatusList());

window.addEventListener('load', () => {
  resetToIdle();
  void loadAuthUser();
  void refreshStatusList();
  if (scannerTrap) {
    scannerTrap.readOnly = true;
    scannerTrap.focus({ preventScroll: true });
  }
  ks.statusRefreshTimer = window.setInterval(() => void refreshStatusList(), 5000);
  ks.focusTimer = window.setInterval(() => focusScanner(), 600);
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await apiJson('/api/auth/kiosk-logout', { method: 'POST' });
    window.location.href = '/kiosk-login';
  });
}
