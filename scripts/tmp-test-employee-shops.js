'use strict';

/**
 * Local-only regression for Employee Shop Assignment + Assembly kiosk i18n wiring.
 *   node scripts/tmp-test-employee-shops.js snapshot   -> fingerprint existing rows (before)
 *   node scripts/tmp-test-employee-shops.js http       -> HTTP scenarios (creates ZZSHOP* test employees)
 *   node scripts/tmp-test-employee-shops.js compare    -> verify existing rows unchanged (after)
 * Refuses Neon. Only creates/removes its own ZZSHOP* employees and their memberships.
 */

require('./load-env');
const fs = require('fs');
const path = require('path');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

const BASE = 'http://localhost:3000';
const SNAP_FILE = path.join(__dirname, 'tmp-employee-shops-snapshot.json');
const MANAGER_PASSWORD = process.env.DEFAULT_MANAGER_PASSWORD || 'manager123';
const TABLES = [
  'employees',
  'teams',
  'team_members',
  'employee_team_memberships',
  'scan_logs',
  'machine_sessions',
  'session_team_members',
  'stage_labor_sessions',
  'stage_labor_participants',
  'downtime_intervals',
  'job_finish_events',
  'assembly_kiosk_teams',
  'assembly_tank_teams',
  'tanks',
];

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures += 1;
}

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(p, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(BASE + p, { redirect: 'manual', ...opts, headers });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const part = c.split(';')[0];
      if (part.startsWith('factory_scan_sid=')) this.cookie = part;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_e) {}
    return { status: res.status, data, text };
  }
  json(p, method, body) {
    return this.req(p, { method, body: JSON.stringify(body || {}) });
  }
}

async function tableFingerprints(maxIds) {
  const out = {};
  for (const t of TABLES) {
    const exists = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`]);
    if (!exists.rows[0].ok) continue;
    const max = maxIds ? maxIds[t] : (await pool.query(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM ${t}`)).rows[0].m;
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) AS h
       FROM ${t} x WHERE x.id <= $1`,
      [max]
    );
    out[t] = { max: String(max), n: r.rows[0].n, h: r.rows[0].h };
  }
  return out;
}

async function snapshot() {
  const fp = await tableFingerprints(null);
  fs.writeFileSync(SNAP_FILE, JSON.stringify(fp, null, 2));
  for (const [t, v] of Object.entries(fp)) console.log(`${t}: rows<=${v.max} count=${v.n}`);
  console.log(`snapshot written: ${path.basename(SNAP_FILE)}`);
}

async function compare() {
  const before = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
  const maxIds = Object.fromEntries(Object.entries(before).map(([t, v]) => [t, v.max]));
  const after = await tableFingerprints(maxIds);
  for (const t of Object.keys(before)) {
    const same = after[t] && after[t].n === before[t].n && after[t].h === before[t].h;
    check(same, `${t}: ${before[t].n} pre-existing rows unchanged`);
  }
  const shops = await pool.query(`SELECT COUNT(*)::int AS n FROM employee_shops`);
  const emps = await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE code LIKE 'ZZ%'`);
  const teams = await pool.query(`SELECT COUNT(*)::int AS n FROM teams WHERE barcode LIKE 'ZZSHOP%' AND active = 1`);
  check(shops.rows[0].n === 0, `employee_shops left with ${shops.rows[0].n} rows (test rows removed with their employees)`);
  check(emps.rows[0].n === 0, `no leftover ZZ test employees (${emps.rows[0].n})`);
  check(teams.rows[0].n === 0, `no active ZZ test teams (${teams.rows[0].n})`);
}

async function pickTeam(department) {
  const r = await pool.query(
    `SELECT id, name, barcode FROM teams WHERE active = 1 AND department = $1 ORDER BY id LIMIT 1`,
    [department]
  );
  return r.rows[0] || null;
}

