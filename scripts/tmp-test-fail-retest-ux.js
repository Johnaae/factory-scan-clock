'use strict';

/**
 * Local regression: QA FAIL + Vacuum/Brine FAIL retest UX/backend.
 * Refuses Neon. No destructive cleanup of unrelated production tanks.
 */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');
  const phase2 = createPhase2AssemblyTesting(pool, {});
  const suffix = String(Date.now()).slice(-6);
  const machine = { id: null };
  const user = { id: 1, username: 'qa_qc' };

  const m = await pool.query(
    `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
     VALUES ($1,$2,$3,$4,9980,1,'qa_testing',NOW(),NOW()) RETURNING id`,
    [`QA Fail UX ${suffix}`, `QAF-${suffix}`, `QAF-BC-${suffix}`, `qa-fail-ux-${suffix}`]
  );
  machine.id = Number(m.rows[0].id);

  async function makeTank(tag) {
    const r = await pool.query(
      `INSERT INTO tanks
         (tank_number, status, fab_completed_at, assembly_started_at, assembly_completed_at,
          requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_qa',NOW(),NOW(),NOW(),TRUE,NOW(),NOW())
       RETURNING id, tank_number`,
      [`2026-${tag}-${suffix}`]
    );
    return { id: Number(r.rows[0].id), tank_number: r.rows[0].tank_number };
  }

  // ---------- D: QA FAIL → restart → PASS ----------
  const tankD = await makeTank('D');
  await phase2.startQa(machine, { tank_id: tankD.id, user });
  const qaFail = await phase2.recordQaResult(machine, {
    tank_id: tankD.id,
    result: 'FAIL',
    note: 'qa weld issue',
    user,
  });
  assert(qaFail.ok && qaFail.body.tank.status === 'qa_failed', 'D QA fail status');
  const boardFail = await phase2.getQaBoardConfig();
  assert(
    (boardFail.body.qa_failed || []).some((t) => Number(t.id) === tankD.id),
    'D on qa_failed board'
  );
  await phase2.startQa(machine, { tank_id: tankD.id, user });
  const qaPassD = await phase2.recordQaResult(machine, {
    tank_id: tankD.id,
    result: 'PASS',
    user,
  });
  assert(qaPassD.ok && qaPassD.body.tank.status === 'ready_for_testing', 'D ready for testing');
  const qaAttemptsD = await phase2.listTestAttemptsForTank(tankD.id);
  assert(
    qaAttemptsD.filter((a) => a.test_type === 'QA' && a.result === 'FAIL').length >= 1 &&
      qaAttemptsD.filter((a) => a.test_type === 'QA' && a.result === 'PASS').length >= 1,
    'D QA history'
  );

  // ---------- A: QA PASS → Vacuum PASS ----------
  const tankA = await makeTank('A');
  await phase2.startQa(machine, { tank_id: tankA.id, user });
  await phase2.recordQaResult(machine, { tank_id: tankA.id, result: 'PASS', user });
  const vacA = await phase2.startVacuumTest(machine, {
    tank_id: tankA.id,
    vacuum_start_inhg: 29.5,
    user,
  });
  const vacAPass = await phase2.completeVacuumTest(machine, {
    attempt_id: vacA.body.attempt_id,
    vacuum_end_inhg: 29.4,
    result: 'PASS',
    user,
  });
  assert(vacAPass.ok && vacAPass.body.tank.status === 'ready_for_dome_install', 'A vacuum pass complete');

  // ---------- B: Vacuum FAIL → note → retest PASS ----------
  const tankB = await makeTank('B');
  await phase2.startQa(machine, { tank_id: tankB.id, user });
  await phase2.recordQaResult(machine, { tank_id: tankB.id, result: 'PASS', user });
  const vacB1 = await phase2.startVacuumTest(machine, {
    tank_id: tankB.id,
    vacuum_start_inhg: 30,
    user,
  });
  const vacBFail = await phase2.completeVacuumTest(machine, {
    attempt_id: vacB1.body.attempt_id,
    vacuum_end_inhg: 10,
    result: 'FAIL',
    note: 'vacuum leak B',
    user,
  });
  assert(vacBFail.ok && vacBFail.body.tank.status === 'ready_for_testing', 'B back to ready_for_testing');
  assert(vacBFail.body.tank.vacuum_retest_required === true, 'B vacuum_retest_required');
  assert(
    vacBFail.body.tank.testing_status_label === 'Vacuum Failed — Retest Required',
    `B label=${vacBFail.body.tank.testing_status_label}`
  );
  assert(
    vacBFail.body.tank.latest_failed_vacuum &&
      vacBFail.body.tank.latest_failed_vacuum.failure_note === 'vacuum leak B',
    'B failure note on context'
  );

  const noteB = await phase2.appendTestAttemptNote({
    attempt_id: vacB1.body.attempt_id,
    note: 'follow-up photo taken',
    user,
  });
  assert(noteB.ok, 'B add note to failed attempt');

  const boardB = await phase2.getQaBoardConfig();
  const cardB = (boardB.body.ready_for_testing || []).find((t) => Number(t.id) === tankB.id);
  assert(cardB && cardB.vacuum_retest_required, 'B board card retest required');
  assert(cardB.latest_failed_vacuum && cardB.latest_failed_vacuum.id === vacB1.body.attempt_id, 'B failed attempt id');

  const vacB2 = await phase2.startVacuumTest(machine, {
    tank_id: tankB.id,
    vacuum_start_inhg: 29.9,
    user,
  });
  assert(Number(vacB2.body.attempt_id) !== Number(vacB1.body.attempt_id), 'B new attempt id');
  const ctxMid = await phase2.getTestingFailureContext(tankB.id);
  assert(ctxMid.vacuum_retest_in_progress === true, 'B vacuum retest in progress');
  assert(ctxMid.testing_status_label === 'Testing — Vacuum Retest', ctxMid.testing_status_label);

  const vacBPass = await phase2.completeVacuumTest(machine, {
    attempt_id: vacB2.body.attempt_id,
    vacuum_end_inhg: 29.8,
    result: 'PASS',
    user,
  });
  assert(vacBPass.ok && vacBPass.body.tank.status === 'ready_for_dome_install', 'B pass completes');
  const attemptsB = await phase2.listTestAttemptsForTank(tankB.id);
  const vacFails = attemptsB.filter((a) => a.test_type === 'VACUUM' && a.result === 'FAIL');
  const vacPasses = attemptsB.filter((a) => a.test_type === 'VACUUM' && a.result === 'PASS');
  assert(vacFails.length >= 1 && vacPasses.length >= 1, 'B keep FAIL+PASS history');
  assert(vacFails[0].notes && vacFails[0].notes.length >= 1, 'B fail attempt notes preserved');
  // Ensure fail row not overwritten
  const failRow = await pool.query(`SELECT result, failure_note FROM test_attempts WHERE id = $1`, [
    vacB1.body.attempt_id,
  ]);
  assert(failRow.rows[0].result === 'FAIL' && failRow.rows[0].failure_note === 'vacuum leak B', 'B fail immutable');

  // ---------- C: Brine FAIL → note → retest PASS ----------
  const tankC = await makeTank('C');
  await phase2.startQa(machine, { tank_id: tankC.id, user });
  await phase2.recordQaResult(machine, { tank_id: tankC.id, result: 'PASS', user });
  const brine1 = await phase2.startBrineFill(machine, {
    tank_id: tankC.id,
    brine_expected_amount: 100,
    user,
  });
  const brineFail = await phase2.stopBrineFill(machine, {
    attempt_id: brine1.body.attempt_id,
    brine_actual_amount: 50,
    result: 'FAIL',
    note: 'underfill C',
    user,
  });
  assert(brineFail.ok && brineFail.body.tank.status === 'ready_for_testing', 'C ready for testing after brine fail');
  assert(brineFail.body.tank.brine_retest_required === true, 'C brine_retest_required');
  assert(
    brineFail.body.tank.testing_status_label === 'Brine Failed — Retest Required',
    brineFail.body.tank.testing_status_label
  );

  const noteC = await phase2.appendTestAttemptNote({
    attempt_id: brine1.body.attempt_id,
    note: 'checked valve',
    user,
  });
  assert(noteC.ok, 'C note on failed brine');

  const brine2 = await phase2.startBrineFill(machine, {
    tank_id: tankC.id,
    brine_expected_amount: 100,
    user,
  });
  assert(Number(brine2.body.attempt_id) !== Number(brine1.body.attempt_id), 'C new brine attempt');
  const brinePass = await phase2.stopBrineFill(machine, {
    attempt_id: brine2.body.attempt_id,
    brine_actual_amount: 100,
    result: 'PASS',
    user,
  });
  assert(brinePass.ok && brinePass.body.tank.status === 'ready_for_dome_install', 'C brine pass completes');
  const attemptsC = await phase2.listTestAttemptsForTank(tankC.id);
  assert(
    attemptsC.filter((a) => a.test_type === 'BRINE' && a.result === 'FAIL').length >= 1 &&
      attemptsC.filter((a) => a.test_type === 'BRINE' && a.result === 'PASS').length >= 1,
    'C brine FAIL+PASS history'
  );
  const brineFailRow = await pool.query(`SELECT result, failure_note, brine_actual_amount FROM test_attempts WHERE id=$1`, [
    brine1.body.attempt_id,
  ]);
  assert(
    brineFailRow.rows[0].result === 'FAIL' &&
      brineFailRow.rows[0].failure_note === 'underfill C' &&
      Number(brineFailRow.rows[0].brine_actual_amount) === 50,
    'C fail brine immutable'
  );

  // Legacy recordTestResult FAIL must NOT go to FAB rework_required
  const tankL = await makeTank('L');
  await phase2.startQa(machine, { tank_id: tankL.id, user });
  await phase2.recordQaResult(machine, { tank_id: tankL.id, result: 'PASS', user });
  const legacy = await phase2.recordTestResult(machine, {
    tank_id: tankL.id,
    result: 'FAIL',
    note: 'legacy path',
    user,
  });
  assert(legacy.ok && legacy.body.tank.status === 'ready_for_testing', 'legacy FAIL stays in testing pipeline');
  assert(legacy.body.tank.status !== 'rework_required', 'legacy must not FAB rework');

  console.log('PASS QA/Vacuum/Brine fail-retest UX regression');
  console.log(
    JSON.stringify(
      {
        machineId: machine.id,
        tankA: tankA.tank_number,
        tankB: tankB.tank_number,
        tankC: tankC.tank_number,
        tankD: tankD.tank_number,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('FAIL', err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
