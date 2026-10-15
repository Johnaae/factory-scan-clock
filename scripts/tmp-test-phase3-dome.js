'use strict';

/**
 * Local-only Phase 3 (Dome Shop / Dome Inventory / Fabrication Dome Install) regression.
 *   node scripts/tmp-test-phase3-dome.js snapshot   -> fingerprint existing rows (before)
 *   node scripts/tmp-test-phase3-dome.js http       -> HTTP scenarios (creates ZZP3* test rows)
 *   node scripts/tmp-test-phase3-dome.js compare    -> verify pre-existing rows unchanged (after)
 * Refuses Neon. Test rows are prefixed ZZP3 and are left in place (no deletes).
 */

require('./load-env');
const fs = require('fs');
const path = require('path');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

const BASE = 'http://localhost:3000';
const SNAP_FILE = path.join(__dirname, 'tmp-phase3-snapshot.json');
const MANAGER_PASSWORD = process.env.DEFAULT_MANAGER_PASSWORD || 'manager123';
const TABLES = [
  'employees',
  'teams',
  'team_members',
  'employee_team_memberships',
  'scan_logs',
  'machines',
  'machine_sessions',
  'session_team_members',
  'stage_labor_sessions',
  'stage_labor_participants',
  'downtime_intervals',
  'job_finish_events',
  'assembly_kiosk_teams',
  'assembly_tank_teams',
  'tanks',
  'tank_pieces',
  'test_attempts',
];

