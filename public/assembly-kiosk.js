'use strict';

const API = '/api/kiosk/assembly';
const KIOSK_SLUG_KEY = 'windingKioskSlug';

const AK_I18N = window.AssemblyI18n || null;
function tr(key, vars) {
  return AK_I18N ? AK_I18N.tr(key, vars) : key;
}
/** Deferred translation so a message shown on screen follows a later language switch. */
function say(key, vars) {
  return () => tr(key, vars);
}
function displayMessage(msg) {
  if (typeof msg === 'function') return msg();
  return AK_I18N ? AK_I18N.trServer(msg) : String(msg);
}

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
  lockedTesting: document.getElementById('lockedTesting'),
  lockedTestingList: document.getElementById('lockedTestingList'),
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
  if (
    activeTeams.length &&
    (!focusedTeamId || !activeTeams.some((t) => Number(t.team_id) === Number(focusedTeamId)))
  ) {
    focusedTeamId = Number(activeTeams[0].team_id);
  }
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

let lastWarning = null;

function showWarning(msg) {
  if (!els.warning) return;
  if (!msg) {
    lastWarning = null;
    els.warning.hidden = true;
    els.warning.textContent = '';
    return;
  }
  lastWarning = msg;
  els.warning.hidden = false;
  els.warning.textContent = displayMessage(msg);
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
    data = { ok: false, message: say('ak.msg.badResponse') };
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
    if (els.confirmTitle) els.confirmTitle.textContent = title || tr('ak.confirmTitle');
    if (els.confirmText) els.confirmText.textContent = text || '';
    if (els.btnConfirmOk) els.btnConfirmOk.textContent = okLabel || tr('ak.confirm');
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

const KNOWN_STATUS_LABELS = new Set([
  'ready_for_assembly',
  'assembly_in_progress',
  'ready_for_qa',
  'qa_in_progress',
  'qa_failed',
  'ready_for_testing',
  'testing_in_progress',
]);

function statusLabel(status) {
  const st = String(status || '').toLowerCase();
  if (KNOWN_STATUS_LABELS.has(st)) return tr(`ak.status.${st}`);
  return st || '—';
}

function tankLabel(tankNumber) {
  return tr('ak.tank', { tank: tankNumber || '—' });
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

function otherTeamNames(teams) {
  return (teams || []).map((t) => t.team_name || tr('ak.team', { id: t.team_id })).join(', ');
}

function eligibleOptionLabel(tank) {
  const st = String((tank && tank.status) || '').toLowerCase();
  const num = (tank && tank.tank_number) || '—';
  if (st === 'assembly_in_progress') {
    const teams = Array.isArray(tank.assembly_active_teams) ? tank.assembly_active_teams : [];
    const base = teams.length
      ? tr('ak.optInAssemblyTeams', { tank: num, teams: otherTeamNames(teams) })
      : tr('ak.optInAssembly', { tank: num });
    return tank && tank.concurrent_testing ? `${base} — ${tr('ak.optAlsoTesting')}` : base;
  }
  if (st === 'testing_in_progress') {
    // Concurrent Testing no longer locks Assembly — tank remains selectable.
    return tr('ak.optAlsoInTesting', { tank: num });
  }
  if (st === 'testing_failed') return tr('ak.optLockedTestingFailed', { tank: num });
  if (tank && tank.requires_test && tank.testing_done) {
    return tr('ak.optTestingPassed', { tank: num });
  }
  if (tank && tank.assembly_restored_at) {
    return tr('ak.optRestored', { tank: num });
  }
  return tr('ak.optReady', { tank: num });
}

function isTestingLockedTank(tank) {
  const st = String((tank && tank.status) || '').toLowerCase();
  // Only FAILED/HOLD blocks Assembly selection; concurrent Testing is allowed.
  return Boolean(tank && tank.locked) && st === 'testing_failed';
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
    return `<span class="ak-badge ak-badge--lunch">${escapeHtml(tr('ak.badge.lunch'))}</span>`;
  }
  const hasLabor = (team.tanks || []).some((t) => t.active_session);
  if (hasLabor) return `<span class="ak-badge ak-badge--working">${escapeHtml(tr('ak.badge.working'))}</span>`;
  return `<span class="ak-badge ak-badge--active">${escapeHtml(tr('ak.badge.active'))}</span>`;
}

function assemblyActionButtons(tank, teamId) {
  const status = String(tank.status || '').toLowerCase();
  const session = tank.active_session || null;
  const stage = session ? String(session.stage || '').toUpperCase() : '';
  const tid = Number(tank.id);
  const btns = [];
  const label = (key) => escapeHtml(tr(key));
  if (status === 'assembly_in_progress' && !session) {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--start-work" data-ak-action="start" data-tank-id="${tid}" data-team-id="${teamId}" data-stage="ASSEMBLY">${label('ak.btn.start')}</button>`
    );
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-ak-action="finish" data-tank-id="${tid}" data-team-id="${teamId}">${label('ak.btn.finish')}</button>`
    );
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-ak-action="remove_from_assembly" data-tank-id="${tid}" data-team-id="${teamId}">${label('ak.btn.remove')}</button>`
    );
  }
  if (session && stage === 'ASSEMBLY') {
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-ak-action="stop" data-tank-id="${tid}" data-team-id="${teamId}">${label('ak.btn.stop')}</button>`
    );
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-ak-action="finish" data-tank-id="${tid}" data-team-id="${teamId}">${label('ak.btn.finish')}</button>`
    );
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-ak-action="remove_from_assembly" data-tank-id="${tid}" data-team-id="${teamId}">${label('ak.btn.remove')}</button>`
    );
  }
  return btns.join('');
}

function renderTankCard(tank, teamId) {
  const status = String(tank.status || '').toLowerCase();
  const session = tank.active_session || null;
  const active = Boolean(session) && String(session.stage || '').toUpperCase() === 'ASSEMBLY';
  return `<article class="ak-tank-card ${active ? 'is-active' : ''}" data-tank-id="${Number(tank.id)}">
    <div class="ak-tank-head">
      <h3 class="ak-tank-title">${escapeHtml(tankLabel(tank.tank_number))}</h3>
      <span class="ak-tank-status">${escapeHtml(statusLabel(status))}</span>
    </div>
    <div class="ak-metrics">
      <div class="ak-metric"><span class="ak-metric-label">${escapeHtml(tr('ak.metric.duration'))}</span><span class="ak-metric-value">${escapeHtml(liveAssemblyDurationDisplay(tank))}</span></div>
      <div class="ak-metric"><span class="ak-metric-label">${escapeHtml(tr('ak.metric.labor'))}</span><span class="ak-metric-value">${escapeHtml(laborDisplay(tank))}</span></div>
    </div>
    ${
      Array.isArray(tank.assembly_other_teams) && tank.assembly_other_teams.length
        ? `<p class="ak-tank-stage">${escapeHtml(tr('ak.alsoWorking', { teams: otherTeamNames(tank.assembly_other_teams) }))}${
            tank.tank_labor_display ? escapeHtml(tr('ak.tankTotalLabor', { labor: tank.tank_labor_display })) : ''
          }</p>`
        : ''
    }
    <div class="wk-touch ak-actions">${assemblyActionButtons(tank, teamId)}</div>
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
      if (t.completed_at) return false;
      if (st === 'ready_for_assembly') return t.assembly_machine_id == null;
      // Other teams may join a tank already in Assembly; hide it only from teams already on it.
      if (st === 'assembly_in_progress') {
        const onTank = (t.assembly_active_teams || []).some((a) => Number(a.team_id) === teamId);
        const onCard = (team.tanks || []).some((ct) => Number(ct.id) === Number(t.id));
        return !onTank && !onCard;
      }
      // Shown greyed out so the team can see why the tank is not available.
      return isTestingLockedTank(t);
    })
    .map((t) =>
      isTestingLockedTank(t)
        ? `<option value="${Number(t.id)}" disabled>${escapeHtml(eligibleOptionLabel(t))}</option>`
        : `<option value="${Number(t.id)}">${escapeHtml(eligibleOptionLabel(t))}</option>`
    )
    .join('');
  const tanksHtml = (team.tanks || []).map((t) => renderTankCard(t, teamId)).join('');
  return `<section class="ak-team-card ${onLunch ? 'is-lunch' : 'is-working'} ${focused ? 'is-focused' : ''}" data-team-id="${teamId}">
    <div class="ak-team-head">
      <h2 class="ak-team-title">${escapeHtml(team.team_name || tr('ak.team', { id: teamId }))}</h2>
      <div class="ak-team-badges">
        <span class="ak-badge ak-badge--selected" data-selected-badge ${focused ? '' : 'hidden'}>${escapeHtml(tr('ak.badge.selected'))}</span>
        ${teamStatusBadge(team)}
      </div>
    </div>
    ${onLunch ? `<p class="ak-team-meta">${escapeHtml(tr('ak.onLunch'))}</p>` : ''}
    <p class="ak-roster"><span class="ak-roster-label">${escapeHtml(tr('ak.onShift'))}</span> ${escapeHtml(rosterNames || tr('ak.noOpenShift'))}</p>
    <div class="ak-select-panel">
      <div class="ak-select-row">
        <select data-team-tank-select="${teamId}" aria-label="${escapeHtml(tr('ak.selectTankForTeam'))}">
          <option value="">${escapeHtml(tr('ak.selectFabTank'))}</option>
          ${tankOptions}
        </select>
        <button type="button" class="btn-primary btn-touch" data-ak-action="confirm_tank" data-team-id="${teamId}">${escapeHtml(tr('ak.btn.confirmTank'))}</button>
      </div>
    </div>
    <div class="ak-tank-grid">${tanksHtml || `<p class="ak-empty">${escapeHtml(tr('ak.noTankYet'))}</p>`}</div>
    <div class="wk-touch ak-team-actions" data-team-controls="${teamId}">
      ${
        onLunch
          ? `<button type="button" class="btn-primary btn-touch" data-ak-action="resume" data-team-id="${teamId}">${escapeHtml(tr('ak.btn.resume'))}</button>`
          : `<button type="button" class="btn-secondary btn-touch" data-ak-action="lunch" data-team-id="${teamId}">${escapeHtml(tr('ak.btn.lunch'))}</button>`
      }
      <button type="button" class="btn-secondary btn-touch btn-touch--employee-out" data-ak-action="employee_out" data-team-id="${teamId}">${escapeHtml(tr('ak.btn.employeeOut'))}</button>
      <button type="button" class="btn-secondary btn-touch" data-ak-action="end_shift" data-team-id="${teamId}">${escapeHtml(tr('ak.btn.endShift'))}</button>
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
        <h3>${escapeHtml(tankLabel(t.tank_number))}</h3>
        <p>${escapeHtml(tr('ak.finishedAt', { ts: formatTs(t.assembly_completed_at) }))}</p>
        <p>${escapeHtml(tr('ak.statusLine', { status: statusLabel(t.status) }))}</p>
        <button type="button" class="btn-primary btn-touch" data-ak-action="restore_to_assembly" data-tank-id="${tid}">${escapeHtml(tr('ak.btn.restore'))}</button>
      </article>`;
    })
    .join('');
  wireTouchPrevent(els.recentlyFinishedList);
}

