Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$profilePath = Join-Path $PSScriptRoot 'quicknote-native.ps1'
if (-not (Test-Path -LiteralPath $profilePath)) {
  throw 'quicknote native profile implementation is missing'
}

. $profilePath

$zero = Invoke-QNProbe { node -e 'process.stdout.write("zero"); process.exit(0)' }
if ($zero.ExitCode -ne 0 -or $zero.Output -ne 'zero') { throw 'zero probe mismatch' }

$one = Invoke-QNProbe { node -e 'process.stdout.write("one"); process.exit(1)' }
if ($one.ExitCode -ne 1 -or $one.Output -ne 'one') { throw 'one probe mismatch' }

$twoFailed = $false
try {
  $null = Invoke-QNProbe { node -e 'process.exit(2)' }
} catch {
  $twoFailed = $true
}
if (-not $twoFailed) { throw 'exit 2 probe must fail' }
if (-not $global:PSNativeCommandUseErrorActionPreference) { throw 'probe did not restore strict native behavior' }

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("qn99-native-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
  git -C $temporaryRoot init -q
  git -C $temporaryRoot config user.name 'QN99 Test'
  git -C $temporaryRoot config user.email 'qn99@example.invalid'
  $temporaryScriptDirectory = Join-Path $temporaryRoot 'scripts/audit-report'
  New-Item -ItemType Directory -Path $temporaryScriptDirectory -Force | Out-Null
  $temporaryProfile = Join-Path $temporaryScriptDirectory 'quicknote-native.ps1'
  Copy-Item -LiteralPath $profilePath -Destination $temporaryProfile
  $argumentReceipt = Join-Path $temporaryRoot 'scope-arguments.json'
  $scopeStub = @'
const fs = require('node:fs')
fs.writeFileSync(process.env.QN_SCOPE_ARGUMENT_RECEIPT, JSON.stringify(process.argv.slice(2)))
if (process.argv.includes('task-reject')) process.exit(2)
'@
  Set-Content -LiteralPath (Join-Path $temporaryScriptDirectory 'validate-quicknote-99-scope.cjs') -Value $scopeStub -Encoding utf8NoBOM
  New-Item -ItemType Directory -Path (Join-Path $temporaryRoot 'backend') | Out-Null
  Set-Content -LiteralPath (Join-Path $temporaryRoot 'tracked.txt') -Value 'base' -Encoding utf8NoBOM
  git -C $temporaryRoot add tracked.txt scripts
  git -C $temporaryRoot commit -qm base

  . $temporaryProfile
  $env:QN_SCOPE_ARGUMENT_RECEIPT = $argumentReceipt
  Push-Location (Join-Path $temporaryRoot 'backend')
  try {
    Assert-QNIndexEmpty
    Assert-QNStagedScope -Module 'module-exact' -Task 'task-exact'
    $forwarded = Get-Content -Raw $argumentReceipt | ConvertFrom-Json
    if (($forwarded -join '|') -ne '--staged|--module|module-exact|--task|task-exact') {
      throw "scope arguments were not forwarded exactly: $($forwarded -join '|')"
    }
    $scopeFailed = $false
    try { Assert-QNStagedScope -Module 'module-exact' -Task 'task-reject' } catch { $scopeFailed = $true }
    if (-not $scopeFailed) { throw 'scope mismatch must terminate the caller' }
    Set-Content -LiteralPath (Join-Path $temporaryRoot 'staged.txt') -Value 'staged' -Encoding utf8NoBOM
    git -C $temporaryRoot add staged.txt
    $indexFailed = $false
    try { $null = Assert-QNIndexEmpty } catch { $indexFailed = $true }
    if (-not $indexFailed) { throw 'staged index must fail empty assertion' }
  } finally {
    Pop-Location
    Remove-Item Env:QN_SCOPE_ARGUMENT_RECEIPT -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}

$sentinelRoot = Join-Path ([IO.Path]::GetTempPath()) ("qn99-native-sentinel-" + [guid]::NewGuid().ToString('N'))
foreach ($rawExitCode in @(1, 2)) {
  $sentinel = "$sentinelRoot-$rawExitCode"
  $child = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
`$PSNativeCommandUseErrorActionPreference = `$true
. '$($profilePath.Replace("'", "''"))'
node -e 'process.exit($rawExitCode)'
Set-Content -LiteralPath '$($sentinel.Replace("'", "''"))' -Value reached
"@
  $childResult = Invoke-QNProbe { pwsh -NoProfile -Command $child 2>$null }
  if ($childResult.ExitCode -ne 1 -or (Test-Path -LiteralPath $sentinel)) { throw "raw native exit $rawExitCode did not terminate child shell" }
}

Write-Output 'NATIVE_TEST_OK'
