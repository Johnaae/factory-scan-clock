'use strict';
require('./load-env');
const { pool, closePool } = require('./db');
pool
  .query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name IN ('employees','teams','machines','tanks')
     ORDER BY table_name, ordinal_position`
  )
  .then((r) => {
    for (const row of r.rows) console.log(`${row.table_name}.${row.column_name}`);
  })
  .finally(() => closePool());
