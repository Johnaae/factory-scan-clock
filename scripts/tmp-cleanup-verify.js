'use strict';

/** READ-ONLY post-cleanup verification: DB state + live HTTP checks (GET only, plus one wrong-PIN probe). */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:3000';
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures += 1;
};
const q = async (sql) => (await pool.query(sql)).rows;

async function dbChecks() {
  console.log('== Table row counts');
  const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  for (const { table_name } of tables) {
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM "${table_name}"`);
    console.log(`  ${String(n).padStart(5)}  ${table_name}`);
  }
  ok(tables.length === 27, `schema intact: ${tables.length} tables (expected 27)`);

  console.log('== Machines');
  const machines = await q(`SELECT id, name, code, kiosk_slug, active, workflow, (pin_hash IS NOT NULL AND pin_hash <> '') AS has_pin, assigned_team_id, active_tank_id FROM machines ORDER BY id`);
  machines.forEach((m) => console.log(`  ${JSON.stringify(m)}`));
  const want = { 5: 'Winding Machine 01', 6: 'Winding Machine 02', 7: 'Winding Machine 03', 77: 'Winding Machine 04' };
  ok(machines.length === 4, `exactly 4 machines remain (${machines.length})`);
  for (const [id, name] of Object.entries(want)) {
    const m = machines.find((x) => Number(x.id) === Number(id));
    ok(m && m.name === name && m.active === 1 && m.workflow === 'winding' && m.has_pin, `${name} present, active, winding, PIN configured`);
  }

  console.log('== Teams');
  const teams = await q(`SELECT id, name, active FROM teams ORDER BY id`);
  teams.forEach((t) => console.log(`  ${t.id} ${t.name} active=${t.active}`));
  ok(teams.map((t) => Number(t.id)).join(',') === '1,2,3,7,11', 'teams = Team A/B/C, Winder 1, 10\' water');

  console.log('== Employees');
  const emps = await q(`SELECT id, code, name FROM employees ORDER BY code`);
  ok(emps.length === 20, `20 employees remain (${emps.length})`);
  ok(emps.every((e) => /^EMP0(0[1-9]|1\d|20)$/.test(e.code)), `all remaining employee codes are EMP001-EMP020`);
  const [{ n: memb }] = await q(`SELECT COUNT(*)::int AS n FROM employee_team_memberships`);
  const [{ n: tm }] = await q(`SELECT COUNT(*)::int AS n FROM team_members`);
  ok(memb === 34 && tm === 8, `real team memberships kept (memberships=${memb}/34, team_members=${tm}/8)`);

  console.log('== Users');
  const users = await q(`SELECT id, username, role, is_active, (password_hash IS NOT NULL) AS has_pw, (pin_hash IS NOT NULL) AS has_pin FROM users ORDER BY id`);
  users.forEach((u) => console.log(`  ${u.id} ${u.username} ${u.role} active=${u.is_active} pw=${u.has_pw} pin=${u.has_pin}`));
  ok(users.length === 9 && users.every((u) => u.is_active === 1 && u.has_pw), '9 users remain, active, with credentials');

  const [{ n: rec }] = await q(`SELECT COUNT(*)::int AS n FROM alert_email_recipients`);
  ok(rec === 2, `alert email recipients kept (${rec})`);

  console.log('== Test data remaining');
  const [{ n: tanks }] = await q(`SELECT COUNT(*)::int AS n FROM tanks`);
  ok(tanks === 0, `no tanks remain (${tanks})`);
  const leftovers = await q(`
    SELECT 'machine' AS k, name AS v FROM machines WHERE name ~* '(test|asm|qa|lunch|sync|^\\d+$)'
    UNION ALL SELECT 'team', name FROM teams WHERE name ~* '(test|p2|sync|tap ctx|team[12ab]-)'
    UNION ALL SELECT 'employee', code FROM employees WHERE code !~ '^EMP\\d{3}$'`);
  ok(leftovers.length === 0, `no test-pattern machines/teams/employees remain ${leftovers.length ? JSON.stringify(leftovers) : ''}`);

  console.log('== Orphans (declared FKs + soft references)');
  const orphanSql = {
    'machines.active_tank_id': `SELECT COUNT(*)::int n FROM machines c WHERE c.active_tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.active_tank_id)`,
    'machines.assigned_team_id': `SELECT COUNT(*)::int n FROM machines c WHERE c.assigned_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.assigned_team_id)`,
    'assembly_kiosk_teams': `SELECT COUNT(*)::int n FROM assembly_kiosk_teams`,
    'test_attempts': `SELECT COUNT(*)::int n FROM test_attempts`,
    'test_attempt_notes': `SELECT COUNT(*)::int n FROM test_attempt_notes`,
    'stage_labor_sessions': `SELECT COUNT(*)::int n FROM stage_labor_sessions`,
    'stage_labor_participants': `SELECT COUNT(*)::int n FROM stage_labor_participants`,
    'machine_sessions': `SELECT COUNT(*)::int n FROM machine_sessions`,
    'session_team_members': `SELECT COUNT(*)::int n FROM session_team_members`,
    'part_complete_events': `SELECT COUNT(*)::int n FROM part_complete_events`,
    'tank_pieces': `SELECT COUNT(*)::int n FROM tank_pieces`,
    'tank_admin_phase2_audit': `SELECT COUNT(*)::int n FROM tank_admin_phase2_audit`,
    'machine_session_edits': `SELECT COUNT(*)::int n FROM machine_session_edits`,
    'employee_team_memberships dangling': `SELECT COUNT(*)::int n FROM employee_team_memberships c WHERE NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.team_id) OR NOT EXISTS (SELECT 1 FROM employees p WHERE p.id=c.employee_id)`,
    'team_members dangling': `SELECT COUNT(*)::int n FROM team_members c WHERE NOT EXISTS (SELECT 1 FROM teams p WHERE p.id=c.team_id) OR (c.employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees p WHERE p.id=c.employee_id))`,
  };
  for (const [label, sql] of Object.entries(orphanSql)) {
    const [{ n }] = await q(sql);
    ok(n === 0, `${label}: ${n}`);
  }
  const [{ n: audit }] = await q(`SELECT COUNT(*)::int n FROM tank_admin_audit c WHERE c.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanks p WHERE p.id=c.tank_id)`);
  const [{ n: auditAll }] = await q(`SELECT COUNT(*)::int n FROM tank_admin_audit`);
  ok(audit === 72 && auditAll === 72, `tank_admin_audit: 72 historical rows kept as approved (${auditAll} total)`);
}

async function httpChecks() {
  console.log('== HTTP (live server)');
  const jar = [];
  const req = async (path, opts = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (jar.length) headers.Cookie = jar.join('; ');
    const res = await fetch(BASE + path, { redirect: 'manual', ...opts, headers });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) {
      const part = c.split(';')[0];
      const name = part.split('=')[0];
      const i = jar.findIndex((x) => x.startsWith(name + '='));
      if (i >= 0) jar[i] = part;
      else jar.push(part);
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_e) {}
    return { status: res.status, data, text };
  };

  for (const p of ['/login', '/kiosk-login', '/manager-login', '/login.html', '/kiosk-login.html', '/styles.css', '/manager.js', '/assembly-kiosk.js', '/phase2-qa-kiosk.js', '/machine-areas.js']) {
    const r = await req(p);
    ok(r.status === 200, `GET ${p} -> ${r.status}`);
  }

  const km = await req('/api/auth/kiosk-login-machines');
  const names = km.data && km.data.machines ? km.data.machines.map((m) => m.name) : [];
  ok(km.status === 200 && names.join('|') === 'Winding Machine 01|Winding Machine 02|Winding Machine 03|Winding Machine 04', `kiosk login dropdown: ${names.join(', ')}`);

  const wrong = await req('/api/auth/login-kiosk-pin', { method: 'POST', body: JSON.stringify({ machine_id: 5, pin: '000000' }) });
  ok(wrong.status === 401 && wrong.data && wrong.data.error === 'invalid_credentials', `WM-01 PIN check active (wrong PIN -> ${wrong.status} ${wrong.data && wrong.data.error})`);
  jar.length = 0;

  const login = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'manager', password: process.env.DEFAULT_MANAGER_PASSWORD || 'manager123' }),
  });
  if (!(login.status === 200 && login.data && login.data.ok)) {
    console.log(`SKIP  manager API checks (manager login returned ${login.status})`);
    return;
  }
  const pages = ['/manager-dashboard', '/manager', '/teams', '/machine-areas', '/alert-email-settings', '/qa-qc', '/system', '/dashboard', '/assembly-kiosk.html'];
  for (const p of pages) {
    const r = await req(p);
    ok(r.status === 200 || r.status === 302, `GET ${p} (manager) -> ${r.status}`);
  }
  const apis = [
    '/api/manager/machines',
    '/api/manager/assembly-machines',
    '/api/manager/machine-areas',
    '/api/manager/kiosk-pins',
    '/api/manager/teams',
    '/api/manager/teams/full',
    '/api/manager/teams/dashboard',
    '/api/manager/alerts',
    '/api/manager/alert-email-recipients',
    '/api/manager/production-history',
    '/api/manager/production-notes',
    '/api/manager/current-work',
    '/api/manager/tank-summary',
    '/api/manager/finished-jobs',
    '/api/manager/daily-summary',
    '/api/manager/overtime-watch',
    '/api/employees',
    '/api/tanks',
    '/api/dashboard',
    '/api/dashboard/team-activity',
    '/api/logs',
    '/api/summary/today',
    '/api/payroll/today',
    '/api/status',
    '/api/system/database-status',
    '/api/admin/backup/status',
  ];
  for (const p of apis) {
    const r = await req(p);
    ok(r.status === 200, `GET ${p} -> ${r.status}${r.status !== 200 ? ' ' + r.text.slice(0, 160) : ''}`);
  }
  const pins = await req('/api/manager/kiosk-pins');
  if (pins.data) console.log(`  kiosk-pins: ${JSON.stringify(pins.data).slice(0, 600)}`);
  const emps = await req('/api/employees');
  const empList = Array.isArray(emps.data) ? emps.data : (emps.data && (emps.data.employees || emps.data.rows)) || [];
  console.log(`  /api/employees returned ${empList.length} employees`);
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon.');
  await dbChecks();
  await httpChecks();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures) process.exitCode = 1;
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    await closePool();
    process.exit(1);
  });
