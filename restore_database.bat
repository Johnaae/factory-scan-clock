@echo off
setlocal EnableExtensions

rem Factory Scan Clock — PostgreSQL database restore (Windows only)
rem Restores the latest pg_dump custom-format backup from the backups folder.

cd /d "%~dp0"

echo ============================================================
echo   Factory Scan Clock - PostgreSQL Database Restore
echo ============================================================
echo.
echo Project folder : %~dp0
echo Backups folder : %~dp0backups
echo.
echo Stop the app (pm2 stop factory-scan-clock) before restoring.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  echo Install Node.js 18+ from https://nodejs.org/ and try again.
  goto :fail
)

node scripts/pg-restore.js --latest --interactive
set RESTORE_EXIT=%ERRORLEVEL%

if %RESTORE_EXIT% EQU 2 (
  echo.
  echo ============================================================
  echo   CANCELLED: Restore was not performed.
  echo ============================================================
  echo.
  exit /b 2
)

if %RESTORE_EXIT% NEQ 0 goto :fail

echo.
echo ============================================================
echo   SUCCESS: Database restore completed.
echo ============================================================
echo Restart the app when ready: pm2 start factory-scan-clock
echo.
exit /b 0

:fail
echo.
echo ============================================================
echo   FAILED: Database restore did not complete.
echo ============================================================
echo See error messages above.
echo For step-by-step help after a server crash, read DATABASE_RESTORE.md
echo.
exit /b 1
