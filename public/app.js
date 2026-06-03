function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function formatClockDate(d = new Date()) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
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

function formatIsoLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${localDateString(d)} ${formatTime(d)}`;
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(v);
}

function formatElapsed(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  if (hh > 0) return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  return `${pad2(mm)}:${pad2(ss)}`;
}

function normalizeScanValue(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, '');
}

function initialsFromName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  const a = parts[0][0] || '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] || '' : parts[0][1] || '';
  return (a + b).toUpperCase().slice(0, 2);
}

const scanInput = document.getElementById('scanInput');
const scanRoot = document.getElementById('scanRoot');
const scanWait = document.getElementById('scanWait');
const scanResult = document.getElementById('scanResult');
const scanPill = document.getElementById('scanPill');
const scanName = document.getElementById('scanName');
const scanCode = document.getElementById('scanCode');
const scanTime = document.getElementById('scanTime');

const clockEl = document.getElementById('clock');
const clockDateEl = document.getElementById('clockDate');
const mTotal = document.getElementById('mTotal');
const mIn = document.getElementById('mIn');
const mOut = document.getElementById('mOut');
const mScansToday = document.getElementById('mScansToday');
const statusBody = document.getElementById('statusBody');
const logsBody = document.getElementById('logsBody');
const lastScanCard = document.getElementById('lastScanCard');
const statusFilter = document.getElementById('statusFilter');
const logsFilter = document.getElementById('logsFilter');

const btnSound = document.getElementById('btnSound');
const logoutBtn = document.getElementById('logoutBtn');

const expStart = document.getElementById('expStart');
const expEnd = document.getElementById('expEnd');
const expDateRow = document.getElementById('expDateRow');
const expEmployeeWrap = document.getElementById('expEmployeeWrap');
const expEmployee = document.getElementById('expEmployee');
const btnExportReport = document.getElementById('btnExportReport');
const exportHint = document.getElementById('exportHint');

const payrollBody = document.getElementById('payrollBody');
const payrollHint = document.getElementById('payrollHint');
const payTotalHours = document.getElementById('payTotalHours');
const payTotalWage = document.getElementById('payTotalWage');
const payAvgHours = document.getElementById('payAvgHours');
const logsChips = document.getElementById('logsChips');

const scanNoteOverlay = document.getElementById('scanNoteOverlay');
const scanNoteDialog = document.getElementById('scanNoteDialog');
const scanNoteDialogBody = document.getElementById('scanNoteDialogBody');
const scanStage = document.getElementById('scanStage');
const scanToast = document.getElementById('scanToast');
const manualScanInput = document.getElementById('manualScanInput');
const btnManualScan = document.getElementById('btnManualScan');
const tankInput = document.getElementById('tankInput');
const btnTankConfirm = document.getElementById('btnTankConfirm');
const tankKeypad = document.getElementById('tankKeypad');

/** @type {(() => void) | null} */
let noteModalResolve = null;
let pendingLogId = null;
let pendingEmployeeName = '';
let noteModalSerial = 0;
/** @type {'IN'|'OUT'|''} */
let pendingSheetKind = '';

/** Shown only on clock-in (WORK). */
const WORK_ACTIVITIES = [
  'Run machine',
  'Assemble',
  'Quality check',
  'Packaging',
  'Material handling',
  'Cutting',
  'Drilling',
  'Polishing',
  'Surface sanding',
  'Welding',
];

/** Shown only on clock-out (REASON). */
const OUT_REASONS = [
  'Break',
  'Lunch',
  'Bathroom',
  'End shift',
  'Machine issue',
  'Waiting material',
  'Maintenance',
  'Setup change',
];

let soundEnabled = false;
/** @type {AudioContext | null} */
let webAudioCtx = null;

/**
 * Short beep via Web Audio API (requires user gesture to unlock).
 * @param {number} frequencyHz
 * @param {'success'|'error'} kind
 */
function playWebBeep(frequencyHz, kind) {
  if (!soundEnabled || !webAudioCtx) return;
  try {
    const ctx = webAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequencyHz, ctx.currentTime);
    const peak = kind === 'success' ? 0.12 : 0.14;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (kind === 'success' ? 0.14 : 0.22));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // ignore
  }
}

function primeWebAudio() {
  if (webAudioCtx) return Promise.resolve(webAudioCtx);
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return Promise.resolve(null);
  webAudioCtx = new Ctx();
  return webAudioCtx.resume().then(() => webAudioCtx);
}
let scanBusy = false;
let resetTimer = null;
let lastLogId = null;
let lastRecordedContext = null;
let lastScanSnapshot = null;
let lastEmployees = [];
let lastLogs = [];
/** @type {'all'|'IN'|'OUT'} */
let logsStatusFilter = 'all';
let highlightEmployeeCode = null;
let highlightTimer = null;
let preferTankFocusNext = false;

function playSuccess() {
  if (!soundEnabled) return;
  playWebBeep(1046.5, 'success');
}

function playError() {
  if (!soundEnabled) return;
  playWebBeep(196, 'error');
}

if (btnSound) {
  btnSound.addEventListener('click', () => {
    soundEnabled = true;
    void primeWebAudio().then(() => {
      playWebBeep(523.25, 'success');
    });
    btnSound.textContent = 'Sound on';
    btnSound.classList.add('is-on');
    btnSound.disabled = true;
    focusScanSoon();
  });
}

function setScanState(kind) {
  scanRoot.classList.remove('state-in', 'state-out', 'state-stop', 'state-err');
  if (kind) scanRoot.classList.add(kind);
}

function pulseFeedbackAnimation() {
  scanResult.classList.remove('is-show');
  void scanResult.offsetWidth;
  scanResult.classList.add('is-show');
}

function showWaiting() {
  setScanState('');
  scanResult.classList.remove('is-show');
  scanWait.classList.remove('is-hidden');
  scanWait.setAttribute('aria-hidden', 'false');
  scanPill.textContent = '';
  scanPill.classList.remove('pill-in', 'pill-out', 'pill-stop', 'pill-err');
  scanName.textContent = '';
  scanCode.textContent = '';
  scanTime.textContent = '';
}

function showResult({ pillText, pillClass, name, codeLine, timeLine, state }) {
  scanPill.textContent = pillText;
  scanPill.classList.remove('pill-in', 'pill-out', 'pill-stop', 'pill-err');
  if (pillClass) scanPill.classList.add(pillClass);
  scanName.textContent = name;
  scanCode.textContent = codeLine || '';
  scanTime.textContent = timeLine || '';

  scanWait.classList.add('is-hidden');
  scanWait.setAttribute('aria-hidden', 'true');
  pulseFeedbackAnimation();
  setScanState(state);
}

function scheduleReset() {
  if (resetTimer) window.clearTimeout(resetTimer);
  resetTimer = window.setTimeout(() => {
    showWaiting();
  }, 2800);
}

async function postScan(code) {
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

async function patchScanLogMeta(logId, noteCategory, noteValue, tankNumber) {
  const body = {};
  if (noteCategory !== undefined || noteValue !== undefined) {
    if (noteCategory == null && noteValue == null) {
      body.note_category = null;
      body.note_value = null;
    } else {
      body.note_category = noteCategory;
      body.note_value = noteValue;
    }
  }
  if (tankNumber !== undefined) body.tank_number = tankNumber;
  const res = await fetch(`/api/scan_logs/${encodeURIComponent(logId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error((j && j.message) || `Note save failed (${res.status})`);
  }
}

