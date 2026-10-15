'use strict';

/**
 * SAFE TEST DATA CLEANUP (local PostgreSQL only).
 *
 *   node scripts/tmp-cleanup-test-data.js                  -> preview Tier 1 (SELECT only)
 *   node scripts/tmp-cleanup-test-data.js --tier=2         -> preview Tier 1 + Tier 2 (SELECT only)
 *   node scripts/tmp-cleanup-test-data.js --tier=N --execute --confirm=DELETE-TEST-DATA
 *        -> fresh pg_dump backup, then ONE transaction: explicit child->parent deletes,
 *           post-checks (protected rows unchanged, zero orphans), COMMIT or ROLLBACK.
 *
 * No TRUNCATE, no DROP, no CASCADE reliance (children are deleted explicitly first),
 * no sequence resets. Refuses Neon and any non-local host.
 */

require('./load-env');
const { isNeonUrl, parseDatabaseUrl, isLocalHost } = require('./db-config');
const { pool, closePool } = require('./db');
const { createPgBackup } = require('./pg-backup');

const args = process.argv.slice(2);
const TIER = Number((args.find((a) => a.startsWith('--tier=')) || '--tier=1').split('=')[1]);
const EXECUTE = args.includes('--execute');
const CONFIRMED = args.includes('--confirm=DELETE-TEST-DATA');
// Audit rows from earlier Trash/Permanent Delete actions whose tank no longer exists.
const PURGE_DELETED_TANK_AUDIT = args.includes('--purge-deleted-tank-audit');

// ---------------------------------------------------------------------------
// Protected rows (must exist before and after, untouched).
// ---------------------------------------------------------------------------
const PROTECTED_MACHINES = {
  5: 'Winding Machine 01',
  6: 'Winding Machine 02',
  7: 'Winding Machine 03',
  77: 'Winding Machine 04',
};

// ---------------------------------------------------------------------------
// Tier 1: confirmed test data (script-generated, test naming patterns).
// Exact id -> name map; the run aborts if any row no longer matches.
// ---------------------------------------------------------------------------
const T1_MACHINES = {
  145: 'ASM Test 683731',
  146: 'ASM Test 741312',
  147: 'ASM Test 759860',
  149: 'ASM Lunch 780645',
  150: 'ASM Lunch 934950',
  151: 'ASM Test 065628',
  152: 'QA/QC Kiosk 065628',
  156: 'TEST FAB 202811',
  157: 'TEST ASSEMBLY 202811',
  158: 'TEST QAQC 202811',
  159: 'TEST FAB HTTP 287202',
  160: 'TEST ASSEMBLY HTTP 287202',
  161: 'TEST QAQC HTTP 287202',
  163: 'QA Fail UX 412626',
  164: 'QA Test Flow 585909',
};
const T1_TEAMS = {
  95: 'Tap Ctx Team 191262',
  129: 'P2 Team 644479',
  130: 'P2 Team 799154',
  131: 'P2 Team 156277',
  132: 'P2 Team 558963',
  142: 'Team1-654786',
  143: 'Team2-654786',
  144: 'Team1-683731',
  145: 'Team2-683731',
  146: 'Team1-741312',
  147: 'Team2-741312',
  148: 'Team1-759860',
  149: 'Team2-759860',
  150: 'SyncTeam-125211',
  151: 'SyncTeam2-125211',
  152: 'TeamA-780645',
  153: 'TeamB-780645',
  154: 'TeamA-934950',
  155: 'TeamB-934950',
  156: 'Team1-065628',
  157: 'Team2-065628',
};
const T1_EMPLOYEES = {
  241: 'P2A644479',
  242: 'P2B644479',
  243: 'P2A799154',
  244: 'P2B799154',
  245: 'P2A156277',
  246: 'P2B156277',
  247: 'P2A558963',
  248: 'P2B558963',
  258: 'E1-654786',
  259: 'E2-654786',
  260: 'E1-683731',
  261: 'E2-683731',
  262: 'E1-741312',
  263: 'E2-741312',
  264: 'E1-759860',
  265: 'E2-759860',
  266: 'A1-780645',
  267: 'A2-780645',
  268: 'B1-780645',
  269: 'A1-934950',
  270: 'A2-934950',
  271: 'B1-934950',
  272: 'E1-065628',
  273: 'E2-065628',
};
const T1_TANKS = {
  9: 'TEST-1001',
  135: 'TAPB191262',
  193: 'PH2H644479',
  194: 'P2T644479',
  196: 'PH2H799154',
  197: 'P2T799154',
  200: 'PH2H156277',
  201: 'P2T156277',
  206: 'PH2H558963',
  207: 'P2T558963',
  224: '2026-A-654786',
  225: '2026-B-654786',
  226: '2026-A-683731',
  227: '2026-B-683731',
  228: '2026-A-741312',
  229: '2026-B-741312',
  230: '2026-A-759860',
  231: '2026-B-759860',
  232: '2026-A-780645',
  233: '2026-B-780645',
  234: '2026-A-934950',
  235: '2026-B-934950',
  236: '2026-A-065628',
  237: '2026-B-065628',
  238: '2026-D-412626',
  239: '2026-A-412626',
  240: '2026-B-412626',
  241: '2026-C-412626',
  242: '2026-L-412626',
  243: '2026-A-585909',
  252: '7777', // assembly_in_progress on confirmed test kiosk 150 (ASM Lunch 934950)
};

