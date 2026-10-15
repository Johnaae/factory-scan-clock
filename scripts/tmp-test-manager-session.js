'use strict';

/**
 * HTTP regression for manager session stability (local server only).
 *   node scripts/tmp-test-manager-session.js            -> scenarios 1,2,3,5,8,10 + root-cause repro
 *   node scripts/tmp-test-manager-session.js --restart  -> scenario 6 (pm2 restart while polling)
 * Only touches session rows created by this script (expires one of them for scenario 8).
 */

require('./load-env');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

const BASE = 'http://localhost:3000';
const COOKIE_FILE = path.join(__dirname, 'tmp-test-manager-session-cookie.txt');
const MANAGER_PASSWORD = process.env.DEFAULT_MANAGER_PASSWORD || 'manager123';
const DASHBOARD_APIS = [
  '/api/manager/machines',
  '/api/manager/assembly-machines',
  '/api/manager/teams/dashboard',
  '/api/manager/alerts?status=open',
  '/api/manager/alerts?limit=100',
  '/api/tanks?status=active',
  `/api/manager/daily-summary?date=${new Date().toISOString().slice(0, 10)}`,
  '/api/manager/production-notes?limit=150',
  '/api/manager/kiosk-pins',
  '/api/auth/manager-session',
  '/api/dashboard/team-activity?limit=60',
  '/api/manager/current-work',
  '/api/manager/tank-summary',
  '/api/manager/overtime-watch',
];

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures += 1;
}

class Client {
  constructor(name, cookie) {
    this.name = name;
    this.cookie = cookie || '';
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
    return { status: res.status, location: res.headers.get('location'), data, text };
  }
  async login() {
    const r = await this.req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'manager', password: MANAGER_PASSWORD }),
    });
    if (!(r.status === 200 && r.data && r.data.ok)) throw new Error(`${this.name} login failed: ${r.status}`);
    return r;
  }
  async managerValid() {
    const r = await this.req('/api/auth/manager-session');
    return r.status === 200 && r.data && r.data.ok === true;
  }
  sid() {
    const raw = decodeURIComponent(this.cookie.split('=').slice(1).join('='));
    return raw.startsWith('s:') ? raw.slice(2, raw.lastIndexOf('.')) : raw;
  }
}

async function allDashboardOk(client, label) {
  const results = await Promise.all(DASHBOARD_APIS.map((p) => client.req(p)));
  const bad = results.map((r, i) => [DASHBOARD_APIS[i], r.status]).filter(([, s]) => s !== 200);
  check(bad.length === 0, `${label}: ${DASHBOARD_APIS.length} dashboard requests all 200${bad.length ? ' ' + JSON.stringify(bad) : ''}`);
}

