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
  buildTankDailySummaryPdfBuffer,
  buildTankReportPdfBuffer,
} = require('./scripts/production-report-pdf');
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
const { createAlertEmailService } = require('./scripts/alert-email');
const { runSchemaMigrationWithPool, ensureTankTrashSchema } = require('./scripts/schema-migrate');
const { getSystemHealthSummary, getServerStatus, checkDatabase, checkPm2Status, getDatabaseSize, toIsoTime } = require('./scripts/system-health');
const {
  createPhase1ProductionLogic,
  WINDING_PHASES,
  ALERT_TYPES,
  PAUSE_REASONS,
  DOWNTIME_REASON_OPTIONS,
  RESUME_BARCODES,
  WINDING_MACHINES,
  WINDING_MACHINE_AREA_NAMES,
  WINDING_MACHINE_LEGACY_AREA_ALIASES,
  normalizeWindingMachineAreaName,
  isWindingMachineAreaName,
  CANONICAL_WINDING_MACHINE_CODES,
  isCanonicalWindingMachineCode,
  displayMachineName,
  slugFromMachineName,
  kioskUrlForSlug,
  mapMachineForClient,
} = require('./scripts/phase1-production-logic');

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

/** Full schema (teams/machines/alerts/sessions/…) — see scripts/schema-migrate.js */
async function runPostgresSchema() {
  await withDbRetry(
    async () => {
      await runSchemaMigrationWithPool(pool);
      const client = await pool.connect();
      try {
        await ensureTankTrashSchema(client);
      } finally {
        client.release();
      }
    },
    { label: 'schema', maxAttempts: 3, delayMs: 1000 }
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

/** Phase 1 kiosk login areas — one physical kiosk per winding machine. */
const PHASE1_KIOSK_LOGIN_AREAS = [...WINDING_MACHINE_AREA_NAMES];

/** Production kiosk areas (includes legacy areas for logs / print). */
const KIOSK_PRODUCTION_AREAS = [
  ...WINDING_MACHINE_AREA_NAMES,
  'Assembly',
  'QA/QC',
  'Shipping & Handling',
];

/** Legacy area labels → current production area (logs / filters). */
const LEGACY_KIOSK_AREA_NAMES = {
  'Area A': 'Winding Machine 01',
  Fabrication: 'Winding Machine 01',
  'Winding Machine 1': 'Winding Machine 01',
  'Winding Machine 2': 'Winding Machine 02',
  'Winding Machine 3': 'Winding Machine 03',
  'Winding Station 1': 'Winding Machine 01',
  'Winding Station 2': 'Winding Machine 02',
  'Winding Station 3': 'Winding Machine 03',
  'Winding Station 01': 'Winding Machine 01',
  'Winding Station 02': 'Winding Machine 02',
  'Winding Station 03': 'Winding Machine 03',
  'WS-01': 'Winding Machine 01',
  'WS-02': 'Winding Machine 02',
  'WS-03': 'Winding Machine 03',
  'Area B': 'Assembly',
  'Area C': 'QA/QC',
};

/** Kiosk user profiles (username stable for existing DBs; area_name is display label). */
const KIOSK_AREA_PROFILES = [
  {
    username: 'kiosk_wm_1',
    passwordKey: 'kiosk_area_a',
    pinKey: 'kiosk_area_a',
    area_name: 'Winding Machine 01',
    station_name: 'Winding Machine 01 Kiosk',
    pinField: 'wm_1_pin',
  },
  {
    username: 'kiosk_wm_2',
    passwordKey: 'kiosk_area_b',
    pinKey: 'kiosk_wm_2',
    area_name: 'Winding Machine 02',
    station_name: 'Winding Machine 02 Kiosk',
    pinField: 'wm_2_pin',
  },
  {
    username: 'kiosk_wm_3',
    passwordKey: 'kiosk_area_c',
    pinKey: 'kiosk_wm_3',
    area_name: 'Winding Machine 03',
    station_name: 'Winding Machine 03 Kiosk',
    pinField: 'wm_3_pin',
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
for (const [legacy, current] of Object.entries(WINDING_MACHINE_LEGACY_AREA_ALIASES)) {
  const username = KIOSK_AREA_TO_USERNAME[current];
  if (username) KIOSK_AREA_TO_USERNAME[legacy] = username;
}
KIOSK_AREA_TO_USERNAME.Fabrication = KIOSK_AREA_TO_USERNAME['Winding Machine 01'] || 'kiosk_wm_1';

function normalizeKioskAreaName(area) {
  const s = String(area || '').trim();
  return LEGACY_KIOSK_AREA_NAMES[s] || s;
}

function displayKioskAreaName(area) {
  const normalized = normalizeKioskAreaName(area);
  if (isWindingMachineAreaName(normalized) || isWindingMachineAreaName(area)) {
    return displayMachineName(normalized || area);
  }
  return normalized || area || '-';
}

function isQaQcKioskArea(area) {
  return normalizeKioskAreaName(area) === 'QA/QC';
}

function isWindingMachineKioskArea(area) {
  return isWindingMachineAreaName(area);
}

function windingMachineSlugForArea(areaName) {
  const canonical = normalizeWindingMachineAreaName(String(areaName || '').trim());
  const spec = WINDING_MACHINES.find((m) => m.areaName === canonical);
  if (spec && spec.kioskSlug) return spec.kioskSlug;
  return slugFromMachineName(canonical);
}

function kioskMachinePathForArea(areaName) {
  const slug = windingMachineSlugForArea(areaName);
  return `/kiosk/machine/${encodeURIComponent(slug)}`;
}

function kioskLandingPathForUser(kioskUser) {
  if (kioskUser && isQaQcKioskArea(kioskUser.area_name)) return '/qa-qc';
  if (kioskUser && isWindingMachineKioskArea(kioskUser.area_name)) {
    return kioskMachinePathForArea(kioskUser.area_name);
  }
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
  const tankRow = await validateTankExists(tank);
  if (!tankRow) {
    return { ok: false, status: 404, body: tankNotFoundBody() };
  }
  const tankBlock = tankProductionBlockBody(tankRow);
  if (tankBlock) {
    return { ok: false, status: tankBlock.error === 'tank_in_trash' ? 403 : 403, body: tankBlock };
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

async function migratePartCompleteEventsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS part_complete_events (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT REFERENCES machine_sessions(id) ON DELETE SET NULL,
        tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE RESTRICT,
        team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
        team_name TEXT,
        confirmed_by_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
        confirmed_by_employee_name TEXT,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_part_complete_events_tank ON part_complete_events(tank_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_part_complete_events_completed ON part_complete_events(completed_at DESC)`);
  } catch (err) {
    console.warn('[migration] part_complete_events:', err.message);
  }
}

async function backfillPartCompleteEventsFromSessions() {
  try {
    const { rowCount } = await pool.query(`
      INSERT INTO part_complete_events
        (session_id, tank_id, team_id, team_name, confirmed_by_employee_id, confirmed_by_employee_name, completed_at, created_at)
      SELECT sub.id, sub.tank_id, sub.team_id, sub.team_name, NULL, NULL, sub.completed_at, sub.completed_at
      FROM (
        SELECT DISTINCT ON (ms.tank_id)
          ms.id, ms.tank_id, ms.team_id, t.name AS team_name,
          COALESCE(ms.finished_at, ms.updated_at, NOW()) AS completed_at
        FROM machine_sessions ms
        JOIN teams t ON t.id = ms.team_id
        WHERE ms.activity_code = 'PART_COMPLETE'
          AND ms.status = 'finished'
        ORDER BY ms.tank_id, ms.finished_at DESC NULLS LAST, ms.id DESC
      ) sub
      WHERE NOT EXISTS (SELECT 1 FROM part_complete_events pce WHERE pce.tank_id = sub.tank_id)
    `);
    if (rowCount > 0) console.log(`[backfill] part_complete_events: inserted ${rowCount} row(s) from machine_sessions`);
  } catch (err) {
    console.warn('[backfill] part_complete_events:', err.message);
  }
}

async function migrateSessionTeamMembersTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_team_members (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES machine_sessions(id) ON DELETE CASCADE,
        employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        team_member_id BIGINT REFERENCES team_members(id) ON DELETE SET NULL,
        employee_code TEXT,
        employee_name TEXT,
        hourly_rate NUMERIC(10, 2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(session_id, employee_id)
      )`);
    await pool.query(`ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_code TEXT`);
    await pool.query(`ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS employee_name TEXT`);
    await pool.query(`ALTER TABLE session_team_members ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10, 2)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_team_members_employee ON session_team_members(employee_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_team_members_session ON session_team_members(session_id)`);
    await pool.query(`
      UPDATE session_team_members stm
      SET employee_code = COALESCE(stm.employee_code, e.code),
          employee_name = COALESCE(stm.employee_name, e.name),
          hourly_rate = COALESCE(stm.hourly_rate, e.hourly_rate, 0)
      FROM employees e
      WHERE e.id = stm.employee_id
        AND (stm.employee_code IS NULL OR stm.employee_name IS NULL OR stm.hourly_rate IS NULL)`);
  } catch (err) {
    console.warn('[migration] session_team_members:', err.message);
  }
}

async function migrateTeamMembersEmployeeIdColumn() {
  try {
    await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_team_members_employee_id ON team_members(employee_id)`);
  } catch (err) {
    console.warn('[migration] team_members.employee_id:', err.message);
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

async function migrateTankWipColumns() {
  try {
    await pool.query(`ALTER TABLE tanks ADD COLUMN IF NOT EXISTS paused_reason TEXT`);
    await pool.query(`ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_phase_code TEXT`);
    await pool.query(`ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_phase_name TEXT`);
    await pool.query(`ALTER TABLE tanks ADD COLUMN IF NOT EXISTS wip_machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL`);
  } catch (err) {
    console.warn('[migration] tanks wip:', err.message);
  }
}

/** Daily team-to-machine assignment (valid for one workday). */
async function migrateMachineTeamAssignmentColumns() {
  try {
    await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS assigned_team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS assigned_team_day TEXT`);
    await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS assigned_team_at TIMESTAMPTZ`);
  } catch (err) {
    console.warn('[migration] machine team assignment:', err.message);
  }
}

async function migrateAlertEmailColumns() {
  try {
    await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_status TEXT`);
    await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_error TEXT`);
    await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_status TEXT`);
    await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_error TEXT`);
    await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolve_email_sent_at TIMESTAMPTZ`);
  } catch (err) {
    console.warn('[migration] alert email columns:', err.message);
  }
}

async function migrateAlertEmailRecipientsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alert_email_recipients (
        id BIGSERIAL PRIMARY KEY,
        alert_type TEXT NOT NULL CHECK (alert_type IN ('qa_qc', 'maintenance')),
        email TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (alert_type, email)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_alert_email_recipients_type ON alert_email_recipients(alert_type)`);
  } catch (err) {
    console.warn('[migration] alert email recipients:', err.message);
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
  const tankRow = await validateTankExists(tank);
  if (!tankRow) {
    return { ok: false, status: 404, body: tankNotFoundBody() };
  }
  const tankBlock = tankProductionBlockBody(tankRow);
  if (tankBlock) {
    if (tankBlock.error === 'tank_archived') {
      tankBlock.message = 'This tank is completed. Restore it in Tank Management before assigning work.';
    }
    return { ok: false, status: 403, body: tankBlock };
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
    const tankRow = await validateTankExists(tankNumber);
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
    const tankRow = await validateTankExists(tankRaw);
    if (!tankRow) {
      return res.status(404).json(tankNotFoundBody());
    }
    const tankBlock = tankProductionBlockBody(tankRow);
    if (tankBlock) {
      if (tankBlock.error === 'tank_archived') {
        tankBlock.message = 'This tank is completed. Restore it in Tank Management before assigning work.';
      }
      return res.status(403).json(tankBlock);
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
      const tankRow = await validateTankExists(tankRaw);
      if (!tankRow) {
        return res.status(404).json(tankNotFoundBody());
      }
      const tankBlock = tankProductionBlockBody(tankRow);
      if (tankBlock) {
        if (tankBlock.error === 'tank_archived') {
          tankBlock.message = 'This tank is completed. Restore it in Tank Management before assigning work.';
        }
        return res.status(403).json(tankBlock);
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
      const tankRow = await validateTankExists(tankRaw);
      if (!tankRow) {
        return res.status(404).json(tankNotFoundBody());
      }
      const tankBlock = tankProductionBlockBody(tankRow);
      if (tankBlock) {
        if (tankBlock.error === 'tank_archived') {
          tankBlock.message = 'This tank is completed. Restore it in Tank Management before assigning work.';
        }
        return res.status(403).json(tankBlock);
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

/** Registry status: always lowercase `waiting` | `active` | `paused` | `archived`. */
function normalizeTankStatus(raw) {
  const s = String(raw == null || raw === '' ? 'waiting' : raw)
    .trim()
    .toLowerCase();
  if (s === 'archived' || s === 'completed') return 'archived';
  if (s === 'paused') return 'paused';
  if (s === 'waiting' || s === 'pending') return 'waiting';
  return 'active';
}

const TANK_SELECT_COLUMNS =
  'id, tank_number, description, status, created_at, completed_at, updated_at, first_scanned_at, customer, model, priority, due_date, notes, piece_count, current_piece_number, deleted_at, deleted_by, deleted_reason, previous_status, restored_at, restored_by';

function tankTimestampToIso(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function computeTankDurationMs(row) {
  const status = normalizeTankStatus(row && row.status);
  if (status === 'waiting') return 0;
  // Duration starts only after first production scan (Tank Created ≠ Tank Started).
  const startIso = tankTimestampToIso(row && row.first_scanned_at);
  if (!startIso) return 0;
  const start = new Date(startIso);
  let end = new Date();
  if (status === 'archived') {
    const completedIso = tankTimestampToIso(row.completed_at);
    end = completedIso ? new Date(completedIso) : new Date();
    if (Number.isNaN(end.getTime())) end = new Date();
  }
  return Math.max(0, end.getTime() - start.getTime());
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
  const first_scanned_at = tankTimestampToIso(row.first_scanned_at);
  const completed_at = status === 'archived' ? tankTimestampToIso(row.completed_at) : null;
  const duration_ms = computeTankDurationMs({ ...row, created_at, completed_at, status, first_scanned_at });
  return {
    id: Number(row.id),
    tank_number: row.tank_number,
    description: row.description || '',
    customer: row.customer || '',
    model: row.model || '',
    priority: row.priority || '',
    due_date: row.due_date || null,
    notes: row.notes || '',
    piece_count: Math.min(4, Math.max(1, Number(row.piece_count) || 1)),
    current_piece_number: Math.min(4, Math.max(1, Number(row.current_piece_number) || 1)),
    status,
    created_at,
    first_scanned_at,
    started_at: first_scanned_at,
    completed_at,
    updated_at: tankTimestampToIso(row.updated_at),
    duration_ms,
    duration_display: formatTankDurationDisplay(duration_ms),
    deleted_at: tankTimestampToIso(row.deleted_at),
    deleted_by: row.deleted_by || null,
    deleted_reason: row.deleted_reason || null,
    previous_status: row.previous_status ? normalizeTankStatus(row.previous_status) : null,
    restored_at: tankTimestampToIso(row.restored_at),
    restored_by: row.restored_by || null,
    is_deleted: row.deleted_at != null,
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

/** Idempotent seed of canonical winding machines + starter team (empty Neon). */
async function seedWindingDefaults() {
  const ts = nowIso();
  for (const m of WINDING_MACHINES) {
    await pool.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (code) DO NOTHING`,
      [m.areaName, m.code, m.barcode, m.kioskSlug, m.sortOrder, ts, ts]
    );
  }
  await pool.query(
    `INSERT INTO teams (name, barcode, active, created_at, updated_at)
     VALUES ($1, $2, 1, $3::timestamptz, $4::timestamptz)
     ON CONFLICT (barcode) DO NOTHING`,
    ['Winder 1', 'TEAM-WINDER-1', ts, ts]
  );
}

async function isCoreSeedPresent() {
  try {
    const users = await pool.query(`SELECT 1 FROM users WHERE username = 'manager' LIMIT 1`);
    const machines = await pool.query(`SELECT 1 FROM machines WHERE code = 'WM-01' LIMIT 1`);
    return users.rows.length > 0 && machines.rows.length > 0;
  } catch {
    return false;
  }
}

async function runSeedIfNeeded() {
  const already = await isCoreSeedPresent();
  if (already) {
    // Fill missing PIN hashes only — never rewrite profiles every request.
    await ensureKioskDefaultPins();
    return { skipped: true };
  }
  await seedIfEmpty();
  await seedDefaultUsers();
  await ensureKioskAreaProfiles();
  await ensureKioskDefaultPins();
  await seedWindingDefaults();
  return { skipped: false };
}

