"""Fail-closed Alembic migration entry points for meta and space databases."""

from __future__ import annotations

import asyncio
import os
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterable, Literal, Protocol, Sequence

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import MetaData, column, create_engine, inspect, select, table
from sqlalchemy.engine import Connection

if TYPE_CHECKING:
    from app.runtime.leases import Lease, RuntimeLeaseCoordinator
    from app.runtime.sqlite_vfs import BoundSQLiteTarget, StorageIdentity

DatabaseKind = Literal["meta", "space"]

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = (_BACKEND_DIR / "alembic.ini").resolve()

_VERSION_TABLES = {
    "meta": "alembic_version_meta",
    "space": "alembic_version_space",
}
_ALL_VERSION_TABLES = frozenset({"alembic_version", *_VERSION_TABLES.values()})
_LEGACY_REVISIONS = {
    "meta": "meta_001",
    "space": "space_005_sync_updated_at_indexes",
}


class MigrationSafetyError(RuntimeError):
    """Raised when a database cannot be migrated without an explicit decision."""


class MigrationBusyError(MigrationSafetyError):
    """Raised when a WAL/checkpoint cannot be sealed without data loss."""

    code = "migration_busy"


class ProcessExitRequiredError(MigrationSafetyError):
    """Raised when a physical cleanup cannot be proven terminal."""

    code = "process_exit_required"
    retryable = False


class MigrationQuiescer(Protocol):
    async def drain_identity(self, identity: StorageIdentity) -> None: ...

    async def resume_identity(self, identity: StorageIdentity) -> None: ...


class ProvisionMarker(Protocol):
    def bind_isolated_sqlite_target(self, path: Path) -> BoundSQLiteTarget: ...

    def commit_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None: ...

    def discard_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None: ...


@dataclass(frozen=True)
class MigrationPreflightPolicy:
    """Read-only policy invoked before any fleet migration side effect."""

    kind: DatabaseKind
    target_head: str
    probe: Callable[[DatabaseKind, MigrationStatus, object], None]


@dataclass(frozen=True)
class FleetPreflightTarget:
    """Frozen registration authority consumed by fleet preflight."""

    space_id: str | None
    kind: DatabaseKind
    expected_identity: StorageIdentity
    target: BoundSQLiteTarget


@dataclass(frozen=True)
class FrozenFleetPreflight:
    statuses: tuple[MigrationStatus, ...]
    identities: tuple[StorageIdentity, ...]
    space_ids: tuple[str | None, ...]


@dataclass
class _KeyedUpgradeGate:
    lock: asyncio.Lock
    users: int = 0


@dataclass(frozen=True)
class MigrationStatus:
    kind: DatabaseKind
    revision: str | None
    head: str
    at_head: bool
    integrity_ok: bool


@dataclass(frozen=True)
class MigrationResult:
    kind: DatabaseKind
    previous_revision: str | None
    head: str
    changed: bool


