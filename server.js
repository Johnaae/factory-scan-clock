'use strict';

require('./scripts/load-env');

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pg = require('pg');
const PgSession = require('connect-pg-simple')(session);
const PDFDocument = require('pdfkit');
const {
  createPoolOptions,
  logDatabaseBootInfo,
  withDbRetry,
  formatDbError,
} = require('./scripts/db-config');
const { buildEmployeeBadgesPdfBuffer } = require('./scripts/employee-badge-pdf');
const {
  getBackupStatus,
  createPgBackup,
  getLatestBackup,
  resolveBackupDownload,
} = require('./scripts/pg-backup');
const { readAppVersion } = require('./scripts/app-version');
const { getSystemHealthSummary, getServerStatus, checkDatabase, checkPm2Status, getDatabaseSize, toIsoTime } = require('./scripts/system-health');

const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();

app.set('trust proxy', 1);

logDatabaseBootInfo();
console.log('App version:', readAppVersion());

if (!process.env.SESSION_SECRET) {
  console.error('❌ SESSION_SECRET missing');
  process.exit(1);
}

const pool = new pg.Pool(createPoolOptions());
pool.on('error', (err) => {
  console.error('[db] pool error:', formatDbError(err));
});

const pgSessionStore = new PgSession({
  pool,
  tableName: 'session',
  createTableIfMissing: true,
});

console.log('Session store: Postgres');
console.log('[boot] session-store:', pgSessionStore && pgSessionStore.constructor ? pgSessionStore.constructor.name : 'missing');
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');

