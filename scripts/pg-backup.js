'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const { parseDatabaseUrl, isNeonUrl } = require('./db-config');

const BACKUPS_DIR = path.join(process.cwd(), 'backups');
const BACKUP_FILENAME_RE = /^factory_scan_clock_\d{8}_\d{6}\.backup$/;

function backupTimestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function backupFilename() {
  return `factory_scan_clock_${backupTimestamp()}.backup`;
}

function resolvePgDumpPath() {
  const explicit = String(process.env.PG_DUMP_PATH || '').trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      return {
        path: explicit,
        error: `PG_DUMP_PATH not found: ${explicit}`,
      };
    }
    return { path: explicit };
  }

  if (process.platform === 'win32') {
    for (let major = 18; major >= 12; major -= 1) {
      const candidate = `C:\\Program Files\\PostgreSQL\\${major}\\bin\\pg_dump.exe`;
      if (fs.existsSync(candidate)) {
        return { path: candidate };
      }
    }
    try {
      const out = execSync('where pg_dump', {
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
  } else {
    for (const candidate of ['/usr/bin/pg_dump', '/usr/local/bin/pg_dump', '/opt/homebrew/bin/pg_dump']) {
      if (fs.existsSync(candidate)) {
        return { path: candidate };
      }
    }
    try {
      const out = execSync('command -v pg_dump', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: true,
      }).trim();
      if (out && fs.existsSync(out)) {
        return { path: out };
      }
    } catch {
      // not on PATH
    }
  }

  return {
    path: '',
    error:
      'pg_dump not found. Set PG_DUMP_PATH in .env to your pg_dump executable (e.g. C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe on Windows).',
  };
}

function parseDbCredentials() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) {
    return { error: 'DATABASE_URL is not set.' };
  }

  let host;
  let port;
  let database;
  let user;
  let password;

  try {
    const u = new URL(url);
    host = u.hostname || 'localhost';
    port = u.port || '5432';
    database = (u.pathname || '').replace(/^\//, '').split('?')[0];
    user = decodeURIComponent(u.username || '');
    password = decodeURIComponent(u.password || '');
  } catch {
    return { error: 'DATABASE_URL is invalid.' };
  }

  if (!database) {
    return { error: 'Database name is missing in DATABASE_URL.' };
  }
  if (!user) {
    return { error: 'Database username is missing in DATABASE_URL.' };
  }

  const envPassword = String(process.env.PGPASSWORD || '').trim();
  const finalPassword = password || envPassword;
  if (!finalPassword) {
    return {
      error: 'Database password is missing. Add it to DATABASE_URL or set PGPASSWORD in .env.',
    };
  }

  return { host, port, database, user, password: finalPassword };
}

function validateBackupConfig() {
  const errors = [];
  const creds = parseDbCredentials();
  if (creds.error) {
    errors.push(creds.error);
  }

  const pgDump = resolvePgDumpPath();
  if (pgDump.error) {
    errors.push(pgDump.error);
  }

  return {
    ok: errors.length === 0,
    errors,
    creds: creds.error ? null : creds,
    pgDumpPath: pgDump.error ? '' : pgDump.path,
  };
}

function listPgBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => BACKUP_FILENAME_RE.test(name))
    .map((name) => {
      const fullPath = path.join(BACKUPS_DIR, name);
      const stat = fs.statSync(fullPath);
      return {
        filename: name,
        path: fullPath,
        mtime: stat.mtime,
        size_bytes: stat.size,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function getLatestBackup() {
  const backups = listPgBackups();
  return backups.length ? backups[0] : null;
}

function getBackupStatus(appVersion) {
  const latest = getLatestBackup();
  const validation = validateBackupConfig();
  return {
    ok: true,
    app_version: appVersion || 'unknown',
    last_backup_at: latest ? latest.mtime.toISOString() : null,
    latest_backup_file: latest ? latest.filename : null,
    latest_backup_size_bytes: latest ? latest.size_bytes : null,
    backup_count: listPgBackups().length,
    config_ready: validation.ok,
    config_errors: validation.errors,
  };
}

function runPgDump(pgDumpPath, creds, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ['-h', creds.host, '-p', creds.port, '-U', creds.user, '-d', creds.database, '-F', 'c', '-f', outputPath, '--no-password'];
    const env = {
      ...process.env,
      PGPASSWORD: creds.password,
    };
    if (isNeonUrl(process.env.DATABASE_URL)) {
      env.PGSSLMODE = env.PGSSLMODE || 'require';
    }

    const child = spawn(pgDumpPath, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run pg_dump: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() || `pg_dump exited with code ${code}`;
      reject(new Error(detail));
    });
  });
}

async function createPgBackup() {
  const validation = validateBackupConfig();
  if (!validation.ok) {
    const err = new Error(validation.errors.join(' '));
    err.code = 'backup_config';
    err.details = validation.errors;
    throw err;
  }

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const filename = backupFilename();
  const outputPath = path.join(BACKUPS_DIR, filename);

  try {
    await runPgDump(validation.pgDumpPath, validation.creds, outputPath);
  } catch (err) {
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // ignore partial file cleanup failure
      }
    }
    throw err;
  }

  const stat = fs.statSync(outputPath);
  return {
    filename,
    path: outputPath,
    created_at: stat.mtime.toISOString(),
    size_bytes: stat.size,
  };
}

function resolveBackupDownload(filename) {
  const name = path.basename(String(filename || ''));
  if (!BACKUP_FILENAME_RE.test(name)) {
    return { error: 'Invalid backup filename.' };
  }
  const fullPath = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(fullPath)) {
    return { error: 'Backup file not found.' };
  }
  return { filename: name, path: fullPath };
}

/**
 * Delete oldest PostgreSQL .backup files beyond keepCount (newest kept by mtime).
 * Does not touch .json or other files in backups/.
 * @param {number} keepCount
 */
function prunePgBackups(keepCount) {
  const keep = Math.max(1, Number(keepCount) || 30);
  const backups = listPgBackups();
  const toDelete = backups.slice(keep);
  const deleted = [];

  for (const entry of toDelete) {
    fs.unlinkSync(entry.path);
    deleted.push(entry.filename);
  }

  return {
    keep_count: keep,
    total_before: backups.length,
    kept: backups.slice(0, keep).map((b) => b.filename),
    deleted,
    deleted_count: deleted.length,
    remaining: backups.length - deleted.length,
  };
}

module.exports = {
  BACKUPS_DIR,
  BACKUP_FILENAME_RE,
  parseDbCredentials,
  validateBackupConfig,
  getBackupStatus,
  getLatestBackup,
  listPgBackups,
  createPgBackup,
  resolveBackupDownload,
  prunePgBackups,
};

if (require.main === module) {
  require('./load-env');
  createPgBackup()
    .then((result) => {
      console.log(`[pg-backup] wrote ${result.path} (${result.size_bytes} bytes)`);
    })
    .catch((err) => {
      console.error('[pg-backup] failed:', err && err.message ? err.message : err);
      process.exit(1);
    });
}
