'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execSync } = require('child_process');
const { parseDatabaseUrl, isNeonUrl, isLocalHost, isInternalLanMode } = require('./db-config');
const {
  BACKUPS_DIR,
  parseDbCredentials,
  getLatestBackup,
  listPgBackups,
  resolveBackupDownload,
} = require('./pg-backup');

function resolvePgRestorePath() {
  const explicit = String(process.env.PG_RESTORE_PATH || '').trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      return { path: explicit, error: `PG_RESTORE_PATH not found: ${explicit}` };
    }
    return { path: explicit };
  }

  const dumpPath = String(process.env.PG_DUMP_PATH || '').trim();
  if (dumpPath) {
    const derived = dumpPath.replace(/pg_dump(\.exe)?$/i, 'pg_restore$1');
    if (fs.existsSync(derived)) {
      return { path: derived };
    }
  }

  for (let major = 18; major >= 12; major -= 1) {
    const candidate = `C:\\Program Files\\PostgreSQL\\${major}\\bin\\pg_restore.exe`;
    if (fs.existsSync(candidate)) {
      return { path: candidate };
    }
  }

  try {
    const out = execSync('where pg_restore', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/).find((line) => line.trim());
    if (first && fs.existsSync(first.trim())) {
      return { path: first.trim() };
    }
  } catch {
    // not on PATH
  }

  return {
    path: '',
    error:
      'pg_restore not found. Set PG_RESTORE_PATH in .env (e.g. C:\\Program Files\\PostgreSQL\\16\\bin\\pg_restore.exe) or set PG_DUMP_PATH to the matching pg_dump.exe path.',
  };
}

function validateRestoreConfig() {
  const errors = [];
  const creds = parseDbCredentials();
  if (creds.error) {
    errors.push(creds.error);
  }

  const pgRestore = resolvePgRestorePath();
  if (pgRestore.error) {
    errors.push(pgRestore.error);
  }

  return {
    ok: errors.length === 0,
    errors,
    creds: creds.error ? null : creds,
    pgRestorePath: pgRestore.error ? '' : pgRestore.path,
  };
}

function getRestoreTargetInfo() {
  const creds = parseDbCredentials();
  const { host } = parseDatabaseUrl(process.env.DATABASE_URL);
  const localLan = isInternalLanMode();
  const localHost = isLocalHost(host);
  const neon = isNeonUrl(process.env.DATABASE_URL);
  const isProduction = neon || (!localHost && !localLan);

  return {
    host: host || 'unknown',
    database: creds.error ? '' : creds.database,
    isProduction,
    environmentLabel: isProduction ? 'PRODUCTION / REMOTE' : 'LOCAL',
  };
}

function resolveBackupFile(options) {
  if (options.file) {
    const resolved = resolveBackupDownload(options.file);
    if (resolved.error) {
      return { error: resolved.error };
    }
    return { backup: { filename: resolved.filename, path: resolved.path } };
  }

  const latest = getLatestBackup();
  if (!latest) {
    return {
      error: `No PostgreSQL backup files found in ${BACKUPS_DIR}. Create one first (System page or npm run backup:pg).`,
    };
  }
  return { backup: latest };
}

function promptLine(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function confirmRestore(target, backup) {
  console.log('');
  console.log('============================================================');
  console.log('  RESTORE CONFIRMATION REQUIRED');
  console.log('============================================================');
  console.log(`  Environment : ${target.environmentLabel}`);
  console.log(`  Host        : ${target.host}`);
  console.log(`  Database    : ${target.database}`);
  console.log(`  Backup file : ${backup.filename}`);
  console.log(`  Backup path : ${backup.path}`);
  console.log('');
  console.log('  WARNING: This will DROP and recreate database objects');
  console.log('  from the backup. Existing data in the target database');
  console.log('  will be overwritten.');
  console.log('');

  if (target.isProduction) {
    console.log('  *** PRODUCTION DATABASE ***');
    console.log(`  Type the database name exactly to continue: ${target.database}`);
    console.log('');
    const answer = String(await promptLine('Confirm database name: ')).trim();
    if (answer !== target.database) {
      return { confirmed: false, message: 'Restore cancelled — database name did not match.' };
    }
    return { confirmed: true };
  }

  console.log('  Type YES to restore to this database.');
  console.log('');
  const answer = String(await promptLine('Confirm (YES): ')).trim();
  if (answer.toUpperCase() !== 'YES') {
    return { confirmed: false, message: 'Restore cancelled — confirmation was not YES.' };
  }
  return { confirmed: true };
}

function runPgRestore(pgRestorePath, creds, backupPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-h',
      creds.host,
      '-p',
      creds.port,
      '-U',
      creds.user,
      '-d',
      creds.database,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--verbose',
      backupPath,
    ];
    const env = {
      ...process.env,
      PGPASSWORD: creds.password,
    };
    if (isNeonUrl(process.env.DATABASE_URL)) {
      env.PGSSLMODE = env.PGSSLMODE || 'require';
    }

    const child = spawn(pgRestorePath, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run pg_restore: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `pg_restore exited with code ${code}`;
      reject(new Error(detail));
    });
  });
}

