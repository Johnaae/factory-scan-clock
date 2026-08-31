'use strict';

/**
 * Employee team membership history, membership-aware labor hours,
 * and manager phase-session time edits.
 */

function createTeamMembershipAndLabor(pool, helpers = {}) {
  const {
    nowIso = () => new Date().toISOString(),
    sessionElapsedMs,
    isProductionPhaseCode,
    roundHours2 = (n) => Math.round((Number(n) || 0) * 100) / 100,
    formatDurationSummary,
    displayMachineName = (n) => n,
  } = helpers;

  function toMs(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  }

  function overlapMs(aStart, aEnd, bStart, bEnd) {
    const start = Math.max(aStart, bStart);
    const end = Math.min(aEnd, bEnd);
    return Math.max(0, end - start);
  }

  async function backfillOpenMembershipsIfNeeded() {
    await pool.query(
      `INSERT INTO employee_team_memberships (employee_id, team_id, joined_at, left_at, source, reason)
       SELECT tm.employee_id, tm.team_id, COALESCE(tm.created_at, NOW()), NULL, 'migrate', 'Backfill from team_members'
       FROM team_members tm
       WHERE tm.active = 1 AND tm.employee_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM employee_team_memberships m
           WHERE m.employee_id = tm.employee_id AND m.left_at IS NULL
         )`
    );
  }

  /**
   * Transfer employee onto destinationTeamId at timestamp ts.
   * Closes prior open memberships and updates team_members soft flags.
   */
  async function transferEmployeeToTeam(employeeId, destinationTeamId, opts = {}) {
    const empId = Number(employeeId);
    const teamId = Number(destinationTeamId);
    const ts = opts.at || nowIso();
    const source = opts.source || 'kiosk_transfer';
    const reason = opts.reason || null;

    const empRes = await pool.query(
      `SELECT id, code, name, is_active FROM employees WHERE id = $1`,
      [empId]
    );
    if (!empRes.rows.length) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Employee not found.' } };
    }
    const emp = empRes.rows[0];
    if (Number(emp.is_active) === 0) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'inactive_employee', message: 'That employee is inactive.' },
      };
    }
    const teamRes = await pool.query(`SELECT id, name, barcode, active FROM teams WHERE id = $1`, [teamId]);
    if (!teamRes.rows.length || !Number(teamRes.rows[0].active)) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Team not found.' } };
    }
    const destTeam = teamRes.rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE employee_team_memberships
         SET left_at = $1::timestamptz
         WHERE employee_id = $2 AND left_at IS NULL AND team_id <> $3`,
        [ts, empId, teamId]
      );
      // Already on destination?
      const openDest = await client.query(
        `SELECT id FROM employee_team_memberships
         WHERE employee_id = $1 AND team_id = $2 AND left_at IS NULL LIMIT 1`,
        [empId, teamId]
      );
      if (!openDest.rows.length) {
        // Close any open membership on destination that shouldn't exist, then insert.
        await client.query(
          `UPDATE employee_team_memberships SET left_at = $1::timestamptz
           WHERE employee_id = $2 AND left_at IS NULL`,
          [ts, empId]
        );
        await client.query(
          `INSERT INTO employee_team_memberships (employee_id, team_id, joined_at, left_at, source, reason)
           VALUES ($1, $2, $3::timestamptz, NULL, $4, $5)`,
          [empId, teamId, ts, source, reason]
        );
      }

      await client.query(
        `UPDATE team_members SET active = 0
         WHERE employee_id = $1 AND active = 1 AND team_id <> $2`,
        [empId, teamId]
      );
      const existing = await client.query(
        `SELECT id, active FROM team_members WHERE team_id = $1 AND employee_id = $2 LIMIT 1`,
        [teamId, empId]
      );
      if (existing.rows.length) {
        await client.query(
          `UPDATE team_members SET active = 1, name = $1, role = COALESCE(role, 'Operator')
           WHERE id = $2`,
          [emp.name, Number(existing.rows[0].id)]
        );
      } else {
        await client.query(
          `INSERT INTO team_members (team_id, name, role, active, employee_id, created_at)
           VALUES ($1, $2, 'Operator', 1, $3, $4::timestamptz)`,
          [teamId, emp.name, empId, ts]
        );
      }

      const fromRes = await client.query(
        `SELECT t.id, t.name
         FROM employee_team_memberships m
         JOIN teams t ON t.id = m.team_id
         WHERE m.employee_id = $1 AND m.left_at = $2::timestamptz
         ORDER BY m.id DESC LIMIT 1`,
        [empId, ts]
      );
      await client.query('COMMIT');
      const fromTeam = fromRes.rows[0] || null;
      const alreadyOnTeam = Boolean(openDest.rows.length);
      return {
        ok: true,
        body: {
          ok: true,
          action: 'employee_transferred',
          employee: { id: Number(emp.id), code: emp.code, name: emp.name },
          from_team: fromTeam
            ? { id: Number(fromTeam.id), name: fromTeam.name }
            : null,
          to_team: { id: Number(destTeam.id), name: destTeam.name },
          transferred_at: ts,
          already_on_team: alreadyOnTeam,
          confirmation_line: alreadyOnTeam
            ? `${emp.name} is already on ${destTeam.name}.`
            : fromTeam
              ? `${emp.name} transferred from ${fromTeam.name} to ${destTeam.name}.`
              : `${emp.name} joined ${destTeam.name}.`,
        },
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_e) {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Remove employee from active shift labor without stopping production.
   * Closes ALL open membership intervals for the employee (current shift).
   * Also closes open scan_logs IN interval when present.
   */
  async function employeeOutFromTeam(employeeId, teamId, opts = {}) {
    const empId = Number(employeeId);
    const teamIdNum = teamId != null ? Number(teamId) : null;
    const ts = opts.at || nowIso();
    const source = opts.source || 'kiosk_employee_out';
    const reason = opts.reason || 'Employee out';

    const empRes = await pool.query(
      `SELECT id, code, name, is_active FROM employees WHERE id = $1`,
      [empId]
    );
    if (!empRes.rows.length) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Employee not found.' } };
    }
    const emp = empRes.rows[0];
    if (Number(emp.is_active) === 0) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'inactive_employee', message: 'That employee is inactive.' },
      };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const openAll = await client.query(
        `SELECT id, team_id FROM employee_team_memberships
         WHERE employee_id = $1 AND left_at IS NULL
         ORDER BY joined_at DESC, id DESC`,
        [empId]
      );
      if (!openAll.rows.length) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            error: 'not_on_shift',
            message: `${emp.name} is not currently on shift.`,
          },
        };
      }

      const activeTeamId = Number(openAll.rows[0].team_id);
      let teamName = null;
      if (Number.isInteger(teamIdNum) && teamIdNum > 0) {
        const teamRes = await client.query(`SELECT id, name, active FROM teams WHERE id = $1`, [teamIdNum]);
        if (!teamRes.rows.length || !Number(teamRes.rows[0].active)) {
          await client.query('ROLLBACK');
          return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Team not found.' } };
        }
        teamName = teamRes.rows[0].name;
      } else {
        const teamRes = await client.query(`SELECT name FROM teams WHERE id = $1`, [activeTeamId]);
        teamName = teamRes.rows[0] ? teamRes.rows[0].name : null;
      }

      const { rowCount } = await client.query(
        `UPDATE employee_team_memberships
         SET left_at = $1::timestamptz, reason = COALESCE(reason, $4), source = $3
         WHERE employee_id = $2 AND left_at IS NULL`,
        [ts, empId, source, reason]
      );
      const scanOutWritten = await closeOpenScanClockOut(client, emp, ts, reason);
      await client.query('COMMIT');

      return {
        ok: true,
        body: {
          ok: true,
          action: 'employee_out',
          employee: { id: Number(emp.id), code: emp.code, name: emp.name },
          team: { id: activeTeamId, name: teamName },
          left_at: ts,
          memberships_closed: rowCount || 0,
          scan_clock_out: scanOutWritten,
          confirmation_line: `${emp.name} marked out for today. Production continues. Default team roster unchanged.`,
        },
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_e) {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Open shift labor memberships for default roster when Team is scanned at shift start.
   * Does not modify permanent team_members roster rows.
   */
  async function startTeamShiftMemberships(teamId, opts = {}) {
    const tid = Number(teamId);
    const ts = opts.at || nowIso();
    const source = opts.source || 'team_scan';
    const reason = opts.reason || 'Shift start';
    const { rows: roster } = await pool.query(
      `SELECT tm.employee_id, e.name
       FROM team_members tm
       JOIN employees e ON e.id = tm.employee_id
       WHERE tm.team_id = $1 AND tm.employee_id IS NOT NULL AND tm.active = 1 AND e.is_active = 1`,
      [tid]
    );
    let opened = 0;
    for (const m of roster) {
      const open = await pool.query(
        `SELECT id FROM employee_team_memberships
         WHERE employee_id = $1 AND team_id = $2 AND left_at IS NULL LIMIT 1`,
        [Number(m.employee_id), tid]
      );
      if (!open.rows.length) {
        await pool.query(
          `INSERT INTO employee_team_memberships (employee_id, team_id, joined_at, left_at, source, reason)
           VALUES ($1, $2, $3::timestamptz, NULL, $4, $5)`,
          [Number(m.employee_id), tid, ts, source, reason]
        );
        opened += 1;
      }
    }
    return { opened, roster_count: roster.length };
  }

  /**
   * Close all open shift memberships for a team (End Shift).
   */
  async function closeTeamShiftMemberships(teamId, opts = {}) {
    const tid = Number(teamId);
    const ts = opts.at || nowIso();
    const reason = opts.reason || 'end_shift';
    const { rowCount } = await pool.query(
      `UPDATE employee_team_memberships
       SET left_at = $1::timestamptz, reason = COALESCE(reason, $3)
       WHERE team_id = $2 AND left_at IS NULL`,
      [ts, tid, reason]
    );
    return { closed: rowCount || 0 };
  }

  async function getEmployeeActiveShiftTeam(employeeId) {
    const empId = Number(employeeId);
    if (!Number.isInteger(empId) || empId <= 0) return null;
    const { rows } = await pool.query(
      `SELECT m.id AS membership_id, m.team_id, m.joined_at, t.name AS team_name
       FROM employee_team_memberships m
       JOIN teams t ON t.id = m.team_id
       WHERE m.employee_id = $1 AND m.left_at IS NULL
       ORDER BY m.joined_at DESC, m.id DESC
       LIMIT 1`,
      [empId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      membership_id: Number(r.membership_id),
      team_id: Number(r.team_id),
      team_name: r.team_name,
      joined_at: r.joined_at,
    };
  }

  async function computeEmployeeMembershipProductionMs(employeeId, bounds, closeMs = Date.now()) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0 || !bounds) return 0;
    const ws = new Date(bounds.startIso).getTime();
    const we = new Date(bounds.endIso).getTime();
    if (Number.isNaN(ws) || Number.isNaN(we)) return 0;

    const { rows: memberships } = await pool.query(
      `SELECT team_id, joined_at, left_at FROM employee_team_memberships WHERE employee_id = $1`,
      [id]
    );
    const { rows: sessions } = await pool.query(
      `SELECT ms.team_id, ms.started_at, ms.finished_at, ms.stopped_at, ms.status, ms.activity_code
       FROM session_team_members stm
       INNER JOIN machine_sessions ms ON ms.id = stm.session_id
       WHERE stm.employee_id = $1`,
      [id]
    );

    let total = 0;
    for (const row of sessions) {
      const code = String(row.activity_code || '').trim().toUpperCase();
      if (typeof isProductionPhaseCode === 'function' && !isProductionPhaseCode(code)) continue;

      const startMs = toMs(row.started_at);
      let endMs;
      if (row.status === 'finished' && row.finished_at) endMs = toMs(row.finished_at);
      else if (row.status === 'stopped' && row.stopped_at) endMs = toMs(row.stopped_at);
      else endMs = closeMs;
      if (startMs == null || endMs == null || endMs <= startMs) continue;

      const boundStart = Math.max(startMs, ws);
      const boundEnd = Math.min(endMs, we, closeMs);
      if (boundEnd <= boundStart) continue;

      const teamId = Number(row.team_id);
      for (const mem of memberships) {
        if (Number(mem.team_id) !== teamId) continue;
        const joinMs = toMs(mem.joined_at);
        const leaveMs = mem.left_at ? toMs(mem.left_at) : closeMs;
        if (joinMs == null || leaveMs == null) continue;
        total += overlapMs(boundStart, boundEnd, joinMs, leaveMs);
      }
    }
    return total;
  }

  async function employeeSessionLaborMs(employeeId, sessionRow, closeMs = Date.now()) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0 || !sessionRow) return 0;
    const startMs = toMs(sessionRow.started_at);
    let endMs;
    if (sessionRow.status === 'finished' && sessionRow.finished_at) endMs = toMs(sessionRow.finished_at);
    else if (sessionRow.status === 'stopped' && sessionRow.stopped_at) endMs = toMs(sessionRow.stopped_at);
    else endMs = closeMs;
    if (startMs == null || endMs == null || endMs <= startMs) return 0;

    const { rows: memberships } = await pool.query(
      `SELECT joined_at, left_at FROM employee_team_memberships
       WHERE employee_id = $1 AND team_id = $2`,
      [id, Number(sessionRow.team_id)]
    );
    let labor = 0;
    for (const mem of memberships) {
      const joinMs = toMs(mem.joined_at);
      const leaveMs = mem.left_at ? toMs(mem.left_at) : closeMs;
      if (joinMs == null || leaveMs == null) continue;
      labor += overlapMs(startMs, endMs, joinMs, leaveMs);
    }
    return labor;
  }

  async function closeOpenScanClockOut(client, employee, ts, reason = 'Employee Out') {
    const last = await client.query(
      `SELECT status FROM scan_logs WHERE employee_id = $1 ORDER BY scanned_at DESC, id DESC LIMIT 1`,
      [Number(employee.id)]
    );
    if (!last.rows.length || String(last.rows[0].status || '').toUpperCase() !== 'IN') return false;
    await client.query(
      `INSERT INTO scan_logs (employee_code, employee_name, employee_id, status, scanned_at, note, note_category, note_value, tank_number)
       VALUES ($1, $2, $3, 'OUT', $4::timestamptz, $5, 'REASON', $5, NULL)`,
      [employee.code, employee.name, Number(employee.id), ts, reason]
    );
    return true;
  }

  async function findOpenPieceSession(tankId, pieceNumber, excludeMachineId) {
    const params = [Number(tankId), Number(pieceNumber)];
    let exclude = '';
    if (excludeMachineId != null) {
      params.push(Number(excludeMachineId));
      exclude = ` AND ms.machine_id <> $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT ms.id, ms.machine_id, ms.team_id, ms.status, ms.stop_reason, ms.piece_number, ms.piece_id,
              t.name AS team_name, m.name AS machine_name, tk.tank_number
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN machines m ON m.id = ms.machine_id
       JOIN tanks tk ON tk.id = ms.tank_id
       WHERE ms.tank_id = $1
         AND COALESCE(ms.piece_number, 1) = $2
         AND ms.status IN ('running', 'stopped')
         ${exclude}
       ORDER BY ms.started_at DESC, ms.id DESC
       LIMIT 1`,
      params
    );
    return rows[0] || null;
  }

  function sessionEndIso(row) {
    if (row.finished_at) return row.finished_at;
    if (row.status === 'stopped' && row.stopped_at) return row.stopped_at;
    if (row.status === 'running') return nowIso();
    return row.stopped_at || row.finished_at || nowIso();
  }

  /**
   * Membership-aware labor for a tank.
   * Total labor hours = sum of employee time overlapping productive sessions for their team.
   * Break/Lunch/End Shift/Downtime sessions are stopped — wall clock ends at stop, so pause time
   * is not counted in sessionElapsedMs for the open paused session.
   */
  async function computeMembershipAwareTankLabor(tankId) {
    const tid = Number(tankId);
    const { rows: sessions } = await pool.query(
      `SELECT ms.*, t.name AS team_name, m.name AS machine_name, tk.tank_number
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN machines m ON m.id = ms.machine_id
       JOIN tanks tk ON tk.id = ms.tank_id
       WHERE ms.tank_id = $1
       ORDER BY ms.started_at ASC, ms.id ASC`,
      [tid]
    );

    let totalRunningMs = 0;
    const byEmployee = new Map();
    const byPiece = new Map();

    for (const row of sessions) {
      const code = String(row.activity_code || '').trim().toUpperCase();
      if (typeof isProductionPhaseCode === 'function' && !isProductionPhaseCode(code)) continue;

      const startMs = toMs(row.started_at);
      const endMs = toMs(sessionEndIso(row));
      if (startMs == null || endMs == null || endMs <= startMs) continue;

      let productiveMs =
        typeof sessionElapsedMs === 'function' ? sessionElapsedMs(row) : Math.max(0, endMs - startMs);

      // Subtract overlapping downtime intervals for this tank/piece during the session window.
      try {
        const { rows: dts } = await pool.query(
          `SELECT started_at, ended_at, duration_ms
           FROM downtime_intervals
           WHERE tank_id = $1
             AND started_at < $3::timestamptz
             AND COALESCE(ended_at, NOW()) > $2::timestamptz
             AND (piece_number IS NULL OR piece_number = $4)`,
          [tid, row.started_at, sessionEndIso(row), Number(row.piece_number) || 1]
        );
        for (const d of dts) {
          const ds = toMs(d.started_at);
          const de = toMs(d.ended_at || nowIso());
          if (ds == null || de == null) continue;
          productiveMs -= overlapMs(startMs, endMs, ds, de);
        }
      } catch (_err) {
        /* downtime table may be missing */
      }
      productiveMs = Math.max(0, productiveMs);
      totalRunningMs += productiveMs;

      const pieceKey = Number(row.piece_number) || 1;
      if (!byPiece.has(pieceKey)) {
        byPiece.set(pieceKey, { piece_number: pieceKey, running_ms: 0, labor_ms: 0 });
      }
      byPiece.get(pieceKey).running_ms += productiveMs;

      const { rows: memberships } = await pool.query(
        `SELECT m.employee_id, m.team_id, m.joined_at, m.left_at, e.code AS employee_code, e.name AS employee_name
         FROM employee_team_memberships m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.team_id = $1
           AND m.joined_at < $3::timestamptz
           AND COALESCE(m.left_at, NOW()) > $2::timestamptz`,
        [Number(row.team_id), row.started_at, sessionEndIso(row)]
      );

      for (const mem of memberships) {
        const msJoin = toMs(mem.joined_at);
        const msLeave = toMs(mem.left_at || nowIso());
        if (msJoin == null || msLeave == null) continue;
        // Scale productive time by membership overlap ratio within session window.
        const windowMs = Math.max(1, endMs - startMs);
        const ov = overlapMs(startMs, endMs, msJoin, msLeave);
        const laborMs = Math.round(productiveMs * (ov / windowMs));
        if (laborMs <= 0) continue;
        const key = Number(mem.employee_id);
        if (!byEmployee.has(key)) {
          byEmployee.set(key, {
            employee_id: key,
            employee_code: mem.employee_code,
            employee_name: mem.employee_name,
            team_id: Number(row.team_id),
            team_name: row.team_name,
            total_ms: 0,
            teams: new Map(),
          });
        }
        const entry = byEmployee.get(key);
        entry.total_ms += laborMs;
        const tk = String(row.team_name || '');
        entry.teams.set(tk, (entry.teams.get(tk) || 0) + laborMs);
        byPiece.get(pieceKey).labor_ms += laborMs;
      }
    }

    const member_breakdown = [...byEmployee.values()]
      .map((e) => ({
        employee_id: e.employee_id,
        employee_code: e.employee_code,
        employee_name: e.employee_name,
        team_name: [...e.teams.entries()]
          .map(([name, ms]) => `${name} (${roundHours2(ms / 3600000)}h)`)
          .join(', '),
        total_hours: roundHours2(e.total_ms / 3600000),
        total_ms: e.total_ms,
      }))
      .sort((a, b) => b.total_hours - a.total_hours);

    const totalLaborMs = member_breakdown.reduce((s, m) => s + (Number(m.total_ms) || 0), 0);

    return {
      total_running_ms: totalRunningMs,
      total_running_hours: roundHours2(totalRunningMs / 3600000),
      total_running_display:
        typeof formatDurationSummary === 'function'
          ? formatDurationSummary(totalRunningMs)
          : roundHours2(totalRunningMs / 3600000) + 'h',
      total_labor_ms: totalLaborMs,
      total_labor_hours: roundHours2(totalLaborMs / 3600000),
      total_labor_display:
        typeof formatDurationSummary === 'function'
          ? formatDurationSummary(totalLaborMs)
          : roundHours2(totalLaborMs / 3600000) + 'h',
      member_breakdown,
      hours_per_piece: [...byPiece.values()].map((p) => ({
        piece_number: p.piece_number,
        running_hours: roundHours2(p.running_ms / 3600000),
        labor_hours: roundHours2(p.labor_ms / 3600000),
      })),
    };
  }

  async function editMachineSessionTimes(sessionId, patch, editor) {
    const id = Number(sessionId);
    const { rows } = await pool.query(`SELECT * FROM machine_sessions WHERE id = $1`, [id]);
    if (!rows.length) {
      return { ok: false, status: 404, body: { ok: false, error: 'not_found', message: 'Session not found.' } };
    }
    const row = rows[0];
    const reason = patch.edit_reason != null ? String(patch.edit_reason).trim() : '';
    if (!reason) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'validation', message: 'Edit reason is required.' },
      };
    }

    const originalStart = row.started_at;
    const originalEnd = row.finished_at || row.stopped_at || null;
    const originalDurationMs =
      typeof sessionElapsedMs === 'function'
        ? sessionElapsedMs(row)
        : Math.max(0, (toMs(originalEnd || nowIso()) || 0) - (toMs(originalStart) || 0));

    let newStart = patch.started_at != null ? new Date(patch.started_at) : new Date(originalStart);
    let newEnd =
      patch.ended_at != null
        ? new Date(patch.ended_at)
        : originalEnd
          ? new Date(originalEnd)
          : null;

    if (patch.duration_ms != null && Number.isFinite(Number(patch.duration_ms))) {
      // Duration is authoritative relative to start when provided without end.
      if (patch.ended_at == null) {
        newEnd = new Date(newStart.getTime() + Math.max(0, Number(patch.duration_ms)));
      }
    }
    if (Number.isNaN(newStart.getTime())) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Invalid start time.' } };
    }
    if (newEnd && Number.isNaN(newEnd.getTime())) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Invalid end time.' } };
    }
    if (newEnd && newEnd.getTime() < newStart.getTime()) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'validation', message: 'End time must be after start time.' },
      };
    }

    const editedDurationMs = newEnd
      ? Math.max(0, newEnd.getTime() - newStart.getTime())
      : originalDurationMs;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO machine_session_edits
           (session_id, tank_id, piece_id, piece_number, phase_code, phase_name,
            original_started_at, original_ended_at, original_duration_ms,
            edited_started_at, edited_ended_at, edited_duration_ms,
            edited_by_user_id, edited_by_name, edited_at, edit_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,NOW(),$15)`,
        [
          id,
          row.tank_id != null ? Number(row.tank_id) : null,
          row.piece_id != null ? Number(row.piece_id) : null,
          row.piece_number != null ? Number(row.piece_number) : null,
          row.activity_code || null,
          row.activity_name || null,
          originalStart,
          originalEnd,
          originalDurationMs,
          newStart.toISOString(),
          newEnd ? newEnd.toISOString() : null,
          editedDurationMs,
          editor && editor.user_id != null ? Number(editor.user_id) : null,
          editor && editor.name ? String(editor.name) : null,
          reason.slice(0, 500),
        ]
      );

      // Apply to session. Prefer finished_at for finished sessions; stopped_at for stopped.
      if (row.status === 'finished') {
        await client.query(
          `UPDATE machine_sessions
           SET started_at = $1::timestamptz, finished_at = $2::timestamptz, updated_at = NOW()
           WHERE id = $3`,
          [newStart.toISOString(), newEnd ? newEnd.toISOString() : row.finished_at, id]
        );
      } else if (row.status === 'stopped') {
        await client.query(
          `UPDATE machine_sessions
           SET started_at = $1::timestamptz, stopped_at = $2::timestamptz, updated_at = NOW()
           WHERE id = $3`,
          [newStart.toISOString(), newEnd ? newEnd.toISOString() : row.stopped_at, id]
        );
      } else {
        // Running: allow start edit; if end provided, finish/stop consistently as finished wall-clock end.
        if (newEnd) {
          await client.query(
            `UPDATE machine_sessions
             SET started_at = $1::timestamptz, status = 'finished', finished_at = $2::timestamptz, updated_at = NOW()
             WHERE id = $3`,
            [newStart.toISOString(), newEnd.toISOString(), id]
          );
        } else {
          await client.query(
            `UPDATE machine_sessions SET started_at = $1::timestamptz, updated_at = NOW() WHERE id = $2`,
            [newStart.toISOString(), id]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_e) {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }

    const edits = await listSessionEdits(id);
    return {
      ok: true,
      body: {
        ok: true,
        session_id: id,
        tank_id: row.tank_id != null ? Number(row.tank_id) : null,
        piece_id: row.piece_id != null ? Number(row.piece_id) : null,
        piece_number: row.piece_number != null ? Number(row.piece_number) : null,
        phase_code: row.activity_code || null,
        edited: true,
        edits,
        message: 'Phase session times updated.',
      },
    };
  }

  async function listSessionEdits(sessionId) {
    const { rows } = await pool.query(
      `SELECT * FROM machine_session_edits WHERE session_id = $1 ORDER BY edited_at DESC, id DESC`,
      [Number(sessionId)]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      session_id: Number(r.session_id),
      tank_id: r.tank_id != null ? Number(r.tank_id) : null,
      piece_id: r.piece_id != null ? Number(r.piece_id) : null,
      piece_number: r.piece_number != null ? Number(r.piece_number) : null,
      phase_code: r.phase_code || null,
      phase_name: r.phase_name || null,
      original_started_at: r.original_started_at,
      original_ended_at: r.original_ended_at,
      original_duration_ms: r.original_duration_ms != null ? Number(r.original_duration_ms) : null,
      edited_started_at: r.edited_started_at,
      edited_ended_at: r.edited_ended_at,
      edited_duration_ms: r.edited_duration_ms != null ? Number(r.edited_duration_ms) : null,
      edited_by_user_id: r.edited_by_user_id != null ? Number(r.edited_by_user_id) : null,
      edited_by_name: r.edited_by_name || null,
      edited_at: r.edited_at,
      edit_reason: r.edit_reason,
    }));
  }

  return {
    backfillOpenMembershipsIfNeeded,
    transferEmployeeToTeam,
    employeeOutFromTeam,
    getEmployeeActiveShiftTeam,
    startTeamShiftMemberships,
    closeTeamShiftMemberships,
    findOpenPieceSession,
    computeMembershipAwareTankLabor,
    computeEmployeeMembershipProductionMs,
    employeeSessionLaborMs,
    editMachineSessionTimes,
    listSessionEdits,
  };
}

module.exports = { createTeamMembershipAndLabor };
