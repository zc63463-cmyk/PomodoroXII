<#
  PomodoroXII - portable bootstrap.

  Re-anchor this checkout to the machine / drive it currently lives on.
  Idempotent: safe to run every time you switch computers or drive letters.

  Actions:
    1. rewrite backend\.env path trio to <repo>\data\...  (absolute, forward slashes)
    2. repair backend\.venv for the new location
         - pyvenv.cfg "home" -> <repo>\.portable\uv-python\<ver>
         - prefix-replace the old repo root inside the scikit-build editable
           mapping files (absolute paths were baked in at install time)
    3. prepend portable Node.js (.portable\node) to PATH for this session
    4. housekeeping: git worktree prune, drop stale .run-logs\*.pid

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\bootstrap.ps1
    ... -Check        # report what would change; write nothing
    ... -Offline      # venv rebuild path only: forbid network access
    ... -RepairNode   # run npm ci when frontend\node_modules looks incomplete
#>
param(
    [switch]$Check,
    [switch]$Offline,
    [switch]$RepairNode
)

$ErrorActionPreference = 'Stop'
$Root     = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # <repo>
$Portable = Join-Path $Root '.portable'
$script:warnings = New-Object System.Collections.Generic.List[string]
$script:changes  = New-Object System.Collections.Generic.List[string]

function Say($m)  { Write-Host $m }
function Head($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan; Write-Host ('-' * 60) -ForegroundColor Cyan }
function Ok($m)   { Write-Host ('  [ok]   ' + $m) -ForegroundColor Green }
function Info($m) { Write-Host ('  [info] ' + $m) -ForegroundColor Cyan }
function Warn($m) { Write-Host ('  [warn] ' + $m) -ForegroundColor Yellow; $script:warnings.Add($m) | Out-Null }
function Bad($m)  { Write-Host ('  [FAIL] ' + $m) -ForegroundColor Red; $script:warnings.Add($m) | Out-Null }

function Read-Text([string]$path) { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

Head 'PomodoroXII portable bootstrap'
Info ('repo root : ' + $Root)
Info ('drive     : ' + $Root.Substring(0, 2))
if (Test-Path -LiteralPath $Portable) { Ok '.portable toolchain present' }
else { Warn 'no .portable folder - venv repair/rebuild will be limited' }
if ($Check) { Info 'CHECK mode: nothing will be written' }
if ($Offline) { Info 'OFFLINE mode: network forbidden for rebuild steps' }

# ---------------------------------------------------------------- 1. backend\.env
Head '1/4  re-anchor backend\.env + Meta registry'
$envFile = Join-Path $Root 'backend\.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Warn 'backend\.env not found - restore it (or copy .env.bak-* back) before starting the backend'
} else {
    $fwd = (Join-Path $Root 'data').Replace('\', '/')
    $desired = [ordered]@{
        'POMODOROXII_DATABASE_URL'    = 'sqlite+aiosqlite:///' + $fwd + '/meta.db'
        'POMODOROXII_SPACES_DATA_DIR' = $fwd + '/spaces'
        'POMODOROXII_DATA_ROOT'       = $fwd
    }
    $text = Read-Text $envFile
    $nl = "`n"
    if ($text.Contains("`r`n")) { $nl = "`r`n" }
    $lines = $text -split "`r?`n"
    $out = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    foreach ($line in $lines) {
        $m = [regex]::Match($line, '^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$')
        if ($m.Success -and $desired.Contains($m.Groups[1].Value)) {
            $k = $m.Groups[1].Value
            $want = $desired[$k]
            if ($m.Groups[2].Value -ne $want) {
                $changes.Add($k + ' -> ' + $want) | Out-Null
                $line = $k + '=' + $want
            }
            $seen[$k] = $true
        }
        $out.Add($line) | Out-Null
    }
    foreach ($k in $desired.Keys) {
        if (-not $seen.ContainsKey($k)) {
            $changes.Add($k + ' (appended)') | Out-Null
            $out.Add($k + '=' + $desired[$k]) | Out-Null
        }
    }
    if ($changes.Count -eq 0) {
        Ok 'path trio already points at this root'
    } else {
        foreach ($c in $changes) { Ok ('will set: ' + $c) }
        if (-not $Check) { Write-Text $envFile ($out -join $nl); Ok 'backend\.env rewritten' }
    }
}

# 1b. re-anchor absolute paths stored inside data\meta.db (spaces.db_path / notes_dir)
$fixScript = Join-Path $Root 'scripts\portable\fix_registry.py'
$pyRun = $null
$pyRootDir = Join-Path $Portable 'uv-python'
if (Test-Path -LiteralPath $pyRootDir) {
    $pyd = Get-ChildItem -LiteralPath $pyRootDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'cpython-*-windows-x86_64-none' } | Select-Object -First 1
    if ($pyd) { $candPy = Join-Path $pyd.FullName 'python.exe'; if (Test-Path -LiteralPath $candPy) { $pyRun = $candPy } }
}
if (-not $pyRun) { $candPy2 = Join-Path $Root 'backend\.venv\Scripts\python.exe'; if (Test-Path -LiteralPath $candPy2) { $pyRun = $candPy2 } }
if ((Test-Path -LiteralPath $fixScript) -and $pyRun) {
    $fixArgs = @($fixScript, '--root', $Root)
    if ($Check) { $fixArgs += '--check' }
    $regOut = & $pyRun @fixArgs 2>&1
    $regRc = $LASTEXITCODE
    foreach ($line in $regOut) {
        if ("$line" -match '^REGISTRY') { Ok "$line" } else { Info "$line" }
    }
    if ($regRc -eq 1 -and $Check) { $changes.Add('Meta registry: stale rows found (run without -Check to fix)') | Out-Null }
    elseif ($regRc -ge 2) { Warn ('registry re-anchor failed (rc=' + $regRc + ')') }
} else {
    Warn 'registry re-anchor skipped (no python runner or fix_registry.py missing)'
}

