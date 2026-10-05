'use strict';

/**
 * Phase 2 Assembly + Testing — additive PostgreSQL DDL (idempotent).
 * schema-migrate requires this module and runs the SQL in ADD_COLUMNS /
 * EXTENDED_TABLES / INDEXES / additive pass.
 *
 * Tables must be CREATED before ALTER TABLE statements that target them.
 *
 * workflows:
 *   machines.workflow: 'winding' | 'assembly_testing' | 'qa_testing'
 *
 * Multi-team Assembly presence is tracked in assembly_kiosk_teams (not by
 * replacing machines.assigned_team_id for other teams).
 * Several teams may work the same tank: assembly_tank_teams holds one row per
 * (tank, team) Assembly assignment; the tank completes Assembly only when no
 * 'active' assignment remains.
 */

const PHASE2_ADD_COLUMNS_SQL = `
ALTER TABLE machines ADD COLUMN IF NOT EXISTS workflow TEXT NOT NULL DEFAULT 'winding';

ALTER TABLE tanks ADD COLUMN IF NOT EXISTS fab_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_started_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_started_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_machine_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_team_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_machine_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_confirmed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS requires_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS last_rework_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS qa_started_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS qa_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS qa_machine_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS qa_result TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS qa_failure_note TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS qa_user_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS qa_user_name TEXT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_removed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_restored_at TIMESTAMPTZ;

ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS previous_status TEXT;
ALTER TABLE test_attempts ALTER COLUMN result DROP NOT NULL;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS test_type TEXT;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS attempt_status TEXT;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS vacuum_start_inhg NUMERIC(10,3);
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS vacuum_end_inhg NUMERIC(10,3);
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS brine_expected_amount NUMERIC(12,3);
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS brine_actual_amount NUMERIC(12,3);
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS tester_user_id BIGINT;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS tester_user_name TEXT;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS parent_attempt_id BIGINT;

ALTER TABLE assembly_kiosk_teams ADD COLUMN IF NOT EXISTS lunch_paused_at TIMESTAMPTZ;
ALTER TABLE assembly_kiosk_teams ADD COLUMN IF NOT EXISTS status TEXT;
`;

/** Alias used by existing schema-migrate ADD_COLUMNS_SQL embedding. */
const PHASE2_COLUMNS_SQL = PHASE2_ADD_COLUMNS_SQL;

