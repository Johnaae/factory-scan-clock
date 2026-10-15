'use strict';

/**
 * Local HTTP regression: Assembly kiosk "Return Tank to Assembly" on tank 2222.
 *   Remove → listed in removed_tanks → Return → back in eligible_tanks, FAB/history unchanged.
 * Uses the real kiosk endpoints on localhost:3000. Refuses Neon. Deletes nothing.
 * Leaves tank 2222 in removed_from_assembly so the final Return can be done in the kiosk UI.
 */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

const BASE = 'http://localhost:3000';
const TANK_NUMBER = '2222';
const SLUG = 'assembly-1';

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
    return { status: res.status, data };
  }
  action(body) {
    return this.req('/api/kiosk/assembly/action', { method: 'POST', body: JSON.stringify(body) });
  }
}

const PRESERVED_COLUMNS = [
  'fab_completed_at',
  'first_scanned_at',
  'created_at',
  'assembly_started_at',
  'assembly_completed_at',
  'requires_test',
  'qa_started_at',
  'qa_completed_at',
  'qa_result',
  'testing_started_at',
  'testing_completed_at',
  'completed_at',
  'deleted_at',
  'piece_count',
];

async function tankRow() {
  const { rows } = await pool.query(`SELECT * FROM tanks WHERE tank_number = $1 AND deleted_at IS NULL`, [TANK_NUMBER]);
  return rows[0] || null;
}

/** Row counts in every table with a tank_id column (FAB sessions, labor, QA, testing, audits…). */
async function relatedCounts(tankId) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tank_id' ORDER BY table_name`
  );
  const out = {};
  for (const { table_name: t } of tables) {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM "${t}" WHERE tank_id = $1`, [tankId]);
    out[t] = r.rows[0].n;
  }
  const p = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stage_labor_participants p
     JOIN stage_labor_sessions s ON s.id = p.session_id WHERE s.tank_id = $1`,
    [tankId]
  );
  out.stage_labor_participants_via_session = p.rows[0].n;
  return out;
}