function formatNoteDisplay(l) {
  const raw =
    l.note_value != null && String(l.note_value).trim() !== ''
      ? String(l.note_value).trim()
      : l.note
        ? String(l.note).trim()
        : '';
  if (!raw) return '';
  const c = l.note_category;
  if (c === 'WORK' || c === 'REASON') return `${c} · ${raw}`;
  return raw;
}

function showScanToast(msg) {
  if (!scanToast) return;
  scanToast.textContent = msg;
  scanToast.removeAttribute('hidden');
  scanToast.setAttribute('aria-hidden', 'false');
  scanToast.classList.add('scan-toast--visible');
  window.clearTimeout(showScanToast._timer);
  showScanToast._timer = window.setTimeout(() => {
    scanToast.classList.remove('scan-toast--visible');
    scanToast.setAttribute('aria-hidden', 'true');
    scanToast.textContent = '';
    scanToast.setAttribute('hidden', '');
  }, 2600);
}

function flashScanStageSuccess() {
  if (!scanStage) return;
  scanStage.classList.remove('scan-success-flash');
  void scanStage.offsetWidth;
  scanStage.classList.add('scan-success-flash');
  window.setTimeout(() => scanStage.classList.remove('scan-success-flash'), 520);
}

function playNoteConfirmChime() {
  playWebBeep(880, 'success');
}

function workActivityButtonsHtml() {
  return WORK_ACTIVITIES.map(
    (label) =>
      `<button type="button" class="scan-note-btn" data-note-cat="WORK" data-note-val="${escapeHtml(label)}">${escapeHtml(label)}</button>`
  ).join('');
}

function outReasonButtonsHtml() {
  return OUT_REASONS.map(
    (label) =>
      `<button type="button" class="scan-note-btn" data-note-cat="REASON" data-note-val="${escapeHtml(label)}">${escapeHtml(label)}</button>`
  ).join('');
}

function buildOutNoteMarkup(name) {
  const grid = outReasonButtonsHtml();
  return `
<div class="scan-note-sheet scan-note-sheet--out" data-sheet="out">
  <div class="scan-note-head scan-note-head--compact">
    <h2 id="scanNoteHeading" class="scan-note-name">${escapeHtml(name)}</h2>
    <div class="scan-note-badge is-out" aria-hidden="true">OUT</div>
  </div>
  <p class="scan-note-lead scan-note-lead--out">Why are you clocking out?</p>
  <div class="scan-note-grid scan-note-grid--compact" role="group" aria-label="Out reasons">${grid}</div>
  <button type="button" class="scan-note-btn scan-note-btn--wide scan-note-btn--ghost scan-note-btn--sm" id="scanNoteBtnOtherOut">Other reason…</button>
  <div id="scanNoteOtherRowOut" class="scan-note-other scan-note-other--compact is-hidden">
    <label class="sr-only" for="scanNoteOtherInputOut">Other reason (max 20 characters)</label>
    <input id="scanNoteOtherInputOut" type="text" class="scan-note-input scan-note-input--compact" maxlength="20" autocomplete="off" placeholder="Reason (20 max)" />
    <button type="button" class="btn btn-primary scan-note-save scan-note-save--compact" id="scanNoteOtherSaveOut">Save</button>
  </div>
  <button type="button" class="scan-note-skip scan-note-skip--secondary" id="scanNoteSkipOut">Skip — no note</button>
</div>`;
}