function renderLockedTesting() {
  if (!els.lockedTesting || !els.lockedTestingList) return;
  const rows = (eligibleTanks || []).filter(isTestingLockedTank);
  if (!rows.length) {
    els.lockedTesting.hidden = true;
    els.lockedTestingList.innerHTML = '';
    return;
  }
  els.lockedTesting.hidden = false;
  els.lockedTestingList.innerHTML = rows
    .map((t) => {
      const failed = String(t.status || '').toLowerCase() === 'testing_failed';
      return `<article class="ak-locked-card" data-locked-tank-id="${Number(t.id)}" aria-disabled="true">
        <div class="ak-locked-head">
          <h3>${escapeHtml(tankLabel(t.tank_number))}</h3>
          <span class="ak-locked-badge">${escapeHtml(tr('ak.lockedBadge'))}</span>
        </div>
        <p class="ak-locked-reason">${escapeHtml(tr(failed ? 'ak.lockedTestingFailedReason' : 'ak.lockedTestingReason'))}</p>
      </article>`;
    })
    .join('');
}

function syncReturnRemovedButton() {
  if (!els.btnReturnRemoved || !els.returnRemovedSelect) return;
  els.btnReturnRemoved.hidden = !els.returnRemovedSelect.value;
  els.btnReturnRemoved.disabled = returnRemovedBusy;
  els.btnReturnRemoved.textContent = returnRemovedBusy ? tr('ak.returning') : tr('ak.returnBtn');
}

