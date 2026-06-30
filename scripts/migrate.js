'use strict';

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scan_logs (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN','OUT','STOP')),
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

ALTER TABLE employees ADD COLUMN IF NOT EXISTS badge_role TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scan_logs_tank_number ON scan_logs(tank_number);

CREATE TABLE IF NOT EXISTS job_finish_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL DEFAULT 'FINISH_JOB',
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  tank_number TEXT NOT NULL,
  activity_code TEXT,
  activity_name TEXT NOT NULL,
  area_name TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  kiosk_user TEXT,
  scan_source TEXT,
  finish_out_log_id BIGINT UNIQUE,
  finish_in_log_id BIGINT,
  job_in_log_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_finish_events_employee_code ON job_finish_events(employee_code);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_tank_number ON job_finish_events(tank_number);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_finished_at ON job_finish_events(finished_at DESC);
`;

async function run() {
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(MIGRATION_SQL);
      await client.query(`UPDATE tanks SET created_at = NOW() WHERE created_at IS NULL`);
      await client.query(`
        UPDATE tanks
        SET completed_at = COALESCE(completed_at, updated_at, NOW())
        WHERE LOWER(TRIM(status)) = 'archived'
          AND completed_at IS NULL
      `);
      await client.query(`
        UPDATE tanks
        SET completed_at = NULL
        WHERE LOWER(TRIM(COALESCE(status, ''))) IN ('active', '')
      `);
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