class MigrationCoordinator:
    """Owns migration, replacement, and read-only fleet preflight authority."""

    def __init__(
        self,
        leases: RuntimeLeaseCoordinator | None = None,
        quiescer: MigrationQuiescer | None = None,
        *,
        failpoint: Callable[[str], None] | None = None,
        migrate_target: Callable[[DatabaseKind, BoundSQLiteTarget], None] | None = None,
    ) -> None:
        self._leases = leases
        self._quiescer = quiescer
        self._failpoint = failpoint or (lambda _name: None)
        self._migrate_target = migrate_target or _migrate_bound_target
        self._upgrade_gates: dict[tuple[DatabaseKind, Path], _KeyedUpgradeGate] = {}
        self._upgrade_gates_guard = asyncio.Lock()
        self._process_exit_holds: dict[
            tuple[DatabaseKind, Path], tuple[object, ...]
        ] = {}

    def _require_runtime(self) -> tuple[RuntimeLeaseCoordinator, MigrationQuiescer]:
        if self._leases is None or self._quiescer is None:
            raise RuntimeError("migration coordinator runtime authority is not configured")
        return self._leases, self._quiescer

    def _assert_destructive_lease(self, lease: Lease) -> None:
        from app.runtime.leases import LeaseMode, LeaseOrderError

        leases, _quiescer = self._require_runtime()
        lease.assert_active_owner(
            mode=LeaseMode.EXCLUSIVE,
            scope="global",
            require_process_owner=True,
        )
        receipt = lease.process_owner
        if receipt is None or receipt.coordinator_id != id(leases):
            raise LeaseOrderError(
                "migration lease belongs to another runtime coordinator"
            )

    async def verify(self, kind: DatabaseKind, path: Path) -> MigrationStatus:
        from app.runtime.sqlite_vfs import _bind_existing_target

        target = _bind_existing_target(path, create_authority=False)
        primary: BaseException | None = None
        result: MigrationStatus | None = None
        try:
            result = await self.verify_open(kind, target)
        except BaseException as error:
            primary = error
        cleanup_errors = await _close_all(target)
        _raise_primary_cleanup(
            "migration verification failed", primary, cleanup_errors
        )
        assert result is not None
        return result

    async def verify_open(
        self, kind: DatabaseKind, target: BoundSQLiteTarget
    ) -> MigrationStatus:
        return await _run_joined(lambda: _verify_bound_target(kind, target))

    async def preflight_fleet_under_lease(
        self,
        targets: Sequence[FleetPreflightTarget],
        lease: Lease,
        policies: Iterable[MigrationPreflightPolicy] = (),
    ) -> FrozenFleetPreflight:
        self._assert_destructive_lease(lease)
        targets = tuple(targets)
        close_targets = tuple(registration.target for registration in targets)
        policy_list = tuple(policies)
        statuses: list[MigrationStatus] = []
        primary: BaseException | None = None
        identities: tuple[StorageIdentity, ...] = ()
        ordered: tuple[FleetPreflightTarget, ...] = ()
        try:
            ordered = _canonical_fleet_order(targets)
            actual_identities: list[StorageIdentity] = []
            for registration in ordered:
                actual_identity = registration.target.identity
                if actual_identity != registration.expected_identity:
                    raise MigrationSafetyError(
                        "fleet preflight target does not match expected identity"
                    )
                actual_identities.append(actual_identity)
            identities = tuple(actual_identities)
            if len(set(identities)) != len(identities):
                raise MigrationSafetyError(
                    "fleet preflight target identities must be unique"
                )
            for registration in ordered:
                self._assert_destructive_lease(lease)
                status = await _run_joined(
                    lambda registration=registration: _preflight_bound_target(
                        registration.kind, registration.target, policy_list
                    )
                )
                statuses.append(status)
        except BaseException as error:
            primary = error
        cleanup_errors = await _close_all(*close_targets)
        _raise_primary_cleanup("fleet preflight failed", primary, cleanup_errors)
        return FrozenFleetPreflight(
            tuple(statuses),
            identities,
            tuple(registration.space_id for registration in ordered),
        )

    async def upgrade(self, kind: DatabaseKind, path: Path) -> MigrationResult:
        from app.runtime.leases import _HELD_ORDER, LeaseMode, LeaseOrderError

        if _HELD_ORDER.get().level != "none":
            raise LeaseOrderError("standalone upgrade cannot inherit an existing lease")
        leases, _quiescer = self._require_runtime()
        key = (kind, Path(path).expanduser().resolve())
        async with self._upgrade_gates_guard:
            gate = self._upgrade_gates.get(key)
            if gate is None:
                gate = _KeyedUpgradeGate(asyncio.Lock())
                self._upgrade_gates[key] = gate
            gate.users += 1
        try:
            async with gate.lock:
                owner = await leases.acquire_process_owner(f"migrate:{kind}", 5)
                global_lease: Lease | None = None
                primary: BaseException | None = None
                result: MigrationResult | None = None
                try:
                    global_lease = await leases.acquire_global(
                        LeaseMode.EXCLUSIVE, f"migrate:{kind}", 60
                    )
                    result = await self.upgrade_under_lease(
                        kind, key[1], global_lease
                    )
                except BaseException as error:
                    primary = error
                cleanup_errors: list[BaseException] = []
                cleanup_errors.extend(
                    await leases.retry_pending_cleanups_for_current_task()
                )
                if (
                    not leases.has_pending_cleanups_for_current_task()
                    and global_lease is not None
                ):
                    try:
                        await global_lease.release()
                    except BaseException as error:
                        cleanup_errors.append(error)
                    cleanup_errors.extend(
                        await leases.retry_pending_cleanups_for_current_task()
                    )
                if not leases.has_pending_cleanups_for_current_task():
                    try:
                        await owner.release()
                    except BaseException as error:
                        cleanup_errors.append(error)
                    cleanup_errors.extend(
                        await leases.retry_pending_cleanups_for_current_task()
                    )
                if leases.has_pending_cleanups_for_current_task():
                    pending = leases.pending_cleanups_for_current_task()
                    self._process_exit_holds[key] = (owner, global_lease, *pending)
                    leases.mark_process_exit_required(
                        "standalone migration cleanup did not converge",
                        holds=self._process_exit_holds[key],
                    )
                    cleanup_errors.append(
                        ProcessExitRequiredError(
                            "standalone migration requires offline process exit"
                        )
                    )
                _raise_primary_cleanup(
                    "standalone migration failed", primary, cleanup_errors
                )
                assert result is not None
                return result
        finally:
            async with self._upgrade_gates_guard:
                gate.users -= 1
                if gate.users == 0 and not gate.lock.locked():
                    self._upgrade_gates.pop(key, None)

    async def upgrade_under_lease(
        self, kind: DatabaseKind, path: Path, lease: Lease
    ) -> MigrationResult:
        from app.runtime.sqlite_vfs import _bind_existing_target

        _leases, quiescer = self._require_runtime()
        self._assert_destructive_lease(lease)
        fence_receipt = lease.fence_receipt("global")
        source = _bind_existing_target(path, create_authority=False)
        identity = source.identity
        cleanup_owner = object()
        lease.retain_cleanup_dependency(cleanup_owner)
        drain_started = False
        primary: BaseException | None = None
        result: MigrationResult | None = None
        try:
            drain_started = True
            await quiescer.drain_identity(identity)
            self._assert_destructive_lease(lease)
            current = await self.verify_open(kind, source)
            if current.at_head:
                result = MigrationResult(kind, current.revision, current.head, False)
            else:
                result = await self._replace_upgrade(
                    kind, source, current, fence_receipt, lease
                )
        except BaseException as error:
            primary = error
        cleanup_errors: list[BaseException] = []
        terminal = {"closed": False, "resumed": not drain_started}
        try:
            await source.aclose()
            terminal["closed"] = True
        except BaseException as error:
            cleanup_errors.append(error)
        if terminal["closed"] and drain_started:
            try:
                await quiescer.resume_identity(identity)
                terminal["resumed"] = True
            except BaseException as error:
                cleanup_errors.append(error)
        if not cleanup_errors:
            lease.complete_cleanup_dependency(cleanup_owner)
        else:
            async def retry_cleanup() -> None:
                errors: list[BaseException] = []
                if not terminal["closed"]:
                    try:
                        await source.aclose()
                        terminal["closed"] = True
                    except BaseException as error:
                        errors.append(error)
                if terminal["closed"] and not terminal["resumed"]:
                    try:
                        await quiescer.resume_identity(identity)
                        terminal["resumed"] = True
                    except BaseException as error:
                        errors.append(error)
                if errors:
                    raise BaseExceptionGroup("migration cleanup retry failed", errors)

            _leases.register_pending_cleanup(
                cleanup_owner,
                retry=retry_cleanup,
                holds=(self, source, quiescer),
                physical_terminal=lambda: (
                    terminal["closed"] and terminal["resumed"]
                ),
                dependencies=(lease,),
            )
        _raise_primary_cleanup("migration failed", primary, cleanup_errors)
        assert result is not None
        return result

    async def _replace_upgrade(
        self,
        kind: DatabaseKind,
        source: BoundSQLiteTarget,
        current: MigrationStatus,
        fence_receipt,
        lease: Lease,
    ) -> MigrationResult:
        from app.runtime.durability import sqlite_online_backup
        from app.runtime.sqlite_vfs import begin_bound_replacement

        replacement = begin_bound_replacement(source)
        replacement_target = replacement.target
        primary: BaseException | None = None
        committed = False
        checkpointed = False
        checkpoint_attempted = False
        commit_attempted = False
        result: MigrationResult | None = None
        try:
            await _run_joined(
                lambda: sqlite_online_backup(source, replacement_target)
            )
            self._failpoint("after_backup")
            await _run_joined(
                lambda: self._migrate_target(kind, replacement_target)
            )
            self._failpoint("after_upgrade")
            verified = await self.verify_open(kind, replacement_target)
            if not verified.at_head or not verified.integrity_ok:
                raise MigrationSafetyError("replacement verification failed")
            self._failpoint("after_integrity_check")
            checkpoint_attempted = True
            checkpoint = await _run_joined(
                replacement.checkpoint_and_seal_source
            )
            if len(checkpoint) != 3 or checkpoint[0] != 0 or checkpoint[1] != checkpoint[2]:
                raise MigrationBusyError("source WAL checkpoint is not terminal")
            checkpointed = True
            close_errors = await _close_all(replacement_target, source)
            if close_errors:
                raise BaseExceptionGroup("replacement close failed", close_errors)
            fence_receipt.assert_current()
            self._failpoint("before_replace")
            commit_attempted = True
            committed_identity = await _run_joined(
                replacement.commit_bound_replace
            )
            committed = True
            if committed_identity != replacement_target.identity:
                raise MigrationSafetyError(
                    "published replacement identity does not match verified target"
                )
            self._failpoint("after_replace")
            result = MigrationResult(kind, current.revision, verified.head, True)
        except BaseException as error:
            primary = error
        if not committed:
            close_errors: list[BaseException] = []
            if not checkpoint_attempted:
                try:
                    checkpoint = await _run_joined(
                        replacement.checkpoint_and_seal_source
                    )
                    checkpointed = True
                    if (
                        len(checkpoint) != 3
                        or checkpoint[0] != 0
                        or checkpoint[1] != checkpoint[2]
                    ):
                        close_errors.append(
                            MigrationBusyError("source WAL checkpoint is not terminal")
                        )
                except BaseException as error:
                    close_errors.append(error)
            close_errors.extend(await _close_all(replacement_target, source))
            if commit_attempted and not committed:
                try:
                    reconciled_identity = await _run_joined(
                        replacement.commit_bound_replace
                    )
                    if reconciled_identity == replacement_target.identity:
                        committed = True
                        leases, _quiescer = self._require_runtime()
                        leases.mark_process_exit_required(
                            "replacement commit completed after ambiguous failure",
                            holds=(replacement, replacement_target, source),
                        )
                        close_errors.append(
                            ProcessExitRequiredError(
                                "replacement commit requires post-cutover review"
                            )
                        )
                except BaseException as error:
                    close_errors.append(error)
            try:
                if checkpointed and not committed:
                    await _run_joined(replacement.discard_closed_replacement)
            except BaseException as error:
                close_errors.append(error)
            if checkpoint_attempted and not checkpointed:
                leases, _quiescer = self._require_runtime()
                cleanup_owner = object()

                async def cannot_retry_checkpoint() -> None:
                    raise ProcessExitRequiredError(
                        "checkpoint outcome is not safely retryable"
                    )

                leases.register_pending_cleanup(
                    cleanup_owner,
                    retry=cannot_retry_checkpoint,
                    holds=(self, replacement, replacement_target, source),
                    physical_terminal=lambda: False,
                    dependencies=(lease,),
                )
                leases.mark_process_exit_required(
                    "migration checkpoint did not reach a terminal receipt",
                    holds=(replacement, replacement_target, source),
                )
                close_errors.append(
                    ProcessExitRequiredError(
                        "migration checkpoint requires process exit"
                    )
                )
            _raise_primary_cleanup(
                "replacement migration failed", primary, close_errors
            )
        if committed and primary is not None:
            leases, _quiescer = self._require_runtime()
            leases.mark_process_exit_required(
                "replacement failed after physical cutover",
                holds=(replacement, replacement_target, source),
            )
            _raise_primary_cleanup(
                "post-cutover migration verification failed",
                primary,
                [
                    ProcessExitRequiredError(
                        "replacement cutover requires process exit"
                    )
                ],
            )
        if primary is not None:
            raise primary
        assert result is not None
        return result

    async def create_isolated_under_lease(
        self,
        kind: DatabaseKind,
        path: Path,
        lease: Lease,
        marker: ProvisionMarker,
    ) -> MigrationResult:
        self._assert_destructive_lease(lease)
        fence_receipt = lease.fence_receipt("global")
        target = marker.bind_isolated_sqlite_target(path)
        cleanup_owner = object()
        lease.retain_cleanup_dependency(cleanup_owner)
        primary: BaseException | None = None
        result: MigrationResult | None = None
        terminal = {"closed": False, "committed": False, "discarded": False}
        try:
            await _run_joined(lambda: self._migrate_target(kind, target))
            status = await self.verify_open(kind, target)
            if not status.at_head or not status.integrity_ok:
                raise MigrationSafetyError("isolated migration verification failed")
            fence_receipt.assert_current()
            result = MigrationResult(kind, None, status.head, True)
        except BaseException as error:
            primary = error
        cleanup_errors: list[BaseException] = []
        try:
            await target.aclose()
            terminal["closed"] = True
        except BaseException as error:
            cleanup_errors.append(error)
        if primary is None and terminal["closed"]:
            try:
                await _run_joined(
                    lambda: marker.commit_isolated_sqlite_target(target)
                )
                terminal["committed"] = True
            except BaseException as error:
                cleanup_errors.append(error)
        if primary is not None and terminal["closed"]:
            try:
                await _run_joined(
                    lambda: marker.discard_isolated_sqlite_target(target)
                )
                terminal["discarded"] = True
            except BaseException as error:
                cleanup_errors.append(error)
        desired_terminal = "committed" if primary is None else "discarded"
        if terminal[desired_terminal] and not cleanup_errors:
            lease.complete_cleanup_dependency(cleanup_owner)
        else:
            leases, _quiescer = self._require_runtime()

            async def retry_cleanup() -> None:
                errors: list[BaseException] = []
                if not terminal["closed"]:
                    try:
                        await target.aclose()
                        terminal["closed"] = True
                    except BaseException as error:
                        errors.append(error)
                if terminal["closed"] and not terminal[desired_terminal]:
                    try:
                        callback = (
                            marker.commit_isolated_sqlite_target
                            if desired_terminal == "committed"
                            else marker.discard_isolated_sqlite_target
                        )
                        await _run_joined(lambda: callback(target))
                        terminal[desired_terminal] = True
                    except BaseException as error:
                        errors.append(error)
                if errors:
                    raise BaseExceptionGroup(
                        "isolated migration cleanup retry failed", errors
                    )

            leases.register_pending_cleanup(
                cleanup_owner,
                retry=retry_cleanup,
                holds=(self, target, marker),
                physical_terminal=lambda: terminal[desired_terminal],
                dependencies=(lease,),
            )
        _raise_primary_cleanup("isolated migration failed", primary, cleanup_errors)
        assert result is not None
        return result

