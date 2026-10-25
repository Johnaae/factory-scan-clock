'use strict';

const API = '/api/kiosk/dome';
const KIOSK_SLUG_KEY = 'windingKioskSlug';

const DI = window.DomeI18n;
const tr = (key, vars) => (DI ? DI.tr(key, vars) : key);

const $ = (id) => document.getElementById(id);
const els = {
  machineLabel: $('machineLabel'),
  manual: $('manualBarcodeInput'),
  scanForm: $('scanForm'),
  scannerTrap: $('scannerTrap'),
  warning: $('scanWarning'),
  teamCards: $('teamCards'),
  teamsEmpty: $('teamsEmpty'),
  legacyTeamsSection: $('legacyTeamsSection'),
  activeDomes: $('activeDomes'),
  domesEmpty: $('domesEmpty'),
  activeBulkheads: $('activeBulkheads'),
  bulkheadsEmpty: $('bulkheadsEmpty'),
  btnCreateDome: $('btnCreateDome'),
  btnCreateBulkhead: $('btnCreateBulkhead'),
  btnBoardLunch: $('btnBoardLunch'),
  bhCreateModal: $('bhCreateModal'),
  bhCreateForm: $('bhCreateForm'),
  bhCreateNumber: $('bhCreateNumber'),
  bhCreateSelected: $('bhCreateSelected'),
  bhCreateEmpSearch: $('bhCreateEmpSearch'),
  bhCreateFabs: $('bhCreateFabs'),
  bhCreateNotes: $('bhCreateNotes'),
  bhCreateError: $('bhCreateError'),
  btnBoardResume: $('btnBoardResume'),
  btnBoardEndShift: $('btnBoardEndShift'),
  otherSection: $('otherSection'),
  otherHint: $('otherHint'),
  otherCards: $('otherCards'),
  recentSection: $('recentSection'),
  recentList: $('recentList'),
  logoutBtn: $('logoutBtn'),
  createModal: $('createModal'),
  createForm: $('createForm'),
  createTitle: $('createTitle'),
  createNumber: $('createNumber'),
  createTypes: $('createTypes'),
  createDiameters: $('createDiameters'),
  createAutoFab: $('createAutoFab'),
  createFabHint: $('createFabHint'),
  createSelected: $('createSelected'),
  createEmpSearch: $('createEmpSearch'),
  createFabs: $('createFabs'),
  createNotes: $('createNotes'),
  createError: $('createError'),
  completeModal: $('completeModal'),
  completeForm: $('completeForm'),
  completeText: $('completeText'),
  completeWeight: $('completeWeight'),
  completeError: $('completeError'),
  fabsModal: $('fabsModal'),
  fabsForm: $('fabsForm'),
  fabsTitle: $('fabsTitle'),
  fabsChips: $('fabsChips'),
  fabsError: $('fabsError'),
  outModal: $('outModal'),
  outTitle: $('outTitle'),
  outList: $('outList'),
  outEmpty: $('outEmpty'),
  outConfirmText: $('outConfirmText'),
  outSubmit: $('outSubmit'),
  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmText: $('confirmText'),
  confirmOk: $('confirmOk'),
  confirmCancel: $('confirmCancel'),
};

/** Scan input is TEAM / EMPLOYEE only (Assembly rule) — actions are team-card buttons. */
const SCAN_ACTION_KEYWORDS = new Set(['start', 'stop', 'finish', 'complete', 'lunch', 'resume', 'end_shift', 'pause', 'break']);

let config = null;
let activeTeams = [];
let focusedTeamId = null;
let fetchedAt = 0;
let busy = false;
let lastWarning = null;
let scanBuffer = '';
let lastKeyTime = 0;
let confirmResolve = null;
const createState = { teamId: null, type: null, diameter: null, fabs: new Set(), manual: true, search: '' };
const bhCreateState = { fabs: new Set(), search: '' };
const MAX_FABRICATORS = 3;
let fabsDome = null;
const fabsSelected = new Set();
let completeDomeRef = null;
let fabsBulkhead = null;
/** Transfer notices already shown on this kiosk session (from config.transfer_notices). */
const seenTransferNoticeIds = new Set();
let outTeam = null;
let outPick = null;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Warnings are stored as functions so they follow a later language switch. */
function showWarning(msg) {
  lastWarning = msg || null;
  if (!els.warning) return;
  const text = typeof msg === 'function' ? msg() : msg;
  els.warning.hidden = !text;
  els.warning.textContent = text || '';
}

/** Translated response message, plus what happened to dome labor on a move / Employee Out. */
function responseText(data, ctx) {
  const base = DI ? DI.msg(data, ctx) : (data && data.message) || '';
  if (!data || !data.ok) return base;
  const extra = [];
  if (data.dome_joined) extra.push(tr('dk.msg.joinedDome', { dome: data.dome_joined }));
  if (Array.isArray(data.dome_stopped) && data.dome_stopped.length) {
    extra.push(tr('dk.msg.domeStopped', { list: data.dome_stopped.join(', ') }));
  }
  return [base, ...extra].filter(Boolean).join(' ');
}

function responseMessage(data, ctx) {
  return () => responseText(data, ctx);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...opts,
    headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_err) {
    data = { ok: false, message: tr('dome.badResponse') };
  }
  return { res, data };
}

function postAction(body) {
  return api(`${API}/action`, { method: 'POST', body: JSON.stringify(body) });
}

function anyModalOpen() {
  return [els.createModal, els.bhCreateModal, els.completeModal, els.fabsModal, els.outModal, els.confirmModal].some(
    (m) => m && !m.hidden
  );
}

function openModal(el) {
  el.hidden = false;
  el.classList.add('show');
  try {
    if (els.manual) els.manual.blur();
    if (els.scannerTrap) els.scannerTrap.blur();
  } catch (_err) {
    /* ignore */
  }
}

function closeModal(el) {
  el.classList.remove('show');
  el.hidden = true;
}

function askConfirm(title, text, okLabel) {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmText.textContent = text;
    els.confirmOk.textContent = okLabel || tr('dome.confirm');
    confirmResolve = resolve;
    openModal(els.confirmModal);
  });
}