const DB_INIT_TIMEOUT_MS = Number(process.env.DB_INIT_TIMEOUT_MS) > 0 ? Number(process.env.DB_INIT_TIMEOUT_MS) : 25000;

async function initializeDatabase() {
  console.log('[db-init] starting');
  await withTimeout(runPostgresSchema(), DB_INIT_TIMEOUT_MS, 'schema init');
  console.log('[db-init] schema complete');
  await withTimeout(
    withDbRetry(runSeedIfNeeded, { label: 'seed', maxAttempts: 2, delayMs: 800 }),
    DB_INIT_TIMEOUT_MS,
    'seed'
  );
  console.log('[db-init] seed complete');
  console.log('[db-init] ready');
}

/** Process-level singleton so concurrent Vercel requests share one init promise. */
function ensureDatabaseReady() {
  const g = globalThis;
  if (g.__factoryScanDbInitPromise) return g.__factoryScanDbInitPromise;
  g.__factoryScanDbInitPromise = initializeDatabase().catch((err) => {
    g.__factoryScanDbInitPromise = null;
    console.error('[db-init] failed:', err && err.message ? err.message : err);
    if (!process.env.VERCEL) {
      console.error('\n' + formatDbError(err) + '\n');
      process.exit(1);
    }
    throw err;
  });
  return g.__factoryScanDbInitPromise;
}

const dbReady = ensureDatabaseReady();

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

/** Production must never auto-create tanks. Manager Add Tank is the only create path. */
const TANK_NOT_FOUND_MESSAGE = 'Tank not found. Please contact your supervisor.';

async function validateTankExists(rawTankNumber) {
  const tankNumber = normalizeTankNumber(rawTankNumber);
  if (!tankNumber) return null;
  return getTankByNumber(tankNumber);
}

function isTankDeleted(row) {
  return !!(row && row.deleted_at != null && row.deleted_at !== '');
}

function tankNotDeletedClause(alias) {
  const p = alias ? `${alias}.` : '';
  return `${p}deleted_at IS NULL`;
}

function tankInTrashClause(alias) {
  const p = alias ? `${alias}.` : '';
  return `${p}deleted_at IS NOT NULL`;
}

function tankProductionBlockBody(tankRow) {
  if (!tankRow) return tankNotFoundBody();
  if (isTankDeleted(tankRow)) {
    return {
      ok: false,
      error: 'tank_in_trash',
      message: `Tank ${tankRow.tank_number} is in Trash and cannot be used. Contact a manager.`,
    };
  }
  if (normalizeTankStatus(tankRow.status) === 'archived') {
    return {
      ok: false,
      error: 'tank_archived',
      message: 'This tank is completed. Restore it in Tank Management before resuming work.',
    };
  }
  return null;
}

function managerAuditName(req) {
  const auth = currentManagerFromSession(req);
  return auth && auth.username ? String(auth.username) : 'manager';
}

async function writeTankAdminAudit(client, { action, tankId, tankNumber, performedBy, reason, previousStatus, details }) {
  await client.query(
    `INSERT INTO tank_admin_audit (action, tank_id, tank_number, performed_by, performed_at, reason, previous_status, details)
     VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7::jsonb)`,
    [
      action,
      tankId != null ? Number(tankId) : null,
      String(tankNumber),
      String(performedBy),
      reason != null && String(reason).trim() !== '' ? String(reason).trim().slice(0, 500) : null,
      previousStatus != null ? String(previousStatus) : null,
      details != null ? JSON.stringify(details) : null,
    ]
  );
}

async function getTankTrashBlockers(tankId) {
  const tid = Number(tankId);
  if (!Number.isInteger(tid) || tid <= 0) return { blocked: true, reasons: ['invalid tank'] };
  const reasons = [];
  const { rows: running } = await pool.query(
    `SELECT 1 FROM machine_sessions WHERE tank_id = $1 AND status = 'running' LIMIT 1`,
    [tid]
  );
  if (running.length) reasons.push('running phase');
  const { rows: openSessions } = await pool.query(
    `SELECT 1 FROM machine_sessions WHERE tank_id = $1 AND status IN ('running', 'stopped') LIMIT 1`,
    [tid]
  );
  if (openSessions.length) reasons.push('active piece session');
  const { rows: openAlerts } = await pool.query(
    `SELECT 1 FROM alert_events WHERE tank_id = $1 AND status = 'open' LIMIT 1`,
    [tid]
  );
  if (openAlerts.length) reasons.push('open QA/QC');
  const { rows: openDowntime } = await pool.query(
    `SELECT 1 FROM downtime_intervals WHERE tank_id = $1 AND ended_at IS NULL LIMIT 1`,
    [tid]
  );
  if (openDowntime.length) reasons.push('active downtime');
  // Only treat WIP as active when the tank is paused (End Shift). Stale wip_* on
  // active/waiting/archived tanks must not block Trash — those fields are cleared on trash.
  const { rows: wipRows } = await pool.query(
    `SELECT 1 FROM tanks
     WHERE id = $1
       AND LOWER(TRIM(COALESCE(status, ''))) = 'paused'
       AND (wip_team_id IS NOT NULL OR wip_machine_id IS NOT NULL)
     LIMIT 1`,
    [tid]
  );
  if (wipRows.length) reasons.push('active team/winder assignment (paused End Shift WIP)');
  const { rows: machineRows } = await pool.query(
    `SELECT 1 FROM machines WHERE active_tank_id = $1 LIMIT 1`,
    [tid]
  );
  if (machineRows.length) reasons.push('active winder assignment');
  return { blocked: reasons.length > 0, reasons };
}

async function tankHasProductionHistory(tankId) {
  return phase1.tankHasProductionActivity(tankId);
}

async function permanentlyDeleteTank(client, tankId, auditMeta) {
  const tid = Number(tankId);
  const tankRes = await client.query(
    `SELECT id, tank_number, status, deleted_at FROM tanks WHERE id = $1`,
    [tid]
  );
  if (!tankRes.rows.length) return { ok: false, error: 'not_found' };
  const tank = tankRes.rows[0];
  if (!isTankDeleted(tank)) {
    return { ok: false, error: 'not_in_trash', message: 'Tank must be in Trash before permanent deletion.' };
  }

  await writeTankAdminAudit(client, {
    action: 'permanent_delete',
    tankId: tid,
    tankNumber: tank.tank_number,
    performedBy: auditMeta.performedBy,
    reason: auditMeta.reason || null,
    previousStatus: tank.status,
    details: { tank_id: tid, tank_number: tank.tank_number },
  });

  await client.query(`UPDATE machines SET active_tank_id = NULL, updated_at = NOW() WHERE active_tank_id = $1`, [tid]);
  await client.query(`DELETE FROM machine_sessions WHERE tank_id = $1`, [tid]);
  await client.query(`DELETE FROM part_complete_events WHERE tank_id = $1`, [tid]);
  await client.query(`DELETE FROM downtime_intervals WHERE tank_id = $1`, [tid]);
  await client.query(`UPDATE alert_events SET tank_id = NULL WHERE tank_id = $1`, [tid]);
  await client.query(`UPDATE production_notes SET tank_id = NULL WHERE tank_id = $1`, [tid]);
  await client.query(`UPDATE job_finish_events SET tank_id = NULL WHERE tank_id = $1`, [tid]);
  await client.query(`DELETE FROM tank_pieces WHERE tank_id = $1`, [tid]);
  await client.query(`DELETE FROM tanks WHERE id = $1`, [tid]);
  return { ok: true, tank_number: tank.tank_number };
}

