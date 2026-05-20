'use strict';

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

const WORKFLOW_STATE = {
  IDLE: 'IDLE',
  EMPLOYEE_SELECTED_OUT: 'EMPLOYEE_SELECTED_OUT',
  EMPLOYEE_SELECTED_IN: 'EMPLOYEE_SELECTED_IN',
  WAITING_FOR_TANK: 'WAITING_FOR_TANK',
};

const SELECTION_IDLE_MS = 60000;

let scanBuffer = '';
let lastKeyTime = 0;
let scanTimer = null;
const SCAN_TIMEOUT = 50;
let scanSequenceId = 0;

let errorMessage = '';
let rescanBadge = false;
let unknownEmployeeCode = '';
let lastErrorCode = '';
let lastSuccessCode = '';

const state = {
  step: WORKFLOW_STATE.IDLE,
  currentEmployee: null,
  currentlyWorking: false,
  currentActivity: null,
  currentTank: null,
  pendingActivity: null,
  pendingTank: null,
  statusRefreshTimer: null,
  focusTimer: null,
  selectionIdleTimer: null,
  isBusy: false,
  lastAction: '',
  authUser: null,
  kioskArea: '',
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
  const normalized = normalizeCode(raw);
  return CODE_ALIASES.get(normalized) || normalized;
}

function isCommandIn(code) {
  const n = String(code || '').toUpperCase();
  return n === 'CMD:IN' || n === 'CMD_IN' || n === 'COMMAND_IN';
}

function isCommandOut(code) {
  const n = String(code || '').toUpperCase();
  return n === 'CMD:OUT' || n === 'CMD_OUT' || n === 'COMMAND_OUT';
}

function parsePrefixedCode(code, prefix) {
  const n = String(code || '').toUpperCase();
  if (n.startsWith(`${prefix}:`)) return n.slice(prefix.length + 1);
  if (n.startsWith(`${prefix}_`)) return n.slice(prefix.length + 1);
  return null;
}

function classifyBarcode(normalizedCode) {
  const n = normalizedCode;
  if (/^EMP\d{3}$/.test(n)) return { kind: 'EMPLOYEE', value: n };
  if (isCommandIn(n)) return { kind: 'LEGACY_CMD', value: 'IN' };
  if (isCommandOut(n)) return { kind: 'LEGACY_CMD', value: 'OUT' };
  const actPref = parsePrefixedCode(n, 'ACTIVITY');
  if (actPref) return { kind: 'ACTIVITY', value: CODE_ALIASES.get(actPref) || actPref };
  const reasonPref = parsePrefixedCode(n, 'REASON');
  if (reasonPref) return { kind: 'OUT_REASON', value: reasonPref };
  if (/^TANK_[A-Z0-9-]+$/.test(n)) return { kind: 'TANK', value: n };
  if (KNOWN_ACTIVITY_CODES.has(n)) return { kind: 'ACTIVITY', value: n };
  if (KNOWN_REASON_CODES.has(n)) return { kind: 'OUT_REASON', value: n };
  const tank = normalizeTank(n);
  if (tank) return { kind: 'TANK', value: n };
  return { kind: 'UNKNOWN', value: n };
}

function normalizeTank(normalizedCode) {
  const v = normalizedCode;
  if (!v) return null;
  if (/^EMP\d{3}$/.test(v)) return null;
  if (isCommandIn(v) || isCommandOut(v)) return null;
  if (v.startsWith('ACTIVITY:') || v.startsWith('ACTIVITY_')) return null;
  if (v.startsWith('REASON:') || v.startsWith('REASON_')) return null;
  if (KNOWN_ACTIVITY_CODES.has(v)) return null;
  if (KNOWN_REASON_CODES.has(v)) return null;
  if (v.startsWith('TANK_')) return v.slice(5) || null;
  if (/^[A-Z0-9][A-Z0-9-]*$/i.test(v)) return v;
  return null;
}

function activityLabelFromScan(cls) {
  if (cls.kind !== 'ACTIVITY') return null;
  if (cls.value === 'OTHER') return null;
  return ACTIVITY_LOOKUP.get(cls.value) || cls.value.replace(/_/g, ' ');
}

function reasonLabelFromScan(cls) {
  if (cls.kind !== 'OUT_REASON') return null;
  if (cls.value === 'OTHER') return null;
  return REASON_LOOKUP.get(cls.value) || cls.value.replace(/_/g, ' ');
}

