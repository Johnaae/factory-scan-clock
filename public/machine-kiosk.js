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
  valPiece: document.getElementById('valPiece'),
  pieceChips: document.getElementById('pieceChips'),
  pieceStatusPanel: document.getElementById('pieceStatusPanel'),
  pieceTouchButtons: document.getElementById('pieceTouchButtons'),
  openTanksPanel: document.getElementById('openTanksPanel'),
  phaseSummaryPanel: document.getElementById('phaseSummaryPanel'),
  phaseSummaryList: document.getElementById('phaseSummaryList'),
  pendingPanel: document.getElementById('pendingPanel'),
  pendingText: document.getElementById('pendingText'),
  phasePanel: document.getElementById('phasePanel'),
  phaseButtons: document.getElementById('phaseButtons'),
  logoutBtn: document.getElementById('logoutBtn'),
  noteModal: document.getElementById('noteModal'),
  noteModalTitle: document.getElementById('noteModalTitle'),
  noteType: document.getElementById('noteType'),
  noteBody: document.getElementById('noteBody'),
  btnSaveNote: document.getElementById('btnSaveNote'),
  btnCancelNote: document.getElementById('btnCancelNote'),
  btnOpenNotes: document.getElementById('btnOpenNotes'),
  btnShowPhases: document.getElementById('btnShowPhases'),
  touchControls: document.getElementById('touchControls'),
  qaQcPanel: document.getElementById('qaQcPanel'),
  qaQcStarted: document.getElementById('qaQcStarted'),
  qaQcPhasePaused: document.getElementById('qaQcPhasePaused'),
  qaQcNote: document.getElementById('qaQcNote'),
  btnQaQc: document.getElementById('btnQaQc'),
  btnResolveQaQc: document.getElementById('btnResolveQaQc'),
  btnResolveQaQcPanel: document.getElementById('btnResolveQaQcPanel'),
  resolveQaQcModal: document.getElementById('resolveQaQcModal'),
  resolveQaQcNote: document.getElementById('resolveQaQcNote'),
  btnConfirmResolveQaQc: document.getElementById('btnConfirmResolveQaQc'),
  btnSkipResolveQaQcNote: document.getElementById('btnSkipResolveQaQcNote'),
  btnCancelResolveQaQc: document.getElementById('btnCancelResolveQaQc'),
  downtimeModal: document.getElementById('downtimeModal'),
  downtimeReason: document.getElementById('downtimeReason'),
  downtimeNote: document.getElementById('downtimeNote'),
  btnSaveDowntime: document.getElementById('btnSaveDowntime'),
  btnSkipDowntimeReason: document.getElementById('btnSkipDowntimeReason'),
  btnCancelDowntime: document.getElementById('btnCancelDowntime'),
  btnEmployeeOut: document.getElementById('btnEmployeeOut'),
  employeeOutModal: document.getElementById('employeeOutModal'),
  employeeOutHint: document.getElementById('employeeOutHint'),
  employeeOutList: document.getElementById('employeeOutList'),
  employeeOutEmpty: document.getElementById('employeeOutEmpty'),
  employeeOutConfirm: document.getElementById('employeeOutConfirm'),
  btnCancelEmployeeOut: document.getElementById('btnCancelEmployeeOut'),
  btnConfirmEmployeeOut: document.getElementById('btnConfirmEmployeeOut'),
  changePhaseModal: document.getElementById('changePhaseModal'),
  changePhaseContext: document.getElementById('changePhaseContext'),
  changePhaseTarget: document.getElementById('changePhaseTarget'),
  changePhaseCurrent: document.getElementById('changePhaseCurrent'),
  changePhaseEmpty: document.getElementById('changePhaseEmpty'),
  changePhaseList: document.getElementById('changePhaseList'),
  changePhaseConfirm: document.getElementById('changePhaseConfirm'),
  btnCancelChangePhase: document.getElementById('btnCancelChangePhase'),
  btnConfirmChangePhase: document.getElementById('btnConfirmChangePhase'),
};

let config = null;
let assignment = null;
let session = null;
let openSessions = [];
let tankOpenSessions = [];
let pieces = [];
let pieceCount = 0;
let phaseTimeSummary = [];
let pendingTank = null;
let pendingPiece = null;
let resumablePhase = null;
let pendingConfirmer = null;
let employeeOutPick = null;
let employeeOutSubmitting = false;
let changePhasePick = null;
let changePhaseContext = null;
let changePhaseSubmitting = false;
let phases = [];
let elapsedTimer = null;
let scanBuffer = '';
let lastKeyTime = 0;
let noteMode = 'general'; // general | correction
let pendingCorrectionBarcode = null;
let downtimeReasons = [];
let openQaQc = null;

function isEmployeeOutModalOpen() {
  return Boolean(
    els.employeeOutModal && !els.employeeOutModal.hidden && els.employeeOutModal.classList.contains('show')
  );
}

function isChangePhaseModalOpen() {
  return Boolean(
    els.changePhaseModal && !els.changePhaseModal.hidden && els.changePhaseModal.classList.contains('show')
  );
}

