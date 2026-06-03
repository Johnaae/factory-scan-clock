'use strict';

/**
 * Factory kiosk — Phase 1 workflow
 * Barcodes: EMPLOYEE, TANK, ACTIVITY (production), STOP (downtime), REASON (clock out), FINISH (end job)
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
const currentWorkerStop = document.getElementById('currentWorkerStop');
const allowedActionsEl = document.getElementById('allowedActions');
const btnClearSelection = document.getElementById('btnClearSelection');
const selectionPanel = document.getElementById('selectionPanel');
const selectionTitle = document.getElementById('selectionTitle');
const selectionButtons = document.getElementById('selectionButtons');
const refreshStatusBtn = document.getElementById('refreshStatusBtn');
const statusTableBody = document.getElementById('statusTableBody');
const scanToast = document.getElementById('scanToast');
const scanWarning = document.getElementById('scanWarning');
const finishSuccessBanner = document.getElementById('finishSuccessBanner');
const rescanBadgeBanner = document.getElementById('rescanBadgeBanner');

const FINISH_SUCCESS_BANNER_MS = 5000;
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

let activityOptions = [];
const activityLookup = new Map();
let knownActivityCodes = new Set();

let stopOptions = [
  { code: 'CLEAN_UP', label: 'Clean Up' },
  { code: 'LUNCH', label: 'Lunch' },
  { code: 'BREAK', label: 'Break' },
  { code: 'MATERIAL', label: 'Material' },
  { code: 'MAINTENANCE_DOWNTIME', label: 'Maintenance/Downtime' },
];

const STOP_CODE_ALIASES = new Map([['CLEANUP', 'CLEAN_UP']]);

let outReasonOptions = [{ code: 'END_SHIFT', label: 'End Shift' }];

const ACTIVITY_LOOKUP = activityLookup;
const KNOWN_ACTIVITY_CODES = knownActivityCodes;

const STOP_LOOKUP = new Map();
const REASON_LOOKUP = new Map();
const KNOWN_STOP_CODES = new Set();
const KNOWN_REASON_CODES = new Set();

function rebuildStopLookups() {
  STOP_LOOKUP.clear();
  KNOWN_STOP_CODES.clear();
  for (const o of stopOptions) {
    STOP_LOOKUP.set(o.code, o.label);
    KNOWN_STOP_CODES.add(o.code);
  }
  STOP_LOOKUP.set('CLEANUP', STOP_LOOKUP.get('CLEAN_UP') || 'Clean Up');
  KNOWN_STOP_CODES.add('CLEANUP');
}

function normalizeStopScanCode(code) {
  const c = String(code || '').toUpperCase();
  return STOP_CODE_ALIASES.get(c) || c;
}

function rebuildReasonLookups() {
  REASON_LOOKUP.clear();
  KNOWN_REASON_CODES.clear();
  for (const o of outReasonOptions) {
    REASON_LOOKUP.set(o.code, o.label);
    KNOWN_REASON_CODES.add(o.code);
  }
}

rebuildStopLookups();
rebuildReasonLookups();

function rebuildActivityLookups() {
  activityLookup.clear();
  knownActivityCodes.clear();
  for (const o of activityOptions) {
    activityLookup.set(o.code, o.label);
    knownActivityCodes.add(o.code);
  }
}

async function loadKioskWorkConfig() {
  const { res, data } = await apiJson('/api/kiosk/work-config', { cache: 'no-store' });
  if (!res.ok || !data.ok) return;
  if (Array.isArray(data.activities)) {
    activityOptions = data.activities;
    rebuildActivityLookups();
  }
  if (Array.isArray(data.stop_reasons) && data.stop_reasons.length) {
    stopOptions = data.stop_reasons;
    rebuildStopLookups();
  }
  if (Array.isArray(data.out_reasons) && data.out_reasons.length) {
    outReasonOptions = data.out_reasons;
    rebuildReasonLookups();
  }
  if (data.area_name) ks.kioskArea = String(data.area_name);
}

/** @readonly */
const STEP = {
  IDLE: 'IDLE',
  OUT_SELECTED: 'OUT_SELECTED',
  OUT_TANK_SELECTED: 'OUT_TANK_SELECTED',
  IN_SELECTED: 'IN_SELECTED',
  IN_CHANGE_PENDING: 'IN_CHANGE_PENDING',
  STOP_SELECTED: 'STOP_SELECTED',
};

