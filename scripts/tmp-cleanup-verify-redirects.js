'use strict';

/** READ-ONLY: confirm the two unauthenticated 302s are auth redirects and pages load for manager. */

const BASE = 'http://localhost:3000';

async function main() {
  for (const p of ['/login', '/machine-areas.js', '/kiosk/machine/winding-machine-01']) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    console.log(`anon GET ${p} -> ${r.status} Location=${r.headers.get('location')}`);
  }
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'manager', password: process.env.DEFAULT_MANAGER_PASSWORD || 'manager123' }),
  });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  for (const p of ['/machine-areas.js', '/machine-areas.html', '/qa-qc']) {
    const r = await fetch(BASE + p, { redirect: 'manual', headers: { Cookie: cookie } });
    console.log(`manager GET ${p} -> ${r.status} Location=${r.headers.get('location')}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
