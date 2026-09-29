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
  teamCards: document.getElementById('teamCards'),
  teamsEmpty: document.getElementById('teamsEmpty'),
  recentlyFinished: document.getElementById('recentlyFinished'),
  recentlyFinishedList: document.getElementById('recentlyFinishedList'),
  returnRemoved: document.getElementById('returnRemoved'),
  returnRemovedSelect: document.getElementById('returnRemovedSelect'),
  btnReturnRemoved: document.getElementById('btnReturnRemoved'),
  logoutBtn: document.getElementById('logoutBtn'),
  confirmModal: document.getElementById('confirmModal'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmText: document.getElementById('confirmText'),
  btnConfirmOk: document.getElementById('btnConfirmOk'),
  btnConfirmCancel: document.getElementById('btnConfirmCancel'),
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
let activeTeams = [];
let eligibleTanks = [];
let recentlyFinished = [];
let removedTanks = [];
let returnRemovedSignature = '';
let returnRemovedBusy = false;
let focusedTeamId = null;
let pendingConfirmer = null;
let employeeOutTeamId = null;
let employeeOutPick = null;
let employeeOutSubmitting = false;
let confirmHandler = null;
let actionBusy = false;
let scanBuffer = '';
let lastKeyTime = 0;
let loadConfigSeq = 0;
let loadConfigInFlight = null;

function applyConfigData(data) {
  if (!data || !data.ok) return;
  config = data;
  if (Array.isArray(data.active_teams) && data.active_teams.length) {
    activeTeams = data.active_teams;
  } else if (data.assignment && data.assignment.team_id) {
    // Defensive: never blank the kiosk when a team is assigned.
    activeTeams = [
      {
        team_id: Number(data.assignment.team_id),
        team_name: data.assignment.team_name,
        team_barcode: data.assignment.team_barcode || null,
        status: 'active',
        on_lunch: false,
        roster: Array.isArray(data.roster) ? data.roster : [],
        tanks: [],
      },
    ];
  } else {
    activeTeams = [];
  }
  eligibleTanks = Array.isArray(data.eligible_tanks) ? data.eligible_tanks : [];
  recentlyFinished = Array.isArray(data.recently_finished_assembly) ? data.recently_finished_assembly : [];
  // Scan responses re-render from partial data without removed_tanks — keep the last known list.
  if (Array.isArray(data.removed_tanks)) removedTanks = data.removed_tanks;
  if (!focusedTeamId && activeTeams.length) focusedTeamId = Number(activeTeams[0].team_id);
  if (data.machine && data.machine.slug) {
    try {
      localStorage.setItem(KIOSK_SLUG_KEY, String(data.machine.slug));
    } catch (_err) {
      /* ignore */
    }
  }
  renderAll();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isTextEntryModalOpen() {
  const confirmOpen = els.confirmModal && !els.confirmModal.hidden && els.confirmModal.classList.contains('show');
  const outOpen =
    els.employeeOutModal && !els.employeeOutModal.hidden && els.employeeOutModal.classList.contains('show');
  return Boolean(confirmOpen || outOpen);
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
    ...(options.headers || {}),
  };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    credentials: 'same-origin',
    cache: options.cache || 'default',
    ...options,
    headers,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_err) {
    data = { ok: false, message: 'Invalid server response.' };
  }
  return { res, data };
}

