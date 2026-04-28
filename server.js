'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pg = require('pg');
const PgSession = require('connect-pg-simple')(session);
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'scan.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const app = express();
if (IS_PROD) {
  app.set('trust proxy', 1);
}

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL missing');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('❌ SESSION_SECRET missing');
  process.exit(1);
}
console.log('ENV:', process.env.NODE_ENV);
console.log('DB:', !!process.env.DATABASE_URL);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on('error', (err) => {
  console.error('[session-store] pool error:', err && err.message ? err.message : err);
});

const sessionStore = new PgSession({
  pool: pool,
  tableName: 'session',
  createTableIfMissing: true,
});
console.log('Session store: Postgres OK');

app.use(express.json({ limit: '32kb' }));
app.use(
  session({
    store: sessionStore,
    name: 'factory_scan_sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const MIGRATION_TABLE_NAMES = new Set(['employees', 'scan_logs', 'tanks', 'users']);

const ROLE = {
  MANAGER: 'MANAGER',
  KIOSK: 'KIOSK',
};

const DEFAULT_USER_PASSWORDS = {
  manager: process.env.DEFAULT_MANAGER_PASSWORD || 'manager123',
  kiosk_area_a: process.env.DEFAULT_KIOSK_PASSWORD_A || 'kioskA123',
  kiosk_area_b: process.env.DEFAULT_KIOSK_PASSWORD_B || 'kioskB123',
  kiosk_area_c: process.env.DEFAULT_KIOSK_PASSWORD_C || 'kioskC123',
};

/** Default kiosk PINs (hashed in DB). */
const DEFAULT_KIOSK_PINS = {
  kiosk_area_a: '1111',
  kiosk_area_b: '2222',
  kiosk_area_c: '3333',
};

/** Maps UI area label → users.username for KIOSK accounts. */
const KIOSK_AREA_TO_USERNAME = {
  'Area A': 'kiosk_area_a',
  'Area B': 'kiosk_area_b',
  'Area C': 'kiosk_area_c',
};

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

function assertSafeIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name || ''))) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
}

/** @param {string} tableName @param {string} columnName */
function columnExists(tableName, columnName) {
  assertSafeIdent(tableName);
  assertSafeIdent(columnName);
  if (!MIGRATION_TABLE_NAMES.has(tableName)) {
    throw new Error(`columnExists: unknown table ${tableName}`);
  }
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const want = String(columnName).toLowerCase();
    return rows.some((c) => String(c.name || '').toLowerCase() === want);
  } catch (e) {
    console.error(`[migration] columnExists failed for ${tableName}.${columnName}:`, e && e.message);
    return false;
  }
}

/**
 * @param {string} tableName
 * @param {string} columnDefinition e.g. "tank_number TEXT" or "hourly_rate REAL NOT NULL DEFAULT 20"
 */
