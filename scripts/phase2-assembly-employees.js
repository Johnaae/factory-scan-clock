'use strict';

/**
 * Assembly kiosk tank-based employee workflow (no Team barcode).
 * Additive on Phase 2; historical team Assembly sessions stay readable.
 *
 * Requires migrate-assembly-tank-employees.sql (mirrored in phase2-schema-sql.js).
 */

const ASSEMBLY_POOL_BARCODE = 'ASSEMBLY-EMPLOYEE-POOL';
const ASSEMBLY_POOL_NAME = 'Assembly Employees';

function errResult(status, error, message, extra = {}) {
  return { ok: false, status, body: { ok: false, error, message, ...extra } };
}
function okResult(body, status = 200) {
  return { ok: true, status, body: { ok: true, ...body } };
}

function parseIdList(raw) {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out = [];
  for (const v of list) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function createAssemblyEmployeeWorkflow(pool, helpers = {}) {
  const nowIso = helpers.nowIso || (() => new Date().toISOString());
  const getPhase2 = () => helpers.phase2 || null;
  const isEmployeeShopsReady = helpers.isEmployeeShopsReady || (async () => false);

  let tablesReady = null;
  let tablesCheckedAt = 0;

  async function isReady() {
    if (tablesReady === true) return true;
    if (Date.now() - tablesCheckedAt < 30000 && tablesReady === false) return false;
    tablesCheckedAt = Date.now();
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = ANY($1::text[])`,
        [['assembly_tank_workers', 'assembly_kiosk_tanks']]
      );
      tablesReady = Number(rows[0].n) === 2;
    } catch (_err) {
      tablesReady = false;
    }
    return tablesReady;
  }

  function notReady() {
    return errResult(
      503,
      'assembly_employees_not_ready',
      'Assembly employee assignments are not available yet. Apply scripts/migrate-assembly-tank-employees.sql (or restart after schema migrate), then retry.'
    );
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      if (result && result.ok === false) await client.query('ROLLBACK');
      else await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err && err.apiResult) return err.apiResult;
      throw err;
    } finally {
      client.release();
    }
  }

  async function ensurePoolTeam(client = pool) {
    const { rows } = await client.query(
      `SELECT id, name, barcode FROM teams WHERE barcode = $1 LIMIT 1`,
      [ASSEMBLY_POOL_BARCODE]
    );
    if (rows[0]) {
      return { id: Number(rows[0].id), name: rows[0].name, barcode: rows[0].barcode };
    }
    const { rows: ins } = await client.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at)
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW()
       RETURNING id, name, barcode`,
      [ASSEMBLY_POOL_NAME, ASSEMBLY_POOL_BARCODE]
    );
    return { id: Number(ins[0].id), name: ins[0].name, barcode: ins[0].barcode };
  }

  /**
   * Eligible Assembly kiosk workers — same source of truth as Dome (employee_shops).
   * Does not depend on assembly_tank_workers readiness (listing must work even if
   * confirm tables are still migrating).
   *
   * When Shop Assignment is ready:
   *   - active + employee_shops.shop = 'Assembly' (primary, mirrors Dome)
   *   - active + zero shop rows (unassigned — not excluded until a manager assigns)
   * When Shop Assignment is not ready: all active employees (temporary fallback).
   */
  async function listAssemblyShopEmployees() {
    const shopsReady = await isEmployeeShopsReady();
    if (shopsReady) {
      // Direct SQL eligibility — do not start from all employees then hope a filter sticks.
      const { rows } = await pool.query(
        `SELECT e.id, e.code, e.name,
                ARRAY(
                  SELECT es2.shop FROM employee_shops es2
                  WHERE es2.employee_id = e.id
                  ORDER BY CASE es2.shop
                    WHEN 'Fabrication' THEN 1 WHEN 'Assembly' THEN 2 WHEN 'Dome' THEN 3 ELSE 4
                  END
                ) AS shops,
                EXISTS (
                  SELECT 1 FROM employee_shops es3
                  WHERE es3.employee_id = e.id AND es3.shop = 'Assembly'
                ) AS has_assembly
         FROM employees e
         WHERE COALESCE(e.is_active, 1) = 1
           AND (
             EXISTS (
               SELECT 1 FROM employee_shops es
               WHERE es.employee_id = e.id AND es.shop = 'Assembly'
             )
             OR NOT EXISTS (
               SELECT 1 FROM employee_shops es
               WHERE es.employee_id = e.id
             )
           )
         ORDER BY LOWER(e.name), e.id
         LIMIT 2000`
      );
      return rows.map((r) => {
        const shops = Array.isArray(r.shops) ? r.shops : [];
        const hasAssembly = Boolean(r.has_assembly);
        return {
          id: Number(r.id),
          code: r.code || null,
          name: r.name,
          shops,
          assembly_shop: hasAssembly,
          assembly_eligible: true,
        };
      });
    }
    // Fallback when shops table is not ready: all active employees.
    const { rows } = await pool.query(
      `SELECT id, code, name FROM employees
       WHERE COALESCE(is_active, 1) = 1
       ORDER BY LOWER(name), id
       LIMIT 2000`
    );
    return rows.map((r) => ({
      id: Number(r.id),
      code: r.code || null,
      name: r.name,
      shops: [],
      assembly_shop: null,
      assembly_eligible: true,
    }));
  }

  /** True when employee may be confirmed on Assembly (mirrors listAssemblyShopEmployees). */
  async function employeeIsAssemblyEligible(employeeId, client = pool) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const shopsReady = await isEmployeeShopsReady();
    if (!shopsReady) return true;
    const { rows } = await client.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM employee_shops WHERE employee_id = $1 AND shop = 'Assembly'
         ) AS has_assembly,
         EXISTS (
           SELECT 1 FROM employee_shops WHERE employee_id = $1
         ) AS has_any_shop`,
      [id]
    );
    const r = rows[0];
    if (!r) return false;
    return Boolean(r.has_assembly) || !Boolean(r.has_any_shop);
  }

  async function loadWorkersForTank(tankId, client = pool) {
    const { rows } = await client.query(
      `SELECT w.employee_id, w.assigned_at, e.code, e.name
       FROM assembly_tank_workers w
       JOIN employees e ON e.id = w.employee_id
       WHERE w.tank_id = $1 AND w.left_at IS NULL
       ORDER BY LOWER(e.name), e.id`,
      [Number(tankId)]
    );
    return rows.map((r) => ({
      id: Number(r.employee_id),
      employee_id: Number(r.employee_id),
      code: r.code || null,
      name: r.name,
      employee_name: r.name,
      assigned_at: r.assigned_at,
    }));
  }

  async function loadKioskTankRow(machineId, tankId, client = pool) {
    const { rows } = await client.query(
      `SELECT * FROM assembly_kiosk_tanks
       WHERE machine_id = $1 AND tank_id = $2 AND left_at IS NULL
       LIMIT 1`,
      [Number(machineId), Number(tankId)]
    );
    return rows[0] || null;
  }

  /**
   * Build one card per confirmed Assembly tank on this machine.
   */
  async function listAssemblyTankCards(machineId) {
    if (!(await isReady()) || !getPhase2()) return [];
    const phase2 = getPhase2();
    const mid = Number(machineId);
    const confirmed = await phase2.listConfirmedTanksForAssembly(mid);
    const cards = [];
    for (const tank of confirmed) {
      const tid = Number(tank.id);
      const workers = await loadWorkersForTank(tid);
      const kiosk = await loadKioskTankRow(mid, tid);
      let onLunch = kiosk && String(kiosk.status || '').toLowerCase() === 'lunch';
      let lunchPausedAt = kiosk ? kiosk.lunch_paused_at || null : null;
      // Recover RESUME after refresh when presence row was lost but labor was paused for Lunch.
      if (!onLunch && !tank.active_session) {
        try {
          const { rows: lunchRows } = await pool.query(
            `SELECT ended_at
             FROM stage_labor_sessions
             WHERE tank_id = $1
               AND machine_id = $2
               AND status = 'stopped'
               AND UPPER(COALESCE(stage, '')) = 'ASSEMBLY'
               AND UPPER(TRIM(COALESCE(notes, ''))) LIKE 'LUNCH%'
             ORDER BY ended_at DESC NULLS LAST, id DESC
             LIMIT 1`,
            [tid, mid]
          );
          if (lunchRows[0]) {
            // Only recover if no newer non-lunch stop replaced this pause (End Shift / STOP).
            const { rows: newer } = await pool.query(
              `SELECT id
               FROM stage_labor_sessions
               WHERE tank_id = $1
                 AND machine_id = $2
                 AND status = 'stopped'
                 AND UPPER(COALESCE(stage, '')) = 'ASSEMBLY'
                 AND ended_at IS NOT NULL
                 AND ended_at > $3::timestamptz
                 AND UPPER(TRIM(COALESCE(notes, ''))) NOT LIKE 'LUNCH%'
               LIMIT 1`,
              [tid, mid, lunchRows[0].ended_at]
            );
            if (!newer.length) {
              onLunch = true;
              lunchPausedAt = lunchRows[0].ended_at;
            }
          }
        } catch (_err) {
          /* ignore recovery errors */
        }
      }
      cards.push({
        ...tank,
        workers,
        worker_count: workers.length,
        on_lunch: Boolean(onLunch),
        lunch_paused_at: lunchPausedAt,
        kiosk_status: onLunch ? 'lunch' : kiosk ? kiosk.status : 'active',
        card_mode: 'tank_employees',
      });
    }
    return cards;
  }

  async function validateEmployees(employeeIds, client) {
    const ids = parseIdList(employeeIds);
    if (!ids.length) {
      return { error: errResult(400, 'workers_required', 'Select at least one Assembly employee.') };
    }
    const { rows } = await client.query(
      `SELECT id, code, name, is_active FROM employees WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    for (const id of ids) {
      const e = byId.get(id);
      if (!e) return { error: errResult(400, 'invalid_employee', 'One or more selected employees were not found.') };
      if (Number(e.is_active) === 0) {
        return { error: errResult(400, 'inactive_employee', `${e.name} is inactive.`) };
      }
    }
    const shopsReady = await isEmployeeShopsReady();
    if (shopsReady) {
      for (const id of ids) {
        const ok = await employeeIsAssemblyEligible(id, client);
        if (!ok) {
          const e = byId.get(id);
          return {
            error: errResult(
              400,
              'not_assembly_shop',
              `${e.name} is not eligible for Assembly. Assign Assembly in Shop Assignment, or clear other shop tags if they should work here.`,
              { employee_id: id }
            ),
          };
        }
      }
    }
    return {
      employees: ids.map((id) => {
        const e = byId.get(id);
        return { id, code: e.code, name: e.name };
      }),
    };
  }

  async function closeWorkerConflicts(client, employeeIds, exceptTankId, ts) {
    const ids = parseIdList(employeeIds);
    if (!ids.length) return [];
    const { rows } = await client.query(
      `SELECT w.id, w.tank_id, w.employee_id, e.name AS employee_name, t.tank_number
       FROM assembly_tank_workers w
       JOIN employees e ON e.id = w.employee_id
       JOIN tanks t ON t.id = w.tank_id
       WHERE w.employee_id = ANY($1::bigint[])
         AND w.left_at IS NULL
         AND ($2::bigint IS NULL OR w.tank_id <> $2)`,
      [ids, exceptTankId != null ? Number(exceptTankId) : null]
    );
    for (const r of rows) {
      // Close open stage labor for this employee first (history preserved).
      await client.query(
        `UPDATE stage_labor_participants p
         SET left_at = $1::timestamptz
         FROM stage_labor_sessions s
         WHERE p.session_id = s.id
           AND p.employee_id = $2
           AND p.left_at IS NULL
           AND s.status = 'active'
           AND UPPER(COALESCE(s.stage, '')) = 'ASSEMBLY'`,
        [ts, Number(r.employee_id)]
      );
      await client.query(
        `UPDATE assembly_tank_workers
         SET left_at = $1::timestamptz, status = 'left', updated_at = $1::timestamptz
         WHERE id = $2 AND left_at IS NULL`,
        [ts, Number(r.id)]
      );
    }
    return rows.map((r) => ({
      employee_id: Number(r.employee_id),
      employee_name: r.employee_name,
      from_tank_id: Number(r.tank_id),
      from_tank_number: r.tank_number,
    }));
  }

  async function upsertWorkers(client, { tankId, machineId, employees, ts, performedBy }) {
    const moved = await closeWorkerConflicts(
      client,
      employees.map((e) => e.id),
      tankId,
      ts
    );
    for (const emp of employees) {
      const { rows: existing } = await client.query(
        `SELECT id FROM assembly_tank_workers
         WHERE tank_id = $1 AND employee_id = $2 AND left_at IS NULL
         LIMIT 1`,
        [tankId, emp.id]
      );
      if (existing.length) continue;
      await client.query(
        `INSERT INTO assembly_tank_workers
           (tank_id, machine_id, employee_id, status, assigned_at, assigned_by, created_at, updated_at)
         VALUES ($1,$2,$3,'assigned',$4::timestamptz,$5,$4::timestamptz,$4::timestamptz)`,
        [tankId, machineId, emp.id, ts, performedBy || null]
      );
    }
    return moved;
  }

  async function ensureKioskTank(client, machineId, tankId, ts) {
    const { rows } = await client.query(
      `SELECT id FROM assembly_kiosk_tanks
       WHERE machine_id = $1 AND tank_id = $2 AND left_at IS NULL
       LIMIT 1`,
      [machineId, tankId]
    );
    if (rows.length) {
      await client.query(
        `UPDATE assembly_kiosk_tanks
         SET status = 'active', lunch_paused_at = NULL, updated_at = $1::timestamptz
         WHERE id = $2`,
        [ts, Number(rows[0].id)]
      );
      return Number(rows[0].id);
    }
    const { rows: ins } = await client.query(
      `INSERT INTO assembly_kiosk_tanks
         (machine_id, tank_id, status, confirmed_at, created_at, updated_at)
       VALUES ($1,$2,'active',$3::timestamptz,$3::timestamptz,$3::timestamptz)
       RETURNING id`,
      [machineId, tankId, ts]
    );
    return Number(ins[0].id);
  }

  /**
   * CONFIRM TANK & EMPLOYEES — starts Assembly Duration (via phase2.confirmTank)
   * with the employee pool team; does NOT start labor.
   */
  async function confirmTankWithEmployees(machine, opts = {}) {
    if (!(await isReady())) return notReady();
    const phase2 = getPhase2();
    if (!phase2 || typeof phase2.confirmTank !== 'function') {
      return errResult(503, 'phase2_missing', 'Assembly Phase 2 is not available.');
    }
    const mid = Number(machine && machine.id);
    const tankId = Number(opts.tank_id != null ? opts.tank_id : opts.tankId);
    if (!Number.isInteger(mid) || mid <= 0) return errResult(400, 'validation', 'Machine is required.');
    if (!Number.isInteger(tankId) || tankId <= 0) return errResult(400, 'validation', 'Select a tank.');

    return withTransaction(async (client) => {
      const validated = await validateEmployees(opts.employee_ids || opts.employees || opts.employeeIds, client);
      if (validated.error) return validated.error;

      // Block duplicate Assembly cards. Testing status alone must NOT block.
      const { rows: tankRows } = await client.query(
        `SELECT id, tank_number, status, assembly_machine_id, assembly_started_at, assembly_completed_at,
                assembly_restored_at, completed_at, deleted_at
         FROM tanks WHERE id = $1 FOR UPDATE`,
        [tankId]
      );
      const tank = tankRows[0];
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      if (tank.completed_at) {
        return errResult(409, 'tank_completed', 'Tank is already completed.');
      }
      const ownedMid = tank.assembly_machine_id != null ? Number(tank.assembly_machine_id) : null;
      if (ownedMid != null) {
        return errResult(
          409,
          'already_assigned',
          ownedMid === mid
            ? `Tank ${tank.tank_number} is already on this Assembly kiosk. Use Manage Employees on its card to change workers.`
            : `Tank ${tank.tank_number} is already assigned to another Assembly kiosk.`,
          { tank_id: tankId, assembly_machine_id: ownedMid }
        );
      }
      const { rows: openKiosk } = await client.query(
        `SELECT machine_id FROM assembly_kiosk_tanks
         WHERE tank_id = $1 AND left_at IS NULL LIMIT 1`,
        [tankId]
      );
      if (openKiosk.length) {
        const kioskMid = Number(openKiosk[0].machine_id);
        return errResult(
          409,
          'already_assigned',
          kioskMid === mid
            ? `Tank ${tank.tank_number} is already on this Assembly kiosk. Use Manage Employees on its card to change workers.`
            : `Tank ${tank.tank_number} is already assigned to another Assembly kiosk.`,
          { tank_id: tankId, assembly_machine_id: kioskMid }
        );
      }
      const { rows: openTeams } = await client.query(
        `SELECT id FROM assembly_tank_teams WHERE tank_id = $1 AND status = 'active' LIMIT 1`,
        [tankId]
      );
      if (openTeams.length) {
        return errResult(
          409,
          'already_assigned',
          `Tank ${tank.tank_number} is already assigned to Assembly. Use Manage Employees on its card.`,
          { tank_id: tankId }
        );
      }

      const poolTeam = await ensurePoolTeam(client);
      const ts = opts.at || nowIso();

      // Presence for lunch/resume scoping.
      await ensureKioskTank(client, mid, tankId, ts);
      const moved = await upsertWorkers(client, {
        tankId,
        machineId: mid,
        employees: validated.employees,
        ts,
        performedBy: opts.performed_by || 'assembly_kiosk',
      });

      // Commit worker rows before calling confirmTank (uses its own transaction via pool).
      // We run confirmTank outside — so do pool confirm after this transaction.
      return okResult({
        _defer_confirm: true,
        pool_team_id: poolTeam.id,
        employees: validated.employees,
        moved_from_other_tanks: moved,
        tank_id: tankId,
        machine_id: mid,
        at: ts,
      });
    }).then(async (prep) => {
      if (!prep || !prep.ok) return prep;
      const body = prep.body || {};
      if (!body._defer_confirm) return prep;
      const confirmed = await phase2.confirmTank(machine, {
        tank_id: body.tank_id,
        team_id: body.pool_team_id,
        at: body.at,
      });
      if (!confirmed.ok) return confirmed;
      const workers = await loadWorkersForTank(body.tank_id);
      return okResult({
        action: 'confirm_tank_employees',
        tank: confirmed.body.tank,
        employees: workers,
        moved_from_other_tanks: body.moved_from_other_tanks || [],
        already_started: confirmed.body.already_started,
        message:
          (confirmed.body.message || 'Tank confirmed.') +
          ' Labor starts only when you press START.',
      });
    });
  }

  /**
   * EMPLOYEE OUT on a tank card — stop working on THIS tank only.
   * Ends open Assembly labor participation on this tank, removes the assignment,
   * and leaves the employee free for another Assembly tank.
   * Does NOT end an overall work shift / team membership. History is preserved.
   */
  async function employeeOutFromTank(machine, opts = {}) {
    if (!(await isReady())) return notReady();
    const mid = Number(machine && machine.id);
    const tankId = Number(opts.tank_id != null ? opts.tank_id : opts.tankId);
    const employeeId = Number(opts.employee_id != null ? opts.employee_id : opts.employeeId);
    if (!Number.isInteger(mid) || mid <= 0) return errResult(400, 'validation', 'Machine is required.');
    if (!Number.isInteger(tankId) || tankId <= 0) return errResult(400, 'validation', 'tank_id is required.');
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return errResult(400, 'validation', 'employee_id is required.');
    }

    return withTransaction(async (client) => {
      const { rows: workers } = await client.query(
        `SELECT w.id AS worker_row_id, e.id AS employee_id, e.name, e.code
         FROM assembly_tank_workers w
         JOIN employees e ON e.id = w.employee_id
         WHERE w.tank_id = $1 AND w.employee_id = $2 AND w.left_at IS NULL
         FOR UPDATE`,
        [tankId, employeeId]
      );
      if (!workers.length) {
        return errResult(404, 'not_on_tank', 'That employee is not assigned to this tank.');
      }
      const emp = workers[0];
      const ts = opts.at || nowIso();

      // Close this employee's open Assembly labor on THIS tank only (keep history).
      const { rows: closedParts } = await client.query(
        `UPDATE stage_labor_participants p
         SET left_at = $1::timestamptz
         FROM stage_labor_sessions s
         WHERE p.session_id = s.id
           AND p.employee_id = $2
           AND p.left_at IS NULL
           AND s.tank_id = $3
           AND s.machine_id = $4
           AND s.status = 'active'
           AND UPPER(COALESCE(s.stage, '')) = 'ASSEMBLY'
         RETURNING p.session_id`,
        [ts, employeeId, tankId, mid]
      );

      // If this tank's session has no open participants left, stop the session.
      // Other employees on the same session keep it active.
      const seenSessions = new Set();
      for (const part of closedParts) {
        const sid = Number(part.session_id);
        if (!sid || seenSessions.has(sid)) continue;
        seenSessions.add(sid);
        const openRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM stage_labor_participants
           WHERE session_id = $1 AND left_at IS NULL`,
          [sid]
        );
        if (openRes.rows[0] && Number(openRes.rows[0].n) === 0) {
          await client.query(
            `UPDATE stage_labor_sessions
             SET status = 'stopped',
                 ended_at = COALESCE(ended_at, $1::timestamptz),
                 notes = COALESCE(NULLIF(TRIM(notes), ''), 'Employee out — last worker on tank'),
                 updated_at = $1::timestamptz
             WHERE id = $2 AND status = 'active'`,
            [ts, sid]
          );
        }
      }

      await client.query(
        `UPDATE assembly_tank_workers
         SET left_at = $1::timestamptz, status = 'left', updated_at = $1::timestamptz
         WHERE id = $2 AND left_at IS NULL`,
        [ts, Number(emp.worker_row_id)]
      );

      const remaining = await loadWorkersForTank(tankId, client);
      return okResult({
        action: 'employee_out_tank',
        employee_id: employeeId,
        employee_name: emp.name,
        employee_code: emp.code || null,
        tank_id: tankId,
        employees: remaining,
        labor_closed: closedParts.length > 0,
        message: `${emp.name} stopped working on this tank and is available for another Assembly tank. Their overall shift was not ended.`,
      });
    });
  }

  async function manageTankEmployees(machine, opts = {}) {
    if (!(await isReady())) return notReady();
    const mid = Number(machine && machine.id);
    const tankId = Number(opts.tank_id != null ? opts.tank_id : opts.tankId);
    const addIds = parseIdList(opts.add_employee_ids || opts.add || []);
    const removeIds = parseIdList(opts.remove_employee_ids || opts.remove || []);
    if (!Number.isInteger(mid) || mid <= 0) return errResult(400, 'validation', 'Machine is required.');
    if (!Number.isInteger(tankId) || tankId <= 0) return errResult(400, 'validation', 'tank_id is required.');
    if (!addIds.length && !removeIds.length) {
      return errResult(400, 'validation', 'Provide employees to add and/or remove.');
    }

    return withTransaction(async (client) => {
      const kiosk = await loadKioskTankRow(mid, tankId, client);
      if (!kiosk) {
        return errResult(409, 'not_on_kiosk', 'Confirm this tank on the Assembly kiosk first.');
      }
      const ts = opts.at || nowIso();
      const phase2 = getPhase2();

      if (removeIds.length) {
        for (const eid of removeIds) {
          await client.query(
            `UPDATE stage_labor_participants p
             SET left_at = $1::timestamptz
             FROM stage_labor_sessions s
             WHERE p.session_id = s.id
               AND p.employee_id = $2
               AND p.left_at IS NULL
               AND s.tank_id = $3
               AND s.status = 'active'
               AND UPPER(COALESCE(s.stage, '')) = 'ASSEMBLY'`,
            [ts, eid, tankId]
          );
          await client.query(
            `UPDATE assembly_tank_workers
             SET left_at = $1::timestamptz, status = 'left', updated_at = $1::timestamptz
             WHERE tank_id = $2 AND employee_id = $3 AND left_at IS NULL`,
            [ts, tankId, eid]
          );
        }
      }

      let added = [];
      let moved = [];
      if (addIds.length) {
        const validated = await validateEmployees(addIds, client);
        if (validated.error) return validated.error;
        // Close other-tank assignments + their Assembly labor first (transfer).
        moved = await upsertWorkers(client, {
          tankId,
          machineId: mid,
          employees: validated.employees,
          ts,
          performedBy: opts.performed_by || 'assembly_kiosk',
        });
        added = validated.employees;

        // If Assembly labor is already running on this tank, join new employees now.
        if (phase2 && typeof phase2.getActiveSessionForTank === 'function') {
          const active = await phase2.getActiveSessionForTank(tankId, mid, client);
          if (active && String(active.stage || '').toUpperCase() === 'ASSEMBLY') {
            // Only treat as busy if still open on a DIFFERENT tank/session after transfer close.
            const conflicts = await client.query(
              `SELECT p.employee_id, e.name, s.tank_id
               FROM stage_labor_participants p
               JOIN employees e ON e.id = p.employee_id
               JOIN stage_labor_sessions s ON s.id = p.session_id
               WHERE p.employee_id = ANY($1::bigint[])
                 AND p.left_at IS NULL
                 AND s.status = 'active'
                 AND s.tank_id IS DISTINCT FROM $2`,
              [addIds, tankId]
            );
            if (conflicts.rows.length) {
              return errResult(
                409,
                'employee_busy',
                `Employee(s) already in active labor: ${conflicts.rows.map((r) => r.name).join(', ')}.`
              );
            }
            for (const emp of validated.employees) {
              const { rows: already } = await client.query(
                `SELECT id FROM stage_labor_participants
                 WHERE session_id = $1 AND employee_id = $2 AND left_at IS NULL
                 LIMIT 1`,
                [Number(active.id), emp.id]
              );
              if (already.length) continue;
              await client.query(
                `INSERT INTO stage_labor_participants
                   (session_id, employee_id, employee_code, employee_name, team_id, joined_at, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
                [
                  Number(active.id),
                  emp.id,
                  emp.code || null,
                  emp.name,
                  active.team_id != null ? Number(active.team_id) : null,
                  ts,
                ]
              );
            }
          }
        }
      }

      const workers = await loadWorkersForTank(tankId, client);
      return okResult({
        action: 'manage_tank_employees',
        tank_id: tankId,
        employees: workers,
        added,
        removed_ids: removeIds,
        moved_from_other_tanks: moved,
        message: 'Assembly employees updated.',
      });
    });
  }

  async function moveEmployeeBetweenTanks(machine, opts = {}) {
    if (!(await isReady())) return notReady();
    const mid = Number(machine && machine.id);
    const employeeId = Number(opts.employee_id != null ? opts.employee_id : opts.employeeId);
    const toTankId = Number(opts.to_tank_id != null ? opts.to_tank_id : opts.toTankId);
    const fromTankId =
      opts.from_tank_id != null
        ? Number(opts.from_tank_id)
        : opts.fromTankId != null
          ? Number(opts.fromTankId)
          : null;
    if (!Number.isInteger(mid) || mid <= 0) return errResult(400, 'validation', 'Machine is required.');
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return errResult(400, 'validation', 'employee_id is required.');
    }
    if (!Number.isInteger(toTankId) || toTankId <= 0) {
      return errResult(400, 'validation', 'to_tank_id is required.');
    }

    return withTransaction(async (client) => {
      const dest = await loadKioskTankRow(mid, toTankId, client);
      if (!dest) {
        return errResult(409, 'dest_not_on_kiosk', 'Destination tank is not confirmed on this kiosk.');
      }
      const validated = await validateEmployees([employeeId], client);
      if (validated.error) return validated.error;
      const ts = opts.at || nowIso();
      const emp = validated.employees[0];

      // Close source assignment + labor.
      const { rows: src } = await client.query(
        `SELECT id, tank_id FROM assembly_tank_workers
         WHERE employee_id = $1 AND left_at IS NULL
           AND ($2::bigint IS NULL OR tank_id = $2)
         FOR UPDATE`,
        [employeeId, fromTankId]
      );
      for (const r of src) {
        if (Number(r.tank_id) === toTankId) continue;
        await client.query(
          `UPDATE stage_labor_participants p
           SET left_at = $1::timestamptz
           FROM stage_labor_sessions s
           WHERE p.session_id = s.id
             AND p.employee_id = $2
             AND p.left_at IS NULL
             AND s.tank_id = $3
             AND s.status = 'active'`,
          [ts, employeeId, Number(r.tank_id)]
        );
        await client.query(
          `UPDATE assembly_tank_workers
           SET left_at = $1::timestamptz, status = 'left', updated_at = $1::timestamptz
           WHERE id = $2`,
          [ts, Number(r.id)]
        );
      }

      await upsertWorkers(client, {
        tankId: toTankId,
        machineId: mid,
        employees: [emp],
        ts,
        performedBy: opts.performed_by || 'assembly_kiosk',
      });

      // Join dest active labor if running and tank not on lunch.
      const phase2 = getPhase2();
      const onLunch = String(dest.status || '').toLowerCase() === 'lunch';
      if (!onLunch && phase2 && typeof phase2.getActiveSessionForTank === 'function') {
        const active = await phase2.getActiveSessionForTank(toTankId, mid, client);
        if (active && String(active.stage || '').toUpperCase() === 'ASSEMBLY') {
          const { rows: open } = await client.query(
            `SELECT id FROM stage_labor_participants
             WHERE employee_id = $1 AND left_at IS NULL LIMIT 1`,
            [employeeId]
          );
          if (!open.length) {
            await client.query(
              `INSERT INTO stage_labor_participants
                 (session_id, employee_id, employee_code, employee_name, team_id, joined_at, created_at)
               VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
              [
                Number(active.id),
                emp.id,
                emp.code || null,
                emp.name,
                active.team_id != null ? Number(active.team_id) : null,
                ts,
              ]
            );
          }
        }
      }

      return okResult({
        action: 'move_employee_tank',
        employee: emp,
        to_tank_id: toTankId,
        from_tank_ids: src.map((r) => Number(r.tank_id)),
        message: `${emp.name} moved to the selected Assembly tank.`,
      });
    });
  }

  /**
   * Resolve employees for START from assembly_tank_workers (not team roster).
   */
  async function resolveWorkersForStart(tankId) {
    if (!(await isReady())) return [];
    return loadWorkersForTank(tankId);
  }

  async function setKioskTankLunch(machineId, tankId, onLunch, ts) {
    if (!(await isReady())) return notReady();
    const mid = Number(machineId);
    const tid = Number(tankId);
    if (!Number.isInteger(mid) || mid <= 0 || !Number.isInteger(tid) || tid <= 0) {
      return errResult(400, 'validation', 'machine_id and tank_id are required.');
    }
    const at = ts || nowIso();
    const nextStatus = onLunch ? 'lunch' : 'active';
    // Per-tank only — never touches other cards. Create the presence row if missing
    // so Lunch still shows RESUME after refresh (legacy / restored tanks).
    const { rowCount } = await pool.query(
      onLunch
        ? `UPDATE assembly_kiosk_tanks
           SET status = 'lunch', lunch_paused_at = $1::timestamptz, updated_at = $1::timestamptz
           WHERE machine_id = $2 AND tank_id = $3 AND left_at IS NULL`
        : `UPDATE assembly_kiosk_tanks
           SET status = 'active', lunch_paused_at = NULL, updated_at = $1::timestamptz
           WHERE machine_id = $2 AND tank_id = $3 AND left_at IS NULL`,
      [at, mid, tid]
    );
    if (!rowCount) {
      try {
        await pool.query(
          `INSERT INTO assembly_kiosk_tanks
             (machine_id, tank_id, status, lunch_paused_at, confirmed_at, created_at, updated_at)
           VALUES (
             $1, $2, $3::text,
             CASE WHEN $3::text = 'lunch' THEN $4::timestamptz ELSE NULL END,
             $4::timestamptz, $4::timestamptz, $4::timestamptz
           )`,
          [mid, tid, nextStatus, at]
        );
      } catch (err) {
        // Concurrent insert on open (machine_id, tank_id) — retry update.
        if (err && err.code === '23505') {
          await pool.query(
            onLunch
              ? `UPDATE assembly_kiosk_tanks
                 SET status = 'lunch', lunch_paused_at = $1::timestamptz, updated_at = $1::timestamptz
                 WHERE machine_id = $2 AND tank_id = $3 AND left_at IS NULL`
              : `UPDATE assembly_kiosk_tanks
                 SET status = 'active', lunch_paused_at = NULL, updated_at = $1::timestamptz
                 WHERE machine_id = $2 AND tank_id = $3 AND left_at IS NULL`,
            [at, mid, tid]
          );
        } else {
          throw err;
        }
      }
    }
    return okResult({ action: onLunch ? 'tank_lunch' : 'tank_resume', tank_id: tid });
  }

  async function endShiftForTank(machine, opts = {}) {
    if (!(await isReady())) return notReady();
    const mid = Number(machine && machine.id);
    const tankId = Number(opts.tank_id != null ? opts.tank_id : opts.tankId);
    if (!Number.isInteger(mid) || mid <= 0) return errResult(400, 'validation', 'Machine is required.');
    if (!Number.isInteger(tankId) || tankId <= 0) return errResult(400, 'validation', 'tank_id is required.');
    const phase2 = getPhase2();
    const ts = opts.at || nowIso();

    return withTransaction(async (client) => {
      // Close active Assembly labor on this tank only. Keep employee assignments so
      // START NEW SHIFT can begin another session without re-confirming the tank.
      void phase2;
      await client.query(
        `UPDATE stage_labor_participants p
         SET left_at = $1::timestamptz
         FROM stage_labor_sessions s
         WHERE p.session_id = s.id
           AND p.left_at IS NULL
           AND s.tank_id = $2
           AND s.machine_id = $3
           AND s.status = 'active'
           AND UPPER(COALESCE(s.stage, '')) = 'ASSEMBLY'`,
        [ts, tankId, mid]
      );
      await client.query(
        `UPDATE stage_labor_sessions
         SET status = 'stopped', ended_at = COALESCE(ended_at, $1::timestamptz),
             notes = COALESCE(NULLIF(TRIM(notes), ''), 'END_SHIFT'),
             updated_at = $1::timestamptz
         WHERE tank_id = $2 AND machine_id = $3 AND status = 'active'
           AND UPPER(COALESCE(stage, '')) = 'ASSEMBLY'`,
        [ts, tankId, mid]
      );
      await client.query(
        `UPDATE assembly_kiosk_tanks
         SET status = 'active', lunch_paused_at = NULL, updated_at = $1::timestamptz
         WHERE machine_id = $2 AND tank_id = $3 AND left_at IS NULL`,
        [ts, mid, tankId]
      );
      const workers = await loadWorkersForTank(tankId, client);
      return okResult({
        action: 'end_shift_tank',
        tank_id: tankId,
        employees: workers,
        shift_ended: true,
        message:
          'End Shift closed Assembly labor for this tank. Progress and employee assignments are kept — press START NEW SHIFT when ready.',
      });
    });
  }

  return {
    isReady,
    ASSEMBLY_POOL_BARCODE,
    ensurePoolTeam,
    listAssemblyShopEmployees,
    employeeIsAssemblyEligible,
    listAssemblyTankCards,
    loadWorkersForTank,
    confirmTankWithEmployees,
    employeeOutFromTank,
    manageTankEmployees,
    moveEmployeeBetweenTanks,
    resolveWorkersForStart,
    setKioskTankLunch,
    endShiftForTank,
  };
}

module.exports = {
  createAssemblyEmployeeWorkflow,
  ASSEMBLY_POOL_BARCODE,
  ASSEMBLY_POOL_NAME,
};
