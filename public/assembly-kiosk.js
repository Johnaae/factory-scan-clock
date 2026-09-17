'use strict';

const API = '/api/kiosk/assembly';
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
  assemblySection: document.getElementById('assemblySection'),
  tankSelectPanel: document.getElementById('tankSelectPanel'),
  tankSelect: document.getElementById('tankSelect'),
  btnConfirmTank: document.getElementById('btnConfirmTank'),
  assemblyConfirmedHeading: document.getElementById('assemblyConfirmedHeading'),
  assemblyTankList: document.getElementById('assemblyTankList'),
  assemblyEmptyState: document.getElementById('assemblyEmptyState'),
  testingSection: document.getElementById('testingSection'),
  testingSelectPanel: document.getElementById('testingSelectPanel'),
  testingTankSelect: document.getElementById('testingTankSelect'),
  btnConfirmTest: document.getElementById('btnConfirmTest'),
  testingConfirmedHeading: document.getElementById('testingConfirmedHeading'),
  testingTankList: document.getElementById('testingTankList'),
  testingEmptyState: document.getElementById('testingEmptyState'),
  logoutBtn: document.getElementById('logoutBtn'),
  btnResume: document.getElementById('btnResume'),
  btnLunch: document.getElementById('btnLunch'),
  btnEmployeeOut: document.getElementById('btnEmployeeOut'),
  btnEndShift: document.getElementById('btnEndShift'),
  confirmModal: document.getElementById('confirmModal'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmText: document.getElementById('confirmText'),
  btnConfirmOk: document.getElementById('btnConfirmOk'),
  btnConfirmCancel: document.getElementById('btnConfirmCancel'),
  failModal: document.getElementById('failModal'),
  failNote: document.getElementById('failNote'),
  btnFailSave: document.getElementById('btnFailSave'),
  btnFailCancel: document.getElementById('btnFailCancel'),
  employeeOutModal: document.getElementById('employeeOutModal'),
  employeeOutHint: document.getElementById('employeeOutHint'),
  employeeOutList: document.getElementById('employeeOutList'),
  employeeOutEmpty: document.getElementById('employeeOutEmpty'),
  employeeOutConfirm: document.getElementById('employeeOutConfirm'),
  employeeOutConfirmText: document.getElementById('employeeOutConfirmText'),
  btnCancelEmployeeOut: document.getElementById('btnCancelEmployeeOut'),
  btnConfirmEmployeeOut: document.getElementById('btnConfirmEmployeeOut'),
};

let config = null;
let assignment = null;
let eligibleTanks = [];
let assemblyConfirmedTanks = [];
let eligibleTestingTanks = [];
let testingConfirmedTanks = [];
let pendingConfirmer = null;
let employeeOutPick = null;
let employeeOutSubmitting = false;
let confirmHandler = null;
let failTankId = null;
let actionBusy = false;
let scanBuffer = '';
let lastKeyTime = 0;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isTextEntryModalOpen() {
  const confirmOpen = els.confirmModal && !els.confirmModal.hidden && els.confirmModal.classList.contains('show');
  const failOpen = els.failModal && !els.failModal.hidden && els.failModal.classList.contains('show');
  const outOpen =
    els.employeeOutModal && !els.employeeOutModal.hidden && els.employeeOutModal.classList.contains('show');
  return Boolean(confirmOpen || failOpen || outOpen);
}

function blurScanInputs() {
  try {
    if (els.manual && typeof els.manual.blur === 'function') els.manual.blur();
  } catch (_err) {
    /* ignore */
  }
  try {
    if (els.scannerTrap && typeof els.scannerTrap.blur === 'function') els.scannerTrap.blur();
  } catch (_err) {
    /* ignore */
  }
  try {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      const tag = String(document.activeElement.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') document.activeElement.blur();
    }
  } catch (_err) {
    /* ignore */
  }
}

function showWarning(msg) {
  if (!els.warning) return;
  if (!msg) {
    els.warning.hidden = true;
    els.warning.textContent = '';
    return;
  }
  els.warning.hidden = false;
  els.warning.textContent = msg;
}

async function api(path, opts) {
  const options = opts || {};
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const { headers: _ignoredHeaders, ...rest } = options;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function statusLabel(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'ready_for_assembly') return 'Ready for Assembly';
  if (st === 'assembly_in_progress') return 'Assembly In Progress';
  if (st === 'ready_for_testing') return 'Ready for Testing';
  if (st === 'testing_in_progress') return 'Testing In Progress';
  if (st === 'ready_for_dome_install' || st === 'ready_for_final_completion') return 'Ready for Dome Install';
  return st ? st.replace(/_/g, ' ') : '—';
}

