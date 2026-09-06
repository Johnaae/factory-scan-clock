'use strict';

/** Winding Machine Phase 1 — phases, alerts, sessions. */
const WINDING_PHASES = [
  { code: 'PREP_CLEANUP', label: 'Prep/Clean up', barcode: 'PHASE:PREP_CLEANUP' },
  { code: 'CHOP', label: 'Chop', barcode: 'PHASE:CHOP' },
  { code: 'RIB_INSTALL', label: 'Rib Install', barcode: 'PHASE:RIB_INSTALL' },
  { code: 'DOME_INSTALL', label: 'Dome Install', barcode: 'PHASE:DOME_INSTALL' },
  { code: 'WIND', label: 'Wind', barcode: 'PHASE:WIND' },
  { code: 'HOT_COAT', label: 'Hot Coat', barcode: 'PHASE:HOT_COAT' },
  { code: 'GRIND', label: 'Grind', barcode: 'PHASE:GRIND' },
  { code: 'LINER', label: 'Liner', barcode: 'PHASE:LINER' },
  { code: 'CORRECTIONS', label: 'Corrections', barcode: 'PHASE:CORRECTIONS' },
  { code: 'SPACER_GLASS', label: 'Spacer Glass', barcode: 'PHASE:SPACER_GLASS' },
  { code: 'PART_COMPLETE', label: 'Part Complete', barcode: 'PHASE:PART_COMPLETE', completes: true },
  { code: 'PIECE_COMPLETE', label: 'Piece Complete', barcode: 'PHASE:PIECE_COMPLETE', piece_complete: true },
  { code: 'TANK_COMPLETE', label: 'Tank Complete', barcode: 'PHASE:TANK_COMPLETE', completes: true },
];

/** Production phases included in Tank Total Running Time (excludes Prep/Clean up). */
const TANK_TOTAL_RUNNING_PHASE_CODES = new Set([
  'CHOP',
  'RIB_INSTALL',
  'DOME_INSTALL',
  'WIND',
  'HOT_COAT',
  'GRIND',
  'LINER',
  'CORRECTIONS',
  'SPACER_GLASS',
]);

function isTankTotalRunningPhaseCode(code) {
  return TANK_TOTAL_RUNNING_PHASE_CODES.has(String(code || '').trim().toUpperCase());
}

const ALERT_TYPES = [
  {
    code: 'QA_QC',
    label: 'QA/QC Alert',
    barcode: 'ALERT:QA_QC',
    alert_type: 'qa_qc',
    css_class: 'alert-qa',
  },
  {
    code: 'MAINTENANCE',
    label: 'Maintenance/Tooling Alert',
    barcode: 'ALERT:MAINTENANCE',
    alert_type: 'maintenance',
    css_class: 'alert-maint',
  },
];

const PAUSE_REASONS = {
  BREAK: { code: 'BREAK', label: 'Break', barcode: 'STOP:BREAK', stop_reason: 'break', resumable: true, winder_level: true },
  LUNCH: { code: 'LUNCH', label: 'Lunch', barcode: 'STOP:LUNCH', stop_reason: 'lunch', resumable: true, winder_level: true },
  DOWNTIME: {
    code: 'DOWNTIME',
    label: 'Downtime',
    barcode: 'STOP:DOWNTIME',
    stop_reason: 'downtime',
    resumable: true,
    winder_level: false,
    tank_specific: true,
  },
  END_SHIFT: {
    code: 'END_SHIFT',
    label: 'End Shift',
    barcode: 'REASON:END_SHIFT',
    stop_reason: 'end_shift',
    resumable: false,
    winder_level: true,
  },
};

const DOWNTIME_REASON_OPTIONS = [
  { code: 'mold_issue', label: 'Mold issue' },
  { code: 'material_unavailable', label: 'Material unavailable' },
  { code: 'equipment_issue', label: 'Equipment issue' },
  { code: 'quality_inspection', label: 'Quality inspection' },
  { code: 'waiting_for_cure', label: 'Waiting for cure' },
  { code: 'other', label: 'Other' },
];

const RESUME_BARCODES = new Set(['RESUME', 'STOP:RESUME', 'ACTION:RESUME']);

const WINDING_MACHINES = [
  { areaName: 'Winding Machine 01', code: 'WM-01', barcode: 'WM-01', kioskSlug: 'winding-machine-01', sortOrder: 1 },
  { areaName: 'Winding Machine 02', code: 'WM-02', barcode: 'WM-02', kioskSlug: 'winding-machine-02', sortOrder: 2 },
  { areaName: 'Winding Machine 03', code: 'WM-03', barcode: 'WM-03', kioskSlug: 'winding-machine-03', sortOrder: 3 },
];

const WINDING_MACHINE_AREA_NAMES = WINDING_MACHINES.map((m) => m.areaName);

/** Seed defaults for WM-01/02/03. Live lists come from the machines table. */
const CANONICAL_WINDING_MACHINE_CODES = WINDING_MACHINES.map((m) => m.code);

function isCanonicalWindingMachineCode(code) {
  const c = String(code || '')
    .trim()
    .toUpperCase();
  return CANONICAL_WINDING_MACHINE_CODES.includes(c);
}

function isLegacyWindingStationRecord(row) {
  if (!row) return false;
  if (isCanonicalWindingMachineCode(row.code)) return false;
  const code = String(row.code || '')
    .trim()
    .toUpperCase();
  const name = String(row.name || '').trim();
  if (code.startsWith('WS-')) return true;
  if (/^winding\s+station\b/i.test(name)) return true;
  return false;
}

/** Legacy login / log labels → canonical machine area name. */
const WINDING_MACHINE_LEGACY_AREA_ALIASES = {
  'Winding Machine 01': 'Winding Machine 01',
  'Winding Machine 02': 'Winding Machine 02',
  'Winding Machine 03': 'Winding Machine 03',
  'Winding Machine 1': 'Winding Machine 01',
  'Winding Machine 2': 'Winding Machine 02',
  'Winding Machine 3': 'Winding Machine 03',
  'Area A': 'Winding Machine 01',
  Fabrication: 'Winding Machine 01',
  'Winding Station 1': 'Winding Machine 01',
  'Winding Station 2': 'Winding Machine 02',
  'Winding Station 3': 'Winding Machine 03',
  'Winding Station 01': 'Winding Machine 01',
  'Winding Station 02': 'Winding Machine 02',
  'Winding Station 03': 'Winding Machine 03',
  'WS-01': 'Winding Machine 01',
  'WS-02': 'Winding Machine 02',
  'WS-03': 'Winding Machine 03',
};

function normalizeWindingMachineAreaName(area) {
  const raw = String(area || '').trim();
  if (!raw) return '';
  return WINDING_MACHINE_LEGACY_AREA_ALIASES[raw] || raw;
}

function isWindingMachineAreaName(area) {
  const raw = String(area || '').trim();
  if (!raw) return false;
  const n = normalizeWindingMachineAreaName(raw);
  if (WINDING_MACHINE_AREA_NAMES.includes(n)) return true;
  // Machines created in Manage Machines (Winding Machine 04, etc.)
  return /^winding\s+machine\b/i.test(raw) || /^winding\s+machine\b/i.test(n);
}

function slugFromMachineName(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `machine-${Date.now()}`;
}

function kioskUrlForSlug(slug) {
  const s = String(slug || '')
    .trim()
    .toLowerCase();
  return s ? `/kiosk/machine/${encodeURIComponent(s)}` : '/kiosk/machine';
}

function displayMachineName(name) {
  const n = String(name || '').trim();
  if (!n) return n;
  return normalizeWindingMachineAreaName(n) || n;
}

function mapMachineForClient(row) {
  if (!row) return null;
  const slug = String(row.kiosk_slug || slugFromMachineName(row.name))
    .trim()
    .toLowerCase();
  return {
    id: Number(row.id),
    name: displayMachineName(row.name),
    slug,
    kiosk_url: kioskUrlForSlug(slug),
    sort_order: Number(row.sort_order) || 0,
    active: Number(row.active) !== 0,
  };
}

function countActiveProduction(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
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
  return {
    active_tank_count: tankKeys.size,
    active_piece_count: list.length,
  };
}