function finishConfirm(value) {
  closeModal(els.confirmModal);
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(value);
}

/** Touch screens: fire the click on touchend so a tap never needs a second press (Assembly kiosk). */
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

function formatMs(ms) {
  const totalMin = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`;
}

/** Live production time: server total at fetch time + elapsed since, while the dome is running. */
function liveProductionMs(d) {
  const base = Number(d.production_ms) || 0;
  if (d.production_status !== 'in_progress' || !d.active_since) return base;
  return base + Math.max(0, Date.now() - fetchedAt);
}

function formatClock(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString(DI && DI.lang() === 'es' ? 'es-MX' : 'en-US', { hour: 'numeric', minute: '2-digit' });
}

function teamById(id) {
  return activeTeams.find((t) => Number(t.team_id) === Number(id)) || null;
}

function allDomes() {
  return (config && config.domes) || [];
}

function domeById(id) {
  return allDomes().find((d) => Number(d.id) === Number(id)) || null;
}

function renderMachineLabel() {
  if (!els.machineLabel) return;
  const name = config && config.machine ? config.machine.name : '';
  els.machineLabel.textContent = name ? `${tr('dk.subtitle')} — ${name}` : tr('dk.subtitle');
}

// ---------------------------------------------------------------- Dome cards

function domeCardClass(d) {
  if (d.production_status === 'in_progress') return 'is-active';
  if (d.production_status === 'paused' && d.pause_reason === 'lunch') return 'is-lunch';
  return '';
}

/** One dome card. teamId optional (legacy); Start Dome uses selected fabricators when omitted. */
function renderDomeCard(d, teamId) {
  const spec = [DI.typeLabel(d.dome_type), d.diameter_label].filter(Boolean).join(' · ');
  const running = d.production_status === 'in_progress';
  const people = running && d.working && d.working.length ? d.working : d.fabricators || [];
  const peopleLabel = running && d.working && d.working.length ? tr('dk.working') : tr('dome.field.fabricators');
  const names = people.map((f) => f.name).join(', ') || '—';
  const since = running && d.active_since ? ` · ${tr('dk.since', { time: formatClock(d.active_since) })}` : '';
  const tidAttr = teamId != null && teamId !== '' ? ` data-team-id="${Number(teamId)}"` : '';
  const btns = [];
  if (running) {
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-dk-dome="stop" data-dome-id="${d.id}"${tidAttr}>${escapeHtml(tr('dk.btn.stop'))}</button>`
    );
  } else {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--start-work" data-dk-dome="start" data-dome-id="${d.id}"${tidAttr}>${escapeHtml(tr('dk.btn.start'))}</button>`
    );
  }
  if (d.started_at) {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-dk-dome="complete" data-dome-id="${d.id}">${escapeHtml(tr('dk.btn.complete'))}</button>`
    );
  }
  btns.push(
    `<button type="button" class="btn-secondary btn-touch" data-dk-dome="fabricators" data-dome-id="${d.id}" style="grid-column: 1 / -1">${escapeHtml(tr('dk.btn.fabricators'))}</button>`
  );
  const notesHtml = d.notes
    ? `<p class="dk-notes-preview"><span class="ak-roster-label">${escapeHtml(tr('dome.field.notes'))}:</span> ${escapeHtml(d.notes)}</p>`
    : '';
  return `<article class="ak-tank-card ${domeCardClass(d)}" data-dome-id="${d.id}">
    <div class="ak-tank-head">
      <h3 class="ak-tank-title">${escapeHtml(tr('dome.label', { dome: d.dome_number }))}</h3>
      <span class="ak-tank-status">${escapeHtml(DI.productionLabel(d))}</span>
    </div>
    <p class="ak-tank-stage">${escapeHtml(spec)}${escapeHtml(since)}</p>
    <p class="ak-tank-stage"><span class="ak-roster-label">${escapeHtml(peopleLabel)}:</span> ${escapeHtml(names)}</p>
    ${notesHtml}
    <div class="ak-metrics">
      <div class="ak-metric">
        <span class="ak-metric-label">${escapeHtml(tr('dome.field.productionTime'))}</span>
        <span class="ak-metric-value" data-live-ms="${d.id}">${escapeHtml(formatMs(liveProductionMs(d)))}</span>
      </div>
      <div class="ak-metric">
        <span class="ak-metric-label">${escapeHtml(tr('dome.field.labor'))}</span>
        <span class="ak-metric-value">${escapeHtml(d.labor_display || '0h 0m')}</span>
      </div>
    </div>
    <div class="dk-dome-actions">${btns.join('')}</div>
  </article>`;
}

// ---------------------------------------------------------------- Team cards (Assembly layout)

function teamStatusBadge(team) {
  if (team.on_lunch) return `<span class="ak-badge ak-badge--lunch">${escapeHtml(tr('dk.badge.lunch'))}</span>`;
  if (team.working) return `<span class="ak-badge ak-badge--working">${escapeHtml(tr('dk.badge.working'))}</span>`;
  return `<span class="ak-badge ak-badge--active">${escapeHtml(tr('dk.badge.active'))}</span>`;
}

function renderTeamCard(team) {
  const teamId = Number(team.team_id);
  const focused = focusedTeamId === teamId;
  const rosterNames = (team.roster || []).map((e) => e.name).filter(Boolean).join(', ');
  const domesHtml = (team.domes || []).map((d) => renderDomeCard(d, teamId)).join('');
  const cls = team.on_lunch ? 'is-lunch' : 'is-working';
  return `<section class="ak-team-card ${cls} ${focused ? 'is-focused' : ''}" data-team-id="${teamId}">
    <div class="ak-team-head">
      <h2 class="ak-team-title">${escapeHtml(team.team_name || '')}</h2>
      <div class="ak-team-badges">
        <span class="ak-badge ak-badge--selected" data-selected-badge ${focused ? '' : 'hidden'}>${escapeHtml(tr('dk.badge.selected'))}</span>
        ${teamStatusBadge(team)}
      </div>
    </div>
    ${team.on_lunch ? `<p class="ak-team-meta">${escapeHtml(tr('dk.onLunch'))}</p>` : ''}
    <p class="ak-roster"><span class="ak-roster-label">${escapeHtml(tr('dk.onShift'))}</span> ${escapeHtml(rosterNames || tr('dk.noOpenShift'))}</p>
    <button type="button" class="btn-touch btn-touch--create" data-dk="create" data-team-id="${teamId}">${escapeHtml(tr('dk.btn.create'))}</button>
    <div class="ak-tank-grid">${domesHtml || `<p class="ak-empty">${escapeHtml(tr('dk.teamNoDomes'))}</p>`}</div>
    <div class="wk-touch ak-team-actions">
      ${
        team.on_lunch
          ? `<button type="button" class="btn-primary btn-touch" data-dk="resume" data-team-id="${teamId}">${escapeHtml(tr('dk.btn.resume'))}</button>`
          : `<button type="button" class="btn-secondary btn-touch" data-dk="lunch" data-team-id="${teamId}">${escapeHtml(tr('dk.btn.lunch'))}</button>`
      }
      <button type="button" class="btn-secondary btn-touch btn-touch--employee-out" data-dk="employee_out" data-team-id="${teamId}">${escapeHtml(tr('dk.btn.employeeOut'))}</button>
      <button type="button" class="btn-secondary btn-touch" data-dk="end_shift" data-team-id="${teamId}">${escapeHtml(tr('dk.btn.endShift'))}</button>
    </div>
  </section>`;
}

function renderActiveDomes() {
  const list = (config && Array.isArray(config.domes) ? config.domes : []).slice();
  if (els.domesEmpty) els.domesEmpty.hidden = list.length > 0;
  if (els.activeDomes) {
    els.activeDomes.innerHTML = list.map((d) => renderDomeCard(d, null)).join('');
    wireTouchPrevent(els.activeDomes);
  }
}

function renderBulkheadCard(b) {
  const running = b.production_status === 'in_progress';
  const people = running && b.working && b.working.length ? b.working : b.workers || [];
  const peopleLabel = running && b.working && b.working.length ? tr('dk.working') : tr('dome.field.fabricators');
  const names = people.map((f) => f.name || f.employee_name).join(', ') || '—';
  const since = running && b.active_since ? ` · ${tr('dk.since', { time: formatClock(b.active_since) })}` : '';
  const btns = [];
  if (running) {
    btns.push(
      `<button type="button" class="btn-secondary btn-touch" data-dk-bh="stop" data-bh-id="${b.id}">${escapeHtml(tr('dk.btn.stop'))}</button>`
    );
  } else {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--start-work" data-dk-bh="start" data-bh-id="${b.id}">${escapeHtml(tr('dk.btn.start'))}</button>`
    );
  }
  if (b.started_at) {
    btns.push(
      `<button type="button" class="btn-primary btn-touch btn-touch--complete" data-dk-bh="finish" data-bh-id="${b.id}">${escapeHtml(tr('dk.btn.finishBulkhead'))}</button>`
    );
  }
  btns.push(
    `<button type="button" class="btn-secondary btn-touch" data-dk-bh="workers" data-bh-id="${b.id}" style="grid-column: 1 / -1">${escapeHtml(tr('dk.btn.fabricators'))}</button>`
  );
  const notesHtml = b.notes
    ? `<p class="dk-notes-preview"><span class="ak-roster-label">${escapeHtml(tr('dome.field.notes'))}:</span> ${escapeHtml(b.notes)}</p>`
    : '';
  return `<article class="ak-tank-card ${domeCardClass(b)}" data-bh-id="${b.id}">
    <div class="ak-tank-head">
      <h3 class="ak-tank-title">${escapeHtml(tr('bi.label', { n: b.bulkhead_number }))}</h3>
      <span class="ak-tank-status">${escapeHtml(DI.productionLabel(b))}</span>
    </div>
    <p class="ak-tank-stage">${escapeHtml(tr('dk.bulkhead.kind'))}${escapeHtml(since)}</p>
    <p class="ak-tank-stage"><span class="ak-roster-label">${escapeHtml(peopleLabel)}:</span> ${escapeHtml(names)}</p>
    ${notesHtml}
    <div class="ak-metrics">
      <div class="ak-metric">
        <span class="ak-metric-label">${escapeHtml(tr('dome.field.productionTime'))}</span>
        <span class="ak-metric-value" data-live-bh-ms="${b.id}">${escapeHtml(formatMs(liveProductionMs(b)))}</span>
      </div>
      <div class="ak-metric">
        <span class="ak-metric-label">${escapeHtml(tr('dome.field.labor'))}</span>
        <span class="ak-metric-value">${escapeHtml(b.labor_display || '0h 0m')}</span>
      </div>
    </div>
    <div class="dk-dome-actions">${btns.join('')}</div>
  </article>`;
}