function stageLabel(status, session) {
  const st = String(status || '').toLowerCase();
  const stage = session && session.stage ? String(session.stage).toUpperCase() : '';
  if (stage === 'CORRECTION') return 'Correction';
  if (stage === 'TESTING' || st === 'testing_in_progress') return 'Testing';
  if (stage === 'ASSEMBLY' || st === 'assembly_in_progress') return 'Assembly';
  if (st === 'ready_for_dome_install' || st === 'ready_for_final_completion') return 'Ready for Dome Install';
  if (st === 'ready_for_testing') return 'Ready for Testing';
  if (st === 'ready_for_assembly') return 'Ready for Assembly';
  return statusLabel(status);
}

function laborDisplay(tank) {
  if (tank && tank.labor && tank.labor.total_display) return tank.labor.total_display;
  return '0h 0m';
}

function assemblyDurationDisplay(tank) {
  if (tank && tank.assembly_duration_display) return tank.assembly_duration_display;
  return '0h 0m';
}

function openModal(el) {
  if (!el) return;
  el.hidden = false;
  el.classList.add('show');
  blurScanInputs();
}

function closeModal(el) {
  if (!el) return;
  el.hidden = true;
  el.classList.remove('show');
}

function openConfirm(title, text, onOk) {
  if (els.confirmTitle) els.confirmTitle.textContent = title || 'Confirm';
  if (els.confirmText) els.confirmText.textContent = text || '';
  confirmHandler = onOk;
  openModal(els.confirmModal);
}

function closeConfirm() {
  confirmHandler = null;
  closeModal(els.confirmModal);
}

function openFailModal(tankId) {
  failTankId = tankId;
  if (els.failNote) els.failNote.value = '';
  openModal(els.failModal);
  try {
    if (els.failNote) els.failNote.focus();
  } catch (_err) {
    /* ignore */
  }
}

function closeFailModal() {
  failTankId = null;
  closeModal(els.failModal);
}

async function postAction(payload) {
  if (actionBusy) return { res: { ok: false }, data: { message: 'Please wait…' } };
  actionBusy = true;
  try {
    return await api(`${API}/action`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } finally {
    actionBusy = false;
  }
}

async function runAction(payload, successMsg) {
  showWarning('');
  const { res, data } = await postAction(payload);
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || 'Action failed.');
    return false;
  }
  if (successMsg) showWarning(successMsg);
  else if (data.message) showWarning(data.message);
  if (data.confirmer) pendingConfirmer = data.confirmer;
  if (data.assignment) assignment = data.assignment;
  if (data.action === 'end_shift') {
    assignment = null;
    pendingConfirmer = null;
  }
  await loadConfig();
  return true;
}

function renderWorkflowHints() {
  if (!els.workflowTitle || !els.workflowSub) return;
  if (!assignment) {
    els.workflowTitle.textContent = 'Scan Team or Employee';
    els.workflowSub.textContent =
      'Scan a TEAM or EMPLOYEE barcode only. Assembly and Testing sections appear after assignment.';
    return;
  }
  els.workflowTitle.textContent = 'Assembly / Testing';
  els.workflowSub.textContent = pendingConfirmer
    ? `${pendingConfirmer.name} selected — use Assembly CONFIRM TANK or Testing CONFIRM TEST, then the section buttons.`
    : 'ASSEMBLY: Confirm → START / STOP / FINISH. TESTING: Confirm Test → START TESTING → PASS / FAIL. FAIL returns tank to FAB for rework.';
}

function renderAssignment() {
  if (!els.assignmentBanner || !els.assignmentTeam) return;
  const parts = [];
  if (assignment && assignment.team_name) parts.push(assignment.team_name);
  if (pendingConfirmer && pendingConfirmer.name) parts.push(pendingConfirmer.name);
  if (parts.length) {
    els.assignmentBanner.hidden = false;
    els.assignmentTeam.textContent = parts.join(' · ');
  } else {
    els.assignmentBanner.hidden = true;
    els.assignmentTeam.textContent = '—';
  }
}

function eligibleOptionLabel(tank) {
  const num = tank.tank_number || '—';
  return `Tank ${num} — Ready for Assembly`;
}

function eligibleTestingOptionLabel(tank) {
  const num = tank.tank_number || '—';
  return `Tank ${num} — Ready for Testing`;
}

