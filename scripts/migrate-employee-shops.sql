-- Employee Shop Assignment (permanent department eligibility).
-- Additive and idempotent: creates one new table, touches no existing rows or columns.
-- Existing employees start with no rows here (shown as "Unassigned"); nothing is guessed.
-- ON DELETE CASCADE only removes this table's own rows when an employee row is deleted,
-- so the existing employee delete keeps working; no other table is affected.

CREATE TABLE IF NOT EXISTS employee_shops (
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shop TEXT NOT NULL CHECK (shop IN ('Fabrication', 'Assembly', 'Dome')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, shop)
);

CREATE INDEX IF NOT EXISTS idx_employee_shops_shop ON employee_shops (shop);
