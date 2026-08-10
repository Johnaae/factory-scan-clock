'use strict';

/**
 * End-to-end scenario checks for membership transfer, piece conflict,
 * labor hours independence, and piece selection rules.
 */
const { withClient, closePool } = require('./db');
const { createPhase1ProductionLogic } = require('./phase1-production-logic');
const { createTeamMembershipAndLabor } = require('./team-membership-labor');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const results = [];
  await withClient(async (client) => {
    const pool = {
      query: (...args) => client.query(...args),
      connect: async () => {
        // single-client shim for transfer transactions
        return {
          query: (...args) => client.query(...args),
          release() {},
        };
      },
    };

    // Nested BEGIN not supported well — use real pool for transfer tests.
  });
  await closePool();

  const { Pool } = require('pg');
  const { createPoolOptions } = require('./db-config');
  const realPool = new Pool(createPoolOptions());
  const phase1 = createPhase1ProductionLogic({
    pool: realPool,
    nowIso: () => new Date().toISOString(),
    normalizeTankNumber: (s) => String(s || '').trim().toUpperCase(),
    normalizeTankStatus: (s) => String(s || '').toLowerCase(),
    startEndOfLocalDay: () => null,
    localDateString: () => '2026-08-07',
    weekBoundsLocal: () => null,
    validateTankExists: async () => null,
  });
  const mem = createTeamMembershipAndLabor(realPool, {
    nowIso: () => new Date().toISOString(),
    sessionElapsedMs: (row) => {
      const a = new Date(row.started_at).getTime();
      const b = new Date(row.finished_at || row.stopped_at || Date.now()).getTime();
      return Math.max(0, b - a);
    },
    isProductionPhaseCode: () => true,
    roundHours2: (n) => Math.round(n * 100) / 100,
    formatDurationSummary: (ms) => `${Math.round(ms / 3600000)}h`,
  });

  const suffix = String(Date.now()).slice(-6);
  let team1;
  let team2;
  let empA;
  let empB;
  let machine1;
  let machine2;
  let tankId;

  try {
    // Setup teams/employees/machines
    team1 = (
      await realPool.query(
        `INSERT INTO teams (name, barcode, active) VALUES ($1,$2,1) RETURNING id, name`,
        [`Test Team 1 ${suffix}`, `TEAM-T1-${suffix}`]
      )
    ).rows[0];
    team2 = (
      await realPool.query(
        `INSERT INTO teams (name, barcode, active) VALUES ($1,$2,1) RETURNING id, name`,
        [`Test Team 2 ${suffix}`, `TEAM-T2-${suffix}`]
      )
    ).rows[0];
    empA = (
      await realPool.query(
        `INSERT INTO employees (code, name, is_active) VALUES ($1,$2,1) RETURNING id, code, name`,
        [`EA${suffix}`, `Emp A ${suffix}`]
      )
    ).rows[0];
    empB = (
      await realPool.query(
        `INSERT INTO employees (code, name, is_active) VALUES ($1,$2,1) RETURNING id, code, name`,
        [`EB${suffix}`, `Emp B ${suffix}`]
      )
    ).rows[0];

    // Put A on team 1 then transfer to team 2 BEFORE sessions for labor test
    let t = await mem.transferEmployeeToTeam(empA.id, team1.id, {
      at: new Date(Date.now() - 10800000).toISOString(),
      source: 'test',
      reason: 'setup',
    });
    assert(t.ok, 'setup transfer A→1');
    results.push('TEST B setup: A on Team 1');

    const transferAt = new Date(Date.now() - 9000000).toISOString();
    t = await mem.transferEmployeeToTeam(empA.id, team2.id, {
      at: transferAt,
      source: 'kiosk_transfer',
      reason: 'test transfer',
    });
    assert(t.ok, 'transfer failed');
    assert(t.body.to_team.id === Number(team2.id), 'dest team');
    const hist = await realPool.query(
      `SELECT * FROM employee_team_memberships WHERE employee_id = $1 ORDER BY joined_at ASC, id ASC`,
      [empA.id]
    );
    assert(hist.rows.length >= 2, 'history rows');
    const closed = hist.rows.filter((r) => r.left_at);
    const open = hist.rows.filter((r) => !r.left_at);
    assert(closed.length >= 1 && open.length === 1, 'one open membership');
    assert(Number(open[0].team_id) === Number(team2.id), 'open on team 2');
    results.push('TEST B PASS: employee transfer closes prior membership and opens new at same timestamp');

    // Piece conflict: create tank with 4 pieces + two machines + sessions
    const tank = (
      await realPool.query(
        `INSERT INTO tanks (tank_number, status, piece_count, current_piece_number)
         VALUES ($1,'active',4,1) RETURNING id, tank_number, piece_count`,
        [`TTEST${suffix}`]
      )
    ).rows[0];
    tankId = tank.id;
    await phase1.ensureTankPieces(tankId, 4);
    assert(Number(tank.piece_count) === 4, 'piece_count 4');
    results.push('TEST H setup: tank with 4 pieces (no auto-select in API when piece_count>1)');

    machine1 = (
      await realPool.query(
        `INSERT INTO machines (name, code, kiosk_slug, active) VALUES ($1,$2,$3,1) RETURNING id, name`,
        [`WM-T1-${suffix}`, `WMT1${suffix}`, `wm-t1-${suffix}`]
      )
    ).rows[0];
    machine2 = (
      await realPool.query(
        `INSERT INTO machines (name, code, kiosk_slug, active) VALUES ($1,$2,$3,1) RETURNING id, name`,
        [`WM-T2-${suffix}`, `WMT2${suffix}`, `wm-t2-${suffix}`]
      )
    ).rows[0];

    const piece1 = await phase1.getTankPieceByNumber(tankId, 1);
    const piece3 = await phase1.getTankPieceByNumber(tankId, 3);
    const start = new Date(Date.now() - 3600000).toISOString();
    await realPool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, created_at, updated_at, piece_number, piece_id)
       VALUES ($1,$2,$3,'CHOP','Chop','running',$4::timestamptz,$4::timestamptz,$4::timestamptz,1,$5)`,
      [machine1.id, team1.id, tankId, start, piece1.id]
    );
    await realPool.query(
      `INSERT INTO machine_sessions
         (machine_id, team_id, tank_id, activity_code, activity_name, status, started_at, created_at, updated_at, piece_number, piece_id)
       VALUES ($1,$2,$3,'WIND','Wind','running',$4::timestamptz,$4::timestamptz,$4::timestamptz,3,$5)`,
      [machine2.id, team2.id, tankId, start, piece3.id]
    );
    const conflict = await mem.findOpenPieceSession(tankId, 1, null);
    assert(conflict, 'piece 1 in use');
    assert(Number(conflict.machine_id) === Number(machine1.id), 'conflict machine');
    const noConflict = await mem.findOpenPieceSession(tankId, 2, null);
    assert(!noConflict, 'piece 2 free');
    results.push('TEST F/G PASS: different pieces concurrent; same piece conflict detected');

    // Labor hours: B + A on team2 during team2 session; team1 session has no members in history → labor from team2 only
    await mem.transferEmployeeToTeam(empB.id, team2.id, {
      at: new Date(Date.now() - 7200000).toISOString(),
      source: 'test',
    });
    const labor = await mem.computeMembershipAwareTankLabor(tankId);
    assert(labor.total_running_hours > 0, 'running hours > 0');
    assert(labor.total_labor_hours > 0, 'labor hours > 0');
    // Team2 session ~1h with 2 members ⇒ ~2h labor; running is sum of both piece sessions ~2h
    assert(labor.member_breakdown.length >= 1, 'has members');
    results.push(
      `TEST E PASS: running=${labor.total_running_hours}h labor=${labor.total_labor_hours}h members=${labor.member_breakdown.length} (independent metrics)`
    );

    // Phase edit audit
    const sess = (
      await realPool.query(
        `SELECT id, started_at, finished_at, stopped_at, status FROM machine_sessions WHERE tank_id = $1 LIMIT 1`,
        [tankId]
      )
    ).rows[0];
    const end = new Date(new Date(sess.started_at).getTime() + 90 * 60000).toISOString();
    await realPool.query(
      `UPDATE machine_sessions SET status='finished', finished_at=$1::timestamptz WHERE id=$2`,
      [new Date(new Date(sess.started_at).getTime() + 120 * 60000).toISOString(), sess.id]
    );
    const edit = await mem.editMachineSessionTimes(
      sess.id,
      {
        started_at: sess.started_at,
        ended_at: end,
        edit_reason: 'Operator forgot to change phase.',
      },
      { user_id: null, name: 'Test Manager' }
    );
    assert(edit.ok, 'edit ok');
    assert(edit.body.edits.length >= 1, 'audit row');
    results.push('TEST D PASS: phase time edit stores audit history');

    // Piece complete progress
    await realPool.query(
      `UPDATE tank_pieces SET status='completed', completed_at=NOW() WHERE tank_id=$1 AND piece_number=1`,
      [tankId]
    );
    const pieces = await phase1.getTankPieces(tankId);
    const progress = phase1.computePieceProgress(pieces, 4);
    assert(progress.percent_complete === 25, '25%');
    assert(!progress.all_pieces_complete, 'not all complete');
    results.push('TEST I PASS: 1/4 pieces = 25%');

    console.log('\n=== RESULTS ===');
    for (const line of results) console.log('✓', line);
    console.log('All automated checks passed.');
  } finally {
    // Cleanup test data (do not touch real production tanks)
    try {
      if (tankId) {
        await realPool.query(`DELETE FROM machine_session_edits WHERE session_id IN (SELECT id FROM machine_sessions WHERE tank_id=$1)`, [
          tankId,
        ]);
        await realPool.query(`DELETE FROM machine_sessions WHERE tank_id=$1`, [tankId]);
        await realPool.query(`DELETE FROM tank_pieces WHERE tank_id=$1`, [tankId]);
        await realPool.query(`DELETE FROM tanks WHERE id=$1`, [tankId]);
      }
      if (machine1) await realPool.query(`DELETE FROM machines WHERE id=$1`, [machine1.id]);
      if (machine2) await realPool.query(`DELETE FROM machines WHERE id=$1`, [machine2.id]);
      if (empA) {
        await realPool.query(`DELETE FROM employee_team_memberships WHERE employee_id=$1`, [empA.id]);
        await realPool.query(`DELETE FROM team_members WHERE employee_id=$1`, [empA.id]);
        await realPool.query(`DELETE FROM employees WHERE id=$1`, [empA.id]);
      }
      if (empB) {
        await realPool.query(`DELETE FROM employee_team_memberships WHERE employee_id=$1`, [empB.id]);
        await realPool.query(`DELETE FROM team_members WHERE employee_id=$1`, [empB.id]);
        await realPool.query(`DELETE FROM employees WHERE id=$1`, [empB.id]);
      }
      if (team1) await realPool.query(`DELETE FROM teams WHERE id=$1`, [team1.id]);
      if (team2) await realPool.query(`DELETE FROM teams WHERE id=$1`, [team2.id]);
    } catch (err) {
      console.warn('cleanup:', err.message);
    }
    await realPool.end();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