function renderTankSelect() {
  if (!els.tankSelect) return;
  const hasAssignment = Boolean(assignment && assignment.team_name);
  if (els.assemblySection) els.assemblySection.hidden = !hasAssignment;
  if (!hasAssignment) return;

  const prev = els.tankSelect.value;
  const options = (eligibleTanks || [])
    .filter((t) => {
      const st = String(t.status || '').toLowerCase();
      return (
        st === 'ready_for_assembly' &&
        t.assembly_machine_id == null &&
        !t.assembly_started_at &&
        !t.completed_at
      );
    })
    .map(
      (t) =>
        `<option value="${Number(t.id)}">${escapeHtml(eligibleOptionLabel(t))}</option>`
    );
  els.tankSelect.innerHTML = `<option value="">Choose a tank…</option>${options.join('')}`;
  if (prev && Array.from(els.tankSelect.options).some((o) => o.value === prev)) {
    els.tankSelect.value = prev;
  }
}

function renderTestingTankSelect() {
  if (!els.testingTankSelect) return;
  const hasAssignment = Boolean(assignment && assignment.team_name);
  if (els.testingSection) els.testingSection.hidden = !hasAssignment;
  if (!hasAssignment) return;

  const prev = els.testingTankSelect.value;
  const options = (eligibleTestingTanks || [])
    .filter((t) => {
      const st = String(t.status || '').toLowerCase();
      const requiresTest =
        t.requires_test === true || t.requires_test === 1 || t.requires_test === 'true';
      return (
        requiresTest &&
        st === 'ready_for_testing' &&
        t.testing_machine_id == null &&
        t.assembly_completed_at &&
        !t.completed_at &&
        !t.testing_completed_at
      );
    })
    .map(
      (t) =>
        `<option value="${Number(t.id)}">${escapeHtml(eligibleTestingOptionLabel(t))}</option>`
    );
  els.testingTankSelect.innerHTML = `<option value="">Choose a tank…</option>${options.join('')}`;
  if (prev && Array.from(els.testingTankSelect.options).some((o) => o.value === prev)) {
    els.testingTankSelect.value = prev;
  }
}

function assemblyActionButtons(tank) {
  const status = String(tank.status || '').toLowerCase();
  const session = tank.active_session || null;
  const stage = session ? String(session.stage || '').toUpperCase() : '';
  const tid = Number(tank.id);
  const btns = [];

  if (status === 'assembly_in_progress' && !session) {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--start-work" data-ak-action="start" data-tank-id="${tid}" data-stage="ASSEMBLY">START</button>`
    );
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-ak-action="finish" data-tank-id="${tid}">FINISH</button>`
    );
  }
  if (session && stage === 'ASSEMBLY') {
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-ak-action="stop" data-tank-id="${tid}">STOP</button>`
    );
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-ak-action="finish" data-tank-id="${tid}">FINISH</button>`
    );
  }
  return btns.join('');
}

function testingActionButtons(tank) {
  const status = String(tank.status || '').toLowerCase();
  const tid = Number(tank.id);
  const btns = [];
  const requiresTest =
    tank.requires_test === true || tank.requires_test === 1 || tank.requires_test === 'true';
  if (!requiresTest) return '';

  // QA/QC only — Correction/rework labor belongs on FAB after FAIL (rework_required).
  if (status === 'ready_for_testing') {
    btns.push(
      `<button type="button" class="btn-primary btn-touch" data-ak-action="start_testing" data-tank-id="${tid}">START TESTING</button>`
    );
  }
  if (status === 'testing_in_progress') {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--pass" data-ak-action="test_pass" data-tank-id="${tid}">PASS</button>`
    );
    btns.push(
      `<button type="button" class="btn-secondary btn-touch btn-touch--fail" data-ak-action="test_fail" data-tank-id="${tid}">FAIL</button>`
    );
  }
  return btns.join('');
}

