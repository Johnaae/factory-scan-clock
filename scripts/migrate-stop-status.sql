-- Phase 1: allow STOP status on scan_logs (backward compatible)
-- Run once on Neon: psql $DATABASE_URL -f scripts/migrate-stop-status.sql

ALTER TABLE scan_logs DROP CONSTRAINT IF EXISTS scan_logs_status_check;
ALTER TABLE scan_logs ADD CONSTRAINT scan_logs_status_check CHECK (status IN ('IN', 'OUT', 'STOP'));
