"""Production migration runner contract tests."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text


def test_migration_coordinator_verifies_bound_target_without_upgrade(tmp_path):
    import asyncio

    from app.db.migrations import MigrationCoordinator, run_migrations
    from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target

    path = tmp_path / "verify.db"
    run_migrations("space", path)
    target = _bind_existing_target(path, create_authority=False)
    try:
        status = asyncio.run(MigrationCoordinator().verify_open("space", target))
        assert status.at_head
        assert status.integrity_ok
    finally:
        asyncio.run(target.aclose())


def test_migration_coordinator_exposes_all_authority_preserving_entrypoints():
    from app.db.migrations import MigrationCoordinator

    assert callable(MigrationCoordinator.upgrade)
    assert callable(MigrationCoordinator.upgrade_under_lease)
    assert callable(MigrationCoordinator.create_isolated_under_lease)
    assert callable(MigrationCoordinator.preflight_fleet_under_lease)


@pytest.mark.asyncio
async def test_coordinator_upgrade_and_fleet_preflight_use_same_owner_and_close_targets(
    tmp_path: Path,
) -> None:
    from app.db.migrations import (
        MigrationCoordinator,
        MigrationPreflightPolicy,
        run_migrations,
    )
    from app.errors import SQLiteAuthorityRevokedError
    from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator
    from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target

    class Quiescer:
        def __init__(self) -> None:
            self.events: list[str] = []

        async def drain_identity(self, _identity) -> None:
            self.events.append("drain")

        async def resume_identity(self, _identity) -> None:
            self.events.append("resume")

    path = tmp_path / "coordinator.db"
    await asyncio.to_thread(run_migrations, "space", path)
    quiescer = Quiescer()
    leases = RuntimeLeaseCoordinator(tmp_path / "runtime")
    coordinator = MigrationCoordinator(leases, quiescer)
    result = await coordinator.upgrade("space", path)
    assert result.changed is False
    assert quiescer.events == ["drain", "resume"]

    owner = await leases.acquire_process_owner("preflight", 5)
    global_lease = await leases.acquire_global(LeaseMode.EXCLUSIVE, "preflight", 5)
    target = _bind_existing_target(path, create_authority=False)
    observed: list[object] = []

    def read_only_probe(_kind, _status, connection) -> None:
        observed.append(connection.execute("SELECT 1").fetchone())
        with pytest.raises(Exception, match="readonly|authorized|query"):
            connection.execute("CREATE TABLE forbidden_preflight_write (id INTEGER)")

    try:
        head = result.head
        fleet = await coordinator.preflight_fleet_under_lease(
            [("space", target)],
            global_lease,
            [
                MigrationPreflightPolicy(
                    "space",
                    head,
                    read_only_probe,
                )
            ],
        )
        assert fleet.statuses[0].at_head
        assert observed == [(1,)]
        with pytest.raises(SQLiteAuthorityRevokedError):
            target.open_maintenance(MaintenanceOptions(read_only=True))
    finally:
        await global_lease.release()
        await owner.release()


@pytest.mark.asyncio
async def test_coordinator_replaces_managed_space_007_under_bound_authority(
    tmp_path: Path,
) -> None:
    from app.db.migrations import MigrationCoordinator, _config
    from app.runtime.leases import RuntimeLeaseCoordinator
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _alembic_maintenance_adapter,
        _bind_existing_target,
    )

    path = tmp_path / "managed-007.db"

    def seed_revision() -> None:
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
                    config = _config("space")
                    config.attributes["maintenance_adapter"] = adapter
                    command.upgrade(config, "space_007_session_mood_check")
        finally:
            asyncio.run(target.aclose())

    class Quiescer:
        async def drain_identity(self, _identity) -> None:
            return None

        async def resume_identity(self, _identity) -> None:
            return None

    await asyncio.to_thread(seed_revision)
    coordinator = MigrationCoordinator(
        RuntimeLeaseCoordinator(tmp_path / "runtime"), Quiescer()
    )
    result = await coordinator.upgrade("space", path)
    assert result.changed is True
    assert result.previous_revision == "space_007_session_mood_check"
    assert result.head == "space_008_sync_retention_snapshot"
    status = await coordinator.verify("space", path)
    assert status.at_head and status.integrity_ok


@pytest.mark.asyncio
async def test_upgrade_failure_after_backup_preserves_old_revision_and_releases_owner(
    tmp_path: Path,
) -> None:
    from app.db.migrations import MigrationCoordinator, _config
    from app.runtime.leases import RuntimeLeaseCoordinator
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _alembic_maintenance_adapter,
        _bind_existing_target,
    )

    path = tmp_path / "failure-after-backup.db"

    def seed_revision() -> None:
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
                    config = _config("space")
                    config.attributes["maintenance_adapter"] = adapter
                    command.upgrade(config, "space_007_session_mood_check")
        finally:
            asyncio.run(target.aclose())

    class Quiescer:
        async def drain_identity(self, _identity) -> None:
            return None

        async def resume_identity(self, _identity) -> None:
            return None

    await asyncio.to_thread(seed_revision)
    leases = RuntimeLeaseCoordinator(tmp_path / "runtime")
    coordinator = MigrationCoordinator(
        leases, Quiescer(), failpoint=lambda name: (_ for _ in ()).throw(
            RuntimeError("injected " + name)
        ) if name == "after_backup" else None
    )
    with pytest.raises(RuntimeError, match="injected after_backup"):
        await coordinator.upgrade("space", path)

    status = await coordinator.verify("space", path)
    assert status.revision == "space_007_session_mood_check"
    assert status.integrity_ok
    fresh = RuntimeLeaseCoordinator(tmp_path / "runtime")
    owner = await fresh.acquire_process_owner("fresh", 5)
    await owner.release()


@pytest.mark.asyncio
async def test_partial_drain_failure_still_resumes_identity(tmp_path: Path) -> None:
    from app.db.migrations import MigrationCoordinator, run_migrations
    from app.runtime.leases import RuntimeLeaseCoordinator

    path = tmp_path / "partial-drain.db"
    await asyncio.to_thread(run_migrations, "space", path)
    events: list[str] = []

    class PartialQuiescer:
        async def drain_identity(self, _identity) -> None:
            events.append("drain-started")
            raise RuntimeError("partial drain")

        async def resume_identity(self, _identity) -> None:
            events.append("resume")

    coordinator = MigrationCoordinator(
        RuntimeLeaseCoordinator(tmp_path / "runtime"), PartialQuiescer()
    )
    with pytest.raises(RuntimeError, match="partial drain"):
        await coordinator.upgrade("space", path)
    assert events == ["drain-started", "resume"]


@pytest.mark.asyncio
async def test_isolated_close_failure_registers_same_task_cleanup(tmp_path: Path) -> None:
    from app.db.migrations import MigrationCoordinator
    from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator

    class FailingTarget:
        identity = object()

        def __init__(self) -> None:
            self.close_calls = 0

        async def aclose(self) -> None:
            self.close_calls += 1
            if self.close_calls == 1:
                raise RuntimeError("close once")

    class Marker:
        def __init__(self) -> None:
            self.target = FailingTarget()
            self.discard_calls = 0

        def bind_isolated_sqlite_target(self, _path: Path):
            return self.target

        def commit_isolated_sqlite_target(self, _target) -> None:
            raise AssertionError("failed migration cannot commit")

        def discard_isolated_sqlite_target(self, _target) -> None:
            self.discard_calls += 1

    class Quiescer:
        async def drain_identity(self, _identity) -> None:
            return None

        async def resume_identity(self, _identity) -> None:
            return None

    leases = RuntimeLeaseCoordinator(tmp_path / "runtime")
    coordinator = MigrationCoordinator(
        leases,
        Quiescer(),
        migrate_target=lambda _kind, _target: (_ for _ in ()).throw(
            RuntimeError("create body")
        ),
    )
    owner = await leases.acquire_process_owner("isolated", 5)
    global_lease = await leases.acquire_global(LeaseMode.EXCLUSIVE, "isolated", 5)
    marker = Marker()
    try:
        with pytest.raises(BaseExceptionGroup, match="isolated migration failed"):
            await coordinator.create_isolated_under_lease(
                "space", tmp_path / "new.db", global_lease, marker
            )
        assert leases.has_pending_cleanups_for_current_task()
        with pytest.raises(Exception, match="cleanup"):
            leases.assert_ready()
        assert marker.discard_calls == 0
        assert await leases.retry_pending_cleanups_for_current_task() == ()
        assert not leases.has_pending_cleanups_for_current_task()
        assert marker.discard_calls == 1
    finally:
        await global_lease.release()
        await owner.release()


@pytest.mark.asyncio
async def test_duplicate_preflight_identities_close_all_open_targets(tmp_path: Path) -> None:
    from app.db.migrations import MigrationCoordinator, MigrationSafetyError, run_migrations
    from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator
    from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target

    path = tmp_path / "duplicate-preflight.db"
    await asyncio.to_thread(run_migrations, "space", path)
    leases = RuntimeLeaseCoordinator(tmp_path / "runtime")
    coordinator = MigrationCoordinator(leases, type("Q", (), {})())
    owner = await leases.acquire_process_owner("duplicate", 5)
    global_lease = await leases.acquire_global(LeaseMode.EXCLUSIVE, "duplicate", 5)
    first = _bind_existing_target(path, create_authority=False)
    second = _bind_existing_target(path, create_authority=False)
    try:
        with pytest.raises(MigrationSafetyError, match="unique"):
            await coordinator.preflight_fleet_under_lease(
                [("space", first), ("space", second)], global_lease
            )
        from app.errors import SQLiteAuthorityRevokedError

        for target in (first, second):
            with pytest.raises(SQLiteAuthorityRevokedError):
                target.open_maintenance(MaintenanceOptions(read_only=True))
    finally:
        await global_lease.release()
        await owner.release()


@pytest.mark.asyncio
async def test_nonterminal_checkpoint_keeps_process_owner_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.db.migrations import MigrationCoordinator, _config
    from app.runtime.leases import (
        _HELD_ORDER,
        LeaseTimeoutError,
        RuntimeLeaseCoordinator,
        _HeldOrder,
    )
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        SQLiteReplacementAuthority,
        _alembic_maintenance_adapter,
        _bind_existing_target,
    )

    path = tmp_path / "busy-checkpoint.db"

    def seed_revision() -> None:
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
                    config = _config("space")
                    config.attributes["maintenance_adapter"] = adapter
                    command.upgrade(config, "space_007_session_mood_check")
        finally:
            asyncio.run(target.aclose())

    class Quiescer:
        async def drain_identity(self, _identity) -> None:
            return None

        async def resume_identity(self, _identity) -> None:
            return None

    await asyncio.to_thread(seed_revision)
    monkeypatch.setattr(
        SQLiteReplacementAuthority,
        "checkpoint_and_seal_source",
        lambda _self: (1, 4, 3),
    )
    runtime_root = tmp_path / "runtime"
    coordinator = MigrationCoordinator(
        RuntimeLeaseCoordinator(runtime_root), Quiescer()
    )
    with pytest.raises(BaseExceptionGroup) as captured:
        await coordinator.upgrade("space", path)
    leaves = list(captured.value.exceptions)
    assert any("checkpoint" in str(error).lower() for error in leaves)
    fresh = RuntimeLeaseCoordinator(runtime_root)

    async def acquire_from_fresh_task() -> None:
        token = _HELD_ORDER.set(_HeldOrder(None, None, None, "none"))
        try:
            await fresh.acquire_process_owner("blocked", 0.05)
        finally:
            _HELD_ORDER.reset(token)

    with pytest.raises(LeaseTimeoutError):
        await asyncio.to_thread(asyncio.run, acquire_from_fresh_task())
import app.db.migrations as migrations_module

META_TABLES = {"spaces", "meta_settings"}
SPACE_TABLES = {
    "folders",
    "habit_check_ins",
    "habits",
    "memo_comments",
    "notes",
    "quick_notes",
    "reflections",
    "schedule_quick_notes",
    "schedules",
    "session_quick_notes",
    "sessions",
    "settings",
    "sync_audit_log",
    "sync_outbox",
    "sync_snapshots",
    "sync_state",
    "task_quick_notes",
    "tasks",
    "time_blocks",
    "tombstones",
}


def _sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def _create_legacy_schema(path: Path, database_kind: str) -> None:
    from app.db.metadata import get_meta_metadata, get_space_metadata

    metadata = get_meta_metadata() if database_kind == "meta" else get_space_metadata()

    engine = create_engine(_sqlite_url(path))
    try:
        metadata.create_all(engine)
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("database_kind", "expected_tables", "version_table"),
    [
        ("meta", META_TABLES, "alembic_version_meta"),
        ("space", SPACE_TABLES, "alembic_version_space"),
    ],
)
def test_fresh_database_upgrades_to_single_head(
    tmp_path: Path,
    database_kind: str,
    expected_tables: set[str],
    version_table: str,
) -> None:
    from app.db.migrations import run_migrations

    path = tmp_path / f"fresh-{database_kind}.db"
    run_migrations(database_kind, path)

    engine = create_engine(_sqlite_url(path))
    try:
        assert set(inspect(engine).get_table_names()) == expected_tables | {version_table}
        with engine.connect() as connection:
            rows = connection.execute(text(f"SELECT version_num FROM {version_table}")).scalars().all()
        assert len(rows) == 1
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("database_kind", "table_names", "version_table", "marker_sql", "marker_query"),
    [
        (
            "meta",
            META_TABLES,
            "alembic_version_meta",
            "INSERT INTO meta_settings "
            "(id, key, value, created_at, updated_at) "
            "VALUES ('marker', 'preserved', 'yes', '2026-01-01T00:00:00Z', "
            "'2026-01-01T00:00:00Z')",
            "SELECT value FROM meta_settings WHERE id = 'marker'",
        ),
        (
            "space",
            SPACE_TABLES,
            "alembic_version_space",
            "INSERT INTO settings (key, value, updated_at) "
            "VALUES ('preserved', 'yes', '2026-01-01T00:00:00Z')",
            "SELECT value FROM settings WHERE key = 'preserved'",
        ),
    ],
)
def test_exact_create_all_legacy_schema_is_adopted_without_data_loss(
    tmp_path: Path,
    database_kind: str,
    table_names: set[str],
    version_table: str,
    marker_sql: str,
    marker_query: str,
) -> None:
    from app.db.migrations import run_migrations

    path = tmp_path / f"legacy-{database_kind}.db"
    _create_legacy_schema(path, database_kind)
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(text(marker_sql))
    engine.dispose()

    run_migrations(database_kind, path)

    engine = create_engine(_sqlite_url(path))
    try:
        with engine.connect() as connection:
            assert connection.execute(text(marker_query)).scalar_one() == "yes"
            assert connection.execute(
                text(f"SELECT count(*) FROM {version_table}")
            ).scalar_one() == 1
    finally:
        engine.dispose()


def test_legacy_schema_with_column_drift_fails_closed(tmp_path: Path) -> None:
    from app.db.migrations import MigrationSafetyError, run_migrations

    path = tmp_path / "legacy-column-drift.db"
    _create_legacy_schema(path, "meta")
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE spaces ADD COLUMN unexpected TEXT"))
    engine.dispose()
    before = path.read_bytes()

    with pytest.raises(MigrationSafetyError, match="fingerprint|schema"):
        run_migrations("meta", path)

    assert path.read_bytes() == before


def test_legacy_schema_with_partial_index_predicate_drift_fails_closed(tmp_path: Path) -> None:
    from app.db.migrations import MigrationSafetyError, run_migrations

    path = tmp_path / "legacy-index-drift.db"
    _create_legacy_schema(path, "space")
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX uq_folder_root_name"))
        connection.execute(
            text(
                "CREATE UNIQUE INDEX uq_folder_root_name ON folders (name) "
                "WHERE parent_id IS NOT NULL"
            )
        )
    engine.dispose()

    with pytest.raises(MigrationSafetyError, match="fingerprint|schema"):
        run_migrations("space", path)


def test_managed_space_007_upgrades_to_008_with_existing_outbox_cursor(tmp_path: Path) -> None:
    from app.db.migrations import _config, run_migrations
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _alembic_maintenance_adapter,
        _bind_existing_target,
    )

    path = tmp_path / "managed-space-007.db"
    path.touch()
    target = _bind_existing_target(path, create_authority=True)
    config = _config("space")
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
                command.upgrade(config, "space_007_session_mood_check")
    finally:
        import asyncio

        asyncio.run(target.aclose())

    engine = create_engine(_sqlite_url(path))
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO sync_outbox "
                    "(entity_type, entity_id, action, payload, created_at, synced_at) "
                    "VALUES "
                    "('tasks', 'task-1', 'upsert', '{}', '2026-01-01T00:00:00.000Z', NULL), "
                    "('notes', 'note-1', 'delete', '{}', '2026-01-02T00:00:00.000Z', NULL)"
                )
            )
    finally:
        engine.dispose()

    run_migrations("space", path)

    engine = create_engine(_sqlite_url(path))
    try:
        assert {"sync_state", "sync_snapshots"}.issubset(inspect(engine).get_table_names())
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT current_cursor FROM sync_state WHERE id = 1")
            ).scalar_one() == 2
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == "space_008_sync_retention_snapshot"
    finally:
        engine.dispose()


def test_space_legacy_adoption_runs_timestamp_data_migration(tmp_path: Path) -> None:
    from app.db.migrations import run_migrations

    path = tmp_path / "legacy-space-data.db"
    _create_legacy_schema(path, "space")
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO settings (key, value, updated_at) "
                "VALUES ('preserved', 'yes', '2026-01-01T00:00:00Z')"
            )
        )
    engine.dispose()

    run_migrations("space", path)

    engine = create_engine(_sqlite_url(path))
    try:
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT value FROM settings WHERE key = 'preserved'")
            ).scalar_one() == "yes"
            assert connection.execute(
                text("SELECT updated_at FROM settings WHERE key = 'preserved'")
            ).scalar_one() == "2026-01-01T00:00:00.000Z"
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == "space_008_sync_retention_snapshot"
    finally:
        engine.dispose()


@pytest.mark.parametrize("database_kind", ["meta", "space"])
def test_fresh_migration_failure_does_not_create_target(
    tmp_path: Path, monkeypatch, database_kind: str
) -> None:
    path = tmp_path / f"fresh-failure-{database_kind}.db"

    def fail_upgrade(*_args, **_kwargs):
        raise RuntimeError("injected upgrade failure")

    monkeypatch.setattr(migrations_module.command, "upgrade", fail_upgrade)

    with pytest.raises(migrations_module.MigrationSafetyError, match="failed to migrate"):
        migrations_module.run_migrations(database_kind, path)

    assert not path.exists()


def test_existing_migration_failure_restores_exact_database_bytes(
    tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "existing-failure.db"
    migrations_module.run_migrations("meta", path)
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO meta_settings "
                "(id, key, value, created_at, updated_at) VALUES "
                "('marker', 'preserved', 'yes', '2026-01-01T00:00:00.000Z', "
                "'2026-01-01T00:00:00.000Z')"
            )
        )
    engine.dispose()
    before = path.read_bytes()

    def fail_upgrade(config, _revision):
        adapter = config.attributes["maintenance_adapter"]
        adapter.run(
            lambda connection: connection.execute(
                text("CREATE TABLE migration_pollution (id INTEGER)")
            )
        )
        raise RuntimeError("injected upgrade failure")

    monkeypatch.setattr(migrations_module.command, "upgrade", fail_upgrade)

    with pytest.raises(migrations_module.MigrationSafetyError, match="failed to migrate"):
        migrations_module.run_migrations("meta", path)

    assert path.read_bytes() == before
    engine = create_engine(_sqlite_url(path))
    try:
        assert "migration_pollution" not in inspect(engine).get_table_names()
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT value FROM meta_settings WHERE id = 'marker'")
            ).scalar_one() == "yes"
    finally:
        engine.dispose()


@pytest.mark.parametrize("database_kind", ["meta", "space"])
def test_mixed_or_unknown_schema_fails_closed_without_changes(
    tmp_path: Path, database_kind: str
) -> None:
    from app.db.migrations import MigrationSafetyError, run_migrations

    path = tmp_path / f"mixed-{database_kind}.db"
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE spaces (id TEXT PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE tasks (id TEXT PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE unknown_table (id TEXT PRIMARY KEY)"))
        before = set(inspect(connection).get_table_names())
    engine.dispose()

    with pytest.raises(MigrationSafetyError, match="mixed|unknown|schema"):
        run_migrations(database_kind, path)

    engine = create_engine(_sqlite_url(path))
    try:
        assert set(inspect(engine).get_table_names()) == before
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("version_table", "version_rows"),
    [
        ("alembic_version", ["legacy_001"]),
        ("alembic_version_meta", ["wrong_revision"]),
        ("alembic_version_meta", ["meta_001", "wrong_revision"]),
    ],
)
def test_legacy_single_chain_wrong_or_multiple_versions_fail_closed(
    tmp_path: Path, version_table: str, version_rows: list[str]
) -> None:
    from app.db.migrations import MigrationSafetyError, run_migrations

    path = tmp_path / f"bad-version-{version_table}-{len(version_rows)}.db"
    _create_legacy_schema(path, "meta")
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(text(f"CREATE TABLE {version_table} (version_num VARCHAR(64) NOT NULL)"))
        for version in version_rows:
            connection.execute(
                text(f"INSERT INTO {version_table} (version_num) VALUES (:version)"),
                {"version": version},
            )
        before = set(inspect(connection).get_table_names())
    engine.dispose()

    with pytest.raises(MigrationSafetyError, match="version|legacy|head"):
        run_migrations("meta", path)

    engine = create_engine(_sqlite_url(path))
    try:
        assert set(inspect(engine).get_table_names()) == before
        with engine.connect() as connection:
            assert connection.execute(
                text(f"SELECT version_num FROM {version_table}")
            ).scalars().all() == version_rows
    finally:
        engine.dispose()
