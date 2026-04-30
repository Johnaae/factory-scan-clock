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
const routePath = String(window.location.pathname || '').toLowerCase();
const routeMode = String(new URLSearchParams(window.location.search).get('mode') || '').toLowerCase();
const kioskOnlyMode = routePath === '/kiosk' || routePath === '/ipad-scan' || routeMode === 'kiosk';

const ACTIVITY_OPTIONS = [
  { code: 'RUN_MACHINE', label: 'Run Machine' },
  { code: 'ASSEMBLE', label: 'Assemble' },
  { code: 'QUALITY', label: 'Quality Check' },
  { code: 'SURFACE_SANDING', label: 'Surface Sanding' },
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
  WAITING_EMPLOYEE: 'WAITING_EMPLOYEE',
  WAITING_ACTIVITY: 'WAITING_ACTIVITY',
  WAITING_TANK: 'WAITING_TANK',
  WAITING_OUT_REASON: 'WAITING_OUT_REASON',
};

let scanBuffer = '';
let lastKeyTime = 0;
let scanTimer = null;

const SCAN_TIMEOUT = 50;

/** Monotonic id: new scan in `handleBarcode` supersedes in-flight async work. */
let scanSequenceId = 0;

let errorMessage = '';
let rescanBadge = false;
let unknownEmployeeCode = '';
let lastErrorCode = '';
let lastSuccessCode = '';

const state = {
  step: WORKFLOW_STATE.WAITING_EMPLOYEE,
  currentEmployee: null,
  nextStatus: null,
  selectedActivity: null,
  selectedReason: null,
  selectedTank: null,
  activeTankNumber: null,
  statusRefreshTimer: null,
  focusTimer: null,
  isBusy: false,
  lastAction: '',
  authUser: null,
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
    .replace(/[^A-Z0-9_-]/g, '');
}

const WORK_ACTIVITY_CODES = [
  'RUN_MACHINE',
  'ASSEMBLE',
  'QUALITY',
  'QUALITY_CHECK',
  'SURFACE_SANDING',
  'SANDING',
  'CUTTING',
  'WELDING',
  'MATERIAL_HANDLING',
  'OTHER',
];

const OUT_REASON_CODES = [
  'BREAK',
  'LUNCH',
  'BATHROOM',
  'END_SHIFT',
  'MACHINE_ISSUE',
  'WAITING_MATERIAL',
  'MAINTENANCE',
  'SETUP_CHANGE',
  'OTHER',
];

const CODE_ALIASES = new Map([
  ['RUN_MACHINE', 'RUN_MACHINE'],
  ['QUALITY_CHECK', 'QUALITY'],
  ['SURFACE_SANDING', 'SURFACE_SANDING'],
  ['SANDING', 'SURFACE_SANDING'],
  ['MATERIAL_HANDLING', 'MATERIAL_HANDLING'],
  ['END_SHIFT', 'END_SHIFT'],
  ['MACHINE_ISSUE', 'MACHINE_ISSUE'],
  ['WAITING_MATERIAL', 'WAITING_MATERIAL'],
  ['SETUP_CHANGE', 'SETUP_CHANGE'],
]);

function canonicalizeCode(raw) {
  const normalized = normalizeCode(raw);
  return CODE_ALIASES.get(normalized) || normalized;
}

function classifyCode(code) {
  if (/^EMP\d{3}$/.test(code)) return 'EMPLOYEE';
  if (/^TANK_[A-Z0-9-]+$/.test(code)) return 'TANK';
  if (WORK_ACTIVITY_CODES.includes(code)) return 'WORK_ACTIVITY';
  if (OUT_REASON_CODES.includes(code)) return 'OUT_REASON';
  return 'UNKNOWN';
}

