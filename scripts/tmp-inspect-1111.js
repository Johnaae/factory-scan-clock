'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { createPoolOptions } = require('./db-config');
const pg = require('pg');
const pool = new pg.Pool(createPoolOptions());

(async () => {
  const t = await pool.query(
    `SELECT id, tank_number, status, requires_test,
            fab_completed_at, assembly_started_at, assembly_completed_at,
            testing_started_at, testing_completed_at,
            wip_team_id, wip_machine_id, wip_phase_code, wip_phase_name,
            paused_reason, current_piece_number, piece_count, notes,
            updated_at, first_scanned_at, deleted_at
     FROM tanks
     WHERE TRIM(tank_number::text) = '1111'`
  );
  console.log('TANK', JSON.stringify(t.rows, null, 2));
  if (!t.rows[0]) {
    await pool.end();
    return;
  }
  const id = t.rows[0].id;

  const pieces = await pool.query(
    `SELECT piece_number, status, started_at, completed_at, machine_id, team_id
     FROM tank_pieces WHERE tank_id = $1 ORDER BY piece_number`,
    [id]
  );
  console.log('PIECES', JSON.stringify(pieces.rows, null, 2));

  const fails = await pool.query(
    `SELECT id, result, failure_note, attempted_at, previous_status
     FROM test_attempts
     WHERE tank_id = $1
     ORDER BY attempted_at DESC NULLS LAST, id DESC
     LIMIT 5`,
    [id]
  );
  console.log('FAILS', JSON.stringify(fails.rows, null, 2));

  const sess = await pool.query(
    `SELECT id, status, activity_code, activity_name, stop_reason,
            started_at, stopped_at, finished_at, piece_number, team_id, machine_id
     FROM machine_sessions
     WHERE tank_id = $1
     ORDER BY started_at DESC
     LIMIT 12`,
    [id]
  );
  console.log('SESSIONS', JSON.stringify(sess.rows, null, 2));

  const m = await pool.query(
    `SELECT id, name, active_tank_id, assigned_team_id, assigned_team_day
     FROM machines
     WHERE active_tank_id = $1
        OR id IN (SELECT DISTINCT machine_id FROM machine_sessions WHERE tank_id = $1)`,
    [id]
  );
  console.log('MACHINES', JSON.stringify(m.rows, null, 2));

  // Simulate FAB gate
  const row = t.rows[0];
  const st = String(row.status || '').trim().toLowerCase();
  const rework = st === 'rework_required';
  const fabDone =
    row.fab_completed_at != null ||
    st === 'ready_for_assembly' ||
    st === 'assembly_in_progress' ||
    st === 'ready_for_testing' ||
    st === 'testing_in_progress' ||
    st === 'ready_for_dome_install';
  console.log('GATE', { status: st, rework, fabDone, blocked: fabDone && !rework });

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (_e) {
    /* ignore */
  }
  process.exit(1);
});
