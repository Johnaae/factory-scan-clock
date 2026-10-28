'use strict';

/**
 * Idempotent PostgreSQL schema migration for empty or existing databases.
 * Parent tables before children; columns/indexes/FKs after base CREATE.
 * Safe for local Postgres (INTERNAL_LAN_MODE) and Neon (SSL via pool config).
 * Concurrent Vercel invocations serialize via pg_advisory_lock.
 */

const SCHEMA_LOCK_KEY = 87420136;

let phase2SchemaSql = null;
try {
  phase2SchemaSql = require('./phase2-schema-sql');
} catch (_err) {
  phase2SchemaSql = null;
}

let phase3SchemaSql = null;
try {
  phase3SchemaSql = require('./phase3-schema-sql');
} catch (_err) {
  phase3SchemaSql = null;
}

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
  pin_hash TEXT,
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
  piece_id BIGINT,
  piece_number INTEGER,
  phase_code TEXT,
  phase_name TEXT,
  resolution_note TEXT,
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

/** Stage 4 — additive columns, run after extended/Phase 2 tables exist. */
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
ALTER TABLE teams ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_name TEXT;
ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10, 2);
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_status TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_error TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_status TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_error TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_sent_at TIMESTAMPTZ;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS piece_id BIGINT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS piece_number INTEGER;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS phase_code TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS phase_name TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS first_scanned_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS customer TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS piece_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS current_piece_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS active_tank_id BIGINT;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE machine_sessions ADD COLUMN IF NOT EXISTS piece_number INTEGER;
ALTER TABLE machine_sessions ADD COLUMN IF NOT EXISTS piece_id BIGINT;
ALTER TABLE machine_sessions ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE part_complete_events ADD COLUMN IF NOT EXISTS piece_number INTEGER;
ALTER TABLE part_complete_events ADD COLUMN IF NOT EXISTS piece_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS deleted_reason TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS previous_status TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS restored_by TEXT;

CREATE TABLE IF NOT EXISTS tank_admin_audit (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('move_to_trash', 'restore_from_trash', 'permanent_delete')),
  tank_id BIGINT,
  tank_number TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  previous_status TEXT,
  details JSONB
);