async def _close_all(*targets: BoundSQLiteTarget) -> list[BaseException]:
    errors: list[BaseException] = []
    for target in targets:
        try:
            await target.aclose()
        except BaseException as error:
            errors.append(error)
    return errors


def _canonical_fleet_order(
    targets: Sequence[FleetPreflightTarget],
) -> tuple[FleetPreflightTarget, ...]:
    keyed: list[tuple[tuple[int, str], str | None, FleetPreflightTarget]] = []
    for registration in targets:
        if registration.kind == "meta":
            if registration.space_id is not None:
                raise MigrationSafetyError(
                    "Meta fleet preflight target cannot carry a Space ID"
                )
            key = (0, "")
            canonical: str | None = None
        elif registration.kind == "space":
            space_id = registration.space_id
            if not isinstance(space_id, str) or not space_id:
                raise MigrationSafetyError(
                    "Space fleet preflight target requires a canonical Space ID"
                )
            canonical = unicodedata.normalize("NFC", space_id).casefold()
            key = (1, canonical)
        else:
            raise MigrationSafetyError("fleet preflight database kind is invalid")
        keyed.append((key, canonical, registration))

    keys = [key for key, _canonical, _registration in keyed]
    if len(set(keys)) != len(keys):
        raise MigrationSafetyError(
            "fleet preflight canonical Space IDs must be unique"
        )
    for _key, canonical, registration in keyed:
        if registration.kind == "space" and registration.space_id != canonical:
            raise MigrationSafetyError(
                "fleet preflight Space ID is not canonical"
            )
    return tuple(registration for _key, _canonical, registration in sorted(keyed))