function liveAssemblyDurationDisplay(tank) {
  const started = tank && tank.assembly_started_at ? new Date(tank.assembly_started_at).getTime() : NaN;
  if (!Number.isFinite(started)) return assemblyDurationDisplay(tank);
  const completed = tank.assembly_completed_at ? new Date(tank.assembly_completed_at).getTime() : NaN;
  const end = Number.isFinite(completed) ? completed : Date.now();
  const ms = Math.max(0, end - started);
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function liveTestingElapsedDisplay(tank) {
  if (tank && tank.testing_elapsed_display) return tank.testing_elapsed_display;
  const started = tank && tank.testing_started_at ? new Date(tank.testing_started_at).getTime() : NaN;
  if (!Number.isFinite(started)) return '0h 0m';
  const completed = tank.testing_completed_at ? new Date(tank.testing_completed_at).getTime() : NaN;
  const status = String(tank.status || '').toLowerCase();
  let end = Date.now();
  if (Number.isFinite(completed)) end = completed;
  else if (status !== 'testing_in_progress') return '0h 0m';
  const ms = Math.max(0, end - started);
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function fmtTestingStarted(tank) {
  const iso = tank && tank.testing_started_at;
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  } catch (_e) {
    return '—';
  }
}

function renderAssemblyTankCard(tank) {
  const status = String(tank.status || '').toLowerCase();
  const session = tank.active_session || null;
  const sessionStage = session ? String(session.stage || '').toUpperCase() : '';
  const active = Boolean(session) && sessionStage === 'ASSEMBLY';
  const labor = laborDisplay(tank);
  const asmDur = liveAssemblyDurationDisplay(tank);
  const showStartHint = status === 'assembly_in_progress' && !tank.active_session;

  return `<article class="ak-tank-card ${active ? 'is-active' : ''}" data-tank-id="${Number(tank.id)}">
    <div class="ak-tank-head">
      <div>
        <h3 class="ak-tank-title">Tank ${escapeHtml(tank.tank_number || '—')}</h3>
        <p class="ak-tank-stage">Status: ${escapeHtml(statusLabel(status))}</p>
      </div>
      <span class="ak-badge ${active ? 'ak-badge--active' : 'ak-badge--waiting'}">${
        active ? 'LABOR ACTIVE' : 'LABOR STOPPED'
      }</span>
    </div>
    <div class="ak-metrics">
      <div class="ak-metric ak-metric--assembly"><p class="ak-metric-label">Assembly Duration</p><p class="ak-metric-value" data-asm-duration="${Number(
        tank.id
      )}">${escapeHtml(asmDur)}</p></div>
      <div class="ak-metric ak-metric--labor"><p class="ak-metric-label">Labor Time</p><p class="ak-metric-value">${escapeHtml(
        labor
      )}</p></div>
    </div>
    ${
      showStartHint
        ? `<p class="ak-start-hint">Assembly Duration is running. Press <strong>START</strong> to begin labor.</p>`
        : ''
    }
    <div class="ak-tank-actions">${assemblyActionButtons(tank)}</div>
  </article>`;
}

function renderTestingTankCard(tank) {
  const status = String(tank.status || '').toLowerCase();

  if (status === 'testing_in_progress') {
    const elapsed = liveTestingElapsedDisplay(tank);
    return `<article class="ak-tank-card ak-tank-card--testing" data-tank-id="${Number(tank.id)}">
    <div class="ak-tank-head">
      <div>
        <h3 class="ak-tank-title">Tank ${escapeHtml(tank.tank_number || '—')}</h3>
        <p class="ak-tank-stage">Status: ${escapeHtml(statusLabel(status))}</p>
        <p class="ak-tank-stage">Testing Started: ${escapeHtml(fmtTestingStarted(tank))}</p>
      </div>
      <span class="ak-badge ak-badge--testing">QA / TESTING</span>
    </div>
    <div class="ak-metrics">
      <div class="ak-metric"><p class="ak-metric-label">Testing Elapsed (QA/QC only)</p><p class="ak-metric-value" data-testing-elapsed="${Number(
        tank.id
      )}">${escapeHtml(elapsed)}</p></div>
    </div>
    <p class="ak-start-hint">Testing does not count as production labor or Tank Total Running Time.</p>
    <div class="ak-tank-actions">${testingActionButtons(tank)}</div>
  </article>`;
  }

  // Ready for Testing (after CONFIRM TEST) — QA only (no Correction on this kiosk).
  return `<article class="ak-tank-card" data-tank-id="${Number(tank.id)}">
    <div class="ak-tank-head">
      <div>
        <h3 class="ak-tank-title">Tank ${escapeHtml(tank.tank_number || '—')}</h3>
        <p class="ak-tank-stage">Status: ${escapeHtml(statusLabel(status))}</p>
      </div>
      <span class="ak-badge ak-badge--waiting">READY FOR TESTING</span>
    </div>
    <div class="ak-tank-actions">${testingActionButtons(tank)}</div>
  </article>`;
}

function renderAssemblyTanks() {
  if (!els.assemblyTankList) return;
  const tanks = (Array.isArray(assemblyConfirmedTanks) ? assemblyConfirmedTanks : []).filter(
    (t) => String(t.status || '').toLowerCase() === 'assembly_in_progress'
  );
  if (els.assemblyConfirmedHeading) els.assemblyConfirmedHeading.hidden = tanks.length === 0;
  if (!tanks.length) {
    els.assemblyTankList.innerHTML = '';
    if (els.assemblyEmptyState) {
      els.assemblyEmptyState.hidden = false;
      els.assemblyEmptyState.textContent = assignment
        ? 'No tanks confirmed for Assembly. Select a tank above and press CONFIRM TANK.'
        : 'Scan a Team or Employee first, then select and confirm a tank.';
    }
    return;
  }
  if (els.assemblyEmptyState) els.assemblyEmptyState.hidden = true;
  els.assemblyTankList.innerHTML = tanks.map(renderAssemblyTankCard).join('');
  wireTankButtons(els.assemblyTankList);
}

function renderTestingTanks() {
  if (!els.testingTankList) return;
  const tanks = (Array.isArray(testingConfirmedTanks) ? testingConfirmedTanks : []).filter((t) => {
    const st = String((t && t.status) || '').toLowerCase();
    return st === 'ready_for_testing' || st === 'testing_in_progress';
  });
  if (els.testingConfirmedHeading) els.testingConfirmedHeading.hidden = tanks.length === 0;
  if (!tanks.length) {
    els.testingTankList.innerHTML = '';
    if (els.testingEmptyState) {
      els.testingEmptyState.hidden = false;
      els.testingEmptyState.textContent =
        'No tanks confirmed for Testing. Finished Assembly tanks with Require Test appear in the dropdown — select one and press CONFIRM TEST.';
    }
    return;
  }
  if (els.testingEmptyState) els.testingEmptyState.hidden = true;
  els.testingTankList.innerHTML = tanks.map(renderTestingTankCard).join('');
  wireTankButtons(els.testingTankList);
}

function wireTouchPrevent(root) {
  if (!root) return;
  root.querySelectorAll('button').forEach((btn) => {
    if (btn.dataset.akMousedown === '1') return;
    btn.dataset.akMousedown = '1';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      blurScanInputs();
    });
  });
}