const SELECTION_IDLE_MS = 60000;
const CHANGE_CONTEXT_MS = 15000;
const SCAN_TIMEOUT = 50;
const ERROR_RESET_MS = 4000;

let scanBuffer = '';
let lastKeyTime = 0;
let scanTimer = null;
let scanSequenceId = 0;
let errorResetTimer = null;
let changeContextTimer = null;

let lastErrorCode = '';
let lastSuccessCode = '';

const ks = {
  step: STEP.IDLE,
  employee: null,
  phase: 'OUT',
  activity: null,
  tank: null,
  stopReason: null,
  pendingActivity: null,
  pendingTank: null,
  isBusy: false,
  lastAction: '',
  authUser: null,
  kioskArea: '',
  statusRefreshTimer: null,
  focusTimer: null,
  idleTimer: null,
  lastScanSource: 'scanner',
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
  ['QA_QC', 'QAQC'],
  ['QUALITY', 'QAQC'],
  ['QUALITY_CHECK', 'QAQC'],
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
  if (act === 'CLEAN_UP' || act === 'CLEANUP') return { type: 'STOP', value: 'CLEAN_UP' };
  if (act) return { type: 'ACTIVITY', value: CODE_ALIASES.get(act) || act };
  const stop = parsePrefixed(n, 'STOP');
  if (stop) return { type: 'STOP', value: normalizeStopScanCode(stop) };
  const reason = parsePrefixed(n, 'REASON');
  if (reason === 'LUNCH' || reason === 'BREAK' || reason === 'CLEAN_UP' || reason === 'CLEANUP') {
    return { type: 'STOP', value: normalizeStopScanCode(reason) };
  }
  if (reason) return { type: 'REASON', value: reason };
  if (n === 'CLEAN_UP' || n === 'CLEANUP') return { type: 'STOP', value: 'CLEAN_UP' };
  if (KNOWN_ACTIVITY_CODES.has(n)) return { type: 'ACTIVITY', value: CODE_ALIASES.get(n) || n };
  if (KNOWN_STOP_CODES.has(n)) return { type: 'STOP', value: normalizeStopScanCode(n) };
  if (KNOWN_REASON_CODES.has(n)) return { type: 'REASON', value: n };
  if (n === 'FINISH') return { type: 'FINISH', value: 'FINISH' };
  const finishPrefixed =
    parsePrefixed(n, 'ACTION_FINISH') ||
    parsePrefixed(n, 'FINISH_CURRENT_TANK') ||
    parsePrefixed(n, 'FINISH_CURRENT');
  if (finishPrefixed) return { type: 'FINISH', value: finishPrefixed };
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
  const key = CODE_ALIASES.get(clsValue || code) || clsValue || code;
  return activityLookup.get(key) || null;
}

function formatActivity(value) {
  if (!value) return null;
  return activityLookup.get(value) || value;
}

function stopLabel(code) {
  return STOP_LOOKUP.get(normalizeStopScanCode(code)) || null;
}

function reasonLabel(code) {
  return REASON_LOOKUP.get(code) || null;
}

function employeePhase() {
  return ks.phase || 'OUT';
}

function isPhaseIn() {
  return employeePhase() === 'IN';
}

function isPhaseOut() {
  return employeePhase() === 'OUT';
}

function isPhaseStop() {
  return employeePhase() === 'STOP';
}

function hasActiveJob() {
  return !!(ks.activity && ks.tank);
}

function isWaitingForJob() {
  return isPhaseIn() && ks.employee && !hasActiveJob();
}