function renderReturnRemoved() {
  if (!els.returnRemoved || !els.returnRemovedSelect) return;
  const rows = removedTanks || [];
  if (!rows.length) {
    els.returnRemoved.hidden = true;
    els.returnRemovedSelect.innerHTML = `<option value="">${escapeHtml(tr('ak.selectRemoved'))}</option>`;
    returnRemovedSignature = '';
    syncReturnRemovedButton();
    return;
  }
  els.returnRemoved.hidden = false;
  // Only rebuild options when the list changes so the 10 s poll never resets an operator's pick.
  const signature = `${tr('ak.selectRemoved')}|${rows.map((t) => `${Number(t.id)}:${t.tank_number}`).join('|')}`;
  if (signature !== returnRemovedSignature) {
    const previous = els.returnRemovedSelect.value;
    els.returnRemovedSelect.innerHTML =
      `<option value="">${escapeHtml(tr('ak.selectRemoved'))}</option>` +
      rows
        .map((t) => `<option value="${Number(t.id)}">${escapeHtml(tankLabel(t.tank_number))}</option>`)
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
    showWarning(say('ak.msg.selectRemovedFirst'));
    return;
  }
  const ok = await askConfirm(
    tr('ak.msg.returnTitle'),
    tr('ak.msg.returnBody', { tank: tank.tank_number }),
    tr('ak.returnBtn')
  );
  if (!ok || returnRemovedBusy || actionBusy) return;
  returnRemovedBusy = true;
  actionBusy = true;
  syncReturnRemovedButton();
  showWarning('');
  try {
    const { res, data } = await postAction({ action: 'return_removed_to_assembly', tank_id: tankId });
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || say('ak.msg.returnFailed'));
      if (res.status === 409) await loadConfig();
      return;
    }
    removedTanks = removedTanks.filter((t) => Number(t.id) !== tankId);
    renderReturnRemoved();
    showWarning(data.message || say('ak.msg.returned', { tank: tank.tank_number }));
    await loadConfig();
  } catch (_err) {
    showWarning(say('ak.msg.offline'));
  } finally {
    returnRemovedBusy = false;
    actionBusy = false;
    syncReturnRemovedButton();
  }
}

