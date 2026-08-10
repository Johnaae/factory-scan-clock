'use strict';

/**
 * Safely remove leftover agent test tanks only.
 * Matches tank_number AND description (winder-pause-test | piece-complete-test).
 * Never deletes tanks without those test descriptions.
 */
require('./load-env');
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');

const TARGET_NUMBERS = ['WA64594', 'WB64594', 'PC864166'];
const TEST_DESCRIPTIONS = ['winder-pause-test', 'piece-complete-test'];

(async () => {
  const pool = new Pool(createPoolOptions());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: candidates } = await client.query(
      `SELECT id, tank_number, description, status
       FROM tanks
       WHERE UPPER(TRIM(tank_number)) = ANY($1::text[])
         AND (
           TRIM(COALESCE(description, '')) = ANY($2::text[])
           OR TRIM(COALESCE(description, '')) LIKE 'winder-pause-test%'
           OR TRIM(COALESCE(description, '')) LIKE 'piece-complete-test%'
         )`,
      [TARGET_NUMBERS.map((n) => n.toUpperCase()), TEST_DESCRIPTIONS]
    );

    if (!candidates.length) {
      console.log('No matching test tanks found (numbers + test descriptions). Nothing deleted.');
      await client.query('ROLLBACK');
      return;
    }

    console.log('Deleting test tanks:');
    for (const t of candidates) {
      console.log(`  id=${t.id} ${t.tank_number} desc="${t.description}" status=${t.status}`);
    }

    const ids = candidates.map((t) => t.id);

    await client.query(
      `UPDATE machines SET active_tank_id = NULL, updated_at = NOW()
       WHERE active_tank_id = ANY($1::bigint[])`,
      [ids]
    );

    // Session children cascade from machine_sessions; remove sessions first (RESTRICT on tank_id).
    await client.query(`DELETE FROM machine_sessions WHERE tank_id = ANY($1::bigint[])`, [ids]);
    await client.query(`DELETE FROM part_complete_events WHERE tank_id = ANY($1::bigint[])`, [ids]);
    await client.query(`DELETE FROM tank_pieces WHERE tank_id = ANY($1::bigint[])`, [ids]);
    await client.query(`DELETE FROM production_notes WHERE tank_id = ANY($1::bigint[])`, [ids]);
    await client.query(
      `UPDATE job_finish_events SET tank_id = NULL WHERE tank_id = ANY($1::bigint[])`,
      [ids]
    );

    const del = await client.query(`DELETE FROM tanks WHERE id = ANY($1::bigint[]) RETURNING tank_number`, [
      ids,
    ]);
    await client.query('COMMIT');
    console.log('Deleted:', del.rows.map((r) => r.tank_number).join(', '));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
