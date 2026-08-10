'use strict';

require('./load-env');
const { Pool } = require('pg');
const { createPoolOptions } = require('./db-config');
const { createPhase1ProductionLogic, displayMachineName } = require('./phase1-production-logic');

(async () => {
  const pool = new Pool(createPoolOptions());
  const nowIso = () => new Date().toISOString();
  const normalizeTankNumber = (v) => String(v || '').trim().toUpperCase();
  const normalizeTankStatus = (s) => {
    const x = String(s || 'active').toLowerCase().trim();
    if (x === 'archived' || x === 'completed') return 'archived';
    if (x === 'waiting') return 'waiting';
    if (x === 'paused') return 'paused';
    return 'active';
  };
  const localDateString = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const startEndOfLocalDay = (date) => {
    const [y, m, dd] = String(date).split('-').map(Number);
    const start = new Date(y, m - 1, dd, 0, 0, 0, 0);
    const end = new Date(y, m - 1, dd, 23, 59, 59, 999);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  };
  const weekBoundsLocal = () => startEndOfLocalDay(localDateString());
  const phase1 = createPhase1ProductionLogic({
    pool,
    nowIso,
    normalizeTankNumber,
    ensureTankExists: async () => null,
    normalizeTankStatus,
    startEndOfLocalDay,
    localDateString,
    weekBoundsLocal,
  });

  const open = await pool.query(
    `SELECT m.name, ms.tank_id, tk.tank_number, ms.status, ms.stop_reason, ms.activity_name, m.active_tank_id
     FROM machine_sessions ms
     JOIN machines m ON m.id = ms.machine_id
     JOIN tanks tk ON tk.id = ms.tank_id
     WHERE ms.status IN ('running', 'stopped')
     ORDER BY m.name, tk.tank_number`
  );
  console.log('DB open sessions:', open.rows.length);
  for (const r of open.rows) {
    console.log(
      ' ',
      displayMachineName(r.name),
      'tank',
      r.tank_number,
      r.status,
      r.activity_name,
      'active_tank_id=',
      r.active_tank_id
    );
  }

  const cards = await phase1.buildDashboardCards();
  const expectedMap = {};
  for (const r of open.rows) {
    const n = displayMachineName(r.name);
    expectedMap[n] = expectedMap[n] || [];
    expectedMap[n].push(String(r.tank_number));
  }

  let ok = true;
  for (const [name, tanks] of Object.entries(expectedMap)) {
    const card = cards.find((c) => c.name === name);
    if (!card) {
      console.error('Missing card for', name);
      ok = false;
      continue;
    }
    const got = (card.open_sessions || [])
      .map((s) => String(s.tank_number))
      .sort()
      .join(',');
    const exp = [...new Set(tanks)].sort().join(',');
    if (got !== exp) {
      console.error('MISMATCH', name, 'got', got, 'expected', exp);
      ok = false;
    } else {
      console.log(
        'OK',
        name,
        'shows all [',
        exp,
        '] selected=',
        card.selected_tank_number || '-',
        '(selection does not hide others)'
      );
    }
  }

  for (const c of cards) {
    if (!(c.open_sessions || []).length) continue;
    for (const s of c.open_sessions) {
      if (!s.running_time_display || !s.tank_total_running_time_display) {
        console.error('Missing timers for', c.name, s.tank_number);
        ok = false;
      }
      const summary = s.phase_time_summary || [];
      const codes = summary.map((r) => r.phase_code);
      const required = [
        'PREP_CLEANUP',
        'CHOP',
        'RIB_INSTALL',
        'DOME_INSTALL',
        'WIND',
        'HOT_COAT',
        'LINER',
        'CORRECTIONS',
        'SPACER_GLASS',
      ];
      for (const code of required) {
        if (!codes.includes(code)) {
          console.error('Missing phase', code, 'on tank', s.tank_number);
          ok = false;
        }
      }
      console.log(
        '  Phase summary for tank',
        s.tank_number,
        '→',
        summary
          .filter((r) => r.status !== 'not_started')
          .map((r) => `${r.phase_name}:${r.total_duration_display}:${r.status_label}`)
          .join(' | ') || '(none started)'
      );
    }
  }

  await pool.end();
  if (!ok) process.exit(1);
  console.log('PASS multi-tank manager dashboard payload');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
