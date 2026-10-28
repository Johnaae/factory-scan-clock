'use strict';

/**
 * Phase 3 — Dome Shop + Dome Inventory + Fabrication Dome Install.
 * New tables only; no existing table or column is altered.
 *
 * Links back to tanks / machine sessions / tank pieces use ON DELETE SET NULL (with
 * tank_number snapshots) so the existing permanent-delete tank tool keeps working and
 * installation history survives. dome_fabricators and dome_installation_sessions are
 * pure link tables and are removed with their parent row.
 */
const PHASE3_DOME_SQL = `
CREATE TABLE IF NOT EXISTS domes (
  id BIGSERIAL PRIMARY KEY,
  dome_number TEXT NOT NULL,
  dome_type TEXT CHECK (dome_type IS NULL OR dome_type IN ('Petro', 'Water')),
  diameter_ft INTEGER NOT NULL CHECK (diameter_ft IN (4, 6, 8, 10, 12)),
  weight_lbs NUMERIC(10,2) CHECK (weight_lbs IS NULL OR weight_lbs > 0),
  production_status TEXT NOT NULL DEFAULT 'created'
    CHECK (production_status IN ('created', 'in_progress', 'paused', 'completed')),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('lunch', 'end_shift')),
  inventory_status TEXT NOT NULL DEFAULT 'not_in_inventory'
    CHECK (inventory_status IN ('not_in_inventory', 'available', 'reserved', 'installed')),
  source TEXT NOT NULL DEFAULT 'kiosk' CHECK (source IN ('kiosk', 'manual')),
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  created_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  installed_at TIMESTAMPTZ,
  installed_tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  installed_tank_number TEXT,
  installed_piece_number INTEGER,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  deleted_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domes_number_unique
  ON domes (UPPER(TRIM(dome_number))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_domes_inventory ON domes (inventory_status, diameter_ft);
CREATE INDEX IF NOT EXISTS idx_domes_production ON domes (production_status, machine_id);
CREATE INDEX IF NOT EXISTS idx_domes_deleted_at ON domes (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS dome_fabricators (
  dome_id BIGINT NOT NULL REFERENCES domes(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dome_id, employee_id)
);

CREATE TABLE IF NOT EXISTS dome_labor_sessions (
  id BIGSERIAL PRIMARY KEY,
  dome_id BIGINT NOT NULL REFERENCES domes(id) ON DELETE RESTRICT,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'finished')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dome_labor_sessions_dome ON dome_labor_sessions (dome_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dome_labor_sessions_one_active
  ON dome_labor_sessions (dome_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS dome_labor_participants (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES dome_labor_sessions(id) ON DELETE RESTRICT,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT,
  employee_name TEXT,
  hourly_rate NUMERIC(10,2),
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dome_labor_participants_session ON dome_labor_participants (session_id);
CREATE INDEX IF NOT EXISTS idx_dome_labor_participants_employee
  ON dome_labor_participants (employee_id, joined_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dome_labor_participants_open_employee
  ON dome_labor_participants (employee_id) WHERE left_at IS NULL AND employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dome_installations (
  id BIGSERIAL PRIMARY KEY,
  dome_id BIGINT NOT NULL REFERENCES domes(id) ON DELETE RESTRICT,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  tank_number TEXT NOT NULL,
  piece_number INTEGER NOT NULL CHECK (piece_number BETWEEN 1 AND 8),
  piece_id BIGINT REFERENCES tank_pieces(id) ON DELETE SET NULL,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'installed', 'cancelled')),
  current_session_id BIGINT REFERENCES machine_sessions(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dome_installations_one_live
  ON dome_installations (dome_id) WHERE status IN ('in_progress', 'installed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_dome_installations_one_live_piece
  ON dome_installations (tank_id, piece_number)
  WHERE status IN ('in_progress', 'installed') AND tank_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dome_installations_tank ON dome_installations (tank_id, status);

CREATE TABLE IF NOT EXISTS dome_installation_sessions (
  installation_id BIGINT NOT NULL REFERENCES dome_installations(id) ON DELETE CASCADE,
  machine_session_id BIGINT NOT NULL REFERENCES machine_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (installation_id, machine_session_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dome_installation_sessions_session
  ON dome_installation_sessions (machine_session_id);

CREATE TABLE IF NOT EXISTS dome_events (
  id BIGSERIAL PRIMARY KEY,
  dome_id BIGINT NOT NULL REFERENCES domes(id) ON DELETE RESTRICT,
  event TEXT NOT NULL,
  details JSONB,
  performed_by TEXT,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dome_events_dome ON dome_events (dome_id, performed_at);

CREATE TABLE IF NOT EXISTS tank_dome_completion_overrides (
  id BIGSERIAL PRIMARY KEY,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  tank_number TEXT NOT NULL,
  reason TEXT NOT NULL,
  performed_by TEXT,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tank_dome_completion_overrides_tank
  ON tank_dome_completion_overrides (tank_id, performed_at);
`;

