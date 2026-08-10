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
};

let config = null;
let assignment = null;
let session = null;
let openSessions = [];
let pieces = [];
let pieceCount = 0;
let phaseTimeSummary = [];
let pendingTank = null;
let pendingPiece = null;
let resumablePhase = null;
let pendingConfirmer = null;
let phases = [];
let elapsedTimer = null;
let scanBuffer = '';
let lastKeyTime = 0;
let noteMode = 'general'; // general | correction
let pendingCorrectionBarcode = null;
let downtimeReasons = [];
let openQaQc = null;

function isTextEntryModalOpen() {
  const noteOpen = els.noteModal && !els.noteModal.hidden && els.noteModal.classList.contains('show');
  const downtimeOpen =
    els.downtimeModal && !els.downtimeModal.hidden && els.downtimeModal.classList.contains('show');
  const resolveOpen =
    els.resolveQaQcModal && !els.resolveQaQcModal.hidden && els.resolveQaQcModal.classList.contains('show');
  return Boolean(noteOpen || downtimeOpen || resolveOpen);
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
    pending: { tank: pendingTank || (session && session.tank_number) || null },
    tank_id: session ? session.tank_id : null,
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
  // Multi-tank: while configuring a newly scanned tank, ignore the other open session's piece.
  if (pendingIsDifferentTank()) {
    return pendingPiece != null ? Number(pendingPiece) : null;
  }
  if (session) return Number(session.piece_number) || null;
  if (pendingPiece != null) return Number(pendingPiece);
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

function renderOpenTanks() {
  if (!els.openTanksPanel) return;
  if (!openSessions.length) {
    els.openTanksPanel.hidden = true;
    els.openTanksPanel.innerHTML = '';
    return;
  }
  els.openTanksPanel.hidden = false;
  const activeId = session && !pendingIsDifferentTank() ? Number(session.tank_id) : null;
  els.openTanksPanel.innerHTML = openSessions
    .map((s) => {
      const active = Number(s.tank_id) === activeId ? ' is-active' : '';
      const stCls = ` is-${statusClassForSession(s)}`;
      return `<button type="button" class="btn-secondary wk-open-tank-btn${active}${stCls}" data-tank-id="${Number(s.tank_id)}">
        Tank ${String(s.tank_number || '')} - Piece ${Number(s.piece_number) || 1} - ${String(s.phase_name || s.activity_name || '')}
      </button>`;
    })
    .join('');
  els.openTanksPanel.querySelectorAll('[data-tank-id]').forEach((btn) => {
    // Keep keyboard focus on the scan input (USB scanner ready).
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => void switchTank(Number(btn.getAttribute('data-tank-id'))));
  });
}

async function switchTank(tankId) {
  const data = await postAction({ action: 'switch_tank', tank_id: tankId });
  if (data) await loadConfig();
  focusScanInput();
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
  renderQaQcUi();

  if (els.valPiece) {
    const n = selectedPieceNumber();
    els.valPiece.textContent = n ? `Piece ${n}` : '—';
  }

  // Multi-tank: an open session must not block configuring another scanned tank.
  const configuringNewTank = pendingIsDifferentTank();

  if (session && !configuringNewTank) {
    els.valTeam.textContent = session.team_name || (assignment ? assignment.team_name : '—');
    els.valTank.textContent = session.tank_number || '—';
    els.valPhase.textContent = session.phase_name || session.activity_name || '—';
    const st = session.status || 'running';
    const stopReason = String(session.stop_reason || '').toLowerCase();
    els.valStatus.textContent = sessionStatusLabel(st, session.status_label);
    els.valStatus.className = statusCssClass(session);
    els.pendingPanel.hidden = true;
    els.phasePanel.hidden = true;
    els.workflowTitle.textContent = stopReason === 'qa_qc' ? 'QA/QC in progress' : 'Production in progress';
    if (pendingConfirmer) {
      els.workflowSub.textContent = `${pendingConfirmer.name} will confirm completion — scan Piece/Tank Complete or tap a button.`;
    } else if (stopReason === 'qa_qc') {
      els.workflowSub.textContent =
        'QA/QC Issue Open. Scan QA_QC_RESOLVE or tap Resolve QA/QC to resume this piece (other tanks continue).';
    } else if (st === 'stopped' && stopReason === 'downtime') {
      els.workflowSub.textContent = 'Selected tank is on Downtime. Tap Resume to continue only this tank.';
    } else if (st === 'stopped') {
      els.workflowSub.textContent = 'Paused. Scan RESUME or tap Resume to continue all paused tanks on this Winder.';
    } else {
      els.workflowSub.textContent = 'Scan phase / piece / tank complete, or use touch buttons. Switch tanks above if multiple are active.';
    }
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
    els.workflowSub.textContent = openSessions.length
      ? `Team ${assignment.team_name} assigned. ${openSessions.length} tank(s) active — scan another Tank to add, or tap one above to select.`
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
  session = data.session || null;
  openSessions = data.open_sessions || [];
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
  if (session) {
    pendingTank = null;
    pendingPiece = Number(session.piece_number) || pendingPiece;
  } else if (data.active_tank_number && !pendingTank) {
    // After Piece Complete, keep the tank available for the next piece.
    pendingTank = data.active_tank_number;
  }
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
    if (data.session) session = data.session;
    if (data.pieces) pieces = data.pieces;
    if (data.piece_count != null) pieceCount = Number(data.piece_count) || pieces.length;
    pendingTank = null;
    pendingPiece = data.session ? Number(data.session.piece_number) || null : null;
    resumablePhase = null;
    warn(data.session ? `Switched to tank ${data.session.tank_number}.` : 'Tank switched.');
    await loadConfig();
    return;
  }
  if (data.action === 'piece_selected') {
    if (data.session) session = data.session;
    if (data.pieces) pieces = data.pieces;
    if (data.piece_count != null) pieceCount = Number(data.piece_count) || pieces.length;
    if (data.pending && data.pending.tank) pendingTank = data.pending.tank;
    pendingPiece = data.piece_number != null ? Number(data.piece_number) : pendingPiece;
    warn(data.message || `Piece ${data.piece_number || ''} selected.`);
    renderUi();
    return;
  }
  if (data.action === 'tank_selected') {
    pendingTank = data.pending ? data.pending.tank : pendingTank;
    pendingPiece = data.pending && data.pending.piece != null ? Number(data.pending.piece) : null;
    resumablePhase = data.resumable_phase || null;
    if (data.pieces) pieces = data.pieces;
    if (data.piece_count != null) pieceCount = Number(data.piece_count) || pieces.length;
    // Keep existing open sessions — scanning another tank must not replace them.
    if (Array.isArray(data.open_sessions)) openSessions = data.open_sessions;
    warn(data.message || `Tank ${pendingTank} selected.`);
    renderUi();
    return;
  }
  if (data.action === 'piece_complete') {
    pendingConfirmer = null;
    session = null;
    if (data.pieces) pieces = data.pieces;
    if (data.tank_number) pendingTank = data.tank_number;
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
  if (data.session) {
    session = data.session;
    pendingTank = null;
    pendingPiece = null;
    resumablePhase = null;
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
  els.btnShowPhases.addEventListener('click', () => {
    if (els.phasePanel) {
      els.phasePanel.hidden = !els.phasePanel.hidden;
      if (!els.phasePanel.hidden) renderPhases();
    }
    focusScanInput();
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
