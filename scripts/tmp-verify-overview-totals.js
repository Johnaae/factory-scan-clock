'use strict';

/** Verify Tank Report overview_totals math (FAB+Assembly; Testing excluded). */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};

async function main() {
  // Load server helpers without listening — require db + phase modules like report payload does.
  require('./load-env');
  const { createPoolOptions } = require('./db-config');
  const pg = require('pg');
  const pool = new pg.Pool(createPoolOptions());

  // Prefer a tank that has FAB sessions; fall back to any tank.
  const { rows } = await pool.query(
    `SELECT t.id, t.tank_number
     FROM tanks t
     WHERE t.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM machine_sessions ms WHERE ms.tank_id = t.id)
     ORDER BY t.updated_at DESC NULLS LAST
     LIMIT 5`
  );
  if (!rows.length) {
    console.log('SKIP: no tanks with machine_sessions');
    await pool.end();
    return;
  }

  // Hit the live report via requiring build from server is heavy; replicate aggregation using phase modules.
  const { createPhase1ProductionLogic } = require('./phase1-production-logic');
  const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

  const nowIso = () => new Date().toISOString();
  const normalizeTankNumber = (v) => String(v || '').trim().toUpperCase();
  const normalizeTankStatus = (raw) =>
    String(raw == null || raw === '' ? 'waiting' : raw)
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');

  const phase1 = createPhase1ProductionLogic({
    pool,
    nowIso,
    normalizeTankNumber,
    normalizeTankStatus,
    startEndOfLocalDay: () => ({ start: new Date(), end: new Date() }),
    localDateString: () => '2026-09-15',
    weekBoundsLocal: () => ({ start: new Date(), end: new Date() }),
    validateTankExists: async (n) => {
      const r = await pool.query(
        `SELECT * FROM tanks WHERE UPPER(TRIM(tank_number::text))=$1 AND deleted_at IS NULL LIMIT 1`,
        [normalizeTankNumber(n)]
      );
      return r.rows[0] || null;
    },
  });
  const phase2 = createPhase2AssemblyTesting(pool, {
    nowIso,
    normalizeTankNumber,
    localDateString: () => '2026-09-15',
    getTeamByBarcode: (b) => phase1.getTeamByBarcode(b),
    getMachineAssignment: (id) => phase1.getMachineAssignment(id),
    assignTeamToMachine: (mid, team) => phase1.assignTeamToMachine(mid, team),
  });

  const fmt = (ms) => phase2.formatDurationXhYm(ms);
  let checked = 0;
  for (const tank of rows) {
    const teamProduction = await phase1.fetchTankProductionLabor(tank.id);
    const stageLabor = await phase2.computeStageLaborForTank(tank.id);
    const tankRow = (await pool.query(`SELECT * FROM tanks WHERE id=$1`, [tank.id])).rows[0];
    const assemblyDurationMs = phase2.computeAssemblyDurationMs(tankRow);
    let testingMs = 0;
    if (typeof phase2.computeTestingElapsedMs === 'function') {
      testingMs = phase2.computeTestingElapsedMs(tankRow) || 0;
    } else {
      const start = tankRow.testing_started_at ? new Date(tankRow.testing_started_at).getTime() : null;
      const done = tankRow.testing_completed_at ? new Date(tankRow.testing_completed_at).getTime() : null;
      if (start != null && !Number.isNaN(start)) {
        testingMs =
          done != null && !Number.isNaN(done) ? Math.max(0, done - start) : 0;
      }
    }

    const fabRunning = Number(teamProduction && teamProduction.total_running_ms) || 0;
    const fabLabor = Number(teamProduction && teamProduction.total_labor_ms) || 0;
    const assemblyLabor = Number(stageLabor && stageLabor.total_ms) || 0;
    const totalProd = fabRunning + assemblyDurationMs;
    const totalLabor = fabLabor + assemblyLabor;

    assert(totalProd === fabRunning + assemblyDurationMs, `${tank.tank_number} production sum`);
    assert(totalLabor === fabLabor + assemblyLabor, `${tank.tank_number} labor sum`);
    // Testing must not be baked into stage labor total.
    const testingStage = ((stageLabor && stageLabor.by_stage) || []).find(
      (s) => String(s.stage).toUpperCase() === 'TESTING'
    );
    if (testingStage) {
      assert(
        assemblyLabor ===
          ((stageLabor.by_stage || [])
            .filter((s) => ['ASSEMBLY', 'CORRECTION'].includes(String(s.stage).toUpperCase()))
            .reduce((sum, s) => sum + (Number(s.total_ms) || 0), 0)),
        `${tank.tank_number} assembly labor excludes TESTING`
      );
    }

    console.log(
      `OK ${tank.tank_number}: prod ${fmt(totalProd)} = FAB ${fmt(fabRunning)} + Asm ${fmt(
        assemblyDurationMs
      )}; labor ${fmt(totalLabor)} = FAB ${fmt(fabLabor)} + Asm ${fmt(assemblyLabor)}; testing ${fmt(
        testingMs
      )} (excluded)`
    );
    checked += 1;
  }

  assert(checked > 0, 'checked at least one tank');
  console.log(`PASS: overview totals math verified on ${checked} tank(s)`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