function addColumnIfMissing(tableName, columnDefinition) {
  assertSafeIdent(tableName);
  if (!MIGRATION_TABLE_NAMES.has(tableName)) {
    throw new Error(`addColumnIfMissing: unknown table ${tableName}`);
  }
  const def = String(columnDefinition).trim();
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+(.+)$/s.exec(def);
  if (!m) {
    throw new Error(`addColumnIfMissing: bad column definition: ${columnDefinition}`);
  }
  const columnName = m[1];
  const typeAndConstraints = m[2].trim();
  if (columnExists(tableName, columnName)) {
    console.log(`[migration] ${tableName}.${columnName} already exists`);
    return;
  }
  const sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${typeAndConstraints}`;
  try {
    db.exec(sql);
    console.log(`[migration] Added ${tableName}.${columnName}`);
  } catch (e) {
    const msg = String((e && e.message) || e || '').toLowerCase();
    if (msg.includes('duplicate column name')) {
      console.log(`[migration] ${tableName}.${columnName} already exists (caught duplicate)`);
      return;
    }
    console.error(`[migration] FAILED SQL:\n${sql}`);
    console.error(`[migration] Error:`, e && e.message);
    throw e;
  }
}

function execMigrationSql(sql, label = 'migration') {
  try {
    db.exec(sql);
  } catch (e) {
    console.error(`[migration] (${label}) FAILED SQL:\n${sql}`);
    console.error(`[migration] (${label}) Error:`, e && e.message);
    throw e;
  }
}

/** Base tables only — indexes on optional columns run after addColumnIfMissing (see ensureIndexes). */
function initSchema() {
  execMigrationSql(
    `CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'initSchema.employees'
  );

  execMigrationSql(
    `CREATE TABLE IF NOT EXISTS scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_code TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('IN','OUT')),
      scanned_at TEXT NOT NULL
    )`,
    'initSchema.scan_logs_base'
  );

  execMigrationSql(
    `CREATE TABLE IF NOT EXISTS tanks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tank_number TEXT UNIQUE NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'initSchema.tanks'
  );

  execMigrationSql(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('MANAGER','KIOSK')),
      station_name TEXT,
      area_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'initSchema.users'
  );
}

function migrateEmployeesHourlyRate() {
  addColumnIfMissing('employees', 'hourly_rate REAL NOT NULL DEFAULT 20');
  try {
    db.prepare(`UPDATE employees SET hourly_rate = 20 WHERE hourly_rate IS NULL OR hourly_rate < 0`).run();
  } catch (e) {
    console.error('[migration] migrateEmployeesHourlyRate UPDATE failed:', e && e.message);
    throw e;
  }
}

function migrateScanLogsColumns() {
  addColumnIfMissing('scan_logs', 'employee_id INTEGER');
  addColumnIfMissing('scan_logs', 'note TEXT');
  addColumnIfMissing('scan_logs', 'note_category TEXT');
  addColumnIfMissing('scan_logs', 'note_value TEXT');
  addColumnIfMissing('scan_logs', 'tank_number TEXT');
  addColumnIfMissing('scan_logs', 'station_name TEXT');
  addColumnIfMissing('scan_logs', 'area_name TEXT');
  addColumnIfMissing('scan_logs', 'kiosk_user TEXT');
}

function migrateScanLogsNoteCategoryValue() {
  if (!columnExists('scan_logs', 'note')) return;
  try {
    db.prepare(
      `UPDATE scan_logs SET note_value = note WHERE note_value IS NULL AND note IS NOT NULL AND TRIM(note) != ''`
    ).run();
    db.prepare(
      `UPDATE scan_logs SET note_category = CASE WHEN status = 'OUT' THEN 'REASON' WHEN status = 'IN' THEN 'WORK' ELSE NULL END
       WHERE note_value IS NOT NULL AND (note_category IS NULL OR TRIM(note_category) = '')`
    ).run();
    db.prepare(`UPDATE scan_logs SET note = note_value WHERE note_value IS NOT NULL`).run();
  } catch (e) {
    console.error('[migration] migrateScanLogsNoteCategoryValue UPDATE failed:', e && e.message);
    throw e;
  }
}

function migrateScanLogsEmployeeIdBackfill() {
  if (!columnExists('scan_logs', 'employee_id')) return;
  try {
    db.prepare(
      `UPDATE scan_logs SET employee_id = (SELECT id FROM employees WHERE employees.code = scan_logs.employee_code)
       WHERE employee_id IS NULL`
    ).run();
  } catch (e) {
    console.error('[migration] migrateScanLogsEmployeeIdBackfill failed:', e && e.message);
    throw e;
  }
}

function migrateUsersPinHash() {
  addColumnIfMissing('users', 'pin_hash TEXT');
}

function ensureIndexes() {
  const statements = [
    ['idx_employees_code', `CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(code)`],
    ['idx_users_username', `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`],
    ['idx_scan_logs_employee_code', `CREATE INDEX IF NOT EXISTS idx_scan_logs_employee_code ON scan_logs(employee_code)`],
    ['idx_scan_logs_scanned_at', `CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at)`],
  ];
  for (const [label, sql] of statements) {
    try {
      db.exec(sql);
      console.log(`[migration] Index ready: ${label}`);
    } catch (e) {
      console.error(`[migration] Index (${label}) FAILED SQL:\n${sql}`);
      console.error(`[migration] Error:`, e && e.message);
      throw e;
    }
  }
  if (columnExists('scan_logs', 'tank_number')) {
    const sql = `CREATE INDEX IF NOT EXISTS idx_scan_logs_tank_number ON scan_logs(tank_number)`;
    try {
      db.exec(sql);
      console.log('[migration] Index ready: idx_scan_logs_tank_number');
    } catch (e) {
      console.error(`[migration] Index (idx_scan_logs_tank_number) FAILED SQL:\n${sql}`);
      console.error(`[migration] Error:`, e && e.message);
      throw e;
    }
  } else {
    console.log('[migration] skip idx_scan_logs_tank_number (scan_logs.tank_number not present)');
  }
  const tanksIdx = `CREATE INDEX IF NOT EXISTS idx_tanks_tank_number ON tanks(tank_number)`;
  try {
    db.exec(tanksIdx);
    console.log('[migration] Index ready: idx_tanks_tank_number');
  } catch (e) {
    console.error(`[migration] Index (idx_tanks_tank_number) FAILED SQL:\n${tanksIdx}`);
    console.error(`[migration] Error:`, e && e.message);
    throw e;
  }
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

/** WORK (clock-in activity) or REASON (clock-out). */
function normalizeNoteCategory(raw) {
  if (raw === undefined || raw === null) return null;
  const u = String(raw).trim().toUpperCase();
  if (u === 'WORK' || u === 'REASON') return u;
  return null;
}

function normalizeTankNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  return s.slice(0, 24);
}

function normalizeTankStatus(raw) {
  const s = String(raw || 'ACTIVE').trim().toUpperCase();
  if (s === 'ACTIVE' || s === 'ARCHIVED' || s === 'COMPLETED') return s;
  return 'ACTIVE';
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
  for (const bundle of byCode.values()) {
    const activityMs = new Map();
    let pendingIn = null;
    for (const log of bundle.logs) {
      const t = new Date(log.scanned_at).getTime();
      if (Number.isNaN(t)) continue;
      if (log.status === 'IN') {
        pendingIn = log;
      } else if (log.status === 'OUT') {
        if (!pendingIn) continue;
        const t0 = new Date(pendingIn.scanned_at).getTime();
        if (Number.isNaN(t0) || t < t0) {
          pendingIn = null;
          continue;
        }
        const label = workActivityLabelFromInRow(pendingIn);
        const dur = t - t0;
        activityMs.set(label, (activityMs.get(label) || 0) + dur);
        pendingIn = null;
      }
    }
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

function computeTankSummaryFromLogs(logsAsc) {
  const map = new Map();
  const byEmp = new Map();
  for (const log of logsAsc) {
    const code = log.employee_code;
    const tank = normalizeTankNumber(log.tank_number || '');
    if (log.status === 'IN') {
      if (tank) byEmp.set(code, tank);
    } else if (log.status === 'OUT') {
      byEmp.delete(code);
    }
    if (log.status !== 'IN') continue;
    const resolved = tank || byEmp.get(code);
    if (!resolved) continue;
    if (!map.has(resolved)) map.set(resolved, { workers: new Set(), logs: [], activities: new Set() });
    const ent = map.get(resolved);
    ent.workers.add(code);
    ent.logs.push(log);
    const label = workActivityLabelFromInRow(log);
    if (label && label !== '-') ent.activities.add(label);
  }
  const out = [];
  for (const [tankNumber, ent] of map.entries()) {
    const ms = workedMsFromLogsAsc(ent.logs);
    out.push({
      tank_number: tankNumber,
      workers: ent.workers.size,
      total_labor_hours: Math.round((ms / 3600000) * 100) / 100,
      activities: [...ent.activities].slice(0, 4),
    });
  }
  return out.sort((a, b) => a.tank_number.localeCompare(b.tank_number, undefined, { sensitivity: 'base' }));
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

function seedIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM employees').get();
  if (row.c > 0) return;

  const insert = db.prepare(`
    INSERT INTO employees (code, name, is_active, hourly_rate, created_at, updated_at)
    VALUES (@code, @name, 1, 20, @created_at, @updated_at)
  `);
  const ts = nowIso();
  const seeds = [
    ['EMP001', 'John Carter'],
    ['EMP002', 'Mike Davis'],
    ['EMP003', 'Alex Turner'],
    ['EMP004', 'David Brooks'],
    ['EMP005', 'Chris Miller'],
    ['EMP006', 'Ethan Scott'],
  ];
  const tx = db.transaction(() => {
    for (const [code, name] of seeds) {
      insert.run({ code, name, created_at: ts, updated_at: ts });
    }
  });
  tx();
}

function seedDefaultUsers() {
  const ts = nowIso();
  const upsert = db.prepare(`
    INSERT INTO users (username, password_hash, pin_hash, role, station_name, area_name, is_active, created_at, updated_at)
    VALUES (@username, @password_hash, @pin_hash, @role, @station_name, @area_name, 1, @created_at, @updated_at)
    ON CONFLICT(username) DO NOTHING
  `);
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
      username: 'kiosk_area_a',
      password_hash: hashPassword(DEFAULT_USER_PASSWORDS.kiosk_area_a),
      pin_hash: hashPassword(DEFAULT_KIOSK_PINS.kiosk_area_a),
      role: ROLE.KIOSK,
      station_name: 'Area A Kiosk',
      area_name: 'Area A',
      created_at: ts,
      updated_at: ts,
    },
    {
      username: 'kiosk_area_b',
      password_hash: hashPassword(DEFAULT_USER_PASSWORDS.kiosk_area_b),
      pin_hash: hashPassword(DEFAULT_KIOSK_PINS.kiosk_area_b),
      role: ROLE.KIOSK,
      station_name: 'Area B Kiosk',
      area_name: 'Area B',
      created_at: ts,
      updated_at: ts,
    },
    {
      username: 'kiosk_area_c',
      password_hash: hashPassword(DEFAULT_USER_PASSWORDS.kiosk_area_c),
      pin_hash: hashPassword(DEFAULT_KIOSK_PINS.kiosk_area_c),
      role: ROLE.KIOSK,
      station_name: 'Area C Kiosk',
      area_name: 'Area C',
      created_at: ts,
      updated_at: ts,
    },
  ];
  const tx = db.transaction(() => {
    for (const u of seeds) upsert.run(u);
  });
  tx();
}

/** Existing databases: fill pin_hash only when missing (does not overwrite manager-set PINs). */
function ensureKioskDefaultPins() {
  const ts = nowIso();
  const stmt = db.prepare(
    `UPDATE users SET pin_hash = ?, updated_at = ? WHERE username = ? AND (pin_hash IS NULL OR TRIM(IFNULL(pin_hash, '')) = '')`
  );
  const tx = db.transaction(() => {
    for (const [uname, pin] of Object.entries(DEFAULT_KIOSK_PINS)) {
      stmt.run(hashPassword(pin), ts, uname);
    }
  });
  tx();
}

function runSchemaMigrationsSafely() {
  const steps = [
    ['initSchema', initSchema],
    ['migrateEmployeesHourlyRate', migrateEmployeesHourlyRate],
    ['migrateScanLogsColumns', migrateScanLogsColumns],
    ['migrateScanLogsNoteCategoryValue', migrateScanLogsNoteCategoryValue],
    ['migrateScanLogsEmployeeIdBackfill', migrateScanLogsEmployeeIdBackfill],
    ['migrateUsersPinHash', migrateUsersPinHash],
    ['ensureIndexes', ensureIndexes],
  ];
  for (const [name, fn] of steps) {
    try {
      console.log(`[migration] --- ${name} ---`);
      fn();
    } catch (e) {
      console.error(`[migration] Step "${name}" failed:`, e && e.message);
      throw e;
    }
  }
  console.log('[migration] All schema steps completed.');
}

runSchemaMigrationsSafely();
seedIfEmpty();
seedDefaultUsers();
ensureKioskDefaultPins();

function getEmployeeByCode(code) {
  const n = normalizeCode(code);
  if (!n) return null;
  /** Case/space tolerant without COLLATE NOCASE (avoids SQLite build quirks). */
  return db
    .prepare(
      `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at
       FROM employees
       WHERE REPLACE(UPPER(TRIM(IFNULL(code, ''))), ' ', '') = ?`
    )
    .get(n);
}

function getUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return db
    .prepare(
      `SELECT id, username, password_hash, pin_hash, role, station_name, area_name, is_active
       FROM users WHERE LOWER(TRIM(username)) = ? LIMIT 1`
    )
    .get(u);
}

function getTankByNumber(tankNumber) {
  return db
    .prepare(`SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE tank_number = ?`)
    .get(tankNumber);
}

function ensureTankExists(rawTankNumber) {
  const tankNumber = normalizeTankNumber(rawTankNumber);
  if (!tankNumber) return null;
  const existing = getTankByNumber(tankNumber);
  if (existing) return existing;
  const ts = nowIso();
  try {
    db.prepare(`INSERT INTO tanks (tank_number, description, status, created_at, updated_at) VALUES (?, '', 'ACTIVE', ?, ?)`).run(
      tankNumber,
      ts,
      ts
    );
  } catch {
    // race-safe: ignore and fetch
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

function workedMsFromLogsAsc(logsAsc) {
  let pendingInMs = null;
  let total = 0;
  for (const row of logsAsc) {
    const t = new Date(row.scanned_at).getTime();
    if (Number.isNaN(t)) continue;
    if (row.status === 'IN') {
      pendingInMs = t;
    } else if (row.status === 'OUT') {
      if (pendingInMs !== null && t >= pendingInMs) {
        total += t - pendingInMs;
      }
      pendingInMs = null;
    }
  }
  return total;
}

function isAllEmployeesParam(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return !s || s === 'all';
}

/** @param {{ scope: string, start?: string, end?: string, employee?: string }} q */
function queryScanLogsForExport(q) {
  const scope = String(q.scope || '').toLowerCase();
  let sql = `SELECT id, employee_id, employee_code, employee_name, status, scanned_at, note, note_category, note_value, tank_number, station_name, area_name, kiosk_user FROM scan_logs WHERE 1=1`;
  const params = [];

  if (scope === 'today') {
    const day = localDateString();
    const b = startEndOfLocalDay(day);
    if (!b) return [];
    sql += ` AND scanned_at >= ? AND scanned_at <= ?`;
    params.push(b.startIso, b.endIso);
  } else if (scope === 'range') {
    const sb = startEndOfLocalDay(q.start || '');
    const eb = startEndOfLocalDay(q.end || '');
    if (!sb || !eb) return [];
    sql += ` AND scanned_at >= ? AND scanned_at <= ?`;
    params.push(sb.startIso, eb.endIso);
  }

  if (!isAllEmployeesParam(q.employee)) {
    sql += ` AND employee_code = ?`;
    params.push(normalizeCode(q.employee));
  }

  sql += ` ORDER BY scanned_at ASC, id ASC`;
  return db.prepare(sql).all(...params);
}

/**
 * Payroll rows for employees in `employeesList` using logs already filtered by date/employee.
 */
function computePayrollRowsFromLogs(employeesList, logsAsc) {
  const byCode = new Map();
  for (const e of employeesList) {
    byCode.set(e.code, []);
  }
  for (const log of logsAsc) {
    if (!byCode.has(log.employee_code)) byCode.set(log.employee_code, []);
    byCode.get(log.employee_code).push(log);
  }

  const rows = [];
  let totalHoursRounded = 0;
  let totalPayroll = 0;

  for (const e of employeesList) {
    const list = byCode.get(e.code) || [];
    const ms = workedMsFromLogsAsc(list);
    const minutesWorked = Math.round(ms / 60000);
    const hoursDecimal = ms / 3600000;
    const roundedMinutes = roundWorkedHours(hoursDecimal) * 60;
    const hoursRounded = roundWorkedHours(hoursDecimal);
    const regularHours = Math.min(hoursRounded, 8);
    const overtimeHours = Math.max(0, hoursRounded - 8);
    const rate = Number(e.hourly_rate);
    const safeRate = Number.isFinite(rate) && rate >= 0 ? rate : 20;
    const wage = Math.round((regularHours * safeRate + overtimeHours * safeRate * 1.5) * 100) / 100;
    totalHoursRounded += hoursRounded;
    totalPayroll += wage;
    rows.push({
      employee_code: e.code,
      employee_name: e.name,
      is_active: !!e.is_active,
      hourly_rate: safeRate,
      minutes_worked: minutesWorked,
      rounded_minutes: roundedMinutes,
      hours_decimal: Math.round(hoursDecimal * 100) / 100,
      hours_rounded: hoursRounded,
      regular_hours: regularHours,
      overtime_hours: overtimeHours,
      wage,
    });
  }

  rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }));

  const employeeCount = employeesList.length;
  const averageHoursPerEmployee =
    employeeCount > 0 ? Math.round((totalHoursRounded / employeeCount) * 100) / 100 : 0;

  return {
    rows,
    total_hours_rounded: totalHoursRounded,
    total_payroll: Math.round(totalPayroll * 100) / 100,
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
function computePayrollForExport(scope, startStr, endStr, employeeRaw) {
  const allEmp = isAllEmployeesParam(employeeRaw);
  let employeesList;
  if (allEmp) {
    employeesList = db
      .prepare(`SELECT id, code, name, is_active, hourly_rate FROM employees ORDER BY name COLLATE NOCASE ASC`)
      .all();
  } else {
    const code = normalizeCode(employeeRaw);
    const row = db
      .prepare(`SELECT id, code, name, is_active, hourly_rate FROM employees WHERE code = ?`)
      .get(code);
    if (!row) return null;
    employeesList = [row];
  }

  const logsAll = queryScanLogsForExport({
    scope,
    start: startStr,
    end: endStr,
    employee: employeeRaw,
  });

  const base = computePayrollRowsFromLogs(employeesList, logsAll);
  enrichPayrollRowsWithScanHints(base.rows, logsAll);
  const workAnalytics = computeWorkAnalyticsFromLogs(logsAll);
  const tankSummary = computeTankSummaryFromLogs(logsAll);
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

function computePayrollForDate(yyyyMmDd) {
  const bounds = startEndOfLocalDay(yyyyMmDd);
  if (!bounds) return null;

  const employees = db
    .prepare(`SELECT id, code, name, is_active, hourly_rate FROM employees ORDER BY name COLLATE NOCASE ASC`)
    .all();

  const logs = db
    .prepare(
      `SELECT employee_code, employee_name, status, scanned_at, note, note_category, note_value
       FROM scan_logs
       WHERE scanned_at >= ? AND scanned_at <= ?
       ORDER BY scanned_at ASC, id ASC`
    )
    .all(bounds.startIso, bounds.endIso);

  const agg = computePayrollRowsFromLogs(employees, logs);
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
          .fillColor(row.status === 'IN' ? '#15803d' : '#b91c1c')
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
            .fillColor(row.status === 'IN' ? '#15803d' : '#b91c1c')
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

function getLatestLogForCode(code) {
  const n = normalizeCode(code);
  if (!n) return null;
  return db
    .prepare(
      `SELECT id, employee_code, employee_name, status, scanned_at, tank_number
       FROM scan_logs
       WHERE REPLACE(UPPER(TRIM(IFNULL(employee_code, ''))), ' ', '') = ?
       ORDER BY scanned_at DESC, id DESC
       LIMIT 1`
    )
    .get(n);
}

function getCurrentActiveInSessionByCode(code) {
  const n = normalizeCode(code);
  if (!n) return null;
  const rows = db
    .prepare(
      `SELECT id, status, scanned_at, note_value, note, tank_number
       FROM scan_logs
       WHERE REPLACE(UPPER(TRIM(IFNULL(employee_code, ''))), ' ', '') = ?
       ORDER BY scanned_at DESC, id DESC`
    )
    .all(n);
  let seenOut = false;
  for (const r of rows) {
    if (r.status === 'OUT') {
      seenOut = true;
      continue;
    }
    if (r.status === 'IN' && !seenOut) {
      return r;
    }
  }
  return null;
}

function nextStatusFromLatest(latestRow) {
  if (!latestRow) return 'IN';
  return latestRow.status === 'IN' ? 'OUT' : 'IN';
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

function currentAuthFromSession(req) {
  const u = req.session && req.session.user;
  if (!u) return null;
  return {
    id: Number(u.id),
    username: String(u.username),
    role: String(u.role || '').toUpperCase(),
    station_name: u.station_name ? String(u.station_name) : null,
    area_name: u.area_name ? String(u.area_name) : null,
  };
}

function requireRoles(allowedRoles) {
  return (req, res, next) => {
    const auth = currentAuthFromSession(req);
    req.auth = auth;
    if (!auth) {
      if (isApiPath(req.path)) return authJson(res, 401, 'Login required.', 'not_authenticated');
      return res.redirect('/login');
    }
    if (!isRoleAllowed(auth.role, allowedRoles)) {
      if (isApiPath(req.path)) return authJson(res, 403, 'Forbidden.', 'forbidden');
      return res.status(403).type('text').send('Forbidden');
    }
    return next();
  };
}

const requireManager = requireRoles([ROLE.MANAGER]);
const requireScanRole = requireRoles([ROLE.MANAGER, ROLE.KIOSK]);

app.get('/api/auth/me', (req, res) => {
  const auth = currentAuthFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Login required.' });
  return res.json({ ok: true, user: auth });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body && req.body.username ? req.body.username : '').trim().toLowerCase();
  const password = String(req.body && req.body.password ? req.body.password : '');
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'username and password are required.' });
  }
  const user = getUserByUsername(username);
  if (!user || !user.is_active) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Invalid username or password.' });
  }
  if (!verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Invalid username or password.' });
  }
  req.session.user = {
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
app.post('/api/auth/login-kiosk-pin', (req, res) => {
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
  const user = getUserByUsername(username);
  if (!user || !user.is_active || String(user.role).toUpperCase() !== ROLE.KIOSK) {
    recordPinFailure(ip);
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Incorrect PIN.' });
  }
  if (!user.pin_hash || !verifyPassword(pinRaw, user.pin_hash)) {
    recordPinFailure(ip);
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Incorrect PIN.' });
  }
  pinRateLimitReset(ip);
  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    station_name: user.station_name || null,
    area_name: user.area_name || null,
  };
  return res.json({
    ok: true,
    role: ROLE.KIOSK,
    redirect: '/scan',
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('factory_scan_sid');
    res.json({ ok: true });
  });
});

app.use((req, res, next) => {
  const p = String(req.path || '');
  if (p === '/login' || p.startsWith('/api/auth/')) return next();
  if (p === '/scan' || p === '/scan/' || p === '/scan.html' || p === '/scan.js' || p === '/scan.css') {
    return requireScanRole(req, res, next);
  }
  if (p === '/admin.html' || p === '/summary.html' || p === '/index.html') {
    return requireManager(req, res, next);
  }
  if (p === '/manager-dashboard' || p === '/manager' || p === '/manager/tank-print' || p === '/dashboard' || p === '/') {
    return requireManager(req, res, next);
  }
  if (p.startsWith('/api/kiosk/') || p.startsWith('/api/scan')) {
    return requireScanRole(req, res, next);
  }
  if (
    p.startsWith('/api/manager/') ||
    p.startsWith('/api/employees') ||
    p.startsWith('/api/tanks') ||
    p.startsWith('/api/export') ||
    p.startsWith('/api/payroll') ||
    p.startsWith('/api/summary') ||
    p.startsWith('/api/status') ||
    p.startsWith('/api/logs') ||
    p.startsWith('/api/scan_logs')
  ) {
    return requireManager(req, res, next);
  }
  return next();
});

/** Kiosk GET employee — JSON only; registered with other /api routes (not only before static). */
function handleKioskEmployeeLookup(req, res) {
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

    const employee = getEmployeeByCode(code);
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

    const latest = getLatestLogForCode(code);
    const next_status = nextStatusFromLatest(latest);
    let current_status = 'OUT';
    if (latest && latest.status) {
      const s = String(latest.status).toUpperCase();
      current_status = s === 'IN' || s === 'OUT' ? s : 'OUT';
    }

    let active_tank_number = null;
    if (current_status === 'IN' && latest && latest.tank_number != null && String(latest.tank_number).trim() !== '') {
      active_tank_number = String(latest.tank_number).trim();
    } else {
      const activeIn = getCurrentActiveInSessionByCode(code);
      if (
        activeIn &&
        activeIn.status &&
        String(activeIn.status).toUpperCase() === 'IN' &&
        activeIn.tank_number != null &&
        String(activeIn.tank_number).trim() !== ''
      ) {
        active_tank_number = String(activeIn.tank_number).trim();
      }
    }

    console.log('[kiosk lookup] current_status:', current_status);
    console.log('[kiosk lookup] next_status:', next_status);

    return res.json({
      ok: true,
      employee: {
        id: employee.id,
        code: String(employee.code),
        name: String(employee.name),
      },
      current_status,
      next_status,
      active_tank_number,
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

app.post('/api/scan', (req, res) => {
  const code = normalizeCode(req.body && req.body.code);
  if (!code) {
    return res.status(400).json({ ok: false, error: 'invalid_code', message: 'Missing or empty barcode.' });
  }

  const employee = getEmployeeByCode(code);
  if (!employee) {
    return res.status(404).json({ ok: false, error: 'unknown_employee', message: 'Unknown barcode.' });
  }
  if (!employee.is_active) {
    return res.status(403).json({ ok: false, error: 'inactive_employee', message: 'Employee is inactive.' });
  }

  const latest = getLatestLogForCode(code);
  const status = nextStatusFromLatest(latest);
  const scannedAt = nowIso();

  /** Notes are set via PATCH after the modal (WORK on IN, REASON on OUT). */
  const info = db
    .prepare(
      `INSERT INTO scan_logs (employee_code, employee_name, employee_id, status, scanned_at, note, note_category, note_value, tank_number)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
    )
    .run(code, employee.name, employee.id, status, scannedAt);

  return res.json({
    ok: true,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status,
    scanned_at: scannedAt,
    log_id: info.lastInsertRowid,
  });
});