CREATE TABLE IF NOT EXISTS employee_team_memberships (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  source TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS machine_session_edits (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES machine_sessions(id) ON DELETE CASCADE,
  tank_id BIGINT,
  piece_id BIGINT,
  piece_number INTEGER,
  phase_code TEXT,
  phase_name TEXT,
  original_started_at TIMESTAMPTZ,
  original_ended_at TIMESTAMPTZ,
  original_duration_ms BIGINT,
  edited_started_at TIMESTAMPTZ,
  edited_ended_at TIMESTAMPTZ,
  edited_duration_ms BIGINT,
  edited_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  edited_by_name TEXT,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edit_reason TEXT NOT NULL
);

ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS tank_id BIGINT;
ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS piece_id BIGINT;
ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS piece_number INTEGER;
ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS phase_code TEXT;
ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS phase_name TEXT;
${
  phase2SchemaSql
    ? phase2SchemaSql.PHASE2_COLUMNS_SQL
    : `
ALTER TABLE machines ADD COLUMN IF NOT EXISTS workflow TEXT NOT NULL DEFAULT 'winding';
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS fab_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_started_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_started_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_completed_at TIMESTAMPTZ;
`
}
`;

/** Stage 3 — extended/Phase 2 tables, created after all parent tables. */
const EXTENDED_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tank_pieces (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
  piece_number INTEGER NOT NULL CHECK (piece_number >= 1 AND piece_number <= 8),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  operator_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tank_id, piece_number)
);

CREATE TABLE IF NOT EXISTS piece_restore_events (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE RESTRICT,
  tank_number TEXT,
  piece_id BIGINT REFERENCES tank_pieces(id) ON DELETE SET NULL,
  piece_number INTEGER NOT NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  previous_completed_at TIMESTAMPTZ,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  team_name TEXT,
  restored_by_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  restored_by_employee_name TEXT,
  reason TEXT,
  restored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_piece_restore_events_tank ON piece_restore_events(tank_id, restored_at DESC);

CREATE TABLE IF NOT EXISTS production_notes (
  id BIGSERIAL PRIMARY KEY,
  note_type TEXT NOT NULL DEFAULT 'general'
    CHECK (note_type IN ('general', 'problem', 'maintenance', 'quality', 'safety', 'correction')),
  body TEXT NOT NULL,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  tank_number TEXT,
  piece_number INTEGER,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  team_name TEXT,
  operator_name TEXT,
  session_id BIGINT REFERENCES machine_sessions(id) ON DELETE SET NULL,
  phase_code TEXT,
  phase_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS downtime_intervals (
  id BIGSERIAL PRIMARY KEY,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
  tank_number TEXT,
  session_id BIGINT REFERENCES machine_sessions(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  team_name TEXT,
  phase_code TEXT,
  phase_name TEXT,
  piece_number INTEGER,
  reason_code TEXT,
  reason_note TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
${
  phase2SchemaSql
    ? phase2SchemaSql.PHASE2_TABLES_SQL
    : `
CREATE TABLE IF NOT EXISTS stage_labor_sessions (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
  machine_id BIGINT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('ASSEMBLY', 'TESTING', 'CORRECTION')),
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'finished')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  started_by_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  started_by_employee_name TEXT,
  stopped_by_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  stopped_by_employee_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stage_labor_participants (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES stage_labor_sessions(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employee_code TEXT,
  employee_name TEXT,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_attempts (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  team_name TEXT,
  result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  attempted_at TIMESTAMPTZ NOT NULL,
  tester_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  tester_employee_name TEXT,
  failure_note TEXT,
  labor_session_id BIGINT REFERENCES stage_labor_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
}
`;

/** Stage 5 — indexes. */
const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(code);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_tanks_tank_number ON tanks(tank_number);
CREATE INDEX IF NOT EXISTS idx_tanks_deleted_at ON tanks(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tank_admin_audit_tank ON tank_admin_audit(tank_number, performed_at DESC);
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
CREATE INDEX IF NOT EXISTS idx_tank_pieces_tank ON tank_pieces(tank_id);
CREATE INDEX IF NOT EXISTS idx_production_notes_created ON production_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_notes_tank ON production_notes(tank_id);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_tank_id ON machine_sessions(tank_id);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_piece_id ON machine_sessions(piece_id);
CREATE INDEX IF NOT EXISTS idx_machine_sessions_tank_piece_phase ON machine_sessions(tank_id, piece_number, activity_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_sessions_open_tank_piece
  ON machine_sessions(tank_id, piece_number)
  WHERE status IN ('running', 'stopped') AND piece_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_team_memberships_emp ON employee_team_memberships(employee_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_team_memberships_team ON employee_team_memberships(team_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_team_memberships_open ON employee_team_memberships(employee_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_machine_session_edits_session ON machine_session_edits(session_id, edited_at DESC);
${
  phase2SchemaSql
    ? phase2SchemaSql.PHASE2_INDEXES_SQL
    : `
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_tank ON stage_labor_sessions(tank_id);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_machine ON stage_labor_sessions(machine_id);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_status ON stage_labor_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_labor_participants_open_employee
  ON stage_labor_participants(employee_id)
  WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_test_attempts_tank ON test_attempts(tank_id);
`
}
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
  'tank_pieces',
  'production_notes',
  'stage_labor_sessions',
  'stage_labor_participants',
  'test_attempts',
  'test_attempt_notes',
  'assembly_kiosk_teams',
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
    const phase2Backfill =
      (phase2SchemaSql && phase2SchemaSql.PHASE2_BACKFILL_SQL) ||
      `
UPDATE machines SET workflow = 'winding' WHERE workflow IS NULL OR workflow = '';
UPDATE machines SET workflow = 'winding' WHERE workflow = 'winding' OR name ILIKE 'Winding%' OR code ILIKE 'WM-%';
`;
    await client.query(phase2Backfill);
  } catch (err) {
    log.warn('[migration] phase2 workflow backfill (noncritical):', err.message);
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

  try {
    await client.query(`
      UPDATE machine_sessions ms
      SET piece_id = tp.id
      FROM tank_pieces tp
      WHERE ms.piece_id IS NULL
        AND ms.tank_id = tp.tank_id
        AND ms.piece_number = tp.piece_number
    `);
    await client.query(`
      UPDATE part_complete_events pce
      SET piece_id = tp.id
      FROM tank_pieces tp
      WHERE pce.piece_id IS NULL
        AND pce.tank_id = tp.tank_id
        AND pce.piece_number = tp.piece_number
    `);
  } catch (err) {
    log.warn('[migration] piece_id backfill (noncritical):', err.message);
  }
}

async function allRequiredTablesExist(client) {
  const status = await listRequiredTableStatus(client);
  return status.every((row) => row.ok);
}

const TANK_TRASH_COLUMNS = [
  'deleted_at',
  'deleted_by',
  'deleted_reason',
  'previous_status',
  'restored_at',
  'restored_by',
];

async function ensureTankPiecesPieceLimit(client, log = console) {
  try {
    const { rows } = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'tank_pieces'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%piece_number%'`
    );
    for (const row of rows) {
      const def = String(row.def || '');
      if (/piece_number\s*>=\s*1\s*AND\s*piece_number\s*<=\s*8/i.test(def)) continue;
      if (/piece_number/i.test(def)) {
        await client.query(`ALTER TABLE tank_pieces DROP CONSTRAINT IF EXISTS ${row.conname}`);
      }
    }
    const { rows: after } = await client.query(
      `SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'tank_pieces'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%piece_number%<=%8%'`
    );
    if (!after.length) {
      await client.query(
        `ALTER TABLE tank_pieces
         ADD CONSTRAINT tank_pieces_piece_number_check
         CHECK (piece_number >= 1 AND piece_number <= 8)`
      );
      log.log('[migration] expanded tank_pieces.piece_number check to allow 1–8');
    }
  } catch (err) {
    log.warn('[migration] tank_pieces piece limit expansion (noncritical):', err.message);
  }
}