function buildInNoteMarkup(name) {
  const grid = workActivityButtonsHtml();
  return `
<div class="scan-note-sheet scan-note-sheet--in" data-sheet="in">
  <div class="scan-note-head scan-note-head--compact">
    <h2 id="scanNoteHeading" class="scan-note-name">${escapeHtml(name)}</h2>
    <div class="scan-note-badge is-in" aria-hidden="true">IN</div>
  </div>
  <p class="scan-note-lead scan-note-lead--in">What are you starting work on?</p>
  <div class="scan-note-grid scan-note-grid--compact" role="group" aria-label="Work activities">${grid}</div>
  <button type="button" class="scan-note-btn scan-note-btn--wide scan-note-btn--ghost scan-note-btn--sm" id="scanNoteBtnOtherIn">Other work…</button>
  <div id="scanNoteOtherRowIn" class="scan-note-other scan-note-other--compact is-hidden">
    <label class="sr-only" for="scanNoteOtherInputIn">Other work (max 20 characters)</label>
    <input id="scanNoteOtherInputIn" type="text" class="scan-note-input scan-note-input--compact" maxlength="20" autocomplete="off" placeholder="Describe (20 max)" />
    <button type="button" class="btn btn-primary scan-note-save scan-note-save--compact" id="scanNoteOtherSaveIn">Save</button>
  </div>
  <button type="button" class="scan-note-skip scan-note-skip--secondary" id="scanNoteSkipIn">Skip — no note</button>
</div>`;
}

function closeScanNoteModal() {
  if (scanNoteOverlay) {
    scanNoteOverlay.classList.remove('is-open');
    scanNoteOverlay.setAttribute('aria-hidden', 'true');
  }
  if (scanNoteDialog) {
    scanNoteDialog.classList.remove('scan-note-dialog--in', 'scan-note-dialog--out');
  }
  if (scanNoteDialogBody) {
    scanNoteDialogBody.innerHTML = '';
    scanNoteDialogBody.removeAttribute('data-modal-key');
  }
  pendingLogId = null;
  pendingEmployeeName = '';
  pendingSheetKind = '';
  const fn = noteModalResolve;
  noteModalResolve = null;
  if (typeof fn === 'function') fn();
}

/**
 * Fresh DOM each open — no reused component state.
 * @param {{ logId: number, name: string, status: string }} p
 */
function openScanNoteModal(p) {
  return new Promise((resolve) => {
    if (!scanNoteOverlay || !scanNoteDialogBody || !scanNoteDialog) {
      resolve();
      return;
    }
    noteModalResolve = resolve;
    pendingLogId = p.logId;
    pendingEmployeeName = p.name || '';
    pendingSheetKind = p.status === 'IN' ? 'IN' : 'OUT';
    noteModalSerial += 1;
    const key = `${p.logId}-${noteModalSerial}-${p.status}`;
    scanNoteDialogBody.dataset.modalKey = key;

    if (p.status === 'IN') {
      scanNoteDialogBody.innerHTML = buildInNoteMarkup(p.name);
      scanNoteDialog.classList.remove('scan-note-dialog--out');
      scanNoteDialog.classList.add('scan-note-dialog--in');
    } else {
      scanNoteDialogBody.innerHTML = buildOutNoteMarkup(p.name);
      scanNoteDialog.classList.remove('scan-note-dialog--in');
      scanNoteDialog.classList.add('scan-note-dialog--out');
    }

    scanNoteOverlay.classList.add('is-open');
    scanNoteOverlay.setAttribute('aria-hidden', 'false');

    window.setTimeout(() => {
      try {
        if (p.status === 'IN') {
          document.querySelector('.scan-note-sheet--in .scan-note-btn[data-note-val]')?.focus();
        } else {
          document.querySelector('.scan-note-sheet--out .scan-note-btn[data-note-val]')?.focus();
        }
      } catch {
        /* ignore */
      }
    }, 40);
  });
}

async function finalizeScanNote(category, value, toastMsg) {
  const id = pendingLogId;
  if (id == null || !category || !value) {
    playError();
    showScanToast('Could not save note. Please try again.');
    return;
  }
  try {
    await patchScanLogMeta(id, category, value);
  } catch {
    playError();
    showScanToast('Could not save note. Please check connection and retry.');
    return;
  }
  flashScanStageSuccess();
  playNoteConfirmChime();
  showScanToast(toastMsg || 'Saved.');
  lastRecordedContext = {
    logId: id,
    employeeName: pendingEmployeeName || '',
    status: pendingSheetKind || '',
    activity: value || '-',
  };
  window.setTimeout(() => closeScanNoteModal(), 140);
}

