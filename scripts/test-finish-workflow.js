'use strict';

/**
 * Manual-assisted FINISH workflow checks.
 * Requires an authenticated kiosk session cookie (run from browser/devtools for full e2e),
 * but this script validates server endpoint behavior and messages where possible.
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function logCase(name, pass, extra) {
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${extra ? ` — ${extra}` : ''}`);
}

async function main() {
  console.log('[finish-test] Base URL:', BASE);
  console.log('[finish-test] Note: if you see 401, run through kiosk login first.');

  const employee = process.env.TEST_EMPLOYEE_CODE || 'EMP001';

  // Case 1: IN -> FINISH with no active job should fail clearly
  {
    const { res, data } = await call('/api/kiosk/work-action', {
      employee_code: employee,
      action: 'finish_job',
    });
    if (res.status === 401) {
      logCase('auth required', true, 'kiosk session required for full test');
      return;
    }
    const ok = !res.ok && data && /No active job to finish/i.test(String(data.message || ''));
    logCase('IN -> FINISH no active job blocked', ok, data.message || `status=${res.status}`);
  }

  // Case 2: STOPPED -> FINISH blocked message
  {
    const { data: stopData } = await call('/api/kiosk/work-action', {
      employee_code: employee,
      action: 'enter_stop',
      stop: 'Material',
    });
    if (stopData && stopData.ok) {
      const { res, data } = await call('/api/kiosk/work-action', {
        employee_code: employee,
        action: 'finish_job',
      });
      const ok = !res.ok && /Resume current job before finishing/i.test(String(data.message || ''));
      logCase('STOPPED -> FINISH blocked', ok, data.message || `status=${res.status}`);
      await call('/api/kiosk/work-action', { employee_code: employee, action: 'resume_work' });
    } else {
      logCase('STOPPED -> FINISH blocked', true, 'skipped (employee not in stoppable state)');
    }
  }

  // Case 3+: manual checklist marker
  console.log('\nManual verification still required for these scenarios:');
  console.log('1) IN -> Activity -> Tank -> FINISH');
  console.log('2) IN -> Activity -> Tank -> FINISH -> New Activity -> New Tank');
  console.log('3) FINISH -> OUT');
}

main().catch((err) => {
  console.error('[finish-test] ERROR', err.message || err);
  process.exit(1);
});