function getAllowed() {
  switch (ks.step) {
    case STEP.OUT_SELECTED:
      return { activity: false, tank: true, stop: false, reason: false };
    case STEP.OUT_TANK_SELECTED:
      return { activity: true, tank: false, stop: false, reason: false };
    case STEP.IN_SELECTED:
      return {
        activity: true,
        tank: true,
        stop: hasActiveJob(),
        reason: true,
        finish: hasActiveJob(),
      };
    case STEP.IN_CHANGE_PENDING:
      return { activity: true, tank: true, stop: false, reason: false, finish: false };
    case STEP.STOP_SELECTED:
      return { activity: false, tank: false, stop: false, reason: true, finish: false };
    default:
      return { activity: false, tank: false, stop: false, reason: false, finish: false };
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

function resetChangeContextTimer() {
  if (changeContextTimer) window.clearTimeout(changeContextTimer);
  if (ks.step !== STEP.IN_CHANGE_PENDING) return;
  changeContextTimer = window.setTimeout(() => {
    if (ks.step === STEP.IN_CHANGE_PENDING) {
      ks.pendingActivity = null;
      ks.pendingTank = null;
      ks.step = STEP.IN_SELECTED;
      renderUi();
    }
  }, CHANGE_CONTEXT_MS);
}

function extendChangeContext() {
  resetChangeContextTimer();
  resetIdleTimer();
}

function resetToIdle() {
  dismissFinishSuccessBanner();
  if (ks.idleTimer) window.clearTimeout(ks.idleTimer);
  ks.idleTimer = null;
  if (changeContextTimer) window.clearTimeout(changeContextTimer);
  changeContextTimer = null;
  if (errorResetTimer) window.clearTimeout(errorResetTimer);
  errorResetTimer = null;
  ks.step = STEP.IDLE;
  ks.employee = null;
  ks.phase = 'OUT';
  ks.activity = null;
  ks.tank = null;
  ks.stopReason = null;
  ks.pendingActivity = null;
  ks.pendingTank = null;
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
    <div class="allowed-row ${a.stop ? 'allowed-yes' : 'allowed-no'}">${a.stop ? '✅' : '❌'} Stop</div>
    <div class="allowed-row ${a.finish ? 'allowed-yes' : 'allowed-no'}">${a.finish ? '✅' : '❌'} Finish job</div>
    <div class="allowed-row ${a.reason ? 'allowed-yes' : 'allowed-no'}">${a.reason ? '✅' : '❌'} End Shift</div>
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
  const phase = employeePhase();
  if (currentWorkerMode) {
    let statusText = 'Employee OUT';
    let cls = 'current-worker-status current-worker-status--out';
    if (phase === 'IN') {
      if (isWaitingForJob()) {
        statusText = 'IN — Waiting for next job';
      } else if (hasActiveJob()) {
        statusText = 'Employee IN';
      } else {
        statusText = 'IN — Available';
      }
      cls = 'current-worker-status current-worker-status--in';
    } else if (phase === 'STOP') {
      statusText = ks.stopReason ? `STOP — ${ks.stopReason}` : 'Employee STOP';
      cls = 'current-worker-status current-worker-status--stop';
    }
    currentWorkerMode.textContent = statusText;
    currentWorkerMode.className = cls;
  }
  if (currentWorkerActivity) {
    const actLabel =
      phase === 'STOP'
        ? formatActivity(ks.activity) || ks.activity || '—'
        : isWaitingForJob()
          ? 'Waiting'
          : formatActivity(ks.activity) || formatActivity(ks.pendingActivity) || '—';
    currentWorkerActivity.textContent = `Activity: ${actLabel}`;
  }
  if (currentWorkerTank) {
    const tankLabel =
      phase === 'STOP'
        ? ks.tank || ks.pendingTank || '—'
        : isWaitingForJob()
          ? '—'
          : ks.tank || ks.pendingTank || '—';
    currentWorkerTank.textContent = `Tank: ${tankLabel}`;
  }
  if (currentWorkerStop) {
    const showStop = phase === 'STOP' && ks.stopReason;
    currentWorkerStop.hidden = !showStop;
    currentWorkerStop.textContent = showStop ? `Stop: ${ks.stopReason}` : '';
  }
}

function renderWorkflowText() {
  if (!workflowTitle || !workflowSub) return;
  if (ks.step === STEP.IDLE) {
    workflowTitle.textContent = 'Scan employee badge';
    workflowSub.textContent = 'OUT: Tank → Activity. IN: Activity, Tank, Finish, Stop, or Out reason.';
    return;
  }
  const name = ks.employee ? ks.employee.name : 'Employee';
  if (ks.step === STEP.OUT_SELECTED) {
    workflowTitle.textContent = `${name} — OUT`;
    workflowSub.textContent = 'Employee selected. Scan tank, then activity.';
    return;
  }
  if (ks.step === STEP.OUT_TANK_SELECTED) {
    workflowTitle.textContent = `${name} — tank selected`;
    workflowSub.textContent = 'Tank selected. Scan activity to start work.';
    return;
  }
  if (ks.step === STEP.IN_CHANGE_PENDING) {
    workflowTitle.textContent = `${name} — changing work`;
    workflowSub.textContent = ks.pendingTank
      ? `Tank ${ks.pendingTank} selected. Scan activity for this tank.`
      : 'Scan activity or tank within 15 seconds.';
    return;
  }
  if (ks.step === STEP.STOP_SELECTED) {
    workflowTitle.textContent = `${name} — STOP`;
    workflowSub.textContent = ks.stopReason
      ? `STOP — ${ks.stopReason}. Scan employee badge to resume, or End Shift to clock out.`
      : 'Scan employee badge to resume, or End Shift to clock out.';
    return;
  }
  if (ks.step === STEP.IN_SELECTED) {
    workflowTitle.textContent = `${name} — IN`;
    workflowSub.textContent = isWaitingForJob()
      ? 'IN — Waiting for next job. Scan activity + tank, or scan out reason.'
      : 'Employee selected. Scan activity, tank, Finish Job, Stop reason, or End Shift.';
  }
}

function appendQuickPickHeading(parent, title) {
  const h = document.createElement('p');
  h.className = 'quick-pick-heading';
  h.textContent = title;
  parent.appendChild(h);
}

function appendQuickPickButton(parent, label, barcode, className) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className || 'choice-btn';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    void handleBarcode(barcode, { source: 'button' });
  });
  parent.appendChild(btn);
  return btn;
}

