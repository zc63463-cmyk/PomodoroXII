# Run the Task Space Playwright suite against a CONTROLLED backend + frontend
# stack with explicit, conflict-free ports (CI gate for Wave 2B Task E).
#
# The script NEVER touches services already running on :3000/:5173/:8011.
# It starts its own uvicorn backend on a fresh temp data root and its own
# `next dev` frontend, polls real readiness (no fixed sleeps), runs Playwright,
# preserves trace/screenshot/video artifacts on failure, and tears everything
# down.
#
# Usage (from repo root or frontend dir):
#   powershell -NoProfile -ExecutionPolicy Bypass -File frontend/scripts/run-task-space-e2e.ps1
# Options:
#   -BackendPort <int>   backend port (default 8022)
#   -FrontendPort <int>  frontend port (default 4190)
#   -KeepServers         leave servers running after the run (debugging)
#   -NoBrowserInstall    skip `playwright install chromium` (already installed)

param(
    [int]$BackendPort = 8022,
    [int]$FrontendPort = 4190,
    [switch]$KeepServers,
    [switch]$NoBrowserInstall
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $frontendDir '..'))
$backendDir = Join-Path $repoRoot 'backend'

function Fail-Fast([string]$message) {
    Write-Host "[e2e] FAIL: $message" -ForegroundColor Red
    Stop-Servers
    exit 1
}

$script:startedProcesses = @()

function Stop-Servers {
    foreach ($proc in $script:startedProcesses) {
        if ($proc -and -not $proc.HasExited) {
            taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
        }
    }
    Write-Host '[e2e] servers stopped'
}

# --- 1. Verify the target ports are actually free --------------------------
foreach ($port in @($BackendPort, $FrontendPort)) {
    $used = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $port }
    if ($used) {
        Fail-Fast "port $port is already in use (PID $($used.OwningProcess)); choose a free -BackendPort/-FrontendPort"
    }
}

# --- 2. Fresh backend data root --------------------------------------------
$dataRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pxii-e2e-$PID"
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
Write-Host "[e2e] backend data root: $dataRoot"

# --- 3. Locate the backend runner ------------------------------------------
# Prefer the project venv (uv sync in CI creates it) — `uv run` on Windows may
# resolve to the uv-managed cpython instead, which can be missing project deps.
$backendRunner = $null
if (Test-Path (Join-Path $backendDir '.venv\Scripts\python.exe')) {
    $backendRunner = Join-Path $backendDir '.venv\Scripts\python.exe'
    $backendArgs = @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$BackendPort")
} elseif (Get-Command uv -ErrorAction SilentlyContinue) {
    $backendRunner = 'uv'
    $backendArgs = @('run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$BackendPort")
} else {
    Fail-Fast 'neither backend/.venv python nor `uv` is available'
}

# --- 4. Initialize the fresh meta DB + start the backend --------------------
# The runtime requires the meta.db FILE and its alembic version table to exist
# before preflight (it refuses to own first-time schema creation).  Create the
# empty version table so the runtime's authority-bound `upgrade_under_lease`
# can migrate it to head at startup.
$backendLog = Join-Path $dataRoot 'backend.log'
$backendErr = Join-Path $dataRoot 'backend.err.log'
New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot 'spaces') | Out-Null
& $backendRunner -c "import sqlite3; sqlite3.connect(r'$dataRoot\meta.db').execute('CREATE TABLE alembic_version_meta (version_num VARCHAR(32) NOT NULL)').connection.commit()"
if ($LASTEXITCODE -ne 0) { Fail-Fast 'failed to pre-create the meta version table' }
$oldDataRoot = $env:POMODOROXII_DATA_ROOT
$oldBackup = $env:POMODOROXII_BACKUP_ENABLED
$oldDbUrl = $env:POMODOROXII_DATABASE_URL
$oldSpaces = $env:POMODOROXII_SPACES_DATA_DIR
# Settings requires a canonical layout: database_url == data_root/meta.db and
# spaces_data_dir == data_root/spaces — set all three together.
$env:POMODOROXII_DATA_ROOT = $dataRoot
$env:POMODOROXII_DATABASE_URL = "sqlite+aiosqlite:///$($dataRoot -replace '\\','/')/meta.db"
$env:POMODOROXII_SPACES_DATA_DIR = Join-Path $dataRoot 'spaces'
$env:POMODOROXII_BACKUP_ENABLED = 'false'
$backendProc = $null
try {
    $backendProc = Start-Process -FilePath $backendRunner -ArgumentList $backendArgs `
        -WorkingDirectory $backendDir -PassThru -NoNewWindow `
        -RedirectStandardOutput $backendLog -RedirectStandardError $backendErr
} finally {
    $env:POMODOROXII_DATA_ROOT = $oldDataRoot
    $env:POMODOROXII_BACKUP_ENABLED = $oldBackup
    $env:POMODOROXII_DATABASE_URL = $oldDbUrl
    $env:POMODOROXII_SPACES_DATA_DIR = $oldSpaces
}
$script:startedProcesses += $backendProc
Write-Host "[e2e] backend started pid=$($backendProc.Id) on 127.0.0.1:$BackendPort"

