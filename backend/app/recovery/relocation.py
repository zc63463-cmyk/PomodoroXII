"""Explicit, offline relocation of a complete PomodoroXII data root.

Relocation is deliberately a composition of the recovery coordinator's
snapshot, inventory-copy and read-only authority boundaries.  It does not use
``cutover()``: the source root remains intact, while staging and publication
occur entirely below the new target's parent.
"""

from __future__ import annotations

import shutil
import sqlite3
import uuid
from contextlib import closing
from dataclasses import replace
from pathlib import Path

from app.runtime import LeaseMode, LeaseTimeoutError

from .contracts import RelocationResult, StagedRestore
from .coordinator import DomainFailure, RecoveryCoordinator, _is_link_or_reparse
from .sqlite_copy import fsync_directory


class DataRootRelocator:
    """Move a data root only through an explicit offline, verified operation."""

    LEASE_TIMEOUT_SECONDS = 60.0

    def __init__(self, recovery: RecoveryCoordinator, *, backup_target: Path | None = None) -> None:
        self.recovery = recovery
        self.backup_target = Path(backup_target).expanduser().absolute() if backup_target else None

    async def relocate(self, target_root: Path) -> RelocationResult:
        target = self._validate_target(target_root)
        owner = None
        global_lease = None
        publication_lock = None
        primary: BaseException | None = None
        try:
            owner = await self._acquire_owner()
            global_lease = await self._acquire_global()
            self._assert_fences(owner, global_lease)
            snapshot = await self.recovery._snapshot_under_lease(
                self._rollback_snapshot_target(target), global_lease
            )
            verification = await self.recovery.verify(snapshot)
            if not verification.valid or verification.manifest != snapshot.manifest:
                raise DomainFailure("relocation_verification_failed", "source rollback snapshot is invalid")
            staged, target_recovery = await self._restore_and_rewrite(snapshot, verification, target)
            publication_lock = await target_recovery._acquire_publication_lock()
            self._assert_fences(owner, global_lease)
            result = await self._publish_target(
                staged, target_recovery, snapshot, owner, global_lease
            )
            return result
        except BaseException as exc:
            primary = exc
            raise
        finally:
            await self._release(publication_lock, global_lease, owner, primary)

    def _validate_target(self, target_root: Path) -> Path:
        target = Path(target_root).expanduser().absolute()
        source = self.recovery.active_root.absolute()
        if target.exists():
            raise DomainFailure("relocation_target_invalid", "relocation target already exists")
        if target == source or source in target.parents:
            raise DomainFailure("relocation_target_invalid", "relocation target is inside the source root")
        parent = target.parent
        if not parent.is_dir() or any(_is_link_or_reparse(item) for item in (parent, *parent.parents)):
            raise DomainFailure("relocation_target_invalid", "relocation target parent is unavailable")
        # An absent path cannot lexically contain an existing source root, but
        # retain the explicit proof to avoid accepting unusual relative input.
        if target in source.parents:
            raise DomainFailure("relocation_target_invalid", "relocation target contains the source root")
        return target

    def _rollback_snapshot_target(self, target: Path) -> Path:
        parent = self.backup_target or (target.parent / f".{target.name}.relocation-snapshots")
        parent = parent.absolute()
        source = self.recovery.active_root.absolute()
        if (
            parent == source
            or source in parent.parents
            or any(_is_link_or_reparse(item) for item in (parent, *parent.parents))
        ):
            raise DomainFailure("relocation_target_invalid", "rollback snapshot target is unsafe")
        parent.mkdir(parents=True, exist_ok=True)
        run = parent / uuid.uuid4().hex
        run.mkdir()
        return run

    async def _acquire_owner(self):
        if self.recovery.lease_coordinator is None:
            raise DomainFailure("relocation_invalid", "process-owner lease coordinator is required")
        try:
            return await self.recovery.lease_coordinator.acquire_process_owner(
                "relocate", self.LEASE_TIMEOUT_SECONDS
            )
        except LeaseTimeoutError as exc:
            raise DomainFailure("lease_timeout", "process owner is busy") from exc

    async def _acquire_global(self):
        try:
            return await self.recovery.lease_coordinator.acquire_global(
                LeaseMode.EXCLUSIVE, "relocate", self.LEASE_TIMEOUT_SECONDS
            )
        except LeaseTimeoutError as exc:
            raise DomainFailure("lease_timeout", "global exclusive lease is busy") from exc

    @staticmethod
    def _assert_fences(owner, global_lease) -> None:
        owner.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="process")
        global_lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="global")
        owner.assert_fence("process")
        global_lease.assert_fence("global")

    def _target_recovery(self, target: Path) -> RecoveryCoordinator:
        source = self.recovery
        return RecoveryCoordinator(
            lease_coordinator=source.lease_coordinator,
            source_root=source.source_root,
            active_root=target,
            catalog=source.catalog,
            meta=source.meta,
            spaces=source.spaces,
            index_schema=source.index_schema,
            active_coordination_inspector=source.active_coordination_inspector,
            effort_projection_compiler=source.effort_projection_compiler,
            recovery_view_factory=source.recovery_view_factory,
            migration_coordinator=source.migration_coordinator,
            knowledge_checker=source.knowledge_checker,
            mutation_recovery_inspector=source.mutation_recovery_inspector,
        )

    async def _restore_and_rewrite(self, snapshot, verification, target: Path) -> tuple[StagedRestore, RecoveryCoordinator]:
        target_recovery = self._target_recovery(target)
        staging = target_recovery._allocate_staging_root()
        try:
            target_recovery._copy_manifest_inventory(snapshot.root, staging, snapshot.manifest)
            target_recovery._fsync_tree(staging)
            staged = StagedRestore(
                proof_id=uuid.uuid4().hex,
                snapshot_root=snapshot.root,
                root=staging,
                target_active_root=target,
                manifest_sha256=verification.manifest_sha256,
                staged_tree_sha256=target_recovery.hash_staged_tree(staging, snapshot.manifest),
                catalog_hash=snapshot.manifest.catalog_hash,
                source_fence=snapshot.manifest.source_fence,
                manifest=snapshot.manifest,
                verification=verification,
            )
            return await self.rewrite_staged_meta(staged, target), target_recovery
        except BaseException:
            try:
                shutil.rmtree(staging)
            except OSError:
                pass
            raise

    async def rewrite_staged_meta(self, staged: StagedRestore, target_root: Path) -> StagedRestore:
        """Rewrite staged registry paths and return a newly verified receipt.

        This is intentionally the only mutable interval in relocation.  The
        source manifest remains the authority for all non-registry inventory;
        the returned tree digest is recomputed from the rewritten bytes.
        """
        target = self._validate_target(target_root)
        if staged.target_active_root != target or staged.root.parent != target.parent:
            raise DomainFailure("relocation_metadata_rewrite_failed", "staged receipt targets another root")
        self._rewrite_staged_registry(staged.root, staged.manifest, target)
        target_recovery = self._target_recovery(target)
        target_recovery._fsync_tree(staged.root)
        before = target_recovery.hash_staged_tree(staged.root, staged.manifest)
        await target_recovery._inspect_staged_root_read_only(
            staged.root, staged.manifest, target_active_root=target
        )
        after = target_recovery.hash_staged_tree(staged.root, staged.manifest)
        if before != after:
            raise DomainFailure("relocation_verification_failed", "read-only authority modified staging")
        return replace(staged, staged_tree_sha256=after)

    @staticmethod
    def _rewrite_staged_registry(staging: Path, manifest, target: Path) -> None:
        """Rewrite precisely the staged registry locations and nothing else."""
        meta_db = staging / "meta.db"
        if _is_link_or_reparse(meta_db):
            raise DomainFailure("relocation_metadata_rewrite_failed", "staged Meta database is a link")
        expected_ids = tuple(space.space_id for space in manifest.spaces)
        try:
            with closing(sqlite3.connect(meta_db)) as connection:
                with connection:
                    rows = connection.execute("SELECT id FROM spaces ORDER BY id").fetchall()
                    if tuple(str(row[0]) for row in rows) != expected_ids:
                        raise DomainFailure("relocation_metadata_rewrite_failed", "staged Space registry is incomplete")
                    for space_id in expected_ids:
                        root = target / "spaces" / space_id
                        cursor = connection.execute(
                            "UPDATE spaces SET db_path=?, notes_dir=? WHERE id=?",
                            (str(root / "space.db"), str(root / "notes"), space_id),
                        )
                        if cursor.rowcount != 1:
                            raise DomainFailure("relocation_metadata_rewrite_failed", "staged Space registry changed")
        except sqlite3.DatabaseError as exc:
            raise DomainFailure("relocation_metadata_rewrite_failed", "staged Meta registry is unreadable") from exc

    async def _publish_target(self, staged, target_recovery, snapshot, owner, global_lease) -> RelocationResult:
        self._assert_fences(owner, global_lease)
        target = staged.target_active_root
        if target.exists():
            raise DomainFailure("relocation_stale", "relocation target appeared before publication")
        published = False
        try:
            target_recovery._rename_no_overwrite(staged.root, target)
            published = True
            fsync_directory(target.parent)
            await target_recovery._inspect_staged_root_read_only(
                target, staged.manifest, target_active_root=target
            )
            if target_recovery.hash_staged_tree(target, staged.manifest) != staged.staged_tree_sha256:
                raise DomainFailure("relocation_verification_failed", "published target tree changed")
            self._assert_fences(owner, global_lease)
            return RelocationResult(
                success=True,
                source_root=self.recovery.active_root,
                target_root=target,
                rollback_snapshot_root=snapshot.root,
                rollback_manifest_sha256=snapshot.manifest_sha256,
                staged_tree_sha256=staged.staged_tree_sha256,
                catalog_hash=staged.catalog_hash,
                source_fence=staged.source_fence,
                process_owner_fence=owner.fence,
                global_fence=global_lease.fence,
                verified_spaces=tuple(space.space_id for space in staged.manifest.spaces),
            )
        except BaseException:
            if published and target.is_dir() and not staged.root.exists():
                try:
                    target_recovery._rename_no_overwrite(target, staged.root)
                    fsync_directory(target.parent)
                except BaseException:
                    pass
            raise

    @staticmethod
    async def _release(publication_lock, global_lease, owner, primary: BaseException | None) -> None:
        for resource in (publication_lock, global_lease, owner):
            if resource is None:
                continue
            try:
                result = resource.release()
                if hasattr(result, "__await__"):
                    await result
            except BaseException as exc:
                if primary is not None:
                    primary.add_note(f"relocation fence release failed: {exc}")
                else:
                    raise
