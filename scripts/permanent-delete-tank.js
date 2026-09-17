'use strict';
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');

/** Discover every FK pointing at tanks (live DB). */
async function listTankForeignKeys(pool) {
  const { rows } = await pool.query(`
    SELECT
      tc.table_name,
      kcu.column_name,
      rc.delete_rule,
      tc.constraint_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'tanks'
    ORDER BY tc.table_name
  `);
  return rows;
}

async function tableExists(client, name) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`]);
  return rows[0] && rows[0].reg != null;
}

/**
 * Delete all rows owned by one tank, in FK-safe order.
 * Shared master data (employees/teams/machines/phases) is never deleted.
 */
async function permanentlyDeleteTankOwnedRows(client, tankId) {
  const tid = Number(tankId);
  if (!Number.isInteger(tid) || tid <= 0) throw new Error('invalid tank id');

  // Clear machine pointers (not owned rows).
  await client.query(
    `UPDATE machines SET active_tank_id = NULL, updated_at = NOW() WHERE active_tank_id = $1`,
    [tid]
  );

  // Phase 2 testing / stage labor (RESTRICT on tanks).
  if (await tableExists(client, 'test_attempts')) {
    await client.query(`DELETE FROM test_attempts WHERE tank_id = $1`, [tid]);
  }
  if (await tableExists(client, 'stage_labor_participants') && (await tableExists(client, 'stage_labor_sessions'))) {
    await client.query(
      `DELETE FROM stage_labor_participants
       WHERE session_id IN (SELECT id FROM stage_labor_sessions WHERE tank_id = $1)`,
      [tid]
    );
  }
  if (await tableExists(client, 'stage_labor_sessions')) {
    await client.query(`DELETE FROM stage_labor_sessions WHERE tank_id = $1`, [tid]);
  }

  // Session edits before machine_sessions when present.
  if (await tableExists(client, 'machine_session_edits')) {
    try {
      await client.query(
        `DELETE FROM machine_session_edits
         WHERE tank_id = $1
            OR session_id IN (SELECT id FROM machine_sessions WHERE tank_id = $1)`,
        [tid]
      );
    } catch (err) {
      // Older schemas may lack tank_id on edits — delete by session only.
      if (!/tank_id/i.test(String(err && err.message))) throw err;
      await client.query(
        `DELETE FROM machine_session_edits
         WHERE session_id IN (SELECT id FROM machine_sessions WHERE tank_id = $1)`,
        [tid]
      );
    }
  }

  // Phase 1 production children (RESTRICT).
  await client.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [tid]);
  await client.query(`DELETE FROM part_complete_events WHERE tank_id = $1`, [tid]);
  if (await tableExists(client, 'downtime_intervals')) {
    await client.query(`DELETE FROM downtime_intervals WHERE tank_id = $1`, [tid]);
  }

  // SET NULL FKs — detach history that is allowed to survive without tank_id.
  if (await tableExists(client, 'alert_events')) {
    await client.query(`UPDATE alert_events SET tank_id = NULL WHERE tank_id = $1`, [tid]);
  }
  if (await tableExists(client, 'production_notes')) {
    await client.query(`UPDATE production_notes SET tank_id = NULL WHERE tank_id = $1`, [tid]);
  }
  if (await tableExists(client, 'job_finish_events')) {
    await client.query(`UPDATE job_finish_events SET tank_id = NULL WHERE tank_id = $1`, [tid]);
  }

  // Pieces then tank.
  await client.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [tid]);
  await client.query(`DELETE FROM tanks WHERE id = $1`, [tid]);
}

module.exports = {
  listTankForeignKeys,
  permanentlyDeleteTankOwnedRows,
  tableExists,
};