async function finalizeSkipScanNote() {
  const id = pendingLogId;
  const emp = pendingEmployeeName || '';
  const kind = pendingSheetKind;
  if (id != null) {
    try {
      await patchScanLogMeta(id, null, null);
    } catch {
      /* ignore */
    }
  }
  flashScanStageSuccess();
  showScanToast(kind === 'IN' ? `${emp} IN` : `${emp} OUT`);
  lastRecordedContext = {
    logId: id,
    employeeName: emp,
    status: kind,
    activity: '-',
  };
  window.setTimeout(() => closeScanNoteModal(), 90);
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data && data.message ? data.message : 'Request failed');
  return data;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusBadgeFor(value, options) {
  if (typeof FactoryStatus !== 'undefined') return FactoryStatus.statusBadgeHtml(value, options);
  const st = String(value || '').toUpperCase();
  const cls = st === 'IN' ? 'badge-in' : st === 'STOP' ? 'badge-stop' : st === 'ERROR' ? 'badge-err' : 'badge-out';
  const lg = options && options.large ? ' badge-lg' : '';
  return `<span class="badge${lg} ${cls}">${st || 'OUT'}</span>`;
}

function renderLastScan(log) {
  if (!log) {
    lastScanCard.innerHTML = '<div class="muted" style="font-weight:700">No scans yet.</div>';
    return;
  }
  const meta = typeof FactoryStatus !== 'undefined' ? FactoryStatus.statusMeta(log.status) : null;
  const badgeClass = meta ? meta.badgeClass : log.status === 'IN' ? 'badge-in' : 'badge-out';
  const avClass = meta ? meta.avatarClass : log.status === 'IN' ? 'is-in' : 'is-out';
  const ini = initialsFromName(log.employee_name);
  const nd = formatNoteDisplay(log);
  const noteLine = nd ? `<div class="last-scan-note">${escapeHtml(nd)}</div>` : '';
  lastScanCard.innerHTML = `
    <div class="last-scan-shell">
      <div class="last-scan-avatar ${avClass}" aria-hidden="true">${escapeHtml(ini)}</div>
      <div class="last-scan-main">
        <h3 class="last-scan-name">${escapeHtml(log.employee_name)}</h3>
        <div class="last-scan-code">${escapeHtml(log.employee_code)}</div>
        <div class="last-scan-meta">
          <span class="badge badge-lg ${badgeClass}">${log.status}</span>
          <span class="last-scan-time">${escapeHtml(formatDisplayDateTime(log.scanned_at))}</span>
        </div>
        ${noteLine}
      </div>
    </div>
  `;
}

function filterQuery() {
  return (statusFilter && statusFilter.value ? statusFilter.value : '').trim().toLowerCase();
}

function logsQuery() {
  return (logsFilter && logsFilter.value ? logsFilter.value : '').trim().toLowerCase();
}