function classifyBarcode(normalizedCode) {
  const n = normalizedCode;
  if (/^EMP\d{3}$/.test(n)) return { kind: 'EMPLOYEE', label: 'EMPLOYEE', value: n };
  if (/^TANK_[A-Z0-9-]+$/.test(n)) return { kind: 'TANK_BARCODE', label: 'TANK', value: n };
  if (KNOWN_ACTIVITY_CODES.has(n)) return { kind: 'ACTIVITY', label: 'ACTIVITY', value: n };
  if (KNOWN_REASON_CODES.has(n)) return { kind: 'REASON', label: 'REASON', value: n };
  return { kind: 'UNKNOWN', label: 'UNKNOWN', value: n };
}

/** Parsed tank id from normalized barcode only (never reads DOM). */
function normalizeTank(normalizedCode) {
  const v = normalizedCode;
  if (!v) return null;
  if (/^EMP\d{3}$/.test(v)) return null;
  if (v.startsWith('TANK_')) return v.slice(5) || null;
  if (/^[A-Z0-9][A-Z0-9-]*$/i.test(v)) return v;
  return null;
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

/**
 * Clears all error UI and error tracking. Does not clear lastSuccessCode.
 * Call on new scan start and after successful save.
 */
function clearScanError() {
  errorMessage = '';
  rescanBadge = false;
  unknownEmployeeCode = '';
  lastErrorCode = '';

  window.clearTimeout(showScanWarning._t);
  window.clearTimeout(showEmployeeNotFound._warnT);
  window.clearTimeout(showEmployeeNotFound._bannerT);

  dismissToastNow();

  if (rescanBadgeBanner) rescanBadgeBanner.hidden = true;
  if (scanWarning) {
    scanWarning.textContent = '';
    scanWarning.hidden = true;
  }
  updateBarcodeDebugPanel({});
}

function setLastActionFromSave(status, employeeCode) {
  state.lastAction = `Saved ${status} for ${employeeCode}`;
  if (debugLine) debugLine.textContent = state.lastAction;
  if (debugLastAction) debugLastAction.textContent = state.lastAction;
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
  }, variant === 'error' ? 4500 : 3000);
}

function showScanWarning(message, errCode = '') {
  setScanError({ code: errCode, message, showRescanBadge: false });
  window.clearTimeout(showScanWarning._t);
  showScanWarning._t = window.setTimeout(() => {
    if (scanWarning) scanWarning.hidden = true;
  }, 5500);
  showToast(message, 'error');
  playErrorBeep();
}

/** Unknown employee (valid EMP### shape, not in DB). Does not alter workflow state. */
function showEmployeeNotFound(code) {
  const msg = `Unknown employee ${code} — rescan badge`;
  setScanError({ code, message: msg, showRescanBadge: true });
  window.clearTimeout(showEmployeeNotFound._warnT);
  showEmployeeNotFound._warnT = window.setTimeout(() => {
    if (scanWarning) scanWarning.hidden = true;
  }, 6500);
  window.clearTimeout(showEmployeeNotFound._bannerT);
  showEmployeeNotFound._bannerT = window.setTimeout(() => {
    if (rescanBadgeBanner) rescanBadgeBanner.hidden = true;
    rescanBadge = false;
  }, 6500);
  showToast(msg, 'error');
  playErrorBeep();
  focusScannerTrapSoon();
}

function focusScannerTrapSoon() {
  window.setTimeout(() => {
    const active = document.activeElement;
    const manual = document.getElementById('manualBarcodeInput');
    const trap = document.getElementById('scannerTrap');

    if (active === manual) return;

    if (state.step === WORKFLOW_STATE.WAITING_TANK && active === tankInput) return;

    if (state.step === WORKFLOW_STATE.WAITING_TANK && tankInput) {
      tankInput.focus({ preventScroll: true });
    } else if (trap) {
      trap.focus({ preventScroll: true });
    }
    updateBarcodeDebugPanel({});
  }, 50);
}