async function getTrashTankCount() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM tanks WHERE deleted_at IS NOT NULL`);
  return Number(rows[0] && rows[0].n) || 0;
}

async function assertTankTrashSchemaReady() {
  const client = await pool.connect();
  try {
    await ensureTankTrashSchema(client);
  } finally {
    client.release();
  }
}

function formatTankTrashServerError(err) {
  const msg = err && err.message ? String(err.message) : 'Unknown error';
  if (/column .* does not exist|tank_admin_audit|trash columns missing/i.test(msg)) {
    return 'Trash is not available because the database schema is not fully migrated. Restart the server to run migrations, then try again.';
  }
  return `Could not move tank to Trash. ${msg}`;
}

async function findTankNumberConflict(tankNumber) {
  const { rows } = await pool.query(
    `SELECT id, tank_number, deleted_at FROM tanks WHERE tank_number = $1 LIMIT 1`,
    [tankNumber]
  );
  return rows[0] || null;
}

function tankNotFoundBody() {
  return { ok: false, error: 'tank_not_found', message: TANK_NOT_FOUND_MESSAGE };
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
    await withTimeout(ensureDatabaseReady(), DB_INIT_TIMEOUT_MS + 5000, 'database ready');
    next();
  } catch (err) {
    console.error('[boot] database unavailable:', formatDbError(err));
    res.status(503).json({
      ok: false,
      error: 'database_unavailable',
      message: 'Database is still starting or unavailable. Please retry in a moment.',
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
    phase1_kiosk_login_areas: PHASE1_KIOSK_LOGIN_AREAS,
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
  const username =
    KIOSK_AREA_TO_USERNAME[area] ||
    KIOSK_AREA_TO_USERNAME[normalizeWindingMachineAreaName(area)] ||
    KIOSK_AREA_TO_USERNAME[normalizeKioskAreaName(area)];
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
  const machineSlug = isWindingMachineKioskArea(req.session.kiosk_user.area_name)
    ? windingMachineSlugForArea(req.session.kiosk_user.area_name)
    : null;
  return res.json({
    ok: true,
    role: ROLE.KIOSK,
    redirect: kioskLandingPathForUser(req.session.kiosk_user),
    machine_slug: machineSlug,
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
  if (req.session) {
    delete req.session.kiosk_user;
    delete req.session.machine_kiosk;
  }
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

/** Phase 1 winding production logic */
const phase1 = createPhase1ProductionLogic({
  pool,
  nowIso,
  normalizeTankNumber,
  validateTankExists,
  tankNotFoundMessage: TANK_NOT_FOUND_MESSAGE,
  normalizeTankStatus,
  startEndOfLocalDay,
  localDateString,
  weekBoundsLocal,
});

const alertEmail = createAlertEmailService({ pool });

void ensureDatabaseReady().then(async () => {
  try {
    await phase1.backfillOpenSessionTeamMembers();
  } catch (err) {
    console.warn('[boot] open session team member backfill:', err.message);
  }
});

async function windingMachineFromKioskAuth(auth) {
  if (!auth || !isWindingMachineKioskArea(auth.area_name)) return null;
  return phase1.getMachineByAreaName(auth.area_name);
}

function currentMachineKioskFromSession(req) {
  return req.session && req.session.machine_kiosk ? req.session.machine_kiosk : null;
}

async function windingMachineFromRequest(req) {
  const mk = currentMachineKioskFromSession(req);
  if (mk && mk.machine_id) {
    return phase1.getMachineById(mk.machine_id);
  }
  const auth = currentKioskFromSession(req);
  return windingMachineFromKioskAuth(auth);
}

function mapWindingMachineResponse(machine) {
  if (!machine) return null;
  return mapMachineForClient(machine);
}

async function lookupActiveEmployeeByScan(raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  const { rows } = await pool.query(
    `SELECT id, code, name FROM employees
     WHERE is_active = 1 AND REPLACE(UPPER(TRIM(code)), ' ', '') = $1
     LIMIT 1`,
    [code]
  );
  return rows[0] || null;
}

function confirmerFromBody(body) {
  const b = body || {};
  const c = b.confirmer || b.pending_confirmer || null;
  if (!c) return null;
  const id = c.id != null ? Number(c.id) : c.employee_id != null ? Number(c.employee_id) : null;
  const name = c.name != null ? String(c.name).trim() : c.employee_name != null ? String(c.employee_name).trim() : '';
  if (!Number.isInteger(id) || id <= 0 || !name) return null;
  return { id, name, code: c.code ? String(c.code) : null };
}

const NEED_TEAM_MESSAGE = 'Please scan a Team barcode first.';

async function resolveWindingFocusedSession(machine, pending, openRowsOptional) {
  const openRows = openRowsOptional || (await phase1.getOpenSessionsForMachine(machine.id));
  if (pending.piece != null) {
    const pieceNum = Number(pending.piece);
    if (pending.tank) {
      const tankNorm = String(pending.tank).toUpperCase();
      const match = openRows.find(
        (r) =>
          String(r.tank_number || '').toUpperCase() === tankNorm &&
          Number(r.piece_number || 1) === pieceNum
      );
      return match || null;
    }
    const activeTankId = machine.active_tank_id != null ? Number(machine.active_tank_id) : null;
    if (activeTankId) {
      const match = await phase1.getOpenSessionForPiece(machine.id, activeTankId, pieceNum);
      return match || null;
    }
    return null;
  }
  if (pending.tank) {
    const tankNorm = String(pending.tank).toUpperCase();
    const sameTank = openRows.filter((r) => String(r.tank_number || '').toUpperCase() === tankNorm);
    if (sameTank.length === 1) return sameTank[0];
    return null;
  }
  return (await phase1.getOpenSession(machine.id)) || openRows[0] || null;
}

async function resolvePhaseTargetSession(machine, pending, openRows) {
  const pieceNum = pending.piece != null ? Number(pending.piece) : null;
  let tankRow = null;
  if (pending.tank) {
    tankRow = await validateTankExists(pending.tank);
  } else if (machine.active_tank_id) {
    const r = await pool.query(`SELECT * FROM tanks WHERE id = $1`, [Number(machine.active_tank_id)]);
    tankRow = r.rows[0] || null;
  }
  if (pieceNum != null) {
    if (!tankRow) return null;
    return (await phase1.getOpenSessionForPiece(machine.id, tankRow.id, pieceNum)) || null;
  }
  if (tankRow) {
    const sameTank = openRows.filter((r) => Number(r.tank_id) === Number(tankRow.id));
    if (sameTank.length === 1) return sameTank[0];
    return null;
  }
  return (await phase1.getOpenSession(machine.id)) || openRows[0] || null;
}

async function mapOpenSessionsPayload(machineId, activeTankIdOptional) {
  const openRows = await phase1.getOpenSessionsForMachine(machineId);
  const open_sessions = [];
  for (const row of openRows) {
    open_sessions.push(await phase1.mapSession(row));
  }
  const activeTankId =
    activeTankIdOptional != null
      ? Number(activeTankIdOptional)
      : null;
  const tank_open_sessions = activeTankId
    ? open_sessions.filter((s) => Number(s.tank_id) === activeTankId)
    : open_sessions;
  const active_work = open_sessions.map((s) => ({
    tank_id: s.tank_id,
    tank_number: s.tank_number,
    piece_number: Number(s.piece_number) || 1,
    phase_code: s.phase_code || s.activity_code,
    phase_name: s.phase_name || s.activity_name,
    status: s.status,
    status_label: s.status_label,
    session_id: s.id,
  }));
  return { open_sessions, tank_open_sessions, active_work };
}

async function handleWindingScanAction(machine, body) {
  const barcode = body.barcode;
  const pendingIn = body.pending || {};
  let pending = {
    tank: pendingIn.tank || null,
    piece: pendingIn.piece != null ? Number(pendingIn.piece) : null,
  };
  if (pending.piece != null && (!Number.isInteger(pending.piece) || pending.piece < 1 || pending.piece > 4)) {
    pending.piece = null;
  }
  const parsed = phase1.parseScan(barcode);
  const openRows = await phase1.getOpenSessionsForMachine(machine.id);
  const session = await resolveWindingFocusedSession(machine, pending, openRows);
  const assignment = await phase1.getMachineAssignment(machine.id);

  // Global Winder/team actions (apply to ALL open tanks — not just selected).
  if (parsed.type === 'pause') {
    const result = await phase1.pauseSession(machine, parsed.value, {});
    if (!result.ok) return result;
    return { ok: true, status: 200, body: { ok: true, ...result.body, assignment } };
  }

  // Tank-specific Downtime (selected tank only).
  if (parsed.type === 'downtime') {
    const result = await phase1.pauseDowntimeSession(machine, {
      tank_number: pending.tank || (session && session.tank_number) || null,
      tank_id: body.tank_id != null ? Number(body.tank_id) : session ? Number(session.tank_id) : null,
      piece_number:
        pending.piece != null ? pending.piece : session && session.piece_number != null ? session.piece_number : null,
      reason_code: body.reason_code || body.downtime_reason || null,
      reason_note: body.reason_note || body.downtime_note || null,
    });
    if (!result.ok) return result;
    return { ok: true, status: 200, body: { ok: true, ...result.body, assignment } };
  }

  if (parsed.type === 'end_shift') {
    const result = await phase1.endShiftSession(machine, {});
    if (!result.ok) return result;
    return { ok: true, status: 200, body: { ok: true, ...result.body } };
  }

  if (parsed.type === 'alert') {
    const result = await phase1.createAlert(machine, barcode, session, {
      notes: body.notes || body.issue_note || null,
    });
    if (!result.ok) return result;
    if (result.body && result.body.alert && result.body.alert.id) {
      alertEmail.queueNewAlertEmail(result.body.alert.id);
    }
    return { ok: true, status: 200, body: { ok: true, ...result.body, assignment } };
  }

  if (parsed.type === 'qa_qc_resolve') {
    const result = await phase1.resolveQaQcForMachine(machine, {
      session,
      resolution_note: body.resolution_note || body.notes || null,
      resolved_by: body.resolved_by || 'kiosk',
    });
    if (!result.ok) return result;
    if (result.body && result.body.alert && result.body.alert.id) {
      alertEmail.queueResolveAlertEmail(result.body.alert.id);
    }
    return { ok: true, status: 200, body: { ok: true, ...result.body, assignment } };
  }

  // Team scan: assign the team to this machine for the day.
  if (parsed.type === 'team') {
    const team = await phase1.getTeamByBarcode(parsed.value);
    if (!team || !Number(team.active)) {
      return { ok: false, status: 404, body: { ok: false, error: 'unknown_team', message: 'Unknown team barcode.' } };
    }
    const newAssignment = await phase1.assignTeamToMachine(machine.id, team);
    return {
      ok: true,
      status: 200,
      body: { ok: true, action: 'team_assigned', assignment: newAssignment, pending: { tank: null } },
    };
  }

  // Resume: selected Downtime tank only, OR all Break/Lunch on Winder, OR all End Shift WIP.
  // QA/QC uses Resolve QA/QC (not normal Resume).
  if (parsed.type === 'resume') {
    const selected =
      (pending.tank
        ? openRows.find((r) => {
            const tankMatch =
              String(r.tank_number || '').toUpperCase() === String(pending.tank).toUpperCase();
            if (!tankMatch) return false;
            if (pending.piece != null) return Number(r.piece_number || 1) === Number(pending.piece);
            return true;
          })
        : null) || session;

    if (
      selected &&
      selected.status === 'stopped' &&
      phase1.isQaQcStopReason(selected.stop_reason)
    ) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'use_resolve_qa_qc',
          message: 'This piece is on QA/QC. Scan QA_QC_RESOLVE or tap Resolve QA/QC.',
        },
      };
    }

    if (
      selected &&
      selected.status === 'stopped' &&
      phase1.isDowntimeStopReason(selected.stop_reason)
    ) {
      const result = await phase1.resumeSelectedSession(machine, {
        tank_id: Number(selected.tank_id),
        piece_number:
          pending.piece != null ? pending.piece : selected.piece_number != null ? selected.piece_number : null,
      });
      if (!result.ok) return result;
      return { ok: true, status: 200, body: { ok: true, ...result.body, assignment } };
    }

    const pausedOpen = openRows.filter(
      (s) => s.status === 'stopped' && phase1.isWinderResumableStopReason(s.stop_reason)
    );
    if (pausedOpen.length) {
      const result = await phase1.resumeSession(machine, {});
      if (!result.ok) return result;
      return { ok: true, status: 200, body: { ok: true, ...result.body, assignment } };
    }
    if (!assignment) {
      return { ok: false, status: 409, body: { ok: false, error: 'need_team', message: NEED_TEAM_MESSAGE } };
    }
    // After End Shift: resume all WIP tanks on this Winder together.
    if (body.resume_all_wip === true || !pending.tank) {
      const allWip = await phase1.resumeAllEndShiftWipTanks(
        machine,
        {
          id: assignment.team_id,
          name: assignment.team_name,
          barcode: assignment.team_barcode,
          active: 1,
        },
        {}
      );
      if (allWip.ok) {
        return { ok: true, status: 200, body: { ok: true, ...allWip.body, assignment, pending: { tank: null } } };
      }
      if (!pending.tank) return allWip;
    }
    if (!pending.tank) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'need_tank', message: 'Scan the tank to resume its End Shift paused phase.' },
      };
    }
    const result = await phase1.resumePausedTank(machine, pending.tank, {
      id: assignment.team_id,
      name: assignment.team_name,
      barcode: assignment.team_barcode,
      active: 1,
    });
    if (!result.ok) return result;
    return { ok: true, status: 200, body: { ok: true, ...result.body, assignment, pending: { tank: null } } };
  }

  // All tank/phase scans require a team assignment.
  if ((parsed.type === 'tank' || parsed.type === 'phase') && !assignment) {
    return { ok: false, status: 409, body: { ok: false, error: 'need_team', message: NEED_TEAM_MESSAGE } };
  }

  if (parsed.type === 'tank') {
    pending.tank = parsed.value;
    pending.piece = null;
    const tankRow = await validateTankExists(pending.tank);
    if (!tankRow) {
      return { ok: false, status: 404, body: tankNotFoundBody() };
    }
    const tankBlock = tankProductionBlockBody(tankRow);
    if (tankBlock) {
      if (tankBlock.error === 'tank_archived') {
        tankBlock.message = 'This tank is completed. Restore it in Tank Management before use.';
      }
      return { ok: false, status: 403, body: tankBlock };
    }
    const pieceCount = Math.min(4, Math.max(1, Number(tankRow.piece_count) || 1));
    await phase1.ensureTankPieces(tankRow.id, pieceCount);
    const pieces = await phase1.getTankPieces(tankRow.id);
    const configuredPieces = pieces.filter((p) => Number(p.piece_number) <= pieceCount);
    // Multi-tank: if this tank already has an open session on this machine, switch to it.
    const openRows = await phase1.getOpenSessionsForMachine(machine.id);
    const match = openRows.find(
      (r) => String(r.tank_number || '').toUpperCase() === String(pending.tank).toUpperCase()
    );
    if (match) {
      await phase1.setMachineActiveTank(machine.id, match.tank_id);
      const tankSessions = openRows.filter((r) => Number(r.tank_id) === Number(match.tank_id));
      if (pieceCount === 1) pending.piece = 1;
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          action: 'tank_selected',
          assignment,
          pending,
          pieces: configuredPieces,
          piece_count: pieceCount,
          open_sessions: await Promise.all(openRows.map((r) => phase1.mapSession(r))),
          tank_open_sessions: await Promise.all(tankSessions.map((r) => phase1.mapSession(r))),
          message:
            pieceCount === 1
              ? 'Piece 1 selected. Scan a phase to begin.'
              : `Select Piece 1–${pieceCount} for this tank.`,
        },
      };
    }
    if (pieceCount === 1) pending.piece = 1;
    const pausedTank = await phase1.getPausedTankByNumber(pending.tank);
    const resumablePhase =
      pausedTank && pausedTank.wip_phase_name ? pausedTank.wip_phase_name : null;
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        action: 'tank_selected',
        assignment,
        pending,
        pieces: configuredPieces,
        piece_count: pieceCount,
        open_sessions: await Promise.all(openRows.map((r) => phase1.mapSession(r))),
        resumable_phase: resumablePhase,
        message:
          pieceCount === 1
            ? 'Piece 1 selected. Scan a phase to begin.'
            : `Select Piece 1–${pieceCount} for this tank.`,
      },
    };
  }

  if (parsed.type === 'piece') {
    const pieceNum = Number(parsed.value);
    if (!assignment) {
      return { ok: false, status: 409, body: { ok: false, error: 'need_team', message: NEED_TEAM_MESSAGE } };
    }
    let tankRow = null;
    if (pending.tank) {
      tankRow = await validateTankExists(pending.tank);
    } else if (machine.active_tank_id) {
      const r = await pool.query(`SELECT * FROM tanks WHERE id = $1`, [Number(machine.active_tank_id)]);
      tankRow = r.rows[0] || null;
    } else if (session) {
      const r = await pool.query(`SELECT * FROM tanks WHERE id = $1`, [Number(session.tank_id)]);
      tankRow = r.rows[0] || null;
    }
    if (!tankRow) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'need_tank', message: 'Scan a tank before selecting a piece.' },
      };
    }
    const resolved = await phase1.resolvePieceForTank(tankRow.id, pieceNum);
    if (!resolved.ok) return resolved;
    if (String(resolved.piece.status) === 'completed') {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'piece_completed',
          message: `Piece ${pieceNum} is already completed. Select another piece.`,
          pieces: resolved.pieces,
        },
      };
    }
    const conflict = await phase1.findOpenPieceSession(tankRow.id, pieceNum, machine.id);
    if (conflict) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'piece_in_use',
          message: `Piece ${pieceNum} is currently being worked on by ${conflict.team_name || 'another team'} / ${conflict.machine_name || 'another winder'}.`,
          conflicting_team: conflict.team_name,
          conflicting_machine: conflict.machine_name,
        },
      };
    }
    pending.tank = tankRow.tank_number;
    pending.piece = pieceNum;
    await pool.query(`UPDATE tanks SET current_piece_number = $1, updated_at = NOW() WHERE id = $2`, [
      pieceNum,
      tankRow.id,
    ]);
    await phase1.setMachineActiveTank(machine.id, tankRow.id);
    const existingOnMachine = await phase1.getOpenSessionForPiece(machine.id, tankRow.id, pieceNum);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        action: 'piece_selected',
        piece_number: pieceNum,
        piece_id: resolved.piece.id,
        session: existingOnMachine ? await phase1.mapSession(existingOnMachine) : null,
        pieces: resolved.pieces.filter((p) => Number(p.piece_number) <= resolved.piece_count),
        piece_count: resolved.piece_count,
        assignment,
        pending,
        open_sessions: await Promise.all(openRows.map((r) => phase1.mapSession(r))),
        message: existingOnMachine
          ? `Piece ${pieceNum} selected — ${existingOnMachine.activity_name || existingOnMachine.activity_code} in progress. Scan a phase to change.`
          : `Piece ${pieceNum} selected. Scan a phase to begin.`,
      },
    };
  }

  if (parsed.type === 'employee_out') {
    if (!assignment) {
      return { ok: false, status: 409, body: { ok: false, error: 'need_team', message: NEED_TEAM_MESSAGE } };
    }
    const confirmer = confirmerFromBody(body);
    if (!confirmer) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'need_employee',
          message: 'Scan employee barcode first, then Employee Out.',
        },
      };
    }
    const out = await phase1.employeeOutFromTeam(confirmer.id, assignment.team_id, {
      source: 'kiosk_employee_out',
      reason: 'Kiosk employee out scan',
    });
    if (!out.ok) return out;
    return { ok: true, status: 200, body: { ok: true, ...out.body, assignment } };
  }

  if (parsed.type === 'phase') {
    const ph = phase1.resolvePhase(parsed.value);
    if (!ph) {
      return { ok: false, status: 400, body: { ok: false, error: 'validation', message: 'Unknown phase barcode.' } };
    }
    // Piece Complete / Tank Complete / Part Complete
    const focusedSession = await resolvePhaseTargetSession(machine, pending, openRows);
    if (ph.piece_complete || ph.completes) {
      if (!focusedSession) {
        // Tank Complete after all pieces are done (no open session).
        if (ph.code === 'TANK_COMPLETE' || ph.code === 'PART_COMPLETE') {
          const tankId =
            machine.active_tank_id != null
              ? Number(machine.active_tank_id)
              : pending.tank
                ? null
                : null;
          let tankRow = null;
          if (tankId) {
            const r = await pool.query(`SELECT * FROM tanks WHERE id = $1`, [tankId]);
            tankRow = r.rows[0] || null;
          } else if (pending.tank) {
            tankRow = await validateTankExists(pending.tank);
          }
          if (!tankRow) {
            return {
              ok: false,
              status: 409,
              body: {
                ok: false,
                error: 'no_session',
                message: 'No active session. Scan the tank first, then Tank Complete.',
              },
            };
          }
          const pieces = await phase1.getTankPieces(tankRow.id);
          const pieceCount = Math.min(4, Math.max(1, Number(tankRow.piece_count) || 1));
          const progress = phase1.computePieceProgress(pieces, pieceCount);
          if (!progress.all_pieces_complete) {
            return {
              ok: false,
              status: 409,
              body: {
                ok: false,
                error: 'pieces_incomplete',
                message:
                  'Complete all pieces before Tank Complete. Still needed: Piece ' +
                  progress.incomplete_pieces.join(', Piece ') +
                  '.',
                incomplete_pieces: progress.incomplete_pieces,
                pieces,
              },
            };
          }
          const confirmer = confirmerFromBody(body);
          const ts = nowIso();
          const fakeSession = {
            id: null,
            tank_id: tankRow.id,
            tank_number: tankRow.tank_number,
            team_id: assignment ? assignment.team_id : null,
            team_name: assignment ? assignment.team_name : null,
            piece_number: tankRow.current_piece_number || pieceCount,
          };
          const archived = await phase1.finishTankArchive(machine, fakeSession, {
            confirmedByEmployeeId: confirmer ? confirmer.id : null,
            confirmedByEmployeeName: confirmer ? confirmer.name : null,
          }, ts);
          return { ok: true, status: 200, body: { ok: true, ...archived.body, assignment } };
        }
        return {
          ok: false,
          status: 409,
          body: { ok: false, error: 'no_session', message: 'Start a phase before completing piece/tank.' },
        };
      }
      const confirmer = confirmerFromBody(body);
      const fin = await phase1.changePhase(machine, ph.barcode, {
        notes: body.notes || body.correction_note || null,
        confirmedByEmployeeId: confirmer ? confirmer.id : null,
        confirmedByEmployeeName: confirmer ? confirmer.name : null,
        forceTankComplete: ph.code === 'TANK_COMPLETE' || ph.code === 'PART_COMPLETE',
        pieceNumber:
          pending.piece != null
            ? pending.piece
            : focusedSession
              ? focusedSession.piece_number
              : null,
        tankId: focusedSession ? Number(focusedSession.tank_id) : null,
        session: focusedSession,
      });
      if (!fin.ok) return fin;
      const sessionsPayload = await mapOpenSessionsPayload(machine.id, machine.active_tank_id);
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          ...fin.body,
          assignment,
          pending: { tank: pending.tank, piece: pending.piece },
          ...sessionsPayload,
        },
      };
    }
    // Existing session on SELECTED piece -> change phase. No session on selected piece -> start new.
    if (focusedSession) {
      const pendingTankNorm = pending.tank ? String(pending.tank).toUpperCase() : null;
      const sessionTankNorm = focusedSession.tank_number
        ? String(focusedSession.tank_number).toUpperCase()
        : null;
      if (pendingTankNorm && pendingTankNorm !== sessionTankNorm) {
        const pieceForStart =
          body.piece_number != null ? Number(body.piece_number) : pending.piece != null ? Number(pending.piece) : null;
        if (pieceForStart == null) {
          return {
            ok: false,
            status: 409,
            body: {
              ok: false,
              error: 'need_piece',
              message: 'Select a piece for the new tank before scanning a phase.',
              pending,
            },
          };
        }
        const startOther = await phase1.startSession(machine, {
          team: { id: assignment.team_id, name: assignment.team_name, barcode: assignment.team_barcode, active: 1 },
          tankNumber: pending.tank,
          phaseRaw: ph.barcode,
          pieceNumber: pieceForStart,
          notes: body.notes || null,
        });
        if (!startOther.ok) return startOther;
        const sessionsPayload = await mapOpenSessionsPayload(machine.id, machine.active_tank_id);
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            ...startOther.body,
            assignment,
            pending: { tank: pending.tank, piece: pending.piece },
            ...sessionsPayload,
          },
        };
      }
      const ch = await phase1.changePhase(machine, ph.barcode, {
        notes: body.notes || body.correction_note || null,
        pieceNumber:
          pending.piece != null
            ? pending.piece
            : body.piece_number != null
              ? Number(body.piece_number)
              : focusedSession.piece_number,
        tankId: Number(focusedSession.tank_id),
        session: focusedSession,
        confirmedByEmployeeId: confirmerFromBody(body) ? confirmerFromBody(body).id : null,
        confirmedByEmployeeName: confirmerFromBody(body) ? confirmerFromBody(body).name : null,
      });
      if (!ch.ok) return ch;
      const sessionsPayload = await mapOpenSessionsPayload(machine.id, machine.active_tank_id);
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          ...ch.body,
          assignment,
          pending: { tank: pending.tank, piece: pending.piece },
          ...sessionsPayload,
        },
      };
    }
    // No open session on selected piece — start new phase for pending tank+piece.
    let tankForStart = pending.tank;
    if (!tankForStart && machine.active_tank_id) {
      const r = await pool.query(`SELECT tank_number FROM tanks WHERE id = $1`, [Number(machine.active_tank_id)]);
      tankForStart = r.rows[0] ? r.rows[0].tank_number : null;
    }
    if (!tankForStart) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'need_tank', message: 'Scan a tank before the phase.' },
      };
    }
    const pieceForStart =
      body.piece_number != null ? Number(body.piece_number) : pending.piece != null ? Number(pending.piece) : null;
    if (pieceForStart == null) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: 'need_piece',
          message: 'Select a piece before scanning a phase.',
          pending,
        },
      };
    }
    const start = await phase1.startSession(machine, {
      team: { id: assignment.team_id, name: assignment.team_name, barcode: assignment.team_barcode, active: 1 },
      tankNumber: tankForStart,
      phaseRaw: ph.barcode,
      pieceNumber: pieceForStart,
      notes: body.notes || null,
    });
    if (!start.ok) return start;
    const sessionsPayload = await mapOpenSessionsPayload(machine.id, machine.active_tank_id);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        ...start.body,
        assignment,
        pending: { tank: tankForStart, piece: pieceForStart },
        ...sessionsPayload,
      },
    };
  }

  const employee = await lookupActiveEmployeeByScan(barcode);
  if (employee) {
    if (!assignment) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, error: 'need_team', message: 'Scan Team first.' },
      };
    }
    if (body.employee_out === true) {
      const out = await phase1.employeeOutFromTeam(employee.id, assignment.team_id, {
        source: 'kiosk_employee_out',
        reason: 'Kiosk employee out button',
      });
      if (!out.ok) return out;
      return {
        ok: true,
        status: 200,
        body: { ok: true, ...out.body, assignment },
      };
    }

    const activeShift = await phase1.getEmployeeActiveShiftTeam(employee.id);
    const currentTeamId = Number(assignment.team_id);
    if (activeShift && Number(activeShift.team_id) === currentTeamId) {
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          action: 'employee_selected',
          employee: {
            id: Number(employee.id),
            code: employee.code,
            name: employee.name,
          },
          team: { id: currentTeamId, name: assignment.team_name },
          active_shift_team_id: currentTeamId,
          confirmation_line: `Selected Employee: ${employee.name}. Tap Employee Out when ready.`,
          confirmer: {
            id: Number(employee.id),
            code: employee.code,
            name: employee.name,
          },
          assignment,
        },
      };
    }

    const transfer = await phase1.transferEmployeeToTeam(employee.id, assignment.team_id, {
      source: 'kiosk_transfer',
      reason: 'Kiosk employee barcode scan',
    });
    if (!transfer.ok) return transfer;
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        ...transfer.body,
        // Also set confirmer for subsequent Piece/Tank Complete.
        confirmer: {
          id: Number(employee.id),
          code: employee.code,
          name: employee.name,
        },
        assignment,
      },
    };
  }

  return { ok: false, status: 400, body: { ok: false, error: 'unknown_barcode', message: 'Unrecognized barcode.' } };
}

app.get('/api/kiosk/winding/config', async (req, res) => {
  try {
    const machine = await windingMachineFromRequest(req);
    if (!machine || !Number(machine.active)) {
      return res.status(403).json({ ok: false, error: 'forbidden', message: 'Open a machine kiosk URL to use this screen.' });
    }
    const openRows = await phase1.getOpenSessionsForMachine(machine.id);
    const activeTankId = machine.active_tank_id != null ? Number(machine.active_tank_id) : null;
    let session =
      activeTankId != null
        ? openRows.find((r) => Number(r.tank_id) === activeTankId) || openRows[0] || null
        : openRows[0] || null;
    const mappedSession = session ? await phase1.mapSession(session) : null;
    const open_sessions = [];
    for (const row of openRows) {
      open_sessions.push(await phase1.mapSession(row));
    }
    const phaseTimeSummary =
      session && session.tank_id ? await phase1.fetchTankPhaseTimeSummary(Number(session.tank_id)) : [];
    let piecesTankId = session && session.tank_id ? Number(session.tank_id) : activeTankId;
    let pieces = piecesTankId ? await phase1.getTankPieces(piecesTankId) : [];
    let piece_count = 0;
    let active_tank_number = null;
    if (piecesTankId) {
      const tankMeta = await pool.query(
        `SELECT tank_number, piece_count FROM tanks WHERE id = $1`,
        [piecesTankId]
      );
      if (tankMeta.rows[0]) {
        piece_count = Math.min(4, Math.max(1, Number(tankMeta.rows[0].piece_count) || 1));
        active_tank_number = tankMeta.rows[0].tank_number;
        await phase1.ensureTankPieces(piecesTankId, piece_count);
        pieces = (await phase1.getTankPieces(piecesTankId)).filter((p) => Number(p.piece_number) <= piece_count);
      }
    }
    const assignment = await phase1.getMachineAssignment(machine.id);
    const { rows: teams } = await pool.query(`SELECT id, name, barcode FROM teams WHERE active = 1 ORDER BY name ASC`);
    let open_qa_qc = null;
    if (mappedSession && mappedSession.tank_id) {
      try {
        open_qa_qc = await phase1.findOpenQaQcAlert(
          mappedSession.tank_id,
          mappedSession.piece_number != null ? mappedSession.piece_number : 1
        );
      } catch (_err) {
        open_qa_qc = null;
      }
    }
    const tank_open_sessions = activeTankId
      ? open_sessions.filter((s) => Number(s.tank_id) === activeTankId)
      : [];
    const active_work = open_sessions.map((s) => ({
      tank_id: s.tank_id,
      tank_number: s.tank_number,
      piece_number: Number(s.piece_number) || 1,
      phase_code: s.phase_code || s.activity_code,
      phase_name: s.phase_name || s.activity_name,
      status: s.status,
      status_label: s.status_label,
      session_id: s.id,
    }));
    const productionCounts = phase1.countActiveProduction(open_sessions);
    return res.json({
      ok: true,
      workflow: 'winding_production',
      machine: mapWindingMachineResponse(machine),
      teams,
      phases: WINDING_PHASES,
      alerts: ALERT_TYPES,
      pause_actions: [PAUSE_REASONS.BREAK, PAUSE_REASONS.LUNCH],
      downtime_action: PAUSE_REASONS.DOWNTIME,
      downtime_reasons: DOWNTIME_REASON_OPTIONS,
      end_shift: PAUSE_REASONS.END_SHIFT,
      resume_barcode: 'RESUME',
      qa_qc_resolve_barcode: 'QA_QC_RESOLVE',
      employee_out_barcode: 'EMPLOYEE_OUT',
      assignment,
      session: mappedSession,
      open_sessions,
      tank_open_sessions,
      active_work,
      active_tank_count: productionCounts.active_tank_count,
      active_piece_count: productionCounts.active_piece_count,
      open_qa_qc,
      pieces,
      piece_count,
      active_tank_id: activeTankId,
      active_tank_number,
      phase_time_summary: phaseTimeSummary,
    });
  } catch (err) {
    console.error('[winding config]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load winding kiosk.' });
  }
});

app.post('/api/kiosk/winding/action', async (req, res) => {
  try {
    const machine = await windingMachineFromRequest(req);
    if (!machine || !Number(machine.active)) {
      return res.status(403).json({ ok: false, error: 'forbidden', message: 'Open a machine kiosk URL to use this screen.' });
    }
    const body = req.body || {};
    const action = String(body.action || '').trim().toLowerCase();
    let result;
    if (action === 'scan') {
      result = await handleWindingScanAction(machine, body);
    } else if (action === 'start') {
      result = await phase1.startSession(machine, {
        teamBarcode: body.team_barcode,
        tankNumber: body.tank_number,
        phaseRaw: body.phase,
        pieceNumber: body.piece_number != null ? Number(body.piece_number) : null,
      });
    } else if (action === 'change_phase') {
      const confirmer = confirmerFromBody(body);
      result = await phase1.changePhase(machine, body.phase, {
        notes: body.notes || body.correction_note || null,
        pieceNumber: body.piece_number,
        confirmedByEmployeeId: confirmer ? confirmer.id : null,
        confirmedByEmployeeName: confirmer ? confirmer.name : null,
        forceTankComplete: body.force_tank_complete === true,
      });
    } else if (action === 'switch_tank') {
      const tankId = Number(body.tank_id);
      if (!Number.isInteger(tankId) || tankId <= 0) {
        return res.status(400).json({ ok: false, error: 'validation', message: 'tank_id required.' });
      }
      await phase1.setMachineActiveTank(machine.id, tankId);
      const switched = await phase1.getOpenSession(machine.id, tankId);
      result = {
        ok: true,
        body: {
          ok: true,
          action: 'switch_tank',
          session: switched ? await phase1.mapSession(switched) : null,
        },
      };
    } else if (action === 'part_complete') {
      const confirmer = confirmerFromBody(body);
      result = await phase1.finishSession(machine, {
        confirmedByEmployeeId: confirmer ? confirmer.id : null,
        confirmedByEmployeeName: confirmer ? confirmer.name : null,
        forceTankComplete: true,
      });
    } else if (action === 'pause') {
      result = await phase1.pauseSession(machine, body.barcode || body.pause, {
        confirmed: body.confirmed === true,
      });
    } else if (action === 'resume') {
      result = await phase1.resumeSession(machine, { confirmed: body.confirmed === true });
    } else if (action === 'end_shift') {
      result = await phase1.endShiftSession(machine, { confirmed: body.confirmed === true });
    } else if (action === 'alert') {
      const session = await phase1.getOpenSession(machine.id);
      result = await phase1.createAlert(machine, body.barcode || body.alert, session, {
        notes: body.notes || body.issue_note || null,
      });
      if (result.ok && result.body && result.body.alert && result.body.alert.id) {
        alertEmail.queueNewAlertEmail(result.body.alert.id);
      }
    } else if (action === 'resolve_qa_qc') {
      const session = await phase1.getOpenSession(machine.id);
      result = await phase1.resolveQaQcForMachine(machine, {
        session,
        resolution_note: body.resolution_note || body.notes || null,
        resolved_by: body.resolved_by || 'kiosk',
      });
      if (result.ok && result.body && result.body.alert && result.body.alert.id) {
        alertEmail.queueResolveAlertEmail(result.body.alert.id);
      }
    } else {
      return res.status(400).json({ ok: false, error: 'validation', message: 'Unknown action.' });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    return res.json(result.body);
  } catch (err) {
    console.error('[winding action]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not process action.' });
  }
});

app.get('/api/manager/machines', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const machines = await phase1.buildDashboardCards();
    return res.json({ ok: true, machines });
  } catch (err) {
    console.error('[manager machines]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load machines.' });
  }
});

app.get('/api/manager/alerts', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows =
      status === 'open' ? await phase1.fetchAllOpenAlerts() : await phase1.fetchAlertHistory({ status, limit: req.query.limit });
    return res.json({ ok: true, alerts: rows });
  } catch (err) {
    console.error('[manager alerts]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load alerts.' });
  }
});

app.patch('/api/manager/alerts/:id/resolve', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const result = await phase1.resolveAlertById(req.params.id, auth.username || auth.name || 'manager', {
      resolution_note: req.body && (req.body.resolution_note || req.body.notes) ? req.body.resolution_note || req.body.notes : null,
    });
    if (!result.ok) return res.status(result.status).json(result.body);
    alertEmail.queueResolveAlertEmail(req.params.id);
    return res.json(result.body);
  } catch (err) {
    console.error('[manager alert resolve]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not resolve alert.' });
  }
});

app.get('/api/manager/alert-email-recipients', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const recipients = await alertEmail.listRecipients();
    return res.json({ ok: true, recipients, smtp_configured: Boolean(alertEmail.smtpConfig()) });
  } catch (err) {
    console.error('[alert email recipients list]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load alert email settings.' });
  }
});

app.post('/api/manager/alert-email-recipients', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const result = await alertEmail.addRecipient(req.body && req.body.alert_type, req.body && req.body.email);
    if (!result.ok) return res.status(result.status).json({ ok: false, message: result.message });
    return res.json({ ok: true, recipient: result.recipient });
  } catch (err) {
    console.error('[alert email recipient add]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not add recipient.' });
  }
});

app.delete('/api/manager/alert-email-recipients/:id', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const result = await alertEmail.removeRecipient(req.params.id);
    if (!result.ok) return res.status(result.status).json({ ok: false, message: result.message });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[alert email recipient remove]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not remove recipient.' });
  }
});

app.post('/api/manager/alert-email-recipients/test', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const result = await alertEmail.sendTestEmail(req.body && req.body.alert_type, req.body && req.body.email);
    if (!result.ok) return res.status(result.status || 500).json({ ok: false, message: result.message });
    return res.json({ ok: true, message: result.message });
  } catch (err) {
    console.error('[alert email test]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not send test email.' });
  }
});

app.get('/api/manager/production-history', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const rows = await phase1.fetchProductionHistory({
      date: req.query.date ? String(req.query.date) : undefined,
      machine_id: req.query.machine_id ? Number(req.query.machine_id) : undefined,
      team_id: req.query.team_id ? Number(req.query.team_id) : undefined,
      tank_number: req.query.tank ? String(req.query.tank) : undefined,
      limit: req.query.limit,
    });
    return res.json({ ok: true, rows });
  } catch (err) {
    console.error('[manager production-history]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load production history.' });
  }
});

app.get('/api/manager/tank-activity', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  const tank = req.query.tank ? String(req.query.tank) : '';
  if (!tank) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Tank number is required.' });
  }
  try {
    const activity = await phase1.fetchTankActivity(tank);
    return res.json({ ok: true, ...activity });
  } catch (err) {
    console.error('[manager tank-activity]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load tank activity.' });
  }
});

app.get('/api/manager/sessions/:id/details', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id', message: 'Invalid session id.' });
  }
  try {
    const details = await phase1.fetchSessionDetails(id);
    if (!details) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Session not found.' });
    }
    let edits = [];
    try {
      edits = await phase1.listSessionEdits(id);
    } catch (_err) {
      edits = [];
    }
    return res.json({
      ok: true,
      session: {
        ...details,
        edits,
        is_edited: edits.length > 0,
      },
    });
  } catch (err) {
    console.error('[manager session details]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load session details.' });
  }
});

/** Manager-only: tank → piece → phase → session editor payload. */
app.get('/api/manager/tanks/:id/phase-editor', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id', message: 'Invalid tank id.' });
  }
  try {
    const result = await phase1.fetchPhaseEditorPayload(id, {
      pieceNumber: req.query.piece != null ? Number(req.query.piece) : null,
      pieceId: req.query.piece_id != null ? Number(req.query.piece_id) : null,
      phaseCode: req.query.phase || null,
    });
    if (!result.ok) return res.status(result.status || 400).json(result.body || result);
    return res.json(result.body);
  } catch (err) {
    console.error('[manager phase-editor]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load phase editor.' });
  }
});

/** Manager-only: edit phase session start/end times (not available on kiosk). */
app.patch('/api/manager/sessions/:id/times', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id', message: 'Invalid session id.' });
  }
  const body = req.body || {};
  try {
    const result = await phase1.editMachineSessionTimes(
      id,
      {
        started_at: body.started_at,
        ended_at: body.ended_at,
        duration_ms: body.duration_ms,
        edit_reason: body.edit_reason,
      },
      {
        user_id: auth.id || auth.user_id || null,
        name: auth.name || auth.username || 'Manager',
      }
    );
    if (!result.ok) return res.status(result.status || 400).json(result.body || result);
    const details = await phase1.fetchSessionDetails(id);
    return res.json({ ok: true, ...result.body, session: details });
  } catch (err) {
    console.error('[manager session times]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not edit session times.' });
  }
});

app.get('/api/manager/teams/dashboard', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const teams = await phase1.buildTeamDashboardCards();
    return res.json({ ok: true, teams });
  } catch (err) {
    console.error('[manager teams dashboard]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load team dashboard.' });
  }
});

app.delete('/api/manager/teams/:id', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid team id.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const activeSession = await client.query(
      `SELECT id FROM machine_sessions WHERE team_id = $1 AND status IN ('running', 'stopped') LIMIT 1`,
      [id]
    );
    if (activeSession.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: 'team_active',
        message: 'Finish the active production session before deactivating this team.',
      });
    }
    const updated = await client.query(
      `UPDATE teams SET active = 0, updated_at = $1::timestamptz WHERE id = $2 RETURNING id`,
      [nowIso(), id]
    );
    if (!updated.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Team not found.' });
    }
    await client.query(`UPDATE team_members SET active = 0 WHERE team_id = $1`, [id]);
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      /* ignore rollback errors */
    }
    console.error('[manager team deactivate]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not deactivate team.' });
  } finally {
    client.release();
  }
});

app.patch('/api/manager/teams/:id/restore', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid team id.' });
  }
  try {
    const updated = await pool.query(
      `UPDATE teams SET active = 1, updated_at = $1::timestamptz WHERE id = $2 RETURNING id`,
      [nowIso(), id]
    );
    if (!updated.rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Team not found.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[manager team restore]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not restore team.' });
  }
});

app.get('/api/manager/employees/search', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  const q = String(req.query.q || req.query.search || '').trim();
  try {
    let rows;
    if (q) {
      const safe = q.replace(/%/g, '').replace(/_/g, '');
      const pattern = `%${safe}%`;
      const r = await pool.query(
        `SELECT id, code, name FROM employees
         WHERE is_active = 1 AND (lower(code) LIKE lower($1) OR lower(name) LIKE lower($2))
         ORDER BY LOWER(name) ASC LIMIT 30`,
        [pattern, pattern]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT id, code, name FROM employees WHERE is_active = 1 ORDER BY LOWER(name) ASC LIMIT 50`
      );
      rows = r.rows;
    }
    return res.json({
      ok: true,
      employees: rows.map((e) => ({ id: Number(e.id), code: e.code, name: e.name })),
    });
  } catch (err) {
    console.error('[manager employees search]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not search employees.' });
  }
});

