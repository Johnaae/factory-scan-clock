'use strict';

/**
 * Regression: multi-tank per winder + piece selection from piece_count.
 * Creates temporary tanks MTREG-A / MTREG-B only; cleans up afterward.
 */

require('./load-env');
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');
const { createPhase1ProductionLogic } = require('./phase1-production-logic');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const pool = new Pool(createPoolOptions());
  const phase1 = createPhase1ProductionLogic({
    pool,
    nowIso: () => new Date().toISOString(),
    normalizeTankNumber: (s) => String(s || '').trim().toUpperCase(),
    normalizeTankStatus: (s) => String(s || '').toLowerCase(),
    startEndOfLocalDay: () => null,
    localDateString: () => '2026-08-07',
    weekBoundsLocal: () => null,
    validateTankExists: async (n) => {
      const { rows } = await pool.query(
        `SELECT * FROM tanks WHERE UPPER(TRIM(tank_number)) = UPPER(TRIM($1)) LIMIT 1`,
        [n]
      );
      return rows[0] || null;
    },
  });

  const stamp = Date.now().toString(36).slice(-6);
  const tankANum = `MTREG-A-${stamp}`;
  const tankBNum = `MTREG-B-${stamp}`;
  let machineId = null;
  let teamId = null;
  let tankAId = null;
  let tankBId = null;

  try {
    const m = await pool.query(
      `SELECT id, name FROM machines WHERE active = 1 ORDER BY id ASC LIMIT 1`
    );
    assert(m.rows[0], 'Need an active machine');
    machineId = Number(m.rows[0].id);
    const machine = { id: machineId, name: m.rows[0].name, active: 1 };

    const t = await pool.query(`SELECT id, name, barcode FROM teams WHERE active = 1 ORDER BY id ASC LIMIT 1`);
    assert(t.rows[0], 'Need an active team');
    teamId = Number(t.rows[0].id);
    const team = { id: teamId, name: t.rows[0].name, barcode: t.rows[0].barcode, active: 1 };

    await phase1.assignTeamToMachine(machineId, team);

    // Inspect legacy tanks
    const legacy = await pool.query(
      `SELECT tank_number, piece_count FROM tanks WHERE tank_number IN ('1002','1111') ORDER BY tank_number`
    );
    console.log('Legacy tanks:', legacy.rows);

    const insA = await pool.query(
      `INSERT INTO tanks (tank_number, status, piece_count, current_piece_number, created_at, updated_at)
       VALUES ($1, 'waiting', 4, 1, NOW(), NOW()) RETURNING id, piece_count`,
      [tankANum]
    );
    tankAId = Number(insA.rows[0].id);
    await phase1.ensureTankPieces(tankAId, 4);
    const piecesA = await phase1.getTankPieces(tankAId);
    assert(piecesA.length >= 4, 'Tank A should have 4 piece rows');
    assert(Number(insA.rows[0].piece_count) === 4, 'Tank A piece_count=4');

    const insB = await pool.query(
      `INSERT INTO tanks (tank_number, status, piece_count, current_piece_number, created_at, updated_at)
       VALUES ($1, 'waiting', 2, 1, NOW(), NOW()) RETURNING id, piece_count`,
      [tankBNum]
    );
    tankBId = Number(insB.rows[0].id);
    await phase1.ensureTankPieces(tankBId, 2);
    assert(Number(insB.rows[0].piece_count) === 2, 'Tank B piece_count=2');

    // TEST 1: start Tank A needs explicit piece; start piece 3 Chop
    const needPiece = await phase1.startSession(machine, {
      team,
      tankNumber: tankANum,
      phaseRaw: 'PHASE:CHOP',
      pieceNumber: null,
    });
    assert(!needPiece.ok && needPiece.body && needPiece.body.error === 'need_piece', 'Must require piece when count>1');
    assert(Number(needPiece.body.piece_count) === 4, 'need_piece returns piece_count 4');

    const startA = await phase1.startSession(machine, {
      team,
      tankNumber: tankANum,
      phaseRaw: 'PHASE:CHOP',
      pieceNumber: 3,
    });
    assert(startA.ok, 'Start A piece 3: ' + JSON.stringify(startA.body));
    assert(Number(startA.body.current_piece) === 3, 'A running piece 3');

    // TEST 2: start Tank B without ending A
    const startB = await phase1.startSession(machine, {
      team,
      tankNumber: tankBNum,
      phaseRaw: 'PHASE:HOT_COAT',
      pieceNumber: 2,
    });
    assert(startB.ok, 'Start B piece 2: ' + JSON.stringify(startB.body));

    const open = await phase1.getOpenSessionsForMachine(machineId);
    const ours = open.filter((r) => String(r.tank_number).startsWith('MTREG-'));
    console.log(
      'Open sessions (ours):',
      ours.map((r) => ({
        tank: r.tank_number,
        piece: r.piece_number,
        phase: r.activity_name || r.activity_code,
      }))
    );
    assert(ours.length === 2, `Expected 2 MTREG open sessions, got ${ours.length}`);
    assert(
      ours.some((r) => String(r.tank_number) === tankANum) && ours.some((r) => String(r.tank_number) === tankBNum),
      'Both tanks must stay open'
    );

    const aRow = ours.find((r) => String(r.tank_number) === tankANum);
    const bRow = ours.find((r) => String(r.tank_number) === tankBNum);
    assert(Number(aRow.piece_number) === 3, 'A still piece 3');
    assert(Number(bRow.piece_number) === 2, 'B piece 2');

    // TEST 3: switch selected tank without closing the other
    await phase1.setMachineActiveTank(machineId, tankAId);
    let selected = await phase1.getOpenSession(machineId);
    assert(Number(selected.tank_id) === tankAId, 'Selected A');
    assert(
      (await phase1.getOpenSessionsForMachine(machineId)).filter((r) => String(r.tank_number).startsWith('MTREG-'))
        .length === 2,
      'Still 2 MTREG after select A'
    );

    await phase1.setMachineActiveTank(machineId, tankBId);
    selected = await phase1.getOpenSession(machineId);
    assert(Number(selected.tank_id) === tankBId, 'Selected B');
    assert(
      (await phase1.getOpenSessionsForMachine(machineId)).filter((r) => String(r.tank_number).startsWith('MTREG-'))
        .length === 2,
      'Still 2 MTREG after select B'
    );

    // Dashboard cards should list both under same machine
    const cards = await phase1.buildDashboardCards();
    const matching = (cards || []).filter(
      (c) => Number(c.machine_id) === machineId || Number(c.id) === machineId
    );
    const dashOurs = (await phase1.getOpenSessionsForMachine(machineId)).filter((r) =>
      String(r.tank_number).startsWith('MTREG-')
    );
    assert(dashOurs.length === 2, 'Dashboard source still has 2 MTREG open tanks');
    console.log('Dashboard cards for machine:', matching.length, 'open MTREG=', dashOurs.length);

    console.log('ALL TESTS PASSED');
  } finally {
    if (machineId) {
      await pool.query(
        `UPDATE machine_sessions SET status = 'finished', finished_at = NOW(), updated_at = NOW()
         WHERE machine_id = $1 AND status IN ('running','stopped')
           AND tank_id IN (SELECT id FROM tanks WHERE tank_number LIKE 'MTREG-%')`,
        [machineId]
      );
    }
    if (tankAId) {
      await pool.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [tankAId]);
      await pool.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [tankAId]);
      await pool.query(`DELETE FROM tanks WHERE id = $1`, [tankAId]);
    }
    if (tankBId) {
      await pool.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [tankBId]);
      await pool.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [tankBId]);
      await pool.query(`DELETE FROM tanks WHERE id = $1`, [tankBId]);
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message || err);
  process.exit(1);
});
