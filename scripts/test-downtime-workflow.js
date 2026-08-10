'use strict';

/**
 * Winder Break/Resume + tank-specific Downtime scenario.
 * Tank A Chop + Tank B Hot Coat → Break both → Resume phases → Downtime A only → Resume A only → End Shift both.
 */
require('./load-env');
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');
const { createPhase1ProductionLogic } = require('./phase1-production-logic');
const { runSchemaMigrationWithPool } = require('./schema-migrate');

(async () => {
  const pool = new Pool(createPoolOptions());
  await runSchemaMigrationWithPool(pool, { log: { log() {}, warn() {} } });

  const nowIso = () => new Date().toISOString();
  const normalizeTankNumber = (v) => String(v || '').trim().toUpperCase();
  const normalizeTankStatus = (s) => {
    const x = String(s || 'active').toLowerCase().trim();
    if (x === 'archived' || x === 'completed') return 'archived';
    if (x === 'waiting') return 'waiting';
    if (x === 'paused') return 'paused';
    return 'active';
  };
  const localDateString = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const startEndOfLocalDay = (date) => {
    const [y, m, dd] = String(date).split('-').map(Number);
    return {
      startIso: new Date(y, m - 1, dd, 0, 0, 0, 0).toISOString(),
      endIso: new Date(y, m - 1, dd, 23, 59, 59, 999).toISOString(),
    };
  };
  const weekBoundsLocal = () => startEndOfLocalDay(localDateString());

  async function createTestTank(raw) {
    const tankNumber = normalizeTankNumber(raw);
    let { rows } = await pool.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`, [
      tankNumber,
    ]);
    if (rows[0]) return rows[0];
    const ts = nowIso();
    await pool.query(
      `INSERT INTO tanks (tank_number, description, status, created_at, updated_at, piece_count, current_piece_number)
       VALUES ($1, 'downtime-workflow-test', 'waiting', $2::timestamptz, $2::timestamptz, 1, 1)
       ON CONFLICT (tank_number) DO NOTHING`,
      [tankNumber, ts]
    );
    ({ rows } = await pool.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`, [tankNumber]));
    return rows[0];
  }

  async function cleanupTank(num) {
    const { rows } = await pool.query(
      `SELECT id FROM tanks WHERE tank_number = $1 AND description = 'downtime-workflow-test'`,
      [num]
    );
    if (!rows[0]) return;
    const id = rows[0].id;
    await pool.query(`UPDATE machines SET active_tank_id = NULL WHERE active_tank_id = $1`, [id]);
    await pool.query(`DELETE FROM downtime_intervals WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM part_complete_events WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM production_notes WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM tanks WHERE id = $1 AND description = 'downtime-workflow-test'`, [id]);
  }

  const phase1 = createPhase1ProductionLogic({
    pool,
    nowIso,
    normalizeTankNumber,
    ensureTankExists: createTestTank,
    normalizeTankStatus,
    startEndOfLocalDay,
    localDateString,
    weekBoundsLocal,
  });

  const machine = (await phase1.fetchCanonicalWindingMachines())[0];
  const team = (await pool.query(`SELECT id, name, barcode, active FROM teams WHERE active = 1 ORDER BY id ASC LIMIT 1`))
    .rows[0];
  if (!machine || !team) throw new Error('Need machine + team');

  // Isolate test: finish any leftover open sessions on this machine.
  const leftovers = await phase1.getOpenSessionsForMachine(machine.id);
  for (const row of leftovers) {
    await pool.query(
      `UPDATE machine_sessions SET status = 'finished', finished_at = COALESCE(stopped_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
  }
  await pool.query(`UPDATE machines SET active_tank_id = NULL WHERE id = $1`, [machine.id]);

  const suffix = Date.now().toString().slice(-5);
  const tA = `DA${suffix}`;
  const tB = `DB${suffix}`;
  await createTestTank(tA);
  await createTestTank(tB);
  const teamObj = { id: team.id, name: team.name, barcode: team.barcode, active: 1 };

  const s1 = await phase1.startSession(machine, { team: teamObj, tankNumber: tA, phaseRaw: 'PHASE:CHOP' });
  const s2 = await phase1.startSession(machine, { team: teamObj, tankNumber: tB, phaseRaw: 'PHASE:HOT_COAT' });
  if (!s1.ok || !s2.ok) throw new Error(`start failed: ${JSON.stringify(s1.body || s2.body)}`);

  // Break — immediate, no confirmation, both tanks
  const pause = await phase1.pauseSession(machine, 'STOP:BREAK', {});
  if (!pause.ok || pause.body.action !== 'pause') throw new Error(`break failed: ${JSON.stringify(pause.body)}`);
  if (pause.body.action === 'need_winder_confirmation') throw new Error('confirmation should be removed');
  let open = await phase1.getOpenSessionsForMachine(machine.id);
  if (open.length !== 2) throw new Error('expected 2 open after break');
  for (const row of open) {
    if (row.status !== 'stopped' || String(row.stop_reason) !== 'break') {
      throw new Error(`tank ${row.tank_number} not on break`);
    }
  }
  console.log('OK Break applied to both tanks immediately');

  const resume = await phase1.resumeSession(machine, {});
  if (!resume.ok) throw new Error(`resume failed: ${JSON.stringify(resume.body)}`);
  open = await phase1.getOpenSessionsForMachine(machine.id);
  const byTank = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  if (byTank[tA].status !== 'running' || String(byTank[tA].activity_code).toUpperCase() !== 'CHOP') {
    throw new Error('Tank A did not resume Chop');
  }
  if (byTank[tB].status !== 'running' || String(byTank[tB].activity_code).toUpperCase() !== 'HOT_COAT') {
    throw new Error('Tank B did not resume Hot Coat');
  }
  console.log('OK Resume restored each tank phase');

  // Downtime only on Tank A
  await phase1.setMachineActiveTank(machine.id, byTank[tA].tank_id);
  const dt = await phase1.pauseDowntimeSession(machine, {
    tank_id: Number(byTank[tA].tank_id),
    reason_code: 'equipment_issue',
    reason_note: 'test downtime',
  });
  if (!dt.ok || dt.body.action !== 'downtime') throw new Error(`downtime failed: ${JSON.stringify(dt.body)}`);
  open = await phase1.getOpenSessionsForMachine(machine.id);
  const afterDt = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  if (afterDt[tA].status !== 'stopped' || String(afterDt[tA].stop_reason) !== 'downtime') {
    throw new Error('Tank A not on downtime');
  }
  if (afterDt[tB].status !== 'running') throw new Error('Tank B should still be running during Downtime on A');
  console.log('OK Downtime is tank-specific');

  const resumeDt = await phase1.resumeSelectedSession(machine, { tank_id: Number(afterDt[tA].tank_id) });
  if (!resumeDt.ok) throw new Error(`resume downtime failed: ${JSON.stringify(resumeDt.body)}`);
  open = await phase1.getOpenSessionsForMachine(machine.id);
  const afterResumeDt = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  if (afterResumeDt[tA].status !== 'running' || String(afterResumeDt[tA].activity_code).toUpperCase() !== 'CHOP') {
    throw new Error('Tank A did not resume Chop after Downtime');
  }
  if (afterResumeDt[tB].status !== 'running') throw new Error('Tank B should remain running');
  console.log('OK Resume from Downtime is tank-specific');

  const end = await phase1.endShiftSession(machine, {});
  if (!end.ok || end.body.action !== 'end_shift') throw new Error(`end shift failed: ${JSON.stringify(end.body)}`);
  if (end.body.action === 'need_winder_confirmation') throw new Error('end shift confirmation should be removed');
  open = await phase1.getOpenSessionsForMachine(machine.id);
  if (open.length) throw new Error('open sessions remain after end shift');
  console.log('OK End Shift applied immediately to all tanks');

  await cleanupTank(tA);
  await cleanupTank(tB);
  await pool.end();
  console.log('PASS downtime + winder-level workflow');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