app.use(express.json({ limit: '32kb' }));
app.use(
  session({
    name: 'factory_scan_sid',
    store: pgSessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

/** Same DDL as scripts/migrate.js — Neon Postgres only. */
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('MANAGER','KIOSK')),
  station_name TEXT,
  area_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tanks (
  id BIGSERIAL PRIMARY KEY,
  tank_number TEXT UNIQUE NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scan_logs (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN','OUT','STOP')),
  note TEXT,
  note_category TEXT,
  note_value TEXT,
  tank_number TEXT,
  station_name TEXT,
  area_name TEXT,
  kiosk_user TEXT,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(code);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_tanks_tank_number ON tanks(tank_number);
CREATE INDEX IF NOT EXISTS idx_scan_logs_employee_code ON scan_logs(employee_code);
CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at);
CREATE INDEX IF NOT EXISTS idx_scan_logs_tank_number ON scan_logs(tank_number);

CREATE TABLE IF NOT EXISTS job_finish_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL DEFAULT 'FINISH_JOB',
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  tank_number TEXT NOT NULL,
  activity_code TEXT,
  activity_name TEXT NOT NULL,
  area_name TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  kiosk_user TEXT,
  scan_source TEXT,
  finish_out_log_id BIGINT UNIQUE,
  finish_in_log_id BIGINT,
  job_in_log_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_finish_events_employee_code ON job_finish_events(employee_code);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_tank_number ON job_finish_events(tank_number);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_finished_at ON job_finish_events(finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_finish_events_area ON job_finish_events(area_name);
`;

async function runPostgresSchema() {
  await withDbRetry(
    async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(MIGRATION_SQL);
        await client.query('COMMIT');
        await normalizeTankStatusesInDb();
        await migrateStopStatusConstraint();
        await migrateEmployeeBadgeRoleColumn();
        await migrateTankLifecycleColumns();
        await backfillFinishJobEventsFromScanLogs();
        console.log('[migration] Postgres schema ready');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    { label: 'schema', maxAttempts: 5, delayMs: 2000 }
  );
}

const ROLE = {
  MANAGER: 'MANAGER',
  KIOSK: 'KIOSK',
};

const DEFAULT_USER_PASSWORDS = {
  manager: process.env.DEFAULT_MANAGER_PASSWORD || 'manager123',
  owner: process.env.OWNER_PASSWORD || 'owner123',
  kiosk_area_a: process.env.DEFAULT_KIOSK_PASSWORD_A || 'kioskA123',
  kiosk_area_b: process.env.DEFAULT_KIOSK_PASSWORD_B || 'kioskB123',
  kiosk_area_c: process.env.DEFAULT_KIOSK_PASSWORD_C || 'kioskC123',
  kiosk_area_d: process.env.DEFAULT_KIOSK_PASSWORD_D || 'kioskD123',
};

/** Default kiosk PINs (hashed in DB). */
const DEFAULT_KIOSK_PINS = {
  kiosk_area_a: '1111',
  kiosk_area_b: '2222',
  kiosk_area_c: '3333',
  kiosk_area_d: '4444',
};

/** Production kiosk areas (display names). */
const KIOSK_PRODUCTION_AREAS = ['Fabrication', 'Assembly', 'QA/QC', 'Shipping & Handling'];

/** Legacy area labels → current production area (logs / filters). */
const LEGACY_KIOSK_AREA_NAMES = {
  'Area A': 'Fabrication',
  'Area B': 'Assembly',
  'Area C': 'QA/QC',
};

/** Kiosk user profiles (username stable for existing DBs; area_name is display label). */
const KIOSK_AREA_PROFILES = [
  {
    username: 'kiosk_area_a',
    passwordKey: 'kiosk_area_a',
    pinKey: 'kiosk_area_a',
    area_name: 'Fabrication',
    station_name: 'Fabrication Kiosk',
    pinField: 'area_a_pin',
  },
  {
    username: 'kiosk_area_b',
    passwordKey: 'kiosk_area_b',
    pinKey: 'kiosk_area_b',
    area_name: 'Assembly',
    station_name: 'Assembly Kiosk',
    pinField: 'area_b_pin',
  },
  {
    username: 'kiosk_area_c',
    passwordKey: 'kiosk_area_c',
    pinKey: 'kiosk_area_c',
    area_name: 'QA/QC',
    station_name: 'QA/QC Kiosk',
    pinField: 'area_c_pin',
  },
  {
    username: 'kiosk_area_d',
    passwordKey: 'kiosk_area_d',
    pinKey: 'kiosk_area_d',
    area_name: 'Shipping & Handling',
    station_name: 'Shipping & Handling Kiosk',
    pinField: 'area_d_pin',
  },
];

/** Maps UI area label → users.username for KIOSK PIN login. */
const KIOSK_AREA_TO_USERNAME = Object.fromEntries(
  KIOSK_AREA_PROFILES.map((p) => [p.area_name, p.username])
);
for (const [legacy, current] of Object.entries(LEGACY_KIOSK_AREA_NAMES)) {
  const username = KIOSK_AREA_TO_USERNAME[current];
  if (username) KIOSK_AREA_TO_USERNAME[legacy] = username;
}

function normalizeKioskAreaName(area) {
  const s = String(area || '').trim();
  return LEGACY_KIOSK_AREA_NAMES[s] || s;
}

function displayKioskAreaName(area) {
  return normalizeKioskAreaName(area) || area || '-';
}

function isQaQcKioskArea(area) {
  return normalizeKioskAreaName(area) === 'QA/QC';
}

function kioskLandingPathForUser(kioskUser) {
  if (kioskUser && isQaQcKioskArea(kioskUser.area_name)) return '/qa-qc';
  return '/kiosk';
}

function areaMatchesFilter(rowArea, filter) {
  if (!filter || filter === 'ALL') return true;
  const normalized = normalizeKioskAreaName(rowArea);
  return normalized === filter || String(rowArea || '').trim() === filter;
}

const PIN_FAIL_WINDOW_MS = 60 * 1000;
const PIN_FAIL_MAX = 5;
/** @type {Map<string, number[]>} */
const pinFailTimestampsByIp = new Map();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim() || 'unknown';
  return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
}

function pinRateLimitAllow(ip) {
  const now = Date.now();
  const arr = pinFailTimestampsByIp.get(ip) || [];
  const recent = arr.filter((t) => now - t < PIN_FAIL_WINDOW_MS);
  pinFailTimestampsByIp.set(ip, recent);
  return recent.length < PIN_FAIL_MAX;
}

function recordPinFailure(ip) {
  const now = Date.now();
  const arr = pinFailTimestampsByIp.get(ip) || [];
  arr.push(now);
  pinFailTimestampsByIp.set(ip, arr.filter((t) => now - t < PIN_FAIL_WINDOW_MS));
}

function pinRateLimitReset(ip) {
  pinFailTimestampsByIp.delete(ip);
}

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return `pbkdf2_sha512$120000$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha512') return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expectedHex = parts[3];
  if (!Number.isFinite(iterations) || !salt || !expectedHex) return false;
  const actualHex = crypto.pbkdf2Sync(String(password), salt, iterations, 64, 'sha512').toString('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(actualHex, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLocalDate(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return null;
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function startEndOfLocalDay(yyyyMmDd) {
  const day = parseLocalDate(yyyyMmDd);
  if (!day) return null;
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function normalizeCode(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().replace(/\s+/g, '').toUpperCase();
}

/** Custom note text (quick pick or Other). Max 20 characters. */
function normalizeNoteValue(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.slice(0, 20);
}

/** WORK (production), REASON (clock-out), STOP (downtime), SWITCH (segment change), AVAILABLE (clocked in, no job). */
function normalizeNoteCategory(raw) {
  if (raw === undefined || raw === null) return null;
  const u = String(raw).trim().toUpperCase();
  if (u === 'WORK' || u === 'REASON' || u === 'SWITCH' || u === 'STOP' || u === 'AVAILABLE') return u;
  return null;
}

const KIOSK_ACTIVITIES_BY_AREA = {
  Fabrication: [
    { code: 'WINDING', label: 'Winding', barcode: 'ACTIVITY:WINDING' },
    { code: 'SHELL_CREATION', label: 'Shell Creation', barcode: 'ACTIVITY:SHELL_CREATION' },
  ],
  Assembly: [
    { code: 'INSTALLING_FITTINGS', label: 'Installing Fittings', barcode: 'ACTIVITY:INSTALLING_FITTINGS' },
    { code: 'BAFFLES', label: 'Baffles', barcode: 'ACTIVITY:BAFFLES' },
    { code: 'BOTTOMS', label: 'Bottoms', barcode: 'ACTIVITY:BOTTOMS' },
    { code: 'ATTACHING_SHELL_SECTION', label: 'Attaching Shell Section', barcode: 'ACTIVITY:ATTACHING_SHELL_SECTION' },
    { code: 'SECONDARY_COMPONENTS', label: 'Secondary Components', barcode: 'ACTIVITY:SECONDARY_COMPONENTS' },
  ],
  'QA/QC': [{ code: 'QAQC', label: 'QA/QC', barcode: 'ACTIVITY:QAQC' }],
  'Shipping & Handling': [
    { code: 'SHIPPING', label: 'Shipping', barcode: 'ACTIVITY:SHIPPING' },
    { code: 'HANDLING', label: 'Handling', barcode: 'ACTIVITY:HANDLING' },
  ],
};

const KIOSK_ACTIVITY_LABELS = {
  WINDING: 'Winding',
  SHELL_CREATION: 'Shell Creation',
  INSTALLING_FITTINGS: 'Installing Fittings',
  BAFFLES: 'Baffles',
  BOTTOMS: 'Bottoms',
  ATTACHING_SHELL_SECTION: 'Attaching Shell Section',
  SECONDARY_COMPONENTS: 'Secondary Components',
  QAQC: 'QA/QC',
  SHIPPING: 'Shipping',
  HANDLING: 'Handling',
  /** Legacy activity codes (old scan logs). */
  FABRICATING: 'Fabrication',
  ASSEMBLY: 'Assembly',
  ASSEMBLE: 'Assembly',
  QA_QC: 'QA/QC',
  QUALITY: 'QA/QC',
  QUALITY_CHECK: 'QA/QC',
  SHIPPING_HANDLING: 'Shipping & Handling',
  KIT_UP: 'Kit Up',
  /** Legacy activity code (now a STOP reason). */
  CLEAN_UP: 'Clean Up',
};

const KIOSK_ACTIVITY_CODE_ALIASES = {
  QA_QC: 'QAQC',
  QUALITY: 'QAQC',
  QUALITY_CHECK: 'QAQC',
};

/** Build label → code map from area activity definitions (single source of truth). */
const KIOSK_ACTIVITY_LABEL_TO_CODE = Object.create(null);
for (const areaActs of Object.values(KIOSK_ACTIVITIES_BY_AREA)) {
  for (const a of areaActs) {
    KIOSK_ACTIVITY_LABEL_TO_CODE[a.code] = a.code;
    KIOSK_ACTIVITY_LABEL_TO_CODE[a.label.toUpperCase()] = a.code;
    KIOSK_ACTIVITY_LABEL_TO_CODE[a.label.toUpperCase().replace(/\//g, '')] = a.code;
  }
}

function normalizeActivityCode(raw) {
  const code = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/^ACTIVITY[:_]/, '')
    .replace(/\//g, '')
    .replace(/\s+/g, '_');
  if (!code) return '';
  return KIOSK_ACTIVITY_CODE_ALIASES[code] || code;
}

/** Resolve scanned value (code, label, or barcode payload) to canonical activity code for an area. */
function resolveActivityCodeForArea(areaName, activityRaw) {
  const area = normalizeKioskAreaName(areaName);
  const allowed = getKioskActivitiesForArea(area);
  if (!allowed.length) return normalizeActivityCode(activityRaw);

  const fromCode = normalizeActivityCode(activityRaw);
  if (allowed.some((a) => a.code === fromCode)) return fromCode;

  const labelKey = String(activityRaw || '')
    .trim()
    .toUpperCase();
  const fromLabel = KIOSK_ACTIVITY_LABEL_TO_CODE[labelKey];
  if (fromLabel && allowed.some((a) => a.code === fromLabel)) return fromLabel;

  const labelNoSlash = labelKey.replace(/\//g, '');
  const fromLabelNoSlash = KIOSK_ACTIVITY_LABEL_TO_CODE[labelNoSlash];
  if (fromLabelNoSlash && allowed.some((a) => a.code === fromLabelNoSlash)) return fromLabelNoSlash;

  return fromCode;
}

function getKioskActivitiesForArea(areaName) {
  const area = normalizeKioskAreaName(areaName);
  if (!area || area === 'Office') {
    return KIOSK_PRODUCTION_AREAS.flatMap((a) => KIOSK_ACTIVITIES_BY_AREA[a] || []);
  }
  return KIOSK_ACTIVITIES_BY_AREA[area] ? [...KIOSK_ACTIVITIES_BY_AREA[area]] : [];
}

function activityAllowedInArea(areaName, activityRaw) {
  const area = normalizeKioskAreaName(areaName);
  if (!area || area === 'Office') return true;
  const allowed = KIOSK_ACTIVITIES_BY_AREA[area];
  if (!allowed) return true;
  const code = resolveActivityCodeForArea(area, activityRaw);
  return allowed.some((a) => a.code === code);
}

function validateKioskActivityForAuth(auth, activityRaw) {
  if (!auth || String(auth.role || '').toUpperCase() !== ROLE.KIOSK) return { ok: true };
  const area = auth.area_name;
  const allowedCodes = getKioskActivitiesForArea(area).map((a) => a.code);
  const resolvedCode = resolveActivityCodeForArea(area, activityRaw);
  if (!activityRaw) {
    console.log('[kiosk-activity] Area:', displayKioskAreaName(area));
    console.log('[kiosk-activity] Scanned activity:', activityRaw);
    console.log('[kiosk-activity] Allowed activities:', allowedCodes.join(', '));
    console.log('[kiosk-activity] Validation result: FAIL (missing activity)');
    return { ok: false, message: 'Activity is required.' };
  }
  const ok = activityAllowedInArea(area, activityRaw);
  console.log('[kiosk-activity] Area:', displayKioskAreaName(area));
  console.log('[kiosk-activity] Scanned activity:', activityRaw);
  console.log('[kiosk-activity] Allowed activities:', allowedCodes.join(', '));
  console.log(
    '[kiosk-activity] Validation result:',
    ok ? 'PASS' : 'FAIL',
    `(resolved: ${resolvedCode || 'none'})`
  );
  if (!ok) {
    return {
      ok: false,
      message: `Activity not allowed at ${displayKioskAreaName(area)} kiosk.`,
    };
  }
  return { ok: true };
}

const KIOSK_STOP_LABELS = {
  CLEAN_UP: 'Clean Up',
  LUNCH: 'Lunch',
  BREAK: 'Break',
  MAINTENANCE_DOWNTIME: 'Maintenance/Downtime',
  MAINTENANCE: 'Maintenance/Downtime',
  MATERIAL: 'Material',
};

const KIOSK_STOP_CODE_ALIASES = {
  CLEANUP: 'CLEAN_UP',
};

/** UI / PDF colors: IN green, OUT gray, STOP orange, ERROR red. */
const SCAN_STATUS_COLORS = {
  IN: '#15803d',
  OUT: '#64748b',
  STOP: '#d97706',
  ERROR: '#b91c1c',
};

function pdfStatusColor(status) {
  const s = String(status || '').toUpperCase();
  return SCAN_STATUS_COLORS[s] || SCAN_STATUS_COLORS.OUT;
}

/**
 * Production IN start time for the session ending at `stopRow` (exclusive of STOP duration).
 * @param {Array<{status:string, scanned_at:string, id?: number}>} logsAsc
 * @param {{ status: string, scanned_at: string, id?: number }} stopRow
 * @returns {number | null}
 */
function activeSessionStartMsBeforeStop(logsAsc, stopRow) {
  const stopMs = new Date(stopRow.scanned_at).getTime();
  if (Number.isNaN(stopMs)) return null;
  const stopId = stopRow.id != null ? Number(stopRow.id) : null;
  let sessionStart = null;
  for (const row of logsAsc) {
    const t = new Date(row.scanned_at).getTime();
    if (Number.isNaN(t)) continue;
    const sameStop =
      t === stopMs &&
      (stopId == null || row.id == null || Number(row.id) === stopId || row === stopRow);
    if (sameStop) return sessionStart;
    const st = String(row.status || '').toUpperCase();
    if (st === 'IN' && isProductionInRow(row)) sessionStart = t;
    else if (st === 'OUT' || st === 'STOP') sessionStart = null;
  }
  return sessionStart;
}

const KIOSK_REASON_LABELS = {
  END_SHIFT: 'End Shift',
};

/** Lunch/Break/Clean Up legacy REASON barcodes → STOP when on an active job. */
const KIOSK_LEGACY_PAUSE_REASON_CODES = new Set(['LUNCH', 'BREAK', 'CLEAN_UP']);

function kioskActivityLabel(raw) {
  const code = normalizeActivityCode(raw);
  if (!code) {
    const labelKey = String(raw || '')
      .trim()
      .toUpperCase();
    const mapped = KIOSK_ACTIVITY_LABEL_TO_CODE[labelKey] || KIOSK_ACTIVITY_LABEL_TO_CODE[labelKey.replace(/\//g, '')];
    if (mapped) return KIOSK_ACTIVITY_LABELS[mapped] || mapped.replace(/_/g, ' ').slice(0, 20);
    return null;
  }
  return KIOSK_ACTIVITY_LABELS[code] || code.replace(/_/g, ' ').slice(0, 20);
}

function kioskReasonLabel(raw) {
  const code = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/^REASON[:_]/, '');
  if (!code) return null;
  return KIOSK_REASON_LABELS[code] || code.replace(/_/g, ' ').slice(0, 20);
}

function normalizeStopReasonCode(raw) {
  const code = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/^STOP[:_]/, '')
    .replace(/^REASON[:_]/, '')
    .replace(/^ACTIVITY[:_]/, '')
    .replace(/\s+/g, '_');
  return KIOSK_STOP_CODE_ALIASES[code] || code;
}

function kioskStopLabel(raw) {
  const code = normalizeStopReasonCode(raw);
  if (!code) return null;
  return KIOSK_STOP_LABELS[code] || code.replace(/_/g, ' ').slice(0, 20);
}

function isLegacyPauseReasonCode(raw) {
  const code = normalizeStopReasonCode(raw);
  return KIOSK_LEGACY_PAUSE_REASON_CODES.has(code);
}

function isProductionInRow(row) {
  if (!row || String(row.status || '').toUpperCase() !== 'IN') return false;
  const cat = String(row.note_category || '').toUpperCase();
  if (cat === 'AVAILABLE' || cat === 'WAITING') return false;
  return !cat || cat === 'WORK';
}

function hasActiveProductionJob(activeIn) {
  if (!activeIn || !isProductionInRow(activeIn)) return false;
  const tank = normalizeTankNumber(activeIn.tank_number || '');
  if (!tank) return false;
  const act = workActivityLabelFromInRow(activeIn);
  return !!(act && act !== '-');
}

/**
 * Production activity + tank to restore after STOP (from STOP row and prior IN scans).
 * @param {string} code
 * @returns {Promise<{ activity: string|null, tank: string|null, stop_reason: string|null }|null>}
 */
async function getLastActiveWorkContext(code) {
  const employee = await getEmployeeByCode(code);
  if (!employee) return null;
  const eid = Number(employee.id);
  if (!Number.isInteger(eid) || eid <= 0) return null;

  const { rows } = await pool.query(
    `SELECT status, scanned_at, id, tank_number, note_value, note, note_category
     FROM scan_logs
     WHERE employee_id = $1
     ORDER BY scanned_at DESC, id DESC
     LIMIT 100`,
    [eid]
  );
  if (!rows.length) return null;

  const latest = rows[0];
  if (String(latest.status || '').toUpperCase() !== 'STOP') return null;

  const stopReason =
    latest.note_value != null && String(latest.note_value).trim() !== ''
      ? String(latest.note_value).trim()
      : null;

  let activity = null;
  let tank = normalizeTankNumber(latest.tank_number || '') || null;

  const noteText = latest.note != null ? String(latest.note).trim() : '';
  const noteVal = latest.note_value != null ? String(latest.note_value).trim() : '';
  const noteCat = String(latest.note_category || '').toUpperCase();

  if (noteCat === 'STOP' && noteText && noteText !== '-' && noteText !== noteVal) {
    activity = noteText;
  } else if (noteText && noteText !== noteVal && noteText !== '-') {
    activity = noteText;
  }

  if (!activity || !tank) {
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const st = String(row.status || '').toUpperCase();
      if (st === 'STOP') continue;
      if (st === 'IN' && isProductionInRow(row)) {
        if (!activity) {
          const label = workActivityLabelFromInRow(row);
          if (label && label !== '-') activity = label;
        }
        if (!tank) tank = normalizeTankNumber(row.tank_number || '') || null;
        if (activity && tank) break;
      }
      if (st === 'OUT') break;
    }
  }

  if (!activity && !tank) return null;
  return { activity: activity || null, tank: tank || null, stop_reason: stopReason };
}

/**
 * Resume IN from STOP using saved work context; inserts a new IN scan log.
 * @param {{ employee: object, code: string, auth: object|null, activity?: string|null, tank?: string|null }}
 */
async function resumeFromStop({ employee, code, auth, activity: activityOverride, tank: tankOverride }) {
  const ctx = await getLastActiveWorkContext(code);
  const activity = (activityOverride && String(activityOverride).trim()) || (ctx && ctx.activity) || null;
  const tank = normalizeTankNumber(tankOverride || (ctx && ctx.tank) || '') || null;
  if (!activity || !tank) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: 'validation',
        message: 'Missing resume activity or tank context.',
      },
    };
  }
  const tankRow = await ensureTankExists(tank);
  if (tankRow && normalizeTankStatus(tankRow.status) === 'archived') {
    return {
      ok: false,
      status: 403,
      body: {
        ok: false,
        error: 'tank_archived',
        message: 'This tank is completed. Restore it in Tank Management before resuming work.',
      },
    };
  }
  const row = await insertScanLogForEmployee({
    employee,
    code,
    status: 'IN',
    noteCategory: 'WORK',
    noteValue: activity,
    tankNumber: tank,
    auth,
  });
  return {
    ok: true,
    body: {
      ok: true,
      action: 'resume_work',
      log_id: row.id,
      employee: { id: employee.id, code: employee.code, name: employee.name },
      status: 'IN',
      phase: 'IN',
      activity,
      tank_number: tank,
      kiosk_message: 'Resumed previous job',
      scanned_at: row.scanned_at,
    },
  };
}

async function migrateStopStatusConstraint() {
  try {
    await pool.query(`ALTER TABLE scan_logs DROP CONSTRAINT IF EXISTS scan_logs_status_check`);
    await pool.query(
      `ALTER TABLE scan_logs ADD CONSTRAINT scan_logs_status_check CHECK (status IN ('IN', 'OUT', 'STOP'))`
    );
  } catch (err) {
    console.warn('[migration] scan_logs STOP status constraint:', err.message);
  }
}

async function migrateEmployeeBadgeRoleColumn() {
  try {
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS badge_role TEXT`);
  } catch (err) {
    console.warn('[migration] employees.badge_role:', err.message);
  }
}

async function migrateTankLifecycleColumns() {
  try {
    await pool.query(`ALTER TABLE tanks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await pool.query(`UPDATE tanks SET created_at = NOW() WHERE created_at IS NULL`);
    await pool.query(`
      UPDATE tanks
      SET completed_at = COALESCE(completed_at, updated_at, NOW())
      WHERE LOWER(TRIM(status)) IN ('archived', 'completed')
        AND completed_at IS NULL
    `);
    await pool.query(`
      UPDATE tanks
      SET completed_at = NULL
      WHERE LOWER(TRIM(COALESCE(status, ''))) IN ('active', '')
    `);
  } catch (err) {
    console.warn('[migration] tanks lifecycle:', err.message);
  }
}

function parseBadgeRoleInput(body) {
  if (!body || body.badge_role === undefined) return null;
  const s = String(body.badge_role).trim();
  return s || null;
}

function isCommandInBarcode(normalized) {
  const n = String(normalized || '').toUpperCase();
  return n === 'CMD:IN' || n === 'CMD_IN' || n === 'COMMAND_IN' || n === 'IN_CMD';
}

function isCommandOutBarcode(normalized) {
  const n = String(normalized || '').toUpperCase();
  return n === 'CMD:OUT' || n === 'CMD_OUT' || n === 'COMMAND_OUT' || n === 'OUT_CMD';
}

async function insertScanLogForEmployee({
  employee,
  code,
  status,
  noteCategory,
  noteValue,
  noteText,
  tankNumber,
  auth,
  scannedAtIso,
}) {
  const stationName = auth && auth.role === ROLE.KIOSK ? auth.station_name || null : null;
  const areaName = auth && auth.role === ROLE.KIOSK ? auth.area_name || null : null;
  const kioskUser = auth && auth.role === ROLE.KIOSK ? auth.username || null : null;
  const scannedAt = scannedAtIso || nowIso();
  const noteCol = noteText != null && String(noteText).trim() !== '' ? String(noteText).trim() : noteValue;
  const ins = await pool.query(
    `INSERT INTO scan_logs (employee_code, employee_name, employee_id, status, scanned_at, note, note_category, note_value, tank_number, station_name, area_name, kiosk_user)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, scanned_at`,
    [
      code,
      employee.name,
      employee.id,
      status,
      scannedAt,
      noteCol,
      noteCategory,
      noteValue,
      tankNumber,
      stationName,
      areaName,
      kioskUser,
    ]
  );
  return ins.rows[0];
}

/**
 * Kiosk employee phase: OUT | IN | STOP (production context).
 * @returns {Promise<{ phase: string, on_clock: boolean, currently_working: boolean, current_activity: string|null, current_tank: string|null, stop_reason: string|null, resume_activity: string|null, resume_tank: string|null }>}
 */
async function getEmployeeKioskWorkState(code) {
  const paired = await getTodayPairingStateForEmployeeCode(code);
  const latest = paired.latestRow;
  const activeIn =
    paired.currentlyWorking && paired.pendingInSourceRow && isProductionInRow(paired.pendingInSourceRow)
      ? paired.pendingInSourceRow
      : null;
  let phase = 'OUT';
  let stopReason = null;
  let currentActivity = null;
  let currentTank = null;
  let resumeActivity = null;
  let resumeTank = null;

  if (latest) {
    const st = String(latest.status || '').toUpperCase();
    if (st === 'STOP') {
      phase = 'STOP';
      const ctx = await getLastActiveWorkContext(code);
      stopReason = (ctx && ctx.stop_reason) || latest.note_value || null;
      resumeActivity = ctx && ctx.activity ? ctx.activity : null;
      resumeTank = ctx && ctx.tank ? ctx.tank : normalizeTankNumber(latest.tank_number || '') || null;
      currentActivity = resumeActivity;
      currentTank = resumeTank;
    } else if (paired.currentlyWorking && String(latest.status || '').toUpperCase() === 'IN') {
      phase = 'IN';
      if (activeIn && hasActiveProductionJob(activeIn)) {
        currentActivity = workActivityLabelFromInRow(activeIn);
        currentTank = normalizeTankNumber(activeIn.tank_number || '') || null;
      }
    } else if (paired.currentlyWorking && activeIn && hasActiveProductionJob(activeIn)) {
      phase = 'IN';
      currentActivity = workActivityLabelFromInRow(activeIn);
      currentTank = normalizeTankNumber(activeIn.tank_number || '') || null;
    }
  }

  const onClock = phase === 'IN' || phase === 'STOP';
  const hasJob = !!(activeIn && hasActiveProductionJob(activeIn));
  return {
    phase,
    on_clock: onClock,
    currently_working: phase === 'IN' && hasJob,
    has_active_job: hasJob,
    waiting_for_job: phase === 'IN' && onClock && !hasJob,
    current_activity: currentActivity,
    current_tank: currentTank,
    stop_reason: stopReason,
    resume_activity: resumeActivity,
    resume_tank: resumeTank,
  };
}

/**
 * Start a production job while employee remains clocked IN (after FINISH / waiting).
 */
async function performAssignWorkWhileClockedIn({ employee, code, auth, activity, tank }) {
  const tankRow = await ensureTankExists(tank);
  if (tankRow && normalizeTankStatus(tankRow.status) === 'archived') {
    return {
      ok: false,
      status: 403,
      body: {
        ok: false,
        error: 'tank_archived',
        message: 'This tank is completed. Restore it in Tank Management before assigning work.',
      },
    };
  }
  const baseMs = Date.now();
  const outIso = new Date(baseMs).toISOString();
  const inIso = new Date(baseMs + 15).toISOString();
  await insertScanLogForEmployee({
    employee,
    code,
    status: 'OUT',
    noteCategory: 'SWITCH',
    noteValue: 'ASSIGN_WORK',
    tankNumber: null,
    auth,
    scannedAtIso: outIso,
  });
  const inRow = await insertScanLogForEmployee({
    employee,
    code,
    status: 'IN',
    noteCategory: 'WORK',
    noteValue: activity,
    tankNumber: tank,
    auth,
    scannedAtIso: inIso,
  });
  return {
    ok: true,
    action: 'assign_work',
    log_id: inRow.id,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status: 'IN',
    phase: 'IN',
    activity,
    tank_number: tank,
    scanned_at: inRow.scanned_at,
    has_active_job: true,
    waiting_for_job: false,
  };
}

/**
 * Complete current tank/activity job; employee stays clocked IN (available for next job).
 */
async function recordFinishJobEvent({ employee, activeIn, outRow, inRow, auth, scanSource }) {
  if (!outRow || !activeIn) return null;
  const dup = await pool.query(`SELECT * FROM job_finish_events WHERE finish_out_log_id = $1 LIMIT 1`, [
    Number(outRow.id),
  ]);
  if (dup.rows.length) return dup.rows[0];

  const startedAt = activeIn.scanned_at;
  const finishedAt = outRow.scanned_at;
  const startMs = new Date(startedAt).getTime();
  const finishMs = new Date(finishedAt).getTime();
  const durationMinutes =
    Number.isFinite(startMs) && Number.isFinite(finishMs) ? Math.max(0, Math.round((finishMs - startMs) / 60000)) : 0;

  const activityName = workActivityLabelFromInRow(activeIn);
  const tankNumber = normalizeTankNumber(outRow.tank_number || activeIn.tank_number || '') || '';
  const areaName =
    (auth && auth.area_name ? String(auth.area_name) : null) ||
    (activeIn.area_name ? String(activeIn.area_name) : null) ||
    (outRow.area_name ? String(outRow.area_name) : null);
  const activityCode = areaName ? resolveActivityCodeForArea(areaName, activityName) : normalizeActivityCode(activityName);
  let tankId = null;
  if (tankNumber) {
    const tankRow = await ensureTankExists(tankNumber);
    if (tankRow && tankRow.id != null) tankId = Number(tankRow.id);
  }
  const kioskUser = auth && auth.role === ROLE.KIOSK ? auth.username || null : null;
  const scanSrc = scanSource ? String(scanSource).trim().slice(0, 40) : 'kiosk';

  const ins = await pool.query(
    `INSERT INTO job_finish_events (
       event_type, employee_id, employee_code, employee_name,
       tank_id, tank_number, activity_code, activity_name,
       area_name, started_at, finished_at, duration_minutes,
       kiosk_user, scan_source, finish_out_log_id, finish_in_log_id, job_in_log_id
     ) VALUES (
       'FINISH_JOB', $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11,
       $12, $13, $14, $15, $16
     )
     ON CONFLICT (finish_out_log_id) DO NOTHING
     RETURNING *`,
    [
      employee.id,
      employee.code,
      employee.name,
      tankId,
      tankNumber,
      activityCode || null,
      activityName,
      areaName,
      startedAt,
      finishedAt,
      durationMinutes,
      kioskUser,
      scanSrc,
      Number(outRow.id),
      inRow && inRow.id != null ? Number(inRow.id) : null,
      activeIn.id != null ? Number(activeIn.id) : null,
    ]
  );
  if (ins.rows.length) return ins.rows[0];
  const again = await pool.query(`SELECT * FROM job_finish_events WHERE finish_out_log_id = $1 LIMIT 1`, [
    Number(outRow.id),
  ]);
  return again.rows[0] || null;
}

function mapFinishJobEventRow(row) {
  if (!row) return null;
  const tankNumber = row.tank_number ? String(row.tank_number) : '';
  const activityName = row.activity_name ? String(row.activity_name) : '-';
  const employeeName = row.employee_name ? String(row.employee_name) : row.employee_code || '-';
  const durationMinutes = Number(row.duration_minutes) || 0;
  return {
    id: Number(row.id),
    event_type: String(row.event_type || 'FINISH_JOB'),
    employee_id: row.employee_id != null ? Number(row.employee_id) : null,
    employee_code: String(row.employee_code || ''),
    employee_name: employeeName,
    tank_id: row.tank_id != null ? Number(row.tank_id) : null,
    tank_number: tankNumber,
    activity_code: row.activity_code ? String(row.activity_code) : null,
    activity_name: activityName,
    area_name: row.area_name ? String(row.area_name) : null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_minutes: durationMinutes,
    kiosk_id: row.kiosk_user ? String(row.kiosk_user) : null,
    scan_source: row.scan_source ? String(row.scan_source) : null,
    employee_history_line: tankNumber
      ? `Finished ${activityName} on Tank ${tankNumber}`
      : `Finished ${activityName}`,
    tank_history_line: `${employeeName} finished ${activityName}`,
  };
}

async function backfillFinishJobEventsFromScanLogs() {
  try {
    const { rows: outs } = await pool.query(
      `SELECT id, employee_id, employee_code, employee_name, scanned_at, tank_number, note, note_value,
              area_name, kiosk_user
       FROM scan_logs
       WHERE UPPER(COALESCE(status, '')) = 'OUT'
         AND UPPER(COALESCE(note_category, '')) = 'SWITCH'
         AND UPPER(COALESCE(note_value, '')) = 'FINISH'
         AND NOT EXISTS (SELECT 1 FROM job_finish_events e WHERE e.finish_out_log_id = scan_logs.id)
       ORDER BY scanned_at ASC, id ASC`
    );
    for (const outRow of outs) {
      const eid = outRow.employee_id != null ? Number(outRow.employee_id) : null;
      if (!eid) continue;
      const { rows: prior } = await pool.query(
        `SELECT id, status, scanned_at, tank_number, note_value, note, note_category, area_name
         FROM scan_logs
         WHERE employee_id = $1 AND scanned_at < $2::timestamptz
         ORDER BY scanned_at DESC, id DESC
         LIMIT 30`,
        [eid, outRow.scanned_at]
      );
      const activeIn = prior.find((r) => isProductionInRow(r));
      if (!activeIn) continue;
      const { rows: afterIn } = await pool.query(
        `SELECT id FROM scan_logs
         WHERE employee_id = $1 AND scanned_at > $2::timestamptz
         ORDER BY scanned_at ASC, id ASC LIMIT 1`,
        [eid, outRow.scanned_at]
      );
      const inRow = afterIn[0] || null;
      const employee = {
        id: eid,
        code: outRow.employee_code,
        name: outRow.employee_name,
      };
      await recordFinishJobEvent({
        employee,
        activeIn,
        outRow,
        inRow,
        auth: outRow.kiosk_user ? { role: ROLE.KIOSK, username: outRow.kiosk_user, area_name: outRow.area_name } : null,
        scanSource: 'backfill',
      });
    }
  } catch (err) {
    console.warn('[migration] finish job events backfill:', err.message);
  }
}

async function fetchFinishJobEvents({
  employeeCode,
  tankNumber,
  areaName,
  limit = 20,
  finishedAfter,
  finishedBefore,
}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const params = [];
  const where = [`event_type = 'FINISH_JOB'`];
  if (employeeCode) {
    params.push(normalizeCode(employeeCode));
    where.push(`REPLACE(UPPER(TRIM(COALESCE(employee_code, ''))), ' ', '') = $${params.length}`);
  }
  if (tankNumber) {
    params.push(normalizeTankNumber(tankNumber));
    where.push(`UPPER(TRIM(COALESCE(tank_number, ''))) = $${params.length}`);
  }
  if (areaName) {
    params.push(String(areaName).trim());
    where.push(`TRIM(COALESCE(area_name, '')) = $${params.length}`);
  }
  if (finishedAfter) {
    params.push(finishedAfter);
    where.push(`finished_at >= $${params.length}::timestamptz`);
  }
  if (finishedBefore) {
    params.push(finishedBefore);
    where.push(`finished_at <= $${params.length}::timestamptz`);
  }
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM job_finish_events
     WHERE ${where.join(' AND ')}
     ORDER BY finished_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map(mapFinishJobEventRow).filter(Boolean);
}

function resolveFinishJobsAreaFilter(raw) {
  const f = String(raw || '').trim();
  if (!f || f.toUpperCase() === 'ALL') return null;
  if (f === 'Shipping' || f === 'Shipping & Handling') return 'Shipping & Handling';
  return normalizeKioskAreaName(f) || f;
}

async function fetchManagerFinishedJobs({ area, todayOnly, limit = 30 }) {
  let finishedAfter;
  let finishedBefore;
  if (todayOnly !== false) {
    const day = startEndOfLocalDay(localDateString());
    if (day) {
      finishedAfter = day.startIso;
      finishedBefore = day.endIso;
    }
  }
  const areaName = resolveFinishJobsAreaFilter(area);
  return fetchFinishJobEvents({
    areaName: areaName || undefined,
    limit,
    finishedAfter,
    finishedBefore,
  });
}

function mapDashboardFinishedJob(row) {
  if (!row) return null;
  const activityName = row.activity_name || row.activityName || '-';
  const tankNumber = row.tank_number || row.tankNumber || '';
  const employeeName = row.employee_name || row.employeeName || row.employee_code || row.employeeCode || '-';
  const durationMinutes = Number(row.duration_minutes != null ? row.duration_minutes : row.durationMinutes) || 0;
  const areaRaw = row.area_name || row.area || null;
  return {
    employeeCode: String(row.employee_code || row.employeeCode || ''),
    employeeName: String(employeeName),
    tankNumber: String(tankNumber),
    activityName: String(activityName),
    area: displayKioskAreaName(areaRaw),
    finishedAt: row.finished_at || row.finishedAt || null,
    durationMinutes,
  };
}

async function fetchFinishedJobsFromScanLogs({ areaName, finishedAfter, finishedBefore, limit = 30 }) {
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const params = [];
  const where = [
    `UPPER(COALESCE(status, '')) = 'OUT'`,
    `(
      UPPER(COALESCE(note_value, '')) = 'FINISH'
      OR UPPER(COALESCE(note, '')) = 'FINISH'
      OR (UPPER(COALESCE(note_category, '')) = 'SWITCH' AND UPPER(COALESCE(note_value, '')) = 'FINISH')
    )`,
  ];
  if (areaName) {
    params.push(String(areaName).trim());
    where.push(`TRIM(COALESCE(area_name, '')) = $${params.length}`);
  }
  if (finishedAfter) {
    params.push(finishedAfter);
    where.push(`scanned_at >= $${params.length}::timestamptz`);
  }
  if (finishedBefore) {
    params.push(finishedBefore);
    where.push(`scanned_at <= $${params.length}::timestamptz`);
  }
  params.push(lim);
  const { rows: outs } = await pool.query(
    `SELECT id, employee_id, employee_code, employee_name, scanned_at, tank_number, note, note_value,
            area_name, kiosk_user
     FROM scan_logs
     WHERE ${where.join(' AND ')}
     ORDER BY scanned_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  const jobs = [];
  for (const outRow of outs) {
    const eid = outRow.employee_id != null ? Number(outRow.employee_id) : null;
    if (!eid) continue;
    const { rows: prior } = await pool.query(
      `SELECT id, status, scanned_at, tank_number, note_value, note, note_category, area_name
       FROM scan_logs
       WHERE employee_id = $1 AND scanned_at < $2::timestamptz
       ORDER BY scanned_at DESC, id DESC
       LIMIT 30`,
      [eid, outRow.scanned_at]
    );
    const activeIn = prior.find((r) => isProductionInRow(r));
    let activityName = activeIn ? workActivityLabelFromInRow(activeIn) : '';
    if (!activityName || activityName === '-') {
      const noteText = outRow.note ? String(outRow.note).trim() : '';
      activityName = noteText && noteText.toUpperCase() !== 'FINISH' ? noteText : 'Job';
    }
    const tankNumber = normalizeTankNumber(outRow.tank_number || (activeIn && activeIn.tank_number) || '') || '';
    const startedAt = activeIn ? activeIn.scanned_at : null;
    const finishedAt = outRow.scanned_at;
    const startMs = new Date(startedAt).getTime();
    const finishMs = new Date(finishedAt).getTime();
    const durationMinutes =
      Number.isFinite(startMs) && Number.isFinite(finishMs) ? Math.max(0, Math.round((finishMs - startMs) / 60000)) : 0;
    const areaRaw =
      (outRow.area_name ? String(outRow.area_name) : null) ||
      (activeIn.area_name ? String(activeIn.area_name) : null);
    jobs.push(
      mapDashboardFinishedJob({
        employee_code: outRow.employee_code,
        employee_name: outRow.employee_name,
        tank_number: tankNumber,
        activity_name: activityName,
        area_name: areaRaw,
        finished_at: finishedAt,
        duration_minutes: durationMinutes,
      })
    );
  }
  return jobs.filter(Boolean);
}

async function fetchDashboardFinishedJobs({ area, todayOnly, limit = 30 }) {
  let finishedAfter;
  let finishedBefore;
  if (todayOnly !== false) {
    const day = startEndOfLocalDay(localDateString());
    if (day) {
      finishedAfter = day.startIso;
      finishedBefore = day.endIso;
    }
  }
  const areaName = resolveFinishJobsAreaFilter(area);
  const scanJobs = await fetchFinishedJobsFromScanLogs({
    areaName: areaName || undefined,
    finishedAfter,
    finishedBefore,
    limit,
  });
  if (scanJobs.length) return scanJobs;
  const eventRows = await fetchFinishJobEvents({
    areaName: areaName || undefined,
    limit,
    finishedAfter,
    finishedBefore,
  });
  return eventRows.map(mapDashboardFinishedJob).filter(Boolean);
}

async function fetchLastFinishByTankForWindow(startIso, endIso) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (UPPER(TRIM(tank_number)))
       tank_number, employee_name, activity_name, finished_at, duration_minutes
     FROM job_finish_events
     WHERE finished_at >= $1::timestamptz AND finished_at <= $2::timestamptz
     ORDER BY UPPER(TRIM(tank_number)), finished_at DESC, id DESC`,
    [startIso, endIso]
  );
  const map = new Map();
  for (const r of rows) {
    const key = normalizeTankNumber(r.tank_number);
    if (key) map.set(key, r);
  }
  return map;
}

async function performFinishJob({ employee, code, activeIn, auth, scanSource }) {
  if (!hasActiveProductionJob(activeIn)) {
    return {
      ok: false,
      status: 409,
      body: { ok: false, error: 'no_active_job', message: 'No active job to finish.' },
    };
  }
  const prevActivity = workActivityLabelFromInRow(activeIn);
  const prevTank = normalizeTankNumber(activeIn.tank_number || '') || null;
  const baseMs = Date.now();
  const outIso = new Date(baseMs).toISOString();
  const inIso = new Date(baseMs + 15).toISOString();
  const outRow = await insertScanLogForEmployee({
    employee,
    code,
    status: 'OUT',
    noteCategory: 'SWITCH',
    noteValue: 'FINISH',
    noteText: prevActivity,
    tankNumber: prevTank,
    auth,
    scannedAtIso: outIso,
  });
  const inRow = await insertScanLogForEmployee({
    employee,
    code,
    status: 'IN',
    noteCategory: 'AVAILABLE',
    noteValue: 'Waiting',
    tankNumber: null,
    auth,
    scannedAtIso: inIso,
  });
  let finishEvent = null;
  try {
    finishEvent = await recordFinishJobEvent({
      employee,
      activeIn,
      outRow,
      inRow,
      auth,
      scanSource,
    });
  } catch (err) {
    console.error('[finish_job event]', err);
  }
  return {
    ok: true,
    body: {
      ok: true,
      action: 'finish_job',
      log_id: inRow.id,
      out_log_id: outRow.id,
      in_log_id: inRow.id,
      finish_event_id: finishEvent && finishEvent.id != null ? Number(finishEvent.id) : null,
      finish_event: mapFinishJobEventRow(finishEvent),
      employee: { id: employee.id, code: employee.code, name: employee.name },
      status: 'IN',
      phase: 'IN',
      activity: null,
      tank_number: null,
      previous_activity: prevActivity,
      previous_tank: prevTank,
      started_at: activeIn.scanned_at,
      finished_at: outRow.scanned_at,
      duration_minutes: finishEvent ? Number(finishEvent.duration_minutes) : null,
      has_active_job: false,
      waiting_for_job: true,
      kiosk_message: 'IN — Waiting for next job',
      scanned_at: inRow.scanned_at,
    },
  };
}

async function performProductionSwitch({ employee, code, activeIn, auth, nextActivity, nextTank, endedBy, action }) {
  const prevActivity = workActivityLabelFromInRow(activeIn);
  const prevTank = normalizeTankNumber(activeIn.tank_number || '') || null;
  const baseMs = Date.now();
  const outIso = new Date(baseMs).toISOString();
  const inIso = new Date(baseMs + 15).toISOString();
  const outRow = await insertScanLogForEmployee({
    employee,
    code,
    status: 'OUT',
    noteCategory: 'SWITCH',
    noteValue: endedBy,
    tankNumber: prevTank,
    auth,
    scannedAtIso: outIso,
  });
  const inRow = await insertScanLogForEmployee({
    employee,
    code,
    status: 'IN',
    noteCategory: 'WORK',
    noteValue: nextActivity,
    tankNumber: nextTank,
    auth,
    scannedAtIso: inIso,
  });
  return {
    ok: true,
    action,
    ended_by: endedBy,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status: 'IN',
    phase: 'IN',
    previous_activity: prevActivity,
    previous_tank: prevTank,
    activity: nextActivity,
    tank_number: nextTank,
    out_log_id: outRow.id,
    in_log_id: inRow.id,
    scanned_at: inRow.scanned_at,
  };
}

async function performKioskWorkAction(req, res) {
  const auth = req.auth || currentKioskFromSession(req) || currentAuthFromSession(req) || null;
  const code = normalizeCode(req.body && req.body.employee_code);
  const action = String(req.body && req.body.action ? req.body.action : '')
    .trim()
    .toLowerCase();
  if (!code) return res.status(400).json({ ok: false, error: 'validation', message: 'employee_code is required.' });
  const employee = await getEmployeeByCode(code);
  if (!employee) return res.status(404).json({ ok: false, error: 'unknown_employee', message: 'Unknown employee.' });
  if (!employee.is_active) return res.status(403).json({ ok: false, error: 'inactive_employee', message: 'Employee is inactive.' });

  const latestAny = await getLatestLogForEmployeeCode(code);
  const latestSt = latestAny ? String(latestAny.status || '').toUpperCase() : '';
  const skipDebounce = action === 'resume_work' && latestSt === 'STOP';
  if (!skipDebounce && recentDuplicateScan(latestAny)) {
    return res.status(429).json({
      ok: false,
      error: 'duplicate_scan',
      message: 'Duplicate scan ignored. Please wait a moment before scanning again.',
    });
  }

  const pairedBefore = await getTodayPairingStateForEmployeeCode(code);
  const workState = await getEmployeeKioskWorkState(code);
  const activeIn = await getCurrentActiveInSessionByCode(code);

  const activityRaw = req.body && (req.body.activity != null ? req.body.activity : req.body.note_value);
  const reasonRaw = req.body && (req.body.reason != null ? req.body.reason : req.body.note_value);
  const stopRaw = req.body && (req.body.stop != null ? req.body.stop : req.body.stop_reason);
  const tankRaw = normalizeTankNumber(req.body && req.body.tank_number);

  if (action === 'clock_in' || action === 'clock_in_activity') {
    if (workState.on_clock && workState.phase === 'IN' && !activeIn) {
      const activity = kioskActivityLabel(activityRaw);
      if (!activity) {
        return res.status(400).json({ ok: false, error: 'validation', message: 'Activity is required.' });
      }
      const activityCheck = validateKioskActivityForAuth(auth, activityRaw);
      if (!activityCheck.ok) {
        return res.status(400).json({ ok: false, error: 'validation', message: activityCheck.message });
      }
      if (!tankRaw) {
        return res.status(400).json({ ok: false, error: 'validation', message: 'Tank is required.' });
      }
      const assign = await performAssignWorkWhileClockedIn({
        employee,
        code,
        auth,
        activity,
        tank: tankRaw,
      });
      if (!assign.ok) return res.status(assign.status).json(assign.body);
      return res.json(assign);
    }
    if (workState.on_clock) {
      const msg =
        workState.phase === 'STOP'
          ? 'Employee is on STOP. Scan employee to resume or scan reason to clock out.'
          : 'Employee is already clocked in.';
      return res.status(409).json({ ok: false, error: 'already_in', message: msg });
    }
    const activity = kioskActivityLabel(activityRaw);
    if (!activity) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'Activity is required to clock in.' });
    }
    const activityCheck = validateKioskActivityForAuth(auth, activityRaw);
    if (!activityCheck.ok) {
      return res.status(400).json({ ok: false, error: 'validation', message: activityCheck.message });
    }
    if (!tankRaw) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'Tank is required to clock in.' });
    }
    const tankRow = await ensureTankExists(tankRaw);
    if (tankRow && normalizeTankStatus(tankRow.status) === 'archived') {
      return res.status(403).json({
        ok: false,
        error: 'tank_archived',
        message: 'This tank is completed. Restore it in Tank Management before assigning work.',
      });
    }
    const row = await insertScanLogForEmployee({
      employee,
      code,
      status: 'IN',
      noteCategory: 'WORK',
      noteValue: activity,
      tankNumber: tankRaw,
      auth,
    });
    let kiosk_message = null;
    if (pairedBefore.regularAutoEnded && !pairedBefore.pendingOvertimeSession) {
      kiosk_message = 'Overtime session started.';
    }
    return res.json({
      ok: true,
      action: 'clock_in',
      log_id: row.id,
      employee: { id: employee.id, code: employee.code, name: employee.name },
      status: 'IN',
      phase: 'IN',
      activity,
      tank_number: tankRaw,
      session_type: pairedBefore.regularAutoEnded ? 'OVERTIME' : 'REGULAR',
      scanned_at: row.scanned_at,
      kiosk_message,
    });
  }

  if (action === 'clock_out') {
    if (!workState.on_clock) {
      return res.status(409).json({ ok: false, error: 'not_working', message: 'Employee is not clocked in.' });
    }
    if (isLegacyPauseReasonCode(reasonRaw)) {
      if (workState.phase === 'IN' && activeIn && hasActiveProductionJob(activeIn)) {
        const stopLabel = kioskStopLabel(reasonRaw);
        const prevActivity = workActivityLabelFromInRow(activeIn);
        const prevTank = normalizeTankNumber(activeIn.tank_number || '') || null;
        const row = await insertScanLogForEmployee({
          employee,
          code,
          status: 'STOP',
          noteCategory: 'STOP',
          noteValue: stopLabel,
          noteText: prevActivity,
          tankNumber: prevTank,
          auth,
        });
        return res.json({
          ok: true,
          action: 'enter_stop',
          log_id: row.id,
          employee: { id: employee.id, code: employee.code, name: employee.name },
          status: 'STOP',
          phase: 'STOP',
          stop_reason: stopLabel,
          resume_activity: prevActivity,
          resume_tank: prevTank,
          scanned_at: row.scanned_at,
          kiosk_message: `STOP: ${stopLabel} (legacy REASON barcode)`,
        });
      }
      return res.status(409).json({
        ok: false,
        error: 'use_stop_barcode',
        message: 'Lunch, Break, and Clean Up are STOP reasons. Scan STOP while on a job.',
      });
    }
    const reason = kioskReasonLabel(reasonRaw);
    if (!reason) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'OUT reason is required.' });
    }
    const resolvedTank =
      tankRaw ||
      workState.current_tank ||
      (activeIn && activeIn.tank_number ? normalizeTankNumber(activeIn.tank_number) : null);
    const row = await insertScanLogForEmployee({
      employee,
      code,
      status: 'OUT',
      noteCategory: 'REASON',
      noteValue: reason,
      tankNumber: resolvedTank,
      auth,
    });
    let kiosk_message = null;
    if (pairedBefore.pendingOvertimeSession) kiosk_message = 'Overtime ended.';
    return res.json({
      ok: true,
      action: 'clock_out',
      log_id: row.id,
      employee: { id: employee.id, code: employee.code, name: employee.name },
      status: 'OUT',
      phase: 'OUT',
      reason,
      tank_number: resolvedTank,
      scanned_at: row.scanned_at,
      kiosk_message,
    });
  }

  if (action === 'enter_stop') {
    if (workState.phase !== 'IN' || !workState.on_clock) {
      return res.status(409).json({
        ok: false,
        error: 'not_in',
        message: 'Employee must be IN before using Stop.',
      });
    }
    if (!activeIn || !hasActiveProductionJob(activeIn)) {
      return res.status(409).json({
        ok: false,
        error: 'no_active_job',
        message: 'No active job to stop. Scan activity and tank to start work.',
      });
    }
    const stopLabel = kioskStopLabel(stopRaw);
    if (!stopLabel) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'Stop reason is required.' });
    }
    const prevActivity = workActivityLabelFromInRow(activeIn);
    const prevTank = normalizeTankNumber(activeIn.tank_number || '') || null;
    const row = await insertScanLogForEmployee({
      employee,
      code,
      status: 'STOP',
      noteCategory: 'STOP',
      noteValue: stopLabel,
      noteText: prevActivity,
      tankNumber: prevTank,
      auth,
    });
    return res.json({
      ok: true,
      action: 'enter_stop',
      log_id: row.id,
      employee: { id: employee.id, code: employee.code, name: employee.name },
      status: 'STOP',
      phase: 'STOP',
      stop_reason: stopLabel,
      resume_activity: prevActivity,
      resume_tank: prevTank,
      scanned_at: row.scanned_at,
    });
  }

  if (action === 'resume_work') {
    if (workState.phase !== 'STOP') {
      return res.status(409).json({
        ok: false,
        error: 'not_stopped',
        message: 'Employee is not on STOP.',
      });
    }
    const activityHint = workState.resume_activity || kioskActivityLabel(activityRaw);
    const tankHint = workState.resume_tank || tankRaw;
    const result = await resumeFromStop({
      employee,
      code,
      auth,
      activity: activityHint,
      tank: tankHint,
    });
    if (!result.ok) return res.status(result.status).json(result.body);
    return res.json(result.body);
  }

  if (action === 'finish_job' || action === 'finish') {
    if (workState.phase === 'STOP') {
      return res.status(409).json({
        ok: false,
        error: 'stopped',
        message: 'Resume current job before finishing.',
      });
    }
    if (workState.phase !== 'IN' || !workState.on_clock) {
      return res.status(409).json({
        ok: false,
        error: 'not_in',
        message: 'Employee must be IN to finish a job.',
      });
    }
    const scanSource = String(
      (req.body && req.body.scan_source) || (req.body && req.body.source) || 'kiosk'
    )
      .trim()
      .slice(0, 40);
    const finishResult = await performFinishJob({ employee, code, activeIn, auth, scanSource });
    if (!finishResult.ok) return res.status(finishResult.status).json(finishResult.body);
    return res.json(finishResult.body);
  }

  if (action === 'switch_activity' || action === 'switch_tank' || action === 'switch_work' || action === 'assign_tank') {
    if (workState.phase !== 'IN' || !workState.on_clock) {
      return res.status(409).json({
        ok: false,
        error: 'not_working',
        message: 'Employee must be IN to assign or switch work.',
      });
    }
    if (!activeIn) {
      const act = kioskActivityLabel(activityRaw);
      if (!act) return res.status(400).json({ ok: false, error: 'validation', message: 'Activity is required.' });
      const actCheck = validateKioskActivityForAuth(auth, activityRaw);
      if (!actCheck.ok) return res.status(400).json({ ok: false, error: 'validation', message: actCheck.message });
      if (!tankRaw) return res.status(400).json({ ok: false, error: 'validation', message: 'Tank is required.' });
      const assign = await performAssignWorkWhileClockedIn({
        employee,
        code,
        auth,
        activity: act,
        tank: tankRaw,
      });
      if (!assign.ok) return res.status(assign.status).json(assign.body);
      return res.json(assign);
    }
    const prevActivity = workActivityLabelFromInRow(activeIn);
    const prevTank = normalizeTankNumber(activeIn.tank_number || '') || null;
    let nextActivity = prevActivity;
    let nextTank = prevTank;
    let endedBy = 'SWITCH_WORK';
    const effectiveAction = action === 'assign_tank' ? 'switch_tank' : action;
    if (effectiveAction === 'switch_activity') {
      const act = kioskActivityLabel(activityRaw);
      if (!act) return res.status(400).json({ ok: false, error: 'validation', message: 'Activity is required.' });
      const actCheck = validateKioskActivityForAuth(auth, activityRaw);
      if (!actCheck.ok) return res.status(400).json({ ok: false, error: 'validation', message: actCheck.message });
      if (act === prevActivity) {
        return res.json({
          ok: true,
          noop: true,
          message: 'Already on this activity.',
          activity: act,
          tank_number: prevTank,
          phase: 'IN',
        });
      }
      nextActivity = act;
      endedBy = 'SWITCH_ACTIVITY';
    } else if (effectiveAction === 'switch_tank') {
      if (!tankRaw) return res.status(400).json({ ok: false, error: 'validation', message: 'Tank is required.' });
      const tankRow = await ensureTankExists(tankRaw);
      if (tankRow && normalizeTankStatus(tankRow.status) === 'archived') {
        return res.status(403).json({
          ok: false,
          error: 'tank_archived',
          message: 'This tank is completed. Restore it in Tank Management before assigning work.',
        });
      }
      if (prevTank && prevTank === tankRaw) {
        return res.json({
          ok: true,
          noop: true,
          message: 'Already on this tank.',
          activity: prevActivity,
          tank_number: prevTank,
          phase: 'IN',
        });
      }
      nextTank = tankRaw;
      endedBy = 'SWITCH_TANK';
    } else {
      const act = kioskActivityLabel(activityRaw);
      if (!act) return res.status(400).json({ ok: false, error: 'validation', message: 'Activity is required.' });
      const actCheck = validateKioskActivityForAuth(auth, activityRaw);
      if (!actCheck.ok) return res.status(400).json({ ok: false, error: 'validation', message: actCheck.message });
      if (!tankRaw) return res.status(400).json({ ok: false, error: 'validation', message: 'Tank is required.' });
      const tankRow = await ensureTankExists(tankRaw);
      if (tankRow && normalizeTankStatus(tankRow.status) === 'archived') {
        return res.status(403).json({
          ok: false,
          error: 'tank_archived',
          message: 'This tank is completed. Restore it in Tank Management before assigning work.',
        });
      }
      nextActivity = act;
      nextTank = tankRaw;
      endedBy = 'SWITCH_WORK';
    }
    const payload = await performProductionSwitch({
      employee,
      code,
      activeIn,
      auth,
      nextActivity,
      nextTank,
      endedBy,
      action,
    });
    return res.json(payload);
  }

  return res.status(400).json({ ok: false, error: 'validation', message: 'Unknown kiosk action.' });
}

function normalizeTankNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  return s.slice(0, 24);
}

/** Registry status: always lowercase `active` | `archived`. */
function normalizeTankStatus(raw) {
  const s = String(raw == null || raw === '' ? 'active' : raw)
    .trim()
    .toLowerCase();
  if (s === 'archived' || s === 'completed') return 'archived';
  return 'active';
}

const TANK_SELECT_COLUMNS = 'id, tank_number, description, status, created_at, completed_at, updated_at';

function tankTimestampToIso(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function computeTankDurationMs(row) {
  const createdIso = tankTimestampToIso(row && row.created_at);
  if (!createdIso) return 0;
  const created = new Date(createdIso);
  const status = normalizeTankStatus(row && row.status);
  let end = new Date();
  if (status === 'archived') {
    const completedIso = tankTimestampToIso(row.completed_at);
    end = completedIso ? new Date(completedIso) : new Date();
    if (Number.isNaN(end.getTime())) end = new Date();
  }
  return Math.max(0, end.getTime() - created.getTime());
}

function formatTankDurationDisplay(durationMs) {
  const totalMins = Math.floor(Math.max(0, Number(durationMs) || 0) / 60000);
  if (totalMins < 60) return `${totalMins}m`;
  if (totalMins < 24 * 60) {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const totalHours = Math.floor(totalMins / 60);
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function mapTankRowForApi(row) {
  if (!row) return row;
  const status = normalizeTankStatus(row.status);
  const created_at = tankTimestampToIso(row.created_at) || nowIso();
  const completed_at = status === 'archived' ? tankTimestampToIso(row.completed_at) : null;
  const duration_ms = computeTankDurationMs({ ...row, created_at, completed_at, status });
  return {
    id: Number(row.id),
    tank_number: row.tank_number,
    description: row.description,
    status,
    created_at,
    completed_at,
    updated_at: tankTimestampToIso(row.updated_at),
    duration_ms,
    duration_display: formatTankDurationDisplay(duration_ms),
  };
}

/** One-time safe repair for legacy ACTIVE/ARCHIVED/null values in Neon. */
async function normalizeTankStatusesInDb() {
  await pool.query(`
    UPDATE tanks SET status = 'active'
    WHERE status IS NULL
       OR TRIM(status) = ''
       OR LOWER(TRIM(status)) IN ('active', 'ACTIVE');
  `);
  await pool.query(`
    UPDATE tanks SET status = 'archived'
    WHERE LOWER(TRIM(status)) IN ('archived', 'ARCHIVED', 'completed', 'COMPLETED');
  `);
}

function formatLogNoteDisplay(row) {
  const v = row.note_value != null && String(row.note_value).trim() !== '' ? String(row.note_value).trim() : row.note;
  if (!v || String(v).trim() === '') return '—';
  const c = row.note_category;
  if (c === 'WORK' || c === 'REASON') return `${c} · ${v}`;
  return String(v);
}

/** PDF / export: single-line activity or reason text (not the full WORK · prefix). */
function truncatePdfCell(text, maxLen) {
  if (!text) return '';
  const s = String(text).trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

/** Scan log row → Activity / Reason column (value only; missing → "-"). */
function pdfScanActivityCell(row) {
  const raw =
    row.note_value != null && String(row.note_value).trim() !== ''
      ? String(row.note_value).trim()
      : row.note && String(row.note).trim() !== ''
        ? String(row.note).trim()
        : '';
  if (!raw) return '-';
  return truncatePdfCell(raw, 20);
}

/** Activity / reason for PDF with custom max length (timeline, wide columns). */
function pdfScanActivityTrunc(row, maxLen) {
  const raw =
    row.note_value != null && String(row.note_value).trim() !== ''
      ? String(row.note_value).trim()
      : row.note && String(row.note).trim() !== ''
        ? String(row.note).trim()
        : '';
  if (!raw) return '-';
  return truncatePdfCell(raw, maxLen);
}

function pdfScanActivityRaw(row) {
  const raw =
    row.note_value != null && String(row.note_value).trim() !== ''
      ? String(row.note_value).trim()
      : row.note && String(row.note).trim() !== ''
        ? String(row.note).trim()
        : '';
  return raw || '-';
}

/**
 * Last IN activity / last OUT reason per employee within ordered logs (export scope).
 * @param {Array<{employee_code: string, status: string, note_value?: string, note?: string}>} logsAsc
 */
function buildLastInOutHintsByCode(logsAsc) {
  const map = new Map();
  for (const log of logsAsc) {
    const code = log.employee_code;
    if (!map.has(code)) map.set(code, { lastIn: null, lastOut: null });
    const ent = map.get(code);
    const val =
      log.note_value != null && String(log.note_value).trim() !== ''
        ? String(log.note_value).trim()
        : log.note && String(log.note).trim() !== ''
          ? String(log.note).trim()
          : null;
    if (!val) continue;
    if (log.status === 'IN') ent.lastIn = val;
    if (log.status === 'OUT') ent.lastOut = val;
  }
  return map;
}

function enrichPayrollRowsWithScanHints(rows, logsAsc) {
  const hints = buildLastInOutHintsByCode(logsAsc);
  for (const r of rows) {
    const h = hints.get(r.employee_code);
    r.pdf_hint_last_in = h && h.lastIn ? h.lastIn : null;
    r.pdf_hint_last_out = h && h.lastOut ? h.lastOut : null;
  }
}

/** IN row: work label for duration / display; uses note on that event. */
function workActivityLabelFromInRow(inRow) {
  const raw =
    inRow.note_value != null && String(inRow.note_value).trim() !== ''
      ? inRow.note_value
      : inRow.note && String(inRow.note).trim() !== ''
        ? inRow.note
        : '';
  const t = raw ? String(raw).trim() : '';
  return t || '-';
}

/**
 * Same cumulative regular / OT rules as pairSessionsMsForWindow, without window clipping (full wall times).
 * @param {boolean} includeTrailing If false, an open trailing IN is ignored (matches legacy analytics).
 */
function walkCumulativePairSegmentsNoWindow(logsAsc, closeMs, onClose, includeTrailing) {
  /** @type {Map<string, number>} */
  const regularByDay = new Map();
  let pendingMs = null;
  /** @type {object | null} */
  let pendingRow = null;
  let pendingOt = false;

  function clearP() {
    pendingMs = null;
    pendingRow = null;
    pendingOt = false;
  }

  function closeAt(outMs) {
    if (pendingMs === null) return;
    const tin = pendingMs;
    if (outMs <= tin) {
      clearP();
      return;
    }
    const eff = pendingOt ? outMs : closeRegularSegmentEnd(tin, outMs, regularByDay);
    if (eff > tin) onClose(tin, eff, pendingRow, pendingOt);
    clearP();
  }

  for (const row of logsAsc) {
    const st = String(row.status || '').toUpperCase();
    const t = new Date(row.scanned_at).getTime();
    if (Number.isNaN(t)) continue;
    if (st === 'IN') {
      if (!isProductionInRow(row)) continue;
      if (pendingMs !== null) {
        if (!pendingOt) {
          const virtEnd = peekRegularSegmentEnd(pendingMs, t, regularByDay);
          if (virtEnd > pendingMs && virtEnd < t) closeAt(virtEnd);
        }
        if (pendingMs !== null) continue;
      }
      pendingMs = t;
      pendingRow = row;
      const dk = localDateString(new Date(t));
      pendingOt = (regularByDay.get(dk) || 0) >= REGULAR_SHIFT_CAP_MS;
    } else if (st === 'STOP') {
      if (pendingMs !== null) {
        if (t < pendingMs) {
          clearP();
          continue;
        }
        closeAt(t);
      }
    } else if (st === 'OUT') {
      if (pendingMs === null) continue;
      if (t < pendingMs) {
        clearP();
        continue;
      }
      closeAt(t);
    }
  }
  if (includeTrailing && pendingMs !== null) {
    const tin = pendingMs;
    const eff = pendingOt ? closeMs : closeRegularSegmentEnd(tin, closeMs, regularByDay);
    if (eff > tin) onClose(tin, eff, pendingRow, pendingOt);
  }
}

/**
 * IN→OUT pairs; duration attributed to the IN row’s work (note_value). Incomplete pairs ignored.
 * @param {Array<Object>} logsAsc
 * @returns {Array<{ employee_id: number|null, employee_code: string, employee_name: string, activities: Array<{ label: string, hours: number }> }>}
 */
function computeWorkAnalyticsFromLogs(logsAsc) {
  const byCode = new Map();
  for (const log of logsAsc) {
    const code = log.employee_code;
    if (!byCode.has(code)) {
      byCode.set(code, {
        employee_id: log.employee_id != null ? log.employee_id : null,
        employee_code: code,
        employee_name: log.employee_name,
        logs: [],
      });
    }
    byCode.get(code).logs.push(log);
  }
  const out = [];
  const closeAt = Date.now();
  for (const bundle of byCode.values()) {
    const activityMs = new Map();
    bundle.logs.sort((a, b) => {
      const ta = new Date(a.scanned_at).getTime();
      const tb = new Date(b.scanned_at).getTime();
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    walkCumulativePairSegmentsNoWindow(bundle.logs, closeAt, (tin, tout, inRow) => {
      const label = workActivityLabelFromInRow(inRow);
      const dur = tout - tin;
      if (dur > 0) activityMs.set(label, (activityMs.get(label) || 0) + dur);
    }, false);
    const activities = [...activityMs.entries()]
      .map(([label, ms]) => ({
        label,
        hours: Math.round((ms / 3600000) * 100) / 100,
      }))
      .filter((a) => a.hours > 0)
      .sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    out.push({
      employee_id: bundle.employee_id,
      employee_code: bundle.employee_code,
      employee_name: bundle.employee_name,
      activities,
    });
  }
  out.sort((a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }));
  return out;
}

/** Duration attributed to the tank stamped on each IN row (IN→OUT segments; trailing IN to closeMs). */
function laborMsAttributedByTank(logsAsc, closeMs = Date.now()) {
  const groups = new Map();
  for (const log of logsAsc) {
    const code = log.employee_code;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(log);
  }
  const tankMs = new Map();
  for (const [, logs] of groups) {
    logs.sort((a, b) => {
      const ta = new Date(a.scanned_at).getTime();
      const tb = new Date(b.scanned_at).getTime();
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    walkCumulativePairSegmentsNoWindow(
      logs,
      closeMs,
      (tin, tout, inRow) => {
        if (!isProductionInRow(inRow)) return;
        const tank = normalizeTankNumber(inRow.tank_number || '');
        if (!tank) return;
        const dur = tout - tin;
        if (dur > 0) tankMs.set(tank, (tankMs.get(tank) || 0) + dur);
      },
      true
    );
  }
  return tankMs;
}

function computeTankSummaryFromLogs(logsAsc, closeMs) {
  const closeAt = closeMs != null ? closeMs : Date.now();
  const tankMs = laborMsAttributedByTank(logsAsc, closeAt);
  const map = new Map();
  const byEmp = new Map();
  for (const log of logsAsc) {
    const code = log.employee_code;
    const tank = normalizeTankNumber(log.tank_number || '');
    if (log.status === 'IN') {
      if (tank) byEmp.set(code, tank);
    } else if (log.status === 'OUT' || log.status === 'STOP') {
      byEmp.delete(code);
    }
    if (log.status !== 'IN') continue;
    const resolved = tank || byEmp.get(code);
    if (!resolved) continue;
    if (!map.has(resolved)) map.set(resolved, { workers: new Set(), activities: new Set() });
    const ent = map.get(resolved);
    ent.workers.add(code);
    const label = workActivityLabelFromInRow(log);
    if (label && label !== '-') ent.activities.add(label);
  }
  const out = [];
  for (const [tankNumber, ent] of map.entries()) {
    const ms = tankMs.get(tankNumber) || 0;
    out.push({
      tank_number: tankNumber,
      workers: ent.workers.size,
      total_labor_hours: Math.round((ms / 3600000) * 100) / 100,
      activities: [...ent.activities].slice(0, 4),
    });
  }
  return out.sort((a, b) => a.tank_number.localeCompare(b.tank_number, undefined, { sensitivity: 'base' }));
}

function msToHours2(ms) {
  return Math.round((ms / 3600000) * 100) / 100;
}

/** Tank-scoped labor from scan logs (IN-row tank attribution; same pairing engine as payroll). */
function computeTankLaborReport(tankNumber, logsAsc, employeesByCode, closeMs = Date.now()) {
  const tankNorm = normalizeTankNumber(tankNumber);
  if (!tankNorm) {
    return {
      summary: {
        total_hours: 0,
        regular_hours: 0,
        overtime_hours: 0,
        estimated_pay: 0,
        workers_count: 0,
        last_activity_at: null,
      },
      employeeBreakdown: [],
      activityBreakdown: [],
      sessions: [],
    };
  }

  const groups = new Map();
  for (const log of logsAsc) {
    const code = log.employee_code;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(log);
  }

  const employeeBreakdown = [];
  const activityAgg = new Map();
  const sessions = [];
  let totalMs = 0;
  let totalRegularMs = 0;
  let totalOtMs = 0;
  let totalPay = 0;
  const workerCodes = new Set();
  let lastActivityMs = null;

  function logHasOutNear(logs, tMs, toleranceMs = 2500) {
    return logs.some((r) => {
      if (String(r.status || '').toUpperCase() !== 'OUT') return false;
      const ot = new Date(r.scanned_at).getTime();
      return !Number.isNaN(ot) && Math.abs(ot - tMs) <= toleranceMs;
    });
  }

  for (const [code, logs] of groups) {
    logs.sort((a, b) => {
      const ta = new Date(a.scanned_at).getTime();
      const tb = new Date(b.scanned_at).getTime();
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    const normCode = normalizeCode(code);
    const emp = employeesByCode.get(normCode);
    const rateRaw = emp ? Number(emp.hourly_rate) : 20;
    const safeRate = Number.isFinite(rateRaw) && rateRaw >= 0 ? rateRaw : 20;
    let empTotalMs = 0;
    let empRegMs = 0;
    let empOtMs = 0;
    const activityMs = new Map();
    const activitySessionCounts = new Map();

    walkCumulativePairSegmentsNoWindow(
      logs,
      closeMs,
      (tin, tout, inRow, isOt) => {
        if (!isProductionInRow(inRow)) return;
        const segTank = normalizeTankNumber(inRow.tank_number || '');
        if (segTank !== tankNorm) return;
        const dur = tout - tin;
        if (dur <= 0) return;
        empTotalMs += dur;
        if (isOt) empOtMs += dur;
        else empRegMs += dur;
        const label = workActivityLabelFromInRow(inRow);
        activityMs.set(label, (activityMs.get(label) || 0) + dur);
        activitySessionCounts.set(label, (activitySessionCounts.get(label) || 0) + 1);
        const hadOut = logHasOutNear(logs, tout);
        const autoEnded = !hadOut && !isOt;
        sessions.push({
          employee_code: code,
          employee_name: inRow.employee_name || code,
          activity: label,
          area_name: inRow.area_name != null ? String(inRow.area_name) : null,
          in_time: new Date(tin).toISOString(),
          out_time: new Date(tout).toISOString(),
          duration_hours: msToHours2(dur),
          session_type: isOt ? 'OVERTIME' : 'REGULAR',
          auto_ended: autoEnded,
        });
        workerCodes.add(code);
        if (lastActivityMs === null || tout > lastActivityMs) lastActivityMs = tout;
      },
      true
    );

    if (empTotalMs <= 0) continue;
    totalMs += empTotalMs;
    totalRegularMs += empRegMs;
    totalOtMs += empOtMs;
    const regH = msToHours2(empRegMs);
    const otH = msToHours2(empOtMs);
    const totalH = msToHours2(empTotalMs);
    const pay = roundMoney2(regH * safeRate + otH * safeRate * 1.5);
    totalPay += pay;
    const activities = [...activityMs.entries()]
      .map(([name, ms]) => ({ name, hours: msToHours2(ms) }))
      .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    employeeBreakdown.push({
      employee_code: code,
      employee_name: emp ? emp.name : logs[0].employee_name || code,
      total_hours: totalH,
      regular_hours: regH,
      overtime_hours: otH,
      estimated_pay: pay,
      activities_performed: activities.map((a) => a.name),
    });
    for (const [name, ms] of activityMs) {
      const prev = activityAgg.get(name) || { total_ms: 0, session_count: 0 };
      prev.total_ms += ms;
      prev.session_count += activitySessionCounts.get(name) || 0;
      activityAgg.set(name, prev);
    }
  }

  const activityBreakdown = [...activityAgg.entries()]
    .map(([activity_name, v]) => ({
      activity_name,
      total_hours: msToHours2(v.total_ms),
      session_count: v.session_count,
    }))
    .sort(
      (a, b) =>
        b.total_hours - a.total_hours ||
        a.activity_name.localeCompare(b.activity_name, undefined, { sensitivity: 'base' })
    );

  employeeBreakdown.sort((a, b) =>
    a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' })
  );
  sessions.sort((a, b) => {
    const ta = new Date(a.in_time).getTime();
    const tb = new Date(b.in_time).getTime();
    return tb - ta;
  });

  return {
    summary: {
      total_hours: msToHours2(totalMs),
      regular_hours: msToHours2(totalRegularMs),
      overtime_hours: msToHours2(totalOtMs),
      estimated_pay: roundMoney2(totalPay),
      workers_count: workerCodes.size,
      last_activity_at: lastActivityMs != null ? new Date(lastActivityMs).toISOString() : null,
    },
    employeeBreakdown,
    activityBreakdown,
    sessions,
  };
}

async function fetchTankLaborLogs(tankNumber) {
  const tankNorm = normalizeTankNumber(tankNumber);
  if (!tankNorm) return [];
  const codesRes = await pool.query(
    `SELECT DISTINCT employee_code FROM scan_logs
     WHERE UPPER(TRIM(COALESCE(tank_number, ''))) = $1`,
    [tankNorm]
  );
  const codes = codesRes.rows.map((r) => r.employee_code).filter(Boolean);
  if (!codes.length) return [];
  const logRes = await pool.query(
    `SELECT id, employee_id, employee_code, employee_name, status, scanned_at, note, note_category, note_value,
            tank_number, station_name, area_name, kiosk_user
     FROM scan_logs
     WHERE employee_code = ANY($1::text[])
     ORDER BY scanned_at ASC, id ASC`,
    [codes]
  );
  return logRes.rows;
}

/**
 * @param {Array<Object>} logsAsc
 */
function groupLogsByEmployeeTimeline(logsAsc) {
  const map = new Map();
  for (const log of logsAsc) {
    const code = log.employee_code;
    if (!map.has(code)) {
      map.set(code, {
        employee_id: log.employee_id != null ? log.employee_id : null,
        employee_code: code,
        employee_name: log.employee_name,
        logs: [],
      });
    }
    map.get(code).logs.push(log);
  }
  return [...map.values()].sort((a, b) =>
    a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' })
  );
}

function exportPdfTimeColumnShowsDate(payroll) {
  const meta = payroll.meta || {};
  if (meta.scope === 'today') return false;
  if (meta.scope === 'range' && payroll.range_start && payroll.range_end && payroll.range_start === payroll.range_end) {
    return false;
  }
  return true;
}

function formatPdfScanLineTime(iso, withDate) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!withDate) return hm;
  const md = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return md;
}

function parseHourlyRate(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 20;
  return Math.round(n * 100) / 100;
}

async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM employees');
  if (rows[0].c > 0) return;

  const ts = nowIso();
  const seeds = [
    ['EMP001', 'John Carter'],
    ['EMP002', 'Mike Davis'],
    ['EMP003', 'Alex Turner'],
    ['EMP004', 'David Brooks'],
    ['EMP005', 'Chris Miller'],
    ['EMP006', 'Ethan Scott'],
  ];
  for (const [code, name] of seeds) {
    await pool.query(
      `INSERT INTO employees (code, name, is_active, hourly_rate, created_at, updated_at)
       VALUES ($1, $2, 1, 20, $3::timestamptz, $4::timestamptz)`,
      [code, name, ts, ts]
    );
  }
}

async function seedDefaultUsers() {
  const ts = nowIso();
  const seeds = [
    {
      username: 'manager',
      password_hash: hashPassword(DEFAULT_USER_PASSWORDS.manager),
      pin_hash: null,
      role: ROLE.MANAGER,
      station_name: 'Office Manager',
      area_name: 'Office',
      created_at: ts,
      updated_at: ts,
    },
    {
      username: 'owner',
      password_hash: hashPassword(DEFAULT_USER_PASSWORDS.owner),
      pin_hash: null,
      role: ROLE.MANAGER,
      station_name: 'Backup Owner Account',
      area_name: 'Office',
      created_at: ts,
      updated_at: ts,
    },
    ...KIOSK_AREA_PROFILES.map((p) => ({
      username: p.username,
      password_hash: hashPassword(DEFAULT_USER_PASSWORDS[p.passwordKey]),
      pin_hash: hashPassword(DEFAULT_KIOSK_PINS[p.pinKey]),
      role: ROLE.KIOSK,
      station_name: p.station_name,
      area_name: p.area_name,
      created_at: ts,
      updated_at: ts,
    })),
  ];
  for (const u of seeds) {
    await pool.query(
      `INSERT INTO users (username, password_hash, pin_hash, role, station_name, area_name, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (username) DO NOTHING`,
      [
        u.username,
        u.password_hash,
        u.pin_hash,
        u.role,
        u.station_name,
        u.area_name,
        u.created_at,
        u.updated_at,
      ]
    );
  }
}

/** Existing DBs: refresh kiosk area labels and ensure Shipping kiosk account exists. */
async function ensureKioskAreaProfiles() {
  const ts = nowIso();
  for (const p of KIOSK_AREA_PROFILES) {
    await pool.query(
      `INSERT INTO users (username, password_hash, pin_hash, role, station_name, area_name, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (username) DO NOTHING`,
      [
        p.username,
        hashPassword(DEFAULT_USER_PASSWORDS[p.passwordKey]),
        hashPassword(DEFAULT_KIOSK_PINS[p.pinKey]),
        ROLE.KIOSK,
        p.station_name,
        p.area_name,
        ts,
        ts,
      ]
    );
    await pool.query(
      `UPDATE users SET area_name = $1, station_name = $2, updated_at = $3::timestamptz
       WHERE username = $4 AND role = $5`,
      [p.area_name, p.station_name, ts, p.username, ROLE.KIOSK]
    );
  }
}

/** Existing databases: fill pin_hash only when missing (does not overwrite manager-set PINs). */
async function ensureKioskDefaultPins() {
  const ts = nowIso();
  for (const [uname, pin] of Object.entries(DEFAULT_KIOSK_PINS)) {
    await pool.query(
      `UPDATE users SET pin_hash = $1, updated_at = $2::timestamptz
       WHERE username = $3 AND (pin_hash IS NULL OR TRIM(COALESCE(pin_hash, '')) = '')`,
      [hashPassword(pin), ts, uname]
    );
  }
}

async function initializeDatabase() {
  await runPostgresSchema();
  await withDbRetry(
    async () => {
      await seedIfEmpty();
      await seedDefaultUsers();
      await ensureKioskAreaProfiles();
      await ensureKioskDefaultPins();
    },
    { label: 'seed', maxAttempts: 3, delayMs: 1500 }
  );
  console.log('[boot] database seed complete');
}

const dbReady = initializeDatabase().catch((err) => {
  console.error('\n' + formatDbError(err) + '\n');
  if (!process.env.VERCEL) {
    process.exit(1);
  }
  throw err;
});

async function getEmployeeByCode(code) {
  const n = normalizeCode(code);
  if (!n) return null;
  const { rows } = await pool.query(
    `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at
     FROM employees
     WHERE REPLACE(UPPER(TRIM(COALESCE(code, ''))), ' ', '') = $1`,
    [n]
  );
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, pin_hash, role, station_name, area_name, is_active
     FROM users WHERE LOWER(TRIM(username)) = $1 LIMIT 1`,
    [u]
  );
  return rows[0] || null;
}

async function getTankByNumber(tankNumber) {
  const { rows } = await pool.query(
    `SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE tank_number = $1`,
    [tankNumber]
  );
  return rows[0] || null;
}

async function ensureTankExists(rawTankNumber) {
  const tankNumber = normalizeTankNumber(rawTankNumber);
  if (!tankNumber) return null;
  let existing = await getTankByNumber(tankNumber);
  if (existing) return existing;
  const ts = nowIso();
  try {
    await pool.query(
      `INSERT INTO tanks (tank_number, description, status, created_at, updated_at)
       VALUES ($1, '', 'active', $2::timestamptz, $3::timestamptz)`,
      [tankNumber, ts, ts]
    );
  } catch {
    /* race-safe */
  }
  return getTankByNumber(tankNumber);
}

function hoursRoundMode() {
  const m = String(process.env.PAYROLL_ROUND_HOURS || 'nearest').toLowerCase();
  return m === 'floor' ? 'floor' : 'nearest';
}

function roundWorkedHours(decimalHours) {
  const mode = hoursRoundMode();
  if (!Number.isFinite(decimalHours) || decimalHours < 0) return 0;
  if (mode === 'floor') return Math.floor(decimalHours + 1e-9);
  return Math.round(decimalHours);
}

function roundMoney2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function roundHours2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

/** Ms overlap of intervals [a0,a1] and [b0,b1] (inclusive bounds). */
function intervalOverlapMs(a0, a1, b0, b1) {
  const s = Math.max(a0, b0);
  const e = Math.min(a1, b1);
  return Math.max(0, e - s);
}

/** Max regular (non-explicit-OT) hours per local calendar day. */
const REGULAR_SHIFT_CAP_MS = 8 * 60 * 60 * 1000;

/** Upper bound when peeking virtual regular-shift end for open sessions. */
const REGULAR_PAIRING_PEEK_MS = 48 * 60 * 60 * 1000;

function localDayAfterStartMs(tMs) {
  const d = new Date(tMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

function cloneRegularByDayMap(regularByDay) {
  return new Map(regularByDay);
}

/**
 * Advance from tin toward tout, crediting regular time against each local calendar day (max 8h/day).
 * Mutates regularByDay (keys yyyy-mm-dd local). Returns effective segment end (<= tout).
 */
function closeRegularSegmentEnd(tin, tout, regularByDay) {
  if (!(Number.isFinite(tin) && Number.isFinite(tout)) || tout <= tin) return tin;
  let cur = tin;
  while (cur < tout) {
    const dayKey = localDateString(new Date(cur));
    const used = regularByDay.get(dayKey) || 0;
    const remDay = Math.max(0, REGULAR_SHIFT_CAP_MS - used);
    if (remDay === 0) break;
    const dayEndNext = localDayAfterStartMs(cur);
    const chunkEnd = Math.min(tout, dayEndNext);
    const chunkLen = chunkEnd - cur;
    const take = Math.min(chunkLen, remDay);
    cur += take;
    regularByDay.set(dayKey, used + take);
    if (take < chunkLen) break;
    if (cur >= tout) break;
  }
  return cur;
}

function peekRegularSegmentEnd(tin, tout, regularByDay) {
  return closeRegularSegmentEnd(tin, tout, cloneRegularByDayMap(regularByDay));
}

/**
 * Pair IN→OUT chronologically; ignore duplicate IN while pending (unless cumulative 8h regular forces a virtual OUT before the next IN).
 * Unmatched trailing IN closes to closeMs (open session). Optionally clip all segments to a local-day window.
 *
 * Regular hours: cumulative max 8h per local calendar day across all completed segments; an open regular session
 * ends virtually when the day’s remaining regular budget is exhausted. Overtime only after an IN when that day’s
 * regular bucket is already full (explicit OT IN).
 */
function pairSessionsMsForWindow(logsAsc, opts) {
  const closeMs = opts.closeMs;
  const windowStartMs = opts.windowStartMs;
  const windowEndMs = opts.windowEndMs;
  const isToday = !!opts.isToday;
  const carry = opts.carryPendingIn;

  /** @type {Map<string, number>} */
  const regularByDay = new Map();

  let pendingInMs = null;
  /** @type {object | null} */
  let pendingInRow = null;
  let pendingSessionNum = 0;
  let sessionSeq = 0;
  let pendingIsOvertime = false;

  if (carry && String(carry.status || '').toUpperCase() === 'IN') {
    const t0 = new Date(carry.scanned_at).getTime();
    if (!Number.isNaN(t0)) {
      pendingInMs = t0;
      pendingInRow = carry;
      sessionSeq = 1;
      pendingSessionNum = 1;
      const dk = localDateString(new Date(t0));
      pendingIsOvertime = (regularByDay.get(dk) || 0) >= REGULAR_SHIFT_CAP_MS;
    }
  }

  let totalMs = 0;
  /** @type {Array<{ in: string, out: string, duration_ms: number }>} */
  const sessions = [];

  function addSegment(inMs, outMs) {
    const ms = intervalOverlapMs(inMs, outMs, windowStartMs, windowEndMs);
    if (ms <= 0) return;
    totalMs += ms;
    sessions.push({
      in: new Date(inMs).toISOString(),
      out: new Date(outMs).toISOString(),
      duration_ms: ms,
    });
  }

  function clearPending() {
    pendingInMs = null;
    pendingInRow = null;
    pendingSessionNum = 0;
    pendingIsOvertime = false;
  }

  function closePendingAtOutMs(outMs) {
    if (pendingInMs === null) return;
    const tin = pendingInMs;
    if (outMs <= tin) {
      clearPending();
      return;
    }
    const effOutMs = pendingIsOvertime ? outMs : closeRegularSegmentEnd(tin, outMs, regularByDay);
    addSegment(tin, effOutMs);
    clearPending();
  }

  for (const row of logsAsc) {
    const st = String(row.status || '').toUpperCase();
    const t = new Date(row.scanned_at).getTime();
    if (Number.isNaN(t)) continue;
    if (st === 'IN') {
      if (pendingInMs !== null) {
        if (!pendingIsOvertime) {
          const virtEnd = peekRegularSegmentEnd(pendingInMs, t, regularByDay);
          if (virtEnd > pendingInMs && virtEnd < t) {
            closePendingAtOutMs(virtEnd);
          }
        }
        if (pendingInMs !== null) continue;
      }
      pendingInMs = t;
      pendingInRow = row;
      sessionSeq += 1;
      pendingSessionNum = sessionSeq;
      const dk = localDateString(new Date(t));
      pendingIsOvertime = (regularByDay.get(dk) || 0) >= REGULAR_SHIFT_CAP_MS;
    } else if (st === 'STOP') {
      if (pendingInMs !== null) {
        if (t < pendingInMs) {
          clearPending();
          continue;
        }
        closePendingAtOutMs(t);
      }
    } else if (st === 'OUT') {
      if (pendingInMs === null) continue;
      if (t < pendingInMs) {
        clearPending();
        continue;
      }
      closePendingAtOutMs(t);
    }
  }

  let currentlyWorking = false;
  let currentSessionStart = null;
  let regularAutoEnded = false;
  /** @type {number | null} */
  let pendingRegularCapEndMs = null;

  if (pendingInMs !== null) {
    currentSessionStart = new Date(pendingInMs).toISOString();
    if (!pendingIsOvertime) {
      pendingRegularCapEndMs = peekRegularSegmentEnd(
        pendingInMs,
        pendingInMs + REGULAR_PAIRING_PEEK_MS,
        regularByDay
      );
    }
    const effCloseMs = pendingIsOvertime ? closeMs : closeRegularSegmentEnd(pendingInMs, closeMs, regularByDay);
    addSegment(pendingInMs, effCloseMs);
    if (!pendingIsOvertime && pendingRegularCapEndMs != null) {
      currentlyWorking = isToday && closeMs < pendingRegularCapEndMs;
      regularAutoEnded = isToday && closeMs >= pendingRegularCapEndMs && pendingRegularCapEndMs > pendingInMs;
    } else {
      currentlyWorking = isToday;
      regularAutoEnded = false;
    }
  }

  return {
    totalMs,
    sessions,
    currentlyWorking,
    currentSessionStart,
    pendingInSourceRow: pendingInRow,
    pendingSessionNum: pendingInMs !== null ? pendingSessionNum : 0,
    pendingOvertimeSession: pendingInMs !== null && pendingIsOvertime,
    pendingRegularCapEndMs,
    regularAutoEnded,
  };
}

/**
 * @param {Array<{status:string, scanned_at:string}>} logsAsc
 * @param {{ closeMs: number, windowStartMs: number, windowEndMs: number, isToday?: boolean, carryPendingIn?: object|null }} opts
 */
function workedMsFromPairedLogs(logsAsc, opts) {
  return pairSessionsMsForWindow(logsAsc, opts).totalMs;
}

/** Pair one employee's logs for the local calendar day `dayBounds` (same rules as payroll / kiosk). */
function pairEmployeeLogsForLocalDay(logsAsc, employeeId, carryMap, dayBounds, closeMs) {
  const ws = new Date(dayBounds.startIso).getTime();
  const we = new Date(dayBounds.endIso).getTime();
  const eid = Number(employeeId);
  const carry = Number.isInteger(eid) && eid > 0 ? carryMap.get(eid) || null : null;
  return pairSessionsMsForWindow(logsAsc, {
    closeMs,
    windowStartMs: ws,
    windowEndMs: we,
    isToday: true,
    carryPendingIn: carry && String(carry.status || '').toUpperCase() === 'IN' ? carry : null,
  });
}

/** Backward-compatible: same calendar day as logs, close at now or end-of-window; no carry. */
function workedMsFromLogsAsc(logsAsc, nowMs = Date.now()) {
  if (!logsAsc || !logsAsc.length) return 0;
  let winStart = Infinity;
  let winEnd = -Infinity;
  for (const row of logsAsc) {
    const t = new Date(row.scanned_at).getTime();
    if (!Number.isNaN(t)) {
      winStart = Math.min(winStart, t);
      winEnd = Math.max(winEnd, t);
    }
  }
  if (!Number.isFinite(winStart)) return 0;
  const dayKey = localDateString(new Date(winStart));
  const b = startEndOfLocalDay(dayKey);
  if (!b) return 0;
  const windowStartMs = new Date(b.startIso).getTime();
  const windowEndMs = new Date(b.endIso).getTime();
  const todayKey = localDateString();
  const isToday = dayKey === todayKey;
  const closeMs = isToday ? nowMs : windowEndMs;
  return workedMsFromPairedLogs(logsAsc, {
    closeMs,
    windowStartMs,
    windowEndMs,
    isToday,
    carryPendingIn: null,
  });
}

const SCAN_DEBOUNCE_MS = Math.min(Math.max(Number(process.env.SCAN_DEBOUNCE_MS) || 2500, 500), 10000);

async function fetchCarryInBeforeDay(startIso) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (employee_id) employee_id, status, scanned_at, id, tank_number
     FROM scan_logs
     WHERE employee_id IS NOT NULL AND scanned_at < $1::timestamptz
     ORDER BY employee_id, scanned_at DESC, id DESC`,
    [startIso]
  );
  /** @type {Map<number, { status: string, scanned_at: string }>} */
  const map = new Map();
  for (const r of rows) {
    const id = Number(r.employee_id);
    if (Number.isInteger(id) && id > 0) map.set(id, r);
  }
  return map;
}

/**
 * Reusable daily hours for one employee (local calendar date).
 * @param {number} employeeId
 * @param {string} yyyyMmDd
 */
async function computeDailyHours(employeeId, yyyyMmDd) {
  const id = Number(employeeId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const bounds = startEndOfLocalDay(yyyyMmDd);
  if (!bounds) return null;
  const todayKey = localDateString();
  const isToday = yyyyMmDd === todayKey;
  const windowStartMs = new Date(bounds.startIso).getTime();
  const windowEndMs = new Date(bounds.endIso).getTime();
  const closeMs = isToday ? Date.now() : windowEndMs;

  const carryRes = await pool.query(
    `SELECT status, scanned_at FROM scan_logs WHERE employee_id = $1 AND scanned_at < $2::timestamptz ORDER BY scanned_at DESC, id DESC LIMIT 1`,
    [id, bounds.startIso]
  );
  const carryRow = carryRes.rows[0] || null;

  const logsRes = await pool.query(
    `SELECT status, scanned_at FROM scan_logs
     WHERE employee_id = $1 AND scanned_at >= $2::timestamptz AND scanned_at <= $3::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [id, bounds.startIso, bounds.endIso]
  );

  const paired = pairSessionsMsForWindow(logsRes.rows, {
    closeMs,
    windowStartMs,
    windowEndMs,
    isToday,
    carryPendingIn: carryRow && String(carryRow.status || '').toUpperCase() === 'IN' ? carryRow : null,
  });

  const totalHours = roundHours2(paired.totalMs / 3600000);
  return {
    date: yyyyMmDd,
    employee_id: id,
    totalHours,
    total_ms: paired.totalMs,
    sessions: paired.sessions.map((s) => ({
      in: s.in,
      out: s.out,
      duration: roundHours2(s.duration_ms / 3600000),
      duration_ms: s.duration_ms,
    })),
    currentlyWorking: isToday && paired.currentlyWorking,
    currentSessionStart: isToday && paired.currentlyWorking ? paired.currentSessionStart : null,
    pendingRegularCapEndMs: isToday ? paired.pendingRegularCapEndMs : null,
    pendingOvertimeSession: isToday ? paired.pendingOvertimeSession : false,
  };
}

/**
 * Worked hours per employee for a local-time window (carry before window start; close open IN at closeMs).
 * @param {{ startIso: string, endIso: string }} bounds
 * @param {number} closeMs
 * @returns {Promise<Map<number, number>>}
 */
async function buildWorkedHoursMapForWindow(bounds, closeMs) {
  const carryMap = await fetchCarryInBeforeDay(bounds.startIso);
  const logRes = await pool.query(
    `SELECT employee_id, employee_code, status, scanned_at, id, tank_number, note_value, note FROM scan_logs
     WHERE scanned_at >= $1::timestamptz AND scanned_at <= $2::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [bounds.startIso, bounds.endIso]
  );
  const emRes = await pool.query(`SELECT id, code FROM employees`);
  const byId = new Map();
  for (const e of emRes.rows) {
    const eid = Number(e.id);
    if (Number.isInteger(eid) && eid > 0) byId.set(eid, []);
  }
  for (const row of logRes.rows) {
    const eid = row.employee_id != null ? Number(row.employee_id) : null;
    if (eid && byId.has(eid)) byId.get(eid).push(row);
    else {
      const emp = emRes.rows.find((x) => normalizeCode(x.code) === normalizeCode(row.employee_code));
      if (emp) {
        const mappedId = Number(emp.id);
        if (byId.has(mappedId)) byId.get(mappedId).push(row);
      }
    }
  }
  const ws = new Date(bounds.startIso).getTime();
  const we = new Date(bounds.endIso).getTime();
  const spanIncludesNow = Date.now() >= ws && Date.now() <= we;
  /** @type {Map<number, number>} */
  const out = new Map();
  for (const e of emRes.rows) {
    const eid = Number(e.id);
    const list = byId.get(eid) || [];
    const carry = carryMap.get(eid);
    const paired = pairSessionsMsForWindow(list, {
      closeMs,
      windowStartMs: ws,
      windowEndMs: we,
      isToday: spanIncludesNow,
      carryPendingIn: carry && String(carry.status || '').toUpperCase() === 'IN' ? carry : null,
    });
    out.set(eid, roundHours2(paired.totalMs / 3600000));
  }
  return out;
}

async function getLatestLogForEmployeeCode(code) {
  const n = normalizeCode(code);
  if (!n) return null;
  const { rows } = await pool.query(
    `SELECT id, status, scanned_at, employee_code, employee_name
     FROM scan_logs
     WHERE REPLACE(UPPER(TRIM(COALESCE(employee_code, ''))), ' ', '') = $1
     ORDER BY scanned_at DESC, id DESC
     LIMIT 1`,
    [n]
  );
  return rows[0] || null;
}

function recentDuplicateScan(latestRow, nowMs = Date.now()) {
  if (!latestRow || !latestRow.scanned_at) return false;
  const t = new Date(latestRow.scanned_at).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t >= 0 && nowMs - t <= SCAN_DEBOUNCE_MS;
}

function isAllEmployeesParam(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return !s || s === 'all';
}

/** @param {{ scope: string, start?: string, end?: string, employee?: string }} q */
async function queryScanLogsForExport(q) {
  const scope = String(q.scope || '').toLowerCase();
  let sql = `SELECT id, employee_id, employee_code, employee_name, status, scanned_at, note, note_category, note_value, tank_number, station_name, area_name, kiosk_user FROM scan_logs WHERE 1=1`;
  const params = [];
  let p = 1;

  if (scope === 'today') {
    const day = localDateString();
    const b = startEndOfLocalDay(day);
    if (!b) return [];
    sql += ` AND scanned_at >= $${p} AND scanned_at <= $${p + 1}`;
    params.push(b.startIso, b.endIso);
    p += 2;
  } else if (scope === 'range') {
    const sb = startEndOfLocalDay(q.start || '');
    const eb = startEndOfLocalDay(q.end || '');
    if (!sb || !eb) return [];
    sql += ` AND scanned_at >= $${p} AND scanned_at <= $${p + 1}`;
    params.push(sb.startIso, eb.endIso);
    p += 2;
  }

  if (!isAllEmployeesParam(q.employee)) {
    sql += ` AND employee_code = $${p}`;
    params.push(normalizeCode(q.employee));
    p += 1;
  }

  sql += ` ORDER BY scanned_at ASC, id ASC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

function exportSpanBounds(scope, startStr, endStr, logsAll) {
  if (scope === 'today') {
    const day = localDateString();
    const b = startEndOfLocalDay(day);
    if (!b) return null;
    return { startIso: b.startIso, endIso: b.endIso };
  }
  if (scope === 'range') {
    const sb = startEndOfLocalDay(startStr || '');
    const eb = startEndOfLocalDay(endStr || '');
    if (!sb || !eb) return null;
    return { startIso: sb.startIso, endIso: eb.endIso };
  }
  if (!logsAll || !logsAll.length) {
    const b = startEndOfLocalDay(localDateString());
    return b ? { startIso: b.startIso, endIso: b.endIso } : null;
  }
  let minT = Infinity;
  let maxT = -Infinity;
  for (const l of logsAll) {
    const t = new Date(l.scanned_at).getTime();
    if (!Number.isNaN(t)) {
      minT = Math.min(minT, t);
      maxT = Math.max(maxT, t);
    }
  }
  if (!Number.isFinite(minT)) {
    const b = startEndOfLocalDay(localDateString());
    return b ? { startIso: b.startIso, endIso: b.endIso } : null;
  }
  return { startIso: new Date(minT).toISOString(), endIso: new Date(maxT).toISOString() };
}

/**
 * Payroll rows: IN→OUT pairing with optional carry before span, open session closed at min(now, span end).
 * Wage uses decimal hours × rate (8h regular, OT 1.5×). Amounts rounded to 2 decimals.
 */
async function computePayrollRowsFromScopedLogs(employeesList, logsAsc, spanStartIso, spanEndIso) {
  const spanStartMs = new Date(spanStartIso).getTime();
  const spanEndMs = new Date(spanEndIso).getTime();
  const nowMs = Date.now();
  const closeMs = Math.min(nowMs, spanEndMs);
  const spanIncludesNow = nowMs >= spanStartMs && nowMs <= spanEndMs;

  const carryRes = await pool.query(
    `SELECT DISTINCT ON (employee_id) employee_id, status, scanned_at
     FROM scan_logs
     WHERE employee_id IS NOT NULL AND scanned_at < $1::timestamptz
     ORDER BY employee_id, scanned_at DESC, id DESC`,
    [spanStartIso]
  );
  const carryById = new Map();
  for (const r of carryRes.rows) {
    const eid = Number(r.employee_id);
    if (Number.isInteger(eid) && eid > 0) carryById.set(eid, r);
  }

  const byEmpId = new Map();
  for (const e of employeesList) {
    byEmpId.set(e.id, []);
  }
  for (const log of logsAsc) {
    const eid = log.employee_id != null ? Number(log.employee_id) : null;
    if (eid && byEmpId.has(eid)) {
      byEmpId.get(eid).push(log);
    } else {
      const c = normalizeCode(log.employee_code);
      const emp = employeesList.find((x) => normalizeCode(x.code) === c);
      if (emp) byEmpId.get(emp.id).push(log);
    }
  }

  const rows = [];
  let totalHoursDecimalSum = 0;
  let totalPayroll = 0;

  for (const e of employeesList) {
    const list = byEmpId.get(e.id) || [];
    list.sort((a, b) => {
      const ta = new Date(a.scanned_at).getTime();
      const tb = new Date(b.scanned_at).getTime();
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    const carry = carryById.get(e.id);
    const paired = pairSessionsMsForWindow(list, {
      closeMs,
      windowStartMs: spanStartMs,
      windowEndMs: spanEndMs,
      isToday: spanIncludesNow,
      carryPendingIn: carry && String(carry.status || '').toUpperCase() === 'IN' ? carry : null,
    });

    const ms = paired.totalMs;
    const minutesWorked = Math.round(ms / 60000);
    const hoursDecimal = roundHours2(ms / 3600000);
    const rate = Number(e.hourly_rate);
    const safeRate = Number.isFinite(rate) && rate >= 0 ? rate : 20;
    const regularHoursDec = Math.min(hoursDecimal, 8);
    const overtimeHoursDec = Math.max(0, hoursDecimal - 8);
    const wage = roundMoney2(regularHoursDec * safeRate + overtimeHoursDec * safeRate * 1.5);
    const hoursRounded = roundWorkedHours(hoursDecimal);

    totalHoursDecimalSum += hoursDecimal;
    totalPayroll += wage;
    rows.push({
      employee_code: e.code,
      employee_name: e.name,
      is_active: !!e.is_active,
      hourly_rate: safeRate,
      minutes_worked: minutesWorked,
      rounded_minutes: hoursRounded * 60,
      hours_decimal: hoursDecimal,
      hours_rounded: hoursRounded,
      regular_hours: roundHours2(regularHoursDec),
      overtime_hours: roundHours2(overtimeHoursDec),
      wage,
    });
  }

  rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }));

  const employeeCount = employeesList.length;
  const averageHoursPerEmployee =
    employeeCount > 0 ? roundHours2(totalHoursDecimalSum / employeeCount) : 0;

  return {
    rows,
    total_hours: roundHours2(totalHoursDecimalSum),
    total_hours_decimal: roundHours2(totalHoursDecimalSum),
    total_hours_rounded: Math.round(totalHoursDecimalSum),
    total_payroll: roundMoney2(totalPayroll),
    employee_count: employeeCount,
    average_hours_per_employee: averageHoursPerEmployee,
  };
}

function scopeDescription(scope, start, end) {
  if (scope === 'today') return `Today (${localDateString()}, local)`;
  if (scope === 'range' && start && end) return `Date range: ${start} → ${end}`;
  if (scope === 'all') return 'All dates (complete log archive)';
  return scope;
}

/**
 * Unified payroll object for export + dashboard daily API compatibility.
 */
async function computePayrollForExport(scope, startStr, endStr, employeeRaw) {
  const allEmp = isAllEmployeesParam(employeeRaw);
  let employeesList;
  if (allEmp) {
    const { rows } = await pool.query(
      `SELECT id, code, name, is_active, hourly_rate FROM employees ORDER BY LOWER(name) ASC`
    );
    employeesList = rows;
  } else {
    const code = normalizeCode(employeeRaw);
    const { rows } = await pool.query(
      `SELECT id, code, name, is_active, hourly_rate FROM employees WHERE code = $1`,
      [code]
    );
    if (!rows.length) return null;
    employeesList = rows;
  }

  const logsAll = await queryScanLogsForExport({
    scope,
    start: startStr,
    end: endStr,
    employee: employeeRaw,
  });

  const span = exportSpanBounds(scope, startStr, endStr, logsAll);
  if (!span) return null;
  const base = await computePayrollRowsFromScopedLogs(employeesList, logsAll, span.startIso, span.endIso);
  enrichPayrollRowsWithScanHints(base.rows, logsAll);
  const workAnalytics = computeWorkAnalyticsFromLogs(logsAll);
  const tankCloseMs = Math.min(Date.now(), new Date(span.endIso).getTime());
  const tankSummary = computeTankSummaryFromLogs(logsAll, tankCloseMs);
  const pdfSubtitle =
    scope === 'today'
      ? 'Daily Payroll Summary'
      : scope === 'range'
        ? 'Date Range Payroll Summary'
        : 'Complete Log Summary';
  const meta = {
    scope,
    scope_label: scopeDescription(scope, startStr, endStr),
    pdf_subtitle: pdfSubtitle,
    worker_scope_line: allEmp ? 'All workers' : `Single employee · ${employeesList[0].name} (${employeesList[0].code})`,
    employee_filter: allEmp ? 'all' : normalizeCode(employeeRaw),
    employee_display: allEmp ? 'All workers' : `${employeesList[0].name} (${employeesList[0].code})`,
    is_single_employee: employeesList.length === 1 && !allEmp,
    primary_name: !allEmp ? employeesList[0].name : null,
    primary_code: !allEmp ? employeesList[0].code : null,
  };

  return {
    rounding: hoursRoundMode(),
    date: scope === 'today' ? localDateString() : null,
    range_start: scope === 'range' ? startStr : null,
    range_end: scope === 'range' ? endStr : null,
    meta,
    logs_for_appendix: logsAll,
    work_analytics: workAnalytics,
    tank_summary: tankSummary,
    ...base,
  };
}

async function computePayrollForDate(yyyyMmDd) {
  const bounds = startEndOfLocalDay(yyyyMmDd);
  if (!bounds) return null;

  const emRes = await pool.query(
    `SELECT id, code, name, is_active, hourly_rate FROM employees ORDER BY LOWER(name) ASC`
  );
  const employees = emRes.rows;

  const logRes = await pool.query(
    `SELECT employee_id, employee_code, employee_name, status, scanned_at, note, note_category, note_value
     FROM scan_logs
     WHERE scanned_at >= $1::timestamptz AND scanned_at <= $2::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [bounds.startIso, bounds.endIso]
  );

  const agg = await computePayrollRowsFromScopedLogs(employees, logRes.rows, bounds.startIso, bounds.endIso);
  return {
    date: yyyyMmDd,
    rounding: hoursRoundMode(),
    ...agg,
  };
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toFixed(2)}`;
}

function formatIsoForPdf(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatIsoForPdfCompact(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Professional internal report layout (PDFKit).
 * Helpers keep spacing tight and hierarchy clear.
 */
function buildUnifiedExportPdfBuffer(payroll) {
  return new Promise((resolve, reject) => {
    const M = { top: 46, left: 48, right: 48, bottom: 50 };
    const SECTION_GAP = 22;
    const doc = new PDFDocument({
      size: 'A4',
      margins: M,
      bufferPages: true,
      info: { Title: 'Factory Scan Report', Author: 'Factory Scan Clock' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const meta = payroll.meta || {};
    const logs = Array.isArray(payroll.logs_for_appendix) ? payroll.logs_for_appendix : [];
    const workAnalytics = Array.isArray(payroll.work_analytics) ? payroll.work_analytics : [];
    const tankSummary = Array.isArray(payroll.tank_summary) ? payroll.tank_summary : [];
    const timelineGroups = groupLogsByEmployeeTimeline(logs);
    const timeColShowsDate = exportPdfTimeColumnShowsDate(payroll);
    const contentW = doc.page.width - M.left - M.right;
    const pageBottom = () => doc.page.height - M.bottom;
    const COL = {
      title: '#0f172a',
      body: '#334155',
      muted: '#64748b',
      faint: '#94a3b8',
      border: '#e2e8f0',
      rule: '#cbd5e1',
      accent: '#2563eb',
      stripe: '#f8fafc',
      thead: '#f1f5f9',
    };

    const generatedAt = new Date().toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    function ensureY(y, need) {
      if (y + need > pageBottom() - 8) {
        doc.addPage();
        return M.top;
      }
      return y;
    }

    function pdfReportPrimaryDateLabel() {
      if (meta.scope === 'today') return payroll.date || localDateString();
      if (meta.scope === 'range' && payroll.range_start && payroll.range_end) {
        return payroll.range_start === payroll.range_end ? payroll.range_start : `${payroll.range_start} → ${payroll.range_end}`;
      }
      return 'All dates';
    }

    function drawReportHeader(y) {
      doc.font('Helvetica-Bold').fontSize(18).fillColor(COL.title).text('Factory Scan Report', M.left, y, {
        width: contentW,
        align: 'left',
      });
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(10).fillColor(COL.accent).text(meta.pdf_subtitle || 'Payroll summary', M.left, y, {
        width: contentW,
      });
      y = doc.y + 14;

      const bandH = 38;
      y = ensureY(y, bandH + 28);
      doc.save();
      doc.rect(M.left, y, contentW, bandH).fill(COL.thead);
      doc.rect(M.left, y, contentW, bandH).strokeColor(COL.border).lineWidth(0.65).stroke();
      doc.restore();

      const colW = contentW / 4;
      const metrics = [
        { label: 'Date', val: pdfReportPrimaryDateLabel() },
        {
          label: 'Total workers',
          val: String(payroll.employee_count ?? (payroll.rows || []).length ?? 0),
        },
        { label: 'Total hours', val: String(payroll.total_hours_rounded ?? 0) },
        { label: 'Total payroll', val: money(payroll.total_payroll ?? 0) },
      ];
      for (let i = 0; i < 4; i++) {
        const x = M.left + i * colW + 10;
        doc.font('Helvetica').fontSize(7).fillColor(COL.muted).text(metrics[i].label, x, y + 7, {
          width: colW - 16,
          lineBreak: false,
        });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(COL.title).text(metrics[i].val, x, y + 20, {
          width: colW - 16,
          lineBreak: false,
        });
      }
      y += bandH + 12;

      doc.moveTo(M.left, y).lineTo(M.left + contentW, y).strokeColor(COL.rule).lineWidth(0.85).stroke();
      y += 10;

      doc.font('Helvetica').fontSize(7.5).fillColor(COL.muted);
      doc.text(`Generated  ${generatedAt}`, M.left, y, { width: contentW });
      y = doc.y + 3;
      doc.text(`Filters  ${meta.scope_label || '—'} · ${meta.worker_scope_line || meta.employee_display || '—'}`, M.left, y, {
        width: contentW,
        lineGap: 1,
      });
      y = doc.y + 10;
      doc.font('Helvetica').fontSize(7.5).fillColor(COL.muted);
      doc.text(
        `Payroll uses IN→OUT pairs; incomplete pairs excluded from hours. Hours rounded (${payroll.rounding}). Work analytics use completed IN→OUT intervals only.`,
        M.left,
        y,
        { width: contentW, lineGap: 1 }
      );
      y = doc.y + 14;
      return y;
    }

    function payrollRowHeight(r) {
      let n = 0;
      if (r.pdf_hint_last_in) n += 1;
      if (r.pdf_hint_last_out) n += 1;
      if (n === 0) return 15;
      return 11 + n * 9;
    }

    function payrollNumBaseline(y, rh) {
      return y + Math.floor((rh - 8) / 2) + 1;
    }

    function drawPayrollTableAll(y) {
      const wName = Math.round(contentW * 0.32);
      const wReg = Math.round(contentW * 0.12);
      const wOt = Math.round(contentW * 0.12);
      const wRate = Math.round(contentW * 0.18);
      const wWage = contentW - wName - wReg - wOt - wRate;
      const totH = 15;
      const rows = payroll.rows || [];

      doc.font('Helvetica-Bold').fontSize(10).fillColor(COL.title).text('Payroll summary', M.left, y);
      y = doc.y + 8;

      y = ensureY(y, 28);
      doc.save();
      doc.rect(M.left, y, contentW, 18).fill(COL.thead);
      doc.rect(M.left, y, contentW, 18).strokeColor(COL.border).lineWidth(0.5).stroke();
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#475569');
      const hy = y + 5;
      doc.text('Employee', M.left + 6, hy, { width: wName - 10, lineBreak: false });
      doc.text('Regular', M.left + wName, hy, { width: wReg - 6, align: 'right', lineBreak: false });
      doc.text('OT', M.left + wName + wReg, hy, { width: wOt - 6, align: 'right', lineBreak: false });
      doc.text('Hourly rate', M.left + wName + wReg + wOt, hy, { width: wRate - 6, align: 'right', lineBreak: false });
      doc.text('Total pay', M.left + wName + wReg + wOt + wRate, hy, { width: wWage - 8, align: 'right', lineBreak: false });
      y += 18;

      let i = 0;
      for (const r of rows) {
        const rh = payrollRowHeight(r);
        y = ensureY(y, rh + 2);
        if (i % 2 === 1) {
          doc.save();
          doc.rect(M.left, y, contentW, rh).fill(COL.stripe);
          doc.restore();
        }
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COL.body);
        doc.text(r.employee_name, M.left + 6, y + 3, { width: wName - 10, lineBreak: false });
        let ty = y + 11;
        if (r.pdf_hint_last_in) {
          doc.font('Helvetica').fontSize(6).fillColor('#475569').text(
            `Last IN: ${truncatePdfCell(r.pdf_hint_last_in, 38)}`,
            M.left + 6,
            ty,
            { width: wName - 10, lineGap: 0 }
          );
          ty = doc.y + 1;
        }
        if (r.pdf_hint_last_out) {
          doc.font('Helvetica').fontSize(6).fillColor('#475569').text(
            `Last OUT: ${truncatePdfCell(r.pdf_hint_last_out, 38)}`,
            M.left + 6,
            ty,
            { width: wName - 10, lineGap: 0 }
          );
        }
        const nb = payrollNumBaseline(y, rh);
        doc.font('Helvetica').fontSize(8).fillColor(COL.body);
        doc.text(String(r.regular_hours), M.left + wName, nb, { width: wReg - 6, align: 'right', lineBreak: false });
        doc.text(String(r.overtime_hours), M.left + wName + wReg, nb, { width: wOt - 6, align: 'right', lineBreak: false });
        doc.text(money(r.hourly_rate), M.left + wName + wReg + wOt, nb, { width: wRate - 6, align: 'right', lineBreak: false });
        doc.font('Helvetica-Bold').text(money(r.wage), M.left + wName + wReg + wOt + wRate, nb, {
          width: wWage - 8,
          align: 'right',
          lineBreak: false,
        });
        doc.moveTo(M.left, y + rh).lineTo(M.left + contentW, y + rh).strokeColor(COL.border).lineWidth(0.35).stroke();
        y += rh;
        i += 1;
      }

      y = ensureY(y, totH + 10);
      doc.save();
      doc.rect(M.left, y, contentW, totH + 2).fill('#eff6ff');
      doc.rect(M.left, y, contentW, totH + 2).strokeColor(COL.rule).lineWidth(0.75).stroke();
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COL.title);
      doc.text('Totals', M.left + 6, y + 4, { width: wName - 12, lineBreak: false });
      doc.text(String(payroll.total_hours_rounded), M.left + wName, y + 4, { width: wReg - 6, align: 'right', lineBreak: false });
      doc.fillColor(COL.muted).font('Helvetica', 8).text('—', M.left + wName + wReg, y + 4, {
        width: wOt - 6,
        align: 'right',
        lineBreak: false,
      });
      doc.fillColor(COL.muted).font('Helvetica', 8).text('—', M.left + wName + wReg + wOt, y + 4, {
        width: wRate - 6,
        align: 'right',
        lineBreak: false,
      });
      doc.fillColor(COL.title).font('Helvetica-Bold', 8);
      doc.text(money(payroll.total_payroll), M.left + wName + wReg + wOt + wRate, y + 4, {
        width: wWage - 8,
        align: 'right',
        lineBreak: false,
      });
      y += totH + 10;
      return y;
    }

    function drawSingleEmployeeSummary(y) {
      if (!meta.is_single_employee || !payroll.rows || !payroll.rows[0]) return y;
      const r = payroll.rows[0];
      y = ensureY(y, 62);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COL.title).text('Employee summary', M.left, y);
      y = doc.y + 6;
      doc.save();
      doc.rect(M.left, y, contentW, 50).fill('#ffffff');
      doc.rect(M.left, y, contentW, 50).strokeColor(COL.border).lineWidth(0.6).stroke();
      doc.restore();
      const x = M.left + 10;
      let yy = y + 8;
      doc.font('Helvetica-Bold').fontSize(8.2).fillColor(COL.body).text(`Employee: ${r.employee_name}`, x, yy, { width: contentW - 20 });
      yy = doc.y + 2;
      doc.font('Helvetica').fontSize(7.8).fillColor(COL.muted).text(`Code: ${r.employee_code}`, x, yy, { width: contentW - 20 });
      yy = doc.y + 6;
      doc.font('Helvetica-Bold').fontSize(7.7).fillColor(COL.body).text('Work summary:', x, yy, { width: contentW - 20 });
      yy = doc.y + 2;
      doc.font('Helvetica').fontSize(7.4).fillColor('#475569').text(
        `Last IN activity: ${r.pdf_hint_last_in ? truncatePdfCell(r.pdf_hint_last_in, 58) : '-'}`,
        x,
        yy,
        { width: contentW - 20 }
      );
      yy = doc.y + 1;
      doc.text(`Last OUT reason: ${r.pdf_hint_last_out ? truncatePdfCell(r.pdf_hint_last_out, 58) : '-'}`, x, yy, {
        width: contentW - 20,
      });
      return y + 58;
    }

    function drawScanLogSection(y) {
      const pad = 6;
      const inner = contentW - pad * 2;
      const wS = Math.round(inner * 0.13);
      const wT = Math.round(inner * 0.22);
      const wTank = Math.round(inner * 0.17);
      const wA = inner - wS - wT - wTank;

      y = ensureY(y, 40);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COL.title).text('Scan events', M.left, y);
      y = doc.y + 4;
      doc.save();
      doc.rect(M.left, y, 3, 12).fill(COL.accent);
      doc.restore();
      doc.font('Helvetica').fontSize(7.5).fillColor(COL.muted).text(
        `${logs.length} event(s), chronological · includes IN/OUT reason or activity notes`,
        M.left + 10,
        y,
        { width: contentW - 10 }
      );
      y = doc.y + 14;

      y = ensureY(y, 22);
      doc.save();
      doc.rect(M.left, y, contentW, 16).fill(COL.thead);
      doc.rect(M.left, y, contentW, 16).strokeColor(COL.border).lineWidth(0.5).stroke();
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#475569');
      const hh = y + 4;
      doc.text('Status', M.left + pad, hh, { width: wS - pad, align: 'center', lineBreak: false });
      doc.text('Timestamp', M.left + pad + wS, hh, { width: wT - 8, lineBreak: false });
      doc.text('Tank #', M.left + pad + wS + wT, hh, { width: wTank - 8, lineBreak: false });
      doc.text('Reason / Activity', M.left + pad + wS + wT + wTank, hh, { width: wA - pad, lineBreak: false });
      y += 16;

      if (logs.length === 0) {
        y = ensureY(y, 20);
        doc.font('Helvetica').fontSize(8).fillColor(COL.faint).text('No scan events in this scope.', M.left + 6, y + 4, {
          width: contentW - 12,
        });
        return y + 18;
      }

      let ix = 0;
      for (const row of logs) {
        const tStr = formatPdfScanLineTime(row.scanned_at, timeColShowsDate);
        const baseReason = pdfScanActivityRaw(row);
        const tankText = row.tank_number && String(row.tank_number).trim() !== '' ? String(row.tank_number).trim() : '-';
        const reasonLine = meta.is_single_employee
          ? baseReason
          : `${row.employee_name} (${row.employee_code}) — ${baseReason}`;
        const reasonText = truncatePdfCell(reasonLine, 50);
        const rowH = 14;
        y = ensureY(y, rowH + 2);
        if (ix % 2 === 1) {
          doc.save();
          doc.rect(M.left, y, contentW, rowH).fill(COL.stripe);
          doc.restore();
        }
        doc.font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor(pdfStatusColor(row.status))
          .text(String(row.status), M.left + pad, y + 3, { width: wS - pad, align: 'center', lineBreak: false });
        doc.font('Helvetica').fontSize(7.5).fillColor(COL.body).text(tStr, M.left + pad + wS, y + 3, {
          width: wT - 8,
          lineBreak: false,
        });
        doc.font('Helvetica').fillColor(COL.body).text(tankText, M.left + pad + wS + wT, y + 3, {
          width: wTank - 8,
          lineBreak: false,
        });
        doc.font('Helvetica').fillColor('#475569').text(reasonText, M.left + pad + wS + wT + wTank, y + 3, {
          width: wA - pad,
          lineBreak: false,
        });
        doc.moveTo(M.left, y + rowH).lineTo(M.left + contentW, y + rowH).strokeColor(COL.border).lineWidth(0.25).stroke();
        y += rowH;
        ix += 1;
      }
      return y + 6;
    }

    function drawTankSummarySection(y) {
      y = ensureY(y, 36);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COL.title).text('Tank summary', M.left, y);
      y = doc.y + 8;
      if (!tankSummary.length) {
        doc.font('Helvetica').fontSize(8).fillColor(COL.faint).text('No tank data in this scope.', M.left, y, { width: contentW });
        return y + 10;
      }
      for (const t of tankSummary) {
        y = ensureY(y, 18);
        const acts = t.activities && t.activities.length ? t.activities.join(', ') : '-';
        doc.font('Helvetica').fontSize(8).fillColor(COL.body).text(
          `${t.tank_number}  |  Workers: ${t.workers}  |  Labor: ${t.total_labor_hours} hrs  |  Activities: ${truncatePdfCell(acts, 56)}`,
          M.left + 2,
          y,
          { width: contentW - 4, lineBreak: false }
        );
        y += 12;
      }
      return y + 4;
    }

    function drawEmployeeTimelineSection(y) {
      y = ensureY(y, 36);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COL.title).text('Employee timelines', M.left, y);
      y = doc.y + 5;
      doc.font('Helvetica').fontSize(7.5).fillColor(COL.muted).text('Per worker, same order as payroll filters · oldest first within each block', M.left, y, {
        width: contentW,
      });
      y = doc.y + 12;

      if (timelineGroups.length === 0) {
        y = ensureY(y, 18);
        doc.font('Helvetica').fontSize(8).fillColor(COL.faint).text('No timeline data.', M.left, y, { width: contentW });
        return y + 14;
      }

      const lineH = 13;
      const gapAfterBlock = 14;

      for (const bundle of timelineGroups) {
        const blockNeed = 28 + bundle.logs.length * lineH + gapAfterBlock;
        y = ensureY(y, blockNeed);

        doc.font('Helvetica-Bold').fontSize(9).fillColor(COL.title).text(`${bundle.employee_name} (${bundle.employee_code})`, M.left, y, {
          width: contentW,
        });
        y = doc.y + 6;
        doc.moveTo(M.left, y).lineTo(M.left + contentW, y).strokeColor(COL.border).lineWidth(0.5).stroke();
        y += 8;

        for (const row of bundle.logs) {
          const tStr = formatPdfScanLineTime(row.scanned_at, timeColShowsDate);
          doc.font('Helvetica').fontSize(8).fillColor(COL.body).text(tStr, M.left, y, { width: 52, lineBreak: false });
          doc.font('Helvetica-Bold')
            .fillColor(pdfStatusColor(row.status))
            .text(row.status, M.left + 54, y, { width: 34, lineBreak: false });
          doc.font('Helvetica').fillColor(COL.body).text('→', M.left + 92, y, { width: 14, lineBreak: false });
          doc.font('Helvetica').fillColor('#475569').text(pdfScanActivityTrunc(row, 52), M.left + 106, y, {
            width: contentW - 106,
            lineBreak: false,
          });
          y += lineH;
        }

        y += gapAfterBlock;
      }
      return y;
    }

    function drawWorkAnalyticsSection(y) {
      y = ensureY(y, 36);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COL.title).text('Work analytics', M.left, y);
      y = doc.y + 5;
      doc.font('Helvetica').fontSize(7.5).fillColor(COL.muted).text('Hours by clock-in activity (IN→OUT segments only)', M.left, y, {
        width: contentW,
      });
      y = doc.y + 14;

      if (workAnalytics.length === 0) {
        y = ensureY(y, 18);
        doc.font('Helvetica').fontSize(8).fillColor(COL.faint).text('No analytics in this scope.', M.left, y, { width: contentW });
        return y + 12;
      }

      for (const emp of workAnalytics) {
        const lines = Math.max(1, emp.activities.length) + 3;
        y = ensureY(y, lines * 12 + 10);

        doc.font('Helvetica-Bold').fontSize(9).fillColor(COL.body).text(`${emp.employee_name} — work summary`, M.left, y, {
          width: contentW,
        });
        y = doc.y + 6;

        if (!emp.activities.length) {
          doc.font('Helvetica').fontSize(8).fillColor(COL.faint).text('No completed IN→OUT work intervals.', M.left + 8, y, {
            width: contentW - 16,
          });
          y = doc.y + 14;
          continue;
        }

        for (const a of emp.activities) {
          doc.font('Helvetica').fontSize(8).fillColor('#475569').text(`• ${truncatePdfCell(a.label, 42)}: ${a.hours} hrs`, M.left + 10, y, {
            width: contentW - 18,
          });
          y = doc.y + 2;
        }
        y += 10;
        doc.moveTo(M.left + 8, y).lineTo(M.left + contentW - 8, y).strokeColor(COL.border).lineWidth(0.35).stroke();
        y += 12;
      }
      return y;
    }

    function drawPageNumbers() {
      const rng = doc.bufferedPageRange();
      for (let i = 0; i < rng.count; i++) {
        doc.switchToPage(rng.start + i);
        doc.font('Helvetica').fontSize(7).fillColor(COL.faint);
        doc.text(`Page ${i + 1} of ${rng.count}`, M.left, doc.page.height - 28, {
          width: contentW,
          align: 'center',
        });
        doc.text('Factory Scan Clock · internal use', M.left, doc.page.height - 18, {
          width: contentW,
          align: 'center',
        });
      }
    }

    let y = M.top;
    y = drawReportHeader(y);
    y = drawPayrollTableAll(y);
    y = drawSingleEmployeeSummary(y);
    y += SECTION_GAP;
    y = drawScanLogSection(y);
    y += SECTION_GAP;
    y = drawEmployeeTimelineSection(y);
    y += SECTION_GAP;
    y = drawTankSummarySection(y);
    y += SECTION_GAP;
    y = drawWorkAnalyticsSection(y);

    try {
      drawPageNumbers();
    } catch (e) {
      /* ignore footer if switchToPage unsupported */
    }

    doc.end();
  });
}

async function getLatestLogForCode(code) {
  const n = normalizeCode(code);
  if (!n) return null;
  const { rows } = await pool.query(
    `SELECT id, employee_code, employee_name, status, scanned_at, tank_number, note_value, note, note_category
     FROM scan_logs
     WHERE REPLACE(UPPER(TRIM(COALESCE(employee_code, ''))), ' ', '') = $1
     ORDER BY scanned_at DESC, id DESC
     LIMIT 1`,
    [n]
  );
  return rows[0] || null;
}

/**
 * Pair today's logs for one employee (local calendar day) using the same rules as payroll hours.
 * @returns {Promise<ReturnType<typeof pairSessionsMsForWindow> & { latestRow: object | null }>}
 */
async function getTodayPairingStateForEmployeeCode(code) {
  const employee = await getEmployeeByCode(code);
  if (!employee) {
    return {
      totalMs: 0,
      sessions: [],
      currentlyWorking: false,
      currentSessionStart: null,
      pendingInSourceRow: null,
      pendingSessionNum: 0,
      pendingOvertimeSession: false,
      pendingRegularCapEndMs: null,
      regularAutoEnded: false,
      latestRow: null,
    };
  }
  const eid = Number(employee.id);
  const day = startEndOfLocalDay(localDateString());
  if (!day) {
    return {
      totalMs: 0,
      sessions: [],
      currentlyWorking: false,
      currentSessionStart: null,
      pendingInSourceRow: null,
      pendingSessionNum: 0,
      pendingOvertimeSession: false,
      pendingRegularCapEndMs: null,
      regularAutoEnded: false,
      latestRow: null,
    };
  }
  const dayClose = Math.min(Date.now(), new Date(day.endIso).getTime());
  const ws = new Date(day.startIso).getTime();
  const we = new Date(day.endIso).getTime();
  const carryMap = await fetchCarryInBeforeDay(day.startIso);
  const carry = carryMap.get(eid) || null;
  const { rows } = await pool.query(
    `SELECT employee_id, employee_code, status, scanned_at, id, tank_number, note_value, note
     FROM scan_logs
     WHERE employee_id = $1 AND scanned_at >= $2::timestamptz AND scanned_at <= $3::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [eid, day.startIso, day.endIso]
  );
  const latestRes = await pool.query(
    `SELECT id, employee_code, employee_name, status, scanned_at, tank_number, note_value, note, note_category
     FROM scan_logs
     WHERE REPLACE(UPPER(TRIM(COALESCE(employee_code, ''))), ' ', '') = $1
     ORDER BY scanned_at DESC, id DESC
     LIMIT 1`,
    [normalizeCode(code)]
  );
  const latestRow = latestRes.rows[0] || null;
  const paired = pairSessionsMsForWindow(rows, {
    closeMs: dayClose,
    windowStartMs: ws,
    windowEndMs: we,
    isToday: true,
    carryPendingIn: carry && String(carry.status || '').toUpperCase() === 'IN' ? carry : null,
  });
  return { ...paired, latestRow };
}

async function getCurrentActiveInSessionByCode(code) {
  const paired = await getTodayPairingStateForEmployeeCode(code);
  if (!paired.currentlyWorking || !paired.pendingInSourceRow) return null;
  const latest = paired.latestRow;
  if (latest && String(latest.status || '').toUpperCase() === 'STOP') return null;
  const row = paired.pendingInSourceRow;
  return isProductionInRow(row) ? row : null;
}

async function resolveExpectedNextStatus(code) {
  const paired = await getTodayPairingStateForEmployeeCode(code);
  const latest = paired.latestRow;
  if (!latest) return 'IN';
  const st = String(latest.status || '').toUpperCase();
  if (st === 'OUT' || st === 'STOP') return 'IN';
  if (paired.currentlyWorking) return 'OUT';
  return 'IN';
}

function isApiPath(p) {
  return String(p || '').startsWith('/api/');
}

function isRoleAllowed(role, allowed) {
  return allowed.includes(String(role || '').toUpperCase());
}

function authJson(res, status, message, error = 'auth') {
  return res.status(status).json({ ok: false, error, message });
}

function sessionUserToAuth(u) {
  if (!u) return null;
  return {
    id: Number(u.id),
    username: String(u.username),
    role: String(u.role || '').toUpperCase(),
    station_name: u.station_name ? String(u.station_name) : null,
    area_name: u.area_name ? String(u.area_name) : null,
  };
}

function currentManagerFromSession(req) {
  const u = req.session && req.session.manager_user;
  return sessionUserToAuth(u);
}

function currentKioskFromSession(req) {
  const u = req.session && req.session.kiosk_user;
  return sessionUserToAuth(u);
}

function currentAuthFromSession(req) {
  return currentManagerFromSession(req) || currentKioskFromSession(req);
}

function requireRoles(allowedRoles, authResolver = currentAuthFromSession, redirectTo = '/login') {
  return (req, res, next) => {
    const auth = authResolver(req);
    req.auth = auth;
    if (!auth) {
      if (isApiPath(req.path)) return authJson(res, 401, 'Login required.', 'not_authenticated');
      return res.redirect(redirectTo);
    }
    if (!isRoleAllowed(auth.role, allowedRoles)) {
      if (isApiPath(req.path)) return authJson(res, 403, 'Forbidden.', 'forbidden');
      return res.status(403).type('text').send('Forbidden');
    }
    return next();
  };
}

const requireManager = requireRoles([ROLE.MANAGER], currentManagerFromSession, '/manager-login');
const requireKiosk = requireRoles([ROLE.KIOSK], currentKioskFromSession, '/kiosk-login');
const requireScanRole = requireRoles([ROLE.MANAGER, ROLE.KIOSK], currentAuthFromSession, '/manager-login');

app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    console.error('[boot] database unavailable:', formatDbError(err));
    res.status(503).json({
      ok: false,
      error: 'database_unavailable',
      message: 'Database connection failed. Check DATABASE_URL and PostgreSQL service.',
    });
  }
});

