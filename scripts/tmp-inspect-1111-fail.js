'use strict';
require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');

  const tank = await pool.query(
    `SELECT id, tank_number, status, requires_test,
            assembly_completed_at, qa_started_at, qa_completed_at, qa_result, qa_failure_note,
            testing_started_at, testing_completed_at, completed_at, updated_at
     FROM tanks
     WHERE tank_number = '1111' OR tank_number ILIKE '%1111%'
     ORDER BY id DESC
     LIMIT 5`
  );
  console.log('TANKS', JSON.stringify(tank.rows, null, 2));

  for (const t of tank.rows) {
    const attempts = await pool.query(
      `SELECT id, test_type, result, attempt_status, failure_note, previous_status,
              vacuum_start_inhg, vacuum_end_inhg, brine_expected_amount, brine_actual_amount,
              started_at, completed_at, attempted_at, tester_user_name, created_at
       FROM test_attempts
       WHERE tank_id = $1
       ORDER BY id ASC`,
      [t.id]
    );
    console.log(`ATTEMPTS tank ${t.tank_number} id=${t.id}`, JSON.stringify(attempts.rows, null, 2));

    const notes = await pool.query(
      `SELECT n.id, n.attempt_id, n.body, n.created_at, n.author_user_name
       FROM test_attempt_notes n
       JOIN test_attempts a ON a.id = n.attempt_id
       WHERE a.tank_id = $1
       ORDER BY n.id ASC`,
      [t.id]
    );
    console.log(`NOTES tank ${t.tank_number}`, JSON.stringify(notes.rows, null, 2));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
