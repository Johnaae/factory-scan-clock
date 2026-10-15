'use strict';
require('./load-env');
const { pool, closePool } = require('./db');
const {
  mapMachineForClient,
  normalizeMachineWorkflow,
} = require('./phase1-production-logic');

async function main() {
  const { rows } = await pool.query(
    `SELECT * FROM machines WHERE id = 152 OR kiosk_slug = 'qa-qc-kiosk-065628'`
  );
  for (const row of rows) {
    console.log('raw workflow:', JSON.stringify(row.workflow));
    console.log('normalized:', normalizeMachineWorkflow(row.workflow));
    console.log('mapped:', mapMachineForClient(row));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
