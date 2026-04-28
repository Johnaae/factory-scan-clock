# Production Checklist

- [ ] `npm run migrate` succeeds locally against Neon
- [ ] `npm run seed` succeeds locally against Neon
- [ ] `npm run dev` starts without env/session errors
- [ ] Vercel deploy succeeds
- [ ] `/login` loads
- [ ] Manager login works
- [ ] Kiosk login works
- [ ] Scan IN flow works (`EMP001 -> RUN_MACHINE -> TANK_1111`)
- [ ] Scan OUT flow works (`EMP001 -> LUNCH` / `END_SHIFT`)
- [ ] Manager dashboard updates every ~5s
- [ ] Export PDF/CSV works
- [ ] No MemoryStore warning in logs
- [ ] No `FUNCTION_INVOCATION_FAILED` due to sessions
- [ ] Backup scripts run (`npm run backup`, `npm run backup:daily`)