function renderActiveBulkheads() {
  const list = (config && Array.isArray(config.bulkheads) ? config.bulkheads : []).slice();
  if (els.bulkheadsEmpty) els.bulkheadsEmpty.hidden = list.length > 0;
  if (els.activeBulkheads) {
    els.activeBulkheads.innerHTML = list.map((b) => renderBulkheadCard(b)).join('');
    wireTouchPrevent(els.activeBulkheads);
  }
}

function renderTeams() {
  const showLegacy = activeTeams.length > 0;
  if (els.legacyTeamsSection) els.legacyTeamsSection.hidden = !showLegacy;
  if (!els.teamCards) return;
  if (els.teamsEmpty) els.teamsEmpty.hidden = activeTeams.length > 0;
  els.teamCards.innerHTML = activeTeams.map(renderTeamCard).join('');
  wireTouchPrevent(els.teamCards);
  els.teamCards.querySelectorAll('section.ak-team-card[data-team-id]').forEach((card) => {
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('button, select, option, input, label')) return;
      selectTeam(Number(card.getAttribute('data-team-id')));
    });
  });
}

function renderOther() {
  // Domes already listed on the active board — hide legacy "other" section.
  if (els.otherSection) els.otherSection.hidden = true;
  if (els.otherCards) els.otherCards.innerHTML = '';
}