function renderMachineLabel() {
  if (!els.machineLabel) return;
  els.machineLabel.textContent = (config && config.machine && config.machine.name) || tr('ak.subtitle');
}

function renderAll() {
  renderMachineLabel();
  renderRecentlyFinished();
  renderLockedTesting();
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
  els.teamCards.querySelectorAll('section.ak-team-card[data-team-id]').forEach((card) => {
    card.addEventListener('click', (ev) => {
      // Buttons / tank picker act on their own card without changing the selection.
      if (ev.target.closest('button, select, option, input, label')) return;
      selectTeam(Number(card.getAttribute('data-team-id')));
    });
  });
}

/** SELECTED TEAM — employee barcode scans join this team. Only one at a time. */
function selectTeam(teamId) {
  if (!Number.isInteger(teamId) || teamId <= 0 || teamId === focusedTeamId) return;
  focusedTeamId = teamId;
  if (!els.teamCards) return;
  els.teamCards.querySelectorAll('section.ak-team-card[data-team-id]').forEach((card) => {
    const on = Number(card.getAttribute('data-team-id')) === teamId;
    card.classList.toggle('is-focused', on);
    const badge = card.querySelector('[data-selected-badge]');
    if (badge) badge.hidden = !on;
  });
  const team = activeTeams.find((t) => Number(t.team_id) === teamId);
  const teamName = team && team.team_name;
  showWarning(() => tr('ak.msg.teamSelected', { team: teamName || tr('ak.teamFallback') }));
}

