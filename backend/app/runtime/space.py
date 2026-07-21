from __future__ import annotations

import asyncio
import inspect
import shutil
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, AsyncIterator, Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth.authority import Principal
from app.db.migrations import (
    FleetPreflightTarget,
    FrozenFleetPreflight,
    MigrationSafetyError,
)
from app.db.models.meta import Space
from app.errors import SpaceRecoveryRequiredError, SpaceStorageMissingError
from app.file_system.interfaces import FileSystem
from app.runtime.contained_io import StorageIdentity
from app.runtime.leases import (
    Lease,
    LeaseMode,
    LeaseOrderError,
    RuntimeCleanupPendingError,
)
from app.runtime.scope import (
    AuthorizedSpaceScope,
    AuthorizedSpaceScopeResult,
    SpaceContainmentCapability,
)
from app.runtime.sqlite_vfs import (
    BoundSQLiteTarget,
    MaintenanceOptions,
    _bind_existing_target,
)

if TYPE_CHECKING:
    from app.mutation.staging import StageStore
    from app.space_manager import EngineHandle, SpaceEngineManager


def _current_settings():
    from app.settings import settings

    return settings


@dataclass(frozen=True, slots=True)
class SpaceHealth:
    space_id: str
    available: bool
    migration_head: str
    index_schema_version: int
    catalog_hash: str
    degraded_reason: str | None = None


class SpaceProvisionConflictError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SpaceProvisionSpec:
    space_id: str
    name: str


@dataclass(frozen=True, slots=True)
class _RegisteredSpacePathRecord:
    space_root: Path
    db_path: Path
    notes_dir: Path
    index_db: Path


@dataclass(frozen=True, slots=True)
class ProvisionedSpace:
    id: str
    name: str
    db_path: str
    notes_dir: str
    is_default: bool
    created_at: str
    updated_at: str

    async def __aenter__(self) -> "ProvisionedSpace":
        return self

    async def __aexit__(self, *_exc_info: object) -> bool:
        return False


@dataclass(slots=True)
class ProvisionMarker:
    staging_root: Path
    nonce: str
    _isolated_authorities: dict[StorageIdentity, object] = field(
        default_factory=dict, init=False, repr=False
    )

    @property
    def marker_path(self) -> Path:
        return self.staging_root / ".pomodoroxii-provision"

    def _validated_binding_request(self, path: Path) -> tuple[Path, str]:
        root = self.staging_root.expanduser().resolve(strict=True)
        marker = root / ".pomodoroxii-provision"
        if marker.is_symlink() or not marker.is_file():
            raise SpaceProvisionConflictError("provision marker is missing")
        if marker.read_text(encoding="ascii") != self.nonce:
            raise SpaceProvisionConflictError("provision marker does not match")
        requested = Path(path).expanduser()
        if requested.name in {"", ".", ".."}:
            raise SpaceProvisionConflictError("invalid provision target name")
        if requested.parent.resolve(strict=True) != root:
            raise SpaceProvisionConflictError("provision target is outside staging root")
        return root, requested.name

    def bind_isolated_sqlite_target(self, path: Path) -> BoundSQLiteTarget:
        from app.runtime.sqlite_vfs import bind_marked_isolated_target

        root, basename = self._validated_binding_request(path)
        target, cleanup_authority = bind_marked_isolated_target(
            parent_path=root,
            exact_absent_basename=basename,
            marker_basename=self.marker_path.name,
            marker_nonce=self.nonce,
        )
        self._isolated_authorities[target.identity] = cleanup_authority
        return target

    def commit_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None:
        from app.runtime.sqlite_vfs import commit_closed_isolated_target

        authority = self._isolated_authorities[target.identity]
        commit_closed_isolated_target(authority, target.identity)
        del self._isolated_authorities[target.identity]

    def discard_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None:
        from app.runtime.sqlite_vfs import discard_closed_isolated_target

        authority = self._isolated_authorities[target.identity]
        discard_closed_isolated_target(authority, target.identity)
        del self._isolated_authorities[target.identity]