function renderRecent() {
  const list = (config && config.recently_completed) || [];
  els.recentSection.hidden = !list.length;
  els.recentList.innerHTML = list
    .map(
      (d) => `<div class="dk-recent-row">
        <span>${escapeHtml(tr('dome.label', { dome: d.dome_number }))} · ${escapeHtml(DI.describe(d))}${
          d.notes ? ` · ${escapeHtml(d.notes)}` : ''
        }</span>
        <span class="ak-badge ak-badge--available">${escapeHtml(DI.inventoryLabel(d.inventory_status))}</span>
      </div>`
    )
    .join('');
}

function renderAll() {
  renderMachineLabel();
  renderActiveDomes();
  renderActiveBulkheads();
  renderTeams();
  renderOther();
  renderRecent();
}

/** SELECTED TEAM — employee badges scanned now join this team. Only one at a time. */
function selectTeam(teamId) {
  if (!Number.isInteger(teamId) || teamId <= 0 || teamId === focusedTeamId) return;
  focusedTeamId = teamId;
  els.teamCards.querySelectorAll('section.ak-team-card[data-team-id]').forEach((card) => {
    const on = Number(card.getAttribute('data-team-id')) === teamId;
    card.classList.toggle('is-focused', on);
    const badge = card.querySelector('[data-selected-badge]');
    if (badge) badge.hidden = !on;
  });
  renderOther();
  const team = teamById(teamId);
  showWarning(() => tr('dk.teamSelected', { team: team ? team.team_name : '' }));
}

function allBulkheads() {
  return (config && Array.isArray(config.bulkheads) ? config.bulkheads : []).slice();
}

function tickLiveTimers() {
  for (const d of allDomes()) {
    if (d.production_status !== 'in_progress') continue;
    document.querySelectorAll(`[data-live-ms="${d.id}"]`).forEach((el) => {
      el.textContent = formatMs(liveProductionMs(d));
    });
  }
  for (const b of allBulkheads()) {
    if (b.production_status !== 'in_progress') continue;
    document.querySelectorAll(`[data-live-bh-ms="${b.id}"]`).forEach((el) => {
      el.textContent = formatMs(liveProductionMs(b));
    });
  }
}

function applyConfig(data) {
  config = data;
  fetchedAt = Date.now();
  activeTeams = Array.isArray(data.active_teams) ? data.active_teams : [];
  if (activeTeams.length && (!focusedTeamId || !teamById(focusedTeamId))) {
    focusedTeamId = Number(activeTeams[0].team_id);
  }
  if (!activeTeams.length) focusedTeamId = null;
  if (data.machine && data.machine.slug) {
    try {
      localStorage.setItem(KIOSK_SLUG_KEY, String(data.machine.slug));
    } catch (_err) {
      /* ignore */
    }
  }
  renderAll();
  showNewTransferNotices(data.transfer_notices || []);
  // Keep open Create modals in sync when config arrives/refreshes.
  if (els.createModal && !els.createModal.hidden) renderCreateFabs();
  if (els.bhCreateModal && !els.bhCreateModal.hidden) renderBhCreateFabs();
}

/** Superseded kiosk: show that a worker was assigned elsewhere (from recent events). */
function showNewTransferNotices(notices) {
  if (!Array.isArray(notices) || !notices.length) return;
  const fresh = notices.filter((n) => n && n.id && !seenTransferNoticeIds.has(String(n.id)));
  if (!fresh.length) return;
  for (const n of fresh) seenTransferNoticeIds.add(String(n.id));
  const msg = fresh.map((n) => n.message || tr('dk.transfer.elsewhereShort')).join(' ');
  showWarning(() => msg);
}

async function loadConfig() {
  const { res, data } = await api(`${API}/config`);
  if (res.status === 401 || res.status === 403) {
    showWarning(() => (data && data.message) || tr('dome.err.server_error'));
    return;
  }
  if (!data || !data.ok) {
    if (data && data.error === 'wrong_workflow') {
      window.location.reload();
      return;
    }
    showWarning(responseMessage(data));
    return;
  }
  applyConfig(data);
}

async function runAction(body, ctx) {
  if (busy) return null;
  busy = true;
  try {
    const { data } = await postAction(body);
    showWarning(responseMessage(data, ctx));
    return data;
  } finally {
    busy = false;
    await loadConfig();
  }
}

/**
 * Start Dome/Bulkhead. If the employee is already on another Dome/Bulkhead job,
 * prompt to confirm intentional transfer, then retry with confirm_transfer.
 */
async function runStartWithTransferConfirm(body, ctx) {
  let data = await runAction(body, ctx);
  if (data && data.ok === false && data.error === 'employee_assigned_elsewhere' && data.confirm_transfer_required) {
    const who = data.employee_name || tr('dk.transfer.aWorker');
    const where = data.assigned_to || tr('dk.transfer.anotherJob');
    const ok = await askConfirm(
      tr('dk.transfer.title'),
      tr('dk.transfer.text', { name: who, where }),
      tr('dk.transfer.confirm')
    );
    if (ok) {
      data = await runAction({ ...body, confirm_transfer: true }, ctx);
    }
  }
  return data;
}

function isScanActionKeyword(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return SCAN_ACTION_KEYWORDS.has(s.replace(/[\s-]+/g, '_'));
}

async function submitScan(raw) {
  const barcode = String(raw || '').trim();
  if (!barcode || busy) return;
  if (isScanActionKeyword(barcode)) {
    showWarning(() => tr('dome.err.use_buttons'));
    return;
  }
  const team = teamById(focusedTeamId);
  const data = await runAction(
    { action: 'scan', barcode, team_id: focusedTeamId || undefined },
    { team: team ? team.team_name : null }
  );
  if (data && data.ok && data.team && data.team.id && (data.action === 'team_assigned' || data.action === 'team_present')) {
    focusedTeamId = Number(data.team.id);
    renderAll();
  }
}

// ---------------------------------------------------------------- Create Dome

