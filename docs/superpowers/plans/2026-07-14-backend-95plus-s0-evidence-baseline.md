# Backend 95+ S0 Evidence Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible, exact-SHA evidence baseline for `d20f200`, lock the nine-module scoring contract, move new test sandboxes outside the repository, and preserve a deterministic N-1 fixture for later recovery certification.

**Architecture:** Treat evidence as versioned data rather than prose: a closed JSON Schema plus one standard-library semantic validator defines each evidence record, including exact artifact byte size, path containment, time/result consistency, and trust provenance; a policy file fixes scoring and caps; and the baseline verifier recomputes every score and rehashes every artifact. Baseline commands run against the immutable audited backend subject before S0 changes; pytest sandboxes use one dedicated external root and never delete retained user artifacts. The N-1 fixture is a deterministic population program plus manifest pinned to `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f`.

**Tech Stack:** Python 3.13, pytest, pytest-cov 6+, Ruff, uv, JSON Schema 2020-12, SQLite, SQLAlchemy asyncio, Git, GitHub Actions

---

## Scope And Execution Invariants

- The immutable audited subject is `d20f200a95c25c25b1572da1781fde55560cdce0`.
- The saved remote and first-certification N-1 subject is the immutable historical Git object `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f`. The movable current `origin/main` tip is recorded separately as implementation context and is never required to remain equal to that historical object.
- Run every Task 1 baseline command in a newly created, detached, clean worktree at the full audited SHA; never execute an exact-SHA receipt against the current checkout, even when its tracked diff appears empty.
- Never remove, rename, or modify `backend/tests/pytest-of-20564/`, `backend/.test-artifacts/`, or any pre-existing untracked path. Record their debt only.
- Every generated test run lives immediately below a configured external directory named `pomodoroxii-test-artifacts` and then below a unique run directory whose name is `run-` plus 16 lowercase hexadecimal characters.
- Every PowerShell block that invokes pytest sets `POMODOROXII_TEST_ARTIFACTS_ROOT` itself; no block relies on environment state from an earlier shell.
- Every shell block is independent and starts at the repository root. A block either uses repository-root-relative pathspecs or enters `backend/` itself; it never inherits a previous block's working directory.
- Evidence timestamps are RFC 3339 with an explicit offset; SHA fields are full lowercase hex; repository paths use `/` separators.
- S0 does not change production behavior, migrations, REST/MCP contracts, or frontend code.

## File Responsibility Map

- Create `backend/audit/95plus/evidence.schema.json`: closed JSON Schema for the evidence envelope and its required record fields.
- Create `backend/audit/95plus/score-policy.json`: immutable module IDs, five 0-20 dimensions, formulas, thresholds, and hard caps.
- Create `backend/audit/95plus/baseline.json`: audited subject, saved remote, nine module worksheets, all classified findings, evidence records, and retained artifact debt.
- Create `backend/app/audit/__init__.py`: export the S0 evidence-contract validator for later producer and certification consumers.
- Create `backend/app/audit/evidence_contract.py`: standard-library closed-envelope, semantic-field, and lexical/contained artifact-path validation shared unchanged by S0, S5, and S6.
- Create `backend/scripts/verify_95plus_baseline.py`: standard-library verifier for schema shape, hashes, score arithmetic, classifications, and subject locks.
- Create `backend/tests/test_audit_evidence.py`: contract tests for all three JSON files and the verifier.
- Modify `backend/pyproject.toml`: add `pytest-cov>=6.0` to the `dev` dependency group.
- Modify `backend/uv.lock`: refresh the lock after the development dependency change.
- Modify `backend/tests/conftest.py`: default new pytest sandboxes to the OS temporary directory outside the repository.
- Modify `backend/tests/test_test_isolation.py`: lock external-root, containment, uniqueness, and no-recursive-delete behavior.
- Create `backend/tests/fixtures/certification/n_minus_one_manifest.json`: deterministic fixture contract pinned to the full N-1 SHA.
- Create `backend/tests/fixtures/certification/populate_n_minus_one.py`: populate Meta, one Space, database rows, Markdown bodies, `index.db`, and Sync ledger deterministically.
- Create `backend/tests/test_n_minus_one_fixture.py`: execute the population program and verify counts, Note body hashes, paths, and waterline.

## Interfaces Locked By S0

```text
verify_baseline(root: Path) -> VerificationSummary
validate_evidence_envelope(envelope, *, expected_subject_sha, known_modules, known_findings) -> tuple[Mapping[str, object], ...]
resolve_bundle_artifact(artifact_root: Path, artifact_path: str) -> Path
resolve_external_artifact(external_root: Path, artifact_uri: str) -> Path
score_module(dimensions: Mapping[str, int]) -> Decimal
score_backend(module_scores: Sequence[Decimal]) -> Decimal
effective_cap(findings: Sequence[Mapping[str, object]], evidence: Sequence[Mapping[str, object]], verified_artifact_ids: Collection[str]) -> int | None
populate_fixture(data_root: Path, manifest_path: Path) -> FixtureReceipt
```

An evidence record always has exactly these required fields:

```text
evidence_id, subject_sha, command, cwd, runtime, started_at, finished_at,
exit_code, result, artifact_path, artifact_sha256, artifact_size_bytes,
trust_level, confidence, modules, finding_ids, certification_tags
```

`trust_level` is exactly one of `local_snapshot`, `pr_local`, `trusted_push`, or `release_drill`. S0 baseline/source evidence uses `local_snapshot`; later waves may promote only newly produced evidence, never relabel an existing record.

The baseline top level always has exactly these required fields:

```text
schema_version, audited_subject_sha, saved_remote_sha, modules, findings,
evidence, retained_artifact_debt
```

### Task 1: Capture The Immutable Subject Before Editing Backend Files

**Files:**
- Read: `backend/`
- Read: `.github/workflows/ci.yml`
- Create externally: one new `s0-baseline/` directory below a generated `run-` directory in the configured `pomodoroxii-test-artifacts` root
- Later consume: `backend/audit/95plus/baseline.json`

**Interfaces:**
- Consumes: Git objects `d20f200a95c25c25b1572da1781fde55560cdce0` and `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f`, the audited `backend/uv.lock` blob, repository-local Python only as a bootstrap interpreter, and an identified `uv` executable.
- Produces: external, rehashed EvidenceRecord receipts whose commands run from a clean detached audited worktree; no tracked file and no commit.

- [ ] **Step 1: Prove the audited object can be materialized as a clean detached subject**

Run from the repository root:

```powershell
$auditSha = 'd20f200a95c25c25b1572da1781fde55560cdce0'
$savedRemoteSha = '1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f'
$preflightBase = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
$preflightName = 'run-' + [guid]::NewGuid().ToString('N').Substring(0,16)
$preflightRoot = Join-Path $preflightBase $preflightName
$auditRoot = Join-Path $preflightRoot 'subject-d20f200'
New-Item -ItemType Directory -Path $preflightRoot -Force | Out-Null

& git cat-file -e "$auditSha^{commit}"
if ($LASTEXITCODE -ne 0) { throw "audited commit object missing: $auditSha" }
& git cat-file -e "$savedRemoteSha^{commit}"
if ($LASTEXITCODE -ne 0) { throw "saved remote commit object missing: $savedRemoteSha" }
& git merge-base --is-ancestor $savedRemoteSha $auditSha
if ($LASTEXITCODE -ne 0) { throw 'saved remote is not an ancestor of the audited subject' }
$snapshotAhead = (& git rev-list --count "$savedRemoteSha..$auditSha").Trim()
if ($LASTEXITCODE -ne 0 -or $snapshotAhead -ne '18') {
    throw "captured snapshot ancestry count mismatch: $snapshotAhead"
}
$currentOriginSha = (& git rev-parse --verify 'origin/main^{commit}').Trim()
if ($LASTEXITCODE -ne 0 -or $currentOriginSha -notmatch '^[0-9a-f]{40}$') {
    throw "current origin/main is not a full commit SHA: $currentOriginSha"
}

& git worktree add --detach -- $auditRoot $auditSha
if ($LASTEXITCODE -ne 0) { throw 'failed to create detached audited worktree' }
try {
    $head = (& git -C $auditRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $auditSha) {
        throw "detached worktree HEAD mismatch: $head"
    }
    $status = @(& git -C $auditRoot status --porcelain=v1 --untracked-files=all -- backend .github/workflows/ci.yml)
    if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
        $status | Write-Output
        throw 'detached audited backend inputs are not clean'
    }
    $expectedLockBlob = (& git rev-parse "$auditSha`:backend/uv.lock").Trim()
    $actualLockBlob = (& git -C $auditRoot hash-object backend/uv.lock).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualLockBlob -ne $expectedLockBlob) {
        throw 'audited uv.lock does not match its Git blob'
    }
    "HEAD=$head"
    "STATUS=CLEAN_TRACKED_AND_UNTRACKED"
    "UV_LOCK_BLOB=$actualLockBlob"
    "SAVED_REMOTE_SHA=$savedRemoteSha"
    "SNAPSHOT_AHEAD=$snapshotAhead"
    "CURRENT_ORIGIN_MAIN=$currentOriginSha"
}
finally {
    & git worktree remove -- $auditRoot
    if ($LASTEXITCODE -ne 0) { throw "failed to remove clean preflight worktree: $auditRoot" }
}
```

Expected: `HEAD`, `UV_LOCK_BLOB`, `SAVED_REMOTE_SHA`, and `SNAPSHOT_AHEAD` print the locked historical values, `CURRENT_ORIGIN_MAIN` records the current movable implementation-context tip, and status is exactly clean. The saved remote must exist as a commit and remain exactly 18 commits behind the audited subject; the current `origin/main` value is deliberately not compared with it. The check covers tracked and untracked relevant inputs in the detached worktree, so untracked Python files in the current checkout cannot enter an audited command. A missing historical object, invalid captured ancestry, dirty detached subject, or lock-blob mismatch stops S0; normal movement of the current remote-tracking ref does not invalidate the historical snapshot.

- [ ] **Step 2: Characterize the old repository-local default without starting pytest**

Run from the repository root in another independently created detached worktree:

```powershell
$auditSha = 'd20f200a95c25c25b1572da1781fde55560cdce0'
$inspectBase = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
$inspectName = 'run-' + [guid]::NewGuid().ToString('N').Substring(0,16)
$inspectRoot = Join-Path $inspectBase $inspectName
$auditRoot = Join-Path $inspectRoot 'subject-d20f200'
New-Item -ItemType Directory -Path $inspectRoot -Force | Out-Null
& git worktree add --detach -- $auditRoot $auditSha
if ($LASTEXITCODE -ne 0) { throw 'failed to create detached characterization worktree' }
try {
    $status = @(& git -C $auditRoot status --porcelain=v1 --untracked-files=all -- backend .github/workflows/ci.yml)
    if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
        throw 'detached characterization subject is not clean'
    }
    & rg -n "pytest-of-|POMODOROXII_TEST_ARTIFACTS_ROOT|tempfile" `
        (Join-Path $auditRoot 'backend/tests/conftest.py') `
        (Join-Path $auditRoot 'backend/tests/test_test_isolation.py')
    if ($LASTEXITCODE -gt 1) { throw "rg failed with exit code $LASTEXITCODE" }
}
finally {
    & git worktree remove -- $auditRoot
    if ($LASTEXITCODE -ne 0) { throw "failed to remove clean characterization worktree: $auditRoot" }
}
```

Expected: the audited source, not the current checkout, shows the repository-local fallback and its characterization assertion. Do not invoke pytest before setting the external artifact root: the autouse fixture would create a repository-local run directory. Task 5 replaces this source path and its test.

- [ ] **Step 3: Capture one exact JSON receipt per baseline command outside the repository**

Run this entire block from the current repository root. It creates a fresh detached worktree for the audited code, uses the current checkout only to locate locked runtime executables, and writes all receipts outside both worktrees:

```powershell
$auditSha = 'd20f200a95c25c25b1572da1781fde55560cdce0'
$sourceRoot = (Resolve-Path .).Path
$artifactBase = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
$runName = 'run-' + [guid]::NewGuid().ToString('N').Substring(0,16)
$runRoot = Join-Path $artifactBase $runName
$baselineRoot = Join-Path $runRoot 's0-baseline'
$auditRoot = Join-Path $runRoot 'subject-d20f200'
$auditBackend = Join-Path $auditRoot 'backend'
New-Item -ItemType Directory -Path $baselineRoot -Force | Out-Null
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPYCACHEPREFIX = Join-Path $runRoot 'pycache'
$bootstrapPythonExe = Join-Path $sourceRoot 'backend\.venv\Scripts\python.exe'
$uvCommand = Get-Command uv -CommandType Application -ErrorAction Stop
$uvExe = $uvCommand.Source
if (-not (Test-Path -LiteralPath $bootstrapPythonExe -PathType Leaf)) { throw 'bootstrap Python runtime is missing' }

