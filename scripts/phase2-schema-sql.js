'use strict';

/**
 * Phase 2 Assembly + Testing — additive PostgreSQL DDL (idempotent).
 * schema-migrate requires this module and runs the SQL in ADD_COLUMNS /
 * EXTENDED_TABLES / INDEXES / additive pass.
 *
 * Expected columns / tables:
 *
 * machines.workflow TEXT DEFAULT 'winding'  -- 'winding' | 'assembly_testing'
 *
 * tanks:
 *   fab_completed_at TIMESTAMPTZ
 *   assembly_started_at TIMESTAMPTZ
 *   assembly_completed_at TIMESTAMPTZ
 *   testing_started_at TIMESTAMPTZ
 *   testing_completed_at TIMESTAMPTZ
 *
 * stage_labor_sessions:
 *   id BIGSERIAL PK
 *   tank_id BIGINT NOT NULL REFERENCES tanks
 *   machine_id BIGINT NOT NULL REFERENCES machines
 *   team_id BIGINT REFERENCES teams
 *   stage TEXT NOT NULL CHECK (stage IN ('ASSEMBLY','TESTING','CORRECTION'))
 *   status TEXT NOT NULL CHECK (status IN ('active','stopped','finished'))
 *   started_at, ended_at, started_by_*, stopped_by_*, notes, created_at, updated_at
 *
 * stage_labor_participants:
 *   id, session_id, employee_id, employee_code, employee_name, team_id,
 *   joined_at, left_at, created_at
 *   UNIQUE partial: one open participation per employee (left_at IS NULL)
 *
 * test_attempts:
 *   id, tank_id, machine_id, team_id, team_name, result PASS|FAIL,
 *   attempted_at, tester_*, failure_note, labor_session_id, created_at
 *
 * Does NOT convert historical archived tanks. Machine workflow backfill only.
 */

const PHASE2_ADD_COLUMNS_SQL = `
ALTER TABLE machines ADD COLUMN IF NOT EXISTS workflow TEXT NOT NULL DEFAULT 'winding';

ALTER TABLE tanks ADD COLUMN IF NOT EXISTS fab_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_started_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_started_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_completed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS assembly_machine_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_machine_id BIGINT;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS testing_confirmed_at TIMESTAMPTZ;
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS requires_test BOOLEAN NOT NULL DEFAULT FALSE;
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
  result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  attempted_at TIMESTAMPTZ NOT NULL,
  tester_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  tester_employee_name TEXT,
  failure_note TEXT,
  labor_session_id BIGINT REFERENCES stage_labor_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const PHASE2_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_tank ON stage_labor_sessions(tank_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_machine ON stage_labor_sessions(machine_id, status);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_status ON stage_labor_sessions(status);
CREATE INDEX IF NOT EXISTS idx_stage_labor_sessions_active
  ON stage_labor_sessions(machine_id, tank_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_stage_labor_participants_session ON stage_labor_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_stage_labor_participants_employee ON stage_labor_participants(employee_id, joined_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_labor_participants_open_employee
  ON stage_labor_participants(employee_id)
  WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_test_attempts_tank ON test_attempts(tank_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_attempts_machine ON test_attempts(machine_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_machines_workflow ON machines(workflow) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_tanks_assembly_machine
  ON tanks(assembly_machine_id)
  WHERE assembly_machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tanks_testing_machine
  ON tanks(testing_machine_id)
  WHERE testing_machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tanks_assembly_status
  ON tanks(status)
  WHERE LOWER(TRIM(status)) IN (
    'ready_for_assembly',
    'assembly_in_progress',
    'ready_for_testing',
    'testing_in_progress',
    'ready_for_dome_install',
    'ready_for_final_completion'
  );
`;

/** Machine workflow only — never touch tank status / archived history. */
const PHASE2_BACKFILL_SQL = `
UPDATE machines SET workflow = 'winding' WHERE workflow IS NULL OR TRIM(workflow) = '';
UPDATE machines
SET workflow = 'winding'
WHERE LOWER(TRIM(COALESCE(workflow, ''))) NOT IN ('assembly_testing')
  AND (
    name ILIKE 'Winding%'
    OR UPPER(TRIM(code)) LIKE 'WM-%'
  );
`;

const PHASE2_REQUIRED_TABLES = [
  'stage_labor_sessions',
  'stage_labor_participants',
  'test_attempts',
];

module.exports = {
  PHASE2_ADD_COLUMNS_SQL,
  PHASE2_COLUMNS_SQL,
  PHASE2_TABLES_SQL,
  PHASE2_INDEXES_SQL,
  PHASE2_BACKFILL_SQL,
  PHASE2_REQUIRED_TABLES,
};
