'use strict';

const API = '/api/kiosk/winding';
const KIOSK_SLUG_KEY = 'windingKioskSlug';

const els = {
  machineLabel: document.getElementById('machineLabel'),
  workflowTitle: document.getElementById('workflowTitle'),
  workflowSub: document.getElementById('workflowSub'),
  manual: document.getElementById('manualBarcodeInput'),
  scanForm: document.getElementById('scanForm'),
  scanButton: document.getElementById('scanButton'),
  scannerTrap: document.getElementById('scannerTrap'),
  warning: document.getElementById('scanWarning'),
  assignmentBanner: document.getElementById('assignmentBanner'),
  assignmentTeam: document.getElementById('assignmentTeam'),
  finishBanner: document.getElementById('finishBanner'),
  valTeam: document.getElementById('valTeam'),
  valTank: document.getElementById('valTank'),
  valPhase: document.getElementById('valPhase'),
  valStatus: document.getElementById('valStatus'),
  valElapsed: document.getElementById('valElapsed'),
  valTankTotal: document.getElementById('valTankTotal'),
  phaseSummaryPanel: document.getElementById('phaseSummaryPanel'),
  phaseSummaryList: document.getElementById('phaseSummaryList'),
  pendingPanel: document.getElementById('pendingPanel'),
  pendingText: document.getElementById('pendingText'),
  btnPartComplete: document.getElementById('btnPartComplete'),
  phasePanel: document.getElementById('phasePanel'),
  phaseButtons: document.getElementById('phaseButtons'),
  logoutBtn: document.getElementById('logoutBtn'),
};

let config = null;
let assignment = null;
let session = null;
let phaseTimeSummary = [];
let pendingTank = null;
let resumablePhase = null;
let pendingConfirmer = null;
let phases = [];
let elapsedTimer = null;
let scanBuffer = '';
let lastKeyTime = 0;

async function api(url, opts) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function warn(msg) {
  if (!els.warning) return;
  els.warning.hidden = !msg;
  els.warning.textContent = msg || '';
}

function confirmerPayload() {
  return pendingConfirmer ? { confirmer: pendingConfirmer } : {};
}