async function openSessions(tankId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stage_labor_sessions WHERE tank_id = $1 AND ended_at IS NULL`,
    [tankId]
  );
  return rows[0].n;
}

function iso(v) {
  return v instanceof Date ? v.toISOString() : v == null ? null : String(v);
}

function diffPreserved(before, after) {
  return PRESERVED_COLUMNS.filter((c) => c in before && iso(before[c]) !== iso(after[c]));
}

function diffCounts(before, after, expectedDelta) {
  const bad = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const want = (before[k] || 0) + ((expectedDelta && expectedDelta[k]) || 0);
    if ((after[k] || 0) !== want) bad.push(`${k}: ${before[k] || 0} -> ${after[k] || 0} (expected ${want})`);
  }
  return bad;
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');
  let tank = await tankRow();
  if (!tank) throw new Error(`Tank ${TANK_NUMBER} not found locally`);
  const tid = Number(tank.id);
  console.log(`Tank ${TANK_NUMBER} = id ${tid}, status ${tank.status}`);

  const K = new Client();
  check((await K.req(`/kiosk/machine/${SLUG}`)).status === 200, `Assembly kiosk ${SLUG} opens`);
  let cfg = await K.req('/api/kiosk/assembly/config');
  check(cfg.status === 200 && Array.isArray(cfg.data.removed_tanks), 'config returns removed_tanks list');

  if (String(tank.status).toLowerCase() !== 'removed_from_assembly') {
    throw new Error(`Tank ${TANK_NUMBER} must start as removed_from_assembly (got ${tank.status})`);
  }

  console.log('== Removed tank is listed only in the Return dropdown');
  const inRemoved = (c) => (c.data.removed_tanks || []).some((t) => Number(t.id) === tid);
  const inEligible = (c) => (c.data.eligible_tanks || []).some((t) => Number(t.id) === tid);
  check(inRemoved(cfg), 'tank 2222 listed in removed_tanks');
  check(!inEligible(cfg), 'tank 2222 NOT in normal Assembly selection while removed');
  check(
    (cfg.data.removed_tanks || []).every((t) => t.id && t.tank_number && Object.keys(t).length <= 3),
    'removed_tanks entries expose only id / tank_number / removed time'
  );
  const statuses = await pool.query(
    `SELECT id FROM tanks WHERE deleted_at IS NULL AND completed_at IS NULL AND LOWER(TRIM(status)) = 'removed_from_assembly'`
  );
  check(
    statuses.rows.length === (cfg.data.removed_tanks || []).length,
    `removed_tanks matches every Removed-from-Assembly tank (${statuses.rows.length})`
  );

  console.log('== Authorization');
  const anon = new Client();
  const a1 = await anon.action({ action: 'return_removed_to_assembly', tank_id: tid });
  check(a1.status === 403, `no kiosk session -> ${a1.status} (expected 403)`);
  const W = new Client();
  await W.req('/kiosk/machine/winding-machine-01');
  const a2 = await W.action({ action: 'return_removed_to_assembly', tank_id: tid });
  check(a2.status === 409 || a2.status === 403, `winding kiosk session -> ${a2.status} (rejected)`);
  check(String((await tankRow()).status).toLowerCase() === 'removed_from_assembly', 'tank unchanged after rejected requests');

  console.log('== Return #1 (duplicate-protected)');
  const before1 = await tankRow();
  const counts1 = await relatedCounts(tid);
  const [r1, r2, r3] = await Promise.all([
    K.action({ action: 'return_removed_to_assembly', tank_id: tid }),
    K.action({ action: 'return_removed_to_assembly', tank_id: tid }),
    K.action({ action: 'return_removed_to_assembly', tank_id: tid }),
  ]);
  const codes = [r1.status, r2.status, r3.status].sort();
  check(codes.filter((c) => c === 200).length === 1, `3 concurrent returns: exactly one succeeds (${codes.join(',')})`);
  check(codes.filter((c) => c === 409).length === 2, 'the duplicates are rejected with 409');
  const again = await K.action({ action: 'return_removed_to_assembly', tank_id: tid });
  check(again.status === 409 && /already returned/i.test(again.data.message || ''), `repeat after success -> 409 "${again.data.message}"`);
  const after1 = await tankRow();
  check(String(after1.status).toLowerCase() === 'ready_for_assembly', `status -> ${after1.status}`);
  check(after1.assembly_machine_id == null && after1.assembly_team_id == null, 'not auto-assigned to any kiosk or team');
  const changed1 = diffPreserved(before1, after1);
  check(!changed1.length, `FAB / Assembly / QA / Testing fields unchanged${changed1.length ? ': ' + changed1.join(', ') : ''}`);
  check(iso(after1.assembly_removed_at) === iso(before1.assembly_removed_at), 'assembly_removed_at history kept');
  check(await openSessions(tid) === 0, 'no labor session started');
  const cdiff1 = diffCounts(counts1, await relatedCounts(tid), { tank_admin_phase2_audit: 1 });
  check(!cdiff1.length, `only one audit row added; no other rows touched${cdiff1.length ? ': ' + cdiff1.join('; ') : ''}`);
  const audit = await pool.query(
    `SELECT action, previous_status, next_status, performed_by, details FROM tank_admin_phase2_audit
     WHERE tank_id = $1 ORDER BY id DESC LIMIT 1`,
    [tid]
  );
  const a = audit.rows[0] || {};
  check(
    a.action === 'return_to_assembly' && a.previous_status === 'removed_from_assembly' && a.next_status === 'ready_for_assembly',
    `audit: ${a.action} ${a.previous_status} -> ${a.next_status} by ${a.performed_by}`
  );
  cfg = await K.req('/api/kiosk/assembly/config');
  check(!inRemoved(cfg), 'tank 2222 gone from removed_tanks');
  check(inEligible(cfg), 'tank 2222 back in normal Assembly selection (eligible_tanks)');

  console.log('== Normal workflow: CONFIRM TANK → REMOVE FROM ASSEMBLY (existing, unchanged)');
  const team = (cfg.data.active_teams || [])[0];
  if (!team) {
    console.log('SKIP  no team on the kiosk — cannot run confirm/remove cycle');
  } else {
    const confirm = await K.req('/api/kiosk/assembly/confirm-tank', {
      method: 'POST',
      body: JSON.stringify({ tank_id: tid, team_id: Number(team.team_id) }),
    });
    check(confirm.status === 200, `CONFIRM TANK for team "${team.team_name}" -> ${confirm.status} ${confirm.data && confirm.data.message}`);
    const conf = await tankRow();
    check(iso(conf.assembly_started_at) === iso(before1.assembly_started_at), 'Assembly start time not reset on confirm');
    check(await openSessions(tid) === 0, 'confirm does not start labor');
    const rm = await K.action({ action: 'remove_from_assembly', tank_id: tid, team_id: Number(team.team_id) });
    check(rm.status === 200, `REMOVE FROM ASSEMBLY -> ${rm.status}`);
    const removed = await tankRow();
    check(String(removed.status).toLowerCase() === 'removed_from_assembly', 'status back to removed_from_assembly');
    cfg = await K.req('/api/kiosk/assembly/config');
    check(inRemoved(cfg) && !inEligible(cfg), 'tank 2222 reappears in the Return dropdown only');
    const changed2 = diffPreserved(before1, removed);
    check(!changed2.length, `FAB completion and history still unchanged${changed2.length ? ': ' + changed2.join(', ') : ''}`);
  }

  console.log('== Other statuses are refused');
  const other = await pool.query(
    `SELECT id, tank_number, status FROM tanks WHERE deleted_at IS NULL AND LOWER(TRIM(status)) <> 'removed_from_assembly' ORDER BY id DESC LIMIT 1`
  );
  if (other.rows[0]) {
    const o = other.rows[0];
    const r = await K.action({ action: 'return_removed_to_assembly', tank_id: Number(o.id) });
    const still = await pool.query(`SELECT status FROM tanks WHERE id = $1`, [o.id]);
    check(r.status === 409 && still.rows[0].status === o.status, `tank ${o.tank_number} (${o.status}) -> ${r.status}, status unchanged`);
  }
  const bad = await K.action({ action: 'return_removed_to_assembly', tank_id: 'abc' });
  check(bad.status === 400, `invalid tank id -> ${bad.status}`);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
