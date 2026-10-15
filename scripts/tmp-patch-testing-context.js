'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'phase2-assembly-testing.js');
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('  function emptyTestingFailureContext()');
const end = s.indexOf('  async function mapStageSession(row, client = pool)');
if (start < 0 || end < 0) {
  console.error('markers not found', start, end);
  process.exit(1);
}
const replacement = `  function emptyTestingSessionContext() {
    return {
      open_testing_attempt_id: null,
      open_vacuum_attempt_id: null,
      open_brine_attempt_id: null,
      latest_failed_testing: null,
      testing_attempt_number: 0,
      is_testing_retest: false,
      testing_status_detail: null,
      testing_status_label: null,
      vacuum_retest_required: false,
      brine_retest_required: false,
      vacuum_retest_in_progress: false,
      brine_retest_in_progress: false,
      latest_failed_vacuum: null,
      latest_failed_brine: null,
    };
  }

  function mapAttemptBrief(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      test_type: String(row.test_type || '')
        .trim()
        .toUpperCase(),
      result: row.result || null,
      attempt_status: row.attempt_status || null,
      failure_note: row.failure_note || null,
      started_at: row.started_at || row.attempted_at || null,
      completed_at: row.completed_at || row.attempted_at || null,
      parent_attempt_id: row.parent_attempt_id != null ? Number(row.parent_attempt_id) : null,
      vacuum_start_inhg: row.vacuum_start_inhg != null ? Number(row.vacuum_start_inhg) : null,
      vacuum_end_inhg: row.vacuum_end_inhg != null ? Number(row.vacuum_end_inhg) : null,
      brine_expected_amount: row.brine_expected_amount != null ? Number(row.brine_expected_amount) : null,
      brine_actual_amount: row.brine_actual_amount != null ? Number(row.brine_actual_amount) : null,
    };
  }

  async function getTestingFailureContext(tankId, client = pool) {
    const tid = Number(tankId);
    if (!Number.isInteger(tid) || tid <= 0) return emptyTestingSessionContext();
    let rows = [];
    try {
      const res = await client.query(
        \`SELECT id, test_type, result, attempt_status, failure_note, started_at, completed_at, attempted_at,
                parent_attempt_id, vacuum_start_inhg, vacuum_end_inhg,
                brine_expected_amount, brine_actual_amount
         FROM test_attempts
         WHERE tank_id = $1
           AND UPPER(TRIM(COALESCE(test_type, ''))) IN ('TESTING', 'VACUUM', 'BRINE')
         ORDER BY id ASC\`,
        [tid]
      );
      rows = res.rows || [];
    } catch (_err) {
      return emptyTestingSessionContext();
    }
    const testingRows = rows.filter((r) => String(r.test_type || '').toUpperCase() === 'TESTING');
    const openTesting = [...testingRows].reverse().find((r) => {
      const st = String(r.attempt_status || '')
        .trim()
        .toLowerCase();
      return st === 'in_progress' || (!r.result && st !== 'passed' && st !== 'failed');
    });
    const failedTesting = [...testingRows]
      .reverse()
      .find(
        (r) =>
          normalizeTestResult(r.result) === 'FAIL' ||
          String(r.attempt_status || '')
            .toLowerCase() === 'failed'
      );
    const parentId = openTesting ? Number(openTesting.id) : null;
    const children = parentId ? rows.filter((r) => Number(r.parent_attempt_id) === parentId) : [];
    const openVacuum = [...children].reverse().find((r) => {
      if (String(r.test_type || '').toUpperCase() !== 'VACUUM') return false;
      const st = String(r.attempt_status || '')
        .trim()
        .toLowerCase();
      return (
        st === 'in_progress' ||
        (r.vacuum_end_inhg == null && st !== 'recorded' && st !== 'passed' && st !== 'failed')
      );
    });
    const openBrine = [...children].reverse().find((r) => {
      if (String(r.test_type || '').toUpperCase() !== 'BRINE') return false;
      const st = String(r.attempt_status || '')
        .trim()
        .toLowerCase();
      return (
        st === 'in_progress' ||
        (r.brine_actual_amount == null && st !== 'recorded' && st !== 'passed' && st !== 'failed')
      );
    });
    const failedCount = testingRows.filter(
      (r) =>
        normalizeTestResult(r.result) === 'FAIL' ||
        String(r.attempt_status || '')
          .toLowerCase() === 'failed'
    ).length;
    const isRetest = Boolean(openTesting && failedCount > 0);
    let testing_status_detail = null;
    let testing_status_label = null;
    if (openTesting && isRetest) {
      testing_status_detail = 'testing_retest_in_progress';
      testing_status_label = 'Testing — Retest';
    } else if (openTesting) {
      testing_status_detail = 'testing_in_progress';
      testing_status_label = 'Testing';
    } else if (failedTesting) {
      testing_status_detail = 'testing_failed_hold';
      testing_status_label = 'Testing Failed — Hold';
    }
    return {
      open_testing_attempt_id: openTesting ? Number(openTesting.id) : null,
      open_vacuum_attempt_id: openVacuum ? Number(openVacuum.id) : null,
      open_brine_attempt_id: openBrine ? Number(openBrine.id) : null,
      latest_failed_testing: failedTesting ? mapAttemptBrief(failedTesting) : null,
      testing_attempt_number: testingRows.length,
      is_testing_retest: isRetest,
      testing_status_detail,
      testing_status_label,
      vacuum_retest_required: false,
      brine_retest_required: false,
      vacuum_retest_in_progress: false,
      brine_retest_in_progress: false,
      latest_failed_vacuum: null,
      latest_failed_brine: null,
    };
  }

  async function enrichTankSummaryWithTestingFailure(summary, client = pool) {
    if (!summary || !summary.id) return summary;
    const st = normalizeAssemblyTankStatus(summary.status);
    if (
      st !== ASSEMBLY_STATUSES.READY_FOR_TESTING &&
      st !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS &&
      st !== ASSEMBLY_STATUSES.TESTING_FAILED
    ) {
      return { ...summary, ...emptyTestingSessionContext() };
    }
    const ctx = await getTestingFailureContext(summary.id, client);
    return { ...summary, ...ctx };
  }

  async function ensureOpenTestingAttempt(tankId, machine, user, client, previousStatus) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const existing = await client.query(
      \`SELECT id FROM test_attempts
       WHERE tank_id = $1
         AND UPPER(TRIM(COALESCE(test_type, ''))) = 'TESTING'
         AND LOWER(TRIM(COALESCE(attempt_status, ''))) = 'in_progress'
       ORDER BY id DESC
       LIMIT 1\`,
      [tankId]
    );
    if (existing.rows.length) return Number(existing.rows[0].id);
    const ts = nowIso();
    const insert = await client.query(
      \`INSERT INTO test_attempts
         (tank_id, machine_id, attempted_at, previous_status, test_type, attempt_status,
          started_at, tester_user_id, tester_user_name, tester_employee_name, created_at)
       VALUES ($1,$2,$3::timestamptz,$4,'TESTING','in_progress',$3::timestamptz,$5,$6,$6,NOW())
       RETURNING id\`,
      [
        tankId,
        mid,
        ts,
        previousStatus || null,
        user && user.id != null ? Number(user.id) : null,
        (user && (user.name || user.username)) || null,
      ]
    );
    return Number(insert.rows[0].id);
  }

`;
fs.writeFileSync(p, s.slice(0, start) + replacement + s.slice(end));
console.log('OK replaced context helpers');
