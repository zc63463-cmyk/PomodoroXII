<#
  PomodoroXII - export working tree + portable toolchain to a (removable) drive.

  Additive by design: it never deletes anything on the destination.

  What it stages under <DriveRoot>\<DestParent>\<DestName>
  (default: <DriveRoot>\Dev\PomodoroXII - one tidy container keeps the drive root clean) :

    - the full working tree (including .git, docs, data, frontend\node_modules)
    - .portable\uv.exe              standalone uv binary
    - .portable\uv-python\<ver>     the CPython the backend venv was built on
    - .portable\uv-cache\           warmed wheel cache (offline venv rebuild)
    - .portable\node\               portable Node.js (npm included)
    - .portable\backups\            git bundle --all snapshot of this repo
    - .portable\PREV_ROOT.txt       source root; bootstrap.ps1 uses it to re-anchor
    - .portable\requirements.lock.txt  frozen backend requirements (audit / fallback)

  Typical use:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\export-to-drive.ps1 -DriveRoot F:\
    powershell ... -DriveRoot F:\ -DestParent Projects    # custom container folder name
    powershell ... -DriveRoot F:\ -DestParent ''          # put the repo directly at the drive root

  Then on the target machine:
    scripts\portable\bootstrap.ps1     (once per machine / drive-letter change)
    scripts\portable\doctor.ps1
    scripts\portable\start-dev.ps1
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$DriveRoot,

    [string]$DestParent = 'Dev',
    [string]$DestName = 'PomodoroXII',
    [string]$NodeSource = '',
    [switch]$Lean,          # skip demos / archived projects / agent state (smaller copy)
    [switch]$WithScratch,   # also copy temp\ and tmp\ scratch dirs
    [switch]$SkipToolchain,
    [switch]$SkipCacheWarm,
    [switch]$SkipBundle,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