async def _run_joined(callback: Callable[[], Any]) -> Any:
    from app.runtime.joined_thread import run_joined_thread

    return await run_joined_thread(callback)


async def _release_all(
    global_lease: Lease | None, process_owner: Lease | None
) -> list[BaseException]:
    errors: list[BaseException] = []
    for lease in (global_lease, process_owner):
        if lease is None:
            continue
        try:
            await lease.release()
        except BaseException as error:
            errors.append(error)
    return errors


def _raise_primary_cleanup(
    label: str,
    primary: BaseException | None,
    cleanup_errors: Sequence[BaseException],
) -> None:
    if primary is not None and cleanup_errors:
        raise BaseExceptionGroup(label, [primary, *cleanup_errors]) from None
    if primary is not None:
        raise primary
    if cleanup_errors:
        raise BaseExceptionGroup(label, list(cleanup_errors))


def _migrate_bound_target(kind: DatabaseKind, target: BoundSQLiteTarget) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _alembic_maintenance_adapter,
    )

    config = _config(kind)
    head = _single_head(config)
    with target.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=False)
    ) as connection:
        with _alembic_maintenance_adapter(
            connection,
            expected_identity=target.identity,
            require_write=True,
        ) as adapter:
            config.attributes["maintenance_adapter"] = adapter
            command.upgrade(config, head)


