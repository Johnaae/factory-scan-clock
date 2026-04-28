'use strict';

require('dotenv').config();

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL missing');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
  console.log('DB connected:', `${String(process.env.DATABASE_URL || '').slice(0, 30)}...`);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  withClient,
  closePool,
};
