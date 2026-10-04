<#
  PomodoroXII - portable dev launcher (wrapper around scripts\dev-local.ps1).

  Prepends .portable\node (if staged) to PATH, points uv env vars at .portable,
  clears PYTHONPATH, then delegates to dev-local.ps1 (backend :8100 / frontend :3010).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\start-dev.ps1 start
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\start-dev.ps1 stop
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\start-dev.ps1 status
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'start',

    [int]$BackendPort = 8100,
    [int]$FrontendPort = 3010
)

$ErrorActionPreference = 'Stop'
$Root     = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Portable = Join-Path $Root '.portable'

if (Test-Path -LiteralPath $Portable) {
    $nodeDir = Get-ChildItem -LiteralPath $Portable -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'node*' } | Select-Object -First 1
    if ($nodeDir) { $env:PATH = $nodeDir.FullName + ';' + $env:PATH }
    if (Test-Path -LiteralPath (Join-Path $Portable 'uv-python')) { $env:UV_PYTHON_INSTALL_DIR = Join-Path $Portable 'uv-python' }
    if (Test-Path -LiteralPath (Join-Path $Portable 'uv-cache'))  { $env:UV_CACHE_DIR = Join-Path $Portable 'uv-cache' }
}
$env:PYTHONPATH = ''

& (Join-Path $Root 'scripts\dev-local.ps1') -Action $Action -BackendPort $BackendPort -FrontendPort $FrontendPort
