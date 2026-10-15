'use strict';

/** READ-ONLY: pre-existing orphan tank_admin_audit rows. */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon.');
  const r = await pool.query(`
    SELECT a.action, COUNT(*)::int AS n, MIN(a.performed_at) AS first_at, MAX(a.performed_at) AS last_at,
           string_agg(DISTINCT a.tank_number, ', ') AS tank_numbers
    FROM tank_admin_audit a
    WHERE a.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks t WHERE t.id = a.tank_id)
    GROUP BY a.action ORDER BY n DESC`);
  for (const row of r.rows) {
    console.log(`${row.n}  ${row.action}  ${row.first_at.toISOString()} .. ${row.last_at.toISOString()}`);
    console.log(`    tanks: ${row.tank_numbers}`);
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    await closePool();
    process.exit(1);
  });
