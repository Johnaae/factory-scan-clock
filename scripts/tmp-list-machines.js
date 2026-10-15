'use strict';

/** READ-ONLY: list machines (no PIN hashes). */

require('./load-env');
const { pool, closePool } = require('./db');

pool
  .query(`SELECT id, name, kiosk_slug, workflow, active, (pin_hash IS NOT NULL) AS has_pin FROM machines ORDER BY id`)
  .then(({ rows }) => rows.forEach((r) => console.log(JSON.stringify(r))))
  .catch((err) => console.error('FAILED:', err.message))
  .finally(() => closePool());
