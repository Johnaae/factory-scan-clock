# Database restore after a server crash (Windows)

This guide explains how to restore **Factory Scan Clock** from a PostgreSQL backup after hardware failure, corruption, or accidental data loss on your **Windows** server.

Backups are **pg_dump custom-format** files (`.backup`) stored in:

`C:\Users\POS\factory-scan-clock\backups`

Example filename: `factory_scan_clock_20260528_143000.backup`

JSON files in the same folder (`backup-*.json`) are legacy exports and are **not** used for restore.

---

## Before you start

1. **PostgreSQL must be running** on the target machine (Windows Services → PostgreSQL, or your installer’s service).
2. **Know your target database** — check `DATABASE_URL` in `.env` or `.env.local`:
   - Local LAN example: `postgresql://postgres:password@localhost:5432/factory_scan_clock`
3. **Have a recent `.backup` file** — create one from another machine if needed (System page → Create Backup, or `npm run backup:pg`).
4. **Stop the app** so nothing writes to the database during restore:

```bat
pm2 stop factory-scan-clock
```

---

## Quick restore (latest backup)

1. Open **Command Prompt** or **PowerShell** as a user that can reach PostgreSQL.
2. Go to the project folder:

```bat
cd C:\Users\POS\factory-scan-clock
```

3. Run the restore script:

```bat
restore_database.bat
```

4. Read the confirmation screen carefully:
   - **Local database** — type `YES` to continue.
   - **Production / remote database** (Neon, cloud, or non-local host without `INTERNAL_LAN_MODE`) — you must type the **exact database name** to continue. This prevents accidental overwrites.
5. Wait for `pg_restore` to finish. The script prints **SUCCESS** or **FAILED**.

6. Start the app again:

```bat
pm2 start factory-scan-clock
```

7. Verify: open the manager login, check tanks, employees, and recent scan logs.

---

## Restore a specific backup file

List available backups:

```bat
node scripts/pg-restore.js --list
```

Restore one file (still requires confirmation):

```bat
node scripts/pg-restore.js --file factory_scan_clock_20260528_143000.backup --interactive
```

---

## Configuration

Restore uses the same credentials as the running app:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Host, port, database name, user, password |
| `PGPASSWORD` | Optional password if not in `DATABASE_URL` |
| `PG_RESTORE_PATH` | Optional full path to `pg_restore.exe` |
| `PG_DUMP_PATH` | If set, restore tries the matching `pg_restore.exe` in the same `bin` folder |

Windows auto-detection looks in:

`C:\Program Files\PostgreSQL\{12–18}\bin\pg_restore.exe`

and on `PATH` via `where pg_restore`.

---

## After a full server crash (new or replaced PC)

### 1. Reinstall prerequisites

- **Node.js** 18+ (same major version as before if possible)
- **PostgreSQL** 14+ (match or exceed your previous version)
- **PM2** (if you use it): `npm install -g pm2`

### 2. Restore project files

Copy or clone the app to:

`C:\Users\POS\factory-scan-clock`

Restore **`.env` / `.env.local`** from secure backup (or recreate `DATABASE_URL` and `SESSION_SECRET`).

Copy backup files into:

`C:\Users\POS\factory-scan-clock\backups`

### 3. Create the empty database (if needed)

If PostgreSQL is fresh and the database does not exist:

```bat
psql -U postgres -c "CREATE DATABASE factory_scan_clock;"
```

Or use pgAdmin → Create → Database.

### 4. Install dependencies and run restore

```bat
cd C:\Users\POS\factory-scan-clock
npm install
restore_database.bat
```

You do **not** need `npm run migrate` before restore if the backup already contains your full schema and data. After restore, the database should match the backup point in time.

### 5. Start the application

```bat
pm2 start server.js --name factory-scan-clock
pm2 save
```

Open `http://localhost:3000` (or your LAN IP) and sign in as manager.

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| `pg_restore not found` | Set `PG_RESTORE_PATH` in `.env` to your `pg_restore.exe` path |
| `DATABASE_URL is not set` | Copy `.env.local.example` → `.env.local` and set credentials |
| `No PostgreSQL backup files found` | Copy a `.backup` file into `backups\` or create one with `npm run backup:pg` |
| `password authentication failed` | Fix username/password in `DATABASE_URL` |
| Restore cancelled | Re-run `restore_database.bat` and confirm when prompted |
| App works but sessions lost | Expected if `SESSION_SECRET` changed; users re-login |
| `relation already exists` warnings | Often harmless with `--clean`; check app data after restore |

---

## Safety notes

- Restore **overwrites** objects in the target database (`pg_restore --clean --if-exists`).
- Always confirm the **host** and **database name** on the confirmation screen.
- For production (Neon/cloud), take a fresh backup before restoring over live data.
- Keep `.backup` files off the server as well (network share or cloud storage) so a disk failure does not destroy your only copy.

---

## Related commands

| Command | Description |
|---------|-------------|
| `restore_database.bat` | Interactive restore of latest backup (Windows) |
| `npm run backup:pg` | Create a new `.backup` file |
| `npm run backup` | JSON export (legacy, not for pg_restore) |

See also [LOCAL_LAN_SETUP.md](LOCAL_LAN_SETUP.md) for local PostgreSQL setup.
