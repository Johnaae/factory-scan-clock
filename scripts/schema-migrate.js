'use strict';

/**
 * Idempotent PostgreSQL schema migration for empty or existing databases.
 * Parent tables before children; columns/indexes/FKs after base CREATE.
 * Safe for local Postgres (INTERNAL_LAN_MODE) and Neon (SSL via pool config).
 * Concurrent Vercel invocations serialize via pg_advisory_lock.
 */

const SCHEMA_LOCK_KEY = 87420136;

/** Stage 1 — parent / base tables (no FKs that depend on later tables). */
const BASE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 20,
  badge_role TEXT,
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
  completed_at TIMESTAMPTZ,
  paused_reason TEXT,
  wip_team_id BIGINT,
  wip_phase_code TEXT,
  wip_phase_name TEXT,
  wip_machine_id BIGINT
);

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
  barcode TEXT,
  kiosk_slug TEXT UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  assigned_team_id BIGINT,
  assigned_team_day TEXT,
  assigned_team_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/** Stage 2 — child / junction tables (after parents exist). */
const JUNCTION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_members (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  email_status TEXT,
  email_error TEXT,
  email_sent_at TIMESTAMPTZ,
  resolve_email_status TEXT,
  resolve_email_error TEXT,
  resolve_email_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_email_recipients (
  id BIGSERIAL PRIMARY KEY,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('qa_qc', 'maintenance')),
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_type, email)
);
`;

/** Stage 3 — additive columns for databases created before columns existed on CREATE. */
const ADD_COLUMNS_SQL = `
ALTER TABLE employees ADD COLUMN IF NOT EXISTS badge_role TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS paused_reason TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_team_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_phase_code TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_phase_name TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_machine_id BIGINT;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS barcode TEXT;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS assigned_team_id BIGINT;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS assigned_team_day TEXT;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS assigned_team_at TIMESTAMPTZ;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS employee_id BIGINT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_name TEXT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10, 2);
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_status TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_error TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_status TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_error TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_sent_at TIMESTAMPTZ;
`;

/** Stage 4 — indexes. */
const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(code);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_tanks_tank_number ON tanks(tank_number);
CREATE INDEX IF NOT EXISTS idx_scan_logs_employee_code ON scan_logs(employee_code);
CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at);
CREATE INDEX IF NOT EXISTS idx_scan_logs_tank_number ON scan_logs(tank_number);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_employee_code ON job_finish_events(employee_code);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_tank_number ON job_finish_events(tank_number);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_finished_at ON job_finish_events(finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_area ON job_finish_events(area_name);
CREATE INDEX IF NOT EXISTS idx_teams_barcode ON teams(barcode);
CREATE INDEX IF NOT EXISTS idx_machines_kiosk_slug ON machines(kiosk_slug);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_machine_id ON machine_sessions(machine_id);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_team_id ON machine_sessions(team_id);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_status ON machine_sessions(status);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_started_at ON machine_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_finished_at ON machine_sessions(finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_team_members_employee ON session_team_members(employee_id);
CREATE INDEX IF NOT EXISTS idx_session_team_members_session ON session_team_members(session_id);
CREATE INDEX IF NOT EXISTS idx_part_complete_events_tank ON part_complete_events(tank_id);
CREATE INDEX IF NOT EXISTS idx_part_complete_events_completed ON part_complete_events(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_employee_id ON team_members(employee_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_status ON alert_events(status);
CREATE INDEX IF NOT EXISTS idx_alert_events_machine_id ON alert_events(machine_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_reported_at ON alert_events(reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_email_recipients_type ON alert_email_recipients(alert_type);
`;

const REQUIRED_TABLES = [
  'employees',
  'users',
  'tanks',
  'teams',
  'machines',
  'team_members',
  'scan_logs',
  'job_finish_events',
  'machine_sessions',
  'session_team_members',
  'part_complete_events',
  'alert_events',
  'alert_email_recipients',
];