function renderCreateChips() {
  const types = (config && config.types) || ['Petro', 'Water'];
  els.createTypes.innerHTML = types
    .map(
      (t) =>
        `<button type="button" class="dk-chip${createState.type === t ? ' is-on' : ''}" data-type="${escapeHtml(t)}">${escapeHtml(DI.typeLabel(t))}</button>`
    )
    .join('');
  const diameters = (config && config.diameters) || [4, 6, 8, 10, 12];
  els.createDiameters.innerHTML = diameters
    .map(
      (n) => `<button type="button" class="dk-chip${createState.diameter === n ? ' is-on' : ''}" data-diameter="${n}">${n}'</button>`
    )
    .join('');
  renderCreateFabs();
}

function employeePickerOptions() {
  const all = (config && config.all_employees) || [];
  if (all.length) return all;
  const shop = (config && config.dome_shop_employees) || [];
  if (shop.length) return shop;
  return (config && config.fabricator_options) || [];
}

function maxFabricators() {
  const n = config && config.max_fabricators != null ? Number(config.max_fabricators) : MAX_FABRICATORS;
  return Number.isInteger(n) && n > 0 ? n : MAX_FABRICATORS;
}

function employeeMetaNote(o, domeId) {
  const busyDome = o.busy_on_dome && (domeId == null || Number(o.busy_on_dome.dome_id) !== Number(domeId));
  const busyBh = o.busy_on_bulkhead || (o.busy && o.busy.kind === 'bulkhead' ? o.busy : null);
  if (busyDome) return tr('dk.fab.busy', { dome: o.busy_on_dome.dome_number });
  if (busyBh) return tr('dk.fab.busyBh', { n: busyBh.bulkhead_number });
  const dept = o.department || null;
  const home = o.home_team_name || null;
  const team = o.team_name || null;
  if (dept && home) return tr('dk.fab.teamDept', { team: home, dept });
  if (dept && team) return tr('dk.fab.teamDept', { team, dept });
  if (home) return tr('dk.fab.homeTeam', { team: home });
  if (team) return tr('dk.fab.team', { team });
  if (dept) return String(dept);
  return tr('dk.fab.noTeam');
}

function selectedPicksHtml(selectedIds) {
  const opts = employeePickerOptions();
  const chips = [...selectedIds]
    .map((id) => {
      const o = opts.find((e) => Number(e.id) === Number(id));
      const name = o ? o.name : `#${id}`;
      return `<button type="button" class="dk-emp-pick" data-fab-remove="${id}" aria-label="${escapeHtml(
        tr('dk.create.removeWorker', { name })
      )}"><span>${escapeHtml(name)}</span><span class="dk-emp-pick-x" aria-hidden="true">×</span></button>`;
    })
    .join('');
  if (!chips) return '';
  return `${chips}<span class="dk-emp-pick-count">${escapeHtml(
    tr('dk.create.selectedCount', { n: selectedIds.size, max: maxFabricators() })
  )}</span>`;
}

/** Always show searchable 1–3 employee picker (no team login). */
function renderCreateFabs() {
  if (els.createTitle) els.createTitle.textContent = tr('dk.create.title');
  createState.manual = true;
  if (els.createAutoFab) {
    els.createAutoFab.hidden = true;
    els.createAutoFab.textContent = '';
  }
  if (els.createFabHint) {
    els.createFabHint.hidden = false;
    els.createFabHint.textContent = tr('dk.create.pickFab');
  }
  if (els.createSelected) {
    const html = selectedPicksHtml(createState.fabs);
    els.createSelected.hidden = !html;
    els.createSelected.innerHTML = html;
  }
  if (els.createFabs) {
    els.createFabs.hidden = false;
    els.createFabs.classList.add('dk-emp-dropdown');
    els.createFabs.setAttribute('role', 'listbox');
    els.createFabs.innerHTML = fabChipsHtml(createState.fabs, null, createState.search);
  }
}