# ---------------------------------------------------------------- 2. venv repair
Head '2/4  repair backend\.venv for this location'
$venv     = Join-Path $Root 'backend\.venv'
$cfg      = Join-Path $venv 'pyvenv.cfg'
$venvPy   = Join-Path $venv 'Scripts\python.exe'
$sites    = Join-Path $venv 'Lib\site-packages'
$pthFile  = Join-Path $sites '_pomodoroxii_backend_editable.pth'
$mapFile  = Join-Path $sites '_pomodoroxii_backend_editable.py'
$needsRebuild = $false
$pythonOk     = $false

$pyDir = $null
$pyRoot = Join-Path $Portable 'uv-python'
if (Test-Path -LiteralPath $pyRoot) {
    $pyDir = Get-ChildItem -LiteralPath $pyRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'cpython-*-windows-x86_64-none' } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $cfg)) {
    Warn 'backend\.venv\pyvenv.cfg missing - venv must be rebuilt'
    $needsRebuild = $true
} else {
    # 2a. pyvenv.cfg home
    if ($pyDir) {
        $t  = Read-Text $cfg
        $t2 = [regex]::Replace($t, '(?m)^home\s*=.*$', ('home = ' + $pyDir.FullName))
        if ($t2 -ne $t) {
            Ok ('pyvenv.cfg home -> ' + $pyDir.FullName)
            if (-not $Check) { Write-Text $cfg $t2 }
        } else { Ok 'pyvenv.cfg home already points at the portable python' }
    } else {
        Warn 'portable CPython not found under .portable\uv-python'
        $needsRebuild = $true
    }

    # 2b. re-anchor scikit-build editable mappings (absolute paths inside).
    # The .pth stores plain backslash paths; the mapping .py stores Python-escaped
    # double-backslash paths. Collect every candidate stale root from both files,
    # then replace all three spellings (plain / double-backslash / forward-slash).
    $candidates = New-Object System.Collections.Generic.List[string]
    $prevFile = Join-Path $Portable 'PREV_ROOT.txt'
    if (Test-Path -LiteralPath $prevFile) {
        $pr = (Read-Text $prevFile).Trim()
        if ($pr) { $candidates.Add($pr) | Out-Null }
    }
    if (Test-Path -LiteralPath $pthFile) {
        $m0 = [regex]::Match((Read-Text $pthFile), '(?m)^([A-Za-z]:\\[^\r\n]*)\\backend$')
        if ($m0.Success) { $candidates.Add($m0.Groups[1].Value) | Out-Null }
    }
    if (Test-Path -LiteralPath $mapFile) {
        $m1 = [regex]::Match((Read-Text $mapFile), '([A-Za-z]:\\\\[^''\r\n]*?)\\\\backend\\\\app\\\\')
        if ($m1.Success) { $candidates.Add(($m1.Groups[1].Value.Replace('\\', '\'))) | Out-Null }
    }
    $stale = @($candidates | Where-Object { $_ -and ($_ -ne $Root) } | Select-Object -Unique)
    if ($stale.Count -gt 0) {
        foreach ($cand in $stale) {
            $pairs = @(
                @($cand, $Root),
                @($cand.Replace('\', '\\'), $Root.Replace('\', '\\')),
                @($cand.Replace('\', '/'), $Root.Replace('\', '/'))
            )
            foreach ($f in @($pthFile, $mapFile)) {
                if (Test-Path -LiteralPath $f) {
                    $t = Read-Text $f
                    $orig = $t
                    foreach ($p in $pairs) { if ($t.Contains($p[0])) { $t = $t.Replace($p[0], $p[1]) } }
                    if ($t -ne $orig) {
                        Ok ('re-anchor ' + (Split-Path -Leaf $f) + '  (' + $cand + ' -> ' + $Root + ')')
                        if (-not $Check) { Write-Text $f $t }
                    }
                }
            }
        }
    } else {
        Ok 'editable mappings already point at this root (or no stale root recorded)'
    }

    if (-not $Check) {
        if (-not (Test-Path -LiteralPath $Portable)) { New-Item -ItemType Directory -Force -Path $Portable | Out-Null }
        Set-Content -LiteralPath (Join-Path $Portable 'PREV_ROOT.txt') -Value $Root -Encoding Ascii
    }

    # 2c. health probe
    if (Test-Path -LiteralPath $venvPy) {
        Push-Location (Join-Path $Root 'backend')
        try {
            $probe = & $venvPy -c "import app; print('venv-ok ' + app.__file__)" 2>&1
            if ($LASTEXITCODE -eq 0) {
                $pythonOk = $true
                Ok ('venv healthy: ' + ($probe | Select-Object -First 1))
            } else {
                Warn ('venv probe failed: ' + (($probe | Select-Object -First 2) -join ' | '))
                $needsRebuild = $true
            }
        } catch {
            Warn ('venv probe error: ' + $_.Exception.Message)
            $needsRebuild = $true
        } finally { Pop-Location }
    } else { Warn 'backend\.venv\Scripts\python.exe missing'; $needsRebuild = $true }
}

if ($needsRebuild) {
    $uv = $null
    $uvPortable = Join-Path $Portable 'uv.exe'
    if (Test-Path -LiteralPath $uvPortable) { $uv = $uvPortable }
    else {
        $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
        if ($uvCmd) { $uv = $uvCmd.Source }
    }
    if (-not $uv) {
        Bad 'venv broken AND no uv available - install uv (or restore .portable) then re-run'
    } elseif ($Check) {
        Info 'CHECK: venv would be moved aside and rebuilt via uv sync --locked --extra dev'
    } else {
        Warn 'rebuilding backend\.venv via uv (keep this window open)...'
        Warn 'note: a FULL sync also builds the native VFS extension and needs MSVC Build Tools'
        if ($pyDir) { $env:UV_PYTHON_INSTALL_DIR = $pyRoot }
        $cacheDir = Join-Path $Portable 'uv-cache'
        $hasCache = Test-Path -LiteralPath $cacheDir
        if ($hasCache) { $env:UV_CACHE_DIR = $cacheDir }
        if (Test-Path -LiteralPath $venv) {
            $broken = $venv + '.broken-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
            Move-Item -LiteralPath $venv -Destination $broken -Force
            Warn ('previous venv kept as ' + (Split-Path -Leaf $broken) + ' - delete it yourself once the new one works')
        }
        Push-Location (Join-Path $Root 'backend')
        try {
            $synced = $false
            $offlineFirst = $Offline -or $hasCache
            if ($offlineFirst) {
                $env:UV_OFFLINE = '1'
                & $uv sync --locked --extra dev
                if ($LASTEXITCODE -eq 0) { $synced = $true } else { Warn ('offline sync rc=' + $LASTEXITCODE) }
                if (-not $synced) {
                    Warn 'offline full sync failed; retrying without the project install'
                    & $uv sync --locked --extra dev --no-install-project
                    if ($LASTEXITCODE -eq 0) { $synced = $true; Warn 'deps installed WITHOUT the native VFS extension (backend may still boot; re-run later where MSVC is available)' }
                }
                [System.Environment]::SetEnvironmentVariable('UV_OFFLINE', [NullString]::Value)
            }
            if (-not $synced -and -not $Offline) {
                & $uv sync --locked --extra dev
                if ($LASTEXITCODE -eq 0) { $synced = $true }
            }
            if (-not $synced -and -not $Offline) {
                Warn 'full sync failed (native build?); retrying without project install'
                & $uv sync --locked --extra dev --no-install-project
                if ($LASTEXITCODE -eq 0) { $synced = $true; Warn 'deps installed WITHOUT the native VFS extension (backend may still boot; re-run later where MSVC is available)' }
            }
            if ($synced -and (Test-Path -LiteralPath $venvPy)) {
                $probe = & $venvPy -c "import app; print('venv-ok ' + app.__file__)" 2>&1
                if ($LASTEXITCODE -eq 0) { Ok ('venv rebuilt: ' + ($probe | Select-Object -First 1)) } else { Bad 'venv rebuilt but probe still fails' }
            } elseif (-not $synced) { Bad 'venv rebuild failed - see uv output above' }
        } finally {
            Pop-Location
            [System.Environment]::SetEnvironmentVariable('UV_CACHE_DIR', [NullString]::Value)
            [System.Environment]::SetEnvironmentVariable('UV_PYTHON_INSTALL_DIR', [NullString]::Value)
        }
    }
}

# ---------------------------------------------------------------- 3. node
Head '3/4  node / frontend sanity'
$nodeDir = $null
if (Test-Path -LiteralPath $Portable) {
    $nodeDir = Get-ChildItem -LiteralPath $Portable -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'node*' } | Select-Object -First 1
}
if ($nodeDir -and (Test-Path -LiteralPath (Join-Path $nodeDir.FullName 'node.exe'))) {
    $env:PATH = $nodeDir.FullName + ';' + $env:PATH
    Ok ('portable node on PATH: ' + (& (Join-Path $nodeDir.FullName 'node.exe') -v))
} else {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $v = & $nodeCmd.Source -v
        if ($v -match '^v(\d+)') {
            if ([int]$Matches[1] -ge 22) { Ok ('system node: ' + $v) }
            else { Warn ('system node ' + $v + ' is older than v22 - upgrade or stage .portable\node') }
        }
    } else { Warn 'node not found - frontend cannot start (stage .portable\node or install Node.js 22+)' }
}
$nm = Join-Path $Root 'frontend\node_modules\next\package.json'
if (Test-Path -LiteralPath $nm) { Ok 'frontend\node_modules present' }
elseif ($RepairNode) {
    if ($Check) { Info 'CHECK: would run npm ci in frontend' }
    else {
        Warn 'frontend\node_modules missing - running npm ci (needs network)...'
        Push-Location (Join-Path $Root 'frontend')
        try { & npm ci; if ($LASTEXITCODE -eq 0) { Ok 'npm ci done' } else { Bad ('npm ci rc=' + $LASTEXITCODE) } }
        finally { Pop-Location }
    }
} else {
    Warn 'frontend\node_modules looks incomplete - re-run with -RepairNode (or npm ci in frontend)'
}

# ---------------------------------------------------------------- 4. housekeeping
Head '4/4  housekeeping'
if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
    Push-Location $Root
    try {
        & git worktree prune 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'git worktree prune done (stale worktree refs cleared)' } else { Warn 'git worktree prune rc=' + $LASTEXITCODE }
    } catch { Warn ('git unavailable: ' + $_.Exception.Message) } finally { Pop-Location }
}
$rl = Join-Path $Root '.run-logs'
if (Test-Path -LiteralPath $rl) {
    $pids = Get-ChildItem -LiteralPath $rl -Filter '*.pid' -ErrorAction SilentlyContinue
    if ($pids) { if (-not $Check) { $pids | Remove-Item -Force -ErrorAction SilentlyContinue; Ok 'stale .run-logs pid files removed' } else { Info 'CHECK: would remove stale pid files' } }
}
$sp = Join-Path $Root 'data\spaces'
if (Test-Path -LiteralPath $sp) {
    $n = (Get-ChildItem -LiteralPath $sp -Directory -ErrorAction SilentlyContinue).Count
    Ok ('data root present: ' + $n + ' space folder(s) under data\spaces')
} else { Warn 'data\spaces missing - first backend start will create it' }

# ---------------------------------------------------------------- summary
Head 'summary'
if ($Check) { Info 'CHECK mode - no changes were written' }
if ($script:changes.Count -gt 0) {
    Say '  planned/applied changes:'
    foreach ($c in $script:changes) { Say ('    - ' + $c) }
}
if ($script:warnings.Count -gt 0) {
    Say ''
    Write-Host '  warnings:' -ForegroundColor Yellow
    foreach ($w in $script:warnings) { Write-Host ('    - ' + $w) -ForegroundColor Yellow }
}
Say ''
Say '  NEXT:'
Say '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\doctor.ps1'
Say '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\start-dev.ps1 start'
Say ''
if (-not $pythonOk -and $warnings.Count -eq 0) { exit 0 }
