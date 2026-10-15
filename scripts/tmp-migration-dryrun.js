'use strict';

/**
 * Local-only migration dry run for the Neon deploy.
 * 1. Creates a scratch database on the LOCAL Postgres server.
 * 2. Builds the schema with the COMMITTED (HEAD) migration = what production runs today.
 * 3. Seeds production-like rows, snapshots them.
 * 4. Runs the NEW (working tree) migration twice; verifies success, idempotency, and
 *    that every pre-existing row/column value is unchanged.
 * 5. Compares the resulting schema with the local dev database (detects manual local patches).
 * 6. Drops the scratch database. Refuses Neon. Never touches the dev database's data.
 */

require('./load-env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { isNeonUrl } = require('./db-config');

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures += 1;
}

const quiet = { log() {}, warn: (...a) => console.log('  [migration warn]', ...a), error: (...a) => console.log('  [migration error]', ...a) };

function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function tableSnapshot(client, table, cols) {
  const { rows } = await client.query(
    `SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY t.id)) AS h, COUNT(*)::int AS n
     FROM (SELECT ${cols.join(', ')} FROM ${table}) t`
  );
  return rows[0];
}

async function schemaMap(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns WHERE table_schema = 'public'
     ORDER BY table_name, column_name`
  );
  const m = new Map();
  for (const r of rows) m.set(`${r.table_name}.${r.column_name}`, `${r.data_type}/${r.is_nullable}`);
  return m;
}

async function main() {
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl || isNeonUrl(devUrl)) throw new Error('Refusing: DATABASE_URL missing or Neon');
  const host = new URL(devUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing non-local host ${host}`);

  const scratch = `fsc_migtest_${Date.now()}`;
  const admin = new Client({ connectionString: devUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${scratch}`);
  console.log(`scratch database ${scratch} created on ${host}`);

  const headDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsc-head-'));
  for (const f of ['schema-migrate.js', 'phase2-schema-sql.js']) {
    fs.writeFileSync(path.join(headDir, f), execSync(`git show HEAD:scripts/${f}`, { cwd: path.join(__dirname, '..') }));
  }
  const headMigrate = require(path.join(headDir, 'schema-migrate.js'));
  const newMigrate = require('./schema-migrate');

  const db = new Client({ connectionString: withDb(devUrl, scratch) });
  await db.connect();
  try {
    console.log('== Production-like schema from committed code (HEAD)');
    await headMigrate.runSchemaMigration(db, { log: quiet });
    await headMigrate.runSchemaMigration(db, { log: quiet });
    check(true, 'HEAD migration built schema');

    // Production-like rows under the OLD schema.
    const u = await db.query(
      `INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
       VALUES ('manager','x','MANAGER',1,NOW(),NOW()), ('kiosk_a','x','KIOSK',1,NOW(),NOW()) RETURNING id`
    );
    const m = await db.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
       VALUES ('Winding Machine 01','WM-01','WM-01','winding-machine-01',1,1,'winding',NOW(),NOW()),
              ('Assembly 1','AS-01','AS-01','assembly-1',2,1,'assembly_testing',NOW(),NOW()) RETURNING id`
    );
    const t = await db.query(
      `INSERT INTO tanks (tank_number, status, fab_completed_at, assembly_started_at, assembly_completed_at,
                          requires_test, first_scanned_at, completed_at, created_at, updated_at)
       VALUES ('P-100','ready_for_testing',NOW()-interval '3 day',NOW()-interval '2 day',NOW()-interval '1 day',TRUE,NOW()-interval '4 day',NULL,NOW(),NOW()),
              ('P-101','archived',NOW()-interval '9 day',NOW()-interval '8 day',NOW()-interval '7 day',FALSE,NOW()-interval '10 day',NOW()-interval '6 day',NOW(),NOW()),
              ('P-102','assembly_in_progress',NOW()-interval '1 day',NOW(),NULL,FALSE,NOW()-interval '2 day',NULL,NOW(),NOW())
       RETURNING id`
    );
    await db.query(
      `INSERT INTO test_attempts (tank_id, machine_id, result, attempted_at, failure_note, created_at)
       VALUES ($1,$2,'FAIL',NOW()-interval '20 hour','leak at nozzle',NOW()),
              ($1,$2,'PASS',NOW()-interval '10 hour',NULL,NOW())`,
      [t.rows[0].id, m.rows[1].id]
    );
    console.log(`  seeded ${u.rowCount} users, ${m.rowCount} machines, ${t.rowCount} tanks, 2 test attempts`);

    const oldSchema = await schemaMap(db);
    const cols = (table) =>
      [...oldSchema.keys()].filter((k) => k.startsWith(`${table}.`)).map((k) => k.split('.')[1]);
    const before = {};
    for (const table of ['users', 'machines', 'tanks', 'test_attempts', 'employees', 'teams']) {
      before[table] = await tableSnapshot(db, table, cols(table));
    }
    const tanksBefore = (await db.query(`SELECT ${cols('tanks').join(', ')} FROM tanks ORDER BY id`)).rows;

    console.log('== New migration (working tree) on the production-like database');
    let err1 = null;
    try {
      await newMigrate.runSchemaMigration(db, { log: quiet });
    } catch (e) {
      err1 = e;
    }
    check(!err1, `new migration run #1 succeeded${err1 ? ': ' + err1.message : ''}`);
    let err2 = null;
    try {
      await newMigrate.runSchemaMigration(db, { log: quiet });
    } catch (e) {
      err2 = e;
    }
    check(!err2, `new migration run #2 (idempotent) succeeded${err2 ? ': ' + err2.message : ''}`);

    for (const table of Object.keys(before)) {
      const after = await tableSnapshot(db, table, cols(table));
      check(
        after.n === before[table].n && after.h === before[table].h,
        `${table}: ${after.n} rows, pre-existing column values unchanged`
      );
    }

    const tanksAfter = (await db.query(`SELECT ${cols('tanks').join(', ')} FROM tanks ORDER BY id`)).rows;
    tanksBefore.forEach((row, i) => {
      for (const c of Object.keys(row)) {
        const a = JSON.stringify(row[c]);
        const b = JSON.stringify(tanksAfter[i][c]);
        if (a !== b) console.log(`  tanks ${row.tank_number}.${c}: ${a} -> ${b}`);
      }
    });

    const newSchema = await schemaMap(db);
    const removed = [...oldSchema.keys()].filter((k) => !newSchema.has(k));
    check(!removed.length, `no columns removed${removed.length ? ': ' + removed.join(', ') : ''}`);
    const typeChanged = [...oldSchema.keys()].filter(
      (k) => newSchema.has(k) && newSchema.get(k).split('/')[0] !== oldSchema.get(k).split('/')[0]
    );
    check(!typeChanged.length, `no column types changed${typeChanged.length ? ': ' + typeChanged.join(', ') : ''}`);
    const nullChanged = [...oldSchema.keys()].filter((k) => newSchema.has(k) && newSchema.get(k) !== oldSchema.get(k));
    console.log(`  nullability relaxed: ${nullChanged.map((k) => `${k} ${oldSchema.get(k)} -> ${newSchema.get(k)}`).join(', ') || 'none'}`);
    const added = [...newSchema.keys()].filter((k) => !oldSchema.has(k));
    const addedTables = [...new Set(added.map((k) => k.split('.')[0]))].filter(
      (tb) => ![...oldSchema.keys()].some((k) => k.startsWith(`${tb}.`))
    );
    console.log(`  new tables: ${addedTables.join(', ') || 'none'}`);
    console.log(`  new columns on existing tables: ${added.filter((k) => !addedTables.includes(k.split('.')[0])).join(', ')}`);

    const ta = await db.query(`SELECT result, test_type, attempt_status, started_at IS NOT NULL AS s FROM test_attempts ORDER BY id`);
    check(
      ta.rows.every((r) => r.test_type === 'LEGACY' && r.s) &&
        ta.rows[0].attempt_status === 'failed' &&
        ta.rows[1].attempt_status === 'passed',
      'legacy test_attempts backfilled (test_type LEGACY, attempt_status from result); results untouched'
    );
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at) VALUES ('qa_probe','x','QA_QC',1,NOW(),NOW())`
    );
    await db.query(
      `INSERT INTO test_attempts (tank_id, result, attempted_at, test_type, attempt_status, created_at)
       VALUES ($1, NULL, NOW(), 'VACUUM', 'in_progress', NOW())`,
      [t.rows[0].id]
    );
    let badRole = null;
    try {
      await db.query('SAVEPOINT s');
      await db.query(
        `INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at) VALUES ('bad','x','ADMIN',1,NOW(),NOW())`
      );
    } catch (e) {
      badRole = e;
      await db.query('ROLLBACK TO SAVEPOINT s');
    }
    await db.query('ROLLBACK');
    check(true, 'QA_QC role and in-progress (NULL result) test attempts accepted');
    check(Boolean(badRole), 'users.role check still enforced for unknown roles');
    const statusRow = await db.query(
      `SELECT COUNT(*)::int AS n FROM tanks WHERE status IN ('ready_for_testing','archived','assembly_in_progress')`
    );
    check(statusRow.rows[0].n === 3, 'no tank statuses rewritten by migration');

    console.log('== Compare with local dev database schema');
    const dev = new Client({ connectionString: devUrl });
    await dev.connect();
    const devSchema = await schemaMap(dev);
    await dev.end();
    const serverInlineTables = ['part_complete_events', 'session_team_members', 'alert_email_recipients', 'session'];
    const devOnly = [...devSchema.keys()].filter((k) => !newSchema.has(k) && !serverInlineTables.includes(k.split('.')[0]));
    console.log(`  dev-only columns (not produced by migration): ${devOnly.join(', ') || 'none'}`);
    check(
      devOnly.every((k) => !/^(tanks|test_attempts|test_attempt_notes|assembly_kiosk_teams|tank_admin_phase2_audit|stage_labor_\w+|machines|users)\./.test(k)),
      'every Phase 2 column used locally is created by the migration'
    );
  } finally {
    await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.end();
    fs.rmSync(headDir, { recursive: true, force: true });
    console.log(`scratch database ${scratch} dropped`);
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
