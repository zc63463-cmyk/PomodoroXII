"""Production migration runner contract tests."""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text

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
    "sync_clients",
    "sync_outbox",
    "sync_snapshots",
    "sync_snapshot_chunks",
    "sync_state",
    "task_quick_notes",
    "tasks",
    "time_blocks",
    "tombstones",
}
SYNC_SAFETY_REVISIONS = (
    "009_sync_clients.py",
    "010_sync_snapshot_chunks.py",
    "011_sync_client_credentials.py",
    "012_sync_timestamp_canonical.py",
)


def _sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def _space_head() -> str:
    head = migrations_module._single_head(migrations_module._config("space"))
    assert head == "space_012_sync_timestamp_canonical"
    return head


def _read_space_backup_state(path: Path) -> dict[str, object]:
    engine = create_engine(_sqlite_url(path))
    try:
        with engine.connect() as connection:
            return {
                "integrity": connection.execute(text("PRAGMA integrity_check")).scalar_one(),
                "revision": connection.execute(
                    text("SELECT version_num FROM alembic_version_space")
                ).scalar_one(),
                "settings": tuple(
                    connection.execute(
                        text("SELECT key, value, updated_at FROM settings ORDER BY key")
                    ).all()
                ),
                "client": tuple(
                    connection.execute(
                        text(
                            "SELECT client_id, user_id, display_name, ack_cursor, "
                            "last_seen_at, lease_expires_at, created_at, revoked_at, "
                            "snapshot_required, token_hash FROM sync_clients "
                            "WHERE client_id = 'r6-f1-client'"
                        )
                    ).one()
                ),
                "snapshot": tuple(
                    connection.execute(
                        text(
                            "SELECT token, cursor, payload, format, status, item_count, "
                            "chunk_count, uncompressed_bytes, compressed_bytes, checksum, "
                            "created_at, expires_at FROM sync_snapshots "
                            "WHERE token = 'r6-f1-snapshot'"
                        )
                    ).one()
                ),
                "chunk": tuple(
                    connection.execute(
                        text(
                            "SELECT snapshot_token, chunk_index, item_start, item_count, "
                            "compressed_payload, uncompressed_bytes, compressed_bytes, "
                            "checksum FROM sync_snapshot_chunks "
                            "WHERE snapshot_token = 'r6-f1-snapshot' AND chunk_index = 0"
                        )
                    ).one()
                ),
                "marker": tuple(
                    connection.execute(
                        text(
                            "SELECT id, title, description, status, priority, tags, plan, "
                            "completion, estimated_pomodoros, actual_pomodoros, created_at, "
                            "updated_at, version FROM tasks WHERE id = 'r6-f1-marker'"
                        )
                    ).one()
                ),
            }
    finally:
        engine.dispose()


