'use strict';

/**
 * QA/QC open/resolve for selected tank+piece only.
 * Hot Coat productive time must exclude QA/QC pause window.
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
       VALUES ($1, 'qa-qc-resolve-test', 'waiting', $2::timestamptz, $2::timestamptz, 1, 1)
       ON CONFLICT (tank_number) DO NOTHING`,
      [tankNumber, ts]
    );
    ({ rows } = await pool.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`, [tankNumber]));
    return rows[0];
  }

  async function cleanupTank(num) {
    const { rows } = await pool.query(
      `SELECT id FROM tanks WHERE tank_number = $1 AND description = 'qa-qc-resolve-test'`,
      [num]
    );
    if (!rows[0]) return;
    const id = rows[0].id;
    await pool.query(`UPDATE machines SET active_tank_id = NULL WHERE active_tank_id = $1`, [id]);
    await pool.query(`DELETE FROM alert_events WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM downtime_intervals WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM part_complete_events WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM production_notes WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM tanks WHERE id = $1 AND description = 'qa-qc-resolve-test'`, [id]);
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

  const leftovers = await phase1.getOpenSessionsForMachine(machine.id);
  for (const row of leftovers) {
    await pool.query(
      `UPDATE machine_sessions SET status = 'finished', finished_at = COALESCE(stopped_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
  }
  await pool.query(`UPDATE machines SET active_tank_id = NULL WHERE id = $1`, [machine.id]);

  const suffix = Date.now().toString().slice(-5);
  const tA = `QA${suffix}`;
  const tB = `QB${suffix}`;
  await createTestTank(tA);
  await createTestTank(tB);
  const teamObj = { id: team.id, name: team.name, barcode: team.barcode, active: 1 };

  const s1 = await phase1.startSession(machine, {
    team: teamObj,
    tankNumber: tA,
    phaseRaw: 'PHASE:HOT_COAT',
    pieceNumber: 1,
  });
  const s2 = await phase1.startSession(machine, {
    team: teamObj,
    tankNumber: tB,
    phaseRaw: 'PHASE:WIND',
    pieceNumber: 1,
  });
  if (!s1.ok || !s2.ok) throw new Error(`start failed: ${JSON.stringify(s1.body || s2.body)}`);

  let open = await phase1.getOpenSessionsForMachine(machine.id);
  let byTank = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  await phase1.setMachineActiveTank(machine.id, byTank[tA].tank_id);

  // Run Hot Coat for ~3s productive before QA/QC.
  await new Promise((r) => setTimeout(r, 3000));
  open = await phase1.getOpenSessionsForMachine(machine.id);
  byTank = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  const productiveBeforeMs = phase1.sessionElapsedMs(byTank[tA]);
  if (productiveBeforeMs < 2000) throw new Error(`expected ~3s productive before QA/QC, got ${productiveBeforeMs}`);

  const alert = await phase1.createAlert(machine, 'ALERT:QA_QC', byTank[tA], {
    notes: 'Surface check',
  });
  if (!alert.ok || alert.body.action !== 'alert') throw new Error(`QA/QC open failed: ${JSON.stringify(alert.body)}`);
  if (!alert.body.open_qa_qc || alert.body.open_qa_qc.status !== 'open') {
    throw new Error('open_qa_qc missing after create');
  }

  open = await phase1.getOpenSessionsForMachine(machine.id);
  byTank = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  if (byTank[tA].status !== 'stopped' || String(byTank[tA].stop_reason) !== 'qa_qc') {
    throw new Error('Tank A Piece 1 should be QA/QC paused');
  }
  if (byTank[tB].status !== 'running') throw new Error('Tank B should keep running during QA/QC on A');
  console.log('OK QA/QC pauses selected tank+piece only');

  const dup = await phase1.createAlert(machine, 'ALERT:QA_QC', byTank[tA], {});
  if (dup.ok || dup.body.error !== 'qa_qc_open') {
    throw new Error(`expected duplicate QA/QC block, got ${JSON.stringify(dup.body)}`);
  }
  console.log('OK second open QA/QC blocked');

  // Normal Resume must not clear QA/QC.
  const badResume = await phase1.resumeSession(machine, {});
  open = await phase1.getOpenSessionsForMachine(machine.id);
  byTank = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  if (byTank[tA].status === 'running' && String(byTank[tA].stop_reason || '') === '') {
    // resumeSession may resume winder-level pauses only; QA/QC should remain stopped.
  }
  if (byTank[tA].status !== 'stopped' || String(byTank[tA].stop_reason) !== 'qa_qc') {
    throw new Error(`Resume must not clear QA/QC: ${JSON.stringify(byTank[tA])}`);
  }
  void badResume;
  console.log('OK normal Resume does not clear QA/QC');

  // Simulate ~5s QA/QC hold (scaled down from 5 minutes).
  await new Promise((r) => setTimeout(r, 5000));

  const none = await phase1.resolveQaQcForMachine(machine, {
    tank_id: byTank[tB].tank_id,
    resolved_by: 'test',
  });
  if (none.ok || none.body.error !== 'no_open_qa_qc') {
    // Tank B has no QA/QC — may still resolve if findOpen uses wrong session.
    // Select B then resolve should fail.
    if (none.ok) throw new Error('resolve on Tank B should fail with no open QA/QC');
  }

  await phase1.setMachineActiveTank(machine.id, byTank[tA].tank_id);
  const resolved = await phase1.resolveQaQcForMachine(machine, {
    tank_id: byTank[tA].tank_id,
    resolved_by: 'test-operator',
    resolution_note: 'Surface issue corrected',
  });
  if (!resolved.ok || resolved.body.action !== 'qa_qc_resolved') {
    throw new Error(`resolve failed: ${JSON.stringify(resolved.body)}`);
  }
  if (!resolved.body.alert || resolved.body.alert.status !== 'resolved') {
    throw new Error('alert not resolved');
  }
  if (String(resolved.body.alert.resolution_note || '') !== 'Surface issue corrected') {
    throw new Error('resolution note not saved');
  }

  open = await phase1.getOpenSessionsForMachine(machine.id);
  byTank = Object.fromEntries(open.map((r) => [r.tank_number, r]));
  if (byTank[tA].status !== 'running' || String(byTank[tA].activity_code).toUpperCase() !== 'HOT_COAT') {
    throw new Error('Tank A did not resume Hot Coat after Resolve QA/QC');
  }
  if (byTank[tB].status !== 'running') throw new Error('Tank B should remain running');

  const productiveAfterMs = phase1.sessionElapsedMs(byTank[tA]);
  // After resume, elapsed should be ~productive before QA (~3s), not include the 5s QA window.
  if (productiveAfterMs > productiveBeforeMs + 2500) {
    throw new Error(
      `QA/QC time counted as Hot Coat: before=${productiveBeforeMs} after=${productiveAfterMs}`
    );
  }
  if (Math.abs(productiveAfterMs - productiveBeforeMs) > 2500) {
    throw new Error(
      `Hot Coat elapsed drifted too far after resolve: before=${productiveBeforeMs} after=${productiveAfterMs}`
    );
  }
  console.log('OK Resolve resumes Hot Coat without counting QA/QC time');

  const history = await phase1.fetchTankQaQcHistory(byTank[tA].tank_id);
  if (!history.length || history[0].status !== 'resolved') {
    throw new Error('QA/QC history missing resolved record');
  }
  if ((history[0].duration_ms || 0) < 4000) {
    throw new Error(`expected QA/QC duration ~5s, got ${history[0].duration_ms}`);
  }
  console.log('OK QA/QC history preserved');

  const noOpen = await phase1.resolveQaQcForMachine(machine, {
    tank_id: byTank[tA].tank_id,
    resolved_by: 'test',
  });
  if (noOpen.ok || noOpen.body.error !== 'no_open_qa_qc') {
    throw new Error(`expected no_open_qa_qc, got ${JSON.stringify(noOpen.body)}`);
  }
  console.log('OK resolve rejected when no open issue');

  await cleanupTank(tA);
  await cleanupTank(tB);
  await pool.end();
  console.log('PASS QA/QC resolve workflow');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