function renderStatusTable() {
  const q = filterQuery();
  const employees = lastEmployees
    .filter((e) => {
      if (!q) return true;
      return e.code.toLowerCase().includes(q) || e.name.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const rows = employees
    .map((e) => {
      const active = e.is_active ? '<span class="badge badge-in">Active</span>' : '<span class="badge badge-muted">Inactive</span>';
      const st = e.is_active ? statusBadgeFor(e.current_status) : '<span class="badge badge-muted">—</span>';
      const daily = Number.isFinite(Number(e.daily_hours)) ? Number(e.daily_hours).toFixed(2) : '0.00';
      const elapsed =
        e.current_status === 'STOP' && e.elapsed_paused
          ? `${formatElapsed(e.elapsed_seconds || 0)} (paused)`
          : e.currently_working && e.current_session_start
            ? formatElapsed(e.elapsed_seconds || 0)
            : '—';
      const last = e.is_active ? formatDisplayDateTime(e.last_scan_at) : '—';
      const rowHi = highlightEmployeeCode && e.code === highlightEmployeeCode ? ' row-employee-updated' : '';
      return `<tr class="${rowHi}">
        <td><strong>${escapeHtml(e.code)}</strong></td>
        <td>${escapeHtml(e.name)}</td>
        <td>${active}</td>
        <td>${st}</td>
        <td class="td-num">${escapeHtml(daily)}</td>
        <td class="muted td-time">${escapeHtml(elapsed)}</td>
        <td class="muted td-time">${escapeHtml(last)}</td>
      </tr>`;
    })
    .join('');

  statusBody.innerHTML =
    rows || `<tr><td colspan="7" class="muted">${q ? 'No matches for this filter.' : 'No employees yet.'}</td></tr>`;
}

function renderLogsTable() {
  const q = logsQuery();
  const logs = lastLogs.filter((l) => {
    if (logsStatusFilter !== 'all' && l.status !== logsStatusFilter) return false;
    if (!q) return true;
    return (
      l.employee_code.toLowerCase().includes(q) ||
      l.employee_name.toLowerCase().includes(q) ||
      String(l.status).toLowerCase().includes(q) ||
      (l.note && String(l.note).toLowerCase().includes(q)) ||
      (l.note_value && String(l.note_value).toLowerCase().includes(q)) ||
      (l.note_category && String(l.note_category).toLowerCase().includes(q))
    );
  });

  const body = logs
    .map((l) => {
      const badgeMeta = typeof FactoryStatus !== 'undefined' ? FactoryStatus.statusMeta(l.status) : null;
      const badge = badgeMeta ? badgeMeta.badgeClass : l.status === 'IN' ? 'badge-in' : 'badge-out';
      const hi = lastLogId && l.id === lastLogId ? ' row-highlight' : '';
      const nd = formatNoteDisplay(l);
      const noteCell = nd ? `<span class="log-note-pill">${escapeHtml(nd)}</span>` : '<span class="muted">—</span>';
      return `<tr class="${hi}">
        <td class="muted">${escapeHtml(formatDisplayDateTime(l.scanned_at))}</td>
        <td><strong>${escapeHtml(l.employee_code)}</strong></td>
        <td>${escapeHtml(l.employee_name)}</td>
        <td><span class="badge ${badge}">${l.status}</span></td>
        <td class="td-note">${noteCell}</td>
      </tr>`;
    })
    .join('');

  logsBody.innerHTML =
    body || `<tr><td colspan="5" class="muted">${q ? 'No log lines match this filter.' : 'No logs yet.'}</td></tr>`;
}

function renderPayrollFromData(p) {
  if (!payrollBody || !payTotalHours || !payTotalWage || !payrollHint) return;
  if (!p || !p.rows) {
    payTotalHours.textContent = '0';
    payTotalWage.textContent = formatMoney(0);
    if (payAvgHours) payAvgHours.textContent = '0';
    payrollBody.innerHTML = '<tr><td colspan="4" class="muted">Payroll unavailable.</td></tr>';
    payrollHint.textContent = 'Could not load payroll.';
    return;
  }

  payTotalHours.textContent = String(p.total_hours_rounded ?? 0);
  payTotalWage.textContent = formatMoney(p.total_payroll ?? 0);
  if (payAvgHours) {
    const avg = p.average_hours_per_employee;
    payAvgHours.textContent =
      avg != null && Number.isFinite(Number(avg)) ? Number(avg).toFixed(1) : '0';
  }

  const rows = p.rows || [];
  const maxWage = rows.reduce((m, r) => Math.max(m, Number(r.wage) || 0), 0);
  const body = rows
    .map((r) => {
      const w = Number(r.wage) || 0;
      const hi = maxWage > 0 && w >= maxWage * 0.85 ? ' row-wage-high' : '';
      return `<tr class="${hi}">
        <td><strong>${escapeHtml(r.employee_name)}</strong></td>
        <td class="td-num">${escapeHtml(String(r.hours_rounded))}</td>
        <td class="td-num">${escapeHtml(formatMoney(r.hourly_rate))}</td>
        <td class="td-num">${escapeHtml(formatMoney(r.wage))}</td>
      </tr>`;
    })
    .join('');

  payrollBody.innerHTML =
    body || `<tr><td colspan="4" class="muted">No employees on file.</td></tr>`;
  payrollHint.textContent = `Rounding: ${p.rounding} whole hours · Date ${p.date} (server local).`;
}

async function refreshDashboard() {
  let status;
  let logs;
  try {
    [status, logs] = await Promise.all([getJson('/api/status'), getJson('/api/logs?limit=80')]);
  } catch (err) {
    console.error('[dashboard] refresh status/logs failed', err);
    return;
  }

  let payroll = null;
  try {
    payroll = await getJson('/api/payroll/today');
  } catch {
    payroll = null;
  }
  renderPayrollFromData(payroll);

  const emps = status.employees || [];
  const active = emps.filter((e) => e.is_active);
  const ins = active.filter((e) => e.current_status === 'IN').length;
  const outs = active.filter((e) => e.current_status === 'OUT').length;

  mTotal.textContent = String(emps.length);
  mIn.textContent = String(ins);
  mOut.textContent = String(outs);
  mScansToday.textContent = String(Number(status.scans_today || 0));

  lastEmployees = emps;
  lastLogs = logs.logs || [];

  populateExportEmployees(emps);
  renderStatusTable();
  renderLogsTable();

  const newest = lastLogs[0];
  if (newest && (!lastScanSnapshot || lastScanSnapshot.id !== newest.id)) {
    lastScanSnapshot = newest;
  }
  if (lastLogs[0]) renderLastScan(lastLogs[0]);
}

function focusScanSoon() {
  window.setTimeout(() => {
    try {
      scanInput.focus({ preventScroll: true });
    } catch {
      scanInput.focus();
    }
  }, 0);
}

function focusTankSoon() {
  if (!tankInput) return;
  window.setTimeout(() => {
    try {
      tankInput.focus({ preventScroll: true });
      tankInput.select();
    } catch {
      tankInput.focus();
      tankInput.select();
    }
  }, 0);
}

document.addEventListener('click', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable="true"], .tank-panel .btn')) return;
  const a = e.target.closest('a[href]');
  if (a && a.getAttribute('href') !== '#') return;
  focusScanSoon();
});

