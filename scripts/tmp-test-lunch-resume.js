'use strict';
/**
 * Reproduce Lunch → Resume without rescanning team (multi-team isolation + Employee Out).
 */
require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');

  const phase2 = createPhase2AssemblyTesting(pool, {
    localDateString: () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
  });

  const suffix = String(Date.now()).slice(-6);
  const client = await pool.connect();
  let machineId;
  let teamA;
  let teamB;
  let empA1;
  let empA2;
  let empB1;
  let tankA;
  let tankB;
  try {
    await client.query('BEGIN');
    const m = await client.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
       VALUES ($1,$2,$3,$4,9992,1,'assembly_testing',NOW(),NOW()) RETURNING id`,
      [`ASM Lunch ${suffix}`, `ASM-L-${suffix}`, `ASM-LB-${suffix}`, `asm-lunch-${suffix}`]
    );
    machineId = Number(m.rows[0].id);

    const ta = await client.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at) VALUES ($1,$2,1,NOW(),NOW()) RETURNING id, name, barcode`,
      [`TeamA-${suffix}`, `TA-${suffix}`]
    );
    const tb = await client.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at) VALUES ($1,$2,1,NOW(),NOW()) RETURNING id, name, barcode`,
      [`TeamB-${suffix}`, `TB-${suffix}`]
    );
    teamA = ta.rows[0];
    teamB = tb.rows[0];

    const e1 = await client.query(
      `INSERT INTO employees (code, name, is_active, created_at, updated_at) VALUES ($1,$2,1,NOW(),NOW()) RETURNING id, code, name`,
      [`A1-${suffix}`, `A1 Emp ${suffix}`]
    );
    const e2 = await client.query(
      `INSERT INTO employees (code, name, is_active, created_at, updated_at) VALUES ($1,$2,1,NOW(),NOW()) RETURNING id, code, name`,
      [`A2-${suffix}`, `A2 Emp ${suffix}`]
    );
    const e3 = await client.query(
      `INSERT INTO employees (code, name, is_active, created_at, updated_at) VALUES ($1,$2,1,NOW(),NOW()) RETURNING id, code, name`,
      [`B1-${suffix}`, `B1 Emp ${suffix}`]
    );
    empA1 = e1.rows[0];
    empA2 = e2.rows[0];
    empB1 = e3.rows[0];

    await client.query(
      `INSERT INTO employee_team_memberships (employee_id, team_id, joined_at, created_at)
       VALUES ($1,$2,NOW(),NOW()), ($3,$2,NOW(),NOW()), ($4,$5,NOW(),NOW())`,
      [empA1.id, teamA.id, empA2.id, empB1.id, teamB.id]
    );

    const tka = await client.query(
      `INSERT INTO tanks (tank_number, status, fab_completed_at, requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_assembly',NOW(),TRUE,NOW(),NOW()) RETURNING id`,
      [`2026-A-${suffix}`]
    );
    const tkb = await client.query(
      `INSERT INTO tanks (tank_number, status, fab_completed_at, requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_assembly',NOW(),TRUE,NOW(),NOW()) RETURNING id`,
      [`2026-B-${suffix}`]
    );
    tankA = Number(tka.rows[0].id);
    tankB = Number(tkb.rows[0].id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const machine = { id: machineId };

  assert((await phase2.assignTeamToMachine(machineId, teamA)).ok, 'assign A');
  assert((await phase2.assignTeamToMachine(machineId, teamB)).ok, 'assign B');

  assert((await phase2.confirmTank(machine, { tank_id: tankA, team_id: Number(teamA.id) })).ok, 'confirm A');
  assert((await phase2.confirmTank(machine, { tank_id: tankB, team_id: Number(teamB.id) })).ok, 'confirm B');

  const startA = await phase2.startWork(machine, {
    tank_id: tankA,
    team_id: Number(teamA.id),
    stage: 'ASSEMBLY',
    employees: [empA1, empA2],
  });
  assert(startA.ok, startA.body && startA.body.message);

  const startB = await phase2.startWork(machine, {
    tank_id: tankB,
    team_id: Number(teamB.id),
    stage: 'ASSEMBLY',
    employees: [empB1],
  });
  assert(startB.ok, startB.body && startB.body.message);

  // Employee Out A2 from stage + membership (simulate kiosk employee-out path partially)
  const outStage = await phase2.employeeOutFromStage(machine, { employee_id: Number(empA2.id) });
  assert(outStage.ok, outStage.body && outStage.body.message);
  await pool.query(
    `UPDATE employee_team_memberships
     SET left_at = NOW(), reason = 'test employee out'
     WHERE employee_id = $1 AND team_id = $2 AND left_at IS NULL`,
    [empA2.id, teamA.id]
  );

  // Team A lunch — Team B must stay active
  const lunchA = await phase2.pauseStationLabor(machine, 'LUNCH', { team_id: Number(teamA.id) });
  assert(lunchA.ok, lunchA.body && lunchA.body.message);
  console.log('lunchA', JSON.stringify(lunchA.body, null, 2));

  const activeAfterLunch = await phase2.getActiveSessionsForMachine(machineId);
  assert(
    activeAfterLunch.length === 1 && Number(activeAfterLunch[0].team_id) === Number(teamB.id),
    `expected only Team B active after A lunch, got ${JSON.stringify(activeAfterLunch.map((s) => s.team_id))}`
  );

  const cardsAfterLunch = await phase2.listAssemblyKioskTeams(machineId);
  const cardA = cardsAfterLunch.find((c) => Number(c.team_id) === Number(teamA.id));
  assert(cardA && cardA.on_lunch, 'Team A card should be on lunch');
  assert(cardsAfterLunch.find((c) => Number(c.team_id) === Number(teamB.id)), 'Team B still present');

  // Resume Team A WITHOUT rescanning — pass explicit team_id only
  const resumeA = await phase2.resumeStationLabor(machine, { team_id: Number(teamA.id) });
  console.log('resumeA', JSON.stringify(resumeA, null, 2));
  assert(resumeA.ok, resumeA.body && resumeA.body.message);

  const resumed = (resumeA.body && resumeA.body.resumed_sessions) || [];
  assert(resumed.length === 1, 'expected 1 resumed session for Team A');
  const openIds = (resumed[0].participants || [])
    .filter((p) => p.open || p.left_at == null)
    .map((p) => Number(p.employee_id))
    .sort();
  assert(openIds.includes(Number(empA1.id)), 'Employee A1 should resume');
  assert(!openIds.includes(Number(empA2.id)), 'Employee A2 (Employee Out) must NOT resume');

  const activeAfterResume = await phase2.getActiveSessionsForMachine(machineId);
  assert(activeAfterResume.length === 2, `expected 2 active sessions, got ${activeAfterResume.length}`);
  assert(
    activeAfterResume.some((s) => Number(s.team_id) === Number(teamA.id)),
    'Team A session missing after resume'
  );
  assert(
    activeAfterResume.some((s) => Number(s.team_id) === Number(teamB.id)),
    'Team B must remain active while A resumes'
  );

  // STOP then LUNCH then RESUME (notes were null historically) — Team B
  assert((await phase2.stopWork(machine, { tank_id: tankB })).ok, 'stop B');
  assert((await phase2.pauseStationLabor(machine, 'LUNCH', { team_id: Number(teamB.id) })).ok, 'lunch B after stop');
  const { rows: tagged } = await pool.query(
    `SELECT id, notes FROM stage_labor_sessions
     WHERE machine_id = $1 AND team_id = $2 AND status = 'stopped'
     ORDER BY ended_at DESC NULLS LAST LIMIT 1`,
    [machineId, teamB.id]
  );
  assert(tagged.length && String(tagged[0].notes).toUpperCase() === 'LUNCH', 'stop+lunch must tag LUNCH notes');
  assert((await phase2.resumeStationLabor(machine, { team_id: Number(teamB.id) })).ok, 'resume B after stop+lunch');

  // Team B lunch then resume isolation while A working
  assert((await phase2.pauseStationLabor(machine, 'LUNCH', { team_id: Number(teamB.id) })).ok, 'lunch B again');
  const onlyA = await phase2.getActiveSessionsForMachine(machineId);
  assert(onlyA.length === 1 && Number(onlyA[0].team_id) === Number(teamA.id), 'only A active during B lunch');
  assert((await phase2.resumeStationLabor(machine, { team_id: Number(teamB.id) })).ok, 'resume B again');
  assert((await phase2.getActiveSessionsForMachine(machineId)).length === 2, 'both active again');

  // Resume without team_id must fail (no assigned_team_id fallback)
  const bad = await phase2.resumeStationLabor(machine, {});
  assert(!bad.ok && bad.body && bad.body.error === 'team_required', 'resume requires team_id');

  console.log('PASS lunch/resume multi-team + employee-out protection');
}

main()
  .catch((e) => {
    console.error('FAIL', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