async function handleTankAction(action, tankId, stage) {
  const confirmer = pendingConfirmer
    ? { id: pendingConfirmer.id, name: pendingConfirmer.name, code: pendingConfirmer.code || null }
    : null;

  let apiAction = action;
  if (action === 'start') apiAction = 'start_work';
  else if (action === 'stop') apiAction = 'stop_work';
  else if (action === 'finish') apiAction = 'assembly_complete';

  if (apiAction === 'assembly_complete') {
    const tank = (assemblyConfirmedTanks || []).find((t) => Number(t.id) === Number(tankId));
    const requiresTest =
      tank &&
      (tank.requires_test === true || tank.requires_test === 1 || tank.requires_test === 'true');
    const finishMsg = requiresTest
      ? 'Finish assembly? Tank will leave Assembly and become available in the Testing dropdown (CONFIRM TEST required).'
      : 'Finish assembly? Tank will become Ready for Dome Install and leave this kiosk.';
    openConfirm('Finish Assembly', finishMsg, async () => {
      closeConfirm();
      await runAction({ action: 'assembly_complete', tank_id: tankId, confirmer });
    });
    return;
  }
  if (apiAction === 'test_fail') {
    openFailModal(tankId);
    return;
  }
  const payload = { action: apiAction, tank_id: tankId, confirmer };
  if (apiAction === 'start_work') payload.stage = stage || 'ASSEMBLY';
  await runAction(payload);
}

function wireTankButtons(root) {
  if (!root) return;
  wireTouchPrevent(root);
  root.querySelectorAll('[data-ak-action]').forEach((btn) => {
    if (btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      blurScanInputs();
      const action = btn.getAttribute('data-ak-action');
      const tankId = Number(btn.getAttribute('data-tank-id'));
      const stage = btn.getAttribute('data-stage') || null;
      if (!action || !Number.isInteger(tankId) || tankId <= 0) return;
      void handleTankAction(action, tankId, stage);
    });
  });
}

