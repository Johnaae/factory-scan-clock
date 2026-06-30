# Scheduled nightly backup (Windows Task Scheduler)

Automatically back up the Factory Scan Clock PostgreSQL database every day at **11:00 PM**, store files in `backups\`, and keep only the **30 most recent** `.backup` files.

| Item | Value |
|------|--------|
| Schedule | Daily at **11:00 PM** |
| Script | `scheduled_backup.bat` |
| Backup command | `npm run backup:pg` |
| Backup folder | `C:\Users\POS\factory-scan-clock\backups` |
| Retention | 30 newest `factory_scan_clock_*.backup` files |
| Logs | `C:\Users\POS\factory-scan-clock\logs\scheduled-backup-YYYYMMDD.log` |

JSON files in `backups\` (`backup-*.json`) are **never** deleted by the scheduled job.

---

## 1. Test the batch file manually

Before scheduling, confirm a backup works on this PC:

```bat
cd C:\Users\POS\factory-scan-clock
scheduled_backup.bat
```

You should see **SUCCESS** and a new file in:

`C:\Users\POS\factory-scan-clock\backups\factory_scan_clock_YYYYMMDD_HHMMSS.backup`

Check the log if anything fails:

```bat
type logs\scheduled-backup-20260604.log
```

Dry-run retention (lists files that would be deleted):

```bat
node scripts/prune-pg-backups.js --keep 30 --dry-run
```

---

## 2. Prerequisites for Task Scheduler

The Windows account that runs the task must have:

1. **Read access** to the project folder (especially `.env` / `.env.local` with `DATABASE_URL`)
2. **Write access** to `backups\` and `logs\`
3. **Node.js and npm on PATH** for that account (or log in once as that user and verify `where node` and `where npm`)
4. **PostgreSQL client tools** — `pg_dump.exe` reachable (auto-detected or set `PG_DUMP_PATH` in `.env`)
5. **PostgreSQL running** at 11:00 PM (local service or remote host in `DATABASE_URL`)

Recommended: run the task as the **same user** that runs PM2 / the app (e.g. `POS`), not as `SYSTEM`, so `.env.local` and PATH match your normal setup.

---

## 3. Create the scheduled task (GUI)

### Step A — Open Task Scheduler

1. Press **Win + R**, type `taskschd.msc`, press **Enter**
2. Or search **Task Scheduler** in the Start menu

### Step B — Create task

1. Click **Create Task…** (not “Create Basic Task” — we need extra options)
2. **General** tab:
   - **Name:** `Factory Scan Clock - Nightly DB Backup`
   - **Description:** `Runs scheduled_backup.bat at 11 PM — pg_dump to backups folder`
   - Select **Run only when user is logged on** (simplest; use your app user)
   - Or **Run whether user is logged on or not** if the server runs headless (you will be prompted for the account password)
   - Check **Run with highest privileges** only if required for PostgreSQL/network access

### Step C — Triggers

1. Open the **Triggers** tab → **New…**
2. **Begin the task:** On a schedule
3. **Settings:** Daily
4. **Start:** today’s date, time **11:00:00 PM** (23:00)
5. **Recur every:** 1 days
6. Check **Enabled** → **OK**

### Step D — Actions

1. Open the **Actions** tab → **New…**
2. **Action:** Start a program
3. **Program/script:**

   ```
   C:\Users\POS\factory-scan-clock\scheduled_backup.bat
   ```

4. **Start in (optional but required for this app):**

   ```
   C:\Users\POS\factory-scan-clock
   ```

5. **OK**

### Step E — Conditions (recommended)

**Conditions** tab:

- Uncheck **Start the task only if the computer is on AC power** (if you use a laptop/server that might be on battery)
- Check **Wake the computer to run this task** only if you need wake-from-sleep (usually off for a factory PC)

### Step F — Settings

**Settings** tab:

- Check **Allow task to be run on demand** (so you can test from the GUI)
- **If the task fails, restart every:** 10 minutes, **Attempt to restart up to:** 3 times
- **If the task is already running:** Do not start a new instance

Click **OK**. Enter the Windows password if prompted.

---

## 4. Test from Task Scheduler

1. In Task Scheduler Library, find **Factory Scan Clock - Nightly DB Backup**
2. Right-click → **Run**
3. Wait ~30 seconds, then check:
   - New `.backup` in `backups\`
   - Log file in `logs\`
   - **Last Run Result** column should show `(0x0)` for success

If **Last Run Result** is not `0x0`, open the log file for that day or run `scheduled_backup.bat` manually in Command Prompt to see errors.

---

## 5. Create the task with PowerShell (optional)

Run **PowerShell as Administrator** (adjust username if needed):

```powershell
$action = New-ScheduledTaskAction `
  -Execute "C:\Users\POS\factory-scan-clock\scheduled_backup.bat" `
  -WorkingDirectory "C:\Users\POS\factory-scan-clock"

$trigger = New-ScheduledTaskTrigger -Daily -At "11:00 PM"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName "Factory Scan Clock - Nightly DB Backup" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User "POS" `
  -Description "Nightly pg_dump backup for Factory Scan Clock"
```

You will be prompted for the `POS` account password unless you use a group managed service account.

---

## 6. What the batch file does

1. Changes to `C:\Users\POS\factory-scan-clock`
2. Runs `npm run backup:pg` → creates `factory_scan_clock_YYYYMMDD_HHMMSS.backup` in `backups\`
3. Runs `node scripts/prune-pg-backups.js --keep 30` → deletes older `.backup` files beyond the 30 newest (by file date)
4. Appends output to `logs\scheduled-backup-YYYYMMDD.log`
5. Exits with code **0** (success) or **1** (failure)

To change retention, edit `KEEP_COUNT=30` in `scheduled_backup.bat`.

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Task runs but no backup | Open today’s log in `logs\`; confirm `DATABASE_URL` and `pg_dump` path |
| `Node.js not found` | Install Node or add `C:\Program Files\nodejs` to **system** PATH for the task user |
| `pg_dump not found` | Set `PG_DUMP_PATH` in `.env` to full path of `pg_dump.exe` |
| `0x1` / failed in Task Scheduler | Run `scheduled_backup.bat` manually while logged in as the task user |
| Backups folder empty | Task user may lack write permission on `backups\` |
| Wrong database backed up | Task uses `.env` + `.env.local` in the project folder — verify `DATABASE_URL` |

---

## Related docs

- [DATABASE_RESTORE.md](DATABASE_RESTORE.md) — restore after a crash (`restore_database.bat`)
- [LOCAL_LAN_SETUP.md](LOCAL_LAN_SETUP.md) — local PostgreSQL setup
- System page (`/system`) — manual backup from the manager UI
