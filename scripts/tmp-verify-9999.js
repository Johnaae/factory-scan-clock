'use strict';
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');

async function main() {
  const pool = new Pool(createPoolOptions());
  try {
    const tank = (
      await pool.query(
        `SELECT tank_number, status, requires_test, testing_machine_id FROM tanks WHERE tank_number = $1`,
        ['9999']
      )
    ).rows[0];
    console.log('db', tank);

    // Simulate what /api/tanks?status=active returns for this tank
    const list = await pool.query(
      `SELECT tank_number, status FROM tanks
       WHERE tank_number = $1
         AND LOWER(TRIM(COALESCE(status, ''))) IN (
           'active', 'paused', 'waiting', '', 'ready_for_assembly', 'assembly_in_progress',
           'ready_for_testing', 'testing_in_progress', 'ready_for_dome_install',
           'ready_for_final_completion', 'rework_required'
         )`,
      ['9999']
    );
    console.log('active_list_includes', list.rows);

    const testingEligible = await pool.query(
      `SELECT tank_number, status FROM tanks
       WHERE tank_number = $1
         AND COALESCE(requires_test, FALSE) = TRUE
         AND LOWER(TRIM(status)) = 'ready_for_testing'
         AND testing_machine_id IS NULL`,
      ['9999']
    );
    console.log('testing_dropdown_includes', testingEligible.rows);

    const testingConfirmed = await pool.query(
      `SELECT tank_number, status FROM tanks
       WHERE tank_number = $1
         AND testing_machine_id IS NOT NULL
         AND LOWER(TRIM(status)) IN ('ready_for_testing', 'testing_in_progress')`,
      ['9999']
    );
    console.log('testing_on_kiosk_includes', testingConfirmed.rows);

    if (!tank || String(tank.status).toLowerCase() !== 'rework_required') {
      throw new Error(`expected rework_required, got ${tank && tank.status}`);
    }
    if (!list.rows.length) throw new Error('Manager active list missing rework_required tank');
    if (testingEligible.rows.length) throw new Error('Testing dropdown should exclude rework tank');
    if (testingConfirmed.rows.length) throw new Error('Testing on kiosk should exclude rework tank');
    console.log('PASS: tank 9999 rework_required + filters OK');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