// ---------------------------------------------------------------------------
// Tier 2: manually-created test data that needs explicit owner confirmation.
// ---------------------------------------------------------------------------
const T2_MACHINES = {
  1: 'Winding Station 01',
  2: 'Winding Station 02',
  94: '005',
  155: '1414',
  162: '1212',
};
const T2_TEAMS = { 101: 'test-1' };
const T2_TANKS = {
  2: '1006',
  3: '1002',
  4: '1001',
  5: '1003',
  6: '1004',
  7: '1005',
  8: '1234',
  11: 'PC377681',
  23: '4444',
  24: '6666',
  217: '1111',
  218: '2222',
};
// Tier 2 also clears all remaining activity history (scan logs, job finish events,
// kiosk sync queue, alerts, production notes, downtime).
const T2_HISTORY_TABLES = [
  'scan_logs',
  'job_finish_events',
  'kiosk_sync_events',
  'alert_events',
  'production_notes',
  'downtime_intervals',
];

function ids(...maps) {
  return [...new Set(maps.flatMap((m) => Object.keys(m).map(Number)))];
}

function buildSets() {
  const tier2 = TIER >= 2;
  return {
    TK: ids(T1_TANKS, tier2 ? T2_TANKS : {}),
    MC: ids(T1_MACHINES, tier2 ? T2_MACHINES : {}),
    TM: ids(T1_TEAMS, tier2 ? T2_TEAMS : {}),
    EM: ids(T1_EMPLOYEES),
    expected: {
      machines: { ...T1_MACHINES, ...(tier2 ? T2_MACHINES : {}) },
      teams: { ...T1_TEAMS, ...(tier2 ? T2_TEAMS : {}) },
      tanks: { ...T1_TANKS, ...(tier2 ? T2_TANKS : {}) },
      employees: T1_EMPLOYEES,
    },
  };
}

/** Replace :NAME tokens with $n and return [sql, values]. */
function bind(sql, sets) {
  const values = [];
  const order = {};
  const text = sql.replace(/:([A-Z]{2})\b/g, (_m, name) => {
    if (!(name in order)) {
      values.push(sets[name]);
      order[name] = values.length;
    }
    return `$${order[name]}::bigint[]`;
  });
  return [text, values];
}

