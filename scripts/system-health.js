'use strict';

const { spawn } = require('child_process');
const { getBackupStatus } = require('./pg-backup');

const PM2_PROCESS_NAME = 'factory-scan-clock';
const PM2_TIMEOUT_MS = 5000;

function toIsoTime(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

async function checkDatabase(pool) {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');
    const serverTime = result.rows[0] && result.rows[0].server_time;
    return {
      status: 'connected',
      message: 'PostgreSQL responding',
      server_time: serverTime,
    };
  } catch (err) {
    return {
      status: 'disconnected',
      message: err && err.message ? err.message : 'Database connection failed',
      server_time: null,
    };
  }
}

async function getDatabaseSize(pool) {
  const result = await pool.query(
    'SELECT pg_size_pretty(pg_database_size(current_database())) AS size'
  );
  return result.rows[0] && result.rows[0].size ? result.rows[0].size : null;
}

function getServerStatus() {
  return {
    ok: true,
    status: 'online',
    message: 'Node.js server is running',
  };
}

function checkPm2Status() {
  return new Promise((resolve) => {
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child) child.kill();
      } catch {
        // ignore kill errors
      }
      resolve(result);
    }

    const timer = setTimeout(() => {
      finish({ status: 'offline', message: 'PM2 status check timed out' });
    }, PM2_TIMEOUT_MS);

    let child;
    const args = ['jlist'];
    const options = {
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    child = spawn('pm2', args, options);

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', (err) => {
      finish({
        status: 'offline',
        message: err.code === 'ENOENT' ? 'PM2 not installed or not on PATH' : 'Could not query PM2',
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ status: 'offline', message: 'PM2 returned an error' });
        return;
      }
      try {
        const list = JSON.parse(stdout);
        if (!Array.isArray(list)) {
          finish({ status: 'offline', message: 'Invalid PM2 response' });
          return;
        }

        const proc = list.find(
          (entry) =>
            entry &&
            (entry.name === PM2_PROCESS_NAME ||
              (entry.pm2_env && entry.pm2_env.name === PM2_PROCESS_NAME))
        );

        if (proc && proc.pm2_env && proc.pm2_env.status === 'online') {
          finish({
            status: 'online',
            message: `${PM2_PROCESS_NAME} is online`,
          });
          return;
        }

        if (proc) {
          const pmStatus = proc.pm2_env && proc.pm2_env.status ? proc.pm2_env.status : 'unknown';
          finish({
            status: 'offline',
            message: `${PM2_PROCESS_NAME} status: ${pmStatus}`,
          });
          return;
        }

        finish({
          status: 'offline',
          message: `${PM2_PROCESS_NAME} not found in PM2`,
        });
      } catch {
        finish({ status: 'offline', message: 'Could not parse PM2 response' });
      }
    });
  });
}

async function getSystemHealthSummary(pool, appVersion) {
  const dbCheck = await checkDatabase(pool);

  let databaseSize = null;
  if (dbCheck.status === 'connected') {
    try {
      databaseSize = await getDatabaseSize(pool);
    } catch {
      databaseSize = null;
    }
  }

  const backupInfo = getBackupStatus(appVersion);

  return {
    ok: true,
    server_status: 'online',
    server_message: 'Node.js server is running',
    database_status: dbCheck.status,
    database_message: dbCheck.message,
    app_version: appVersion,
    database_size: databaseSize,
    server_time: toIsoTime(dbCheck.server_time),
    ...backupInfo,
  };
}

module.exports = {
  getServerStatus,
  checkDatabase,
  checkPm2Status,
  getDatabaseSize,
  getSystemHealthSummary,
  toIsoTime,
};
