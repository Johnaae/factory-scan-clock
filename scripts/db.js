'use strict';

const { Pool } = require('pg');
const {
  createPoolOptions,
  logDatabaseBootInfo,
  formatDbError,
  withDbRetry,
} = require('./db-config');

logDatabaseBootInfo();

const pool = new Pool(createPoolOptions());

pool.on('error', (err) => {
  console.error('[db] pool error:', formatDbError(err));
});

async function withClient(fn) {
  return withDbRetry(
    async () => {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    { label: 'script', maxAttempts: 3, delayMs: 1500 }
  );
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  withClient,
  closePool,
  withDbRetry,
};
