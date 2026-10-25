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
 *   Assembly and Testing do NOT lock each other — the same tank may be worked concurrently.
 *     Independent labor, teams, and completion timestamps; QA/QC only when both required stages done.
 *   Assembly Complete (all assigned teams finished):
 *     requires_test=false → ready_for_qa
 *     requires_test=true + Testing already passed → ready_for_qa
 *     requires_test=true + Testing still in progress → keep testing_in_progress
 *     requires_test=true + Testing not started → ready_for_testing
 *   CONFIRM TEST / START TESTING may run while Assembly is still in progress (or before Assembly)
 *   Workflow order: FAB → Assembly / Testing (parallel OK) → QA/QC → Ready for Dome Install
 *     → Dome Install → Dome Installed (waiting) → Manager Complete Tank archives
 *   START TESTING → testing started (+ status testing_in_progress unless Assembly still owns status)
 *   One test per TESTING attempt (the other is locked once a test is started on that attempt)
 *   Vacuum START → RECORD END → Vacuum PASS/FAIL
 *   Brine START FILL → STOP FILL → Brine PASS/FAIL
 *     PASS (either) → testing work continues until READY FOR QA/QC
 *     FAIL (either) → testing_failed (FAILED/HOLD); RETEST or existing FAB rework
 *   READY FOR QA/QC → Testing PASS recorded; ready_for_qa only if Assembly is also done;
 *     otherwise keep assembly_in_progress / ready_for_assembly until Assembly finishes
 *   START QA → qa_in_progress; QA PASS → ready_for_dome_install; QA FAIL → qa_failed
 *   FAB Dome Install (after QA PASS) → dome_installed (waiting for next Fabrication phase / Complete Tank)
 *   Legacy: tanks the old order parked in ready_for_qa (untested, QA not started) list under
 *     Ready for Testing and may START TESTING; legacy qa_in_progress tanks → QA PASS → ready_for_testing
 *   RETEST from testing_failed → new TESTING attempt (select Vacuum or Brine again)
 *   SEND BACK TO FAB REWORK from testing_failed or qa_failed → existing rework_required FAB workflow
 *   RESTORE TO ASSEMBLY from any Testing / QA/QC status → ready_for_assembly (open attempts cancelled)
 *   FAB Tank Complete after rework_required → ready_for_testing (skip re-Assembly; requires_test stays true)
 *   Manager Complete Tank → archived + completed_at (final factory completion / ready to ship;
 *     allowed from ready_for_dome_install or dome_installed; Phase 3 may require a dome or override)
 *   START/STOP WORK manage stage labor only; Tank Duration freezes at Assembly FINISH
 *   Team assign does NOT start labor
 *   Same employee cannot have two open stage_labor_participants rows
 *   Only requires_test=true tanks may enter Testing
 *   Testing never creates production labor
 *   testing_failed still blocks new Assembly confirms (FAILED / HOLD) until Retest or FAB Rework
 */

const ASSEMBLY_STATUSES = Object.freeze({
  READY_FOR_ASSEMBLY: 'ready_for_assembly',
  ASSEMBLY_IN_PROGRESS: 'assembly_in_progress',
  READY_FOR_QA: 'ready_for_qa',
  QA_IN_PROGRESS: 'qa_in_progress',
  QA_FAILED: 'qa_failed',
  READY_FOR_TESTING: 'ready_for_testing',
  TESTING_IN_PROGRESS: 'testing_in_progress',
  TESTING_FAILED: 'testing_failed',
  READY_FOR_DOME_INSTALL: 'ready_for_dome_install',
  /** @deprecated alias — normalize to ready_for_dome_install */
  READY_FOR_FINAL_COMPLETION: 'ready_for_dome_install',
  /** Dome installed (Phase 3); tank stays active until the next phase / Manager Complete Tank. */
  DOME_INSTALLED: 'dome_installed',
  REWORK_REQUIRED: 'rework_required',
  /** Schedule change after CONFIRM TANK — not QA, not deleted, not complete. */
  REMOVED_FROM_ASSEMBLY: 'removed_from_assembly',
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
  QA: 'QA',
});

const TEST_TYPES = Object.freeze({
  LEGACY: 'LEGACY',
  QA: 'QA',
  TESTING: 'TESTING',
  VACUUM: 'VACUUM',
  BRINE: 'BRINE',
});

const ELIGIBLE_LIST_STATUSES = Object.freeze([
  ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY,
  ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS,
  ASSEMBLY_STATUSES.READY_FOR_QA,
  ASSEMBLY_STATUSES.QA_IN_PROGRESS,
  ASSEMBLY_STATUSES.QA_FAILED,
  ASSEMBLY_STATUSES.READY_FOR_TESTING,
  ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
  ASSEMBLY_STATUSES.TESTING_FAILED,
]);

const STAGE_ELIGIBLE_STATUSES = Object.freeze({
  // ASSEMBLY labor requires CONFIRM TANK first. Concurrent Testing may leave status as
  // testing_in_progress while assembly_started_at is set — still allow Assembly labor.
  [STAGE_CODES.ASSEMBLY]: [
    ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS,
    ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
  ],
  [STAGE_CODES.TESTING]: [
    ASSEMBLY_STATUSES.READY_FOR_TESTING,
    ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
    ASSEMBLY_STATUSES.TESTING_FAILED,
    ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS,
  ],
  [STAGE_CODES.CORRECTION]: [
    ASSEMBLY_STATUSES.READY_FOR_TESTING,
    ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
    ASSEMBLY_STATUSES.TESTING_FAILED,
    ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS,
    ASSEMBLY_STATUSES.QA_FAILED,
    ASSEMBLY_STATUSES.REWORK_REQUIRED,
  ],
});

const TANK_SELECT_CORE =
  `id, tank_number, status, description, first_scanned_at, completed_at,
   fab_completed_at, assembly_started_at, assembly_completed_at,
   testing_started_at, testing_completed_at, assembly_machine_id,
   assembly_team_id, testing_machine_id, testing_confirmed_at,
   requires_test, created_at, updated_at, deleted_at,
   qa_started_at, qa_completed_at, qa_machine_id, qa_result, qa_failure_note,
   qa_user_id, qa_user_name, assembly_removed_at, assembly_restored_at`;

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

/**
 * Assembly stage done for the current cycle. Restore to Assembly keeps assembly_completed_at
 * for history, so a restore at/after the finish means Assembly is pending again.
 */
function tankAssemblyDone(row) {
  if (!row || !row.assembly_completed_at) return false;
  const doneMs = toMs(row.assembly_completed_at);
  const restoredMs = toMs(row.assembly_restored_at);
  return restoredMs == null || doneMs == null || restoredMs < doneMs;
}

function tankTestingDone(row) {
  return Boolean(row && row.testing_completed_at);
}

/**
 * Testing work is open (started, not passed/failed-closed). Concurrent Assembly may own
 * tanks.status = assembly_in_progress while testing_started_at is set.
 */
function tankTestingWorkOpen(row) {
  if (!row || !tankRequiresTest(row) || tankTestingDone(row)) return false;
  const st = normalizeAssemblyTankStatus(row.status);
  if (st === ASSEMBLY_STATUSES.TESTING_FAILED) return false;
  if (st === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS) return true;
  return Boolean(row.testing_started_at);
}

/** Assembly confirmed and not finished (may share the tank with Testing). */
function tankAssemblyWorkOpen(row) {
  if (!row || tankAssemblyDone(row)) return false;
  const st = normalizeAssemblyTankStatus(row.status);
  // Concurrent path always sets status to assembly_in_progress while Assembly owns the tank.
  if (st === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS) return true;
  // Testing FAIL/HOLD after a concurrent start — Assembly may still finish this cycle.
  if (st === ASSEMBLY_STATUSES.TESTING_FAILED && row.assembly_machine_id != null) return true;
  return false;
}

/** Next tanks.status after Assembly fully finishes (all teams). */
function nextStatusAfterAssemblyComplete(tank) {
  const st = normalizeAssemblyTankStatus(tank && tank.status);
  if (st === ASSEMBLY_STATUSES.TESTING_FAILED) return ASSEMBLY_STATUSES.TESTING_FAILED;
  if (!tankRequiresTest(tank)) return ASSEMBLY_STATUSES.READY_FOR_QA;
  if (tankTestingDone(tank)) return ASSEMBLY_STATUSES.READY_FOR_QA;
  if (tankTestingWorkOpen(tank)) return ASSEMBLY_STATUSES.TESTING_IN_PROGRESS;
  return ASSEMBLY_STATUSES.READY_FOR_TESTING;
}

/**
 * Next tanks.status after Testing PASS / READY FOR QA/QC.
 * Does not clear Assembly ownership when Assembly is still working.
 */
function nextStatusAfterTestingPass(tank) {
  if (tankAssemblyDone(tank)) return ASSEMBLY_STATUSES.READY_FOR_QA;
  if (tankAssemblyWorkOpen(tank) || normalizeAssemblyTankStatus(tank.status) === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS) {
    return ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS;
  }
  return ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY;
}

