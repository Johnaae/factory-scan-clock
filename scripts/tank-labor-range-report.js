'use strict';

/**
 * Date-range tank labor / running-time report.
 * Reuses FAB membership-labor semantics + Assembly stage labor / duration,
 * clipped to a local-timezone [start, end] window.
 */

const { isTankTotalRunningPhaseCode } = require('./phase1-production-logic');

function createTankLaborRangeReport(pool, helpers = {}) {
  const nowIso = helpers.nowIso || (() => new Date().toISOString());
  const sessionElapsedMs =
    helpers.sessionElapsedMs ||
    ((row, nowMs = Date.now()) => {
      const start = toMs(row.started_at);
      if (start == null) return 0;
      let end;
      if (row.finished_at) end = toMs(row.finished_at);
      else if (row.status === 'stopped' && row.stopped_at) end = toMs(row.stopped_at);
      else if (row.status === 'running') end = nowMs;
      else end = toMs(row.stopped_at) || toMs(row.finished_at) || nowMs;
      if (end == null || end <= start) return 0;
      return end - start;
    });
  const isProductionPhaseCode =
    helpers.isProductionPhaseCode ||
    ((code) => String(code || '').trim().toUpperCase() !== 'PART_COMPLETE');
  const parseLocalDate =
    helpers.parseLocalDate ||
    ((yyyyMmDd) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return null;
      const [y, m, d] = yyyyMmDd.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
      return dt;
    });

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

  function mergeIntervalsMs(intervals) {
    const sorted = (intervals || [])
      .filter((iv) => iv && Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start)
      .map((iv) => ({ start: iv.start, end: iv.end }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    if (!sorted.length) return 0;
    let total = 0;
    let curStart = sorted[0].start;
    let curEnd = sorted[0].end;
    for (let i = 1; i < sorted.length; i += 1) {
      const iv = sorted[i];
      if (iv.start <= curEnd) {
        curEnd = Math.max(curEnd, iv.end);
      } else {
        total += curEnd - curStart;
        curStart = iv.start;
        curEnd = iv.end;
      }
    }
    total += curEnd - curStart;
    return total;
  }

  function formatXhYmFromMs(ms) {
    const totalMin = Math.round(Math.max(0, Number(ms) || 0) / 60000);
    return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
  }

  function roundHours2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function sessionEndIso(row) {
    if (row.finished_at) return row.finished_at;
    if (row.status === 'stopped' && row.stopped_at) return row.stopped_at;
    if (row.status === 'running') return nowIso();
    return row.stopped_at || row.finished_at || nowIso();
  }

  /**
   * Inclusive local calendar range → UTC ISO bounds (same as startEndOfLocalDay).
   */
  function rangeBounds(startDate, endDate) {
    const startDay = parseLocalDate(String(startDate || '').trim());
    const endDay = parseLocalDate(String(endDate || '').trim());
    if (!startDay || !endDay) return null;
    if (endDay.getTime() < startDay.getTime()) return null;
    const start = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate(), 0, 0, 0, 0);
    const end = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate(), 23, 59, 59, 999);
    // Guard against extremely large ranges (performance).
    const maxDays = 366;
    if ((end.getTime() - start.getTime()) / 86400000 > maxDays) {
      return { error: 'range_too_large', message: 'Date range cannot exceed 366 days.' };
    }
    return {
      startDate: String(startDate).trim(),
      endDate: String(endDate).trim(),
      startMs: start.getTime(),
      endMs: end.getTime(),
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  async function findTankIdsInRange(bounds) {
    const { rows } = await pool.query(
      `SELECT tk.id, tk.tank_number,
              tk.assembly_started_at, tk.assembly_completed_at, tk.assembly_removed_at, tk.status
       FROM tanks tk
       WHERE tk.deleted_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM machine_sessions ms
             WHERE ms.tank_id = tk.id
               AND ms.started_at <= $2::timestamptz
               AND COALESCE(ms.finished_at, ms.stopped_at, NOW()) >= $1::timestamptz
           )
           OR EXISTS (
             SELECT 1
             FROM stage_labor_sessions s
             JOIN stage_labor_participants p ON p.session_id = s.id
             WHERE s.tank_id = tk.id
               AND p.joined_at <= $2::timestamptz
               AND COALESCE(p.left_at, s.ended_at, NOW()) >= $1::timestamptz
           )
           OR (
             tk.assembly_started_at IS NOT NULL
             AND tk.assembly_started_at <= $2::timestamptz
             AND COALESCE(tk.assembly_completed_at, tk.assembly_removed_at, NOW()) >= $1::timestamptz
           )
         )
       ORDER BY UPPER(tk.tank_number), tk.id`,
      [bounds.startIso, bounds.endIso]
    );
    return rows;
  }

  /**
   * FAB running (production phases that count toward tank total) + labor (membership),
   * both clipped to [rangeStart, rangeEnd].
   */
  async function computeFabRangeForTank(tankId, bounds, closeMs) {
    const tid = Number(tankId);
    const { rows: sessions } = await pool.query(
      `SELECT ms.*, t.name AS team_name
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       WHERE ms.tank_id = $1
         AND ms.started_at <= $3::timestamptz
         AND COALESCE(ms.finished_at, ms.stopped_at, NOW()) >= $2::timestamptz
       ORDER BY ms.started_at ASC, ms.id ASC`,
      [tid, bounds.startIso, bounds.endIso]
    );

    let runningMs = 0;
    const byEmployee = new Map();

    for (const row of sessions) {
      const code = String(row.activity_code || '').trim().toUpperCase();
      if (!isProductionPhaseCode(code)) continue;

      const startMs = toMs(row.started_at);
      const endMs = Math.min(toMs(sessionEndIso(row)) || closeMs, closeMs);
      if (startMs == null || endMs == null || endMs <= startMs) continue;

      // Clip session window to report range.
      const winStart = Math.max(startMs, bounds.startMs);
      const winEnd = Math.min(endMs, bounds.endMs);
      if (winEnd <= winStart) continue;

      // Running time: only phases that count toward Tank Total Running Time.
      if (isTankTotalRunningPhaseCode(code)) {
        let productiveMs = overlapMs(startMs, endMs, bounds.startMs, bounds.endMs);
        // Scale downtime only inside the clipped window.
        try {
          const { rows: dts } = await pool.query(
            `SELECT started_at, ended_at
             FROM downtime_intervals
             WHERE tank_id = $1
               AND started_at < $3::timestamptz
               AND COALESCE(ended_at, NOW()) > $2::timestamptz
               AND (piece_number IS NULL OR piece_number = $4)`,
            [tid, new Date(winStart).toISOString(), new Date(winEnd).toISOString(), Number(row.piece_number) || 1]
          );
          for (const d of dts) {
            const ds = toMs(d.started_at);
            const de = toMs(d.ended_at || nowIso());
            if (ds == null || de == null) continue;
            productiveMs -= overlapMs(winStart, winEnd, ds, de);
          }
        } catch (_err) {
          /* downtime table may lag */
        }
        runningMs += Math.max(0, productiveMs);
      }

      // Labor: membership ∩ session ∩ range (union later per employee).
      const { rows: memberships } = await pool.query(
        `SELECT m.employee_id, m.joined_at, m.left_at, e.code AS employee_code, e.name AS employee_name
         FROM employee_team_memberships m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.team_id = $1
           AND m.joined_at < $3::timestamptz
           AND COALESCE(m.left_at, NOW()) > $2::timestamptz`,
        [Number(row.team_id), new Date(winStart).toISOString(), new Date(winEnd).toISOString()]
      );

      for (const mem of memberships) {
        const msJoin = toMs(mem.joined_at);
        const msLeave = toMs(mem.left_at || nowIso());
        if (msJoin == null || msLeave == null) continue;
        const laborStart = Math.max(winStart, msJoin);
        const laborEnd = Math.min(winEnd, msLeave, closeMs);
        if (laborEnd <= laborStart) continue;
        const key = Number(mem.employee_id);
        if (!byEmployee.has(key)) {
          byEmployee.set(key, {
            employee_id: key,
            employee_code: mem.employee_code,
            employee_name: mem.employee_name,
            intervals: [],
          });
        }
        byEmployee.get(key).intervals.push({ start: laborStart, end: laborEnd });
      }
    }

    const laborMs = [...byEmployee.values()].reduce((s, e) => s + mergeIntervalsMs(e.intervals), 0);
    return { runningMs, laborMs };
  }

  /**
   * Assembly wall-clock duration clipped to range (same start/end fields as
   * computeAssemblyDurationMs) + ASSEMBLY/CORRECTION stage participant labor.
   */
  async function computeAssemblyRangeForTank(tankRow, bounds, closeMs) {
    let runningMs = 0;
    const startMs = toMs(tankRow.assembly_started_at);
    if (startMs != null) {
      const status = String(tankRow.status || '').toLowerCase();
      let endMs;
      if (status === 'removed_from_assembly') {
        endMs = toMs(tankRow.assembly_removed_at) || closeMs;
      } else {
        endMs = toMs(tankRow.assembly_completed_at) || closeMs;
      }
      if (endMs != null && endMs > startMs) {
        runningMs = overlapMs(startMs, endMs, bounds.startMs, bounds.endMs);
      }
    }

    const { rows } = await pool.query(
      `SELECT s.stage, s.status, s.ended_at, p.employee_id, p.joined_at, p.left_at
       FROM stage_labor_sessions s
       JOIN stage_labor_participants p ON p.session_id = s.id
       WHERE s.tank_id = $1
         AND p.joined_at <= $3::timestamptz
         AND COALESCE(p.left_at, s.ended_at, NOW()) >= $2::timestamptz
       ORDER BY p.joined_at ASC, p.id ASC`,
      [Number(tankRow.id), bounds.startIso, bounds.endIso]
    );

    const byEmployee = new Map();
    for (const row of rows) {
      const stage = String(row.stage || '').toUpperCase();
      if (stage !== 'ASSEMBLY' && stage !== 'CORRECTION') continue;
      const joinMs = toMs(row.joined_at);
      if (joinMs == null) continue;
      const leaveMs =
        toMs(row.left_at) ||
        (row.status === 'active' && row.left_at == null ? closeMs : toMs(row.ended_at) || closeMs);
      if (leaveMs == null || leaveMs <= joinMs) continue;
      const laborStart = Math.max(joinMs, bounds.startMs);
      const laborEnd = Math.min(leaveMs, bounds.endMs, closeMs);
      if (laborEnd <= laborStart) continue;
      const key = Number(row.employee_id);
      if (!byEmployee.has(key)) byEmployee.set(key, []);
      byEmployee.get(key).push({ start: laborStart, end: laborEnd });
    }
    const laborMs = [...byEmployee.values()].reduce((s, ivs) => s + mergeIntervalsMs(ivs), 0);
    return { runningMs, laborMs };
  }

  async function buildTankLaborRangeReport({ startDate, endDate } = {}) {
    const bounds = rangeBounds(startDate, endDate);
    if (!bounds) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'invalid_date', message: 'start and end must be YYYY-MM-DD with end ≥ start.' },
      };
    }
    if (bounds.error) {
      return { ok: false, status: 400, body: { ok: false, error: bounds.error, message: bounds.message } };
    }

    const tankRows = await findTankIdsInRange(bounds);
    const closeMs = Date.now();
    const tanks = [];
    let totalRunningMs = 0;
    let totalLaborMs = 0;

    for (const tankRow of tankRows) {
      const fab = await computeFabRangeForTank(tankRow.id, bounds, closeMs);
      const asm = await computeAssemblyRangeForTank(tankRow, bounds, closeMs);
      const runningMs = fab.runningMs + asm.runningMs;
      const laborMs = fab.laborMs + asm.laborMs;
      // Include tanks with any overlapping activity even if clipped ms is 0
      // (e.g. session started in range but fully downtime — still listed if found by query).
      if (runningMs <= 0 && laborMs <= 0) {
        // Still include: activity existed in range window (query already filtered).
      }
      totalRunningMs += runningMs;
      totalLaborMs += laborMs;
      tanks.push({
        tank_id: Number(tankRow.id),
        tank_number: tankRow.tank_number,
        total_running_ms: runningMs,
        total_running_hours: roundHours2(runningMs / 3600000),
        total_running_display: formatXhYmFromMs(runningMs),
        total_labor_ms: laborMs,
        total_labor_hours: roundHours2(laborMs / 3600000),
        total_labor_display: formatXhYmFromMs(laborMs),
        fab_running_ms: fab.runningMs,
        fab_labor_ms: fab.laborMs,
        assembly_running_ms: asm.runningMs,
        assembly_labor_ms: asm.laborMs,
      });
    }

    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        report: 'tank_labor_range',
        start_date: bounds.startDate,
        end_date: bounds.endDate,
        tank_count: tanks.length,
        tanks,
        totals: {
          total_running_ms: totalRunningMs,
          total_running_hours: roundHours2(totalRunningMs / 3600000),
          total_running_display: formatXhYmFromMs(totalRunningMs),
          total_labor_ms: totalLaborMs,
          total_labor_hours: roundHours2(totalLaborMs / 3600000),
          total_labor_display: formatXhYmFromMs(totalLaborMs),
        },
        generated_at: nowIso(),
      },
    };
  }

  function buildTankLaborRangeCsv(report) {
    const header = ['Tank Number', 'Total Running Time', 'Total Labor Hours'];
    const lines = [header.join(',')];
    for (const r of report.tanks || []) {
      const cells = [r.tank_number, r.total_running_display, r.total_labor_display].map(
        (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`
      );
      lines.push(cells.join(','));
    }
    const totals = report.totals || {};
    lines.push(
      ['TOTALS', totals.total_running_display || '0h 0m', totals.total_labor_display || '0h 0m']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    return `${lines.join('\r\n')}\r\n`;
  }

  return {
    rangeBounds,
    buildTankLaborRangeReport,
    buildTankLaborRangeCsv,
    formatXhYmFromMs,
  };
}

module.exports = {
  createTankLaborRangeReport,
};
