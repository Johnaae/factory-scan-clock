'use strict';

const d = require('./tmp-cleanup-inspect2-out.json');

const line = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== 0 && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

console.log('== TANKS');
d.tank_refs.forEach((r) => console.log(line(r)));
console.log('== MACHINES');
d.machine_refs.forEach((r) => console.log(line(r)));
console.log('== TEAMS');
d.team_refs.forEach((r) => console.log(line(r)));
console.log('== EMPLOYEES');
d.employee_refs.forEach((r) => console.log(line(r)));
console.log('== TEAM_MEMBERS');
d.team_members.forEach((r) => console.log(`id=${r.id} team=${r.team_id} emp=${r.employee_id} name=${r.name} active=${r.active}`));
console.log('== MEMBERSHIPS');
d.memberships.forEach((r) => console.log(`id=${r.id} emp=${r.employee_id} team=${r.team_id} left=${r.left_at ? 'y' : 'n'} src=${r.source}`));
console.log('== ASSEMBLY_KIOSK_TEAMS');
d.assembly_kiosk_teams.forEach((r) => console.log(`id=${r.id} machine=${r.machine_id} team=${r.team_id} status=${r.status}`));
console.log('== ALERT RECIPIENTS');
d.alert_email_recipients.forEach((r) => console.log(`id=${r.id} ${r.alert_type} ${r.email}`));
console.log('== KIOSK_SYNC_EVENTS');
d.kiosk_sync_events_sample.forEach((r) =>
  console.log(`id=${r.id} kiosk=${r.kiosk_id} status=${r.status}/${r.sync_status} ${r.created_at} ${JSON.stringify(r.payload).slice(0, 160)}`)
);
console.log('== PRODUCTION_NOTES');
d.production_notes.forEach((r) => console.log(`id=${r.id} tank=${r.tank_id} machine=${r.machine_id} session=${r.session_id} ${r.body}`));
console.log('== MACHINE_SESSION_EDITS');
d.machine_session_edits.forEach((r) => console.log(`id=${r.id} session=${r.session_id} tank=${r.tank_id}`));
console.log('== ALERT_EVENTS');
d.alert_events.forEach((r) => console.log(`id=${r.id} machine=${r.machine_id} tank=${r.tank_id} team=${r.team_id} session=${r.session_id} ${r.alert_type} ${r.created_at}`));
