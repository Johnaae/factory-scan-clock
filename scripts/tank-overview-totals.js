'use strict';

/**
 * Tank Report Overview production / labor totals.
 *
 * Total Running Time =
 *   FAB Running + Assembly Duration + Dome Production Running + Bulkhead Production Running
 *
 * Total Labor Hours =
 *   FAB Labor + Assembly Labor + Dome Labor + Bulkhead Labor
 *
 * Testing / QA-QC elapsed is reported separately and never added into these totals.
 * FAB Running already includes Dome Install machine sessions — do not add install time again.
 */

function defaultFormatXhYm(ms) {
  const totalMin = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (totalMin < 1) return '0h 0m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function buildTankOverviewProductionTotals(teamProduction, assemblyTesting, domeShop, formatXhYm) {
  const tp = teamProduction || {};
  const at = assemblyTesting || {};
  const ds = domeShop || {};
  const fmt = typeof formatXhYm === 'function' ? formatXhYm : defaultFormatXhYm;

  const hoursToMs = (hours) => {
    const h = Number(hours);
    return Number.isFinite(h) ? Math.round(h * 3600000) : 0;
  };

  let fabRunningMs = Number(tp.total_running_ms);
  if (!Number.isFinite(fabRunningMs) || fabRunningMs < 0) {
    fabRunningMs = hoursToMs(tp.total_running_hours != null ? tp.total_running_hours : tp.total_machine_hours);
  }
  let fabLaborMs = Number(tp.total_labor_ms);
  if (!Number.isFinite(fabLaborMs) || fabLaborMs < 0) {
    fabLaborMs = hoursToMs(tp.total_labor_hours != null ? tp.total_labor_hours : tp.total_hours);
  }

  const assemblyDurationMs = Math.max(0, Number(at.assembly_duration_ms) || 0);
  // Existing stage labor total already excludes TESTING (ASSEMBLY + CORRECTION only).
  const assemblyLaborMs = Math.max(0, Number(at.total_stage_labor_ms) || 0);
  const testingElapsedMs = Math.max(0, Number(at.testing_elapsed_ms) || 0);

  const domeRunningMs = Math.max(0, Number(ds.dome_production_ms) || 0);
  const domeLaborMs = Math.max(0, Number(ds.dome_labor_ms) || 0);
  const bulkheadRunningMs = Math.max(0, Number(ds.bulkhead_production_ms) || 0);
  const bulkheadLaborMs = Math.max(0, Number(ds.bulkhead_labor_ms) || 0);
  const domeShopRunningMs = Math.max(
    0,
    Number(ds.production_ms) || domeRunningMs + bulkheadRunningMs
  );
  const domeShopLaborMs = Math.max(0, Number(ds.labor_ms) || domeLaborMs + bulkheadLaborMs);

  const totalProductionMs = fabRunningMs + assemblyDurationMs + domeShopRunningMs;
  const totalLaborMs = fabLaborMs + assemblyLaborMs + domeShopLaborMs;

  const stageLabor = at.stage_labor || {};
  const byStage = Array.isArray(stageLabor.by_stage) ? stageLabor.by_stage : [];
  const assemblyEmpMap = new Map();
  for (const stageRow of byStage) {
    const stage = String(stageRow.stage || '').toUpperCase();
    if (stage !== 'ASSEMBLY' && stage !== 'CORRECTION') continue;
    for (const emp of stageRow.employees || []) {
      const key =
        emp.employee_id != null ? `id:${Number(emp.employee_id)}` : `name:${String(emp.employee_name || '')}`;
      const prev = assemblyEmpMap.get(key) || {
        employee_id: emp.employee_id != null ? Number(emp.employee_id) : null,
        employee_code: emp.employee_code || null,
        employee_name: emp.employee_name || '—',
        stage,
        total_ms: 0,
      };
      prev.total_ms += Number(emp.total_ms) || 0;
      if (stage === 'CORRECTION') prev.stage = 'CORRECTION';
      assemblyEmpMap.set(key, prev);
    }
  }
  const assemblyEmployees = [...assemblyEmpMap.values()]
    .map((e) => ({
      ...e,
      total_display: fmt(e.total_ms),
    }))
    .sort((a, b) => (Number(b.total_ms) || 0) - (Number(a.total_ms) || 0));

  const fabPieces = (tp.hours_per_piece || []).map((p) => {
    const runningMs =
      p.running_ms != null
        ? Number(p.running_ms) || 0
        : hoursToMs(p.running_hours != null ? p.running_hours : p.hours);
    return {
      piece_number: Number(p.piece_number) || 1,
      running_ms: runningMs,
      running_display: p.running_display || fmt(runningMs),
      labor_ms: p.labor_ms != null ? Number(p.labor_ms) || 0 : hoursToMs(p.labor_hours),
      labor_display:
        p.labor_display ||
        fmt(p.labor_ms != null ? Number(p.labor_ms) || 0 : hoursToMs(p.labor_hours)),
    };
  });

  return {
    fab_running_ms: fabRunningMs,
    fab_running_display: tp.total_running_display || fmt(fabRunningMs),
    assembly_duration_ms: assemblyDurationMs,
    assembly_duration_display: at.assembly_duration_display || fmt(assemblyDurationMs),
    dome_production_ms: domeRunningMs,
    dome_production_display: ds.dome_production_display || fmt(domeRunningMs),
    bulkhead_production_ms: bulkheadRunningMs,
    bulkhead_production_display: ds.bulkhead_production_display || fmt(bulkheadRunningMs),
    dome_shop_running_ms: domeShopRunningMs,
    dome_shop_running_display: ds.production_display || fmt(domeShopRunningMs),
    total_production_running_ms: totalProductionMs,
    total_production_running_display: fmt(totalProductionMs),
    fab_labor_ms: fabLaborMs,
    fab_labor_display: tp.total_labor_display || fmt(fabLaborMs),
    assembly_labor_ms: assemblyLaborMs,
    assembly_labor_display: at.total_stage_labor_display || fmt(assemblyLaborMs),
    dome_labor_ms: domeLaborMs,
    dome_labor_display: ds.dome_labor_display || fmt(domeLaborMs),
    bulkhead_labor_ms: bulkheadLaborMs,
    bulkhead_labor_display: ds.bulkhead_labor_display || fmt(bulkheadLaborMs),
    dome_shop_labor_ms: domeShopLaborMs,
    dome_shop_labor_display: ds.labor_display || fmt(domeShopLaborMs),
    total_labor_ms: totalLaborMs,
    total_labor_display: fmt(totalLaborMs),
    testing_elapsed_ms: testingElapsedMs,
    testing_elapsed_display: at.testing_elapsed_display || fmt(testingElapsedMs),
    fab_pieces: fabPieces,
    fab_labor_members: (tp.member_breakdown || []).map((m) => ({
      employee_id: m.employee_id != null ? Number(m.employee_id) : null,
      employee_code: m.employee_code || null,
      employee_name: m.employee_name || '—',
      team_name: m.team_name || null,
      total_ms: Number(m.total_ms) || hoursToMs(m.total_hours),
      total_display:
        m.total_hours_display || m.total_display || fmt(Number(m.total_ms) || hoursToMs(m.total_hours)),
    })),
    assembly_labor_employees: assemblyEmployees,
  };
}

module.exports = {
  buildTankOverviewProductionTotals,
  defaultFormatXhYm,
};