/** SQL twin of !tankAssemblyDone (column names unqualified). */
const SQL_ASSEMBLY_NOT_DONE = `(assembly_completed_at IS NULL
  OR (assembly_restored_at IS NOT NULL AND assembly_restored_at >= assembly_completed_at))`;

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
  if (s === 'ready_for_qa' || s === 'ready-for-qa') return ASSEMBLY_STATUSES.READY_FOR_QA;
  if (s === 'qa_in_progress' || s === 'qa-in-progress') return ASSEMBLY_STATUSES.QA_IN_PROGRESS;
  if (s === 'qa_failed' || s === 'qa-failed') return ASSEMBLY_STATUSES.QA_FAILED;
  if (s === 'ready_for_testing' || s === 'ready-for-testing') return ASSEMBLY_STATUSES.READY_FOR_TESTING;
  if (s === 'testing_in_progress' || s === 'testing-in-progress') {
    return ASSEMBLY_STATUSES.TESTING_IN_PROGRESS;
  }
  if (s === 'testing_failed' || s === 'testing-failed' || s === 'test_failed') {
    return ASSEMBLY_STATUSES.TESTING_FAILED;
  }
  if (
    s === 'rework_required' ||
    s === 'returned_to_fab' ||
    s === 'fab_rework' ||
    s === 'rework'
  ) {
    return ASSEMBLY_STATUSES.REWORK_REQUIRED;
  }
  if (s === 'removed_from_assembly' || s === 'removed-from-assembly') {
    return ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY;
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

  /**
   * Multi-team Assembly presence — additive, does not close other teams.
   * Team scan opens/focuses a team card without replacing siblings.
   */
  async function ensureAssemblyKioskTeam(machineId, team, opts = {}) {
    const mid = Number(machineId);
    const tid = Number(team && (team.id || team.team_id));
    if (!Number.isInteger(mid) || mid <= 0 || !Number.isInteger(tid) || tid <= 0) {
      return errResult(400, 'validation', 'Machine and team are required.');
    }
    const ts = opts.at || nowIso();
    await closeStaleAssemblyMoves();
    const { rows: existing } = await pool.query(
      `SELECT akt.*, t.name AS team_name, t.barcode AS team_barcode
       FROM assembly_kiosk_teams akt
       JOIN teams t ON t.id = akt.team_id
       WHERE akt.machine_id = $1 AND akt.team_id = $2 AND akt.left_at IS NULL
       LIMIT 1`,
      [mid, tid]
    );
    if (existing.length) {
      // Keep machines.assigned_team_id as last-focused team for legacy helpers.
      await assignTeamToMachineFn(mid, {
        id: tid,
        name: existing[0].team_name,
        barcode: existing[0].team_barcode,
      });
      await keepAssemblyMovesAfterTeamScan(tid, ts);
      return okResult({
        action: 'team_present',
        already_present: true,
        team: {
          id: tid,
          name: existing[0].team_name,
          barcode: existing[0].team_barcode,
          status: existing[0].status || 'active',
          joined_at: existing[0].joined_at,
          lunch_paused_at: existing[0].lunch_paused_at || null,
        },
      });
    }
    await pool.query(
      `INSERT INTO assembly_kiosk_teams
         (machine_id, team_id, status, joined_at, created_at, updated_at)
       VALUES ($1,$2,'active',$3::timestamptz,$3::timestamptz,$3::timestamptz)`,
      [mid, tid, ts]
    );
    const assignment = await assignTeamToMachineFn(mid, team);
    await keepAssemblyMovesAfterTeamScan(tid, ts);
    return okResult({
      action: 'team_present',
      already_present: false,
      team: {
        id: tid,
        name: (team && team.name) || (assignment && assignment.team_name) || null,
        barcode: (team && team.barcode) || (assignment && assignment.team_barcode) || null,
        status: 'active',
        joined_at: ts,
        lunch_paused_at: null,
      },
      assignment,
    });
  }

  /**
   * Temporary Assembly team moves are shift memberships with this source.
   * team_members (the permanent/default roster) is never changed by a move.
   */
  const ASSEMBLY_MOVE_SOURCE = 'assembly_kiosk_move';

  /** A move only lasts for the shift it was made in — expire moves from earlier days. */
  async function closeStaleAssemblyMoves() {
    try {
      const { rows } = await pool.query(
        `SELECT id, joined_at FROM employee_team_memberships
         WHERE source = $1 AND left_at IS NULL`,
        [ASSEMBLY_MOVE_SOURCE]
      );
      const today = localDateString();
      const stale = rows
        .filter((r) => r.joined_at && localDateString(new Date(r.joined_at)) !== today)
        .map((r) => Number(r.id));
      if (!stale.length) return 0;
      const { rowCount } = await pool.query(
        `UPDATE employee_team_memberships
         SET left_at = NOW(), reason = COALESCE(reason, 'assembly_move_expired')
         WHERE id = ANY($1::bigint[]) AND left_at IS NULL`,
        [stale]
      );
      return rowCount || 0;
    } catch (err) {
      console.warn('[phase2] closeStaleAssemblyMoves:', err.message);
      return 0;
    }
  }

  /**
   * Team scan re-opens the default roster. An employee temporarily moved to
   * another Assembly team this shift must stay there — close the membership the
   * scan just opened on the default team (zero-length, no labor).
   */
  async function keepAssemblyMovesAfterTeamScan(teamId, scanTs) {
    try {
      await pool.query(
        `UPDATE employee_team_memberships m
         SET left_at = m.joined_at
         WHERE m.team_id = $1
           AND m.left_at IS NULL
           AND m.source = 'team_scan'
           AND m.joined_at >= $2::timestamptz
           AND EXISTS (
             SELECT 1 FROM employee_team_memberships o
             WHERE o.employee_id = m.employee_id
               AND o.left_at IS NULL
               AND o.team_id <> m.team_id
               AND o.source = $3
           )`,
        [Number(teamId), scanTs, ASSEMBLY_MOVE_SOURCE]
      );
    } catch (err) {
      console.warn('[phase2] keepAssemblyMovesAfterTeamScan:', err.message);
    }
  }

  /** End Shift: temporary moves INTO this team end; default rosters apply next shift. */
  async function endAssemblyTeamMoves(teamId, opts = {}) {
    const tid = Number(teamId);
    if (!Number.isInteger(tid) || tid <= 0) return { closed: 0 };
    const ts = opts.at || nowIso();
    const { rowCount } = await pool.query(
      `UPDATE employee_team_memberships
       SET left_at = $1::timestamptz, reason = COALESCE(reason, 'end_shift')
       WHERE team_id = $2 AND source = $3 AND left_at IS NULL`,
      [ts, tid, ASSEMBLY_MOVE_SOURCE]
    );
    return { closed: rowCount || 0 };
  }

  /**
   * Employee barcode on the Assembly kiosk: put the employee on the SELECTED
   * Assembly team for this shift. Moves them off any other Assembly team (no
   * duplicate), leaves their old team's labor and joins the new team's active
   * Assembly labor. Does not touch team_members (default team).
   *
   * The Dome Shop kiosk reuses this with opts.dome_kiosk = true: moves stay between
   * teams present on Dome kiosks, and opts.onMoved(client, ctx) moves dome labor in
   * the same transaction (return an error result to roll back, or extra body fields).
   */
  async function moveEmployeeToAssemblyTeam(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const domeKiosk = opts.dome_kiosk === true;
    const kioskLabel = domeKiosk ? 'Dome' : 'Assembly';
    const employeeId = Number(opts.employee_id != null ? opts.employee_id : opts.employeeId);
    const teamId = Number(opts.team_id != null ? opts.team_id : opts.teamId);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return errResult(400, 'validation', 'employee_id is required.');
    }
    if (!Number.isInteger(teamId) || teamId <= 0) {
      return errResult(409, 'need_team', `Select ${domeKiosk ? 'a Dome' : 'an Assembly'} team card first.`);
    }
    await closeStaleAssemblyMoves();

    return withTransaction(async (client) => {
      const { rows: empRows } = await client.query(
        `SELECT id, code, name, is_active FROM employees WHERE id = $1 FOR UPDATE`,
        [employeeId]
      );
      const emp = empRows[0];
      if (!emp) return errResult(404, 'not_found', 'Employee not found.');
      if (Number(emp.is_active) === 0) {
        return errResult(400, 'inactive_employee', 'That employee is inactive.');
      }
      const employee = { id: Number(emp.id), code: emp.code || null, name: emp.name };

      const { rows: teamRows } = await client.query(
        `SELECT t.id, t.name
         FROM assembly_kiosk_teams akt
         JOIN teams t ON t.id = akt.team_id
         WHERE akt.machine_id = $1 AND akt.team_id = $2 AND akt.left_at IS NULL
         LIMIT 1`,
        [mid, teamId]
      );
      if (!teamRows.length) {
        return errResult(409, 'team_not_on_kiosk', `The selected team is not on this ${kioskLabel} kiosk.`);
      }
      const destTeam = { id: Number(teamRows[0].id), name: teamRows[0].name };

      // Dome teams share assembly_kiosk_teams; moves never cross between Assembly and Dome kiosks.
      const { rows: openRows } = await client.query(
        `SELECT m.id, m.team_id, t.name AS team_name,
                EXISTS (
                  SELECT 1 FROM assembly_kiosk_teams a
                  JOIN machines km ON km.id = a.machine_id
                  WHERE a.team_id = m.team_id
                    AND (LOWER(TRIM(COALESCE(km.workflow, ''))) = 'dome') = $2
                ) AS is_assembly_team
         FROM employee_team_memberships m
         JOIN teams t ON t.id = m.team_id
         WHERE m.employee_id = $1 AND m.left_at IS NULL
         ORDER BY m.joined_at DESC, m.id DESC`,
        [employeeId, domeKiosk]
      );
      const onDest = openRows.some((r) => Number(r.team_id) === destTeam.id);
      const others = openRows.filter((r) => Number(r.team_id) !== destTeam.id);
      if (onDest && !others.length) {
        return okResult({
          action: 'employee_selected',
          employee,
          confirmer: employee,
          team: destTeam,
          already_on_team: true,
          confirmation_line: `${employee.name} is already on ${destTeam.name}.`,
        });
      }
      // Assembly moves only — never pull someone off a FAB (non-Assembly) team.
      const nonAssembly = others.find((r) => !r.is_assembly_team);
      if (nonAssembly) {
        return errResult(
          409,
          'not_assembly_team',
          `${employee.name} is on shift with ${nonAssembly.team_name}, which is not ${domeKiosk ? 'a Dome' : 'an Assembly'} team. Use Employee Out there first.`,
          { team_name: nonAssembly.team_name, employee }
        );
      }

      const { rows: openLabor } = await client.query(
        `SELECT p.id AS participant_id, p.session_id, s.stage, s.team_id
         FROM stage_labor_participants p
         JOIN stage_labor_sessions s ON s.id = p.session_id
         WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active'`,
        [employeeId]
      );
      const nonAssemblyLabor = openLabor.find(
        (r) => String(r.stage || '').toUpperCase() !== STAGE_CODES.ASSEMBLY
      );
      if (nonAssemblyLabor) {
        return errResult(
          409,
          'employee_busy',
          `${employee.name} is in active ${String(nonAssemblyLabor.stage || '').toLowerCase()} labor. Use Employee Out there first.`
        );
      }

      const ts = opts.at || nowIso();

      // Leave the previous team's Assembly labor (history kept; left_at closes the interval).
      for (const lab of openLabor) {
        if (Number(lab.team_id) === destTeam.id) continue;
        await client.query(
          `UPDATE stage_labor_participants SET left_at = $1::timestamptz WHERE id = $2 AND left_at IS NULL`,
          [ts, Number(lab.participant_id)]
        );
        const { rows: remaining } = await client.query(
          `SELECT COUNT(*)::int AS n FROM stage_labor_participants WHERE session_id = $1 AND left_at IS NULL`,
          [Number(lab.session_id)]
        );
        if (remaining[0] && remaining[0].n === 0) {
          const session = await getSessionById(Number(lab.session_id), client);
          if (session && session.status === 'active') {
            await closeStageSession(
              session,
              ts,
              { statusTarget: 'stopped', notes: 'All participants moved to another team' },
              client
            );
          }
        }
      }

      await client.query(
        `UPDATE employee_team_memberships
         SET left_at = $1::timestamptz, reason = COALESCE(reason, 'assembly_move')
         WHERE employee_id = $2 AND left_at IS NULL AND team_id <> $3`,
        [ts, employeeId, destTeam.id]
      );
      if (!onDest) {
        await client.query(
          `INSERT INTO employee_team_memberships (employee_id, team_id, joined_at, left_at, source, reason)
           VALUES ($1, $2, $3::timestamptz, NULL, $4, $5)`,
          [employeeId, destTeam.id, ts, ASSEMBLY_MOVE_SOURCE, 'Temporary Assembly team move (this shift only)']
        );
      }

      // Join the selected team's running Assembly labor, if any.
      let joinedSessionId = null;
      const alreadyInDestLabor = openLabor.some((r) => Number(r.team_id) === destTeam.id);
      if (!alreadyInDestLabor) {
        const { rows: destSessions } = await client.query(
          `SELECT id FROM stage_labor_sessions
           WHERE team_id = $1 AND stage = $2 AND status = 'active'
           ORDER BY (machine_id = $3) DESC, started_at DESC, id DESC
           LIMIT 1`,
          [destTeam.id, STAGE_CODES.ASSEMBLY, mid]
        );
        if (destSessions.length) {
          joinedSessionId = Number(destSessions[0].id);
          await client.query(
            `INSERT INTO stage_labor_participants
               (session_id, employee_id, employee_code, employee_name, team_id, joined_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
            [joinedSessionId, employeeId, employee.code, employee.name, destTeam.id, ts]
          );
        }
      }

      const fromTeam = others[0]
        ? { id: Number(others[0].team_id), name: others[0].team_name }
        : null;
      let hookExtra = null;
      if (typeof opts.onMoved === 'function') {
        hookExtra = await opts.onMoved(client, { employee, destTeam, fromTeam, machineId: mid, ts });
        if (hookExtra && hookExtra.ok === false) return hookExtra;
      }
      return okResult({
        ...(hookExtra || {}),
        action: 'employee_moved',
        employee,
        confirmer: employee,
        from_team: fromTeam,
        to_team: destTeam,
        team: destTeam,
        moved_at: ts,
        joined_session_id: joinedSessionId,
        temporary: true,
        confirmation_line: fromTeam
          ? `${employee.name} moved from ${fromTeam.name} to ${destTeam.name} for this shift.`
          : `${employee.name} joined ${destTeam.name} for this shift.`,
      });
    });
  }

  async function listAssemblyKioskTeams(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return [];
    let rows = [];
    try {
      const res = await pool.query(
        `SELECT akt.id, akt.machine_id, akt.team_id, akt.status, akt.joined_at, akt.lunch_paused_at,
                t.name AS team_name, t.barcode AS team_barcode
         FROM assembly_kiosk_teams akt
         JOIN teams t ON t.id = akt.team_id
         WHERE akt.machine_id = $1
           AND akt.left_at IS NULL
           AND COALESCE(t.active, 1) <> 0
         ORDER BY akt.joined_at ASC, akt.id ASC`,
        [mid]
      );
      rows = res.rows;
    } catch (err) {
      console.warn('[phase2] listAssemblyKioskTeams query failed:', err.message);
      return [];
    }
    const out = [];
    for (const row of rows) {
      const roster = await listOpenShiftEmployeesLocal(Number(row.team_id));
      const teamTanks = await listAssemblyTanksForTeam(Number(row.team_id));
      out.push({
        id: Number(row.id),
        team_id: Number(row.team_id),
        team_name: row.team_name,
        team_barcode: row.team_barcode || null,
        status: String(row.status || 'active').toLowerCase(),
        joined_at: row.joined_at,
        lunch_paused_at: row.lunch_paused_at || null,
        on_lunch: String(row.status || '').toLowerCase() === 'lunch',
        roster,
        tanks: teamTanks,
      });
    }
    return out;
  }

  /**
   * If legacy machines.assigned_team_id is set but assembly_kiosk_teams has no
   * open row, sync presence so Team Cards appear before any tank is selected.
   */
  async function syncAssemblyKioskPresenceFromAssignment(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return [];
    let teams = await listAssemblyKioskTeams(mid);
    if (teams.length) return teams;
    const assignment = await getMachineAssignment(mid);
    if (!assignment || !assignment.team_id) return teams;
    const synced = await ensureAssemblyKioskTeam(mid, {
      id: assignment.team_id,
      name: assignment.team_name,
      barcode: assignment.team_barcode,
    });
    if (!synced.ok) {
      console.warn('[phase2] syncAssemblyKioskPresenceFromAssignment:', synced.body && synced.body.message);
      return teams;
    }
    teams = await listAssemblyKioskTeams(mid);
    return teams;
  }

  async function writePhase2Audit(opts = {}) {
    try {
      await pool.query(
        `INSERT INTO tank_admin_phase2_audit
           (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, next_status, details)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8::jsonb)`,
        [
          String(opts.action || 'unknown').slice(0, 80),
          opts.tank_id != null ? Number(opts.tank_id) : null,
          String(opts.tank_number || ''),
          String(opts.performed_by || 'system').slice(0, 200),
          opts.reason != null ? String(opts.reason).slice(0, 2000) : null,
          opts.previous_status || null,
          opts.next_status || null,
          JSON.stringify(opts.details || {}),
        ]
      );
    } catch (err) {
      console.warn('[phase2 audit]', err.message);
    }
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
    if (status === ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY) {
      const removedMs = toMs(tankRow.assembly_removed_at) || toMs(tankRow.updated_at) || closeMs;
      return Math.max(0, removedMs - startMs);
    }
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
    const status = normalizeAssemblyTankStatus(tankRow.status);
    if (status === ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY) {
      const removedMs = toMs(tankRow.assembly_removed_at) || toMs(tankRow.updated_at) || closeMs;
      return Math.max(0, removedMs - startMs);
    }
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
    // Concurrent Assembly may own tanks.status while Testing is still open.
    if (tankTestingWorkOpen(tankRow)) {
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
      assembly_team_id: row.assembly_team_id != null ? Number(row.assembly_team_id) : null,
      testing_machine_id: row.testing_machine_id != null ? Number(row.testing_machine_id) : null,
      testing_confirmed_at: row.testing_confirmed_at || null,
      qa_started_at: row.qa_started_at || null,
      qa_completed_at: row.qa_completed_at || null,
      qa_machine_id: row.qa_machine_id != null ? Number(row.qa_machine_id) : null,
      qa_result: row.qa_result || null,
      qa_failure_note: row.qa_failure_note || null,
      qa_user_id: row.qa_user_id != null ? Number(row.qa_user_id) : null,
      qa_user_name: row.qa_user_name || null,
      assembly_removed_at: row.assembly_removed_at || null,
      assembly_restored_at: row.assembly_restored_at || null,
      completed_at: row.completed_at || null,
      duration_ms: durationMs,
      duration_display: formatDurationXhYm(durationMs),
      duration_summary: formatDurationSummary(durationMs),
      assembly_duration_ms: assemblyDurationMs,
      assembly_duration_display: formatDurationXhYm(assemblyDurationMs),
      testing_elapsed_ms: testingElapsedMs,
      testing_elapsed_display: formatDurationXhYm(testingElapsedMs),
      assembly_done: tankAssemblyDone(row),
      testing_done: tankTestingDone(row),
      testing_pending: requiresTest && !tankTestingDone(row),
      labor: laborSummary || null,
    };
  }

  function emptyTestingSessionContext() {
    return {
      open_testing_attempt_id: null,
      open_vacuum_attempt_id: null,
      open_brine_attempt_id: null,
      pending_vacuum_result: null,
      pending_brine_result: null,
      current_vacuum: null,
      latest_failed_testing: null,
      latest_failed_vacuum: null,
      latest_failed_brine: null,
      failure_source: null,
      testing_attempt_number: 0,
      is_testing_retest: false,
      testing_status_detail: null,
      testing_status_label: null,
      selected_test: null,
      vacuum_unlocked: false,
      vacuum_passed: false,
      brine_unlocked: false,
      brine_started: false,
      brine_completed: false,
      brine_passed: false,
      current_brine: null,
      can_ready_for_qa: false,
      can_test_complete: false,
      vacuum_retest_required: false,
      brine_retest_required: false,
      vacuum_retest_in_progress: false,
      brine_retest_in_progress: false,
    };
  }

  function mapAttemptBrief(row) {
    if (!row) return null;
    const startInHg = row.vacuum_start_inhg != null ? Number(row.vacuum_start_inhg) : null;
    const endInHg = row.vacuum_end_inhg != null ? Number(row.vacuum_end_inhg) : null;
    const expected = row.brine_expected_amount != null ? Number(row.brine_expected_amount) : null;
    const actual = row.brine_actual_amount != null ? Number(row.brine_actual_amount) : null;
    const startMs = toMs(row.started_at || row.attempted_at);
    const endMs = toMs(row.completed_at);
    const elapsedMs = startMs != null && endMs != null ? Math.max(0, endMs - startMs) : null;
    return {
      id: Number(row.id),
      test_type: String(row.test_type || '')
        .trim()
        .toUpperCase(),
      result: row.result || null,
      attempt_status: row.attempt_status || null,
      failure_note: row.failure_note || null,
      started_at: row.started_at || row.attempted_at || null,
      completed_at: row.completed_at || row.attempted_at || null,
      parent_attempt_id: row.parent_attempt_id != null ? Number(row.parent_attempt_id) : null,
      vacuum_start_inhg: startInHg,
      vacuum_end_inhg: endInHg,
      vacuum_delta_inhg:
        startInHg != null && endInHg != null && Number.isFinite(startInHg) && Number.isFinite(endInHg)
          ? endInHg - startInHg
          : null,
      brine_expected_amount: expected,
      brine_actual_amount: actual,
      brine_variance:
        expected != null && actual != null && Number.isFinite(expected) && Number.isFinite(actual)
          ? actual - expected
          : null,
      elapsed_ms: elapsedMs,
      elapsed_display: elapsedMs != null ? formatDurationXhYm(elapsedMs) : null,
    };
  }

  function isOpenMeasurementRow(r, type, endField) {
    if (String(r.test_type || '').toUpperCase() !== type) return false;
    const st = String(r.attempt_status || '')
      .trim()
      .toLowerCase();
    return (
      st === 'in_progress' ||
      (r[endField] == null &&
        st !== 'recorded' &&
        st !== 'passed' &&
        st !== 'failed' &&
        st !== 'cancelled')
    );
  }

  function isCancelledAttemptRow(r) {
    return (
      String(r.attempt_status || '')
        .trim()
        .toLowerCase() === 'cancelled'
    );
  }

  async function getTestingFailureContext(tankId, client = pool) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return emptyTestingSessionContext();
    let rows = [];
    try {
      const res = await client.query(
        `SELECT id, test_type, result, attempt_status, failure_note, started_at, completed_at, attempted_at,
                parent_attempt_id, vacuum_start_inhg, vacuum_end_inhg,
                brine_expected_amount, brine_actual_amount
         FROM test_attempts
         WHERE tank_id = $1
           AND UPPER(TRIM(COALESCE(test_type, ''))) IN ('TESTING', 'VACUUM', 'BRINE')
         ORDER BY id ASC`,
        [tid]
      );
      rows = (res.rows || []).filter((r) => !isCancelledAttemptRow(r));
    } catch (_err) {
      return emptyTestingSessionContext();
    }
    const testingRows = rows.filter((r) => String(r.test_type || '').toUpperCase() === 'TESTING');
    const attemptStatusOf = (r) =>
      String(r.attempt_status || '')
        .trim()
        .toLowerCase();
    // Same parent the start actions attach to (ensureOpenTestingAttempt): latest in_progress TESTING row.
    // Legacy rows without a status are only used when no in_progress parent exists.
    const openTesting =
      [...testingRows].reverse().find((r) => attemptStatusOf(r) === 'in_progress') ||
      [...testingRows].reverse().find((r) => {
        const st = attemptStatusOf(r);
        return !r.result && st !== 'passed' && st !== 'failed' && st !== 'recorded';
      });
    const failedTesting = [...testingRows]
      .reverse()
      .find((r) => normalizeTestResult(r.result) === 'FAIL' || attemptStatusOf(r) === 'failed');
    const parentId = openTesting ? Number(openTesting.id) : null;
    const children = parentId
      ? rows.filter(
          (r) =>
            Number(r.parent_attempt_id) === parentId ||
            (r.parent_attempt_id == null &&
              String(r.test_type || '')
                .toUpperCase()
                .match(/VACUUM|BRINE/) &&
              Number(r.id) > parentId)
        )
      : [];
    const vacuumRows = children.filter((r) => String(r.test_type || '').toUpperCase() === 'VACUUM');
    const brineRows = children.filter((r) => String(r.test_type || '').toUpperCase() === 'BRINE');
    const openVacuum = [...vacuumRows]
      .reverse()
      .find((r) => isOpenMeasurementRow(r, 'VACUUM', 'vacuum_end_inhg'));
    const openBrine = [...brineRows]
      .reverse()
      .find((r) => isOpenMeasurementRow(r, 'BRINE', 'brine_actual_amount'));
    const pendingVacuum = [...vacuumRows].reverse().find((r) => {
      const st = String(r.attempt_status || '')
        .trim()
        .toLowerCase();
      return st === 'recorded' && r.vacuum_end_inhg != null && !normalizeTestResult(r.result);
    });
    const passedVacuum = [...vacuumRows].reverse().find((r) => {
      const st = String(r.attempt_status || '')
        .trim()
        .toLowerCase();
      return normalizeTestResult(r.result) === 'PASS' || st === 'passed';
    });
    const completedBrine = [...brineRows].reverse().find((r) => {
      const st = attemptStatusOf(r);
      return (
        r.brine_actual_amount != null &&
        (st === 'recorded' || st === 'passed' || st === 'failed' || normalizeTestResult(r.result))
      );
    });
    const pendingBrine = [...brineRows].reverse().find((r) => {
      return (
        attemptStatusOf(r) === 'recorded' && r.brine_actual_amount != null && !normalizeTestResult(r.result)
      );
    });
    const passedBrine = [...brineRows].reverse().find((r) => {
      return normalizeTestResult(r.result) === 'PASS' || attemptStatusOf(r) === 'passed';
    });
    const isFailedRow = (r) => normalizeTestResult(r.result) === 'FAIL' || attemptStatusOf(r) === 'failed';
    const failedVacuumGlobal = [...rows]
      .reverse()
      .find((r) => String(r.test_type || '').toUpperCase() === 'VACUUM' && isFailedRow(r));
    const failedBrineGlobal = [...rows]
      .reverse()
      .find((r) => String(r.test_type || '').toUpperCase() === 'BRINE' && isFailedRow(r));
    const failedCount = testingRows.filter(isFailedRow).length;
    const isRetest = Boolean(openTesting && failedCount > 0);
    const vacuumPassed = Boolean(passedVacuum);
    const brinePassed = Boolean(passedBrine);
    const brineStarted = brineRows.length > 0;
    const brineCompleted = Boolean(completedBrine);
    // One test per Testing attempt: the operator selects Vacuum OR Brine.
    const selectedTest = vacuumRows.length > 0 ? 'VACUUM' : brineStarted ? 'BRINE' : null;
    // READY FOR QA/QC: the selected test PASSED and nothing is still open or awaiting PASS/FAIL.
    const canReadyForQa =
      Boolean(openTesting) &&
      (vacuumPassed || brinePassed) &&
      !openVacuum &&
      !openBrine &&
      !pendingVacuum &&
      !(pendingBrine && !vacuumPassed);
    // The failed measurement under the latest failed TESTING attempt decides what Failed / Hold shows.
    let failureSource = null;
    if (failedTesting) {
      const pid = Number(failedTesting.id);
      const child = [...rows]
        .reverse()
        .find(
          (r) =>
            Number(r.parent_attempt_id) === pid &&
            isFailedRow(r) &&
            /VACUUM|BRINE/.test(String(r.test_type || '').toUpperCase())
        );
      failureSource = child
        ? String(child.test_type).toUpperCase() === 'BRINE'
          ? 'brine'
          : 'vacuum'
        : 'testing';
    } else if (failedVacuumGlobal || failedBrineGlobal) {
      failureSource =
        Number((failedBrineGlobal || {}).id || 0) > Number((failedVacuumGlobal || {}).id || 0)
          ? 'brine'
          : 'vacuum';
    }
    let testing_status_detail = null;
    let testing_status_label = null;
    if (openTesting && canReadyForQa) {
      testing_status_detail = 'test_passed_ready_for_qa';
      testing_status_label = `Testing — ${vacuumPassed ? 'Vacuum' : 'Brine'} PASS`;
    } else if (openTesting && isRetest) {
      testing_status_detail = 'testing_retest_in_progress';
      testing_status_label = 'Testing — Retest';
    } else if (openTesting && selectedTest === 'VACUUM') {
      testing_status_detail = 'vacuum_selected';
      testing_status_label = 'Testing — Vacuum';
    } else if (openTesting && selectedTest === 'BRINE') {
      testing_status_detail = 'brine_selected';
      testing_status_label = 'Testing — Brine';
    } else if (openTesting) {
      testing_status_detail = 'select_test';
      testing_status_label = 'Testing — Select Vacuum or Brine';
    } else if (failureSource) {
      testing_status_detail = 'testing_failed_hold';
      testing_status_label =
        failureSource === 'vacuum'
          ? 'Vacuum Failed — Hold'
          : failureSource === 'brine'
            ? 'Brine Failed — Hold'
            : 'Testing Failed — Hold';
    }
    return {
      open_testing_attempt_id: openTesting ? Number(openTesting.id) : null,
      open_vacuum_attempt_id: openVacuum ? Number(openVacuum.id) : null,
      open_brine_attempt_id: openBrine ? Number(openBrine.id) : null,
      pending_vacuum_result: pendingVacuum ? mapAttemptBrief(pendingVacuum) : null,
      pending_brine_result: pendingBrine ? mapAttemptBrief(pendingBrine) : null,
      current_vacuum: passedVacuum
        ? mapAttemptBrief(passedVacuum)
        : pendingVacuum
          ? mapAttemptBrief(pendingVacuum)
          : openVacuum
            ? mapAttemptBrief(openVacuum)
            : null,
      current_brine: passedBrine
        ? mapAttemptBrief(passedBrine)
        : completedBrine
          ? mapAttemptBrief(completedBrine)
          : openBrine
            ? mapAttemptBrief(openBrine)
            : null,
      latest_failed_testing: failedTesting ? mapAttemptBrief(failedTesting) : null,
      latest_failed_vacuum: failedVacuumGlobal ? mapAttemptBrief(failedVacuumGlobal) : null,
      latest_failed_brine: failedBrineGlobal ? mapAttemptBrief(failedBrineGlobal) : null,
      failure_source: openTesting ? null : failureSource,
      testing_attempt_number: testingRows.length,
      is_testing_retest: isRetest,
      testing_status_detail,
      testing_status_label,
      selected_test: selectedTest,
      vacuum_unlocked: Boolean(openTesting) && selectedTest !== 'BRINE',
      vacuum_passed: vacuumPassed,
      brine_unlocked: Boolean(openTesting) && selectedTest !== 'VACUUM',
      brine_started: brineStarted,
      brine_completed: brineCompleted,
      brine_passed: brinePassed,
      can_ready_for_qa: canReadyForQa,
      can_test_complete: canReadyForQa,
      vacuum_retest_required: false,
      brine_retest_required: false,
      vacuum_retest_in_progress: false,
      brine_retest_in_progress: false,
    };
  }

  async function enrichTankSummaryWithTestingFailure(summary, client = pool) {
    if (!summary || !summary.id) return summary;
    const st = normalizeAssemblyTankStatus(summary.status);
    // Concurrent Assembly keeps tanks.status = assembly_in_progress while Testing is open.
    // Still load Vacuum/Brine attempt context so the QA/QC kiosk shows RECORD END / PASS-FAIL
    // instead of a stale START VACUUM button.
    const shouldEnrichTestingContext =
      st === ASSEMBLY_STATUSES.READY_FOR_TESTING ||
      st === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS ||
      st === ASSEMBLY_STATUSES.TESTING_FAILED ||
      tankTestingWorkOpen(summary);
    if (!shouldEnrichTestingContext) {
      return { ...summary, ...emptyTestingSessionContext() };
    }
    const ctx = await getTestingFailureContext(summary.id, client);
    return { ...summary, ...ctx };
  }

  /**
   * Tank finished Assembly under the old QA-before-Testing order and is waiting in Ready for QA
   * without any Testing or QA started. It belongs in Ready for Testing under the current order.
   */
  function isUntestedLegacyQaTank(tank) {
    return (
      Boolean(tank) &&
      normalizeAssemblyTankStatus(tank.status) === ASSEMBLY_STATUSES.READY_FOR_QA &&
      tankRequiresTest(tank) &&
      !tank.testing_completed_at &&
      !tank.testing_started_at &&
      !tank.qa_started_at
    );
  }

  async function ensureOpenTestingAttempt(tankId, machine, user, client, previousStatus) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    // Serialize Testing actions per tank so double taps / two kiosks cannot open duplicate tests.
    await client.query(`SELECT id FROM tanks WHERE id = $1 FOR UPDATE`, [tankId]);
    const existing = await client.query(
      `SELECT id FROM test_attempts
       WHERE tank_id = $1
         AND UPPER(TRIM(COALESCE(test_type, ''))) = 'TESTING'
         AND LOWER(TRIM(COALESCE(attempt_status, ''))) = 'in_progress'
       ORDER BY id DESC
       LIMIT 1`,
      [tankId]
    );
    if (existing.rows.length) return Number(existing.rows[0].id);
    const ts = nowIso();
    const insert = await client.query(
      `INSERT INTO test_attempts
         (tank_id, machine_id, attempted_at, previous_status, test_type, attempt_status,
          started_at, tester_user_id, tester_user_name, tester_employee_name, created_at)
       VALUES ($1,$2,$3::timestamptz,$4,'TESTING','in_progress',$3::timestamptz,$5,$6,$6,NOW())
       RETURNING id`,
      [
        tankId,
        mid,
        ts,
        previousStatus || null,
        user && user.id != null ? Number(user.id) : null,
        (user && (user.name || user.username)) || null,
      ]
    );
    return Number(insert.rows[0].id);
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
    let elapsedMs = startedMs != null && endedMs != null ? Math.max(0, endedMs - startedMs) : 0;
    const participantIds = parts.map((part) => Number(part.employee_id));
    const hasResumedParticipants = new Set(participantIds).size < participantIds.length;
    if (hasResumedParticipants) {
      const intervals = parts
        .map((part) => {
          const start = toMs(part.joined_at);
          const end =
            toMs(part.left_at) ||
            (row.status === 'active' ? Date.now() : toMs(row.ended_at));
          return start != null && end != null ? [start, Math.max(start, end)] : null;
        })
        .filter(Boolean)
        .sort((a, b) => a[0] - b[0]);
      let productiveMs = 0;
      let current = null;
      for (const interval of intervals) {
        if (!current) {
          current = interval.slice();
        } else if (interval[0] <= current[1]) {
          current[1] = Math.max(current[1], interval[1]);
        } else {
          productiveMs += current[1] - current[0];
          current = interval.slice();
        }
      }
      if (current) productiveMs += current[1] - current[0];
      elapsedMs = productiveMs;
    }
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

  /** Active ASSEMBLY session of one team on a tank (optionally on one kiosk). */
  async function getActiveAssemblySessionForTeam(tankId, teamId, machineIdOptional, client = pool) {
    const tid = Number(tankId);
    const teamNum = Number(teamId);
    if (!Number.isInteger(tid) || tid <= 0 || !Number.isInteger(teamNum) || teamNum <= 0) return null;
    const params = [tid, teamNum, STAGE_CODES.ASSEMBLY];
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
       WHERE sls.tank_id = $1 AND sls.team_id = $2 AND sls.stage = $3
         AND sls.status = 'active'${machineClause}
       ORDER BY sls.started_at DESC, sls.id DESC
       LIMIT 1`,
      params
    );
    return rows[0] || null;
  }

  let legacyAssemblyTeamLinksBackfilled = false;

  /**
   * Tanks confirmed before assembly_tank_teams existed only carry
   * tanks.assembly_team_id — give that team an active assignment row once.
   */
  async function backfillLegacyAssemblyTeamLinks() {
    if (legacyAssemblyTeamLinksBackfilled) return;
    try {
      await pool.query(
        `INSERT INTO assembly_tank_teams
           (tank_id, team_id, machine_id, status, confirmed_at, created_at, updated_at)
         SELECT t.id, t.assembly_team_id, t.assembly_machine_id, 'active',
                COALESCE(t.assembly_started_at, NOW()), NOW(), NOW()
         FROM tanks t
         WHERE t.deleted_at IS NULL
           AND LOWER(TRIM(t.status)) = $1
           AND t.assembly_team_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM teams tm WHERE tm.id = t.assembly_team_id)
           AND (t.assembly_machine_id IS NULL
                OR EXISTS (SELECT 1 FROM machines m WHERE m.id = t.assembly_machine_id))
           AND NOT EXISTS (SELECT 1 FROM assembly_tank_teams a WHERE a.tank_id = t.id)
         ON CONFLICT DO NOTHING`,
        [ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS]
      );
      legacyAssemblyTeamLinksBackfilled = true;
    } catch (err) {
      console.warn('[phase2] assembly_tank_teams legacy backfill failed:', err.message);
    }
  }

  async function listActiveAssemblyTeamLinks(tankId, client = pool) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return [];
    const { rows } = await client.query(
      `SELECT a.id, a.tank_id, a.team_id, a.machine_id, a.confirmed_at,
              tm.name AS team_name, m.name AS machine_name
       FROM assembly_tank_teams a
       LEFT JOIN teams tm ON tm.id = a.team_id
       LEFT JOIN machines m ON m.id = a.machine_id
       WHERE a.tank_id = $1 AND a.status = 'active'
       ORDER BY a.confirmed_at ASC, a.id ASC`,
      [tid]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      tank_id: Number(r.tank_id),
      team_id: Number(r.team_id),
      team_name: r.team_name || null,
      machine_id: r.machine_id != null ? Number(r.machine_id) : null,
      machine_name: r.machine_name || null,
      confirmed_at: r.confirmed_at,
    }));
  }

  /** tank_id → [{ team_id, team_name, machine_id }] for active Assembly assignments. */
  async function mapActiveAssemblyTeamsByTank(tankIds) {
    const ids = (tankIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const out = new Map();
    if (!ids.length) return out;
    const { rows } = await pool.query(
      `SELECT a.tank_id, a.team_id, a.machine_id, tm.name AS team_name, m.name AS machine_name
       FROM assembly_tank_teams a
       LEFT JOIN teams tm ON tm.id = a.team_id
       LEFT JOIN machines m ON m.id = a.machine_id
       WHERE a.tank_id = ANY($1::bigint[]) AND a.status = 'active'
       ORDER BY a.confirmed_at ASC, a.id ASC`,
      [ids]
    );
    for (const r of rows) {
      const key = Number(r.tank_id);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({
        team_id: Number(r.team_id),
        team_name: r.team_name || null,
        machine_id: r.machine_id != null ? Number(r.machine_id) : null,
        machine_name: r.machine_name || null,
      });
    }
    return out;
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

  /**
   * Temporary Dome Shop Start handoff: leave this employee's open stage labor without
   * stopping the tank job for remaining teammates. Safe to interrupt ASSEMBLY (and
   * CORRECTION). TESTING (and other non-assembly stages) returns a conflict.
   * Must run inside an open transaction (client required).
   */
  async function releaseEmployeeOpenStageLabor(client, employeeId, ts, opts = {}) {
    const empId = Number(employeeId);
    if (!client || !Number.isInteger(empId) || empId <= 0) {
      return { ok: false, error: 'validation', message: 'employee_id is required.' };
    }
    const at = ts || nowIso();
    const allow = new Set(
      (opts.allowedStages || [STAGE_CODES.ASSEMBLY, STAGE_CODES.CORRECTION]).map((s) =>
        String(s || '').toUpperCase()
      )
    );
    const { rows: openLabor } = await client.query(
      `SELECT p.id AS participant_id, p.session_id, p.employee_name, s.stage, s.team_id,
              tk.tank_number
       FROM stage_labor_participants p
       JOIN stage_labor_sessions s ON s.id = p.session_id
       JOIN tanks tk ON tk.id = s.tank_id
       WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active'`,
      [empId]
    );
    const blocked = openLabor.find((r) => !allow.has(String(r.stage || '').toUpperCase()));
    if (blocked) {
      const stage = String(blocked.stage || '').toUpperCase();
      return {
        ok: false,
        error: 'employee_busy',
        message: `${blocked.employee_name || 'Employee'} is in active ${stage.toLowerCase()} labor on Tank ${
          blocked.tank_number || '?'
        }. Finish or stop that work first.`,
        stage,
        tank_number: blocked.tank_number || null,
      };
    }
    const left = [];
    for (const lab of openLabor) {
      await client.query(
        `UPDATE stage_labor_participants SET left_at = $1::timestamptz WHERE id = $2 AND left_at IS NULL`,
        [at, Number(lab.participant_id)]
      );
      left.push({
        session_id: Number(lab.session_id),
        stage: lab.stage,
        tank_number: lab.tank_number,
      });
      const { rows: remaining } = await client.query(
        `SELECT COUNT(*)::int AS n FROM stage_labor_participants WHERE session_id = $1 AND left_at IS NULL`,
        [Number(lab.session_id)]
      );
      if (remaining[0] && remaining[0].n === 0) {
        const session = await getSessionById(Number(lab.session_id), client);
        if (session && session.status === 'active') {
          await closeStageSession(
            session,
            at,
            { statusTarget: 'stopped', notes: 'All participants moved to Dome Shop work' },
            client
          );
        }
      }
    }
    return { ok: true, left };
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
        // Unassigned pool only. Never clear assembly_started_at — a restored tank
        // keeps prior Assembly duration and must stay selectable.
        if (tank.assembly_machine_id != null || tank.assembly_team_id != null) {
          await client.query(
            `UPDATE tanks
             SET assembly_machine_id = NULL,
                 assembly_team_id = NULL,
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
   * Dropdown candidates: FAB-complete unassigned tanks plus tanks already in
   * Assembly (any kiosk / team) so more teams can join. Each row carries
   * assembly_active_teams; the kiosk hides a tank only from teams already on it.
   */
  async function listEligibleTanksForAssembly(opts = {}) {
    const forDropdown = opts.forDropdown === true;
    let sql;
    let params;
    if (forDropdown) {
      sql = `SELECT ${TANK_SELECT_CORE}
             FROM tanks
             WHERE deleted_at IS NULL
               AND completed_at IS NULL
               AND (
                 (LOWER(TRIM(status)) = 'ready_for_assembly' AND assembly_machine_id IS NULL)
                 OR LOWER(TRIM(status)) = 'assembly_in_progress'
                 OR (
                   LOWER(TRIM(status)) IN ('testing_in_progress', 'testing_failed')
                   AND COALESCE(requires_test, FALSE) = TRUE
                   AND fab_completed_at IS NOT NULL
                   AND ${SQL_ASSEMBLY_NOT_DONE}
                 )
               )
             ORDER BY tank_number ASC`;
      params = [];
      await backfillLegacyAssemblyTeamLinks();
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
    let teamsByTank = new Map();
    if (forDropdown) {
      try {
        teamsByTank = await mapActiveAssemblyTeamsByTank(rows.map((r) => r.id));
      } catch (err) {
        console.warn('[phase2] listEligibleTanksForAssembly teams:', err.message);
      }
    }
    const out = [];
    for (const row of rows) {
      const labor = await computeStageLaborForTank(Number(row.id));
      const summary = mapTankSummary(row, labor);
      if (forDropdown) {
        summary.assembly_active_teams = teamsByTank.get(Number(row.id)) || [];
        // Assembly and Testing may run concurrently — only FAILED/HOLD locks Assembly out.
        if (summary.status === ASSEMBLY_STATUSES.TESTING_FAILED) {
          summary.locked = true;
          summary.locked_by = 'testing_failed';
          summary.lock_reason =
            'Failed Testing — on hold. Assembly is blocked until Retest passes or FAB Rework is complete.';
        } else if (summary.status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS && !tankAssemblyDone(row)) {
          summary.testing_in_progress = true;
          summary.concurrent_testing = true;
        }
      }
      out.push(summary);
    }
    return out;
  }

  /**
   * Assembly section only — tanks still in active Assembly on this kiosk.
   * Ready for Testing / Testing / Dome Install are NOT shown here.
   */
  function isAssemblyConfirmedTank(row) {
    if (!row || row.deleted_at) return false;
    return tankAssemblyWorkOpen(row);
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
      status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS ||
      tankTestingWorkOpen(row)
    );
  }

  /** @deprecated use isAssemblyConfirmedTank / isTestingConfirmedTank */
  function isKioskActionableTank(row) {
    return isAssemblyConfirmedTank(row) || isTestingConfirmedTank(row);
  }

  /**
   * Confirmed for Assembly on THIS kiosk (Assembly open; may also be in Testing concurrently).
   */
  async function listConfirmedTanksForAssembly(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE deleted_at IS NULL
         AND assembly_started_at IS NOT NULL
         AND ${SQL_ASSEMBLY_NOT_DONE}
         AND LOWER(TRIM(status)) = ANY($2::text[])
         AND (
           assembly_machine_id = $1
           OR EXISTS (
             SELECT 1 FROM assembly_tank_teams a
             WHERE a.tank_id = tanks.id AND a.machine_id = $1 AND a.status = 'active'
           )
         )
       ORDER BY tank_number ASC`,
      [mid, [ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS, ASSEMBLY_STATUSES.TESTING_IN_PROGRESS]]
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

  /** Labor logged by one team on a tank's ASSEMBLY stage. */
  async function computeTeamAssemblyLabor(tankId, teamId) {
    const { rows } = await pool.query(
      `SELECT s.status, s.ended_at, p.joined_at, p.left_at
       FROM stage_labor_sessions s
       JOIN stage_labor_participants p ON p.session_id = s.id
       WHERE s.tank_id = $1 AND s.team_id = $2 AND s.stage = $3`,
      [Number(tankId), Number(teamId), STAGE_CODES.ASSEMBLY]
    );
    const closeMs = Date.now();
    let totalMs = 0;
    for (const row of rows) {
      const joinMs = toMs(row.joined_at);
      if (joinMs == null) continue;
      const leaveMs =
        toMs(row.left_at) || (row.status === 'active' ? closeMs : toMs(row.ended_at) || closeMs);
      totalMs += Math.max(0, leaveMs - joinMs);
    }
    return { total_ms: totalMs, total_display: formatDurationXhYm(totalMs) };
  }

  /**
   * Tanks this team is actively assigned to in Assembly (any kiosk).
   * active_session and labor_display are this team's own; other teams on the
   * same tank are listed in assembly_other_teams.
   */
  async function listAssemblyTanksForTeam(teamId) {
    const teamNum = Number(teamId);
    if (!Number.isInteger(teamNum) || teamNum <= 0) return [];
    await backfillLegacyAssemblyTeamLinks();
    let tankIds = [];
    try {
      const { rows: linkRows } = await pool.query(
        `SELECT DISTINCT tank_id FROM assembly_tank_teams WHERE team_id = $1 AND status = 'active'`,
        [teamNum]
      );
      tankIds = linkRows.map((r) => Number(r.tank_id));
    } catch (err) {
      console.warn('[phase2] listAssemblyTanksForTeam:', err.message);
      return [];
    }
    if (!tankIds.length) return [];
    const { rows } = await pool.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE id = ANY($1::bigint[])
         AND deleted_at IS NULL
         AND LOWER(TRIM(status)) = $2
       ORDER BY tank_number ASC`,
      [tankIds, ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS]
    );
    const teamsByTank = await mapActiveAssemblyTeamsByTank(rows.map((r) => r.id));
    const out = [];
    for (const row of rows) {
      const tid = Number(row.id);
      const labor = await computeStageLaborForTank(tid);
      const teamLabor = await computeTeamAssemblyLabor(tid, teamNum);
      const sessionRow = await getActiveAssemblySessionForTeam(tid, teamNum, null);
      const activeTeams = teamsByTank.get(tid) || [];
      out.push({
        ...mapTankSummary(row, labor),
        active_session: sessionRow ? await mapStageSession(sessionRow) : null,
        team_id: teamNum,
        labor_display: teamLabor.total_display,
        team_labor_ms: teamLabor.total_ms,
        team_labor_display: teamLabor.total_display,
        tank_labor_display: labor.total_display,
        assembly_active_teams: activeTeams,
        assembly_other_teams: activeTeams.filter((t) => t.team_id !== teamNum),
        confirmed: true,
        section: 'assembly',
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
   * CONFIRM TANK — enter tank into Assembly for this team on this kiosk.
   * Several teams (on any kiosks) may confirm the same tank; each gets its own
   * assembly_tank_teams row. Starts Assembly Duration (assembly_started_at)
   * once; NEVER resets it. Does NOT create stage_labor_session / labor.
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
    await backfillLegacyAssemblyTeamLinks();

    return withTransaction(async (client) => {
      const machineRow = await getMachineRow(mid, client);
      if (!machineRow || Number(machineRow.active) === 0) {
        return errResult(404, 'machine_not_found', 'Machine not found or inactive.');
      }
      // Serialize with FINISH so a team cannot join while the last team completes the tank.
      await client.query('SELECT id FROM tanks WHERE id = $1 FOR UPDATE', [tankId]);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is completed/archived.');
      }
      if (status === ASSEMBLY_STATUSES.TESTING_FAILED) {
        return errResult(
          409,
          'tank_testing_failed',
          `Tank ${tank.tank_number} failed Testing and is on FAILED / HOLD. Assembly is blocked until it passes Retest or FAB Rework is complete.`,
          { tank_status: status, locked_by: 'testing_failed' }
        );
      }
      // Concurrent Testing is allowed. Assembly may confirm while Testing is open.
      const canConfirmAssembly =
        status === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY ||
        status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS ||
        status === ASSEMBLY_STATUSES.READY_FOR_TESTING ||
        (status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS && !tankAssemblyDone(tank));
      if (!canConfirmAssembly) {
        return errResult(
          409,
          'tank_status',
          `Tank status "${status}" cannot be confirmed for Assembly.`,
          { tank_status: status }
        );
      }
      if (tankAssemblyDone(tank) && status !== ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY) {
        return errResult(
          409,
          'assembly_already_done',
          `Tank ${tank.tank_number} Assembly is already complete.`,
          { tank_status: status }
        );
      }

      const ts = opts.at || nowIso();
      const hadStarted = tank.assembly_started_at != null;
      const resumeAfterRestore =
        (status === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY ||
          status === ASSEMBLY_STATUSES.READY_FOR_TESTING ||
          status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS) &&
        tank.assembly_restored_at != null &&
        tank.assembly_completed_at != null;
      let teamId =
        opts.team_id != null
          ? Number(opts.team_id)
          : opts.teamId != null
            ? Number(opts.teamId)
            : null;
      if (!Number.isInteger(teamId) || teamId <= 0) {
        const assignment = await getMachineAssignment(mid);
        teamId = assignment && assignment.team_id ? Number(assignment.team_id) : null;
      }
      if (!Number.isInteger(teamId) || teamId <= 0) {
        return errResult(409, 'no_team', 'Scan a Team barcode before confirming a tank.');
      }

      // COALESCE protects assembly_started_at from reset on re-confirm / re-select.
      // assembly_machine_id / assembly_team_id keep the first confirming kiosk/team;
      // per-team ownership lives in assembly_tank_teams.
      // After RESTORE, clear the accidental Finish timestamp so the next FINISH
      // can record a new completion. The original Finish stays in phase2 audit.
      await client.query(
        `UPDATE tanks
         SET status = $1,
             assembly_started_at = COALESCE(assembly_started_at, $2::timestamptz),
             assembly_machine_id = CASE WHEN $7::boolean THEN COALESCE(assembly_machine_id, $3) ELSE $3 END,
             assembly_team_id = CASE WHEN $7::boolean THEN COALESCE(assembly_team_id, $4) ELSE $4 END,
             assembly_completed_at = CASE WHEN $6::boolean THEN NULL ELSE assembly_completed_at END,
             updated_at = $2::timestamptz
         WHERE id = $5`,
        [
          ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS,
          ts,
          mid,
          teamId,
          tankId,
          resumeAfterRestore,
          status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS,
        ]
      );
      await client.query(
        `INSERT INTO assembly_tank_teams
           (tank_id, team_id, machine_id, status, confirmed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4::timestamptz, $4::timestamptz, $4::timestamptz)
         ON CONFLICT DO NOTHING`,
        [tankId, teamId, mid, ts]
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
      const activeTeams = await listActiveAssemblyTeamLinks(tankId, client);
      const otherTeams = activeTeams.filter((t) => t.team_id !== teamId);
      const otherNote = otherTeams.length
        ? ` Also in Assembly: ${otherTeams.map((t) => t.team_name || `Team ${t.team_id}`).join(', ')}.`
        : '';
      return okResult({
        action: 'confirm_tank',
        already_started: hadStarted,
        tank: mapTankSummary(updated, labor),
        assembly_active_teams: activeTeams,
        message:
          (hadStarted
            ? `Tank ${updated.tank_number} selected — Assembly Duration continues (not reset).`
            : `Tank ${updated.tank_number} confirmed — Assembly Duration started. Press START for labor.`) +
          otherNote,
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
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS &&
        status !== ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS &&
        status !== ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY
      ) {
        return errResult(
          409,
          'tank_status',
          `Tank status "${status}" cannot be confirmed for Testing.`,
          { tank_status: status }
        );
      }
      if (tankTestingDone(tank)) {
        return errResult(
          409,
          'testing_already_passed',
          `Tank ${tank.tank_number} already passed Testing.`,
          { tank_status: status }
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

  /**
   * Tanks finished on this Assembly kiosk that are waiting downstream and nothing has started
   * (Ready for Testing, or legacy Ready for QA from before the Testing → QA/QC order).
   * Shown so an accidental FINISH can be restored before Testing / inspection begins.
   */
  async function listRecentlyFinishedAssembly(machineId) {
    const mid = Number(machineId);
    if (!Number.isInteger(mid) || mid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE deleted_at IS NULL
         AND (
           assembly_machine_id = $1
           OR EXISTS (
             SELECT 1 FROM assembly_tank_teams a
             WHERE a.tank_id = tanks.id AND a.machine_id = $1 AND a.status = 'finished'
           )
         )
         AND assembly_completed_at IS NOT NULL
         AND qa_started_at IS NULL
         AND (
           (testing_started_at IS NULL AND testing_machine_id IS NULL AND LOWER(TRIM(status)) IN ($2, $3))
           OR (
             LOWER(TRIM(status)) = $3
             AND testing_completed_at IS NOT NULL
             AND testing_completed_at <= assembly_completed_at
           )
         )
       ORDER BY assembly_completed_at DESC, tank_number ASC`,
      [mid, ASSEMBLY_STATUSES.READY_FOR_TESTING, ASSEMBLY_STATUSES.READY_FOR_QA]
    );
    const out = [];
    for (const row of rows) {
      const labor = await computeStageLaborForTank(Number(row.id));
      out.push(mapTankSummary(row, labor));
    }
    return out;
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
    const recently_finished_assembly = await listRecentlyFinishedAssembly(machine.id);
    const removed_tanks = await listRemovedFromAssemblyTanks();
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
    let active_teams = [];
    try {
      // Prefer persisted multi-team presence; sync from legacy assignment if needed.
      active_teams = await syncAssemblyKioskPresenceFromAssignment(machine.id);
    } catch (err) {
      console.warn('[phase2] listAssemblyKioskTeams:', err.message);
      active_teams = [];
    }
    // Last-resort card so Team scan never leaves the kiosk blank when assignment exists.
    if (!active_teams.length && assignment && assignment.team_id) {
      active_teams = [
        {
          team_id: Number(assignment.team_id),
          team_name: assignment.team_name,
          team_barcode: assignment.team_barcode || null,
          status: 'active',
          on_lunch: false,
          roster,
          tanks: assembly_confirmed_tanks.filter(
            (t) =>
              t.assembly_team_id == null || Number(t.assembly_team_id) === Number(assignment.team_id)
          ),
        },
      ];
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
      active_teams,
      eligible_tanks,
      recently_finished_assembly,
      removed_tanks,
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
    // Assigning a team ADDS/FOCUSSES a team card — never removes other teams.
    // Presence is persisted in assembly_kiosk_teams BEFORE any tank selection.
    const present = await ensureAssemblyKioskTeam(machineId, resolved);
    if (!present.ok) return present;
    const activeTeams = await listAssemblyKioskTeams(machineId);
    return okResult({
      action: 'assign_team',
      assignment: present.body.assignment || {
        team_id: present.body.team.id,
        team_name: present.body.team.name,
        team_barcode: present.body.team.barcode,
      },
      team: present.body.team,
      already_present: !!present.body.already_present,
      active_teams: activeTeams,
      message: present.body.already_present
        ? 'Team already on this Assembly kiosk.'
        : 'Team assigned. Select a tank from the dropdown and press CONFIRM TANK, then START for labor.',
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
    if (stage === STAGE_CODES.ASSEMBLY) await backfillLegacyAssemblyTeamLinks();

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

      let teamId =
        opts.team_id != null
          ? Number(opts.team_id)
          : opts.teamId != null
            ? Number(opts.teamId)
            : tank.assembly_team_id != null
              ? Number(tank.assembly_team_id)
              : null;

      if (stage === STAGE_CODES.ASSEMBLY) {
        if (!tank.assembly_started_at) {
          return errResult(
            409,
            'not_confirmed',
            'Confirm the tank first. CONFIRM TANK starts Assembly Duration; START WORK starts labor.'
          );
        }
        if (!Number.isInteger(teamId) || teamId <= 0) {
          return errResult(409, 'no_team', 'Scan a Team barcode before starting work.');
        }
        // Several teams may work the same tank — each needs its own assignment
        // and may hold at most one active Assembly session on it.
        const teamLinks = await listActiveAssemblyTeamLinks(tankId, client);
        if (!teamLinks.some((l) => l.team_id === teamId)) {
          return errResult(
            409,
            'not_confirmed',
            `Tank ${tank.tank_number} is not confirmed for this team. Select it and press CONFIRM TANK first.`
          );
        }
        const teamActive = await getActiveAssemblySessionForTeam(tankId, teamId, null, client);
        if (teamActive) {
          return errResult(409, 'session_active', 'This team already has active Assembly labor on this tank.', {
            session_id: Number(teamActive.id),
            machine_id: Number(teamActive.machine_id),
            stage: teamActive.stage,
          });
        }
      } else {
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
      }
      let rosterInfo = await resolveRosterForMachine({ id: mid });
      if (Number.isInteger(teamId) && teamId > 0) {
        const employeesForTeam = await listOpenShiftEmployeesLocal(teamId);
        rosterInfo = {
          ...rosterInfo,
          teamId,
          employees: employeesForTeam,
        };
      }
      if (!rosterInfo.teamId) {
        return errResult(409, 'no_team', 'Assign a team to this machine before starting work.');
      }
      teamId = Number(rosterInfo.teamId);
      if (
        stage !== STAGE_CODES.ASSEMBLY &&
        tank.assembly_team_id != null &&
        Number(tank.assembly_team_id) !== teamId
      ) {
        return errResult(
          409,
          'tank_other_team',
          'This tank belongs to another Assembly team.',
          { assembly_team_id: Number(tank.assembly_team_id) }
        );
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
             assembly_team_id = COALESCE(assembly_team_id, $5),
             testing_started_at = CASE
               WHEN $2::text = 'TESTING' THEN COALESCE(testing_started_at, $3::timestamptz)
               ELSE testing_started_at
             END,
             updated_at = $3::timestamptz
         WHERE id = $4`,
        [nextStatus, stage, ts, tankId, teamId]
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
    const teamId = opts.team_id != null ? Number(opts.team_id) : opts.teamId != null ? Number(opts.teamId) : null;

    return withTransaction(async (client) => {
      let sessionRow = null;
      if (Number.isInteger(sessionId) && sessionId > 0) {
        sessionRow = await getSessionById(sessionId, client);
        if (sessionRow && Number(sessionRow.machine_id) !== mid) {
          return errResult(409, 'wrong_machine', 'Session does not belong to this machine.');
        }
      } else if (Number.isInteger(tankId) && tankId > 0 && Number.isInteger(teamId) && teamId > 0) {
        // Multi-team tank: STOP only this team's Assembly labor.
        sessionRow = await getActiveAssemblySessionForTeam(tankId, teamId, null, client);
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
    let teamId = opts.team_id != null ? Number(opts.team_id) : opts.teamId != null ? Number(opts.teamId) : null;
    if (!Number.isInteger(teamId) || teamId <= 0) teamId = null;
    await backfillLegacyAssemblyTeamLinks();

    return withTransaction(async (client) => {
      // Lock the tank so two teams finishing at once cannot both see the other still working.
      await client.query('SELECT id FROM tanks WHERE id = $1 FOR UPDATE', [tankId]);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status === ASSEMBLY_STATUSES.ARCHIVED) {
        return errResult(403, 'tank_archived', 'Tank is already archived.');
      }
      if (!tankAssemblyWorkOpen(tank) && status !== ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS) {
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
      const finisherId = opts.employee && (opts.employee.id || opts.employee.employee_id);
      const finisherName = opts.employee && (opts.employee.name || opts.employee.employee_name);
      const links = await listActiveAssemblyTeamLinks(tankId, client);
      if (teamId == null && links.length === 1) teamId = links[0].team_id;
      if (teamId == null && links.length > 1) {
        return errResult(409, 'need_team', 'Several teams are working this tank — FINISH from a team card.', {
          assembly_active_teams: links,
        });
      }
      const myLink = teamId != null ? links.find((l) => l.team_id === teamId) : null;
      if (teamId != null && !myLink && links.length) {
        return errResult(
          409,
          'not_confirmed',
          `Tank ${tank.tank_number} is not confirmed for this team — nothing to finish.`,
          { assembly_active_teams: links }
        );
      }

      // Finish only this team's labor and assignment.
      if (teamId != null) {
        const mine = await getActiveAssemblySessionForTeam(tankId, teamId, null, client);
        if (mine) {
          await closeStageSession(
            mine,
            ts,
            {
              statusTarget: 'finished',
              employeeId: finisherId,
              employeeName: finisherName,
              notes: opts.notes || 'Assembly Complete (team finished)',
            },
            client
          );
        }
      }
      if (myLink) {
        await client.query(
          `UPDATE assembly_tank_teams
           SET status = 'finished', finished_at = $2::timestamptz, ended_at = $2::timestamptz,
               end_reason = 'finish', updated_at = $2::timestamptz
           WHERE id = $1 AND status = 'active'`,
          [myLink.id, ts]
        );
      }

      // Every other team, on any Assembly kiosk, must also have finished.
      const remainingLinks = links.filter((l) => !myLink || l.id !== myLink.id);
      const { rows: otherSessions } = await client.query(
        `SELECT sls.id, sls.team_id, sls.machine_id, t.name AS team_name, m.name AS machine_name
         FROM stage_labor_sessions sls
         LEFT JOIN teams t ON t.id = sls.team_id
         LEFT JOIN machines m ON m.id = sls.machine_id
         WHERE sls.tank_id = $1 AND sls.stage = $2 AND sls.status = 'active'
           AND ($3::bigint IS NULL OR sls.team_id IS DISTINCT FROM $3::bigint)`,
        [tankId, STAGE_CODES.ASSEMBLY, teamId]
      );
      const stillWorking = new Map();
      for (const l of remainingLinks) {
        stillWorking.set(l.team_id, { team_id: l.team_id, team_name: l.team_name, machine_name: l.machine_name });
      }
      for (const s of otherSessions) {
        const key = s.team_id != null ? Number(s.team_id) : `session-${s.id}`;
        if (!stillWorking.has(key)) {
          stillWorking.set(key, {
            team_id: s.team_id != null ? Number(s.team_id) : null,
            team_name: s.team_name,
            machine_name: s.machine_name,
          });
        }
      }
      if (stillWorking.size) {
        const waiting = Array.from(stillWorking.values());
        const names = waiting
          .map((w) => `${w.team_name || (w.team_id ? `Team ${w.team_id}` : 'another team')}${w.machine_name ? ` (${w.machine_name})` : ''}`)
          .join(', ');
        await client.query(
          `INSERT INTO tank_admin_phase2_audit
             (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, next_status, details)
           VALUES ('assembly_team_finished',$1,$2,$3,$4::timestamptz,$5,$6,$6,$7::jsonb)`,
          [
            tankId,
            tank.tank_number,
            String(finisherName || 'assembly_kiosk').slice(0, 200),
            ts,
            'Team finished Assembly work; other teams still working.',
            status,
            JSON.stringify({ team_id: teamId, machine_id: mid, waiting_on: waiting }),
          ]
        );
        const updatedPartial = await getTankById(tankId, client);
        const myTeamName = myLink && myLink.team_name ? myLink.team_name : 'Team';
        return okResult({
          action: 'assembly_team_finished',
          tank_completed: false,
          tank: mapTankSummary(updatedPartial),
          team_id: teamId,
          waiting_on: waiting,
          message: `${myTeamName} finished Tank ${tank.tank_number}. Assembly stays open until all teams finish — still working: ${names}.`,
        });
      }

      // Last team: close any leftover session on this tank before advancing.
      for (;;) {
        const leftover = await getActiveSessionForTank(tankId, null, client);
        if (!leftover) break;
        await closeStageSession(leftover, ts, { statusTarget: 'finished', notes: 'Assembly Complete' }, client);
      }

      // End Assembly Duration at assembly_completed_at. Never reset assembly_started_at.
      // Every tank goes through QA/QC; only Testing is skipped when requires_test is off.
      // Ready for Dome Install is reached only via QA/QC PASS.
      // Concurrent Testing may still be open — wait for Testing before ready_for_qa.
      const tankAfterTeams = await getTankById(tankId, client);
      const requiresTest = tankRequiresTest(tankAfterTeams || tank);
      const testingAlreadyPassed = requiresTest && tankTestingDone(tankAfterTeams || tank);
      const testingStillOpen = requiresTest && !testingAlreadyPassed && tankTestingWorkOpen(tankAfterTeams || tank);
      const nextStatus = nextStatusAfterAssemblyComplete(tankAfterTeams || tank);
      await client.query(
        `UPDATE tanks
         SET status = $1,
             assembly_completed_at = COALESCE(assembly_completed_at, $2::timestamptz),
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [nextStatus, ts, tankId]
      );

      const updated = await getTankById(tankId, client);
      const { rows: finishedRows } = await client.query(
        `SELECT COUNT(DISTINCT team_id)::int AS n
         FROM assembly_tank_teams
         WHERE tank_id = $1 AND status = 'finished'
           AND confirmed_at >= COALESCE($2::timestamptz, $3::timestamptz, '-infinity'::timestamptz)`,
        [tankId, tank.assembly_restored_at || null, tank.assembly_started_at || null]
      );
      const allTeamsNote = finishedRows[0] && finishedRows[0].n > 1 ? 'All teams finished. ' : '';
      return okResult({
        action: 'assembly_complete',
        tank_completed: true,
        team_id: teamId,
        tank: mapTankSummary(updated),
        requires_test: requiresTest,
        testing_already_passed: testingAlreadyPassed,
        testing_still_open: testingStillOpen,
        next_status: nextStatus,
        message: !requiresTest
          ? `${allTeamsNote}Assembly complete — Ready for QA/QC (no testing required).`
          : testingAlreadyPassed
            ? `${allTeamsNote}Assembly complete — Testing already passed. Tank moved to Ready for QA/QC.`
            : testingStillOpen
              ? `${allTeamsNote}Assembly complete — Testing still in progress. Tank goes to QA/QC when Testing finishes.`
              : `${allTeamsNote}Assembly complete — Ready for Testing. QA/QC reviews the tank after Testing.`,
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
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS &&
        status !== ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS &&
        status !== ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY
      ) {
        return errResult(
          409,
          'tank_status',
          `Tank status "${status}" is not eligible for Testing.`,
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
      const user = opts.user || {};
      const attemptId = await ensureOpenTestingAttempt(tankId, machine, user, client, status);
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
        attempt_id: attemptId,
        tank: await enrichTankSummaryWithTestingFailure(mapTankSummary(updated), client),
        labor_created: false,
        message:
          'Testing started (QA/QC). No production labor session created. Tank Total Running Time unchanged.',
      });
    });
  }

  /** QA/QC kiosk: enter Testing without legacy CONFIRM TEST gate. */
  async function beginTestingSession(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    return withTransaction(async (client) => {
      // Row lock serializes status transitions with Assembly FINISH / CONFIRM (no mutual exclusion).
      await client.query('SELECT id FROM tanks WHERE id = $1 FOR UPDATE', [tankId]);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (!tankRequiresTest(tank)) {
        return errResult(
          409,
          'test_not_required',
          `Tank ${tank.tank_number} does not require Testing.`,
          { tank_status: status }
        );
      }
      if (tankTestingDone(tank)) {
        return errResult(
          409,
          'testing_already_passed',
          `Tank ${tank.tank_number} already passed Testing — it is waiting for Assembly or QA/QC.`,
          { tank_status: status }
        );
      }
      // Concurrent Assembly is allowed. Testing may start while Assembly is open.
      const canStartTesting =
        status === ASSEMBLY_STATUSES.READY_FOR_TESTING ||
        status === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS ||
        status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS ||
        (status === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY && !tankTestingDone(tank) && !tankAssemblyDone(tank)) ||
        isUntestedLegacyQaTank(tank);
      if (!canStartTesting) {
        return errResult(409, 'tank_status', `Cannot start Testing from "${status}".`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      const assemblyStillOpen = tankAssemblyWorkOpen(tank) || status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS;
      // Keep assembly_in_progress when Assembly is still working so Assembly labor stays eligible.
      const nextStatus = assemblyStillOpen
        ? ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS
        : ASSEMBLY_STATUSES.TESTING_IN_PROGRESS;
      const attemptId = await ensureOpenTestingAttempt(tankId, machine, user, client, nextStatus);
      await client.query(
        `UPDATE tanks
         SET status = $1,
             testing_started_at = COALESCE(testing_started_at, $2::timestamptz),
             testing_machine_id = COALESCE($3, testing_machine_id),
             updated_at = $2::timestamptz
         WHERE id = $4`,
        [nextStatus, ts, mid, tankId]
      );
      return okResult({
        action: 'begin_testing',
        attempt_id: attemptId,
        concurrent_assembly: assemblyStillOpen,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: assemblyStillOpen
          ? 'Testing started (Assembly still in progress) — select Vacuum OR Brine.'
          : 'Testing started — select Vacuum OR Brine.',
      });
    });
  }

  /**
   * @deprecated Prefer completeTesting (TEST COMPLETE) on the QA/QC kiosk.
   * Legacy FAIL→rework_required/FAB routing is retired; FAIL now goes to testing_failed (FAILED/HOLD).
   * Explicit FAB routing: sendTestingFailToFabRework.
   */
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
    if (result === 'FAIL') {
      const noteText = String(opts.note || opts.failure_note || opts.failureNote || '').trim();
      if (!noteText) {
        return errResult(400, 'validation', 'A failure note is required.');
      }
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
        status !== ASSEMBLY_STATUSES.READY_FOR_TESTING &&
        !tankTestingWorkOpen(tank)
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
      const previousStatus = status;

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
      let attempt;
      try {
        const attemptRes = await client.query(
          `INSERT INTO test_attempts
             (tank_id, machine_id, team_id, team_name, result, attempted_at,
              tester_employee_id, tester_employee_name, failure_note, labor_session_id,
              previous_status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11,$6::timestamptz)
           RETURNING id, tank_id, result, attempted_at, failure_note, previous_status`,
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
            previousStatus || null,
          ]
        );
        attempt = attemptRes.rows[0];
      } catch (err) {
        // Older DBs without previous_status column — still record the attempt.
        if (!/previous_status/i.test(String(err && err.message))) throw err;
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
        attempt = attemptRes.rows[0];
      }

      let passNextStatus = null;
      if (result === 'PASS') {
        // Testing PASS → Ready for QA/QC, or back to Assembly when Testing ran first.
        // Clear Testing kiosk confirmation so tank leaves Testing section + dropdown.
        passNextStatus = tankAssemblyDone(tank)
          ? ASSEMBLY_STATUSES.READY_FOR_QA
          : ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY;
        await client.query(
          `UPDATE tanks
           SET status = $1,
               testing_completed_at = COALESCE(testing_completed_at, $2::timestamptz),
               testing_started_at = COALESCE(testing_started_at, $2::timestamptz),
               testing_machine_id = NULL,
               testing_confirmed_at = NULL,
               assembly_machine_id = CASE WHEN $1::text = 'ready_for_assembly' THEN NULL ELSE assembly_machine_id END,
               assembly_team_id = CASE WHEN $1::text = 'ready_for_assembly' THEN NULL ELSE assembly_team_id END,
               completed_at = NULL,
               updated_at = $2::timestamptz
           WHERE id = $3`,
          [passNextStatus, ts, tankId]
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
        // Legacy API: overall Testing FAIL → FAILED/HOLD (testing_failed), not FAB.
        // Use sendTestingFailToFabRework for explicit FAB routing.
        const failUpd = await client.query(
          `UPDATE tanks
           SET status = $1,
               requires_test = TRUE,
               completed_at = NULL,
               updated_at = $2::timestamptz
           WHERE id = $3
           RETURNING status, requires_test`,
          [ASSEMBLY_STATUSES.TESTING_FAILED, ts, tankId]
        );
        const failRow = failUpd.rows[0];
        if (!failRow || normalizeAssemblyTankStatus(failRow.status) !== ASSEMBLY_STATUSES.TESTING_FAILED) {
          throw new Error(
            `FAIL status transition failed: expected testing_failed, got ${failRow && failRow.status}`
          );
        }
        try {
          await client.query(
            `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz
             WHERE id = $2 AND active_tank_id = $3`,
            [ts, mid, tankId]
          );
        } catch (_err) {
          /* ignore */
        }
      }

      const updated = await getTankById(tankId, client);
      return okResult({
        action: 'test_result',
        result,
        deprecated: true,
        attempt: {
          id: Number(attempt.id),
          tank_id: Number(attempt.tank_id),
          result: attempt.result,
          attempted_at: attempt.attempted_at,
          failure_note: attempt.failure_note || null,
          previous_status: attempt.previous_status || previousStatus || null,
          labor_session_id: laborSessionId,
        },
        tank: mapTankSummary(updated),
        message:
          result === 'PASS'
            ? testingPassMessage(passNextStatus)
            : 'Testing FAIL recorded (legacy API) — FAILED / HOLD. Prefer TEST COMPLETE on QA/QC kiosk; use Send Back to FAB Rework explicitly.',
      });
    });
  }

  /**
   * Manager Dashboard "Complete Tank" — FINAL factory completion / ready to ship.
   * Distinct from Winding kiosk Tank Complete (FAB → Assembly) and from FAB Dome Install
   * (ready_for_dome_install → dome_installed). Allowed from ready_for_dome_install or
   * dome_installed; Phase 3 may gate on an installed dome (or manager override).
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
      if (
        status !== ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL &&
        status !== ASSEMBLY_STATUSES.DOME_INSTALLED
      ) {
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

      if (typeof opts.beforeComplete === 'function') {
        const gate = await opts.beforeComplete(client, tank);
        if (gate && gate.ok === false) return gate;
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
    // Post-test correction/rework belongs on FAB / Winder kiosks (rework_required), not QA/QC.
    return errResult(
      409,
      'use_fab_rework',
      'Correction after Testing FAIL is done on FAB / Winder kiosks. Failed tanks show as Rework Required — scan the tank there, select the piece, and use Correction.'
    );
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

  async function pauseStationLabor(machine, reason, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const reasonText = reason != null ? String(reason).trim() : 'pause';
    const teamId =
      opts.teamId != null
        ? Number(opts.teamId)
        : opts.team_id != null
          ? Number(opts.team_id)
          : null;
    const isLunch = String(reasonText).toUpperCase() === 'LUNCH';
    if (isLunch && (!Number.isInteger(teamId) || teamId <= 0)) {
      return errResult(
        400,
        'team_required',
        'Lunch must come from a Team Card (team_id required).'
      );
    }
    return withTransaction(async (client) => {
      let rows = await getActiveSessionsForMachine(mid, client);
      if (Number.isInteger(teamId) && teamId > 0) {
        rows = rows.filter((row) => Number(row.team_id) === teamId);
      }
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

      // If Lunch and no active labor (e.g. worker pressed STOP first), tag the latest
      // stopped ASSEMBLY session for this team so Resume can find it without a Team rescan.
      if (isLunch && Number.isInteger(teamId) && teamId > 0 && !closed.length) {
        await client.query(
          `UPDATE stage_labor_sessions sls
           SET notes = 'LUNCH', updated_at = $1::timestamptz
           WHERE sls.id = (
             SELECT s.id
             FROM stage_labor_sessions s
             JOIN tanks tk ON tk.id = s.tank_id
             WHERE s.machine_id = $2
               AND s.team_id = $3
               AND s.status = 'stopped'
               AND UPPER(COALESCE(s.stage, '')) = 'ASSEMBLY'
               AND LOWER(TRIM(COALESCE(tk.status, ''))) = 'assembly_in_progress'
               AND (
                 tk.assembly_machine_id = $2
                 OR EXISTS (
                   SELECT 1 FROM assembly_tank_teams a
                   WHERE a.tank_id = tk.id AND a.team_id = $3 AND a.status = 'active'
                 )
               )
             ORDER BY s.ended_at DESC NULLS LAST, s.id DESC
             LIMIT 1
           )
           AND (sls.notes IS NULL OR TRIM(sls.notes) = '')`,
          [ts, mid, teamId]
        );
      }

      if (Number.isInteger(teamId) && teamId > 0 && isLunch) {
        await client.query(
          `UPDATE assembly_kiosk_teams
           SET status = 'lunch', lunch_paused_at = $1::timestamptz, updated_at = $1::timestamptz
           WHERE machine_id = $2 AND team_id = $3 AND left_at IS NULL`,
          [ts, mid, teamId]
        );
      }
      return okResult({
        action: 'pause_station',
        reason: reasonText,
        team_id: Number.isInteger(teamId) && teamId > 0 ? teamId : null,
        stopped_sessions: closed,
        count: closed.length,
        message: isLunch
          ? 'Team Lunch — this Team Card only. Press Resume on the same card when ready.'
          : undefined,
      });
    });
  }

  async function resumeStationLabor(machine, opts = {}) {
    const mid = Number(machine && machine.id);
    if (!Number.isInteger(mid) || mid <= 0) {
      return errResult(400, 'validation', 'Machine is required.');
    }
    const teamId =
      opts.teamId != null
        ? Number(opts.teamId)
        : opts.team_id != null
          ? Number(opts.team_id)
          : null;
    if (!Number.isInteger(teamId) || teamId <= 0) {
      return errResult(
        400,
        'team_required',
        'Resume must come from a Team Card (team_id required). Do not rescan the Team barcode.'
      );
    }
    const resumeTeamId = teamId;

    return withTransaction(async (client) => {
      const { rows: kioskRows } = await client.query(
        `SELECT id, status, lunch_paused_at
         FROM assembly_kiosk_teams
         WHERE machine_id = $1 AND team_id = $2 AND left_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [mid, resumeTeamId]
      );
      if (!kioskRows.length) {
        return errResult(
          409,
          'team_not_on_kiosk',
          'This team is not present on this Assembly kiosk. Scan the Team barcode once to open its card.'
        );
      }
      const kioskTeam = kioskRows[0];
      const onLunch = String(kioskTeam.status || '').toLowerCase() === 'lunch';
      const lunchAt = kioskTeam.lunch_paused_at || null;

      // Prefer LUNCH-tagged stops. Also recover recent STOP+then+LUNCH cases where
      // notes stayed null but the Team Card is on lunch and the tank is still in Assembly.
      const { rows: pausedRows } = await client.query(
        `SELECT sls.*, tk.tank_number, t.name AS team_name
         FROM stage_labor_sessions sls
         JOIN tanks tk ON tk.id = sls.tank_id
         LEFT JOIN teams t ON t.id = sls.team_id
         WHERE sls.machine_id = $1
           AND sls.team_id = $2
           AND sls.status = 'stopped'
           AND UPPER(COALESCE(sls.stage, '')) = 'ASSEMBLY'
           AND (
             UPPER(TRIM(COALESCE(sls.notes, ''))) = 'LUNCH'
             OR UPPER(TRIM(COALESCE(sls.notes, ''))) LIKE 'LUNCH%'
             OR (
               $3::boolean = TRUE
               AND LOWER(TRIM(COALESCE(tk.status, ''))) = 'assembly_in_progress'
               AND (
                 EXISTS (
                   SELECT 1 FROM assembly_tank_teams a
                   WHERE a.tank_id = tk.id AND a.team_id = $2 AND a.status = 'active'
                 )
                 OR (
                   tk.assembly_machine_id = $1
                   AND (tk.assembly_team_id IS NULL OR tk.assembly_team_id = $2)
                 )
               )
               AND sls.ended_at IS NOT NULL
               AND (
                 $4::timestamptz IS NULL
                 OR sls.ended_at >= ($4::timestamptz - INTERVAL '2 minutes')
               )
             )
           )
         ORDER BY
           CASE
             WHEN UPPER(TRIM(COALESCE(sls.notes, ''))) = 'LUNCH' THEN 0
             WHEN UPPER(TRIM(COALESCE(sls.notes, ''))) LIKE 'LUNCH%' THEN 1
             ELSE 2
           END,
           sls.ended_at DESC NULLS LAST,
           sls.id DESC
         FOR UPDATE OF sls`,
        [mid, resumeTeamId, onLunch, lunchAt]
      );

      // Only resume the latest lunch/stop batch (same ended_at second), not ancient history.
      let batch = [];
      if (pausedRows.length) {
        const latestEnded = pausedRows[0].ended_at
          ? new Date(pausedRows[0].ended_at).getTime()
          : null;
        batch = pausedRows.filter((row) => {
          if (latestEnded == null || !row.ended_at) return true;
          return Math.abs(new Date(row.ended_at).getTime() - latestEnded) <= 2000;
        });
      }

      const roster = await listOpenShiftEmployeesLocal(resumeTeamId);
      const rosterById = new Map(
        roster.map((employee) => [Number(employee.id || employee.employee_id), employee])
      );
      const prepared = [];

      for (const row of batch) {
        if (Number(row.team_id) !== Number(resumeTeamId)) continue;

        const tank = await getTankById(Number(row.tank_id), client);
        if (!tank) continue;
        const stage = normalizeStageCode(row.stage) || STAGE_CODES.ASSEMBLY;
        const status = normalizeAssemblyTankStatus(tank.status);
        if (!(STAGE_ELIGIBLE_STATUSES[stage] || []).includes(status)) continue;
        if (stage === STAGE_CODES.ASSEMBLY) {
          // Resume only tanks this team is still assigned to (not finished / removed).
          const teamLinks = await listActiveAssemblyTeamLinks(Number(row.tank_id), client);
          const linked = teamLinks.some((l) => l.team_id === Number(resumeTeamId));
          if (!linked && !(teamLinks.length === 0 && Number(tank.assembly_machine_id) === mid)) continue;
          const teamActive = await getActiveAssemblySessionForTeam(
            Number(row.tank_id),
            resumeTeamId,
            null,
            client
          );
          if (teamActive) continue;
        } else {
          const active = await getActiveSessionForTank(Number(row.tank_id), null, client);
          if (active) continue;
        }

        const { rows: priorParticipants } = await client.query(
          `SELECT DISTINCT ON (employee_id)
                  employee_id, employee_code, employee_name, team_id
           FROM stage_labor_participants
           WHERE session_id = $1
           ORDER BY employee_id, joined_at DESC, id DESC`,
          [Number(row.id)]
        );
        // Only employees still on open shift for THIS team (Employee Out stays out).
        const employees = priorParticipants
          .map((participant) => rosterById.get(Number(participant.employee_id)))
          .filter(Boolean);
        // Employees moved onto this team during Lunch join its resumed labor too.
        const endedMs = row.ended_at ? new Date(row.ended_at).getTime() : null;
        if (endedMs != null) {
          for (const member of roster) {
            const memberId = Number(member.id || member.employee_id);
            if (employees.some((e) => Number(e.id || e.employee_id) === memberId)) continue;
            if (prepared.some((p) => p.employees.some((e) => Number(e.id || e.employee_id) === memberId))) continue;
            const joinedMs = member.joined_at ? new Date(member.joined_at).getTime() : null;
            if (joinedMs != null && joinedMs >= endedMs) employees.push(member);
          }
        }
        if (!employees.length) continue;
        prepared.push({ row, employees });
      }

      const ts = nowIso();

      // Team Card Resume must clear lunch presence even when there is no labor to revive
      // (e.g. Lunch pressed before START). Worker can then press START from the same card.
      if (!prepared.length) {
        await client.query(
          `UPDATE assembly_kiosk_teams
           SET status = 'active', lunch_paused_at = NULL, updated_at = $1::timestamptz
           WHERE machine_id = $2 AND team_id = $3 AND left_at IS NULL`,
          [ts, mid, resumeTeamId]
        );
        if (onLunch) {
          return okResult({
            action: 'resume_station',
            team_id: resumeTeamId,
            resumed_sessions: [],
            count: 0,
            message:
              'Team resumed from Lunch. No paused Assembly labor was found — press START on this Team Card to begin labor.',
          });
        }
        return errResult(
          409,
          'nothing_to_resume',
          'No Assembly work is paused for Lunch for this team.'
        );
      }

      const employeeIds = [
        ...new Set(
          prepared.flatMap(({ employees }) =>
            employees.map((employee) => Number(employee.id || employee.employee_id))
          )
        ),
      ];
      const conflicts = await findOpenParticipationConflicts(employeeIds, client);
      if (conflicts.length) {
        const names = conflicts
          .map((conflict) => conflict.employee_name || `Employee ${conflict.employee_id}`)
          .join(', ');
        return errResult(409, 'employee_busy', `Employee(s) already in active stage labor: ${names}.`);
      }

      const resumed = [];
      for (const { row, employees } of prepared) {
        await client.query(
          `UPDATE stage_labor_sessions
           SET status = 'active',
               ended_at = NULL,
               stopped_by_employee_id = NULL,
               stopped_by_employee_name = NULL,
               notes = 'RESUMED_AFTER_LUNCH',
               updated_at = $1::timestamptz
           WHERE id = $2 AND status = 'stopped'`,
          [ts, Number(row.id)]
        );
        for (const employee of employees) {
          await client.query(
            `INSERT INTO stage_labor_participants
               (session_id, employee_id, employee_code, employee_name, team_id, joined_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
            [
              Number(row.id),
              Number(employee.id || employee.employee_id),
              employee.code || employee.employee_code || null,
              employee.name || employee.employee_name || null,
              Number(resumeTeamId),
              ts,
            ]
          );
        }
        resumed.push(await mapStageSession(await getSessionById(Number(row.id), client), client));
      }

      await client.query(
        `UPDATE assembly_kiosk_teams
         SET status = 'active', lunch_paused_at = NULL, updated_at = $1::timestamptz
         WHERE machine_id = $2 AND team_id = $3 AND left_at IS NULL`,
        [ts, mid, resumeTeamId]
      );

      return okResult({
        action: 'resume_station',
        team_id: resumeTeamId,
        resumed_sessions: resumed,
        count: resumed.length,
        message: 'Team resumed — Assembly labor continues for this Team Card only.',
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

  const DOWNSTREAM_RESTORE_STATUSES = new Set([
    ASSEMBLY_STATUSES.READY_FOR_TESTING,
    ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
    ASSEMBLY_STATUSES.TESTING_FAILED,
    ASSEMBLY_STATUSES.READY_FOR_QA,
    ASSEMBLY_STATUSES.QA_IN_PROGRESS,
    ASSEMBLY_STATUSES.QA_FAILED,
  ]);

  /**
   * mode 'assembly_finish': Assembly kiosk undo of an accidental FINISH — only before Testing / QA started.
   * mode 'downstream': Testing / QA/QC kiosk (or Manager) — any Testing or QA/QC status.
   * Both return the tank to ready_for_assembly (unassigned) so any Assembly team can CONFIRM it again.
   * Test attempts history and labor are kept; open Testing attempts are marked cancelled.
   */
  async function restoreTankToAssemblyCore(tankId, opts, mode) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    const downstream = mode === 'downstream';
    const reason =
      String(opts.reason || '').trim() ||
      (downstream
        ? 'Restored to Assembly from Testing / QA/QC.'
        : 'Accidental Assembly Finish reversed before Testing started.');
    return withTransaction(async (client) => {
      const tank = await getTankById(tid, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (downstream) {
        if (!DOWNSTREAM_RESTORE_STATUSES.has(status)) {
          return errResult(
            409,
            'tank_status',
            `Restore to Assembly is only available while the tank is in Testing or QA/QC (got "${status}").`,
            { tank_status: status }
          );
        }
      } else {
        const untouchedTesting =
          status === ASSEMBLY_STATUSES.READY_FOR_TESTING &&
          !tank.testing_started_at &&
          tank.testing_machine_id == null &&
          !tank.qa_started_at;
        const untouchedLegacyQa =
          status === ASSEMBLY_STATUSES.READY_FOR_QA && !tank.qa_started_at && !tank.testing_started_at;
        // Testing passed before Assembly; the FINISH moved it to QA/QC. The Testing pass is kept.
        const untouchedQaTestedFirst =
          status === ASSEMBLY_STATUSES.READY_FOR_QA &&
          !tank.qa_started_at &&
          tankTestingDone(tank) &&
          tank.assembly_completed_at != null &&
          toMs(tank.testing_completed_at) <= toMs(tank.assembly_completed_at);
        if (!untouchedTesting && !untouchedLegacyQa && !untouchedQaTestedFirst) {
          return errResult(
            409,
            'downstream_started',
            'Restore from the Assembly kiosk is only allowed before Testing starts. Use RESTORE TO ASSEMBLY on the Testing / QA/QC kiosk.',
            {
              tank_status: status,
              testing_started_at: tank.testing_started_at || null,
              qa_started_at: tank.qa_started_at || null,
            }
          );
        }
        const machineId =
          opts.machine_id != null
            ? Number(opts.machine_id)
            : opts.machineId != null
              ? Number(opts.machineId)
              : null;
        if (Number.isInteger(machineId) && machineId > 0) {
          const owned = tank.assembly_machine_id != null ? Number(tank.assembly_machine_id) : null;
          if (owned != null && owned !== machineId) {
            const { rows: teamHere } = await client.query(
              `SELECT 1 FROM assembly_tank_teams
               WHERE tank_id = $1 AND machine_id = $2 AND status = 'finished'
               LIMIT 1`,
              [tid, machineId]
            );
            if (!teamHere.length) {
              return errResult(409, 'tank_on_other_kiosk', 'Tank was finished on another Assembly kiosk.');
            }
          }
        }
      }
      const ts = opts.at || nowIso();
      const priorFinishedAt = tank.assembly_completed_at || null;

      // Status-guarded so a double tap / second kiosk cannot restore twice.
      const upd = downstream
        ? await client.query(
            `UPDATE tanks
             SET status = $1,
                 assembly_machine_id = NULL,
                 assembly_team_id = NULL,
                 assembly_restored_at = $2::timestamptz,
                 testing_machine_id = NULL,
                 testing_confirmed_at = NULL,
                 testing_started_at = NULL,
                 testing_completed_at = NULL,
                 qa_started_at = NULL,
                 qa_completed_at = NULL,
                 qa_machine_id = NULL,
                 qa_result = NULL,
                 qa_failure_note = NULL,
                 qa_user_id = NULL,
                 qa_user_name = NULL,
                 completed_at = NULL,
                 updated_at = $2::timestamptz
             WHERE id = $3 AND LOWER(TRIM(status)) = $4`,
            [ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY, ts, tid, status]
          )
        : await client.query(
            `UPDATE tanks
             SET status = $1,
                 assembly_machine_id = NULL,
                 assembly_team_id = NULL,
                 assembly_restored_at = $2::timestamptz,
                 updated_at = $2::timestamptz
             WHERE id = $3 AND LOWER(TRIM(status)) = $4`,
            [ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY, ts, tid, status]
          );
      if (!upd.rowCount) {
        return errResult(409, 'tank_status_changed', 'Tank status changed — refresh and try again.');
      }

      let cancelledAttemptIds = [];
      if (downstream) {
        const openParents = await client.query(
          `SELECT id FROM test_attempts
           WHERE tank_id = $1
             AND UPPER(TRIM(COALESCE(test_type, ''))) = 'TESTING'
             AND LOWER(TRIM(COALESCE(attempt_status, ''))) = 'in_progress'`,
          [tid]
        );
        const parentIds = openParents.rows.map((r) => Number(r.id));
        if (parentIds.length) {
          const cancelled = await client.query(
            `UPDATE test_attempts
             SET attempt_status = 'cancelled',
                 completed_at = COALESCE(completed_at, $2::timestamptz),
                 failure_note = COALESCE(failure_note, $3)
             WHERE tank_id = $1
               AND result IS NULL
               AND LOWER(TRIM(COALESCE(attempt_status, ''))) IN ('in_progress', 'recorded')
               AND (id = ANY($4::bigint[]) OR parent_attempt_id = ANY($4::bigint[]))
             RETURNING id`,
            [tid, ts, 'Cancelled — tank restored to Assembly', parentIds]
          );
          cancelledAttemptIds = cancelled.rows.map((r) => Number(r.id));
        }
        const activeSession = await getActiveSessionForTank(tid, null, client);
        if (activeSession) {
          await closeStageSession(
            activeSession,
            ts,
            { statusTarget: 'stopped', notes: 'Restored to Assembly' },
            client
          );
        }
      }

      try {
        await client.query(
          `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz WHERE active_tank_id = $2`,
          [ts, tid]
        );
      } catch (_err) {
        /* ignore */
      }
      await client.query(
        `INSERT INTO tank_admin_phase2_audit
           (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, next_status, details)
         VALUES ('restore_to_assembly',$1,$2,$3,$4::timestamptz,$5,$6,$7,$8::jsonb)`,
        [
          tid,
          tank.tank_number,
          String(opts.performed_by || (downstream ? 'qa_kiosk' : 'assembly_kiosk')).slice(0, 200),
          ts,
          reason.slice(0, 2000),
          status,
          ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY,
          JSON.stringify(
            downstream
              ? {
                  source: String(opts.source || 'downstream_restore'),
                  machine_id: opts.machine_id != null ? Number(opts.machine_id) : null,
                  prior_assembly_completed_at: priorFinishedAt,
                  assembly_started_at: tank.assembly_started_at || null,
                  prior_testing_machine_id: tank.testing_machine_id != null ? Number(tank.testing_machine_id) : null,
                  prior_testing_started_at: tank.testing_started_at || null,
                  prior_testing_completed_at: tank.testing_completed_at || null,
                  prior_qa_started_at: tank.qa_started_at || null,
                  prior_qa_completed_at: tank.qa_completed_at || null,
                  prior_qa_result: tank.qa_result || null,
                  prior_qa_failure_note: tank.qa_failure_note || null,
                  prior_qa_user_name: tank.qa_user_name || null,
                  cancelled_test_attempt_ids: cancelledAttemptIds,
                }
              : {
                  source: 'assembly_finish_reversed',
                  prior_assembly_completed_at: priorFinishedAt,
                  assembly_started_at: tank.assembly_started_at || null,
                }
          ),
        ]
      );
      const updated = await getTankById(tid, client);
      return okResult({
        action: 'restore_to_assembly',
        tank: mapTankSummary(updated),
        previous_status: status,
        message: downstream
          ? `Tank ${tank.tank_number} restored to Assembly. It is available again on the Assembly kiosk — CONFIRM TANK to resume. Prior labor and test history are preserved.`
          : 'Tank restored to the Assembly selection list. Confirm the tank again. Prior labor and the original Finish are preserved.',
      });
    });
  }

  async function restoreTankToAssembly(tankId, opts = {}) {
    return restoreTankToAssemblyCore(tankId, opts, 'assembly_finish');
  }

  async function restoreTankToAssemblyFromDownstream(tankId, opts = {}) {
    return restoreTankToAssemblyCore(tankId, opts, 'downstream');
  }

  async function removeTankFromAssembly(tankId, opts = {}) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    const reason =
      String(opts.reason || '').trim() || 'Schedule change — removed from the Assembly shop.';
    return withTransaction(async (client) => {
      const tank = await getTankById(tid, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status !== ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS) {
        return errResult(
          409,
          'tank_status',
          `Remove from Assembly only applies to a confirmed Assembly tank (got "${status}").`,
          { tank_status: status }
        );
      }
      const machineId =
        opts.machine_id != null
          ? Number(opts.machine_id)
          : opts.machineId != null
            ? Number(opts.machineId)
            : null;
      const teamId =
        opts.team_id != null ? Number(opts.team_id) : opts.teamId != null ? Number(opts.teamId) : null;
      const teamLinks = await listActiveAssemblyTeamLinks(tid, client);
      if (teamLinks.length && Number.isInteger(teamId) && teamId > 0) {
        // Kiosk removal: any team working this tank may remove it (for all teams).
        if (!teamLinks.some((l) => l.team_id === teamId)) {
          return errResult(409, 'tank_other_team', 'This tank is not confirmed for this Assembly team.');
        }
      } else if (!teamLinks.length) {
        if (Number.isInteger(machineId) && machineId > 0) {
          const owned = tank.assembly_machine_id != null ? Number(tank.assembly_machine_id) : null;
          if (owned != null && owned !== machineId) {
            return errResult(409, 'tank_on_other_kiosk', 'Tank is confirmed on another Assembly kiosk.');
          }
        }
        if (Number.isInteger(teamId) && teamId > 0 && tank.assembly_team_id != null) {
          if (Number(tank.assembly_team_id) !== teamId) {
            return errResult(409, 'tank_other_team', 'This tank belongs to another Assembly team.');
          }
        }
      }
      const ts = opts.at || nowIso();
      for (;;) {
        const active = await getActiveSessionForTank(tid, null, client);
        if (!active) break;
        await closeStageSession(
          active,
          ts,
          {
            statusTarget: 'stopped',
            notes: `REMOVE_FROM_ASSEMBLY: ${reason}`.slice(0, 2000),
          },
          client
        );
      }
      await client.query(
        `UPDATE assembly_tank_teams
         SET status = 'removed', ended_at = $2::timestamptz, end_reason = 'remove_from_assembly',
             updated_at = $2::timestamptz
         WHERE tank_id = $1 AND status = 'active'`,
        [tid, ts]
      );
      await client.query(
        `UPDATE tanks
         SET status = $1,
             assembly_machine_id = NULL,
             assembly_team_id = NULL,
             assembly_removed_at = $2::timestamptz,
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY, ts, tid]
      );
      try {
        await client.query(
          `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz WHERE active_tank_id = $2`,
          [ts, tid]
        );
      } catch (_err) {
        /* ignore */
      }
      await client.query(
        `INSERT INTO tank_admin_phase2_audit
           (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, next_status, details)
         VALUES ('remove_from_assembly',$1,$2,$3,$4::timestamptz,$5,$6,$7,$8::jsonb)`,
        [
          tid,
          tank.tank_number,
          String(opts.performed_by || 'assembly_kiosk').slice(0, 200),
          ts,
          reason.slice(0, 2000),
          status,
          ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY,
          JSON.stringify({
            source: 'assembly_schedule_change',
            assembly_started_at: tank.assembly_started_at || null,
            prior_team_id: tank.assembly_team_id != null ? Number(tank.assembly_team_id) : null,
            prior_team_ids: teamLinks.map((l) => l.team_id),
          }),
        ]
      );
      const updated = await getTankById(tid, client);
      return okResult({
        action: 'remove_from_assembly',
        tank: mapTankSummary(updated),
        message:
          'Tank removed from the Assembly schedule. It is not Ready for QA and was not deleted. Prior labor is preserved.',
      });
    });
  }

  /** Tanks parked by REMOVE FROM ASSEMBLY — candidates for the kiosk "Return Tank to Assembly" dropdown. */
  async function listRemovedFromAssemblyTanks() {
    const { rows } = await pool.query(
      `SELECT id, tank_number, assembly_removed_at
       FROM tanks
       WHERE deleted_at IS NULL
         AND completed_at IS NULL
         AND LOWER(TRIM(status)) = $1
       ORDER BY tank_number ASC`,
      [ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      tank_number: r.tank_number,
      assembly_removed_at: r.assembly_removed_at || null,
    }));
  }

  /**
   * Schedule change reversed: removed_from_assembly → ready_for_assembly (unassigned pool).
   * Keeps FAB completion, assembly_started_at, labor sessions and audit history.
   * Does NOT confirm the tank or start labor — the team uses CONFIRM TANK as usual.
   */
  async function returnRemovedTankToAssembly(tankId, opts = {}) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    const reason =
      String(opts.reason || '').trim() || 'Schedule change — tank returned to the Assembly shop.';
    return withTransaction(async (client) => {
      const tank = await getTankById(tid, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status !== ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY) {
        return errResult(
          409,
          'not_removed',
          status === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY
            ? `Tank ${tank.tank_number} was already returned to Assembly.`
            : `Tank ${tank.tank_number} is not Removed from Assembly (status "${status}").`,
          { tank_status: status }
        );
      }
      if (tank.completed_at) {
        return errResult(409, 'tank_completed', 'Tank is already completed and cannot return to Assembly.');
      }
      const ts = opts.at || nowIso();
      // Status guard in the UPDATE makes concurrent duplicate returns a no-op for the loser.
      const upd = await client.query(
        `UPDATE tanks
         SET status = $1,
             assembly_machine_id = NULL,
             assembly_team_id = NULL,
             assembly_restored_at = $2::timestamptz,
             updated_at = $2::timestamptz
         WHERE id = $3
           AND LOWER(TRIM(status)) = $4`,
        [ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY, ts, tid, ASSEMBLY_STATUSES.REMOVED_FROM_ASSEMBLY]
      );
      if (!upd.rowCount) {
        return errResult(409, 'not_removed', `Tank ${tank.tank_number} was already returned to Assembly.`);
      }
      const machineId =
        opts.machine_id != null ? Number(opts.machine_id) : opts.machineId != null ? Number(opts.machineId) : null;
      await client.query(
        `INSERT INTO tank_admin_phase2_audit
           (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, next_status, details)
         VALUES ('return_to_assembly',$1,$2,$3,$4::timestamptz,$5,$6,$7,$8::jsonb)`,
        [
          tid,
          tank.tank_number,
          String(opts.performed_by || 'assembly_kiosk').slice(0, 200),
          ts,
          reason.slice(0, 2000),
          status,
          ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY,
          JSON.stringify({
            source: 'assembly_kiosk_return_removed',
            machine_id: Number.isInteger(machineId) && machineId > 0 ? machineId : null,
            assembly_removed_at: tank.assembly_removed_at || null,
            assembly_started_at: tank.assembly_started_at || null,
            fab_completed_at: tank.fab_completed_at || null,
          }),
        ]
      );
      const updated = await getTankById(tid, client);
      return okResult({
        action: 'return_to_assembly',
        tank: mapTankSummary(updated),
        message: `Tank ${tank.tank_number} returned to Assembly. Select it and press CONFIRM TANK to continue.`,
      });
    });
  }

  async function recordQaResult(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    const result = normalizeTestResult(opts.result);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    if (!result) {
      return errResult(400, 'validation', 'result must be PASS or FAIL.');
    }
    const note = String(opts.note || opts.failure_note || '').trim();
    if (result === 'FAIL' && !note) {
      return errResult(400, 'validation', 'A failure reason is required for QA FAIL.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (
        status !== ASSEMBLY_STATUSES.READY_FOR_QA &&
        status !== ASSEMBLY_STATUSES.QA_IN_PROGRESS &&
        status !== ASSEMBLY_STATUSES.QA_FAILED
      ) {
        return errResult(409, 'tank_status', `QA actions require Ready for QA (got "${status}").`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      // Legacy tanks that reached QA before Testing (old order) still need Testing after QA PASS.
      const legacyNeedsTesting = tankRequiresTest(tank) && !tank.testing_completed_at;
      const nextStatus =
        result === 'PASS'
          ? legacyNeedsTesting
            ? ASSEMBLY_STATUSES.READY_FOR_TESTING
            : ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL
          : ASSEMBLY_STATUSES.QA_FAILED;
      await client.query(
        `INSERT INTO test_attempts
           (tank_id, machine_id, result, attempted_at, failure_note, previous_status,
            test_type, attempt_status, started_at, completed_at, tester_user_id, tester_user_name,
            tester_employee_name, created_at)
         VALUES ($1,$2,$3,$4::timestamptz,$5,$6,'QA',$7,$4::timestamptz,$4::timestamptz,$8,$9,$9,NOW())`,
        [
          tankId,
          Number.isInteger(mid) && mid > 0 ? mid : null,
          result,
          ts,
          result === 'FAIL' ? note : null,
          status,
          result === 'PASS' ? 'passed' : 'failed',
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
        ]
      );
      await client.query(
        `UPDATE tanks
         SET status = $1,
             qa_started_at = COALESCE(qa_started_at, $2::timestamptz),
             qa_completed_at = $2::timestamptz,
             qa_machine_id = COALESCE($3, qa_machine_id),
             qa_result = $4,
             qa_failure_note = $5,
             qa_user_id = $6,
             qa_user_name = $7,
             updated_at = $2::timestamptz
         WHERE id = $8`,
        [
          nextStatus,
          ts,
          Number.isInteger(mid) && mid > 0 ? mid : null,
          result,
          result === 'FAIL' ? note : null,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
          tankId,
        ]
      );
      const updated = await getTankById(tankId, client);
      return okResult({
        action: 'qa_result',
        result,
        next_status: nextStatus,
        tank: mapTankSummary(updated),
        message:
          result === 'PASS'
            ? nextStatus === ASSEMBLY_STATUSES.READY_FOR_TESTING
              ? 'QA PASS — tank is Ready for Testing.'
              : 'QA PASS — tank is Completed (Ready for Dome Install).'
            : 'QA FAIL recorded. Tank marked QA Failed with reason preserved.',
      });
    });
  }

  async function startVacuumTest(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    const startInHg = Number(opts.vacuum_start_inhg != null ? opts.vacuum_start_inhg : opts.start_inhg);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    if (!Number.isFinite(startInHg)) {
      return errResult(400, 'validation', 'Vacuum starting reading (inHg) is required.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (!tankTestingWorkOpen(tank)) {
        return errResult(
          409,
          'tank_status',
          status === ASSEMBLY_STATUSES.READY_FOR_TESTING || status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS
            ? 'Press START TESTING before Vacuum.'
            : `Vacuum requires Testing in progress (got "${status}").`
        );
      }
      const user = opts.user || {};
      const parentId = await ensureOpenTestingAttempt(tankId, machine, user, client, status);
      const ctx = await getTestingFailureContext(tankId, client);
      if (ctx.vacuum_passed) {
        return errResult(
          409,
          'vacuum_already_passed',
          'Vacuum already PASSED for this Testing attempt. Press READY FOR QA/QC.'
        );
      }
      if (ctx.selected_test === 'BRINE') {
        return errResult(
          409,
          'brine_selected',
          'Brine was selected for this Testing attempt. Vacuum is not required — finish Brine and press TEST COMPLETE.'
        );
      }
      if (ctx.pending_vacuum_result) {
        return errResult(
          409,
          'vacuum_pending_result',
          'Vacuum end reading is already recorded. Choose PASS or FAIL for that Vacuum test first.'
        );
      }
      if (ctx.open_vacuum_attempt_id) {
        return errResult(
          409,
          'vacuum_open',
          'A Vacuum test is already in progress. Press RECORD END VACUUM and enter the ending reading.',
          { open_vacuum_attempt_id: ctx.open_vacuum_attempt_id }
        );
      }
      const ts = opts.at || nowIso();
      const insert = await client.query(
        `INSERT INTO test_attempts
           (tank_id, machine_id, attempted_at, previous_status, test_type, attempt_status,
            started_at, vacuum_start_inhg, parent_attempt_id,
            tester_user_id, tester_user_name, tester_employee_name, created_at)
         VALUES ($1,$2,$3::timestamptz,$4,'VACUUM','in_progress',$3::timestamptz,$5,$6,$7,$8,$8,NOW())
         RETURNING id`,
        [
          tankId,
          mid,
          ts,
          status,
          startInHg,
          parentId,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
        ]
      );
      await client.query(
        `UPDATE tanks
         SET testing_machine_id = COALESCE($1, testing_machine_id),
             updated_at = $2::timestamptz
         WHERE id = $3`,
        [mid, ts, tankId]
      );
      return okResult({
        action: 'vacuum_start',
        attempt_id: Number(insert.rows[0].id),
        testing_attempt_id: parentId,
        vacuum_start_inhg: startInHg,
        started_at: ts,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Vacuum start recorded. Enter ending inHg when ready.',
      });
    });
  }

  /** Record ending Vacuum inHg — then UI must call recordVacuumResult (PASS/FAIL). */
  async function completeVacuumTest(machine, opts = {}) {
    const attemptId = Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId);
    const endInHg = Number(opts.vacuum_end_inhg != null ? opts.vacuum_end_inhg : opts.end_inhg);
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return errResult(400, 'validation', 'attempt_id is required (Vacuum attempt).');
    }
    if (!Number.isFinite(endInHg)) {
      return errResult(400, 'validation', 'Vacuum ending reading (inHg) is required.');
    }
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Vacuum attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'VACUUM') {
        return errResult(
          409,
          'wrong_type',
          `Attempt #${attemptId} is ${attempt.test_type || 'unknown'}, not Vacuum. Use the Vacuum Complete action with the Vacuum attempt id.`
        );
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'passed' || prior === 'failed') {
        return errResult(409, 'already_complete', 'This Vacuum attempt already has a PASS/FAIL result.');
      }
      if (prior === 'recorded' && attempt.vacuum_end_inhg != null) {
        return errResult(
          409,
          'awaiting_result',
          'Vacuum end reading already recorded. Choose PASS or FAIL.'
        );
      }
      const tank = await getTankById(Number(attempt.tank_id), client);
      if (!tank || !tankTestingWorkOpen(tank)) {
        return errResult(409, 'tank_status', 'Vacuum end requires Testing in progress.');
      }
      const ts = opts.at || nowIso();
      const startInHg = Number(attempt.vacuum_start_inhg);
      const delta = Number.isFinite(startInHg) ? endInHg - startInHg : null;
      await client.query(
        `UPDATE test_attempts
         SET vacuum_end_inhg = $1,
             completed_at = $2::timestamptz,
             attempt_status = 'recorded',
             result = NULL
         WHERE id = $3`,
        [endInHg, ts, attemptId]
      );
      const tankId = Number(attempt.tank_id);
      const startMs = toMs(attempt.started_at || attempt.attempted_at);
      const elapsedMs = startMs != null ? Math.max(0, toMs(ts) - startMs) : 0;
      return okResult({
        action: 'vacuum_complete',
        attempt_id: attemptId,
        testing_attempt_id: attempt.parent_attempt_id != null ? Number(attempt.parent_attempt_id) : null,
        vacuum_start_inhg: startInHg,
        vacuum_end_inhg: endInHg,
        vacuum_delta_inhg: delta,
        elapsed_ms: elapsedMs,
        elapsed_display: formatDurationXhYm(elapsedMs),
        needs_result: true,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Vacuum data recorded. Choose PASS or FAIL.',
      });
    });
  }

  /** Vacuum PASS → stays in Testing; READY FOR QA/QC unlocks. Vacuum FAIL → FAILED / HOLD (testing_failed). */
  async function recordVacuumResult(machine, opts = {}) {
    const attemptId = Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId);
    const result = normalizeTestResult(opts.result);
    const note = String(opts.note || opts.failure_note || '').trim();
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return errResult(400, 'validation', 'attempt_id is required (Vacuum attempt).');
    }
    if (!result) {
      return errResult(400, 'validation', 'result must be PASS or FAIL.');
    }
    if (result === 'FAIL' && !note) {
      return errResult(400, 'validation', 'A failure reason is required for Vacuum FAIL.');
    }
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Vacuum attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'VACUUM') {
        return errResult(409, 'wrong_type', 'Not a Vacuum attempt.');
      }
      if (attempt.vacuum_end_inhg == null) {
        return errResult(409, 'incomplete', 'Record the ending Vacuum reading before PASS/FAIL.');
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'passed' || prior === 'failed' || normalizeTestResult(attempt.result)) {
        return errResult(409, 'already_complete', 'This Vacuum attempt already has a result.');
      }
      const tankId = Number(attempt.tank_id);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      if (!tankTestingWorkOpen(tank)) {
        return errResult(409, 'tank_status', 'Vacuum result requires Testing in progress.');
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      await client.query(
        `UPDATE test_attempts
         SET result = $1,
             attempt_status = $2,
             failure_note = $3,
             completed_at = COALESCE(completed_at, $4::timestamptz),
             tester_user_id = COALESCE($5, tester_user_id),
             tester_user_name = COALESCE($6, tester_user_name)
         WHERE id = $7`,
        [
          result,
          result === 'PASS' ? 'passed' : 'failed',
          result === 'FAIL' ? note : null,
          ts,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
          attemptId,
        ]
      );

      const parentId =
        attempt.parent_attempt_id != null ? Number(attempt.parent_attempt_id) : null;
      // PASS keeps the tank in Testing; the operator presses READY FOR QA/QC to move it on.
      let nextStatus = ASSEMBLY_STATUSES.TESTING_IN_PROGRESS;
      if (result === 'FAIL') {
        nextStatus = ASSEMBLY_STATUSES.TESTING_FAILED;
        if (parentId) {
          await client.query(
            `UPDATE test_attempts
             SET result = 'FAIL',
                 attempt_status = 'failed',
                 failure_note = $1,
                 completed_at = COALESCE(completed_at, $2::timestamptz)
             WHERE id = $3
               AND UPPER(TRIM(COALESCE(test_type, ''))) = 'TESTING'
               AND LOWER(TRIM(COALESCE(attempt_status, ''))) = 'in_progress'`,
            [note.slice(0, 4000), ts, parentId]
          );
        }
        await client.query(
          `UPDATE tanks
           SET status = $1,
               updated_at = $2::timestamptz
           WHERE id = $3`,
          [ASSEMBLY_STATUSES.TESTING_FAILED, ts, tankId]
        );
      }

      const startInHg = Number(attempt.vacuum_start_inhg);
      const endInHg = Number(attempt.vacuum_end_inhg);
      const startMs = toMs(attempt.started_at || attempt.attempted_at);
      const endMs = toMs(attempt.completed_at) || toMs(ts);
      const elapsedMs = startMs != null && endMs != null ? Math.max(0, endMs - startMs) : 0;
      return okResult({
        action: 'vacuum_result',
        attempt_id: attemptId,
        testing_attempt_id: parentId,
        result,
        next_status: nextStatus,
        vacuum_start_inhg: startInHg,
        vacuum_end_inhg: endInHg,
        vacuum_delta_inhg:
          Number.isFinite(startInHg) && Number.isFinite(endInHg) ? endInHg - startInHg : null,
        elapsed_ms: elapsedMs,
        elapsed_display: formatDurationXhYm(elapsedMs),
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message:
          result === 'PASS'
            ? 'Vacuum PASS — press READY FOR QA/QC to send the tank to QA/QC.'
            : 'Vacuum FAIL — tank moved to FAILED / HOLD.',
      });
    });
  }

  async function startBrineFill(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    const expected = Number(
      opts.brine_expected_amount != null ? opts.brine_expected_amount : opts.expected_amount
    );
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    if (!Number.isFinite(expected)) {
      return errResult(400, 'validation', 'Expected brine amount is required.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (!tankTestingWorkOpen(tank)) {
        return errResult(
          409,
          'tank_status',
          status === ASSEMBLY_STATUSES.READY_FOR_TESTING || status === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS
            ? 'Press START TESTING before Brine.'
            : `Brine requires Testing in progress (got "${status}").`
        );
      }
      const user = opts.user || {};
      const parentId = await ensureOpenTestingAttempt(tankId, machine, user, client, status);
      const ctx = await getTestingFailureContext(tankId, client);
      if (ctx.selected_test === 'VACUUM') {
        return errResult(
          409,
          'vacuum_selected',
          'Vacuum was selected for this Testing attempt. Brine is not required — finish the Vacuum test.'
        );
      }
      if (ctx.open_brine_attempt_id) {
        return errResult(
          409,
          'brine_open',
          'A Brine fill is already in progress. Press STOP FILL and enter the actual amount.',
          { open_brine_attempt_id: ctx.open_brine_attempt_id }
        );
      }
      if (ctx.brine_completed) {
        return errResult(
          409,
          'brine_already_recorded',
          ctx.brine_passed
            ? 'Brine already PASSED for this Testing attempt. Press READY FOR QA/QC.'
            : 'Brine is already recorded for this Testing attempt. Choose Brine PASS or FAIL.'
        );
      }
      const ts = opts.at || nowIso();
      const insert = await client.query(
        `INSERT INTO test_attempts
           (tank_id, machine_id, attempted_at, previous_status, test_type, attempt_status,
            started_at, brine_expected_amount, parent_attempt_id,
            tester_user_id, tester_user_name, tester_employee_name, created_at)
         VALUES ($1,$2,$3::timestamptz,$4,'BRINE','in_progress',$3::timestamptz,$5,$6,$7,$8,$8,NOW())
         RETURNING id`,
        [
          tankId,
          mid,
          ts,
          status,
          expected,
          parentId,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
        ]
      );
      return okResult({
        action: 'brine_start',
        attempt_id: Number(insert.rows[0].id),
        testing_attempt_id: parentId,
        brine_expected_amount: expected,
        started_at: ts,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Brine fill started. Enter actual amount when stopping fill.',
      });
    });
  }

  /** Record actual brine amount only — does NOT set overall Testing PASS/FAIL. */
  async function stopBrineFill(machine, opts = {}) {
    const attemptId = Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId);
    const actual = Number(
      opts.brine_actual_amount != null ? opts.brine_actual_amount : opts.actual_amount
    );
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return errResult(400, 'validation', 'attempt_id is required (Brine attempt).');
    }
    if (!Number.isFinite(actual)) {
      return errResult(400, 'validation', 'Actual brine amount is required.');
    }
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Brine attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'BRINE') {
        return errResult(
          409,
          'wrong_type',
          `Attempt #${attemptId} is ${attempt.test_type || 'unknown'}, not Brine. Use Stop Fill with the Brine attempt id.`
        );
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'recorded' || prior === 'passed' || prior === 'failed') {
        return errResult(409, 'already_complete', 'This Brine measurement is already recorded.');
      }
      const tank = await getTankById(Number(attempt.tank_id), client);
      if (!tank || !tankTestingWorkOpen(tank)) {
        return errResult(409, 'tank_status', 'Brine stop requires Testing in progress.');
      }
      const ts = opts.at || nowIso();
      const expected = Number(attempt.brine_expected_amount);
      const variance = Number.isFinite(expected) ? actual - expected : null;
      await client.query(
        `UPDATE test_attempts
         SET brine_actual_amount = $1,
             completed_at = $2::timestamptz,
             attempt_status = 'recorded',
             result = NULL
         WHERE id = $3`,
        [actual, ts, attemptId]
      );
      const tankId = Number(attempt.tank_id);
      const startMs = toMs(attempt.started_at || attempt.attempted_at);
      const elapsedMs = startMs != null ? Math.max(0, toMs(ts) - startMs) : 0;
      return okResult({
        action: 'brine_stop',
        attempt_id: attemptId,
        testing_attempt_id: attempt.parent_attempt_id != null ? Number(attempt.parent_attempt_id) : null,
        brine_expected_amount: expected,
        brine_actual_amount: actual,
        brine_variance: variance,
        elapsed_ms: elapsedMs,
        elapsed_display: formatDurationXhYm(elapsedMs),
        needs_result: true,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Brine data recorded. Choose PASS or FAIL.',
      });
    });
  }

  /** Brine PASS → stays in Testing; READY FOR QA/QC unlocks. Brine FAIL → FAILED / HOLD (testing_failed). */
  async function recordBrineResult(machine, opts = {}) {
    const attemptId = Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId);
    const result = normalizeTestResult(opts.result);
    const note = String(opts.note || opts.failure_note || '').trim();
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return errResult(400, 'validation', 'attempt_id is required (Brine attempt).');
    }
    if (!result) {
      return errResult(400, 'validation', 'result must be PASS or FAIL.');
    }
    if (result === 'FAIL' && !note) {
      return errResult(400, 'validation', 'A failure reason is required for Brine FAIL.');
    }
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Brine attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'BRINE') {
        return errResult(409, 'wrong_type', 'Not a Brine attempt.');
      }
      if (attempt.brine_actual_amount == null) {
        return errResult(409, 'incomplete', 'Press STOP FILL and record the actual amount before PASS/FAIL.');
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'passed' || prior === 'failed' || prior === 'cancelled' || normalizeTestResult(attempt.result)) {
        return errResult(409, 'already_complete', 'This Brine attempt already has a result.');
      }
      const tankId = Number(attempt.tank_id);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      if (!tankTestingWorkOpen(tank)) {
        return errResult(409, 'tank_status', 'Brine result requires Testing in progress.');
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      await client.query(
        `UPDATE test_attempts
         SET result = $1,
             attempt_status = $2,
             failure_note = $3,
             completed_at = COALESCE(completed_at, $4::timestamptz),
             tester_user_id = COALESCE($5, tester_user_id),
             tester_user_name = COALESCE($6, tester_user_name)
         WHERE id = $7`,
        [
          result,
          result === 'PASS' ? 'passed' : 'failed',
          result === 'FAIL' ? note : null,
          ts,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
          attemptId,
        ]
      );
      const parentId =
        attempt.parent_attempt_id != null ? Number(attempt.parent_attempt_id) : null;
      if (result === 'FAIL') {
        if (parentId) {
          await client.query(
            `UPDATE test_attempts
             SET result = 'FAIL',
                 attempt_status = 'failed',
                 failure_note = $1,
                 completed_at = COALESCE(completed_at, $2::timestamptz)
             WHERE id = $3
               AND UPPER(TRIM(COALESCE(test_type, ''))) = 'TESTING'
               AND LOWER(TRIM(COALESCE(attempt_status, ''))) = 'in_progress'`,
            [note.slice(0, 4000), ts, parentId]
          );
        }
        await client.query(
          `UPDATE tanks SET status = $1, updated_at = $2::timestamptz WHERE id = $3`,
          [ASSEMBLY_STATUSES.TESTING_FAILED, ts, tankId]
        );
      }
      return okResult({
        action: 'brine_result',
        attempt_id: attemptId,
        testing_attempt_id: parentId,
        result,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message:
          result === 'PASS'
            ? 'Brine PASS — press READY FOR QA/QC to send the tank to QA/QC.'
            : 'Brine FAIL — tank moved to FAILED / HOLD.',
      });
    });
  }

  /**
   * READY FOR QA/QC — the selected test (Vacuum OR Brine) PASSED on the open Testing attempt.
   * Closes the Testing attempt as PASS and moves the tank to ready_for_qa. Does NOT start QA.
   */
  async function markTestingReadyForQa(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    return withTransaction(async (client) => {
      await client.query(`SELECT id FROM tanks WHERE id = $1 FOR UPDATE`, [tankId]);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (!tankTestingWorkOpen(tank) && status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS) {
        return errResult(
          409,
          'tank_status',
          `READY FOR QA/QC requires Testing in progress (got "${status}").`,
          { tank_status: status }
        );
      }
      const ctx = await getTestingFailureContext(tankId, client);
      if (!ctx.can_ready_for_qa) {
        let message = 'Complete the selected test with PASS (Vacuum or Brine) before READY FOR QA/QC.';
        if (ctx.open_vacuum_attempt_id) message = 'Record the ending Vacuum reading first.';
        else if (ctx.open_brine_attempt_id) message = 'Press STOP FILL for the open Brine test first.';
        else if (ctx.pending_vacuum_result) message = 'Choose Vacuum PASS or FAIL first.';
        else if (ctx.pending_brine_result) message = 'Choose Brine PASS or FAIL first.';
        return errResult(409, 'test_not_passed', message);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      const parentId = ctx.open_testing_attempt_id;
      await client.query(
        `UPDATE test_attempts
         SET result = 'PASS',
             attempt_status = 'passed',
             completed_at = COALESCE(completed_at, $1::timestamptz),
             machine_id = COALESCE(machine_id, $2),
             tester_user_id = COALESCE($3, tester_user_id),
             tester_user_name = COALESCE($4, tester_user_name)
         WHERE id = $5
           AND UPPER(TRIM(COALESCE(test_type, ''))) = 'TESTING'`,
        [ts, mid, user.id != null ? Number(user.id) : null, user.name || user.username || null, parentId]
      );
      const nextStatus = await markTankTestingPassed(tank, ts, client);
      return okResult({
        action: 'ready_for_qa',
        testing_attempt_id: parentId,
        selected_test: ctx.vacuum_passed ? 'VACUUM' : 'BRINE',
        next_status: nextStatus,
        tank: mapTankSummary(await getTankById(tankId, client)),
        message:
          nextStatus === ASSEMBLY_STATUSES.READY_FOR_QA
            ? `Tank ${tank.tank_number} moved to Ready for QA/QC. Press START QA when ready.`
            : nextStatus === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS
              ? `Tank ${tank.tank_number} passed Testing — Assembly is still in progress. Tank goes to QA/QC when Assembly finishes.`
              : `Tank ${tank.tank_number} passed Testing — moved to Ready for Assembly. It goes to QA/QC after Assembly finishes.`,
      });
    });
  }

  /**
   * Testing PASS → ready_for_qa when Assembly is done; otherwise keep Assembly working
   * (assembly_in_progress) or return to ready_for_assembly. Preserves concurrent Assembly ownership.
   */
  async function markTankTestingPassed(tank, ts, client) {
    const fresh = (await getTankById(Number(tank.id), client)) || tank;
    const nextStatus = nextStatusAfterTestingPass(fresh);
    const clearAssemblyOwner = nextStatus === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY;
    await client.query(
      `UPDATE tanks
       SET status = $1,
           testing_completed_at = COALESCE(testing_completed_at, $2::timestamptz),
           assembly_machine_id = CASE WHEN $4::boolean THEN NULL ELSE assembly_machine_id END,
           assembly_team_id = CASE WHEN $4::boolean THEN NULL ELSE assembly_team_id END,
           updated_at = $2::timestamptz
       WHERE id = $3`,
      [nextStatus, ts, Number(tank.id), clearAssemblyOwner]
    );
    return nextStatus;
  }

  function testingPassMessage(nextStatus) {
    if (nextStatus === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY) {
      return 'Testing PASS — Assembly still required. Tank moved to Ready for Assembly; it goes to QA/QC after Assembly finishes.';
    }
    if (nextStatus === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS) {
      return 'Testing PASS — Assembly is still in progress. Tank goes to QA/QC when Assembly finishes.';
    }
    return 'Testing PASS — tank moved to Ready for QA/QC.';
  }

  /**
   * TEST COMPLETE — final PASS/FAIL after the selected test (Vacuum PASS or Brine fill recorded).
   * FAIL → testing_failed (FAILED/HOLD). PASS → ready_for_qa (see markTankTestingPassed).
   */
  async function completeTesting(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    const result = normalizeTestResult(opts.result);
    const note = String(opts.note || opts.failure_note || '').trim();
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    if (!result) {
      return errResult(400, 'validation', 'result must be PASS or FAIL.');
    }
    if (result === 'FAIL' && !note) {
      return errResult(400, 'validation', 'A failure reason is required for Testing FAIL.');
    }
    return withTransaction(async (client) => {
      await client.query('SELECT id FROM tanks WHERE id = $1 FOR UPDATE', [tankId]);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (!tankTestingWorkOpen(tank)) {
        return errResult(409, 'tank_status', `TEST COMPLETE requires Testing in progress (got "${status}").`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      let attemptId =
        opts.attempt_id != null || opts.attemptId != null
          ? Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId)
          : null;
      if (!Number.isInteger(attemptId) || attemptId <= 0) {
        attemptId = await ensureOpenTestingAttempt(tankId, machine, user, client, status);
      }
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Testing attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'TESTING') {
        return errResult(
          409,
          'wrong_type',
          `Attempt #${attemptId} is ${attempt.test_type || 'unknown'}, not overall Testing. TEST COMPLETE must target the TESTING attempt.`
        );
      }
      if (Number(attempt.tank_id) !== tankId) {
        return errResult(409, 'tank_mismatch', 'Testing attempt does not belong to this tank.');
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'passed' || prior === 'failed') {
        return errResult(409, 'already_complete', 'This Testing attempt is already complete.');
      }
      const ctx = await getTestingFailureContext(tankId, client);
      if (ctx.open_brine_attempt_id) {
        return errResult(409, 'brine_open', 'Finish the open Brine fill (STOP FILL) before TEST COMPLETE.');
      }
      if (ctx.open_vacuum_attempt_id) {
        return errResult(409, 'vacuum_open', 'Record the ending Vacuum reading before TEST COMPLETE.');
      }
      if (ctx.pending_vacuum_result) {
        return errResult(409, 'vacuum_pending_result', 'Choose Vacuum PASS or FAIL before TEST COMPLETE.');
      }
      if (!ctx.vacuum_passed && !ctx.brine_completed) {
        return errResult(
          409,
          'test_required',
          'Complete the selected test (Vacuum PASS or Brine START FILL + STOP FILL) before TEST COMPLETE.'
        );
      }
      await client.query(
        `UPDATE test_attempts
         SET result = $1,
             attempt_status = $2,
             failure_note = $3,
             completed_at = $4::timestamptz,
             machine_id = COALESCE($5, machine_id),
             tester_user_id = COALESCE($6, tester_user_id),
             tester_user_name = COALESCE($7, tester_user_name)
         WHERE id = $8`,
        [
          result,
          result === 'PASS' ? 'passed' : 'failed',
          result === 'FAIL' ? note : null,
          ts,
          mid,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
          attemptId,
        ]
      );
      let nextStatus = ASSEMBLY_STATUSES.TESTING_FAILED;
      if (result === 'PASS') {
        nextStatus = await markTankTestingPassed(tank, ts, client);
      } else {
        await client.query(
          `UPDATE tanks
           SET status = $1,
               updated_at = $2::timestamptz
           WHERE id = $3`,
          [ASSEMBLY_STATUSES.TESTING_FAILED, ts, tankId]
        );
      }
      return okResult({
        action: 'testing_complete',
        attempt_id: attemptId,
        result,
        next_status: nextStatus,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message:
          result === 'PASS'
            ? testingPassMessage(nextStatus)
            : 'Testing FAIL — tank moved to FAILED / HOLD. Retest or Send Back to FAB Rework.',
      });
    });
  }

  /** From testing_failed → new TESTING attempt (history preserved). Not FAB. */
  async function retestTesting(machine, opts = {}) {
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    return withTransaction(async (client) => {
      await client.query('SELECT id FROM tanks WHERE id = $1 FOR UPDATE', [tankId]);
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status !== ASSEMBLY_STATUSES.TESTING_FAILED) {
        return errResult(409, 'tank_status', `RETEST requires Testing Failed / Hold (got "${status}").`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      await client.query(
        `UPDATE tanks
         SET status = $1,
             testing_machine_id = COALESCE($2, testing_machine_id),
             updated_at = $3::timestamptz
         WHERE id = $4`,
        [
          ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
          Number(machine && machine.id) > 0 ? Number(machine.id) : null,
          ts,
          tankId,
        ]
      );
      const attemptId = await ensureOpenTestingAttempt(
        tankId,
        machine,
        user,
        client,
        ASSEMBLY_STATUSES.TESTING_FAILED
      );
      return okResult({
        action: 'testing_retest',
        attempt_id: attemptId,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Retest started — new Testing attempt. Previous FAIL history preserved.',
      });
    });
  }

  /**
   * SEND BACK TO FAB REWORK — reuses existing rework_required FAB workflow.
   * FAB Tank Complete after rework returns tank to ready_for_testing (existing phase1 logic).
   */
  async function sendTestingFailToFabRework(machine, opts = {}) {
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
      const fromQa = status === ASSEMBLY_STATUSES.QA_FAILED;
      if (status !== ASSEMBLY_STATUSES.TESTING_FAILED && !fromQa) {
        return errResult(
          409,
          'tank_status',
          `Send Back to FAB Rework requires Testing or QA/QC Failed / Hold (got "${status}").`
        );
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      const reason = String(opts.reason || opts.note || opts.failure_note || '').trim();
      let failNote = reason;
      if (!failNote && fromQa) {
        failNote = tank.qa_failure_note || 'QA/QC FAIL — sent to FAB rework';
      } else if (!failNote) {
        const ctx = await getTestingFailureContext(tankId, client);
        failNote =
          (ctx.latest_failed_vacuum && ctx.latest_failed_vacuum.failure_note) ||
          (ctx.latest_failed_brine && ctx.latest_failed_brine.failure_note) ||
          (ctx.latest_failed_testing && ctx.latest_failed_testing.failure_note) ||
          'Testing FAIL — sent to FAB rework';
      }

      // Reuse existing FAB rework_required state (same path FAB kiosks already honor).
      // QA columns (qa_result / qa_failure_note / qa_user_*) and test_attempts history are left intact.
      const upd = await client.query(
        `UPDATE tanks
         SET status = 'rework_required',
             testing_machine_id = NULL,
             testing_confirmed_at = NULL,
             requires_test = TRUE,
             completed_at = NULL,
             updated_at = $1::timestamptz
         WHERE id = $2 AND LOWER(TRIM(status)) = $3`,
        [ts, tankId, status]
      );
      if (!upd.rowCount) {
        return errResult(409, 'tank_status_changed', 'Tank status changed — refresh and try again.');
      }

      try {
        await client.query(
          `INSERT INTO tank_admin_phase2_audit
             (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, next_status, details)
           VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,'rework_required',$8::jsonb)`,
          [
            fromQa ? 'qa_fail_to_fab_rework' : 'testing_fail_to_fab_rework',
            tankId,
            tank.tank_number,
            user.name || user.username || 'qa_kiosk',
            ts,
            failNote.slice(0, 4000),
            status,
            JSON.stringify(
              fromQa
                ? {
                    source: 'qa_fail',
                    machine_id: machine && machine.id != null ? Number(machine.id) : null,
                    qa_result: tank.qa_result || null,
                    qa_failure_note: tank.qa_failure_note || null,
                    qa_completed_at: tank.qa_completed_at || null,
                    qa_user_name: tank.qa_user_name || null,
                    testing_completed_at: tank.testing_completed_at || null,
                  }
                : {
                    source: 'vacuum_fail',
                    machine_id: machine && machine.id != null ? Number(machine.id) : null,
                  }
            ),
          ]
        );
      } catch (_err) {
        /* audit table optional until migrate */
      }

      if (Number(machine && machine.id) > 0) {
        try {
          await client.query(
            `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz
             WHERE id = $2 AND active_tank_id = $3`,
            [ts, Number(machine.id), tankId]
          );
        } catch (_err) {
          /* ignore */
        }
      }

      return okResult({
        action: 'send_to_fab_rework',
        tank: mapTankSummary(await getTankById(tankId, client)),
        message:
          'Tank sent to existing FAB Rework Required workflow. Scan on a Winding kiosk, correct, then Tank Complete to return to Testing.',
        rework_reason: failNote,
      });
    });
  }

  async function appendTestAttemptNote(opts = {}) {
    const attemptId = Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId);
    const body = String(opts.body || opts.note || '').trim();
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return errResult(400, 'validation', 'attempt_id is required.');
    }
    if (!body) {
      return errResult(400, 'validation', 'Note text is required.');
    }
    const { rows } = await pool.query(`SELECT id, tank_id FROM test_attempts WHERE id = $1`, [
      attemptId,
    ]);
    if (!rows.length) return errResult(404, 'not_found', 'Test attempt not found.');
    const user = opts.user || {};
    const insert = await pool.query(
      `INSERT INTO test_attempt_notes
         (test_attempt_id, tank_id, body, author_user_id, author_user_name, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING id, created_at`,
      [
        attemptId,
        Number(rows[0].tank_id),
        body.slice(0, 4000),
        user.id != null ? Number(user.id) : null,
        user.name || user.username || null,
      ]
    );
    return okResult({
      action: 'test_note_appended',
      note: {
        id: Number(insert.rows[0].id),
        test_attempt_id: attemptId,
        body: body.slice(0, 4000),
        author_user_name: user.name || user.username || null,
        created_at: insert.rows[0].created_at,
      },
    });
  }

  async function listTestAttemptsForTank(tankId) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return [];
    const { rows } = await pool.query(
      `SELECT id, tank_id, machine_id, team_id, team_name, result, attempted_at,
              tester_employee_id, tester_employee_name, failure_note, labor_session_id, created_at,
              previous_status, test_type, attempt_status, started_at, completed_at,
              vacuum_start_inhg, vacuum_end_inhg, brine_expected_amount, brine_actual_amount,
              tester_user_id, tester_user_name, parent_attempt_id
       FROM test_attempts
       WHERE tank_id = $1
       ORDER BY attempted_at ASC, id ASC`,
      [tid]
    );
    const notesByAttempt = new Map();
    try {
      const { rows: noteRows } = await pool.query(
        `SELECT id, test_attempt_id, body, author_user_name, created_at
         FROM test_attempt_notes
         WHERE tank_id = $1
         ORDER BY created_at ASC, id ASC`,
        [tid]
      );
      for (const note of noteRows) {
        const key = Number(note.test_attempt_id);
        if (!notesByAttempt.has(key)) notesByAttempt.set(key, []);
        notesByAttempt.get(key).push({
          id: Number(note.id),
          body: note.body,
          author_user_name: note.author_user_name || null,
          created_at: note.created_at,
        });
      }
    } catch (_err) {
      /* table may not exist until migrate */
    }
    return rows.map((r) => {
      const startMs = toMs(r.started_at || r.attempted_at);
      const endMs = toMs(r.completed_at);
      const elapsedMs =
        startMs != null && endMs != null ? Math.max(0, endMs - startMs) : null;
      const startInHg = r.vacuum_start_inhg != null ? Number(r.vacuum_start_inhg) : null;
      const endInHg = r.vacuum_end_inhg != null ? Number(r.vacuum_end_inhg) : null;
      const expected = r.brine_expected_amount != null ? Number(r.brine_expected_amount) : null;
      const actual = r.brine_actual_amount != null ? Number(r.brine_actual_amount) : null;
      return {
        id: Number(r.id),
        tank_id: Number(r.tank_id),
        machine_id: r.machine_id != null ? Number(r.machine_id) : null,
        team_id: r.team_id != null ? Number(r.team_id) : null,
        team_name: r.team_name || null,
        result: r.result,
        attempted_at: r.attempted_at,
        tester_employee_id: r.tester_employee_id != null ? Number(r.tester_employee_id) : null,
        tester_employee_name: r.tester_employee_name || null,
        tester_user_id: r.tester_user_id != null ? Number(r.tester_user_id) : null,
        tester_user_name: r.tester_user_name || null,
        failure_note: r.failure_note || null,
        labor_session_id: r.labor_session_id != null ? Number(r.labor_session_id) : null,
        created_at: r.created_at,
        previous_status: r.previous_status || null,
        test_type: r.test_type || 'LEGACY',
        attempt_status: r.attempt_status || null,
        parent_attempt_id: r.parent_attempt_id != null ? Number(r.parent_attempt_id) : null,
        started_at: r.started_at || r.attempted_at || null,
        completed_at: r.completed_at || null,
        vacuum_start_inhg: startInHg,
        vacuum_end_inhg: endInHg,
        vacuum_delta_inhg:
          startInHg != null && endInHg != null ? endInHg - startInHg : null,
        brine_expected_amount: expected,
        brine_actual_amount: actual,
        brine_variance: expected != null && actual != null ? actual - expected : null,
        elapsed_ms: elapsedMs,
        elapsed_display: elapsedMs != null ? formatDurationXhYm(elapsedMs) : null,
        notes: notesByAttempt.get(Number(r.id)) || [],
      };
    });
  }

  async function getQaBoardConfig() {
    const { rows } = await pool.query(
      `SELECT ${TANK_SELECT_CORE}
       FROM tanks
       WHERE deleted_at IS NULL
         AND (
           LOWER(TRIM(status)) IN (
             'ready_for_qa', 'qa_in_progress', 'qa_failed',
             'ready_for_testing', 'testing_in_progress', 'testing_failed'
           )
           OR (
             LOWER(TRIM(status)) IN ('ready_for_assembly', 'assembly_in_progress')
             AND COALESCE(requires_test, FALSE) = TRUE
             AND testing_completed_at IS NULL
             AND fab_completed_at IS NOT NULL
             AND completed_at IS NULL
           )
         )
       ORDER BY
         CASE LOWER(TRIM(status))
           WHEN 'ready_for_qa' THEN 0
           WHEN 'qa_in_progress' THEN 1
           WHEN 'qa_failed' THEN 2
           WHEN 'testing_failed' THEN 2
           WHEN 'ready_for_testing' THEN 3
           WHEN 'ready_for_assembly' THEN 3
           WHEN 'testing_in_progress' THEN 4
           WHEN 'assembly_in_progress' THEN 5
           ELSE 9
         END,
         updated_at DESC NULLS LAST,
         tank_number ASC`
    );
    const assemblyTeamsByTank = await mapActiveAssemblyTeamsByTank(
      rows
        .filter((r) => normalizeAssemblyTankStatus(r.status) === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS)
        .map((r) => r.id)
    );
    const ready_for_qa = [];
    const qa_in_progress = [];
    const failed_hold = [];
    const ready_for_testing = [];
    const testing = [];
    for (const row of rows) {
      const rowStatus = normalizeAssemblyTankStatus(row.status);
      if (rowStatus === ASSEMBLY_STATUSES.READY_FOR_ASSEMBLY) {
        // RT tank waiting on both stages — Testing may go first (or alongside Assembly).
        ready_for_testing.push({ ...mapTankSummary(row), assembly_pending: true });
        continue;
      }
      if (rowStatus === ASSEMBLY_STATUSES.ASSEMBLY_IN_PROGRESS) {
        const teams = assemblyTeamsByTank.get(Number(row.id)) || [];
        const summaryAsm = mapTankSummary(row);
        if (tankTestingWorkOpen(row)) {
          // Concurrent: Assembly owns status but Testing already started — show under Testing.
          const laborOpen = await computeStageLaborForTank(row.id);
          testing.push(
            await enrichTankSummaryWithTestingFailure({
              ...mapTankSummary(row, laborOpen),
              assembly_pending: !tankAssemblyDone(row),
              concurrent_assembly: true,
              assembly_active_teams: teams,
            })
          );
        } else if (!tankTestingDone(row) && tankRequiresTest(row)) {
          // Assembly open; Testing not started yet — selectable (not locked).
          ready_for_testing.push({
            ...summaryAsm,
            assembly_pending: true,
            concurrent_assembly: true,
            assembly_active_teams: teams,
          });
        }
        continue;
      }
      const labor = await computeStageLaborForTank(row.id);
      const summary = await enrichTankSummaryWithTestingFailure(mapTankSummary(row, labor));
      const st = normalizeAssemblyTankStatus(row.status);
      if (st === ASSEMBLY_STATUSES.READY_FOR_QA && isUntestedLegacyQaTank(row)) {
        ready_for_testing.push({ ...summary, legacy_ready_for_qa: true });
      } else if (st === ASSEMBLY_STATUSES.READY_FOR_QA) ready_for_qa.push(summary);
      else if (st === ASSEMBLY_STATUSES.QA_IN_PROGRESS) qa_in_progress.push(summary);
      else if (st === ASSEMBLY_STATUSES.QA_FAILED || st === ASSEMBLY_STATUSES.TESTING_FAILED) {
        const source =
          st === ASSEMBLY_STATUSES.QA_FAILED ? 'qa' : summary.failure_source || 'testing';
        failed_hold.push({
          ...summary,
          failure_source: source,
        });
      } else if (st === ASSEMBLY_STATUSES.READY_FOR_TESTING) ready_for_testing.push(summary);
      else if (st === ASSEMBLY_STATUSES.TESTING_IN_PROGRESS) {
        testing.push({
          ...summary,
          assembly_pending: !tankAssemblyDone(row),
          concurrent_assembly: tankAssemblyWorkOpen(row),
        });
      }
    }
    return okResult({
      ready_for_qa,
      qa_in_progress,
      // Combined FAILED / HOLD (QA + Testing). Keep qa_failed alias for older clients.
      failed_hold,
      qa_failed: failed_hold,
      ready_for_testing,
      testing,
    });
  }

  async function startQa(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
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
      if (status !== ASSEMBLY_STATUSES.READY_FOR_QA && status !== ASSEMBLY_STATUSES.QA_FAILED) {
        return errResult(409, 'tank_status', `START QA requires Ready for QA (got "${status}").`);
      }
      // Hard gate: never start QA while a required department is still open.
      if (!tankAssemblyDone(tank)) {
        return errResult(
          409,
          'assembly_incomplete',
          `Tank ${tank.tank_number} cannot start QA until Assembly is finished.`,
          { tank_status: status }
        );
      }
      if (tankRequiresTest(tank) && !tankTestingDone(tank)) {
        return errResult(
          409,
          'testing_incomplete',
          `Tank ${tank.tank_number} cannot start QA until Testing is finished.`,
          { tank_status: status }
        );
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      await client.query(
        `UPDATE tanks
         SET status = $1,
             qa_started_at = $2::timestamptz,
             qa_completed_at = NULL,
             qa_machine_id = COALESCE($3, qa_machine_id),
             qa_user_id = COALESCE($4, qa_user_id),
             qa_user_name = COALESCE($5, qa_user_name),
             updated_at = $2::timestamptz
         WHERE id = $6`,
        [
          ASSEMBLY_STATUSES.QA_IN_PROGRESS,
          ts,
          Number.isInteger(mid) && mid > 0 ? mid : null,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
          tankId,
        ]
      );
      return okResult({
        action: 'start_qa',
        tank: mapTankSummary(await getTankById(tankId, client)),
        message: 'QA In Progress.',
      });
    });
  }

  return {
    releaseTankFromFab,
    listEligibleTanksForAssembly,
    listEligibleTanksForTesting,
    listConfirmedTanksForMachine,
    listConfirmedTanksForAssembly,
    listConfirmedTanksForTesting,
    getMachineConfig,
    getQaBoardConfig,
    assignTeamToMachine,
    ensureAssemblyKioskTeam,
    listAssemblyKioskTeams,
    moveEmployeeToAssemblyTeam,
    endAssemblyTeamMoves,
    releaseEmployeeOpenStageLabor,
    syncAssemblyKioskPresenceFromAssignment,
    confirmTank,
    confirmTest,
    startWork,
    stopWork,
    assemblyComplete,
    restoreTankToAssembly,
    restoreTankToAssemblyFromDownstream,
    recordBrineResult,
    markTestingReadyForQa,
    removeTankFromAssembly,
    listRemovedFromAssemblyTanks,
    returnRemovedTankToAssembly,
    startTesting,
    beginTestingSession,
    recordTestResult,
    startQa,
    recordQaResult,
    startVacuumTest,
    completeVacuumTest,
    recordVacuumResult,
    startBrineFill,
    stopBrineFill,
    completeTesting,
    retestTesting,
    sendTestingFailToFabRework,
    appendTestAttemptNote,
    finalizeTankCompletion,
    getTestingFailureContext,
    enrichTankSummaryWithTestingFailure,
    startCorrection,
    employeeOutFromStage,
    pauseStationLabor,
    resumeStationLabor,
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
  TEST_TYPES,
  ELIGIBLE_LIST_STATUSES,
  POST_ASSEMBLY_READY_STATUSES,
  formatDurationXhYm,
  tankRequiresTest,
  normalizeAssemblyTankStatus,
};