function renderSelectionPanel() {
  if (!selectionPanel) return;
  if (ks.step === STEP.STOP_SELECTED) {
    selectionPanel.hidden = false;
    if (!selectionButtons) return;
    selectionButtons.innerHTML = '';
    if (selectionTitle) selectionTitle.textContent = 'Quick picks';
    appendQuickPickHeading(selectionButtons, 'Actions');
    appendQuickPickButton(selectionButtons, 'End Shift', 'REASON:END_SHIFT', 'choice-btn choice-btn--out');
    return;
  }
  if (ks.step === STEP.OUT_TANK_SELECTED || ks.step === STEP.IN_SELECTED || ks.step === STEP.IN_CHANGE_PENDING) {
    selectionPanel.hidden = false;
    if (!selectionButtons) return;
    selectionButtons.innerHTML = '';

    if (ks.step === STEP.OUT_TANK_SELECTED || ks.step === STEP.IN_CHANGE_PENDING) {
      if (selectionTitle) {
        selectionTitle.textContent = ks.step === STEP.OUT_TANK_SELECTED ? 'Tap activity' : 'Tap activity';
      }
      appendQuickPickHeading(selectionButtons, 'Activities');
      for (const opt of activityOptions) {
        appendQuickPickButton(selectionButtons, opt.label, `ACTIVITY:${opt.code}`);
      }
      return;
    }

    if (selectionTitle) selectionTitle.textContent = 'Quick picks';
    appendQuickPickHeading(selectionButtons, 'Activities');
    for (const opt of activityOptions) {
      appendQuickPickButton(selectionButtons, opt.label, `ACTIVITY:${opt.code}`);
    }
    if (hasActiveJob()) {
      appendQuickPickHeading(selectionButtons, 'Stop Reasons');
      for (const opt of stopOptions) {
        appendQuickPickButton(selectionButtons, opt.label, `STOP:${opt.code}`, 'choice-btn choice-btn--stop');
      }
      appendQuickPickHeading(selectionButtons, 'Actions');
      appendQuickPickButton(selectionButtons, 'Finish Job', 'FINISH', 'choice-btn choice-btn--finish');
      appendQuickPickButton(selectionButtons, 'End Shift', 'REASON:END_SHIFT', 'choice-btn choice-btn--out');
    } else {
      appendQuickPickHeading(selectionButtons, 'Actions');
      appendQuickPickButton(selectionButtons, 'End Shift', 'REASON:END_SHIFT', 'choice-btn choice-btn--out');
    }
    return;
  }
  selectionPanel.hidden = true;
  if (selectionButtons) selectionButtons.innerHTML = '';
}