function resetSelectionIdleTimer() {
  if (state.selectionIdleTimer) window.clearTimeout(state.selectionIdleTimer);
  if (state.step === WORKFLOW_STATE.IDLE) return;
  state.selectionIdleTimer = window.setTimeout(() => {
    showToast('Selection cleared (timeout).');
    clearSelectionOnly();
  }, SELECTION_IDLE_MS);
}

function clearSelectionOnly() {
  state.step = WORKFLOW_STATE.IDLE;
  state.currentEmployee = null;
  state.currentlyWorking = false;
  state.currentActivity = null;
  state.currentTank = null;
  state.pendingActivity = null;
  state.pendingTank = null;
  tankInput.value = '';
  if (scannerTrap) scannerTrap.value = '';
  if (manualBarcodeInput) manualBarcodeInput.value = '';
  renderWorkflow();
  focusScannerTrapSoon();
}

function resetWorkflow() {
  if (state.selectionIdleTimer) window.clearTimeout(state.selectionIdleTimer);
  state.selectionIdleTimer = null;
  clearSelectionOnly();
}

function activeElementDebugLabel() {
  const el = document.activeElement;
  if (!el || el === document.body) return '(none)';
  return el.id ? `#${el.id}` : el.tagName || '—';
}

function updateBarcodeDebugPanel(opts = {}) {
  if (opts.raw !== undefined && debugRaw) {
    debugRaw.textContent = opts.raw === null || opts.raw === '' ? '—' : JSON.stringify(String(opts.raw));
  }
  if (opts.normalized !== undefined && debugNormalized) {
    debugNormalized.textContent = opts.normalized || '—';
  }
  if (opts.source !== undefined && debugSource) {
    debugSource.textContent = opts.source || '—';
  }
  if (opts.processing !== undefined && debugProcessing) {
    debugProcessing.textContent = opts.processing ? 'true' : 'false';
  }
  if (debugLastAction) debugLastAction.textContent = state.lastAction || '—';
  if (debugLastErrorCode) debugLastErrorCode.textContent = lastErrorCode || '—';
  if (debugLastSuccessCode) debugLastSuccessCode.textContent = lastSuccessCode || '—';
  if (debugScanId) debugScanId.textContent = String(scanSequenceId);
  if (debugActiveEl) debugActiveEl.textContent = activeElementDebugLabel();
}

function dismissToastNow() {
  window.clearTimeout(showToast._t);
  if (scanToast) {
    scanToast.classList.remove('scan-toast--visible', 'scan-toast--error');
    scanToast.hidden = true;
    scanToast.textContent = '';
  }
}

function clearScanError() {
  errorMessage = '';
  rescanBadge = false;
  unknownEmployeeCode = '';
  lastErrorCode = '';
  window.clearTimeout(showScanWarning._t);
  dismissToastNow();
  if (rescanBadgeBanner) rescanBadgeBanner.hidden = true;
  if (scanWarning) {
    scanWarning.textContent = '';
    scanWarning.hidden = true;
  }
  updateBarcodeDebugPanel({});
}

function setScanError({ code, message, showRescanBadge = false }) {
  unknownEmployeeCode = code || '';
  errorMessage = message || '';
  rescanBadge = showRescanBadge;
  lastErrorCode = code || (message ? '—' : '');
  if (showRescanBadge && rescanBadgeBanner) rescanBadgeBanner.hidden = false;
  else if (rescanBadgeBanner) rescanBadgeBanner.hidden = true;
  if (scanWarning) {
    scanWarning.textContent = message || '';
    scanWarning.hidden = !message;
  }
  updateBarcodeDebugPanel({});
}

