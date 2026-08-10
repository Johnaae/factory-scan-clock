'use strict';

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
    return {
      startIso: new Date(y, m - 1, dd, 0, 0, 0, 0).toISOString(),
      endIso: new Date(y, m - 1, dd, 23, 59, 59, 999).toISOString(),
    };
  };
  const weekBoundsLocal = () => startEndOfLocalDay(localDateString());

  async function ensureTankExists(raw) {
    const tankNumber = normalizeTankNumber(raw);
    let { rows } = await pool.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`, [tankNumber]);
    if (rows[0]) return rows[0];
    const ts = nowIso();
    await pool.query(
      `INSERT INTO tanks (tank_number, description, status, created_at, updated_at, piece_count, current_piece_number)
       VALUES ($1, 'winder-pause-test', 'waiting', $2::timestamptz, $2::timestamptz, 1, 1)
       ON CONFLICT (tank_number) DO NOTHING`,
      [tankNumber, ts]
    );
    ({ rows } = await pool.query(`SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = $1 LIMIT 1`, [tankNumber]));
    return rows[0];
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

  const machine = (await phase1.fetchCanonicalWindingMachines())[0];
  const team = (await pool.query(`SELECT id, name, barcode, active FROM teams WHERE active = 1 ORDER BY id ASC LIMIT 1`))
    .rows[0];
  if (!machine || !team) throw new Error('Need machine + team');

  const leftovers = await phase1.getOpenSessionsForMachine(machine.id);
  for (const row of leftovers) {
    await pool.query(
      `UPDATE machine_sessions SET status = 'finished', finished_at = COALESCE(stopped_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
  }
  await pool.query(`UPDATE machines SET active_tank_id = NULL WHERE id = $1`, [machine.id]);

  const suffix = Date.now().toString().slice(-5);
  const tA = `WA${suffix}`;
  const tB = `WB${suffix}`;
  await ensureTankExists(tA);
  await ensureTankExists(tB);

  const teamObj = { id: team.id, name: team.name, barcode: team.barcode, active: 1 };
  const s1 = await phase1.startSession(machine, { team: teamObj, tankNumber: tA, phaseRaw: 'PHASE:CHOP' });
  const s2 = await phase1.startSession(machine, { team: teamObj, tankNumber: tB, phaseRaw: 'PHASE:HOT_COAT' });
  if (!s1.ok || !s2.ok) throw new Error('start failed');

  const preview = await phase1.pauseSession(machine, 'STOP:BREAK', {});
  if (!preview.ok || preview.body.action !== 'pause') throw new Error('expected immediate pause');
  if (preview.body.action === 'need_winder_confirmation') throw new Error('confirmation should be removed');
  if (preview.body.tank_count !== 2) throw new Error(`expected 2 tanks, got ${preview.body.tank_count}`);

  const pause = preview;
  if (!pause.ok || pause.body.action !== 'pause') throw new Error('pause failed');
  const openPaused = await phase1.getOpenSessionsForMachine(machine.id);
  if (openPaused.length !== 2) throw new Error(`expected 2 open after pause, got ${openPaused.length}`);
  for (const row of openPaused) {
    if (row.status !== 'stopped' || String(row.stop_reason) !== 'break') {
      throw new Error(`tank ${row.tank_number} not on break: ${row.status}/${row.stop_reason}`);
    }
  }
  console.log('OK Break applied to both tanks');

  const resume = await phase1.resumeSession(machine, {});
  if (!resume.ok) throw new Error('resume failed');
  const openRun = await phase1.getOpenSessionsForMachine(machine.id);
  const byTank = Object.fromEntries(openRun.map((r) => [r.tank_number, r]));
  if (byTank[tA].status !== 'running' || String(byTank[tA].activity_code).toUpperCase() !== 'CHOP') {
    throw new Error('Tank A did not resume Chop');
  }
  if (byTank[tB].status !== 'running' || String(byTank[tB].activity_code).toUpperCase() !== 'HOT_COAT') {
    throw new Error('Tank B did not resume Hot Coat');
  }
  console.log('OK Resume restored Chop and Hot Coat independently');

  await phase1.pauseSession(machine, 'STOP:LUNCH', {});
  const lunchRows = await phase1.getOpenSessionsForMachine(machine.id);
  for (const row of lunchRows) {
    if (String(row.stop_reason) !== 'lunch') throw new Error('lunch not applied');
  }
  console.log('OK Lunch applied to both tanks');

  const end = await phase1.endShiftSession(machine, {});
  if (!end.ok || end.body.tank_count !== 2) throw new Error('end shift failed');
  const afterEnd = await phase1.getOpenSessionsForMachine(machine.id);
  if (afterEnd.length) throw new Error('open sessions remain after end shift');
  const tanks = await pool.query(
    `SELECT tank_number, status, paused_reason, wip_phase_code FROM tanks WHERE tank_number = ANY($1::text[])`,
    [[tA, tB]]
  );
  for (const row of tanks.rows) {
    if (normalizeTankStatus(row.status) !== 'paused' || row.paused_reason !== 'end_shift') {
      throw new Error(`tank ${row.tank_number} not end-shift paused`);
    }
    if (!row.wip_phase_code) throw new Error(`tank ${row.tank_number} missing WIP phase`);
  }
  console.log('OK End Shift paused both tanks with phases preserved');

  // Remove temporary test tanks created by this script only.
  for (const num of [tA, tB]) {
    const { rows } = await pool.query(
      `SELECT id FROM tanks WHERE tank_number = $1 AND description = 'winder-pause-test'`,
      [num]
    );
    if (!rows[0]) continue;
    const id = rows[0].id;
    await pool.query(`UPDATE machines SET active_tank_id = NULL WHERE active_tank_id = $1`, [id]);
    await pool.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM part_complete_events WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM production_notes WHERE tank_id = $1`, [id]);
    await pool.query(`DELETE FROM tanks WHERE id = $1 AND description = 'winder-pause-test'`, [id]);
  }
  console.log('OK cleaned up test tanks', tA, tB);

  await pool.end();
  console.log('PASS winder-level break/lunch/resume/end-shift');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
