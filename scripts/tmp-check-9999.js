'use strict';
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');

async function main() {
  const pool = new Pool(createPoolOptions());
  try {
    const { rows } = await pool.query(
      `SELECT id, tank_number, status, requires_test, testing_machine_id, testing_confirmed_at
       FROM tanks WHERE tank_number = $1`,
      ['9999']
    );
    console.log('tank', rows[0] || null);
    if (rows[0]) {
      const a = await pool.query(
        `SELECT id, result, failure_note, attempted_at FROM test_attempts
         WHERE tank_id = $1 ORDER BY id DESC LIMIT 5`,
        [rows[0].id]
      );
      console.log('attempts', a.rows);
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