app.get('/api/auth/me', (req, res) => {
  const auth = currentAuthFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Login required.' });
  return res.json({ ok: true, user: auth });
});

app.get('/api/debug/finished-jobs-test', (_req, res) => {
  console.log('[finished-jobs] debug test endpoint called');
  return res.json({
    success: true,
    count: 1,
    jobs: [
      {
        employeeName: 'TEST EMPLOYEE',
        employeeCode: 'EMP999',
        tankNumber: 'TEST-TANK',
        activityName: 'TEST ACTIVITY',
        area: 'Fabrication',
        finishedAt: '2026-06-02T19:00:00',
        durationMinutes: 5,
      },
    ],
  });
});

app.get('/api/auth/me-kiosk', (req, res) => {
  const auth = currentKioskFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Kiosk login required.' });
  return res.json({ ok: true, user: auth });
});

app.get('/api/kiosk/work-config', (req, res) => {
  const auth = currentKioskFromSession(req) || currentAuthFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Kiosk login required.' });
  }
  const area = auth.area_name ? String(auth.area_name) : '';
  const activities = getKioskActivitiesForArea(area);
  const stop_reasons = [
    { code: 'CLEAN_UP', label: 'Clean Up', barcode: 'STOP:CLEAN_UP' },
    { code: 'LUNCH', label: 'Lunch', barcode: 'STOP:LUNCH' },
    { code: 'BREAK', label: 'Break', barcode: 'STOP:BREAK' },
    { code: 'MATERIAL', label: 'Material', barcode: 'STOP:MATERIAL' },
    { code: 'MAINTENANCE_DOWNTIME', label: 'Maintenance/Downtime', barcode: 'STOP:MAINTENANCE_DOWNTIME' },
  ];
  const out_reasons = [{ code: 'END_SHIFT', label: 'End Shift', barcode: 'REASON:END_SHIFT' }];
  return res.json({
    ok: true,
    area_name: displayKioskAreaName(area),
    production_areas: KIOSK_PRODUCTION_AREAS,
    activities,
    stop_reasons,
    out_reasons,
  });
});

