'use strict';

const crypto = require('crypto');
const { withClient, closePool } = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return `pbkdf2_sha512$120000$${salt}$${hash}`;
}

function ts() {
  return new Date().toISOString();
}

const KIOSK_USERS = [
  {
    username: 'kiosk_area_a',
    password: process.env.DEFAULT_KIOSK_PASSWORD_A || 'kioskA123',
    role: 'KIOSK',
    station_name: 'Fabrication Kiosk',
    area_name: 'Fabrication',
    pin: '1111',
  },
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
    ...KIOSK_USERS,
  ];

  for (const u of users) {
    await client.query(
      `INSERT INTO users (username, password_hash, pin_hash, role, station_name, area_name, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, hashPassword(u.password), u.pin ? hashPassword(u.pin) : null, u.role, u.station_name, u.area_name, now, now]
    );
  }

  for (const k of KIOSK_USERS) {
    await client.query(
      `UPDATE users SET area_name = $1, station_name = $2, updated_at = $3
       WHERE username = $4 AND role = 'KIOSK'`,
      [k.area_name, k.station_name, now, k.username]
    );
  }
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
      await seedEmployees(client);
      await client.query('COMMIT');
      console.log('[seed] done: users + EMP001-EMP020');
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