def _create_space_011_backup_fixture(
    path: Path, *, invalid_timestamp: bool = False
) -> dict[str, object]:
    from app.db.migrations import _config

    raw_payload = b'{"kind":"entity","payload":{"id":"r6-f1-marker"}}\n'
    compressed_payload = gzip.compress(raw_payload, mtime=0)
    chunk_checksum = hashlib.sha256(compressed_payload).hexdigest()
    manifest_checksum = hashlib.sha256(chunk_checksum.encode("ascii")).hexdigest()
    second_setting_timestamp = "not-a-timestamp" if invalid_timestamp else "2026-07-04T10:00:01Z"

    engine = create_engine(_sqlite_url(path))
    config = _config("space")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "space_011_sync_client_credentials")
            connection.execute(
                text(
                    "INSERT INTO settings (key, value, updated_at) VALUES "
                    "('r6-f1-sync-enabled', 'true', "
                    "'2026-07-04T11:00:00.123456+01:00'), "
                    "('r6-f1-theme', 'dark', :second_timestamp)"
                ),
                {"second_timestamp": second_setting_timestamp},
            )
            connection.execute(
                text(
                    "INSERT INTO sync_clients "
                    "(client_id, user_id, display_name, ack_cursor, last_seen_at, "
                    "lease_expires_at, created_at, revoked_at, snapshot_required, token_hash) "
                    "VALUES ('r6-f1-client', 'r6-f1-user', 'R6 F1 Client', 41, "
                    "'2026-07-04T11:00:02+01:00', '2026-08-04T10:00:02', "
                    "'2026-07-04T10:00:02.987654Z', NULL, 0, :token_hash)"
                ),
                {"token_hash": "ab" * 32},
            )
            connection.execute(
                text(
                    "INSERT INTO sync_snapshots "
                    "(token, cursor, payload, format, status, item_count, chunk_count, "
                    "uncompressed_bytes, compressed_bytes, checksum, created_at, expires_at) "
                    "VALUES ('r6-f1-snapshot', 41, '', 'gzip-chunks-v1', 'ready', 1, 1, "
                    ":uncompressed_bytes, :compressed_bytes, :checksum, "
                    "'2026-07-04T10:00:03Z', '2026-07-05T12:00:03.456789+02:00')"
                ),
                {
                    "uncompressed_bytes": len(raw_payload),
                    "compressed_bytes": len(compressed_payload),
                    "checksum": manifest_checksum,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO sync_snapshot_chunks "
                    "(snapshot_token, chunk_index, item_start, item_count, compressed_payload, "
                    "uncompressed_bytes, compressed_bytes, checksum) VALUES "
                    "('r6-f1-snapshot', 0, 0, 1, :compressed_payload, "
                    ":uncompressed_bytes, :compressed_bytes, :checksum)"
                ),
                {
                    "compressed_payload": compressed_payload,
                    "uncompressed_bytes": len(raw_payload),
                    "compressed_bytes": len(compressed_payload),
                    "checksum": chunk_checksum,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO tasks "
                    "(id, title, description, status, priority, tags, plan, completion, "
                    "estimated_pomodoros, actual_pomodoros, created_at, updated_at, version) "
                    "VALUES ('r6-f1-marker', 'backup marker', 'must survive restore', 'todo', "
                    "'high', '[\"r6-f1\"]', 'plan', '0%', 3, 1, "
                    "'2026-07-04T10:00:04Z', '2026-07-04T11:00:04.654321+01:00', 7)"
                )
            )
    finally:
        engine.dispose()

    return _read_space_backup_state(path)


def _assert_space_backup_state(
    path: Path, expected: dict[str, object], *, revision: str
) -> None:
    actual = _read_space_backup_state(path)
    assert actual["integrity"] == "ok"
    assert actual["revision"] == revision
    assert actual == expected


def _assert_space_012_state(path: Path, before: dict[str, object]) -> None:
    actual = _read_space_backup_state(path)
    assert actual["integrity"] == "ok"
    assert actual["revision"] == _space_head()
    assert actual["settings"] == (
        ("r6-f1-sync-enabled", before["settings"][0][1], "2026-07-04T10:00:00.123Z"),
        ("r6-f1-theme", before["settings"][1][1], "2026-07-04T10:00:01.000Z"),
    )
    assert actual["client"] == (
        "r6-f1-client",
        "r6-f1-user",
        "R6 F1 Client",
        41,
        "2026-07-04T10:00:02.000Z",
        "2026-08-04T10:00:02.000Z",
        "2026-07-04T10:00:02.987Z",
        None,
        1,
        "ab" * 32,
    )
    assert actual["snapshot"] == (
        "r6-f1-snapshot",
        41,
        "",
        "gzip-chunks-v1",
        "ready",
        1,
        1,
        before["snapshot"][7],
        before["snapshot"][8],
        before["snapshot"][9],
        "2026-07-04T10:00:03.000Z",
        "2026-07-05T10:00:03.456Z",
    )
    assert actual["chunk"] == before["chunk"]
    assert actual["marker"] == (
        "r6-f1-marker",
        "backup marker",
        "must survive restore",
        "todo",
        "high",
        '["r6-f1"]',
        "plan",
        "0%",
        3,
        1,
        "2026-07-04T10:00:04.000Z",
        "2026-07-04T10:00:04.654Z",
        7,
    )


def _restore_backup_copy(backup_path: Path, restored_path: Path) -> None:
    assert backup_path.resolve() != restored_path.resolve()
    assert not restored_path.exists()
    shutil.copy2(backup_path, restored_path)