/** Focus scanner trap or tank field (never steals manual typing). */
function focusPrimaryScannerOrTank() {
  if (!scannerTrap || !tankInput) return;
  if (state.step === WORKFLOW_STATE.WAITING_TANK) {
    tankInput.focus({ preventScroll: true });
  } else {
    scannerTrap.focus({ preventScroll: true });
  }
  updateBarcodeDebugPanel({});
}

function setDebug(text) {
  state.lastAction = text || '';
  if (debugLine) debugLine.textContent = state.lastAction;
  if (debugLastAction) debugLastAction.textContent = state.lastAction || '—';
}


function renderCurrentWorker() {
  if (!state.currentEmployee) {
    currentWorkerCard.hidden = true;
    currentWorkerName.textContent = '—';
    currentWorkerMode.textContent = '—';
    return;
  }
  currentWorkerCard.hidden = false;
  currentWorkerName.textContent = state.currentEmployee.name;
  currentWorkerMode.textContent = state.nextStatus === 'IN' ? 'Check IN' : 'Check OUT';
}

function renderSelectionPanel() {
  if (state.step !== WORKFLOW_STATE.WAITING_ACTIVITY && state.step !== WORKFLOW_STATE.WAITING_OUT_REASON) {
    selectionPanel.hidden = true;
    selectionButtons.innerHTML = '';
    return;
  }
  selectionPanel.hidden = false;
  const isIn = state.step === WORKFLOW_STATE.WAITING_ACTIVITY;
  const options = isIn ? ACTIVITY_OPTIONS : REASON_OPTIONS;
  selectionTitle.textContent = isIn ? 'Select Activity' : 'Select Out Reason';
  selectionButtons.innerHTML = '';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-btn';
    btn.textContent = opt.label;
    btn.dataset.code = opt.code;
    btn.addEventListener('click', () => {
      void handleBarcode(opt.code, { source: 'button' });
    });
    selectionButtons.appendChild(btn);
  }
}

function renderTankPanel() {
  tankPanel.hidden = state.step !== WORKFLOW_STATE.WAITING_TANK;
  if (!tankPanel.hidden) {
    window.setTimeout(() => focusPrimaryScannerOrTank(), 0);
  }
}

function renderWorkflow() {
  if (!state.currentEmployee) {
    workflowTitle.textContent = 'Scan employee badge';
    workflowSub.textContent = 'Scan or type employee code — field clears after each read (Enter from scanner).';
  } else if (state.step === WORKFLOW_STATE.WAITING_ACTIVITY) {
    workflowTitle.textContent = `${state.currentEmployee.name} — Check IN`;
    workflowSub.textContent = 'Tap an activity or scan/type the activity code, then Enter.';
  } else if (state.step === WORKFLOW_STATE.WAITING_TANK) {
    workflowTitle.textContent = `${state.currentEmployee.name} — Tank Number`;
    workflowSub.textContent = 'Scan tank in the scanner field or type here — Enter to confirm.';
  } else if (state.step === WORKFLOW_STATE.WAITING_OUT_REASON) {
    workflowTitle.textContent = `${state.currentEmployee.name} — Check OUT`;
    workflowSub.textContent = 'Tap a reason or scan/type the reason code, then Enter.';
  } else {
    workflowTitle.textContent = 'Scan employee badge';
    workflowSub.textContent = 'Scan or type employee code — field clears after each read.';
  }
  renderCurrentWorker();
  renderSelectionPanel();
  renderTankPanel();
}

function resetWorkflow() {
  state.step = WORKFLOW_STATE.WAITING_EMPLOYEE;
  state.currentEmployee = null;
  state.nextStatus = null;
  state.selectedActivity = null;
  state.selectedReason = null;
  state.selectedTank = null;
  state.activeTankNumber = null;
  tankInput.value = '';
  if (scannerTrap) scannerTrap.value = '';
  if (manualBarcodeInput) manualBarcodeInput.value = '';
  renderWorkflow();
  focusScannerTrapSoon();
}