function isTextEntryModalOpen() {
  const noteOpen = els.noteModal && !els.noteModal.hidden && els.noteModal.classList.contains('show');
  const downtimeOpen =
    els.downtimeModal && !els.downtimeModal.hidden && els.downtimeModal.classList.contains('show');
  const resolveOpen =
    els.resolveQaQcModal && !els.resolveQaQcModal.hidden && els.resolveQaQcModal.classList.contains('show');
  return Boolean(
    noteOpen || downtimeOpen || resolveOpen || isEmployeeOutModalOpen() || isChangePhaseModalOpen()
  );
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

/**
 * Keep the kiosk ready for USB barcode scanners: clear + focus the scan box
 * unless a text-entry dialog currently owns the keyboard.
 */
function focusScanInput(opts) {
  const clear = !opts || opts.clear !== false;
  if (isTextEntryModalOpen()) return;
  const input = els.manual || els.scannerTrap;
  if (!input) return;
  if (clear) {
    if (els.manual) els.manual.value = '';
    scanBuffer = '';
  }
  const apply = () => {
    if (isTextEntryModalOpen()) return;
    try {
      input.focus({ preventScroll: true });
      if (els.manual && input === els.manual && typeof input.setSelectionRange === 'function') {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    } catch (_err) {
      try {
        input.focus();
      } catch (_err2) {
        /* ignore */
      }
    }
  };
  window.requestAnimationFrame(() => {
    apply();
    window.setTimeout(apply, 0);
  });
}

function statusClassForSession(s) {
  if (!s) return 'idle';
  if (s.status === 'running') return 'running';
  const reason = String(s.stop_reason || '').toLowerCase();
  if (reason === 'qa_qc') return 'qa_qc';
  if (reason === 'downtime') return 'downtime';
  if (reason === 'break') return 'break';
  if (reason === 'lunch') return 'lunch';
  if (s.status === 'stopped' || s.status === 'paused') return 'paused';
  return 'idle';
}

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

function closeEmployeeOutModal() {
  employeeOutPick = null;
  employeeOutSubmitting = false;
  if (!els.employeeOutModal) return;
  els.employeeOutModal.classList.remove('show');
  els.employeeOutModal.hidden = true;
  if (els.employeeOutList) els.employeeOutList.innerHTML = '';
  if (els.employeeOutEmpty) els.employeeOutEmpty.hidden = true;
  if (els.employeeOutConfirm) {
    els.employeeOutConfirm.hidden = true;
    els.employeeOutConfirm.textContent = '';
  }
  if (els.btnConfirmEmployeeOut) {
    els.btnConfirmEmployeeOut.hidden = true;
    els.btnConfirmEmployeeOut.disabled = false;
  }
}

function showEmployeeOutConfirm(emp) {
  employeeOutPick = emp;
  if (els.employeeOutConfirm) {
    els.employeeOutConfirm.hidden = false;
    els.employeeOutConfirm.textContent = `Mark ${emp.name} out for this shift?`;
  }
  if (els.btnConfirmEmployeeOut) {
    els.btnConfirmEmployeeOut.hidden = false;
    els.btnConfirmEmployeeOut.disabled = false;
  }
  if (els.employeeOutList) {
    Array.from(els.employeeOutList.querySelectorAll('.employee-out-row')).forEach((btn) => {
      btn.classList.toggle('is-selected', Number(btn.getAttribute('data-employee-id')) === Number(emp.id));
    });
  }
}

function renderEmployeeOutList(employees) {
  employeeOutPick = null;
  if (els.employeeOutConfirm) {
    els.employeeOutConfirm.hidden = true;
    els.employeeOutConfirm.textContent = '';
  }
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = true;
  if (!els.employeeOutList) return;
  els.employeeOutList.innerHTML = '';
  const list = Array.isArray(employees) ? employees : [];
  if (!list.length) {
    if (els.employeeOutEmpty) {
      els.employeeOutEmpty.hidden = false;
      els.employeeOutEmpty.textContent = 'No active employees available.';
    }
    return;
  }
  if (els.employeeOutEmpty) els.employeeOutEmpty.hidden = true;
  list.forEach((emp) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'employee-out-row';
    btn.setAttribute('data-employee-id', String(emp.id));
    const name = document.createElement('span');
    name.className = 'employee-out-name';
    name.textContent = emp.name || 'Employee';
    const meta = document.createElement('span');
    meta.className = 'employee-out-meta';
    meta.textContent = [emp.code, emp.role].filter(Boolean).join('  ·  ');
    btn.appendChild(name);
    btn.appendChild(meta);
    btn.addEventListener('click', () => showEmployeeOutConfirm(emp));
    els.employeeOutList.appendChild(btn);
  });
}

async function openEmployeeOutModal() {
  if (!assignment) {
    warn('Scan a Team barcode first. Employee Out needs a team assigned to this machine.');
    return;
  }
  if (!els.employeeOutModal) return;
  blurScanInputs();
  employeeOutPick = null;
  employeeOutSubmitting = false;
  els.employeeOutModal.hidden = false;
  els.employeeOutModal.classList.add('show');
  if (els.employeeOutHint) {
    els.employeeOutHint.textContent = 'Select an active employee. Production continues for the rest of the team.';
  }
  if (els.employeeOutList) els.employeeOutList.innerHTML = '';
  if (els.employeeOutEmpty) {
    els.employeeOutEmpty.hidden = false;
    els.employeeOutEmpty.textContent = 'Loading…';
  }
  if (els.employeeOutConfirm) els.employeeOutConfirm.hidden = true;
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.hidden = true;
  const { res, data } = await api(`${API}/shift-employees`);
  if (!res.ok || !data.ok) {
    closeEmployeeOutModal();
    warn((data && data.message) || 'Could not load active employees.');
    focusScanInput();
    return;
  }
  renderEmployeeOutList(data.employees || []);
}

async function confirmEmployeeOut() {
  if (!employeeOutPick || !employeeOutPick.id || employeeOutSubmitting) return;
  employeeOutSubmitting = true;
  if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.disabled = true;
  const { res, data } = await api(`${API}/employee-out`, {
    method: 'POST',
    body: JSON.stringify({ employee_id: employeeOutPick.id }),
  });
  employeeOutSubmitting = false;
  if (!res.ok || !data.ok) {
    if (els.btnConfirmEmployeeOut) els.btnConfirmEmployeeOut.disabled = false;
    warn((data && data.message) || 'Could not mark employee out.');
    if (data && data.error === 'not_on_shift') {
      await openEmployeeOutModal();
    }
    return;
  }
  await consumeScanResult(data);
}

function isEmployeeOutBarcode(value) {
  const s = String(value || '').trim().toUpperCase();
  return (
    s === 'EMPLOYEE_OUT' ||
    s === 'EMPLOYEE:OUT' ||
    s === 'SCAN:EMPLOYEE_OUT' ||
    s === 'ACTION:EMPLOYEE_OUT'
  );
}

function selectablePhases() {
  return (phases || []).filter((ph) => ph && !ph.completes && !ph.piece_complete);
}

function closeChangePhaseModal() {
  changePhasePick = null;
  changePhaseContext = null;
  changePhaseSubmitting = false;
  if (!els.changePhaseModal) return;
  els.changePhaseModal.classList.remove('show');
  els.changePhaseModal.hidden = true;
  if (els.changePhaseList) els.changePhaseList.innerHTML = '';
  if (els.changePhaseEmpty) {
    els.changePhaseEmpty.hidden = true;
    els.changePhaseEmpty.textContent = '';
  }
  if (els.changePhaseConfirm) {
    els.changePhaseConfirm.hidden = true;
    els.changePhaseConfirm.textContent = '';
  }
  if (els.changePhaseContext) els.changePhaseContext.hidden = true;
  if (els.btnConfirmChangePhase) {
    els.btnConfirmChangePhase.hidden = true;
    els.btnConfirmChangePhase.disabled = false;
  }
}

function showChangePhaseConfirm(ph) {
  if (!changePhaseContext || !ph) return;
  changePhasePick = ph;
  const pieceLabel = `Piece ${changePhaseContext.piece}`;
  const fromLabel = changePhaseContext.currentPhase || '—';
  const toLabel = ph.label || ph.code || 'phase';
  if (els.changePhaseConfirm) {
    els.changePhaseConfirm.hidden = false;
    els.changePhaseConfirm.textContent = changePhaseContext.hasCurrentPhase
      ? `Change ${pieceLabel} from ${fromLabel} to ${toLabel}?`
      : `Start ${toLabel} on ${pieceLabel}?`;
  }
  if (els.btnConfirmChangePhase) {
    els.btnConfirmChangePhase.hidden = false;
    els.btnConfirmChangePhase.disabled = false;
  }
  if (els.changePhaseList) {
    Array.from(els.changePhaseList.querySelectorAll('.change-phase-btn')).forEach((btn) => {
      const code = String(btn.getAttribute('data-phase-code') || '');
      btn.classList.toggle('is-selected', code === String(ph.code || ''));
    });
  }
}

function renderChangePhaseList(list) {
  changePhasePick = null;
  if (els.changePhaseConfirm) {
    els.changePhaseConfirm.hidden = true;
    els.changePhaseConfirm.textContent = '';
  }
  if (els.btnConfirmChangePhase) els.btnConfirmChangePhase.hidden = true;
  if (!els.changePhaseList) return;
  els.changePhaseList.innerHTML = '';
  const currentCode = changePhaseContext && changePhaseContext.currentCode
    ? String(changePhaseContext.currentCode).toUpperCase()
    : '';
  list.forEach((ph) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'change-phase-btn';
    btn.setAttribute('data-phase-code', String(ph.code || ''));
    btn.textContent = ph.label || ph.code || 'Phase';
    if (currentCode && String(ph.code || '').toUpperCase() === currentCode) {
      btn.classList.add('is-current');
    }
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => showChangePhaseConfirm(ph));
    els.changePhaseList.appendChild(btn);
  });
}