# --- 5. Start the frontend (Next dev) ---------------------------------------
$frontLog = Join-Path $dataRoot 'frontend.log'
$frontErr = Join-Path $dataRoot 'frontend.err.log'
$oldTarget = $env:TASK_SPACE_API_TARGET
$env:TASK_SPACE_API_TARGET = "http://127.0.0.1:$BackendPort"
$frontendProc = $null
try {
    # npm on Windows is npm.cmd; Start-Process cannot exec .cmd directly.
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
    if (-not $npm) { Fail-Fast 'npm.cmd not found' }
    $frontendProc = Start-Process -FilePath $npm `
        -ArgumentList @('run', 'dev', '--', '--port', "$FrontendPort") `
        -WorkingDirectory $frontendDir -PassThru -NoNewWindow `
        -RedirectStandardOutput $frontLog -RedirectStandardError $frontErr
} finally {
    $env:TASK_SPACE_API_TARGET = $oldTarget
}
$script:startedProcesses += $frontendProc
Write-Host "[e2e] frontend started pid=$($frontendProc.Id) on 127.0.0.1:$FrontendPort"

function Wait-Ready([string]$name, [scriptblock]$probe, [int]$timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($backendProc.HasExited -or $frontendProc.HasExited) {
            Fail-Fast "$name process exited before becoming ready (see logs in $dataRoot)"
        }
        try {
            & $probe | Out-Null
            Write-Host "[e2e] $name is ready"
            return
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    Fail-Fast "$name did not become ready within ${timeoutSeconds}s (see logs in $dataRoot)"
}

# --- 6. Wait for real readiness --------------------------------------------
# Password must be 12-64 bytes (backend validation).
$script:e2ePassword = 'e2e-pass-1234'
Wait-Ready 'backend' {
    $setup = Invoke-WebRequest -Uri "http://127.0.0.1:$BackendPort/api/v1/auth/setup" `
        -Method POST -ContentType 'application/json' -Body "{""password"":""$script:e2ePassword""}" `
        -UseBasicParsing -ErrorAction Stop
    if ($setup.StatusCode -notin 201, 409, 429) { throw "backend setup status $($setup.StatusCode)" }
} 60

Wait-Ready 'frontend' {
    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$FrontendPort/tasks" -UseBasicParsing -ErrorAction Stop
    if ($page.StatusCode -ne 200) { throw "frontend status $($page.StatusCode)" }
} 180

# --- 7. Install the Playwright browser if missing ---------------------------
if (-not $NoBrowserInstall) {
    Push-Location $frontendDir
    try {
        npx playwright install chromium 2>&1 | Out-Null
    } finally {
        Pop-Location
    }
}

# --- 8. Run the Playwright suite --------------------------------------------
$env:E2E_BACKEND_BASE = "http://127.0.0.1:$BackendPort"
$env:E2E_FRONTEND_BASE = "http://127.0.0.1:$FrontendPort"
$env:E2E_PASSWORD = $script:e2ePassword

Push-Location $frontendDir
try {
    npx playwright test e2e/task-space.spec.ts e2e/focus-offline.spec.ts --reporter=list
    $testExit = $LASTEXITCODE
} finally {
    Pop-Location
}

# --- 9. Preserve artifacts and report ----------------------------------------
$resultsDir = Join-Path $frontendDir 'test-results'
$reportDir = Join-Path $frontendDir 'playwright-report'
Write-Host "[e2e] test exit code: $testExit"
Write-Host "[e2e] artifacts:"
Write-Host "      test-results : $resultsDir"
Write-Host "      playwright-report : $reportDir"
Write-Host "      server logs  : $dataRoot"

# --- 10. Teardown ------------------------------------------------------------
if ($KeepServers) {
    Write-Host "[e2e] -KeepServers: leaving servers running; data root $dataRoot"
    exit $testExit
}
Stop-Servers
exit $testExit