async function apiJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function refreshStatusList() {
  const { res, data } = await apiJson('/api/kiosk/status');
  if (!res.ok || !data.ok || !Array.isArray(data.rows)) {
    statusTableBody.innerHTML = '<tr><td colspan="5" class="status-empty">Failed to load status.</td></tr>';
    return;
  }
  if (data.rows.length === 0) {
    statusTableBody.innerHTML = '<tr><td colspan="5" class="status-empty">No employees found.</td></tr>';
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
  const { res, data } = await apiJson('/api/auth/me');
  if (!res.ok || !data.ok || !data.user) {
    state.authUser = null;
    return false;
  }
  state.authUser = data.user;
  if (state.authUser.role === 'KIOSK' && state.authUser.area_name) {
    kioskStationLabel.textContent = `${state.authUser.area_name} Kiosk`;
    if (managerQuickNav) managerQuickNav.hidden = true;
    if (logoutBtn) logoutBtn.hidden = kioskOnlyMode;
  } else if (state.authUser.role === 'MANAGER') {
    kioskStationLabel.textContent = 'Manager Scan Access';
    if (managerQuickNav) managerQuickNav.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;
  }
  return true;
}

function ensureKioskGate() {
  let gate = document.getElementById('kioskPinGate');
  if (gate) return gate;
  gate = document.createElement('div');
  gate.id = 'kioskPinGate';
  gate.className = 'kiosk-pin-gate';
  gate.innerHTML = `
    <div class="kiosk-pin-card" role="dialog" aria-modal="true" aria-labelledby="kioskPinGateTitle">
      <h2 id="kioskPinGateTitle">Kiosk PIN Login</h2>
      <p>Enter area PIN to unlock this kiosk.</p>
      <label for="kioskGateArea">Area</label>
      <select id="kioskGateArea">
        <option value="">Select area…</option>
        <option value="Area A">Area A</option>
        <option value="Area B">Area B</option>
        <option value="Area C">Area C</option>
      </select>
      <label for="kioskGatePin">PIN (4–6 digits)</label>
      <input id="kioskGatePin" type="password" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
      <button id="kioskGateSubmit" type="button">Unlock Kiosk</button>
      <div id="kioskGateHint" class="kiosk-pin-hint" role="status" aria-live="polite"></div>
    </div>
  `;
  document.body.appendChild(gate);
  return gate;
}

async function requireKioskPinLogin() {
  const gate = ensureKioskGate();
  gate.hidden = false;
  const areaEl = document.getElementById('kioskGateArea');
  const pinEl = document.getElementById('kioskGatePin');
  const submitEl = document.getElementById('kioskGateSubmit');
  const hintEl = document.getElementById('kioskGateHint');
  if (!areaEl || !pinEl || !submitEl || !hintEl) return false;
  return new Promise((resolve) => {
    const attempt = async () => {
      const area = String(areaEl.value || '').trim();
      const pin = String(pinEl.value || '').trim();
      if (!area || !/^\d{4,6}$/.test(pin)) {
        hintEl.textContent = 'Select area and enter a valid 4–6 digit PIN.';
        return;
      }
      submitEl.disabled = true;
      hintEl.textContent = 'Signing in…';
      const { res, data } = await apiJson('/api/auth/login-kiosk-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ area, pin }),
      });
      submitEl.disabled = false;
      if (!res.ok || !data.ok) {
        hintEl.textContent = (data && data.message) || 'PIN login failed.';
        pinEl.value = '';
        pinEl.focus();
        return;
      }
      gate.hidden = true;
      resolve(true);
    };
    submitEl.onclick = () => void attempt();
    pinEl.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void attempt();
      }
    };
    window.setTimeout(() => areaEl.focus(), 0);
  });
}