const PHASE2_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS stage_labor_sessions (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE RESTRICT,
  machine_id BIGINT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
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
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employee_code TEXT,
  employee_name TEXT,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_attempts (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE RESTRICT,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  team_name TEXT,
  result TEXT CHECK (result IS NULL OR result IN ('PASS', 'FAIL')),
  attempted_at TIMESTAMPTZ NOT NULL,
  tester_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  tester_employee_name TEXT,
  failure_note TEXT,
  labor_session_id BIGINT REFERENCES stage_labor_sessions(id) ON DELETE SET NULL,
  previous_status TEXT,
  test_type TEXT,
  attempt_status TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  vacuum_start_inhg NUMERIC(10,3),
  vacuum_end_inhg NUMERIC(10,3),
  brine_expected_amount NUMERIC(12,3),
  brine_actual_amount NUMERIC(12,3),
  tester_user_id BIGINT,
  tester_user_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_attempt_notes (
  id BIGSERIAL PRIMARY KEY,
  test_attempt_id BIGINT NOT NULL REFERENCES test_attempts(id) ON DELETE CASCADE,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  author_user_id BIGINT,
  author_user_name TEXT,
  author_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  author_employee_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assembly_kiosk_teams (
  id BIGSERIAL PRIMARY KEY,
  machine_id BIGINT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  lunch_paused_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assembly_tank_teams (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tank_admin_phase2_audit (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  tank_id BIGINT,
  tank_number TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  previous_status TEXT,
  next_status TEXT,
  details JSONB
);
`;

const PHASE2_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_tank ON stage_labor_sessions(tank_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_machine ON stage_labor_sessions(machine_id, status);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_status ON stage_labor_sessions(status);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_active
  ON stage_labor_sessions(machine_id, tank_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_team
  ON stage_labor_sessions(machine_id, team_id, status);
CREATE INDEX IF NOT EXISTS idx_stage_labor_participants_session ON stage_labor_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_stage_labor_participants_employee ON stage_labor_participants(employee_id, joined_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_labor_participants_open_employee
  ON stage_labor_participants(employee_id)
  WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_test_attempts_tank ON test_attempts(tank_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_attempts_machine ON test_attempts(machine_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_attempts_type ON test_attempts(tank_id, test_type, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_attempts_parent ON test_attempts(parent_attempt_id)
  WHERE parent_attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_test_attempt_notes_attempt ON test_attempt_notes(test_attempt_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_machines_workflow ON machines(workflow) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_tanks_assembly_machine
  ON tanks(assembly_machine_id)
  WHERE assembly_machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tanks_assembly_team
  ON tanks(assembly_team_id)
  WHERE assembly_team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tanks_testing_machine
  ON tanks(testing_machine_id)
  WHERE testing_machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tanks_assembly_status
  ON tanks(status)
  WHERE LOWER(TRIM(status)) IN (
    'ready_for_assembly',
    'assembly_in_progress',
    'ready_for_qa',
    'qa_in_progress',
    'qa_failed',
    'ready_for_testing',
    'testing_in_progress',
    'ready_for_dome_install',
    'ready_for_final_completion',
    'rework_required'
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_assembly_kiosk_teams_open
  ON assembly_kiosk_teams(machine_id, team_id)
  WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assembly_kiosk_teams_machine
  ON assembly_kiosk_teams(machine_id, joined_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assembly_tank_teams_active
  ON assembly_tank_teams(tank_id, team_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_assembly_tank_teams_team
  ON assembly_tank_teams(team_id, status);
CREATE INDEX IF NOT EXISTS idx_assembly_tank_teams_tank
  ON assembly_tank_teams(tank_id, status);
CREATE INDEX IF NOT EXISTS idx_tank_admin_phase2_audit_tank
  ON tank_admin_phase2_audit(tank_number, performed_at DESC);
`;

/** Machine workflow only — never touch tank status / archived history. */
const PHASE2_BACKFILL_SQL = `
UPDATE machines SET workflow = 'winding' WHERE workflow IS NULL OR TRIM(workflow) = '';
UPDATE machines
SET workflow = 'winding'
WHERE LOWER(TRIM(COALESCE(workflow, ''))) NOT IN ('assembly_testing', 'qa_testing')
  AND (
    name ILIKE 'Winding%'
    OR UPPER(TRIM(code)) LIKE 'WM-%'
  );
UPDATE test_attempts
SET test_type = COALESCE(NULLIF(TRIM(test_type), ''), 'LEGACY'),
    attempt_status = COALESCE(
      NULLIF(TRIM(attempt_status), ''),
      CASE
        WHEN UPPER(TRIM(COALESCE(result, ''))) = 'PASS' THEN 'passed'
        WHEN UPPER(TRIM(COALESCE(result, ''))) = 'FAIL' THEN 'failed'
        ELSE 'recorded'
      END
    ),
    started_at = COALESCE(started_at, attempted_at),
    completed_at = COALESCE(completed_at, attempted_at)
WHERE test_type IS NULL OR attempt_status IS NULL OR started_at IS NULL;
`;

const PHASE2_REQUIRED_TABLES = [
  'stage_labor_sessions',
  'stage_labor_participants',
  'test_attempts',
  'test_attempt_notes',
  'assembly_kiosk_teams',
  'assembly_tank_teams',
];

module.exports = {
  PHASE2_ADD_COLUMNS_SQL,
  PHASE2_COLUMNS_SQL,
  PHASE2_TABLES_SQL,
  PHASE2_INDEXES_SQL,
  PHASE2_BACKFILL_SQL,
  PHASE2_REQUIRED_TABLES,
};