function openChangePhaseModal() {
  blurScanInputs();
  if (els.phasePanel) els.phasePanel.hidden = true;

  if (!assignment) {
    warn('Scan a Team barcode first before changing phase.');
    return;
  }
  const tank = activeTankNumber();
  if (!tank) {
    warn('Scan or select a tank first, then Change Phase.');
    return;
  }
  const piece = selectedPieceNumber();
  if (piece == null) {
    warn('Select the target piece first, then Change Phase.');
    return;
  }

  const currentSession = focusedSession();
  const currentPhase =
    (currentSession && (currentSession.phase_name || currentSession.activity_name)) || null;
  const currentCode =
    (currentSession && (currentSession.activity_code || currentSession.phase_code)) || null;

  changePhaseContext = {
    tank: String(tank).toUpperCase(),
    piece: Number(piece),
    currentPhase: currentPhase || 'Not started',
    currentCode,
    hasCurrentPhase: Boolean(currentPhase),
  };
  changePhasePick = null;
  changePhaseSubmitting = false;

  if (!els.changePhaseModal) return;
  els.changePhaseModal.hidden = false;
  els.changePhaseModal.classList.add('show');
  blurScanInputs();

  if (els.changePhaseContext) els.changePhaseContext.hidden = false;
  if (els.changePhaseTarget) {
    els.changePhaseTarget.textContent = `Tank ${changePhaseContext.tank} — Piece ${changePhaseContext.piece}`;
  }
  if (els.changePhaseCurrent) {
    els.changePhaseCurrent.textContent = `Current Phase: ${changePhaseContext.currentPhase}`;
  }

  const list = selectablePhases();
  if (!list.length) {
    if (els.changePhaseEmpty) {
      els.changePhaseEmpty.hidden = false;
      els.changePhaseEmpty.textContent = 'No phases available.';
    }
    if (els.changePhaseList) els.changePhaseList.innerHTML = '';
    if (els.btnConfirmChangePhase) els.btnConfirmChangePhase.hidden = true;
    return;
  }
  if (els.changePhaseEmpty) els.changePhaseEmpty.hidden = true;
  renderChangePhaseList(list);
  // Keep focus off inputs while the modal is open.
  blurScanInputs();
  window.setTimeout(blurScanInputs, 0);
}

async function confirmChangePhase() {
  if (!changePhasePick || !changePhaseContext || changePhaseSubmitting) return;
  changePhaseSubmitting = true;
  if (els.btnConfirmChangePhase) els.btnConfirmChangePhase.disabled = true;

  pendingTank = changePhaseContext.tank;
  pendingPiece = changePhaseContext.piece;
  const ph = changePhasePick;
  closeChangePhaseModal();

  const data = await postAction({
    action: 'scan',
    barcode: ph.barcode || ph.code,
    pending: { tank: pendingTank, piece: pendingPiece },
    ...confirmerPayload(),
  });
  changePhaseSubmitting = false;
  if (!data) {
    focusScanInput();
    return;
  }
  await consumeScanResult(data);
  if (!isTextEntryModalOpen()) focusScanInput();
}

