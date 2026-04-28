# Factory Scan Clock

Lightweight barcode **IN / OUT** time clock for small factory offices. Employees scan badge codes at a kiosk; the app records timestamps, shows live presence, summarizes the day, and estimates **daily payroll** from paired scans.

---

## Overview

- **SQLite** persistence (`scan.db`), **Express** HTTP API, static **HTML/CSS/JS** UI.
- **No authentication** — designed for a trusted LAN kiosk (demo / internal use).
- Scanner hardware behaves like a **keyboard**: it types the barcode and sends **Enter**. The dashboard keeps focus on a hidden input so scans are captured reliably.

---

## Setup

Requirements: **Node.js** 18.18+, 20.9+, 22+, or 24+.

```bash
npm install
npm run dev
```

Open **http://localhost:3000** (or the port shown in the terminal). Optional: `PORT=4000 npm run dev`.

---

## Production deployment (Vercel + Neon)

1. Create a Neon Postgres database and copy the connection string.
2. In Vercel project settings, set:
   - `DATABASE_URL`
   - `SESSION_SECRET`
   - `NODE_ENV=production`
3. Run migrations and seed against Neon:

```bash
npm run migrate
npm run seed
```

The seed command creates:
- `manager`
- `kiosk_area_a`
- `kiosk_area_b`
- `kiosk_area_c`
- `EMP001` through `EMP020`

---

## How the scanner works

1. Plug in the USB barcode scanner (keyboard wedge mode — default for most scanners).
2. Open the **Dashboard** fullscreen (**F11** recommended).
3. Click **Enable sound** once to unlock audio; success/error tones use the **Web Audio API** (high pitch = OK, low pitch = error).
4. Scan a badge: the device “types” the code and presses **Enter**.
5. The server looks up the employee by **code**, decides the next status (**IN** if last was OUT or missing, **OUT** if last was **IN**), and appends one row to `scan_logs`.

Unknown or inactive employees get a clear on-screen error; scan logic is unchanged across UI updates.

---

## Sample employee codes

After a fresh database, seeded employees include:

| Code    | Name         |
|---------|--------------|
| EMP001  | John Carter  |
| EMP002  | Mike Davis   |
| EMP003  | Alex Turner  |
| EMP004  | David Brooks |
| EMP005  | Chris Miller |
| EMP006  | Ethan Scott  |

Manage codes and **hourly rates** under **Employees** (`/admin.html`).

---

## Payroll calculation (simple)

Payroll is **intentionally simple** for demos and small teams:

1. For each **calendar day** (server local timezone), load all scans for that day ordered by time.
2. Walk the log chronologically per employee and build **IN → OUT** segments. Only time **between** a matched IN and the next OUT counts.
3. **Incomplete pairs** (IN without OUT, or OUT without a preceding IN inside the same day handling) **do not** add paid time.
4. Sum worked time → convert to hours; **round total worked hours** to the nearest **whole hour** (default).  
   Set `PAYROLL_ROUND_HOURS=floor` to round **down** to whole hours instead.
5. **`hours_rounded`** × **`hourly_rate`** = **wage** for that employee (stored per employee; default rate **20** USD).

Rounding applies to **hours**, not cents: wage uses the rounded hour count × rate.

---

## Export / reporting

Single endpoint for both CSV and PDF:

**GET** `/api/export`

| Query           | Values |
|-----------------|--------|
| `format`        | `csv` or `pdf` (required) |
| `scope`       | `today`, `range`, or `all` |
| `employee`    | `all` or an employee **code** (e.g. `EMP001`) |
| `start`, `end`| Required when `scope=range` (`YYYY-MM-DD`) |

Examples:

- Today, all workers, PDF: `/api/export?format=pdf&scope=today&employee=all`
- Today, one worker CSV: `/api/export?format=csv&scope=today&employee=EMP001`
- Range: `/api/export?format=csv&scope=range&employee=all&start=2026-04-01&end=2026-04-20`

**CSV** returns matching **scan_logs** rows (`employee_code`, `employee_name`, `status`, `scanned_at`).

**PDF** (PDFKit): **Factory Scan Report** — payroll summary for the selected scope and workers (IN→OUT pairs, rounded hours × rate), plus a **scan log** appendix filtered the same way. One worker yields a compact summary plus that worker’s detailed log table.

Dashboard and Daily Summary both use **Export report** with the same options.

---

## Environment variables

| Variable               | Meaning |
|------------------------|---------|
| `PORT`                 | HTTP port (default `3000`). |
| `PAYROLL_ROUND_HOURS`  | `nearest` (default) or `floor` — how whole hours are rounded from computed work time. |

---

## Pages

| Page            | Path            | Purpose |
|-----------------|-----------------|---------|
| Dashboard       | `/`             | Scan kiosk, KPIs, payroll snapshot, CSV export, employee status & logs. |
| Employees       | `/admin.html`   | CRUD employees, hourly rate, active flag. |
| Daily Summary   | `/summary.html` | Calendar day summary + CSV/PDF exports. |

---

## License

MIT.
