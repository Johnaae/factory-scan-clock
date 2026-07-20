'use strict';

const fs = require('fs');
const path = require('path');
const { withClient, closePool } = require('./db');

function stamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function run() {
  const isDaily = process.argv.includes('--daily');
  const dir = path.join(process.cwd(), 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const payload = await withClient(async (client) => {
    const employees = await client.query(
      `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at
       FROM employees ORDER BY id ASC`
    );
    const tanks = await client.query(
      `SELECT id, tank_number, description, status, created_at, completed_at, updated_at
       FROM tanks ORDER BY id ASC`
    );
    const scanLogs = await client.query(
      `SELECT id, employee_id, employee_code, employee_name, status, note_category, note_value, tank_number,
              station_name, area_name, kiosk_user, scanned_at
       FROM scan_logs ORDER BY id ASC`
    );
    const usersSafe = await client.query(
      `SELECT id, username, role, station_name, area_name, is_active, created_at, updated_at
       FROM users ORDER BY id ASC`
    );
    const teams = await client.query(
      `SELECT id, name, barcode, active, created_at, updated_at FROM teams ORDER BY id ASC`
    );
    const machines = await client.query(
      `SELECT id, name, code, kiosk_slug, active, created_at, updated_at FROM machines ORDER BY id ASC`
    );
    const machineSessions = await client.query(
      `SELECT id, machine_id, team_id, tank_id, activity_code, activity_name, status,
              started_at, stopped_at, resumed_at, finished_at, stop_reason, notes, created_at, updated_at
       FROM machine_sessions ORDER BY id ASC`
    );
    const teamMembers = await client.query(
      `SELECT tm.id, tm.team_id, tm.name, tm.role, tm.active, tm.created_at, tm.employee_id FROM team_members tm ORDER BY tm.id ASC`
    );
    const alertEvents = await client.query(
      `SELECT id, machine_id, team_id, tank_id, session_id, alert_type, alert_code, status,
              reported_at, resolved_at, resolved_by, notes, created_at
       FROM alert_events ORDER BY id ASC`
    );

    return {
      generated_at: new Date().toISOString(),
      source: 'neon-postgres',
      users: usersSafe.rows,
      employees: employees.rows,
      tanks: tanks.rows,
      scan_logs: scanLogs.rows,
      teams: teams.rows,
      machines: machines.rows,
      machine_sessions: machineSessions.rows,
      team_members: teamMembers.rows,
      alert_events: alertEvents.rows,
    };
  });

  const filename = isDaily ? `backup-daily-${stamp()}.json` : `backup-${stamp()}.json`;
  const outPath = path.join(dir, filename);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[backup] wrote ${outPath}`);
}

run()
  .then(async () => {
    await closePool();
  })
  .catch(async (err) => {
    console.error('[backup] failed:', err && err.message ? err.message : err);
    await closePool();
    process.exit(1);
  });
