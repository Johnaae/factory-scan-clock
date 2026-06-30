@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Factory Scan Clock — production install (Windows)
rem Uses the folder containing this script as the app root. No hardcoded user paths.

cd /d "%~dp0"
set "APP_ROOT=%~dp0"
set "APP_ROOT=%APP_ROOT:~0,-1%"
set "BACKUPS_DIR=%~dp0backups"
set "LOGS_DIR=%~dp0logs"
set "UPDATES_DIR=%~dp0updates"
set "CERTS_DIR=%~dp0certs"
set "PM2_NAME=factory-scan-clock"
set "EXPECTED_DB=factory_scan_clock"
set "PORT=3000"

echo.
echo ============================================================
echo   Factory Scan Clock - Production Install
echo ============================================================
echo.
echo App root : %APP_ROOT%
echo.

rem --- 1. Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Please install Node.js first
  echo Download from https://nodejs.org/ ^(Node 18+ recommended^)
  goto :fail
)

echo Checking Node.js ...
for /f "delims=" %%V in ('node -v 2^>nul') do echo   Node %%V
if errorlevel 1 (
  echo ERROR: Please install Node.js first
  goto :fail
)

rem --- 2. npm ---
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  echo Install Node.js ^(includes npm^) from https://nodejs.org/
  goto :fail
)

echo Checking npm ...
for /f "delims=" %%V in ('npm -v 2^>nul') do echo   npm %%V
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  goto :fail
)

rem --- 3. PostgreSQL client tools ---
set "PG_BIN="
set "PG_DUMP="
set "PG_RESTORE="

for %%V in (18 17 16 15 14 13 12) do (
  if not defined PG_BIN (
    set "CAND=C:\Program Files\PostgreSQL\%%V\bin"
    if exist "!CAND!\pg_dump.exe" if exist "!CAND!\pg_restore.exe" (
      set "PG_BIN=!CAND!"
      set "PG_DUMP=!CAND!\pg_dump.exe"
      set "PG_RESTORE=!CAND!\pg_restore.exe"
    )
  )
)

if not defined PG_DUMP (
  where pg_dump >nul 2>&1
  if not errorlevel 1 (
    for /f "delims=" %%P in ('where pg_dump 2^>nul') do (
      if not defined PG_DUMP set "PG_DUMP=%%P"
    )
  )
)

if not defined PG_RESTORE (
  where pg_restore >nul 2>&1
  if not errorlevel 1 (
    for /f "delims=" %%P in ('where pg_restore 2^>nul') do (
      if not defined PG_RESTORE set "PG_RESTORE=%%P"
    )
  )
)

if defined PG_DUMP if not defined PG_BIN (
  for %%D in ("%PG_DUMP%") do set "PG_BIN=%%~dpD"
  if defined PG_BIN set "PG_BIN=!PG_BIN:~0,-1!"
)

echo.
if defined PG_DUMP if defined PG_RESTORE (
  echo PostgreSQL tools found:
  echo   pg_dump    : %PG_DUMP%
  echo   pg_restore : %PG_RESTORE%
) else (
  echo WARNING: PostgreSQL client tools not found.
  echo   Looked in C:\Program Files\PostgreSQL\18\bin and 17\bin ^(and older versions^).
  echo   Also checked PATH for pg_dump.exe and pg_restore.exe.
  echo.
  echo   Install PostgreSQL client tools or set PG_DUMP_PATH / PG_RESTORE_PATH in .env.local
  echo   Example:
  echo     PG_DUMP_PATH=C:\Program Files\PostgreSQL\18\bin\pg_dump.exe
  echo     PG_RESTORE_PATH=C:\Program Files\PostgreSQL\18\bin\pg_restore.exe
  echo.
  echo   Backups on the System page will not work until pg_dump is available.
  echo.
)