function fabChipsHtml(selected, domeId, searchText) {
  const q = String(searchText || '')
    .trim()
    .toLowerCase();
  let opts = employeePickerOptions();
  if (q) {
    opts = opts.filter((o) => {
      const hay = `${o.name || ''} ${o.team_name || ''} ${o.home_team_name || ''} ${o.department || ''} ${
        o.code || ''
      }`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (!opts.length) {
    return `<p class="dk-modal-hint">${escapeHtml(q ? tr('dk.create.noSearch') : tr('dk.create.noFab'))}</p>`;
  }
  // Cap visible rows for touch performance; search narrows the full list.
  const limit = q ? 200 : 120;
  const shown = opts.slice(0, limit);
  const more = opts.length > shown.length ? opts.length - shown.length : 0;
  const rows = shown
    .map((o) => {
      const id = Number(o.id);
      const on = selected.has(id);
      const note = employeeMetaNote(o, domeId);
      return `<button type="button" class="dk-chip dk-fab-chip${on ? ' is-on' : ''}" data-fab="${id}" role="option" aria-selected="${
        on ? 'true' : 'false'
      }">
        <span>${escapeHtml(o.name)}</span><small>${escapeHtml(note)}</small>
      </button>`;
    })
    .join('');
  return more
    ? `${rows}<p class="dk-modal-hint">${escapeHtml(tr('dk.create.moreResults', { n: more }))}</p>`
    : rows;
}

/** Toggle employee id in a selection Set (shared by Create Dome / Bulkhead / Set Fabricators). */
function toggleFab(getSet, afterToggle, container, domeId, searchFn) {
  return (ev) => {
    const remove = ev.target.closest('[data-fab-remove]');
    if (remove) {
      const set = getSet();
      const id = Number(remove.getAttribute('data-fab-remove'));
      if (set.has(id)) set.delete(id);
      if (typeof afterToggle === 'function') afterToggle();
      else container.innerHTML = fabChipsHtml(set, domeId(), searchFn ? searchFn() : '');
      return;
    }
    const b = ev.target.closest('[data-fab]');
    if (!b) return;
    const set = getSet();
    const id = Number(b.getAttribute('data-fab'));
    if (set.has(id)) set.delete(id);
    else if (set.size >= maxFabricators()) {
      showWarning(() => tr('dk.create.tooMany', { max: maxFabricators() }));
      return;
    } else set.add(id);
    if (typeof afterToggle === 'function') afterToggle();
    else container.innerHTML = fabChipsHtml(set, domeId(), searchFn ? searchFn() : '');
  };
}

function setModalError(el, msg) {
  el.hidden = !msg;
  el.textContent = msg || '';
}

async function openCreate(teamId) {
  createState.teamId = teamId != null ? teamId : null;
  createState.type = null;
  createState.diameter = null;
  createState.fabs = new Set();
  createState.search = '';
  createState.manual = true;
  els.createNumber.value = '';
  if (els.createNotes) els.createNotes.value = '';
  if (els.createEmpSearch) els.createEmpSearch.value = '';
  setModalError(els.createError, '');
  if (!employeePickerOptions().length) await loadConfig();
  renderCreateChips();
  openModal(els.createModal);
  setTimeout(() => {
    if (els.createEmpSearch) els.createEmpSearch.focus();
    else els.createNumber.focus();
  }, 50);
}

async function submitCreate(ev) {
  ev.preventDefault();
  if (busy) return;
  const ids = [...createState.fabs];
  if (!ids.length) {
    setModalError(els.createError, tr('dk.create.needWorkers'));
    return;
  }
  if (ids.length > maxFabricators()) {
    setModalError(els.createError, tr('dk.create.tooMany', { max: maxFabricators() }));
    return;
  }
  busy = true;
  try {
    const body = {
      action: 'create_dome',
      dome_number: els.createNumber.value,
      dome_type: createState.type,
      diameter_ft: createState.diameter,
      fabricator_ids: ids,
      notes: els.createNotes ? els.createNotes.value : null,
    };
    // Legacy optional team card create still sends team_id when opened from a team card.
    if (createState.teamId) body.team_id = createState.teamId;
    const { data } = await postAction(body);
    if (!data || !data.ok) {
      setModalError(els.createError, DI.msg(data, {}));
      return;
    }
    closeModal(els.createModal);
    showWarning(responseMessage(data, {}));
  } finally {
    busy = false;
    await loadConfig();
  }
}

// ---------------------------------------------------------------- Dome card actions

function openComplete(d) {
  completeDomeRef = d;
  els.completeText.textContent = tr('dk.complete.text', { dome: d.dome_number });
  els.completeWeight.value = '';
  setModalError(els.completeError, '');
  openModal(els.completeModal);
  setTimeout(() => els.completeWeight.focus(), 50);
}

async function submitComplete(ev) {
  ev.preventDefault();
  if (busy || !completeDomeRef) return;
  busy = true;
  try {
    const d = completeDomeRef;
    const { data } = await postAction({ action: 'complete_dome', dome_id: d.id, weight_lbs: els.completeWeight.value });
    if (!data || !data.ok) {
      setModalError(els.completeError, DI.msg(data, { dome: d.dome_number }));
      return;
    }
    closeModal(els.completeModal);
    showWarning(responseMessage(data, { dome: d.dome_number }));
  } finally {
    busy = false;
    await loadConfig();
  }
}

function openFabs(d) {
  fabsDome = d;
  fabsBulkhead = null;
  fabsSelected.clear();
  for (const f of d.fabricators || []) fabsSelected.add(Number(f.id));
  els.fabsTitle.textContent = tr('dk.fab.title', { dome: d.dome_number });
  els.fabsChips.innerHTML = fabChipsHtml(fabsSelected, d.id);
  setModalError(els.fabsError, '');
  openModal(els.fabsModal);
}

function openBhWorkers(b) {
  fabsBulkhead = b;
  fabsDome = null;
  fabsSelected.clear();
  for (const f of b.workers || []) fabsSelected.add(Number(f.id));
  els.fabsTitle.textContent = tr('dk.bhFab.title', { n: b.bulkhead_number });
  els.fabsChips.innerHTML = fabChipsHtml(fabsSelected, null);
  setModalError(els.fabsError, '');
  openModal(els.fabsModal);
}

async function submitFabs(ev) {
  ev.preventDefault();
  if (busy || (!fabsDome && !fabsBulkhead)) return;
  const ids = [...fabsSelected];
  if (!ids.length) {
    setModalError(els.fabsError, tr('dk.create.needWorkers'));
    return;
  }
  if (ids.length > maxFabricators()) {
    setModalError(els.fabsError, tr('dk.create.tooMany', { max: maxFabricators() }));
    return;
  }
  busy = true;
  try {
    if (fabsBulkhead) {
      const b = fabsBulkhead;
      const { data } = await postAction({
        action: 'set_bulkhead_workers',
        bulkhead_id: b.id,
        worker_ids: ids,
      });
      if (!data || !data.ok) {
        setModalError(els.fabsError, DI.msg(data, {}) || (data && data.message) || '');
        return;
      }
      closeModal(els.fabsModal);
      showWarning(responseMessage(data, {}));
    } else {
      const d = fabsDome;
      const { data } = await postAction({ action: 'set_fabricators', dome_id: d.id, fabricator_ids: ids });
      if (!data || !data.ok) {
        setModalError(els.fabsError, DI.msg(data, { dome: d.dome_number }));
        return;
      }
      closeModal(els.fabsModal);
      showWarning(responseMessage(data, { dome: d.dome_number }));
    }
  } finally {
    busy = false;
    await loadConfig();
  }
}

function renderBhCreateFabs() {
  if (els.bhCreateSelected) {
    const html = selectedPicksHtml(bhCreateState.fabs);
    els.bhCreateSelected.hidden = !html;
    els.bhCreateSelected.innerHTML = html;
  }
  if (els.bhCreateFabs) {
    els.bhCreateFabs.hidden = false;
    els.bhCreateFabs.classList.add('dk-emp-dropdown');
    els.bhCreateFabs.setAttribute('role', 'listbox');
    els.bhCreateFabs.innerHTML = fabChipsHtml(bhCreateState.fabs, null, bhCreateState.search);
  }
}

async function openBhCreate() {
  bhCreateState.fabs = new Set();
  bhCreateState.search = '';
  if (els.bhCreateNumber) els.bhCreateNumber.value = '';
  if (els.bhCreateNotes) els.bhCreateNotes.value = '';
  if (els.bhCreateEmpSearch) els.bhCreateEmpSearch.value = '';
  setModalError(els.bhCreateError, '');
  if (!employeePickerOptions().length) await loadConfig();
  renderBhCreateFabs();
  openModal(els.bhCreateModal);
  setTimeout(() => {
    if (els.bhCreateEmpSearch) els.bhCreateEmpSearch.focus();
    else if (els.bhCreateNumber) els.bhCreateNumber.focus();
  }, 50);
}

async function submitBhCreate(ev) {
  ev.preventDefault();
  if (busy) return;
  const ids = [...bhCreateState.fabs];
  if (!ids.length) {
    setModalError(els.bhCreateError, tr('dk.create.needWorkers'));
    return;
  }
  if (ids.length > maxFabricators()) {
    setModalError(els.bhCreateError, tr('dk.create.tooMany', { max: maxFabricators() }));
    return;
  }
  busy = true;
  try {
    const { data } = await postAction({
      action: 'create_bulkhead',
      bulkhead_number: els.bhCreateNumber.value,
      worker_ids: ids,
      notes: els.bhCreateNotes ? els.bhCreateNotes.value : null,
    });
    if (!data || !data.ok) {
      setModalError(els.bhCreateError, DI.msg(data, {}) || (data && data.message) || '');
      return;
    }
    closeModal(els.bhCreateModal);
    showWarning(responseMessage(data, {}));
  } finally {
    busy = false;
    await loadConfig();
  }
}

function bulkheadById(id) {
  return allBulkheads().find((b) => Number(b.id) === Number(id)) || null;
}

async function handleBulkheadButton(btn) {
  const b = bulkheadById(btn.getAttribute('data-bh-id'));
  if (!b) return;
  const what = btn.getAttribute('data-dk-bh');
  const ctx = {};
  if (what === 'start') await runStartWithTransferConfirm({ action: 'start_bulkhead', bulkhead_id: b.id }, ctx);
  else if (what === 'stop') await runAction({ action: 'stop_bulkhead', bulkhead_id: b.id }, ctx);
  else if (what === 'finish') {
    const ok = await askConfirm(
      tr('dk.bhFinish.title'),
      tr('dk.bhFinish.text', { n: b.bulkhead_number }),
      tr('dk.btn.finishBulkhead')
    );
    if (ok) await runAction({ action: 'finish_bulkhead', bulkhead_id: b.id }, ctx);
  } else if (what === 'workers') openBhWorkers(b);
}

async function handleDomeButton(btn) {
  const d = domeById(btn.getAttribute('data-dome-id'));
  if (!d) return;
  const what = btn.getAttribute('data-dk-dome');
  const teamAttr = btn.getAttribute('data-team-id');
  const teamId = teamAttr != null && teamAttr !== '' ? Number(teamAttr) : null;
  const team = teamId != null ? teamById(teamId) : null;
  const ctx = { dome: d.dome_number, team: team ? team.team_name : null };
  if (what === 'start') {
    const body = { action: 'start_dome', dome_id: d.id };
    if (Number.isInteger(teamId) && teamId > 0) body.team_id = teamId;
    await runStartWithTransferConfirm(body, ctx);
  } else if (what === 'stop') {
    await runAction({ action: 'stop_dome', dome_id: d.id }, ctx);
  } else if (what === 'complete') openComplete(d);
  else if (what === 'fabricators') openFabs(d);
}

// ---------------------------------------------------------------- Team card actions

function openEmployeeOut(team) {
  outTeam = team;
  outPick = null;
  const list = team.roster || [];
  els.outTitle.textContent = tr('dk.out.titleTeam', { team: team.team_name });
  els.outEmpty.hidden = list.length > 0;
  els.outList.innerHTML = list
    .map((e) => `<button type="button" class="employee-out-row" data-out="${e.id}">${escapeHtml(e.name)}</button>`)
    .join('');
  els.outConfirmText.hidden = true;
  els.outSubmit.hidden = true;
  openModal(els.outModal);
}

function pickEmployeeOut(id) {
  const e = ((outTeam && outTeam.roster) || []).find((x) => Number(x.id) === Number(id));
  if (!e) return;
  outPick = e;
  els.outList.querySelectorAll('[data-out]').forEach((b) => b.classList.toggle('is-on', Number(b.getAttribute('data-out')) === Number(id)));
  els.outConfirmText.textContent = tr('dk.out.confirm', { name: e.name });
  els.outConfirmText.hidden = false;
  els.outSubmit.hidden = false;
}

async function submitEmployeeOut() {
  if (!outPick || !outTeam) return;
  const e = outPick;
  const team = outTeam;
  closeModal(els.outModal);
  await runAction({ action: 'employee_out', employee_id: e.id, team_id: team.team_id }, { name: e.name, team: team.team_name });
}

async function handleTeamButton(btn) {
  const what = btn.getAttribute('data-dk');
  const team = teamById(btn.getAttribute('data-team-id'));
  if (!team) return;
  const teamId = Number(team.team_id);
  const ctx = { team: team.team_name };
  if (what === 'create') openCreate(teamId);
  else if (what === 'lunch') await runAction({ action: 'lunch', team_id: teamId }, ctx);
  else if (what === 'resume') await runAction({ action: 'resume', team_id: teamId }, ctx);
  else if (what === 'employee_out') openEmployeeOut(team);
  else if (what === 'end_shift') {
    const ok = await askConfirm(tr('dk.endShift.title'), tr('dk.endShift.text', { team: team.team_name }), tr('dk.btn.endShift'));
    if (ok) await runAction({ action: 'end_shift', team_id: teamId }, ctx);
  }
}

async function handleBoardClick(ev) {
  if (busy) return;
  const domeBtn = ev.target.closest('[data-dk-dome]');
  if (domeBtn) {
    await handleDomeButton(domeBtn);
    return;
  }
  const bhBtn = ev.target.closest('[data-dk-bh]');
  if (bhBtn) {
    await handleBulkheadButton(bhBtn);
    return;
  }
  const teamBtn = ev.target.closest('[data-dk]');
  if (teamBtn && !teamBtn.disabled) await handleTeamButton(teamBtn);
}

// ---------------------------------------------------------------- wiring

function bindChips() {
  els.createTypes.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-type]');
    if (!b) return;
    createState.type = b.getAttribute('data-type');
    renderCreateChips();
  });
  els.createDiameters.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-diameter]');
    if (!b) return;
    createState.diameter = Number(b.getAttribute('data-diameter'));
    renderCreateChips();
  });
  els.createFabs.addEventListener(
    'click',
    toggleFab(
      () => createState.fabs,
      () => renderCreateFabs(),
      els.createFabs,
      () => null,
      () => createState.search
    )
  );
  if (els.createSelected) {
    els.createSelected.addEventListener(
      'click',
      toggleFab(
        () => createState.fabs,
        () => renderCreateFabs(),
        els.createFabs,
        () => null,
        () => createState.search
      )
    );
  }
  els.fabsChips.addEventListener(
    'click',
    toggleFab(
      () => fabsSelected,
      null,
      els.fabsChips,
      () => (fabsDome ? fabsDome.id : null),
      () => ''
    )
  );
  if (els.createEmpSearch) {
    const showList = () => {
      if (els.createFabs) els.createFabs.hidden = false;
      renderCreateFabs();
    };
    els.createEmpSearch.addEventListener('input', () => {
      createState.search = els.createEmpSearch.value || '';
      renderCreateFabs();
    });
    els.createEmpSearch.addEventListener('focus', showList);
    els.createEmpSearch.addEventListener('click', showList);
  }
}

