'use strict';
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');
const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

async function main() {
  const pool = new Pool(createPoolOptions());
  const nowIso = () => new Date().toISOString();
  const phase2 = createPhase2AssemblyTesting(pool, {
    nowIso,
    normalizeTankNumber: (s) => String(s || '').trim().toUpperCase(),
    localDateString: () => new Date().toISOString().slice(0, 10),
  });

  const tank = (
    await pool.query(`SELECT * FROM tanks WHERE tank_number = $1`, ['9999'])
  ).rows[0];
  if (!tank) {
    console.log('tank 9999 missing');
    await pool.end();
    return;
  }
  console.log('before', {
    status: tank.status,
    testing_machine_id: tank.testing_machine_id,
  });

  // Put tank into testing_in_progress so FAIL is allowed
  await pool.query(
    `UPDATE tanks
     SET status = 'testing_in_progress',
         testing_machine_id = COALESCE(testing_machine_id, $2),
         requires_test = TRUE,
         updated_at = NOW()
     WHERE id = $1`,
    [tank.id, tank.testing_machine_id || 94]
  );

  const machine = (
    await pool.query(`SELECT * FROM machines WHERE id = $1`, [
      Number(tank.testing_machine_id || 94),
    ])
  ).rows[0];

  const result = await phase2.recordTestResult(machine, {
    tank_id: tank.id,
    result: 'FAIL',
    note: 'scripted FAIL→rework_required verification',
  });
  console.log('api', {
    ok: result.ok,
    status: result.status,
    message: result.body && result.body.message,
    tank_status: result.body && result.body.tank && result.body.tank.status,
    error: result.body && result.body.error,
  });

  const after = (
    await pool.query(
      `SELECT status, testing_machine_id, testing_confirmed_at, requires_test FROM tanks WHERE id = $1`,
      [tank.id]
    )
  ).rows[0];
  console.log('after', after);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