function populateExportEmployees(employees) {
  if (!expEmployee) return;
  const prev = expEmployee.value;
  expEmployee.innerHTML = '<option value="all">All workers</option>';
  const sorted = employees
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const e of sorted) {
    const o = document.createElement('option');
    o.value = e.code;
    o.textContent = `${e.name} (${e.code})`;
    expEmployee.appendChild(o);
  }
  const ok = [...expEmployee.options].some((o) => o.value === prev);
  expEmployee.value = ok ? prev : 'all';
  syncWorkerExportUi();
}

function syncExportScopeUi() {
  const scope = document.querySelector('input[name="expScope"]:checked');
  const v = scope ? scope.value : 'today';
  if (expDateRow) {
    expDateRow.classList.toggle('is-hidden', v !== 'range');
  }
}

function syncWorkerExportUi() {
  syncExportScopeUi();
  const wm = document.querySelector('input[name="expWorkerMode"]:checked');
  const mode = wm ? wm.value : 'all';
  if (expEmployeeWrap) {
    expEmployeeWrap.classList.toggle('is-hidden', mode !== 'single');
    expEmployeeWrap.setAttribute('aria-hidden', mode !== 'single' ? 'true' : 'false');
  }
  if (expEmployee) {
    expEmployee.disabled = mode !== 'single';
    if (mode === 'single') {
      if (expEmployee.value === 'all' && expEmployee.options.length > 1) {
        expEmployee.selectedIndex = 1;
      }
    }
  }
}

function buildExportQueryParams() {
  const format = document.querySelector('input[name="expFormat"]:checked')?.value || 'csv';
  const scope = document.querySelector('input[name="expScope"]:checked')?.value || 'today';
  const workerMode = document.querySelector('input[name="expWorkerMode"]:checked')?.value || 'all';
  let employee = 'all';
  if (workerMode === 'single' && expEmployee) {
    employee = expEmployee.value || 'all';
  }
  const p = new URLSearchParams({ format, scope, employee });
  if (scope === 'range') {
    if (expStart) p.set('start', expStart.value);
    if (expEnd) p.set('end', expEnd.value);
  }
  return p;
}

async function runUnifiedExport() {
  if (!btnExportReport) return;
  const scope = document.querySelector('input[name="expScope"]:checked')?.value || 'today';
  const workerMode = document.querySelector('input[name="expWorkerMode"]:checked')?.value || 'all';
  if (scope === 'range' && (!expStart || !expEnd || !expStart.value || !expEnd.value)) {
    exportHint.textContent = 'Choose start and end dates for a date range export.';
    return;
  }
  if (workerMode === 'single' && expEmployee && expEmployee.value === 'all') {
    exportHint.textContent = 'Select an employee, or switch back to all workers.';
    return;
  }

  const params = buildExportQueryParams();
  const url = `/api/export?${params.toString()}`;
  const labelEl = btnExportReport.querySelector('.btn-export-label');
  const prevLabel = labelEl ? labelEl.textContent : '';
  btnExportReport.disabled = true;
  btnExportReport.classList.add('is-loading');
  btnExportReport.setAttribute('aria-busy', 'true');
  if (labelEl) labelEl.textContent = 'Preparing report…';
  exportHint.textContent = 'Preparing report…';
  try {
    const res = await fetch(url);
    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      exportHint.textContent = (j && j.message) || `Export failed (${res.status}).`;
      return;
    }
    if (ct.includes('application/json')) {
      exportHint.textContent = 'Unexpected response from server.';
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
    exportHint.textContent =
      blob.size === 0
        ? `Empty ${fmt.toUpperCase()} — no matching log rows.`
        : 'Download started.';
  } catch {
    exportHint.textContent = 'Network error — try again.';
  } finally {
    btnExportReport.disabled = false;
    btnExportReport.classList.remove('is-loading');
    btnExportReport.setAttribute('aria-busy', 'false');
    if (labelEl) labelEl.textContent = prevLabel || 'Export Report';
    focusScanSoon();
  }
}

window.addEventListener('load', () => {
  if (expStart) expStart.value = localDateString();
  if (expEnd) expEnd.value = localDateString();
  exportHint.textContent = 'Choose format, date scope, and workers — then Export Report.';
  syncWorkerExportUi();
  syncLogFilterChips();
  showWaiting();
  focusScanSoon();
  tickClock();
  window.setInterval(tickClock, 1000);
  window.setInterval(() => {
    refreshDashboard().catch(() => {});
  }, 3500);
  refreshDashboard().catch(() => {});
});

function tickClock() {
  const now = new Date();
  if (clockDateEl) clockDateEl.textContent = formatClockDate(now);
  clockEl.textContent = formatTime(now);
  for (const e of lastEmployees) {
    if (e && e.currently_working && e.current_session_start && !e.elapsed_paused) {
      const ms = Date.now() - new Date(e.current_session_start).getTime();
      e.elapsed_seconds = Math.max(0, Math.floor(ms / 1000));
    } else if (e && !e.elapsed_paused) {
      e.elapsed_seconds = e.elapsed_seconds || 0;
    }
  }
  renderStatusTable();
}