/** Idempotent additive pass — always safe on existing production databases. */
async function runAdditiveSchemaPass(client, log = console) {
  // Some additive ALTER statements target Phase 2 tables (for example
  // test_attempts.previous_status), so those tables must exist first.
  await client.query(EXTENDED_TABLES_SQL);
  await client.query(ADD_COLUMNS_SQL);
  await ensureTankPiecesPieceLimit(client, log);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tank_pieces_tank ON tank_pieces(tank_id);
    CREATE INDEX IF NOT EXISTS idx_production_notes_created ON production_notes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_production_notes_tank ON production_notes(tank_id);
    CREATE INDEX IF NOT EXISTS idx_machine_sessions_tank_id ON machine_sessions(tank_id);
    CREATE INDEX IF NOT EXISTS idx_machine_sessions_piece_id ON machine_sessions(piece_id);
    CREATE INDEX IF NOT EXISTS idx_machine_sessions_tank_piece_phase ON machine_sessions(tank_id, piece_number, activity_code);
    CREATE INDEX IF NOT EXISTS idx_downtime_intervals_tank ON downtime_intervals(tank_id);
    CREATE INDEX IF NOT EXISTS idx_downtime_intervals_started ON downtime_intervals(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tanks_deleted_at ON tanks(deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tank_admin_audit_tank ON tank_admin_audit(tank_number, performed_at DESC);
  `);
  const phase2Indexes =
    (phase2SchemaSql && phase2SchemaSql.PHASE2_INDEXES_SQL) ||
    `
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_tank ON stage_labor_sessions(tank_id);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_machine ON stage_labor_sessions(machine_id);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_status ON stage_labor_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_labor_participants_open_employee
  ON stage_labor_participants(employee_id)
  WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_test_attempts_tank ON test_attempts(tank_id);
`;
  await client.query(phase2Indexes);
  const phase2Backfill =
    (phase2SchemaSql && phase2SchemaSql.PHASE2_BACKFILL_SQL) ||
    `
UPDATE machines SET workflow = 'winding' WHERE workflow IS NULL OR workflow = '';
UPDATE machines SET workflow = 'winding' WHERE workflow = 'winding' OR name ILIKE 'Winding%' OR code ILIKE 'WM-%';
`;
  try {
    await client.query(phase2Backfill);
  } catch (err) {
    log.warn('[migration] phase2 workflow backfill (noncritical):', err.message);
  }
  await client.query(`
    UPDATE machine_sessions ms
    SET piece_id = tp.id
    FROM tank_pieces tp
    WHERE ms.piece_id IS NULL
      AND ms.tank_id = tp.tank_id
      AND ms.piece_number = tp.piece_number
  `);
  await client.query(`
    UPDATE tanks t
    SET status = 'waiting'
    WHERE LOWER(TRIM(COALESCE(t.status,''))) = 'active'
      AND t.first_scanned_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM machine_sessions ms WHERE ms.tank_id = t.id
      )
  `);
  await client.query(`
    UPDATE tanks t
    SET first_scanned_at = sub.first_at
    FROM (
      SELECT tank_id, MIN(started_at) AS first_at
      FROM machine_sessions
      GROUP BY tank_id
    ) sub
    WHERE t.id = sub.tank_id AND t.first_scanned_at IS NULL
  `);
  // Do NOT reopen shift labor for Employee-Out workers.
  // Permanent team_members roster is not the same as active shift labor
  // (employee_team_memberships with left_at IS NULL). This additive pass runs on
  // every boot, so a "missing open membership" backfill would undo Employee Out.
  // One-time migrate only: create history only when this employee/team pair has
  // never had any membership row at all.
  try {
    await client.query(`
      INSERT INTO employee_team_memberships (employee_id, team_id, joined_at, left_at, source, reason)
      SELECT tm.employee_id, tm.team_id, COALESCE(tm.created_at, NOW()), NULL, 'migrate', 'Backfill from team_members'
      FROM team_members tm
      WHERE tm.active = 1 AND tm.employee_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM employee_team_memberships m
          WHERE m.employee_id = tm.employee_id AND m.team_id = tm.team_id
        )
    `);
  } catch (err) {
    log.warn('[migration] employee_team_memberships backfill (noncritical):', err.message);
  }

  // Additive role expansion for QA/QC personnel (idempotent).
  try {
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await client.query(
      `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('MANAGER','KIOSK','QA_QC'))`
    );
  } catch (err) {
    log.warn('[migration] users.role QA_QC check (noncritical):', err.message);
  }

  await ensureEmployeeShopsSchema(client, log);
  await ensurePhase3DomeSchema(client, log);
  await ensurePhase3DomeSoftDelete(client, log);
  await ensurePhase3DomePieceInstall(client, log);
  await ensurePhase3BulkheadSchema(client, log);
}

/**
 * Employee Shop Assignment (permanent department eligibility). New table only; no existing
 * table, column or row is changed. ON DELETE CASCADE removes only this table's own rows when
 * an employee row is deleted, so the existing employee delete keeps working.
 */
const EMPLOYEE_SHOPS_SQL = `
CREATE TABLE IF NOT EXISTS employee_shops (
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shop TEXT NOT NULL CHECK (shop IN ('Fabrication', 'Assembly', 'Dome')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, shop)
);
CREATE INDEX IF NOT EXISTS idx_employee_shops_shop ON employee_shops (shop);
`;

/**
 * Reads pg_class with a fresh snapshot rather than to_regclass(): waiting on an advisory lock
 * does not refresh the session's catalog cache, so to_regclass() can miss a table another
 * session committed while this one waited.
 */
async function employeeShopsSchemaPresent(client) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname IN ('employee_shops', 'idx_employee_shops_shop')`
  );
  return Boolean(rows[0] && rows[0].n === 2);
}