function showFinishBanner(message) {
  if (!els.finishBanner) return;
  const title = els.finishBanner.querySelector('.finish-success-banner__title');
  if (title) title.textContent = message || 'Tank finished';
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

function statusCssClass(sessionObj) {
  const cls = statusClassForSession(sessionObj);
  if (cls === 'running') return 'wk-value wk-value--running';
  if (cls === 'qa_qc') return 'wk-value wk-value--qa_qc';
  if (cls === 'downtime') return 'wk-value wk-value--downtime';
  if (cls === 'break') return 'wk-value wk-value--break';
  if (cls === 'lunch') return 'wk-value wk-value--lunch';
  if (cls === 'paused') return 'wk-value wk-value--paused';
  return 'wk-value wk-value--idle';
}

function fmtClockTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function selectedHasOpenQaQc() {
  if (openQaQc) return true;
  if (!session) return false;
  return String(session.stop_reason || '').toLowerCase() === 'qa_qc';
}

function pausedPhaseLabel() {
  if (openQaQc && (openQaQc.phase_name || openQaQc.phase_code)) {
    return openQaQc.phase_name || openQaQc.phase_code;
  }
  if (session) return session.phase_name || session.activity_name || '—';
  return '—';
}

function renderQaQcUi() {
  const hasOpen = selectedHasOpenQaQc();
  if (els.btnResolveQaQc) {
    els.btnResolveQaQc.hidden = !hasOpen;
    els.btnResolveQaQc.disabled = !hasOpen;
  }
  if (els.btnResolveQaQcPanel) {
    els.btnResolveQaQcPanel.hidden = !hasOpen;
    els.btnResolveQaQcPanel.disabled = !hasOpen;
  }
  if (els.btnQaQc) els.btnQaQc.hidden = hasOpen;
  if (!els.qaQcPanel) return;
  if (!hasOpen) {
    els.qaQcPanel.hidden = true;
    return;
  }
  els.qaQcPanel.hidden = false;
  if (els.qaQcPhasePaused) {
    els.qaQcPhasePaused.textContent = `Phase Paused: ${pausedPhaseLabel()}`;
  }
  if (els.qaQcStarted) {
    const started = openQaQc && openQaQc.reported_at ? openQaQc.reported_at : session && session.stopped_at;
    els.qaQcStarted.textContent = `Started: ${fmtClockTime(started)}`;
  }
  if (els.qaQcNote) {
    const note = (openQaQc && (openQaQc.issue_note || openQaQc.notes)) || '';
    if (note) {
      els.qaQcNote.hidden = false;
      els.qaQcNote.textContent = `Note: ${note}`;
    } else {
      els.qaQcNote.hidden = true;
      els.qaQcNote.textContent = '';
    }
  }
}

function openResolveQaQcModal() {
  if (!selectedHasOpenQaQc()) {
    warn('No open QA/QC issue for this piece.');
    return;
  }
  if (els.resolveQaQcNote) els.resolveQaQcNote.value = '';
  if (els.resolveQaQcModal) {
    els.resolveQaQcModal.hidden = false;
    els.resolveQaQcModal.classList.add('show');
  }
  if (els.resolveQaQcNote) els.resolveQaQcNote.focus();
}

function closeResolveQaQcModal() {
  if (els.resolveQaQcModal) {
    els.resolveQaQcModal.hidden = true;
    els.resolveQaQcModal.classList.remove('show');
  }
  focusScanInput();
}

async function submitResolveQaQc(includeNote) {
  if (!selectedHasOpenQaQc()) {
    warn('No open QA/QC issue for this piece.');
    closeResolveQaQcModal();
    return;
  }
  const note =
    includeNote && els.resolveQaQcNote ? String(els.resolveQaQcNote.value || '').trim() : '';
  const resolvedBy =
    assignment && assignment.team_name ? `kiosk:${assignment.team_name}` : 'kiosk';
  closeResolveQaQcModal();
  const data = await postAction({
    action: 'resolve_qa_qc',
    resolution_note: note || null,
    resolved_by: resolvedBy,
  });
  if (!data) {
    focusScanInput();
    return;
  }
  await consumeScanResult(data);
  focusScanInput();
}

function openNoteModal(mode, title) {
  noteMode = mode || 'general';
  if (els.noteModalTitle) els.noteModalTitle.textContent = title || 'Notes';
  if (els.noteType) {
    els.noteType.value = noteMode === 'correction' ? 'correction' : 'general';
    els.noteType.disabled = noteMode === 'correction';
  }
  if (els.noteBody) els.noteBody.value = '';
  if (els.noteModal) {
    els.noteModal.hidden = false;
    els.noteModal.classList.add('show');
  }
  if (els.noteBody) els.noteBody.focus();
}

function closeNoteModal() {
  if (els.noteModal) {
    els.noteModal.hidden = true;
    els.noteModal.classList.remove('show');
  }
  pendingCorrectionBarcode = null;
  noteMode = 'general';
  if (els.noteType) els.noteType.disabled = false;
  focusScanInput();
}

function openDowntimeModal() {
  if (els.downtimeReason && downtimeReasons.length) {
    els.downtimeReason.innerHTML = downtimeReasons
      .map((r) => `<option value="${String(r.code)}">${String(r.label)}</option>`)
      .join('');
  }
  if (els.downtimeNote) els.downtimeNote.value = '';
  if (els.downtimeModal) {
    els.downtimeModal.hidden = false;
    els.downtimeModal.classList.add('show');
  }
  if (els.downtimeReason) els.downtimeReason.focus();
}

function closeDowntimeModal() {
  if (els.downtimeModal) {
    els.downtimeModal.hidden = true;
    els.downtimeModal.classList.remove('show');
  }
  focusScanInput();
}

async function submitDowntime(includeReason) {
  const reasonCode = includeReason && els.downtimeReason ? String(els.downtimeReason.value || '').trim() : '';
  const reasonNote = includeReason && els.downtimeNote ? String(els.downtimeNote.value || '').trim() : '';
  closeDowntimeModal();
  const data = await postAction({
    action: 'scan',
    barcode: 'STOP:DOWNTIME',
    pending: {
      tank: pendingTank || (focusedSession() && focusedSession().tank_number) || null,
      piece: pendingPiece != null ? pendingPiece : focusedSession() ? focusedSession().piece_number : null,
    },
    tank_id: focusedSession() ? focusedSession().tank_id : session ? session.tank_id : null,
    reason_code: reasonCode || null,
    reason_note: reasonNote || null,
    ...confirmerPayload(),
  });
  if (data) await consumeScanResult(data);
  focusScanInput();
}

async function saveNoteModal() {
  const body = String(els.noteBody && els.noteBody.value ? els.noteBody.value : '').trim();
  if (noteMode === 'correction') {
    const barcode = pendingCorrectionBarcode || 'PHASE:CORRECTIONS';
    closeNoteModal();
    const data = await postAction({
      action: 'scan',
      barcode,
      notes: body || null,
      pending: { tank: pendingTank },
      ...confirmerPayload(),
    });
    if (data) await consumeScanResult(data);
    focusScanInput();
    return;
  }
  if (!body) {
    warn('Enter a note before saving.');
    if (els.noteBody) els.noteBody.focus();
    return;
  }
  const noteType = els.noteType ? els.noteType.value : 'general';
  const { res, data } = await api(`${API}/notes`, {
    method: 'POST',
    body: JSON.stringify({
      body,
      note_type: noteType,
      tank_number: session ? session.tank_number : pendingTank,
      piece_number: session ? session.piece_number : null,
    }),
  });
  closeNoteModal();
  if (!res.ok || !data.ok) {
    warn((data && data.message) || 'Could not save note.');
    focusScanInput();
    return;
  }
  warn('Note saved.');
  focusScanInput();
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

function activeProductionCounts() {
  const list = openSessions.length ? openSessions : [];
  const tankKeys = new Set();
  for (const s of list) {
    const tid = Number(s.tank_id);
    if (Number.isInteger(tid) && tid > 0) {
      tankKeys.add(`id:${tid}`);
      continue;
    }
    const tn = String(s.tank_number || '').trim().toUpperCase();
    if (tn) tankKeys.add(`num:${tn}`);
  }
  return { tanks: tankKeys.size, pieces: list.length };
}

function activeTankNumber() {
  if (pendingTank) return pendingTank;
  if (session && session.tank_number) return session.tank_number;
  if (config && config.active_tank_number) return config.active_tank_number;
  return null;
}

function openSessionForPiece(pieceNum) {
  const tankNorm = activeTankNumber() ? String(activeTankNumber()).toUpperCase() : null;
  if (pieceNum == null) return null;
  const source = openSessions.length ? openSessions : tankOpenSessions;
  if (tankNorm) {
    return (
      source.find(
        (s) =>
          String(s.tank_number || '').toUpperCase() === tankNorm &&
          Number(s.piece_number || 1) === Number(pieceNum)
      ) || null
    );
  }
  return source.find((s) => Number(s.piece_number || 1) === Number(pieceNum)) || null;
}

function focusedSession() {
  const pieceNum = selectedPieceNumber();
  if (pieceNum != null) {
    return openSessionForPiece(pieceNum);
  }
  if (pendingIsDifferentTank()) return null;
  const tankNorm = activeTankNumber() ? String(activeTankNumber()).toUpperCase() : null;
  if (tankNorm) {
    const onTank = openSessions.filter(
      (s) => String(s.tank_number || '').toUpperCase() === tankNorm
    );
    if (onTank.length === 1) return onTank[0];
    if (onTank.length > 1) return null;
  }
  return openSessions.length === 1 ? openSessions[0] : null;
}

function pieceStatusLabel(pieceNum) {
  const pieceRow = configuredPieces().find((p) => Number(p.piece_number) === Number(pieceNum));
  if (pieceRow && String(pieceRow.status) === 'completed') return 'Complete';
  const sess = openSessionForPiece(pieceNum);
  if (!sess) return 'Not Started';
  const st = sess.status || 'running';
  const stopReason = String(sess.stop_reason || '').toLowerCase();
  if (st === 'running') return 'Running';
  if (stopReason === 'downtime') return 'Downtime';
  if (stopReason === 'qa_qc') return 'QA/QC';
  if (stopReason === 'break') return 'Break';
  if (stopReason === 'lunch') return 'Lunch';
  return sess.status_label || 'Paused';
}

function pieceElapsedDisplay(pieceNum) {
  const sess = openSessionForPiece(pieceNum);
  if (!sess || !sess.started_at) return '';
  const start = new Date(sess.started_at).getTime();
  if (Number.isNaN(start)) return '';
  let end = Date.now();
  if (sess.status === 'finished' && sess.finished_at) end = new Date(sess.finished_at).getTime();
  if (sess.status === 'stopped' && sess.stopped_at) end = new Date(sess.stopped_at).getTime();
  return fmtElapsed(end - start);
}

function renderPieceStatusPanel() {
  if (!els.pieceStatusPanel) return;
  const list = configuredPieces();
  const tank = activeTankNumber();
  if (!list.length || !tank) {
    els.pieceStatusPanel.hidden = true;
    els.pieceStatusPanel.innerHTML = '';
    return;
  }
  const selected = selectedPieceNumber();
  els.pieceStatusPanel.hidden = false;
  els.pieceStatusPanel.innerHTML = list
    .map((p) => {
      const n = Number(p.piece_number);
      const status = pieceStatusLabel(n);
      const sess = openSessionForPiece(n);
      const phase = sess ? sess.phase_name || sess.activity_name || '—' : '—';
      const elapsed = pieceElapsedDisplay(n);
      const selectedCls = n === selected ? ' is-selected' : '';
      const runningCls = sess && sess.status === 'running' ? ' is-running' : '';
      const detail =
        status === 'Not Started'
          ? 'Not Started'
          : `${phase}${elapsed ? ` — ${elapsed}` : ''} — ${status}`;
      return `<div class="wk-piece-status${selectedCls}${runningCls}" data-piece="${n}">
        <div class="wk-piece-status-head">Piece ${n}</div>
        <div class="wk-piece-status-body">${detail}</div>
      </div>`;
    })
    .join('');
  els.pieceStatusPanel.querySelectorAll('[data-piece]').forEach((row) => {
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => {
      const n = Number(row.getAttribute('data-piece'));
      if (!Number.isInteger(n)) return;
      void postAction({
        action: 'scan',
        barcode: `PIECE:${n}`,
        pending: { tank: pendingTank || activeTankNumber(), piece: pendingPiece },
        ...confirmerPayload(),
      }).then((data) => {
        if (data) void consumeScanResult(data);
        focusScanInput();
      });
    });
  });
}

function configuredPieces() {
  const count = Math.min(4, Math.max(0, Number(pieceCount) || pieces.length || 0));
  if (!count) return pieces.slice();
  return pieces.filter((p) => Number(p.piece_number) >= 1 && Number(p.piece_number) <= count);
}

function pendingIsDifferentTank() {
  if (!pendingTank) return false;
  if (!session) return true;
  return String(session.tank_number || '').toUpperCase() !== String(pendingTank).toUpperCase();
}

function selectedPieceNumber() {
  if (pendingIsDifferentTank()) {
    return pendingPiece != null ? Number(pendingPiece) : null;
  }
  if (pendingPiece != null) return Number(pendingPiece);
  if (session) return Number(session.piece_number) || null;
  return null;
}

function renderPieceTouchButtons() {
  if (!els.pieceTouchButtons) return;
  const list = configuredPieces();
  if (!list.length && !pendingTank && !session) {
    els.pieceTouchButtons.innerHTML = '';
    els.pieceTouchButtons.hidden = true;
    return;
  }
  const count = Math.min(4, Math.max(1, Number(pieceCount) || list.length || 1));
  const source = list.length
    ? list
    : Array.from({ length: count }, (_, i) => ({ piece_number: i + 1, status: 'pending' }));
  const current = selectedPieceNumber();
  els.pieceTouchButtons.hidden = false;
  els.pieceTouchButtons.innerHTML = source
    .map((p) => {
      const n = Number(p.piece_number);
      const done = String(p.status) === 'completed';
      const selected = current === n;
      return `<button type="button" class="btn-secondary btn-touch${selected ? ' is-selected' : ''}${done ? ' is-done' : ''}" data-barcode="PIECE:${n}" ${done ? 'disabled' : ''}>Piece ${n}${done ? ' ✓' : ''}</button>`;
    })
    .join('');
}

function renderPieces() {
  if (!els.pieceChips) return;
  const list = configuredPieces();
  if (!list.length) {
    els.pieceChips.hidden = true;
    els.pieceChips.innerHTML = '';
    renderPieceTouchButtons();
    return;
  }
  els.pieceChips.hidden = false;
  const current = selectedPieceNumber();
  els.pieceChips.innerHTML = list
    .map((p) => {
      const n = Number(p.piece_number);
      let cls = 'wk-piece-chip';
      if (p.status === 'completed') cls += ' done';
      else if (n === current) cls += ' current';
      return `<span class="${cls}">Piece ${n}${p.status === 'completed' ? ' ✓' : ''}</span>`;
    })
    .join('');
  renderPieceTouchButtons();
}

function selectedContextKey() {
  const focused = focusedSession();
  if (focused && !pendingIsDifferentTank()) {
    return `${Number(focused.tank_id)}:${Number(focused.piece_number) || 1}`;
  }
  if (pendingTank && pendingPiece != null) {
    const match = openSessions.find(
      (s) =>
        String(s.tank_number || '').toUpperCase() === String(pendingTank).toUpperCase() &&
        Number(s.piece_number || 1) === Number(pendingPiece)
    );
    if (match) return `${Number(match.tank_id)}:${Number(match.piece_number) || 1}`;
  }
  return null;
}

function renderOpenTanks() {
  if (!els.openTanksPanel) return;
  if (!openSessions.length) {
    els.openTanksPanel.hidden = true;
    els.openTanksPanel.innerHTML = '';
    return;
  }
  els.openTanksPanel.hidden = false;
  const selectedKey = selectedContextKey();
  els.openTanksPanel.innerHTML = openSessions
    .map((s) => {
      const tankId = Number(s.tank_id);
      const pieceNum = Number(s.piece_number) || 1;
      const key = `${tankId}:${pieceNum}`;
      const active = selectedKey && key === selectedKey ? ' is-active' : '';
      const stCls = ` is-${statusClassForSession(s)}`;
      const sessionId = s.id != null ? Number(s.id) : '';
      return `<button type="button" class="btn-secondary wk-open-tank-btn${active}${stCls}" data-tank-id="${tankId}" data-piece-number="${pieceNum}" data-session-id="${sessionId}" aria-pressed="${active ? 'true' : 'false'}">
        Tank ${String(s.tank_number || '')} · Piece ${pieceNum} · ${String(s.phase_name || s.activity_name || '')}
      </button>`;
    })
    .join('');
  els.openTanksPanel.querySelectorAll('[data-tank-id]').forEach((btn) => {
    // Keep keyboard focus on the scan input (USB scanner ready); avoid mobile keyboard.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      void selectActiveContext({
        tankId: Number(btn.getAttribute('data-tank-id')),
        pieceNumber: Number(btn.getAttribute('data-piece-number')),
        sessionId: Number(btn.getAttribute('data-session-id')) || null,
      });
    });
  });
}