function bindModals() {
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => closeModal($(b.getAttribute('data-close'))))
  );
  els.createForm.addEventListener('submit', (ev) => void submitCreate(ev));
  if (els.bhCreateForm) els.bhCreateForm.addEventListener('submit', (ev) => void submitBhCreate(ev));
  els.completeForm.addEventListener('submit', (ev) => void submitComplete(ev));
  els.fabsForm.addEventListener('submit', (ev) => void submitFabs(ev));
  els.outList.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-out]');
    if (b) pickEmployeeOut(b.getAttribute('data-out'));
  });
  els.outSubmit.addEventListener('click', () => void submitEmployeeOut());
  els.confirmOk.addEventListener('click', () => finishConfirm(true));
  els.confirmCancel.addEventListener('click', () => finishConfirm(false));
  if (els.btnCreateDome) els.btnCreateDome.addEventListener('click', () => void openCreate(null));
  if (els.btnCreateBulkhead) els.btnCreateBulkhead.addEventListener('click', () => void openBhCreate());
  if (els.bhCreateFabs) {
    els.bhCreateFabs.addEventListener(
      'click',
      toggleFab(
        () => bhCreateState.fabs,
        () => renderBhCreateFabs(),
        els.bhCreateFabs,
        () => null,
        () => bhCreateState.search
      )
    );
  }
  if (els.bhCreateSelected) {
    els.bhCreateSelected.addEventListener(
      'click',
      toggleFab(
        () => bhCreateState.fabs,
        () => renderBhCreateFabs(),
        els.bhCreateFabs,
        () => null,
        () => bhCreateState.search
      )
    );
  }
  if (els.bhCreateEmpSearch) {
    const showList = () => {
      if (els.bhCreateFabs) els.bhCreateFabs.hidden = false;
      renderBhCreateFabs();
    };
    els.bhCreateEmpSearch.addEventListener('input', () => {
      bhCreateState.search = els.bhCreateEmpSearch.value || '';
      renderBhCreateFabs();
    });
    els.bhCreateEmpSearch.addEventListener('focus', showList);
    els.bhCreateEmpSearch.addEventListener('click', showList);
  }
  if (els.btnBoardLunch) {
    els.btnBoardLunch.addEventListener('click', () => void runAction({ action: 'lunch' }, {}));
  }
  if (els.btnBoardResume) {
    els.btnBoardResume.addEventListener('click', () => void runAction({ action: 'resume' }, {}));
  }
  if (els.btnBoardEndShift) {
    els.btnBoardEndShift.addEventListener('click', async () => {
      const ok = await askConfirm(tr('dk.endShift.title'), tr('dk.endShift.boardText'), tr('dk.btn.endShift'));
      if (ok) await runAction({ action: 'end_shift' }, {});
    });
  }
  if (els.activeDomes) els.activeDomes.addEventListener('click', (ev) => void handleBoardClick(ev));
  if (els.activeBulkheads) els.activeBulkheads.addEventListener('click', (ev) => void handleBoardClick(ev));
  if (els.teamCards) els.teamCards.addEventListener('click', (ev) => void handleBoardClick(ev));
  if (els.otherCards) els.otherCards.addEventListener('click', (ev) => void handleBoardClick(ev));
  els.logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/kiosk-logout', { method: 'POST', body: '{}' });
    window.location.href = '/kiosk-login';
  });
}

function bindScan() {
  els.scanForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = els.manual.value;
    els.manual.value = '';
    scanBuffer = '';
    void submitScan(v);
  });
  document.addEventListener('keydown', (ev) => {
    if (anyModalOpen()) return;
    const tag = ev.target && ev.target.tagName;
    if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && ev.target !== els.scannerTrap) return;
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

function bindLanguage() {
  const fi = window.FactoryI18n;
  if (!fi) return;
  fi.mountSelector('kioskLangMount');
  fi.applyDom();
  window.addEventListener('factory-lang-change', () => {
    renderAll();
    if (!els.createModal.hidden) renderCreateChips();
    if (lastWarning) showWarning(lastWarning);
    const active = document.activeElement;
    if (active && active.id === 'factoryLangSelect' && typeof active.blur === 'function') active.blur();
  });
}

bindChips();
bindModals();
bindScan();
bindLanguage();
renderAll();
void loadConfig().then(() => {
  setInterval(() => {
    if (!busy && !anyModalOpen()) void loadConfig();
  }, 10000);
  setInterval(tickLiveTimers, 15000);
});
