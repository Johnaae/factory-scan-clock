'use strict';

const API = '/api/qa';
const IS_MACHINE_KIOSK = /^\/kiosk\/machine\//i.test(window.location.pathname);

const els = {
  userLabel: document.getElementById('userLabel'),
  warning: document.getElementById('scanWarning'),
  readyQaList: document.getElementById('readyQaList'),
  qaProgressList: document.getElementById('qaProgressList'),
  qaFailedList: document.getElementById('qaFailedList'),
  readyTestList: document.getElementById('readyTestList'),
  testingList: document.getElementById('testingList'),
  logoutBtn: document.getElementById('logoutBtn'),
  inputModal: document.getElementById('inputModal'),
  inputTitle: document.getElementById('inputTitle'),
  inputHint: document.getElementById('inputHint'),
  inputField: document.getElementById('inputField'),
  inputNote: document.getElementById('inputNote'),
  inputCancel: document.getElementById('inputCancel'),
  inputOk: document.getElementById('inputOk'),
  resultChoice: document.getElementById('resultChoice'),
  resultPass: document.getElementById('resultPass'),
  resultFail: document.getElementById('resultFail'),
};

let board = null;
let machineId = null;
let busy = false;
let inputResolve = null;
/** Per-tank open attempt ids by type — never mix Vacuum/Brine/TESTING ids. */
const openByTank = {};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTs(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function formatNum(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(n);
}

function showWarning(msg) {
  if (!els.warning) return;
  if (!msg) {
    els.warning.hidden = true;
    els.warning.textContent = '';
    return;
  }
  els.warning.hidden = false;
  els.warning.textContent = msg;
}

async function api(path, opts) {
  const options = opts || {};
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  let data = null;
  try {
    data = await res.json();
  } catch (_err) {
    data = { ok: false, message: 'Invalid server response.' };
  }
  return { res, data };
}

function setResultChoiceVisible(show) {
  if (!els.resultChoice) return;
  els.resultChoice.hidden = !show;
  els.resultChoice.style.display = show ? 'grid' : 'none';
}

function openInput({ title, hint, numeric, needNote, placeholder, confirmLabel, hideField, resultChoice }) {
  return new Promise((resolve) => {
    inputResolve = resolve;
    const showPassFail = Boolean(resultChoice);
    if (els.inputTitle) els.inputTitle.textContent = title || 'Input';
    if (els.inputHint) {
      els.inputHint.textContent = hint || '';
      els.inputHint.style.whiteSpace = 'pre-line';
    }
    // PASS/FAIL only when explicitly requested — never during measurement entry.
    setResultChoiceVisible(showPassFail);
    if (els.inputField) {
      els.inputField.value = '';
      els.inputField.placeholder = placeholder || '';
      els.inputField.inputMode = numeric ? 'decimal' : 'text';
      els.inputField.hidden = Boolean(hideField) || showPassFail || (needNote && !placeholder && !numeric);
    }
    if (els.inputNote) {
      els.inputNote.value = '';
      els.inputNote.hidden = !needNote;
      if (needNote) {
        els.inputNote.placeholder = showPassFail
          ? 'Failure reason (required for FAIL)'
          : 'Reason / notes';
      }
    }
    if (els.inputOk) {
      els.inputOk.textContent = confirmLabel || 'Confirm';
      els.inputOk.hidden = showPassFail;
    }
    if (els.inputCancel) els.inputCancel.textContent = 'Cancel';
    els.inputModal.hidden = false;
    els.inputModal.classList.add('show');
    if (showPassFail) {
      /* PASS/FAIL buttons drive submit */
    } else if (els.inputNote && needNote && els.inputField && els.inputField.hidden) {
      els.inputNote.focus();
    } else if (els.inputField && !els.inputField.hidden) {
      els.inputField.focus();
    }
  });
}

function closeInput(result) {
  els.inputModal.classList.remove('show');
  els.inputModal.hidden = true;
  if (els.inputOk) els.inputOk.hidden = false;
  setResultChoiceVisible(false);
  const r = inputResolve;
  inputResolve = null;
  if (r) r(result);
}

function submitTestResult(result) {
  const note =
    els.inputNote && !els.inputNote.hidden ? String(els.inputNote.value || '').trim() : null;
  if (result === 'FAIL' && !note) {
    showWarning('Failure reason required for FAIL.');
    if (els.inputNote) els.inputNote.focus();
    return;
  }
  closeInput({ value: result, note });
}

function emptyHtml(msg) {
  return `<p class="qa2-empty">${escapeHtml(msg)}</p>`;
}

function tankCard(tank, metaHtml, actionsHtml) {
  return `<article class="qa2-card" data-tank-id="${Number(tank.id)}">
    <h3 class="qa2-title">Tank ${escapeHtml(tank.tank_number || '—')}</h3>
    ${metaHtml}
    <div class="qa2-actions">${actionsHtml}</div>
  </article>`;
}

function renderList(el, tanks, builder) {
  if (!el) return;
  if (!tanks || !tanks.length) {
    el.innerHTML = emptyHtml('None');
    return;
  }
  el.innerHTML = tanks.map(builder).join('');
}

function syncOpenFromTank(t) {
  const tid = Number(t.id);
  openByTank[tid] = {
    testing: t.open_testing_attempt_id ? Number(t.open_testing_attempt_id) : null,
    vacuum: t.open_vacuum_attempt_id ? Number(t.open_vacuum_attempt_id) : null,
    brine: t.open_brine_attempt_id ? Number(t.open_brine_attempt_id) : null,
  };
}

function noteAttemptId(t) {
  const o = openByTank[Number(t.id)] || {};
  return (
    o.testing ||
    (t.latest_failed_testing && t.latest_failed_testing.id) ||
    (t.latest_failed_vacuum && t.latest_failed_vacuum.parent_attempt_id) ||
    null
  );
}

function readyTestingCard(t) {
  return tankCard(
    t,
    `<p class="qa2-meta">QA Complete — Ready for Testing</p>
     <p class="qa2-meta">QA completed: ${escapeHtml(formatTs(t.qa_completed_at))}</p>`,
    `<button type="button" class="btn-primary btn-touch" data-qa="begin_testing" data-tank-id="${Number(t.id)}">START TESTING</button>`
  );
}

function vacuumSummaryHtml(vac) {
  if (!vac) return '';
  return `<p class="qa2-meta">Start: ${escapeHtml(formatNum(vac.vacuum_start_inhg))} inHg</p>
    <p class="qa2-meta">End: ${escapeHtml(formatNum(vac.vacuum_end_inhg))} inHg</p>
    <p class="qa2-meta">Difference: ${escapeHtml(formatNum(vac.vacuum_delta_inhg))} inHg</p>
    <p class="qa2-meta">Elapsed Time: ${escapeHtml(vac.elapsed_display || '—')}</p>`;
}

function brineSummaryHtml(brine) {
  if (!brine) return '';
  return `<p class="qa2-meta">Expected: ${escapeHtml(formatNum(brine.brine_expected_amount))}</p>
    <p class="qa2-meta">Actual: ${escapeHtml(formatNum(brine.brine_actual_amount))}</p>
    <p class="qa2-meta">Difference: ${escapeHtml(formatNum(brine.brine_variance))}</p>
    <p class="qa2-meta">Fill Duration: ${escapeHtml(brine.elapsed_display || '—')}</p>`;
}

function testingCard(t) {
  syncOpenFromTank(t);
  const o = openByTank[Number(t.id)] || {};
  const heading = t.is_testing_retest ? 'TESTING — RETEST' : 'TESTING';
  const vacuumPassed = Boolean(t.vacuum_passed);
  const pending = t.pending_vacuum_result || null;
  const openVac = o.vacuum;
  const noteId = noteAttemptId(t) || o.testing || '';
  let meta = `<p class="qa2-meta"><strong>${escapeHtml(heading)}</strong></p>
    <p class="qa2-meta">Started: ${escapeHtml(formatTs(t.testing_started_at))}</p>`;
  if (t.testing_attempt_number) {
    meta += `<p class="qa2-meta">Attempt #${Number(t.testing_attempt_number)}</p>`;
  }

  const actions = [];

  if (pending) {
    // Decision point #1 — Vacuum Test Complete (PASS/FAIL only here, not in measurement modals)
    meta += `<p class="qa2-meta"><strong>Vacuum Test Complete</strong></p>${vacuumSummaryHtml(pending)}`;
    actions.push(
      `<button type="button" class="btn-touch btn-pass" data-qa="vacuum_result" data-tank-id="${Number(t.id)}" data-attempt-id="${Number(pending.id)}" data-result="PASS">PASS</button>`
    );
    actions.push(
      `<button type="button" class="btn-touch btn-fail" data-qa="vacuum_result" data-tank-id="${Number(t.id)}" data-attempt-id="${Number(pending.id)}" data-result="FAIL">FAIL</button>`
    );
  } else if (!vacuumPassed) {
    meta += `<p class="qa2-meta"><strong>VACUUM TEST REQUIRED</strong></p>`;
    if (openVac) {
      actions.push(
        `<button type="button" class="btn-touch btn-vac" data-qa="vacuum_complete" data-tank-id="${Number(t.id)}" data-attempt-id="${openVac}">RECORD END VACUUM</button>`
      );
    } else {
      actions.push(
        `<button type="button" class="btn-touch btn-vac" data-qa="vacuum" data-tank-id="${Number(t.id)}">START VACUUM</button>`
      );
    }
  } else {
    const vac = t.current_vacuum || {};
    meta += `<p class="qa2-meta"><strong>VACUUM</strong> ✓ PASS</p>${vacuumSummaryHtml(vac)}`;
    meta += `<p class="qa2-meta"><strong>BRINE TEST</strong></p>`;
    if (o.brine) {
      actions.push(
        `<button type="button" class="btn-touch btn-brine" data-qa="brine_stop" data-tank-id="${Number(t.id)}" data-attempt-id="${o.brine}">STOP FILL</button>`
      );
    } else if (!t.brine_completed) {
      actions.push(
        `<button type="button" class="btn-touch btn-brine" data-qa="brine" data-tank-id="${Number(t.id)}">START FILL</button>`
      );
    } else {
      meta += brineSummaryHtml(t.current_brine);
      actions.push(
        `<button type="button" class="btn-primary btn-touch" data-qa="testing_complete" data-tank-id="${Number(t.id)}" data-attempt-id="${o.testing || ''}">TEST COMPLETE</button>`
      );
    }
  }

  actions.push(
    `<button type="button" class="btn-secondary btn-touch" data-qa="add_note" data-tank-id="${Number(t.id)}" data-attempt-id="${noteId}">ADD NOTE</button>`
  );

  return tankCard(t, meta, actions.join('\n'));
}

function failedHoldCard(t) {
  const isQa = t.failure_source === 'qa' || String(t.status).toLowerCase() === 'qa_failed';
  if (isQa) {
    return tankCard(
      t,
      `<p class="qa2-meta"><strong>QA FAILED</strong></p>
       <p class="qa2-meta">Reason: ${escapeHtml(t.qa_failure_note || '—')}</p>
       <p class="qa2-meta">Failed: ${escapeHtml(formatTs(t.qa_completed_at))}</p>`,
      `<button type="button" class="btn-primary btn-touch" data-qa="start_qa" data-tank-id="${Number(t.id)}">RESTART QA</button>`
    );
  }
  const vacFail = t.latest_failed_vacuum || null;
  const fail = vacFail || t.latest_failed_testing || {};
  const attemptNo = t.testing_attempt_number || (fail.parent_attempt_id ? null : null);
  const noteId = (t.latest_failed_testing && t.latest_failed_testing.id) || fail.parent_attempt_id || '';
  let meta = `<p class="qa2-meta"><strong>${vacFail ? 'VACUUM FAILED' : 'TESTING FAILED'}</strong></p>`;
  if (t.testing_attempt_number) {
    meta += `<p class="qa2-meta">Attempt #${Number(t.testing_attempt_number)}</p>`;
  } else if (attemptNo) {
    meta += `<p class="qa2-meta">Attempt #${Number(attemptNo)}</p>`;
  }
  meta += `<p class="qa2-meta">Reason: ${escapeHtml(fail.failure_note || '—')}</p>
    <p class="qa2-meta">Failed: ${escapeHtml(formatTs(fail.completed_at))}</p>`;
  if (vacFail) meta += vacuumSummaryHtml(vacFail);
  return tankCard(
    t,
    meta,
    `<button type="button" class="btn-primary btn-touch" data-qa="testing_retest" data-tank-id="${Number(t.id)}">RETEST</button>
     <button type="button" class="btn-touch btn-fail" data-qa="send_to_fab_rework" data-tank-id="${Number(t.id)}">SEND BACK TO FAB REWORK</button>
     <button type="button" class="btn-secondary btn-touch" data-qa="add_note" data-tank-id="${Number(t.id)}" data-attempt-id="${noteId}">ADD NOTE</button>`
  );
}

function renderAll() {
  if (!board) return;
  renderList(els.readyQaList, board.ready_for_qa, (t) =>
    tankCard(
      t,
      `<p class="qa2-meta">Assembly completed: ${escapeHtml(formatTs(t.assembly_completed_at))}</p>`,
      `<button type="button" class="btn-primary btn-touch" data-qa="start_qa" data-tank-id="${Number(t.id)}">START QA</button>`
    )
  );
  renderList(els.qaProgressList, board.qa_in_progress, (t) =>
    tankCard(
      t,
      `<p class="qa2-meta">QA/QC</p>
       <p class="qa2-meta">Started: ${escapeHtml(formatTs(t.qa_started_at))}</p>`,
      `<button type="button" class="btn-touch btn-pass" data-qa="qa_pass" data-tank-id="${Number(t.id)}">PASS</button>
       <button type="button" class="btn-touch btn-fail" data-qa="qa_fail" data-tank-id="${Number(t.id)}">FAIL</button>`
    )
  );
  const failed = board.failed_hold || board.qa_failed || [];
  renderList(els.qaFailedList, failed, failedHoldCard);
  renderList(els.readyTestList, board.ready_for_testing, readyTestingCard);
  renderList(els.testingList, board.testing, testingCard);
  (board.testing || []).forEach(syncOpenFromTank);
}

async function loadBoard() {
  const { res, data } = await api(`${API}/board`, { cache: 'no-store' });
  if (res.status === 401) {
    if (IS_MACHINE_KIOSK) {
      showWarning('QA/QC kiosk session missing. Reload this machine URL.');
      return;
    }
    window.location.href = '/manager-login';
    return;
  }
  if (!res.ok || !data.ok) {
    showWarning((data && data.message) || 'Could not load QA board.');
    return;
  }
  board = data;
  if (data.machine && data.machine.id) machineId = Number(data.machine.id);
  if (els.userLabel) {
    if (data.machine && data.machine.name) {
      els.userLabel.textContent = `${data.machine.name} — inspection only (no labor hours)`;
    } else if (data.user) {
      els.userLabel.textContent = `${data.user.username} (${data.user.role}) — inspection only`;
    }
  }
  renderAll();
}

async function runAction(payload, okMessage) {
  if (busy) return null;
  busy = true;
  showWarning('');
  try {
    const body = { ...payload };
    if (machineId && body.machine_id == null) body.machine_id = machineId;
    const { res, data } = await api(`${API}/action`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      showWarning((data && data.message) || 'Not authorized for QA/Testing actions.');
      return null;
    }
    if (!res.ok || !data.ok) {
      showWarning((data && data.message) || 'Action failed.');
      return null;
    }
    if (okMessage || data.message) showWarning(okMessage || data.message);
    await loadBoard();
    return data;
  } finally {
    busy = false;
  }
}

async function promptVacuumResult(vacSummary) {
  const hint = [
    'Vacuum Test Complete',
    `Start: ${formatNum(vacSummary.vacuum_start_inhg)} inHg`,
    `End: ${formatNum(vacSummary.vacuum_end_inhg)} inHg`,
    `Difference: ${formatNum(vacSummary.vacuum_delta_inhg)} inHg`,
    `Elapsed Time: ${vacSummary.elapsed_display || '—'}`,
    '',
    'Select PASS or FAIL. FAIL requires a reason.',
  ].join('\n');
  return openInput({
    title: 'Vacuum Test Complete',
    hint,
    needNote: true,
    resultChoice: true,
    hideField: true,
  });
}

async function handleClick(ev) {
  const btn = ev.target.closest('[data-qa]');
  if (!btn || busy) return;
  const action = btn.getAttribute('data-qa');
  const tankId = Number(btn.getAttribute('data-tank-id'));
  const attemptIdAttr = btn.getAttribute('data-attempt-id');
  const attemptId = attemptIdAttr ? Number(attemptIdAttr) : null;
  if (!openByTank[tankId]) openByTank[tankId] = { testing: null, vacuum: null, brine: null };

  if (action === 'start_qa') {
    await runAction({ action: 'start_qa', tank_id: tankId }, 'QA In Progress.');
    return;
  }
  if (action === 'qa_pass') {
    await runAction({ action: 'qa_pass', tank_id: tankId }, 'QA PASS — Ready for Testing.');
    return;
  }
  if (action === 'qa_fail') {
    const note = await openInput({
      title: 'QA/QC Failed',
      hint: 'Reason is required. Failure history is preserved.',
      needNote: true,
      hideField: true,
      confirmLabel: 'Confirm Fail',
    });
    if (!note || !note.note) return;
    await runAction({ action: 'qa_fail', tank_id: tankId, note: note.note }, 'QA FAIL — Failed / Hold.');
    return;
  }
  if (action === 'begin_testing') {
    const data = await runAction({ action: 'begin_testing', tank_id: tankId }, 'Testing started — Vacuum required.');
    if (data && data.attempt_id) openByTank[tankId].testing = Number(data.attempt_id);
    return;
  }
  if (action === 'vacuum') {
    const start = await openInput({
      title: 'START Vacuum',
      hint: 'Enter starting vacuum reading (inHg).',
      numeric: true,
      placeholder: 'e.g. 29.5',
      confirmLabel: 'Confirm',
      resultChoice: false,
    });
    if (!start || start.value == null || start.value === '') return;
    const data = await runAction(
      { action: 'vacuum_start', tank_id: tankId, vacuum_start_inhg: Number(start.value) },
      'Vacuum started.'
    );
    if (data) {
      if (data.attempt_id) openByTank[tankId].vacuum = Number(data.attempt_id);
      if (data.testing_attempt_id) openByTank[tankId].testing = Number(data.testing_attempt_id);
    }
    return;
  }
  if (action === 'vacuum_complete') {
    if (!attemptId) {
      showWarning('No open Vacuum attempt. Press START VACUUM first.');
      return;
    }
    const end = await openInput({
      title: 'RECORD END Vacuum',
      hint: 'Enter ending vacuum reading (inHg).',
      numeric: true,
      placeholder: 'e.g. 28.0',
      confirmLabel: 'Confirm',
      resultChoice: false,
    });
    if (!end || end.value == null || end.value === '') return;
    const data = await runAction(
      {
        action: 'vacuum_complete',
        attempt_id: attemptId,
        vacuum_end_inhg: Number(end.value),
      },
      'Vacuum readings saved.'
    );
    openByTank[tankId].vacuum = null;
    if (!data || !data.needs_result) return;
    // Decision point #1 — only after readings are confirmed.
    const passFail = await promptVacuumResult(data);
    if (!passFail || !passFail.value) {
      showWarning('Vacuum data saved. Choose PASS or FAIL on the card.');
      return;
    }
    const result = String(passFail.value).trim().toUpperCase() === 'FAIL' ? 'FAIL' : 'PASS';
    if (result === 'FAIL' && !passFail.note) {
      showWarning('Failure reason required for Vacuum FAIL.');
      return;
    }
    await runAction(
      {
        action: 'vacuum_result',
        attempt_id: attemptId,
        result,
        note: passFail.note || null,
      },
      result === 'PASS' ? 'Vacuum PASS — Brine unlocked.' : 'Vacuum FAIL — Failed / Hold.'
    );
    return;
  }
  if (action === 'vacuum_result') {
    if (!attemptId) {
      showWarning('Missing Vacuum attempt.');
      return;
    }
    const preset = String(btn.getAttribute('data-result') || '').toUpperCase();
    let result = preset === 'FAIL' || preset === 'PASS' ? preset : null;
    let note = null;
    if (!result) {
      const tank = (board && board.testing || []).find((x) => Number(x.id) === tankId);
      const pending = tank && tank.pending_vacuum_result;
      const passFail = await promptVacuumResult(pending || {});
      if (!passFail || !passFail.value) return;
      result = String(passFail.value).trim().toUpperCase() === 'FAIL' ? 'FAIL' : 'PASS';
      note = passFail.note || null;
    } else if (result === 'FAIL') {
      const failNote = await openInput({
        title: 'Vacuum Test Failed',
        hint: 'Reason is required.',
        needNote: true,
        hideField: true,
        confirmLabel: 'Confirm Fail',
        resultChoice: false,
      });
      if (!failNote || !failNote.note) return;
      note = failNote.note;
    }
    if (result === 'FAIL' && !note) {
      showWarning('Failure reason required for Vacuum FAIL.');
      return;
    }
    await runAction(
      { action: 'vacuum_result', attempt_id: attemptId, result, note },
      result === 'PASS' ? 'Vacuum PASS — Brine unlocked.' : 'Vacuum FAIL — Failed / Hold.'
    );
    return;
  }
  if (action === 'brine') {
    const expected = await openInput({
      title: 'START FILL',
      hint: 'Enter expected brine amount.',
      numeric: true,
      placeholder: 'Expected amount',
      confirmLabel: 'Confirm',
      resultChoice: false,
    });
    if (!expected || expected.value == null || expected.value === '') return;
    const data = await runAction(
      {
        action: 'brine_start',
        tank_id: tankId,
        brine_expected_amount: Number(expected.value),
      },
      'Brine fill started.'
    );
    if (data) {
      if (data.attempt_id) openByTank[tankId].brine = Number(data.attempt_id);
      if (data.testing_attempt_id) openByTank[tankId].testing = Number(data.testing_attempt_id);
    }
    return;
  }
  if (action === 'brine_stop') {
    if (!attemptId) {
      showWarning('No open Brine attempt. Press START FILL first.');
      return;
    }
    const actual = await openInput({
      title: 'STOP FILL',
      hint: 'Enter actual brine amount.',
      numeric: true,
      placeholder: 'Actual amount',
      confirmLabel: 'Confirm',
      resultChoice: false,
    });
    if (!actual || actual.value == null || actual.value === '') return;
    await runAction(
      {
        action: 'brine_stop',
        attempt_id: attemptId,
        brine_actual_amount: Number(actual.value),
      },
      'Brine recorded — ready for TEST COMPLETE.'
    );
    openByTank[tankId].brine = null;
    return;
  }
  if (action === 'testing_complete') {
    const testingId = attemptId || openByTank[tankId].testing || null;
    const tank = (board && board.testing || []).find((x) => Number(x.id) === tankId) || {};
    const vac = tank.current_vacuum || {};
    const brine = tank.current_brine || {};
    const summary = [
      'Final Testing Result',
      '',
      'Vacuum:',
      `  Start: ${formatNum(vac.vacuum_start_inhg)} inHg`,
      `  End: ${formatNum(vac.vacuum_end_inhg)} inHg`,
      `  Difference: ${formatNum(vac.vacuum_delta_inhg)} inHg`,
      '',
      'Brine:',
      `  Expected: ${formatNum(brine.brine_expected_amount)}`,
      `  Actual: ${formatNum(brine.brine_actual_amount)}`,
      `  Difference: ${formatNum(brine.brine_variance)}`,
      '',
      'Select PASS or FAIL. FAIL requires a reason.',
    ].join('\n');
    const passFail = await openInput({
      title: 'TEST COMPLETE',
      hint: summary,
      needNote: true,
      resultChoice: true,
      hideField: true,
    });
    if (!passFail || !passFail.value) return;
    const result = String(passFail.value).trim().toUpperCase() === 'FAIL' ? 'FAIL' : 'PASS';
    if (result === 'FAIL' && !passFail.note) {
      showWarning('Failure reason required for Testing FAIL.');
      return;
    }
    const payload = {
      action: 'testing_complete',
      tank_id: tankId,
      result,
      note: passFail.note || null,
    };
    if (testingId) payload.attempt_id = testingId;
    await runAction(
      payload,
      result === 'PASS' ? 'Testing PASS — ready for Dome Install.' : 'Testing FAIL — Failed / Hold.'
    );
    openByTank[tankId] = { testing: null, vacuum: null, brine: null };
    return;
  }
  if (action === 'testing_retest') {
    const data = await runAction({ action: 'testing_retest', tank_id: tankId }, 'Retest started — Vacuum required.');
    if (data && data.attempt_id) {
      openByTank[tankId] = { testing: Number(data.attempt_id), vacuum: null, brine: null };
    }
    return;
  }
  if (action === 'send_to_fab_rework') {
    const ok = await openInput({
      title: 'Send Back to FAB Rework',
      hint: 'Confirm sending this tank to the existing FAB Rework Required workflow. Optional note below.',
      needNote: true,
      hideField: true,
      confirmLabel: 'Send to FAB Rework',
    });
    if (!ok) return;
    await runAction(
      {
        action: 'send_to_fab_rework',
        tank_id: tankId,
        reason: ok.note || null,
      },
      'Sent to FAB Rework Required.'
    );
    return;
  }
  if (action === 'add_note') {
    if (!attemptId) {
      showWarning('No Testing attempt available to attach a note.');
      return;
    }
    const note = await openInput({
      title: 'Add Test Note',
      hint: 'Append-only note attached to this Testing attempt.',
      needNote: true,
      hideField: true,
      confirmLabel: 'Save Note',
    });
    if (!note || !note.note) return;
    await runAction({ action: 'add_note', attempt_id: attemptId, note: note.note }, 'Note appended.');
  }
}

els.inputCancel.addEventListener('click', () => closeInput(null));
els.inputOk.addEventListener('click', () => {
  closeInput({
    value: els.inputField && !els.inputField.hidden ? els.inputField.value : null,
    note: els.inputNote && !els.inputNote.hidden ? String(els.inputNote.value || '').trim() : null,
  });
});
if (els.resultPass) {
  els.resultPass.addEventListener('click', () => submitTestResult('PASS'));
}
if (els.resultFail) {
  els.resultFail.addEventListener('click', () => submitTestResult('FAIL'));
}
document.addEventListener('click', (ev) => void handleClick(ev));
if (els.logoutBtn) {
  els.logoutBtn.addEventListener('click', async () => {
    if (IS_MACHINE_KIOSK) {
      await api('/api/auth/kiosk-logout', { method: 'POST', body: '{}' });
      window.location.href = '/kiosk-login';
      return;
    }
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    window.location.href = '/manager-login';
  });
}

void loadBoard().then(() => {
  setInterval(() => void loadBoard(), 10000);
});