/**
 * Selection-only context switch among already-open sessions on this winder.
 * Does not start/stop sessions, change phase, or alter labor — only focuses UI.
 */
async function selectActiveContext({ tankId, pieceNumber, sessionId }) {
  const tid = Number(tankId);
  const pieceNum = Number(pieceNumber);
  if (!Number.isInteger(tid) || tid <= 0 || !Number.isInteger(pieceNum) || pieceNum < 1) {
    warn('Invalid tank/piece context.');
    focusScanInput();
    return;
  }

  const localMatch =
    openSessions.find((s) => {
      if (Number(s.tank_id) !== tid) return false;
      if (Number(s.piece_number || 1) !== pieceNum) return false;
      if (sessionId != null && Number.isInteger(Number(sessionId)) && Number(sessionId) > 0) {
        return Number(s.id) === Number(sessionId);
      }
      return true;
    }) || null;

  if (!localMatch) {
    warn('That tank/piece is not an active context on this winder.');
    focusScanInput();
    return;
  }

  const data = await postAction({
    action: 'switch_tank',
    tank_id: tid,
    piece_number: pieceNum,
    session_id: localMatch.id != null ? Number(localMatch.id) : sessionId,
  });
  if (!data) {
    focusScanInput();
    return;
  }
  await consumeScanResult(data);
  focusScanInput();
}

async function switchTank(tankId) {
  const onTank = openSessions.filter((s) => Number(s.tank_id) === Number(tankId));
  const preferred =
    onTank.find((s) => pendingPiece != null && Number(s.piece_number || 1) === Number(pendingPiece)) ||
    onTank[0] ||
    null;
  if (!preferred) {
    warn('That tank is not an active context on this winder.');
    focusScanInput();
    return;
  }
  await selectActiveContext({
    tankId: Number(preferred.tank_id),
    pieceNumber: Number(preferred.piece_number) || 1,
    sessionId: preferred.id != null ? Number(preferred.id) : null,
  });
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
  if (code === 'PREP_CLEANUP' || code === 'PART_COMPLETE' || code === 'PIECE_COMPLETE' || code === 'TANK_COMPLETE') {
    return false;
  }
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
  const display = focusedSession();
  if (!display) {
    els.valElapsed.textContent = '—';
    if (els.valTankTotal && !openSessions.length) els.valTankTotal.textContent = '—';
    return;
  }
  session = display;
  const start = new Date(display.started_at).getTime();
  if (Number.isNaN(start)) return;
  let end = Date.now();
  if (display.status === 'finished' && display.finished_at) end = new Date(display.finished_at).getTime();
  if (display.status === 'stopped' && display.stopped_at) end = new Date(display.stopped_at).getTime();
  const phaseMs = end - start;
  els.valElapsed.textContent = fmtElapsed(phaseMs);
  if (els.valTankTotal) {
    const summaryMs = tankTotalMs();
    let liveMs = summaryMs;
    if (display.status === 'running' && sessionCountsTowardTankTotal() && Number.isFinite(Number(display.elapsed_ms))) {
      liveMs = summaryMs - Number(display.elapsed_ms) + phaseMs;
    }
    els.valTankTotal.textContent = fmtTankTotal(liveMs > 0 ? liveMs : sessionCountsTowardTankTotal() ? phaseMs : summaryMs);
  }
}

function renderPhases() {
  if (!els.phaseButtons) return;
  els.phaseButtons.innerHTML = '';
  for (const ph of phases) {
    if (ph.completes || ph.piece_complete) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary selection-btn';
    btn.textContent = ph.label;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      els.phasePanel.hidden = true;
      void onPhaseSelected(ph);
    });
    els.phaseButtons.appendChild(btn);
  }
}

