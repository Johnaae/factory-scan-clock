'use strict';

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const { mapMachineForClient } = require('./phase1-production-logic');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function workflowLoginSuffix(m) {
  const wf = String((m && m.workflow) || 'winding').toLowerCase();
  if (wf === 'qa_testing') return ' (QA/QC)';
  if (wf === 'assembly_testing') return ' (Assembly / Testing)';
  return ' (Winding)';
}

/** Reproduce the OLD buggy login label mapping. */
function oldBugSuffix(m) {
  const wf = String((m && m.workflow) || 'winding').toLowerCase();
  return wf === 'assembly_testing' ? ' (Assembly / Testing)' : ' (Winding)';
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');

  const { rows } = await pool.query(
    `SELECT id, name, code, barcode, kiosk_slug, sort_order, active, workflow
     FROM machines
     WHERE active = 1
       AND (
         name = '1212'
         OR name ILIKE 'Winding Machine 01%'
         OR name = '005'
         OR name ILIKE 'TEST QAQC%'
       )
     ORDER BY
       CASE
         WHEN name = '1212' THEN 0
         WHEN name ILIKE 'Winding Machine 01%' THEN 1
         WHEN name = '005' THEN 2
         ELSE 3
       END,
       id DESC`
  );

  const byName = {};
  for (const row of rows) {
    const mapped = mapMachineForClient(row);
    byName[mapped.name] = mapped;
    console.log(
      JSON.stringify({
        name: mapped.name,
        db_workflow: row.workflow,
        api_workflow: mapped.workflow,
        api_label: mapped.workflow_label,
        login_suffix_new: workflowLoginSuffix(mapped),
        login_suffix_old_bug: oldBugSuffix(mapped),
        kiosk_url: mapped.kiosk_url,
      })
    );
  }

  const m1212 = rows.find((r) => String(r.name).trim() === '1212');
  assert(m1212, 'machine 1212 not found');
  assert(String(m1212.workflow).toLowerCase() === 'qa_testing', `1212 db workflow=${m1212.workflow}`);
  const mapped1212 = mapMachineForClient(m1212);
  assert(mapped1212.workflow === 'qa_testing', '1212 API workflow');
  assert(oldBugSuffix(mapped1212) === ' (Winding)', 'document old bug maps QA to Winding');
  assert(workflowLoginSuffix(mapped1212) === ' (QA/QC)', 'fixed suffix for 1212');

  // Live API (same endpoint as Kiosk PIN Login)
  const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
  const res = await fetch(`${base}/api/auth/kiosk-login-machines`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const data = await res.json();
  assert(res.ok && data.ok, `kiosk-login-machines failed: ${JSON.stringify(data)}`);
  const api1212 = (data.machines || []).find((m) => String(m.name).trim() === '1212');
  assert(api1212, '1212 missing from kiosk-login-machines');
  assert(api1212.workflow === 'qa_testing', `API returned workflow=${api1212.workflow}`);
  assert(workflowLoginSuffix(api1212) === ' (QA/QC)', 'login label for API 1212');

  const winding = (data.machines || []).find((m) => String(m.name).includes('Winding Machine 01'));
  const asm005 = (data.machines || []).find((m) => String(m.name).trim() === '005');
  if (winding) {
    assert(winding.workflow === 'winding', `Winding Machine 01 workflow=${winding.workflow}`);
    assert(workflowLoginSuffix(winding) === ' (Winding)', 'winding suffix');
  }
  if (asm005) {
    assert(asm005.workflow === 'assembly_testing', `005 workflow=${asm005.workflow}`);
    assert(workflowLoginSuffix(asm005) === ' (Assembly / Testing)', '005 suffix');
  }

  // Routing markers for QA kiosk HTML
  const kioskRes = await fetch(`${base}${api1212.kiosk_url}`, { redirect: 'manual' });
  const html = await kioskRes.text();
  assert(kioskRes.ok, `kiosk open status ${kioskRes.status}`);
  assert(/QA\/QC/i.test(html), 'QA kiosk HTML');
  assert(!/assembly-kiosk\.js/i.test(html), 'not assembly');
  assert(!/machine-kiosk\.js/i.test(html), 'not fab');

  console.log('PASS kiosk login workflow labels + 1212 QA route');
  console.log(
    JSON.stringify(
      {
        winding: winding
          ? { name: winding.name, workflow: winding.workflow, label: `${winding.name}${workflowLoginSuffix(winding)}` }
          : null,
        asm005: asm005
          ? { name: asm005.name, workflow: asm005.workflow, label: `${asm005.name}${workflowLoginSuffix(asm005)}` }
          : null,
        m1212: {
          name: api1212.name,
          workflow: api1212.workflow,
          label: `${api1212.name}${workflowLoginSuffix(api1212)}`,
          url: api1212.kiosk_url,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('FAIL', err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