function triggerScanFromCode(rawValue) {
  const code = normalizeScanValue(rawValue);
  if (!code || scanBusy) return;
  void handleScan(code);
}

if (scanInput) {
  scanInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = scanInput.value;
      scanInput.value = '';
      triggerScanFromCode(code);
    }
  });
}

if (statusFilter) {
  statusFilter.addEventListener('input', () => renderStatusTable());
}
if (logsFilter) {
  logsFilter.addEventListener('input', () => renderLogsTable());
}

function syncLogFilterChips() {
  if (!logsChips) return;
  const buttons = logsChips.querySelectorAll('[data-log-filter]');
  buttons.forEach((btn) => {
    const v = btn.getAttribute('data-log-filter');
    btn.classList.toggle('chip-active', v === logsStatusFilter);
  });
}

if (logsChips) {
  logsChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-log-filter]');
    if (!btn) return;
    const v = btn.getAttribute('data-log-filter');
    if (v === 'all' || v === 'IN' || v === 'OUT' || v === 'STOP') {
      logsStatusFilter = v;
      syncLogFilterChips();
      renderLogsTable();
    }
  });
}

async function handleScan(code) {
  scanBusy = true;
  preferTankFocusNext = false;
  try {
    const { ok, data } = await postScan(code);
    if (ok && data && data.ok) {
      lastLogId = data.log_id || null;
      const st = data.status;
      const emp = data.employee;
      const scanMeta = typeof FactoryStatus !== 'undefined' ? FactoryStatus.statusMeta(st) : null;
      highlightEmployeeCode = emp.code;
      window.clearTimeout(highlightTimer);
      highlightTimer = window.setTimeout(() => {
        highlightEmployeeCode = null;
        renderStatusTable();
      }, 12000);
      showResult({
        pillText: st,
        pillClass: scanMeta ? scanMeta.pillClass : st === 'IN' ? 'pill-in' : 'pill-out',
        name: emp.name,
        codeLine: `Badge ${emp.code}`,
        timeLine: formatDisplayDateTime(data.scanned_at),
        state: typeof FactoryStatus !== 'undefined' ? FactoryStatus.scanStateClass(st) : st === 'IN' ? 'state-in' : 'state-out',
      });
      playSuccess();
      const lid = Number(data.log_id);
      if (Number.isFinite(lid) && lid > 0 && scanNoteOverlay) {
        await openScanNoteModal({
          logId: lid,
          name: emp.name,
          status: st,
        });
      }
      preferTankFocusNext = true;
      showScanToast('Scan saved. Enter tank number and press Enter.');
      scheduleReset();
      await refreshDashboard().catch(() => {});
    } else {
      const msg =
        (data && data.error === 'unknown_employee' && 'Unknown barcode.') ||
        (data && data.error === 'inactive_employee' && 'Employee is inactive.') ||
        (data && data.error === 'employee_stopped' && 'Employee is on STOP. Use the kiosk to resume or clock out.') ||
        (data && data.message) ||
        'Invalid scan.';
      showResult({
        pillText: 'INVALID',
        pillClass: 'pill-err',
        name: msg,
        codeLine: code ? `Scanned value · ${code}` : '',
        timeLine: '',
        state: 'state-err',
      });
      playError();
      scheduleReset();
    }
  } catch {
    showResult({
      pillText: 'ERROR',
      pillClass: 'pill-err',
      name: 'Network or server error.',
      codeLine: '',
      timeLine: 'Check connection and try again.',
      state: 'state-err',
    });
    playError();
    scheduleReset();
  } finally {
    scanBusy = false;
    if (preferTankFocusNext) focusTankSoon();
    else focusScanSoon();
  }
}

window.addEventListener('focus', () => focusScanSoon());

document.querySelectorAll('input[name="expScope"]').forEach((el) => {
  el.addEventListener('change', () => syncWorkerExportUi());
});
document.querySelectorAll('input[name="expWorkerMode"]').forEach((el) => {
  el.addEventListener('change', () => syncWorkerExportUi());
});

if (btnExportReport) {
  btnExportReport.addEventListener('click', () => void runUnifiedExport());
}

if (btnManualScan) {
  btnManualScan.addEventListener('click', () => {
    if (!manualScanInput) return;
    const raw = manualScanInput.value;
    manualScanInput.value = '';
    triggerScanFromCode(raw);
  });
}

if (manualScanInput) {
  manualScanInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = manualScanInput.value;
    manualScanInput.value = '';
    triggerScanFromCode(raw);
  });
}

function confirmTankNumber() {
  if (!tankInput) return;
  const value = String(tankInput.value || '').replace(/[^\d]/g, '').slice(0, 12);
  if (!value) {
    playError();
    showScanToast('Enter a tank number.');
    focusTankSoon();
    return;
  }
  const id = (lastRecordedContext && lastRecordedContext.logId) || lastLogId;
  const worker = lastRecordedContext && lastRecordedContext.employeeName ? lastRecordedContext.employeeName : 'EMP';
  const status = lastRecordedContext && lastRecordedContext.status ? lastRecordedContext.status : '';
  const activity = lastRecordedContext && lastRecordedContext.activity ? lastRecordedContext.activity : '-';
  const done = () => {
    tankInput.value = '';
    flashScanStageSuccess();
    playNoteConfirmChime();
    showScanToast(`Recorded: ${worker} ${status} ${activity} Tank ${value}`);
    focusScanSoon();
  };
  if (!id) {
    done();
    return;
  }
  void patchScanLogMeta(id, undefined, undefined, value)
    .then(() => done())
    .catch(() => {
      playError();
      showScanToast('Could not save tank number. Retry.');
      focusTankSoon();
    });
}