function renderUi() {
  renderAssignment();
  renderOpenTanks();
  renderPieces();
  renderPieceStatusPanel();
  renderQaQcUi();

  const displaySession = focusedSession();

  if (els.valPiece) {
    const n = selectedPieceNumber();
    els.valPiece.textContent = n ? `Piece ${n}` : '—';
  }

  // Multi-tank: an open session must not block configuring another scanned tank.
  const configuringNewTank = pendingIsDifferentTank();
  const tankNorm = activeTankNumber() ? String(activeTankNumber()).toUpperCase() : null;
  const activeOnTank = tankNorm
    ? openSessions.filter((s) => String(s.tank_number || '').toUpperCase() === tankNorm)
    : [];

  if (!displaySession && activeOnTank.length > 1 && !configuringNewTank && assignment && !pendingPiece) {
    els.valTeam.textContent = assignment.team_name;
    els.valTank.textContent = activeTankNumber() || '—';
    els.valPhase.textContent = `${activeOnTank.length} pieces active`;
    els.valStatus.textContent = 'Running';
    els.valStatus.className = 'wk-value wk-value--running';
    els.pendingPanel.hidden = true;
    els.phasePanel.hidden = true;
    els.workflowTitle.textContent = 'Multiple pieces running';
    els.workflowSub.textContent = 'Select the target piece above, then scan a phase. All running pieces stay active.';
    if (els.valElapsed) els.valElapsed.textContent = '—';
    renderPhaseSummary();
    return;
  }

  if (displaySession && !configuringNewTank) {
    els.valTeam.textContent = displaySession.team_name || (assignment ? assignment.team_name : '—');
    els.valTank.textContent = displaySession.tank_number || pendingTank || '—';
    els.valPhase.textContent = displaySession.phase_name || displaySession.activity_name || '—';
    const st = displaySession.status || 'running';
    const stopReason = String(displaySession.stop_reason || '').toLowerCase();
    els.valStatus.textContent = sessionStatusLabel(st, displaySession.status_label);
    els.valStatus.className = statusCssClass(displaySession);
    els.pendingPanel.hidden = true;
    els.phasePanel.hidden = true;
    els.workflowTitle.textContent = stopReason === 'qa_qc' ? 'QA/QC in progress' : 'Production in progress';
    if (pendingConfirmer) {
      els.workflowSub.textContent = `${pendingConfirmer.name} will confirm completion — scan Piece/Tank Complete or tap a button.`;
    } else if (stopReason === 'qa_qc') {
      els.workflowSub.textContent =
        'QA/QC Issue Open. Scan QA_QC_RESOLVE or tap Resolve QA/QC to resume this piece (other tanks continue).';
    } else if (st === 'stopped' && stopReason === 'downtime') {
      els.workflowSub.textContent = 'Selected piece is on Downtime. Tap Resume to continue only this piece.';
    } else if (st === 'stopped') {
      els.workflowSub.textContent = 'Paused. Scan RESUME or tap Resume to continue all paused tanks on this Winder.';
    } else {
      els.workflowSub.textContent =
        'Scan phase / piece / tank complete, or use touch buttons. Select piece above before changing phase.';
    }
    session = displaySession;
    renderPhaseSummary();
    tickElapsed();
    return;
  }

  els.pendingPanel.hidden = true;
  if (!configuringNewTank) pendingConfirmer = null;
  els.valElapsed.textContent = '—';
  if (els.valTankTotal) els.valTankTotal.textContent = '—';

  els.valTeam.textContent = assignment ? assignment.team_name : '—';
  els.valTank.textContent = pendingTank || '—';
  els.valPhase.textContent = '—';
  els.valStatus.textContent = configuringNewTank && openSessions.length ? 'Adding tank' : 'Idle';
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
    const { tanks, pieces } = activeProductionCounts();
    els.workflowSub.textContent = tanks
      ? `Team ${assignment.team_name} assigned. ${tanks} tank${tanks === 1 ? '' : 's'} active${pieces !== tanks ? ` (${pieces} piece${pieces === 1 ? '' : 's'})` : ''} — scan another Tank to add, or tap one above to select.`
      : `Team ${assignment.team_name} assigned. Scan a Tank to begin or resume. Touch buttons available anytime.`;
    els.phasePanel.hidden = true;
    if (els.phaseSummaryPanel) els.phaseSummaryPanel.hidden = true;
    return;
  }

  if (pendingPiece == null) {
    const count = Math.min(4, Math.max(1, Number(pieceCount) || configuredPieces().length || 1));
    els.workflowTitle.textContent = 'Select Piece';
    els.workflowSub.textContent =
      count <= 1
        ? `Tank ${pendingTank}: Piece 1 selected. Scan a phase to begin.`
        : `Tank ${pendingTank}: select Piece 1–${count} (do not assume Piece 1).`;
    els.phasePanel.hidden = true;
    if (els.phaseSummaryPanel) els.phaseSummaryPanel.hidden = true;
    return;
  }

  if (resumablePhase) {
    els.workflowTitle.textContent = 'Scan Phase or RESUME';
    els.workflowSub.textContent = `Tank ${pendingTank} · Piece ${pendingPiece}: scan RESUME to continue ${resumablePhase}, or scan a new Phase.`;
  } else {
    els.workflowTitle.textContent = 'Scan or select Phase';
    els.workflowSub.textContent = configuringNewTank
      ? `Tank ${pendingTank} · Piece ${pendingPiece}: scan a Phase to add this tank (other active tanks stay running).`
      : `Tank ${pendingTank} · Piece ${pendingPiece}: scan a Phase to begin production (timer starts on first scan).`;
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
  openSessions = data.open_sessions || [];
  tankOpenSessions = data.tank_open_sessions || [];
  pieces = data.pieces || [];
  pieceCount = Number(data.piece_count) || pieces.length || pieceCount || 0;
  assignment = data.assignment || null;
  phaseTimeSummary = data.phase_time_summary || [];
  downtimeReasons = data.downtime_reasons || downtimeReasons;
  openQaQc = data.open_qa_qc || null;
  if (
    !openQaQc &&
    session &&
    String(session.stop_reason || '').toLowerCase() === 'qa_qc'
  ) {
    openQaQc = {
      status: 'open',
      reported_at: session.stopped_at || null,
      phase_name: session.phase_name || session.activity_name || null,
      phase_code: session.activity_code || null,
      piece_number: session.piece_number != null ? Number(session.piece_number) : null,
      issue_note: null,
      notes: null,
    };
  }
  if (!assignment) {
    pendingTank = null;
    pendingPiece = null;
    resumablePhase = null;
  }
  if (data.pending && data.pending.tank) pendingTank = data.pending.tank;
  if (data.pending && data.pending.piece != null) pendingPiece = Number(data.pending.piece);
  if (Array.isArray(data.tank_open_sessions)) tankOpenSessions = data.tank_open_sessions;
  else if (pendingTank || data.active_tank_number) {
    const tankNorm = String(pendingTank || data.active_tank_number).toUpperCase();
    tankOpenSessions = openSessions.filter(
      (s) => String(s.tank_number || '').toUpperCase() === tankNorm
    );
  }
  session = focusedSession();
  if (!pendingTank && data.active_tank_number) pendingTank = data.active_tank_number;
  if (data.machine && data.machine.slug) {
    try {
      localStorage.setItem(KIOSK_SLUG_KEY, data.machine.slug);
    } catch (_err) {
      /* ignore */
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
    pending: { tank: pendingTank, piece: pendingPiece },
    ...confirmerPayload(),
  });
  if (data) await consumeScanResult(data);
  focusScanInput();
}