function showFinishBanner(message) {
  if (!els.finishBanner) return;
  const title = els.finishBanner.querySelector('.finish-success-banner__title');
  if (title) title.textContent = message || 'Part complete — tank finished';
  els.finishBanner.hidden = false;
  window.setTimeout(() => {
    els.finishBanner.hidden = true;
  }, 6000);
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

function sessionStatusLabel(st, statusLabelText) {
  if (statusLabelText) return statusLabelText;
  if (st === 'running') return 'Running';
  if (st === 'stopped' || st === 'paused') return 'Paused';
  if (st === 'finished') return 'Completed';
  return 'Idle';
}

function renderAssignment() {
  if (!els.assignmentBanner) return;
  if (assignment && assignment.team_name) {
    els.assignmentBanner.hidden = false;
    if (els.assignmentTeam) els.assignmentTeam.textContent = assignment.team_name;
  } else {
    els.assignmentBanner.hidden = true;
  }
}

function renderPhaseSummary() {
  if (!els.phaseSummaryPanel || !els.phaseSummaryList) return;
  if (!phaseTimeSummary.length || (!session && !pendingTank)) {
    els.phaseSummaryPanel.hidden = true;
    els.phaseSummaryList.innerHTML = '';
    return;
  }
  els.phaseSummaryPanel.hidden = false;
  els.phaseSummaryList.innerHTML = phaseTimeSummary
    .map(
      (row) =>
        `<li class="wk-phase-summary-item wk-phase-summary-item--${row.status || 'not_started'}">${String(row.summary_line || row.phase_name || '')}</li>`
    )
    .join('');
}

function tankTotalMs() {
  return phaseTimeSummary.reduce((sum, row) => {
    if (row.counts_toward_tank_total === false) return sum;
    return sum + (Number(row.total_duration_ms) || 0);
  }, 0);
}

function sessionCountsTowardTankTotal() {
  if (!session) return false;
  const code = String(session.phase_code || session.activity_code || '').toUpperCase();
  if (code === 'PREP_CLEANUP' || code === 'PART_COMPLETE') return false;
  const row = phaseTimeSummary.find((r) => String(r.phase_code || '').toUpperCase() === code);
  if (row && row.counts_toward_tank_total === false) return false;
  return true;
}

function fmtTankTotal(ms) {
  const totalMin = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (totalMin < 1) return '0m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function tickElapsed() {
  if (!els.valElapsed) return;
  if (!session) {
    els.valElapsed.textContent = '—';
    return;
  }
  const start = new Date(session.started_at).getTime();
  if (Number.isNaN(start)) return;
  let end = Date.now();
  if (session.status === 'finished' && session.finished_at) end = new Date(session.finished_at).getTime();
  if (session.status === 'stopped' && session.stopped_at) end = new Date(session.stopped_at).getTime();
  const phaseMs = end - start;
  els.valElapsed.textContent = fmtElapsed(phaseMs);
  if (els.valTankTotal) {
    const summaryMs = tankTotalMs();
    let liveMs = summaryMs;
    if (session.status === 'running' && sessionCountsTowardTankTotal() && Number.isFinite(Number(session.elapsed_ms))) {
      liveMs = summaryMs - Number(session.elapsed_ms) + phaseMs;
    }
    els.valTankTotal.textContent = fmtTankTotal(liveMs > 0 ? liveMs : sessionCountsTowardTankTotal() ? phaseMs : summaryMs);
  }
}

function renderPhases() {
  if (!els.phaseButtons) return;
  els.phaseButtons.innerHTML = '';
  for (const ph of phases) {
    if (ph.completes) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary selection-btn';
    btn.textContent = ph.label;
    btn.addEventListener('click', () => {
      els.phasePanel.hidden = true;
      void onPhaseSelected(ph);
    });
    els.phaseButtons.appendChild(btn);
  }
}

function renderUi() {
  renderAssignment();

  // Active production session.
  if (session) {
    els.valTeam.textContent = session.team_name || (assignment ? assignment.team_name : '—');
    els.valTank.textContent = session.tank_number || '—';
    els.valPhase.textContent = session.phase_name || session.activity_name || '—';
    const st = session.status || 'running';
    els.valStatus.textContent = sessionStatusLabel(st, session.status_label);
    els.valStatus.className =
      st === 'running' ? 'wk-value wk-value--running' : st === 'stopped' ? 'wk-value wk-value--paused' : 'wk-value wk-value--idle';
    els.pendingPanel.hidden = true;
    els.btnPartComplete.hidden = false;
    els.phasePanel.hidden = true;
    els.workflowTitle.textContent = 'Production in progress';
    if (pendingConfirmer) {
      els.workflowSub.textContent = `${pendingConfirmer.name} will confirm Part Complete — scan Part Complete or tap the button.`;
    } else if (st === 'stopped') {
      els.workflowSub.textContent = 'Paused. Scan RESUME to continue the same phase.';
    } else {
      els.workflowSub.textContent = 'Scan a new Phase to switch. Break / Lunch to pause. End Shift to close for the day.';
    }
    renderPhaseSummary();
    tickElapsed();
    return;
  }

  // Idle states.
  els.btnPartComplete.hidden = true;
  els.pendingPanel.hidden = true;
  pendingConfirmer = null;
  els.valElapsed.textContent = '—';
  if (els.valTankTotal) els.valTankTotal.textContent = '—';

  els.valTeam.textContent = assignment ? assignment.team_name : '—';
  els.valTank.textContent = pendingTank || '—';
  els.valPhase.textContent = '—';
  els.valStatus.textContent = 'Idle';
  els.valStatus.className = 'wk-value wk-value--idle';

  if (!assignment) {
    els.workflowTitle.textContent = 'Scan Team barcode';
    els.workflowSub.textContent = 'Please scan a Team barcode first. This assigns the team to this machine for today.';
    els.phasePanel.hidden = true;
    if (els.phaseSummaryPanel) els.phaseSummaryPanel.hidden = true;
    return;
  }

  if (!pendingTank) {
    els.workflowTitle.textContent = 'Scan Tank barcode';
    els.workflowSub.textContent = `Team ${assignment.team_name} assigned. Scan a Tank to begin. Break / Lunch / End Shift available anytime.`;
    els.phasePanel.hidden = true;
    if (els.phaseSummaryPanel) els.phaseSummaryPanel.hidden = true;
    return;
  }

  // Tank selected, no session yet.
  if (resumablePhase) {
    els.workflowTitle.textContent = 'Scan Phase or RESUME';
    els.workflowSub.textContent = `Tank ${pendingTank}: scan RESUME to continue ${resumablePhase}, or scan a new Phase.`;
  } else {
    els.workflowTitle.textContent = 'Scan or select Phase';
    els.workflowSub.textContent = `Tank ${pendingTank}: scan a Phase to begin production.`;
  }
  els.phasePanel.hidden = false;
  renderPhases();
  renderPhaseSummary();
}

async function loadConfig() {
  const { res, data } = await api(`${API}/config`, { cache: 'no-store' });
  if (res.status === 401 || res.status === 403) {
    window.location.href = '/kiosk-login';
    return;
  }
  if (!res.ok || !data.ok) {
    warn((data && data.message) || 'Could not load kiosk.');
    return;
  }
  config = data;
  phases = data.phases || [];
  session = data.session || null;
  assignment = data.assignment || null;
  phaseTimeSummary = data.phase_time_summary || [];
  if (!assignment) {
    pendingTank = null;
    resumablePhase = null;
  }
  if (data.machine && data.machine.slug) {
    try {
      localStorage.setItem(KIOSK_SLUG_KEY, data.machine.slug);
    } catch (_err) {
      /* ignore storage errors */
    }
  }
  if (els.machineLabel && data.machine) els.machineLabel.textContent = data.machine.name;
  renderUi();
}

async function postAction(body) {
  const { res, data } = await api(`${API}/action`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok || !data.ok) {
    warn((data && data.message) || 'Action failed.');
    return null;
  }
  return data;
}

function applyAssignment(data) {
  if (Object.prototype.hasOwnProperty.call(data, 'assignment')) {
    assignment = data.assignment || assignment;
  }
}

async function onPhaseSelected(ph) {
  const data = await postAction({
    action: 'scan',
    barcode: ph.barcode || ph.code,
    pending: { tank: pendingTank },
    ...confirmerPayload(),
  });
  if (!data) return;
  await consumeScanResult(data);
}

async function partComplete() {
  const data = await postAction({ action: 'part_complete', ...confirmerPayload() });
  if (data) {
    session = null;
    phaseTimeSummary = [];
    pendingTank = null;
    resumablePhase = null;
    pendingConfirmer = null;
    showFinishBanner(data.confirmation_line || 'Part complete — tank finished');
  }
  await loadConfig();
}

async function consumeScanResult(data) {
  applyAssignment(data);

  if (data.action === 'confirmer' && data.employee) {
    pendingConfirmer = data.employee;
    warn(`Confirmer set: ${data.employee.name}. Scan Part Complete or tap the button.`);
    renderUi();
    return;
  }
  if (data.action === 'team_assigned') {
    pendingTank = null;
    resumablePhase = null;
    warn(`Team ${data.assignment ? data.assignment.team_name : ''} assigned for today. Scan a Tank to begin.`);
    await loadConfig();
    return;
  }
  if (data.alert) {
    warn(`${data.alert.alert_label} reported — manager notified.`);
    await loadConfig();
    return;
  }
  if (data.action === 'pause') {
    if (data.session) session = data.session;
    warn(`${(data.session && data.session.status_label) || 'Paused'} — scan RESUME to continue this phase.`);
    await loadConfig();
    return;
  }
  if (data.action === 'resume') {
    if (data.session) session = data.session;
    pendingTank = null;
    resumablePhase = null;
    warn(data.resumed_phase ? `Resumed ${data.resumed_phase}.` : 'Production resumed.');
    await loadConfig();
    return;
  }
  if (data.action === 'end_shift') {
    session = null;
    assignment = null;
    phaseTimeSummary = [];
    pendingTank = null;
    resumablePhase = null;
    pendingConfirmer = null;
    warn(
      data.tank_number
        ? `End shift recorded for tank ${data.tank_number}. Tank stays in progress — scan Team tomorrow to resume.`
        : 'End shift recorded. Scan Team tomorrow to begin.'
    );
    await loadConfig();
    return;
  }
  if (data.action === 'tank_selected') {
    pendingTank = data.pending ? data.pending.tank : pendingTank;
    resumablePhase = data.resumable_phase || null;
    await loadConfig();
    return;
  }
  if (data.action === 'part_complete') {
    session = null;
    pendingConfirmer = null;
    phaseTimeSummary = [];
    pendingTank = null;
    resumablePhase = null;
    showFinishBanner(data.confirmation_line || 'Part complete — tank finished');
    await loadConfig();
    return;
  }
  if (data.session) {
    session = data.session;
    pendingTank = null;
    resumablePhase = null;
    await loadConfig();
    return;
  }
  await loadConfig();
}

async function handleScan(raw) {
  warn('');
  const value = String(raw || '').trim();
  if (!value) return;
  const data = await postAction({
    action: 'scan',
    barcode: value,
    pending: { tank: pendingTank },
    ...confirmerPayload(),
  });
  if (!data) return;
  await consumeScanResult(data);
}

function processScan(v) {
  void handleScan(v);
  if (els.manual) els.manual.value = '';
}

if (els.scanForm) {
  els.scanForm.addEventListener('submit', (e) => {
    e.preventDefault();
    processScan(els.manual ? els.manual.value : '');
  });
}
if (els.scanButton) els.scanButton.addEventListener('click', () => processScan(els.manual ? els.manual.value : ''));
if (els.btnPartComplete) els.btnPartComplete.addEventListener('click', () => void partComplete());
if (els.logoutBtn) {
  els.logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/kiosk-logout', { method: 'POST' });
    window.location.href = '/kiosk-login';
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target === els.manual) return;
  const now = Date.now();
  if (now - lastKeyTime > 80) scanBuffer = '';
  lastKeyTime = now;
  if (e.key === 'Enter' && scanBuffer.length >= 2) {
    e.preventDefault();
    processScan(scanBuffer);
    scanBuffer = '';
    return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) scanBuffer += e.key;
});

void loadConfig().then(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 1000);
  setInterval(() => void loadConfig(), 12000);
  if (els.scannerTrap) els.scannerTrap.focus();
});
