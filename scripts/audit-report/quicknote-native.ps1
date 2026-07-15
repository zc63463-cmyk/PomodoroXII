Set-StrictMode -Version Latest
$global:ErrorActionPreference = 'Stop'
$global:PSNativeCommandUseErrorActionPreference = $true
$script:QNRepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

function Invoke-QNProbe {
  param([Parameter(Mandatory)][scriptblock]$Command)

  $previous = $global:PSNativeCommandUseErrorActionPreference
  try {
    $global:PSNativeCommandUseErrorActionPreference = $false
    $output = @(& $Command)
    $exitCode = $LASTEXITCODE
  } finally {
    $global:PSNativeCommandUseErrorActionPreference = $previous
  }
  if ($exitCode -notin @(0, 1)) { throw "probe failed with exit $exitCode" }
  [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

function Assert-QNIndexEmpty {
  $staged = @(git -C $script:QNRepositoryRoot diff --cached --name-only)
  if ($staged) { $staged; throw 'index must be empty before task staging' }
}

function Assert-QNStagedScope {
  param(
    [Parameter(Mandatory)][string]$Module,
    [Parameter(Mandatory)][string]$Task
  )

  Push-Location $script:QNRepositoryRoot
  try {
    node scripts/audit-report/validate-quicknote-99-scope.cjs --staged --module $Module --task $Task
  } finally {
    Pop-Location
  }
}
