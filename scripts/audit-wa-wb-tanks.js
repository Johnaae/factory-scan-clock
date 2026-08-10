'use strict';

require('./load-env');
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');

(async () => {
  const pool = new Pool(createPoolOptions());

  const tanks = await pool.query(
    `SELECT *
     FROM tanks
     WHERE UPPER(TRIM(tank_number)) IN ('WA64594', 'WB64594')
        OR tank_number ILIKE '%64594%'
     ORDER BY id`
  );
  console.log('=== TANKS ===');
  console.log(JSON.stringify(tanks.rows, null, 2));

  for (const t of tanks.rows) {
    const sessions = await pool.query(
      `SELECT id, machine_id, team_id, activity_code, activity_name, status, started_at, finished_at,
              stop_reason, piece_number, created_at, updated_at
       FROM machine_sessions WHERE tank_id = $1 ORDER BY id`,
      [t.id]
    );
    const pieces = await pool.query(`SELECT * FROM tank_pieces WHERE tank_id = $1 ORDER BY piece_number`, [t.id]);
    const notes = await pool.query(
      `SELECT id, note_type, body, created_at
       FROM production_notes
       WHERE tank_id = $1 OR UPPER(TRIM(COALESCE(tank_number,''))) = UPPER(TRIM($2))
       ORDER BY id`,
      [t.id, t.tank_number]
    );
    const pce = await pool.query(
      `SELECT id, session_id, team_id, team_name, completed_at, piece_number, created_at
       FROM part_complete_events WHERE tank_id = $1 ORDER BY id`,
      [t.id]
    );
    console.log(`\n=== SESSIONS for ${t.tank_number} ===`);
    console.log(JSON.stringify(sessions.rows, null, 2));
    console.log(`\n=== PIECES for ${t.tank_number} ===`);
    console.log(JSON.stringify(pieces.rows, null, 2));
    console.log(`\n=== NOTES for ${t.tank_number} ===`);
    console.log(JSON.stringify(notes.rows, null, 2));
    console.log(`\n=== PART COMPLETE for ${t.tank_number} ===`);
    console.log(JSON.stringify(pce.rows, null, 2));
  }

  const near = await pool.query(
    `SELECT id, tank_number, description, status, created_at, updated_at, completed_at, first_scanned_at
     FROM tanks
     WHERE created_at >= TIMESTAMPTZ '2026-08-04 23:00:00+00'
       AND created_at <= TIMESTAMPTZ '2026-08-05 01:00:00+00'
     ORDER BY created_at`
  );
  console.log('\n=== TANKS CREATED around Aug 4 6-7PM CDT (23:00-01:00 UTC) ===');
  console.log(JSON.stringify(near.rows, null, 2));

  const testish = await pool.query(
    `SELECT id, tank_number, description, status, created_at
     FROM tanks
     WHERE description ILIKE '%test%'
        OR description ILIKE '%winder-pause%'
        OR description ILIKE '%piece-complete%'
        OR tank_number ~ '^(WA|WB|PC)[0-9]+$'
     ORDER BY created_at DESC
     LIMIT 50`
  );
  console.log('\n=== TEST-LIKE TANKS ===');
  console.log(JSON.stringify(testish.rows, null, 2));

  // Decode suffix: Date.now().toString().slice(-5) === '64594'
  // Find candidate timestamps ending in 64594
  console.log('\n=== SUFFIX ANALYSIS ===');
  console.log('64594 as Date.now() last 5 digits means epoch ms ending in 64594');
  // Around Aug 4 2026 18:24 CDT = 2026-08-04 23:24 UTC approx
  const approx = Date.parse('2026-08-04T23:24:00.000Z');
  console.log('Approx target ms:', approx, 'last5=', String(approx).slice(-5));
  for (let delta = -30 * 60 * 1000; delta <= 30 * 60 * 1000; delta += 1000) {
    const ms = approx + delta;
    if (String(ms).endsWith('64594')) {
      console.log('Matching epoch ms:', ms, '=>', new Date(ms).toISOString());
    }
  }

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
