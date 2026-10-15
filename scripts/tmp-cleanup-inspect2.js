'use strict';

/** READ-ONLY: columns per table + per-entity reference summary. Refuses Neon. */

require('./load-env');
const fs = require('fs');
const path = require('path');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');

async function q(sql, params) {
  return (await pool.query(sql, params)).rows;
}

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon.');
  const out = {};

  const cols = await q(
    `SELECT table_name, string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS cols
     FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name ORDER BY table_name`
  );
  out.columns = Object.fromEntries(cols.map((r) => [r.table_name, r.cols]));

  out.tank_refs = await q(`
    SELECT t.id, t.tank_number, t.status,
      (SELECT string_agg(DISTINCT ms.machine_id::text, ',') FROM machine_sessions ms WHERE ms.tank_id=t.id) AS ms_machines,
      (SELECT COUNT(*) FROM machine_sessions ms WHERE ms.tank_id=t.id)::int AS machine_sessions,
      (SELECT COUNT(*) FROM stage_labor_sessions s WHERE s.tank_id=t.id)::int AS labor_sessions,
      (SELECT string_agg(DISTINCT s.machine_id::text, ',') FROM stage_labor_sessions s WHERE s.tank_id=t.id) AS labor_machines,
      (SELECT COUNT(*) FROM test_attempts a WHERE a.tank_id=t.id)::int AS test_attempts,
      (SELECT COUNT(*) FROM tank_pieces p WHERE p.tank_id=t.id)::int AS pieces,
      (SELECT COUNT(*) FROM part_complete_events e WHERE e.tank_id=t.id)::int AS part_events,
      (SELECT COUNT(*) FROM job_finish_events e WHERE e.tank_id=t.id)::int AS job_finish,
      (SELECT COUNT(*) FROM alert_events e WHERE e.tank_id=t.id)::int AS alerts,
      (SELECT COUNT(*) FROM production_notes e WHERE e.tank_id=t.id)::int AS notes,
      (SELECT COUNT(*) FROM tank_admin_audit e WHERE e.tank_id=t.id)::int AS admin_audit,
      (SELECT COUNT(*) FROM tank_admin_phase2_audit e WHERE e.tank_id=t.id)::int AS p2_audit,
      (SELECT string_agg(DISTINCT stm.employee_id::text, ',')
         FROM machine_sessions ms JOIN session_team_members stm ON stm.session_id=ms.id WHERE ms.tank_id=t.id) AS winding_employees,
      (SELECT string_agg(DISTINCT sp.employee_id::text, ',')
         FROM stage_labor_sessions s JOIN stage_labor_participants sp ON sp.session_id=s.id WHERE s.tank_id=t.id) AS labor_employees
    FROM tanks t ORDER BY t.id`);

  out.machine_refs = await q(`
    SELECT m.id, m.name,
      (SELECT COUNT(*) FROM machine_sessions x WHERE x.machine_id=m.id)::int AS machine_sessions,
      (SELECT COUNT(*) FROM stage_labor_sessions x WHERE x.machine_id=m.id)::int AS labor_sessions,
      (SELECT COUNT(*) FROM test_attempts x WHERE x.machine_id=m.id)::int AS test_attempts,
      (SELECT COUNT(*) FROM assembly_kiosk_teams x WHERE x.machine_id=m.id)::int AS kiosk_teams,
      (SELECT COUNT(*) FROM alert_events x WHERE x.machine_id=m.id)::int AS alerts,
      (SELECT COUNT(*) FROM downtime_intervals x WHERE x.machine_id=m.id)::int AS downtime,
      (SELECT COUNT(*) FROM production_notes x WHERE x.machine_id=m.id)::int AS notes,
      (SELECT COUNT(*) FROM tank_pieces x WHERE x.machine_id=m.id)::int AS pieces,
      (SELECT COUNT(*) FROM tanks x WHERE x.wip_machine_id=m.id OR x.assembly_machine_id=m.id
          OR x.testing_machine_id=m.id OR x.qa_machine_id=m.id)::int AS tank_links
    FROM machines m ORDER BY m.id`);

  out.team_refs = await q(`
    SELECT t.id, t.name,
      (SELECT COUNT(*) FROM machine_sessions x WHERE x.team_id=t.id)::int AS machine_sessions,
      (SELECT COUNT(*) FROM stage_labor_sessions x WHERE x.team_id=t.id)::int AS labor_sessions,
      (SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id)::int AS team_members,
      (SELECT COUNT(*) FROM employee_team_memberships x WHERE x.team_id=t.id)::int AS memberships,
      (SELECT COUNT(*) FROM assembly_kiosk_teams x WHERE x.team_id=t.id)::int AS kiosk_teams,
      (SELECT string_agg(x.id::text, ',') FROM machines x WHERE x.assigned_team_id=t.id) AS assigned_to_machines
    FROM teams t ORDER BY t.id`);

  out.employee_refs = await q(`
    SELECT e.id, e.code, e.name,
      (SELECT COUNT(*) FROM scan_logs x WHERE x.employee_id=e.id)::int AS scans,
      (SELECT COUNT(*) FROM session_team_members x WHERE x.employee_id=e.id)::int AS session_members,
      (SELECT COUNT(*) FROM stage_labor_participants x WHERE x.employee_id=e.id)::int AS labor_participants,
      (SELECT COUNT(*) FROM employee_team_memberships x WHERE x.employee_id=e.id)::int AS memberships,
      (SELECT COUNT(*) FROM team_members x WHERE x.employee_id=e.id)::int AS team_members
    FROM employees e ORDER BY e.id`);

  out.team_members = await q(`SELECT * FROM team_members ORDER BY id`);
  out.memberships = await q(`SELECT * FROM employee_team_memberships ORDER BY id`);
  out.assembly_kiosk_teams = await q(`SELECT * FROM assembly_kiosk_teams ORDER BY machine_id`);
  out.alert_email_recipients = await q(`SELECT * FROM alert_email_recipients`);
  out.kiosk_sync_events_sample = await q(`SELECT * FROM kiosk_sync_events ORDER BY id LIMIT 20`);
  out.scan_logs_by_machine = await q(`SELECT * FROM scan_logs ORDER BY id DESC LIMIT 5`);
  out.production_notes = await q(`SELECT * FROM production_notes`);
  out.machine_session_edits = await q(`SELECT * FROM machine_session_edits`);
  out.alert_events = await q(`SELECT id, machine_id, tank_id, team_id, session_id, alert_type, created_at FROM alert_events ORDER BY id`).catch(
    async () => q(`SELECT * FROM alert_events ORDER BY id`)
  );

  const file = path.join(__dirname, 'tmp-cleanup-inspect2-out.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    try {
      await closePool();
    } catch (_e) {}
    process.exit(1);
  });