async function saveCompletedScan(payload) {
  const { res, data } = await apiJson('/api/kiosk/complete-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !data.ok) {
    throw new Error(data.message || 'Could not save scan');
  }
  await refreshStatusList();
  return data;
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

function requireResetForOtherEmployee(nextCode) {
  if (!state.currentEmployee) return true;
  if (state.currentEmployee.code === nextCode) return true;
  const ok = window.confirm(
    `Incomplete workflow for ${state.currentEmployee.code}. Reset and switch to ${nextCode}?`
  );
  if (!ok) return false;
  resetWorkflow();
  return true;
}

async function applyEmployeeAfterLookup(code, scanId) {
  const data = await lookupEmployee(code);
  if (scanId !== scanSequenceId) return;
  state.currentEmployee = data.employee;
  state.nextStatus = data.next_status;
  state.activeTankNumber = data.active_tank_number || null;
  state.selectedActivity = null;
  state.selectedReason = null;
  state.selectedTank = null;
  state.step = data.next_status === 'IN' ? WORKFLOW_STATE.WAITING_ACTIVITY : WORKFLOW_STATE.WAITING_OUT_REASON;
  setDebug(`Employee ${data.employee.code} next ${data.next_status}`);
  renderWorkflow();
}

function promptOtherText(kind) {
  const label = window.prompt(`Enter ${kind} text (max 20 chars):`, '');
  const clean = String(label || '').trim();
  return clean ? clean.slice(0, 20) : null;
}

function handleActivityChoice(code) {
  if (state.step !== WORKFLOW_STATE.WAITING_ACTIVITY) return;
  clearScanError();
  if (code === 'OTHER') {
    const v = promptOtherText('activity');
    if (!v) return;
    state.selectedActivity = v;
  } else {
    state.selectedActivity = ACTIVITY_LOOKUP.get(code) || null;
  }
  if (!state.selectedActivity) return;
  state.step = WORKFLOW_STATE.WAITING_TANK;
  setDebug(`Activity selected: ${state.selectedActivity}`);
  renderWorkflow();
}

async function confirmTankAndSave(scanIdOpt) {
  if (state.step !== WORKFLOW_STATE.WAITING_TANK) return;
  if (scanIdOpt === undefined) clearScanError();
  const parsed = normalizeTank(normalizeBarcode(tankInput.value));
  if (!parsed) {
    showToast('Enter or scan tank number');
    focusScannerTrapSoon();
    return;
  }
  state.selectedTank = parsed;
  try {
    const payload = {
      employee_code: state.currentEmployee.code,
      status: 'IN',
      note_category: 'WORK',
      note_value: state.selectedActivity,
      tank_number: state.selectedTank,
    };
    const data = await saveCompletedScan(payload);
    if (scanIdOpt !== undefined && scanIdOpt !== scanSequenceId) return;
    clearScanError();
    lastSuccessCode = data.employee.code;
    updateBarcodeDebugPanel({});
    showToast(`${data.employee.name} checked IN`);
    setLastActionFromSave('IN', data.employee.code);
    resetWorkflow();
  } catch (err) {
    if (scanIdOpt !== undefined && scanIdOpt !== scanSequenceId) return;
    showToast(err.message || 'Failed to save IN', 'error');
    focusScannerTrapSoon();
  }
}

async function handleReasonChoice(code, scanIdOpt) {
  if (state.step !== WORKFLOW_STATE.WAITING_OUT_REASON) return;
  if (scanIdOpt === undefined) clearScanError();
  let reason = null;
  if (code === 'OTHER') reason = promptOtherText('reason');
  else reason = REASON_LOOKUP.get(code) || null;
  if (!reason) return;
  state.selectedReason = reason;
  try {
    const payload = {
      employee_code: state.currentEmployee.code,
      status: 'OUT',
      note_category: 'REASON',
      note_value: state.selectedReason,
    };
    const data = await saveCompletedScan(payload);
    if (scanIdOpt !== undefined && scanIdOpt !== scanSequenceId) return;
    clearScanError();
    lastSuccessCode = data.employee.code;
    updateBarcodeDebugPanel({});
    showToast(`${data.employee.name} checked OUT`);
    setLastActionFromSave('OUT', data.employee.code);
    resetWorkflow();
  } catch (err) {
    if (scanIdOpt !== undefined && scanIdOpt !== scanSequenceId) return;
    showToast(err.message || 'Failed to save OUT', 'error');
    focusScannerTrapSoon();
  }
}

async function processManualInput() {
  if (!manualBarcodeInput) return;
  if (state.isBusy) {
    focusScannerTrapSoon();
    return;
  }

  const raw = manualBarcodeInput.value;
  manualBarcodeInput.value = '';

  const code = canonicalizeCode(raw);
  updateBarcodeDebugPanel({ raw, normalized: code, source: 'manual' });

  if (!code) {
    focusScannerTrapSoon();
    return;
  }

  try {
    await handleBarcode(code, { source: 'manual' });
  } finally {
    focusScannerTrapSoon();
  }
}

/**
 * Routes normalized barcode only — never reads trap/manual DOM.
 */
async function handleBarcode(code, meta = {}) {
  const myScanId = ++scanSequenceId;
  clearScanError();

  const source = meta.source === 'manual' ? 'manual' : 'scanner';
  const normalizedCode = canonicalizeCode(code);
  const cls = classifyCode(normalizedCode);

  state.isBusy = true;
  updateBarcodeDebugPanel({ normalized: normalizedCode, source, processing: true });

  try {
    if (!normalizedCode || normalizedCode.length < 2) {
      return;
    }

    if (state.step === WORKFLOW_STATE.WAITING_EMPLOYEE) {
      if (cls !== 'EMPLOYEE') {
        showScanWarning('Scan employee badge first', normalizedCode);
        focusScannerTrapSoon();
        return;
      }
      if (!requireResetForOtherEmployee(normalizedCode)) {
        focusScannerTrapSoon();
        return;
      }
      try {
        await applyEmployeeAfterLookup(normalizedCode, myScanId);
        if (myScanId !== scanSequenceId) return;
      } catch (err) {
        if (myScanId !== scanSequenceId) return;
        const ec = err && err.errorCode;
        if (ec === 'unknown_employee' || err.httpStatus === 404 || /not found/i.test(String(err.message || ''))) {
          showEmployeeNotFound(normalizedCode);
          return;
        }
        if (ec === 'inactive_employee') {
          showScanWarning('Unknown employee', normalizedCode);
          focusScannerTrapSoon();
          return;
        }
        showToast(err.message || 'Scan failed', 'error');
        focusScannerTrapSoon();
      }
      return;
    }

    if (state.step === WORKFLOW_STATE.WAITING_ACTIVITY) {
      if (cls === 'WORK_ACTIVITY') {
        handleActivityChoice(normalizedCode === 'QUALITY_CHECK' ? 'QUALITY' : normalizedCode);
        return;
      }
      if (cls !== 'UNKNOWN') {
        showScanWarning('Scan work activity', normalizedCode);
        focusScannerTrapSoon();
        return;
      }
      showScanWarning('Unknown activity', normalizedCode);
      focusScannerTrapSoon();
      return;
    }

    if (state.step === WORKFLOW_STATE.WAITING_OUT_REASON) {
      if (cls === 'OUT_REASON') {
        await handleReasonChoice(normalizedCode, myScanId);
        if (myScanId !== scanSequenceId) return;
        return;
      }
      if (cls !== 'UNKNOWN') {
        showScanWarning('Scan out reason', normalizedCode);
        focusScannerTrapSoon();
        return;
      }
      showScanWarning('Unknown out reason', normalizedCode);
      focusScannerTrapSoon();
      return;
    }

    if (state.step === WORKFLOW_STATE.WAITING_TANK) {
      if (cls === 'TANK') {
        const parsed = normalizeTank(normalizedCode);
        if (parsed) {
          tankInput.value = parsed;
          await confirmTankAndSave(myScanId);
          if (myScanId !== scanSequenceId) return;
          return;
        }
      }
      if (cls !== 'UNKNOWN') {
        showScanWarning('Scan tank barcode', normalizedCode);
        focusScannerTrapSoon();
        return;
      }
      showScanWarning('Unknown tank', normalizedCode);
      focusScannerTrapSoon();
      return;
    }
  } catch (err) {
    if (myScanId !== scanSequenceId) return;
    showToast(err.message || 'Scan failed', 'error');
    focusScannerTrapSoon();
  } finally {
    state.isBusy = false;
    updateBarcodeDebugPanel({ processing: false });
    focusScannerTrapSoon();
  }
}

function processScan(raw) {
  const code = canonicalizeCode(raw);

  console.log('[SCAN RAW BUFFERED]', JSON.stringify(raw));
  console.log('[SCAN NORMALIZED]', code);
  updateBarcodeDebugPanel({ raw, normalized: code, source: 'scanner' });

  if (!code) {
    return;
  }

  console.log('SCAN ROUTED:', code, classifyCode(code));
  void handleBarcode(code, { source: 'scanner' });
}

window.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  if (active === manualBarcodeInput || active === tankInput) {
    return;
  }

  const now = Date.now();

  if (now - lastKeyTime > SCAN_TIMEOUT) {
    scanBuffer = '';
  }

  lastKeyTime = now;

  if (e.key === 'Enter') {
    processScan(scanBuffer);
    scanBuffer = '';
    clearTimeout(scanTimer);
    focusScannerTrapSoon();
    return;
  }

  if (e.key.length === 1) {
    scanBuffer += e.key;
  }

  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (scanBuffer.length > 0) {
      processScan(scanBuffer);
      scanBuffer = '';
      focusScannerTrapSoon();
    }
  }, SCAN_TIMEOUT);
});