function renderUi() {
  renderEmployeeCard();
  renderAllowedActions();
  renderWorkflowText();
  renderSelectionPanel();
  if (debugLine) debugLine.textContent = ks.lastAction || '';
  if (debugLastAction) debugLastAction.textContent = ks.lastAction || '—';
}

function focusScanner() {
  window.setTimeout(() => {
    if (document.activeElement === manualBarcodeInput) return;
    if (scannerTrap) scannerTrap.focus({ preventScroll: true });
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

function playSuccessBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    function tone(at, freq, dur) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(at);
      o.stop(at + dur);
    }
    tone(now, 880, 0.1);
    tone(now + 0.14, 1100, 0.12);
  } catch (_) {
    /* ignore */
  }
}

function dismissFinishSuccessBanner() {
  if (!finishSuccessBanner) return;
  if (finishSuccessBanner._hideTimer) {
    window.clearTimeout(finishSuccessBanner._hideTimer);
    finishSuccessBanner._hideTimer = null;
  }
  finishSuccessBanner.hidden = true;
}

function showFinishSuccessBanner() {
  if (!finishSuccessBanner) return;
  if (scanWarning) scanWarning.hidden = true;
  if (finishSuccessBanner._hideTimer) {
    window.clearTimeout(finishSuccessBanner._hideTimer);
    finishSuccessBanner._hideTimer = null;
  }
  finishSuccessBanner.hidden = false;
  finishSuccessBanner._hideTimer = window.setTimeout(() => {
    finishSuccessBanner.hidden = true;
    finishSuccessBanner._hideTimer = null;
  }, FINISH_SUCCESS_BANNER_MS);
}

function mapFinishErrorMessage(err) {
  const code = String(err?.errorCode || '');
  if (code === 'no_active_job') return 'No active job to finish';
  if (code === 'stopped') return 'Resume current job before finishing';
  const m = String(err?.message || '');
  if (/no active job/i.test(m)) return 'No active job to finish';
  if (/resume current job/i.test(m)) return 'Resume current job before finishing';
  return m || 'Finish failed.';
}