def _verify_bound_target(
    kind: DatabaseKind, target: BoundSQLiteTarget
) -> MigrationStatus:
    from app.runtime.sqlite_vfs import MaintenanceOptions

    config = _config(kind)
    head = _single_head(config)
    version_table = _VERSION_TABLES[kind]
    with target.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
        integrity_row = connection.execute("PRAGMA integrity_check").fetchone()
        try:
            revision_row = connection.execute(
                f'SELECT version_num FROM "{version_table}"'
            ).fetchone()
        except Exception:
            revision_row = None
    revision = str(revision_row[0]) if revision_row else None
    return MigrationStatus(
        kind=kind,
        revision=revision,
        head=head,
        at_head=revision == head,
        integrity_ok=integrity_row == ("ok",),
    )


def _preflight_bound_target(
    kind: DatabaseKind,
    target: BoundSQLiteTarget,
    policies: Sequence[MigrationPreflightPolicy],
) -> MigrationStatus:
    from app.runtime.sqlite_vfs import MaintenanceOptions

    config = _config(kind)
    head = _single_head(config)
    version_table = _VERSION_TABLES[kind]
    with target.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
        integrity_row = connection.execute("PRAGMA integrity_check").fetchone()
        revision_row = connection.execute(
            f'SELECT version_num FROM "{version_table}"'
        ).fetchone()
        revision = str(revision_row[0]) if revision_row else None
        status = MigrationStatus(
            kind=kind,
            revision=revision,
            head=head,
            at_head=revision == head,
            integrity_ok=integrity_row == ("ok",),
        )
        if not status.integrity_ok:
            raise MigrationSafetyError("fleet preflight integrity check failed")
        for policy in policies:
            if policy.kind != kind:
                continue
            if policy.target_head != head:
                raise MigrationSafetyError(
                    "fleet preflight policy targets a different revision"
                )
            policy.probe(kind, status, connection)
        return status


