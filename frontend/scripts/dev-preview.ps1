param(
  [int]$Port = 3005,
  [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$frontendRoot = Split-Path -Parent $PSScriptRoot
$npm = "C:\Program Files\nodejs\npm.cmd"

if (-not (Test-Path -LiteralPath $npm)) {
  $npm = "npm.cmd"
}

Set-Location -LiteralPath $frontendRoot

Write-Host "Starting PomodoroXII frontend preview..."
Write-Host "URL: http://${HostName}:$Port/quick-notes?quickNotePreview=1"
Write-Host "Keep this terminal open while testing."
Write-Host ""
Write-Host "If the browser shows ERR_CONNECTION_REFUSED, this terminal is not running the dev server."
Write-Host "If port $Port is already in use, start another preview with:"
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/dev-preview.ps1 -Port 3006"
Write-Host "This script does not stop or kill existing processes."
Write-Host ""

& $npm run dev -- --hostname $HostName --port $Port
