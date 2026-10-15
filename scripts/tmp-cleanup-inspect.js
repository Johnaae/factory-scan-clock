'use strict';

/**
 * READ-ONLY inspection for test-data cleanup planning.
 * Runs only SELECT statements. Refuses Neon.
 */

require('./load-env');
const fs = require('fs');
const path = require('path');
const { isNeonUrl, parseDatabaseUrl, isLocalHost } = require('./db-config');
const { pool, closePool } = require('./db');

async function main() {
  const url = process.env.DATABASE_URL;
  const parsed = parseDatabaseUrl(url);
  const out = {
    connection: {
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      is_neon: isNeonUrl(url),
      is_local: isLocalHost(parsed.host),
      internal_lan_mode: process.env.INTERNAL_LAN_MODE || null,
    },
  };
  if (out.connection.is_neon) throw new Error('Refusing to inspect Neon from cleanup tooling.');

  const srv = await pool.query(
    `SELECT current_database() AS db, inet_server_addr()::text AS addr, inet_server_port() AS port, version() AS version`
  );
  out.server = srv.rows[0];

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  out.table_counts = {};
  for (const { table_name } of tables.rows) {
    const c = await pool.query(`SELECT COUNT(*)::int AS n FROM "${table_name}"`);
    out.table_counts[table_name] = c.rows[0].n;
  }

  const fks = await pool.query(
    `SELECT tc.table_name AS child_table, kcu.column_name AS child_column,
            ccu.table_name AS parent_table, ccu.column_name AS parent_column,
            rc.delete_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
     ORDER BY ccu.table_name, tc.table_name`
  );
  out.foreign_keys = fks.rows;

  // Columns referencing tank/machine/team/employee ids WITHOUT a declared FK (soft references).
  const softCols = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name IN ('tank_id','machine_id','team_id','employee_id','active_tank_id',
                           'assembly_machine_id','assembly_team_id','testing_machine_id','qa_machine_id',
                           'assigned_team_id','wip_team_id','wip_machine_id','session_id','test_attempt_id',
                           'parent_attempt_id','user_id','qa_user_id','tester_user_id')
     ORDER BY table_name, column_name`
  );
  out.id_columns = softCols.rows;

  const redact = (rows) =>
    rows.map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) {
        if (/pin|password|hash|secret|token/i.test(k)) o[k] = v == null ? null : '[set]';
        else o[k] = v;
      }
      return o;
    });
  const all = async (t) =>
    out.table_counts[t] === undefined ? [] : redact((await pool.query(`SELECT * FROM "${t}" ORDER BY id`)).rows);
  out.machines = await all('machines');
  out.teams = await all('teams');
  out.employees = await all('employees');
  out.users = await all('users');
  out.tanks = (await all('tanks')).map((t) => ({
    id: t.id,
    tank_number: t.tank_number,
    status: t.status,
    created_at: t.created_at,
    assembly_machine_id: t.assembly_machine_id,
    testing_machine_id: t.testing_machine_id,
  }));

  const file = path.join(__dirname, 'tmp-cleanup-inspect-out.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
  console.log(JSON.stringify(out.connection));
  console.log(`tables=${tables.rows.length} fks=${fks.rows.length} machines=${out.machines.length} teams=${out.teams.length} employees=${out.employees.length} users=${out.users.length} tanks=${out.tanks.length}`);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    try {
      await closePool();
    } catch (_e) {}
    process.exit(1);
  });
