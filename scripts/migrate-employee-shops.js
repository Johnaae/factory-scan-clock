'use strict';

/**
 * Manual migration: Employee Shop Assignment table (scripts/migrate-employee-shops.sql).
 * Not run at server startup.
 *
 *   node scripts/migrate-employee-shops.js                    dry run (default, no changes)
 *   node scripts/migrate-employee-shops.js --apply            apply to a local database
 *   node scripts/migrate-employee-shops.js --apply --production   apply to Neon / non-local
 *
 * Does not print secrets.
 */

const fs = require('fs');
const path = require('path');
const { withClient, closePool } = require('./db');
const { getDbHostLabel } = require('./db-config');

const SQL_PATH = path.join(__dirname, 'migrate-employee-shops.sql');

async function tableExists(client) {
  const r = await client.query(`SELECT to_regclass('public.employee_shops') IS NOT NULL AS ok`);
  return Boolean(r.rows[0] && r.rows[0].ok);
}

async function run() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const allowProduction = args.has('--production');
  const hostLabel = getDbHostLabel();
  const sql = fs.readFileSync(SQL_PATH, 'utf8');

  console.log(`[employee-shops] DB host label: ${hostLabel}`);
  console.log(`[employee-shops] mode: ${apply ? 'APPLY' : 'DRY RUN (no changes)'}`);

  if (apply && hostLabel !== 'localhost' && !allowProduction) {
    console.error('[employee-shops] Refusing to apply to a non-local database without --production.');
    process.exitCode = 1;
    return;
  }

  await withClient(async (client) => {
    const before = await tableExists(client);
    const emp = await client.query(`SELECT COUNT(*)::int AS n FROM employees`);
    console.log(`[employee-shops] employees: ${emp.rows[0].n} (not modified)`);
    console.log(`[employee-shops] employee_shops table exists: ${before ? 'yes' : 'no'}`);

    if (!apply) {
      console.log('[employee-shops] SQL that --apply would run:\n');
      console.log(sql);
      return;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const after = await tableExists(client);
    const rows = await client.query(`SELECT COUNT(*)::int AS n FROM employee_shops`);
    const empAfter = await client.query(`SELECT COUNT(*)::int AS n FROM employees`);
    console.log(`[employee-shops] employee_shops table exists: ${after ? 'yes' : 'no'}`);
    console.log(`[employee-shops] shop assignment rows: ${rows.rows[0].n}`);
    console.log(`[employee-shops] employees after: ${empAfter.rows[0].n}`);
  });
}

run()
  .then(async () => {
    await closePool();
  })
  .catch(async (err) => {
    console.error('[employee-shops] failed:', err && err.message ? err.message : err);
    await closePool();
    process.exit(1);
  });