async function confirmSelectedTank() {
  if (!assignment) {
    showWarning('Scan a Team or Employee first.');
    return;
  }
  const tankId = els.tankSelect ? Number(els.tankSelect.value) : 0;
  if (!Number.isInteger(tankId) || tankId <= 0) {
    showWarning('Select a tank from the Assembly list, then press CONFIRM TANK.');
    return;
  }
  if (actionBusy) {
    showWarning('Please wait…');
    return;
  }
  actionBusy = true;
  showWarning('');
  try {
    const { res, data } = await api(`${API}/confirm-tank`, {
      method: 'POST',
      body: JSON.stringify({ tank_id: tankId }),
    });
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || `Could not confirm tank${res && res.status ? ` (HTTP ${res.status})` : ''}.`);
      return;
    }
    showWarning(data.message || 'Tank confirmed — Assembly Duration started. Press START for labor.');
    await loadConfig();
  } finally {
    actionBusy = false;
  }
}

async function confirmSelectedTest() {
  if (!assignment) {
    showWarning('Scan a Team or Employee first.');
    return;
  }
  const tankId = els.testingTankSelect ? Number(els.testingTankSelect.value) : 0;
  if (!Number.isInteger(tankId) || tankId <= 0) {
    showWarning('Select a tank from the Testing list, then press CONFIRM TEST.');
    return;
  }
  if (actionBusy) {
    showWarning('Please wait…');
    return;
  }
  actionBusy = true;
  showWarning('');
  try {
    const { res, data } = await api(`${API}/confirm-test`, {
      method: 'POST',
      body: JSON.stringify({ tank_id: tankId }),
    });
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || `Could not confirm test${res && res.status ? ` (HTTP ${res.status})` : ''}.`);
      return;
    }
    showWarning(data.message || 'Tank confirmed for Testing. Press START TESTING when ready.');
    await loadConfig();
  } finally {
    actionBusy = false;
  }
}

function renderAll() {
  if (config && config.machine && els.machineLabel) {
    els.machineLabel.textContent = config.machine.name || 'Assembly / Testing';
  }
  renderAssignment();
  renderWorkflowHints();
  renderTankSelect();
  renderTestingTankSelect();
  renderAssemblyTanks();
  renderTestingTanks();
  wireTouchPrevent(document.getElementById('stationControls'));
  if (els.btnConfirmTank) wireTouchPrevent(els.btnConfirmTank.parentElement);
  if (els.btnConfirmTest) wireTouchPrevent(els.btnConfirmTest.parentElement);
}

async function loadConfig() {
  const { res, data } = await api(`${API}/config`, { cache: 'no-store' });
  if (res.status === 409 && data && data.workflow === 'winding') {
    showWarning(data.message || 'This machine is winding — redirecting…');
    const slug = (config && config.machine && config.machine.slug) || null;
    if (slug) window.location.href = `/kiosk/machine/${encodeURIComponent(slug)}`;
    return;
  }
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || 'Could not load assembly kiosk.');
    return;
  }
  config = data;
  assignment = data.assignment || null;
  eligibleTanks = Array.isArray(data.eligible_tanks) ? data.eligible_tanks : [];
  assemblyConfirmedTanks = Array.isArray(data.assembly_confirmed_tanks)
    ? data.assembly_confirmed_tanks
    : Array.isArray(data.confirmed_tanks)
      ? data.confirmed_tanks.filter((t) => String(t.status || '').toLowerCase() === 'assembly_in_progress')
      : [];
  eligibleTestingTanks = Array.isArray(data.eligible_testing_tanks) ? data.eligible_testing_tanks : [];
  testingConfirmedTanks = Array.isArray(data.testing_confirmed_tanks)
    ? data.testing_confirmed_tanks
    : [];
  if (data.machine && data.machine.slug) {
    try {
      localStorage.setItem(KIOSK_SLUG_KEY, String(data.machine.slug));
    } catch (_err) {
      /* ignore */
    }
  }
  renderAll();
}

const ASSEMBLY_SCAN_ACTION_KEYWORDS = new Set([
  'confirm_tank',
  'confirm',
  'confirm tank',
  'start',
  'stop',
  'finish',
  'start_work',
  'stop_work',
  'assembly_complete',
  'start_testing',
  'start_correction',
  'test_pass',
  'test_fail',
  'pass',
  'fail',
  'break',
  'lunch',
  'resume',
  'end_shift',
  'pause',
]);

function isForbiddenAssemblyScanInput(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!s) return false;
  if (ASSEMBLY_SCAN_ACTION_KEYWORDS.has(s)) return true;
  // Also reject spaced forms like "confirm tank"
  const spaced = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ');
  return ASSEMBLY_SCAN_ACTION_KEYWORDS.has(spaced);
}

