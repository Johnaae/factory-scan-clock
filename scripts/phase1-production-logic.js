'use strict';

/** Winding Machine Phase 1 — phases, alerts, sessions. */
const WINDING_PHASES = [
  { code: 'PREP_CLEANUP', label: 'Prep/Clean up', barcode: 'PHASE:PREP_CLEANUP' },
  { code: 'CHOP', label: 'Chop', barcode: 'PHASE:CHOP' },
  { code: 'RIB_INSTALL', label: 'Rib Install', barcode: 'PHASE:RIB_INSTALL' },
  { code: 'DOME_INSTALL', label: 'Dome Install', barcode: 'PHASE:DOME_INSTALL' },
  { code: 'WIND', label: 'Wind', barcode: 'PHASE:WIND' },
  { code: 'HOT_COAT', label: 'Hot Coat', barcode: 'PHASE:HOT_COAT' },
  { code: 'CORRECTIONS', label: 'Corrections', barcode: 'PHASE:CORRECTIONS' },
  { code: 'SPACER_GLASS', label: 'Spacer Glass', barcode: 'PHASE:SPACER_GLASS' },
  { code: 'PART_COMPLETE', label: 'Part Complete', barcode: 'PHASE:PART_COMPLETE', completes: true },
];

/** Production phases included in Tank Total Running Time (excludes Prep/Clean up). */
const TANK_TOTAL_RUNNING_PHASE_CODES = new Set([
  'CHOP',
  'RIB_INSTALL',
  'DOME_INSTALL',
  'WIND',
  'HOT_COAT',
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
  BREAK: { code: 'BREAK', label: 'Break', barcode: 'STOP:BREAK', stop_reason: 'break', resumable: true },
  LUNCH: { code: 'LUNCH', label: 'Lunch', barcode: 'STOP:LUNCH', stop_reason: 'lunch', resumable: true },
  END_SHIFT: {
    code: 'END_SHIFT',
    label: 'End Shift',
    barcode: 'REASON:END_SHIFT',
    stop_reason: 'end_shift',
    resumable: false,
  },
};

const RESUME_BARCODES = new Set(['RESUME', 'STOP:RESUME', 'ACTION:RESUME']);

const WINDING_MACHINES = [
  { areaName: 'Winding Machine 01', code: 'WM-01', barcode: 'WM-01', kioskSlug: 'winding-machine-01', sortOrder: 1 },
  { areaName: 'Winding Machine 02', code: 'WM-02', barcode: 'WM-02', kioskSlug: 'winding-machine-02', sortOrder: 2 },
  { areaName: 'Winding Machine 03', code: 'WM-03', barcode: 'WM-03', kioskSlug: 'winding-machine-03', sortOrder: 3 },
];

const WINDING_MACHINE_AREA_NAMES = WINDING_MACHINES.map((m) => m.areaName);

/** Only WM-01/02/03 are rendered on dashboards and production UIs. */
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
  return WINDING_MACHINE_AREA_NAMES.includes(normalizeWindingMachineAreaName(area));
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

function createPhase1ProductionLogic(deps) {
  const {
    pool,
    nowIso,
    normalizeTankNumber,
    ensureTankExists,
    normalizeTankStatus,
    startEndOfLocalDay,
    localDateString,
    weekBoundsLocal,
  } = deps;

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
      if (!def.resumable) continue;
      if (def.barcode === s || def.code === code || def.code === s) return def;
    }
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

  function isResumableStopReason(reason) {
    const r = normalizeStopReason(reason);
    return r === 'break' || r === 'lunch' || r === 'qa_qc' || r === 'maintenance';
  }

  function sessionStatusLabelFromRow(row) {
    if (!row) return 'Idle';
    const status = String(row.status || '').toLowerCase();
    if (status === 'running') return 'Running';
    if (status === 'finished') return 'Completed';
    if (status === 'stopped') {
      const reason = normalizeStopReason(row.stop_reason);
      if (reason === 'break') return 'Paused - Break';
      if (reason === 'lunch') return 'Paused - Lunch';
      if (reason === 'end_shift') return 'Paused - End Shift';
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

  async function fetchTankPhaseTimeSummary(tankId) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT ms.id, ms.activity_code, ms.activity_name, ms.status, ms.started_at, ms.stopped_at, ms.finished_at
       FROM machine_sessions ms
       WHERE ms.tank_id = $1
       ORDER BY ms.started_at ASC, ms.id ASC`,
      [tid]
    );
    const productionPhases = WINDING_PHASES.filter((p) => !p.completes);
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
      for (const s of phaseSessions) totalMs += sessionElapsedMs(s);
      const hasRunning = phaseSessions.some((s) => s.status === 'running');
      const hasPaused = phaseSessions.some((s) => s.status === 'stopped');
      const hasFinished = phaseSessions.some((s) => s.status === 'finished');
      let status = 'not_started';
      if (hasRunning) status = 'running';
      else if (hasPaused) status = 'paused';
      else if (hasFinished || totalMs > 0) status = 'completed';

      const dur = formatDurationSummary(totalMs);
      let summaryLine = `${p.label}: not started`;
      if (status === 'running') summaryLine = `${p.label}: ${dur} running`;
      else if (status === 'paused') summaryLine = `${p.label}: ${dur} paused`;
      else if (status === 'completed') summaryLine = `${p.label}: ${dur} completed`;

      return {
        phase_code: p.code,
        phase_name: p.label,
        status,
        status_label: sessionStatusLabel(status === 'not_started' ? null : status),
        total_duration_ms: totalMs,
        total_duration_display: dur,
        summary_line: summaryLine,
        session_count: phaseSessions.length,
        counts_toward_tank_total: isTankTotalRunningPhaseCode(p.code),
      };
    });
  }

  async function getMachineById(id) {
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, active FROM machines WHERE id = $1 LIMIT 1`,
      [Number(id)]
    );
    return rows[0] || null;
  }

  async function getMachineByCode(code) {
    const c = normalizeMachineBarcode(code);
    if (!c) return null;
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, active FROM machines
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
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active FROM machines
       WHERE LOWER(TRIM(kiosk_slug)) = $1 LIMIT 1`,
      [s]
    );
    return rows[0] || null;
  }

  async function getMachineByAreaName(areaName) {
    const canonical = normalizeWindingMachineAreaName(areaName);
    if (!canonical || !isWindingMachineAreaName(canonical)) return null;
    const slug = slugFromMachineName(canonical);
    const spec = WINDING_MACHINES.find((m) => m.areaName === canonical);
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active FROM machines
       WHERE active = 1 AND (
         name = $1 OR LOWER(TRIM(kiosk_slug)) = $2 OR ($3::text IS NOT NULL AND code = $3)
       ) LIMIT 1`,
      [canonical, slug, spec ? spec.code : null]
    );
    return rows[0] || null;
  }

  async function getTeamByBarcode(barcode) {
    const bc = normalizeTeamBarcode(barcode);
    if (!bc) return null;
    const { rows } = await pool.query(
      `SELECT id, name, barcode, active FROM teams WHERE UPPER(TRIM(barcode)) = $1 LIMIT 1`,
      [bc]
    );
    return rows[0] || null;
  }

  async function getOpenSession(machineId) {
    const { rows } = await pool.query(
      `SELECT ms.*,
              t.name AS team_name, t.barcode AS team_barcode,
              tk.tank_number,
              m.name AS machine_name, m.code AS machine_code, m.barcode AS machine_barcode
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.machine_id = $1 AND ms.status IN ('running', 'stopped')
       ORDER BY ms.started_at DESC, ms.id DESC LIMIT 1`,
      [machineId]
    );
    return rows[0] || null;
  }

  /**
   * Daily team-to-machine assignment. A team is assigned to a machine for the
   * current workday only. It is cleared on End Shift and expires overnight.
   */
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
      alert_type: row.alert_type,
      alert_code: row.alert_code,
      alert_label: typeDef ? typeDef.label : row.alert_code,
      css_class: typeDef ? typeDef.css_class : 'alert-qa',
      status: row.status,
      reported_at: row.reported_at,
      resolved_at: row.resolved_at || null,
      resolved_by: row.resolved_by || null,
      notes: row.notes || null,
      email_status: row.email_status || null,
      email_error: row.email_error || null,
      email_sent_at: row.email_sent_at || null,
      resolve_email_status: row.resolve_email_status || null,
      resolve_email_error: row.resolve_email_error || null,
      resolve_email_sent_at: row.resolve_email_sent_at || null,
    };
  }

  async function fetchActiveWindingMachines() {
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active
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

  async function fetchManagedWindingMachines() {
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active
       FROM machines
       WHERE NOT (
         UPPER(TRIM(COALESCE(code, ''))) LIKE 'WS-%'
         OR name ILIKE 'Winding Station%'
       )
       ORDER BY sort_order ASC, name ASC`
    );
    return rows;
  }

  async function fetchCanonicalWindingMachines() {
    return fetchActiveWindingMachines();
  }

  async function buildDashboardCards() {
    const machines = await fetchCanonicalWindingMachines();
    const cards = [];
    for (const m of machines) {
      const session = await getOpenSession(m.id);
      const mapped = session ? await mapSession(session) : null;
      const labor = session ? await computeSessionLaborForRow(session) : null;
      const phaseTimeSummary =
        session && session.tank_id ? await fetchTankPhaseTimeSummary(Number(session.tank_id)) : [];
      const openAlerts = await fetchOpenAlertsForMachine(m.id);
      const assignment = await getMachineAssignment(m.id);
      const currentTeam = mapped ? mapped.team_name : assignment ? assignment.team_name : null;
      cards.push({
        id: Number(m.id),
        name: displayMachineName(m.name),
        slug: String(m.kiosk_slug || slugFromMachineName(m.name)).toLowerCase(),
        kiosk_url: kioskUrlForSlug(m.kiosk_slug || slugFromMachineName(m.name)),
        current_team: currentTeam,
        assigned_team: assignment ? assignment.team_name : null,
        current_tank: mapped ? mapped.tank_number : null,
        current_phase: mapped ? mapped.phase_name : null,
        status: mapped ? mapped.status : assignment ? 'assigned' : 'idle',
        status_label: mapped ? mapped.status_label : assignment ? 'Team Assigned' : 'Idle',
        started_at: mapped ? mapped.started_at : null,
        elapsed_display: mapped ? mapped.elapsed_display : '—',
        running_time_display: mapped ? mapped.running_time_display : '—',
        session_id: mapped ? mapped.id : null,
        tank_id: mapped ? mapped.tank_id : null,
        estimated_labor_cost: labor ? labor.total_estimated_cost : null,
        phase_time_summary: phaseTimeSummary,
        tank_total_running_time_ms: computeTankTotalRunningMs(phaseTimeSummary),
        tank_total_running_time_display: tankTotalRunningTimeDisplay(phaseTimeSummary),
        finished_tanks_today: await countFinishedToday(m.id),
        open_alerts: openAlerts,
        session: mapped,
      });
    }
    return cards;
  }

  async function startSession(machine, { teamBarcode, team: teamArg, tankNumber, phaseRaw }) {
    const existing = await getOpenSession(machine.id);
    if (existing) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'session_active', message: 'Machine already has an active session.' },
      };
    }
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
    if (phase.completes) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'validation', message: 'Scan Part Complete during an active session to finish.' },
      };
    }
    const tankRow = await ensureTankExists(tankNorm);
    if (tankRow && normalizeTankStatus(tankRow.status) === 'archived') {
      return {
        ok: false,
        status: 403,
        body: { ok: false, error: 'tank_archived', message: 'Tank is completed. Restore before use.' },
      };
    }
    const ts = nowIso();
    await pool.query(
      `UPDATE tanks
       SET status = 'active',
           paused_reason = NULL,
           wip_team_id = $1,
           wip_phase_code = $2,
           wip_phase_name = $3,
           wip_machine_id = $4,
           updated_at = $5::timestamptz
       WHERE id = $6`,
      [team.id, phase.code, phase.label, machine.id, ts, tankRow.id]
    );
    const insertRes = await pool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'running',$6::timestamptz,$6::timestamptz,$6::timestamptz)
       RETURNING id`,
      [machine.id, team.id, tankRow.id, phase.code, phase.label, ts]
    );
    const sessionId = insertRes.rows[0] ? Number(insertRes.rows[0].id) : null;
    if (sessionId) await snapshotSessionTeamMembers(sessionId, team.id);
    const session = await getOpenSession(machine.id);
    return { ok: true, body: { ok: true, action: 'start', session: await mapSession(session) } };
  }

  async function changePhase(machine, phaseRaw) {
    const session = await getOpenSession(machine.id);
    if (!session) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No active session.' } };
    }
    const phase = resolvePhase(phaseRaw);
    if (!phase) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Unknown phase.' } };
    }
    if (phase.completes) {
      return finishSession(machine);
    }
    const ts = nowIso();
    if (session.activity_code === phase.code && session.status === 'running') {
      await finalizeSessionBeforeTransition(session, ts);
      const newSession = await spawnContinuationSession(session, phase, ts);
      return { ok: true, body: { ok: true, action: 'change_phase', session: await mapSession(newSession) } };
    }
    await finalizeSessionBeforeTransition(session, ts);
    const newSession = await spawnContinuationSession(session, phase, ts);
    return { ok: true, body: { ok: true, action: 'change_phase', session: await mapSession(newSession) } };
  }

  async function finishSession(machine, opts = {}) {
    const session = await getOpenSession(machine.id);
    if (!session) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No active session to complete.' } };
    }
    const ts = nowIso();
    const endTs = session.status === 'stopped' && session.stopped_at ? session.stopped_at : ts;
    await pool.query(
      `UPDATE machine_sessions SET status = 'finished', finished_at = $1::timestamptz, updated_at = $2::timestamptz WHERE id = $3`,
      [endTs, ts, session.id]
    );
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
    const { rows } = await pool.query(
      `SELECT ms.*, t.name AS team_name, t.barcode AS team_barcode, tk.tank_number,
              m.name AS machine_name, m.code AS machine_code
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN tanks tk ON tk.id = ms.tank_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.id = $1`,
      [session.id]
    );
    const finishedRow = rows[0];
    const teamName = finishedRow ? finishedRow.team_name : null;
    const confirmedByEmployeeId =
      opts && opts.confirmedByEmployeeId != null ? Number(opts.confirmedByEmployeeId) : null;
    const confirmedByEmployeeName =
      opts && opts.confirmedByEmployeeName != null ? String(opts.confirmedByEmployeeName).trim() : null;
    if (finishedRow) {
      try {
        await pool.query(
          `INSERT INTO part_complete_events
             (session_id, tank_id, team_id, team_name, confirmed_by_employee_id, confirmed_by_employee_name, completed_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz)`,
          [
            Number(finishedRow.id),
            Number(finishedRow.tank_id),
            Number(finishedRow.team_id),
            teamName,
            Number.isInteger(confirmedByEmployeeId) && confirmedByEmployeeId > 0 ? confirmedByEmployeeId : null,
            confirmedByEmployeeName || null,
            ts,
          ]
        );
      } catch (err) {
        console.error('[finishSession] part_complete_events insert failed:', err.message);
        throw err;
      }
    }
    const confirmationLine =
      confirmedByEmployeeName && teamName
        ? `${confirmedByEmployeeName} confirmed Part Complete for ${teamName}`
        : confirmedByEmployeeName
          ? `${confirmedByEmployeeName} confirmed Part Complete`
          : teamName
            ? `Part Complete recorded for ${teamName}`
            : 'Part Complete recorded';
    return {
      ok: true,
      body: {
        ok: true,
        action: 'part_complete',
        session: await mapSession(finishedRow),
        confirmation_line: confirmationLine,
        team_name: teamName,
        confirmed_by_employee_name: confirmedByEmployeeName || null,
      },
    };
  }

  async function createAlert(machine, alertRaw, sessionOptional) {
    const alertDef = resolveAlert(alertRaw);
    if (!alertDef) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Unknown alert barcode.' } };
    }
    const session = sessionOptional || (machine ? await getOpenSession(machine.id) : null);
    const ts = nowIso();
    if (session && session.status === 'running') {
      await stopSessionForWait(session, ts, alertDef.alert_type);
    }
    const { rows } = await pool.query(
      `INSERT INTO alert_events
         (machine_id, team_id, tank_id, session_id, alert_type, alert_code, status, reported_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7::timestamptz,$7::timestamptz)
       RETURNING id`,
      [
        machine ? machine.id : session ? session.machine_id : null,
        session ? session.team_id : null,
        session ? session.tank_id : null,
        session ? session.id : null,
        alertDef.alert_type,
        alertDef.code,
        ts,
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
    return { ok: true, body: { ok: true, action: 'alert', alert: mapAlertRow(full[0]) } };
  }

  async function resolveAlertById(id, resolvedBy) {
    const ts = nowIso();
    const { rows } = await pool.query(
      `UPDATE alert_events SET status = 'resolved', resolved_at = $1::timestamptz, resolved_by = $2
       WHERE id = $3 AND status = 'open'
       RETURNING id`,
      [ts, resolvedBy || null, Number(id)]
    );
    if (!rows.length) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Alert not found or already resolved.' } };
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
    return { ok: true, body: { ok: true, id: Number(rows[0].id), alert: mapAlertRow(full[0]) } };
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
    return {
      tank_number: sessionRows[0] ? sessionRows[0].tank_number : normalized,
      sessions,
      alerts: alertRows.map(mapAlertRow),
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
      const pause = resolvePauseReason(s);
      if (pause) return { type: 'pause', value: pause.barcode };
    }
    if (s.startsWith('REASON:') || s.startsWith('REASON_')) {
      const endShift = resolveEndShift(s);
      if (endShift) return { type: 'end_shift', value: endShift.barcode };
    }
    if (s.startsWith('PHASE:') || s.startsWith('PHASE_') || s.startsWith('ACTIVITY:')) {
      return { type: 'phase', value: s };
    }
    if (s.startsWith('ALERT:') || s.startsWith('ALERT_')) return { type: 'alert', value: s };
    const endShift = resolveEndShift(s);
    if (endShift) return { type: 'end_shift', value: endShift.barcode };
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
    const machines = await fetchCanonicalWindingMachines();
    const productionByTeamId = new Map();
    for (const m of machines) {
      const session = await getOpenSession(m.id);
      if (!session) continue;
      const mapped = await mapSession(session);
      const labor = await computeSessionLaborForRow(session);
      const phaseTimeSummary = await fetchTankPhaseTimeSummary(Number(session.tank_id));
      productionByTeamId.set(Number(session.team_id), {
        machine_id: Number(m.id),
        machine_name: displayMachineName(m.name),
        tank_number: mapped.tank_number,
        tank_id: mapped.tank_id,
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
      });
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
      if (!Number.isInteger(teamId) || teamId <= 0 || productionByTeamId.has(teamId) || pausedWipByTeamId.has(teamId)) {
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
      const prod = productionByTeamId.get(tid) || null;
      const wip = !prod ? pausedWipByTeamId.get(tid) || null : null;
      const activeMembers = members.filter((m) => m.active);
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
      cards.push({
        id: tid,
        name: t.name,
        barcode: t.barcode,
        active: Number(t.active) !== 0,
        member_count: activeMembers.length,
        members,
        current_machine: machineName,
        current_tank: prod ? prod.tank_number : wip ? wip.tank_number : null,
        current_phase: prod ? prod.phase_name : wip ? wip.wip_phase_name || wip.wip_phase_code : null,
        status: prod ? prod.status : wip ? 'paused' : 'idle',
        status_label: prod ? prod.status_label : wip ? wipStatusLabel : 'Idle',
        elapsed_display: prod ? prod.elapsed_display : '—',
        running_time_display: prod ? prod.running_time_display : '—',
        started_at: prod ? prod.started_at : null,
        session_id: prod ? prod.session_id : null,
        tank_id: prod ? prod.tank_id : wip ? Number(wip.id) : null,
        estimated_labor_cost: prod ? prod.estimated_labor_cost : null,
        phase_time_summary: phaseTimeSummary,
        tank_total_running_time_ms: computeTankTotalRunningMs(phaseTimeSummary),
        tank_total_running_time_display: tankTotalRunningTimeDisplay(phaseTimeSummary),
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

  function buildSessionLaborBreakdown(sessionRow, memberSnapshots) {
    const hours = roundHours2(sessionElapsedMs(sessionRow) / 3600000);
    const members = memberSnapshots.map((m) => ({
      employee_id: m.employee_id,
      employee_code: m.employee_code,
      employee_name: m.employee_name,
      hourly_rate: m.hourly_rate,
      hours,
      estimated_cost: roundMoney(hours * m.hourly_rate),
    }));
    const totalEstimatedCost = roundMoney(members.reduce((sum, m) => sum + m.estimated_cost, 0));
    return {
      duration_hours: hours,
      duration_display: formatElapsedDisplay(sessionElapsedMs(sessionRow)),
      member_count: members.length,
      members,
      total_estimated_cost: totalEstimatedCost,
    };
  }

  async function computeSessionLaborForRow(sessionRow) {
    if (!sessionRow) return null;
    const members = await fetchSessionMemberSnapshots(Number(sessionRow.id));
    return buildSessionLaborBreakdown(sessionRow, members);
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

  async function finalizeSessionBeforeTransition(sessionRow, ts) {
    if (!sessionRow || sessionRow.status === 'finished') return;
    const id = Number(sessionRow.id);
    if (sessionRow.status === 'stopped' && sessionRow.stopped_at) {
      await pool.query(
        `UPDATE machine_sessions SET status = 'finished', finished_at = stopped_at, updated_at = $1::timestamptz WHERE id = $2`,
        [ts, id]
      );
    } else {
      await pool.query(
        `UPDATE machine_sessions SET status = 'finished', finished_at = $1::timestamptz, updated_at = $1::timestamptz WHERE id = $2`,
        [ts, id]
      );
    }
  }

  async function stopSessionForWait(sessionRow, ts, stopReason) {
    if (!sessionRow || sessionRow.status !== 'running') return;
    await pool.query(
      `UPDATE machine_sessions SET status = 'stopped', stopped_at = $1::timestamptz, stop_reason = $2, updated_at = $1::timestamptz WHERE id = $3`,
      [ts, stopReason || null, Number(sessionRow.id)]
    );
  }

  async function pauseSession(machine, pauseRaw) {
    const pauseDef = resolvePauseReason(pauseRaw);
    if (!pauseDef) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Unknown pause barcode.' } };
    }
    const session = await getOpenSession(machine.id);
    if (!session) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No active session to pause.' } };
    }
    if (session.status !== 'running') {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'not_running', message: 'Session is already paused.' },
      };
    }
    const ts = nowIso();
    await stopSessionForWait(session, ts, pauseDef.stop_reason);
    const updated = await getSessionById(Number(session.id));
    return {
      ok: true,
      body: {
        ok: true,
        action: 'pause',
        pause_reason: pauseDef.stop_reason,
        session: await mapSession(updated),
      },
    };
  }

  async function resumeSession(machine) {
    const session = await getOpenSession(machine.id);
    if (!session) {
      return { ok: false, status: 409, body: { ok: false, error: 'no_session', message: 'No paused session to resume.' } };
    }
    if (session.status !== 'stopped') {
      return { ok: false, status: 409, body: { ok: false, error: 'not_paused', message: 'Session is not paused.' } };
    }
    if (!isResumableStopReason(session.stop_reason)) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'not_resumable',
          message: 'This pause cannot be resumed. Scan team and tank to continue production.',
        },
      };
    }
    const ts = nowIso();
    const priorMs = sessionElapsedMs(session);
    const newStartedAt = new Date(Date.now() - priorMs).toISOString();
    await pool.query(
      `UPDATE machine_sessions
       SET status = 'running',
           started_at = $1::timestamptz,
           stopped_at = NULL,
           resumed_at = $2::timestamptz,
           stop_reason = NULL,
           updated_at = $2::timestamptz
       WHERE id = $3`,
      [newStartedAt, ts, Number(session.id)]
    );
    const updated = await getSessionById(Number(session.id));
    return { ok: true, body: { ok: true, action: 'resume', session: await mapSession(updated) } };
  }

  async function endShiftSession(machine) {
    const session = await getOpenSession(machine.id);
    if (!session) {
      const assignment = await getMachineAssignment(machine.id);
      await clearMachineAssignment(machine.id);
      return {
        ok: true,
        body: {
          ok: true,
          action: 'end_shift',
          tank_number: null,
          phase_name: null,
          team_name: assignment ? assignment.team_name : null,
          status_label: 'Shift ended',
        },
      };
    }
    const ts = nowIso();
    await finalizeSessionBeforeTransition(session, ts);
    await pool.query(
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
    await clearMachineAssignment(Number(session.machine_id));
    return {
      ok: true,
      body: {
        ok: true,
        action: 'end_shift',
        tank_number: session.tank_number,
        phase_name: session.activity_name,
        team_name: session.team_name,
        status_label: 'Paused - End Shift',
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
      `SELECT id, tank_number, status, paused_reason, wip_team_id, wip_phase_code, wip_phase_name, wip_machine_id
       FROM tanks
       WHERE UPPER(TRIM(tank_number)) = $1 AND LOWER(TRIM(COALESCE(status, ''))) = 'paused'
       LIMIT 1`,
      [norm]
    );
    return rows[0] || null;
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
    });
    if (!start.ok) return start;
    return { ok: true, body: { ok: true, action: 'resume', resumed_phase: phase.label, session: start.body.session } };
  }

  async function spawnContinuationSession(prevSessionRow, phase, ts) {
    const insertRes = await pool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'running',$6::timestamptz,$6::timestamptz,$6::timestamptz)
       RETURNING id`,
      [
        Number(prevSessionRow.machine_id),
        Number(prevSessionRow.team_id),
        Number(prevSessionRow.tank_id),
        phase.code,
        phase.label,
        ts,
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
      `SELECT tm.id, tm.employee_id, e.code AS employee_code, e.name AS employee_name, e.hourly_rate
       FROM team_members tm
       JOIN employees e ON e.id = tm.employee_id
       WHERE tm.team_id = $1 AND tm.active = 1 AND tm.employee_id IS NOT NULL`,
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
          Number(m.id),
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
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0 || !bounds) return 0;
    const { rows } = await pool.query(
      `SELECT ms.started_at, ms.finished_at, ms.stopped_at, ms.status
       FROM session_team_members stm
       INNER JOIN machine_sessions ms ON ms.id = stm.session_id
       WHERE stm.employee_id = $1`,
      [id]
    );
    let total = 0;
    for (const row of rows) {
      total += sessionMsInBounds(row, bounds, closeMs);
    }
    return total;
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
        total_estimated_labor_cost: 0,
        phases: [],
        phase_time_summary,
        member_breakdown: [],
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
      const phaseGroup = phaseMap.get(phaseKey);
      phaseGroup.sessions.push({
        id: Number(row.id),
        team_name: row.team_name,
        machine_name: displayMachineName(row.machine_name),
        phase_name: row.activity_name,
        phase_code: row.activity_code,
        started_at: row.started_at,
        finished_at: row.finished_at || null,
        ended_at: endTs,
        status: row.status,
        status_label: sessionStatusLabelFromRow(row),
        duration_hours: labor.duration_hours,
        duration_display: labor.duration_display,
        total_estimated_cost: labor.total_estimated_cost,
        members: labor.members,
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

    return {
      total_hours: roundHours2(totalHours),
      total_estimated_labor_cost: roundMoney(totalEstimatedCost),
      phases,
      phase_time_summary,
      member_breakdown,
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
    getMachineAssignment,
    assignTeamToMachine,
    clearMachineAssignment,
    fetchTeamPausedWip,
    getPausedTankByNumber,
    resumePausedTank,
    mapSession,
    fetchActiveWindingMachines,
    fetchManagedWindingMachines,
    fetchCanonicalWindingMachines,
    buildDashboardCards,
    buildTeamDashboardCards,
    fetchAllOpenAlerts,
    startSession,
    changePhase,
    finishSession,
    pauseSession,
    resumeSession,
    endShiftSession,
    createAlert,
    resolveAlertById,
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
};
