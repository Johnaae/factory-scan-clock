# Production Deployment Guide

## 1) Neon setup
- Create a Neon Postgres project/database.
- Copy the `DATABASE_URL` connection string.
- Run:
  - `npm run migrate`
  - `npm run seed`

## 2) Required environment variables
- `DATABASE_URL`
- `SESSION_SECRET`
- `NODE_ENV=production`

## 3) Vercel setup
- Import this repo into Vercel.
- Add the env vars above in Project Settings -> Environment Variables.
- Deploy.

## 4) Session + auth behavior
- Sessions use Postgres (`connect-pg-simple`), no in-memory store.
- Cookie policy:
  - `secure=true` in production
  - `sameSite=lax`
  - `httpOnly=true`
  - 30-day maxAge (kiosk friendly)

## 5) Kiosk setup
- Accounts seeded:
  - `manager`
  - `kiosk_area_a`
  - `kiosk_area_b`
  - `kiosk_area_c`
- Use `/login` and kiosk PIN login flow.

## 6) Scanner setup
- Scanner mode: HID keyboard wedge
- Suffix: CR / Enter
- Keep scanner-focused kiosk page at `/scan`.
- iPad: Add to Home Screen + Guided Access recommended.

## 7) Troubleshooting
- `DATABASE_URL missing` -> set env var in Vercel and redeploy.
- `SESSION_SECRET missing` -> set env var and redeploy.
- `500` errors:
  - check Vercel function logs
  - verify Neon is reachable
  - rerun migration script against target DB

## 8) Backups
- Manual backup:
  - `npm run backup`
- Daily-style backup export:
  - `npm run backup:daily`
- Output folder:
  - `backups/`
- Backup includes:
  - `employees`
  - `tanks`
  - `scan_logs`
  - `users` (without password/pin hashes)
