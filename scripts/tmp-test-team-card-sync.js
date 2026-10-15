'use strict';
/**
 * Regression: legacy assignment without assembly_kiosk_teams must still yield Team Cards.
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
    throw new Error('Refusing Neon');
  }
  const phase2 = createPhase2AssemblyTesting(pool, {
    localDateString: () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
  });

  const suffix = String(Date.now()).slice(-6);
  const client = await pool.connect();
  let machineId;
  let teamId;
  try {
    await client.query('BEGIN');
    const m = await client.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
       VALUES ($1,$2,$3,$4,9991,1,'assembly_testing',NOW(),NOW()) RETURNING id`,
      [`ASM Sync ${suffix}`, `ASM-S-${suffix}`, `ASM-SB-${suffix}`, `asm-sync-${suffix}`]
    );
    machineId = Number(m.rows[0].id);
    const t = await client.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at)
       VALUES ($1,$2,1,NOW(),NOW()) RETURNING id`,
      [`SyncTeam-${suffix}`, `ST-${suffix}`]
    );
    teamId = Number(t.rows[0].id);
    const today = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    // Legacy-only assignment (no assembly_kiosk_teams row) — the bug state.
    await client.query(
      `UPDATE machines
       SET assigned_team_id = $1, assigned_team_day = $2, assigned_team_at = NOW()
       WHERE id = $3`,
      [teamId, today, machineId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const before = await phase2.listAssemblyKioskTeams(machineId);
  assert(before.length === 0, 'expected no presence rows before sync');

  const cfg = await phase2.getMachineConfig(machineId);
  assert(cfg.ok, 'config failed');
  const teams = cfg.body.active_teams || [];
  assert(teams.length === 1, `expected 1 active team after sync, got ${teams.length}`);
  assert(Number(teams[0].team_id) === teamId, 'wrong team synced');

  const after = await phase2.listAssemblyKioskTeams(machineId);
  assert(after.length === 1, 'presence row not persisted');

  // Second team scan must add, not replace.
  const t2 = await pool.query(
    `INSERT INTO teams (name, barcode, active, created_at, updated_at)
     VALUES ($1,$2,1,NOW(),NOW()) RETURNING id, name, barcode`,
    [`SyncTeam2-${suffix}`, `ST2-${suffix}`]
  );
  const team2 = t2.rows[0];
  const assign2 = await phase2.assignTeamToMachine(machineId, team2);
  assert(assign2.ok, 'team2 assign failed');
  assert((assign2.body.active_teams || []).length === 2, 'expected 2 team cards');

  const cfg2 = await phase2.getMachineConfig(machineId);
  assert((cfg2.body.active_teams || []).length === 2, 'config must keep both teams');

  console.log('PASS team-card presence sync + multi-team');
}

main()
  .catch((e) => {
    console.error('FAIL', e && e.message ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
