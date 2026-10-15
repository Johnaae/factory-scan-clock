'use strict';

/**
 * Local Phase 2 regression smoke (multi-team Assembly + QA/Vacuum/Brine).
 * Uses DATABASE_URL from environment — must be localhost.
 */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) {
    throw new Error('Refusing to run against Neon. Set local DATABASE_URL.');
  }

  const phase2 = createPhase2AssemblyTesting(pool, {});
  const ts = Date.now();
  const suffix = String(ts).slice(-6);

  const client = await pool.connect();
  let machineId;
  let team1Id;
  let team2Id;
  let emp1Id;
  let emp2Id;
  let tankAId;
  let tankBId;
  try {
    await client.query('BEGIN');

    const m = await client.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
       VALUES ($1,$2,$3,$4,9990,1,'assembly_testing',NOW(),NOW()) RETURNING id`,
      [`ASM Test ${suffix}`, `ASM-T-${suffix}`, `ASM-BC-${suffix}`, `asm-test-${suffix}`]
    );
    machineId = Number(m.rows[0].id);

    const t1 = await client.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at)
       VALUES ($1,$2,1,NOW(),NOW()) RETURNING id`,
      [`Team1-${suffix}`, `T1-${suffix}`]
    );
    const t2 = await client.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at)
       VALUES ($1,$2,1,NOW(),NOW()) RETURNING id`,
      [`Team2-${suffix}`, `T2-${suffix}`]
    );
    team1Id = Number(t1.rows[0].id);
    team2Id = Number(t2.rows[0].id);

    const e1 = await client.query(
      `INSERT INTO employees (code, name, is_active, created_at, updated_at)
       VALUES ($1,$2,1,NOW(),NOW()) RETURNING id`,
      [`E1-${suffix}`, `Emp One ${suffix}`]
    );
    const e2 = await client.query(
      `INSERT INTO employees (code, name, is_active, created_at, updated_at)
       VALUES ($1,$2,1,NOW(),NOW()) RETURNING id`,
      [`E2-${suffix}`, `Emp Two ${suffix}`]
    );
    emp1Id = Number(e1.rows[0].id);
    emp2Id = Number(e2.rows[0].id);

    await client.query(
      `INSERT INTO employee_team_memberships (employee_id, team_id, joined_at, created_at)
       VALUES ($1,$2,NOW(),NOW()), ($3,$4,NOW(),NOW())`,
      [emp1Id, team1Id, emp2Id, team2Id]
    );

    const ta = await client.query(
      `INSERT INTO tanks (tank_number, status, fab_completed_at, requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_assembly',NOW(),TRUE,NOW(),NOW()) RETURNING id`,
      [`2026-A-${suffix}`]
    );
    const tb = await client.query(
      `INSERT INTO tanks (tank_number, status, fab_completed_at, requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_assembly',NOW(),TRUE,NOW(),NOW()) RETURNING id`,
      [`2026-B-${suffix}`]
    );
    tankAId = Number(ta.rows[0].id);
    tankBId = Number(tb.rows[0].id);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    throw err;
  }
  client.release();

  const machine = { id: machineId };

  // Multi-team presence
  const a1 = await phase2.assignTeamToMachine(machineId, { id: team1Id, name: `Team1-${suffix}` });
  assert(a1.ok, 'team1 assign failed');
  const a2 = await phase2.assignTeamToMachine(machineId, { id: team2Id, name: `Team2-${suffix}` });
  assert(a2.ok, 'team2 assign failed');
  const teams = await phase2.listAssemblyKioskTeams(machineId);
  assert(teams.length === 2, `expected 2 team cards, got ${teams.length}`);
  const a1b = await phase2.assignTeamToMachine(machineId, { id: team1Id, name: `Team1-${suffix}` });
  assert(a1b.ok && (a1b.body.already_present || a1b.body.action === 'assign_team'), 'same team should not duplicate');
  const teams2 = await phase2.listAssemblyKioskTeams(machineId);
  assert(teams2.length === 2, 'same team scan duplicated card');

  // Confirm + start independent tanks
  const c1 = await phase2.confirmTank(machine, { tank_id: tankAId, team_id: team1Id });
  assert(c1.ok, c1.body && c1.body.message);
  const c2 = await phase2.confirmTank(machine, { tank_id: tankBId, team_id: team2Id });
  assert(c2.ok, c2.body && c2.body.message);

  const s1 = await phase2.startWork(machine, {
    tank_id: tankAId,
    team_id: team1Id,
    stage: 'ASSEMBLY',
    employees: [{ id: emp1Id, name: `Emp One ${suffix}`, code: `E1-${suffix}` }],
  });
  assert(s1.ok, s1.body && s1.body.message);
  const s2 = await phase2.startWork(machine, {
    tank_id: tankBId,
    team_id: team2Id,
    stage: 'ASSEMBLY',
    employees: [{ id: emp2Id, name: `Emp Two ${suffix}`, code: `E2-${suffix}` }],
  });
  assert(s2.ok, s2.body && s2.body.message);

  // Team1 lunch must not stop Team2
  const lunch = await phase2.pauseStationLabor(machine, 'LUNCH', { team_id: team1Id });
  assert(lunch.ok, 'lunch failed');
  const activeAfterLunch = await phase2.getActiveSessionsForMachine(machineId);
  assert(
    activeAfterLunch.length === 1 && Number(activeAfterLunch[0].team_id) === team2Id,
    'team2 should still be active after team1 lunch'
  );

  const resume = await phase2.resumeStationLabor(machine, { team_id: team1Id });
  assert(resume.ok, resume.body && resume.body.message);
  const activeAfterResume = await phase2.getActiveSessionsForMachine(machineId);
  assert(activeAfterResume.length === 2, 'both teams should be active after resume');

  // Finish Team1 → Ready for QA
  const fin = await phase2.assemblyComplete(machine, { tank_id: tankAId });
  assert(fin.ok, fin.body && fin.body.message);
  assert(String(fin.body.tank.status) === 'ready_for_qa', `expected ready_for_qa got ${fin.body.tank.status}`);

  // Restore to Assembly
  const restore = await phase2.restoreTankToAssembly(tankAId, {
    reason: 'accidental finish test',
    performed_by: 'test',
  });
  assert(restore.ok, restore.body && restore.body.message);
  assert(String(restore.body.tank.status) === 'assembly_in_progress', 'restore status');

  // Finish again → QA
  await phase2.startWork(machine, {
    tank_id: tankAId,
    team_id: team1Id,
    stage: 'ASSEMBLY',
    employees: [{ id: emp1Id, name: `Emp One ${suffix}`, code: `E1-${suffix}` }],
  });
  const fin2 = await phase2.assemblyComplete(machine, { tank_id: tankAId });
  assert(fin2.ok && String(fin2.body.tank.status) === 'ready_for_qa', 'finish to QA');

  // Dedicated QA/QC machine row (third workflow)
  const qaMach = await pool.query(
    `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
     VALUES ($1,$2,$3,$4,9991,1,'qa_testing',NOW(),NOW()) RETURNING id, workflow, kiosk_slug`,
    [`QA/QC Kiosk ${suffix}`, `QA-T-${suffix}`, `QA-BC-${suffix}`, `qa-qc-kiosk-${suffix}`]
  );
  assert(String(qaMach.rows[0].workflow) === 'qa_testing', 'qa_testing workflow stored');
  const qaMachine = { id: Number(qaMach.rows[0].id) };

  // START QA → FAIL (history) → RESTART → PASS
  const startQa = await phase2.startQa(qaMachine, {
    tank_id: tankAId,
    user: { id: 1, username: 'qa_qc' },
  });
  assert(startQa.ok && String(startQa.body.tank.status) === 'qa_in_progress', 'start qa');

  const qaFail = await phase2.recordQaResult(qaMachine, {
    tank_id: tankAId,
    result: 'FAIL',
    note: 'weld porosity',
    user: { id: 1, username: 'qa_qc' },
  });
  assert(qaFail.ok && String(qaFail.body.tank.status) === 'qa_failed', 'qa fail status');

  const boardAfterFail = await phase2.getQaBoardConfig();
  assert(boardAfterFail.ok, 'qa board');
  assert(
    (boardAfterFail.body.qa_failed || []).some((t) => Number(t.id) === tankAId),
    'failed tank on QA board'
  );
  assert(
    !(boardAfterFail.body.ready_for_testing || []).some((t) => Number(t.id) === tankAId),
    'failed tank must not be Ready for Testing'
  );

  const startQa2 = await phase2.startQa(qaMachine, {
    tank_id: tankAId,
    user: { id: 1, username: 'qa_qc' },
  });
  assert(startQa2.ok && String(startQa2.body.tank.status) === 'qa_in_progress', 'restart qa after fail');

  const qaPass = await phase2.recordQaResult(qaMachine, {
    tank_id: tankAId,
    result: 'PASS',
    user: { id: 1, username: 'qa_qc' },
  });
  assert(qaPass.ok && String(qaPass.body.tank.status) === 'ready_for_testing', 'qa pass');

  const qaAttemptsBeforeVac = await phase2.listTestAttemptsForTank(tankAId);
  const qaFails = qaAttemptsBeforeVac.filter((a) => a.test_type === 'QA' && a.result === 'FAIL');
  const qaPasses = qaAttemptsBeforeVac.filter((a) => a.test_type === 'QA' && a.result === 'PASS');
  assert(qaFails.length >= 1 && qaPasses.length >= 1, 'QA fail+pass history preserved');

  // Vacuum start/complete fail preserves attempt then retest
  const vac = await phase2.startVacuumTest(qaMachine, {
    tank_id: tankAId,
    vacuum_start_inhg: 29.5,
    user: { id: 1, username: 'qa_qc' },
  });
  assert(vac.ok, vac.body && vac.body.message);
  const vacFail = await phase2.completeVacuumTest(qaMachine, {
    attempt_id: vac.body.attempt_id,
    vacuum_end_inhg: 20,
    result: 'FAIL',
    note: 'leak',
    user: { id: 1, username: 'qa_qc' },
  });
  assert(vacFail.ok, vacFail.body && vacFail.body.message);
  const note = await phase2.appendTestAttemptNote({
    attempt_id: vac.body.attempt_id,
    note: 'follow-up note',
    user: { id: 1, username: 'qa_qc' },
  });
  assert(note.ok, 'note append failed');

  const vac2 = await phase2.startVacuumTest(qaMachine, {
    tank_id: tankAId,
    vacuum_start_inhg: 29.9,
    user: { id: 1, username: 'qa_qc' },
  });
  assert(vac2.ok, 'retest start');
  assert(Number(vac2.body.attempt_id) !== Number(vac.body.attempt_id), 'retest must new attempt');
  const vacPass = await phase2.completeVacuumTest(qaMachine, {
    attempt_id: vac2.body.attempt_id,
    vacuum_end_inhg: 29.8,
    result: 'PASS',
    user: { id: 1, username: 'qa_qc' },
  });
  assert(vacPass.ok, vacPass.body && vacPass.body.message);

  // Separate Brine path on tank B (finish assembly first)
  await phase2.startWork(machine, {
    tank_id: tankBId,
    team_id: team2Id,
    stage: 'ASSEMBLY',
    employees: [{ id: emp2Id, name: `Emp Two ${suffix}`, code: `E2-${suffix}` }],
  });
  const finB = await phase2.assemblyComplete(machine, { tank_id: tankBId });
  assert(finB.ok && String(finB.body.tank.status) === 'ready_for_qa', 'tank B ready for QA');
  await phase2.startQa(qaMachine, { tank_id: tankBId, user: { id: 1, username: 'qa_qc' } });
  const qaB = await phase2.recordQaResult(qaMachine, {
    tank_id: tankBId,
    result: 'PASS',
    user: { id: 1, username: 'qa_qc' },
  });
  assert(qaB.ok && String(qaB.body.tank.status) === 'ready_for_testing', 'tank B ready for testing');
  const brineStart = await phase2.startBrineFill(qaMachine, {
    tank_id: tankBId,
    brine_expected_amount: 100,
    user: { id: 1, username: 'qa_qc' },
  });
  assert(brineStart.ok, brineStart.body && brineStart.body.message);
  const brineStop = await phase2.stopBrineFill(qaMachine, {
    attempt_id: brineStart.body.attempt_id,
    brine_actual_amount: 98.5,
    result: 'PASS',
    user: { id: 1, username: 'qa_qc' },
  });
  assert(brineStop.ok, brineStop.body && brineStop.body.message);

  const attempts = await phase2.listTestAttemptsForTank(tankAId);
  assert(attempts.length >= 4, `expected QA fail+pass + 2 vacuum attempts, got ${attempts.length}`);
  const failed = attempts.find((a) => a.test_type === 'VACUUM' && a.result === 'FAIL');
  assert(failed && failed.notes && failed.notes.length, 'failed attempt notes preserved');

  // Labor should not include QA/testing as production: compute stage labor
  const labor = await phase2.computeStageLaborForTank(tankAId);
  assert(labor && typeof labor.total_ms === 'number', 'labor summary');

  console.log('PASS phase2 multi-team + QA/QC kiosk workflow + Vacuum/Brine local smoke');
  console.log(
    JSON.stringify({
      machineId,
      qaMachineId: qaMachine.id,
      qaKioskSlug: qaMach.rows[0].kiosk_slug,
      team1Id,
      team2Id,
      tankAId,
      tankBId,
      attempts: attempts.length,
      labor_ms: labor.total_ms,
    })
  );
}

main()
  .catch((err) => {
    console.error('FAIL', err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
