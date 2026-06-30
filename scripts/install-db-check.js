'use strict';

const { Pool } = require('pg');
const { validateDatabaseConfig, createPoolOptions, parseDatabaseUrl } = require('./db-config');

function oneLine(msg) {
  return String(msg || '').replace(/\r?\n/g, ' ').trim();
}

async function main() {
  const parsed = parseDatabaseUrl(process.env.DATABASE_URL);
  if (parsed.database) {
    console.log(`DB_NAME=${parsed.database}`);
  }

  if (!process.env.DATABASE_URL) {
    console.log('DB_STATUS=MISSING_URL');
    process.exit(2);
  }

  try {
    validateDatabaseConfig();
    const pool = new Pool(createPoolOptions());
    await pool.query('SELECT 1 AS ok');
    await pool.end();
    console.log('DB_STATUS=OK');
    process.exit(0);
  } catch (err) {
    console.log(`DB_STATUS=ERROR:${oneLine(err && err.message ? err.message : err)}`);
    process.exit(1);
  }
}

main();