def _config(kind: DatabaseKind) -> Config:
    config = Config(str(_ALEMBIC_INI), ini_section=f"alembic:{kind}")
    config.get_main_option("script_location")
    return config


def _metadata(kind: DatabaseKind, *, legacy: bool = False) -> MetaData:
    from app.db.metadata import (
        get_legacy_space_metadata,
        get_meta_metadata,
        get_space_metadata,
    )

    if kind == "meta":
        return get_meta_metadata()
    return get_legacy_space_metadata() if legacy else get_space_metadata()


def _table_names(kind: DatabaseKind, *, legacy: bool = False) -> frozenset[str]:
    return frozenset(_metadata(kind, legacy=legacy).tables)


def _single_head(config: Config) -> str:
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        raise MigrationSafetyError(
            f"{config.config_ini_section} migration chain must have exactly one head"
        )
    return heads[0]


def _version_rows(connection: Connection, version_table: str) -> list[str]:
    version_tbl = table(version_table, column("version_num"))
    return list(connection.execute(select(version_tbl.c.version_num)).scalars())


def _normalize_sql(value: Any) -> str | None:
    if value is None:
        return None
    return " ".join(str(value).strip().lower().split())


def _inspector_fingerprint(connection: Connection, table_names: frozenset[str]) -> dict[str, Any]:
    inspector = inspect(connection)
    fingerprint: dict[str, Any] = {}
    for table_name in sorted(table_names):
        columns = tuple(
            (
                column["name"],
                str(column["type"]).upper(),
                bool(column["nullable"]),
                _normalize_sql(column["default"]),
            )
            for column in inspector.get_columns(table_name)
        )
        pk = tuple(inspector.get_pk_constraint(table_name).get("constrained_columns") or ())
        uniques = frozenset(
            (
                constraint.get("name"),
                tuple(constraint.get("column_names") or ()),
            )
            for constraint in inspector.get_unique_constraints(table_name)
        )
        checks = frozenset(
            (constraint.get("name"), _normalize_sql(constraint.get("sqltext")))
            for constraint in inspector.get_check_constraints(table_name)
        )
        indexes = frozenset(
            (
                index.get("name"),
                tuple(index.get("column_names") or ()),
                bool(index.get("unique")),
                _normalize_sql((index.get("dialect_options") or {}).get("sqlite_where")),
            )
            for index in inspector.get_indexes(table_name)
        )
        fingerprint[table_name] = (columns, pk, uniques, checks, indexes)
    return fingerprint