app.post('/api/scan/resolve', (req, res) => {
  const code = normalizeCode(req.body && req.body.code);
  if (!code) return res.status(400).json({ ok: false, error: 'invalid_code', message: 'Missing or empty barcode.' });
  const employee = getEmployeeByCode(code);
  if (!employee) return res.status(404).json({ ok: false, error: 'unknown_employee', message: 'Unknown barcode.' });
  if (!employee.is_active) return res.status(403).json({ ok: false, error: 'inactive_employee', message: 'Employee is inactive.' });
  const latest = getLatestLogForCode(code);
  const status = nextStatusFromLatest(latest);
  const activeIn = getCurrentActiveInSessionByCode(code);
  res.json({
    ok: true,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status,
    active_tank_number: activeIn && activeIn.tank_number ? String(activeIn.tank_number) : null,
  });
});

function postScanRecord(req, res) {
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
  const employee = getEmployeeByCode(code);
  if (!employee) return res.status(404).json({ ok: false, error: 'unknown_employee', message: 'Unknown employee.' });
  if (!employee.is_active) return res.status(403).json({ ok: false, error: 'inactive_employee', message: 'Employee is inactive.' });

  const latest = getLatestLogForCode(code);
  const expected = nextStatusFromLatest(latest);
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

  const activeIn = getCurrentActiveInSessionByCode(code);
  const resolvedTank = status === 'IN' ? tankRaw : tankRaw || (activeIn && activeIn.tank_number ? normalizeTankNumber(activeIn.tank_number) : null);
  const stationName = auth && auth.role === ROLE.KIOSK ? auth.station_name || null : null;
  const areaName = auth && auth.role === ROLE.KIOSK ? auth.area_name || null : null;
  const kioskUser = auth && auth.role === ROLE.KIOSK ? auth.username || null : null;
  if (resolvedTank) ensureTankExists(resolvedTank);
  const scannedAt = nowIso();
  const info = db
    .prepare(
      `INSERT INTO scan_logs (employee_code, employee_name, employee_id, status, scanned_at, note, note_category, note_value, tank_number, station_name, area_name, kiosk_user)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(code, employee.name, employee.id, status, scannedAt, noteValue, noteCategory, noteValue, resolvedTank, stationName, areaName, kioskUser);
  res.json({
    ok: true,
    log_id: info.lastInsertRowid,
    employee: { id: employee.id, code: employee.code, name: employee.name },
    status,
    note_category: noteCategory,
    note_value: noteValue,
    tank_number: resolvedTank,
    station_name: stationName,
    area_name: areaName,
    kiosk_user: kioskUser,
    scanned_at: scannedAt,
  });
}

app.post('/api/scan/record', postScanRecord);
/** Kiosk multi-step flow: same body as /api/scan/record (single INSERT when all fields collected). */
app.post('/api/kiosk/complete-scan', postScanRecord);

app.get('/api/kiosk/status', (_req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT
           e.code AS employee_code,
           e.name AS employee_name,
           e.is_active AS is_active,
           COALESCE((
             SELECT l.status
             FROM scan_logs l
             WHERE REPLACE(UPPER(TRIM(IFNULL(l.employee_code, ''))), ' ', '') = REPLACE(UPPER(TRIM(IFNULL(e.code, ''))), ' ', '')
             ORDER BY l.scanned_at DESC, l.id DESC
             LIMIT 1
           ), 'OUT') AS status,
           (
             SELECT COALESCE(NULLIF(TRIM(l.note_value), ''), NULLIF(TRIM(l.note), ''))
             FROM scan_logs l
             WHERE REPLACE(UPPER(TRIM(IFNULL(l.employee_code, ''))), ' ', '') = REPLACE(UPPER(TRIM(IFNULL(e.code, ''))), ' ', '')
             ORDER BY l.scanned_at DESC, l.id DESC
             LIMIT 1
           ) AS note_value,
           (
             SELECT l.tank_number
             FROM scan_logs l
             WHERE REPLACE(UPPER(TRIM(IFNULL(l.employee_code, ''))), ' ', '') = REPLACE(UPPER(TRIM(IFNULL(e.code, ''))), ' ', '')
             ORDER BY l.scanned_at DESC, l.id DESC
             LIMIT 1
           ) AS tank_number,
           (
             SELECT l.area_name
             FROM scan_logs l
             WHERE REPLACE(UPPER(TRIM(IFNULL(l.employee_code, ''))), ' ', '') = REPLACE(UPPER(TRIM(IFNULL(e.code, ''))), ' ', '')
             ORDER BY l.scanned_at DESC, l.id DESC
             LIMIT 1
           ) AS area_name,
           (
             SELECT l.station_name
             FROM scan_logs l
             WHERE REPLACE(UPPER(TRIM(IFNULL(l.employee_code, ''))), ' ', '') = REPLACE(UPPER(TRIM(IFNULL(e.code, ''))), ' ', '')
             ORDER BY l.scanned_at DESC, l.id DESC
             LIMIT 1
           ) AS station_name,
           (
             SELECT l.scanned_at
             FROM scan_logs l
             WHERE REPLACE(UPPER(TRIM(IFNULL(l.employee_code, ''))), ' ', '') = REPLACE(UPPER(TRIM(IFNULL(e.code, ''))), ' ', '')
             ORDER BY l.scanned_at DESC, l.id DESC
             LIMIT 1
           ) AS scanned_at
         FROM employees e
         ORDER BY e.name COLLATE NOCASE ASC`
      )
      .all();

    return res.json({
      ok: true,
      rows: rows.map((r) => ({
        employee_code: String(r.employee_code || ''),
        employee_name: String(r.employee_name || ''),
        status: r.status === 'IN' ? 'IN' : 'OUT',
        note_value: r.note_value ? String(r.note_value) : null,
        tank_number: r.tank_number ? String(r.tank_number) : null,
        area_name: r.area_name ? String(r.area_name) : null,
        station_name: r.station_name ? String(r.station_name) : null,
        scanned_at: r.scanned_at || null,
        is_active: Number(r.is_active) ? 1 : 0,
      })),
    });
  } catch (err) {
    console.error('[kiosk status error]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Failed to load kiosk status.' });
  }
});

