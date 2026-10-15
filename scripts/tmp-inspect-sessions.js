'use strict';

/** READ-ONLY: summarize express-session rows (no secrets printed). */

require('./load-env');
const { pool, closePool } = require('./db');

async function main() {
  console.log('NODE_ENV=', process.env.NODE_ENV || '(unset)', ' VERCEL=', process.env.VERCEL || '(unset)', ' SESSION_SECRET set=', Boolean(process.env.SESSION_SECRET));
  const { rows } = await pool.query(`SELECT sid, sess, expire FROM session ORDER BY expire DESC`);
  for (const r of rows) {
    const s = r.sess || {};
    console.log(
      JSON.stringify({
        sid: String(r.sid).slice(0, 6) + '…',
        expire: r.expire,
        cookie_expires: s.cookie && s.cookie.expires,
        manager_user: s.manager_user ? `${s.manager_user.username}/${s.manager_user.role}` : null,
        kiosk_user: s.kiosk_user ? `${s.kiosk_user.username}/${s.kiosk_user.role}` : null,
        machine_kiosk: s.machine_kiosk ? `${s.machine_kiosk.machine_name}/${s.machine_kiosk.workflow}` : null,
        keys: Object.keys(s).filter((k) => k !== 'cookie'),
      })
    );
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    await closePool();
    process.exit(1);
  });