// Explicit child -> parent order. Every WHERE uses ids captured before any delete.
function buildSteps() {
  const s = [
    ['delete', 'test_attempt_notes', `tank_id = ANY(:TK) OR test_attempt_id = ANY(:TA)`],
    ['delete', 'test_attempts', `id = ANY(:TA)`],
    ['delete', 'stage_labor_participants', `session_id = ANY(:LS)`],
    ['delete', 'stage_labor_sessions', `id = ANY(:LS)`],
    ['delete', 'downtime_intervals', `tank_id = ANY(:TK) OR machine_id = ANY(:MC) OR session_id = ANY(:MS)`],
    ['delete', 'alert_events', `tank_id = ANY(:TK) OR machine_id = ANY(:MC) OR session_id = ANY(:MS)`],
    ['delete', 'production_notes', `tank_id = ANY(:TK) OR machine_id = ANY(:MC) OR session_id = ANY(:MS)`],
    ['delete', 'part_complete_events', `tank_id = ANY(:TK) OR session_id = ANY(:MS)`],
    ['delete', 'machine_session_edits', `session_id = ANY(:MS) OR tank_id = ANY(:TK)`],
    ['delete', 'session_team_members', `session_id = ANY(:MS)`],
    ['delete', 'machine_sessions', `id = ANY(:MS)`],
    ['delete', 'tank_pieces', `tank_id = ANY(:TK)`],
    ['delete', 'job_finish_events', `tank_id = ANY(:TK)`],
    [
      'delete',
      'tank_admin_audit',
      PURGE_DELETED_TANK_AUDIT
        ? `tank_id = ANY(:TK) OR (tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks t WHERE t.id = tank_admin_audit.tank_id))`
        : `tank_id = ANY(:TK)`,
    ],
    ['delete', 'tank_admin_phase2_audit', `tank_id = ANY(:TK)`],
    ['update', 'machines', `active_tank_id = ANY(:TK) AND NOT (id = ANY(:MC))`, `active_tank_id = NULL`],
    [
      'update',
      'machines',
      `assigned_team_id = ANY(:TM) AND NOT (id = ANY(:MC))`,
      `assigned_team_id = NULL, assigned_team_day = NULL, assigned_team_at = NULL`,
    ],
    ['delete', 'assembly_kiosk_teams', `machine_id = ANY(:MC) OR team_id = ANY(:TM)`],
    ['delete', 'tanks', `id = ANY(:TK)`],
    ['delete', 'machines', `id = ANY(:MC)`],
    ['delete', 'employee_team_memberships', `team_id = ANY(:TM) OR employee_id = ANY(:EM)`],
    ['delete', 'team_members', `team_id = ANY(:TM) OR employee_id = ANY(:EM)`],
    ['delete', 'teams', `id = ANY(:TM)`],
    ['delete', 'employees', `id = ANY(:EM)`],
  ];
  if (TIER >= 2) {
    for (const t of T2_HISTORY_TABLES) {
      const prior = s.filter(([kind, table]) => kind === 'delete' && table === t).map(([, , w]) => `COALESCE((${w}), false)`);
      s.push(['delete', t, prior.length ? `NOT (${prior.join(' OR ')})` : `TRUE`]);
    }
  }
  return s.map(([kind, table, where, set]) => ({ kind, table, where, set }));
}

