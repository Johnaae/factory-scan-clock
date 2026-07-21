'use strict';

/**
 * Initialize / migrate PostgreSQL schema (empty Neon or local).
 * Does not print secrets.
 */

const { withClient, closePool } = require('./db');
const { getDbHostLabel } = require('./db-config');
const { runSchemaMigration } = require('./schema-migrate');

async function run() {
  console.log('[db] connecting');
  console.log(`[db] host label: ${getDbHostLabel()}`);
  await withClient(async (client) => {
    await runSchemaMigration(client);
  });
}

run()
  .then(async () => {
    await closePool();
  })
  .catch(async (err) => {
    console.error('[migrate] failed:', err && err.message ? err.message : err);
    await closePool();
    process.exit(1);
  });
