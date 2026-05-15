'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pg = require('pg');
const PgSession = require('connect-pg-simple')(session);
const PDFDocument = require('pdfkit');

const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();

app.set('trust proxy', 1);

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL missing');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('❌ SESSION_SECRET missing');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on('error', (err) => {
  console.error('[session-store] pool error:', err && err.message ? err.message : err);
});

const pgSessionStore = new PgSession({
  pool,
  tableName: 'session',
  createTableIfMissing: true,
});

console.log('Session store: Postgres');
console.log('[boot] session-store:', pgSessionStore && pgSessionStore.constructor ? pgSessionStore.constructor.name : 'missing');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Has DB:', Boolean(process.env.DATABASE_URL));

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
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scan_logs (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN','OUT')),
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
`;

async function runPostgresSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(MIGRATION_SQL);
    await client.query('COMMIT');
    console.log('[migration] Postgres schema ready');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
    } else if (log.status === 'OUT') {
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
  await seedIfEmpty();
  await seedDefaultUsers();
  await ensureKioskDefaultPins();
  console.log('[boot] database seed complete');
}

const dbReady = initializeDatabase();

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
    `SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE tank_number = $1`,
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
       VALUES ($1, '', 'ACTIVE', $2::timestamptz, $3::timestamptz)`,
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

async function getLatestLogForCode(code) {
  const n = normalizeCode(code);
  if (!n) return null;
  const { rows } = await pool.query(
    `SELECT id, employee_code, employee_name, status, scanned_at, tank_number
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
    `SELECT id, employee_code, employee_name, status, scanned_at, tank_number
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
  return paired.pendingInSourceRow;
}

async function resolveExpectedNextStatus(code) {
  const paired = await getTodayPairingStateForEmployeeCode(code);
  const latest = paired.latestRow;
  if (!latest) return 'IN';
  const st = String(latest.status || '').toUpperCase();
  if (st === 'OUT') return 'IN';
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
    console.error('[boot] database unavailable:', err);
    res.status(503).json({ ok: false, error: 'database_unavailable', message: 'Database initialization failed.' });
  }
});

app.get('/api/auth/me', (req, res) => {
  const auth = currentAuthFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Login required.' });
  return res.json({ ok: true, user: auth });
});

