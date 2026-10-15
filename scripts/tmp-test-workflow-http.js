'use strict';

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) {
    throw new Error('Refusing Neon');
  }

  const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
  const jar = { cookie: '' };

  async function req(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (jar.cookie) headers.Cookie = jar.cookie;
    const res = await fetch(`${base}${path}`, { ...opts, headers, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const raw = res.headers.raw ? res.headers.raw()['set-cookie'] : null;
    const cookies = setCookie.length ? setCookie : raw || [];
    for (const c of cookies) {
      const part = String(c).split(';')[0];
      if (part) jar.cookie = jar.cookie ? `${jar.cookie}; ${part}` : part;
    }
    // node fetch may expose set-cookie differently
    const sc = res.headers.get('set-cookie');
    if (sc && !jar.cookie.includes(sc.split(';')[0])) {
      jar.cookie = jar.cookie ? `${jar.cookie}; ${sc.split(';')[0]}` : sc.split(';')[0];
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_e) {
      data = null;
    }
    return { res, data };
  }

  const login = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'manager', password: process.env.DEFAULT_MANAGER_PASSWORD || 'manager123' }),
  });
  assert(login.res.ok && login.data && login.data.ok, `login failed: ${JSON.stringify(login.data)}`);

  const suffix = String(Date.now()).slice(-6);
  const cases = [
    { name: `TEST FAB HTTP ${suffix}`, workflow: 'winding', expect: 'winding', label: 'Winding (FAB)' },
    { name: `TEST ASSEMBLY HTTP ${suffix}`, workflow: 'assembly_testing', expect: 'assembly_testing', label: 'Assembly + Testing' },
    { name: `TEST QAQC HTTP ${suffix}`, workflow: 'qa_testing', expect: 'qa_testing', label: 'QA/QC' },
  ];

  const created = [];
  for (const c of cases) {
    const { res, data } = await req('/api/manager/machine-areas', {
      method: 'POST',
      body: JSON.stringify({ name: c.name, workflow: c.workflow }),
    });
    assert(res.ok && data && data.ok, `create ${c.name}: ${JSON.stringify(data)}`);
    assert(data.machine.workflow === c.expect, `${c.name} response workflow=${data.machine.workflow}`);
    assert(data.machine.workflow_label === c.label, `${c.name} label=${data.machine.workflow_label}`);
    created.push({ ...c, id: data.machine.id, slug: data.machine.slug, url: data.machine.kiosk_url });
  }

  // Invalid workflow must 400 (not silently winding)
  const bad = await req('/api/manager/machine-areas', {
    method: 'POST',
    body: JSON.stringify({ name: `TEST BAD ${suffix}`, workflow: 'not_a_real_workflow' }),
  });
  assert(bad.res.status === 400, `expected 400 got ${bad.res.status}`);

  const ids = created.map((c) => c.id);
  const { rows } = await pool.query(
    `SELECT id, name, workflow, kiosk_slug FROM machines WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [ids]
  );
  assert(rows[0].workflow === 'winding', rows[0].workflow);
  assert(rows[1].workflow === 'assembly_testing', rows[1].workflow);
  assert(rows[2].workflow === 'qa_testing', rows[2].workflow);

  const list = await req('/api/manager/machine-areas?show_inactive=0');
  assert(list.res.ok && list.data && list.data.ok, 'list failed');
  for (const c of created) {
    const row = (list.data.machines || []).find((m) => Number(m.id) === Number(c.id));
    assert(row, `missing from list: ${c.name}`);
    assert(row.workflow === c.expect, `list workflow for ${c.name}`);
    assert(row.workflow_label === c.label, `list label for ${c.name}`);
  }

  const kiosk = await fetch(`${base}${created[2].url}`, { redirect: 'manual' });
  const html = await kiosk.text();
  assert(kiosk.ok, `kiosk status ${kiosk.status}`);
  assert(/QA\/QC/i.test(html) || /phase2-qa-kiosk/i.test(html) || /Ready for QA/i.test(html), 'QA kiosk HTML missing markers');
  assert(!/assembly-kiosk\.js/i.test(html), 'must not load assembly kiosk');
  assert(!/machine-kiosk\.js/i.test(html), 'must not load FAB machine kiosk');

  console.log('PASS HTTP create + list + QA kiosk route');
  console.log(JSON.stringify(created, null, 2));
}

main()
  .catch((err) => {
    console.error('FAIL', err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