app.get('/api/manager/teams/full', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const { rows: teams } = await pool.query(`SELECT id, name, barcode, active FROM teams ORDER BY name ASC`);
    const { rows: members } = await pool.query(
      `SELECT tm.id, tm.team_id, tm.name, tm.role, tm.active, tm.created_at, tm.employee_id,
              e.code AS employee_code, e.name AS employee_name
       FROM team_members tm
       LEFT JOIN employees e ON e.id = tm.employee_id
       ORDER BY tm.team_id, COALESCE(e.name, tm.name) ASC`
    );
    const byTeam = new Map();
    for (const t of teams) byTeam.set(Number(t.id), { ...t, members: [] });
    for (const m of members) {
      const tid = Number(m.team_id);
      if (byTeam.has(tid)) byTeam.get(tid).members.push(m);
    }
    return res.json({ ok: true, teams: [...byTeam.values()] });
  } catch (err) {
    console.error('[manager teams full]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load teams.' });
  }
});

app.get('/api/manager/teams', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  }
  try {
    const { rows } = await pool.query(`SELECT id, name, barcode, active FROM teams WHERE active = 1 ORDER BY name ASC`);
    return res.json({ ok: true, teams: rows });
  } catch (err) {
    console.error('[manager teams]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load teams.' });
  }
});