async function consumeScanResult(data) {
  applyAssignment(data);

  if (data.action === 'need_correction_note' || data.require_correction_note) {
    pendingCorrectionBarcode = 'PHASE:CORRECTIONS';
    openNoteModal('correction', 'Correction Notes');
    warn('Enter an optional correction note, then Save.');
    return;
  }
  if (data.action === 'confirmer' && data.employee) {
    pendingConfirmer = data.employee;
    warn(`Confirmer set: ${data.employee.name}.`);
    renderUi();
    focusScanInput();
    return;
  }
  if (data.action === 'employee_out_prompt') {
    await openEmployeeOutModal();
    return;
  }
  if (data.action === 'employee_out') {
    closeEmployeeOutModal();
    pendingConfirmer = null;
    warn(data.confirmation_line || `${(data.employee && data.employee.name) || 'Employee'} marked out.`);
    await loadConfig();
    focusScanInput();
    return;
  }
  if (data.action === 'employee_selected') {
    if (data.confirmer) pendingConfirmer = data.confirmer;
    else if (data.employee) pendingConfirmer = data.employee;
    warn(data.confirmation_line || `Selected Employee: ${(data.employee && data.employee.name) || 'Employee'}.`);
    renderUi();
    focusScanInput();
    return;
  }
  if (data.action === 'employee_transferred') {
    if (data.confirmer) pendingConfirmer = data.confirmer;
    else if (data.employee) pendingConfirmer = data.employee;
    warn(data.confirmation_line || `${(data.employee && data.employee.name) || 'Employee'} transferred.`);
    renderUi();
    focusScanInput();
    return;
  }
  if (data.action === 'team_assigned') {
    pendingTank = null;
    pendingPiece = null;
    resumablePhase = null;
    warn(`Team ${data.assignment ? data.assignment.team_name : ''} assigned for today. Scan a Tank to begin.`);
    await loadConfig();
    return;
  }
  if (data.alert) {
    openQaQc = data.open_qa_qc || (data.alert.alert_type === 'qa_qc' ? data.alert : openQaQc);
    warn(data.confirmation_line || `${data.alert.alert_label} reported — manager notified.`);
    await loadConfig();
    return;
  }
  if (data.action === 'qa_qc_resolved') {
    openQaQc = null;
    if (data.session) session = data.session;
    warn(data.confirmation_line || 'QA/QC resolved — production resumed.');
    await loadConfig();
    return;
  }
  if (data.action === 'alert_resolved') {
    openQaQc = null;
    warn(data.confirmation_line || 'Alert resolved.');
    await loadConfig();
    return;
  }
  if (data.action === 'pause') {
    if (data.session) session = data.session;
    if (data.sessions) openSessions = data.sessions;
    warn(data.confirmation_line || data.message || `${(data.pause_label || 'Break')} applied to all active tanks.`);
    await loadConfig();
    return;
  }
  if (data.action === 'downtime') {
    if (data.session) session = data.session;
    if (data.sessions) openSessions = data.sessions;
    warn(data.confirmation_line || data.message || 'Downtime started for selected tank.');
    await loadConfig();
    return;
  }
  if (data.action === 'resume') {
    if (data.session) session = data.session;
    if (data.sessions) openSessions = data.sessions;
    pendingTank = null;
    pendingPiece = null;
    resumablePhase = null;
    warn(
      data.confirmation_line ||
        data.message ||
        (data.tank_specific
          ? 'Selected tank resumed.'
          : data.resumed_phase
            ? `Resumed ${data.resumed_phase}.`
            : 'Production resumed on all active tanks.')
    );
    await loadConfig();
    return;
  }
  if (data.action === 'end_shift') {
    session = null;
    assignment = null;
    phaseTimeSummary = [];
    openSessions = [];
    pendingTank = null;
    pendingPiece = null;
    resumablePhase = null;
    pendingConfirmer = null;
    warn(
      data.confirmation_line ||
        data.message ||
        (data.tank_numbers && data.tank_numbers.length
          ? `End Shift applied. Stopped ${data.tank_numbers.length} tank(s) — phases preserved. Scan Team tomorrow to resume.`
          : 'End shift recorded. Scan Team tomorrow to begin.')
    );
    await loadConfig();
    return;
  }
  if (data.action === 'switch_tank') {
    // Selection only — keep other open sessions running; just focus this tank+piece.
    if (Array.isArray(data.open_sessions)) openSessions = data.open_sessions;
    if (Array.isArray(data.tank_open_sessions)) tankOpenSessions = data.tank_open_sessions;
    if (data.pieces) pieces = data.pieces;
    if (data.piece_count != null) pieceCount = Number(data.piece_count) || pieces.length;
    if (data.phase_time_summary) phaseTimeSummary = data.phase_time_summary;
    if (Object.prototype.hasOwnProperty.call(data, 'open_qa_qc')) openQaQc = data.open_qa_qc || null;
    pendingTank =
      (data.pending && data.pending.tank) ||
      (data.session && data.session.tank_number) ||
      pendingTank;
    pendingPiece =
      data.pending && data.pending.piece != null
        ? Number(data.pending.piece)
        : data.session
          ? Number(data.session.piece_number) || null
          : pendingPiece;
    resumablePhase = null;
    session = focusedSession() || data.session || null;
    warn(
      data.message ||
        (pendingTank && pendingPiece != null
          ? `Selected Tank ${pendingTank} · Piece ${pendingPiece}.`
          : 'Context selected.')
    );
    renderUi();
    // Refresh from server so timers/phase summary stay authoritative without mutating production.
    await loadConfig();
    if (data.pending && data.pending.tank) pendingTank = data.pending.tank;
    if (data.pending && data.pending.piece != null) pendingPiece = Number(data.pending.piece);
    if (Object.prototype.hasOwnProperty.call(data, 'open_qa_qc')) openQaQc = data.open_qa_qc || null;
    if (data.phase_time_summary) phaseTimeSummary = data.phase_time_summary;
    session = focusedSession() || data.session || session;
    renderUi();
    focusScanInput();
    return;
  }
  if (data.action === 'piece_selected') {
    if (data.session) session = data.session;
    if (data.pieces) pieces = data.pieces;
    if (data.piece_count != null) pieceCount = Number(data.piece_count) || pieces.length;
    if (data.pending && data.pending.tank) pendingTank = data.pending.tank;
    pendingPiece = data.piece_number != null ? Number(data.piece_number) : pendingPiece;
    if (Array.isArray(data.open_sessions)) openSessions = data.open_sessions;
    if (Array.isArray(data.tank_open_sessions)) tankOpenSessions = data.tank_open_sessions;
    else if (pendingTank) {
      const tankNorm = String(pendingTank).toUpperCase();
      tankOpenSessions = openSessions.filter(
        (s) => String(s.tank_number || '').toUpperCase() === tankNorm
      );
    }
    warn(data.message || `Piece ${data.piece_number || ''} selected.`);
    renderUi();
    focusScanInput();
    return;
  }
  if (data.action === 'tank_selected') {
    pendingTank = data.pending ? data.pending.tank : pendingTank;
    pendingPiece = data.pending && data.pending.piece != null ? Number(data.pending.piece) : null;
    resumablePhase = data.resumable_phase || null;
    if (data.pieces) pieces = data.pieces;
    if (data.piece_count != null) pieceCount = Number(data.piece_count) || pieces.length;
    if (Array.isArray(data.open_sessions)) openSessions = data.open_sessions;
    if (Array.isArray(data.tank_open_sessions)) tankOpenSessions = data.tank_open_sessions;
    else if (pendingTank) {
      const tankNorm = String(pendingTank).toUpperCase();
      tankOpenSessions = openSessions.filter(
        (s) => String(s.tank_number || '').toUpperCase() === tankNorm
      );
    }
    warn(data.message || `Tank ${pendingTank} selected.`);
    renderUi();
    focusScanInput();
    return;
  }
  if (data.action === 'piece_complete') {
    pendingConfirmer = null;
    if (Array.isArray(data.open_sessions)) openSessions = data.open_sessions;
    if (data.pieces) pieces = data.pieces;
    if (data.tank_number) pendingTank = data.tank_number;
    session = focusedSession();
    showFinishBanner(data.confirmation_line || `Piece ${data.piece_number || ''} complete`);
    if (data.all_pieces_complete) {
      pendingPiece = null;
      warn(data.message || 'All pieces complete. Status is Ready to Complete — scan Tank Complete to finish.');
    } else if (data.next_piece) {
      pendingPiece = Number(data.next_piece);
      warn(`Piece complete. Continue with Piece ${data.next_piece}, then scan a phase.`);
    } else {
      pendingPiece = null;
    }
    await loadConfig();
    return;
  }
  if (data.action === 'part_complete' || data.action === 'tank_complete') {
    session = null;
    pendingConfirmer = null;
    phaseTimeSummary = [];
    pendingTank = null;
    pendingPiece = null;
    resumablePhase = null;
    showFinishBanner(data.confirmation_line || 'Tank complete');
    await loadConfig();
    return;
  }
  if (data.session || Array.isArray(data.open_sessions)) {
    if (Array.isArray(data.open_sessions)) openSessions = data.open_sessions;
    if (Array.isArray(data.tank_open_sessions)) tankOpenSessions = data.tank_open_sessions;
    if (data.pending) {
      if (data.pending.tank) pendingTank = data.pending.tank;
      if (data.pending.piece != null) pendingPiece = Number(data.pending.piece);
    }
    session = focusedSession() || data.session || null;
    await loadConfig();
    return;
  }
  await loadConfig();
}

