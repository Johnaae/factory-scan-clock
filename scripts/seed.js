'use strict';

const crypto = require('crypto');
const { withClient, closePool } = require('./db');
const { WINDING_MACHINES } = require('./phase1-production-logic');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return `pbkdf2_sha512$120000$${salt}$${hash}`;
}

function ts() {
  return new Date().toISOString();
}

const LEGACY_KIOSK_USERS = [
  {
    username: 'kiosk_area_b',
    password: process.env.DEFAULT_KIOSK_PASSWORD_B || 'kioskB123',
    role: 'KIOSK',
    station_name: 'Assembly Kiosk',
    area_name: 'Assembly',
    pin: '2222',
  },
  {
    username: 'kiosk_area_c',
    password: process.env.DEFAULT_KIOSK_PASSWORD_C || 'kioskC123',
    role: 'KIOSK',
    station_name: 'QA/QC Kiosk',
    area_name: 'QA/QC',
    pin: '3333',
  },
  {
    username: 'kiosk_area_d',
    password: process.env.DEFAULT_KIOSK_PASSWORD_D || 'kioskD123',
    role: 'KIOSK',
    station_name: 'Shipping & Handling Kiosk',
    area_name: 'Shipping & Handling',
    pin: '4444',
  },
];

const WINDING_KIOSK_USERS = [
  {
    username: 'kiosk_wm_1',
    password: process.env.DEFAULT_KIOSK_PASSWORD_A || 'kioskA123',
    role: 'KIOSK',
    station_name: 'Winding Machine 01 Kiosk',
    area_name: 'Winding Machine 01',
    pin: '1111',
  },
  {
    username: 'kiosk_wm_2',
    password: process.env.DEFAULT_KIOSK_PASSWORD_WM2 || '2222',
    role: 'KIOSK',
    station_name: 'Winding Machine 02 Kiosk',
    area_name: 'Winding Machine 02',
    pin: '2222',
  },
  {
    username: 'kiosk_wm_3',
    password: process.env.DEFAULT_KIOSK_PASSWORD_WM3 || '3333',
    role: 'KIOSK',
    station_name: 'Winding Machine 03 Kiosk',
    area_name: 'Winding Machine 03',
    pin: '3333',
  },
];

async function seedUsers(client) {
  const now = ts();
  const users = [
    {
      username: 'manager',
      password: process.env.DEFAULT_MANAGER_PASSWORD || 'manager123',
      role: 'MANAGER',
      station_name: 'Office Manager',
      area_name: 'Office',
      pin: null,
    },
    {
      username: 'owner',
      password: process.env.OWNER_PASSWORD || 'owner123',
      role: 'MANAGER',
      station_name: 'Backup Owner Account',
      area_name: 'Office',
      pin: null,
    },
    ...WINDING_KIOSK_USERS,
    ...LEGACY_KIOSK_USERS,
  ];

  for (const u of users) {
    await client.query(
      `INSERT INTO users (username, password_hash, pin_hash, role, station_name, area_name, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, hashPassword(u.password), u.pin ? hashPassword(u.pin) : null, u.role, u.station_name, u.area_name, now, now]
    );
  }

  for (const k of WINDING_KIOSK_USERS) {
    await client.query(
      `UPDATE users SET area_name = $1, station_name = $2, updated_at = $3
       WHERE username = $4 AND role = 'KIOSK'`,
      [k.area_name, k.station_name, now, k.username]
    );
  }

  await client.query(
    `UPDATE users wm
     SET pin_hash = la.pin_hash, updated_at = $1
     FROM users la
     WHERE wm.username = 'kiosk_wm_1'
       AND la.username = 'kiosk_area_a'
       AND la.pin_hash IS NOT NULL`,
    [now]
  );
}

async function seedTeams(client) {
  const now = ts();
  const teams = [{ name: 'Winder 1', barcode: 'TEAM-WINDER-1' }];
  for (const t of teams) {
    await client.query(
      `INSERT INTO teams (name, barcode, active, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (barcode) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
      [t.name, t.barcode, now, now]
    );
  }
}

async function seedMachines(client) {
  const now = ts();
  for (const m of WINDING_MACHINES) {
    await client.query(
      `INSERT INTO machines (name, code, barcode, kiosk_slug, sort_order, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         barcode = EXCLUDED.barcode,
         kiosk_slug = EXCLUDED.kiosk_slug,
         sort_order = EXCLUDED.sort_order,
         active = 1,
         updated_at = EXCLUDED.updated_at`,
      [m.areaName, m.code, m.barcode, m.kioskSlug, m.sortOrder, now, now]
    );
  }
}

async function deactivateLegacyStationMachines(client) {
  const now = ts();
  await client.query(
    `UPDATE machines
     SET active = 0, updated_at = $1
     WHERE UPPER(TRIM(code)) LIKE 'WS-%'
        OR name ILIKE 'Winding Station%'`,
    [now]
  );
}

async function seedEmployees(client) {
  const now = ts();
  for (let i = 1; i <= 20; i += 1) {
    const code = `EMP${String(i).padStart(3, '0')}`;
    const name = `Employee ${String(i).padStart(3, '0')}`;
    await client.query(
      `INSERT INTO employees (code, name, is_active, hourly_rate, created_at, updated_at)
       VALUES ($1,$2,1,20,$3,$4)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, now, now]
    );
  }
}

async function run() {
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await seedUsers(client);
      await seedTeams(client);
      await seedMachines(client);
      await deactivateLegacyStationMachines(client);
      await seedEmployees(client);
      await client.query('COMMIT');
      console.log('[seed] done: users, teams, winding machines, EMP001-EMP020');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

run()
  .then(async () => {
    await closePool();
  })
  .catch(async (err) => {
    console.error('[seed] failed:', err.message);
    await closePool();
    process.exit(1);
  });
