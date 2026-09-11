'use strict';

/**
 * Unified employee labor across Phase 1 (winding) + Phase 2 (assembly/testing)
 * + optional scan-clock intervals. Overlaps are merged (union), never summed.
 */

function createUnifiedEmployeeLabor(pool, helpers = {}) {
  const nowIso = helpers.nowIso || (() => new Date().toISOString());
  const mergeIntervalsMs =
    helpers.mergeIntervalsMs ||
    function defaultMerge(intervals) {
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
    };
  const mergeIntervals =
    helpers.mergeIntervals ||
    function defaultMergeList(intervals) {
      const sorted = (intervals || [])
        .filter((iv) => iv && Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start)
        .map((iv) => ({
          start: iv.start,
          end: iv.end,
          source: iv.source || null,
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
      if (!sorted.length) return [];
      const out = [];
      let cur = { ...sorted[0] };
      for (let i = 1; i < sorted.length; i += 1) {
        const iv = sorted[i];
        if (iv.start <= cur.end) {
          cur.end = Math.max(cur.end, iv.end);
          if (iv.source && cur.source && iv.source !== cur.source) cur.source = 'merged';
          else if (iv.source && !cur.source) cur.source = iv.source;
        } else {
          out.push(cur);
          cur = { ...iv };
        }
      }
      out.push(cur);
      return out;
    };
  const roundHours2 =
    helpers.roundHours2 || ((n) => Math.round((Number(n) || 0) * 100) / 100);
  const formatXhYmFromMs =
    helpers.formatXhYmFromMs ||
    ((ms) => {
      const totalMin = Math.round(Math.max(0, Number(ms) || 0) / 60000);
      return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
    });
  const collectPhase1Intervals =
    helpers.collectPhase1Intervals ||
    (async () => []);
  const collectScanIntervals =
    helpers.collectScanIntervals ||
    (async () => []);
  const displayMachineName = helpers.displayMachineName || ((n) => n);

  function toMs(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  }

  function stageDisplayName(stage) {
    const s = String(stage || '').trim().toUpperCase();
    if (s === 'ASSEMBLY') return 'Assembly';
    if (s === 'TESTING') return 'Testing';
    if (s === 'CORRECTION') return 'Correction';
    return s || '—';
  }

  /**
   * Phase 2 stage_labor_participants intervals for one employee, clipped to bounds.
   * Open participants count through closeMs (NOW for live windows).
   */
  async function collectPhase2LaborIntervals(employeeId, bounds, closeMs = Date.now()) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0 || !bounds) return [];
    const ws = new Date(bounds.startIso).getTime();
    const we = new Date(bounds.endIso).getTime();
    if (Number.isNaN(ws) || Number.isNaN(we)) return [];

    const { rows } = await pool.query(
      `SELECT p.joined_at, p.left_at, s.status AS session_status, s.ended_at, s.stage
       FROM stage_labor_participants p
       JOIN stage_labor_sessions s ON s.id = p.session_id
       WHERE p.employee_id = $1
         AND UPPER(TRIM(COALESCE(s.stage, ''))) <> 'TESTING'
         AND p.joined_at < $3::timestamptz
         AND (p.left_at IS NULL OR p.left_at > $2::timestamptz)`,
      [id, bounds.startIso, bounds.endIso]
    );

    const intervals = [];
    for (const row of rows) {
      const joinMs = toMs(row.joined_at);
      if (joinMs == null) continue;
      let leaveMs = toMs(row.left_at);
      if (leaveMs == null) {
        if (String(row.session_status || '').toLowerCase() === 'active') {
          leaveMs = closeMs;
        } else {
          leaveMs = toMs(row.ended_at) || closeMs;
        }
      }
      const start = Math.max(joinMs, ws);
      const end = Math.min(leaveMs, we, closeMs);
      if (end > start) {
        intervals.push({
          start,
          end,
          source: 'phase2',
          stage: String(row.stage || '').toUpperCase() || null,
        });
      }
    }
    return intervals;
  }

  /**
   * Collect Phase1 + Phase2 (+ optional scan) intervals, clipped and returned raw
   * (not yet merged). Caller may inspect sources; use getEmployeeUnifiedLaborIntervals
   * for the merged union.
   */
  async function collectEmployeeLaborIntervals(employeeId, bounds, closeMs = Date.now()) {
    const phase1 = await collectPhase1Intervals(employeeId, bounds, closeMs);
    const phase2 = await collectPhase2LaborIntervals(employeeId, bounds, closeMs);
    const scan = await collectScanIntervals(employeeId, bounds, closeMs);
    return [...phase1, ...phase2, ...scan];
  }

  async function getEmployeeUnifiedLaborIntervals(employeeId, fromIso, toIso, opts = {}) {
    const closeMs = opts.closeMs != null ? opts.closeMs : Date.now();
    const bounds = {
      startIso: fromIso,
      endIso: toIso,
    };
    const raw = await collectEmployeeLaborIntervals(employeeId, bounds, closeMs);
    const merged = mergeIntervals(raw);
    const totalMs = mergeIntervalsMs(merged);
    return {
      employee_id: Number(employeeId),
      from: fromIso,
      to: toIso,
      intervals: merged,
      raw_count: raw.length,
      total_ms: totalMs,
      total_display: formatXhYmFromMs(totalMs),
      total_hours: roundHours2(totalMs / 3600000),
    };
  }

  async function getEmployeeUnifiedLaborMs(employeeId, bounds, closeMs = Date.now()) {
    if (!bounds) return 0;
    const result = await getEmployeeUnifiedLaborIntervals(
      employeeId,
      bounds.startIso,
      bounds.endIso,
      { closeMs }
    );
    return result.total_ms;
  }

  async function getEmployeeUnifiedLaborHoursForDay(employeeId, yyyyMmDd, dayBoundsFn) {
    const bounds = typeof dayBoundsFn === 'function' ? dayBoundsFn(yyyyMmDd) : null;
    if (!bounds) return 0;
    const todayKey =
      typeof helpers.localDateString === 'function' ? helpers.localDateString() : null;
    const closeMs =
      todayKey && yyyyMmDd === todayKey ? Date.now() : new Date(bounds.endIso).getTime();
    const ms = await getEmployeeUnifiedLaborMs(employeeId, bounds, closeMs);
    return roundHours2(ms / 3600000);
  }

  async function getEmployeeUnifiedLaborWeekHours(employeeId, weekBounds, todayBounds) {
    if (!weekBounds || !todayBounds) return 0;
    const bounds = { startIso: weekBounds.startIso, endIso: todayBounds.endIso };
    const ms = await getEmployeeUnifiedLaborMs(employeeId, bounds, Date.now());
    return roundHours2(ms / 3600000);
  }

  /**
   * Active Phase 2 stage labor sessions keyed by team_id (null team sessions omitted
   * from Team Management — individual labor still counts via participants).
   */
  async function listActiveStageLaborByTeam(closeMs = Date.now()) {
    const { rows } = await pool.query(
      `SELECT s.id AS session_id, s.tank_id, s.machine_id, s.team_id, s.stage, s.status,
              s.started_at, s.ended_at,
              tk.tank_number, tk.first_scanned_at, tk.created_at, tk.completed_at,
              tk.assembly_completed_at, tk.status AS tank_status,
              m.name AS machine_name, m.kiosk_slug,
              t.name AS team_name,
              (SELECT COUNT(*)::int FROM stage_labor_participants p
                WHERE p.session_id = s.id AND p.left_at IS NULL) AS open_participants
       FROM stage_labor_sessions s
       JOIN tanks tk ON tk.id = s.tank_id
       JOIN machines m ON m.id = s.machine_id
       LEFT JOIN teams t ON t.id = s.team_id
       WHERE LOWER(TRIM(COALESCE(s.status, ''))) = 'active'
         AND UPPER(TRIM(COALESCE(s.stage, ''))) <> 'TESTING'
       ORDER BY s.started_at DESC, s.id DESC`
    );

    const byTeam = new Map();
    for (const row of rows) {
      const teamId = row.team_id != null ? Number(row.team_id) : null;
      if (!Number.isInteger(teamId) || teamId <= 0) continue;
      if (byTeam.has(teamId)) continue; // most recent only per team
      const startedMs = toMs(row.started_at);
      const elapsedMs =
        startedMs != null ? Math.max(0, closeMs - startedMs) : 0;

      // Tank Total Running Time: first_scanned_at → assembly_completed_at (frozen) / now / completed.
      const tankStartMs = toMs(row.first_scanned_at) || toMs(row.created_at);
      const tankStatus = String(row.tank_status || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
      let tankEndMs = closeMs;
      const assemblyDoneMs = toMs(row.assembly_completed_at);
      if (assemblyDoneMs != null) {
        tankEndMs = assemblyDoneMs;
      } else if (tankStatus === 'archived' || tankStatus === 'completed' || tankStatus === 'ready_to_ship') {
        tankEndMs = toMs(row.completed_at) || closeMs;
      }
      const tankDurationMs =
        tankStartMs != null ? Math.max(0, tankEndMs - tankStartMs) : 0;

      byTeam.set(teamId, {
        session_id: Number(row.session_id),
        tank_id: Number(row.tank_id),
        tank_number: row.tank_number || null,
        machine_id: Number(row.machine_id),
        machine_name: displayMachineName(row.machine_name || row.kiosk_slug || ''),
        team_id: teamId,
        team_name: row.team_name || null,
        stage: String(row.stage || '').toUpperCase(),
        stage_display: stageDisplayName(row.stage),
        status: 'running',
        status_label: 'Running',
        started_at: row.started_at,
        elapsed_ms: elapsedMs,
        elapsed_display: formatXhYmFromMs(elapsedMs),
        tank_total_running_time_ms: tankDurationMs,
        tank_total_running_time_display: formatXhYmFromMs(tankDurationMs),
        open_participants: Number(row.open_participants) || 0,
        source: 'phase2',
        tank_level: true,
      });
    }
    return byTeam;
  }

  /**
   * Merge Phase 2 active labor into Team Management cards built from Phase 1.
   * Does not invent teams. Individual (team_id null) stage labor is ignored here.
   */
  function mergeTeamDashboardWithStageLabor(cards, stageByTeam) {
    if (!Array.isArray(cards) || !stageByTeam || !stageByTeam.size) return cards || [];
    return cards.map((card) => {
      const tid = Number(card.id);
      const stage = stageByTeam.get(tid);
      if (!stage) return card;

      const hasPhase1 = Array.isArray(card.active_sessions) && card.active_sessions.length > 0;
      const phase1Running = hasPhase1 && (card.status === 'running' || card.status === 'stopped');

      if (phase1Running) {
        const phase1Start = card.started_at ? toMs(card.started_at) : null;
        const stageStart = stage.started_at ? toMs(stage.started_at) : null;
        console.warn('[team-dashboard] conflicting active Phase1 + Phase2 labor for team', {
          team_id: tid,
          team_name: card.name,
          phase1_session_id: card.session_id,
          phase1_started_at: card.started_at,
          phase2_session_id: stage.session_id,
          phase2_started_at: stage.started_at,
          phase2_stage: stage.stage,
        });
        // Prefer the more recently started open labor context.
        if (phase1Start != null && stageStart != null && phase1Start >= stageStart) {
          return card;
        }
      }

      const stageEntry = {
        machine_id: stage.machine_id,
        machine_name: stage.machine_name,
        tank_number: stage.tank_number,
        tank_id: stage.tank_id,
        piece_number: null,
        phase_name: stage.stage_display,
        status: 'running',
        status_label: 'Running',
        // Team Management does not show stage elapsed for Phase 2.
        elapsed_display: null,
        running_time_display: null,
        started_at: stage.started_at,
        session_id: stage.session_id,
        estimated_labor_cost: null,
        phase_time_summary: [],
        tank_total_running_time_ms: stage.tank_total_running_time_ms,
        tank_total_running_time_display: stage.tank_total_running_time_display,
        source: 'phase2',
        stage: stage.stage,
        tank_level: true,
      };

      return {
        ...card,
        current_machine: stage.machine_name,
        current_tank: stage.tank_number,
        current_phase: stage.stage_display,
        current_piece: null,
        status: 'running',
        status_label: 'Running',
        // Hide Current Stage Time — kiosk owns Assembly Duration / Labor Time.
        elapsed_display: null,
        running_time_display: null,
        hide_stage_time: true,
        started_at: stage.started_at,
        // Do not reuse Phase 1 session-details modal for stage labor ids.
        session_id: null,
        tank_id: stage.tank_id,
        estimated_labor_cost: null,
        tank_total_running_time_ms: stage.tank_total_running_time_ms,
        tank_total_running_time_display: stage.tank_total_running_time_display || '—',
        // Phase 2 is tank-level — do not show Phase 1 piece phase summary.
        phase_time_summary: [],
        active_sessions: [stageEntry],
        active_session_count: 1,
        stage_labor: stage,
      };
    });
  }

  return {
    collectPhase2LaborIntervals,
    collectEmployeeLaborIntervals,
    getEmployeeUnifiedLaborIntervals,
    getEmployeeUnifiedLaborMs,
    getEmployeeUnifiedLaborHoursForDay,
    getEmployeeUnifiedLaborWeekHours,
    listActiveStageLaborByTeam,
    mergeTeamDashboardWithStageLabor,
    stageDisplayName,
    formatXhYmFromMs,
    mergeIntervalsMs,
    mergeIntervals,
    nowIso,
  };
}

module.exports = { createUnifiedEmployeeLabor };
