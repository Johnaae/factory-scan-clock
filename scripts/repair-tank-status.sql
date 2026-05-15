-- Safe one-time repair for legacy tank status values (run in Neon SQL editor if needed).
UPDATE tanks SET status = 'active'
WHERE status IS NULL
   OR TRIM(status) = ''
   OR LOWER(TRIM(status)) IN ('active', 'ACTIVE');

UPDATE tanks SET status = 'archived'
WHERE LOWER(TRIM(status)) IN ('archived', 'ARCHIVED', 'completed', 'COMPLETED');