@pytest.mark.parametrize("revision_file", SYNC_SAFETY_REVISIONS)
def test_sync_safety_revisions_reject_downgrade_without_drops(
    revision_file: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    revision_path = (
        Path(__file__).resolve().parents[1]
        / "alembic_space"
        / "versions"
        / revision_file
    )
    spec = importlib.util.spec_from_file_location(
        f"test_migration_{revision_path.stem}", revision_path
    )
    assert spec is not None and spec.loader is not None
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)

    def fail_drop(*_args, **_kwargs) -> None:
        pytest.fail("forward-only sync safety downgrade attempted a drop operation")

    drop_operations = [name for name in dir(revision.op) if name.startswith("drop_")]
    assert drop_operations
    for operation_name in drop_operations:
        monkeypatch.setattr(revision.op, operation_name, fail_drop)

    with pytest.raises(
        RuntimeError,
        match=r"synchronization safety and recovery state.*lose data.*backup",
    ):
        revision.downgrade()


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


def test_managed_space_007_upgrades_to_latest_with_existing_outbox_cursor(tmp_path: Path) -> None:
    from app.db.migrations import _config, run_migrations

    path = tmp_path / "managed-space-007.db"
    engine = create_engine(_sqlite_url(path))
    config = _config("space")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "space_007_session_mood_check")
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
        assert {"sync_state", "sync_snapshots", "sync_snapshot_chunks", "sync_clients"}.issubset(
            inspect(engine).get_table_names()
        )
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT current_cursor FROM sync_state WHERE id = 1")
            ).scalar_one() == 2
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == _space_head()
    finally:
        engine.dispose()


def test_managed_space_008_upgrades_to_009_sync_clients(tmp_path: Path) -> None:
    from app.db.migrations import _config, run_migrations

    path = tmp_path / "managed-space-008.db"
    engine = create_engine(_sqlite_url(path))
    config = _config("space")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "space_008_sync_retention_snapshot")
    finally:
        engine.dispose()

    run_migrations("space", path)

    engine = create_engine(_sqlite_url(path))
    try:
        inspector = inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("sync_clients")}
        assert {
            "client_id",
            "user_id",
            "display_name",
            "ack_cursor",
            "last_seen_at",
            "lease_expires_at",
            "created_at",
            "revoked_at",
            "snapshot_required",
            "token_hash",
        } == columns
        indexes = {index["name"] for index in inspector.get_indexes("sync_clients")}
        assert indexes == {"ix_sync_clients_user_revoked", "ix_sync_clients_watermark"}
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == _space_head()
    finally:
        engine.dispose()


def test_managed_space_009_upgrades_to_010_snapshot_chunks(tmp_path: Path) -> None:
    from app.db.migrations import _config, run_migrations

    path = tmp_path / "managed-space-009.db"
    engine = create_engine(_sqlite_url(path))
    config = _config("space")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "space_009_sync_clients")
            connection.execute(
                text(
                    "INSERT INTO sync_snapshots (token, cursor, payload, created_at) "
                    "VALUES ('legacy-token', 7, '[]', '2026-01-01T00:00:00Z')"
                )
            )
    finally:
        engine.dispose()

    run_migrations("space", path)

    engine = create_engine(_sqlite_url(path))
    try:
        inspector = inspect(engine)
        assert "sync_snapshot_chunks" in inspector.get_table_names()
        columns = {column["name"] for column in inspector.get_columns("sync_snapshots")}
        assert {"format", "status", "item_count", "chunk_count", "expires_at"}.issubset(columns)
        with engine.connect() as connection:
            legacy = connection.execute(
                text("SELECT format, status, payload FROM sync_snapshots WHERE token='legacy-token'")
            ).one()
            assert legacy == ("legacy-json-v1", "ready", "[]")
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == _space_head()
    finally:
        engine.dispose()


