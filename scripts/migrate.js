'use strict';

require('dotenv').config();

const { withClient, closePool } = require('./db');

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('MANAGER','KIOSK')),
  station_name TEXT,
  area_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tanks (
  id BIGSERIAL PRIMARY KEY,
  tank_number TEXT UNIQUE NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scan_logs (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN','OUT')),
  note TEXT,
  note_category TEXT,
  note_value TEXT,
  tank_number TEXT,
  station_name TEXT,
  area_name TEXT,
  kiosk_user TEXT,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(code);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_tanks_tank_number ON tanks(tank_number);
CREATE INDEX IF NOT EXISTS idx_scan_logs_employee_code ON scan_logs(employee_code);
CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at);
CREATE INDEX IF NOT EXISTS idx_scan_logs_tank_number ON scan_logs(tank_number);
`;

async function run() {
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(MIGRATION_SQL);
      await client.query('COMMIT');
      console.log('[migrate] schema ready');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

run()
  .then(async () => {
    await closePool();
  })
  .catch(async (err) => {
    console.error('[migrate] failed:', err.message);
    await closePool();
    process.exit(1);
  });