app.post('/api/manager/teams', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const name = String((req.body && req.body.name) || '').trim();
  const barcode = phase1.normalizeTeamBarcode((req.body && req.body.barcode) || '');
  if (!name || !barcode) return res.status(400).json({ ok: false, error: 'validation', message: 'Name and barcode required.' });
  try {
    const ts = nowIso();
    const { rows } = await pool.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at) VALUES ($1,$2,1,$3,$3) RETURNING *`,
      [name, barcode, ts]
    );
    return res.json({ ok: true, team: rows[0] });
  } catch (err) {
    if (String(err.message || '').includes('unique')) {
      return res.status(409).json({ ok: false, error: 'duplicate', message: 'Barcode already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not create team.' });
  }
});

app.put('/api/manager/teams/:id', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const id = Number(req.params.id);
  const name = String((req.body && req.body.name) || '').trim();
  const barcode = phase1.normalizeTeamBarcode((req.body && req.body.barcode) || '');
  if (!Number.isInteger(id) || id <= 0 || !name || !barcode) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid team data.' });
  }
  try {
    await pool.query(`UPDATE teams SET name = $1, barcode = $2, updated_at = $3::timestamptz WHERE id = $4`, [
      name,
      barcode,
      nowIso(),
      id,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not update team.' });
  }
});

app.post('/api/manager/teams/:id/members', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const teamId = Number(req.params.id);
  const body = req.body || {};
  const employeeId = body.employee_id != null ? Number(body.employee_id) : null;
  const role = body.role != null ? String(body.role).trim() : null;
  const move = !!body.move;
  if (!Number.isInteger(teamId) || teamId <= 0) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid team id.' });
  }
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Select an employee from the directory.' });
  }
  try {
    const teamCheck = await pool.query(`SELECT id, name FROM teams WHERE id = $1`, [teamId]);
    if (!teamCheck.rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Team not found.' });
    }
    const empRes = await pool.query(`SELECT id, code, name, is_active FROM employees WHERE id = $1`, [employeeId]);
    if (!empRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Employee not found.' });
    }
    const emp = empRes.rows[0];
    if (Number(emp.is_active) === 0) {
      return res.status(400).json({ ok: false, error: 'inactive_employee', message: 'That employee is inactive in the directory.' });
    }
    const dupSame = await pool.query(
      `SELECT id FROM team_members WHERE team_id = $1 AND employee_id = $2 AND active = 1`,
      [teamId, employeeId]
    );
    if (dupSame.rows.length) {
      return res.status(409).json({
        ok: false,
        error: 'duplicate',
        message: 'Employee already in this team.',
      });
    }
    const otherRes = await pool.query(
      `SELECT tm.id, tm.team_id, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.employee_id = $1 AND tm.active = 1 AND tm.team_id != $2
       LIMIT 1`,
      [employeeId, teamId]
    );
    if (otherRes.rows.length && !move) {
      const other = otherRes.rows[0];
      return res.status(409).json({
        ok: false,
        error: 'assigned_elsewhere',
        other_team_id: Number(other.team_id),
        other_team_name: other.team_name,
        message: `This employee is already assigned to ${other.team_name}. Move them to this team?`,
      });
    }

    const transfer = await phase1.transferEmployeeToTeam(employeeId, teamId, {
      source: 'manager',
      reason: move ? 'Manager moved employee between teams' : 'Manager added employee to team',
    });
    if (!transfer.ok) return res.status(transfer.status || 500).json(transfer.body || transfer);
    if (role) {
      await pool.query(
        `UPDATE team_members SET role = $1 WHERE team_id = $2 AND employee_id = $3 AND active = 1`,
        [role, teamId, employeeId]
      );
    }
    const memberRes = await pool.query(
      `SELECT * FROM team_members WHERE team_id = $1 AND employee_id = $2 AND active = 1 LIMIT 1`,
      [teamId, employeeId]
    );
    const memberRow = memberRes.rows[0];
    return res.json({
      ok: true,
      transferred: transfer.body,
      member: memberRow
        ? {
            ...memberRow,
            employee_id: Number(memberRow.employee_id),
            employee_code: emp.code,
            employee_name: emp.name,
          }
        : null,
    });
  } catch (err) {
    console.error('[manager team member add]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not add team member.' });
  }
});

app.delete('/api/manager/teams/:teamId/members/:memberId', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid member id.' });
  }
  await pool.query(`UPDATE team_members SET active = 0 WHERE id = $1`, [memberId]);
  try {
    const row = await pool.query(`SELECT employee_id FROM team_members WHERE id = $1`, [memberId]);
    if (row.rows[0] && row.rows[0].employee_id) {
      await pool.query(
        `UPDATE employee_team_memberships SET left_at = NOW()
         WHERE employee_id = $1 AND left_at IS NULL`,
        [Number(row.rows[0].employee_id)]
      );
    }
  } catch (_err) {
    /* membership table may be new */
  }
  return res.json({ ok: true });
});

app.get('/api/manager/teams/:teamId/members/:memberId/details', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated', message: 'Manager login required.' });
  const teamId = Number(req.params.teamId);
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(teamId) || teamId <= 0 || !Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid team or member id.' });
  }
  try {
    const memberRes = await pool.query(
      `SELECT tm.id, tm.team_id, tm.name, tm.role, tm.active, tm.employee_id,
              e.code AS employee_code, e.name AS employee_name, e.is_active AS employee_active, e.hourly_rate
       FROM team_members tm
       LEFT JOIN employees e ON e.id = tm.employee_id
       WHERE tm.id = $1 AND tm.team_id = $2`,
      [memberId, teamId]
    );
    if (!memberRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Team member not found.' });
    }
    const m = memberRes.rows[0];
    const employeeId = m.employee_id != null ? Number(m.employee_id) : null;
    const rate = Number.isFinite(Number(m.hourly_rate)) ? Number(m.hourly_rate) : 0;
    const activeShift = employeeId ? await phase1.getEmployeeActiveShiftTeam(employeeId) : null;
    const isActive =
      Boolean(activeShift) && (m.employee_active == null || Number(m.employee_active) !== 0);
    const onShift = Boolean(activeShift);

    let todayHours = 0;
    let weekHours = 0;
    let hasTimeData = false;

    if (employeeId) {
      const todayKey = localDateString();
      const teamTodayHours = await phase1.computeEmployeeTeamProductionHoursForDay(employeeId, todayKey);
      const teamWeekHours = await phase1.computeEmployeeTeamProductionWeekHours(employeeId);

      const scanToday = await computeDailyHours(employeeId, todayKey);
      const scanTodayHours =
        scanToday && Number.isFinite(Number(scanToday.totalHours)) ? Number(scanToday.totalHours) : 0;

      let scanWeekHours = 0;
      const week = weekBoundsLocal();
      if (week) {
        const cursor = new Date(week.startIso);
        const todayEnd = startEndOfLocalDay(todayKey);
        const weekEndMs = todayEnd ? new Date(todayEnd.endIso).getTime() : Date.now();
        while (cursor.getTime() <= weekEndMs) {
          const dayKey = localDateString(cursor);
          const daily = await computeDailyHours(employeeId, dayKey);
          const hrs = daily && Number.isFinite(Number(daily.totalHours)) ? Number(daily.totalHours) : 0;
          scanWeekHours += hrs;
          if (dayKey === todayKey) break;
          cursor.setDate(cursor.getDate() + 1);
        }
      }

      todayHours = roundHours2(teamTodayHours + scanTodayHours);
      weekHours = roundHours2(teamWeekHours + scanWeekHours);
      hasTimeData = todayHours > 0 || weekHours > 0;
    }

    return res.json({
      ok: true,
      member: {
        id: Number(m.id),
        team_id: Number(m.team_id),
        employee_id: employeeId,
        name: m.employee_name || m.name || '—',
        code: m.employee_code || null,
        role: m.role || null,
        active: isActive,
        on_shift: onShift,
        has_time_data: hasTimeData,
        hourly_rate: roundMoney2(rate),
        today_hours: roundHours2(todayHours),
        week_hours: weekHours,
        estimated_pay_today: roundMoney2(todayHours * rate),
        estimated_pay_week: roundMoney2(weekHours * rate),
      },
    });
  } catch (err) {
    console.error('[manager team member details]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load member details.' });
  }
});

app.get('/api/manager/machine-areas', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  try {
    const rows = await phase1.fetchManagedWindingMachines();
    return res.json({ ok: true, machines: rows.map(mapMachineForClient) });
  } catch (err) {
    console.error('[manager machine-areas]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load machines.' });
  }
});

app.post('/api/manager/machine-areas', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'validation', message: 'Machine name is required.' });
  let slug = slugFromMachineName(name);
  const ts = nowIso();
  try {
    const dup = await pool.query(`SELECT id FROM machines WHERE LOWER(TRIM(kiosk_slug)) = $1 LIMIT 1`, [slug]);
    if (dup.rows.length) slug = `${slug}-${Date.now()}`;
    const sortRes = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM machines`);
    const sortOrder = sortRes.rows[0] ? Number(sortRes.rows[0].next_sort) : 1;
    const internalCode = slug;
    const { rows } = await pool.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$6) RETURNING *`,
      [name, internalCode, null, slug, sortOrder, ts]
    );
    return res.json({ ok: true, machine: mapMachineForClient(rows[0]) });
  } catch (err) {
    console.error('[manager machine-areas create]', err);
    if (String(err.message || '').includes('unique')) {
      return res.status(409).json({ ok: false, error: 'duplicate', message: 'A machine with that name already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not create machine.' });
  }
});

app.put('/api/manager/machine-areas/:id', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const id = Number(req.params.id);
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!Number.isInteger(id) || id <= 0 || !name) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid machine data.' });
  }
  const sortOrder = body.sort_order != null ? Number(body.sort_order) : null;
  const active = body.active != null ? (body.active ? 1 : 0) : null;
  try {
    const { rows: existing } = await pool.query(`SELECT id FROM machines WHERE id = $1`, [id]);
    if (!existing.length) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Machine not found.' });
    }
    await pool.query(
      `UPDATE machines SET
         name = $1,
         sort_order = COALESCE($2, sort_order),
         active = COALESCE($3, active),
         updated_at = $4::timestamptz
       WHERE id = $5`,
      [name, sortOrder, active, nowIso(), id]
    );
    const { rows } = await pool.query(
      `SELECT id, name, code, barcode, kiosk_slug, sort_order, active FROM machines WHERE id = $1`,
      [id]
    );
    return res.json({ ok: true, machine: mapMachineForClient(rows[0]) });
  } catch (err) {
    console.error('[manager machine-areas update]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not update machine.' });
  }
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
  if (p === '/kiosk' || p === '/ipad-scan' || p === '/qa-qc') {
    return requireKiosk(req, res, next);
  }
  if (
    p === '/winding-kiosk' ||
    p === '/winding-kiosk.html' ||
    p === '/machine-kiosk.js' ||
    /^\/kiosk\/machine\/[^/]+$/.test(p)
  ) {
    return next();
  }
  if (p === '/teams' || p === '/teams.html' || p === '/teams.js' || p === '/machine-areas' || p === '/machine-areas.html' || p === '/machine-areas.js' || p === '/alert-email-settings' || p === '/alert-email-settings.html' || p === '/alert-email-settings.js') {
    return requireManager(req, res, next);
  }
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
  if (p.startsWith('/api/kiosk/winding/')) {
    return next();
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
    p.startsWith('/api/dashboard') ||
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
    const tankRow = await validateTankExists(resolvedTank);
    if (status === 'IN') {
      if (!tankRow) {
        return res.status(404).json(tankNotFoundBody());
      }
      const tankBlock = tankProductionBlockBody(tankRow);
      if (tankBlock) {
        if (tankBlock.error === 'tank_archived') {
          tankBlock.message = 'This tank is completed. Restore it in Tank Management before assigning work.';
        }
        return res.status(403).json(tankBlock);
      }
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
    if (tank) {
      const tankRow = await validateTankExists(tank);
      if (!tankRow) {
        return res.status(404).json(tankNotFoundBody());
      }
    }
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

app.get('/api/dashboard/team-activity', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  try {
    const { rows } = await pool.query(
      `WITH activity AS (
         SELECT ms.started_at AS event_time,
                t.name AS team_name,
                m.name AS machine_name,
                tk.tank_number,
                ms.activity_name AS phase_name,
                ms.status,
                'Started production' AS note,
                ms.id AS sort_id
         FROM machine_sessions ms
         JOIN teams t ON t.id = ms.team_id
         JOIN machines m ON m.id = ms.machine_id
         JOIN tanks tk ON tk.id = ms.tank_id
         UNION ALL
         SELECT ms.finished_at AS event_time,
                t.name AS team_name,
                m.name AS machine_name,
                tk.tank_number,
                ms.activity_name AS phase_name,
                'finished' AS status,
                'Part complete' AS note,
                ms.id AS sort_id
         FROM machine_sessions ms
         JOIN teams t ON t.id = ms.team_id
         JOIN machines m ON m.id = ms.machine_id
         JOIN tanks tk ON tk.id = ms.tank_id
         WHERE ms.finished_at IS NOT NULL
         UNION ALL
         SELECT ae.reported_at AS event_time,
                t.name AS team_name,
                m.name AS machine_name,
                tk.tank_number,
                COALESCE(ms.activity_name, '') AS phase_name,
                ae.status,
                CASE ae.alert_type WHEN 'qa_qc' THEN 'QA/QC Alert' ELSE 'Maintenance/Tooling Alert' END AS note,
                ae.id AS sort_id
         FROM alert_events ae
         LEFT JOIN machine_sessions ms ON ms.id = ae.session_id
         LEFT JOIN teams t ON t.id = ae.team_id
         LEFT JOIN machines m ON m.id = ae.machine_id
         LEFT JOIN tanks tk ON tk.id = ae.tank_id
         UNION ALL
         SELECT sl.scanned_at AS event_time,
                NULL AS team_name,
                COALESCE(sl.station_name, sl.area_name) AS machine_name,
                sl.tank_number,
                CASE WHEN sl.note_category = 'WORK' THEN sl.note_value ELSE NULL END AS phase_name,
                sl.status,
                COALESCE(sl.note, sl.note_value, sl.note_category, 'Manual scan') AS note,
                sl.id AS sort_id
         FROM scan_logs sl
       )
       SELECT event_time, team_name, machine_name, tank_number, phase_name, status, note
       FROM activity
       WHERE event_time IS NOT NULL
       ORDER BY event_time DESC, sort_id DESC
       LIMIT $1`,
      [limit]
    );
    return res.json({
      ok: true,
      logs: rows.map((r) => ({
        time: r.event_time,
        team: r.team_name || '—',
        machine: r.machine_name ? displayMachineName(r.machine_name) : '—',
        tank: r.tank_number || '—',
        phase: r.phase_name || '—',
        status: r.status || '—',
        note: r.note || '',
      })),
    });
  } catch (err) {
    console.error('[dashboard team activity]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load team scan activity.' });
  }
});

app.post('/api/dashboard/manual-scan', async (req, res) => {
  const raw = String(req.body && req.body.barcode != null ? req.body.barcode : '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'validation', message: 'Enter a barcode.' });
  try {
    const parsed = phase1.parseScan(raw);
    let label = 'Unknown barcode';
    let detail = parsed.value || raw;
    if (parsed.type === 'team') {
      const team = await phase1.getTeamByBarcode(parsed.value);
      label = team ? 'Team barcode' : 'Team barcode not found';
      detail = team ? team.name : parsed.value;
    } else if (parsed.type === 'tank') {
      label = 'Tank barcode';
      detail = parsed.value;
    } else if (parsed.type === 'phase') {
      const phase = phase1.resolvePhase(parsed.value);
      label = 'Phase barcode';
      detail = phase ? phase.label : parsed.value;
    } else if (parsed.type === 'alert') {
      const alert = phase1.resolveAlert(parsed.value);
      label = 'Alert barcode';
      detail = alert ? alert.label : parsed.value;
    }
    return res.json({ ok: true, type: parsed.type, label, detail });
  } catch (err) {
    console.error('[dashboard manual scan]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not read barcode.' });
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
  try {
    const day = localDateString();
    const summary = await buildTankDailySummary(day);
    if (!summary) return res.status(400).json({ ok: false, error: 'invalid_date' });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[summary/today]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load daily summary.' });
  }
});

app.get('/api/summary', async (req, res) => {
  try {
    const q = req.query.date ? String(req.query.date) : localDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q) || !parseLocalDate(q)) {
      return res.status(400).json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
    }
    const summary = await buildTankDailySummary(q);
    if (!summary) return res.status(400).json({ ok: false, error: 'invalid_date' });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[summary]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load daily summary.' });
  }
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
  if (statusFilter === 'trash') {
    try {
      await assertTankTrashSchemaReady();
    } catch (err) {
      console.error('[tanks trash list] schema:', err);
      return res.status(503).json({
        ok: false,
        error: 'schema_not_ready',
        message: 'Trash is not available because the database schema is not fully migrated. Restart the server to run migrations.',
      });
    }
  }
  let sql = `SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE 1=1`;
  const params = [];
  let n = 1;
  if (statusFilter === 'trash') {
    sql += ` AND ${tankInTrashClause()}`;
  } else {
    sql += ` AND ${tankNotDeletedClause()}`;
    if (statusFilter === 'active') {
      sql += ` AND LOWER(TRIM(COALESCE(status, ''))) IN ('active', 'paused', 'waiting', '')`;
    } else if (statusFilter === 'waiting') {
      sql += ` AND LOWER(TRIM(COALESCE(status, ''))) = 'waiting'`;
    } else if (statusFilter === 'archived') {
      sql += ` AND LOWER(TRIM(status)) = 'archived'`;
    } else if (statusFilter === 'all') {
      if (activeOnly) {
        sql += ` AND (LOWER(TRIM(COALESCE(status, ''))) IN ('active', 'waiting', 'paused') OR TRIM(COALESCE(status, '')) = '')`;
      }
    } else {
      return res.status(400).json({
        ok: false,
        error: 'validation',
        message: 'status filter must be active, waiting, completed, trash, or all.',
      });
    }
  }
  if (search) {
    sql += ` AND (tank_number ILIKE $${n} OR COALESCE(description, '') ILIKE $${n})`;
    params.push(`%${search}%`);
    n += 1;
  }
  if (statusFilter === 'trash') {
    sql += ` ORDER BY deleted_at DESC NULLS LAST, tank_number ASC`;
  } else {
    sql += ` ORDER BY CASE WHEN LOWER(TRIM(COALESCE(status, ''))) IN ('active', '') THEN 0 ELSE 1 END, updated_at DESC, tank_number ASC`;
  }
  const { rows } = await pool.query(sql, params);
  const trashCount = await getTrashTankCount();
  res.json({ ok: true, tanks: rows.map(mapTankRowForApi), trash_count: trashCount });
});

app.post('/api/tanks', async (req, res) => {
  const body = req.body || {};
  const tank_number = normalizeTankNumber(body.tank_number);
  const description = body.description != null ? String(body.description).trim().slice(0, 200) : '';
  const customer = body.customer != null ? String(body.customer).trim().slice(0, 120) : '';
  const model = body.model != null ? String(body.model).trim().slice(0, 120) : '';
  const priority = body.priority != null ? String(body.priority).trim().slice(0, 40) : '';
  const due_date = body.due_date ? String(body.due_date).slice(0, 10) : null;
  const notes = body.notes != null ? String(body.notes).trim().slice(0, 2000) : '';
  const piece_count = Math.min(4, Math.max(1, Number(body.piece_count) || 1));
  if (!tank_number) {
    return res.status(400).json({ ok: false, error: 'validation', message: 'tank_number is required.' });
  }
  const ts = nowIso();
  try {
    const ins = await pool.query(
      `INSERT INTO tanks
         (tank_number, description, status, created_at, updated_at, customer, model, priority, due_date, notes, piece_count, current_piece_number)
       VALUES ($1, $2, 'waiting', $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, 1)
       RETURNING id`,
      [tank_number, description, ts, ts, customer, model, priority, due_date, notes, piece_count]
    );
    const tid = ins.rows[0].id;
    for (let n = 1; n <= piece_count; n += 1) {
      await pool.query(
        `INSERT INTO tank_pieces (tank_id, piece_number, status, created_at, updated_at)
         VALUES ($1, $2, 'pending', NOW(), NOW()) ON CONFLICT DO NOTHING`,
        [tid, n]
      );
    }
    const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [tid]);
    return res.status(201).json({ ok: true, tank: mapTankRowForApi(tankRes.rows[0]) });
  } catch (e) {
    if (e && e.code === '23505') {
      const existing = await findTankNumberConflict(tank_number);
      if (existing && isTankDeleted(existing)) {
        return res.status(409).json({
          ok: false,
          error: 'tank_in_trash',
          message: `Tank ${tank_number} exists in Trash. Restore it or permanently delete it before reusing this tank number.`,
        });
      }
      return res.status(409).json({ ok: false, error: 'duplicate_tank', message: 'Tank number already exists.' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not create tank.' });
  }
});

app.put('/api/tanks/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const current = await pool.query(`SELECT * FROM tanks WHERE id = $1`, [id]);
  if (!current.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  if (isTankDeleted(current.rows[0])) {
    return res.status(409).json({ ok: false, error: 'tank_in_trash', message: 'This tank is in Trash. Restore it from Trash to edit.' });
  }
  const body = req.body || {};
  const tank_number = normalizeTankNumber(body.tank_number != null ? body.tank_number : current.rows[0].tank_number);
  const description =
    body.description != null ? String(body.description).trim().slice(0, 200) : current.rows[0].description || '';
  const customer = body.customer != null ? String(body.customer).trim().slice(0, 120) : current.rows[0].customer || '';
  const model = body.model != null ? String(body.model).trim().slice(0, 120) : current.rows[0].model || '';
  const priority = body.priority != null ? String(body.priority).trim().slice(0, 40) : current.rows[0].priority || '';
  const due_date =
    body.due_date !== undefined
      ? body.due_date
        ? String(body.due_date).slice(0, 10)
        : null
      : current.rows[0].due_date || null;
  const notes = body.notes != null ? String(body.notes).trim().slice(0, 2000) : current.rows[0].notes || '';
  let piece_count = Math.min(
    4,
    Math.max(1, Number(body.piece_count != null ? body.piece_count : current.rows[0].piece_count) || 1)
  );
  const prevPieceCount = Math.min(4, Math.max(1, Number(current.rows[0].piece_count) || 1));
  if (body.piece_count != null && piece_count !== prevPieceCount) {
    const hasActivity = await phase1.tankHasProductionActivity(id);
    if (hasActivity && piece_count < prevPieceCount) {
      const maxActive = await phase1.maxPieceNumberWithActivity(id);
      if (piece_count < maxActive) {
        return res.status(409).json({
          ok: false,
          error: 'piece_count_locked',
          message: `Cannot reduce pieces below ${maxActive} because production activity already exists on those pieces.`,
          min_piece_count: maxActive,
          has_production_activity: true,
        });
      }
    }
  }
  const status =
    body.status != null && String(body.status).trim() !== ''
      ? normalizeTankStatus(body.status)
      : normalizeTankStatus(current.rows[0].status);
  if (!tank_number) return res.status(400).json({ ok: false, error: 'validation', message: 'tank_number is required.' });
  const ts = nowIso();
  try {
    const becomingArchived = status === 'archived' && normalizeTankStatus(current.rows[0].status) !== 'archived';
    const becomingActive =
      (status === 'active' || status === 'waiting') && normalizeTankStatus(current.rows[0].status) === 'archived';
    const completedAt = becomingArchived ? ts : becomingActive ? null : current.rows[0].completed_at;
    await pool.query(
      `UPDATE tanks SET
         tank_number = $1, description = $2, status = $3, completed_at = $4, updated_at = $5::timestamptz,
         customer = $6, model = $7, priority = $8, due_date = $9, notes = $10, piece_count = $11
       WHERE id = $12`,
      [tank_number, description, status, completedAt, ts, customer, model, priority, due_date, notes, piece_count, id]
    );
    for (let n = 1; n <= piece_count; n += 1) {
      await pool.query(
        `INSERT INTO tank_pieces (tank_id, piece_number, status, created_at, updated_at)
         VALUES ($1, $2, 'pending', NOW(), NOW()) ON CONFLICT DO NOTHING`,
        [id, n]
      );
    }
    await phase1.ensureTankPieces(id, piece_count, { pruneExtras: piece_count < prevPieceCount });
  } catch (e) {
    if (e && e.code === '23505') {
      const existing = await findTankNumberConflict(tank_number);
      if (existing && isTankDeleted(existing) && Number(existing.id) !== id) {
        return res.status(409).json({
          ok: false,
          error: 'tank_in_trash',
          message: `Tank ${tank_number} exists in Trash. Restore it or permanently delete it before reusing this tank number.`,
        });
      }
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
  const rowRes = await pool.query(`SELECT id, deleted_at FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  if (isTankDeleted(rowRes.rows[0])) {
    return res.status(409).json({ ok: false, error: 'tank_in_trash', message: 'This tank is in Trash.' });
  }
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
  const rowRes = await pool.query(`SELECT id, deleted_at FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  if (isTankDeleted(rowRes.rows[0])) {
    return res.status(409).json({ ok: false, error: 'tank_in_trash', message: 'This tank is in Trash. Use Restore from the Trash view.' });
  }
  const ts = nowIso();
  await pool.query(
    `UPDATE tanks SET status = 'waiting', completed_at = NULL, updated_at = $1::timestamptz WHERE id = $2`,
    [ts, id]
  );
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  res.json({ ok: true, tank: mapTankRowForApi(tankRes.rows[0]) });
});

app.patch('/api/tanks/:id/trash', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  try {
    await assertTankTrashSchemaReady();
  } catch (err) {
    console.error('[tank trash] schema:', err);
    return res.status(503).json({
      ok: false,
      error: 'schema_not_ready',
      message: 'Trash is not available because the database schema is not fully migrated. Restart the server to run migrations.',
    });
  }
  const rowRes = await pool.query(`SELECT * FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const tank = rowRes.rows[0];
  if (isTankDeleted(tank)) {
    return res.status(409).json({ ok: false, error: 'already_in_trash', message: 'Tank is already in Trash.' });
  }
  const blockers = await getTankTrashBlockers(id);
  if (blockers.blocked) {
    return res.status(409).json({
      ok: false,
      error: 'tank_active_production',
      message: `Tank ${tank.tank_number} currently has active production activity.\n\nStop or resolve all active sessions before deleting this tank.`,
      reasons: blockers.reasons,
    });
  }
  const performedBy = managerAuditName(req);
  const reason = req.body && req.body.reason != null ? String(req.body.reason).trim().slice(0, 500) : null;
  const previousStatus = normalizeTankStatus(tank.status);
  const hasHistory = await tankHasProductionHistory(id);
  const ts = nowIso();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tanks SET
         deleted_at = $1::timestamptz,
         deleted_by = $2,
         deleted_reason = $3,
         previous_status = $4,
         restored_at = NULL,
         restored_by = NULL,
         paused_reason = NULL,
         wip_team_id = NULL,
         wip_phase_code = NULL,
         wip_phase_name = NULL,
         wip_machine_id = NULL,
         updated_at = $1::timestamptz
       WHERE id = $5`,
      [ts, performedBy, reason, previousStatus, id]
    );
    await client.query(
      `UPDATE machines SET active_tank_id = NULL, updated_at = NOW() WHERE active_tank_id = $1`,
      [id]
    );
    await writeTankAdminAudit(client, {
      action: 'move_to_trash',
      tankId: id,
      tankNumber: tank.tank_number,
      performedBy,
      reason,
      previousStatus,
      details: { tank_id: id, tank_number: tank.tank_number },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[tank trash]', err);
    return res.status(500).json({ ok: false, error: 'server', message: formatTankTrashServerError(err) });
  } finally {
    client.release();
  }
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  return res.json({
    ok: true,
    tank: mapTankRowForApi(tankRes.rows[0]),
    has_production_history: hasHistory,
  });
});

app.patch('/api/tanks/:id/trash-restore', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const rowRes = await pool.query(`SELECT * FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const tank = rowRes.rows[0];
  if (!isTankDeleted(tank)) {
    return res.status(409).json({ ok: false, error: 'not_in_trash', message: 'Tank is not in Trash.' });
  }
  const performedBy = managerAuditName(req);
  const restoreStatus = normalizeTankStatus(tank.previous_status || 'waiting');
  const ts = nowIso();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tanks SET
         status = $1,
         deleted_at = NULL,
         deleted_by = NULL,
         deleted_reason = NULL,
         previous_status = NULL,
         restored_at = $2::timestamptz,
         restored_by = $3,
         updated_at = $2::timestamptz
       WHERE id = $4`,
      [restoreStatus, ts, performedBy, id]
    );
    await writeTankAdminAudit(client, {
      action: 'restore_from_trash',
      tankId: id,
      tankNumber: tank.tank_number,
      performedBy,
      reason: null,
      previousStatus: restoreStatus,
      details: { tank_id: id, tank_number: tank.tank_number, restored_status: restoreStatus },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[tank trash-restore]', err);
    return res.status(500).json({ ok: false, error: 'server', message: 'Could not restore tank from Trash.' });
  } finally {
    client.release();
  }
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  return res.json({ ok: true, tank: mapTankRowForApi(tankRes.rows[0]) });
});

app.delete('/api/tanks/:id/permanent', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const rowRes = await pool.query(`SELECT id, tank_number, deleted_at FROM tanks WHERE id = $1`, [id]);
  if (!rowRes.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  const tank = rowRes.rows[0];
  const confirmNumber = normalizeTankNumber(req.body && req.body.confirm_tank_number);
  if (!confirmNumber || confirmNumber !== normalizeTankNumber(tank.tank_number)) {
    return res.status(400).json({
      ok: false,
      error: 'confirmation_required',
      message: `Type "${tank.tank_number}" to confirm permanent deletion.`,
    });
  }
  const performedBy = managerAuditName(req);
  const reason = req.body && req.body.reason != null ? String(req.body.reason).trim().slice(0, 500) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await permanentlyDeleteTank(client, id, { performedBy, reason });
    if (!result.ok) {
      await client.query('ROLLBACK');
      return res.status(result.error === 'not_in_trash' ? 409 : 404).json({
        ok: false,
        error: result.error,
        message: result.message || 'Permanent delete failed.',
      });
    }
    await client.query('COMMIT');
    return res.json({ ok: true, tank_number: result.tank_number, permanently_deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[tank permanent delete]', err);
    return res.status(500).json({ ok: false, error: 'server', message: 'Permanent delete failed and was rolled back.' });
  } finally {
    client.release();
  }
});

/**
 * Tank-focused daily production summary (not payroll).
 * One row per tank worked on the local calendar date.
 */
async function buildTankDailySummary(date) {
  const day = startEndOfLocalDay(date);
  if (!day) return null;
  const { rows } = await pool.query(
    `SELECT tk.id AS tank_id, tk.tank_number, tk.status, tk.first_scanned_at, tk.completed_at,
            tk.piece_count, tk.current_piece_number, tk.customer, tk.model, tk.paused_reason,
            open_ms.id AS open_session_id,
            open_ms.status AS open_session_status,
            open_ms.stop_reason AS open_stop_reason,
            open_ms.started_at AS open_started_at,
            open_ms.stopped_at AS open_stopped_at,
            open_ms.activity_name AS open_phase_name,
            open_ms.activity_code AS open_phase_code,
            open_ms.piece_number AS open_piece_number,
            open_ms.team_name AS open_team_name,
            open_ms.machine_name AS open_machine_name,
            last_ms.activity_name AS last_phase_name,
            last_ms.team_name AS last_team_name,
            last_ms.machine_name AS last_machine_name,
            last_ms.last_at AS last_activity_at,
            (SELECT COUNT(*)::int FROM tank_pieces tp WHERE tp.tank_id = tk.id AND tp.status = 'completed') AS completed_pieces,
            (SELECT COUNT(*)::int FROM tank_pieces tp WHERE tp.tank_id = tk.id) AS total_pieces
     FROM tanks tk
     LEFT JOIN LATERAL (
       SELECT ms.id, ms.status, ms.stop_reason, ms.started_at, ms.stopped_at,
              ms.activity_name, ms.activity_code, ms.piece_number,
              t.name AS team_name, m.name AS machine_name
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.tank_id = tk.id AND ms.status IN ('running', 'stopped')
       ORDER BY ms.started_at DESC, ms.id DESC
       LIMIT 1
     ) open_ms ON TRUE
     LEFT JOIN LATERAL (
       SELECT ms.activity_name, t.name AS team_name, m.name AS machine_name,
              COALESCE(ms.finished_at, ms.stopped_at, ms.updated_at, ms.started_at) AS last_at
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.tank_id = tk.id
       ORDER BY COALESCE(ms.finished_at, ms.stopped_at, ms.updated_at, ms.started_at) DESC NULLS LAST, ms.id DESC
       LIMIT 1
     ) last_ms ON TRUE
     WHERE tk.deleted_at IS NULL
       AND (
       EXISTS (
       SELECT 1 FROM machine_sessions ms
       WHERE ms.tank_id = tk.id
         AND ms.started_at >= $1::timestamptz AND ms.started_at <= $2::timestamptz
     )
     OR (tk.completed_at IS NOT NULL AND tk.completed_at >= $1::timestamptz AND tk.completed_at <= $2::timestamptz)
     )
     ORDER BY tk.tank_number ASC`,
    [day.startIso, day.endIso]
  );

  const tanks = [];
  for (const r of rows) {
    const tankId = Number(r.tank_id);
    const pieceCount = Math.min(4, Math.max(1, Number(r.piece_count) || Number(r.total_pieces) || 1));
    const completedPieces = Number(r.completed_pieces) || 0;
    const currentPiece =
      r.open_piece_number != null
        ? Number(r.open_piece_number)
        : Math.min(pieceCount, Math.max(1, Number(r.current_piece_number) || 1));
    const tankStatus = normalizeTankStatus(r.status);

    let production_status = 'Waiting';
    if (tankStatus === 'archived') {
      production_status = 'Completed';
    } else if (completedPieces >= pieceCount && pieceCount > 0) {
      production_status = 'Ready to Complete';
    } else if (r.open_session_id) {
      const openSt = String(r.open_session_status || '').toLowerCase();
      if (openSt === 'running') production_status = 'Running';
      else {
        const reason = String(r.open_stop_reason || '')
          .trim()
          .toLowerCase()
          .replace(/-/g, '_');
        if (reason === 'break') production_status = 'Break';
        else if (reason === 'lunch') production_status = 'Lunch';
        else if (reason === 'downtime') production_status = 'Downtime';
        else if (reason === 'end_shift') production_status = 'End Shift';
        else production_status = 'Paused';
      }
    } else if (tankStatus === 'paused') {
      const pr = String(r.paused_reason || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
      production_status = pr === 'end_shift' ? 'End Shift' : 'Paused';
    } else if (tankStatus === 'waiting') {
      production_status = 'Waiting';
    } else {
      production_status = 'Active';
    }

    const duration_ms = computeTankDurationMs({
      status: tankStatus,
      first_scanned_at: r.first_scanned_at,
      completed_at: r.completed_at,
    });

    let current_phase_time_ms = 0;
    if (r.open_session_id) {
      current_phase_time_ms = phase1.sessionElapsedMs({
        status: r.open_session_status,
        started_at: r.open_started_at,
        stopped_at: r.open_stopped_at,
        finished_at: null,
      });
    }

    let tank_total_running_time_ms = 0;
    let tank_total_running_time_display = '—';
    try {
      const phaseSummary = await phase1.fetchTankPhaseTimeSummary(tankId);
      tank_total_running_time_ms = phaseSummary.reduce((sum, row) => {
        if (row.counts_toward_tank_total === false) return sum;
        return sum + (Number(row.total_duration_ms) || 0);
      }, 0);
      tank_total_running_time_display =
        tank_total_running_time_ms > 0
          ? formatTankDurationDisplay(tank_total_running_time_ms)
          : '—';
    } catch (_err) {
      /* ignore */
    }

    let downtime_ms = 0;
    try {
      const { rows: dtRows } = await pool.query(
        `SELECT started_at, ended_at, duration_ms
         FROM downtime_intervals
         WHERE tank_id = $1
           AND started_at >= $2::timestamptz
           AND started_at <= $3::timestamptz`,
        [tankId, day.startIso, day.endIso]
      );
      for (const d of dtRows) {
        if (d.duration_ms != null) {
          downtime_ms += Number(d.duration_ms) || 0;
        } else {
          const startMs = new Date(d.started_at).getTime();
          const endMs = d.ended_at ? new Date(d.ended_at).getTime() : Date.now();
          if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) downtime_ms += Math.max(0, endMs - startMs);
        }
      }
    } catch (_err) {
      /* table may not exist yet */
    }

    const current_phase = r.open_phase_name || r.last_phase_name || '—';
    const team_name = r.open_team_name || r.last_team_name || '—';
    const machine_name = r.open_machine_name || r.last_machine_name || '—';

    tanks.push({
      tank_id: tankId,
      tank_number: r.tank_number,
      piece: currentPiece,
      piece_label: `Piece ${currentPiece}`,
      piece_count: pieceCount,
      current_piece_number: currentPiece,
      team_name,
      machine_name,
      current_phase,
      production_status,
      status: tankStatus,
      started_at: tankTimestampToIso(r.first_scanned_at),
      current_phase_time_ms,
      current_phase_time_display: phase1.formatElapsedDisplay(current_phase_time_ms),
      duration_ms,
      duration_display: formatTankDurationDisplay(duration_ms),
      tank_total_running_time_ms,
      tank_total_running_time_display,
      downtime_ms,
      downtime_display: phase1.formatElapsedDisplay(downtime_ms),
      percent_complete: Math.round((completedPieces / pieceCount) * 100),
      completed_pieces: completedPieces,
      remaining_pieces: Math.max(0, pieceCount - completedPieces),
      completed: tankStatus === 'archived',
      last_activity_at: tankTimestampToIso(r.last_activity_at),
      customer: r.customer || '',
      model: r.model || '',
    });
  }

  return { date, tanks };
}

app.get('/api/manager/daily-summary', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  try {
    const date = req.query.date ? String(req.query.date) : localDateString();
    const summary = await buildTankDailySummary(date);
    if (!summary) return res.status(400).json({ ok: false, error: 'validation', message: 'Invalid date.' });
    return res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[daily-summary]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load daily summary.' });
  }
});

/** CSV export of tank daily summary (production, not payroll). */
app.get('/api/summary/tanks.csv', async (req, res) => {
  try {
    const date = req.query.date ? String(req.query.date) : localDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseLocalDate(date)) {
      return res.status(400).json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
    }
    const summary = await buildTankDailySummary(date);
    if (!summary) return res.status(400).json({ ok: false, error: 'invalid_date' });
    const header = [
      'Tank #',
      'Team',
      'Machine',
      'Current Phase',
      'Status',
      'Current Phase Time',
      'Total Running Time',
      'Progress %',
      'Last Activity',
    ];
    const lines = [header.join(',')];
    for (const r of summary.tanks) {
      const cells = [
        r.tank_number,
        r.team_name,
        r.machine_name,
        r.current_phase,
        r.production_status,
        r.current_phase_time_display || '',
        r.tank_total_running_time_display || '',
        r.percent_complete,
        r.last_activity_at || '',
      ].map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`);
      lines.push(cells.join(','));
    }
    const body = `${lines.join('\r\n')}\r\n`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tank-daily-summary-${date}.csv"`);
    return res.send(body);
  } catch (err) {
    console.error('[summary tanks csv]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not export daily summary.' });
  }
});

