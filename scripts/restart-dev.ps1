# =============================================================================
# LeadForge AI - one-command dev stack restart (Windows / PowerShell)
#
#   .\scripts\restart-dev.ps1
#
# Stops anything holding 4000 / 5173 / 8000, then starts in dependency order:
#   1. scraper   FastAPI + uvicorn  http://127.0.0.1:8000   (Python, .venv)
#   2. backend   Express API        http://127.0.0.1:4000   (Node)
#   3. frontend  Vite dev server    http://127.0.0.1:5173   (Node)
#
# Logs land in <service>/dev.log. Pass -Detach to run hidden (no new window).
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Detach
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$services = @(
    @{ Name = 'scraper';  Port = 8000; Dir = Join-Path $root 'scraper'  }
    @{ Name = 'backend';  Port = 4000; Dir = Join-Path $root 'backend'  }
    @{ Name = 'frontend'; Port = 5173; Dir = Join-Path $root 'frontend' }
)

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Start-Service([string]$file, [string[]]$argv, [string]$dir, [string]$log) {
    $err = $log -replace '\.log$', '.err.log'
    $common = @{
        FilePath               = $file
        ArgumentList           = $argv
        WorkingDirectory       = $dir
        RedirectStandardOutput = $log
        RedirectStandardError  = $err
    }
    if ($Detach) { $common['WindowStyle'] = 'Hidden' } else { $common['NoNewWindow'] = $true }
    Start-Process @common
}

# --- 1. free the ports -------------------------------------------------------
Write-Step 'Stopping anything on 4000 / 5173 / 8000'
foreach ($svc in $services) {
    $conns = Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $procId = $c.OwningProcess
        # Never kill ourselves.
        if ($procId -ne $PID) {
            Write-Host "    stopping $($svc.Name) (port $($svc.Port), pid $procId)"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
}
Start-Sleep -Seconds 3

# --- 2. start the scraper first (backend calls it) ---------------------------
Write-Step 'Starting scraper (FastAPI :8000)'
$python = Join-Path $root 'scraper\.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    throw "Python venv not found at $python - run: cd scraper; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
}
Start-Service $python @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000') `
    (Join-Path $root 'scraper') (Join-Path $root 'scraper\dev.log')

# Wait for the scraper so the backend never starts against a dead dependency.
$ready = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}
if ($ready) { Write-Host '    scraper healthy' -ForegroundColor Green }
else { Write-Warning 'scraper :8000 did not answer /health in 30s - check scraper\dev.err.log' }

# --- 3. backend --------------------------------------------------------------
Write-Step 'Starting backend (Express :4000)'
$backendDir = Join-Path $root 'backend'
if (-not (Test-Path (Join-Path $backendDir 'node_modules'))) {
    throw 'backend node_modules missing - run: cd backend; npm install'
}
Start-Service 'npm.cmd' @('start') $backendDir (Join-Path $backendDir 'dev.log')

# --- 4. frontend -------------------------------------------------------------
Write-Step 'Starting frontend (Vite :5173)'
$frontDir = Join-Path $root 'frontend'
if (-not (Test-Path (Join-Path $frontDir 'node_modules'))) {
    throw 'frontend node_modules missing - run: cd frontend; npm install'
}
Start-Service 'npm.cmd' @('run', 'dev') $frontDir (Join-Path $frontDir 'dev.log')

# --- 5. verify ---------------------------------------------------------------
Write-Step 'Waiting for backend + frontend'
$backendOk = $false; $frontOk = $false
foreach ($i in 1..40) {
    Start-Sleep -Seconds 1
    if (-not $backendOk) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4000/api/health' -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $backendOk = $true }
        } catch { }
    }
    if (-not $frontOk) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/' -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $frontOk = $true }
        } catch { }
    }
    if ($backendOk -and $frontOk) { break }
}

Write-Host ''
Write-Step 'Status'
$rows = @(
    @{ S = 'scraper '; Ok = $ready;    Url = 'http://127.0.0.1:8000/health' }
    @{ S = 'backend '; Ok = $backendOk; Url = 'http://127.0.0.1:4000/api/health' }
    @{ S = 'frontend'; Ok = $frontOk;   Url = 'http://127.0.0.1:5173/' }
)
foreach ($r in $rows) {
    $mark = if ($r.Ok) { 'OK  ' } else { 'FAIL' }
    $col = if ($r.Ok) { 'Green' } else { 'Red' }
    Write-Host "    [$mark] $($r.S)  $($r.Url)" -ForegroundColor $col
}
Write-Host ''
if ($ready -and $backendOk -and $frontOk) {
    Write-Host 'Dev stack is up. Open http://localhost:5173' -ForegroundColor Green
} else {
    Write-Warning 'One or more services did not come up - see dev.log / dev.err.log in each folder.'
}
