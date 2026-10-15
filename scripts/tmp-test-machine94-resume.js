'use strict';
/** Recover stuck lunch cards on machine 94 (local only) and verify Resume. */
require('./load-env');
const { isNeonUrl } = require('./db-config');
const { pool, closePool } = require('./db');
const { createPhase2AssemblyTesting } = require('./phase2-assembly-testing');

async function main() {
  if (isNeonUrl(process.env.DATABASE_URL)) throw new Error('Refusing Neon');
  const phase2 = createPhase2AssemblyTesting(pool, {
    localDateString: () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
  });

  const machine = { id: 94 };
  const { rows: lunchCards } = await pool.query(
    `SELECT team_id, status FROM assembly_kiosk_teams
     WHERE machine_id = 94 AND left_at IS NULL AND LOWER(status) = 'lunch'`
  );
  console.log('stuck lunch cards', lunchCards);

  for (const card of lunchCards) {
    const teamId = Number(card.team_id);
    const result = await phase2.resumeStationLabor(machine, { team_id: teamId });
    console.log('resume team', teamId, JSON.stringify(result.body || result, null, 2));
    if (!result.ok) throw new Error(result.body && result.body.message);
  }

  const { rows: after } = await pool.query(
    `SELECT team_id, status FROM assembly_kiosk_teams
     WHERE machine_id = 94 AND left_at IS NULL`
  );
  console.log('cards after resume', after);
  console.log('PASS machine 94 lunch card resume recovery');
}

main()
  .catch((e) => {
    console.error('FAIL', e && e.message ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