& git worktree add --detach -- $auditRoot $auditSha
if ($LASTEXITCODE -ne 0) { throw 'failed to create detached evidence worktree' }
$expectedLockBlob = (& git rev-parse "$auditSha`:backend/uv.lock").Trim()
$actualLockBlob = (& git -C $auditRoot hash-object backend/uv.lock).Trim()
if ($LASTEXITCODE -ne 0 -or $actualLockBlob -ne $expectedLockBlob) {
    throw 'audited uv.lock does not match its Git blob before sync'
}
$runtimeRoot = Join-Path $runRoot 'runtime-venv'
$env:UV_PROJECT_ENVIRONMENT = $runtimeRoot
$uvVersion = (& $uvExe --version 2>&1 | Out-String).Trim()
& $uvExe sync --frozen --all-extras --all-groups --no-install-project `
    --project $auditBackend --python $bootstrapPythonExe 2>&1 |
    Tee-Object -LiteralPath (Join-Path $baselineRoot 'runtime-sync.txt')
if ($LASTEXITCODE -ne 0) { throw 'uv frozen sync failed' }
$runtimeSyncSha = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $baselineRoot 'runtime-sync.txt')).Hash.ToLowerInvariant()
$pythonExe = Join-Path $runtimeRoot 'Scripts\python.exe'
$ruffExe = Join-Path $runtimeRoot 'Scripts\ruff.exe'
if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) { throw 'frozen Python runtime is missing' }
if (-not (Test-Path -LiteralPath $ruffExe -PathType Leaf)) { throw 'frozen Ruff runtime is missing' }
$env:PYTHONPATH = $auditBackend
$env:PYTHONNOUSERSITE = '1'
$pythonVersion = (& $pythonExe --version 2>&1 | Out-String).Trim()
$ruffVersion = (& $ruffExe --version 2>&1 | Out-String).Trim()
$platform = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription

function Assert-AuditedWorktree {
    $head = (& git -C $auditRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $auditSha) {
        throw "audited HEAD changed: $head"
    }
    $status = @(& git -C $auditRoot status --porcelain=v1 --untracked-files=all -- backend .github/workflows/ci.yml)
    if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
        $status | Write-Output
        throw 'audited backend inputs contain tracked or untracked drift'
    }
    $actualLockBlob = (& git -C $auditRoot hash-object backend/uv.lock).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualLockBlob -ne $expectedLockBlob) {
        throw 'audited uv.lock blob changed'
    }
    $appRoot = (& $pythonExe -c "import importlib.util; print(importlib.util.find_spec('app').submodule_search_locations[0])").Trim()
    $expectedAppRoot = (Resolve-Path (Join-Path $auditBackend 'app')).Path
    if ($LASTEXITCODE -ne 0 -or $appRoot -ne $expectedAppRoot) {
        throw "Python imports app from non-audited source: $appRoot"
    }
    "HEAD=$head"
    "STATUS=CLEAN_TRACKED_AND_UNTRACKED"
    "UV_LOCK_BLOB=$actualLockBlob"
    "UV_VERSION=$uvVersion"
    "RUNTIME_SYNC_SHA256=$runtimeSyncSha"
    "APP_SOURCE_ROOT=$appRoot"
}

function Invoke-EvidenceCommand {
    param(
        [Parameter(Mandatory)] [string] $EvidenceId,
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string] $ArtifactName,
        [Parameter(Mandatory)] [string] $RuntimeName,
        [Parameter(Mandatory)] [string] $RuntimeVersion,
        [Parameter(Mandatory)] [string[]] $Modules,
        [string[]] $FindingIds = @(),
        [Parameter(Mandatory)] [scriptblock] $Action
    )
    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }
    $artifactPath = Join-Path $baselineRoot $ArtifactName
    $startedAt = [DateTimeOffset]::Now.ToString('o')
    Assert-AuditedWorktree | Set-Content -LiteralPath $artifactPath -Encoding utf8NoBOM
    Push-Location $auditBackend
    try {
        & $Action 2>&1 | Tee-Object -FilePath $artifactPath -Append
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    Assert-AuditedWorktree | Tee-Object -FilePath $artifactPath -Append | Out-Null
    $finishedAt = [DateTimeOffset]::Now.ToString('o')
    $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
    $artifactSizeBytes = (Get-Item -LiteralPath $artifactPath).Length
    $artifactUri = 'external://pomodoroxii-test-artifacts/' +
        $runName + '/s0-baseline/' + $ArtifactName
    $receipt = [ordered]@{
        evidence_id = $EvidenceId
        subject_sha = $auditSha
        command = $Command
        cwd = 'backend'
        runtime = [ordered]@{
            name = $RuntimeName
            version = $RuntimeVersion
            platform = $platform
        }
        started_at = $startedAt
        finished_at = $finishedAt
        exit_code = $exitCode
        result = if ($exitCode -eq 0) { 'passed' } else { 'failed' }
        artifact_path = $artifactUri
        artifact_sha256 = $sha256
        artifact_size_bytes = $artifactSizeBytes
        trust_level = 'local_snapshot'
        confidence = 'confirmed'
        modules = @($Modules)
        finding_ids = @($FindingIds)
        certification_tags = @()
    }
    $receiptPath = Join-Path $baselineRoot ($EvidenceId.ToLowerInvariant() + '.receipt.json')
    $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
    $receipt | ConvertTo-Json -Depth 4
    if ($exitCode -ne 0) { throw "$EvidenceId failed with exit code $exitCode" }
}

$retainAuditWorktree = $false
try {
    Invoke-EvidenceCommand `
        -EvidenceId 'EV-COLLECT' `
        -Command "$pythonExe -m pytest --collect-only -q -p no:cacheprovider" `
        -ArtifactName 'collect.txt' `
        -RuntimeName 'python' `
        -RuntimeVersion $pythonVersion `
        -Modules @('entity_commands') `
        -Action { & $pythonExe -m pytest --collect-only -q -p no:cacheprovider }
    Invoke-EvidenceCommand `
        -EvidenceId 'EV-RUFF' `
        -Command "$ruffExe check --no-cache app tests" `
        -ArtifactName 'ruff.txt' `
        -RuntimeName 'ruff' `
        -RuntimeVersion $ruffVersion `
        -Modules @('runtime_auth', 'migration_space_lifecycle', 'registry_meta', 'entity_commands', 'sync_push', 'sync_pull_recovery', 'notes_fs', 'mcp') `
        -Action { & $ruffExe check --no-cache app tests }
    Invoke-EvidenceCommand `
        -EvidenceId 'EV-FOCUSED-AUTH' `
        -Command "$pythonExe -m pytest -q tests/test_prod_hardening.py tests/test_auth_security.py tests/test_routes_auth_spaces.py tests/test_settings.py -p no:cacheprovider" `
        -ArtifactName 'focused-auth.txt' `
        -RuntimeName 'python' `
        -RuntimeVersion $pythonVersion `
        -Modules @('runtime_auth') `
        -Action { & $pythonExe -m pytest -q tests/test_prod_hardening.py tests/test_auth_security.py tests/test_routes_auth_spaces.py tests/test_settings.py -p no:cacheprovider }
    Invoke-EvidenceCommand `
        -EvidenceId 'EV-FOCUSED-SYNC' `
        -Command "$pythonExe -m pytest -q tests/test_sync_service.py tests/test_sync_routes.py tests/test_sync_safety.py tests/test_sync_cursor_pagination.py -p no:cacheprovider" `
        -ArtifactName 'focused-sync.txt' `
        -RuntimeName 'python' `
        -RuntimeVersion $pythonVersion `
        -Modules @('sync_push', 'sync_pull_recovery') `
        -Action { & $pythonExe -m pytest -q tests/test_sync_service.py tests/test_sync_routes.py tests/test_sync_safety.py tests/test_sync_cursor_pagination.py -p no:cacheprovider }
    Invoke-EvidenceCommand `
        -EvidenceId 'EV-FOCUSED-MIGRATION' `
        -Command "$pythonExe -m pytest -q tests/test_migration_runner.py tests/test_alembic_dual_environments.py tests/test_note_service.py tests/test_mcp_server.py -p no:cacheprovider" `
        -ArtifactName 'focused-migration-notes-mcp.txt' `
        -RuntimeName 'python' `
        -RuntimeVersion $pythonVersion `
        -Modules @('migration_space_lifecycle', 'registry_meta', 'notes_fs', 'mcp') `
        -Action { & $pythonExe -m pytest -q tests/test_migration_runner.py tests/test_alembic_dual_environments.py tests/test_note_service.py tests/test_mcp_server.py -p no:cacheprovider }
}
catch {
    $retainAuditWorktree = $true
    ($_ | Out-String) | Set-Content -LiteralPath (Join-Path $baselineRoot 'evidence-command-failure.txt') -Encoding utf8NoBOM
    throw
}
finally {
    $remaining = @(& git -C $auditRoot status --porcelain=v1 --untracked-files=all -- backend .github/workflows/ci.yml)
    if (-not $retainAuditWorktree -and $LASTEXITCODE -eq 0 -and $remaining.Count -eq 0) {
        & git worktree remove -- $auditRoot
        if ($LASTEXITCODE -ne 0) { throw "failed to remove clean evidence worktree: $auditRoot" }
    }
    else {
        $remaining | Set-Content -LiteralPath (Join-Path $baselineRoot 'unexpected-worktree-drift.txt') -Encoding utf8NoBOM
        "AUDIT_WORKTREE_RETAINED=$auditRoot"
    }
}
```

Expected: `runtime-sync.txt` records identified `uv` resolving all audited runtime/dev extras from the lock with `--frozen` into an external environment; collection ends with `828 tests collected`; Ruff ends with `All checks passed!`; all three explicit focused suites exit `0`. Every artifact begins and ends with the same audited `HEAD`, `UV_LOCK_BLOB`, `UV_VERSION`, `RUNTIME_SYNC_SHA256`, and detached `APP_SOURCE_ROOT` plus a clean tracked/untracked status; any drift or import resolution into the current checkout prevents a confirmed receipt and retains the generated detached worktree for diagnosis. Each command writes its own output artifact and a complete closed-schema EvidenceRecord receipt containing the exact subject/command, audited `backend` cwd, runtime identity/version/platform, independent start/end timestamps, exit/result, concrete external URI, lowercase SHA-256, exact byte size, `trust_level: local_snapshot`, confidence, module/finding bindings, and an empty certification-tag array. The `EV-RUFF` receipt binds exactly the eight module IDs `runtime_auth`, `migration_space_lifecycle`, `registry_meta`, `entity_commands`, `sync_push`, `sync_pull_recovery`, `notes_fs`, and `mcp` in that order; it does not bind `deploy_operations`, whose evidence is drawn from Docker/CI rather than the Ruff lint surface. All five Task 1 receipts carry a non-empty, unique `modules` array and satisfy the later Schema requirement `modules.minItems = 1`. The generated root is outside the repository. The earlier `83/64/79` discovery counts are context only and must not be copied into S0 evidence because their original commands and artifacts were not retained.

- [ ] **Step 4: Record retained debt without deleting it**

Run from the repository root:

```powershell
$debt = Get-Item -LiteralPath 'backend/tests/pytest-of-20564' -ErrorAction Stop
$bytes = (Get-ChildItem -LiteralPath $debt.FullName -Recurse -File | Measure-Object Length -Sum).Sum
"PATH=backend/tests/pytest-of-20564"
"SIZE_BYTES=$bytes"
"HANDLING=preserve"
```

Expected: the path remains present and the measured size is recorded under `retained_artifact_debt`; no delete or move command is run.

- [ ] **Step 5: Commit**

This task intentionally changes no tracked file. Record its command outputs in the execution log and continue without creating an empty commit.

- Commit: none; Task 1 produces only external evidence artifacts and transient detached-worktree metadata.

### Task 2: Lock Evidence Schema And Nine-Module Score Policy

**Files:**
- Create: `backend/audit/95plus/evidence.schema.json`
- Create: `backend/audit/95plus/score-policy.json`
- Create: `backend/app/audit/__init__.py`
- Create: `backend/app/audit/evidence_contract.py`
- Create: `backend/tests/test_audit_evidence.py`

**Interfaces:**
- Consumes: the locked EvidenceRecord/baseline field sets, nine module IDs, finding classifications, and exact-integer scoring policy.
- Produces: closed JSON Schema and `validate_evidence_envelope`/score/cap contracts shared by S0, S5, and S6.

- [ ] **Step 1: Write the failing schema and policy tests**

Create `backend/tests/test_audit_evidence.py` with:

```python
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest


AUDITED_SHA = "d20f200a95c25c25b1572da1781fde55560cdce0"
EXPECTED_BASELINE_EVIDENCE_IDS = {
    "EV-SOURCE-RUNTIME-AUTH",
    "EV-SOURCE-MIGRATION",
    "EV-SOURCE-REGISTRY",
    "EV-SOURCE-ENTITY",
    "EV-SOURCE-SYNC",
    "EV-SOURCE-NOTES",
    "EV-SOURCE-DELIVERY",
    "EV-SOURCE-MCP",
    "EV-COLLECT",
    "EV-RUFF",
    "EV-FOCUSED-AUTH",
    "EV-FOCUSED-SYNC",
    "EV-FOCUSED-MIGRATION",
    "EV-GITHUB-CI",
}

AUDIT_ROOT = Path(__file__).resolve().parents[1] / "audit" / "95plus"
MODULE_IDS = {
    "runtime_auth",
    "migration_space_lifecycle",
    "registry_meta",
    "entity_commands",
    "sync_push",
    "sync_pull_recovery",
    "notes_fs",
    "deploy_operations",
    "mcp",
}
EVIDENCE_FIELDS = {
    "evidence_id",
    "subject_sha",
    "command",
    "cwd",
    "runtime",
    "started_at",
    "finished_at",
    "exit_code",
    "result",
    "artifact_path",
    "artifact_sha256",
    "artifact_size_bytes",
    "trust_level",
    "confidence",
    "modules",
    "finding_ids",
    "certification_tags",
}
FINDING_FIELDS = {
    "finding_id",
    "severity",
    "status",
    "classification",
    "release_blocker",
    "modules",
    "evidence_ids",
}


def load_json(name: str) -> dict:
    return json.loads((AUDIT_ROOT / name).read_text(encoding="utf-8"))


def load_evidence_contract():
    from app.audit import evidence_contract

    return evidence_contract


def valid_envelope(tmp_path: Path) -> dict:
    artifact = tmp_path / "artifact.json"
    artifact.write_text("{}", encoding="utf-8")
    return {
        "schema_version": "1.0",
        "records": [{
            "evidence_id": "EV-VALID",
            "subject_sha": AUDITED_SHA,
            "command": "python -m pytest -q",
            "cwd": "backend",
            "runtime": {"name": "python", "version": "3.13.5", "platform": "test"},
            "started_at": "2026-07-14T00:00:00+00:00",
            "finished_at": "2026-07-14T00:00:01+00:00",
            "exit_code": 0,
            "result": "passed",
            "artifact_path": "artifact.json",
            "artifact_sha256": hashlib.sha256(b"{}").hexdigest(),
            "artifact_size_bytes": 2,
            "trust_level": "local_snapshot",
            "confidence": "confirmed",
            "modules": ["runtime_auth"],
            "finding_ids": ["P0-01"],
            "certification_tags": [],
        }],
    }


def test_evidence_schema_is_closed_and_requires_the_locked_record_fields() -> None:
    schema = load_json("evidence.schema.json")
    record = schema["$defs"]["evidence_record"]
    finding = schema["$defs"]["finding_record"]
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["additionalProperties"] is False
    assert record["additionalProperties"] is False
    assert set(record["required"]) == EVIDENCE_FIELDS
    assert set(record["properties"]) == EVIDENCE_FIELDS
    assert record["properties"]["trust_level"]["enum"] == [
        "local_snapshot", "pr_local", "trusted_push", "release_drill"
    ]
    assert record["properties"]["artifact_size_bytes"] == {
        "type": ["integer", "null"], "minimum": 0
    }
    certification_rule = record["allOf"][0]
    assert certification_rule["if"]["properties"]["certification_tags"] == {
        "minItems": 1
    }
    assert set(certification_rule["then"]["properties"]) == {
        "artifact_path", "artifact_sha256", "artifact_size_bytes"
    }
    assert finding["additionalProperties"] is False
    assert set(finding["required"]) == FINDING_FIELDS
    assert set(finding["properties"]) == FINDING_FIELDS


def test_score_policy_locks_modules_dimensions_formula_thresholds_and_caps() -> None:
    policy = load_json("score-policy.json")
    assert set(policy["modules"]) == MODULE_IDS
    assert policy["dimensions"] == {
        "completeness": {"minimum": 0, "maximum": 20},
        "integrity": {"minimum": 0, "maximum": 20},
        "verification": {"minimum": 0, "maximum": 20},
        "operability": {"minimum": 0, "maximum": 20},
        "maintainability": {"minimum": 0, "maximum": 20},
    }
    assert policy["formula"]["module_composite"] == (
        "0.4*((completeness+integrity)/40*100)+"
        "0.6*((verification+operability+maintainability)/60*100)"
    )
    assert policy["thresholds"] == {
        "backend_composite_minimum": 95.0,
        "module_composite_minimum": 90.0,
        "p0_maximum": 0,
        "release_blocker_maximum": 0,
        "critical_xfail_maximum": 0,
    }
    assert policy["hard_caps"] == {
        "data_loss_authorization_path_escape_or_unrecoverable_p0": 69,
        "release_blocker_or_missing_rollback": 89,
        "missing_restore_drill_exact_sha_ci_or_digest_evidence": 94,
    }


