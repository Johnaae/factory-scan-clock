'use strict';

/**
 * Local regression: sequential Vacuum → Brine Testing workflow.
 * Refuses Neon. Cleans up only rows created here.
 */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');
  const phase2 = createPhase2AssemblyTesting(pool, {});
  const suffix = String(Date.now()).slice(-6);
  const machine = { id: null };
  const user = { id: 1, username: 'qa_qc' };
  const created = { tanks: [], machines: [] };

  const m = await pool.query(
    `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
     VALUES ($1,$2,$3,$4,9960,1,'qa_testing',NOW(),NOW()) RETURNING id`,
    [`QA Seq ${suffix}`, `QSEQ-${suffix}`, `QSEQ-BC-${suffix}`, `qa-seq-${suffix}`]
  );
  machine.id = Number(m.rows[0].id);
  created.machines.push(machine.id);

  async function makeTank(tag) {
    const r = await pool.query(
      `INSERT INTO tanks
         (tank_number, status, fab_completed_at, assembly_started_at, assembly_completed_at,
          qa_completed_at, qa_result, requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_testing',NOW(),NOW(),NOW(),NOW(),'PASS',TRUE,NOW(),NOW())
       RETURNING id, tank_number`,
      [`2026-${tag}-${suffix}`]
    );
    const tank = { id: Number(r.rows[0].id), tank_number: r.rows[0].tank_number };
    created.tanks.push(tank.id);
    return tank;
  }

  // --- Ready for Testing: Vacuum/Brine blocked until START TESTING ---
  const tankA = await makeTank('A');
  const vacTooSoon = await phase2.startVacuumTest(machine, {
    tank_id: tankA.id,
    vacuum_start_inhg: 12,
    user,
  });
  assert(!vacTooSoon.ok, 'Vacuum blocked before START TESTING');
  const brineTooSoon = await phase2.startBrineFill(machine, {
    tank_id: tankA.id,
    brine_expected_amount: 100,
    user,
  });
  assert(!brineTooSoon.ok, 'Brine blocked before START TESTING');

  const begin = await phase2.beginTestingSession(machine, { tank_id: tankA.id, user });
  assert(begin.ok && begin.body.tank.status === 'testing_in_progress', 'START TESTING');
  assert(begin.body.attempt_id, 'TESTING attempt created');

  const brineBeforeVac = await phase2.startBrineFill(machine, {
    tank_id: tankA.id,
    brine_expected_amount: 100,
    user,
  });
  assert(!brineBeforeVac.ok, 'Brine locked until Vacuum PASS');

  const completeTooSoon = await phase2.completeTesting(machine, {
    tank_id: tankA.id,
    attempt_id: begin.body.attempt_id,
    result: 'PASS',
    user,
  });
  assert(!completeTooSoon.ok, 'TEST COMPLETE locked until Vacuum PASS');

  // --- Vacuum FAIL → Hold ---
  const vac1 = await phase2.startVacuumTest(machine, {
    tank_id: tankA.id,
    vacuum_start_inhg: 12,
    user,
  });
  assert(vac1.ok, 'vacuum start');
  const vac1End = await phase2.completeVacuumTest(machine, {
    attempt_id: vac1.body.attempt_id,
    vacuum_end_inhg: 10,
    user,
  });
  assert(vac1End.ok && vac1End.body.needs_result, 'vacuum end needs result');
  const vacFail = await phase2.recordVacuumResult(machine, {
    attempt_id: vac1.body.attempt_id,
    result: 'FAIL',
    note: 'Vacuum loss',
    user,
  });
  assert(vacFail.ok && vacFail.body.tank.status === 'testing_failed', 'Vacuum FAIL → testing_failed');
  const boardFail = await phase2.getQaBoardConfig();
  const hold = (boardFail.body.failed_hold || []).find((t) => Number(t.id) === tankA.id);
  assert(hold && hold.failure_source === 'vacuum', 'FAILED/HOLD vacuum source');
  assert(hold.latest_failed_vacuum && /Vacuum loss/i.test(hold.latest_failed_vacuum.failure_note || ''), 'fail reason');
  assert(!(boardFail.body.testing || []).some((t) => Number(t.id) === tankA.id), 'left Testing section');

  // --- RETEST → Attempt #2 starts at Vacuum ---
  const retest = await phase2.retestTesting(machine, { tank_id: tankA.id, user });
  assert(retest.ok && retest.body.tank.status === 'testing_in_progress', 'retest → testing');
  assert(retest.body.attempt_id !== begin.body.attempt_id, 'new TESTING attempt');
  assert(retest.body.tank.is_testing_retest === true, 'retest flag');
  assert(Number(retest.body.tank.testing_attempt_number) >= 2, 'attempt #2');
  assert(retest.body.tank.vacuum_passed !== true, 'brine still locked on retest');
  const brineStillLocked = await phase2.startBrineFill(machine, {
    tank_id: tankA.id,
    brine_expected_amount: 100,
    user,
  });
  assert(!brineStillLocked.ok, 'Brine locked on Attempt #2 until Vacuum PASS');

  // --- Vacuum PASS → Brine unlock ---
  const vac2 = await phase2.startVacuumTest(machine, {
    tank_id: tankA.id,
    vacuum_start_inhg: 12,
    user,
  });
  await phase2.completeVacuumTest(machine, {
    attempt_id: vac2.body.attempt_id,
    vacuum_end_inhg: 12,
    user,
  });
  const vacPass = await phase2.recordVacuumResult(machine, {
    attempt_id: vac2.body.attempt_id,
    result: 'PASS',
    user,
  });
  assert(vacPass.ok && vacPass.body.tank.status === 'testing_in_progress', 'PASS stays in Testing');
  assert(vacPass.body.tank.vacuum_passed === true, 'vacuum_passed');
  assert(vacPass.body.tank.brine_unlocked === true, 'brine unlocked');

  const brine = await phase2.startBrineFill(machine, {
    tank_id: tankA.id,
    brine_expected_amount: 100,
    user,
  });
  assert(brine.ok, 'brine start after vacuum pass');
  const completeMidBrine = await phase2.completeTesting(machine, {
    tank_id: tankA.id,
    attempt_id: retest.body.attempt_id,
    result: 'PASS',
    user,
  });
  assert(!completeMidBrine.ok, 'TEST COMPLETE blocked while Brine open');
  await phase2.stopBrineFill(machine, {
    attempt_id: brine.body.attempt_id,
    brine_actual_amount: 98,
    user,
  });

  const done = await phase2.completeTesting(machine, {
    tank_id: tankA.id,
    attempt_id: retest.body.attempt_id,
    result: 'PASS',
    user,
  });
  assert(done.ok && done.body.tank.status === 'ready_for_dome_install', 'TEST COMPLETE → dome');

  const hist = await phase2.listTestAttemptsForTank(tankA.id);
  const testing = hist.filter((a) => a.test_type === 'TESTING');
  const vacuums = hist.filter((a) => a.test_type === 'VACUUM');
  assert(testing.filter((a) => a.result === 'FAIL').length >= 1, 'failed TESTING attempt preserved');
  assert(testing.filter((a) => a.result === 'PASS').length >= 1, 'passed TESTING attempt recorded');
  assert(vacuums.filter((a) => a.result === 'FAIL').length >= 1, 'failed Vacuum preserved');
  assert(vacuums.filter((a) => a.result === 'PASS').length >= 1, 'passed Vacuum recorded');
  assert(hist.some((a) => a.test_type === 'BRINE'), 'brine preserved');

  // --- CASE C: Vacuum FAIL → FAB rework ---
  const tankC = await makeTank('C');
  await phase2.beginTestingSession(machine, { tank_id: tankC.id, user });
  const vacC = await phase2.startVacuumTest(machine, {
    tank_id: tankC.id,
    vacuum_start_inhg: 20,
    user,
  });
  await phase2.completeVacuumTest(machine, {
    attempt_id: vacC.body.attempt_id,
    vacuum_end_inhg: 15,
    user,
  });
  await phase2.recordVacuumResult(machine, {
    attempt_id: vacC.body.attempt_id,
    result: 'FAIL',
    note: 'Leak — send to FAB',
    user,
  });
  const toFab = await phase2.sendTestingFailToFabRework(machine, {
    tank_id: tankC.id,
    user,
  });
  assert(toFab.ok && toFab.body.tank.status === 'rework_required', 'FAB rework_required');
  const histC = await phase2.listTestAttemptsForTank(tankC.id);
  assert(
    histC.some((a) => a.test_type === 'VACUUM' && a.result === 'FAIL'),
    'Vacuum FAIL history after FAB route'
  );

  // --- Final TEST COMPLETE FAIL after Vacuum PASS + Brine ---
  const tankB = await makeTank('B');
  const beginB = await phase2.beginTestingSession(machine, { tank_id: tankB.id, user });
  const vacB = await phase2.startVacuumTest(machine, {
    tank_id: tankB.id,
    vacuum_start_inhg: 29.5,
    user,
  });
  await phase2.completeVacuumTest(machine, {
    attempt_id: vacB.body.attempt_id,
    vacuum_end_inhg: 29.4,
    user,
  });
  await phase2.recordVacuumResult(machine, {
    attempt_id: vacB.body.attempt_id,
    result: 'PASS',
    user,
  });
  const noBrineComplete = await phase2.completeTesting(machine, {
    tank_id: tankB.id,
    attempt_id: beginB.body.attempt_id,
    result: 'PASS',
    user,
  });
  assert(!noBrineComplete.ok, 'TEST COMPLETE requires Brine');
  const brineB = await phase2.startBrineFill(machine, {
    tank_id: tankB.id,
    brine_expected_amount: 50,
    user,
  });
  await phase2.stopBrineFill(machine, {
    attempt_id: brineB.body.attempt_id,
    brine_actual_amount: 49,
    user,
  });
  const failFinal = await phase2.completeTesting(machine, {
    tank_id: tankB.id,
    attempt_id: beginB.body.attempt_id,
    result: 'FAIL',
    note: 'Overall testing fail after brine',
    user,
  });
  assert(failFinal.ok && failFinal.body.tank.status === 'testing_failed', 'final FAIL → Hold');
  assert(
    failFinal.body.tank.latest_failed_testing &&
      /Overall testing fail/i.test(failFinal.body.tank.latest_failed_testing.failure_note || ''),
    'final fail reason preserved'
  );
  const histB = await phase2.listTestAttemptsForTank(tankB.id);
  assert(histB.some((a) => a.test_type === 'VACUUM' && a.result === 'PASS'), 'vacuum PASS kept after final FAIL');
  assert(histB.some((a) => a.test_type === 'BRINE'), 'brine kept after final FAIL');

  console.log('ALL PASSED');

  for (const id of created.tanks) {
    await pool.query(`DELETE FROM test_attempt_notes WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM test_attempts WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM tank_admin_phase2_audit WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM tanks WHERE id = $1`, [id]);
  }
  for (const id of created.machines) {
    await pool.query(`DELETE FROM machines WHERE id = $1`, [id]);
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    try {
      await closePool();
    } catch (_e) {}
    process.exit(1);
  });