function showFinishError(message) {
  dismissFinishSuccessBanner();
  showScanWarning(message);
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

async function workAction(body, scanSource) {
  const payload = { ...body };
  if (scanSource) payload.scan_source = scanSource;
  const { res, data } = await apiJson('/api/kiosk/work-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
    const st = String(row.status || 'OUT').toUpperCase();
    const stopLabel = st === 'STOP' && row.stop_reason ? `STOP — ${row.stop_reason}` : null;
    const badgeHtml =
      typeof FactoryStatus !== 'undefined'
        ? stopLabel
          ? FactoryStatus.statusBadgeHtml(st, { label: stopLabel })
          : FactoryStatus.statusScanBadgeHtml(st)
        : `<span class="status-badge ${st === 'IN' ? 'in' : st === 'STOP' ? 'stop' : 'out'}">${stopLabel || st}</span>`;
    const actCell = row.display_activity || row.job_activity || row.note_value || '—';
    const when = row.scanned_at
      ? new Date(row.scanned_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '—';
    tr.innerHTML = `
      <td>${row.employee_name || row.employee_code || '—'}</td>
      <td>${badgeHtml}</td>
      <td>${actCell}</td>
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
  await loadKioskWorkConfig();
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

function applyEmployeeContext(data) {
  ks.employee = data.employee;
  ks.phase = String(data.phase || data.current_status || 'OUT').toUpperCase();
  const waiting = !!data.waiting_for_job;
  ks.activity = waiting ? null : data.current_activity || data.resume_activity || null;
  ks.tank = waiting ? null : data.active_tank_number || data.resume_tank || null;
  ks.stopReason = data.stop_reason || null;
  ks.pendingActivity = null;
  ks.pendingTank = null;
}

async function onEmployeeScanned(code, scanId) {
  const data = await loadEmployee(code, scanId);
  if (!data || scanId !== scanSequenceId) return;

  applyEmployeeContext(data);

  if (isPhaseStop()) {
    try {
      const resumed = await workAction({ employee_code: ks.employee.code, action: 'resume_work' });
      if (scanId !== scanSequenceId) return;
      ks.phase = 'IN';
      ks.activity = resumed.activity || ks.activity;
      ks.tank = resumed.tank_number || ks.tank;
      ks.stopReason = null;
      ks.step = STEP.IN_SELECTED;
      lastSuccessCode = ks.employee.code;
      showToast(resumed.kiosk_message || 'Resumed previous job');
      playSuccessBeep();
      ks.lastAction = `Resumed previous job for ${ks.employee.code}`;
      resetIdleTimer();
      renderUi();
    } catch (err) {
      scheduleErrorReset(err.message || 'Could not resume from STOP.');
    }
    return;
  }

  if (isPhaseOut()) {
    ks.step = STEP.OUT_SELECTED;
    showToast('Employee selected. Scan tank, then activity.');
  } else if (isPhaseIn()) {
    ks.step = STEP.IN_SELECTED;
    showToast(
      isWaitingForJob()
        ? 'Employee selected. Waiting for next job — scan activity, then tank.'
        : 'Employee selected. Scan activity, tank, finish, stop, or out reason.'
    );
  } else {
    ks.step = STEP.OUT_SELECTED;
  }

  ks.lastAction = `Selected ${ks.employee.code} (${ks.phase})`;
  if (data.kiosk_notice) showToast(data.kiosk_notice);
  resetIdleTimer();
  renderUi();
}

async function onTankScanned(tank, scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }

  if (ks.step === STEP.OUT_SELECTED) {
    ks.pendingTank = tank;
    ks.tank = tank;
    ks.step = STEP.OUT_TANK_SELECTED;
    showToast('Tank selected. Scan activity to start work.');
    resetIdleTimer();
    renderUi();
    return;
  }

  if (ks.step === STEP.IN_CHANGE_PENDING && ks.pendingActivity) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'switch_work',
      activity: ks.pendingActivity,
      tank_number: tank,
    });
    if (scanId !== scanSequenceId) return;
    if (data.noop) {
      finishSuccess(data.message || 'Already on this tank.');
      return;
    }
    finishSuccess(`Tank ${data.tank_number} · ${data.activity}`);
    return;
  }

  if (ks.step === STEP.IN_SELECTED) {
    ks.pendingTank = tank;
    ks.step = STEP.IN_CHANGE_PENDING;
    extendChangeContext();
    showToast(`Tank ${tank}. Scan activity for this tank.`);
    renderUi();
    return;
  }

  scheduleErrorReset('Tank not allowed now.');
}

async function onActivityScanned(activityCode, scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }

  if (ks.step === STEP.OUT_TANK_SELECTED) {
    const tank = ks.pendingTank || ks.tank;
    if (!tank) {
      scheduleErrorReset('Scan tank first.');
      return;
    }
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'clock_in',
      activity: activityCode,
      tank_number: tank,
    });
    if (scanId !== scanSequenceId) return;
    ks.phase = 'IN';
    ks.activity = data.activity || formatActivity(activityCode);
    ks.tank = data.tank_number || tank;
    lastSuccessCode = ks.employee.code;
    let msg = `Clocked IN — ${ks.activity} on Tank ${ks.tank}`;
    if (data.kiosk_message) msg += ` — ${data.kiosk_message}`;
    finishSuccess(msg);
    return;
  }

  if (ks.step === STEP.OUT_SELECTED) {
    scheduleErrorReset('Scan tank first.');
    return;
  }

  if (ks.step === STEP.IN_CHANGE_PENDING && ks.pendingTank) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'switch_work',
      activity: activityCode,
      tank_number: ks.pendingTank,
    });
    if (scanId !== scanSequenceId) return;
    if (data.noop) {
      finishSuccess(data.message || 'Already on this activity.');
      return;
    }
    finishSuccess(`${data.activity} · Tank ${data.tank_number}`);
    return;
  }

  if (ks.step === STEP.IN_SELECTED && isWaitingForJob()) {
    ks.pendingActivity = activityCode;
    ks.step = STEP.IN_CHANGE_PENDING;
    extendChangeContext();
    showToast('Scan tank to start next job.');
    renderUi();
    return;
  }

  if (ks.step === STEP.IN_SELECTED) {
    const data = await workAction({
      employee_code: ks.employee.code,
      action: 'switch_activity',
      activity: activityCode,
    });
    if (scanId !== scanSequenceId) return;
    if (data.noop) {
      finishSuccess(data.message || 'Already on this activity.');
      return;
    }
    finishSuccess(`Activity: ${data.activity || formatActivity(activityCode)}`);
    return;
  }

  scheduleErrorReset('Activity not allowed now.');
}

async function onStopScanned(label, scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }
  if (isPhaseOut()) {
    scheduleErrorReset('Employee must be IN before using Stop.');
    return;
  }
  if (ks.step !== STEP.IN_SELECTED && ks.phase !== 'IN') {
    scheduleErrorReset('Employee must be IN before using Stop.');
    return;
  }
  const data = await workAction({
    employee_code: ks.employee.code,
    action: 'enter_stop',
    stop: label,
  });
  if (scanId !== scanSequenceId) return;
  ks.phase = 'STOP';
  ks.stopReason = data.stop_reason || label;
  ks.activity = data.resume_activity || ks.activity;
  ks.tank = data.resume_tank || ks.tank;
  ks.step = STEP.STOP_SELECTED;
  lastSuccessCode = ks.employee.code;
  showToast(ks.stopReason ? `STOP — ${ks.stopReason}` : 'STOP');
  ks.lastAction = `Stop ${ks.employee.code} (${ks.stopReason || '—'})`;
  resetIdleTimer();
  renderUi();
}

async function onFinishScanned(scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }
  if (isPhaseOut()) {
    scheduleErrorReset('Employee is OUT.');
    return;
  }
  if (isPhaseStop()) {
    showFinishError('Resume current job before finishing.');
    return;
  }
  if (!hasActiveJob()) {
    showFinishError('No active job to finish.');
    return;
  }
  let data;
  try {
    data = await workAction(
      {
        employee_code: ks.employee.code,
        action: 'finish_job',
      },
      ks.lastScanSource
    );
  } catch (err) {
    if (scanId !== scanSequenceId) return;
    showFinishError(mapFinishErrorMessage(err));
    return;
  }
  if (scanId !== scanSequenceId) return;
  ks.phase = 'IN';
  ks.activity = null;
  ks.tank = null;
  ks.pendingActivity = null;
  ks.pendingTank = null;
  ks.step = STEP.IN_SELECTED;
  const empCode = ks.employee.code || '';
  lastSuccessCode = empCode;
  ks.lastAction = empCode ? `Finished current job for ${empCode}` : 'Finished current job';
  showFinishSuccessBanner();
  playSuccessBeep();
  resetIdleTimer();
  renderUi();
  void refreshStatusList();
}

async function onReasonScanned(reason, scanId) {
  if (!ks.employee) {
    scheduleErrorReset('Scan employee first.');
    return;
  }
  if (isPhaseOut()) {
    scheduleErrorReset('Employee is already OUT.');
    return;
  }
  const data = await workAction({
    employee_code: ks.employee.code,
    action: 'clock_out',
    reason,
  });
  if (scanId !== scanSequenceId) return;
  ks.phase = 'OUT';
  lastSuccessCode = ks.employee.code;
  let msg = `Clocked out: ${reason}`;
  if (data.kiosk_message) msg += ` — ${data.kiosk_message}`;
  finishSuccess(msg);
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
  ks.lastScanSource = meta && meta.source ? meta.source : 'scanner';
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
        scheduleErrorReset(
          ks.step === STEP.OUT_SELECTED ? 'Scan tank first.' : 'Activity not allowed now.'
        );
        return;
      }
      const actCode = CODE_ALIASES.get(cls.value) || cls.value;
      if (!activityLookup.has(actCode)) {
        scheduleErrorReset('Activity not allowed at this kiosk.');
        return;
      }
      await onActivityScanned(actCode, myScanId);
      return;
    }

    if (cls.type === 'TANK') {
      if (!allowed.tank) {
        scheduleErrorReset(
          ks.step === STEP.OUT_SELECTED
            ? 'Scan tank first.'
            : ks.step === STEP.OUT_TANK_SELECTED
              ? 'Scan activity to start work.'
              : 'Tank not allowed now.'
        );
        return;
      }
      const tank = cls.tank || cls.value;
      await onTankScanned(tank, myScanId);
      return;
    }

    if (cls.type === 'STOP') {
      if (isPhaseStop()) {
        scheduleErrorReset('Scan employee badge to resume.');
        return;
      }
      if (!allowed.stop) {
        scheduleErrorReset(
          hasActiveJob() ? 'Employee must be IN before using Stop.' : 'No active job to pause.'
        );
        return;
      }
      const label = stopLabel(cls.value);
      if (!label) {
        scheduleErrorReset('Unknown stop barcode.');
        return;
      }
      await onStopScanned(label, myScanId);
      return;
    }

    if (cls.type === 'FINISH') {
      if (!allowed.finish) {
        if (isPhaseStop()) showFinishError('Resume current job before finishing.');
        else if (!hasActiveJob()) showFinishError('No active job to finish.');
        else showFinishError('Finish not allowed now.');
        return;
      }
      await onFinishScanned(myScanId);
      return;
    }

    if (cls.type === 'REASON') {
      if (!allowed.reason) {
        scheduleErrorReset(
          isPhaseOut() ? 'Employee is already OUT.' : 'End Shift not allowed now.'
        );
        return;
      }
      const label = reasonLabel(cls.value);
      if (!label) {
        scheduleErrorReset('Unknown End Shift barcode.');
        return;
      }
      await onReasonScanned(label, myScanId);
      return;
    }
  } catch (err) {
    if (myScanId !== scanSequenceId) return;
    console.error('[kiosk scan]', err);
    if (err.errorCode === 'unknown_employee' || err.httpStatus === 404) {
      showEmployeeNotFound(code);
    } else {
      scheduleErrorReset(err.message || 'Scan failed. Try again.');
    }
  } finally {
    ks.isBusy = false;
    scanBuffer = '';
    if (scannerTrap) scannerTrap.value = '';
    if (manualBarcodeInput) manualBarcodeInput.value = '';
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
  if (e.target === manualBarcodeInput) return;
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
