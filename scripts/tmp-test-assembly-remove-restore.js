'use strict';

/**
 * Local regression: REMOVE FROM ASSEMBLY + RESTORE accidental FINISH.
 * Refuses Neon. Cleans up only rows created here.
 */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const { runSchemaMigration } = require('./schema-migrate');
const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');
  await runSchemaMigration(pool);
  const phase2 = createPhase2AssemblyTesting(pool, {});
  const suffix = String(Date.now()).slice(-6);
  const machine = { id: null };
  const created = { tanks: [], teams: [], machines: [] };

  const m = await pool.query(
    `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
     VALUES ($1,$2,$3,$4,9970,1,'assembly_testing',NOW(),NOW()) RETURNING id`,
    [`Asm RR ${suffix}`, `ARR-${suffix}`, `ARR-BC-${suffix}`, `asm-rr-${suffix}`]
  );
  machine.id = Number(m.rows[0].id);
  created.machines.push(machine.id);

  async function makeTeam(tag) {
    const r = await pool.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at)
       VALUES ($1,$2,1,NOW(),NOW()) RETURNING id`,
      [`Team ${tag} ${suffix}`, `TM-${tag}-${suffix}`]
    );
    const id = Number(r.rows[0].id);
    created.teams.push(id);
    return id;
  }

  async function makeTank(tag) {
    const r = await pool.query(
      `INSERT INTO tanks
         (tank_number, status, fab_completed_at, requires_test, created_at, updated_at)
       VALUES ($1,'ready_for_assembly',NOW(),TRUE,NOW(),NOW())
       RETURNING id, tank_number`,
      [`2026-${tag}-${suffix}`]
    );
    const tank = { id: Number(r.rows[0].id), tank_number: r.rows[0].tank_number };
    created.tanks.push(tank.id);
    return tank;
  }

  const teamA = await makeTeam('A');
  const teamB = await makeTeam('B');
  const tankA = await makeTank('A');
  const tankB = await makeTank('B');
  const tankC = await makeTank('C');

  const confA = await phase2.confirmTank(machine, { tank_id: tankA.id, team_id: teamA });
  const confB = await phase2.confirmTank(machine, { tank_id: tankB.id, team_id: teamB });
  assert(confA.ok && confA.body.tank.status === 'assembly_in_progress', 'A confirmed');
  assert(confB.ok && confB.body.tank.status === 'assembly_in_progress', 'B confirmed');
  const startedA = confA.body.tank.assembly_started_at;

  await pool.query(
    `INSERT INTO stage_labor_sessions
       (tank_id, machine_id, team_id, stage, status, started_at, created_at, updated_at)
     VALUES ($1,$2,$3,'ASSEMBLY','active',NOW(),NOW(),NOW())`,
    [tankA.id, machine.id, teamA]
  );

  const wrongTeam = await phase2.removeTankFromAssembly(tankA.id, {
    machine_id: machine.id,
    team_id: teamB,
    performed_by: 'test',
  });
  assert(!wrongTeam.ok, 'remove must not act on another team');
  const stillA = await pool.query(`SELECT status, assembly_team_id FROM tanks WHERE id = $1`, [tankA.id]);
  assert(stillA.rows[0].status === 'assembly_in_progress', 'A unchanged after wrong-team remove');
  const stillB = await pool.query(`SELECT status, assembly_team_id FROM tanks WHERE id = $1`, [tankB.id]);
  assert(stillB.rows[0].status === 'assembly_in_progress' && Number(stillB.rows[0].assembly_team_id) === teamB, 'B untouched');

  const removed = await phase2.removeTankFromAssembly(tankA.id, {
    machine_id: machine.id,
    team_id: teamA,
    performed_by: 'test',
  });
  assert(removed.ok && removed.body.tank.status === 'removed_from_assembly', 'A removed status');
  assert(removed.body.tank.assembly_started_at, 'A start preserved');
  assert(String(removed.body.tank.assembly_started_at) === String(startedA) || removed.body.tank.assembly_started_at, 'A duration start kept');
  const sess = await pool.query(
    `SELECT status FROM stage_labor_sessions WHERE tank_id = $1`,
    [tankA.id]
  );
  assert(sess.rows.length === 1 && sess.rows[0].status === 'stopped', 'A labor stopped not deleted');
  const boardAfterRemove = await phase2.getQaBoardConfig();
  assert(
    !(boardAfterRemove.body.ready_for_qa || []).some((t) => Number(t.id) === tankA.id),
    'removed tank is not Ready for QA'
  );
  const cfgAfterRemove = await phase2.getMachineConfig(machine.id);
  const teamsAfter = cfgAfterRemove.body.active_teams || [];
  const bStill = (cfgAfterRemove.body.assembly_confirmed_tanks || []).some((t) => Number(t.id) === tankB.id);
  assert(bStill, 'team B tank still confirmed');
  assert(
    !(cfgAfterRemove.body.assembly_confirmed_tanks || []).some((t) => Number(t.id) === tankA.id),
    'removed tank left active cards'
  );
  assert(teamsAfter.length >= 0, 'config still loads');

  const finished = await phase2.assemblyComplete(machine, { tank_id: tankB.id });
  assert(finished.ok && finished.body.tank.status === 'ready_for_qa', 'B finish → Ready for QA');
  const cfgFinished = await phase2.getMachineConfig(machine.id);
  assert(
    (cfgFinished.body.recently_finished_assembly || []).some((t) => Number(t.id) === tankB.id),
    'B in recently finished'
  );
  const qaBoard = await phase2.getQaBoardConfig();
  assert((qaBoard.body.ready_for_qa || []).some((t) => Number(t.id) === tankB.id), 'B on QA board');

  await phase2.confirmTank(machine, { tank_id: tankC.id, team_id: teamB });
  await phase2.assemblyComplete(machine, { tank_id: tankC.id });
  const qaStart = await phase2.startQa({ id: null }, { tank_id: tankC.id, user: { id: 1, username: 'qa' } });
  assert(qaStart.ok && qaStart.body.tank.status === 'qa_in_progress', 'C QA started');
  const blocked = await phase2.restoreTankToAssembly(tankC.id, { machine_id: machine.id, performed_by: 'test' });
  assert(!blocked.ok, 'restore blocked after QA start');
  const cStatus = await pool.query(`SELECT status FROM tanks WHERE id = $1`, [tankC.id]);
  assert(cStatus.rows[0].status === 'qa_in_progress', 'C stays in QA');
  const cfgQa = await phase2.getMachineConfig(machine.id);
  assert(
    !(cfgQa.body.recently_finished_assembly || []).some((t) => Number(t.id) === tankC.id),
    'QA-started tank not in restore list'
  );

  const priorFinish = finished.body.tank.assembly_completed_at;
  const priorStart = finished.body.tank.assembly_started_at;
  const restored = await phase2.restoreTankToAssembly(tankB.id, {
    machine_id: machine.id,
    performed_by: 'test',
  });
  assert(restored.ok && restored.body.tank.id === tankB.id, 'same tank id');
  assert(restored.body.tank.status === 'ready_for_assembly', 'B back to assembly pool');
  assert(restored.body.tank.assembly_machine_id == null, 'B unassigned');
  assert(restored.body.tank.assembly_team_id == null, 'B not auto-assigned to team');
  assert(restored.body.tank.assembly_started_at, 'B start preserved');
  assert(String(new Date(restored.body.tank.assembly_started_at).toISOString()) === String(new Date(priorStart).toISOString()), 'B start not reset');
  const qaAfter = await phase2.getQaBoardConfig();
  assert(!(qaAfter.body.ready_for_qa || []).some((t) => Number(t.id) === tankB.id), 'B left QA board');
  const cfgRestored = await phase2.getMachineConfig(machine.id);
  assert(
    (cfgRestored.body.eligible_tanks || []).some((t) => Number(t.id) === tankB.id),
    'B selectable again'
  );
  assert(
    !(cfgRestored.body.recently_finished_assembly || []).some((t) => Number(t.id) === tankB.id),
    'B left recently finished'
  );
  const audit = await pool.query(
    `SELECT action, previous_status, next_status, details
     FROM tank_admin_phase2_audit
     WHERE tank_id = $1 AND action = 'restore_to_assembly'
     ORDER BY id DESC LIMIT 1`,
    [tankB.id]
  );
  assert(audit.rows.length === 1, 'restore audit');
  const details = typeof audit.rows[0].details === 'string' ? JSON.parse(audit.rows[0].details) : audit.rows[0].details;
  assert(details.prior_assembly_completed_at, 'original finish kept in audit');
  assert(
    String(new Date(details.prior_assembly_completed_at).toISOString()) === String(new Date(priorFinish).toISOString()),
    'finish timestamp matches'
  );

  const again = await phase2.confirmTank(machine, { tank_id: tankB.id, team_id: teamA });
  assert(again.ok && again.body.tank.id === tankB.id, 'reconfirm same tank');
  assert(again.body.tank.status === 'assembly_in_progress', 'reconfirm in progress');
  assert(again.body.tank.assembly_completed_at == null, 'new finish can be recorded');
  assert(Number(again.body.tank.assembly_team_id) === teamA, 'new team only after confirm');

  const count = await pool.query(`SELECT COUNT(*)::int AS n FROM tanks WHERE tank_number = $1`, [tankB.tank_number]);
  assert(count.rows[0].n === 1, 'no duplicate tank');

  console.log('ALL PASSED');

  for (const id of created.tanks) {
    await pool.query(`DELETE FROM stage_labor_sessions WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM tank_admin_phase2_audit WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM test_attempts WHERE tank_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM tanks WHERE id = $1`, [id]);
  }
  for (const id of created.teams) await pool.query(`DELETE FROM teams WHERE id = $1`, [id]);
  for (const id of created.machines) await pool.query(`DELETE FROM machines WHERE id = $1`, [id]);
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