async function loadConfig() {
  const seq = ++loadConfigSeq;
  const run = (async () => {
    const { res, data } = await api(`${API}/config`, { cache: 'no-store' });
    if (seq !== loadConfigSeq) return; // newer loadConfig superseded this response
    if (res.status === 409 && data && data.workflow === 'winding') {
      showWarning(data.message || say('ak.msg.windingRedirect'));
      const slug = (config && config.machine && config.machine.slug) || null;
      if (slug) window.location.href = `/kiosk/machine/${encodeURIComponent(slug)}`;
      return;
    }
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || say('ak.msg.loadFailed'));
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
      showWarning((data && data.message) || say('ak.msg.actionFailed'));
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
    showWarning(say('ak.msg.selectTankFirst'));
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
      showWarning((data && data.message) || say('ak.msg.confirmFailed'));
      return;
    }
    showWarning(data.message || say('ak.msg.tankConfirmed'));
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
  if (els.employeeOutHint) els.employeeOutHint.textContent = tr('ak.employeeOutHint');
  openModal(els.employeeOutModal);
  const { res, data } = await api(`${API}/shift-employees?team_id=${encodeURIComponent(teamId)}`, {
    cache: 'no-store',
  });
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || say('ak.msg.loadEmployeesFailed'));
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
        els.employeeOutConfirmText.textContent = tr('ak.msg.clockOutQuestion', { name: emp.name });
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
      showWarning((data && data.message) || say('ak.msg.clockOutFailed'));
      return;
    }
    showWarning(data.message || say('ak.msg.clockedOut', { name: employeeOutPick.name }));
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

  if (action === 'confirm_tank') {
    await confirmTankForTeam(teamId);
    return;
  }
  if (action === 'start') {
    await runTeamAction(
      { action: 'start', tank_id: tankId, team_id: teamId, stage: 'ASSEMBLY' },
      say('ak.msg.laborStarted')
    );
    return;
  }
  if (action === 'stop') {
    await runTeamAction({ action: 'stop', tank_id: tankId, team_id: teamId }, say('ak.msg.laborStopped'));
    return;
  }
  if (action === 'finish') {
    const tankNo = btn.closest('[data-tank-id]')
      ? (btn.closest('article') && btn.closest('article').querySelector('.ak-tank-title')
          ? btn.closest('article').querySelector('.ak-tank-title').textContent
          : tr('ak.thisTank'))
      : tr('ak.thisTank');
    const teamRow = (activeTeams || []).find((t) => Number(t.team_id) === teamId);
    const tankRow = teamRow ? (teamRow.tanks || []).find((t) => Number(t.id) === tankId) : null;
    const others = tankRow && Array.isArray(tankRow.assembly_other_teams) ? tankRow.assembly_other_teams : [];
    const ok = await askConfirm(
      tr('ak.msg.finishTitle'),
      others.length
        ? tr('ak.msg.finishOthers', { tank: tankNo, teams: otherTeamNames(others) })
        : tankRow && tankRow.testing_pending === false
          ? tr('ak.msg.finishLastQa', { tank: tankNo })
          : tr('ak.msg.finishLast', { tank: tankNo }),
      tr('ak.msg.finishOk')
    );
    if (!ok) return;
    await runTeamAction({ action: 'finish', tank_id: tankId, team_id: teamId }, null);
    return;
  }
  if (action === 'remove_from_assembly') {
    const titleEl = btn.closest('article') && btn.closest('article').querySelector('.ak-tank-title');
    const label = titleEl ? titleEl.textContent : tankLabel(tankId);
    const ok = await askConfirm(
      tr('ak.msg.removeTitle'),
      tr('ak.msg.removeBody', { tank: label }),
      tr('ak.msg.removeOk')
    );
    if (!ok) return;
    await runTeamAction(
      { action: 'remove_from_assembly', tank_id: tankId, team_id: teamId },
      say('ak.msg.removed')
    );
    return;
  }
  if (action === 'lunch') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning(say('ak.msg.lunchOnCard'));
      return;
    }
    await runTeamAction({ action: 'lunch', team_id: teamId }, say('ak.msg.lunchStarted'));
    return;
  }
  if (action === 'resume') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning(say('ak.msg.resumeOnCard'));
      return;
    }
    await runTeamAction({ action: 'resume', team_id: teamId }, say('ak.msg.resumed'));
    return;
  }
  if (action === 'employee_out') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning(say('ak.msg.outOnCard'));
      return;
    }
    await openEmployeeOut(teamId);
    return;
  }
  if (action === 'end_shift') {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      showWarning(say('ak.msg.endShiftOnCard'));
      return;
    }
    const ok = await askConfirm(tr('ak.msg.endShiftTitle'), tr('ak.msg.endShiftBody'));
    if (!ok) return;
    await runTeamAction({ action: 'end_shift', team_id: teamId }, say('ak.msg.endShiftDone'));
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
    showWarning(say('ak.msg.useButtons'));
    return;
  }
  const { res, data } = await postAction({
    action: 'scan',
    barcode,
    team_id: Number.isInteger(focusedTeamId) && focusedTeamId > 0 ? focusedTeamId : undefined,
  });
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || say('ak.msg.scanTeamOrEmployee'));
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
    showWarning(data.message || say('ak.msg.teamAssigned'));
  } else if (data.action === 'employee_selected' || data.confirmer) {
    pendingConfirmer = data.confirmer || data.employee || null;
    showWarning(
      data.confirmation_line ||
        (pendingConfirmer
          ? say('ak.msg.selectedEmployee', { name: pendingConfirmer.name })
          : say('ak.msg.employeeSelected'))
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
  const title = card && card.querySelector('h3') ? card.querySelector('h3').textContent : tankLabel(tankId);
  const ok = await askConfirm(
    tr('ak.msg.restoreTitle'),
    tr('ak.msg.restoreBody', { tank: title }),
    tr('ak.msg.restoreOk')
  );
  if (!ok) return;
  await runTeamAction(
    { action: 'restore_to_assembly', tank_id: tankId },
    say('ak.msg.restored')
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

function bindLanguage() {
  const fi = window.FactoryI18n;
  if (!fi) return;
  fi.mountSelector('kioskLangMount');
  fi.applyDom();
  renderMachineLabel();
  syncReturnRemovedButton();
  window.addEventListener('factory-lang-change', () => {
    renderAll();
    syncReturnRemovedButton();
    if (lastWarning) showWarning(lastWarning);
    // Badge scanners type into the focused element; never leave the language picker focused.
    const active = document.activeElement;
    if (active && active.id === 'factoryLangSelect' && typeof active.blur === 'function') active.blur();
  });
}

bindScan();
bindModals();
bindLanguage();
void loadConfig().then(() => {
  setInterval(() => void loadConfig(), 10000);
});
