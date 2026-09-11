'use strict';

/**
 * Phase 2 — Assembly + Testing business logic (tank-level, no pieces).
 *
 * Schema expectations (migrated via phase2-schema-sql.js):
 *   machines.workflow TEXT DEFAULT 'winding'  -- 'winding' | 'assembly_testing'
 *   tanks: fab_completed_at, assembly_started_at, assembly_completed_at,
 *          testing_started_at, testing_completed_at, requires_test,
 *          assembly_machine_id, testing_machine_id, testing_confirmed_at
 *   stage_labor_sessions / stage_labor_participants / test_attempts
 *
 * Business rules:
 *   FAB Tank Complete → ready_for_assembly + fab_completed_at; NOT archived; NOT completed_at
 *   CONFIRM TANK → assembly_in_progress (Assembly Duration); NOT labor
 *   Assembly Complete:
 *     requires_test=true  → ready_for_testing (eligible for Testing dropdown only — NOT auto-confirmed)
 *     requires_test=false → ready_for_dome_install (skip Testing)
 *   CONFIRM TEST → testing_machine_id (QA selects tank); status stays ready_for_testing until START TESTING
 *   Testing PASS → testing_completed_at + ready_for_dome_install (NOT archived / NOT completed_at)
 *   Testing FAIL → insert test_attempts row; status ready_for_testing; allow correction/retest
 *   Manager Complete Tank → archived + completed_at (final factory completion / ready to ship)
 *   START/STOP WORK manage stage labor only; Tank Duration freezes at Assembly FINISH
 *   Team assign does NOT start labor
 *   Same employee cannot have two open stage_labor_participants rows
 *   Only requires_test=true tanks may enter Testing
 *   Testing never creates production labor
 */

const ASSEMBLY_STATUSES = Object.freeze({
  READY_FOR_ASSEMBLY: 'ready_for_assembly',
  ASSEMBLY_IN_PROGRESS: 'assembly_in_progress',
  READY_FOR_TESTING: 'ready_for_testing',
  TESTING_IN_PROGRESS: 'testing_in_progress',
  READY_FOR_DOME_INSTALL: 'ready_for_dome_install',
  /** @deprecated alias — normalize to ready_for_dome_install */
  READY_FOR_FINAL_COMPLETION: 'ready_for_dome_install',
  ARCHIVED: 'archived',
});

const POST_ASSEMBLY_READY_STATUSES = Object.freeze([
  ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL,
  'ready_for_final_completion', // historical rows
]);

const STAGE_CODES = Object.freeze({
  ASSEMBLY: 'ASSEMBLY',
  TESTING: 'TESTING',
  CORRECTION: 'CORRECTION',
});

const ELIGIBLE_LIST_STATUSES = Object.freeze([
  ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY,
  ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS,
  ASSEMBLY_STATUSES.READY_FOR_TESTING,
  ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
]);

const STAGE_ELIGIBLE_STATUSES = Object.freeze({
  // ASSEMBLY labor requires CONFIRM TANK first (status = assembly_in_progress).
  [STAGE_CODES.ASSEMBLY]: [ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS],
  [STAGE_CODES.TESTING]: [
    ASSEMBLY_STATUSES.READY_FOR_TESTING,
    ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
  ],
  [STAGE_CODES.CORRECTION]: [
    ASSEMBLY_STATUSES.READY_FOR_TESTING,
    ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
  ],
});

const TANK_SELECT_CORE =
  `id, tank_number, status, description, first_scanned_at, completed_at,
   fab_completed_at, assembly_started_at, assembly_completed_at,
   testing_started_at, testing_completed_at, assembly_machine_id,
   testing_machine_id, testing_confirmed_at,
   requires_test, created_at, updated_at, deleted_at`;

function formatDurationXhYm(ms) {
  const totalMin = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (totalMin < 1) return '0h 0m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function toMs(value) {
  if (value == null || value === '') return null;
  const n = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(n) ? null : n;
}

function tankRequiresTest(row) {
  if (!row) return false;
  const v = row.requires_test;
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true' || v === 'yes';
}

function normalizeStageCode(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/^STAGE[:_]/, '')
    .replace(/^PHASE[:_]/, '');
  if (s === 'ASSEMBLY' || s === 'ASM') return STAGE_CODES.ASSEMBLY;
  if (s === 'TESTING' || s === 'TEST') return STAGE_CODES.TESTING;
  if (s === 'CORRECTION' || s === 'CORRECTIONS' || s === 'CORRECT') return STAGE_CODES.CORRECTION;
  return null;
}

function normalizeAssemblyTankStatus(raw) {
  const s = String(raw == null || raw === '' ? '' : raw)
    .trim()
    .toLowerCase();
  if (!s) return '';
  if (s === 'archived' || s === 'completed') return ASSEMBLY_STATUSES.ARCHIVED;
  if (s === 'ready_for_assembly' || s === 'ready-for-assembly') return ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY;
  if (s === 'assembly_in_progress' || s === 'assembly-in-progress') {
    return ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS;
  }
  if (s === 'ready_for_testing' || s === 'ready-for-testing') return ASSEMBLY_STATUSES.READY_FOR_TESTING;
  if (s === 'testing_in_progress' || s === 'testing-in-progress') {
    return ASSEMBLY_STATUSES.TESTING_IN_PROGRESS;
  }
  if (
    s === 'ready_for_dome_install' ||
    s === 'ready-for-dome-install' ||
    s === 'ready_for_final_completion' ||
    s === 'ready-for-final-completion' ||
    s === 'ready_to_ship' ||
    s === 'final_ready'
  ) {
    return ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL;
  }
  return s;
}

function normalizeTestResult(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase();
  if (s === 'PASS' || s === 'PASSED' || s === 'OK') return 'PASS';
  if (s === 'FAIL' || s === 'FAILED' || s === 'NG') return 'FAIL';
  return null;
}

function errResult(status, error, message, extra = {}) {
  return {
    ok: false,
    status,
    body: { ok: false, error, message, ...extra },
  };
}

function okResult(body, status = 200) {
  return { ok: true, status, body: { ok: true, ...body } };
}

