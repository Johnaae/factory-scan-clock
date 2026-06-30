@echo off
setlocal EnableExtensions

rem Factory Scan Clock — nightly PostgreSQL backup (Windows Task Scheduler)
rem Runs: npm run backup:pg, then keeps the 30 newest .backup files.

cd /d "%~dp0"

set "BACKUPS_DIR=%~dp0backups"
set "LOG_DIR=%~dp0logs"
set "KEEP_COUNT=30"

if not exist "%BACKUPS_DIR%" mkdir "%BACKUPS_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "LOGDATE=%%I"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""') do set "TS=%%I"

set "LOG_FILE=%LOG_DIR%\scheduled-backup-%LOGDATE%.log"

echo.
echo ============================================================
echo   Factory Scan Clock - Scheduled PostgreSQL Backup
echo ============================================================
echo   Time    : %TS%
echo   Backups : %BACKUPS_DIR%
echo   Log     : %LOG_FILE%
echo ============================================================
echo.

>> "%LOG_FILE%" echo.
>> "%LOG_FILE%" echo ============================================================
>> "%LOG_FILE%" echo [%TS%] Scheduled backup started
>> "%LOG_FILE%" echo Backups folder: %BACKUPS_DIR%
>> "%LOG_FILE%" echo ============================================================

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  >> "%LOG_FILE%" echo ERROR: Node.js not found on PATH
  goto :fail
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  >> "%LOG_FILE%" echo ERROR: npm not found on PATH
  goto :fail
)

echo Running npm run backup:pg ...
>> "%LOG_FILE%" echo Running npm run backup:pg ...

call npm run backup:pg >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo ERROR: backup:pg failed. See log: %LOG_FILE%
  >> "%LOG_FILE%" echo ERROR: backup:pg failed
  goto :fail
)

echo Backup completed. Pruning to latest %KEEP_COUNT% file(s) ...
>> "%LOG_FILE%" echo Running prune — keep %KEEP_COUNT%

call node scripts/prune-pg-backups.js --keep %KEEP_COUNT% >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo ERROR: prune failed. See log: %LOG_FILE%
  >> "%LOG_FILE%" echo ERROR: prune failed
  goto :fail
)

>> "%LOG_FILE%" echo [%TS%] SUCCESS — scheduled backup finished
echo.
echo SUCCESS: Backup completed. Keeping latest %KEEP_COUNT% .backup file(s).
echo Log: %LOG_FILE%
echo.
exit /b 0

:fail
>> "%LOG_FILE%" echo FAILED — scheduled backup did not complete
echo.
echo FAILED: Scheduled backup did not complete. See log: %LOG_FILE%
echo.
exit /b 1