def _expected_legacy_fingerprint(kind: DatabaseKind) -> dict[str, Any]:
    metadata = _metadata(kind, legacy=True)
    table_names = _table_names(kind, legacy=True)
    engine = create_engine("sqlite://")
    try:
        metadata.create_all(engine)
        with engine.connect() as connection:
            return _inspector_fingerprint(connection, table_names)
    finally:
        engine.dispose()


def _expected_managed_schema(
    kind: DatabaseKind, revision: str
) -> tuple[frozenset[str], dict[str, Any]]:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _alembic_maintenance_adapter,
        _bind_existing_target,
    )

    config = _config(kind)
    version_table = _VERSION_TABLES[kind]
    with tempfile.TemporaryDirectory(prefix="pxii-schema-oracle-") as directory:
        path = Path(directory) / "oracle.db"
        path.touch()
        target = _bind_existing_target(path, create_authority=True)
        try:
            with target.open_maintenance(
                MaintenanceOptions(read_only=False, create_if_missing=False)
            ) as maintenance:
                with _alembic_maintenance_adapter(
                    maintenance,
                    expected_identity=target.identity,
                    require_write=True,
                ) as adapter:
                    config.attributes["maintenance_adapter"] = adapter
                    command.upgrade(config, revision)

                    def fingerprint(connection: Connection):
                        table_names = frozenset(inspect(connection).get_table_names()) - {
                            version_table
                        }
                        return table_names, _inspector_fingerprint(
                            connection, table_names
                        )

                    return adapter.run(fingerprint)
        finally:
            asyncio.run(target.aclose())


