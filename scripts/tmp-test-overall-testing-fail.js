'use strict';

/**
 * Local regression: overall Testing PASS/FAIL at TEST COMPLETE,
 * FAILED/HOLD, RETEST, SEND BACK TO FAB REWORK.
 * Refuses Neon. Additive only — cleans up only tanks/machines created here.
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
  const createdTankIds = [];
  const createdMachineIds = [];

  const m = await pool.query(
    `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
     VALUES ($1,$2,$3,$4,9981,1,'qa_testing',NOW(),NOW()) RETURNING id`,
    [`QA Test Flow ${suffix}`, `QTF-${suffix}`, `QTF-BC-${suffix}`, `qa-test-flow-${suffix}`]
  );
  machine.id = Number(m.rows[0].id);
  createdMachineIds.push(machine.id);

  async function makeTank(tag) {
    const r = await pool.query(
      `INSERT INTO tanks
         (tank_number, status, fab_completed_at, assembly_started_at, assembly_completed_at,
          requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_qa',NOW(),NOW(),NOW(),TRUE,NOW(),NOW())
       RETURNING id, tank_number`,
      [`2026-${tag}-${suffix}`]
    );
    const tank = { id: Number(r.rows[0].id), tank_number: r.rows[0].tank_number };
    createdTankIds.push(tank.id);
    return tank;
  }

  async function qaPass(tank) {
    await phase2.startQa(machine, { tank_id: tank.id, user });
    const r = await phase2.recordQaResult(machine, { tank_id: tank.id, result: 'PASS', user });
    assert(r.ok && r.body.tank.status === 'ready_for_testing', `${tank.tank_number} QA PASS`);
  }

  async function vacuumBrine(tank) {
    const vac = await phase2.startVacuumTest(machine, {
      tank_id: tank.id,
      vacuum_start_inhg: 29.5,
      user,
    });
    assert(vac.ok, 'vacuum start');
    assert(vac.body.attempt_id !== vac.body.testing_attempt_id, 'vacuum id != testing id');
    const vacDone = await phase2.completeVacuumTest(machine, {
      attempt_id: vac.body.attempt_id,
      vacuum_end_inhg: 28.0,
      user,
    });
    assert(vacDone.ok, 'vacuum complete');
    // Wrong type must fail (regression for "Attempt is not a Vacuum test" root cause)
    const wrong = await phase2.completeVacuumTest(machine, {
      attempt_id: vac.body.testing_attempt_id,
      vacuum_end_inhg: 27.0,
      user,
    });
    assert(!wrong.ok && wrong.body && /not Vacuum/i.test(wrong.body.message || ''), 'wrong type blocked');

    const brine = await phase2.startBrineFill(machine, {
      tank_id: tank.id,
      brine_expected_amount: 100,
      user,
    });
    assert(brine.ok, 'brine start');
    assert(brine.body.attempt_id !== brine.body.testing_attempt_id, 'brine id != testing id');
    const brineDone = await phase2.stopBrineFill(machine, {
      attempt_id: brine.body.attempt_id,
      brine_actual_amount: 98,
      user,
    });
    assert(brineDone.ok, 'brine stop');
    return { testingAttemptId: vac.body.testing_attempt_id, vacuumId: vac.body.attempt_id };
  }

  // ---------- CASE A: PASS ----------
  console.log('CASE A — PASS');
  const tankA = await makeTank('A');
  await qaPass(tankA);
  const beginA = await phase2.beginTestingSession(machine, { tank_id: tankA.id, user });
  assert(beginA.ok && beginA.body.tank.status === 'testing_in_progress', 'A testing started');
  const idsA = await vacuumBrine(tankA);
  const passA = await phase2.completeTesting(machine, {
    tank_id: tankA.id,
    attempt_id: idsA.testingAttemptId,
    result: 'PASS',
    user,
  });
  assert(passA.ok && passA.body.tank.status === 'ready_for_dome_install', 'A PASS → dome');
  const histA = await phase2.listTestAttemptsForTank(tankA.id);
  assert(histA.some((a) => a.test_type === 'TESTING' && a.result === 'PASS'), 'A TESTING PASS history');
  assert(histA.some((a) => a.test_type === 'VACUUM'), 'A vacuum preserved');
  assert(histA.some((a) => a.test_type === 'BRINE'), 'A brine preserved');

  // ---------- CASE B: FAIL + RETEST + PASS ----------
  console.log('CASE B — FAIL + RETEST');
  const tankB = await makeTank('B');
  await qaPass(tankB);
  await phase2.beginTestingSession(machine, { tank_id: tankB.id, user });
  const idsB1 = await vacuumBrine(tankB);
  const failB = await phase2.completeTesting(machine, {
    tank_id: tankB.id,
    attempt_id: idsB1.testingAttemptId,
    result: 'FAIL',
    note: 'Vacuum leak detected',
    user,
  });
  assert(failB.ok && failB.body.tank.status === 'testing_failed', 'B FAIL → testing_failed');
  const boardB1 = await phase2.getQaBoardConfig();
  const holdB = (boardB1.body.failed_hold || []).find((t) => Number(t.id) === tankB.id);
  assert(holdB && holdB.failure_source === 'testing', 'B on FAILED/HOLD as testing');
  assert(
    holdB.latest_failed_testing && /Vacuum leak/i.test(holdB.latest_failed_testing.failure_note || ''),
    'B fail reason on card'
  );
  assert(!(boardB1.body.testing || []).some((t) => Number(t.id) === tankB.id), 'B left Testing section');

  const retest = await phase2.retestTesting(machine, { tank_id: tankB.id, user });
  assert(retest.ok && retest.body.tank.status === 'testing_in_progress', 'B retest → testing');
  assert(retest.body.attempt_id !== idsB1.testingAttemptId, 'B new TESTING attempt id');
  assert(retest.body.tank.is_testing_retest === true, 'B marked retest');
  const idsB2 = await vacuumBrine(tankB);
  assert(idsB2.testingAttemptId === retest.body.attempt_id, 'B vacuum under new testing attempt');
  const passB = await phase2.completeTesting(machine, {
    tank_id: tankB.id,
    attempt_id: idsB2.testingAttemptId,
    result: 'PASS',
    user,
  });
  assert(passB.ok && passB.body.tank.status === 'ready_for_dome_install', 'B retest PASS');
  const histB = await phase2.listTestAttemptsForTank(tankB.id);
  const testingB = histB.filter((a) => a.test_type === 'TESTING');
  assert(testingB.filter((a) => a.result === 'FAIL').length >= 1, 'B FAIL attempt preserved');
  assert(testingB.filter((a) => a.result === 'PASS').length >= 1, 'B PASS attempt recorded');
  assert(testingB.length >= 2, 'B multiple TESTING attempts');

  // ---------- CASE C: FAIL + FAB REWORK ----------
  console.log('CASE C — FAIL + FAB REWORK');
  const tankC = await makeTank('C');
  await qaPass(tankC);
  await phase2.beginTestingSession(machine, { tank_id: tankC.id, user });
  const idsC = await vacuumBrine(tankC);
  await phase2.completeTesting(machine, {
    tank_id: tankC.id,
    attempt_id: idsC.testingAttemptId,
    result: 'FAIL',
    note: 'Brine shortfill — send to FAB',
    user,
  });
  const toFab = await phase2.sendTestingFailToFabRework(machine, {
    tank_id: tankC.id,
    reason: 'Brine shortfill — send to FAB',
    user,
  });
  assert(toFab.ok && toFab.body.tank.status === 'rework_required', 'C → rework_required');
  const audit = await pool.query(
    `SELECT action, previous_status, next_status, reason, details
     FROM tank_admin_phase2_audit
     WHERE tank_id = $1 AND action = 'testing_fail_to_fab_rework'
     ORDER BY id DESC LIMIT 1`,
    [tankC.id]
  );
  if (audit.rows.length) {
    assert(audit.rows[0].previous_status === 'testing_failed', 'C audit previous');
    assert(audit.rows[0].next_status === 'rework_required', 'C audit next');
    const details =
      typeof audit.rows[0].details === 'string'
        ? JSON.parse(audit.rows[0].details)
        : audit.rows[0].details || {};
    assert(details.source === 'testing_fail', 'C audit source=testing_fail');
  } else {
    console.log('(audit table empty/missing — status still rework_required)');
  }
  const histC = await phase2.listTestAttemptsForTank(tankC.id);
  assert(
    histC.some((a) => a.test_type === 'TESTING' && a.result === 'FAIL'),
    'C FAIL attempt still in history after FAB route'
  );

  // ---------- QA FAIL still separate ----------
  console.log('QA FAIL board source');
  const tankQ = await makeTank('Q');
  await phase2.startQa(machine, { tank_id: tankQ.id, user });
  await phase2.recordQaResult(machine, {
    tank_id: tankQ.id,
    result: 'FAIL',
    note: 'weld porosity',
    user,
  });
  const boardQ = await phase2.getQaBoardConfig();
  const holdQ = (boardQ.body.failed_hold || []).find((t) => Number(t.id) === tankQ.id);
  assert(holdQ && holdQ.failure_source === 'qa', 'Q failure_source=qa');

  console.log('ALL PASSED');

  // Cleanup only what we created
  for (const id of createdTankIds) {
    await pool.query(`DELETE FROM test_attempt_notes WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM test_attempts WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM tank_admin_phase2_audit WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM tanks WHERE id = $1`, [id]);
  }
  for (const id of createdMachineIds) {
    await pool.query(`DELETE FROM machines WHERE id = $1`, [id]);
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    try {
      await closePool();
    } catch (_e) {
      /* ignore */
    }
    process.exit(1);
  });