rem --- 4. Required folders ---
echo Creating folders if missing ...
if not exist "%BACKUPS_DIR%" mkdir "%BACKUPS_DIR%"
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%"
if not exist "%UPDATES_DIR%" mkdir "%UPDATES_DIR%"
if not exist "%CERTS_DIR%" mkdir "%CERTS_DIR%"
echo   backups : %BACKUPS_DIR%
echo   logs    : %LOGS_DIR%
echo   updates : %UPDATES_DIR%
echo   certs   : %CERTS_DIR%
echo.

rem --- 5. npm install ---
echo Installing npm dependencies ...
call npm install
if errorlevel 1 (
  echo ERROR: npm install failed.
  goto :fail
)
echo.

rem --- 6. .env.local ---
set "ENV_CREATED="
if not exist ".env.local" (
  if exist ".env.local.example" (
    copy /y ".env.local.example" ".env.local" >nul
    set "ENV_CREATED=1"
    echo Created .env.local from .env.local.example
  ) else if exist ".env.example" (
    copy /y ".env.example" ".env.local" >nul
    set "ENV_CREATED=1"
    echo Created .env.local from .env.example
  ) else (
    echo WARNING: .env.local is missing and no .env.local.example or .env.example was found.
    echo Create .env.local with DATABASE_URL before starting the app.
  )
) else (
  echo .env.local already exists — leaving it unchanged.
)

if defined ENV_CREATED (
  echo.
  echo IMPORTANT: Edit .env.local and set:
  echo   - DATABASE_URL ^(PostgreSQL user, password, and database name^)
  echo   - SESSION_SECRET and OWNER_PASSWORD
  echo   Expected database name: %EXPECTED_DB%
  echo.
)

rem --- 7. Database name and connection ---
set "DB_CHECK_OK="
set "DB_NAME="
set "DB_CONN_MSG="

if exist ".env.local" (
  echo Checking database configuration ...
  for /f "usebackq tokens=1,* delims==" %%A in (`node scripts\install-db-check.js 2^>nul`) do (
    if /i "%%A"=="DB_NAME" set "DB_NAME=%%B"
    if /i "%%A"=="DB_STATUS" set "DB_CONN_MSG=%%B"
  )

  if defined DB_NAME (
    echo   Database name in DATABASE_URL: !DB_NAME!
    if /i not "!DB_NAME!"=="%EXPECTED_DB%" (
      echo.
      echo WARNING: Expected database name "%EXPECTED_DB%" but DATABASE_URL uses "!DB_NAME!".
      echo Edit .env.local if this machine should use %EXPECTED_DB%.
      echo.
    )
  ) else (
    echo WARNING: Could not read database name from DATABASE_URL in .env.local
    echo Edit .env.local and set DATABASE_URL before using the app.
    echo.
  )

  echo Testing database connection ...
  if "!DB_CONN_MSG!"=="OK" (
    set "DB_CHECK_OK=1"
    echo   Connection successful.
  ) else if "!DB_CONN_MSG!"=="MISSING_URL" (
    echo   DATABASE_URL is not set in .env.local — edit the file and re-run install if needed.
  ) else if defined DB_CONN_MSG (
    set "DB_ERR=!DB_CONN_MSG!"
    if /i "!DB_ERR:~0,6!"=="ERROR:" set "DB_ERR=!DB_ERR:~6!"
    echo   Connection failed: !DB_ERR!
    echo !DB_ERR! | findstr /i "does not exist" >nul 2>&1
    if not errorlevel 1 (
      echo.
      echo The database does not exist yet. Create it in pgAdmin:
      echo   1. Open pgAdmin and connect to your PostgreSQL server
      echo   2. Right-click Databases -^> Create -^> Database
      echo   3. Name: %EXPECTED_DB%
      echo   4. Save, then edit .env.local with the correct password
      echo   5. Run: npm run migrate
      echo      npm run seed   ^(optional, for initial users^)
      echo.
    ) else (
      echo   Check PostgreSQL is running and DATABASE_URL credentials in .env.local are correct.
      echo.
    )
  ) else (
    echo   Could not test connection — run: node scripts\install-db-check.js
    echo.
  )
) else (
  echo Skipping database check — .env.local not found.
  echo Copy .env.local.example to .env.local and set DATABASE_URL first.
  echo.
)