// Soft references (no declared FK) + declared FKs, checked for dangling ids.
const ORPHAN_CHECKS = [
  ['tanks.assembly_machine_id', `SELECT COUNT(*) FROM tanks c WHERE c.assembly_machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines p WHERE p.id=c.assembly_machine_id)`],
  ['tanks.testing_machine_id', `SELECT COUNT(*) FROM tanks c WHERE c.testing_machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines p WHERE p.id=c.testing_machine_id)`],
  ['tanks.qa_machine_id', `SELECT COUNT(*) FROM tanks c WHERE c.qa_machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines p WHERE p.id=c.qa_machine_id)`],
  ['tanks.wip_machine_id', `SELECT COUNT(*) FROM tanks c WHERE c.wip_machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines p WHERE p.id=c.wip_machine_id)`],
  ['tanks.assembly_team_id', `SELECT COUNT(*) FROM tanks c WHERE c.assembly_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.assembly_team_id)`],
  ['tanks.wip_team_id', `SELECT COUNT(*) FROM tanks c WHERE c.wip_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.wip_team_id)`],
  ['tanks.qa_user_id', `SELECT COUNT(*) FROM tanks c WHERE c.qa_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users p WHERE p.id=c.qa_user_id)`],
  ['machines.active_tank_id', `SELECT COUNT(*) FROM machines c WHERE c.active_tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.active_tank_id)`],
  ['machines.assigned_team_id', `SELECT COUNT(*) FROM machines c WHERE c.assigned_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.assigned_team_id)`],
  ['test_attempts.tank_id', `SELECT COUNT(*) FROM test_attempts c WHERE NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['test_attempts.parent_attempt_id', `SELECT COUNT(*) FROM test_attempts c WHERE c.parent_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM test_attempts p WHERE p.id=c.parent_attempt_id)`],
  ['test_attempts.labor_session_id', `SELECT COUNT(*) FROM test_attempts c WHERE c.labor_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stage_labor_sessions p WHERE p.id=c.labor_session_id)`],
  ['test_attempts.tester_user_id', `SELECT COUNT(*) FROM test_attempts c WHERE c.tester_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users p WHERE p.id=c.tester_user_id)`],
  ['test_attempt_notes.test_attempt_id', `SELECT COUNT(*) FROM test_attempt_notes c WHERE NOT EXISTS (SELECT 1 FROM test_attempts p WHERE p.id=c.test_attempt_id)`],
  ['test_attempt_notes.author_user_id', `SELECT COUNT(*) FROM test_attempt_notes c WHERE c.author_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users p WHERE p.id=c.author_user_id)`],
  ['stage_labor_sessions.tank_id', `SELECT COUNT(*) FROM stage_labor_sessions c WHERE NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['stage_labor_participants.session_id', `SELECT COUNT(*) FROM stage_labor_participants c WHERE NOT EXISTS (SELECT 1 FROM stage_labor_sessions p WHERE p.id=c.session_id)`],
  ['machine_sessions.tank_id', `SELECT COUNT(*) FROM machine_sessions c WHERE c.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['session_team_members.session_id', `SELECT COUNT(*) FROM session_team_members c WHERE NOT EXISTS (SELECT 1 FROM machine_sessions p WHERE p.id=c.session_id)`],
  ['part_complete_events.tank_id', `SELECT COUNT(*) FROM part_complete_events c WHERE c.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['tank_pieces.tank_id', `SELECT COUNT(*) FROM tank_pieces c WHERE NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['tank_admin_audit.tank_id', `SELECT COUNT(*) FROM tank_admin_audit c WHERE c.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['tank_admin_phase2_audit.tank_id', `SELECT COUNT(*) FROM tank_admin_phase2_audit c WHERE c.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['machine_session_edits.tank_id', `SELECT COUNT(*) FROM machine_session_edits c WHERE c.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`],
  ['assembly_kiosk_teams.machine/team', `SELECT COUNT(*) FROM assembly_kiosk_teams c WHERE NOT EXISTS (SELECT 1 FROM machines p WHERE p.id=c.machine_id) OR NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.team_id)`],
  ['employee_team_memberships.team/employee', `SELECT COUNT(*) FROM employee_team_memberships c WHERE NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.team_id) OR NOT EXISTS (SELECT 1 FROM employees p WHERE p.id=c.employee_id)`],
  ['team_members.team_id', `SELECT COUNT(*) FROM team_members c WHERE NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.team_id)`],
];

async function runOrphanChecks(db) {
  const out = {};
  for (const [label, sql] of ORPHAN_CHECKS) {
    out[label] = Number((await db.query(sql)).rows[0].count);
  }
  return out;
}

/** Retained rows that would lose a reference (FK SET NULL / soft ref) to a removed row. */
async function retainedImpact(db, sets) {
  const checks = [
    ['retained tanks -> removed machine (assembly/testing/qa/wip)', `SELECT COUNT(*) FROM tanks WHERE NOT (id = ANY(:TK)) AND (assembly_machine_id = ANY(:MC) OR testing_machine_id = ANY(:MC) OR qa_machine_id = ANY(:MC) OR wip_machine_id = ANY(:MC))`],
    ['retained tanks -> removed team (assembly/wip)', `SELECT COUNT(*) FROM tanks WHERE NOT (id = ANY(:TK)) AND (assembly_team_id = ANY(:TM) OR wip_team_id = ANY(:TM))`],
    ['retained test_attempts -> removed machine/team/employee', `SELECT COUNT(*) FROM test_attempts WHERE NOT (id = ANY(:TA)) AND (machine_id = ANY(:MC) OR team_id = ANY(:TM) OR tester_employee_id = ANY(:EM))`],
    ['retained labor sessions -> removed team/employee', `SELECT COUNT(*) FROM stage_labor_sessions WHERE NOT (id = ANY(:LS)) AND (team_id = ANY(:TM) OR started_by_employee_id = ANY(:EM) OR stopped_by_employee_id = ANY(:EM))`],
    ['retained labor participants -> removed employee/team', `SELECT COUNT(*) FROM stage_labor_participants WHERE NOT (session_id = ANY(:LS)) AND (employee_id = ANY(:EM) OR team_id = ANY(:TM))`],
    ['retained machine_sessions -> removed team', `SELECT COUNT(*) FROM machine_sessions WHERE NOT (id = ANY(:MS)) AND team_id = ANY(:TM)`],
    ['retained tank_pieces -> removed machine/team', `SELECT COUNT(*) FROM tank_pieces WHERE NOT (tank_id = ANY(:TK)) AND (machine_id = ANY(:MC) OR team_id = ANY(:TM))`],
    ['retained part_complete_events -> removed team/employee', `SELECT COUNT(*) FROM part_complete_events WHERE NOT COALESCE(tank_id = ANY(:TK), false) AND NOT COALESCE(session_id = ANY(:MS), false) AND (team_id = ANY(:TM) OR confirmed_by_employee_id = ANY(:EM))`],
    ['retained scan_logs -> removed employee', `SELECT COUNT(*) FROM scan_logs WHERE employee_id = ANY(:EM)`],
    ['retained session_team_members -> removed employee', `SELECT COUNT(*) FROM session_team_members WHERE NOT (session_id = ANY(:MS)) AND employee_id = ANY(:EM)`],
  ];
  const out = {};
  for (const [label, sql] of checks) {
    const [text, values] = bind(sql, sets);
    out[label] = Number((await db.query(text, values)).rows[0].count);
  }
  return out;
}

async function verifyExpected(db, sets) {
  const problems = [];
  const check = async (table, col, map) => {
    const idList = Object.keys(map).map(Number);
    const rows = (await db.query(`SELECT id, ${col} AS v FROM ${table} WHERE id = ANY($1::bigint[])`, [idList])).rows;
    const found = Object.fromEntries(rows.map((r) => [Number(r.id), r.v]));
    for (const [id, want] of Object.entries(map)) {
      if (!(id in found)) problems.push(`${table} id=${id} (${want}) not found`);
      else if (found[id] !== want) problems.push(`${table} id=${id} expected "${want}" got "${found[id]}"`);
    }
  };
  await check('machines', 'name', sets.expected.machines);
  await check('teams', 'name', sets.expected.teams);
  await check('tanks', 'tank_number', sets.expected.tanks);
  await check('employees', 'code', sets.expected.employees);
  await check('machines', 'name', PROTECTED_MACHINES);
  for (const id of Object.keys(PROTECTED_MACHINES).map(Number)) {
    if (sets.MC.includes(id)) problems.push(`protected machine ${id} is in removal set`);
  }
  return problems;
}

async function protectedSnapshot(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return JSON.stringify({
    machines: await q(`SELECT id, name, code, kiosk_slug, active, pin_hash, workflow, barcode, sort_order, assigned_team_id FROM machines WHERE id IN (5,6,7,77) ORDER BY id`),
    users: await q(`SELECT id, username, password_hash, pin_hash, role, station_name, area_name, is_active FROM users ORDER BY id`),
    alert_email_recipients: await q(`SELECT * FROM alert_email_recipients ORDER BY id`),
    session: await q(`SELECT COUNT(*)::int AS n FROM session`),
  });
}

async function captureDerivedIds(db, sets) {
  const one = async (sql) => {
    const [text, values] = bind(sql, sets);
    return (await db.query(text, values)).rows.map((r) => Number(r.id));
  };
  sets.MS = await one(`SELECT id FROM machine_sessions WHERE tank_id = ANY(:TK) OR machine_id = ANY(:MC) OR team_id = ANY(:TM)`);
  sets.LS = await one(`SELECT id FROM stage_labor_sessions WHERE tank_id = ANY(:TK) OR machine_id = ANY(:MC)`);
  sets.TA = await one(`SELECT id FROM test_attempts WHERE tank_id = ANY(:TK)`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  const conn = parseDatabaseUrl(url);
  console.log(`DB host: ${conn.host}:${conn.port}  DB name: ${conn.database}  user: ${conn.user}`);
  if (isNeonUrl(url)) throw new Error('Refusing: DATABASE_URL points to Neon.');
  if (!isLocalHost(conn.host)) throw new Error(`Refusing: host ${conn.host} is not local.`);
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'PREVIEW (read-only)'}  Tier: ${TIER}`);

  const sets = buildSets();
  const steps = buildSteps();

  const problems = await verifyExpected(pool, sets);
  if (problems.length) {
    console.error('ABORT: id/name verification failed:\n  ' + problems.join('\n  '));
    process.exitCode = 1;
    return;
  }
  await captureDerivedIds(pool, sets);

  console.log(`\nRemoval sets: tanks=${sets.TK.length} machines=${sets.MC.length} teams=${sets.TM.length} employees=${sets.EM.length}`);
  console.log(`Derived: machine_sessions=${sets.MS.length} labor_sessions=${sets.LS.length} test_attempts=${sets.TA.length}`);

  console.log('\nPlanned statements (in order) and affected row counts:');
  for (const st of steps) {
    const [text, values] = bind(`SELECT COUNT(*) FROM ${st.table} WHERE ${st.where}`, sets);
    const n = Number((await pool.query(text, values)).rows[0].count);
    st.preview = n;
    const verb = st.kind === 'delete' ? 'DELETE' : `UPDATE SET ${st.set}`;
    console.log(`  ${String(n).padStart(5)}  ${verb} ${st.table} WHERE ${st.where}`);
  }

  console.log('\nRetained rows that reference a removed row (FK SET NULL would apply):');
  const impact = await retainedImpact(pool, sets);
  for (const [k, v] of Object.entries(impact)) console.log(`  ${String(v).padStart(5)}  ${k}`);

  console.log('\nExisting orphan check (before):');
  const before = await runOrphanChecks(pool);
  const preOrphans = Object.entries(before).filter(([, v]) => v > 0);
  console.log(preOrphans.length ? preOrphans.map(([k, v]) => `  ${v}  ${k}`).join('\n') : '  none');

  if (!EXECUTE) {
    console.log('\nPREVIEW ONLY. Nothing was changed.');
    return;
  }
  if (!CONFIRMED) throw new Error('Refusing to execute without --confirm=DELETE-TEST-DATA');
  const blocking = Object.entries(impact).filter(([, v]) => v > 0);
  if (blocking.length) throw new Error(`Refusing: retained rows reference removed rows: ${JSON.stringify(blocking)}`);

  const backup = await createPgBackup();
  console.log(`\nPre-cleanup backup: ${backup.path} (${backup.size_bytes} bytes)`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapBefore = await protectedSnapshot(client);
    for (const st of steps) {
      const sql =
        st.kind === 'delete'
          ? `DELETE FROM ${st.table} WHERE ${st.where}`
          : `UPDATE ${st.table} SET ${st.set} WHERE ${st.where}`;
      const [text, values] = bind(sql, sets);
      const r = await client.query(text, values);
      console.log(`  ${String(r.rowCount).padStart(5)}  ${st.kind.toUpperCase()} ${st.table}`);
      if (r.rowCount !== st.preview) throw new Error(`${st.table}: affected ${r.rowCount}, preview said ${st.preview}`);
    }
    const snapAfter = await protectedSnapshot(client);
    if (snapBefore !== snapAfter) throw new Error('Protected rows changed (machines 5/6/7/77, users, recipients, sessions).');
    const after = await runOrphanChecks(client);
    const allowed = (label) => (label === 'tank_admin_audit.tank_id' && !PURGE_DELETED_TANK_AUDIT ? before[label] : 0);
    const orphans = Object.entries(after).filter(([label, v]) => v > allowed(label));
    if (orphans.length) throw new Error(`Orphans after cleanup: ${JSON.stringify(orphans)}`);
    await client.query('COMMIT');
    console.log(`\nCOMMITTED. Orphan check after: ${JSON.stringify(Object.entries(after).filter(([, v]) => v > 0)) || 'none'}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nROLLED BACK:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
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