function createPhase1ProductionLogic(deps) {
  const {
    pool,
    nowIso,
    normalizeTankNumber,
    normalizeTankStatus,
    startEndOfLocalDay,
    localDateString,
    weekBoundsLocal,
  } = deps;
  // Production passes validateTankExists (lookup only). Test scripts may pass ensureTankExists that creates temp tanks.
  const validateTankExists = deps.validateTankExists || deps.ensureTankExists;
  const TANK_NOT_FOUND_MESSAGE =
    deps.tankNotFoundMessage || 'Tank not found. Please contact your supervisor.';

  const { createTeamMembershipAndLabor } = require('./team-membership-labor');
  let membershipApi = null;
  function getMembershipApi() {
    if (!membershipApi) {
      membershipApi = createTeamMembershipAndLabor(pool, {
        nowIso,
        sessionElapsedMs,
        isProductionPhaseCode,
        roundHours2,
        formatDurationSummary,
        displayMachineName,
      });
    }
    return membershipApi;
  }

  function normalizeTeamBarcode(raw) {
    if (raw === undefined || raw === null) return '';
    return String(raw).trim().toUpperCase().replace(/\s+/g, '');
  }

  function normalizeMachineBarcode(raw) {
    if (raw === undefined || raw === null) return '';
    let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
    s = s.replace(/^MACHINE[:_]/, '').replace(/^WM[:_]/, 'WM-');
    if (/^WM\d+$/.test(s)) s = `WM-${s.slice(2).padStart(2, '0')}`;
    return s;
  }

  function normalizePhaseCode(raw) {
    const s = String(raw || '')
      .trim()
      .toUpperCase()
      .replace(/^PHASE[:_]/, '')
      .replace(/^ACTIVITY[:_]/, '')
      .replace(/\//g, '_')
      .replace(/\s+/g, '_');
    return s;
  }

  function resolvePhase(raw) {
    const code = normalizePhaseCode(raw);
    let found = WINDING_PHASES.find((p) => p.code === code);
    if (found) return found;
    const labelKey = String(raw || '')
      .trim()
      .toLowerCase();
    found = WINDING_PHASES.find((p) => p.label.toLowerCase() === labelKey);
    return found || null;
  }

  function resolveAlert(raw) {
    const s = String(raw || '')
      .trim()
      .toUpperCase()
      .replace(/^ALERT[:_]/, '')
      .replace(/^PROBLEM[:_]/, '');
    return ALERT_TYPES.find(
      (a) =>
        a.code === s ||
        a.barcode.toUpperCase() === String(raw || '').trim().toUpperCase() ||
        a.barcode.toUpperCase().replace('ALERT:', '') === s
    );
  }

  function normalizeStopReason(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/-/g, '_');
  }

  function resolvePauseReason(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return null;
    const code = s.replace(/^STOP[:_]/, '');
    for (const def of Object.values(PAUSE_REASONS)) {
      if (!def.resumable || def.tank_specific) continue;
      if (def.barcode === s || def.code === code || def.code === s) return def;
    }
    return null;
  }

  function resolveDowntimeReason(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return null;
    const code = s.replace(/^STOP[:_]/, '');
    const def = PAUSE_REASONS.DOWNTIME;
    if (def.barcode === s || def.code === code || def.code === s) return def;
    return null;
  }

  function resolveEndShift(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return null;
    if (s === PAUSE_REASONS.END_SHIFT.barcode || s === PAUSE_REASONS.END_SHIFT.code || s === 'REASON_END_SHIFT') {
      return PAUSE_REASONS.END_SHIFT;
    }
    return null;
  }

  function isResumeScan(raw) {
    const s = String(raw || '').trim().toUpperCase();
    return RESUME_BARCODES.has(s);
  }

  /** Winder-level resumable pauses (not tank-specific Downtime or QA/QC). */
  function isWinderResumableStopReason(reason) {
    const r = normalizeStopReason(reason);
    return r === 'break' || r === 'lunch' || r === 'maintenance';
  }

  function isDowntimeStopReason(reason) {
    return normalizeStopReason(reason) === 'downtime';
  }

  function isQaQcStopReason(reason) {
    return normalizeStopReason(reason) === 'qa_qc';
  }

  function isResumableStopReason(reason) {
    return isWinderResumableStopReason(reason) || isDowntimeStopReason(reason) || isQaQcStopReason(reason);
  }

  function sessionStatusLabelFromRow(row) {
    if (!row) return 'Idle';
    const status = String(row.status || '').toLowerCase();
    if (status === 'running') return 'Running';
    if (status === 'finished') return 'Completed';
    if (status === 'stopped') {
      const reason = normalizeStopReason(row.stop_reason);
      if (reason === 'break') return 'Break';
      if (reason === 'lunch') return 'Lunch';
      if (reason === 'downtime') return 'Downtime';
      if (reason === 'end_shift') return 'End Shift';
      if (reason === 'qa_qc') return 'QA/QC';
      if (reason === 'maintenance') return 'Maintenance';
      return 'Paused';
    }
    return 'Idle';
  }

  function sessionElapsedMs(session, nowMs = Date.now()) {
    if (!session) return 0;
    const startMs = new Date(session.started_at).getTime();
    if (Number.isNaN(startMs)) return 0;
    if (session.status === 'finished' && session.finished_at) {
      const endMs = new Date(session.finished_at).getTime();
      return Number.isNaN(endMs) ? 0 : Math.max(0, endMs - startMs);
    }
    if (session.status === 'stopped' && session.stopped_at) {
      const stopMs = new Date(session.stopped_at).getTime();
      return Number.isNaN(stopMs) ? 0 : Math.max(0, stopMs - startMs);
    }
    return Math.max(0, nowMs - startMs);
  }

  function formatElapsedDisplay(ms) {
    const totalSec = Math.floor(Math.max(0, ms) / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hh > 0) return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    return `${pad(mm)}:${pad(ss)}`;
  }

  function isProductionPhaseCode(code) {
    return String(code || '').trim().toUpperCase() !== 'PART_COMPLETE';
  }

  function sessionStatusLabel(status) {
    if (status === 'running') return 'Running';
    if (status === 'stopped' || status === 'paused') return 'Paused';
    if (status === 'finished' || status === 'completed') return 'Completed';
    return '—';
  }

  function formatDurationSummary(ms) {
    const totalMin = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
    if (totalMin < 1) return '0m';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }

  function computeTankTotalRunningMs(phaseTimeSummary) {
    if (!Array.isArray(phaseTimeSummary)) return 0;
    return phaseTimeSummary.reduce((sum, row) => {
      if (row.counts_toward_tank_total === false) return sum;
      if (!isTankTotalRunningPhaseCode(row.phase_code)) return sum;
      return sum + (Number(row.total_duration_ms) || 0);
    }, 0);
  }

  function tankTotalRunningTimeDisplay(phaseTimeSummary) {
    const ms = computeTankTotalRunningMs(phaseTimeSummary);
    return ms > 0 ? formatDurationSummary(ms) : '—';
  }

  function sessionEndTimestamp(session) {
    if (!session) return null;
    if (session.status === 'finished' && session.finished_at) return session.finished_at;
    if (session.status === 'stopped' && session.stopped_at) return session.stopped_at;
    return null;
  }

  function productionPhaseSortIndex(code) {
    const idx = WINDING_PHASES.findIndex((p) => p.code === code && !p.completes);
    return idx >= 0 ? idx : 999;
  }

  async function fetchTankPhaseTimeSummary(tankId, opts = {}) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return [];
    const pieceFilter =
      opts.pieceNumber != null && Number.isFinite(Number(opts.pieceNumber)) ? Number(opts.pieceNumber) : null;
    const pieceIdFilter =
      opts.pieceId != null && Number.isFinite(Number(opts.pieceId)) ? Number(opts.pieceId) : null;

    const params = [tid];
    let pieceClause = '';
    if (pieceIdFilter != null) {
      params.push(pieceIdFilter);
      pieceClause = ' AND (ms.piece_id = $' + params.length + ' OR (ms.piece_id IS NULL AND COALESCE(ms.piece_number, 1) = (SELECT tp.piece_number FROM tank_pieces tp WHERE tp.id = $' + params.length + ')))';
    } else if (pieceFilter != null) {
      params.push(pieceFilter);
      pieceClause = ' AND COALESCE(ms.piece_number, 1) = $' + params.length;
    }

    const { rows } = await pool.query(
      'SELECT ms.id, ms.activity_code, ms.activity_name, ms.status, ms.started_at, ms.stopped_at, ms.finished_at, ms.notes,\n' +
        '              ms.piece_number, ms.piece_id\n' +
        '       FROM machine_sessions ms\n' +
        '       WHERE ms.tank_id = $1' +
        pieceClause +
        '\n       ORDER BY ms.started_at ASC, ms.id ASC',
      params
    );
    let noteRows = [];
    try {
      const noteParams = [tid];
      let notePieceClause = '';
      if (pieceFilter != null) {
        noteParams.push(pieceFilter);
        notePieceClause = ' AND piece_number = $' + noteParams.length;
      }
      const noteRes = await pool.query(
        'SELECT phase_code, body, note_type, created_at, piece_number\n' +
          '         FROM production_notes\n' +
          '         WHERE tank_id = $1' +
          notePieceClause +
          '\n         ORDER BY created_at ASC',
        noteParams
      );
      noteRows = noteRes.rows;
    } catch (_err) {
      noteRows = [];
    }
    const productionPhases = WINDING_PHASES.filter((p) => !p.completes && !p.piece_complete);
    const sessionsByCode = new Map();
    for (const p of productionPhases) sessionsByCode.set(p.code, []);
    for (const row of rows) {
      const code = String(row.activity_code || '').trim().toUpperCase();
      if (!isProductionPhaseCode(code) || !sessionsByCode.has(code)) continue;
      sessionsByCode.get(code).push(row);
    }

    return productionPhases.map((p) => {
      const phaseSessions = sessionsByCode.get(p.code) || [];
      let totalMs = 0;
      let completedAt = null;
      const noteParts = [];
      for (const s of phaseSessions) {
        totalMs += sessionElapsedMs(s);
        if (s.finished_at) {
          const finMs = new Date(s.finished_at).getTime();
          if (!Number.isNaN(finMs) && (completedAt == null || finMs > completedAt)) {
            completedAt = finMs;
          }
        }
        if (s.notes && String(s.notes).trim()) {
          noteParts.push(String(s.notes).trim());
        }
      }
      for (const n of noteRows) {
        if (String(n.phase_code || '').trim().toUpperCase() === p.code && n.body) {
          const prefix = n.note_type === 'correction' ? 'Correction: ' : '';
          noteParts.push(prefix + String(n.body).trim());
        }
      }
      const hasRunning = phaseSessions.some((s) => s.status === 'running');
      const hasPaused = phaseSessions.some((s) => s.status === 'stopped');
      const hasFinished = phaseSessions.some((s) => s.status === 'finished');
      let status = 'not_started';
      if (hasRunning) status = 'running';
      else if (hasPaused) status = 'paused';
      else if (hasFinished || totalMs > 0) status = 'completed';

      const dur = formatDurationSummary(totalMs);
      let summaryLine = p.label + ': not started';
      if (status === 'running') summaryLine = p.label + ': ' + dur + ' running';
      else if (status === 'paused') summaryLine = p.label + ': ' + dur + ' paused';
      else if (status === 'completed') summaryLine = p.label + ': ' + dur + ' completed';

      const statusLabelMap = {
        not_started: 'Not Started',
        running: 'Running',
        paused: 'Paused',
        completed: 'Completed',
      };

      return {
        phase_code: p.code,
        phase_id: p.code,
        phase_name: p.label,
        status,
        status_label: statusLabelMap[status] || sessionStatusLabel(status === 'not_started' ? null : status),
        total_duration_ms: totalMs,
        total_duration_display: dur,
        summary_line: summaryLine,
        session_count: phaseSessions.length,
        counts_toward_tank_total: isTankTotalRunningPhaseCode(p.code),
        completed_at: status === 'completed' && completedAt != null ? new Date(completedAt).toISOString() : null,
        notes: noteParts.length ? noteParts.join(' · ') : null,
      };
    });
  }

  async function fetchPhaseEditorPayload(tankId, opts = {}) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) {
      return { ok: false, status: 400, body: { ok: false, error: 'invalid_id', message: 'Invalid tank id.' } };
    }
    const tankRes = await pool.query(
      `SELECT id, tank_number, status, piece_count, current_piece_number, customer, model
       FROM tanks WHERE id = $1 LIMIT 1`,
      [tid]
    );
    if (!tankRes.rows[0]) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Tank not found.' } };
    }
    const tankRow = tankRes.rows[0];
    const pieceCount = Math.min(4, Math.max(1, Number(tankRow.piece_count) || 1));
    await ensureTankPieces(tid, pieceCount);
    const pieces = (await getTankPieces(tid)).filter((p) => Number(p.piece_number) <= pieceCount);

    const requestedPiece =
      opts.pieceNumber != null && Number.isFinite(Number(opts.pieceNumber))
        ? Number(opts.pieceNumber)
        : opts.pieceId != null
          ? Number((pieces.find((p) => Number(p.id) === Number(opts.pieceId)) || {}).piece_number)
          : null;

    // Do not permanently default to Piece 1 when multiple pieces exist.
    let selectedPieceNumber = requestedPiece;
    if (selectedPieceNumber == null && pieceCount === 1) selectedPieceNumber = 1;
    if (
      selectedPieceNumber != null &&
      !pieces.some((p) => Number(p.piece_number) === Number(selectedPieceNumber))
    ) {
      selectedPieceNumber = null;
    }

    const selectedPiece = pieces.find((p) => Number(p.piece_number) === Number(selectedPieceNumber)) || null;
    const productionPhases = WINDING_PHASES.filter((p) => !p.completes && !p.piece_complete);

    let phase_summaries = [];
    let sessions = [];
    let selected_phase_code = opts.phaseCode ? String(opts.phaseCode).trim().toUpperCase() : null;

    if (selectedPieceNumber != null) {
      const { rows } = await pool.query(
        `SELECT ms.*, t.name AS team_name, m.name AS machine_name, tk.tank_number
         FROM machine_sessions ms
         JOIN teams t ON t.id = ms.team_id
         JOIN machines m ON m.id = ms.machine_id
         JOIN tanks tk ON tk.id = ms.tank_id
         WHERE ms.tank_id = $1
           AND COALESCE(ms.piece_number, 1) = $2
         ORDER BY ms.started_at ASC, ms.id ASC`,
        [tid, selectedPieceNumber]
      );

      const sessionsByCode = new Map();
      for (const p of productionPhases) sessionsByCode.set(p.code, []);
      for (const row of rows) {
        const code = String(row.activity_code || '').trim().toUpperCase();
        if (!isProductionPhaseCode(code) || !sessionsByCode.has(code)) continue;
        sessionsByCode.get(code).push(row);
      }

      for (const p of productionPhases) {
        const phaseSessions = sessionsByCode.get(p.code) || [];
        let totalMs = 0;
        const mappedSessions = [];
        for (const s of phaseSessions) {
          const ms = sessionElapsedMs(s);
          totalMs += ms;
          const endIso = s.finished_at || s.stopped_at || null;
          let edits = [];
          try {
            edits = await getMembershipApi().listSessionEdits(Number(s.id));
          } catch (_err) {
            edits = [];
          }
          mappedSessions.push({
            id: Number(s.id),
            tank_id: tid,
            piece_id: s.piece_id != null ? Number(s.piece_id) : selectedPiece ? Number(selectedPiece.id) : null,
            piece_number: Number(s.piece_number) || selectedPieceNumber,
            phase_code: s.activity_code,
            phase_name: s.activity_name || p.label,
            team_name: s.team_name,
            machine_name: displayMachineName(s.machine_name),
            started_at: s.started_at,
            ended_at: endIso,
            finished_at: s.finished_at || null,
            stopped_at: s.stopped_at || null,
            status: s.status,
            status_label: sessionStatusLabelFromRow(s),
            duration_ms: ms,
            duration_display: formatDurationSummary(ms),
            duration_clock: formatElapsedDisplay(ms),
            is_edited: edits.length > 0,
            latest_edit_reason: edits[0] ? edits[0].edit_reason : null,
            edits,
          });
        }
        const hasRunning = phaseSessions.some((x) => x.status === 'running');
        const hasPaused = phaseSessions.some((x) => x.status === 'stopped');
        const hasFinished = phaseSessions.some((x) => x.status === 'finished');
        let status = 'not_started';
        if (hasRunning) status = 'running';
        else if (hasPaused) status = 'paused';
        else if (hasFinished || totalMs > 0) status = 'completed';
        const statusLabelMap = {
          not_started: 'Not Started',
          running: 'Running',
          paused: 'Paused',
          completed: 'Completed',
        };
        phase_summaries.push({
          phase_code: p.code,
          phase_id: p.code,
          phase_name: p.label,
          status,
          status_label: statusLabelMap[status],
          total_duration_ms: totalMs,
          total_duration_display: formatDurationSummary(totalMs),
          total_duration_clock: formatElapsedDisplay(totalMs),
          session_count: mappedSessions.length,
          has_recorded_activity: mappedSessions.length > 0,
          sessions: mappedSessions,
          summary_line:
            p.label +
            ' — ' +
            statusLabelMap[status] +
            (totalMs > 0 ? ' — ' + formatDurationSummary(totalMs) : ''),
        });
      }

      if (selected_phase_code) {
        const match = phase_summaries.find((p) => p.phase_code === selected_phase_code);
        sessions = match ? match.sessions : [];
      } else {
        const firstWithActivity = phase_summaries.find((p) => p.has_recorded_activity);
        if (firstWithActivity) {
          selected_phase_code = firstWithActivity.phase_code;
          sessions = firstWithActivity.sessions;
        }
      }
    }

    const selectedPhase = phase_summaries.find((p) => p.phase_code === selected_phase_code) || null;

    return {
      ok: true,
      body: {
        ok: true,
        tank: {
          id: tid,
          tank_number: tankRow.tank_number,
          status: tankRow.status,
          piece_count: pieceCount,
          customer: tankRow.customer || null,
          model: tankRow.model || null,
        },
        pieces: pieces.map((p) => ({
          id: Number(p.id),
          piece_number: Number(p.piece_number),
          status: p.status,
        })),
        phases: productionPhases.map((p) => ({
          code: p.code,
          name: p.label,
          barcode: p.barcode,
        })),
        selected_piece_number: selectedPieceNumber,
        selected_piece_id: selectedPiece ? Number(selectedPiece.id) : null,
        selected_phase_code: selected_phase_code,
        selected_phase: selectedPhase,
        phase_summaries,
        sessions,
        phase_total_ms: selectedPhase ? selectedPhase.total_duration_ms : 0,
        phase_total_display: selectedPhase ? selectedPhase.total_duration_display : '0m',
        phase_total_clock: selectedPhase ? selectedPhase.total_duration_clock : '00:00',
      },
    };
  }

  async function fetchPieceReports(tankId) {
    const tid = Number(tankId);
    const tankRes = await pool.query('SELECT piece_count FROM tanks WHERE id = $1', [tid]);
    const pieceCount = Math.min(4, Math.max(1, Number(tankRes.rows[0] && tankRes.rows[0].piece_count) || 1));
    await ensureTankPieces(tid, pieceCount);
    const pieces = await getTankPieces(tid);
    const reports = [];
    for (const piece of pieces.filter((p) => Number(p.piece_number) <= pieceCount)) {
      const phase_time_summary = await fetchTankPhaseTimeSummary(tid, {
        pieceNumber: piece.piece_number,
        pieceId: piece.id,
      });
      const total_ms = phase_time_summary.reduce((sum, row) => {
        if (row.counts_toward_tank_total === false) return sum;
        return sum + (Number(row.total_duration_ms) || 0);
      }, 0);
      reports.push({
        piece_id: piece.id,
        piece_number: piece.piece_number,
        status: piece.status,
        started_at: piece.started_at,
        completed_at: piece.completed_at,
        operator_name: piece.operator_name || null,
        total_duration_ms: total_ms,
        total_duration_display: formatDurationSummary(total_ms),
        phase_time_summary,
      });
    }
    return reports;
  }

  async function getMachineById(id) {
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, active, active_tank_id FROM machines WHERE id = $1 LIMIT 1`,
      [Number(id)]
    );
    return rows[0] || null;
  }

  async function getMachineByCode(code) {
    const c = normalizeMachineBarcode(code);
    if (!c) return null;
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, active, active_tank_id FROM machines
       WHERE UPPER(TRIM(code)) = $1 OR UPPER(TRIM(COALESCE(barcode, ''))) = $1 LIMIT 1`,
      [c]
    );
    return rows[0] || null;
  }

  async function getMachineBySlug(slug) {
    const s = String(slug || '')
      .trim()
      .toLowerCase();
    if (!s) return null;
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active, active_tank_id FROM machines
       WHERE LOWER(TRIM(kiosk_slug)) = $1 LIMIT 1`,
      [s]
    );
    return rows[0] || null;
  }

  async function getMachineByAreaName(areaName) {
    const raw = String(areaName || '').trim();
    if (!raw) return null;
    const canonical = normalizeWindingMachineAreaName(raw) || raw;
    const slug = slugFromMachineName(canonical);
    const spec = WINDING_MACHINES.find((m) => m.areaName === canonical);
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active, active_tank_id FROM machines
       WHERE (
         name = $1
         OR LOWER(TRIM(name)) = LOWER($1)
         OR LOWER(TRIM(kiosk_slug)) = $2
         OR ($3::text IS NOT NULL AND code = $3)
       )
       AND NOT (
         UPPER(TRIM(COALESCE(code, ''))) LIKE 'WS-%'
         OR name ILIKE 'Winding Station%'
       )
       ORDER BY active DESC, sort_order ASC, id ASC
       LIMIT 1`,
      [canonical, slug, spec ? spec.code : null]
    );
    return rows[0] || null;
  }

  async function getTeamByBarcode(barcode) {
    const bc = normalizeTeamBarcode(barcode);
    if (!bc) return null;
    const { rows } = await pool.query(
      `SELECT id, name, barcode, active FROM teams
       WHERE active = 1 AND UPPER(REPLACE(TRIM(barcode), ' ', '')) = $1
       LIMIT 1`,
      [bc]
    );
    return rows[0] || null;
  }

  async function getOpenSession(machineId, tankIdOptional) {
    const params = [machineId];
    let tankClause = '';
    if (tankIdOptional != null && Number.isFinite(Number(tankIdOptional))) {
      tankClause = ' AND ms.tank_id = $2';
      params.push(Number(tankIdOptional));
    } else {
      // Prefer the machine's active tank when multiple sessions are open.
      tankClause = ` AND (
        m.active_tank_id IS NULL
        OR ms.tank_id = m.active_tank_id
        OR NOT EXISTS (
          SELECT 1 FROM machine_sessions ms2
          WHERE ms2.machine_id = ms.machine_id
            AND ms2.status IN ('running', 'stopped')
            AND ms2.tank_id = m.active_tank_id
        )
      )`;
    }
    const { rows } = await pool.query(
      `SELECT ms.*,
              t.name AS team_name, t.barcode AS team_barcode,
              tk.tank_number,
              m.name AS machine_name, m.code AS machine_code, m.barcode AS machine_barcode,
              m.active_tank_id
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.machine_id = $1 AND ms.status IN ('running', 'stopped')${tankClause}
       ORDER BY
         CASE WHEN m.active_tank_id IS NOT NULL AND ms.tank_id = m.active_tank_id THEN 0 ELSE 1 END,
         ms.started_at DESC, ms.id DESC
       LIMIT 1`,
      params
    );
    return rows[0] || null;
  }

  async function getOpenSessionsForMachine(machineId) {
    const { rows } = await pool.query(
      `SELECT ms.*,
              t.name AS team_name, t.barcode AS team_barcode,
              tk.tank_number,
              m.name AS machine_name, m.code AS machine_code
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.machine_id = $1 AND ms.status IN ('running', 'stopped')
       ORDER BY ms.started_at DESC, ms.id DESC`,
      [machineId]
    );
    return rows;
  }

  async function getOpenSessionForPiece(machineId, tankId, pieceNumber) {
    const mid = Number(machineId);
    const tid = Number(tankId);
    const pieceNum = Number(pieceNumber);
    if (!Number.isInteger(mid) || mid <= 0 || !Number.isInteger(tid) || tid <= 0) return null;
    if (!Number.isInteger(pieceNum) || pieceNum < 1 || pieceNum > 4) return null;
    const { rows } = await pool.query(
      `SELECT ms.*,
              t.name AS team_name, t.barcode AS team_barcode,
              tk.tank_number,
              m.name AS machine_name, m.code AS machine_code, m.barcode AS machine_barcode,
              m.active_tank_id
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.machine_id = $1
         AND ms.tank_id = $2
         AND COALESCE(ms.piece_number, 1) = $3
         AND ms.status IN ('running', 'stopped')
       ORDER BY ms.started_at DESC, ms.id DESC
       LIMIT 1`,
      [mid, tid, pieceNum]
    );
    return rows[0] || null;
  }

  async function setMachineActiveTank(machineId, tankId) {
    await pool.query(`UPDATE machines SET active_tank_id = $1 WHERE id = $2`, [
      tankId != null ? Number(tankId) : null,
      Number(machineId),
    ]);
  }

  async function ensureTankPieces(tankId, pieceCount, opts = {}) {
    const count = Math.min(4, Math.max(1, Number(pieceCount) || 1));
    const tid = Number(tankId);
    for (let n = 1; n <= count; n += 1) {
      await pool.query(
        "INSERT INTO tank_pieces (tank_id, piece_number, status, created_at, updated_at)\n" +
          "         VALUES ($1, $2, 'pending', NOW(), NOW())\n" +
          '         ON CONFLICT (tank_id, piece_number) DO NOTHING',
        [tid, n]
      );
    }
    await pool.query('UPDATE tanks SET piece_count = $1 WHERE id = $2', [count, tid]);
    if (opts.pruneExtras) {
      await pool.query(
        'DELETE FROM tank_pieces\n' +
          '         WHERE tank_id = $1\n' +
          '           AND piece_number > $2\n' +
          "           AND status = 'pending'\n" +
          '           AND started_at IS NULL\n' +
          '           AND completed_at IS NULL\n' +
          '           AND NOT EXISTS (\n' +
          '             SELECT 1 FROM machine_sessions ms\n' +
          '             WHERE ms.tank_id = tank_pieces.tank_id\n' +
          '               AND (ms.piece_id = tank_pieces.id OR ms.piece_number = tank_pieces.piece_number)\n' +
          '           )',
        [tid, count]
      );
    }
    return getTankPieces(tid);
  }

  async function getTankPieces(tankId) {
    const { rows } = await pool.query(
      'SELECT * FROM tank_pieces WHERE tank_id = $1 ORDER BY piece_number ASC',
      [Number(tankId)]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      tank_id: Number(r.tank_id),
      piece_number: Number(r.piece_number),
      status: r.status,
      started_at: r.started_at || null,
      completed_at: r.completed_at || null,
      machine_id: r.machine_id != null ? Number(r.machine_id) : null,
      team_id: r.team_id != null ? Number(r.team_id) : null,
      operator_name: r.operator_name || null,
      notes: r.notes || null,
    }));
  }

  async function getTankPieceByNumber(tankId, pieceNumber) {
    const n = Number(pieceNumber);
    if (!Number.isInteger(n) || n < 1 || n > 4) return null;
    const { rows } = await pool.query(
      'SELECT * FROM tank_pieces WHERE tank_id = $1 AND piece_number = $2 LIMIT 1',
      [Number(tankId), n]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: Number(r.id),
      tank_id: Number(r.tank_id),
      piece_number: Number(r.piece_number),
      status: r.status,
      started_at: r.started_at || null,
      completed_at: r.completed_at || null,
      operator_name: r.operator_name || null,
    };
  }

  async function resolvePieceForTank(tankId, pieceNumber) {
    const pieces = await getTankPieces(tankId);
    const tankRes = await pool.query('SELECT piece_count FROM tanks WHERE id = $1', [Number(tankId)]);
    const pieceCount = Math.min(
      4,
      Math.max(1, Number(tankRes.rows[0] && tankRes.rows[0].piece_count) || pieces.length || 1)
    );
    const n = Number(pieceNumber);
    if (!Number.isInteger(n) || n < 1 || n > pieceCount) {
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: 'invalid_piece',
          message: 'Select Piece 1–' + pieceCount + ' for this tank.',
          piece_count: pieceCount,
          pieces,
        },
      };
    }
    let piece = pieces.find((p) => Number(p.piece_number) === n) || null;
    if (!piece) {
      await ensureTankPieces(tankId, pieceCount);
      piece = await getTankPieceByNumber(tankId, n);
    }
    if (!piece) {
      return {
        ok: false,
        status: 404,
        body: { ok: false, error: 'piece_not_found', message: 'Piece not found for this tank.' },
      };
    }
    return { ok: true, piece, piece_count: pieceCount, pieces };
  }

  async function tankHasProductionActivity(tankId) {
    const tid = Number(tankId);
    const { rows: sess } = await pool.query('SELECT 1 FROM machine_sessions WHERE tank_id = $1 LIMIT 1', [tid]);
    if (sess.length) return true;
    const { rows: pcs } = await pool.query(
      "SELECT 1 FROM tank_pieces\n" +
        '       WHERE tank_id = $1\n' +
        "         AND (status <> 'pending' OR started_at IS NOT NULL OR completed_at IS NOT NULL)\n" +
        '       LIMIT 1',
      [tid]
    );
    return pcs.length > 0;
  }

  async function maxPieceNumberWithActivity(tankId) {
    const tid = Number(tankId);
    const { rows } = await pool.query(
      'SELECT GREATEST(\n' +
        '         COALESCE((SELECT MAX(piece_number) FROM machine_sessions WHERE tank_id = $1 AND piece_number IS NOT NULL), 0),\n' +
        '         COALESCE((\n' +
        '           SELECT MAX(piece_number) FROM tank_pieces\n' +
        '           WHERE tank_id = $1\n' +
        "             AND (status <> 'pending' OR started_at IS NOT NULL OR completed_at IS NOT NULL)\n" +
        '         ), 0)\n' +
        '       ) AS max_piece',
      [tid]
    );
    return Number(rows[0] && rows[0].max_piece) || 0;
  }

  function computePieceProgress(pieces, pieceCount) {
    const count = Math.min(4, Math.max(1, Number(pieceCount) || (pieces && pieces.length) || 1));
    const configured = (pieces || []).filter((p) => Number(p.piece_number) >= 1 && Number(p.piece_number) <= count);
    const completed = configured.filter((p) => String(p.status) === 'completed').length;
    const incomplete = configured.filter((p) => String(p.status) !== 'completed');
    return {
      piece_count: count,
      completed_pieces: completed,
      remaining_pieces: Math.max(0, count - completed),
      percent_complete: Math.round((completed / count) * 100),
      all_pieces_complete: completed >= count && count > 0,
      incomplete_pieces: incomplete.map((p) => Number(p.piece_number)),
    };
  }

  async function getMachineAssignment(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return null;
    const today = localDateString();
    const { rows } = await pool.query(
      `SELECT m.assigned_team_id, m.assigned_team_day, m.assigned_team_at,
              t.id AS team_id, t.name AS team_name, t.barcode AS team_barcode, t.active AS team_active
       FROM machines m
       LEFT JOIN teams t ON t.id = m.assigned_team_id
       WHERE m.id = $1`,
      [mid]
    );
    const row = rows[0];
    if (!row || !row.assigned_team_id) return null;
    if (String(row.assigned_team_day || '') !== String(today)) return null;
    if (!Number(row.team_active)) return null;
    return {
      team_id: Number(row.team_id),
      team_name: row.team_name,
      team_barcode: row.team_barcode,
      assigned_at: row.assigned_team_at || null,
      assigned_day: row.assigned_team_day || null,
    };
  }

  async function assignTeamToMachine(machineId, team) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0 || !team) return null;
    const ts = nowIso();
    const today = localDateString();
    await pool.query(
      `UPDATE machines
       SET assigned_team_id = $1, assigned_team_day = $2, assigned_team_at = $3::timestamptz
       WHERE id = $4`,
      [Number(team.id), today, ts, mid]
    );
    await getMembershipApi().startTeamShiftMemberships(Number(team.id), {
      at: ts,
      source: 'team_scan',
      reason: 'Kiosk team scan — shift start',
    });
    return {
      team_id: Number(team.id),
      team_name: team.name,
      team_barcode: team.barcode,
      assigned_at: ts,
      assigned_day: today,
    };
  }

  async function clearMachineAssignment(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return;
    await pool.query(
      `UPDATE machines SET assigned_team_id = NULL, assigned_team_day = NULL, assigned_team_at = NULL WHERE id = $1`,
      [mid]
    );
  }

  async function mapSession(row) {
    if (!row) return null;
    const elapsedMs = sessionElapsedMs(row);
    return {
      id: Number(row.id),
      machine_id: Number(row.machine_id),
      machine_name: displayMachineName(row.machine_name),
      machine_code: row.machine_code,
      team_id: Number(row.team_id),
      team_name: row.team_name,
      team_barcode: row.team_barcode,
      tank_id: Number(row.tank_id),
      tank_number: row.tank_number,
      phase_code: row.activity_code,
      phase_name: row.activity_name,
      activity_code: row.activity_code,
      activity_name: row.activity_name,
      status: row.status,
      started_at: row.started_at,
      stopped_at: row.stopped_at || null,
      resumed_at: row.resumed_at || null,
      finished_at: row.finished_at || null,
      elapsed_ms: elapsedMs,
      elapsed_display: formatElapsedDisplay(elapsedMs),
      running_time_display: formatElapsedDisplay(elapsedMs),
      stop_reason: row.stop_reason || null,
      status_label: sessionStatusLabelFromRow(row),
      piece_number: Number(row.piece_number) || 1,
      piece_id: row.piece_id != null ? Number(row.piece_id) : null,
      notes: row.notes || null,
    };
  }

  async function countFinishedToday(machineId) {
    const day = startEndOfLocalDay(localDateString());
    if (!day) return 0;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM machine_sessions
       WHERE machine_id = $1 AND status = 'finished'
         AND finished_at >= $2::timestamptz AND finished_at <= $3::timestamptz`,
      [machineId, day.startIso, day.endIso]
    );
    return rows[0] ? rows[0].c : 0;
  }

  async function fetchOpenAlertsForMachine(machineId) {
    const { rows } = await pool.query(
      `SELECT ae.*,
              m.name AS machine_name, m.code AS machine_code,
              t.name AS team_name,
              tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE ae.status = 'open' AND ae.machine_id = $1
       ORDER BY ae.reported_at DESC`,
      [machineId]
    );
    return rows.map(mapAlertRow);
  }

  async function fetchAllOpenAlerts() {
    const { rows } = await pool.query(
      `SELECT ae.*,
              m.name AS machine_name, m.code AS machine_code,
              t.name AS team_name,
              tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE ae.status = 'open'
       ORDER BY ae.reported_at DESC`
    );
    return rows.map(mapAlertRow);
  }

  function mapAlertRow(row) {
    const typeDef = ALERT_TYPES.find((a) => a.alert_type === row.alert_type);
    const openedMs = row.reported_at ? new Date(row.reported_at).getTime() : NaN;
    const closedMs = row.resolved_at
      ? new Date(row.resolved_at).getTime()
      : row.status === 'open'
        ? Date.now()
        : NaN;
    const durationMs =
      Number.isNaN(openedMs) || Number.isNaN(closedMs) ? 0 : Math.max(0, closedMs - openedMs);
    return {
      id: Number(row.id),
      machine_id: row.machine_id != null ? Number(row.machine_id) : null,
      machine_name: displayMachineName(row.machine_name) || null,
      machine_code: row.machine_code || null,
      team_id: row.team_id != null ? Number(row.team_id) : null,
      team_name: row.team_name || null,
      tank_id: row.tank_id != null ? Number(row.tank_id) : null,
      tank_number: row.tank_number || null,
      session_id: row.session_id != null ? Number(row.session_id) : null,
      piece_id: row.piece_id != null ? Number(row.piece_id) : null,
      piece_number: row.piece_number != null ? Number(row.piece_number) : null,
      phase_code: row.phase_code || null,
      phase_name: row.phase_name || null,
      alert_type: row.alert_type,
      alert_code: row.alert_code,
      alert_label: typeDef ? typeDef.label : row.alert_code,
      css_class: typeDef ? typeDef.css_class : 'alert-qa',
      status: row.status,
      reported_at: row.reported_at,
      resolved_at: row.resolved_at || null,
      resolved_by: row.resolved_by || null,
      notes: row.notes || null,
      issue_note: row.notes || null,
      resolution_note: row.resolution_note || null,
      duration_ms: durationMs,
      duration_display: formatDurationSummary(durationMs),
      email_status: row.email_status || null,
      email_error: row.email_error || null,
      email_sent_at: row.email_sent_at || null,
      resolve_email_status: row.resolve_email_status || null,
      resolve_email_error: row.resolve_email_error || null,
      resolve_email_sent_at: row.resolve_email_sent_at || null,
    };
  }

  async function findOpenQaQcAlert(tankId, pieceNumber) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return null;
    const piece = pieceNumber != null ? Number(pieceNumber) : null;
    const params = [tid];
    let pieceClause = '';
    if (Number.isInteger(piece) && piece >= 1) {
      params.push(piece);
      pieceClause = ` AND COALESCE(ae.piece_number, 1) = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT ae.*, m.name AS machine_name, m.code AS machine_code, t.name AS team_name, tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE ae.status = 'open'
         AND ae.alert_type = 'qa_qc'
         AND ae.tank_id = $1
         ${pieceClause}
       ORDER BY ae.reported_at DESC, ae.id DESC
       LIMIT 1`,
      params
    );
    return rows[0] ? mapAlertRow(rows[0]) : null;
  }

  async function fetchTankQaQcHistory(tankId) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT ae.*, m.name AS machine_name, m.code AS machine_code, t.name AS team_name, tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE ae.tank_id = $1 AND ae.alert_type = 'qa_qc'
       ORDER BY ae.reported_at DESC, ae.id DESC`,
      [tid]
    );
    return rows.map(mapAlertRow);
  }

  async function fetchActiveWindingMachines() {
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active, active_tank_id
       FROM machines
       WHERE active = 1
         AND NOT (
           UPPER(TRIM(COALESCE(code, ''))) LIKE 'WS-%'
           OR name ILIKE 'Winding Station%'
         )
       ORDER BY sort_order ASC, name ASC`
    );
    return rows;
  }

  async function fetchManagedWindingMachines(opts = {}) {
    const includeInactive = opts.includeInactive !== false;
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active, active_tank_id
       FROM machines
       WHERE NOT (
         UPPER(TRIM(COALESCE(code, ''))) LIKE 'WS-%'
         OR name ILIKE 'Winding Station%'
       )
       ${includeInactive ? '' : 'AND active = 1'}
       ORDER BY sort_order ASC, name ASC`
    );
    return rows;
  }

  async function getMachineUsageSummary(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) {
      return { open_sessions: 0, history_sessions: 0, alerts: 0, notes: 0, has_history: false, has_open_production: false };
    }
    const [openRes, histRes, alertRes, noteRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS n FROM machine_sessions
         WHERE machine_id = $1 AND status IN ('running', 'stopped')`,
        [mid]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM machine_sessions WHERE machine_id = $1`, [mid]),
      pool.query(`SELECT COUNT(*)::int AS n FROM alert_events WHERE machine_id = $1`, [mid]).catch(() => ({ rows: [{ n: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS n FROM production_notes WHERE machine_id = $1`, [mid]).catch(() => ({ rows: [{ n: 0 }] })),
    ]);
    const open_sessions = Number(openRes.rows[0] && openRes.rows[0].n) || 0;
    const history_sessions = Number(histRes.rows[0] && histRes.rows[0].n) || 0;
    const alerts = Number(alertRes.rows[0] && alertRes.rows[0].n) || 0;
    const notes = Number(noteRes.rows[0] && noteRes.rows[0].n) || 0;
    return {
      open_sessions,
      history_sessions,
      alerts,
      notes,
      has_open_production: open_sessions > 0,
      has_history: history_sessions > 0 || alerts > 0 || notes > 0,
    };
  }

  async function fetchCanonicalWindingMachines() {
    return fetchActiveWindingMachines();
  }

  async function buildDashboardCards() {
    const machines = await fetchCanonicalWindingMachines();
    const cards = [];
    for (const m of machines) {
      // Source of truth for Manager Dashboard: ALL open sessions on this machine.
      // Do NOT filter by machines.active_tank_id (kiosk selection only).
      const openRows = await getOpenSessionsForMachine(m.id);
      const open_sessions = [];
      for (const row of openRows) {
        const mapped = await mapSession(row);
        const phaseTimeSummary = row.tank_id
          ? await fetchTankPhaseTimeSummary(Number(row.tank_id))
          : [];
        open_sessions.push({
          ...mapped,
          phase_time_summary: phaseTimeSummary,
          tank_total_running_time_ms: computeTankTotalRunningMs(phaseTimeSummary),
          tank_total_running_time_display: tankTotalRunningTimeDisplay(phaseTimeSummary),
          piece_number: Number(row.piece_number) || mapped.piece_number || 1,
        });
      }
      open_sessions.sort((a, b) =>
        String(a.tank_number || '').localeCompare(String(b.tank_number || ''), undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );

      // Kiosk selection is separate metadata — never the only tank shown.
      const selectedTankId = m.active_tank_id != null ? Number(m.active_tank_id) : null;
      const selectedSession =
        (selectedTankId != null
          ? open_sessions.find((s) => Number(s.tank_id) === selectedTankId)
          : null) || open_sessions[0] || null;

      const openAlerts = await fetchOpenAlertsForMachine(m.id);
      const assignment = await getMachineAssignment(m.id);
      const assignedTeam = assignment ? assignment.team_name : null;
      const currentTeam =
        assignedTeam ||
        (open_sessions.length ? open_sessions[0].team_name : null);

      let machineStatus = 'idle';
      let machineStatusLabel = 'Idle';
      const productionCounts = countActiveProduction(open_sessions);
      if (open_sessions.length) {
        const anyRunning = open_sessions.some((s) => s.status === 'running');
        machineStatus = anyRunning ? 'running' : 'stopped';
        const tankN = productionCounts.active_tank_count;
        machineStatusLabel = anyRunning
          ? `${tankN} tank${tankN > 1 ? 's' : ''} active`
          : `${tankN} tank${tankN > 1 ? 's' : ''} paused`;
      } else if (assignment) {
        machineStatus = 'assigned';
        machineStatusLabel = 'Team Assigned';
      }

      cards.push({
        id: Number(m.id),
        name: displayMachineName(m.name),
        slug: String(m.kiosk_slug || slugFromMachineName(m.name)).toLowerCase(),
        kiosk_url: kioskUrlForSlug(m.kiosk_slug || slugFromMachineName(m.name)),
        current_team: currentTeam,
        assigned_team: assignedTeam,
        // Selected tank = kiosk focus only (optional highlight), not the sole display.
        selected_tank_id: selectedSession ? selectedSession.tank_id : null,
        selected_tank_number: selectedSession ? selectedSession.tank_number : null,
        // Legacy single-tank fields kept for older UI consumers (prefer open_sessions).
        current_tank: selectedSession ? selectedSession.tank_number : null,
        current_phase: selectedSession ? selectedSession.phase_name : null,
        current_piece: selectedSession ? selectedSession.piece_number || 1 : null,
        status: machineStatus,
        status_label: machineStatusLabel,
        started_at: selectedSession ? selectedSession.started_at : null,
        elapsed_display: selectedSession ? selectedSession.elapsed_display : '—',
        running_time_display: selectedSession ? selectedSession.running_time_display : '—',
        session_id: selectedSession ? selectedSession.id : null,
        tank_id: selectedSession ? selectedSession.tank_id : null,
        estimated_labor_cost: null,
        phase_time_summary: selectedSession ? selectedSession.phase_time_summary || [] : [],
        tank_total_running_time_ms: selectedSession
          ? selectedSession.tank_total_running_time_ms || 0
          : 0,
        tank_total_running_time_display: selectedSession
          ? selectedSession.tank_total_running_time_display || '—'
          : '—',
        finished_tanks_today: await countFinishedToday(m.id),
        open_alerts: openAlerts,
        open_sessions,
        active_tank_count: productionCounts.active_tank_count,
        active_piece_count: productionCounts.active_piece_count,
        pieces: [],
        session: selectedSession,
      });
    }
    return cards;
  }

  async function startSession(machine, { teamBarcode, team: teamArg, tankNumber, phaseRaw, pieceNumber, notes }) {
    const team = teamArg || (await getTeamByBarcode(teamBarcode));
    if (!team || !Number(team.active)) {
      return { ok: false, status: 404, body: { ok: false, error: 'unknown_team', message: 'Unknown team barcode.' } };
    }
    const tankNorm = normalizeTankNumber(tankNumber);
    if (!tankNorm) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Tank is required.' } };
    }
    const phase = resolvePhase(phaseRaw);
    if (!phase) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Phase is required.' } };
    }
    if (phase.completes || phase.piece_complete) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'validation', message: 'Use Piece Complete or Tank Complete during an active session.' },
      };
    }
    const tankRow = await validateTankExists(tankNorm);
    if (!tankRow) {
      return {
        ok: false,
        status: 404,
        body: { ok: false, error: 'tank_not_found', message: TANK_NOT_FOUND_MESSAGE },
      };
    }
    if (normalizeTankStatus(tankRow.status) === 'archived') {
      return {
        ok: false,
        status: 403,
        body: { ok: false, error: 'tank_archived', message: 'Tank is completed. Restore before use.' },
      };
    }

    // Multi-piece: block only if THIS tank + piece already has an open session on this machine.
    // (checked after piece resolution below)

    const pieceCount = Math.min(4, Math.max(1, Number(tankRow.piece_count) || 1));
    await ensureTankPieces(tankRow.id, pieceCount);
    const requestedPiece = pieceNumber != null ? Number(pieceNumber) : null;
    if (requestedPiece == null || !Number.isInteger(requestedPiece)) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'need_piece',
          message: 'Select a piece before starting a phase.',
          piece_count: pieceCount,
          pieces: await getTankPieces(tankRow.id),
        },
      };
    }
    const resolved = await resolvePieceForTank(tankRow.id, requestedPiece);
    if (!resolved.ok) return resolved;
    if (String(resolved.piece.status) === 'completed') {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'piece_completed',
          message: 'Piece ' + requestedPiece + ' is already completed. Select another piece.',
          pieces: resolved.pieces,
        },
      };
    }
    const pieceNum = resolved.piece.piece_number;
    const pieceId = resolved.piece.id;

    const existingForPiece = await getOpenSessionForPiece(machine.id, tankRow.id, pieceNum);
    if (existingForPiece) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'session_active',
          message: `Piece ${pieceNum} already has an active session on this machine. Scan a phase to continue.`,
          piece_number: pieceNum,
        },
      };
    }

    // Same piece cannot have two active sessions (any winder/team).
    const conflict = await getMembershipApi().findOpenPieceSession(tankRow.id, pieceNum, null);
    if (conflict && Number(conflict.machine_id) !== Number(machine.id)) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'piece_in_use',
          message: `Piece ${pieceNum} is currently being worked on by ${conflict.team_name || 'another team'} / ${displayMachineName(conflict.machine_name) || 'another winder'}.`,
          conflicting_team: conflict.team_name,
          conflicting_machine: displayMachineName(conflict.machine_name),
          piece_number: pieceNum,
        },
      };
    }

    const ts = nowIso();
    await pool.query(
      `UPDATE tanks
       SET status = 'active',
           first_scanned_at = COALESCE(first_scanned_at, $5::timestamptz),
           paused_reason = NULL,
           wip_team_id = $1,
           wip_phase_code = $2,
           wip_phase_name = $3,
           wip_machine_id = $4,
           current_piece_number = $6,
           updated_at = $5::timestamptz
       WHERE id = $7`,
      [team.id, phase.code, phase.label, machine.id, ts, pieceNum, tankRow.id]
    );
    await pool.query(
      `UPDATE tank_pieces
       SET status = CASE WHEN status = 'completed' THEN status ELSE 'in_progress' END,
           started_at = COALESCE(started_at, $1::timestamptz),
           machine_id = $2,
           team_id = $3,
           updated_at = $1::timestamptz
       WHERE id = $4`,
      [ts, machine.id, team.id, pieceId]
    );
    const insertRes = await pool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, created_at, updated_at, piece_number, piece_id, notes)
       VALUES ($1,$2,$3,$4,$5,'running',$6::timestamptz,$6::timestamptz,$6::timestamptz,$7,$8,$9)
       RETURNING id`,
      [machine.id, team.id, tankRow.id, phase.code, phase.label, ts, pieceNum, pieceId, notes || null]
    );
    const sessionId = insertRes.rows[0] ? Number(insertRes.rows[0].id) : null;
    if (sessionId) await snapshotSessionTeamMembers(sessionId, team.id);
    await setMachineActiveTank(machine.id, tankRow.id);

    if (phase.code === 'CORRECTIONS' && notes) {
      await pool.query(
        `INSERT INTO production_notes
           (note_type, body, tank_id, tank_number, piece_number, machine_id, team_id, team_name, session_id, phase_code, phase_name, created_at)
         VALUES ('correction', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
        [String(notes).slice(0, 2000), tankRow.id, tankNorm, pieceNum, machine.id, team.id, team.name, sessionId, phase.code, phase.label, ts]
      );
    }

    const session = await getOpenSessionForPiece(machine.id, tankRow.id, pieceNum);
    return {
      ok: true,
      body: {
        ok: true,
        action: 'start',
        session: await mapSession(session),
        require_correction_note: phase.code === 'CORRECTIONS' && !notes,
        pieces: await getTankPieces(tankRow.id),
        current_piece: pieceNum,
      },
    };
  }

  async function changePhase(machine, phaseRaw, opts = {}) {
    let session = opts.session || null;
    const requestedPiece = opts.pieceNumber != null ? Number(opts.pieceNumber) : null;
    const tankIdHint = opts.tankId != null ? Number(opts.tankId) : null;
    if (!session) {
      if (requestedPiece != null && tankIdHint) {
        session = await getOpenSessionForPiece(machine.id, tankIdHint, requestedPiece);
      } else if (requestedPiece != null) {
        const machineRow = await getMachineById(machine.id);
        const activeTankId =
          machineRow && machineRow.active_tank_id != null ? Number(machineRow.active_tank_id) : null;
        if (activeTankId) {
          session = await getOpenSessionForPiece(machine.id, activeTankId, requestedPiece);
        }
      } else if (tankIdHint) {
        session = await getOpenSession(machine.id, tankIdHint);
      } else {
        session = await getOpenSession(machine.id);
      }
    }
    if (!session) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No active session.' } };
    }
    if (
      requestedPiece != null &&
      Number(session.piece_number || 1) !== requestedPiece
    ) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'piece_session_mismatch',
          message: `No active session for Piece ${requestedPiece}. Scan a phase to start it.`,
          piece_number: requestedPiece,
        },
      };
    }
    const phase = resolvePhase(phaseRaw);
    if (!phase) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Unknown phase.' } };
    }
    if (phase.piece_complete) {
      return finishPiece(machine, { ...opts, session });
    }
    if (phase.completes) {
      return finishSession(machine, {
        ...opts,
        session,
        forceTankComplete: phase.code === 'TANK_COMPLETE' || phase.code === 'PART_COMPLETE',
      });
    }
    if (phase.code === 'CORRECTIONS' && !opts.notes) {
      return {
        ok: true,
        body: {
          ok: true,
          action: 'need_correction_note',
          require_correction_note: true,
          phase: phase.label,
          session: await mapSession(session),
        },
      };
    }
    const ts = nowIso();
    await finalizeSessionBeforeTransition(session, ts);
    const newSession = await spawnContinuationSession(session, phase, ts, {
      notes: opts.notes || null,
      pieceNumber: opts.pieceNumber || session.piece_number,
    });
    if (phase.code === 'CORRECTIONS' && opts.notes) {
      await pool.query(
        `INSERT INTO production_notes
           (note_type, body, tank_id, tank_number, piece_number, machine_id, team_id, team_name, session_id, phase_code, phase_name, created_at)
         VALUES ('correction', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
        [
          String(opts.notes).slice(0, 2000),
          Number(session.tank_id),
          session.tank_number,
          session.piece_number || 1,
          machine.id,
          Number(session.team_id),
          session.team_name,
          newSession ? Number(newSession.id) : null,
          phase.code,
          phase.label,
          ts,
        ]
      );
    }
    await setMachineActiveTank(machine.id, session.tank_id);
    return { ok: true, body: { ok: true, action: 'change_phase', session: await mapSession(newSession) } };
  }

  /**
   * Piece Complete: finish the current piece/session only.
   * Never archives the tank — Tank Complete (or PART_COMPLETE) is required.
   */
  async function finishPiece(machine, opts = {}) {
    const session = opts.session || (await getOpenSession(machine.id));
    if (!session) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No active session.' } };
    }
    const ts = nowIso();
    const pieceNum = Number(session.piece_number) || 1;
    const endTs = session.status === 'stopped' && session.stopped_at ? session.stopped_at : ts;

    const pieceCountRes = await pool.query(`SELECT piece_count FROM tanks WHERE id = $1`, [session.tank_id]);
    const pieceCount = Math.min(
      4,
      Math.max(1, Number(pieceCountRes.rows[0] && pieceCountRes.rows[0].piece_count) || 1)
    );
    await ensureTankPieces(session.tank_id, pieceCount);

    await pool.query(
      `UPDATE machine_sessions SET status = 'finished', finished_at = $1::timestamptz, updated_at = $2::timestamptz WHERE id = $3`,
      [endTs, ts, session.id]
    );
    await pool.query(
      `UPDATE tank_pieces
       SET status = 'completed', completed_at = $1::timestamptz, updated_at = $1::timestamptz,
           machine_id = $2, team_id = $3, operator_name = $4
       WHERE tank_id = $5 AND piece_number = $6`,
      [ts, machine.id, session.team_id, opts.confirmedByEmployeeName || null, session.tank_id, pieceNum]
    );
    try {
      await pool.query(
        `INSERT INTO part_complete_events
           (session_id, tank_id, team_id, team_name, confirmed_by_employee_id, confirmed_by_employee_name, completed_at, created_at, piece_number, piece_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz,$8,$9)`,
        [
          Number(session.id),
          Number(session.tank_id),
          Number(session.team_id),
          session.team_name,
          opts.confirmedByEmployeeId || null,
          opts.confirmedByEmployeeName || null,
          ts,
          pieceNum,
          session.piece_id || null,
        ]
      );
    } catch (err) {
      console.error('[finishPiece] part_complete_events insert failed:', err.message);
      throw err;
    }

    const pieces = await getTankPieces(session.tank_id);
    const progress = computePieceProgress(pieces, pieceCount);
    const allPiecesComplete = progress.all_pieces_complete;
    const nextPiece = pieces.find(
      (p) => Number(p.piece_number) <= pieceCount && p.status !== 'completed'
    );
    const nextPieceNum = nextPiece ? Number(nextPiece.piece_number) : pieceNum;

    // Keep tank Active. Clear WIP phase fields; do NOT set status=archived.
    await pool.query(
      `UPDATE tanks
       SET status = CASE
             WHEN LOWER(TRIM(COALESCE(status, ''))) = 'archived' THEN status
             ELSE 'active'
           END,
           current_piece_number = $1,
           paused_reason = NULL,
           wip_team_id = NULL,
           wip_phase_code = NULL,
           wip_phase_name = NULL,
           wip_machine_id = NULL,
           completed_at = NULL,
           updated_at = $2::timestamptz
       WHERE id = $3`,
      [nextPieceNum, ts, session.tank_id]
    );

    // Keep this tank selectable on the machine without forcing archive.
    await setMachineActiveTank(machine.id, session.tank_id);

    return {
      ok: true,
      body: {
        ok: true,
        action: 'piece_complete',
        piece_number: pieceNum,
        pieces,
        tank_complete: false,
        all_pieces_complete: allPiecesComplete,
        next_piece: nextPiece ? nextPiece.piece_number : null,
        tank_id: Number(session.tank_id),
        tank_number: session.tank_number,
        confirmation_line: allPiecesComplete
          ? `Piece ${pieceNum} complete — all pieces done. Scan Tank Complete to finish the tank.`
          : `Piece ${pieceNum} complete${nextPiece ? ` — continue with Piece ${nextPiece.piece_number}` : ''}`,
        message: allPiecesComplete
          ? 'All pieces are complete. Status is Ready to Complete — scan Tank Complete to mark the tank Completed.'
          : null,
      },
    };
  }

  async function finishTankArchive(machine, session, opts, ts) {
    await pool.query(
      `UPDATE tanks
       SET status = 'archived',
           completed_at = $1::timestamptz,
           paused_reason = NULL,
           wip_team_id = NULL,
           wip_phase_code = NULL,
           wip_phase_name = NULL,
           wip_machine_id = NULL,
           updated_at = $1::timestamptz
       WHERE id = $2`,
      [ts, session.tank_id]
    );
    await setMachineActiveTank(machine.id, null);
    let mapped = null;
    try {
      if (session && session.id) mapped = await mapSession(session);
    } catch (_err) {
      mapped = null;
    }
    return {
      ok: true,
      body: {
        ok: true,
        action: 'tank_complete',
        tank_complete: true,
        session: mapped,
        tank_number: session.tank_number || null,
        confirmation_line: opts.confirmedByEmployeeName
          ? `${opts.confirmedByEmployeeName} confirmed Tank Complete`
          : 'Tank Complete recorded',
        team_name: session.team_name,
        confirmed_by_employee_name: opts.confirmedByEmployeeName || null,
      },
    };
  }

  /**
   * Tank Complete / Part Complete: archive the tank.
   * Without forceTankComplete, delegates to Piece Complete (never archives).
   */
  async function finishSession(machine, opts = {}) {
    const session = opts.session || (await getOpenSession(machine.id));
    if (!session) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No active session to complete.' } };
    }
    if (!opts.forceTankComplete) {
      return finishPiece(machine, { ...opts, session });
    }
    const pieceCountRes = await pool.query('SELECT piece_count FROM tanks WHERE id = $1', [session.tank_id]);
    const pieceCount = Math.min(
      4,
      Math.max(1, Number(pieceCountRes.rows[0] && pieceCountRes.rows[0].piece_count) || 1)
    );
    await ensureTankPieces(session.tank_id, pieceCount);
    const piecesBeforeComplete = await getTankPieces(session.tank_id);
    const progress = computePieceProgress(piecesBeforeComplete, pieceCount);
    if (!progress.all_pieces_complete) {
      const incomplete = progress.incomplete_pieces;
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'pieces_incomplete',
          message:
            'Complete all pieces before Tank Complete. Still needed: Piece ' + incomplete.join(', Piece ') + '.',
          incomplete_pieces: incomplete,
          pieces: piecesBeforeComplete,
          piece_count: pieceCount,
          percent_complete: progress.percent_complete,
        },
      };
    }
    const ts = nowIso();
    const endTs = session.status === 'stopped' && session.stopped_at ? session.stopped_at : ts;
    await pool.query(
      `UPDATE machine_sessions SET status = 'finished', finished_at = $1::timestamptz, updated_at = $2::timestamptz WHERE id = $3`,
      [endTs, ts, session.id]
    );
    await pool.query(
      `UPDATE tank_pieces
       SET updated_at = $1::timestamptz
       WHERE tank_id = $2 AND status = 'completed'`,
      [ts, session.tank_id]
    );
    try {
      await pool.query(
        `INSERT INTO part_complete_events
           (session_id, tank_id, team_id, team_name, confirmed_by_employee_id, confirmed_by_employee_name, completed_at, created_at, piece_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz,$8)`,
        [
          Number(session.id),
          Number(session.tank_id),
          Number(session.team_id),
          session.team_name,
          opts.confirmedByEmployeeId || null,
          opts.confirmedByEmployeeName || null,
          ts,
          session.piece_number || null,
        ]
      );
    } catch (err) {
      console.error('[finishSession] part_complete_events insert failed:', err.message);
      throw err;
    }
    return finishTankArchive(machine, session, opts, ts);
  }

  async function createAlert(machine, alertRaw, sessionOptional, opts = {}) {
    const alertDef = resolveAlert(alertRaw);
    if (!alertDef) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Unknown alert barcode.' } };
    }
    const session = sessionOptional || (machine ? await getOpenSession(machine.id) : null);
    if (alertDef.alert_type === 'qa_qc' && !session) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_session', message: 'Select an active tank/piece before scanning QA/QC.' },
      };
    }
    const pieceNumber = session ? Number(session.piece_number) || 1 : null;
    if (alertDef.alert_type === 'qa_qc') {
      const existing = await findOpenQaQcAlert(session.tank_id, pieceNumber);
      if (existing) {
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            error: 'qa_qc_open',
            message: `Piece ${pieceNumber} already has an open QA/QC issue.`,
            open_qa_qc: existing,
          },
        };
      }
    }
    const ts = nowIso();
    const issueNote =
      opts.notes != null
        ? String(opts.notes).trim().slice(0, 1000)
        : opts.issue_note != null
          ? String(opts.issue_note).trim().slice(0, 1000)
          : null;
    if (session && alertDef.alert_type === 'qa_qc') {
      if (session.status === 'running') {
        await stopSessionForWait(session, ts, 'qa_qc');
      } else if (session.status === 'stopped' && !isQaQcStopReason(session.stop_reason)) {
        await stopSessionForWait(session, ts, 'qa_qc');
      }
    } else if (session && session.status === 'running' && alertDef.alert_type === 'maintenance') {
      // Maintenance alert notifies managers; keep prior pause behavior for tooling.
      await stopSessionForWait(session, ts, alertDef.alert_type);
    }
    const { rows } = await pool.query(
      `INSERT INTO alert_events
         (machine_id, team_id, tank_id, session_id, alert_type, alert_code, status, reported_at, created_at,
          piece_id, piece_number, phase_code, phase_name, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7::timestamptz,$7::timestamptz,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        machine ? machine.id : session ? session.machine_id : null,
        session ? session.team_id : null,
        session ? session.tank_id : null,
        session ? session.id : null,
        alertDef.alert_type,
        alertDef.code,
        ts,
        session && session.piece_id != null ? Number(session.piece_id) : null,
        pieceNumber,
        session ? session.activity_code || null : null,
        session ? session.activity_name || null : null,
        issueNote || null,
      ]
    );
    const { rows: full } = await pool.query(
      `SELECT ae.*, m.name AS machine_name, m.code AS machine_code, t.name AS team_name, tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE ae.id = $1`,
      [rows[0].id]
    );
    const mappedSession =
      machine && session
        ? await mapSession(await getOpenSession(machine.id, session.tank_id))
        : session
          ? await mapSession(session)
          : null;
    return {
      ok: true,
      body: {
        ok: true,
        action: 'alert',
        alert: mapAlertRow(full[0]),
        open_qa_qc: alertDef.alert_type === 'qa_qc' ? mapAlertRow(full[0]) : null,
        session: mappedSession,
        confirmation_line:
          alertDef.alert_type === 'qa_qc'
            ? `QA/QC opened for Tank ${session.tank_number} Piece ${pieceNumber}. ${session.activity_name || 'Phase'} paused.`
            : `${alertDef.label} reported — manager notified.`,
      },
    };
  }

  async function resumeSessionAfterQaQc(sessionRow, ts) {
    if (!sessionRow) return null;
    if (sessionRow.status === 'stopped' && isQaQcStopReason(sessionRow.stop_reason)) {
      await withTransaction(async (client) => {
        await resumeSingleOpenSession(sessionRow, ts, client);
      });
      return getSessionById(sessionRow.id);
    }
    return sessionRow;
  }

  async function resolveAlertById(id, resolvedBy, opts = {}) {
    const ts = nowIso();
    const resolutionNote =
      opts.resolution_note != null
        ? String(opts.resolution_note).trim().slice(0, 1000)
        : opts.notes != null
          ? String(opts.notes).trim().slice(0, 1000)
          : null;
    const { rows: before } = await pool.query(`SELECT * FROM alert_events WHERE id = $1`, [Number(id)]);
    if (!before.length) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Alert not found.' } };
    }
    const prior = before[0];
    if (String(prior.status) !== 'open') {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'already_resolved', message: 'Alert is already resolved.' },
      };
    }
    const { rows } = await pool.query(
      `UPDATE alert_events
       SET status = 'resolved',
           resolved_at = $1::timestamptz,
           resolved_by = $2,
           resolution_note = COALESCE($3, resolution_note)
       WHERE id = $4 AND status = 'open'
       RETURNING id`,
      [ts, resolvedBy || null, resolutionNote, Number(id)]
    );
    if (!rows.length) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Alert not found or already resolved.' } };
    }

    let resumedSession = null;
    if (prior.alert_type === 'qa_qc' && prior.session_id) {
      const sessionRow = await getSessionById(prior.session_id);
      resumedSession = await resumeSessionAfterQaQc(sessionRow, ts);
      if (sessionRow && sessionRow.machine_id) {
        await setMachineActiveTank(sessionRow.machine_id, sessionRow.tank_id);
      }
    }

    const { rows: full } = await pool.query(
      `SELECT ae.*, m.name AS machine_name, m.code AS machine_code, t.name AS team_name, tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE ae.id = $1`,
      [rows[0].id]
    );
    return {
      ok: true,
      body: {
        ok: true,
        id: Number(rows[0].id),
        alert: mapAlertRow(full[0]),
        session: resumedSession ? await mapSession(resumedSession) : null,
        action: prior.alert_type === 'qa_qc' ? 'qa_qc_resolved' : 'alert_resolved',
        confirmation_line:
          prior.alert_type === 'qa_qc'
            ? `QA/QC resolved${prior.piece_number ? ` for Piece ${prior.piece_number}` : ''}${
                resumedSession && resumedSession.activity_name
                  ? ` — resumed ${resumedSession.activity_name}`
                  : ''
              }.`
            : 'Alert resolved.',
      },
    };
  }

  async function resolveQaQcForMachine(machine, opts = {}) {
    const session =
      opts.session ||
      (opts.tank_id != null
        ? await getOpenSession(machine.id, Number(opts.tank_id))
        : await getOpenSession(machine.id));
    if (!session) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_session', message: 'No open QA/QC issue for this piece.' },
      };
    }
    const pieceNumber = Number(session.piece_number) || 1;
    const open = await findOpenQaQcAlert(session.tank_id, pieceNumber);
    if (!open) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'no_open_qa_qc',
          message: 'No open QA/QC issue for this piece.',
        },
      };
    }
    return resolveAlertById(open.id, opts.resolved_by || opts.resolvedBy || 'kiosk', {
      resolution_note: opts.resolution_note || opts.notes || null,
    });
  }

  async function fetchProductionHistory(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
    const params = [];
    const where = [`ms.status = 'finished'`];
    let idx = 1;
    if (filters.date) {
      const day = startEndOfLocalDay(String(filters.date));
      if (day) {
        where.push(`ms.finished_at >= $${idx}::timestamptz AND ms.finished_at <= $${idx + 1}::timestamptz`);
        params.push(day.startIso, day.endIso);
        idx += 2;
      }
    }
    if (filters.machine_id) {
      where.push(`ms.machine_id = $${idx++}`);
      params.push(Number(filters.machine_id));
    }
    if (filters.team_id) {
      where.push(`ms.team_id = $${idx++}`);
      params.push(Number(filters.team_id));
    }
    if (filters.tank_number) {
      where.push(`UPPER(TRIM(tk.tank_number)) = $${idx++}`);
      params.push(normalizeTankNumber(filters.tank_number));
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ms.*, m.name AS machine_name, m.code AS machine_code,
              t.name AS team_name, tk.tank_number,
              (SELECT COALESCE(string_agg(
                 CASE ae.alert_type WHEN 'qa_qc' THEN 'QA/QC' ELSE 'Maintenance' END
                 || CASE WHEN ae.status = 'open' THEN ' (open)' ELSE ' (resolved)' END,
                 ', '
               ), '')
               FROM alert_events ae
               WHERE ae.session_id = ms.id OR (
                 ae.machine_id = ms.machine_id AND ae.reported_at >= ms.started_at
                 AND ae.reported_at <= COALESCE(ms.finished_at, NOW())
               )) AS alerts_summary
       FROM machine_sessions ms
       JOIN machines m ON m.id = ms.machine_id
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       WHERE ${where.join(' AND ')}
       ORDER BY ms.finished_at DESC NULLS LAST LIMIT $${idx}`,
      params
    );
    return rows.map((row) => ({
      id: Number(row.id),
      date: row.finished_at ? localDateString(new Date(row.finished_at)) : null,
      machine_name: displayMachineName(row.machine_name),
      machine_code: row.machine_code,
      team_name: row.team_name,
      tank_number: row.tank_number,
      phase_name: row.activity_name,
      started_at: row.started_at,
      finished_at: row.finished_at,
      duration_display: formatElapsedDisplay(sessionElapsedMs(row)),
      alerts_summary: row.alerts_summary || '',
      status: row.status,
    }));
  }

  async function fetchTankActivity(tankNumber) {
    const normalized = normalizeTankNumber(tankNumber);
    if (!normalized) return { tank_number: null, sessions: [], alerts: [] };
    const { rows: sessionRows } = await pool.query(
      `SELECT ms.*, m.name AS machine_name, m.code AS machine_code,
              t.name AS team_name, tk.tank_number
       FROM machine_sessions ms
       JOIN machines m ON m.id = ms.machine_id
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       WHERE UPPER(TRIM(tk.tank_number)) = $1
       ORDER BY ms.started_at DESC NULLS LAST, ms.id DESC`,
      [normalized]
    );
    const { rows: alertRows } = await pool.query(
      `SELECT ae.*, m.name AS machine_name, m.code AS machine_code, t.name AS team_name, tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE UPPER(TRIM(tk.tank_number)) = $1
       ORDER BY ae.reported_at DESC`,
      [normalized]
    );
    const sessions = sessionRows.map((row) => {
      const phaseCode = String(row.activity_code || '').trim().toUpperCase();
      return {
        id: Number(row.id),
        machine_name: displayMachineName(row.machine_name),
        machine_code: row.machine_code,
        team_name: row.team_name,
        tank_number: row.tank_number,
        phase_name: row.activity_name,
        phase_code: row.activity_code,
        started_at: row.started_at,
        finished_at: row.finished_at,
        duration_display: formatElapsedDisplay(sessionElapsedMs(row)),
        status: row.status,
        excluded_from_tank_total: !isTankTotalRunningPhaseCode(phaseCode),
      };
    });
    for (const s of sessions) {
      const labor = await computeSessionLaborForRow(
        sessionRows.find((r) => Number(r.id) === s.id)
      );
      if (labor) {
        s.duration_hours = labor.duration_hours;
        s.total_estimated_cost = labor.total_estimated_cost;
      }
    }
    let tankId = null;
    if (sessionRows[0] && sessionRows[0].tank_id != null) {
      tankId = Number(sessionRows[0].tank_id);
    } else {
      const tankLookup = await pool.query(
        `SELECT id FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`,
        [normalized]
      );
      if (tankLookup.rows[0]) tankId = Number(tankLookup.rows[0].id);
    }
    const phase_time_summary = tankId ? await fetchTankPhaseTimeSummary(tankId) : [];
    let downtime_intervals = [];
    let downtime_total_ms = 0;
    if (tankId) {
      try {
        const { rows: dtRows } = await pool.query(
          `SELECT id, started_at, ended_at, duration_ms, reason_code, reason_note,
                  phase_code, phase_name, piece_number, team_name, tank_number
           FROM downtime_intervals
           WHERE tank_id = $1
           ORDER BY started_at DESC, id DESC`,
          [tankId]
        );
        downtime_intervals = dtRows.map((r) => {
          const startMs = new Date(r.started_at).getTime();
          const endMs = r.ended_at ? new Date(r.ended_at).getTime() : Date.now();
          const ms =
            r.duration_ms != null
              ? Number(r.duration_ms)
              : Number.isNaN(startMs) || Number.isNaN(endMs)
                ? 0
                : Math.max(0, endMs - startMs);
          downtime_total_ms += ms;
          const opt = DOWNTIME_REASON_OPTIONS.find((o) => o.code === r.reason_code);
          return {
            id: Number(r.id),
            started_at: r.started_at,
            ended_at: r.ended_at || null,
            duration_ms: ms,
            duration_display: formatElapsedDisplay(ms),
            reason_code: r.reason_code || null,
            reason_label: opt ? opt.label : r.reason_code || null,
            reason_note: r.reason_note || null,
            phase_name: r.phase_name || null,
            piece_number: r.piece_number != null ? Number(r.piece_number) : null,
            team_name: r.team_name || null,
            open: !r.ended_at,
          };
        });
      } catch (err) {
        console.warn('[fetchTankActivity] downtime_intervals query failed:', err.message);
      }
    }
    return {
      tank_number: sessionRows[0] ? sessionRows[0].tank_number : normalized,
      tank_id: tankId,
      sessions,
      alerts: alertRows.map(mapAlertRow),
      phase_time_summary,
      tank_total_running_time_ms: computeTankTotalRunningMs(phase_time_summary),
      tank_total_running_time_display: tankTotalRunningTimeDisplay(phase_time_summary),
      downtime_intervals,
      downtime_total_ms,
      downtime_total_display: formatElapsedDisplay(downtime_total_ms),
    };
  }

  async function fetchAlertHistory(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
    const params = [];
    let where = '1=1';
    let idx = 1;
    if (filters.status) {
      where += ` AND ae.status = $${idx++}`;
      params.push(String(filters.status));
    }
    if (filters.machine_id) {
      where += ` AND ae.machine_id = $${idx++}`;
      params.push(Number(filters.machine_id));
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ae.*, m.name AS machine_name, m.code AS machine_code, t.name AS team_name, tk.tank_number
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       WHERE ${where}
       ORDER BY ae.reported_at DESC LIMIT $${idx}`,
      params
    );
    return rows.map(mapAlertRow);
  }

  function isWindingMachineArea(areaName) {
    return isWindingMachineAreaName(areaName);
  }

  function parseScan(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return { type: 'unknown' };
    if (isResumeScan(s)) return { type: 'resume', value: s };
    if (s.startsWith('TEAM')) return { type: 'team', value: normalizeTeamBarcode(s) };
    if (s.startsWith('TANK_') || s.startsWith('TANK:')) {
      return { type: 'tank', value: normalizeTankNumber(s.replace(/^TANK[_:]/, '')) };
    }
    if (s.startsWith('STOP:') || s.startsWith('STOP_')) {
      const downtime = resolveDowntimeReason(s);
      if (downtime) return { type: 'downtime', value: downtime.barcode };
      const pause = resolvePauseReason(s);
      if (pause) return { type: 'pause', value: pause.barcode };
    }
    if (s.startsWith('REASON:') || s.startsWith('REASON_')) {
      const endShift = resolveEndShift(s);
      if (endShift) return { type: 'end_shift', value: endShift.barcode };
    }
    if (s.startsWith('PIECE:') || s.startsWith('PIECE_') || /^PIECE\s*[1-4]$/.test(s)) {
      const num = Number(String(s).replace(/^PIECE[_:\s]*/i, '').trim());
      if (Number.isInteger(num) && num >= 1 && num <= 4) {
        return { type: 'piece', value: num };
      }
    }
    if (
      s === 'EMPLOYEE_OUT' ||
      s === 'EMPLOYEE:OUT' ||
      s === 'SCAN:EMPLOYEE_OUT' ||
      s === 'ACTION:EMPLOYEE_OUT'
    ) {
      return { type: 'employee_out', value: s };
    }
    if (s.startsWith('PHASE:') || s.startsWith('PHASE_') || s.startsWith('ACTIVITY:')) {
      return { type: 'phase', value: s };
    }
    if (
      s === 'QA_QC_RESOLVE' ||
      s === 'RESOLVE_QA_QC' ||
      s === 'RESOLVE:QA_QC' ||
      s === 'ALERT:QA_QC_RESOLVE'
    ) {
      return { type: 'qa_qc_resolve', value: 'QA_QC_RESOLVE' };
    }
    if (s.startsWith('ALERT:') || s.startsWith('ALERT_')) return { type: 'alert', value: s };
    const endShift = resolveEndShift(s);
    if (endShift) return { type: 'end_shift', value: endShift.barcode };
    const downtime = resolveDowntimeReason(s);
    if (downtime) return { type: 'downtime', value: downtime.barcode };
    const pause = resolvePauseReason(s);
    if (pause) return { type: 'pause', value: pause.barcode };
    const phase = resolvePhase(s);
    if (phase) return { type: 'phase', value: phase.barcode };
    const alert = resolveAlert(s);
    if (alert) return { type: 'alert', value: alert.barcode };
    return { type: 'unknown', value: s };
  }

  async function buildTeamDashboardCards() {
    const { rows: teams } = await pool.query(
      `SELECT id, name, barcode, active FROM teams ORDER BY name ASC`
    );
    const { rows: memberRows } = await pool.query(
      `SELECT tm.id, tm.team_id, tm.name, tm.role, tm.active, tm.employee_id,
              e.code AS employee_code, e.name AS employee_name
       FROM team_members tm
       LEFT JOIN employees e ON e.id = tm.employee_id
       ORDER BY tm.team_id, COALESCE(e.name, tm.name) ASC`
    );
    const { rows: shiftMemberRows } = await pool.query(
      `SELECT team_id, employee_id FROM employee_team_memberships WHERE left_at IS NULL`
    );
    const onShiftByTeamId = new Map();
    for (const r of shiftMemberRows) {
      const tid = Number(r.team_id);
      if (!onShiftByTeamId.has(tid)) onShiftByTeamId.set(tid, new Set());
      if (r.employee_id != null) onShiftByTeamId.get(tid).add(Number(r.employee_id));
    }
    const machines = await fetchCanonicalWindingMachines();
    const productionByTeamId = new Map();
    for (const m of machines) {
      const openRows = await getOpenSessionsForMachine(m.id);
      for (const session of openRows) {
        const teamId = Number(session.team_id);
        if (!Number.isInteger(teamId) || teamId <= 0) continue;
        const mapped = await mapSession(session);
        const labor = await computeSessionLaborForRow(session);
        const phaseTimeSummary = session.tank_id
          ? await fetchTankPhaseTimeSummary(Number(session.tank_id))
          : [];
        const entry = {
          machine_id: Number(m.id),
          machine_name: displayMachineName(m.name),
          tank_number: mapped.tank_number,
          tank_id: mapped.tank_id,
          piece_number: Number(session.piece_number) || mapped.piece_number || 1,
          phase_name: mapped.phase_name,
          status: mapped.status || 'running',
          status_label: mapped.status_label,
          elapsed_display: mapped.elapsed_display,
          running_time_display: mapped.running_time_display,
          started_at: mapped.started_at,
          session_id: mapped.id,
          estimated_labor_cost: labor ? labor.total_estimated_cost : null,
          phase_time_summary: phaseTimeSummary,
          tank_total_running_time_ms: computeTankTotalRunningMs(phaseTimeSummary),
          tank_total_running_time_display: tankTotalRunningTimeDisplay(phaseTimeSummary),
        };
        if (!productionByTeamId.has(teamId)) productionByTeamId.set(teamId, []);
        productionByTeamId.get(teamId).push(entry);
      }
    }
    for (const entries of productionByTeamId.values()) {
      entries.sort((a, b) =>
        String(a.tank_number || '').localeCompare(String(b.tank_number || ''), undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );
    }
    const pausedWipByTeamId = new Map();
    const { rows: pausedTanks } = await pool.query(
      `SELECT id, tank_number, paused_reason, wip_team_id, wip_phase_code, wip_phase_name, wip_machine_id
       FROM tanks
       WHERE LOWER(TRIM(COALESCE(status, ''))) = 'paused' AND wip_team_id IS NOT NULL
       ORDER BY updated_at DESC, id DESC`
    );
    for (const row of pausedTanks) {
      const teamId = Number(row.wip_team_id);
      if (!Number.isInteger(teamId) || teamId <= 0 || (productionByTeamId.get(teamId) || []).length || pausedWipByTeamId.has(teamId)) {
        continue;
      }
      pausedWipByTeamId.set(teamId, row);
    }
    const wipPhaseSummaryByTankId = new Map();
    const wipMachineNameById = new Map();
    for (const row of pausedWipByTeamId.values()) {
      const tankId = Number(row.id);
      wipPhaseSummaryByTankId.set(tankId, await fetchTankPhaseTimeSummary(tankId));
      const machineId = Number(row.wip_machine_id);
      if (Number.isInteger(machineId) && machineId > 0 && !wipMachineNameById.has(machineId)) {
        const machineRow = await getMachineById(machineId);
        wipMachineNameById.set(machineId, machineRow ? displayMachineName(machineRow.name) : null);
      }
    }
    const cards = [];
    for (const t of teams) {
      const tid = Number(t.id);
      const members = memberRows
        .filter((m) => Number(m.team_id) === tid)
        .map((m) => ({
          id: Number(m.id),
          name: m.employee_name || m.name,
          employee_id: m.employee_id != null ? Number(m.employee_id) : null,
          employee_code: m.employee_code || null,
          role: m.role || null,
          active: Number(m.active) !== 0,
        }));
      const prodEntries = productionByTeamId.get(tid) || [];
      const prod = prodEntries.length ? prodEntries[0] : null;
      const wip = !prodEntries.length ? pausedWipByTeamId.get(tid) || null : null;
      const activeMembers = members.filter((m) => m.active);
      const onShift = onShiftByTeamId.get(tid) || new Set();
      const phaseTimeSummary = prod
        ? prod.phase_time_summary
        : wip
          ? wipPhaseSummaryByTankId.get(Number(wip.id)) || []
          : [];
      const machineName = prod
        ? prod.machine_name
        : wip && wip.wip_machine_id
          ? wipMachineNameById.get(Number(wip.wip_machine_id)) || null
          : null;
      const wipStatusLabel =
        wip && normalizeStopReason(wip.paused_reason) === 'end_shift' ? 'Paused - End Shift' : 'Paused';
      const anyRunning = prodEntries.some((p) => p.status === 'running');
      const teamStatus = prodEntries.length
        ? anyRunning
          ? 'running'
          : 'stopped'
        : wip
          ? 'paused'
          : 'idle';
      const teamStatusLabel = prodEntries.length
        ? prodEntries.length > 1
          ? `${prodEntries.length} active`
          : prod.status_label
        : wip
          ? wipStatusLabel
          : 'Idle';
      cards.push({
        id: tid,
        name: t.name,
        barcode: t.barcode,
        active: Number(t.active) !== 0,
        member_count: onShift.size || activeMembers.length,
        members: members.map((m) => ({
          ...m,
          on_shift: m.employee_id != null && onShift.has(Number(m.employee_id)),
        })),
        current_machine: machineName,
        current_tank: prod ? prod.tank_number : wip ? wip.tank_number : null,
        current_phase: prod ? prod.phase_name : wip ? wip.wip_phase_name || wip.wip_phase_code : null,
        current_piece: prod ? prod.piece_number || 1 : null,
        status: teamStatus,
        status_label: teamStatusLabel,
        elapsed_display: prod ? prod.elapsed_display : '—',
        running_time_display: prod ? prod.running_time_display : '—',
        started_at: prod ? prod.started_at : null,
        session_id: prod ? prod.session_id : null,
        tank_id: prod ? prod.tank_id : wip ? Number(wip.id) : null,
        estimated_labor_cost: prod ? prod.estimated_labor_cost : null,
        phase_time_summary: phaseTimeSummary,
        tank_total_running_time_ms: computeTankTotalRunningMs(phaseTimeSummary),
        tank_total_running_time_display: tankTotalRunningTimeDisplay(phaseTimeSummary),
        active_sessions: prodEntries,
        active_session_count: prodEntries.length,
      });
    }
    return cards;
  }

  function roundHours2(n) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  }

  function roundMoney(n) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  }

  async function fetchSessionMemberSnapshots(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT stm.employee_id, stm.employee_code, stm.employee_name, stm.hourly_rate,
              e.code AS live_code, e.name AS live_name, e.hourly_rate AS live_rate
       FROM session_team_members stm
       LEFT JOIN employees e ON e.id = stm.employee_id
       WHERE stm.session_id = $1
       ORDER BY COALESCE(stm.employee_name, e.name) ASC`,
      [sid]
    );
    return rows.map((r) => ({
      employee_id: Number(r.employee_id),
      employee_code: r.employee_code || r.live_code || null,
      employee_name: r.employee_name || r.live_name || 'Unknown',
      hourly_rate: roundMoney(r.hourly_rate != null ? r.hourly_rate : r.live_rate || 0),
    }));
  }

  function buildSessionLaborBreakdown(sessionRow, memberSnapshots, memberHoursById) {
    const defaultHours = roundHours2(sessionElapsedMs(sessionRow) / 3600000);
    const members = memberSnapshots.map((m) => {
      const empId = Number(m.employee_id);
      const hours =
        memberHoursById && memberHoursById.has(empId)
          ? memberHoursById.get(empId)
          : defaultHours;
      return {
        employee_id: m.employee_id,
        employee_code: m.employee_code,
        employee_name: m.employee_name,
        hourly_rate: m.hourly_rate,
        hours,
        estimated_cost: roundMoney(hours * m.hourly_rate),
      };
    });
    const totalEstimatedCost = roundMoney(members.reduce((sum, m) => sum + m.estimated_cost, 0));
    return {
      duration_hours: defaultHours,
      duration_display: formatElapsedDisplay(sessionElapsedMs(sessionRow)),
      member_count: members.length,
      members,
      total_estimated_cost: totalEstimatedCost,
    };
  }

  async function computeSessionLaborForRow(sessionRow) {
    if (!sessionRow) return null;
    const members = await fetchSessionMemberSnapshots(Number(sessionRow.id));
    const memberHoursById = new Map();
    for (const m of members) {
      const laborMs = await getMembershipApi().employeeSessionLaborMs(
        Number(m.employee_id),
        sessionRow,
        Date.now()
      );
      memberHoursById.set(Number(m.employee_id), roundHours2(laborMs / 3600000));
    }
    return buildSessionLaborBreakdown(sessionRow, members, memberHoursById);
  }

  async function getSessionById(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) return null;
    const { rows } = await pool.query(
      `SELECT ms.*,
              t.name AS team_name, t.barcode AS team_barcode,
              tk.tank_number,
              m.name AS machine_name, m.code AS machine_code, m.barcode AS machine_barcode
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.id = $1`,
      [sid]
    );
    return rows[0] || null;
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackErr) {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function finalizeSessionBeforeTransition(sessionRow, ts, client = pool) {
    if (!sessionRow || sessionRow.status === 'finished') return;
    const id = Number(sessionRow.id);
    if (sessionRow.status === 'stopped' && sessionRow.stopped_at) {
      await client.query(
        `UPDATE machine_sessions SET status = 'finished', finished_at = stopped_at, updated_at = $1::timestamptz WHERE id = $2`,
        [ts, id]
      );
    } else {
      await client.query(
        `UPDATE machine_sessions SET status = 'finished', finished_at = $1::timestamptz, updated_at = $1::timestamptz WHERE id = $2`,
        [ts, id]
      );
    }
  }

  async function stopSessionForWait(sessionRow, ts, stopReason, client = pool, notes = undefined) {
    if (!sessionRow) return;
    if (sessionRow.status === 'running') {
      if (notes !== undefined) {
        await client.query(
          `UPDATE machine_sessions
           SET status = 'stopped', stopped_at = $1::timestamptz, stop_reason = $2, notes = $3, updated_at = $1::timestamptz
           WHERE id = $4`,
          [ts, stopReason || null, notes, Number(sessionRow.id)]
        );
      } else {
        await client.query(
          `UPDATE machine_sessions SET status = 'stopped', stopped_at = $1::timestamptz, stop_reason = $2, updated_at = $1::timestamptz WHERE id = $3`,
          [ts, stopReason || null, Number(sessionRow.id)]
        );
      }
      return;
    }
    if (sessionRow.status === 'stopped') {
      // Already paused (e.g. Break → Lunch): update reason only; keep original stopped_at so elapsed stays correct.
      if (notes !== undefined) {
        await client.query(
          `UPDATE machine_sessions SET stop_reason = $1, notes = $2, updated_at = $3::timestamptz WHERE id = $4`,
          [stopReason || null, notes, ts, Number(sessionRow.id)]
        );
      } else {
        await client.query(
          `UPDATE machine_sessions SET stop_reason = $1, updated_at = $2::timestamptz WHERE id = $3`,
          [stopReason || null, ts, Number(sessionRow.id)]
        );
      }
    }
  }

  async function closeOpenDowntimeIntervalsForSession(sessionId, ts, client = pool) {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) return;
    const { rows } = await client.query(
      `SELECT id, started_at FROM downtime_intervals
       WHERE session_id = $1 AND ended_at IS NULL
       ORDER BY started_at DESC`,
      [sid]
    );
    for (const row of rows) {
      const startMs = new Date(row.started_at).getTime();
      const endMs = new Date(ts).getTime();
      const durationMs = Number.isNaN(startMs) || Number.isNaN(endMs) ? 0 : Math.max(0, endMs - startMs);
      await client.query(
        `UPDATE downtime_intervals
         SET ended_at = $1::timestamptz, duration_ms = $2
         WHERE id = $3`,
        [ts, durationMs, Number(row.id)]
      );
    }
  }

  function formatDowntimeNotes(reasonCode, reasonNote) {
    const opt = DOWNTIME_REASON_OPTIONS.find((o) => o.code === reasonCode);
    const label = opt ? opt.label : reasonCode ? String(reasonCode) : '';
    const note = reasonNote != null ? String(reasonNote).trim().slice(0, 500) : '';
    if (label && note) return `${label}: ${note}`;
    if (label) return label;
    if (note) return note;
    return null;
  }

  function uniqueTankNumbers(sessions) {
    const seen = new Set();
    const out = [];
    for (const s of sessions || []) {
      const t = String(s.tank_number || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  function formatTankList(tankNumbers) {
    const list = uniqueTankNumbers(tankNumbers.map((t) => ({ tank_number: t })));
    if (!list.length) return '';
    if (list.length === 1) return `Tank ${list[0]}`;
    if (list.length === 2) return `Tank ${list[0]} and Tank ${list[1]}`;
    return `${list.slice(0, -1).map((t) => `Tank ${t}`).join(', ')}, and Tank ${list[list.length - 1]}`;
  }

  async function resumeSingleOpenSession(row, ts, client = pool) {
    const priorMs = sessionElapsedMs(row);
    const newStartedAt = new Date(Date.now() - priorMs).toISOString();
    await closeOpenDowntimeIntervalsForSession(row.id, ts, client);
    await client.query(
      `UPDATE machine_sessions
       SET status = 'running',
           started_at = $1::timestamptz,
           stopped_at = NULL,
           resumed_at = $2::timestamptz,
           stop_reason = NULL,
           notes = NULL,
           updated_at = $2::timestamptz
       WHERE id = $3`,
      [newStartedAt, ts, Number(row.id)]
    );
  }

  /**
   * Winder-level Break / Lunch: pause EVERY open session on this machine immediately.
   */
  async function pauseSession(machine, pauseRaw, opts = {}) {
    void opts;
    const pauseDef = resolvePauseReason(pauseRaw);
    if (!pauseDef) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Unknown pause barcode.' } };
    }
    const openRows = await getOpenSessionsForMachine(machine.id);
    const eligible = openRows.filter((s) => s.status === 'running' || s.status === 'stopped');
    if (!eligible.length) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No active tanks to pause on this Winder.' } };
    }
    const tankNumbers = uniqueTankNumbers(eligible);
    const label = pauseDef.label || 'Break';
    const ts = nowIso();
    await withTransaction(async (client) => {
      for (const row of eligible) {
        await closeOpenDowntimeIntervalsForSession(row.id, ts, client);
        await stopSessionForWait(row, ts, pauseDef.stop_reason, client);
      }
    });

    const refreshed = await getOpenSessionsForMachine(machine.id);
    const sessions = [];
    for (const row of refreshed) sessions.push(await mapSession(row));
    const listText = formatTankList(tankNumbers);
    return {
      ok: true,
      body: {
        ok: true,
        action: 'pause',
        winder_level: true,
        pause_reason: pauseDef.stop_reason,
        pause_label: label,
        tank_count: tankNumbers.length,
        tank_numbers: tankNumbers,
        sessions,
        session: sessions[0] || null,
        confirmation_line: `${label} applied to ${listText}.`,
        message: `${label} applied to ${listText}.`,
      },
    };
  }

  /**
   * Tank-specific Downtime: pause only the selected tank's open session.
   */
  async function pauseDowntimeSession(machine, opts = {}) {
    const openRows = await getOpenSessionsForMachine(machine.id);
    let target = null;
    const tankId = opts.tank_id != null ? Number(opts.tank_id) : null;
    const tankNorm = opts.tank_number ? normalizeTankNumber(opts.tank_number) : '';
    const pieceNum = opts.piece_number != null ? Number(opts.piece_number) : null;
    if (Number.isInteger(tankId) && tankId > 0) {
      const sameTank = openRows.filter((r) => Number(r.tank_id) === tankId);
      if (pieceNum != null) {
        target = sameTank.find((r) => Number(r.piece_number || 1) === pieceNum) || null;
      } else if (sameTank.length === 1) {
        target = sameTank[0];
      } else if (sameTank.length > 1) {
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            error: 'need_piece',
            message: 'Select the piece for Downtime when multiple pieces are active on this tank.',
          },
        };
      } else {
        target = null;
      }
    } else if (tankNorm) {
      const sameTank = openRows.filter(
        (r) => String(r.tank_number || '').toUpperCase() === tankNorm
      );
      if (pieceNum != null) {
        target = sameTank.find((r) => Number(r.piece_number || 1) === pieceNum) || null;
      } else if (sameTank.length === 1) {
        target = sameTank[0];
      } else if (sameTank.length > 1) {
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            error: 'need_piece',
            message: 'Select the piece for Downtime when multiple pieces are active on this tank.',
          },
        };
      } else {
        target = null;
      }
    } else {
      target = await getOpenSession(machine.id);
    }
    if (!target) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'need_tank',
          message: 'Select the affected tank first, then press Downtime.',
        },
      };
    }
    if (target.status !== 'running' && target.status !== 'stopped') {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_session', message: 'Selected tank has no active session to put on Downtime.' },
      };
    }

    const reasonCode = opts.reason_code != null ? String(opts.reason_code).trim().slice(0, 60) : '';
    const reasonNote = opts.reason_note != null ? String(opts.reason_note).trim().slice(0, 500) : '';
    const notes = formatDowntimeNotes(reasonCode, reasonNote);
    const ts = nowIso();

    await withTransaction(async (client) => {
      // If already on downtime, close prior open interval before starting a new one.
      if (isDowntimeStopReason(target.stop_reason)) {
        await closeOpenDowntimeIntervalsForSession(target.id, ts, client);
      }
      await stopSessionForWait(target, ts, 'downtime', client, notes);
      await client.query(
        `INSERT INTO downtime_intervals
           (machine_id, tank_id, tank_number, session_id, team_id, team_name,
            phase_code, phase_name, piece_number, reason_code, reason_note, started_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $12::timestamptz)`,
        [
          Number(target.machine_id),
          Number(target.tank_id),
          String(target.tank_number || ''),
          Number(target.id),
          Number(target.team_id),
          target.team_name || null,
          target.activity_code || null,
          target.activity_name || null,
          Number(target.piece_number) || 1,
          reasonCode || null,
          reasonNote || null,
          ts,
        ]
      );
    });

    await setMachineActiveTank(machine.id, target.tank_id);
    const refreshed = await getOpenSessionsForMachine(machine.id);
    const sessions = [];
    for (const row of refreshed) sessions.push(await mapSession(row));
    const mapped = sessions.find((s) => Number(s.id) === Number(target.id)) || sessions[0] || null;
    return {
      ok: true,
      body: {
        ok: true,
        action: 'downtime',
        winder_level: false,
        tank_specific: true,
        pause_reason: 'downtime',
        pause_label: 'Downtime',
        tank_number: target.tank_number,
        tank_count: 1,
        tank_numbers: [String(target.tank_number)],
        reason_code: reasonCode || null,
        reason_note: reasonNote || null,
        sessions,
        session: mapped,
        confirmation_line: `Downtime started for Tank ${target.tank_number}.`,
        message: `Downtime started for Tank ${target.tank_number}.`,
      },
    };
  }

  /**
   * Winder-level Resume: resume EVERY Break/Lunch paused session on this machine.
   * Each tank keeps its own phase. Does not resume Downtime tanks (those are tank-specific).
   */
  async function resumeSession(machine, opts = {}) {
    void opts;
    const openRows = await getOpenSessionsForMachine(machine.id);
    const eligible = openRows.filter(
      (s) => s.status === 'stopped' && isWinderResumableStopReason(s.stop_reason)
    );
    if (!eligible.length) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_session', message: 'No paused tanks to resume on this Winder.' },
      };
    }
    const tankNumbers = uniqueTankNumbers(eligible);
    const ts = nowIso();
    await withTransaction(async (client) => {
      for (const row of eligible) {
        await resumeSingleOpenSession(row, ts, client);
      }
    });

    const refreshed = await getOpenSessionsForMachine(machine.id);
    const sessions = [];
    for (const row of refreshed) sessions.push(await mapSession(row));
    const listText = formatTankList(tankNumbers);
    const phaseNames = [
      ...new Set(eligible.map((s) => String(s.activity_name || s.activity_code || '').trim()).filter(Boolean)),
    ];
    return {
      ok: true,
      body: {
        ok: true,
        action: 'resume',
        winder_level: true,
        tank_count: tankNumbers.length,
        tank_numbers: tankNumbers,
        sessions,
        session: sessions[0] || null,
        resumed_phase: phaseNames.length === 1 ? phaseNames[0] : null,
        confirmation_line: `Resumed ${listText}.`,
        message: `Resumed ${listText}.`,
      },
    };
  }

  /**
   * Resume only the selected tank (typically from Downtime).
   */
  async function resumeSelectedSession(machine, opts = {}) {
    const openRows = await getOpenSessionsForMachine(machine.id);
    let target = null;
    const tankId = opts.tank_id != null ? Number(opts.tank_id) : null;
    const tankNorm = opts.tank_number ? normalizeTankNumber(opts.tank_number) : '';
    const pieceNum = opts.piece_number != null ? Number(opts.piece_number) : null;
    if (Number.isInteger(tankId) && tankId > 0) {
      const sameTank = openRows.filter((r) => Number(r.tank_id) === tankId);
      if (pieceNum != null) {
        target = sameTank.find((r) => Number(r.piece_number || 1) === pieceNum) || null;
      } else if (sameTank.length === 1) {
        target = sameTank[0];
      } else {
        target = sameTank[0] || null;
      }
    } else if (tankNorm) {
      const sameTank = openRows.filter(
        (r) => String(r.tank_number || '').toUpperCase() === tankNorm
      );
      if (pieceNum != null) {
        target = sameTank.find((r) => Number(r.piece_number || 1) === pieceNum) || null;
      } else if (sameTank.length === 1) {
        target = sameTank[0];
      } else {
        target = sameTank[0] || null;
      }
    } else {
      target = await getOpenSession(machine.id);
    }
    if (!target || target.status !== 'stopped' || !isResumableStopReason(target.stop_reason)) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_session', message: 'Selected tank is not paused.' },
      };
    }
    if (isQaQcStopReason(target.stop_reason)) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'use_resolve_qa_qc',
          message: 'This piece is on QA/QC. Scan QA_QC_RESOLVE or tap Resolve QA/QC.',
        },
      };
    }
    const ts = nowIso();
    await withTransaction(async (client) => {
      await resumeSingleOpenSession(target, ts, client);
    });
    await setMachineActiveTank(machine.id, target.tank_id);
    const refreshed = await getOpenSessionsForMachine(machine.id);
    const sessions = [];
    for (const row of refreshed) sessions.push(await mapSession(row));
    const mapped = sessions.find((s) => Number(s.id) === Number(target.id)) || null;
    return {
      ok: true,
      body: {
        ok: true,
        action: 'resume',
        winder_level: false,
        tank_specific: true,
        tank_count: 1,
        tank_numbers: [String(target.tank_number)],
        tank_number: target.tank_number,
        sessions,
        session: mapped,
        resumed_phase: target.activity_name || target.activity_code || null,
        confirmation_line: `Resumed Tank ${target.tank_number}.`,
        message: `Resumed Tank ${target.tank_number}${target.activity_name ? ` — ${target.activity_name}` : ''}.`,
      },
    };
  }

  /**
   * Winder-level End Shift: stop ALL open sessions, preserve each tank's phase as WIP, clear team assignment.
   */
  async function endShiftSession(machine, opts = {}) {
    void opts;
    const openRows = await getOpenSessionsForMachine(machine.id);
    const assignment = await getMachineAssignment(machine.id);
    const machineName = displayMachineName(machine.name);

    if (!openRows.length) {
      await clearMachineAssignment(machine.id);
      return {
        ok: true,
        body: {
          ok: true,
          action: 'end_shift',
          winder_level: true,
          tank_number: null,
          tank_numbers: [],
          tank_count: 0,
          phase_name: null,
          team_name: assignment ? assignment.team_name : null,
          status_label: 'Shift ended',
          confirmation_line: `End Shift applied to ${machineName}.`,
          message: `End Shift applied to ${machineName}.`,
        },
      };
    }

    const tankNumbers = uniqueTankNumbers(openRows);
    const ts = nowIso();
    const teamIdForClose = assignment ? Number(assignment.team_id) : null;
    await withTransaction(async (client) => {
      for (const session of openRows) {
        await closeOpenDowntimeIntervalsForSession(session.id, ts, client);
        await finalizeSessionBeforeTransition(session, ts, client);
        await client.query(
          `UPDATE tanks
           SET status = 'paused',
               paused_reason = 'end_shift',
               wip_team_id = $1,
               wip_phase_code = $2,
               wip_phase_name = $3,
               wip_machine_id = $4,
               updated_at = $5::timestamptz
           WHERE id = $6`,
          [
            Number(session.team_id),
            String(session.activity_code || ''),
            String(session.activity_name || ''),
            Number(session.machine_id),
            ts,
            Number(session.tank_id),
          ]
        );
      }
      if (teamIdForClose) {
        await client.query(
          `UPDATE employee_team_memberships
           SET left_at = $1::timestamptz, reason = COALESCE(reason, 'end_shift')
           WHERE team_id = $2 AND left_at IS NULL`,
          [ts, teamIdForClose]
        );
      }
      await client.query(
        `UPDATE machines SET assigned_team_id = NULL, assigned_team_day = NULL, assigned_team_at = NULL, active_tank_id = NULL WHERE id = $1`,
        [Number(machine.id)]
      );
    });

    return {
      ok: true,
      body: {
        ok: true,
        action: 'end_shift',
        winder_level: true,
        tank_number: tankNumbers[0] || null,
        tank_numbers: tankNumbers,
        tank_count: tankNumbers.length,
        phase_name: null,
        team_name: openRows[0] ? openRows[0].team_name : assignment ? assignment.team_name : null,
        status_label: 'End Shift',
        confirmation_line: `End Shift applied to ${machineName}. Stopped ${formatTankList(tankNumbers)}. Phases preserved for next shift.`,
        message: `End Shift applied to ${machineName}.`,
      },
    };
  }

  async function fetchTeamPausedWip(teamId) {
    const tid = Number(teamId);
    if (!Number.isInteger(tid) || tid <= 0) return null;
    const { rows } = await pool.query(
      `SELECT id, tank_number, paused_reason, wip_phase_code, wip_phase_name, wip_machine_id
       FROM tanks
       WHERE wip_team_id = $1 AND LOWER(TRIM(COALESCE(status, ''))) = 'paused'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [tid]
    );
    return rows[0] || null;
  }

  async function getPausedTankByNumber(tankNumber) {
    const norm = normalizeTankNumber(tankNumber);
    if (!norm) return null;
    const { rows } = await pool.query(
      `SELECT id, tank_number, status, paused_reason, wip_team_id, wip_phase_code, wip_phase_name, wip_machine_id, current_piece_number
       FROM tanks
       WHERE UPPER(TRIM(tank_number)) = $1 AND LOWER(TRIM(COALESCE(status, ''))) = 'paused'
       LIMIT 1`,
      [norm]
    );
    return rows[0] || null;
  }

  /**
   * After End Shift, tanks are paused with WIP (no open session). Resume all WIP tanks on this Winder.
   */
  async function resumeAllEndShiftWipTanks(machine, team, opts = {}) {
    void opts;
    if (!team) {
      return { ok: false, status: 409, body: { ok: false, error: 'need_team', message: 'Scan a Team barcode first.' } };
    }
    const { rows: pausedTanks } = await pool.query(
      `SELECT id, tank_number, wip_phase_code, wip_phase_name, paused_reason, current_piece_number
       FROM tanks
       WHERE LOWER(TRIM(COALESCE(status, ''))) = 'paused'
         AND LOWER(TRIM(COALESCE(paused_reason, ''))) = 'end_shift'
         AND wip_machine_id = $1
       ORDER BY tank_number ASC`,
      [Number(machine.id)]
    );
    if (!pausedTanks.length) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_session', message: 'No End Shift paused tanks to resume on this Winder.' },
      };
    }

    const sessions = [];
    const resumed = [];
    for (const tank of pausedTanks) {
      const phaseCode = String(tank.wip_phase_code || '').trim().toUpperCase();
      const phase = resolvePhase(phaseCode);
      if (!phase) continue;
      const start = await startSession(machine, {
        team,
        tankNumber: tank.tank_number,
        phaseRaw: phase.barcode,
        pieceNumber: Number(tank.current_piece_number) || 1,
      });
      if (start.ok && start.body && start.body.session) {
        sessions.push(start.body.session);
        resumed.push(String(tank.tank_number));
      }
    }
    if (!resumed.length) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_paused_phase', message: 'Could not resume End Shift tanks — missing saved phases.' },
      };
    }
    return {
      ok: true,
      body: {
        ok: true,
        action: 'resume',
        winder_level: true,
        tank_count: resumed.length,
        tank_numbers: resumed,
        sessions,
        session: sessions[0] || null,
        confirmation_line: `Resumed ${formatTankList(resumed)} from End Shift.`,
        message: `Resumed ${formatTankList(resumed)} from End Shift.`,
      },
    };
  }

  /**
   * Option 1: resume a tank that was paused via End Shift, continuing the same
   * (paused) phase. Opens a fresh running session on the saved WIP phase.
   */
  async function resumePausedTank(machine, tankNumber, team) {
    const pausedTank = await getPausedTankByNumber(tankNumber);
    if (!pausedTank) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_paused_phase', message: 'No paused phase for this tank. Scan a phase to begin.' },
      };
    }
    const phaseCode = String(pausedTank.wip_phase_code || '').trim().toUpperCase();
    const phase = resolvePhase(phaseCode);
    if (!phase) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'no_paused_phase', message: 'No saved phase to resume. Scan a phase to begin.' },
      };
    }
    const start = await startSession(machine, {
      team,
      tankNumber: pausedTank.tank_number,
      phaseRaw: phase.barcode,
      pieceNumber: Number(pausedTank.current_piece_number) || 1,
    });
    if (!start.ok) return start;
    return { ok: true, body: { ok: true, action: 'resume', resumed_phase: phase.label, session: start.body.session } };
  }

  async function spawnContinuationSession(prevSessionRow, phase, ts, opts = {}) {
    const pieceNum = opts.pieceNumber != null ? Number(opts.pieceNumber) : prevSessionRow.piece_number || 1;
    let pieceId = opts.pieceId != null ? Number(opts.pieceId) : prevSessionRow.piece_id || null;
    if (!pieceId) {
      const pieceRow = await getTankPieceByNumber(prevSessionRow.tank_id, pieceNum);
      pieceId = pieceRow ? pieceRow.id : null;
    }
    const insertRes = await pool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, created_at, updated_at, piece_number, piece_id, notes)
       VALUES ($1,$2,$3,$4,$5,'running',$6::timestamptz,$6::timestamptz,$6::timestamptz,$7,$8,$9)
       RETURNING id`,
      [
        Number(prevSessionRow.machine_id),
        Number(prevSessionRow.team_id),
        Number(prevSessionRow.tank_id),
        phase.code,
        phase.label,
        ts,
        pieceNum,
        pieceId,
        opts.notes || null,
      ]
    );
    const newId = insertRes.rows[0] ? Number(insertRes.rows[0].id) : null;
    if (newId) await snapshotSessionTeamMembers(newId, Number(prevSessionRow.team_id));
    return getSessionById(newId);
  }

  function sessionMsInBounds(session, bounds, closeMs = Date.now()) {
    if (!bounds) return 0;
    const ws = new Date(bounds.startIso).getTime();
    const we = new Date(bounds.endIso).getTime();
    if (Number.isNaN(ws) || Number.isNaN(we)) return 0;
    const startMs = new Date(session.started_at).getTime();
    if (Number.isNaN(startMs)) return 0;
    let endMs;
    if (session.status === 'finished' && session.finished_at) {
      endMs = new Date(session.finished_at).getTime();
    } else if (session.status === 'stopped' && session.stopped_at) {
      endMs = new Date(session.stopped_at).getTime();
    } else {
      endMs = closeMs;
    }
    if (Number.isNaN(endMs)) endMs = closeMs;
    const overlapStart = Math.max(startMs, ws);
    const overlapEnd = Math.min(endMs, we, closeMs);
    return Math.max(0, overlapEnd - overlapStart);
  }

  async function snapshotSessionTeamMembers(sessionId, teamId) {
    const sid = Number(sessionId);
    const tid = Number(teamId);
    if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(tid) || tid <= 0) return;
    const { rows } = await pool.query(
      `SELECT tm.id, etm.employee_id, e.code AS employee_code, e.name AS employee_name, e.hourly_rate
       FROM employee_team_memberships etm
       JOIN employees e ON e.id = etm.employee_id
       LEFT JOIN team_members tm ON tm.team_id = etm.team_id AND tm.employee_id = etm.employee_id
       WHERE etm.team_id = $1 AND etm.left_at IS NULL AND etm.employee_id IS NOT NULL`,
      [tid]
    );
    for (const m of rows) {
      await pool.query(
        `INSERT INTO session_team_members
           (session_id, employee_id, team_member_id, employee_code, employee_name, hourly_rate, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (session_id, employee_id) DO NOTHING`,
        [
          sid,
          Number(m.employee_id),
          m.id != null ? Number(m.id) : null,
          m.employee_code || null,
          m.employee_name || null,
          m.hourly_rate != null ? roundMoney(m.hourly_rate) : 0,
        ]
      );
    }
  }

  async function backfillOpenSessionTeamMembers() {
    const { rows } = await pool.query(
      `SELECT ms.id, ms.team_id FROM machine_sessions ms
       WHERE ms.status IN ('running', 'stopped')
         AND NOT EXISTS (SELECT 1 FROM session_team_members stm WHERE stm.session_id = ms.id)`
    );
    for (const r of rows) {
      await snapshotSessionTeamMembers(Number(r.id), Number(r.team_id));
    }
  }

  async function computeEmployeeTeamProductionMs(employeeId, bounds, closeMs = Date.now()) {
    return getMembershipApi().computeEmployeeMembershipProductionMs(employeeId, bounds, closeMs);
  }

  async function computeEmployeeTeamProductionHoursForDay(employeeId, yyyyMmDd) {
    const bounds = startEndOfLocalDay(yyyyMmDd);
    if (!bounds) return 0;
    const todayKey = localDateString();
    const closeMs = yyyyMmDd === todayKey ? Date.now() : new Date(bounds.endIso).getTime();
    const ms = await computeEmployeeTeamProductionMs(employeeId, bounds, closeMs);
    return roundHours2(ms / 3600000);
  }

  async function computeEmployeeTeamProductionWeekHours(employeeId) {
    const week = weekBoundsLocal ? weekBoundsLocal() : null;
    const today = startEndOfLocalDay(localDateString());
    if (!week || !today) return 0;
    const bounds = { startIso: week.startIso, endIso: today.endIso };
    const ms = await computeEmployeeTeamProductionMs(employeeId, bounds, Date.now());
    return roundHours2(ms / 3600000);
  }

  async function fetchSessionDetails(sessionId) {
    const row = await getSessionById(sessionId);
    if (!row) return null;
    const labor = await computeSessionLaborForRow(row);
    return {
      id: Number(row.id),
      team_id: Number(row.team_id),
      team_name: row.team_name,
      tank_id: Number(row.tank_id),
      tank_number: row.tank_number,
      machine_id: Number(row.machine_id),
      machine_name: displayMachineName(row.machine_name),
      phase_code: row.activity_code,
      phase_name: row.activity_name,
      piece_number: row.piece_number != null ? Number(row.piece_number) : 1,
      piece_id: row.piece_id != null ? Number(row.piece_id) : null,
      status: row.status,
      status_label: sessionStatusLabelFromRow(row),
      stop_reason: row.stop_reason || null,
      started_at: row.started_at,
      stopped_at: row.stopped_at || null,
      finished_at: row.finished_at || null,
      duration_hours: labor ? labor.duration_hours : 0,
      duration_display: labor ? labor.duration_display : formatElapsedDisplay(sessionElapsedMs(row)),
      total_estimated_cost: labor ? labor.total_estimated_cost : 0,
      members: labor ? labor.members : [],
    };
  }

  async function fetchTankProductionLabor(tankId) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return null;
    const { rows: sessionRows } = await pool.query(
      `SELECT ms.*, t.name AS team_name, tk.tank_number, m.name AS machine_name
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.tank_id = $1
       ORDER BY ms.started_at ASC, ms.id ASC`,
      [tid]
    );
    if (!sessionRows.length) {
      const phase_time_summary = await fetchTankPhaseTimeSummary(tid);
      return {
        total_hours: 0,
        total_machine_hours: 0,
        total_estimated_labor_cost: 0,
        phases: [],
        phase_time_summary,
        member_breakdown: [],
        hours_per_phase: [],
        hours_per_team: [],
        hours_per_piece: [],
      };
    }

    const phaseMap = new Map();
    const memberTotals = new Map();
    let totalEstimatedCost = 0;
    let totalHours = 0;

    for (const row of sessionRows) {
      const code = String(row.activity_code || '').trim().toUpperCase();
      if (!isProductionPhaseCode(code)) continue;
      const labor = await computeSessionLaborForRow(row);
      if (!labor) continue;
      totalEstimatedCost += labor.total_estimated_cost;
      totalHours += labor.duration_hours;

      const phaseKey = code;
      if (!phaseMap.has(phaseKey)) {
        phaseMap.set(phaseKey, {
          phase_code: row.activity_code,
          phase_name: row.activity_name,
          sessions: [],
          phase_total_hours: 0,
          phase_total_cost: 0,
          phase_total_duration_ms: 0,
        });
      }
      const endTs = sessionEndTimestamp(row);
      let edits = [];
      try {
        edits = await getMembershipApi().listSessionEdits(Number(row.id));
      } catch (_err) {
        edits = [];
      }
      const phaseGroup = phaseMap.get(phaseKey);
      phaseGroup.sessions.push({
        id: Number(row.id),
        team_name: row.team_name,
        machine_name: displayMachineName(row.machine_name),
        phase_name: row.activity_name,
        phase_code: row.activity_code,
        piece_number: row.piece_number != null ? Number(row.piece_number) : null,
        piece_id: row.piece_id != null ? Number(row.piece_id) : null,
        started_at: row.started_at,
        finished_at: row.finished_at || null,
        ended_at: endTs,
        status: row.status,
        status_label: sessionStatusLabelFromRow(row),
        duration_hours: labor.duration_hours,
        duration_display: labor.duration_display,
        total_estimated_cost: labor.total_estimated_cost,
        members: labor.members,
        is_edited: edits.length > 0,
        latest_edit_reason: edits[0] ? edits[0].edit_reason : null,
        edits,
      });
      phaseGroup.phase_total_hours = roundHours2(phaseGroup.phase_total_hours + labor.duration_hours);
      phaseGroup.phase_total_cost = roundMoney(phaseGroup.phase_total_cost + labor.total_estimated_cost);
      phaseGroup.phase_total_duration_ms += sessionElapsedMs(row);

      for (const m of labor.members) {
        const eid = Number(m.employee_id);
        const prev = memberTotals.get(eid) || {
          employee_id: eid,
          employee_code: m.employee_code,
          employee_name: m.employee_name,
          total_hours: 0,
          total_estimated_cost: 0,
        };
        prev.total_hours = roundHours2(prev.total_hours + m.hours);
        prev.total_estimated_cost = roundMoney(prev.total_estimated_cost + m.estimated_cost);
        memberTotals.set(eid, prev);
      }
    }

    const phases = [...phaseMap.values()].sort(
      (a, b) => productionPhaseSortIndex(a.phase_code) - productionPhaseSortIndex(b.phase_code)
    );
    const phase_time_summary = await fetchTankPhaseTimeSummary(tid);
    const member_breakdown = [...memberTotals.values()].sort((a, b) =>
      String(a.employee_name || '').localeCompare(String(b.employee_name || ''))
    );

    // Machine hours = sum of session wall-clock duration (not multiplied by headcount).
    let totalMachineHours = 0;
    const teamHoursMap = new Map();
    const pieceHoursMap = new Map();
    for (const row of sessionRows) {
      const code = String(row.activity_code || '').trim().toUpperCase();
      if (!isProductionPhaseCode(code)) continue;
      const ms = sessionElapsedMs(row);
      const hours = roundHours2(ms / 3600000);
      totalMachineHours = roundHours2(totalMachineHours + hours);
      const teamKey = row.team_name || '—';
      teamHoursMap.set(teamKey, roundHours2((teamHoursMap.get(teamKey) || 0) + hours));
      const pieceKey = Number(row.piece_number) || 1;
      pieceHoursMap.set(pieceKey, roundHours2((pieceHoursMap.get(pieceKey) || 0) + hours));
    }

    let membershipLabor = null;
    try {
      membershipLabor = await getMembershipApi().computeMembershipAwareTankLabor(tid);
    } catch (err) {
      console.warn('[fetchTankProductionLabor] membership labor:', err.message);
    }

    return {
      total_hours: membershipLabor ? membershipLabor.total_labor_hours : roundHours2(totalHours),
      total_labor_hours: membershipLabor ? membershipLabor.total_labor_hours : roundHours2(totalHours),
      total_labor_display: membershipLabor ? membershipLabor.total_labor_display : null,
      total_machine_hours: membershipLabor ? membershipLabor.total_running_hours : totalMachineHours,
      total_running_hours: membershipLabor ? membershipLabor.total_running_hours : totalMachineHours,
      total_running_display: membershipLabor ? membershipLabor.total_running_display : null,
      total_estimated_labor_cost: roundMoney(totalEstimatedCost),
      phases,
      phase_time_summary,
      member_breakdown: membershipLabor ? membershipLabor.member_breakdown : member_breakdown,
      hours_per_phase: phases.map((p) => ({
        phase_code: p.phase_code,
        phase_name: p.phase_name,
        hours: p.phase_total_hours,
      })),
      hours_per_team: [...teamHoursMap.entries()].map(([team_name, hours]) => ({ team_name, hours })),
      hours_per_piece: membershipLabor
        ? membershipLabor.hours_per_piece
        : [...pieceHoursMap.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([piece_number, hours]) => ({ piece_number, hours })),
      labor_source: membershipLabor ? 'membership_history' : 'session_snapshot',
    };
  }

  async function fetchTankTeamCompletion(tankId) {
    const empty = () => ({
      recorded: false,
      team_id: null,
      team_name: null,
      completed_at: null,
      confirmed_by_employee_id: null,
      confirmed_by_employee_name: null,
      confirmation_line: null,
      members: [],
      members_included: 0,
      total_team_hours: 0,
      total_estimated_labor_cost: 0,
    });

    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return empty();

    let pce = null;
    try {
      const pceRes = await pool.query(
        `SELECT * FROM part_complete_events WHERE tank_id = $1 ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1`,
        [tid]
      );
      pce = pceRes.rows[0] || null;
    } catch (err) {
      console.warn('[fetchTankTeamCompletion] part_complete_events query failed:', err.message);
    }

    let sessionRows = [];
    try {
      const sessionsRes = await pool.query(
        `SELECT ms.id, ms.started_at, ms.finished_at, ms.stopped_at, ms.status, ms.team_id, ms.activity_code,
                t.name AS team_name
         FROM machine_sessions ms
         JOIN teams t ON t.id = ms.team_id
         WHERE ms.tank_id = $1
         ORDER BY ms.started_at ASC, ms.id ASC`,
        [tid]
      );
      sessionRows = sessionsRes.rows;
    } catch (err) {
      console.warn('[fetchTankTeamCompletion] machine_sessions query failed:', err.message);
    }

    const memberHours = new Map();
    for (const sessionRow of sessionRows) {
      if (!isProductionPhaseCode(sessionRow.activity_code)) continue;
      const elapsedMs = sessionElapsedMs(sessionRow);
      if (elapsedMs <= 0) continue;
      const hours = elapsedMs / 3600000;
      let members = [];
      try {
        const memberRes = await pool.query(
          `SELECT stm.employee_id, stm.employee_code, stm.employee_name, stm.hourly_rate,
                  e.code AS live_code, e.name AS live_name, e.hourly_rate AS live_rate
           FROM session_team_members stm
           LEFT JOIN employees e ON e.id = stm.employee_id
           WHERE stm.session_id = $1`,
          [Number(sessionRow.id)]
        );
        members = memberRes.rows;
      } catch (err) {
        console.warn('[fetchTankTeamCompletion] session_team_members query failed:', err.message);
        continue;
      }
      for (const m of members) {
        const eid = Number(m.employee_id);
        if (!Number.isInteger(eid) || eid <= 0) continue;
        const rate = roundMoney(m.hourly_rate != null ? m.hourly_rate : m.live_rate || 0);
        const estCost = roundMoney(hours * rate);
        const prev = memberHours.get(eid) || {
          employee_id: eid,
          employee_code: m.employee_code || m.live_code,
          employee_name: m.employee_name || m.live_name || 'Unknown',
          total_hours: 0,
          total_estimated_cost: 0,
        };
        prev.total_hours = roundHours2(prev.total_hours + hours);
        prev.total_estimated_cost = roundMoney(prev.total_estimated_cost + estCost);
        memberHours.set(eid, prev);
      }
    }

    const teamId =
      pce && pce.team_id != null
        ? Number(pce.team_id)
        : sessionRows.length
          ? Number(sessionRows[sessionRows.length - 1].team_id)
          : null;
    const teamName =
      (pce && pce.team_name) ||
      (sessionRows.length ? sessionRows[sessionRows.length - 1].team_name : null);
    const confirmedName =
      pce && pce.confirmed_by_employee_name ? String(pce.confirmed_by_employee_name).trim() : null;
    const completedAt = pce && pce.completed_at ? pce.completed_at : null;
    const confirmationLine =
      confirmedName && teamName
        ? `${confirmedName} confirmed Part Complete for ${teamName}`
        : confirmedName
          ? `${confirmedName} confirmed Part Complete`
          : teamName
            ? `Part Complete recorded for ${teamName}`
            : null;

    const members = [...memberHours.values()]
      .map((m) => ({
        ...m,
        total_hours: roundHours2(m.total_hours),
        total_estimated_cost: roundMoney(m.total_estimated_cost),
      }))
      .sort((a, b) => String(a.employee_name || '').localeCompare(String(b.employee_name || '')));
    const totalTeamHours = roundHours2(members.reduce((sum, m) => sum + m.total_hours, 0));
    const totalEstimatedCost = roundMoney(members.reduce((sum, m) => sum + m.total_estimated_cost, 0));

    if (!pce && !sessionRows.length && !members.length) return empty();

    return {
      recorded: !!pce,
      team_id: teamId,
      team_name: teamName,
      completed_at: completedAt,
      confirmed_by_employee_id:
        pce && pce.confirmed_by_employee_id != null ? Number(pce.confirmed_by_employee_id) : null,
      confirmed_by_employee_name: confirmedName,
      confirmation_line: confirmationLine,
      members,
      members_included: members.length,
      total_team_hours: totalTeamHours,
      total_estimated_labor_cost: totalEstimatedCost,
    };
  }

  return {
    WINDING_PHASES,
    ALERT_TYPES,
    PAUSE_REASONS,
    RESUME_BARCODES,
    WINDING_MACHINE_AREA_NAMES,
    isWindingMachineArea,
    normalizeTeamBarcode,
    normalizeMachineBarcode,
    resolvePhase,
    resolveAlert,
    resolvePauseReason,
    resolveEndShift,
    isResumeScan,
    parseScan,
    getMachineById,
    getMachineByCode,
    getMachineBySlug,
    getMachineByAreaName,
    getTeamByBarcode,
    getOpenSession,
    getOpenSessionsForMachine,
    getOpenSessionForPiece,
    setMachineActiveTank,
    ensureTankPieces,
    getTankPieces,
    getTankPieceByNumber,
    resolvePieceForTank,
    tankHasProductionActivity,
    maxPieceNumberWithActivity,
    computePieceProgress,
    fetchPieceReports,
    fetchPhaseEditorPayload,
    finishPiece,
    finishTankArchive,
    getMachineAssignment,
    assignTeamToMachine,
    clearMachineAssignment,
    fetchTeamPausedWip,
    getPausedTankByNumber,
    resumePausedTank,
    resumeAllEndShiftWipTanks,
    mapSession,
    fetchActiveWindingMachines,
    fetchManagedWindingMachines,
    getMachineUsageSummary,
    fetchCanonicalWindingMachines,
    buildDashboardCards,
    buildTeamDashboardCards,
    countActiveProduction,
    fetchAllOpenAlerts,
    startSession,
    changePhase,
    finishSession,
    pauseSession,
    pauseDowntimeSession,
    resumeSession,
    resumeSelectedSession,
    endShiftSession,
    createAlert,
    resolveAlertById,
    resolveQaQcForMachine,
    findOpenQaQcAlert,
    fetchTankQaQcHistory,
    isQaQcStopReason,
    fetchProductionHistory,
    fetchTankActivity,
    fetchAlertHistory,
    formatElapsedDisplay,
    sessionElapsedMs,
    sessionStatusLabelFromRow,
    snapshotSessionTeamMembers,
    backfillOpenSessionTeamMembers,
    computeEmployeeTeamProductionMs,
    computeEmployeeTeamProductionHoursForDay,
    computeEmployeeTeamProductionWeekHours,
    fetchTankTeamCompletion,
    fetchTankProductionLabor,
    fetchSessionDetails,
    fetchTankPhaseTimeSummary,
    transferEmployeeToTeam: (...args) => getMembershipApi().transferEmployeeToTeam(...args),
    employeeOutFromTeam: (...args) => getMembershipApi().employeeOutFromTeam(...args),
    listOpenShiftEmployeesForTeam: (...args) => getMembershipApi().listOpenShiftEmployeesForTeam(...args),
    getEmployeeActiveShiftTeam: (...args) => getMembershipApi().getEmployeeActiveShiftTeam(...args),
    startTeamShiftMemberships: (...args) => getMembershipApi().startTeamShiftMemberships(...args),
    closeTeamShiftMemberships: (...args) => getMembershipApi().closeTeamShiftMemberships(...args),
    findOpenPieceSession: (...args) => getMembershipApi().findOpenPieceSession(...args),
    computeMembershipAwareTankLabor: (...args) => getMembershipApi().computeMembershipAwareTankLabor(...args),
    computeEmployeeMembershipProductionMs: (...args) =>
      getMembershipApi().computeEmployeeMembershipProductionMs(...args),
    employeeSessionLaborMs: (...args) => getMembershipApi().employeeSessionLaborMs(...args),
    editMachineSessionTimes: (...args) => getMembershipApi().editMachineSessionTimes(...args),
    listSessionEdits: (...args) => getMembershipApi().listSessionEdits(...args),
    isDowntimeStopReason,
    isQaQcStopReason,
    isWinderResumableStopReason,
    DOWNTIME_REASON_OPTIONS,
    computeSessionLaborForRow,
    emptyTankTeamCompletion: () => ({
      recorded: false,
      team_id: null,
      team_name: null,
      completed_at: null,
      confirmed_by_employee_id: null,
      confirmed_by_employee_name: null,
      confirmation_line: null,
      members: [],
      members_included: 0,
      total_team_hours: 0,
      total_estimated_labor_cost: 0,
    }),
  };
}

module.exports = {
  createPhase1ProductionLogic,
  WINDING_PHASES,
  ALERT_TYPES,
  PAUSE_REASONS,
  DOWNTIME_REASON_OPTIONS,
  RESUME_BARCODES,
  TANK_TOTAL_RUNNING_PHASE_CODES,
  isTankTotalRunningPhaseCode,
  WINDING_MACHINES,
  WINDING_MACHINE_AREA_NAMES,
  CANONICAL_WINDING_MACHINE_CODES,
  WINDING_MACHINE_LEGACY_AREA_ALIASES,
  normalizeWindingMachineAreaName,
  isWindingMachineAreaName,
  isCanonicalWindingMachineCode,
  isLegacyWindingStationRecord,
  slugFromMachineName,
  kioskUrlForSlug,
  mapMachineForClient,
  displayMachineName,
  countActiveProduction,
};