function createPhase2AssemblyTesting(pool, helpers = {}) {
  const nowIso = helpers.nowIso || (() => new Date().toISOString());
  const normalizeTankNumber =
    helpers.normalizeTankNumber ||
    ((raw) =>
      String(raw == null ? '' : raw)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ''));
  const localDateString =
    helpers.localDateString ||
    ((d = new Date()) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    });
  const formatDurationSummary = helpers.formatDurationSummary || formatDurationXhYm;

  const getTeamByBarcode = helpers.getTeamByBarcode;
  const listOpenShiftEmployeesForTeam = helpers.listOpenShiftEmployeesForTeam;
  const startTeamShiftMemberships = helpers.startTeamShiftMemberships;
  let getMachineAssignment = helpers.getMachineAssignment;
  let assignTeamToMachineFn = helpers.assignTeamToMachine;

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      // Roll back on structured API errors so partial writes never commit.
      if (result && result.ok === false) {
        await client.query('ROLLBACK');
        return result;
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackErr) {
        /* ignore */
      }
      if (err && err.apiResult) return err.apiResult;
      throw err;
    } finally {
      client.release();
    }
  }

  async function defaultGetMachineAssignment(machineId) {
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

  async function defaultAssignTeamToMachine(machineId, team) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0 || !team) return null;
    const ts = nowIso();
    const today = localDateString();
    await pool.query(
      `UPDATE machines
       SET assigned_team_id = $1, assigned_team_day = $2, assigned_team_at = $3::timestamptz,
           updated_at = $3::timestamptz
       WHERE id = $4`,
      [Number(team.id), today, ts, mid]
    );
    if (typeof startTeamShiftMemberships === 'function') {
      await startTeamShiftMemberships(Number(team.id), {
        at: ts,
        source: 'team_scan',
        reason: 'Assembly kiosk team scan — shift start',
      });
    }
    return {
      team_id: Number(team.id),
      team_name: team.name,
      team_barcode: team.barcode,
      assigned_at: ts,
      assigned_day: today,
    };
  }

  if (typeof getMachineAssignment !== 'function') {
    getMachineAssignment = defaultGetMachineAssignment;
  }
  if (typeof assignTeamToMachineFn !== 'function') {
    assignTeamToMachineFn = defaultAssignTeamToMachine;
  }

  async function listOpenShiftEmployeesLocal(teamId) {
    if (typeof listOpenShiftEmployeesForTeam === 'function') {
      return listOpenShiftEmployeesForTeam(teamId);
    }
    const tid = Number(teamId);
    if (!Number.isInteger(tid) || tid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT e.id, e.code, e.name, COALESCE(NULLIF(TRIM(tm.role), ''), 'Operator') AS role, m.joined_at
       FROM employee_team_memberships m
       JOIN employees e ON e.id = m.employee_id
       LEFT JOIN team_members tm
         ON tm.team_id = m.team_id AND tm.employee_id = m.employee_id AND tm.active = 1
       WHERE m.team_id = $1 AND m.left_at IS NULL AND e.is_active = 1
       ORDER BY LOWER(e.name) ASC, e.id ASC`,
      [tid]
    );
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        code: r.code || null,
        name: r.name,
        role: r.role || 'Operator',
        joined_at: r.joined_at,
      });
    }
    return out;
  }

  async function getTankById(tankId, client = pool) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return null;
    const { rows } = await client.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE id = $1`,
      [tid]
    );
    return rows[0] || null;
  }

  async function getMachineRow(machineId, client = pool) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return null;
    const { rows } = await client.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active, workflow,
              assigned_team_id, assigned_team_day, assigned_team_at, active_tank_id
       FROM machines
       WHERE id = $1`,
      [mid]
    );
    return rows[0] || null;
  }

  function computeTankDurationMs(tankRow, closeMs = Date.now()) {
    if (!tankRow) return 0;
    const startMs = toMs(tankRow.first_scanned_at) || toMs(tankRow.created_at);
    if (startMs == null) return 0;
    // Production Total Running Time freezes permanently at Assembly FINISH.
    // Testing / QA time must never extend this clock.
    const assemblyDoneMs = toMs(tankRow.assembly_completed_at);
    if (assemblyDoneMs != null) {
      return Math.max(0, assemblyDoneMs - startMs);
    }
    const status = normalizeAssemblyTankStatus(tankRow.status);
    if (status === ASSEMBLY_STATUSES.ARCHIVED) {
      const endMs = toMs(tankRow.completed_at) || closeMs;
      return Math.max(0, endMs - startMs);
    }
    return Math.max(0, closeMs - startMs);
  }

  function computeAssemblyDurationMs(tankRow, closeMs = Date.now()) {
    if (!tankRow) return 0;
    const startMs = toMs(tankRow.assembly_started_at);
    if (startMs == null) return 0;
    const endMs = toMs(tankRow.assembly_completed_at) || closeMs;
    return Math.max(0, endMs - startMs);
  }

  /** QA/QC elapsed only — never production duration / labor. */
  function computeTestingElapsedMs(tankRow, closeMs = Date.now()) {
    if (!tankRow) return 0;
    const startMs = toMs(tankRow.testing_started_at);
    if (startMs == null) return 0;
    const completedMs = toMs(tankRow.testing_completed_at);
    if (completedMs != null) return Math.max(0, completedMs - startMs);
    const status = normalizeAssemblyTankStatus(tankRow.status);
    if (status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS) {
      return Math.max(0, closeMs - startMs);
    }
    return 0;
  }

  function mapTankSummary(row, laborSummary = null) {
    if (!row) return null;
    const status = normalizeAssemblyTankStatus(row.status);
    const durationMs = computeTankDurationMs(row);
    const assemblyDurationMs = computeAssemblyDurationMs(row);
    const testingElapsedMs = computeTestingElapsedMs(row);
    const requiresTest = tankRequiresTest(row);
    return {
      id: Number(row.id),
      tank_number: row.tank_number,
      status,
      description: row.description || '',
      requires_test: requiresTest,
      first_scanned_at: row.first_scanned_at || null,
      fab_completed_at: row.fab_completed_at || null,
      assembly_started_at: row.assembly_started_at || null,
      assembly_completed_at: row.assembly_completed_at || null,
      testing_started_at: row.testing_started_at || null,
      testing_completed_at: row.testing_completed_at || null,
      assembly_machine_id: row.assembly_machine_id != null ? Number(row.assembly_machine_id) : null,
      testing_machine_id: row.testing_machine_id != null ? Number(row.testing_machine_id) : null,
      testing_confirmed_at: row.testing_confirmed_at || null,
      completed_at: row.completed_at || null,
      duration_ms: durationMs,
      duration_display: formatDurationXhYm(durationMs),
      duration_summary: formatDurationSummary(durationMs),
      assembly_duration_ms: assemblyDurationMs,
      assembly_duration_display: formatDurationXhYm(assemblyDurationMs),
      testing_elapsed_ms: testingElapsedMs,
      testing_elapsed_display: formatDurationXhYm(testingElapsedMs),
      labor: laborSummary || null,
    };
  }

  async function mapStageSession(row, client = pool) {
    if (!row) return null;
    const sid = Number(row.id);
    const { rows: parts } = await client.query(
      `SELECT id, session_id, employee_id, employee_code, employee_name, team_id, joined_at, left_at
       FROM stage_labor_participants
       WHERE session_id = $1
       ORDER BY joined_at ASC, id ASC`,
      [sid]
    );
    const startedMs = toMs(row.started_at);
    const endedMs = toMs(row.ended_at) || (row.status === 'active' ? Date.now() : startedMs);
    const elapsedMs = startedMs != null && endedMs != null ? Math.max(0, endedMs - startedMs) : 0;
    return {
      id: sid,
      tank_id: Number(row.tank_id),
      tank_number: row.tank_number || null,
      machine_id: Number(row.machine_id),
      team_id: row.team_id != null ? Number(row.team_id) : null,
      team_name: row.team_name || null,
      stage: row.stage,
      status: row.status,
      started_at: row.started_at,
      ended_at: row.ended_at || null,
      started_by_employee_id: row.started_by_employee_id != null ? Number(row.started_by_employee_id) : null,
      started_by_employee_name: row.started_by_employee_name || null,
      stopped_by_employee_id: row.stopped_by_employee_id != null ? Number(row.stopped_by_employee_id) : null,
      stopped_by_employee_name: row.stopped_by_employee_name || null,
      notes: row.notes || null,
      elapsed_ms: elapsedMs,
      elapsed_display: formatDurationXhYm(elapsedMs),
      participants: parts.map((p) => ({
        id: Number(p.id),
        employee_id: Number(p.employee_id),
        employee_code: p.employee_code || null,
        employee_name: p.employee_name || null,
        team_id: p.team_id != null ? Number(p.team_id) : null,
        joined_at: p.joined_at,
        left_at: p.left_at || null,
        open: p.left_at == null,
      })),
    };
  }

  async function getActiveSessionForTank(tankId, machineIdOptional, client = pool) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return null;
    const params = [tid];
    let machineClause = '';
    if (machineIdOptional != null) {
      params.push(Number(machineIdOptional));
      machineClause = ` AND sls.machine_id = $${params.length}`;
    }
    const { rows } = await client.query(
      `SELECT sls.*, tk.tank_number, t.name AS team_name
       FROM stage_labor_sessions sls
       JOIN tanks tk ON tk.id = sls.tank_id
       LEFT JOIN teams t ON t.id = sls.team_id
       WHERE sls.tank_id = $1 AND sls.status = 'active'${machineClause}
       ORDER BY sls.started_at DESC, sls.id DESC
       LIMIT 1`,
      params
    );
    return rows[0] || null;
  }

  async function getActiveSessionsForMachine(machineId, client = pool) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return [];
    const { rows } = await client.query(
      `SELECT sls.*, tk.tank_number, t.name AS team_name
       FROM stage_labor_sessions sls
       JOIN tanks tk ON tk.id = sls.tank_id
       LEFT JOIN teams t ON t.id = sls.team_id
       WHERE sls.machine_id = $1 AND sls.status = 'active'
       ORDER BY sls.started_at ASC, sls.id ASC`,
      [mid]
    );
    return rows;
  }

  async function getSessionById(sessionId, client = pool) {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) return null;
    const { rows } = await client.query(
      `SELECT sls.*, tk.tank_number, t.name AS team_name
       FROM stage_labor_sessions sls
       JOIN tanks tk ON tk.id = sls.tank_id
       LEFT JOIN teams t ON t.id = sls.team_id
       WHERE sls.id = $1`,
      [sid]
    );
    return rows[0] || null;
  }

  /**
   * End an active stage labor session and leave all open participants.
   * statusTarget: 'stopped' | 'finished'
   */
  async function closeStageSession(sessionRow, ts, opts = {}, client = pool) {
    if (!sessionRow || sessionRow.status !== 'active') return null;
    const sid = Number(sessionRow.id);
    const statusTarget = opts.statusTarget === 'finished' ? 'finished' : 'stopped';
    await client.query(
      `UPDATE stage_labor_sessions
       SET status = $1,
           ended_at = $2::timestamptz,
           stopped_by_employee_id = $3,
           stopped_by_employee_name = $4,
           notes = COALESCE($5, notes),
           updated_at = $2::timestamptz
       WHERE id = $6 AND status = 'active'`,
      [
        statusTarget,
        ts,
        opts.employeeId != null ? Number(opts.employeeId) : null,
        opts.employeeName || null,
        opts.notes != null ? String(opts.notes).slice(0, 2000) : null,
        sid,
      ]
    );
    await client.query(
      `UPDATE stage_labor_participants
       SET left_at = $1::timestamptz
       WHERE session_id = $2 AND left_at IS NULL`,
      [ts, sid]
    );
    return getSessionById(sid, client);
  }

  async function findOpenParticipationConflicts(employeeIds, client = pool) {
    const ids = (Array.isArray(employeeIds) ? employeeIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return [];
    const { rows } = await client.query(
      `SELECT p.employee_id, p.employee_name, p.session_id, s.tank_id, s.machine_id, s.stage,
              tk.tank_number, m.name AS machine_name
       FROM stage_labor_participants p
       JOIN stage_labor_sessions s ON s.id = p.session_id
       JOIN tanks tk ON tk.id = s.tank_id
       JOIN machines m ON m.id = s.machine_id
       WHERE p.left_at IS NULL
         AND p.employee_id = ANY($1::bigint[])
         AND s.status = 'active'`,
      [ids]
    );
    return rows;
  }

  async function resolveRosterForMachine(machine, client = pool) {
    const assignment = await getMachineAssignment(machine.id);
    if (!assignment || !assignment.team_id) {
      return { assignment: null, employees: [], teamId: null, teamName: null };
    }
    const employees = await listOpenShiftEmployeesLocal(assignment.team_id);
    return {
      assignment,
      employees,
      teamId: assignment.team_id,
      teamName: assignment.team_name,
    };
  }

  /**
   * FAB Tank Complete path: mark tank ready for assembly.
   * Does NOT archive, does NOT set completed_at.
   * Does NOT assign assembly_machine_id / assembly_started_at (CONFIRM TANK owns that).
   * Tank Duration continues.
   */
  async function releaseTankFromFab(tankId, opts = {}) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tid, client);
      if (!tank) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      if (tank.deleted_at) {
        return errResult(403, 'tank_deleted', 'Tank is in trash and cannot be released to assembly.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(409, 'tank_archived', 'Tank is already archived; FAB release refused.', {
          tank_id: tid,
          status,
        });
      }
      if (status === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY && tank.fab_completed_at) {
        // Ensure unassigned even if a prior bug left assembly ownership set.
        if (tank.assembly_machine_id != null || tank.assembly_started_at != null) {
          await client.query(
            `UPDATE tanks
             SET assembly_machine_id = NULL,
                 assembly_started_at = NULL,
                 updated_at = $1::timestamptz
             WHERE id = $2
               AND LOWER(TRIM(status)) = 'ready_for_assembly'`,
            [opts.at || nowIso(), tid]
          );
        }
        return okResult({
          action: 'release_fab',
          already_released: true,
          tank: mapTankSummary(await getTankById(tid, client)),
        });
      }
      // Already past FAB into assembly/testing — treat as no-op success if fab_completed_at set.
      if (
        tank.fab_completed_at &&
        (status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS ||
          status === ASSEMBLY_STATUSES.READY_FOR_TESTING ||
          status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS ||
          status === ASSEMBLY_STATUSES.READY_FOR_FINAL_COMPLETION)
      ) {
        return okResult({
          action: 'release_fab',
          already_released: true,
          tank: mapTankSummary(tank),
        });
      }

      const ts = opts.at || nowIso();
      await client.query(
        `UPDATE tanks
         SET status = $1,
             fab_completed_at = COALESCE(fab_completed_at, $2::timestamptz),
             completed_at = NULL,
             assembly_started_at = NULL,
             assembly_machine_id = NULL,
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY, ts, tid]
      );
      try {
        await client.query(
          `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz WHERE active_tank_id = $2`,
          [ts, tid]
        );
      } catch (_err) {
        /* ignore */
      }
      const updated = await getTankById(tid, client);
      return okResult({
        action: 'release_fab',
        already_released: false,
        tank: mapTankSummary(updated),
        message: 'Tank released to Assembly (unassigned). Confirm on an Assembly kiosk to start Assembly Duration.',
      });
    });
  }

  /**
   * Dropdown candidates: FAB-complete, unassigned, not owned by another Assembly kiosk.
   * Does NOT include tanks already confirmed on any kiosk (those appear under Confirmed).
   */
  async function listEligibleTanksForAssembly(opts = {}) {
    const forDropdown = opts.forDropdown === true;
    const machineId = opts.machineId != null ? Number(opts.machineId) : null;
    let sql;
    let params;
    if (forDropdown) {
      // Only unassigned ready_for_assembly tanks. Never auto-include confirmed tanks.
      sql = `SELECT ${TANK_SELECT_CORE}
             FROM tanks
             WHERE deleted_at IS NULL
               AND LOWER(TRIM(status)) = 'ready_for_assembly'
               AND assembly_machine_id IS NULL
               AND assembly_started_at IS NULL
               AND completed_at IS NULL
             ORDER BY tank_number ASC`;
      params = [];
    } else {
      sql = `SELECT ${TANK_SELECT_CORE}
             FROM tanks
             WHERE deleted_at IS NULL
               AND LOWER(TRIM(status)) = ANY($1::text[])
             ORDER BY
               CASE LOWER(TRIM(status))
                 WHEN 'testing_in_progress' THEN 1
                 WHEN 'assembly_in_progress' THEN 2
                 WHEN 'ready_for_testing' THEN 3
                 WHEN 'ready_for_assembly' THEN 4
                 ELSE 5
               END,
               tank_number ASC`;
      params = [ELIGIBLE_LIST_STATUSES];
    }
    const { rows } = await pool.query(sql, params);
    const out = [];
    for (const row of rows) {
      // Extra guard: never list another kiosk's confirmed tank in the dropdown.
      if (forDropdown && row.assembly_machine_id != null) {
        if (machineId == null || Number(row.assembly_machine_id) !== machineId) continue;
      }
      const labor = await computeStageLaborForTank(Number(row.id));
      out.push(mapTankSummary(row, labor));
    }
    return out;
  }

  /**
   * Assembly section only — tanks still in active Assembly on this kiosk.
   * Ready for Testing / Testing / Dome Install are NOT shown here.
   */
  function isAssemblyConfirmedTank(row) {
    if (!row || row.deleted_at) return false;
    return normalizeAssemblyTankStatus(row.status) === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS;
  }

  /**
   * Testing section only — QA must have CONFIRM TEST'd on this kiosk.
   */
  function isTestingConfirmedTank(row) {
    if (!row || row.deleted_at) return false;
    if (!tankRequiresTest(row)) return false;
    const status = normalizeAssemblyTankStatus(row.status);
    return (
      status === ASSEMBLY_STATUSES.READY_FOR_TESTING ||
      status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS
    );
  }

  /** @deprecated use isAssemblyConfirmedTank / isTestingConfirmedTank */
  function isKioskActionableTank(row) {
    return isAssemblyConfirmedTank(row) || isTestingConfirmedTank(row);
  }

  /**
   * Confirmed for Assembly on THIS kiosk (assembly_in_progress only).
   */
  async function listConfirmedTanksForAssembly(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE deleted_at IS NULL
         AND assembly_machine_id = $1
         AND assembly_started_at IS NOT NULL
         AND LOWER(TRIM(status)) = $2
       ORDER BY tank_number ASC`,
      [mid, ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS]
    );
    const out = [];
    for (const row of rows) {
      if (!isAssemblyConfirmedTank(row)) continue;
      const labor = await computeStageLaborForTank(Number(row.id));
      const sessionRow = await getActiveSessionForTank(Number(row.id), mid);
      const stageUpper = sessionRow ? String(sessionRow.stage || '').toUpperCase() : '';
      const activeSession =
        sessionRow && stageUpper === STAGE_CODES.ASSEMBLY
          ? await mapStageSession(sessionRow)
          : sessionRow && stageUpper === STAGE_CODES.CORRECTION
            ? await mapStageSession(sessionRow)
            : null;
      out.push({
        ...mapTankSummary(row, labor),
        active_session: activeSession,
        confirmed: true,
        section: 'assembly',
      });
    }
    return out;
  }

  /**
   * Testing dropdown — Assembly finished, requires_test, not yet CONFIRM TEST'd.
   */
  async function listEligibleTanksForTesting(opts = {}) {
    const machineId = opts.machineId != null ? Number(opts.machineId) : null;
    const { rows } = await pool.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE deleted_at IS NULL
         AND COALESCE(requires_test, FALSE) = TRUE
         AND LOWER(TRIM(status)) = $1
         AND assembly_completed_at IS NOT NULL
         AND completed_at IS NULL
         AND testing_completed_at IS NULL
         AND testing_machine_id IS NULL
       ORDER BY tank_number ASC`,
      [ASSEMBLY_STATUSES.READY_FOR_TESTING]
    );
    const out = [];
    for (const row of rows) {
      if (!tankRequiresTest(row)) continue;
      if (row.testing_machine_id != null) continue;
      const labor = await computeStageLaborForTank(Number(row.id));
      out.push({
        ...mapTankSummary(row, labor),
        section: 'testing_eligible',
      });
    }
    return out;
  }

  /**
   * Testing on this kiosk — after CONFIRM TEST (testing_machine_id = this machine).
   */
  async function listConfirmedTanksForTesting(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return [];
    const statuses = [
      ASSEMBLY_STATUSES.READY_FOR_TESTING,
      ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
    ];
    const { rows } = await pool.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE deleted_at IS NULL
         AND COALESCE(requires_test, FALSE) = TRUE
         AND testing_machine_id = $1
         AND LOWER(TRIM(status)) = ANY($2::text[])
         AND completed_at IS NULL
       ORDER BY
         CASE LOWER(TRIM(status))
           WHEN 'testing_in_progress' THEN 1
           WHEN 'ready_for_testing' THEN 2
           ELSE 3
         END,
         tank_number ASC`,
      [mid, statuses]
    );
    const out = [];
    for (const row of rows) {
      if (!isTestingConfirmedTank(row)) continue;
      const labor = await computeStageLaborForTank(Number(row.id));
      const sessionRow = await getActiveSessionForTank(Number(row.id), mid);
      const stageUpper = sessionRow ? String(sessionRow.stage || '').toUpperCase() : '';
      // Only CORRECTION production labor may show as active in Testing section.
      const activeSession =
        sessionRow && stageUpper === STAGE_CODES.CORRECTION
          ? await mapStageSession(sessionRow)
          : null;
      out.push({
        ...mapTankSummary(row, labor),
        active_session: activeSession,
        confirmed: true,
        testing_confirmed: true,
        section: 'testing',
      });
    }
    return out;
  }

  /**
   * @deprecated Prefer listConfirmedTanksForAssembly — kept for callers that expect
   * a combined list. Returns assembly confirmed only (Testing is separate).
   */
  async function listConfirmedTanksForMachine(machineId) {
    return listConfirmedTanksForAssembly(machineId);
  }

  /**
   * CONFIRM TANK — enter tank into Assembly on this kiosk.
   * Starts Assembly Duration (assembly_started_at) once; NEVER resets it.
   * Does NOT create stage_labor_session / labor.
   */
  async function confirmTank(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }

    return withTransaction(async (client) => {
      const machineRow = await getMachineRow(mid, client);
      if (!machineRow || Number(machineRow.active) === 0) {
        return errResult(404, 'machine_not_found', 'Machine not found or inactive.');
      }
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is completed/archived.');
      }
      if (
        status !== ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY &&
        status !== ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS
      ) {
        return errResult(
          409,
          'tank_status',
          `Tank status "${status}" cannot be confirmed for Assembly. Need ready_for_assembly or assembly_in_progress.`,
          { tank_status: status }
        );
      }

      const existingMachineId =
        tank.assembly_machine_id != null ? Number(tank.assembly_machine_id) : null;
      if (
        existingMachineId != null &&
        existingMachineId !== mid &&
        status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS
      ) {
        return errResult(
          409,
          'tank_on_other_kiosk',
          'Tank is already confirmed on another Assembly kiosk.',
          { assembly_machine_id: existingMachineId }
        );
      }

      const ts = opts.at || nowIso();
      const hadStarted = tank.assembly_started_at != null;

      // COALESCE protects assembly_started_at from reset on re-confirm / re-select.
      await client.query(
        `UPDATE tanks
         SET status = $1,
             assembly_started_at = COALESCE(assembly_started_at, $2::timestamptz),
             assembly_machine_id = $3,
             updated_at = $2::timestamptz
         WHERE id = $4`,
        [ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS, ts, mid, tankId]
      );

      try {
        await client.query(
          `UPDATE machines SET active_tank_id = $1, updated_at = $2::timestamptz WHERE id = $3`,
          [tankId, ts, mid]
        );
      } catch (_err) {
        /* ignore */
      }

      const updated = await getTankById(tankId, client);
      const labor = await computeStageLaborForTank(tankId);
      return okResult({
        action: 'confirm_tank',
        already_started: hadStarted,
        tank: mapTankSummary(updated, labor),
        message: hadStarted
          ? `Tank ${updated.tank_number} selected — Assembly Duration continues (not reset).`
          : `Tank ${updated.tank_number} confirmed — Assembly Duration started. Press START for labor.`,
      });
    });
  }

  /**
   * CONFIRM TEST — QA selects tank into Testing on this kiosk.
   * Does NOT start testing elapsed / testing_in_progress. Does NOT create labor.
   * Assembly FINISH only makes the tank available in the Testing dropdown.
   */
  async function confirmTest(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }

    return withTransaction(async (client) => {
      const machineRow = await getMachineRow(mid, client);
      if (!machineRow || Number(machineRow.active) === 0) {
        return errResult(404, 'machine_not_found', 'Machine not found or inactive.');
      }
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is completed/archived.');
      }
      if (!tankRequiresTest(tank)) {
        return errResult(
          409,
          'test_not_required',
          'This tank is not marked Require Test. It cannot be confirmed for Testing.',
          { requires_test: false }
        );
      }
      if (
        status !== ASSEMBLY_STATUSES.READY_FOR_TESTING &&
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS
      ) {
        return errResult(
          409,
          'tank_status',
          `Tank status "${status}" cannot be confirmed for Testing. Need ready_for_testing.`,
          { tank_status: status }
        );
      }
      if (!tank.assembly_completed_at) {
        return errResult(
          409,
          'assembly_not_finished',
          'Assembly must be finished before confirming Testing.'
        );
      }

      const existingTestMachine =
        tank.testing_machine_id != null ? Number(tank.testing_machine_id) : null;
      if (existingTestMachine != null && existingTestMachine !== mid) {
        return errResult(
          409,
          'tank_on_other_kiosk',
          'Tank is already confirmed for Testing on another kiosk.',
          { testing_machine_id: existingTestMachine }
        );
      }

      const ts = opts.at || nowIso();
      const already = existingTestMachine === mid;
      await client.query(
        `UPDATE tanks
         SET testing_machine_id = $1,
             testing_confirmed_at = COALESCE(testing_confirmed_at, $2::timestamptz),
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [mid, ts, tankId]
      );

      const updated = await getTankById(tankId, client);
      return okResult({
        action: 'confirm_test',
        already_confirmed: already,
        tank: mapTankSummary(updated),
        message: already
          ? `Tank ${updated.tank_number} already confirmed for Testing on this kiosk.`
          : `Tank ${updated.tank_number} confirmed for Testing. Press START TESTING when ready.`,
      });
    });
  }

  async function getMachineConfig(machineId) {
    const machine = await getMachineRow(machineId);
    if (!machine) {
      return errResult(404, 'machine_not_found', 'Machine not found.');
    }
    const assignment = await getMachineAssignment(machine.id);
    const activeRows = await getActiveSessionsForMachine(machine.id);
    const active_sessions = [];
    for (const row of activeRows) {
      active_sessions.push(await mapStageSession(row));
    }

    const eligible_tanks = await listEligibleTanksForAssembly({
      forDropdown: true,
      machineId: machine.id,
    });
    const assembly_confirmed_tanks = await listConfirmedTanksForAssembly(machine.id);
    const eligible_testing_tanks = await listEligibleTanksForTesting({
      machineId: machine.id,
    });
    const testing_confirmed_tanks = await listConfirmedTanksForTesting(machine.id);

    // Merge open ASSEMBLY labor only into assembly confirmed list.
    const asmSeen = new Set(assembly_confirmed_tanks.map((t) => Number(t.id)));
    for (const session of active_sessions) {
      const stage = String(session.stage || '').toUpperCase();
      if (stage !== STAGE_CODES.ASSEMBLY && stage !== STAGE_CODES.CORRECTION) continue;
      const tid = Number(session.tank_id);
      if (stage === STAGE_CODES.ASSEMBLY) {
        if (asmSeen.has(tid)) continue;
        const tank = await getTankById(tid);
        if (!tank || !isAssemblyConfirmedTank(tank)) continue;
        const ownedHere =
          tank.assembly_machine_id != null &&
          Number(tank.assembly_machine_id) === Number(machine.id);
        if (!ownedHere) continue;
        asmSeen.add(tid);
        const labor = await computeStageLaborForTank(tid);
        assembly_confirmed_tanks.push({
          ...mapTankSummary(tank, labor),
          active_session: session,
          confirmed: true,
          section: 'assembly',
        });
      } else if (stage === STAGE_CODES.CORRECTION) {
        // Correction labor attaches to testing confirmed cards when present.
        const idx = testing_confirmed_tanks.findIndex((t) => Number(t.id) === tid);
        if (idx >= 0 && !testing_confirmed_tanks[idx].active_session) {
          testing_confirmed_tanks[idx] = {
            ...testing_confirmed_tanks[idx],
            active_session: session,
          };
        }
      }
    }

    let roster = [];
    if (assignment && assignment.team_id) {
      roster = await listOpenShiftEmployeesLocal(assignment.team_id);
    }

    return okResult({
      machine: {
        id: Number(machine.id),
        name: machine.name,
        code: machine.code,
        barcode: machine.barcode || null,
        slug: machine.kiosk_slug,
        workflow: String(machine.workflow || 'winding').toLowerCase(),
        active: Number(machine.active) !== 0,
        active_tank_id: machine.active_tank_id != null ? Number(machine.active_tank_id) : null,
      },
      assignment,
      roster,
      eligible_tanks,
      eligible_testing_tanks,
      assembly_confirmed_tanks,
      testing_confirmed_tanks,
      // Backward-compatible aliases (Assembly only — Testing is separate).
      confirmed_tanks: assembly_confirmed_tanks,
      loaded_tanks: assembly_confirmed_tanks,
      active_labor_sessions: active_sessions,
    });
  }

  async function assignTeamToMachine(machineId, team) {
    let resolved = team;
    if (!resolved && arguments.length > 2) {
      // allow (machineId, null, barcode) style via helpers only — ignore
    }
    if (resolved && !resolved.id && resolved.barcode && typeof getTeamByBarcode === 'function') {
      resolved = await getTeamByBarcode(resolved.barcode);
    }
    if (!resolved || !resolved.id) {
      return errResult(400, 'validation', 'Team is required.');
    }
    // Assigning a team must NOT start stage labor.
    const assignment = await assignTeamToMachineFn(machineId, resolved);
    if (!assignment) {
      return errResult(400, 'assign_failed', 'Could not assign team to machine.');
    }
    return okResult({
      action: 'assign_team',
      assignment,
      message: 'Team assigned. Select a tank from the dropdown and press CONFIRM TANK, then START for labor.',
    });
  }

  async function startWork(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    const stage = normalizeStageCode(opts.stage);
    if (!stage) {
      return errResult(400, 'validation', 'stage must be ASSEMBLY or CORRECTION.');
    }
    if (stage === STAGE_CODES.TESTING) {
      return errResult(
        400,
        'validation',
        'Testing is QA/QC only. Use startTesting — it does not create production labor.'
      );
    }

    return withTransaction(async (client) => {
      const machineRow = await getMachineRow(mid, client);
      if (!machineRow || Number(machineRow.active) === 0) {
        return errResult(404, 'machine_not_found', 'Machine not found or inactive.');
      }

      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const tankStatus = normalizeAssemblyTankStatus(tank.status);
      if (tankStatus === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is completed/archived.');
      }
      const eligible = STAGE_ELIGIBLE_STATUSES[stage] || [];
      if (!eligible.includes(tankStatus)) {
        const hint =
          stage === STAGE_CODES.ASSEMBLY && tankStatus === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY
            ? ' Press CONFIRM TANK first to enter Assembly (starts Assembly Duration). Then START WORK for labor.'
            : '';
        return errResult(
          409,
          'tank_status',
          `Tank status "${tankStatus}" is not eligible for ${stage}.${hint}`,
          {
            tank_status: tankStatus,
            stage,
            eligible_statuses: eligible,
          }
        );
      }

      if (
        (stage === STAGE_CODES.TESTING || stage === STAGE_CODES.CORRECTION) &&
        !tankRequiresTest(tank)
      ) {
        return errResult(
          409,
          'test_not_required',
          'This tank is not marked Require Test. Testing is not available.',
          { requires_test: false }
        );
      }

      if (stage === STAGE_CODES.ASSEMBLY) {
        if (!tank.assembly_started_at) {
          return errResult(
            409,
            'not_confirmed',
            'Confirm the tank first. CONFIRM TANK starts Assembly Duration; START WORK starts labor.'
          );
        }
        const confirmMachine =
          tank.assembly_machine_id != null ? Number(tank.assembly_machine_id) : null;
        if (confirmMachine != null && confirmMachine !== mid) {
          return errResult(
            409,
            'tank_on_other_kiosk',
            'Tank is confirmed on another Assembly kiosk.',
            { assembly_machine_id: confirmMachine }
          );
        }
      }

      const existing = await getActiveSessionForTank(tankId, mid, client);
      if (existing) {
        return errResult(409, 'session_active', 'Tank already has an active stage labor session on this machine.', {
          session_id: Number(existing.id),
          stage: existing.stage,
        });
      }

      // One active stage session per tank globally (tank-level work).
      const anyActive = await getActiveSessionForTank(tankId, null, client);
      if (anyActive) {
        return errResult(409, 'session_active', 'Tank already has an active stage labor session.', {
          session_id: Number(anyActive.id),
          machine_id: Number(anyActive.machine_id),
          stage: anyActive.stage,
        });
      }

      const rosterInfo = await resolveRosterForMachine({ id: mid });
      if (!rosterInfo.teamId) {
        return errResult(409, 'no_team', 'Assign a team to this machine before starting work.');
      }
      const employees = Array.isArray(opts.employees) && opts.employees.length
        ? opts.employees
        : rosterInfo.employees;
      if (!employees.length) {
        return errResult(
          409,
          'no_roster',
          'No employees on shift for the assigned team. Team assign alone does not start labor.'
        );
      }

      const empIds = employees.map((e) => Number(e.id || e.employee_id)).filter((id) => id > 0);
      const conflicts = await findOpenParticipationConflicts(empIds, client);
      if (conflicts.length) {
        const names = conflicts.map((c) => c.employee_name || `Employee ${c.employee_id}`).join(', ');
        return errResult(409, 'employee_busy', `Employee(s) already in active stage labor: ${names}.`, {
          conflicts: conflicts.map((c) => ({
            employee_id: Number(c.employee_id),
            employee_name: c.employee_name,
            session_id: Number(c.session_id),
            tank_id: Number(c.tank_id),
            tank_number: c.tank_number,
            machine_id: Number(c.machine_id),
            machine_name: c.machine_name,
            stage: c.stage,
          })),
        });
      }

      const ts = opts.at || nowIso();
      const starter = opts.employee || opts.startedBy || null;
      const starterId = starter && (starter.id || starter.employee_id) != null
        ? Number(starter.id || starter.employee_id)
        : null;
      const starterName = starter ? starter.name || starter.employee_name || null : null;

      let nextStatus = tankStatus;
      if (stage === STAGE_CODES.ASSEMBLY) {
        nextStatus = ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS;
      } else if (stage === STAGE_CODES.TESTING) {
        nextStatus = ASSEMBLY_STATUSES.TESTING_IN_PROGRESS;
      }
      // CORRECTION: keep ready_for_testing (or current soft state) — labor only.
      // ASSEMBLY: never set/reset assembly_started_at here — CONFIRM TANK owns that.

      await client.query(
        `UPDATE tanks
         SET status = $1,
             testing_started_at = CASE
               WHEN $2::text = 'TESTING' THEN COALESCE(testing_started_at, $3::timestamptz)
               ELSE testing_started_at
             END,
             updated_at = $3::timestamptz
         WHERE id = $4`,
        [nextStatus, stage, ts, tankId]
      );

      const insertRes = await client.query(
        `INSERT INTO stage_labor_sessions
           (tank_id, machine_id, team_id, stage, status, started_at,
            started_by_employee_id, started_by_employee_name, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'active',$5::timestamptz,$6,$7,$8,$5::timestamptz,$5::timestamptz)
         RETURNING id`,
        [
          tankId,
          mid,
          rosterInfo.teamId,
          stage,
          ts,
          starterId,
          starterName,
          opts.notes != null ? String(opts.notes).slice(0, 2000) : null,
        ]
      );
      const sessionId = Number(insertRes.rows[0].id);

      for (const emp of employees) {
        const eid = Number(emp.id || emp.employee_id);
        if (!Number.isInteger(eid) || eid <= 0) continue;
        try {
          await client.query(
            `INSERT INTO stage_labor_participants
               (session_id, employee_id, employee_code, employee_name, team_id, joined_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
            [
              sessionId,
              eid,
              emp.code || emp.employee_code || null,
              emp.name || emp.employee_name || null,
              rosterInfo.teamId,
              ts,
            ]
          );
        } catch (insertErr) {
          // Unique partial index: one open participation per employee — force ROLLBACK.
          if (insertErr && insertErr.code === '23505') {
            const conflictErr = new Error(
              `Employee ${emp.name || eid} already has an active stage labor session.`
            );
            conflictErr.apiResult = errResult(409, 'employee_busy', conflictErr.message, {
              employee_id: eid,
            });
            throw conflictErr;
          }
          throw insertErr;
        }
      }

      try {
        await client.query(`UPDATE machines SET active_tank_id = $1, updated_at = $2::timestamptz WHERE id = $3`, [
          tankId,
          ts,
          mid,
        ]);
      } catch (_err) {
        /* active_tank_id may be winding-only in some DBs — ignore if missing handled by migrate */
      }

      const sessionRow = await getSessionById(sessionId, client);
      const session = await mapStageSession(sessionRow, client);
      const updatedTank = mapTankSummary(await getTankById(tankId, client));
      return okResult({
        action: 'start_work',
        stage,
        session,
        tank: updatedTank,
      });
    });
  }

  async function stopWork(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const tankId = opts.tankId != null ? Number(opts.tankId) : opts.tank_id != null ? Number(opts.tank_id) : null;
    const sessionId = opts.sessionId != null ? Number(opts.sessionId) : opts.session_id != null ? Number(opts.session_id) : null;

    return withTransaction(async (client) => {
      let sessionRow = null;
      if (Number.isInteger(sessionId) && sessionId > 0) {
        sessionRow = await getSessionById(sessionId, client);
        if (sessionRow && Number(sessionRow.machine_id) !== mid) {
          return errResult(409, 'wrong_machine', 'Session does not belong to this machine.');
        }
      } else if (Number.isInteger(tankId) && tankId > 0) {
        sessionRow = await getActiveSessionForTank(tankId, mid, client);
      } else {
        const rows = await getActiveSessionsForMachine(mid, client);
        if (rows.length === 1) sessionRow = rows[0];
        else if (rows.length > 1) {
          return errResult(409, 'need_tank', 'Multiple active sessions — specify tankId or sessionId.', {
            active_session_ids: rows.map((r) => Number(r.id)),
          });
        }
      }

      if (!sessionRow || sessionRow.status !== 'active') {
        return errResult(409, 'no_session', 'No active stage labor session to stop.');
      }

      const ts = opts.at || nowIso();
      const stopper = opts.employee || null;
      const closed = await closeStageSession(
        sessionRow,
        ts,
        {
          statusTarget: 'stopped',
          employeeId: stopper && (stopper.id || stopper.employee_id),
          employeeName: stopper && (stopper.name || stopper.employee_name),
          notes: opts.notes,
        },
        client
      );
      // Tank stays in_progress (assembly_in_progress / testing_in_progress); duration continues.
      const tank = await getTankById(Number(sessionRow.tank_id), client);
      return okResult({
        action: 'stop_work',
        session: await mapStageSession(closed, client),
        tank: mapTankSummary(tank),
      });
    });
  }

  async function assemblyComplete(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }

    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is already archived.');
      }
      if (status !== ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS) {
        return errResult(
          409,
          'tank_status',
          status === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY
            ? 'Confirm the tank first (CONFIRM TANK), then complete Assembly.'
            : `Cannot complete assembly from status "${status}".`,
          { tank_status: status }
        );
      }

      const ts = opts.at || nowIso();
      const active = await getActiveSessionForTank(tankId, mid, client);
      if (active && String(active.stage).toUpperCase() === STAGE_CODES.ASSEMBLY) {
        await closeStageSession(
          active,
          ts,
          {
            statusTarget: 'finished',
            employeeId: opts.employee && (opts.employee.id || opts.employee.employee_id),
            employeeName: opts.employee && (opts.employee.name || opts.employee.employee_name),
            notes: opts.notes || 'Assembly Complete',
          },
          client
        );
      } else if (active) {
        // Finish any other active session on this tank before advancing.
        await closeStageSession(active, ts, { statusTarget: 'finished', notes: 'Assembly Complete' }, client);
      }

      // End Assembly Duration at assembly_completed_at. Never reset assembly_started_at.
      // Route by requires_test: Testing vs Ready for Dome Install.
      const requiresTest = tankRequiresTest(tank);
      const nextStatus = requiresTest
        ? ASSEMBLY_STATUSES.READY_FOR_TESTING
        : ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL;
      await client.query(
        `UPDATE tanks
         SET status = $1,
             assembly_completed_at = COALESCE(assembly_completed_at, $2::timestamptz),
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [nextStatus, ts, tankId]
      );

      const updated = await getTankById(tankId, client);
      return okResult({
        action: 'assembly_complete',
        tank: mapTankSummary(updated),
        requires_test: requiresTest,
        message: requiresTest
          ? 'Assembly complete — ready for testing. Select the tank in Testing / QA-QC and press CONFIRM TEST. Production time frozen.'
          : 'Assembly complete — ready for Dome Install (no testing required). Removed from Assembly kiosk. Production time frozen.',
      });
    });
  }

  /**
   * START TESTING — QA/QC only. Requires CONFIRM TEST on this kiosk first.
   * Sets testing_in_progress + testing_started_at. Does NOT create stage_labor_session,
   * participants, LABOR ACTIVE, employee hours, or Total Running Time.
   */
  async function startTesting(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }

    return withTransaction(async (client) => {
      const machineRow = await getMachineRow(mid, client);
      if (!machineRow || Number(machineRow.active) === 0) {
        return errResult(404, 'machine_not_found', 'Machine not found or inactive.');
      }

      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is completed/archived.');
      }
      if (!tankRequiresTest(tank)) {
        return errResult(
          409,
          'test_not_required',
          'This tank is not marked Require Test. Testing is not available.',
          { requires_test: false }
        );
      }
      if (
        status !== ASSEMBLY_STATUSES.READY_FOR_TESTING &&
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS
      ) {
        return errResult(
          409,
          'tank_status',
          `Tank status "${status}" is not eligible for Testing. Need ready_for_testing.`,
          { tank_status: status }
        );
      }

      const testMachine =
        tank.testing_machine_id != null ? Number(tank.testing_machine_id) : null;
      if (testMachine == null) {
        return errResult(
          409,
          'not_confirmed_for_testing',
          'Confirm the tank for Testing first (CONFIRM TEST), then press START TESTING.'
        );
      }
      if (testMachine !== mid) {
        return errResult(409, 'tank_on_other_kiosk', 'Tank is confirmed for Testing on another kiosk.', {
          testing_machine_id: testMachine,
        });
      }

      // Close any legacy TESTING labor sessions — Testing must not count as production labor.
      const active = await getActiveSessionForTank(tankId, mid, client);
      if (active && String(active.stage || '').toUpperCase() === STAGE_CODES.TESTING) {
        await closeStageSession(
          active,
          opts.at || nowIso(),
          { statusTarget: 'stopped', notes: 'Closed: Testing is QA-only (no production labor).' },
          client
        );
      }

      const ts = opts.at || nowIso();
      await client.query(
        `UPDATE tanks
         SET status = $1,
             testing_started_at = COALESCE(testing_started_at, $2::timestamptz),
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [ASSEMBLY_STATUSES.TESTING_IN_PROGRESS, ts, tankId]
      );

      const updated = await getTankById(tankId, client);
      return okResult({
        action: 'start_testing',
        tank: mapTankSummary(updated),
        labor_created: false,
        message:
          'Testing started (QA/QC). No production labor session created. Tank Total Running Time unchanged.',
      });
    });
  }

  async function recordTestResult(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    const result = normalizeTestResult(opts.result);
    if (!result) {
      return errResult(400, 'validation', 'result must be PASS or FAIL.');
    }
    if (result === 'FAIL' && !(opts.note || opts.failure_note || opts.failureNote)) {
      // Note preferred but not strictly required — allow empty with warning in message.
    }

    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is already archived.');
      }
      if (
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS &&
        status !== ASSEMBLY_STATUSES.READY_FOR_TESTING
      ) {
        return errResult(409, 'tank_status', `Cannot record test from status "${status}".`, {
          tank_status: status,
        });
      }
      if (!tankRequiresTest(tank)) {
        return errResult(
          409,
          'test_not_required',
          'This tank is not marked Require Test. Testing results are not accepted.',
          { requires_test: false }
        );
      }

      const ts = opts.at || nowIso();
      const assignment = await getMachineAssignment(mid);
      const tester = opts.employee || opts.tester || null;
      const testerId = tester && (tester.id || tester.employee_id) != null
        ? Number(tester.id || tester.employee_id)
        : null;
      const testerName = tester ? tester.name || tester.employee_name || null : null;
      const note = opts.note || opts.failure_note || opts.failureNote || null;

      // Close legacy TESTING labor sessions if any (historical). Do not create labor.
      let laborSessionId = null;
      const active = await getActiveSessionForTank(tankId, mid, client);
      if (active && String(active.stage || '').toUpperCase() === STAGE_CODES.TESTING) {
        laborSessionId = Number(active.id);
        await closeStageSession(
          active,
          ts,
          {
            statusTarget: 'finished',
            employeeId: testerId,
            employeeName: testerName,
            notes: result === 'PASS' ? 'Testing PASS (legacy labor closed)' : 'Testing FAIL (legacy labor closed)',
          },
          client
        );
      }

      // Always INSERT — never overwrite historical attempts.
      const attemptRes = await client.query(
        `INSERT INTO test_attempts
           (tank_id, machine_id, team_id, team_name, result, attempted_at,
            tester_employee_id, tester_employee_name, failure_note, labor_session_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$6::timestamptz)
         RETURNING id, tank_id, result, attempted_at, failure_note`,
        [
          tankId,
          mid,
          assignment ? assignment.team_id : null,
          assignment ? assignment.team_name : null,
          result,
          ts,
          testerId,
          testerName,
          result === 'FAIL' && note ? String(note).slice(0, 4000) : note ? String(note).slice(0, 4000) : null,
          laborSessionId,
        ]
      );
      const attempt = attemptRes.rows[0];

      if (result === 'PASS') {
        // Testing PASS → Ready for Dome Install (NOT final factory completion).
        // Clear Testing kiosk confirmation so tank leaves Testing section + dropdown.
        await client.query(
          `UPDATE tanks
           SET status = $1,
               testing_completed_at = COALESCE(testing_completed_at, $2::timestamptz),
               testing_started_at = COALESCE(testing_started_at, $2::timestamptz),
               testing_machine_id = NULL,
               testing_confirmed_at = NULL,
               completed_at = NULL,
               updated_at = $2::timestamptz
           WHERE id = $3`,
          [ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL, ts, tankId]
        );
        try {
          await client.query(
            `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz
             WHERE id = $2 AND active_tank_id = $3`,
            [ts, mid, tankId]
          );
        } catch (_err) {
          /* ignore */
        }
      } else {
        // FAIL → ready_for_testing so correction then retest can start.
        await client.query(
          `UPDATE tanks
           SET status = $1,
               updated_at = $2::timestamptz
           WHERE id = $3`,
          [ASSEMBLY_STATUSES.READY_FOR_TESTING, ts, tankId]
        );
      }

      const updated = await getTankById(tankId, client);
      return okResult({
        action: 'test_result',
        result,
        attempt: {
          id: Number(attempt.id),
          tank_id: Number(attempt.tank_id),
          result: attempt.result,
          attempted_at: attempt.attempted_at,
          failure_note: attempt.failure_note || null,
          labor_session_id: laborSessionId,
        },
        tank: mapTankSummary(updated),
        message:
          result === 'PASS'
            ? 'Testing PASS — ready for Dome Install. Manager Complete Tank is still required for final completion.'
            : 'Testing FAIL recorded. Tank remains ready_for_testing for correction/retest.',
      });
    });
  }

  /**
   * Manager Dashboard "Complete Tank" — FINAL factory completion / ready to ship.
   * Distinct from Winding kiosk Tank Complete (FAB → Assembly).
   * Sets completed_at + archived. Tank Duration stops here.
   */
  async function finalizeTankCompletion(tankId, opts = {}) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }

    return withTransaction(async (client) => {
      const tank = await getTankById(tid, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return okResult({
          action: 'manager_complete_tank',
          already_completed: true,
          tank: mapTankSummary(tank),
          message: 'Tank is already completed / archived.',
        });
      }
      if (status !== ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL) {
        return errResult(
          409,
          'not_ready_for_final',
          'Complete Tank is final factory completion. Tank must be Ready for Dome Install first.',
          {
            tank_status: status,
            required_status: ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL,
          }
        );
      }

      const ts = opts.at || nowIso();

      // Close any lingering stage labor on this tank.
      const anyActive = await getActiveSessionForTank(tid, null, client);
      if (anyActive) {
        await closeStageSession(anyActive, ts, { statusTarget: 'finished', notes: 'Manager Complete Tank' }, client);
      }

      await client.query(
        `UPDATE tanks
         SET status = $1,
             completed_at = COALESCE(completed_at, $2::timestamptz),
             testing_completed_at = COALESCE(testing_completed_at, $2::timestamptz),
             assembly_machine_id = NULL,
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [ASSEMBLY_STATUSES.ARCHIVED, ts, tid]
      );

      try {
        await client.query(
          `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz
           WHERE active_tank_id = $2`,
          [ts, tid]
        );
      } catch (_err) {
        /* ignore */
      }

      const updated = await getTankById(tid, client);
      return okResult({
        action: 'manager_complete_tank',
        tank: mapTankSummary(updated),
        message: 'Tank completed — archived / ready to ship. Tank Duration stopped.',
      });
    });
  }

  async function startCorrection(machine, opts = {}) {
    return startWork(machine, { ...opts, stage: STAGE_CODES.CORRECTION });
  }

  async function employeeOutFromStage(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const employeeId = Number(opts.employeeId != null ? opts.employeeId : opts.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return errResult(400, 'validation', 'employeeId is required.');
    }

    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT p.id AS participant_id, p.session_id, p.employee_id, p.employee_name, p.joined_at,
                s.machine_id, s.tank_id, s.stage, s.status
         FROM stage_labor_participants p
         JOIN stage_labor_sessions s ON s.id = p.session_id
         WHERE p.employee_id = $1
           AND p.left_at IS NULL
           AND s.status = 'active'
           AND s.machine_id = $2
         ORDER BY p.joined_at DESC, p.id DESC
         LIMIT 1`,
        [employeeId, mid]
      );
      if (!rows.length) {
        return errResult(404, 'not_in_labor', 'Employee is not in an active stage labor session on this machine.');
      }
      const row = rows[0];
      const ts = opts.at || nowIso();
      await client.query(
        `UPDATE stage_labor_participants SET left_at = $1::timestamptz WHERE id = $2 AND left_at IS NULL`,
        [ts, Number(row.participant_id)]
      );

      // If no open participants remain, stop the session.
      const openRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM stage_labor_participants
         WHERE session_id = $1 AND left_at IS NULL`,
        [Number(row.session_id)]
      );
      let session = await getSessionById(Number(row.session_id), client);
      if (openRes.rows[0] && openRes.rows[0].n === 0 && session && session.status === 'active') {
        session = await closeStageSession(session, ts, { statusTarget: 'stopped', notes: 'All participants out' }, client);
      }

      return okResult({
        action: 'employee_out',
        employee_id: employeeId,
        session: await mapStageSession(session, client),
      });
    });
  }

  async function pauseStationLabor(machine, reason) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const reasonText = reason != null ? String(reason).trim() : 'pause';
    return withTransaction(async (client) => {
      const rows = await getActiveSessionsForMachine(mid, client);
      const ts = nowIso();
      const closed = [];
      for (const row of rows) {
        const updated = await closeStageSession(
          row,
          ts,
          { statusTarget: 'stopped', notes: reasonText.slice(0, 2000) },
          client
        );
        closed.push(await mapStageSession(updated, client));
      }
      return okResult({
        action: 'pause_station',
        reason: reasonText,
        stopped_sessions: closed,
        count: closed.length,
      });
    });
  }

  async function computeStageLaborForTank(tankId) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) {
      return { tank_id: tid, by_stage: [], by_employee: [], total_ms: 0, total_display: formatDurationXhYm(0) };
    }
    const { rows } = await pool.query(
      `SELECT s.id AS session_id, s.stage, s.status, s.started_at, s.ended_at,
              p.employee_id, p.employee_code, p.employee_name, p.joined_at, p.left_at
       FROM stage_labor_sessions s
       JOIN stage_labor_participants p ON p.session_id = s.id
       WHERE s.tank_id = $1
       ORDER BY p.joined_at ASC, p.id ASC`,
      [tid]
    );

    const closeMs = Date.now();
    const byEmployeeMap = new Map();
    const byStageMap = new Map();
    let totalMs = 0;

    for (const row of rows) {
      const joinMs = toMs(row.joined_at);
      if (joinMs == null) continue;
      const leaveMs = toMs(row.left_at) || (row.status === 'active' && row.left_at == null ? closeMs : toMs(row.ended_at) || closeMs);
      const ms = Math.max(0, leaveMs - joinMs);
      const stage = String(row.stage || '').toUpperCase();
      // TESTING is QA/QC only — never production labor totals.
      const isProductionLabor = stage === STAGE_CODES.ASSEMBLY || stage === STAGE_CODES.CORRECTION;

      if (!byStageMap.has(stage)) {
        byStageMap.set(stage, { stage, total_ms: 0, employees: new Map() });
      }
      const stageBucket = byStageMap.get(stage);
      stageBucket.total_ms += ms;
      const eid = Number(row.employee_id);
      const empKey = eid;
      if (!stageBucket.employees.has(empKey)) {
        stageBucket.employees.set(empKey, {
          employee_id: eid,
          employee_code: row.employee_code || null,
          employee_name: row.employee_name || null,
          total_ms: 0,
        });
      }
      stageBucket.employees.get(empKey).total_ms += ms;

      if (!isProductionLabor) continue;

      totalMs += ms;

      if (!byEmployeeMap.has(empKey)) {
        byEmployeeMap.set(empKey, {
          employee_id: eid,
          employee_code: row.employee_code || null,
          employee_name: row.employee_name || null,
          total_ms: 0,
          by_stage: {},
        });
      }
      const empBucket = byEmployeeMap.get(empKey);
      empBucket.total_ms += ms;
      empBucket.by_stage[stage] = (empBucket.by_stage[stage] || 0) + ms;
    }

    const by_stage = Array.from(byStageMap.values()).map((s) => ({
      stage: s.stage,
      total_ms: s.total_ms,
      total_display: formatDurationXhYm(s.total_ms),
      employees: Array.from(s.employees.values()).map((e) => ({
        ...e,
        total_display: formatDurationXhYm(e.total_ms),
      })),
    }));

    const by_employee = Array.from(byEmployeeMap.values()).map((e) => {
      const stages = {};
      for (const [k, v] of Object.entries(e.by_stage)) {
        stages[k] = { total_ms: v, total_display: formatDurationXhYm(v) };
      }
      return {
        employee_id: e.employee_id,
        employee_code: e.employee_code,
        employee_name: e.employee_name,
        total_ms: e.total_ms,
        total_display: formatDurationXhYm(e.total_ms),
        by_stage: stages,
      };
    });

    return {
      tank_id: tid,
      by_stage,
      by_employee,
      total_ms: totalMs,
      total_display: formatDurationXhYm(totalMs),
    };
  }

  async function buildAssemblyDashboardCards() {
    const { rows: machines } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active, workflow, active_tank_id
       FROM machines
       WHERE active = 1
         AND LOWER(TRIM(COALESCE(workflow, 'winding'))) = 'assembly_testing'
       ORDER BY sort_order ASC, name ASC, id ASC`
    );

    const cards = [];
    for (const m of machines) {
      const assignment = await getMachineAssignment(m.id);
      const activeRows = await getActiveSessionsForMachine(m.id);
      const active_sessions = [];
      for (const row of activeRows) {
        active_sessions.push(await mapStageSession(row));
      }

      let machineStatus = 'idle';
      let machineStatusLabel = 'Idle';
      if (active_sessions.length) {
        machineStatus = 'running';
        const n = active_sessions.length;
        machineStatusLabel = `${n} tank${n > 1 ? 's' : ''} in stage labor`;
      } else if (assignment) {
        machineStatus = 'assigned';
        machineStatusLabel = 'Team Assigned';
      }

      const tanks = [];
      const seen = new Set();
      for (const session of active_sessions) {
        const tid = Number(session.tank_id);
        if (seen.has(tid)) continue;
        seen.add(tid);
        const tank = await getTankById(tid);
        if (!tank) continue;
        const labor = await computeStageLaborForTank(tid);
        tanks.push({
          ...mapTankSummary(tank, labor),
          active_session: session,
        });
      }

      cards.push({
        id: Number(m.id),
        name: m.name,
        code: m.code,
        slug: m.kiosk_slug,
        workflow: 'assembly_testing',
        workflow_label: 'Assembly + Testing',
        current_team: assignment ? assignment.team_name : null,
        assigned_team: assignment ? assignment.team_name : null,
        assignment,
        status: machineStatus,
        status_label: machineStatusLabel,
        active_labor_sessions: active_sessions,
        tanks,
        active_tank_count: tanks.length,
      });
    }
    return cards;
  }

  async function listTestAttemptsForTank(tankId) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT id, tank_id, machine_id, team_id, team_name, result, attempted_at,
              tester_employee_id, tester_employee_name, failure_note, labor_session_id, created_at
       FROM test_attempts
       WHERE tank_id = $1
       ORDER BY attempted_at ASC, id ASC`,
      [tid]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      tank_id: Number(r.tank_id),
      machine_id: r.machine_id != null ? Number(r.machine_id) : null,
      team_id: r.team_id != null ? Number(r.team_id) : null,
      team_name: r.team_name || null,
      result: r.result,
      attempted_at: r.attempted_at,
      tester_employee_id: r.tester_employee_id != null ? Number(r.tester_employee_id) : null,
      tester_employee_name: r.tester_employee_name || null,
      failure_note: r.failure_note || null,
      labor_session_id: r.labor_session_id != null ? Number(r.labor_session_id) : null,
      created_at: r.created_at,
    }));
  }

  return {
    releaseTankFromFab,
    listEligibleTanksForAssembly,
    listEligibleTanksForTesting,
    listConfirmedTanksForMachine,
    listConfirmedTanksForAssembly,
    listConfirmedTanksForTesting,
    getMachineConfig,
    assignTeamToMachine,
    confirmTank,
    confirmTest,
    startWork,
    stopWork,
    assemblyComplete,
    startTesting,
    recordTestResult,
    finalizeTankCompletion,
    startCorrection,
    employeeOutFromStage,
    pauseStationLabor,
    computeStageLaborForTank,
    computeAssemblyDurationMs,
    computeTankDurationMs,
    computeTestingElapsedMs,
    buildAssemblyDashboardCards,
    formatDurationXhYm,
    listTestAttemptsForTank,
    normalizeStageCode,
    normalizeAssemblyTankStatus,
    getActiveSessionForTank,
    getActiveSessionsForMachine,
  };
}

module.exports = {
  createPhase2AssemblyTesting,
  ASSEMBLY_STATUSES,
  STAGE_CODES,
  ELIGIBLE_LIST_STATUSES,
  POST_ASSEMBLY_READY_STATUSES,
  formatDurationXhYm,
  tankRequiresTest,
  normalizeAssemblyTankStatus,
};
