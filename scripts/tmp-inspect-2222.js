'use strict';

/** Read-only: current state of tank 2222 and all removed_from_assembly tanks (local DB only). */
require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');
  const t = await pool.query(
    `SELECT id, tank_number, status, deleted_at, completed_at, fab_completed_at, assembly_started_at,
            assembly_completed_at, assembly_machine_id, assembly_team_id, assembly_removed_at,
            assembly_restored_at, requires_test, qa_started_at, testing_started_at
     FROM tanks WHERE tank_number = '2222' OR LOWER(TRIM(status)) = 'removed_from_assembly'
     ORDER BY id`
  );
  console.log(JSON.stringify(t.rows, null, 2));
  for (const row of t.rows) {
    const s = await pool.query(
      `SELECT id, machine_id, stage, status, started_at, ended_at FROM stage_labor_sessions WHERE tank_id = $1 ORDER BY id`,
      [row.id]
    );
    const a = await pool.query(
      `SELECT id, action, performed_at, previous_status, next_status FROM tank_admin_phase2_audit WHERE tank_id = $1 ORDER BY id`,
      [row.id]
    );
    console.log(`tank ${row.tank_number} (#${row.id}) sessions:`, JSON.stringify(s.rows));
    console.log(`tank ${row.tank_number} (#${row.id}) phase2 audit:`, JSON.stringify(a.rows));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