app.get('/api/kiosk/finished-jobs', async (req, res) => {
  const auth = currentKioskFromSession(req) || currentAuthFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Login required.' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 100);
  const employeeCode = req.query.employee_code ? String(req.query.employee_code).trim() : '';
  const tankNumber = req.query.tank_number ? String(req.query.tank_number).trim() : '';
  const todayOnly = req.query.today_only === '1' || req.query.today_only === 'true';
  let finishedAfter;
  let finishedBefore;
  if (todayOnly) {
    const day = startEndOfLocalDay(localDateString());
    if (day) {
      finishedAfter = day.startIso;
      finishedBefore = day.endIso;
    }
  }
  let areaName = '';
  const areaQuery = req.query.area ? String(req.query.area).trim() : '';
  if (areaQuery && areaQuery.toUpperCase() !== 'ALL') {
    areaName = resolveFinishJobsAreaFilter(areaQuery) || areaQuery;
  } else if (String(auth.role || '').toUpperCase() === ROLE.KIOSK && auth.area_name) {
    areaName = String(auth.area_name);
  }
  try {
    const rows = await fetchFinishJobEvents({
      employeeCode: employeeCode || undefined,
      tankNumber: tankNumber || undefined,
      areaName: !employeeCode && !tankNumber && areaName ? areaName : undefined,
      finishedAfter,
      finishedBefore,
      limit,
    });
    return res.json({ ok: true, rows });
  } catch (err) {
    console.error('[kiosk finished-jobs]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load finished jobs.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body && req.body.username ? req.body.username : '').trim().toLowerCase();
  const password = String(req.body && req.body.password ? req.body.password : '');
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'username and password are required.' });
  }
  const user = await getUserByUsername(username);
  if (!user || !user.is_active) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Invalid username or password.' });
  }
  if (!verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Invalid username or password.' });
  }
  req.session.manager_user = {
    id: user.id,
    username: user.username,
    role: user.role,
    station_name: user.station_name || null,
    area_name: user.area_name || null,
  };
  const role = String(user.role || '').toUpperCase();
  return res.json({
    ok: true,
    role,
    redirect: role === ROLE.MANAGER ? '/manager-dashboard' : '/scan',
  });
});

/**
 * Kiosk quick login: area + 4–6 digit PIN (stored hashed). Rate-limited on failures per IP.
 */