app.patch('/api/scan_logs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id', message: 'Invalid log id.' });
  }
  const row = db.prepare(`SELECT id, status FROM scan_logs WHERE id = ?`).get(id);
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
      db.prepare(`UPDATE scan_logs SET note = NULL, note_category = NULL, note_value = NULL WHERE id = ?`).run(id);
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
      db.prepare(`UPDATE scan_logs SET note_category = ?, note_value = ?, note = ? WHERE id = ?`).run(cat, val, val, id);
    }
  }

  let tankNumber = null;
  if (hasTankPayload) {
    if (tank) ensureTankExists(tank);
    tankNumber = tank;
    db.prepare(`UPDATE scan_logs SET tank_number = ? WHERE id = ?`).run(tankNumber, id);
  }

  const latest = db
    .prepare(`SELECT id, note_category, note_value, tank_number FROM scan_logs WHERE id = ?`)
    .get(id);
  return res.json({
    ok: true,
    id,
    note_category: latest.note_category,
    note_value: latest.note_value,
    tank_number: latest.tank_number,
  });
});

app.get('/api/status', (_req, res) => {
  const day = localDateString();
  const bounds = startEndOfLocalDay(day);
  const scansTodayRow = bounds
    ? db
        .prepare(`SELECT COUNT(*) AS c FROM scan_logs WHERE scanned_at >= ? AND scanned_at <= ?`)
        .get(bounds.startIso, bounds.endIso)
    : { c: 0 };

  const employees = db
    .prepare(
      `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees ORDER BY name COLLATE NOCASE ASC`
    )
    .all();

  const latestStmt = db.prepare(
    `SELECT status, scanned_at FROM scan_logs WHERE employee_code = ? ORDER BY scanned_at DESC, id DESC LIMIT 1`
  );

  const payload = employees.map((e) => {
    const latest = latestStmt.get(e.code);
    let current_status = 'OUT';
    let last_scan_at = null;
    if (latest) {
      current_status = latest.status;
      last_scan_at = latest.scanned_at;
    }
    return {
      id: e.id,
      code: e.code,
      name: e.name,
      is_active: !!e.is_active,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
      current_status,
      last_scan_at,
    };
  });

  res.json({ ok: true, scans_today: Number(scansTodayRow.c || 0), employees: payload });
});