def test_closed_semantic_validator_rejects_each_tampered_field(tmp_path: Path) -> None:
    contract = load_evidence_contract()
    valid = valid_envelope(tmp_path)
    tamper_cases = {
        "top-level extra": lambda value: value.update({"extra": True}),
        "wrong schema version": lambda value: value.update({"schema_version": "2.0"}),
        "duplicate evidence id": lambda value: value["records"].append(value["records"][0]),
        "invalid evidence id": lambda value: value["records"][0].update(evidence_id="bad"),
        "empty command": lambda value: value["records"][0].update(command=""),
        "empty cwd": lambda value: value["records"][0].update(cwd=""),
        "runtime extra": lambda value: value["records"][0]["runtime"].update(extra="x"),
        "timestamp without offset": lambda value: value["records"][0].update(started_at="2026-07-14T00:00:00"),
        "timestamp with a space separator": lambda value: value["records"][0].update(started_at="2026-07-14 00:00:00+00:00"),
        "timestamp with offset seconds": lambda value: value["records"][0].update(started_at="2026-07-14T00:00:00+00:00:01"),
        "invalid calendar date": lambda value: value["records"][0].update(started_at="2026-02-30T00:00:00Z"),
        "time reversal": lambda value: value["records"][0].update(finished_at="2026-07-13T23:59:59+00:00"),
        "passed nonzero": lambda value: value["records"][0].update(exit_code=1),
        "failed zero": lambda value: value["records"][0].update(result="failed"),
        "not-run integer exit": lambda value: value["records"][0].update(result="not_run"),
        "unverified integer exit": lambda value: value["records"][0].update(result="unverified"),
        "boolean exit": lambda value: value["records"][0].update(exit_code=False),
        "empty runtime name": lambda value: value["records"][0]["runtime"].update(name=""),
        "invalid confidence": lambda value: value["records"][0].update(confidence="likely"),
        "unknown module": lambda value: value["records"][0].update(modules=["unknown"]),
        "duplicate module": lambda value: value["records"][0].update(modules=["runtime_auth", "runtime_auth"]),
        "unknown finding": lambda value: value["records"][0].update(finding_ids=["P0-99"]),
        "duplicate tag": lambda value: value["records"][0].update(certification_tags=["exact_sha_ci", "exact_sha_ci"]),
        "absolute artifact": lambda value: value["records"][0].update(artifact_path="/tmp/out.json"),
        "drive artifact": lambda value: value["records"][0].update(artifact_path="C:/out.json"),
        "parent artifact": lambda value: value["records"][0].update(artifact_path="../out.json"),
        "backslash artifact": lambda value: value["records"][0].update(artifact_path="logs\\out.json"),
        "encoded slash artifact": lambda value: value["records"][0].update(artifact_path="logs%2Fout.json"),
        "encoded backslash artifact": lambda value: value["records"][0].update(artifact_path="logs%5Cout.json"),
        "double-encoded separator artifact": lambda value: value["records"][0].update(artifact_path="logs%252Fout.json"),
        "artifact query": lambda value: value["records"][0].update(artifact_path="artifact.json?download=1"),
        "artifact fragment": lambda value: value["records"][0].update(artifact_path="artifact.json#sha"),
        "wrong external authority": lambda value: value["records"][0].update(artifact_path="external://other/out.json"),
        "tag without artifact": lambda value: value["records"][0].update(
            artifact_path=None,
            artifact_sha256=None,
            artifact_size_bytes=None,
            certification_tags=["exact_sha_ci"],
        ),
    }
    for name, tamper in tamper_cases.items():
        candidate = copy.deepcopy(valid)
        tamper(candidate)
        with pytest.raises(ValueError, match="evidence"):
            contract.validate_evidence_envelope(
                candidate,
                expected_subject_sha=AUDITED_SHA,
                known_modules=MODULE_IDS,
                known_findings={"P0-01"},
            )


def test_bundle_resolver_rejects_symlink_escape(tmp_path: Path) -> None:
    contract = load_evidence_contract()
    root = tmp_path / "bundle"
    outside = tmp_path / "outside.json"
    root.mkdir()
    outside.write_text("{}", encoding="utf-8")
    link = root / "linked.json"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("host cannot create test symlinks")
    with pytest.raises(ValueError, match="symlink|escapes"):
        contract.resolve_bundle_artifact(root, "linked.json")


@pytest.mark.parametrize(
    "uri",
    [
        "external://pomodoroxii-test-artifacts/run-a/out%2Flog.json",
        "external://pomodoroxii-test-artifacts/run-a/out%5Clog.json",
        "external://pomodoroxii-test-artifacts/run-a/out%252Flog.json",
        "external://pomodoroxii-test-artifacts/run-a/log.json?download=1",
        "external://pomodoroxii-test-artifacts/run-a/log.json#sha",
    ],
)
def test_external_resolver_rejects_encoded_or_delimited_paths(
    tmp_path: Path, uri: str
) -> None:
    contract = load_evidence_contract()
    root = tmp_path / "pomodoroxii-test-artifacts"
    root.mkdir()
    with pytest.raises(ValueError, match="external|encoded|delimited"):
        contract.resolve_external_artifact(root, uri)
```

- [ ] **Step 2: Run the tests and verify they fail**

Run from the repository root; this independent block enters `backend/` itself:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_audit_evidence.py -p no:cacheprovider
```

Expected: FAIL with `FileNotFoundError` for `audit/95plus/evidence.schema.json`.

- [ ] **Step 3: Add the minimal closed schema and policy**

Create `backend/audit/95plus/evidence.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pomodoroxii.local/audit/95plus/evidence.schema.json",
  "title": "PomodoroXII Backend 95+ Evidence Envelope",
  "type": "object",
  "required": ["schema_version", "records"],
  "properties": {
    "schema_version": {"const": "1.0"},
    "records": {
      "type": "array",
      "minItems": 1,
      "items": {"$ref": "#/$defs/evidence_record"}
    },
    "findings": {
      "type": "array",
      "items": {"$ref": "#/$defs/finding_record"}
    }
  },
  "additionalProperties": false,
  "$defs": {
    "evidence_record": {
      "type": "object",
      "required": [
        "evidence_id", "subject_sha", "command", "cwd", "runtime",
        "started_at", "finished_at", "exit_code", "result",
        "artifact_path", "artifact_sha256", "artifact_size_bytes",
        "trust_level", "confidence", "modules", "finding_ids",
        "certification_tags"
      ],
      "properties": {
        "evidence_id": {"type": "string", "pattern": "^EV-[A-Z0-9-]+$"},
        "subject_sha": {"type": "string", "pattern": "^[0-9a-f]{40}$"},
        "command": {"type": "string", "minLength": 1},
        "cwd": {"type": "string", "minLength": 1},
        "runtime": {
          "type": "object",
          "required": ["name", "version", "platform"],
          "properties": {
            "name": {"type": "string", "minLength": 1},
            "version": {"type": "string", "minLength": 1},
            "platform": {"type": "string", "minLength": 1}
          },
          "additionalProperties": false
        },
        "started_at": {"type": "string", "format": "date-time"},
        "finished_at": {"type": "string", "format": "date-time"},
        "exit_code": {"type": ["integer", "null"]},
        "result": {
          "enum": ["passed", "failed", "not_run", "unverified"]
        },
        "artifact_path": {
          "oneOf": [
            {"type": "string", "minLength": 1},
            {"type": "null"}
          ]
        },
        "artifact_sha256": {
          "oneOf": [
            {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            {"type": "null"}
          ]
        },
        "artifact_size_bytes": {"type": ["integer", "null"], "minimum": 0},
        "trust_level": {
          "enum": ["local_snapshot", "pr_local", "trusted_push", "release_drill"]
        },
        "confidence": {"enum": ["confirmed", "inferred", "unverified"]},
        "modules": {
          "type": "array",
          "items": {"type": "string"},
          "minItems": 1,
          "uniqueItems": true
        },
        "finding_ids": {
          "type": "array",
          "items": {"type": "string", "pattern": "^P[01]-[0-9]{2}$"},
          "uniqueItems": true
        },
        "certification_tags": {
          "type": "array",
          "items": {
            "enum": ["restore_drill", "exact_sha_ci", "image_digest"]
          },
          "uniqueItems": true
        }
      },
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {"certification_tags": {"minItems": 1}},
            "required": ["certification_tags"]
          },
          "then": {
            "properties": {
              "artifact_path": {"type": "string", "minLength": 1},
              "artifact_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
              "artifact_size_bytes": {"type": "integer", "minimum": 0}
            }
          }
        }
      ]
    },
    "finding_record": {
      "type": "object",
      "required": [
        "finding_id", "severity", "status", "classification",
        "release_blocker", "modules", "evidence_ids"
      ],
      "properties": {
        "finding_id": {"type": "string", "pattern": "^P[01]-[0-9]{2}$"},
        "severity": {"enum": ["P0", "P1"]},
        "status": {"enum": ["open", "closed"]},
        "classification": {"enum": ["confirmed", "inferred", "unverified"]},
        "release_blocker": {"type": "boolean"},
        "modules": {
          "type": "array",
          "items": {"type": "string"},
          "minItems": 1,
          "uniqueItems": true
        },
        "evidence_ids": {
          "type": "array",
          "items": {"type": "string", "pattern": "^EV-[A-Z0-9-]+$"},
          "minItems": 1,
          "uniqueItems": true
        }
      },
      "additionalProperties": false
    }
  }
}
```

Create `backend/app/audit/__init__.py` and `backend/app/audit/evidence_contract.py`. The latter is the semantic authority behind the JSON Schema; S5 writers and S6 consumers import it instead of reproducing a subset. Import `re`, `datetime`, `PurePosixPath`, and `urlsplit` from their standard-library modules. It exposes exactly the envelope validator plus the two artifact resolvers. Timestamp acceptance uses one strict lexical profile before semantic parsing:

```python
RFC3339_PATTERN = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]"
    r"(?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"
)


def parse_rfc3339(value: object, *, field: str) -> datetime:
    if not isinstance(value, str) or RFC3339_PATTERN.fullmatch(value) is None:
        raise ValueError(f"evidence {field} must be strict RFC 3339")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError as exc:
        raise ValueError(f"evidence {field} is not a real RFC 3339 instant") from exc
    if parsed.utcoffset() is None:
        raise ValueError(f"evidence {field} requires an explicit offset")
    return parsed


def validate_evidence_envelope(
    envelope: Mapping[str, Any],
    *,
    expected_subject_sha: str,
    known_modules: Collection[str],
    known_findings: Collection[str],
) -> tuple[Mapping[str, Any], ...]: ...


def _validated_relative_parts(value: str, *, field: str) -> tuple[str, ...]:
    if any(marker in value for marker in ("%", "?", "#", "\\")):
        raise ValueError(f"invalid encoded or delimited {field}: {value}")
    relative = PurePosixPath(value)
    if (
        relative.is_absolute()
        or not relative.parts
        or ":" in relative.parts[0]
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise ValueError(f"invalid {field}: {value}")
    return relative.parts


def resolve_bundle_artifact(artifact_root: Path, artifact_path: str) -> Path:
    root = artifact_root.expanduser().resolve(strict=True)
    parts = _validated_relative_parts(artifact_path, field="evidence artifact path")
    unresolved = root.joinpath(*parts)
    probe = root
    for part in parts:
        probe = probe / part
        if probe.is_symlink():
            raise ValueError(f"evidence artifact uses a symlink: {artifact_path}")
    candidate = unresolved.resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"evidence artifact escapes bundle: {artifact_path}") from exc
    if not candidate.is_file():
        raise ValueError(f"evidence artifact is not a regular file: {artifact_path}")
    return candidate


def resolve_external_artifact(external_root: Path, artifact_uri: str) -> Path:
    root = external_root.expanduser().resolve(strict=True)
    if not root.is_dir() or root.name != "pomodoroxii-test-artifacts":
        raise ValueError("external artifact root is not the dedicated directory")
    parsed = urlsplit(artifact_uri)
    if (
        parsed.scheme != "external"
        or parsed.netloc != "pomodoroxii-test-artifacts"
        or parsed.query
        or parsed.fragment
        or "%" in artifact_uri
    ):
        raise ValueError(f"invalid external artifact URI: {artifact_uri}")
    parts = _validated_relative_parts(
        parsed.path.removeprefix("/"), field="external artifact path"
    )
    return resolve_bundle_artifact(root, PurePosixPath(*parts).as_posix())
```

`validate_evidence_envelope()` is implemented with the Python standard library and enforces every rule below before returning immutable/deep-copied records:

- the envelope key set is exactly `schema_version,records` or exactly `schema_version,records,findings`; version is `1.0`, `records` is a nonempty list, and evidence IDs are unique;
- every record key set equals `EVIDENCE_FIELDS`; `evidence_id` matches `^EV-[A-Z0-9-]+$`; the subject equals the full expected lowercase SHA; `command`/`cwd` are nonempty strings; `runtime` has exactly nonempty string `name,version,platform`;
- timestamps first match `RFC3339_PATTERN`, then parse through `parse_rfc3339`, carry an explicit UTC offset, and satisfy aware-instant `started_at <= finished_at`; space separators, offset seconds, impossible calendar dates, and every other `datetime.fromisoformat` extension outside this profile are rejected; booleans are never accepted as integers;
- `passed` requires exit `0`, `failed` requires a nonzero integer, and `not_run|unverified` require `null`; trust, confidence, and certification tags use only their closed enums;
- `artifact_path` is either `null` together with null hash/size, a POSIX bundle/repository-relative path, or `external://pomodoroxii-test-artifacts/<nonempty-posix-path>`; all absolute/drive/UNC/backslash/empty/dot/parent segments, query/fragment, percent encoding (including encoded or double-encoded separators), and any other external authority are rejected before any decode. A nonnull path requires lowercase SHA-256 and a nonnegative non-boolean byte size; nonempty `certification_tags` additionally require the complete nonnull artifact/hash/size triple;
- `modules`, `finding_ids`, and `certification_tags` are lists of unique strings; modules are nonempty and all module/finding IDs belong to the supplied closed sets;
- optional findings have exactly `FINDING_FIELDS`, unique known IDs, severity matching their ID prefix, closed status/classification, a boolean release blocker, nonempty unique known modules, and nonempty unique evidence IDs that resolve inside this envelope.

The two resolvers share `_validated_relative_parts`; there is no verifier-local URI parser and no second decode path. Both resolve with `strict=True`, reject every symlink component, require a regular file, and re-check containment. They return a path only; callers must independently compute and compare both hash and byte size before adding that record's ID to the verified-artifact set. A certification tag is never trusted merely because its record is schema-valid.

Create `backend/audit/95plus/score-policy.json`:

```json
{
  "schema_version": "1.0",
  "modules": [
    "runtime_auth",
    "migration_space_lifecycle",
    "registry_meta",
    "entity_commands",
    "sync_push",
    "sync_pull_recovery",
    "notes_fs",
    "deploy_operations",
    "mcp"
  ],
  "dimensions": {
    "completeness": {"minimum": 0, "maximum": 20},
    "integrity": {"minimum": 0, "maximum": 20},
    "verification": {"minimum": 0, "maximum": 20},
    "operability": {"minimum": 0, "maximum": 20},
    "maintainability": {"minimum": 0, "maximum": 20}
  },
  "formula": {
    "maturity": "(completeness+integrity)/40*100",
    "health": "(verification+operability+maintainability)/60*100",
    "module_composite": "0.4*((completeness+integrity)/40*100)+0.6*((verification+operability+maintainability)/60*100)",
    "backend_composite": "arithmetic_mean(module_composite)"
  },
  "thresholds": {
    "backend_composite_minimum": 95.0,
    "module_composite_minimum": 90.0,
    "p0_maximum": 0,
    "release_blocker_maximum": 0,
    "critical_xfail_maximum": 0
  },
  "hard_caps": {
    "data_loss_authorization_path_escape_or_unrecoverable_p0": 69,
    "release_blocker_or_missing_rollback": 89,
    "missing_restore_drill_exact_sha_ci_or_digest_evidence": 94
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_audit_evidence.py -p no:cacheprovider
```

Expected: schema/policy tests and the closed semantic/path tamper table pass. The symlink case may skip only when the host cannot create a test symlink; no lexical escape is skipped.

- [ ] **Step 5: Commit**

```powershell
Set-Location backend
git add audit/95plus/evidence.schema.json audit/95plus/score-policy.json app/audit/__init__.py app/audit/evidence_contract.py tests/test_audit_evidence.py
git commit -m "test: lock backend 95plus evidence contract"
```

### Task 3: Add The Baseline Worksheet And Machine Verifier

**Files:**
- Create: `backend/audit/95plus/baseline.json`
- Create: `backend/scripts/verify_95plus_baseline.py`
- Consume unchanged: `backend/app/audit/evidence_contract.py`
- Modify: `backend/tests/test_audit_evidence.py`

**Interfaces:**
- Consumes: detached-subject Task 1 receipts plus the Task 2 schema, semantic validator, module policy, and 14 locked evidence IDs.
- Produces: the audited worksheet and `verify_baseline(root) -> VerificationSummary`, including artifact containment/rehash and exact score recomputation.

- [ ] **Step 1: Write failing arithmetic, classification, and subject-lock tests**

Append to `backend/tests/test_audit_evidence.py`:

```python
import importlib.util
import inspect
import sys
from decimal import Decimal

import pytest


def load_verifier():
    path = Path(__file__).resolve().parents[1] / "scripts" / "verify_95plus_baseline.py"
    spec = importlib.util.spec_from_file_location("verify_95plus_baseline", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_baseline_subject_modules_findings_and_scores_are_locked() -> None:
    baseline = load_json("baseline.json")
    assert baseline["audited_subject_sha"] == "d20f200a95c25c25b1572da1781fde55560cdce0"
    assert baseline["saved_remote_sha"] == "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
    assert set(baseline["modules"]) == MODULE_IDS
    assert {item["finding_id"] for item in baseline["findings"]} == {
        *(f"P0-{index:02d}" for index in range(1, 8)),
        *(f"P1-{index:02d}" for index in range(1, 14)),
    }
    assert {item["classification"] for item in baseline["findings"]} <= {
        "confirmed", "inferred", "unverified"
    }
    verifier = load_verifier()
    summary = verifier.verify_baseline(AUDIT_ROOT)
    assert summary.raw_backend_composite == Decimal("75.88888888888888888888888889")
    assert summary.claimable_score == Decimal("69")


def test_every_module_and_finding_points_to_known_evidence() -> None:
    baseline = load_json("baseline.json")
    known = {item["evidence_id"] for item in baseline["evidence"]}
    assert known == EXPECTED_BASELINE_EVIDENCE_IDS
    for module in baseline["modules"].values():
        assert set(module["evidence_ids"]) <= known
        assert module["evidence_ids"]
    for finding in baseline["findings"]:
        assert set(finding["evidence_ids"]) <= known
        assert finding["evidence_ids"]


def test_baseline_provenance_never_branches_on_evidence_id() -> None:
    verifier = load_verifier()
    source = inspect.getsource(verifier.verify_baseline)
    assert 'startswith("EV-SOURCE-")' not in source
    assert "_contained_repository_path" not in source


def test_verifier_checks_artifact_size_in_addition_to_sha256() -> None:
    verifier = load_verifier()
    record = {
        "evidence_id": "EV-SIZE-CHECK",
        "artifact_size_bytes": 4,
        "artifact_sha256": "0" * 64,
    }
    with pytest.raises(ValueError, match="artifact size mismatch"):
        verifier._require_fingerprint(record, actual_size=5, actual_hash="0" * 64)


@pytest.mark.parametrize("invalid", [True, "20", 19.9])
def test_score_dimensions_require_exact_non_boolean_integers(invalid: object) -> None:
    verifier = load_verifier()
    dimensions = {name: 20 for name in verifier.DIMENSIONS}
    dimensions["verification"] = invalid
    with pytest.raises(ValueError, match="non-Boolean integers"):
        verifier.score_module(dimensions)


def test_local_and_pr_evidence_cannot_lift_certification_cap() -> None:
    verifier = load_verifier()
    low_trust = [
        {
            "evidence_id": f"EV-LOW-{index}",
            "result": "passed",
            "confidence": "confirmed",
            "trust_level": trust,
            "certification_tags": [tag],
            "artifact_path": f"low-{index}.json",
            "artifact_sha256": "a" * 64,
            "artifact_size_bytes": 1,
        }
        for index, (trust, tag) in enumerate([
            ("local_snapshot", "restore_drill"),
            ("pr_local", "exact_sha_ci"),
            ("pr_local", "image_digest"),
        ])
    ]
    low_ids = {item["evidence_id"] for item in low_trust}
    assert verifier.effective_cap([], low_trust, low_ids) == 94

    trusted = [
        {
            "evidence_id": "EV-TRUSTED-CI",
            "result": "passed",
            "confidence": "confirmed",
            "trust_level": "trusted_push",
            "certification_tags": ["exact_sha_ci", "image_digest"],
            "artifact_path": "trusted-ci.json",
            "artifact_sha256": "b" * 64,
            "artifact_size_bytes": 1,
        },
        {
            "evidence_id": "EV-TRUSTED-DRILL",
            "result": "passed",
            "confidence": "confirmed",
            "trust_level": "release_drill",
            "certification_tags": ["restore_drill"],
            "artifact_path": "trusted-drill.json",
            "artifact_sha256": "c" * 64,
            "artifact_size_bytes": 1,
        },
    ]
    trusted_ids = {item["evidence_id"] for item in trusted}
    assert verifier.effective_cap([], trusted, trusted_ids) is None
    assert verifier.effective_cap([], trusted, {"EV-TRUSTED-CI"}) == 94


def test_certification_tags_without_a_verified_artifact_cannot_lift_cap() -> None:
    verifier = load_verifier()
    record = {
        "evidence_id": "EV-UNBACKED-DRILL",
        "result": "passed",
        "confidence": "confirmed",
        "trust_level": "release_drill",
        "certification_tags": ["restore_drill", "exact_sha_ci", "image_digest"],
        "artifact_path": None,
        "artifact_sha256": None,
        "artifact_size_bytes": None,
    }
    assert verifier.effective_cap([], [record], set()) == 94
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_audit_evidence.py -p no:cacheprovider
```