app.post('/api/auth/login-kiosk-pin', async (req, res) => {
  const ip = clientIp(req);
  if (!pinRateLimitAllow(ip)) {
    return res
      .status(429)
      .json({ ok: false, error: 'rate_limited', message: 'Too many PIN attempts. Try again in about a minute.' });
  }
  const area = String(req.body && req.body.area != null ? req.body.area : '').trim();
  const pinRaw = String(req.body && req.body.pin != null ? req.body.pin : '').trim();
  const username = KIOSK_AREA_TO_USERNAME[area];
  if (!username || !/^\d{4,6}$/.test(pinRaw)) {
    recordPinFailure(ip);
    return res.status(400).json({ ok: false, error: 'validation', message: 'Select an area and enter a 4–6 digit PIN.' });
  }
  const user = await getUserByUsername(username);
  if (!user || !user.is_active || String(user.role).toUpperCase() !== ROLE.KIOSK) {
    recordPinFailure(ip);
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Incorrect PIN.' });
  }
  if (!user.pin_hash || !verifyPassword(pinRaw, user.pin_hash)) {
    recordPinFailure(ip);
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Incorrect PIN.' });
  }
  pinRateLimitReset(ip);
  req.session.kiosk_user = {
    id: user.id,
    username: user.username,
    role: user.role,
    station_name: user.station_name || null,
    area_name: user.area_name || null,
  };
  return res.json({
    ok: true,
    role: ROLE.KIOSK,
    redirect: kioskLandingPathForUser(req.session.kiosk_user),
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) delete req.session.manager_user;
  if (req.session && !req.session.kiosk_user) {
    req.session.save(() => res.json({ ok: true }));
    return;
  }
  if (req.session) {
    req.session.save(() => res.json({ ok: true }));
    return;
  }
  res.json({ ok: true });
});

app.post('/api/auth/kiosk-logout', (req, res) => {
  if (req.session) delete req.session.kiosk_user;
  if (req.session && !req.session.manager_user) {
    req.session.save(() => res.json({ ok: true }));
    return;
  }
  if (req.session) {
    req.session.save(() => res.json({ ok: true }));
    return;
  }
  res.json({ ok: true });
});

app.use((req, res, next) => {
  const p = String(req.path || '');
  if (
    p === '/login' ||
    p === '/manager-login' ||
    p === '/kiosk-login' ||
    p === '/install' ||
    p === '/install.html' ||
    p.startsWith('/api/auth/') ||
    p.startsWith('/api/debug/')
  ) {
    return next();
  }
  if (p === '/kiosk' || p === '/ipad-scan' || p === '/qa-qc') return requireKiosk(req, res, next);
  if (
    p === '/scan' ||
    p === '/scan/' ||
    p === '/scan.html' ||
    p === '/scan.js' ||
    p === '/scan.css' ||
    p === '/ipad-scan'
  ) {
    return requireScanRole(req, res, next);
  }
  if (p === '/admin.html' || p === '/summary.html' || p === '/index.html' || p === '/system.html') {
    return requireManager(req, res, next);
  }
  if (p === '/system') {
    return requireManager(req, res, next);
  }
  if (
    p === '/manager-dashboard' ||
    p === '/manager' ||
    p === '/manager/tank-print' ||
    p === '/manager/command-print' ||
    p === '/dashboard' ||
    p === '/'
  ) {
    return requireManager(req, res, next);
  }
  if (p.startsWith('/api/kiosk/')) {
    return requireKiosk(req, res, next);
  }
  if (p.startsWith('/api/scan')) {
    return requireScanRole(req, res, next);
  }
  if (
    p.startsWith('/api/manager/') ||
    p.startsWith('/api/owner/') ||
    p.startsWith('/api/employees') ||
    p.startsWith('/api/tanks') ||
    p.startsWith('/api/export') ||
    p.startsWith('/api/payroll') ||
    p.startsWith('/api/summary') ||
    p.startsWith('/api/status') ||
    p.startsWith('/api/logs') ||
    p.startsWith('/api/scan_logs') ||
    p.startsWith('/api/dashboard/finished-jobs') ||
    p.startsWith('/api/admin/') ||
    p.startsWith('/api/system/')
  ) {
    return requireManager(req, res, next);
  }
  return next();
});

/** Kiosk GET employee — JSON only; registered with other /api routes (not only before static). */
async function handleKioskEmployeeLookup(req, res) {
  try {
    const rawParam = req.params && req.params.code != null ? String(req.params.code) : '';
    const code = normalizeCode(rawParam);
    console.log('[kiosk lookup] code:', code || rawParam);
    if (!code) {
      return res.status(400).json({
        ok: false,
        error: 'missing_code',
        message: 'Missing employee code',
      });
    }

    const employee = await getEmployeeByCode(code);
    if (!employee) {
      console.log('[kiosk lookup] employee not found for:', code);
      return res.status(404).json({
        ok: false,
        error: 'unknown_employee',
        message: 'Employee not found',
      });
    }

    console.log('[kiosk lookup] employee found:', employee.name);
    if (!employee.is_active) {
      return res.status(403).json({
        ok: false,
        error: 'inactive_employee',
        message: 'Employee is inactive.',
      });
    }

    const paired = await getTodayPairingStateForEmployeeCode(code);
    const latest = paired.latestRow || (await getLatestLogForCode(code));
    const workState = await getEmployeeKioskWorkState(code);
    const next_status = await resolveExpectedNextStatus(code);

    let current_status = workState.phase;
    if (latest && String(latest.status || '').toUpperCase() === 'IN' && !paired.currentlyWorking) {
      current_status = 'OUT';
    }

    const staleRegularAuto =
      latest &&
      String(latest.status || '').toUpperCase() === 'IN' &&
      !paired.currentlyWorking &&
      paired.regularAutoEnded &&
      !paired.pendingOvertimeSession;
    let kiosk_notice = null;
    if (next_status === 'IN' && staleRegularAuto) {
      kiosk_notice = 'Regular shift auto-ended at 8 hours. Overtime started.';
    }

    let current_session_type = null;
    if (workState.on_clock && workState.phase === 'IN') {
      current_session_type = paired.pendingOvertimeSession ? 'OVERTIME' : 'REGULAR';
    }

    console.log('[kiosk lookup] current_status:', current_status);

    return res.json({
      ok: true,
      employee: {
        id: employee.id,
        code: String(employee.code),
        name: String(employee.name),
      },
      current_status,
      phase: workState.phase,
      next_status,
      currently_working: workState.on_clock,
      active_tank_number: workState.current_tank || workState.resume_tank,
      current_activity: workState.current_activity || workState.resume_activity,
      has_active_job: workState.has_active_job,
      waiting_for_job: workState.waiting_for_job,
      stop_reason: workState.stop_reason,
      resume_activity: workState.resume_activity,
      resume_tank: workState.resume_tank,
      current_session_type,
      kiosk_notice,
    });
  } catch (err) {
    console.error('[kiosk employee lookup error]', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error',
      message: err && err.message ? String(err.message) : 'Server error',
    });
  }
}

app.get('/api/kiosk/employee/:code', handleKioskEmployeeLookup);
console.log('[kiosk] registered GET /api/kiosk/employee/:code');

app.post('/api/scan', async (req, res) => {
  const code = normalizeCode(req.body && req.body.code);
  if (!code) {
    return res.status(400).json({ ok: false, error: 'invalid_code', message: 'Missing or empty barcode.' });
  }

  const employee = await getEmployeeByCode(code);
  if (!employee) {
    return res.status(404).json({ ok: false, error: 'unknown_employee', message: 'Unknown barcode.' });
  }
  if (!employee.is_active) {
    return res.status(403).json({ ok: false, error: 'inactive_employee', message: 'Employee is inactive.' });
  }

  const latestAny = await getLatestLogForEmployeeCode(code);
  if (recentDuplicateScan(latestAny)) {
    return res.status(429).json({
      ok: false,
      error: 'duplicate_scan',
      message: 'Duplicate scan ignored. Please wait a moment before scanning again.',
    });
  }

  const workState = await getEmployeeKioskWorkState(code);
  if (workState.phase === 'STOP') {
    return res.status(409).json({
      ok: false,
      error: 'employee_stopped',
      message: 'Employee is on STOP. Use the kiosk to resume or clock out.',
    });
  }

  const status = await resolveExpectedNextStatus(code);
  const scannedAt = nowIso();

  /** Notes are set via PATCH after the modal (WORK on IN, REASON on OUT). */
  const ins = await pool.query(
    `INSERT INTO scan_logs (employee_code, employee_name, employee_id, status, scanned_at, note, note_category, note_value, tank_number)
     VALUES ($1, $2, $3, $4, $5::timestamptz, NULL, NULL, NULL, NULL)
     RETURNING id`,
    [code, employee.name, employee.id, status, scannedAt]
  );

  return res.json({
    ok: true,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status,
    scanned_at: scannedAt,
    log_id: ins.rows[0].id,
  });
});

app.post('/api/scan/resolve', async (req, res) => {
  const code = normalizeCode(req.body && req.body.code);
  if (!code) return res.status(400).json({ ok: false, error: 'invalid_code', message: 'Missing or empty barcode.' });
  const employee = await getEmployeeByCode(code);
  if (!employee) return res.status(404).json({ ok: false, error: 'unknown_employee', message: 'Unknown barcode.' });
  if (!employee.is_active) return res.status(403).json({ ok: false, error: 'inactive_employee', message: 'Employee is inactive.' });
  const status = await resolveExpectedNextStatus(code);
  const activeIn = await getCurrentActiveInSessionByCode(code);
  res.json({
    ok: true,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status,
    active_tank_number: activeIn && activeIn.tank_number ? String(activeIn.tank_number) : null,
  });
});

async function postScanRecord(req, res) {
  const auth = req.auth || currentAuthFromSession(req) || null;
  const code = normalizeCode(req.body && req.body.employee_code);
  const status = String((req.body && req.body.status) || '').toUpperCase();
  const noteCategory = normalizeNoteCategory(req.body && req.body.note_category);
  const noteValue = normalizeNoteValue(req.body && req.body.note_value);
  const tankRaw = normalizeTankNumber(req.body && req.body.tank_number);
  if (!code) return res.status(400).json({ ok: false, error: 'validation', message: 'employee_code is required.' });
  if (status !== 'IN' && status !== 'OUT') {
    return res.status(400).json({ ok: false, error: 'validation', message: 'status must be IN or OUT.' });
  }
  const employee = await getEmployeeByCode(code);
  if (!employee) return res.status(404).json({ ok: false, error: 'unknown_employee', message: 'Unknown employee.' });
  if (!employee.is_active) return res.status(403).json({ ok: false, error: 'inactive_employee', message: 'Employee is inactive.' });

  const latestAny = await getLatestLogForEmployeeCode(code);
  if (recentDuplicateScan(latestAny)) {
    return res.status(429).json({
      ok: false,
      error: 'duplicate_scan',
      message: 'Duplicate scan ignored. Please wait a moment before scanning again.',
    });
  }

  const pairedBefore = await getTodayPairingStateForEmployeeCode(code);
  const expected = await resolveExpectedNextStatus(code);
  if (expected !== status) {
    return res.status(409).json({ ok: false, error: 'status_mismatch', message: `Expected ${expected} for this employee.` });
  }

  if (status === 'IN') {
    if (noteCategory !== 'WORK' || !noteValue) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'IN requires WORK activity.' });
    }
    if (!tankRaw) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'IN requires tank_number.' });
    }
  }
  if (status === 'OUT') {
    if (noteCategory !== 'REASON' || !noteValue) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'OUT requires REASON.' });
    }
  }

  const activeIn = await getCurrentActiveInSessionByCode(code);
  const resolvedTank = status === 'IN' ? tankRaw : tankRaw || (activeIn && activeIn.tank_number ? normalizeTankNumber(activeIn.tank_number) : null);
  const stationName = auth && auth.role === ROLE.KIOSK ? auth.station_name || null : null;
  const areaName = auth && auth.role === ROLE.KIOSK ? auth.area_name || null : null;
  const kioskUser = auth && auth.role === ROLE.KIOSK ? auth.username || null : null;
  if (resolvedTank) {
    const tankRow = await ensureTankExists(resolvedTank);
    if (status === 'IN' && tankRow && normalizeTankStatus(tankRow.status) === 'archived') {
      return res.status(403).json({
        ok: false,
        error: 'tank_archived',
        message: 'This tank is completed. Restore it in Tank Management before assigning work.',
      });
    }
  }
  const scannedAt = nowIso();

  let kiosk_message = null;
  if (status === 'OUT' && pairedBefore.currentlyWorking && pairedBefore.pendingOvertimeSession) {
    kiosk_message = 'Overtime ended.';
  }

  const ins = await pool.query(
    `INSERT INTO scan_logs (employee_code, employee_name, employee_id, status, scanned_at, note, note_category, note_value, tank_number, station_name, area_name, kiosk_user)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      code,
      employee.name,
      employee.id,
      status,
      scannedAt,
      noteValue,
      noteCategory,
      noteValue,
      resolvedTank,
      stationName,
      areaName,
      kioskUser,
    ]
  );
  res.json({
    ok: true,
    log_id: ins.rows[0].id,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status,
    note_category: noteCategory,
    note_value: noteValue,
    tank_number: resolvedTank,
    station_name: stationName,
    area_name: areaName,
    kiosk_user: kioskUser,
    scanned_at: scannedAt,
    kiosk_message,
  });
}

app.post('/api/scan/record', postScanRecord);
/** Kiosk multi-step flow: same body as /api/scan/record (single INSERT when all fields collected). */
app.post('/api/kiosk/complete-scan', postScanRecord);

app.post('/api/kiosk/work-action', async (req, res) => {
  try {
    await performKioskWorkAction(req, res);
  } catch (err) {
    console.error('[kiosk work-action]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not process scan action.' });
  }
});

/**
 * Adjust kiosk status rows so DB "IN" that is auto-ended after 8h shows as OUT (no extra DB writes).
 * @param {Array<object>} rowsFromDb
 */
async function applyEffectiveStatusToKioskRows(rowsFromDb) {
  const day = startEndOfLocalDay(localDateString());
  if (!day || !rowsFromDb.length) return rowsFromDb;
  const dayClose = Math.min(Date.now(), new Date(day.endIso).getTime());
  const carryMap = await fetchCarryInBeforeDay(day.startIso);
  const codes = [...new Set(rowsFromDb.map((r) => normalizeCode(r.employee_code)).filter(Boolean))];
  if (!codes.length) return rowsFromDb;
  const { rows: emRows } = await pool.query(
    `SELECT id, code FROM employees WHERE REPLACE(UPPER(TRIM(COALESCE(code, ''))), ' ', '') = ANY($1::text[])`,
    [codes]
  );
  const idByCode = new Map();
  for (const er of emRows) {
    idByCode.set(normalizeCode(er.code), Number(er.id));
  }
  const eids = [...new Set([...idByCode.values()].filter((n) => Number.isInteger(n) && n > 0))];
  if (!eids.length) return rowsFromDb;
  const logRes = await pool.query(
    `SELECT employee_id, employee_code, status, scanned_at, id, tank_number, note_value, note
     FROM scan_logs
     WHERE employee_id = ANY($1::int[])
       AND scanned_at >= $2::timestamptz AND scanned_at <= $3::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [eids, day.startIso, day.endIso]
  );
  const byEmpId = new Map();
  for (const id of eids) byEmpId.set(id, []);
  for (const lg of logRes.rows) {
    const eid = Number(lg.employee_id);
    if (byEmpId.has(eid)) byEmpId.get(eid).push(lg);
  }
  const pairCache = new Map();
  for (const id of eids) {
    pairCache.set(id, pairEmployeeLogsForLocalDay(byEmpId.get(id) || [], id, carryMap, day, dayClose));
  }
  return rowsFromDb.map((r) => {
    const c = normalizeCode(r.employee_code);
    const eid = idByCode.get(c);
    if (!eid) return r;
    const paired = pairCache.get(eid);
    if (!paired) return r;
    let status = r.status;
    const st = String(status || '').toUpperCase();
    if (st === 'IN' && !paired.currentlyWorking) {
      status = 'OUT';
    } else if (st === 'STOP') {
      status = 'STOP';
    }
    return { ...r, status };
  });
}

app.get('/api/kiosk/status', async (req, res) => {
  try {
    const kioskAuth = currentKioskFromSession(req);
    const kioskArea = kioskAuth && kioskAuth.area_name ? String(kioskAuth.area_name).trim() : '';
    if (!kioskArea) {
      return res.status(400).json({
        ok: false,
        error: 'kiosk_area_missing',
        message: 'Kiosk area is missing from session.',
      });
    }

    const { rows } = await pool.query(
      `WITH latest_logs AS (
         SELECT DISTINCT ON (l.employee_id)
           l.employee_id,
           l.employee_code,
           l.employee_name,
           l.status,
           l.note_value,
           l.note,
           l.tank_number,
           l.area_name,
           l.station_name,
           l.scanned_at
         FROM scan_logs l
         WHERE l.employee_id IS NOT NULL
         ORDER BY l.employee_id, l.scanned_at DESC, l.id DESC
       )
       SELECT
         e.code AS employee_code,
         e.name AS employee_name,
         e.is_active AS is_active,
         latest_logs.status AS status,
         NULLIF(TRIM(latest_logs.note_value), '') AS note_value,
         NULLIF(TRIM(latest_logs.note), '') AS note,
         latest_logs.tank_number AS tank_number,
         latest_logs.area_name AS area_name,
         latest_logs.station_name AS station_name,
         latest_logs.scanned_at AS scanned_at
       FROM latest_logs
       JOIN employees e ON e.id = latest_logs.employee_id
       WHERE TRIM(COALESCE(latest_logs.area_name, '')) = $1
       ORDER BY LOWER(e.name) ASC`,
      [kioskArea]
    );

    const adjusted = await applyEffectiveStatusToKioskRows(rows);

    return res.json({
      ok: true,
      kiosk_area: kioskArea,
      rows: adjusted.map((r) => {
        const st = ['IN', 'OUT', 'STOP'].includes(String(r.status || '').toUpperCase())
          ? String(r.status).toUpperCase()
          : 'OUT';
        const noteVal = r.note_value ? String(r.note_value) : null;
        const noteText = r.note ? String(r.note).trim() : '';
        const stopReason = st === 'STOP' ? noteVal : null;
        const jobActivity =
          st === 'STOP' && noteText && noteText !== '-' && noteText !== noteVal ? noteText : null;
        return {
        employee_code: String(r.employee_code || ''),
        employee_name: String(r.employee_name || ''),
        status: st,
        note_value: noteVal,
        stop_reason: stopReason,
        job_activity: jobActivity,
        display_activity: st === 'STOP' ? jobActivity || '—' : noteVal,
        tank_number: r.tank_number ? String(r.tank_number) : null,
        area_name: r.area_name ? String(r.area_name) : null,
        station_name: r.station_name ? String(r.station_name) : null,
        scanned_at: r.scanned_at || null,
        is_active: Number(r.is_active) ? 1 : 0,
      };
      }),
    });
  } catch (err) {
    console.error('[kiosk status error]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Failed to load kiosk status.' });
  }
});

app.patch('/api/scan_logs/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id', message: 'Invalid log id.' });
  }
  const sel = await pool.query(`SELECT id, status FROM scan_logs WHERE id = $1`, [id]);
  const row = sel.rows[0];
  if (!row) {
    return res.status(404).json({ ok: false, error: 'not_found', message: 'Log row not found.' });
  }

  const body = req.body || {};
  const hasNoteCategory = Object.prototype.hasOwnProperty.call(body, 'note_category');
  const hasNoteValue = Object.prototype.hasOwnProperty.call(body, 'note_value');
  const hasNotePayload = hasNoteCategory || hasNoteValue;
  const hasTankPayload = Object.prototype.hasOwnProperty.call(body, 'tank_number');
  if (!hasNotePayload && !hasTankPayload) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Provide note and/or tank_number.' });
  }

  const catIn = body.note_category;
  const valIn = body.note_value;
  const cat = normalizeNoteCategory(catIn);
  const val = normalizeNoteValue(valIn);
  const tank = hasTankPayload ? normalizeTankNumber(body.tank_number) : null;

  if (hasNotePayload) {
    if (cat == null && val == null) {
      await pool.query(`UPDATE scan_logs SET note = NULL, note_category = NULL, note_value = NULL WHERE id = $1`, [id]);
    } else {
      if (!val) {
        return res.status(400).json({ ok: false, error: 'validation', message: 'note_value required when saving a note.' });
      }
      if (!cat) {
        return res.status(400).json({ ok: false, error: 'validation', message: 'note_category must be WORK or REASON.' });
      }
      if (row.status === 'IN' && cat !== 'WORK') {
        return res.status(400).json({ ok: false, error: 'validation', message: 'Clock-in notes must use category WORK.' });
      }
      if (row.status === 'OUT' && cat !== 'REASON') {
        return res.status(400).json({ ok: false, error: 'validation', message: 'Clock-out notes must use category REASON.' });
      }
      await pool.query(`UPDATE scan_logs SET note_category = $1, note_value = $2, note = $3 WHERE id = $4`, [cat, val, val, id]);
    }
  }

  let tankNumber = null;
  if (hasTankPayload) {
    if (tank) await ensureTankExists(tank);
    tankNumber = tank;
    await pool.query(`UPDATE scan_logs SET tank_number = $1 WHERE id = $2`, [tankNumber, id]);
  }

  const latestRes = await pool.query(`SELECT id, note_category, note_value, tank_number FROM scan_logs WHERE id = $1`, [id]);
  const latest = latestRes.rows[0];
  return res.json({
    ok: true,
    id,
    note_category: latest.note_category,
    note_value: latest.note_value,
    tank_number: latest.tank_number,
  });
});

