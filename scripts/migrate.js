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

CREATE TABLE IF NOT EXISTS teams (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS machines (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  kiosk_slug TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS machine_sessions (
  id BIGSERIAL PRIMARY KEY,
  machine_id BIGINT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE RESTRICT,
  activity_code TEXT NOT NULL,
  activity_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'stopped', 'finished')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  resumed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  stop_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_barcode ON teams(barcode);
CREATE INDEX IF NOT EXISTS idx_machines_kiosk_slug ON machines(kiosk_slug);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_machine_id ON machine_sessions(machine_id);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_team_id ON machine_sessions(team_id);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_status ON machine_sessions(status);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_started_at ON machine_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_finished_at ON machine_sessions(finished_at DESC);

CREATE TABLE IF NOT EXISTS session_team_members (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES machine_sessions(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  team_member_id BIGINT REFERENCES team_members(id) ON DELETE SET NULL,
  employee_code TEXT,
  employee_name TEXT,
  hourly_rate NUMERIC(10, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_session_team_members_employee ON session_team_members(employee_id);
CREATE INDEX IF NOT EXISTS idx_session_team_members_session ON session_team_members(session_id);

ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_name TEXT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10, 2);

CREATE TABLE IF NOT EXISTS part_complete_events (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES machine_sessions(id) ON DELETE SET NULL,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE RESTRICT,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  team_name TEXT,
  confirmed_by_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  confirmed_by_employee_name TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_part_complete_events_tank ON part_complete_events(tank_id);
CREATE INDEX IF NOT EXISTS idx_part_complete_events_completed ON part_complete_events(completed_at DESC);

ALTER TABLE machines ADD COLUMN IF NOT EXISTS barcode TEXT;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS team_members (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);

ALTER TABLE team_members ADD COLUMN IF NOT EXISTS employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_team_members_employee_id ON team_members(employee_id);

CREATE TABLE IF NOT EXISTS alert_events (
  id BIGSERIAL PRIMARY KEY,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  session_id BIGINT REFERENCES machine_sessions(id) ON DELETE SET NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('qa_qc', 'maintenance')),
  alert_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_status ON alert_events(status);
CREATE INDEX IF NOT EXISTS idx_alert_events_machine_id ON alert_events(machine_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_reported_at ON alert_events(reported_at DESC);

ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_status TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_error TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_status TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_error TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS alert_email_recipients (
  id BIGSERIAL PRIMARY KEY,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('qa_qc', 'maintenance')),
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_type, email)
);

CREATE INDEX IF NOT EXISTS idx_alert_email_recipients_type ON alert_email_recipients(alert_type);
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
      await client.query(`
        UPDATE machines
        SET active = 0, updated_at = NOW()
        WHERE UPPER(TRIM(code)) LIKE 'WS-%'
           OR name ILIKE 'Winding Station%'
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
