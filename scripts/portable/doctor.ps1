<#
  PomodoroXII - portable environment doctor (read-only).
  Run after bootstrap, and any time something feels off.

  Exit code: 0 = no FAIL, 1 = at least one FAIL.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\doctor.ps1
#>
param()

$ErrorActionPreference = 'Continue'
$Root     = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Portable = Join-Path $Root '.portable'
$script:fails = 0
$script:warns = 0

function Head($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan; Write-Host ('-' * 60) -ForegroundColor Cyan }
function Ok($m)   { Write-Host ('  [PASS] ' + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ('  [WARN] ' + $m) -ForegroundColor Yellow; $script:warns++ }
function Bad($m)  { Write-Host ('  [FAIL] ' + $m) -ForegroundColor Red; $script:fails++ }
function Info($m) { Write-Host ('  [info] ' + $m) -ForegroundColor Gray }

Head 'PomodoroXII portable doctor'
Info ('repo root : ' + $Root)
Info ('drive     : ' + $Root.Substring(0, 2))
Info ('time      : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
if ($Root.Length -gt 60) { Warn ('repo path is long (' + $Root.Length + ' chars); deep node_modules paths may hit the 260-char limit') }

# ---------------------------------------------------------------- layout
Head '1. layout'
foreach ($d in @('backend', 'frontend', 'scripts', 'data')) {
    $p = Join-Path $Root $d
    if (Test-Path -LiteralPath $p) { Ok ($d + '\ present') } else { Bad ($d + '\ MISSING') }
}
if (Test-Path -LiteralPath (Join-Path $Root '.git')) { Ok '.git present' } else { Bad '.git missing (not a git checkout)' }

# ---------------------------------------------------------------- backend env
Head '2. backend\.env vs current root'
$envFile = Join-Path $Root 'backend\.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Bad 'backend\.env missing'
} else {
    $fwd = (Join-Path $Root 'data').Replace('\', '/')
    $expect = @{
        'POMODOROXII_DATABASE_URL'    = 'sqlite+aiosqlite:///' + $fwd + '/meta.db'
        'POMODOROXII_SPACES_DATA_DIR' = $fwd + '/spaces'
        'POMODOROXII_DATA_ROOT'       = $fwd
    }
    $vals = @{}
    foreach ($line in ([System.IO.File]::ReadAllText($envFile, [System.Text.Encoding]::UTF8)) -split "`r?`n") {
        $m = [regex]::Match($line, '^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$')
        if ($m.Success) { $vals[$m.Groups[1].Value] = $m.Groups[2].Value }
    }
    foreach ($k in $expect.Keys) {
        if (-not $vals.ContainsKey($k)) { Bad ($k + ' missing from backend\.env') }
        elseif ($vals[$k] -ne $expect[$k]) { Bad ($k + ' points elsewhere: ' + $vals[$k]) }
        else { Ok ($k + ' ok') }
    }
}

# 2b. Meta registry (spaces.db_path / notes_dir stored absolute inside meta.db)
$fixScript = Join-Path $Root 'scripts\portable\fix_registry.py'
$pyRun = $null
$pyRootDir = Join-Path $Portable 'uv-python'
if (Test-Path -LiteralPath $pyRootDir) {
    $pyd = Get-ChildItem -LiteralPath $pyRootDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'cpython-*-windows-x86_64-none' } | Select-Object -First 1
    if ($pyd) { $cand = Join-Path $pyd.FullName 'python.exe'; if (Test-Path -LiteralPath $cand) { $pyRun = $cand } }
}
if (-not $pyRun) { $cand2 = Join-Path $Root 'backend\.venv\Scripts\python.exe'; if (Test-Path -LiteralPath $cand2) { $pyRun = $cand2 } }
if ((Test-Path -LiteralPath $fixScript) -and $pyRun) {
    $regOut = & $pyRun $fixScript --root $Root --check 2>&1
    $regRc = $LASTEXITCODE
    if ($regRc -eq 0) { Ok ('Meta registry: ' + (($regOut | Select-Object -Last 1) -replace '^REGISTRY OK: ', '')) }
    elseif ($regRc -eq 1) {
        Bad 'Meta registry paths are stale -> run bootstrap.ps1'
        foreach ($l in $regOut) { Info ("  " + $l) }
    } else { Warn ('Meta registry check failed to run (rc=' + $regRc + ')') }
} else { Warn 'Meta registry check skipped (no python runner / fix_registry.py)' }

# ---------------------------------------------------------------- toolchain
Head '3. portable toolchain (.portable)'
if (Test-Path -LiteralPath $Portable) {
    $uvP = Join-Path $Portable 'uv.exe'
    if (Test-Path -LiteralPath $uvP) { Ok ('uv.exe  ' + (& $uvP --version)) } else { Warn 'uv.exe not staged' }
    $pyDir = Get-ChildItem -LiteralPath (Join-Path $Portable 'uv-python') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'cpython-*-windows-x86_64-none' } | Select-Object -First 1
    if ($pyDir) { Ok ('python  ' + $pyDir.Name) } else { Warn 'uv-python not staged' }
    $nodeDir = Get-ChildItem -LiteralPath $Portable -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'node*' } | Select-Object -First 1
    if ($nodeDir) { Ok ('node    ' + $nodeDir.Name) } else { Warn 'portable node not staged' }
    if (Test-Path -LiteralPath (Join-Path $Portable 'uv-cache')) { Ok 'uv-cache staged' } else { Warn 'uv-cache not staged (offline venv rebuild unavailable)' }
    $bk = Get-ChildItem -LiteralPath (Join-Path $Portable 'backups') -Filter '*.bundle' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bk) { Ok ('git bundle ' + $bk.Name) } else { Info 'no git bundle staged' }
} else {
    Warn '.portable missing - repo must rely on system toolchain'
}