rem --- 8. PM2 ---
echo Setting up PM2 ...
set "PM2_CMD=pm2.cmd"
where pm2.cmd >nul 2>&1
if errorlevel 1 (
  set "PM2_CMD=pm2"
  where pm2 >nul 2>&1
  if errorlevel 1 (
    echo PM2 not found — installing globally ...
    call npm install -g pm2
    if errorlevel 1 (
      echo ERROR: Failed to install PM2. Try: npm install -g pm2
      goto :fail
    )
    where pm2.cmd >nul 2>&1
    if not errorlevel 1 (
      set "PM2_CMD=pm2.cmd"
    ) else (
      where pm2 >nul 2>&1
      if errorlevel 1 (
        echo ERROR: PM2 is still not available on PATH after install.
        goto :fail
      )
    )
  )
)

call %PM2_CMD% describe %PM2_NAME% >nul 2>&1
if errorlevel 1 (
  echo Starting %PM2_NAME% ...
  call %PM2_CMD% start server.js --name %PM2_NAME%
) else (
  echo Restarting %PM2_NAME% ...
  call %PM2_CMD% restart %PM2_NAME%
)
if errorlevel 1 (
  echo ERROR: PM2 failed to start the app. Check messages above.
  goto :fail
)

call %PM2_CMD% save
if errorlevel 1 (
  echo WARNING: pm2 save failed — process list may not persist after reboot.
) else (
  echo PM2 process list saved.
)
echo.

rem --- 9. Scheduled backup task ---
if exist "%~dp0setup-backup-task.ps1" (
  echo Registering nightly backup task ^(setup-backup-task.ps1^) ...
  echo Note: Administrator PowerShell may be required.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-backup-task.ps1"
  if errorlevel 1 (
    echo WARNING: Scheduled backup task was not registered.
    echo Run PowerShell as Administrator, then:
    echo   powershell -ExecutionPolicy Bypass -File "%~dp0setup-backup-task.ps1"
    echo.
  )
) else (
  echo setup-backup-task.ps1 not found — skipping scheduled backup setup.
  echo.
)

rem --- 10. LAN IPv4 ---
set "LAN_IP="
for /f "delims=" %%I in ('powershell -NoProfile -Command "$addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue ^| Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' -and $_.InterfaceAlias -notmatch 'Loopback' }; $ip = ($addrs ^| Where-Object { $_.IPAddress -match '^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)' } ^| Select-Object -First 1).IPAddress; if (-not $ip) { $ip = ($addrs ^| Select-Object -First 1).IPAddress }; if ($ip) { $ip }" 2^>nul') do set "LAN_IP=%%I"

rem --- 11. Final summary ---
echo.
echo ============================================================
echo   Installation completed
echo ============================================================
echo.
echo Local URL : http://localhost:%PORT%
if defined LAN_IP (
  echo LAN URL   : http://%LAN_IP%:%PORT%
) else (
  echo LAN URL   : http://^<your-lan-ip^>:%PORT%  ^(run ipconfig to find IPv4^)
)
echo.
echo Backup folder : %BACKUPS_DIR%
echo.
if not defined DB_CHECK_OK (
  echo Database: configure .env.local and ensure PostgreSQL database "%EXPECTED_DB%" exists.
  echo After creating the database, run: npm run migrate
) else (
  echo Database: connected to "%EXPECTED_DB%" ^(or name in DATABASE_URL^).
  echo If this is a new database, run: npm run migrate
)
echo.
echo Reminder: open the System page to verify health, backups, and PM2 status:
echo   http://localhost:%PORT%/system
echo.
echo Safety: existing backups were not modified. No database restore was run.
echo To restore from backup, run restore_database.bat manually when needed.
echo.
exit /b 0

:fail
echo.
echo ============================================================
echo   Installation failed — see messages above.
echo ============================================================
echo.
exit /b 1