app.get('/api/logs', (req, res) => {
  let limit = Number(req.query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(Math.floor(limit), 500);

  const rows = db
    .prepare(
      `SELECT id, employee_id, employee_code, employee_name, status, scanned_at, note, note_category, note_value, tank_number, station_name, area_name, kiosk_user
       FROM scan_logs ORDER BY scanned_at DESC, id DESC LIMIT ?`
    )
    .all(limit);

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
        csvEscape(r.area_name),
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
    const emp = getEmployeeByCode(normalizeCode(employeeRaw));
    if (!emp) {
      return res.status(404).json({ ok: false, error: 'employee_not_found', message: 'No employee with that code.' });
    }
    employeeKey = normalizeCode(employeeRaw);
  } else {
    employeeKey = 'all';
  }

  const logs = queryScanLogsForExport({
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
    const payroll = computePayrollForExport(scope, start, end, employeeKey);
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

function summaryForLocalDate(yyyyMmDd) {
  const bounds = startEndOfLocalDay(yyyyMmDd);
  if (!bounds) return null;

  const employees = db
    .prepare(`SELECT code, name, is_active FROM employees ORDER BY name COLLATE NOCASE ASC`)
    .all();

  const logs = db
    .prepare(
      `SELECT employee_code, employee_name, status, scanned_at, note, note_category, note_value
       FROM scan_logs
       WHERE scanned_at >= ? AND scanned_at <= ?
       ORDER BY scanned_at ASC, id ASC`
    )
    .all(bounds.startIso, bounds.endIso);

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

app.get('/api/summary/today', (_req, res) => {
  const day = localDateString();
  const s = summaryForLocalDate(day);
  if (!s) return res.status(400).json({ ok: false, error: 'invalid_date' });
  res.json({ ok: true, ...s });
});

app.get('/api/summary', (req, res) => {
  const q = req.query.date ? String(req.query.date) : localDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q) || !parseLocalDate(q)) {
    return res.status(400).json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
  }
  const s = summaryForLocalDate(q);
  res.json({ ok: true, ...s });
});

app.get('/api/payroll/today', (_req, res) => {
  const day = localDateString();
  const p = computePayrollForDate(day);
  if (!p) return res.status(400).json({ ok: false, error: 'invalid_date' });
  res.json({ ok: true, ...p });
});

app.get('/api/payroll', (req, res) => {
  const q = req.query.date ? String(req.query.date) : localDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q) || !parseLocalDate(q)) {
    return res.status(400).json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
  }
  const p = computePayrollForDate(q);
  if (!p) return res.status(400).json({ ok: false, error: 'invalid_date' });
  res.json({ ok: true, ...p });
});

app.get('/api/employees', (req, res) => {
  const search = req.query.search ? String(req.query.search).trim() : '';
  let rows;
  if (search) {
    const safe = search.replace(/%/g, '').replace(/_/g, '');
    const pattern = `%${safe}%`;
    rows = db
      .prepare(
        `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees
         WHERE lower(code) LIKE lower(?) OR lower(name) LIKE lower(?)
         ORDER BY name COLLATE NOCASE ASC`
      )
      .all(pattern, pattern);
  } else {
    rows = db
      .prepare(
        `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees ORDER BY name COLLATE NOCASE ASC`
      )
      .all();
  }
  res.json({
    ok: true,
    employees: rows.map((e) => ({
      ...e,
      is_active: !!e.is_active,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
    })),
  });
});

app.post('/api/employees', (req, res) => {
  const code = normalizeCode(req.body && req.body.code);
  const name = req.body && req.body.name !== undefined ? String(req.body.name).trim() : '';
  if (!code || !name) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'code and name are required.' });
  }
  const hourly_rate = parseHourlyRate(req.body && req.body.hourly_rate);

  const ts = nowIso();
  try {
    const info = db
      .prepare(
        `INSERT INTO employees (code, name, is_active, hourly_rate, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)`
      )
      .run(code, name, hourly_rate, ts, ts);
    const created = db
      .prepare('SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees WHERE id = ?')
      .get(info.lastInsertRowid);
    return res.status(201).json({
      ok: true,
      employee: {
        ...created,
        is_active: !!created.is_active,
        hourly_rate: Number(created.hourly_rate),
      },
    });
  } catch (e) {
    if (String(e.message || e).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'duplicate_code', message: 'Employee code already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not create employee.' });
  }
});