async function http() {
  const M = new Client();
  const login = await M.json('/api/auth/login', 'POST', { username: 'manager', password: MANAGER_PASSWORD });
  if (!(login.status === 200 && login.data && login.data.ok)) throw new Error(`manager login failed: ${login.status}`);

  const created = [];
  const memberRows = [];
  let tempTeamId = null;
  try {
    console.log('== Existing employees load with no guessed shops');
    const list = await M.req('/api/employees');
    const dbCount = (await pool.query(`SELECT COUNT(*)::int AS n FROM employees`)).rows[0].n;
    check(list.status === 200 && list.data.ok, 'GET /api/employees -> 200');
    check(list.data.shop_assignment_ready === true, 'shop_assignment_ready = true after local migration');
    check(list.data.employees.length === dbCount, `directory returns all ${dbCount} employees`);
    check(list.data.employees.every((e) => Array.isArray(e.shops)), 'every employee has a shops array');
    const preassigned = (await pool.query(`SELECT COUNT(*)::int AS n FROM employee_shops`)).rows[0].n;
    check(preassigned === 0, `no shop rows were created for existing employees (rows: ${preassigned})`);

    const fab = await pickTeam('Fabrication');
    const asm = await pickTeam('Assembly');
    let dome = await pickTeam('Dome');
    if (!dome) {
      const stampT = Date.now().toString().slice(-6);
      const t = await M.json('/api/manager/teams', 'POST', {
        name: `ZZ Shop Test Dome ${stampT}`,
        barcode: `ZZSHOPDOME${stampT}`,
        department: 'Dome',
      });
      if (t.data && t.data.ok) {
        tempTeamId = Number(t.data.team.id);
        dome = { id: tempTeamId, name: t.data.team.name, barcode: t.data.team.barcode };
      }
    }
    const qa = await pickTeam('QA/QC');
    console.log(
      `   teams: Fabrication=${fab && fab.name}, Assembly=${asm && asm.name}, Dome=${dome && dome.name}, QA/QC=${qa && qa.name}`
    );

    console.log('== Create employees with one / multiple / no shops');
    const stamp = Date.now().toString().slice(-6);
    const one = await M.json('/api/employees', 'POST', {
      code: `ZZSHOPA${stamp}`,
      name: 'ZZ Shop Test Assembly',
      hourly_rate: 21,
      badge_role: 'Assembly Team Member',
      shops: ['Assembly'],
    });
    check(one.status === 201 && JSON.stringify(one.data.employee.shops) === '["Assembly"]', 'create with one shop (Assembly)');
    const multi = await M.json('/api/employees', 'POST', {
      code: `ZZSHOPFD${stamp}`,
      name: 'ZZ Shop Test Fab Dome',
      hourly_rate: 22,
      badge_role: 'Fabrication Team Member',
      shops: ['Dome', 'fabrication', 'Dome'],
    });
    check(
      multi.status === 201 && JSON.stringify(multi.data.employee.shops) === '["Fabrication","Dome"]',
      `create with two shops, normalized + de-duplicated -> ${multi.data && JSON.stringify(multi.data.employee && multi.data.employee.shops)}`
    );
    const none = await M.json('/api/employees', 'POST', {
      code: `ZZSHOPN${stamp}`,
      name: 'ZZ Shop Test Unassigned',
      hourly_rate: 20,
      badge_role: 'Fabrication Team Member',
    });
    check(none.status === 201 && none.data.employee.shops.length === 0, 'create without shops -> Unassigned');
    for (const r of [one, multi, none]) if (r.data && r.data.employee) created.push(Number(r.data.employee.id));
    const bad = await M.json('/api/employees', 'POST', { code: `ZZSHOPX${stamp}`, name: 'ZZ bad', shops: ['Paint'] });
    check(bad.status === 400, 'unknown shop rejected (400), nothing created');
    const badRow = await pool.query(`SELECT 1 FROM employees WHERE code = $1`, [`ZZSHOPX${stamp}`]);
    check(!badRow.rows.length, 'rejected employee not inserted');

    const [idA, idFD, idN] = created;

    console.log('== Save / load when editing');
    const got = await M.req(`/api/employees/${idFD}`);
    check(JSON.stringify(got.data.employee.shops) === '["Fabrication","Dome"]', 'GET by id returns saved shops');
    const all3 = await M.json(`/api/employees/${idA}`, 'PUT', {
      code: `ZZSHOPA${stamp}`,
      name: 'ZZ Shop Test Assembly',
      hourly_rate: 21,
      badge_role: 'Assembly Team Member',
      status: 'ACTIVE',
      shops: ['Fabrication', 'Assembly', 'Dome'],
    });
    check(JSON.stringify(all3.data.employee.shops) === '["Fabrication","Assembly","Dome"]', 'edit to all three shops');
    const noField = await M.json(`/api/employees/${idA}`, 'PUT', {
      code: `ZZSHOPA${stamp}`,
      name: 'ZZ Shop Test Assembly',
      hourly_rate: 23.5,
      badge_role: 'Assembly Team Member',
      status: 'ACTIVE',
    });
    check(
      noField.data.employee.shops.length === 3 && Number(noField.data.employee.hourly_rate) === 23.5,
      'edit without shops field keeps shops; other fields still save'
    );
    const back = await M.json(`/api/employees/${idA}`, 'PUT', {
      code: `ZZSHOPA${stamp}`,
      name: 'ZZ Shop Test Assembly',
      hourly_rate: 21,
      badge_role: 'Assembly Team Member',
      status: 'ACTIVE',
      shops: ['Assembly'],
    });
    check(JSON.stringify(back.data.employee.shops) === '["Assembly"]', 'edit back to one shop');
    check(back.data.employee.badge_role === 'Assembly Team Member', 'badge role unchanged by shop edits');

    console.log('== Team eligibility (search + add)');
    if (fab && dome) {
      const sFab = await M.req(`/api/manager/employees/search?q=ZZ%20Shop&team_id=${fab.id}`);
      const elig = (id) => (sFab.data.employees.find((e) => e.id === id) || {}).shop_eligibility;
      check(sFab.data.team_department === 'Fabrication', 'search reports team department');
      check(elig(idFD) === 'eligible', 'Fab+Dome employee eligible for Fabrication team');
      check(elig(idA) === 'ineligible', 'Assembly-only employee not eligible for Fabrication team');
      check(elig(idN) === 'unassigned', 'unassigned employee flagged "unassigned" (still allowed)');
      const sDome = await M.req(`/api/manager/employees/search?q=ZZ%20Shop&team_id=${dome.id}`);
      check(
        (sDome.data.employees.find((e) => e.id === idFD) || {}).shop_eligibility === 'eligible',
        'Fab+Dome employee eligible for Dome team'
      );

      const denied = await M.json(`/api/manager/teams/${fab.id}/members`, 'POST', { employee_id: idA });
      check(denied.status === 409 && denied.data.error === 'shop_ineligible', `Assembly-only -> Fabrication team blocked (${denied.status} ${denied.data && denied.data.error})`);
      const addFab = await M.json(`/api/manager/teams/${fab.id}/members`, 'POST', { employee_id: idFD });
      check(addFab.status === 200 && addFab.data.ok, 'Fab+Dome employee added to Fabrication team');
      const toDome = await M.json(`/api/manager/teams/${dome.id}/members`, 'POST', { employee_id: idFD });
      check(toDome.status === 409 && toDome.data.error === 'assigned_elsewhere', 'Dome add asks to move (existing one-roster rule kept)');
      const moveDome = await M.json(`/api/manager/teams/${dome.id}/members`, 'POST', { employee_id: idFD, move: true });
      check(moveDome.status === 200 && moveDome.data.ok, 'Fab+Dome employee moved to Dome team');
      if (moveDome.data && moveDome.data.member) memberRows.push([dome.id, Number(moveDome.data.member.id)]);
    } else {
      console.log('SKIP  Fabrication/Dome team missing locally');
    }
    if (asm) {
      const addN = await M.json(`/api/manager/teams/${asm.id}/members`, 'POST', { employee_id: idN });
      check(addN.status === 200 && addN.data.ok, 'unassigned employee can still be added (no guessing, no block)');
      if (addN.data && addN.data.member) memberRows.push([asm.id, Number(addN.data.member.id)]);
    }
    if (qa) {
      const sQa = await M.req(`/api/manager/employees/search?q=ZZ%20Shop&team_id=${qa.id}`);
      check(
        sQa.data.employees.filter((e) => created.includes(e.id)).every((e) => e.shop_eligibility === 'not_applicable'),
        'QA/QC team: shop filtering not applied'
      );
    }

    console.log('== Conflict flagged, membership kept');
    if (dome) {
      const narrow = await M.json(`/api/employees/${idFD}`, 'PUT', {
        code: `ZZSHOPFD${stamp}`,
        name: 'ZZ Shop Test Fab Dome',
        hourly_rate: 22,
        badge_role: 'Fabrication Team Member',
        status: 'ACTIVE',
        shops: ['Fabrication'],
      });
      const conflicts = narrow.data.employee.shop_conflicts || [];
      check(
        narrow.status === 200 && conflicts.some((c) => c.team_id === Number(dome.id)),
        'removing Dome shop while on a Dome team returns a conflict for review'
      );
      const still = await pool.query(
        `SELECT 1 FROM team_members WHERE team_id = $1 AND employee_id = $2 AND active = 1`,
        [dome.id, idFD]
      );
      check(still.rows.length === 1, 'employee NOT removed from the Dome team');
      const full = await M.req('/api/manager/teams/full');
      const domeTeam = full.data.teams.find((t) => Number(t.id) === Number(dome.id));
      const mem = domeTeam && domeTeam.members.find((m) => Number(m.employee_id) === idFD && Number(m.active) === 1);
      check(mem && mem.shop_conflict === true, 'Teams page data flags shop_conflict on the member');
      const dir = await M.req('/api/employees');
      const row = dir.data.employees.find((e) => Number(e.id) === idFD);
      check(row && row.shop_conflicts.length === 1, 'Employee Directory row lists the conflict');
    }

    console.log('== Team barcodes + kiosk pages');
    if (fab) {
      const tb = await M.req(`/manager/command-print?type=teams&department=Fabrication`);
      check(tb.status === 200 && tb.text.includes(fab.barcode), 'Fabrication team barcode print page still renders team barcode');
    }
    const K = new Client();
    const page = await K.req('/kiosk/machine/assembly-1');
    check(page.status === 200, 'Assembly kiosk page loads');
    check(
      /\/i18n\.js/.test(page.text) && /\/assembly-kiosk-i18n\.js/.test(page.text) && /data-i18n="ak\.scanTitle"/.test(page.text),
      'Assembly kiosk page loads the language files and tags static text'
    );
    const dict = await K.req('/assembly-kiosk-i18n.js');
    check(dict.status === 200 && dict.text.includes('AssemblyI18n'), 'assembly-kiosk-i18n.js served to kiosk (no login needed)');
    const cfg = await K.req('/api/kiosk/assembly/config');
    check(cfg.status === 200 && cfg.data && cfg.data.ok, 'Assembly kiosk config API -> 200');
  } finally {
    console.log('== Cleanup (test rows only)');
    for (const [teamId, memberId] of memberRows) {
      await M.req(`/api/manager/teams/${teamId}/members/${memberId}`, { method: 'DELETE' });
    }
    for (const id of created) {
      const del = await M.req(`/api/employees/${id}`, { method: 'DELETE' });
      if (del.status !== 200) {
        await pool.query(`UPDATE employees SET is_active = 0 WHERE id = $1 AND code LIKE 'ZZSHOP%'`, [id]);
        console.log(`   employee ${id}: delete blocked by history rows (${del.status}) -> deactivated instead`);
      }
    }
    if (tempTeamId) {
      const d = await M.req(`/api/manager/teams/${tempTeamId}`, { method: 'DELETE' });
      console.log(`   temporary Dome team ${tempTeamId} deactivated (${d.status})`);
    }
  }
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon.');
  const mode = process.argv[2];
  if (mode === 'snapshot') await snapshot();
  else if (mode === 'compare') await compare();
  else if (mode === 'http') await http();
  else throw new Error('mode: snapshot | http | compare');
  if (mode !== 'snapshot') console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures) process.exitCode = 1;
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    await closePool();
    process.exit(1);
  });