Expected: FAIL with `FileNotFoundError` for `audit/95plus/baseline.json`.

- [ ] **Step 3: Implement the verifier and populate all baseline records**

Create `backend/scripts/verify_95plus_baseline.py` with these complete validation rules:

```python
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path, PurePosixPath
from typing import Any, Collection, Mapping

from app.audit.evidence_contract import resolve_external_artifact, validate_evidence_envelope

AUDITED_SHA = "d20f200a95c25c25b1572da1781fde55560cdce0"
REMOTE_SHA = "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
DIMENSIONS = (
    "completeness", "integrity", "verification", "operability", "maintainability"
)
EVIDENCE_FIELDS = {
    "evidence_id", "subject_sha", "command", "cwd", "runtime",
    "started_at", "finished_at", "exit_code", "result", "artifact_path",
    "artifact_sha256", "artifact_size_bytes", "trust_level", "confidence",
    "modules", "finding_ids", "certification_tags",
}
TRUST_LEVELS = {"local_snapshot", "pr_local", "trusted_push", "release_drill"}
CERTIFICATION_TRUST = {
    "restore_drill": {"release_drill"},
    "exact_sha_ci": {"trusted_push", "release_drill"},
    "image_digest": {"trusted_push", "release_drill"},
}
FINDING_FIELDS = {
    "finding_id", "severity", "status", "classification", "release_blocker",
    "modules", "evidence_ids",
}
BASELINE_FIELDS = {
    "schema_version", "audited_subject_sha", "saved_remote_sha", "modules",
    "findings", "evidence", "retained_artifact_debt",
}
EXPECTED_BASELINE_EVIDENCE_IDS = {
    "EV-SOURCE-RUNTIME-AUTH", "EV-SOURCE-MIGRATION", "EV-SOURCE-REGISTRY",
    "EV-SOURCE-ENTITY", "EV-SOURCE-SYNC", "EV-SOURCE-NOTES",
    "EV-SOURCE-DELIVERY", "EV-SOURCE-MCP", "EV-COLLECT", "EV-RUFF",
    "EV-FOCUSED-AUTH", "EV-FOCUSED-SYNC", "EV-FOCUSED-MIGRATION",
    "EV-GITHUB-CI",
}


@dataclass(frozen=True, slots=True)
class VerificationSummary:
    raw_backend_composite: Decimal
    claimable_score: Decimal
    module_scores: Mapping[str, Decimal]


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _file_fingerprint(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _git_blob_fingerprint(
    repository_root: Path, subject_sha: str, value: str
) -> tuple[int, str]:
    relative = PurePosixPath(value)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise ValueError(f"invalid Git artifact path: {value}")
    completed = subprocess.run(
        ["git", "show", f"{subject_sha}:{relative.as_posix()}"],
        cwd=repository_root,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        raise ValueError(f"Git artifact is absent from audited subject: {value}")
    return len(completed.stdout), hashlib.sha256(completed.stdout).hexdigest()


def _require_fingerprint(
    record: Mapping[str, Any], actual_size: int, actual_hash: str
) -> None:
    if actual_size != record["artifact_size_bytes"]:
        raise ValueError(f"artifact size mismatch: {record['evidence_id']}")
    if actual_hash != record["artifact_sha256"]:
        raise ValueError(f"artifact hash mismatch: {record['evidence_id']}")


def _configured_external_root() -> Path:
    configured = os.environ.get("POMODOROXII_TEST_ARTIFACTS_ROOT")
    if not configured:
        raise ValueError("POMODOROXII_TEST_ARTIFACTS_ROOT is required")
    root = Path(configured).expanduser().resolve(strict=True)
    if not root.is_dir() or root.name != "pomodoroxii-test-artifacts":
        raise ValueError("external artifact root must be the configured dedicated directory")
    return root


def score_module(dimensions: Mapping[str, int]) -> Decimal:
    if set(dimensions) != set(DIMENSIONS):
        raise ValueError("module dimensions do not match score policy")
    values = [dimensions[name] for name in DIMENSIONS]
    if any(type(value) is not int or not 0 <= value <= 20 for value in values):
        raise ValueError("module dimensions must be non-Boolean integers within 0..20")
    maturity = Decimal(values[0] + values[1]) / Decimal(40) * Decimal(100)
    health = Decimal(sum(values[2:])) / Decimal(60) * Decimal(100)
    return Decimal("0.4") * maturity + Decimal("0.6") * health


def score_backend(module_scores: list[Decimal]) -> Decimal:
    if len(module_scores) != 9:
        raise ValueError("backend score requires exactly nine modules")
    return sum(module_scores, Decimal(0)) / Decimal(9)


def effective_cap(
    findings: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    verified_artifact_ids: Collection[str],
) -> int | None:
    if any(item["severity"] == "P0" and item["status"] == "open" for item in findings):
        return 69
    if any(item.get("release_blocker") is True and item["status"] == "open" for item in findings):
        return 89
    for item in evidence:
        if set(item.get("certification_tags", [])) - set(CERTIFICATION_TRUST):
            raise ValueError("unknown certification tag")
    required = {"restore_drill", "exact_sha_ci", "image_digest"}
    proven = {
        tag
        for item in evidence
        if (
            item["evidence_id"] in verified_artifact_ids
            and item["artifact_path"] is not None
            and item["artifact_sha256"] is not None
            and type(item["artifact_size_bytes"]) is int
            and item["artifact_size_bytes"] >= 0
            and item["result"] == "passed"
            and item["confidence"] == "confirmed"
        )
        for tag in item.get("certification_tags", [])
        if item["trust_level"] in CERTIFICATION_TRUST[tag]
    }
    return None if required <= proven else 94


def verify_baseline(audit_root: Path) -> VerificationSummary:
    baseline = _load(audit_root / "baseline.json")
    policy = _load(audit_root / "score-policy.json")
    if set(baseline) != BASELINE_FIELDS or baseline["schema_version"] != "1.0":
        raise ValueError("invalid baseline top-level schema")
    if baseline["audited_subject_sha"] != AUDITED_SHA:
        raise ValueError("audited subject SHA changed")
    if baseline["saved_remote_sha"] != REMOTE_SHA:
        raise ValueError("saved remote SHA changed")
    if list(baseline["modules"]) != policy["modules"]:
        raise ValueError("module order or identity changed")
    evidence_ids = [item["evidence_id"] for item in baseline["evidence"]]
    if len(evidence_ids) != len(set(evidence_ids)):
        raise ValueError("duplicate evidence_id")
    if set(evidence_ids) != EXPECTED_BASELINE_EVIDENCE_IDS:
        raise ValueError("baseline evidence ID set changed")
    known = set(evidence_ids)
    module_scores: dict[str, Decimal] = {}
    for module_id, worksheet in baseline["modules"].items():
        if not worksheet["evidence_ids"] or not set(worksheet["evidence_ids"]) <= known:
            raise ValueError(f"invalid module evidence: {module_id}")
        score = score_module(worksheet["dimensions"])
        if score != Decimal(str(worksheet["composite"])):
            raise ValueError(f"stored composite drift: {module_id}")
        module_scores[module_id] = score
    finding_ids = [item["finding_id"] for item in baseline["findings"]]
    if len(finding_ids) != 20 or len(finding_ids) != len(set(finding_ids)):
        raise ValueError("baseline must contain seven P0 and thirteen P1 findings")
    records = validate_evidence_envelope(
        {
            "schema_version": "1.0",
            "records": baseline["evidence"],
            "findings": baseline["findings"],
        },
        expected_subject_sha=AUDITED_SHA,
        known_modules=set(policy["modules"]),
        known_findings=set(finding_ids),
    )
    for finding in baseline["findings"]:
        if set(finding) != FINDING_FIELDS:
            raise ValueError(f"invalid finding fields: {finding['finding_id']}")
        if finding["classification"] not in {"confirmed", "inferred", "unverified"}:
            raise ValueError(f"invalid classification: {finding['finding_id']}")
        if not finding["evidence_ids"] or not set(finding["evidence_ids"]) <= known:
            raise ValueError(f"invalid finding evidence: {finding['finding_id']}")
    repository_root = audit_root.parents[2].resolve()
    external_root: Path | None = None
    verified_artifact_ids: set[str] = set()
    for record in records:
        artifact = record["artifact_path"]
        expected_hash = record["artifact_sha256"]
        expected_size = record["artifact_size_bytes"]
        if artifact is None:
            if expected_hash is not None or expected_size is not None:
                raise ValueError(f"fingerprint without artifact: {record['evidence_id']}")
            continue
        if (
            expected_hash is None
            or not isinstance(expected_size, int)
            or isinstance(expected_size, bool)
            or expected_size < 0
        ):
            raise ValueError(f"artifact without valid fingerprint: {record['evidence_id']}")
        if artifact.startswith("external://"):
            external_root = external_root or _configured_external_root()
            actual_size, actual_hash = _file_fingerprint(
                resolve_external_artifact(external_root, artifact)
            )
        else:
            actual_size, actual_hash = _git_blob_fingerprint(
                repository_root, AUDITED_SHA, artifact
            )
        _require_fingerprint(record, actual_size, actual_hash)
        verified_artifact_ids.add(record["evidence_id"])
    raw = score_backend(list(module_scores.values()))
    cap = effective_cap(
        baseline["findings"], list(records), verified_artifact_ids
    )
    claimable = raw if cap is None else min(raw, Decimal(cap))
    return VerificationSummary(raw, claimable, module_scores)


def main() -> int:
    root = Path(__file__).resolve().parents[1] / "audit" / "95plus"
    summary = verify_baseline(root)
    print(
        "VERIFY_OK "
        f"raw={summary.raw_backend_composite.quantize(Decimal('0.1'))} "
        f"claimable={summary.claimable_score} modules={len(summary.module_scores)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Create `backend/audit/95plus/baseline.json` with the following locked worksheet values and then add the 20 finding records and Task 1 evidence receipts. Do not change these dimension totals to make the baseline look better:

```json
{
  "schema_version": "1.0",
  "audited_subject_sha": "d20f200a95c25c25b1572da1781fde55560cdce0",
  "saved_remote_sha": "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f",
  "modules": {
    "runtime_auth": {"dimensions": {"completeness": 17, "integrity": 17, "verification": 17, "operability": 15, "maintainability": 16}, "composite": 82, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-RUNTIME-AUTH", "EV-FOCUSED-AUTH"]},
    "migration_space_lifecycle": {"dimensions": {"completeness": 17, "integrity": 16, "verification": 16, "operability": 15, "maintainability": 17}, "composite": 81, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-MIGRATION", "EV-FOCUSED-MIGRATION"]},
    "registry_meta": {"dimensions": {"completeness": 18, "integrity": 18, "verification": 18, "operability": 16, "maintainability": 17}, "composite": 87, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-REGISTRY", "EV-FOCUSED-MIGRATION"]},
    "entity_commands": {"dimensions": {"completeness": 16, "integrity": 15, "verification": 15, "operability": 14, "maintainability": 16}, "composite": 76, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-ENTITY", "EV-COLLECT"]},
    "sync_push": {"dimensions": {"completeness": 17, "integrity": 17, "verification": 17, "operability": 15, "maintainability": 16}, "composite": 82, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-SYNC", "EV-FOCUSED-SYNC"]},
    "sync_pull_recovery": {"dimensions": {"completeness": 15, "integrity": 15, "verification": 15, "operability": 14, "maintainability": 15}, "composite": 74, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-SYNC", "EV-FOCUSED-SYNC"]},
    "notes_fs": {"dimensions": {"completeness": 16, "integrity": 16, "verification": 16, "operability": 14, "maintainability": 16}, "composite": 78, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-NOTES", "EV-FOCUSED-MIGRATION"]},
    "deploy_operations": {"dimensions": {"completeness": 13, "integrity": 12, "verification": 12, "operability": 10, "maintainability": 11}, "composite": 58, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-DELIVERY", "EV-GITHUB-CI"]},
    "mcp": {"dimensions": {"completeness": 14, "integrity": 13, "verification": 13, "operability": 12, "maintainability": 13}, "composite": 65, "confidence": "inferred", "evidence_ids": ["EV-SOURCE-MCP", "EV-FOCUSED-MIGRATION"]}
  },
  "findings": [],
  "evidence": [],
  "retained_artifact_debt": []
}
```

Populate `findings` in ID order with exactly P0-01 through P0-07 and P1-01 through P1-13. Each object uses:

```json
{
  "finding_id": "P0-01",
  "severity": "P0",
  "status": "open",
  "classification": "confirmed",
  "release_blocker": true,
  "modules": ["notes_fs", "entity_commands"],
  "evidence_ids": ["EV-SOURCE-NOTES"]
}
```

Use the approved spec's module mapping; P0 findings are `confirmed`; P1-01 through P1-10 and P1-13 are `confirmed`; supply-chain and reproducible-deployment findings P1-11 and P1-12 are `confirmed` from `.github/workflows/ci.yml`, `backend/Dockerfile`, and `backend/docker-compose.yml`. Set `release_blocker: true` on P0-01 through P0-07 and P1-11/P1-12, and `false` on the other P1 records. Add exactly the 14 IDs in `EXPECTED_BASELINE_EVIDENCE_IDS`: the eight listed `EV-SOURCE-*` records, the exact five fresh Task 1 command receipts (`EV-COLLECT`, `EV-RUFF`, and the three `EV-FOCUSED-*` records), and `EV-GITHUB-CI` with `result: "unverified"`, `exit_code: null`, `artifact_path: null`, `artifact_sha256: null`, and `artifact_size_bytes: null`. The historical `83/64/79` counts have neither exact commands nor retained output artifacts and therefore are not separate evidence records. Every S0 record has `trust_level: "local_snapshot"` and contains every locked field, including `artifact_size_bytes` and `certification_tags` (an empty array unless that exact artifact proves an allowed tag); add no other record keys. Neither `local_snapshot` nor `pr_local` evidence may satisfy a certification hard-cap tag, and no tag at any trust level counts until its nonnull artifact has passed containment plus independent size/hash verification.

For Task 1 records, copy each concrete `external://pomodoroxii-test-artifacts/...` URI, digest, and byte size from its generated JSON receipt; do not reconstruct or template any of them. Every baseline artifact that is neither `external://...` nor null is unconditionally read with `git show d20f200a95c25c25b1572da1781fde55560cdce0:<artifact_path>` and fingerprinted from those exact blob bytes; `evidence_id` never selects the provenance branch. For every source record, set `command` to that exact invocation. Never hash or size an evolving working-tree file for baseline evidence. `retained_artifact_debt` contains the measured byte count, `path: "backend/tests/pytest-of-20564"`, `observed_at` from Task 1, and `handling: "preserve"`.

- [ ] **Step 4: Run the verifier and tests**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe scripts/verify_95plus_baseline.py
.\.venv\Scripts\python.exe -m pytest -q tests/test_audit_evidence.py -p no:cacheprovider
```

Expected: verifier prints `VERIFY_OK raw=75.9 claimable=69 modules=9`; all evidence tests pass. A missing evidence ID, wrong source hash or byte size, invalid trust level/tag, score change, missing finding, or subject drift exits non-zero; a valid low-trust record may remain useful evidence but cannot lift the certification cap.

- [ ] **Step 5: Commit**

```powershell
Set-Location backend
git add audit/95plus/baseline.json scripts/verify_95plus_baseline.py tests/test_audit_evidence.py
git commit -m "docs: record backend 95plus evidence baseline"
```

### Task 4: Add Executable Coverage Tooling To The Locked Environment

**Files:**
- Modify: `backend/pyproject.toml`
- Modify: `backend/uv.lock`
- Modify: `backend/tests/test_audit_evidence.py`

**Interfaces:**
- Consumes: the existing `uv` project and S0's frozen-environment requirement.
- Produces: a lock-resolved `pytest-cov>=6.0` development dependency and an executable coverage command without altering production dependencies.

- [ ] **Step 1: Write the failing dependency contract test**

Append to `backend/tests/test_audit_evidence.py`:

```python
import tomllib


def test_development_dependencies_include_pytest_cov_6_or_newer() -> None:
    pyproject = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    )
    dev = pyproject["project"]["optional-dependencies"]["dev"]
    assert "pytest-cov>=6.0" in dev
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_audit_evidence.py::test_development_dependencies_include_pytest_cov_6_or_newer -p no:cacheprovider
```

Expected: FAIL because `pytest-cov>=6.0` is absent.

- [ ] **Step 3: Add the dependency and refresh the lock**

Add this exact entry to `[project.optional-dependencies].dev` in `backend/pyproject.toml`:

```toml
    "pytest-cov>=6.0",
```

Run:

```powershell
Set-Location backend
uv lock
uv sync --frozen --extra dev
```

Expected: `uv.lock` contains `pytest-cov` and its resolved coverage dependency; sync exits `0` without changing application dependencies outside the lock's normal resolution.

- [ ] **Step 4: Run offline lock and coverage availability checks**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
uv lock --check --offline
.\.venv\Scripts\python.exe -m pytest --help | Select-String -- '--cov-branch'
.\.venv\Scripts\python.exe -m pytest -q tests/test_audit_evidence.py -p no:cacheprovider
```

Expected: lock check exits `0`; pytest help contains `--cov-branch`; all evidence tests pass.

- [ ] **Step 5: Commit**

```powershell
Set-Location backend
git add pyproject.toml uv.lock tests/test_audit_evidence.py
git commit -m "build: add backend coverage tooling"
```

### Task 5: Make External Run-Scoped Test Sandboxes The Default

**Files:**
- Modify: `backend/tests/conftest.py`
- Modify: `backend/tests/test_test_isolation.py`

**Interfaces:**
- Consumes: optional `POMODOROXII_TEST_ARTIFACTS_ROOT` and the OS temporary directory.
- Produces: unique externally contained `run-[0-9a-f]{16}` pytest sandboxes while preserving all pre-existing retained paths.

- [ ] **Step 1: Replace the old characterization test with failing external-root tests**

Replace `test_default_artifacts_root_is_backend_local` in `backend/tests/test_test_isolation.py` with:

```python
def test_default_artifacts_root_is_dedicated_and_outside_repository(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("POMODOROXII_TEST_ARTIFACTS_ROOT", raising=False)

    resolved = suite_conftest._resolve_artifacts_root()

    assert resolved.name == "pomodoroxii-test-artifacts"
    assert resolved != suite_conftest._project_root
    assert suite_conftest._project_root not in resolved.parents


def test_existing_repository_artifacts_are_not_cleanup_targets() -> None:
    source = Path(suite_conftest.__file__).read_text(encoding="utf-8")
    assert "backend/.test-artifacts" not in source
    assert "pytest-of-" not in source
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_test_isolation.py -p no:cacheprovider
```

Expected: FAIL because `_DEFAULT_ARTIFACTS_ROOT` resolves to `backend/.test-artifacts`.

- [ ] **Step 3: Change only the default root and preserve all containment guards**

In `backend/tests/conftest.py`, import `tempfile` and replace the default root with:

```python
import tempfile

_DEFAULT_ARTIFACTS_ROOT = (
    Path(tempfile.gettempdir()) / "pomodoroxii-test-artifacts"
).resolve()
```

Update the fixture docstrings to state that new runs default to the OS temporary directory. Keep `_resolve_artifacts_root`, `_validate_run_root`, `_ensure_inside_temp_root`, the dedicated-name check, and the absence of recursive cleanup. Do not add `shutil.rmtree`, `Path.unlink`, or `Remove-Item` behavior to pytest fixtures.

- [ ] **Step 4: Run isolation and collection checks**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_test_isolation.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest --collect-only -q -p no:cacheprovider
```

Expected: isolation tests pass; collection succeeds; the new run directory is external and the pre-existing retained paths remain unchanged.

- [ ] **Step 5: Commit**

```powershell
Set-Location backend
git add tests/conftest.py tests/test_test_isolation.py
git commit -m "test: move backend sandboxes outside repository"
```

### Task 6: Freeze And Prove The N-1 Certification Fixture

**Files:**
- Create: `backend/tests/fixtures/certification/n_minus_one_manifest.json`
- Create: `backend/tests/fixtures/certification/populate_n_minus_one.py`
- Create: `backend/tests/test_n_minus_one_fixture.py`

**Interfaces:**
- Consumes: full N-1 SHA `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f`, a fresh external data root, and the frozen manifest.
- Produces: deterministic Meta/Space/Notes/index/Sync fixture state plus a rehashable `FixtureReceipt` for later restore certification.

- [ ] **Step 1: Write the failing fixture integration test**

Create `backend/tests/test_n_minus_one_fixture.py`:

```python
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest


FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "certification"


@pytest.mark.asyncio
async def test_n_minus_one_fixture_matches_manifest(tmp_path: Path) -> None:
    from tests.fixtures.certification.populate_n_minus_one import populate_fixture

    manifest_path = FIXTURE_ROOT / "n_minus_one_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    receipt = await populate_fixture(tmp_path / "n-minus-one", manifest_path)

    assert manifest["subject_sha"] == "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
    assert receipt.space_id == manifest["space_id"]
    assert receipt.entity_counts == manifest["expected"]["entity_counts"]
    assert receipt.sync_waterline == manifest["expected"]["sync_waterline"]
    assert receipt.meta_db.is_file()
    assert receipt.space_db.is_file()
    assert receipt.index_db.is_file()
    bodies = {
        note_id: hashlib.sha256(body.encode("utf-8")).hexdigest()
        for note_id, body in receipt.note_bodies.items()
    }
    assert bodies == manifest["expected"]["note_body_sha256"]
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_n_minus_one_fixture.py -p no:cacheprovider
```

Expected: FAIL with `ModuleNotFoundError` for `tests.fixtures.certification.populate_n_minus_one`.

- [ ] **Step 3: Add the pinned manifest and deterministic population program**

Create `backend/tests/fixtures/certification/n_minus_one_manifest.json`:

```json
{
  "schema_version": "1.0",
  "fixture_id": "backend-95plus-n-minus-one-v1",
  "subject_sha": "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f",
  "seed": 95001,
  "fixed_timestamp": "2026-07-01T00:00:00.000Z",
  "space_id": "spc_cert_n_minus_one",
  "expected": {
    "entity_counts": {"tasks": 1, "quick_notes": 1, "notes": 2},
    "note_body_sha256": {
      "note_cert_a": "6dfbdde5b0382b2e1fd8d636889366ff04c743a6e68343761a319e332d90fd22",
      "note_cert_b": "c5a62e7ae6bf299351331bbb9ca1535c53784489df1b32fc76886654ab1749ca"
    },
    "sync_waterline": 4
  }
}
```

Create `backend/tests/fixtures/certification/populate_n_minus_one.py` with a frozen `FixtureReceipt` dataclass and the reusable two-argument coroutine below. The reusable API must not import pytest or accept `monkeypatch`:

```python
import os
from contextlib import contextmanager
from typing import Iterator, Mapping


@dataclass(frozen=True, slots=True)
class FixtureReceipt:
    space_id: str
    meta_db: Path
    space_db: Path
    index_db: Path
    entity_counts: dict[str, int]
    note_bodies: dict[str, str]
    sync_waterline: int


_ENVIRONMENT_KEYS = (
    "POMODOROXII_DATABASE_URL",
    "POMODOROXII_SPACES_DATA_DIR",
    "POMODOROXII_ENVIRONMENT",
    "POMODOROXII_SECRET_KEY",
)
_MISSING = object()


@contextmanager
def _fixture_environment(values: Mapping[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key, _MISSING) for key in _ENVIRONMENT_KEYS}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is _MISSING:
                os.environ.pop(key, None)
            else:
                assert isinstance(value, str)
                os.environ[key] = value
```

Implement exactly `async def populate_fixture(data_root: Path, manifest_path: Path) -> FixtureReceipt`. It first asserts the manifest subject SHA and resolves a not-yet-existing `data_root`. Its outer `try/finally` owns database/filesystem cleanup. Inside that, use `_fixture_environment(...)` to set `POMODOROXII_DATABASE_URL`, `POMODOROXII_SPACES_DATA_DIR`, `POMODOROXII_ENVIRONMENT=development`, and a strong test secret, then reload the same settings-dependent module graph in the exact dependency order locked by `backend/tests/conftest.py` before importing database/services that capture settings. After the context restores all four variables, the outer `finally` reloads that same graph once more so the caller's settings singletons match the restored environment even when population or verification fails. Migrate Meta and Space through existing named migration entrypoints; insert one `Space` with the fixed ID and canonical paths; initialize `FileSystem` with `get_file_system(notes_dir, index_db)`; create these exact bodies through `NoteService`:

```python
NOTE_BODIES = {
    "note_cert_a": "# Certification Note A\n\nDeterministic body A.\n",
    "note_cert_b": "# Certification Note B\n\nDeterministic body B.\n",
}
```

Insert `Task(id="task_cert", title="N-1 task", updated_at=fixed_timestamp)` and `QuickNote(id="quick_cert", content="N-1 quick note", tags="[]", updated_at=fixed_timestamp)`. Record one Sync event for each non-Note row; `NoteService.create` records the other two events. Commit once, query counts and `get_current_cursor`, read both bodies through the filesystem Interface, close every session/engine in `finally`, and return `FixtureReceipt`. Assert the manifest's subject SHA before any write so the fixture cannot silently move to another baseline.

- [ ] **Step 4: Run the fixture and baseline tests**

Run:

```powershell
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\.venv\Scripts\python.exe -m pytest -q tests/test_n_minus_one_fixture.py tests/test_audit_evidence.py -p no:cacheprovider
```

Expected: both fixture Note hashes match exactly, counts are `1/1/2`, waterline is `4`, and all tests pass.

- [ ] **Step 5: Commit**

```powershell
Set-Location backend
git add tests/fixtures/certification/n_minus_one_manifest.json tests/fixtures/certification/populate_n_minus_one.py tests/test_n_minus_one_fixture.py
git commit -m "test: freeze backend n-minus-one fixture"
```

## S0 Exit Gate

Run from the repository root; this independent block enters `backend/` and configures its own dedicated external artifact directory:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
Set-Location backend
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
uv lock --check --offline
.\.venv\Scripts\python.exe scripts/verify_95plus_baseline.py
.\.venv\Scripts\python.exe -m pytest -q tests/test_audit_evidence.py tests/test_test_isolation.py tests/test_n_minus_one_fixture.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest --collect-only -q -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app tests
```

Expected:

- lock verification exits `0` offline;
- baseline verifier prints `VERIFY_OK raw=75.9 claimable=69 modules=9`;
- focused S0 tests pass;
- collection exits `0` and reports the new total explicitly in the S0 review evidence;
- Ruff prints `All checks passed!`;
- no new run directory exists inside the repository;
- `backend/tests/pytest-of-20564/` and every pre-existing untracked path remain unchanged.

## Review Gate

Do not merge S0 until a reviewer checks all of the following against the committed files and fresh command artifacts:

- the audited and saved-remote SHAs are the full locked values and are not replaced by the documentation carrier SHA;
- nine module IDs, five dimensions, formula, thresholds, and caps match the approved design;
- all seven P0 and thirteen P1 records have classification and valid evidence IDs;
- the baseline evidence ID set equals the locked 14 IDs, and no artifact provenance branch depends on an ID prefix;
- every current module score points to at least one source, test, or runtime artifact;
- no score is rounded before the backend arithmetic mean is evaluated;
- every score dimension is an exact non-Boolean integer in `0..20`;
- every timestamp passes the strict RFC 3339 lexical/calendar/offset/order checks;
- every nonnull artifact is resolved by the shared containment resolver and rehashed/resized; only IDs added to that verified set can contribute certification tags or lift the `94` cap;
- the old retained artifact debt is recorded but not deleted;
- the N-1 fixture is pinned throughout to `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f` and produces deterministic bodies, counts, paths, and waterline;
- the diff contains no production behavior, frontend work, unrelated report cleanup, or historical artifact deletion.

Finish the wave with one review-only commit if evidence metadata changed during review:

```powershell
Set-Location backend
git add audit/95plus/evidence.schema.json audit/95plus/score-policy.json audit/95plus/baseline.json tests/fixtures/certification/n_minus_one_manifest.json tests/fixtures/certification/populate_n_minus_one.py
git commit -m "docs: finalize backend S0 evidence receipts"
```