app.put('/api/employees/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const existing = db.prepare('SELECT id FROM employees WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

  const code = normalizeCode(req.body && req.body.code);
  const name = req.body && req.body.name !== undefined ? String(req.body.name).trim() : '';
  if (!code || !name) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'code and name are required.' });
  }
  const hourly_rate = parseHourlyRate(req.body && req.body.hourly_rate);

  const ts = nowIso();
  try {
    db.prepare(`UPDATE employees SET code = ?, name = ?, hourly_rate = ?, updated_at = ? WHERE id = ?`).run(
      code,
      name,
      hourly_rate,
      ts,
      id
    );
  } catch (e) {
    if (String(e.message || e).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'duplicate_code', message: 'Employee code already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not update employee.' });
  }

  const updated = db.prepare('SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees WHERE id = ?').get(id);
  res.json({
    ok: true,
    employee: { ...updated, is_active: !!updated.is_active, hourly_rate: Number(updated.hourly_rate) },
  });
});

app.delete('/api/employees/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const info = db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

app.patch('/api/employees/:id/toggle-active', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const row = db.prepare('SELECT id, is_active FROM employees WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

  const next = row.is_active ? 0 : 1;
  const ts = nowIso();
  db.prepare('UPDATE employees SET is_active = ?, updated_at = ? WHERE id = ?').run(next, ts, id);
  const updated = db.prepare('SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees WHERE id = ?').get(id);
  res.json({
    ok: true,
    employee: { ...updated, is_active: !!updated.is_active, hourly_rate: Number(updated.hourly_rate) },
  });
});

app.get('/api/tanks', (req, res) => {
  const search = String(req.query.search || '').trim().toUpperCase();
  const activeOnly = String(req.query.active_only || '').toLowerCase() === '1';
  let sql = `SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE 1=1`;
  const params = [];
  if (activeOnly) sql += ` AND status = 'ACTIVE'`;
  if (search) {
    sql += ` AND (tank_number LIKE ? OR description LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY CASE WHEN status='ACTIVE' THEN 0 ELSE 1 END, updated_at DESC, tank_number ASC`;
  const tanks = db.prepare(sql).all(...params);
  res.json({ ok: true, tanks });
});

app.post('/api/tanks', (req, res) => {
  const tank_number = normalizeTankNumber(req.body && req.body.tank_number);
  const description = req.body && req.body.description != null ? String(req.body.description).trim().slice(0, 120) : '';
  if (!tank_number) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'tank_number is required.' });
  }
  const ts = nowIso();
  try {
    const info = db
      .prepare(`INSERT INTO tanks (tank_number, description, status, created_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?)`)
      .run(tank_number, description, ts, ts);
    const tank = db.prepare(`SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = ?`).get(info.lastInsertRowid);
    return res.status(201).json({ ok: true, tank });
  } catch (e) {
    if (String(e.message || e).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'duplicate_tank', message: 'Tank number already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not create tank.' });
  }
});

