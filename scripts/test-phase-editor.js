'use strict';

/**
 * Phase editor: edit Piece 3 Rib Install without changing Piece 1 Hot Coat.
 */
require('./load-env');
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');
const { createPhase1ProductionLogic } = require('./phase1-production-logic');
const { createTeamMembershipAndLabor } = require('./team-membership-labor');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const pool = new Pool(createPoolOptions());
  const nowIso = () => new Date().toISOString();
  const phase1 = createPhase1ProductionLogic({
    pool,
    nowIso,
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
  const mem = createTeamMembershipAndLabor(pool, {
    nowIso,
    sessionElapsedMs: phase1.sessionElapsedMs,
    isProductionPhaseCode: () => true,
    roundHours2: (n) => Math.round(n * 100) / 100,
    formatDurationSummary: (ms) => `${Math.round(ms / 60000)}m`,
  });

  const stamp = Date.now().toString(36).slice(-5);
  const tankNum = `PEDIT-${stamp}`;
  let tankId;
  let s1;
  let s3;
  let machineId;
  let teamId;

  try {
    // Ensure audit columns exist
    await pool.query(`ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS tank_id BIGINT`);
    await pool.query(`ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS piece_id BIGINT`);
    await pool.query(`ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS piece_number INTEGER`);
    await pool.query(`ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS phase_code TEXT`);
    await pool.query(`ALTER TABLE machine_session_edits ADD COLUMN IF NOT EXISTS phase_name TEXT`);

    const m = await pool.query(`SELECT id FROM machines WHERE active = 1 ORDER BY id LIMIT 1`);
    const t = await pool.query(`SELECT id, name, barcode FROM teams WHERE active = 1 ORDER BY id LIMIT 1`);
    assert(m.rows[0] && t.rows[0], 'Need machine + team');
    machineId = Number(m.rows[0].id);
    teamId = Number(t.rows[0].id);
    const machine = { id: machineId, active: 1 };
    const team = { id: teamId, name: t.rows[0].name, barcode: t.rows[0].barcode, active: 1 };

    const ins = await pool.query(
      `INSERT INTO tanks (tank_number, status, piece_count, current_piece_number, created_at, updated_at)
       VALUES ($1,'waiting',4,1,NOW(),NOW()) RETURNING id`,
      [tankNum]
    );
    tankId = Number(ins.rows[0].id);
    await phase1.ensureTankPieces(tankId, 4);

    // Piece 1 Hot Coat 1h
    const start1 = new Date('2026-08-07T09:00:00.000Z');
    const end1 = new Date('2026-08-07T10:00:00.000Z');
    const r1 = await pool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, finished_at, created_at, updated_at, piece_number, piece_id)
       SELECT $1,$2,$3,'HOT_COAT','Hot Coat','finished',$4::timestamptz,$5::timestamptz,$4::timestamptz,$5::timestamptz,1,tp.id
       FROM tank_pieces tp WHERE tp.tank_id=$3 AND tp.piece_number=1
       RETURNING id`,
      [machineId, teamId, tankId, start1.toISOString(), end1.toISOString()]
    );
    s1 = Number(r1.rows[0].id);

    // Piece 3 Rib Install 2h (09:00-11:00)
    const start3 = new Date('2026-08-07T09:00:00.000Z');
    const end3 = new Date('2026-08-07T11:00:00.000Z');
    const r3 = await pool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, finished_at, created_at, updated_at, piece_number, piece_id)
       SELECT $1,$2,$3,'RIB_INSTALL','Rib Install','finished',$4::timestamptz,$5::timestamptz,$4::timestamptz,$5::timestamptz,3,tp.id
       FROM tank_pieces tp WHERE tp.tank_id=$3 AND tp.piece_number=3
       RETURNING id`,
      [machineId, teamId, tankId, start3.toISOString(), end3.toISOString()]
    );
    s3 = Number(r3.rows[0].id);

    const editor = await phase1.fetchPhaseEditorPayload(tankId, { pieceNumber: 3, phaseCode: 'RIB_INSTALL' });
    assert(editor.ok, 'editor load');
    assert(Number(editor.body.selected_piece_number) === 3, 'piece 3 selected');
    assert(editor.body.selected_phase_code === 'RIB_INSTALL', 'rib selected');
    assert(editor.body.sessions.length === 1, 'one rib session');
    assert(Math.abs(editor.body.phase_total_ms - 2 * 3600000) < 1000, 'rib total ~2h');

    // No permanent default piece when multi
    const bare = await phase1.fetchPhaseEditorPayload(tankId, {});
    assert(bare.ok && bare.body.selected_piece_number == null, 'no default piece for 4-piece tank');

    const edit = await mem.editMachineSessionTimes(
      s3,
      {
        started_at: '2026-08-07T09:30:00.000Z',
        ended_at: '2026-08-07T11:00:00.000Z',
        edit_reason: 'Operator forgot to change phase.',
      },
      { name: 'Test Manager', user_id: null }
    );
    assert(edit.ok, 'edit ok: ' + JSON.stringify(edit.body));
    assert(edit.body.piece_number === 3, 'audit piece 3');
    assert(edit.body.phase_code === 'RIB_INSTALL', 'audit phase');

    const after = await phase1.fetchPhaseEditorPayload(tankId, { pieceNumber: 3, phaseCode: 'RIB_INSTALL' });
    assert(Math.abs(after.body.phase_total_ms - 1.5 * 3600000) < 1000, 'rib now 1h30m');
    assert(after.body.sessions[0].is_edited, 'edited flag');

    const p1 = await phase1.fetchPhaseEditorPayload(tankId, { pieceNumber: 1, phaseCode: 'HOT_COAT' });
    assert(Math.abs(p1.body.phase_total_ms - 3600000) < 1000, 'piece1 hot coat unchanged 1h');

    const edits = await mem.listSessionEdits(s3);
    assert(edits.length >= 1, 'audit rows');
    assert(edits[0].edit_reason.includes('forgot'), 'reason preserved');
    assert(Number(edits[0].tank_id) === tankId, 'audit tank_id');

    console.log('PHASE EDITOR TEST PASSED', { tankNum, s1, s3 });
  } finally {
    if (tankId) {
      await pool.query(`DELETE FROM machine_session_edits WHERE session_id IN (SELECT id FROM machine_sessions WHERE tank_id=$1)`, [
        tankId,
      ]);
      await pool.query(`DELETE FROM machine_sessions WHERE tank_id=$1`, [tankId]);
      await pool.query(`DELETE FROM tank_pieces WHERE tank_id=$1`, [tankId]);
      await pool.query(`DELETE FROM tanks WHERE id=$1`, [tankId]);
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error('FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