function Say($m)  { Write-Host $m }
function Head($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan; Write-Host ('-' * 60) -ForegroundColor Cyan }
function Ok($m)   { Write-Host ('  [ok]   ' + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ('  [warn] ' + $m) -ForegroundColor Yellow }
function Die($m)  { Write-Host ('  [FAIL] ' + $m) -ForegroundColor Red; exit 1 }

$Src = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # <repo>
$ts  = Get-Date -Format 'yyyyMMdd-HHmmss'

Head 'PomodoroXII export to drive'
Say ('  source     : ' + $Src)

if (-not (Test-Path -LiteralPath $DriveRoot)) { Die ('drive root not found: ' + $DriveRoot) }
$resolved = (Resolve-Path -LiteralPath $DriveRoot).Path
if ($DestParent) { $DestParent = $DestParent.Trim() }
$DestTarget = $resolved
if ($DestParent) { $DestTarget = Join-Path $resolved $DestParent }
$Dest = Join-Path $DestTarget $DestName
Say ('  destination: ' + $Dest)

if ($Dest.StartsWith($Src, [System.StringComparison]::OrdinalIgnoreCase)) { Die 'destination must not live inside the source tree' }

$dl = $resolved.Substring(0, 1)
$drv = Get-PSDrive -Name $dl -ErrorAction SilentlyContinue
if ($drv) {
    $freeGB = [math]::Round(($drv.Free / 1GB), 1)
    $needGB = 3
    if (-not $Lean) { $needGB = 6 }
    Say ('  free space : ' + $freeGB + ' GB (estimate needed: ~' + $needGB + ' GB)')
    if ($freeGB -lt $needGB) { Warn 'free space looks tight; continue at your own risk' }
}
if (Test-Path -LiteralPath $Dest) { Warn 'destination exists - robocopy will be additive (nothing deleted)' }

# ---------------------------------------------------------------- robocopy plan
$xd = @(
    '.next', '.next-broken', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache',
    '.codex-logs', '.run-logs', '.uploads', '.playwright-cli',
    'pytest-cache-files-*', '.portable',
    # regenerable test/build artifacts + local caches (measured 2026-09-24:
    # backend/.test-artifacts ~1.4GB; excluded by default, docs say why)
    '.tmp', '.pytest-tmp', '.test-artifacts', 'pomodoroxii-test-artifacts',
    '.uv-cache', '.uv-cache-run',
    # machine-local agent/IDE state (measured 2026-09-24: .worktrees ~12.3GB /
    # 729k files of stale checkout copies; .trae ~1.6GB editor venv). Both are
    # gitignored local state, fully derivable from .git on the target machine.
    '.worktrees', '.trae'
)
if (-not $WithScratch) {
    $xd += (Join-Path $Src 'temp')
    $xd += (Join-Path $Src 'tmp')
}
if ($Lean) {
    $xd += @('board-demo', 'knowledge-canvas-demo', 'quick-notes-token-demo',
             'PomodoroXII-rebuild', 'pomodoroXii-deep-review',
             'out', '.codex', '.codebuddy', '.agents', '.archify',
             '.archify-delivery-Euicus', '.codebase-memory', '.data.runtime',
             '.kc-stage', '.git-corrupt-20260912')
}
$xf = @('*.log', 'tmp-*.txt', 'nul', '*--title', '*.pid', '*.pyc')

$log = Join-Path $env:TEMP ('pxii-export-' + $ts + '.log')
$rcMain = @($Src, $Dest, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/MT:16',
            '/NFL', '/NDL', '/NP', '/BYTES', '/XD')
$rcMain += $xd
$rcMain += '/XF'
$rcMain += $xf
$rcMain += ('/LOG+:' + $log)
$rcMain += '/TEE'

if ($WhatIf) {
    Head 'WHATIF - planned actions (nothing executed)'
    Say ('  robocopy ' + ($rcMain -join ' '))
    Say '  + stage .portable toolchain (uv / uv-python / node / uv-cache / bundle)'
    exit 0
}

# create the container folder (e.g. <Drive>:\Dev) when needed
if (-not (Test-Path -LiteralPath $DestTarget)) {
    New-Item -ItemType Directory -Force -Path $DestTarget | Out-Null
    Ok ('container folder created: ' + $DestTarget)
}

# ---------------------------------------------------------------- 1. main tree
Head '1/4  copy working tree (code + docs + data + .git + node_modules)'
Say '  (this can take several minutes; robocopy summary below, log: ' + $log + ')'
& robocopy @rcMain
$rc = $LASTEXITCODE
# rc and counters are unreliable under /MT (observed 2026-09-24: rc=9 with an
# empty error log and self-contradictory dir counters). Decide by log content:
# a real failure leaves a "0x000000NN" / "Access is denied" line.
$hadErrors = $false
try {
    $logText = Get-Content -LiteralPath $log -Encoding Default -Raw -ErrorAction SilentlyContinue
    if ($logText -and ($logText -match '0x[0-9A-Fa-f]{8}|Access is denied|ERROR\s+[0-9]+')) { $hadErrors = $true }
} catch {}
if ($hadErrors) { Die ('robocopy logged real errors (rc=' + $rc + '); see ' + $log) }
if ($rc -ge 8) { Warn ('robocopy rc=' + $rc + ' but no error lines in log (known /MT counter quirk) - continuing') }
else { Ok ('tree copied (robocopy rc=' + $rc + ')') }

# ---------------------------------------------------------------- 2. toolchain
$Portable = Join-Path $Dest '.portable'
$toolchainOk = $true
if ($SkipToolchain) {
    Head '2/4  toolchain staging SKIPPED (-SkipToolchain)'
} else {
    Head '2/4  stage portable toolchain under .portable'
    New-Item -ItemType Directory -Force -Path $Portable | Out-Null

    # 2a. uv.exe
    $uvSrc = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (-not (Test-Path -LiteralPath $uvSrc)) {
        $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
        if ($uvCmd) { $uvSrc = $uvCmd.Source }
    }
    $uvDst = Join-Path $Portable 'uv.exe'
    if ($uvSrc -and (Test-Path -LiteralPath $uvSrc)) {
        Copy-Item -LiteralPath $uvSrc -Destination $uvDst -Force
        Ok ('uv.exe staged (' + (& $uvDst --version) + ')')
    } else {
        Warn 'uv.exe not found on this machine; cache warm and rebuild fallback will be unavailable'
        $toolchainOk = $false
    }

    # 2b. uv-managed CPython (the exact interpreter the backend venv uses)
    $venvPy = Join-Path $Src 'backend\.venv\Scripts\python.exe'
    $pyVer = ''
    if (Test-Path -LiteralPath $venvPy) {
        try { $pyVer = (& $venvPy -c "import sys;print('{0}.{1}.{2}'.format(*sys.version_info[:3]))").Trim() } catch { $pyVer = '' }
    }
    $pyDirName = ''
    $pySrc = ''
    if ($pyVer) { $pyDirName = 'cpython-' + $pyVer + '-windows-x86_64-none' }
    if ($pyDirName) { $pySrc = Join-Path $env:APPDATA ('uv\python\' + $pyDirName) }
    if (-not $pySrc -or -not (Test-Path -LiteralPath $pySrc)) {
        $pyRoot = Join-Path $env:APPDATA 'uv\python'
        $cand = $null
        if (Test-Path -LiteralPath $pyRoot) {
            $cand = Get-ChildItem -LiteralPath $pyRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'cpython-3.13*-windows-x86_64-none' } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
        if ($cand) { $pySrc = $cand.FullName; $pyDirName = $cand.Name } else { $pySrc = '' }
    }
    if ($pySrc) {
        $pyDst = Join-Path (Join-Path $Portable 'uv-python') $pyDirName
        New-Item -ItemType Directory -Force -Path (Join-Path $Portable 'uv-python') | Out-Null
        & robocopy $pySrc $pyDst /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:16 /NFL /NDL /NP /BYTES ('/LOG+:' + $log)
        if (Test-Path -LiteralPath (Join-Path $pyDst 'python.exe')) { Ok ('CPython staged: ' + $pyDirName) }
        else { Warn ('CPython copy incomplete (robocopy rc=' + $LASTEXITCODE + ')'); $toolchainOk = $false }
    } else {
        Warn 'uv-managed CPython not found; venv repair will not be possible on target'
        $toolchainOk = $false
    }

    # 2c. portable Node.js
    if (-not $NodeSource) { $NodeSource = Join-Path $env:ProgramFiles 'nodejs' }
    if (Test-Path -LiteralPath (Join-Path $NodeSource 'node.exe')) {
        $nodeDst = Join-Path $Portable 'node'
        & robocopy $NodeSource $nodeDst /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:16 /NFL /NDL /NP /BYTES ('/LOG+:' + $log)
        if (Test-Path -LiteralPath (Join-Path $nodeDst 'node.exe')) { Ok ('Node.js staged from ' + $NodeSource + ' (' + (& (Join-Path $NodeSource 'node.exe') -v) + ')') }
        else { Warn ('node copy incomplete (robocopy rc=' + $LASTEXITCODE + ')') }
    } else {
        Warn ('Node.js source not found: ' + $NodeSource + ' (use -NodeSource <dir>)')
    }

    # 2d. metadata + PREV_ROOT
    Set-Content -LiteralPath (Join-Path $Portable 'PREV_ROOT.txt') -Value $Src -Encoding Ascii
    $uvVer = 'missing'
    if ($uvSrc) { try { $uvVer = (& $uvSrc --version) } catch { $uvVer = 'unknown' } }
    $meta = @(
        'exported_at  = ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        'source_root  = ' + $Src
        'dest_root    = ' + $Dest
        'python_ver   = ' + $pyVer
        'uv_ver       = ' + $uvVer
    )
    Set-Content -LiteralPath (Join-Path $Portable 'TOOLCHAIN.txt') -Value $meta -Encoding Ascii
    Ok 'PREV_ROOT.txt + TOOLCHAIN.txt written'
}

# ---------------------------------------------------------------- 3. cache warm
if ($SkipCacheWarm -or -not $toolchainOk) {
    Head '3/4  uv cache warm + offline verification SKIPPED'
    if (-not $toolchainOk) { Warn 'toolchain incomplete; skipping cache warm' }
} else {
    Head '3/4  warm uv cache (offline rebuild insurance) + verify offline install'
    $scratch = Join-Path $env:TEMP ('pxii-warm-' + $ts)
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    try {
        Copy-Item -LiteralPath (Join-Path $Dest 'backend\pyproject.toml') -Destination $scratch
        Copy-Item -LiteralPath (Join-Path $Dest 'backend\uv.lock')          -Destination $scratch
        $env:UV_CACHE_DIR = Join-Path $Portable 'uv-cache'
        $env:UV_PYTHON_INSTALL_DIR = Join-Path $Portable 'uv-python'
        [System.Environment]::SetEnvironmentVariable('UV_OFFLINE', [NullString]::Value)

        $uvDst = Join-Path $Portable 'uv.exe'
        Push-Location $scratch
        try {
            $req = Join-Path $scratch 'requirements.lock.txt'
            & $uvDst export --locked --extra dev --no-emit-project --no-hashes -o $req
            if ($LASTEXITCODE -ne 0) { throw 'uv export failed (lock stale? run uv lock in backend first)' }
            Ok 'requirements.lock.txt generated'

            Say '  warming cache (downloads wheels for backend[dev])...'
            & $uvDst venv --python (Join-Path $pySrc 'python.exe') warm1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'uv venv (warm1) failed' }
            & $uvDst pip install --python (Join-Path $scratch 'warm1\Scripts\python.exe') -r $req
            if ($LASTEXITCODE -ne 0) { throw 'uv pip install (online warm) failed' }
            Ok 'cache warmed'

            Say '  verifying OFFLINE install from cache (fresh venv, network forbidden)...'
            & $uvDst venv --python (Join-Path $pySrc 'python.exe') warm2 | Out-Null
            & $uvDst pip install --offline --python (Join-Path $scratch 'warm2\Scripts\python.exe') -r $req
            if ($LASTEXITCODE -ne 0) { Warn 'OFFLINE verification FAILED - cache may be incomplete (target machine will need network)' }
            else { Ok 'offline install verified from warmed cache' }

            Copy-Item -LiteralPath $req -Destination (Join-Path $Portable 'requirements.lock.txt') -Force
        } finally {
            Pop-Location
        }
    } catch {
        Warn ('cache warm skipped: ' + $_.Exception.Message)
    } finally {
        [System.Environment]::SetEnvironmentVariable('UV_CACHE_DIR', [NullString]::Value)
        [System.Environment]::SetEnvironmentVariable('UV_PYTHON_INSTALL_DIR', [NullString]::Value)
        try { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# ---------------------------------------------------------------- 4. git bundle
if ($SkipBundle -or -not (Test-Path -LiteralPath (Join-Path $Src '.git'))) {
    Head '4/4  git bundle SKIPPED'
} else {
    Head '4/4  git bundle --all (history snapshot)'
    $bk = Join-Path (Join-Path $Dest '.portable') 'backups'
    New-Item -ItemType Directory -Force -Path $bk | Out-Null
    $bundle = Join-Path $bk ('repo-all-' + $ts + '.bundle')
    Push-Location $Src
    try {
        & git bundle create $bundle --all 2>&1 | Select-Object -Last 3
        if ($LASTEXITCODE -ne 0) { Warn 'git bundle failed' } else { Ok ('bundle: ' + $bundle) }
    } catch { Warn ('git bundle failed: ' + $_.Exception.Message) } finally { Pop-Location }
}

# ---------------------------------------------------------------- summary
Head 'done'
Say ('  destination : ' + $Dest)
Say ('  log         : ' + $log)
Say ''
Say '  NEXT (on the target machine, from the repo folder):'
Say '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\bootstrap.ps1'
Say '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\doctor.ps1'
Say '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\start-dev.ps1 start'
Say ''