app.put('/api/tanks/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const current = db.prepare(`SELECT id FROM tanks WHERE id = ?`).get(id);
  if (!current) return res.status(404).json({ ok: false, error: 'not_found' });
  const tank_number = normalizeTankNumber(req.body && req.body.tank_number);
  const description = req.body && req.body.description != null ? String(req.body.description).trim().slice(0, 120) : '';
  const status = normalizeTankStatus(req.body && req.body.status);
  if (!tank_number) return res.status(400).json({ ok: false, error: 'validation', message: 'tank_number is required.' });
  const ts = nowIso();
  try {
    db.prepare(`UPDATE tanks SET tank_number = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`).run(
      tank_number,
      description,
      status,
      ts,
      id
    );
  } catch (e) {
    if (String(e.message || e).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'duplicate_tank', message: 'Tank number already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not update tank.' });
  }
  const tank = db.prepare(`SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = ?`).get(id);
  res.json({ ok: true, tank });
});

app.patch('/api/tanks/:id/archive', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const row = db.prepare(`SELECT id FROM tanks WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  const status = normalizeTankStatus(req.body && req.body.status ? req.body.status : 'ARCHIVED');
  const ts = nowIso();
  db.prepare(`UPDATE tanks SET status = ?, updated_at = ? WHERE id = ?`).run(status, ts, id);
  const tank = db.prepare(`SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = ?`).get(id);
  res.json({ ok: true, tank });
});

function managerCurrentWorkRows() {
  const employees = db.prepare(`SELECT id, code, name, hourly_rate FROM employees WHERE is_active = 1`).all();
  const latestStmt = db.prepare(
    `SELECT status, scanned_at FROM scan_logs WHERE employee_code = ? ORDER BY scanned_at DESC, id DESC LIMIT 1`
  );
  const latestInStmt = db.prepare(
    `SELECT scanned_at, note_value, note, tank_number, area_name, station_name, kiosk_user FROM scan_logs
     WHERE employee_code = ? AND status = 'IN' ORDER BY scanned_at DESC, id DESC LIMIT 1`
  );
  const day = startEndOfLocalDay(localDateString());
  const week = weekBoundsLocal();
  const logsRangeStmt = db.prepare(
    `SELECT status, scanned_at FROM scan_logs WHERE employee_code = ? AND scanned_at >= ? AND scanned_at <= ? ORDER BY scanned_at ASC, id ASC`
  );
  const rows = [];
  for (const e of employees) {
    const latest = latestStmt.get(e.code);
    if (!latest || latest.status !== 'IN') continue;
    const inRow = latestInStmt.get(e.code) || {};
    const startMs = new Date(inRow.scanned_at || latest.scanned_at).getTime();
    const elapsedMs = Number.isFinite(startMs) ? Math.max(0, Date.now() - startMs) : 0;
    const activity = inRow.note_value || inRow.note || '-';
    const tank_number = inRow.tank_number || '-';
    const dailyHours = day ? workedMsFromLogsAsc(logsRangeStmt.all(e.code, day.startIso, day.endIso)) / 3600000 : 0;
    const weeklyHours = workedMsFromLogsAsc(logsRangeStmt.all(e.code, week.startIso, week.endIso)) / 3600000;
    rows.push({
      employee_code: e.code,
      employee_name: e.name,
      status: 'IN',
      activity,
      tank_number,
      area_name: inRow.area_name || null,
      station_name: inRow.station_name || null,
      kiosk_user: inRow.kiosk_user || null,
      started_at: inRow.scanned_at || latest.scanned_at,
      elapsed_minutes: Math.round(elapsedMs / 60000),
      last_scan_time: latest.scanned_at,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
      daily_hours: Math.round(dailyHours * 100) / 100,
      weekly_hours: Math.round(weeklyHours * 100) / 100,
      overtime_warning: dailyHours > 8 || weeklyHours > 40,
    });
  }
  rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }));
  return rows;
}

function managerTankSummaryRows() {
  const day = localDateString();
  const bounds = startEndOfLocalDay(day);
  if (!bounds) return [];
  const rows = db
    .prepare(
      `SELECT employee_code, employee_name, status, scanned_at, note_value, note, tank_number
       FROM scan_logs
       WHERE scanned_at >= ? AND scanned_at <= ?
       ORDER BY scanned_at ASC, id ASC`
    )
    .all(bounds.startIso, bounds.endIso);
  const byTank = new Map();
  const workerTank = new Map();
  for (const r of rows) {
    const code = r.employee_code;
    const tank = normalizeTankNumber(r.tank_number);
    if (r.status === 'IN') {
      if (tank) workerTank.set(code, tank);
    } else if (r.status === 'OUT') {
      workerTank.delete(code);
    }
    if (r.status !== 'IN') continue;
    const resolvedTank = tank || workerTank.get(code);
    if (!resolvedTank) continue;
    if (!byTank.has(resolvedTank)) byTank.set(resolvedTank, { logs: [], workersNow: new Set(), last_activity: '-' });
    byTank.get(resolvedTank).logs.push(r);
    byTank.get(resolvedTank).last_activity = r.note_value || r.note || '-';
  }
  for (const [code, tank] of workerTank.entries()) {
    if (!byTank.has(tank)) byTank.set(tank, { logs: [], workersNow: new Set(), last_activity: '-' });
    byTank.get(tank).workersNow.add(code);
  }
  const out = [];
  for (const [tank, item] of byTank.entries()) {
    const ms = workedMsFromLogsAsc(item.logs);
    out.push({
      tank_number: tank,
      workers_currently_on_tank: item.workersNow.size,
      total_labor_hours_today: Math.round((ms / 3600000) * 100) / 100,
      last_activity: item.last_activity,
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

function managerOvertimeWatch() {
  const today = startEndOfLocalDay(localDateString());
  const week = weekBoundsLocal();
  const employees = db.prepare(`SELECT code, name, hourly_rate FROM employees WHERE is_active = 1`).all();
  const dailyLogsStmt = db.prepare(
    `SELECT status, scanned_at FROM scan_logs WHERE employee_code = ? AND scanned_at >= ? AND scanned_at <= ? ORDER BY scanned_at ASC, id ASC`
  );
  const weeklyLogsStmt = db.prepare(
    `SELECT status, scanned_at FROM scan_logs WHERE employee_code = ? AND scanned_at >= ? AND scanned_at <= ? ORDER BY scanned_at ASC, id ASC`
  );
  const rows = [];
  for (const e of employees) {
    const dailyLogs = dailyLogsStmt.all(e.code, today.startIso, today.endIso);
    const weeklyLogs = weeklyLogsStmt.all(e.code, week.startIso, week.endIso);
    const dailyHours = workedMsFromLogsAsc(dailyLogs) / 3600000;
    const weeklyHours = workedMsFromLogsAsc(weeklyLogs) / 3600000;
    const dailyOt = Math.max(0, dailyHours - 8);
    const weeklyOt = Math.max(0, weeklyHours - 40);
    const otHours = Math.max(dailyOt, weeklyOt);
    const regularHours = Math.max(0, dailyHours - otHours);
    const rate = Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20;
    const estimatedPay = regularHours * rate + otHours * rate * 1.5;
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
    });
  }
  return rows;
}

app.get('/api/manager/current-work', (_req, res) => {
  res.json({ ok: true, rows: managerCurrentWorkRows() });
});

app.get('/api/manager/tank-summary', (_req, res) => {
  res.json({ ok: true, rows: managerTankSummaryRows() });
});

app.get('/api/manager/overtime-watch', (_req, res) => {
  res.json({ ok: true, rows: managerOvertimeWatch() });
});

/**
 * Update kiosk PINs for Area A / B / C (manager only). Body: optional area_a_pin, area_b_pin, area_c_pin (4–6 digits each).
 */
app.patch('/api/manager/kiosk-pins', (req, res) => {
  const auth = currentAuthFromSession(req);
  if (!auth || auth.role !== ROLE.MANAGER) {
    return authJson(res, 403, 'Forbidden.', 'forbidden');
  }
  const body = req.body || {};
  const fields = [
    ['kiosk_area_a', 'area_a_pin'],
    ['kiosk_area_b', 'area_b_pin'],
    ['kiosk_area_c', 'area_c_pin'],
  ];
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
    const row = getUserByUsername(uname);
    if (!row || String(row.role).toUpperCase() !== ROLE.KIOSK) {
      return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid kiosk account.' });
    }
    toApply.push([uname, digits]);
  }
  if (!toApply.length) {
    return res.status(400).json({
      ok: false,
      error: 'validation',
      message: 'Provide at least one PIN (area_a_pin, area_b_pin, or area_c_pin).',
    });
  }
  const ts = nowIso();
  const updateStmt = db.prepare(`UPDATE users SET pin_hash = ?, updated_at = ? WHERE username = ? AND role = ?`);
  const tx = db.transaction(() => {
    for (const [uname, digits] of toApply) {
      updateStmt.run(hashPassword(digits), ts, uname, ROLE.KIOSK);
    }
  });
  try {
    tx();
  } catch (e) {
    console.error('[kiosk-pins]', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not update PINs.' });
  }
  return res.json({ ok: true });
});

/** Kiosk + main HTML — MUST be registered before express.static so /scan never serves index.html. */
function scanKioskCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

app.get('/scan', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
});

app.get('/scan/', (_req, res) => {
  res.redirect(301, '/scan');
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
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/manager-dashboard', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'manager.html'));
});

app.get('/manager', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'manager.html'));
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
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

async function startServer() {
  try {
    await pool.query('SELECT 1');
    console.log('Connected to DB: OK');
  } catch (err) {
    console.error('Connected to DB: FAILED', err && err.message ? err.message : err);
    process.exit(1);
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`factory-scan-clock listening on http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Set PORT to a free port and try again.`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
}

if (process.env.NODE_ENV !== 'production') {
  void startServer();
}

module.exports = app;
