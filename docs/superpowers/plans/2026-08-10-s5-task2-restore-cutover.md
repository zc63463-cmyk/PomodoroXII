# S5 Task 2 Restore Cutover Implementation Plan

> **Windows self-use amendment:** For S5 Task 2 phase two, follow
> [2026-08-14-s5-task2-windows-self-use-acceptance.md](2026-08-14-s5-task2-windows-self-use-acceptance.md).
> Its Windows single-user gates supersede this plan's cross-platform exit gate.
> Task 3 relocation remains out of scope.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a verified snapshot into isolated staging, publish it through a fenced rollback-preserving cutover, and provide explicit data-root relocation without overwriting a live root.

**Architecture:** `RecoveryCoordinator` owns immutable snapshot/staging receipts and read-only staged verification. `DataRootRelocator` composes snapshot, staging, metadata rewrite, and parent-locked publication. No path mutation, runtime opening, or lease reacquisition is allowed inside the verification boundary.

**Tech Stack:** Python 3.13, asyncio, SQLAlchemy async SQLite, SQLite Online Backup API, pytest, Ruff.

## Global Constraints

- Restore never overwrites the live root; every restore starts in a unique staging directory.
- Cutover requires process-owner and global-exclusive fences and rejects a live backend with `lease_timeout` before any rename.
- Staged verification is read-only and must consume migration, index, knowledge, mutation recovery, TS2 active-session, and effort authorities.
- Cutover preserves the old root as rollback; rollback is attempted after any post-rename failure and the rollback root is never deleted by cutover.
- Relocation is explicit, target-root-contained, and does not claim cross-volume atomicity.
- No S5 Task 3+ files, frontend files, or integration baseline changes are permitted.

---

### Task 1: Immutable Restore Receipt And Staging

**Files:**
- Modify: `backend/app/recovery/contracts.py`
- Modify: `backend/app/recovery/coordinator.py`
- Modify: `backend/app/recovery/__init__.py`
- Test: `backend/tests/test_recovery.py`

**Produces:** `restore_to_staging(snapshot) -> StagedRestore` with source manifest hash, staged-tree hash, target active root, catalog hash, and source fence.

- [ ] Write failing tests for absent snapshot, manifest hash drift, traversal/symlink assets, staging outside the target parent, and preserving the live marker.
- [ ] Implement canonical snapshot receipt parsing and unique staging allocation beneath the target parent.
- [ ] Copy SQLite databases with `backup_sqlite`, copy regular Note/index assets, fsync files/directories, and reject symlinks or unexpected inventory.
- [ ] Run `_inspect_staged_root_read_only()` with TS2 `inspect_read_only(meta_view, space_views=...)`; never open a runtime writer or mutate staging during verification.
- [ ] Assert `StagedRestore` is frozen and serialized from verified facts only.
- [ ] Run `pytest -q backend/tests/test_recovery.py -k "restore or staged" -p no:cacheprovider` and commit `feat(recovery): restore snapshots to verified staging`.

### Task 2: Fenced Rollback-Preserving Cutover

**Files:**
- Modify: `backend/app/recovery/contracts.py`
- Modify: `backend/app/recovery/coordinator.py`
- Modify: `backend/app/recovery/__init__.py`
- Test: `backend/tests/test_recovery.py`

**Produces:** `cutover(staged_restore) -> CutoverResult` with exact process/global fence values and preserved rollback root.

- [ ] Write failing tests for live-owner refusal, stale staged receipt, parent lock contention, failure before rename, failure after first rename, and successful catalog/inventory verification.
- [ ] Acquire process-owner first and global-exclusive second; return stable `lease_timeout` with zero rename if either fence cannot be acquired.
- [ ] Rehash and verify the staged receipt under both fences, create a rollback snapshot using the already-held global lease, and atomically rename active root to rollback then staging to active.
- [ ] Fsync the parent and re-run read-only verification while retaining both fences; on failure reverse both renames and verify the old root.
- [ ] Return only a success receipt built from verified staged facts; preserve rollback root for a separate retention action.
- [ ] Run `pytest -q backend/tests/test_recovery.py -k "cutover or rollback or fence" -p no:cacheprovider` and commit `feat(recovery): add fenced rollback-preserving cutover`.

### Task 3: Explicit Data-Root Relocation

**Files:**
- Create: `backend/app/recovery/relocation.py`
- Modify: `backend/app/recovery/__init__.py`
- Modify: `backend/app/recovery/contracts.py`
- Test: `backend/tests/test_space_relocation.py`

**Produces:** `DataRootRelocator.relocate(target_root) -> RelocationResult` and `rewrite_staged_meta(...) -> StagedRestore`.

- [ ] Write failing tests for target containment, pre-existing target, permission failure, moved registry paths, metadata rewrite failure, stale fences, reverse rollback, and cross-volume rejection.
- [ ] Validate an absent target and acquire a parent-level publication lock without modifying the old root.
- [ ] Snapshot the old root, restore into target staging, rewrite only staged Meta `db_path` and `notes_dir` to canonical target paths, and emit a new immutable receipt.
- [ ] Re-run all staged authorities, publish target staging atomically on the target filesystem, and preserve the old root as rollback.
- [ ] Return `RelocationResult` with process/global fences, source fence, catalog hash, manifest hash, and staged-tree hash derived from receipts.
- [ ] Run `pytest -q backend/tests/test_space_relocation.py backend/tests/test_recovery.py -k "relocate or relocation" -p no:cacheprovider` and commit `feat(recovery): add explicit data-root relocation`.

### Task 4: Task 2 Exit Gate And Independent Review

**Files:**
- Modify only files listed in Tasks 1-3 if a failing gate requires it.

- [ ] Run focused restore/cutover/relocation tests serially.
- [ ] Run backend recovery, backup lifespan, migration, mutation recovery, authority, OpenAPI, Ruff, compileall, full collect, and `git diff --check`.
- [ ] Verify no frontend files, S5 Task 3+ files, or `s5-next` worktree changes are included.
- [ ] Perform an independent read-only review against this plan and record findings before declaring Task 2 complete.
- [ ] Record the final full SHA and merge only after all required gates have explicit exit code 0.
