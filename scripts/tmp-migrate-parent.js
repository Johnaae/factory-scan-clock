'use strict';
require('./load-env');
const { pool, closePool } = require('./db');
const { runSchemaMigration } = require('./schema-migrate');

async function main() {
  const result = await runSchemaMigration(pool);
  console.log('migrate:', result);
  const cols = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'test_attempts' AND column_name = 'parent_attempt_id'`
  );
  console.log('parent_attempt_id present:', cols.rows.length > 0);
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closePool();
  } catch (_e) {}
  process.exit(1);
});
