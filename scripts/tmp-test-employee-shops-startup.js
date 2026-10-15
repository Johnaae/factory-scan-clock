'use strict';

/**
 * Local-only check of the automatic employee_shops startup migration.
 * 1. Creates scratch databases on the LOCAL Postgres server (refuses Neon / non-local hosts).
 * 2. Builds a production-like schema with the COMMITTED (HEAD) migration (no employee_shops)
 *    and seeds employee / team / kiosk / labor / payroll rows.
 * 3. Runs the NEW migration from 6 concurrent connections (simulated Vercel cold starts),
 *    then twice more sequentially; verifies no errors, table + index created once,
 *    and every pre-existing row and column unchanged.
 * 4. Repeats the concurrent run on an EMPTY database (first-time full migration path).
 * Scratch databases are left in place (no DROP); names are printed at the end.
 */

require('./load-env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { isNeonUrl } = require('./db-config');

const BASELINE = process.argv.includes('--baseline');
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures += 1;
}

function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function captureLog() {
  const lines = [];
  return {
    lines,
    log: (...a) => lines.push(['log', a.join(' ')]),
    warn: (...a) => lines.push(['warn', a.join(' ')]),
    error: (...a) => lines.push(['error', a.join(' ')]),
  };
}

async function tableSnapshots(client, exclude) {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  const out = {};
  for (const { table_name: t } of tables) {
    if (exclude.includes(t)) continue;
    const r = await client.query(
      `SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`
    );
    out[t] = r.rows[0];
  }
  return out;
}

async function columnMap(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, COALESCE(column_default, '') AS d
     FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const m = new Map();
  for (const r of rows) m.set(`${r.table_name}.${r.column_name}`, `${r.data_type}/${r.is_nullable}/${r.d}`);
  return m;
}

async function shopsSchemaState(client) {
  const t = await client.query(
    `SELECT to_regclass('public.employee_shops') IS NOT NULL AS t,
            to_regclass('public.idx_employee_shops_shop') IS NOT NULL AS i`
  );
  const cons = await client.query(
    `SELECT contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = to_regclass('public.employee_shops') ORDER BY contype`
  );
  return { table: t.rows[0].t, index: t.rows[0].i, constraints: cons.rows };
}

async function concurrentRun(url, migrate, n) {
  const clients = [];
  for (let i = 0; i < n; i += 1) {
    const c = new Client({ connectionString: url });
    await c.connect();
    const q = c.query.bind(c);
    c.query = async (...args) => {
      try {
        return await q(...args);
      } catch (err) {
        if (!err.failedSql) err.failedSql = String(typeof args[0] === 'string' ? args[0] : args[0].text).replace(/\s+/g, ' ').trim().slice(0, 110);
        throw err;
      }
    };
    clients.push(c);
  }
  const logs = clients.map(() => captureLog());
  const results = await Promise.allSettled(clients.map((c, i) => migrate.runSchemaMigration(c, { log: logs[i] })));
  await Promise.all(clients.map((c) => c.end().catch(() => {})));
  return { results, logs };
}

function summarize(label, { results, logs }) {
  const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  const shopErrors = rejected.filter((e) => /employee_shops/.test(`${e.message} ${e.failedSql || ''}`));
  const otherErrors = rejected.filter((e) => !shopErrors.includes(e));
  const shopWarnings = logs.flatMap((l) => l.lines).filter(([lvl, m]) => lvl !== 'log' && /employee_shops/.test(m));
  const created = logs.flatMap((l) => l.lines).filter(([, m]) => /employee_shops table ready/.test(m)).length;
  check(!shopErrors.length, `${label}: no failure involving employee_shops${shopErrors.length ? ' — ' + shopErrors.map((e) => `${e.message} [at: ${e.failedSql}]`).join(' | ') : ''}`);
  if (BASELINE || otherErrors.length) {
    const where = [...new Set(otherErrors.map((e) => `${e.message} at "${(e.failedSql || '?').slice(0, 60)}…"`))];
    console.log(`  ${label}: ${results.length - rejected.length}/${results.length} succeeded; ${otherErrors.length} pre-existing-statement failure(s): ${where.join(' | ') || 'none'}`);
  }
  check(!shopWarnings.length, `${label}: no employee_shops warnings${shopWarnings.length ? ' — ' + shopWarnings.map((w) => w[1]).join(' | ') : ''}`);
  return created;
}