function playErrorBeep() {
  try {
    const ACtx = window.AudioContext || window.webkitAudioContext;
    if (!ACtx) return;
    const ctx = new ACtx();
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

function showToast(message, variant) {
  dismissToastNow();
  if (!scanToast) return;
  scanToast.textContent = message;
  scanToast.hidden = false;
  scanToast.classList.remove('scan-toast--error');
  if (variant === 'error') scanToast.classList.add('scan-toast--error');
  scanToast.classList.add('scan-toast--visible');
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => {
    scanToast.classList.remove('scan-toast--visible', 'scan-toast--error');
    scanToast.hidden = true;
  }, variant === 'error' ? 4500 : 3500);
}

function showScanWarning(message, errCode = '') {
  setScanError({ code: errCode, message, showRescanBadge: false });
  showToast(message, 'error');
  playErrorBeep();
}

function showEmployeeNotFound(code) {
  const msg = `Unknown employee ${code} — rescan badge`;
  setScanError({ code, message: msg, showRescanBadge: true });
  showToast(msg, 'error');
  playErrorBeep();
}

function focusScannerTrapSoon() {
  window.setTimeout(() => {
    const active = document.activeElement;
    const manual = document.getElementById('manualBarcodeInput');
    if (active === manual) return;
    if (state.step === WORKFLOW_STATE.WAITING_FOR_TANK && active === tankInput) return;
    if (state.step === WORKFLOW_STATE.WAITING_FOR_TANK && tankInput) {
      tankInput.focus({ preventScroll: true });
    } else if (scannerTrap) {
      scannerTrap.focus({ preventScroll: true });
    }
    updateBarcodeDebugPanel({});
  }, 50);
}

function setDebug(text) {
  state.lastAction = text || '';
  if (debugLine) debugLine.textContent = state.lastAction;
  if (debugLastAction) debugLastAction.textContent = state.lastAction || '—';
}

function isOutFlow() {
  return (
    state.step === WORKFLOW_STATE.EMPLOYEE_SELECTED_OUT ||
    state.step === WORKFLOW_STATE.WAITING_FOR_TANK
  );
}

function isInFlow() {
  return state.step === WORKFLOW_STATE.EMPLOYEE_SELECTED_IN;
}

function renderCurrentWorker() {
  if (!state.currentEmployee) {
    currentWorkerCard.hidden = true;
    return;
  }
  currentWorkerCard.hidden = false;
  currentWorkerName.textContent = `${state.currentEmployee.name} (${state.currentEmployee.code})`;
  const status = state.currentlyWorking ? 'IN' : 'OUT';
  currentWorkerMode.textContent = `Status: ${status}`;
  if (currentWorkerActivity) {
    currentWorkerActivity.textContent = state.currentActivity ? `Activity: ${state.currentActivity}` : 'Activity: —';
  }
  if (currentWorkerTank) {
    currentWorkerTank.textContent = state.currentTank ? `Tank: ${state.currentTank}` : 'Tank: —';
  }
}

function renderSelectionPanel() {
  const show = isOutFlow() || isInFlow();
  if (!show) {
    selectionPanel.hidden = true;
    selectionButtons.innerHTML = '';
    return;
  }
  selectionPanel.hidden = false;
  const isActivity = isOutFlow();
  const options = isActivity ? ACTIVITY_OPTIONS : REASON_OPTIONS;
  selectionTitle.textContent = isActivity
    ? 'Select Activity (clocks IN)'
    : 'Select Reason (clocks OUT)';
  selectionButtons.innerHTML = '';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-btn';
    btn.textContent = opt.label;
    btn.dataset.code = opt.code;
    btn.addEventListener('click', () => {
      void handleBarcode(isActivity ? `ACTIVITY:${opt.code}` : `REASON:${opt.code}`, { source: 'button' });
    });
    selectionButtons.appendChild(btn);
  }
}

function renderTankPanel() {
  tankPanel.hidden = state.step !== WORKFLOW_STATE.WAITING_FOR_TANK;
}

