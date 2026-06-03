'use strict';

const hdrProjectNo = document.getElementById('hdrProjectNo');
const hdrReportId = document.getElementById('hdrReportId');
const qaToast = document.getElementById('qaToast');
const btnNew = document.getElementById('btnNew');
const btnCsv = document.getElementById('btnCsv');
const btnPrint = document.getElementById('btnPrint');
const btnExitKiosk = document.getElementById('btnExitKiosk');
const qaScannerTrap = document.getElementById('qaScannerTrap');
const qaManualScan = document.getElementById('qaManualScan');
const qaScanBtn = document.getElementById('qaScanBtn');
const qaLastScan = document.getElementById('qaLastScan');

const SCAN_TIMEOUT_MS = 50;
const SCAN_FOCUS_INTERVAL_MS = 800;

let scanBuffer = '';
let lastKeyTime = 0;
let scanTimer = null;

const FIELD_IDS = [
  'projectName',
  'projectNo',
  'reportId',
  'diameter',
  'signedBy',
  'signDate',
  'scannedBarcode',
  'scannedTank',
  'domesNotes',
  'shellsNotes',
  'summaryNotes',
  'listsNotes',
];

function makeReportId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `QA-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function todayIsoDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readFormState() {
  /** @type {Record<string, string>} */
  const data = {};
  for (const id of FIELD_IDS) {
    const el = document.getElementById(id);
    data[id] = el ? String(el.value || '').trim() : '';
  }
  return data;
}

function writeFormState(data) {
  for (const id of FIELD_IDS) {
    const el = document.getElementById(id);
    if (el) el.value = data[id] || '';
  }
  syncHeader();
  updateLastScanDisplay(data.scannedBarcode || '');
}

function defaultFormState() {
  const reportId = makeReportId();
  return {
    projectName: '',
    projectNo: '',
    reportId,
    diameter: '',
    signedBy: '',
    signDate: todayIsoDate(),
    scannedBarcode: '',
    scannedTank: '',
    domesNotes: '',
    shellsNotes: '',
    summaryNotes: '',
    listsNotes: '',
  };
}

function syncHeader() {
  const data = readFormState();
  if (hdrProjectNo) hdrProjectNo.textContent = data.projectNo || '—';
  if (hdrReportId) hdrReportId.textContent = data.reportId || '—';
}

function showToast(message) {
  if (!qaToast) return;
  qaToast.textContent = message;
  qaToast.classList.add('show');
  window.setTimeout(() => qaToast.classList.remove('show'), 2600);
}

function setActiveTab(tabName) {
  document.querySelectorAll('.qa-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.qa-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.getAttribute('data-panel') === tabName);
  });
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv() {
  const data = readFormState();
  const rows = [
    ['Field', 'Value'],
    ['projectNo', data.projectNo],
    ['scannedTank', data.scannedTank],
    ['reportId', data.reportId],
    ['projectName', data.projectName],
    ['diameter', data.diameter],
    ['scannedBarcode', data.scannedBarcode],
    ['signedBy', data.signedBy],
    ['signDate', data.signDate],
    ['domesNotes', data.domesNotes],
    ['shellsNotes', data.shellsNotes],
    ['summaryNotes', data.summaryNotes],
    ['listsNotes', data.listsNotes],
  ];
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(data.reportId || 'qa-report').replace(/[^\w.-]+/g, '_')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('CSV exported.');
}

function clearForm() {
  writeFormState(defaultFormState());
  setActiveTab('project');
  if (qaManualScan) qaManualScan.value = '';
  showToast('New QA report started.');
  focusQaScanner();
}

function bindInputs() {
  for (const id of FIELD_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', syncHeader);
    el.addEventListener('change', syncHeader);
  }
}

function normalizeBarcode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/['"]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9_:-]/g, '');
}

function parsePrefixed(code, prefix) {
  const n = String(code || '').toUpperCase();
  if (n.startsWith(`${prefix}:`)) return n.slice(prefix.length + 1);
  if (n.startsWith(`${prefix}_`)) return n.slice(prefix.length + 1);
  return null;
}

/**
 * QA/QC-only barcode classification (no employee / labor scan).
 * @returns {{ type: string, value: string, tank?: string, raw: string } | null}
 */
function classifyQaBarcode(raw) {
  const code = normalizeBarcode(raw);
  if (!code || code.length < 2) return null;

  const workOrder = parsePrefixed(code, 'WORKORDER');
  if (workOrder) return { type: 'PROJECT', value: workOrder, raw: code };

  const project = parsePrefixed(code, 'PROJECT');
  if (project) return { type: 'PROJECT', value: project, raw: code };

  if (/^EMP\d{3}$/.test(code)) return null;

  const tankPref = parsePrefixed(code, 'TANK');
  if (tankPref) return { type: 'TANK', value: tankPref, tank: tankPref, raw: code };

  if (code.startsWith('TANK_')) {
    const t = code.slice(5);
    if (t) return { type: 'TANK', value: t, tank: t, raw: code };
  }

  if (/^\d+$/.test(code)) {
    return { type: 'TANK', value: code, tank: code, raw: code };
  }

  if (/^[A-Z0-9][A-Z0-9-]*$/.test(code) && !code.startsWith('CMD') && !/^EMP\d{3}$/.test(code)) {
    return { type: 'TANK', value: code, tank: code, raw: code };
  }

  return { type: 'UNKNOWN', value: code, raw: code };
}

function updateLastScanDisplay(raw) {
  if (!qaLastScan) return;
  const data = readFormState();
  if (!raw && !data.scannedBarcode) {
    qaLastScan.textContent = 'Last scan: —';
    return;
  }
  const parts = [];
  if (data.scannedBarcode) parts.push(data.scannedBarcode);
  if (data.scannedTank) parts.push(`Tank ${data.scannedTank}`);
  if (data.projectNo) parts.push(`Project ${data.projectNo}`);
  qaLastScan.textContent = `Last scan: ${parts.join(' · ') || raw}`;
}

async function lookupTankDescription(tankNumber) {
  try {
    const res = await fetch(`/api/tanks?search=${encodeURIComponent(tankNumber)}&status=active`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const tanks = data.tanks || [];
    const exact = tanks.find((t) => String(t.tank_number || '').toUpperCase() === tankNumber.toUpperCase());
    return exact || tanks[0] || null;
  } catch {
    return null;
  }
}

function projectNameFromTankRow(row, tankNumber) {
  if (!row) return '';
  const desc = row.description != null ? String(row.description).trim() : '';
  if (desc) return desc;
  return '';
}

async function applyQaScan(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return;

  const cls = classifyQaBarcode(trimmed);
  if (!cls) {
    showToast('Unrecognized barcode.');
    return;
  }

  const state = readFormState();
  state.scannedBarcode = cls.raw;

  if (cls.type === 'PROJECT') {
    state.projectNo = cls.value;
    state.scannedTank = state.scannedTank || '';
    if (!state.projectName && cls.value.includes('-')) {
      const prefix = cls.value.split('-')[0];
      if (prefix && /^\d{4}$/.test(prefix)) {
        state.projectName = `${prefix} Series`;
      }
    }
    writeFormState(state);
    updateLastScanDisplay(cls.raw);
    showToast(`Project loaded: ${cls.value}`);
    return;
  }

  if (cls.type === 'TANK') {
    const tank = cls.tank || cls.value;
    state.scannedTank = tank;
    const tankRow = await lookupTankDescription(tank);
    const desc = projectNameFromTankRow(tankRow, tank);
    if (desc) state.projectName = desc;
    if (!state.projectNo) state.projectNo = tank;
    writeFormState(state);
    updateLastScanDisplay(cls.raw);
    showToast(desc ? `Tank ${tank} — ${desc}` : `Tank ${tank} scanned.`);
    return;
  }

  state.projectNo = cls.value;
  writeFormState(state);
  updateLastScanDisplay(cls.raw);
  showToast(`Scanned: ${cls.value}`);
}

function isEditableField(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  if (el.id === 'qaScannerTrap' || el.id === 'qaManualScan') return false;
  return true;
}

function focusQaScanner() {
  if (document.activeElement === qaManualScan) return;
  if (isEditableField(document.activeElement)) return;
  if (qaScannerTrap) qaScannerTrap.focus({ preventScroll: true });
}

function processManualScanInput() {
  if (!qaManualScan) return;
  const raw = qaManualScan.value;
  qaManualScan.value = '';
  void applyQaScan(raw);
  focusQaScanner();
}

function onDocumentKeydown(e) {
  if (isEditableField(e.target)) return;
  const now = Date.now();
  if (now - lastKeyTime > SCAN_TIMEOUT_MS) scanBuffer = '';
  lastKeyTime = now;
  if (e.key === 'Enter') {
    if (scanBuffer.length >= 2) void applyQaScan(scanBuffer);
    scanBuffer = '';
    clearTimeout(scanTimer);
    return;
  }
  if (e.key.length === 1) scanBuffer += e.key;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (scanBuffer.length >= 2) void applyQaScan(scanBuffer);
    scanBuffer = '';
  }, SCAN_TIMEOUT_MS);
}

function initQaScanner() {
  document.addEventListener('keydown', onDocumentKeydown);
  if (qaScanBtn) qaScanBtn.addEventListener('click', () => processManualScanInput());
  if (qaManualScan) {
    qaManualScan.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        processManualScanInput();
      }
    });
  }
  window.setInterval(() => focusQaScanner(), SCAN_FOCUS_INTERVAL_MS);
  focusQaScanner();
}

async function ensureQaQcKiosk() {
  const res = await fetch('/api/auth/me-kiosk', { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || !data.user) {
    window.location.href = '/kiosk-login';
    return false;
  }
  const area = String(data.user.area_name || '').trim();
  if (area !== 'QA/QC') {
    window.location.href = '/kiosk';
    return false;
  }
  return true;
}

document.querySelectorAll('.qa-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    setActiveTab(btn.getAttribute('data-tab') || 'project');
  });
});

if (btnNew) btnNew.addEventListener('click', () => clearForm());
if (btnCsv) btnCsv.addEventListener('click', () => exportCsv());
if (btnPrint) btnPrint.addEventListener('click', () => window.print());
if (btnExitKiosk) {
  btnExitKiosk.addEventListener('click', async () => {
    await fetch('/api/auth/kiosk-logout', { method: 'POST' });
    window.location.href = '/kiosk-login';
  });
}

bindInputs();
writeFormState(defaultFormState());

void (async () => {
  const ok = await ensureQaQcKiosk();
  if (!ok) return;
  initQaScanner();
})();