async function main() {
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl || isNeonUrl(devUrl)) throw new Error('Refusing: DATABASE_URL missing or Neon');
  const host = new URL(devUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing non-local host ${host}`);

  const stamp = Date.now();
  const scratchProd = `fsc_shoptest_prodlike_${stamp}`;
  const scratchEmpty = `fsc_shoptest_empty_${stamp}`;
  const scratchDirect = `fsc_shoptest_direct_${stamp}`;
  const admin = new Client({ connectionString: devUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${scratchProd}`);
  await admin.query(`CREATE DATABASE ${scratchEmpty}`);
  await admin.end();
  console.log(`scratch databases created on ${host}: ${scratchProd}, ${scratchEmpty}`);

  const headDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsc-head-'));
  for (const f of ['schema-migrate.js', 'phase2-schema-sql.js']) {
    fs.writeFileSync(path.join(headDir, f), execSync(`git show HEAD:scripts/${f}`, { cwd: path.join(__dirname, '..') }));
  }
  const headMigrate = require(path.join(headDir, 'schema-migrate.js'));
  const newMigrate = require('./schema-migrate');
  const quiet = captureLog();

  try {
    console.log('== Production-like database built by committed code (what Neon runs today)');
    const prodUrl = withDb(devUrl, scratchProd);
    const db = new Client({ connectionString: prodUrl });
    await db.connect();
    await headMigrate.runSchemaMigration(db, { log: quiet });
    await headMigrate.runSchemaMigration(db, { log: quiet });
    check(!(await shopsSchemaState(db)).table, 'committed code does not create employee_shops');

    const emp = await db.query(
      `INSERT INTO employees (code, name, is_active, hourly_rate, badge_role, created_at, updated_at)
       VALUES ('E100','Ana Lopez',1,24.50,'Fabrication Team Member',NOW(),NOW()),
              ('E101','Bo Chen',1,22.00,'Assembly Team Member',NOW(),NOW()),
              ('E102','Cy Diaz',0,20.00,'',NOW(),NOW()) RETURNING id`
    );
    const teams = await db.query(
      `INSERT INTO teams (name, barcode, department, active, created_at, updated_at)
       VALUES ('Fab A','TEAM-FA','Fabrication',1,NOW(),NOW()), ('Asm A','TEAM-AA','Assembly',1,NOW(),NOW()) RETURNING id`
    );
    await db.query(
      `INSERT INTO team_members (team_id, name, role, active, employee_id, created_at)
       VALUES ($1,'Ana Lopez','Operator',1,$3,NOW()), ($2,'Bo Chen','Operator',1,$4,NOW())`,
      [teams.rows[0].id, teams.rows[1].id, emp.rows[0].id, emp.rows[1].id]
    );
    const m = await db.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
       VALUES ('Assembly 1','AS-01','AS-01','assembly-1',1,1,'assembly_testing',NOW(),NOW()) RETURNING id`
    );
    const tk = await db.query(
      `INSERT INTO tanks (tank_number, status, created_at, updated_at)
       VALUES ('P-200','assembly_in_progress',NOW(),NOW()) RETURNING id`
    );
    await db.query(
      `INSERT INTO assembly_kiosk_teams (machine_id, team_id, status, created_at, updated_at)
       VALUES ($1,$2,'active',NOW(),NOW())`,
      [m.rows[0].id, teams.rows[1].id]
    ).catch((e) => console.log(`  (assembly_kiosk_teams seed skipped: ${e.message})`));
    const sl = await db.query(
      `INSERT INTO stage_labor_sessions (tank_id, machine_id, team_id, stage, status, started_at, ended_at)
       VALUES ($1,$2,$3,'ASSEMBLY','finished',NOW()-interval '2 hour',NOW()-interval '1 hour') RETURNING id`,
      [tk.rows[0].id, m.rows[0].id, teams.rows[1].id]
    );
    await db.query(
      `INSERT INTO stage_labor_participants (session_id, employee_id, employee_code, employee_name, team_id, joined_at, left_at)
       VALUES ($1,$2,'E101','Bo Chen',$3,NOW()-interval '2 hour',NOW()-interval '1 hour')`,
      [sl.rows[0].id, emp.rows[1].id, teams.rows[1].id]
    );
    await db.query(
      `INSERT INTO scan_logs (employee_id, employee_code, employee_name, status, scanned_at)
       VALUES ($1,'E100','Ana Lopez','IN',NOW()-interval '8 hour'), ($1,'E100','Ana Lopez','OUT',NOW()-interval '30 minute')`,
      [emp.rows[0].id]
    );
    await headMigrate.runSchemaMigration(db, { log: quiet });
    const before = await tableSnapshots(db, ['employee_shops']);
    const colsBefore = await columnMap(db);
    const seeded = Object.entries(before).filter(([, v]) => v.n > 0).map(([t, v]) => `${t}=${v.n}`);
    console.log(`  seeded rows: ${seeded.join(', ')}`);
    await db.end();

    if (BASELINE) {
      for (let round = 1; round <= 3; round += 1) {
        console.log(`== BASELINE round ${round}: 6 concurrent cold starts with the COMMITTED code`);
        summarize('committed code concurrent', await concurrentRun(prodUrl, headMigrate, 6));
      }
      console.log('== BASELINE: 4 concurrent cold starts on an EMPTY database with the COMMITTED code');
      summarize('committed code concurrent full', await concurrentRun(withDb(devUrl, scratchEmpty), headMigrate, 4));
      return;
    }

    console.log('== employee_shops step alone: 8 simultaneous callers on a copy of the seeded database');
    const adm = new Client({ connectionString: devUrl });
    await adm.connect();
    await adm.query(`CREATE DATABASE ${scratchDirect} TEMPLATE ${scratchProd}`);
    await adm.end();
    const directUrl = withDb(devUrl, scratchDirect);
    const directClients = [];
    for (let i = 0; i < 8; i += 1) {
      const c = new Client({ connectionString: directUrl });
      await c.connect();
      directClients.push(c);
    }
    const directLogs = directClients.map(() => captureLog());
    const direct = await Promise.allSettled(
      directClients.map((c, i) => newMigrate.ensureEmployeeShopsSchema(c, directLogs[i]))
    );
    const vals = direct.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason.message }));
    check(vals.every((v) => !v.error), `all 8 callers finished without error${vals.some((v) => v.error) ? ': ' + vals.map((v) => v.error).filter(Boolean).join(' | ') : ''}`);
    check(vals.filter((v) => v.created).length === 1, `exactly one caller created the table (${vals.filter((v) => v.created).length})`);
    const dc = directClients[0];
    const dstate = await shopsSchemaState(dc);
    check(dstate.table && dstate.index, 'table + index present after simultaneous creation');
    await Promise.all(directClients.map((c) => c.end().catch(() => {})));

    console.log('== 6 concurrent cold starts with the new code (existing database, full startup pass)');
    const run1 = await concurrentRun(prodUrl, newMigrate, 6);
    const created1 = summarize('concurrent startup', run1);
    check(created1 <= 1, `employee_shops created by at most one instance (${created1})`);

    console.log('== 2 more sequential starts (idempotent)');
    for (let i = 0; i < 2; i += 1) {
      const r = await concurrentRun(prodUrl, newMigrate, 1);
      const c = summarize(`sequential start ${i + 1}`, r);
      check(c === 0, `start ${i + 1}: no DDL — table already present`);
    }

    const after = new Client({ connectionString: prodUrl });
    await after.connect();
    const state = await shopsSchemaState(after);
    check(state.table && state.index, 'employee_shops table and idx_employee_shops_shop index exist');
    const defs = state.constraints.map((c) => c.def).join(' ; ');
    check(/PRIMARY KEY \(employee_id, shop\)/.test(defs), 'primary key (employee_id, shop)');
    check(/REFERENCES employees\(id\) ON DELETE CASCADE/.test(defs), 'foreign key to employees(id)');
    check(/Fabrication.*Assembly.*Dome/.test(defs), 'check constraint limits shops to Fabrication/Assembly/Dome');
    const nShops = (await after.query(`SELECT COUNT(*)::int AS n FROM employee_shops`)).rows[0].n;
    check(nShops === 0, 'no shop rows created (existing employees stay Unassigned)');
    const afterSnap = await tableSnapshots(after, ['employee_shops']);
    for (const t of Object.keys(before)) {
      const same = afterSnap[t] && afterSnap[t].n === before[t].n && afterSnap[t].h === before[t].h;
      if (!same || before[t].n > 0) check(same, `${t}: ${before[t].n} rows unchanged`);
    }
    const unchangedTables = Object.keys(before).filter(
      (t) => before[t].n === 0 && afterSnap[t] && afterSnap[t].n === 0
    ).length;
    console.log(`  (${unchangedTables} other empty tables still empty)`);
    const colsAfter = await columnMap(after);
    const changed = [...colsBefore.keys()].filter((k) => colsAfter.get(k) !== colsBefore.get(k));
    const addedCols = [...colsAfter.keys()].filter((k) => !colsBefore.has(k));
    check(!changed.length, `no existing column added/changed/removed${changed.length ? ': ' + changed.join(', ') : ''}`);
    check(
      addedCols.every((k) => k.startsWith('employee_shops.')),
      `only new columns are in employee_shops (${addedCols.join(', ')})`
    );
    const locks = await after.query(`SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`);
    check(locks.rows[0].n === 0, 'no advisory locks left held');
    await after.end();

    console.log('== 4 concurrent cold starts on an EMPTY database (first-time full migration)');
    const emptyUrl = withDb(devUrl, scratchEmpty);
    const run2 = await concurrentRun(emptyUrl, newMigrate, 4);
    summarize('concurrent full', run2);
    const e = new Client({ connectionString: emptyUrl });
    await e.connect();
    const st2 = await shopsSchemaState(e);
    check(st2.table && st2.index, 'employee_shops created on a brand-new database');
    await e.end();
  } finally {
    fs.rmSync(headDir, { recursive: true, force: true });
  }
  console.log(`\nScratch databases left in place (not dropped): ${scratchProd}, ${scratchEmpty}${BASELINE ? '' : ', ' + scratchDirect}`);
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
});