def _classify_schema(
    connection: Connection,
    kind: DatabaseKind,
    known_revisions: set[str],
) -> Literal["fresh", "legacy", "managed"]:
    expected_tables = _table_names(kind, legacy=True)
    version_table = _VERSION_TABLES[kind]
    tables = set(inspect(connection).get_table_names())
    present_version_tables = tables & _ALL_VERSION_TABLES
    business_tables = tables - _ALL_VERSION_TABLES

    if not tables:
        return "fresh"

    if present_version_tables:
        if present_version_tables != {version_table}:
            raise MigrationSafetyError(
                f"legacy, foreign, or multiple version tables found: {sorted(present_version_tables)}"
            )
        try:
            rows = _version_rows(connection, version_table)
        except Exception as exc:
            raise MigrationSafetyError(f"invalid {version_table} schema") from exc
        if len(rows) != 1:
            raise MigrationSafetyError(
                f"{version_table} must contain exactly one migration version"
            )
        revision = rows[0]
        if revision not in known_revisions:
            raise MigrationSafetyError(
                f"{version_table} contains unknown migration version {revision!r}"
            )
        revision_tables, expected = _expected_managed_schema(kind, revision)
        if business_tables != revision_tables:
            raise MigrationSafetyError(
                f"managed {kind} schema has mixed, unknown, or missing tables"
            )
        actual = _inspector_fingerprint(connection, revision_tables)
        if actual != expected:
            raise MigrationSafetyError(
                f"managed {kind} schema fingerprint does not match revision {revision!r}"
            )
        return "managed"

    if business_tables == expected_tables:
        actual = _inspector_fingerprint(connection, expected_tables)
        expected = _expected_legacy_fingerprint(kind)
        if actual != expected:
            raise MigrationSafetyError(
                f"legacy {kind} schema fingerprint does not match create_all schema"
            )
        return "legacy"

    raise MigrationSafetyError(
        f"mixed, unknown, or incomplete {kind} schema cannot be adopted safely"
    )


def _migrate_file(kind: DatabaseKind, path: Path) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _alembic_maintenance_adapter,
        _bind_existing_target,
    )
    config = _config(kind)
    script = ScriptDirectory.from_config(config)
    head = _single_head(config)
    known_revisions = {revision.revision for revision in script.walk_revisions()}
    target = _bind_existing_target(path, create_authority=True)
    try:
        with target.open_maintenance(
            MaintenanceOptions(read_only=False, create_if_missing=False)
        ) as maintenance:
            with _alembic_maintenance_adapter(
                maintenance,
                expected_identity=target.identity,
                require_write=True,
            ) as adapter:
                def migrate(connection: Connection) -> None:
                    state = _classify_schema(connection, kind, known_revisions)
                    if state == "legacy":
                        config.attributes["allow_legacy_adoption"] = True
                        config.attributes["maintenance_adapter"] = adapter
                        command.stamp(config, _LEGACY_REVISIONS[kind])
                    config.attributes["maintenance_adapter"] = adapter
                    command.upgrade(config, head)

                adapter.run(migrate)
    finally:
        asyncio.run(target.aclose())


def run_migrations(kind: DatabaseKind, db_path: Path) -> None:
    """Atomically upgrade one SQLite database, adopting only an exact legacy schema."""
    if kind not in _VERSION_TABLES:
        raise ValueError(f"unsupported database kind: {kind!r}")

    from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target

    path = Path(db_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    temporary_path: Path | None = None
    try:
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.migration-", suffix=".db", dir=path.parent
        )
        os.close(fd)
        temporary_path = Path(temporary_name)
        if existed:
            source = _bind_existing_target(path, create_authority=False)
            try:
                replacement = _bind_existing_target(temporary_path, create_authority=True)
                try:
                    with source.open_maintenance(MaintenanceOptions(read_only=False)) as source_connection:
                        with replacement.open_maintenance(MaintenanceOptions(read_only=False)) as destination_connection:
                            source_connection.backup(destination_connection)
                finally:
                    asyncio.run(replacement.aclose())
            finally:
                asyncio.run(source.aclose())
        _migrate_file(kind, temporary_path)
        os.replace(temporary_path, path)
        temporary_path = None
    except MigrationSafetyError:
        raise
    except Exception as exc:
        raise MigrationSafetyError(f"failed to migrate {kind} database at {path}") from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
