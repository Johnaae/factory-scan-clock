'use strict';

/**
 * Phase 3 — Dome Shop kiosk, Dome Inventory, Fabrication Dome Install, Complete Tank dome gate.
 * Tables: scripts/phase3-schema-sql.js (created by the startup schema pass).
 *
 * Dome production labor lives in dome_labor_sessions / dome_labor_participants (one row per
 * work interval, like Phase 2 stage labor). Dome Install labor is a normal Fabrication
 * machine_sessions row (phase DOME_INSTALL), so Lunch / Resume / Downtime / End Shift and
 * Fabrication labor reports work unchanged.
 */

const { DOME_DIAMETERS_FT, DOME_TYPES, PHASE3_DOME_RELATIONS } = require('./phase3-schema-sql');

const DOME_INSTALL_PHASE = { code: 'DOME_INSTALL', label: 'Dome Install' };
const READY_RECHECK_MS = 60000;
const DOME_TANK_STATUSES = ['ready_for_dome_install', 'ready_for_final_completion', 'ready_to_ship', 'final_ready'];

function errResult(status, error, message, extra = {}) {
  return { ok: false, status, body: { ok: false, error, message, ...extra } };
}

function okResult(body, status = 200) {
  return { ok: true, status, body: { ok: true, ...body } };
}

function toMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function formatXhYm(ms) {
  const totalMin = Math.round(Math.max(0, Number(ms) || 0) / 60000);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function normalizeDomeNumber(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function parseDomeType(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  return DOME_TYPES.find((t) => t.toLowerCase() === s) || undefined;
}

function parseDiameter(raw) {
  const m = String(raw == null ? '' : raw).match(/^\s*(\d{1,2})\s*(?:'|ft|feet|’)?\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return DOME_DIAMETERS_FT.includes(n) ? n : null;
}

function parseWeight(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return undefined;
  return Math.round(n * 100) / 100;
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

function isDomeTankStatus(status) {
  const s = String(status == null ? '' : status)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return DOME_TANK_STATUSES.includes(s);
}

function mapDome(row) {
  if (!row) return null;
  const diameter = row.diameter_ft != null ? Number(row.diameter_ft) : null;
  return {
    id: Number(row.id),
    dome_number: row.dome_number,
    dome_type: row.dome_type || null,
    diameter_ft: diameter,
    diameter_label: diameter != null ? `${diameter}'` : null,
    weight_lbs: row.weight_lbs != null ? Number(row.weight_lbs) : null,
    production_status: row.production_status,
    pause_reason: row.pause_reason || null,
    inventory_status: row.inventory_status,
    source: row.source,
    machine_id: row.machine_id != null ? Number(row.machine_id) : null,
    team_id: row.team_id != null ? Number(row.team_id) : null,
    team_name: row.team_name || null,
    notes: row.notes || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    installed_at: row.installed_at || null,
    installed_tank_id: row.installed_tank_id != null ? Number(row.installed_tank_id) : null,
    installed_tank_number: row.installed_tank_number || null,
    installed_piece_number: row.installed_piece_number != null ? Number(row.installed_piece_number) : null,
    updated_at: row.updated_at || null,
  };
}

function createPhase3Dome(pool, helpers = {}) {
  const nowIso = helpers.nowIso || (() => new Date().toISOString());
  const phase1 = helpers.phase1;
  const phase2 = helpers.phase2;
  const isEmployeeShopsReady = helpers.isEmployeeShopsReady || (async () => false);

  let readyCache = { value: false, checkedAt: 0 };

  async function isReady() {
    if (readyCache.value) return true;
    if (Date.now() - readyCache.checkedAt < READY_RECHECK_MS && readyCache.checkedAt) return false;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [PHASE3_DOME_RELATIONS]
      );
      readyCache = { value: rows[0].n === PHASE3_DOME_RELATIONS.length, checkedAt: Date.now() };
    } catch (_err) {
      readyCache = { value: false, checkedAt: Date.now() };
    }
    return readyCache.value;
  }

  function notReady() {
    return errResult(
      503,
      'dome_not_ready',
      'Dome features are not available yet — the database update has not finished. Try again in a minute.'
    );
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      if (result && result.ok === false) {
        await client.query('ROLLBACK');
        return result;
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err && err.code === '23505') {
        const c = String(err.constraint || '');
        if (c === 'idx_domes_number_unique') {
          return errResult(409, 'duplicate_dome_number', 'That Dome Number already exists. Enter a different number.');
        }
        if (c === 'idx_dome_installations_one_live') {
          return errResult(409, 'dome_unavailable', 'That dome was just assigned to another tank. Select a different dome.');
        }
        if (c === 'idx_dome_labor_participants_open_employee') {
          return errResult(409, 'employee_busy', 'An employee is already working on another dome.');
        }
        if (c === 'idx_dome_labor_sessions_one_active') {
          return errResult(409, 'dome_already_running', 'This dome is already running.');
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function logEvent(client, domeId, event, details, performedBy, ts) {
    await client.query(
      `INSERT INTO dome_events (dome_id, event, details, performed_by, performed_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)`,
      [domeId, event, details ? JSON.stringify(details) : null, performedBy || null, ts || nowIso()]
    );
  }

  // ---------------------------------------------------------------- shared reads

  async function loadFabricators(domeIds, client = pool) {
    const ids = parseIdList(domeIds);
    const map = new Map();
    if (!ids.length) return map;
    const { rows } = await client.query(
      `SELECT df.dome_id, e.id, e.code, e.name, e.is_active
       FROM dome_fabricators df JOIN employees e ON e.id = df.employee_id
       WHERE df.dome_id = ANY($1::bigint[])
       ORDER BY LOWER(e.name), e.id`,
      [ids]
    );
    for (const r of rows) {
      const k = Number(r.dome_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ id: Number(r.id), code: r.code, name: r.name, active: Number(r.is_active) === 1 });
    }
    return map;
  }

  /** Production time + per-employee labor for domes, from dome labor rows. */
  async function loadLaborSummary(domeIds, client = pool, closeMs = Date.now()) {
    const ids = parseIdList(domeIds);
    const out = new Map();
    if (!ids.length) return out;
    const { rows: sessions } = await client.query(
      `SELECT id, dome_id, status, started_at, ended_at FROM dome_labor_sessions
       WHERE dome_id = ANY($1::bigint[]) ORDER BY started_at`,
      [ids]
    );
    const { rows: parts } = await client.query(
      `SELECT p.session_id, p.employee_id, p.employee_code, p.employee_name, p.hourly_rate, p.joined_at, p.left_at,
              s.dome_id, s.status, s.ended_at
       FROM dome_labor_participants p JOIN dome_labor_sessions s ON s.id = p.session_id
       WHERE s.dome_id = ANY($1::bigint[])`,
      [ids]
    );
    for (const id of ids) {
      out.set(id, { production_ms: 0, active_since: null, employees: new Map() });
    }
    for (const s of sessions) {
      const entry = out.get(Number(s.dome_id));
      const start = toMs(s.started_at);
      const end = s.status === 'active' ? closeMs : toMs(s.ended_at) || closeMs;
      if (start != null && end > start) entry.production_ms += end - start;
      if (s.status === 'active') entry.active_since = s.started_at;
    }
    for (const p of parts) {
      const entry = out.get(Number(p.dome_id));
      const start = toMs(p.joined_at);
      let end = toMs(p.left_at);
      if (end == null) end = p.status === 'active' ? closeMs : toMs(p.ended_at) || closeMs;
      const ms = start != null && end > start ? end - start : 0;
      const key = p.employee_id != null ? `id:${p.employee_id}` : `code:${p.employee_code || p.employee_name}`;
      if (!entry.employees.has(key)) {
        entry.employees.set(key, {
          employee_id: p.employee_id != null ? Number(p.employee_id) : null,
          employee_code: p.employee_code || null,
          employee_name: p.employee_name || null,
          hourly_rate: p.hourly_rate != null ? Number(p.hourly_rate) : null,
          labor_ms: 0,
        });
      }
      entry.employees.get(key).labor_ms += ms;
    }
    for (const [id, entry] of out) {
      const employees = [...entry.employees.values()].map((e) => ({
        ...e,
        labor_hours: Math.round((e.labor_ms / 3600000) * 100) / 100,
        labor_display: formatXhYm(e.labor_ms),
      }));
      const laborMs = employees.reduce((a, e) => a + e.labor_ms, 0);
      out.set(id, {
        production_ms: entry.production_ms,
        production_display: formatXhYm(entry.production_ms),
        active_since: entry.active_since,
        labor_ms: laborMs,
        labor_display: formatXhYm(laborMs),
        employees,
      });
    }
    return out;
  }

  async function lockDome(client, domeId) {
    const { rows } = await client.query(`SELECT * FROM domes WHERE id = $1 FOR UPDATE`, [domeId]);
    return rows[0] || null;
  }

  async function activeEmployees(ids, client) {
    if (!ids.length) return [];
    const { rows } = await client.query(
      `SELECT id, code, name, hourly_rate, is_active FROM employees WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    return rows;
  }

  async function domeShopEmployeeIds(client = pool) {
    if (!(await isEmployeeShopsReady())) return null;
    const { rows } = await client.query(
      `SELECT es.employee_id FROM employee_shops es JOIN employees e ON e.id = es.employee_id
       WHERE es.shop = 'Dome' AND e.is_active = 1`
    );
    return new Set(rows.map((r) => Number(r.employee_id)));
  }

  /**
   * Validates fabricator ids: active employees with the Dome shop (when shop data exists).
   * Employees on shift with a Dome team on the kiosk (shopExempt) skip the shop check.
   */
  async function validateFabricators(ids, client, shopExempt = new Set()) {
    if (!ids.length) {
      return { error: errResult(400, 'fabricators_required', 'Select at least one fabricator.') };
    }
    const rows = await activeEmployees(ids, client);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const missing = ids.filter((id) => !byId.has(id) || Number(byId.get(id).is_active) !== 1);
    if (missing.length) {
      return { error: errResult(400, 'invalid_fabricator', 'One or more selected fabricators are not active employees.') };
    }
    const shopSet = await domeShopEmployeeIds(client);
    if (shopSet) {
      const notDome = ids.filter((id) => !shopSet.has(id) && !shopExempt.has(id)).map((id) => byId.get(id).name);
      if (notDome.length) {
        return {
          error: errResult(
            409,
            'not_dome_shop',
            `Not assigned to the Dome shop: ${notDome.join(', ')}. A manager can update Shop Assignment.`,
            { employees: notDome }
          ),
        };
      }
    }
    return { employees: ids.map((id) => byId.get(id)) };
  }

  async function busyElsewhere(employeeIds, domeId, client) {
    if (!employeeIds.length) return [];
    const { rows } = await client.query(
      `SELECT p.employee_id, p.employee_name, d.dome_number
       FROM dome_labor_participants p
       JOIN dome_labor_sessions s ON s.id = p.session_id
       JOIN domes d ON d.id = s.dome_id
       WHERE p.left_at IS NULL AND p.employee_id = ANY($1::bigint[]) AND s.dome_id <> $2`,
      [employeeIds, domeId]
    );
    return rows;
  }

  function busyResult(rows) {
    const names = rows.map((r) => `${r.employee_name} (Dome ${r.dome_number})`).join(', ');
    return errResult(409, 'employee_busy', `Already working on another dome: ${names}.`, {
      busy: rows.map((r) => ({ employee_id: Number(r.employee_id), employee_name: r.employee_name, dome_number: r.dome_number })),
    });
  }

  async function openLabor(client, dome, teamId, machineId, employees, ts) {
    const { rows } = await client.query(
      `INSERT INTO dome_labor_sessions (dome_id, machine_id, team_id, status, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4::timestamptz, $4::timestamptz, $4::timestamptz) RETURNING id`,
      [dome.id, machineId, teamId, ts]
    );
    const sessionId = Number(rows[0].id);
    for (const e of employees) {
      await client.query(
        `INSERT INTO dome_labor_participants
           (session_id, employee_id, employee_code, employee_name, hourly_rate, joined_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)`,
        [sessionId, Number(e.id), e.code || null, e.name || null, e.hourly_rate != null ? Number(e.hourly_rate) : null, ts]
      );
    }
    return sessionId;
  }

  async function closeLabor(client, domeId, ts, statusTarget, reason) {
    const { rows } = await client.query(
      `UPDATE dome_labor_sessions
       SET status = $3, ended_at = $2::timestamptz, end_reason = $4, updated_at = $2::timestamptz
       WHERE dome_id = $1 AND status = 'active'
       RETURNING id`,
      [domeId, ts, statusTarget, reason]
    );
    for (const r of rows) {
      await client.query(
        `UPDATE dome_labor_participants SET left_at = $2::timestamptz WHERE session_id = $1 AND left_at IS NULL`,
        [Number(r.id), ts]
      );
    }
    return rows.length;
  }

  /**
   * Start (or restart after Stop / Lunch / End Shift) labor for one locked dome row. The team's
   * workers become participants and are added to the dome's fabricators; the dome moves to that team.
   */
  async function startLaborForLockedDome(client, dome, machine, team, employees, ts, event) {
    if (!employees.length) {
      return errResult(
        409,
        'no_workers',
        `Nobody can work on Dome ${dome.dome_number}: ${team.name} has no employees on shift. Scan employee badges onto the team first.`,
        { dome_number: dome.dome_number, team_name: team.name }
      );
    }
    const busy = await busyElsewhere(employees.map((e) => Number(e.id)), dome.id, client);
    if (busy.length) return busyResult(busy);
    await openLabor(client, dome, team.id, machine.id, employees, ts);
    for (const e of employees) {
      await client.query(
        `INSERT INTO dome_fabricators (dome_id, employee_id, added_at) VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (dome_id, employee_id) DO NOTHING`,
        [dome.id, Number(e.id), ts]
      );
    }
    await client.query(
      `UPDATE domes SET production_status = 'in_progress', pause_reason = NULL,
              started_at = COALESCE(started_at, $2::timestamptz), team_id = $3,
              updated_at = $2::timestamptz
       WHERE id = $1`,
      [dome.id, ts, team.id]
    );
    await logEvent(
      client,
      dome.id,
      event,
      { machine_id: Number(machine.id), team_id: team.id, employees: employees.map((e) => Number(e.id)) },
      'kiosk',
      ts
    );
    return null;
  }

  // ---------------------------------------------------------------- Dome teams (shared Assembly presence)

  /** A team card on this Dome kiosk (assembly_kiosk_teams row, shared with the Assembly kiosk logic). */
  async function presentTeam(client, machineId, teamId, forUpdate = false) {
    const { rows } = await client.query(
      `SELECT akt.id, akt.team_id, akt.status, akt.lunch_paused_at, t.name AS team_name
       FROM assembly_kiosk_teams akt JOIN teams t ON t.id = akt.team_id
       WHERE akt.machine_id = $1 AND akt.team_id = $2 AND akt.left_at IS NULL
       ORDER BY akt.id DESC LIMIT 1${forUpdate ? ' FOR UPDATE OF akt' : ''}`,
      [machineId, teamId]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.team_id),
      name: r.team_name,
      on_lunch: String(r.status || '').toLowerCase() === 'lunch',
      lunch_paused_at: r.lunch_paused_at || null,
    };
  }

  /** Team from body.team_id (the selected card), else the fallback, else the only team on the kiosk. */
  async function resolveKioskTeam(client, machine, body, fallbackTeamId, forUpdate = false) {
    let tid = Number(body && body.team_id);
    if (!(Number.isInteger(tid) && tid > 0)) tid = Number(fallbackTeamId);
    if (!(Number.isInteger(tid) && tid > 0)) {
      const { rows } = await client.query(
        `SELECT team_id FROM assembly_kiosk_teams WHERE machine_id = $1 AND left_at IS NULL`,
        [machine.id]
      );
      if (rows.length !== 1) {
        return {
          error: rows.length
            ? errResult(409, 'select_team', 'Tap a Team card first.')
            : errResult(409, 'need_team', 'Scan your Team barcode first.'),
        };
      }
      tid = Number(rows[0].team_id);
    }
    const team = await presentTeam(client, machine.id, tid, forUpdate);
    if (!team) {
      return { error: errResult(409, 'team_not_on_kiosk', 'That team is not on this Dome kiosk. Scan the Team barcode first.') };
    }
    return { team };
  }

  /** Employees on shift with a team right now (open membership), same rule as the Assembly roster. */
  async function teamShiftEmployees(client, teamId) {
    const { rows } = await client.query(
      `SELECT DISTINCT ON (e.id) e.id, e.code, e.name, e.hourly_rate, m.joined_at
       FROM employee_team_memberships m JOIN employees e ON e.id = m.employee_id
       WHERE m.team_id = $1 AND m.left_at IS NULL AND e.is_active = 1
       ORDER BY e.id, m.joined_at ASC`,
      [teamId]
    );
    return rows;
  }

  async function kioskShiftEmployeeIds(client, machineId) {
    const { rows } = await client.query(
      `SELECT DISTINCT m.employee_id FROM employee_team_memberships m
       JOIN assembly_kiosk_teams akt ON akt.team_id = m.team_id AND akt.machine_id = $1 AND akt.left_at IS NULL
       WHERE m.left_at IS NULL`,
      [machineId]
    );
    return new Set(rows.map((r) => Number(r.employee_id)));
  }

  /** Stop a dome whose labor session has nobody left on it (everyone moved or went out). */
  async function stopSessionIfEmpty(client, sessionId, ts, reason) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM dome_labor_participants WHERE session_id = $1 AND left_at IS NULL`,
      [sessionId]
    );
    if (rows[0].n > 0) return null;
    const { rows: s } = await client.query(
      `UPDATE dome_labor_sessions SET status = 'stopped', ended_at = $2::timestamptz, end_reason = $3, updated_at = $2::timestamptz
       WHERE id = $1 AND status = 'active' RETURNING dome_id`,
      [sessionId, ts, reason]
    );
    if (!s.length) return null;
    const domeId = Number(s[0].dome_id);
    const { rows: d } = await client.query(
      `UPDATE domes SET production_status = 'paused', pause_reason = NULL, updated_at = $2::timestamptz
       WHERE id = $1 AND production_status = 'in_progress' RETURNING dome_number`,
      [domeId, ts]
    );
    await logEvent(client, domeId, 'stopped', { reason }, 'kiosk', ts);
    return d[0] ? d[0].dome_number : null;
  }

  /** Close one employee's open dome labor; a dome left with nobody working stops. */
  async function leaveDomeLabor(client, employeeId, ts, reason, keepTeamId = null) {
    const { rows } = await client.query(
      `SELECT p.id, p.session_id, s.dome_id, s.team_id, d.dome_number
       FROM dome_labor_participants p
       JOIN dome_labor_sessions s ON s.id = p.session_id
       JOIN domes d ON d.id = s.dome_id
       WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active'`,
      [employeeId]
    );
    const left = [];
    const stopped = [];
    for (const r of rows) {
      if (keepTeamId != null && Number(r.team_id) === Number(keepTeamId)) continue;
      await client.query(`UPDATE dome_labor_participants SET left_at = $2::timestamptz WHERE id = $1 AND left_at IS NULL`, [
        Number(r.id),
        ts,
      ]);
      await logEvent(client, Number(r.dome_id), 'employee_left', { employee_id: Number(employeeId), reason }, 'kiosk', ts);
      left.push(r.dome_number);
      const stoppedNumber = await stopSessionIfEmpty(client, Number(r.session_id), ts, reason);
      if (stoppedNumber) stopped.push(stoppedNumber);
    }
    return { left, stopped };
  }

  /**
   * Runs inside Phase 2 moveEmployeeToAssemblyTeam's transaction (Dome kiosk employee scan):
   * leave the old team's dome labor (history kept, no overlap) and join the selected team's
   * running dome, if any.
   */
  async function handleEmployeeTeamMove(client, { employee, destTeam, machineId, ts }) {
    if (!(await isReady())) return null;
    const empId = Number(employee.id);
    const { left, stopped } = await leaveDomeLabor(client, empId, ts, 'team_move', destTeam.id);
    const { rows: already } = await client.query(
      `SELECT 1 FROM dome_labor_participants p JOIN dome_labor_sessions s ON s.id = p.session_id
       WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active' LIMIT 1`,
      [empId]
    );
    let joined = null;
    if (!already.length) {
      const { rows: dest } = await client.query(
        `SELECT s.id, s.dome_id, d.dome_number FROM dome_labor_sessions s JOIN domes d ON d.id = s.dome_id
         WHERE s.team_id = $1 AND s.status = 'active'
         ORDER BY (s.machine_id = $2) DESC, s.started_at DESC, s.id DESC LIMIT 1`,
        [destTeam.id, machineId]
      );
      if (dest.length) {
        const { rows: er } = await client.query(`SELECT hourly_rate FROM employees WHERE id = $1`, [empId]);
        const rate = er[0] && er[0].hourly_rate != null ? Number(er[0].hourly_rate) : null;
        await client.query(
          `INSERT INTO dome_labor_participants
             (session_id, employee_id, employee_code, employee_name, hourly_rate, joined_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)`,
          [Number(dest[0].id), empId, employee.code || null, employee.name || null, rate, ts]
        );
        await client.query(
          `INSERT INTO dome_fabricators (dome_id, employee_id, added_at) VALUES ($1, $2, $3::timestamptz)
           ON CONFLICT (dome_id, employee_id) DO NOTHING`,
          [Number(dest[0].dome_id), empId, ts]
        );
        await logEvent(client, Number(dest[0].dome_id), 'employee_joined', { employee_id: empId, team_id: destTeam.id }, 'kiosk', ts);
        joined = dest[0].dome_number;
      }
    }
    return { dome_left: left, dome_stopped: stopped, dome_joined: joined };
  }

  // ---------------------------------------------------------------- Dome Shop kiosk

  async function getKioskConfig(machine) {
    if (!(await isReady())) return notReady();
    const mid = Number(machine.id);
    const presence = await phase2.syncAssemblyKioskPresenceFromAssignment(mid);
    const assignment = await phase1.getMachineAssignment(mid);
    const presentIds = new Set(presence.map((t) => Number(t.team_id)));
    const shiftTeamBy = new Map();
    for (const t of presence) {
      for (const e of t.roster || []) shiftTeamBy.set(Number(e.id), { team_id: Number(t.team_id), team_name: t.team_name });
    }

    const { rows: domeRows } = await pool.query(
      `SELECT d.*, t.name AS team_name FROM domes d LEFT JOIN teams t ON t.id = d.team_id
       WHERE d.machine_id = $1 AND d.production_status <> 'completed'
       ORDER BY d.created_at ASC, d.id ASC`,
      [mid]
    );
    const { rows: doneRows } = await pool.query(
      `SELECT d.*, t.name AS team_name FROM domes d LEFT JOIN teams t ON t.id = d.team_id
       WHERE d.machine_id = $1 AND d.production_status = 'completed' AND d.completed_at >= NOW() - INTERVAL '16 hours'
       ORDER BY d.completed_at DESC LIMIT 6`,
      [mid]
    );
    const ids = [...domeRows, ...doneRows].map((r) => Number(r.id));
    const fabs = await loadFabricators(ids);
    const labor = await loadLaborSummary(ids);
    const working = new Map();
    if (ids.length) {
      const { rows: wr } = await pool.query(
        `SELECT s.dome_id, s.team_id, p.employee_id, p.employee_name
         FROM dome_labor_sessions s JOIN dome_labor_participants p ON p.session_id = s.id
         WHERE s.dome_id = ANY($1::bigint[]) AND s.status = 'active' AND p.left_at IS NULL
         ORDER BY LOWER(p.employee_name), p.employee_id`,
        [ids]
      );
      for (const r of wr) {
        const k = Number(r.dome_id);
        if (!working.has(k)) working.set(k, []);
        working.get(k).push({ id: r.employee_id != null ? Number(r.employee_id) : null, name: r.employee_name });
      }
    }
    const decorate = (r) => {
      const d = mapDome(r);
      const l = labor.get(d.id) || {};
      return {
        ...d,
        fabricators: fabs.get(d.id) || [],
        working: working.get(d.id) || [],
        production_ms: l.production_ms || 0,
        production_display: l.production_display || '0h 0m',
        active_since: l.active_since || null,
        labor_display: l.labor_display || '0h 0m',
      };
    };
    const domes = domeRows.map(decorate);
    const teams = presence.map((t) => {
      const tid = Number(t.team_id);
      const teamDomes = domes.filter((d) => d.team_id === tid);
      return {
        id: t.id,
        team_id: tid,
        team_name: t.team_name,
        team_barcode: t.team_barcode,
        status: t.status,
        on_lunch: Boolean(t.on_lunch),
        joined_at: t.joined_at,
        lunch_paused_at: t.lunch_paused_at,
        roster: (t.roster || []).map((e) => ({ id: Number(e.id), code: e.code || null, name: e.name, joined_at: e.joined_at })),
        domes: teamDomes,
        working: teamDomes.some((d) => d.production_status === 'in_progress'),
      };
    });

    // Fabricator choices: Dome-shop employees plus everyone on shift with a team on this kiosk
    // and everyone already on a listed dome (so editing never silently drops a worker).
    const shopSet = await domeShopEmployeeIds();
    const candidateIds = new Set([...(shopSet || []), ...shiftTeamBy.keys()]);
    for (const list of fabs.values()) for (const f of list) if (f.active) candidateIds.add(f.id);
    const { rows: candidates } = candidateIds.size
      ? await pool.query(
          `SELECT id, code, name FROM employees WHERE id = ANY($1::bigint[]) AND is_active = 1 ORDER BY LOWER(name), id`,
          [[...candidateIds]]
        )
      : { rows: [] };
    const { rows: busyRows } = await pool.query(
      `SELECT p.employee_id, s.dome_id, d.dome_number FROM dome_labor_participants p
       JOIN dome_labor_sessions s ON s.id = p.session_id JOIN domes d ON d.id = s.dome_id
       WHERE p.left_at IS NULL AND p.employee_id IS NOT NULL`
    );
    const busyBy = new Map(busyRows.map((r) => [Number(r.employee_id), { dome_id: Number(r.dome_id), dome_number: r.dome_number }]));
    const fabricatorOptions = candidates.map((e) => {
      const shift = shiftTeamBy.get(Number(e.id)) || null;
      return {
        id: Number(e.id),
        code: e.code || null,
        name: e.name,
        on_shift: Boolean(shift),
        team_id: shift ? shift.team_id : null,
        team_name: shift ? shift.team_name : null,
        busy_on_dome: busyBy.get(Number(e.id)) || null,
      };
    });

    return okResult({
      workflow: 'dome',
      machine: { id: mid, name: machine.name, slug: machine.kiosk_slug },
      assignment,
      active_teams: teams,
      other_domes: domes.filter((d) => !presentIds.has(d.team_id)),
      fabricator_options: fabricatorOptions,
      shop_assignment_ready: Boolean(shopSet),
      diameters: DOME_DIAMETERS_FT,
      types: DOME_TYPES,
      domes,
      recently_completed: doneRows.map(decorate),
      state: {
        running: domes.filter((d) => d.production_status === 'in_progress').length,
        on_lunch: domes.filter((d) => d.production_status === 'paused' && d.pause_reason === 'lunch').length,
        end_shift_paused: domes.filter((d) => d.production_status === 'paused' && d.pause_reason === 'end_shift').length,
      },
      server_time: nowIso(),
    });
  }

  async function assignTeam(machine, team) {
    const dept = String(team.department || '').trim();
    if (dept && dept.toLowerCase() !== 'dome') {
      return errResult(409, 'wrong_department', `${team.name} is a ${dept} team. Scan a Dome team.`, { department: dept });
    }
    // Same multi-team presence as the Assembly kiosk: adds / focuses a team card, never replaces others.
    const added = await phase2.assignTeamToMachine(machine.id, team);
    if (!added.ok) return added;
    const b = added.body;
    return okResult({
      action: b.already_present ? 'team_present' : 'team_assigned',
      team: b.team,
      already_present: Boolean(b.already_present),
      assignment: b.assignment,
      message: b.already_present ? `${team.name} is already on this Dome kiosk.` : `${team.name} started the shift.`,
    });
  }

  /**
   * Create Dome for the selected team card. Fabricators default to the team's on-shift employees;
   * a manual pick is only needed when nobody is on shift with the team.
   */
  async function createDome(machine, body) {
    if (!(await isReady())) return notReady();
    const number = normalizeDomeNumber(body.dome_number);
    if (!number) return errResult(400, 'dome_number_required', 'Enter a Dome Number.');
    const type = parseDomeType(body.dome_type);
    if (!type) return errResult(400, 'dome_type_required', 'Select a Dome Type (Petro or Water).');
    const diameter = parseDiameter(body.diameter_ft != null ? body.diameter_ft : body.diameter);
    if (!diameter) return errResult(400, 'diameter_required', "Select a Diameter (4', 6', 8', 10' or 12').");
    return withTransaction(async (client) => {
      const { team, error } = await resolveKioskTeam(client, machine, body);
      if (error) return error;
      const roster = await teamShiftEmployees(client, team.id);
      let ids = parseIdList(body.fabricator_ids);
      if (!ids.length) ids = roster.map((e) => Number(e.id));
      if (!ids.length) {
        return errResult(
          400,
          'fabricators_required',
          `Nobody is on shift with ${team.name}. Scan employee badges onto the team, or select fabricators.`,
          { team_name: team.name }
        );
      }
      const v = await validateFabricators(ids, client, await kioskShiftEmployeeIds(client, machine.id));
      if (v.error) return v.error;
      const ts = nowIso();
      const { rows } = await client.query(
        `INSERT INTO domes (dome_number, dome_type, diameter_ft, production_status, inventory_status, source,
                            machine_id, team_id, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'created', 'not_in_inventory', 'kiosk', $4, $5, $6, $7::timestamptz, $7::timestamptz)
         RETURNING *`,
        [number, type, diameter, machine.id, team.id, `kiosk:${machine.name}`, ts]
      );
      const dome = rows[0];
      for (const id of ids) {
        await client.query(`INSERT INTO dome_fabricators (dome_id, employee_id, added_at) VALUES ($1, $2, $3::timestamptz)`, [
          dome.id,
          id,
          ts,
        ]);
      }
      await logEvent(
        client,
        dome.id,
        'created',
        { dome_type: type, diameter_ft: diameter, team_id: team.id, fabricators: ids },
        `kiosk:${machine.name}`,
        ts
      );
      return okResult({
        action: 'dome_created',
        dome: { ...mapDome(dome), team_name: team.name },
        team: { id: team.id, name: team.name },
        fabricator_ids: ids,
        message: `Dome ${number} created for ${team.name}. Press Start Dome when work begins.`,
      });
    });
  }

  /**
   * Start Dome for a team card: that team's on-shift employees become the labor participants.
   * A team runs one dome at a time; different teams run different domes at the same time.
   */
  async function startDome(machine, body) {
    if (!(await isReady())) return notReady();
    const domeId = Number(body.dome_id);
    if (!Number.isInteger(domeId) || domeId <= 0) return errResult(400, 'validation', 'Select a dome.');
    return withTransaction(async (client) => {
      const { rows: peek } = await client.query(`SELECT team_id FROM domes WHERE id = $1`, [domeId]);
      const { team, error } = await resolveKioskTeam(client, machine, body, peek[0] ? peek[0].team_id : null, true);
      if (error) return error;
      const dome = await lockDome(client, domeId);
      if (!dome || Number(dome.machine_id) !== Number(machine.id)) return errResult(404, 'not_found', 'Dome not found on this kiosk.');
      if (dome.production_status === 'completed') return errResult(409, 'dome_completed', `Dome ${dome.dome_number} is already completed.`);
      if (dome.production_status === 'in_progress') return errResult(409, 'dome_already_running', `Dome ${dome.dome_number} is already running.`);
      if (team.on_lunch) {
        return errResult(409, 'team_on_lunch', `${team.name} is on lunch. Press Resume on the team card first.`, { team_name: team.name });
      }
      const { rows: running } = await client.query(
        `SELECT d.dome_number FROM dome_labor_sessions s JOIN domes d ON d.id = s.dome_id
         WHERE s.team_id = $1 AND s.status = 'active' AND s.dome_id <> $2 LIMIT 1`,
        [team.id, domeId]
      );
      if (running.length) {
        return errResult(
          409,
          'team_busy',
          `${team.name} is already working on Dome ${running[0].dome_number}. Stop or complete it first.`,
          { team_name: team.name, dome_number: running[0].dome_number }
        );
      }
      const employees = await teamShiftEmployees(client, team.id);
      const ts = nowIso();
      const fail = await startLaborForLockedDome(client, dome, machine, team, employees, ts, dome.started_at ? 'restarted' : 'started');
      if (fail) return fail;
      return okResult({
        action: 'dome_started',
        dome_id: domeId,
        dome_number: dome.dome_number,
        team: { id: team.id, name: team.name },
        message: `Dome ${dome.dome_number} started by ${team.name}.`,
      });
    });
  }

  /** Stop Dome (Assembly STOP): labor ends now, the dome waits for Start Dome. */
  async function stopDome(machine, body) {
    if (!(await isReady())) return notReady();
    const domeId = Number(body.dome_id);
    if (!Number.isInteger(domeId) || domeId <= 0) return errResult(400, 'validation', 'Select a dome.');
    return withTransaction(async (client) => {
      const dome = await lockDome(client, domeId);
      if (!dome || Number(dome.machine_id) !== Number(machine.id)) return errResult(404, 'not_found', 'Dome not found on this kiosk.');
      if (dome.production_status !== 'in_progress') {
        return errResult(409, 'dome_not_running', `Dome ${dome.dome_number} is not running.`, { dome_number: dome.dome_number });
      }
      const ts = nowIso();
      await closeLabor(client, dome.id, ts, 'stopped', 'stop');
      await client.query(
        `UPDATE domes SET production_status = 'paused', pause_reason = NULL, updated_at = $2::timestamptz WHERE id = $1`,
        [dome.id, ts]
      );
      await logEvent(client, dome.id, 'stopped', { reason: 'stop' }, 'kiosk', ts);
      return okResult({ action: 'dome_stopped', dome_id: domeId, dome_number: dome.dome_number, message: `Dome ${dome.dome_number} stopped.` });
    });
  }

  /** Team Lunch (Assembly rule): this team card only — its running dome pauses, other teams keep working. */
  async function lunch(machine, body = {}) {
    if (!(await isReady())) return notReady();
    return withTransaction(async (client) => {
      const { team, error } = await resolveKioskTeam(client, machine, body, null, true);
      if (error) return error;
      const { rows } = await client.query(
        `SELECT d.* FROM domes d
         WHERE d.machine_id = $1 AND d.production_status = 'in_progress'
           AND EXISTS (SELECT 1 FROM dome_labor_sessions s WHERE s.dome_id = d.id AND s.status = 'active' AND s.team_id = $2)
         ORDER BY d.id FOR UPDATE`,
        [machine.id, team.id]
      );
      const ts = nowIso();
      for (const d of rows) {
        await closeLabor(client, d.id, ts, 'stopped', 'lunch');
        await client.query(
          `UPDATE domes SET production_status = 'paused', pause_reason = 'lunch', updated_at = $2::timestamptz WHERE id = $1`,
          [d.id, ts]
        );
        await logEvent(client, d.id, 'lunch', { team_id: team.id }, 'kiosk', ts);
      }
      await client.query(
        `UPDATE assembly_kiosk_teams SET status = 'lunch', lunch_paused_at = $1::timestamptz, updated_at = $1::timestamptz
         WHERE machine_id = $2 AND team_id = $3 AND left_at IS NULL`,
        [ts, machine.id, team.id]
      );
      const list = rows.map((d) => d.dome_number);
      return okResult({
        action: 'lunch',
        team_id: team.id,
        team_name: team.name,
        dome_numbers: list,
        count: list.length,
        message: list.length ? `${team.name} on lunch. Dome ${list.join(', ')} paused.` : `${team.name} on lunch.`,
      });
    });
  }

  /**
   * Team Resume (Assembly rule): restart the domes this team paused for lunch with the prior workers
   * still on shift plus anyone who joined the team during lunch. Always clears the team's lunch.
   */
  async function resume(machine, body = {}) {
    if (!(await isReady())) return notReady();
    return withTransaction(async (client) => {
      const { team, error } = await resolveKioskTeam(client, machine, body, null, true);
      if (error) return error;
      const { rows: lunchDomes } = await client.query(
        `SELECT * FROM domes WHERE machine_id = $1 AND team_id = $2 AND production_status = 'paused' AND pause_reason = 'lunch'
         ORDER BY updated_at DESC, id DESC FOR UPDATE`,
        [machine.id, team.id]
      );
      const roster = await teamShiftEmployees(client, team.id);
      const lunchAt = toMs(team.lunch_paused_at);
      const ts = nowIso();
      const resumed = [];
      const used = new Set();
      for (const d of lunchDomes) {
        const { rows: prior } = await client.query(
          `SELECT DISTINCT p.employee_id FROM dome_labor_participants p
           WHERE p.session_id = (SELECT id FROM dome_labor_sessions WHERE dome_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1)`,
          [d.id]
        );
        const priorIds = new Set(prior.map((r) => Number(r.employee_id)));
        let employees = roster.filter((e) => priorIds.has(Number(e.id)) || (lunchAt != null && toMs(e.joined_at) > lunchAt));
        if (!employees.length) employees = roster;
        employees = employees.filter((e) => !used.has(Number(e.id)));
        if (!employees.length) continue;
        const fail = await startLaborForLockedDome(client, d, machine, team, employees, ts, 'resumed');
        if (fail) return fail;
        for (const e of employees) used.add(Number(e.id));
        resumed.push(d.dome_number);
      }
      await client.query(
        `UPDATE assembly_kiosk_teams SET status = 'active', lunch_paused_at = NULL, updated_at = $1::timestamptz
         WHERE machine_id = $2 AND team_id = $3 AND left_at IS NULL`,
        [ts, machine.id, team.id]
      );
      return okResult({
        action: 'resume',
        team_id: team.id,
        team_name: team.name,
        dome_numbers: resumed,
        count: resumed.length,
        message: resumed.length ? `${team.name} resumed Dome ${resumed.join(', ')}.` : `${team.name} is back from lunch.`,
      });
    });
  }

  /**
   * Team End Shift (Assembly rule): this team's domes pause for the next shift, its card leaves the
   * kiosk and temporary moves into the team end. Default team rosters are untouched.
   */
  async function endShift(machine, body = {}) {
    if (!(await isReady())) return notReady();
    const ts = nowIso();
    const result = await withTransaction(async (client) => {
      const { team, error } = await resolveKioskTeam(client, machine, body, null, true);
      if (error) return error;
      const { rows } = await client.query(
        `SELECT d.* FROM domes d
         WHERE d.machine_id = $1
           AND (
             (d.production_status = 'paused' AND d.pause_reason = 'lunch' AND d.team_id = $2)
             OR (d.production_status = 'in_progress' AND EXISTS (
               SELECT 1 FROM dome_labor_sessions s WHERE s.dome_id = d.id AND s.status = 'active' AND s.team_id = $2))
           )
         ORDER BY d.id FOR UPDATE`,
        [machine.id, team.id]
      );
      for (const d of rows) {
        await closeLabor(client, d.id, ts, 'stopped', 'end_shift');
        await client.query(
          `UPDATE domes SET production_status = 'paused', pause_reason = 'end_shift', updated_at = $2::timestamptz WHERE id = $1`,
          [d.id, ts]
        );
        await logEvent(client, d.id, 'end_shift', { team_id: team.id }, 'kiosk', ts);
      }
      await client.query(
        `UPDATE assembly_kiosk_teams SET left_at = $1::timestamptz, status = 'left', updated_at = $1::timestamptz
         WHERE machine_id = $2 AND team_id = $3 AND left_at IS NULL`,
        [ts, machine.id, team.id]
      );
      // Keep the legacy single-team assignment on a team still here, so the card is not re-synced back.
      const { rows: rest } = await client.query(
        `SELECT team_id FROM assembly_kiosk_teams WHERE machine_id = $1 AND left_at IS NULL ORDER BY joined_at DESC, id DESC LIMIT 1`,
        [machine.id]
      );
      if (rest.length) {
        await client.query(`UPDATE machines SET assigned_team_id = $2 WHERE id = $1 AND assigned_team_id = $3`, [
          machine.id,
          Number(rest[0].team_id),
          team.id,
        ]);
      } else {
        await client.query(
          `UPDATE machines SET assigned_team_id = NULL, assigned_team_day = NULL, assigned_team_at = NULL WHERE id = $1`,
          [machine.id]
        );
      }
      const list = rows.map((d) => d.dome_number);
      return okResult({
        action: 'end_shift',
        team_id: team.id,
        team_name: team.name,
        dome_numbers: list,
        count: list.length,
        message: list.length
          ? `End Shift for ${team.name}. Dome ${list.join(', ')} paused for the next shift.`
          : `End Shift for ${team.name}.`,
      });
    });
    if (result.ok) await phase2.endAssemblyTeamMoves(result.body.team_id, { at: ts });
    return result;
  }

  async function completeDome(machine, body) {
    if (!(await isReady())) return notReady();
    const domeId = Number(body.dome_id);
    if (!Number.isInteger(domeId) || domeId <= 0) return errResult(400, 'validation', 'Select a dome.');
    const weight = parseWeight(body.weight_lbs != null ? body.weight_lbs : body.weight);
    if (weight == null || weight === undefined) {
      return errResult(400, 'weight_required', 'Enter the Dome Weight in pounds (greater than 0).');
    }
    return withTransaction(async (client) => {
      const dome = await lockDome(client, domeId);
      if (!dome || Number(dome.machine_id) !== Number(machine.id)) return errResult(404, 'not_found', 'Dome not found on this kiosk.');
      if (dome.production_status === 'completed') return errResult(409, 'dome_completed', `Dome ${dome.dome_number} is already completed.`);
      if (!dome.started_at) return errResult(409, 'dome_not_started', `Start Dome ${dome.dome_number} before completing it.`);
      const ts = nowIso();
      await closeLabor(client, dome.id, ts, 'finished', 'complete');
      const { rows } = await client.query(
        `UPDATE domes
         SET production_status = 'completed', pause_reason = NULL, weight_lbs = $2, completed_at = $3::timestamptz,
             inventory_status = 'available', updated_at = $3::timestamptz
         WHERE id = $1 RETURNING *`,
        [dome.id, weight, ts]
      );
      await logEvent(client, dome.id, 'completed', { weight_lbs: weight }, 'kiosk', ts);
      return okResult({
        action: 'dome_completed',
        dome: mapDome(rows[0]),
        message: `Dome ${dome.dome_number} completed (${weight} lb) and added to Dome Inventory.`,
      });
    });
  }

  async function setFabricators(machine, body) {
    if (!(await isReady())) return notReady();
    const domeId = Number(body.dome_id);
    if (!Number.isInteger(domeId) || domeId <= 0) return errResult(400, 'validation', 'Select a dome.');
    const ids = parseIdList(body.fabricator_ids);
    return withTransaction(async (client) => {
      const dome = await lockDome(client, domeId);
      if (!dome || Number(dome.machine_id) !== Number(machine.id)) return errResult(404, 'not_found', 'Dome not found on this kiosk.');
      if (dome.production_status === 'completed') return errResult(409, 'dome_completed', `Dome ${dome.dome_number} is already completed.`);
      const { rows: cur } = await client.query(`SELECT employee_id FROM dome_fabricators WHERE dome_id = $1`, [domeId]);
      const before = cur.map((r) => Number(r.employee_id));
      const exempt = await kioskShiftEmployeeIds(client, machine.id);
      for (const id of before) exempt.add(id);
      const v = await validateFabricators(ids, client, exempt);
      if (v.error) return v.error;
      const added = ids.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !ids.includes(id));
      const ts = nowIso();
      const { rows: act } = await client.query(
        `SELECT id FROM dome_labor_sessions WHERE dome_id = $1 AND status = 'active' LIMIT 1`,
        [domeId]
      );
      const activeSessionId = act[0] ? Number(act[0].id) : null;
      if (activeSessionId && added.length) {
        const busy = await busyElsewhere(added, domeId, client);
        if (busy.length) return busyResult(busy);
      }
      if (removed.length) {
        await client.query(`DELETE FROM dome_fabricators WHERE dome_id = $1 AND employee_id = ANY($2::bigint[])`, [domeId, removed]);
        if (activeSessionId) {
          await client.query(
            `UPDATE dome_labor_participants SET left_at = $3::timestamptz
             WHERE session_id = $1 AND employee_id = ANY($2::bigint[]) AND left_at IS NULL`,
            [activeSessionId, removed, ts]
          );
        }
      }
      for (const id of added) {
        await client.query(`INSERT INTO dome_fabricators (dome_id, employee_id, added_at) VALUES ($1, $2, $3::timestamptz)`, [domeId, id, ts]);
      }
      if (activeSessionId && added.length) {
        for (const e of v.employees.filter((x) => added.includes(Number(x.id)))) {
          await client.query(
            `INSERT INTO dome_labor_participants
               (session_id, employee_id, employee_code, employee_name, hourly_rate, joined_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)`,
            [activeSessionId, Number(e.id), e.code || null, e.name || null, e.hourly_rate != null ? Number(e.hourly_rate) : null, ts]
          );
        }
      }
      await logEvent(client, domeId, 'fabricators_changed', { added, removed }, 'kiosk', ts);
      const stopped = activeSessionId ? await stopSessionIfEmpty(client, activeSessionId, ts, 'fabricators_removed') : null;
      return okResult({
        action: 'fabricators_updated',
        dome_id: domeId,
        dome_stopped: stopped ? [stopped] : [],
        message: `Fabricators updated for Dome ${dome.dome_number}.`,
      });
    });
  }

  /**
   * Dome kiosk Employee Out from a team card: leave open dome labor (a dome left with nobody on it
   * stops), then the shared shift-out. Production on the team's dome continues with the others.
   */
  async function employeeOut(machine, body) {
    if (!(await isReady())) return notReady();
    const employeeId = Number(body.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) return errResult(400, 'validation', 'Select an employee.');
    let teamId = Number(body.team_id);
    if (!(Number.isInteger(teamId) && teamId > 0)) {
      const active = await phase1.getEmployeeActiveShiftTeam(employeeId);
      teamId = active ? Number(active.team_id) : null;
    }
    const { team, error } = await resolveKioskTeam(pool, machine, { team_id: teamId });
    if (error) return error;
    const onShift = await phase1.listOpenShiftEmployeesForTeam(team.id);
    if (!onShift.some((e) => Number(e.id) === employeeId)) {
      return errResult(409, 'not_on_shift', 'That employee is not currently on shift for this team.');
    }
    const ts = nowIso();
    const labor = await withTransaction(async (client) =>
      okResult(await leaveDomeLabor(client, employeeId, ts, 'employee_out'))
    );
    const out = await phase1.employeeOutFromTeam(employeeId, team.id, {
      at: ts,
      source: 'kiosk_employee_out',
      reason: 'Dome kiosk employee out',
    });
    if (!out.ok) return out;
    return okResult({
      ...out.body,
      action: 'employee_out',
      team_id: team.id,
      dome_left: labor.body.left,
      dome_stopped: labor.body.stopped,
    });
  }

  // ---------------------------------------------------------------- Inventory

  const INVENTORY_FILTERS = {
    available: `d.inventory_status = 'available'`,
    reserved: `d.inventory_status = 'reserved'`,
    installed: `d.inventory_status = 'installed'`,
    in_production: `d.production_status <> 'completed'`,
  };

  async function listDomes(filters = {}) {
    if (!(await isReady())) return notReady();
    const where = ['TRUE'];
    const params = [];
    const search = String(filters.search || '').trim();
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      where.push(`(UPPER(d.dome_number) LIKE $${params.length} OR UPPER(COALESCE(d.installed_tank_number, '')) LIKE $${params.length})`);
    }
    const diameter = parseDiameter(filters.diameter);
    if (diameter) {
      params.push(diameter);
      where.push(`d.diameter_ft = $${params.length}`);
    }
    const type = String(filters.type || '').trim().toLowerCase();
    if (type === 'unknown') where.push('d.dome_type IS NULL');
    else if (parseDomeType(type)) {
      params.push(parseDomeType(type));
      where.push(`d.dome_type = $${params.length}`);
    }
    const status = String(filters.status || '').trim().toLowerCase();
    if (INVENTORY_FILTERS[status]) where.push(INVENTORY_FILTERS[status]);
    const { rows } = await pool.query(
      `SELECT d.*, t.name AS team_name FROM domes d LEFT JOIN teams t ON t.id = d.team_id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE d.inventory_status WHEN 'available' THEN 0 WHEN 'reserved' THEN 1 WHEN 'not_in_inventory' THEN 2 ELSE 3 END,
                d.diameter_ft, UPPER(d.dome_number)
       LIMIT 1000`,
      params
    );
    const { rows: counts } = await pool.query(
      `SELECT inventory_status, production_status, COUNT(*)::int AS n FROM domes GROUP BY 1, 2`
    );
    const totals = { all: 0, available: 0, reserved: 0, installed: 0, in_production: 0 };
    for (const c of counts) {
      totals.all += c.n;
      if (c.production_status !== 'completed') totals.in_production += c.n;
      if (totals[c.inventory_status] != null) totals[c.inventory_status] += c.n;
    }
    return okResult({ domes: rows.map(mapDome), totals, diameters: DOME_DIAMETERS_FT, types: DOME_TYPES });
  }

  async function listAvailableDomes(filters = {}) {
    if (!(await isReady())) return notReady();
    const params = [];
    const where = [`d.inventory_status = 'available'`, `d.production_status = 'completed'`];
    const search = String(filters.search || '').trim();
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      where.push(`UPPER(d.dome_number) LIKE $${params.length}`);
    }
    const diameter = parseDiameter(filters.diameter);
    if (diameter) {
      params.push(diameter);
      where.push(`d.diameter_ft = $${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT d.* FROM domes d WHERE ${where.join(' AND ')}
       ORDER BY d.diameter_ft, UPPER(d.dome_number) LIMIT 500`,
      params
    );
    return okResult({ domes: rows.map(mapDome), diameters: DOME_DIAMETERS_FT });
  }

  async function getDomeDetails(domeId) {
    if (!(await isReady())) return notReady();
    const id = Number(domeId);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Invalid dome id.');
    const { rows } = await pool.query(
      `SELECT d.*, t.name AS team_name FROM domes d LEFT JOIN teams t ON t.id = d.team_id WHERE d.id = $1`,
      [id]
    );
    if (!rows.length) return errResult(404, 'not_found', 'Dome not found.');
    const fabs = await loadFabricators([id]);
    const labor = (await loadLaborSummary([id])).get(id);
    const { rows: sessions } = await pool.query(
      `SELECT s.id, s.status, s.started_at, s.ended_at, s.end_reason, t.name AS team_name, m.name AS machine_name,
              COALESCE(json_agg(json_build_object('employee_name', p.employee_name, 'employee_code', p.employee_code,
                       'joined_at', p.joined_at, 'left_at', p.left_at) ORDER BY p.joined_at)
                       FILTER (WHERE p.id IS NOT NULL), '[]') AS participants
       FROM dome_labor_sessions s
       LEFT JOIN teams t ON t.id = s.team_id
       LEFT JOIN machines m ON m.id = s.machine_id
       LEFT JOIN dome_labor_participants p ON p.session_id = s.id
       WHERE s.dome_id = $1
       GROUP BY s.id, t.name, m.name
       ORDER BY s.started_at`,
      [id]
    );
    const { rows: installs } = await pool.query(
      `SELECT i.id, i.tank_id, i.tank_number, i.piece_number, i.status, i.started_at, i.finished_at, i.cancelled_at,
              i.cancel_reason, t.name AS team_name, m.name AS machine_name,
              (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ms.finished_at, ms.stopped_at, NOW()) - ms.started_at)) * 1000), 0)
               FROM dome_installation_sessions dis JOIN machine_sessions ms ON ms.id = dis.machine_session_id
               WHERE dis.installation_id = i.id) AS install_ms
       FROM dome_installations i
       LEFT JOIN teams t ON t.id = i.team_id
       LEFT JOIN machines m ON m.id = i.machine_id
       WHERE i.dome_id = $1 ORDER BY i.started_at`,
      [id]
    );
    const { rows: events } = await pool.query(
      `SELECT event, details, performed_by, performed_at FROM dome_events WHERE dome_id = $1 ORDER BY performed_at, id`,
      [id]
    );
    return okResult({
      dome: {
        ...mapDome(rows[0]),
        fabricators: fabs.get(id) || [],
        production_ms: labor.production_ms,
        production_display: labor.production_display,
        labor_display: labor.labor_display,
        labor_by_employee: labor.employees,
      },
      labor_sessions: sessions.map((s) => ({
        id: Number(s.id),
        status: s.status,
        started_at: s.started_at,
        ended_at: s.ended_at,
        end_reason: s.end_reason,
        team_name: s.team_name,
        machine_name: s.machine_name,
        participants: s.participants,
      })),
      installations: installs.map((i) => ({
        id: Number(i.id),
        tank_id: i.tank_id != null ? Number(i.tank_id) : null,
        tank_number: i.tank_number,
        piece_number: Number(i.piece_number),
        status: i.status,
        started_at: i.started_at,
        finished_at: i.finished_at,
        cancelled_at: i.cancelled_at,
        cancel_reason: i.cancel_reason,
        team_name: i.team_name,
        machine_name: i.machine_name,
        install_display: formatXhYm(Number(i.install_ms) || 0),
      })),
      events,
    });
  }

  async function addManualDome(body, performedBy) {
    if (!(await isReady())) return notReady();
    const number = normalizeDomeNumber(body.dome_number);
    if (!number) return errResult(400, 'dome_number_required', 'Enter a Dome Number.');
    const diameter = parseDiameter(body.diameter_ft != null ? body.diameter_ft : body.diameter);
    if (!diameter) return errResult(400, 'diameter_required', "Select a Diameter (4', 6', 8', 10' or 12').");
    const weight = parseWeight(body.weight_lbs != null ? body.weight_lbs : body.weight);
    if (weight == null || weight === undefined) return errResult(400, 'weight_required', 'Enter the Dome Weight in pounds (greater than 0).');
    const type = parseDomeType(body.dome_type);
    if (type === undefined) return errResult(400, 'validation', 'Dome Type must be Petro or Water.');
    const notes = body.notes != null ? String(body.notes).trim().slice(0, 1000) || null : null;
    return withTransaction(async (client) => {
      const ts = nowIso();
      const { rows } = await client.query(
        `INSERT INTO domes (dome_number, dome_type, diameter_ft, weight_lbs, production_status, inventory_status, source,
                            created_by, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'completed', 'available', 'manual', $5, $6, $7::timestamptz, $7::timestamptz)
         RETURNING *`,
        [number, type, diameter, weight, performedBy || 'manager', notes, ts]
      );
      await logEvent(client, rows[0].id, 'manual_add', { diameter_ft: diameter, weight_lbs: weight, dome_type: type }, performedBy, ts);
      return okResult({ dome: mapDome(rows[0]), message: `Dome ${number} added to inventory.` }, 201);
    });
  }

  async function updateDome(domeId, body, performedBy) {
    if (!(await isReady())) return notReady();
    const id = Number(domeId);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Invalid dome id.');
    return withTransaction(async (client) => {
      const dome = await lockDome(client, id);
      if (!dome) return errResult(404, 'not_found', 'Dome not found.');
      const next = {
        dome_number: dome.dome_number,
        dome_type: dome.dome_type,
        diameter_ft: Number(dome.diameter_ft),
        weight_lbs: dome.weight_lbs != null ? Number(dome.weight_lbs) : null,
        notes: dome.notes,
      };
      if (body.dome_number !== undefined) {
        const n = normalizeDomeNumber(body.dome_number);
        if (!n) return errResult(400, 'dome_number_required', 'Enter a Dome Number.');
        next.dome_number = n;
      }
      if (body.dome_type !== undefined) {
        const t = parseDomeType(body.dome_type);
        if (t === undefined) return errResult(400, 'validation', 'Dome Type must be Petro or Water.');
        if (t === null && dome.source !== 'manual') return errResult(400, 'dome_type_required', 'Dome Type is required for kiosk-built domes.');
        next.dome_type = t;
      }
      if (body.diameter_ft !== undefined || body.diameter !== undefined) {
        const d = parseDiameter(body.diameter_ft !== undefined ? body.diameter_ft : body.diameter);
        if (!d) return errResult(400, 'diameter_required', "Select a Diameter (4', 6', 8', 10' or 12').");
        next.diameter_ft = d;
      }
      if (body.weight_lbs !== undefined || body.weight !== undefined) {
        const w = parseWeight(body.weight_lbs !== undefined ? body.weight_lbs : body.weight);
        if (w === undefined || (w == null && dome.production_status === 'completed')) {
          return errResult(400, 'weight_required', 'Enter the Dome Weight in pounds (greater than 0).');
        }
        next.weight_lbs = w;
      }
      if (body.notes !== undefined) next.notes = body.notes == null ? null : String(body.notes).trim().slice(0, 1000) || null;
      const changes = {};
      for (const k of Object.keys(next)) {
        const before = k === 'diameter_ft' ? Number(dome[k]) : k === 'weight_lbs' && dome[k] != null ? Number(dome[k]) : dome[k];
        if (before !== next[k]) changes[k] = { from: before, to: next[k] };
      }
      if (!Object.keys(changes).length) return okResult({ dome: mapDome(dome), message: 'No changes.' });
      const ts = nowIso();
      const { rows } = await client.query(
        `UPDATE domes SET dome_number = $2, dome_type = $3, diameter_ft = $4, weight_lbs = $5, notes = $6, updated_at = $7::timestamptz
         WHERE id = $1 RETURNING *`,
        [id, next.dome_number, next.dome_type, next.diameter_ft, next.weight_lbs, next.notes, ts]
      );
      await logEvent(client, id, 'edited', changes, performedBy, ts);
      return okResult({ dome: mapDome(rows[0]), message: `Dome ${next.dome_number} updated.` });
    });
  }

  // ---------------------------------------------------------------- Fabrication Dome Install

  function mapInstall(r) {
    return {
      installation_id: Number(r.id),
      dome_id: Number(r.dome_id),
      dome_number: r.dome_number,
      dome_type: r.dome_type || null,
      diameter_ft: r.diameter_ft != null ? Number(r.diameter_ft) : null,
      diameter_label: r.diameter_ft != null ? `${Number(r.diameter_ft)}'` : null,
      weight_lbs: r.weight_lbs != null ? Number(r.weight_lbs) : null,
      tank_id: r.tank_id != null ? Number(r.tank_id) : null,
      tank_number: r.tank_number,
      piece_number: Number(r.piece_number),
      status: r.status,
      machine_id: r.machine_id != null ? Number(r.machine_id) : null,
      current_session_id: r.current_session_id != null ? Number(r.current_session_id) : null,
      session_status: r.session_status || null,
      started_at: r.started_at,
      finished_at: r.finished_at || null,
    };
  }

  const INSTALL_SELECT = `
    SELECT i.*, d.dome_number, d.dome_type, d.diameter_ft, d.weight_lbs, ms.status AS session_status
    FROM dome_installations i
    JOIN domes d ON d.id = i.dome_id
    LEFT JOIN machine_sessions ms ON ms.id = i.current_session_id`;

  async function installForSession(sessionId) {
    if (!(await isReady())) return null;
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) return null;
    const { rows } = await pool.query(`${INSTALL_SELECT} WHERE i.current_session_id = $1 AND i.status = 'in_progress'`, [sid]);
    return rows[0] ? mapInstall(rows[0]) : null;
  }

  async function machineHasOpenInstallSession(machineId) {
    if (!(await isReady())) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM dome_installations i JOIN machine_sessions ms ON ms.id = i.current_session_id
       WHERE i.status = 'in_progress' AND ms.machine_id = $1 AND ms.status IN ('running', 'stopped') LIMIT 1`,
      [machineId]
    );
    return rows.length > 0;
  }

  /** In-progress installs started on this Fabrication machine (open session or ended by End Shift). */
  async function listMachineInstalls(machineId) {
    if (!(await isReady())) return [];
    const { rows } = await pool.query(`${INSTALL_SELECT} WHERE i.status = 'in_progress' AND i.machine_id = $1 ORDER BY i.started_at`, [
      machineId,
    ]);
    return rows.map(mapInstall);
  }

  async function getTankDomeState(tankId) {
    const tid = Number(tankId);
    if (!(await isReady()) || !Number.isInteger(tid) || tid <= 0) {
      return { ready: false, installs: [], installed_count: 0, in_progress_count: 0, overrides: [] };
    }
    const { rows } = await pool.query(
      `${INSTALL_SELECT} WHERE i.tank_id = $1 AND i.status IN ('in_progress', 'installed') ORDER BY i.piece_number, i.started_at`,
      [tid]
    );
    const { rows: ov } = await pool.query(
      `SELECT reason, performed_by, performed_at FROM tank_dome_completion_overrides WHERE tank_id = $1 ORDER BY performed_at`,
      [tid]
    );
    const installs = rows.map(mapInstall);
    return {
      ready: true,
      installs,
      installed_count: installs.filter((i) => i.status === 'installed').length,
      in_progress_count: installs.filter((i) => i.status === 'in_progress').length,
      overrides: ov,
    };
  }

  async function tankDomeSummaries(tankIds) {
    const ids = parseIdList(tankIds);
    const map = new Map();
    if (!ids.length || !(await isReady())) return map;
    const { rows } = await pool.query(
      `SELECT i.tank_id, i.status, i.piece_number, d.dome_number
       FROM dome_installations i JOIN domes d ON d.id = i.dome_id
       WHERE i.tank_id = ANY($1::bigint[]) AND i.status IN ('in_progress', 'installed')
       ORDER BY i.piece_number, i.started_at`,
      [ids]
    );
    const { rows: ov } = await pool.query(
      `SELECT DISTINCT tank_id FROM tank_dome_completion_overrides WHERE tank_id = ANY($1::bigint[])`,
      [ids]
    );
    const overridden = new Set(ov.map((r) => Number(r.tank_id)));
    for (const r of rows) {
      const k = Number(r.tank_id);
      if (!map.has(k)) map.set(k, { installed: [], in_progress: [], override: false });
      map.get(k)[r.status === 'installed' ? 'installed' : 'in_progress'].push({
        dome_number: r.dome_number,
        piece_number: Number(r.piece_number),
      });
    }
    for (const k of overridden) {
      if (!map.has(k)) map.set(k, { installed: [], in_progress: [], override: false });
      map.get(k).override = true;
    }
    return map;
  }

  async function lockDomeTank(client, { tankId, tankNumber }) {
    const { rows } = tankId
      ? await client.query(`SELECT * FROM tanks WHERE id = $1 FOR UPDATE`, [tankId])
      : await client.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 FOR UPDATE`, [
          String(tankNumber || '').trim().toUpperCase(),
        ]);
    return rows[0] || null;
  }

  async function linkSession(client, installationId, sessionId) {
    await client.query(
      `INSERT INTO dome_installation_sessions (installation_id, machine_session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [installationId, sessionId]
    );
  }

  async function insertInstallSession(client, { machineId, teamId, tankId, pieceNumber, pieceId, domeNumber, ts }) {
    const { rows } = await client.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, created_at, updated_at,
          piece_number, piece_id, notes)
       VALUES ($1, $2, $3, $4, $5, 'running', $6::timestamptz, $6::timestamptz, $6::timestamptz, $7, $8, $9)
       RETURNING id`,
      [machineId, teamId, tankId, DOME_INSTALL_PHASE.code, DOME_INSTALL_PHASE.label, ts, pieceNumber, pieceId, `Dome ${domeNumber}`]
    );
    return Number(rows[0].id);
  }

  /** In-progress or installed Dome Install on a tank (Dome Install is one per tank). */
  async function tankLiveInstall(db, tankId) {
    const { rows } = await db.query(
      `SELECT i.id, i.status, d.dome_number FROM dome_installations i JOIN domes d ON d.id = i.dome_id
       WHERE i.tank_id = $1 AND i.status IN ('in_progress', 'installed')
       ORDER BY CASE WHEN i.status = 'in_progress' THEN 0 ELSE 1 END, i.started_at DESC LIMIT 1`,
      [tankId]
    );
    return rows[0] || null;
  }

  function liveInstallError(tank, live) {
    return live.status === 'in_progress'
      ? errResult(409, 'dome_install_in_progress', `Tank ${tank.tank_number} has a Dome Install in progress (Dome ${live.dome_number}). Tap Finish Install or Cancel Install.`, {
          tank_number: tank.tank_number,
          dome_number: live.dome_number,
        })
      : errResult(409, 'dome_already_installed', `Dome ${live.dome_number} is already installed on Tank ${tank.tank_number}.`, {
          tank_number: tank.tank_number,
          dome_number: live.dome_number,
        });
  }

  /**
   * Fabrication guard before the dome picker: tank-level, so no piece is needed. Returns an error
   * result when the tank already has a live install or open work, else null.
   */
  async function tankInstallBlock(tankRow) {
    if (!(await isReady())) return notReady();
    const live = await tankLiveInstall(pool, tankRow.id);
    if (live) return liveInstallError(tankRow, live);
    const busy = await tankOpenWork(pool, tankRow.id);
    if (busy) return tankInUseError(tankRow, busy);
    return null;
  }

  async function tankOpenWork(db, tankId) {
    const { rows } = await db.query(
      `SELECT ms.id, m.name AS machine_name, t.name AS team_name
       FROM machine_sessions ms LEFT JOIN machines m ON m.id = ms.machine_id LEFT JOIN teams t ON t.id = ms.team_id
       WHERE ms.tank_id = $1 AND ms.status IN ('running', 'stopped')
       LIMIT 1`,
      [tankId]
    );
    return rows[0] || null;
  }

  function tankInUseError(tank, busy) {
    return errResult(
      409,
      'tank_in_use',
      `Tank ${tank.tank_number} is already being worked on by ${busy.team_name || 'another team'} / ${busy.machine_name || 'another machine'}.`,
      { tank_number: tank.tank_number }
    );
  }

  /** Dome Install is a tank-level operation; the session/install row is recorded on piece 1. */
  async function startInstall(machine, assignment, body) {
    if (!(await isReady())) return notReady();
    if (!assignment) return errResult(409, 'need_team', 'Scan your Team barcode first.');
    const domeId = Number(body.dome_id);
    if (!Number.isInteger(domeId) || domeId <= 0) return errResult(400, 'dome_required', 'Select a dome.');
    const pieceNumber = 1;
    const tankId = body.tank_id != null ? Number(body.tank_id) : null;
    const result = await withTransaction(async (client) => {
      const tank = await lockDomeTank(client, { tankId, tankNumber: body.tank_number });
      if (!tank || tank.deleted_at) return errResult(404, 'tank_not_found', 'Tank not found.');
      if (!isDomeTankStatus(tank.status)) {
        return errResult(409, 'not_ready_for_dome_install', `Tank ${tank.tank_number} is not Ready for Dome Install.`);
      }
      const live = await tankLiveInstall(client, tank.id);
      if (live) return liveInstallError(tank, live);
      const busy = await tankOpenWork(client, tank.id);
      if (busy) return tankInUseError(tank, busy);
      const { rows: pieceRows } = await client.query(
        `SELECT id FROM tank_pieces WHERE tank_id = $1 AND piece_number = $2`,
        [tank.id, pieceNumber]
      );
      const pieceId = pieceRows[0] ? Number(pieceRows[0].id) : null;
      const dome = await lockDome(client, domeId);
      if (!dome) return errResult(404, 'not_found', 'Dome not found.');
      if (dome.production_status !== 'completed' || dome.inventory_status !== 'available') {
        return errResult(409, 'dome_unavailable', `Dome ${dome.dome_number} is no longer available. Select a different dome.`);
      }
      const ts = nowIso();
      const sessionId = await insertInstallSession(client, {
        machineId: machine.id,
        teamId: assignment.team_id,
        tankId: tank.id,
        pieceNumber,
        pieceId,
        domeNumber: dome.dome_number,
        ts,
      });
      const { rows: ins } = await client.query(
        `INSERT INTO dome_installations
           (dome_id, tank_id, tank_number, piece_number, piece_id, machine_id, team_id, status, current_session_id,
            started_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', $8, $9::timestamptz, $9::timestamptz, $9::timestamptz)
         RETURNING id`,
        [dome.id, tank.id, tank.tank_number, pieceNumber, pieceId, machine.id, assignment.team_id, sessionId, ts]
      );
      const installationId = Number(ins[0].id);
      await linkSession(client, installationId, sessionId);
      await client.query(`UPDATE domes SET inventory_status = 'reserved', updated_at = $2::timestamptz WHERE id = $1`, [dome.id, ts]);
      await logEvent(
        client,
        dome.id,
        'install_started',
        { tank_id: Number(tank.id), tank_number: tank.tank_number, piece_number: pieceNumber, machine_id: Number(machine.id) },
        `kiosk:${machine.name}`,
        ts
      );
      return okResult({
        action: 'dome_install_started',
        installation_id: installationId,
        session_id: sessionId,
        tank_id: Number(tank.id),
        tank_number: tank.tank_number,
        piece_number: pieceNumber,
        dome: mapDome(dome),
        message: `Dome Install started — Dome ${dome.dome_number} on Tank ${tank.tank_number}.`,
      });
    });
    if (result.ok) {
      await phase1.snapshotSessionTeamMembers(result.body.session_id, assignment.team_id);
      await phase1.setMachineActiveTank(machine.id, result.body.tank_id);
    }
    return result;
  }

  async function closeInstallSession(client, sessionId, ts) {
    if (!sessionId) return;
    const { rows } = await client.query(`SELECT id, status, stopped_at FROM machine_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
    const s = rows[0];
    if (!s || (s.status !== 'running' && s.status !== 'stopped')) return;
    const { rows: dt } = await client.query(
      `SELECT id, started_at FROM downtime_intervals WHERE session_id = $1 AND ended_at IS NULL`,
      [sessionId]
    );
    for (const d of dt) {
      const ms = Math.max(0, new Date(ts).getTime() - new Date(d.started_at).getTime());
      await client.query(`UPDATE downtime_intervals SET ended_at = $1::timestamptz, duration_ms = $2 WHERE id = $3`, [ts, ms, d.id]);
    }
    if (s.status === 'stopped' && s.stopped_at) {
      await client.query(
        `UPDATE machine_sessions SET status = 'finished', finished_at = stopped_at, updated_at = $1::timestamptz WHERE id = $2`,
        [ts, sessionId]
      );
    } else {
      await client.query(
        `UPDATE machine_sessions SET status = 'finished', finished_at = $1::timestamptz, updated_at = $1::timestamptz WHERE id = $2`,
        [ts, sessionId]
      );
    }
  }

  async function lockInstallForMachine(client, machine, installationId) {
    const { rows } = await client.query(
      `SELECT i.*, ms.status AS session_status, ms.machine_id AS session_machine_id
       FROM dome_installations i LEFT JOIN machine_sessions ms ON ms.id = i.current_session_id
       WHERE i.id = $1 FOR UPDATE OF i`,
      [installationId]
    );
    const inst = rows[0];
    if (!inst) return { error: errResult(404, 'not_found', 'Dome Install not found.') };
    if (inst.status !== 'in_progress') {
      return { error: errResult(409, 'install_not_in_progress', 'This Dome Install is already finished or cancelled.') };
    }
    const sessionOpen = inst.session_status === 'running' || inst.session_status === 'stopped';
    if (sessionOpen && Number(inst.session_machine_id) !== Number(machine.id)) {
      return { error: errResult(409, 'install_on_other_machine', 'This Dome Install is running on another Fabrication kiosk.') };
    }
    return { inst };
  }

  async function finishInstall(machine, body) {
    if (!(await isReady())) return notReady();
    const installationId = Number(body.installation_id);
    if (!Number.isInteger(installationId) || installationId <= 0) return errResult(400, 'validation', 'Select a Dome Install.');
    return withTransaction(async (client) => {
      const { inst, error } = await lockInstallForMachine(client, machine, installationId);
      if (error) return error;
      const dome = await lockDome(client, inst.dome_id);
      const ts = nowIso();
      await closeInstallSession(client, inst.current_session_id, ts);
      await client.query(
        `UPDATE dome_installations SET status = 'installed', finished_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1`,
        [inst.id, ts]
      );
      await client.query(
        `UPDATE domes SET inventory_status = 'installed', installed_at = $2::timestamptz, installed_tank_id = $3,
                installed_tank_number = $4, installed_piece_number = $5, updated_at = $2::timestamptz
         WHERE id = $1`,
        [dome.id, ts, inst.tank_id, inst.tank_number, inst.piece_number]
      );
      // Only advances the tank to "Dome Installed"; never archives / completes it.
      const { rows: tankRows } = await client.query(
        `UPDATE tanks SET status = 'dome_installed', updated_at = $2::timestamptz
         WHERE id = $1 AND deleted_at IS NULL AND LOWER(TRIM(COALESCE(status, ''))) = ANY($3::text[])
         RETURNING status`,
        [inst.tank_id, ts, DOME_TANK_STATUSES]
      );
      await logEvent(
        client,
        dome.id,
        'installed',
        { tank_id: inst.tank_id != null ? Number(inst.tank_id) : null, tank_number: inst.tank_number, piece_number: Number(inst.piece_number) },
        `kiosk:${machine.name}`,
        ts
      );
      return okResult({
        action: 'dome_install_finished',
        installation_id: Number(inst.id),
        tank_number: inst.tank_number,
        piece_number: Number(inst.piece_number),
        dome_number: dome.dome_number,
        tank_status: tankRows.length ? 'dome_installed' : null,
        message: `Dome ${dome.dome_number} installed on Tank ${inst.tank_number}. Tank status: Dome Installed.`,
      });
    });
  }

  async function cancelInstall(machine, body) {
    if (!(await isReady())) return notReady();
    const installationId = Number(body.installation_id);
    if (!Number.isInteger(installationId) || installationId <= 0) return errResult(400, 'validation', 'Select a Dome Install.');
    const reason = body.reason != null ? String(body.reason).trim().slice(0, 300) || null : null;
    return withTransaction(async (client) => {
      const { inst, error } = await lockInstallForMachine(client, machine, installationId);
      if (error) return error;
      const dome = await lockDome(client, inst.dome_id);
      const ts = nowIso();
      await closeInstallSession(client, inst.current_session_id, ts);
      await client.query(
        `UPDATE dome_installations SET status = 'cancelled', cancelled_at = $2::timestamptz, cancel_reason = $3,
                updated_at = $2::timestamptz WHERE id = $1`,
        [inst.id, ts, reason]
      );
      await client.query(
        `UPDATE domes SET inventory_status = 'available', updated_at = $2::timestamptz WHERE id = $1 AND inventory_status = 'reserved'`,
        [dome.id, ts]
      );
      await logEvent(client, dome.id, 'install_cancelled', { tank_number: inst.tank_number, piece_number: Number(inst.piece_number), reason }, `kiosk:${machine.name}`, ts);
      return okResult({
        action: 'dome_install_cancelled',
        installation_id: Number(inst.id),
        message: `Dome Install cancelled. Dome ${dome.dome_number} is back in available inventory.`,
      });
    });
  }

  /** Fabrication Resume after End Shift: reopen Dome Install sessions on this machine. */
  async function resumeEndShiftInstalls(machine, assignment) {
    if (!(await isReady()) || !assignment) return { resumed: [], session_ids: [] };
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT i.*, d.dome_number, ms.status AS session_status, t.status AS tank_status, t.deleted_at
         FROM dome_installations i
         JOIN domes d ON d.id = i.dome_id
         LEFT JOIN machine_sessions ms ON ms.id = i.current_session_id
         LEFT JOIN tanks t ON t.id = i.tank_id
         WHERE i.status = 'in_progress' AND i.machine_id = $1
         ORDER BY i.started_at
         FOR UPDATE OF i`,
        [machine.id]
      );
      const ts = nowIso();
      const resumed = [];
      const sessionIds = [];
      for (const inst of rows) {
        if (inst.session_status === 'running' || inst.session_status === 'stopped') continue;
        if (!inst.tank_id || inst.deleted_at || !isDomeTankStatus(inst.tank_status)) continue;
        const { rows: openRows } = await client.query(
          `SELECT 1 FROM machine_sessions WHERE tank_id = $1 AND COALESCE(piece_number, 1) = $2 AND status IN ('running', 'stopped') LIMIT 1`,
          [inst.tank_id, inst.piece_number]
        );
        if (openRows.length) continue;
        const sessionId = await insertInstallSession(client, {
          machineId: machine.id,
          teamId: assignment.team_id,
          tankId: inst.tank_id,
          pieceNumber: inst.piece_number,
          pieceId: inst.piece_id,
          domeNumber: inst.dome_number,
          ts,
        });
        await client.query(
          `UPDATE dome_installations SET current_session_id = $2, team_id = $3, updated_at = $4::timestamptz WHERE id = $1`,
          [inst.id, sessionId, assignment.team_id, ts]
        );
        await linkSession(client, inst.id, sessionId);
        resumed.push(String(inst.tank_number));
        sessionIds.push(sessionId);
      }
      return okResult({ resumed, session_ids: sessionIds });
    });
    const body = result.ok ? result.body : { resumed: [], session_ids: [] };
    for (const sid of body.session_ids) {
      await phase1.snapshotSessionTeamMembers(sid, assignment.team_id);
    }
    return { resumed: body.resumed, session_ids: body.session_ids };
  }

  /** Machine-area removal guard: open dome work blocks; any dome history keeps the machine (deactivate). */
  async function machineDomeUsage(machineId) {
    if (!(await isReady())) return { has_open_production: false, has_history: false };
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM domes WHERE machine_id = $1 AND production_status IN ('in_progress', 'paused')) AS open_domes,
         (SELECT COUNT(*)::int FROM domes WHERE machine_id = $1) AS domes,
         (SELECT COUNT(*)::int FROM dome_labor_sessions WHERE machine_id = $1) AS labor,
         (SELECT COUNT(*)::int FROM dome_installations WHERE machine_id = $1) AS installs,
         (SELECT COUNT(*)::int FROM dome_installations WHERE machine_id = $1 AND status = 'in_progress') AS open_installs`,
      [machineId]
    );
    const r = rows[0] || {};
    return {
      has_open_production: r.open_domes > 0 || r.open_installs > 0,
      has_history: r.domes > 0 || r.labor > 0 || r.installs > 0,
    };
  }

  // ---------------------------------------------------------------- Complete Tank gate

  /**
   * Runs inside finalizeTankCompletion's transaction. Blocks when a Dome Install is still in
   * progress, or when no dome is installed and no override reason was given.
   */
  function makeCompletionGate(overrideReason, performedBy) {
    const reason = overrideReason != null ? String(overrideReason).trim().slice(0, 500) : '';
    return async (client, tank) => {
      if (!(await isReady())) return null;
      await client.query(`SELECT id FROM tanks WHERE id = $1 FOR UPDATE`, [tank.id]);
      const { rows } = await client.query(
        `SELECT status, COUNT(*)::int AS n FROM dome_installations
         WHERE tank_id = $1 AND status IN ('in_progress', 'installed') GROUP BY status`,
        [tank.id]
      );
      const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      if (counts.in_progress) {
        return errResult(
          409,
          'dome_install_in_progress',
          `Tank ${tank.tank_number} has a Dome Install in progress. Finish or cancel it at the Fabrication kiosk first.`
        );
      }
      if (counts.installed) return null;
      if (reason.length < 3) {
        return errResult(
          409,
          'dome_required',
          `No dome is recorded as installed on Tank ${tank.tank_number}. Install a dome at the Fabrication kiosk, or complete with a manager override reason.`,
          { override_allowed: true }
        );
      }
      await client.query(
        `INSERT INTO tank_dome_completion_overrides (tank_id, tank_number, reason, performed_by, performed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [tank.id, tank.tank_number, reason, performedBy || 'manager']
      );
      return null;
    };
  }

  return {
    isReady,
    isDomeTankStatus,
    getKioskConfig,
    assignTeam,
    createDome,
    startDome,
    stopDome,
    handleEmployeeTeamMove,
    lunch,
    resume,
    endShift,
    completeDome,
    setFabricators,
    employeeOut,
    listDomes,
    listAvailableDomes,
    getDomeDetails,
    addManualDome,
    updateDome,
    installForSession,
    machineHasOpenInstallSession,
    listMachineInstalls,
    getTankDomeState,
    tankDomeSummaries,
    tankInstallBlock,
    tankLiveInstallStatus: async (tankId) => ((await isReady()) ? tankLiveInstall(pool, tankId) : null),
    startInstall,
    finishInstall,
    cancelInstall,
    resumeEndShiftInstalls,
    machineDomeUsage,
    makeCompletionGate,
    collectDomeLaborIntervals,
  };

  async function collectDomeLaborIntervals(employeeId, bounds, closeMs = Date.now()) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0 || !bounds || !(await isReady())) return [];
    const ws = new Date(bounds.startIso).getTime();
    const we = new Date(bounds.endIso).getTime();
    if (Number.isNaN(ws) || Number.isNaN(we)) return [];
    const { rows } = await pool.query(
      `SELECT p.joined_at, p.left_at, s.status, s.ended_at
       FROM dome_labor_participants p JOIN dome_labor_sessions s ON s.id = p.session_id
       WHERE p.employee_id = $1 AND p.joined_at < $3::timestamptz AND (p.left_at IS NULL OR p.left_at > $2::timestamptz)`,
      [id, bounds.startIso, bounds.endIso]
    );
    const out = [];
    for (const r of rows) {
      const join = toMs(r.joined_at);
      if (join == null) continue;
      let leave = toMs(r.left_at);
      if (leave == null) leave = r.status === 'active' ? closeMs : toMs(r.ended_at) || closeMs;
      const start = Math.max(join, ws);
      const end = Math.min(leave, we, closeMs);
      if (end > start) out.push({ start, end, source: 'dome' });
    }
    return out;
  }
}

module.exports = {
  createPhase3Dome,
  isDomeTankStatus,
  DOME_INSTALL_PHASE,
  parseDiameter,
  parseDomeType,
  parseWeight,
  normalizeDomeNumber,
};