async function handleScan(raw) {
  warn('');
  const value = String(raw || '').trim();
  if (!value) {
    focusScanInput();
    return;
  }
  const upper = value.toUpperCase();
  if (upper === 'STOP:DOWNTIME' || upper === 'STOP_DOWNTIME' || upper === 'DOWNTIME') {
    openDowntimeModal();
    return;
  }
  if (
    upper === 'QA_QC_RESOLVE' ||
    upper === 'RESOLVE_QA_QC' ||
    upper === 'RESOLVE:QA_QC' ||
    upper === 'ALERT:QA_QC_RESOLVE'
  ) {
    openResolveQaQcModal();
    return;
  }
  if (isEmployeeOutBarcode(value)) {
    await openEmployeeOutModal();
    return;
  }
  const data = await postAction({
    action: 'scan',
    barcode: value,
    pending: { tank: pendingTank, piece: pendingPiece },
    ...confirmerPayload(),
  });
  if (!data) {
    // Invalid / unrecognized barcode — clear and stay ready for the next scan.
    focusScanInput();
    return;
  }
  await consumeScanResult(data);
  focusScanInput();
}

function processScan(v) {
  if (els.manual) els.manual.value = '';
  scanBuffer = '';
  void handleScan(v);
}

if (els.scanForm) {
  els.scanForm.addEventListener('submit', (e) => {
    e.preventDefault();
    processScan(els.manual ? els.manual.value : '');
  });
}
if (els.scanButton) els.scanButton.addEventListener('click', () => processScan(els.manual ? els.manual.value : ''));
if (els.logoutBtn) {
  els.logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/kiosk-logout', { method: 'POST' });
    window.location.href = '/kiosk-login';
  });
}
if (els.btnOpenNotes) {
  els.btnOpenNotes.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnOpenNotes.addEventListener('click', () => openNoteModal('general', 'Production Notes'));
}
if (els.btnShowPhases) {
  els.btnShowPhases.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnShowPhases.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    blurScanInputs();
    openChangePhaseModal();
  });
}
if (els.btnSaveNote) els.btnSaveNote.addEventListener('click', () => void saveNoteModal());
if (els.btnCancelNote) els.btnCancelNote.addEventListener('click', () => closeNoteModal());
if (els.btnSaveDowntime) els.btnSaveDowntime.addEventListener('click', () => void submitDowntime(true));
if (els.btnSkipDowntimeReason) els.btnSkipDowntimeReason.addEventListener('click', () => void submitDowntime(false));
if (els.btnCancelDowntime) els.btnCancelDowntime.addEventListener('click', () => closeDowntimeModal());
if (els.btnResolveQaQcPanel) {
  els.btnResolveQaQcPanel.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnResolveQaQcPanel.addEventListener('click', () => openResolveQaQcModal());
}
if (els.btnConfirmResolveQaQc) {
  els.btnConfirmResolveQaQc.addEventListener('click', () => void submitResolveQaQc(true));
}
if (els.btnSkipResolveQaQcNote) {
  els.btnSkipResolveQaQcNote.addEventListener('click', () => void submitResolveQaQc(false));
}
if (els.btnCancelResolveQaQc) {
  els.btnCancelResolveQaQc.addEventListener('click', () => closeResolveQaQcModal());
}
if (els.btnEmployeeOut) {
  els.btnEmployeeOut.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnEmployeeOut.addEventListener('click', () => {
    void openEmployeeOutModal();
  });
}
if (els.btnCancelEmployeeOut) {
  els.btnCancelEmployeeOut.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnCancelEmployeeOut.addEventListener('click', () => {
    closeEmployeeOutModal();
    focusScanInput();
  });
}
if (els.btnConfirmEmployeeOut) {
  els.btnConfirmEmployeeOut.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnConfirmEmployeeOut.addEventListener('click', () => void confirmEmployeeOut());
}
if (els.employeeOutModal) {
  els.employeeOutModal.addEventListener('click', (e) => {
    if (e.target === els.employeeOutModal) {
      closeEmployeeOutModal();
      focusScanInput();
    }
  });
}
if (els.btnCancelChangePhase) {
  els.btnCancelChangePhase.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnCancelChangePhase.addEventListener('click', () => {
    closeChangePhaseModal();
    focusScanInput();
  });
}
if (els.btnConfirmChangePhase) {
  els.btnConfirmChangePhase.addEventListener('mousedown', (e) => e.preventDefault());
  els.btnConfirmChangePhase.addEventListener('click', () => void confirmChangePhase());
}
if (els.changePhaseModal) {
  els.changePhaseModal.addEventListener('click', (e) => {
    if (e.target === els.changePhaseModal) {
      closeChangePhaseModal();
      focusScanInput();
    }
  });
}
if (els.touchControls) {
  els.touchControls.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('[data-barcode], button');
    if (btn) e.preventDefault();
  });
  els.touchControls.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-barcode]');
    if (!btn) return;
    const barcode = btn.getAttribute('data-barcode');
    if (!barcode) return;
    if (barcode === 'PHASE:CORRECTIONS') {
      pendingCorrectionBarcode = barcode;
      openNoteModal('correction', 'Correction Notes');
      return;
    }
    if (String(barcode).toUpperCase() === 'STOP:DOWNTIME') {
      openDowntimeModal();
      return;
    }
    if (String(barcode).toUpperCase() === 'QA_QC_RESOLVE') {
      openResolveQaQcModal();
      return;
    }
    processScan(barcode);
  });
}

document.addEventListener('keydown', (e) => {
  if (
    e.target === els.manual ||
    e.target === els.noteBody ||
    e.target === els.downtimeNote ||
    e.target === els.downtimeReason ||
    e.target === els.resolveQaQcNote
  ) {
    return;
  }
  if (e.target === els.noteType) return;
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

if (window.FactoryI18n) {
  window.FactoryI18n.mountSelector('kioskLangMount');
  window.FactoryI18n.applyDom();
}

void loadConfig().then(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 1000);
  setInterval(() => void loadConfig(), 12000);
  focusScanInput();
});

// If the operator clicks empty page chrome, snap focus back for the scanner.
document.addEventListener('click', (e) => {
  if (isTextEntryModalOpen()) return;
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('input, textarea, select, a, button, label, .modal-note')) return;
  focusScanInput({ clear: false });
});