@dataclass
class SpaceRuntimeHandle:
    scope: AuthorizedSpaceScopeResult
    engine: EngineHandle | None
    file_system: FileSystem | None
    global_lease: Lease
    space_lease: Lease | None
    owns_global_lease: bool
    owns_space_lease: bool
    fence: int
    _runtime: "SpaceRuntime" = field(repr=False)
    mutation_stages: "StageStore | None" = field(default=None, repr=False)
    _storage_identity: StorageIdentity | None = field(default=None, repr=False)
    _degraded_evict_pending: bool = field(default=False, repr=False)
    _closed: bool = False

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        if self.engine is None:
            raise LeaseOrderError("Space resources are not active under a lease")
        return self.engine.session_factory

    async def activate_space_resources_under_lease(self, lease: Lease) -> None:
        from app.file_system.api import open_existing_file_system
        from app.mutation.staging import StageStore

        lease.assert_active_owner(scope=self.scope.space_id)
        if (
            self.engine is not None
            or self.file_system is not None
            or self.mutation_stages is not None
        ):
            raise LeaseOrderError("Space resources are already active")
        if self._runtime.is_degraded(self.scope.space_id):
            raise SpaceRecoveryRequiredError("space recovery is required")
        try:
            async with self.scope.containment.open_verified() as opens:
                database_target = getattr(opens, "database_target", None)
                if database_target is not None:
                    self._storage_identity = database_target.identity
                self.engine = await self._runtime.engines.acquire(self.scope.space_id, opens)
                self.mutation_stages = StageStore(opens.take_mutation_stage_authority())
                self.file_system = await open_existing_file_system(opens)
        except BaseException as primary:
            cleanup_errors: list[BaseException] = []
            try:
                await self.close_space_resources()
            except BaseExceptionGroup as group:
                cleanup_errors.extend(group.exceptions)
            if cleanup_errors:
                self._runtime.register_pending_cleanup(self)
                raise BaseExceptionGroup(
                    "Space activation and cleanup failed",
                    [primary, *cleanup_errors],
                ) from None
            raise

    async def close_space_resources(self) -> None:
        errors: list[BaseException] = []
        if self.file_system is not None:
            try:
                await self.file_system.close()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.file_system = None
        if self.mutation_stages is not None:
            try:
                self.mutation_stages.close()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.mutation_stages = None
        if self.engine is not None:
            try:
                await self.engine.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.engine = None
        if (
            not errors
            and self._degraded_evict_pending
            and self.engine is None
            and self.file_system is None
            and self.mutation_stages is None
        ):
            try:
                if self.space_lease is None:
                    raise LeaseOrderError("degraded cleanup lost its Space lease")
                await self._runtime.finish_degraded_evict_under_lease(
                    self, self.space_lease
                )
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise BaseExceptionGroup("Space runtime resource close failed", errors)

    async def aclose(self) -> None:
        if self._closed:
            return
        errors: list[BaseException] = []
        try:
            await self.close_space_resources()
        except BaseExceptionGroup as group:
            errors.extend(group.exceptions)
        if (
            self.engine is None
            and self.file_system is None
            and self.mutation_stages is None
            and self.owns_space_lease
            and self.space_lease is not None
            and not self._degraded_evict_pending
        ):
            try:
                await self.space_lease.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.space_lease = None
        if (
            self.engine is None
            and self.file_system is None
            and self.mutation_stages is None
            and (not self.owns_space_lease or self.space_lease is None)
            and self.owns_global_lease
        ):
            try:
                await self.global_lease.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self.owns_global_lease = False
        space_done = not self.owns_space_lease or self.space_lease is None
        global_done = not self.owns_global_lease
        self._closed = (
            self.engine is None
            and self.file_system is None
            and self.mutation_stages is None
            and space_done
            and global_done
        )
        if self._closed:
            complete = getattr(self._runtime.leases, "complete_pending_cleanup", None)
            if complete is not None:
                complete(self)
        if errors:
            self._runtime.register_pending_cleanup(self)
            raise BaseExceptionGroup("SpaceRuntimeHandle close failed", errors)

    @asynccontextmanager
    async def exclusive_space_resources(
        self, purpose: str, timeout_seconds: float
    ) -> AsyncIterator[Lease]:
        if self.space_lease is not None:
            raise LeaseOrderError("handle already owns a Space lease")
        lease = await self._runtime.leases.acquire_spaces(
            [self.scope.space_id], LeaseMode.EXCLUSIVE, purpose, timeout_seconds
        )
        self.space_lease = lease
        self.owns_space_lease = True
        primary: BaseException | None = None
        try:
            await self.activate_space_resources_under_lease(lease)
            yield lease
        except BaseException as exc:
            primary = exc
        cleanup_errors: list[BaseException] = []
        try:
            await self.close_space_resources()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
        if (
            self.engine is None
            and self.file_system is None
            and self.mutation_stages is None
            and not self._degraded_evict_pending
        ):
            try:
                await lease.release()
            except BaseException as exc:
                cleanup_errors.append(exc)
            else:
                self.space_lease = None
                self.owns_space_lease = False
        if cleanup_errors:
            self._runtime.register_pending_cleanup(self)
        if primary is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "Space operation and cleanup failed", [primary, *cleanup_errors]
            ) from None
        if primary is not None:
            raise primary
        if cleanup_errors:
            raise BaseExceptionGroup("Space operation cleanup failed", cleanup_errors) from None

    async def __aenter__(self) -> "SpaceRuntimeHandle":
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        try:
            await self.aclose()
        except BaseExceptionGroup as cleanup:
            if exc is not None:
                raise BaseExceptionGroup(
                    "SpaceRuntimeHandle body and cleanup failed", [exc, *cleanup.exceptions]
                ) from None
            raise
        return False


