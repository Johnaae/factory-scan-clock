'use strict';

const { BACKUPS_DIR, listPgBackups, prunePgBackups } = require('./pg-backup');

function parseArgs(argv) {
  let keep = 30;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep' && argv[i + 1]) {
      keep = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--dry-run') {
      return { keep, dryRun: true };
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/prune-pg-backups.js [--keep 30] [--dry-run]');
      console.log('');
      console.log('Removes oldest factory_scan_clock_*.backup files beyond the keep count.');
      console.log('JSON backups and other files in backups/ are never deleted.');
      process.exit(0);
    }
  }
  return { keep, dryRun: false };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const backups = listPgBackups();

  if (options.dryRun) {
    const wouldDelete = backups.slice(options.keep);
    console.log(`[prune-pg-backups] dry run — folder: ${BACKUPS_DIR}`);
    console.log(`[prune-pg-backups] would keep ${Math.min(backups.length, options.keep)} of ${backups.length}`);
    wouldDelete.forEach((b) => console.log(`  delete: ${b.filename}`));
    process.exit(0);
  }

  const result = prunePgBackups(options.keep);
  console.log(
    `[prune-pg-backups] kept ${result.remaining} backup(s), deleted ${result.deleted_count} older file(s)`
  );
  result.deleted.forEach((name) => console.log(`  deleted: ${name}`));
}

main();
