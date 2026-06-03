# Local LAN database setup

Use this when testing on your office network with **local PostgreSQL** (not Neon).

## 1. Install PostgreSQL

Install PostgreSQL 14+ on the machine that will run the app (Windows installer or Docker).

## 2. Create database

```sql
CREATE DATABASE factory_scan_clock;
```

Or from a shell:

```bash
createdb factory_scan_clock
```

## 3. Configure environment

```bash
copy .env.local.example .env.local
```

Edit `.env.local`:

- `DATABASE_URL` — your local user, password, host, port, database name
- `SESSION_SECRET` — any long random string
- `INTERNAL_LAN_MODE=true` — required for local LAN (disables SSL, blocks accidental Neon URL)

## 4. Run migrations and seed

```bash
npm run migrate
npm run seed
```

## 5. Start the app

```bash
npm run dev
```

Open **http://localhost:3000** (or `http://<your-lan-ip>:3000` from other devices on the network).

On startup you should see:

```
DB host: localhost
[db] INTERNAL_LAN_MODE=true — local PostgreSQL, SSL off
```

## Switching back to Neon / Vercel

1. Remove or rename `.env.local`, **or** set `INTERNAL_LAN_MODE=false`
2. Set `DATABASE_URL` to your Neon connection string in Vercel env vars or `.env`
3. Do **not** set `INTERNAL_LAN_MODE=true` in production

See `.env.example` for cloud deploy variables.
