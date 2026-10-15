'use strict';

/** One-shot generic repair: restore rework_required wiped by End Shift. */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { createPoolOptions } = require('./db-config');
const pg = require('pg');
const { createPhase1ProductionLogic } = require('./phase1-production-logic');

const pool = new pg.Pool(createPoolOptions());
const phase1 = createPhase1ProductionLogic({
  pool,
  nowIso: () => new Date().toISOString(),
  normalizeTankNumber: (v) => String(v || '').trim().toUpperCase(),
  normalizeTankStatus: (raw) => {
    const s = String(raw == null || raw === '' ? 'waiting' : raw)
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (s === 'rework_required' || s === 'returned_to_fab' || s === 'fab_rework') return 'rework_required';
    if (s === 'paused') return 'paused';
    return s || 'active';
  },
  startEndOfLocalDay: () => ({ start: new Date(), end: new Date() }),
  localDateString: () => '2026-09-14',
  weekBoundsLocal: () => ({ start: new Date(), end: new Date() }),
  validateTankExists: async () => null,
});

(async () => {
  const rows = await phase1.repairEndShiftClearedRework(pool);
  console.log(
    'Repaired tanks:',
    rows.map((r) => ({ id: r.id, tank_number: r.tank_number, status: r.status }))
  );
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (_e) {
    /* ignore */
  }
  process.exit(1);
});