let failures = 0;
function check(cond, msg, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${!cond && extra !== undefined ? `  -> ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
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
}

async function http() {
  const stamp = Date.now().toString().slice(-6);
  const M = new Client();
  const login = await M.json('/api/auth/login', 'POST', { username: 'manager', password: MANAGER_PASSWORD });
  if (!(login.status === 200 && login.data && login.data.ok)) throw new Error(`manager login failed: ${login.status}`);

  console.log('== Setup (ZZP3 test rows)');
  const domeMachine = await M.json('/api/manager/machine-areas', 'POST', { name: `ZZP3 Dome Shop ${stamp}`, workflow: 'dome' });
  check(domeMachine.data && domeMachine.data.ok && domeMachine.data.machine.workflow === 'dome', 'create machine with workflow=dome', domeMachine.data);
  const winder = await M.json('/api/manager/machine-areas', 'POST', { name: `ZZP3 Winder ${stamp}`, workflow: 'winding' });
  check(winder.data && winder.data.ok, 'create test Fabrication machine');
  const domeSlug = domeMachine.data.machine.kiosk_slug || domeMachine.data.machine.slug;
  const winderSlug = winder.data.machine.kiosk_slug || winder.data.machine.slug;

  const asmMachine = await M.json('/api/manager/machine-areas', 'POST', { name: `ZZP3 Assembly ${stamp}`, workflow: 'assembly_testing' });
  check(asmMachine.data && asmMachine.data.ok, 'create test Assembly machine');
  const asmSlug = asmMachine.data.machine.kiosk_slug || asmMachine.data.machine.slug;

  const mkTeam = async (label, code, department) => {
    const t = (await M.json('/api/manager/teams', 'POST', { name: `ZZP3 ${label} ${stamp}`, barcode: `ZZP3${code}${stamp}`, department })).data.team;
    return t ? { ...t, id: Number(t.id) } : t;
  };
  const domeTeam = await mkTeam('Dome Team', 'DOME', 'Dome');
  const domeTeamB = await mkTeam('Dome Team B', 'DOMEB', 'Dome');
  const fabTeam = await mkTeam('Fab Team', 'FAB', 'Fabrication');
  const asmTeam = await mkTeam('Asm Team', 'ASM', 'Assembly');
  check(domeTeam && domeTeamB && fabTeam && asmTeam, 'create 2 Dome + Fabrication + Assembly test teams');

  const mkEmp = async (suffix, shops, role) => {
    const r = await M.json('/api/employees', 'POST', {
      code: `ZZP3${suffix}${stamp}`,
      name: `ZZP3 ${suffix}`,
      hourly_rate: 20,
      badge_role: role || 'Fabrication Team Member',
      shops,
    });
    return r.data.employee ? { ...r.data.employee, id: Number(r.data.employee.id) } : r.data.employee;
  };
  const e1 = await mkEmp('D1', ['Dome']);
  const e2 = await mkEmp('D2', ['Dome']);
  const e3 = await mkEmp('D3', ['Dome', 'Fabrication']);
  const e4 = await mkEmp('D4', ['Dome']);
  const e5 = await mkEmp('D5', ['Dome']);
  const f1 = await mkEmp('F1', ['Fabrication']);
  const a1 = await mkEmp('A1', ['Assembly']);
  for (const e of [e1, e2, e3]) await M.json(`/api/manager/teams/${domeTeam.id}/members`, 'POST', { employee_id: e.id });
  for (const e of [e4, e5]) await M.json(`/api/manager/teams/${domeTeamB.id}/members`, 'POST', { employee_id: e.id });
  await M.json(`/api/manager/teams/${fabTeam.id}/members`, 'POST', { employee_id: f1.id });
  await M.json(`/api/manager/teams/${asmTeam.id}/members`, 'POST', { employee_id: a1.id });

  console.log('== Dome kiosk routing');
  const K = new Client();
  const page = await K.req(`/kiosk/machine/${domeSlug}`);
  check(page.status === 200 && /dome-kiosk\.js/.test(page.text), 'dome machine URL serves dome-kiosk.html');
  const wrong = await K.req('/api/kiosk/winding/config');
  check(wrong.status === 409 && wrong.data.error === 'wrong_workflow', 'winding API rejects dome kiosk session');
  let cfg = await K.req('/api/kiosk/dome/config');
  check(cfg.status === 200 && cfg.data.ok && cfg.data.workflow === 'dome', 'GET /api/kiosk/dome/config', cfg.data);
  check(JSON.stringify(cfg.data.diameters) === '[4,6,8,10,12]' && cfg.data.types.join() === 'Petro,Water', 'diameters + types offered');
  const act = (body) => K.json('/api/kiosk/dome/action', 'POST', body);

  const n1 = `ZZP3-D${stamp}A`;
  const n2 = `ZZP3-D${stamp}B`;
  const n3 = `ZZP3-E${stamp}C`;
  const A = domeTeam.id;
  const B = domeTeamB.id;
  const openParts = async (employeeId) =>
    (
      await pool.query(
        `SELECT p.id, s.dome_id, s.team_id, p.joined_at, p.left_at FROM dome_labor_participants p
         JOIN dome_labor_sessions s ON s.id = p.session_id
         WHERE p.employee_id = $1 AND p.left_at IS NULL AND s.status = 'active'`,
        [employeeId]
      )
    ).rows;
  const openTeams = async (employeeId) =>
    (
      await pool.query(
        `SELECT team_id, source FROM employee_team_memberships WHERE employee_id = $1 AND left_at IS NULL ORDER BY id`,
        [employeeId]
      )
    ).rows.map((x) => ({ team_id: Number(x.team_id), source: x.source }));
  const domeRow = async (id) => (await pool.query(`SELECT production_status, pause_reason, team_id FROM domes WHERE id = $1`, [id])).rows[0];
  const teamCard = (c, id) => (c.data.active_teams || []).find((t) => t.team_id === Number(id));

  let r = await act({ action: 'create_dome', dome_number: n1, dome_type: 'Petro', diameter_ft: 8, team_id: A });
  check(r.status === 409 && ['need_team', 'team_not_on_kiosk'].includes(r.data.error), 'create dome needs a team on the kiosk', r.data);
  r = await act({ action: 'scan', barcode: fabTeam.barcode });
  check(r.status === 409 && r.data.error === 'wrong_department', 'Fabrication team rejected on Dome kiosk', r.data);

  console.log('== Multiple Dome teams on one kiosk (Assembly presence)');
  r = await act({ action: 'scan', barcode: domeTeam.barcode });
  check(r.status === 200 && r.data.action === 'team_assigned' && r.data.team.id === A, 'Dome team A scan adds its card', r.data);
  r = await act({ action: 'scan', barcode: domeTeamB.barcode });
  check(r.status === 200 && r.data.action === 'team_assigned' && r.data.team.id === B, 'Dome team B scan adds a second card', r.data);
  r = await act({ action: 'scan', barcode: domeTeam.barcode });
  check(r.status === 200 && r.data.action === 'team_present', 'rescanning team A focuses it (no duplicate card)', r.data);
  cfg = await K.req('/api/kiosk/dome/config');
  check(cfg.data.active_teams.length === 2, 'config: 2 team cards side by side', cfg.data.active_teams);
  const rosterIds = (c, id) => (teamCard(c, id) ? teamCard(c, id).roster.map((e) => e.id).sort((x, y) => x - y) : []);
  check(
    JSON.stringify(rosterIds(cfg, A)) === JSON.stringify([e1.id, e2.id, e3.id].sort((x, y) => x - y)) &&
      JSON.stringify(rosterIds(cfg, B)) === JSON.stringify([e4.id, e5.id].sort((x, y) => x - y)),
    'each card shows its default roster on shift'
  );
  for (const kw of ['STOP:LUNCH', 'LUNCH', 'RESUME', 'END_SHIFT']) {
    r = await act({ action: 'scan', barcode: kw, team_id: A });
    check(r.status === 400 && r.data.error === 'use_buttons', `scan "${kw}" -> use the team-card buttons (Assembly rule)`, r.data);
  }

  console.log('== Assembly / Dome moves stay separate');
  const AK = new Client();
  await AK.req(`/kiosk/machine/${asmSlug}`);
  const aact = (body) => AK.json('/api/kiosk/assembly/action', 'POST', body);
  r = await aact({ action: 'scan', barcode: asmTeam.barcode });
  check(r.status === 200 && r.data.action === 'assign_team', 'Assembly kiosk: Assembly team scanned', r.data);
  r = await act({ action: 'scan', barcode: a1.code, team_id: A });
  check(r.status === 409 && r.data.error === 'not_assembly_team', 'Dome kiosk cannot pull an Assembly-team employee', r.data);
  r = await aact({ action: 'scan', barcode: e5.code, team_id: asmTeam.id });
  check(r.status === 409 && r.data.error === 'not_assembly_team', 'Assembly kiosk cannot pull a Dome-team employee', r.data);
  check((await openTeams(e5.id)).every((m) => m.team_id === B), 'D5 still only on Dome team B');

  console.log('== Create Dome (team employees assigned automatically)');
  r = await act({ action: 'create_dome', dome_number: n1, dome_type: 'Petro', diameter_ft: 7, team_id: A });
  check(r.status === 400 && r.data.error === 'diameter_required', "diameter 7' rejected");
  r = await act({ action: 'create_dome', dome_number: n1, dome_type: 'Oil', diameter_ft: 8, team_id: A });
  check(r.status === 400, 'type Oil rejected');
  r = await act({ action: 'create_dome', dome_number: n1, dome_type: 'Petro', diameter_ft: 8 });
  check(r.status === 409 && r.data.error === 'select_team', 'two teams on the kiosk: Create Dome needs the selected team', r.data);
  r = await act({ action: 'create_dome', dome_number: n1, dome_type: 'Petro', diameter_ft: 8, team_id: A, fabricator_ids: [f1.id] });
  check(r.status === 409 && r.data.error === 'not_dome_shop', 'manual pick of a Fabrication-only employee rejected', r.data);
  r = await act({ action: 'create_dome', dome_number: n1, dome_type: 'Petro', diameter_ft: 8, team_id: A });
  check(
    r.status === 200 && r.data.dome.team_id === A && JSON.stringify([...r.data.fabricator_ids].sort((x, y) => x - y)) === JSON.stringify([e1.id, e2.id, e3.id].sort((x, y) => x - y)),
    "create dome A (Petro 8') for team A — no fabricator pick, team roster assigned",
    r.data
  );
  const d1 = r.data.dome;
  r = await act({ action: 'create_dome', dome_number: ` ${n1.toLowerCase()} `, dome_type: 'Water', diameter_ft: 6, team_id: B });
  check(r.status === 409 && r.data.error === 'duplicate_dome_number', 'duplicate dome number (case/space-insensitive) rejected', r.data);
  r = await act({ action: 'create_dome', dome_number: n2, dome_type: 'Water', diameter_ft: '10', team_id: B });
  check(r.status === 200 && r.data.dome.team_id === B, "create dome B (Water 10') for team B");
  const d2 = r.data.dome;
  r = await act({ action: 'create_dome', dome_number: n3, dome_type: 'Water', diameter_ft: 4, team_id: A });
  check(r.status === 200, 'create dome C for team A');
  const d3 = r.data.dome;
  cfg = await K.req('/api/kiosk/dome/config');
  check(
    teamCard(cfg, A).domes.map((d) => d.id).join() === `${d1.id},${d3.id}` && teamCard(cfg, B).domes.map((d) => d.id).join() === `${d2.id}`,
    'each team card lists its own domes'
  );

  console.log('== Teams work different domes at the same time');
  r = await act({ action: 'complete_dome', dome_id: d1.id, weight_lbs: 100 });
  check(r.status === 409 && r.data.error === 'dome_not_started', 'cannot complete a dome that never started');
  r = await act({ action: 'start_dome', dome_id: d1.id, team_id: A });
  check(r.status === 200, 'team A starts dome A', r.data);
  r = await act({ action: 'start_dome', dome_id: d2.id, team_id: B });
  check(r.status === 200, 'team B starts dome B at the same time', r.data);
  r = await act({ action: 'start_dome', dome_id: d3.id, team_id: A });
  check(r.status === 409 && r.data.error === 'team_busy', 'team A cannot run a second dome at once', r.data);
  const partCount = async (domeId) =>
    (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM dome_labor_sessions s JOIN dome_labor_participants p ON p.session_id = s.id
         WHERE s.dome_id = $1 AND s.status = 'active' AND p.left_at IS NULL`,
        [domeId]
      )
    ).rows[0].n;
  check((await partCount(d1.id)) === 3 && (await partCount(d2.id)) === 2, 'labor: dome A = team A (3), dome B = team B (2)');

  console.log('== Employee scan moves to the selected team (labor follows, no duplicate)');
  r = await act({ action: 'scan', barcode: e3.code, team_id: B });
  check(
    r.status === 200 && r.data.action === 'employee_moved' && r.data.from_team.id === A && r.data.to_team.id === B && r.data.dome_joined === n2,
    'D3 scanned with team B selected: moved A -> B and joined dome B',
    r.data
  );
  let p3 = await openParts(e3.id);
  check(p3.length === 1 && Number(p3[0].dome_id) === d2.id, 'D3 now in dome B labor only', p3);
  check(JSON.stringify(await openTeams(e3.id)) === JSON.stringify([{ team_id: B, source: 'assembly_kiosk_move' }]), 'D3 on team B only (temporary move)');
  const gap = await pool.query(
    `SELECT p.left_at, s.dome_id FROM dome_labor_participants p JOIN dome_labor_sessions s ON s.id = p.session_id
     WHERE p.employee_id = $1 AND s.dome_id = $2 ORDER BY p.id DESC LIMIT 1`,
    [e3.id, d1.id]
  );
  check(new Date(gap.rows[0].left_at).getTime() === new Date(p3[0].joined_at).getTime(), 'dome A labor ends exactly when dome B labor starts (no overlap, no gap)');
  const defaultRoster = await pool.query(`SELECT team_id FROM team_members WHERE employee_id = $1 AND active = 1`, [e3.id]);
  check(defaultRoster.rows.length === 1 && Number(defaultRoster.rows[0].team_id) === A, 'D3 default team (team_members) unchanged');
  r = await act({ action: 'scan', barcode: e3.code, team_id: B });
  check(r.status === 200 && r.data.action === 'employee_selected' && (await openParts(e3.id)).length === 1, 'rescan on the same team: no duplicate');
  check((await partCount(d1.id)) === 2 && (await partCount(d2.id)) === 3, 'dome A keeps running with 2, dome B now 3');

  console.log('== Employee Out / move-out stops an empty dome');
  r = await act({ action: 'employee_out', employee_id: e4.id, team_id: B });
  check(r.status === 200 && (await openParts(e4.id)).length === 0 && (await partCount(d2.id)) === 2, 'Employee Out D4: labor closed, dome B continues', r.data);
  r = await act({ action: 'scan', barcode: e3.code, team_id: A });
  check(r.status === 200 && r.data.from_team.id === B && r.data.dome_joined === n1, 'D3 moved back to team A and rejoins dome A', r.data);
  check((await partCount(d1.id)) === 3 && (await partCount(d2.id)) === 1, 'dome A 3, dome B 1 (D5)');

  console.log('== Lunch / Resume per team card');
  r = await act({ action: 'lunch', team_id: A });
  check(r.status === 200 && r.data.dome_numbers.join() === n1, 'Lunch on team A pauses only dome A', r.data);
  check((await domeRow(d1.id)).pause_reason === 'lunch' && (await domeRow(d2.id)).production_status === 'in_progress', 'team B keeps working through team A lunch');
  cfg = await K.req('/api/kiosk/dome/config');
  check(teamCard(cfg, A).on_lunch && !teamCard(cfg, B).on_lunch, 'only card A shows Lunch');
  r = await act({ action: 'scan', barcode: e5.code, team_id: A });
  check(r.status === 200 && (r.data.dome_stopped || []).join() === n2 && !r.data.dome_joined, 'D5 moved to team A on lunch: dome B left empty -> stopped', r.data);
  const stoppedB = await domeRow(d2.id);
  check(stoppedB.production_status === 'paused' && stoppedB.pause_reason === null, 'dome B stopped (Start Dome to continue)', stoppedB);
  r = await act({ action: 'start_dome', dome_id: d3.id, team_id: A });
  check(r.status === 409 && r.data.error === 'team_on_lunch', 'team on lunch cannot start a dome', r.data);
  r = await act({ action: 'resume', team_id: A });
  check(r.status === 200 && r.data.dome_numbers.join() === n1, 'Resume on team A restarts dome A', r.data);
  const resumed = (
    await pool.query(
      `SELECT p.employee_id FROM dome_labor_participants p JOIN dome_labor_sessions s ON s.id = p.session_id
       WHERE s.dome_id = $1 AND s.status = 'active' AND p.left_at IS NULL ORDER BY p.employee_id`,
      [d1.id]
    )
  ).rows.map((x) => Number(x.employee_id));
  check(
    JSON.stringify(resumed) === JSON.stringify([e1.id, e2.id, e3.id, e5.id].sort((x, y) => x - y)),
    'Resume = prior workers still on the team + D5 who joined during lunch',
    resumed
  );
  r = await act({ action: 'resume', team_id: B });
  check(r.status === 200 && r.data.dome_numbers.length === 0, 'Resume on a team not on lunch is harmless');
  r = await act({ action: 'start_dome', dome_id: d2.id, team_id: B });
  check(r.status === 409 && r.data.error === 'no_workers', 'team B has nobody on shift -> cannot start dome B', r.data);

  console.log('== Stop Dome');
  r = await act({ action: 'stop_dome', dome_id: d1.id });
  check(r.status === 200 && (await domeRow(d1.id)).production_status === 'paused', 'Stop Dome A', r.data);
  r = await act({ action: 'start_dome', dome_id: d3.id, team_id: A });
  check(r.status === 200, 'team A switches to dome C');
  r = await act({ action: 'stop_dome', dome_id: d3.id });
  check(r.status === 200, 'Stop Dome C');
  r = await act({ action: 'start_dome', dome_id: d1.id, team_id: A });
  check(r.status === 200, 'team A back on dome A');

  console.log('== No double-counted labor');
  const testIds = [e1.id, e2.id, e3.id, e4.id, e5.id];
  const overlaps = await pool.query(
    `SELECT a.employee_id FROM dome_labor_participants a
     JOIN dome_labor_participants b ON a.employee_id = b.employee_id AND a.id < b.id
     WHERE a.employee_id = ANY($1::bigint[])
       AND a.joined_at < COALESCE(b.left_at, 'infinity'::timestamptz)
       AND b.joined_at < COALESCE(a.left_at, 'infinity'::timestamptz)`,
    [testIds]
  );
  check(overlaps.rows.length === 0, 'no employee has overlapping dome labor intervals', overlaps.rows);
  const sessOverlap = await pool.query(
    `SELECT a.dome_id FROM dome_labor_sessions a JOIN dome_labor_sessions b ON a.dome_id = b.dome_id AND a.id < b.id
     WHERE a.dome_id = ANY($1::bigint[])
       AND a.started_at < COALESCE(b.ended_at, 'infinity'::timestamptz)
       AND b.started_at < COALESCE(a.ended_at, 'infinity'::timestamptz)`,
    [[d1.id, d2.id, d3.id]]
  );
  check(sessOverlap.rows.length === 0, 'no dome has overlapping production sessions');

  console.log('== End Shift per team (Assembly rule)');
  r = await act({ action: 'end_shift', team_id: A });
  check(r.status === 200 && r.data.dome_numbers.join() === n1, 'End Shift team A pauses dome A', r.data);
  check((await domeRow(d1.id)).pause_reason === 'end_shift', 'dome A paused for the next shift');
  cfg = await K.req('/api/kiosk/dome/config');
  check(cfg.data.active_teams.length === 1 && cfg.data.active_teams[0].team_id === B, 'card A closed, team B card stays');
  check(cfg.data.other_domes.some((d) => d.id === d1.id), "team A's domes listed under Other Domes");
  const moveRows = await pool.query(
    `SELECT employee_id FROM employee_team_memberships WHERE team_id = $1 AND source = 'assembly_kiosk_move' AND left_at IS NULL`,
    [A]
  );
  check(moveRows.rows.length === 0, 'temporary moves into team A ended (D3, D5)');
  const scanRows = await pool.query(
    `SELECT employee_id FROM employee_team_memberships WHERE team_id = $1 AND source <> 'assembly_kiosk_move' AND left_at IS NULL ORDER BY employee_id`,
    [A]
  );
  check(scanRows.rows.map((x) => Number(x.employee_id)).join() === [e1.id, e2.id].sort((x, y) => x - y).join(), 'default-roster shift rows stay (Assembly End Shift behavior)', scanRows.rows);
  r = await act({ action: 'end_shift', team_id: B });
  check(r.status === 200, 'End Shift team B');
  cfg = await K.req('/api/kiosk/dome/config');
  check(cfg.data.active_teams.length === 0 && !cfg.data.assignment, 'no cards left, assignment cleared (cards do not come back)');

  console.log('== Next shift: default rosters return, old moves expire');
  r = await act({ action: 'scan', barcode: domeTeamB.barcode });
  check(r.status === 200 && r.data.action === 'team_assigned', 'team B scanned again');
  check(JSON.stringify(await openTeams(e5.id)) === JSON.stringify([{ team_id: B, source: 'team_scan' }]), 'D5 back on default team B');
  r = await act({ action: 'scan', barcode: e1.code, team_id: B });
  check(r.status === 200 && r.data.action === 'employee_moved', 'D1 moved to team B', r.data);
  const mv = await pool.query(
    `SELECT id FROM employee_team_memberships WHERE employee_id = $1 AND team_id = $2 AND source = 'assembly_kiosk_move' AND left_at IS NULL`,
    [e1.id, B]
  );
  await pool.query(`UPDATE employee_team_memberships SET joined_at = joined_at - INTERVAL '1 day' WHERE id = $1`, [mv.rows[0].id]);
  r = await act({ action: 'scan', barcode: domeTeamB.barcode });
  const expired = await pool.query(`SELECT left_at, reason FROM employee_team_memberships WHERE id = $1`, [mv.rows[0].id]);
  check(!!expired.rows[0].left_at, 'a move from an earlier day expires (new workday)', expired.rows[0]);
  r = await act({ action: 'end_shift', team_id: B });
  check(r.status === 200, 'End Shift team B');
  await aact({ action: 'end_shift', team_id: asmTeam.id });

  console.log('== Dome Complete -> inventory');
  r = await act({ action: 'complete_dome', dome_id: d1.id });
  check(r.status === 400 && r.data.error === 'weight_required', 'Dome Complete requires weight');
  r = await act({ action: 'complete_dome', dome_id: d1.id, weight_lbs: '-5' });
  check(r.status === 400, 'negative weight rejected');
  r = await act({ action: 'complete_dome', dome_id: d1.id, weight_lbs: '1,234.5' });
  check(r.status === 200 && r.data.dome.inventory_status === 'available' && r.data.dome.weight_lbs === 1234.5, 'dome A completed -> available, 1234.5 lb', r.data);
  r = await act({ action: 'complete_dome', dome_id: d1.id, weight_lbs: 5 });
  check(r.status === 409 && r.data.error === 'dome_completed', 'cannot complete twice');
  const laborRows = await pool.query(`SELECT COUNT(*)::int AS n FROM dome_labor_sessions WHERE dome_id = $1 AND status = 'active'`, [d1.id]);
  check(laborRows.rows[0].n === 0, 'dome A labor closed');

  console.log('== Fabrication Dome Install');
  const tankNum = `ZZP3T${stamp}`;
  const tank = (await M.json('/api/tanks', 'POST', { tank_number: tankNum, piece_count: 2 })).data.tank;
  const tank2Num = `ZZP3U${stamp}`;
  const tank2 = (await M.json('/api/tanks', 'POST', { tank_number: tank2Num, piece_count: 1 })).data.tank;
  check(tank && tank2, 'create two test tanks');
  for (const t of [tank, tank2]) {
    const pc = t === tank ? 2 : 1;
    for (let n = 1; n <= pc; n += 1) {
      await pool.query(
        `INSERT INTO tank_pieces (tank_id, piece_number, status, created_at, updated_at, completed_at)
         VALUES ($1, $2, 'completed', NOW(), NOW(), NOW())
         ON CONFLICT (tank_id, piece_number) DO UPDATE SET status = 'completed', completed_at = NOW()`,
        [t.id, n]
      );
    }
    await pool.query(
      `UPDATE tanks SET status = 'ready_for_dome_install', fab_completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tank_number LIKE 'ZZP3%'`,
      [t.id]
    );
  }
  const W = new Client();
  await W.req(`/kiosk/machine/${winderSlug}`);
  const wact = (body) => W.json('/api/kiosk/winding/action', 'POST', body);
  const wrongDome = await W.req('/api/kiosk/dome/config');
  check(wrongDome.status === 409 && wrongDome.data.error === 'wrong_workflow', 'dome API rejects Fabrication kiosk session');
  await wact({ action: 'scan', barcode: fabTeam.barcode });

  const normalNum = `ZZP3N${stamp}`;
  await M.json('/api/tanks', 'POST', { tank_number: normalNum, piece_count: 2 });
  r = await wact({ action: 'scan', barcode: `TANK_${normalNum}` });
  check(
    r.status === 200 && r.data.action === 'tank_selected' && !r.data.dome_install_mode && r.data.pending.piece == null && r.data.piece_count === 2,
    'normal Fabrication tank still goes to Select Piece (unchanged)',
    r.data
  );

  r = await wact({ action: 'scan', barcode: `TANK_${tankNum}` });
  check(
    r.status === 200 && r.data.action === 'tank_selected' && r.data.dome_install_mode === true && r.data.dome_install_tank_level === true &&
      r.data.pending.piece == null && !r.data.dome_install_in_progress,
    'tank scan on Ready for Dome Install -> tank-level Dome Install (no Select Piece)',
    r.data
  );
  let wcfg = await W.req('/api/kiosk/winding/config');
  check(wcfg.data.active_tank_dome_install === true && wcfg.data.active_tank_number === tankNum, 'config keeps the tank in Dome Install mode (reload / poll)', wcfg.data);
  r = await wact({ action: 'scan', barcode: 'PHASE:WIND', pending: { tank: tankNum } });
  check(r.status === 409 && r.data.error === 'dome_install_only', 'other phases blocked on dome tank', r.data);
  r = await wact({ action: 'scan', barcode: 'PHASE:TANK_COMPLETE', pending: { tank: tankNum } });
  check(r.status === 409 && r.data.error === 'dome_install_only', 'FAB Tank Complete blocked on dome tank (no auto-complete)', r.data);
  r = await wact({ action: 'scan', barcode: 'PHASE:DOME_INSTALL', pending: { tank: tankNum, piece: null } });
  const listed = r.data && r.data.domes ? r.data.domes.map((d) => d.id) : [];
  check(
    r.status === 200 && r.data.action === 'dome_install_select' && r.data.piece_number == null && listed.includes(d1.id) && !listed.includes(d2.id),
    'Dome Install (no piece) opens picker: completed dome A listed, in-production B not',
    r.data
  );
  const av = await W.req('/api/kiosk/winding/domes/available?diameter=10');
  check(av.status === 200 && !av.data.domes.some((d) => d.id === d1.id), 'diameter filter (10\') excludes 8\' dome A');

  const [ra, rb] = await Promise.all([
    wact({ action: 'dome_install_start', tank_id: tank.id, dome_id: d1.id }),
    wact({ action: 'dome_install_start', tank_id: tank.id, dome_id: d1.id }),
  ]);
  const okCount = [ra, rb].filter((x) => x.status === 200).length;
  const loser = [ra, rb].find((x) => x.status !== 200);
  check(
    okCount === 1 && loser && ['dome_unavailable', 'dome_install_in_progress'].includes(loser.data.error),
    'double-tap Start Install: exactly one install',
    [ra.data, rb.data]
  );
  const winner = ra.status === 200 ? ra : rb;
  const installId = winner.data.installation_id;
  const installPiece = winner.data.piece_number;
  r = await wact({ action: 'dome_install_start', tank_id: tank2.id, dome_id: d1.id });
  check(r.status === 409 && r.data.error === 'dome_unavailable', 'reserved dome cannot go on another tank', r.data);
  const dState = await pool.query(`SELECT inventory_status FROM domes WHERE id = $1`, [d1.id]);
  check(dState.rows[0].inventory_status === 'reserved', 'dome A reserved while installing');
  wcfg = await W.req('/api/kiosk/winding/config');
  check(wcfg.data.dome_installs.length === 1 && wcfg.data.dome_installs[0].session_status === 'running', 'winding config lists the running Dome Install', wcfg.data.dome_installs);
  check(wcfg.data.active_tank_dome_install === false, 'config: running install shown as production, not the Dome Install picker');
  const instRows = await pool.query(`SELECT COUNT(*)::int AS n FROM dome_installations WHERE tank_id = $1 AND status = 'in_progress'`, [tank.id]);
  check(instRows.rows[0].n === 1, 'one Dome Install per tank');
  r = await wact({ action: 'scan', barcode: 'PHASE:WIND', pending: { tank: tankNum, piece: installPiece } });
  check(r.status === 409 && r.data.error === 'dome_install_active', 'phase change blocked during Dome Install');
  r = await wact({ action: 'part_complete' });
  check(r.status === 409 && r.data.error === 'dome_install_active', 'part_complete blocked during Dome Install');
  r = await M.json(`/api/tanks/${tank.id}/archive`, 'PATCH', {});
  check(r.status === 409 && r.data.error === 'dome_install_in_progress', 'manager Complete Tank blocked while install in progress', r.data);

  r = await wact({ action: 'pause', barcode: 'STOP:LUNCH', confirmed: true });
  wcfg = await W.req('/api/kiosk/winding/config');
  check(r.status === 200 && wcfg.data.dome_installs[0].session_status === 'stopped', 'FAB Lunch pauses the install session', r.data);
  r = await wact({ action: 'resume', confirmed: true });
  wcfg = await W.req('/api/kiosk/winding/config');
  check(r.status === 200 && wcfg.data.dome_installs[0].session_status === 'running', 'FAB Resume restarts it');
  r = await wact({ action: 'end_shift', confirmed: true });
  const tAfter = await pool.query(`SELECT status, paused_reason FROM tanks WHERE id = $1`, [tank.id]);
  check(r.status === 200 && tAfter.rows[0].status === 'ready_for_dome_install', 'FAB End Shift keeps tank Ready for Dome Install', tAfter.rows[0]);
  const instAfter = await pool.query(`SELECT status FROM dome_installations WHERE id = $1`, [installId]);
  check(instAfter.rows[0].status === 'in_progress', 'install stays in progress across End Shift');
  await wact({ action: 'scan', barcode: fabTeam.barcode });
  r = await wact({ action: 'scan', barcode: 'RESUME' });
  check(r.status === 200 && (r.data.dome_install_resumed || []).includes(tankNum), 'RESUME after End Shift reopens the Dome Install', r.data);
  wcfg = await W.req('/api/kiosk/winding/config');
  const liveInstall = wcfg.data.dome_installs[0];
  check(liveInstall && liveInstall.session_status === 'running', 'new install session running');

  r = await wact({ action: 'dome_install_finish', installation_id: installId });
  check(r.status === 200 && r.data.action === 'dome_install_finished' && r.data.tank_status === 'dome_installed', 'Finish Install', r.data);
  const tDone = await pool.query(`SELECT status, completed_at, deleted_at FROM tanks WHERE id = $1`, [tank.id]);
  check(
    tDone.rows[0].status === 'dome_installed' && tDone.rows[0].completed_at == null && tDone.rows[0].deleted_at == null,
    'Finish Install: tank status = dome_installed, NOT completed/archived',
    tDone.rows[0]
  );
  const dDone = await pool.query(`SELECT inventory_status, installed_tank_number, installed_piece_number FROM domes WHERE id = $1`, [d1.id]);
  check(dDone.rows[0].inventory_status === 'installed' && dDone.rows[0].installed_tank_number === tankNum, 'dome A installed on the tank', dDone.rows[0]);
  const sess = await pool.query(
    `SELECT COUNT(*)::int AS n, BOOL_AND(ms.status = 'finished') AS all_done FROM dome_installation_sessions dis
     JOIN machine_sessions ms ON ms.id = dis.machine_session_id WHERE dis.installation_id = $1`,
    [installId]
  );
  check(sess.rows[0].n === 2 && sess.rows[0].all_done, 'install labor kept as 2 Fabrication sessions (before/after End Shift)', sess.rows[0]);
  const installLabor = await pool.query(
    `SELECT COUNT(*)::int AS n FROM session_team_members stm JOIN dome_installation_sessions dis ON dis.machine_session_id = stm.session_id
     WHERE dis.installation_id = $1`,
    [installId]
  );
  check(installLabor.rows[0].n >= 1, 'install sessions carry the Fabrication team labor', installLabor.rows[0]);
  wcfg = await W.req('/api/kiosk/winding/config');
  check(wcfg.data.active_tank_id == null && wcfg.data.active_tank_dome_install === false, 'after Finish Install the kiosk returns to Scan Tank', wcfg.data);
  r = await wact({ action: 'scan', barcode: `TANK_${tankNum}` });
  check(r.status >= 400 && r.data.error === 'dome_installed_waiting' && r.data.tank_number === tankNum, 'rescan: Dome Installed, waiting for next phase (no phase started)', r.data);
  for (const code of ['PHASE:WIND', 'PHASE:TANK_COMPLETE', 'PHASE:DOME_INSTALL']) {
    r = await wact({ action: 'scan', barcode: code, pending: { tank: tankNum, piece: 1 } });
    check(r.status >= 400 && r.data.error === 'dome_installed_waiting', `${code} on a Dome Installed tank is refused (no next phase invented)`, r.data);
  }
  const noNewSess = await pool.query(`SELECT COUNT(*)::int AS n FROM machine_sessions WHERE tank_id = $1 AND status IN ('running', 'stopped')`, [tank.id]);
  check(noNewSess.rows[0].n === 0, 'no session opened on the Dome Installed tank', noNewSess.rows[0]);
  r = await M.req(`/api/tanks?status=active&search=${tankNum}`);
  const activeRow = r.data.tanks && r.data.tanks.find((t) => t.id === tank.id);
  check(activeRow && activeRow.status === 'dome_installed', 'Dome Installed tank stays in the Active tanks list', activeRow);
  r = await M.req(`/api/tanks?status=archived&search=${tankNum}`);
  check(!(r.data.tanks || []).some((t) => t.id === tank.id), 'Dome Installed tank is NOT in the Completed list', r.data.tanks);
  r = await M.req(`/api/tanks/${tank.id}/report`);
  check(r.status === 200 && r.data.report_meta && r.data.report_meta.production_status === 'Dome Installed', 'tank report status: Dome Installed', r.data && r.data.report_meta);
  r = await M.json(`/api/tanks/${tank.id}`, 'PUT', { notes: 'edit keeps status', status: '' });
  check(r.status === 200 && r.data.tank.status === 'dome_installed', 'manager Edit (blank status) keeps Dome Installed', r.data);
  r = await M.json(`/api/tanks/${tank.id}`, 'PUT', { notes: 'edit keeps status 2', status: 'dome_installed' });
  check(r.status === 200 && r.data.tank.status === 'dome_installed', 'manager Edit (status=dome_installed) keeps Dome Installed', r.data);

  r = await act({ action: 'complete_dome', dome_id: d2.id, weight_lbs: 900 });
  check(r.status === 200, 'complete dome B');
  r = await wact({ action: 'dome_install_start', tank_id: tank.id, dome_id: d2.id });
  check(
    r.status === 409 && ['dome_already_installed', 'not_ready_for_dome_install'].includes(r.data.error),
    'second dome on the same tank refused (tank-level)',
    r.data
  );
  r = await wact({ action: 'scan', barcode: `TANK_${tank2Num}` });
  check(r.status === 200 && r.data.dome_install_mode && r.data.pending.piece == null, 'tank 2 scan -> Dome Install (no piece)');
  r = await wact({ action: 'dome_install_start', tank_id: tank2.id, dome_id: d2.id });
  check(r.status === 200, 'start install of dome B on tank 2');
  r = await wact({ action: 'scan', barcode: `TANK_${tank2Num}` });
  check(r.status === 200 && r.data.dome_install_in_progress && r.data.dome_install_in_progress.dome_number === n2, 'rescan during install: shows the install in progress', r.data);
  r = await wact({ action: 'dome_install_cancel', installation_id: (await pool.query(
    `SELECT id FROM dome_installations WHERE tank_id = $1 AND status = 'in_progress'`, [tank2.id])).rows[0].id, reason: 'wrong dome' });
  const dB = await pool.query(`SELECT inventory_status FROM domes WHERE id = $1`, [d2.id]);
  check(r.status === 200 && dB.rows[0].inventory_status === 'available', 'Cancel Install returns dome B to available', r.data);

  console.log('== Dome Install on a tank that went through rework and passed QA/QC');
  const reworkNum = `ZZP3R${stamp}`;
  const reworkTank = (await M.json('/api/tanks', 'POST', { tank_number: reworkNum, piece_count: 2 })).data.tank;
  for (let n = 1; n <= 2; n += 1) {
    await pool.query(
      `INSERT INTO tank_pieces (tank_id, piece_number, status, created_at, updated_at, completed_at)
       VALUES ($1, $2, 'completed', NOW(), NOW(), NOW())
       ON CONFLICT (tank_id, piece_number) DO UPDATE SET status = 'completed', completed_at = NOW()`,
      [reworkTank.id, n]
    );
  }
  await pool.query(
    `UPDATE tanks SET status = 'ready_for_dome_install', fab_completed_at = NOW() - INTERVAL '2 days',
            last_rework_completed_at = NOW() - INTERVAL '1 day', qa_result = 'pass', qa_completed_at = NOW(),
            qa_failure_note = 'leak at seam (fixed in rework)', updated_at = NOW()
     WHERE id = $1 AND tank_number LIKE 'ZZP3%'`,
    [reworkTank.id]
  );
  const reDome = await M.json('/api/manager/domes', 'POST', { dome_number: `ZZP3-R${stamp}`, diameter_ft: 8, weight_lbs: 410 });
  check(reDome.status === 201, 'available dome for the rework tank');
  r = await wact({ action: 'scan', barcode: `TANK_${reworkNum}` });
  check(
    r.status === 200 && r.data.dome_install_mode === true && r.data.rework_required === false && r.data.pending.piece == null,
    'rework tank (QA/QC passed) -> tank-level Dome Install, not rework',
    r.data
  );
  r = await wact({ action: 'scan', barcode: 'PHASE:DOME_INSTALL', pending: { tank: reworkNum, piece: null } });
  check(r.status === 200 && r.data.action === 'dome_install_select' && r.data.domes.some((d) => d.id === reDome.data.dome.id), 'rework tank: dome picker opens', r.data);
  r = await wact({ action: 'dome_install_start', tank_id: reworkTank.id, dome_id: reDome.data.dome.id });
  check(r.status === 200, 'rework tank: Start Install', r.data);
  r = await wact({ action: 'dome_install_finish', installation_id: r.data.installation_id });
  const reTank = await pool.query(`SELECT status, completed_at FROM tanks WHERE id = $1`, [reworkTank.id]);
  check(reTank.rows[0].status === 'dome_installed' && reTank.rows[0].completed_at == null, 'rework tank: status Dome Installed, not completed', reTank.rows[0]);
  const reInstalled = await pool.query(`SELECT inventory_status, installed_tank_id FROM domes WHERE id = $1`, [reDome.data.dome.id]);
  check(
    r.status === 200 && reInstalled.rows[0].inventory_status === 'installed' && Number(reInstalled.rows[0].installed_tank_id) === Number(reworkTank.id),
    'rework tank: Finish Install records the dome on the tank',
    reInstalled.rows[0]
  );

  console.log('== Manager Dome Inventory');
  r = await M.req(`/api/manager/domes?search=${encodeURIComponent(`ZZP3-D${stamp}`)}`);
  check(r.status === 200 && r.data.domes.length === 2, 'search by dome number', r.data);
  r = await M.req(`/api/manager/domes?status=installed&search=ZZP3`);
  check(r.data.domes.some((d) => d.id === d1.id) && !r.data.domes.some((d) => d.id === d2.id), 'status filter: installed');
  r = await M.req(`/api/manager/domes?type=water&diameter=10&search=ZZP3`);
  check(r.data.domes.length >= 1 && r.data.domes.every((d) => d.dome_type === 'Water' && d.diameter_ft === 10), 'type + diameter filters');
  r = await M.json('/api/manager/domes', 'POST', { dome_number: `ZZP3-M${stamp}`, diameter_ft: 12 });
  check(r.status === 400 && r.data.error === 'weight_required', 'manual add requires weight');
  r = await M.json('/api/manager/domes', 'POST', { dome_number: n1, diameter_ft: 12, weight_lbs: 500 });
  check(r.status === 409 && r.data.error === 'duplicate_dome_number', 'manual add rejects duplicate number');
  r = await M.json('/api/manager/domes', 'POST', { dome_number: `ZZP3-M${stamp}`, diameter_ft: 12, weight_lbs: 750 });
  check(r.status === 201 && r.data.dome.source === 'manual' && r.data.dome.inventory_status === 'available', 'manual add (number + diameter + weight) -> available', r.data);
  const manual = r.data.dome;
  const manualLabor = await pool.query(`SELECT COUNT(*)::int AS n FROM dome_labor_sessions WHERE dome_id = $1`, [manual.id]);
  check(manualLabor.rows[0].n === 0, 'manual dome has no manufacturing time/history');
  r = await M.req(`/api/manager/domes/${d1.id}`);
  check(
    r.status === 200 &&
      r.data.installations.length === 1 &&
      r.data.installations[0].status === 'installed' &&
      r.data.dome.labor_by_employee.length === 4 &&
      r.data.events.length >= 5,
    'dome details: install history, per-employee labor, events',
    r.data && { inst: r.data.installations, labor: r.data.dome && r.data.dome.labor_by_employee }
  );
  r = await M.json(`/api/manager/domes/${manual.id}`, 'PATCH', { weight_lbs: 760, dome_type: 'Water' });
  check(r.status === 200 && r.data.dome.weight_lbs === 760, 'manager edits a dome (audited)');
  const K2 = new Client();
  r = await K2.req('/api/manager/domes');
  check(r.status === 401 || r.status === 403 || r.status === 302, 'Dome Inventory API requires manager login', r.status);

  console.log('== Tank report + list');
  r = await M.req(`/api/tanks/${tank.id}/report`);
  check(r.status === 200 && r.data.dome_state.installed_count === 1 && r.data.tank.domes_installed_display.includes(n1), 'tank report shows installed dome', r.data && r.data.dome_state);
  r = await M.req(`/api/tanks?status=all&search=${tankNum}`);
  const listed1 = r.data.tanks.find((t) => t.id === tank.id);
  check(listed1 && listed1.dome_summary && listed1.dome_summary.installed.length === 1, 'tank list includes dome summary');

  console.log('== Complete Tank gate');
  r = await M.json(`/api/tanks/${tank.id}/archive`, 'PATCH', {});
  check(r.status === 200 && r.data.ok, 'Complete Tank succeeds with an installed dome', r.data);
  const tFinal = await pool.query(`SELECT status, completed_at FROM tanks WHERE id = $1`, [tank.id]);
  check(tFinal.rows[0].status === 'archived' && tFinal.rows[0].completed_at != null, 'manual Complete Tank from Dome Installed archives it', tFinal.rows[0]);
  r = await M.json(`/api/tanks/${tank2.id}/archive`, 'PATCH', {});
  check(r.status === 409 && r.data.error === 'dome_required' && r.data.override_allowed === true, 'Complete Tank without a dome is blocked (override allowed)', r.data);
  r = await M.json(`/api/tanks/${tank2.id}/archive`, 'PATCH', { dome_override_reason: 'x' });
  check(r.status === 409 && r.data.error === 'dome_required', 'too-short override reason rejected');
  const t2s = await pool.query(`SELECT status FROM tanks WHERE id = $1`, [tank2.id]);
  check(t2s.rows[0].status === 'ready_for_dome_install', 'blocked completion rolled back (status unchanged)');
  r = await M.json(`/api/tanks/${tank2.id}/archive`, 'PATCH', { dome_override_reason: 'Legacy tank — dome installed before Phase 3' });
  check(r.status === 200 && r.data.ok, 'override with reason completes the tank', r.data);
  const ov = await pool.query(`SELECT reason, performed_by FROM tank_dome_completion_overrides WHERE tank_id = $1`, [tank2.id]);
  check(ov.rows.length === 1 && ov.rows[0].performed_by === 'manager', 'override reason recorded with manager name', ov.rows);

  console.log('== Dome labor in unified employee hours');
  const unified = await pool.query(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(p.left_at, NOW()) - p.joined_at))), 0)::float AS s
     FROM dome_labor_participants p WHERE p.employee_id = $1`,
    [e1.id]
  );
  check(unified.rows[0].s > 0, 'dome labor participant intervals recorded for D1');

  console.log('== Cleanup (deactivate test machines/teams only; rows are kept)');
  r = await act({ action: 'complete_dome', dome_id: d3.id, weight_lbs: 300 });
  check(r.status === 200, 'complete dome C (no open dome work left on the test machine)');
  await M.json(`/api/manager/machine-areas/${domeMachine.data.machine.id}/remove`, 'POST', {});
  await M.json(`/api/manager/machine-areas/${asmMachine.data.machine.id}/remove`, 'POST', {});
  const domeM = await pool.query(`SELECT active FROM machines WHERE id = $1`, [domeMachine.data.machine.id]);
  check(domeM.rows.length === 1 && Number(domeM.rows[0].active) === 0, 'dome machine with history is deactivated, not deleted');
  await wact({ action: 'end_shift', confirmed: true });
  await M.json(`/api/manager/machine-areas/${winder.data.machine.id}/remove`, 'POST', {});
  for (const t of [domeTeam, domeTeamB, fabTeam, asmTeam]) await M.req(`/api/manager/teams/${t.id}`, { method: 'DELETE' });
  console.log(`   test stamp ${stamp}: domes ${n1}, ${n2}, ${n3}, ZZP3-M${stamp}; tanks ${tankNum}, ${tank2Num}`);
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
    console.error('FAILED:', err.stack || err.message);
    await closePool();
    process.exit(1);
  });
