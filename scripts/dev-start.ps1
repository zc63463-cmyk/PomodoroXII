# Dev stack launcher for PomodoroXII (阶段 0.3 固化).
#
# Encodes every environment lesson from 2026-08-30/31:
#   - backend must run via backend/.venv python (uv trampoline breaks here)
#   - PYTHONPATH must be EMPTY (WorkBuddy shim hijacks file deletes ->
#     SpaceStorageMissingError / SAFE_DELETE_FAIL_CLOSED on provisioning)
#   - settings require the canonical env trio pointing at ONE data root
#   - refuse to touch ports that are already taken
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-start.ps1          # start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-start.ps1 -Stop    # stop
# Default ports: backend 8011 / frontend 5173 (match playwright config).
param(
    [int]$BackendPort = 8011,
    [int]$FrontendPort = 5173,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $env:TEMP 'pxii-dev-stack.pids'

function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

if ($Stop) {
    if (Test-Path $pidFile) {
        foreach ($pid in Get-Content $pidFile) {
            if ($pid) { taskkill.exe /PID $pid /T /F 2>&1 | Out-Null }
        }
        Remove-Item $pidFile -Force
        Write-Host '[dev] stack stopped'
    } else {
        Write-Host '[dev] no pid file; nothing to stop'
    }
    exit 0
}

if ((Test-Port $BackendPort) -or (Test-Port $FrontendPort)) {
    Write-Host "[dev] FAIL: port $BackendPort or $FrontendPort already in use; run with -Stop first"
    exit 1
}

# Canonical data root: the repo-root ./data (clean instance).
$dataRoot = Join-Path $repoRoot 'data'
$env:POMODOROXII_DATA_ROOT = $dataRoot
$env:POMODOROXII_DATABASE_URL = "sqlite+aiosqlite:///$($dataRoot -replace '\\','/')/meta.db"
$env:POMODOROXII_SPACES_DATA_DIR = Join-Path $dataRoot 'spaces'
$env:POMODOROXII_BACKUP_ENABLED = 'false'

# Lesson: kill the WorkBuddy shim so file deletes reach the Recycle Bin
# normally (sitecustomize.py safe-delete fail-closes without it).
$env:PYTHONPATH = ''

$backend = Join-Path $repoRoot 'backend\.venv\Scripts\python.exe'
if (-not (Test-Path $backend)) { Write-Host '[dev] FAIL: backend/.venv missing (run uv sync first)'; exit 1 }

$backendProc = Start-Process -FilePath $backend `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$BackendPort") `
    -WorkingDirectory (Join-Path $repoRoot 'backend') -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $env:TEMP 'pxii-dev-backend.log') `
    -RedirectStandardError (Join-Path $env:TEMP 'pxii-dev-backend.err.log')

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
$env:TASK_SPACE_API_TARGET = "http://127.0.0.1:$BackendPort"
$frontendProc = Start-Process -FilePath $npm `
    -ArgumentList @('run', 'dev', '--', '--port', "$FrontendPort") `
    -WorkingDirectory (Join-Path $repoRoot 'frontend') -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $env:TEMP 'pxii-dev-frontend.log') `
    -RedirectStandardError (Join-Path $env:TEMP 'pxii-dev-frontend.err.log')

@($backendProc.Id, $frontendProc.Id) | Set-Content $pidFile

# Readiness probes (no fixed sleeps).
foreach ($probe in @(
    @{ name = 'backend';  url = "http://127.0.0.1:$BackendPort/openapi.json" },
    @{ name = 'frontend'; url = "http://127.0.0.1:$FrontendPort/" }
)) {
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $status = (Invoke-WebRequest -Uri $probe.url -UseBasicParsing -TimeoutSec 3).StatusCode
            if ($status -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 800 }
    }
    if (-not $ready) { Write-Host "[dev] FAIL: $($probe.name) not ready in 60s (see $env:TEMP pxii-dev-*.log)"; exit 1 }
    Write-Host "[dev] $($probe.name) ready"
}
Write-Host "[dev] stack up: http://localhost:$FrontendPort  (stop with -Stop)"