/** Soft-delete columns on domes (additive; safe on existing production rows). */
const PHASE3_DOME_SOFT_DELETE_SQL = `
ALTER TABLE domes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE domes ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE domes ADD COLUMN IF NOT EXISTS deleted_reason TEXT;
DROP INDEX IF EXISTS idx_domes_number_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_domes_number_unique
  ON domes (UPPER(TRIM(dome_number))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_domes_deleted_at ON domes (deleted_at) WHERE deleted_at IS NOT NULL;
`;

/**
 * Multi-piece Dome Install — additive index only.
 * One live install per (tank_id, piece_number). Does NOT drop anything.
 * Companion JS (ensurePhase3DomePieceInstall) creates this first, then safely drops any
 * obsolete tank-only unique index, while preserving idx_dome_installations_one_live on dome_id.
 */
const PHASE3_DOME_PIECE_INSTALL_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_dome_installations_one_live_piece
  ON dome_installations (tank_id, piece_number)
  WHERE status IN ('in_progress', 'installed') AND tank_id IS NOT NULL;
`;

/** Dome-id uniqueness (one live install per inventory dome). Kept separate for recreate-if-wrong. */
const PHASE3_DOME_ONE_LIVE_DOME_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_dome_installations_one_live
  ON dome_installations (dome_id) WHERE status IN ('in_progress', 'installed');
`;

/**
 * Phase 3 — Bulkhead production + inventory (Dome Shop). New tables only.
 * Mirrors dome labor patterns; inventory is separate from Dome Inventory.
 */
const PHASE3_BULKHEAD_SQL = `
CREATE TABLE IF NOT EXISTS bulkheads (
  id BIGSERIAL PRIMARY KEY,
  bulkhead_number TEXT NOT NULL,
  production_status TEXT NOT NULL DEFAULT 'created'
    CHECK (production_status IN ('created', 'in_progress', 'paused', 'completed')),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('lunch', 'end_shift')),
  inventory_status TEXT NOT NULL DEFAULT 'not_in_inventory'
    CHECK (inventory_status IN ('not_in_inventory', 'available', 'assigned', 'installed')),
  source TEXT NOT NULL DEFAULT 'kiosk' CHECK (source IN ('kiosk', 'manual')),
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  created_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  installed_at TIMESTAMPTZ,
  installed_tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  installed_tank_number TEXT,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  deleted_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulkheads_number_unique
  ON bulkheads (UPPER(TRIM(bulkhead_number))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bulkheads_inventory ON bulkheads (inventory_status, production_status);
CREATE INDEX IF NOT EXISTS idx_bulkheads_production ON bulkheads (production_status, machine_id);
CREATE INDEX IF NOT EXISTS idx_bulkheads_deleted_at ON bulkheads (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS bulkhead_workers (
  bulkhead_id BIGINT NOT NULL REFERENCES bulkheads(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bulkhead_id, employee_id)
);

CREATE TABLE IF NOT EXISTS bulkhead_labor_sessions (
  id BIGSERIAL PRIMARY KEY,
  bulkhead_id BIGINT NOT NULL REFERENCES bulkheads(id) ON DELETE RESTRICT,
  machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'finished')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bulkhead_labor_sessions_bh ON bulkhead_labor_sessions (bulkhead_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulkhead_labor_sessions_one_active
  ON bulkhead_labor_sessions (bulkhead_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS bulkhead_labor_participants (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES bulkhead_labor_sessions(id) ON DELETE RESTRICT,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT,
  employee_name TEXT,
  hourly_rate NUMERIC(10,2),
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bulkhead_labor_participants_session ON bulkhead_labor_participants (session_id);
CREATE INDEX IF NOT EXISTS idx_bulkhead_labor_participants_employee
  ON bulkhead_labor_participants (employee_id, joined_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulkhead_labor_participants_open_employee
  ON bulkhead_labor_participants (employee_id) WHERE left_at IS NULL AND employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bulkhead_events (
  id BIGSERIAL PRIMARY KEY,
  bulkhead_id BIGINT NOT NULL REFERENCES bulkheads(id) ON DELETE RESTRICT,
  event TEXT NOT NULL,
  details JSONB,
  performed_by TEXT,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bulkhead_events_bh ON bulkhead_events (bulkhead_id, performed_at);

CREATE TABLE IF NOT EXISTS bulkhead_assignments (
  id BIGSERIAL PRIMARY KEY,
  bulkhead_id BIGINT NOT NULL REFERENCES bulkheads(id) ON DELETE RESTRICT,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  tank_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('assigned', 'installed', 'cancelled')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  installed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  performed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulkhead_assignments_one_live
  ON bulkhead_assignments (bulkhead_id) WHERE status IN ('assigned', 'installed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulkhead_assignments_one_live_tank
  ON bulkhead_assignments (tank_id) WHERE status IN ('assigned', 'installed') AND tank_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bulkhead_assignments_tank ON bulkhead_assignments (tank_id, status);
`;