if (scanButton) {
  scanButton.addEventListener('click', () => void processManualInput());
}

scanForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void processManualInput();
});

const kioskMain = document.querySelector('.kiosk-page');
if (kioskMain) {
  kioskMain.addEventListener(
    'click',
    (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      if (el.closest('button, a, input, textarea, select, label')) return;
      focusScannerTrapSoon();
    },
    true
  );
}

tankInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  void confirmTankAndSave();
});

tankConfirmBtn.addEventListener('click', () => {
  void confirmTankAndSave();
});

refreshStatusBtn.addEventListener('click', () => {
  void refreshStatusList();
});

window.addEventListener('load', async () => {
  resetWorkflow();
  if (kioskOnlyMode) {
    if (managerQuickNav) managerQuickNav.hidden = true;
    if (logoutBtn) logoutBtn.hidden = true;
  }
  let hasAuth = await loadAuthUser();
  if (!hasAuth && kioskOnlyMode) {
    await requireKioskPinLogin();
    hasAuth = await loadAuthUser();
  } else if (!hasAuth) {
    window.location.href = '/manager-login';
    return;
  }
  void refreshStatusList();
  if (scannerTrap) {
    scannerTrap.readOnly = true;
    scannerTrap.focus({ preventScroll: true });
  }
  updateBarcodeDebugPanel({});
  if (state.statusRefreshTimer) window.clearInterval(state.statusRefreshTimer);
  state.statusRefreshTimer = window.setInterval(() => {
    void refreshStatusList();
  }, 5000);
  if (state.focusTimer) window.clearInterval(state.focusTimer);
  state.focusTimer = window.setInterval(() => {
    const ae = document.activeElement;
    const manual = document.getElementById('manualBarcodeInput');
    if (ae === manual) return;
    if (state.step === WORKFLOW_STATE.WAITING_TANK && ae === tankInput) return;
    focusPrimaryScannerOrTank();
    updateBarcodeDebugPanel({});
  }, 500);
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await apiJson('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}
