'use strict';

/**
 * Generate FGT employee badge PDFs from the database.
 * Usage:
 *   node scripts/print-employee-badges.js
 *   node scripts/print-employee-badges.js --active
 *   node scripts/print-employee-badges.js --id 1
 *   node scripts/print-employee-badges.js --out badges.pdf
 */

require('./load-env');

const fs = require('fs');
const path = require('path');
const { pool, closePool } = require('./db');
const { buildEmployeeBadgesPdfBuffer } = require('./employee-badge-pdf');

async function main() {
  const args = process.argv.slice(2);
  let outPath = path.join(process.cwd(), 'fgt-employee-badges.pdf');
  let activeOnly = false;
  let id = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      outPath = path.resolve(args[++i]);
    } else if (args[i] === '--active') {
      activeOnly = true;
    } else if (args[i] === '--id' && args[i + 1]) {
      id = Number(args[++i]);
    }
  }

  let rows;
  if (Number.isInteger(id) && id > 0) {
    const r = await pool.query(
      `SELECT code, name, badge_role FROM employees WHERE id = $1`,
      [id]
    );
    rows = r.rows;
  } else if (activeOnly) {
    const r = await pool.query(
      `SELECT code, name, badge_role FROM employees WHERE is_active = 1 ORDER BY LOWER(name) ASC`
    );
    rows = r.rows;
  } else {
    const r = await pool.query(`SELECT code, name, badge_role FROM employees ORDER BY LOWER(name) ASC`);
    rows = r.rows;
  }

  if (!rows.length) {
    console.error('No employees found.');
    process.exitCode = 1;
    return;
  }

  const employees = rows.map((e) => ({
    name: e.name,
    code: e.code,
    badge_role:
      e.badge_role != null && e.badge_role !== undefined ? String(e.badge_role).trim() : '',
  }));
  const buf = await buildEmployeeBadgesPdfBuffer(employees);
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${rows.length} badge(s) to ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