function renderWorkflow() {
  if (state.step === WORKFLOW_STATE.IDLE) {
    workflowTitle.textContent = 'Scan employee badge';
    workflowSub.textContent = 'Clock in: Employee → Activity → Tank. Clock out: Employee → Reason.';
  } else if (isOutFlow()) {
    workflowTitle.textContent = `${state.currentEmployee.name} — OUT`;
    workflowSub.textContent =
      state.step === WORKFLOW_STATE.WAITING_FOR_TANK
        ? `Activity: ${state.pendingActivity || state.currentActivity || '—'}. Scan tank barcode.`
        : 'Scan activity to clock in.';
  } else if (isInFlow()) {
    workflowTitle.textContent = `${state.currentEmployee.name} — IN`;
    workflowSub.textContent = 'Scan activity, tank, or reason.';
  }
  renderCurrentWorker();
  renderSelectionPanel();
  renderTankPanel();
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
  const { res, data } = await apiJson('/api/kiosk/status');
  if (!res.ok || !data.ok || !Array.isArray(data.rows)) {
    statusTableBody.innerHTML = '<tr><td colspan="5" class="status-empty">Failed to load status.</td></tr>';
    return;
  }
  const currentArea = data.kiosk_area || state.kioskArea || '';
  if (!data.rows.length) {
    const areaLabel = currentArea ? ` in ${currentArea}` : '';
    statusTableBody.innerHTML = `<tr><td colspan="5" class="status-empty">No employees have scanned${areaLabel} yet.</td></tr>`;
    return;
  }
  statusTableBody.innerHTML = '';
  for (const row of data.rows) {
    const tr = document.createElement('tr');
    const statusCls = row.status === 'IN' ? 'in' : 'out';
    const when = row.scanned_at ? new Date(row.scanned_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
    tr.innerHTML = `
      <td>${row.employee_name || row.employee_code || '—'}</td>
      <td><span class="status-badge ${statusCls}">${row.status}</span></td>
      <td>${row.note_value || '—'}</td>
      <td>${row.tank_number ? `Tank ${row.tank_number}` : '—'}</td>
      <td>${row.area_name ? `${when} · ${row.area_name}` : when}</td>
    `;
    statusTableBody.appendChild(tr);
  }
}

async function loadAuthUser() {
  const { res, data } = await apiJson('/api/auth/me-kiosk');
  if (!res.ok || !data.ok || !data.user) {
    window.location.href = '/kiosk-login';
    return;
  }
  state.authUser = data.user;
  state.kioskArea = state.authUser && state.authUser.area_name ? String(state.authUser.area_name) : '';
  if (state.authUser.role === 'KIOSK' && state.authUser.area_name) {
    kioskStationLabel.textContent = `${state.authUser.area_name} Kiosk`;
    if (managerQuickNav) managerQuickNav.hidden = true;
    if (logoutBtn) logoutBtn.hidden = false;
  } else if (state.authUser.role === 'MANAGER') {
    kioskStationLabel.textContent = 'Manager Scan Access';
    if (managerQuickNav) managerQuickNav.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;
  }
}

async function lookupEmployee(code) {
  const { res, data } = await apiJson(`/api/kiosk/employee/${encodeURIComponent(code)}`, { cache: 'no-store' });
  if (!res.ok || !data.ok) {
    const err = new Error(data.message || 'Employee lookup failed');
    err.errorCode = data.error || '';
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

async function selectEmployee(code, scanId) {
  const data = await lookupEmployee(code);
  if (scanId !== scanSequenceId) return;
  state.currentEmployee = data.employee;
  state.currentlyWorking = !!data.currently_working;
  state.currentActivity = data.current_activity || null;
  state.currentTank = data.active_tank_number || null;
  state.pendingActivity = null;
  state.pendingTank = null;
  state.step = state.currentlyWorking
    ? WORKFLOW_STATE.EMPLOYEE_SELECTED_IN
    : WORKFLOW_STATE.EMPLOYEE_SELECTED_OUT;
  setDebug(`Employee ${data.employee.code} selected`);
  if (data.kiosk_notice) showToast(data.kiosk_notice);
  showToast(
    state.currentlyWorking
      ? 'Scan activity, tank, or reason.'
      : 'Scan activity to clock in.'
  );
  resetSelectionIdleTimer();
  renderWorkflow();
}

async function beginClockInActivity(activity, scanId) {
  const data = await workAction({
    employee_code: state.currentEmployee.code,
    action: 'clock_in_activity',
    activity,
  });
  if (scanId !== scanSequenceId) return;
  if (data.noop) {
    showToast(data.message || 'Already clocked in.');
    return;
  }
  state.currentlyWorking = true;
  state.currentActivity = data.activity || activity;
  state.pendingActivity = state.currentActivity;
  state.currentTank = null;
  state.step = WORKFLOW_STATE.WAITING_FOR_TANK;
  clearScanError();
  lastSuccessCode = state.currentEmployee.code;
  const ot = data.session_type === 'OVERTIME' ? ' (OT)' : '';
  showToast(`Clocked IN${ot}. Scan tank.`);
  if (data.kiosk_message) showToast(data.kiosk_message);
  setDebug(`Clock in activity ${state.currentEmployee.code}`);
  await refreshStatusList();
  renderWorkflow();
}

async function assignTank(tank, scanId) {
  const data = await workAction({
    employee_code: state.currentEmployee.code,
    action: 'assign_tank',
    tank_number: tank,
  });
  if (scanId !== scanSequenceId) return;
  if (data.noop) {
    showToast(data.message || 'Already on this tank.');
    return;
  }
  state.currentTank = data.tank_number || tank;
  state.currentActivity = data.activity || state.currentActivity;
  state.pendingActivity = null;
  state.pendingTank = null;
  tankInput.value = '';
  clearScanError();
  showToast(`Tank ${state.currentTank} assigned.`);
  setDebug(`Tank assigned ${state.currentEmployee.code}`);
  await refreshStatusList();
  clearSelectionOnly();
}

async function completeClockOut(reason, scanId) {
  const data = await workAction({
    employee_code: state.currentEmployee.code,
    action: 'clock_out',
    reason,
  });
  if (scanId !== scanSequenceId) return;
  clearScanError();
  showToast(`Clocked out: ${reason}`);
  if (data.kiosk_message) showToast(data.kiosk_message);
  setDebug(`Clocked OUT ${state.currentEmployee.code}`);
  await refreshStatusList();
  clearSelectionOnly();
}

async function switchActivity(activity, scanId) {
  const data = await workAction({
    employee_code: state.currentEmployee.code,
    action: 'switch_activity',
    activity,
  });
  if (scanId !== scanSequenceId) return;
  if (data.noop) {
    showToast(data.message || 'Already on this activity.');
    return;
  }
  state.currentActivity = data.activity;
  state.currentTank = data.tank_number || state.currentTank;
  const prev = data.previous_activity || '—';
  showToast(`Activity switched from ${prev} to ${data.activity}`);
  setDebug(`Switch activity ${state.currentEmployee.code}`);
  await refreshStatusList();
  resetSelectionIdleTimer();
  renderWorkflow();
}

async function switchTank(tank, scanId) {
  const data = await workAction({
    employee_code: state.currentEmployee.code,
    action: 'switch_tank',
    tank_number: tank,
  });
  if (scanId !== scanSequenceId) return;
  if (data.noop) {
    showToast(data.message || 'Already on this tank.');
    return;
  }
  state.currentTank = data.tank_number;
  state.currentActivity = data.activity || state.currentActivity;
  const prev = data.previous_tank || '—';
  showToast(`Tank switched from ${prev} to ${data.tank_number}`);
  setDebug(`Switch tank ${state.currentEmployee.code}`);
  await refreshStatusList();
  resetSelectionIdleTimer();
  renderWorkflow();
}

function promptOtherText(kind) {
  const label = window.prompt(`Enter ${kind} text (max 20 chars):`, '');
  const clean = String(label || '').trim();
  return clean ? clean.slice(0, 20) : null;
}

async function handleBarcode(code, meta = {}) {
  const myScanId = ++scanSequenceId;
  clearScanError();
  const normalizedCode = canonicalizeCode(code);
  const cls = classifyBarcode(normalizedCode);
  state.isBusy = true;
  updateBarcodeDebugPanel({
    normalized: normalizedCode,
    source: meta.source === 'manual' ? 'manual' : 'scanner',
    processing: true,
  });

  try {
    if (!normalizedCode || normalizedCode.length < 2) return;

    if (cls.kind === 'EMPLOYEE') {
      await selectEmployee(normalizedCode, myScanId);
      if (myScanId !== scanSequenceId) return;
      return;
    }

    if (state.step === WORKFLOW_STATE.IDLE) {
      showScanWarning('Scan employee first', normalizedCode);
      return;
    }

    resetSelectionIdleTimer();

    if (cls.kind === 'LEGACY_CMD') {
      showToast('Use Activity to clock in, or Reason to clock out.');
      return;
    }

    if (cls.kind === 'ACTIVITY') {
      let label = activityLabelFromScan(cls);
      if (!label && cls.value === 'OTHER') label = promptOtherText('activity');
      if (!label) {
        showScanWarning('Unknown activity', normalizedCode);
        return;
      }
      if (state.step === WORKFLOW_STATE.WAITING_FOR_TANK) {
        await switchActivity(label, myScanId);
        state.pendingActivity = label;
        return;
      }
      if (state.step === WORKFLOW_STATE.EMPLOYEE_SELECTED_OUT) {
        await beginClockInActivity(label, myScanId);
        return;
      }
      if (isInFlow()) {
        await switchActivity(label, myScanId);
        return;
      }
      showScanWarning('Scan employee first');
      return;
    }

    if (cls.kind === 'TANK') {
      const tank = normalizeTank(normalizedCode);
      if (!tank) {
        showScanWarning('Unknown tank', normalizedCode);
        return;
      }
      if (state.step === WORKFLOW_STATE.WAITING_FOR_TANK) {
        tankInput.value = tank;
        await assignTank(tank, myScanId);
        return;
      }
      if (state.step === WORKFLOW_STATE.EMPLOYEE_SELECTED_OUT) {
        showScanWarning('Scan activity first to clock in.');
        return;
      }
      if (isInFlow()) {
        await switchTank(tank, myScanId);
        return;
      }
      showScanWarning('Scan employee first');
      return;
    }

    if (cls.kind === 'OUT_REASON') {
      let reason = reasonLabelFromScan(cls);
      if (!reason && cls.value === 'OTHER') reason = promptOtherText('reason');
      if (!reason) {
        showScanWarning('Unknown reason', normalizedCode);
        return;
      }
      if (isOutFlow()) {
        showScanWarning('Employee is already out. Scan activity to clock in.');
        return;
      }
      if (isInFlow()) {
        await completeClockOut(reason, myScanId);
        return;
      }
      showScanWarning('Scan employee first');
      return;
    }

    showScanWarning('Unknown barcode', normalizedCode);
  } catch (err) {
    if (myScanId !== scanSequenceId) return;
    const ec = err && err.errorCode;
    if (ec === 'unknown_employee' || err.httpStatus === 404) {
      showEmployeeNotFound(normalizedCode);
    } else {
      showToast(err.message || 'Scan failed', 'error');
      playErrorBeep();
    }
  } finally {
    state.isBusy = false;
    updateBarcodeDebugPanel({ processing: false });
    focusScannerTrapSoon();
  }
}

async function processManualInput() {
  if (!manualBarcodeInput || state.isBusy) return;
  const raw = manualBarcodeInput.value;
  manualBarcodeInput.value = '';
  const code = canonicalizeCode(raw);
  updateBarcodeDebugPanel({ raw, normalized: code, source: 'manual' });
  if (!code) return;
  await handleBarcode(code, { source: 'manual' });
}

function processScan(raw) {
  const code = canonicalizeCode(raw);
  updateBarcodeDebugPanel({ raw, normalized: code, source: 'scanner' });
  if (!code) return;
  void handleBarcode(code, { source: 'scanner' });
}

window.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  if (active === manualBarcodeInput || active === tankInput) return;
  const now = Date.now();
  if (now - lastKeyTime > SCAN_TIMEOUT) scanBuffer = '';
  lastKeyTime = now;
  if (e.key === 'Enter') {
    processScan(scanBuffer);
    scanBuffer = '';
    clearTimeout(scanTimer);
    focusScannerTrapSoon();
    return;
  }
  if (e.key.length === 1) scanBuffer += e.key;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (scanBuffer.length > 0) {
      processScan(scanBuffer);
      scanBuffer = '';
      focusScannerTrapSoon();
    }
  }, SCAN_TIMEOUT);
});

