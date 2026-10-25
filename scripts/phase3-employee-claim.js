'use strict';

/**
 * Temporary employee handoff into Dome Shop work (Dome / Bulkhead Start).
 *
 * Prefer Start (not Create) so selecting workers on a draft job does not move anyone.
 * Closes prior open shift memberships and stage/dome/bulkhead labor for each employee
 * atomically inside the caller's transaction. Never updates team_members (home team).
 */

function errResult(status, error, message, extra = {}) {
  return { ok: false, status, body: { ok: false, error, message, ...extra } };
}

function createPhase3EmployeeClaim(pool, helpers = {}) {
  const nowIso = helpers.nowIso || (() => new Date().toISOString());
  const phase2 = helpers.phase2 || null;

  /**
   * Lock employees, release conflicting open labor, close open memberships.
   * Active Dome/Bulkhead labor on another job requires opts.confirmTransfer === true
   * (intentional move). Without it, returns 409 employee_assigned_elsewhere so concurrent
   * Starts cannot both report success.
   *
   * @param {object} client - open transaction client
   * @param {Array<{id:number,code?:string,name?:string}>} employees
   * @param {object} opts
   * @param {number|null} opts.keepDomeId - leave open on this dome (restart same dome)
   * @param {number|null} opts.keepBulkheadId - leave open on this bulkhead
   * @param {boolean} opts.confirmTransfer - allow moving off other Dome/Bulkhead labor
   * @param {number|null} opts.keepTeamId - do not close open memberships on this team
   *   (team-card Start/Resume — workers stay on their Dome team shift)
   * @param {string} opts.targetLabel - e.g. "Dome D-1" for notices on the superseded job
   * @param {number|null} opts.targetMachineId
   * @param {string} opts.ts
   * @param {string} opts.reason
   */
  async function claimEmployeesForDomeWork(client, employees, opts = {}) {
    const list = (Array.isArray(employees) ? employees : [])
      .map((e) => ({
        id: Number(e.id != null ? e.id : e.employee_id),
        code: e.code || null,
        name: e.name || e.employee_name || null,
      }))
      .filter((e) => Number.isInteger(e.id) && e.id > 0);
    if (!list.length) {
      return errResult(400, 'workers_required', 'Select 1 to 3 employees.');
    }
    const ids = [...new Set(list.map((e) => e.id))].sort((a, b) => a - b);
    const ts = opts.ts || nowIso();
    const reason = opts.reason || 'dome_shop_start';
    const keepDomeId = opts.keepDomeId != null ? Number(opts.keepDomeId) : null;
    const keepBulkheadId = opts.keepBulkheadId != null ? Number(opts.keepBulkheadId) : null;
    const keepTeamId =
      opts.keepTeamId != null && Number.isInteger(Number(opts.keepTeamId)) && Number(opts.keepTeamId) > 0
        ? Number(opts.keepTeamId)
        : null;
    const confirmTransfer = opts.confirmTransfer === true;
    const targetLabel = opts.targetLabel ? String(opts.targetLabel).slice(0, 80) : null;
    const targetMachineId =
      opts.targetMachineId != null && Number.isInteger(Number(opts.targetMachineId))
        ? Number(opts.targetMachineId)
        : null;

    const { rows: locked } = await client.query(
      `SELECT id, code, name, is_active FROM employees WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [ids]
    );
    if (locked.length !== ids.length) {
      return errResult(400, 'invalid_fabricator', 'One or more selected employees are not active.');
    }
    for (const e of locked) {
      if (Number(e.is_active) !== 1) {
        return errResult(400, 'inactive_employee', `${e.name || e.code} is inactive.`);
      }
    }
    const byId = new Map(locked.map((r) => [Number(r.id), r]));

    // Inspect other active Dome/Bulkhead labor before mutating (serialized by employee locks).
    const conflicts = [];
    for (const id of ids) {
      const emp = byId.get(id);
      const { rows: domeParts } = await client.query(
        `SELECT p.id, p.session_id, s.dome_id, d.dome_number, d.machine_id, m.name AS machine_name
         FROM dome_labor_participants p
         JOIN dome_labor_sessions s ON s.id = p.session_id
         JOIN domes d ON d.id = s.dome_id
         LEFT JOIN machines m ON m.id = d.machine_id
         WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active'
           AND d.deleted_at IS NULL
           AND ($2::bigint IS NULL OR s.dome_id <> $2)`,
        [id, keepDomeId]
      );
      for (const r of domeParts) {
        conflicts.push({
          employee_id: id,
          employee_name: emp.name,
          kind: 'dome',
          dome_id: Number(r.dome_id),
          dome_number: r.dome_number,
          bulkhead_id: null,
          bulkhead_number: null,
          participant_id: Number(r.id),
          session_id: Number(r.session_id),
          machine_id: r.machine_id != null ? Number(r.machine_id) : null,
          machine_name: r.machine_name || null,
          label: `Dome ${r.dome_number}`,
        });
      }
      const { rows: bhParts } = await client
        .query(
          `SELECT p.id, p.session_id, s.bulkhead_id, b.bulkhead_number, b.machine_id, m.name AS machine_name
           FROM bulkhead_labor_participants p
           JOIN bulkhead_labor_sessions s ON s.id = p.session_id
           JOIN bulkheads b ON b.id = s.bulkhead_id
           LEFT JOIN machines m ON m.id = b.machine_id
           WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active'
             AND b.deleted_at IS NULL
             AND ($2::bigint IS NULL OR s.bulkhead_id <> $2)`,
          [id, keepBulkheadId]
        )
        .catch(() => ({ rows: [] }));
      for (const r of bhParts) {
        conflicts.push({
          employee_id: id,
          employee_name: emp.name,
          kind: 'bulkhead',
          dome_id: null,
          dome_number: null,
          bulkhead_id: Number(r.bulkhead_id),
          bulkhead_number: r.bulkhead_number,
          participant_id: Number(r.id),
          session_id: Number(r.session_id),
          machine_id: r.machine_id != null ? Number(r.machine_id) : null,
          machine_name: r.machine_name || null,
          label: `Bulkhead ${r.bulkhead_number}`,
        });
      }
    }

    if (conflicts.length && !confirmTransfer) {
      const c = conflicts[0];
      const where = c.machine_name ? `${c.label} (${c.machine_name})` : c.label;
      return errResult(
        409,
        'employee_assigned_elsewhere',
        `${c.employee_name} is already working on ${where}. Confirm transfer to move them here, or wait until that work stops.`,
        {
          confirm_transfer_required: true,
          employee_id: c.employee_id,
          employee_name: c.employee_name,
          assigned_to: c.label,
          machine_name: c.machine_name,
          conflicts: conflicts.map((x) => ({
            employee_id: x.employee_id,
            employee_name: x.employee_name,
            kind: x.kind,
            label: x.label,
            dome_number: x.dome_number,
            bulkhead_number: x.bulkhead_number,
            machine_name: x.machine_name,
          })),
        }
      );
    }

    const handoff = [];
    for (const id of ids) {
      const emp = byId.get(id);

      // Stage labor (Assembly/Correction OK; Testing blocked). Always released on Start.
      if (phase2 && typeof phase2.releaseEmployeeOpenStageLabor === 'function') {
        const stage = await phase2.releaseEmployeeOpenStageLabor(client, id, ts);
        if (!stage.ok) {
          return errResult(409, stage.error || 'employee_busy', stage.message, {
            employee_id: id,
            employee_name: emp.name,
            stage: stage.stage || null,
            tank_number: stage.tank_number || null,
          });
        }
        if (stage.left && stage.left.length) {
          handoff.push({ employee_id: id, from: 'stage', details: stage.left });
        }
      } else {
        const { rows: openStage } = await client.query(
          `SELECT p.id, s.stage, tk.tank_number, p.employee_name
           FROM stage_labor_participants p
           JOIN stage_labor_sessions s ON s.id = p.session_id
           JOIN tanks tk ON tk.id = s.tank_id
           WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active' LIMIT 1`,
          [id]
        );
        if (openStage.length) {
          const st = String(openStage[0].stage || '').toUpperCase();
          if (st !== 'ASSEMBLY' && st !== 'CORRECTION') {
            return errResult(
              409,
              'employee_busy',
              `${openStage[0].employee_name || emp.name} is in active ${st.toLowerCase()} labor on Tank ${
                openStage[0].tank_number || '?'
              }. Finish or stop that work first.`,
              { employee_id: id, stage: st, tank_number: openStage[0].tank_number }
            );
          }
        }
      }

      // Confirmed move off other Dome/Bulkhead labor.
      const mine = conflicts.filter((c) => c.employee_id === id);
      for (const c of mine) {
        if (c.kind === 'dome') {
          await client.query(
            `UPDATE dome_labor_participants SET left_at = $2::timestamptz WHERE id = $1 AND left_at IS NULL`,
            [c.participant_id, ts]
          );
          const { rows: rem } = await client.query(
            `SELECT COUNT(*)::int AS n FROM dome_labor_participants WHERE session_id = $1 AND left_at IS NULL`,
            [c.session_id]
          );
          if (rem[0] && rem[0].n === 0) {
            await client.query(
              `UPDATE dome_labor_sessions SET status = 'stopped', ended_at = $2::timestamptz, end_reason = $3, updated_at = $2::timestamptz
               WHERE id = $1 AND status = 'active'`,
              [c.session_id, ts, reason]
            );
            await client.query(
              `UPDATE domes SET production_status = 'paused', pause_reason = NULL, updated_at = $2::timestamptz
               WHERE id = $1 AND production_status = 'in_progress'`,
              [c.dome_id, ts]
            );
          }
          await client.query(
            `INSERT INTO dome_events (dome_id, event, details, performed_by, performed_at)
             VALUES ($1, 'employee_reassigned', $2::jsonb, $3, $4::timestamptz)`,
            [
              c.dome_id,
              JSON.stringify({
                employee_id: id,
                employee_name: emp.name,
                to: targetLabel,
                to_machine_id: targetMachineId,
                reason,
              }),
              'kiosk',
              ts,
            ]
          );
          handoff.push({
            employee_id: id,
            employee_name: emp.name,
            from: 'dome',
            dome_id: c.dome_id,
            dome_number: c.dome_number,
            machine_id: c.machine_id,
            machine_name: c.machine_name,
          });
        } else if (c.kind === 'bulkhead') {
          await client.query(
            `UPDATE bulkhead_labor_participants SET left_at = $2::timestamptz WHERE id = $1 AND left_at IS NULL`,
            [c.participant_id, ts]
          );
          const { rows: rem } = await client.query(
            `SELECT COUNT(*)::int AS n FROM bulkhead_labor_participants WHERE session_id = $1 AND left_at IS NULL`,
            [c.session_id]
          );
          if (rem[0] && rem[0].n === 0) {
            await client.query(
              `UPDATE bulkhead_labor_sessions SET status = 'stopped', ended_at = $2::timestamptz, end_reason = $3, updated_at = $2::timestamptz
               WHERE id = $1 AND status = 'active'`,
              [c.session_id, ts, reason]
            );
            await client.query(
              `UPDATE bulkheads SET production_status = 'paused', pause_reason = NULL, updated_at = $2::timestamptz
               WHERE id = $1 AND production_status = 'in_progress'`,
              [c.bulkhead_id, ts]
            );
          }
          await client.query(
            `INSERT INTO bulkhead_events (bulkhead_id, event, details, performed_by, performed_at)
             VALUES ($1, 'employee_reassigned', $2::jsonb, $3, $4::timestamptz)`,
            [
              c.bulkhead_id,
              JSON.stringify({
                employee_id: id,
                employee_name: emp.name,
                to: targetLabel,
                to_machine_id: targetMachineId,
                reason,
              }),
              'kiosk',
              ts,
            ]
          );
          handoff.push({
            employee_id: id,
            employee_name: emp.name,
            from: 'bulkhead',
            bulkhead_id: c.bulkhead_id,
            bulkhead_number: c.bulkhead_number,
            machine_id: c.machine_id,
            machine_name: c.machine_name,
          });
        }
      }

      // Close open shift memberships on other teams (temporary transfer). Does NOT touch
      // team_members. When keepTeamId is set (team-card Start), that team's membership stays open.
      const { rows: mem } = await client.query(
        `SELECT m.id, m.team_id, t.name AS team_name
         FROM employee_team_memberships m
         JOIN teams t ON t.id = m.team_id
         WHERE m.employee_id = $1 AND m.left_at IS NULL
           AND ($2::bigint IS NULL OR m.team_id <> $2)`,
        [id, keepTeamId]
      );
      if (mem.length) {
        await client.query(
          `UPDATE employee_team_memberships
           SET left_at = $1::timestamptz, reason = COALESCE(reason, $2)
           WHERE employee_id = $3 AND left_at IS NULL
             AND ($4::bigint IS NULL OR team_id <> $4)`,
          [ts, reason, id, keepTeamId]
        );
        for (const m of mem) {
          handoff.push({ employee_id: id, from: 'membership', team_name: m.team_name, team_id: Number(m.team_id) });
        }
      }
    }

    return {
      ok: true,
      employees: ids.map((id) => byId.get(id)),
      handoff,
      transferred_from: handoff.filter((h) => h.from === 'dome' || h.from === 'bulkhead'),
      claimed_at: ts,
    };
  }

  /** Active employees for the Create Dome / Bulkhead picker (all shops/departments). */
  async function listActiveEmployeesForPicker() {
    const { rows } = await pool.query(
      `SELECT e.id, e.code, e.name,
              m.team_id AS shift_team_id, m.name AS shift_team_name, m.department AS shift_department,
              ht.team_id AS home_team_id, ht.team_name AS home_team_name, ht.department AS home_department
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT mem.team_id, t.name, t.department
         FROM employee_team_memberships mem
         JOIN teams t ON t.id = mem.team_id
         WHERE mem.employee_id = e.id AND mem.left_at IS NULL
         ORDER BY mem.joined_at DESC, mem.id DESC
         LIMIT 1
       ) m ON TRUE
       LEFT JOIN LATERAL (
         SELECT tm.team_id, t.name AS team_name, t.department
         FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
         WHERE tm.employee_id = e.id AND tm.active = 1
         ORDER BY tm.id DESC
         LIMIT 1
       ) ht ON TRUE
       WHERE e.is_active = 1
       ORDER BY LOWER(e.name), e.id
       LIMIT 2000`
    );
    const { rows: busyDome } = await pool.query(
      `SELECT p.employee_id, s.dome_id, d.dome_number
       FROM dome_labor_participants p
       JOIN dome_labor_sessions s ON s.id = p.session_id
       JOIN domes d ON d.id = s.dome_id
       WHERE p.left_at IS NULL AND p.employee_id IS NOT NULL AND d.deleted_at IS NULL`
    ).catch(() => ({ rows: [] }));
    const { rows: busyBh } = await pool.query(
      `SELECT p.employee_id, s.bulkhead_id, b.bulkhead_number
       FROM bulkhead_labor_participants p
       JOIN bulkhead_labor_sessions s ON s.id = p.session_id
       JOIN bulkheads b ON b.id = s.bulkhead_id
       WHERE p.left_at IS NULL AND p.employee_id IS NOT NULL AND b.deleted_at IS NULL`
    ).catch(() => ({ rows: [] }));
    const busyBy = new Map();
    for (const r of busyDome) {
      busyBy.set(Number(r.employee_id), {
        kind: 'dome',
        dome_id: Number(r.dome_id),
        dome_number: r.dome_number,
      });
    }
    for (const r of busyBh) {
      if (!busyBy.has(Number(r.employee_id))) {
        busyBy.set(Number(r.employee_id), {
          kind: 'bulkhead',
          bulkhead_id: Number(r.bulkhead_id),
          bulkhead_number: r.bulkhead_number,
        });
      }
    }
    return rows.map((e) => {
      const shiftTeam = e.shift_team_id
        ? { id: Number(e.shift_team_id), name: e.shift_team_name, department: e.shift_department || null }
        : null;
      const homeTeam = e.home_team_id
        ? { id: Number(e.home_team_id), name: e.home_team_name, department: e.home_department || null }
        : null;
      // Prefer home team for department/label (Team Management); fall back to open shift team.
      const department = (homeTeam && homeTeam.department) || (shiftTeam && shiftTeam.department) || null;
      const displayName = (homeTeam && homeTeam.name) || (shiftTeam && shiftTeam.name) || null;
      return {
        id: Number(e.id),
        code: e.code || null,
        name: e.name,
        on_shift: Boolean(shiftTeam),
        team_id: homeTeam ? homeTeam.id : shiftTeam ? shiftTeam.id : null,
        team_name: displayName,
        department,
        home_team_id: homeTeam ? homeTeam.id : null,
        home_team_name: homeTeam ? homeTeam.name : null,
        home_department: homeTeam ? homeTeam.department : null,
        busy_on_dome: busyBy.get(Number(e.id)) && busyBy.get(Number(e.id)).kind === 'dome' ? busyBy.get(Number(e.id)) : null,
        busy_on_bulkhead:
          busyBy.get(Number(e.id)) && busyBy.get(Number(e.id)).kind === 'bulkhead' ? busyBy.get(Number(e.id)) : null,
        busy: busyBy.get(Number(e.id)) || null,
      };
    });
  }

  return {
    claimEmployeesForDomeWork,
    listActiveEmployeesForPicker,
  };
}

module.exports = { createPhase3EmployeeClaim };