async function restorePgDatabase(options) {
  if (process.platform !== 'win32') {
    throw new Error('This restore script is Windows-only.');
  }

  const validation = validateRestoreConfig();
  if (!validation.ok) {
    const err = new Error(validation.errors.join(' '));
    err.code = 'restore_config';
    err.details = validation.errors;
    throw err;
  }

  const backupResult = resolveBackupFile(options);
  if (backupResult.error) {
    const err = new Error(backupResult.error);
    err.code = 'backup_not_found';
    throw err;
  }

  const target = getRestoreTargetInfo();
  const backup = backupResult.backup;

  if (options.interactive && !options.yes) {
    const confirmation = await confirmRestore(target, backup);
    if (!confirmation.confirmed) {
      const err = new Error(confirmation.message || 'Restore cancelled.');
      err.code = 'cancelled';
      throw err;
    }
  } else if (!options.yes) {
    const err = new Error('Restore requires confirmation. Run restore_database.bat or use --interactive.');
    err.code = 'confirmation_required';
    throw err;
  }

  console.log('');
  console.log(`[pg-restore] Restoring ${backup.filename} to ${target.database} on ${target.host}...`);
  console.log('');

  await runPgRestore(validation.pgRestorePath, validation.creds, backup.path);

  return {
    filename: backup.filename,
    database: target.database,
    host: target.host,
    path: backup.path,
  };
}

function printUsage() {
  console.log('Usage: node scripts/pg-restore.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --latest         Restore the newest .backup file (default)');
  console.log('  --file <name>    Restore a specific backup filename');
  console.log('  --interactive    Prompt for confirmation before restore');
  console.log('  --list           List available .backup files and exit');
  console.log('');
  console.log('Windows: use restore_database.bat in the project root.');
}

function parseArgs(argv) {
  const options = {
    latest: true,
    file: '',
    interactive: false,
    yes: false,
    list: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--latest') {
      options.latest = true;
    } else if (arg === '--file') {
      options.file = argv[i + 1] || '';
      options.latest = false;
      i += 1;
    } else if (arg === '--interactive') {
      options.interactive = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

if (require.main === module) {
  require('./load-env');

  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    const backups = listPgBackups();
    if (!backups.length) {
      console.log(`No .backup files in ${BACKUPS_DIR}`);
      process.exit(0);
    }
    console.log(`Backups in ${BACKUPS_DIR}:`);
    backups.forEach((b, index) => {
      const tag = index === 0 ? ' (latest)' : '';
      console.log(`  ${b.filename}${tag}`);
    });
    process.exit(0);
  }

  restorePgDatabase(options)
    .then((result) => {
      console.log('');
      console.log(`[pg-restore] SUCCESS — restored ${result.filename} to ${result.database} (${result.host})`);
    })
    .catch((err) => {
      if (err && err.code === 'cancelled') {
        console.error(`[pg-restore] ${err.message}`);
        process.exit(2);
      }
      console.error('[pg-restore] FAILED:', err && err.message ? err.message : err);
      process.exit(1);
    });
}

module.exports = {
  validateRestoreConfig,
  getRestoreTargetInfo,
  restorePgDatabase,
  resolvePgRestorePath,
};