if (scanButton) scanButton.addEventListener('click', () => void processManualInput());
scanForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void processManualInput();
});
if (btnClearSelection) btnClearSelection.addEventListener('click', () => clearSelectionOnly());
tankInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const tank = normalizeTank(normalizeBarcode(tankInput.value));
  if (!tank) return;
  state.pendingTank = tank;
  void assignTank(tank, scanSequenceId);
});
tankConfirmBtn.addEventListener('click', () => {
  const tank = normalizeTank(normalizeBarcode(tankInput.value));
  if (tank) void assignTank(tank, scanSequenceId);
});
refreshStatusBtn.addEventListener('click', () => void refreshStatusList());

window.addEventListener('load', () => {
  resetWorkflow();
  void loadAuthUser();
  void refreshStatusList();
  if (scannerTrap) {
    scannerTrap.readOnly = true;
    scannerTrap.focus({ preventScroll: true });
  }
  state.statusRefreshTimer = window.setInterval(() => void refreshStatusList(), 5000);
  state.focusTimer = window.setInterval(() => {
    const ae = document.activeElement;
    if (ae === manualBarcodeInput) return;
    if (state.step === WORKFLOW_STATE.WAITING_FOR_TANK && ae === tankInput) return;
    if (state.step === WORKFLOW_STATE.WAITING_FOR_TANK) tankInput.focus({ preventScroll: true });
    else if (scannerTrap) scannerTrap.focus({ preventScroll: true });
  }, 500);
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await apiJson('/api/auth/kiosk-logout', { method: 'POST' });
    window.location.href = '/kiosk-login';
  });
}