/** Dedicated PDF layout for tank daily summary (not HTML print). */
app.get('/api/summary/tanks.pdf', async (req, res) => {
  try {
    const date = req.query.date ? String(req.query.date) : localDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseLocalDate(date)) {
      return res.status(400).json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
    }
    const summary = await buildTankDailySummary(date);
    if (!summary) return res.status(400).json({ ok: false, error: 'invalid_date' });
    const buffer = await buildTankDailySummaryPdfBuffer(summary);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tank-daily-summary-${date}.pdf"`);
    return res.send(buffer);
  } catch (err) {
    console.error('[summary tanks pdf]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not export daily summary PDF.' });
  }
});

app.get('/api/manager/production-notes', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await pool.query(
      `SELECT pn.*, m.name AS machine_name
       FROM production_notes pn
       LEFT JOIN machines m ON m.id = pn.machine_id
       ORDER BY pn.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.json({
      ok: true,
      notes: rows.map((r) => ({
        id: Number(r.id),
        note_type: r.note_type,
        body: r.body,
        tank_number: r.tank_number,
        piece_number: r.piece_number,
        machine_name: r.machine_name,
        team_name: r.team_name,
        operator_name: r.operator_name,
        phase_name: r.phase_name,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[production-notes]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load notes.' });
  }
});

app.post('/api/manager/production-notes', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const body = req.body || {};
  const noteBody = String(body.body || '').trim().slice(0, 2000);
  if (!noteBody) return res.status(400).json({ ok: false, error: 'validation', message: 'Note body is required.' });
  const noteType = ['general', 'problem', 'maintenance', 'quality', 'safety', 'correction'].includes(
    String(body.note_type || '').toLowerCase()
  )
    ? String(body.note_type).toLowerCase()
    : 'general';
  try {
    const { rows } = await pool.query(
      `INSERT INTO production_notes (note_type, body, tank_number, piece_number, operator_name, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id, created_at`,
      [noteType, noteBody, body.tank_number || null, body.piece_number || null, auth.username || null]
    );
    return res.status(201).json({ ok: true, note: rows[0] });
  } catch (err) {
    console.error('[production-notes create]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not save note.' });
  }
});

app.post('/api/kiosk/winding/notes', async (req, res) => {
  try {
    const machine = await windingMachineFromRequest(req);
    if (!machine) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const body = req.body || {};
    const noteBody = String(body.body || '').trim().slice(0, 2000);
    if (!noteBody) return res.status(400).json({ ok: false, error: 'validation', message: 'Note is required.' });
    const noteType = ['general', 'problem', 'maintenance', 'quality', 'safety', 'correction'].includes(
      String(body.note_type || '').toLowerCase()
    )
      ? String(body.note_type).toLowerCase()
      : 'general';
    const session = await phase1.getOpenSession(machine.id);
    const { rows } = await pool.query(
      `INSERT INTO production_notes
         (note_type, body, tank_id, tank_number, piece_number, machine_id, team_id, team_name, session_id, phase_code, phase_name, operator_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING id`,
      [
        noteType,
        noteBody,
        session ? session.tank_id : null,
        session ? session.tank_number : body.tank_number || null,
        session ? session.piece_number || 1 : body.piece_number || null,
        machine.id,
        session ? session.team_id : null,
        session ? session.team_name : null,
        session ? session.id : null,
        session ? session.activity_code : null,
        session ? session.activity_name : null,
        body.operator_name || null,
      ]
    );
    return res.status(201).json({ ok: true, id: Number(rows[0].id) });
  } catch (err) {
    console.error('[kiosk notes]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not save note.' });
  }
});

app.get('/api/manager/tanks/print-selected', async (req, res) => {
  const auth = currentManagerFromSession(req);
  if (!auth) return res.status(401).type('html').send('Login required');
  const ids = String(req.query.ids || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const printAll = String(req.query.all || '') === '1';
  try {
    let rows;
    if (printAll) {
      const r = await pool.query(
        `SELECT tank_number FROM tanks WHERE deleted_at IS NULL AND LOWER(TRIM(COALESCE(status,''))) <> 'archived' ORDER BY tank_number ASC LIMIT 200`
      );
      rows = r.rows;
    } else if (ids.length) {
      const r = await pool.query(`SELECT tank_number FROM tanks WHERE id = ANY($1::bigint[]) ORDER BY tank_number ASC`, [
        ids,
      ]);
      rows = r.rows;
    } else {
      return res.status(400).type('html').send('No tanks selected.');
    }
    if (!rows.length) return res.status(404).type('html').send('No tanks found.');
    let bcIndex = 0;
    const scripts = [];
    const cards = rows
      .map((t) => {
        const tank = String(t.tank_number).replace(/</g, '&lt;');
        const barcode = `TANK_${t.tank_number}`;
        const esc = barcode.replace(/'/g, "\\'");
        const id = `bc${bcIndex++}`;
        scripts.push(`JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:90,margin:6,width:2});`);
        return `<div class="card"><p class="title">Tank ${tank}</p><svg id="${id}"></svg><p class="value">${barcode.replace(/</g, '&lt;')}</p></div>`;
      })
      .join('');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/><title>Tank Barcodes</title>
<style>body{font-family:Arial,sans-serif;margin:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{border:1.5px solid #cbd5e1;border-radius:10px;padding:12px;text-align:center;break-inside:avoid}.title{font-size:18px;font-weight:800;margin:0 0 8px}.value{font-family:monospace;font-size:12px;margin-top:6px}@media print{body{margin:8px}}</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script></head><body>
<h1>Selected Tank Barcodes</h1><div class="grid">${cards}</div>
<script>${scripts.join('')}setTimeout(()=>window.print(),400);</script></body></html>`);
  } catch (err) {
    console.error('[print-selected]', err);
    res.status(500).type('html').send('Could not print barcodes.');
  }
});

