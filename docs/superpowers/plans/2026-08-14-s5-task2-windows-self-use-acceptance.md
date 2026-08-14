# S5 Task 2 Windows Self-Use Acceptance

## Scope

This addendum supersedes the cross-platform release requirements for S5 Task 2
phase two. It applies only to a single-user Windows installation with one local
active data root. It does not authorize Task 3 relocation or a production
cross-platform release claim.

The threat model covers normal application failures, accidental interruption,
and stale local state. It does not make Linux-specific behavior, hostile local
administrators, or a complete backend suite a per-change delivery blocker.

## Non-Negotiable Safety Invariants

- A failed cutover must not overwrite or delete the current active root.
- A successful cutover must preserve the prior active root as rollback data.
- Snapshot, staging, and active-root paths must remain contained and reject
  symlinks or Windows reparse points.
- Staged and rollback verification remain read-only.
- Cutover must fail closed when its proof, fences, or inventory drift.

## Development Gate

Any change touching restore or cutover must pass, serially in the target
worktree virtual environment:

```powershell
python -m pytest -q backend/tests/test_recovery_cutover.py -p no:cacheprovider
python -m pytest -q backend/tests/test_recovery.py backend/tests/test_recovery_staging.py -p no:cacheprovider
python -m ruff check backend/app/recovery backend/app/file_system backend/tests/test_recovery_cutover.py
python -m compileall -q backend/app/recovery backend/app/file_system
git diff --check
```

The change must stay within the Task 2 backend and test boundary. A P0 finding
(data loss, wrong-root publication, broken rollback, or failure to start) blocks
delivery. A P1/P2 finding is recorded and scheduled unless it violates an
invariant above.

## Windows Self-Use Enablement Gate

Before enabling automatic cutover against personal data, complete the
development gate plus:

1. Confirm the existing local backup location and free disk space.
2. Run one supervised rehearsal against a disposable copy of the data root:
   snapshot, restore to staging, cutover, verify the new active root, and verify
   the preserved rollback root's manifest/hash.
3. Record the active, rollback, and snapshot paths used by the rehearsal.
4. Keep automatic cutover disabled if the rehearsal cannot complete.

No agent may run this rehearsal against a user data root without an explicitly
named target and confirmation from the user.

## Local Operator Entry Point

The offline operator is `backend/scripts/rehearse_recovery.py`. It does not
mount an HTTP route or boot the application runtime. Run it with the target
worktree's Python environment.

Verify an existing snapshot without writing to the active data root:

```powershell
python backend/scripts/rehearse_recovery.py verify-snapshot `
  --data-root E:\path\to\disposable-copy `
  --snapshot E:\path\to\published-snapshot
```

Run a rehearsal only against a disposable copy. The confirmation value must
exactly repeat `--data-root`, and `--confirm-cutover` is a separate opt-in for
the publication step:

```powershell
python backend/scripts/rehearse_recovery.py rehearse `
  --data-root E:\path\to\disposable-copy `
  --snapshot-dir E:\path\to\rehearsal-snapshots `
  --confirm-disposable-root E:\path\to\disposable-copy `
  --confirm-cutover
```

The command emits one canonical JSON receipt. Record its `snapshot_root`,
`active_root`, `rollback_root`, and `rollback_snapshot_root`. It must never be
pointed at the user's normal active root; make a filesystem copy first.

## Deferred Release Work

The following are valuable but do not block Windows self-use enablement:

- Linux CI and `renameat2(RENAME_NOREPLACE)` execution.
- Linux symlink behavior and cross-platform filesystem matrices.
- Full backend serial sharding and performance/stress runs.
- Hostile-local-administrator proof substitution scenarios beyond the current
  fail-closed proof and path checks.

These gates are required only for a later cross-platform or multi-user release.

## Status Labels

- `development-ready`: the development gate passed.
- `windows-self-use-ready`: the development gate and supervised disposable-root
  rehearsal passed.
- `cross-platform-release-ready`: all deferred work and an independent review
  passed.

Do not use a stronger label than the evidence supports.