app.get('/api/status', async (_req, res) => {
  const day = localDateString();
  const bounds = startEndOfLocalDay(day);
  let scansToday = 0;
  if (bounds) {
    const cRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM scan_logs WHERE scanned_at >= $1 AND scanned_at <= $2`,
      [bounds.startIso, bounds.endIso]
    );
    scansToday = cRes.rows[0].c;
  }

  const emRes = await pool.query(
    `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees ORDER BY LOWER(name) ASC`
  );
  const employees = emRes.rows;
  const workedMap = bounds ? await buildWorkedHoursMapForWindow(bounds, Math.min(Date.now(), new Date(bounds.endIso).getTime())) : new Map();
  const dayLogsByEmpId = new Map();
  if (bounds) {
    const dayLogsRes = await pool.query(
      `SELECT employee_id, employee_code, status, scanned_at, id, note_value, note, tank_number
       FROM scan_logs
       WHERE scanned_at >= $1::timestamptz AND scanned_at <= $2::timestamptz
       ORDER BY scanned_at ASC, id ASC`,
      [bounds.startIso, bounds.endIso]
    );
    for (const row of dayLogsRes.rows) {
      const eid = row.employee_id != null ? Number(row.employee_id) : null;
      if (!eid) continue;
      if (!dayLogsByEmpId.has(eid)) dayLogsByEmpId.set(eid, []);
      dayLogsByEmpId.get(eid).push(row);
    }
  }

  const payload = [];
  for (const e of employees) {
    const latestRes = await pool.query(
      `SELECT status, scanned_at, id FROM scan_logs WHERE employee_code = $1 ORDER BY scanned_at DESC, id DESC LIMIT 1`,
      [e.code]
    );
    const latest = latestRes.rows[0];
    let current_status = 'OUT';
    let last_scan_at = null;
    if (latest) {
      last_scan_at = latest.scanned_at;
    }
    const daily = await computeDailyHours(Number(e.id), day);
    if (latest) {
      const s = String(latest.status || '').toUpperCase();
      if (s === 'IN' && daily && !daily.currentlyWorking) current_status = 'OUT';
      else current_status = s;
    }
    const startMs =
      daily && daily.currentlyWorking && daily.currentSessionStart
        ? new Date(daily.currentSessionStart).getTime()
        : NaN;
    let effNow = Date.now();
    if (daily && daily.currentlyWorking && !daily.pendingOvertimeSession && daily.pendingRegularCapEndMs != null) {
      const cap = Number(daily.pendingRegularCapEndMs);
      if (Number.isFinite(cap)) effNow = Math.min(Date.now(), cap);
    }
    let elapsed_seconds = 0;
    let elapsed_paused = false;
    if (current_status === 'STOP' && latest) {
      const logs = dayLogsByEmpId.get(Number(e.id)) || [];
      const inStartMs = activeSessionStartMsBeforeStop(logs, latest);
      const stopMs = new Date(latest.scanned_at).getTime();
      if (inStartMs != null && Number.isFinite(stopMs)) {
        elapsed_seconds = Math.max(0, Math.floor((stopMs - inStartMs) / 1000));
      }
      elapsed_paused = true;
    } else if (daily && daily.currentlyWorking && Number.isFinite(startMs)) {
      elapsed_seconds = Math.max(0, Math.floor((effNow - startMs) / 1000));
    }
    payload.push({
      id: e.id,
      code: e.code,
      name: e.name,
      is_active: !!e.is_active,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
      current_status,
      last_scan_at,
      daily_hours: Number.isFinite(Number(workedMap.get(Number(e.id)))) ? Number(workedMap.get(Number(e.id))) : 0,
      currently_working: !!(daily && daily.currentlyWorking),
      current_session_start: daily && daily.currentlyWorking ? daily.currentSessionStart : null,
      elapsed_seconds,
      elapsed_paused,
    });
  }

  res.json({ ok: true, scans_today: scansToday, employees: payload });
});

app.get('/api/dashboard/finished-jobs', async (req, res) => {
  console.log('[finished-jobs] endpoint called');
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const todayOnly = req.query.today_only !== '0' && req.query.today_only !== 'false';
  const area = req.query.area ? String(req.query.area).trim() : 'ALL';
  try {
    const jobs = await fetchDashboardFinishedJobs({ area, todayOnly, limit });
    console.log('[finished-jobs] rows found:', jobs.length);
    return res.json({ success: true, count: jobs.length, jobs });
  } catch (err) {
    console.error('[finished-jobs] error:', err);
    return res.status(500).json({
      success: false,
      count: 0,
      jobs: [],
      error: 'server_error',
      message: err && err.message ? err.message : 'Could not load finished jobs.',
    });
  }
});

app.get('/api/dashboard', async (_req, res) => {
  const [status, payroll] = await Promise.all([
    (async () => {
      const r = await pool.query(`SELECT 1`);
      void r;
      return null;
    })(),
    computePayrollForDate(localDateString()),
  ]);
  void status;
  const statusRes = await (async () => {
    const day = localDateString();
    const bounds = startEndOfLocalDay(day);
    let scansToday = 0;
    if (bounds) {
      const cRes = await pool.query(
        `SELECT COUNT(*)::int AS c FROM scan_logs WHERE scanned_at >= $1::timestamptz AND scanned_at <= $2::timestamptz`,
        [bounds.startIso, bounds.endIso]
      );
      scansToday = cRes.rows[0].c;
    }
    const emRes = await pool.query(
      `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees ORDER BY LOWER(name) ASC`
    );
    const workedMap = bounds ? await buildWorkedHoursMapForWindow(bounds, Math.min(Date.now(), new Date(bounds.endIso).getTime())) : new Map();
    const out = [];
    for (const e of emRes.rows) {
      const latestRes = await pool.query(
        `SELECT status, scanned_at FROM scan_logs WHERE employee_code = $1 ORDER BY scanned_at DESC, id DESC LIMIT 1`,
        [e.code]
      );
      const latest = latestRes.rows[0];
      const daily = await computeDailyHours(Number(e.id), day);
      let current_status = 'OUT';
      if (latest) {
        const s = String(latest.status || '').toUpperCase();
        if (s === 'IN' && daily && !daily.currentlyWorking) current_status = 'OUT';
        else current_status = s;
      }
      out.push({
        id: e.id,
        code: e.code,
        name: e.name,
        is_active: !!e.is_active,
        hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
        current_status,
        last_scan_at: latest ? latest.scanned_at : null,
        daily_hours: Number.isFinite(Number(workedMap.get(Number(e.id)))) ? Number(workedMap.get(Number(e.id))) : 0,
        currently_working: !!(daily && daily.currentlyWorking),
        current_session_start: daily && daily.currentlyWorking ? daily.currentSessionStart : null,
      });
    }
    return { scans_today: scansToday, employees: out };
  })();
  res.json({
    ok: true,
    date: localDateString(),
    scans_today: statusRes.scans_today,
    employees: statusRes.employees,
    payroll: payroll || null,
  });
});

app.get('/api/logs', async (req, res) => {
  let limit = Number(req.query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(Math.floor(limit), 500);

  const { rows } = await pool.query(
    `SELECT id, employee_id, employee_code, employee_name, status, scanned_at, note, note_category, note_value, tank_number, station_name, area_name, kiosk_user
     FROM scan_logs ORDER BY scanned_at DESC, id DESC LIMIT $1`,
    [limit]
  );

  res.json({ ok: true, logs: rows });
});

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildLogsCsvRows(rows) {
  const header = [
    'id',
    'employee_id',
    'employee_code',
    'employee_name',
    'status',
    'scanned_at',
    'note_category',
    'note_value',
    'tank_number',
    'station_name',
    'area_name',
    'kiosk_user',
    'note_display',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.id),
        csvEscape(r.employee_id),
        csvEscape(r.employee_code),
        csvEscape(r.employee_name),
        csvEscape(r.status),
        csvEscape(r.scanned_at),
        csvEscape(r.note_category),
        csvEscape(r.note_value),
        csvEscape(r.tank_number),
        csvEscape(r.station_name),
        csvEscape(displayKioskAreaName(r.area_name)),
        csvEscape(r.kiosk_user),
        csvEscape(formatLogNoteDisplay(r)),
      ].join(',')
    );
  }
  return lines.join('\r\n');
}

function csvExportFilename(scope, start, end, employeeKey) {
  const emp = isAllEmployeesParam(employeeKey) ? '' : `_${normalizeCode(employeeKey)}`;
  if (scope === 'today') return `scan_logs${emp}_today_${localDateString()}.csv`;
  if (scope === 'range') return `scan_logs${emp}_${start}_to_${end}.csv`;
  return `scan_logs${emp}_all.csv`;
}

function pdfExportFilename(scope, start, end, employeeKey) {
  const emp = isAllEmployeesParam(employeeKey) ? 'all' : normalizeCode(employeeKey);
  if (scope === 'today') return `factory_scan_report_${emp}_today_${localDateString()}.pdf`;
  if (scope === 'range') return `factory_scan_report_${emp}_${start}_to_${end}.pdf`;
  return `factory_scan_report_${emp}_all.pdf`;
}

/** Unified CSV + PDF export: format, scope, date range, employee filter. */
app.get('/api/export', async (req, res) => {
  const format = String(req.query.format || '').toLowerCase();
  const scope = String(req.query.scope || '').toLowerCase();
  const employeeRaw = req.query.employee !== undefined ? String(req.query.employee) : 'all';
  const start = req.query.start ? String(req.query.start) : '';
  const end = req.query.end ? String(req.query.end) : '';

  if (format !== 'csv' && format !== 'pdf') {
    return res.status(400).json({ ok: false, error: 'invalid_format', message: 'format must be csv or pdf.' });
  }
  if (!['today', 'range', 'all'].includes(scope)) {
    return res.status(400).json({ ok: false, error: 'invalid_scope', message: 'scope must be today, range, or all.' });
  }

  if (scope === 'range') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !parseLocalDate(start)) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'scope=range requires valid start (YYYY-MM-DD).' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !parseLocalDate(end)) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'scope=range requires valid end (YYYY-MM-DD).' });
    }
    const sb = startEndOfLocalDay(start);
    const eb = startEndOfLocalDay(end);
    if (new Date(sb.startIso) > new Date(eb.endIso)) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'start must be before or equal to end.' });
    }
  }

  let employeeKey = employeeRaw;
  if (!isAllEmployeesParam(employeeRaw)) {
    const emp = await getEmployeeByCode(normalizeCode(employeeRaw));
    if (!emp) {
      return res.status(404).json({ ok: false, error: 'employee_not_found', message: 'No employee with that code.' });
    }
    employeeKey = normalizeCode(employeeRaw);
  } else {
    employeeKey = 'all';
  }

  const logs = await queryScanLogsForExport({
    scope,
    start,
    end,
    employee: employeeKey,
  });

  if (format === 'csv') {
    const fname = csvExportFilename(scope, start, end, employeeKey);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send('\ufeff' + buildLogsCsvRows(logs));
  }

  try {
    const payroll = await computePayrollForExport(scope, start, end, employeeKey);
    if (!payroll) {
      return res.status(404).json({ ok: false, error: 'employee_not_found', message: 'No employee with that code.' });
    }
    const buffer = await buildUnifiedExportPdfBuffer(payroll);
    const fname = pdfExportFilename(scope, start, end, employeeKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(buffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'pdf_failed', message: 'PDF generation failed.' });
  }
});

async function summaryForLocalDate(yyyyMmDd) {
  const bounds = startEndOfLocalDay(yyyyMmDd);
  if (!bounds) return null;

  const emRes = await pool.query(`SELECT code, name, is_active FROM employees ORDER BY LOWER(name) ASC`);
  const employees = emRes.rows;

  const logRes = await pool.query(
    `SELECT employee_code, employee_name, status, scanned_at, note, note_category, note_value
     FROM scan_logs
     WHERE scanned_at >= $1 AND scanned_at <= $2
     ORDER BY scanned_at ASC, id ASC`,
    [bounds.startIso, bounds.endIso]
  );
  const logs = logRes.rows;

  const byCode = new Map();
  for (const e of employees) {
    byCode.set(e.code, {
      employee_code: e.code,
      employee_name: e.name,
      is_active: !!e.is_active,
      first_in: null,
      last_out: null,
      total_scans: 0,
      current_status: 'OUT',
      last_event_at: null,
    });
  }

  for (const log of logs) {
    let row = byCode.get(log.employee_code);
    if (!row) {
      row = {
        employee_code: log.employee_code,
        employee_name: log.employee_name,
        is_active: true,
        first_in: null,
        last_out: null,
        total_scans: 0,
        current_status: 'OUT',
        last_event_at: null,
      };
      byCode.set(log.employee_code, row);
    }
    row.total_scans += 1;
    if (log.status === 'IN') {
      if (!row.first_in) row.first_in = log.scanned_at;
    }
    if (log.status === 'OUT') {
      row.last_out = log.scanned_at;
    }
    row.current_status = log.status;
    row.last_event_at = log.scanned_at;
  }

  const rows = Array.from(byCode.values()).sort((a, b) =>
    a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' })
  );

  return { date: yyyyMmDd, rows };
}

app.get('/api/summary/today', async (_req, res) => {
  const day = localDateString();
  const s = await summaryForLocalDate(day);
  if (!s) return res.status(400).json({ ok: false, error: 'invalid_date' });
  res.json({ ok: true, ...s });
});

app.get('/api/summary', async (req, res) => {
  const q = req.query.date ? String(req.query.date) : localDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q) || !parseLocalDate(q)) {
    return res.status(400).json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
  }
  const s = await summaryForLocalDate(q);
  res.json({ ok: true, ...s });
});

app.get('/api/payroll/today', async (_req, res) => {
  const day = localDateString();
  const p = await computePayrollForDate(day);
  if (!p) return res.status(400).json({ ok: false, error: 'invalid_date' });
  res.json({ ok: true, ...p });
});

app.get('/api/payroll', async (req, res) => {
  const q = req.query.date ? String(req.query.date) : localDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q) || !parseLocalDate(q)) {
    return res.status(400).json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
  }
  const p = await computePayrollForDate(q);
  if (!p) return res.status(400).json({ ok: false, error: 'invalid_date' });
  res.json({ ok: true, ...p });
});

async function loadEmployeesForBadges({ ids, activeOnly, roleOverride }) {
  let rows;
  if (ids && ids.length) {
    const r = await pool.query(
      `SELECT id, code, name, badge_role FROM employees WHERE id = ANY($1::bigint[]) ORDER BY LOWER(name) ASC`,
      [ids]
    );
    rows = r.rows;
  } else if (activeOnly) {
    const r = await pool.query(
      `SELECT id, code, name, badge_role FROM employees WHERE is_active = 1 ORDER BY LOWER(name) ASC`
    );
    rows = r.rows;
  } else {
    const r = await pool.query(`SELECT id, code, name, badge_role FROM employees ORDER BY LOWER(name) ASC`);
    rows = r.rows;
  }
  return rows.map((e) => {
    const fromDb =
      e.badge_role != null && e.badge_role !== undefined ? String(e.badge_role).trim() : '';
    return {
      name: e.name,
      code: e.code,
      badge_role: roleOverride || fromDb,
    };
  });
}

app.get('/api/employees/badges.pdf', async (req, res) => {
  try {
    const activeOnly = req.query.active_only !== '0' && req.query.active_only !== 'false';
    const roleOverride = req.query.role ? String(req.query.role).trim() : null;
    let ids = null;
    if (req.query.ids) {
      ids = String(req.query.ids)
        .split(',')
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
    const employees = await loadEmployeesForBadges({
      ids: ids && ids.length ? ids : null,
      activeOnly: ids && ids.length ? false : activeOnly,
      roleOverride,
    });
    if (!employees.length) {
      return res.status(404).json({ ok: false, message: 'No employees found for badge print.' });
    }
    const buf = await buildEmployeeBadgesPdfBuffer(employees);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="fgt-employee-badges.pdf"');
    return res.send(buf);
  } catch (err) {
    console.error('[badge pdf] batch', err);
    return res.status(500).json({ ok: false, message: err.message || 'Could not generate badges.' });
  }
});

app.get('/api/employees/:id/badge.pdf', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: 'Invalid employee id.' });
  }
  try {
    const roleOverride = req.query.role ? String(req.query.role).trim() : null;
    const employees = await loadEmployeesForBadges({ ids: [id], activeOnly: false, roleOverride });
    if (!employees.length) {
      return res.status(404).json({ ok: false, message: 'Employee not found.' });
    }
    const buf = await buildEmployeeBadgesPdfBuffer(employees);
    const code = String(employees[0].code || 'employee').replace(/[^\w-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="fgt-badge-${code}.pdf"`);
    return res.send(buf);
  } catch (err) {
    console.error('[badge pdf] single', err);
    return res.status(500).json({ ok: false, message: err.message || 'Could not generate badge.' });
  }
});

app.get('/api/employees', async (req, res) => {
  const search = req.query.search ? String(req.query.search).trim() : '';
  const day = localDateString();
  const bounds = startEndOfLocalDay(day);
  const workedMap = bounds ? await buildWorkedHoursMapForWindow(bounds, Math.min(Date.now(), new Date(bounds.endIso).getTime())) : new Map();
  let rows;
  if (search) {
    const safe = search.replace(/%/g, '').replace(/_/g, '');
    const pattern = `%${safe}%`;
    const r = await pool.query(
      `SELECT id, code, name, is_active, hourly_rate, badge_role, created_at, updated_at FROM employees
       WHERE lower(code) LIKE lower($1) OR lower(name) LIKE lower($2)
       ORDER BY LOWER(name) ASC`,
      [pattern, pattern]
    );
    rows = r.rows;
  } else {
    const r = await pool.query(
      `SELECT id, code, name, is_active, hourly_rate, badge_role, created_at, updated_at FROM employees ORDER BY LOWER(name) ASC`
    );
    rows = r.rows;
  }
  res.json({
    ok: true,
    employees: rows.map((e) => ({
      ...e,
      is_active: !!e.is_active,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
      badge_role: e.badge_role ? String(e.badge_role) : '',
      daily_hours: Number.isFinite(Number(workedMap.get(Number(e.id)))) ? Number(workedMap.get(Number(e.id))) : 0,
    })),
  });
});

app.get('/api/employees/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id', message: 'Invalid employee id.' });
  }
  const r = await pool.query(
    'SELECT id, code, name, is_active, hourly_rate, badge_role, created_at, updated_at FROM employees WHERE id = $1',
    [id]
  );
  if (!r.rows.length) {
    return res.status(404).json({ ok: false, error: 'not_found', message: 'Employee not found.' });
  }
  const e = r.rows[0];
  return res.json({
    ok: true,
    employee: {
      ...e,
      is_active: !!e.is_active,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
      badge_role: e.badge_role ? String(e.badge_role) : '',
    },
  });
});

app.post('/api/employees', async (req, res) => {
  const code = normalizeCode(req.body && req.body.code);
  const name = req.body && req.body.name !== undefined ? String(req.body.name).trim() : '';
  if (!code || !name) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'code and name are required.' });
  }
  const hourly_rate = parseHourlyRate(req.body && req.body.hourly_rate);
  const badge_role = parseBadgeRoleInput(req.body);

  const ts = nowIso();
  try {
    const ins = await pool.query(
      `INSERT INTO employees (code, name, is_active, hourly_rate, badge_role, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5::timestamptz, $6::timestamptz)
       RETURNING id, code, name, is_active, hourly_rate, badge_role, created_at, updated_at`,
      [code, name, hourly_rate, badge_role, ts, ts]
    );
    const created = ins.rows[0];
    return res.status(201).json({
      ok: true,
      employee: {
        ...created,
        is_active: !!created.is_active,
        hourly_rate: Number(created.hourly_rate),
      },
    });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'duplicate_code', message: 'Employee code already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not create employee.' });
  }
});

app.put('/api/employees/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const ex = await pool.query('SELECT id FROM employees WHERE id = $1', [id]);
  if (!ex.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });

  const code = normalizeCode(req.body && req.body.code);
  const name = req.body && req.body.name !== undefined ? String(req.body.name).trim() : '';
  if (!code || !name) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'code and name are required.' });
  }
  const hourly_rate = parseHourlyRate(req.body && req.body.hourly_rate);
  const statusRaw = String((req.body && req.body.status) || '').trim().toUpperCase();
  const is_active = statusRaw === 'INACTIVE' ? 0 : 1;
  const badge_role = parseBadgeRoleInput(req.body);

  const ts = nowIso();
  try {
    await pool.query(
      `UPDATE employees SET code = $1, name = $2, hourly_rate = $3, is_active = $4, badge_role = $5, updated_at = $6::timestamptz WHERE id = $7`,
      [code, name, hourly_rate, is_active, badge_role, ts, id]
    );
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'duplicate_code', message: 'Employee code already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not update employee.' });
  }

  const updatedRes = await pool.query(
    'SELECT id, code, name, is_active, hourly_rate, badge_role, created_at, updated_at FROM employees WHERE id = $1',
    [id]
  );
  const updated = updatedRes.rows[0];
  res.json({
    success: true,
    ok: true,
    employee: {
      ...updated,
      is_active: !!updated.is_active,
      hourly_rate: Number(updated.hourly_rate),
      badge_role: updated.badge_role ? String(updated.badge_role) : '',
    },
  });
});

app.delete('/api/employees/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const del = await pool.query('DELETE FROM employees WHERE id = $1', [id]);
  if (del.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

app.patch('/api/employees/:id/toggle-active', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const rowRes = await pool.query('SELECT id, is_active FROM employees WHERE id = $1', [id]);
  const row = rowRes.rows[0];
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

  const next = row.is_active ? 0 : 1;
  const ts = nowIso();
  await pool.query('UPDATE employees SET is_active = $1, updated_at = $2::timestamptz WHERE id = $3', [next, ts, id]);
  const updatedRes = await pool.query(
    'SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees WHERE id = $1',
    [id]
  );
  const updated = updatedRes.rows[0];
  res.json({
    ok: true,
    employee: { ...updated, is_active: !!updated.is_active, hourly_rate: Number(updated.hourly_rate) },
  });
});

app.get('/api/tanks', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const statusFilter = String(req.query.status || 'active').trim().toLowerCase();
  const activeOnly = String(req.query.active_only || '').toLowerCase() === '1';
  let sql = `SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE 1=1`;
  const params = [];
  let n = 1;
  if (statusFilter === 'active') {
    sql += ` AND (LOWER(TRIM(COALESCE(status, ''))) = 'active' OR TRIM(COALESCE(status, '')) = '')`;
  } else if (statusFilter === 'archived') {
    sql += ` AND LOWER(TRIM(status)) = 'archived'`;
  } else if (statusFilter === 'all') {
    if (activeOnly) sql += ` AND (LOWER(TRIM(COALESCE(status, ''))) = 'active' OR TRIM(COALESCE(status, '')) = '')`;
  } else {
    return res.status(400).json({
      ok: false,
      error: 'validation',
      message: 'status filter must be active, completed, or all.',
    });
  }
  if (search) {
    sql += ` AND (tank_number ILIKE $${n} OR COALESCE(description, '') ILIKE $${n})`;
    params.push(`%${search}%`);
    n += 1;
  }
  sql += ` ORDER BY CASE WHEN LOWER(TRIM(COALESCE(status, ''))) IN ('active', '') THEN 0 ELSE 1 END, updated_at DESC, tank_number ASC`;
  const { rows } = await pool.query(sql, params);
  res.json({ ok: true, tanks: rows.map(mapTankRowForApi) });
});

app.post('/api/tanks', async (req, res) => {
  const tank_number = normalizeTankNumber(req.body && req.body.tank_number);
  const description = req.body && req.body.description != null ? String(req.body.description).trim().slice(0, 120) : '';
  if (!tank_number) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'tank_number is required.' });
  }
  const ts = nowIso();
  try {
    const ins = await pool.query(
      `INSERT INTO tanks (tank_number, description, status, created_at, updated_at) VALUES ($1, $2, 'active', $3::timestamptz, $4::timestamptz)
       RETURNING id`,
      [tank_number, description, ts, ts]
    );
    const tid = ins.rows[0].id;
    const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [tid]);
    return res.status(201).json({ ok: true, tank: mapTankRowForApi(tankRes.rows[0]) });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'duplicate_tank', message: 'Tank number already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not create tank.' });
  }
});

app.put('/api/tanks/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const current = await pool.query(`SELECT id, status FROM tanks WHERE id = $1`, [id]);
  if (!current.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const tank_number = normalizeTankNumber(req.body && req.body.tank_number);
  const description = req.body && req.body.description != null ? String(req.body.description).trim().slice(0, 120) : '';
  const status =
    req.body && req.body.status != null && String(req.body.status).trim() !== ''
      ? normalizeTankStatus(req.body.status)
      : normalizeTankStatus(current.rows[0].status);
  if (!tank_number) return res.status(400).json({ ok: false, error: 'validation', message: 'tank_number is required.' });
  const ts = nowIso();
  try {
    const becomingArchived = status === 'archived' && normalizeTankStatus(current.rows[0].status) !== 'archived';
    const becomingActive = status === 'active' && normalizeTankStatus(current.rows[0].status) === 'archived';
    const completedAt = becomingArchived ? ts : becomingActive ? null : undefined;
    if (completedAt !== undefined) {
      await pool.query(
        `UPDATE tanks SET tank_number = $1, description = $2, status = $3, completed_at = $4, updated_at = $5::timestamptz WHERE id = $6`,
        [tank_number, description, status, completedAt, ts, id]
      );
    } else {
      await pool.query(`UPDATE tanks SET tank_number = $1, description = $2, status = $3, updated_at = $4::timestamptz WHERE id = $5`, [
        tank_number,
        description,
        status,
        ts,
        id,
      ]);
    }
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'duplicate_tank', message: 'Tank number already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not update tank.' });
  }
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  res.json({ ok: true, tank: mapTankRowForApi(tankRes.rows[0]) });
});

app.patch('/api/tanks/:id/archive', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const rowRes = await pool.query(`SELECT id FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const status = normalizeTankStatus(req.body && req.body.status ? req.body.status : 'archived');
  const ts = nowIso();
  await pool.query(`UPDATE tanks SET status = $1, completed_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $3`, [
    status,
    ts,
    id,
  ]);
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  res.json({ ok: true, tank: mapTankRowForApi(tankRes.rows[0]) });
});

app.patch('/api/tanks/:id/restore', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const rowRes = await pool.query(`SELECT id FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const ts = nowIso();
  await pool.query(`UPDATE tanks SET status = 'active', completed_at = NULL, updated_at = $1::timestamptz WHERE id = $2`, [ts, id]);
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  res.json({ ok: true, tank: mapTankRowForApi(tankRes.rows[0]) });
});

app.get('/api/tanks/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  if (!tankRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found', message: 'Tank not found.' });
  const tank = mapTankRowForApi(tankRes.rows[0]);
  const logsAsc = await fetchTankLaborLogs(tank.tank_number);
  const emRes = await pool.query(`SELECT id, code, name, hourly_rate FROM employees`);
  const employeesByCode = new Map();
  for (const e of emRes.rows) {
    employeesByCode.set(normalizeCode(e.code), e);
  }
  const report = computeTankLaborReport(tank.tank_number, logsAsc, employeesByCode, Date.now());
  const finishedJobs = await fetchFinishJobEvents({ tankNumber: tank.tank_number, limit: 50 });
  res.json({
    ok: true,
    tank: {
      id: tank.id,
      tank_number: tank.tank_number,
      description: tank.description,
      status: tank.status,
      registry_status: tankRes.rows[0].status,
      created_at: tank.created_at,
      completed_at: tank.completed_at,
      duration_ms: tank.duration_ms,
      duration_display: tank.duration_display,
    },
    summary: report.summary,
    employeeBreakdown: report.employeeBreakdown,
    activityBreakdown: report.activityBreakdown,
    sessions: report.sessions,
    finished_jobs: finishedJobs,
  });
});

