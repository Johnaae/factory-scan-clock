'use strict';

/**
 * Regression: Piece Complete must keep tank Active; only Tank Complete archives.
 */
require('./load-env');
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');
const { createPhase1ProductionLogic } = require('./phase1-production-logic');

(async () => {
  const pool = new Pool(createPoolOptions());
  const nowIso = () => new Date().toISOString();
  const normalizeTankNumber = (v) => String(v || '').trim().toUpperCase();
  const normalizeTankStatus = (s) => {
    const x = String(s || 'active').toLowerCase().trim();
    if (x === 'archived' || x === 'completed') return 'archived';
    if (x === 'waiting') return 'waiting';
    if (x === 'paused') return 'paused';
    return 'active';
  };
  const localDateString = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const startEndOfLocalDay = (date) => {
    const [y, m, dd] = String(date).split('-').map(Number);
    const start = new Date(y, m - 1, dd, 0, 0, 0, 0);
    const end = new Date(y, m - 1, dd, 23, 59, 59, 999);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  };
  const weekBoundsLocal = () => startEndOfLocalDay(localDateString());

  async function ensureTankExists(raw) {
    const tankNumber = normalizeTankNumber(raw);
    if (!tankNumber) return null;
    let { rows } = await pool.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`, [
      tankNumber,
    ]);
    if (rows[0]) return rows[0];
    const ts = nowIso();
    await pool.query(
      `INSERT INTO tanks (tank_number, description, status, created_at, updated_at, piece_count, current_piece_number)
       VALUES ($1, 'piece-complete-test', 'waiting', $2::timestamptz, $2::timestamptz, 1, 1)
       ON CONFLICT (tank_number) DO NOTHING`,
      [tankNumber, ts]
    );
    ({ rows } = await pool.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`, [tankNumber]));
    return rows[0] || null;
  }

  const phase1 = createPhase1ProductionLogic({
    pool,
    nowIso,
    normalizeTankNumber,
    ensureTankExists,
    normalizeTankStatus,
    startEndOfLocalDay,
    localDateString,
    weekBoundsLocal,
  });

  const machines = await phase1.fetchCanonicalWindingMachines();
  if (!machines.length) throw new Error('No winding machines');
  const machine = machines[0];

  let team = (await pool.query(`SELECT id, name, barcode, active FROM teams WHERE active = 1 ORDER BY id ASC LIMIT 1`))
    .rows[0];
  if (!team) {
    const ins = await pool.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at)
       VALUES ('Test Team PC', 'TEAM_TEST_PC', 1, NOW(), NOW()) RETURNING id, name, barcode, active`
    );
    team = ins.rows[0];
  }

  const tankNumber = `PC${Date.now().toString().slice(-6)}`;
  const tank = await ensureTankExists(tankNumber);
  await pool.query(`UPDATE tanks SET piece_count = 1, status = 'waiting', completed_at = NULL WHERE id = $1`, [
    tank.id,
  ]);

  const start = await phase1.startSession(machine, {
    team: { id: team.id, name: team.name, barcode: team.barcode, active: 1 },
    tankNumber,
    phaseRaw: 'PHASE:CHOP',
  });
  if (!start.ok) throw new Error(`start failed: ${JSON.stringify(start.body)}`);

  const piece = await phase1.changePhase(machine, 'PHASE:PIECE_COMPLETE');
  if (!piece.ok) throw new Error(`piece complete failed: ${JSON.stringify(piece.body)}`);
  if (piece.body.tank_complete) throw new Error('Piece Complete incorrectly set tank_complete=true');
  if (piece.body.action !== 'piece_complete') throw new Error(`unexpected action ${piece.body.action}`);

  const afterPiece = await pool.query(`SELECT status, completed_at FROM tanks WHERE id = $1`, [tank.id]);
  const st1 = normalizeTankStatus(afterPiece.rows[0].status);
  if (st1 === 'archived') {
    throw new Error('FAIL: Piece Complete archived the tank (status=archived)');
  }
  if (afterPiece.rows[0].completed_at) {
    throw new Error('FAIL: Piece Complete set completed_at');
  }
  console.log('OK Piece Complete keeps tank Active:', st1);

  // Restart a phase so Tank Complete has an open session
  const start2 = await phase1.startSession(machine, {
    team: { id: team.id, name: team.name, barcode: team.barcode, active: 1 },
    tankNumber,
    phaseRaw: 'PHASE:CHOP',
  });
  if (!start2.ok) throw new Error(`restart failed: ${JSON.stringify(start2.body)}`);

  const tankDone = await phase1.changePhase(machine, 'PHASE:TANK_COMPLETE');
  if (!tankDone.ok) throw new Error(`tank complete failed: ${JSON.stringify(tankDone.body)}`);
  if (!tankDone.body.tank_complete) throw new Error('Tank Complete did not set tank_complete');

  const afterTank = await pool.query(`SELECT status, completed_at FROM tanks WHERE id = $1`, [tank.id]);
  const st2 = normalizeTankStatus(afterTank.rows[0].status);
  if (st2 !== 'archived') throw new Error(`FAIL: Tank Complete status=${st2}, expected archived`);
  if (!afterTank.rows[0].completed_at) throw new Error('FAIL: Tank Complete missing completed_at');
  console.log('OK Tank Complete archives tank:', st2);

  // Remove temporary test tank created by this script only.
  await pool.query(`UPDATE machines SET active_tank_id = NULL WHERE active_tank_id = $1`, [tank.id]);
  await pool.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [tank.id]);
  await pool.query(`DELETE FROM part_complete_events WHERE tank_id = $1`, [tank.id]);
  await pool.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [tank.id]);
  await pool.query(`DELETE FROM production_notes WHERE tank_id = $1`, [tank.id]);
  await pool.query(`DELETE FROM tanks WHERE id = $1 AND description = 'piece-complete-test'`, [tank.id]);
  console.log('OK cleaned up test tank', tankNumber);

  await pool.end();
  console.log('PASS piece-complete vs tank-complete status sync');
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
