# Generate mkcert TLS certificates for LAN HTTPS / PWA install.
# Requires mkcert: winget install FiloSottile.mkcert  OR  choco install mkcert

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$CertsDir = Join-Path $Root "certs"
$KeyFile = Join-Path $CertsDir "lan-key.pem"
$CertFile = Join-Path $CertsDir "lan.pem"

function Get-LanIPv4 {
  $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notmatch '^127\.' -and
      $_.IPAddress -notmatch '^169\.254\.' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Sort-Object InterfaceMetric |
    Select-Object -ExpandProperty IPAddress -First 1
  if ($addrs) { return $addrs }
  return "192.168.1.229"
}

function Require-Mkcert {
  $mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
  if (-not $mkcert) {
    Write-Host ""
    Write-Host "mkcert is not installed." -ForegroundColor Red
    Write-Host "Install with one of:"
    Write-Host "  winget install FiloSottile.mkcert"
    Write-Host "  choco install mkcert"
    Write-Host ""
    Write-Host "Then close and reopen PowerShell and run this script again."
    exit 1
  }
  return $mkcert.Source
}

Write-Host "Factory Scan Clock — mkcert HTTPS setup" -ForegroundColor Cyan
Write-Host ""

$mkcertPath = Require-Mkcert
Write-Host "Using mkcert: $mkcertPath"

if (-not (Test-Path $CertsDir)) {
  New-Item -ItemType Directory -Path $CertsDir | Out-Null
}

Write-Host "Installing local CA (admin prompt may appear)..."
& mkcert -install
if ($LASTEXITCODE -ne 0) {
  Write-Host "mkcert -install failed." -ForegroundColor Red
  exit 1
}

$lanIp = Get-LanIPv4
$customIp = Read-Host "LAN IP to include in certificate [$lanIp]"
if ($customIp.Trim()) { $lanIp = $customIp.Trim() }

$names = @("localhost", "127.0.0.1", "::1", $lanIp)
Write-Host ""
Write-Host "Generating certificate for: $($names -join ', ')"
Write-Host "Output: $CertFile"

Push-Location $CertsDir
try {
  if (Test-Path $KeyFile) { Remove-Item $KeyFile -Force }
  if (Test-Path $CertFile) { Remove-Item $CertFile -Force }

  & mkcert -key-file "lan-key.pem" -cert-file "lan.pem" @names
  if ($LASTEXITCODE -ne 0) {
    Write-Host "mkcert certificate generation failed." -ForegroundColor Red
    exit 1
  }
} finally {
  Pop-Location
}

$caRoot = & mkcert -CAROOT
$caFile = Join-Path $caRoot "rootCA.pem"

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "1. Add to .env.local:"
Write-Host "   HTTPS_ENABLED=true"
Write-Host "   HTTPS_PORT=3443"
Write-Host "   HTTP_PORT=3000"
Write-Host "   HTTP_REDIRECT_ENABLED=true"
Write-Host ""
Write-Host "2. Restart the app:"
Write-Host "   pm2 restart factory-scan-clock --update-env"
Write-Host "   (or: npm run dev)"
Write-Host ""
Write-Host "3. Open on this PC:"
Write-Host "   https://localhost:3443/pwa-debug"
Write-Host ""
Write-Host "4. Open on Android (same Wi‑Fi):"
Write-Host "   https://${lanIp}:3443/pwa-debug"
Write-Host ""
Write-Host "5. Trust mkcert on Android (required once per device):"
Write-Host "   Copy root CA to the phone:"
Write-Host "   $caFile"
Write-Host "   Settings > Security > Encryption & credentials > Install a certificate > CA certificate"
Write-Host ""
Write-Host "See LOCAL_HTTPS_SETUP.md for full steps."