class SpaceRuntime:
    def __init__(self, *, leases, engines: SpaceEngineManager, migrations, index_schema) -> None:
        self.leases = leases
        self.engines = engines
        self.migrations = migrations
        self.index_schema = index_schema
        self._owner_executor: object | None = None
        self._admission_gate: object | None = None
        self._recovery_provider: object | None = None
        self._degraded_spaces: dict[str, str] = {}
        self._frozen_registrations: tuple[tuple[str, str, str, str, bool, str, str], ...] | None = (
            None
        )

    def install_owner_executor(self, executor: object) -> None:
        if self._owner_executor is not None and self._owner_executor is not executor:
            raise RuntimeError("SpaceRuntime owner executor is already installed")
        self._owner_executor = executor
        self._admission_gate = getattr(executor, "gate", None)

    def install_recovery_provider(self, provider: object) -> None:
        if self._recovery_provider is not None and self._recovery_provider is not provider:
            raise RuntimeError("SpaceRuntime recovery provider is already installed")
        self._recovery_provider = provider

    @property
    def recovery_provider(self) -> object | None:
        return self._recovery_provider

    def is_degraded(self, space_id: str) -> bool:
        return space_id in self._degraded_spaces

    async def begin_degraded_under_lease(self, handle, reason: str, space_lease) -> None:
        space_lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope=handle.scope.space_id)
        self._degraded_spaces[handle.scope.space_id] = reason
        handle._degraded_evict_pending = True

    async def finish_degraded_evict_under_lease(self, handle, space_lease) -> None:
        space_lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope=handle.scope.space_id)
        if handle.engine is not None or handle.file_system is not None or handle.mutation_stages is not None:
            raise LeaseOrderError("cannot evict a Space with live resources")
        identity = handle._storage_identity
        if identity is None:
            raise LeaseOrderError("degraded Space has no bound storage identity")
        await self.engines.drain_identity(identity)
        handle._degraded_evict_pending = False
        self._degraded_spaces[handle.scope.space_id] = self._degraded_spaces.get(
            handle.scope.space_id, "mutation_recovery_required"
        )

    async def inspect_recovery(self, handle):
        provider = self._recovery_provider
        if provider is None:
            return None
        inspect = getattr(provider, "inspect_recovery", None)
        if inspect is None:
            inspect = getattr(provider, "inspect", None)
        return await inspect(handle) if inspect is not None else None

    async def recover_under_lease(self, handle, space_lease):
        provider = self._recovery_provider
        if provider is None:
            return None
        recover = getattr(provider, "recover_under_lease", None)
        if recover is None:
            return None
        return await recover(handle, space_lease)

    async def close(self) -> None:
        errors = await self.leases.retry_pending_cleanups_for_current_task()
        if errors:
            raise BaseExceptionGroup("runtime cleanup failed", errors)
        if self.leases.has_pending_cleanups_for_current_task():
            raise RuntimeCleanupPendingError("runtime cleanup remains pending")
        await self.engines.dispose_all()
        self.leases.assert_ready()

    async def provision(self, spec: SpaceProvisionSpec) -> ProvisionedSpace:
        """Submit one exclusive provision command to the installed owner Task."""
        executor = self._owner_executor
        if executor is None:
            raise RuntimeError("RuntimeOwnerExecutor is not installed")

        async def operation(cancellation: asyncio.Event) -> ProvisionedSpace:
            return await self._provision_owned(spec, cancellation)

        operation._pxii_accepts_cancellation = True  # type: ignore[attr-defined]
        return await executor.submit(f"provision:{spec.space_id}", operation)

    async def _provision_owned(
        self,
        spec: SpaceProvisionSpec,
        cancellation: asyncio.Event,
    ) -> ProvisionedSpace:
        """Provision and publish one Space entirely inside the owner Task."""
        from app.file_system.api import provision_file_system
        from app.runtime.durability import fsync_directory, fsync_file
        from app.runtime.sqlite_vfs import _bind_existing_target

        runtime_settings = _current_settings()
        final_root = runtime_settings.spaces_data_dir / spec.space_id
        if final_root.exists():
            raise SpaceProvisionConflictError("Space storage already exists")
        nonce = uuid.uuid4().hex
        staging_root = runtime_settings.spaces_data_dir / f".provision-{spec.space_id}-{nonce}"
        db_path = staging_root / "space.db"
        index_path = staging_root / "index.db"
        notes_dir = staging_root / "notes"
        marker = ProvisionMarker(staging_root, nonce)
        renamed = False
        global_lease = None
        space_lease = None
        committed = False
        provisioned: ProvisionedSpace | None = None
        primary: BaseException | None = None
        cleanup_errors: list[BaseException] = []
        try:
            if cancellation.is_set():
                raise asyncio.CancelledError()
            staging_root.mkdir(parents=True, exist_ok=False)
            marker.marker_path.write_text(nonce, encoding="ascii")
            fsync_file(marker.marker_path)
            fsync_directory(staging_root)
            fsync_directory(staging_root.parent)

            global_lease = await self.leases.acquire_global(
                LeaseMode.EXCLUSIVE, "space-provision", 5
            )
            space_lease = await self.leases.acquire_spaces(
                [spec.space_id], LeaseMode.EXCLUSIVE, "space-provision", 5
            )
            await self.migrations.create_isolated_under_lease(
                "space", db_path, global_lease, marker
            )
            marker.marker_path.write_text(nonce, encoding="ascii")
            fsync_file(marker.marker_path)
            fsync_directory(staging_root)
            file_system = await provision_file_system(notes_dir, index_path)
            try:
                await file_system.close()
            except BaseException as error:
                cleanup_errors.append(error)
            index_target = _bind_existing_target(index_path, create_authority=False)
            try:
                self.index_schema.upgrade_open(index_target, create_if_missing=False)
                index_status = self.index_schema.verify_open(index_target)
            finally:
                await index_target.aclose()
            if not index_status.valid:
                raise RuntimeError("provisioned index schema is not valid")
            if cancellation.is_set():
                raise asyncio.CancelledError()
            global_lease.fence_receipt("global").assert_current()
            space_lease.fence_receipt(spec.space_id).assert_current()
            if final_root.exists():
                raise SpaceProvisionConflictError("Space storage already exists")
            staging_root.rename(final_root)
            renamed = True
            fsync_directory(final_root.parent)
            final_marker = final_root / marker.marker_path.name

            if cancellation.is_set():
                raise asyncio.CancelledError()
            space = await self._commit_registration(spec, final_root)
            committed = True
            provisioned = ProvisionedSpace(
                id=space.id,
                name=space.name,
                db_path=space.db_path,
                notes_dir=space.notes_dir,
                is_default=space.is_default,
                created_at=space.created_at,
                updated_at=space.updated_at,
            )
            final_marker.unlink()
            fsync_directory(final_root)
        except BaseException as error:
            primary = error
        if primary is not None and not committed:
            cleanup_errors.extend(
                self._cleanup_marked_provision_tree(final_root if renamed else staging_root, nonce)
            )
        if space_lease is not None:
            try:
                await space_lease.release()
            except BaseException as error:
                cleanup_errors.append(error)
        if global_lease is not None:
            try:
                await global_lease.release()
            except BaseException as error:
                cleanup_errors.append(error)
        if primary is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "Space provision and cleanup failed", [primary, *cleanup_errors]
            ) from None
        if primary is not None:
            raise primary
        if cleanup_errors:
            raise BaseExceptionGroup("Space provision cleanup failed", cleanup_errors) from None
        assert provisioned is not None
        return provisioned

    async def _commit_registration(self, spec: SpaceProvisionSpec, final_root: Path) -> Space:
        from app.db.meta_session import get_meta_session

        async for session in get_meta_session():
            space = Space(
                id=spec.space_id,
                name=spec.name,
                db_path=str(final_root / "space.db"),
                notes_dir=str(final_root / "notes"),
            )
            session.add(space)
            await session.commit()
            await session.refresh(space)
            return space
        raise RuntimeError("Meta session fixture did not yield")

    async def get_registered(self, space_id: str) -> Space | None:
        from sqlalchemy import select

        from app.db.meta_session import get_meta_session

        async for session in get_meta_session():
            return await session.scalar(select(Space).where(Space.id == space_id))
        return None

    @staticmethod
    def _registration_tuple(space: Space) -> tuple[str, str, str, str, bool, str, str]:
        return (
            space.id,
            space.name,
            space.db_path,
            space.notes_dir,
            space.is_default,
            space.created_at,
            space.updated_at,
        )

    @staticmethod
    def _paths_for_registration(
        space_id: str, db_path: str, notes_dir: str
    ) -> _RegisteredSpacePathRecord:
        runtime_settings = _current_settings()
        expected_db = runtime_settings.space_db_path(space_id)
        expected_notes = runtime_settings.space_notes_dir(space_id)
        if Path(db_path) != expected_db or Path(notes_dir) != expected_notes:
            raise MigrationSafetyError(
                "registered Space paths do not match the canonical runtime layout"
            )
        index_db = expected_db.parent / "index.db"
        if not expected_db.is_file() or not expected_notes.is_dir() or not index_db.is_file():
            raise SpaceStorageMissingError()
        return _RegisteredSpacePathRecord(
            space_root=runtime_settings.canonical_spaces_root,
            db_path=expected_db,
            notes_dir=expected_notes,
            index_db=index_db,
        )

    async def preflight_registered_fleet(
        self,
        migrations,
        meta_target: Path,
        global_lease: Lease,
    ) -> FrozenFleetPreflight:
        """Freeze Meta registrations and preflight every store read-only."""
        global_lease.assert_active_owner(
            mode=LeaseMode.EXCLUSIVE,
            scope="global",
            require_process_owner=True,
        )
        targets: list[BoundSQLiteTarget] = []
        handed_to_coordinator = False
        try:
            meta = _bind_existing_target(meta_target, create_authority=False)
            targets.append(meta)
            with meta.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_schema WHERE type='table'"
                    ).fetchall()
                }
                rows = (
                    connection.execute(
                        "SELECT id,name,db_path,notes_dir,is_default,"
                        "created_at,updated_at FROM spaces ORDER BY id"
                    ).fetchall()
                    if "spaces" in tables
                    else []
                )
            registrations = tuple(
                (
                    str(row[0]),
                    str(row[1]),
                    str(row[2]),
                    str(row[3]),
                    bool(row[4]),
                    str(row[5]),
                    str(row[6]),
                )
                for row in rows
            )
            fleet_targets = [FleetPreflightTarget(None, "meta", meta.identity, meta)]
            for registration in registrations:
                space_id, _name, db_path, notes_dir, *_rest = registration
                paths = self._paths_for_registration(space_id, db_path, notes_dir)
                containment = SpaceContainmentCapability._create(paths)
                async with containment.open_verified() as opens:
                    target = opens.take_database_target()
                targets.append(target)
                fleet_targets.append(
                    FleetPreflightTarget(space_id, "space", target.identity, target)
                )
            handed_to_coordinator = True
            fleet = await migrations.preflight_fleet_under_lease(fleet_targets, global_lease)
            self._frozen_registrations = registrations
            return fleet
        finally:
            if not handed_to_coordinator:
                errors: list[BaseException] = []
                for target in targets:
                    try:
                        await target.aclose()
                    except BaseException as error:
                        errors.append(error)
                if errors:
                    raise BaseExceptionGroup("fleet target cleanup failed", errors) from None

    async def prepare_registered_spaces(
        self,
        catalog,
        global_lease: Lease,
        fleet: FrozenFleetPreflight,
    ) -> None:
        """Migrate and verify the frozen registration set in sorted order."""
        global_lease.assert_active_owner(
            mode=LeaseMode.EXCLUSIVE,
            scope="global",
            require_process_owner=True,
        )
        expected = self._frozen_registrations
        if expected is None:
            raise MigrationSafetyError("fleet preflight was not completed")
        from app.db.meta_session import get_meta_session

        async for session in get_meta_session():
            from sqlalchemy import select

            rows = (await session.execute(select(Space).order_by(Space.id))).scalars().all()
            current = tuple(self._registration_tuple(row) for row in rows)
            if current != expected:
                raise MigrationSafetyError(
                    "registered Space inventory changed after fleet preflight"
                )
            scopes = [
                await AuthorizedSpaceScope(
                    session, _current_settings().canonical_spaces_root, self
                ).resolve(
                    Principal(
                        subject="runtime-startup",
                        token_type="trusted_stdio",
                        epoch=0,
                        expires_at=None,
                        space_id=row.id,
                    ),
                    row.id,
                    "read",
                )
                for row in rows
            ]
            break
        else:
            raise RuntimeError("Meta session fixture did not yield")

        frozen_identities = {
            space_id: identity
            for space_id, identity in zip(fleet.space_ids, fleet.identities, strict=True)
            if space_id is not None
        }
        for row, scope in zip(rows, scopes, strict=True):
            async with scope.containment.open_verified() as opens:
                if opens.database_target.identity != frozen_identities[row.id]:
                    raise MigrationSafetyError(
                        "registered Space identity changed after fleet preflight"
                    )
            space_lease = await self.leases.acquire_spaces(
                [row.id], LeaseMode.EXCLUSIVE, "startup-prepare", 60
            )
            async with space_lease:
                global_lease.assert_active_owner(
                    mode=LeaseMode.EXCLUSIVE,
                    scope="global",
                    require_process_owner=True,
                )
                space_lease.assert_active_owner(
                    mode=LeaseMode.EXCLUSIVE,
                    scope=row.id,
                    require_process_owner=True,
                )
                await self.migrations.upgrade_under_lease("space", Path(row.db_path), global_lease)
                async with scope.containment.open_verified() as opens:
                    status = self.index_schema.upgrade_open(
                        opens.index_target, create_if_missing=False
                    )
                    if not status.valid:
                        raise RuntimeError("registered index schema is invalid")
                async with self.borrow_prepared_space(
                    scope, global_lease, space_lease
                ) as handle:
                    result = await self.recover_under_lease(handle, space_lease)
                    if result is not None and getattr(result, "failed_manual", ()):
                        raise SpaceRecoveryRequiredError(
                            "space recovery requires manual intervention"
                        )

    def _cleanup_marked_provision_tree(
        self, provision_root: Path, nonce: str
    ) -> list[BaseException]:
        if not provision_root.exists():
            return []
        errors: list[BaseException] = []
        try:
            root = provision_root.expanduser().resolve(strict=True)
            spaces_root = _current_settings().spaces_data_dir.expanduser().resolve(strict=True)
            if root.parent != spaces_root:
                raise SpaceProvisionConflictError("provision cleanup target is outside spaces root")
            marker = root / ".pomodoroxii-provision"
            if marker.is_symlink() or not marker.is_file():
                raise SpaceProvisionConflictError("provision marker is missing")
            if marker.read_text(encoding="ascii") != nonce:
                raise SpaceProvisionConflictError("provision marker does not match")
            shutil.rmtree(root)
        except BaseException as error:
            errors.append(error)
        return errors

    async def _verify_registered_open(self, scope: AuthorizedSpaceScopeResult) -> None:
        async with scope.containment.open_verified() as opens:
            migration = await self.migrations.verify_open("space", opens.database_target)
            if not migration.at_head:
                raise RuntimeError("registered space migration is not at head")
            index_status = self.index_schema.verify_open(opens.index_target)
            if not index_status.valid:
                raise RuntimeError("registered index schema is not valid")

    async def open_resolved(
        self,
        scope: AuthorizedSpaceScopeResult,
        mode: Literal["read", "mutation"],
        global_lease: Lease,
        *,
        owns_global_lease: bool,
        borrowed_space_lease: Lease | None = None,
        _skip_recovery: bool = False,
    ) -> SpaceRuntimeHandle:
        space_lease = borrowed_space_lease
        owns_space_lease = False
        handle = None
        defer_handle_cleanup = False
        try:
            if mode == "read" and space_lease is None:
                space_lease = await self.leases.acquire_spaces(
                    [scope.space_id], LeaseMode.SHARED, "read", 5
                )
                owns_space_lease = True
            if self.is_degraded(scope.space_id):
                raise SpaceRecoveryRequiredError("space recovery is required")
            verified = self._verify_registered_open(scope)
            if inspect.isawaitable(verified):
                await verified
            handle = SpaceRuntimeHandle(
                scope,
                None,
                None,
                global_lease,
                space_lease,
                owns_global_lease,
                owns_space_lease,
                space_lease.fence if space_lease is not None else global_lease.fence,
                self,
            )
            if mode == "read" or borrowed_space_lease is not None:
                assert space_lease is not None
                await handle.activate_space_resources_under_lease(space_lease)
            if mode == "read" and borrowed_space_lease is None and not _skip_recovery:
                inspection = await self.inspect_recovery(handle)
                if inspection is not None and not inspection.clean:
                    # A shared read lease may never be upgraded in place.  Close
                    # all read resources first, then release it, then recover
                    # through a temporary exclusive handle.
                    try:
                        await handle.close_space_resources()
                    except BaseException:
                        defer_handle_cleanup = True
                        self.register_pending_cleanup(handle)
                        raise
                    await space_lease.release()
                    handle.space_lease = None
                    handle.owns_space_lease = False
                    transferred_global_lease = handle.owns_global_lease
                    exclusive = await self.leases.acquire_spaces(
                        [scope.space_id], LeaseMode.EXCLUSIVE, "recovery", 5
                    )
                    async with exclusive:
                        async with self.borrow_prepared_space(
                            scope, global_lease, exclusive
                        ) as recovery_handle:
                            result = await self.recover_under_lease(
                                recovery_handle, exclusive
                            )
                            if result is not None and getattr(
                                result, "failed_manual", ()
                            ):
                                raise SpaceRecoveryRequiredError(
                                    "space recovery requires manual intervention"
                                )
                    reopened = await self.open_resolved(
                        scope,
                        "read",
                        global_lease,
                        owns_global_lease=transferred_global_lease,
                        _skip_recovery=False,
                    )
                    handle.owns_global_lease = False
                    return reopened
            return handle
        except BaseException as primary:
            cleanup_errors: list[BaseException] = []
            if handle is not None:
                if not defer_handle_cleanup:
                    try:
                        await handle.aclose()
                    except BaseExceptionGroup as group:
                        cleanup_errors.extend(group.exceptions)
            else:
                if owns_space_lease and space_lease is not None:
                    try:
                        await space_lease.release()
                    except BaseException as exc:
                        cleanup_errors.append(exc)
                if owns_global_lease:
                    try:
                        await global_lease.release()
                    except BaseException as exc:
                        cleanup_errors.append(exc)
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "runtime open and cleanup failed", [primary, *cleanup_errors]
                ) from None
            raise

    async def health(
        self, scope: AuthorizedSpaceScopeResult, *, catalog_hash: str = ""
    ) -> SpaceHealth:
        async with scope.containment.open_verified() as opens:
            migration = await self.migrations.verify_open("space", opens.database_target)
            index_status = self.index_schema.verify_open(opens.index_target)
        available = bool(migration.at_head and index_status.valid)
        if self.is_degraded(scope.space_id):
            available = False
        return SpaceHealth(
            scope.space_id,
            available,
            getattr(migration, "revision", None) or "",
            index_status.version,
            catalog_hash,
            None if available else "space_recovery_required",
        )

    def register_pending_cleanup(self, handle: SpaceRuntimeHandle) -> None:
        dependencies = (
            (handle.space_lease,)
            if handle.space_lease is not None and not handle.owns_space_lease
            else ()
        )
        self.leases.register_pending_cleanup(
            handle,
            retry=handle.aclose,
            holds=(handle,),
            physical_terminal=lambda: handle._closed,
            dependencies=dependencies,
        )

    def assert_ready(self) -> None:
        if self._admission_gate is None:
            raise RuntimeError("RuntimeAdmissionGate is not installed")
        self._admission_gate.assert_ready()
        self.leases.assert_ready()
        if self._degraded_spaces:
            raise SpaceRecoveryRequiredError("one or more Spaces require recovery")

    @asynccontextmanager
    async def borrow_prepared_space(
        self, scope: AuthorizedSpaceScopeResult, global_lease: Lease, space_lease: Lease
    ) -> AsyncIterator[SpaceRuntimeHandle]:
        handle = await self.open_resolved(
            scope,
            "mutation",
            global_lease,
            owns_global_lease=False,
            borrowed_space_lease=space_lease,
        )
        space_lease.retain_cleanup_dependency(handle)
        primary: BaseException | None = None
        try:
            yield handle
        except BaseException as exc:
            primary = exc
        cleanup_errors: list[BaseException] = []
        try:
            await handle.aclose()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
            self.register_pending_cleanup(handle)
        if handle._closed:
            space_lease.complete_cleanup_dependency(handle)
        if primary is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "borrowed Space runtime body and cleanup failed",
                [primary, *cleanup_errors],
            ) from None
        if primary is not None:
            raise primary
        if cleanup_errors:
            raise BaseExceptionGroup(
                "borrowed Space runtime cleanup failed", cleanup_errors
            ) from None