async function getTankReportPayload(id) {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'invalid_id' };
  const tankRes = await pool.query(`SELECT ${TANK_SELECT_COLUMNS} FROM tanks WHERE id = $1`, [id]);
  if (!tankRes.rows.length) return { ok: false, status: 404, error: 'not_found', message: 'Tank not found.' };
  const tank = mapTankRowForApi(tankRes.rows[0]);
  const logsAsc = await fetchTankLaborLogs(tank.tank_number);
  const emRes = await pool.query(`SELECT id, code, name, hourly_rate FROM employees`);
  const employeesByCode = new Map();
  for (const e of emRes.rows) employeesByCode.set(normalizeCode(e.code), e);
  const report = computeTankLaborReport(tank.tank_number, logsAsc, employeesByCode, Date.now());
  const finishedJobs = await fetchFinishJobEvents({ tankNumber: tank.tank_number, limit: 50 });
  let teamCompletion = phase1.emptyTankTeamCompletion();
  let teamProduction = null;
  try {
    teamCompletion = await phase1.fetchTankTeamCompletion(id);
  } catch (err) {
    console.error('[tank report] team_completion:', err);
    teamCompletion = phase1.emptyTankTeamCompletion();
  }
  try {
    teamProduction = await phase1.fetchTankProductionLabor(id);
  } catch (err) {
    console.error('[tank report] team_production:', err);
    teamProduction = null;
  }
  let phaseTimeSummary = [];
  try {
    phaseTimeSummary = await phase1.fetchTankPhaseTimeSummary(id);
  } catch (err) {
    console.error('[tank report] phase_time_summary:', err);
  }
  if (teamProduction && (!teamProduction.phase_time_summary || !teamProduction.phase_time_summary.length)) {
    teamProduction.phase_time_summary = phaseTimeSummary;
  }
  let pieces = [];
  let correctionNotes = [];
  let downtimeIntervals = [];
  let downtimeTotalMs = 0;
  let pieceReports = [];
  let qaQcHistory = [];
  try {
    pieces = await phase1.getTankPieces(id);
  } catch (err) {
    console.error('[tank report] pieces:', err);
  }
  try {
    pieceReports = await phase1.fetchPieceReports(id);
  } catch (err) {
    console.error('[tank report] piece_reports:', err);
  }
  try {
    qaQcHistory = await phase1.fetchTankQaQcHistory(id);
  } catch (err) {
    console.error('[tank report] qa_qc_history:', err);
  }
  try {
    const noteRes = await pool.query(
      `SELECT id, note_type, body, tank_number, piece_number, team_name, operator_name, phase_name, machine_id, created_at
       FROM production_notes
       WHERE tank_id = $1 OR (tank_number IS NOT NULL AND UPPER(TRIM(tank_number)) = UPPER(TRIM($2)))
       ORDER BY created_at DESC LIMIT 200`,
      [id, tank.tank_number]
    );
    correctionNotes = noteRes.rows;
  } catch (err) {
    console.error('[tank report] notes:', err);
  }
  try {
    const activity = await phase1.fetchTankActivity(tank.tank_number);
    downtimeIntervals = activity.downtime_intervals || [];
    downtimeTotalMs = Number(activity.downtime_total_ms) || 0;
  } catch (err) {
    console.error('[tank report] downtime:', err);
  }
  const totalLaborHours =
    teamProduction && teamProduction.total_hours != null
      ? teamProduction.total_hours
      : teamCompletion.total_team_hours || 0;
  const totalMachineHours =
    teamProduction && teamProduction.total_machine_hours != null
      ? teamProduction.total_machine_hours
      : totalLaborHours;

  let reportMeta = {
    team_name: teamCompletion.team_name || null,
    machine_name: null,
    current_phase: null,
    production_status: normalizeTankStatus(tank.status) === 'archived' ? 'Completed' : tank.status,
    percent_complete: null,
    piece_label: `Piece ${tank.current_piece_number || 1}`,
    started_at: tank.first_scanned_at || tank.started_at || null,
    downtime_display: phase1.formatElapsedDisplay(downtimeTotalMs),
  };
  try {
    const { rows: openRows } = await pool.query(
      `SELECT ms.status, ms.stop_reason, ms.activity_name, ms.piece_number,
              t.name AS team_name, m.name AS machine_name
       FROM machine_sessions ms
       JOIN teams t ON t.id = ms.team_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE ms.tank_id = $1 AND ms.status IN ('running', 'stopped')
       ORDER BY ms.started_at DESC LIMIT 1`,
      [id]
    );
    if (openRows[0]) {
      const o = openRows[0];
      reportMeta.team_name = o.team_name;
      reportMeta.machine_name = o.machine_name;
      reportMeta.current_phase = o.activity_name;
      reportMeta.piece_label = `Piece ${o.piece_number || tank.current_piece_number || 1}`;
      const st = String(o.status || '').toLowerCase();
      if (st === 'running') reportMeta.production_status = 'Running';
      else {
        const reason = String(o.stop_reason || '').toLowerCase();
        if (reason === 'break') reportMeta.production_status = 'Break';
        else if (reason === 'lunch') reportMeta.production_status = 'Lunch';
        else if (reason === 'downtime') reportMeta.production_status = 'Downtime';
        else if (reason === 'qa_qc') reportMeta.production_status = 'QA/QC';
        else reportMeta.production_status = 'Paused';
      }
    } else if (teamProduction && (teamProduction.phases || []).length) {
      const lastPhase = teamProduction.phases[teamProduction.phases.length - 1];
      reportMeta.current_phase = lastPhase.phase_name || reportMeta.current_phase;
      if ((lastPhase.sessions || []).length) {
        const s0 = lastPhase.sessions[lastPhase.sessions.length - 1];
        reportMeta.team_name = s0.team_name || reportMeta.team_name;
        reportMeta.machine_name = s0.machine_name || reportMeta.machine_name;
      }
    }
    const pieceCount = Math.min(4, Math.max(1, Number(tank.piece_count) || pieces.length || 1));
    const completedPieces = pieces.filter((p) => String(p.status) === 'completed' && Number(p.piece_number) <= pieceCount).length;
    reportMeta.percent_complete = Math.round((completedPieces / pieceCount) * 100);
    reportMeta.piece_count = pieceCount;
    reportMeta.completed_pieces = completedPieces;
    if (normalizeTankStatus(tank.status) !== 'archived' && completedPieces >= pieceCount && pieceCount > 0) {
      reportMeta.production_status = 'Ready to Complete';
    }
  } catch (err) {
    console.error('[tank report] report_meta:', err.message);
  }

  return {
    ok: true,
    tank: {
      id: tank.id,
      tank_number: tank.tank_number,
      description: tank.description,
      customer: tank.customer,
      model: tank.model,
      priority: tank.priority,
      due_date: tank.due_date,
      notes: tank.notes,
      piece_count: tank.piece_count,
      current_piece_number: tank.current_piece_number,
      status: tank.status,
      registry_status: tankRes.rows[0].status,
      created_at: tank.created_at,
      first_scanned_at: tank.first_scanned_at,
      started_at: tank.started_at,
      completed_at: tank.completed_at,
      duration_ms: tank.duration_ms,
      duration_display: tank.duration_display,
    },
    report_meta: reportMeta,
    summary: report.summary,
    employeeBreakdown: report.employeeBreakdown,
    activityBreakdown: report.activityBreakdown,
    sessions: report.sessions,
    finished_jobs: finishedJobs,
    team_completion: teamCompletion,
    team_production: teamProduction,
    phase_time_summary: phaseTimeSummary,
    pieces,
    piece_reports: pieceReports,
    has_production_activity: await phase1.tankHasProductionActivity(id),
    max_piece_with_activity: await phase1.maxPieceNumberWithActivity(id),
    production_notes: correctionNotes,
    downtime_intervals: downtimeIntervals,
    downtime_total_ms: downtimeTotalMs,
    downtime_total_display: phase1.formatElapsedDisplay(downtimeTotalMs),
    qa_qc_history: qaQcHistory,
    labor_hours: {
      total_labor_hours: totalLaborHours,
      total_machine_hours: totalMachineHours,
      hours_per_phase: (teamProduction && teamProduction.hours_per_phase) || [],
      hours_per_team: (teamProduction && teamProduction.hours_per_team) || [],
      hours_per_piece: (teamProduction && teamProduction.hours_per_piece) || [],
    },
  };
}