/**
 * Creates employee_shops once. The additive pass runs on every cold start without the schema
 * lock, and concurrent CREATE TABLE IF NOT EXISTS can still collide, so creation takes
 * SCHEMA_LOCK_KEY as a transaction-scoped advisory lock (released at COMMIT/ROLLBACK, also
 * safe through a transaction-mode pooler; re-entrant when this session already holds the
 * session-level lock during a full migration).
 * Noncritical: the app treats a missing table as "Shop Assignment not available yet",
 * and the next cold start retries.
 */
async function ensureEmployeeShopsSchema(client, log = console) {
  try {
    if (await employeeShopsSchemaPresent(client)) return { created: false };
    await client.query('BEGIN');
    let created = false;
    try {
      await client.query(`SELECT set_config('lock_timeout', '8000', true)`);
      await client.query(`SELECT set_config('statement_timeout', '20000', true)`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      if (!(await employeeShopsSchemaPresent(client))) {
        await client.query(EMPLOYEE_SHOPS_SQL);
        created = true;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    if (created) log.log('[migration] employee_shops table ready');
    return { created };
  } catch (err) {
    log.warn('[migration] employee_shops (noncritical, retried on next start):', err.message);
    return { created: false, error: err.message };
  }
}

async function relationsPresent(client, names) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [names]
  );
  return Boolean(rows[0] && rows[0].n === names.length);
}

/**
 * Phase 3 Dome tables (scripts/phase3-schema-sql.js). Same locking as employee_shops.
 * Noncritical: Dome features report "not available yet" until the tables exist.
 */
async function ensurePhase3DomeSchema(client, log = console) {
  if (!phase3SchemaSql) return { created: false, error: 'phase3-schema-sql not loaded' };
  const { PHASE3_DOME_SQL, PHASE3_DOME_RELATIONS } = phase3SchemaSql;
  try {
    if (await relationsPresent(client, PHASE3_DOME_RELATIONS)) return { created: false };
    await client.query('BEGIN');
    let created = false;
    try {
      await client.query(`SELECT set_config('lock_timeout', '8000', true)`);
      await client.query(`SELECT set_config('statement_timeout', '20000', true)`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      if (!(await relationsPresent(client, PHASE3_DOME_RELATIONS))) {
        await client.query(PHASE3_DOME_SQL);
        created = true;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    if (created) log.log('[migration] Phase 3 dome tables ready');
    return { created };
  } catch (err) {
    log.warn('[migration] Phase 3 dome tables (noncritical, retried on next start):', err.message);
    return { created: false, error: err.message };
  }
}

/**
 * Soft-delete columns + partial unique dome_number index. Always safe to re-run (IF NOT EXISTS).
 * Runs even when base dome tables already exist so production can gain Delete Dome without
 * recreating tables. Noncritical — delete API returns not-ready until columns exist.
 * Multi-piece Dome Install indexes live in ensurePhase3DomePieceInstall (not here).
 */
async function ensurePhase3DomeSoftDelete(client, log = console) {
  if (!phase3SchemaSql) return { ok: false, error: 'phase3-schema-sql not loaded' };
  const { PHASE3_DOME_SOFT_DELETE_SQL } = phase3SchemaSql;
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'domes' AND column_name = 'deleted_at'`
    );
    const hasDeletedAt = Boolean(rows.length);
    // Still rewrite unique index if soft-delete columns already exist (idempotent CREATE).
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('lock_timeout', '8000', true)`);
      await client.query(`SELECT set_config('statement_timeout', '20000', true)`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      await client.query(PHASE3_DOME_SOFT_DELETE_SQL);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    if (!hasDeletedAt) log.log('[migration] Phase 3 dome soft-delete columns ready');
    return { ok: true };
  } catch (err) {
    log.warn('[migration] Phase 3 dome soft-delete (noncritical, retried on next start):', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * List non-primary unique indexes on dome_installations with ordered key column names.
 * Used to detect obsolete tank-only unique indexes vs the required dome_id / piece indexes.
 */
async function listDomeInstallationUniqueIndexes(client) {
  const { rows } = await client.query(`
    SELECT
      i.relname AS index_name,
      pg_get_indexdef(i.oid) AS index_def,
      COALESCE(
        (
          SELECT array_agg(a.attname::text ORDER BY u.ord)
          FROM unnest(ix.indkey) WITH ORDINALITY AS u(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
          WHERE u.attnum > 0
        ),
        ARRAY[]::text[]
      ) AS key_columns
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    JOIN pg_index ix ON ix.indrelid = t.oid
    JOIN pg_class i ON i.oid = ix.indexrelid
    WHERE t.relname = 'dome_installations'
      AND ix.indisunique
      AND NOT ix.indisprimary
    ORDER BY i.relname
  `);
  return rows.map((r) => ({
    index_name: r.index_name,
    index_def: r.index_def,
    key_columns: Array.isArray(r.key_columns) ? r.key_columns.map(String) : [],
  }));
}

function isDomeIdLiveUniqueIndex(idx) {
  return (
    idx.key_columns.length === 1 &&
    idx.key_columns[0] === 'dome_id' &&
    /status/i.test(idx.index_def || '') &&
    /in_progress/i.test(idx.index_def || '')
  );
}

function isPieceLiveUniqueIndex(idx) {
  return (
    idx.key_columns.length === 2 &&
    idx.key_columns[0] === 'tank_id' &&
    idx.key_columns[1] === 'piece_number' &&
    /status/i.test(idx.index_def || '') &&
    /in_progress/i.test(idx.index_def || '')
  );
}

/** Obsolete: unique live install per tank only (blocks Piece 2+ on the same tank). */
function isObsoleteTankOnlyLiveUniqueIndex(idx) {
  if (idx.key_columns.length !== 1 || idx.key_columns[0] !== 'tank_id') return false;
  // Prefer dropping indexes that clearly target live install statuses; also drop known names.
  const name = String(idx.index_name || '');
  if (
    name === 'idx_dome_installations_one_live_tank' ||
    name === 'idx_dome_installations_one_live' ||
    /one_live/i.test(name)
  ) {
    return true;
  }
  return /status/i.test(idx.index_def || '') && /in_progress/i.test(idx.index_def || '');
}

/**
 * Multi-piece Dome Install index migration (idempotent, non-destructive).
 *
 * Order:
 *  1) Create/validate idx_dome_installations_one_live_piece (tank_id, piece_number)
 *  2) Ensure idx_dome_installations_one_live remains on dome_id (recreate if missing/wrong)
 *  3) DROP any obsolete tank-only unique live index (never drops the dome_id unique)
 *
 * Does NOT delete or rewrite dome_installations rows. If duplicates prevent creating the
 * piece index, logs a warning and skips the tank-index DROP so data stays intact.
 */
async function ensurePhase3DomePieceInstall(client, log = console) {
  if (!phase3SchemaSql) return { ok: false, error: 'phase3-schema-sql not loaded' };
  const { PHASE3_DOME_PIECE_INSTALL_SQL, PHASE3_DOME_ONE_LIVE_DOME_SQL } = phase3SchemaSql;
  try {
    const tableCheck = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'dome_installations'`
    );
    if (!tableCheck.rows.length) return { ok: true, skipped: true, reason: 'no_dome_installations' };

    // Report conflicts only — never auto-delete or rewrite historical rows.
    const pieceConflicts = await client.query(`
      SELECT tank_id, piece_number, COUNT(*)::int AS n
      FROM dome_installations
      WHERE status IN ('in_progress', 'installed') AND tank_id IS NOT NULL
      GROUP BY tank_id, piece_number
      HAVING COUNT(*) > 1
    `);
    const domeConflicts = await client.query(`
      SELECT dome_id, COUNT(*)::int AS n
      FROM dome_installations
      WHERE status IN ('in_progress', 'installed')
      GROUP BY dome_id
      HAVING COUNT(*) > 1
    `);
    if (pieceConflicts.rows.length) {
      log.warn(
        '[migration] Phase 3 multi-piece index blocked: duplicate live installs on same tank piece (no rows modified):',
        pieceConflicts.rows.slice(0, 5)
      );
    }
    if (domeConflicts.rows.length) {
      log.warn(
        '[migration] Phase 3 dome_id unique blocked: duplicate live installs for same dome (no rows modified):',
        domeConflicts.rows.slice(0, 5)
      );
    }

    await client.query('BEGIN');
    let pieceReady = false;
    let domeReady = false;
    let dropped = [];
    try {
      await client.query(`SELECT set_config('lock_timeout', '8000', true)`);
      await client.query(`SELECT set_config('statement_timeout', '20000', true)`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);

      let indexes = await listDomeInstallationUniqueIndexes(client);

      // --- Step 1: create / validate per-piece unique index first ---
      const pieceIdx = indexes.find((i) => i.index_name === 'idx_dome_installations_one_live_piece');
      if (pieceIdx && isPieceLiveUniqueIndex(pieceIdx)) {
        pieceReady = true;
      } else if (pieceIdx && !isPieceLiveUniqueIndex(pieceIdx)) {
        // Wrong definition under the expected name — drop only this index object, then recreate.
        // Does not touch installation rows.
        await client.query(`DROP INDEX IF EXISTS idx_dome_installations_one_live_piece`);
        dropped.push('idx_dome_installations_one_live_piece(wrong_def)');
        indexes = indexes.filter((i) => i.index_name !== 'idx_dome_installations_one_live_piece');
      }

      if (!pieceReady) {
        if (pieceConflicts.rows.length) {
          // Leave DB unchanged rather than failing the whole additive pass.
          await client.query('ROLLBACK');
          return {
            ok: false,
            error: 'duplicate_live_piece_installs',
            conflicts: pieceConflicts.rows,
          };
        }
        await client.query(PHASE3_DOME_PIECE_INSTALL_SQL);
        indexes = await listDomeInstallationUniqueIndexes(client);
        const created = indexes.find((i) => i.index_name === 'idx_dome_installations_one_live_piece');
        pieceReady = Boolean(created && isPieceLiveUniqueIndex(created));
        if (!pieceReady) {
          throw new Error('idx_dome_installations_one_live_piece missing or wrong after CREATE');
        }
      }

      // --- Step 2: ensure dome_id unique remains (same dome cannot be installed twice) ---
      indexes = await listDomeInstallationUniqueIndexes(client);
      const namedLive = indexes.find((i) => i.index_name === 'idx_dome_installations_one_live');
      const anyDomeLive = indexes.find((i) => isDomeIdLiveUniqueIndex(i));

      if (namedLive && isDomeIdLiveUniqueIndex(namedLive)) {
        domeReady = true;
      } else if (namedLive && isObsoleteTankOnlyLiveUniqueIndex(namedLive)) {
        // Name reused for a tank-only unique — drop AFTER piece index is validated, then recreate on dome_id.
        // Deferred to step 3 drop loop; recreate below after drops.
        domeReady = false;
      } else if (namedLive && !isDomeIdLiveUniqueIndex(namedLive)) {
        await client.query(`DROP INDEX IF EXISTS idx_dome_installations_one_live`);
        dropped.push('idx_dome_installations_one_live(wrong_def)');
        domeReady = false;
      } else if (anyDomeLive) {
        // Correct uniqueness exists under another name — leave it; also ensure canonical name.
        domeReady = true;
        if (!namedLive) {
          if (!domeConflicts.rows.length) {
            await client.query(PHASE3_DOME_ONE_LIVE_DOME_SQL);
          }
        }
      }

      // --- Step 3: drop obsolete tank-only unique indexes (multi-piece unblock) ---
      indexes = await listDomeInstallationUniqueIndexes(client);
      for (const idx of indexes) {
        if (!isObsoleteTankOnlyLiveUniqueIndex(idx)) continue;
        // Never drop a dome_id unique; isObsoleteTankOnlyLiveUniqueIndex requires tank_id-only keys.
        await client.query(`DROP INDEX IF EXISTS ${quoteIdent(idx.index_name)}`);
        dropped.push(idx.index_name);
      }

      // Recreate dome_id unique if still missing after dropping a misnamed tank-level index.
      indexes = await listDomeInstallationUniqueIndexes(client);
      const domeAfter = indexes.find((i) => isDomeIdLiveUniqueIndex(i));
      if (domeAfter) {
        domeReady = true;
      } else if (!domeConflicts.rows.length) {
        await client.query(PHASE3_DOME_ONE_LIVE_DOME_SQL);
        indexes = await listDomeInstallationUniqueIndexes(client);
        domeReady = Boolean(indexes.find((i) => isDomeIdLiveUniqueIndex(i)));
        if (!domeReady) throw new Error('idx_dome_installations_one_live missing after recreate');
      } else {
        log.warn(
          '[migration] Phase 3 skipped recreating dome_id unique due to duplicate live dome rows (no data modified)'
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    if (dropped.length) {
      log.log('[migration] Phase 3 multi-piece Dome Install: dropped obsolete tank unique index(es):', dropped.join(', '));
    } else if (pieceReady && domeReady) {
      log.log('[migration] Phase 3 multi-piece Dome Install indexes verified');
    }
    return { ok: pieceReady && domeReady, pieceReady, domeReady, dropped };
  } catch (err) {
    log.warn('[migration] Phase 3 multi-piece Dome Install indexes (noncritical, retried on next start):', err.message);
    return { ok: false, error: err.message };
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Phase 3 Bulkhead tables. New tables only; same locking as dome schema.
 */
async function ensurePhase3BulkheadSchema(client, log = console) {
  if (!phase3SchemaSql) return { created: false, error: 'phase3-schema-sql not loaded' };
  const { PHASE3_BULKHEAD_SQL, PHASE3_BULKHEAD_ONE_LIVE_TANK_SQL, PHASE3_BULKHEAD_RELATIONS } =
    phase3SchemaSql;
  try {
    if (await relationsPresent(client, PHASE3_BULKHEAD_RELATIONS)) return { created: false };
    await client.query('BEGIN');
    let created = false;
    try {
      await client.query(`SELECT set_config('lock_timeout', '8000', true)`);
      await client.query(`SELECT set_config('statement_timeout', '20000', true)`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      if (!(await relationsPresent(client, PHASE3_BULKHEAD_RELATIONS))) {
        // Base tables may already exist from an earlier pass — always apply full IF NOT EXISTS SQL,
        // then the additive one-live-tank unique index for Assembly install uniqueness.
        await client.query(PHASE3_BULKHEAD_SQL);
        if (PHASE3_BULKHEAD_ONE_LIVE_TANK_SQL) await client.query(PHASE3_BULKHEAD_ONE_LIVE_TANK_SQL);
        created = true;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    if (created) log.log('[migration] Phase 3 bulkhead tables ready');
    return { created };
  } catch (err) {
    log.warn('[migration] Phase 3 bulkhead tables (noncritical, retried on next start):', err.message);
    return { created: false, error: err.message };
  }
}

/** Verify tank soft-delete columns + audit table exist (throws if missing after additive pass). */
async function ensureTankTrashSchema(client) {
  const { rows: colRows } = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'tanks'
       AND column_name = ANY($1::text[])`,
    [TANK_TRASH_COLUMNS]
  );
  const found = new Set(colRows.map((r) => r.column_name));
  const missing = TANK_TRASH_COLUMNS.filter((c) => !found.has(c));
  if (missing.length) {
    throw new Error(`Tank trash columns missing on tanks: ${missing.join(', ')}`);
  }
  const { rows: auditRows } = await client.query(
    `SELECT to_regclass('public.tank_admin_audit') AS reg`
  );
  if (!auditRows[0] || !auditRows[0].reg) {
    throw new Error('tank_admin_audit table is missing');
  }
}

/**
 * Run full required schema migration. Throws on required failure.
 * Fast-path: if all required tables already exist, skip lock + DDL + backfills.
 * Uses lock_timeout so serverless invocations cannot wait forever on advisory lock.
 */
async function runSchemaMigration(client, options = {}) {
  const log = options.log || console;
  const skipBackfills = Boolean(options.skipBackfills);
  const forceFull = Boolean(options.forceFull);

    if (!forceFull && (await allRequiredTablesExist(client))) {
      await runAdditiveSchemaPass(client, log);
      await ensureTankTrashSchema(client);
      log.log('[migration] schema already present — additive pass complete');
      return { skipped: true };
    }

  log.log('[migration] acquiring schema lock');
  await client.query(`SELECT set_config('lock_timeout', '8000', true)`);
  await client.query(`SELECT set_config('statement_timeout', '20000', true)`);

  let locked = false;
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHEMA_LOCK_KEY]);
    locked = Boolean(lockRes.rows[0] && lockRes.rows[0].ok);
    if (!locked) {
      // Another invoker is migrating — wait briefly, then accept existing schema.
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        if (await allRequiredTablesExist(client)) {
          await runAdditiveSchemaPass(client, log);
          await ensureTankTrashSchema(client);
          log.log('[migration] schema became ready while waiting for lock');
          return { skipped: true, waited: true };
        }
      }
      throw new Error('Could not acquire schema lock within timeout; schema not ready.');
    }

    // Re-check under lock (another process may have finished).
    if (await allRequiredTablesExist(client)) {
      await runAdditiveSchemaPass(client, log);
      await ensureTankTrashSchema(client);
      log.log('[migration] schema already present under lock — additive pass complete');
      return { skipped: true };
    }

    log.log('[migration] creating base tables');
    await client.query('BEGIN');
    try {
      await client.query(BASE_TABLES_SQL);

      log.log('[migration] creating junction tables');
      await client.query(JUNCTION_TABLES_SQL);

      log.log('[migration] creating extended tables');
      await client.query(EXTENDED_TABLES_SQL);

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

    await ensureEmployeeShopsSchema(client, log);
    await ensurePhase3DomeSchema(client, log);
    await ensurePhase3DomeSoftDelete(client, log);
    await ensurePhase3DomePieceInstall(client, log);
    await ensurePhase3BulkheadSchema(client, log);

    if (!skipBackfills) {
      await runOptionalBackfills(client, log);
    }

    log.log('[migration] schema complete');
    return { skipped: false };
  } finally {
    await client.query(`SELECT set_config('lock_timeout', '0', true)`).catch(() => {});
    await client.query(`SELECT set_config('statement_timeout', '0', true)`).catch(() => {});
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
    }
  }
}

async function runSchemaMigrationWithPool(pool, options = {}) {
  const client = await pool.connect();
  try {
    return await runSchemaMigration(client, options);
  } finally {
    client.release();
  }
}

module.exports = {
  SCHEMA_LOCK_KEY,
  REQUIRED_TABLES,
  BASE_TABLES_SQL,
  JUNCTION_TABLES_SQL,
  EXTENDED_TABLES_SQL,
  ADD_COLUMNS_SQL,
  INDEXES_SQL,
  TANK_TRASH_COLUMNS,
  runSchemaMigration,
  runSchemaMigrationWithPool,
  runAdditiveSchemaPass,
  ensureEmployeeShopsSchema,
  EMPLOYEE_SHOPS_SQL,
  ensurePhase3DomeSchema,
  ensurePhase3DomeSoftDelete,
  ensurePhase3DomePieceInstall,
  ensurePhase3BulkheadSchema,
  ensureTankTrashSchema,
  runOptionalBackfills,
  verifyRequiredTables,
  listRequiredTableStatus,
  allRequiredTablesExist,
};