# ---------------------------------------------------------------- venv
Head '4. backend\.venv'
$venv   = Join-Path $Root 'backend\.venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$cfg    = Join-Path $venv 'pyvenv.cfg'
if (-not (Test-Path -LiteralPath $venvPy)) {
    Bad 'venv python missing - run bootstrap.ps1'
} else {
    $pyv = & $venvPy -c "import sys;print(sys.version.split()[0])" 2>&1
    if ($LASTEXITCODE -eq 0) { Ok ('venv python ' + $pyv) } else { Bad ('venv python broken: ' + ($pyv | Select-Object -First 1)) }
    if (Test-Path -LiteralPath $cfg) {
        $venvHome = ([regex]::Match([System.IO.File]::ReadAllText($cfg), '(?m)^home\s*=\s*(.+)$')).Groups[1].Value.Trim()
        if ($venvHome -and (Test-Path -LiteralPath $venvHome)) { Ok ('pyvenv home resolves: ' + $venvHome) }
        else { Bad ('pyvenv home does NOT resolve: ' + $venvHome + '  -> run bootstrap.ps1') }
    }
    $pth = Join-Path $venv 'Lib\site-packages\_pomodoroxii_backend_editable.pth'
    $map = Join-Path $venv 'Lib\site-packages\_pomodoroxii_backend_editable.py'
    $mapOk = $true
    if (Test-Path -LiteralPath $pth) {
        $t = [System.IO.File]::ReadAllText($pth, [System.Text.Encoding]::UTF8)
        if (-not $t.Contains($Root)) { $mapOk = $false; Bad 'editable .pth is stale (points elsewhere) -> run bootstrap.ps1' }
    } else { Warn 'editable mapping .pth not found (project may be installed in non-editable mode)' }
    if (Test-Path -LiteralPath $map) {
        $t2 = [System.IO.File]::ReadAllText($map, [System.Text.Encoding]::UTF8)
        if (-not $t2.Contains($Root.Replace('\', '\\'))) { $mapOk = $false; Bad 'editable mapping .py is stale (escaped paths) -> run bootstrap.ps1' }
    }
    if ($mapOk) { Ok 'editable mappings point at this root' }
    Push-Location (Join-Path $Root 'backend')
    try {
        $probe = & $venvPy -c "import app; print(app.__file__)" 2>&1
        if ($LASTEXITCODE -eq 0) { Ok ('import app -> ' + ($probe | Select-Object -First 1)) } else { Bad ('import app FAILED: ' + (($probe | Select-Object -First 2) -join ' | ')) }
        $native = & $venvPy -c "import pomodoroxii_native; print('native-ok')" 2>&1
        if ($LASTEXITCODE -eq 0) { Ok 'import pomodoroxii_native ok' } else { Warn ('pomodoroxii_native not importable (VFS extension absent?): ' + (($native | Select-Object -First 1))) }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- node / frontend
Head '5. node + frontend'
$pNode = $null
if (Test-Path -LiteralPath $Portable) {
    $nd = Get-ChildItem -LiteralPath $Portable -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'node*' } | Select-Object -First 1
    if ($nd -and (Test-Path -LiteralPath (Join-Path $nd.FullName 'node.exe'))) { $pNode = Join-Path $nd.FullName 'node.exe' }
}
$nodeExe = $pNode
if (-not $nodeExe) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $nodeExe = $c.Source } }
if ($nodeExe) {
    $nv = & $nodeExe -v
    if ($nv -match '^v(\d+)' -and [int]$Matches[1] -ge 22) { Ok ('node ' + $nv + '  (' + $nodeExe + ')') }
    else { Warn ('node ' + $nv + ' is older than v22') }
} else { Bad 'node not found (stage .portable\node or install Node.js 22+)' }
if (Test-Path -LiteralPath (Join-Path $Root 'frontend\node_modules\next\package.json')) { Ok 'frontend\node_modules ok' }
else { Bad 'frontend\node_modules incomplete - run bootstrap.ps1 -RepairNode' }

# ---------------------------------------------------------------- data
Head '6. data'
$meta = Join-Path $Root 'data\meta.db'
if (Test-Path -LiteralPath $meta) {
    $sz = [math]::Round(((Get-Item -LiteralPath $meta).Length / 1KB), 1)
    Ok ('meta.db present (' + $sz + ' KB)')
} else { Bad 'data\meta.db missing' }
$sp = Join-Path $Root 'data\spaces'
if (Test-Path -LiteralPath $sp) {
    $dirs = Get-ChildItem -LiteralPath $sp -Directory -ErrorAction SilentlyContinue
    $dbs = Get-ChildItem -LiteralPath $sp -Recurse -Filter 'space.db' -ErrorAction SilentlyContinue
    Ok ($dirs.Count.ToString() + ' space folder(s), ' + $dbs.Count.ToString() + ' space.db file(s)')
    if ($dbs) {
        $newest = $dbs | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        Info ('newest space.db: ' + $newest.FullName.Replace($Root, '.') + ' @ ' + $newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
    }
} else { Warn 'data\spaces missing (first start will create it)' }

# ---------------------------------------------------------------- alembic tripwire
Head '7. alembic tripwire (task_space preflight vs migration head)'
$preflight = Join-Path $Root 'backend\app\task_space\migration_preflight.py'
$versions  = Join-Path $Root 'backend\alembic_space\versions'
if ((Test-Path -LiteralPath $preflight) -and (Test-Path -LiteralPath $versions)) {
    $m = [regex]::Match([System.IO.File]::ReadAllText($preflight, [System.Text.Encoding]::UTF8), 'TASK_SPACE_TARGET_HEAD\s*=\s*"([^"]+)"')
    if (-not $m.Success) { Warn 'could not parse TASK_SPACE_TARGET_HEAD' }
    else {
        $target = $m.Groups[1].Value
        $found = $false
        foreach ($f in Get-ChildItem -LiteralPath $versions -Filter '*.py' -ErrorAction SilentlyContinue) {
            if ([System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8) -match ('revision[^=]*=\s*"' + [regex]::Escape($target) + '"')) { $found = $true; break }
        }
        if ($found) { Ok ('TASK_SPACE_TARGET_HEAD "' + $target + '" matches a migration file') }
        else { Bad ('TASK_SPACE_TARGET_HEAD "' + $target + '" has NO matching migration file - backend will refuse to start') }
    }
} else { Warn 'preflight / alembic_space not found' }

# ---------------------------------------------------------------- ports
Head '8. ports'
foreach ($p in @(8100, 3010)) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Warn ('port ' + $p + ' is LISTENING (pid ' + $c.OwningProcess + ') - a dev stack may already be up') }
    else { Ok ('port ' + $p + ' free') }
}

# ---------------------------------------------------------------- git
Head '9. git'
if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
    Push-Location $Root
    try {
        $br = & git rev-parse --abbrev-ref HEAD 2>&1
        $sb = & git status -sb 2>&1 | Select-Object -First 1
        $dirty = (& git status --porcelain 2>&1 | Measure-Object).Count
        $wt = (& git worktree list 2>&1 | Measure-Object).Count
        Ok ('branch: ' + $br)
        Info ('status: ' + $sb)
        if ($dirty -gt 0) { Warn ($dirty.ToString() + ' uncommitted change(s) - WIP travels with the drive, keep it that way') } else { Ok 'working tree clean' }
        Info ($wt.ToString() + ' worktree registration(s) (stale ones are pruned by bootstrap)')
    } catch { Warn ('git checks failed: ' + $_.Exception.Message) } finally { Pop-Location }
}

# ---------------------------------------------------------------- secrets hygiene
Head '10. hygiene'
$baks = Get-ChildItem -LiteralPath (Join-Path $Root 'backend') -Filter '.env.bak-*' -Force -ErrorAction SilentlyContinue
if ($baks) { Warn ('backend\.env.bak-* present (' + $baks.Count + ') - contains real keys; treat this drive as private') } else { Ok 'no .env.bak-* in backend' }
$drv = Get-PSDrive -Name $Root.Substring(0, 1) -ErrorAction SilentlyContinue
if ($drv) { Info ('drive free space: ' + [math]::Round(($drv.Free / 1GB), 1) + ' GB') }

# ---------------------------------------------------------------- summary
Head 'summary'
if ($script:fails -eq 0) {
    Write-Host ('  RESULT: OK  (' + $script:warns + ' warning(s))') -ForegroundColor Green
    exit 0
} else {
    Write-Host ('  RESULT: ' + $script:fails + ' FAIL(s), ' + $script:warns + ' warning(s)') -ForegroundColor Red
    exit 1
}