app.get('/api/tanks/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const payload = await getTankReportPayload(id);
    if (!payload.ok) return res.status(payload.status || 500).json(payload);
    return res.json(payload);
  } catch (err) {
    console.error('[tank report]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not load tank report.' });
  }
});

app.get('/api/tanks/:id/report.pdf', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const assembled = await getTankReportPayload(id);
    if (!assembled.ok) return res.status(assembled.status || 500).json(assembled);
    const buffer = await buildTankReportPdfBuffer(assembled);
    const safeTank = String((assembled.tank && assembled.tank.tank_number) || id).replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tank-report-${safeTank}.pdf"`);
    return res.send(buffer);
  } catch (err) {
    console.error('[tank report pdf]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Could not export tank report PDF.' });
  }
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
      message: 'Provide at least one PIN (wm_1_pin, wm_2_pin, or wm_3_pin).',
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
  if (auth && isWindingMachineKioskArea(auth.area_name)) {
    return res.redirect(302, kioskMachinePathForArea(auth.area_name));
  }
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
});

app.get('/winding-kiosk', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'winding-kiosk-redirect.html'));
});

app.get('/winding-kiosk.js', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'machine-kiosk.js'));
});

app.get('/kiosk/machine/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '')
      .trim()
      .toLowerCase();
    const machine = await phase1.getMachineBySlug(slug);
    if (!machine || !Number(machine.active)) {
      return res.status(404).type('html').send('<p>Machine kiosk not found.</p>');
    }
    req.session.machine_kiosk = {
      machine_id: Number(machine.id),
      slug: String(machine.kiosk_slug || slug).toLowerCase(),
      machine_name: machine.name,
    };
    req.session.save((err) => {
      if (err) console.error('[machine kiosk session]', err);
      scanKioskCacheHeaders(res);
      res.type('html');
      res.sendFile(path.join(PUBLIC_DIR, 'machine-kiosk.html'));
    });
  } catch (err) {
    console.error('[kiosk/machine]', err);
    res.status(500).type('html').send('<p>Could not open machine kiosk.</p>');
  }
});

app.get('/teams', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'teams.html'));
});

app.get('/teams.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'teams.js'));
});

app.get('/machine-areas', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'machine-areas.html'));
});

app.get('/machine-areas.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'machine-areas.js'));
});

app.get('/alert-email-settings', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'alert-email-settings.html'));
});

app.get('/alert-email-settings.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'alert-email-settings.js'));
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

app.get('/machine-kiosk.js', (_req, res) => {
  scanKioskCacheHeaders(res);
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'machine-kiosk.js'));
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
  <p class="instr">Scan employee badge, tank, then activity. Each section lists activities for one production area. Laminate and keep at the machine kiosk.</p>
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

async function renderTeamBarcodesPrintPage() {
  const { rows } = await pool.query(`SELECT name, barcode FROM teams WHERE active = 1 ORDER BY name ASC`);
  let bcIndex = 0;
  const scripts = [];
  const cards = rows
    .map((t) => {
      const safeTitle = String(t.name).replace(/</g, '&lt;');
      const safeVal = String(t.barcode).replace(/</g, '&lt;');
      const esc = String(t.barcode).replace(/'/g, "\\'");
      const id = `bc${bcIndex++}`;
      scripts.push(`JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:110,margin:10,width:2.5});`);
      return `<div class="card"><p class="title">${safeTitle}</p><p class="sub">Team Badge</p><svg id="${id}"></svg><p class="value">${safeVal}</p></div>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Team Barcodes</title>
<style>body{font-family:Arial,sans-serif;margin:20px;color:#0f172a}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.card{border:2px solid #cbd5e1;border-radius:12px;padding:20px;text-align:center}.title{font-size:28px;font-weight:800;margin:0 0 6px}.sub{font-size:13px;color:#64748b;margin:0 0 12px;text-transform:uppercase}.value{font-family:monospace;font-size:18px;margin-top:10px;font-weight:700}svg{height:110px;width:100%}</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script></head><body>
<h1>Team Barcodes</h1><div class="grid">${cards || '<p>No teams.</p>'}</div>
<script>${scripts.join('')}window.setTimeout(()=>window.print(),400);</script></body></html>`;
}

function renderPhaseBarcodesPrintPage() {
  let bcIndex = 0;
  const scripts = [];
  const cards = WINDING_PHASES.map((a) => {
    const safeTitle = String(a.label).replace(/</g, '&lt;');
    const safeVal = String(a.barcode).replace(/</g, '&lt;');
    const esc = String(a.barcode).replace(/'/g, "\\'");
    const id = `bc${bcIndex++}`;
    scripts.push(`JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:110,margin:10,width:2.5});`);
    return `<div class="card"><p class="title">${safeTitle}</p><p class="sub">Production Phase</p><svg id="${id}"></svg><p class="value">${safeVal}</p></div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Phase Barcodes</title>
<style>body{font-family:Arial,sans-serif;margin:20px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.card{border:2px solid #cbd5e1;border-radius:12px;padding:20px;text-align:center}.title{font-size:22px;font-weight:800;margin:0 0 6px}.sub{font-size:12px;color:#64748b;text-transform:uppercase}.value{font-family:monospace;font-size:14px;margin-top:10px;font-weight:700;word-break:break-all}svg{height:110px;width:100%}</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script></head><body>
<h1>Winding Machine Phase Barcodes</h1><div class="grid">${cards}</div>
<script>${scripts.join('')}window.setTimeout(()=>window.print(),400);</script></body></html>`;
}

function renderAlertBarcodesPrintPage() {
  let bcIndex = 0;
  const scripts = [];
  const cards = ALERT_TYPES.map((a) => {
    const safeTitle = String(a.label).replace(/</g, '&lt;');
    const safeVal = String(a.barcode).replace(/</g, '&lt;');
    const esc = String(a.barcode).replace(/'/g, "\\'");
    const id = `bc${bcIndex++}`;
    scripts.push(`JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:110,margin:10,width:2.5});`);
    return `<div class="card"><p class="title">${safeTitle}</p><p class="sub">Alert Barcode</p><svg id="${id}"></svg><p class="value">${safeVal}</p></div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Alert Barcodes</title>
<style>body{font-family:Arial,sans-serif;margin:20px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.card{border:3px solid #cbd5e1;border-radius:12px;padding:20px;text-align:center}.title{font-size:24px;font-weight:800}.sub{font-size:12px;color:#64748b;text-transform:uppercase}.value{font-family:monospace;font-size:16px;margin-top:10px;font-weight:700}svg{height:110px;width:100%}</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script></head><body>
<h1>Alert Barcodes</h1><div class="grid">${cards}</div>
<script>${scripts.join('')}window.setTimeout(()=>window.print(),400);</script></body></html>`;
}

async function renderMachineBarcodesPrintPage() {
  const codes = CANONICAL_WINDING_MACHINE_CODES.map((c) => c.toUpperCase());
  const { rows } = await pool.query(
    `SELECT name, code, barcode FROM machines
     WHERE active = 1 AND UPPER(TRIM(code)) = ANY($1::text[])
     ORDER BY sort_order ASC, code ASC`,
    [codes]
  );
  let bcIndex = 0;
  const scripts = [];
  const cards = rows
    .map((m) => {
      const bc = m.barcode || m.code;
      const safeTitle = String(m.name).replace(/</g, '&lt;');
      const safeVal = String(bc).replace(/</g, '&lt;');
      const esc = String(bc).replace(/'/g, "\\'");
      const id = `bc${bcIndex++}`;
      scripts.push(`JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:110,margin:10,width:2.5});`);
      return `<div class="card"><p class="title">${safeTitle}</p><p class="sub">${String(m.code).replace(/</g, '&lt;')}</p><svg id="${id}"></svg><p class="value">${safeVal}</p></div>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Machine Barcodes</title>
<style>body{font-family:Arial,sans-serif;margin:20px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.card{border:2px solid #cbd5e1;border-radius:12px;padding:20px;text-align:center}.title{font-size:24px;font-weight:800}.sub{font-size:14px;color:#475569;font-weight:700}.value{font-family:monospace;font-size:18px;margin-top:10px;font-weight:700}svg{height:110px;width:100%}</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script></head><body>
<h1>Winding Machine Barcodes</h1><div class="grid">${cards || '<p>No machines.</p>'}</div>
<script>${scripts.join('')}window.setTimeout(()=>window.print(),400);</script></body></html>`;
}

async function renderTankBarcodesIndexPrintPage() {
  const { rows } = await pool.query(
    `SELECT tank_number FROM tanks WHERE deleted_at IS NULL AND LOWER(TRIM(COALESCE(status,''))) IN ('active','') ORDER BY tank_number ASC LIMIT 48`
  );
  if (!rows.length) {
    return `<!doctype html><html><body><p>No active tanks to print.</p></body></html>`;
  }
  let bcIndex = 0;
  const scripts = [];
  const cards = rows
    .map((t) => {
      const tank = String(t.tank_number).replace(/</g, '&lt;');
      const barcode = `TANK_${t.tank_number}`;
      const esc = barcode.replace(/'/g, "\\'");
      const id = `bc${bcIndex++}`;
      scripts.push(`JsBarcode('#${id}','${esc}',{format:'CODE128',displayValue:false,height:100,margin:8,width:2});`);
      return `<div class="card"><p class="title">Tank ${tank}</p><svg id="${id}"></svg><p class="value">${barcode.replace(/</g, '&lt;')}</p></div>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Tank Barcodes</title>
<style>body{font-family:Arial,sans-serif;margin:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{border:1.5px solid #cbd5e1;border-radius:10px;padding:12px;text-align:center;break-inside:avoid}.title{font-size:18px;font-weight:800;margin:0 0 8px}.value{font-family:monospace;font-size:13px;margin-top:6px}svg{height:90px;width:100%}</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script></head><body>
<h1 style="font-size:22px">Active Tank Barcodes</h1>
<div class="grid">${cards}</div>
<script>${scripts.join('')}window.setTimeout(()=>window.print(),500);</script></body></html>`;
}

app.get('/manager/command-print', (req, res) => {
  const type = String(req.query.type || '').toLowerCase();
  if (type === 'activities') {
    return res.type('html').send(renderActivitiesByAreaPrintPage());
  }
  if (type === 'teams') {
    return renderTeamBarcodesPrintPage()
      .then((html) => res.type('html').send(html))
      .catch((err) => {
        console.error('[print teams]', err);
        res.status(500).send('Could not generate team barcodes.');
      });
  }
  if (type === 'phases' || type === 'winding-activities' || type === 'machine-activities') {
    return res.type('html').send(renderPhaseBarcodesPrintPage());
  }
  if (type === 'alerts' || type === 'alert') {
    return res.type('html').send(renderAlertBarcodesPrintPage());
  }
  if (type === 'machines' || type === 'machine-barcodes') {
    return res.status(410).send('Machine barcode printing has been removed. Each kiosk uses its permanent machine URL instead.');
  }
  if (type === 'tanks') {
    return renderTankBarcodesIndexPrintPage()
      .then((html) => res.type('html').send(html))
      .catch((err) => {
        console.error('[print tanks]', err);
        res.status(500).send('Could not generate tank barcode print page.');
      });
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
