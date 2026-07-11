"""Production migration runner contract tests."""

from __future__ import annotations

from pathlib import Path

import pytest
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
    "sync_outbox",
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
            ).scalar_one() == "space_007_session_mood_check"
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