async function submitScan(raw) {
  const barcode = String(raw || '').trim();
  if (!barcode) return;
  showWarning('');
  // Scan field accepts TEAM / EMPLOYEE barcodes only — never tank actions.
  if (isForbiddenAssemblyScanInput(barcode)) {
    showWarning('Use the buttons for tank actions. Scan only a TEAM or EMPLOYEE barcode here.');
    return;
  }
  const { res, data } = await postAction({ action: 'scan', barcode });
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || 'Scan a Team or Employee barcode only.');
    return;
  }
  if (data.action === 'assign_team' || data.action === 'team_assigned') {
    assignment = data.assignment || assignment;
    showWarning(data.message || 'Team assigned. Select a tank and press CONFIRM TANK.');
  } else if (data.action === 'employee_selected' || data.confirmer) {
    pendingConfirmer = data.confirmer || data.employee || null;
    showWarning(data.confirmation_line || (pendingConfirmer ? `Selected: ${pendingConfirmer.name}` : 'Employee selected.'));
  } else if (data.message) {
    showWarning(data.message);
  }
  await loadConfig();
}

function closeEmployeeOut() {
  employeeOutPick = null;
  employeeOutSubmitting = false;
  if (els.employeeOutList) els.employeeOutList.innerHTML = '';
  if (els.employeeOutEmpty) els.employeeOutEmpty.hidden = true;
  if (els.employeeOutConfirm) els.employeeOutConfirm.hidden = true;
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = true;
  closeModal(els.employeeOutModal);
}

async function openEmployeeOut() {
  if (!assignment) {
    showWarning('Scan a Team barcode first.');
    return;
  }
  employeeOutPick = null;
  if (els.employeeOutConfirm) els.employeeOutConfirm.hidden = true;
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = true;
  if (els.employeeOutHint) els.employeeOutHint.textContent = 'Select an employee on this team’s open shift.';
  openModal(els.employeeOutModal);
  const { res, data } = await api(`${API}/shift-employees`, { cache: 'no-store' });
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || 'Could not load employees.');
    closeEmployeeOut();
    return;
  }
  const employees = Array.isArray(data.employees) ? data.employees : [];
  if (!employees.length) {
    if (els.employeeOutList) els.employeeOutList.innerHTML = '';
    if (els.employeeOutEmpty) els.employeeOutEmpty.hidden = false;
    return;
  }
  if (els.employeeOutEmpty) els.employeeOutEmpty.hidden = true;
  els.employeeOutList.innerHTML = employees
    .map(
      (e) => `<button type="button" class="employee-out-row" data-employee-id="${Number(e.id)}">
      <span class="employee-out-name">${escapeHtml(e.name || '—')}</span>
      <span class="employee-out-meta">${escapeHtml(e.code || '')}</span>
    </button>`
    )
    .join('');
  wireTouchPrevent(els.employeeOutList);
  els.employeeOutList.querySelectorAll('[data-employee-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-employee-id'));
      const emp = employees.find((x) => Number(x.id) === id);
      if (!emp) return;
      employeeOutPick = emp;
      if (els.employeeOutConfirm) els.employeeOutConfirm.hidden = false;
      if (els.employeeOutConfirmText) {
        els.employeeOutConfirmText.textContent = `Clock out ${emp.name}? They will leave active stage labor on this station.`;
      }
      if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = false;
    });
  });
}

async function confirmEmployeeOut() {
  if (!employeeOutPick || employeeOutSubmitting) return;
  employeeOutSubmitting = true;
  try {
    const { res, data } = await api(`${API}/employee-out`, {
      method: 'POST',
      body: JSON.stringify({ employee_id: employeeOutPick.id }),
    });
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || 'Could not clock employee out.');
      return;
    }
    showWarning(`${employeeOutPick.name} is out.`);
    closeEmployeeOut();
    await loadConfig();
  } finally {
    employeeOutSubmitting = false;
  }
}

