'use strict';

/**
 * TEST: rework_required must survive End Shift; heal wiped status; normal FAB-complete still blocked.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};

async function main() {
  const { createPoolOptions } = require('./db-config');
  const pg = require('pg');
  const pool = new pg.Pool(createPoolOptions());
  const { createPhase1ProductionLogic } = require('./phase1-production-logic');

  const nowIso = () => new Date().toISOString();
  const normalizeTankNumber = (v) => String(v || '').trim().toUpperCase();
  const normalizeTankStatus = (raw) => {
    const s = String(raw == null || raw === '' ? 'waiting' : raw)
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (s === 'rework_required' || s === 'returned_to_fab' || s === 'fab_rework') return 'rework_required';
    if (s === 'paused') return 'paused';
    if (s === 'archived' || s === 'completed') return 'archived';
    return s || 'active';
  };

  const phase1 = createPhase1ProductionLogic({
    pool,
    nowIso,
    normalizeTankNumber,
    normalizeTankStatus,
    startEndOfLocalDay: () => ({ start: new Date(), end: new Date() }),
    localDateString: () => '2026-09-14',
    weekBoundsLocal: () => ({ start: new Date(), end: new Date() }),
    validateTankExists: async (n) => {
      const { rows } = await pool.query(
        `SELECT * FROM tanks WHERE UPPER(TRIM(tank_number::text)) = $1 AND deleted_at IS NULL LIMIT 1`,
        [normalizeTankNumber(n)]
      );
      return rows[0] || null;
    },
  });

  const suffix = String(Date.now()).slice(-6);
  const tankNumber = `RWES${suffix}`;
  const blockedNum = `NOES${suffix}`;
  const created = { teams: [], employees: [], tanks: [], machines: [] };

  try {
    const team = (
      await pool.query(`INSERT INTO teams (name, barcode, active) VALUES ($1,$2,1) RETURNING *`, [
        `Rework EndShift Team ${suffix}`,
        `TEAM-RWES-${suffix}`,
      ])
    ).rows[0];
    created.teams.push(team.id);

    const emp = (
      await pool.query(`INSERT INTO employees (code, name, is_active) VALUES ($1,$2,1) RETURNING *`, [
        `RW${suffix}`,
        `Rework ES Emp ${suffix}`,
      ])
    ).rows[0];
    created.employees.push(emp.id);
    await pool.query(`INSERT INTO team_members (team_id, name, active, employee_id) VALUES ($1,$2,1,$3)`, [
      team.id,
      emp.name,
      emp.id,
    ]);

    const machine = (
      await pool.query(
        `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow)
         VALUES ($1,$2,$3,$4,95,1,'winding') RETURNING *`,
        [`RWES Wind ${suffix}`, `RWESW${suffix}`, `MACH-RWES-${suffix}`, `rwes-wind-${suffix}`]
      )
    ).rows[0];
    created.machines.push(machine.id);

    const tank = (
      await pool.query(
        `INSERT INTO tanks (
           tank_number, status, piece_count, requires_test, fab_completed_at,
           assembly_completed_at, first_scanned_at, created_at, updated_at
         ) VALUES ($1,'rework_required',2,TRUE,NOW(),NOW(),NOW(),NOW(),NOW())
         RETURNING *`,
        [tankNumber]
      )
    ).rows[0];
    created.tanks.push(tank.id);
    await pool.query(
      `INSERT INTO tank_pieces (tank_id, piece_number, status, created_at, updated_at)
       VALUES ($1,1,'completed',NOW(),NOW()), ($1,2,'completed',NOW(),NOW())`,
      [tank.id]
    );
    await pool.query(
      `INSERT INTO test_attempts (tank_id, result, failure_note, attempted_at, previous_status)
       VALUES ($1,'FAIL','end-shift persistence test',NOW(),'testing_in_progress')`,
      [tank.id]
    );

    await phase1.assignTeamToMachine(machine.id, {
      id: team.id,
      name: team.name,
      barcode: team.barcode,
      active: 1,
    });

    const start = await phase1.startSession(machine, {
      team: { id: team.id, name: team.name, barcode: team.barcode, active: 1 },
      tankNumber: tank.tank_number,
      phaseRaw: 'CORRECTIONS',
      pieceNumber: 1,
      notes: 'rework note',
    });
    assert(start.ok, `start rework: ${JSON.stringify(start.body)}`);
    const mid = (await pool.query(`SELECT status FROM tanks WHERE id=$1`, [tank.id])).rows[0];
    assert(mid.status === 'rework_required', `during rework got ${mid.status}`);

    const end = await phase1.endShiftSession(machine);
    assert(end.ok, `end shift: ${JSON.stringify(end.body)}`);

    const afterEnd = (
      await pool.query(
        `SELECT status, paused_reason, wip_team_id, wip_machine_id, requires_test
         FROM tanks WHERE id=$1`,
        [tank.id]
      )
    ).rows[0];
    assert(afterEnd.status === 'rework_required', `TEST1 after End Shift got ${afterEnd.status}`);
    assert(!afterEnd.paused_reason, 'no end_shift paused_reason on rework');
    assert(afterEnd.wip_team_id == null, 'WIP team cleared');
    assert(afterEnd.wip_machine_id == null, 'WIP machine cleared');
    assert(afterEnd.requires_test === true, 'requires_test persists');

    // Simulate legacy bug wipe, then heal.
    await pool.query(
      `UPDATE tanks
       SET status='paused', paused_reason='end_shift',
           wip_team_id=$2, wip_machine_id=$3, wip_phase_code='HOT_COAT', wip_phase_name='Hot Coat'
       WHERE id=$1`,
      [tank.id, team.id, machine.id]
    );
    const healed = await phase1.ensurePersistentReworkStatus(
      (await pool.query(`SELECT * FROM tanks WHERE id=$1`, [tank.id])).rows[0]
    );
    assert(healed.status === 'rework_required', `heal got ${healed.status}`);

    const blocked = (
      await pool.query(
        `INSERT INTO tanks (tank_number, status, piece_count, fab_completed_at, first_scanned_at, created_at, updated_at)
         VALUES ($1,'ready_for_assembly',1,NOW(),NOW(),NOW(),NOW()) RETURNING *`,
        [blockedNum]
      )
    ).rows[0];
    created.tanks.push(blocked.id);
    await pool.query(
      `INSERT INTO tank_pieces (tank_id, piece_number, status, created_at, updated_at)
       VALUES ($1,1,'pending',NOW(),NOW())`,
      [blocked.id]
    );
    await phase1.assignTeamToMachine(machine.id, {
      id: team.id,
      name: team.name,
      barcode: team.barcode,
      active: 1,
    });
    const blockedStart = await phase1.startSession(machine, {
      team: { id: team.id, name: team.name, barcode: team.barcode, active: 1 },
      tankNumber: blocked.tank_number,
      phaseRaw: 'CHOP',
      pieceNumber: 1,
    });
    assert(!blockedStart.ok, 'normal FAB-complete must be blocked');
    assert(
      blockedStart.body && blockedStart.body.error === 'fab_complete_no_rework',
      `expected fab_complete_no_rework got ${JSON.stringify(blockedStart.body)}`
    );

    const openLeft = await pool.query(
      `SELECT id FROM machine_sessions WHERE tank_id=$1 AND status IN ('running','stopped')`,
      [tank.id]
    );
    assert(openLeft.rows.length === 0, 'no labor left running after End Shift');

    console.log('PASS: rework_required persists across End Shift + heal + FAB block still works');
  } finally {
    try {
      for (const id of created.tanks) {
        await pool.query(`DELETE FROM test_attempts WHERE tank_id=$1`, [id]);
        await pool.query(`DELETE FROM machine_sessions WHERE tank_id=$1`, [id]);
        await pool.query(`DELETE FROM tank_pieces WHERE tank_id=$1`, [id]);
        await pool.query(`DELETE FROM tanks WHERE id=$1`, [id]);
      }
      for (const id of created.machines) {
        await pool.query(
          `UPDATE machines SET assigned_team_id=NULL, assigned_team_day=NULL, assigned_team_at=NULL, active_tank_id=NULL WHERE id=$1`,
          [id]
        );
        await pool.query(`DELETE FROM machines WHERE id=$1`, [id]);
      }
      for (const id of created.employees) {
        await pool.query(`DELETE FROM team_members WHERE employee_id=$1`, [id]);
        await pool.query(`DELETE FROM employees WHERE id=$1`, [id]);
      }
      for (const id of created.teams) {
        await pool.query(`DELETE FROM team_members WHERE team_id=$1`, [id]);
        await pool.query(`DELETE FROM teams WHERE id=$1`, [id]);
      }
    } catch (cleanupErr) {
      console.warn('cleanup:', cleanupErr.message);
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
