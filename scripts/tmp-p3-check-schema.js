'use strict';
require('./load-env');
const { pool, closePool } = require('./db');
const { PHASE3_DOME_RELATIONS } = require('./phase3-schema-sql');
(async () => {
  const host = await pool.query(`SELECT current_database() AS db, inet_server_addr()::text AS addr`);
  console.log('db', host.rows[0]);
  const { rows } = await pool.query(
    `SELECT relname FROM pg_class WHERE relname = ANY($1) ORDER BY relname`,
    [PHASE3_DOME_RELATIONS]
  );
  console.log('present', rows.length, 'of', PHASE3_DOME_RELATIONS.length);
  const have = new Set(rows.map((r) => r.relname));
  console.log('missing', PHASE3_DOME_RELATIONS.filter((n) => !have.has(n)));
  const counts = await pool.query(
    `SELECT (SELECT COUNT(*) FROM domes)::int AS domes, (SELECT COUNT(*) FROM dome_installations)::int AS installs`
  ).catch((e) => ({ rows: [{ err: e.message }] }));
  console.log('counts', counts.rows[0]);
})()
  .catch((e) => console.error(e.message))
  .finally(() => closePool());