async function postAction(body) {
  return api(`${API}/action`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

function openModal(el) {
  if (!el) return;
  el.hidden = false;
  el.classList.add('show');
  blurScanInputs();
}

function closeModal(el) {
  if (!el) return;
  el.classList.remove('show');
  el.hidden = true;
}

function askConfirm(title, text, okLabel) {
  return new Promise((resolve) => {
    if (els.confirmTitle) els.confirmTitle.textContent = title || 'Confirm';
    if (els.confirmText) els.confirmText.textContent = text || '';
    if (els.btnConfirmOk) els.btnConfirmOk.textContent = okLabel || 'Confirm';
    confirmHandler = resolve;
    openModal(els.confirmModal);
  });
}

function formatTs(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function statusLabel(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'ready_for_assembly') return 'Ready for Assembly';
  if (st === 'assembly_in_progress') return 'Assembly Working';
  if (st === 'ready_for_qa') return 'Ready for QA';
  if (st === 'qa_in_progress') return 'QA In Progress';
  if (st === 'qa_failed') return 'QA Failed';
  if (st === 'ready_for_testing') return 'Ready for Testing';
  if (st === 'testing_in_progress') return 'Testing';
  return st || '—';
}

function laborDisplay(tank) {
  if (tank && tank.labor_display) return tank.labor_display;
  if (tank && tank.stage_labor_display) return tank.stage_labor_display;
  return '0h 0m';
}

function liveAssemblyDurationDisplay(tank) {
  const started = tank && tank.assembly_started_at ? new Date(tank.assembly_started_at).getTime() : NaN;
  if (!Number.isFinite(started)) return tank && tank.assembly_duration_display ? tank.assembly_duration_display : '0h 0m';
  const completed = tank.assembly_completed_at ? new Date(tank.assembly_completed_at).getTime() : NaN;
  const end = Number.isFinite(completed) ? completed : Date.now();
  const ms = Math.max(0, end - started);
  const totalMin = Math.floor(ms / 60000);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function eligibleOptionLabel(tank) {
  if (tank && tank.assembly_restored_at) {
    return `Tank ${tank.tank_number || '—'} — Restored, Ready for Assembly`;
  }
  return `Tank ${tank.tank_number || '—'} — Ready for Assembly`;
}

function wireTouchPrevent(root) {
  if (!root) return;
  root.querySelectorAll('button').forEach((btn) => {
    if (btn.dataset.touchWired) return;
    btn.dataset.touchWired = '1';
    btn.addEventListener(
      'touchend',
      (ev) => {
        ev.preventDefault();
        btn.click();
      },
      { passive: false }
    );
  });
}

function teamStatusBadge(team) {
  if (team.on_lunch || String(team.status || '').toLowerCase() === 'lunch') {
    return '<span class="ak-badge ak-badge--lunch">LUNCH</span>';
  }
  const hasLabor = (team.tanks || []).some((t) => t.active_session);
  if (hasLabor) return '<span class="ak-badge ak-badge--working">WORKING</span>';
  return '<span class="ak-badge ak-badge--active">ACTIVE</span>';
}

function assemblyActionButtons(tank, teamId) {
  const status = String(tank.status || '').toLowerCase();
  const session = tank.active_session || null;
  const stage = session ? String(session.stage || '').toUpperCase() : '';
  const tid = Number(tank.id);
  const btns = [];
  if (status === 'assembly_in_progress' && !session) {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--start-work" data-ak-action="start" data-tank-id="${tid}" data-team-id="${teamId}" data-stage="ASSEMBLY">START</button>`
    );
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-ak-action="finish" data-tank-id="${tid}" data-team-id="${teamId}">FINISH</button>`
    );
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-ak-action="remove_from_assembly" data-tank-id="${tid}" data-team-id="${teamId}">REMOVE FROM ASSEMBLY</button>`
    );
  }
  if (session && stage === 'ASSEMBLY') {
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-ak-action="stop" data-tank-id="${tid}" data-team-id="${teamId}">STOP</button>`
    );
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-ak-action="finish" data-tank-id="${tid}" data-team-id="${teamId}">FINISH</button>`
    );
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-ak-action="remove_from_assembly" data-tank-id="${tid}" data-team-id="${teamId}">REMOVE FROM ASSEMBLY</button>`
    );
  }
  return btns.join('');
}

function renderTankCard(tank, teamId) {
  const status = String(tank.status || '').toLowerCase();
  const session = tank.active_session || null;
  const active = Boolean(session) && String(session.stage || '').toUpperCase() === 'ASSEMBLY';
  return `<article class="ak-tank-card ${active ? 'is-active' : ''}" data-tank-id="${Number(tank.id)}">
    <div>
      <h3 class="ak-tank-title">Tank ${escapeHtml(tank.tank_number || '—')}</h3>
      <p class="ak-tank-stage">Status: ${escapeHtml(statusLabel(status))}</p>
    </div>
    <div class="ak-metrics">
      <div class="ak-metric"><p class="ak-metric-label">Assembly Duration</p><p class="ak-metric-value">${escapeHtml(liveAssemblyDurationDisplay(tank))}</p></div>
      <div class="ak-metric"><p class="ak-metric-label">Assembly Labor</p><p class="ak-metric-value">${escapeHtml(laborDisplay(tank))}</p></div>
    </div>
    <div class="wk-touch">${assemblyActionButtons(tank, teamId)}</div>
  </article>`;
}

function renderTeamCard(team) {
  const teamId = Number(team.team_id);
  const onLunch = team.on_lunch || String(team.status || '').toLowerCase() === 'lunch';
  const focused = focusedTeamId === teamId;
  const rosterNames = (team.roster || [])
    .map((e) => e.name || e.employee_name || '')
    .filter(Boolean)
    .slice(0, 8)
    .join(', ');
  const tankOptions = (eligibleTanks || [])
    .filter((t) => {
      const st = String(t.status || '').toLowerCase();
      return (
        st === 'ready_for_assembly' &&
        t.assembly_machine_id == null &&
        !t.completed_at
      );
    })
    .map((t) => `<option value="${Number(t.id)}">${escapeHtml(eligibleOptionLabel(t))}</option>`)
    .join('');
  const tanksHtml = (team.tanks || []).map((t) => renderTankCard(t, teamId)).join('');
  return `<section class="ak-team-card ${onLunch ? 'is-lunch' : 'is-working'} ${focused ? 'is-focused' : ''}" data-team-id="${teamId}">
    <div class="ak-team-head">
      <div>
        <h2 class="ak-team-title">${escapeHtml(team.team_name || `Team ${teamId}`)}</h2>
        <p class="ak-team-meta">${onLunch ? 'On lunch — timers paused for this team only' : 'Independent Assembly team card'}</p>
        <p class="ak-roster">${rosterNames ? `On shift: ${escapeHtml(rosterNames)}` : 'No open-shift employees'}</p>
      </div>
      ${teamStatusBadge(team)}
    </div>
    <div class="ak-select-panel">
      <p class="ak-select-label">Tank</p>
      <div class="ak-select-row">
        <select data-team-tank-select="${teamId}" aria-label="Select tank for team">
          <option value="">Select completed FAB tank…</option>
          ${tankOptions}
        </select>
        <button type="button" class="btn-primary btn-touch" data-ak-action="confirm_tank" data-team-id="${teamId}">CONFIRM TANK</button>
      </div>
    </div>
    <div class="ak-tank-grid">${tanksHtml || '<p class="ak-empty">No tank confirmed for this team yet.</p>'}</div>
    <div class="wk-touch" data-team-controls="${teamId}">
      ${
        onLunch
          ? `<button type="button" class="btn-primary btn-touch" data-ak-action="resume" data-team-id="${teamId}">Resume</button>`
          : `<button type="button" class="btn-secondary btn-touch" data-ak-action="lunch" data-team-id="${teamId}">Lunch</button>`
      }
      <button type="button" class="btn-secondary btn-touch btn-touch--employee-out" data-ak-action="employee_out" data-team-id="${teamId}">Employee Out</button>
      <button type="button" class="btn-secondary btn-touch" data-ak-action="end_shift" data-team-id="${teamId}">End Shift</button>
    </div>
  </section>`;
}

function renderRecentlyFinished() {
  if (!els.recentlyFinished || !els.recentlyFinishedList) return;
  const rows = recentlyFinished || [];
  if (!rows.length) {
    els.recentlyFinished.hidden = true;
    els.recentlyFinishedList.innerHTML = '';
    return;
  }
  els.recentlyFinished.hidden = false;
  els.recentlyFinishedList.innerHTML = rows
    .map((t) => {
      const tid = Number(t.id);
      return `<article class="ak-recent-card" data-tank-id="${tid}">
        <h3>Tank ${escapeHtml(t.tank_number || '—')}</h3>
        <p>Finished: ${escapeHtml(formatTs(t.assembly_completed_at))}</p>
        <p>Status: ${escapeHtml(statusLabel(t.status))}</p>
        <button type="button" class="btn-primary btn-touch" data-ak-action="restore_to_assembly" data-tank-id="${tid}">RESTORE TO ASSEMBLY</button>
      </article>`;
    })
    .join('');
  wireTouchPrevent(els.recentlyFinishedList);
}

function syncReturnRemovedButton() {
  if (!els.btnReturnRemoved || !els.returnRemovedSelect) return;
  els.btnReturnRemoved.hidden = !els.returnRemovedSelect.value;
  els.btnReturnRemoved.disabled = returnRemovedBusy;
  els.btnReturnRemoved.textContent = returnRemovedBusy ? 'Returning…' : 'Return to Assembly';
}

function renderReturnRemoved() {
  if (!els.returnRemoved || !els.returnRemovedSelect) return;
  const rows = removedTanks || [];
  if (!rows.length) {
    els.returnRemoved.hidden = true;
    els.returnRemovedSelect.innerHTML = '<option value="">Select removed tank…</option>';
    returnRemovedSignature = '';
    syncReturnRemovedButton();
    return;
  }
  els.returnRemoved.hidden = false;
  // Only rebuild options when the list changes so the 10 s poll never resets an operator's pick.
  const signature = rows.map((t) => `${Number(t.id)}:${t.tank_number}`).join('|');
  if (signature !== returnRemovedSignature) {
    const previous = els.returnRemovedSelect.value;
    els.returnRemovedSelect.innerHTML =
      '<option value="">Select removed tank…</option>' +
      rows
        .map((t) => `<option value="${Number(t.id)}">Tank ${escapeHtml(t.tank_number || '—')}</option>`)
        .join('');
    els.returnRemovedSelect.value = rows.some((t) => String(Number(t.id)) === previous) ? previous : '';
    returnRemovedSignature = signature;
  }
  syncReturnRemovedButton();
}

async function returnRemovedTank() {
  if (!els.returnRemovedSelect || returnRemovedBusy || actionBusy) return;
  const tankId = Number(els.returnRemovedSelect.value);
  const tank = (removedTanks || []).find((t) => Number(t.id) === tankId);
  if (!tank) {
    showWarning('Select a removed tank first.');
    return;
  }
  const ok = await askConfirm(
    'Return Tank to Assembly?',
    `Tank ${tank.tank_number}\n\nThe tank goes back to the Assembly tank list. It is not sent back to FAB.\nFAB completion, prior Assembly labor and history are preserved.\nNo timer or labor starts until a team confirms the tank and presses START.`,
    'Return to Assembly'
  );
  if (!ok || returnRemovedBusy || actionBusy) return;
  returnRemovedBusy = true;
  actionBusy = true;
  syncReturnRemovedButton();
  showWarning('');
  try {
    const { res, data } = await postAction({ action: 'return_removed_to_assembly', tank_id: tankId });
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || 'Could not return the tank to Assembly.');
      if (res.status === 409) await loadConfig();
      return;
    }
    removedTanks = removedTanks.filter((t) => Number(t.id) !== tankId);
    renderReturnRemoved();
    showWarning(data.message || `Tank ${tank.tank_number} returned to Assembly.`);
    await loadConfig();
  } catch (_err) {
    showWarning('Could not reach the server. Check the connection and try again.');
  } finally {
    returnRemovedBusy = false;
    actionBusy = false;
    syncReturnRemovedButton();
  }
}

function renderAll() {
  if (config && config.machine && els.machineLabel) {
    els.machineLabel.textContent = config.machine.name || 'Assembly Production';
  }
  renderRecentlyFinished();
  renderReturnRemoved();
  if (!els.teamCards) return;
  if (!activeTeams.length) {
    els.teamCards.innerHTML = '';
    if (els.teamsEmpty) els.teamsEmpty.hidden = false;
    return;
  }
  if (els.teamsEmpty) els.teamsEmpty.hidden = true;
  els.teamCards.innerHTML = activeTeams.map(renderTeamCard).join('');
  wireTouchPrevent(els.teamCards);
  els.teamCards.querySelectorAll('[data-team-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const id = Number(card.getAttribute('data-team-id'));
      if (Number.isInteger(id) && id > 0) focusedTeamId = id;
    });
  });
}

async function loadConfig() {
  const seq = ++loadConfigSeq;
  const run = (async () => {
    const { res, data } = await api(`${API}/config`, { cache: 'no-store' });
    if (seq !== loadConfigSeq) return; // newer loadConfig superseded this response
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
    applyConfigData(data);
  })();
  loadConfigInFlight = run;
  try {
    await run;
  } finally {
    if (loadConfigInFlight === run) loadConfigInFlight = null;
  }
}

async function runTeamAction(payload, okMessage) {
  if (actionBusy) return;
  actionBusy = true;
  showWarning('');
  try {
    const { res, data } = await postAction(payload);
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || 'Action failed.');
      return;
    }
    if (okMessage || data.message) showWarning(okMessage || data.message);
    await loadConfig();
  } finally {
    actionBusy = false;
  }
}

async function confirmTankForTeam(teamId) {
  const select = els.teamCards.querySelector(`[data-team-tank-select="${teamId}"]`);
  const tankId = select ? Number(select.value) : 0;
  if (!tankId) {
    showWarning('Select a tank for this team first.');
    return;
  }
  if (actionBusy) return;
  actionBusy = true;
  showWarning('');
  try {
    const { res, data } = await api(`${API}/confirm-tank`, {
      method: 'POST',
      body: JSON.stringify({ tank_id: tankId, team_id: teamId }),
    });
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || 'Could not confirm tank.');
      return;
    }
    showWarning(data.message || 'Tank confirmed. Press START for labor.');
    focusedTeamId = teamId;
    await loadConfig();
  } finally {
    actionBusy = false;
  }
}

async function openEmployeeOut(teamId) {
  employeeOutTeamId = teamId;
  employeeOutPick = null;
  if (els.employeeOutConfirm) els.employeeOutConfirm.hidden = true;
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = true;
  if (els.employeeOutHint) els.employeeOutHint.textContent = 'Select an employee on this team’s open shift.';
  openModal(els.employeeOutModal);
  const { res, data } = await api(`${API}/shift-employees?team_id=${encodeURIComponent(teamId)}`, {
    cache: 'no-store',
  });
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
        els.employeeOutConfirmText.textContent = `Clock out ${emp.name}? They leave this team’s active stage labor only.`;
      }
      if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = false;
    });
  });
}

function closeEmployeeOut() {
  employeeOutPick = null;
  employeeOutTeamId = null;
  employeeOutSubmitting = false;
  if (els.employeeOutList) els.employeeOutList.innerHTML = '';
  if (els.employeeOutEmpty) els.employeeOutEmpty.hidden = true;
  if (els.employeeOutConfirm) els.employeeOutConfirm.hidden = true;
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = true;
  closeModal(els.employeeOutModal);
}

async function confirmEmployeeOut() {
  if (!employeeOutPick || employeeOutSubmitting) return;
  employeeOutSubmitting = true;
  try {
    const { res, data } = await api(`${API}/employee-out`, {
      method: 'POST',
      body: JSON.stringify({ employee_id: employeeOutPick.id, team_id: employeeOutTeamId }),
    });
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || 'Could not clock employee out.');
      return;
    }
    showWarning(data.message || `${employeeOutPick.name} clocked out.`);
    closeEmployeeOut();
    await loadConfig();
  } finally {
    employeeOutSubmitting = false;
  }
}

async function handleTeamCardsClick(ev) {
  const btn = ev.target.closest('[data-ak-action]');
  if (!btn || actionBusy) return;
  const action = btn.getAttribute('data-ak-action');
  const teamId = Number(btn.getAttribute('data-team-id'));
  const tankId = Number(btn.getAttribute('data-tank-id'));
  focusedTeamId = teamId || focusedTeamId;

  if (action === 'confirm_tank') {
    await confirmTankForTeam(teamId);
    return;
  }
  if (action === 'start') {
    await runTeamAction(
      { action: 'start', tank_id: tankId, team_id: teamId, stage: 'ASSEMBLY' },
      'Assembly labor started for this team.'
    );
    return;
  }
  if (action === 'stop') {
    await runTeamAction({ action: 'stop', tank_id: tankId, team_id: teamId }, 'Labor stopped.');
    return;
  }
  if (action === 'finish') {
    const tankNo = btn.closest('[data-tank-id]')
      ? (btn.closest('article') && btn.closest('article').querySelector('.ak-tank-title')
          ? btn.closest('article').querySelector('.ak-tank-title').textContent
          : 'this tank')
      : 'this tank';
    const ok = await askConfirm(
      'Finish Assembly?',
      `This ends Assembly for ${tankNo} and sends the tank to Ready for Testing.`,
      'Finish'
    );
    if (!ok) return;
    await runTeamAction({ action: 'finish', tank_id: tankId, team_id: teamId }, null);
    return;
  }
  if (action === 'remove_from_assembly') {
    const titleEl = btn.closest('article') && btn.closest('article').querySelector('.ak-tank-title');
    const label = titleEl ? titleEl.textContent : `Tank ${tankId}`;
    const ok = await askConfirm(
      'Remove Tank From Assembly?',
      `${label}\n\nThis will remove the tank from the current Assembly schedule.\nProduction history already recorded will be preserved.`,
      'Remove From Assembly'
    );
    if (!ok) return;
    await runTeamAction(
      { action: 'remove_from_assembly', tank_id: tankId, team_id: teamId },
      'Tank removed from the Assembly schedule.'
    );
    return;
  }
  if (action === 'lunch') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning('Lunch must be pressed on a Team Card.');
      return;
    }
    await runTeamAction({ action: 'lunch', team_id: teamId }, 'Team lunch — this team paused only.');
    return;
  }
  if (action === 'resume') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning('Resume must be pressed on a Team Card. Do not rescan the Team barcode.');
      return;
    }
    await runTeamAction({ action: 'resume', team_id: teamId }, 'Team resumed.');
    return;
  }
  if (action === 'employee_out') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning('Employee Out must be pressed on a Team Card.');
      return;
    }
    await openEmployeeOut(teamId);
    return;
  }
  if (action === 'end_shift') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning('End Shift must be pressed on a Team Card.');
      return;
    }
    const ok = await askConfirm('End Shift for this team?', 'Stops this team’s labor and removes their card from the kiosk.');
    if (!ok) return;
    await runTeamAction({ action: 'end_shift', team_id: teamId }, 'Team end shift complete.');
  }
}

const ASSEMBLY_SCAN_ACTION_KEYWORDS = new Set([
  'confirm_tank',
  'confirm',
  'start',
  'stop',
  'finish',
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
  if (isForbiddenAssemblyScanInput(barcode)) {
    showWarning('Use the buttons for tank actions. Scan only a TEAM or EMPLOYEE barcode here.');
    return;
  }
  const { res, data } = await postAction({ action: 'scan', barcode });
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || 'Scan a Team or Employee barcode only.');
    return;
  }
  if (data.action === 'assign_team' || data.action === 'team_assigned' || data.action === 'team_present') {
    if (data.team && data.team.id) focusedTeamId = Number(data.team.id);
    else if (data.assignment && data.assignment.team_id) focusedTeamId = Number(data.assignment.team_id);
    // Render immediately from scan response — do not wait for a later poll that could race empty.
    if (Array.isArray(data.active_teams) && data.active_teams.length) {
      applyConfigData({
        ok: true,
        machine: (config && config.machine) || null,
        assignment: data.assignment || (config && config.assignment) || null,
        active_teams: data.active_teams,
        eligible_tanks: eligibleTanks,
        roster: data.roster || [],
      });
    } else if (data.assignment && data.assignment.team_id) {
      applyConfigData({
        ok: true,
        machine: (config && config.machine) || null,
        assignment: data.assignment,
        active_teams: [],
        eligible_tanks: eligibleTanks,
        roster: data.roster || [],
      });
    }
    showWarning(
      data.message ||
        'Team assigned. Select a tank from the dropdown and press CONFIRM TANK, then START for labor.'
    );
  } else if (data.action === 'employee_selected' || data.confirmer) {
    pendingConfirmer = data.confirmer || data.employee || null;
    showWarning(
      data.confirmation_line || (pendingConfirmer ? `Selected: ${pendingConfirmer.name}` : 'Employee selected.')
    );
  } else if (data.message) {
    showWarning(data.message);
  }
  await loadConfig();
}

function bindScan() {
  if (els.scanForm) {
    els.scanForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = els.manual ? els.manual.value : '';
      if (els.manual) els.manual.value = '';
      void submitScan(v);
    });
  }
  if (els.scanButton) {
    els.scanButton.addEventListener('click', () => {
      const v = els.manual ? els.manual.value : '';
      if (els.manual) els.manual.value = '';
      void submitScan(v);
    });
  }
  document.addEventListener('keydown', (ev) => {
    if (isTextEntryModalOpen()) return;
    if (ev.key === 'Enter') {
      if (scanBuffer) {
        const v = scanBuffer;
        scanBuffer = '';
        void submitScan(v);
      }
      return;
    }
    if (ev.key.length === 1) {
      const now = Date.now();
      if (now - lastKeyTime > 80) scanBuffer = '';
      lastKeyTime = now;
      scanBuffer += ev.key;
    }
  });
}

async function handleRecentlyFinishedClick(ev) {
  const btn = ev.target.closest('[data-ak-action="restore_to_assembly"]');
  if (!btn || actionBusy) return;
  const tankId = Number(btn.getAttribute('data-tank-id'));
  const card = btn.closest('article');
  const title = card && card.querySelector('h3') ? card.querySelector('h3').textContent : `Tank ${tankId}`;
  const ok = await askConfirm(
    'Restore Tank to Assembly?',
    `${title} was marked Finish and is waiting for Testing (not started yet).\n\nRestore it to Assembly?`,
    'Restore'
  );
  if (!ok) return;
  await runTeamAction(
    { action: 'restore_to_assembly', tank_id: tankId },
    'Tank restored to the Assembly selection list. Confirm the tank again.'
  );
}

function bindModals() {
  if (els.btnConfirmCancel) {
    els.btnConfirmCancel.addEventListener('click', () => {
      closeModal(els.confirmModal);
      if (confirmHandler) confirmHandler(false);
      confirmHandler = null;
    });
  }
  if (els.btnConfirmOk) {
    els.btnConfirmOk.addEventListener('click', () => {
      closeModal(els.confirmModal);
      if (confirmHandler) confirmHandler(true);
      confirmHandler = null;
    });
  }
  if (els.btnCancelEmployeeOut) els.btnCancelEmployeeOut.addEventListener('click', closeEmployeeOut);
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.addEventListener('click', () => void confirmEmployeeOut());
  if (els.teamCards) els.teamCards.addEventListener('click', (ev) => void handleTeamCardsClick(ev));
  if (els.recentlyFinishedList) {
    els.recentlyFinishedList.addEventListener('click', (ev) => void handleRecentlyFinishedClick(ev));
  }
  if (els.returnRemovedSelect) {
    els.returnRemovedSelect.addEventListener('change', syncReturnRemovedButton);
  }
  if (els.btnReturnRemoved) {
    els.btnReturnRemoved.addEventListener('click', () => void returnRemovedTank());
    wireTouchPrevent(els.returnRemoved);
  }
  if (els.logoutBtn) {
    els.logoutBtn.addEventListener('click', async () => {
      await api('/api/auth/kiosk-logout', { method: 'POST', body: '{}' });
      window.location.href = '/kiosk-login';
    });
  }
}

bindScan();
bindModals();
void loadConfig().then(() => {
  setInterval(() => void loadConfig(), 10000);
});
