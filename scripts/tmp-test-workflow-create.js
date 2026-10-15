'use strict';

/**
 * Local regression: Manage Machines create persists winding / assembly_testing / qa_testing.
 * Refuses Neon. Does not repair older bad rows.
 */

require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const {
  mapMachineForClient,
  parseMachineWorkflow,
  MACHINE_WORKFLOWS,
  slugFromMachineName,
} = require('./phase1-production-logic');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function insertViaCreatePath(name, workflowRaw) {
  const workflow = parseMachineWorkflow(workflowRaw, { allowDefault: false });
  assert(workflow, `parse failed for ${workflowRaw}`);
  const slugBase = slugFromMachineName(name);
  let slug = slugBase;
  const dup = await pool.query(`SELECT id FROM machines WHERE LOWER(TRIM(kiosk_slug)) = $1 LIMIT 1`, [slug]);
  if (dup.rows.length) slug = `${slug}-${Date.now()}`;
  const sortRes = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM machines`);
  const sortOrder = sortRes.rows[0] ? Number(sortRes.rows[0].next_sort) : 1;
  const ts = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, workflow, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,$7,$7) RETURNING *`,
    [name, slug, null, slug, sortOrder, workflow, ts]
  );
  return rows[0];
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) {
    throw new Error('Refusing to run against Neon. Set local DATABASE_URL.');
  }

  assert(parseMachineWorkflow('qa_testing', { allowDefault: false }) === 'qa_testing', 'qa_testing parse');
  assert(parseMachineWorkflow('assembly_testing', { allowDefault: false }) === 'assembly_testing', 'assembly parse');
  assert(parseMachineWorkflow('winding', { allowDefault: false }) === 'winding', 'winding parse');
  assert(parseMachineWorkflow('nope', { allowDefault: false }) === null, 'invalid must be null');
  assert(parseMachineWorkflow(undefined, { allowDefault: true }) === 'winding', 'default winding');

  // Simulate old buggy create path (what running Sep-14 server did)
  const oldBug = (raw) => {
    const workflowRaw = String(raw || 'winding')
      .trim()
      .toLowerCase();
    return workflowRaw === 'assembly_testing' ? 'assembly_testing' : 'winding';
  };
  assert(oldBug('qa_testing') === 'winding', 'document old bug: qa_testing collapsed to winding');

  const suffix = String(Date.now()).slice(-6);
  const fab = await insertViaCreatePath(`TEST FAB ${suffix}`, MACHINE_WORKFLOWS.WINDING);
  const asm = await insertViaCreatePath(`TEST ASSEMBLY ${suffix}`, MACHINE_WORKFLOWS.ASSEMBLY_TESTING);
  const qa = await insertViaCreatePath(`TEST QAQC ${suffix}`, MACHINE_WORKFLOWS.QA_TESTING);

  const { rows } = await pool.query(
    `SELECT id, name, workflow, kiosk_slug FROM machines WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [[fab.id, asm.id, qa.id]]
  );
  assert(rows.length === 3, 'expected 3 rows');
  assert(rows[0].workflow === 'winding', `FAB got ${rows[0].workflow}`);
  assert(rows[1].workflow === 'assembly_testing', `ASM got ${rows[1].workflow}`);
  assert(rows[2].workflow === 'qa_testing', `QA got ${rows[2].workflow}`);

  const mapped = rows.map(mapMachineForClient);
  assert(mapped[0].workflow_label === 'Winding (FAB)', mapped[0].workflow_label);
  assert(mapped[1].workflow_label === 'Assembly + Testing', mapped[1].workflow_label);
  assert(mapped[2].workflow_label === 'QA/QC', mapped[2].workflow_label);
  assert(mapped[2].kiosk_url === `/kiosk/machine/${rows[2].kiosk_slug}`, 'qa kiosk url');

  // Reload persistence check
  const reload = await pool.query(`SELECT workflow FROM machines WHERE id = $1`, [qa.id]);
  assert(reload.rows[0].workflow === 'qa_testing', 'QA workflow still qa_testing after reload query');

  console.log('PASS manage-machines workflow persistence');
  console.log(
    JSON.stringify(
      {
        fab: { id: Number(fab.id), workflow: rows[0].workflow, slug: rows[0].kiosk_slug },
        assembly: { id: Number(asm.id), workflow: rows[1].workflow, slug: rows[1].kiosk_slug },
        qaqc: { id: Number(qa.id), workflow: rows[2].workflow, slug: rows[2].kiosk_slug },
        old_bug_demo: oldBug('qa_testing'),
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