async function ensureForeignKey(client, tableName, columnName, refTable, refColumn, onDelete) {
  const conname = `fk_${tableName}_${columnName}`;
  const { rows } = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = $1 LIMIT 1`, [conname]);
  if (rows.length) return;
  await client.query(
    `ALTER TABLE ${tableName}
     ADD CONSTRAINT ${conname}
     FOREIGN KEY (${columnName}) REFERENCES ${refTable}(${refColumn}) ON DELETE ${onDelete}`
  );
}

async function ensureScanLogsStatusConstraint(client) {
  await client.query(`ALTER TABLE scan_logs DROP CONSTRAINT IF EXISTS scan_logs_status_check`);
  await client.query(
    `ALTER TABLE scan_logs ADD CONSTRAINT scan_logs_status_check CHECK (status IN ('IN', 'OUT', 'STOP'))`
  );
}

async function addDeferredForeignKeys(client) {
  await ensureForeignKey(client, 'tanks', 'wip_team_id', 'teams', 'id', 'SET NULL');
  await ensureForeignKey(client, 'tanks', 'wip_machine_id', 'machines', 'id', 'SET NULL');
  await ensureForeignKey(client, 'machines', 'assigned_team_id', 'teams', 'id', 'SET NULL');
  await ensureForeignKey(client, 'team_members', 'employee_id', 'employees', 'id', 'SET NULL');
}

async function verifyRequiredTables(client) {
  const { rows } = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'
       AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES]
  );
  const found = new Set(rows.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
  if (missing.length) {
    throw new Error(`Required tables missing after migration: ${missing.join(', ')}`);
  }
  return REQUIRED_TABLES.map((name) => ({ table: name, ok: found.has(name) }));
}

async function listRequiredTableStatus(client) {
  const { rows } = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'
       AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES]
  );
  const found = new Set(rows.map((r) => r.table_name));
  return REQUIRED_TABLES.map((name) => ({ table: name, ok: found.has(name) }));
}

async function runOptionalBackfills(client, log = console) {
  log.log('[migration] running backfills');
  try {
    await client.query(`
      UPDATE tanks SET status = 'active'
      WHERE status IS NULL
         OR TRIM(status) = ''
         OR LOWER(TRIM(status)) IN ('active');
    `);
    await client.query(`
      UPDATE tanks SET status = 'archived'
      WHERE LOWER(TRIM(status)) IN ('archived', 'completed');
    `);
    await client.query(`UPDATE tanks SET created_at = NOW() WHERE created_at IS NULL`);
    await client.query(`
      UPDATE tanks
      SET completed_at = COALESCE(completed_at, updated_at, NOW())
      WHERE LOWER(TRIM(status)) IN ('archived', 'completed')
        AND completed_at IS NULL
    `);
    await client.query(`
      UPDATE tanks
      SET completed_at = NULL
      WHERE LOWER(TRIM(COALESCE(status, ''))) IN ('active', '')
    `);
  } catch (err) {
    log.warn('[migration] tanks lifecycle backfill (noncritical):', err.message);
  }

  try {
    await client.query(`
      UPDATE machines
      SET active = 0, updated_at = NOW()
      WHERE UPPER(TRIM(code)) LIKE 'WS-%'
         OR name ILIKE 'Winding Station%'
    `);
  } catch (err) {
    log.warn('[migration] legacy machines deactivate (noncritical):', err.message);
  }

  try {
    await client.query(`
      UPDATE session_team_members stm
      SET employee_code = COALESCE(stm.employee_code, e.code),
          employee_name = COALESCE(stm.employee_name, e.name),
          hourly_rate = COALESCE(stm.hourly_rate, e.hourly_rate, 0)
      FROM employees e
      WHERE e.id = stm.employee_id
        AND (stm.employee_code IS NULL OR stm.employee_name IS NULL OR stm.hourly_rate IS NULL)
    `);
  } catch (err) {
    log.warn('[migration] session_team_members backfill (noncritical):', err.message);
  }

  try {
    const { rowCount } = await client.query(`
      INSERT INTO part_complete_events
        (session_id, tank_id, team_id, team_name, confirmed_by_employee_id, confirmed_by_employee_name, completed_at, created_at)
      SELECT sub.id, sub.tank_id, sub.team_id, sub.team_name, NULL, NULL, sub.completed_at, sub.completed_at
      FROM (
        SELECT DISTINCT ON (ms.tank_id)
          ms.id, ms.tank_id, ms.team_id, t.name AS team_name,
          COALESCE(ms.finished_at, ms.updated_at, NOW()) AS completed_at
        FROM machine_sessions ms
        JOIN teams t ON t.id = ms.team_id
        WHERE ms.activity_code = 'PART_COMPLETE'
          AND ms.status = 'finished'
        ORDER BY ms.tank_id, ms.finished_at DESC NULLS LAST, ms.id DESC
      ) sub
      WHERE NOT EXISTS (SELECT 1 FROM part_complete_events pce WHERE pce.tank_id = sub.tank_id)
    `);
    if (rowCount > 0) {
      log.log(`[migration] part_complete_events backfill: inserted ${rowCount} row(s)`);
    }
  } catch (err) {
    log.warn('[migration] part_complete_events backfill (noncritical):', err.message);
  }
}

/**
 * Run full required schema migration. Throws on required failure.
 * Uses pg_advisory_lock so concurrent serverless cold starts serialize.
 */
async function runSchemaMigration(client, options = {}) {
  const log = options.log || console;
  const skipBackfills = Boolean(options.skipBackfills);

  log.log('[migration] acquiring schema lock');
  await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
  try {
    log.log('[migration] creating base tables');
    await client.query('BEGIN');
    try {
      await client.query(BASE_TABLES_SQL);

      log.log('[migration] creating junction tables');
      await client.query(JUNCTION_TABLES_SQL);

      log.log('[migration] adding columns');
      await client.query(ADD_COLUMNS_SQL);

      log.log('[migration] creating indexes');
      await client.query(INDEXES_SQL);

      log.log('[migration] adding constraints');
      await ensureScanLogsStatusConstraint(client);
      await addDeferredForeignKeys(client);

      await verifyRequiredTables(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    if (!skipBackfills) {
      await runOptionalBackfills(client, log);
    }

    log.log('[migration] schema complete');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
  }
}

async function runSchemaMigrationWithPool(pool, options = {}) {
  const log = (options && options.log) || console;
  log.log('[db] connecting');
  const client = await pool.connect();
  try {
    await runSchemaMigration(client, options);
  } finally {
    client.release();
  }
}

module.exports = {
  SCHEMA_LOCK_KEY,
  REQUIRED_TABLES,
  BASE_TABLES_SQL,
  JUNCTION_TABLES_SQL,
  ADD_COLUMNS_SQL,
  INDEXES_SQL,
  runSchemaMigration,
  runSchemaMigrationWithPool,
  runOptionalBackfills,
  verifyRequiredTables,
  listRequiredTableStatus,
};