def test_managed_space_011_canonicalizes_all_sync_timestamps_to_milliseconds(
    tmp_path: Path,
) -> None:
    from app.db.migrations import _config

    path = tmp_path / "managed-space-011-timestamps.db"
    engine = create_engine(_sqlite_url(path))
    config = _config("space")
    timestamp_cases = {
        "offset": ("2026-07-04T11:00:00.123456+01:00", "2026-07-04T10:00:00.123Z"),
        "naive": ("2026-07-04T10:00:01", "2026-07-04T10:00:01.000Z"),
        "seconds": ("2026-07-04T10:00:02Z", "2026-07-04T10:00:02.000Z"),
        "micro-a": ("2026-07-04T10:00:03.123123Z", "2026-07-04T10:00:03.123Z"),
        "micro-b": ("2026-07-04T10:00:03.123456Z", "2026-07-04T10:00:03.123Z"),
    }
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "space_011_sync_client_credentials")
            connection.execute(
                text(
                    "INSERT INTO settings (key, value, updated_at) "
                    "VALUES (:key, 'value', :timestamp)"
                ),
                [
                    {"key": key, "timestamp": source}
                    for key, (source, _expected) in timestamp_cases.items()
                ],
            )
            connection.execute(
                text(
                    "INSERT INTO tombstones (entity_type, entity_id, deleted_at) "
                    "VALUES ('task', :entity_id, :timestamp)"
                ),
                [
                    {"entity_id": key, "timestamp": source}
                    for key, (source, _expected) in timestamp_cases.items()
                ],
            )
            connection.execute(
                text(
                    "INSERT INTO tasks "
                    "(id, title, description, status, priority, tags, plan, completion, "
                    "estimated_pomodoros, actual_pomodoros, created_at, updated_at, version) "
                    "VALUES ('canonical-task', 'task', '', 'todo', 'medium', '[]', '', '', "
                    "1, 0, '2026-07-04T11:00:04+01:00', "
                    "'2026-07-04T10:00:04.987654Z', 1)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO sync_outbox "
                    "(entity_type, entity_id, action, payload, created_at, synced_at) "
                    "VALUES ('task', 'canonical-task', 'update', '{}', "
                    "'2026-07-04T10:00:05Z', '2026-07-04T10:00:05.654321Z')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO sync_clients "
                    "(client_id, user_id, ack_cursor, last_seen_at, lease_expires_at, "
                    "created_at, revoked_at, snapshot_required, token_hash) VALUES "
                    "('client', 'user', 0, '2026-07-04T11:00:06+01:00', "
                    "'2026-08-04T10:00:06', '2026-07-04T10:00:06Z', "
                    "'2026-07-05T10:00:06.111999Z', 0, NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO sync_snapshots "
                    "(token, cursor, payload, created_at, expires_at) VALUES "
                    "('snapshot', 0, '[]', '2026-07-04T10:00:07', "
                    "'2026-07-04T12:00:07.222999+02:00')"
                )
            )

        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
            command.upgrade(config, "head")

        with engine.connect() as connection:
            settings = dict(connection.execute(
                text("SELECT key, updated_at FROM settings")
            ).all())
            tombstones = dict(connection.execute(
                text("SELECT entity_id, deleted_at FROM tombstones")
            ).all())
            expected = {key: value for key, (_source, value) in timestamp_cases.items()}
            assert settings == expected
            assert tombstones == expected
            assert connection.execute(
                text("SELECT created_at, updated_at FROM tasks WHERE id='canonical-task'")
            ).one() == (
                "2026-07-04T10:00:04.000Z",
                "2026-07-04T10:00:04.987Z",
            )
            assert connection.execute(
                text("SELECT created_at, synced_at FROM sync_outbox")
            ).one() == (
                "2026-07-04T10:00:05.000Z",
                "2026-07-04T10:00:05.654Z",
            )
            assert connection.execute(
                text(
                    "SELECT last_seen_at, lease_expires_at, created_at, revoked_at, "
                    "snapshot_required FROM sync_clients WHERE client_id='client'"
                )
            ).one() == (
                "2026-07-04T10:00:06.000Z",
                "2026-08-04T10:00:06.000Z",
                "2026-07-04T10:00:06.000Z",
                "2026-07-05T10:00:06.111Z",
                1,
            )
            assert connection.execute(
                text("SELECT created_at, expires_at FROM sync_snapshots WHERE token='snapshot'")
            ).one() == (
                "2026-07-04T10:00:07.000Z",
                "2026-07-04T10:00:07.222Z",
            )
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == "space_012_sync_timestamp_canonical"
    finally:
        engine.dispose()


