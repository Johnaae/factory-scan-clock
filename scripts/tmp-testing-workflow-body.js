  async function startVacuumTest(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    const startInHg = Number(opts.vacuum_start_inhg != null ? opts.vacuum_start_inhg : opts.start_inhg);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    if (!Number.isFinite(startInHg)) {
      return errResult(400, 'validation', 'Vacuum starting reading (inHg) is required.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (
        status !== ASSEMBLY_STATUSES.READY_FOR_TESTING &&
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS
      ) {
        return errResult(409, 'tank_status', `Vacuum requires Testing in progress (got "${status}").`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      const parentId = await ensureOpenTestingAttempt(tankId, machine, user, client, status);
      const insert = await client.query(
        `INSERT INTO test_attempts
           (tank_id, machine_id, attempted_at, previous_status, test_type, attempt_status,
            started_at, vacuum_start_inhg, parent_attempt_id,
            tester_user_id, tester_user_name, tester_employee_name, created_at)
         VALUES ($1,$2,$3::timestamptz,$4,'VACUUM','in_progress',$3::timestamptz,$5,$6,$7,$8,$8,NOW())
         RETURNING id`,
        [
          tankId,
          mid,
          ts,
          status,
          startInHg,
          parentId,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
        ]
      );
      await client.query(
        `UPDATE tanks
         SET status = $1,
             testing_started_at = COALESCE(testing_started_at, $2::timestamptz),
             testing_machine_id = COALESCE($3, testing_machine_id),
             updated_at = $2::timestamptz
         WHERE id = $4`,
        [ASSEMBLY_STATUSES.TESTING_IN_PROGRESS, ts, mid, tankId]
      );
      return okResult({
        action: 'vacuum_start',
        attempt_id: Number(insert.rows[0].id),
        testing_attempt_id: parentId,
        vacuum_start_inhg: startInHg,
        started_at: ts,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Vacuum start recorded (measurement only — overall PASS/FAIL is via TEST COMPLETE).',
      });
    });
  }

  /** Record ending Vacuum inHg only — does NOT set overall Testing PASS/FAIL. */
  async function completeVacuumTest(machine, opts = {}) {
    const attemptId = Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId);
    const endInHg = Number(opts.vacuum_end_inhg != null ? opts.vacuum_end_inhg : opts.end_inhg);
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return errResult(400, 'validation', 'attempt_id is required (Vacuum attempt).');
    }
    if (!Number.isFinite(endInHg)) {
      return errResult(400, 'validation', 'Vacuum ending reading (inHg) is required.');
    }
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Vacuum attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'VACUUM') {
        return errResult(
          409,
          'wrong_type',
          `Attempt #${attemptId} is ${attempt.test_type || 'unknown'}, not Vacuum. Use the Vacuum Complete action with the Vacuum attempt id.`
        );
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'recorded' || prior === 'passed' || prior === 'failed') {
        return errResult(409, 'already_complete', 'This Vacuum measurement is already recorded.');
      }
      const ts = opts.at || nowIso();
      const startInHg = Number(attempt.vacuum_start_inhg);
      const delta = Number.isFinite(startInHg) ? endInHg - startInHg : null;
      await client.query(
        `UPDATE test_attempts
         SET vacuum_end_inhg = $1,
             completed_at = $2::timestamptz,
             attempt_status = 'recorded',
             result = NULL
         WHERE id = $3`,
        [endInHg, ts, attemptId]
      );
      const tankId = Number(attempt.tank_id);
      const startMs = toMs(attempt.started_at || attempt.attempted_at);
      const elapsedMs = startMs != null ? Math.max(0, toMs(ts) - startMs) : 0;
      return okResult({
        action: 'vacuum_complete',
        attempt_id: attemptId,
        testing_attempt_id: attempt.parent_attempt_id != null ? Number(attempt.parent_attempt_id) : null,
        vacuum_start_inhg: startInHg,
        vacuum_end_inhg: endInHg,
        vacuum_delta_inhg: delta,
        elapsed_ms: elapsedMs,
        elapsed_display: formatDurationXhYm(elapsedMs),
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Vacuum data recorded. Use TEST COMPLETE for overall PASS/FAIL.',
      });
    });
  }

  async function startBrineFill(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    const expected = Number(
      opts.brine_expected_amount != null ? opts.brine_expected_amount : opts.expected_amount
    );
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    if (!Number.isFinite(expected)) {
      return errResult(400, 'validation', 'Expected brine amount is required.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (
        status !== ASSEMBLY_STATUSES.READY_FOR_TESTING &&
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS
      ) {
        return errResult(409, 'tank_status', `Brine requires Testing in progress (got "${status}").`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      const parentId = await ensureOpenTestingAttempt(tankId, machine, user, client, status);
      const insert = await client.query(
        `INSERT INTO test_attempts
           (tank_id, machine_id, attempted_at, previous_status, test_type, attempt_status,
            started_at, brine_expected_amount, parent_attempt_id,
            tester_user_id, tester_user_name, tester_employee_name, created_at)
         VALUES ($1,$2,$3::timestamptz,$4,'BRINE','in_progress',$3::timestamptz,$5,$6,$7,$8,$8,NOW())
         RETURNING id`,
        [
          tankId,
          mid,
          ts,
          status,
          expected,
          parentId,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
        ]
      );
      await client.query(
        `UPDATE tanks
         SET status = $1,
             testing_started_at = COALESCE(testing_started_at, $2::timestamptz),
             testing_machine_id = COALESCE($3, testing_machine_id),
             updated_at = $2::timestamptz
         WHERE id = $4`,
        [ASSEMBLY_STATUSES.TESTING_IN_PROGRESS, ts, mid, tankId]
      );
      return okResult({
        action: 'brine_start',
        attempt_id: Number(insert.rows[0].id),
        testing_attempt_id: parentId,
        brine_expected_amount: expected,
        started_at: ts,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Brine fill started (measurement only — overall PASS/FAIL is via TEST COMPLETE).',
      });
    });
  }

  /** Record actual brine amount only — does NOT set overall Testing PASS/FAIL. */
  async function stopBrineFill(machine, opts = {}) {
    const attemptId = Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId);
    const actual = Number(
      opts.brine_actual_amount != null ? opts.brine_actual_amount : opts.actual_amount
    );
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return errResult(400, 'validation', 'attempt_id is required (Brine attempt).');
    }
    if (!Number.isFinite(actual)) {
      return errResult(400, 'validation', 'Actual brine amount is required.');
    }
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Brine attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'BRINE') {
        return errResult(
          409,
          'wrong_type',
          `Attempt #${attemptId} is ${attempt.test_type || 'unknown'}, not Brine. Use Stop Fill with the Brine attempt id.`
        );
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'recorded' || prior === 'passed' || prior === 'failed') {
        return errResult(409, 'already_complete', 'This Brine measurement is already recorded.');
      }
      const ts = opts.at || nowIso();
      const expected = Number(attempt.brine_expected_amount);
      const variance = Number.isFinite(expected) ? actual - expected : null;
      await client.query(
        `UPDATE test_attempts
         SET brine_actual_amount = $1,
             completed_at = $2::timestamptz,
             attempt_status = 'recorded',
             result = NULL
         WHERE id = $3`,
        [actual, ts, attemptId]
      );
      const tankId = Number(attempt.tank_id);
      const startMs = toMs(attempt.started_at || attempt.attempted_at);
      const elapsedMs = startMs != null ? Math.max(0, toMs(ts) - startMs) : 0;
      return okResult({
        action: 'brine_stop',
        attempt_id: attemptId,
        testing_attempt_id: attempt.parent_attempt_id != null ? Number(attempt.parent_attempt_id) : null,
        brine_expected_amount: expected,
        brine_actual_amount: actual,
        brine_variance: variance,
        elapsed_ms: elapsedMs,
        elapsed_display: formatDurationXhYm(elapsedMs),
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Brine data recorded. Use TEST COMPLETE for overall PASS/FAIL.',
      });
    });
  }

  /** Overall Testing result — only place that sets tank PASS/FAIL for Testing. */
  async function completeTesting(machine, opts = {}) {
    const midRaw = Number(machine && machine.id);
    const mid = Number.isInteger(midRaw) && midRaw > 0 ? midRaw : null;
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    const result = normalizeTestResult(opts.result);
    const note = String(opts.note || opts.failure_note || '').trim();
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    if (!result) {
      return errResult(400, 'validation', 'result must be PASS or FAIL.');
    }
    if (result === 'FAIL' && !note) {
      return errResult(400, 'validation', 'A failure reason is required for Testing FAIL.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (
        status !== ASSEMBLY_STATUSES.TESTING_IN_PROGRESS &&
        status !== ASSEMBLY_STATUSES.READY_FOR_TESTING
      ) {
        return errResult(409, 'tank_status', `TEST COMPLETE requires Testing (got "${status}").`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      let attemptId =
        opts.attempt_id != null || opts.attemptId != null
          ? Number(opts.attempt_id != null ? opts.attempt_id : opts.attemptId)
          : null;
      if (!Number.isInteger(attemptId) || attemptId <= 0) {
        attemptId = await ensureOpenTestingAttempt(tankId, machine, user, client, status);
      }
      const { rows } = await client.query(`SELECT * FROM test_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);
      if (!rows.length) return errResult(404, 'not_found', 'Testing attempt not found.');
      const attempt = rows[0];
      if (String(attempt.test_type || '').toUpperCase() !== 'TESTING') {
        return errResult(
          409,
          'wrong_type',
          `Attempt #${attemptId} is ${attempt.test_type || 'unknown'}, not overall Testing. TEST COMPLETE must target the TESTING attempt.`
        );
      }
      if (Number(attempt.tank_id) !== tankId) {
        return errResult(409, 'tank_mismatch', 'Testing attempt does not belong to this tank.');
      }
      const prior = String(attempt.attempt_status || '')
        .trim()
        .toLowerCase();
      if (prior === 'passed' || prior === 'failed') {
        return errResult(409, 'already_complete', 'This Testing attempt is already complete.');
      }
      await client.query(
        `UPDATE test_attempts
         SET result = $1,
             attempt_status = $2,
             failure_note = $3,
             completed_at = $4::timestamptz,
             machine_id = COALESCE($5, machine_id),
             tester_user_id = COALESCE($6, tester_user_id),
             tester_user_name = COALESCE($7, tester_user_name)
         WHERE id = $8`,
        [
          result,
          result === 'PASS' ? 'passed' : 'failed',
          result === 'FAIL' ? note : null,
          ts,
          mid,
          user.id != null ? Number(user.id) : null,
          user.name || user.username || null,
          attemptId,
        ]
      );
      if (result === 'PASS') {
        await client.query(
          `UPDATE tanks
           SET status = $1,
               testing_completed_at = COALESCE(testing_completed_at, $2::timestamptz),
               updated_at = $2::timestamptz
           WHERE id = $3`,
          [ASSEMBLY_STATUSES.READY_FOR_DOME_INSTALL, ts, tankId]
        );
      } else {
        await client.query(
          `UPDATE tanks
           SET status = $1,
               updated_at = $2::timestamptz
           WHERE id = $3`,
          [ASSEMBLY_STATUSES.TESTING_FAILED, ts, tankId]
        );
      }
      return okResult({
        action: 'testing_complete',
        attempt_id: attemptId,
        result,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message:
          result === 'PASS'
            ? 'Testing PASS — ready for Dome Install.'
            : 'Testing FAIL — tank moved to FAILED / HOLD. Retest or Send Back to FAB Rework.',
      });
    });
  }

  /** From testing_failed → new TESTING attempt (history preserved). Not FAB. */
  async function retestTesting(machine, opts = {}) {
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status !== ASSEMBLY_STATUSES.TESTING_FAILED) {
        return errResult(409, 'tank_status', `RETEST requires Testing Failed / Hold (got "${status}").`);
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      await client.query(
        `UPDATE tanks
         SET status = $1,
             testing_machine_id = COALESCE($2, testing_machine_id),
             updated_at = $3::timestamptz
         WHERE id = $4`,
        [
          ASSEMBLY_STATUSES.TESTING_IN_PROGRESS,
          Number(machine && machine.id) > 0 ? Number(machine.id) : null,
          ts,
          tankId,
        ]
      );
      const attemptId = await ensureOpenTestingAttempt(
        tankId,
        machine,
        user,
        client,
        ASSEMBLY_STATUSES.TESTING_FAILED
      );
      return okResult({
        action: 'testing_retest',
        attempt_id: attemptId,
        tank: await enrichTankSummaryWithTestingFailure(
          mapTankSummary(await getTankById(tankId, client)),
          client
        ),
        message: 'Retest started — new Testing attempt. Previous FAIL history preserved.',
      });
    });
  }

  /**
   * SEND BACK TO FAB REWORK — reuses existing rework_required FAB workflow.
   * FAB Tank Complete after rework returns tank to ready_for_testing (existing phase1 logic).
   */
  async function sendTestingFailToFabRework(machine, opts = {}) {
    const tankId = Number(opts.tankId != null ? opts.tankId : opts.tank_id);
    if (!Number.isInteger(tankId) || tankId <= 0) {
      return errResult(400, 'validation', 'tankId is required.');
    }
    return withTransaction(async (client) => {
      const tank = await getTankById(tankId, client);
      if (!tank || tank.deleted_at) {
        return errResult(404, 'tank_not_found', 'Tank not found.');
      }
      const status = normalizeAssemblyTankStatus(tank.status);
      if (status !== ASSEMBLY_STATUSES.TESTING_FAILED) {
        return errResult(
          409,
          'tank_status',
          `Send Back to FAB Rework requires Testing Failed / Hold (got "${status}").`
        );
      }
      const ts = opts.at || nowIso();
      const user = opts.user || {};
      const reason = String(opts.reason || opts.note || opts.failure_note || '').trim();
      let failNote = reason;
      if (!failNote) {
        const ctx = await getTestingFailureContext(tankId, client);
        failNote =
          (ctx.latest_failed_testing && ctx.latest_failed_testing.failure_note) ||
          'Testing FAIL — sent to FAB rework';
      }

      // Reuse existing FAB rework_required state (same path FAB kiosks already honor).
      await client.query(
        `UPDATE tanks
         SET status = 'rework_required',
             testing_machine_id = NULL,
             testing_confirmed_at = NULL,
             requires_test = TRUE,
             completed_at = NULL,
             updated_at = $1::timestamptz
         WHERE id = $2`,
        [ts, tankId]
      );

      try {
        await client.query(
          `INSERT INTO tank_admin_phase2_audit
             (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, next_status, details)
           VALUES ('testing_fail_to_fab_rework',$1,$2,$3,$4::timestamptz,$5,'testing_failed','rework_required',$6::jsonb)`,
          [
            tankId,
            tank.tank_number,
            user.name || user.username || 'qa_kiosk',
            ts,
            failNote.slice(0, 4000),
            JSON.stringify({
              source: 'testing_fail',
              machine_id: machine && machine.id != null ? Number(machine.id) : null,
            }),
          ]
        );
      } catch (_err) {
        /* audit table optional until migrate */
      }

      if (Number(machine && machine.id) > 0) {
        try {
          await client.query(
            `UPDATE machines SET active_tank_id = NULL, updated_at = $1::timestamptz
             WHERE id = $2 AND active_tank_id = $3`,
            [ts, Number(machine.id), tankId]
          );
        } catch (_err) {
          /* ignore */
        }
      }

      return okResult({
        action: 'send_to_fab_rework',
        tank: mapTankSummary(await getTankById(tankId, client)),
        message:
          'Tank sent to existing FAB Rework Required workflow. Scan on a Winding kiosk, correct, then Tank Complete to return to Testing.',
        rework_reason: failNote,
      });
    });
  }

