#Requires -Version 5.1
<#
.SYNOPSIS
  One-click setup for the Factory Scan Clock nightly PostgreSQL backup task.

.DESCRIPTION
  Registers (or overwrites) the Windows Task Scheduler job:
    Factory Scan Clock - Nightly DB Backup
  Runs scheduled_backup.bat daily at 11:00 PM.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-backup-task.ps1
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'Factory Scan Clock - Nightly DB Backup'
$ProjectRoot = $PSScriptRoot
$BatchPath = Join-Path $ProjectRoot 'scheduled_backup.bat'
$BackupsDir = Join-Path $ProjectRoot 'backups'

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  Factory Scan Clock - Nightly Backup Task Setup' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $BatchPath)) {
  throw "scheduled_backup.bat not found: $BatchPath"
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Existing task found - overwriting: $TaskName" -ForegroundColor Yellow
}

$action = New-ScheduledTaskAction `
  -Execute $BatchPath `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At '11:00 PM'

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Nightly pg_dump backup for Factory Scan Clock' `
    -Force | Out-Null
} catch {
  Write-Host ''
  Write-Host 'ERROR: Could not register the scheduled task.' -ForegroundColor Red
  Write-Host 'Run PowerShell as Administrator, then run this script again.' -ForegroundColor Yellow
  Write-Host ''
  throw
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host '  SUCCESS: Scheduled backup task is ready.' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''
Write-Host "  Task name : $TaskName"
Write-Host '  Schedule  : Daily at 11:00 PM'
Write-Host "  Runs      : $BatchPath"
Write-Host "  Backups   : $BackupsDir"
Write-Host ''
Write-Host '  Test: Open Task Scheduler, find the task, right-click -> Run.'
Write-Host ''