async function managerCurrentWorkRows() {
  const emRes = await pool.query(`SELECT id, code, name, hourly_rate FROM employees WHERE is_active = 1`);
  const employees = emRes.rows;
  const day = startEndOfLocalDay(localDateString());
  const week = weekBoundsLocal();
  if (!day) return [];
  const dayClose = Math.min(Date.now(), new Date(day.endIso).getTime());
  const weekClose = Math.min(Date.now(), new Date(week.endIso).getTime());
  const dailyMap = await buildWorkedHoursMapForWindow(day, dayClose);
  const weeklyMap = await buildWorkedHoursMapForWindow(week, weekClose);
  const carryMap = await fetchCarryInBeforeDay(day.startIso);
  const logRes = await pool.query(
    `SELECT employee_id, employee_code, status, scanned_at, id, tank_number, note_value, note, area_name, station_name, kiosk_user
     FROM scan_logs
     WHERE scanned_at >= $1::timestamptz AND scanned_at <= $2::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [day.startIso, day.endIso]
  );
  const byEmpId = new Map();
  for (const e of employees) byEmpId.set(Number(e.id), []);
  for (const row of logRes.rows) {
    const eid = row.employee_id != null ? Number(row.employee_id) : null;
    if (eid && byEmpId.has(eid)) {
      byEmpId.get(eid).push(row);
    } else {
      const emp = employees.find((x) => normalizeCode(x.code) === normalizeCode(row.employee_code));
      if (emp) {
        const mappedId = Number(emp.id);
        if (byEmpId.has(mappedId)) byEmpId.get(mappedId).push(row);
      }
    }
  }

  const rows = [];
  for (const e of employees) {
    const eid = Number(e.id);
    const list = byEmpId.get(eid) || [];
    const paired = pairEmployeeLogsForLocalDay(list, eid, carryMap, day, dayClose);
    const lastRow = list.length ? list[list.length - 1] : null;
    const lastSt = lastRow ? String(lastRow.status || '').toUpperCase() : '';
    if (!paired.currentlyWorking && lastSt !== 'STOP') continue;

    if (lastSt === 'STOP' && lastRow) {
      const stopMs = new Date(lastRow.scanned_at).getTime();
      const inStartMs = activeSessionStartMsBeforeStop(list, lastRow);
      const elapsedMs =
        inStartMs != null && Number.isFinite(stopMs)
          ? Math.max(0, stopMs - inStartMs)
          : 0;
      const dailyHours = dailyMap.get(eid) || 0;
      const weeklyHours = weeklyMap.get(eid) || 0;
      rows.push({
        employee_code: e.code,
        employee_name: e.name,
        status: 'STOP',
        activity: lastRow.note_value || '-',
        tank_number: lastRow.tank_number || '-',
        stop_reason: lastRow.note_value || '-',
        resume_activity: lastRow.note || null,
        area_name: lastRow.area_name || null,
        station_name: lastRow.station_name || null,
        kiosk_user: lastRow.kiosk_user || null,
        started_at: inStartMs != null ? new Date(inStartMs).toISOString() : lastRow.scanned_at,
        elapsed_minutes: Math.round(elapsedMs / 60000),
        elapsed_paused: true,
        last_scan_time: lastRow.scanned_at,
        hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
        daily_hours: dailyHours,
        weekly_hours: weeklyHours,
        overtime_warning: false,
        flags: ['stop'],
      });
      continue;
    }

    if (!paired.pendingInSourceRow) continue;
    const inRow = paired.pendingInSourceRow;
    const startMs = new Date(inRow.scanned_at).getTime();
    const effNow = paired.pendingOvertimeSession
      ? Date.now()
      : Math.min(
          Date.now(),
          paired.pendingRegularCapEndMs != null && Number.isFinite(paired.pendingRegularCapEndMs)
            ? paired.pendingRegularCapEndMs
            : startMs + REGULAR_SHIFT_CAP_MS
        );
    const elapsedMs = Number.isFinite(startMs) ? Math.max(0, effNow - startMs) : 0;
    const activity = inRow.note_value || inRow.note || '-';
    const tank_number = inRow.tank_number || '-';
    const dailyHours = dailyMap.get(eid) || 0;
    const weeklyHours = weeklyMap.get(eid) || 0;
    const flags = [];
    if (paired.pendingOvertimeSession) flags.push('overtime_session');
    if (weeklyHours > 40) flags.push('weekly_overtime');
    const overtime_warning = paired.pendingOvertimeSession && (dailyHours > 8 || weeklyHours > 40);
    rows.push({
      employee_code: e.code,
      employee_name: e.name,
      status: 'IN',
      activity,
      tank_number,
      area_name: inRow.area_name || null,
      station_name: inRow.station_name || null,
      kiosk_user: inRow.kiosk_user || null,
      started_at: inRow.scanned_at,
      elapsed_minutes: Math.round(elapsedMs / 60000),
      last_scan_time: (lastRow && lastRow.scanned_at) || inRow.scanned_at,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
      daily_hours: dailyHours,
      weekly_hours: weeklyHours,
      overtime_warning,
      flags: flags.length ? flags : ['active_shift'],
    });
  }
  rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }));
  return rows;
}

async function managerTankSummaryRows() {
  const day = localDateString();
  const bounds = startEndOfLocalDay(day);
  if (!bounds) return [];
  const logRes = await pool.query(
    `SELECT employee_id, employee_code, employee_name, status, scanned_at, note_value, note, tank_number
     FROM scan_logs
     WHERE scanned_at >= $1::timestamptz AND scanned_at <= $2::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [bounds.startIso, bounds.endIso]
  );
  const rows = logRes.rows;
  const closeAt = Math.min(Date.now(), new Date(bounds.endIso).getTime());
  const tankMs = laborMsAttributedByTank(rows, closeAt);
  const byTank = new Map();
  const workerTank = new Map();
  for (const r of rows) {
    const code = r.employee_code;
    const tank = normalizeTankNumber(r.tank_number);
    if (r.status === 'IN') {
      if (tank) workerTank.set(code, tank);
    } else if (r.status === 'OUT' || r.status === 'STOP') {
      workerTank.delete(code);
    }
    if (r.status !== 'IN') continue;
    const resolvedTank = tank || workerTank.get(code);
    if (!resolvedTank) continue;
    if (!byTank.has(resolvedTank)) byTank.set(resolvedTank, { workersNow: new Set(), last_activity: '-' });
    byTank.get(resolvedTank).last_activity = r.note_value || r.note || '-';
  }
  const emRes = await pool.query(`SELECT id, code FROM employees WHERE is_active = 1`);
  const carryMap = await fetchCarryInBeforeDay(bounds.startIso);
  const byEmpId = new Map();
  for (const e of emRes.rows) byEmpId.set(Number(e.id), []);
  for (const row of rows) {
    const eid = row.employee_id != null ? Number(row.employee_id) : null;
    if (eid && byEmpId.has(eid)) {
      byEmpId.get(eid).push(row);
    } else {
      const emp = emRes.rows.find((x) => normalizeCode(x.code) === normalizeCode(row.employee_code));
      if (emp) byEmpId.get(Number(emp.id)).push(row);
    }
  }
  for (const [code, tank] of [...workerTank.entries()]) {
    const emp = emRes.rows.find((x) => normalizeCode(x.code) === normalizeCode(code));
    if (!emp) continue;
    const eid = Number(emp.id);
    const list = byEmpId.get(eid) || [];
    const paired = pairEmployeeLogsForLocalDay(list, eid, carryMap, bounds, closeAt);
    if (!paired.currentlyWorking) workerTank.delete(code);
  }
  for (const [code, tank] of workerTank.entries()) {
    if (!byTank.has(tank)) byTank.set(tank, { workersNow: new Set(), last_activity: '-' });
    byTank.get(tank).workersNow.add(code);
  }
  for (const [tank, ms] of tankMs.entries()) {
    if (!byTank.has(tank)) byTank.set(tank, { workersNow: new Set(), last_activity: '-' });
  }
  const lastFinishByTank = await fetchLastFinishByTankForWindow(bounds.startIso, bounds.endIso);
  const out = [];
  for (const [tank, item] of byTank.entries()) {
    const ms = tankMs.get(tank) || 0;
    const lastFinish = lastFinishByTank.get(tank);
    const lastCompleted = lastFinish
      ? {
          employee_name: String(lastFinish.employee_name || ''),
          activity_name: String(lastFinish.activity_name || ''),
          finished_at: lastFinish.finished_at,
          duration_minutes: Number(lastFinish.duration_minutes) || 0,
          label: `${String(lastFinish.employee_name || '')} - ${String(lastFinish.activity_name || '')} - ${new Date(
            lastFinish.finished_at
          ).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
        }
      : null;
    out.push({
      tank_number: tank,
      workers_currently_on_tank: item.workersNow.size,
      total_labor_hours_today: Math.round((ms / 3600000) * 100) / 100,
      last_activity: item.last_activity,
      last_completed: lastCompleted,
      status: item.workersNow.size > 0 ? 'ACTIVE' : 'IDLE',
    });
  }
  out.sort((a, b) => a.tank_number.localeCompare(b.tank_number, undefined, { sensitivity: 'base' }));
  return out;
}

function weekBoundsLocal(now = new Date()) {
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0, 0);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function managerOvertimeWatch() {
  const today = startEndOfLocalDay(localDateString());
  if (!today) return [];
  const week = weekBoundsLocal();
  const dayClose = Math.min(Date.now(), new Date(today.endIso).getTime());
  const weekClose = Math.min(Date.now(), new Date(week.endIso).getTime());
  const dailyMap = await buildWorkedHoursMapForWindow(today, dayClose);
  const weeklyMap = await buildWorkedHoursMapForWindow(week, weekClose);
  const emRes = await pool.query(`SELECT id, code, name, hourly_rate FROM employees WHERE is_active = 1`);
  const employees = emRes.rows;
  const carryMap = await fetchCarryInBeforeDay(today.startIso);
  const tlogRes = await pool.query(
    `SELECT employee_id, employee_code, status, scanned_at, id
     FROM scan_logs
     WHERE scanned_at >= $1::timestamptz AND scanned_at <= $2::timestamptz
     ORDER BY scanned_at ASC, id ASC`,
    [today.startIso, today.endIso]
  );
  /** @type {Map<string, Array<{status:string, scanned_at:string, id:number}>>} */
  const todayLogsByCode = new Map();
  /** @type {Map<number, Array<{status:string, scanned_at:string, id:number, employee_code:string}>>} */
  const todayLogsById = new Map();
  for (const e of employees) todayLogsById.set(Number(e.id), []);
  for (const row of tlogRes.rows) {
    const code = normalizeCode(row.employee_code);
    if (!todayLogsByCode.has(code)) todayLogsByCode.set(code, []);
    todayLogsByCode.get(code).push(row);
    const eid = row.employee_id != null ? Number(row.employee_id) : null;
    if (eid && todayLogsById.has(eid)) todayLogsById.get(eid).push(row);
    else {
      const emp = employees.find((x) => normalizeCode(x.code) === code);
      if (emp) todayLogsById.get(Number(emp.id)).push(row);
    }
  }
  const rows = [];
  for (const e of employees) {
    const eid = Number(e.id);
    const dailyHours = dailyMap.get(eid) || 0;
    const weeklyHours = weeklyMap.get(eid) || 0;
    const dailyOt = Math.max(0, dailyHours - 8);
    const weeklyOt = Math.max(0, weeklyHours - 40);
    const otHours = Math.max(dailyOt, weeklyOt);
    const regularHours = Math.max(0, dailyHours - otHours);
    const rate = Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20;
    const estimatedPay = dailyHours * rate;
    const logsToday = todayLogsByCode.get(normalizeCode(e.code)) || [];
    const latest = logsToday.length ? logsToday[logsToday.length - 1] : null;
    const listForPair = todayLogsById.get(eid) || [];
    const paired = pairEmployeeLogsForLocalDay(listForPair, eid, carryMap, today, dayClose);
    let duplicateFastScan = false;
    for (let i = 1; i < logsToday.length; i += 1) {
      const a = logsToday[i - 1];
      const b = logsToday[i];
      if (String(a.status || '').toUpperCase() !== String(b.status || '').toUpperCase()) continue;
      const ta = new Date(a.scanned_at).getTime();
      const tb = new Date(b.scanned_at).getTime();
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && tb - ta >= 0 && tb - ta <= SCAN_DEBOUNCE_MS) {
        duplicateFastScan = true;
        break;
      }
    }
    const flags = [];
    const latestIn = latest && String(latest.status || '').toUpperCase() === 'IN';
    const staleAuto = latestIn && !paired.currentlyWorking && paired.regularAutoEnded && !paired.pendingOvertimeSession;
    if (staleAuto) flags.push('auto_ended_at_8h');
    else if (latestIn && paired.currentlyWorking && !paired.pendingOvertimeSession) flags.push('missing_out');
    if (duplicateFastScan) flags.push('duplicate_scan');
    if (dailyHours > 8) flags.push('daily_overtime');
    if (weeklyHours > 40) flags.push('weekly_overtime');
    rows.push({
      employee_code: e.code,
      employee_name: e.name,
      daily_hours: Math.round(dailyHours * 100) / 100,
      weekly_hours: Math.round(weeklyHours * 100) / 100,
      regular_hours: Math.round(regularHours * 100) / 100,
      overtime_hours: Math.round(otHours * 100) / 100,
      estimated_pay: Math.round(estimatedPay * 100) / 100,
      flag_daily_over_8h: dailyHours > 8,
      flag_daily_close_8h: dailyHours >= 7 && dailyHours <= 8,
      flag_weekly_over_40h: weeklyHours > 40,
      flags,
    });
  }
  return rows;
}

app.get('/api/manager/finished-jobs', async (req, res) => {
  const todayOnly = req.query.today_only !== '0' && req.query.today_only !== 'false';
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const area = req.query.area ? String(req.query.area).trim() : 'ALL';
  try {
    const rows = await fetchManagerFinishedJobs({ area, todayOnly, limit });
    return res.json({
      ok: true,
      rows,
      today_only: todayOnly,
      area: area || 'ALL',
    });
  } catch (err) {
    console.error('[manager finished-jobs]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load finished jobs.' });
  }
});

app.get('/api/manager/current-work', async (_req, res) => {
  const rows = await managerCurrentWorkRows();
  res.json({ ok: true, rows });
});

app.get('/api/manager/tank-summary', async (_req, res) => {
  const rows = await managerTankSummaryRows();
  res.json({ ok: true, rows });
});

app.get('/api/manager/overtime-watch', async (_req, res) => {
  const rows = await managerOvertimeWatch();
  res.json({ ok: true, rows });
});

/**
 * Update kiosk PINs for production areas (manager only).
 * Body: optional area_a_pin, area_b_pin, area_c_pin, area_d_pin (4–6 digits each).
 */
app.patch('/api/manager/kiosk-pins', async (req, res) => {
  const auth = currentAuthFromSession(req);
  if (!auth || auth.role !== ROLE.MANAGER) {
    return authJson(res, 403, 'Forbidden.', 'forbidden');
  }
  const body = req.body || {};
  const fields = KIOSK_AREA_PROFILES.map((p) => [p.username, p.pinField]);
  /** @type {Array<[string, string]>} */
  const toApply = [];
  for (const [uname, key] of fields) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const raw = body[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const digits = String(raw).trim();
    if (!/^\d{4,6}$/.test(digits)) {
      return res.status(400).json({
        ok: false,
        error: 'validation',
        message: `${key} must be exactly 4–6 digits.`,
      });
    }
    const row = await getUserByUsername(uname);
    if (!row || String(row.role).toUpperCase() !== ROLE.KIOSK) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid kiosk account.' });
    }
    toApply.push([uname, digits]);
  }
  if (!toApply.length) {
    return res.status(400).json({
      ok: false,
      error: 'validation',
      message: 'Provide at least one PIN (area_a_pin, area_b_pin, area_c_pin, or area_d_pin).',
    });
  }
  const ts = nowIso();
  try {
    for (const [uname, digits] of toApply) {
      await pool.query(`UPDATE users SET pin_hash = $1, updated_at = $2::timestamptz WHERE username = $3 AND role = $4`, [
        hashPassword(digits),
        ts,
        uname,
        ROLE.KIOSK,
      ]);
    }
  } catch (e) {
    console.error('[kiosk-pins]', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not update PINs.' });
  }
  return res.json({ ok: true });
});

function isOwnerManager(auth) {
  return !!auth && auth.role === ROLE.MANAGER && String(auth.username || '').toLowerCase() === 'owner';
}

app.get('/api/system/server-status', (_req, res) => {
  try {
    return res.json(getServerStatus());
  } catch (e) {
    console.error('[system/server-status]', e);
    return res.json({ ok: false, status: 'offline', message: 'Server status unavailable' });
  }
});

app.get('/api/system/database-status', async (_req, res) => {
  try {
    const db = await checkDatabase(pool);
    return res.json({
      ok: db.status === 'connected',
      status: db.status,
      message: db.message,
      server_time: db.server_time ? toIsoTime(db.server_time) : null,
    });
  } catch (e) {
    console.error('[system/database-status]', e);
    return res.json({ ok: false, status: 'disconnected', message: 'Database check failed' });
  }
});

app.get('/api/system/database-size', async (_req, res) => {
  try {
    const size = await getDatabaseSize(pool);
    return res.json({ ok: true, size: size || 'unknown' });
  } catch (e) {
    console.error('[system/database-size]', e);
    return res.json({ ok: false, size: null, message: 'Could not read database size' });
  }
});

app.get('/api/system/server-time', async (_req, res) => {
  try {
    const db = await checkDatabase(pool);
    if (db.status === 'connected' && db.server_time) {
      return res.json({ ok: true, server_time: toIsoTime(db.server_time) });
    }
    return res.json({
      ok: false,
      server_time: new Date().toISOString(),
      message: 'Database unavailable — using app server time',
    });
  } catch (e) {
    console.error('[system/server-time]', e);
    return res.json({
      ok: false,
      server_time: new Date().toISOString(),
      message: 'Could not read server time from database',
    });
  }
});

app.get('/api/system/pm2-status', async (_req, res) => {
  try {
    const pm2 = await checkPm2Status();
    return res.json({
      ok: pm2.status === 'online',
      status: pm2.status,
      message: pm2.message,
    });
  } catch (e) {
    console.error('[system/pm2-status]', e);
    return res.json({ ok: false, status: 'offline', message: 'PM2 check failed' });
  }
});

app.get('/api/admin/system/info', async (_req, res) => {
  try {
    const health = await getSystemHealthSummary(pool, readAppVersion());
    return res.json(health);
  } catch (e) {
    console.error('[admin/system/info]', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not read system information.' });
  }
});

app.get('/api/admin/backup/status', (_req, res) => {
  try {
    const status = getBackupStatus(readAppVersion());
    return res.json({ ok: true, ...status });
  } catch (e) {
    console.error('[admin/backup/status]', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not read backup status.' });
  }
});

app.post('/api/admin/backup/create', async (req, res) => {
  try {
    const result = await createPgBackup();
    console.log(`[admin/backup/create] wrote ${result.filename} (${result.size_bytes} bytes)`);
    return res.json({
      ok: true,
      message: `Backup created: ${result.filename}`,
      filename: result.filename,
      created_at: result.created_at,
      size_bytes: result.size_bytes,
    });
  } catch (e) {
    console.error('[admin/backup/create]', e);
    const details = e && e.details ? e.details : null;
    const message =
      e && e.code === 'backup_config'
        ? (details && details.length ? details.join(' ') : e.message)
        : e && e.message
          ? e.message
          : 'Backup failed.';
    return res.status(e && e.code === 'backup_config' ? 400 : 500).json({
      ok: false,
      error: e && e.code === 'backup_config' ? 'backup_config' : 'server_error',
      message,
      details,
    });
  }
});

app.get('/api/admin/backup/latest/download', (req, res) => {
  try {
    const latest = getLatestBackup();
    if (!latest) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'No PostgreSQL backup file found.' });
    }
    const resolved = resolveBackupDownload(latest.filename);
    if (resolved.error) {
      return res.status(404).json({ ok: false, error: 'not_found', message: resolved.error });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${resolved.filename}"`);
    return res.sendFile(resolved.path);
  } catch (e) {
    console.error('[admin/backup/latest/download]', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not download backup.' });
  }
});

app.post('/api/owner/change-password', async (req, res) => {
  const auth = currentAuthFromSession(req);
  if (!isOwnerManager(auth)) {
    return res.status(403).json({ ok: false, error: 'forbidden', message: 'Owner access required.' });
  }
  const currentPassword = String((req.body && req.body.current_password) || '');
  const newPassword = String((req.body && req.body.new_password) || '');
  if (!currentPassword || !newPassword || newPassword.trim().length < 6) {
    return res
      .status(400)
      .json({ ok: false, error: 'validation', message: 'current_password and new_password (min 6 chars) are required.' });
  }
  try {
    const cur = await pool.query(`SELECT password_hash FROM users WHERE username = 'owner' AND role = 'MANAGER' LIMIT 1`);
    const row = cur.rows[0];
    if (!row) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Owner account not found.' });
    }
    if (!verifyPassword(currentPassword, row.password_hash)) {
      return res.status(400).json({ ok: false, error: 'invalid_current_password', message: 'Current password is incorrect.' });
    }
    const ts = nowIso();
    const nextHash = hashPassword(newPassword);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = $2::timestamptz WHERE username = 'owner' AND role = 'MANAGER'`,
      [nextHash, ts]
    );
    return res.json({ ok: true, success: true });
  } catch (e) {
    console.error('[owner/change-password]', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not change owner password.' });
  }
});

app.post('/api/owner/reset-manager-password', async (req, res) => {
  const auth = currentAuthFromSession(req);
  if (!isOwnerManager(auth)) {
    return res.status(403).json({ ok: false, error: 'forbidden', message: 'Owner access required.' });
  }
  const newPassword = String((req.body && req.body.new_password) || '');
  if (!newPassword || newPassword.trim().length < 6) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'new_password must be at least 6 characters.' });
  }
  try {
    const ts = nowIso();
    const nextHash = hashPassword(newPassword);
    const upd = await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = $2::timestamptz WHERE username = 'manager' AND role = 'MANAGER'`,
      [nextHash, ts]
    );
    if (!upd.rowCount) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Manager account not found.' });
    }
    return res.json({ ok: true, success: true });
  } catch (e) {
    console.error('[owner/reset-manager-password]', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not reset manager password.' });
  }
});

/** Kiosk + main HTML — MUST be registered before express.static so /scan never serves index.html. */
function scanKioskCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

app.get('/scan', (req, res) => {
  const auth = currentKioskFromSession(req) || currentAuthFromSession(req);
  if (auth && auth.role === ROLE.KIOSK && isQaQcKioskArea(auth.area_name)) {
    return res.redirect(302, '/qa-qc');
  }
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
});

app.get('/scan/', (_req, res) => {
  res.redirect(301, '/scan');
});

app.get('/kiosk', (req, res) => {
  const auth = currentKioskFromSession(req);
  if (auth && isQaQcKioskArea(auth.area_name)) {
    return res.redirect(302, '/qa-qc');
  }
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
});

app.get('/qa-qc', (req, res) => {
  const auth = currentKioskFromSession(req);
  if (!auth) return res.redirect(302, '/kiosk-login');
  if (!isQaQcKioskArea(auth.area_name)) return res.redirect(302, '/kiosk');
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'qa-qc.html'));
});

app.get('/qa-qc.css', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('text/css');
  res.sendFile(path.join(PUBLIC_DIR, 'qa-qc.css'));
});

app.get('/qa-qc.js', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'qa-qc.js'));
});

app.get('/ipad-scan', (_req, res) => {
  res.redirect(302, '/kiosk-login');
});

app.get('/scan.css', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('text/css');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.css'));
});

app.get('/scan.js', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.js'));
});

app.get('/scan.html', (_req, res) => {
  res.redirect(301, '/scan');
});

app.get('/login', (_req, res) => {
  res.redirect(302, '/manager-login');
});

app.get('/manager-login', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'manager-login.html'));
});

app.get('/kiosk-login', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'kiosk-login.html'));
});

app.get('/install', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'install.html'));
});

app.get('/manager-dashboard', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'manager.html'));
});

app.get('/manager', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'manager.html'));
});

app.get('/system', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'system.html'));
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function renderActivitiesByAreaPrintPage() {
  let bcIndex = 0;
  const scripts = [];
  const sections = KIOSK_PRODUCTION_AREAS.map((area) => {
    const items = getKioskActivitiesForArea(area);
    const areaHeader = String(area).replace(/</g, '&lt;').toUpperCase();
    const cards = items
      .map((a) => {
        const label = String(a.label || '').replace(/</g, '&lt;');
        const sub = String(area).replace(/</g, '&lt;');
        const val = String(a.barcode || '').replace(/</g, '&lt;');
        const esc = String(a.barcode || '').replace(/'/g, "\\'");
        const id = `bc${bcIndex++}`;
        scripts.push(
          `JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:110,margin:10,width:2.4});`
        );
        return `<div class="card">
  <p class="label">${label}</p>
  <p class="sub">${sub}</p>
  <svg id="${id}"></svg>
  <p class="value">${val}</p>
</div>`;
      })
      .join('');
    return `<section class="area-section">
  <h2 class="area-header">${areaHeader}</h2>
  <hr class="area-rule" />
  <div class="area-grid">${cards}</div>
</section>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Production Activities by Area</title>
<style>
@page { size: letter; margin: 0.55in; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 20px 24px 28px; color: #0f172a; background: #fff; }
.page-head { margin-bottom: 24px; }
h1 { font-size: 26px; font-weight: 800; margin: 0 0 6px; letter-spacing: 0.02em; }
.instr { font-size: 14px; color: #475569; margin: 0; line-height: 1.45; max-width: 720px; }
.area-section { margin-bottom: 32px; page-break-inside: avoid; }
.area-section + .area-section { page-break-before: auto; }
.area-header { font-size: 20px; font-weight: 800; margin: 0 0 6px; letter-spacing: 0.08em; color: #1a3a5c; }
.area-rule { border: none; border-top: 2px solid #1a3a5c; margin: 0 0 16px; }
.area-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 22px; }
.card { border: 2px solid #cbd5e1; border-radius: 12px; padding: 16px 14px 14px; text-align: center; break-inside: avoid; background: #fff; }
.label { font-size: 20px; font-weight: 800; margin: 0; line-height: 1.2; color: #0f172a; }
.sub { font-size: 11px; color: #64748b; margin: 6px 0 12px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
.card svg { display: block; width: 100%; max-width: 340px; height: 110px; margin: 0 auto; }
.value { font-size: 13px; font-family: Consolas, Monaco, monospace; margin: 10px 0 0; font-weight: 700; color: #1e293b; letter-spacing: 0.04em; word-break: break-all; }
@media print {
  body { padding: 0; }
  .area-section { margin-bottom: 28px; }
  .card { border: 1.5px solid #94a3b8; }
}
@media (max-width: 640px) {
  .area-grid { grid-template-columns: 1fr; }
}
</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
</head><body>
<div class="page-head">
  <h1>Production Activities by Area</h1>
  <p class="instr">Scan employee badge, tank, then activity. Each section lists activities for one production area. Laminate and keep at the kiosk station.</p>
</div>
${sections}
<script>${scripts.join('')}window.setTimeout(()=>window.print(),450);</script>
</body></html>`;
}

function renderStopEndShiftPrintPage() {
  let bcIndex = 0;
  const scripts = [];

  function renderCard(title, description, barcode) {
    const safeTitle = String(title || '').replace(/</g, '&lt;');
    const safeDesc = String(description || '').replace(/</g, '&lt;');
    const safeVal = String(barcode || '').replace(/</g, '&lt;');
    const esc = String(barcode || '').replace(/'/g, "\\'");
    const id = `bc${bcIndex++}`;
    scripts.push(
      `JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:112,margin:12,width:3});`
    );
    return `<div class="scan-card">
  <p class="card-title">${safeTitle}</p>
  <p class="card-desc">${safeDesc}</p>
  <svg id="${id}"></svg>
  <p class="card-code">${safeVal}</p>
</div>`;
  }

  const jobActions = [
    {
      title: 'Finished Job',
      description: 'Complete current activity and send it to Recent Finished Jobs.',
      barcode: 'FINISHED_JOB',
    },
    {
      title: 'End Shift',
      description: 'Employee clocks OUT for the day.',
      barcode: 'REASON:END_SHIFT',
    },
  ];

  const stopReasons = [
    { title: 'Clean Up', description: 'Pause current job. Activity and tank are preserved.', barcode: 'STOP:CLEAN_UP' },
    { title: 'Lunch', description: 'Pause current job. Activity and tank are preserved.', barcode: 'STOP:LUNCH' },
    { title: 'Break', description: 'Pause current job. Activity and tank are preserved.', barcode: 'STOP:BREAK' },
    { title: 'Material', description: 'Pause current job. Activity and tank are preserved.', barcode: 'STOP:MATERIAL' },
    {
      title: 'Maintenance / Downtime',
      description: 'Pause current job. Activity and tank are preserved.',
      barcode: 'STOP:MAINTENANCE_DOWNTIME',
    },
  ];

  const jobCards = jobActions.map((a) => renderCard(a.title, a.description, a.barcode)).join('');
  const stopCards = stopReasons.map((a) => renderCard(a.title, a.description, a.barcode)).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>STOP / END SHIFT SCAN SHEET</title>
<style>
@page { size: letter; margin: 0.55in; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; color: #0f172a; background: #fff; }
.print-page { padding: 20px 24px 28px; }
.print-page + .print-page { page-break-before: always; padding-top: 24px; }
.page-head { margin-bottom: 22px; }
h1 { font-size: 28px; font-weight: 800; margin: 0 0 8px; letter-spacing: 0.04em; color: #1a3a5c; }
.subtitle { font-size: 15px; color: #475569; margin: 0; line-height: 1.45; max-width: 720px; }
.section { margin-bottom: 8px; }
.section-title { font-size: 16px; font-weight: 800; margin: 0 0 14px; letter-spacing: 0.1em; text-transform: uppercase; color: #1a3a5c; }
.grid { display: grid; gap: 20px 22px; }
.grid--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.scan-card { border: 2px solid #cbd5e1; border-radius: 14px; padding: 18px 16px 16px; text-align: center; background: #fff; min-height: 180px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; break-inside: avoid; }
.card-title { font-size: 22px; font-weight: 800; margin: 0; line-height: 1.2; color: #0f172a; }
.card-desc { font-size: 12px; color: #64748b; margin: 8px 0 14px; line-height: 1.4; max-width: 280px; min-height: 34px; }
.scan-card svg { display: block; width: 100%; max-width: 360px; height: 112px; margin: 0 auto; flex-shrink: 0; }
.card-code { font-size: 14px; font-family: Consolas, Monaco, monospace; margin: 12px 0 0; font-weight: 700; color: #1e293b; letter-spacing: 0.05em; word-break: break-all; }
@media print {
  .print-page { padding: 0; }
  .scan-card { border: 1.5px solid #94a3b8; min-height: 180px; }
}
@media (max-width: 640px) {
  .grid--2 { grid-template-columns: 1fr; }
}
</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
</head><body>
<div class="print-page">
  <div class="page-head">
    <h1>STOP / END SHIFT SCAN SHEET</h1>
    <p class="subtitle">Scan these codes when pausing work, completing work, or clocking out.</p>
  </div>
  <section class="section">
    <h2 class="section-title">Job Status Actions</h2>
    <div class="grid grid--2">${jobCards}</div>
  </section>
</div>
<div class="print-page">
  <section class="section">
    <h2 class="section-title">Stop Reasons</h2>
    <div class="grid grid--2">${stopCards}</div>
  </section>
</div>
<script>${scripts.join('')}window.setTimeout(()=>window.print(),450);</script>
</body></html>`;
}

function renderMultiBarcodePrintPage(pageTitle, instruction, items) {
  const safeTitle = String(pageTitle || 'Barcodes').replace(/</g, '&lt;');
  const safeInstr = String(instruction || '').replace(/</g, '&lt;');
  const scripts = [];
  const cards = items
    .map((item, i) => {
      const label = String(item.title || '').replace(/</g, '&lt;');
      const sub = String(item.sub || '').replace(/</g, '&lt;');
      const val = String(item.barcode || '').replace(/</g, '&lt;');
      const esc = String(item.barcode || '').replace(/'/g, "\\'");
      scripts.push(`JsBarcode('#bc${i}','${esc}',{format:'CODE128',displayValue:false,height:90,margin:6,width:2});`);
      return `<div class="card"><p class="label">${label}</p><p class="sub">${sub}</p><svg id="bc${i}"></svg><p class="value">${val}</p></div>`;
    })
    .join('');
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
body{font-family:Arial,sans-serif;margin:20px;color:#0f172a}
h1{font-size:28px;margin:0 0 8px}
.instr{font-size:16px;color:#334155;margin:0 0 20px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.card{border:2px solid #cbd5e1;border-radius:12px;padding:16px;text-align:center;break-inside:avoid}
.label{font-size:18px;font-weight:800;margin:0}
.sub{font-size:13px;color:#64748b;margin:4px 0 10px}
.value{font-size:14px;font-family:monospace;margin-top:6px}
@media print{body{margin:8px}.card{border:1px solid #94a3b8}}
</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
</head><body>
<h1>${safeTitle}</h1>
<p class="instr">${safeInstr}</p>
<div class="grid">${cards}</div>
<script>${scripts.join('')}window.setTimeout(()=>window.print(),400);</script>
</body></html>`;
}

function renderCommandBarcodePrintPage(title, barcodeValue, subtitle) {
  const safeTitle = String(title || 'Barcode').replace(/</g, '&lt;');
  const safeSub = String(subtitle || '').replace(/</g, '&lt;');
  const safeVal = String(barcodeValue || '').replace(/'/g, "\\'");
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Print ${safeTitle}</title>
<style>
body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}
.card{border:2px solid #cbd5e1;border-radius:14px;padding:24px;max-width:760px;margin:0 auto;text-align:center}
.title{font-size:36px;font-weight:800;margin:0 0 8px}
.sub{font-size:20px;margin:0 0 16px;color:#334155}
svg{max-width:100%;height:120px}
.value{font-size:20px;letter-spacing:0.06em;margin-top:8px;font-family:monospace}
.hint{font-size:14px;color:#64748b;margin-top:12px}
@media print{body{margin:8px}.card{border:1px solid #94a3b8}}
</style>
</head><body>
<div class="card">
  <p class="title">${safeTitle}</p>
  <p class="sub">${safeSub}</p>
  <svg id="barcode"></svg>
  <p class="value">${String(barcodeValue || '').replace(/</g, '&lt;')}</p>
</div>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<script>JsBarcode('#barcode','${safeVal}',{format:'CODE128',displayValue:false,height:110,margin:8,width:2});window.setTimeout(()=>window.print(),300);</script>
</body></html>`;
}

app.get('/manager/command-print', (req, res) => {
  const type = String(req.query.type || '').toLowerCase();
  if (type === 'activities') {
    return res.type('html').send(renderActivitiesByAreaPrintPage());
  }
  if (type === 'areas') {
    return res.status(410).send('Area barcode printing has been removed. Use Print Activities by Area instead.');
  }
  if (type === 'reasons' || type === 'stops') {
    return res.type('html').send(renderStopEndShiftPrintPage());
  }
  const map = {
    lunch: { title: 'Lunch Stop', barcode: 'STOP:LUNCH', sub: 'STOP — pause job' },
    break: { title: 'Break Stop', barcode: 'STOP:BREAK', sub: 'STOP — pause job' },
    clean_up: { title: 'Clean Up Stop', barcode: 'STOP:CLEAN_UP', sub: 'STOP — pause job' },
    end_shift: { title: 'End Shift', barcode: 'REASON:END_SHIFT', sub: 'Clock-out reason' },
    sanding: { title: 'Activity — Sanding', barcode: 'ACTIVITY:SANDING', sub: 'Work activity' },
    painting: { title: 'Activity — Painting', barcode: 'ACTIVITY:PAINTING', sub: 'Work activity' },
    assembly: { title: 'Activity — Assembly', barcode: 'ACTIVITY:ASSEMBLY', sub: 'Work activity' },
  };
  const item = map[type];
  if (!item) return res.status(400).send('Unknown command type');
  res.type('html').send(renderCommandBarcodePrintPage(item.title, item.barcode, item.sub));
});

app.get('/manager/tank-print', (req, res) => {
  const tank = normalizeTankNumber(req.query.tank);
  if (!tank) return res.status(400).send('Missing tank');
  const barcodeValue = `TANK_${tank}`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Print Tank ${tank}</title>
<style>
body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}
.card{border:2px solid #cbd5e1;border-radius:14px;padding:24px;max-width:760px;margin:0 auto;text-align:center}
.title{font-size:40px;font-weight:800;margin:0 0 8px}
.sub{font-size:22px;margin:0 0 16px;color:#334155}
svg{max-width:100%;height:130px}
.value{font-size:22px;letter-spacing:0.08em;margin-top:8px}
@media print{body{margin:8px}.card{border:1px solid #94a3b8}}
</style>
</head><body>
<div class="card">
  <p class="title">Tank ${tank}</p>
  <p class="sub">Traveler Barcode</p>
  <svg id="barcode"></svg>
  <p class="value">${barcodeValue}</p>
</div>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<script>JsBarcode('#barcode','${barcodeValue}',{format:'CODE128',displayValue:false,height:120,margin:8,width:2});window.setTimeout(()=>window.print(),300);</script>
</body></html>`;
  res.type('html').send(html);
});

app.use(express.static(PUBLIC_DIR));

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = Number(err.statusCode || err.status);
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, error: 'bad_request', message: err.message || 'Bad request.' });
  }
  return res.status(500).json({ ok: false, error: 'server', message: 'Unexpected server error.' });
});

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = app;