/** Additive index for one live bulkhead per tank (existing DBs that already have bulkhead tables). */
const PHASE3_BULKHEAD_ONE_LIVE_TANK_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulkhead_assignments_one_live_tank
  ON bulkhead_assignments (tank_id) WHERE status IN ('assigned', 'installed') AND tank_id IS NOT NULL;
`;

/** Every relation PHASE3_DOME_SQL creates; all present = nothing to do. */
const PHASE3_DOME_RELATIONS = [
  'domes',
  'idx_domes_number_unique',
  'idx_domes_inventory',
  'idx_domes_production',
  'dome_fabricators',
  'dome_labor_sessions',
  'idx_dome_labor_sessions_dome',
  'idx_dome_labor_sessions_one_active',
  'dome_labor_participants',
  'idx_dome_labor_participants_session',
  'idx_dome_labor_participants_employee',
  'idx_dome_labor_participants_open_employee',
  'dome_installations',
  'idx_dome_installations_one_live',
  'idx_dome_installations_one_live_piece',
  'idx_dome_installations_tank',
  'dome_installation_sessions',
  'idx_dome_installation_sessions_session',
  'dome_events',
  'idx_dome_events_dome',
  'tank_dome_completion_overrides',
  'idx_tank_dome_completion_overrides_tank',
];

const PHASE3_BULKHEAD_RELATIONS = [
  'bulkheads',
  'idx_bulkheads_number_unique',
  'idx_bulkheads_inventory',
  'idx_bulkheads_production',
  'bulkhead_workers',
  'bulkhead_labor_sessions',
  'idx_bulkhead_labor_sessions_bh',
  'idx_bulkhead_labor_sessions_one_active',
  'bulkhead_labor_participants',
  'idx_bulkhead_labor_participants_session',
  'idx_bulkhead_labor_participants_employee',
  'idx_bulkhead_labor_participants_open_employee',
  'bulkhead_events',
  'idx_bulkhead_events_bh',
  'bulkhead_assignments',
  'idx_bulkhead_assignments_one_live',
  'idx_bulkhead_assignments_one_live_tank',
  'idx_bulkhead_assignments_tank',
];

const DOME_DIAMETERS_FT = [4, 6, 8, 10, 12];
const DOME_TYPES = ['Petro', 'Water'];

module.exports = {
  PHASE3_DOME_SQL,
  PHASE3_DOME_SOFT_DELETE_SQL,
  PHASE3_DOME_PIECE_INSTALL_SQL,
  PHASE3_DOME_ONE_LIVE_DOME_SQL,
  PHASE3_DOME_RELATIONS,
  PHASE3_BULKHEAD_SQL,
  PHASE3_BULKHEAD_ONE_LIVE_TANK_SQL,
  PHASE3_BULKHEAD_RELATIONS,
  DOME_DIAMETERS_FT,
  DOME_TYPES,
};
