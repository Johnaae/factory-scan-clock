'use strict';

require('./load-env');

function isTruthy(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isInternalLanMode() {
  return isTruthy(process.env.INTERNAL_LAN_MODE);
}

function parseDatabaseUrl(url) {
  const s = String(url || '').trim();
  if (!s) return { host: '', port: '', database: '', user: '' };
  try {
    const u = new URL(s);
    return {
      host: u.hostname || '',
      port: u.port || '5432',
      database: (u.pathname || '').replace(/^\//, ''),
      user: u.username || '',
    };
  } catch {
    return { host: 'unknown', port: '', database: '', user: '' };
  }
}

function isNeonHost(host) {
  const h = String(host || '').toLowerCase();
  return h.includes('neon.tech') || h.includes('.neon.') || h.endsWith('.neon.tech');
}

function isNeonUrl(url) {
  return isNeonHost(parseDatabaseUrl(url).host);
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Sanitized label for logs (no password). */
function getDbHostLabel(url) {
  const { host } = parseDatabaseUrl(url || process.env.DATABASE_URL);
  if (!host || host === 'unknown') return 'unknown';
  if (isLocalHost(host)) return 'localhost';
  if (isNeonHost(host)) return 'Neon';
  return host;
}

function validateDatabaseConfig() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL missing');
    process.exit(1);
  }
  if (isInternalLanMode() && isNeonUrl(process.env.DATABASE_URL)) {
    console.error('');
    console.error('❌ DATABASE_URL points to Neon/cloud while INTERNAL_LAN_MODE=true.');
    console.error('   Use a local PostgreSQL URL for LAN testing, for example:');
    console.error('   DATABASE_URL=postgresql://postgres:password@localhost:5432/factory_scan_clock');
    console.error('');
    console.error('   Copy .env.local.example → .env.local and update credentials.');
    console.error('');
    process.exit(1);
  }
}

function getPoolSslConfig() {
  if (isInternalLanMode()) {
    return false;
  }
  const url = process.env.DATABASE_URL;
  if (isNeonUrl(url)) {
    return { rejectUnauthorized: false };
  }
  if (process.env.VERCEL || String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return { rejectUnauthorized: false };
  }
  if (/sslmode=require/i.test(String(url || ''))) {
    return { rejectUnauthorized: false };
  }
  if (isLocalHost(parseDatabaseUrl(url).host)) {
    return false;
  }
  return undefined;
}

function createPoolOptions() {
  const opts = {
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) > 0 ? Number(process.env.PG_POOL_MAX) : 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  };
  const ssl = getPoolSslConfig();
  if (ssl !== undefined) {
    opts.ssl = ssl;
  }
  return opts;
}

function formatDbError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|password authentication failed|Connection terminated/i.test(msg)) {
    return `Database connection failed. Check DATABASE_URL and PostgreSQL service.\nDetails: ${msg}`;
  }
  return msg;
}

function isRetryableDbError(err) {
  const msg = err && err.message ? err.message : String(err);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection terminated|timeout expired|server closed the connection/i.test(
    msg
  );
}

/**
 * Retry transient connection failures (e.g. local Postgres still starting).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, delayMs?: number, label?: string }} [options]
 */
async function withDbRetry(fn, options) {
  const maxAttempts = options && options.maxAttempts ? options.maxAttempts : 5;
  const baseDelay = options && options.delayMs ? options.delayMs : 2000;
  const label = options && options.label ? options.label : 'db';
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err) || attempt >= maxAttempts) break;
      console.warn(
        `[${label}] attempt ${attempt}/${maxAttempts} failed (${err.message}). Retrying in ${baseDelay * attempt}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, baseDelay * attempt));
    }
  }
  const formatted = formatDbError(lastErr);
  const wrapped = new Error(formatted);
  wrapped.cause = lastErr;
  throw wrapped;
}

function logDatabaseBootInfo() {
  validateDatabaseConfig();
  const parsed = parseDatabaseUrl(process.env.DATABASE_URL);
  const label = getDbHostLabel();
  console.log(`DB host: ${label}`);
  if (parsed.database) console.log(`DB name: ${parsed.database}`);
  if (isInternalLanMode()) {
    console.log('[db] INTERNAL_LAN_MODE=true — local PostgreSQL, SSL off');
  } else if (process.env.VERCEL) {
    console.log('[db] Vercel/cloud mode — SSL enabled when required');
  }
}

module.exports = {
  isInternalLanMode,
  isNeonUrl,
  isLocalHost,
  getDbHostLabel,
  parseDatabaseUrl,
  validateDatabaseConfig,
  createPoolOptions,
  formatDbError,
  withDbRetry,
  logDatabaseBootInfo,
};