def test_managed_space_011_invalid_timestamp_fails_closed_without_changes(
    tmp_path: Path,
) -> None:
    from app.db.migrations import _config

    path = tmp_path / "managed-space-011-invalid-timestamp.db"
    engine = create_engine(_sqlite_url(path))
    config = _config("space")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "space_011_sync_client_credentials")
            connection.execute(
                text(
                    "INSERT INTO settings (key, value, updated_at) VALUES "
                    "('valid-before-invalid', 'value', '2026-07-04T10:00:00Z'), "
                    "('invalid', 'value', 'not-a-timestamp')"
                )
            )

        with pytest.raises(RuntimeError, match="rejected invalid timestamp.*settings.updated_at"):
            with engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "head")

        with engine.connect() as connection:
            assert dict(connection.execute(
                text("SELECT key, updated_at FROM settings")
            ).all()) == {
                "valid-before-invalid": "2026-07-04T10:00:00Z",
                "invalid": "not-a-timestamp",
            }
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == "space_011_sync_client_credentials"
    finally:
        engine.dispose()


def test_space_012_upgrade_is_directly_idempotent(tmp_path: Path) -> None:
    from app.db.migrations import _config

    revision_path = (
        Path(__file__).resolve().parents[1]
        / "alembic_space"
        / "versions"
        / "012_sync_timestamp_canonical.py"
    )
    spec = importlib.util.spec_from_file_location("test_space_012_idempotent", revision_path)
    assert spec is not None and spec.loader is not None
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)

    path = tmp_path / "space-012-direct-idempotent.db"
    engine = create_engine(_sqlite_url(path))
    config = _config("space")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "space_011_sync_client_credentials")
            connection.execute(
                text(
                    "INSERT INTO settings (key, value, updated_at) "
                    "VALUES ('direct', 'value', '2026-07-04T10:00:00.123456Z')"
                )
            )
            original_get_bind = revision.op.get_bind
            revision.op.get_bind = lambda: connection
            try:
                revision.upgrade()
                revision.upgrade()
            finally:
                revision.op.get_bind = original_get_bind
            assert connection.execute(
                text("SELECT updated_at FROM settings WHERE key='direct'")
            ).scalar_one() == "2026-07-04T10:00:00.123Z"
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
            ).scalar_one() == _space_head()
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
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
        connection = config.attributes["connection"]
        connection.execute(text("CREATE TABLE migration_pollution (id INTEGER)"))
        connection.commit()
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


def test_existing_space_migration_failure_restores_exact_database_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "existing-space-failure.db"
    migrations_module.run_migrations("space", path)
    engine = create_engine(_sqlite_url(path))
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO settings (key, value, updated_at) "
                "VALUES ('preserved', 'yes', '2026-01-01T00:00:00.000Z')"
            )
        )
    engine.dispose()
    before = path.read_bytes()

    real_upgrade = migrations_module.command.upgrade
    target_path = path.resolve()
    injected = False

    def fail_upgrade(config, revision):
        nonlocal injected
        connection = config.attributes["connection"]
        database_path = Path(connection.engine.url.database or "").resolve()
        if database_path == target_path:
            real_upgrade(config, revision)
            return
        if database_path.name.startswith(f".{path.name}.migration-"):
            injected = True
            connection.execute(text("CREATE TABLE migration_pollution (id INTEGER)"))
            connection.execute(
                text(
                    "INSERT INTO settings (key, value, updated_at) "
                    "VALUES ('pollution', 'committed', '2026-01-02T00:00:00.000Z')"
                )
            )
            connection.commit()
            raise RuntimeError("injected upgrade failure")
        real_upgrade(config, revision)

    monkeypatch.setattr(migrations_module.command, "upgrade", fail_upgrade)

    with pytest.raises(migrations_module.MigrationSafetyError, match="failed to migrate"):
        migrations_module.run_migrations("space", path)

    assert injected is True
    assert path.read_bytes() == before
    engine = create_engine(_sqlite_url(path))
    try:
        inspector = inspect(engine)
        assert "migration_pollution" not in inspector.get_table_names()
        assert {
            "sync_state",
            "sync_clients",
            "sync_snapshots",
            "sync_snapshot_chunks",
        }.issubset(inspector.get_table_names())
        assert {
            "client_id",
            "ack_cursor",
            "snapshot_required",
            "token_hash",
        }.issubset(
            column["name"] for column in inspector.get_columns("sync_clients")
        )
        assert {
            "format",
            "status",
            "item_count",
            "chunk_count",
            "checksum",
        }.issubset(
            column["name"] for column in inspector.get_columns("sync_snapshots")
        )
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT version_num FROM alembic_version_space")
            ).scalar_one() == _space_head()
            assert connection.execute(
                text("SELECT value FROM settings WHERE key = 'preserved'")
            ).scalar_one() == "yes"
            assert connection.execute(
                text("SELECT count(*) FROM settings WHERE key = 'pollution'")
            ).scalar_one() == 0
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


