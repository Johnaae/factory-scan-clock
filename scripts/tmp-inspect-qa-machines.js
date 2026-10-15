'use strict';
require('./load-env');
const { pool, closePool } = require('./db');

async function main() {
  const r = await pool.query(
    `SELECT id, name, workflow, kiosk_slug, active, created_at
     FROM machines
     WHERE name ILIKE '%QA%'
        OR name ILIKE '%065628%'
        OR kiosk_slug ILIKE '%qa-qc%'
        OR name ILIKE 'TEST %'
     ORDER BY id DESC
     LIMIT 30`
  );
  console.log(JSON.stringify(r.rows, null, 2));

  const cons = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'machines'::regclass
       AND contype = 'c'`
  );
  console.log('constraints', JSON.stringify(cons.rows, null, 2));

  const col = await pool.query(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'machines' AND column_name = 'workflow'`
  );
  console.log('column', JSON.stringify(col.rows, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