function wireStationButtons() {
  const map = [
    [els.btnResume, () => runAction({ action: 'resume' }, 'Assembly work resumed after Lunch.')],
    [els.btnLunch, () => runAction({ action: 'lunch' }, 'Lunch — station labor paused.')],
    [els.btnEmployeeOut, () => openEmployeeOut()],
    [
      els.btnEndShift,
      () =>
        openConfirm('End Shift', 'Stop all stage labor on this station and clear the team assignment?', async () => {
          closeConfirm();
          await runAction({ action: 'end_shift' }, 'Shift ended.');
        }),
    ],
  ];
  map.forEach(([btn, handler]) => {
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      blurScanInputs();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      void handler();
    });
  });
  if (els.btnConfirmTank) {
    els.btnConfirmTank.addEventListener('mousedown', (e) => {
      e.preventDefault();
      blurScanInputs();
    });
    els.btnConfirmTank.addEventListener('click', (e) => {
      e.preventDefault();
      void confirmSelectedTank();
    });
  }
  if (els.btnConfirmTest) {
    els.btnConfirmTest.addEventListener('mousedown', (e) => {
      e.preventDefault();
      blurScanInputs();
    });
    els.btnConfirmTest.addEventListener('click', (e) => {
      e.preventDefault();
      void confirmSelectedTest();
    });
  }
}

function wireScan() {
  if (els.scanButton) {
    els.scanButton.addEventListener('mousedown', (e) => e.preventDefault());
    els.scanButton.addEventListener('click', (e) => {
      e.preventDefault();
      const val = els.manual ? els.manual.value : '';
      if (els.manual) els.manual.value = '';
      void submitScan(val);
      blurScanInputs();
    });
  }
  if (els.scanForm) {
    els.scanForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = els.manual ? els.manual.value : '';
      if (els.manual) els.manual.value = '';
      void submitScan(val);
      blurScanInputs();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (isTextEntryModalOpen()) return;
    const tag = String((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return;
    if (tag === 'input' && e.target === els.manual) return;
    const now = Date.now();
    if (now - lastKeyTime > 80) scanBuffer = '';
    lastKeyTime = now;
    if (e.key === 'Enter') {
      if (scanBuffer) {
        e.preventDefault();
        const code = scanBuffer;
        scanBuffer = '';
        void submitScan(code);
      }
      return;
    }
    if (e.key && e.key.length === 1) {
      scanBuffer += e.key;
    }
  });
}

function wireModals() {
  if (els.btnConfirmCancel) {
    els.btnConfirmCancel.addEventListener('click', () => closeConfirm());
  }
  if (els.btnConfirmOk) {
    els.btnConfirmOk.addEventListener('click', () => {
      const fn = confirmHandler;
      if (typeof fn === 'function') void fn();
    });
  }
  if (els.btnFailCancel) {
    els.btnFailCancel.addEventListener('click', () => closeFailModal());
  }
  if (els.btnFailSave) {
    els.btnFailSave.addEventListener('click', async () => {
      const note = els.failNote ? String(els.failNote.value || '').trim() : '';
      if (!note) {
        showWarning('A failure note is required.');
        return;
      }
      const tankId = failTankId;
      closeFailModal();
      await runAction({
        action: 'test_fail',
        tank_id: tankId,
        note,
        confirmer: pendingConfirmer
          ? { id: pendingConfirmer.id, name: pendingConfirmer.name, code: pendingConfirmer.code || null }
          : null,
      });
    });
  }
  if (els.btnCancelEmployeeOut) {
    els.btnCancelEmployeeOut.addEventListener('click', () => closeEmployeeOut());
  }
  if (els.btnConfirmEmployeeOut) {
    els.btnConfirmEmployeeOut.addEventListener('click', () => void confirmEmployeeOut());
  }
}

if (els.logoutBtn) {
  els.logoutBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.logoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/kiosk-login';
  });
}

if (window.FactoryI18n) {
  window.FactoryI18n.mountSelector('kioskLangMount');
  window.FactoryI18n.applyDom();
}

wireScan();
wireStationButtons();
wireModals();

setInterval(() => {
  if (els.assemblyTankList && Array.isArray(assemblyConfirmedTanks)) {
    assemblyConfirmedTanks.forEach((tank) => {
      if (!tank || !tank.assembly_started_at || tank.assembly_completed_at) return;
      const el = els.assemblyTankList.querySelector(`[data-asm-duration="${Number(tank.id)}"]`);
      if (el) el.textContent = liveAssemblyDurationDisplay(tank);
    });
  }
  if (els.testingTankList && Array.isArray(testingConfirmedTanks)) {
    testingConfirmedTanks.forEach((tank) => {
      if (!tank) return;
      if (String(tank.status || '').toLowerCase() === 'testing_in_progress') {
        const tel = els.testingTankList.querySelector(`[data-testing-elapsed="${Number(tank.id)}"]`);
        if (tel) tel.textContent = liveTestingElapsedDisplay(tank);
      }
    });
  }
}, 15000);

void loadConfig().then(() => {
  setInterval(() => void loadConfig(), 10000);
});