def test_space_011_online_backup_restores_sync_state_after_012_upgrade(
    tmp_path: Path,
) -> None:
    from app.db.migrations import run_migrations
    from app.file_system.backup import BackupService

    source_path = tmp_path / "source-011.db"
    backup_dir = tmp_path / "online-backup"
    restored_path = tmp_path / "restored-011.db"
    expected = _create_space_011_backup_fixture(source_path)

    wal_connection = sqlite3.connect(source_path)
    try:
        assert wal_connection.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
        wal_connection.execute("PRAGMA wal_autocheckpoint=0")
        wal_connection.execute(
            "UPDATE settings SET value = 'from-wal' WHERE key = 'r6-f1-theme'"
        )
        wal_connection.commit()
        assert Path(f"{source_path}-wal").stat().st_size > 0
        expected = _read_space_backup_state(source_path)

        backup_name = BackupService.create_backup(source_path, backup_dir)
        assert backup_name is not None
        backup_path = Path(backup_name)
        assert backup_path.is_file()
        assert backup_path.stat().st_size > 0
        _assert_space_backup_state(
            backup_path, expected, revision="space_011_sync_client_credentials"
        )
    finally:
        wal_connection.close()

    run_migrations("space", source_path)
    _assert_space_012_state(source_path, expected)

    _restore_backup_copy(backup_path, restored_path)
    _assert_space_backup_state(
        restored_path,
        expected,
        revision="space_011_sync_client_credentials",
    )

    run_migrations("space", restored_path)
    _assert_space_012_state(restored_path, expected)


def test_space_011_invalid_timestamp_keeps_source_and_backup_restorable(
    tmp_path: Path,
) -> None:
    from app.db.migrations import MigrationSafetyError, run_migrations
    from app.file_system.backup import BackupService

    source_path = tmp_path / "invalid-source-011.db"
    backup_dir = tmp_path / "invalid-online-backup"
    restored_path = tmp_path / "invalid-restored-011.db"
    expected = _create_space_011_backup_fixture(source_path, invalid_timestamp=True)

    backup_name = BackupService.create_backup(source_path, backup_dir)
    assert backup_name is not None
    backup_path = Path(backup_name)
    assert backup_path.is_file()
    assert backup_path.stat().st_size > 0
    source_before = source_path.read_bytes()
    backup_before = backup_path.read_bytes()

    with pytest.raises(MigrationSafetyError, match="failed to migrate space database"):
        run_migrations("space", source_path)

    assert not list(source_path.parent.glob(f".{source_path.name}.migration-*.db"))
    assert source_path.read_bytes() == source_before
    assert backup_path.read_bytes() == backup_before
    _assert_space_backup_state(backup_path, expected, revision="space_011_sync_client_credentials")

    _restore_backup_copy(backup_path, restored_path)
    assert restored_path.read_bytes() == backup_before
    _assert_space_backup_state(
        restored_path,
        expected,
        revision="space_011_sync_client_credentials",
    )

    restored_before = restored_path.read_bytes()
    with pytest.raises(MigrationSafetyError, match="failed to migrate space database"):
        run_migrations("space", restored_path)

    assert not list(restored_path.parent.glob(f".{restored_path.name}.migration-*.db"))
    assert restored_path.read_bytes() == restored_before
    _assert_space_backup_state(
        restored_path,
        expected,
        revision="space_011_sync_client_credentials",
    )