async function mainScenarios() {
  console.log('== 1. Manager logs in and opens the Dashboard');
  const A = new Client('A');
  await A.login();
  fs.writeFileSync(COOKIE_FILE, A.cookie);
  check((await A.req('/manager-dashboard')).status === 200, 'GET /manager-dashboard -> 200');
  await allDashboardOk(A, 'initial load');

  console.log('== 2. Refresh repeatedly');
  let refreshOk = true;
  for (let i = 0; i < 15; i += 1) {
    const page = await A.req('/manager-dashboard');
    const results = await Promise.all(DASHBOARD_APIS.map((p) => A.req(p)));
    if (page.status !== 200 || results.some((r) => r.status !== 200)) refreshOk = false;
  }
  check(refreshOk, '15 full refreshes (page + all dashboard APIs) all 200');
  check(await A.managerValid(), 'session still valid after refreshes');

  console.log('== 3. Navigate Manager / Main Dashboard / iPad Scan');
  check((await A.req('/manager')).status === 200, 'GET /manager -> 200');
  check((await A.req('/dashboard')).status === 200, 'GET /dashboard (Main Dashboard) -> 200');
  const ipad = await A.req('/ipad-scan');
  check(ipad.status === 302 && ipad.location === '/kiosk-login', `GET /ipad-scan -> ${ipad.status} ${ipad.location} (kiosk-only page, redirects without touching manager login)`);
  check((await A.req('/manager-dashboard')).status === 200, 'back to /manager-dashboard -> 200');
  check(await A.managerValid(), 'session still valid after navigation');

  console.log('== 5. Multiple tabs (concurrent polling on one session + a second login)');
  let concurrentOk = true;
  for (let round = 0; round < 8; round += 1) {
    const batch = await Promise.all([...DASHBOARD_APIS, ...DASHBOARD_APIS].map((p) => A.req(p)));
    if (batch.some((r) => r.status !== 200)) concurrentOk = false;
  }
  check(concurrentOk, '8 rounds x 28 concurrent requests on the same session all 200');
  const B = new Client('B');
  await B.login();
  check(await A.managerValid() && await B.managerValid(), 'second tab/browser login: both sessions valid');
  await B.req('/api/auth/logout', { method: 'POST', body: '{}' });
  check(!(await B.managerValid()) && (await A.managerValid()), 'logging out session B does not affect session A');

  console.log('== Root cause: kiosk logout in the same browser as the manager');
  const R = new Client('R');
  await R.login();
  check((await R.req('/kiosk/machine/qa-qc-1')).status === 200, 'manager browser opens QA/QC kiosk URL -> 200');
  const oldLogout = await R.req('/api/auth/logout', { method: 'POST', body: '{}' });
  const afterOld = await R.req('/api/manager/machines');
  const tanksAfterOld = await R.req('/api/tanks?status=active');
  check(oldLogout.status === 200 && afterOld.status === 401 && afterOld.data && afterOld.data.message === 'Manager login required.',
    `OLD kiosk Logout (/api/auth/logout) kills the manager login: /api/manager/machines -> ${afterOld.status} "${afterOld.data && afterOld.data.message}", /api/tanks -> ${tanksAfterOld.status}`);

  for (const slug of ['qa-qc-1', 'assembly-1']) {
    const K = new Client(`K-${slug}`);
    await K.login();
    check((await K.req(`/kiosk/machine/${slug}`)).status === 200, `manager browser opens /kiosk/machine/${slug} -> 200`);
    const kl = await K.req('/api/auth/kiosk-logout', { method: 'POST', body: '{}' });
    check(kl.status === 200 && (await K.managerValid()), `NEW kiosk Logout (/api/auth/kiosk-logout) on ${slug}: manager session stays valid`);
    await allDashboardOk(K, `after ${slug} kiosk logout`);
    await K.req('/api/auth/logout', { method: 'POST', body: '{}' });
  }
  const asmJs = await A.req('/assembly-kiosk.js');
  const qaJs = await A.req('/phase2-qa-kiosk.js');
  check(/api\/auth\/kiosk-logout/.test(asmJs.text) && !/api\/auth\/logout'/.test(asmJs.text), 'served assembly-kiosk.js logout uses /api/auth/kiosk-logout');
  check(/api\/auth\/kiosk-logout/.test(qaJs.text), 'served phase2-qa-kiosk.js machine-kiosk logout uses /api/auth/kiosk-logout');

  console.log('== 8. Genuine session expiration');
  const E = new Client('E');
  await E.login();
  check(await E.managerValid(), 'fresh session valid');
  const sid = E.sid();
  const upd = await pool.query(`UPDATE session SET expire = now() - interval '1 minute' WHERE sid = $1`, [sid]);
  check(upd.rowCount === 1, 'expired only this test session row in the store');
  const expProbe = await E.req('/api/auth/manager-session');
  const expApi = await E.req('/api/manager/machines');
  check(expProbe.status === 401 && expApi.status === 401, `expired session -> manager-session ${expProbe.status}, /api/manager/machines ${expApi.status}`);
  const expPage = await E.req('/manager-dashboard');
  check(expPage.status === 302 && expPage.location === '/manager-login', `expired session page load -> ${expPage.status} ${expPage.location}`);
  const T = new Client('T', 'factory_scan_sid=s%3Atampered.invalidsig');
  check((await T.req('/api/auth/manager-session')).status === 401, 'tampered/unknown cookie -> 401');
  check(await A.managerValid(), 'other sessions unaffected by one session expiring');

  console.log('== 10. Kiosk remains independently functional');
  const km = await new Client('anon').req('/api/auth/kiosk-login-machines');
  check(km.status === 200 && km.data && km.data.machines.length >= 4, `kiosk login machine list -> ${km.status} (${km.data && km.data.machines.map((m) => m.name).join(', ')})`);
  const wrong = await new Client('pin').req('/api/auth/login-kiosk-pin', { method: 'POST', body: JSON.stringify({ machine_id: 5, pin: '000000' }) });
  check(wrong.status === 401 && wrong.data.error === 'invalid_credentials', 'kiosk PIN check active (wrong PIN rejected)');
  const W = new Client('W');
  check((await W.req('/kiosk/machine/winding-machine-01')).status === 200, 'winding kiosk page loads (no manager login)');
  const wcfg = await W.req('/api/kiosk/winding/config');
  check(wcfg.status === 200, `winding kiosk config API -> ${wcfg.status}`);
  const Q = new Client('Q');
  check((await Q.req('/kiosk/machine/qa-qc-1')).status === 200, 'QA/QC kiosk page loads');
  check((await Q.req('/api/qa/board')).status === 200, 'QA/QC kiosk board API -> 200');
  const S = new Client('S');
  check((await S.req('/kiosk/machine/assembly-1')).status === 200, 'Assembly kiosk page loads');
  check((await S.req('/api/kiosk/assembly/config')).status === 200, 'Assembly kiosk config API -> 200');
  check((await W.req('/api/manager/machines')).status === 401, 'kiosk session does not grant manager APIs');
  check(await A.managerValid(), 'manager session A still valid after all kiosk activity');
}

async function restartScenario() {
  console.log('== 6. Restart the Node.js server and reconnect');
  const A = new Client('A', fs.readFileSync(COOKIE_FILE, 'utf8').trim());
  check(await A.managerValid(), 'saved manager session valid before restart');
  const outcomes = { ok: 0, network: 0, s401: 0, s5xx: 0, other: 0 };
  let polling = true;
  const poller = (async () => {
    while (polling) {
      try {
        const r = await A.req('/api/auth/manager-session');
        if (r.status === 200) outcomes.ok += 1;
        else if (r.status === 401) outcomes.s401 += 1;
        else if (r.status >= 500) outcomes.s5xx += 1;
        else outcomes.other += 1;
      } catch (_e) {
        outcomes.network += 1;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
  })();
  await new Promise((res) => setTimeout(res, 600));
  await new Promise((resolve, reject) => {
    exec('pm2 restart factory-scan-clock', (err) => (err ? reject(err) : resolve()));
  });
  const deadline = Date.now() + 60000;
  let back = false;
  while (Date.now() < deadline) {
    try {
      const r = await A.req('/api/auth/manager-session');
      if (r.status === 200) {
        back = true;
        break;
      }
    } catch (_e) {}
    await new Promise((res) => setTimeout(res, 500));
  }
  await new Promise((res) => setTimeout(res, 1500));
  polling = false;
  await poller;
  console.log(`  poll outcomes during restart: ${JSON.stringify(outcomes)}`);
  check(back, 'server came back and the same manager session is valid (no re-login)');
  check(outcomes.s401 === 0, 'no 401 at any point during the restart (only connection errors / 5xx, treated as transient by the UI)');
  await allDashboardOk(A, 'after restart');
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon.');
  if (process.argv.includes('--restart')) await restartScenario();
  else await mainScenarios();
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