app.get('/api/auth/me-kiosk', (req, res) => {
  const auth = currentKioskFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Kiosk login required.' });
  return res.json({ ok: true, user: auth });
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
    redirect: '/kiosk',
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
    p.startsWith('/api/auth/')
  ) {
    return next();
  }
  if (p === '/kiosk' || p === '/ipad-scan') return requireKiosk(req, res, next);
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
  if (p === '/admin.html' || p === '/summary.html' || p === '/index.html') {
    return requireManager(req, res, next);
  }
  if (p === '/manager-dashboard' || p === '/manager' || p === '/manager/tank-print' || p === '/dashboard' || p === '/') {
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
    p.startsWith('/api/scan_logs')
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
    const next_status = await resolveExpectedNextStatus(code);

    let current_status = 'OUT';
    if (latest && latest.status) {
      const s = String(latest.status).toUpperCase();
      if (s === 'IN' && paired.currentlyWorking) current_status = 'IN';
      else if (s === 'IN' && !paired.currentlyWorking) current_status = 'OUT';
      else current_status = s === 'IN' || s === 'OUT' ? s : 'OUT';
    }

    let active_tank_number = null;
    const activeIn = await getCurrentActiveInSessionByCode(code);
    if (
      activeIn &&
      activeIn.status &&
      String(activeIn.status).toUpperCase() === 'IN' &&
      activeIn.tank_number != null &&
      String(activeIn.tank_number).trim() !== ''
    ) {
      active_tank_number = String(activeIn.tank_number).trim();
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
    if (paired.currentlyWorking) {
      current_session_type = paired.pendingOvertimeSession ? 'OVERTIME' : 'REGULAR';
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
    if (status === 'IN' && tankRow && String(tankRow.status || '').toUpperCase() === 'ARCHIVED') {
      return res.status(403).json({
        ok: false,
        error: 'tank_archived',
        message: 'This tank is archived. Restore it in Tank Management before assigning work.',
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
    if (String(status || '').toUpperCase() === 'IN' && !paired.currentlyWorking) {
      status = 'OUT';
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
         COALESCE(NULLIF(TRIM(latest_logs.note_value), ''), NULLIF(TRIM(latest_logs.note), '')) AS note_value,
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
      rows: adjusted.map((r) => ({
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

  const payload = [];
  for (const e of employees) {
    const latestRes = await pool.query(
      `SELECT status, scanned_at FROM scan_logs WHERE employee_code = $1 ORDER BY scanned_at DESC, id DESC LIMIT 1`,
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
      elapsed_seconds:
        daily && daily.currentlyWorking && Number.isFinite(startMs)
          ? Math.max(0, Math.floor((effNow - startMs) / 1000))
          : 0,
    });
  }

  res.json({ ok: true, scans_today: scansToday, employees: payload });
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
      `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees
       WHERE lower(code) LIKE lower($1) OR lower(name) LIKE lower($2)
       ORDER BY LOWER(name) ASC`,
      [pattern, pattern]
    );
    rows = r.rows;
  } else {
    const r = await pool.query(
      `SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees ORDER BY LOWER(name) ASC`
    );
    rows = r.rows;
  }
  res.json({
    ok: true,
    employees: rows.map((e) => ({
      ...e,
      is_active: !!e.is_active,
      hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
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
    'SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees WHERE id = $1',
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

  const ts = nowIso();
  try {
    const ins = await pool.query(
      `INSERT INTO employees (code, name, is_active, hourly_rate, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4::timestamptz, $5::timestamptz)
       RETURNING id, code, name, is_active, hourly_rate, created_at, updated_at`,
      [code, name, hourly_rate, ts, ts]
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

  const ts = nowIso();
  try {
    await pool.query(`UPDATE employees SET code = $1, name = $2, hourly_rate = $3, is_active = $4, updated_at = $5::timestamptz WHERE id = $6`, [
      code,
      name,
      hourly_rate,
      is_active,
      ts,
      id,
    ]);
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'duplicate_code', message: 'Employee code already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not update employee.' });
  }

  const updatedRes = await pool.query(
    'SELECT id, code, name, is_active, hourly_rate, created_at, updated_at FROM employees WHERE id = $1',
    [id]
  );
  const updated = updatedRes.rows[0];
  res.json({
    success: true,
    ok: true,
    employee: { ...updated, is_active: !!updated.is_active, hourly_rate: Number(updated.hourly_rate) },
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
  const search = String(req.query.search || '').trim().toUpperCase();
  const statusFilter = String(req.query.status || 'active').trim().toLowerCase();
  const activeOnly = String(req.query.active_only || '').toLowerCase() === '1';
  let sql = `SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE 1=1`;
  const params = [];
  let n = 1;
  if (statusFilter === 'active') {
    sql += ` AND status = 'ACTIVE'`;
  } else if (statusFilter === 'archived') {
    sql += ` AND status = 'ARCHIVED'`;
  } else if (statusFilter === 'all') {
    if (activeOnly) sql += ` AND status = 'ACTIVE'`;
  } else {
    return res.status(400).json({
      ok: false,
      error: 'validation',
      message: 'status filter must be active, archived, or all.',
    });
  }
  if (search) {
    sql += ` AND (tank_number LIKE $${n} OR description LIKE $${n + 1})`;
    params.push(`%${search}%`, `%${search}%`);
    n += 2;
  }
  sql += ` ORDER BY CASE WHEN status='ACTIVE' THEN 0 ELSE 1 END, updated_at DESC, tank_number ASC`;
  const { rows: tanks } = await pool.query(sql, params);
  res.json({ ok: true, tanks });
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
      `INSERT INTO tanks (tank_number, description, status, created_at, updated_at) VALUES ($1, $2, 'ACTIVE', $3::timestamptz, $4::timestamptz)
       RETURNING id`,
      [tank_number, description, ts, ts]
    );
    const tid = ins.rows[0].id;
    const tankRes = await pool.query(
      `SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = $1`,
      [tid]
    );
    return res.status(201).json({ ok: true, tank: tankRes.rows[0] });
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
    await pool.query(`UPDATE tanks SET tank_number = $1, description = $2, status = $3, updated_at = $4::timestamptz WHERE id = $5`, [
      tank_number,
      description,
      status,
      ts,
      id,
    ]);
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'duplicate_tank', message: 'Tank number already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not update tank.' });
  }
  const tankRes = await pool.query(`SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = $1`, [id]);
  res.json({ ok: true, tank: tankRes.rows[0] });
});

app.patch('/api/tanks/:id/archive', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const rowRes = await pool.query(`SELECT id FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const status = normalizeTankStatus(req.body && req.body.status ? req.body.status : 'ARCHIVED');
  const ts = nowIso();
  await pool.query(`UPDATE tanks SET status = $1, updated_at = $2::timestamptz WHERE id = $3`, [status, ts, id]);
  const tankRes = await pool.query(`SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = $1`, [id]);
  res.json({ ok: true, tank: tankRes.rows[0] });
});

app.patch('/api/tanks/:id/restore', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const rowRes = await pool.query(`SELECT id FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const ts = nowIso();
  await pool.query(`UPDATE tanks SET status = 'ACTIVE', updated_at = $1::timestamptz WHERE id = $2`, [ts, id]);
  const tankRes = await pool.query(`SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = $1`, [id]);
  res.json({ ok: true, tank: tankRes.rows[0] });
});

app.get('/api/tanks/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const tankRes = await pool.query(
    `SELECT id, tank_number, description, status, created_at, updated_at FROM tanks WHERE id = $1`,
    [id]
  );
  if (!tankRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found', message: 'Tank not found.' });
  const tank = tankRes.rows[0];
  const logsAsc = await fetchTankLaborLogs(tank.tank_number);
  const emRes = await pool.query(`SELECT id, code, name, hourly_rate FROM employees`);
  const employeesByCode = new Map();
  for (const e of emRes.rows) {
    employeesByCode.set(normalizeCode(e.code), e);
  }
  const report = computeTankLaborReport(tank.tank_number, logsAsc, employeesByCode, Date.now());
  const registryStatus =
    String(tank.status || '').toUpperCase() === 'ACTIVE' ? 'active' : 'archived';
  res.json({
    ok: true,
    tank: {
      id: tank.id,
      tank_number: tank.tank_number,
      description: tank.description,
      status: registryStatus,
      registry_status: tank.status,
    },
    summary: report.summary,
    employeeBreakdown: report.employeeBreakdown,
    activityBreakdown: report.activityBreakdown,
    sessions: report.sessions,
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
    if (!paired.currentlyWorking || !paired.pendingInSourceRow) continue;
    const inRow = paired.pendingInSourceRow;
    const lastRow = list.length ? list[list.length - 1] : null;
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
    } else if (r.status === 'OUT') {
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
  const out = [];
  for (const [tank, item] of byTank.entries()) {
    const ms = tankMs.get(tank) || 0;
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
 * Update kiosk PINs for Area A / B / C (manager only). Body: optional area_a_pin, area_b_pin, area_c_pin (4–6 digits each).
 */
app.patch('/api/manager/kiosk-pins', async (req, res) => {
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
      message: 'Provide at least one PIN (area_a_pin, area_b_pin, or area_c_pin).',
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

app.get('/scan', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
});

app.get('/scan/', (_req, res) => {
  res.redirect(301, '/scan');
});

app.get('/kiosk', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
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

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = app;
