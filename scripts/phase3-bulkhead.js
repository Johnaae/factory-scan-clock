'use strict';

/**
 * Phase 3 — Bulkhead production (Dome Shop) + Bulkhead Inventory (Manager).
 * Tables: scripts/phase3-schema-sql.js (PHASE3_BULKHEAD_SQL).
 * Mirrors Dome Shop employee-based create / start / stop / finish + lunch board actions.
 * Labor rows are never hard-deleted when a bulkhead is removed from inventory.
 */

const { PHASE3_BULKHEAD_RELATIONS, DOME_DIAMETERS_FT, DOME_TYPES } = require('./phase3-schema-sql');

const READY_RECHECK_MS = 60000;
const MAX_WORKERS = 3;
const BULKHEAD_TYPES = DOME_TYPES;
const BULKHEAD_DIAMETERS_FT = DOME_DIAMETERS_FT;

function errResult(status, error, message, extra = {}) {
  return { ok: false, status, body: { ok: false, error, message, ...extra } };
}

function okResult(body, status = 200) {
  return { ok: true, status, body: { ok: true, ...body } };
}

function formatXhYm(ms) {
  const totalMin = Math.round(Math.max(0, Number(ms) || 0) / 60000);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function normalizeNumber(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
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

function parseNotes(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().slice(0, 1000);
  return s || null;
}

function parseBulkheadType(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  return BULKHEAD_TYPES.find((t) => t.toLowerCase() === s) || undefined;
}

function parseDiameter(raw) {
  const m = String(raw == null ? '' : raw).match(/^\s*(\d{1,2})\s*(?:'|ft|feet|’)?\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return BULKHEAD_DIAMETERS_FT.includes(n) ? n : null;
}

function parseWeight(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return undefined;
  return Math.round(n * 100) / 100;
}

function mapBulkhead(row) {
  if (!row) return null;
  const diameter = row.diameter_ft != null ? Number(row.diameter_ft) : null;
  return {
    id: Number(row.id),
    bulkhead_number: row.bulkhead_number,
    bulkhead_type: row.bulkhead_type || null,
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
    deleted_at: row.deleted_at || null,
    deleted_by: row.deleted_by || null,
    deleted_reason: row.deleted_reason || null,
    updated_at: row.updated_at || null,
  };
}

function createPhase3Bulkhead(pool, helpers = {}) {
  const nowIso = helpers.nowIso || (() => new Date().toISOString());
  const isEmployeeShopsReady = helpers.isEmployeeShopsReady || (async () => false);
  const claimEmployeesForDomeWork = helpers.claimEmployeesForDomeWork || null;
  const withTransaction =
    helpers.withTransaction ||
    (async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        if (result && result.ok === false) await client.query('ROLLBACK');
        else await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });

  let readyCache = { value: false, checkedAt: 0 };

  async function isReady() {
    if (readyCache.value) return true;
    if (Date.now() - readyCache.checkedAt < READY_RECHECK_MS && readyCache.checkedAt) return false;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [PHASE3_BULKHEAD_RELATIONS]
      );
      readyCache = { value: rows[0].n === PHASE3_BULKHEAD_RELATIONS.length, checkedAt: Date.now() };
    } catch (_err) {
      readyCache = { value: false, checkedAt: Date.now() };
    }
    return readyCache.value;
  }

  function notReady() {
    return errResult(
      503,
      'bulkhead_not_ready',
      'Bulkhead features are not available yet — the database update has not finished. Try again in a minute.'
    );
  }

  async function logEvent(client, bulkheadId, event, details, performedBy, ts) {
    await client.query(
      `INSERT INTO bulkhead_events (bulkhead_id, event, details, performed_by, performed_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)`,
      [bulkheadId, event, details ? JSON.stringify(details) : null, performedBy || null, ts || nowIso()]
    );
  }

  async function lockBulkhead(client, id) {
    const { rows } = await client.query(
      `SELECT * FROM bulkheads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    return rows[0] || null;
  }

  async function domeShopEmployeeIds(client = pool) {
    if (!(await isEmployeeShopsReady())) return null;
    const { rows } = await client.query(
      `SELECT es.employee_id FROM employee_shops es JOIN employees e ON e.id = es.employee_id
       WHERE es.shop = 'Dome' AND e.is_active = 1`
    );
    return new Set(rows.map((r) => Number(r.employee_id)));
  }

  async function validateWorkers(ids, client) {
    if (!ids.length) {
      return { error: errResult(400, 'workers_required', 'Select 1 to 3 Dome Shop employees.') };
    }
    if (ids.length > MAX_WORKERS) {
      return {
        error: errResult(400, 'too_many_workers', `Select at most ${MAX_WORKERS} employees per bulkhead.`, {
          max: MAX_WORKERS,
        }),
      };
    }
    const { rows } = await client.query(
      `SELECT id, code, name, hourly_rate, is_active FROM employees WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    if (rows.length !== ids.length) {
      return { error: errResult(400, 'invalid_worker', 'One or more selected employees are not active.') };
    }
    for (const e of rows) {
      if (!e.is_active) {
        return { error: errResult(400, 'inactive_employee', `${e.name || e.code} is inactive.`) };
      }
    }
    const shopSet = await domeShopEmployeeIds(client);
    if (!shopSet) {
      return {
        error: errResult(
          503,
          'shop_assignment_not_ready',
          'Shop Assignment is not ready yet. Try again in a minute.'
        ),
      };
    }
    const notDome = ids.filter((id) => !shopSet.has(Number(id)));
    if (notDome.length) {
      return {
        error: errResult(
          400,
          'not_dome_shop',
          'Select employees assigned to the Dome shop only. Update Shop Assignment in Manager Dashboard if needed.'
        ),
      };
    }
    // Preserve selection order from ids.
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return { employees: ids.map((id) => byId.get(id)).filter(Boolean) };
  }

  async function busyElsewhere(employeeIds, excludeBulkheadId, client) {
    if (!employeeIds.length) return [];
    const { rows: onBh } = await client.query(
      `SELECT p.employee_id, p.employee_name, b.id AS bulkhead_id, b.bulkhead_number
       FROM bulkhead_labor_participants p
       JOIN bulkhead_labor_sessions s ON s.id = p.session_id
       JOIN bulkheads b ON b.id = s.bulkhead_id
       WHERE p.left_at IS NULL AND p.employee_id = ANY($1::bigint[]) AND s.bulkhead_id <> $2
         AND b.deleted_at IS NULL`,
      [employeeIds, excludeBulkheadId || 0]
    );
    const { rows: onDome } = await client.query(
      `SELECT p.employee_id, p.employee_name, d.id AS dome_id, d.dome_number
       FROM dome_labor_participants p
       JOIN dome_labor_sessions s ON s.id = p.session_id
       JOIN domes d ON d.id = s.dome_id
       WHERE p.left_at IS NULL AND p.employee_id = ANY($1::bigint[])
         AND d.deleted_at IS NULL`,
      [employeeIds]
    ).catch(() => ({ rows: [] }));
    return [
      ...onBh.map((r) => ({
        employee_id: Number(r.employee_id),
        employee_name: r.employee_name,
        bulkhead_number: r.bulkhead_number,
      })),
      ...onDome.map((r) => ({
        employee_id: Number(r.employee_id),
        employee_name: r.employee_name,
        dome_number: r.dome_number,
      })),
    ];
  }

  function busyResult(busy) {
    const parts = busy.map((b) => {
      const who = b.employee_name || `Employee ${b.employee_id}`;
      if (b.bulkhead_number) return `${who} is already on Bulkhead ${b.bulkhead_number}`;
      if (b.dome_number) return `${who} is already on Dome ${b.dome_number}`;
      return who;
    });
    return errResult(409, 'worker_busy', `${parts.join('. ')}.`, { busy });
  }

  async function closeLabor(client, bulkheadId, ts, statusTarget, reason) {
    const { rows } = await client.query(
      `UPDATE bulkhead_labor_sessions
       SET status = $3, ended_at = $2::timestamptz, end_reason = $4, updated_at = $2::timestamptz
       WHERE bulkhead_id = $1 AND status = 'active'
       RETURNING id`,
      [bulkheadId, ts, statusTarget, reason]
    );
    for (const r of rows) {
      await client.query(
        `UPDATE bulkhead_labor_participants SET left_at = $2::timestamptz WHERE session_id = $1 AND left_at IS NULL`,
        [Number(r.id), ts]
      );
    }
    return rows.length;
  }

  async function openLabor(client, bh, machineId, employees, ts) {
    const { rows } = await client.query(
      `INSERT INTO bulkhead_labor_sessions (bulkhead_id, machine_id, team_id, status, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4::timestamptz, $4::timestamptz, $4::timestamptz)
       RETURNING id`,
      [bh.id, machineId, bh.team_id || null, ts]
    );
    const sessionId = Number(rows[0].id);
    for (const e of employees) {
      await client.query(
        `INSERT INTO bulkhead_labor_participants
           (session_id, employee_id, employee_code, employee_name, hourly_rate, joined_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)`,
        [sessionId, Number(e.id), e.code || null, e.name || null, e.hourly_rate != null ? Number(e.hourly_rate) : null, ts]
      );
    }
    return sessionId;
  }

  async function workerEmployees(client, bulkheadId) {
    const { rows } = await client.query(
      `SELECT e.id, e.code, e.name, e.hourly_rate, e.is_active
       FROM bulkhead_workers w JOIN employees e ON e.id = w.employee_id
       WHERE w.bulkhead_id = $1 AND e.is_active = 1
       ORDER BY w.added_at ASC, e.id ASC`,
      [bulkheadId]
    );
    return rows;
  }

  async function startLaborForLocked(client, bh, machine, employees, ts, event, opts = {}) {
    if (!employees.length) {
      return errResult(
        409,
        'no_workers',
        `Select 1 to 3 employees on Bulkhead ${bh.bulkhead_number} before Start.`,
        { bulkhead_number: bh.bulkhead_number }
      );
    }
    let transferredFrom = [];
    if (typeof claimEmployeesForDomeWork === 'function') {
      const claimed = await claimEmployeesForDomeWork(client, employees, {
        ts,
        reason: opts.reason || 'bulkhead_start',
        keepBulkheadId: Number(bh.id),
        confirmTransfer: Boolean(opts.confirmTransfer),
        targetLabel: `Bulkhead ${bh.bulkhead_number}`,
        targetMachineId: Number(machine.id),
      });
      if (!claimed.ok) return claimed;
      transferredFrom = claimed.transferred_from || [];
    } else {
      const busy = await busyElsewhere(
        employees.map((e) => Number(e.id)),
        Number(bh.id),
        client
      );
      if (busy.length) return busyResult(busy);
    }
    await openLabor(client, bh, machine.id, employees, ts);
    for (const e of employees) {
      await client.query(
        `INSERT INTO bulkhead_workers (bulkhead_id, employee_id, added_at) VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (bulkhead_id, employee_id) DO NOTHING`,
        [bh.id, Number(e.id), ts]
      );
    }
    await client.query(
      `UPDATE bulkheads SET production_status = 'in_progress', pause_reason = NULL,
              started_at = COALESCE(started_at, $2::timestamptz), updated_at = $2::timestamptz
       WHERE id = $1`,
      [bh.id, ts]
    );
    await logEvent(
      client,
      bh.id,
      event,
      { machine_id: Number(machine.id), employees: employees.map((e) => Number(e.id)) },
      'kiosk',
      ts
    );
    return { ok: true, transferred_from: transferredFrom };
  }

  async function loadWorkers(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const { rows } = await pool.query(
      `SELECT w.bulkhead_id, e.id, e.code, e.name
       FROM bulkhead_workers w JOIN employees e ON e.id = w.employee_id
       WHERE w.bulkhead_id = ANY($1::bigint[])
       ORDER BY w.added_at ASC, e.id ASC`,
      [ids]
    );
    for (const r of rows) {
      const id = Number(r.bulkhead_id);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({ id: Number(r.id), code: r.code, name: r.name, employee_name: r.name });
    }
    return map;
  }

  async function loadLaborSummary(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const { rows } = await pool.query(
      `SELECT s.bulkhead_id, s.status, s.started_at, s.ended_at,
              p.employee_id, p.employee_name, p.joined_at, p.left_at
       FROM bulkhead_labor_sessions s
       LEFT JOIN bulkhead_labor_participants p ON p.session_id = s.id
       WHERE s.bulkhead_id = ANY($1::bigint[])`,
      [ids]
    );
    const now = Date.now();
    for (const r of rows) {
      const id = Number(r.bulkhead_id);
      if (!out.has(id)) {
        out.set(id, { production_ms: 0, labor_ms: 0, active_since: null, by_employee: new Map() });
      }
      const entry = out.get(id);
      if (r.started_at) {
        const end = r.ended_at ? new Date(r.ended_at).getTime() : now;
        const start = new Date(r.started_at).getTime();
        if (!Number.isNaN(start) && end > start) {
          entry.production_ms += end - start;
          if (r.status === 'active' && !entry.active_since) entry.active_since = r.started_at;
        }
      }
      if (r.employee_id && r.joined_at) {
        const left = r.left_at ? new Date(r.left_at).getTime() : now;
        const joined = new Date(r.joined_at).getTime();
        if (!Number.isNaN(joined) && left > joined) {
          const eid = Number(r.employee_id);
          const prev = entry.by_employee.get(eid) || { employee_id: eid, employee_name: r.employee_name, labor_ms: 0 };
          prev.labor_ms += left - joined;
          entry.by_employee.set(eid, prev);
          entry.labor_ms += left - joined;
        }
      }
    }
    return out;
  }

  function decorate(row, workers, labor) {
    const id = Number(row.id);
    const lab = labor.get(id);
    const productionMs = lab ? lab.production_ms : 0;
    const laborMs = lab ? lab.labor_ms : 0;
    return {
      ...mapBulkhead(row),
      workers: workers.get(id) || [],
      production_ms: productionMs,
      production_display: formatXhYm(productionMs),
      labor_ms: laborMs,
      labor_display: formatXhYm(laborMs),
      labor_by_employee: lab
        ? [...lab.by_employee.values()].map((e) => ({
            ...e,
            labor_display: formatXhYm(e.labor_ms),
          }))
        : [],
      active_since: lab ? lab.active_since : null,
    };
  }

  // ---------------------------------------------------------------- Kiosk

  async function listMachineBulkheads(machine) {
    if (!(await isReady())) return [];
    const mid = Number(machine.id);
    const { rows } = await pool.query(
      `SELECT * FROM bulkheads
       WHERE machine_id = $1 AND production_status <> 'completed' AND deleted_at IS NULL
       ORDER BY created_at ASC, id ASC`,
      [mid]
    );
    const ids = rows.map((r) => Number(r.id));
    const workers = await loadWorkers(ids);
    const labor = await loadLaborSummary(ids);
    const working = new Map();
    if (ids.length) {
      const { rows: wr } = await pool.query(
        `SELECT s.bulkhead_id, p.employee_id, p.employee_name
         FROM bulkhead_labor_sessions s JOIN bulkhead_labor_participants p ON p.session_id = s.id
         WHERE s.bulkhead_id = ANY($1::bigint[]) AND s.status = 'active' AND p.left_at IS NULL`,
        [ids]
      );
      for (const r of wr) {
        const id = Number(r.bulkhead_id);
        if (!working.has(id)) working.set(id, []);
        working.get(id).push({ id: Number(r.employee_id), name: r.employee_name });
      }
    }
    return rows.map((r) => {
      const d = decorate(r, workers, labor);
      d.working = working.get(Number(r.id)) || [];
      return d;
    });
  }

  async function createBulkhead(machine, body) {
    if (!(await isReady())) return notReady();
    const number = normalizeNumber(body.bulkhead_number);
    if (!number) return errResult(400, 'bulkhead_number_required', 'Enter a Bulkhead Number.');
    const type = parseBulkheadType(body.bulkhead_type != null ? body.bulkhead_type : body.dome_type);
    if (!type) return errResult(400, 'bulkhead_type_required', 'Select a Bulkhead Type (Petro or Water).');
    const diameter = parseDiameter(body.diameter_ft != null ? body.diameter_ft : body.diameter);
    if (!diameter) return errResult(400, 'diameter_required', "Select a Diameter (4', 6', 8', 10' or 12').");
    const notes = parseNotes(body.notes);
    const ids = parseIdList(body.worker_ids != null ? body.worker_ids : body.fabricator_ids);
    return withTransaction(async (client) => {
      if (!ids.length) {
        return errResult(400, 'workers_required', 'Select 1 to 3 Dome Shop employees.');
      }
      const v = await validateWorkers(ids, client);
      if (v.error) return v.error;
      const ts = nowIso();
      let rows;
      try {
        ({ rows } = await client.query(
          `INSERT INTO bulkheads (bulkhead_number, bulkhead_type, diameter_ft, production_status, inventory_status, source,
                                  machine_id, created_by, notes, created_at, updated_at)
           VALUES ($1, $2, $3, 'created', 'not_in_inventory', 'kiosk', $4, $5, $6, $7::timestamptz, $7::timestamptz)
           RETURNING *`,
          [number, type, diameter, machine.id, `kiosk:${machine.name}`, notes, ts]
        ));
      } catch (err) {
        if (err && err.code === '23505') {
          return errResult(409, 'duplicate_bulkhead_number', 'That Bulkhead Number already exists. Enter a different number.');
        }
        throw err;
      }
      const bh = rows[0];
      for (const id of ids) {
        await client.query(
          `INSERT INTO bulkhead_workers (bulkhead_id, employee_id, added_at) VALUES ($1, $2, $3::timestamptz)`,
          [bh.id, id, ts]
        );
      }
      await logEvent(
        client,
        bh.id,
        'created',
        { bulkhead_type: type, diameter_ft: diameter, workers: ids, notes },
        `kiosk:${machine.name}`,
        ts
      );
      const names = v.employees.map((e) => e.name).filter(Boolean).join(', ');
      return okResult({
        action: 'bulkhead_created',
        bulkhead: mapBulkhead(bh),
        worker_ids: ids,
        message: names
          ? `Bulkhead ${number} created for ${names}. Press Start when work begins.`
          : `Bulkhead ${number} created. Press Start when work begins.`,
      });
    });
  }

  async function startBulkhead(machine, body) {
    if (!(await isReady())) return notReady();
    const id = Number(body.bulkhead_id);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Select a bulkhead.');
    return withTransaction(async (client) => {
      const bh = await lockBulkhead(client, id);
      if (!bh || Number(bh.machine_id) !== Number(machine.id)) {
        return errResult(404, 'not_found', 'Bulkhead not found on this kiosk.');
      }
      if (bh.production_status === 'completed') {
        return errResult(409, 'bulkhead_completed', `Bulkhead ${bh.bulkhead_number} is already finished.`);
      }
      if (bh.production_status === 'in_progress') {
        return errResult(409, 'bulkhead_already_running', `Bulkhead ${bh.bulkhead_number} is already running.`);
      }
      const employees = await workerEmployees(client, id);
      const ts = nowIso();
      const started = await startLaborForLocked(
        client,
        bh,
        machine,
        employees,
        ts,
        bh.started_at ? 'restarted' : 'started',
        { confirmTransfer: body && body.confirm_transfer === true, reason: 'bulkhead_start' }
      );
      if (started && started.ok === false) return started;
      const transferredFrom = (started && started.transferred_from) || [];
      const names = employees.map((e) => e.name).filter(Boolean).join(', ');
      const moveNote = transferredFrom.length
        ? ` Moved from ${transferredFrom
            .map((h) => (h.dome_number ? `Dome ${h.dome_number}` : h.bulkhead_number ? `Bulkhead ${h.bulkhead_number}` : null))
            .filter(Boolean)
            .join(', ')}.`
        : '';
      return okResult({
        action: 'bulkhead_started',
        bulkhead_id: id,
        bulkhead_number: bh.bulkhead_number,
        transferred_from: transferredFrom,
        message: names
          ? `Bulkhead ${bh.bulkhead_number} started — ${names}.${moveNote}`
          : `Bulkhead ${bh.bulkhead_number} started.${moveNote}`,
      });
    });
  }

  async function stopBulkhead(machine, body) {
    if (!(await isReady())) return notReady();
    const id = Number(body.bulkhead_id);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Select a bulkhead.');
    return withTransaction(async (client) => {
      const bh = await lockBulkhead(client, id);
      if (!bh || Number(bh.machine_id) !== Number(machine.id)) {
        return errResult(404, 'not_found', 'Bulkhead not found on this kiosk.');
      }
      if (bh.production_status !== 'in_progress') {
        return errResult(409, 'bulkhead_not_running', `Bulkhead ${bh.bulkhead_number} is not running.`, {
          bulkhead_number: bh.bulkhead_number,
        });
      }
      const ts = nowIso();
      await closeLabor(client, bh.id, ts, 'stopped', 'stop');
      await client.query(
        `UPDATE bulkheads SET production_status = 'paused', pause_reason = NULL, updated_at = $2::timestamptz WHERE id = $1`,
        [bh.id, ts]
      );
      await logEvent(client, bh.id, 'stopped', { reason: 'stop' }, 'kiosk', ts);
      return okResult({
        action: 'bulkhead_stopped',
        bulkhead_id: id,
        bulkhead_number: bh.bulkhead_number,
        message: `Bulkhead ${bh.bulkhead_number} stopped.`,
      });
    });
  }

  async function finishBulkhead(machine, body) {
    if (!(await isReady())) return notReady();
    const id = Number(body.bulkhead_id);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Select a bulkhead.');
    const weight = parseWeight(body.weight_lbs != null ? body.weight_lbs : body.weight);
    if (weight == null || weight === undefined) {
      return errResult(400, 'weight_required', 'Enter the Bulkhead Weight in pounds (greater than 0).');
    }
    return withTransaction(async (client) => {
      const bh = await lockBulkhead(client, id);
      if (!bh || Number(bh.machine_id) !== Number(machine.id)) {
        return errResult(404, 'not_found', 'Bulkhead not found on this kiosk.');
      }
      if (bh.production_status === 'completed') {
        return errResult(409, 'bulkhead_completed', `Bulkhead ${bh.bulkhead_number} is already finished.`);
      }
      if (!bh.started_at) {
        return errResult(409, 'bulkhead_not_started', `Start Bulkhead ${bh.bulkhead_number} before finishing it.`);
      }
      const ts = nowIso();
      await closeLabor(client, bh.id, ts, 'finished', 'complete');
      const { rows } = await client.query(
        `UPDATE bulkheads
         SET production_status = 'completed', pause_reason = NULL, weight_lbs = $2, completed_at = $3::timestamptz,
             inventory_status = 'available', updated_at = $3::timestamptz
         WHERE id = $1 RETURNING *`,
        [bh.id, weight, ts]
      );
      await logEvent(client, bh.id, 'completed', { weight_lbs: weight }, 'kiosk', ts);
      return okResult({
        action: 'bulkhead_finished',
        bulkhead: mapBulkhead(rows[0]),
        message: `Bulkhead ${bh.bulkhead_number} finished (${weight} lb) and added to Bulkhead Inventory.`,
      });
    });
  }

  async function setWorkers(machine, body) {
    if (!(await isReady())) return notReady();
    const id = Number(body.bulkhead_id);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Select a bulkhead.');
    const ids = parseIdList(body.worker_ids != null ? body.worker_ids : body.fabricator_ids);
    return withTransaction(async (client) => {
      const bh = await lockBulkhead(client, id);
      if (!bh || Number(bh.machine_id) !== Number(machine.id)) {
        return errResult(404, 'not_found', 'Bulkhead not found on this kiosk.');
      }
      if (bh.production_status === 'completed') {
        return errResult(409, 'bulkhead_completed', `Bulkhead ${bh.bulkhead_number} is already finished.`);
      }
      if (bh.production_status === 'in_progress') {
        return errResult(409, 'bulkhead_already_running', 'Stop the bulkhead before changing workers.');
      }
      const v = await validateWorkers(ids, client);
      if (v.error) return v.error;
      const ts = nowIso();
      await client.query(`DELETE FROM bulkhead_workers WHERE bulkhead_id = $1`, [id]);
      for (const eid of ids) {
        await client.query(
          `INSERT INTO bulkhead_workers (bulkhead_id, employee_id, added_at) VALUES ($1, $2, $3::timestamptz)`,
          [id, eid, ts]
        );
      }
      await logEvent(client, id, 'workers_updated', { workers: ids }, 'kiosk', ts);
      return okResult({
        action: 'bulkhead_workers_updated',
        bulkhead_id: id,
        worker_ids: ids,
        message: `Workers updated for Bulkhead ${bh.bulkhead_number}.`,
      });
    });
  }

  /** Pause all running bulkheads on this kiosk (board Lunch). */
  async function lunchBoard(client, machine, ts) {
    const { rows } = await client.query(
      `SELECT * FROM bulkheads
       WHERE machine_id = $1 AND production_status = 'in_progress' AND deleted_at IS NULL
       ORDER BY id FOR UPDATE`,
      [machine.id]
    );
    const list = [];
    for (const b of rows) {
      await closeLabor(client, b.id, ts, 'stopped', 'lunch');
      await client.query(
        `UPDATE bulkheads SET production_status = 'paused', pause_reason = 'lunch', updated_at = $2::timestamptz WHERE id = $1`,
        [b.id, ts]
      );
      await logEvent(client, b.id, 'lunch', {}, 'kiosk', ts);
      list.push(b.bulkhead_number);
    }
    return list;
  }

  /** Resume lunch-paused bulkheads on this kiosk. */
  async function resumeBoard(client, machine, ts) {
    const { rows } = await client.query(
      `SELECT * FROM bulkheads
       WHERE machine_id = $1 AND production_status = 'paused' AND pause_reason = 'lunch' AND deleted_at IS NULL
       ORDER BY updated_at DESC, id DESC FOR UPDATE`,
      [machine.id]
    );
    const resumed = [];
    const used = new Set();
    for (const b of rows) {
      let employees = await workerEmployees(client, b.id);
      employees = employees.filter((e) => !used.has(Number(e.id)));
      if (!employees.length) continue;
      const started = await startLaborForLocked(client, b, machine, employees, ts, 'resumed', {
        confirmTransfer: false,
        reason: 'bulkhead_resume',
      });
      if (started && started.ok === false) {
        if (started.body && started.body.error === 'employee_assigned_elsewhere') continue;
        return { error: started, resumed };
      }
      for (const e of employees) used.add(Number(e.id));
      resumed.push(b.bulkhead_number);
    }
    return { resumed };
  }

  /** End-shift pause for running/lunch bulkheads on this kiosk. */
  async function endShiftBoard(client, machine, ts) {
    const { rows } = await client.query(
      `SELECT * FROM bulkheads
       WHERE machine_id = $1 AND deleted_at IS NULL
         AND (
           (production_status = 'paused' AND pause_reason = 'lunch')
           OR production_status = 'in_progress'
         )
       ORDER BY id FOR UPDATE`,
      [machine.id]
    );
    const list = [];
    for (const b of rows) {
      await closeLabor(client, b.id, ts, 'stopped', 'end_shift');
      await client.query(
        `UPDATE bulkheads SET production_status = 'paused', pause_reason = 'end_shift', updated_at = $2::timestamptz WHERE id = $1`,
        [b.id, ts]
      );
      await logEvent(client, b.id, 'end_shift', {}, 'kiosk', ts);
      list.push(b.bulkhead_number);
    }
    return list;
  }

  // ---------------------------------------------------------------- Inventory

  const INVENTORY_FILTERS = {
    available: `b.inventory_status = 'available'`,
    assigned: `b.inventory_status = 'assigned'`,
    installed: `b.inventory_status = 'installed'`,
    in_production: `b.production_status <> 'completed'`,
  };

  async function listBulkheads(filters = {}) {
    if (!(await isReady())) return notReady();
    const where = ['b.deleted_at IS NULL'];
    const params = [];
    const search = String(filters.search || '').trim();
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      where.push(
        `(UPPER(b.bulkhead_number) LIKE $${params.length} OR UPPER(COALESCE(b.installed_tank_number, '')) LIKE $${params.length})`
      );
    }
    const status = String(filters.status || '').trim().toLowerCase();
    if (INVENTORY_FILTERS[status]) where.push(INVENTORY_FILTERS[status]);
    const { rows } = await pool.query(
      `SELECT b.*, t.name AS team_name FROM bulkheads b LEFT JOIN teams t ON t.id = b.team_id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE b.inventory_status WHEN 'available' THEN 0 WHEN 'assigned' THEN 1 WHEN 'not_in_inventory' THEN 2 ELSE 3 END,
                UPPER(b.bulkhead_number)
       LIMIT 1000`,
      params
    );
    const { rows: counts } = await pool.query(
      `SELECT inventory_status, production_status, COUNT(*)::int AS n FROM bulkheads WHERE deleted_at IS NULL GROUP BY 1, 2`
    );
    const totals = { all: 0, available: 0, assigned: 0, installed: 0, in_production: 0 };
    for (const c of counts) {
      totals.all += c.n;
      if (c.production_status !== 'completed') totals.in_production += c.n;
      if (totals[c.inventory_status] != null) totals[c.inventory_status] += c.n;
    }
    const ids = rows.map((r) => Number(r.id));
    const workers = await loadWorkers(ids);
    const labor = await loadLaborSummary(ids);
    return okResult({
      bulkheads: rows.map((r) => decorate(r, workers, labor)),
      totals,
    });
  }

  async function getBulkheadDetails(bulkheadId) {
    if (!(await isReady())) return notReady();
    const id = Number(bulkheadId);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Invalid bulkhead id.');
    const { rows } = await pool.query(
      `SELECT b.*, t.name AS team_name FROM bulkheads b LEFT JOIN teams t ON t.id = b.team_id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return errResult(404, 'not_found', 'Bulkhead not found.');
    const workers = await loadWorkers([id]);
    const labor = await loadLaborSummary([id]);
    const { rows: sessions } = await pool.query(
      `SELECT s.id, s.status, s.started_at, s.ended_at, s.end_reason, m.name AS machine_name,
              COALESCE(json_agg(json_build_object('employee_name', p.employee_name, 'employee_code', p.employee_code,
                       'joined_at', p.joined_at, 'left_at', p.left_at) ORDER BY p.joined_at)
                       FILTER (WHERE p.id IS NOT NULL), '[]') AS participants
       FROM bulkhead_labor_sessions s
       LEFT JOIN machines m ON m.id = s.machine_id
       LEFT JOIN bulkhead_labor_participants p ON p.session_id = s.id
       WHERE s.bulkhead_id = $1
       GROUP BY s.id, m.name
       ORDER BY s.started_at DESC`,
      [id]
    );
    const { rows: events } = await pool.query(
      `SELECT id, event, details, performed_by, performed_at FROM bulkhead_events
       WHERE bulkhead_id = $1 ORDER BY performed_at DESC, id DESC LIMIT 100`,
      [id]
    );
    return okResult({
      bulkhead: decorate(rows[0], workers, labor),
      labor_sessions: sessions,
      events,
    });
  }

  async function addManualBulkhead(body, performedBy) {
    if (!(await isReady())) return notReady();
    const number = normalizeNumber(body.bulkhead_number);
    if (!number) return errResult(400, 'bulkhead_number_required', 'Enter a Bulkhead Number.');
    const type = parseBulkheadType(body.bulkhead_type != null ? body.bulkhead_type : body.dome_type);
    if (type === undefined) return errResult(400, 'bulkhead_type_required', 'Select a Bulkhead Type (Petro or Water).');
    const diameterRaw = body.diameter_ft != null ? body.diameter_ft : body.diameter;
    const diameter =
      diameterRaw == null || String(diameterRaw).trim() === '' ? null : parseDiameter(diameterRaw);
    if (diameterRaw != null && String(diameterRaw).trim() !== '' && !diameter) {
      return errResult(400, 'diameter_required', "Select a Diameter (4', 6', 8', 10' or 12').");
    }
    const weightRaw = body.weight_lbs != null ? body.weight_lbs : body.weight;
    const weight = parseWeight(weightRaw);
    if (weight === undefined) {
      return errResult(400, 'weight_required', 'Enter the Bulkhead Weight in pounds (greater than 0).');
    }
    const notes = parseNotes(body.notes);
    return withTransaction(async (client) => {
      const ts = nowIso();
      let rows;
      try {
        ({ rows } = await client.query(
          `INSERT INTO bulkheads (bulkhead_number, bulkhead_type, diameter_ft, weight_lbs, production_status, inventory_status, source,
                                  created_by, notes, created_at, completed_at, updated_at)
           VALUES ($1, $2, $3, $4, 'completed', 'available', 'manual', $5, $6, $7::timestamptz, $7::timestamptz, $7::timestamptz)
           RETURNING *`,
          [number, type, diameter, weight, performedBy || 'manager', notes, ts]
        ));
      } catch (err) {
        if (err && err.code === '23505') {
          return errResult(409, 'duplicate_bulkhead_number', 'That Bulkhead Number already exists. Enter a different number.');
        }
        throw err;
      }
      await logEvent(
        client,
        rows[0].id,
        'manual_added',
        { bulkhead_type: type, diameter_ft: diameter, weight_lbs: weight, notes },
        performedBy,
        ts
      );
      return okResult({ bulkhead: mapBulkhead(rows[0]), message: `Bulkhead ${number} added to inventory.` }, 201);
    });
  }

  async function updateBulkhead(bulkheadId, body, performedBy) {
    if (!(await isReady())) return notReady();
    const id = Number(bulkheadId);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Invalid bulkhead id.');
    return withTransaction(async (client) => {
      const bh = await lockBulkhead(client, id);
      if (!bh) return errResult(404, 'not_found', 'Bulkhead not found.');
      const next = {
        bulkhead_number: bh.bulkhead_number,
        bulkhead_type: bh.bulkhead_type || null,
        diameter_ft: bh.diameter_ft != null ? Number(bh.diameter_ft) : null,
        weight_lbs: bh.weight_lbs != null ? Number(bh.weight_lbs) : null,
        notes: bh.notes,
      };
      if (body.bulkhead_number !== undefined) {
        const n = normalizeNumber(body.bulkhead_number);
        if (!n) return errResult(400, 'bulkhead_number_required', 'Enter a Bulkhead Number.');
        next.bulkhead_number = n;
      }
      if (body.bulkhead_type !== undefined || body.dome_type !== undefined) {
        const t = parseBulkheadType(body.bulkhead_type !== undefined ? body.bulkhead_type : body.dome_type);
        if (t === undefined) return errResult(400, 'bulkhead_type_required', 'Select a Bulkhead Type (Petro or Water).');
        next.bulkhead_type = t;
      }
      if (body.diameter_ft !== undefined || body.diameter !== undefined) {
        const raw = body.diameter_ft !== undefined ? body.diameter_ft : body.diameter;
        if (raw == null || String(raw).trim() === '') next.diameter_ft = null;
        else {
          const d = parseDiameter(raw);
          if (!d) return errResult(400, 'diameter_required', "Select a Diameter (4', 6', 8', 10' or 12').");
          next.diameter_ft = d;
        }
      }
      if (body.weight_lbs !== undefined || body.weight !== undefined) {
        const w = parseWeight(body.weight_lbs !== undefined ? body.weight_lbs : body.weight);
        if (w === undefined) {
          return errResult(400, 'weight_required', 'Enter the Bulkhead Weight in pounds (greater than 0).');
        }
        next.weight_lbs = w;
      }
      if (body.notes !== undefined) next.notes = parseNotes(body.notes);
      const changes = {};
      for (const k of Object.keys(next)) {
        const before = k === 'diameter_ft' || k === 'weight_lbs' ? (bh[k] != null ? Number(bh[k]) : null) : bh[k];
        if (before !== next[k]) changes[k] = { from: before, to: next[k] };
      }
      if (!Object.keys(changes).length) return okResult({ bulkhead: mapBulkhead(bh), message: 'No changes.' });
      const ts = nowIso();
      let rows;
      try {
        ({ rows } = await client.query(
          `UPDATE bulkheads SET bulkhead_number = $2, bulkhead_type = $3, diameter_ft = $4, weight_lbs = $5,
                  notes = $6, updated_at = $7::timestamptz
           WHERE id = $1 RETURNING *`,
          [id, next.bulkhead_number, next.bulkhead_type, next.diameter_ft, next.weight_lbs, next.notes, ts]
        ));
      } catch (err) {
        if (err && err.code === '23505') {
          return errResult(409, 'duplicate_bulkhead_number', 'That Bulkhead Number already exists. Enter a different number.');
        }
        throw err;
      }
      await logEvent(client, id, 'edited', changes, performedBy, ts);
      return okResult({ bulkhead: mapBulkhead(rows[0]), message: `Bulkhead ${next.bulkhead_number} updated.` });
    });
  }

  async function deleteBulkhead(bulkheadId, body = {}, performedBy) {
    if (!(await isReady())) return notReady();
    const id = Number(bulkheadId);
    if (!Number.isInteger(id) || id <= 0) return errResult(400, 'validation', 'Invalid bulkhead id.');
    const confirm = normalizeNumber(body.confirm_bulkhead_number != null ? body.confirm_bulkhead_number : body.bulkhead_number);
    if (!confirm) {
      return errResult(400, 'confirm_required', 'Type the Bulkhead Number to confirm delete.');
    }
    const reason = body.reason != null ? String(body.reason).trim().slice(0, 500) || null : null;
    return withTransaction(async (client) => {
      const bh = await lockBulkhead(client, id);
      if (!bh) return errResult(404, 'not_found', 'Bulkhead not found.');
      if (normalizeNumber(bh.bulkhead_number).toUpperCase() !== confirm.toUpperCase()) {
        return errResult(400, 'confirm_mismatch', 'Bulkhead Number confirmation does not match.');
      }
      if (String(bh.inventory_status) === 'installed') {
        return errResult(
          409,
          'cannot_delete_installed',
          `Bulkhead ${bh.bulkhead_number} is installed and cannot be deleted.`,
          { bulkhead_number: bh.bulkhead_number }
        );
      }
      if (String(bh.inventory_status) === 'assigned') {
        return errResult(
          409,
          'cannot_delete_active',
          `Bulkhead ${bh.bulkhead_number} is assigned and cannot be deleted.`,
          { bulkhead_number: bh.bulkhead_number }
        );
      }
      if (['in_progress', 'paused'].includes(String(bh.production_status))) {
        return errResult(
          409,
          'cannot_delete_active',
          `Bulkhead ${bh.bulkhead_number} is still in production and cannot be deleted.`,
          { bulkhead_number: bh.bulkhead_number }
        );
      }
      const { rows: activeLabor } = await client.query(
        `SELECT id FROM bulkhead_labor_sessions WHERE bulkhead_id = $1 AND status = 'active' LIMIT 1`,
        [id]
      );
      if (activeLabor.length) {
        return errResult(409, 'cannot_delete_active', `Bulkhead ${bh.bulkhead_number} still has open labor.`);
      }
      const ts = nowIso();
      const by = performedBy || 'manager';
      const { rows } = await client.query(
        `UPDATE bulkheads
         SET deleted_at = $2::timestamptz, deleted_by = $3, deleted_reason = $4, updated_at = $2::timestamptz
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [id, ts, by, reason]
      );
      if (!rows.length) return errResult(404, 'not_found', 'Bulkhead not found.');
      await logEvent(
        client,
        id,
        'deleted',
        { inventory_status: bh.inventory_status, production_status: bh.production_status, reason },
        by,
        ts
      );
      return okResult({
        action: 'bulkhead_deleted',
        bulkhead: mapBulkhead(rows[0]),
        message: `Bulkhead ${bh.bulkhead_number} deleted from inventory. Labor history is preserved.`,
      });
    });
  }

  // ---------------------------------------------------------------- Assembly kiosk install (Task 5)

  /** Completed bulkheads in inventory that are free to install on a tank. */
  async function listAvailableBulkheads(filters = {}) {
    if (!(await isReady())) return notReady();
    const params = [];
    const where = [
      `b.deleted_at IS NULL`,
      `b.inventory_status = 'available'`,
      `b.production_status = 'completed'`,
      `b.installed_tank_id IS NULL`,
    ];
    const search = String(filters.search || '').trim();
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      where.push(`UPPER(b.bulkhead_number) LIKE $${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT b.id, b.bulkhead_number, b.bulkhead_type, b.diameter_ft, b.weight_lbs, b.notes,
              b.completed_at, b.source, b.created_at, t.name AS team_name
       FROM bulkheads b
       LEFT JOIN teams t ON t.id = b.team_id
       WHERE ${where.join(' AND ')}
       ORDER BY UPPER(b.bulkhead_number)
       LIMIT 500`,
      params
    );
    return okResult({
      bulkheads: rows.map((r) => {
        const mapped = mapBulkhead(r);
        return {
          id: mapped.id,
          bulkhead_number: mapped.bulkhead_number,
          bulkhead_type: mapped.bulkhead_type,
          diameter_ft: mapped.diameter_ft,
          diameter_label: mapped.diameter_label,
          weight_lbs: mapped.weight_lbs,
          notes: mapped.notes,
          completed_at: mapped.completed_at,
          source: mapped.source,
          team_name: r.team_name || null,
          created_at: mapped.created_at,
        };
      }),
    });
  }

  async function tankBulkheadSummaries(tankIds) {
    const ids = parseIdList(tankIds);
    const map = new Map();
    if (!ids.length || !(await isReady())) return map;
    const { rows } = await pool.query(
      `SELECT a.tank_id, a.status, a.installed_at, b.id AS bulkhead_id, b.bulkhead_number,
              b.bulkhead_type, b.diameter_ft, b.weight_lbs, b.notes
       FROM bulkhead_assignments a
       JOIN bulkheads b ON b.id = a.bulkhead_id
       WHERE a.tank_id = ANY($1::bigint[])
         AND a.status IN ('assigned', 'installed')
         AND b.deleted_at IS NULL
       ORDER BY a.installed_at NULLS LAST, a.id`,
      [ids]
    );
    for (const r of rows) {
      const k = Number(r.tank_id);
      if (!map.has(k)) map.set(k, { installed: [] });
      const diameter = r.diameter_ft != null ? Number(r.diameter_ft) : null;
      map.get(k).installed.push({
        bulkhead_id: Number(r.bulkhead_id),
        bulkhead_number: r.bulkhead_number,
        bulkhead_type: r.bulkhead_type || null,
        diameter_ft: diameter,
        diameter_label: diameter != null ? `${diameter}'` : null,
        weight_lbs: r.weight_lbs != null ? Number(r.weight_lbs) : null,
        notes: r.notes || null,
        installed_at: r.installed_at || null,
        status: r.status,
      });
    }
    return map;
  }

  async function getTankBulkheadState(tankId) {
    const tid = Number(tankId);
    if (!(await isReady()) || !Number.isInteger(tid) || tid <= 0) {
      return { ready: false, installs: [], installed_count: 0 };
    }
    const map = await tankBulkheadSummaries([tid]);
    const installed = (map.get(tid) && map.get(tid).installed) || [];
    return { ready: true, installs: installed, installed_count: installed.length };
  }

  /**
   * Install an available bulkhead onto a tank (Assembly kiosk).
   * Does not change tank status. One live bulkhead per tank; one tank per bulkhead.
   */
  async function installBulkheadOnTank(body = {}, performedBy = 'assembly_kiosk') {
    if (!(await isReady())) return notReady();
    const tankId = Number(body.tank_id != null ? body.tank_id : body.tankId);
    const bulkheadId = Number(body.bulkhead_id != null ? body.bulkhead_id : body.bulkheadId);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'Select a tank.');
    }
    if (!Number.isInteger(bulkheadId) || bulkheadId <= 0) {
      return errResult(400, 'validation', 'Select a bulkhead.');
    }
    const by = String(performedBy || 'assembly_kiosk').slice(0, 200);
    return withTransaction(async (client) => {
      const { rows: tankRows } = await client.query(
        `SELECT id, tank_number, status, deleted_at FROM tanks WHERE id = $1 FOR UPDATE`,
        [tankId]
      );
      const tank = tankRows[0];
      if (!tank || tank.deleted_at) return errResult(404, 'tank_not_found', 'Tank not found.');

      const { rows: tankLive } = await client.query(
        `SELECT a.id, b.bulkhead_number FROM bulkhead_assignments a
         JOIN bulkheads b ON b.id = a.bulkhead_id
         WHERE a.tank_id = $1 AND a.status IN ('assigned', 'installed') LIMIT 1`,
        [tankId]
      );
      if (tankLive.length) {
        return errResult(
          409,
          'tank_has_bulkhead',
          `Tank ${tank.tank_number} already has Bulkhead ${tankLive[0].bulkhead_number}. Remove it in Manager before installing another.`,
          { tank_number: tank.tank_number, bulkhead_number: tankLive[0].bulkhead_number }
        );
      }

      const bh = await lockBulkhead(client, bulkheadId);
      if (!bh) return errResult(404, 'not_found', 'Bulkhead not found.');
      if (String(bh.inventory_status) !== 'available' || bh.installed_tank_id != null) {
        return errResult(
          409,
          'bulkhead_unavailable',
          `Bulkhead ${bh.bulkhead_number} is not available for install.`,
          { bulkhead_number: bh.bulkhead_number, inventory_status: bh.inventory_status }
        );
      }
      if (String(bh.production_status) !== 'completed') {
        return errResult(
          409,
          'bulkhead_not_ready',
          `Bulkhead ${bh.bulkhead_number} is still in production.`,
          { bulkhead_number: bh.bulkhead_number }
        );
      }

      const ts = nowIso();
      try {
        await client.query(
          `INSERT INTO bulkhead_assignments
             (bulkhead_id, tank_id, tank_number, status, assigned_at, installed_at, performed_by, created_at, updated_at)
           VALUES ($1, $2, $3, 'installed', $4::timestamptz, $4::timestamptz, $5, $4::timestamptz, $4::timestamptz)`,
          [bulkheadId, tankId, tank.tank_number, ts, by]
        );
      } catch (err) {
        if (err && err.code === '23505') {
          return errResult(
            409,
            'bulkhead_already_installed',
            'That bulkhead or tank already has an active bulkhead assignment.',
            { bulkhead_number: bh.bulkhead_number, tank_number: tank.tank_number }
          );
        }
        throw err;
      }
      await client.query(
        `UPDATE bulkheads
         SET inventory_status = 'installed',
             installed_at = $2::timestamptz,
             installed_tank_id = $3,
             installed_tank_number = $4,
             updated_at = $2::timestamptz
         WHERE id = $1`,
        [bulkheadId, ts, tankId, tank.tank_number]
      );
      await logEvent(
        client,
        bulkheadId,
        'installed',
        { tank_id: tankId, tank_number: tank.tank_number },
        by,
        ts
      );
      return okResult({
        action: 'bulkhead_installed',
        tank_id: tankId,
        tank_number: tank.tank_number,
        bulkhead: mapBulkhead({
          ...bh,
          inventory_status: 'installed',
          installed_at: ts,
          installed_tank_id: tankId,
          installed_tank_number: tank.tank_number,
        }),
        message: `Bulkhead ${bh.bulkhead_number} installed on Tank ${tank.tank_number}.`,
      });
    });
  }

  /**
   * Manager-only: undo a bulkhead install. Returns bulkhead to available inventory.
   * Assignment row is cancelled (history preserved); bulkhead_events records the undo.
   */
  async function undoBulkheadInstall(body = {}, performedBy = 'manager') {
    if (!(await isReady())) return notReady();
    const tankId = Number(body.tank_id != null ? body.tank_id : body.tankId);
    const bulkheadId = Number(body.bulkhead_id != null ? body.bulkhead_id : body.bulkheadId);
    const reason = body.reason != null ? String(body.reason).trim().slice(0, 500) : '';
    if (!reason || reason.length < 3) {
      return errResult(400, 'reason_required', 'Enter a short reason for removing the bulkhead (at least 3 characters).');
    }
    if ((!Number.isInteger(tankId) || tankId <= 0) && (!Number.isInteger(bulkheadId) || bulkheadId <= 0)) {
      return errResult(400, 'validation', 'tank_id or bulkhead_id is required.');
    }
    const by = String(performedBy || 'manager').slice(0, 200);
    return withTransaction(async (client) => {
      let assignment;
      if (Number.isInteger(bulkheadId) && bulkheadId > 0) {
        const { rows } = await client.query(
          `SELECT a.*, b.bulkhead_number FROM bulkhead_assignments a
           JOIN bulkheads b ON b.id = a.bulkhead_id
           WHERE a.bulkhead_id = $1 AND a.status IN ('assigned', 'installed')
           ORDER BY a.id DESC LIMIT 1 FOR UPDATE OF a`,
          [bulkheadId]
        );
        assignment = rows[0] || null;
      } else {
        const { rows } = await client.query(
          `SELECT a.*, b.bulkhead_number FROM bulkhead_assignments a
           JOIN bulkheads b ON b.id = a.bulkhead_id
           WHERE a.tank_id = $1 AND a.status IN ('assigned', 'installed')
           ORDER BY a.id DESC LIMIT 1 FOR UPDATE OF a`,
          [tankId]
        );
        assignment = rows[0] || null;
      }
      if (!assignment) {
        return errResult(404, 'not_found', 'No installed bulkhead found for that tank.');
      }
      const bhId = Number(assignment.bulkhead_id);
      const bh = await lockBulkhead(client, bhId);
      if (!bh) return errResult(404, 'not_found', 'Bulkhead not found.');
      const ts = nowIso();
      await client.query(
        `UPDATE bulkhead_assignments
         SET status = 'cancelled', cancelled_at = $2::timestamptz, cancel_reason = $3, updated_at = $2::timestamptz
         WHERE id = $1`,
        [assignment.id, ts, reason]
      );
      await client.query(
        `UPDATE bulkheads
         SET inventory_status = 'available',
             installed_at = NULL,
             installed_tank_id = NULL,
             installed_tank_number = NULL,
             updated_at = $2::timestamptz
         WHERE id = $1`,
        [bhId, ts]
      );
      await logEvent(
        client,
        bhId,
        'install_undone',
        {
          tank_id: assignment.tank_id != null ? Number(assignment.tank_id) : null,
          tank_number: assignment.tank_number,
          reason,
          previous_status: assignment.status,
        },
        by,
        ts
      );
      return okResult({
        action: 'bulkhead_install_undone',
        tank_id: assignment.tank_id != null ? Number(assignment.tank_id) : null,
        tank_number: assignment.tank_number,
        bulkhead: mapBulkhead({
          ...bh,
          inventory_status: 'available',
          installed_at: null,
          installed_tank_id: null,
          installed_tank_number: null,
        }),
        message: `Bulkhead ${assignment.bulkhead_number} removed from Tank ${assignment.tank_number} and returned to inventory.`,
      });
    });
  }

  async function collectBulkheadLaborIntervals(employeeId, bounds, closeMs = Date.now()) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0 || !bounds || !(await isReady())) return [];
    const startIso = bounds.startIso || bounds.from;
    const endIso = bounds.endIso || bounds.to;
    if (!startIso || !endIso) return [];
    const ws = new Date(startIso).getTime();
    const we = new Date(endIso).getTime();
    if (Number.isNaN(ws) || Number.isNaN(we)) return [];
    const { rows } = await pool.query(
      `SELECT p.joined_at, p.left_at, s.status, s.ended_at
       FROM bulkhead_labor_participants p
       JOIN bulkhead_labor_sessions s ON s.id = p.session_id
       WHERE p.employee_id = $1 AND p.joined_at < $3::timestamptz
         AND (p.left_at IS NULL OR p.left_at > $2::timestamptz)`,
      [id, startIso, endIso]
    );
    const out = [];
    for (const r of rows) {
      const join = new Date(r.joined_at).getTime();
      if (Number.isNaN(join)) continue;
      let leave = r.left_at ? new Date(r.left_at).getTime() : null;
      if (leave == null || Number.isNaN(leave)) {
        leave = r.status === 'active' ? closeMs : r.ended_at ? new Date(r.ended_at).getTime() : closeMs;
      }
      if (Number.isNaN(leave)) leave = closeMs;
      const start = Math.max(join, ws);
      const end = Math.min(leave, we, closeMs);
      if (end > start) out.push({ start, end, source: 'bulkhead' });
    }
    return out;
  }

  return {
    isReady,
    listMachineBulkheads,
    createBulkhead,
    startBulkhead,
    stopBulkhead,
    finishBulkhead,
    setWorkers,
    lunchBoard,
    resumeBoard,
    endShiftBoard,
    listBulkheads,
    getBulkheadDetails,
    addManualBulkhead,
    updateBulkhead,
    deleteBulkhead,
    listAvailableBulkheads,
    installBulkheadOnTank,
    undoBulkheadInstall,
    tankBulkheadSummaries,
    getTankBulkheadState,
    collectBulkheadLaborIntervals,
    MAX_WORKERS,
  };
}

module.exports = { createPhase3Bulkhead, MAX_WORKERS };