if (btnTankConfirm) {
  btnTankConfirm.addEventListener('click', () => confirmTankNumber());
}

if (tankInput) {
  tankInput.addEventListener('input', () => {
    tankInput.value = String(tankInput.value || '').replace(/[^\d]/g, '').slice(0, 12);
  });
  tankInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    confirmTankNumber();
  });
}

if (tankKeypad) {
  tankKeypad.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !tankInput) return;
    const key = btn.getAttribute('data-tank-key');
    const action = btn.getAttribute('data-tank-action');
    if (key && /^\d$/.test(key)) {
      const next = `${tankInput.value || ''}${key}`.replace(/[^\d]/g, '').slice(0, 12);
      tankInput.value = next;
      focusTankSoon();
      return;
    }
    if (action === 'clear') {
      tankInput.value = '';
      focusTankSoon();
      return;
    }
    if (action === 'back') {
      tankInput.value = String(tankInput.value || '').slice(0, -1);
      focusTankSoon();
    }
  });
}

function bindScanNoteInteraction() {
  if (!scanNoteOverlay || scanNoteOverlay.dataset.bound === '1') return;
  scanNoteOverlay.dataset.bound = '1';

  scanNoteOverlay.addEventListener('click', (e) => {
    if (e.target === scanNoteOverlay) {
      void finalizeSkipScanNote();
      return;
    }

    const emp = pendingEmployeeName || 'Employee';

    const otherOut = e.target.closest('#scanNoteBtnOtherOut');
    if (otherOut) {
      document.getElementById('scanNoteOtherRowOut')?.classList.remove('is-hidden');
      window.setTimeout(() => document.getElementById('scanNoteOtherInputOut')?.focus(), 25);
      return;
    }

    const otherIn = e.target.closest('#scanNoteBtnOtherIn');
    if (otherIn) {
      document.getElementById('scanNoteOtherRowIn')?.classList.remove('is-hidden');
      window.setTimeout(() => document.getElementById('scanNoteOtherInputIn')?.focus(), 25);
      return;
    }

    const saveOtherOut = e.target.closest('#scanNoteOtherSaveOut');
    if (saveOtherOut) {
      const inp = document.getElementById('scanNoteOtherInputOut');
      const v = inp ? String(inp.value || '').trim().slice(0, 20) : '';
      if (v) void finalizeScanNote('REASON', v, `${emp} OUT — REASON · ${v}`);
      else void finalizeSkipScanNote();
      return;
    }

    const saveOtherIn = e.target.closest('#scanNoteOtherSaveIn');
    if (saveOtherIn) {
      const inp = document.getElementById('scanNoteOtherInputIn');
      const v = inp ? String(inp.value || '').trim().slice(0, 20) : '';
      if (v) void finalizeScanNote('WORK', v, `${emp} IN — WORK · ${v}`);
      else void finalizeSkipScanNote();
      return;
    }

    if (e.target.closest('#scanNoteSkipIn') || e.target.closest('#scanNoteSkipOut')) {
      void finalizeSkipScanNote();
      return;
    }

    const preset = e.target.closest('[data-note-cat][data-note-val]');
    if (preset && preset.closest('.scan-note-sheet--in')) {
      const v = preset.getAttribute('data-note-val');
      if (v) void finalizeScanNote('WORK', v, `${emp} IN — WORK · ${v}`);
      return;
    }

    if (preset && preset.closest('.scan-note-sheet--out')) {
      const v = preset.getAttribute('data-note-val');
      if (v) void finalizeScanNote('REASON', v, `${emp} OUT — REASON · ${v}`);
    }
  });

  scanNoteOverlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = /** @type {HTMLElement} */ (e.target);
    const outIn = document.getElementById('scanNoteOtherInputOut');
    const inIn = document.getElementById('scanNoteOtherInputIn');
    const emp = pendingEmployeeName || 'Employee';
    if (t === outIn) {
      e.preventDefault();
      const v = outIn ? String(outIn.value || '').trim().slice(0, 20) : '';
      if (v) void finalizeScanNote('REASON', v, `${emp} OUT — REASON · ${v}`);
      else void finalizeSkipScanNote();
    } else if (t === inIn) {
      e.preventDefault();
      const v = inIn ? String(inIn.value || '').trim().slice(0, 20) : '';
      if (v) void finalizeScanNote('WORK', v, `${emp} IN — WORK · ${v}`);
      else void finalizeSkipScanNote();
    }
  });
}

bindScanNoteInteraction();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && scanNoteOverlay?.classList.contains('is-open')) {
    e.preventDefault();
    void finalizeSkipScanNote();
  }
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    window.location.href = '/login';
  });
}
