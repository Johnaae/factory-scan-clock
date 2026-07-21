'use strict';

/**
 * Verify required PostgreSQL tables exist (optionally runs schema init first).
 * Never prints DATABASE_URL or secrets.
 *
 * Usage:
 *   node scripts/verify-database.js
 *   node scripts/verify-database.js --migrate
 */

const { Pool } = require('pg');
const {
  createPoolOptions,
  validateDatabaseConfig,
  getDbHostLabel,
  formatDbError,
} = require('./db-config');
const {
  REQUIRED_TABLES,
  runSchemaMigration,
  listRequiredTableStatus,
} = require('./schema-migrate');

async function main() {
  validateDatabaseConfig();
  const shouldMigrate = process.argv.includes('--migrate') || process.argv.includes('--init');
  console.log('[db] connecting');
  console.log(`[db] host label: ${getDbHostLabel()}`);

  const pool = new Pool(createPoolOptions());
  const client = await pool.connect();
  try {
    if (shouldMigrate) {
      await runSchemaMigration(client);
    }
    const status = await listRequiredTableStatus(client);
    let failed = 0;
    for (const row of status) {
      if (row.ok) {
        console.log(`[verify] OK  ${row.table}`);
      } else {
        failed += 1;
        console.error(`[verify] MISSING  ${row.table}`);
      }
    }
    if (failed > 0) {
      console.error(`[verify] ${failed} required table(s) missing (${REQUIRED_TABLES.length} expected)`);
      process.exitCode = 1;
      return;
    }
    console.log(`[verify] all ${REQUIRED_TABLES.length} required tables present`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[verify] failed:', formatDbError(err));
  process.exit(1);
});
